use super::row::{self, Row};
use crate::{
    http_response::BoundedResponseExt,
    plex::{
        catalogue::{decode_json, number},
        PlexClient,
    },
};
use serde_json::Value;

pub const PAGE: i64 = 500;
pub struct Page {
    pub rows: Vec<Row>,
    pub total: i64,
    pub bytes: i64,
}
pub fn modern(version: &str) -> bool {
    let parts: Vec<u32> = version
        .split('.')
        .take(3)
        .map(|p| p.parse().unwrap_or(0))
        .collect();
    parts.as_slice() >= [1, 41, 9].as_slice()
}
fn parse(
    raw: Value,
    library: i64,
    kind: &str,
    offset: i64,
    header_offset: Option<i64>,
    header_total: Option<i64>,
    bytes: i64,
) -> Result<Page, String> {
    let container = raw
        .get("MediaContainer")
        .ok_or("Plex census has no container")?;
    let actual = number(&container["offset"])
        .or(header_offset)
        .ok_or("Plex did not confirm its census offset")?;
    let total = number(&container["totalSize"])
        .or(header_total)
        .ok_or("Plex did not confirm its census total")?;
    if actual != offset
        || header_offset.is_some_and(|n| n != actual)
        || header_total.is_some_and(|n| n != total)
        || total < 0
    {
        return Err("Plex census offset or total changed".into());
    }
    if container.get("librarySectionID").is_some()
        && number(&container["librarySectionID"]) != Some(library)
    {
        return Err("Plex census belongs to another library".into());
    }
    let items = match container.get("Metadata") {
        Some(Value::Array(items)) => items.as_slice(),
        None => &[],
        _ => return Err("Invalid Plex census records".into()),
    };
    if items.len() > PAGE as usize
        || number(&container["size"]) != Some(items.len() as i64)
        || offset + items.len() as i64 > total
        || items.is_empty() && offset < total
    {
        return Err("Plex census count is invalid or nonadvancing".into());
    }
    let mut ids = std::collections::HashSet::new();
    let mut rows = Vec::with_capacity(items.len());
    for item in items {
        let row = row::parse(item, kind, library)?;
        if !ids.insert(row.id) {
            return Err("Plex repeated a census identity".into());
        }
        rows.push(row);
    }
    Ok(Page { rows, total, bytes })
}
pub async fn page(
    client: &PlexClient,
    library: i64,
    kind: &str,
    offset: i64,
    modern: bool,
) -> Result<Page, String> {
    let kind_number = match kind {
        "artist" => 8,
        "album" => 9,
        "track" => 10,
        _ => return Err("Invalid census kind".into()),
    };
    let mut token = reqwest::header::HeaderValue::from_str(&client.token)
        .map_err(|_| "Invalid Plex session")?;
    token.set_sensitive(true);
    let mut request = client
        .client
        .get(client.build_url(&format!("/library/sections/{library}/all")))
        .header("X-Plex-Token", token)
        .header("Accept", "application/json")
        .query(&[
            ("type", kind_number.to_string()),
            ("X-Plex-Container-Start", offset.to_string()),
            ("X-Plex-Container-Size", PAGE.to_string()),
            ("includeGuids", "1".into()),
            (
                "excludeElements",
                "Media,Extras,Related,UltraBlurColors,MusicAnalysis".into(),
            ),
        ]);
    if modern {
        request=request.header("X-Plex-Pms-Api-Version","1.0.0").query(&[("includeFields","size,offset,totalSize,librarySectionID,type,ratingKey,guid,title,originalTitle,parentRatingKey,grandparentRatingKey,parentTitle,grandparentTitle,parentGuid,grandparentGuid,duration,contentRating,explicit,editionTitle,subtype,originallyAvailableAt,year,parentIndex,index,addedAt,updatedAt"),("includeElements","Metadata,Guid,Artist,Format")]);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "Plex matching listing is unavailable")?;
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
    };
    let start = header("X-Plex-Container-Start");
    let total = header("X-Plex-Container-Total-Size");
    let body = response
        .bounded_bytes(8 * 1024 * 1024)
        .await
        .map_err(|_| "Plex matching listing failed or exceeded its byte limit")?;
    let bytes = body.len() as i64;
    parse(
        decode_json(&body).map_err(|_| "Plex matching listing contains invalid JSON")?,
        library,
        kind,
        offset,
        start,
        total,
        bytes,
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn negotiated_selection_and_strict_counts() {
        assert!(modern("1.41.9.1234-test"));
        assert!(!modern("1.41.8.9"));
        assert!(!modern(""));
        let raw = serde_json::json!({"MediaContainer":{"size":1,"offset":0,"totalSize":1,"librarySectionID":4,"Metadata":[{"type":"artist","title":"A","ratingKey":1}]}});
        assert!(parse(raw.clone(), 4, "artist", 0, None, None, 1).is_ok());
        assert!(parse(raw.clone(), 4, "artist", 1, None, None, 1).is_err());
        assert!(parse(raw.clone(), 4, "artist", 0, Some(1), None, 1).is_err());
        assert!(parse(raw.clone(), 5, "artist", 0, None, None, 1).is_err());
        let mut short = raw;
        short["MediaContainer"]["size"] = 2.into();
        assert!(parse(short, 4, "artist", 0, None, None, 1).is_err());
    }
    #[test]
    fn captured_live_listing_shapes_satisfy_the_same_strict_parser_when_supplied() {
        let Ok(path) = std::env::var("HIBIKI_MATCHING_PAGES") else {
            return;
        };
        let pages: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        for page in pages.as_array().unwrap() {
            let result = parse(
                page["raw"].clone(),
                page["library"].as_i64().unwrap(),
                page["kind"].as_str().unwrap(),
                0,
                None,
                None,
                0,
            )
            .unwrap();
            assert_eq!(result.rows.len(), 500);
        }
    }
}
