#![allow(dead_code)]

use std::sync::atomic::Ordering;
use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Stream, StreamConfig};
use ringbuf::traits::Consumer;
use ringbuf::HeapCons;
use tracing::{error, info};

use super::decoder::DecoderShared;

/// Size of the ring buffer in samples (2 seconds at 48kHz stereo)
pub const RING_BUFFER_SIZE: usize = 48000 * 2 * 2;

/// Builds and starts the cpal output stream.
/// Returns the Stream handle (must be kept alive) and the device sample rate.
pub fn start_output(
    consumer: HeapCons<f32>,
    shared: Arc<DecoderShared>,
) -> Result<(Stream, u32), String> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or("No audio output device found")?;

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

fn build_f32_stream(
    device: &cpal::Device,
    config: &StreamConfig,
    mut consumer: HeapCons<f32>,
    shared: Arc<DecoderShared>,
) -> Result<Stream, String> {
    let output_channels = config.channels as usize;

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
                    data.fill(0.0);
                    return;
                }

                // If paused or finished, output silence
                if shared.paused.load(Ordering::Relaxed) {
                    data.fill(0.0);
                    return;
                }

                let volume = shared.volume();
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
                        // Apply volume
                        for sample in &mut data[pos..pos + available] {
                            *sample *= volume;
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

                        // Map source channels to output channels
                        for out_ch in 0..output_channels {
                            let src_ch = if out_ch < source_channels {
                                out_ch
                            } else {
                                // Duplicate last source channel for extra output channels
                                source_channels - 1
                            };
                            if pos < data.len() {
                                data[pos] = frame[src_ch] * volume;
                                pos += 1;
                            }
                        }
                    }
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
