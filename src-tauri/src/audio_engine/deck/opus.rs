//! Opus multistream decoding with named speaker mapping and OpusHead gain.
//! The container owns packet timestamps/trimming; header delay is only applied
//! when the packet does not already account for it.

use std::ptr::NonNull;
use symphonia::core::audio::{
    AsGenericAudioBufferRef, AudioBuffer, AudioMut, AudioSpec as SignalSpec,
    GenericAudioBufferRef as AudioBufferRef, Position as Channels,
};
use symphonia::core::codecs::CodecInfo;
use symphonia::core::codecs::audio::FinalizeResult;
use symphonia::core::codecs::audio::{
    AudioCodecParameters as CodecParameters, AudioDecoder as Decoder,
    AudioDecoderOptions as DecoderOptions, well_known::CODEC_ID_OPUS,
};
use symphonia::core::codecs::registry::{RegisterableAudioDecoder, SupportedAudioCodec};
use symphonia::core::errors::{Error, Result};
#[cfg(test)]
use symphonia::core::packet::Packet;
use symphonia::core::packet::PacketRef;
#[cfg(test)]
use symphonia::core::units::{Duration, Timestamp};

const SAMPLE_RATE: u32 = 48000;
const MAX_FRAMES: usize = 5760; // Maximum Opus packet duration: 120 ms.

#[derive(Debug)]
struct Header {
    layout: Channels,
    mapping: Vec<u8>,
    streams: i32,
    coupled: i32,
    pre_skip: usize,
    gain_q8: i32,
}

impl Header {
    fn parse(params: &CodecParameters) -> Result<Self> {
        let Some(data) = params.extra_data.as_deref() else {
            let count = params
                .channels
                .as_ref()
                .map(|channels| channels.count())
                .unwrap_or(0);
            if !(1..=2).contains(&count) {
                return Err(Error::Unsupported("opus: missing channel mapping"));
            }
            return Ok(Self {
                layout: if count == 1 {
                    Channels::FRONT_LEFT
                } else {
                    Channels::FRONT_LEFT | Channels::FRONT_RIGHT
                },
                mapping: (0..count as u8).collect(),
                streams: 1,
                coupled: (count - 1) as i32,
                pre_skip: 0,
                gain_q8: 0,
            });
        };
        if data.len() < 19 || &data[..8] != b"OpusHead" || data[8] > 15 {
            return Err(Error::DecodeError("opus: invalid identification header"));
        }
        let count = usize::from(data[9]);
        if !(1..=8).contains(&count) {
            return Err(Error::Unsupported("opus: unsupported channel count"));
        }
        let (streams, coupled, mapping) = match data[18] {
            0 if count <= 2 => (1, (count - 1) as i32, (0..count as u8).collect::<Vec<_>>()),
            1 => {
                if data.len() < 21 + count {
                    return Err(Error::DecodeError("opus: truncated channel mapping"));
                }
                (
                    i32::from(data[19]),
                    i32::from(data[20]),
                    data[21..21 + count].to_vec(),
                )
            }
            _ => return Err(Error::Unsupported("opus: unsupported mapping family")),
        };
        if streams == 0
            || coupled > streams
            || streams + coupled > 255
            || mapping
                .iter()
                .any(|&value| value != 255 && i32::from(value) >= streams + coupled)
        {
            return Err(Error::DecodeError("opus: invalid stream mapping"));
        }
        // RFC 7845 family 1 uses Vorbis speaker order. Sort each speaker's coded
        // channel index into Symphonia's bit order before passing it to libopus.
        let wire_order: &[Channels] = match count {
            1 => &[Channels::FRONT_LEFT],
            2 => &[Channels::FRONT_LEFT, Channels::FRONT_RIGHT],
            3 => &[
                Channels::FRONT_LEFT,
                Channels::FRONT_CENTER,
                Channels::FRONT_RIGHT,
            ],
            4 => &[
                Channels::FRONT_LEFT,
                Channels::FRONT_RIGHT,
                Channels::REAR_LEFT,
                Channels::REAR_RIGHT,
            ],
            5 => &[
                Channels::FRONT_LEFT,
                Channels::FRONT_CENTER,
                Channels::FRONT_RIGHT,
                Channels::REAR_LEFT,
                Channels::REAR_RIGHT,
            ],
            6 => &[
                Channels::FRONT_LEFT,
                Channels::FRONT_CENTER,
                Channels::FRONT_RIGHT,
                Channels::REAR_LEFT,
                Channels::REAR_RIGHT,
                Channels::LFE1,
            ],
            7 => &[
                Channels::FRONT_LEFT,
                Channels::FRONT_CENTER,
                Channels::FRONT_RIGHT,
                Channels::SIDE_LEFT,
                Channels::SIDE_RIGHT,
                Channels::REAR_CENTER,
                Channels::LFE1,
            ],
            8 => &[
                Channels::FRONT_LEFT,
                Channels::FRONT_CENTER,
                Channels::FRONT_RIGHT,
                Channels::SIDE_LEFT,
                Channels::SIDE_RIGHT,
                Channels::REAR_LEFT,
                Channels::REAR_RIGHT,
                Channels::LFE1,
            ],
            _ => unreachable!(),
        };
        let mut speakers: Vec<_> = wire_order.iter().copied().zip(mapping).collect();
        speakers.sort_by_key(|(speaker, _)| speaker.bits());
        Ok(Self {
            layout: speakers
                .iter()
                .fold(Channels::empty(), |layout, (speaker, _)| layout | *speaker),
            mapping: speakers.into_iter().map(|(_, index)| index).collect(),
            streams,
            coupled,
            pre_skip: usize::from(u16::from_le_bytes([data[10], data[11]])),
            gain_q8: i32::from(i16::from_le_bytes([data[16], data[17]])),
        })
    }
}

pub(super) struct OpusDecoder {
    handle: NonNull<opusic_sys::OpusMSDecoder>,
    params: CodecParameters,
    buf: AudioBuffer<f32>,
    pcm: Vec<f32>,
    channels: usize,
    pre_skip: usize,
    remaining_skip: usize,
    just_reset: bool,
    usable: bool,
}

// The handle is uniquely owned and never exposed. Mutating FFI calls are
// exclusive during construction or require &mut self. Shared trait access only
// reads Rust metadata/audio buffers.
unsafe impl Send for OpusDecoder {}
unsafe impl Sync for OpusDecoder {}

impl Drop for OpusDecoder {
    fn drop(&mut self) {
        // SAFETY: a successful create supplies this non-null, uniquely owned handle.
        unsafe { opusic_sys::opus_multistream_decoder_destroy(self.handle.as_ptr()) }
    }
}

impl OpusDecoder {
    pub(super) fn try_new(params: &CodecParameters, _options: &DecoderOptions) -> Result<Self> {
        if params.codec != CODEC_ID_OPUS {
            return Err(Error::Unsupported("opus: codec mismatch"));
        }
        let header = Header::parse(params)?;
        let channels = header.mapping.len();
        let mut status = 0;
        // SAFETY: validated stream counts/mapping, supported rate, and a mapping
        // buffer of exactly `channels` bytes, valid for the duration of create.
        let raw = unsafe {
            opusic_sys::opus_multistream_decoder_create(
                SAMPLE_RATE as i32,
                channels as i32,
                header.streams,
                header.coupled,
                header.mapping.as_ptr(),
                &mut status,
            )
        };
        let handle =
            NonNull::new(raw).ok_or(Error::DecodeError("opus: decoder allocation failed"))?;
        let mut normalized = params.clone();
        normalized.sample_rate = Some(SAMPLE_RATE);
        normalized.channels = Some(header.layout.into());
        let result = Self {
            handle,
            params: normalized,
            buf: AudioBuffer::new(
                SignalSpec::new(SAMPLE_RATE, header.layout.into()),
                MAX_FRAMES,
            ),
            pcm: vec![0.0; MAX_FRAMES * channels],
            channels,
            pre_skip: header.pre_skip,
            remaining_skip: header.pre_skip,
            just_reset: false,
            usable: true,
        };
        if status != opusic_sys::OPUS_OK {
            return Err(Error::DecodeError("opus: decoder creation failed"));
        }
        // SAFETY: the owned decoder is live; SET_GAIN takes one promoted signed
        // integer in Q8 dB, validated by its signed 16-bit header representation.
        let status = unsafe {
            opusic_sys::opus_multistream_decoder_ctl(
                result.handle.as_ptr(),
                opusic_sys::OPUS_SET_GAIN_REQUEST,
                header.gain_q8,
            )
        };
        if status != opusic_sys::OPUS_OK {
            return Err(Error::DecodeError("opus: output gain configuration failed"));
        }
        Ok(result)
    }
}
const CODEC_INFO: CodecInfo = CodecInfo {
    short_name: "opus",
    long_name: "Opus multistream",
    profiles: &[],
};
impl RegisterableAudioDecoder for OpusDecoder {
    fn try_registry_new(
        params: &CodecParameters,
        options: &DecoderOptions,
    ) -> Result<Box<dyn Decoder>> {
        Ok(Box::new(Self::try_new(params, options)?))
    }
    fn supported_codecs() -> &'static [SupportedAudioCodec] {
        &[SupportedAudioCodec {
            id: CODEC_ID_OPUS,
            info: CODEC_INFO,
        }]
    }
}
impl Decoder for OpusDecoder {
    fn codec_info(&self) -> &CodecInfo {
        &CODEC_INFO
    }
    fn reset(&mut self) {
        self.buf.clear();
        self.remaining_skip = 0;
        self.just_reset = true;
        // SAFETY: RESET_STATE has no additional arguments and the handle is live.
        let status = unsafe {
            opusic_sys::opus_multistream_decoder_ctl(
                self.handle.as_ptr(),
                opusic_sys::OPUS_RESET_STATE,
            )
        };
        self.usable = status == opusic_sys::OPUS_OK;
    }

    fn codec_params(&self) -> &CodecParameters {
        &self.params
    }

    fn decode_ref(&mut self, packet: &PacketRef<'_>) -> Result<AudioBufferRef<'_>> {
        self.buf.clear();
        if !self.usable {
            return Err(Error::DecodeError("opus: decoder reset failed"));
        }
        let data = packet.data;
        if data.is_empty() {
            return Err(Error::DecodeError("opus: empty audio packet"));
        }
        let length = i32::try_from(data.len())
            .map_err(|_| Error::DecodeError("opus: oversized audio packet"))?;
        // SAFETY: input is valid for `length` bytes; output has MAX_FRAMES times
        // channel-count writable floats, matching the supplied frame capacity.
        let frames = unsafe {
            opusic_sys::opus_multistream_decode_float(
                self.handle.as_ptr(),
                data.as_ptr(),
                length,
                self.pcm.as_mut_ptr(),
                MAX_FRAMES as i32,
                0,
            )
        };
        if frames <= 0 || frames as usize > MAX_FRAMES {
            return Err(Error::DecodeError("opus: invalid audio packet"));
        }
        let frames = frames as usize;
        self.buf.render_uninit(Some(frames));
        for channel in 0..self.channels {
            for (frame, sample) in self
                .buf
                .plane_mut(channel)
                .expect("validated channel")
                .iter_mut()
                .enumerate()
            {
                *sample = self.pcm[frame * self.channels + channel];
            }
        }
        if self.just_reset {
            // Seeking back to the first packet needs its initial delay again;
            // a middle-of-stream reset must not skip header delay a second time.
            self.remaining_skip = if packet.pts.get() <= 0 {
                self.pre_skip
            } else {
                0
            };
            self.just_reset = false;
        }
        let skip = self.remaining_skip.min(frames);
        self.remaining_skip = self.remaining_skip.saturating_sub(frames);
        self.buf.trim(
            skip.max(packet.trim_start.get() as usize),
            packet.trim_end.get() as usize,
        );
        Ok(self.buf.as_generic_audio_buffer_ref())
    }

    fn finalize(&mut self) -> FinalizeResult {
        FinalizeResult::default()
    }
    fn last_decoded(&self) -> AudioBufferRef<'_> {
        self.buf.as_generic_audio_buffer_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(head: &[u8]) -> CodecParameters {
        let mut params = CodecParameters::new();
        params.for_codec(CODEC_ID_OPUS).with_extra_data(head.into());
        params
    }

    fn stereo_header() -> Vec<u8> {
        let file = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/audio/opus-stereo.ogg"
        ));
        let start = 27 + usize::from(file[26]);
        file[start..start + 19].to_vec()
    }

    #[test]
    fn truncated_and_incompatible_headers_are_rejected_before_ffi() {
        let head = stereo_header();
        for length in 0..19 {
            assert!(Header::parse(&params(&head[..length])).is_err());
        }
        for (offset, value) in [(0, b'X'), (8, 16), (9, 0), (9, 9), (18, 2), (18, 255)] {
            let mut invalid = head.clone();
            invalid[offset] = value;
            assert!(Header::parse(&params(&invalid)).is_err());
        }
        let mut invalid = head;
        invalid[9] = 3;
        assert!(Header::parse(&params(&invalid)).is_err());
    }

    #[test]
    fn multistream_counts_and_mapping_are_checked_before_ffi() {
        let mut head = stereo_header();
        head[9] = 6;
        head[18] = 1;
        head.extend([4, 2, 0, 4, 1, 2, 3, 5]);
        assert!(Header::parse(&params(&head)).is_ok());
        for length in 19..27 {
            assert!(Header::parse(&params(&head[..length])).is_err());
        }
        for (offset, value) in [(19, 0), (19, 1), (19, 255), (20, 5), (21, 6)] {
            let mut invalid = head.clone();
            invalid[offset] = value;
            assert!(Header::parse(&params(&invalid)).is_err());
        }
        head[21] = 255; // Opus explicitly allows a silent mapped output channel.
        assert_eq!(Header::parse(&params(&head)).unwrap().mapping[0], 255);
    }

    #[test]
    fn decode_errors_and_reset_clear_the_last_audio_buffer() {
        let file = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/audio/opus-stereo.ogg"
        ));
        let mut setup = super::super::decode::probe_audio(file.to_vec()).unwrap();
        let packet = setup.format.next_packet().unwrap().unwrap();
        assert!(setup.decoder.decode(&packet).unwrap().frames() > 0);
        let invalid = Packet::new(setup.track_id, Timestamp::ZERO, Duration::ZERO, &[3][..]);
        assert!(setup.decoder.decode(&invalid).is_err());
        assert_eq!(setup.decoder.last_decoded().frames(), 0);
        setup.decoder.reset();
        assert_eq!(setup.decoder.last_decoded().frames(), 0);
    }
}
