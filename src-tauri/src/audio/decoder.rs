#![allow(dead_code)]

use std::f32::consts::FRAC_PI_2;
use std::fs::File;
use std::io::Cursor;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crossbeam_channel::{Receiver, Sender};
use once_cell::sync::Lazy;
use ringbuf::traits::Producer;
use ringbuf::HeapProd;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::{Limit, MetadataOptions, StandardTagKey, Value};
use symphonia::core::probe::Hint;
use tracing::{debug, error, info, warn};

use super::bpm;
use super::eq::{BiquadCoeffs, compute_eq_coeffs};
use super::types::{AudioCommand, AudioEvent, PlaybackState, TrackMeta};

// ---------------------------------------------------------------------------
// Statics
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// DecoderShared
// ---------------------------------------------------------------------------

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
    /// Set to true when a Seek command completes so the output callback drains
    /// the ring buffer of pre-seek audio. Unlike flush_pending, this is NOT
    /// checked in the push loop — the decoder continues pushing from the new
    /// position immediately while the output thread drains the stale samples.
    pub seek_flush_pending: AtomicBool,
    /// Crossfade window in milliseconds. 0 = disabled, default = 8000 ms.
    pub crossfade_window_ms: AtomicU64,
    /// BPM of the currently playing track (* 100 fixed-point; 0 = unknown)
    pub current_bpm: AtomicU64,
    /// BPM of the queued next track (* 100 fixed-point; 0 = unknown)
    pub next_bpm: AtomicU64,
    /// ReplayGain normalization gain for the current track (× 1000; 1000 = 1.0 linear)
    pub normalization_gain_millths: AtomicI64,
    /// ReplayGain normalization gain for the queued next track (× 1000)
    pub next_norm_gain_millths: AtomicI64,
    /// Whether ReplayGain normalization is applied (default: true)
    pub normalization_enabled: AtomicBool,
    /// Whether the EQ is active (default: false)
    pub eq_enabled: AtomicBool,
    /// Current EQ biquad coefficients — recomputed on SetEq, read once per output callback.
    /// Mutex is locked only when bands change (rare) and once per callback (short hold).
    pub eq_coeffs: Mutex<[BiquadCoeffs; 10]>,
    /// Last-set gains in fixed-point (×1000) for potential future recompute.
    pub eq_gains_millths: Mutex<[i32; 10]>,
    /// Sample rate used for the last coefficient computation.
    pub eq_sample_rate: AtomicI64,
    /// Pre-amp gain applied in the output callback before EQ (× 1000; 1000 = 1.0 = 0 dB).
    pub preamp_gain_millths: AtomicI64,
    /// When false (default), crossfade is suppressed for consecutive same-album tracks
    /// so gapless classical/live recordings are not interrupted by a fade.
    pub same_album_crossfade: AtomicBool,
    /// Gates the PCM IPC bridge — only emit audio://vis-frame when true.
    pub vis_enabled: AtomicBool,
    /// Channel sender for PCM data to the visualizer relay thread. None when disabled.
    pub vis_sender: Mutex<Option<crossbeam_channel::Sender<Vec<f32>>>>,
    /// Preferred CPAL output device name. Applied on next stream open (next Play command).
    pub preferred_device_name: Mutex<Option<String>>,
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
            seek_flush_pending: AtomicBool::new(false),
            crossfade_window_ms: AtomicU64::new(8_000), // 8 s default
            current_bpm: AtomicU64::new(0),
            next_bpm: AtomicU64::new(0),
            normalization_gain_millths: AtomicI64::new(1_000), // 1.0 linear
            next_norm_gain_millths: AtomicI64::new(1_000),
            normalization_enabled: AtomicBool::new(true),
            eq_enabled: AtomicBool::new(false),
            eq_coeffs: Mutex::new([BiquadCoeffs::identity(); 10]),
            eq_gains_millths: Mutex::new([0i32; 10]),
            eq_sample_rate: AtomicI64::new(44100),
            preamp_gain_millths: AtomicI64::new(1_000), // 1.0 linear = 0 dB
            same_album_crossfade: AtomicBool::new(false), // suppress same-album crossfade by default
            vis_enabled: AtomicBool::new(false),
            vis_sender: Mutex::new(None),
            preferred_device_name: Mutex::new(None),
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

    pub fn normalization_gain(&self) -> f32 {
        self.normalization_gain_millths.load(Ordering::Relaxed) as f32 / 1_000.0
    }
}

// ---------------------------------------------------------------------------
// CrossfadeState
// ---------------------------------------------------------------------------

/// Holds the decoder for the *next* track while it is being mixed in during a
/// crossfade transition. Stored as a local variable in `decoder_thread`.
struct CrossfadeState {
    format_reader: Box<dyn FormatReader>,
    decoder: Box<dyn symphonia::core::codecs::Decoder>,
    track_id: u32,
    sample_rate: u32,
    channels: u32,
    meta: TrackMeta,
    sample_buf: Option<SampleBuffer<f32>>,
    /// How many output frames have been mixed so far
    elapsed_frames: usize,
    /// Total frames to crossfade over (in *device-rate* frames)
    total_frames: usize,
    /// Decoded + resampled (to device rate) samples not yet consumed by the mixing loop.
    /// This decouples the next track's codec packet size from the current track's chunk size.
    pending: Vec<f32>,
    /// ReplayGain linear gain for the next track (1.0 = no change)
    norm_gain: f32,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Simple linear interpolation resampler for interleaved f32 audio.
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

/// Parse a ReplayGain gain string like "-3.14 dB" or "+1.20 dB" → linear gain.
fn parse_rg_gain(s: &str) -> Option<f32> {
    let db: f32 = s.trim().trim_end_matches("dB").trim().parse().ok()?;
    Some(10f32.powf(db / 20.0).clamp(0.1, 4.0))
}

/// Extract REPLAYGAIN_TRACK_GAIN from the format reader's embedded metadata.
/// Returns a linear gain factor (1.0 = no change) if the tag is absent or unparseable.
fn try_extract_replaygain(fmt: &mut Box<dyn FormatReader>) -> f32 {
    let meta = fmt.metadata();
    let Some(rev) = meta.current() else { return 1.0 };

    for tag in rev.tags() {
        let is_rg = matches!(tag.std_key, Some(StandardTagKey::ReplayGainTrackGain))
            || tag.key.eq_ignore_ascii_case("REPLAYGAIN_TRACK_GAIN");

        if is_rg {
            if let Value::String(ref s) = tag.value {
                if let Some(g) = parse_rg_gain(s) {
                    return g;
                }
            }
        }
    }

    1.0
}

/// Fetch audio bytes from a URL
fn fetch_audio(url: &str) -> Result<Vec<u8>, String> {
    info!(url = url, "Fetching audio data");
    DECODER_RT.block_on(async {
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
fn audio_cache_key(url: &str) -> String {
    let without_query = url.split('?').next().unwrap_or(url);
    let path = without_query
        .split("://")
        .nth(1)
        .and_then(|rest| rest.splitn(2, '/').nth(1))
        .unwrap_or(without_query);
    format!("{}.audio", path.replace('/', "_"))
}

/// Open a URL for streaming decode (cache hit → File::open; miss → fetch + save).
fn open_for_decode(
    url: &str,
    shared: &Arc<DecoderShared>,
) -> Result<(MediaSourceStream, String), String> {
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

    // Fallback: in-memory cursor
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
pub fn prefetch_url_bg(url: String, shared: Arc<DecoderShared>) {
    DECODER_RT.spawn(async move {
        if let Some(ref cache_dir) = shared.cache_dir {
            let cache_path = cache_dir.join(audio_cache_key(&url));
            if cache_path.exists() {
                debug!(url = %url, "Audio prefetch: already cached");
                return;
            }
            let _ = std::fs::create_dir_all(cache_dir);
        } else {
            return;
        }

        match AUDIO_HTTP.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => match resp.bytes().await {
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
            },
            Ok(resp) => warn!(url = %url, status = %resp.status(), "Audio prefetch: bad status"),
            Err(e) => warn!(url = %url, error = %e, "Audio prefetch: request failed"),
        }
    });
}

/// Probe a `MediaSourceStream` and return a format reader + decoder + track info.
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
    let mut hint = Hint::new();
    if let Some(ext) = url.rsplit('.').next() {
        let ext_lower = ext.split('?').next().unwrap_or(ext).to_lowercase();
        hint.with_extension(&ext_lower);
    }

    let format_opts = FormatOptions {
        enable_gapless: true,
        ..Default::default()
    };
    let metadata_opts = MetadataOptions {
        limit_metadata_bytes: Limit::Maximum(16 * 1024),
        limit_visual_bytes: Limit::Maximum(0),
    };

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &format_opts, &metadata_opts)
        .map_err(|e| format!("Failed to probe audio format: {e}"))?;

    let format = probed.format;

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

/// Decode and resample from the crossfade track until `cf.pending` contains at
/// least `needed` interleaved samples (at device rate). Pads with silence on EOF.
fn refill_crossfade_pending(cf: &mut CrossfadeState, needed: usize, dev_rate: u32) {
    while cf.pending.len() < needed {
        let packet = match cf.format_reader.next_packet() {
            Ok(p) if p.track_id() == cf.track_id => p,
            Ok(_) => continue, // wrong track ID — skip
            Err(_) => {
                // EOF or read error — pad the rest with silence
                cf.pending.resize(needed, 0.0);
                return;
            }
        };

        match cf.decoder.decode(&packet) {
            Ok(audio_buf) => {
                let spec = *audio_buf.spec();
                let num_frames = audio_buf.frames();
                if cf
                    .sample_buf
                    .as_ref()
                    .map_or(true, |sb| sb.capacity() < num_frames)
                {
                    cf.sample_buf = Some(SampleBuffer::new(num_frames as u64, spec));
                }
                let sb = cf.sample_buf.as_mut().unwrap();
                sb.copy_interleaved_ref(audio_buf);

                // Resample to device rate so the mixed output is always at dev_rate
                let chunk = if cf.sample_rate != dev_rate && dev_rate > 0 {
                    resample_linear(sb.samples(), cf.sample_rate, dev_rate, cf.channels)
                } else {
                    sb.samples().to_vec()
                };
                cf.pending.extend_from_slice(&chunk);
            }
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(_) => {
                cf.pending.resize(needed, 0.0);
                return;
            }
        }
    }
}

/// Background BPM detection: decode the first 30 s of the cached audio file
/// and store the result in `shared.next_bpm` (BPM * 100 fixed-point).
fn detect_bpm_bg(url: &str, shared: &Arc<DecoderShared>) {
    let Some(ref cache_dir) = shared.cache_dir else { return };
    let cache_path = cache_dir.join(audio_cache_key(url));

    // Wait up to 10 s for the prefetch to write the cache file
    let mut waited_ms = 0u64;
    while !cache_path.exists() && waited_ms < 10_000 {
        std::thread::sleep(std::time::Duration::from_millis(500));
        waited_ms += 500;
    }
    if !cache_path.exists() {
        return;
    }

    let file = match File::open(&cache_path) {
        Ok(f) => f,
        Err(_) => return,
    };

    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let Ok((mut fmt, mut dec, tid, sr, _ch)) = probe_audio(mss, url) else { return };

    // Decode first 30 s of mono samples for BPM analysis
    let max_frames = sr as usize * 30;
    let mut mono_samples: Vec<f32> = Vec::with_capacity(max_frames);
    let mut sb: Option<SampleBuffer<f32>> = None;

    'outer: loop {
        let packet = match fmt.next_packet() {
            Ok(p) if p.track_id() == tid => p,
            Ok(_) => continue,
            Err(_) => break,
        };
        match dec.decode(&packet) {
            Ok(audio_buf) => {
                let spec = *audio_buf.spec();
                let frames = audio_buf.frames();
                if sb.as_ref().map_or(true, |s| s.capacity() < frames) {
                    sb = Some(SampleBuffer::new(frames as u64, spec));
                }
                let s = sb.as_mut().unwrap();
                s.copy_interleaved_ref(audio_buf);
                let ch = spec.channels.count().max(1);
                for frame_samples in s.samples().chunks(ch) {
                    let mono = frame_samples.iter().sum::<f32>() / ch as f32;
                    mono_samples.push(mono);
                    if mono_samples.len() >= max_frames {
                        break 'outer;
                    }
                }
            }
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(_) => break,
        }
    }

    if mono_samples.is_empty() {
        return;
    }

    let detected = bpm::detect(&mono_samples, sr);
    let bpm_fixed = (detected * 100.0) as u64;
    shared.next_bpm.store(bpm_fixed, Ordering::Relaxed);
    info!(bpm = detected, "BPM detected for next track");
}

// ---------------------------------------------------------------------------
// Decoder thread
// ---------------------------------------------------------------------------

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
    let mut sample_buf: Option<SampleBuffer<f32>> = None;

    // Gapless / crossfade state
    let mut next_meta: Option<TrackMeta> = None;
    let mut crossfade: Option<CrossfadeState> = None;

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
                        &mut next_meta,
                        &mut crossfade,
                    ) {
                        return;
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
                &mut next_meta,
                &mut crossfade,
            ) {
                return;
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

                            if sample_buf
                                .as_ref()
                                .map_or(true, |sb| sb.capacity() < num_frames)
                            {
                                sample_buf = Some(SampleBuffer::new(num_frames as u64, spec));
                            }

                            let sb = sample_buf.as_mut().unwrap();
                            sb.copy_interleaved_ref(audio_buf);
                            // audio_buf consumed here — dec borrow released (NLL).
                            // fmt borrow was released after next_packet() returned.

                            let raw_samples: Vec<f32> = sb.samples().to_vec();
                            let raw_sample_count = raw_samples.len();

                            // Resample if source rate differs from output device rate
                            let src_rate =
                                shared.sample_rate.load(Ordering::Relaxed) as u32;
                            let dev_rate =
                                shared.device_sample_rate.load(Ordering::Relaxed) as u32;
                            let ch_val = shared.channels.load(Ordering::Relaxed) as u32;

                            let resampled = if src_rate != dev_rate && dev_rate > 0 {
                                resample_linear(&raw_samples, src_rate, dev_rate, ch_val)
                            } else {
                                raw_samples
                            };

                            // ===============================================
                            // CROSSFADE TRIGGER
                            // ===============================================
                            let cfade_ms = shared
                                .crossfade_window_ms
                                .load(Ordering::Relaxed) as i64;

                            // Suppress crossfade when current and next track share the
                            // same album (parent_key), unless the user has explicitly
                            // enabled same-album crossfade in settings.
                            let same_album = current_track.as_ref()
                                .zip(next_meta.as_ref())
                                .map(|(c, n)| !c.parent_key.is_empty() && c.parent_key == n.parent_key)
                                .unwrap_or(false);
                            let suppress_xfade = same_album
                                && !shared.same_album_crossfade.load(Ordering::Relaxed);

                            if cfade_ms > 0 && !suppress_xfade && crossfade.is_none() && next_meta.is_some() {
                                let duration_ms = current_track
                                    .as_ref()
                                    .map(|m| m.duration_ms)
                                    .unwrap_or(0);
                                let pos_ms = shared.position_ms();

                                // Beat-align the crossfade start if current BPM is known
                                let crossfade_start = {
                                    let bpm_fixed =
                                        shared.current_bpm.load(Ordering::Relaxed);
                                    if bpm_fixed > 0 {
                                        let bpm = bpm_fixed as f64 / 100.0;
                                        let beat_ms = 60_000.0 / bpm;
                                        let ideal =
                                            (duration_ms - cfade_ms).max(0) as f64;
                                        let offset = ideal % beat_ms;
                                        (ideal - offset) as i64
                                    } else {
                                        (duration_ms - cfade_ms).max(0)
                                    }
                                };

                                if pos_ms >= crossfade_start {
                                    let next_url =
                                        next_meta.as_ref().unwrap().url.clone();
                                    // Only start if next track is already cached
                                    // so open_for_decode is guaranteed fast (~1 ms).
                                    let is_cached = shared
                                        .cache_dir
                                        .as_ref()
                                        .map(|d| {
                                            d.join(audio_cache_key(&next_url)).exists()
                                        })
                                        .unwrap_or(false);

                                    if is_cached {
                                        info!(url = %next_url, "Starting crossfade");
                                        match open_for_decode(&next_url, &shared)
                                            .and_then(|(mss, u)| probe_audio(mss, &u))
                                        {
                                            Ok((mut nfmt, ndec, ntid, nsr, nch)) => {
                                                // Use Plex API gain if available, else file tags
                                                let next_meta_ref =
                                                    next_meta.as_ref().unwrap();
                                                let next_norm =
                                                    if let Some(db) = next_meta_ref.gain_db {
                                                        10f32.powf(db / 20.0).clamp(0.1, 4.0)
                                                    } else {
                                                        try_extract_replaygain(&mut nfmt)
                                                    };
                                                shared.next_norm_gain_millths.store(
                                                    (next_norm * 1_000.0) as i64,
                                                    Ordering::Relaxed,
                                                );
                                                // total_frames must be in device-rate
                                                // units because elapsed_frames counts
                                                // output (device-rate) frames.
                                                let out_rate =
                                                    if dev_rate > 0 { dev_rate } else { src_rate };
                                                let total_frames = cfade_ms as usize
                                                    * out_rate as usize
                                                    / 1000;
                                                let meta = next_meta.take().unwrap();
                                                crossfade = Some(CrossfadeState {
                                                    format_reader: nfmt,
                                                    decoder: ndec,
                                                    track_id: ntid,
                                                    sample_rate: nsr,
                                                    channels: nch,
                                                    meta,
                                                    sample_buf: None,
                                                    elapsed_frames: 0,
                                                    total_frames,
                                                    pending: Vec::new(),
                                                    norm_gain: next_norm,
                                                });
                                            }
                                            Err(e) => {
                                                warn!(
                                                    error = %e,
                                                    "Crossfade: failed to open next track"
                                                );
                                            }
                                        }
                                    }
                                }
                            }

                            // ===============================================
                            // CROSSFADE MIXING (equal-power curves)
                            // ===============================================
                            let norm_enabled =
                                shared.normalization_enabled.load(Ordering::Relaxed);

                            let samples_to_push = if let Some(ref mut cf) = crossfade {
                                let needed = resampled.len();

                                // Fill pending with enough decoded+resampled samples
                                // from the next track. This decouples packet sizes and
                                // ensures the next track is always at device rate.
                                refill_crossfade_pending(cf, needed, dev_rate);

                                let ch = ch_val.max(1) as usize;
                                let frames = needed / ch;
                                let mut mixed = Vec::with_capacity(needed);

                                // Per-track normalization gains applied during mixing so
                                // each track is levelled before the fade curves run.
                                let cur_gain =
                                    if norm_enabled { shared.normalization_gain() } else { 1.0 };
                                let next_gain = if norm_enabled { cf.norm_gain } else { 1.0 };

                                for frame in 0..frames {
                                    let t = ((cf.elapsed_frames + frame) as f32
                                        / cf.total_frames as f32)
                                        .min(1.0);
                                    let fade_out = (t * FRAC_PI_2).cos();
                                    let fade_in = (t * FRAC_PI_2).sin();
                                    for c in 0..ch {
                                        let old_s = resampled
                                            .get(frame * ch + c)
                                            .copied()
                                            .unwrap_or(0.0);
                                        let new_s = cf
                                            .pending
                                            .get(frame * ch + c)
                                            .copied()
                                            .unwrap_or(0.0);
                                        mixed.push(
                                            old_s * cur_gain * fade_out
                                                + new_s * next_gain * fade_in,
                                        );
                                    }
                                }
                                cf.elapsed_frames += frames;
                                // Consume the samples we just mixed
                                cf.pending.drain(..needed.min(cf.pending.len()));
                                mixed
                            } else {
                                // Non-crossfade path: apply normalization in-place so the
                                // ring buffer always holds normalized samples.
                                let mut s = resampled;
                                if norm_enabled {
                                    let gain = shared.normalization_gain();
                                    s.iter_mut().for_each(|x| *x *= gain);
                                }
                                s
                            };

                            // ===============================================
                            // PUSH TO RING BUFFER
                            // ===============================================
                            let mut written = 0;
                            while written < samples_to_push.len() {
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
                                        &mut next_meta,
                                        &mut crossfade,
                                    ) {
                                        return;
                                    }
                                    // If Play/Stop was called, abandon remaining
                                    // samples from this packet.
                                    if format_reader.is_none()
                                        || shared.flush_pending.load(Ordering::Relaxed)
                                    {
                                        break;
                                    }
                                }

                                let n = producer.push_slice(&samples_to_push[written..]);
                                written += n;
                                if n == 0 {
                                    std::thread::sleep(std::time::Duration::from_millis(5));
                                }
                            }

                            // Track position using raw (pre-resample) sample count so
                            // position_ms() reflects the correct source-time position.
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

                // ===============================================================
                // END OF STREAM — gapless / crossfade completion / normal stop
                // ===============================================================
                Err(symphonia::core::errors::Error::IoError(ref e))
                    if e.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    info!("Track decode complete (EOF)");

                    if let Some(cf) = crossfade.take() {
                        // Crossfade was active — promote the next-track decoder.
                        info!(
                            rating_key = cf.meta.rating_key,
                            "Crossfade complete — swapping to next track"
                        );
                        if let Some(ref old) = current_track {
                            let _ = event_tx.send(AudioEvent::TrackEnded {
                                rating_key: old.rating_key,
                            });
                        }
                        // Set position to where the crossfade decoder has decoded
                        let ch = cf.channels as i64;
                        shared.position_samples.store(
                            (cf.elapsed_frames as i64).saturating_mul(ch),
                            Ordering::Relaxed,
                        );
                        // Rotate BPM: next → current
                        let nb = shared.next_bpm.swap(0, Ordering::Relaxed);
                        shared.current_bpm.store(nb, Ordering::Relaxed);
                        // Promote normalization gain for the new current track
                        shared.normalization_gain_millths.store(
                            (cf.norm_gain * 1_000.0) as i64,
                            Ordering::Relaxed,
                        );
                        shared.next_norm_gain_millths.store(1_000, Ordering::Relaxed);

                        format_reader = Some(cf.format_reader);
                        decoder = Some(cf.decoder);
                        current_track_id = cf.track_id;
                        sample_buf = cf.sample_buf;
                        shared.sample_rate.store(cf.sample_rate as i64, Ordering::Relaxed);
                        shared.channels.store(cf.channels as i64, Ordering::Relaxed);
                        shared.finished.store(false, Ordering::Relaxed);
                        current_track = Some(cf.meta.clone());
                        let _ = event_tx.send(AudioEvent::TrackStarted {
                            rating_key: cf.meta.rating_key,
                            duration_ms: cf.meta.duration_ms,
                        });
                        let _ = event_tx.send(AudioEvent::State {
                            state: PlaybackState::Playing,
                        });
                    } else if let Some(nmeta) = next_meta.take() {
                        // Gapless: open next track immediately. The ring buffer
                        // still contains audio from the tail of the old track, so
                        // decoding begins before that audio is consumed — true gapless.
                        info!(rating_key = nmeta.rating_key, "Gapless: opening next track");
                        match open_for_decode(&nmeta.url, &shared)
                            .and_then(|(mss, u)| probe_audio(mss, &u))
                        {
                            Ok((mut fmt, dec, tid, sr, ch)) => {
                                // Prefer Plex API gain from the TrackMeta we stored,
                                // then the pre-computed next_norm_gain (set at crossfade
                                // trigger time), then extract from embedded file tags.
                                let norm_gain = if let Some(db) = nmeta.gain_db {
                                    10f32.powf(db / 20.0).clamp(0.1, 4.0)
                                } else {
                                    let next_g =
                                        shared.next_norm_gain_millths.load(Ordering::Relaxed);
                                    if next_g != 1_000 {
                                        next_g as f32 / 1_000.0
                                    } else {
                                        try_extract_replaygain(&mut fmt)
                                    }
                                };
                                if let Some(ref old) = current_track {
                                    let _ = event_tx.send(AudioEvent::TrackEnded {
                                        rating_key: old.rating_key,
                                    });
                                }
                                let nb = shared.next_bpm.swap(0, Ordering::Relaxed);
                                shared.current_bpm.store(nb, Ordering::Relaxed);
                                shared.normalization_gain_millths.store(
                                    (norm_gain * 1_000.0) as i64,
                                    Ordering::Relaxed,
                                );
                                shared.next_norm_gain_millths.store(1_000, Ordering::Relaxed);

                                format_reader = Some(fmt);
                                decoder = Some(dec);
                                current_track_id = tid;
                                sample_buf = None;
                                shared.sample_rate.store(sr as i64, Ordering::Relaxed);
                                shared.channels.store(ch as i64, Ordering::Relaxed);
                                shared.position_samples.store(0, Ordering::Relaxed);
                                shared.finished.store(false, Ordering::Relaxed);
                                current_track = Some(nmeta.clone());
                                let _ = event_tx.send(AudioEvent::TrackStarted {
                                    rating_key: nmeta.rating_key,
                                    duration_ms: nmeta.duration_ms,
                                });
                                let _ = event_tx.send(AudioEvent::State {
                                    state: PlaybackState::Playing,
                                });
                            }
                            Err(e) => {
                                warn!(
                                    error = %e,
                                    "Gapless: failed to open next track — ending playback"
                                );
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
                        }
                    } else {
                        // Normal end of playback — no queued next track
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

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

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
    next_meta: &mut Option<TrackMeta>,
    crossfade: &mut Option<CrossfadeState>,
) -> bool {
    match cmd {
        AudioCommand::Play(meta) => {
            info!(rating_key = meta.rating_key, url = %meta.url, "Play command received");

            // Clear any queued next track and in-progress crossfade
            *next_meta = None;
            *crossfade = None;

            // Signal the output callback to drain stale samples immediately
            shared.flush_pending.store(true, Ordering::Release);

            let _ = event_tx.send(AudioEvent::State {
                state: PlaybackState::Buffering,
            });

            match open_for_decode(&meta.url, shared) {
                Ok((mss, url)) => match probe_audio(mss, &url) {
                    Ok((mut fmt, dec, tid, sr, ch)) => {
                        // Prefer Plex API gain (already analysed server-side);
                        // fall back to embedded ReplayGain tag for unanalysed tracks.
                        let norm_gain = if let Some(db) = meta.gain_db {
                            10f32.powf(db / 20.0).clamp(0.1, 4.0)
                        } else {
                            try_extract_replaygain(&mut fmt)
                        };
                        *format_reader = Some(fmt);
                        *decoder = Some(dec);
                        *current_track_id = tid;
                        *sample_buf = None;

                        shared.sample_rate.store(sr as i64, Ordering::Relaxed);
                        shared.channels.store(ch as i64, Ordering::Relaxed);
                        shared.position_samples.store(0, Ordering::Relaxed);
                        shared.paused.store(false, Ordering::Relaxed);
                        shared.finished.store(false, Ordering::Relaxed);
                        shared.current_bpm.store(0, Ordering::Relaxed);
                        shared.next_bpm.store(0, Ordering::Relaxed);
                        shared.normalization_gain_millths
                            .store((norm_gain * 1_000.0) as i64, Ordering::Relaxed);
                        shared.next_norm_gain_millths.store(1_000, Ordering::Relaxed);

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
                        let _ = event_tx.send(AudioEvent::Error { message: e });
                        let _ = event_tx.send(AudioEvent::State {
                            state: PlaybackState::Stopped,
                        });
                    }
                },
                Err(e) => {
                    error!(error = %e, "Failed to fetch audio");
                    let _ = event_tx.send(AudioEvent::Error { message: e });
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
            *next_meta = None;
            *crossfade = None;
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
                        if let Some(ref mut dec) = decoder {
                            dec.reset();
                        }
                        let ch = shared.channels.load(Ordering::Relaxed);
                        shared.position_samples.store(
                            (seeked.actual_ts as i64) * ch,
                            Ordering::Relaxed,
                        );
                        // Seeking cancels any in-progress crossfade
                        *crossfade = None;
                        // Tell the output callback to drain the ring buffer so stale
                        // pre-seek audio is discarded instantly instead of playing
                        // through (~2 s worth of buffered samples).
                        shared.seek_flush_pending.store(true, Ordering::Release);
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
            debug!(
                rating_key = meta.rating_key,
                url = %meta.url,
                "PreloadNext: warming cache + queueing for gapless"
            );
            // Start downloading the next track in the background
            prefetch_url_bg(meta.url.clone(), Arc::clone(shared));
            // Queue for gapless swap / crossfade trigger
            *next_meta = Some(meta.clone());

            // Detect BPM in a background OS thread so it's ready before crossfade time
            let shared_bpm = Arc::clone(shared);
            let url_bpm = meta.url.clone();
            std::thread::Builder::new()
                .name("bpm-detect".into())
                .spawn(move || {
                    detect_bpm_bg(&url_bpm, &shared_bpm);
                })
                .ok();
        }

        AudioCommand::SetCrossfadeWindow(ms) => {
            shared.crossfade_window_ms.store(ms, Ordering::Relaxed);
            info!(ms = ms, "Crossfade window updated");
        }

        AudioCommand::SetNormalizationEnabled(enabled) => {
            shared.normalization_enabled.store(enabled, Ordering::Relaxed);
            info!(enabled = enabled, "Audio normalization toggled");
        }

        AudioCommand::SetEqEnabled(enabled) => {
            shared.eq_enabled.store(enabled, Ordering::Relaxed);
            info!(enabled = enabled, "EQ toggled");
        }

        AudioCommand::SetEq { gains_db } => {
            let sr = shared.device_sample_rate.load(Ordering::Relaxed) as f32;
            let coeffs = compute_eq_coeffs(&gains_db, sr);
            if let Ok(mut lock) = shared.eq_coeffs.lock() {
                *lock = coeffs;
            }
            if let Ok(mut gains_lock) = shared.eq_gains_millths.lock() {
                for (i, &g) in gains_db.iter().enumerate() {
                    gains_lock[i] = (g * 1000.0) as i32;
                }
            }
            shared.eq_sample_rate.store(sr as i64, Ordering::Relaxed);
            debug!("EQ coefficients recomputed at {}Hz", sr as i32);
        }

        AudioCommand::SetPreampGain(db) => {
            // Convert dB to linear gain and store as fixed-point × 1000.
            // Clamped to a sane range (−24 to +6 dB) to prevent accidental extremes.
            let linear = 10f32.powf(db.clamp(-24.0, 6.0) / 20.0);
            shared.preamp_gain_millths.store((linear * 1_000.0) as i64, Ordering::Relaxed);
            debug!(db = db, linear = linear, "Pre-amp gain updated");
        }

        AudioCommand::SetSameAlbumCrossfade(enabled) => {
            shared.same_album_crossfade.store(enabled, Ordering::Relaxed);
            info!(enabled = enabled, "Same-album crossfade toggled");
        }

        AudioCommand::SetVisualizerEnabled(enabled) => {
            shared.vis_enabled.store(enabled, Ordering::Relaxed);
            debug!(enabled = enabled, "Visualizer PCM bridge toggled");
        }

        AudioCommand::SetPreferredDevice(name) => {
            *shared.preferred_device_name.lock().unwrap() = name.clone();
            debug!(?name, "Preferred output device updated (takes effect on next play)");
        }

        AudioCommand::Shutdown => {
            info!("Decoder thread shutting down");
            return true;
        }
    }

    false
}
