#![allow(dead_code)]

use std::sync::atomic::Ordering;
use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Stream, StreamConfig};
use ringbuf::traits::Consumer;
use ringbuf::HeapCons;
use tracing::{error, info};

use super::decoder::DecoderShared;
use super::eq::{BiquadCoeffs, BiquadState};

/// Size of the ring buffer in samples (2 seconds at 48kHz stereo)
pub const RING_BUFFER_SIZE: usize = 48000 * 2 * 2;

/// Builds and starts the cpal output stream.
/// Returns the Stream handle (must be kept alive) and the device sample rate.
pub fn start_output(
    consumer: HeapCons<f32>,
    shared: Arc<DecoderShared>,
) -> Result<(Stream, u32), String> {
    let host = cpal::default_host();

    // Use the user-preferred device if set; fall back to system default.
    let preferred = shared.preferred_device_name.try_lock()
        .ok()
        .and_then(|g| g.clone());
    let device = if let Some(ref name) = preferred {
        host.output_devices()
            .ok()
            .and_then(|mut devs| devs.find(|d| d.name().ok().as_deref() == Some(name.as_str())))
            .or_else(|| host.default_output_device())
            .ok_or_else(|| format!("Audio output device '{}' not found and no default available", name))?
    } else {
        host.default_output_device()
            .ok_or("No audio output device found")?
    };

    let default_config = device
        .default_output_config()
        .map_err(|e| format!("Failed to get default output config: {e}"))?;

    let sample_rate = default_config.sample_rate().0;
    let channels = default_config.channels();

    info!(
        device = device.name().unwrap_or_default(),
        sample_rate = sample_rate,
        channels = channels,
        sample_format = ?default_config.sample_format(),
        "Audio output device selected"
    );

    // We always output f32 — cpal handles conversion to device native format
    let config = StreamConfig {
        channels,
        sample_rate: cpal::SampleRate(sample_rate),
        buffer_size: cpal::BufferSize::Default,
    };

    let stream = build_f32_stream(&device, &config, consumer, shared)?;

    stream
        .play()
        .map_err(|e| format!("Failed to start audio stream: {e}"))?;

    Ok((stream, sample_rate))
}

/// Smooth soft-knee peak limiter — transparent below 0.95 (≈ −0.45 dBFS),
/// curves asymptotically toward ±1.0 above the threshold.
/// Always active; no toggle needed — it's a safety net, not an effect.
#[inline(always)]
fn soft_limit(x: f32) -> f32 {
    const THRESH: f32 = 0.95;
    let abs = x.abs();
    if abs <= THRESH {
        x
    } else {
        // Normalize overshoot to [0, ∞) so the result asymptotes to exactly 1.0.
        // At abs = THRESH: over = 0 → result = THRESH.
        // As abs → ∞: over → ∞, over/(1+over) → 1 → result → THRESH + (1-THRESH) = 1.0.
        let over = (abs - THRESH) / (1.0 - THRESH);
        let sign = if x > 0.0 { 1.0f32 } else { -1.0f32 };
        (THRESH + (1.0 - THRESH) * over / (1.0 + over)) * sign
    }
}

fn build_f32_stream(
    device: &cpal::Device,
    config: &StreamConfig,
    mut consumer: HeapCons<f32>,
    shared: Arc<DecoderShared>,
) -> Result<Stream, String> {
    let output_channels = config.channels as usize;

    // EQ filter state lives here, captured by the closure and persists across callbacks.
    // [band 0..10][channel 0..8] — Direct Form I history per band per channel.
    let mut eq_state = [[BiquadState::default(); 8]; 10];
    let mut eq_was_enabled = false;
    // PCM accumulator for the visualizer relay — collects mono-mixed samples.
    let mut vis_accum: Vec<f32> = Vec::with_capacity(512);

    let stream = device
        .build_output_stream(
            config,
            move |data: &mut [f32], _info: &cpal::OutputCallbackInfo| {
                // A new Play command was received — drain all stale samples from the
                // previous track instantly so the new track starts without old audio
                // bleeding through. Uses `data` as a scratch buffer; draining ~192 k f32
                // samples takes < 0.1 ms (pure memory copies).
                if shared.flush_pending.swap(false, Ordering::AcqRel) {
                    loop {
                        let n = consumer.pop_slice(data);
                        if n < data.len() {
                            break;
                        }
                    }
                    // Reset EQ history to prevent stale IIR state causing audible clicks
                    for band in &mut eq_state { *band = [BiquadState::default(); 8]; }
                    data.fill(0.0);
                    return;
                }

                // A Seek command completed — drain pre-seek samples so the seeked
                // position is heard immediately instead of after ~2 s of buffered audio.
                // Unlike flush_pending, the decoder push loop is NOT interrupted here;
                // new samples from the seeked position are pushed concurrently.
                if shared.seek_flush_pending.swap(false, Ordering::AcqRel) {
                    loop {
                        let n = consumer.pop_slice(data);
                        if n < data.len() {
                            break;
                        }
                    }
                    // Reset EQ history to prevent seeking artifacts from stale IIR state
                    for band in &mut eq_state { *band = [BiquadState::default(); 8]; }
                    data.fill(0.0);
                    return;
                }

                // If paused or finished, output silence
                if shared.paused.load(Ordering::Relaxed) {
                    data.fill(0.0);
                    return;
                }

                // EQ: snapshot enabled flag + coefficients once per callback (not per-sample).
                // If EQ was just re-enabled, reset IIR state to avoid a pop from stale history.
                let eq_enabled = shared.eq_enabled.load(Ordering::Relaxed);
                if eq_enabled && !eq_was_enabled {
                    for band in &mut eq_state { *band = [BiquadState::default(); 8]; }
                }
                eq_was_enabled = eq_enabled;
                let coeffs: Option<[BiquadCoeffs; 10]> = if eq_enabled {
                    shared.eq_coeffs.lock().ok().map(|g| *g)
                } else {
                    None
                };

                // Normalization gain is applied in the decoder before samples reach the
                // ring buffer, so the output callback only needs to scale by volume × pre-amp.
                let volume = shared.volume();
                let preamp = shared.preamp_gain_millths.load(Ordering::Relaxed) as f32 / 1_000.0;
                let source_channels = shared.channels.load(Ordering::Relaxed) as usize;

                if source_channels == 0 {
                    data.fill(0.0);
                    return;
                }

                // Read samples from ring buffer
                let mut pos = 0;
                while pos < data.len() {
                    // We need to handle channel count mismatch between source and output
                    if source_channels == output_channels {
                        // Direct read
                        let available = consumer.pop_slice(&mut data[pos..]);
                        if available == 0 {
                            // Underrun — fill remainder with silence
                            data[pos..].fill(0.0);
                            break;
                        }
                        // Apply volume × pre-amp, then EQ, then soft limiter — single pass.
                        // Channel index is (absolute output position) % output_channels.
                        for (i, sample) in data[pos..pos + available].iter_mut().enumerate() {
                            let ch = (pos + i) % output_channels;
                            *sample *= volume * preamp;
                            if let Some(ref c) = coeffs {
                                for band in 0..10 {
                                    if !c[band].is_identity() {
                                        *sample = eq_state[band][ch].process(*sample, &c[band]);
                                    }
                                }
                            }
                            *sample = soft_limit(*sample);
                        }
                        pos += available;
                    } else {
                        // Channel conversion needed — read one frame at a time
                        let mut frame = [0.0f32; 8]; // max 8 channels
                        let frame_slice = &mut frame[..source_channels];
                        let read = consumer.pop_slice(frame_slice);
                        if read < source_channels {
                            // Underrun
                            data[pos..].fill(0.0);
                            break;
                        }

                        // Apply EQ per source channel before channel mapping
                        if let Some(ref c) = coeffs {
                            for ch in 0..source_channels {
                                let mut s = frame[ch];
                                for band in 0..10 {
                                    if !c[band].is_identity() {
                                        s = eq_state[band][ch].process(s, &c[band]);
                                    }
                                }
                                frame[ch] = s;
                            }
                        }

                        // Map source channels to output channels; apply volume × preamp + limiter
                        for out_ch in 0..output_channels {
                            let src_ch = if out_ch < source_channels {
                                out_ch
                            } else {
                                // Duplicate last source channel for extra output channels
                                source_channels - 1
                            };
                            if pos < data.len() {
                                data[pos] = soft_limit(frame[src_ch] * volume * preamp);
                                pos += 1;
                            }
                        }
                    }
                }
                // PCM IPC bridge — feed visualizer when enabled.
                // Down-mix processed output to mono and batch into 512-sample chunks.
                if shared.vis_enabled.load(Ordering::Relaxed) && output_channels > 0 {
                    let frames = data.len() / output_channels;
                    for f in 0..frames {
                        let mut mono = 0.0f32;
                        for ch in 0..output_channels {
                            mono += data[f * output_channels + ch];
                        }
                        vis_accum.push(mono / output_channels as f32);
                        if vis_accum.len() >= 512 {
                            if let Ok(guard) = shared.vis_sender.try_lock() {
                                if let Some(ref tx) = *guard {
                                    let _ = tx.try_send(vis_accum.clone());
                                }
                            }
                            vis_accum.clear();
                        }
                    }
                } else {
                    vis_accum.clear();
                }
            },
            move |err| {
                error!(error = %err, "Audio output stream error");
            },
            None, // No timeout
        )
        .map_err(|e| format!("Failed to build output stream: {e}"))?;

    Ok(stream)
}
