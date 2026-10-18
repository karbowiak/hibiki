use super::BackgroundJobs;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{Emitter, Manager};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Progress {
    pub stage: String,
    pub current: Option<String>,
    pub completed: u64,
    pub total: Option<u64>,
    pub unit: String,
}
#[derive(Clone)]
struct Context {
    id: String,
    app: tauri::AppHandle,
    journal: Arc<tokio::sync::Mutex<butler::Progress<Progress>>>,
    last_event: Arc<std::sync::Mutex<std::time::Instant>>,
}
tokio::task_local! { static CURRENT: Context; }

pub(super) async fn run<T>(
    app: &tauri::AppHandle,
    id: String,
    journal: butler::Progress<Progress>,
    work: impl std::future::Future<Output = T>,
) -> T {
    let jobs = app.state::<Arc<BackgroundJobs>>();
    if let Ok(mut active) = jobs.progress.lock() {
        active.insert(id.clone(), journal.get().clone());
    }
    let _ = app.emit_to("main", "background://changed", ());
    let context = Context {
        id: id.clone(),
        app: app.clone(),
        journal: Arc::new(tokio::sync::Mutex::new(journal)),
        last_event: Arc::new(std::sync::Mutex::new(std::time::Instant::now())),
    };
    let _completion = Completion {
        app: app.clone(),
        id,
    };
    CURRENT.scope(context, work).await
}

struct Completion {
    app: tauri::AppHandle,
    id: String,
}
impl Drop for Completion {
    fn drop(&mut self) {
        if let Ok(mut active) = self.app.state::<Arc<BackgroundJobs>>().progress.lock() {
            active.remove(&self.id);
        }
        let _ = self.app.emit_to("main", "background://changed", ());
    }
}

/// A public step description, never raw URLs, credentials or error payloads.
/// Safe to call from foreground code too: it is a no-op outside a queue job.
pub(crate) async fn report(
    stage: &str,
    current: Option<String>,
    completed: u64,
    total: Option<u64>,
    unit: &str,
) -> Result<(), String> {
    let Ok(context) = CURRENT.try_with(Clone::clone) else {
        return Ok(());
    };
    let progress = Progress {
        stage: stage.into(),
        current,
        completed,
        total,
        unit: unit.into(),
    };
    if let Ok(mut active) = context.app.state::<Arc<BackgroundJobs>>().progress.lock() {
        active.insert(context.id.clone(), progress.clone());
    }
    context
        .journal
        .lock()
        .await
        .set(progress)
        .await
        .map_err(|_| "Background work paused for shutdown".to_owned())?;
    let notify = context.last_event.lock().is_ok_and(|mut at| {
        if at.elapsed() < std::time::Duration::from_secs(1) {
            return false;
        }
        *at = std::time::Instant::now();
        true
    });
    if notify {
        let _ = context.app.emit_to("main", "background://changed", ());
    }
    Ok(())
}
