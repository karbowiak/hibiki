//! Explicit canonical review: search never selects or merges a candidate.
use super::*;
use crate::public_metadata::identity::{Alias, Candidate, Credit, Identifiers, Review};
fn external(value: &Value, namespace: &str) -> Option<String> {
    value
        .get("external_ids")?
        .as_array()?
        .iter()
        .find_map(|entry| {
            (entry.get("provider")?.as_str()? == "musicbrainz"
                && entry.get("namespace")?.as_str()? == namespace)
                .then(|| {
                    entry
                        .get("value")?
                        .as_str()
                        .filter(|id| valid_mbid(id))
                        .map(str::to_owned)
                })?
        })
}
fn candidate(value: &Value, kind: &str, binding: &str) -> Option<Candidate> {
    if value.get("kind")?.as_str()? != kind {
        return None;
    }
    let id = value.get("id")?.as_str()?.to_owned();
    if !valid_mbid(&id) {
        return None;
    }
    let title = crate::public_metadata::identity::bounded_text(
        value
            .pointer(if kind == "artist" {
                "/display/name"
            } else {
                "/display/title"
            })?
            .as_str()?,
    )?;
    let artist = if kind == "artist" {
        title.clone()
    } else {
        crate::public_metadata::identity::bounded_text(
            value.pointer("/display/artist_credit")?.as_str()?,
        )?
    };
    let mut aliases = vec![];
    if let Some(names) = value
        .pointer(if kind == "artist" {
            "/data/names"
        } else {
            "/data/titles"
        })
        .and_then(Value::as_array)
    {
        for entry in names.iter().take(64) {
            let Some(name) = entry
                .get("value")
                .and_then(Value::as_str)
                .and_then(crate::public_metadata::identity::bounded_text)
            else {
                continue;
            };
            if aliases.iter().any(|entry: &Alias| entry.name == name) {
                continue;
            }
            aliases.push(Alias {
                name,
                locale: entry
                    .get("language")
                    .and_then(Value::as_str)
                    .filter(|v| v.len() <= 64)
                    .map(str::to_owned),
                r#type: entry
                    .get("type")
                    .and_then(Value::as_str)
                    .filter(|v| v.len() <= 64)
                    .map(str::to_owned),
            });
            if aliases.len() == 32 {
                break;
            }
        }
    }
    let artist_mbid = if kind == "artist" {
        external(value, "artist")
    } else {
        None
    };
    let credits = if kind == "artist" {
        vec![Credit {
            name: artist.clone(),
            mbid: artist_mbid.clone(),
        }]
    } else {
        value
            .pointer("/data/artist_credits")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .take(16)
                    .filter_map(|entry| {
                        let name = entry
                            .get("artist_name")
                            .or_else(|| entry.get("name"))?
                            .as_str()
                            .and_then(crate::public_metadata::identity::bounded_text)?;
                        let mbid = (entry.get("artist_provider").and_then(Value::as_str)
                            == Some("musicbrainz"))
                        .then(|| {
                            entry
                                .get("artist_id")
                                .and_then(Value::as_str)
                                .filter(|id| valid_mbid(id))
                                .map(str::to_owned)
                        })
                        .flatten();
                        Some(Credit { name, mbid })
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    Some(Candidate {
        provider: "heya".into(),
        kind: if kind == "artist" { "artist" } else { "album" }.into(),
        id,
        title,
        artist,
        aliases,
        disambiguation: value
            .pointer("/display/disambiguation")
            .and_then(Value::as_str)
            .and_then(crate::public_metadata::identity::bounded_text),
        artist_type: value
            .pointer("/data/classification/artist_type")
            .and_then(Value::as_str)
            .and_then(crate::public_metadata::identity::bounded_text),
        area: None,
        release_date: None,
        identifiers: Identifiers {
            artist_mbid: artist_mbid.or_else(|| {
                if credits.len() == 1 {
                    credits[0].mbid.clone()
                } else {
                    None
                }
            }),
            release_group_mbid: external(value, "release_group"),
            wikidata_qid: None,
        },
        artist_credits: credits,
        connection_id: Some(binding.into()),
    })
}
fn native_kind(kind: &str) -> Result<&'static str, String> {
    match kind {
        "artist" => Ok("artist"),
        "album" => Ok("release_group"),
        _ => Err("Unsupported identity type.".into()),
    }
}
async fn online(app: &tauri::AppHandle) -> Result<(), String> {
    if app
        .state::<crate::commands::PlexState>()
        .image_context()
        .await
        .client
        .as_ref()
        .is_some_and(|client| client.offline_only)
    {
        return Err("Identity lookup is unavailable offline.".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn heya_search_identities(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<MetadataServicesState>>,
    revision: String,
    kind: String,
    query: String,
) -> Result<Vec<Candidate>, String> {
    online(&app).await?;
    let kind = native_kind(&kind)?;
    let query = crate::public_metadata::identity::bounded_text(&query)
        .ok_or("Enter a bounded identity query.")?;
    let dir = directory(&app, Service::Heya)?;
    let connection = state.connection(Service::Heya);
    let (status, config) = connection.settings.snapshot(&dir).await?;
    if status.revision != revision {
        return Err("Metadata service configuration changed. Retry the lookup.".into());
    }
    if !status.enabled || !status.configured {
        return Ok(vec![]);
    }
    let binding = status
        .connection_id
        .ok_or("Review the HeyaMetadata connection again.")?;
    let Some(value) = connection
        .get(
            Service::Heya,
            &dir,
            &revision,
            &config,
            "api/v2/search",
            &[("q", &query), ("kind", kind), ("limit", "20")],
        )
        .await?
    else {
        return Ok(vec![]);
    };
    let mut result = vec![];
    for value in value
        .get("results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(20)
    {
        if let Some(item) = candidate(value, kind, &binding) {
            if !result.iter().any(|old: &Candidate| old.id == item.id) {
                result.push(item);
            }
        }
    }
    Ok(result)
}
#[tauri::command]
pub async fn heya_review_identity(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<MetadataServicesState>>,
    revision: String,
    kind: String,
    id: String,
) -> Result<Review, String> {
    online(&app).await?;
    let kind = native_kind(&kind)?;
    if !valid_mbid(&id) {
        return Err("Invalid canonical identity.".into());
    }
    let dir = directory(&app, Service::Heya)?;
    let connection = state.connection(Service::Heya);
    let (status, config) = connection.settings.snapshot(&dir).await?;
    if status.revision != revision || !status.enabled || !status.configured {
        return Err("Metadata service configuration changed. Retry the lookup.".into());
    }
    let binding = status
        .connection_id
        .ok_or("Review the HeyaMetadata connection again.")?;
    let value = connection
        .get(
            Service::Heya,
            &dir,
            &revision,
            &config,
            &format!("api/v2/entities/{id}"),
            &[],
        )
        .await?
        .ok_or("This canonical identity is unavailable.")?;
    let candidate = candidate(&value, kind, &binding)
        .filter(|candidate| candidate.id == id)
        .ok_or("The canonical identity response did not match.")?;
    let item = heya_item(
        &value,
        &id,
        kind,
        &candidate.artist,
        &candidate.title,
        None,
        &revision,
    )
    .ok_or("The canonical identity response did not match.")?;
    Ok(Review {
        candidate,
        fields: item.fields,
        field_origins: item.field_origins,
        reviewed_at: crate::public_metadata::identity::now(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_candidates_keep_translations_and_cross_ids_without_name_selection() {
        let id = "51497a0b-fd77-48dc-9cb0-bfe8ce205173";
        let binding = "fde1a1f9-a32e-4abf-b0de-f894c6720f4a";
        let value = json!({"id":id,"kind":"release_group","display":{"title":"残夢","artist_credit":"Ado"},"external_ids":[{"provider":"musicbrainz","namespace":"release_group","value":id}],"data":{"titles":[{"value":"Zanmu","language":"en","type":"alias"}],"artist_credits":[{"artist_name":"Ado","artist_provider":"musicbrainz","artist_id":binding}]}});
        let result = candidate(&value, "release_group", binding).unwrap();
        assert_eq!(result.title, "残夢");
        assert_eq!(result.aliases[0].name, "Zanmu");
        assert_eq!(result.identifiers.release_group_mbid.as_deref(), Some(id));
        assert_eq!(result.identifiers.artist_mbid.as_deref(), Some(binding));
        assert_eq!(result.connection_id.as_deref(), Some(binding));
        assert!(candidate(&value, "artist", binding).is_none());
        let mut bad = value.clone();
        bad["id"] = json!("../../../private");
        assert!(candidate(&bad, "release_group", binding).is_none());
    }
}

#[cfg(test)]
mod enrichment_tests {
    use super::*;
    #[test]
    fn canonical_facts_keep_provider_origins_and_reject_unsafe_links_and_counts() {
        let id = "51497a0b-fd77-48dc-9cb0-bfe8ce205173";
        let value = json!({"id":id,"kind":"artist","display":{"name":"Artist"},"external_ids":[{"provider":"musicbrainz","namespace":"artist","value":id}],"data":{"areas":[{"name":"Japan","role":"primary"}],"lifecycle":{"dates":[{"type":"begin","value":"2002-10-24"}]},"metrics":[{"name":"listeners","value":1234.0,"provider":"lastfm"},{"name":"fan_count","value":0.0,"provider":"deezer"},{"name":"playcount","value":-1.0,"provider":"lastfm"}],"links":[{"url":"https://wikipedia.org:123/private"},{"url":"https://en.wikipedia.org/wiki/Artist"}]},"provenance":{"data.lifecycle":[{"provider":"musicbrainz"}]}});
        let item = heya_item(&value, id, "artist", "Artist", "", None, "revision").unwrap();
        assert_eq!(item.fields["listeners"], 1234);
        assert_eq!(item.fields["fans"], 0);
        assert!(item.fields.get("playCount").is_none());
        assert_eq!(item.field_origins["listeners"], "lastfm via HeyaMetadata");
        assert_eq!(
            item.field_origins["beginDate"],
            "musicbrainz via HeyaMetadata"
        );
        assert_eq!(item.fields["mbid"], id);
        assert_eq!(item.fields["area"], "Japan");
        assert_eq!(
            item.fields["wikipediaUrl"],
            "https://en.wikipedia.org/wiki/Artist"
        );
    }
}
