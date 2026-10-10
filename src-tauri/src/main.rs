// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio_devices;
mod audio_engine;
mod commands;
mod db;
mod deezer;
mod genius;
mod itunes;
mod itunes_throttle;
mod lastfm;
mod listenbrainz;
mod mediasession;
mod musicbrainz;
mod plex;
mod plextv;
mod podcast;
mod podcastindex;
mod radiobrowser;

use commands::PlexState;
use mediasession::MediaSessionState;
use once_cell::sync::Lazy;
use tauri::Manager;
use tauri_plugin_window_state::{StateFlags, WindowExt};

// ---------------------------------------------------------------------------
// Image cache — persistent disk cache for all images.
//
// The frontend uses a single `image://` scheme with semantic entity paths:
//   image://localhost/artist/{id}?src=...&name=...
//   image://localhost/album/{id}?src=...&artist=...&name=...
//   image://localhost/track/{id}?src=...&artist=...&album=...
//   image://localhost/playlist/{id}?src=...
//   image://localhost/ext/img?src=...    (one-off external images, no fallback)
//
// This handler:
//   1. Parses path → entity type + ID.
//   2. Parses query → src, name, artist params.
//   3. Derives cache key: {type}_{id}_{md5(src)[..8]}.img
//   4. Returns cached bytes from disk if present.
//   5. Fetches from src URL → success → cache + return.
//   6. src failed/absent + name present → metadata fallback (Deezer, iTunes).
//
// Cache dir: {app_cache_dir}/imgcache/
// Clear via `clear_image_cache` Tauri command.
// ---------------------------------------------------------------------------

/// Dedicated Tokio runtime for image fetching — isolated from Tauri's runtime.
/// Uses up to 8 workers so many concurrent cache-miss images can be fetched
/// without blocking each other or Tauri's main thread pool.
static IMGCACHE_RT: Lazy<tokio::runtime::Runtime> = Lazy::new(|| {
    let threads = std::thread::available_parallelism()
        .map(|n| n.get().min(8))
        .unwrap_or(4);
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(threads)
        .thread_name("imgcache")
        .enable_all()
        .build()
        .expect("Failed to create image-cache async runtime")
});

/// Shared HTTP client for image fetching (accepts self-signed certs for local Plex servers).
static IMG_HTTP: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .expect("Failed to build image HTTP client")
});

/// Derives a deterministic cache key for an image.
///
/// Format: `{entity_type}_{entity_id}_{md5(src)[..8]}.img`
/// When src is empty (fallback-only): `{entity_type}_{entity_id}_fallback.img`
fn img_cache_key(entity_type: &str, entity_id: &str, src: &str) -> String {
    if src.is_empty() {
        return format!("{}_{}_fallback.img", entity_type, entity_id);
    }
    use md5::{Digest, Md5};
    let hash = format!("{:x}", Md5::digest(src.as_bytes()));
    format!("{}_{}_{}.img", entity_type, entity_id, &hash[..8])
}

/// Attempt metadata fallback — search Deezer/iTunes for an image URL by entity name.
async fn metadata_fallback_url(
    entity_type: &str,
    name: &str,
    artist: &str,
) -> Option<String> {
    match entity_type {
        "artist" => {
            // Try Deezer first
            if let Ok(Some(info)) = crate::deezer::search_artist(name).await {
                if let Some(url) = info.image_url {
                    return Some(url);
                }
            }
            None
        }
        "album" | "track" => {
            // Deezer album search
            let search_artist = if artist.is_empty() { name } else { artist };
            if let Ok(Some(info)) = crate::deezer::search_album(search_artist, name).await {
                if let Some(url) = info.cover_url {
                    return Some(url);
                }
            }
            // iTunes album search
            if let Ok(Some(info)) = crate::itunes::search_album(search_artist, name).await {
                if let Some(url) = info.cover_url {
                    return Some(url);
                }
            }
            None
        }
        _ => None,
    }
}

/// Resolve an image: check cache → fetch src → metadata fallback → None.
///
/// Returns `Some(bytes)` on success, `None` on failure (no image found).
async fn resolve_image(
    app: &tauri::AppHandle,
    entity_type: &str,
    entity_id: &str,
    src: &str,
    name: &str,
    artist: &str,
) -> Option<Vec<u8>> {
    use tauri::Manager;

    // Need at least a src URL or a name for fallback
    if src.is_empty() && name.is_empty() {
        return None;
    }

    let cache_key = img_cache_key(entity_type, entity_id, src);
    let cache_dir: Option<std::path::PathBuf> = app
        .path()
        .app_cache_dir()
        .ok()
        .map(|d| d.join("imgcache"));

    // Helper: cache bytes to disk and return them
    let cache_and_return = |bytes: Vec<u8>, dir: &Option<std::path::PathBuf>, key: &str| -> Vec<u8> {
        if let Some(ref d) = dir {
            let _ = std::fs::write(d.join(key), &bytes);
        }
        bytes
    };

    // Disk cache hit
    if let Some(ref dir) = cache_dir {
        let _ = std::fs::create_dir_all(dir);
        let file_path = dir.join(&cache_key);
        if file_path.exists() {
            if let Ok(bytes) = std::fs::read(&file_path) {
                return Some(bytes);
            }
        }
    }

    // Try fetching from src URL
    if !src.is_empty() {
        if let Ok(resp) = IMG_HTTP.get(src).send().await {
            if resp.status().is_success() {
                if let Ok(bytes) = resp.bytes().await {
                    if !bytes.is_empty() {
                        return Some(cache_and_return(bytes.to_vec(), &cache_dir, &cache_key));
                    }
                }
            }
        }
    }

    // Metadata fallback: only for entity types with names
    if !name.is_empty() && matches!(entity_type, "artist" | "album" | "track") {
        if let Some(fallback_url) = metadata_fallback_url(entity_type, name, artist).await {
            let fb_cache_key = img_cache_key(entity_type, entity_id, &fallback_url);
            // Check fallback cache
            if let Some(ref dir) = cache_dir {
                let fb_path = dir.join(&fb_cache_key);
                if fb_path.exists() {
                    if let Ok(bytes) = std::fs::read(&fb_path) {
                        return Some(bytes);
                    }
                }
            }
            // Fetch fallback URL
            if let Ok(resp) = IMG_HTTP.get(&fallback_url).send().await {
                if resp.status().is_success() {
                    if let Ok(bytes) = resp.bytes().await {
                        if !bytes.is_empty() {
                            return Some(cache_and_return(bytes.to_vec(), &cache_dir, &fb_cache_key));
                        }
                    }
                }
            }
        }
    }

    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialise tracing so debug!/warn! calls produce output.
    // RUST_LOG controls the level (e.g. RUST_LOG=hibiki=debug).
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .init();

    // Linux/Wayland: disable GPU compositing in WebKitGTK to avoid EGL blank-window crashes.
    // Respects user overrides if already set.
    #[cfg(target_os = "linux")]
    {
        if std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE").is_err() {
            unsafe { std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1") };
        }
        if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(PlexState::new())
        .setup(|app| {
            // Open (or create) the local SQLite database.
            let db_path = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("Failed to get app data dir: {e}"))?
                .join("plexmusic.db");
            if let Some(parent) = db_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let db_state = db::DbState::open(&db_path)
                .map_err(|e| Box::<dyn std::error::Error>::from(e))?;
            app.manage(db_state);

            // Start the system Now Playing / media-key integration.
            // Must be called from setup (main thread) so macOS can register
            // MPRemoteCommandCenter before the runloop starts.
            let media_session = MediaSessionState::start(app.handle());
            app.manage(media_session);

            // Start audio device change listener (emits audio-device-changed events).
            audio_devices::start_device_listener(app.handle());

            // Start the Rust audio engine (cpal output, symphonia decode, DSP chain).
            match audio_engine::AudioEngine::start(app.handle().clone()) {
                Ok(engine) => {
                    app.manage(audio_engine::bridge::AudioEngineState(
                        std::sync::Arc::new(engine),
                    ));
                }
                Err(e) => {
                    tracing::error!("Failed to start audio engine: {}", e);
                    app.manage(audio_engine::bridge::AudioEngineState(
                        std::sync::Arc::new(audio_engine::AudioEngine::unavailable(app.handle(), e)),
                    ));
                }
            }

            // Remove the native OS menu bar (redundant on Windows with our custom titlebar).
            app.remove_menu().ok();

            // Restore saved window size/position before making the window visible.
            // The window starts hidden (visible: false in tauri.conf.json) so there
            // is no position-flash when the plugin moves it to the saved bounds.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.restore_state(StateFlags::all());
                let _ = win.show();
            }

            Ok(())
        })
        // ---- Semantic image-caching protocol (async) ----
        //
        // image://localhost/{entity_type}/{entity_id}?src=...&name=...&artist=...
        // image://localhost/ext/img?src=...  (one-off external, no fallback)
        .register_asynchronous_uri_scheme_protocol("image", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let uri = request.uri();
            let raw_path = uri.path().trim_start_matches('/').to_string();
            let query = uri.query().unwrap_or("").to_string();

            IMGCACHE_RT.spawn(async move {
                // Parse query params
                let params: std::collections::HashMap<String, String> =
                    url::form_urlencoded::parse(query.as_bytes())
                        .map(|(k, v)| (k.into_owned(), v.into_owned()))
                        .collect();
                let src = params.get("src").cloned().unwrap_or_default();
                let name = params.get("name").cloned().unwrap_or_default();
                let artist = params.get("artist").cloned().unwrap_or_default();

                // Parse path → entity_type / entity_id
                // Paths: "artist/548757", "album/123", "ext/img", etc.
                let parts: Vec<&str> = raw_path.splitn(2, '/').collect();
                let entity_type = parts.first().copied().unwrap_or("");
                let entity_id = if parts.len() > 1 { parts[1] } else { "" };

                // Resolve the image — result is Some(bytes) on success, None on failure.
                let result = resolve_image(&app, entity_type, entity_id, &src, &name, &artist).await;

                responder.respond(match result {
                    Some(bytes) => tauri::http::Response::builder()
                        .header("Content-Type", "image/jpeg")
                        .header("Cache-Control", "max-age=604800")
                        .header("Access-Control-Allow-Origin", "*")
                        .body(bytes)
                        .unwrap(),
                    None => tauri::http::Response::builder()
                        .status(if src.is_empty() && name.is_empty() { 400 } else { 404 })
                        .header("Access-Control-Allow-Origin", "*")
                        .body(vec![])
                        .unwrap(),
                });
            });
        })
        .invoke_handler(tauri::generate_handler![
            // Connection
            commands::connect_plex,
            // Library
            commands::get_library_sections,
            commands::search_library,
            commands::get_recently_added,
            commands::get_hubs,
            commands::get_on_deck,
            commands::get_section_tags,
            // Metadata
            commands::get_track,
            commands::get_artist,
            commands::get_album,
            commands::get_artist_albums,
            commands::get_album_tracks,
            commands::get_artist_popular_tracks,
            commands::get_artist_popular_leaves,
            commands::get_items_by_tag,
            commands::get_artist_similar,
            commands::get_artist_sonically_similar,
            commands::get_artist_albums_in_section,
            commands::get_artist_popular_tracks_in_section,
            commands::get_related_hubs,
            // Mixes
            commands::get_mix_tracks,
            // Playlists
            commands::get_playlists,
            commands::get_playlist_items,
            commands::get_liked_tracks,
            commands::get_liked_artists,
            commands::get_liked_albums,
            commands::create_playlist,
            commands::add_items_to_playlist,
            commands::remove_items_from_playlist,
            commands::move_playlist_item,
            commands::delete_playlist,
            commands::edit_playlist,
            // Play queue
            commands::create_play_queue,
            commands::get_play_queue,
            commands::add_to_play_queue,
            commands::create_radio_queue,
            commands::create_smart_shuffle_queue,
            // Playback tracking
            commands::mark_played,
            commands::mark_unplayed,
            commands::report_timeline,
            // Ratings (Phase 3)
            commands::rate_item,
            // Sonic / PlexAmp (Phase 2)
            commands::get_sonically_similar,
            commands::get_track_radio,
            commands::get_artist_stations,
            commands::get_section_stations,
            commands::compute_sonic_path,
            commands::get_stream_levels,
            // Streaming URLs (Phase 4)
            commands::get_stream_url,
            commands::get_thumb_url,
            commands::get_audio_transcode_url,
            commands::fetch_audio_bytes,
            // Server info (Phase 5)
            commands::get_identity,
            commands::get_server_info,
            // Settings (Phase 5)
            commands::load_settings,
            commands::save_settings,
            // Cache
            commands::clear_image_cache,
            commands::get_image_cache_info,
            // Plex.tv OAuth
            commands::plex_auth_start,
            commands::plex_auth_poll,
            commands::plex_get_resources,
            commands::test_server_connection,
            commands::get_lyrics,
            // Now Playing / media controls
            commands::update_now_playing,
            commands::set_now_playing_state,
            // Last.fm integration
            commands::lastfm_save_credentials,
            commands::lastfm_get_token,
            commands::lastfm_complete_auth,
            commands::lastfm_disconnect,
            commands::lastfm_set_enabled,
            commands::lastfm_set_replace_metadata,
            commands::lastfm_set_love_threshold,
            commands::lastfm_update_now_playing,
            commands::lastfm_scrobble,
            commands::lastfm_love_track,
            commands::lastfm_get_artist_info,
            commands::lastfm_get_track_info,
            commands::lastfm_get_album_info,
            commands::deezer_search_artist,
            commands::deezer_search_album,
            commands::itunes_search_artist,
            commands::itunes_search_album,
            // Local SQLite database
            commands::db_kv_get,
            commands::db_kv_set,
            commands::db_get_info,
            commands::db_upsert_artist,
            commands::db_upsert_artists,
            commands::db_get_artist,
            commands::db_search_artists,
            commands::db_get_artist_count,
            commands::db_upsert_album,
            commands::db_upsert_albums,
            commands::db_get_album,
            commands::db_search_albums,
            commands::db_get_albums_by_artist,
            commands::db_get_album_count,
            commands::db_upsert_track,
            commands::db_upsert_tracks,
            commands::db_get_track,
            commands::db_search_tracks,
            commands::db_get_tracks_by_album,
            commands::db_get_track_count,
            commands::db_upsert_playlists,
            commands::db_get_playlists,
            commands::db_add_playlist_track,
            commands::db_get_playlist_tracks,
            // Radio Browser (internet radio)
            commands::radiobrowser_search,
            commands::radiobrowser_top_stations,
            commands::radiobrowser_countries,
            commands::radiobrowser_tags,
            commands::radiobrowser_click,
            // Podcasts (iTunes + RSS)
            commands::podcast_search,
            commands::podcast_get_top,
            commands::podcast_get_feed,
            commands::podcast_lookup,
            commands::podcast_get_categories,
            // Genius integration
            commands::genius_save_credentials,
            commands::genius_disconnect,
            commands::genius_set_enabled,
            commands::genius_set_always_fetch,
            commands::genius_search,
            commands::genius_get_lyrics,
            // MusicBrainz integration
            commands::musicbrainz_get_artist_info,
            commands::musicbrainz_get_album_info,
            commands::musicbrainz_lookup_recording,
            // ListenBrainz integration
            commands::listenbrainz_save_token,
            commands::listenbrainz_disconnect,
            commands::listenbrainz_set_enabled,
            commands::listenbrainz_submit_now_playing,
            commands::listenbrainz_submit_listen,
            // Generic HTTP proxy
            commands::http_get_json,
            // Audio device detection
            commands::get_audio_output_device,
            commands::get_audio_output_devices,
            // Rust audio engine
            audio_engine::bridge::audio_play,
            audio_engine::bridge::audio_preload_next,
            audio_engine::bridge::audio_clear_preload,
            audio_engine::bridge::audio_pause,
            audio_engine::bridge::audio_resume,
            audio_engine::bridge::audio_stop,
            audio_engine::bridge::audio_seek,
            audio_engine::bridge::audio_set_volume,
            audio_engine::bridge::audio_set_normalization,
            audio_engine::bridge::audio_set_preamp_gain,
            audio_engine::bridge::audio_set_eq,
            audio_engine::bridge::audio_set_eq_enabled,
            audio_engine::bridge::audio_set_eq_postgain,
            audio_engine::bridge::audio_duck_and_apply,
            audio_engine::bridge::audio_set_crossfade_window,
            audio_engine::bridge::audio_set_same_album_crossfade,
            audio_engine::bridge::audio_set_smart_crossfade,
            audio_engine::bridge::audio_set_smart_crossfade_max,
            audio_engine::bridge::audio_set_mixramp_db,
            audio_engine::bridge::audio_set_visualizer_enabled,
            audio_engine::bridge::audio_get_sample_rate,
            audio_engine::bridge::audio_get_output_available,
            audio_engine::bridge::audio_set_cache_max_bytes,
            audio_engine::bridge::audio_clear_cache,
            audio_engine::bridge::audio_get_cache_stats,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn main() {
    run()
}
