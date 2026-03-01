//! Tauri command bridge — exposes the Plex API to the frontend via invoke()
//!
//! All commands are async and return Result<T, String> so errors surface cleanly
//! in TypeScript. The PlexClient is stored in Tauri managed state; call
//! `connect_plex` first before using any other command.

use tauri::State;
use tokio::sync::Mutex;

use crate::mediasession::{MediaSessionState, MediaUpdate};
use crate::plex::{
    Hub, IdentityResponse, Level, LibrarySection, PlayQueue, Playlist, PlexClient,
    PlexClientConfig, PlexSettings, ServerInfo, Tag, Track,
};
use crate::plex::models::{Album, Artist};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// Shared Plex client state managed by Tauri.
pub struct PlexState(pub Mutex<Option<PlexClient>>);

impl PlexState {
    pub fn new() -> Self {
        PlexState(Mutex::new(None))
    }
}

/// Convenience macro: lock the state and return an error if not connected.
macro_rules! client {
    ($state:expr) => {{
        let guard = $state.0.lock().await;
        match guard.as_ref() {
            Some(c) => c.clone(),
            None => {
                return Err(
                    "Plex client not connected. Call connect_plex first.".to_string(),
                )
            }
        }
    }};
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/// Connect to a Plex Media Server.
///
/// Must be called before any other command. The connection is held in state
/// for the lifetime of the application.
#[tauri::command]
pub async fn connect_plex(
    base_url: String,
    token: String,
    state: State<'_, PlexState>,
) -> Result<(), String> {
    let config = PlexClientConfig {
        base_url,
        token,
        // Plex servers on the LAN commonly use self-signed or Plex-issued
        // certificates that may not validate against the system trust store.
        accept_invalid_certs: true,
        ..Default::default()
    };
    let client = PlexClient::new(config).map_err(|e| format!("{:#}", e))?;
    let mut guard = state.0.lock().await;
    *guard = Some(client);
    Ok(())
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

/// Get all library sections (music, video, photo, etc.)
#[tauri::command]
pub async fn get_library_sections(
    state: State<'_, PlexState>,
) -> Result<Vec<LibrarySection>, String> {
    let c = client!(state);
    c.get_all_sections().await.map_err(|e| format!("{:#}", e))
}

/// Search a library section.
///
/// `libtype` filters by item type: "artist", "album", "track" for music.
#[tauri::command]
pub async fn search_library(
    section_id: i64,
    query: String,
    libtype: Option<String>,
    state: State<'_, PlexState>,
) -> Result<Vec<crate::plex::PlexMedia>, String> {
    let c = client!(state);
    c.search(section_id, &query, libtype.as_deref(), None, None, Some(50))
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get recently added items in a section.
#[tauri::command]
pub async fn get_recently_added(
    section_id: i64,
    libtype: Option<String>,
    limit: Option<i32>,
    state: State<'_, PlexState>,
) -> Result<Vec<crate::plex::PlexMedia>, String> {
    let c = client!(state);
    c.recently_added(section_id, libtype.as_deref(), limit)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get discovery hubs for a section (home screen content).
#[tauri::command]
pub async fn get_hubs(
    section_id: i64,
    state: State<'_, PlexState>,
) -> Result<Vec<Hub>, String> {
    let c = client!(state);
    c.get_section_hubs(section_id)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get "on deck" / continue listening items.
#[tauri::command]
pub async fn get_on_deck(
    section_id: i64,
    state: State<'_, PlexState>,
) -> Result<Vec<crate::plex::PlexMedia>, String> {
    let c = client!(state);
    c.on_deck(section_id).await.map_err(|e| format!("{:#}", e))
}

/// Get tags (genres, moods, styles) for a library section.
///
/// `tag_type` should be "genre", "mood", or "style".
#[tauri::command]
pub async fn get_section_tags(
    section_id: i64,
    tag_type: String,
    state: State<'_, PlexState>,
) -> Result<Vec<Tag>, String> {
    let c = client!(state);
    c.get_tags(section_id, &tag_type)
        .await
        .map_err(|e| format!("{:#}", e))
}

// ---------------------------------------------------------------------------
// Metadata fetch
// ---------------------------------------------------------------------------

/// Get a specific track by rating key.
#[tauri::command]
pub async fn get_track(
    rating_key: i64,
    state: State<'_, PlexState>,
) -> Result<Track, String> {
    let c = client!(state);
    c.get_track(rating_key).await.map_err(|e| format!("{:#}", e))
}

/// Get an artist by rating key.
#[tauri::command]
pub async fn get_artist(
    rating_key: i64,
    state: State<'_, PlexState>,
) -> Result<Artist, String> {
    let c = client!(state);
    c.get_artist(rating_key).await.map_err(|e| format!("{:#}", e))
}

/// Get an album by rating key.
#[tauri::command]
pub async fn get_album(
    rating_key: i64,
    state: State<'_, PlexState>,
) -> Result<Album, String> {
    let c = client!(state);
    c.get_album(rating_key).await.map_err(|e| format!("{:#}", e))
}

/// Get albums by an artist with an optional format filter.
///
/// `format_filter` values:
/// - `null` / `None` → all albums
/// - `"Single"` → only singles
/// - `"!Single"` → full albums and EPs (excludes singles)
#[tauri::command]
pub async fn get_artist_albums(
    rating_key: i64,
    format_filter: Option<String>,
    state: State<'_, PlexState>,
) -> Result<Vec<Album>, String> {
    let c = client!(state);
    c.artist_albums(rating_key, format_filter.as_deref())
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get all tracks in an album.
#[tauri::command]
pub async fn get_album_tracks(
    rating_key: i64,
    state: State<'_, PlexState>,
) -> Result<Vec<Track>, String> {
    let c = client!(state);
    c.album_tracks(rating_key).await.map_err(|e| format!("{:#}", e))
}

/// Get popular tracks for an artist (legacy: /library/all sort by ratingCount).
#[tauri::command]
pub async fn get_artist_popular_tracks(
    rating_key: i64,
    limit: Option<i32>,
    state: State<'_, PlexState>,
) -> Result<Vec<Track>, String> {
    let c = client!(state);
    c.artist_popular_tracks(rating_key, limit)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get popular tracks for an artist using the /popularLeaves endpoint.
#[tauri::command]
pub async fn get_artist_popular_leaves(
    rating_key: i64,
    limit: Option<i32>,
    state: State<'_, PlexState>,
) -> Result<Vec<Track>, String> {
    let c = client!(state);
    c.artist_popular_leaves(rating_key, limit)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get metadata-based similar artists for an artist.
#[tauri::command]
pub async fn get_artist_similar(
    rating_key: i64,
    state: State<'_, PlexState>,
) -> Result<Vec<Artist>, String> {
    let c = client!(state);
    c.artist_similar(rating_key)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get hubs related to a specific item.
#[tauri::command]
pub async fn get_related_hubs(
    rating_key: i64,
    limit: Option<i32>,
    state: State<'_, PlexState>,
) -> Result<Vec<Hub>, String> {
    let c = client!(state);
    c.get_related_hubs(rating_key, limit)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get sonically similar artists for an artist.
///
/// Uses `/library/metadata/{id}/nearest` with sonic analysis to find artists
/// with a similar sound. This is what Plex Web uses for the "Sonically Similar"
/// section on the artist page.
#[tauri::command]
pub async fn get_artist_sonically_similar(
    rating_key: i64,
    limit: Option<i32>,
    max_distance: Option<f64>,
    state: State<'_, PlexState>,
) -> Result<Vec<Artist>, String> {
    let c = client!(state);
    c.artist_sonically_similar(rating_key, limit, max_distance)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get albums for an artist using the section-specific endpoint.
///
/// More efficient than `get_artist_albums` — returns deduplicated results
/// and supports Plex's `format` parameter for filtering by album type.
///
/// `format` examples: `"EP,Single"` (singles + EPs), `null` (all albums).
#[tauri::command]
pub async fn get_artist_albums_in_section(
    section_id: i64,
    rating_key: i64,
    format: Option<String>,
    state: State<'_, PlexState>,
) -> Result<Vec<Album>, String> {
    let c = client!(state);
    c.artist_albums_in_section(section_id, rating_key, format.as_deref())
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get popular tracks for an artist using the section-specific endpoint.
///
/// Uses `group=title` for server-side deduplication and filters out
/// compilations/live albums. This matches the Plex Web approach.
#[tauri::command]
pub async fn get_artist_popular_tracks_in_section(
    section_id: i64,
    rating_key: i64,
    limit: Option<i32>,
    state: State<'_, PlexState>,
) -> Result<Vec<Track>, String> {
    let c = client!(state);
    c.artist_popular_tracks_in_section(section_id, rating_key, limit)
        .await
        .map_err(|e| format!("{:#}", e))
}

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

/// List all playlists in a section.
#[tauri::command]
pub async fn get_playlists(
    section_id: i64,
    state: State<'_, PlexState>,
) -> Result<Vec<Playlist>, String> {
    let c = client!(state);
    c.list_playlists(section_id, None)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get tracks that have been rated (liked) by the user.
///
/// Returns tracks sorted by most recently rated.
#[tauri::command]
pub async fn get_liked_tracks(
    section_id: i64,
    limit: Option<i32>,
    state: State<'_, PlexState>,
) -> Result<Vec<Track>, String> {
    let c = client!(state);
    c.liked_tracks(section_id, limit)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get all tracks in a playlist.
#[tauri::command]
pub async fn get_playlist_items(
    playlist_id: i64,
    limit: Option<i32>,
    offset: Option<i32>,
    state: State<'_, PlexState>,
) -> Result<Vec<Track>, String> {
    let c = client!(state);
    c.get_playlist_items(playlist_id, limit, offset)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Create a new playlist.
#[tauri::command]
pub async fn create_playlist(
    title: String,
    section_id: i64,
    item_ids: Vec<i64>,
    state: State<'_, PlexState>,
) -> Result<Playlist, String> {
    let c = client!(state);
    c.create_playlist(&title, section_id, &item_ids)
        .await
        .map_err(|e| format!("{:#}", e))
}

// ---------------------------------------------------------------------------
// Play queue
// ---------------------------------------------------------------------------

/// Create a server-side play queue.
///
/// Use `PlexClient::build_item_uri(section_uuid, item_key)` to build the URI,
/// or pass a raw library path like `/library/metadata/{ratingKey}`.
#[tauri::command]
pub async fn create_play_queue(
    uri: String,
    shuffle: bool,
    repeat: i32,
    state: State<'_, PlexState>,
) -> Result<PlayQueue, String> {
    let c = client!(state);
    c.create_play_queue(&uri, shuffle, repeat)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Fetch an existing play queue.
#[tauri::command]
pub async fn get_play_queue(
    queue_id: i64,
    state: State<'_, PlexState>,
) -> Result<PlayQueue, String> {
    let c = client!(state);
    c.get_play_queue(queue_id)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Add items to a play queue.
#[tauri::command]
pub async fn add_to_play_queue(
    queue_id: i64,
    uri: String,
    next: bool,
    state: State<'_, PlexState>,
) -> Result<PlayQueue, String> {
    let c = client!(state);
    c.add_to_play_queue(queue_id, &uri, next)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Create a radio play queue seeded from any Plex item (track, album, or artist).
///
/// Uses PlexAmp's `plex://radio` URI scheme so the Plex server generates
/// continuously refreshing, sonically-curated recommendations.
#[tauri::command]
pub async fn create_radio_queue(
    rating_key: i64,
    degrees_of_separation: Option<i32>,
    include_external: bool,
    shuffle: bool,
    state: State<'_, PlexState>,
) -> Result<PlayQueue, String> {
    let c = client!(state);
    c.create_radio_queue(rating_key, degrees_of_separation, include_external, shuffle)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Create a smart-shuffle (Guest DJ) play queue.
///
/// Same as `create_radio_queue` but with Plex's AI-curated `smartShuffle` mode
/// and the DJ persona header. Reads the installation's client ID from saved settings.
#[tauri::command]
pub async fn create_smart_shuffle_queue(
    rating_key: i64,
    degrees_of_separation: Option<i32>,
    include_external: bool,
    state: State<'_, PlexState>,
    app: tauri::AppHandle,
) -> Result<PlayQueue, String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    let settings = crate::plex::load_settings(&config_dir).map_err(|e| format!("{:#}", e))?;
    let client_id = if settings.client_id.is_empty() {
        "plexify-client".to_string()
    } else {
        settings.client_id
    };
    let c = client!(state);
    c.create_smart_shuffle_queue(rating_key, degrees_of_separation, include_external, &client_id)
        .await
        .map_err(|e| format!("{:#}", e))
}

// ---------------------------------------------------------------------------
// Playback tracking
// ---------------------------------------------------------------------------

/// Mark an item as played (scrobble).
#[tauri::command]
pub async fn mark_played(
    rating_key: i64,
    state: State<'_, PlexState>,
) -> Result<(), String> {
    let c = client!(state);
    c.mark_played(rating_key).await.map_err(|e| format!("{:#}", e))
}

/// Mark an item as unplayed.
#[tauri::command]
pub async fn mark_unplayed(
    rating_key: i64,
    state: State<'_, PlexState>,
) -> Result<(), String> {
    let c = client!(state);
    c.mark_unplayed(rating_key)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Report playback timeline progress to the server.
///
/// Call this periodically (every ~10s) during playback.
/// `state_str` is one of: "playing", "paused", "buffering", "stopped".
#[tauri::command]
pub async fn report_timeline(
    rating_key: i64,
    state_str: String,
    time_ms: i64,
    duration_ms: i64,
    plex_state: State<'_, PlexState>,
) -> Result<(), String> {
    use crate::plex::PlaybackState;
    let playback_state = match state_str.as_str() {
        "playing" => PlaybackState::Playing,
        "paused" => PlaybackState::Paused,
        "buffering" => PlaybackState::Buffering,
        _ => PlaybackState::Stopped,
    };
    let c = client!(plex_state);
    c.report_timeline(rating_key, playback_state, time_ms, duration_ms, None)
        .await
        .map_err(|e| format!("{:#}", e))
}

// ---------------------------------------------------------------------------
// Ratings (Phase 3)
// ---------------------------------------------------------------------------

/// Rate a library item.
///
/// `rating` is 0.0–10.0 (Plex half-star scale: 2.0 = 1★, 10.0 = 5★).
/// Pass `null` from the frontend (mapped to `None`) to clear the rating.
#[tauri::command]
pub async fn rate_item(
    rating_key: i64,
    rating: Option<f64>,
    state: State<'_, PlexState>,
) -> Result<(), String> {
    let c = client!(state);
    c.rate_item(rating_key, rating)
        .await
        .map_err(|e| format!("{:#}", e))
}

// ---------------------------------------------------------------------------
// Sonic / PlexAmp features (Phase 2)
// ---------------------------------------------------------------------------

/// Get tracks sonically similar to a given track.
#[tauri::command]
pub async fn get_sonically_similar(
    rating_key: i64,
    limit: Option<i32>,
    max_distance: Option<f64>,
    state: State<'_, PlexState>,
) -> Result<Vec<Track>, String> {
    let c = client!(state);
    c.sonically_similar::<Track>(rating_key, limit, max_distance)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get a track radio (mix) seeded from a track.
#[tauri::command]
pub async fn get_track_radio(
    section_id: i64,
    rating_key: i64,
    limit: Option<i32>,
    state: State<'_, PlexState>,
) -> Result<Vec<Track>, String> {
    let c = client!(state);
    c.track_radio(section_id, rating_key, limit, None)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get radio stations seeded from an artist.
#[tauri::command]
pub async fn get_artist_stations(
    rating_key: i64,
    state: State<'_, PlexState>,
) -> Result<Vec<Playlist>, String> {
    let c = client!(state);
    c.artist_stations(rating_key)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get music stations available in a library section.
///
/// Returns discovery hubs; look for hubs with `hub_identifier` containing
/// "station" to find the station playlists.
#[tauri::command]
pub async fn get_section_stations(
    section_id: i64,
    state: State<'_, PlexState>,
) -> Result<Vec<Hub>, String> {
    let c = client!(state);
    c.section_stations(section_id)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Compute a sonic path between two tracks.
#[tauri::command]
pub async fn compute_sonic_path(
    section_id: i64,
    from_id: i64,
    to_id: i64,
    state: State<'_, PlexState>,
) -> Result<Vec<Track>, String> {
    let c = client!(state);
    c.compute_sonic_path(section_id, from_id, to_id)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get loudness/peak level data for a media stream (for waveform display).
///
/// `stream_id` is the part ID from `track.media[0].parts[0].id`.
/// `sub_sample` controls resolution (128 = PlexAmp default).
#[tauri::command]
pub async fn get_stream_levels(
    stream_id: i64,
    sub_sample: Option<i32>,
    state: State<'_, PlexState>,
) -> Result<Vec<Level>, String> {
    let c = client!(state);
    c.get_stream_levels(stream_id, sub_sample)
        .await
        .map_err(|e| format!("{:#}", e))
}

// ---------------------------------------------------------------------------
// Streaming URLs (Phase 4)
// ---------------------------------------------------------------------------

/// Build a direct-play stream URL for a media part.
///
/// Returns a URL you can pass to an audio element.
/// `part_key` comes from `track.media[0].parts[0].key`.
#[tauri::command]
pub async fn get_stream_url(
    part_key: String,
    state: State<'_, PlexState>,
) -> Result<String, String> {
    let guard = state.0.lock().await;
    match guard.as_ref() {
        Some(c) => Ok(c.direct_play_url(&part_key)),
        None => Err("Plex client not connected.".to_string()),
    }
}

/// Build a thumbnail/artwork URL.
///
/// `thumb_path` comes from `track.thumb`, `album.thumb`, `artist.thumb`, etc.
#[tauri::command]
pub async fn get_thumb_url(
    thumb_path: String,
    state: State<'_, PlexState>,
) -> Result<String, String> {
    let guard = state.0.lock().await;
    match guard.as_ref() {
        Some(c) => Ok(c.thumb_url(&thumb_path)),
        None => Err("Plex client not connected.".to_string()),
    }
}

/// Build an audio transcode URL.
///
/// Use when the client cannot play the native format.
/// `bitrate` in kbps (e.g. 320), `codec` e.g. "mp3" / "aac" / "opus".
#[tauri::command]
pub async fn get_audio_transcode_url(
    part_key: String,
    bitrate: Option<i32>,
    codec: Option<String>,
    state: State<'_, PlexState>,
) -> Result<String, String> {
    let guard = state.0.lock().await;
    match guard.as_ref() {
        Some(c) => Ok(c.audio_transcode_url(&part_key, bitrate, codec.as_deref())),
        None => Err("Plex client not connected.".to_string()),
    }
}

// ---------------------------------------------------------------------------
// Server info (Phase 5)
// ---------------------------------------------------------------------------

/// Get the server's identity (machine ID, version, claimed status).
#[tauri::command]
pub async fn get_identity(
    state: State<'_, PlexState>,
) -> Result<IdentityResponse, String> {
    let c = client!(state);
    c.get_identity().await.map_err(|e| format!("{:#}", e))
}

/// Get full server capabilities and metadata.
#[tauri::command]
pub async fn get_server_info(
    state: State<'_, PlexState>,
) -> Result<ServerInfo, String> {
    let c = client!(state);
    c.get_server_info().await.map_err(|e| format!("{:#}", e))
}

// ---------------------------------------------------------------------------
// Settings persistence (Phase 5)
// ---------------------------------------------------------------------------

/// Load saved connection settings (server URL + token) from disk.
///
/// Returns empty strings if no settings have been saved yet.
#[tauri::command]
pub async fn load_settings(app: tauri::AppHandle) -> Result<PlexSettings, String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    crate::plex::load_settings(&config_dir).map_err(|e| format!("{:#}", e))
}

/// Persist connection settings to disk.
///
/// Loads existing settings first to preserve `client_id` across saves.
/// `all_urls` stores every known connection URL for the server (local, remote,
/// relay) so the app can fall back if the primary URL becomes unreachable.
#[tauri::command]
pub async fn save_settings(
    base_url: String,
    token: String,
    all_urls: Option<Vec<String>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    let mut settings = crate::plex::load_settings(&config_dir).map_err(|e| format!("{:#}", e))?;
    settings.base_url = base_url;
    settings.token = token;
    if let Some(urls) = all_urls {
        settings.all_urls = urls;
    }
    crate::plex::save_settings(&config_dir, &settings).map_err(|e| format!("{:#}", e))
}

/// Quickly probe a Plex server URL to check reachability and measure latency.
///
/// Uses a 5-second timeout with no retries — intended for parallel probing of
/// multiple candidate URLs to find the fastest/best connection.
/// Returns latency in milliseconds on success.
#[tauri::command]
pub async fn test_server_connection(url: String, token: String) -> Result<u64, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| e.to_string())?;

    let probe_url = format!("{}/identity", url.trim_end_matches('/'));
    let start = std::time::Instant::now();

    client
        .get(&probe_url)
        .header("X-Plex-Token", &token)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?
        .error_for_status()
        .map_err(|e| format!("Server error: {}", e))?;

    Ok(start.elapsed().as_millis() as u64)
}

// ---------------------------------------------------------------------------
// Cache management
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Plex.tv OAuth (PIN-based authentication)
// ---------------------------------------------------------------------------


/// Start the Plex OAuth PIN flow.
///
/// Generates (or reuses) a stable client_id, creates a PIN on plex.tv,
/// and returns the pin_id (for polling) plus the auth_url to open in a browser.
#[tauri::command]
pub async fn plex_auth_start(app: tauri::AppHandle) -> Result<crate::plextv::PinInfo, String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    let mut settings = crate::plex::load_settings(&config_dir).map_err(|e| format!("{:#}", e))?;

    // Generate a stable per-installation client_id on first use.
    if settings.client_id.is_empty() {
        settings.client_id = uuid::Uuid::new_v4().to_string();
        crate::plex::save_settings(&config_dir, &settings).map_err(|e| format!("{:#}", e))?;
    }

    crate::plextv::create_pin(&settings.client_id)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Poll plex.tv to check whether the user has completed authentication.
///
/// Returns the auth token string if done, or null if still waiting.
/// Call every ~2 seconds from the frontend until a token arrives.
#[tauri::command]
pub async fn plex_auth_poll(pin_id: u64, app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    let settings = crate::plex::load_settings(&config_dir).map_err(|e| format!("{:#}", e))?;

    crate::plextv::poll_pin(&settings.client_id, pin_id)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get the authenticated user's Plex Media Servers from plex.tv.
///
/// Call this once `plex_auth_poll` returns a token.
/// Returns a list of servers filtered to local connections, local-first.
#[tauri::command]
pub async fn plex_get_resources(
    token: String,
    app: tauri::AppHandle,
) -> Result<Vec<crate::plextv::PlexResource>, String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    let settings = crate::plex::load_settings(&config_dir).map_err(|e| format!("{:#}", e))?;

    crate::plextv::get_resources(&settings.client_id, &token)
        .await
        .map_err(|e| format!("{:#}", e))
}

// ---------------------------------------------------------------------------
// Audio engine
// ---------------------------------------------------------------------------

/// Audio engine state managed by Tauri.
pub struct AudioEngineState(pub std::sync::Mutex<Option<crate::audio::AudioEngine>>);

impl AudioEngineState {
    pub fn new() -> Self {
        Self(std::sync::Mutex::new(None))
    }
}

/// Helper: lock the audio engine and send a command.
fn audio_send(
    state: &AudioEngineState,
    cmd: crate::audio::AudioCommand,
) -> Result<(), String> {
    let guard = state.0.lock().map_err(|e| format!("Audio lock poisoned: {e}"))?;
    match guard.as_ref() {
        Some(engine) => engine.send(cmd),
        None => Err("Audio engine not initialized.".to_string()),
    }
}

/// Start playing a track from the given URL.
#[tauri::command]
pub fn audio_play(
    url: String,
    rating_key: i64,
    duration_ms: i64,
    part_id: i64,
    parent_key: String,
    track_index: i64,
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    audio_send(&state, crate::audio::AudioCommand::Play(crate::audio::TrackMeta {
        url,
        rating_key,
        duration_ms,
        part_id,
        parent_key,
        track_index,
    }))
}

/// Pause audio playback.
#[tauri::command]
pub fn audio_pause(
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    audio_send(&state, crate::audio::AudioCommand::Pause)
}

/// Resume audio playback.
#[tauri::command]
pub fn audio_resume(
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    audio_send(&state, crate::audio::AudioCommand::Resume)
}

/// Stop audio playback and clear the current track.
#[tauri::command]
pub fn audio_stop(
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    audio_send(&state, crate::audio::AudioCommand::Stop)
}

/// Seek to a position in the current track.
#[tauri::command]
pub fn audio_seek(
    position_ms: i64,
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    audio_send(&state, crate::audio::AudioCommand::Seek(position_ms))
}

/// Set the playback volume (0.0 - 1.0).
#[tauri::command]
pub fn audio_set_volume(
    volume: f32,
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    audio_send(&state, crate::audio::AudioCommand::SetVolume(volume))
}

/// Pre-buffer the next track for gapless playback.
#[tauri::command]
pub fn audio_preload_next(
    url: String,
    rating_key: i64,
    duration_ms: i64,
    part_id: i64,
    parent_key: String,
    track_index: i64,
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    audio_send(&state, crate::audio::AudioCommand::PreloadNext(crate::audio::TrackMeta {
        url,
        rating_key,
        duration_ms,
        part_id,
        parent_key,
        track_index,
    }))
}

/// Warm the audio disk cache for a URL in the background.
/// Returns immediately — the fetch happens asynchronously.
#[tauri::command]
pub fn audio_prefetch(url: String, state: State<'_, AudioEngineState>) -> Result<(), String> {
    let guard = state.0.lock().map_err(|e| format!("Audio lock poisoned: {e}"))?;
    match guard.as_ref() {
        Some(engine) => { engine.prefetch_url(url); Ok(()) }
        None => Err("Audio engine not initialized.".to_string()),
    }
}

/// Serializable audio cache stats.
#[derive(serde::Serialize)]
pub struct AudioCacheInfo {
    pub size_bytes: u64,
    pub file_count: u32,
}

/// Return current audio cache usage (size in bytes + file count).
#[tauri::command]
pub fn audio_cache_info(state: State<'_, AudioEngineState>) -> Result<AudioCacheInfo, String> {
    let guard = state.0.lock().map_err(|e| format!("Audio lock poisoned: {e}"))?;
    match guard.as_ref() {
        Some(engine) => {
            let (size_bytes, file_count) = engine.cache_info();
            Ok(AudioCacheInfo { size_bytes, file_count })
        }
        None => Err("Audio engine not initialized.".to_string()),
    }
}

/// Delete all audio cache files from disk.
#[tauri::command]
pub fn audio_clear_cache(state: State<'_, AudioEngineState>) -> Result<(), String> {
    let guard = state.0.lock().map_err(|e| format!("Audio lock poisoned: {e}"))?;
    match guard.as_ref() {
        Some(engine) => { engine.clear_cache(); Ok(()) }
        None => Err("Audio engine not initialized.".to_string()),
    }
}

/// Set the maximum audio cache size in bytes.
/// Pass 0 for unlimited. Default is 1 GB (1_073_741_824).
#[tauri::command]
pub fn audio_set_cache_max_bytes(
    max_bytes: u64,
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    let guard = state.0.lock().map_err(|e| format!("Audio lock poisoned: {e}"))?;
    match guard.as_ref() {
        Some(engine) => { engine.set_max_cache_bytes(max_bytes); Ok(()) }
        None => Err("Audio engine not initialized.".to_string()),
    }
}

// ---------------------------------------------------------------------------
// Now Playing / system media controls
// ---------------------------------------------------------------------------

/// Push track metadata to the OS Now Playing system (macOS Control Centre,
/// Windows SMTC lock screen, Linux MPRIS2 panel).
///
/// `thumb_path` is a Plex path like `/library/metadata/123/thumb`.
/// The Rust side builds the full authenticated URL so the token never touches
/// the frontend logs.
#[tauri::command]
pub async fn update_now_playing(
    title: String,
    artist: String,
    album: String,
    thumb_path: Option<String>,
    duration_ms: u64,
    plex_state: State<'_, PlexState>,
    media_state: State<'_, MediaSessionState>,
) -> Result<(), String> {
    let cover_url = {
        let guard = plex_state.0.lock().await;
        guard
            .as_ref()
            .and_then(|c| thumb_path.as_ref().map(|p| c.thumb_url(p)))
    };

    media_state
        .0
        .send(MediaUpdate::Metadata { title, artist, album, cover_url, duration_ms })
        .map_err(|e| format!("Media session channel closed: {e}"))
}

/// Update the playback state shown in the OS media controls.
///
/// `playback_state` is `"playing"`, `"paused"`, or `"stopped"`.
#[tauri::command]
pub fn set_now_playing_state(
    playback_state: String,
    position_ms: Option<u64>,
    state: State<'_, MediaSessionState>,
) -> Result<(), String> {
    let update = match playback_state.as_str() {
        "playing" => MediaUpdate::Playing { position_ms: position_ms.unwrap_or(0) },
        "paused" => MediaUpdate::Paused { position_ms: position_ms.unwrap_or(0) },
        _ => MediaUpdate::Stopped,
    };
    state
        .0
        .send(update)
        .map_err(|e| format!("Media session channel closed: {e}"))
}

// ---------------------------------------------------------------------------
// Image cache management
// ---------------------------------------------------------------------------

/// Delete all cached Plex artwork from disk.
///
/// Called by the frontend Refresh button before re-fetching library data.
#[tauri::command]
pub async fn clear_image_cache(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("{:#}", e))?
        .join("pleximg");
    if cache_dir.exists() {
        std::fs::remove_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}
