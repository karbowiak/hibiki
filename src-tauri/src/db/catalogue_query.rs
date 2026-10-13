//! Credential/path-free renderer projections over the private, scoped archive.
use crate::plex::{Album, Artist, Playlist, Track};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub items: Vec<Value>,
    pub total: i64,
    pub cached_at: i64,
    pub complete: bool,
    pub server_total: Option<i64>,
}
pub(crate) fn project(kind: &str, raw: Value) -> Result<Value, String> {
    let mut raw = super::catalogue::clean_document(&raw)?;
    // PMS sometimes supplies only ratingKey fields for ancestry.
    for (id, key) in [
        ("parentRatingKey", "parentKey"),
        ("grandparentRatingKey", "grandparentKey"),
    ] {
        if raw[key].as_str().is_none() {
            if let Some(id) = crate::plex::catalogue::number(&raw[id]) {
                raw[key] = json!(format!("/library/metadata/{id}"));
            }
        }
    }
    fn encode<T: serde::de::DeserializeOwned + Serialize>(raw: Value) -> Result<Value, String> {
        serde_json::from_value::<T>(raw)
            .and_then(serde_json::to_value)
            .map_err(|_| "Saved catalogue item is invalid".into())
    }
    let mut item = match kind {
        "track" => encode::<Track>(raw)?,
        "album" => encode::<Album>(raw)?,
        "artist" => encode::<Artist>(raw)?,
        "playlist" => encode::<Playlist>(raw)?,
        _ => return Err("Invalid catalogue kind".into()),
    };
    // The full Part.file/key documents stay native for path joins. Playback
    // refetches a verified native binding; browsing cannot supply an audio URL.
    if let Some(media) = item["media"].as_array_mut() {
        for media in media {
            if let Some(parts) = media["parts"].as_array_mut() {
                for part in parts {
                    if let Some(part) = part.as_object_mut() {
                        part.remove("file");
                        part.insert("key".into(), json!(""));
                    }
                }
            }
        }
    }
    item["type"] = json!(kind);
    Ok(item)
}
const DOCUMENT:&str="CASE WHEN listing_saved_at>saved_at THEN json_patch(document,json_remove(listing,'$.Media','$.Guid')) ELSE document END";
pub fn query(
    conn: &Connection,
    scope: &str,
    method: &str,
    args: &[Value],
) -> Result<Option<Page>, String> {
    super::offline::check_identity(scope, method)?;
    let invalidated: Option<i64> = conn
        .query_row(
            "SELECT invalidated_at FROM plex_catalogue_invalidations WHERE scope=?1 AND method=?2",
            params![scope, method],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| "Cannot read catalogue invalidation")?;
    if method == "getPlaylistItems" {
        let id = args
            .first()
            .and_then(Value::as_str)
            .and_then(|s| s.parse::<i64>().ok())
            .filter(|id| *id > 0)
            .ok_or("Invalid playlist ID")?;
        return playlist(
            conn,
            scope,
            id,
            args.get(1).and_then(Value::as_i64).unwrap_or(0),
            args.get(2).and_then(Value::as_i64).unwrap_or(200),
        );
    }
    if method == "getAlbumTracks" {
        let roster = super::catalogue_sync::task(conn, scope, "track")?;
        let roster_fresh = roster.is_some_and(|task| {
            task.status == "complete"
                && invalidated.is_none_or(|at| task.completed_at.is_some_and(|time| time > at))
        });
        if !roster_fresh {
            let id = args
                .first()
                .and_then(Value::as_str)
                .and_then(|s| s.parse::<i64>().ok())
                .filter(|id| *id > 0)
                .ok_or("Invalid album ID")?;
            if let Some(page) = downloaded_album(conn, scope, id, invalidated)? {
                return Ok(Some(page));
            }
        }
    }
    if let Some(invalidated) = invalidated {
        let detail_kind = match method {
            "getTrack" => Some("track"),
            "getAlbum" => Some("album"),
            "getArtist" => Some("artist"),
            _ => None,
        };
        let detail_fresh = if let Some(kind) = detail_kind {
            let id = args
                .first()
                .and_then(Value::as_str)
                .and_then(|s| s.parse::<i64>().ok())
                .filter(|id| *id > 0)
                .ok_or("Invalid catalogue ID")?;
            conn.query_row("SELECT max(saved_at,listing_saved_at)>?4 FROM plex_catalogue WHERE scope=?1 AND kind=?2 AND id=?3",params![scope,kind,id,invalidated],|r|r.get::<_,bool>(0)).optional().map_err(|_|"Cannot verify detail freshness")?.unwrap_or(false)
        } else {
            false
        };
        let latest:Option<i64>=conn.query_row("SELECT CASE WHEN COUNT(*)=4 AND SUM(status='complete' AND completed_at IS NOT NULL)=4 THEN MIN(completed_at) ELSE NULL END FROM plex_catalogue_tasks WHERE scope=?1 AND task IN ('artist','album','track','playlist')",[scope],|r|r.get(0)).map_err(|_|"Cannot verify catalogue freshness")?;
        if !detail_fresh && latest.is_none_or(|saved| saved <= invalidated) {
            return Ok(None);
        }
    }
    let strarg = |n: usize| args.get(n).and_then(Value::as_str);
    let intarg = |n: usize, default: i64| args.get(n).and_then(Value::as_i64).unwrap_or(default);
    let kind;
    let mut condition = "1".to_owned();
    let mut bindings = Vec::<Value>::new();
    let mut order = "title COLLATE NOCASE,id";
    let mut offset = 0;
    let limit;
    let mut require_complete = false;
    match method {
        "getTags" => {
            let tag = match strarg(0) {
                Some("genre") => "Genre",
                Some("mood") => "Mood",
                Some("style") => "Style",
                _ => return Ok(None),
            };
            let mut stmt=conn.prepare(&format!("SELECT DISTINCT json_extract(t.value,'$.tag') FROM plex_catalogue c,json_each(json_extract(c.document,'$.{tag}')) t WHERE c.scope=?1 AND c.removed=0 AND json_extract(t.value,'$.tag') IS NOT NULL ORDER BY json_extract(t.value,'$.tag') COLLATE NOCASE LIMIT 10001")).map_err(|_|"Cannot read local tags")?;
            let rows = stmt
                .query_map([scope], |r| r.get::<_, String>(0))
                .map_err(|_| "Cannot read local tags")?;
            let mut items = Vec::new();
            for row in rows {
                items.push(json!({"tag":row.map_err(|_|"Cannot read local tag")?,"count":null}));
            }
            if items.len() > 10000 {
                return Err("Saved tag inventory exceeds its response limit".into());
            }
            if items.is_empty() {
                return Ok(None);
            }
            return Ok(Some(Page {
                total: items.len() as i64,
                items,
                cached_at: super::catalogue::now(),
                complete: false,
                server_total: None,
            }));
        }
        "getItemsByTag" => {
            kind = match strarg(2) {
                Some("track" | "10") => "track",
                Some("album" | "9") => "album",
                Some("artist" | "8") | None => "artist",
                _ => return Ok(None),
            };
            let tag = match strarg(0) {
                Some("genre") => "Genre",
                Some("mood") => "Mood",
                Some("style") => "Style",
                _ => return Ok(None),
            };
            condition=format!("EXISTS(SELECT 1 FROM json_each(json_extract(document,'$.{tag}')) WHERE json_extract(value,'$.tag')=?2)");
            bindings.push(json!(strarg(1).ok_or("Invalid local tag name")?));
            limit = intarg(3, 100);
            offset = intarg(4, 0);
        }
        "getTrack" | "getAlbum" | "getArtist" => {
            kind = match method {
                "getAlbum" => "album",
                "getArtist" => "artist",
                _ => "track",
            };
            condition = "id=?2".into();
            bindings.push(json!(strarg(0)
                .and_then(|s| s.parse::<i64>().ok())
                .ok_or("Invalid catalogue ID")?));
            limit = 1;
        }
        "getAllArtists" | "getAllAlbums" | "getAllTracks" => {
            kind = match method {
                "getAllArtists" => "artist",
                "getAllAlbums" => "album",
                _ => "track",
            };
            offset = intarg(0, 0);
            limit = intarg(1, 200);
        }
        "getPlaylists" => {
            kind = "playlist";
            limit = 1000000;
        }
        "getPlaylistItems" => {
            return playlist(
                conn,
                scope,
                strarg(0)
                    .and_then(|s| s.parse().ok())
                    .ok_or("Invalid playlist ID")?,
                intarg(1, 0),
                intarg(2, 200),
            );
        }
        "getAlbumTracks" | "getArtistAlbums" | "getArtistAlbumsInSection" => {
            kind = if method == "getAlbumTracks" {
                "track"
            } else {
                "album"
            };
            require_complete = true;
            condition="CAST(json_extract(document,'$.parentRatingKey') AS INTEGER)=?2 OR json_extract(document,'$.parentKey')=?3".into();
            let id = strarg(0)
                .and_then(|s| s.parse::<i64>().ok())
                .ok_or("Invalid parent ID")?;
            bindings.extend([json!(id), json!(format!("/library/metadata/{id}"))]);
            limit = 1000000;
            order = if kind == "track" {
                "CAST(json_extract(document,'$.parentIndex') AS INTEGER),CAST(json_extract(document,'$.index') AS INTEGER),id"
            } else {
                "json_extract(document,'$.year') DESC,title COLLATE NOCASE,id"
            };
            if kind == "album" {
                if let Some(format) = strarg(1).filter(|s| !s.is_empty()) {
                    let (negate, format) = format
                        .strip_prefix('!')
                        .map(|s| (true, s))
                        .unwrap_or((false, format));
                    condition=format!("({condition}) AND {} EXISTS(SELECT 1 FROM json_each(json_extract(document,'$.Format')) WHERE json_extract(value,'$.tag') IN (SELECT value FROM json_each(?4)))",if negate{"NOT"}else{""});
                    bindings.push(json!(serde_json::to_string(
                        &format.split(',').collect::<Vec<_>>()
                    )
                    .map_err(|_| "Invalid album format")?));
                }
            }
        }
        "getArtistTracks" | "getArtistPopularTracks" | "getArtistPopularTracksInSection" => {
            kind = "track";
            require_complete = method != "getArtistTracks";
            let id = strarg(0)
                .and_then(|s| s.parse::<i64>().ok())
                .ok_or("Invalid artist ID")?;
            condition="CAST(json_extract(document,'$.grandparentRatingKey') AS INTEGER)=?2 OR json_extract(document,'$.grandparentKey')=?3".into();
            bindings.extend([json!(id), json!(format!("/library/metadata/{id}"))]);
            limit = if method == "getArtistTracks" {
                1000000
            } else {
                intarg(1, 100).clamp(1, 500)
            };
            order = if method == "getArtistTracks" {
                "json_extract(document,'$.parentTitle') COLLATE NOCASE,CAST(json_extract(document,'$.parentIndex') AS INTEGER),CAST(json_extract(document,'$.index') AS INTEGER),id"
            } else {
                "CAST(json_extract(document,'$.ratingCount') AS INTEGER) DESC,id"
            };
        }
        "getLikedTracks" | "getLikedAlbums" | "getLikedArtists" => {
            kind = match method {
                "getLikedAlbums" => "album",
                "getLikedArtists" => "artist",
                _ => "track",
            };
            condition = "CAST(json_extract(document,'$.userRating') AS REAL)>0".into();
            limit = 1000000;
            order = "json_extract(document,'$.lastRatedAt') DESC,id";
        }
        "getRecentlyAdded" => {
            kind = match strarg(0) {
                Some("artist") => "artist",
                Some("album") | None => "album",
                Some("track") => "track",
                _ => return Ok(None),
            };
            limit = intarg(1, 50);
            order = "json_extract(document,'$.addedAt') DESC,id";
        }
        "getLatestReleases" => {
            kind = "album";
            limit = intarg(0, 30).clamp(1, 50);
            condition="(date(json_extract(document,'$.originallyAvailableAt')) IS NULL OR date(json_extract(document,'$.originallyAvailableAt'))<=date('now'))".into();
            order = "date(json_extract(document,'$.originallyAvailableAt')) DESC,id";
        }
        "search" => {
            kind = match strarg(1) {
                Some("track") => "track",
                Some("album") => "album",
                Some("artist") => "artist",
                None => "all",
                _ => return Ok(None),
            };
            let words = strarg(0)
                .unwrap_or("")
                .split_whitespace()
                .take(16)
                .map(|s| format!("\"{}\"*", s.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(" AND ");
            if words.is_empty() {
                return Ok(Some(Page {
                    items: vec![],
                    total: 0,
                    cached_at: super::catalogue::now(),
                    complete: false,
                    server_total: None,
                }));
            }
            condition="rowid IN (SELECT rowid FROM plex_catalogue_search WHERE plex_catalogue_search MATCH ?2 AND scope=?1)".into();
            bindings.push(json!(words));
            limit = 250;
        }
        _ => return Ok(None),
    }
    if offset < 0 || !(1..=1000000).contains(&limit) {
        return Err("Invalid catalogue page bounds".into());
    }
    let complete = if matches!(method, "getTrack" | "getAlbum" | "getArtist") {
        let id = bindings
            .first()
            .and_then(Value::as_i64)
            .ok_or("Invalid catalogue detail ID")?;
        conn.query_row(
            "SELECT detail=1 FROM plex_catalogue WHERE scope=?1 AND kind=?2 AND id=?3",
            params![scope, kind, id],
            |r| r.get::<_, bool>(0),
        )
        .optional()
        .map_err(|_| "Cannot verify detail coverage")?
        .unwrap_or(false)
    } else {
        super::catalogue_sync::task(conn, scope, kind)?.is_some_and(|t| t.status == "complete")
    };
    if require_complete && !complete {
        return Ok(None);
    }
    let filter = format!(
        "scope=?1 AND removed=0 AND {} AND ({condition})",
        if kind == "all" {
            "kind IN ('artist','album','track')".into()
        } else {
            format!("kind='{kind}'")
        }
    );
    let mut values = vec![json!(scope)];
    values.extend(bindings);
    let sqlvalues = values
        .iter()
        .map(|v| match v {
            Value::Number(n) => rusqlite::types::Value::Integer(n.as_i64().unwrap_or(0)),
            Value::String(s) => rusqlite::types::Value::Text(s.clone()),
            _ => rusqlite::types::Value::Null,
        })
        .collect::<Vec<_>>();
    let total: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM plex_catalogue WHERE {filter}"),
            rusqlite::params_from_iter(&sqlvalues),
            |r| r.get(0),
        )
        .map_err(|_| "Cannot count catalogue items")?;
    if total == 0 && !complete {
        return Ok(None);
    }
    let mut statement=conn.prepare(&format!("SELECT kind,{DOCUMENT},max(saved_at,listing_saved_at) FROM plex_catalogue WHERE {filter} ORDER BY {order} LIMIT {limit} OFFSET {offset}")).map_err(|_|"Cannot query catalogue")?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(&sqlvalues), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .map_err(|_| "Cannot query catalogue")?;
    let mut items = Vec::new();
    let mut cached_at = 0;
    let mut bytes = 0;
    for row in rows {
        let (kind, text, saved) = row.map_err(|_| "Cannot read catalogue")?;
        bytes += text.len();
        if bytes > 32 * 1024 * 1024 {
            return Err("This saved collection exceeds the browsing response limit. Use paged library browsing.".into());
        }
        items.push(project(
            &kind,
            serde_json::from_str(&text).map_err(|_| "Invalid saved catalogue")?,
        )?);
        cached_at = cached_at.max(saved);
    }
    if items.is_empty() && !complete {
        return Ok(None);
    }
    // Until coverage completes the reported server total remains truthful.
    let server_total = if method.starts_with("getAll") && !complete {
        super::catalogue_sync::task(conn, scope, kind)?.and_then(|t| t.total)
    } else {
        None
    };
    Ok(Some(Page {
        items,
        total,
        cached_at,
        complete,
        server_total,
    }))
}
/// A verified captured entity is independently complete even while the global
/// track census is still running. Old individually adopted intentions have no
/// album membership, so they cannot invent album coverage.
fn downloaded_album(
    conn: &Connection,
    scope: &str,
    id: i64,
    invalidated: Option<i64>,
) -> Result<Option<Page>, String> {
    let entity:Option<(i64,i64)>=conn.query_row("SELECT entry_count,captured_at FROM audio_download_entities WHERE scope=?1 AND kind='album' AND entity_id=?2",params![scope,id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|_|"Cannot read downloaded album coverage")?;
    let Some((expected, cached_at)) = entity else {
        return Ok(None);
    };
    if invalidated.is_some_and(|at| cached_at <= at) {
        return Ok(None);
    }
    let mut stmt=conn.prepare("SELECT m.track_id,m.document,c.document FROM audio_download_members m LEFT JOIN plex_catalogue c ON c.scope=m.scope AND c.kind='track' AND c.id=m.track_id WHERE m.scope=?1 AND m.kind='album' AND m.entity_id=?2 ORDER BY CAST(coalesce(json_extract(m.document,'$.parentIndex'),json_extract(c.document,'$.parentIndex')) AS INTEGER),CAST(coalesce(json_extract(m.document,'$.index'),json_extract(c.document,'$.index')) AS INTEGER),m.track_id").map_err(|_|"Cannot read captured album members")?;
    let rows = stmt
        .query_map(params![scope, id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|_| "Cannot read captured album members")?;
    let mut items = Vec::new();
    let mut bytes = 0;
    for row in rows {
        let (track, member, full) = row.map_err(|_| "Cannot read captured album member")?;
        let raw = match (member.as_deref(), full.as_deref()) {
            (Some(member), full) => enrich_member(member, full, Some(track))?,
            (None, Some(full)) => enrich_member(full, None, Some(track))?,
            (None, None) => return Ok(None),
        };
        let item = project("track", raw)?;
        bytes += serde_json::to_vec(&item)
            .map_err(|_| "Invalid captured album projection")?
            .len();
        if bytes > 32 * 1024 * 1024 {
            return Err("This captured album exceeds the browsing response limit.".into());
        }
        items.push(item);
    }
    if expected < 0 || items.len() as i64 != expected {
        return Ok(None);
    }
    Ok(Some(Page {
        items,
        total: expected,
        cached_at,
        complete: true,
        server_total: Some(expected),
    }))
}
/// Membership scalars and occurrence IDs belong to the captured source. Sparse
/// member Media/Guid lists must not erase full native stream analysis/details.
fn enrich_member(member: &str, full: Option<&str>, expected: Option<i64>) -> Result<Value, String> {
    let member: Value =
        serde_json::from_str(member).map_err(|_| "Invalid captured track metadata")?;
    let id = crate::plex::catalogue::number(&member["ratingKey"])
        .filter(|id| *id > 0)
        .ok_or("Invalid captured track identity")?;
    if expected.is_some_and(|expected| expected != id) || member["type"].as_str() != Some("track") {
        return Err("Captured metadata describes a different track".into());
    }
    let Some(full) = full else { return Ok(member) };
    let mut full: Value = serde_json::from_str(full).map_err(|_| "Invalid full track metadata")?;
    if crate::plex::catalogue::number(&full["ratingKey"]) != Some(id)
        || full["type"].as_str() != Some("track")
    {
        return Err("Full metadata describes a different captured track".into());
    }
    let rich = full.as_object_mut().ok_or("Invalid full track metadata")?;
    // A catalogue track is never allowed to substitute a playlist occurrence.
    rich.remove("playlistItemID");
    for (key, value) in member
        .as_object()
        .ok_or("Invalid captured track metadata")?
    {
        if matches!(key.as_str(), "Media" | "Guid")
            && rich
                .get(key)
                .and_then(Value::as_array)
                .is_some_and(|items| !items.is_empty())
        {
            continue;
        }
        rich.insert(key.clone(), value.clone());
    }
    Ok(full)
}
fn playlist(
    conn: &Connection,
    scope: &str,
    id: i64,
    offset: i64,
    limit: i64,
) -> Result<Option<Page>, String> {
    if id <= 0 || offset < 0 || !(1..=10000).contains(&limit) {
        return Err("Invalid playlist page".into());
    }
    let published:Option<(String,i64,i64)>=conn.query_row("SELECT generation,total,saved_at FROM plex_catalogue_playlist_versions WHERE scope=?1 AND playlist_id=?2",params![scope,id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|_|"Cannot read playlist version")?;
    let Some((generation, total, cached_at)) = published else {
        return Ok(None);
    };
    let invalidated:Option<i64>=conn.query_row("SELECT invalidated_at FROM plex_catalogue_invalidations WHERE scope=?1 AND method='getPlaylistItems'",[scope],|r|r.get(0)).optional().map_err(|_|"Cannot verify playlist freshness")?;
    if invalidated.is_some_and(|at| cached_at <= at) {
        return Ok(None);
    }
    let mut stmt=conn.prepare("SELECT m.document,c.document FROM plex_catalogue_playlist_members m LEFT JOIN plex_catalogue c ON c.scope=m.scope AND c.kind='track' AND c.id=CAST(json_extract(m.document,'$.ratingKey') AS INTEGER) WHERE m.scope=?1 AND m.playlist_id=?2 AND m.generation=?3 ORDER BY m.position LIMIT ?4 OFFSET ?5").map_err(|_|"Cannot read playlist catalogue")?;
    let rows = stmt
        .query_map(params![scope, id, generation, limit, offset], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })
        .map_err(|_| "Cannot read playlist catalogue")?;
    let mut items = vec![];
    let mut bytes = 0;
    for row in rows {
        let (member, full) = row.map_err(|_| "Cannot read playlist catalogue")?;
        let item = project("track", enrich_member(&member, full.as_deref(), None)?)?;
        bytes += serde_json::to_vec(&item)
            .map_err(|_| "Invalid playlist projection")?
            .len();
        if bytes > 32 * 1024 * 1024 {
            return Err(
                "This playlist page exceeds the response limit. Request a smaller page.".into(),
            );
        }
        items.push(item);
    }
    Ok(Some(Page {
        items,
        total,
        cached_at,
        complete: true,
        server_total: Some(total),
    }))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn projections_are_scoped_searchable_and_keep_paths_native() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        let scope = format!("plex-{}", "a".repeat(64));
        let raw = json!({"type":"track","ratingKey":"42","title":"Björk Test","parentRatingKey":"9","Media":[{"Part":[{"id":1,"file":"/private/music.flac","key":"/library/parts/1/file.flac"}]}]});
        crate::db::catalogue::save(&conn, &scope, "track", 42, &raw, true).unwrap();
        let page = query(&conn, &scope, "search", &[json!("bjork")])
            .unwrap()
            .unwrap();
        assert_eq!(page.items.len(), 1);
        assert!(!page.items[0].to_string().contains("/private/"));
        assert_eq!(page.items[0]["parent_key"], "/library/metadata/9");
        assert!(crate::db::catalogue::get(&conn, &scope, "track", 42)
            .unwrap()
            .unwrap()
            .to_string()
            .contains("/private/"));
        assert!(query(
            &conn,
            &format!("plex-{}", "b".repeat(64)),
            "search",
            &[json!("bjork")]
        )
        .unwrap()
        .is_none());
        assert!(query(&conn, &scope, "getAlbumTracks", &[json!("9")])
            .unwrap()
            .is_none());
    }
    #[test]
    fn complete_children_formats_likes_and_new_listings_keep_full_stream_details() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        let scope = format!("plex-{}", "a".repeat(64));
        let albums = [
            json!({"type":"album","ratingKey":"1","parentRatingKey":"9","title":"Album"}),
            json!({"type":"album","ratingKey":"2","parentRatingKey":"9","title":"EP","Format":[{"tag":"EP"}]}),
            json!({"type":"album","ratingKey":"3","parentRatingKey":"9","title":"Single","Format":[{"tag":"Single"}]}),
        ];
        let task = super::super::catalogue_sync::begin(&conn, &scope, "album", None).unwrap();
        super::super::catalogue_sync::roster_page(&conn, &scope, &task, &albums, Some(3), true)
            .unwrap();
        assert_eq!(
            query(
                &conn,
                &scope,
                "getArtistAlbumsInSection",
                &[json!("9"), json!("EP,Single")]
            )
            .unwrap()
            .unwrap()
            .items
            .len(),
            2
        );
        assert_eq!(
            query(
                &conn,
                &scope,
                "getArtistAlbums",
                &[json!("9"), json!("!Single")]
            )
            .unwrap()
            .unwrap()
            .items
            .len(),
            2
        );
        let full = json!({"type":"track","ratingKey":"42","title":"Old","userRating":2,"Media":[{"id":7,"Part":[{"id":8,"file":"/private/song","key":"/library/parts/8/song.flac","Stream":[{"id":9,"streamType":2,"gain":"-8.2"}]}]}]});
        super::super::catalogue::save(&conn, &scope, "track", 42, &full, true).unwrap();
        conn.execute("UPDATE plex_catalogue SET listing=?1,listing_saved_at=saved_at+1 WHERE id=42",[json!({"type":"track","ratingKey":"42","title":"New","Media":[{"id":7,"Part":[{"id":8}]}]}).to_string()]).unwrap();
        let page = query(&conn, &scope, "getTrack", &[json!("42")])
            .unwrap()
            .unwrap();
        assert_eq!(page.items[0]["title"], "New");
        assert_eq!(
            page.items[0]["media"][0]["parts"][0]["streams"][0]["gain"],
            -8.2
        );
        assert_eq!(
            query(&conn, &scope, "search", &[json!("New")])
                .unwrap()
                .unwrap()
                .items
                .len(),
            1
        );
        assert_eq!(
            query(&conn, &scope, "getLikedTracks", &[json!(1)])
                .unwrap()
                .unwrap()
                .items
                .len(),
            1
        );
        assert!(query(&conn, &scope, "search", &[json!("Old")])
            .unwrap()
            .is_none());
    }
    #[test]
    fn partial_browse_keeps_local_totals_and_playlist_publication_has_exact_duplicate_order() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        let scope = format!("plex-{}", "a".repeat(64));
        let track = |id: i64, occurrence: i64| json!({"type":"track","ratingKey":id,"playlistItemID":occurrence,"title":format!("Track {id}")});
        let roster = super::super::catalogue_sync::begin(&conn, &scope, "track", None).unwrap();
        super::super::catalogue_sync::roster_page(
            &conn,
            &scope,
            &roster,
            &[track(1, 10)],
            Some(3),
            false,
        )
        .unwrap();
        let page = query(&conn, &scope, "getAllTracks", &[json!(0), json!(20)])
            .unwrap()
            .unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.server_total, Some(3));
        assert!(!page.complete);
        let task =
            super::super::catalogue_sync::begin(&conn, &scope, "playlist:7", Some("v1")).unwrap();
        super::super::catalogue_sync::playlist_page(
            &conn,
            &scope,
            7,
            &task,
            &[track(1, 10), track(2, 11), track(1, 12)],
            Some(3),
            true,
        )
        .unwrap();
        let page = query(
            &conn,
            &scope,
            "getPlaylistItems",
            &[json!("7"), json!(1), json!(2)],
        )
        .unwrap()
        .unwrap();
        assert_eq!(page.total, 3);
        assert_eq!(page.items[0]["playlist_item_id"], 11);
        assert_eq!(page.items[1]["playlist_item_id"], 12);
        let next =
            super::super::catalogue_sync::begin(&conn, &scope, "playlist:7", Some("v2")).unwrap();
        super::super::catalogue_sync::playlist_page(
            &conn,
            &scope,
            7,
            &next,
            &[track(2, 99)],
            Some(3),
            false,
        )
        .unwrap();
        assert_eq!(
            query(
                &conn,
                &scope,
                "getPlaylistItems",
                &[json!("7"), json!(1), json!(2)]
            )
            .unwrap()
            .unwrap()
            .items[0]["playlist_item_id"],
            11
        );
    }
    #[test]
    fn captured_downloaded_album_is_complete_before_global_roster_and_preserves_full_media() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        let scope = format!("plex-{}", "a".repeat(64));
        super::super::catalogue::save(
            &conn,
            &scope,
            "album",
            7,
            &json!({"type":"album","ratingKey":7,"title":"Captured album","parentRatingKey":9}),
            true,
        )
        .unwrap();
        super::super::catalogue::save(
            &conn,
            &scope,
            "artist",
            9,
            &json!({"type":"artist","ratingKey":9,"title":"Captured artist"}),
            true,
        )
        .unwrap();
        let full = json!({"type":"track","ratingKey":30,"title":"Older title","parentRatingKey":7,"Media":[{"id":1,"Part":[{"id":8,"file":"/private/song.flac","key":"/library/parts/8/song.flac","Stream":[{"id":9,"streamType":2,"gain":"-8.2"}]}]},{"id":2,"Part":[{"id":18,"file":"/private/song.mp3","key":"/library/parts/18/song.mp3","Stream":[{"id":19,"streamType":2,"gain":"-4.1"}]}]}],"Guid":[{"id":"mbid://recording"}]});
        super::super::catalogue::save(&conn, &scope, "track", 30, &full, true).unwrap();
        conn.execute("INSERT INTO audio_download_entities(scope,kind,entity_id,title,revision,captured_at,entry_count) VALUES(?1,'album',7,'Captured album','verified',100,3)",[&scope]).unwrap();
        for (id, disc, index) in [(30, 1, 3), (10, 1, 1), (20, 2, 1)] {
            let raw = json!({"type":"track","ratingKey":id,"title":format!("Captured {id}"),"parentRatingKey":7,"parentIndex":disc,"index":index,"Media":[{"id":1,"Part":[{"id":8}]}],"Guid":[]});
            conn.execute("INSERT INTO audio_download_members(scope,kind,entity_id,track_id,document) VALUES(?1,'album',7,?2,?3)",params![scope,id,raw.to_string()]).unwrap();
        }
        assert!(super::super::catalogue_sync::task(&conn, &scope, "track")
            .unwrap()
            .is_none());
        let page = query(&conn, &scope, "getAlbumTracks", &[json!("7")])
            .unwrap()
            .unwrap();
        assert_eq!(page.total, 3);
        assert!(page.complete);
        assert_eq!(
            page.items
                .iter()
                .map(|item| item["rating_key"].as_i64().unwrap())
                .collect::<Vec<_>>(),
            vec![10, 30, 20]
        );
        assert_eq!(page.items[1]["title"], "Captured 30");
        assert_eq!(page.items[1]["media"].as_array().unwrap().len(), 2);
        assert_eq!(
            page.items[1]["media"][0]["parts"][0]["streams"][0]["gain"],
            -8.2
        );
        assert!(!page.items[1].to_string().contains("/private/"));
        assert!(
            query(&conn, &scope, "getAlbum", &[json!("7")])
                .unwrap()
                .unwrap()
                .complete
        );
        assert_eq!(
            query(&conn, &scope, "getAlbum", &[json!("7")])
                .unwrap()
                .unwrap()
                .items[0]["title"],
            "Captured album"
        );
        assert_eq!(
            query(&conn, &scope, "getArtist", &[json!("9")])
                .unwrap()
                .unwrap()
                .items[0]["title"],
            "Captured artist"
        );
        assert!(query(
            &conn,
            &format!("plex-{}", "b".repeat(64)),
            "getAlbumTracks",
            &[json!("7")]
        )
        .unwrap()
        .is_none());
        conn.execute("INSERT INTO plex_catalogue_invalidations(scope,method,invalidated_at) VALUES(?1,'getAlbumTracks',50)",[&scope]).unwrap();
        assert!(query(&conn, &scope, "getAlbumTracks", &[json!("7")])
            .unwrap()
            .is_some());
        conn.execute(
            "UPDATE plex_catalogue_invalidations SET invalidated_at=150 WHERE scope=?1",
            [&scope],
        )
        .unwrap();
        assert!(query(&conn, &scope, "getAlbumTracks", &[json!("7")])
            .unwrap()
            .is_none());
        conn.execute(
            "DELETE FROM plex_catalogue_invalidations WHERE scope=?1",
            [&scope],
        )
        .unwrap();
        conn.execute("DELETE FROM audio_download_members WHERE track_id=20", [])
            .unwrap();
        assert!(query(&conn, &scope, "getAlbumTracks", &[json!("7")])
            .unwrap()
            .is_none());
    }
    #[test]
    fn captured_playlist_before_global_roster_keeps_order_occurrences_and_scoped_full_streams() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        let scope = format!("plex-{}", "a".repeat(64));
        let other = format!("plex-{}", "b".repeat(64));
        super::super::catalogue::save(&conn,&scope,"playlist",7,&json!({"type":"playlist","ratingKey":7,"title":"Captured playlist","smart":false,"leafCount":3}),true).unwrap();
        for (s, gain) in [(&scope, -8.2), (&other, 99.0)] {
            super::super::catalogue::save(&conn,s,"track",42,&json!({"type":"track","ratingKey":42,"title":"Full track","playlistItemID":999,"Media":[{"id":1,"Part":[{"id":8,"file":"/private/song.flac","key":"/library/parts/8/song.flac","Stream":[{"id":9,"streamType":2,"gain":gain}]}]}]}),true).unwrap();
        }
        conn.execute("INSERT INTO plex_catalogue_playlist_versions(scope,playlist_id,generation,total,saved_at) VALUES(?1,7,'download:verified',3,100)",[&scope]).unwrap();
        for (position, id, occurrence) in [(0, 42, 11), (1, 43, 12), (2, 42, 13)] {
            let raw = json!({"type":"track","ratingKey":id,"playlistItemID":occurrence,"title":"Captured occurrence","Media":[{"id":1,"Part":[{"id":8}]}]});
            conn.execute("INSERT INTO plex_catalogue_playlist_members(scope,playlist_id,generation,position,document) VALUES(?1,7,'download:verified',?2,?3)",params![scope,position,raw.to_string()]).unwrap();
        }
        conn.execute("INSERT INTO plex_catalogue_invalidations(scope,method,invalidated_at) VALUES(?1,'getPlaylistItems',50)",[&scope]).unwrap();
        assert!(super::super::catalogue_sync::task(&conn, &scope, "track")
            .unwrap()
            .is_none());
        let page = query(
            &conn,
            &scope,
            "getPlaylistItems",
            &[json!("7"), json!(1), json!(2)],
        )
        .unwrap()
        .unwrap();
        assert_eq!(page.total, 3);
        assert!(page.complete);
        assert_eq!(page.items[0]["playlist_item_id"], 12);
        assert_eq!(page.items[1]["playlist_item_id"], 13);
        assert_eq!(
            page.items[1]["media"][0]["parts"][0]["streams"][0]["gain"],
            -8.2
        );
        assert!(!page.items[1].to_string().contains("/private/"));
        assert_eq!(
            query(&conn, &scope, "getPlaylists", &[])
                .unwrap()
                .unwrap()
                .items[0]["title"],
            "Captured playlist"
        );
        assert!(query(
            &conn,
            &other,
            "getPlaylistItems",
            &[json!("7"), json!(0), json!(2)]
        )
        .unwrap()
        .is_none());
        conn.execute(
            "UPDATE plex_catalogue_invalidations SET invalidated_at=150 WHERE scope=?1",
            [&scope],
        )
        .unwrap();
        assert!(query(
            &conn,
            &scope,
            "getPlaylistItems",
            &[json!("7"), json!(0), json!(2)]
        )
        .unwrap()
        .is_none());
        assert!(enrich_member(
            &json!({"type":"track","ratingKey":41}).to_string(),
            None,
            Some(42)
        )
        .is_err());
    }
}
