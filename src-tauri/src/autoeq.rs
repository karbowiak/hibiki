//! On-demand, revision-pinned public AutoEq catalogue. Saved corrections are
//! owned separately by the user; refreshing this cache cannot replace them.
use crate::{
    db::{self, DbState},
    http_response::BoundedResponseExt,
};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::{
    sync::{
        atomic::{AtomicI64, Ordering},
        Arc, RwLock,
    },
    time::Duration,
};
use tauri::{Emitter, Manager};

const KEY: &str = "autoeq-catalogue-v1";
const TTL: i64 = 86400000;
static CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .user_agent(concat!(
            "Hibiki/",
            env!("CARGO_PKG_VERSION"),
            " (https://github.com/karbowiak/hibiki)"
        ))
        .build()
        .expect("AutoEq public client")
});
#[derive(Default)]
pub struct AutoEqState {
    catalogue: RwLock<Option<Arc<Catalogue>>>,
    refresh: tokio::sync::Mutex<()>,
    retry_at: AtomicI64,
}
#[derive(Clone, Serialize, Deserialize)]
struct Entry {
    id: String,
    name: String,
    path: String,
    measurement: String,
    rig: String,
}
#[derive(Serialize, Deserialize)]
struct Catalogue {
    revision: String,
    checked_at: i64,
    license: String,
    entries: Vec<Entry>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    id: String,
    name: String,
    measurement: String,
    rig: String,
    target: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Search {
    items: Vec<Model>,
    total: usize,
    catalogue_size: usize,
    revision: String,
    checked_at: i64,
    stale: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    name: String,
    text: String,
    url: String,
    revision: String,
    measurement: String,
    rig: String,
    target: Option<String>,
    license: String,
}
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn revision(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn decode(value: &str) -> Result<String, String> {
    let form = format!("x={}", value.replace('+', "%2B").replace('&', "%26"));
    let decoded = url::form_urlencoded::parse(form.as_bytes())
        .next()
        .ok_or("Invalid AutoEq path")?
        .1
        .into_owned();
    if decoded.is_empty()
        || decoded.len() > 512
        || decoded == "."
        || decoded == ".."
        || decoded
            .chars()
            .any(|ch| ch.is_control() || "\\/\u{fffd}".contains(ch))
    {
        return Err("Invalid AutoEq path".into());
    }
    Ok(decoded)
}
fn path_parts(path: &str) -> Result<Vec<String>, String> {
    if path.len() > 2048 || path.contains(['?', '#', '\\']) {
        return Err("Invalid AutoEq path".into());
    }
    let parts = path.split('/').map(decode).collect::<Result<Vec<_>, _>>()?;
    if parts.len() < 3 || parts.len() > 6 {
        return Err("Invalid AutoEq path".into());
    }
    Ok(parts)
}
fn parse_index(text: &str) -> Result<Vec<Entry>, String> {
    if text.len() > 4 * 1024 * 1024 {
        return Err("AutoEq catalogue is too large".into());
    }
    let mut entries = std::collections::BTreeMap::new();
    for line in text.lines() {
        let Some(link) = line.strip_prefix("- [") else {
            continue;
        };
        let Some((name, path)) = link.split_once("](") else {
            continue;
        };
        let Some(path) = path.strip_prefix("./").and_then(|value| {
            value
                .strip_suffix(')')
                .or_else(|| value.split_once(") by ").map(|(path, _)| path))
        }) else {
            continue;
        };
        if name.is_empty() || name.len() > 512 || name.chars().any(char::is_control) {
            continue;
        }
        let Ok(parts) = path_parts(path) else {
            continue;
        };
        let id = hex::encode(Sha1::digest(path.as_bytes()));
        entries.insert(
            id.clone(),
            Entry {
                id,
                name: name.to_owned(),
                path: path.to_owned(),
                measurement: parts[0].clone(),
                rig: parts[1..parts.len() - 1].join(" / "),
            },
        );
        if entries.len() > 20000 {
            return Err("AutoEq catalogue is too large".into());
        }
    }
    if entries.is_empty() {
        return Err("AutoEq catalogue did not contain supported models".into());
    }
    Ok(entries.into_values().collect())
}
fn profile_url(sha: &str, path: &str) -> Result<reqwest::Url, String> {
    if !revision(sha) {
        return Err("Invalid AutoEq source revision".into());
    }
    path_parts(path)?;
    let name = path.rsplit('/').next().ok_or("Invalid AutoEq path")?;
    let url=reqwest::Url::parse(&format!("https://raw.githubusercontent.com/jaakkopasanen/AutoEq/{sha}/results/{path}/{name}%20ParametricEQ.txt")).map_err(|_|"Invalid AutoEq source")?;
    if url.host_str() != Some("raw.githubusercontent.com")
        || !url
            .path()
            .starts_with(&format!("/jaakkopasanen/AutoEq/{sha}/results/"))
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Invalid AutoEq source".into());
    }
    Ok(url)
}
fn search(catalogue: &Catalogue, query: &str) -> Search {
    let key = |value: &str| {
        value
            .chars()
            .filter(|ch| ch.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect::<String>()
    };
    let wanted = key(query);
    let mut matches = catalogue
        .entries
        .iter()
        .filter(|entry| key(&entry.name).contains(&wanted))
        .collect::<Vec<_>>();
    matches.sort_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then_with(|| a.measurement.cmp(&b.measurement))
            .then_with(|| a.rig.cmp(&b.rig))
    });
    Search {
        total: matches.len(),
        catalogue_size: catalogue.entries.len(),
        revision: catalogue.revision.clone(),
        checked_at: catalogue.checked_at,
        stale: !(0..TTL).contains(&now().saturating_sub(catalogue.checked_at)),
        items: matches
            .into_iter()
            .take(50)
            .map(|entry| Model {
                id: entry.id.clone(),
                name: entry.name.clone(),
                measurement: entry.measurement.clone(),
                rig: entry.rig.clone(),
                target: None,
            })
            .collect(),
    }
}
async fn text(url: reqwest::Url, limit: usize) -> Result<String, String> {
    CLIENT.get(url).send().await.map_err(|_|"AutoEq could not be reached. Try again or import a profile.")?
        .bounded_text(limit).await.map_err(|_|"AutoEq returned an unavailable or unsupported file. Try another model or import a profile.".into())
}
fn decode_catalogue(saved: &str) -> Option<Catalogue> {
    if saved.len() > 8 * 1024 * 1024 {
        return None;
    }
    serde_json::from_str::<Catalogue>(saved)
        .ok()
        .filter(|cache| {
            revision(&cache.revision)
                && !cache.entries.is_empty()
                && cache.entries.len() <= 20000
                && cache.license.contains("MIT License")
                && cache.license.len() <= 16384
                && cache.entries.iter().all(|entry| {
                    entry.id == hex::encode(Sha1::digest(entry.path.as_bytes()))
                        && !entry.name.is_empty()
                        && entry.name.len() <= 512
                        && !entry.name.chars().any(char::is_control)
                        && entry.measurement.len() <= 512
                        && entry.rig.len() <= 2048
                        && path_parts(&entry.path).is_ok()
                })
        })
}
async fn load(
    app: &tauri::AppHandle,
    state: &AutoEqState,
) -> Result<Option<Arc<Catalogue>>, String> {
    if let Some(catalogue) = state
        .catalogue
        .read()
        .map_err(|_| "AutoEq cache unavailable")?
        .clone()
    {
        return Ok(Some(catalogue));
    }
    let saved = app
        .state::<DbState>()
        .read(|conn| db::kv::get(conn, KEY))
        .await?;
    let Some(saved) = saved else { return Ok(None) };
    let Some(catalogue) = decode_catalogue(&saved) else {
        return Ok(None);
    };
    let catalogue = Arc::new(catalogue);
    let mut current = state
        .catalogue
        .write()
        .map_err(|_| "AutoEq cache unavailable")?;
    Ok(Some(current.get_or_insert(catalogue).clone()))
}
async fn refresh(app: &tauri::AppHandle, state: &AutoEqState) -> Result<Arc<Catalogue>, String> {
    let old = load(app, state).await?;
    if state.retry_at.load(Ordering::Relaxed) > now() {
        return old.ok_or(
            "AutoEq is temporarily unavailable. Try again shortly or import a profile.".into(),
        );
    }
    let work = async {
        let head = text(
            reqwest::Url::parse(
                "https://api.github.com/repos/jaakkopasanen/AutoEq/git/ref/heads/master",
            )
            .unwrap(),
            65536,
        )
        .await?;
        let head: serde_json::Value =
            serde_json::from_str(&head).map_err(|_| "AutoEq source revision was unavailable")?;
        let sha = head["object"]["sha"]
            .as_str()
            .filter(|value| revision(value))
            .ok_or("AutoEq source revision was unavailable")?;
        let (index, license) = tokio::try_join!(
            text(
                reqwest::Url::parse(&format!(
                    "https://raw.githubusercontent.com/jaakkopasanen/AutoEq/{sha}/results/INDEX.md"
                ))
                .unwrap(),
                4 * 1024 * 1024
            ),
            text(
                reqwest::Url::parse(&format!(
                    "https://raw.githubusercontent.com/jaakkopasanen/AutoEq/{sha}/LICENSE"
                ))
                .unwrap(),
                16384
            )
        )?;
        let entries = parse_index(&index)?;
        if entries.len() < 100 || !license.contains("MIT License") {
            return Err("AutoEq catalogue was incomplete".into());
        }
        Ok::<_, String>(Arc::new(Catalogue {
            revision: sha.into(),
            checked_at: now(),
            license,
            entries,
        }))
    };
    let result = tokio::time::timeout(Duration::from_secs(25), work)
        .await
        .unwrap_or_else(|_| Err("AutoEq catalogue request timed out".into()));
    let catalogue = match result {
        Ok(catalogue) => catalogue,
        Err(error) => {
            state.retry_at.store(now() + 60000, Ordering::Relaxed);
            return old.ok_or(error);
        }
    };
    let saved = serde_json::to_string(&*catalogue).map_err(|_| "AutoEq cache unavailable")?;
    app.state::<DbState>()
        .write(move |conn| db::kv::set(conn, KEY, &saved))
        .await?;
    *state
        .catalogue
        .write()
        .map_err(|_| "AutoEq cache unavailable")? = Some(catalogue.clone());
    let _ = app.emit(
        "autoeq-catalogue-updated",
        serde_json::json!({"revision":catalogue.revision}),
    );
    Ok(catalogue)
}
#[tauri::command]
pub async fn autoeq_search(app: tauri::AppHandle, query: String) -> Result<Search, String> {
    if query.trim().chars().count() < 2 || query.len() > 256 {
        return Err("Enter between 2 and 256 characters to search headphone models".into());
    }
    let state = app.state::<Arc<AutoEqState>>().inner().clone();
    if let Some(catalogue) = load(&app, &state).await? {
        let result = search(&catalogue, &query);
        if result.stale {
            let background = app.clone();
            let owner = state.clone();
            tauri::async_runtime::spawn(async move {
                if let Ok(_guard) = owner.refresh.try_lock() {
                    let _ = refresh(&background, &owner).await;
                }
            });
        }
        return Ok(result);
    }
    let _guard = state.refresh.lock().await;
    let catalogue = match load(&app, &state).await? {
        Some(catalogue) => catalogue,
        None => refresh(&app, &state).await?,
    };
    Ok(search(&catalogue, &query))
}
#[tauri::command]
pub async fn autoeq_download(
    app: tauri::AppHandle,
    model_id: String,
    source_revision: String,
) -> Result<Download, String> {
    let state = app.state::<Arc<AutoEqState>>();
    let catalogue = load(&app, &state)
        .await?
        .ok_or("Search AutoEq models before choosing a profile")?;
    if catalogue.revision != source_revision {
        return Err(
            "The AutoEq catalogue changed. Search again to choose its current profile.".into(),
        );
    }
    let entry = catalogue
        .entries
        .iter()
        .find(|entry| entry.id == model_id)
        .ok_or("Choose a model from the AutoEq search results")?;
    let url = profile_url(&catalogue.revision, &entry.path)?;
    let contents = text(url.clone(), 65536).await?;
    if !contents.contains("Preamp:") || !contents.contains("Filter ") || contents.contains('\0') {
        return Err("This AutoEq result did not contain a parametric profile".into());
    }
    Ok(Download {
        name: entry.name.clone(),
        text: contents,
        url: url.to_string(),
        revision: catalogue.revision.clone(),
        measurement: entry.measurement.clone(),
        rig: entry.rig.clone(),
        target: None,
        license: catalogue.license.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    const SHA: &str = "7ae0f56d53074872b028649617a22bbb4232feb7";
    #[tokio::test]
    async fn public_transport_rejects_redirects_and_oversized_profile_bodies() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for response in ["HTTP/1.1 302 Found\r\nLocation: /other\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_owned(),
                format!("HTTP/1.1 200 OK\r\nContent-Length: 65537\r\nConnection: close\r\n\r\n{}", "x".repeat(65537))] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0;4096]; let _ = socket.read(&mut request).await;
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        assert!(text(reqwest::Url::parse(&base).unwrap(), 65536)
            .await
            .is_err());
        assert!(text(reqwest::Url::parse(&base).unwrap(), 65536)
            .await
            .is_err());
        server.await.unwrap();
    }
    #[test]
    fn corrupt_cached_catalogues_cannot_replace_a_valid_pinned_selection() {
        let catalogue = Catalogue {
            revision: SHA.into(),
            checked_at: now(),
            license: "MIT License".into(),
            entries: parse_index("- [Model](./source/rig/Model) by source on rig").unwrap(),
        };
        let valid = serde_json::to_value(&catalogue).unwrap();
        assert!(decode_catalogue(&valid.to_string()).is_some());
        for (field, value) in [("revision", "master"), ("license", "missing attribution")] {
            let mut corrupt = valid.clone();
            corrupt[field] = value.into();
            assert!(decode_catalogue(&corrupt.to_string()).is_none());
        }
        let mut corrupt = valid.clone();
        corrupt["entries"][0]["path"] = "../outside/model".into();
        assert!(decode_catalogue(&corrupt.to_string()).is_none());
        assert!(decode_catalogue("truncated").is_none());
        assert!(decode_catalogue(&"x".repeat(8 * 1024 * 1024 + 1)).is_none());
        assert!(decode_catalogue(&valid.to_string()).is_some());
    }
    #[tokio::test]
    #[ignore = "explicit read-only public AutoEq catalogue/profile validation"]
    async fn live_pinned_public_catalogue_and_profile_are_compatible() {
        let index = text(
            reqwest::Url::parse(&format!(
                "https://raw.githubusercontent.com/jaakkopasanen/AutoEq/{SHA}/results/INDEX.md"
            ))
            .unwrap(),
            4 * 1024 * 1024,
        )
        .await
        .unwrap();
        let entries = parse_index(&index).unwrap();
        let entry = entries
            .iter()
            .find(|entry| {
                entry.name == "Sennheiser HD 650"
                    && entry.measurement == "oratory1990"
                    && entry.rig == "over-ear"
            })
            .unwrap();
        let profile = text(profile_url(SHA, &entry.path).unwrap(), 65536)
            .await
            .unwrap();
        assert!(profile.starts_with("Preamp:"));
        assert_eq!(
            profile
                .lines()
                .filter(|line| line.starts_with("Filter "))
                .count(),
            10
        );
        println!(
            "autoeq_public_sample revision={SHA} catalogue_models={} profile_bytes={}",
            entries.len(),
            profile.len()
        );
    }
    #[test]
    fn catalogue_retains_source_rig_and_exact_hardware_variants_without_inventing_target() {
        let entries=parse_index("# Index\n- [Headphone (ANC On)](./oratory1990/over-ear/Headphone%20(ANC%20On)) by oratory1990 on GRAS\n- [Headphone (ANC Off)](./Rtings/GRAS%2043AG/Headphone%20(ANC%20Off)) by Rtings on GRAS 43AG").unwrap();
        let catalogue = Catalogue {
            revision: SHA.into(),
            checked_at: now(),
            license: "notice".into(),
            entries,
        };
        let result = search(&catalogue, "headphone");
        assert_eq!(result.total, 2);
        assert!(result.items.iter().all(|item| item.target.is_none()));
        assert!(result
            .items
            .iter()
            .any(|item| item.name.ends_with("(ANC On)") && item.measurement == "oratory1990"));
        assert!(result.items.iter().any(|item| item.rig == "GRAS 43AG"));
    }
    #[test]
    fn profile_paths_cannot_escape_pinned_results_or_change_hosts() {
        let url = profile_url(SHA, "oratory1990/over-ear/Sennheiser%20HD%20650").unwrap();
        assert!(url
            .as_str()
            .ends_with("/Sennheiser%20HD%20650%20ParametricEQ.txt"));
        for path in [
            "../outside/model",
            "source/%2e%2e/model",
            "source/rig/%2Foutside",
            "source/rig/name?token=secret",
            "https://evil.example/source/model",
            "source/rig/name#fragment",
        ] {
            assert!(profile_url(SHA, path).is_err(), "{path}");
        }
        assert!(profile_url("master", "source/rig/model").is_err());
        assert_eq!(decode("A+B%20%26%20C").unwrap(), "A+B & C");
    }
    #[test]
    fn search_payload_is_bounded_and_saved_catalogue_is_separate_from_selected_corrections() {
        let lines = (0..1000)
            .map(|index| format!("- [Model {index}](./source/rig/Model%20{index})"))
            .collect::<Vec<_>>()
            .join("\n");
        let catalogue = Catalogue {
            revision: SHA.into(),
            checked_at: 1,
            license: "MIT License retained".into(),
            entries: parse_index(&lines).unwrap(),
        };
        let result = search(&catalogue, "Model");
        assert_eq!(result.total, 1000);
        assert_eq!(result.items.len(), 50);
        assert!(result.stale);
        let restored = decode_catalogue(&serde_json::to_string(&catalogue).unwrap()).unwrap();
        assert_eq!(restored.license, "MIT License retained");
        assert_eq!(restored.revision, SHA);
        assert!(parse_index("# unavailable catalogue").is_err());
    }
}
