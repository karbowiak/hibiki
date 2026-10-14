//! Bounded cancellable R128 preparation. Measurement never changes an audible occurrence.
use super::{
    cache::{AudioCache, CacheStamp},
    callback::SharedAtomics,
    request::PlaybackRequest,
    types::DeckId,
};
use crossbeam_channel::{Receiver, Sender};
use std::fs::File;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
pub(super) type Analyzer =
    dyn Fn(File, &str, &dyn Fn() -> bool) -> Result<f32, String> + Send + Sync;
struct Job {
    key: String,
    ext: String,
    file: File,
    cache: Arc<AudioCache>,
    stamp: Option<CacheStamp>,
    request: PlaybackRequest,
    reply: Sender<Result<f32, String>>,
}
struct Pending {
    slots: Mutex<[Option<Job>; 2]>,
    wake: Condvar,
    running: AtomicBool,
}
pub struct LoudnessAnalysis {
    pending: Arc<Pending>,
    atomics: Arc<SharedAtomics>,
    alive: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl LoudnessAnalysis {
    pub fn start(atomics: Arc<SharedAtomics>, alive: Arc<AtomicBool>) -> std::io::Result<Self> {
        Self::with_analyzer(
            atomics,
            alive,
            Arc::new(|file, ext, current| {
                super::loudness::analyze_loudness_file(file, ext, current)
            }),
        )
    }
    pub(super) fn with_analyzer(
        atomics: Arc<SharedAtomics>,
        alive: Arc<AtomicBool>,
        analyze: Arc<Analyzer>,
    ) -> std::io::Result<Self> {
        let pending = Arc::new(Pending {
            slots: Mutex::new([None, None]),
            wake: Condvar::new(),
            running: AtomicBool::new(true),
        });
        let queue = pending.clone();
        let worker_alive = alive.clone();
        let preferences = atomics.clone();
        let worker = std::thread::Builder::new()
            .name("audio-loudness".into())
            .spawn(move || {
                let alive = || {
                    queue.running.load(Ordering::Acquire) && worker_alive.load(Ordering::Acquire)
                };
                while alive() {
                    let mut slots = match queue.slots.lock() {
                        Ok(s) => s,
                        Err(_) => return,
                    };
                    let job = loop {
                        if !alive() {
                            return;
                        }
                        for slot in slots.iter_mut() {
                            if slot.as_ref().is_some_and(|j| !j.request.is_current()) {
                                *slot = None
                            }
                        }
                        if let Some(job) = slots.iter_mut().find_map(Option::take) {
                            break job;
                        }
                        slots = match queue.wake.wait_timeout(slots, Duration::from_millis(100)) {
                            Ok((s, _)) => s,
                            Err(_) => return,
                        };
                    };
                    drop(slots);
                    let current = || {
                        alive()
                            && job.request.is_current()
                            && preferences.normalization_is_enabled()
                            && job
                                .stamp
                                .as_ref()
                                .is_none_or(|stamp| job.cache.stamp_is_current(&job.key, stamp))
                    };
                    if !current() {
                        let _ = job
                            .reply
                            .try_send(Err("Audio preparation cancelled".into()));
                        continue;
                    }
                    let result = if job.stamp.is_some() {
                        job.cache
                            .get_computed_gain(&job.key)
                            .filter(|g| g.is_finite())
                            .map(Ok)
                            .unwrap_or_else(|| analyze(job.file, &job.ext, &current))
                    } else {
                        analyze(job.file, &job.ext, &current)
                    };
                    let result = match result {
                        Ok(gain) if gain.is_finite() && current() => {
                            // Persistence is opportunistic; transient spool preparation still works
                            // while another process owns the cache or storage is unavailable.
                            if let Some(stamp) = &job.stamp {
                                let _ =
                                    job.cache.set_computed_gain_for_stamp(&job.key, stamp, gain);
                            }
                            if current() {
                                Ok(gain)
                            } else {
                                Err("Audio preparation cancelled".into())
                            }
                        }
                        Err(error) if current() => {
                            // Full-file preparation can discover damage beyond the initial
                            // playback prefix. Retire only positively incomplete encoded bytes.
                            // A valid silent/short file lacking integrated loudness is not corrupt.
                            if error == "Incomplete audio cannot be used for loudness analysis" {
                                if let Some(stamp) = &job.stamp {
                                    job.cache.discard(&job.key, stamp);
                                }
                            }
                            Err(error)
                        }
                        _ => Err("Audio preparation cancelled".into()),
                    };
                    let _ = job.reply.try_send(result);
                }
            })?;
        Ok(Self {
            pending,
            atomics,
            alive,
            worker: Some(worker),
        })
    }
    pub(super) fn prepare(
        &self,
        source: &super::source::MediaSource,
        deck: DeckId,
        request: &PlaybackRequest,
        cache: Arc<AudioCache>,
        file: File,
        stamp: Option<CacheStamp>,
    ) -> Result<Option<f32>, String> {
        if !request.is_current() {
            return Err("Audio preparation cancelled".into());
        }
        if !self.atomics.normalization_is_enabled() {
            return Ok(None);
        }
        let (tx, rx): (Sender<Result<f32, String>>, Receiver<Result<f32, String>>) =
            crossbeam_channel::bounded(1);
        let accepted_stamp = stamp.clone();
        let accepted_cache = cache.clone();
        let job = Job {
            key: source.cache_key.clone(),
            ext: source.extension.clone(),
            file,
            cache,
            stamp,
            request: request.clone(),
            reply: tx,
        };
        {
            let mut slots = self
                .pending
                .slots
                .lock()
                .map_err(|_| "Audio preparation unavailable")?;
            slots[if deck == DeckId::A { 0 } else { 1 }] = Some(job);
            self.pending.wake.notify_one();
        }
        loop {
            if !request.is_current()
                || !self.alive.load(Ordering::Acquire)
                || !self.pending.running.load(Ordering::Acquire)
            {
                return Err("Audio preparation cancelled".into());
            }
            if !self.atomics.normalization_is_enabled() {
                return Ok(None);
            }
            match rx.recv_timeout(Duration::from_millis(10)) {
                Ok(result) => {
                    if result.is_ok()
                        && accepted_stamp.as_ref().is_some_and(|stamp| {
                            !accepted_cache.stamp_is_current(&source.cache_key, stamp)
                        })
                    {
                        return Err("Audio file changed during preparation".into());
                    }
                    return result.map(Some);
                }
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                Err(_) => return Err("Audio preparation unavailable".into()),
            }
        }
    }
}
impl Drop for LoudnessAnalysis {
    fn drop(&mut self) {
        self.pending.running.store(false, Ordering::Release);
        self.pending.wake.notify_all();
        self.worker.take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    fn source() -> super::super::source::MediaSource {
        super::super::source::MediaSource::new(
            crate::plex::client::public_media_request("https://fixture.invalid/song.wav"),
            None,
        )
        .unwrap()
    }
    fn cache_file(cache: &AudioCache, source: &super::super::source::MediaSource, bytes: &[u8]) {
        let mut writer = cache.begin_write(&source.cache_key, "wav").unwrap();
        writer.write_chunk(bytes).unwrap();
        writer.finish(cache).unwrap();
    }
    fn request(atomics: &SharedAtomics, deck: DeckId) -> PlaybackRequest {
        atomics.request_epoch.store(1, Ordering::SeqCst);
        PlaybackRequest::new(
            1,
            atomics.request_epoch.clone(),
            if deck == DeckId::A {
                atomics.deck_a_load_id.clone()
            } else {
                atomics.deck_b_load_id.clone()
            },
        )
    }
    #[test]
    fn preparation_runs_before_installation_and_second_deck_reuses_same_revision() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(AudioCache::new(dir.path().into(), None));
        let source = source();
        cache_file(&cache, &source, b"encoded");
        let atomics = Arc::new(SharedAtomics::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let measured = calls.clone();
        let service = LoudnessAnalysis::with_analyzer(
            atomics.clone(),
            Arc::new(AtomicBool::new(true)),
            Arc::new(move |_, _, _| {
                measured.fetch_add(1, Ordering::SeqCst);
                Ok(-5.0)
            }),
        )
        .unwrap();
        for deck in [DeckId::A, DeckId::B] {
            let request = request(&atomics, deck);
            let (file, stamp) = cache.open_with_stamp(&source.cache_key).unwrap();
            assert_eq!(
                service
                    .prepare(&source, deck, &request, cache.clone(), file, Some(stamp))
                    .unwrap(),
                Some(-5.0)
            );
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(atomics.deck_a_loaded_id.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn normalization_off_never_admits_a_measurement() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(AudioCache::new(dir.path().into(), None));
        let source = source();
        cache_file(&cache, &source, b"encoded");
        let atomics = Arc::new(SharedAtomics::new());
        atomics.normalization_enabled.store(false, Ordering::SeqCst);
        let service = LoudnessAnalysis::with_analyzer(
            atomics.clone(),
            Arc::new(AtomicBool::new(true)),
            Arc::new(|_, _, _| panic!("Disabled normalization cannot analyze")),
        )
        .unwrap();
        let request = request(&atomics, DeckId::A);
        let (file, stamp) = cache.open_with_stamp(&source.cache_key).unwrap();
        assert_eq!(
            service
                .prepare(
                    &source,
                    DeckId::A,
                    &request,
                    cache.clone(),
                    file,
                    Some(stamp)
                )
                .unwrap(),
            None
        );
        assert!(cache.get_computed_gain(&source.cache_key).is_none());
    }
    #[test]
    fn latest_request_cancels_waiting_scan_and_cannot_publish_old_gain() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(AudioCache::new(dir.path().into(), None));
        let source = source();
        cache_file(&cache, &source, b"encoded");
        let atomics = Arc::new(SharedAtomics::new());
        let (started_tx, started) = crossbeam_channel::bounded(1);
        let (done_tx, done) = crossbeam_channel::bounded(1);
        let service = LoudnessAnalysis::with_analyzer(
            atomics.clone(),
            Arc::new(AtomicBool::new(true)),
            Arc::new(move |_, _, current| {
                started_tx.send(()).unwrap();
                let deadline = std::time::Instant::now() + Duration::from_secs(2);
                while current() && std::time::Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(1))
                }
                assert!(!current(), "Synthetic scan must be cancelled");
                done_tx.send(()).unwrap();
                Ok(-9.0)
            }),
        )
        .unwrap();
        let request = request(&atomics, DeckId::A);
        let (file, stamp) = cache.open_with_stamp(&source.cache_key).unwrap();
        std::thread::scope(|scope| {
            let waiting = scope.spawn(|| {
                service.prepare(
                    &source,
                    DeckId::A,
                    &request,
                    cache.clone(),
                    file,
                    Some(stamp),
                )
            });
            started.recv_timeout(Duration::from_secs(2)).unwrap();
            atomics.request_epoch.fetch_add(1, Ordering::SeqCst);
            assert!(waiting.join().unwrap().is_err());
        });
        done.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(cache.get_computed_gain(&source.cache_key).is_none());
    }
    #[test]
    fn changed_file_revision_rejects_late_measurement() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(AudioCache::new(dir.path().into(), None));
        let source = source();
        let mut replacement = cache.begin_write(&source.cache_key, "wav").unwrap();
        replacement.write_chunk(b"replaced").unwrap();
        cache_file(&cache, &source, b"original");
        let atomics = Arc::new(SharedAtomics::new());
        let (started_tx, started) = crossbeam_channel::bounded(1);
        let service = LoudnessAnalysis::with_analyzer(
            atomics.clone(),
            Arc::new(AtomicBool::new(true)),
            Arc::new(move |_, _, current| {
                started_tx.send(()).unwrap();
                let deadline = std::time::Instant::now() + Duration::from_secs(2);
                while current() && std::time::Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(1))
                }
                assert!(!current(), "Synthetic scan must be cancelled");
                Ok(-9.0)
            }),
        )
        .unwrap();
        let request = request(&atomics, DeckId::A);
        let (file, stamp) = cache.open_with_stamp(&source.cache_key).unwrap();
        std::thread::scope(|scope| {
            let waiting = scope.spawn(|| {
                service.prepare(
                    &source,
                    DeckId::A,
                    &request,
                    cache.clone(),
                    file,
                    Some(stamp),
                )
            });
            started.recv_timeout(Duration::from_secs(2)).unwrap();
            replacement.finish(&cache).unwrap();
            assert!(waiting.join().unwrap().is_err());
        });
        assert!(cache.get_computed_gain(&source.cache_key).is_none());
    }
    #[test]
    fn full_file_preparation_retires_confirmed_corrupt_cache_beyond_the_initial_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(AudioCache::new(dir.path().into(), None));
        let source = source();
        let mut bytes = super::super::deck::decode::tests::generate_test_wav(44100, 2, 3.0);
        bytes.truncate(bytes.len() * 3 / 4);
        cache_file(&cache, &source, &bytes);
        let atomics = Arc::new(SharedAtomics::new());
        let request = request(&atomics, DeckId::A);
        let service = LoudnessAnalysis::start(atomics, Arc::new(AtomicBool::new(true))).unwrap();
        let (file, stamp) = cache.open_with_stamp(&source.cache_key).unwrap();
        assert!(service
            .prepare(
                &source,
                DeckId::A,
                &request,
                cache.clone(),
                file,
                Some(stamp)
            )
            .is_err());
        assert!(cache.lookup(&source.cache_key).is_none());
        assert!(cache.get_computed_gain(&source.cache_key).is_none());
    }
}
