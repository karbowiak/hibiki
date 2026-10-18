//! Only the opaque video identity crosses IPC. Stream credentials are resolved
//! under the audio engine's request ownership, including preload cancellation.
use super::*;
use crate::audio_engine::source::MediaSource;
use sha2::{Digest, Sha256};

pub(crate) fn cache_owner(app: &tauri::AppHandle) -> Result<String, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|_| "YouTube Music cache settings unavailable.")?
        .join("youtube-music-cache-owner");
    if let Ok(value) = std::fs::read_to_string(&path) {
        return uuid::Uuid::parse_str(value.trim())
            .map(|id| id.to_string())
            .map_err(|_| {
                "YouTube Music cache settings are invalid. Disconnect and sign in again.".into()
            });
    }
    std::fs::create_dir_all(path.parent().unwrap())
        .map_err(|_| "Could not prepare YouTube Music cache settings.")?;
    let owner = uuid::Uuid::new_v4().to_string();
    let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap())
        .map_err(|_| "Could not prepare YouTube Music cache settings.")?;
    use std::io::Write;
    file.write_all(owner.as_bytes())
        .map_err(|_| "Could not save YouTube Music cache settings.")?;
    match file.persist_noclobber(&path) {
        Ok(_) => Ok(owner),
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => cache_owner(app),
        Err(_) => Err("Could not save YouTube Music cache settings.".into()),
    }
}

pub(super) fn forget_cache_owner(app: &tauri::AppHandle) {
    if let Ok(path) = app.path().app_config_dir() {
        let _ = std::fs::remove_file(path.join("youtube-music-cache-owner"));
    }
}

pub(crate) fn cache_key(owner: &str, video_id: &str) -> String {
    // Container-neutral best supported/reachable audio. Old temporary M4A cache
    // entries cannot pin this policy to the previous lower-quality selection.
    format!(
        "s1-{}",
        hex::encode(Sha256::digest(format!(
            "hibiki-ytmusic-best-audio-v2\0{owner}\0{video_id}"
        )))
    )
}

fn video_id(source: &str) -> Result<&str, String> {
    source
        .strip_prefix("ytmusic:")
        .filter(|id| api::valid_video_id(id))
        .ok_or_else(|| "Choose a valid YouTube Music song.".into())
}

pub(crate) fn valid_track_id(source: &str) -> bool {
    video_id(source).is_ok()
}

pub(crate) fn source(
    app: &tauri::AppHandle,
    url: &str,
    track_key: i64,
    has_plex_context: bool,
) -> Result<MediaSource, String> {
    let id = video_id(url)?.to_owned();
    if track_key >= 0 || has_plex_context {
        return Err("YouTube Music playback requires its own track identity.".into());
    }
    let key = cache_key(&cache_owner(app)?, &id);
    // Explicit audio is durable and can play before a remote session refresh.
    let downloads = app.state::<crate::offline_audio::AudioDownloads>().cache();
    if let Some(path) = downloads.lookup(&key) {
        return Ok(MediaSource::cached(key, path.extension().and_then(|ext| ext.to_str()).unwrap_or("dat").into(),
            crate::provider_downloads::youtube_scope(app)?, downloads));
    }
    let generation = app.state::<Arc<YoutubeMusic>>().generation()?;
    let cache = app
        .state::<crate::audio_engine::bridge::AudioEngineState>()
        .0
        .cache()
        .clone();
    let app = app.clone();
    let resolved_key = key.clone();
    let resolved_cache = cache.clone();
    let mut source = MediaSource::deferred(key, move || {
        let app = app.clone();
        let id = id.clone();
        let key = resolved_key.clone();
        let cache = resolved_cache.clone();
        Box::pin(async move {
            let state = app.state::<Arc<YoutubeMusic>>();
            if !state.owns(generation) {
                return Err("YouTube Music session changed.".into());
            }
            let (resolved_generation, stream) = extractor::resolve(&app, &id).await?;
            if generation != resolved_generation || !state.owns(generation) {
                return Err("YouTube Music session changed.".into());
            }
            let mut source = MediaSource::new(
                extractor::media_client()?
                    .get(stream.url)
                    .headers(stream.headers),
                None,
            )?;
            source.extension = stream.extension;
            source.gain_db = stream.gain_db;
            source.prepare_waveform = true;
            source.cache_key = key;
            source.local_cache = Some(cache);
            Ok(source)
        })
    });
    source.local_cache = Some(cache);
    source.prepare_waveform = true;
    Ok(source)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opaque_sources_accept_only_a_single_video_identity() {
        assert_eq!(video_id("ytmusic:abcdefghijk").unwrap(), "abcdefghijk");
        for source in [
            "https://music.youtube.com/watch?v=abcdefghijk",
            "ytmusic:abcdefghijk?token=private",
            "ytmusic://abcdefghijk",
            "ytmusic:../../secret",
            "ytmusic:short",
        ] {
            assert!(video_id(source).is_err());
        }
    }
    #[test]
    fn stable_cache_identity_ignores_stream_signatures_but_separates_connections_and_songs() {
        assert_eq!(
            cache_key("same-owner", "abcdefghijk"),
            cache_key("same-owner", "abcdefghijk")
        );
        assert_ne!(
            cache_key("same-owner", "abcdefghijk"),
            cache_key("new-owner", "abcdefghijk")
        );
        assert_ne!(
            cache_key("same-owner", "abcdefghijk"),
            cache_key("same-owner", "lmnopqrstuv")
        );
    }
}
