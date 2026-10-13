//! Bounded catalogue pages retain raw fields and validate actual PMS paging.
use super::{
    client::{request_error, token_header},
    PlexClient,
};
use crate::http_response::BoundedResponseExt;
use anyhow::{Context, Result};
use serde_json::Value;

/// PMS can emit malformed UTF-8 from imported tags in otherwise valid JSON.
/// Preserve each original byte sequence next to the affected native document,
/// instead of inventing an encoding or silently discarding the bad text. Valid
/// UTF-8, structural JSON and object keys retain normal strict parsing.
pub(crate) fn decode_json<T: serde::de::DeserializeOwned>(body: &[u8]) -> Result<T> {
    if std::str::from_utf8(body).is_ok() {
        return serde_json::from_slice(body).context("Failed to parse Plex JSON");
    }
    const MAX_REPAIRS: usize = 65536;
    let prefix = format!("__HIBIKI_UTF8_{}_", uuid::Uuid::new_v4().simple());
    anyhow::ensure!(
        !body
            .windows(prefix.len())
            .any(|bytes| bytes == prefix.as_bytes()),
        "Plex JSON recovery marker collision"
    );
    let mut patched = Vec::new();
    patched
        .try_reserve_exact(body.len())
        .context("Cannot allocate bounded Plex JSON recovery")?;
    let mut bytes = Vec::<(usize, String)>::new();
    let mut cursor = 0;
    while cursor < body.len() {
        match std::str::from_utf8(&body[cursor..]) {
            Ok(_) => {
                patched.extend_from_slice(&body[cursor..]);
                break;
            }
            Err(error) => {
                let start = cursor + error.valid_up_to();
                let end = start + error.error_len().unwrap_or(body.len() - start);
                patched.extend_from_slice(&body[cursor..start]);
                anyhow::ensure!(
                    bytes.len() < MAX_REPAIRS,
                    "Plex JSON malformed-text recovery exceeds its bound"
                );
                let marker = format!("{prefix}{:x}__", bytes.len());
                patched.extend_from_slice(marker.as_bytes());
                bytes.push((
                    start,
                    body[start..end]
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect(),
                ));
                cursor = end;
            }
        }
    }
    let mut raw: Value = serde_json::from_slice(&patched)
        .context("Plex JSON is malformed beyond UTF-8 value text")?;
    let mut repairs = Vec::<Value>::new();
    recover_values(&mut raw, "", &prefix, &bytes, &mut repairs)?;
    let count = repairs.len();
    // Attach provenance to each raw metadata/directory record so the scoped
    // archive retains it when the outer MediaContainer is discarded.
    let mut grouped = std::collections::BTreeMap::<(String, usize), Vec<Value>>::new();
    let mut remaining = Vec::new();
    for mut repair in repairs {
        let path = repair["path"].as_str().unwrap_or_default().to_owned();
        let destination = ["Metadata", "Directory"].into_iter().find_map(|kind| {
            let rest = path.strip_prefix(&format!("/MediaContainer/{kind}/"))?;
            let (index, field) = rest.split_once('/')?;
            Some((
                kind.to_owned(),
                index.parse::<usize>().ok()?,
                format!("/{field}"),
            ))
        });
        if let Some((kind, index, path)) = destination {
            repair["path"] = Value::String(path);
            grouped.entry((kind, index)).or_default().push(repair);
        } else {
            remaining.push(repair);
        }
    }
    for ((kind, index), fields) in grouped {
        let record = raw["MediaContainer"][kind]
            .as_array_mut()
            .and_then(|items| items.get_mut(index))
            .and_then(Value::as_object_mut)
            .context("Missing Plex text-recovery record")?;
        append_recovery(record, fields);
    }
    if !remaining.is_empty() {
        let object = raw
            .as_object_mut()
            .context("Missing Plex text-recovery envelope")?;
        append_recovery(object, remaining);
    }
    tracing::warn!(
        fields = count,
        "Plex returned malformed UTF-8 value text; native original-byte provenance retained"
    );
    serde_json::from_value(raw).context("Failed to decode recovered Plex JSON")
}
fn append_recovery(object: &mut serde_json::Map<String, Value>, fields: Vec<Value>) {
    let mut key = "_hibikiInvalidUtf8".to_owned();
    let mut suffix = 0;
    while object.contains_key(&key) {
        suffix += 1;
        key = format!("_hibikiInvalidUtf8_{suffix}");
    }
    object.insert(
        key,
        serde_json::json!({
            "policy":"invalid UTF-8 value bytes replaced with U+FFFD",
            "offsetUnit":"unicode scalar values", "fields":fields
        }),
    );
}
fn credential_path(path: &str, text: &str) -> bool {
    let secret = |key: &str| {
        matches!(
            key.replace(['-', '_'], "").to_ascii_lowercase().as_str(),
            "token"
                | "xplextoken"
                | "accesstoken"
                | "authorization"
                | "apikey"
                | "password"
                | "secret"
        )
    };
    if path.split('/').any(secret) {
        return true;
    }
    if url::Url::parse(text)
        .ok()
        .is_some_and(|url| !url.username().is_empty() || url.password().is_some())
    {
        return true;
    }
    // Provenance may never reintroduce a byte belonging to an authenticated
    // URL after normal archive cleaning removes that URL's credential query.
    if let Some((_, query)) = text.split_once('?') {
        if url::form_urlencoded::parse(query.split('#').next().unwrap_or_default().as_bytes())
            .any(|(key, _)| secret(&key))
        {
            return true;
        }
    }
    false
}
fn recover_values(
    value: &mut Value,
    path: &str,
    prefix: &str,
    bytes: &[(usize, String)],
    repairs: &mut Vec<Value>,
) -> Result<()> {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                anyhow::ensure!(
                    !key.contains(prefix),
                    "Plex JSON contains a malformed UTF-8 object key"
                );
                recover_values(
                    value,
                    &format!("{path}/{}", key.replace('~', "~0").replace('/', "~1")),
                    prefix,
                    bytes,
                    repairs,
                )?;
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter_mut().enumerate() {
                recover_values(item, &format!("{path}/{index}"), prefix, bytes, repairs)?;
            }
        }
        Value::String(text) => {
            if !text.contains(prefix) {
                return Ok(());
            }
            let mut out = String::new();
            let mut cursor = 0;
            let mut characters = 0;
            let mut positions = Vec::new();
            while let Some(start) = text[cursor..]
                .find(prefix)
                .map(|relative| cursor + relative)
            {
                let plain = &text[cursor..start];
                out.push_str(plain);
                characters += plain.chars().count();
                let after = start + prefix.len();
                let end = text[after..]
                    .find("__")
                    .map(|relative| after + relative)
                    .context("Invalid Plex text-recovery marker")?;
                let index = usize::from_str_radix(&text[after..end], 16)
                    .context("Invalid Plex text-recovery marker")?;
                let (offset, hex) = bytes
                    .get(index)
                    .context("Invalid Plex text-recovery index")?;
                positions.push(serde_json::json!({"characterOffset":characters,"sourceByteOffset":offset,"bytesHex":hex}));
                out.push('\u{fffd}');
                characters += 1;
                cursor = end + 2;
            }
            out.push_str(&text[cursor..]);
            if !credential_path(path, &out) {
                repairs.push(serde_json::json!({"path":path,"replacements":positions}));
            }
            *text = out;
        }
        _ => {}
    }
    Ok(())
}

/// Analysis identity depends on the media and actual analysis revision, not a
/// metadata edit timestamp (which also changes for ratings/tags).
pub(crate) fn analysis_revision(
    media: &super::Media,
    music_version: Option<i64>,
) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    Ok(format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&(media, music_version)).map_err(|_| "Invalid analysis revision")?
        )
    ))
}
pub struct Page {
    pub items: Vec<Value>,
    pub total: Option<i64>,
    pub server_time: Option<i64>,
}
pub fn number(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|v| v.parse().ok()))
}

fn parse_page(
    container: Value,
    offset: i64,
    limit: i64,
    header_start: Option<i64>,
    header_total: Option<i64>,
) -> Result<Page> {
    let items = match container.get("Metadata") {
        Some(Value::Array(items)) => items.clone(),
        None => Vec::new(),
        _ => anyhow::bail!("Invalid Plex catalogue records"),
    };
    anyhow::ensure!(
        items.len() <= limit as usize,
        "Plex ignored the catalogue page size"
    );
    let start = container
        .get("offset")
        .map(|v| number(v).context("Invalid Plex page offset"))
        .transpose()?;
    anyhow::ensure!(
        start.is_none() || header_start.is_none() || start == header_start,
        "Conflicting Plex page offsets"
    );
    anyhow::ensure!(
        start.or(header_start).is_none_or(|start| start == offset),
        "Plex returned a nonadvancing catalogue page"
    );
    let body_total = container
        .get("totalSize")
        .map(|v| number(v).context("Invalid Plex page total"))
        .transpose()?;
    anyhow::ensure!(
        body_total.is_none_or(|v| v >= 0) && header_total.is_none_or(|v| v >= 0),
        "Invalid Plex page total"
    );
    // A few playlist endpoints return totalSize=0 alongside nonempty pages.
    let meaningful = |v: Option<i64>| v.filter(|n| *n > 0 || items.is_empty());
    let body_total = meaningful(body_total);
    let header_total = meaningful(header_total);
    anyhow::ensure!(
        body_total.is_none() || header_total.is_none() || body_total == header_total,
        "Conflicting Plex page totals"
    );
    let total = body_total.or(header_total);
    anyhow::ensure!(
        total.is_none_or(|n| n >= offset + items.len() as i64),
        "Plex catalogue page exceeded its total"
    );
    Ok(Page {
        items,
        total,
        server_time: None,
    })
}

impl PlexClient {
    /// Path and filters are native constants, never renderer-provided URLs.
    pub async fn catalogue_page(
        &self,
        path: &str,
        offset: i64,
        limit: i64,
        filters: &[(&str, String)],
    ) -> Result<Page> {
        anyhow::ensure!(
            offset >= 0 && (1..=500).contains(&limit),
            "Invalid catalogue page request"
        );
        let response = self
            .client
            .get(self.build_url(path))
            .query(filters)
            .query(&[
                ("X-Plex-Container-Start", offset.to_string()),
                ("X-Plex-Container-Size", limit.to_string()),
            ])
            .header("X-Plex-Token", token_header(&self.token))
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(request_error)
            .context("Catalogue page request failed")?;
        anyhow::ensure!(
            response.status().is_success(),
            "Plex catalogue returned HTTP {}",
            response.status()
        );
        let header = |name: &str| -> Result<Option<i64>> {
            response
                .headers()
                .get(name)
                .map(|v| {
                    v.to_str()
                        .context("Invalid catalogue header")?
                        .parse::<i64>()
                        .context("Invalid catalogue header")
                })
                .transpose()
        };
        let server_time = response
            .headers()
            .get("Date")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| chrono::DateTime::parse_from_rfc2822(v).ok())
            .map(|v| v.timestamp());
        let start = header("X-Plex-Container-Start")?;
        let total = header("X-Plex-Container-Total-Size")?;
        let raw: Value = response
            .bounded_plex_json(16 * 1024 * 1024)
            .await
            .context("Catalogue response exceeds its bounds or is invalid")?;
        let container = raw
            .get("MediaContainer")
            .context("Missing Plex catalogue container")?
            .clone();
        // Playlist ratingKeys may repeat legitimately; without either returned
        // offset we cannot prove that a later page actually advanced.
        if path.starts_with("/playlists/") && offset > 0 {
            anyhow::ensure!(
                start.is_some() || container.get("offset").is_some(),
                "Plex did not confirm its playlist page offset"
            );
        }
        let mut page = parse_page(container, offset, limit, start, total)?;
        page.server_time = server_time;
        Ok(page)
    }

    /// A genuine authenticated 404 is distinct from transport/JSON failures.
    /// Callers still verify the owning native account, server and section.
    pub async fn catalogue_lookup(&self, id: i64, playlist: bool) -> Result<Option<Value>> {
        anyhow::ensure!(id > 0, "Invalid catalogue identity");
        let path = if playlist {
            format!("/playlists/{id}")
        } else {
            format!(
                "/library/metadata/{id}?includeGuids=1&includeLyrics=1&resolveTags=1&skipRefresh=1"
            )
        };
        let response = self
            .client
            .get(self.build_url(&path))
            .header("X-Plex-Token", token_header(&self.token))
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(request_error)
            .context("Catalogue lookup failed")?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let raw: Value = response
            .bounded_plex_json(16 * 1024 * 1024)
            .await
            .context("Catalogue lookup is unavailable or invalid")?;
        let items = raw["MediaContainer"]["Metadata"]
            .as_array()
            .context("Missing catalogue lookup records")?;
        anyhow::ensure!(
            items.len() == 1 && number(&items[0]["ratingKey"]) == Some(id),
            "Plex returned a different catalogue item"
        );
        Ok(Some(items[0].clone()))
    }
    pub async fn catalogue_details(&self, ids: &[i64]) -> Result<Vec<Value>> {
        anyhow::ensure!(
            !ids.is_empty() && ids.len() <= 50 && ids.iter().all(|id| *id > 0),
            "Invalid catalogue detail batch"
        );
        let raw: Value = self
            .get(&format!(
                "/library/metadata/{}?includeGuids=1&includeLyrics=1&resolveTags=1&skipRefresh=1",
                ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",")
            ))
            .await?;
        let items = raw["Metadata"]
            .as_array()
            .context("Missing catalogue detail records")?;
        anyhow::ensure!(
            items.len() <= ids.len(),
            "Plex returned too many detail records"
        );
        let mut seen = std::collections::HashSet::new();
        for item in items {
            let id = number(&item["ratingKey"]).context("Invalid catalogue detail identity")?;
            anyhow::ensure!(
                ids.contains(&id) && seen.insert(id),
                "Plex returned a different or repeated detail item"
            );
        }
        // Removed items can be absent; never substitute an adjacent item.
        Ok(items.clone())
    }
}

/// Compare ordered playlist occurrences, allowing the same track more than
/// once. Timestamps/artwork and track metadata are independent of membership.
pub(crate) fn playlist_membership_matches(expected: &[Value], actual: &[Value]) -> Result<bool> {
    fn identity(item: &Value) -> Result<(i64, Option<i64>)> {
        anyhow::ensure!(
            item["type"].as_str() == Some("track"),
            "Invalid playlist track"
        );
        let track = number(&item["ratingKey"])
            .filter(|id| *id > 0)
            .context("Invalid playlist identity")?;
        let occurrence = if item["playlistItemID"].is_null() {
            None
        } else {
            Some(
                number(&item["playlistItemID"])
                    .filter(|id| *id > 0)
                    .context("Invalid playlist occurrence")?,
            )
        };
        Ok((track, occurrence))
    }
    if expected.len() != actual.len() {
        return Ok(false);
    }
    for (expected, actual) in expected.iter().zip(actual) {
        if identity(expected)? != identity(actual)? {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn playlist_membership_checks_occurrence_order_instead_of_artwork_and_timestamps() {
        let entry = |track, occurrence| serde_json::json!({"type":"track","ratingKey":track,"playlistItemID":occurrence});
        let a = entry(1, 10);
        let b = entry(1, 11);
        let mut refreshed = a.clone();
        refreshed["ratingKey"] = serde_json::json!("1");
        refreshed["playlistItemID"] = serde_json::json!("10");
        refreshed["updatedAt"] = serde_json::json!(999);
        refreshed["thumb"] = serde_json::json!("/changed-artwork");
        assert!(
            playlist_membership_matches(&[a.clone(), b.clone()], &[refreshed, b.clone()]).unwrap()
        );
        assert!(
            !playlist_membership_matches(&[a.clone(), b.clone()], &[b.clone(), a.clone()]).unwrap()
        );
        assert!(
            !playlist_membership_matches(&[a.clone(), b.clone()], &[a.clone(), entry(2, 11)])
                .unwrap()
        );
        assert!(!playlist_membership_matches(&[a.clone(), b], &[a.clone()]).unwrap());
        assert!(playlist_membership_matches(&[], &[]).unwrap());
        assert!(playlist_membership_matches(&[a.clone()], &[entry(1, 0)]).is_err());
        let no_occurrence = serde_json::json!({"type":"track","ratingKey":1});
        assert!(
            playlist_membership_matches(&[no_occurrence.clone()], &[no_occurrence.clone()])
                .unwrap()
        );
        assert!(!playlist_membership_matches(&[a], &[no_occurrence]).unwrap());
    }
    fn malformed_fixture() -> Vec<u8> {
        let mut bytes = br#"{"MediaContainer":{"offset":15000,"totalSize":15200,"Metadata":[{"ratingKey":"17","title":"Bj"#.to_vec();
        bytes.extend_from_slice("örk ".as_bytes());
        bytes.extend_from_slice(b"\xe9");
        bytes.extend_from_slice(br#"\u0021","Image":[{"alt":"caf"#);
        bytes.extend_from_slice(b"\xe9");
        bytes.extend_from_slice(br#""}],"Media":[{"id":1,"Part":[{"Stream":[{"id":2,"audioChannelLayout":"stereo"}]}]}],"unknown":{"a/b~c":"x"#);
        bytes.extend_from_slice(b"\xff\xc3\xb6\xe9");
        bytes.extend_from_slice(br#""},"_hibikiInvalidUtf8":{"source":"preserved"}}]}}"#);
        bytes
    }
    #[test]
    fn malformed_value_text_retains_original_bytes_and_unknown_full_metadata() {
        let source = malformed_fixture();
        assert!(serde_json::from_slice::<Value>(&source).is_err());
        let raw: Value = decode_json(&source).unwrap();
        let record = &raw["MediaContainer"]["Metadata"][0];
        assert_eq!(record["title"], "Björk \u{fffd}!");
        assert_eq!(record["Image"][0]["alt"], "caf\u{fffd}");
        assert_eq!(record["unknown"]["a/b~c"], "x\u{fffd}ö\u{fffd}");
        assert_eq!(record["Media"][0]["Part"][0]["Stream"][0]["id"], 2);
        assert_eq!(record["_hibikiInvalidUtf8"]["source"], "preserved");
        let fields = record["_hibikiInvalidUtf8_1"]["fields"].as_array().unwrap();
        assert_eq!(fields.len(), 3);
        let title = fields.iter().find(|v| v["path"] == "/title").unwrap();
        assert_eq!(title["replacements"][0]["characterOffset"], 6);
        for field in fields {
            let value = record
                .pointer(field["path"].as_str().unwrap())
                .unwrap()
                .as_str()
                .unwrap();
            for replacement in field["replacements"].as_array().unwrap() {
                let character = replacement["characterOffset"].as_u64().unwrap() as usize;
                assert_eq!(value.chars().nth(character), Some('\u{fffd}'));
                let offset = replacement["sourceByteOffset"].as_u64().unwrap() as usize;
                let hex = replacement["bytesHex"].as_str().unwrap();
                let bytes: Vec<u8> = (0..hex.len())
                    .step_by(2)
                    .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
                    .collect();
                assert_eq!(&source[offset..offset + bytes.len()], bytes.as_slice());
            }
        }
        let unchanged =
            br#"{"MediaContainer":{"Metadata":[{"title":"normal\u00e9","unknown":17}]}}"#;
        assert_eq!(
            decode_json::<Value>(unchanged).unwrap(),
            serde_json::from_slice::<Value>(unchanged).unwrap()
        );
    }
    #[test]
    fn recovery_rejects_invalid_keys_structure_truncation_and_excessive_repairs() {
        for bytes in [
            b"{\"\xe9\":1}".as_slice(),
            b"{\"a\":\xe9}".as_slice(),
            b"{\"a\":\"\xe9\",}".as_slice(),
            b"{\"a\":\"\xe9".as_slice(),
            b"{\"a\":\"\xe9\"".as_slice(),
            b"{\"a\":\"\\\xe9\"}".as_slice(),
        ] {
            assert!(decode_json::<Value>(bytes).is_err());
        }
        let mut too_many = b"{\"a\":\"".to_vec();
        too_many.extend(std::iter::repeat_n(0xff, 65537));
        too_many.extend_from_slice(b"\"}");
        assert!(decode_json::<Value>(&too_many).is_err());
    }
    #[test]
    fn recovery_does_not_archive_credential_bytes_or_authenticated_url_provenance() {
        let bytes = b"{\"MediaContainer\":{\"Metadata\":[{\"token\":\"abc\xe9\",\"key\":\"/library/metadata/1?X-Plex-Token=abc\xe9&keep=%2f\",\"url\":\"http://u:p\xe9@example.invalid/a\",\"title\":\"caf\xe9\"}]}}";
        let raw: Value = decode_json(bytes).unwrap();
        let record = &raw["MediaContainer"]["Metadata"][0];
        let fields = record["_hibikiInvalidUtf8"]["fields"].as_array().unwrap();
        assert_eq!(fields.len(), 1);
        assert_eq!(fields[0]["path"], "/title");
        let cleaned = crate::db::catalogue::clean_document(record).unwrap();
        assert!(cleaned.get("token").is_none());
        assert_eq!(cleaned["key"], "/library/metadata/1?keep=%2f");
        assert_eq!(cleaned["url"], "http://example.invalid/a");
        assert_eq!(
            cleaned["_hibikiInvalidUtf8"]["fields"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    #[tokio::test]
    #[ignore = "Requires explicit private Plex settings path; read-only malformed album page/detail proof"]
    async fn private_malformed_catalogue_page_and_detail_proof() {
        let settings_path = std::env::var("HIBIKI_CATALOGUE_PROOF_SETTINGS")
            .expect("Set HIBIKI_CATALOGUE_PROOF_SETTINGS explicitly");
        let settings: crate::plex::PlexSettings =
            serde_json::from_slice(&std::fs::read(settings_path).unwrap()).unwrap();
        let client = PlexClient::new(crate::plex::PlexClientConfig {
            base_url: settings.base_url,
            token: settings.token,
            client_id: settings.client_id,
            ..Default::default()
        })
        .unwrap();
        let identity = client
            .get_identity()
            .await
            .expect("Private identity request failed");
        assert_eq!(identity.machine_identifier, settings.machine_identifier);
        let sections = client
            .get_all_sections()
            .await
            .expect("Private section request failed");
        assert!(sections.iter().any(|s| s.key == settings.section_id
            && s.section_type == "artist"
            && s.uuid.as_deref() == Some(&settings.section_uuid)));
        let page = client
            .catalogue_page(
                &format!("/library/sections/{}/all", settings.section_id),
                15000,
                200,
                &[
                    ("type", "9".into()),
                    ("includeGuids", "1".into()),
                    ("includeLyrics", "1".into()),
                    ("resolveTags", "1".into()),
                ],
            )
            .await
            .expect("Malformed private album page recovery failed");
        assert_eq!(page.items.len(), 200);
        let repaired: Vec<_> = page
            .items
            .iter()
            .filter(|item| item.get("_hibikiInvalidUtf8").is_some())
            .collect();
        assert!(!repaired.is_empty());
        let ids: Vec<_> = repaired
            .iter()
            .map(|item| number(&item["ratingKey"]).unwrap())
            .collect();
        let details = client
            .catalogue_details(&ids)
            .await
            .expect("Malformed private detail recovery failed");
        assert_eq!(details.len(), ids.len());
        for id in ids {
            client
                .get_album(id)
                .await
                .expect("Malformed private typed album recovery failed");
        }
        let next = client
            .catalogue_page(
                &format!("/library/sections/{}/all", settings.section_id),
                15200,
                200,
                &[
                    ("type", "9".into()),
                    ("includeGuids", "1".into()),
                    ("includeLyrics", "1".into()),
                    ("resolveTags", "1".into()),
                ],
            )
            .await
            .expect("Next private album page failed");
        assert_eq!(next.items.len(), 200);
        eprintln!("Read-only Plex proof: recovered 200-row album page at offset 15000 ({} affected records); full raw and typed details succeeded; next 200-row page at 15200 succeeded",repaired.len());
    }
    #[test]
    fn pages_use_reported_totals_and_reject_oversized_repeated_or_conflicting_offsets() {
        let page = serde_json::json!({"offset":"10","totalSize":"12","Metadata":[{"ratingKey":"11"},{"ratingKey":"12"}]});
        assert_eq!(
            parse_page(page.clone(), 10, 2, Some(10), Some(12))
                .unwrap()
                .total,
            Some(12)
        );
        assert!(parse_page(page.clone(), 20, 2, None, None).is_err());
        assert!(parse_page(page.clone(), 10, 1, None, None).is_err());
        assert!(parse_page(page.clone(), 10, 2, Some(0), None).is_err());
        assert!(parse_page(page, 10, 2, None, Some(30)).is_err());
        assert!(parse_page(
            serde_json::json!({"Metadata":[{}],"totalSize":0}),
            0,
            2,
            None,
            None
        )
        .unwrap()
        .total
        .is_none());
    }
}
