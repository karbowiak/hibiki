//! Ownership of asynchronous work. A new play/stop invalidates the session;
//! reusing a physical deck also invalidates its previous download and decoder.
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;

#[derive(Clone)]
pub struct PlaybackRequest {
    pub epoch: u64,
    current_epoch: Arc<AtomicU64>,
    pub load_id: u64,
    owner: Arc<AtomicU64>,
    preload_revision: Option<(Arc<AtomicU64>, u64)>,
    audible_deck: Option<(Arc<AtomicU8>, u8, Arc<AtomicBool>, Arc<AtomicU64>)>,
}

impl PlaybackRequest {
    pub fn new(epoch: u64, current_epoch: Arc<AtomicU64>, owner: Arc<AtomicU64>) -> Self {
        let load_id = owner.fetch_add(1, Ordering::SeqCst) + 1;
        Self {
            epoch,
            current_epoch,
            load_id,
            owner,
            preload_revision: None,
            audible_deck: None,
        }
    }

    pub fn for_preload(mut self, revision: Arc<AtomicU64>, value: u64) -> Self {
        self.preload_revision = Some((revision, value));
        self
    }

    pub fn with_audible_deck(
        mut self,
        active: Arc<AtomicU8>,
        deck: u8,
        crossfading: Arc<AtomicBool>,
        loaded: Arc<AtomicU64>,
    ) -> Self {
        self.audible_deck = Some((active, deck, crossfading, loaded));
        self
    }

    pub fn preload_revision(&self) -> Option<u64> {
        self.preload_revision.as_ref().map(|(_, value)| *value)
    }

    pub fn is_current(&self) -> bool {
        let audible = self
            .audible_deck
            .as_ref()
            .is_some_and(|(active, deck, fading, loaded)| {
                loaded.load(Ordering::SeqCst) == self.load_id
                    && (active.load(Ordering::SeqCst) == *deck || fading.load(Ordering::SeqCst))
            });
        self.owner.load(Ordering::SeqCst) == self.load_id
            && (audible
                || (self.current_epoch.load(Ordering::SeqCst) == self.epoch
                    && self
                        .preload_revision
                        .as_ref()
                        .is_none_or(|(revision, value)| revision.load(Ordering::SeqCst) == *value)))
    }

    pub async fn cancelled(&self) {
        while self.is_current() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clearing_the_next_track_keeps_the_promoted_active_download_alive() {
        let epoch = Arc::new(AtomicU64::new(1));
        let revision = Arc::new(AtomicU64::new(0));
        let active = Arc::new(AtomicU8::new(0));
        let fading = Arc::new(AtomicBool::new(false));
        let pending = PlaybackRequest::new(1, epoch.clone(), Arc::new(AtomicU64::new(0)))
            .with_audible_deck(
                active.clone(),
                1,
                fading.clone(),
                Arc::new(AtomicU64::new(1)),
            )
            .for_preload(revision.clone(), 0);
        let promoted = PlaybackRequest::new(1, epoch.clone(), Arc::new(AtomicU64::new(0)))
            .with_audible_deck(active.clone(), 0, fading, Arc::new(AtomicU64::new(1)))
            .for_preload(revision.clone(), 0);
        revision.store(1, Ordering::SeqCst);
        assert!(!pending.is_current());
        assert!(promoted.is_current());
        // Loading a new selection must leave the audible download running.
        epoch.store(2, Ordering::SeqCst);
        assert!(promoted.is_current());
        active.store(1, Ordering::SeqCst);
        assert!(!promoted.is_current());
    }

    #[test]
    fn new_play_and_deck_reuse_invalidate_only_their_old_work() {
        let epoch = Arc::new(AtomicU64::new(1));
        let a = Arc::new(AtomicU64::new(0));
        let b = Arc::new(AtomicU64::new(0));
        let first = PlaybackRequest::new(1, epoch.clone(), a.clone());
        let other = PlaybackRequest::new(1, epoch.clone(), b);
        let replacement = PlaybackRequest::new(1, epoch.clone(), a);
        assert!(!first.is_current());
        assert!(other.is_current());
        assert!(replacement.is_current());
        epoch.fetch_add(1, Ordering::SeqCst);
        assert!(!other.is_current());
        assert!(!replacement.is_current());
    }
}
