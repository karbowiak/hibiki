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
    PlexClientConfig, PlexMedia, PlexSettings, ServerInfo, Tag, Track,
};
use crate::plex::lyrics::LyricLine;
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
    app: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::Manager;
    // Load the stable per-installation client_id so Plex can track this
    // client's sessions (required as X-Plex-Client-Identifier header for /:/timeline).
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    let settings = crate::plex::load_settings(&config_dir).map_err(|e| format!("{:#}", e))?;
    let client_id = if settings.client_id.is_empty() {
        "plexify-client".to_string()
    } else {
        settings.client_id
    };
    let config = PlexClientConfig {
        base_url,
        token,
        client_id,
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

/// Get albums (or artists/tracks) filtered by a tag (genre/mood/style).
#[tauri::command]
pub async fn get_items_by_tag(
    section_id: i64,
    tag_type: String,
    tag_name: String,
    libtype: Option<String>,
    state: State<'_, PlexState>,
) -> Result<Vec<PlexMedia>, String> {
    let c = client!(state);
    c.get_by_tag(section_id, &tag_type, &tag_name, libtype.as_deref(), None)
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
// Mixes
// ---------------------------------------------------------------------------

/// Fetch the track list for a "Mix for You" hub item.
///
/// Hub mixes have `rating_key = 0` so they can only be identified by their
/// `key` field.  This command resolves the key to a list of tracks so the
/// frontend can display them alongside the normal mix playback controls.
#[tauri::command]
pub async fn get_mix_tracks(
    key: String,
    state: State<'_, PlexState>,
) -> Result<Vec<Track>, String> {
    let c = client!(state);
    c.mix_tracks(&key)
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

/// Get artists that have been rated (liked) by the user.
///
/// Returns artists sorted by most recently rated.
#[tauri::command]
pub async fn get_liked_artists(
    section_id: i64,
    limit: Option<i32>,
    state: State<'_, PlexState>,
) -> Result<Vec<Artist>, String> {
    let c = client!(state);
    c.liked_artists(section_id, limit)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get albums that have been rated (liked) by the user.
///
/// Returns albums sorted by most recently rated.
#[tauri::command]
pub async fn get_liked_albums(
    section_id: i64,
    limit: Option<i32>,
    state: State<'_, PlexState>,
) -> Result<Vec<Album>, String> {
    let c = client!(state);
    c.liked_albums(section_id, limit)
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

/// Add items to an existing playlist.
#[tauri::command]
pub async fn add_items_to_playlist(
    playlist_id: i64,
    item_ids: Vec<i64>,
    state: State<'_, PlexState>,
) -> Result<(), String> {
    let c = client!(state);
    c.add_items(playlist_id, &item_ids)
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
/// Create a radio play queue seeded from any Plex item.
///
/// Uses the correct `server://` URI scheme so the Plex server generates
/// continuously refreshing, sonically-curated recommendations.
#[tauri::command]
pub async fn create_radio_queue(
    rating_key: i64,
    item_type: String,
    degrees_of_separation: Option<i32>,
    include_external: bool,
    shuffle: bool,
    state: State<'_, PlexState>,
) -> Result<PlayQueue, String> {
    let c = client!(state);
    c.create_radio_queue(rating_key, &item_type, degrees_of_separation, include_external, shuffle)
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
    item_type: String,
    dj_mode: Option<String>,
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
    c.create_smart_shuffle_queue(rating_key, &item_type, dj_mode.as_deref(), degrees_of_separation, include_external, &client_id)
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
    let client_id = c.client_id.clone();
    c.report_timeline(rating_key, playback_state, time_ms, duration_ms, Some(&client_id))
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
    gain_db: Option<f32>,
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    audio_send(&state, crate::audio::AudioCommand::Play(crate::audio::TrackMeta {
        url,
        rating_key,
        duration_ms,
        part_id,
        parent_key,
        track_index,
        gain_db,
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
    gain_db: Option<f32>,
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    audio_send(&state, crate::audio::AudioCommand::PreloadNext(crate::audio::TrackMeta {
        url,
        rating_key,
        duration_ms,
        part_id,
        parent_key,
        track_index,
        gain_db,
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

/// Set the crossfade window duration in milliseconds.
/// Pass 0 to disable crossfade. Default is 8000 ms (8 s).
/// Maximum recommended value is 30000 ms (30 s).
#[tauri::command]
pub fn audio_set_crossfade_window(
    ms: u64,
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    let guard = state.0.lock().map_err(|e| format!("Audio lock poisoned: {e}"))?;
    match guard.as_ref() {
        Some(engine) => { engine.set_crossfade_window(ms); Ok(()) }
        None => Err("Audio engine not initialized.".to_string()),
    }
}

/// Enable or disable ReplayGain audio normalization.
/// When enabled (default), tracks are volume-levelled using embedded REPLAYGAIN_TRACK_GAIN tags.
#[tauri::command]
pub fn audio_set_normalization_enabled(
    enabled: bool,
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    let guard = state.0.lock().map_err(|e| format!("Audio lock poisoned: {e}"))?;
    match guard.as_ref() {
        Some(engine) => { engine.set_normalization_enabled(enabled); Ok(()) }
        None => Err("Audio engine not initialized.".to_string()),
    }
}

/// Set all 10 EQ band gains in dB (±12 dB per band).
/// Recomputes biquad coefficients in the audio thread immediately.
#[tauri::command]
pub fn audio_set_eq(
    gains_db: [f32; 10],
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    let guard = state.0.lock().map_err(|e| format!("Audio lock poisoned: {e}"))?;
    match guard.as_ref() {
        Some(engine) => { engine.set_eq(gains_db); Ok(()) }
        None => Err("Audio engine not initialized.".to_string()),
    }
}

/// Enable or disable the 10-band graphic EQ.
/// When disabled the EQ processing is bypassed entirely (zero CPU cost).
#[tauri::command]
pub fn audio_set_eq_enabled(
    enabled: bool,
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    let guard = state.0.lock().map_err(|e| format!("Audio lock poisoned: {e}"))?;
    match guard.as_ref() {
        Some(engine) => { engine.set_eq_enabled(enabled); Ok(()) }
        None => Err("Audio engine not initialized.".to_string()),
    }
}

/// Set the pre-amp gain in dB (range −12..+3, default 0).
/// Applied before EQ in the output callback. Use this to recover headroom
/// after EQ boosts to prevent clipping.
#[tauri::command]
pub fn audio_set_preamp_gain(
    db: f32,
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    let guard = state.0.lock().map_err(|e| format!("Audio lock poisoned: {e}"))?;
    match guard.as_ref() {
        Some(engine) => { engine.set_preamp_gain(db); Ok(()) }
        None => Err("Audio engine not initialized.".to_string()),
    }
}

/// Enable or disable crossfade for consecutive same-album tracks.
/// When disabled (default), same-album tracks play gaplessly without any crossfade.
#[tauri::command]
pub fn audio_set_same_album_crossfade(
    enabled: bool,
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    let guard = state.0.lock().map_err(|e| format!("Audio lock poisoned: {e}"))?;
    match guard.as_ref() {
        Some(engine) => { engine.set_same_album_crossfade(enabled); Ok(()) }
        None => Err("Audio engine not initialized.".to_string()),
    }
}

/// Fetch parsed lyrics for a track. Returns an empty list if the track has no lyrics.
/// Prefers TTML over LRC; falls back to plain text.
#[tauri::command]
pub async fn get_lyrics(
    rating_key: i64,
    state: State<'_, PlexState>,
) -> Result<Vec<LyricLine>, String> {
    let guard = state.0.lock().await;
    let client = guard.as_ref().ok_or("Plex not connected")?;
    crate::plex::lyrics::get_lyrics(client, rating_key)
        .await
        .map_err(|e| e.to_string())
}

/// List available audio output device names for the default CPAL host.
#[tauri::command]
pub fn audio_get_output_devices() -> Vec<String> {
    crate::audio::engine::AudioEngine::get_output_devices()
}

/// Set the preferred audio output device by name.
/// Pass `null` to revert to the system default.
/// The change takes effect on the next Play command.
#[tauri::command]
pub fn audio_set_output_device(
    name: Option<String>,
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    let guard = state.0.lock().map_err(|e| format!("Audio lock poisoned: {e}"))?;
    match guard.as_ref() {
        Some(engine) => { engine.set_preferred_device(name); Ok(()) }
        None => Err("Audio engine not initialized.".to_string()),
    }
}

/// Enable or disable the PCM IPC bridge for the visualizer.
/// When enabled, emits `audio://vis-frame` events with mono PCM chunks.
/// Disable when the visualizer is closed to avoid unnecessary IPC overhead.
#[tauri::command]
pub fn audio_set_visualizer_enabled(
    enabled: bool,
    state: State<'_, AudioEngineState>,
) -> Result<(), String> {
    let guard = state.0.lock().map_err(|e| format!("Audio lock poisoned: {e}"))?;
    match guard.as_ref() {
        Some(engine) => { engine.set_visualizer_enabled(enabled); Ok(()) }
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

/// Delete all cached external metadata artwork from disk (Deezer, Apple Music, etc.).
#[tauri::command]
pub async fn clear_meta_image_cache(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("{:#}", e))?
        .join("metaimg");
    if cache_dir.exists() {
        std::fs::remove_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Returns file count and total byte size for both image caches (Plex + external metadata).
#[tauri::command]
pub async fn get_image_cache_info(
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("{:#}", e))?;

    fn dir_stats(dir: &std::path::Path) -> (usize, u64) {
        match std::fs::read_dir(dir) {
            Ok(entries) => {
                let mut count = 0usize;
                let mut bytes = 0u64;
                for entry in entries.flatten() {
                    if let Ok(meta) = entry.metadata() {
                        if meta.is_file() {
                            count += 1;
                            bytes += meta.len();
                        }
                    }
                }
                (count, bytes)
            }
            Err(_) => (0, 0),
        }
    }

    let (plex_files, plex_bytes) = dir_stats(&cache_root.join("pleximg"));
    let (meta_files, meta_bytes) = dir_stats(&cache_root.join("metaimg"));

    Ok(serde_json::json!({
        "plex_files": plex_files,
        "plex_bytes": plex_bytes,
        "meta_files": meta_files,
        "meta_bytes": meta_bytes,
    }))
}

// ---------------------------------------------------------------------------
// Last.fm integration
// ---------------------------------------------------------------------------

/// Persist the user's Last.fm API key and secret to settings.
///
/// The secret stays on disk and is only ever read by Rust — it is never
/// forwarded to the TypeScript frontend.
#[tauri::command]
pub async fn lastfm_save_credentials(
    api_key: String,
    api_secret: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    let mut settings = crate::plex::load_settings(&config_dir).map_err(|e| format!("{:#}", e))?;
    settings.lastfm_api_key = api_key;
    settings.lastfm_api_secret = api_secret;
    crate::plex::save_settings(&config_dir, &settings).map_err(|e| format!("{:#}", e))
}

/// Step 1 of Last.fm auth: request a temporary token.
///
/// Returns the token and the URL the user must open in their browser to grant access.
/// The API key is loaded from saved settings.
#[tauri::command]
pub async fn lastfm_get_token(
    app: tauri::AppHandle,
) -> Result<crate::lastfm::LastfmAuthToken, String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    let settings = crate::plex::load_settings(&config_dir).map_err(|e| format!("{:#}", e))?;
    if settings.lastfm_api_key.is_empty() {
        return Err("Last.fm API key is not configured".to_string());
    }
    crate::lastfm::get_token(&settings.lastfm_api_key)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Step 3 of Last.fm auth: exchange an authorized token for a permanent session key.
///
/// Saves the session key and username to settings on success.
#[tauri::command]
pub async fn lastfm_complete_auth(
    token: String,
    app: tauri::AppHandle,
) -> Result<crate::lastfm::LastfmSession, String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    let mut settings = crate::plex::load_settings(&config_dir).map_err(|e| format!("{:#}", e))?;

    if settings.lastfm_api_key.is_empty() || settings.lastfm_api_secret.is_empty() {
        return Err("Last.fm credentials are not configured".to_string());
    }

    let session =
        crate::lastfm::get_session(&settings.lastfm_api_key, &settings.lastfm_api_secret, &token)
            .await
            .map_err(|e| format!("{:#}", e))?;

    settings.lastfm_session_key = session.session_key.clone();
    settings.lastfm_username = session.username.clone();
    crate::plex::save_settings(&config_dir, &settings).map_err(|e| format!("{:#}", e))?;

    Ok(session)
}

/// Disconnect from Last.fm by clearing the session key and username from settings.
#[tauri::command]
pub async fn lastfm_disconnect(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    let mut settings = crate::plex::load_settings(&config_dir).map_err(|e| format!("{:#}", e))?;
    settings.lastfm_session_key = String::new();
    settings.lastfm_username = String::new();
    settings.lastfm_enabled = false;
    crate::plex::save_settings(&config_dir, &settings).map_err(|e| format!("{:#}", e))
}

/// Enable or disable Last.fm scrobbling and now-playing updates.
#[tauri::command]
pub async fn lastfm_set_enabled(enabled: bool, app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    let mut settings = crate::plex::load_settings(&config_dir).map_err(|e| format!("{:#}", e))?;
    settings.lastfm_enabled = enabled;
    crate::plex::save_settings(&config_dir, &settings).map_err(|e| format!("{:#}", e))
}

/// Set whether Last.fm metadata replaces (true) or augments (false) Plex data.
#[tauri::command]
pub async fn lastfm_set_replace_metadata(replace: bool, app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    let mut settings = crate::plex::load_settings(&config_dir).map_err(|e| format!("{:#}", e))?;
    settings.lastfm_replace_metadata = replace;
    crate::plex::save_settings(&config_dir, &settings).map_err(|e| format!("{:#}", e))
}

/// Set the minimum Plex rating (0–10) that triggers a Last.fm "love".
/// Plex scale: 0=unrated, 2=1★, 4=2★, 6=3★, 8=4★, 10=5★.
#[tauri::command]
pub async fn lastfm_set_love_threshold(threshold: u8, app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    let mut settings = crate::plex::load_settings(&config_dir).map_err(|e| format!("{:#}", e))?;
    settings.lastfm_love_threshold = threshold;
    crate::plex::save_settings(&config_dir, &settings).map_err(|e| format!("{:#}", e))
}

/// Notify Last.fm that a track has started playing (now-playing update).
///
/// No-op if Last.fm is disabled or the user is not authenticated.
/// Errors are mapped to Err strings but callers should treat them as non-fatal.
#[tauri::command]
pub async fn lastfm_update_now_playing(
    artist: String,
    track: String,
    album: String,
    album_artist: String,
    duration_ms: u64,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    let settings = crate::plex::load_settings(&config_dir).map_err(|e| format!("{:#}", e))?;

    if !settings.lastfm_enabled || settings.lastfm_session_key.is_empty() {
        return Ok(());
    }

    let duration_secs = (duration_ms / 1000) as u32;
    crate::lastfm::update_now_playing(
        &settings.lastfm_api_key,
        &settings.lastfm_api_secret,
        &settings.lastfm_session_key,
        &artist,
        &track,
        &album,
        &album_artist,
        duration_secs,
    )
    .await
    .map_err(|e| format!("{:#}", e))
}

/// Scrobble a track to Last.fm.
///
/// `started_at_unix` is the Unix timestamp (seconds) when playback began.
/// `listened_ms` is how many milliseconds the user actually listened.
/// No-op if Last.fm is disabled or not authenticated. Scrobble rules are
/// enforced in the `lastfm` module (>30s track, >50% listened or >4 min).
#[tauri::command]
pub async fn lastfm_scrobble(
    artist: String,
    track: String,
    album: String,
    album_artist: String,
    duration_ms: u64,
    started_at_unix: u64,
    listened_ms: u64,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    let settings = crate::plex::load_settings(&config_dir).map_err(|e| format!("{:#}", e))?;

    if !settings.lastfm_enabled || settings.lastfm_session_key.is_empty() {
        return Ok(());
    }

    let duration_secs = (duration_ms / 1000) as u32;
    let listened_secs = listened_ms / 1000;

    crate::lastfm::scrobble(
        &settings.lastfm_api_key,
        &settings.lastfm_api_secret,
        &settings.lastfm_session_key,
        &artist,
        &track,
        &album,
        &album_artist,
        duration_secs,
        started_at_unix,
        listened_secs,
    )
    .await
    .map_err(|e| format!("{:#}", e))
}

/// Love or unlove a track on Last.fm.
///
/// `love = true` → `track.love`, `love = false` → `track.unlove`.
/// No-op if Last.fm is not authenticated (enabled check is intentionally skipped
/// so ratings can sync even when scrobbling is temporarily disabled).
#[tauri::command]
pub async fn lastfm_love_track(
    artist: String,
    track: String,
    love: bool,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    let settings = crate::plex::load_settings(&config_dir).map_err(|e| format!("{:#}", e))?;

    if settings.lastfm_session_key.is_empty() {
        return Ok(());
    }

    crate::lastfm::love_track(
        &settings.lastfm_api_key,
        &settings.lastfm_api_secret,
        &settings.lastfm_session_key,
        &artist,
        &track,
        love,
    )
    .await
    .map_err(|e| format!("{:#}", e))
}

/// Fetch Last.fm artist metadata: biography, listeners, tags, similar artists.
///
/// Returns an error if the API key is not configured or the artist is not found.
/// TypeScript layer should catch and treat as no-data (return null from store).
#[tauri::command]
pub async fn lastfm_get_artist_info(
    artist: String,
    app: tauri::AppHandle,
) -> Result<crate::lastfm::LastfmArtistInfo, String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    let settings = crate::plex::load_settings(&config_dir).map_err(|e| format!("{:#}", e))?;
    if settings.lastfm_api_key.is_empty() {
        return Err("Last.fm API key not configured".to_string());
    }
    crate::lastfm::get_artist_info(&settings.lastfm_api_key, &artist)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Fetch Last.fm track metadata: listeners, play count, tags, wiki summary.
#[tauri::command]
pub async fn lastfm_get_track_info(
    artist: String,
    track: String,
    app: tauri::AppHandle,
) -> Result<crate::lastfm::LastfmTrackInfo, String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    let settings = crate::plex::load_settings(&config_dir).map_err(|e| format!("{:#}", e))?;
    if settings.lastfm_api_key.is_empty() {
        return Err("Last.fm API key not configured".to_string());
    }
    crate::lastfm::get_track_info(&settings.lastfm_api_key, &artist, &track)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Fetch Last.fm album metadata: tags and wiki summary.
#[tauri::command]
pub async fn lastfm_get_album_info(
    artist: String,
    album: String,
    app: tauri::AppHandle,
) -> Result<crate::lastfm::LastfmAlbumInfo, String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    let settings = crate::plex::load_settings(&config_dir).map_err(|e| format!("{:#}", e))?;
    if settings.lastfm_api_key.is_empty() {
        return Err("Last.fm API key not configured".to_string());
    }
    crate::lastfm::get_album_info(&settings.lastfm_api_key, &artist, &album)
        .await
        .map_err(|e| format!("{:#}", e))
}

// ---------------------------------------------------------------------------
// Deezer commands (no API key required — public endpoints)
// ---------------------------------------------------------------------------

/// Search Deezer for an artist and return image, fan count, and album count.
#[tauri::command]
pub async fn deezer_search_artist(
    artist: String,
) -> Result<Option<crate::deezer::DeezerArtistInfo>, String> {
    crate::deezer::search_artist(&artist)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Search Deezer for an album and return cover art, genres, fans, label, and release date.
#[tauri::command]
pub async fn deezer_search_album(
    artist: String,
    album: String,
) -> Result<Option<crate::deezer::DeezerAlbumInfo>, String> {
    crate::deezer::search_album(&artist, &album)
        .await
        .map_err(|e| format!("{:#}", e))
}

// ---------------------------------------------------------------------------
// iTunes commands (no API key required — public endpoints)
// ---------------------------------------------------------------------------

/// Search iTunes for an artist and return genre info.
#[tauri::command]
pub async fn itunes_search_artist(
    artist: String,
) -> Result<Option<crate::itunes::ItunesArtistInfo>, String> {
    crate::itunes::search_artist(&artist)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Search iTunes for an album and return cover art, genre, and release date.
#[tauri::command]
pub async fn itunes_search_album(
    artist: String,
    album: String,
) -> Result<Option<crate::itunes::ItunesAlbumInfo>, String> {
    crate::itunes::search_album(&artist, &album)
        .await
        .map_err(|e| format!("{:#}", e))
}
