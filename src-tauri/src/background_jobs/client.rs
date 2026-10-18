//! Jobs whose existing reconciliation rules and journals live in TypeScript.
//! Butler owns their scheduling; an app-owned Web Worker executes the rules.
use super::{progress::Progress, Task};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Emitter, Manager};
use tokio::sync::mpsc;

#[derive(Default)]
pub(super) struct Client {
    owner: Mutex<Option<String>>,
    pending: Mutex<HashMap<String, mpsc::Sender<Signal>>>,
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Request {
    pub owner: String,
    pub domain: String,
    pub method: String,
    pub args: Value,
}
impl Request {
    pub(super) fn initial_progress(&self) -> Option<Progress> {
        if self.domain != "collections" { return None; }
        let job = self.args.get(0)?;
        let youtube = self.method == "hydrateYoutubeMusic";
        let resume = job.get("resume");
        let completed = resume.and_then(|value| value.get("completed")).and_then(Value::as_u64)
            .or_else(|| youtube.then_some(0))?;
        let total = if youtube { job.get("total") } else { resume.and_then(|value| value.get("total")) }.and_then(Value::as_u64);
        if !youtube && total.is_none() { return None; }
        if total.is_some_and(|total| completed > total) { return None; }
        Some(Progress { stage: if youtube { "Caching YTM playlist" } else { "Caching Plex collection" }.into(),
            current: job.get(if youtube { "title" } else { "key" })?.as_str().map(String::from),
            completed, total, unit: if youtube { "songs" } else { "items" }.into() })
    }
}
#[derive(Serialize, Clone)]
struct Dispatch {
    token: String,
    request: Request,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Signal {
    Progress {
        progress: Progress,
    },
    Finished {
        result: Value,
    },
    Failed {
        message: String,
        #[serde(default)]
        unexpected: bool,
    },
}
fn valid(request: &Request) -> bool {
    let method = request.method.as_str();
    let supported = match request.domain.as_str() {
        "mixed" => matches!(method, "sync" | "externalSync" | "retryIndexedMatches"),
        "linked" => matches!(method, "syncNow" | "matchIncomplete" | "retryMatching"),
        "favorites" => matches!(method, "sync" | "matchMissing"),
        "ratings" => matches!(method, "resume" | "retryPlexMatches"),
        "collections" => matches!(method, "hydrate" | "hydrateYoutubeMusic"),
        "metadata" => method == "read",
        _ => false,
    };
    supported
        && request.owner.len() <= 128
        && request.args.is_array()
        && serde_json::to_vec(&request.args).is_ok_and(|args| args.len() <= 65536)
}
#[tauri::command]
pub fn background_client_owner(
    owner: Option<String>,
    expected_owner: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if owner.as_ref().is_some_and(|owner| owner.len() > 128) {
        return Err("Invalid background owner".into());
    }
    let client = app.state::<Arc<Client>>();
    let mut current = client
        .owner
        .lock()
        .map_err(|_| "Background owner unavailable")?;
    if owner.is_some() || expected_owner.as_deref() == current.as_deref() {
        *current = owner;
    }
    Ok(())
}
#[tauri::command]
pub async fn background_client_call(
    request: Request,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    if !valid(&request) {
        return Err("Unsupported background work".into());
    }
    let outcome = super::call(&app, Task::Client { request }).await?;
    if outcome["ok"] == false {
        return Err(outcome["message"]
            .as_str()
            .unwrap_or("Background work was deferred")
            .to_owned());
    }
    Ok(outcome.get("result").cloned().unwrap_or(Value::Null))
}
#[tauri::command]
pub async fn background_client_signal(
    token: String,
    signal: Signal,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let sender = app
        .state::<Arc<Client>>()
        .pending
        .lock()
        .map_err(|_| "Background work unavailable")?
        .get(&token)
        .cloned();
    if let Some(sender) = sender {
        let _ = sender.send(signal).await;
    }
    Ok(())
}
struct Pending {
    app: tauri::AppHandle,
    token: String,
}
impl Drop for Pending {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.app.state::<Arc<Client>>().pending.lock() {
            pending.remove(&self.token);
        }
    }
}
fn deferred(message: &str) -> Value {
    serde_json::json!({ "ok": false, "message": message.chars().take(512).collect::<String>() })
}
pub(super) async fn run(app: &tauri::AppHandle, request: Request) -> Result<Value, String> {
    if !valid(&request) {
        return Err("Unsupported background work".into());
    }
    if let Some(progress) = request.initial_progress() {
        super::report(&progress.stage, progress.current, progress.completed, progress.total, &progress.unit).await?;
    }
    let client = app.state::<Arc<Client>>();
    let current = || {
        client
            .owner
            .lock()
            .is_ok_and(|owner| owner.as_deref() == Some(request.owner.as_str()))
    };
    // A previous renderer/connection cannot replay work in a newly bound account.
    // Its durable domain journal is picked up by the new owner's regular scan.
    if !current() {
        return Ok(deferred("Music accounts changed."));
    }
    let token = uuid::Uuid::new_v4().to_string();
    let (send, mut receive) = mpsc::channel(8);
    client
        .pending
        .lock()
        .map_err(|_| "Background work unavailable")?
        .insert(token.clone(), send);
    let _pending = Pending {
        app: app.clone(),
        token: token.clone(),
    };
    let dispatch = Dispatch {
        token,
        request: request.clone(),
    };
    app.emit_to("main", "background://client", &dispatch)
        .map_err(|_| "Background worker unavailable")?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3600);
    loop {
        if !current() {
            return Ok(deferred("Music accounts changed."));
        }
        if *app.state::<Arc<super::BackgroundJobs>>().stop.borrow() {
            return Ok(deferred("Hibiki is closing."));
        }
        tokio::select! {
            signal = receive.recv() => match signal {
                Some(Signal::Progress { progress }) => super::report(&progress.stage, progress.current, progress.completed, progress.total, &progress.unit).await?,
                Some(Signal::Finished { result }) => return Ok(serde_json::json!({ "ok": true, "result": result })),
                Some(Signal::Failed { message, unexpected }) => return if unexpected { Err(message) } else { Ok(deferred(&message)) },
                None => return Err("Background worker disconnected".into()),
            },
            _ = tokio::time::sleep_until(deadline) => return Err("Background work timed out; its saved journal will resume.".into()),
            _ = tokio::time::sleep(Duration::from_secs(1)) => {},
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn queued_collection_turns_retain_progress_before_dispatch() {
        let mut request = Request { owner: "owner".into(), domain: "collections".into(), method: "hydrate".into(),
            args: serde_json::json!([{ "key": "playlist:42", "resume": { "completed": 75000, "total": 381397 } }]) };
        let progress = request.initial_progress().unwrap();
        assert_eq!(progress.completed, 75000);
        assert_eq!(progress.total, Some(381397));
        request.args[0]["resume"]["completed"] = serde_json::json!(381398);
        assert!(request.initial_progress().is_none());
        request.method = "hydrateYoutubeMusic".into();
        request.args = serde_json::json!([{ "key": "ytmusic:playlist:VLone", "title": "Saved playlist",
            "total": 300, "resume": { "completed": 200, "cursor": "next", "pages": 4 } }]);
        let progress = request.initial_progress().unwrap();
        assert_eq!(progress.stage, "Caching YTM playlist");
        assert_eq!(progress.current.as_deref(), Some("Saved playlist"));
        assert_eq!(progress.completed, 200);
        assert_eq!(progress.total, Some(300));
        assert!(valid(&request));
    }
}
