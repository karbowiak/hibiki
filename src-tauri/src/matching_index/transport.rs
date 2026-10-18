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
    pub server_time: Option<i64>,
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
    Ok(Page {
        rows,
        total,
        bytes,
        server_time: None,
    })
}
pub async fn page(
    client: &PlexClient,
    library: i64,
    kind: &str,
    offset: i64,
    modern: bool,
) -> Result<Page, String> {
    listing(client, library, kind, offset, modern, &[]).await
}
pub async fn listing(
    client: &PlexClient,
    library: i64,
    kind: &str,
    offset: i64,
    modern: bool,
    filters: &[(&str, String)],
) -> Result<Page, String> {
    listing_size(client, library, kind, offset, modern, filters, PAGE).await
}
pub async fn candidates(
    client: &PlexClient,
    library: i64,
    kind: &str,
    title: &str,
    modern: bool,
) -> Result<Page, String> {
    if title.trim().is_empty() || title.len() > 512 {
        return Err("Invalid matching search".into());
    }
    let page = listing_size(
        client,
        library,
        kind,
        0,
        modern,
        &[("title", title.to_owned())],
        50,
    )
    .await?;
    let key = row::key(title);
    if key.is_empty() || page.rows.iter().any(|row| !row.title_key.contains(&key)) {
        return Err("Plex did not honor its matching title filter".into());
    }
    Ok(page)
}
async fn listing_size(
    client: &PlexClient,
    library: i64,
    kind: &str,
    offset: i64,
    modern: bool,
    filters: &[(&str, String)],
    size: i64,
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
            ("X-Plex-Container-Size", size.to_string()),
            ("includeGuids", "1".into()),
            (
                "excludeElements",
                "Media,Extras,Related,UltraBlurColors,MusicAnalysis".into(),
            ),
        ]);
    if modern {
        request=request.header("X-Plex-Pms-Api-Version","1.0.0").query(&[("includeFields","size,offset,totalSize,librarySectionID,type,ratingKey,guid,title,originalTitle,parentRatingKey,grandparentRatingKey,parentTitle,grandparentTitle,parentGuid,grandparentGuid,duration,contentRating,explicit,editionTitle,subtype,originallyAvailableAt,year,parentIndex,index,addedAt,updatedAt"),("includeElements","Metadata,Guid,Artist,Format")]);
    }
    request = request.query(filters);
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
    let server_time = response
        .headers()
        .get("Date")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| chrono::DateTime::parse_from_rfc2822(value).ok())
        .map(|value| value.timestamp());
    let body = response
        .bounded_bytes(8 * 1024 * 1024)
        .await
        .map_err(|_| "Plex matching listing failed or exceeded its byte limit")?;
    let bytes = body.len() as i64;
    let mut page = parse(
        decode_json(&body).map_err(|_| "Plex matching listing contains invalid JSON")?,
        library,
        kind,
        offset,
        start,
        total,
        bytes,
    )?;
    page.server_time = server_time;
    if page.rows.len() as i64 > size {
        return Err("Plex matching response exceeded its requested bound".into());
    }
    Ok(page)
}
fn request(
    client: &PlexClient,
    path: &str,
    modern: bool,
) -> Result<reqwest_middleware::RequestBuilder, String> {
    let mut token = reqwest::header::HeaderValue::from_str(&client.token)
        .map_err(|_| "Invalid Plex session")?;
    token.set_sensitive(true);
    let request = client
        .client
        .get(client.build_url(path))
        .header("X-Plex-Token", token)
        .header("Accept", "application/json");
    Ok(if modern {
        request.header("X-Plex-Pms-Api-Version", "1.0.0")
    } else {
        request
    })
}
pub struct Details {
    pub rows: Vec<Row>,
    pub missing: Vec<i64>,
}
pub async fn details(
    client: &PlexClient,
    library: i64,
    items: &[(String, i64)],
    modern: bool,
) -> Result<Details, String> {
    if items.is_empty()
        || items.len() > 25
        || items
            .iter()
            .any(|(kind, id)| *id <= 0 || !["artist", "album", "track"].contains(&kind.as_str()))
    {
        return Err("Invalid matching detail batch".into());
    }
    let path = format!(
        "/library/metadata/{}",
        items
            .iter()
            .map(|(_, id)| id.to_string())
            .collect::<Vec<_>>()
            .join(",")
    );
    let mut query = request(client, &path, modern)?.query(&[
        ("includeGuids", "1"),
        ("skipRefresh", "1"),
        ("excludeElements", "Media,Extras,Related,MusicAnalysis"),
    ]);
    if modern {
        query=query.query(&[("includeFields","size,librarySectionID,type,ratingKey,guid,title,originalTitle,parentRatingKey,grandparentRatingKey,parentTitle,grandparentTitle,parentGuid,grandparentGuid,duration,contentRating,explicit,editionTitle,subtype,originallyAvailableAt,year,parentIndex,index,addedAt,updatedAt"),("includeElements","Metadata,Guid,Artist,Format")]);
    }
    let response = query
        .send()
        .await
        .map_err(|_| "Plex matching details are unavailable")?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(Details {
            rows: vec![],
            missing: items.iter().map(|(_, id)| *id).collect(),
        });
    }
    let body = response
        .bounded_bytes(8 * 1024 * 1024)
        .await
        .map_err(|_| "Plex matching details failed or exceeded their byte limit")?;
    parse_details(
        decode_json(&body).map_err(|_| "Invalid Plex matching details")?,
        library,
        items,
    )
}
fn parse_details(raw: Value, library: i64, items: &[(String, i64)]) -> Result<Details, String> {
    let container = raw
        .get("MediaContainer")
        .ok_or("Missing matching detail container")?;
    let values = match container.get("Metadata") {
        Some(Value::Array(values)) => values.as_slice(),
        None if number(&container["size"]) == Some(0) => &[],
        _ => return Err("Missing matching detail records".into()),
    };
    if values.len() > items.len() || number(&container["size"]) != Some(values.len() as i64) {
        return Err("Plex returned too many matching details".into());
    }
    let mut seen = std::collections::HashSet::new();
    let mut rows = Vec::new();
    for value in values {
        let id = number(&value["ratingKey"]).ok_or("Invalid matching detail identity")?;
        let (kind, _) = items
            .iter()
            .find(|(_, wanted)| *wanted == id)
            .ok_or("Plex returned a different matching detail identity")?;
        if !seen.insert(id) || number(&value["librarySectionID"]) != Some(library) {
            return Err(
                "Matching detail identity is repeated or belongs to another library".into(),
            );
        }
        rows.push(row::parse(value, kind, library)?);
    }
    Ok(Details {
        rows,
        missing: items
            .iter()
            .filter(|(_, id)| !seen.contains(id))
            .map(|(_, id)| *id)
            .collect(),
    })
}
pub async fn capabilities(
    client: &PlexClient,
    library: i64,
    modern: bool,
) -> Result<Value, String> {
    let mut query = request(client, &format!("/library/sections/{library}/all"), modern)?.query(&[
        ("type", "10"),
        ("includeMeta", "1"),
        ("X-Plex-Container-Size", "1"),
        ("excludeElements", "Media,Extras,Related,MusicAnalysis"),
    ]);
    if modern {
        query = query.query(&[
            (
                "includeFields",
                "size,offset,totalSize,librarySectionID,type,title,key,filter,default,direction",
            ),
            (
                "includeElements",
                "Metadata,Meta,Type,Sort,Field,FieldType,Operator",
            ),
        ]);
    }
    let body = query
        .send()
        .await
        .map_err(|_| "Plex matching capabilities are unavailable")?
        .bounded_bytes(1024 * 1024)
        .await
        .map_err(|_| "Plex matching capabilities failed or exceeded their limit")?;
    let raw: Value = decode_json(&body).map_err(|_| "Invalid matching capability response")?;
    let meta = raw["MediaContainer"]["Meta"].clone();
    if !meta.is_object() {
        return Err("Plex did not publish matching filter capabilities".into());
    }
    Ok(meta)
}
pub async fn section_stamp(
    client: &PlexClient,
    library: i64,
) -> Result<(Option<String>, bool), String> {
    use sha2::{Digest, Sha256};
    let raw: Value = client
        .get("/library/sections")
        .await
        .map_err(|_| "Plex library freshness is unavailable")?;
    let section = raw["Directory"]
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|item| number(&item["key"]) == Some(library) && item["type"] == "artist")
        })
        .ok_or("Plex music library is unavailable")?;
    let values: Vec<_> = ["updatedAt", "scannedAt", "contentChangedAt"]
        .iter()
        .map(|field| number(&section[*field]))
        .collect();
    let stamp = values.iter().any(Option::is_some).then(|| {
        hex::encode(Sha256::digest(
            serde_json::to_vec(&values).unwrap_or_default(),
        ))
    });
    Ok((
        stamp,
        section["refreshing"].as_bool().unwrap_or(false)
            || number(&section["refreshing"]).is_some_and(|n| n != 0)
            || section["refreshing"] == "true",
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn targeted_details_require_exact_identity_type_library_and_size() {
        let items = vec![("track".into(), 7), ("album".into(), 8)];
        let raw = serde_json::json!({"MediaContainer":{"size":1,"Metadata":[{"type":"track","ratingKey":7,"title":"Song","librarySectionID":4,"parentRatingKey":2,"grandparentRatingKey":1,"parentTitle":"Release","grandparentTitle":"Artist"}]}});
        let result = parse_details(raw.clone(), 4, &items).unwrap();
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.missing, vec![8]);
        assert!(parse_details(raw.clone(), 5, &items).is_err());
        for (key, value) in [
            ("ratingKey", 9.into()),
            ("type", "album".into()),
            ("librarySectionID", Value::Null),
        ] {
            let mut bad = raw.clone();
            bad["MediaContainer"]["Metadata"][0][key] = value;
            assert!(parse_details(bad, 4, &items).is_err());
        }
        let mut duplicate = raw.clone();
        duplicate["MediaContainer"]["size"] = 2.into();
        duplicate["MediaContainer"]["Metadata"]
            .as_array_mut()
            .unwrap()
            .push(raw["MediaContainer"]["Metadata"][0].clone());
        assert!(parse_details(duplicate, 4, &items).is_err());
        let empty =
            parse_details(serde_json::json!({"MediaContainer":{"size":0}}), 4, &items).unwrap();
        assert!(empty.rows.is_empty());
        assert_eq!(empty.missing, vec![7, 8]);
        assert!(parse_details(serde_json::json!({"MediaContainer":{}}), 4, &items).is_err());
    }
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
