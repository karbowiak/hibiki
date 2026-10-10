//! EBU R128 loudness analysis — computes ReplayGain-compatible gain for tracks
//! where Plex doesn't provide proper loudness data (e.g. Opus).
//!
//! Uses the `ebur128` crate which implements ITU-R BS.1770 / EBU R128.
//! The computed gain targets -18 LUFS (ReplayGain 2.0 reference level).

use std::path::Path;

use ebur128::{EbuR128, Mode};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tracing::{debug, warn};

/// ReplayGain 2.0 reference loudness in LUFS.
const REFERENCE_LUFS: f64 = -18.0;

/// Keep metadata-derived gain finite; the wide range permits quiet recordings.
pub fn replay_gain(db: Option<f32>) -> f32 {
    db.filter(|value| value.is_finite())
        .map_or(1.0, |value| 10.0_f32.powf(value.clamp(-96.0, 60.0) / 20.0))
}

/// Analyze a cached audio file and return the ReplayGain-compatible gain in dB.
///
/// Decodes the entire file, measures integrated loudness (EBU R128), and returns
/// the gain needed to bring the track to the reference level (-18 LUFS).
pub fn analyze_loudness(
    path: &Path,
    ext: &str,
    is_current: impl Fn() -> bool,
) -> Result<f32, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("open: {}", e))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    hint.with_extension(ext);

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("probe: {}", e))?;

    let mut format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
        .ok_or("no audio track")?;

    let sample_rate = track.codec_params.sample_rate.ok_or("no sample rate")?;
    let channels = track
        .codec_params
        .channels
        .map(|c| c.count() as u32)
        .unwrap_or(2);
    let track_id = track.id;

    let mut decoder = super::deck::decode::codec_registry()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("decoder: {}", e))?;

    let mut meter =
        EbuR128::new(channels, sample_rate, Mode::I).map_err(|e| format!("ebur128: {}", e))?;

    let mut sample_buf: Option<SampleBuffer<f32>> = None;
    let mut total_frames = 0u64;

    loop {
        if !is_current() {
            return Err("analysis cancelled".into());
        }
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(symphonia::core::errors::Error::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break; // End of stream
            }
            Err(_) => break,
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(_) => continue,
        };

        let spec = *decoded.spec();
        let duration = decoded.capacity();

        let buf = match sample_buf.as_mut() {
            Some(b) if b.len() >= duration * channels as usize => b,
            _ => {
                sample_buf = Some(SampleBuffer::<f32>::new(duration as u64, spec));
                sample_buf.as_mut().unwrap()
            }
        };
        buf.copy_interleaved_ref(decoded);

        let samples = buf.samples();
        // ebur128 expects interleaved f32 frames
        let frame_count = samples.len() / channels as usize;
        if frame_count > 0 {
            meter
                .add_frames_f32(samples)
                .map_err(|e| format!("add_frames: {}", e))?;
            total_frames += frame_count as u64;
        }
    }

    let loudness = meter
        .loudness_global()
        .map_err(|e| format!("loudness: {}", e))?;

    if loudness.is_finite() {
        let gain_db = (REFERENCE_LUFS - loudness) as f32;
        debug!(
            path = %path.display(),
            loudness_lufs = format!("{:.1}", loudness),
            gain_db = format!("{:.1}", gain_db),
            frames = total_frames,
            "loudness analysis complete"
        );
        Ok(gain_db)
    } else {
        warn!(path = %path.display(), "loudness analysis returned non-finite value");
        Ok(0.0)
    }
}
