use crate::commands::{PlexRequestContext, PlexState};
use crate::db::{
    collection_cache::{self, Request},
    DbState,
};
use tauri::State;

#[tauri::command]
pub async fn collection_cache(
    context: PlexRequestContext,
    request: Request,
    state: State<'_, PlexState>,
    db: State<'_, DbState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "System clock unavailable")?
        .as_millis()
        .min(i64::MAX as u128) as i64;
    if !request.read_only() {
        return crate::offline_commands::owned_write(&app, &context, true, move |conn, scope| {
            collection_cache::run(conn, scope, &request, now)
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
        .read(move |conn| collection_cache::run(conn, &scope, &request, now))
        .await?;
    let guard = state.0.lock().await;
    state.checked_cache_client(&context, &guard)?;
    Ok(result)
}
