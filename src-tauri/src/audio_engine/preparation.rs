//! Bounded, speculative file preparation. Uses the same cache and R128 worker as
//! selected playback and preload; never creates a PCM deck or changes playback.
use super::{
    analysis::{AudioItem, LoudnessAnalysis},
    cache::AudioCache,
    request::PlaybackRequest,
    source::MediaSource,
    types::DeckId,
};
use std::sync::{atomic::Ordering, Arc};

pub(crate) struct Track {
    pub source: MediaSource,
    pub duration_ms: u64,
    pub gain_db: Option<f32>,
}

pub(super) fn prepare(
    track: &Track,
    default_cache: &Arc<AudioCache>,
    rt: &tokio::runtime::Handle,
    request: &PlaybackRequest,
    analysis: Option<&LoudnessAnalysis>,
) -> Result<(), String> {
    if track.duration_ms == 0 || default_cache.stats().max_bytes == 0 {
        return Ok(());
    }
    let mut source = track.source.try_clone()?.resolve(rt, request)?;
    let cache = source.local_cache.as_ref().unwrap_or(default_cache).clone();
    let lock = cache.fill_lock(&source.cache_key);
    let guard = rt.block_on(async {
        tokio::select! {
            biased;
            _ = request.cancelled() => Err("Queue preparation superseded".to_owned()),
            guard = lock.lock_owned() => Ok(guard),
        }
    })?;
    if cache.open_with_stamp(&source.cache_key).is_none() {
        if source.request.is_none() && source.requires_resolution() {
            source = source.resolve_network(rt, request)?;
        }
        let media_request = source
            .request
            .as_ref()
            .ok_or("Audio is unavailable for queue preparation")?;
        let mut writer = cache.begin_write(&source.cache_key, &source.extension)?;
        let size = writer.declared_size();
        rt.block_on(async {
            tokio::select! {
                biased;
                _ = request.cancelled() => Err("Queue preparation superseded".to_owned()),
                result = super::download::download(
                    || media_request.try_clone().expect("cloneable media GET"),
                    |length| { size.store(length, Ordering::Release); },
                    |chunk| writer.write_chunk(chunk), source.plex_fetch_lock.as_deref()) => result,
            }
        })?;
        if !request.is_current() {
            return Err("Queue preparation superseded".into());
        }
        writer.finish(&cache)?;
    }
    if let Some(gain) = source.gain_db.filter(|gain| gain.is_finite()) {
        if let Some((_, stamp)) = cache.open_with_stamp(&source.cache_key) {
            let _ = cache.set_computed_gain_for_stamp(&source.cache_key, &stamp, gain);
        }
    }
    drop(guard);
    if source.prepare_waveform {
        super::waveform::schedule(cache.clone(), source.cache_key.clone(), request.clone());
    }
    if track
        .gain_db
        .or(source.gain_db)
        .is_some_and(|gain| gain.is_finite())
        || cache.get_computed_gain(&source.cache_key).is_some()
    {
        return Ok(());
    }
    if let (Some(analysis), Some(item)) = (analysis, AudioItem::cached(&source, cache.clone())) {
        match analysis.prepare_item(item, DeckId::A, request) {
            Err(error) if error == "No integrated loudness measurement available" => {}
            result => {
                result?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_engine::{callback::SharedAtomics, deck::decode, types::TrackMeta};
    use std::{
        io::{Read, Write},
        sync::atomic::{AtomicBool, AtomicU64, AtomicUsize},
    };

    #[test]
    fn prepared_audio_and_gain_survive_restart_and_skip_extraction_and_analysis_on_replay() {
        for supplied_gain in [Some(-8.0), None] {
            let directory = tempfile::tempdir().unwrap();
            let cache = Arc::new(AudioCache::new(directory.path().into(), None));
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/track.wav", listener.local_addr().unwrap());
            listener.set_nonblocking(true).unwrap();
            let body = decode::tests::generate_test_wav(44100, 2, 3.0);
            let server = std::thread::spawn(move || {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
                let mut socket = loop {
                    if let Ok((socket, _)) = listener.accept() {
                        break socket;
                    }
                    assert!(
                        std::time::Instant::now() < deadline,
                        "Queue preparation did not request audio"
                    );
                    std::thread::sleep(std::time::Duration::from_millis(5));
                };
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                    .unwrap();
                let mut header = Vec::new();
                while !header.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).unwrap();
                    header.push(byte[0]);
                }
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .unwrap();
                socket.write_all(&body).unwrap();
            });
            let key = "s1-prepared-song";
            let lookups = Arc::new(AtomicUsize::new(0));
            let observed = lookups.clone();
            let owned_cache = cache.clone();
            let mut source = MediaSource::deferred(key.into(), move || {
                observed.fetch_add(1, Ordering::SeqCst);
                let mut source = MediaSource::new(reqwest::Client::new().get(&url), None).unwrap();
                source.cache_key = key.into();
                source.gain_db = supplied_gain;
                source.local_cache = Some(owned_cache.clone());
                Box::pin(async move { Ok(source) })
            });
            source.local_cache = Some(cache.clone());
            let track = Track {
                source,
                duration_ms: 3000,
                gain_db: None,
            };
            let atomics = Arc::new(SharedAtomics::new());
            atomics.request_epoch.store(1, Ordering::SeqCst);
            let request = PlaybackRequest::new(
                1,
                atomics.request_epoch.clone(),
                Arc::new(AtomicU64::new(0)),
            );
            let calls = Arc::new(AtomicUsize::new(0));
            let analyzed = calls.clone();
            let analysis = LoudnessAnalysis::with_analyzer(
                atomics.clone(),
                Arc::new(AtomicBool::new(true)),
                Arc::new(move |_, _, _| {
                    analyzed.fetch_add(1, Ordering::SeqCst);
                    Ok(-5.0)
                }),
            )
            .unwrap();
            let runtime = tokio::runtime::Runtime::new().unwrap();
            prepare(&track, &cache, runtime.handle(), &request, Some(&analysis)).unwrap();
            server.join().unwrap();
            prepare(&track, &cache, runtime.handle(), &request, Some(&analysis)).unwrap();
            assert_eq!(lookups.load(Ordering::SeqCst), 1);
            assert_eq!(
                calls.load(Ordering::SeqCst),
                usize::from(supplied_gain.is_none())
            );
            assert_eq!(
                atomics.deck_a_load_id.load(Ordering::SeqCst),
                0,
                "Warming must not revoke playback deck ownership"
            );
            drop(track);
            drop(analysis);
            drop(cache);

            let cache = Arc::new(AudioCache::new(directory.path().into(), None));
            let mut source = MediaSource::deferred(key.into(), || {
                panic!("Cached resume must not invoke yt-dlp or the player API")
            });
            source.local_cache = Some(cache.clone());
            let source = source.resolve(runtime.handle(), &request).unwrap();
            let decoded = super::super::fetch_and_decode_incremental(
                &source,
                -2,
                &cache,
                runtime.handle(),
                44100,
                2,
                &request,
            )
            .unwrap();
            assert!(!decoded.initial_samples.is_empty());
            assert!(decoded.cached_stamp.is_some());
            let meta = TrackMeta {
                rating_key: -2,
                duration_ms: 3000,
                parent_key: String::new(),
                album_playback: false,
                gain_db: None,
                skip_crossfade: true,
                start_ramp: None,
                end_ramp: None,
                labels: None,
                reporting_binding: None,
                source_format: None,
            };
            let gain = super::super::prepare_gain_db(
                &meta,
                &source,
                DeckId::A,
                &request,
                &cache,
                &atomics,
                None,
                &decoded,
            )
            .unwrap();
            assert_eq!(gain, Some(supplied_gain.unwrap_or(-5.0)));
        }
    }
}
