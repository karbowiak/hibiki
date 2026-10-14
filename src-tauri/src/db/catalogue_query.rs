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
    // The native archive has already sanitized and bounded its raw documents.
    // Keep input size/depth guards without cloning unknown metadata, then apply
    // the canonical credential/URL cleaner to only the actual renderer DTO.
    fn input_size(value: &Value, depth: usize, exact: bool) -> Result<(usize, usize), String> {
        const MAX: usize = 16 * 1024 * 1024;
        if depth > 48 {
            return Err("Plex metadata is too deeply nested".into());
        }
        fn text_size(text: &str, exact: bool) -> (usize, usize) {
            let plain = text.len().saturating_add(2);
            if !exact {
                return (plain, text.len().saturating_mul(6).saturating_add(2));
            }
            let extra = text.bytes().map(|byte| match byte {
                b'"' | b'\\' | b'\x08' | b'\x0c' | b'\n' | b'\r' | b'\t' => 1,
                0..=31 => 5,
                _ => 0,
            }).sum::<usize>();
            let size = plain.saturating_add(extra);
            (size, size)
        }
        let mut size = (0usize, 0usize);
        let mut add = |part: (usize, usize)| -> Result<(), String> {
            size.0 = size.0.saturating_add(part.0);
            size.1 = size.1.saturating_add(part.1).min(MAX + 1);
            if size.0 > MAX {
                return Err("Plex metadata document exceeds 16 MB".into());
            }
            Ok(())
        };
        match value {
            Value::Object(values) => {
                let delimiters = 2 + values.len().saturating_sub(1);
                add((delimiters, delimiters))?;
                for (key, value) in values {
                    add(text_size(key, exact))?;
                    add((1, 1))?;
                    add(input_size(value, depth + 1, exact)?)?;
                }
            }
            Value::Array(values) => {
                let delimiters = 2 + values.len().saturating_sub(1);
                add((delimiters, delimiters))?;
                for value in values {
                    add(input_size(value, depth + 1, exact)?)?;
                }
            }
            Value::String(text) => add(text_size(text, exact))?,
            Value::Number(number) => {
                let length = number.to_string().len();
                add((length, length))?;
            }
            Value::Null => add((4, 4))?,
            Value::Bool(value) => {
                let length = if *value { 4 } else { 5 };
                add((length, length))?;
            }
        }
        Ok(size)
    }
    // Ordinary metadata fits even its conservative escaped-size upper bound.
    // Only near-limit inputs need the exact borrowed escape-counting pass.
    if input_size(&raw, 0, false)?.1 > 16 * 1024 * 1024 {
        input_size(&raw, 0, true)?;
    }
    let mut raw = raw;
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
    super::catalogue::clean_document(&item)
}
const DOCUMENT:&str="CASE WHEN listing_saved_at>saved_at THEN json_patch(document,json_remove(listing,'$.Media','$.Guid')) ELSE document END";
// Disjoint NULL/date ranges let SQLite count directly from the release index,
// rather than evaluating this shelf's OR predicate on every album's fields.
const RELEASE_COUNT_SQL: &str = "SELECT
 (SELECT COUNT(*) FROM plex_catalogue_browse_data INDEXED BY plex_catalogue_browse_release WHERE scope=?1 AND kind='album' AND removed=0 AND released_on IS NULL)
 +(SELECT COUNT(*) FROM plex_catalogue_browse_data INDEXED BY plex_catalogue_browse_release WHERE scope=?1 AND kind='album' AND removed=0 AND released_on<=date('now'))";
// Both catalogue publication and captured downloads write consecutive positions
// from zero. Select that bounded range before joining full native track metadata.
const PLAYLIST_PAGE_SQL: &str = "WITH page AS MATERIALIZED(
 SELECT scope,position,document FROM plex_catalogue_playlist_members
 WHERE scope=?1 AND playlist_id=?2 AND generation=?3 AND position>=?4 AND position<?5 ORDER BY position)
 SELECT page.position,page.document,c.document FROM page LEFT JOIN plex_catalogue c
 ON c.scope=page.scope AND c.kind='track' AND c.id=CAST(json_extract(page.document,'$.ratingKey') AS INTEGER)
 ORDER BY page.position";
// Tags are small scalar DTOs, unlike tracks. Large real libraries can exceed
// 10,000 unique genres; retain the full searchable inventory within explicit
// row/encoded-byte bounds instead of falling back merely because of its size.
const TAG_LIMIT: usize = 100_000;
const TAG_BYTES: usize = 4 * 1024 * 1024;
/// Totals come from an atomically verified occurrence publication, never its
/// staging rows or a track-ID count (the same track may occur more than once).
/// Apply the same membership invalidation fence as getPlaylistItems.
pub(crate) fn published_playlist_counts(
    conn: &Connection,
    scope: &str,
    ids: &[i64],
) -> Result<std::collections::HashMap<i64, (i64, i64)>, String> {
    super::offline::check_identity(scope, "playlist-counts")?;
    if ids.is_empty() {
        return Ok(Default::default());
    }
    if ids.len() > 1_000_000 || ids.iter().any(|id| *id <= 0) {
        return Err("Invalid playlist count request".into());
    }
    let encoded = serde_json::to_string(ids).map_err(|_| "Invalid playlist count request")?;
    let mut statement = conn.prepare("SELECT playlist_id,total,saved_at FROM plex_catalogue_playlist_versions WHERE scope=?1 AND total>=0 AND saved_at>coalesce((SELECT invalidated_at FROM plex_catalogue_invalidations WHERE scope=?1 AND method='getPlaylistItems'),-1) AND playlist_id IN (SELECT value FROM json_each(?2))").map_err(|_| "Cannot read published playlist counts")?;
    let rows = statement
        .query_map(params![scope, encoded], |r| {
            Ok((r.get::<_, i64>(0)?, (r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)))
        })
        .map_err(|_| "Cannot read published playlist counts")?;
    rows.collect::<Result<_, _>>()
        .map_err(|_| "Cannot read published playlist counts".into())
}
/// Hot shelves/tags use compact indexed derived rows only after the bounded
/// scope backfill is complete. Foreground read connections never write here.
fn projections_ready(conn: &Connection, scope: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT complete FROM plex_catalogue_browse_state WHERE scope=?1",
        [scope],
        |r| r.get(0),
    )
    .optional()
    .map(|ready| ready.unwrap_or(true))
    .map_err(|_| "Cannot read browse projection coverage".into())
}
/// Runs on the native background writer. The source rows and their full raw
/// metadata never change. A finite original rowid boundary plus composite-key
/// checkpoints survive restart; concurrent new rows are covered by triggers.
pub(crate) fn backfill_projections(
    conn: &Connection,
    scope: &str,
    limit: usize,
) -> Result<bool, String> {
    super::offline::check_identity(scope, "browse-backfill")?;
    if !(1..=200).contains(&limit) {
        return Err("Invalid browse backfill batch".into());
    }
    let state:Option<(String,i64,i64,bool)>=conn.query_row("SELECT cursor_kind,cursor_id,upper_rowid,complete FROM plex_catalogue_browse_state WHERE scope=?1",[scope],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(|_|"Cannot read browse backfill")?;
    let Some((kind, id, upper, complete)) = state else {
        return Ok(true);
    };
    if complete {
        return Ok(true);
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|_| "Cannot start browse backfill")?;
    let fields=format!("json_extract({DOCUMENT},'$.parentRatingKey','$.parentKey','$.grandparentRatingKey','$.grandparentKey','$.parentIndex','$.index','$.year','$.ratingCount','$.userRating','$.addedAt','$.lastRatedAt','$.originallyAvailableAt','$.parentTitle','$.title')");
    let tags = format!("json_extract({DOCUMENT},'$.Genre','$.Mood','$.Style','$.Format')");
    let mut stmt=tx.prepare(&format!("SELECT kind,id,rowid,removed,{fields},{tags} FROM plex_catalogue WHERE scope=?1 AND (kind,id)>(?2,?3) AND rowid<=?4 ORDER BY kind,id LIMIT ?5")).map_err(|_|"Cannot select browse backfill batch")?;
    let rows = stmt
        .query_map(params![scope, kind, id, upper, limit as i64], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        })
        .map_err(|_| "Cannot read browse backfill batch")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Cannot read browse backfill row")?;
    drop(stmt);
    for (kind, id, rowid, removed, fields, tags) in &rows {
        tx.execute("INSERT OR IGNORE INTO plex_catalogue_browse_data(scope,kind,id,catalogue_rowid,removed,fields) VALUES(?1,?2,?3,?4,?5,?6)",params![scope,kind,id,rowid,removed,fields]).map_err(|_|"Cannot save browse projection")?;
        tx.execute("INSERT OR IGNORE INTO plex_catalogue_browse_tags(scope,kind,id,resource,tag,removed) SELECT ?1,?2,?3,CASE CAST(resources.key AS INTEGER) WHEN 0 THEN 'Genre' WHEN 1 THEN 'Mood' WHEN 2 THEN 'Style' ELSE 'Format' END,CASE WHEN t.type='object' THEN json_extract(t.value,'$.tag') END,?4 FROM json_each(?5) resources,json_each(CASE WHEN resources.type='array' THEN resources.value ELSE '[]' END) t WHERE CASE WHEN t.type='object' THEN json_type(t.value,'$.tag')='text' ELSE 0 END",params![scope,kind,id,removed,tags]).map_err(|_|"Cannot save browse tag projection")?;
    }
    let complete = rows.is_empty();
    let (next_kind, next_id) = rows
        .last()
        .map(|row| (row.0.as_str(), row.1))
        .unwrap_or((&kind, id));
    tx.execute("UPDATE plex_catalogue_browse_state SET cursor_kind=?2,cursor_id=?3,complete=?4 WHERE scope=?1",params![scope,next_kind,next_id,complete]).map_err(|_|"Cannot checkpoint browse backfill")?;
    tx.commit().map_err(|_| "Cannot commit browse backfill")?;
    Ok(complete)
}
fn projection_page_sql(filter: &str, order: &str, limit: i64, offset: i64) -> String {
    let columns = order
        .split(',')
        .map(|field| field.split_whitespace().next().unwrap_or("id"))
        .filter(|field| *field != "id")
        .collect::<Vec<_>>()
        .join(",");
    let page_order = order
        .split(',')
        .map(|field| format!("page.{field}"))
        .collect::<Vec<_>>()
        .join(",");
    format!("WITH page AS MATERIALIZED(SELECT scope,kind,id,{columns} FROM plex_catalogue_browse_data WHERE {filter} ORDER BY {order} LIMIT {limit} OFFSET {offset}) SELECT c.kind,CASE WHEN c.listing_saved_at>c.saved_at THEN json_patch(c.document,json_remove(c.listing,'$.Media','$.Guid')) ELSE c.document END,max(c.saved_at,c.listing_saved_at) FROM page JOIN plex_catalogue c ON c.scope=page.scope AND c.kind=page.kind AND c.id=page.id ORDER BY {page_order}")
}
pub fn query(
    conn: &Connection,
    scope: &str,
    method: &str,
    args: &[Value],
) -> Result<Option<Page>, String> {
    super::offline::check_identity(scope, method)?;
    let uses_projection = matches!(
        method,
        "getTags"
            | "getItemsByTag"
            | "getLikedTracks"
            | "getLikedAlbums"
            | "getLikedArtists"
            | "getRecentlyAdded"
            | "getLatestReleases"
    );
    if uses_projection && !projections_ready(conn, scope)? {
        return Ok(None);
    }
    let source = if uses_projection {
        "plex_catalogue_browse_data"
    } else {
        "plex_catalogue"
    };
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
    // A completed native catch-up can reconcile broad mutation invalidations
    // without requiring another full census. Point details keep their own
    // timestamp check, and playlist occurrences keep publication freshness.
    let invalidated = match invalidated {
        Some(at) if !matches!(method, "getTrack" | "getAlbum" | "getArtist")
            && super::catalogue_incremental::browse_reconciled_after(conn, scope, at)? => None,
        marker => marker,
    };
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
            let complete: bool = conn.query_row("SELECT COUNT(*)=3 AND SUM(status='complete')=3 FROM plex_catalogue_tasks WHERE scope=?1 AND task IN ('artist','album','track')", [scope], |r| r.get(0)).map_err(|_| "Cannot verify tag coverage")?;
            let mut stmt=conn.prepare("SELECT DISTINCT tag FROM plex_catalogue_browse_tags WHERE scope=?1 AND resource=?2 AND removed=0 ORDER BY tag COLLATE NOCASE,tag LIMIT ?3").map_err(|_|"Cannot read local tags")?;
            let rows = stmt
                .query_map(params![scope, tag, (TAG_LIMIT + 1) as i64], |r| r.get::<_, String>(0))
                .map_err(|_| "Cannot read local tags")?;
            let mut items = Vec::new();
            let mut bytes = 0;
            for row in rows {
                let item = json!({"tag":row.map_err(|_|"Cannot read local tag")?,"count":null});
                bytes += serde_json::to_vec(&item).map_err(|_| "Invalid local tag")?.len() + 1;
                if items.len() == TAG_LIMIT || bytes > TAG_BYTES {
                    return Err("Saved tag inventory exceeds its response limit".into());
                }
                items.push(item);
            }
            if items.is_empty() && !complete {
                return Ok(None);
            }
            return Ok(Some(Page {
                total: items.len() as i64,
                items,
                cached_at: super::catalogue::now(),
                complete,
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
            condition=format!("id IN(SELECT id FROM plex_catalogue_browse_tags WHERE scope=?1 AND kind='{kind}' AND resource='{tag}' AND removed=0 AND tag=?2)");
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
            condition = "download_album=?2".into();
            let id = strarg(0)
                .and_then(|s| s.parse::<i64>().ok())
                .ok_or("Invalid parent ID")?;
            bindings.push(json!(id));
            limit = 1000000;
            order = if kind == "track" {
                "CAST(json_extract(CASE WHEN listing_saved_at>saved_at THEN json_patch(document,json_remove(listing,'$.Media','$.Guid')) ELSE document END,'$.parentIndex') AS INTEGER),CAST(json_extract(CASE WHEN listing_saved_at>saved_at THEN json_patch(document,json_remove(listing,'$.Media','$.Guid')) ELSE document END,'$.index') AS INTEGER),id"
            } else {
                "json_extract(CASE WHEN listing_saved_at>saved_at THEN json_patch(document,json_remove(listing,'$.Media','$.Guid')) ELSE document END,'$.year') DESC,title COLLATE NOCASE,id"
            };
            if kind == "album" {
                if let Some(format) = strarg(1).filter(|s| !s.is_empty()) {
                    let (negate, format) = format
                        .strip_prefix('!')
                        .map(|s| (true, s))
                        .unwrap_or((false, format));
                    condition=format!("({condition}) AND {} EXISTS(SELECT 1 FROM json_each(json_extract(CASE WHEN listing_saved_at>saved_at THEN json_patch(document,json_remove(listing,'$.Media','$.Guid')) ELSE document END,'$.Format')) WHERE json_extract(value,'$.tag') IN (SELECT value FROM json_each(?3)))",if negate{"NOT"}else{""});
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
            condition = "download_artist=?2".into();
            bindings.push(json!(id));
            limit = if method == "getArtistTracks" {
                1000000
            } else {
                intarg(1, 100).clamp(1, 500)
            };
            order = if method == "getArtistTracks" {
                "json_extract(CASE WHEN listing_saved_at>saved_at THEN json_patch(document,json_remove(listing,'$.Media','$.Guid')) ELSE document END,'$.parentTitle') COLLATE NOCASE,CAST(json_extract(CASE WHEN listing_saved_at>saved_at THEN json_patch(document,json_remove(listing,'$.Media','$.Guid')) ELSE document END,'$.parentIndex') AS INTEGER),CAST(json_extract(CASE WHEN listing_saved_at>saved_at THEN json_patch(document,json_remove(listing,'$.Media','$.Guid')) ELSE document END,'$.index') AS INTEGER),id"
            } else {
                "CAST(json_extract(CASE WHEN listing_saved_at>saved_at THEN json_patch(document,json_remove(listing,'$.Media','$.Guid')) ELSE document END,'$.ratingCount') AS INTEGER) DESC,id"
            };
        }
        "getLikedTracks" | "getLikedAlbums" | "getLikedArtists" => {
            kind = match method {
                "getLikedAlbums" => "album",
                "getLikedArtists" => "artist",
                _ => "track",
            };
            condition = "user_rating>0".into();
            limit = 1000000;
            order = "last_rated_at DESC,id";
        }
        "getRecentlyAdded" => {
            kind = match strarg(0) {
                Some("artist") => "artist",
                Some("album") | None => "album",
                Some("track") => "track",
                _ => return Ok(None),
            };
            limit = intarg(1, 50);
            order = "added_at DESC,id";
        }
        "getLatestReleases" => {
            kind = "album";
            limit = intarg(0, 30).clamp(1, 50);
            condition = "released_on IS NULL OR released_on<=date('now')".into();
            order = "released_on DESC,id";
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
    let count_sql = if method == "getLatestReleases" {
        RELEASE_COUNT_SQL.to_owned()
    } else {
        format!("SELECT COUNT(*) FROM {source} WHERE {filter}")
    };
    let total: i64 = conn
        .query_row(
            &count_sql,
            rusqlite::params_from_iter(&sqlvalues),
            |r| r.get(0),
        )
        .map_err(|_| "Cannot count catalogue items")?;
    if total == 0 && !complete {
        return Ok(None);
    }
    let sql = if uses_projection {
        projection_page_sql(&filter, order, limit, offset)
    } else {
        format!("SELECT kind,{DOCUMENT},max(saved_at,listing_saved_at) FROM {source} WHERE {filter} ORDER BY {order} LIMIT {limit} OFFSET {offset}")
    };
    let mut statement = conn.prepare(&sql).map_err(|_| "Cannot query catalogue")?;
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
    if method == "getPlaylists" {
        let ids = items.iter().filter_map(|item| item["rating_key"].as_i64()).collect::<Vec<_>>();
        let counts = published_playlist_counts(conn, scope, &ids)?;
        for item in &mut items {
            if let Some((count, saved)) = item["rating_key"].as_i64().and_then(|id| counts.get(&id)) {
                item["leaf_count"] = json!(count);
                cached_at = cached_at.max(*saved);
            }
        }
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
    let end = offset.checked_add(limit).ok_or("Invalid playlist page")?;
    let published:Option<(String,i64,i64)>=conn.query_row("SELECT generation,total,saved_at FROM plex_catalogue_playlist_versions WHERE scope=?1 AND playlist_id=?2",params![scope,id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|_|"Cannot read playlist version")?;
    let Some((generation, total, cached_at)) = published else {
        return Ok(None);
    };
    if total < 0 {
        return Err("Invalid published playlist coverage".into());
    }
    let invalidated:Option<i64>=conn.query_row("SELECT invalidated_at FROM plex_catalogue_invalidations WHERE scope=?1 AND method='getPlaylistItems'",[scope],|r|r.get(0)).optional().map_err(|_|"Cannot verify playlist freshness")?;
    if invalidated.is_some_and(|at| cached_at <= at) {
        return Ok(None);
    }
    let mut stmt = conn.prepare(PLAYLIST_PAGE_SQL).map_err(|_| "Cannot read playlist catalogue")?;
    let rows = stmt
        .query_map(params![scope, id, generation, offset, end.min(total)], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?))
        })
        .map_err(|_| "Cannot read playlist catalogue")?;
    let mut items = vec![];
    let mut bytes = 0;
    for row in rows {
        let (position, member, full) = row.map_err(|_| "Cannot read playlist catalogue")?;
        if position != offset + items.len() as i64 {
            return Err("Invalid published playlist coverage".into());
        }
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
    if items.len() as i64 != total.saturating_sub(offset).clamp(0, limit) {
        return Err("Incomplete published playlist coverage".into());
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
    fn fixture() -> (Connection, String) {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        (conn, format!("plex-{}", "a".repeat(64)))
    }
    fn mark_complete(conn: &Connection, scope: &str, kind: &str) {
        let task = crate::db::catalogue_sync::begin(conn, scope, kind, None).unwrap();
        crate::db::catalogue_sync::checkpoint(conn, scope, &task, 0, Some(0), true).unwrap();
    }
    fn ids(page: Page) -> Vec<i64> {
        page.items
            .iter()
            .map(|item| item["rating_key"].as_i64().unwrap())
            .collect()
    }
    #[test]
    fn large_local_tag_inventory_preserves_full_searchable_coverage_and_empty_results() {
        let (conn, scope) = fixture();
        let other = format!("plex-{}", "b".repeat(64));
        let tags = (0..10_002).map(|n| json!({"tag":format!("Genre {n:05}")})).collect::<Vec<_>>();
        let raw = json!({"type":"track","ratingKey":1,"title":"Tagged","Genre":tags});
        crate::db::catalogue::save(&conn, &scope, "track", 1, &raw, true).unwrap();
        crate::db::catalogue::save(&conn, &other, "track", 2, &json!({"type":"track","ratingKey":2,"Genre":[{"tag":"Foreign"}]}), true).unwrap();
        let partial = query(&conn, &scope, "getTags", &[json!("genre")]).unwrap().unwrap();
        assert_eq!(partial.items.len(), 10_002);
        assert!(!partial.complete);
        for kind in ["artist", "album", "track"] {
            let task = crate::db::catalogue_sync::begin(&conn, &scope, kind, None).unwrap();
            crate::db::catalogue_sync::checkpoint(&conn, &scope, &task, 0, Some(0), true).unwrap();
        }
        let complete = query(&conn, &scope, "getTags", &[json!("genre")]).unwrap().unwrap();
        assert!(complete.complete);
        assert_eq!(complete.total, 10_002);
        assert_eq!(complete.items.last().unwrap()["tag"], "Genre 10001");
        assert_eq!(crate::db::catalogue::get(&conn, &scope, "track", 1).unwrap().unwrap(), raw);
        conn.execute("UPDATE plex_catalogue SET removed=1 WHERE scope=?1", [&scope]).unwrap();
        let empty = query(&conn, &scope, "getTags", &[json!("genre")]).unwrap().unwrap();
        assert!(empty.complete);
        assert!(empty.items.is_empty());
        conn.execute("UPDATE plex_catalogue_tasks SET status='running' WHERE scope=?1 AND task='track'", [&scope]).unwrap();
        assert!(query(&conn, &scope, "getTags", &[json!("genre")]).unwrap().is_none());
    }
    #[test]
    fn tag_inventory_bounds_encoded_bytes_including_escaped_text() {
        let (conn, scope) = fixture();
        let escaped = "\u{1}".repeat(TAG_BYTES / 6 + 1);
        conn.execute("INSERT INTO plex_catalogue_browse_tags(scope,kind,id,resource,tag,removed) VALUES(?1,'track',1,'Genre',?2,0)", params![scope, escaped]).unwrap();
        assert_eq!(query(&conn, &scope, "getTags", &[json!("genre")]).err().as_deref(), Some("Saved tag inventory exceeds its response limit"));
    }
    #[test]
    fn playlist_roster_counts_use_fresh_published_occurrences_and_preserve_server_archive() {
        let (conn, scope) = fixture();
        let other = format!("plex-{}", "b".repeat(64));
        let original = json!({"type":"playlist","ratingKey":7,"title":"Smart playlist","leafCount":97,"smart":true});
        crate::db::catalogue::save(&conn, &scope, "playlist", 7, &original, true).unwrap();
        crate::db::catalogue::save(&conn, &scope, "playlist", 8, &json!({"type":"playlist","ratingKey":8,"title":"Unpublished","leafCount":12}), true).unwrap();
        let task = crate::db::catalogue_sync::begin(&conn, &scope, "playlist:7", Some("verified")).unwrap();
        let members = vec![json!({"type":"track","ratingKey":42,"playlistItemID":1}),json!({"type":"track","ratingKey":42,"playlistItemID":2})];
        crate::db::catalogue_sync::playlist_page(&conn, &scope, 7, &task, &members, Some(2), true).unwrap();
        conn.execute("UPDATE plex_catalogue_playlist_versions SET saved_at=200 WHERE scope=?1", [&scope]).unwrap();
        conn.execute("INSERT INTO plex_catalogue_playlist_versions(scope,playlist_id,generation,total,saved_at) VALUES(?1,7,'foreign',999,300)", [&other]).unwrap();
        // In-flight staging must not inflate a verified count, even when it
        // contains more occurrences than the last complete publication.
        let next = crate::db::catalogue_sync::begin(&conn, &scope, "playlist:7", Some("staging")).unwrap();
        crate::db::catalogue_sync::playlist_page(&conn, &scope, 7, &next, &members, Some(3), false).unwrap();
        assert_eq!(published_playlist_counts(&conn, &scope, &[7,8]).unwrap().get(&7), Some(&(2,200)));
        let page = query(&conn, &scope, "getPlaylists", &[]).unwrap().unwrap();
        assert_eq!(page.items.iter().find(|p| p["rating_key"] == 7).unwrap()["leaf_count"], 2);
        assert_eq!(page.items.iter().find(|p| p["rating_key"] == 8).unwrap()["leaf_count"], 12);
        assert_eq!(crate::db::catalogue::get(&conn, &scope, "playlist", 7).unwrap().unwrap(), original);
        conn.execute("INSERT INTO plex_catalogue_invalidations(scope,method,invalidated_at) VALUES(?1,'getPlaylistItems',200)", [&scope]).unwrap();
        assert!(published_playlist_counts(&conn, &scope, &[7]).unwrap().is_empty());
        let stale = query(&conn, &scope, "getPlaylists", &[]).unwrap().unwrap();
        assert_eq!(stale.items.iter().find(|p| p["rating_key"] == 7).unwrap()["leaf_count"], 97);
        conn.execute("UPDATE plex_catalogue_playlist_versions SET saved_at=201,total=0 WHERE scope=?1", [&scope]).unwrap();
        assert_eq!(published_playlist_counts(&conn, &scope, &[7]).unwrap().get(&7), Some(&(0,201)));
        assert!(published_playlist_counts(&conn, &scope, &[0]).is_err());
    }
    #[test]
    fn hot_shelves_and_tags_use_latest_listing_without_losing_full_private_media() {
        let (conn, scope) = fixture();
        let other = format!("plex-{}", "b".repeat(64));
        let full = json!({"type":"track","ratingKey":1,"title":"Original","userRating":0,"addedAt":10,"Genre":[{"tag":"Old"}],"Media":[{"id":7,"Part":[{"id":8,"file":"/private/native-only.flac","key":"/library/parts/8/file.flac","Stream":[{"id":9,"streamType":2,"gain":1.2}]}]}],"unknownFuture":{"keep":true}});
        crate::db::catalogue::save(&conn, &scope, "track", 1, &full, true).unwrap();
        let listing = json!({"type":"track","ratingKey":1,"title":"Latest","userRating":3.5,"lastRatedAt":20,"addedAt":30,"Genre":[{"tag":"New"}],"Mood":[{"tag":"Calm"}],"Media":[{"id":7}]});
        conn.execute("UPDATE plex_catalogue SET listing=?2,listing_saved_at=saved_at+1 WHERE scope=?1 AND id=1",params![scope,listing.to_string()]).unwrap();
        let mut foreign = full.clone();
        foreign["ratingKey"] = json!(2);
        foreign["userRating"] = json!(5);
        foreign["addedAt"] = json!(999);
        crate::db::catalogue::save(&conn, &other, "track", 2, &foreign, true).unwrap();
        let liked = query(&conn, &scope, "getLikedTracks", &[])
            .unwrap()
            .unwrap();
        assert_eq!(liked.total, 1);
        assert_eq!(liked.items[0]["title"], "Latest");
        assert_eq!(
            liked.items[0]["media"][0]["parts"][0]["streams"][0]["id"],
            9
        );
        assert!(!liked.items[0].to_string().contains("/private/"));
        assert_eq!(
            ids(query(
                &conn,
                &scope,
                "getRecentlyAdded",
                &[json!("track"), json!(1)]
            )
            .unwrap()
            .unwrap()),
            vec![1]
        );
        let tags = query(&conn, &scope, "getTags", &[json!("genre")])
            .unwrap()
            .unwrap();
        assert_eq!(tags.items, vec![json!({"tag":"New","count":null})]);
        assert_eq!(
            ids(query(
                &conn,
                &scope,
                "getItemsByTag",
                &[
                    json!("mood"),
                    json!("Calm"),
                    json!("track"),
                    json!(10),
                    json!(0)
                ]
            )
            .unwrap()
            .unwrap()),
            vec![1]
        );
        assert_eq!(
            crate::db::catalogue::get(&conn, &scope, "track", 1)
                .unwrap()
                .unwrap(),
            full
        );
        conn.execute(
            "UPDATE plex_catalogue SET removed=1 WHERE scope=?1 AND id=1",
            [&scope],
        )
        .unwrap();
        assert!(query(&conn, &scope, "getTags", &[json!("genre")])
            .unwrap()
            .is_none());
        conn.execute(
            "DELETE FROM plex_catalogue WHERE scope=?1 AND id=1",
            [&scope],
        )
        .unwrap();
        assert_eq!(
            conn.query_row::<i64, _, _>(
                "SELECT COUNT(*) FROM plex_catalogue_browse_data WHERE scope=?1",
                [&scope],
                |r| r.get(0)
            )
            .unwrap(),
            0
        );
    }
    #[test]
    fn typed_renderer_cleaning_scrubs_credentials_urls_and_paths_without_changing_archive() {
        let (conn, scope) = fixture();
        for kind in ["track", "album", "artist", "playlist"] {
            let raw = json!({
                "type":kind,"ratingKey":42,"title":"Safe title",
                "key":"/library/metadata/42?X%2DPlex%2DToken=relative-token&sig=a%2Fb#keep",
                "thumb":"https://user:credential@example.test/art?Api_Key=url-secret&sig=a%2Fb#keep",
                "guid":"https://user:credential@example.test/reference?access_token=guid-secret&sig=a%2Fb#keep",
                "X-Plex-Token":"root-secret","authorization":"root-authorization",
                "future":{"keep":{"value":17},"password":"nested-secret"},
                "Guid":[{"id":"plex://track/native-guid","future":{"preserve":true},"token":"guid-array-secret"}],
                "Media":[
                    {"id":1,"future":{"preserve":true},"secret":"media-secret","Part":[{"id":8,"key":"/library/parts/8/file?token=part-secret","file":"/private/native-only.flac","Stream":[{"id":9,"streamType":2,"gain":-8.2,"key":"/library/streams/9?authorization=stream-secret&sig=a%2Fb","future":{"preserve":true},"apiKey":"nested-stream-secret"}]}]},
                    {"id":2,"Part":[{"id":18,"file":"/private/alternate.flac","key":"/library/parts/18/file","Stream":[{"id":19,"streamType":2,"gain":1.2}]}]}
                ]
            });
            crate::db::catalogue::save(&conn, &scope, kind, 42, &raw, true).unwrap();
            let before = crate::db::catalogue::get(&conn, &scope, kind, 42).unwrap().unwrap();
            // Project an unsanitized source as an additional privacy check;
            // production reads use the already-clean private archive.
            let dto = project(kind, raw).unwrap();
            assert_eq!(dto["key"], "/library/metadata/42?sig=a%2Fb#keep");
            assert_eq!(dto["thumb"], "https://example.test/art?sig=a%2Fb#keep");
            assert_eq!(dto["guid"], "https://example.test/reference?sig=a%2Fb#keep");
            let encoded = dto.to_string();
            for forbidden in ["secret", "credential", "/private/", "X-Plex-Token", "authorization", "password", "future", "Guid"] {
                assert!(!encoded.contains(forbidden), "Renderer retained {forbidden} for {kind}");
            }
            if kind == "track" {
                assert_eq!(dto["media"].as_array().unwrap().len(), 2);
                assert_eq!(dto["media"][0]["parts"][0]["key"], "");
                assert!(dto["media"][0]["parts"][0].get("file").is_none());
                assert_eq!(dto["media"][0]["parts"][0]["streams"][0]["gain"], -8.2);
                assert_eq!(dto["media"][0]["parts"][0]["streams"][0]["key"], "/library/streams/9?sig=a%2Fb");
            }
            assert_eq!(crate::db::catalogue::get(&conn, &scope, kind, 42).unwrap().unwrap(), before);
            assert_eq!(before["future"]["keep"]["value"], 17);
            assert_eq!(before["Guid"][0]["future"]["preserve"], true);
            assert_eq!(before["Media"][0]["Part"][0]["file"], "/private/native-only.flac");
            assert_eq!(before["Media"][0]["Part"][0]["Stream"][0]["future"]["preserve"], true);
        }
    }
    #[test]
    fn renderer_projection_retains_depth_and_public_payload_bounds() {
        let mut deep = json!("unknown");
        for _ in 0..49 {
            deep = json!({"child":deep});
        }
        assert!(project("track", json!({"type":"track","ratingKey":1,"future":deep})).is_err());
        assert!(project("track", json!({"type":"track","ratingKey":1,"title":"x".repeat(16*1024*1024)})).is_err());
        assert!(project("track", json!({"type":"track","ratingKey":1,"future":"x".repeat(16*1024*1024)})).is_err());
        // Raw byte length alone undercounts heavily escaped ignored fields.
        assert!(project("track", json!({"type":"track","ratingKey":1,"future":"\"".repeat(8*1024*1024)})).is_err());
        assert!(project("track", json!({"type":"track","ratingKey":1,"future":"x".repeat(3*1024*1024)})).is_ok());
    }
    #[test]
    fn indexed_ancestry_honors_numeric_ids_native_keys_and_latest_disc_format_order() {
        let (conn, scope) = fixture();
        mark_complete(&conn, &scope, "track");
        mark_complete(&conn, &scope, "album");
        for (id, disc, index) in [(1, 2, 1), (2, 1, 5), (3, 1, 1)] {
            let raw = json!({"type":"track","ratingKey":id,"title":format!("Track {id}"),"parentKey":"/library/metadata/7","grandparentKey":"/library/metadata/8","parentIndex":disc,"index":index,"ratingCount":id});
            crate::db::catalogue::save(&conn, &scope, "track", id, &raw, true).unwrap();
        }
        assert_eq!(
            ids(query(&conn, &scope, "getAlbumTracks", &[json!("7")])
                .unwrap()
                .unwrap()),
            vec![3, 2, 1]
        );
        conn.execute("UPDATE plex_catalogue SET listing=?2,listing_saved_at=saved_at+1 WHERE scope=?1 AND id=1",params![scope,json!({"type":"track","ratingKey":1,"parentRatingKey":"9","parentKey":"/library/metadata/9","grandparentRatingKey":"10","grandparentKey":"/library/metadata/10","parentIndex":1,"index":0,"ratingCount":99}).to_string()]).unwrap();
        assert_eq!(
            ids(query(&conn, &scope, "getAlbumTracks", &[json!("7")])
                .unwrap()
                .unwrap()),
            vec![3, 2]
        );
        assert_eq!(
            ids(query(
                &conn,
                &scope,
                "getArtistPopularTracks",
                &[json!("10"), json!(10)]
            )
            .unwrap()
            .unwrap()),
            vec![1]
        );
        for id in [11, 12] {
            crate::db::catalogue::save(&conn,&scope,"album",id,&json!({"type":"album","ratingKey":id,"title":format!("Album {id}"),"parentKey":"/library/metadata/8","year":2000}),true).unwrap();
        }
        conn.execute("UPDATE plex_catalogue SET listing=?2,listing_saved_at=saved_at+1 WHERE scope=?1 AND id=12",params![scope,json!({"type":"album","ratingKey":12,"year":2020,"Format":[{"tag":"Single"}]}).to_string()]).unwrap();
        assert_eq!(
            ids(query(
                &conn,
                &scope,
                "getArtistAlbumsInSection",
                &[json!("8"), json!("Single")]
            )
            .unwrap()
            .unwrap()),
            vec![12]
        );
        assert_eq!(
            ids(
                query(&conn, &scope, "getArtistAlbumsInSection", &[json!("8")])
                    .unwrap()
                    .unwrap()
            ),
            vec![12, 11]
        );
    }
    #[test]
    fn bounded_scope_projection_backfill_resumes_and_covers_new_changes_without_writing_raw() {
        let conn = Connection::open_in_memory().unwrap();
        for sql in [
            include_str!("migrations/V1__initial.sql"),
            include_str!("migrations/V2__offline_snapshots.sql"),
            include_str!("migrations/V3__semantic_vectors.sql"),
            include_str!("migrations/V4__local_audio.sql"),
            include_str!("migrations/V5__plex_catalogue.sql"),
            include_str!("migrations/V6__catalogue_sync.sql"),
            include_str!("migrations/V7__download_entities.sql"),
            include_str!("migrations/V8__catalogue_incremental.sql"),
        ] {
            conn.execute_batch(sql).unwrap();
        }
        let scope = format!("plex-{}", "a".repeat(64));
        let other = format!("plex-{}", "b".repeat(64));
        for id in [1, 2, 3] {
            crate::db::catalogue::save(&conn,&scope,"track",id,&json!({"type":"track","ratingKey":id,"title":format!("Track {id}"),"addedAt":id,"Genre":[{"tag":"Existing"}],"future":{"keep":true}}),true).unwrap();
        }
        crate::db::catalogue::save(
            &conn,
            &other,
            "track",
            4,
            &json!({"type":"track","ratingKey":4,"title":"Other"}),
            true,
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 8).unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        assert!(!projections_ready(&conn, &scope).unwrap());
        assert!(query(&conn, &scope, "getRecentlyAdded", &[json!("track")])
            .unwrap()
            .is_none());
        let original = crate::db::catalogue::get(&conn, &scope, "track", 2)
            .unwrap()
            .unwrap();
        assert!(!backfill_projections(&conn, &scope, 1).unwrap());
        assert_eq!(
            conn.query_row::<i64, _, _>(
                "SELECT COUNT(*) FROM plex_catalogue_browse_data WHERE scope=?1",
                [&scope],
                |r| r.get(0)
            )
            .unwrap(),
            1
        );
        crate::db::catalogue::save(&conn,&scope,"artist",9,&json!({"type":"artist","ratingKey":9,"title":"Concurrent arrival","Genre":[{"tag":"New"}]}),true).unwrap();
        conn.execute("UPDATE plex_catalogue SET listing=?2,listing_saved_at=saved_at+1 WHERE scope=?1 AND id=3",params![scope,json!({"type":"track","ratingKey":3,"addedAt":100,"Genre":[{"tag":"Updated"}]}).to_string()]).unwrap();
        let mut batches = 0;
        while !backfill_projections(&conn, &scope, 1).unwrap() {
            batches += 1;
            assert!(batches < 10)
        }
        assert!(projections_ready(&conn, &scope).unwrap());
        assert!(!projections_ready(&conn, &other).unwrap());
        assert_eq!(
            crate::db::catalogue::get(&conn, &scope, "track", 2)
                .unwrap()
                .unwrap(),
            original
        );
        assert_eq!(
            ids(query(
                &conn,
                &scope,
                "getRecentlyAdded",
                &[json!("track"), json!(1)]
            )
            .unwrap()
            .unwrap()),
            vec![3]
        );
        let tags = query(&conn, &scope, "getTags", &[json!("genre")])
            .unwrap()
            .unwrap();
        assert_eq!(tags.items.len(), 3);
        assert_eq!(
            conn.query_row::<i64, _, _>(
                "SELECT COUNT(*) FROM plex_catalogue_browse_data WHERE scope=?1",
                [&scope],
                |r| r.get(0)
            )
            .unwrap(),
            4
        );
        assert!(backfill_projections(&conn, &scope, 0).is_err());
        assert!(backfill_projections(&conn, &scope, 201).is_err());
    }
    #[test]
    fn hot_query_plans_select_indexed_page_before_reading_private_documents() {
        let (conn, scope) = fixture();
        let plan = |sql: &str| {
            let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
            stmt.query_map([&scope], |r| r.get::<_, String>(3))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
                .join("\n")
        };
        let recent = plan(&projection_page_sql(
            "scope=?1 AND kind='album' AND removed=0",
            "added_at DESC,id",
            50,
            0,
        ));
        assert!(recent.contains("MATERIALIZE page"));
        assert!(recent.contains("plex_catalogue_browse_recent"));
        assert!(recent.contains("sqlite_autoindex_plex_catalogue_1"));
        let liked = plan(&projection_page_sql(
            "scope=?1 AND kind='track' AND removed=0 AND user_rating>0",
            "last_rated_at DESC,id",
            100,
            0,
        ));
        assert!(liked.contains("plex_catalogue_browse_liked"));
        let releases=plan(&projection_page_sql("scope=?1 AND kind='album' AND removed=0 AND (released_on IS NULL OR released_on<=date('now'))","released_on DESC,id",30,0));
        assert!(releases.contains("plex_catalogue_browse_release"));
        assert!(plan("SELECT DISTINCT tag FROM plex_catalogue_browse_tags WHERE scope=?1 AND resource='Genre' AND removed=0 ORDER BY tag COLLATE NOCASE LIMIT 10001").contains("COVERING INDEX plex_catalogue_browse_tag_inventory"));
        assert!(plan("SELECT id FROM plex_catalogue WHERE scope=?1 AND kind='track' AND removed=0 AND download_album=7").contains("plex_catalogue_download_album"));
        assert!(plan("SELECT id FROM plex_catalogue WHERE scope=?1 AND kind='track' AND removed=0 AND download_artist=8").contains("plex_catalogue_download_artist"));
    }
    #[test]
    fn release_count_uses_disjoint_index_ranges_and_keeps_scope_date_removal_semantics() {
        let (conn, scope) = fixture();
        let other = format!("plex-{}", "b".repeat(64));
        mark_complete(&conn, &scope, "album");
        for (id, date) in [(1, Some("2000-01-01")), (2, None), (3, Some("invalid")), (4, Some("9999-12-31")), (5, Some("2001-01-01"))] {
            crate::db::catalogue::save(&conn, &scope, "album", id, &json!({"type":"album","ratingKey":id,"title":format!("Album {id}"),"originallyAvailableAt":date}), true).unwrap();
        }
        crate::db::catalogue::save(&conn, &other, "album", 6, &json!({"type":"album","ratingKey":6,"originallyAvailableAt":"2000-01-01"}), true).unwrap();
        conn.execute("UPDATE plex_catalogue SET removed=1 WHERE scope=?1 AND id=5", [&scope]).unwrap();
        let page = query(&conn, &scope, "getLatestReleases", &[json!(1)]).unwrap().unwrap();
        assert_eq!(page.total, 3);
        assert_eq!(ids(page), vec![1]);
        // New listing dates must change both count and page without losing the
        // archived full document. Invalid and absent dates remain included.
        conn.execute("UPDATE plex_catalogue SET listing=?2,listing_saved_at=saved_at+1 WHERE scope=?1 AND id=4", params![scope,json!({"originallyAvailableAt":"2002-01-01"}).to_string()]).unwrap();
        let page = query(&conn, &scope, "getLatestReleases", &[json!(10)]).unwrap().unwrap();
        assert_eq!(page.total, 4);
        assert_eq!(ids(page), vec![4, 1, 2, 3]);
        let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {RELEASE_COUNT_SQL}")).unwrap();
        let plan = stmt.query_map([&scope], |r| r.get::<_, String>(3)).unwrap().collect::<Result<Vec<_>, _>>().unwrap().join("\n");
        assert_eq!(plan.matches("plex_catalogue_browse_release").count(), 2);
        assert!(plan.contains("released_on=?"));
        assert!(plan.contains("released_on<?"));
        assert!(!plan.contains("plex_catalogue_browse_recent"));
    }
    #[test]
    fn published_playlist_pages_seek_positions_bound_overflow_and_reject_broken_coverage() {
        let (conn, scope) = fixture();
        let task = crate::db::catalogue_sync::begin(&conn, &scope, "playlist:7", Some("finite")).unwrap();
        let members = (0..2000).map(|n| json!({"type":"track","ratingKey":42,"playlistItemID":n+1000,"title":"Repeated track"})).collect::<Vec<_>>();
        crate::db::catalogue_sync::playlist_page(&conn, &scope, 7, &task, &members, Some(2000), true).unwrap();
        let page = query(&conn, &scope, "getPlaylistItems", &[json!("7"),json!(1998),json!(200)]).unwrap().unwrap();
        assert_eq!(page.total, 2000);
        assert_eq!(page.items.iter().map(|item| item["playlist_item_id"].as_i64().unwrap()).collect::<Vec<_>>(), vec![2998,2999]);
        assert!(query(&conn, &scope, "getPlaylistItems", &[json!("7"),json!(2000),json!(200)]).unwrap().unwrap().items.is_empty());
        assert!(query(&conn, &scope, "getPlaylistItems", &[json!("7"),json!(i64::MAX),json!(1)]).is_err());
        let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {PLAYLIST_PAGE_SQL}")).unwrap();
        let plan = stmt.query_map(params![scope,7,"finite",1998,2000], |r| r.get::<_, String>(3)).unwrap().collect::<Result<Vec<_>, _>>().unwrap().join("\n");
        assert!(plan.contains("MATERIALIZE page"));
        assert!(plan.contains("position>? AND position<?"));
        // A corrupted or foreign sparse publication must fail honestly, rather
        // than treating its ordinal offset as a valid complete position page.
        conn.execute("DELETE FROM plex_catalogue_playlist_members WHERE scope=?1 AND playlist_id=7 AND generation='finite' AND position=1998", [&scope]).unwrap();
        assert!(query(&conn, &scope, "getPlaylistItems", &[json!("7"),json!(1998),json!(200)]).is_err());
    }
    #[test]
    fn completed_incremental_window_reconciles_browse_and_children_but_not_playlist_publication() {
        let (conn, scope) = fixture();
        crate::db::catalogue::save(&conn, &scope, "track", 1, &json!({"type":"track","ratingKey":1,"parentRatingKey":7,"title":"Local track"}), true).unwrap();
        for kind in ["artist", "album", "track", "playlist"] {
            mark_complete(&conn, &scope, kind);
        }
        conn.execute("UPDATE plex_catalogue_tasks SET completed_at=100 WHERE scope=?1", [&scope]).unwrap();
        for method in ["getAllTracks", "getAlbumTracks", "getPlaylistItems"] {
            conn.execute("INSERT INTO plex_catalogue_invalidations(scope,method,invalidated_at) VALUES(?1,?2,500)", params![scope,method]).unwrap();
        }
        conn.execute("INSERT INTO plex_catalogue_playlist_versions(scope,playlist_id,generation,total,saved_at) VALUES(?1,7,'old',0,400)", [&scope]).unwrap();
        assert!(query(&conn, &scope, "getAllTracks", &[json!(0),json!(200)]).unwrap().is_none());
        assert!(query(&conn, &scope, "getAlbumTracks", &[json!("7")]).unwrap().is_none());
        for kind in ["artist", "album", "track", "playlist"] {
            mark_complete(&conn, &scope, &format!("catchup:{kind}"));
        }
        conn.execute("UPDATE plex_catalogue_tasks SET upper_time=2 WHERE scope=?1 AND task LIKE 'catchup:%'", [&scope]).unwrap();
        conn.execute("INSERT INTO plex_catalogue_incremental(scope,watermark,catchup_started,catchup_requested) VALUES(?1,2,1000,1)", [&scope]).unwrap();
        assert_eq!(ids(query(&conn, &scope, "getAllTracks", &[json!(0),json!(200)]).unwrap().unwrap()), vec![1]);
        assert_eq!(ids(query(&conn, &scope, "getAlbumTracks", &[json!("7")]).unwrap().unwrap()), vec![1]);
        assert!(query(&conn, &scope, "getPlaylistItems", &[json!("7"),json!(0),json!(200)]).unwrap().is_none());
        // A later mutation and an unresolved admitted update retain the guard.
        conn.execute("UPDATE plex_catalogue_invalidations SET invalidated_at=1500 WHERE scope=?1 AND method='getAllTracks'", [&scope]).unwrap();
        assert!(query(&conn, &scope, "getAllTracks", &[json!(0),json!(200)]).unwrap().is_none());
        crate::db::catalogue_incremental::enqueue(&conn, &scope, "track", 1, 5).unwrap();
        assert!(query(&conn, &scope, "getAlbumTracks", &[json!("7")]).unwrap().is_none());
    }
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
