// Adapted from Symphonia's ADTS reader.
// Copyright (c) 2019-2022 The Project Symphonia Developers.
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Preserve the ADTS configuration and decode from a prefix without tail scans.
//! Duration comes from Plex metadata; bitrate estimates are not packet bounds.

use std::io::{Seek, SeekFrom};
use symphonia::core::audio::Channels;
use symphonia::core::codecs::{CodecParameters, CODEC_TYPE_AAC};
use symphonia::core::errors::{Error, Result, SeekErrorKind};
use symphonia::core::formats::{
    Cue, FormatOptions, FormatReader, Packet, SeekMode, SeekTo, SeekedTo, Track,
};
use symphonia::core::io::{MediaSource, MediaSourceStream, ReadBytes};
use symphonia::core::meta::{Metadata, MetadataLog};
use symphonia::core::probe::{Descriptor, Instantiate, QueryDescriptor};
use symphonia::core::support_format;
use symphonia::core::units::TimeBase;

const FRAMES_PER_PACKET: u64 = 1024;
const RATES: [u32; 13] = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

#[derive(Clone, Copy)]
struct Header {
    config: [u8; 2],
    rate: u32,
    channels: Channels,
    payload_len: usize,
}

impl Header {
    fn read(source: &mut MediaSourceStream) -> Result<Self> {
        let mut bytes = [0; 7];
        source.read_buf_exact(&mut bytes)?;
        // Twelve sync bits, MPEG-2 or MPEG-4, zero layer, either CRC mode.
        if bytes[0] != 0xff || bytes[1] & 0xf6 != 0xf0 {
            return Err(Error::DecodeError("adts: invalid frame sync or layer"));
        }
        let rate_index = (bytes[2] >> 2) & 15;
        let rate = *RATES
            .get(usize::from(rate_index))
            .ok_or(Error::DecodeError("adts: reserved sample rate"))?;
        let channel_config = ((bytes[2] & 1) << 2) | (bytes[3] >> 6);
        let stereo = Channels::FRONT_LEFT | Channels::FRONT_RIGHT;
        let front = stereo | Channels::FRONT_CENTRE;
        let rear = Channels::REAR_LEFT | Channels::REAR_RIGHT;
        let channels = match channel_config {
            1 => Channels::FRONT_CENTRE,
            2 => stereo,
            3 => front,
            4 => front | Channels::REAR_CENTRE,
            5 => front | rear,
            6 => front | rear | Channels::LFE1,
            7 => {
                front
                    | rear
                    | Channels::FRONT_LEFT_CENTRE
                    | Channels::FRONT_RIGHT_CENTRE
                    | Channels::LFE1
            }
            _ => {
                return Err(Error::Unsupported(
                    "adts: program-config channel layout is unsupported",
                ))
            }
        };
        if bytes[6] & 3 != 0 {
            return Err(Error::Unsupported(
                "adts: multiple raw blocks per frame are unsupported",
            ));
        }
        let header_len = if bytes[1] & 1 == 0 { 9 } else { 7 };
        let frame_len = (usize::from(bytes[3] & 3) << 11)
            | (usize::from(bytes[4]) << 3)
            | usize::from(bytes[5] >> 5);
        if frame_len <= header_len {
            return Err(Error::DecodeError("adts: invalid frame length"));
        }
        if header_len == 9 {
            source.ignore_bytes(2)?;
        }
        // ASC has the actual ADTS object type (profile + 1), not an LC guess.
        let config = ((u16::from(bytes[2] >> 6) + 1) << 11)
            | (u16::from(rate_index) << 7)
            | (u16::from(channel_config) << 3);
        Ok(Self {
            config: config.to_be_bytes(),
            rate,
            channels,
            payload_len: frame_len - header_len,
        })
    }
}

pub(super) struct AdtsReader {
    reader: MediaSourceStream,
    tracks: Vec<Track>,
    metadata: MetadataLog,
    first_frame_pos: u64,
    next_packet_ts: u64,
    pending: Option<Header>,
    config: [u8; 2],
}

impl AdtsReader {
    fn header(&mut self) -> Result<Header> {
        let header = match self.pending.take() {
            Some(header) => header,
            None => Header::read(&mut self.reader)?,
        };
        if header.config != self.config {
            return Err(Error::Unsupported(
                "adts: configuration changed during playback",
            ));
        }
        Ok(header)
    }
}

impl QueryDescriptor for AdtsReader {
    fn query() -> &'static [Descriptor] {
        &[support_format!(
            "aac",
            "Audio Data Transport Stream",
            &["aac"],
            &["audio/aac", "audio/aacp"],
            &[&[0xff, 0xf0], &[0xff, 0xf1], &[0xff, 0xf8], &[0xff, 0xf9]]
        )]
    }

    fn score(_context: &[u8]) -> u8 {
        255
    }
}

impl FormatReader for AdtsReader {
    fn try_new(mut reader: MediaSourceStream, _options: &FormatOptions) -> Result<Self> {
        let first_frame_pos = reader.pos();
        let header = Header::read(&mut reader)?;
        let mut params = CodecParameters::new();
        params
            .for_codec(CODEC_TYPE_AAC)
            .with_sample_rate(header.rate)
            .with_time_base(TimeBase::new(1, header.rate))
            .with_channels(header.channels)
            .with_extra_data(Box::new(header.config));
        Ok(Self {
            reader,
            tracks: vec![Track::new(0, params)],
            metadata: MetadataLog::default(),
            first_frame_pos,
            next_packet_ts: 0,
            pending: Some(header),
            config: header.config,
        })
    }

    fn next_packet(&mut self) -> Result<Packet> {
        let header = self.header()?;
        let payload = self.reader.read_boxed_slice_exact(header.payload_len)?;
        let ts = self.next_packet_ts;
        self.next_packet_ts = ts
            .checked_add(FRAMES_PER_PACKET)
            .ok_or(Error::DecodeError("adts: timestamp overflow"))?;
        Ok(Packet::new_from_boxed_slice(
            0,
            ts,
            FRAMES_PER_PACKET,
            payload,
        ))
    }

    fn seek(&mut self, _mode: SeekMode, to: SeekTo) -> Result<SeekedTo> {
        let required_ts = match to {
            SeekTo::TimeStamp { ts, track_id: 0 } => ts,
            SeekTo::Time {
                time,
                track_id: None | Some(0),
            } => TimeBase::new(1, self.tracks[0].codec_params.sample_rate.unwrap())
                .calc_timestamp(time),
            _ => return Err(Error::SeekError(SeekErrorKind::InvalidTrack)),
        };
        if required_ts < self.next_packet_ts {
            if !self.reader.is_seekable() {
                return Err(Error::SeekError(SeekErrorKind::ForwardOnly));
            }
            if self.reader.seek(SeekFrom::Start(self.first_frame_pos))? != self.first_frame_pos {
                return Err(Error::SeekError(SeekErrorKind::Unseekable));
            }
            self.next_packet_ts = 0;
            self.pending = None;
        }
        loop {
            let header = self.header()?;
            if required_ts - self.next_packet_ts < FRAMES_PER_PACKET {
                self.pending = Some(header);
                break;
            }
            self.reader.ignore_bytes(header.payload_len as u64)?;
            self.next_packet_ts = self
                .next_packet_ts
                .checked_add(FRAMES_PER_PACKET)
                .ok_or(Error::DecodeError("adts: timestamp overflow"))?;
        }
        Ok(SeekedTo {
            track_id: 0,
            required_ts,
            actual_ts: self.next_packet_ts,
        })
    }

    fn metadata(&mut self) -> Metadata<'_> {
        self.metadata.metadata()
    }
    fn cues(&self) -> &[Cue] {
        &[]
    }
    fn tracks(&self) -> &[Track] {
        &self.tracks
    }
    fn into_inner(self: Box<Self>) -> MediaSourceStream {
        self.reader
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn source(data: Vec<u8>) -> MediaSourceStream {
        MediaSourceStream::new(Box::new(Cursor::new(data)), Default::default())
    }

    fn fixture() -> Vec<u8> {
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/audio/aac-lc-stereo.aac"
        ))
        .to_vec()
    }

    #[test]
    fn header_preserves_profile_and_reads_both_mpeg_versions_and_crc_modes() {
        let original = fixture();
        let mut baseline =
            AdtsReader::try_new(source(original.clone()), &FormatOptions::default()).unwrap();
        let expected = baseline.next_packet().unwrap();
        for profile in 0..=3 {
            for mpeg2 in [false, true] {
                for crc in [false, true] {
                    let mut bytes = original.clone();
                    bytes[2] = (bytes[2] & 0x3f) | (profile << 6);
                    bytes[1] = (bytes[1] & !8) | (u8::from(mpeg2) << 3);
                    if crc {
                        bytes[1] &= !1;
                        let length = ((usize::from(bytes[3] & 3) << 11)
                            | (usize::from(bytes[4]) << 3)
                            | usize::from(bytes[5] >> 5))
                            + 2;
                        bytes[3] = (bytes[3] & 0xfc) | ((length >> 11) as u8);
                        bytes[4] = (length >> 3) as u8;
                        bytes[5] = (bytes[5] & 0x1f) | (((length & 7) as u8) << 5);
                        // Transport CRC values are skipped, not verified by this raw reader.
                        bytes.splice(7..7, [0x12, 0x34]);
                    }
                    let mut reader =
                        AdtsReader::try_new(source(bytes), &FormatOptions::default()).unwrap();
                    let config = reader.tracks()[0].codec_params.extra_data.as_ref().unwrap();
                    assert_eq!(config[0] >> 3, profile + 1);
                    assert_eq!(reader.next_packet().unwrap().buf(), expected.buf());
                }
            }
        }
    }

    #[test]
    fn reserved_headers_short_lengths_and_configuration_changes_are_rejected() {
        let original = fixture();
        for (byte, value) in [
            (0, 0),
            (1, 0xf7),
            (2, (original[2] & 0xc3) | 0x3c),
            (6, original[6] | 1),
        ] {
            let mut invalid = original.clone();
            invalid[byte] = value;
            assert!(AdtsReader::try_new(source(invalid), &FormatOptions::default()).is_err());
        }
        let mut short = original.clone();
        short[3] &= 0xfc;
        short[4] = 0;
        short[5] &= 0x1f;
        assert!(AdtsReader::try_new(source(short), &FormatOptions::default()).is_err());
        let mut reader =
            AdtsReader::try_new(source(original.clone()), &FormatOptions::default()).unwrap();
        let first = reader.next_packet().unwrap();
        let end = first.buf().len() + 7;
        let mut changed = original;
        changed[end + 2] ^= 1 << 2;
        let mut reader = AdtsReader::try_new(source(changed), &FormatOptions::default()).unwrap();
        reader.next_packet().unwrap();
        assert!(reader.next_packet().is_err());
    }

    #[test]
    fn truncated_payloads_do_not_produce_packets_and_seek_replays_the_target_packet() {
        let bytes = fixture();
        let mut reader =
            AdtsReader::try_new(source(bytes.clone()), &FormatOptions::default()).unwrap();
        let first = reader.next_packet().unwrap();
        let mut truncated = AdtsReader::try_new(
            source(bytes[..7 + first.buf().len() - 1].to_vec()),
            &FormatOptions::default(),
        )
        .unwrap();
        assert!(truncated.next_packet().is_err());
        let second = reader.next_packet().unwrap();
        let seeked = reader
            .seek(
                SeekMode::Accurate,
                SeekTo::TimeStamp {
                    ts: 1200,
                    track_id: 0,
                },
            )
            .unwrap();
        assert_eq!(seeked.actual_ts, 1024);
        assert_eq!(reader.next_packet().unwrap().buf(), second.buf());
        reader
            .seek(SeekMode::Accurate, SeekTo::TimeStamp { ts: 0, track_id: 0 })
            .unwrap();
        assert_eq!(reader.next_packet().unwrap().buf(), first.buf());
    }
}
