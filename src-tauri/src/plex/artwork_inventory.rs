//! Plex poster/background inventory and reviewed, single-attempt selection/uploads.
//! Contract: Plex official item/{element}; PlexAPI mixins.resources and BaseResource.
use super::{PlexClient, metadata_edit::MetadataEditKind};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ArtworkRole { Poster, Background }
impl ArtworkRole {
    pub fn inventory(self) -> &'static str { if self == Self::Poster { "posters" } else { "arts" } }
    fn element(self) -> &'static str { if self == Self::Poster { "poster" } else { "art" } }
    fn field(self) -> &'static str { if self == Self::Poster { "thumb" } else { "art" } }
}

pub struct InventoryEntry { pub id: String, pub key: String, pub preview: Option<String>, pub provider: String, pub selected: bool }
pub struct Inventory { pub baseline: String, pub current: Option<String>, pub entries: Vec<InventoryEntry> }
pub struct PreparedArtworkEdit { pub item_id: i64, pub section_id: i64, pub kind: MetadataEditKind, pub role: ArtworkRole,
    pub inventory: Inventory, choice: Option<String>, upload: Option<Vec<u8>> }
fn fingerprint(values: &Value) -> String { format!("{:x}", Sha256::digest(values.to_string().as_bytes())) }
fn numeric(value: Option<&Value>) -> Option<i64> { value.and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok())) }
fn bounded(value: Option<&Value>, max: usize) -> Option<String> { value?.as_str().filter(|s| !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control)).map(str::to_owned) }
fn truth(value: Option<&Value>) -> bool { matches!(value, Some(Value::Bool(true))) || numeric(value) == Some(1) }
pub fn candidate_id(role: ArtworkRole, key: &str) -> String { fingerprint(&serde_json::json!([role, key])) }

/// Inventory paths are admitted only for this item's image endpoints. Never a
/// broad authentication exception for arbitrary provider/server URLs.
pub fn preview_url(client: &PlexClient, item_id: i64, role: ArtworkRole, value: &str) -> Option<String> {
    if value.len() > 4096 || value.contains('\\') || value.chars().any(char::is_control) { return None; }
    let target = if value.starts_with('/') && !value.starts_with("//") { url::Url::parse(&client.build_endpoint_url(value)).ok()? }
        else { url::Url::parse(value).ok()? };
    if !super::artwork::public_url(&target) || target.fragment().is_some() { return None; }
    if target.query_pairs().any(|(key, _)| matches!(key.to_ascii_lowercase().as_str(), "token" | "access_token" | "api_key" | "apikey" | "authorization")) { return None; }
    if !client.is_plex_url(target.as_str()) { return Some(target.into()); }
    let base = url::Url::parse(client.base_url()).ok()?;
    let path = target.path().strip_prefix(base.path().trim_end_matches('/'))?;
    let root = format!("/library/metadata/{item_id}/");
    let suffix = path.strip_prefix(&root)?;
    let (element, rest) = suffix.split_once('/').unwrap_or((suffix, ""));
    if !matches!(element, "thumb" | "art") && element != role.inventory() { return None; }
    if rest.contains('%') || rest.split('/').any(|part| part == "." || part == "..") { return None; }
    // Display routes have no operation parameters; only Plex's dimensions are accepted.
    if target.query_pairs().any(|(key, _)| !matches!(key.as_ref(), "width" | "height" | "minSize" | "upscale")) { return None; }
    Some(target.into())
}

/// Local/embedded inventory images use /file?url=<native resource key> on
/// current PMS. Bind that exception to the exact key returned for this choice;
/// it must never become a general authenticated file or transcode endpoint.
fn inventory_preview_url(client: &PlexClient, item_id: i64, role: ArtworkRole, value: &str, key: &str) -> Option<String> {
    if let Some(url) = preview_url(client, item_id, role, value) { return Some(url); }
    if value.len() > 4096 || !value.starts_with('/') || value.starts_with("//")
        || value.contains('\\') || value.chars().any(char::is_control) { return None; }
    let resource = url::Url::parse(key).ok()?;
    if !matches!(resource.scheme(), "metadata" | "media" | "upload")
        || !resource.username().is_empty() || resource.password().is_some()
        || resource.query().is_some() || resource.fragment().is_some() { return None; }
    let target = url::Url::parse(&client.build_endpoint_url(value)).ok()?;
    if !super::artwork::public_url(&target) || target.fragment().is_some() || !client.is_plex_url(target.as_str()) { return None; }
    let base = url::Url::parse(client.base_url()).ok()?;
    let path = target.path().strip_prefix(base.path().trim_end_matches('/'))?;
    if path != format!("/library/metadata/{item_id}/file") { return None; }
    let params: Vec<_> = target.query_pairs().collect();
    if params.len() != 1 || params[0].0 != "url" || params[0].1 != key { return None; }
    Some(target.into())
}

impl PlexClient {
    async fn artwork_item(&self, section_id: i64, item_id: i64, kind: MetadataEditKind) -> Result<Value> {
        if self.offline_only || section_id <= 0 || item_id <= 0 { bail!("Reconnect to the Plex music library.") }
        let section = self.get_section(section_id).await?;
        if section.key != section_id || section.section_type != "artist"
            || (self.library_scope != self.cache_scope_for_library(section_id, section.uuid.as_deref())
                && self.library_scope != self.cache_scope_for_library(section_id, None)) { bail!("Plex music library changed.") }
        let metadata: Value = self.get(&format!("/library/metadata/{item_id}")).await?;
        let items = metadata.get("Metadata").and_then(Value::as_array).context("Invalid Plex metadata.")?;
        if items.len() != 1 { bail!("Ambiguous Plex item.") }
        let item = &items[0];
        let expected_kind = if kind == MetadataEditKind::Artist { "artist" } else { "album" };
        if numeric(item.get("ratingKey")) != Some(item_id) || numeric(item.get("librarySectionID")) != Some(section_id)
            || item.get("type").and_then(Value::as_str) != Some(expected_kind) { bail!("Plex item or library changed.") }
        Ok(item.clone())
    }
    pub async fn artwork_inventory(&self, section_id: i64, item_id: i64, kind: MetadataEditKind, role: ArtworkRole) -> Result<Inventory> {
        let item = self.artwork_item(section_id, item_id, kind).await?;
        let response: Value = self.get(&format!("/library/metadata/{item_id}/{}", role.inventory())).await?;
        // PMS serializes XML <Photo> records under Metadata in its JSON
        // response. Older servers/adapters may retain Photo; accept both.
        // A malformed/nonempty response must not masquerade as an empty list.
        let photos = match response.get("Metadata").or_else(|| response.get("Photo")) {
            Some(value) => Some(value.as_array().context("Invalid Plex artwork inventory.")?),
            None if numeric(response.get("size")).unwrap_or(0) > 0 => bail!("Invalid Plex artwork inventory."),
            None => None,
        };
        let mut entries = vec![];
        if let Some(photos) = photos {
            if photos.len() > 200 { bail!("Plex artwork inventory exceeds its limit.") }
            for photo in photos {
                let Some(key) = bounded(photo.get("ratingKey"), 4096) else { continue; };
                // Selection keys stay native and must be safe URL values, never credentials.
                if key.to_ascii_lowercase().contains("x-plex-token") { continue; }
                let id = candidate_id(role, &key);
                if entries.iter().any(|e: &InventoryEntry| e.id == id) { continue; }
                let preview = bounded(photo.get("thumb"), 4096).or_else(|| bounded(photo.get("key"), 4096))
                    .and_then(|url| inventory_preview_url(self, item_id, role, &url, &key));
                entries.push(InventoryEntry { id, key, preview, provider: bounded(photo.get("provider"), 100).unwrap_or_else(|| "Plex".into()), selected: truth(photo.get("selected")) });
            }
        }
        let current = bounded(item.get(role.field()), 4096);
        let selected: Vec<_> = entries.iter().filter(|e| e.selected).map(|e| e.id.as_str()).collect();
        let locks = item.get("Field").and_then(Value::as_array).map(|fields| fields.iter().filter(|f| f.get("name").and_then(Value::as_str) == Some(role.field())).cloned().collect::<Vec<_>>()).unwrap_or_default();
        let baseline = fingerprint(&serde_json::json!([current, selected, locks]));
        Ok(Inventory { baseline, current, entries })
    }
    pub async fn prepare_artwork_edit(&self, section_id: i64, item_id: i64, kind: MetadataEditKind, role: ArtworkRole,
        baseline: &str, choice: Option<String>, upload: Option<Vec<u8>>) -> Result<PreparedArtworkEdit> {
        if choice.is_some() == upload.is_some() { bail!("Choose one artwork change.") }
        let upload = if let Some(bytes) = upload {
            if bytes.is_empty() || bytes.len() > crate::image_fetch::MAX_IMAGE_BYTES { bail!("Artwork upload exceeds 8 MiB.") }
            let validated = crate::image_content::validate(bytes, None).await.context("Choose a complete, supported raster image.")?;
            if validated.len() > crate::image_fetch::MAX_IMAGE_BYTES { bail!("Artwork upload exceeds 8 MiB after validation.") }
            Some(validated)
        } else { None };
        let inventory = self.artwork_inventory(section_id, item_id, kind, role).await?;
        if baseline != inventory.baseline { bail!("Plex artwork changed. Reload before saving.") }
        if let Some(id) = &choice {
            let entry = inventory.entries.iter().find(|e| &e.id == id).context("Artwork choice is no longer available.")?;
            if entry.selected { bail!("This artwork is already selected.") }
        }
        Ok(PreparedArtworkEdit { section_id, item_id, kind, role, inventory, choice, upload })
    }
    pub async fn commit_artwork_edit_once(&self, prepared: &PreparedArtworkEdit) -> Result<()> {
        if let Some(id) = &prepared.choice {
            let entry = prepared.inventory.entries.iter().find(|e| &e.id == id).context("Artwork choice missing.")?;
            self.mutate_params_once(reqwest::Method::PUT, &format!("/library/metadata/{}/{}", prepared.item_id, prepared.role.element()),
                &[("url", &entry.key)], None, None).await
        } else {
            let bytes = prepared.upload.as_ref().context("Artwork upload missing.")?;
            self.mutate_params_once(reqwest::Method::POST, &format!("/library/metadata/{}/{}", prepared.item_id, prepared.role.inventory()),
                &[], Some(bytes.clone()), crate::image_content::mime(bytes)).await
        }
    }
    pub async fn verify_artwork_edit(&self, prepared: &PreparedArtworkEdit) -> Result<Inventory> {
        let result = self.artwork_inventory(prepared.section_id, prepared.item_id, prepared.kind, prepared.role).await?;
        let verified = if let Some(id) = &prepared.choice { result.entries.iter().any(|e| &e.id == id && e.selected) }
            else { result.entries.iter().any(|e| e.selected && !prepared.inventory.entries.iter().any(|old| old.id == e.id)) };
        if !verified { bail!("Plex did not confirm the artwork change. Reload before trying again.") }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    fn fixture(replies: Vec<(u16, Value)>) -> (PlexClient, std::thread::JoinHandle<Vec<Vec<u8>>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/proxy", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut requests = vec![];
            for (status, body) in replies {
                listener.set_nonblocking(true).unwrap();
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
                let (mut stream, _) = loop { match listener.accept() { Ok(value) => break value, Err(error) if error.kind() == std::io::ErrorKind::WouldBlock && std::time::Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(5)), Err(error) => panic!("Fixture request missing: {error}") } };
                // macOS inherits the listener's nonblocking mode on accepted sockets.
                stream.set_nonblocking(false).unwrap();
                stream.set_read_timeout(Some(std::time::Duration::from_secs(3))).unwrap();
                let mut bytes = vec![]; let mut buffer = [0; 4096];
                let boundary = loop {
                    let count = stream.read(&mut buffer).unwrap(); assert!(count > 0); bytes.extend_from_slice(&buffer[..count]);
                    if let Some(position) = bytes.windows(4).position(|s| s == b"\r\n\r\n") { break position + 4; }
                };
                let length = String::from_utf8_lossy(&bytes[..boundary]).lines().find_map(|line| {
                    let (key, value) = line.split_once(':')?; key.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().unwrap())
                }).unwrap_or(0);
                while bytes.len() < boundary + length { let count = stream.read(&mut buffer).unwrap(); assert!(count > 0); bytes.extend_from_slice(&buffer[..count]); }
                requests.push(bytes);
                let body = serde_json::json!({"MediaContainer":body}).to_string();
                write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
            listener.set_nonblocking(true).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(150));
            assert!(listener.accept().is_err(), "Mutation was retried");
            requests
        });
        let mut client = PlexClient::new(super::super::PlexClientConfig { base_url: base, token: "fixture-token".into(), ..Default::default() }).unwrap();
        client.machine_identifier = "fixture-server".into(); client.library_scope = client.cache_scope_for_library(5, Some("fixture-library"));
        (client, server)
    }
    fn replies(selected: usize) -> Vec<(u16, Value)> {
        vec![
            (200, serde_json::json!({"Directory":[{"key":"5","type":"artist","uuid":"fixture-library"}]})),
            (200, serde_json::json!({"Metadata":[{"ratingKey":"11","librarySectionID":5,"type":"album","thumb":format!("/library/metadata/11/thumb/{selected}")}]})),
            (200, serde_json::json!({"size":2,"Metadata":[{"ratingKey":"metadata://poster/a","key":"/library/metadata/11/posters/a","selected":selected==1},{"ratingKey":"metadata://poster/b","key":"/library/metadata/11/posters/b","selected":selected==2}]})),
        ]
    }
    #[tokio::test] async fn json_metadata_inventory_preserves_both_posters_and_selection() {
        let mut sequence = replies(1);
        // The requested library need not be the first section in the roster.
        sequence[0].1["Directory"].as_array_mut().unwrap().insert(0,
            serde_json::json!({"key":"2","type":"movie","uuid":"other-library"}));
        let (client, server) = fixture(sequence);
        let inventory = client.artwork_inventory(5, 11, MetadataEditKind::Album, ArtworkRole::Poster).await.unwrap();
        assert_eq!(inventory.entries.len(), 2);
        assert!(inventory.entries[0].selected);
        assert!(!inventory.entries[1].selected);
        assert!(inventory.entries.iter().all(|entry| entry.preview.is_some()));
        let requests = server.join().unwrap();
        let paths: Vec<_> = requests.iter().map(|request| String::from_utf8_lossy(request)
            .split_whitespace().nth(1).unwrap().split('?').next().unwrap().to_owned()).collect();
        assert_eq!(paths[0], "/proxy/library/sections");
        assert_eq!(paths[2], "/proxy/library/metadata/11/posters");
    }
    #[tokio::test] async fn legacy_photo_inventory_remains_supported() {
        let mut sequence = replies(2);
        let body = &mut sequence[2].1;
        body["Photo"] = body.as_object_mut().unwrap().remove("Metadata").unwrap();
        let (client, server) = fixture(sequence);
        let inventory = client.artwork_inventory(5, 11, MetadataEditKind::Album, ArtworkRole::Poster).await.unwrap();
        assert_eq!(inventory.entries.len(), 2);
        assert!(inventory.entries[1].selected);
        server.join().unwrap();
    }
    #[tokio::test] async fn malformed_nonempty_inventory_does_not_claim_no_choices() {
        for body in [serde_json::json!({"size":2}), serde_json::json!({"Metadata":{}})] {
            let mut sequence = replies(1); sequence[2].1 = body;
            let (client, server) = fixture(sequence);
            assert!(client.artwork_inventory(5, 11, MetadataEditKind::Album, ArtworkRole::Poster).await.is_err());
            server.join().unwrap();
        }
    }
    #[tokio::test] async fn selection_is_reviewed_once_and_proven_afterward() {
        let mut sequence = replies(1); sequence.extend(replies(1)); sequence.push((200, serde_json::json!({}))); sequence.extend(replies(2));
        let (client, server) = fixture(sequence);
        let before = client.artwork_inventory(5, 11, MetadataEditKind::Album, ArtworkRole::Poster).await.unwrap();
        let prepared = client.prepare_artwork_edit(5, 11, MetadataEditKind::Album, ArtworkRole::Poster, &before.baseline,
            Some(candidate_id(ArtworkRole::Poster, "metadata://poster/b")), None).await.unwrap();
        client.commit_artwork_edit_once(&prepared).await.unwrap(); client.verify_artwork_edit(&prepared).await.unwrap();
        let requests = server.join().unwrap(); assert_eq!(requests.len(), 10);
        let write = String::from_utf8_lossy(&requests[6]);
        assert!(write.starts_with("PUT /proxy/library/metadata/11/poster?url=metadata%3A%2F%2Fposter%2Fb "));
        assert_eq!(requests.iter().filter(|r| r.starts_with(b"PUT ")).count(), 1);
        assert!(!write.lines().next().unwrap().contains("fixture-token"));
    }
    #[tokio::test] async fn changed_preview_never_dispatches_a_write() {
        let (client, server) = fixture(replies(2));
        assert!(client.prepare_artwork_edit(5, 11, MetadataEditKind::Album, ArtworkRole::Poster, "older-baseline",
            Some(candidate_id(ArtworkRole::Poster, "metadata://poster/b")), None).await.is_err());
        assert!(server.join().unwrap().iter().all(|r| r.starts_with(b"GET ")));
    }
    #[tokio::test] async fn unconfirmed_selection_is_not_retried() {
        let mut sequence = replies(1); sequence.extend(replies(1)); sequence.push((503, serde_json::json!({})));
        let (client, server) = fixture(sequence);
        let before = client.artwork_inventory(5, 11, MetadataEditKind::Album, ArtworkRole::Poster).await.unwrap();
        let prepared = client.prepare_artwork_edit(5, 11, MetadataEditKind::Album, ArtworkRole::Poster, &before.baseline,
            Some(candidate_id(ArtworkRole::Poster, "metadata://poster/b")), None).await.unwrap();
        assert!(client.commit_artwork_edit_once(&prepared).await.is_err());
        assert_eq!(server.join().unwrap().iter().filter(|r| r.starts_with(b"PUT ")).count(), 1);
    }
    #[tokio::test] async fn validated_upload_sends_raster_bytes_to_the_role_endpoint() {
        let mut sequence = replies(1); sequence.extend(replies(1)); sequence.push((200, serde_json::json!({})));
        let (client, server) = fixture(sequence); let image = crate::image_content::test_png();
        let before = client.artwork_inventory(5, 11, MetadataEditKind::Album, ArtworkRole::Poster).await.unwrap();
        let prepared = client.prepare_artwork_edit(5, 11, MetadataEditKind::Album, ArtworkRole::Poster, &before.baseline, None, Some(image.clone())).await.unwrap();
        client.commit_artwork_edit_once(&prepared).await.unwrap();
        let requests = server.join().unwrap(); let upload = &requests[6];
        assert!(upload.starts_with(b"POST /proxy/library/metadata/11/posters "));
        let boundary = upload.windows(4).position(|p| p == b"\r\n\r\n").unwrap() + 4;
        assert_eq!(&upload[boundary..], image);
        assert!(String::from_utf8_lossy(&upload[..boundary]).to_ascii_lowercase().contains("content-type: image/png"));
    }
    #[test] fn preview_paths_never_authorize_other_routes_or_credentials() {
        let client = PlexClient::new(super::super::PlexClientConfig { base_url: "http://127.0.0.1:1/proxy".into(), ..Default::default() }).unwrap();
        for good in ["/library/metadata/1/thumb/123", "/library/metadata/1/posters/abc.jpg", "/library/metadata/1/arts/abc.jpg"] {
            assert!(preview_url(&client, 1, if good.contains("arts") { ArtworkRole::Background } else { ArtworkRole::Poster }, good).is_some());
        }
        for bad in ["/library/metadata/2/thumb/123", "/library/metadata/1/posters/../preferences", "/library/metadata/1/posters/%2e%2e", "/library/metadata/1/posters/a?url=/identity", "//attacker.test/private", "https://user:password@cdn.test/image", "https://cdn.test/image?X-Plex-Token=secret"] {
            assert!(preview_url(&client, 1, ArtworkRole::Poster, bad).is_none(), "{bad}");
        }
    }
    #[test] fn role_and_candidate_keys_stay_separate() {
        assert_ne!(candidate_id(ArtworkRole::Poster, "same"), candidate_id(ArtworkRole::Background, "same"));
    }
    #[test] fn local_file_preview_is_bound_to_exact_inventory_resource_and_item() {
        let client = PlexClient::new(super::super::PlexClientConfig { base_url: "http://127.0.0.1:1/proxy".into(), ..Default::default() }).unwrap();
        let key = "metadata://posters/fixture-image.jpg";
        let good = "/library/metadata/1/file?url=metadata%3A%2F%2Fposters%2Ffixture-image.jpg";
        assert!(inventory_preview_url(&client, 1, ArtworkRole::Poster, good, key).is_some());
        // The generic image allowlist still cannot authenticate this route.
        assert!(preview_url(&client, 1, ArtworkRole::Poster, good).is_none());
        for (url, key) in [
            (good, "metadata://posters/different-image.jpg"),
            ("/library/metadata/2/file?url=metadata%3A%2F%2Fposters%2Ffixture-image.jpg", key),
            ("/library/metadata/1/file?url=metadata%3A%2F%2Fposters%2Ffixture-image.jpg&url=/identity", key),
            ("/library/metadata/1/file?url=https%3A%2F%2Fattacker.test%2Fprivate", "https://attacker.test/private"),
            ("/library/metadata/1/file?url=metadata%3A%2F%2Fposters%2Ffixture-image.jpg&X-Plex-Token=secret", key),
        ] { assert!(inventory_preview_url(&client, 1, ArtworkRole::Poster, url, key).is_none()); }
    }
}
