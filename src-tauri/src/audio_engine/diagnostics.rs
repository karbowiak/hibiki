//! Read-only diagnostics. The callback writes atomics; source I/O stays on workers.
use super::{callback::SharedAtomics, deck::streaming::TransferProgress, types::DeckId};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    Arc, Mutex,
};

struct Source {
    load_id: u64,
    kind: &'static str,
    bytes: Option<u64>,
    spool: Option<Arc<TransferProgress>>,
}

pub struct Diagnostics {
    sources: Mutex<[Option<Source>; 2]>,
    pub source_deck: AtomicU32,
    pub source_load_id: AtomicU64,
    pub buffered_frames: AtomicU64,
    pub decoded_complete: AtomicBool,
    pub block_ns: AtomicU64,
    pub block_frames: AtomicU64,
    pub blocks: AtomicU64,
    pub starvations: AtomicU64,
    pub normalization_gain: AtomicU32,
    pub preamp_gain: AtomicU32,
    pub post_gain: AtomicU32,
    pub volume: AtomicU32,
    pub eq_enabled: AtomicBool,
    pub limiter_enabled: AtomicBool,
    pub output_rate: AtomicU32,
    pub output_channels: AtomicU32,
    pub output_format: AtomicU32,
}
impl Default for Diagnostics {
    fn default() -> Self {
        Self {
            source_deck: AtomicU32::new(0),
            source_load_id: AtomicU64::new(0),
            sources: Mutex::new([None, None]),
            buffered_frames: AtomicU64::new(0),
            decoded_complete: AtomicBool::new(false),
            block_ns: AtomicU64::new(0),
            block_frames: AtomicU64::new(0),
            blocks: AtomicU64::new(0),
            starvations: AtomicU64::new(0),
            normalization_gain: AtomicU32::new(1f32.to_bits()),
            preamp_gain: AtomicU32::new(1f32.to_bits()),
            post_gain: AtomicU32::new(1f32.to_bits()),
            volume: AtomicU32::new(1f32.to_bits()),
            eq_enabled: AtomicBool::new(false),
            limiter_enabled: AtomicBool::new(true),
            output_rate: AtomicU32::new(0),
            output_channels: AtomicU32::new(0),
            output_format: AtomicU32::new(0),
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    kind: &'static str,
    downloaded_bytes: Option<u64>,
    total_bytes: Option<u64>,
    complete: bool,
    failed: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    request_id: u64,
    playback_id: u64,
    rating_key: i64,
    state: super::types::EngineState,
    position_ms: u64,
    buffered_seconds: f64,
    decoded_complete: bool,
    mixer_rate: u32,
    mixer_channels: u16,
    output_available: bool,
    output_rate: u32,
    output_channels: u32,
    output_format: &'static str,
    block_us: f64,
    block_budget_us: f64,
    blocks: u64,
    buffer_starvations: u64,
    normalization_gain: f32,
    preamp_gain: f32,
    post_gain: f32,
    volume: f32,
    eq_enabled: bool,
    limiter_enabled: bool,
    crossfading: bool,
    source: Option<Transfer>,
}
impl Diagnostics {
    /// Called only on the decode/preparation worker, never on the audio callback.
    pub(in crate::audio_engine) fn record_source(
        &self,
        deck: DeckId,
        load_id: u64,
        kind: &'static str,
        bytes: Option<u64>,
        spool: Option<Arc<TransferProgress>>,
    ) {
        if let Ok(mut sources) = self.sources.lock() {
            sources[if deck == DeckId::A { 0 } else { 1 }] = Some(Source {
                load_id,
                kind,
                bytes,
                spool,
            });
        }
    }

    pub fn snapshot(&self, shared: &SharedAtomics) -> Option<Snapshot> {
        let revision = shared.position_revision.load(Ordering::Acquire);
        if revision % 2 != 0 {
            return None;
        }
        let playback_id = shared.active_playback_id.load(Ordering::Relaxed);
        if playback_id == 0 {
            return None;
        }
        let deck = self.source_deck.load(Ordering::Relaxed) as usize;
        let loaded = self.source_load_id.load(Ordering::Relaxed);
        let source = self.sources.try_lock().ok().and_then(|sources| {
            let source = sources
                .get(deck)?
                .as_ref()
                .filter(|source| source.load_id == loaded)?;
            if let Some(spool) = &source.spool {
                let (downloaded, total, complete, failed) = spool.snapshot();
                Some(Transfer {
                    kind: source.kind,
                    downloaded_bytes: Some(downloaded),
                    total_bytes: total,
                    complete,
                    failed,
                })
            } else {
                Some(Transfer {
                    kind: source.kind,
                    downloaded_bytes: source.bytes,
                    total_bytes: source.bytes,
                    complete: true,
                    failed: false,
                })
            }
        });
        let rate = shared.device_sample_rate.load(Ordering::Relaxed).max(1);
        let snapshot = Snapshot {
            request_id: shared.active_request_id.load(Ordering::Relaxed),
            playback_id,
            rating_key: shared.active_rating_key.load(Ordering::Relaxed),
            state: shared.get_state(),
            position_ms: shared.position_ms.load(Ordering::Relaxed),
            buffered_seconds: self.buffered_frames.load(Ordering::Relaxed) as f64 / f64::from(rate),
            decoded_complete: self.decoded_complete.load(Ordering::Relaxed),
            mixer_rate: rate,
            mixer_channels: 2,
            output_available: shared.output_available.load(Ordering::Relaxed),
            output_rate: self.output_rate.load(Ordering::Relaxed),
            output_channels: self.output_channels.load(Ordering::Relaxed),
            output_format: format_name(self.output_format.load(Ordering::Relaxed)),
            block_us: self.block_ns.load(Ordering::Relaxed) as f64 / 1000.0,
            block_budget_us: self.block_frames.load(Ordering::Relaxed) as f64 / f64::from(rate)
                * 1_000_000.0,
            blocks: self.blocks.load(Ordering::Relaxed),
            buffer_starvations: self.starvations.load(Ordering::Relaxed),
            normalization_gain: f32::from_bits(self.normalization_gain.load(Ordering::Relaxed)),
            preamp_gain: f32::from_bits(self.preamp_gain.load(Ordering::Relaxed)),
            post_gain: f32::from_bits(self.post_gain.load(Ordering::Relaxed)),
            volume: f32::from_bits(self.volume.load(Ordering::Relaxed)),
            eq_enabled: self.eq_enabled.load(Ordering::Relaxed),
            limiter_enabled: self.limiter_enabled.load(Ordering::Relaxed),
            crossfading: shared.crossfading.load(Ordering::Relaxed),
            source,
        };
        std::sync::atomic::fence(Ordering::Acquire);
        (revision == shared.position_revision.load(Ordering::Relaxed)).then_some(snapshot)
    }
}

pub fn format_code(format: cpal::SampleFormat) -> u32 {
    use cpal::SampleFormat::*;
    match format {
        F32 => 1,
        F64 => 2,
        I8 => 3,
        I16 => 4,
        I32 => 5,
        I64 => 6,
        U8 => 7,
        U16 => 8,
        U32 => 9,
        U64 => 10,
        _ => 0,
    }
}
fn format_name(code: u32) -> &'static str {
    match code {
        1 => "32-bit float",
        2 => "64-bit float",
        3 => "8-bit signed",
        4 => "16-bit signed",
        5 => "32-bit signed",
        6 => "64-bit signed",
        7 => "8-bit unsigned",
        8 => "16-bit unsigned",
        9 => "32-bit unsigned",
        10 => "64-bit unsigned",
        _ => "Unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_engine::deck::streaming::SharedBuffer;

    #[test]
    fn pending_or_replaced_deck_sources_cannot_appear_as_the_active_transfer() {
        let shared = SharedAtomics::new();
        let metrics = &shared.diagnostics;
        assert!(metrics.snapshot(&shared).is_none());
        shared.active_playback_id.store(41, Ordering::Relaxed);
        metrics.source_deck.store(0, Ordering::Relaxed);
        metrics.source_load_id.store(7, Ordering::Relaxed);
        metrics.record_source(DeckId::B, 8, "download", Some(800), None);
        metrics.record_source(DeckId::A, 6, "cache", Some(600), None);
        assert!(metrics.snapshot(&shared).unwrap().source.is_none());
        metrics.record_source(DeckId::A, 7, "cache", Some(700), None);
        let value = metrics.snapshot(&shared).unwrap();
        assert_eq!(value.playback_id, 41);
        let source = value.source.unwrap();
        assert_eq!(source.kind, "cache");
        assert_eq!(source.downloaded_bytes, Some(700));
        shared.position_revision.store(1, Ordering::Release);
        assert!(metrics.snapshot(&shared).is_none());
    }
    #[test]
    fn telemetry_does_not_retain_an_audio_spool_after_the_decoder_is_gone() {
        let shared = SharedAtomics::new();
        shared.active_playback_id.store(1, Ordering::Relaxed);
        let spool = SharedBuffer::new(Some(10)).unwrap();
        let weak = Arc::downgrade(&spool);
        shared.diagnostics.record_source(
            DeckId::A,
            0,
            "network",
            None,
            Some(spool.transfer_progress()),
        );
        spool.push(b"abcdefghij").unwrap();
        spool.finish();
        drop(spool);
        assert!(
            weak.upgrade().is_none(),
            "Diagnostics must not retain the audio file"
        );
        let source = shared
            .diagnostics
            .snapshot(&shared)
            .unwrap()
            .source
            .unwrap();
        assert_eq!(source.downloaded_bytes, Some(10));
        assert_eq!(source.total_bytes, Some(10));
        assert!(source.complete);
        assert!(!source.failed);
    }
    #[test]
    fn interrupted_transfer_is_not_reported_as_a_complete_cached_file() {
        let shared = SharedAtomics::new();
        shared.active_playback_id.store(1, Ordering::Relaxed);
        let spool = SharedBuffer::new(None).unwrap();
        spool.push(b"part").unwrap();
        spool.abort();
        shared.diagnostics.record_source(
            DeckId::A,
            0,
            "network",
            None,
            Some(spool.transfer_progress()),
        );
        let source = shared
            .diagnostics
            .snapshot(&shared)
            .unwrap()
            .source
            .unwrap();
        assert_eq!(source.kind, "network");
        assert_eq!(source.total_bytes, None);
        assert_eq!(source.downloaded_bytes, Some(4));
        assert!(source.failed);
        assert!(!source.complete);
    }
}
