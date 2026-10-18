//! Local application persistence. SQL and writer waits stay off async workers.
use crate::db::{client_state, DbState};
use tauri::State;

#[tauri::command]
pub async fn client_storage_read(db: State<'_, DbState>, namespace: String, key: String) -> Result<client_state::Record, String> {
    client_state::validate(&namespace, &key, None)?;
    db.read(move |conn| client_state::read(conn, &namespace, &key)).await
}
#[tauri::command]
pub async fn client_storage_write(db: State<'_, DbState>, namespace: String, key: String, value: Option<String>, expected_revision: i64) -> Result<bool, String> {
    let (namespace, key, value) = tauri::async_runtime::spawn_blocking(move || {
        client_state::validate(&namespace, &key, value.as_deref())?;
        Ok::<_, String>((namespace, key, value))
    }).await.map_err(|_| "Saved application validation was interrupted.")??;
    db.write(move |conn| client_state::write(conn, &namespace, &key, value.as_deref(), expected_revision)).await
}
#[tauri::command]
pub async fn client_storage_local(db: State<'_, DbState>) -> Result<Vec<(String, String)>, String> {
    db.read(client_state::local_preferences).await
}
