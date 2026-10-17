use crate::commands::{PlexRequestContext, PlexState};
use crate::db::{
    playback_queue::{self, Request},
    DbState,
};
use tauri::State;

#[tauri::command]
pub async fn saved_queue(
    context: PlexRequestContext,
    request: Request,
    state: State<'_, PlexState>,
    db: State<'_, DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    if !request.read_only() {
        return crate::offline_commands::owned_write(&app, &context, false, move |conn, scope| {
            playback_queue::run(conn, scope, &request)
        })
        .await;
    }
    let guard = state.0.lock().await;
    let scope = state
        .checked_cache_client(&context, &guard)?
        .library_scope
        .clone();
    drop(guard);
    let result = db
        .read(move |conn| playback_queue::run(conn, &scope, &request))
        .await?;
    let guard = state.0.lock().await;
    state.checked_cache_client(&context, &guard)?;
    Ok(result)
}
