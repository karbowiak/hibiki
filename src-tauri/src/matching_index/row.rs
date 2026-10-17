//! Small, typed matching evidence. No raw documents, stream URLs or artwork.
use crate::plex::catalogue::number;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

pub fn key(value: &str) -> String {
    let folded: String = value
        .nfkd()
        .filter(|c| !is_combining_mark(*c))
        .flat_map(char::to_lowercase)
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect();
    folded.split_whitespace().collect::<Vec<_>>().join(" ")
}
pub fn label(value: &str) -> String {
    value
        .nfc()
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Same punctuation policy as lib/artistCredits.ts; canonical provider artists
/// and structured credits override the display-string splitting fallback.
pub fn split_credits(value: &str) -> Vec<String> {
    let known = [
        "tyler, the creator",
        "earth, wind & fire",
        "crosby, stills & nash",
        "crosby, stills, nash & young",
        "peter, paul and mary",
        "peter, bjorn and john",
    ];
    if known.contains(&label(value).as_str()) {
        return vec![value.trim().into()];
    }
    let mut quoted = false;
    let mut separated = String::new();
    for character in value.chars() {
        if character == '"' {
            quoted = !quoted;
        } else {
            separated.push(if !quoted && matches!(character, ',' | ';') {
                '\n'
            } else if quoted && character == ' ' {
                '\u{1f}'
            } else {
                character
            });
        }
    }
    let mut output = Vec::new();
    for part in separated.split('\n') {
        let words: Vec<_> = part.split_whitespace().collect();
        let mut credit = Vec::new();
        for word in words {
            if ["x", "×", "feat", "ft", "featuring", "with"]
                .contains(&word.trim_end_matches('.').to_lowercase().as_str())
                && !credit.is_empty()
            {
                output.push(credit.join(" ").replace('\u{1f}', " "));
                credit.clear();
            } else {
                credit.push(word);
            }
        }
        if !credit.is_empty() {
            output.push(credit.join(" ").replace('\u{1f}', " "));
        }
    }
    output
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Identifier {
    pub scheme: String,
    pub value: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub kind: String,
    pub id: i64,
    pub title: String,
    pub title_key: String,
    pub artists: Vec<String>,
    pub artist_key: String,
    pub artist_id: Option<i64>,
    pub album_id: Option<i64>,
    pub album: Option<String>,
    pub identifiers: Vec<Identifier>,
    pub duration: Option<i64>,
    pub explicit: Option<bool>,
    pub version: Option<String>,
    pub release_type: Option<String>,
    pub date: Option<String>,
    pub year: Option<i64>,
    pub disc: Option<i64>,
    pub track: Option<i64>,
    pub added: Option<i64>,
    pub updated: Option<i64>,
    pub revision: String,
}
fn text(raw: &Value, field: &str) -> Option<String> {
    raw[field]
        .as_str()
        .filter(|v| !v.is_empty() && v.len() <= 4096)
        .map(str::to_owned)
}
pub fn identifiers(raw: &Value, kind: &str) -> Vec<Identifier> {
    let mut values: Vec<_> = raw["Guid"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|g| g["id"].as_str())
        .collect();
    if let Some(guid) = raw["guid"].as_str() {
        values.push(guid);
    }
    let mut output = Vec::new();
    for value in values.into_iter().take(32) {
        let Some((scheme, rest)) = value.split_once("://") else {
            continue;
        };
        let rest = rest.split('?').next().unwrap_or_default();
        let parts: Vec<_> = rest.split('/').filter(|v| !v.is_empty()).collect();
        let identity = match (scheme, parts.as_slice()) {
            ("plex", [entity, id]) if *entity == kind && id.len() <= 128 => {
                Some((format!("plex:{entity}"), (*id).to_owned()))
            }
            ("musicbrainz" | "mbid", [entity, id])
                if ["recording", "release", "release-group", "artist"].contains(entity)
                    && uuid::Uuid::parse_str(id).is_ok() =>
            {
                Some((format!("musicbrainz:{entity}"), id.to_lowercase()))
            }
            // A generic mbid GUID has no typed recording evidence.
            ("mbid", [id]) if uuid::Uuid::parse_str(id).is_ok() => {
                Some(("musicbrainz:untyped".into(), id.to_lowercase()))
            }
            ("isrc", [id]) if id.len() == 12 && id.chars().all(|c| c.is_ascii_alphanumeric()) => {
                Some(("isrc".into(), id.to_uppercase()))
            }
            _ => None,
        };
        if let Some((scheme, value)) = identity {
            let identifier = Identifier { scheme, value };
            if !output.contains(&identifier) {
                output.push(identifier);
            }
        }
    }
    output.sort_by(|a, b| (&a.scheme, &a.value).cmp(&(&b.scheme, &b.value)));
    output
}
pub fn parse(raw: &Value, kind: &str, library: i64) -> Result<Row, String> {
    if !["artist", "album", "track"].contains(&kind) || raw["type"].as_str() != Some(kind) {
        return Err("Plex matching page contains the wrong item type".into());
    }
    if raw.get("librarySectionID").is_some() && number(&raw["librarySectionID"]) != Some(library) {
        return Err("Plex matching item belongs to another library".into());
    }
    let id = number(&raw["ratingKey"])
        .filter(|id| *id > 0)
        .ok_or("Invalid Plex matching identity")?;
    let title = text(raw, "title").ok_or("Plex matching item has no title")?;
    let artist_id = if kind == "artist" {
        Some(id)
    } else {
        number(
            &raw[if kind == "album" {
                "parentRatingKey"
            } else {
                "grandparentRatingKey"
            }],
        )
        .filter(|id| *id > 0)
    };
    let album_id = if kind == "album" {
        Some(id)
    } else if kind == "track" {
        number(&raw["parentRatingKey"]).filter(|id| *id > 0)
    } else {
        None
    };
    if kind != "artist" && (artist_id.is_none() || kind == "track" && album_id.is_none()) {
        return Err("Plex matching item lacks its library parents".into());
    }
    let name = if kind == "artist" {
        title.clone()
    } else {
        text(raw, "originalTitle")
            .or_else(|| {
                text(
                    raw,
                    if kind == "album" {
                        "parentTitle"
                    } else {
                        "grandparentTitle"
                    },
                )
            })
            .unwrap_or_default()
    };
    let structured: Vec<_> = raw["Artist"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|artist| text(artist, "tag"))
        .take(32)
        .collect();
    let canonical = raw[if kind == "track" {
        "grandparentGuid"
    } else if kind == "album" {
        "parentGuid"
    } else {
        "guid"
    }]
    .as_str()
    .is_some_and(|v| v.starts_with("plex://artist/"));
    let artists = if !structured.is_empty() {
        structured
    } else if canonical && (kind == "artist" || raw["originalTitle"].is_null()) {
        vec![name]
    } else {
        split_credits(&name)
    };
    if artists.is_empty() {
        return Err("Plex matching item lacks artist credits".into());
    }
    let mut normalized: Vec<_> = artists.iter().map(|v| key(v)).collect();
    normalized.sort();
    normalized.dedup();
    let format: Vec<_> = raw["Format"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| text(entry, "tag"))
        .take(8)
        .collect();
    let mut row = Row {
        kind: kind.into(),
        id,
        title_key: key(&title),
        title,
        artists,
        artist_key: normalized.join("; "),
        artist_id,
        album_id,
        album: if kind == "track" {
            text(raw, "parentTitle")
        } else {
            None
        },
        identifiers: identifiers(raw, kind),
        duration: number(&raw["duration"]).filter(|v| *v > 0 && *v <= 86_400_000),
        explicit: raw["explicit"]
            .as_bool()
            .or_else(|| match raw["contentRating"].as_str() {
                Some("Explicit" | "explicit") => Some(true),
                Some("Clean" | "clean") => Some(false),
                _ => None,
            }),
        version: text(raw, "editionTitle"),
        release_type: (!format.is_empty())
            .then(|| format.join("; "))
            .or_else(|| text(raw, "subtype")),
        date: text(raw, "originallyAvailableAt"),
        year: number(&raw["year"]),
        disc: number(&raw["parentIndex"]),
        track: number(&raw["index"]),
        added: number(&raw["addedAt"]),
        updated: number(&raw["updatedAt"]),
        revision: String::new(),
    };
    row.revision = hex::encode(Sha256::digest(
        serde_json::to_vec(&row).map_err(|_| "Invalid matching evidence")?,
    ));
    Ok(row)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credits_follow_shared_policy_and_preserve_unicode_and_typed_ids() {
        assert_eq!(
            split_credits("NEEDY GIRL OVERDOSE, Aiobahn +81; Artist x Guest"),
            vec!["NEEDY GIRL OVERDOSE", "Aiobahn +81", "Artist", "Guest"]
        );
        assert_eq!(
            split_credits("Tyler, The Creator"),
            vec!["Tyler, The Creator"]
        );
        assert_eq!(
            split_credits("\"A x B, C\"; Other"),
            vec!["A x B, C", "Other"]
        );
        assert_eq!(key("ÁrönChupa / 東京"), "aronchupa 東京");
        let raw = serde_json::json!({"type":"track","ratingKey":1,"grandparentRatingKey":2,"parentRatingKey":3,"title":"Song (Live)","originalTitle":"A; B","grandparentTitle":"A","librarySectionID":4,"Guid":[{"id":"mbid://11111111-1111-4111-8111-111111111111"},{"id":"musicbrainz://recording/22222222-2222-4222-8222-222222222222"}]});
        let row = parse(&raw, "track", 4).unwrap();
        assert_eq!(row.artists, vec!["A", "B"]);
        assert_eq!(
            row.identifiers
                .iter()
                .filter(|id| id.scheme == "musicbrainz:recording")
                .count(),
            1
        );
        assert!(parse(&raw, "track", 5).is_err());
        assert!(parse(&raw, "album", 4).is_err());
    }
}
