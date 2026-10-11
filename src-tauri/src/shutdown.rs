//! Keep the webview alive until native listens and renderer preferences are retained.
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use tauri::{Emitter, Manager};
#[derive(Default)]
pub struct ShutdownState {
    phase: AtomicU8,
    request: AtomicU64,
}
impl ShutdownState {
    pub fn approved(&self) -> bool {
        self.phase.load(Ordering::Acquire) == 2
    }
    pub fn request(&self, app: &tauri::AppHandle) {
        if self
            .phase
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let request = self.request.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = app.emit("shutdown://requested", request);
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(12)).await;
            let state = app.state::<ShutdownState>();
            if state.request.load(Ordering::Acquire) == request
                && state
                    .phase
                    .compare_exchange(1, 0, Ordering::AcqRel, Ordering::Acquire)
                    .is_ok()
            {
                let _ = app.emit(
                    "shutdown://failed",
                    "Closing timed out. Hibiki stayed open so unsaved changes can be retried.",
                );
            }
        });
    }
    fn complete(&self, request: u64) -> Result<(), String> {
        if self.request.load(Ordering::Acquire) != request {
            return Err("Close request was superseded".into());
        }
        self.phase
            .compare_exchange(1, 2, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "Close request is no longer active")?;
        Ok(())
    }
}
#[tauri::command]
pub fn shutdown_listener_ready(state: tauri::State<'_, ShutdownState>) -> Option<u64> {
    (state.phase.load(Ordering::Acquire) == 1).then(|| state.request.load(Ordering::Acquire))
}
#[tauri::command]
pub async fn prepare_app_shutdown(
    engine: tauri::State<'_, crate::audio_engine::bridge::AudioEngineState>,
) -> Result<Vec<crate::listening_history::PlaybackEnd>, String> {
    let engine = engine.0.clone();
    tauri::async_runtime::spawn_blocking(move || engine.prepare_shutdown())
        .await
        .map_err(|_| "Native shutdown task failed")?
}
#[tauri::command]
pub fn complete_app_shutdown(
    request: u64,
    app: tauri::AppHandle,
    state: tauri::State<'_, ShutdownState>,
) -> Result<(), String> {
    state.complete(request)?;
    app.exit(0);
    Ok(())
}
#[tauri::command]
pub fn cancel_app_shutdown(
    state: tauri::State<'_, ShutdownState>,
    engine: tauri::State<'_, crate::audio_engine::bridge::AudioEngineState>,
) {
    state.phase.store(0, Ordering::Release);
    engine.0.cancel_shutdown();
}
#[tauri::command]
pub fn approve_update_exit(state: tauri::State<'_, ShutdownState>) {
    state.phase.store(2, Ordering::Release);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_or_duplicate_close_acknowledgements_cannot_approve_another_attempt() {
        let state = ShutdownState::default();
        state.request.store(2, Ordering::Release);
        state.phase.store(1, Ordering::Release);
        assert!(state.complete(1).is_err());
        assert!(!state.approved());
        state.complete(2).unwrap();
        assert!(state.approved());
        assert!(state.complete(2).is_err());
    }
}
