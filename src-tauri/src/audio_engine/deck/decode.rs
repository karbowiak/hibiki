//! Symphonia decode — probe format, decode frames into interleaved f32 samples.
//!
//! Two modes:
//! - `probe_audio` + `decode_all`: full decode from in-memory bytes (tests, fallback)
//! - `probe_stream` + `decode_batch`: streaming decode from a `StreamingReader`
//!   that fills as HTTP chunks arrive. Playback starts after the first batch.

use anyhow::{Context, Result};
use once_cell::sync::Lazy;
use symphonia::core::audio::{Channels as ChannelDescriptor, Position as Channels};
use symphonia::core::codecs::audio::well_known::*;
use symphonia::core::codecs::audio::{
    self as codecs, AudioDecoder as Decoder, AudioDecoderOptions as DecoderOptions,
};
use symphonia::core::codecs::registry::CodecRegistry;
use symphonia::core::formats::FormatOptions;
use symphonia::core::formats::probe::{Hint, Probe};
use symphonia::core::io::{MediaSourceStream, ReadBytes, SeekBuffered};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::units::{Duration, Timestamp};
use tracing::{debug, warn};

/// Custom codec registry with all symphonia built-in codecs plus external adapters
/// for Opus (libopus) and AAC (Fraunhofer FDK AAC with HE-AAC support).
static CODEC_REGISTRY: Lazy<CodecRegistry> = Lazy::new(|| {
    let mut registry = CodecRegistry::new();
    // Register symphonia's built-in codecs
    symphonia::default::register_enabled_codecs(&mut registry);
    // Register external adapters
    registry.register_audio_decoder::<super::opus::OpusDecoder>();
    registry.register_audio_decoder::<super::aac::AacDecoder>();
    registry
});

static AUDIO_PROBE: Lazy<Probe> = Lazy::new(|| {
    let mut probe = Probe::default();
    symphonia::default::register_enabled_formats(&mut probe);
    probe.register_format::<super::adts::AdtsReader>();
    probe
});

use super::streaming::StreamingReader;

fn positional_layout(channels: &ChannelDescriptor) -> Result<Channels> {
    match channels {
        ChannelDescriptor::Positioned(layout) => Ok(*layout),
        ChannelDescriptor::Discrete(1) => Ok(Channels::FRONT_LEFT),
        ChannelDescriptor::Discrete(2) => Ok(Channels::FRONT_LEFT | Channels::FRONT_RIGHT),
        _ => anyhow::bail!("unsupported non-positional audio channel layout"),
    }
}

/// Active decoder state — kept alive between batch decode calls.
pub struct DecoderSetup {
    pub resampler: Option<super::super::output::resample::StreamingResampler>,
    pub output_frames_decoded: u64,
    pub format: Box<dyn symphonia::core::formats::FormatReader + 'static>,
    pub decoder: Box<dyn Decoder>,
    pub track_id: u32,
    pub sample_rate: u32,
    pub channels: u16,
    pub channel_layout: Channels,
    /// Reusable sample buffer (avoids per-packet allocation).
    sample_buf: Option<Vec<f32>>,
    /// Whether we've reached end of stream.
    pub finished: bool,
    /// Whether the stream was aborted (download error, not normal EOF).
    /// When true, the decoded audio is truncated — callers should NOT treat
    /// it as a complete track.
    pub aborted: bool,
    pub had_decode_errors: bool,
    cached_file: Option<(
        std::sync::Arc<super::super::cache::AudioCache>,
        String,
        super::super::cache::CacheStamp,
    )>,
    expected_end_ts: Option<Timestamp>,
    last_packet_end_ts: Timestamp,
    time_base: Option<symphonia::core::units::TimeBase>,
    seek_skip_samples: usize,
    seek_skip_seconds: Option<f64>,
    aac_seek_from_start: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    stream_buffer: Option<std::sync::Arc<super::streaming::SharedBuffer>>,
}

impl DecoderSetup {
    pub(in crate::audio_engine) fn source_format(&self) -> super::super::types::SourceAudioFormat {
        let parameters = self.decoder.codec_params();
        super::super::types::SourceAudioFormat {
            codec: codec_type_name(parameters.codec),
            // Encoded-stream parameters, never the interleaved f32 buffer's precision.
            bit_depth: parameters
                .bits_per_sample
                .filter(|bits| *bits > 0 && *bits <= 64),
            sample_rate: self.sample_rate,
            channels: self.channels,
        }
    }

    pub(in crate::audio_engine) fn attach_cached_file(
        &mut self,
        cache: std::sync::Arc<super::super::cache::AudioCache>,
        key: String,
        stamp: super::super::cache::CacheStamp,
    ) {
        self.cached_file = Some((cache, key, stamp));
    }
}

/// Probe and set up a decoder from in-memory bytes (full file).
#[cfg(test)]
pub fn probe_audio(data: Vec<u8>) -> Result<DecoderSetup> {
    let cursor = std::io::Cursor::new(data);
    let mss = MediaSourceStream::new(Box::new(cursor), Default::default());
    probe_from_source(mss, None)
}

/// Probe and set up a decoder from a streaming source.
/// The reader may block waiting for HTTP data — that's fine, we're on the decode thread.
pub fn probe_stream(reader: StreamingReader, ext: Option<&str>) -> Result<DecoderSetup> {
    let buffer = reader.buffer();
    let mss = MediaSourceStream::new(Box::new(reader), Default::default());
    let mut setup = probe_from_source(mss, ext)?;
    setup.stream_buffer = Some(buffer);
    Ok(setup)
}

/// Probe and set up a decoder. Pass a file extension hint (e.g. "opus", "ogg",
/// "flac") for reliable format detection — some containers like OGG/Opus need it.
pub fn probe_from_source(
    mut mss: MediaSourceStream<'static>,
    ext: Option<&str>,
) -> Result<DecoderSetup> {
    // An MP4 file starts with a four-byte box size followed by `ftyp`.
    // Begin marker probing at that valid marker, so the size field isn't
    // misreported as junk. The MP4 reader rewinds to the box start itself.
    let start = mss.pos();
    let mut box_header = [0; 8];
    let is_mp4 = match mss.read_buf_exact(&mut box_header) {
        Ok(()) => {
            &box_header[4..] == b"ftyp"
                && (u32::from_be_bytes(box_header[..4].try_into().unwrap()) >= 16
                    || box_header[..4] == 1_u32.to_be_bytes())
        }
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => false,
        Err(error) => return Err(error).context("failed to read audio header"),
    };
    mss.seek_buffered(start + if is_mp4 { 4 } else { 0 });

    let mut hint = Hint::new();
    if let Some(ext) = ext {
        hint.with_extension(ext);
    }
    // Gapless trimming is always enabled by Symphonia 0.6.
    let format_opts = FormatOptions::default();

    let format = AUDIO_PROBE
        .probe(&hint, mss, format_opts, MetadataOptions::default())
        .context("failed to probe audio format")?;

    let track = format
        .first_track_known_codec(symphonia::core::formats::TrackType::Audio)
        .context("no audio track found")?;
    let params = track
        .codec_params
        .as_ref()
        .and_then(|parameters| parameters.audio())
        .context("no audio codec parameters")?;
    let sample_rate = params
        .sample_rate
        .context("no sample rate in codec params")?;
    let descriptor = params
        .channels
        .clone()
        .unwrap_or_else(|| (Channels::FRONT_LEFT | Channels::FRONT_RIGHT).into());
    let channel_layout = positional_layout(&descriptor)?;
    let channels = channel_layout.iter().count() as u16;
    anyhow::ensure!(
        (8000..=768000).contains(&sample_rate) && (1..=32).contains(&channels),
        "unsupported audio sample rate or channel count"
    );
    let duration_samples = track.num_frames;
    let track_id = track.id;
    let time_base = track.time_base;
    let (decoder, aac_seek_from_start): (Box<dyn Decoder>, _) = if params.codec == CODEC_ID_AAC {
        let decoder = super::aac::AacDecoder::try_new(params, &DecoderOptions::default())
            .context("failed to create AAC decoder")?;
        let policy = decoder.seek_policy();
        (Box::new(decoder), Some(policy))
    } else {
        (
            CODEC_REGISTRY
                .make_audio_decoder(params, &DecoderOptions::default())
                .context("failed to create decoder")?,
            None,
        )
    };
    let sample_rate = decoder.codec_params().sample_rate.unwrap_or(sample_rate);
    let channel_layout = decoder
        .codec_params()
        .channels
        .as_ref()
        .map(positional_layout)
        .transpose()?
        .unwrap_or(channel_layout);
    let channels = channel_layout.iter().count() as u16;

    let codec_name = codec_type_name(params.codec);
    debug!(
        sample_rate,
        channels,
        codec = codec_name,
        duration_samples = duration_samples.unwrap_or(0),
        "audio probed"
    );

    let expected_end_ts = track
        .duration
        .map(|duration| Timestamp::new(track.start_ts.get().max(0)).saturating_add(duration));
    let start_ts = track.start_ts;
    Ok(DecoderSetup {
        resampler: None,
        output_frames_decoded: 0,
        format,
        decoder,
        track_id,
        sample_rate,
        channels,
        channel_layout,
        sample_buf: None,
        finished: false,
        aborted: false,
        had_decode_errors: false,
        cached_file: None,
        expected_end_ts,
        last_packet_end_ts: start_ts,
        time_base,
        seek_skip_samples: 0,
        seek_skip_seconds: None,
        aac_seek_from_start,
        stream_buffer: None,
    })
}

/// Accurate seeking returns a packet before the target. Decode and discard the
/// preroll so the first samples really correspond to the requested position.
pub fn seek_to_ms(setup: &mut DecoderSetup, position_ms: u64) -> Result<()> {
    use symphonia::core::formats::{SeekMode, SeekTo};
    use symphonia::core::units::Time;
    // Learn in-band SBR/PS headers before a cold AAC seek. reset() retains
    // that configuration while retiring old PCM and transport input.
    if setup.decoder.codec_params().codec == CODEC_ID_AAC && setup.sample_buf.is_none() {
        anyhow::ensure!(
            !decode_batch(setup, 16384)?.is_empty(),
            "AAC has no decodable initialization packets"
        );
    }
    // AAC/MP3 overlap filters and Opus prediction need previous packets after
    // reset. MP3's bit-reservoir references alone do not rebuild its synthesis
    // history. Decode 160 ms on the worker and discard it before publishing PCM;
    // this also exceeds Opus's mandatory 80 ms preroll.
    let seek_position_ms = if setup
        .aac_seek_from_start
        .as_ref()
        .is_some_and(|policy| policy.load(std::sync::atomic::Ordering::Acquire))
    {
        // Parametric stereo can depend on earlier delta-coded parameters.
        // Rebuild its state instead of returning an incorrect stereo mix.
        0
    } else if matches!(
        setup.decoder.codec_params().codec,
        CODEC_ID_OPUS | CODEC_ID_AAC | CODEC_ID_MP3
    ) {
        position_ms.saturating_sub(160)
    } else {
        position_ms
    };
    let seeked = setup.format.seek(
        SeekMode::Accurate,
        SeekTo::Time {
            time: Time::from_millis_u64(seek_position_ms),
            track_id: Some(setup.track_id),
        },
    )?;
    setup.decoder.reset();
    setup.finished = false;
    setup.aborted = false;
    setup.had_decode_errors = false;
    setup.last_packet_end_ts = seeked.actual_ts;
    if let Some(resampler) = &mut setup.resampler {
        resampler.reset();
    }
    // Negative packet timestamps include encoder delay, already trimmed by the decoder.
    // Count only presentation PCM when discarding seek pre-roll.
    let delta = seeked
        .required_ts
        .get()
        .saturating_sub(seeked.actual_ts.get().max(0))
        .max(0) as u64;
    let delta_seconds = if let Some(base) = setup.time_base {
        let time = base
            .calc_duration(Duration::new(delta))
            .context("seek time overflow")?;
        time.as_secs_f64()
    } else {
        delta as f64 / f64::from(setup.sample_rate)
    };
    // In-band HE-AAC can reveal SBR's doubled rate and PS's stereo output only
    // on the first decoded packet. Convert time into PCM at that actual format.
    setup.seek_skip_samples = 0;
    setup.seek_skip_seconds =
        Some(delta_seconds + position_ms.saturating_sub(seek_position_ms) as f64 / 1000.0);
    Ok(())
}

/// Decode the next batch of packets, returning up to `max_samples` interleaved f32 samples.
///
/// Returns the decoded samples. An empty Vec means the stream ended.
/// Call repeatedly until `setup.finished` is true.
pub fn decode_batch(setup: &mut DecoderSetup, max_samples: usize) -> Result<Vec<f32>> {
    decode_batch_interruptible(setup, max_samples, || false)
}

/// Check ownership and newer seeks between packets, including discarded preroll.
/// Interruption returns no samples and leaves the decoder available for a new seek.
pub fn decode_batch_interruptible(
    setup: &mut DecoderSetup,
    max_samples: usize,
    interrupted: impl FnMut() -> bool,
) -> Result<Vec<f32>> {
    let result = decode_batch_inner(setup, max_samples, interrupted);
    if result.is_err() || setup.aborted || setup.had_decode_errors {
        if let Some((cache, key, stamp)) = setup.cached_file.take() {
            // Invalid cached frames must not be reported as successful track EOF.
            setup.aborted = true;
            setup.finished = true;
            cache.discard(&key, &stamp);
        }
    }
    result
}

fn decode_batch_inner(
    setup: &mut DecoderSetup,
    max_samples: usize,
    mut interrupted: impl FnMut() -> bool,
) -> Result<Vec<f32>> {
    if setup.finished {
        return Ok(Vec::new());
    }

    let mut batch = Vec::with_capacity(max_samples);

    loop {
        if interrupted() {
            return Ok(Vec::new());
        }
        if batch.len() >= max_samples {
            break;
        }

        let packet = match setup.format.next_packet() {
            Ok(Some(p)) => p,
            Ok(None) => {
                setup.finished = true;
                setup.aborted = setup
                    .stream_buffer
                    .as_ref()
                    .is_some_and(|buffer| buffer.is_aborted())
                    || setup
                        .expected_end_ts
                        .is_some_and(|expected| setup.last_packet_end_ts < expected);
                break;
            }
            Err(symphonia::core::errors::Error::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                setup.finished = true;
                setup.aborted = setup
                    .stream_buffer
                    .as_ref()
                    .is_some_and(|buffer| buffer.is_aborted())
                    || setup
                        .expected_end_ts
                        .is_some_and(|expected| setup.last_packet_end_ts < expected);
                break;
            }
            Err(e) => {
                warn!("decode packet error: {}", e);
                setup.finished = true;
                setup.aborted = true;
                break;
            }
        };

        if packet.track_id != setup.track_id {
            continue;
        }

        setup.last_packet_end_ts = packet.pts.saturating_add(packet.dur);
        let decoded = match setup.decoder.decode(&packet) {
            Ok(d) => d,
            Err(symphonia::core::errors::Error::DecodeError(msg)) => {
                warn!("decode error (skipping packet): {}", msg);
                setup.had_decode_errors = true;
                continue;
            }
            Err(e) => {
                warn!("fatal decode error: {}", e);
                setup.finished = true;
                setup.aborted = true;
                break;
            }
        };

        let spec = decoded.spec();
        let layout = positional_layout(spec.channels())?;
        if setup.sample_buf.is_none() {
            // In-band SBR/PS can reveal the true decoded format on the first packet.
            anyhow::ensure!(
                (8000..=768000).contains(&spec.rate())
                    && (1..=32).contains(&spec.channels().count()),
                "unsupported decoded audio format"
            );
            setup.sample_rate = spec.rate();
            setup.channels = spec.channels().count() as u16;
            setup.channel_layout = layout;
        } else {
            anyhow::ensure!(
                spec.rate() == setup.sample_rate && layout == setup.channel_layout,
                "audio format changed during decoding"
            );
        }
        let buf = setup.sample_buf.get_or_insert_with(Vec::new);
        decoded.copy_to_vec_interleaved(buf);

        if let Some(seconds) = setup.seek_skip_seconds.take() {
            setup.seek_skip_samples = ((seconds * f64::from(spec.rate())).round() as usize)
                .saturating_mul(spec.channels().count());
        }
        let skip = setup.seek_skip_samples.min(buf.len());
        setup.seek_skip_samples -= skip;
        batch.extend_from_slice(&buf[skip..]);
    }

    for sample in &mut batch {
        if !sample.is_finite() {
            *sample = 0.0;
        }
    }
    Ok(batch)
}

/// Decode all frames at once (convenience for tests).
#[cfg(test)]
pub fn decode_all(setup: &mut DecoderSetup) -> Result<Vec<f32>> {
    let mut all_samples = Vec::new();

    loop {
        let batch = decode_batch(setup, 1024 * 1024)?; // 1M samples per batch
        if batch.is_empty() {
            break;
        }
        all_samples.extend_from_slice(&batch);
    }

    debug!(
        total_samples = all_samples.len(),
        frames = all_samples.len() / setup.channels.max(1) as usize,
        "decode complete"
    );

    Ok(all_samples)
}

/// Human-readable name for a symphonia codec type.
fn codec_type_name(ct: codecs::AudioCodecId) -> &'static str {
    match ct {
        CODEC_ID_FLAC => "FLAC",
        CODEC_ID_MP3 => "MP3",
        CODEC_ID_MP2 => "MP2",
        CODEC_ID_MP1 => "MP1",
        CODEC_ID_AAC => "AAC",
        CODEC_ID_OPUS => "Opus",
        CODEC_ID_VORBIS => "Vorbis",
        CODEC_ID_ALAC => "ALAC",
        _ => CODEC_REGISTRY
            .get_audio_decoder(ct)
            .map_or("Unknown", |decoder| decoder.codec.info.short_name),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn flac_metadata_tags_preserve_the_short_final_block() {
        let raw = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/audio/flac-stereo.flac"
        ));
        let mut reference = probe_audio(raw.to_vec()).unwrap();
        let expected = decode_all(&mut reference).unwrap();
        let mut id3 = b"ID3\x04\0\0\0\0\x24\x22".to_vec(); // 4642 padding bytes, 4652 including header.
        id3.resize(4652, 0);
        id3.extend_from_slice(raw);
        let mut tail = [0; 128];
        tail[..3].copy_from_slice(b"TAG");
        id3.extend_from_slice(&tail);
        let mut tagged = probe_audio(id3).unwrap();
        let actual = decode_all(&mut tagged).unwrap();
        assert!(!tagged.aborted && !tagged.had_decode_errors);
        assert_eq!(actual.len(), expected.len());
        assert!(actual.iter().zip(&expected).all(|(a, b)| a == b));
    }

    #[test]
    fn tagged_flac_starts_from_a_prefix_and_preserves_every_frame() {
        use super::super::streaming::{SharedBuffer, StreamingReader};
        let raw = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/audio/flac-stereo.flac"
        ));
        let mut reference = probe_audio(raw.to_vec()).unwrap();
        let expected = decode_all(&mut reference).unwrap();
        let mut tagged = b"ID3\x04\0\0\0\0\x24\x22".to_vec();
        tagged.resize(4652, 0);
        tagged.extend_from_slice(raw);
        let mut tail = [0; 128];
        tail[..3].copy_from_slice(b"TAG");
        tagged.extend_from_slice(&tail);
        for content_length in [Some(tagged.len() as u64), None] {
            let buffer = SharedBuffer::new(content_length).unwrap();
            let split = tagged.len() * 3 / 4;
            buffer.push(&tagged[..split]).unwrap();
            let source = buffer.clone();
            let (send, receive) = std::sync::mpsc::channel();
            let worker = std::thread::spawn(move || {
                let mut setup = probe_stream(StreamingReader::new(source), Some("flac")).unwrap();
                let first = decode_batch(&mut setup, 4096).unwrap();
                send.send((setup, first)).unwrap();
            });
            let result = receive.recv_timeout(std::time::Duration::from_secs(2));
            if result.is_err() {
                buffer.abort();
            }
            worker.join().unwrap();
            let (mut setup, mut actual) =
                result.expect("tag handling waited for the full download");
            assert!(!actual.is_empty());
            buffer.push(&tagged[split..]).unwrap();
            buffer.finish();
            actual.extend(decode_all(&mut setup).unwrap());
            assert!(
                !setup.aborted && !setup.had_decode_errors,
                "tagged FLAC reported incomplete"
            );
            assert_eq!(actual.len(), expected.len());
            assert!(actual.iter().zip(&expected).all(|(a, b)| a == b));
        }
    }

    #[test]
    fn tagged_flac_cannot_hide_truncated_or_corrupt_audio() {
        let raw = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/audio/flac-stereo.flac"
        ));
        for truncated in [false, true] {
            let mut data = raw.to_vec();
            if truncated {
                data.truncate(data.len() - 100);
            } else {
                let end = data.len() - 1;
                data[end] ^= 1;
            } // Damage the final CRC.
            let mut tail = [0; 128];
            tail[..3].copy_from_slice(b"TAG");
            data.extend_from_slice(&tail);
            let mut setup = probe_audio(data).unwrap();
            decode_all(&mut setup).unwrap();
            assert!(
                setup.aborted || setup.had_decode_errors,
                "an ID3 tag disguised invalid audio"
            );
        }
    }

    #[test]
    fn source_format_retains_encoded_precision_instead_of_the_float_decode_buffer() {
        let mut setup = probe_audio(generate_test_wav(44100, 2, 0.1)).unwrap();
        assert!(!decode_batch(&mut setup, 512).unwrap().is_empty());
        let format = setup.source_format();
        assert_eq!(format.bit_depth, Some(16));
        assert_eq!(format.sample_rate, 44100);
        assert_eq!(format.channels, 2);
        assert!(format.codec.to_lowercase().contains("pcm"));
    }

    #[test]
    fn late_cached_eof_is_incomplete_and_discards_only_the_decoded_revision() {
        use crate::audio_engine::cache::AudioCache;
        use std::sync::Arc;
        for replace_during_playback in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let cache = Arc::new(AudioCache::new(dir.path().into(), None));
            let mut replacement = cache.begin_write("42", "wav").unwrap();
            replacement
                .write_chunk(&generate_test_wav(44100, 2, 3.0))
                .unwrap();
            let mut damaged = generate_test_wav(44100, 2, 3.0);
            damaged.truncate(44 + 44100 * 4 * 3 / 2);
            let mut writer = cache.begin_write("42", "wav").unwrap();
            writer.write_chunk(&damaged).unwrap();
            writer.finish(&cache).unwrap();
            let (file, stamp) = cache.open_with_stamp("42").unwrap();
            let mut decoder = probe_from_source(
                MediaSourceStream::new(Box::new(file), Default::default()),
                Some("wav"),
            )
            .unwrap();
            decoder.attach_cached_file(cache.clone(), "42".into(), stamp);
            assert!(!decode_batch(&mut decoder, 44100 * 2).unwrap().is_empty());
            assert!(!decoder.finished && !decoder.aborted);
            if replace_during_playback {
                replacement.finish(&cache).unwrap();
            }
            decode_all(&mut decoder).unwrap();
            assert!(
                decoder.finished && decoder.aborted,
                "premature EOF must not become normal track completion"
            );
            assert_eq!(cache.lookup("42").is_some(), replace_during_playback);
        }
    }

    pub(crate) fn generate_test_wav(
        sample_rate: u32,
        channels: u16,
        duration_secs: f32,
    ) -> Vec<u8> {
        let num_samples = (sample_rate as f32 * duration_secs) as u32;
        let bits_per_sample: u16 = 16;
        let byte_rate = sample_rate * channels as u32 * (bits_per_sample / 8) as u32;
        let block_align = channels * (bits_per_sample / 8);
        let data_size = num_samples * channels as u32 * (bits_per_sample / 8) as u32;

        let mut buf = Vec::new();
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&(36 + data_size).to_le_bytes());
        buf.extend_from_slice(b"WAVE");
        buf.extend_from_slice(b"fmt ");
        buf.extend_from_slice(&16u32.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes());
        buf.extend_from_slice(&channels.to_le_bytes());
        buf.extend_from_slice(&sample_rate.to_le_bytes());
        buf.extend_from_slice(&byte_rate.to_le_bytes());
        buf.extend_from_slice(&block_align.to_le_bytes());
        buf.extend_from_slice(&bits_per_sample.to_le_bytes());
        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&data_size.to_le_bytes());
        for i in 0..num_samples {
            let t = i as f32 / sample_rate as f32;
            let sample = (2.0 * std::f32::consts::PI * 440.0 * t).sin();
            let s16 = (sample * 32767.0) as i16;
            for _ in 0..channels {
                buf.extend_from_slice(&s16.to_le_bytes());
            }
        }
        buf
    }

    pub(crate) fn generate_layout_wav(
        sample_rate: u32,
        layout: Channels,
        frames: usize,
        sample: impl Fn(usize, Channels) -> f32,
    ) -> Vec<u8> {
        let channels: Vec<_> = layout.iter().collect();
        let count = channels.len() as u16;
        let data_size = (frames * channels.len() * 2) as u32;
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(60 + data_size).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&40u32.to_le_bytes());
        wav.extend_from_slice(&0xfffeu16.to_le_bytes()); // WAVE_FORMAT_EXTENSIBLE
        wav.extend_from_slice(&count.to_le_bytes());
        wav.extend_from_slice(&sample_rate.to_le_bytes());
        wav.extend_from_slice(&(sample_rate * count as u32 * 2).to_le_bytes());
        wav.extend_from_slice(&(count * 2).to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(&22u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(&(layout.bits() as u32).to_le_bytes());
        wav.extend_from_slice(&[
            1, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71,
        ]);
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_size.to_le_bytes());
        for frame in 0..frames {
            for &channel in &channels {
                let value = (sample(frame, channel) * 32768.0).clamp(-32768.0, 32767.0) as i16;
                wav.extend_from_slice(&value.to_le_bytes());
            }
        }
        wav
    }

    #[test]
    fn probe_wav() {
        let wav = generate_test_wav(44100, 2, 0.1);
        let setup = probe_audio(wav).expect("should probe WAV");
        assert_eq!(setup.sample_rate, 44100);
        assert_eq!(setup.channels, 2);
    }

    #[test]
    fn decode_wav_produces_samples() {
        let wav = generate_test_wav(44100, 2, 0.5);
        let mut setup = probe_audio(wav).expect("should probe WAV");
        let samples = decode_all(&mut setup).expect("should decode WAV");
        let expected = (0.5 * 44100.0 * 2.0) as usize;
        assert!(
            (samples.len() as i64 - expected as i64).unsigned_abs() < 1000,
            "expected ~{} samples, got {}",
            expected,
            samples.len()
        );
    }

    #[test]
    fn decode_mono_wav() {
        let wav = generate_test_wav(44100, 1, 0.1);
        let mut setup = probe_audio(wav).expect("should probe mono WAV");
        assert_eq!(setup.channels, 1);
        let samples = decode_all(&mut setup).expect("should decode mono WAV");
        assert!(!samples.is_empty());
    }

    #[test]
    fn batch_decode_produces_same_result() {
        let wav = generate_test_wav(44100, 2, 0.5);
        let mut setup = probe_audio(wav).expect("should probe WAV");

        let mut all = Vec::new();
        loop {
            let batch = decode_batch(&mut setup, 8820).expect("decode batch"); // ~0.1s stereo
            if batch.is_empty() {
                break;
            }
            all.extend_from_slice(&batch);
        }

        let expected = (0.5 * 44100.0 * 2.0) as usize;
        assert!(
            (all.len() as i64 - expected as i64).unsigned_abs() < 1000,
            "expected ~{} samples, got {}",
            expected,
            all.len()
        );
    }

    #[test]
    fn accurate_seek_after_eof_discards_preroll_and_matches_the_original_pcm() {
        let wav = generate_test_wav(44100, 2, 2.0);
        let mut setup = probe_audio(wav).unwrap();
        let original = decode_all(&mut setup).unwrap();
        assert!(setup.finished);
        seek_to_ms(&mut setup, 333).unwrap();
        let after_seek = decode_all(&mut setup).unwrap();
        let offset = (333 * 44100 / 1000) * 2;
        assert_eq!(after_seek, original[offset..]);
        seek_to_ms(&mut setup, 100).unwrap();
        let backwards = decode_all(&mut setup).unwrap();
        assert_eq!(backwards, original[4410 * 2..]);
    }

    fn aac_fixtures() -> [&'static [u8]; 3] {
        [
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/audio/aac-lc-stereo.m4a"
            )),
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/audio/he-aac-stereo.m4a"
            )),
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/audio/he-aac-v2-stereo.m4a"
            )),
        ]
    }

    #[test]
    fn aac_lc_and_he_aac_produce_finite_stereo_pcm_at_the_output_rate() {
        for data in aac_fixtures() {
            let mut setup = probe_audio(data.to_vec()).unwrap();
            let samples = decode_all(&mut setup).unwrap();
            assert_eq!(setup.sample_rate, 48000);
            assert_eq!(setup.channels, 2);
            assert!(!setup.aborted && !setup.had_decode_errors);
            assert!(samples.len() > 48000 * 2);
            assert!(samples.iter().all(|sample| sample.is_finite()));
            assert!(samples.iter().any(|sample| sample.abs() > 0.1));
        }
    }

    #[test]
    fn aac_seeks_discard_previous_decoder_history() {
        for data in aac_fixtures() {
            let mut used = probe_audio(data.to_vec()).unwrap();
            decode_batch(&mut used, 16384).unwrap();
            for position in [0, 720, 333, 0] {
                let mut fresh = probe_audio(data.to_vec()).unwrap();
                seek_to_ms(&mut fresh, position).unwrap();
                let expected = decode_batch(&mut fresh, 4096).unwrap();
                assert!(!expected.is_empty());
                seek_to_ms(&mut used, position).unwrap();
                let actual = decode_batch(&mut used, 4096).unwrap();
                assert_eq!(actual.len(), expected.len());
                assert!(
                    actual.iter().zip(&expected).all(|(a, b)| a == b),
                    "AAC seek to {position} retained samples from the previous playback position"
                );
            }
            decode_all(&mut used).unwrap();
            assert!(used.finished);
            let mut fresh = probe_audio(data.to_vec()).unwrap();
            let expected = decode_batch(&mut fresh, 4096).unwrap();
            seek_to_ms(&mut used, 0).unwrap();
            assert_eq!(decode_batch(&mut used, 4096).unwrap(), expected);
        }
    }

    fn opus_fixture(surround: bool) -> Vec<u8> {
        if surround {
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/audio/opus-surround.ogg"
            ))
            .to_vec()
        } else {
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/audio/opus-stereo.ogg"
            ))
            .to_vec()
        }
    }

    fn set_ogg_opus_header_field(data: &mut [u8], field: usize, value: [u8; 2]) {
        let header_size = 27 + usize::from(data[26]);
        assert_eq!(&data[header_size..header_size + 8], b"OpusHead");
        data[header_size + field..header_size + field + 2].copy_from_slice(&value);
        let page_size = header_size
            + data[27..header_size]
                .iter()
                .map(|&n| usize::from(n))
                .sum::<usize>();
        data[22..26].fill(0);
        let mut crc = 0_u32;
        for &byte in &data[..page_size] {
            crc ^= u32::from(byte) << 24;
            for _ in 0..8 {
                crc = (crc << 1)
                    ^ if crc & 0x8000_0000 != 0 {
                        0x04c1_1db7
                    } else {
                        0
                    };
            }
        }
        data[22..26].copy_from_slice(&crc.to_le_bytes());
    }

    #[test]
    fn opus_stereo_keeps_the_complete_gapless_duration() {
        let mut setup = probe_audio(opus_fixture(false)).unwrap();
        let samples = decode_all(&mut setup).unwrap();
        assert_eq!(setup.sample_rate, 48000);
        assert_eq!(setup.channels, 2);
        assert!(!setup.aborted && !setup.had_decode_errors);
        assert_eq!(
            samples.len(),
            72000 * 2,
            "Opus pre-skip must be applied exactly once"
        );
    }

    #[test]
    fn opus_header_output_gain_is_applied_to_pcm() {
        let data = opus_fixture(false);
        let mut setup = probe_audio(data.clone()).unwrap();
        let original = decode_all(&mut setup).unwrap();
        let mut gained = data;
        set_ogg_opus_header_field(&mut gained, 16, (6_i16 * 256).to_le_bytes());
        let mut setup = probe_audio(gained).unwrap();
        let actual = decode_all(&mut setup).unwrap();
        assert_eq!(actual.len(), original.len());
        let gain = 10_f32.powf(6.0 / 20.0);
        let error = original
            .iter()
            .zip(&actual)
            .map(|(&a, &b)| f64::from((a * gain - b).abs()))
            .sum::<f64>()
            / original.len() as f64;
        assert!(
            error < 1e-5,
            "Opus header gain was not honored: mean error {error}"
        );
    }

    #[test]
    fn aac_surround_decodes_all_channels_in_named_speaker_order() {
        let file = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/audio/aac-surround.m4a"
        ));
        let mut setup = probe_audio(file.to_vec()).unwrap();
        let samples = decode_all(&mut setup).unwrap();
        assert_eq!(setup.channels, 6);
        assert!(!setup.aborted && !setup.had_decode_errors);
        let frequencies = [211.0_f64, 307.0, 401.0, 79.0, 503.0, 607.0];
        for channel in 0..6 {
            let strengths: Vec<_> = frequencies
                .iter()
                .map(|&frequency| {
                    let mut re = 0.0;
                    let mut im = 0.0;
                    for frame in 4800..52800 {
                        let phase = 2.0 * std::f64::consts::PI * frequency * frame as f64 / 48000.0;
                        let value = f64::from(samples[frame * 6 + channel]);
                        re += value * phase.cos();
                        im += value * phase.sin();
                    }
                    re.hypot(im) / 24000.0
                })
                .collect();
            assert!(
                strengths[channel] > 0.05,
                "AAC speaker {channel} is missing"
            );
            assert!(
                strengths
                    .iter()
                    .enumerate()
                    .all(|(index, &value)| index == channel || value < strengths[channel] * 0.2),
                "AAC speaker {channel} is reordered"
            );
        }
    }

    #[test]
    fn aac_adts_files_are_probed_and_decoded() {
        let file = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/audio/aac-lc-stereo.aac"
        ));
        let mut setup = probe_audio(file.to_vec()).unwrap();
        let samples = decode_all(&mut setup).unwrap();
        assert_eq!(setup.channels, 2);
        assert_eq!(setup.sample_rate, 48000);
        assert!(!setup.aborted && !setup.had_decode_errors);
        assert!(samples.len() > 48000 * 2);
        assert!(samples.iter().any(|&value| value.abs() > 0.1));
    }

    #[test]
    fn aac_seeking_before_and_after_decoding_matches_the_linear_audio_position() {
        let adts: [&[u8]; 3] = [
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/audio/aac-lc-stereo.aac"
            )),
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/audio/he-aac-stereo.aac"
            )),
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/audio/he-aac-v2-stereo.aac"
            )),
        ];
        let changing: &[u8] = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/audio/he-aac-v2-changing-stereo.m4a"
        ));
        for (index, data) in aac_fixtures()
            .into_iter()
            .chain(adts)
            .chain([changing])
            .enumerate()
        {
            let mut linear = probe_audio(data.to_vec()).unwrap();
            let reference = decode_all(&mut linear).unwrap();
            assert_eq!(linear.sample_rate, 48000);
            assert_eq!(linear.channels, 2);
            for already_decoded in [false, true] {
                let mut setup = probe_audio(data.to_vec()).unwrap();
                if already_decoded {
                    decode_batch(&mut setup, 16384).unwrap();
                }
                for position in [333, 720, 1250, 0] {
                    seek_to_ms(&mut setup, position).unwrap();
                    let actual = decode_batch(&mut setup, 4096).unwrap();
                    assert!(!actual.is_empty() && !setup.aborted && !setup.had_decode_errors);
                    let offset = (position * 48000 / 1000 * 2) as usize;
                    let expected = &reference[offset..offset + actual.len()];
                    let error = actual
                        .iter()
                        .zip(expected)
                        .map(|(a, b)| (a - b).abs())
                        .sum::<f32>()
                        / actual.len() as f32;
                    assert!(
                        error < 1e-3,
                        "AAC fixture {index}, seek {position}, prior decoding {already_decoded}: mean error {error}"
                    );
                }
            }
        }
    }

    #[test]
    fn long_parametric_stereo_preroll_can_be_interrupted_and_replaced_by_a_new_seek() {
        let data = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/audio/he-aac-v2-changing-stereo.m4a"
        ));
        let mut linear = probe_audio(data.to_vec()).unwrap();
        let reference = decode_all(&mut linear).unwrap();
        let mut setup = probe_audio(data.to_vec()).unwrap();
        seek_to_ms(&mut setup, 2500).unwrap();
        let mut checks = 0;
        let discarded = decode_batch_interruptible(&mut setup, 4096, || {
            checks += 1;
            checks == 3
        })
        .unwrap();
        assert_eq!(checks, 3);
        assert!(discarded.is_empty() && !setup.finished && !setup.aborted);
        assert!(setup.seek_skip_samples > 48000 * 2);
        seek_to_ms(&mut setup, 333).unwrap();
        let actual = decode_batch(&mut setup, 4096).unwrap();
        let expected = &reference[15984 * 2..15984 * 2 + actual.len()];
        assert_eq!(actual, expected);
    }

    #[test]
    fn opus_surround_preserves_named_channel_order_and_duration() {
        let mut setup = probe_audio(opus_fixture(true)).unwrap();
        let samples = decode_all(&mut setup).unwrap();
        assert_eq!(setup.channels, 6);
        assert_eq!(samples.len(), 72000 * 6);
        assert!(!setup.aborted && !setup.had_decode_errors);
        let frequencies = [211.0_f64, 307.0, 401.0, 79.0, 503.0, 607.0];
        for channel in 0..6 {
            let strengths: Vec<_> = frequencies
                .iter()
                .map(|&frequency| {
                    let mut re = 0.0;
                    let mut im = 0.0;
                    for frame in 4800..52800 {
                        let phase = 2.0 * std::f64::consts::PI * frequency * frame as f64 / 48000.0;
                        let value = f64::from(samples[frame * 6 + channel]);
                        re += value * phase.cos();
                        im += value * phase.sin();
                    }
                    re.hypot(im) / 24000.0
                })
                .collect();
            assert!(
                strengths[channel] > 0.05,
                "surround channel {channel} is missing"
            );
            assert!(
                strengths
                    .iter()
                    .enumerate()
                    .all(|(index, &value)| index == channel || value < strengths[channel] * 0.2),
                "surround channel {channel} was reordered"
            );
        }
    }

    #[test]
    fn opus_single_audio_page_trims_initial_delay_and_final_padding() {
        let data = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/audio/opus-mono-short.ogg"
        ));
        let mut setup = probe_audio(data.to_vec()).unwrap();
        let samples = decode_all(&mut setup).unwrap();
        assert_eq!(setup.channels, 1);
        assert_eq!(samples.len(), 12000);
        assert!(!setup.aborted && !setup.had_decode_errors);
    }

    #[test]
    fn opus_pre_skip_can_span_multiple_packets() {
        let data = opus_fixture(false);
        let header = 27 + usize::from(data[26]);
        let original_skip = u16::from_le_bytes([data[header + 10], data[header + 11]]);
        let mut setup = probe_audio(data.clone()).unwrap();
        let original = decode_all(&mut setup).unwrap();
        let mut cropped = data;
        set_ogg_opus_header_field(&mut cropped, 10, 2400_u16.to_le_bytes());
        let mut setup = probe_audio(cropped).unwrap();
        let actual = decode_all(&mut setup).unwrap();
        assert_eq!(actual, original[(2400 - usize::from(original_skip)) * 2..]);
    }

    #[test]
    fn opus_starts_from_a_buffered_page_and_can_seek_before_and_after_download_completion() {
        use super::super::streaming::{SharedBuffer, StreamingReader};
        use std::sync::mpsc;
        let data = opus_fixture(true);
        let mut prefix = 0;
        for _ in 0..3 {
            let segments = usize::from(data[prefix + 26]);
            prefix += 27
                + segments
                + data[prefix + 27..prefix + 27 + segments]
                    .iter()
                    .map(|&n| usize::from(n))
                    .sum::<usize>();
        }
        assert!(prefix < data.len());
        let buffer = SharedBuffer::new(None).unwrap();
        buffer.set_content_length(data.len() as u64);
        buffer.push(&data[..prefix]).unwrap();
        let source = buffer.clone();
        let (send, receive) = mpsc::channel();
        let decode = std::thread::spawn(move || {
            let mut setup = probe_stream(StreamingReader::new(source), Some("ogg")).unwrap();
            let first = decode_batch(&mut setup, 6144).unwrap();
            assert!(!first.is_empty());
            seek_to_ms(&mut setup, 50).unwrap();
            assert!(!decode_batch(&mut setup, 6144).unwrap().is_empty());
            send.send(setup).unwrap();
        });
        let result = receive.recv_timeout(std::time::Duration::from_secs(2));
        if result.is_err() {
            buffer.abort();
        }
        decode.join().unwrap();
        let mut setup = result.expect("Opus preparation must not wait for the complete download");
        buffer.push(&data[prefix..]).unwrap();
        buffer.finish();
        seek_to_ms(&mut setup, 0).unwrap();
        let streamed = decode_all(&mut setup).unwrap();
        let mut cached = probe_audio(data).unwrap();
        assert_eq!(streamed, decode_all(&mut cached).unwrap());
        assert_eq!(streamed.len(), 72000 * 6);
    }

    #[test]
    fn opus_seeks_match_linear_playback_at_the_requested_pcm_position() {
        for surround in [false, true] {
            let data = opus_fixture(surround);
            let mut setup = probe_audio(data).unwrap();
            let original = decode_all(&mut setup).unwrap();
            for position in [333, 720, 1250, 0] {
                seek_to_ms(&mut setup, position).unwrap();
                let actual = decode_batch(&mut setup, 4096).unwrap();
                let start = position as usize * 48 * setup.channels as usize;
                let expected = &original[start..start + actual.len()];
                let error = actual
                    .iter()
                    .zip(expected)
                    .map(|(&a, &b)| f64::from((a - b).abs()))
                    .sum::<f64>()
                    / actual.len() as f64;
                assert!(
                    error < 1e-3,
                    "Opus seek {position} differed from the requested PCM position: {error}"
                );
            }
        }
    }

    #[test]
    fn mp3_cold_and_repeated_seeks_match_linear_playback() {
        let data = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/audio/mp3-stereo.mp3"
        ))
        .to_vec();
        let mut setup = probe_audio(data.clone()).unwrap();
        let original = decode_all(&mut setup).unwrap();
        for cold in [true, false] {
            for position in [333, 720, 1250, 0] {
                if cold {
                    setup = probe_audio(data.clone()).unwrap();
                }
                seek_to_ms(&mut setup, position).unwrap();
                let actual = decode_batch(&mut setup, 4096).unwrap();
                assert!(!actual.is_empty());
                let start = (position as f64 * f64::from(setup.sample_rate) / 1000.0).round()
                    as usize
                    * setup.channels as usize;
                let expected = &original[start..start + actual.len()];
                let error = actual
                    .iter()
                    .zip(expected)
                    .map(|(&a, &b)| f64::from((a - b).abs()))
                    .sum::<f64>()
                    / actual.len() as f64;
                assert!(
                    error < 1e-3,
                    "MP3 seek {position}, cold={cold}: mean PCM error {error}"
                );
                assert!(!setup.had_decode_errors && !setup.aborted);
            }
        }
    }

    #[test]
    fn major_formats_start_from_a_prefix_and_keep_the_complete_decoded_tail() {
        use super::super::streaming::{SharedBuffer, StreamingReader};
        use std::sync::mpsc;
        let fixtures: [(&str, &[u8]); 7] = [
            (
                "aac",
                include_bytes!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/tests/fixtures/audio/he-aac-stereo.aac"
                )),
            ),
            (
                "aac",
                include_bytes!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/tests/fixtures/audio/he-aac-v2-stereo.aac"
                )),
            ),
            (
                "aac",
                include_bytes!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/tests/fixtures/audio/aac-lc-stereo.aac"
                )),
            ),
            (
                "flac",
                include_bytes!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/tests/fixtures/audio/flac-stereo.flac"
                )),
            ),
            (
                "mp3",
                include_bytes!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/tests/fixtures/audio/mp3-stereo.mp3"
                )),
            ),
            (
                "m4a",
                include_bytes!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/tests/fixtures/audio/aac-lc-faststart.m4a"
                )),
            ),
            (
                "ogg",
                include_bytes!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/tests/fixtures/audio/vorbis-stereo.ogg"
                )),
            ),
        ];
        for (extension, data) in fixtures {
            for content_length in [Some(data.len() as u64), None] {
                let prefix = if extension == "ogg" {
                    let mut end = 0;
                    for _ in 0..3 {
                        let segments = usize::from(data[end + 26]);
                        end += 27
                            + segments
                            + data[end + 27..end + 27 + segments]
                                .iter()
                                .map(|&n| usize::from(n))
                                .sum::<usize>();
                    }
                    end
                } else {
                    data.len() * 3 / 4
                };
                assert!(prefix < data.len());
                let buffer = SharedBuffer::new(content_length).unwrap();
                buffer.push(&data[..prefix]).unwrap();
                let source = buffer.clone();
                let extension = extension.to_owned();
                let (send, receive) = mpsc::channel();
                let decode = std::thread::spawn(move || {
                    let mut setup = probe_stream(StreamingReader::new(source), Some(&extension))
                        .unwrap_or_else(|error| panic!("{extension} probe: {error:?}"));
                    let first = decode_batch(&mut setup, 4096).unwrap();
                    assert!(!first.is_empty());
                    send.send((setup, first)).unwrap();
                });
                let result = receive.recv_timeout(std::time::Duration::from_secs(2));
                if result.is_err() {
                    buffer.abort();
                }
                decode.join().unwrap();
                let (mut setup, mut streamed) =
                    result.expect("Format preparation waited for the complete download");
                buffer.push(&data[prefix..]).unwrap();
                buffer.finish();
                streamed.extend(decode_all(&mut setup).unwrap());
                let mut cached = probe_audio(data.to_vec()).unwrap();
                let expected = decode_all(&mut cached).unwrap();
                assert_eq!(
                    streamed.len(),
                    expected.len(),
                    "streaming dropped or retained padding"
                );
                assert!(streamed.iter().zip(&expected).all(|(a, b)| a == b));
            }
        }
    }

    #[test]
    fn initial_playback_buffer_is_ready_before_the_full_track_has_arrived() {
        use super::super::streaming::{SharedBuffer, StreamingReader};
        let wav = generate_test_wav(44100, 2, 3.0);
        let shared = SharedBuffer::new(Some(wav.len() as u64)).unwrap();
        // Only half the three-second file has arrived; the body is still open.
        shared.push(&wav[..44 + 44100 * 2 * 2 * 3 / 2]).unwrap();
        let source = shared.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let mut decoder = probe_stream(StreamingReader::new(source), Some("wav")).unwrap();
            let initial = decode_batch(&mut decoder, 44100 * 2).unwrap();
            tx.send((initial.len(), decoder.finished)).unwrap();
        });
        let first = rx.recv_timeout(std::time::Duration::from_secs(2));
        shared.abort(); // Also releases the worker if probing unexpectedly blocked.
        worker.join().unwrap();
        let (samples, finished) = first.expect("playback should not wait for the complete file");
        assert!(samples >= 44100 * 2);
        assert!(!finished);
    }

    #[test]
    fn streaming_decode() {
        use super::super::streaming::{SharedBuffer, StreamingReader};

        let wav = generate_test_wav(44100, 2, 0.5);
        let total_len = wav.len();

        let shared = SharedBuffer::new(Some(total_len as u64)).unwrap();

        // Simulate chunked delivery
        let shared_w = shared.clone();
        let writer = std::thread::spawn(move || {
            for chunk in wav.chunks(4096) {
                std::thread::sleep(std::time::Duration::from_millis(1));
                shared_w.push(chunk).unwrap();
            }
            shared_w.finish();
        });

        let reader = StreamingReader::new(shared);
        let mut setup = probe_stream(reader, Some("wav")).expect("should probe stream");
        let samples = decode_all(&mut setup).expect("should decode stream");

        writer.join().unwrap();

        let expected = (0.5 * 44100.0 * 2.0) as usize;
        assert!(
            (samples.len() as i64 - expected as i64).unsigned_abs() < 1000,
            "streaming: expected ~{} samples, got {}",
            expected,
            samples.len()
        );
    }
}
