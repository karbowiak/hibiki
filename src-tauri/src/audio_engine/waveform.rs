//! Display-only envelopes from completed encoded audio. One CPU worker, bounded
//! memory and revision-bound persistence; playback never waits for this work.
use super::{cache::AudioCache, deck::decode, request::PlaybackRequest};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, OnceLock,
    },
    time::Duration,
};
use symphonia::core::io::MediaSourceStream;

const POINTS: usize = 1024;
const VERSION: u8 = 1;

struct WorkLease(Arc<AtomicBool>);
impl Drop for WorkLease {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Level {
    pub loudness: f32,
}

/// Half-dB values in compact hex keep the persistent cache index small. This is
/// an envelope for display, independent of R128 loudness and normalization gain.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct StoredWaveform {
    version: u8,
    peaks: String,
}
impl StoredWaveform {
    pub(super) fn new(levels: &[Level]) -> Option<Self> {
        if levels.is_empty()
            || levels.len() > POINTS
            || levels.iter().any(|level| !level.loudness.is_finite())
        {
            return None;
        }
        let peaks: Vec<u8> = levels
            .iter()
            .map(|level| ((level.loudness.clamp(-96.0, 0.0) + 96.0) * 2.0).round() as u8)
            .collect();
        Some(Self {
            version: VERSION,
            peaks: hex::encode(peaks),
        })
    }
    pub(super) fn levels(&self) -> Option<Vec<Level>> {
        if self.version != VERSION || self.peaks.is_empty() || self.peaks.len() > POINTS * 2 {
            return None;
        }
        let bytes = hex::decode(&self.peaks).ok()?;
        if bytes.iter().any(|value| *value > 192) {
            return None;
        }
        Some(
            bytes
                .into_iter()
                .map(|value| Level {
                    loudness: value as f32 / 2.0 - 96.0,
                })
                .collect(),
        )
    }
}

#[derive(Clone, Copy, Default)]
struct Bin {
    energy: f64,
    frames: u64,
}
impl Bin {
    fn add(&mut self, other: Self) {
        self.energy += other.energy;
        self.frames += other.frames;
    }
}
struct Envelope {
    bins: Vec<Bin>,
    pending: Bin,
    width: u64,
}
impl Envelope {
    fn new(rate: u32) -> Self {
        Self {
            bins: Vec::with_capacity(POINTS * 2),
            pending: Bin::default(),
            width: (rate as u64 / 20).max(1),
        }
    }
    fn push(&mut self, frame: &[f32]) -> Result<(), String> {
        let mut energy = 0.0;
        for sample in frame {
            if !sample.is_finite() {
                return Err("Invalid audio samples".into());
            }
            let value = f64::from(*sample);
            energy += value * value;
        }
        self.pending.energy += energy / frame.len() as f64;
        self.pending.frames += 1;
        if self.pending.frames == self.width {
            self.bins.push(std::mem::take(&mut self.pending));
            if self.bins.len() == POINTS * 2 {
                for index in 0..POINTS {
                    let mut bin = self.bins[index * 2];
                    bin.add(self.bins[index * 2 + 1]);
                    self.bins[index] = bin;
                }
                self.bins.truncate(POINTS);
                self.width *= 2;
            }
        }
        Ok(())
    }
    fn finish(mut self) -> Vec<Level> {
        if self.pending.frames > 0 {
            self.bins.push(self.pending);
        }
        let frames: u64 = self.bins.iter().map(|bin| bin.frames).sum();
        if frames == 0 {
            return Vec::new();
        }
        let count = POINTS.min(frames as usize);
        let mut bins = self.bins.into_iter();
        let mut bin = bins.next().unwrap();
        let mut available = bin.frames;
        (0..count)
            .map(|index| {
                let start = index as u64 * frames / count as u64;
                let end = (index + 1) as u64 * frames / count as u64;
                let mut remaining = end - start;
                let mut energy = 0.0;
                while remaining > 0 {
                    if available == 0 {
                        bin = bins.next().unwrap();
                        available = bin.frames;
                    }
                    let take = available.min(remaining);
                    energy += bin.energy / bin.frames as f64 * take as f64;
                    remaining -= take;
                    available -= take;
                }
                let power = energy / (end - start) as f64;
                Level {
                    loudness: if power > 0.0 {
                        (10.0 * power.log10()).clamp(-96.0, 0.0) as f32
                    } else {
                        -96.0
                    },
                }
            })
            .collect()
    }
}

fn analyze(file: File, ext: &str, current: &dyn Fn() -> bool) -> Result<Vec<Level>, String> {
    if !current() {
        return Err("Waveform superseded".into());
    }
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut decoder =
        decode::probe_from_source(mss, Some(ext)).map_err(|_| "Cannot read waveform audio")?;
    let expected = decoder
        .format
        .tracks()
        .iter()
        .find(|track| track.id == decoder.track_id)
        .and_then(|track| track.num_frames);
    let mut envelope = None;
    let mut frames = 0_u64;
    let mut format = None;
    while !decoder.finished {
        if !current() {
            return Err("Waveform superseded".into());
        }
        let samples = decode::decode_batch(&mut decoder, 262144)
            .map_err(|_| "Cannot decode waveform audio")?;
        if decoder.aborted || decoder.had_decode_errors {
            return Err("Incomplete waveform audio".into());
        }
        if samples.is_empty() {
            continue;
        }
        let actual = (decoder.sample_rate, decoder.channels);
        if actual.0 == 0 || actual.1 == 0 || format.is_some_and(|format| format != actual) {
            return Err("Waveform audio format changed".into());
        }
        format = Some(actual);
        let envelope = envelope.get_or_insert_with(|| Envelope::new(actual.0));
        for frame in samples.chunks_exact(actual.1 as usize) {
            envelope.push(frame)?;
            frames += 1;
        }
    }
    if !current() {
        return Err("Waveform superseded".into());
    }
    if expected.is_some_and(|expected| frames < expected) {
        return Err("Incomplete waveform audio".into());
    }
    let levels = envelope.ok_or("Empty waveform audio")?.finish();
    if levels.is_empty() {
        return Err("Empty waveform audio".into());
    }
    Ok(levels)
}

/// No network requests or URL resolution. Selected playback can wait for its
/// download to commit; queued preparation passes a file which is already ready.
pub(super) async fn levels(
    cache: Arc<AudioCache>,
    key: String,
    request: PlaybackRequest,
    wait: bool,
) -> Result<Vec<Level>, String> {
    let owned_request = request.clone();
    let lease = WorkLease(Arc::new(AtomicBool::new(true)));
    let running = lease.0.clone();
    let work = async {
        if cache.stats().max_bytes == 0 {
            return Ok(Vec::new());
        }
        let (file, stamp) = loop {
            if !request.is_current() {
                return Err("Waveform superseded".into());
            }
            if let Some(item) = cache.open_with_stamp(&key) {
                break item;
            }
            if !wait {
                return Ok(Vec::new());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        };
        if let Some(levels) = cache.waveform(&key, &stamp) {
            return Ok(levels);
        }
        // Independent of the media fill lock: analyzing a cached file must not
        // block playback from opening that same file immediately.
        let lock = cache.fill_lock(&format!("waveform:{key}"));
        let guard = lock.lock_owned().await;
        if let Some(levels) = cache.waveform(&key, &stamp) {
            return Ok(levels);
        }
        static CPU: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
        let permit = CPU
            .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1)))
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| "Waveform worker unavailable")?;
        crate::background_jobs::report("Decoding waveform", None, 0, Some(1), "songs").await?;
        let ext = stamp.extension();
        tokio::task::spawn_blocking(move || {
            let (_permit, _guard) = (permit, guard);
            let current = || {
                running.load(Ordering::Acquire)
                    && owned_request.is_current()
                    && cache.stamp_is_current(&key, &stamp)
            };
            let levels = analyze(file, &ext, &current)?;
            if !current() || !cache.set_waveform(&key, &stamp, &levels) {
                return Err("Waveform superseded".into());
            }
            // Return the quantized representation both initially and on replay.
            cache
                .waveform(&key, &stamp)
                .ok_or("Waveform unavailable".into())
        })
        .await
        .map_err(|_| "Waveform worker unavailable")?
    };
    tokio::select! {
        biased;
        _ = request.cancelled() => Err("Waveform superseded".into()),
        result = tokio::time::timeout(Duration::from_secs(120), work) => result.map_err(|_| "Waveform preparation timed out".to_owned())?,
    }
}

pub(super) fn schedule(cache: Arc<AudioCache>, key: String, request: PlaybackRequest) {
    if !request.is_current() { return; }
    let Some((_, stamp)) = cache.open_with_stamp(&key) else { return; };
    if cache.waveform(&key, &stamp).is_some() { return; }
    let work_key = format!("waveform:{:p}:{key}:{}:{}:{:?}", Arc::as_ptr(&cache), request.epoch, request.load_id, request.preload_revision());
    crate::background_jobs::advisory_once(work_key, crate::background_jobs::Lane::Analysis, "Generating waveform", async move {
        let _ = levels(cache, key, request, false).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        sync::atomic::{AtomicU64, AtomicUsize},
    };

    fn request() -> (PlaybackRequest, Arc<AtomicU64>) {
        let epoch = Arc::new(AtomicU64::new(1));
        (
            PlaybackRequest::new(1, epoch.clone(), Arc::new(AtomicU64::new(0))),
            epoch,
        )
    }
    fn file(bytes: &[u8]) -> (tempfile::NamedTempFile, File) {
        let mut temp = tempfile::NamedTempFile::new().unwrap();
        temp.write_all(bytes).unwrap();
        let opened = File::open(temp.path()).unwrap();
        (temp, opened)
    }
    fn write(cache: &AudioCache, key: &str, bytes: &[u8]) {
        let mut writer = cache.begin_write(key, "wav").unwrap();
        writer.write_chunk(bytes).unwrap();
        writer.finish(cache).unwrap();
    }

    #[test]
    fn adaptive_envelopes_keep_the_whole_timeline_bounded_and_do_not_cancel_opposite_channels() {
        let mut envelope = Envelope::new(20);
        for index in 0..80000 {
            let amplitude = if index < 40000 { 0.1 } else { 0.5 };
            envelope.push(&[amplitude, -amplitude]).unwrap();
            assert!(envelope.bins.len() < POINTS * 2);
        }
        let levels = envelope.finish();
        assert_eq!(levels.len(), POINTS);
        assert!(levels[..400]
            .iter()
            .all(|level| (level.loudness + 20.0).abs() < 0.01));
        assert!(levels[624..]
            .iter()
            .all(|level| (level.loudness + 6.0206).abs() < 0.01));
        assert!(Envelope::new(44100).finish().is_empty());
    }

    #[test]
    fn real_audio_envelopes_preserve_silence_dynamics_and_the_final_partial_window() {
        use symphonia::core::audio::Position;
        let wav = decode::tests::generate_layout_wav(
            44100,
            Position::FRONT_LEFT | Position::FRONT_RIGHT,
            44100 * 3 + 123,
            |frame, channel| {
                let amplitude = if frame < 44100 {
                    0.0
                } else if frame < 88200 {
                    0.1
                } else {
                    0.5
                };
                if channel == Position::FRONT_LEFT {
                    amplitude
                } else {
                    -amplitude
                }
            },
        );
        let (_temp, file) = file(&wav);
        let levels = analyze(file, "wav", &|| true).unwrap();
        assert_eq!(levels.len(), POINTS);
        assert!(levels[..300].iter().all(|level| level.loudness == -96.0));
        assert!(levels[400..600]
            .iter()
            .all(|level| (level.loudness + 20.0).abs() < 0.01));
        assert!(levels[750..]
            .iter()
            .all(|level| (level.loudness + 6.0206).abs() < 0.01));
        let packed = StoredWaveform::new(&levels).unwrap();
        assert!(packed.peaks.len() <= POINTS * 2);
        assert_eq!(packed.levels().unwrap().len(), POINTS);
    }

    #[test]
    fn the_native_aac_m4a_variants_used_for_streaming_produce_finite_waveforms() {
        for name in [
            "aac-lc-stereo.m4a",
            "aac-lc-faststart.m4a",
            "he-aac-stereo.m4a",
            "he-aac-v2-stereo.m4a",
        ] {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/audio")
                .join(name);
            let levels = analyze(File::open(path).unwrap(), "m4a", &|| true)
                .unwrap_or_else(|error| panic!("{name}: {error}"));
            assert_eq!(levels.len(), POINTS);
            assert!(
                levels
                    .iter()
                    .all(|level| level.loudness.is_finite()
                        && (-96.0..=0.0).contains(&level.loudness))
            );
            assert!(levels.iter().any(|level| level.loudness > -35.0));
        }
    }

    #[test]
    fn canceled_truncated_and_empty_audio_never_produce_a_completed_waveform() {
        let wav = decode::tests::generate_test_wav(44100, 2, 4.0);
        let (_temp, file) = file(&wav);
        let checks = AtomicUsize::new(0);
        assert!(analyze(file, "wav", &|| checks.fetch_add(1, Ordering::SeqCst) < 2).is_err());
        let (_temp, file) = self::file(&wav[..wav.len() / 2]);
        assert!(analyze(file, "wav", &|| true).is_err());
        let (_temp, file) = self::file(&decode::tests::generate_test_wav(44100, 2, 0.0));
        assert!(analyze(file, "wav", &|| true).is_err());
        assert!(StoredWaveform::new(&[Level { loudness: f32::NAN }]).is_none());
        assert!(StoredWaveform {
            version: VERSION,
            peaks: "ff".into()
        }
        .levels()
        .is_none());
        assert!(StoredWaveform {
            version: VERSION + 1,
            peaks: "00".into()
        }
        .levels()
        .is_none());
    }

    #[test]
    fn persisted_waveforms_skip_decoding_after_restart_and_replaced_files_invalidate_them() {
        let directory = tempfile::tempdir().unwrap();
        let key = "waveform-replay";
        let cache = AudioCache::new(directory.path().into(), None);
        write(&cache, key, b"not decodable audio");
        let (_, stamp) = cache.open_with_stamp(key).unwrap();
        assert!(cache.set_waveform(
            key,
            &stamp,
            &[Level { loudness: -12.0 }, Level { loudness: -24.0 }]
        ));
        drop(cache);
        let cache = Arc::new(AudioCache::new(directory.path().into(), None));
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let (request, _) = request();
        let fill = runtime.block_on(cache.fill_lock(key).lock_owned());
        let levels = runtime
            .block_on(super::levels(cache.clone(), key.into(), request, true))
            .unwrap();
        assert_eq!(
            levels
                .iter()
                .map(|level| level.loudness)
                .collect::<Vec<_>>(),
            [-12.0, -24.0]
        );
        drop(fill);
        assert!(cache.discard(key, &stamp));
        write(
            &cache,
            key,
            &decode::tests::generate_test_wav(44100, 1, 0.1),
        );
        assert!(cache.waveform(key, &stamp).is_none());
        assert!(!cache.set_waveform(key, &stamp, &[Level { loudness: -1.0 }]));
        let (_, replaced) = cache.open_with_stamp(key).unwrap();
        assert!(cache.waveform(key, &replaced).is_none());
    }

    #[test]
    fn an_async_request_waits_for_completed_bytes_and_preparation_warms_the_same_waveform() {
        let directory = tempfile::tempdir().unwrap();
        let cache = Arc::new(AudioCache::new(directory.path().into(), None));
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let mut source = super::super::source::MediaSource::new(
            reqwest::Client::new().get("https://fixture.invalid/song.wav"),
            Some("plex-fixture"),
        )
        .unwrap();
        source.prepare_waveform = true;
        let key = source.cache_key.clone();
        let (request, _) = request();
        runtime.block_on(async {
            let pending = tokio::spawn(super::levels(
                cache.clone(),
                key.clone(),
                request.clone(),
                true,
            ));
            tokio::time::sleep(Duration::from_millis(20)).await;
            assert!(!pending.is_finished());
            write(
                &cache,
                &key,
                &decode::tests::generate_test_wav(44100, 2, 0.3),
            );
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(5), pending)
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap()
                    .len(),
                POINTS
            );
        });
        // A different cached item is generated speculatively without a UI request.
        let mut other = source.try_clone().unwrap();
        other.cache_key = "queued-waveform".into();
        write(
            &cache,
            &other.cache_key,
            &decode::tests::generate_test_wav(44100, 1, 0.3),
        );
        let (_, stamp) = cache.open_with_stamp(&other.cache_key).unwrap();
        let track = super::super::preparation::Track {
            source: other,
            duration_ms: 300,
            gain_db: Some(-3.0),
        };
        super::super::preparation::prepare(&track, &cache, runtime.handle(), &request, None)
            .unwrap();
        runtime.block_on(async {
            tokio::time::timeout(Duration::from_secs(5), async {
                while cache.waveform("queued-waveform", &stamp).is_none() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
        });
        assert_eq!(
            cache.waveform("queued-waveform", &stamp).unwrap().len(),
            POINTS
        );
    }

    #[test]
    fn selection_changes_cancel_waiting_waveforms_and_clear_discards_persisted_results() {
        let directory = tempfile::tempdir().unwrap();
        let cache = Arc::new(AudioCache::new(directory.path().into(), None));
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let (request, epoch) = request();
        runtime.block_on(async {
            let pending = tokio::spawn(super::levels(
                cache.clone(),
                "missing".into(),
                request,
                true,
            ));
            tokio::time::sleep(Duration::from_millis(20)).await;
            epoch.store(2, Ordering::SeqCst);
            assert!(tokio::time::timeout(Duration::from_secs(1), pending)
                .await
                .unwrap()
                .unwrap()
                .is_err());
        });
        write(&cache, "cleared", b"encoded audio");
        let (_, stamp) = cache.open_with_stamp("cleared").unwrap();
        assert!(cache.set_waveform("cleared", &stamp, &[Level { loudness: -6.0 }]));
        cache.clear().unwrap();
        assert!(cache.waveform("cleared", &stamp).is_none());
        assert!(!cache.set_waveform("cleared", &stamp, &[Level { loudness: -6.0 }]));
    }
}
