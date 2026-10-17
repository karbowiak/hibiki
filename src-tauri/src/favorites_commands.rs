use crate::commands::{PlexRequestContext, PlexState};
use crate::db::{favorites, DbState};
use crate::favorites_remote::{FavoritePage, FavoriteRecording};
use crate::plex::{playlist_sync_edit::PlaylistSyncOccurrence, PlexClient};
use futures::{stream, StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use tauri::State;

async fn client(
    state: &PlexState,
    context: &PlexRequestContext,
    online: bool,
) -> Result<PlexClient, String> {
    let guard = state.0.lock().await;
    Ok(if online {
        state.checked_client(context, &guard)?
    } else {
        state.checked_cache_client(context, &guard)?
    }
    .clone())
}
#[tauri::command]
pub async fn favorites_load(
    context: PlexRequestContext,
    state: State<'_, PlexState>,
    db: State<'_, DbState>,
) -> Result<favorites::FavoriteProfile, String> {
    let owner = client(&state, &context, false).await?;
    let scope = owner.library_scope;
    let result = db.read(move |conn| favorites::load(conn, &scope)).await?;
    client(&state, &context, false).await?;
    Ok(result)
}
#[tauri::command]
pub async fn favorites_page(
    context: PlexRequestContext,
    offset: usize,
    limit: usize,
    state: State<'_, PlexState>,
    db: State<'_, DbState>,
) -> Result<Vec<favorites::FavoriteRow>, String> {
    let owner = client(&state, &context, false).await?;
    let scope = owner.library_scope;
    let result = db
        .read(move |conn| favorites::page(conn, &scope, offset, limit))
        .await?;
    client(&state, &context, false).await?;
    Ok(result)
}
#[tauri::command]
pub async fn favorites_save(
    context: PlexRequestContext,
    expected: i64,
    metadata: Value,
    rows: Vec<favorites::FavoriteRow>,
    state: State<'_, PlexState>,
    app: tauri::AppHandle,
) -> Result<i64, String> {
    client(&state, &context, false).await?;
    crate::offline_commands::owned_write(&app, &context, false, move |conn, scope| {
        favorites::save(conn, scope, expected, &metadata, &rows)
    })
    .await
}
#[tauri::command]
pub async fn favorites_reset(
    context: PlexRequestContext,
    expected: i64,
    state: State<'_, PlexState>,
    app: tauri::AppHandle,
) -> Result<i64, String> {
    client(&state, &context, false).await?;
    crate::offline_commands::owned_write(&app, &context, false, move |conn, scope| {
        favorites::reset(conn, scope, expected)
    }).await
}
/// Favorites have their own small metadata working set. Resolve only missing
/// IDs from Plex; a whole-library catalogue is never required to open this page.
#[tauri::command]
pub async fn favorites_tracks(
    context: PlexRequestContext,
    ids: Vec<i64>,
    state: State<'_, PlexState>,
    db: State<'_, DbState>,
    app: tauri::AppHandle,
) -> Result<Vec<Value>, String> {
    if ids.len() > 200 || ids.iter().any(|id| *id <= 0) {
        return Err("Invalid favorite track page".into());
    }
    let owner = client(&state, &context, false).await?;
    let scope = owner.library_scope.clone();
    let requested = ids.clone();
    let mut rows = db.read(move |conn| {
        let mut rows = Vec::new();
        for id in requested {
            if let Some(raw) = crate::db::catalogue::get(conn, &scope, "track", id)? {
                rows.push(crate::db::catalogue_query::project("track", raw)?);
            }
        }
        Ok(rows)
    }).await?;
    let found = rows.iter().filter_map(|r| r["rating_key"].as_i64()).collect::<HashSet<_>>();
    let missing = ids.into_iter().filter(|id| !found.contains(id)).collect::<Vec<_>>();
    if !owner.offline_only {
        let section = crate::offline_audio::library_id(&app, &owner)?;
        for batch in missing.chunks(50) {
            let documents = match tokio::time::timeout(std::time::Duration::from_secs(15), owner.catalogue_details(batch)).await {
                Ok(Ok(documents)) => documents,
                // A failed optional hydration must not hide already saved
                // favorites; the connectivity probe owns offline transitions.
                _ => break,
            };
            client(&state, &context, true).await?;
            for raw in &documents {
                if crate::plex::catalogue::number(&raw["librarySectionID"]) != Some(section)
                    || raw["type"].as_str() != Some("track") {
                    return Err("Plex returned a favorite from a different library".into());
                }
                rows.push(crate::db::catalogue_query::project("track", raw.clone())?);
            }
            crate::offline_commands::owned_write(&app, &context, true, move |conn, scope| {
                crate::db::atomic_upsert(conn, |conn| {
                    let favorite_ids = crate::db::focused_library::favorite_ids(conn, scope)?;
                    for raw in &documents {
                        let id = crate::plex::catalogue::number(&raw["ratingKey"]).ok_or("Invalid favorite identity")?;
                        if favorite_ids.contains(&id) {
                            crate::db::catalogue::save(conn, scope, "track", id, raw, true)?;
                        }
                    }
                    Ok(())
                })
            }).await.unwrap_or_else(|error| {
                tracing::debug!(%error,"Optional favorite metadata cache write failed");
            });
        }
    }
    client(&state, &context, false).await?;
    Ok(rows)
}
#[derive(Serialize)]
pub struct FavoritePlexSnapshot {
    pub title: String,
    pub items: Vec<PlaylistSyncOccurrence>,
    #[serde(flatten)]
    pub page: FavoritePage,
}
#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum FavoritePlexOperation {
    Append { ids: Vec<String> },
    Delete { index: usize },
}
fn positive(value: &str) -> Result<i64, String> {
    value
        .parse::<i64>()
        .ok()
        .filter(|id| *id > 0 && id.to_string() == value)
        .ok_or("Invalid favorite track ID".into())
}
fn hash(title: &str, ids: &[String]) -> String {
    hex::encode(Sha256::digest(serde_json::json!([title, ids]).to_string().as_bytes()))
}
async fn snapshot(
    client: &PlexClient,
    section_id: i64,
    playlist_id: i64,
) -> Result<FavoritePlexSnapshot, String> {
    let section = client
        .get_section(section_id)
        .await
        .map_err(|_| "Music library unavailable")?;
    if section.key != section_id
        || section.section_type != "artist"
        || (client.library_scope
            != client.cache_scope_for_library(section_id, section.uuid.as_deref())
            && client.library_scope != client.cache_scope_for_library(section_id, None))
    {
        return Err("Favorite music library changed".into());
    }
    let playlist = client
        .get_playlist(playlist_id)
        .await
        .map_err(|_| "Liked Songs playlist unavailable")?;
    if playlist.rating_key != playlist_id
        || playlist.smart
        || playlist.radio
        || playlist.playlist_type != "audio"
    {
        return Err("Choose a regular Plex music playlist for liked songs".into());
    }
    let mut items = Vec::new();
    let mut rows = Vec::new();
    let mut total = None;
    let mut handles = HashSet::new();
    let mut tracks = HashSet::new();
    loop {
        let offset = items.len();
        let page = client
            .get_playlist_items_page(playlist_id, Some(200), Some(offset as i32))
            .await
            .map_err(|_| "Could not verify Plex liked songs")?;
        if page.total < 0
            || page.total > 100000
            || page.items.len() > 200
            || page.offset.is_some_and(|v| v != offset as i64)
            || total.is_some_and(|v| v != page.total)
            || (page.items.is_empty() && offset < page.total as usize)
            || offset + page.items.len() > page.total as usize
        {
            return Err("Incomplete or changed Plex liked songs".into());
        }
        total = Some(page.total);
        for track in page.items {
            if track.library_section_id != section_id {
                return Err("Liked Songs contains another music library".into());
            }
            let handle = track
                .playlist_item_id
                .filter(|id| *id > 0)
                .ok_or("Playlist occurrence handle missing")?
                .to_string();
            if !handles.insert(handle.clone()) {
                return Err("Repeated Plex favorite page".into());
            }
            let id = track.rating_key.to_string();
            items.push(PlaylistSyncOccurrence {
                track_id: id.clone(),
                occurrence_id: handle,
            });
            if tracks.insert(id.clone()) {
                rows.push(FavoriteRecording {
                    key: format!("local:{id}"),
                    title: track.title,
                    artist: track.original_title
                        .filter(|artist| !artist.trim().is_empty())
                        .unwrap_or(track.grandparent_title),
                    album: track.parent_title,
                    duration_ms: Some(track.duration),
                    liked_at: None,
                    local_track_id: Some(id),
                    recording_mbid: None,
                    recording_msid: None,
                })
            }
        }
        if items.len() == page.total as usize {
            break;
        }
    }
    let after = client
        .get_playlist(playlist_id)
        .await
        .map_err(|_| "Liked Songs playlist unavailable")?;
    if after.title != playlist.title || after.leaf_count != items.len() as i64 || after.smart {
        return Err("Plex liked songs changed during reading".into());
    }
    Ok(FavoritePlexSnapshot {
        title: playlist.title,
        items,
        page: FavoritePage {
            total: rows.len(),
            offset: 0,
            rows,
        },
    })
}
#[tauri::command]
pub async fn favorites_plex_read(
    context: PlexRequestContext,
    section_id: i64,
    playlist_id: i64,
    state: State<'_, PlexState>,
) -> Result<FavoritePlexSnapshot, String> {
    let owner = client(&state, &context, true).await?;
    let result = snapshot(&owner, section_id, playlist_id).await?;
    client(&state, &context, true).await?;
    Ok(result)
}
#[tauri::command]
pub async fn favorites_plex_mutate(
    context: PlexRequestContext,
    section_id: i64,
    playlist_id: i64,
    before_hash: String,
    operation: FavoritePlexOperation,
    state: State<'_, PlexState>,
) -> Result<FavoritePlexSnapshot, String> {
    let owner = client(&state, &context, true).await?;
    let (before, after) =
        prepare_mutation(&owner, section_id, playlist_id, &before_hash, &operation).await?;
    let admission = state.admit_mutation(&context).await?;
    admission.run(|current| {
        let before = &before;
        let operation = &operation;
        async move { send_update(&current, playlist_id, before, operation).await }
    }).await?;
    let result = snapshot(&owner, section_id, playlist_id).await?;
    client(&state, &context, true).await?;
    if result.title != before.title || result.items.iter().map(|i| &i.track_id).ne(after.iter()) {
        return Err("Plex favorite update needs read-only recovery".into());
    }
    Ok(result)
}

async fn prepare_mutation(
    owner: &PlexClient,
    section_id: i64,
    playlist_id: i64,
    before_hash: &str,
    operation: &FavoritePlexOperation,
) -> Result<(FavoritePlexSnapshot, Vec<String>), String> {
    let before = snapshot(owner, section_id, playlist_id).await?;
    let mut after: Vec<String> = before
        .items
        .iter()
        .map(|item| item.track_id.clone())
        .collect();
    if hash(&before.title, &after) != before_hash {
        return Err("Plex favorite membership changed before saving".into());
    }
    match operation {
        FavoritePlexOperation::Append { ids } => {
            if ids.is_empty()
                || ids.len() > 100
                || after.len() + ids.len() > 100000
                || ids.iter().collect::<HashSet<_>>().len() != ids.len()
                || ids.iter().any(|id| after.contains(id))
            {
                return Err("Invalid favorite additions".into());
            }
            let validated_ids = ids
                .iter()
                .map(|id| positive(id))
                .collect::<Result<Vec<_>, _>>()?;
            stream::iter(validated_ids)
                .map(|id| async move {
                    let track = owner
                        .get_track(id)
                        .await
                        .map_err(|_| "Favorite track unavailable".to_owned())?;
                    if track.rating_key != id || track.library_section_id != section_id {
                        return Err("Favorite track belongs to another library".to_owned());
                    }
                    Ok(())
                })
                .buffer_unordered(4)
                .try_collect::<Vec<_>>()
                .await?;
            after.extend(ids.clone());
        }
        FavoritePlexOperation::Delete { index } => {
            if *index >= after.len() {
                return Err("Invalid favorite removal".into());
            };
            after.remove(*index);
        }
    }
    // Re-read after track validation, before this single non-retrying verb.
    let confirmed = snapshot(owner, section_id, playlist_id).await?;
    if confirmed.title != before.title || confirmed.items != before.items {
        return Err("Plex favorites changed before saving".into());
    }
    Ok((before, after))
}
async fn send_update(
    owner: &PlexClient,
    playlist_id: i64,
    before: &FavoritePlexSnapshot,
    operation: &FavoritePlexOperation,
) -> Result<(), String> {
    let response = match operation {
        FavoritePlexOperation::Append { ids } => {
            if owner.machine_identifier.is_empty() {
                return Err("Plex server identity unavailable".into());
            }
            let uri = format!(
                "server://{}/com.plexapp.plugins.library/library/metadata/{}",
                owner.machine_identifier,
                ids.join(",")
            );
            owner
                .mutate_params_once(
                    reqwest::Method::PUT,
                    &format!("/playlists/{playlist_id}/items"),
                    &[("uri", uri.as_str())],
                    None,
                    None,
                )
                .await
        }
        FavoritePlexOperation::Delete { index } => {
            owner
                .mutate_params_once(
                    reqwest::Method::DELETE,
                    &format!(
                        "/playlists/{playlist_id}/items/{}",
                        before.items[*index].occurrence_id
                    ),
                    &[],
                    None,
                    None,
                )
                .await
        }
    };
    response.map_err(|_| "Plex favorite update needs read-only recovery")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::favorites_remote::tests::loopback;
    use serde_json::json;
    fn section() -> Value {
        json!({"MediaContainer":{"Directory":[{"key":"5","type":"artist","uuid":"library"}]}})
    }
    fn playlist(count: usize, smart: bool) -> Value {
        json!({"MediaContainer":{"Metadata":[{"ratingKey":"9","title":"Liked Songs","playlistType":"audio","smart":smart,"radio":false,"leafCount":count}]}})
    }
    fn items(ids: &[i64], offset: usize, total: usize, library: i64) -> Value {
        json!({"MediaContainer":{"size":ids.len(),"totalSize":total,"offset":offset,"Metadata":ids.iter().enumerate().map(|(n,id)|json!({"ratingKey":id.to_string(),"title":format!("Track {id}"),"grandparentTitle":"Artist","librarySectionID":library,"playlistItemID":(offset+n+1).to_string()})).collect::<Vec<_>>()}})
    }
    fn plex_client(base: String) -> PlexClient {
        let mut client = PlexClient::new(crate::plex::PlexClientConfig {
            base_url: base,
            token: "fixture".into(),
            ..Default::default()
        })
        .unwrap();
        client.machine_identifier = "machine".into();
        client.library_scope = client.cache_scope_for_library(5, Some("library"));
        client
    }
    fn roster(ids: &[i64]) -> Vec<(u16, Value)> {
        vec![
            (200, section()),
            (200, playlist(ids.len(), false)),
            (200, items(ids, 0, ids.len(), 5)),
            (200, playlist(ids.len(), false)),
        ]
    }
    #[tokio::test]
    async fn favorite_preflight_batch_uri_and_occurrence_delete_use_single_verbs() {
        let mut replies = roster(&[1, 2]);
        replies.push((200,json!({"MediaContainer":{"Metadata":[{"ratingKey":"3","librarySectionID":5,"title":"Track 3"}]}})));
        replies.extend(roster(&[1, 2]));
        replies.push((200, json!({})));
        replies.extend(roster(&[1, 2, 3]));
        replies.push((200, json!({})));
        let (base, thread) = loopback(replies);
        let client = plex_client(base);
        let operation = FavoritePlexOperation::Append {
            ids: vec!["3".into()],
        };
        let (before, after) = prepare_mutation(
            &client,
            5,
            9,
            &hash("Liked Songs", &["1".into(), "2".into()]),
            &operation,
        )
        .await
        .unwrap();
        assert_eq!(after, vec!["1", "2", "3"]);
        send_update(&client, 9, &before, &operation).await.unwrap();
        let observed = snapshot(&client, 5, 9).await.unwrap();
        send_update(
            &client,
            9,
            &observed,
            &FavoritePlexOperation::Delete { index: 1 },
        )
        .await
        .unwrap();
        let requests = thread.join().unwrap();
        let writes: Vec<_> = requests
            .iter()
            .filter(|row| !row.starts_with("GET"))
            .collect();
        assert_eq!(writes.len(), 2);
        let url = url::Url::parse(&format!(
            "http://fixture{}",
            writes[0]
                .lines()
                .next()
                .unwrap()
                .split_whitespace()
                .nth(1)
                .unwrap()
        ))
        .unwrap();
        assert_eq!(
            url.query_pairs().find(|(key, _)| key == "uri").unwrap().1,
            "server://machine/com.plexapp.plugins.library/library/metadata/3"
        );
        assert!(writes[1].starts_with("DELETE /playlists/9/items/2 "));
        let (base, thread) = loopback(vec![(200, json!({}))]);
        let client = plex_client(base);
        send_update(
            &client,
            9,
            &before,
            &FavoritePlexOperation::Append {
                ids: vec!["3".into(), "4".into()],
            },
        )
        .await
        .unwrap();
        let requests = thread.join().unwrap();
        assert!(requests[0].contains("3%2C4"));
    }
    #[tokio::test]
    async fn favorites_read_full_large_membership_and_reject_smart_or_foreign_rows() {
        let count = 1001;
        let mut replies = vec![(200, section()), (200, playlist(count, false))];
        for offset in (0..count).step_by(200) {
            let ids: Vec<i64> =
                ((offset + 1) as i64..=((offset + 200).min(count)) as i64).collect();
            replies.push((200, items(&ids, offset, count, 5)))
        }
        replies.push((200, playlist(count, false)));
        let (base, thread) = loopback(replies);
        let result = snapshot(&plex_client(base), 5, 9).await.unwrap();
        assert_eq!(result.items.len(), count);
        assert_eq!(result.page.rows.len(), count);
        assert_eq!(thread.join().unwrap().len(), 9);
        let (base, thread) = loopback(vec![
            (200, section()),
            (200, playlist(1, false)),
            (200, items(&[1], 0, 1, 6)),
        ]);
        assert!(snapshot(&plex_client(base), 5, 9).await.is_err());
        thread.join().unwrap();
        let (base, thread) = loopback(vec![(200, section()), (200, playlist(1, true))]);
        assert!(snapshot(&plex_client(base), 5, 9).await.is_err());
        thread.join().unwrap();
    }
    #[tokio::test]
    async fn changed_membership_and_foreign_additions_fail_before_the_verb() {
        let (base, thread) = loopback(roster(&[1, 2]));
        assert!(prepare_mutation(
            &plex_client(base),
            5,
            9,
            "old",
            &FavoritePlexOperation::Delete { index: 0 }
        )
        .await
        .is_err());
        assert!(thread
            .join()
            .unwrap()
            .iter()
            .all(|row| row.starts_with("GET")));
        let mut replies = roster(&[1, 2]);
        replies.push((200,json!({"MediaContainer":{"Metadata":[{"ratingKey":"3","librarySectionID":6,"title":"Other library"}]}})));
        let (base, thread) = loopback(replies);
        assert!(prepare_mutation(
            &plex_client(base),
            5,
            9,
            &hash("Liked Songs", &["1".into(), "2".into()]),
            &FavoritePlexOperation::Append {
                ids: vec!["3".into()]
            }
        )
        .await
        .is_err());
        assert!(thread
            .join()
            .unwrap()
            .iter()
            .all(|row| row.starts_with("GET")));
        let mut replies = roster(&[1, 2]);
        replies.extend(roster(&[2, 1]));
        let (base, thread) = loopback(replies);
        assert!(prepare_mutation(
            &plex_client(base),
            5,
            9,
            &hash("Liked Songs", &["1".into(), "2".into()]),
            &FavoritePlexOperation::Delete { index: 0 }
        )
        .await
        .is_err());
        thread.join().unwrap();
    }
}
