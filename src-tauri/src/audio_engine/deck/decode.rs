//! Symphonia decode — probe format, decode frames into interleaved f32 samples.
//!
//! Two modes:
//! - `probe_audio` + `decode_all`: full decode from in-memory bytes (tests, fallback)
//! - `probe_stream` + `decode_batch`: streaming decode from a `StreamingReader`
//!   that fills as HTTP chunks arrive. Playback starts after the first batch.

use anyhow::{Context, Result};
use once_cell::sync::Lazy;
use symphonia::core::audio::{Channels, SampleBuffer};
use symphonia::core::codecs::{self, CodecRegistry, DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tracing::{debug, warn};

/// Custom codec registry with all symphonia built-in codecs plus external adapters
/// for Opus (libopus) and AAC (Fraunhofer FDK AAC with HE-AAC support).
static CODEC_REGISTRY: Lazy<CodecRegistry> = Lazy::new(|| {
    let mut registry = CodecRegistry::new();
    // Register symphonia's built-in codecs
    symphonia::default::register_enabled_codecs(&mut registry);
    // Register external adapters
    registry.register_all::<symphonia_adapter_libopus::OpusDecoder>();
    registry.register_all::<symphonia_adapter_fdk_aac::AacDecoder>();
    registry
});

use super::streaming::StreamingReader;

/// Active decoder state — kept alive between batch decode calls.
pub struct DecoderSetup {
    pub resampler: Option<super::super::output::resample::StreamingResampler>,
    pub output_frames_decoded: u64,
    pub format: Box<dyn symphonia::core::formats::FormatReader>,
    pub decoder: Box<dyn symphonia::core::codecs::Decoder>,
    pub track_id: u32,
    pub sample_rate: u32,
    pub channels: u16,
    pub channel_layout: Channels,
    /// Reusable sample buffer (avoids per-packet allocation).
    sample_buf: Option<SampleBuffer<f32>>,
    /// Whether we've reached end of stream.
    pub finished: bool,
    /// Whether the stream was aborted (download error, not normal EOF).
    /// When true, the decoded audio is truncated — callers should NOT treat
    /// it as a complete track.
    pub aborted: bool,
    pub had_decode_errors: bool,
    time_base: Option<symphonia::core::units::TimeBase>,
    seek_skip_samples: usize,
    stream_buffer: Option<std::sync::Arc<super::streaming::SharedBuffer>>,
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
pub fn probe_from_source(mss: MediaSourceStream, ext: Option<&str>) -> Result<DecoderSetup> {
    let mut hint = Hint::new();
    if let Some(ext) = ext {
        hint.with_extension(ext);
    }
    let format_opts = FormatOptions {
        enable_gapless: true,
        ..Default::default()
    };

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &format_opts, &MetadataOptions::default())
        .context("failed to probe audio format")?;

    let format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .context("no audio track found")?;

    let sample_rate = track
        .codec_params
        .sample_rate
        .context("no sample rate in codec params")?;
    let channel_layout = track
        .codec_params
        .channels
        .unwrap_or(Channels::FRONT_LEFT | Channels::FRONT_RIGHT);
    let channels = channel_layout.count() as u16;
    anyhow::ensure!(
        (8000..=768000).contains(&sample_rate) && (1..=32).contains(&channels),
        "unsupported audio sample rate or channel count"
    );
    let duration_samples = track.codec_params.n_frames;
    let track_id = track.id;
    let time_base = track.codec_params.time_base;

    let decoder = CODEC_REGISTRY
        .make(&track.codec_params, &DecoderOptions::default())
        .context("failed to create decoder")?;

    let codec_name = codec_type_name(track.codec_params.codec);
    debug!(
        sample_rate,
        channels,
        codec = codec_name,
        duration_samples = duration_samples.unwrap_or(0),
        "audio probed"
    );

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
        time_base,
        seek_skip_samples: 0,
        stream_buffer: None,
    })
}

/// Accurate seeking returns a packet before the target. Decode and discard the
/// preroll so the first samples really correspond to the requested position.
pub fn seek_to_ms(setup: &mut DecoderSetup, position_ms: u64) -> Result<()> {
    use symphonia::core::formats::{SeekMode, SeekTo};
    use symphonia::core::units::Time;
    let seeked = setup.format.seek(
        SeekMode::Accurate,
        SeekTo::Time {
            time: Time::new(position_ms / 1000, (position_ms % 1000) as f64 / 1000.0),
            track_id: Some(setup.track_id),
        },
    )?;
    setup.decoder.reset();
    setup.finished = false;
    setup.aborted = false;
    setup.had_decode_errors = false;
    if let Some(resampler) = &mut setup.resampler {
        resampler.reset();
    }
    let delta = seeked.required_ts.saturating_sub(seeked.actual_ts);
    let frames = if let Some(base) = setup.time_base {
        let time = base.calc_time(delta);
        ((time.seconds as f64 + time.frac) * setup.sample_rate as f64).round() as usize
    } else {
        delta as usize
    };
    setup.seek_skip_samples = frames.saturating_mul(setup.channels as usize);
    Ok(())
}

/// Decode the next batch of packets, returning up to `max_samples` interleaved f32 samples.
///
/// Returns the decoded samples. An empty Vec means the stream ended.
/// Call repeatedly until `setup.finished` is true.
pub fn decode_batch(setup: &mut DecoderSetup, max_samples: usize) -> Result<Vec<f32>> {
    if setup.finished {
        return Ok(Vec::new());
    }

    let mut batch = Vec::with_capacity(max_samples);

    loop {
        if batch.len() >= max_samples {
            break;
        }

        let packet = match setup.format.next_packet() {
            Ok(p) => p,
            Err(symphonia::core::errors::Error::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                setup.finished = true;
                setup.aborted = setup
                    .stream_buffer
                    .as_ref()
                    .is_some_and(|buffer| buffer.is_aborted());
                break;
            }
            Err(e) => {
                warn!("decode packet error: {}", e);
                setup.finished = true;
                setup.aborted = true;
                break;
            }
        };

        if packet.track_id() != setup.track_id {
            continue;
        }

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

        let spec = *decoded.spec();
        if setup.sample_buf.is_none() {
            // HE-AAC SBR/PS can reveal a higher rate or stereo layout only
            // when the first packet is decoded.
            anyhow::ensure!(
                (8000..=768000).contains(&spec.rate) && (1..=32).contains(&spec.channels.count()),
                "unsupported decoded audio format"
            );
            setup.sample_rate = spec.rate;
            setup.channels = spec.channels.count() as u16;
            setup.channel_layout = spec.channels;
        } else {
            anyhow::ensure!(
                spec.rate == setup.sample_rate && spec.channels == setup.channel_layout,
                "audio format changed during decoding"
            );
        }
        let capacity = decoded.capacity();
        let buf = setup
            .sample_buf
            .get_or_insert_with(|| SampleBuffer::new(capacity as u64, spec));

        if buf.capacity() < capacity {
            *buf = SampleBuffer::new(capacity as u64, spec);
        }
        buf.copy_interleaved_ref(decoded);

        let skip = setup.seek_skip_samples.min(buf.samples().len());
        setup.seek_skip_samples -= skip;
        batch.extend_from_slice(&buf.samples()[skip..]);
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
fn codec_type_name(ct: codecs::CodecType) -> &'static str {
    match ct {
        codecs::CODEC_TYPE_FLAC => "FLAC",
        codecs::CODEC_TYPE_MP3 => "MP3",
        codecs::CODEC_TYPE_MP2 => "MP2",
        codecs::CODEC_TYPE_MP1 => "MP1",
        codecs::CODEC_TYPE_AAC => "AAC",
        codecs::CODEC_TYPE_OPUS => "Opus",
        codecs::CODEC_TYPE_VORBIS => "Vorbis",
        codecs::CODEC_TYPE_ALAC => "ALAC",
        _ => "other",
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

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
        wav.extend_from_slice(&layout.bits().to_le_bytes());
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
