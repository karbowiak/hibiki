//! Tauri command bridge — exposes the Plex API to the frontend via invoke()
//!
//! All commands are async and return Result<T, String> so errors surface cleanly
//! in TypeScript. The PlexClient is stored in Tauri managed state; call
//! `connect_plex` first before using any other command.

use tauri::State;
use tokio::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::mediasession::{MediaSessionState, MediaUpdate};
use crate::plex::lyrics::LyricLine;
use crate::plex::models::{Album, Artist};
use crate::plex::{
    Hub, IdentityResponse, Level, LibrarySection, PlayQueue, Playlist, PlexClient,
    PlexClientConfig, PlexMedia, PlexSettings, ServerInfo, Tag, Track,
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// Shared Plex client state managed by Tauri.
pub struct PlexState(pub Mutex<Option<PlexClient>>, AtomicU64);

/// Identifies the account/server/library that originated a provider request.
#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlexRequestContext {
    connection_revision: u64,
    cache_scope: String,
}

impl PlexState {
    pub fn new() -> Self {
        PlexState(Mutex::new(None), AtomicU64::new(0))
    }

    async fn reset_with_audio_revocation(
        &self,
        clear_config: Option<&std::path::Path>,
        revoke_audio: impl FnOnce(),
    ) -> Result<u64, String> {
        let mut client = self.0.lock().await;
        let revision = self.1.fetch_add(1, Ordering::SeqCst) + 1;
        // Audio ingress uses this same lock. Every accepted old play precedes
        // this stop; no retired request can enqueue after it.
        revoke_audio();
        *client = None;
        if let Some(directory) = clear_config {
            crate::plex::update_settings(directory, |settings| {
                settings.base_url.clear();
                settings.token.clear();
                settings.all_urls.clear();
                settings.machine_identifier.clear();
                settings.section_id = 0;
                settings.section_uuid.clear();
                settings.tls_exceptions.clear();
                Ok(())
            })
            .map_err(|error| format!("{error:#}"))?;
        }
        Ok(revision)
    }

    #[cfg(test)]
    async fn reset(&self, clear_config: Option<&std::path::Path>) -> Result<u64, String> {
        self.reset_with_audio_revocation(clear_config, || {}).await
    }

    #[cfg(test)]
    async fn begin_connection(&self) -> u64 {
        self.reset(None).await.unwrap()
    }

    async fn persist_with_audio_revocation(
        &self,
        revision: u64,
        directory: &std::path::Path,
        urls: Vec<String>,
        section_id: Option<i64>,
        section_uuid: Option<String>,
        revoke_audio: impl FnOnce(),
    ) -> Result<(), String> {
        let mut guard = self.0.lock().await;
        if !self.is_current(revision) {
            return Err("Plex connection was superseded".into());
        }
        let client = guard.as_mut().ok_or("Plex client not connected")?;
        let scope =
            client.cache_scope_for_library(section_id.unwrap_or(0), section_uuid.as_deref());
        crate::plex::update_settings(directory, |settings| {
            settings.base_url = client.base_url().to_string();
            settings.token = client.token.clone();
            settings.machine_identifier = client.machine_identifier.clone();
            settings.all_urls = urls;
            settings.section_id = section_id.unwrap_or(0);
            settings.section_uuid = section_uuid.unwrap_or_default();
            Ok(())
        })
        .map_err(|error| format!("{error:#}"))?;
        if client.library_scope != scope {
            revoke_audio();
        }
        client.library_scope = scope;
        Ok(())
    }

    #[cfg(test)]
    async fn persist(
        &self,
        revision: u64,
        directory: &std::path::Path,
        urls: Vec<String>,
        section_id: Option<i64>,
        section_uuid: Option<String>,
    ) -> Result<(), String> {
        self.persist_with_audio_revocation(
            revision,
            directory,
            urls,
            section_id,
            section_uuid,
            || {},
        )
        .await
    }

    /// Validate and enqueue under connection ownership, capturing an immutable
    /// HTTP client/header snapshot before asynchronous audio work starts.
    pub(crate) async fn dispatch_audio(
        &self,
        context: Option<&PlexRequestContext>,
        url: &str,
        send: impl FnOnce(crate::audio_engine::source::MediaSource) -> Result<u64, String>,
    ) -> Result<u64, String> {
        if let Some(context) = context {
            let guard = self.0.lock().await;
            let client = self.checked_client(context, &guard)?;
            if !client.is_plex_url(url) {
                return Err("Audio URL does not belong to this Plex server".into());
            }
            send(crate::audio_engine::source::MediaSource::new(
                client.media_request(url),
                Some(&client.library_scope),
            )?)
        } else {
            // Public episodes never inherit a same-host Plex token/TLS exception.
            send(crate::audio_engine::source::MediaSource::new(
                crate::plex::client::public_media_request(url),
                None,
            )?)
        }
    }

    fn is_current(&self, revision: u64) -> bool {
        self.1.load(Ordering::SeqCst) == revision
    }

    fn checked_client<'a>(
        &self,
        context: &PlexRequestContext,
        current: &'a Option<PlexClient>,
    ) -> Result<&'a PlexClient, String> {
        if !self.is_current(context.connection_revision) {
            return Err("Plex connection was superseded".into());
        }
        let client = current.as_ref().ok_or("Plex client not connected")?;
        if context.cache_scope.is_empty() || context.cache_scope != client.library_scope {
            return Err("Plex music library was superseded".into());
        }
        Ok(client)
    }

    async fn client_for(&self, context: &PlexRequestContext) -> Result<PlexClient, String> {
        let current = self.0.lock().await;
        self.checked_client(context, &current).cloned()
    }

    pub(crate) async fn image_context(&self) -> crate::image_protocol::ImageContext {
        let client = self.0.lock().await;
        crate::image_protocol::ImageContext::new(self.1.load(Ordering::SeqCst), client.clone())
    }

    pub(crate) async fn image_context_is_current(&self, context: &crate::image_protocol::ImageContext) -> bool {
        let client = self.0.lock().await;
        context.matches(self.1.load(Ordering::SeqCst), client.as_ref())
    }

    async fn publish(&self, revision: u64, client: PlexClient) -> Result<(), String> {
        let mut current = self.0.lock().await;
        if !self.is_current(revision) {
            return Err("Plex connection was superseded".into());
        }
        *current = Some(client);
        Ok(())
    }
}

/// Take a snapshot only when the originating connection and library still own it.
macro_rules! client {
    ($state:expr, $context:expr) => {{
        $state.client_for(&$context).await?
    }};
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlexConnectionInfo {
    machine_identifier: String,
    sections: Vec<LibrarySection>,
    cache_scopes: std::collections::BTreeMap<String, String>,
}

/// Revoke the native connection before asynchronous work begins. Logout also
/// removes only the saved Plex connection, preserving unrelated integrations.
#[tauri::command]
pub async fn disconnect_plex(
    clear_saved: bool,
    state: State<'_, PlexState>,
    app: tauri::AppHandle,
) -> Result<u64, String> {
    use tauri::Manager;
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("{error:#}"))?;
    state
        .reset_with_audio_revocation(clear_saved.then_some(directory.as_path()), || {
            if let Some(audio) = app.try_state::<crate::audio_engine::bridge::AudioEngineState>() {
                let _ = audio.0.send(crate::audio_engine::command::Command::Stop);
            }
        })
        .await
}

/// Connect to a Plex Media Server.
///
/// Must be called before any other command. The connection is held in state
/// for the lifetime of the application.
#[tauri::command]
pub async fn connect_plex(
    base_url: String,
    token: String,
    accept_invalid_certs: Option<bool>,
    expected_machine_identifier: Option<String>,
    connection_revision: u64,
    state: State<'_, PlexState>,
    app: tauri::AppHandle,
) -> Result<PlexConnectionInfo, String> {
    use tauri::Manager;
    let revision = connection_revision;
    // Load the stable per-installation client_id so Plex can track this
    // client's sessions (required as X-Plex-Client-Identifier header for /:/timeline).
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("{:#}", e))?;
    let allow_invalid = {
        // Serialize preference changes with connection ownership, too.
        let _guard = state.0.lock().await;
        if !state.is_current(revision) {
            return Err("Plex connection was superseded".into());
        }
        crate::plex::tls::preference(&config_dir, &base_url, accept_invalid_certs)
            .map_err(|e| format!("{:#}", e))?
    };
    let (_, identity) = crate::plex::tls::probe(
        &base_url,
        allow_invalid,
        expected_machine_identifier.as_deref(),
    )
    .await
    .map_err(|e| format!("{:#}", e))?;
    let client_id =
        crate::plex::auth::ensure_client_id(&config_dir).map_err(|e| format!("{:#}", e))?;
    let config = PlexClientConfig {
        base_url,
        token,
        client_id,
        accept_invalid_certs: allow_invalid,
        ..Default::default()
    };
    let mut client = PlexClient::new(config).map_err(|e| format!("{:#}", e))?;
    if !state.is_current(revision) {
        return Err("Plex connection was superseded".into());
    }
    client.machine_identifier = identity.machine_identifier;
    // Do not publish a client with rejected credentials.
    let sections = client
        .get_all_sections()
        .await
        .map_err(|_| "Plex authentication or library access failed".to_string())?;
    let machine_identifier = client.machine_identifier.clone();
    let cache_scopes = sections
        .iter()
        .map(|section| {
            (
                section.key.to_string(),
                client.cache_scope_for_library(section.key, section.uuid.as_deref()),
            )
        })
        .collect();
    state.publish(revision, client).await?;
    Ok(PlexConnectionInfo {
        machine_identifier,
        sections,
        cache_scopes,
    })
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

/// Get all library sections (music, video, photo, etc.)
#[tauri::command]
pub async fn get_library_sections(
    context: PlexRequestContext,
    state: State<'_, PlexState>,
) -> Result<Vec<LibrarySection>, String> {
    let c = client!(state, context);
    c.get_all_sections().await.map_err(|e| format!("{:#}", e))
}

/// Search a library section.
///
/// `libtype` filters by item type: "artist", "album", "track" for music.
#[tauri::command]
pub async fn search_library(
    context: PlexRequestContext,
    section_id: i64,
    query: String,
    libtype: Option<String>,
    state: State<'_, PlexState>,
) -> Result<Vec<crate::plex::PlexMedia>, String> {
    let c = client!(state, context);
    c.search(section_id, &query, libtype.as_deref(), None, None, Some(50))
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get recently added items in a section.
#[tauri::command]
pub async fn get_recently_added(
    context: PlexRequestContext,
    section_id: i64,
    libtype: Option<String>,
    limit: Option<i32>,
    state: State<'_, PlexState>,
) -> Result<Vec<crate::plex::PlexMedia>, String> {
    let c = client!(state, context);
    c.recently_added(section_id, libtype.as_deref(), limit)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get discovery hubs for a section (home screen content).
#[tauri::command]
pub async fn get_hubs(
    context: PlexRequestContext,
    section_id: i64,
    state: State<'_, PlexState>,
) -> Result<Vec<Hub>, String> {
    let c = client!(state, context);
    c.get_section_hubs(section_id)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get "on deck" / continue listening items.
#[tauri::command]
pub async fn get_on_deck(
    context: PlexRequestContext,
    section_id: i64,
    state: State<'_, PlexState>,
) -> Result<Vec<crate::plex::PlexMedia>, String> {
    let c = client!(state, context);
    c.on_deck(section_id).await.map_err(|e| format!("{:#}", e))
}

/// Get tags (genres, moods, styles) for a library section.
///
/// `tag_type` should be "genre", "mood", or "style".
#[tauri::command]
pub async fn get_section_tags(
    context: PlexRequestContext,
    section_id: i64,
    tag_type: String,
    state: State<'_, PlexState>,
) -> Result<Vec<Tag>, String> {
    let c = client!(state, context);
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
    context: PlexRequestContext,
    rating_key: i64,
    state: State<'_, PlexState>,
) -> Result<Track, String> {
    let c = client!(state, context);
    c.get_track(rating_key)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get an artist by rating key.
#[tauri::command]
pub async fn get_artist(
    context: PlexRequestContext,
    rating_key: i64,
    state: State<'_, PlexState>,
) -> Result<Artist, String> {
    let c = client!(state, context);
    c.get_artist(rating_key)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get an album by rating key.
#[tauri::command]
pub async fn get_album(
    context: PlexRequestContext,
    rating_key: i64,
    state: State<'_, PlexState>,
) -> Result<Album, String> {
    let c = client!(state, context);
    c.get_album(rating_key)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get albums by an artist with an optional format filter.
///
/// `format_filter` values:
/// - `null` / `None` → all albums
/// - `"Single"` → only singles
/// - `"!Single"` → full albums and EPs (excludes singles)
#[tauri::command]
pub async fn get_artist_albums(
    context: PlexRequestContext,
    rating_key: i64,
    format_filter: Option<String>,
    state: State<'_, PlexState>,
) -> Result<Vec<Album>, String> {
    let c = client!(state, context);
    c.artist_albums(rating_key, format_filter.as_deref())
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get all tracks in an album.
#[tauri::command]
pub async fn get_album_tracks(
    context: PlexRequestContext,
    rating_key: i64,
    state: State<'_, PlexState>,
) -> Result<Vec<Track>, String> {
    let c = client!(state, context);
    c.album_tracks(rating_key)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get popular tracks for an artist (legacy: /library/all sort by ratingCount).
#[tauri::command]
pub async fn get_artist_popular_tracks(
    context: PlexRequestContext,
    rating_key: i64,
    limit: Option<i32>,
    state: State<'_, PlexState>,
) -> Result<Vec<Track>, String> {
    let c = client!(state, context);
    c.artist_popular_tracks(rating_key, limit)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get popular tracks for an artist using the /popularLeaves endpoint.
#[tauri::command]
pub async fn get_artist_popular_leaves(
    context: PlexRequestContext,
    rating_key: i64,
    limit: Option<i32>,
    state: State<'_, PlexState>,
) -> Result<Vec<Track>, String> {
    let c = client!(state, context);
    c.artist_popular_leaves(rating_key, limit)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Paginated result from `get_items_by_tag`.
#[derive(serde::Serialize)]
pub struct PagedMediaItems {
    pub items: Vec<PlexMedia>,
    pub total: i64,
}

/// Get albums (or artists/tracks) filtered by a tag (genre/mood/style).
#[tauri::command]
pub async fn get_items_by_tag(
    context: PlexRequestContext,
    section_id: i64,
    tag_type: String,
    tag_name: String,
    libtype: Option<String>,
    limit: Option<i32>,
    offset: Option<i32>,
    state: State<'_, PlexState>,
) -> Result<PagedMediaItems, String> {
    let c = client!(state, context);
    let (items, total) = c
        .get_by_tag(
            section_id,
            &tag_type,
            &tag_name,
            libtype.as_deref(),
            limit,
            offset,
        )
        .await
        .map_err(|e| format!("{:#}", e))?;
    Ok(PagedMediaItems { items, total })
}

/// Get metadata-based similar artists for an artist.
#[tauri::command]
pub async fn get_artist_similar(
    context: PlexRequestContext,
    rating_key: i64,
    state: State<'_, PlexState>,
) -> Result<Vec<Artist>, String> {
    let c = client!(state, context);
    c.artist_similar(rating_key)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get hubs related to a specific item.
#[tauri::command]
pub async fn get_related_hubs(
    context: PlexRequestContext,
    rating_key: i64,
    limit: Option<i32>,
    state: State<'_, PlexState>,
) -> Result<Vec<Hub>, String> {
    let c = client!(state, context);
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
    context: PlexRequestContext,
    rating_key: i64,
    limit: Option<i32>,
    max_distance: Option<f64>,
    state: State<'_, PlexState>,
) -> Result<Vec<Artist>, String> {
    let c = client!(state, context);
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
    context: PlexRequestContext,
    section_id: i64,
    rating_key: i64,
    format: Option<String>,
    state: State<'_, PlexState>,
) -> Result<Vec<Album>, String> {
    let c = client!(state, context);
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
    context: PlexRequestContext,
    section_id: i64,
    rating_key: i64,
    limit: Option<i32>,
    state: State<'_, PlexState>,
) -> Result<Vec<Track>, String> {
    let c = client!(state, context);
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
    context: PlexRequestContext,
    key: String,
    state: State<'_, PlexState>,
) -> Result<Vec<Track>, String> {
    let c = client!(state, context);
    c.mix_tracks(&key).await.map_err(|e| format!("{:#}", e))
}

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

/// List all playlists in a section.
#[tauri::command]
pub async fn get_playlists(
    context: PlexRequestContext,
    section_id: i64,
    state: State<'_, PlexState>,
) -> Result<Vec<Playlist>, String> {
    let c = client!(state, context);
    c.list_playlists(section_id, None)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get tracks that have been rated (liked) by the user.
///
/// Returns tracks sorted by most recently rated.
#[tauri::command]
pub async fn get_liked_tracks(
    context: PlexRequestContext,
    section_id: i64,
    limit: Option<i32>,
    state: State<'_, PlexState>,
) -> Result<Vec<Track>, String> {
    let c = client!(state, context);
    c.liked_tracks(section_id, limit)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get artists that have been rated (liked) by the user.
///
/// Returns artists sorted by most recently rated.
#[tauri::command]
pub async fn get_liked_artists(
    context: PlexRequestContext,
    section_id: i64,
    limit: Option<i32>,
    state: State<'_, PlexState>,
) -> Result<Vec<Artist>, String> {
    let c = client!(state, context);
    c.liked_artists(section_id, limit)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get albums that have been rated (liked) by the user.
///
/// Returns albums sorted by most recently rated.
#[tauri::command]
pub async fn get_liked_albums(
    context: PlexRequestContext,
    section_id: i64,
    limit: Option<i32>,
    state: State<'_, PlexState>,
) -> Result<Vec<Album>, String> {
    let c = client!(state, context);
    c.liked_albums(section_id, limit)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get all tracks in a playlist.
#[tauri::command]
pub async fn get_playlist_items(
    context: PlexRequestContext,
    playlist_id: i64,
    limit: Option<i32>,
    offset: Option<i32>,
    state: State<'_, PlexState>,
) -> Result<Vec<Track>, String> {
    let c = client!(state, context);
    c.get_playlist_items(playlist_id, limit, offset)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Create a new playlist.
#[tauri::command]
pub async fn create_playlist(
    context: PlexRequestContext,
    title: String,
    section_id: i64,
    item_ids: Vec<i64>,
    state: State<'_, PlexState>,
) -> Result<Playlist, String> {
    let c = client!(state, context);
    c.create_playlist(&title, section_id, &item_ids)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Add items to an existing playlist.
#[tauri::command]
pub async fn add_items_to_playlist(
    context: PlexRequestContext,
    playlist_id: i64,
    item_ids: Vec<i64>,
    state: State<'_, PlexState>,
) -> Result<(), String> {
    let c = client!(state, context);
    c.add_items(playlist_id, &item_ids)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Remove items from a playlist by their playlist-specific item IDs.
#[tauri::command]
pub async fn remove_items_from_playlist(
    context: PlexRequestContext,
    playlist_id: i64,
    playlist_item_ids: Vec<i64>,
    state: State<'_, PlexState>,
) -> Result<(), String> {
    let c = client!(state, context);
    c.remove_items(playlist_id, &playlist_item_ids)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Move an item within a playlist (reorder).
#[tauri::command]
pub async fn move_playlist_item(
    context: PlexRequestContext,
    playlist_id: i64,
    item_id: i64,
    after_item_id: i64,
    state: State<'_, PlexState>,
) -> Result<(), String> {
    let c = client!(state, context);
    c.move_item(playlist_id, item_id, after_item_id)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Delete a playlist.
#[tauri::command]
pub async fn delete_playlist(
    context: PlexRequestContext,
    playlist_id: i64,
    state: State<'_, PlexState>,
) -> Result<(), String> {
    let c = client!(state, context);
    c.delete_playlist(playlist_id)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Edit playlist metadata (title, summary).
#[tauri::command]
pub async fn edit_playlist(
    context: PlexRequestContext,
    playlist_id: i64,
    title: Option<String>,
    summary: Option<String>,
    state: State<'_, PlexState>,
) -> Result<(), String> {
    let c = client!(state, context);
    c.edit_playlist(playlist_id, title.as_deref(), summary.as_deref())
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
    context: PlexRequestContext,
    uri: String,
    shuffle: bool,
    repeat: i32,
    state: State<'_, PlexState>,
) -> Result<PlayQueue, String> {
    let c = client!(state, context);
    c.create_play_queue(&uri, shuffle, repeat)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Fetch an existing play queue.
#[tauri::command]
pub async fn get_play_queue(
    context: PlexRequestContext,
    queue_id: i64,
    state: State<'_, PlexState>,
) -> Result<PlayQueue, String> {
    let c = client!(state, context);
    c.get_play_queue(queue_id)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Add items to a play queue.
#[tauri::command]
pub async fn add_to_play_queue(
    context: PlexRequestContext,
    queue_id: i64,
    uri: String,
    next: bool,
    state: State<'_, PlexState>,
) -> Result<PlayQueue, String> {
    let c = client!(state, context);
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
    context: PlexRequestContext,
    rating_key: i64,
    item_type: String,
    degrees_of_separation: Option<i32>,
    include_external: bool,
    shuffle: bool,
    state: State<'_, PlexState>,
) -> Result<PlayQueue, String> {
    let c = client!(state, context);
    c.create_radio_queue(
        rating_key,
        &item_type,
        degrees_of_separation,
        include_external,
        shuffle,
    )
    .await
    .map_err(|e| format!("{:#}", e))
}

/// Create a smart-shuffle (Guest DJ) play queue.
///
/// Same as `create_radio_queue` but with Plex's AI-curated `smartShuffle` mode
/// and the DJ persona header. Reads the installation's client ID from saved settings.
#[tauri::command]
pub async fn create_smart_shuffle_queue(
    context: PlexRequestContext,
    rating_key: i64,
    item_type: String,
    dj_mode: Option<String>,
    degrees_of_separation: Option<i32>,
    include_external: bool,
    state: State<'_, PlexState>,
) -> Result<PlayQueue, String> {
    let c = client!(state, context);
    let client_id = c.client_id.clone();
    c.create_smart_shuffle_queue(
        rating_key,
        &item_type,
        dj_mode.as_deref(),
        degrees_of_separation,
        include_external,
        &client_id,
    )
    .await
    .map_err(|e| format!("{:#}", e))
}

// ---------------------------------------------------------------------------
// Playback tracking
// ---------------------------------------------------------------------------

/// Mark an item as played (scrobble).
#[tauri::command]
pub async fn mark_played(
    context: PlexRequestContext,
    rating_key: i64,
    state: State<'_, PlexState>,
) -> Result<(), String> {
    let c = client!(state, context);
    c.mark_played(rating_key)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Mark an item as unplayed.
#[tauri::command]
pub async fn mark_unplayed(
    context: PlexRequestContext,
    rating_key: i64,
    state: State<'_, PlexState>,
) -> Result<(), String> {
    let c = client!(state, context);
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
    context: PlexRequestContext,
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
    let c = client!(plex_state, context);
    let client_id = c.client_id.clone();
    c.report_timeline(
        rating_key,
        playback_state,
        time_ms,
        duration_ms,
        Some(&client_id),
    )
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
    context: PlexRequestContext,
    rating_key: i64,
    rating: Option<f64>,
    state: State<'_, PlexState>,
) -> Result<(), String> {
    let c = client!(state, context);
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
    context: PlexRequestContext,
    rating_key: i64,
    limit: Option<i32>,
    max_distance: Option<f64>,
    state: State<'_, PlexState>,
) -> Result<Vec<Track>, String> {
    let c = client!(state, context);
    c.sonically_similar::<Track>(rating_key, limit, max_distance)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get a track radio (mix) seeded from a track.
#[tauri::command]
pub async fn get_track_radio(
    context: PlexRequestContext,
    section_id: i64,
    rating_key: i64,
    limit: Option<i32>,
    state: State<'_, PlexState>,
) -> Result<Vec<Track>, String> {
    let c = client!(state, context);
    c.track_radio(section_id, rating_key, limit, None)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get radio stations seeded from an artist.
#[tauri::command]
pub async fn get_artist_stations(
    context: PlexRequestContext,
    rating_key: i64,
    state: State<'_, PlexState>,
) -> Result<Vec<Playlist>, String> {
    let c = client!(state, context);
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
    context: PlexRequestContext,
    section_id: i64,
    state: State<'_, PlexState>,
) -> Result<Vec<Hub>, String> {
    let c = client!(state, context);
    c.section_stations(section_id)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Compute a sonic path between two tracks.
#[tauri::command]
pub async fn compute_sonic_path(
    context: PlexRequestContext,
    section_id: i64,
    from_id: i64,
    to_id: i64,
    state: State<'_, PlexState>,
) -> Result<Vec<Track>, String> {
    let c = client!(state, context);
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
    context: PlexRequestContext,
    stream_id: i64,
    sub_sample: Option<i32>,
    state: State<'_, PlexState>,
) -> Result<Vec<Level>, String> {
    let c = client!(state, context);
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
    context: PlexRequestContext,
    part_key: String,
    state: State<'_, PlexState>,
) -> Result<String, String> {
    let client = client!(state, context);
    Ok(client.direct_play_url(&part_key))
}

/// Build a thumbnail/artwork URL.
///
/// `thumb_path` comes from `track.thumb`, `album.thumb`, `artist.thumb`, etc.
#[tauri::command]
pub async fn get_thumb_url(
    context: PlexRequestContext,
    thumb_path: String,
    state: State<'_, PlexState>,
) -> Result<String, String> {
    let client = client!(state, context);
    Ok(client.thumb_url(&thumb_path))
}

/// Build an audio transcode URL.
///
/// Use when the client cannot play the native format.
/// `bitrate` in kbps (e.g. 320), `codec` e.g. "mp3" / "aac" / "opus".
#[tauri::command]
pub async fn get_audio_transcode_url(
    context: PlexRequestContext,
    part_key: String,
    bitrate: Option<i32>,
    codec: Option<String>,
    state: State<'_, PlexState>,
) -> Result<String, String> {
    let client = client!(state, context);
    Ok(client.audio_transcode_url(&part_key, bitrate, codec.as_deref()))
}

/// Download an audio file's bytes via the Rust HTTP client.
///
/// The audio engine uses this instead of `fetch()` from inside WKWebView,
/// because CFNetwork drops large media transfers with `NSURLErrorNetworkConnectionLost`
/// (Tauri's WKWebView fetch is unreliable for multi-MB media bodies). Routing
/// through reqwest also gets the proper Plex headers, retry middleware, and
/// `accept_invalid_certs` for `*.plex.direct` self-signed certs for free.
///
/// Returns raw binary via `tauri::ipc::Response`, which avoids the JSON/base64
/// IPC serialization overhead and lands as an ArrayBuffer on the JS side.
#[tauri::command]
pub async fn fetch_audio_bytes(
    context: PlexRequestContext,
    url: String,
    state: State<'_, PlexState>,
) -> Result<tauri::ipc::Response, String> {
    let c = client!(state, context);
    let bytes = c.fetch_bytes(&url).await.map_err(|e| format!("{:#}", e))?;
    Ok(tauri::ipc::Response::new(bytes))
}

// ---------------------------------------------------------------------------
// Server info (Phase 5)
// ---------------------------------------------------------------------------

/// Get the server's identity (machine ID, version, claimed status).
#[tauri::command]
pub async fn get_identity(
    context: PlexRequestContext,
    state: State<'_, PlexState>,
) -> Result<IdentityResponse, String> {
    let c = client!(state, context);
    c.get_identity().await.map_err(|e| format!("{:#}", e))
}

/// Get full server capabilities and metadata.
#[tauri::command]
pub async fn get_server_info(
    context: PlexRequestContext,
    state: State<'_, PlexState>,
) -> Result<ServerInfo, String> {
    let c = client!(state, context);
    c.get_server_info().await.map_err(|e| format!("{:#}", e))
}

// ---------------------------------------------------------------------------
// Settings persistence (Phase 5)
// ---------------------------------------------------------------------------

/// Load saved connection settings (server URL + token) from disk.
///
/// Returns empty strings if no settings have been saved yet.
#[tauri::command]
pub async fn load_settings(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    crate::plex::load_settings(&config_dir).map(|settings| settings.public_view()).map_err(|e| format!("{:#}", e))
}

/// Persist the verified current connection, rejecting retired ownership revisions.
///
/// Reads the native client rather than trusting frontend credentials.
/// `all_urls` stores every known connection URL for the server (local, remote,
/// relay) so the app can fall back if the primary URL becomes unreachable.
#[tauri::command]
pub async fn save_settings(
    connection_revision: u64,
    all_urls: Vec<String>,
    section_id: Option<i64>,
    section_uuid: Option<String>,
    state: State<'_, PlexState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::Manager;
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("{:#}", e))?;
    state
        .persist_with_audio_revocation(
            connection_revision,
            &config_dir,
            all_urls,
            section_id,
            section_uuid,
            || {
                if let Some(audio) =
                    app.try_state::<crate::audio_engine::bridge::AudioEngineState>()
                {
                    let _ = audio.0.send(crate::audio_engine::command::Command::Stop);
                }
            },
        )
        .await
}

/// Quickly probe a Plex server URL to check reachability and measure latency.
///
/// Uses a 5-second timeout with no retries — intended for parallel probing of
/// multiple candidate URLs to find the fastest/best connection.
/// Returns latency in milliseconds on success.
#[tauri::command]
pub async fn test_server_connection(url: String, expected_machine_identifier: Option<String>, app: tauri::AppHandle) -> Result<u64, String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    let allow_invalid = crate::plex::tls::preference(&config_dir, &url, None).map_err(|e| format!("{:#}", e))?;
    crate::plex::tls::probe(&url, allow_invalid, expected_machine_identifier.as_deref()).await
        .map(|(latency, _)| latency).map_err(|e| format!("{:#}", e))
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
    let client_id =
        crate::plex::auth::ensure_client_id(&config_dir).map_err(|e| format!("{:#}", e))?;
    crate::plextv::create_pin(&client_id)
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

/// Fetch parsed lyrics for a track. Returns an empty list if the track has no lyrics.
/// Prefers TTML over LRC; falls back to plain text.
#[tauri::command]
pub async fn get_lyrics(
    context: PlexRequestContext,
    rating_key: i64,
    state: State<'_, PlexState>,
) -> Result<Vec<LyricLine>, String> {
    let c = client!(state, context);
    crate::plex::lyrics::get_lyrics(&c, rating_key)
        .await
        .map_err(|e| e.to_string())
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
    context: PlexRequestContext,
    title: String,
    artist: String,
    album: String,
    thumb_path: Option<String>,
    duration_ms: u64,
    plex_state: State<'_, PlexState>,
    media_state: State<'_, MediaSessionState>,
) -> Result<(), String> {
    // Send while holding ownership, so a retired metadata message cannot be
    // queued after the next connection's update.
    let guard = plex_state.0.lock().await;
    let client = plex_state.checked_client(&context, &guard)?;
    let cover_url = thumb_path.as_ref().map(|path| client.thumb_url(path));

    media_state
        .0
        .send(MediaUpdate::Metadata {
            title,
            artist,
            album,
            cover_url,
            duration_ms,
        })
        .map_err(|e| format!("Media session channel closed: {e}"))
}

/// Update the playback state shown in the OS media controls.
///
/// `playback_state` is `"playing"`, `"paused"`, or `"stopped"`.
#[tauri::command]
pub async fn set_now_playing_state(
    context: PlexRequestContext,
    playback_state: String,
    position_ms: Option<u64>,
    plex_state: State<'_, PlexState>,
    state: State<'_, MediaSessionState>,
) -> Result<(), String> {
    let guard = plex_state.0.lock().await;
    plex_state.checked_client(&context, &guard)?;
    let update = match playback_state.as_str() {
        "playing" => MediaUpdate::Playing {
            position_ms: position_ms.unwrap_or(0),
        },
        "paused" => MediaUpdate::Paused {
            position_ms: position_ms.unwrap_or(0),
        },
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

/// Clear completes before acknowledgement; old downloads cannot refill the cache.
#[tauri::command]
pub async fn clear_image_cache(
    state: tauri::State<'_, crate::image_cache::ImageCacheState>,
) -> Result<crate::image_cache::CacheInfo, String> {
    let cache = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || cache.clear())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_image_cache_info(
    state: tauri::State<'_, crate::image_cache::ImageCacheState>,
) -> Result<crate::image_cache::CacheInfo, String> {
    let cache = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || cache.stats())
        .await
        .map_err(|e| e.to_string())?
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
    crate::plex::update_settings(&config_dir, |settings| {
        settings.lastfm_auth_revision = settings.lastfm_auth_revision.wrapping_add(1);
        if settings.lastfm_api_key != api_key || settings.lastfm_api_secret != api_secret {
            settings.lastfm_session_key.clear();
            settings.lastfm_username.clear();
            settings.lastfm_enabled = false;
        }
        settings.lastfm_api_key = api_key;
        settings.lastfm_api_secret = api_secret;
        Ok(())
    })
    .map_err(|e| format!("{:#}", e))
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
    let settings = crate::plex::update_settings(&config_dir, |settings| {
        settings.lastfm_auth_revision = settings.lastfm_auth_revision.wrapping_add(1);
        Ok(settings.clone())
    })
    .map_err(|e| format!("{:#}", e))?;

    if settings.lastfm_api_key.is_empty() || settings.lastfm_api_secret.is_empty() {
        return Err("Last.fm credentials are not configured".to_string());
    }

    let session = crate::lastfm::get_session(
        &settings.lastfm_api_key,
        &settings.lastfm_api_secret,
        &token,
    )
    .await
    .map_err(|e| format!("{:#}", e))?;

    crate::plex::auth::finish_lastfm_auth(
        &config_dir,
        &settings,
        &session.session_key,
        &session.username,
    )
    .map_err(|e| format!("{:#}", e))?;

    Ok(session)
}

/// Disconnect from Last.fm by clearing the session key and username from settings.
#[tauri::command]
pub async fn lastfm_disconnect(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    crate::plex::update_settings(&config_dir, |settings| {
        settings.lastfm_auth_revision = settings.lastfm_auth_revision.wrapping_add(1);
        settings.lastfm_session_key = String::new();
        settings.lastfm_username = String::new();
        settings.lastfm_enabled = false;
        Ok(())
    })
    .map_err(|e| format!("{:#}", e))
}

/// Enable or disable Last.fm scrobbling and now-playing updates.
#[tauri::command]
pub async fn lastfm_set_enabled(enabled: bool, app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    crate::plex::update_settings(&config_dir, |settings| {
        settings.lastfm_enabled = enabled;
        Ok(())
    })
    .map_err(|e| format!("{:#}", e))
}

/// Set whether Last.fm metadata replaces (true) or augments (false) Plex data.
#[tauri::command]
pub async fn lastfm_set_replace_metadata(
    replace: bool,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    crate::plex::update_settings(&config_dir, |settings| {
        settings.lastfm_replace_metadata = replace;
        Ok(())
    })
    .map_err(|e| format!("{:#}", e))
}

/// Set the minimum Plex rating (0–10) that triggers a Last.fm "love".
/// Plex scale: 0=unrated, 2=1★, 4=2★, 6=3★, 8=4★, 10=5★.
#[tauri::command]
pub async fn lastfm_set_love_threshold(threshold: u8, app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    crate::plex::update_settings(&config_dir, |settings| {
        settings.lastfm_love_threshold = threshold;
        Ok(())
    })
    .map_err(|e| format!("{:#}", e))
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

// ---------------------------------------------------------------------------
// MusicBrainz commands (no API key required — public endpoints)
// ---------------------------------------------------------------------------

/// Fetch MusicBrainz artist info: tags, area, type, Wikipedia URL.
#[tauri::command]
pub async fn musicbrainz_get_artist_info(
    artist: String,
) -> Result<Option<crate::musicbrainz::MusicBrainzArtistInfo>, String> {
    crate::musicbrainz::get_artist_info(&artist)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Fetch MusicBrainz album info: tags, release type, release date.
#[tauri::command]
pub async fn musicbrainz_get_album_info(
    artist: String,
    album: String,
) -> Result<Option<crate::musicbrainz::MusicBrainzAlbumInfo>, String> {
    crate::musicbrainz::get_album_info(&artist, &album)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Look up MusicBrainz recording MBIDs for a track (for ListenBrainz submission).
#[tauri::command]
pub async fn musicbrainz_lookup_recording(
    artist: String,
    track: String,
    album: String,
) -> Result<Option<crate::musicbrainz::MusicBrainzRecordingMbids>, String> {
    crate::musicbrainz::lookup_recording_mbids(&artist, &track, &album)
        .await
        .map_err(|e| format!("{:#}", e))
}

// ---------------------------------------------------------------------------
// ListenBrainz commands
// ---------------------------------------------------------------------------

/// Validate a ListenBrainz token, save to settings, and return the username.
#[tauri::command]
pub async fn listenbrainz_save_token(
    token: String,
    app: tauri::AppHandle,
) -> Result<crate::listenbrainz::ListenBrainzTokenResult, String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    let revision = crate::plex::update_settings(&config_dir, |settings| {
        settings.listenbrainz_auth_revision = settings.listenbrainz_auth_revision.wrapping_add(1);
        Ok(settings.listenbrainz_auth_revision)
    })
    .map_err(|e| format!("{:#}", e))?;
    let result = crate::listenbrainz::validate_token(&token)
        .await
        .map_err(|e| format!("{:#}", e))?;

    crate::plex::auth::finish_listenbrainz_auth(&config_dir, revision, &token, &result.username)
        .map_err(|e| format!("{:#}", e))?;

    Ok(result)
}

/// Disconnect from ListenBrainz by clearing the token and username.
#[tauri::command]
pub async fn listenbrainz_disconnect(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    crate::plex::update_settings(&config_dir, |settings| {
        settings.listenbrainz_auth_revision = settings.listenbrainz_auth_revision.wrapping_add(1);
        settings.listenbrainz_token = String::new();
        settings.listenbrainz_username = String::new();
        settings.listenbrainz_enabled = false;
        Ok(())
    })
    .map_err(|e| format!("{:#}", e))
}

/// Enable or disable ListenBrainz scrobbling.
#[tauri::command]
pub async fn listenbrainz_set_enabled(enabled: bool, app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    crate::plex::update_settings(&config_dir, |settings| {
        settings.listenbrainz_enabled = enabled;
        Ok(())
    })
    .map_err(|e| format!("{:#}", e))
}

/// Submit a "now playing" update to ListenBrainz.
///
/// No-op if ListenBrainz is disabled or token is empty.
/// Optional MBID fields improve matching on the ListenBrainz side.
#[tauri::command]
pub async fn listenbrainz_submit_now_playing(
    artist: String,
    track: String,
    album: String,
    duration_ms: u64,
    recording_mbid: Option<String>,
    artist_mbids: Option<Vec<String>>,
    release_mbid: Option<String>,
    release_group_mbid: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    let settings = crate::plex::load_settings(&config_dir).map_err(|e| format!("{:#}", e))?;

    if !settings.listenbrainz_enabled || settings.listenbrainz_token.is_empty() {
        return Ok(());
    }

    crate::listenbrainz::submit_now_playing(
        &settings.listenbrainz_token,
        &artist,
        &track,
        &album,
        duration_ms,
        &recording_mbid.unwrap_or_default(),
        &artist_mbids.unwrap_or_default(),
        &release_mbid.unwrap_or_default(),
        &release_group_mbid.unwrap_or_default(),
    )
    .await
    .map_err(|e| format!("{:#}", e))
}

/// Submit a completed listen to ListenBrainz.
///
/// No-op if ListenBrainz is disabled or token is empty.
/// Optional MBID fields improve matching on the ListenBrainz side.
#[tauri::command]
pub async fn listenbrainz_submit_listen(
    artist: String,
    track: String,
    album: String,
    duration_ms: u64,
    listened_at: u64,
    recording_mbid: Option<String>,
    artist_mbids: Option<Vec<String>>,
    release_mbid: Option<String>,
    release_group_mbid: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    let settings = crate::plex::load_settings(&config_dir).map_err(|e| format!("{:#}", e))?;

    if !settings.listenbrainz_enabled || settings.listenbrainz_token.is_empty() {
        return Ok(());
    }

    crate::listenbrainz::submit_listen(
        &settings.listenbrainz_token,
        &artist,
        &track,
        &album,
        duration_ms,
        listened_at,
        &recording_mbid.unwrap_or_default(),
        &artist_mbids.unwrap_or_default(),
        &release_mbid.unwrap_or_default(),
        &release_group_mbid.unwrap_or_default(),
    )
    .await
    .map_err(|e| format!("{:#}", e))
}

// ---------------------------------------------------------------------------
// Local SQLite database
// ---------------------------------------------------------------------------

use crate::db::{self, DbInfo, DbState};

/// Convenience macro: lock the DbState mutex (sync — not async).
macro_rules! db_conn {
    ($state:expr) => {{
        $state.0.lock().map_err(|e| format!("db lock error: {e}"))?
    }};
}

// ---- KV ----

#[tauri::command]
pub fn db_kv_get(db: State<'_, DbState>, key: String) -> Result<Option<String>, String> {
    let conn = db_conn!(db);
    db::kv::get(&conn, &key)
}

#[tauri::command]
pub fn db_kv_set(db: State<'_, DbState>, key: String, value: String) -> Result<(), String> {
    let conn = db_conn!(db);
    db::kv::set(&conn, &key, &value)
}

// ---- Info ----

#[tauri::command]
pub fn db_get_info(db: State<'_, DbState>) -> Result<DbInfo, String> {
    let conn = db_conn!(db);
    Ok(DbInfo {
        artist_count: db::artists::count(&conn)?,
        album_count: db::albums::count(&conn)?,
        track_count: db::tracks::count(&conn)?,
        playlist_count: db::playlists::count(&conn)?,
        tag_count: conn
            .query_row("SELECT COUNT(*) FROM tags", [], |r| r.get(0))
            .map_err(|e| format!("count error: {e}"))?,
        play_history_count: conn
            .query_row("SELECT COUNT(*) FROM play_history", [], |r| r.get(0))
            .map_err(|e| format!("count error: {e}"))?,
    })
}

// ---- Artists ----

#[tauri::command]
pub fn db_upsert_artist(db: State<'_, DbState>, artist: Artist) -> Result<(), String> {
    let conn = db_conn!(db);
    db::artists::upsert(&conn, &artist)
}

#[tauri::command]
pub fn db_upsert_artists(db: State<'_, DbState>, artists: Vec<Artist>) -> Result<(), String> {
    let conn = db_conn!(db);
    db::artists::upsert_bulk(&conn, &artists)
}

#[tauri::command]
pub fn db_get_artist(
    db: State<'_, DbState>,
    id: i64,
) -> Result<Option<db::artists::ArtistRow>, String> {
    let conn = db_conn!(db);
    db::artists::get(&conn, id)
}

#[tauri::command]
pub fn db_search_artists(
    db: State<'_, DbState>,
    query: String,
    limit: i64,
) -> Result<Vec<db::artists::ArtistRow>, String> {
    let conn = db_conn!(db);
    db::artists::search(&conn, &query, limit)
}

#[tauri::command]
pub fn db_get_artist_count(db: State<'_, DbState>) -> Result<i64, String> {
    let conn = db_conn!(db);
    db::artists::count(&conn)
}

// ---- Albums ----

#[tauri::command]
pub fn db_upsert_album(db: State<'_, DbState>, album: Album) -> Result<(), String> {
    let conn = db_conn!(db);
    db::albums::upsert(&conn, &album)
}

#[tauri::command]
pub fn db_upsert_albums(db: State<'_, DbState>, albums: Vec<Album>) -> Result<(), String> {
    let conn = db_conn!(db);
    db::albums::upsert_bulk(&conn, &albums)
}

#[tauri::command]
pub fn db_get_album(
    db: State<'_, DbState>,
    id: i64,
) -> Result<Option<db::albums::AlbumRow>, String> {
    let conn = db_conn!(db);
    db::albums::get(&conn, id)
}

#[tauri::command]
pub fn db_search_albums(
    db: State<'_, DbState>,
    query: String,
    limit: i64,
) -> Result<Vec<db::albums::AlbumRow>, String> {
    let conn = db_conn!(db);
    db::albums::search(&conn, &query, limit)
}

#[tauri::command]
pub fn db_get_albums_by_artist(
    db: State<'_, DbState>,
    artist_id: i64,
) -> Result<Vec<db::albums::AlbumRow>, String> {
    let conn = db_conn!(db);
    db::albums::get_by_artist(&conn, artist_id)
}

#[tauri::command]
pub fn db_get_album_count(db: State<'_, DbState>) -> Result<i64, String> {
    let conn = db_conn!(db);
    db::albums::count(&conn)
}

// ---- Tracks ----

#[tauri::command]
pub fn db_upsert_track(db: State<'_, DbState>, track: Track) -> Result<(), String> {
    let conn = db_conn!(db);
    db::tracks::upsert(&conn, &track)
}

#[tauri::command]
pub fn db_upsert_tracks(db: State<'_, DbState>, tracks: Vec<Track>) -> Result<(), String> {
    let conn = db_conn!(db);
    db::tracks::upsert_bulk(&conn, &tracks)
}

#[tauri::command]
pub fn db_get_track(
    db: State<'_, DbState>,
    id: i64,
) -> Result<Option<db::tracks::TrackRow>, String> {
    let conn = db_conn!(db);
    db::tracks::get(&conn, id)
}

#[tauri::command]
pub fn db_search_tracks(
    db: State<'_, DbState>,
    query: String,
    limit: i64,
) -> Result<Vec<db::tracks::TrackRow>, String> {
    let conn = db_conn!(db);
    db::tracks::search(&conn, &query, limit)
}

#[tauri::command]
pub fn db_get_tracks_by_album(
    db: State<'_, DbState>,
    album_id: i64,
) -> Result<Vec<db::tracks::TrackRow>, String> {
    let conn = db_conn!(db);
    db::tracks::get_by_album(&conn, album_id)
}

#[tauri::command]
pub fn db_get_track_count(db: State<'_, DbState>) -> Result<i64, String> {
    let conn = db_conn!(db);
    db::tracks::count(&conn)
}

// ---- Playlists ----

#[tauri::command]
pub fn db_upsert_playlists(db: State<'_, DbState>, playlists: Vec<Playlist>) -> Result<(), String> {
    let conn = db_conn!(db);
    db::playlists::upsert_bulk(&conn, &playlists)
}

#[tauri::command]
pub fn db_get_playlists(db: State<'_, DbState>) -> Result<Vec<db::playlists::PlaylistRow>, String> {
    let conn = db_conn!(db);
    db::playlists::get_all(&conn)
}

#[tauri::command]
pub fn db_add_playlist_track(
    db: State<'_, DbState>,
    playlist_id: i64,
    track_id: i64,
    position: i64,
    added_by: String,
) -> Result<(), String> {
    let conn = db_conn!(db);
    db::playlists::add_track(&conn, playlist_id, track_id, position, None, &added_by)
}

#[tauri::command]
pub fn db_get_playlist_tracks(
    db: State<'_, DbState>,
    playlist_id: i64,
) -> Result<Vec<db::playlists::PlaylistTrackRow>, String> {
    let conn = db_conn!(db);
    db::playlists::get_tracks(&conn, playlist_id)
}

// ---------------------------------------------------------------------------
// Radio Browser (internet radio)
// ---------------------------------------------------------------------------

/// Search internet radio stations by name, tag, country, etc.
#[tauri::command]
pub async fn radiobrowser_search(
    params: crate::radiobrowser::SearchParams,
) -> Result<Vec<crate::radiobrowser::RadioStation>, String> {
    crate::radiobrowser::search_stations(params)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get top stations by category ("topvote", "topclick", "lastclick").
#[tauri::command]
pub async fn radiobrowser_top_stations(
    category: String,
    count: u32,
) -> Result<Vec<crate::radiobrowser::RadioStation>, String> {
    crate::radiobrowser::top_stations(&category, count)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get all countries with station counts.
#[tauri::command]
pub async fn radiobrowser_countries() -> Result<Vec<crate::radiobrowser::RadioCountry>, String> {
    crate::radiobrowser::get_countries()
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Get popular tags/genres with station counts.
#[tauri::command]
pub async fn radiobrowser_tags(limit: u32) -> Result<Vec<crate::radiobrowser::RadioTag>, String> {
    crate::radiobrowser::get_tags(limit)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Register a click on a station for community stats (fire-and-forget).
#[tauri::command]
pub async fn radiobrowser_click(uuid: String) -> Result<(), String> {
    crate::radiobrowser::register_click(&uuid)
        .await
        .map_err(|e| format!("{:#}", e))
}

// ---------------------------------------------------------------------------
// Podcasts (iTunes Search + RSS)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn podcast_search(
    query: String,
    limit: Option<u32>,
) -> Result<Vec<crate::podcast::PodcastSearchResult>, String> {
    crate::podcast::search_podcasts(&query, limit.unwrap_or(20))
        .await
        .map_err(|e| format!("{:#}", e))
}

#[tauri::command]
pub async fn podcast_get_top(
    category: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<crate::podcast::PodcastTopChart>, String> {
    crate::podcast::get_top_podcasts(category, limit.unwrap_or(20))
        .await
        .map_err(|e| format!("{:#}", e))
}

#[tauri::command]
pub async fn podcast_get_feed(feed_url: String) -> Result<crate::podcast::PodcastDetail, String> {
    crate::podcast::get_podcast_feed(&feed_url)
        .await
        .map_err(|e| format!("{:#}", e))
}

#[tauri::command]
pub async fn podcast_lookup(
    itunes_id: u64,
) -> Result<Option<crate::podcast::PodcastSearchResult>, String> {
    crate::podcast::lookup_podcast(itunes_id)
        .await
        .map_err(|e| format!("{:#}", e))
}

#[tauri::command]
pub async fn podcast_get_categories() -> Result<Vec<crate::podcast::PodcastCategory>, String> {
    crate::podcast::get_podcast_categories()
        .await
        .map_err(|e| format!("{:#}", e))
}

// ---------------------------------------------------------------------------
// Genius integration
// ---------------------------------------------------------------------------

/// Save Genius API credentials to settings.
#[tauri::command]
pub async fn genius_save_credentials(
    client_id: String,
    client_secret: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    crate::plex::update_settings(&config_dir, |settings| {
        settings.genius_client_id = client_id;
        settings.genius_client_secret = client_secret;
        Ok(())
    })
    .map_err(|e| format!("{:#}", e))
}

/// Disconnect Genius — clear credentials from settings.
#[tauri::command]
pub async fn genius_disconnect(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    crate::plex::update_settings(&config_dir, |settings| {
        settings.genius_client_id = String::new();
        settings.genius_client_secret = String::new();
        settings.genius_enabled = false;
        settings.genius_always_fetch = false;
        Ok(())
    })
    .map_err(|e| format!("{:#}", e))
}

/// Enable or disable Genius lyrics fetching.
#[tauri::command]
pub async fn genius_set_enabled(enabled: bool, app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    crate::plex::update_settings(&config_dir, |settings| {
        settings.genius_enabled = enabled;
        Ok(())
    })
    .map_err(|e| format!("{:#}", e))
}

/// Toggle whether Genius should always fetch lyrics (even when Plex has them).
#[tauri::command]
pub async fn genius_set_always_fetch(
    always_fetch: bool,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    crate::plex::update_settings(&config_dir, |settings| {
        settings.genius_always_fetch = always_fetch;
        Ok(())
    })
    .map_err(|e| format!("{:#}", e))
}

/// Search Genius for songs matching "{artist} {track}".
#[tauri::command]
pub async fn genius_search(
    artist: String,
    track: String,
    app: tauri::AppHandle,
) -> Result<Vec<crate::genius::GeniusSearchHit>, String> {
    use tauri::Manager;
    let config_dir = app.path().app_config_dir().map_err(|e| format!("{:#}", e))?;
    let settings = crate::plex::load_settings(&config_dir).map_err(|e| format!("{:#}", e))?;

    if settings.genius_client_id.is_empty() || settings.genius_client_secret.is_empty() {
        return Err("Genius credentials not configured".to_string());
    }

    let token = crate::genius::get_access_token(&settings.genius_client_id, &settings.genius_client_secret)
        .await
        .map_err(|e| format!("{:#}", e))?;

    crate::genius::search(&token, &artist, &track)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Scrape lyrics from a Genius song page URL.
#[tauri::command]
pub async fn genius_get_lyrics(
    song_url: String,
) -> Result<Vec<crate::genius::GeniusLyricLine>, String> {
    crate::genius::scrape_lyrics(&song_url)
        .await
        .map_err(|e| format!("{:#}", e))
}

// ---------------------------------------------------------------------------
// Generic HTTP proxy
// ---------------------------------------------------------------------------

/// Generic HTTP GET that returns JSON. Used by frontend-only backends (e.g. Demo/Deezer)
/// to bypass CORS without needing per-endpoint Rust commands.
#[tauri::command]
pub async fn http_get_json(url: String) -> Result<serde_json::Value, String> {
    use crate::http_response::{BoundedResponseExt, MAX_JSON_BYTES};
    static CLIENT: once_cell::sync::Lazy<reqwest::Client> = once_cell::sync::Lazy::new(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .expect("http client")
    });
    let resp = CLIENT.get(&url).send().await.map_err(|e| e.without_url().to_string())?;
    let json = resp.bounded_json::<serde_json::Value>(MAX_JSON_BYTES).await.map_err(|e| format!("{e:#}"))?;
    Ok(json)
}

// ---------------------------------------------------------------------------
// Audio device detection
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_audio_output_device() -> String {
    crate::audio_devices::get_default_output_device_name()
}

#[tauri::command]
pub fn get_audio_output_devices() -> Vec<crate::audio_devices::AudioOutputDevice> {
    crate::audio_devices::get_output_devices()
}

#[cfg(test)]
mod connection_tests {
    use super::*;

    fn scoped_client(base: &str, token: &str, library: i64) -> PlexClient {
        let mut client = PlexClient::new(PlexClientConfig {
            base_url: base.into(),
            token: token.into(),
            ..Default::default()
        })
        .unwrap();
        client.machine_identifier = "test-server".into();
        client.library_scope = client.cache_scope_for_library(library, None);
        client
    }

    #[tokio::test]
    async fn image_snapshots_retire_on_library_changes_and_same_origin_reconnection() {
        let state = PlexState::new();
        let revision = state.begin_connection().await;
        state.publish(revision, scoped_client("https://server.test", "dummy-old", 1)).await.unwrap();
        let original = state.image_context().await;
        assert!(state.image_context_is_current(&original).await);
        state.0.lock().await.as_mut().unwrap().library_scope = "changed-library".into();
        assert!(!state.image_context_is_current(&original).await);
        let changed = state.image_context().await;
        let next = state.begin_connection().await;
        assert!(!state.image_context_is_current(&changed).await);
        state.publish(next, scoped_client("https://server.test", "dummy-new", 1)).await.unwrap();
        assert!(!state.image_context_is_current(&original).await);
        assert!(state.image_context_is_current(&state.image_context().await).await);
        assert_eq!(original.client.unwrap().token, "dummy-old");
    }

    #[tokio::test]
    async fn queued_audio_keeps_its_account_snapshot_after_same_origin_reconnection() {
        let state = PlexState::new();
        let revision = state.begin_connection().await;
        let old = scoped_client("https://server.test", "dummy-old", 1);
        let context = PlexRequestContext {
            connection_revision: revision,
            cache_scope: old.library_scope.clone(),
        };
        state.publish(revision, old).await.unwrap();
        let mut queued = None;
        state
            .dispatch_audio(
                Some(&context),
                "https://server.test/file?X-Plex-Token=dummy-url",
                |request| {
                    queued = Some(request);
                    Ok(1)
                },
            )
            .await
            .unwrap();
        let next = state.begin_connection().await;
        state
            .publish(next, scoped_client("https://server.test", "dummy-new", 1))
            .await
            .unwrap();
        let original = queued.unwrap();
        for _ in 0..2 {
            let retry = original.request.try_clone().unwrap().build().unwrap();
            assert_eq!(retry.headers()["X-Plex-Token"], "dummy-old");
            assert!(!retry
                .url()
                .query_pairs()
                .any(|(key, _)| key.eq_ignore_ascii_case("X-Plex-Token")));
        }
        assert!(state
            .dispatch_audio(Some(&context), "https://server.test/file", |_| panic!(
                "Retired audio must not enqueue"
            ))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn cache_identity_uses_validated_native_scope_even_with_an_old_caller_token() {
        let directory = tempfile::tempdir().unwrap();
        let cache = crate::audio_engine::cache::AudioCache::new(directory.path().into(), None);
        let state = PlexState::new();
        let revision = state.begin_connection().await;
        let client = scoped_client("https://server.test", "dummy-old", 1);
        let context = PlexRequestContext {
            connection_revision: revision,
            cache_scope: client.library_scope.clone(),
        };
        state.publish(revision, client).await.unwrap();
        let url = "https://server.test/file.flac?X-Plex-Token=dummy-old";
        let mut key = String::new();
        state
            .dispatch_audio(Some(&context), url, |source| {
                key = source.cache_key;
                let mut writer = cache.begin_write(&key, &source.extension).unwrap();
                writer.write_chunk(b"old private audio").unwrap();
                writer.finish(&cache).unwrap();
                cache.set_computed_gain(&key, -6.0);
                Ok(1)
            })
            .await
            .unwrap();
        let revision = state.begin_connection().await;
        let client = scoped_client("https://server.test", "dummy-new", 1);
        let context = PlexRequestContext {
            connection_revision: revision,
            cache_scope: client.library_scope.clone(),
        };
        state.publish(revision, client).await.unwrap();
        for context in [Some(&context), None] {
            state
                .dispatch_audio(context, url, |source| {
                    assert_ne!(source.cache_key, key);
                    assert!(cache.lookup(&source.cache_key).is_none());
                    assert_eq!(cache.get_computed_gain(&source.cache_key), None);
                    let request = source.request.build().unwrap();
                    if context.is_some() {
                        assert_eq!(request.headers()["X-Plex-Token"], "dummy-new");
                    } else {
                        assert!(!request.headers().contains_key("X-Plex-Token"));
                    }
                    assert!(request.url().query().is_none());
                    Ok(2)
                })
                .await
                .unwrap();
        }
        // Existing files remain on disk; new sources simply cannot address them.
        assert!(cache.lookup(&key).is_some());
    }

    #[tokio::test]
    async fn authenticated_audio_rejects_wrong_library_and_origin_before_enqueue() {
        let state = PlexState::new();
        let revision = state.begin_connection().await;
        let client = scoped_client("https://server.test", "dummy-token", 1);
        let mut context = PlexRequestContext {
            connection_revision: revision,
            cache_scope: client.library_scope.clone(),
        };
        state.publish(revision, client).await.unwrap();
        for url in [
            "https://external.test/file",
            "http://server.test/file",
            "https://server.test:444/file",
            "https://user:pass@server.test/file",
        ] {
            assert_eq!(
                state
                    .dispatch_audio(Some(&context), url, |_| panic!(
                        "Wrong-origin audio must not enqueue"
                    ))
                    .await
                    .unwrap_err(),
                "Audio URL does not belong to this Plex server"
            );
        }
        context.cache_scope = "wrong-library".into();
        assert_eq!(
            state
                .dispatch_audio(Some(&context), "https://server.test/file", |_| panic!(
                    "Wrong-library audio must not enqueue"
                ))
                .await
                .unwrap_err(),
            "Plex music library was superseded"
        );
    }

    #[tokio::test]
    async fn public_audio_on_the_plex_host_never_inherits_its_private_credentials() {
        let state = PlexState::new();
        let revision = state.begin_connection().await;
        state
            .publish(
                revision,
                scoped_client("https://server.test", "dummy-private", 1),
            )
            .await
            .unwrap();
        state
            .dispatch_audio(
                None,
                "https://server.test/podcast?X-Plex-Token=dummy-url",
                |request| {
                    let request = request.request.build().unwrap();
                    assert!(!request.headers().contains_key("X-Plex-Token"));
                    assert!(!request
                        .url()
                        .query_pairs()
                        .any(|(key, _)| key.eq_ignore_ascii_case("X-Plex-Token")));
                    Ok(1)
                },
            )
            .await
            .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn native_revocation_waits_for_accepted_audio_and_prevents_late_enqueue() {
        use std::future::Future;
        let state = std::sync::Arc::new(PlexState::new());
        let revision = state.begin_connection().await;
        let client = scoped_client("https://server.test", "dummy-token", 1);
        let context = PlexRequestContext {
            connection_revision: revision,
            cache_scope: client.library_scope.clone(),
        };
        state.publish(revision, client).await.unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let order = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let (entered, ready) = tokio::sync::oneshot::channel();
        let queued = {
            let state = state.clone();
            let barrier = barrier.clone();
            let order = order.clone();
            let context = context.clone();
            tokio::spawn(async move {
                state
                    .dispatch_audio(Some(&context), "https://server.test/file", |_| {
                        entered.send(()).unwrap();
                        barrier.wait();
                        order.lock().unwrap().push("play");
                        Ok(1)
                    })
                    .await
                    .unwrap()
            })
        };
        ready.await.unwrap();
        let revocation = state.reset_with_audio_revocation(None, || order.lock().unwrap().push("stop"));
        tokio::pin!(revocation);
        let pending = std::future::poll_fn(|cx| {
            std::task::Poll::Ready(revocation.as_mut().poll(cx).is_pending())
        })
        .await;
        assert!(pending, "Native stop must wait for accepted audio ingress");
        barrier.wait();
        queued.await.unwrap();
        revocation.await.unwrap();
        assert_eq!(*order.lock().unwrap(), vec!["play", "stop"]);
        assert!(state
            .dispatch_audio(Some(&context), "https://server.test/file", |_| panic!(
                "Late audio must not enqueue after stop"
            ))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn library_changes_revoke_audio_once_and_reject_the_previous_source_context() {
        let state = PlexState::new();
        let directory = tempfile::tempdir().unwrap();
        let revision = state.begin_connection().await;
        let client = scoped_client("https://server.test", "dummy-token", 1);
        let context = PlexRequestContext {
            connection_revision: revision,
            cache_scope: client.library_scope.clone(),
        };
        state.publish(revision, client).await.unwrap();
        let stops = std::sync::atomic::AtomicU64::new(0);
        state
            .persist_with_audio_revocation(revision, directory.path(), vec![], Some(1), None, || {
                stops.fetch_add(1, Ordering::SeqCst);
            })
            .await
            .unwrap();
        assert_eq!(stops.load(Ordering::SeqCst), 0);
        state
            .persist_with_audio_revocation(revision, directory.path(), vec![], Some(2), None, || {
                stops.fetch_add(1, Ordering::SeqCst);
            })
            .await
            .unwrap();
        assert_eq!(stops.load(Ordering::SeqCst), 1);
        assert!(state
            .dispatch_audio(Some(&context), "https://server.test/file", |_| panic!(
                "Previous library must not enqueue"
            ))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn provider_requests_cannot_pick_up_a_replacement_account_even_with_the_same_scope() {
        let state = PlexState::new();
        let revision = state.begin_connection().await;
        let old = scoped_client("https://old.test", "dummy-old", 1);
        let context = PlexRequestContext {
            connection_revision: revision,
            cache_scope: old.library_scope.clone(),
        };
        state.publish(revision, old).await.unwrap();
        let snapshot = state.client_for(&context).await.unwrap();
        let next = state.begin_connection().await;
        let mut replacement = scoped_client("https://new.test", "dummy-new", 1);
        replacement.library_scope = context.cache_scope.clone();
        state.publish(next, replacement).await.unwrap();
        assert_eq!(
            state.client_for(&context).await.unwrap_err(),
            "Plex connection was superseded"
        );
        assert_eq!(snapshot.base_url(), "https://old.test");
        assert_eq!(snapshot.token, "dummy-old");
        let current = PlexRequestContext {
            connection_revision: next,
            ..context
        };
        assert_eq!(
            state.client_for(&current).await.unwrap().base_url(),
            "https://new.test"
        );
    }

    #[tokio::test]
    async fn changing_libraries_retires_the_previous_scope_without_reconnecting() {
        let directory = tempfile::tempdir().unwrap();
        let state = PlexState::new();
        let revision = state.begin_connection().await;
        let client = scoped_client("https://server.test", "dummy-token", 1);
        let old = PlexRequestContext {
            connection_revision: revision,
            cache_scope: client.library_scope.clone(),
        };
        state.publish(revision, client).await.unwrap();
        state.client_for(&old).await.unwrap();
        state
            .persist(revision, directory.path(), vec![], Some(2), None)
            .await
            .unwrap();
        assert_eq!(
            state.client_for(&old).await.unwrap_err(),
            "Plex music library was superseded"
        );
        let current = PlexRequestContext {
            connection_revision: revision,
            cache_scope: state.0.lock().await.as_ref().unwrap().library_scope.clone(),
        };
        let current_client = state.client_for(&current).await.unwrap();
        assert_eq!(current_client.token, "dummy-token");
        assert_ne!(current.cache_scope, old.cache_scope);
    }

    #[tokio::test]
    async fn a_provider_request_waiting_for_the_native_lock_rechecks_ownership_after_replacement() {
        let state = std::sync::Arc::new(PlexState::new());
        let revision = state.begin_connection().await;
        let client = scoped_client("https://old.test", "dummy-old", 1);
        let old = PlexRequestContext {
            connection_revision: revision,
            cache_scope: client.library_scope.clone(),
        };
        state.publish(revision, client).await.unwrap();
        let mut guard = state.0.lock().await;
        let pending_state = state.clone();
        let (started, ready) = tokio::sync::oneshot::channel();
        let pending = tokio::spawn(async move {
            started.send(()).unwrap();
            pending_state.client_for(&old).await
        });
        ready.await.unwrap();
        state.1.fetch_add(1, Ordering::SeqCst);
        *guard = Some(scoped_client("https://new.test", "dummy-new", 1));
        drop(guard);
        assert_eq!(
            pending.await.unwrap().unwrap_err(),
            "Plex connection was superseded"
        );
    }

    #[tokio::test]
    async fn missing_or_empty_provider_ownership_cannot_fall_back_to_the_global_client() {
        assert!(serde_json::from_value::<PlexRequestContext>(
            serde_json::json!({ "cacheScope": "scope" })
        )
        .is_err());
        assert!(serde_json::from_value::<PlexRequestContext>(
            serde_json::json!({ "connectionRevision": 1 })
        )
        .is_err());
        let state = PlexState::new();
        let revision = state.begin_connection().await;
        state
            .publish(
                revision,
                scoped_client("https://server.test", "dummy-token", 1),
            )
            .await
            .unwrap();
        let empty = PlexRequestContext {
            connection_revision: revision,
            cache_scope: String::new(),
        };
        assert!(state.client_for(&empty).await.is_err());
        let selected: PlexRequestContext = serde_json::from_value(serde_json::json!({
            "connectionRevision": revision,
            "cacheScope": state.0.lock().await.as_ref().unwrap().library_scope.clone(),
        }))
        .unwrap();
        state.client_for(&selected).await.unwrap();
        state.begin_connection().await;
        assert!(state.client_for(&selected).await.is_err());
    }
    #[tokio::test]
    async fn retired_connections_cannot_persist_credentials_after_logout_or_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let state = PlexState::new();
        let old = state.begin_connection().await;
        let make_client = |base: &str, token: &str, id: &str| {
            let mut client = PlexClient::new(PlexClientConfig {
                base_url: base.into(),
                token: token.into(),
                ..Default::default()
            })
            .unwrap();
            client.machine_identifier = id.into();
            client
        };
        state
            .publish(
                old,
                make_client("https://old.test", "dummy-old", "old-server"),
            )
            .await
            .unwrap();
        state
            .persist(
                old,
                directory.path(),
                vec!["https://old.test".into()],
                Some(8),
                Some("old-library".into()),
            )
            .await
            .unwrap();
        let current = state.begin_connection().await;
        state
            .publish(
                current,
                make_client("https://new.test", "dummy-new", "new-server"),
            )
            .await
            .unwrap();
        state
            .persist(
                current,
                directory.path(),
                vec!["https://new.test".into()],
                None,
                None,
            )
            .await
            .unwrap();
        assert!(state
            .persist(old, directory.path(), vec![], Some(8), None)
            .await
            .is_err());
        let saved = crate::plex::load_settings(directory.path()).unwrap();
        {
            let guard = state.0.lock().await;
            let client = guard.as_ref().unwrap();
            assert_eq!(client.library_scope, client.cache_scope_for_library(0, None));
            assert_eq!(client.cache_scope_for_library(1, None), client.cache_scope_for_library(1, Some("")));
            assert_ne!(client.cache_scope_for_library(1, None), client.cache_scope_for_library(2, None));
        }
        assert_eq!(saved.base_url, "https://new.test");
        assert_eq!(saved.token, "dummy-new");
        assert_eq!(saved.machine_identifier, "new-server");
        assert_eq!(saved.section_id, 0);
        assert!(saved.section_uuid.is_empty());
        state.reset(Some(directory.path())).await.unwrap();
        assert!(state
            .persist(current, directory.path(), vec![], None, None)
            .await
            .is_err());
        assert!(state
            .publish(
                current,
                make_client("https://new.test", "dummy-new", "new-server")
            )
            .await
            .is_err());
        assert!(state.0.lock().await.is_none());
        assert!(crate::plex::load_settings(directory.path())
            .unwrap()
            .token
            .is_empty());
    }

    #[tokio::test]
    async fn logout_clears_connection_identity_candidates_and_trust_but_preserves_other_settings() {
        let directory = tempfile::tempdir().unwrap();
        crate::plex::update_settings(directory.path(), |settings| {
            settings.base_url = "https://old.test".into();
            settings.token = "dummy-token".into();
            settings.all_urls = vec!["https://old.test".into()];
            settings.machine_identifier = "old-server".into();
            settings.section_id = 8;
            settings.section_uuid = "library".into();
            settings.tls_exceptions = vec!["https://old.test".into()];
            settings.client_id = "installation-id".into();
            settings.lastfm_session_key = "dummy-lastfm".into();
            settings.lastfm_enabled = true;
            settings
                .extra
                .insert("future_setting".into(), serde_json::json!(42));
            Ok(())
        })
        .unwrap();
        let state = PlexState::new();
        state.reset(Some(directory.path())).await.unwrap();
        let saved = crate::plex::load_settings(directory.path()).unwrap();
        assert!(saved.base_url.is_empty() && saved.token.is_empty() && saved.all_urls.is_empty());
        assert!(
            saved.machine_identifier.is_empty()
                && saved.section_uuid.is_empty()
                && saved.tls_exceptions.is_empty()
        );
        assert_eq!(saved.section_id, 0);
        assert_eq!(saved.client_id, "installation-id");
        assert_eq!(saved.lastfm_session_key, "dummy-lastfm");
        assert!(saved.lastfm_enabled);
        assert_eq!(saved.extra["future_setting"], 42);
    }

    #[tokio::test]
    async fn retired_connection_attempts_cannot_restore_an_old_client() {
        let state = PlexState::new();
        let old = state.begin_connection().await;
        let current = state.begin_connection().await;
        let client = |token: &str| {
            PlexClient::new(PlexClientConfig {
                base_url: "https://example.test".into(),
                token: token.into(),
                ..Default::default()
            })
            .unwrap()
        };
        state
            .publish(current, client("dummy-current"))
            .await
            .unwrap();
        assert!(state.publish(old, client("dummy-retired")).await.is_err());
        assert_eq!(
            state.0.lock().await.as_ref().unwrap().token,
            "dummy-current"
        );
        let failed_replacement = state.begin_connection().await;
        assert!(state.0.lock().await.is_none());
        assert!(state.is_current(failed_replacement));
        assert!(!state.is_current(current));
        assert!(state
            .publish(current, client("dummy-retired"))
            .await
            .is_err());
    }
}
