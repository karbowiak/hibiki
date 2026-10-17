use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
mod query;

#[derive(Clone, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Request {
    Info {
        key: String,
    },
    Page {
        key: String,
        offset: i64,
        limit: i64,
    },
    Index { key: String, offset: i64, limit: i64 },
    Query {
        key: String,
        offset: i64,
        limit: i64,
        filter: String,
        sort: String,
        dir: String,
    },
    QueryRefs {
        key: String,
        filter: String,
        sort: String,
        dir: String,
    },
    Pick {
        key: String,
        positions: Vec<i64>,
    },
    Refs {
        key: String,
    },
    Items {
        key: String,
        ids: Vec<String>,
    },
    Begin {
        key: String,
        stamp: String,
    },
    Put {
        key: String,
        generation: i64,
        offset: i64,
        total: i64,
        items: Vec<Value>,
    },
    Commit {
        key: String,
        generation: i64,
    },
    Invalidate {
        key: String,
    },
    Rate {
        key: String,
        id: String,
        rating: Option<f64>,
    },
}
impl Request {
    pub fn read_only(&self) -> bool {
        matches!(
            self,
            Self::Info { .. }
                | Self::Index { .. }
                | Self::Page { .. }
                | Self::Query { .. }
                | Self::QueryRefs { .. }
                | Self::Pick { .. }
                | Self::Refs { .. }
                | Self::Items { .. }
        )
    }
    fn key(&self) -> &str {
        match self {
            Self::Info { key }
            | Self::Index { key, .. }
            | Self::Page { key, .. }
            | Self::Query { key, .. }
            | Self::QueryRefs { key, .. }
            | Self::Pick { key, .. }
            | Self::Refs { key }
            | Self::Items { key, .. }
            | Self::Begin { key, .. }
            | Self::Put { key, .. }
            | Self::Commit { key, .. }
            | Self::Invalidate { key }
            | Self::Rate { key, .. } => key,
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Info {
    total: i64,
    cached_at: i64,
    complete: bool,
    dirty: bool,
    stamp: String,
    refreshing: bool,
}
fn sql<T>(result: rusqlite::Result<T>) -> Result<T, String> {
    result.map_err(|_| "Collection cache is unavailable".into())
}
fn valid_key(key: &str) -> bool {
    matches!(
        key,
        "playlists" | "rated:track" | "rated:album" | "rated:artist"
    ) || key
        .strip_prefix("mix:")
        .is_some_and(|id| id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()))
        || key.strip_prefix("playlist:").is_some_and(|id| {
            !id.is_empty() && id.len() < 24 && id.bytes().all(|b| b.is_ascii_digit())
        })
}
fn metadata(
    conn: &Connection,
    scope: &str,
    key: &str,
) -> Result<Option<(Option<i64>, i64, i64, bool)>, String> {
    sql(conn.query_row("SELECT active_generation,total,cached_at,dirty FROM collection_cache WHERE scope=?1 AND key=?2",params![scope,key],|r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional())
}
fn item_at(
    conn: &Connection,
    scope: &str,
    key: &str,
    generation: i64,
    position: i64,
) -> Result<Option<Value>, String> {
    let row:Option<(String,Option<String>)>=sql(sql(conn.prepare_cached("SELECT i.payload,m.occurrence FROM collection_cache_members m JOIN collection_cache_items i ON i.scope=m.scope AND i.kind=m.kind AND i.id=m.item_id WHERE m.scope=?1 AND m.key=?2 AND m.generation=?3 AND m.position=?4"))?.query_row(params![scope,key,generation,position],|r|Ok((r.get(0)?,r.get(1)?))).optional())?;
    row.map(|(payload, occurrence)| {
        let mut item: Value =
            serde_json::from_str(&payload).map_err(|_| "Saved collection item is invalid")?;
        if let Some(id) = occurrence {
            item["playlistItemId"] = json!(id)
        };
        Ok(item)
    })
    .transpose()
}

fn query_order(sort: &str, dir: &str) -> Result<String, String> {
    let field = match sort {
        "default" => None,
        "title" => Some("title"),
        "artist" => Some("artistName"),
        "album" => Some("albumName"),
        "year" => Some("year"),
        "plays" => Some("playCount"),
        "views" => Some("viewCount"),
        "popularity" => Some("ratingCount"),
        "label" => Some("parentStudio"),
        "bitrate" => Some("bitrate"),
        "format" => Some("codec"),
        "added_at" => Some("addedAt"),
        "rating" => Some("userRating"),
        "rated_at" => Some("lastRatedAt"),
        "duration" => Some("duration"),
        _ => return Err("Unsupported collection order".into()),
    };
    let direction = match dir {
        "desc" => "DESC",
        "asc" => "ASC",
        _ => return Err("Invalid collection direction".into()),
    };
    Ok(field.map(|field| format!("json_extract(i.payload,'$.{field}') IS NULL ASC,json_extract(i.payload,'$.{field}') COLLATE NOCASE {direction},m.position ASC")).unwrap_or("m.position ASC".into()))
}
const QUERY_FROM: &str = "FROM collection_cache_members m JOIN collection_cache_items i ON i.scope=m.scope AND i.kind=m.kind AND i.id=m.item_id WHERE m.scope=?1 AND m.key=?2 AND m.generation=?3 AND (?4='' OR instr(i.search_text,?4)>0)";

/// Mix order belongs to the complete membership, not to a page or play action.
/// Canonical identities keep metadata edits and upstream reordering from reseeding it.
fn order_mix_membership(
    conn: &Connection,
    scope: &str,
    key: &str,
    generation: i64,
) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    let mut members = {
        let mut statement = sql(conn.prepare("SELECT position,kind,item_id,occurrence FROM collection_cache_members WHERE scope=?1 AND key=?2 AND generation=?3"))?;
        let rows = sql(statement.query_map(params![scope, key, generation], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        }))?;
        sql(rows.collect::<rusqlite::Result<Vec<_>>>())?
    };
    members.sort_by(|a, b| (&a.1, &a.2, &a.3).cmp(&(&b.1, &b.2, &b.3)));
    let identities: Vec<_> = members
        .iter()
        .map(|(_, kind, id, occurrence)| (kind, id, occurrence))
        .collect();
    let seed = Sha256::digest(
        serde_json::to_vec(&identities).map_err(|_| "Cannot encode mix membership")?,
    );
    let mut order: Vec<_> = members
        .iter()
        .enumerate()
        .map(|(index, member)| {
            let mut hash = Sha256::new();
            hash.update(&seed);
            hash.update((index as u64).to_le_bytes());
            let rank: [u8; 32] = hash.finalize().into();
            (rank, member.0)
        })
        .collect();
    order.sort_unstable();
    // Free the positive position range before assigning the new permutation.
    sql(conn.execute("UPDATE collection_cache_members SET position=-position-1 WHERE scope=?1 AND key=?2 AND generation=?3", params![scope, key, generation]))?;
    let mut update = sql(conn.prepare("UPDATE collection_cache_members SET position=?5 WHERE scope=?1 AND key=?2 AND generation=?3 AND position=?4"))?;
    for (position, (_, old)) in order.iter().enumerate() {
        sql(update.execute(params![scope, key, generation, -old - 1, position as i64]))?;
    }
    Ok(())
}

pub fn clear(conn: &Connection, scope: &str) -> Result<(), String> {
    super::offline::check_identity(scope, "clear")?;
    for table in [
        "collection_cache_members",
        "collection_cache_items",
        "collection_cache",
    ] {
        sql(conn.execute(&format!("DELETE FROM {table} WHERE scope=?1"), [scope]))?;
    }
    Ok(())
}
pub fn run(conn: &Connection, scope: &str, request: &Request, now: i64) -> Result<Value, String> {
    let key = request.key();
    super::offline::check_identity(scope, key)?;
    if !valid_key(key) {
        return Err("Invalid collection cache key".into());
    }
    match request {
        Request::Info { .. } => {
            let Some((generation, total, cached_at, dirty)) = metadata(conn, scope, key)? else {
                return Ok(Value::Null);
            };
            let (stamp, revision): (String, i64) = sql(conn.query_row(
                "SELECT stamp,revision FROM collection_cache WHERE scope=?1 AND key=?2",
                params![scope, key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            ))?;
            Ok(json!(Info {
                total,
                cached_at,
                complete: generation.is_some(),
                dirty,
                stamp,
                refreshing: generation != Some(revision)
            }))
        }
        Request::Index { offset, limit, .. } => {
            if *offset < 0 || !(1..=500).contains(limit) || !matches!(key, "rated:track" | "rated:album") {
                return Err("Invalid collection index page".into());
            }
            let Some((Some(generation), total, _, false)) = metadata(conn, scope, key)? else { return Ok(Value::Null); };
            const FIELDS: &[&str] = &["id","type","title","artistId","artistName","albumId","albumName","albumYear","year","trackNumber","discNumber","trackCount","guid","duration","playCount","viewCount","userRating","ratingCount","parentStudio","addedAt","lastPlayedAt","lastRatedAt","codec","bitrate","bitDepth","samplingRate","channels"];
            let projection = FIELDS.iter().map(|field| format!("'{field}',json_extract(i.payload,'$.{field}')")).collect::<Vec<_>>().join(",");
            let mut stmt = sql(conn.prepare_cached(&format!("SELECT json_object({projection}) FROM collection_cache_members m JOIN collection_cache_items i ON i.scope=m.scope AND i.kind=m.kind AND i.id=m.item_id WHERE m.scope=?1 AND m.key=?2 AND m.generation=?3 AND m.position>=?4 ORDER BY m.position LIMIT ?5")))?;
            let rows = sql(stmt.query_map(params![scope,key,generation,offset,limit], |r| r.get::<_,String>(0)))?;
            let items = sql(rows.collect::<rusqlite::Result<Vec<_>>>())?.into_iter().map(|row| serde_json::from_str::<Value>(&row).map_err(|_| "Invalid collection index".to_string())).collect::<Result<Vec<_>,_>>()?;
            Ok(json!({"items":items,"total":total,"offset":offset,"generation":generation}))
        }
        Request::Page { offset, limit, .. } => {
            if *offset < 0 || !(1..=500).contains(limit) {
                return Err("Invalid collection cache page".into());
            }
            let Some((Some(generation), total, _, false)) = metadata(conn, scope, key)? else {
                return Ok(Value::Null);
            };
            let mut items = Vec::new();
            // Indexed point lookups stay bounded even for million-item collections.
            for position in *offset..(*offset + *limit).min(total) {
                let Some(item) = item_at(conn, scope, key, generation, position)? else {
                    return Ok(Value::Null);
                };
                items.push(item);
            }
            Ok(json!({"items":items,"total":total,"offset":offset}))
        }
        Request::Query {
            offset,
            limit,
            filter,
            sort,
            dir,
            ..
        } => {
            if *offset < 0 || !(1..=500).contains(limit) || filter.len() > 1024 {
                return Err("Invalid collection query".into());
            }
            let Some((Some(generation), total, _, false)) = metadata(conn, scope, key)? else {
                return Ok(Value::Null);
            };
            query_order(sort, dir)?;
            // The primary key seeks directly to deep default-order pages.
            if filter.is_empty() && sort == "default" {
                return run(
                    conn,
                    scope,
                    &Request::Page {
                        key: key.into(),
                        offset: *offset,
                        limit: *limit,
                    },
                    now,
                );
            }
            let refs = query::membership(conn, scope, key, generation, filter, sort, dir)?;
            let mut statement = sql(conn.prepare_cached(
                "SELECT payload FROM collection_cache_items WHERE scope=?1 AND kind=?2 AND id=?3",
            ))?;
            let mut items = Vec::new();
            for member in refs
                .iter()
                .skip((*offset).min(refs.len() as i64) as usize)
                .take(*limit as usize)
            {
                let payload: String =
                    sql(statement.query_row(params![scope, member.kind, member.id], |r| r.get(0)))?;
                let mut item: Value = serde_json::from_str(&payload)
                    .map_err(|_| "Saved collection item is invalid")?;
                if let Some(id) = &member.occurrence {
                    item["playlistItemId"] = json!(id);
                }
                items.push(item);
            }
            let total = if filter.is_empty() {
                total
            } else {
                refs.len() as i64
            };
            Ok(json!({"items":items,"total":total,"offset":offset}))
        }
        Request::QueryRefs {
            filter, sort, dir, ..
        } => {
            if filter.len() > 1024 {
                return Err("Invalid collection query".into());
            }
            let Some((Some(generation), _, _, false)) = metadata(conn, scope, key)? else {
                return Ok(Value::Null);
            };
            let refs = query::membership(conn, scope, key, generation, filter, sort, dir)?;
            Ok(json!(refs
                .iter()
                .filter(|member| member.kind == "track")
                .map(|member| (&member.id, &member.occurrence))
                .collect::<Vec<_>>()))
        }
        Request::Pick { positions, .. } => {
            if positions.len() > 500 || positions.iter().any(|p| *p < 0) {
                return Err("Invalid shuffled collection page".into());
            }
            let Some((Some(generation), total, _, false)) = metadata(conn, scope, key)? else {
                return Ok(Value::Null);
            };
            let mut items = Vec::new();
            for position in positions {
                if *position >= total {
                    return Ok(Value::Null);
                };
                let Some(item) = item_at(conn, scope, key, generation, *position)? else {
                    return Ok(Value::Null);
                };
                items.push(item);
            }
            Ok(json!({"items":items,"total":total}))
        }
        Request::Refs { .. } => {
            let Some((Some(generation), total, _, false)) = metadata(conn, scope, key)? else {
                return Ok(Value::Null);
            };
            let mut stmt=sql(conn.prepare("SELECT item_id,occurrence FROM collection_cache_members WHERE scope=?1 AND key=?2 AND generation=?3 ORDER BY position"))?;
            let refs = sql(stmt.query_map(params![scope, key, generation], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            }))?;
            let refs = sql(refs.collect::<rusqlite::Result<Vec<_>>>())?;
            if refs.len() as i64 != total {
                return Ok(Value::Null);
            }
            Ok(json!(refs))
        }
        Request::Items { ids, .. } => {
            if ids.len() > 500 || ids.iter().any(|id| id.len() > 128) {
                return Err("Invalid collection item page".into());
            }
            let kind = match key { "rated:album" => "album", "rated:artist" => "artist", _ => "track" };
            let mut stmt=sql(conn.prepare_cached("SELECT payload FROM collection_cache_items WHERE scope=?1 AND kind=?3 AND id=?2"))?;
            let mut items = Vec::new();
            for id in ids {
                let payload: Option<String> =
                    sql(stmt.query_row(params![scope, id, kind], |r| r.get(0)).optional())?;
                items.push(
                    payload
                        .map(|p| {
                            serde_json::from_str::<Value>(&p)
                                .map_err(|_| "Saved collection item is invalid")
                        })
                        .transpose()?,
                );
            }
            Ok(json!(items))
        }
        Request::Begin { stamp, .. } => super::atomic_upsert(conn, |conn| {
            if stamp.len() > 512 {
                return Err("Invalid collection revision".into());
            }
            sql(conn.execute(
                "INSERT OR IGNORE INTO collection_cache(scope,key) VALUES(?1,?2)",
                params![scope, key],
            ))?;
            let (revision,old_stamp,staged): (i64,String,i64)=sql(conn.query_row("SELECT revision,stamp,staged_count FROM collection_cache WHERE scope=?1 AND key=?2",params![scope,key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))))?;
            if &old_stamp == stamp && staged > 0 {
                return Ok(json!({"generation":revision,"offset":staged}));
            }
            sql(conn.execute("DELETE FROM collection_cache_members WHERE scope=?1 AND key=?2 AND generation!=COALESCE((SELECT active_generation FROM collection_cache WHERE scope=?1 AND key=?2),-1)",params![scope,key]))?;
            sql(conn.execute("UPDATE collection_cache SET revision=revision+1,stamp=?3,staged_count=0,staged_total=0,changed=0 WHERE scope=?1 AND key=?2",params![scope,key,stamp]))?;
            Ok(json!({"generation":revision+1,"offset":0}))
        }),
        Request::Put {
            generation,
            offset,
            total,
            items,
            ..
        } => super::atomic_upsert(conn, |conn| {
            if *offset < 0
                || *total < 0
                || items.len() > 500
                || *offset + items.len() as i64 > *total
            {
                return Err("Invalid collection membership page".into());
            }
            let state:Option<(i64,i64,i64)>=sql(conn.query_row("SELECT revision,staged_count,staged_total FROM collection_cache WHERE scope=?1 AND key=?2",params![scope,key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional())?;
            let Some((revision, count, previous_total)) = state else {
                return Err("Collection refresh was superseded".into());
            };
            if revision != *generation
                || count != *offset
                || (*offset > 0 && previous_total != *total)
            {
                return Err("Collection changed while refreshing".into());
            }
            let mut changed = false;
            let mut save=sql(conn.prepare_cached("INSERT INTO collection_cache_items(scope,kind,id,payload,search_text) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(scope,kind,id) DO UPDATE SET payload=excluded.payload,search_text=excluded.search_text WHERE payload!=excluded.payload OR search_text!=excluded.search_text"))?;
            let mut member=sql(conn.prepare_cached("INSERT INTO collection_cache_members(scope,key,generation,position,kind,item_id,occurrence) VALUES(?1,?2,?3,?4,?5,?6,?7)"))?;
            for (i, value) in items.iter().enumerate() {
                super::offline::check_payload(value, 0)?;
                let mut item = value.clone();
                let kind = item["type"]
                    .as_str()
                    .ok_or("Collection item has no type")?
                    .to_owned();
                let id = item["id"]
                    .as_str()
                    .ok_or("Collection item has no identity")?
                    .to_owned();
                if !matches!(kind.as_str(), "track" | "album" | "artist" | "playlist")
                    || id.len() > 128
                {
                    return Err("Invalid collection item".into());
                }
                let occurrence = item
                    .as_object_mut()
                    .and_then(|o| o.remove("playlistItemId"))
                    .and_then(|v| v.as_str().map(str::to_owned));
                let payload =
                    serde_json::to_string(&item).map_err(|_| "Cannot encode collection item")?;
                if payload.len() > 65536 {
                    return Err("Collection item is too large".into());
                }
                let search = ["title", "artistName", "albumName"]
                    .map(|field| item[field].as_str().unwrap_or("").to_lowercase())
                    .join("\n");
                changed |= sql(save.execute(params![scope, kind, id, payload, search]))? > 0;
                sql(member.execute(params![
                    scope,
                    key,
                    generation,
                    offset + i as i64,
                    kind,
                    id,
                    occurrence
                ]))?;
            }
            sql(conn.execute("UPDATE collection_cache SET staged_count=?3,staged_total=?4,changed=MAX(changed,?5) WHERE scope=?1 AND key=?2",params![scope,key,offset+items.len() as i64,total,changed]))?;
            Ok(Value::Null)
        }),
        Request::Commit { generation, .. } => {
            super::atomic_upsert(conn, |conn| {
                let (revision,count,total,changed,active):(i64,i64,i64,bool,Option<i64>)=sql(conn.query_row("SELECT revision,staged_count,staged_total,changed,active_generation FROM collection_cache WHERE scope=?1 AND key=?2",params![scope,key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))))?;
                if revision != *generation || count != total {
                    return Err("Collection refresh is incomplete".into());
                }
                if key.starts_with("mix:") {
                    order_mix_membership(conn, scope, key, *generation)?;
                }
                let membership_changed=active.is_none() || sql(conn.query_row("SELECT EXISTS(SELECT position,kind,item_id,occurrence FROM collection_cache_members WHERE scope=?1 AND key=?2 AND generation=?3 EXCEPT SELECT position,kind,item_id,occurrence FROM collection_cache_members WHERE scope=?1 AND key=?2 AND generation=?4) OR EXISTS(SELECT position,kind,item_id,occurrence FROM collection_cache_members WHERE scope=?1 AND key=?2 AND generation=?4 EXCEPT SELECT position,kind,item_id,occurrence FROM collection_cache_members WHERE scope=?1 AND key=?2 AND generation=?3)",params![scope,key,generation,active],|r|r.get::<_,bool>(0)))?;
                sql(conn.execute("UPDATE collection_cache SET active_generation=?3,total=staged_total,cached_at=?4,dirty=0,staged_count=0 WHERE scope=?1 AND key=?2",params![scope,key,generation,now]))?;
                sql(conn.execute("DELETE FROM collection_cache_members WHERE scope=?1 AND key=?2 AND generation!=?3",params![scope,key,generation]))?;
                Ok(json!({"changed":changed||membership_changed,"total":total}))
            })
        }
        Request::Rate { id, rating, .. } => {
            if id.len() > 128
                || rating
                    .is_some_and(|rating| !rating.is_finite() || !(0.0..=10.0).contains(&rating))
            {
                return Err("Invalid cached rating".into());
            }
            sql(conn.execute("UPDATE collection_cache_items SET payload=json_set(payload,'$.userRating',?3) WHERE scope=?1 AND id=?2",params![scope,id,rating]))?;
            Ok(Value::Null)
        }
        Request::Invalidate { .. } => {
            sql(conn.execute("UPDATE collection_cache SET dirty=1,revision=revision+1,staged_count=0,stamp='' WHERE scope=?1 AND key=?2",params![scope,key]))?;
            Ok(Value::Null)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scope() -> String {
        format!("plex-{}", "a".repeat(64))
    }
    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        super::super::schema::run_migrations(&conn).unwrap();
        conn
    }
    fn item(id: &str, occ: &str) -> Value {
        json!({"type":"track","id":id,"title":format!("Track {id}"),"playlistItemId":occ,"streamUrl":null})
    }
    fn request(conn: &Connection, op: Request) -> Value {
        run(conn, &scope(), &op, 100).unwrap()
    }
    fn begin(conn: &Connection, key: &str, stamp: &str) -> i64 {
        request(
            conn,
            Request::Begin {
                key: key.into(),
                stamp: stamp.into(),
            },
        )["generation"]
            .as_i64()
            .unwrap()
    }
    #[test]
    fn rated_index_omits_full_metadata_and_album_ids_hydrate_by_kind() {
        let conn = db();
        for (key, kind) in [("rated:track", "track"), ("rated:album", "album")] {
            let generation = begin(&conn, key, "test");
            request(&conn, Request::Put { key: key.into(), generation, offset: 0, total: 1,
                items: vec![json!({"id":"1","type":kind,"title":kind,"artistName":"Artist","userRating":8,"summary":"x".repeat(30000),"thumbUrl":"image://cover"})] });
            request(&conn, Request::Commit { key: key.into(), generation });
            let page = request(&conn, Request::Index { key: key.into(), offset: 0, limit: 10 });
            assert_eq!(page["items"][0]["title"], kind);
            assert_eq!(page["items"][0]["userRating"], 8);
            assert!(page["items"][0].get("summary").is_none());
            assert!(page["items"][0].get("thumbUrl").is_none());
            assert!(page.to_string().len() < 2000);
            let items = request(&conn, Request::Items { key: key.into(), ids: vec!["1".into()] });
            assert_eq!(items[0]["type"], kind);
            assert_eq!(items[0]["thumbUrl"], "image://cover");
        }
    }
    #[test]
    fn mix_order_blends_complete_membership_and_survives_refreshes_and_metadata_edits() {
        let conn = db();
        let key = format!("mix:{}", "a".repeat(64));
        let mut items: Vec<_> = (0..1200)
            .map(|index| {
                json!({
                    "type": "track", "id": format!("{index:04}"),
                    "title": format!("Track {index}"), "artistName": format!("Artist {}", index / 400),
                })
            })
            .collect();
        for occurrence in ["repeat-a", "repeat-b"] {
            let mut repeated = items[17].clone();
            repeated["playlistItemId"] = json!(occurrence);
            items.push(repeated);
        }
        let save = |rows: &[Value]| {
            let generation = begin(&conn, &key, "content-seeded-mix-v1");
            for (page, items) in rows.chunks(500).enumerate() {
                request(
                    &conn,
                    Request::Put {
                        key: key.clone(),
                        generation,
                        offset: (page * 500) as i64,
                        total: rows.len() as i64,
                        items: items.to_vec(),
                    },
                );
            }
            request(
                &conn,
                Request::Commit {
                    key: key.clone(),
                    generation,
                },
            )
        };
        save(&items);
        let refs = request(&conn, Request::Refs { key: key.clone() });
        let order = refs.as_array().unwrap();
        assert_eq!(order.len(), items.len());
        assert!(order[..30]
            .iter()
            .any(|entry| entry[0].as_str().unwrap() < "0400"));
        assert!(order[..30]
            .iter()
            .any(|entry| entry[0].as_str().unwrap() >= "0800"));
        assert_eq!(order.iter().filter(|entry| entry[0] == "0017").count(), 3);
        for offset in [0, 490, 1000] {
            let page = request(
                &conn,
                Request::Page {
                    key: key.clone(),
                    offset,
                    limit: 30,
                },
            );
            let ids: Vec<_> = page["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["id"].clone())
                .collect();
            assert_eq!(
                ids,
                order[offset as usize..offset as usize + 30]
                    .iter()
                    .map(|entry| entry[0].clone())
                    .collect::<Vec<_>>()
            );
        }
        let filtered = request(
            &conn,
            Request::Query {
                key: key.clone(),
                offset: 0,
                limit: 30,
                filter: "Artist 2".into(),
                sort: "default".into(),
                dir: "asc".into(),
            },
        );
        let filtered_ids: Vec<_> = filtered["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["id"].clone())
            .collect();
        assert_eq!(
            filtered_ids,
            order
                .iter()
                .filter(|entry| entry[0].as_str().unwrap() >= "0800")
                .take(30)
                .map(|entry| entry[0].clone())
                .collect::<Vec<_>>()
        );
        items.reverse();
        assert_eq!(
            save(&items)["changed"],
            false,
            "upstream order alone must not change the mix"
        );
        assert_eq!(request(&conn, Request::Refs { key: key.clone() }), refs);
        for item in &mut items {
            item["title"] = json!("Updated metadata");
        }
        save(&items);
        assert_eq!(request(&conn, Request::Refs { key: key.clone() }), refs);
        items.push(json!({ "type": "track", "id": "new", "title": "New member" }));
        save(&items);
        let updated = request(&conn, Request::Refs { key: key.clone() });
        assert_eq!(updated.as_array().unwrap().len(), order.len() + 1);
        assert_ne!(
            updated
                .as_array()
                .unwrap()
                .iter()
                .filter(|entry| entry[0] != "new")
                .collect::<Vec<_>>(),
            order.iter().collect::<Vec<_>>()
        );
    }

    #[test]
    fn query_membership_preserves_sort_filter_occurrences_and_captured_identities() {
        let conn = db();
        let key = "playlist:8";
        let mut rows: Vec<_> = (0..420)
            .map(|index| {
                json!({
                    "type":"track", "id":format!("{}", index / 2 + 1),
                    "playlistItemId":format!("{index}"), "title":format!("Song {:04}", index / 2),
                    "artistName": if index < 200 { "Keep" } else { "Other" }
                })
            })
            .collect();
        let save = |rows: &[Value], stamp: &str| {
            let generation = begin(&conn, key, stamp);
            request(
                &conn,
                Request::Put {
                    key: key.into(),
                    generation,
                    offset: 0,
                    total: rows.len() as i64,
                    items: rows.to_vec(),
                },
            );
            request(
                &conn,
                Request::Commit {
                    key: key.into(),
                    generation,
                },
            );
        };
        save(&rows, "initial");
        let query = Request::QueryRefs {
            key: key.into(),
            filter: "KEEP".into(),
            sort: "title".into(),
            dir: "desc".into(),
        };
        let refs = request(&conn, query.clone());
        assert_eq!(refs.as_array().unwrap().len(), 200);
        assert_eq!(refs[0], json!(["100", "198"]));
        assert_eq!(refs[1], json!(["100", "199"]));
        let page = request(
            &conn,
            Request::Query {
                key: key.into(),
                offset: 190,
                limit: 10,
                filter: "keep".into(),
                sort: "title".into(),
                dir: "desc".into(),
            },
        );
        for (offset, item) in page["items"].as_array().unwrap().iter().enumerate() {
            assert_eq!(item["id"], refs[190 + offset][0]);
            assert_eq!(item["playlistItemId"], refs[190 + offset][1]);
        }
        rows.retain(|row| row["id"] != "100");
        rows.reverse();
        save(&rows, "changed");
        assert_ne!(request(&conn, query), refs);
        let selected = request(
            &conn,
            Request::Items {
                key: key.into(),
                ids: vec![refs[0][0].as_str().unwrap().into()],
            },
        );
        assert_eq!(
            selected[0]["id"], "100",
            "a removed occurrence never resolves to the new occupant of its old position"
        );
        assert!(run(
            &conn,
            &scope(),
            &Request::QueryRefs {
                key: key.into(),
                filter: "".into(),
                sort: "unsupported".into(),
                dir: "asc".into()
            },
            100
        )
        .is_err());
    }

    #[test]
    fn sorted_membership_reuses_reads_and_retires_on_shared_item_edits() {
        let conn = db();
        let key = "playlist:7";
        let generation = begin(&conn, key, "initial");
        request(
            &conn,
            Request::Put {
                key: key.into(),
                generation,
                offset: 0,
                total: 3,
                items: vec![item("2", "20"), item("1", "10"), item("1", "11")],
            },
        );
        request(
            &conn,
            Request::Commit {
                key: key.into(),
                generation,
            },
        );
        let read =
            || query::membership(&conn, &scope(), key, generation, "", "title", "asc").unwrap();
        let first = read();
        assert!(std::sync::Arc::ptr_eq(&first, &read()));
        assert_eq!(first[0].occurrence.as_deref(), Some("10"));
        conn.execute("UPDATE collection_cache_items SET payload=json_set(payload,'$.title','AAAA'),search_text='aaaa' WHERE id='2'",[]).unwrap();
        let edited = read();
        assert!(!std::sync::Arc::ptr_eq(&first, &edited));
        assert_eq!(edited[0].id, "2");
        assert_eq!(first[0].id, "1", "captured snapshots remain immutable");
        assert_eq!(
            query::membership(&conn, &scope(), key, generation, "aaaa", "title", "asc")
                .unwrap()
                .len(),
            1
        );
        let other = db();
        let empty =
            query::membership(&other, &scope(), key, generation, "", "title", "asc").unwrap();
        assert!(
            empty.is_empty(),
            "independent databases cannot share query identities"
        );
    }

    #[test]
    #[ignore = "isolated 100k-member performance probe"]
    fn query_performance_probe() {
        use std::time::Instant;
        let conn = db();
        conn.execute("INSERT INTO collection_cache(scope,key,active_generation,total) VALUES(?1,'playlist:1',1,100000)",[scope()]).unwrap();
        conn.execute("WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<99999) INSERT INTO collection_cache_items(scope,kind,id,payload,search_text) SELECT ?1,'track',CAST(x AS TEXT),json_object('id',CAST(x AS TEXT),'type','track','title',printf('Song %06d',99999-x)),printf('song %06d',99999-x) FROM n",[scope()]).unwrap();
        conn.execute("INSERT INTO collection_cache_members(scope,key,generation,position,kind,item_id) SELECT scope,'playlist:1',1,CAST(id AS INTEGER),kind,id FROM collection_cache_items",[]).unwrap();
        let start = Instant::now();
        let total: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) {QUERY_FROM}"),
                params![scope(), "playlist:1", 1, ""],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(total, 100000);
        let mut statement = conn
            .prepare(&format!(
                "SELECT i.payload,m.occurrence {QUERY_FROM} ORDER BY {} LIMIT 200 OFFSET 98000",
                query_order("title", "asc").unwrap()
            ))
            .unwrap();
        let rows = statement
            .query_map(params![scope(), "playlist:1", 1, ""], |r| {
                r.get::<_, String>(0)
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(rows.len(), 200);
        eprintln!(
            "previous count + sort: {:.2} ms",
            start.elapsed().as_secs_f64() * 1000.0
        );
        let op = |offset, sort: &str| Request::Query {
            key: "playlist:1".into(),
            offset,
            limit: 200,
            filter: "".into(),
            sort: sort.into(),
            dir: "asc".into(),
        };
        for (name, request) in [
            ("first sorted", op(0, "title")),
            ("deep sorted", op(98000, "title")),
            ("deep default", op(98000, "default")),
        ] {
            let start = Instant::now();
            let result = run(&conn, &scope(), &request, 100).unwrap();
            assert_eq!(result["items"].as_array().unwrap().len(), 200);
            eprintln!("{name}: {:.2} ms", start.elapsed().as_secs_f64() * 1000.0);
        }
    }

    #[test]
    fn refresh_is_atomic_resumable_and_preserves_duplicate_occurrences() {
        let conn = db();
        let key = "playlist:9";
        let generation = begin(&conn, key, "a");
        request(
            &conn,
            Request::Put {
                key: key.into(),
                generation,
                offset: 0,
                total: 2,
                items: vec![item("1", "10"), item("1", "11")],
            },
        );
        request(
            &conn,
            Request::Commit {
                key: key.into(),
                generation,
            },
        );
        let generation = begin(&conn, key, "b");
        request(
            &conn,
            Request::Put {
                key: key.into(),
                generation,
                offset: 0,
                total: 2,
                items: vec![item("2", "12")],
            },
        );
        let old = request(
            &conn,
            Request::Page {
                key: key.into(),
                offset: 0,
                limit: 10,
            },
        );
        assert_eq!(old["items"][1]["playlistItemId"], "11");
        let token = request(
            &conn,
            Request::Begin {
                key: key.into(),
                stamp: "b".into(),
            },
        );
        assert_eq!(token["offset"], 1);
        assert!(run(
            &conn,
            &scope(),
            &Request::Commit {
                key: key.into(),
                generation
            },
            100
        )
        .is_err());
        request(
            &conn,
            Request::Put {
                key: key.into(),
                generation,
                offset: 1,
                total: 2,
                items: vec![item("3", "13")],
            },
        );
        request(
            &conn,
            Request::Commit {
                key: key.into(),
                generation,
            },
        );
        let new = request(
            &conn,
            Request::Page {
                key: key.into(),
                offset: 1,
                limit: 1,
            },
        );
        assert_eq!(new["items"][0]["id"], "3");
        assert_eq!(new["items"][0]["playlistItemId"], "13");
        let refs = request(&conn, Request::Refs { key: key.into() });
        assert_eq!(refs, json!([["2", "12"], ["3", "13"]]));
        let selected = request(
            &conn,
            Request::Items {
                key: key.into(),
                ids: vec!["3".into(), "2".into()],
            },
        );
        assert_eq!(selected[0]["id"], "3");
        assert_eq!(
            run(
                &conn,
                &format!("plex-{}", "b".repeat(64)),
                &Request::Page {
                    key: key.into(),
                    offset: 0,
                    limit: 1
                },
                100
            )
            .unwrap(),
            Value::Null
        );
    }
    #[test]
    fn invalidation_rejects_old_writes_and_unchanged_refresh_does_not_notify() {
        let conn = db();
        let key = "rated:track";
        let generation = begin(&conn, key, "a");
        let put = Request::Put {
            key: key.into(),
            generation,
            offset: 0,
            total: 1,
            items: vec![item("1", "10")],
        };
        request(&conn, put.clone());
        request(
            &conn,
            Request::Commit {
                key: key.into(),
                generation,
            },
        );
        let generation = begin(&conn, key, "a");
        request(
            &conn,
            Request::Put {
                key: key.into(),
                generation,
                offset: 0,
                total: 1,
                items: vec![item("1", "10")],
            },
        );
        let result = request(
            &conn,
            Request::Commit {
                key: key.into(),
                generation,
            },
        );
        assert_eq!(result["changed"], false);
        request(&conn, Request::Invalidate { key: key.into() });
        assert!(request(
            &conn,
            Request::Page {
                key: key.into(),
                offset: 0,
                limit: 1
            }
        )
        .is_null());
        assert!(run(&conn, &scope(), &put, 100).is_err());
        let generation = begin(&conn, key, "a");
        let unsafe_item = json!({"type":"track","id":"1","token":"secret"});
        assert!(run(
            &conn,
            &scope(),
            &Request::Put {
                key: key.into(),
                generation,
                offset: 0,
                total: 1,
                items: vec![unsafe_item]
            },
            100
        )
        .is_err());
        assert_eq!(
            request(
                &conn,
                Request::Begin {
                    key: key.into(),
                    stamp: "a".into()
                }
            )["offset"],
            0
        );
    }

    #[test]
    fn ratings_patch_cached_rows_and_clearing_is_scoped() {
        let conn = db();
        let key = "playlist:9";
        let generation = begin(&conn, key, "a");
        request(
            &conn,
            Request::Put {
                key: key.into(),
                generation,
                offset: 0,
                total: 1,
                items: vec![item("1", "occ")],
            },
        );
        request(
            &conn,
            Request::Commit {
                key: key.into(),
                generation,
            },
        );
        request(
            &conn,
            Request::Rate {
                key: "rated:track".into(),
                id: "1".into(),
                rating: Some(8.0),
            },
        );
        assert_eq!(
            request(
                &conn,
                Request::Page {
                    key: key.into(),
                    offset: 0,
                    limit: 1
                }
            )["items"][0]["userRating"],
            8.0
        );
        assert!(run(
            &conn,
            &scope(),
            &Request::Rate {
                key: "rated:track".into(),
                id: "1".into(),
                rating: Some(20.0)
            },
            100
        )
        .is_err());
        let other = format!("plex-{}", "d".repeat(64));
        run(
            &conn,
            &other,
            &Request::Begin {
                key: key.into(),
                stamp: "other".into(),
            },
            100,
        )
        .unwrap();
        super::super::atomic_upsert(&conn, |conn| clear(conn, &scope())).unwrap();
        assert!(request(&conn, Request::Info { key: key.into() }).is_null());
        assert_eq!(
            request(
                &conn,
                Request::Items {
                    key: key.into(),
                    ids: vec!["1".into()]
                }
            ),
            json!([null])
        );
        assert!(!run(&conn, &other, &Request::Info { key: key.into() }, 100)
            .unwrap()
            .is_null());
    }
}

#[cfg(test)]
mod query_tests {
    use super::*;
    #[test]
    fn queries_filter_the_entire_collection_keep_global_counts_and_sort_beyond_first_page() {
        let conn = Connection::open_in_memory().unwrap();
        super::super::schema::run_migrations(&conn).unwrap();
        let scope = format!("plex-{}", "c".repeat(64));
        let key = "playlist:18".to_string();
        let generation = run(
            &conn,
            &scope,
            &Request::Begin {
                key: key.clone(),
                stamp: "a".into(),
            },
            1,
        )
        .unwrap()["generation"]
            .as_i64()
            .unwrap();
        for page in 0..10 {
            let offset = page * 500;
            let items=(offset..offset+500).map(|i|json!({"type":"track","id":i.to_string(),"title":format!("Song {i:05}"),"artistName":if i>=4000 {"Ænigma"} else {"First artist"},"duration":i,"playlistItemId":format!("occ-{i}")})).collect();
            run(
                &conn,
                &scope,
                &Request::Put {
                    key: key.clone(),
                    generation,
                    offset,
                    total: 5000,
                    items,
                },
                1,
            )
            .unwrap();
        }
        run(
            &conn,
            &scope,
            &Request::Commit {
                key: key.clone(),
                generation,
            },
            1,
        )
        .unwrap();
        let page = run(
            &conn,
            &scope,
            &Request::Query {
                key: key.clone(),
                offset: 500,
                limit: 200,
                filter: "ænigma".into(),
                sort: "duration".into(),
                dir: "desc".into(),
            },
            1,
        )
        .unwrap();
        assert_eq!(page["total"], 1000);
        assert_eq!(page["items"][0]["id"], "4499");
        assert_eq!(page["items"][0]["playlistItemId"], "occ-4499");
        let empty = run(
            &conn,
            &scope,
            &Request::Query {
                key,
                offset: 0,
                limit: 200,
                filter: "absent".into(),
                sort: "default".into(),
                dir: "asc".into(),
            },
            1,
        )
        .unwrap();
        assert_eq!(empty["total"], 0);
        let mut plan=conn.prepare("EXPLAIN QUERY PLAN SELECT i.payload FROM collection_cache_members m JOIN collection_cache_items i ON i.scope=m.scope AND i.kind=m.kind AND i.id=m.item_id WHERE m.scope=?1 AND m.key=?2 AND m.generation=?3 AND m.position=?4").unwrap();
        let details = plan
            .query_map(params![scope, "playlist:18", generation, 4500], |r| {
                r.get::<_, String>(3)
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert!(
            details.iter().all(|line| !line.starts_with("SCAN")),
            "{details:?}"
        );
    }
}
