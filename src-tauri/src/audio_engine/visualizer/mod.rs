//! Reusable mono ring and FFT buffers. No frame-sized allocations or front copies.
pub mod fft;
pub mod transport;

use self::fft::{FftProcessor, FFT_SIZE, NUM_BINS};

#[derive(serde::Serialize)]
pub struct VisualizerFrame<'a> {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub samples: &'a [f32],
    pub frequency_bins: &'a [f32],
}

pub struct VisualizerProcessor {
    buffer: [f32; FFT_SIZE],
    window: [f32; FFT_SIZE],
    bins: [f32; NUM_BINS],
    channels: usize,
    cursor: usize,
    filled: usize,
    channel: usize,
    channel_sum: f32,
    fft: FftProcessor,
}

impl VisualizerProcessor {
    pub fn new(channels: u16) -> Self {
        Self {
            buffer: [0.0; FFT_SIZE], window: [0.0; FFT_SIZE], bins: [-100.0; NUM_BINS],
            channels: channels.max(1) as usize, cursor: 0, filled: 0,
            channel: 0, channel_sum: 0.0, fft: FftProcessor::new(),
        }
    }

    pub fn push_samples(&mut self, samples: &[f32]) {
        for sample in samples {
            self.channel_sum += sample;
            self.channel += 1;
            if self.channel == self.channels {
                self.buffer[self.cursor] = self.channel_sum / self.channels as f32;
                self.cursor = (self.cursor + 1) % FFT_SIZE;
                self.filled = (self.filled + 1).min(FFT_SIZE);
                self.channel_sum = 0.0;
                self.channel = 0;
            }
        }
    }

    /// Borrow reusable output until the next push/compute. The worker serializes
    /// these slices directly rather than allocating owned event vectors.
    pub fn compute(&mut self) -> Option<VisualizerFrame<'_>> {
        if self.filled < FFT_SIZE { return None; }
        let tail = FFT_SIZE - self.cursor;
        self.window[..tail].copy_from_slice(&self.buffer[self.cursor..]);
        self.window[tail..].copy_from_slice(&self.buffer[..self.cursor]);
        self.fft.compute_into(&self.window, &mut self.bins);
        Some(VisualizerFrame { kind: "visFrame", samples: &self.window, frequency_bins: &self.bins })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn newest_window_matches_downmix_across_chunk_boundaries_and_reuses_outputs() {
        for channels in [0,1,2,6] {
            let mut processor = VisualizerProcessor::new(channels);
            assert!(processor.compute().is_none());
            let ch = channels.max(1) as usize;
            let pcm: Vec<_> = (0..(FFT_SIZE+317)*ch).map(|i| (i as f32 * 0.01).sin()).collect();
            for chunk in pcm.chunks(137) { processor.push_samples(chunk); }
            let mono = fft::downmix_to_mono(&pcm, channels);
            let expected = &mono[mono.len()-FFT_SIZE..];
            let mut bins = [-100.0; NUM_BINS];
            FftProcessor::new().compute_into(expected, &mut bins);
            let output = processor.compute().unwrap();
            assert_eq!(output.samples, expected);
            assert_eq!(output.frequency_bins, bins);
            let pointers = (output.samples.as_ptr(), output.frequency_bins.as_ptr());
            processor.push_samples(&pcm);
            let next = processor.compute().unwrap();
            assert_eq!((next.samples.as_ptr(), next.frequency_bins.as_ptr()), pointers);
            let event = serde_json::to_value(next).unwrap();
            assert_eq!(event["type"], "visFrame");
            assert_eq!(event["samples"].as_array().unwrap().len(), FFT_SIZE);
            assert_eq!(event["frequency_bins"].as_array().unwrap().len(), NUM_BINS);
        }
    }
}
