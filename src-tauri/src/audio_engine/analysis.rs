//! Bounded, cancellable file loudness analysis outside playback preparation.

use super::{
    cache::AudioCache, callback::SharedAtomics, command::AudioCommand, request::PlaybackRequest,
    types::DeckId,
};
use crossbeam_channel::Sender;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

pub(super) type Analyzer =
    dyn Fn(&Path, &str, &dyn Fn() -> bool) -> Result<f32, String> + Send + Sync;
struct Job {
    key: String,
    ext: String,
    deck: DeckId,
    request: PlaybackRequest,
}
struct Pending {
    slots: Mutex<[Option<Job>; 2]>,
    wake: Condvar,
    running: AtomicBool,
}

pub struct LoudnessAnalysis {
    pending: Arc<Pending>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl LoudnessAnalysis {
    pub fn start(
        cache: Arc<AudioCache>,
        commands: Sender<AudioCommand>,
        atomics: Arc<SharedAtomics>,
        engine_alive: Arc<AtomicBool>,
    ) -> std::io::Result<Self> {
        Self::with_analyzer(
            cache,
            commands,
            atomics,
            engine_alive,
            Arc::new(|path, ext, current| super::loudness::analyze_loudness(path, ext, current)),
        )
    }
    pub(super) fn with_analyzer(
        cache: Arc<AudioCache>,
        commands: Sender<AudioCommand>,
        atomics: Arc<SharedAtomics>,
        engine_alive: Arc<AtomicBool>,
        analyze: Arc<Analyzer>,
    ) -> std::io::Result<Self> {
        let pending = Arc::new(Pending {
            slots: Mutex::new([None, None]),
            wake: Condvar::new(),
            running: AtomicBool::new(true),
        });
        let queue = pending.clone();
        let worker = std::thread::Builder::new()
            .name("audio-loudness".into())
            .spawn(move || {
                let alive = || {
                    queue.running.load(Ordering::Acquire) && engine_alive.load(Ordering::Acquire)
                };
                while alive() {
                    let mut slots = match queue.slots.lock() {
                        Ok(slots) => slots,
                        Err(_) => return,
                    };
                    let mut ready = None;
                    for slot in slots.iter_mut() {
                        if slot.as_ref().is_some_and(|job| !job.request.is_current()) {
                            *slot = None;
                        }
                        if let Some(job) = slot.as_ref() {
                            let loaded = match job.deck {
                                DeckId::A => &atomics.deck_a_loaded_id,
                                DeckId::B => &atomics.deck_b_loaded_id,
                            };
                            // Wait for installation before publishing an update. Cache misses
                            // also wait for a completed file, never a partial download.
                            if loaded.load(Ordering::Acquire) == job.request.load_id {
                                if let Some(path) = cache.lookup(&job.key) {
                                    ready = Some((job.deck, path));
                                    break;
                                }
                            }
                        }
                    }
                    let Some((deck, path)) = ready else {
                        if queue
                            .wake
                            .wait_timeout(slots, Duration::from_millis(100))
                            .is_err()
                        {
                            return;
                        }
                        continue;
                    };
                    let job = slots[deck_index(deck)].take().unwrap();
                    drop(slots);
                    let current = || alive() && job.request.is_current();
                    if !current() {
                        continue;
                    }
                    let result = cache
                        .get_computed_gain(&job.key)
                        .filter(|value| value.is_finite())
                        .map(Ok)
                        .unwrap_or_else(|| analyze(&path, &job.ext, &current));
                    match result {
                        Ok(gain_db) if gain_db.is_finite() && current() => {
                            cache.set_computed_gain(&job.key, gain_db);
                            // A full callback queue must not turn analysis into unbounded
                            // queued work. Retry only while this exact deck still belongs here.
                            let mut command = AudioCommand::AnalyzedGain {
                                deck: job.deck,
                                load_id: job.request.load_id,
                                gain_db,
                            };
                            while current() {
                                match commands.send_timeout(command, Duration::from_millis(10)) {
                                    Ok(()) => break,
                                    Err(crossbeam_channel::SendTimeoutError::Timeout(returned)) => {
                                        command = returned
                                    }
                                    Err(crossbeam_channel::SendTimeoutError::Disconnected(_)) => {
                                        return
                                    }
                                }
                            }
                        }
                        Err(error) if current() => {
                            tracing::warn!(%error, "optional loudness analysis failed")
                        }
                        _ => {}
                    }
                }
            })?;
        Ok(Self {
            pending,
            worker: Some(worker),
        })
    }
    pub fn submit(
        &self,
        source: &super::source::MediaSource,
        deck: DeckId,
        request: PlaybackRequest,
    ) {
        if !request.is_current() {
            return;
        }
        if let Ok(mut slots) = self.pending.slots.lock() {
            // At most one queued source per physical deck; a new owner replaces
            // obsolete work instead of building a backlog during rapid skips.
            slots[deck_index(deck)] = Some(Job {
                key: source.cache_key.clone(),
                ext: source.extension.clone(),
                deck,
                request,
            });
            self.pending.wake.notify_one();
        }
    }
    fn stop(&self) {
        self.pending.running.store(false, Ordering::Release);
        self.pending.wake.notify_all();
    }
}
impl Drop for LoudnessAnalysis {
    fn drop(&mut self) {
        self.stop();
        // The worker sees cancellation between bounded decode batches. Do not block
        // the output owner or application shutdown on a filesystem read.
        self.worker.take();
    }
}
fn deck_index(deck: DeckId) -> usize {
    match deck {
        DeckId::A => 0,
        DeckId::B => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::super::source::MediaSource;
    use super::*;
    use std::sync::atomic::{AtomicU64, AtomicUsize};

    fn source(url: &str) -> MediaSource {
        MediaSource::new(crate::plex::client::public_media_request(url), None).unwrap()
    }
    fn cache_file(cache: &AudioCache, url: &str) {
        let media = source(url);
        let mut writer = cache
            .begin_write(&media.cache_key, &media.extension)
            .unwrap();
        writer.write_chunk(b"synthetic cache payload").unwrap();
        writer.finish(cache).unwrap();
    }
    fn request(atomics: &SharedAtomics, deck: DeckId) -> PlaybackRequest {
        let owner = match deck {
            DeckId::A => atomics.deck_a_load_id.clone(),
            DeckId::B => atomics.deck_b_load_id.clone(),
        };
        atomics.request_epoch.store(1, Ordering::SeqCst);
        PlaybackRequest::new(1, atomics.request_epoch.clone(), owner)
    }
    fn installed(atomics: &SharedAtomics, deck: DeckId, request: &PlaybackRequest) {
        match deck {
            DeckId::A => &atomics.deck_a_loaded_id,
            DeckId::B => &atomics.deck_b_loaded_id,
        }
        .store(request.load_id, Ordering::Release);
    }
    fn shutdown(mut service: LoudnessAnalysis) {
        service.stop();
        service.worker.take().unwrap().join().unwrap();
    }

    #[test]
    fn a_missing_current_file_does_not_block_a_ready_preload_or_run_before_installation() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(AudioCache::new(dir.path().into(), None));
        let atomics = Arc::new(SharedAtomics::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let (tx, rx) = crossbeam_channel::bounded(4);
        let measured = calls.clone();
        let service = LoudnessAnalysis::with_analyzer(
            cache.clone(),
            tx,
            atomics.clone(),
            Arc::new(AtomicBool::new(true)),
            Arc::new(move |_, _, _| {
                measured.fetch_add(1, Ordering::SeqCst);
                Ok(-6.0)
            }),
        )
        .unwrap();
        let active = request(&atomics, DeckId::A);
        installed(&atomics, DeckId::A, &active);
        service.submit(
            &source("https://test.invalid/not-complete.wav"),
            DeckId::A,
            active,
        );
        let url = "https://test.invalid/ready.wav";
        cache_file(&cache, url);
        let preload = request(&atomics, DeckId::B);
        service.submit(&source(url), DeckId::B, preload.clone());
        assert!(rx.recv_timeout(Duration::from_millis(150)).is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        installed(&atomics, DeckId::B, &preload);
        assert!(
            matches!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), AudioCommand::AnalyzedGain { deck: DeckId::B, load_id, .. } if load_id == preload.load_id)
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(cache.get_computed_gain(&source(url).cache_key), Some(-6.0));
        shutdown(service);
    }

    #[test]
    fn rapid_skips_replace_queued_deck_work_and_only_measure_the_latest_source() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(AudioCache::new(dir.path().into(), None));
        let atomics = Arc::new(SharedAtomics::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let (tx, rx) = crossbeam_channel::bounded(4);
        let measured = calls.clone();
        let service = LoudnessAnalysis::with_analyzer(
            cache.clone(),
            tx,
            atomics.clone(),
            Arc::new(AtomicBool::new(true)),
            Arc::new(move |_, _, _| {
                measured.fetch_add(1, Ordering::SeqCst);
                Ok(-4.0)
            }),
        )
        .unwrap();
        for index in 0..1000 {
            let job = request(&atomics, DeckId::A);
            service.submit(
                &source(&format!("https://test.invalid/skip-{index}.wav")),
                DeckId::A,
                job,
            );
        }
        let latest = request(&atomics, DeckId::A);
        let url = "https://test.invalid/latest.wav";
        cache_file(&cache, url);
        installed(&atomics, DeckId::A, &latest);
        service.submit(&source(url), DeckId::A, latest.clone());
        assert!(
            matches!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), AudioCommand::AnalyzedGain { load_id, .. } if load_id == latest.load_id)
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(rx.try_recv().is_err());
        shutdown(service);
    }

    #[test]
    fn replacement_cancels_an_active_scan_without_caching_or_publishing_its_gain() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(AudioCache::new(dir.path().into(), None));
        let atomics = Arc::new(SharedAtomics::new());
        let (started_tx, started) = crossbeam_channel::bounded(1);
        let (done_tx, done) = crossbeam_channel::bounded(1);
        let (tx, rx) = crossbeam_channel::bounded(4);
        let service = LoudnessAnalysis::with_analyzer(
            cache.clone(),
            tx,
            atomics.clone(),
            Arc::new(AtomicBool::new(true)),
            Arc::new(move |_, _, current| {
                started_tx.send(()).unwrap();
                while current() {
                    std::thread::sleep(Duration::from_millis(1));
                }
                done_tx.send(()).unwrap();
                Ok(-9.0) // A late success must still be discarded.
            }),
        )
        .unwrap();
        let url = "https://test.invalid/obsolete.wav";
        cache_file(&cache, url);
        let old = request(&atomics, DeckId::A);
        installed(&atomics, DeckId::A, &old);
        service.submit(&source(url), DeckId::A, old);
        started.recv_timeout(Duration::from_secs(2)).unwrap();
        atomics.deck_a_load_id.fetch_add(1, Ordering::SeqCst);
        done.recv_timeout(Duration::from_secs(2)).unwrap();
        shutdown(service);
        assert!(rx.try_recv().is_err());
        assert_eq!(cache.get_computed_gain(&source(url).cache_key), None);
    }

    #[test]
    fn a_second_deck_reuses_a_completed_measurement_of_the_same_file() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(AudioCache::new(dir.path().into(), None));
        let atomics = Arc::new(SharedAtomics::new());
        let calls = Arc::new(AtomicU64::new(0));
        let measured = calls.clone();
        let (tx, rx) = crossbeam_channel::bounded(4);
        let service = LoudnessAnalysis::with_analyzer(
            cache.clone(),
            tx,
            atomics.clone(),
            Arc::new(AtomicBool::new(true)),
            Arc::new(move |_, _, _| {
                measured.fetch_add(1, Ordering::SeqCst);
                Ok(-5.0)
            }),
        )
        .unwrap();
        let url = "https://test.invalid/shared.wav";
        cache_file(&cache, url);
        for deck in [DeckId::A, DeckId::B] {
            let job = request(&atomics, deck);
            installed(&atomics, deck, &job);
            service.submit(&source(url), deck, job);
            assert!(matches!(
                rx.recv_timeout(Duration::from_secs(2)).unwrap(),
                AudioCommand::AnalyzedGain { .. }
            ));
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        shutdown(service);
    }
}
