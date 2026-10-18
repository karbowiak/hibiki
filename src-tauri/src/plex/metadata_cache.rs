//! Plex owns SWR and catalogue invalidation; storage is shared with YTM.
use super::PlexClient;
use crate::{
    commands::{PlexRequestContext, PlexState},
    metadata_cache::{Write, CACHE, RETENTION},
};
use serde_json::Value;
use std::{path::PathBuf, sync::LazyLock, time::Duration};
use tauri::{Emitter, Manager};

#[derive(Clone)]
pub(crate) struct Context {
    pub app: tauri::AppHandle,
    pub request: PlexRequestContext,
}
static SLOTS: LazyLock<std::sync::Arc<tokio::sync::Semaphore>> =
    LazyLock::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(2)));
static RUNNING: LazyLock<moka::sync::Cache<String, ()>> = LazyLock::new(|| {
    moka::sync::Cache::builder()
        .max_capacity(2048)
        .time_to_live(Duration::from_secs(120))
        .build()
});
static FAILURES: LazyLock<moka::sync::Cache<String, (u32, i64)>> = LazyLock::new(|| {
    moka::sync::Cache::builder()
        .max_capacity(2048)
        .time_to_idle(Duration::from_secs(1800))
        .build()
});

pub(crate) fn eligible(path: &str) -> bool {
    // Fresh verification for playlist sync, queues, downloads and the matching
    // index uses a plain PlexClient and never opts into this browse cache.
    path.starts_with("/library/metadata/")
        || path.starts_with("/hubs/")
        || path.starts_with("/library/sections/")
        || path.starts_with("/library/all?")
}
pub(crate) async fn current(context: &Context) -> bool {
    context
        .app
        .state::<PlexState>()
        .current_request_context()
        .await
        .is_some_and(|active| {
            active.connection_revision == context.request.connection_revision
                && active.cache_scope == context.request.cache_scope
        })
}
fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|path| path.join("metadata"))
        .map_err(|_| "Metadata cache directory unavailable".into())
}
fn freshness(path: &str) -> i64 {
    if path.contains("search") {
        30
    } else if path.starts_with("/library/metadata/")
        && !["/children", "/allLeaves", "/similar", "/popular"]
            .iter()
            .any(|part| path.contains(part))
    {
        15 * 60
    } else {
        2 * 60
    }
}
async fn fetch(
    context: Context,
    client: PlexClient,
    path: String,
    root: PathBuf,
    epoch: u64,
) -> Result<Value, String> {
    let owner = context.request.cache_scope.clone();
    let value = CACHE
        .fetch(root, owner, path.clone(), epoch, async {
            if !current(&context).await {
                return Err("Plex connection changed".into());
            }
            let (payload, policy) = client
                .get_uncached_with_policy::<Value>(&path, freshness(&path))
                .await
                .map_err(|error| format!("{error:#}"))?;
            if !current(&context).await {
                return Err("Plex connection changed".into());
            }
            Ok(Write {
                payload,
                tag: path.clone(),
                fresh_for: policy.fresh_for,
                retain_for: policy.stale_for.min(RETENTION),
                store: policy.store,
            })
        })
        .await?;
    if !current(&context).await {
        return Err("Plex connection changed".into());
    }
    Ok(value.payload.clone())
}
pub(crate) async fn get(
    context: &Context,
    client: &PlexClient,
    path: &str,
) -> Result<Value, String> {
    if !current(context).await {
        return Err("Plex connection changed".into());
    }
    let root = root(&context.app)?;
    let owner = context.request.cache_scope.clone();
    let path_owned = path.to_owned();
    let observed = {
        let root = root.clone();
        let owner = owner.clone();
        let path = path_owned.clone();
        tokio::task::spawn_blocking(move || {
            Ok::<_, String>((
                CACHE.epoch(&root, &owner)?,
                CACHE.read(&root, &owner, &path),
            ))
        })
        .await
        .map_err(|_| "Metadata reader stopped")
    };
    let (epoch, saved) = match observed {
        Ok(Ok(value)) => value,
        _ => {
            let value = client
                .get_uncached::<Value>(path)
                .await
                .map_err(|error| format!("{error:#}"))?;
            if !current(context).await {
                return Err("Plex connection changed".into());
            }
            return Ok(value);
        }
    };
    if !current(context).await {
        return Err("Plex connection changed".into());
    }
    if let Some(saved) = saved {
        if !saved.fresh(crate::metadata_cache::now()) {
            let key = format!("{owner}:{epoch}:{path}");
            let ready = FAILURES
                .get(&key)
                .is_none_or(|(_, until)| until <= crate::metadata_cache::now());
            if ready {
                if let Ok(slot) = SLOTS.clone().try_acquire_owned() {
                    if RUNNING.entry(key.clone()).or_insert(()).is_fresh() {
                        let context = context.clone();
                        let client = client.clone();
                        let previous = saved.payload.clone();
                        tauri::async_runtime::spawn(async move {
                            let _slot = slot;
                            let event_path = path_owned.clone();
                            match fetch(context.clone(), client, path_owned, root, epoch).await {
                                Ok(payload) => {
                                    FAILURES.invalidate(&key);
                                    if payload != previous && current(&context).await {
                                        let _ = context.app.emit_to("main","plex://metadata", serde_json::json!({
                                            "cacheScope":context.request.cache_scope,"connectionRevision":context.request.connection_revision,
                                            "path":event_path,"entity":affected(&event_path,&payload)
                                        }));
                                    }
                                }
                                Err(_) => {
                                    let attempts = FAILURES
                                        .get(&key)
                                        .map_or(1, |(attempts, _)| (attempts + 1).min(6));
                                    // Stable per-key jitter avoids synchronizing failed scan bursts.
                                    let jitter = key
                                        .bytes()
                                        .fold(0u64, |sum, byte| sum.wrapping_add(byte as u64))
                                        % 11;
                                    FAILURES.insert(
                                        key.clone(),
                                        (
                                            attempts,
                                            crate::metadata_cache::now()
                                                + (5i64 << attempts)
                                                + jitter as i64,
                                        ),
                                    );
                                }
                            }
                            RUNNING.invalidate(&key);
                        });
                    }
                }
            }
        }
        return Ok(saved.payload.clone());
    }
    fetch(context.clone(), client.clone(), path_owned, root, epoch).await
}

#[tauri::command]
pub async fn plex_metadata_expire(
    app: tauri::AppHandle,
    context: PlexRequestContext,
    ids: Vec<String>,
    catchup: bool,
    removed: Vec<String>,
) -> Result<(), String> {
    let context = Context {
        app,
        request: context,
    };
    if !current(&context).await {
        return Err("Plex connection changed".into());
    }
    if ids.len() > 2000
        || removed.len() > 2000
        || ids
            .iter()
            .chain(removed.iter())
            .any(|id| id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return Err("Invalid metadata identities".into());
    }
    let root = root(&context.app)?;
    let owner = context.request.cache_scope.clone();
    tokio::task::spawn_blocking(move || {
        CACHE.edit(&root, &owner, |path, _, payload| {
            let target = path
                .split('/')
                .nth(3)
                .unwrap_or_default()
                .split('?')
                .next()
                .unwrap_or_default();
            if removed.iter().any(|id| id == target) {
                *payload = Value::Null;
                return true;
            }
            fn prune(value: &mut Value, removed: &[String]) -> bool {
                match value {
                    Value::Array(items) => {
                        let before = items.len();
                        items.retain(|item| {
                            !item["ratingKey"]
                                .as_str()
                                .is_some_and(|id| removed.iter().any(|removed| removed == id))
                        });
                        let mut changed = before != items.len();
                        for item in items {
                            changed |= prune(item, removed);
                        }
                        changed
                    }
                    Value::Object(object) => {
                        let before = object
                            .get("Metadata")
                            .and_then(Value::as_array)
                            .map(Vec::len);
                        let mut changed = false;
                        for item in object.values_mut() {
                            changed |= prune(item, removed);
                        }
                        if let (Some(before), Some(after)) = (
                            before,
                            object
                                .get("Metadata")
                                .and_then(Value::as_array)
                                .map(Vec::len),
                        ) {
                            for key in ["size", "totalSize"] {
                                if let Some(total) = object.get(key).and_then(Value::as_u64) {
                                    object.insert(
                                        key.into(),
                                        Value::from(total.saturating_sub((before - after) as u64)),
                                    );
                                }
                            }
                        }
                        changed
                    }
                    _ => false,
                }
            }
            let repaired = prune(payload, &removed);
            repaired
                || catchup
                || ids.iter().any(|id| id == target)
                || !path.starts_with("/library/metadata/")
                || path.contains("/children")
                || path.contains("/allLeaves")
        })
    })
    .await
    .map_err(|_| "Metadata invalidation stopped")?
}

fn affected(path: &str, payload: &Value) -> Option<Value> {
    let target = path
        .strip_prefix("/library/metadata/")?
        .split(['?', '/'])
        .next()?;
    if !target.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let first = payload.get("Metadata")?.as_array()?.first()?;
    let kind = if first["ratingKey"].as_str() == Some(target) {
        first["type"].as_str()?
    } else if path.contains("/children") && first["type"] == "track" {
        "album"
    } else {
        "artist"
    };
    ["artist", "album", "track"]
        .contains(&kind)
        .then(|| serde_json::json!({"kind":kind,"id":target}))
}

pub(crate) fn invalidate_mutation(
    root: &std::path::Path,
    owner: &str,
    prefixes: &[String],
) -> Result<(), String> {
    let ids = prefixes
        .iter()
        .filter_map(|prefix| {
            let completed = if prefix.ends_with(',') {
                format!("{prefix}[]]")
            } else {
                format!("{prefix}]]")
            };
            serde_json::from_str::<Value>(&completed).ok()?[2][0]
                .as_str()
                .map(str::to_owned)
        })
        .collect::<Vec<_>>();
    fn references(value: &Value, ids: &[String]) -> bool {
        match value {
            Value::Object(object) => object.iter().any(|(key, value)| {
                matches!(
                    key.as_str(),
                    "ratingKey" | "parentRatingKey" | "grandparentRatingKey"
                ) && value
                    .as_str()
                    .is_some_and(|id| ids.iter().any(|known| known == id))
                    || references(value, ids)
            }),
            Value::Array(values) => values.iter().any(|value| references(value, ids)),
            _ => false,
        }
    }
    CACHE.edit(root, owner, |path, _, payload| {
        let target = path
            .strip_prefix("/library/metadata/")
            .and_then(|tail| tail.split(['?', '/']).next());
        let relation = path.strip_prefix("/library/metadata/").is_some_and(|tail| {
            tail.split('?')
                .next()
                .is_some_and(|path| path.contains('/'))
        });
        if !path.starts_with("/library/metadata/")
            || relation
            || target.is_some_and(|id| ids.iter().any(|known| known == id))
            || references(payload, &ids)
        {
            *payload = Value::Null;
            true
        } else {
            false
        }
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refreshed_relationships_notify_their_actual_parent() {
        let tracks = serde_json::json!({"Metadata":[{"ratingKey":"30","type":"track"}]});
        assert_eq!(
            affected("/library/metadata/20/children", &tracks).unwrap(),
            serde_json::json!({"kind":"album","id":"20"})
        );
        assert_eq!(
            affected("/library/metadata/10/allLeaves", &tracks).unwrap()["kind"],
            "artist"
        );
        assert_eq!(
            affected("/library/metadata/30?includeGuids=1", &tracks).unwrap()["kind"],
            "track"
        );
    }
    #[test]
    fn mutations_retire_related_facts_and_lists_without_throwing_away_other_entities() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let owner = "plex-test";
        let epoch = CACHE.epoch(root, owner).unwrap();
        for (path, payload) in [
            (
                "/library/metadata/30",
                serde_json::json!({"Metadata":[{"ratingKey":"30","parentRatingKey":"20"}]}),
            ),
            (
                "/library/metadata/20/children",
                serde_json::json!({"Metadata":[{"ratingKey":"30"}]}),
            ),
            (
                "/library/metadata/99",
                serde_json::json!({"Metadata":[{"ratingKey":"99","type":"artist"}]}),
            ),
        ] {
            CACHE
                .write(
                    root,
                    owner,
                    path,
                    epoch,
                    Write {
                        payload,
                        tag: path.into(),
                        fresh_for: 900,
                        retain_for: RETENTION,
                        store: true,
                    },
                )
                .unwrap();
        }
        let key = serde_json::json!(["v1", "getTrack", ["30"]]).to_string();
        invalidate_mutation(root, owner, &[key[..key.len() - 2].into()]).unwrap();
        assert!(CACHE.read(root, owner, "/library/metadata/30").is_none());
        assert!(CACHE
            .read(root, owner, "/library/metadata/20/children")
            .is_none());
        assert!(CACHE
            .read(root, owner, "/library/metadata/99")
            .unwrap()
            .fresh(crate::metadata_cache::now()));
    }
}
