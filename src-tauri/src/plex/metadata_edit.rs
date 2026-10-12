//! Ordinary music-library field edits, not metadata-provider installation.
use super::{LibrarySection, MediaContainer, PlexClient};
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::time::Duration;

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MetadataEditKind {
    Artist,
    Album,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MetadataEditPatch {
    pub title: Option<String>,
    pub summary: Option<String>,
    pub sort_title: Option<String>,
    pub release_date: Option<String>,
}
pub type MetadataEditExpected = BTreeMap<String, Option<String>>;
pub struct PreparedMetadataEdit {
    path: String,
    params: Vec<(String, String)>,
}
impl MetadataEditPatch {
    fn fields(&self) -> Vec<(&'static str, &'static str, &str)> {
        [
            ("title", "title", self.title.as_deref()),
            ("summary", "summary", self.summary.as_deref()),
            ("sortTitle", "titleSort", self.sort_title.as_deref()),
            (
                "releaseDate",
                "originallyAvailableAt",
                self.release_date.as_deref(),
            ),
        ]
        .into_iter()
        .filter_map(|(key, field, value)| value.map(|value| (key, field, value)))
        .collect()
    }
    pub fn validate(&self, kind: MetadataEditKind, expected: &MetadataEditExpected) -> Result<()> {
        let fields = self.fields();
        if fields.is_empty() || expected.len() != fields.len() {
            bail!("Specify changed fields and their original values.");
        }
        for (key, _, value) in fields {
            if !expected.contains_key(key) {
                bail!("Original values are required for changed fields.");
            }
            let limit = if key == "summary" { 16000 } else { 512 };
            if value.chars().count() > limit
                || value.chars().any(|ch| {
                    ch.is_control()
                        && !(key == "summary" && (ch == '\n' || ch == '\r' || ch == '\t'))
                })
            {
                bail!("Metadata text contains invalid characters or is too long.");
            }
            if key == "title" && value.trim().is_empty() {
                bail!("Title must not be empty.");
            }
            if let Some(Some(original)) = expected.get(key) {
                if original.chars().count() > limit {
                    bail!("Original metadata exceeds supported bounds.");
                }
            }
        }
        if let Some(date) = &self.release_date {
            if kind != MetadataEditKind::Album
                || date.len() != 10
                || chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err()
            {
                bail!("Album release date must be a valid YYYY-MM-DD date.");
            }
        }
        Ok(())
    }
}
fn id(value: Option<&serde_json::Value>) -> Option<i64> {
    value
        .and_then(|value| value.as_i64().or_else(|| value.as_str()?.parse().ok()))
        .filter(|value| *value > 0)
}
impl PlexClient {
    pub async fn prepare_metadata_edit(
        &self,
        section_id: i64,
        item_id: i64,
        kind: MetadataEditKind,
        patch: &MetadataEditPatch,
        expected: &MetadataEditExpected,
    ) -> Result<PreparedMetadataEdit> {
        if section_id <= 0 || item_id <= 0 {
            bail!("Plex library and item IDs must be positive.");
        }
        patch.validate(kind, expected)?;
        let sections: MediaContainer<LibrarySection> = tokio::time::timeout(
            Duration::from_secs(20),
            self.get(&format!("/library/sections/{section_id}")),
        )
        .await
        .context("Plex library verification timed out.")?
        .context("Could not verify the Plex music library.")?;
        let section = sections
            .directory
            .iter()
            .find(|section| section.key == section_id)
            .context("Plex music library was not found.")?;
        if section.section_type != "artist" {
            bail!("Metadata edits require a music library.");
        }
        let scoped = self.cache_scope_for_library(section_id, section.uuid.as_deref());
        if self.library_scope != scoped
            && self.library_scope != self.cache_scope_for_library(section_id, None)
        {
            bail!("Plex music library was superseded.");
        }
        let container: serde_json::Value = tokio::time::timeout(
            Duration::from_secs(20),
            self.get(&format!("/library/metadata/{item_id}")),
        )
        .await
        .context("Plex item verification timed out.")?
        .context("Could not verify the Plex item.")?;
        let items = container
            .get("Metadata")
            .and_then(|value| value.as_array())
            .context("Plex returned invalid item metadata.")?;
        if items.len() != 1 {
            bail!("Plex returned ambiguous item metadata.");
        }
        let item = &items[0];
        let media_type = if kind == MetadataEditKind::Artist {
            "artist"
        } else {
            "album"
        };
        if id(item.get("ratingKey")) != Some(item_id)
            || id(item.get("librarySectionID")) != Some(section_id)
            || item.get("type").and_then(|value| value.as_str()) != Some(media_type)
        {
            bail!("Plex item identity or library does not match the edit.");
        }
        let mut params = vec![
            ("id".into(), item_id.to_string()),
            (
                "type".into(),
                if kind == MetadataEditKind::Artist {
                    "8"
                } else {
                    "9"
                }
                .into(),
            ),
        ];
        for (key, field, value) in patch.fields() {
            let current = match item.get(field) {
                None | Some(serde_json::Value::Null) => None,
                Some(serde_json::Value::String(value)) => Some(value.clone()),
                _ => bail!("Plex returned an invalid original field value."),
            };
            // Missing and empty optional strings are distinct original values;
            // users must reload the preview if another client edited the field.
            if expected.get(key) != Some(&current) {
                bail!("Plex metadata changed. Reload the preview before saving.");
            }
            params.push((format!("{field}.value"), value.into()));
            params.push((format!("{field}.locked"), "1".into()));
        }
        if kind == MetadataEditKind::Album && patch.title.is_some() {
            let parent = id(item.get("parentRatingKey"))
                .context("Album artist identity is missing; reload before editing its title.")?;
            params.push(("artist.id.value".into(), parent.to_string()));
        }
        Ok(PreparedMetadataEdit {
            path: format!("/library/sections/{section_id}/all"),
            params,
        })
    }
    pub async fn save_metadata_edit(&self, edit: PreparedMetadataEdit) -> Result<()> {
        let params: Vec<(&str, &str)> = edit
            .params
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect();
        tokio::time::timeout(Duration::from_secs(20), self.put_metadata_params_once(&edit.path, &params)).await
            .context("Plex did not confirm the save. Reload the item before retrying.")?
            .context("Plex did not confirm the save. Check server permissions and reload the item before retrying.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plex::PlexClientConfig;
    use std::io::{Read, Write};
    fn fixture(
        item: serde_json::Value,
        expect_put: bool,
        put_status: u16,
    ) -> (PlexClient, std::thread::JoinHandle<Vec<String>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/proxy", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for number in 0..if expect_put { 3 } else { 2 } {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 4096];
                while !bytes.windows(4).any(|part| part == b"\r\n\r\n") {
                    let count = stream.read(&mut buffer).unwrap();
                    if count == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buffer[..count]);
                }
                requests.push(String::from_utf8(bytes).unwrap());
                let body = if number == 0 {
                    serde_json::json!({"MediaContainer":{"Directory":[{"key":"5","type":"artist","uuid":"synthetic-library"}]}}).to_string()
                } else if number == 1 {
                    serde_json::json!({"MediaContainer":{"Metadata":[item]}}).to_string()
                } else {
                    String::new()
                };
                let status = if number == 2 { put_status } else { 200 };
                write!(stream, "HTTP/1.1 {status} synthetic\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
            requests
        });
        let mut client = PlexClient::new(PlexClientConfig {
            base_url: base,
            token: "synthetic-private-token".into(),
            ..Default::default()
        })
        .unwrap();
        client.library_scope = client.cache_scope_for_library(5, Some("synthetic-library"));
        (client, server)
    }
    #[tokio::test]
    async fn metadata_edit_put_preserves_proxy_query_fields_locks_and_album_artist() {
        let item = serde_json::json!({"ratingKey":"42","librarySectionID":5,"type":"album","parentRatingKey":"7","title":"Old","summary":null,"originallyAvailableAt":"2020-01-01"});
        let (client, server) = fixture(item, true, 200);
        let patch = MetadataEditPatch {
            title: Some("New & + / 名称".into()),
            summary: Some("Summary\nsecond line".into()),
            release_date: Some("2024-02-29".into()),
            ..Default::default()
        };
        let expected = BTreeMap::from([
            ("title".into(), Some("Old".into())),
            ("summary".into(), None),
            ("releaseDate".into(), Some("2020-01-01".into())),
        ]);
        let edit = client
            .prepare_metadata_edit(5, 42, MetadataEditKind::Album, &patch, &expected)
            .await
            .unwrap();
        client.save_metadata_edit(edit).await.unwrap();
        let requests = server.join().unwrap();
        assert!(requests[0].starts_with("GET /proxy/library/sections/5?"));
        let target = requests[2].split_whitespace().nth(1).unwrap();
        let url = url::Url::parse(&format!("http://synthetic.test{target}")).unwrap();
        assert_eq!(url.path(), "/proxy/library/sections/5/all");
        let query: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
        for (key, value) in [
            ("id", "42"),
            ("type", "9"),
            ("artist.id.value", "7"),
            ("title.value", "New & + / 名称"),
            ("summary.value", "Summary\nsecond line"),
            ("originallyAvailableAt.value", "2024-02-29"),
        ] {
            assert_eq!(query[key], value);
        }
        for field in ["title", "summary", "originallyAvailableAt"] {
            assert_eq!(query[&format!("{field}.locked")], "1");
        }
        assert!(!target.contains("synthetic-private-token"));
    }
    #[tokio::test]
    async fn metadata_edit_rejects_conflict_and_wrong_item_identity_before_put() {
        for (field, value) in [
            ("title", serde_json::json!("Concurrent edit")),
            ("type", serde_json::json!("track")),
            ("librarySectionID", serde_json::json!(6)),
            ("ratingKey", serde_json::json!(43)),
        ] {
            let mut item = serde_json::json!({"ratingKey":"42","librarySectionID":5,"type":"artist","title":"Old"});
            item[field] = value;
            let (client, server) = fixture(item, false, 200);
            let patch = MetadataEditPatch {
                title: Some("New".into()),
                ..Default::default()
            };
            assert!(client
                .prepare_metadata_edit(
                    5,
                    42,
                    MetadataEditKind::Artist,
                    &patch,
                    &BTreeMap::from([("title".into(), Some("Old".into()))])
                )
                .await
                .is_err());
            assert_eq!(server.join().unwrap().len(), 2);
        }
    }
    #[tokio::test]
    async fn metadata_edit_failure_never_replays_a_put_or_exposes_credentials() {
        for status in [403, 500, 307] {
            let item = serde_json::json!({"ratingKey":"42","librarySectionID":5,"type":"artist","title":"Old"});
            let (client, server) = fixture(item, true, status);
            let patch = MetadataEditPatch {
                title: Some("New".into()),
                ..Default::default()
            };
            let expected = BTreeMap::from([("title".into(), Some("Old".into()))]);
            let prepared = client
                .prepare_metadata_edit(5, 42, MetadataEditKind::Artist, &patch, &expected)
                .await
                .unwrap();
            let error = client
                .save_metadata_edit(prepared)
                .await
                .unwrap_err()
                .to_string();
            assert!(error.contains("reload"));
            assert!(!error.contains("synthetic-private-token"));
            assert_eq!(
                server
                    .join()
                    .unwrap()
                    .iter()
                    .filter(|request| request.starts_with("PUT "))
                    .count(),
                1
            );
        }
    }
    #[test]
    fn metadata_edit_validation_rejects_invalid_dates_unknown_fields_and_unbounded_text() {
        let expected = BTreeMap::from([("releaseDate".into(), None)]);
        for date in ["2023-02-29", "2024-13-01", "2024-2-01", ""] {
            assert!(MetadataEditPatch {
                release_date: Some(date.into()),
                ..Default::default()
            }
            .validate(MetadataEditKind::Album, &expected)
            .is_err());
        }
        assert!(MetadataEditPatch {
            release_date: Some("2024-02-29".into()),
            ..Default::default()
        }
        .validate(MetadataEditKind::Artist, &expected)
        .is_err());
        assert!(serde_json::from_value::<MetadataEditPatch>(
            serde_json::json!({"arbitrary":"injected"})
        )
        .is_err());
        for title in [" ".to_string(), "a".repeat(513)] {
            assert!(MetadataEditPatch {
                title: Some(title),
                ..Default::default()
            }
            .validate(
                MetadataEditKind::Artist,
                &BTreeMap::from([("title".into(), None)])
            )
            .is_err());
        }
    }
}
