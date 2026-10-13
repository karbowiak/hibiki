//! Explicit values/locks for bounded music metadata edits.
use super::{metadata_edit::MetadataEditKind, PlexClient};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum AdvancedValue {
    Text(String),
    Tags(Vec<String>),
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AdvancedField {
    pub value: AdvancedValue,
    pub locked: Option<bool>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvancedMetadata {
    pub item_id: i64,
    pub kind: String,
    pub fields: BTreeMap<String, AdvancedField>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdvancedPatch {
    pub expected: BTreeMap<String, AdvancedField>,
    pub changes: BTreeMap<String, AdvancedField>,
}
pub struct PreparedAdvancedEdit {
    path: String,
    params: Vec<(String, String)>,
}
fn definition(key: &str) -> Option<(&'static str, Option<&'static str>)> {
    Some(match key {
        "sortTitle" => ("titleSort", None),
        "studio" => ("studio", None),
        "posterLock" => ("thumb", None),
        "backgroundLock" => ("art", None),
        "genres" => ("genre", Some("Genre")),
        "styles" => ("style", Some("Style")),
        "moods" => ("mood", Some("Mood")),
        "labels" => ("label", Some("Label")),
        _ => return None,
    })
}
fn positive(value: Option<&Value>) -> Option<i64> {
    value
        .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok()))
        .filter(|v| *v > 0)
}
fn lock(value: &Value) -> Result<bool> {
    match value {
        Value::Bool(v) => Ok(*v),
        Value::Number(v) if v.as_i64() == Some(0) => Ok(false),
        Value::Number(v) if v.as_i64() == Some(1) => Ok(true),
        Value::String(v) if v == "0" => Ok(false),
        Value::String(v) if v == "1" => Ok(true),
        _ => bail!("Plex returned an invalid lock state"),
    }
}
fn text(value: &str) -> Result<()> {
    if value.chars().count() > 512 || value.chars().any(char::is_control) {
        bail!("Metadata value contains invalid characters or exceeds bounds")
    }
    Ok(())
}
fn validate(field: &AdvancedField, tags: bool) -> Result<()> {
    if field.locked.is_none() {
        bail!("Explicit original and requested lock states are required")
    }
    match (&field.value, tags) {
        (AdvancedValue::Text(v), false) => text(v)?,
        (AdvancedValue::Tags(v), true) => {
            if v.len() > 64 {
                bail!("Too many metadata tags")
            }
            let mut seen = HashSet::new();
            for tag in v {
                text(tag)?;
                if tag.trim().is_empty() || !seen.insert(tag) {
                    bail!("Metadata tags must be nonempty and unique")
                }
            }
        }
        _ => bail!("Invalid metadata field type"),
    };
    Ok(())
}
fn parse(
    item: &Value,
    item_id: i64,
    section: i64,
    kind: MetadataEditKind,
) -> Result<AdvancedMetadata> {
    let name = if kind == MetadataEditKind::Artist {
        "artist"
    } else {
        "album"
    };
    if positive(item.get("ratingKey")) != Some(item_id)
        || positive(item.get("librarySectionID")) != Some(section)
        || item.get("type").and_then(Value::as_str) != Some(name)
    {
        bail!("Plex metadata identity changed")
    }
    let mut locks = BTreeMap::new();
    if let Some(raw) = item.get("Field") {
        let fields = raw.as_array().context("Invalid Plex field locks")?;
        if fields.len() > 128 {
            bail!("Too many Plex field locks")
        };
        for field in fields {
            let key = field
                .get("name")
                .and_then(Value::as_str)
                .context("Invalid Plex field name")?;
            let value = field
                .get("locked")
                .context("Plex field entry omitted its lock state")?;
            {
                if locks.insert(key.to_owned(), lock(value)?).is_some() {
                    bail!("Ambiguous Plex field locks")
                }
            }
        }
    }
    let mut fields = BTreeMap::new();
    for key in [
        "sortTitle",
        "studio",
        "genres",
        "styles",
        "moods",
        "labels",
        "posterLock",
        "backgroundLock",
    ] {
        if key == "studio" && kind == MetadataEditKind::Artist {
            continue;
        }
        let (wire, tag) = definition(key).unwrap();
        let value = if let Some(tag) = tag {
            let values = match item.get(tag) {
                None | Some(Value::Null) => vec![],
                Some(v) => {
                    let values = v.as_array().context("Invalid Plex metadata tags")?;
                    if values.len() > 64 {
                        bail!("Too many Plex tags")
                    };
                    values
                        .iter()
                        .map(|v| {
                            v.get("tag")
                                .and_then(Value::as_str)
                                .map(str::to_owned)
                                .context("Invalid Plex tag")
                        })
                        .collect::<Result<Vec<_>>>()?
                }
            };
            AdvancedValue::Tags(values)
        } else {
            AdvancedValue::Text(match item.get(wire) {
                None | Some(Value::Null) => String::new(),
                Some(Value::String(v)) => v.clone(),
                _ => bail!("Invalid Plex text metadata"),
            })
        };
        let value = if wire == "thumb" || wire == "art" {
            let AdvancedValue::Text(raw) = value else {
                unreachable!()
            };
            // Expose only a conflict fingerprint, never a private artwork URL.
            AdvancedValue::Text(format!("{:x}", Sha256::digest(raw.as_bytes())))
        } else {
            value
        };
        let field = AdvancedField {
            value,
            locked: Some(locks.get(wire).copied().unwrap_or(false)),
        };
        // Bounds apply even to unknown-lock fields, which remain read-only.
        let checked = AdvancedField {
            locked: Some(false),
            ..field.clone()
        };
        validate(&checked, tag.is_some())?;
        fields.insert(key.to_owned(), field);
    }
    Ok(AdvancedMetadata {
        item_id,
        kind: name.into(),
        fields,
    })
}
fn params(current: &AdvancedMetadata, patch: &AdvancedPatch) -> Result<Vec<(String, String)>> {
    if patch.changes.is_empty()
        || patch.changes.len() > 8
        || patch.expected.len() != patch.changes.len()
    {
        bail!("Specify changed metadata fields and original values")
    }
    let mut result = vec![];
    for (key, next) in &patch.changes {
        let (wire, tag) = definition(key).context("Unsupported metadata field")?;
        let before = patch
            .expected
            .get(key)
            .context("Missing original metadata")?;
        validate(before, tag.is_some())?;
        validate(next, tag.is_some())?;
        if current.fields.get(key) != Some(before) {
            bail!("Plex metadata or field lock changed; reload the preview")
        }
        if (wire == "thumb" || wire == "art") && before.value != next.value {
            bail!("Artwork values cannot be changed through field locks")
        }
        if before == next {
            bail!("Metadata field has no changes")
        }
        result.push((
            format!("{wire}.locked"),
            if next.locked == Some(true) { "1" } else { "0" }.into(),
        ));
        match (&before.value, &next.value) {
            (AdvancedValue::Text(_), AdvancedValue::Text(_))
                if wire == "thumb" || wire == "art" => {}
            (AdvancedValue::Text(_), AdvancedValue::Text(value)) => {
                result.push((format!("{wire}.value"), value.clone()))
            }
            (AdvancedValue::Tags(old), AdvancedValue::Tags(new)) => {
                for (index, value) in new.iter().filter(|v| !old.contains(v)).enumerate() {
                    result.push((format!("{wire}[{index}].tag.tag"), value.clone()))
                }
                let removed: Vec<_> = old
                    .iter()
                    .filter(|v| !new.contains(v))
                    .map(|v| {
                        url::form_urlencoded::byte_serialize(v.as_bytes())
                            .collect::<String>()
                            .replace('+', "%20")
                    })
                    .collect();
                if !removed.is_empty() {
                    result.push((format!("{wire}[].tag.tag-"), removed.join(",")))
                }
            }
            _ => bail!("Invalid metadata field type"),
        }
    }
    Ok(result)
}
impl PlexClient {
    pub async fn advanced_metadata(
        &self,
        section_id: i64,
        item_id: i64,
        kind: MetadataEditKind,
    ) -> Result<AdvancedMetadata> {
        if self.offline_only || section_id <= 0 || item_id <= 0 {
            bail!("Reconnect to edit Plex metadata")
        }
        let section = self.get_section(section_id).await?;
        if section.section_type != "artist"
            || (self.library_scope
                != self.cache_scope_for_library(section_id, section.uuid.as_deref())
                && self.library_scope != self.cache_scope_for_library(section_id, None))
        {
            bail!("Plex library changed")
        }
        let container: Value = self.get(&format!("/library/metadata/{item_id}")).await?;
        let items = container
            .get("Metadata")
            .and_then(Value::as_array)
            .context("Invalid Plex item detail")?;
        if items.len() != 1 {
            bail!("Ambiguous Plex item detail")
        }
        parse(&items[0], item_id, section_id, kind)
    }
    pub async fn prepare_advanced_metadata_edit(
        &self,
        section_id: i64,
        item_id: i64,
        kind: MetadataEditKind,
        patch: &AdvancedPatch,
    ) -> Result<PreparedAdvancedEdit> {
        let current = self.advanced_metadata(section_id, item_id, kind).await?;
        let mut values = params(&current, patch)?;
        values.push(("id".into(), item_id.to_string()));
        values.push((
            "type".into(),
            if kind == MetadataEditKind::Artist {
                "8"
            } else {
                "9"
            }
            .into(),
        ));
        Ok(PreparedAdvancedEdit {
            path: format!("/library/sections/{section_id}/all"),
            params: values,
        })
    }
    pub async fn commit_advanced_metadata_once(
        &self,
        prepared: PreparedAdvancedEdit,
    ) -> Result<()> {
        let params: Vec<_> = prepared
            .params
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        self.put_metadata_params_once(&prepared.path, &params).await
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn detail() -> Value {
        json!({"ratingKey":"12","librarySectionID":5,"type":"album","titleSort":"Original","studio":"Label","Genre":[{"tag":"Rock, Pop"},{"tag":"日本 / Jazz"}],"Field":[{"name":"titleSort","locked":0},{"name":"studio","locked":"1"},{"name":"genre","locked":true}]})
    }
    #[tokio::test]
    async fn advanced_edit_is_one_proxy_scoped_put_with_encoded_tag_removal() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/proxy", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut requests = vec![];
            for index in 0..3 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut bytes = vec![];
                let mut buffer = [0; 4096];
                loop {
                    let count = stream.read(&mut buffer).unwrap();
                    bytes.extend_from_slice(&buffer[..count]);
                    if count == 0 || bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                let request = String::from_utf8(bytes).unwrap();
                let head = request
                    .lines()
                    .next()
                    .unwrap()
                    .split_whitespace()
                    .collect::<Vec<_>>();
                let url = url::Url::parse(&format!("http://test{}", head[1])).unwrap();
                assert!(request
                    .to_lowercase()
                    .contains("x-plex-token: synthetic-token"));
                let body = match index {
                    0 => {
                        assert_eq!(head[0], "GET");
                        assert_eq!(url.path(), "/proxy/library/sections");
                        json!({"MediaContainer":{"Directory":[{"key":"5","type":"artist","uuid":"library"}]}})
                    }
                    1 => {
                        assert_eq!(head[0], "GET");
                        assert_eq!(url.path(), "/proxy/library/metadata/12");
                        json!({"MediaContainer":{"Metadata":[detail()]}})
                    }
                    _ => {
                        assert_eq!(head[0], "PUT");
                        assert_eq!(url.path(), "/proxy/library/sections/5/all");
                        let query: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
                        assert_eq!(
                            query.get("genre[].tag.tag-").unwrap(),
                            "Rock%2C%20Pop,%E6%97%A5%E6%9C%AC%20%2F%20Jazz"
                        );
                        assert_eq!(query.get("genre[0].tag.tag").unwrap(), "New + Genre");
                        assert_eq!(query.get("genre.locked").unwrap(), "0");
                        assert!(!query.contains_key("includeLoudnessRamps"));
                        json!({})
                    }
                };
                requests.push(request);
                let body = body.to_string();
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
            }
            requests
        });
        let mut client = PlexClient::new(super::super::PlexClientConfig {
            base_url: base,
            token: "synthetic-token".into(),
            ..Default::default()
        })
        .unwrap();
        client.library_scope = client.cache_scope_for_library(5, Some("library"));
        let original = parse(&detail(), 12, 5, MetadataEditKind::Album).unwrap();
        let patch = AdvancedPatch {
            expected: BTreeMap::from([("genres".into(), original.fields["genres"].clone())]),
            changes: BTreeMap::from([(
                "genres".into(),
                AdvancedField {
                    value: AdvancedValue::Tags(vec!["New + Genre".into()]),
                    locked: Some(false),
                },
            )]),
        };
        let prepared = client
            .prepare_advanced_metadata_edit(5, 12, MetadataEditKind::Album, &patch)
            .await
            .unwrap();
        client
            .commit_advanced_metadata_once(prepared)
            .await
            .unwrap();
        assert_eq!(server.join().unwrap().len(), 3);
    }
    #[test]
    fn detail_locks_absence_and_identity_are_honest() {
        let result = parse(&detail(), 12, 5, MetadataEditKind::Album).unwrap();
        assert_eq!(result.fields["sortTitle"].locked, Some(false));
        assert_eq!(result.fields["genres"].locked, Some(true));
        assert_eq!(result.fields["moods"].locked, Some(false));
        assert!(parse(&detail(), 13, 5, MetadataEditKind::Album).is_err());
        assert!(parse(&detail(), 12, 6, MetadataEditKind::Album).is_err());
        assert!(parse(&detail(), 12, 5, MetadataEditKind::Artist).is_err());
        let mut invalid = detail();
        invalid["Field"] = json!([{"name":"studio","locked":0},{"name":"studio","locked":1}]);
        assert!(parse(&invalid, 12, 5, MetadataEditKind::Album).is_err());
    }
    #[test]
    fn artwork_locks_never_expose_or_replace_private_image_urls() {
        let mut item = detail();
        item["thumb"] = json!("https://private.invalid/art?token=secret");
        let current = parse(&item, 12, 5, MetadataEditKind::Album).unwrap();
        let before = current.fields["posterLock"].clone();
        assert!(!serde_json::to_string(&current)
            .unwrap()
            .contains("private.invalid"));
        let mut next = before.clone();
        next.locked = Some(true);
        let mut patch = AdvancedPatch {
            expected: BTreeMap::from([("posterLock".into(), before)]),
            changes: BTreeMap::from([("posterLock".into(), next)]),
        };
        assert_eq!(
            params(&current, &patch).unwrap(),
            vec![("thumb.locked".into(), "1".into())]
        );
        patch.changes.get_mut("posterLock").unwrap().value =
            AdvancedValue::Text("foreign-image".into());
        assert!(params(&current, &patch).is_err());
        item["Field"] = json!([{"name":"thumb"}]);
        assert!(parse(&item, 12, 5, MetadataEditKind::Album).is_err());
    }
    #[test]
    fn exact_values_and_locks_guard_encoded_tag_diff() {
        let current = parse(&detail(), 12, 5, MetadataEditKind::Album).unwrap();
        let before = current.fields["genres"].clone();
        let next = AdvancedField {
            value: AdvancedValue::Tags(vec!["New + Genre".into()]),
            locked: Some(false),
        };
        let mut patch = AdvancedPatch {
            expected: BTreeMap::from([("genres".into(), before)]),
            changes: BTreeMap::from([("genres".into(), next)]),
        };
        let output = params(&current, &patch).unwrap();
        assert!(output.contains(&("genre[0].tag.tag".into(), "New + Genre".into())));
        assert!(output.contains(&("genre.locked".into(), "0".into())));
        assert_eq!(
            output
                .iter()
                .find(|(k, _)| k == "genre[].tag.tag-")
                .unwrap()
                .1,
            "Rock%2C%20Pop,%E6%97%A5%E6%9C%AC%20%2F%20Jazz"
        );
        patch.expected.get_mut("genres").unwrap().locked = Some(false);
        assert!(params(&current, &patch).is_err());
        patch.expected.get_mut("genres").unwrap().locked = None;
        assert!(params(&current, &patch).is_err());
    }
}
