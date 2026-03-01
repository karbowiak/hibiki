#![allow(dead_code)]

use std::fs::File;
use std::io::Cursor;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;

use crossbeam_channel::{Receiver, Sender};
use once_cell::sync::Lazy;
use ringbuf::traits::Producer;
use ringbuf::HeapProd;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::{Limit, MetadataOptions};
use symphonia::core::probe::Hint;
use tracing::{debug, error, info, warn};

use super::types::{AudioCommand, AudioEvent, PlaybackState, TrackMeta};

/// Dedicated HTTP client for audio fetching (accepts self-signed certs)
static AUDIO_HTTP: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .expect("failed to build audio HTTP client")
});

/// Dedicated tokio runtime for async HTTP I/O in the decoder thread
static DECODER_RT: Lazy<tokio::runtime::Runtime> = Lazy::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("audio-http")
        .enable_all()
        .build()
        .expect("failed to build decoder tokio runtime")
});

/// Shared state between decoder thread and output callback
pub struct DecoderShared {
    /// Current playback position in samples (across all channels)
    pub position_samples: AtomicI64,
    /// Sample rate of current track
    pub sample_rate: AtomicI64,
    /// Number of channels
    pub channels: AtomicI64,
    /// Whether the decoder is paused
    pub paused: AtomicBool,
    /// Whether the decoder has finished the current track
    pub finished: AtomicBool,
    /// Volume (stored as fixed-point: value * 1000)
    pub volume_millths: AtomicI64,
    /// Output device sample rate (set once at startup by output.rs)
    pub device_sample_rate: AtomicI64,
    /// Directory for audio file cache (None = caching disabled)
    pub cache_dir: Option<PathBuf>,
    /// Maximum audio cache size in bytes (0 = unlimited)
    pub max_cache_bytes: AtomicU64,
    /// Set to true when a new Play command is received so the output callback
    /// can instantly drain stale samples from the previous track.
    pub flush_pending: AtomicBool,
}

impl DecoderShared {
    pub fn new(cache_dir: Option<PathBuf>) -> Self {
        Self {
            position_samples: AtomicI64::new(0),
            sample_rate: AtomicI64::new(44100),
            channels: AtomicI64::new(2),
            paused: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            volume_millths: AtomicI64::new(800), // 0.8 default
            device_sample_rate: AtomicI64::new(44100),
            cache_dir,
            max_cache_bytes: AtomicU64::new(1_073_741_824), // 1 GB default
            flush_pending: AtomicBool::new(false),
        }
    }

    pub fn position_ms(&self) -> i64 {
        let samples = self.position_samples.load(Ordering::Relaxed);
        let rate = self.sample_rate.load(Ordering::Relaxed);
        let channels = self.channels.load(Ordering::Relaxed);
        if rate == 0 || channels == 0 {
            return 0;
        }
        // samples is total interleaved samples, so frames = samples / channels
        (samples / channels) * 1000 / rate
    }

    pub fn set_volume(&self, volume: f32) {
        let v = (volume.clamp(0.0, 1.0) * 1000.0) as i64;
        self.volume_millths.store(v, Ordering::Relaxed);
    }

    pub fn volume(&self) -> f32 {
        self.volume_millths.load(Ordering::Relaxed) as f32 / 1000.0
    }
}

/// Simple linear interpolation resampler for interleaved f32 audio.
///
/// Converts from `in_rate` to `out_rate` using linear interpolation.
/// Good enough for Phase A; will be replaced with rubato (sinc) in Phase B.
fn resample_linear(input: &[f32], in_rate: u32, out_rate: u32, channels: u32) -> Vec<f32> {
    if in_rate == out_rate || input.is_empty() || channels == 0 {
        return input.to_vec();
    }

    let ch = channels as usize;
    let in_frames = input.len() / ch;
    let ratio = in_rate as f64 / out_rate as f64;
    let out_frames = ((in_frames as f64) / ratio).ceil() as usize;
    let mut output = Vec::with_capacity(out_frames * ch);

    for i in 0..out_frames {
        let src_pos = i as f64 * ratio;
        let src_idx = src_pos.floor() as usize;
        let frac = (src_pos - src_idx as f64) as f32;

        for c in 0..ch {
            let s0 = input.get(src_idx * ch + c).copied().unwrap_or(0.0);
            let s1 = input
                .get((src_idx + 1) * ch + c)
                .copied()
                .unwrap_or(s0);
            output.push(s0 + (s1 - s0) * frac);
        }
    }

    output
}

/// Fetch audio bytes from a URL
fn fetch_audio(url: &str) -> Result<Vec<u8>, String> {
    info!(url = url, "Fetching audio data");
    DECODER_RT
        .block_on(async {
            let resp = AUDIO_HTTP
                .get(url)
                .send()
                .await
                .map_err(|e| format!("HTTP fetch failed: {e}"))?;

            if !resp.status().is_success() {
                return Err(format!("HTTP {} for audio URL", resp.status()));
            }

            let bytes = resp
                .bytes()
                .await
                .map_err(|e| format!("Failed to read audio bytes: {e}"))?;

            info!(size = bytes.len(), "Audio data fetched");
            Ok(bytes.to_vec())
        })
}

/// Derive a deterministic cache filename from a URL.
///
/// Strips the scheme, host, and query string — keeping only the path.
/// Example: `https://plex.example.com:32400/library/parts/42/file.flac?token=abc`
///       → `library_parts_42_file.flac.audio`
fn audio_cache_key(url: &str) -> String {
    let without_query = url.split('?').next().unwrap_or(url);
    let path = without_query
        .split("://")
        .nth(1)
        .and_then(|rest| rest.splitn(2, '/').nth(1))
        .unwrap_or(without_query);
    format!("{}.audio", path.replace('/', "_"))
}

/// Open a URL for streaming decode.
///
/// - **Cache hit**: opens the cached `.audio` file directly (~1 ms, no full RAM copy)
/// - **Cache miss**: fetches from network, writes to cache, then opens the cache file
///
/// Using a `File`-backed `MediaSourceStream` lets symphonia stream packets on-demand
/// rather than loading the entire file into memory before decoding starts.
fn open_for_decode(url: &str, shared: &Arc<DecoderShared>) -> Result<(MediaSourceStream, String), String> {
    if let Some(ref cache_dir) = shared.cache_dir {
        let _ = std::fs::create_dir_all(cache_dir);
        let cache_path = cache_dir.join(audio_cache_key(url));
        if cache_path.exists() {
            info!(url = url, "Audio cache hit — streaming from disk");
            let file = File::open(&cache_path)
                .map_err(|e| format!("Failed to open cached audio: {e}"))?;
            let mss = MediaSourceStream::new(Box::new(file), Default::default());
            return Ok((mss, url.to_string()));
        }
    }

    // Cache miss — fetch from network
    let bytes = fetch_audio(url)?;

    // Save to cache, then open from disk (avoids keeping the whole file in RAM during decode)
    if let Some(ref cache_dir) = shared.cache_dir {
        let cache_path = cache_dir.join(audio_cache_key(url));
        if std::fs::write(&cache_path, &bytes).is_ok() {
            let max_bytes = shared.max_cache_bytes.load(Ordering::Relaxed);
            if max_bytes > 0 {
                evict_cache_if_needed(cache_dir, max_bytes);
            }
            if let Ok(file) = File::open(&cache_path) {
                let mss = MediaSourceStream::new(Box::new(file), Default::default());
                return Ok((mss, url.to_string()));
            }
        }
    }

    // Fallback: in-memory cursor (no cache dir configured or write failed)
    let cursor = Cursor::new(bytes);
    let mss = MediaSourceStream::new(Box::new(cursor), Default::default());
    Ok((mss, url.to_string()))
}

/// Delete oldest `.audio` cache files until total size is within `max_bytes`.
fn evict_cache_if_needed(cache_dir: &std::path::Path, max_bytes: u64) {
    let mut entries: Vec<(std::path::PathBuf, u64, std::time::SystemTime)> =
        match std::fs::read_dir(cache_dir) {
            Ok(rd) => rd
                .filter_map(|e| e.ok())
                .filter(|e| {
                    e.path().extension().and_then(|x| x.to_str()) == Some("audio")
                })
                .filter_map(|e| {
                    let meta = e.metadata().ok()?;
                    let mtime = meta.modified().ok()?;
                    Some((e.path(), meta.len(), mtime))
                })
                .collect(),
            Err(_) => return,
        };

    let total: u64 = entries.iter().map(|(_, size, _)| size).sum();
    if total <= max_bytes {
        return;
    }

    // Oldest first
    entries.sort_by_key(|(_, _, mtime)| *mtime);

    let mut remaining = total;
    for (path, size, _) in entries {
        if remaining <= max_bytes {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            remaining = remaining.saturating_sub(size);
            debug!(path = ?path, "Evicted audio cache entry");
        }
    }
}

/// Warm the audio disk cache for `url` in the background.
///
/// No-op if the file is already cached. Fire-and-forget; never blocks the caller.
pub fn prefetch_url_bg(url: String, shared: Arc<DecoderShared>) {
    DECODER_RT.spawn(async move {
        // Skip if already cached
        if let Some(ref cache_dir) = shared.cache_dir {
            let cache_path = cache_dir.join(audio_cache_key(&url));
            if cache_path.exists() {
                debug!(url = %url, "Audio prefetch: already cached");
                return;
            }
            let _ = std::fs::create_dir_all(cache_dir);
        } else {
            return; // caching disabled
        }

        // Fetch and store
        match AUDIO_HTTP.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => {
                match resp.bytes().await {
                    Ok(bytes) => {
                        if let Some(ref cache_dir) = shared.cache_dir {
                            let cache_path = cache_dir.join(audio_cache_key(&url));
                            let _ = std::fs::write(&cache_path, &bytes);
                            let max_bytes = shared.max_cache_bytes.load(Ordering::Relaxed);
                            if max_bytes > 0 {
                                evict_cache_if_needed(cache_dir, max_bytes);
                            }
                            info!(url = %url, size = bytes.len(), "Audio prefetch complete");
                        }
                    }
                    Err(e) => warn!(url = %url, error = %e, "Audio prefetch: failed to read bytes"),
                }
            }
            Ok(resp) => warn!(url = %url, status = %resp.status(), "Audio prefetch: bad status"),
            Err(e) => warn!(url = %url, error = %e, "Audio prefetch: request failed"),
        }
    });
}

/// Probe a `MediaSourceStream` and return a format reader + decoder + track info.
///
/// Accepts any MSS (file-backed, in-memory, etc.) — symphonia streams packets
/// on-demand so decoding begins immediately after reading just the headers.
fn probe_audio(
    mss: MediaSourceStream,
    url: &str,
) -> Result<
    (
        Box<dyn FormatReader>,
        Box<dyn symphonia::core::codecs::Decoder>,
        u32, // track_id
        u32, // sample_rate
        u32, // channels
    ),
    String,
> {
    // Hint the container from the URL extension
    let mut hint = Hint::new();
    if let Some(ext) = url.rsplit('.').next() {
        let ext_lower = ext.split('?').next().unwrap_or(ext).to_lowercase();
        hint.with_extension(&ext_lower);
    }

    let format_opts = FormatOptions {
        enable_gapless: true,
        ..Default::default()
    };
    // Skip embedded artwork (PICTURE blocks can be 3–10 MB in FLAC files).
    // We load artwork via Plex's thumb endpoint, not from audio tags.
    let metadata_opts = MetadataOptions {
        limit_metadata_bytes: Limit::Maximum(16 * 1024),
        limit_visual_bytes: Limit::Maximum(0),
    };

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &format_opts, &metadata_opts)
        .map_err(|e| format!("Failed to probe audio format: {e}"))?;

    let format = probed.format;

    // Find the first audio track
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or("No audio track found")?;

    let track_id = track.id;
    let sample_rate = track
        .codec_params
        .sample_rate
        .ok_or("Unknown sample rate")?;
    let channels = track
        .codec_params
        .channels
        .map(|c| c.count() as u32)
        .unwrap_or(2);

    let decoder_opts = DecoderOptions::default();
    let decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &decoder_opts)
        .map_err(|e| format!("Failed to create decoder: {e}"))?;

    info!(
        sample_rate = sample_rate,
        channels = channels,
        codec = ?track.codec_params.codec,
        "Audio probed successfully"
    );

    Ok((format, decoder, track_id, sample_rate, channels))
}

/// The main decoder thread loop
pub fn decoder_thread(
    cmd_rx: Receiver<AudioCommand>,
    event_tx: Sender<AudioEvent>,
    mut producer: HeapProd<f32>,
    shared: Arc<DecoderShared>,
) {
    info!("Decoder thread started");

    let mut current_track: Option<TrackMeta> = None;
    let mut format_reader: Option<Box<dyn FormatReader>> = None;
    let mut decoder: Option<Box<dyn symphonia::core::codecs::Decoder>> = None;
    let mut current_track_id: u32 = 0;

    // Reusable sample buffer (resized as needed)
    let mut sample_buf: Option<SampleBuffer<f32>> = None;

    loop {
        // If paused or no track, block on command channel
        if shared.paused.load(Ordering::Relaxed) || format_reader.is_none() {
            match cmd_rx.recv() {
                Ok(cmd) => {
                    if handle_command(
                        cmd,
                        &cmd_rx,
                        &event_tx,
                        &mut producer,
                        &shared,
                        &mut current_track,
                        &mut format_reader,
                        &mut decoder,
                        &mut current_track_id,
                        &mut sample_buf,
                    ) {
                        return; // Shutdown
                    }
                }
                Err(_) => {
                    info!("Command channel closed, decoder thread exiting");
                    return;
                }
            }
            continue;
        }

        // Check for commands (non-blocking)
        while let Ok(cmd) = cmd_rx.try_recv() {
            if handle_command(
                cmd,
                &cmd_rx,
                &event_tx,
                &mut producer,
                &shared,
                &mut current_track,
                &mut format_reader,
                &mut decoder,
                &mut current_track_id,
                &mut sample_buf,
            ) {
                return; // Shutdown
            }
        }

        // Decode next packet
        if let (Some(ref mut fmt), Some(ref mut dec)) = (&mut format_reader, &mut decoder) {
            match fmt.next_packet() {
                Ok(packet) => {
                    if packet.track_id() != current_track_id {
                        continue;
                    }

                    match dec.decode(&packet) {
                        Ok(audio_buf) => {
                            let spec = *audio_buf.spec();
                            let num_frames = audio_buf.frames();

                            // Ensure sample buffer is large enough
                            if sample_buf
                                .as_ref()
                                .map_or(true, |sb| sb.capacity() < num_frames)
                            {
                                sample_buf =
                                    Some(SampleBuffer::new(num_frames as u64, spec));
                            }

                            let sb = sample_buf.as_mut().unwrap();
                            sb.copy_interleaved_ref(audio_buf);

                            // Copy samples to a local vec so we release the
                            // mutable borrow on sample_buf before the push loop
                            // (which may need to call handle_command with &mut sample_buf)
                            let raw_samples: Vec<f32> = sb.samples().to_vec();
                            let raw_sample_count = raw_samples.len();

                            // Resample if source rate differs from output device rate
                            let src_rate = shared.sample_rate.load(Ordering::Relaxed) as u32;
                            let dev_rate = shared.device_sample_rate.load(Ordering::Relaxed) as u32;
                            let ch = shared.channels.load(Ordering::Relaxed) as u32;
                            let samples = if src_rate != dev_rate && dev_rate > 0 {
                                resample_linear(&raw_samples, src_rate, dev_rate, ch)
                            } else {
                                raw_samples
                            };
                            let sample_count = samples.len();

                            // Push to ring buffer, waiting if full
                            let mut written = 0;
                            while written < sample_count {
                                // Check for commands while waiting for buffer space
                                if let Ok(cmd) = cmd_rx.try_recv() {
                                    if handle_command(
                                        cmd,
                                        &cmd_rx,
                                        &event_tx,
                                        &mut producer,
                                        &shared,
                                        &mut current_track,
                                        &mut format_reader,
                                        &mut decoder,
                                        &mut current_track_id,
                                        &mut sample_buf,
                                    ) {
                                        return;
                                    }
                                    // Track may have changed, break inner loop
                                    if format_reader.is_none() {
                                        break;
                                    }
                                }

                                let n = producer.push_slice(&samples[written..]);
                                written += n;
                                if n == 0 {
                                    // Buffer full, yield briefly
                                    std::thread::sleep(std::time::Duration::from_millis(5));
                                }
                            }

                            // Update position (use raw/source sample count, not resampled)
                            // This ensures position_ms() reports the correct source-time position
                            shared
                                .position_samples
                                .fetch_add(raw_sample_count as i64, Ordering::Relaxed);
                        }
                        Err(symphonia::core::errors::Error::DecodeError(e)) => {
                            warn!(error = %e, "Decode error (skipping packet)");
                        }
                        Err(e) => {
                            error!(error = %e, "Fatal decode error");
                            let _ = event_tx.send(AudioEvent::Error {
                                message: format!("Decode error: {e}"),
                            });
                            format_reader = None;
                            decoder = None;
                        }
                    }
                }
                Err(symphonia::core::errors::Error::IoError(ref e))
                    if e.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    // End of stream — track finished
                    info!("Track decode complete (EOF)");
                    if let Some(ref meta) = current_track {
                        let _ = event_tx.send(AudioEvent::TrackEnded {
                            rating_key: meta.rating_key,
                        });
                    }
                    shared.finished.store(true, Ordering::Relaxed);
                    format_reader = None;
                    decoder = None;
                    current_track = None;
                }
                Err(e) => {
                    error!(error = %e, "Format reader error");
                    let _ = event_tx.send(AudioEvent::Error {
                        message: format!("Read error: {e}"),
                    });
                    format_reader = None;
                    decoder = None;
                }
            }
        }
    }
}

/// Handle a single command. Returns true if the thread should shut down.
#[allow(clippy::too_many_arguments)]
fn handle_command(
    cmd: AudioCommand,
    _cmd_rx: &Receiver<AudioCommand>,
    event_tx: &Sender<AudioEvent>,
    _producer: &mut HeapProd<f32>,
    shared: &Arc<DecoderShared>,
    current_track: &mut Option<TrackMeta>,
    format_reader: &mut Option<Box<dyn FormatReader>>,
    decoder: &mut Option<Box<dyn symphonia::core::codecs::Decoder>>,
    current_track_id: &mut u32,
    sample_buf: &mut Option<SampleBuffer<f32>>,
) -> bool {
    match cmd {
        AudioCommand::Play(meta) => {
            info!(rating_key = meta.rating_key, url = %meta.url, "Play command received");

            // Signal the output callback to drain stale samples from the previous track
            // immediately. The next cpal callback (~10 ms away) will empty the ring buffer
            // and output silence for that single period — no old audio bleeds through.
            shared.flush_pending.store(true, Ordering::Release);

            // Emit buffering state
            let _ = event_tx.send(AudioEvent::State {
                state: PlaybackState::Buffering,
            });

            // Open for streaming decode (cache hit → File::open, ~1 ms; miss → fetch + save)
            match open_for_decode(&meta.url, shared) {
                Ok((mss, url)) => match probe_audio(mss, &url) {
                    Ok((fmt, dec, tid, sr, ch)) => {
                        *format_reader = Some(fmt);
                        *decoder = Some(dec);
                        *current_track_id = tid;
                        *sample_buf = None;

                        shared.sample_rate.store(sr as i64, Ordering::Relaxed);
                        shared.channels.store(ch as i64, Ordering::Relaxed);
                        shared.position_samples.store(0, Ordering::Relaxed);
                        shared.paused.store(false, Ordering::Relaxed);
                        shared.finished.store(false, Ordering::Relaxed);

                        // Clear any stale samples in the ring buffer
                        // (push silence to flush isn't needed — just note the producer is shared)

                        *current_track = Some(meta.clone());

                        let _ = event_tx.send(AudioEvent::TrackStarted {
                            rating_key: meta.rating_key,
                            duration_ms: meta.duration_ms,
                        });
                        let _ = event_tx.send(AudioEvent::State {
                            state: PlaybackState::Playing,
                        });
                    }
                    Err(e) => {
                        error!(error = %e, "Failed to probe audio");
                        let _ = event_tx.send(AudioEvent::Error {
                            message: e.clone(),
                        });
                        let _ = event_tx.send(AudioEvent::State {
                            state: PlaybackState::Stopped,
                        });
                    }
                },
                Err(e) => {
                    error!(error = %e, "Failed to fetch audio");
                    let _ = event_tx.send(AudioEvent::Error {
                        message: e.clone(),
                    });
                    let _ = event_tx.send(AudioEvent::State {
                        state: PlaybackState::Stopped,
                    });
                }
            }
        }

        AudioCommand::Pause => {
            shared.paused.store(true, Ordering::Relaxed);
            let _ = event_tx.send(AudioEvent::State {
                state: PlaybackState::Paused,
            });
        }

        AudioCommand::Resume => {
            shared.paused.store(false, Ordering::Relaxed);
            if format_reader.is_some() {
                let _ = event_tx.send(AudioEvent::State {
                    state: PlaybackState::Playing,
                });
            }
        }

        AudioCommand::Stop => {
            *format_reader = None;
            *decoder = None;
            *current_track = None;
            shared.paused.store(false, Ordering::Relaxed);
            shared.finished.store(true, Ordering::Relaxed);
            shared.position_samples.store(0, Ordering::Relaxed);
            let _ = event_tx.send(AudioEvent::State {
                state: PlaybackState::Stopped,
            });
        }

        AudioCommand::Seek(ms) => {
            if let Some(ref mut fmt) = format_reader {
                let time_secs = ms as f64 / 1000.0;
                let seek_to = SeekTo::Time {
                    time: symphonia::core::units::Time {
                        seconds: time_secs as u64,
                        frac: time_secs.fract(),
                    },
                    track_id: Some(*current_track_id),
                };
                match fmt.seek(SeekMode::Coarse, seek_to) {
                    Ok(seeked) => {
                        // Reset decoder state after seek
                        if let Some(ref mut dec) = decoder {
                            dec.reset();
                        }
                        let ch = shared.channels.load(Ordering::Relaxed);
                        // Position in interleaved samples (frames * channels)
                        shared.position_samples.store(
                            (seeked.actual_ts as i64) * ch,
                            Ordering::Relaxed,
                        );
                        debug!(seeked_to_ms = ms, actual_ts = seeked.actual_ts, "Seek complete");
                    }
                    Err(e) => {
                        warn!(error = %e, "Seek failed");
                    }
                }
            }
        }

        AudioCommand::SetVolume(vol) => {
            shared.set_volume(vol);
        }

        AudioCommand::PreloadNext(meta) => {
            // Warm the disk cache for the next track so open_for_decode() is near-instant.
            // Fire-and-forget — never blocks the decoder thread.
            debug!(rating_key = meta.rating_key, url = %meta.url, "PreloadNext: warming cache");
            prefetch_url_bg(meta.url.clone(), Arc::clone(shared));
        }

        AudioCommand::Shutdown => {
            info!("Decoder thread shutting down");
            return true;
        }
    }

    false
}
