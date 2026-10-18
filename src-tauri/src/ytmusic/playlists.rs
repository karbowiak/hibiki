//! Fresh occurrence snapshots and single, preflighted writes. No automatic retries.
use super::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use discovery::find;

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Handle { pub video_id: String, pub occurrence_id: String }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    id: String, title: String, description: String, read_only: bool,
    items: Vec<discovery::Item>, handles: Vec<Handle>,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Operation {
    Create { title: String },
    Append { #[serde(rename = "videoId")] video_id: String },
    AppendMany { #[serde(rename = "videoIds")] video_ids: Vec<String> },
    Delete { index: usize },
    Move { from: usize, to: usize },
    Metadata { title: String, description: String, #[serde(rename = "expectedTitle")] expected_title: String,
        #[serde(rename = "expectedDescription")] expected_description: String },
}
fn valid_playlist(id: &str) -> bool {
    id.starts_with("PL") && id.len() <= 256 && id.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
}
fn count_rows(value: &Value, depth: usize) -> usize {
    if depth > 40 { return 0; }
    if value.get("musicResponsiveListItemRenderer").is_some() { return 1; }
    match value {
        Value::Array(list) => list.iter().map(|value| count_rows(value, depth + 1)).sum(),
        Value::Object(map) => map.values().map(|value| count_rows(value, depth + 1)).sum(),
        _ => 0,
    }
}
async fn connection(app: &tauri::AppHandle, expected: &str) -> Result<(u64, api::Context, session::Cookies), String> {
    let state = app.state::<Arc<YoutubeMusic>>();
    let generation = state.generation()?;
    let cookies = session::cookies(app).await?;
    let context = api::context(app).await.map_err(|error| if error.auth { error.report(app, generation) } else { error.message.into() })?;
    if !state.owns(generation) || context.identity().as_deref() != Some(expected) {
        return Err("YouTube Music account changed. Open the playlist again.".into());
    }
    Ok((generation, context, cookies))
}
async fn request(app: &tauri::AppHandle, generation: u64, context: &api::Context, cookies: &session::Cookies, endpoint: &str, body: Value) -> Result<Value, String> {
    if !app.state::<Arc<YoutubeMusic>>().owns(generation) { return Err("YouTube Music session changed.".into()); }
    let value = api::request(context, cookies, endpoint, body).await
        .map_err(|error| if error.auth { error.report(app, generation) } else { error.message.into() })?;
    if !app.state::<Arc<YoutubeMusic>>().owns(generation) { return Err("YouTube Music session changed.".into()); }
    Ok(value)
}
async fn read(app: &tauri::AppHandle, generation: u64, context: &api::Context, cookies: &session::Cookies, id: &str) -> Result<Snapshot, String> {
    if !valid_playlist(id) { return Err("Choose a regular YouTube Music playlist. Mixes and generated playlists cannot be edited.".into()); }
    let mut value = request(app, generation, context, cookies, "browse", json!({ "browseId": format!("VL{id}") })).await?;
    let first = discovery::parse(&value, false, false, false);
    let read_only = find(&value, "musicEditablePlaylistDetailHeaderRenderer", 0).is_none();
    let mut output = Snapshot { id: id.into(), title: first.title, description: first.description.unwrap_or_default(), read_only, items: Vec::new(), handles: Vec::new() };
    let mut cursors = std::collections::HashSet::new();
    for _ in 0..100 {
        let body = find(&value, "musicPlaylistShelfRenderer", 0)
            .or_else(|| find(&value, "musicPlaylistShelfContinuation", 0))
            .or_else(|| find(&value, "appendContinuationItemsAction", 0))
            .ok_or("YouTube Music did not return a complete playlist shelf. It cannot be safely edited.")?;
        let page = discovery::parse(&json!({ "musicPlaylistShelfRenderer": body }), false, false, true);
        let songs = page.items.iter().filter(|item| item.kind == "song").count();
        if songs != count_rows(body, 0) { return Err("This playlist contains unavailable songs. Its original entries will not be removed by a partial sync.".into()); }
        for item in page.items.into_iter().filter(|item| item.kind == "song") {
            let occurrence_id = item.playlist_item_id.clone().ok_or("This playlist contains unavailable songs or missing occurrence IDs. It cannot be safely edited.")?;
            if output.handles.iter().any(|old| old.occurrence_id == occurrence_id) { return Err("YouTube Music repeated a playlist page.".into()); }
            output.handles.push(Handle { video_id: item.id.clone(), occurrence_id });
            output.items.push(item);
        }
        if output.items.len() > 10000 { return Err("This playlist exceeds the supported 10,000 song limit.".into()); }
        let Some(token) = page.continuation else { return Ok(output); };
        if !cursors.insert(token.clone()) { return Err("YouTube Music repeated a playlist cursor.".into()); }
        value = request(app, generation, context, cookies, "browse", json!({ "continuation": token })).await?;
    }
    Err("YouTube Music playlist was incomplete. Try again.".into())
}
pub(super) async fn ytmusic_playlist_read(app: tauri::AppHandle, playlist_id: String, expected_account: String) -> Result<Snapshot, String> {
    let (generation, context, cookies) = connection(&app, &expected_account).await?;
    read(&app, generation, &context, &cookies, &playlist_id).await
}
pub(super) async fn ytmusic_playlist_write(app: tauri::AppHandle, playlist_id: Option<String>, expected_account: String,
    expected: Vec<Handle>, operation: Operation) -> Result<String, String> {
    let state = app.state::<Arc<YoutubeMusic>>();
    let lock = state.discovery_cache.request("playlist-mutation");
    let _guard = lock.lock().await;
    let (generation, context, cookies) = connection(&app, &expected_account).await?;
    if let Operation::Create { title } = &operation {
        if playlist_id.is_some() || !expected.is_empty() || title.trim().is_empty() || title.len() > 500 {
            return Err("Choose a valid playlist title.".into());
        }
        let value = request(&app, generation, &context, &cookies, "playlist/create",
            json!({ "title": title, "description": "", "privacyStatus": "PRIVATE" })).await?;
        let id = value["playlistId"].as_str().filter(|id| valid_playlist(id)).ok_or("Playlist creation returned no receipt. Inspect YouTube Music before retrying.")?;
        if let Ok(directory) = app.path().app_cache_dir() { state.discovery_cache.playlist_changed(directory.join("metadata"), format!("VL{id}")).await; }
        return Ok(id.into());
    }
    let id = playlist_id.filter(|id| valid_playlist(id)).ok_or("Choose a regular YouTube Music playlist.")?;
    let before = read(&app, generation, &context, &cookies, &id).await?;
    if before.read_only { return Err("This YouTube Music playlist is read-only.".into()); }
    if before.handles != expected { return Err("Playlist changed before the write. Read it again.".into()); }
    let actions = match operation {
        Operation::Metadata { title, description, expected_title, expected_description } => {
            if title.trim().is_empty() || title.len() > 500 || description.len() > 5000 ||
                before.title != expected_title || before.description != expected_description { return Err("Playlist details changed. Refresh before saving.".into()); }
            vec![json!({ "action": "ACTION_SET_PLAYLIST_NAME", "playlistName": title }),
                json!({ "action": "ACTION_SET_PLAYLIST_DESCRIPTION", "playlistDescription": description })]
        },
        Operation::Append { video_id } if api::valid_video_id(&video_id) && expected.len() < 10000 => append_actions(vec![video_id], expected.len())?,
        Operation::AppendMany { video_ids } => append_actions(video_ids, expected.len())?,
        Operation::Delete { index } if index < expected.len() => vec![json!({ "action": "ACTION_REMOVE_VIDEO", "removedVideoId": expected[index].video_id, "setVideoId": expected[index].occurrence_id })],
        Operation::Move { from, to } if from < expected.len() && to < expected.len() && from != to => {
            let moved = &expected[from];
            let mut rest = expected.iter().collect::<Vec<_>>(); rest.remove(from);
            let mut action = json!({ "action": "ACTION_MOVE_VIDEO_BEFORE", "setVideoId": moved.occurrence_id });
            if let Some(next) = rest.get(to) { action["movedSetVideoIdSuccessor"] = json!(next.occurrence_id); }
            vec![action]
        },
        _ => return Err("Invalid playlist operation.".into()),
    };
    let value = request(&app, generation, &context, &cookies, "browse/edit_playlist", json!({ "playlistId": id, "actions": actions })).await?;
    if value["status"] != "STATUS_SUCCEEDED" { return Err("Playlist write was not acknowledged. Read the playlist before retrying.".into()); }
    if let Ok(directory) = app.path().app_cache_dir() { state.discovery_cache.playlist_changed(directory.join("metadata"), format!("VL{id}")).await; }
    Ok(id)
}

fn append_actions(video_ids: Vec<String>, current_len: usize) -> Result<Vec<Value>, String> {
    if video_ids.is_empty() || video_ids.len() > 100 || current_len + video_ids.len() > 10000
        || video_ids.iter().any(|id| !api::valid_video_id(id)) {
        return Err("Invalid or oversized playlist append batch.".into());
    }
    Ok(video_ids.into_iter().map(|id| json!({ "action": "ACTION_ADD_VIDEO", "addedVideoId": id, "dedupeOption": "DEDUPE_OPTION_SKIP" })).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_batch_retains_order_and_repeats_with_bounded_actions() {
        let ids = vec!["a1234567890".into(), "b1234567890".into(), "a1234567890".into()];
        let actions = append_actions(ids, 3).unwrap();
        assert_eq!(actions.iter().map(|action| action["addedVideoId"].as_str().unwrap()).collect::<Vec<_>>(),
            vec!["a1234567890", "b1234567890", "a1234567890"]);
        assert!(actions.iter().all(|action| action["action"] == "ACTION_ADD_VIDEO"));
        assert!(append_actions(vec![], 0).is_err());
        assert!(append_actions(vec!["invalid".into()], 0).is_err());
        assert!(append_actions(vec!["a1234567890".into(); 101], 0).is_err());
        assert!(append_actions(vec!["a1234567890".into(); 2], 9999).is_err());
    }
}
