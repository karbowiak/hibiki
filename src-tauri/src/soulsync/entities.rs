//! Bounded library ownership verification for optional album/track enrichment.
use super::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;
fn normalized(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}
fn matches(value: &Value, key: &str, expected: &str) -> bool {
    value
        .get(key)
        .and_then(Value::as_str)
        .is_some_and(|name| normalized(name) == normalized(expected))
}
fn complete(value: &Value, items: &[Value], limit: usize) -> bool {
    items.len() <= limit
        && value
            .pointer("/pagination/has_next")
            .and_then(Value::as_bool)
            != Some(true)
        && !value
            .pointer("/pagination/total")
            .and_then(Value::as_u64)
            .is_some_and(|total| total > items.len() as u64)
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EntityInfo {
    artist: String,
    title: String,
    fields: Value,
    field_origins: BTreeMap<String, String>,
}
#[derive(Serialize, Debug)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum EntityLookup {
    Ready { item: EntityInfo },
    Unavailable,
    Ambiguous { candidates: Vec<ArtistCandidate> },
}
fn ambiguous(items: &[&Value], title: &str) -> EntityLookup {
    EntityLookup::Ambiguous {
        candidates: items
            .iter()
            .filter_map(|item| {
                detail_id(item.get("id")).map(|id| ArtistCandidate {
                    id: id.to_string(),
                    name: title.into(),
                })
            })
            .collect(),
    }
}
fn fields(item: &Value, kind: &str) -> (Value, BTreeMap<String, String>) {
    let mut result = serde_json::Map::new();
    let mut origins = BTreeMap::new();
    let text = |key: &str| {
        item.get(key)
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty() && text.chars().count() <= 16000)
    };
    let lastfm = item.get("lastfm_match_status").and_then(Value::as_str) == Some("matched");
    let genius = item.get("genius_match_status").and_then(Value::as_str) == Some("matched");
    if kind == "album" {
        if lastfm {
            if let Some(summary) = text("lastfm_wiki") {
                result.insert("summary".into(), json!(summary));
                origins.insert("summary".into(), "Last.fm via SoulSync".into());
            }
        }
        for (target, key) in [("label", "label"), ("mbid", "musicbrainz_release_id")] {
            if let Some(value) = text(key).filter(|value| value.len() <= 512) {
                result.insert(target.into(), json!(value));
            }
        }
        if let Some(year) = item
            .get("year")
            .and_then(Value::as_u64)
            .filter(|year| *year > 0 && *year <= 9999)
        {
            result.insert("releaseDate".into(), json!(format!("{year:04}")));
        }
        if let Some(count) = item
            .get("track_count")
            .and_then(Value::as_u64)
            .filter(|value| *value <= 9007199254740991)
        {
            result.insert("trackCount".into(), json!(count));
        }
        let genres = string_tags(item.get("genres"));
        if !genres.is_empty() {
            result.insert("genres".into(), json!(genres));
        }
    } else {
        if genius {
            if let Some(summary) = text("genius_description") {
                result.insert("summary".into(), json!(summary));
                origins.insert("summary".into(), "Genius via SoulSync".into());
            }
        }
        if let Some(mbid) =
            text("musicbrainz_recording_id").filter(|id| uuid::Uuid::parse_str(id).is_ok())
        {
            result.insert("mbid".into(), json!(mbid));
        }
    }
    if lastfm {
        let tags = string_tags(item.get("lastfm_tags"));
        if !tags.is_empty() {
            result.insert("tags".into(), json!(tags));
            origins.insert("tags".into(), "Last.fm via SoulSync".into());
        }
        for (target, key) in [
            ("listeners", "lastfm_listeners"),
            ("playCount", "lastfm_playcount"),
        ] {
            if let Some(count) = item
                .get(key)
                .and_then(Value::as_u64)
                .filter(|value| *value <= 9007199254740991)
            {
                result.insert(target.into(), json!(count));
                origins.insert(target.into(), "Last.fm via SoulSync".into());
            }
        }
    }
    for field in result.keys() {
        origins
            .entry(field.clone())
            .or_insert_with(|| "SoulSync library".into());
    }
    (Value::Object(result), origins)
}
impl SoulSyncState {
    async fn entity(
        &self,
        directory: &Path,
        revision: &str,
        kind: &str,
        artist: &str,
        title: &str,
    ) -> Result<EntityLookup, String> {
        if !["album", "track"].contains(&kind)
            || artist.trim().is_empty()
            || title.trim().is_empty()
            || artist.chars().count() > 512
            || title.chars().count() > 512
        {
            return Err("Invalid SoulSync entity identity.".into());
        }
        self.load(directory).await?;
        let config = {
            let current = self.current.lock().await;
            if current.revision != revision {
                return Err("SoulSync configuration was superseded.".into());
            }
            if !current.configuration.enabled
                || current.configuration.base_url.is_empty()
                || current.configuration.api_key.is_empty()
            {
                return Ok(EntityLookup::Unavailable);
            }
            current.configuration.clone()
        };
        let _permit = self
            .admission
            .try_acquire()
            .map_err(|_| "SoulSync metadata requests are busy. Try again shortly.")?;
        let (listing, artist_id) = if kind == "album" {
            let listing = self
                .get(
                    &config,
                    revision,
                    "api/v1/library/artists",
                    &[
                        ("search", artist),
                        ("page", "1"),
                        ("limit", "5"),
                        ("fields", "id,name"),
                    ],
                )
                .await?;
            let items = listing
                .pointer("/data/artists")
                .and_then(Value::as_array)
                .ok_or("Invalid SoulSync artist metadata.")?;
            if !complete(&listing, items, 5) {
                return Ok(EntityLookup::Unavailable);
            }
            let matching: Vec<_> = items
                .iter()
                .filter(|item| matches(item, "name", artist) && detail_id(item.get("id")).is_some())
                .collect();
            if matching.len() > 1 {
                return Ok(ambiguous(&matching, artist));
            }
            let Some(item) = matching.first() else {
                return Ok(EntityLookup::Unavailable);
            };
            let artist_id = detail_id(item.get("id")).unwrap().to_string();
            (
                self.get(
                    &config,
                    revision,
                    "api/v1/library/albums",
                    &[
                        ("search", title),
                        ("artist_id", &artist_id),
                        ("page", "1"),
                        ("limit", "20"),
                        ("fields", "id,title,artist_id"),
                    ],
                )
                .await?,
                Some(artist_id),
            )
        } else {
            (
                self.get(
                    &config,
                    revision,
                    "api/v1/library/tracks",
                    &[
                        ("title", title),
                        ("artist", artist),
                        ("limit", "21"),
                        ("fields", "id,title,artist_name,artist_id"),
                    ],
                )
                .await?,
                None,
            )
        };
        let plural = if kind == "album" { "albums" } else { "tracks" };
        let items = listing
            .pointer(&format!("/data/{plural}"))
            .and_then(Value::as_array)
            .ok_or("Invalid SoulSync entity metadata.")?;
        if !complete(&listing, items, 20) {
            return Ok(EntityLookup::Unavailable);
        }
        let matching: Vec<_> = items
            .iter()
            .filter(|item| {
                matches(item, "title", title)
                    && detail_id(item.get("id")).is_some()
                    && if let Some(id) = &artist_id {
                        detail_id(item.get("artist_id"))
                            .is_some_and(|actual| actual.to_string() == *id)
                    } else {
                        matches(item, "artist_name", artist)
                            && detail_id(item.get("artist_id")).is_some()
                    }
            })
            .collect();
        if matching.len() > 1 {
            return Ok(ambiguous(&matching, title));
        }
        let Some(item) = matching.first() else {
            return Ok(EntityLookup::Unavailable);
        };
        let id = detail_id(item.get("id")).unwrap();
        let owner = detail_id(item.get("artist_id"));
        // Request only metadata fields, never embedded library paths or full track payloads.
        let detail=self.get(&config,revision,&format!("api/v1/library/{plural}/{id}"),&[("fields","id,title,artist_id,artist_name,year,thumb_url,genres,track_count,label,musicbrainz_release_id,musicbrainz_recording_id,lastfm_match_status,lastfm_wiki,lastfm_tags,lastfm_listeners,lastfm_playcount,genius_match_status,genius_description")]).await?;
        let item = detail
            .pointer(&format!("/data/{kind}"))
            .ok_or("Invalid SoulSync detail metadata.")?;
        if detail_id(item.get("id")) != Some(id)
            || detail_id(item.get("artist_id")) != owner
            || !matches(item, "title", title)
            || item
                .get("artist_name")
                .is_some_and(|name| name.is_string() && !matches(item, "artist_name", artist))
        {
            return Ok(EntityLookup::Unavailable);
        }
        let (fields, field_origins) = fields(item, kind);
        Ok(EntityLookup::Ready {
            item: EntityInfo {
                artist: artist.into(),
                title: title.into(),
                fields,
                field_origins,
            },
        })
    }
}
#[tauri::command]
pub async fn soulsync_entity(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<SoulSyncState>>,
    revision: String,
    kind: String,
    artist: String,
    title: String,
) -> Result<EntityLookup, String> {
    if app
        .state::<crate::commands::PlexState>()
        .image_context()
        .await
        .client
        .as_ref()
        .is_some_and(|client| client.offline_only)
    {
        return Err("SoulSync lookup is unavailable offline.".into());
    }
    state
        .entity(&directory(&app)?, &revision, &kind, &artist, &title)
        .await
}

#[cfg(test)]
mod tests {
    use super::super::tests::{configured, service};
    use super::*;
    #[tokio::test]
    async fn album_enrichment_verifies_artist_and_detail_ownership_with_bounded_fields() {
        let artist = json!({"success":true,"data":{"artists":[{"id":"42","name":"Artist & Name"}]},"pagination":{"has_next":false,"total":1}});
        let album = json!({"success":true,"data":{"albums":[{"id":"70","artist_id":42,"title":"Album + Edition"}]},"pagination":{"has_next":false,"total":1}});
        let detail = json!({"success":true,"data":{"album":{"id":70,"artist_id":"42","title":"Album + Edition","year":2024,"track_count":12,"genres":["Pop"],"lastfm_match_status":"matched","lastfm_wiki":"Album context","lastfm_tags":["Tag"]},"tracks":[]}});
        let (base, server) = service(vec![
            (200, artist.to_string(), None),
            (200, album.to_string(), None),
            (200, detail.to_string(), None),
        ]);
        let dir = tempfile::tempdir().unwrap();
        let (state, revision) = configured(dir.path(), base).await;
        let result = state
            .entity(
                dir.path(),
                &revision,
                "album",
                "Artist & Name",
                "Album + Edition",
            )
            .await
            .unwrap();
        match result {
            EntityLookup::Ready { item } => {
                assert_eq!(item.fields["summary"], "Album context");
                assert_eq!(item.fields["trackCount"], 12);
                assert_eq!(item.fields["releaseDate"], "2024");
                assert_eq!(item.field_origins["summary"], "Last.fm via SoulSync");
            }
            _ => panic!("expected owned album"),
        }
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 3);
        let targets: Vec<_> = requests
            .iter()
            .map(|request| {
                url::Url::parse(&format!(
                    "http://synthetic{}",
                    request.split_whitespace().nth(1).unwrap()
                ))
                .unwrap()
            })
            .collect();
        assert_eq!(targets[1].path(), "/proxy/api/v1/library/albums");
        assert!(targets[1]
            .query_pairs()
            .any(|(k, v)| k == "artist_id" && v == "42"));
        assert!(targets[1]
            .query_pairs()
            .any(|(k, v)| k == "search" && v == "Album + Edition"));
        assert_eq!(targets[2].path(), "/proxy/api/v1/library/albums/70");
        assert!(!targets[2].as_str().contains("file_path"));
    }
    #[tokio::test]
    async fn track_homonyms_and_wrong_detail_artist_never_publish() {
        let listing = json!({"success":true,"data":{"tracks":[{"id":12,"artist_id":42,"artist_name":"Artist","title":"Song"}]}});
        let detail = json!({"success":true,"data":{"track":{"id":12,"artist_id":99,"artist_name":"Artist","title":"Song","genius_match_status":"matched","genius_description":"Wrong owner"}}});
        let (base, server) = service(vec![
            (200, listing.to_string(), None),
            (200, detail.to_string(), None),
        ]);
        let dir = tempfile::tempdir().unwrap();
        let (state, revision) = configured(dir.path(), base).await;
        assert!(matches!(
            state
                .entity(dir.path(), &revision, "track", "Artist", "Song")
                .await
                .unwrap(),
            EntityLookup::Unavailable
        ));
        server.join().unwrap();
        let listing = json!({"success":true,"data":{"tracks":[{"id":12,"artist_id":42,"artist_name":"Artist","title":"Song"},{"id":13,"artist_id":42,"artist_name":"Artist","title":"Song"}]}});
        let (base, server) = service(vec![(200, listing.to_string(), None)]);
        let dir = tempfile::tempdir().unwrap();
        let (state, revision) = configured(dir.path(), base).await;
        assert!(matches!(
            state
                .entity(dir.path(), &revision, "track", "Artist", "Song")
                .await
                .unwrap(),
            EntityLookup::Ambiguous { .. }
        ));
        assert_eq!(server.join().unwrap().len(), 1);
    }
    #[test]
    fn unresolved_provider_data_and_incomplete_search_are_not_evidence() {
        let (fields, origins) = fields(
            &json!({"genius_description":"Wrong match","lastfm_wiki":"Wrong match","lastfm_tags":["Wrong"],"lastfm_playcount":42}),
            "track",
        );
        assert_eq!(fields, json!({}));
        assert!(origins.is_empty());
        assert!(!complete(&json!({"pagination":{"has_next":true}}), &[], 20));
        assert!(!complete(
            &json!({"pagination":{"total":50}}),
            &[json!({})],
            20
        ));
    }
}
