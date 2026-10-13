//! Only verified Plex inventory entries issue authenticated thumbnail references.
use crate::commands::{PlexRequestContext, PlexState};
use crate::plex::artwork_inventory::{ArtworkRole, Inventory};
use crate::plex::metadata_edit::MetadataEditKind;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};

#[derive(Clone)]
struct Reference { revision: u64, scope: String, preview: String, created: std::time::Instant }
#[derive(Default)]
pub struct ArtworkInventoryState(Mutex<HashMap<String, Reference>>);
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtworkCandidate { id: String, source_url: Option<String>, label: String, selected: bool }
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtworkInventory { baseline: String, candidates: Vec<ArtworkCandidate> }

impl ArtworkInventoryState {
    fn issue(&self, context: &PlexRequestContext, inventory: Inventory) -> Result<ArtworkInventory, String> {
        let mut registry = self.0.lock().map_err(|_| "Artwork inventory is unavailable")?;
        registry.retain(|_, entry| entry.revision == context.connection_revision && entry.scope == context.cache_scope
            && entry.created.elapsed() < std::time::Duration::from_secs(1800));
        let candidates = inventory.entries.into_iter().map(|entry| {
            let source_url = entry.preview.and_then(|preview| {
                if registry.len() >= 1000 {
                    if let Some(oldest) = registry.iter().min_by_key(|(_, r)| r.created).map(|(key, _)| key.clone()) { registry.remove(&oldest); }
                }
                let reference = uuid::Uuid::new_v4().to_string();
                registry.insert(reference.clone(), Reference { revision: context.connection_revision, scope: context.cache_scope.clone(), preview, created: std::time::Instant::now() });
                Some(format!("plexartwork://image/{reference}"))
            });
            ArtworkCandidate { id: entry.id, source_url, label: entry.provider, selected: entry.selected }
        }).collect();
        Ok(ArtworkInventory { baseline: inventory.baseline, candidates })
    }
    fn lookup(&self, source: &str, context: &crate::image_protocol::ImageContext) -> Option<String> {
        let url = url::Url::parse(source).ok()?;
        if source.len() > 100 || url.scheme() != "plexartwork" || url.host_str() != Some("image")
            || !url.username().is_empty() || url.password().is_some() || url.port().is_some() || url.query().is_some() || url.fragment().is_some() { return None; }
        let id = url.path().strip_prefix('/')?;
        uuid::Uuid::parse_str(id).ok()?;
        let registry = self.0.lock().ok()?;
        let entry = registry.get(id)?;
        (entry.revision == context.revision && entry.scope == context.cache_scope()
            && entry.created.elapsed() < std::time::Duration::from_secs(1800)).then(|| entry.preview.clone())
    }
}

#[tauri::command]
pub async fn get_library_artwork(context: PlexRequestContext, section_id: i64, item_id: i64, kind: MetadataEditKind,
    role: ArtworkRole, state: State<'_, PlexState>, inventory: State<'_, ArtworkInventoryState>) -> Result<ArtworkInventory, String> {
    let client = { let guard = state.0.lock().await; state.checked_client(&context, &guard)?.clone() };
    let result = tokio::time::timeout(std::time::Duration::from_secs(30), client.artwork_inventory(section_id, item_id, kind, role))
        .await.map_err(|_| "Artwork inventory timed out")?.map_err(|_| "Could not load Plex artwork choices")?;
    let guard = state.0.lock().await;
    state.checked_client(&context, &guard)?;
    inventory.issue(&context, result)
}

#[tauri::command]
pub async fn save_library_artwork(context: PlexRequestContext, section_id: i64, item_id: i64, kind: MetadataEditKind,
    role: ArtworkRole, baseline: String, choice: Option<String>, upload: Option<Vec<u8>>,
    state: State<'_, PlexState>, inventory: State<'_, ArtworkInventoryState>) -> Result<ArtworkInventory, String> {
    let client = { let guard = state.0.lock().await; state.checked_client(&context, &guard)?.clone() };
    let prepared = tokio::time::timeout(std::time::Duration::from_secs(30), client.prepare_artwork_edit(section_id, item_id, kind, role, &baseline, choice, upload))
        .await.map_err(|_| "Artwork review timed out before saving")?.map_err(|error| error.to_string())?;
    {
        let guard = state.0.lock().await;
        let current = state.checked_client(&context, &guard)?;
        tokio::time::timeout(std::time::Duration::from_secs(15), current.commit_artwork_edit_once(&prepared))
            .await.map_err(|_| "Plex did not confirm the artwork change")?.map_err(|_| "Plex did not confirm the artwork change")?;
    }
    let result = tokio::time::timeout(std::time::Duration::from_secs(30), client.verify_artwork_edit(&prepared))
        .await.map_err(|_| "Plex did not confirm the artwork change")?.map_err(|_| "Plex did not confirm the artwork change")?;
    let guard = state.0.lock().await;
    state.checked_client(&context, &guard).map_err(|_| "Plex did not confirm the artwork change: the library changed")?;
    inventory.issue(&context, result)
}

pub async fn resolve_inventory_image(app: &tauri::AppHandle, source: &str, context: &crate::image_protocol::ImageContext,
    cache: Arc<crate::image_cache::ImageCache>, ticket: crate::image_cache::Ticket) -> Option<Vec<u8>> {
    let state = app.state::<PlexState>();
    if !state.image_context_is_current(context).await { return None; }
    let client = context.client.as_ref()?;
    let preview = app.state::<ArtworkInventoryState>().lookup(source, context)?;
    let key = crate::image_fetch::cache_key(context.cache_scope(), "ext", "img", &preview, "", "");
    let ticket = cache.bind_key(&ticket, &key).ok()?;
    if let Some(bytes) = crate::image_cache::read_validated(cache.clone(), ticket.clone(), key.clone()).await {
        return state.image_context_is_current(context).await.then_some(bytes);
    }
    if client.offline_only { return None; }
    let request = if client.is_plex_url(&preview) { client.registered_artwork_request(&preview) }
        else { crate::image_fetch::request(None, &preview)? };
    let bytes = crate::image_fetch::fetch(request).await?;
    let stored = bytes.clone();
    state.publish_image(context, move || cache.store_verified(&ticket, &key, &stored)).await.ok()?;
    Some(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn issued_images_are_owner_scoped_and_opaque() {
        let mut client = crate::plex::PlexClient::new(crate::plex::PlexClientConfig::default()).unwrap(); client.library_scope = "fixture-scope".into();
        let context = PlexRequestContext { connection_revision: 4, cache_scope: client.library_scope.clone() };
        let state = ArtworkInventoryState::default();
        let dto = state.issue(&context, Inventory { baseline: "snapshot".into(), current: None, entries: vec![crate::plex::artwork_inventory::InventoryEntry {
            id: "candidate".into(), key: "metadata://private-key".into(), preview: Some("http://localhost:32400/library/metadata/1/posters/image".into()), provider: "Plex".into(), selected: false }] }).unwrap();
        let source = dto.candidates[0].source_url.as_ref().unwrap();
        assert!(!serde_json::to_string(&dto).unwrap().contains("private-key"));
        assert!(state.lookup(source, &crate::image_protocol::ImageContext::new(4, Some(client.clone()))).is_some());
        assert!(state.lookup(source, &crate::image_protocol::ImageContext::new(5, Some(client.clone()))).is_none());
        client.library_scope = "other-scope".into();
        assert!(state.lookup(source, &crate::image_protocol::ImageContext::new(4, Some(client))).is_none());
    }
}
