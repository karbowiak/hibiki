//! EBU R128 loudness analysis — computes ReplayGain-compatible gain for tracks
//! where Plex doesn't provide proper loudness data (e.g. Opus).
//!
//! Uses the `ebur128` crate which implements ITU-R BS.1770 / EBU R128.
//! The computed gain targets -18 LUFS (ReplayGain 2.0 reference level).

use super::deck::decode;
use ebur128::{Channel, EbuR128, Mode};
#[cfg(test)]
use std::path::Path;
use symphonia::core::audio::Position as Channels;
use symphonia::core::io::MediaSourceStream;
use tracing::debug;

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
#[cfg(test)]
pub fn analyze_loudness(
    path: &Path,
    ext: &str,
    is_current: impl Fn() -> bool,
) -> Result<f32, String> {
    if !is_current() {
        return Err("analysis cancelled".into());
    }
    let file = std::fs::File::open(path).map_err(|error| format!("open: {error}"))?;
    analyze_loudness_file(file, ext, is_current)
}

pub(super) fn analyze_loudness_file(
    file: std::fs::File,
    ext: &str,
    is_current: impl Fn() -> bool,
) -> Result<f32, String> {
    let source = MediaSourceStream::new(Box::new(file), Default::default());
    let mut decoder =
        decode::probe_from_source(source, Some(ext)).map_err(|error| format!("probe: {error}"))?;
    let track = decoder
        .format
        .tracks()
        .iter()
        .find(|track| track.id == decoder.track_id)
        .ok_or("Missing audio track")?;
    // Symphonia 0.6 reports playable frames, excluding encoder delay/padding.
    let expected_frames = track.num_frames;
    let mut meter = None;
    let mut total_frames = 0_u64;
    while !decoder.finished {
        if !is_current() {
            return Err("analysis cancelled".into());
        }
        let samples = decode::decode_batch(&mut decoder, 262144)
            .map_err(|error| format!("decode: {error}"))?;
        if decoder.aborted || decoder.had_decode_errors {
            return Err("Incomplete audio cannot be used for loudness analysis".into());
        }
        if samples.is_empty() {
            continue;
        }
        // First decoded packet can reveal HE-AAC SBR/PS rate/layout changes.
        // Use that format, including the exact speaker mask, just like playback.
        if meter.is_none() {
            let mut initialized = EbuR128::new(
                decoder.channels as u32,
                decoder.sample_rate,
                Mode::I | Mode::HISTOGRAM,
            )
            .map_err(|error| format!("ebur128: {error}"))?;
            initialized
                .set_channel_map(&loudness_channels(decoder.channel_layout))
                .map_err(|error| format!("channel map: {error}"))?;
            meter = Some(initialized);
        }
        let frames = samples.len() / decoder.channels as usize;
        meter
            .as_mut()
            .unwrap()
            .add_frames_f32(&samples)
            .map_err(|error| format!("add frames: {error}"))?;
        total_frames += frames as u64;
    }
    if !is_current() {
        return Err("analysis cancelled".into());
    }
    if expected_frames.is_some_and(|expected| total_frames < expected) {
        return Err("Incomplete audio cannot be used for loudness analysis".into());
    }
    let loudness = meter
        .ok_or("No decodable audio for loudness analysis")?
        .loudness_global()
        .map_err(|error| format!("loudness: {error}"))?;
    // Silence or clips shorter than the integration window do not establish
    // a useful gain. Do not permanently cache a guessed zero adjustment.
    if !loudness.is_finite() {
        return Err("No integrated loudness measurement available".into());
    }
    let gain = (REFERENCE_LUFS - loudness) as f32;
    debug!(
        loudness_lufs = loudness,
        gain_db = gain,
        frames = total_frames,
        "loudness analysis complete"
    );
    Ok(gain)
}

fn loudness_channels(layout: Channels) -> Vec<Channel> {
    layout
        .iter()
        .map(|speaker| match speaker {
            Channels::LFE1 | Channels::LFE2 => Channel::Unused,
            Channels::REAR_LEFT | Channels::SIDE_LEFT => Channel::LeftSurround,
            Channels::REAR_RIGHT | Channels::SIDE_RIGHT => Channel::RightSurround,
            Channels::FRONT_RIGHT => Channel::Right,
            Channels::FRONT_CENTER => Channel::Center,
            _ => Channel::Left,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn measure(data: Vec<u8>) -> Result<f32, String> {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("synthetic.wav");
        std::fs::write(&path, data).unwrap();
        analyze_loudness(&path, "wav", || true)
    }
    #[test]
    fn local_normalization_matches_finite_reference_gain_and_ignores_lfe_energy() {
        let rate = 44100;
        let base = Channels::FRONT_LEFT | Channels::FRONT_RIGHT;
        let tone = |frame: usize| {
            (frame as f32 * 1000.0 * std::f32::consts::TAU / rate as f32).sin() * 0.1
        };
        let stereo = measure(decode::tests::generate_layout_wav(
            rate,
            base,
            rate as usize * 2,
            |frame, _| tone(frame),
        ))
        .unwrap();
        let with_bass = measure(decode::tests::generate_layout_wav(
            rate,
            base | Channels::LFE1,
            rate as usize * 2,
            |frame, speaker| {
                if speaker == Channels::LFE1 {
                    tone(frame) * 5.0
                } else {
                    tone(frame)
                }
            },
        ))
        .unwrap();
        assert!(stereo.is_finite());
        assert!((stereo - with_bass).abs() < 0.01);
        let louder = measure(decode::tests::generate_layout_wav(
            rate,
            base,
            rate as usize * 2,
            |frame, _| tone(frame) * 2.0,
        ))
        .unwrap();
        assert!((stereo - louder - 6.0206).abs() < 0.15);
    }
    #[test]
    fn silence_empty_audio_truncation_and_cancellation_cannot_create_a_cached_guess() {
        let base = Channels::FRONT_LEFT | Channels::FRONT_RIGHT;
        assert!(
            measure(decode::tests::generate_layout_wav(
                44100,
                base,
                44100,
                |_, _| 0.0
            ))
            .is_err()
        );
        assert!(
            measure(decode::tests::generate_layout_wav(
                44100,
                base,
                0,
                |_, _| 0.0
            ))
            .is_err()
        );
        let mut truncated = decode::tests::generate_layout_wav(44100, base, 44100 * 2, |_, _| 0.1);
        truncated.truncate(truncated.len() / 2);
        assert!(measure(truncated).is_err());
        assert!(
            analyze_loudness(Path::new("does-not-exist"), "wav", || false)
                .unwrap_err()
                .contains("cancelled")
        );
    }
}
