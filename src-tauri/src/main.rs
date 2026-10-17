// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio_devices;
#[cfg(all(test, target_os = "macos"))]
mod platform_blocks_tests;
mod audio_engine;
mod cache_files;
mod commands;
mod db;
mod offline_commands;
mod collection_cache_commands;
mod queue_commands;
mod performance;
mod offline_audio;
mod catalogue_commands;
mod library_picker;
mod download_entities;
mod download_library;
mod artwork_commands;
mod deezer;
mod genius;
mod http_response;
mod image_cache;
mod image_content;
mod metadata_match;
mod image_fetch;
mod image_protocol;
mod itunes;
mod itunes_throttle;
mod lastfm;
mod listenbrainz;
mod listenbrainz_transport;
mod listening_history;
mod playlist_sync;
mod favorites_commands;
mod favorites_remote;
mod soulsync;
mod theaudiodb;
mod mediasession;
mod musicbrainz;
mod public_metadata;
mod metadata_service_settings;
mod metadata_services;
mod plex;
mod plextv;
mod podcast;
mod podcastindex;
mod radiobrowser;
mod shutdown;
mod window_geometry;
mod default_playlists;
mod ytmusic;

use commands::PlexState;
use mediasession::MediaSessionState;
use once_cell::sync::Lazy;
use tauri::Manager;

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
//   3. Derives a SHA-256 key scoped to account, library and image identity.
//   4. Returns cached bytes from disk if present.
//   5. Fetches from src URL → success → cache + return.
//   6. src failed/absent + name present → metadata fallback (Deezer, iTunes).
//
// Cache dir: {app_cache_dir}/imgcache/
// Clear via `clear_image_cache` Tauri command.
// ---------------------------------------------------------------------------

/// Dedicated Tokio runtime for image fetching — isolated from Tauri's runtime.
/// The request queue separately bounds active resolutions and admission; runtime
/// worker threads alone do not limit concurrent asynchronous network work.
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

static IMAGE_WORK: Lazy<image_protocol::WorkQueue> = Lazy::new(image_protocol::WorkQueue::default);

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
    request: &image_protocol::ImageRequest,
    context: &image_protocol::ImageContext,
    cache: std::sync::Arc<image_cache::ImageCache>,
    ticket: image_cache::Ticket,
) -> Option<Vec<u8>> {
    let image_protocol::ImageRequest {
        kind: entity_type,
        id: entity_id,
        src,
        name,
        artist,
        scope: requested_scope,
    } = request;
    let state = app.state::<commands::PlexState>();
    let requires_connection = request.requires_connection(context);
    if (requires_connection && !state.image_context_is_current(context).await)
        || !image_fetch::scope_matches(context.client.as_ref(), requested_scope)
    {
        return None;
    }
    if metadata_services::is_heya_image(src) {
        return metadata_services::resolve_heya_image(app,src,context,cache,ticket,false).await.ok();
    }
    if src.starts_with("plexartwork:") {
        return artwork_commands::resolve_inventory_image(app, src, context, cache, ticket).await;
    }
    let source_request = if src.is_empty() {
        None
    } else {
        // Validate authentication/provenance before either cache access or a
        // shared resolution, including when the source has already been cached.
        Some(image_fetch::scoped_request(context.client.as_ref(), requested_scope, src)?)
    };
    let scope = context.cache_scope();
    let cache_key = request.cache_key(context);
    if let Some(bytes) =
        image_protocol::cached_artwork(request, context, cache.clone(), ticket.clone()).await
    {
        return Some(bytes);
    }

    // Saved browsing reads verified local pixels only, including public sources.
    if context.client.as_ref().is_some_and(|client| client.offline_only) {
        return None;
    }

    // Try fetching from src URL
    if !src.is_empty() {
        if let Some(request) = source_request {
            if let Some(bytes) = image_fetch::fetch(request).await {
                if requires_connection && !state.image_context_is_current(context).await {
                    return None;
                }
                return Some(
                    image_cache::store(cache.clone(), ticket.clone(), cache_key.clone(), bytes)
                        .await,
                );
            }
        }
        // A selected source must not silently return another provider's image.
        // The renderer retries transient failures and advances its source order.
        return None;
    }

    // Metadata fallback: only for entity types with names
    if !state.image_context_is_current(context).await {
        return None;
    }
    if !name.is_empty() && matches!(entity_type.as_str(), "artist" | "album" | "track") {
        if let Some(fallback_url) = metadata_fallback_url(entity_type, name, artist).await {
            let fb_cache_key =
                image_fetch::cache_key(scope, entity_type, entity_id, &fallback_url, name, artist);
            let ticket = cache.bind_key(&ticket, &fb_cache_key).ok()?;
            if let Some(bytes) =
                image_cache::read_validated(cache.clone(), ticket.clone(), fb_cache_key.clone())
                    .await
            {
                return Some(bytes);
            }
            // Fetch fallback URL
            if let Some(request) = image_fetch::request(None, &fallback_url) {
                if let Some(bytes) = image_fetch::fetch(request).await {
                    if requires_connection && !state.image_context_is_current(context).await {
                        return None;
                    }
                    return Some(
                        image_cache::store(cache.clone(), ticket.clone(), fb_cache_key, bytes)
                            .await,
                    );
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
        .plugin(ytmusic::app_only_plugin(tauri_plugin_opener::init()))
        .plugin(ytmusic::app_only_plugin(tauri_plugin_dialog::init()))
        .plugin(ytmusic::app_only_plugin(tauri_plugin_window_state::Builder::new().skip_initial_state("main").with_denylist(&[ytmusic::WINDOW]).build()))
        .plugin(ytmusic::app_only_plugin(tauri_plugin_updater::Builder::new().build()))
        .plugin(ytmusic::app_only_plugin(tauri_plugin_notification::init()))
        .manage(PlexState::new())
        .manage(artwork_commands::ArtworkInventoryState::default())
        .manage(std::sync::Arc::new(soulsync::SoulSyncState::default()))
        .manage(std::sync::Arc::new(theaudiodb::TheAudioDbState::default()))
        .manage(std::sync::Arc::new(metadata_services::MetadataServicesState::default()))
        .manage(shutdown::ShutdownState::default())
        .manage(listening_history::ReportingState::default())
        .setup(|app| {
            let images = match app.path().app_cache_dir() {
                Ok(root) => image_cache::ImageCache::new(root.join("imgcache")),
                Err(error) => image_cache::ImageCache::unavailable(error.to_string()),
            };
            app.manage(image_cache::ImageCacheState(std::sync::Arc::new(images)));
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
            let download_root = download_library::initial_directory(
                app.handle(),
                &*db_state.0.lock().map_err(|_| "Download settings unavailable")?,
            )?;
            app.manage(db_state);
            performance::initialize(&app.path().app_data_dir()?);
            app.manage(offline_audio::AudioDownloads::new(download_root));
            app.manage(download_library::DownloadLibrary::default());
            app.manage(catalogue_commands::CatalogueSync::new());
            app.manage(library_picker::LibraryPicker::default());
            app.manage(default_playlists::Bootstrap::default());
            listening_history::start_worker(app.handle().clone());

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

            download_library::start(app.handle().clone());
            ytmusic::start(app.handle().clone());

            // Remove the native OS menu bar (redundant on Windows with our custom titlebar).
            app.remove_menu().ok();

            // Restore saved window size/position before making the window visible.
            // The window starts hidden (visible: false in tauri.conf.json) so there
            // is no position-flash when the plugin moves it to the saved bounds.
            if let Some(win) = app.get_webview_window("main") {
                if let Err(error) = window_geometry::restore(&win) {
                    tracing::warn!("Could not restore main window geometry: {error}");
                }
                let _ = win.show();
            }

            Ok(())
        })
        // ---- Semantic image-caching protocol (async) ----
        //
        // image://localhost/{entity_type}/{entity_id}?src=...&name=...&artist=...
        // image://localhost/ext/img?src=...  (one-off external, no fallback)
        .register_asynchronous_uri_scheme_protocol("image", |ctx, request, responder| {
            let uri = request.uri();
            let parsed = match image_protocol::ImageRequest::parse(
                request.method().as_str(), uri.path(), uri.query().unwrap_or(""), request.body().len(),
            ) {
                Ok(parsed) => parsed,
                Err(status) => { responder.respond(image_protocol::error_response(status)); return; }
            };
            let Some(admission) = IMAGE_WORK.try_admit() else {
                responder.respond(image_protocol::error_response(503));
                return;
            };
            let app = ctx.app_handle().clone();
            let cache = app.state::<image_cache::ImageCacheState>().0.clone();
            // Capture before waiting for a worker so Clear retires queued work, too.
            let ticket = cache.ticket();
            IMGCACHE_RT.spawn(async move {
                let context = app.state::<commands::PlexState>().image_context().await;
                if !image_fetch::scope_matches(context.client.as_ref(), &parsed.scope) {
                    responder.respond(image_protocol::error_response(404));
                    return;
                }
                let ticket = match cache.bind_key(&ticket, &parsed.cache_key(&context)) {
                    Ok(ticket) => ticket,
                    Err(_) => { responder.respond(image_protocol::error_response(503)); return; }
                };
                let key = image_protocol::WorkKey::new(&parsed, &context, ticket.clone());
                let requires_connection = parsed.requires_connection(&context);
                let request_app = app.clone();
                let request_context = context.clone();
                let result = admission.resolve(key, move || async move {
                    resolve_image(&request_app, &parsed, &request_context, cache, ticket).await
                }).await;
                let current = !requires_connection || app.state::<commands::PlexState>().image_context_is_current(&context).await;
                responder.respond(match result.filter(|_| current) {
                    Some(bytes) => image_protocol::success_response((*bytes).clone()),
                    None => image_protocol::error_response(404),
                });
            });
        })
        .invoke_handler(tauri::generate_handler![
            ytmusic::ytmusic_status,
            ytmusic::ytmusic_playlist_read,
            ytmusic::ytmusic_playlist_write,
            ytmusic::ytmusic_connect,
            ytmusic::ytmusic_refresh,
            ytmusic::ytmusic_disconnect,
            ytmusic::ytmusic_search,
            ytmusic::ytmusic_browse,
            ytmusic::ytmusic_set_song_like,
            ytmusic::ytmusic_test_stream,
            ytmusic::ytmusic_helpers,
            ytmusic::ytmusic_install_helpers,
            performance::record_performance,
            shutdown::shutdown_listener_ready,
            shutdown::prepare_app_shutdown,
            shutdown::complete_app_shutdown,
            shutdown::cancel_app_shutdown,
            shutdown::approve_update_exit,
            listening_history::flush_listening_outbox,
            listening_history::listening_history_status,
            listening_history::retry_listening_history,
            // Connection
            commands::connect_plex,
            commands::disconnect_plex,
            offline_commands::restore_offline_context,
            offline_commands::offline_cache_get,
            collection_cache_commands::collection_cache,
            queue_commands::saved_queue,
            offline_commands::offline_cache_put,
            offline_commands::offline_cache_info,
            offline_commands::offline_cache_clear,
            offline_commands::offline_cache_invalidate,
            offline_audio::audio_prepare_plex_track,
            download_entities::download_entity,
            download_entities::download_entity_status,
            download_entities::download_entity_issues,
            download_entities::remove_entity_download,
            download_library::download_storage_info,
            download_library::download_storage_choose,
            download_library::download_storage_retry,
            download_library::download_storage_open,
            library_picker::library_picker_servers,
            library_picker::library_picker_sections,
            library_picker::library_picker_resolve,
            catalogue_commands::catalogue_query,
            catalogue_commands::catalogue_health,
            catalogue_commands::catalogue_availability,
            catalogue_commands::catalogue_remote_page,
            offline_audio::audio_availability,
            offline_audio::audio_track_levels,
            offline_audio::audio_local_track,
            offline_audio::audio_download_list,
            offline_audio::audio_download_enqueue,
            offline_audio::audio_download_resume,
            offline_audio::audio_download_remove,
            // Library
            commands::get_library_sections,
            commands::search_library,
            commands::get_recently_added,
            commands::get_latest_releases,
            commands::get_hubs,
            commands::get_discovery_page,
            commands::get_on_deck,
            commands::get_section_tags,
            // Metadata
            commands::get_track,
            commands::get_artist,
            commands::get_album,
            artwork_commands::get_library_artwork,
            artwork_commands::save_library_artwork,
            commands::get_advanced_metadata,
            commands::edit_advanced_metadata,
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
            commands::get_mix_tracks_page,
            commands::get_rated_items_page,
            // Playlists
            commands::get_playlists,
            commands::get_playlist_items,
            commands::get_playlist_items_page,
            commands::get_liked_tracks,
            commands::get_liked_artists,
            commands::get_liked_albums,
            commands::create_playlist,
            commands::add_items_to_playlist,
            commands::remove_items_from_playlist,
            commands::move_playlist_item,
            commands::delete_playlist,
            commands::edit_playlist,
            commands::edit_library_metadata,
            soulsync::soulsync_status,
            soulsync::soulsync_configure,
            soulsync::soulsync_artist,
            theaudiodb::theaudiodb_status,
            theaudiodb::theaudiodb_configure,
            theaudiodb::theaudiodb_lookup,
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
            commands::refresh_image,
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
            metadata_services::metadata_service_status,
            metadata_services::metadata_service_configure,
            metadata_services::fanart_get_artist,
            metadata_services::fanart_get_album,
            soulsync::entities::soulsync_entity,
            metadata_services::heya_get_metadata,
            metadata_services::identity::heya_search_identities,
            metadata_services::identity::heya_review_identity,
            metadata_services::discovery::heya_discovery_capability,
            metadata_services::discovery::heya_discover,
            metadata_services::discovery::heya_discovery_step,
            metadata_services::discovery::heya_discovery_forget,
            musicbrainz::musicbrainz_search_identities,
            musicbrainz::musicbrainz_review_identity,
            public_metadata::wikidata_get_artist,
            public_metadata::coverartarchive_get_album,
            commands::musicbrainz_get_artist_info,
            commands::musicbrainz_get_album_info,
            commands::musicbrainz_lookup_recording,
            // ListenBrainz integration
            playlist_sync::playlist_sync_listenbrainz_account,
            playlist_sync::playlist_sync_listenbrainz_list,
            playlist_sync::playlist_sync_listenbrainz_read,
            playlist_sync::playlist_sync_listenbrainz_create,
            playlist_sync::playlist_sync_listenbrainz_mutate,
            favorites_commands::favorites_load,
            favorites_commands::favorites_tracks,
            favorites_commands::favorites_page,
            favorites_commands::favorites_save,
            favorites_commands::favorites_reset,
            favorites_commands::favorites_plex_read,
            favorites_commands::favorites_plex_mutate,
            favorites_remote::favorites_remote_account,
            favorites_remote::favorites_remote_page,
            favorites_remote::favorites_remote_peek,
            favorites_remote::favorites_remote_set,
            commands::playlist_sync_plex_mutate,
            commands::playlist_sync_plex_describe,
            commands::playlist_sync_resolve_recording,
            playlist_sync::playlist_sync_candidates,
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
            audio_engine::bridge::audio_prepare_queue,
            audio_engine::bridge::audio_get_waveform,
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
            audio_engine::bridge::audio_configure_eq,
            audio_engine::bridge::audio_duck_and_apply,
            audio_engine::bridge::audio_set_crossfade_window,
            audio_engine::bridge::audio_set_same_album_crossfade,
            audio_engine::bridge::audio_set_smart_crossfade,
            audio_engine::bridge::audio_set_smart_crossfade_max,
            audio_engine::bridge::audio_set_mixramp_db,
            audio_engine::bridge::audio_set_visualizer_enabled,
            audio_engine::bridge::audio_get_sample_rate,
            audio_engine::bridge::audio_get_output_available,
            audio_engine::bridge::audio_get_diagnostics,
            audio_engine::bridge::audio_set_cache_max_bytes,
            audio_engine::bridge::audio_clear_cache,
            audio_engine::bridge::audio_get_cache_stats,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            let state = app.state::<shutdown::ShutdownState>();
            if state.approved() { return; }
            match event {
                tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::CloseRequested { api, .. }, .. } if label == "main" => { api.prevent_close(); state.request(app); }
                tauri::RunEvent::ExitRequested { code, api, .. } if code != Some(tauri::RESTART_EXIT_CODE) => { api.prevent_exit(); state.request(app); }
                _ => {}
            }
        });
}

fn main() {
    run()
}
