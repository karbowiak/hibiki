//! Native scoped audio catalogue and durable, user-requested downloads.
//! Explicit downloads live in app data; the automatic playback cache stays evictable.
use crate::audio_engine::{cache::AudioCache, source::MediaSource};
use crate::commands::{PlexRequestContext, PlexState};
use crate::db::{
    audio::{self, Binding},
    DbState,
};
use crate::plex::{PlexClient, Track};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::{Manager, State};

const LOCAL_PREFIX: &str = "hibiki-local://track/";
const MAX_TRACK_BYTES: u64 = 2 * 1024 * 1024 * 1024;

pub struct AudioDownloads {
    pub cache: Arc<AudioCache>,
    worker: Arc<tokio::sync::Mutex<()>>,
    active: Mutex<Option<(String, i64, Arc<AtomicBool>)>>,
    scheduled: Mutex<HashSet<(u64, String)>>,
    pub(crate) collection_refreshes: Mutex<HashSet<(u64, String)>>,
    analysis: tokio::sync::Mutex<()>,
    analysis_scheduled: Mutex<HashSet<(u64, String)>>,
    loudness_jobs:
        Mutex<HashMap<(String, i64, String), Arc<tokio::sync::Mutex<Option<std::time::Instant>>>>>,
    loudness_slots: tokio::sync::Semaphore,
}
impl AudioDownloads {
    pub(crate) fn cancel_download(&self, scope: &str, track_id: i64) -> Result<(), String> {
        let active = self
            .active
            .lock()
            .map_err(|_| "Download worker unavailable")?;
        if let Some((owner, id, cancel)) = active.as_ref() {
            if owner == scope && *id == track_id {
                cancel.store(true, Ordering::Release);
            }
        }
        Ok(())
    }
    pub fn new(root: std::path::PathBuf) -> Self {
        Self {
            cache: Arc::new(AudioCache::downloads(root)),
            worker: Arc::new(tokio::sync::Mutex::new(())),
            active: Mutex::new(None),
            scheduled: Mutex::new(HashSet::new()),
            collection_refreshes: Mutex::new(HashSet::new()),
            analysis: tokio::sync::Mutex::new(()),
            analysis_scheduled: Mutex::new(HashSet::new()),
            loudness_jobs: Mutex::new(HashMap::new()),
            loudness_slots: tokio::sync::Semaphore::new(2),
        }
    }
}
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |time| time.as_millis().min(i64::MAX as u128) as i64)
}
fn id(value: i64) -> Result<(), String> {
    if value <= 0 {
        return Err("Invalid Plex track".into());
    }
    Ok(())
}

/// The saved library is protected native state, never a renderer-supplied scope hint.
pub(crate) fn library_id(app: &tauri::AppHandle, client: &PlexClient) -> Result<i64, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|_| "Plex settings unavailable")?;
    let settings =
        crate::plex::load_settings(&directory).map_err(|_| "Plex settings unavailable")?;
    if settings.section_id <= 0
        || client.cache_scope_for_library(settings.section_id, Some(&settings.section_uuid))
            != client.library_scope
    {
        return Err("Plex music library changed. Reconnect before downloading.".into());
    }
    Ok(settings.section_id)
}

fn best_media(track: &Track) -> Result<&crate::plex::models::Media, String> {
    let lossless = |codec: &str| {
        matches!(
            codec.to_ascii_lowercase().as_str(),
            "flac" | "alac" | "wav" | "aiff" | "dsd"
        )
    };
    track
        .media
        .iter()
        .enumerate()
        .filter(|(_, media)| media.parts.len() == 1 && !media.parts[0].key.is_empty())
        .max_by(|a, b| {
            let score = |media: &crate::plex::models::Media| {
                let stream = media.parts[0]
                    .streams
                    .iter()
                    .find(|stream| stream.stream_type == Some(2));
                let codec = media.audio_codec.as_deref().unwrap_or("");
                let is_lossless = lossless(codec)
                    || stream
                        .and_then(|stream| stream.codec.as_deref())
                        .is_some_and(lossless);
                f64::from(is_lossless as u8) * 10000.0
                    + stream.and_then(|s| s.bit_depth).unwrap_or(16) as f64 * 100.0
                    + stream.and_then(|s| s.sampling_rate).unwrap_or(44100) as f64 / 100.0
                    + stream
                        .and_then(|s| s.bitrate)
                        .or(media.bitrate)
                        .unwrap_or(0) as f64
            };
            score(a.1)
                .total_cmp(&score(b.1))
                .then_with(|| b.0.cmp(&a.0))
        })
        .map(|(_, media)| media)
        .ok_or_else(|| "This track has no supported single-file media version".into())
}
fn artwork(path: Option<&str>) -> Option<&str> {
    path.filter(|path| {
        path.starts_with("/library/metadata/")
            && !path.contains(['?', '#', '\\'])
            && path.len() <= 2048
    })
}
fn parent_id(path: &str) -> Option<String> {
    path.strip_prefix("/library/metadata/")
        .filter(|id| id.bytes().all(|b| b.is_ascii_digit()) && !id.is_empty())
        .map(str::to_owned)
}

fn binding(
    client: &PlexClient,
    section: i64,
    expected: i64,
    track: &Track,
) -> Result<(Binding, MediaSource, Option<u64>), String> {
    id(expected)?;
    if track.rating_key != expected || track.library_section_id != section || track.duration <= 0 {
        return Err("Plex returned a track from a different music library".into());
    }
    let media = best_media(track)?;
    let part = &media.parts[0];
    if part.id <= 0
        || !part
            .key
            .starts_with(&format!("/library/parts/{}/", part.id))
        || part.key.contains(['?', '#', '\\'])
    {
        return Err("Invalid Plex audio part".into());
    }
    let source = MediaSource::new(
        client.media_request(&client.direct_play_url(&part.key)),
        Some(&client.library_scope),
    )?;
    let stream = part.streams.iter().find(|s| s.stream_type == Some(2));
    let analysis_version =
        crate::plex::catalogue::analysis_revision(media, track.music_analysis_version)?;
    let mut metadata = json!({
        "id":expected.to_string(),"title":track.title,"trackNumber":track.index,"duration":track.duration,
        "albumId":parent_id(&track.parent_key),"albumName":track.parent_title,"albumYear":track.parent_year,
        "artistId":parent_id(&track.grandparent_key),"artistName":track.grandparent_title,"year":track.year,"playCount":track.view_count,
        "summary":track.summary,"userRating":track.user_rating,"addedAt":track.added_at,"lastPlayedAt":track.last_viewed_at,"guid":track.guid,
        "codec":stream.and_then(|s|s.codec.as_ref()).or(media.audio_codec.as_ref()),"bitrate":stream.and_then(|s|s.bitrate).or(media.bitrate),
        "channels":stream.and_then(|s|s.channels).or(media.audio_channels),"bitDepth":stream.and_then(|s|s.bit_depth),"samplingRate":stream.and_then(|s|s.sampling_rate),
        "gain":stream.and_then(|s|s.gain),"albumGain":stream.and_then(|s|s.album_gain),"peak":stream.and_then(|s|s.peak),"loudness":stream.and_then(|s|s.loudness),
        "streamUrl":null,"thumbUrl":null,"albumThumbUrl":null,"artistThumbUrl":null,
        "rawThumbPath":artwork(track.thumb.as_deref().or(track.parent_thumb.as_deref())),
        "localAlbumThumbPath":artwork(track.parent_thumb.as_deref().or(track.thumb.as_deref())),"localArtistThumbPath":artwork(track.grandparent_thumb.as_deref()),
        "startRamp":stream.and_then(|s|s.start_ramp.as_ref()).or(track.start_ramp.as_ref()),"endRamp":stream.and_then(|s|s.end_ramp.as_ref()).or(track.end_ramp.as_ref()),
        "localParentKey":track.parent_key,"localPartId":part.id,"localPartKey":part.key,"mediaInfo":{"metadataComplete":true,"container":media.container,"fileSize":part.size}
    });
    metadata["localAnalysisVersion"] = json!(analysis_version);
    metadata["discNumber"] = json!(track.parent_index.unwrap_or(1));
    metadata["mediaInfo"]["audioStreamId"] = json!(stream.and_then(|s| s.id));
    let saved = Binding {
        track_id: expected,
        cache_key: source.cache_key.clone(),
        extension: source.extension.clone(),
        metadata,
    };
    Ok((
        saved,
        source,
        part.size.filter(|size| *size > 0).map(|size| size as u64),
    ))
}

fn available(
    bindings: Vec<Binding>,
    downloads: &Arc<AudioCache>,
    automatic: &Arc<AudioCache>,
) -> Option<(Binding, Arc<AudioCache>)> {
    for binding in bindings {
        for cache in [downloads, automatic] {
            if cache.lookup(&binding.cache_key).is_some() {
                return Some((binding, cache.clone()));
            }
        }
    }
    None
}

/// Hold the same native connection lock as remote audio admission and Reset.
pub(crate) async fn dispatch(
    plex: &PlexState,
    db: &DbState,
    downloads: &AudioDownloads,
    automatic: &Arc<AudioCache>,
    context: Option<&PlexRequestContext>,
    url: &str,
    track_id: i64,
    send: impl FnOnce(MediaSource) -> Result<u64, String>,
) -> Result<u64, String> {
    if url.starts_with("hibiki-local:") {
        if url != format!("{LOCAL_PREFIX}{track_id}") {
            return Err("Invalid local audio identity".into());
        }
        let context = context.ok_or("Local Plex audio requires its library owner")?;
        {
            let guard = plex.0.lock().await;
            plex.checked_cache_client(context, &guard)?;
        }
        let scope = context.cache_scope.clone();
        let bindings = db
            .read_urgent(move |conn| audio::bindings(conn, &scope, track_id))
            .await?;
        let (binding, cache) = available(bindings, &downloads.cache, automatic)
            .ok_or("This track is not available offline. Reconnect to Plex to download it.")?;
        let guard = plex.0.lock().await;
        let client = plex.checked_cache_client(context, &guard)?;
        send(MediaSource::cached(
            binding.cache_key,
            binding.extension,
            client.library_scope.clone(),
            cache,
        ))
    } else {
        plex.dispatch_audio(context, url, |mut source| {
            if source.plex_scope.is_some() && downloads.cache.lookup(&source.cache_key).is_some() {
                source.local_cache = Some(downloads.cache.clone());
            }
            send(source)
        })
        .await
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackInfo {
    url: String,
    track_key: i64,
    part_id: i64,
    parent_key: String,
    start_ramp: Option<String>,
    end_ramp: Option<String>,
    track_gain: Option<f64>,
    album_gain: Option<f64>,
    plex_context: PlexRequestContext,
}
fn info(binding: &Binding, context: PlexRequestContext, url: String) -> PlaybackInfo {
    let text = |key: &str| binding.metadata[key].as_str().map(str::to_owned);
    PlaybackInfo {
        url,
        track_key: binding.track_id,
        part_id: binding.metadata["localPartId"].as_i64().unwrap_or(0),
        parent_key: text("localParentKey").unwrap_or_default(),
        start_ramp: text("startRamp"),
        end_ramp: text("endRamp"),
        track_gain: binding.metadata["gain"].as_f64().filter(|v| v.is_finite()),
        album_gain: binding.metadata["albumGain"]
            .as_f64()
            .filter(|v| v.is_finite()),
        plex_context: context,
    }
}

/// Queue preparation can ask recent PMS versions for missing loudness. Requests
/// are per-track, deduplicated and bounded; failure leaves native R128 fallback
/// to prepare a fixed gain before any samples become audible.
async fn prepare_server_loudness(
    client: &PlexClient,
    context: &PlexRequestContext,
    plex: &PlexState,
    downloads: &AudioDownloads,
    section: i64,
    mut document: (Track, Value),
    normalization_enabled: impl Fn() -> bool,
    computed_gain_available: impl Fn(&str) -> bool,
) -> Result<(Track, Value), String> {
    let (before, _, _) = binding(client, section, document.0.rating_key, &document.0)?;
    let finite = |v: &Value| v.as_f64().is_some_and(f64::is_finite);
    if !normalization_enabled()
        || finite(&before.metadata["gain"])
        || finite(&before.metadata["albumGain"])
        || computed_gain_available(&before.cache_key)
    {
        return Ok(document);
    }
    let job = {
        let mut jobs = downloads
            .loudness_jobs
            .lock()
            .map_err(|_| "Loudness preparation unavailable")?;
        jobs.retain(|_, job| {
            Arc::strong_count(job) > 1
                || job.try_lock().is_ok_and(|last| {
                    last.is_some_and(|t| t.elapsed() < std::time::Duration::from_secs(600))
                })
        });
        if jobs.len() >= 512 {
            return Ok(document);
        }
        jobs.entry((
            context.cache_scope.clone(),
            before.track_id,
            before.cache_key.clone(),
        ))
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(None)))
        .clone()
    };
    let mut last = job.lock().await;
    {
        let guard = plex.0.lock().await;
        plex.checked_client(context, &guard)?;
    }
    if !normalization_enabled() {
        return Ok(document);
    }
    let recently_attempted =
        last.is_some_and(|t| t.elapsed() < std::time::Duration::from_secs(600));
    let _slot = match downloads.loudness_slots.try_acquire() {
        Ok(slot) => slot,
        Err(_) => return Ok(document),
    };
    if !recently_attempted {
        *last = Some(std::time::Instant::now());
        if !matches!(
            tokio::time::timeout(
                std::time::Duration::from_secs(2),
                client.put_metadata_params_once(
                    &format!("/library/metadata/{}/analyzeLoudness", before.track_id),
                    &[("force", "0"), ("manual", "1")]
                )
            )
            .await,
            Ok(Ok(()))
        ) {
            return Ok(document);
        }
    }
    let deadline = std::time::Instant::now()
        + std::time::Duration::from_secs(if recently_attempted { 1 } else { 4 });
    loop {
        {
            let guard = plex.0.lock().await;
            plex.checked_client(context, &guard)?;
        }
        if !normalization_enabled() {
            return Ok(document);
        }
        if let Ok(Ok(next)) = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            client.get_track_document(before.track_id),
        )
        .await
        {
            let (fresh, _, _) = binding(client, section, before.track_id, &next.0)?;
            if fresh.cache_key != before.cache_key {
                return Err("This track changed while preparing playback. Try again.".into());
            }
            let ready = finite(&fresh.metadata["gain"]) || finite(&fresh.metadata["albumGain"]);
            document = next;
            if ready {
                return Ok(document);
            }
        }
        if recently_attempted || std::time::Instant::now() >= deadline {
            return Ok(document);
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}
fn unavailable(error: &anyhow::Error) -> bool {
    error
        .chain()
        .filter_map(|e| e.downcast_ref::<reqwest::Error>())
        .any(|e| {
            e.is_connect()
                || e.is_timeout()
                || e.status()
                    .is_some_and(|s| matches!(s.as_u16(), 502 | 503 | 504))
        })
}

#[tauri::command]
pub async fn audio_prepare_plex_track(
    context: PlexRequestContext,
    track_id: i64,
    local_only: bool,
    app: tauri::AppHandle,
    plex: State<'_, PlexState>,
    db: State<'_, DbState>,
    downloads: State<'_, AudioDownloads>,
    engine: State<'_, crate::audio_engine::bridge::AudioEngineState>,
) -> Result<PlaybackInfo, String> {
    id(track_id)?;
    let client = {
        let guard = plex.0.lock().await;
        plex.checked_cache_client(&context, &guard)?.clone()
    };
    if !local_only && !client.offline_only {
        let section = library_id(&app, &client)?;
        match tokio::time::timeout(
            std::time::Duration::from_secs(20),
            client.get_track_document(track_id),
        )
        .await
        {
            Ok(Ok((track, raw))) => {
                let (track, raw) = prepare_server_loudness(
                    &client,
                    &context,
                    &plex,
                    &downloads,
                    section,
                    (track, raw),
                    || engine.0.normalization_enabled(),
                    |key| {
                        engine.0.cache().get_computed_gain(key).is_some()
                            || downloads.cache.get_computed_gain(key).is_some()
                    },
                )
                .await?;
                let (binding, _, _) = binding(&client, section, track_id, &track)?;
                let guard = plex.0.lock().await;
                plex.checked_client(&context, &guard)?;
                // Persistence failure must not break otherwise valid online playback.
                if let Ok(conn) = db.0.try_lock() {
                    let _ = audio::remember(&conn, &client.library_scope, &binding, now());
                    let _ = crate::db::catalogue::save(
                        &conn,
                        &client.library_scope,
                        "track",
                        track_id,
                        &raw,
                        true,
                    );
                } else {
                    let app = app.clone();
                    let owner = context.clone();
                    let saved = binding.clone();
                    let scope = client.library_scope.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = crate::catalogue_commands::save_checked(&app, &owner, |conn| {
                            audio::remember(conn, &scope, &saved, now())?;
                            crate::db::catalogue::save(conn, &scope, "track", track_id, &raw, true)
                        })
                        .await;
                    });
                }
                let media = best_media(&track)?;
                let url = client.direct_play_url(&media.parts[0].key);
                return Ok(info(&binding, context, url));
            }
            Ok(Err(error)) if !unavailable(&error) => return Err(
                "Plex could not authorize or locate this track. Refresh your library or reconnect."
                    .into(),
            ),
            _ => {}
        }
    }
    let scope = context.cache_scope.clone();
    let values = db
        .read_urgent(move |conn| audio::bindings(conn, &scope, track_id))
        .await?;
    let guard = plex.0.lock().await;
    plex.checked_cache_client(&context, &guard)?;
    let (binding, _) = available(values, &downloads.cache, engine.0.cache())
        .ok_or("This track is not available offline. Reconnect to Plex to download it.")?;
    Ok(info(&binding, context, format!("{LOCAL_PREFIX}{track_id}")))
}

/// Read full-resolution Plex levels once per exact media/analysis revision.
/// `/levels` contains the same 100 ms loudness series as `/loudness`, plus
/// sample-count metadata. Keep its complete response, not just 128 UI buckets.
fn cached_levels(
    conn: &rusqlite::Connection,
    client: &PlexClient,
    current: &Binding,
    stream_id: i64,
    version: &str,
) -> Result<Option<Value>, String> {
    cached_levels_impl(conn, client, current, stream_id, version, true)
}
fn cached_levels_impl(
    conn: &rusqlite::Connection,
    client: &PlexClient,
    current: &Binding,
    stream_id: i64,
    version: &str,
    persist_legacy: bool,
) -> Result<Option<Value>, String> {
    if let Some(raw) = crate::db::catalogue::levels(
        conn,
        &client.library_scope,
        &current.cache_key,
        stream_id,
        version,
    )? {
        return Ok(Some(raw));
    }
    let Some(raw) =
        crate::db::catalogue::get(conn, &client.library_scope, "track", current.track_id)?
    else {
        return Ok(None);
    };
    let Ok(track) = serde_json::from_value::<Track>(raw) else {
        return Ok(None);
    };
    let Ok((checked, _, _)) = binding(client, track.library_section_id, current.track_id, &track)
    else {
        return Ok(None);
    };
    if checked.cache_key != current.cache_key
        || checked.metadata["localAnalysisVersion"].as_str() != Some(version)
        || checked.metadata["mediaInfo"]["audioStreamId"].as_i64() != Some(stream_id)
    {
        return Ok(None);
    }
    // Adopt only the exact old hash of this same native raw Media/source and
    // analysis version. Never select an arbitrary older waveform for a track.
    use sha2::{Digest, Sha256};
    let media = best_media(&track)?;
    let legacy = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&(media, track.music_analysis_version, track.updated_at))
                .map_err(|_| "Invalid legacy analysis revision")?
        )
    );
    let Some(levels) = crate::db::catalogue::levels(
        conn,
        &client.library_scope,
        &current.cache_key,
        stream_id,
        &legacy,
    )?
    else {
        return Ok(None);
    };
    if persist_legacy {
        crate::db::catalogue::save_levels(
            conn,
            &client.library_scope,
            &current.cache_key,
            stream_id,
            version,
            &levels,
        )?;
    }
    Ok(Some(levels))
}
async fn read_cached_levels(
    db: &DbState,
    client: &PlexClient,
    binding: &Binding,
    stream: i64,
    version: &str,
) -> Result<Option<Value>, String> {
    let client = client.clone();
    let binding = binding.clone();
    let version = version.to_owned();
    db.read_urgent(move |conn| cached_levels_impl(conn, &client, &binding, stream, &version, false))
        .await
}

async fn ensure_levels(
    app: &tauri::AppHandle,
    context: &PlexRequestContext,
    binding: &Binding,
    local_only: bool,
) -> Result<Vec<crate::plex::Level>, String> {
    let Some(stream_id) = binding.metadata["mediaInfo"]["audioStreamId"]
        .as_i64()
        .filter(|id| *id > 0)
    else {
        return Ok(Vec::new());
    };
    let Some(version) = binding.metadata["localAnalysisVersion"].as_str() else {
        return Ok(Vec::new());
    };
    let downloads = app.state::<AudioDownloads>();
    let plex = app.state::<PlexState>();
    let db = app.state::<DbState>();
    let client = {
        let guard = plex.0.lock().await;
        plex.checked_cache_client(context, &guard)?.clone()
    };
    let saved = read_cached_levels(&db, &client, binding, stream_id, version).await?;
    {
        let guard = plex.0.lock().await;
        plex.checked_cache_client(context, &guard)?;
    }
    if let Some(saved) = saved {
        return decode_levels(saved);
    }
    if local_only || client.offline_only {
        return Ok(Vec::new());
    }
    // Offline/cache hits must never wait behind a network transfer. Serialize
    // misses, then recheck so simultaneous player/download requests share data.
    let _analysis = downloads.analysis.lock().await;
    {
        let guard = plex.0.lock().await;
        plex.checked_client(context, &guard)?;
    }
    if let Some(saved) = read_cached_levels(&db, &client, binding, stream_id, version).await? {
        let guard = plex.0.lock().await;
        plex.checked_client(context, &guard)?;
        return decode_levels(saved);
    }
    let raw: Value = tokio::time::timeout(
        std::time::Duration::from_secs(12),
        client.get(&format!("/library/streams/{stream_id}/levels")),
    )
    .await
    .map_err(|_| "Plex waveform request timed out")?
    .map_err(|_| "Plex waveform is unavailable")?;
    crate::db::catalogue::validate_levels(&raw)?;
    crate::catalogue_commands::save_checked(app, context, |conn| {
        crate::db::catalogue::save_levels(
            conn,
            &client.library_scope,
            &binding.cache_key,
            stream_id,
            version,
            &raw,
        )
    })
    .await?;
    decode_levels(raw)
}
fn decode_levels(raw: Value) -> Result<Vec<crate::plex::Level>, String> {
    serde_json::from_value::<crate::plex::LevelsContainer>(raw)
        .map(|container| container.levels)
        .map_err(|_| "Saved Plex waveform is invalid".into())
}

#[tauri::command]
pub async fn audio_track_levels(
    context: PlexRequestContext,
    track_id: i64,
    local_only: bool,
    app: tauri::AppHandle,
    plex: State<'_, PlexState>,
    db: State<'_, DbState>,
    downloads: State<'_, AudioDownloads>,
    engine: State<'_, crate::audio_engine::bridge::AudioEngineState>,
) -> Result<Vec<crate::plex::Level>, String> {
    id(track_id)?;
    let client = {
        let guard = plex.0.lock().await;
        plex.checked_cache_client(&context, &guard)?.clone()
    };
    let scope = client.library_scope.clone();
    let offline = client.offline_only;
    let downloaded = downloads.cache.clone();
    let automatic = engine.0.cache().clone();
    let saved = db
        .read_urgent(move |conn| {
            Ok(if local_only || offline {
                available(
                    audio::bindings(conn, &scope, track_id)?,
                    &downloaded,
                    &automatic,
                )
                .map(|(binding, _)| binding)
            } else {
                audio::latest(conn, &scope, track_id)?
            })
        })
        .await?;
    {
        let guard = plex.0.lock().await;
        plex.checked_cache_client(&context, &guard)?;
    }
    let saved = if saved
        .as_ref()
        .is_some_and(|b| b.metadata["localAnalysisVersion"].is_string())
        || local_only
        || client.offline_only
    {
        saved
    } else {
        let section = library_id(&app, &client)?;
        let (track, raw) = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            client.get_track_document(track_id),
        )
        .await
        .map_err(|_| "Plex track request timed out")?
        .map_err(|_| "Plex track is unavailable")?;
        let (binding, _, _) = binding(&client, section, track_id, &track)?;
        crate::catalogue_commands::save_checked(&app, &context, |conn| {
            audio::remember(conn, &client.library_scope, &binding, now())?;
            crate::db::catalogue::save(conn, &client.library_scope, "track", track_id, &raw, true)
        })
        .await?;
        Some(binding)
    };
    match saved {
        Some(binding) => ensure_levels(&app, &context, &binding, local_only).await,
        None => Ok(Vec::new()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadItem {
    track_id: i64,
    track: Option<Value>,
    status: String,
    received: u64,
    total: Option<u64>,
    error: Option<String>,
    available: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadPage {
    items: Vec<DownloadItem>,
    total: u64,
    downloaded_bytes: u64,
}

#[tauri::command]
pub async fn audio_download_list(
    context: PlexRequestContext,
    offset: u32,
    limit: u32,
    cached: bool,
    plex: State<'_, PlexState>,
    db: State<'_, DbState>,
    downloads: State<'_, AudioDownloads>,
    engine: State<'_, crate::audio_engine::bridge::AudioEngineState>,
) -> Result<DownloadPage, String> {
    let guard = plex.0.lock().await;
    let client = plex.checked_cache_client(&context, &guard)?;
    let conn = db.0.lock().map_err(|_| "Local audio storage unavailable")?;
    let scope = &client.library_scope;
    let mut items = Vec::new();
    let total;
    if cached {
        total = conn
            .query_row::<i64, _, _>(
                "SELECT COUNT(DISTINCT track_id) FROM local_audio WHERE scope=?1",
                [scope],
                |row| row.get(0),
            )
            .map_err(|_| "Cannot read cached tracks")?;
        let mut query=conn.prepare("SELECT track_id FROM local_audio WHERE scope=?1 GROUP BY track_id ORDER BY MAX(saved_at) DESC,track_id LIMIT ?2 OFFSET ?3").map_err(|_|"Cannot read cached tracks")?;
        let ids = query
            .query_map(
                rusqlite::params![scope, limit.clamp(1, 200), offset],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|_| "Cannot read cached tracks")?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "Cannot read cached tracks")?;
        for id in ids {
            let bindings = audio::bindings(&conn, scope, id)?;
            let latest = bindings.first().map(|b| b.metadata.clone());
            let found = available(bindings, &downloads.cache, engine.0.cache());
            items.push(DownloadItem {
                track_id: id,
                track: found.as_ref().map(|(b, _)| b.metadata.clone()).or(latest),
                status: if found.is_some() {
                    "cached"
                } else {
                    "unavailable"
                }
                .into(),
                received: 0,
                total: None,
                error: None,
                available: found.is_some(),
            });
        }
    } else {
        total = conn
            .query_row::<i64, _, _>(
                "SELECT COUNT(*) FROM audio_download_jobs WHERE scope=?1",
                [scope],
                |row| row.get(0),
            )
            .map_err(|_| "Cannot read downloads")?;
        for job in audio::jobs(&conn, scope, offset, limit)? {
            let bindings = audio::bindings(&conn, scope, job.track_id)?;
            let track = bindings
                .iter()
                .find(|b| Some(&b.cache_key) == job.cache_key.as_ref())
                .or(bindings.first())
                .map(|b| b.metadata.clone());
            let ready = job.status == "downloaded"
                && job
                    .cache_key
                    .as_ref()
                    .is_some_and(|key| downloads.cache.lookup(key).is_some());
            items.push(DownloadItem {
                track_id: job.track_id,
                track,
                status: if job.status == "downloaded" && !ready {
                    "unavailable".into()
                } else {
                    job.status
                },
                received: job.received,
                total: job.total,
                error: job.error,
                available: ready,
            });
        }
    }
    Ok(DownloadPage {
        items,
        total: total.max(0) as u64,
        downloaded_bytes: downloads.cache.stats().total_bytes,
    })
}

#[tauri::command]
pub async fn audio_local_track(
    context: PlexRequestContext,
    track_id: i64,
    plex: State<'_, PlexState>,
    db: State<'_, DbState>,
    downloads: State<'_, AudioDownloads>,
    engine: State<'_, crate::audio_engine::bridge::AudioEngineState>,
) -> Result<Option<Value>, String> {
    let guard = plex.0.lock().await;
    let client = plex.checked_cache_client(&context, &guard)?;
    let values = audio::bindings(
        &*db.0.lock().map_err(|_| "Local audio storage unavailable")?,
        &client.library_scope,
        track_id,
    )?;
    Ok(available(values, &downloads.cache, engine.0.cache()).map(|(binding, _)| binding.metadata))
}

#[tauri::command]
pub async fn audio_download_enqueue(
    context: PlexRequestContext,
    track_ids: Vec<i64>,
    plex: State<'_, PlexState>,
    db: State<'_, DbState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    enqueue_download_batch(context, track_ids, plex, db, app, None).await
}
pub(crate) async fn enqueue_download_batch(
    context: PlexRequestContext,
    track_ids: Vec<i64>,
    plex: State<'_, PlexState>,
    db: State<'_, DbState>,
    app: tauri::AppHandle,
    source: Option<(&str, i64, &str)>,
) -> Result<(), String> {
    if track_ids.is_empty() || track_ids.len() > 256 {
        return Err("Choose between 1 and 256 tracks per download batch".into());
    }
    for track in &track_ids {
        id(*track)?;
    }
    let guard = plex.0.lock().await;
    let client = plex.checked_client(&context, &guard)?;
    let conn = db.0.lock().map_err(|_| "Download storage unavailable")?;
    let track_ids = if let Some((kind, id, revision)) = source {
        crate::db::download_entities::admit(
            &conn,
            &client.library_scope,
            kind,
            id,
            revision,
            &track_ids,
        )?
    } else {
        track_ids
    };
    if track_ids.is_empty() {
        return Ok(());
    }
    // Missing completed files may be explicitly downloaded again.
    for id in &track_ids {
        if let Some(mut job) = audio::jobs_for_id(&conn, &client.library_scope, *id)? {
            if job.status == "downloaded"
                && job
                    .cache_key
                    .as_ref()
                    .is_none_or(|key| app.state::<AudioDownloads>().cache.lookup(key).is_none())
            {
                job.status = "error".into();
                audio::update(&conn, &client.library_scope, &job)?;
            }
        }
    }
    audio::enqueue(&conn, &client.library_scope, &track_ids, now())?;
    drop(conn);
    drop(guard);
    start_analysis_backfill(app.clone(), context.clone());
    start_worker(app, context);
    Ok(())
}
#[tauri::command]
pub async fn audio_download_resume(
    context: PlexRequestContext,
    plex: State<'_, PlexState>,
    db: State<'_, DbState>,
    downloads: State<'_, AudioDownloads>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let guard = plex.0.lock().await;
    let client = plex.checked_client(&context, &guard)?;
    // Do not requeue a current writer. Crash/reconnect leftovers have no live owner.
    let active = downloads
        .active
        .lock()
        .map_err(|_| "Download worker unavailable")?;
    if active
        .as_ref()
        .is_none_or(|(scope, _, _)| scope != &client.library_scope)
    {
        audio::resume(
            &*db.0.lock().map_err(|_| "Download storage unavailable")?,
            &client.library_scope,
        )?;
    }
    drop(active);
    drop(guard);
    let owner = context.clone();
    let application = app.clone();
    let downloaded = downloads.cache.clone();
    let automatic = app
        .state::<crate::audio_engine::bridge::AudioEngineState>()
        .0
        .cache()
        .clone();
    tauri::async_runtime::spawn(async move {
        let _ = crate::offline_commands::owned_write(
            &application,
            &owner,
            false,
            move |conn, scope| {
                crate::db::focused_library::maintain(conn, scope, |key| {
                    downloaded.lookup(key).is_some() || automatic.lookup(key).is_some()
                })
            },
        )
        .await;
    });
    start_analysis_backfill(app.clone(), context.clone());
    crate::download_entities::start_requested_refresh(app.clone(), context.clone());
    start_worker(app, context);
    Ok(())
}
#[tauri::command]
pub async fn audio_download_remove(
    context: PlexRequestContext,
    track_id: i64,
    plex: State<'_, PlexState>,
    db: State<'_, DbState>,
    downloads: State<'_, AudioDownloads>,
) -> Result<(), String> {
    let guard = plex.0.lock().await;
    let client = plex.checked_cache_client(&context, &guard)?;
    if let Some((scope, id, cancel)) = downloads
        .active
        .lock()
        .map_err(|_| "Download worker unavailable")?
        .as_ref()
    {
        if scope == &client.library_scope && *id == track_id {
            cancel.store(true, Ordering::Release);
        }
    }
    let conn = db.0.lock().map_err(|_| "Download storage unavailable")?;
    // Only files bound to this owner and track can be removed; no renderer paths/keys.
    for binding in audio::bindings(&conn, &client.library_scope, track_id)? {
        downloads.cache.remove(&binding.cache_key)?;
    }
    audio::remove(&conn, &client.library_scope, track_id)
}

/// Backfill existing downloads/cache entries without transferring encoded audio
/// again. Paging by ID bounds memory even after a large playlist download.
fn start_analysis_backfill(app: tauri::AppHandle, context: PlexRequestContext) {
    let downloads = app.state::<AudioDownloads>();
    let key = (context.connection_revision, context.cache_scope.clone());
    let Ok(mut scheduled) = downloads.analysis_scheduled.lock() else {
        return;
    };
    if !scheduled.insert(key.clone()) {
        return;
    }
    drop(scheduled);
    tauri::async_runtime::spawn(async move {
        if let Err(error) = backfill_analysis(&app, &context).await {
            tracing::debug!(%error,"Saved audio analysis backfill stopped");
        }
        if let Ok(mut scheduled) = app.state::<AudioDownloads>().analysis_scheduled.lock() {
            scheduled.remove(&key);
        }
    });
}
async fn backfill_analysis(
    app: &tauri::AppHandle,
    context: &PlexRequestContext,
) -> Result<(), String> {
    let plex = app.state::<PlexState>();
    let db = app.state::<DbState>();
    let downloads = app.state::<AudioDownloads>();
    let engine = app.state::<crate::audio_engine::bridge::AudioEngineState>();
    let mut cursor = 0i64;
    let mut failures = 0;
    loop {
        let (client, ids) = {
            let guard = plex.0.lock().await;
            let client = plex.checked_client(context, &guard)?.clone();
            let conn = db.0.lock().map_err(|_| "Analysis storage unavailable")?;
            let mut query = conn.prepare("SELECT DISTINCT track_id FROM local_audio WHERE scope=?1 AND track_id>?2 ORDER BY track_id LIMIT 100").map_err(|_|"Cannot read saved audio")?;
            let ids = query
                .query_map(rusqlite::params![client.library_scope, cursor], |row| {
                    row.get::<_, i64>(0)
                })
                .map_err(|_| "Cannot read saved audio")?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| "Cannot read saved audio")?;
            (client, ids)
        };
        if ids.is_empty() {
            return Ok(());
        }
        let section = library_id(app, &client)?;
        for track_id in ids {
            cursor = track_id;
            let saved = {
                let guard = plex.0.lock().await;
                plex.checked_client(context, &guard)?;
                let conn = db.0.lock().map_err(|_| "Analysis storage unavailable")?;
                let saved = available(
                    audio::bindings(&conn, &client.library_scope, track_id)?,
                    &downloads.cache,
                    engine.0.cache(),
                )
                .map(|(binding, _)| binding);
                match saved {
                    Some(binding)
                        if binding.metadata["localAnalysisVersion"].is_string()
                            && binding.metadata["mediaInfo"]["audioStreamId"]
                                .as_i64()
                                .is_none() =>
                    {
                        None
                    }
                    Some(binding) => {
                        let ready = match (
                            binding.metadata["mediaInfo"]["audioStreamId"].as_i64(),
                            binding.metadata["localAnalysisVersion"].as_str(),
                        ) {
                            (Some(stream), Some(version)) => crate::db::catalogue::levels(
                                &conn,
                                &client.library_scope,
                                &binding.cache_key,
                                stream,
                                version,
                            )?
                            .is_some(),
                            _ => false,
                        };
                        if ready {
                            None
                        } else {
                            Some(binding)
                        }
                    }
                    None => None,
                }
            };
            let Some(saved) = saved else { continue };
            let result = async {
                let (track, raw) = tokio::time::timeout(
                    std::time::Duration::from_secs(20),
                    client.get_track_document(track_id),
                )
                .await
                .map_err(|_| "Plex metadata request timed out")?
                .map_err(|_| "Plex metadata unavailable")?;
                let (fresh, _, _) = binding(&client, section, track_id, &track)?;
                // Do not attach a replacement file's analysis to an older download.
                if fresh.cache_key != saved.cache_key {
                    return Ok(());
                }
                {
                    let guard = plex.0.lock().await;
                    plex.checked_client(context, &guard)?;
                    let conn = db.0.lock().map_err(|_| "Analysis storage unavailable")?;
                    audio::remember(&conn, &client.library_scope, &fresh, now())?;
                    crate::db::catalogue::save(
                        &conn,
                        &client.library_scope,
                        "track",
                        track_id,
                        &raw,
                        true,
                    )?;
                }
                // Some files have no server analysis. Keep their full metadata
                // and continue; unavailable levels remain retryable on reconnect.
                let _ = ensure_levels(app, context, &fresh, false).await;
                Ok::<_, String>(())
            }
            .await;
            if result.is_err() {
                failures += 1;
                if failures >= 3 {
                    return Err("Plex analysis unavailable; retry on reconnect".into());
                }
            } else {
                failures = 0;
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
    }
}

fn start_worker(app: tauri::AppHandle, context: PlexRequestContext) {
    let downloads = app.state::<AudioDownloads>();
    let key = (context.connection_revision, context.cache_scope.clone());
    let Ok(mut scheduled) = downloads.scheduled.lock() else {
        return;
    };
    if !scheduled.insert(key.clone()) {
        return;
    }
    drop(scheduled);
    tauri::async_runtime::spawn(async move {
        if let Err(error) = worker(&app, &context).await {
            tracing::warn!(%error,"download queue stopped");
        }
        let downloads = app.state::<AudioDownloads>();
        if let Ok(mut scheduled) = downloads.scheduled.lock() {
            scheduled.remove(&key);
        }
        // Admission can race the last empty-queue read. Recheck after releasing
        // the scheduling flag so an accepted intention is never left dormant.
        let plex = app.state::<PlexState>();
        let guard = plex.0.lock().await;
        if let Ok(client) = plex.checked_client(&context, &guard) {
            let queued = app
                .state::<DbState>()
                .0
                .lock()
                .ok()
                .and_then(|conn| audio::next(&conn, &client.library_scope).ok())
                .flatten()
                .is_some();
            if queued {
                start_worker(app.clone(), context.clone());
            }
        }
    });
}
async fn current(app: &tauri::AppHandle, context: &PlexRequestContext) -> bool {
    let plex = app.state::<PlexState>();
    let guard = plex.0.lock().await;
    plex.checked_client(context, &guard).is_ok()
}
async fn worker(app: &tauri::AppHandle, context: &PlexRequestContext) -> Result<(), String> {
    let downloads = app.state::<AudioDownloads>();
    let worker = downloads.worker.clone();
    let _owner = worker.lock().await;
    {
        let plex = app.state::<PlexState>();
        let guard = plex.0.lock().await;
        let client = match plex.checked_client(context, &guard) {
            Ok(client) => client,
            Err(_) => return Ok(()),
        };
        // A reconnect may have waited for the previous same-scope writer to retire.
        audio::resume(
            &*app
                .state::<DbState>()
                .0
                .lock()
                .map_err(|_| "Download storage unavailable")?,
            &client.library_scope,
        )?;
    }
    loop {
        let plex = app.state::<PlexState>();
        let db = app.state::<DbState>();
        let (client, mut job, cancel) = {
            let guard = plex.0.lock().await;
            let client = match plex.checked_client(context, &guard) {
                Ok(client) => client.clone(),
                Err(_) => return Ok(()),
            };
            let conn = db.0.lock().map_err(|_| "Download storage unavailable")?;
            let Some(mut job) = audio::next(&conn, &client.library_scope)? else {
                return Ok(());
            };
            let cancel = Arc::new(AtomicBool::new(false));
            *downloads
                .active
                .lock()
                .map_err(|_| "Download worker unavailable")? =
                Some((client.library_scope.clone(), job.track_id, cancel.clone()));
            job.status = "downloading".into();
            audio::update(&conn, &client.library_scope, &job)?;
            (client, job, cancel)
        };
        let scope = &client.library_scope;
        let received = Arc::new(AtomicU64::new(0));
        let total = Arc::new(AtomicU64::new(0));
        let transfer = async {
            let section = library_id(app, &client)?;
            let (track, raw) = tokio::time::timeout(
                std::time::Duration::from_secs(30),
                client.get_track_document(job.track_id),
            )
            .await
            .map_err(|_| "Plex track request timed out")?
            .map_err(|_| "Plex could not load this track")?;
            let (binding, source, expected_size) = binding(&client, section, job.track_id, &track)?;
            if expected_size.is_some_and(|size| size > MAX_TRACK_BYTES) {
                return Err("This audio file exceeds the 2 GB per-track download limit".into());
            }
            {
                let guard = plex.0.lock().await;
                plex.checked_client(context, &guard)?;
                audio::remember(
                    &*db.0.lock().map_err(|_| "Download storage unavailable")?,
                    scope,
                    &binding,
                    now(),
                )?;
                crate::db::catalogue::save(
                    &*db.0.lock().map_err(|_| "Download storage unavailable")?,
                    scope,
                    "track",
                    job.track_id,
                    &raw,
                    true,
                )?;
            }
            // Optional analysis cannot prevent a valid audio file being saved.
            let _ = ensure_levels(app, context, &binding, false).await;
            if let Some(file) = downloads.cache.open(&binding.cache_key) {
                if let Ok(metadata) = file.metadata() {
                    received.store(metadata.len(), Ordering::Release);
                    total.store(metadata.len(), Ordering::Release);
                    return Ok(binding);
                }
            }
            let cache = downloads.cache.clone();
            let automatic = app
                .state::<crate::audio_engine::bridge::AudioEngineState>()
                .0
                .cache()
                .clone();
            let writer = stage_download(
                &source,
                expected_size,
                track.duration as u64,
                &cache,
                &automatic,
                &cancel,
                &received,
                &total,
            )
            .await?;
            // Cancellation, disconnect, and a remove/re-add must not publish old work.
            let guard = plex.0.lock().await;
            plex.checked_client(context, &guard)?;
            let conn = db.0.lock().map_err(|_| "Download storage unavailable")?;
            if cancel.load(Ordering::Acquire)
                || audio::jobs_for_id(&conn, scope, job.track_id)?
                    .is_none_or(|fresh| fresh.revision != job.revision)
            {
                return Err("Download cancelled".into());
            }
            writer.finish(&cache)?;
            Ok::<_, String>(binding)
        };
        tokio::pin!(transfer);
        let outcome = loop {
            tokio::select! {
                result=&mut transfer=>break Some(result),
                _=tokio::time::sleep(std::time::Duration::from_millis(250))=> {
                    if cancel.load(Ordering::Acquire)||!current(app,context).await {cancel.store(true,Ordering::Release);break None;}
                    let mut progress=job.clone();progress.received=received.load(Ordering::Acquire);progress.total=match total.load(Ordering::Acquire){0=>None,length=>Some(length)};
                    if let Ok(conn)=db.0.lock(){let _=audio::update(&conn,scope,&progress);}
                }
            }
        };
        job.received = received.load(Ordering::Acquire);
        job.total = match total.load(Ordering::Acquire) {
            0 => None,
            length => Some(length),
        };
        let connected = current(app, context).await;
        match outcome {
            Some(Ok(binding)) => {
                job.status = "downloaded".into();
                job.cache_key = Some(binding.cache_key);
                job.error = None;
            }
            Some(Err(error)) if connected => {
                job.status = "error".into();
                tracing::debug!(track_id=job.track_id,%error,"Plex download could not be validated");
                job.error = Some(if error.starts_with("Downloaded audio failed validation") {
                    "Plex's audio file contains damaged frames or does not match its reported duration. Check the file or choose another version.".into()
                } else {
                    "Could not download this track. Check Plex and available storage, then retry."
                        .into()
                });
            }
            _ => {
                job.status = "paused".into();
                job.error = None;
            }
        }
        if let Ok(conn) = db.0.lock() {
            let _ = audio::update(&conn, scope, &job);
        }
        *downloads
            .active
            .lock()
            .map_err(|_| "Download worker unavailable")? = None;
        if !connected {
            return Ok(());
        }
    }
}

/// Stage and validate outside all connection/SQLite locks. Publication belongs to
/// the caller, after rechecking both connection revision and durable job revision.
async fn stage_download(
    source: &MediaSource,
    expected_size: Option<u64>,
    duration: u64,
    cache: &Arc<AudioCache>,
    automatic: &Arc<AudioCache>,
    cancel: &Arc<AtomicBool>,
    received: &Arc<AtomicU64>,
    total: &Arc<AtomicU64>,
) -> Result<crate::audio_engine::cache::CacheWriter, String> {
    if let Some(mut file) = automatic.open(&source.cache_key) {
        let size = file
            .metadata()
            .map_err(|_| "Cannot read cached audio")?
            .len();
        if size <= MAX_TRACK_BYTES {
            let mut writer = cache.begin_write(&source.cache_key, &source.extension)?;
            let extension = source.extension.clone();
            let cancellation = cancel.clone();
            let progress = received.clone();
            total.store(size, Ordering::Release);
            let copy = tauri::async_runtime::spawn_blocking(move || {
                use std::io::Read;
                let mut chunk = [0u8; 64 * 1024];
                loop {
                    if cancellation.load(Ordering::Acquire) {
                        return Err("Download cancelled".into());
                    }
                    let length = file
                        .read(&mut chunk)
                        .map_err(|_| "Cannot read cached audio")?;
                    if length == 0 {
                        break;
                    }
                    let count = progress
                        .load(Ordering::Acquire)
                        .checked_add(length as u64)
                        .ok_or("Audio size overflow")?;
                    if count > size || count > MAX_TRACK_BYTES {
                        return Err("Cached audio changed during download".into());
                    }
                    writer.write_chunk(&chunk[..length])?;
                    progress.store(count, Ordering::Release);
                }
                validate_audio(
                    writer.validation_file()?,
                    &extension,
                    duration,
                    &cancellation,
                )?;
                Ok::<_, String>(writer)
            })
            .await
            .map_err(|_| "Cached audio validation worker failed")?;
            if let Ok(writer) = copy {
                return Ok(writer);
            }
            // A corrupt automatic cache must not prevent a fresh download.
            if cancel.load(Ordering::Acquire) {
                return Err("Download cancelled".into());
            }
            received.store(0, Ordering::Release);
            total.store(0, Ordering::Release);
        }
    }
    let mut writer = cache.begin_write(&source.cache_key, &source.extension)?;
    let body = source
        .request
        .as_ref()
        .ok_or("Download has no media source")?;
    crate::audio_engine::download::download(
        || body.try_clone().expect("native GET is cloneable"),
        |length| {
            total.store(length, Ordering::Release);
        },
        |chunk| {
            if cancel.load(Ordering::Acquire) {
                return Err("Download cancelled".into());
            }
            let count = received
                .load(Ordering::Acquire)
                .checked_add(chunk.len() as u64)
                .ok_or("Audio size overflow")?;
            if count > MAX_TRACK_BYTES || total.load(Ordering::Acquire) > MAX_TRACK_BYTES {
                return Err("Audio file is too large".into());
            }
            writer.write_chunk(chunk)?;
            received.store(count, Ordering::Release);
            Ok(())
        },
    )
    .await?;
    // Plex's database size can be stale after tag/file updates. The HTTP
    // transfer validates its own length, ranges and overlap; full decoding
    // below still rejects truncation, corruption and a different duration.
    if expected_size.is_some_and(|reported| reported != received.load(Ordering::Acquire)) {
        tracing::debug!(
            reported_bytes = expected_size,
            received_bytes = received.load(Ordering::Acquire),
            "Plex catalogue size differs from the completed media response"
        );
    }
    let file = writer.validation_file()?;
    let extension = source.extension.clone();
    let cancellation = cancel.clone();
    tauri::async_runtime::spawn_blocking(move || {
        validate_audio(file, &extension, duration, &cancellation)
    })
    .await
    .map_err(|_| "Audio validation worker failed")??;
    Ok(writer)
}

fn validate_audio(
    file: std::fs::File,
    extension: &str,
    duration: u64,
    cancel: &AtomicBool,
) -> Result<(), String> {
    use crate::audio_engine::deck::decode;
    let mss = symphonia::core::io::MediaSourceStream::new(Box::new(file), Default::default());
    let mut setup = decode::probe_from_source(mss, Some(extension))
        .map_err(|_| "Downloaded audio format is unsupported")?;
    let mut samples = 0u64;
    while !setup.finished {
        if cancel.load(Ordering::Acquire) {
            return Err("Download cancelled".into());
        }
        let batch = decode::decode_batch_interruptible(&mut setup, 32768, || {
            cancel.load(Ordering::Acquire)
        })
        .map_err(|_| "Downloaded audio could not be decoded")?;
        samples = samples
            .checked_add(batch.len() as u64)
            .ok_or("Audio duration overflow")?;
    }
    let actual = samples.saturating_mul(1000)
        / (setup.sample_rate as u64 * setup.channels.max(1) as u64).max(1);
    let tolerance = 2000.max(duration / 50);
    if setup.aborted
        || setup.had_decode_errors
        || samples == 0
        || actual.abs_diff(duration) > tolerance
    {
        return Err(format!("Downloaded audio failed validation (decoded {actual} ms, expected {duration} ms, aborted {}, invalid frames {})",setup.aborted,setup.had_decode_errors));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plex::{
        models::{Media, MediaPart, PlexStream},
        PlexClientConfig,
    };
    struct LoudnessServer {
        address: String,
        puts: Arc<AtomicU64>,
        gets: Arc<AtomicU64>,
        stop: Arc<AtomicBool>,
        worker: Option<std::thread::JoinHandle<()>>,
    }
    impl Drop for LoudnessServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            self.worker.take().unwrap().join().unwrap();
        }
    }
    fn loudness_server(status: u16, part: i64) -> LoudnessServer {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let puts = Arc::new(AtomicU64::new(0));
        let gets = Arc::new(AtomicU64::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let (p, g, s) = (puts.clone(), gets.clone(), stop.clone());
        let worker = std::thread::spawn(move || {
            while !s.load(Ordering::Acquire) {
                let Ok((mut socket, _)) = listener.accept() else {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                    continue;
                };
                socket
                    .set_read_timeout(Some(std::time::Duration::from_secs(1)))
                    .unwrap();
                let mut request = Vec::new();
                let mut chunk = [0; 4096];
                while !request.windows(4).any(|v| v == b"\r\n\r\n") {
                    match socket.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => request.extend_from_slice(&chunk[..n]),
                    }
                    assert!(request.len() < 16384);
                }
                // A cancelled client can close a pooled connection before
                // sending headers; it is not an unexpected API request.
                if request.is_empty() {
                    continue;
                }
                let request = String::from_utf8(request).unwrap();
                let (code, body) = if request.starts_with("PUT ") {
                    assert!(request
                        .lines()
                        .next()
                        .unwrap()
                        .contains("/library/metadata/42/analyzeLoudness?force=0&manual=1"));
                    p.fetch_add(1, Ordering::SeqCst);
                    (status, String::new())
                } else {
                    assert!(request.starts_with("GET /library/metadata/42?"));
                    g.fetch_add(1, Ordering::SeqCst);
                    (200,json!({"MediaContainer":{"Metadata":[{"type":"track","ratingKey":42,"librarySectionID":1,"duration":1000,"Media":[{"audioCodec":"wav","Part":[{"id":part,"key":format!("/library/parts/{part}/file.wav"),"Stream":[{"id":17,"streamType":2,"gain":-9.0,"albumGain":-11.0}]}]}]}]}}).to_string())
                };
                write!(socket,"HTTP/1.1 {code} Result\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
        });
        LoudnessServer {
            address,
            puts,
            gets,
            stop,
            worker: Some(worker),
        }
    }
    async fn loudness_fixture(
        server: &LoudnessServer,
    ) -> (PlexClient, PlexState, PlexRequestContext, Track) {
        let mut client = PlexClient::new(PlexClientConfig {
            base_url: server.address.clone(),
            token: "fixture-token".into(),
            ..Default::default()
        })
        .unwrap();
        client.library_scope = client.cache_scope_for_library(1, Some("fixture"));
        let context = PlexRequestContext {
            cache_scope: client.library_scope.clone(),
            connection_revision: 0,
        };
        let plex = PlexState::new();
        *plex.0.lock().await = Some(client.clone());
        let mut track = track();
        track.media[0].parts[0].streams[0].gain = None;
        (client, plex, context, track)
    }
    #[tokio::test]
    async fn server_loudness_preparation_is_single_attempt_and_returns_fresh_gain_before_dispatch()
    {
        let server = loudness_server(200, 10);
        let (client, plex, context, track) = loudness_fixture(&server).await;
        let directory = tempfile::tempdir().unwrap();
        let downloads = AudioDownloads::new(directory.path().to_owned());
        for _ in 0..2 {
            let (prepared, _) = prepare_server_loudness(
                &client,
                &context,
                &plex,
                &downloads,
                1,
                (track.clone(), json!({})),
                || true,
                |_| false,
            )
            .await
            .unwrap();
            let binding = binding(&client, 1, 42, &prepared).unwrap().0;
            assert_eq!(binding.metadata["gain"], -9.0);
            assert_eq!(
                info(&binding, context.clone(), "fixture".into()).album_gain,
                Some(-11.0)
            );
        }
        assert_eq!(server.puts.load(Ordering::SeqCst), 1);
        assert_eq!(server.gets.load(Ordering::SeqCst), 2);
    }
    #[tokio::test]
    async fn server_loudness_fast_paths_and_unavailable_endpoint_leave_native_fallback_intact() {
        let server = loudness_server(404, 10);
        let (client, plex, context, track) = loudness_fixture(&server).await;
        let directory = tempfile::tempdir().unwrap();
        let downloads = AudioDownloads::new(directory.path().to_owned());
        let off = prepare_server_loudness(
            &client,
            &context,
            &plex,
            &downloads,
            1,
            (track.clone(), json!({})),
            || false,
            |_| false,
        )
        .await
        .unwrap();
        assert!(off.0.media[0].parts[0].streams[0].gain.is_none());
        prepare_server_loudness(
            &client,
            &context,
            &plex,
            &downloads,
            1,
            (track.clone(), json!({})),
            || true,
            |_| true,
        )
        .await
        .unwrap();
        let mut known = track.clone();
        known.media[0].parts[0].streams[0].gain = Some(0.0);
        prepare_server_loudness(
            &client,
            &context,
            &plex,
            &downloads,
            1,
            (known, json!({})),
            || true,
            |_| false,
        )
        .await
        .unwrap();
        assert_eq!(server.puts.load(Ordering::SeqCst), 0);
        let fallback = prepare_server_loudness(
            &client,
            &context,
            &plex,
            &downloads,
            1,
            (track, json!({})),
            || true,
            |_| false,
        )
        .await
        .unwrap();
        assert!(fallback.0.media[0].parts[0].streams[0].gain.is_none());
        assert_eq!(server.puts.load(Ordering::SeqCst), 1);
        assert_eq!(server.gets.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn server_loudness_rejects_replaced_files_and_retired_native_owners() {
        let server = loudness_server(200, 11);
        let (client, plex, context, track) = loudness_fixture(&server).await;
        let directory = tempfile::tempdir().unwrap();
        let downloads = AudioDownloads::new(directory.path().to_owned());
        assert!(prepare_server_loudness(
            &client,
            &context,
            &plex,
            &downloads,
            1,
            (track.clone(), json!({})),
            || true,
            |_| false
        )
        .await
        .unwrap_err()
        .contains("changed"));
        *plex.0.lock().await = None;
        assert!(prepare_server_loudness(
            &client,
            &context,
            &plex,
            &downloads,
            1,
            (track, json!({})),
            || true,
            |_| false
        )
        .await
        .is_err());
        assert_eq!(server.puts.load(Ordering::SeqCst), 1);
    }
    fn client() -> PlexClient {
        let mut client = PlexClient::new(PlexClientConfig {
            base_url: "http://127.0.0.1:1".into(),
            token: "fixture-private-token".into(),
            ..Default::default()
        })
        .unwrap();
        client.machine_identifier = "fixture-server".into();
        client.library_scope = client.cache_scope_for_library(1, Some("fixture-library"));
        client
    }
    fn track() -> Track {
        Track {
            rating_key: 42,
            library_section_id: 1,
            duration: 1000,
            title: "Fixture song".into(),
            grandparent_title: "Fixture artist".into(),
            parent_title: "Fixture album".into(),
            parent_key: "/library/metadata/2".into(),
            media: vec![Media {
                audio_codec: Some("wav".into()),
                parts: vec![MediaPart {
                    id: 10,
                    key: "/library/parts/10/file.wav".into(),
                    file: Some("/private/server/music.wav".into()),
                    streams: vec![PlexStream {
                        stream_type: Some(2),
                        gain: Some(-3.0),
                        ..Default::default()
                    }],
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        }
    }
    fn wav() -> Vec<u8> {
        let length = 16000u32;
        let mut wav = Vec::new();
        wav.extend(b"RIFF");
        wav.extend((36 + length).to_le_bytes());
        wav.extend(b"WAVEfmt ");
        wav.extend(16u32.to_le_bytes());
        wav.extend(1u16.to_le_bytes());
        wav.extend(1u16.to_le_bytes());
        wav.extend(8000u32.to_le_bytes());
        wav.extend(16000u32.to_le_bytes());
        wav.extend(2u16.to_le_bytes());
        wav.extend(16u16.to_le_bytes());
        wav.extend(b"data");
        wav.extend(length.to_le_bytes());
        for frame in 0..8000 {
            wav.extend((((frame as f32 * 0.1).sin() * 1000.0) as i16).to_le_bytes());
        }
        wav
    }
    #[test]
    fn native_binding_checks_library_identity_and_never_persists_private_paths_or_tokens() {
        let client = client();
        let track = track();
        let (saved, source, _) = binding(&client, 1, 42, &track).unwrap();
        let payload = serde_json::to_string(&saved).unwrap();
        assert!(!payload.contains("private-token"));
        assert!(!payload.contains("/private/server"));
        assert!(!payload.contains("127.0.0.1"));
        assert_eq!(saved.cache_key, source.cache_key);
        assert_eq!(saved.metadata["gain"], -3.0);
        assert!(binding(&client, 2, 42, &track).is_err());
        assert!(binding(&client, 1, 99, &track).is_err());
        let mut forged = track.clone();
        forged.media[0].parts[0].key = "https://other.test/audio.wav".into();
        assert!(binding(&client, 1, 42, &forged).is_err());
        forged.media[0].parts[0].key = "/library/parts/10/file.wav?X-Plex-Token=forged".into();
        assert!(binding(&client, 1, 42, &forged).is_err());
    }

    #[test]
    fn analysis_revision_follows_the_media_and_server_analysis_without_losing_stream_identity() {
        let client = client();
        let mut track = track();
        track.media[0].parts[0].streams[0].id = Some(17);
        let first = binding(&client, 1, 42, &track).unwrap().0;
        assert_eq!(first.metadata["mediaInfo"]["audioStreamId"], 17);
        track.music_analysis_version = Some(1);
        let analyzed = binding(&client, 1, 42, &track).unwrap().0;
        assert_ne!(
            first.metadata["localAnalysisVersion"],
            analyzed.metadata["localAnalysisVersion"]
        );
        assert_eq!(first.cache_key, analyzed.cache_key);
        track.updated_at = chrono::DateTime::from_timestamp(1234567890, 0);
        track.title = "Metadata-only edit".into();
        let edited = binding(&client, 1, 42, &track).unwrap().0;
        assert_eq!(
            analyzed.metadata["localAnalysisVersion"],
            edited.metadata["localAnalysisVersion"]
        );
        assert_eq!(analyzed.cache_key, edited.cache_key);
        track.media[0].parts[0].streams[0].gain = Some(-6.0);
        let changed = binding(&client, 1, 42, &track).unwrap().0;
        assert_ne!(
            analyzed.metadata["localAnalysisVersion"],
            changed.metadata["localAnalysisVersion"]
        );
        track.media[0].parts[0].key = "/library/parts/10/replacement.wav".into();
        assert_ne!(
            changed.cache_key,
            binding(&client, 1, 42, &track).unwrap().0.cache_key
        );
    }
    #[test]
    fn cached_levels_adopts_only_the_exact_legacy_source_stream_and_analysis_revision() {
        use sha2::{Digest, Sha256};
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        let client = client();
        let raw = json!({"type":"track","ratingKey":"42","librarySectionID":1,"duration":1000,"updatedAt":12345,"musicAnalysisVersion":1,"Media":[{"audioCodec":"wav","Part":[{"id":10,"key":"/library/parts/10/file.wav","Stream":[{"id":17,"streamType":2,"gain":-3.0}]}]}]});
        let track: Track = serde_json::from_value(raw.clone()).unwrap();
        let current = binding(&client, 1, 42, &track).unwrap().0;
        let version = current.metadata["localAnalysisVersion"].as_str().unwrap();
        let legacy = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(
                    best_media(&track).unwrap(),
                    track.music_analysis_version,
                    track.updated_at
                ))
                .unwrap()
            )
        );
        let levels = json!({"Level":[{"v":0.4},{"v":0.8}],"futureField":"retained"});
        crate::db::catalogue::save(&conn, &client.library_scope, "track", 42, &raw, true).unwrap();
        crate::db::catalogue::save_levels(
            &conn,
            &client.library_scope,
            &current.cache_key,
            17,
            &legacy,
            &levels,
        )
        .unwrap();
        assert!(cached_levels(&conn, &client, &current, 18, version)
            .unwrap()
            .is_none());
        let mut foreign = client.clone();
        foreign.library_scope = format!("plex-{}", "b".repeat(64));
        assert!(cached_levels(&conn, &foreign, &current, 17, version)
            .unwrap()
            .is_none());
        let mut different = track.clone();
        different.media[0].parts[0].streams[0].gain = Some(-6.0);
        let changed = binding(&client, 1, 42, &different).unwrap().0;
        assert!(cached_levels(
            &conn,
            &client,
            &changed,
            17,
            changed.metadata["localAnalysisVersion"].as_str().unwrap()
        )
        .unwrap()
        .is_none());
        assert_eq!(
            cached_levels(&conn, &client, &current, 17, version).unwrap(),
            Some(levels.clone())
        );
        assert_eq!(
            crate::db::catalogue::levels(
                &conn,
                &client.library_scope,
                &current.cache_key,
                17,
                version
            )
            .unwrap(),
            Some(levels)
        );
    }
    #[test]
    fn media_selection_matches_frontend_quality_order_and_keeps_first_equal_quality_version() {
        let mut track = track();
        track.media[0].audio_codec = Some("mp3".into());
        track.media[0].id = 1;
        let mut lossless = track.media[0].clone();
        lossless.id = 2;
        lossless.audio_codec = Some("flac".into());
        lossless.parts[0].streams[0].bit_depth = Some(24);
        lossless.parts[0].streams[0].sampling_rate = Some(96000);
        track.media.push(lossless.clone());
        lossless.id = 3;
        track.media.push(lossless);
        assert_eq!(best_media(&track).unwrap().id, 2);
        track.media[1].parts.clear();
        assert_eq!(best_media(&track).unwrap().id, 3);
        track.media[2].parts.clear();
        assert_eq!(best_media(&track).unwrap().id, 1);
    }
    #[tokio::test]
    async fn local_admission_has_no_http_request_and_rejects_wrong_owner_missing_files_and_revoked_sessions(
    ) {
        let dir = tempfile::tempdir().unwrap();
        let db = DbState::open(&dir.path().join("test.sqlite")).unwrap();
        let downloads = AudioDownloads::new(dir.path().join("downloads"));
        let automatic = Arc::new(AudioCache::new(dir.path().join("cache"), None));
        let client = client();
        let (saved, _, _) = binding(&client, 1, 42, &track()).unwrap();
        let scope = client.library_scope.clone();
        audio::remember(&db.0.lock().unwrap(), &scope, &saved, 1).unwrap();
        let mut writer = downloads
            .cache
            .begin_write(&saved.cache_key, "wav")
            .unwrap();
        writer.write_chunk(&wav()).unwrap();
        writer.finish(&downloads.cache).unwrap();
        let plex = PlexState::new();
        *plex.0.lock().await = Some(client);
        let context = PlexRequestContext {
            connection_revision: 0,
            cache_scope: scope,
        };
        let result = dispatch(
            &plex,
            &db,
            &downloads,
            &automatic,
            Some(&context),
            "hibiki-local://track/42",
            42,
            |source| {
                assert!(source.request.is_none());
                assert!(Arc::ptr_eq(
                    source.local_cache.as_ref().unwrap(),
                    &downloads.cache
                ));
                Ok(7)
            },
        )
        .await
        .unwrap();
        assert_eq!(result, 7);
        let mut other = context.clone();
        other.cache_scope = format!("plex-{}", "b".repeat(64));
        assert!(dispatch(
            &plex,
            &db,
            &downloads,
            &automatic,
            Some(&other),
            "hibiki-local://track/42",
            42,
            |_| panic!("wrong owner")
        )
        .await
        .is_err());
        assert!(dispatch(
            &plex,
            &db,
            &downloads,
            &automatic,
            None,
            "hibiki-local://track/42",
            42,
            |_| panic!("unowned source")
        )
        .await
        .is_err());
        automatic.clear().unwrap();
        assert!(downloads.cache.lookup(&saved.cache_key).is_some());
        downloads.cache.remove(&saved.cache_key).unwrap();
        assert!(dispatch(
            &plex,
            &db,
            &downloads,
            &automatic,
            Some(&context),
            "hibiki-local://track/42",
            42,
            |_| panic!("missing file")
        )
        .await
        .is_err());
        other = context.clone();
        other.connection_revision = 1;
        assert!(dispatch(
            &plex,
            &db,
            &downloads,
            &automatic,
            Some(&other),
            "hibiki-local://track/42",
            42,
            |_| panic!("old session")
        )
        .await
        .is_err());
    }
    #[tokio::test]
    async fn cached_copy_is_validated_and_persistent_downloads_survive_automatic_eviction_and_restart(
    ) {
        let dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(AudioCache::new(dir.path().join("downloads"), Some(0)));
        let automatic = Arc::new(AudioCache::new(dir.path().join("cache"), None));
        let (_, source, _) = binding(&client(), 1, 42, &track()).unwrap();
        let data = wav();
        let mut writer = automatic.begin_write(&source.cache_key, "wav").unwrap();
        writer.write_chunk(&data).unwrap();
        writer.finish(&automatic).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let received = Arc::new(AtomicU64::new(0));
        let total = Arc::new(AtomicU64::new(0));
        let writer = stage_download(
            &source,
            Some(data.len() as u64),
            1000,
            &cache,
            &automatic,
            &cancel,
            &received,
            &total,
        )
        .await
        .unwrap();
        assert!(
            cache.lookup(&source.cache_key).is_none(),
            "staged body is not yet an available download"
        );
        writer.finish(&cache).unwrap();
        automatic.set_max_bytes(1).unwrap();
        assert!(automatic.lookup(&source.cache_key).is_none());
        assert_eq!(
            std::fs::read(cache.lookup(&source.cache_key).unwrap()).unwrap(),
            data
        );
        drop(cache);
        let reopened = AudioCache::new(dir.path().join("downloads"), Some(0));
        assert!(reopened.lookup(&source.cache_key).is_some());
    }
    #[test]
    fn audio_validation_rejects_truncation_corruption_duration_mismatch_and_cancelled_work() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fixture.wav");
        let data = wav();
        let cancel = AtomicBool::new(false);
        std::fs::write(&path, &data).unwrap();
        validate_audio(std::fs::File::open(&path).unwrap(), "wav", 1000, &cancel).unwrap();
        assert!(
            validate_audio(std::fs::File::open(&path).unwrap(), "wav", 30000, &cancel).is_err()
        );
        std::fs::write(&path, &data[..data.len() / 2]).unwrap();
        assert!(validate_audio(std::fs::File::open(&path).unwrap(), "wav", 1000, &cancel).is_err());
        std::fs::write(&path, b"not audio").unwrap();
        assert!(validate_audio(std::fs::File::open(&path).unwrap(), "wav", 1000, &cancel).is_err());
        std::fs::write(&path, &data).unwrap();
        cancel.store(true, Ordering::Release);
        assert!(validate_audio(std::fs::File::open(&path).unwrap(), "wav", 1000, &cancel).is_err());
    }

    #[test]
    #[ignore = "explicit local media validation proof; no user files read by default"]
    fn validate_private_audio_fixture() {
        let file = std::env::var("HIBIKI_VALIDATION_FILE").expect("explicit fixture file");
        let extension = std::env::var("HIBIKI_VALIDATION_FORMAT").expect("explicit fixture format");
        let duration = std::env::var("HIBIKI_VALIDATION_DURATION_MS")
            .expect("explicit fixture duration")
            .parse()
            .unwrap();
        let result = validate_audio(
            std::fs::File::open(file).unwrap(),
            &extension,
            duration,
            &AtomicBool::new(false),
        );
        let valid = std::env::var("HIBIKI_VALIDATION_VALID").map_or(true, |value| value == "true");
        assert_eq!(result.is_ok(), valid, "{result:?}");
    }
    #[tokio::test]
    async fn http_downloads_validate_actual_audio_even_when_plex_file_size_is_stale() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for (corrupt, wrong_size) in [(false, false), (true, false), (false, true)] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let data = if corrupt { vec![0u8; 16044] } else { wav() };
            let size = data.len() as u64;
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut header = Vec::new();
                while !header.ends_with(b"\r\n\r\n") {
                    header.push(socket.read_u8().await.unwrap());
                    assert!(header.len() < 16384);
                }
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            data.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
                socket.write_all(&data).await.unwrap();
            });
            let dir = tempfile::tempdir().unwrap();
            let downloads = Arc::new(AudioCache::new(dir.path().join("downloads"), Some(0)));
            let automatic = Arc::new(AudioCache::new(dir.path().join("cache"), None));
            let source = MediaSource::new(
                reqwest::Client::new().get(format!("http://{address}/file.wav")),
                None,
            )
            .unwrap();
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                stage_download(
                    &source,
                    Some(size + u64::from(wrong_size)),
                    1000,
                    &downloads,
                    &automatic,
                    &Arc::new(AtomicBool::new(false)),
                    &Arc::new(AtomicU64::new(0)),
                    &Arc::new(AtomicU64::new(0)),
                ),
            )
            .await
            .expect("download/validation must terminate");
            server.await.unwrap();
            assert!(downloads.lookup(&source.cache_key).is_none());
            if corrupt {
                assert!(result.is_err());
                assert_eq!(downloads.stats().total_bytes, 0);
            } else {
                result.unwrap().finish(&downloads).unwrap();
                assert!(downloads.lookup(&source.cache_key).is_some());
            }
        }
    }
}

#[tauri::command]
pub async fn audio_availability(
    context: PlexRequestContext,
    track_ids: Vec<i64>,
    plex: State<'_, PlexState>,
    db: State<'_, DbState>,
    downloads: State<'_, AudioDownloads>,
    engine: State<'_, crate::audio_engine::bridge::AudioEngineState>,
) -> Result<Vec<i64>, String> {
    if track_ids.len() > 10000 || track_ids.iter().any(|id| *id <= 0) {
        return Err("Invalid availability batch".into());
    }
    let guard = plex.0.lock().await;
    let client = plex.checked_cache_client(&context, &guard)?;
    let conn = db.0.lock().map_err(|_| "Local audio storage unavailable")?;
    let mut result = Vec::new();
    for id in track_ids {
        if available(
            audio::bindings(&conn, &client.library_scope, id)?,
            &downloads.cache,
            engine.0.cache(),
        )
        .is_some()
        {
            result.push(id);
        }
    }
    Ok(result)
}
