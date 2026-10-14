//! Finite keyset censuses and a durable, scoped event/catch-up lane.
use super::{
    catalogue::{self, now},
    catalogue_sync::{self as sync, Task},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const MAX_QUEUE: i64 = 20_000;
#[derive(Clone, Deserialize)]
pub struct Hint {
    pub id: i64,
    #[serde(rename = "type")]
    pub media_type: i64,
    #[allow(dead_code)]
    pub state: i64,
}
pub fn kind(typ: i64) -> Option<&'static str> {
    match typ {
        8 => Some("artist"),
        9 => Some("album"),
        10 => Some("track"),
        15 => Some("playlist"),
        _ => None,
    }
}
fn ensure_state(conn: &Connection, scope: &str) -> Result<(), String> {
    super::offline::check_identity(scope, "incremental")?;
    conn.execute(
        "INSERT OR IGNORE INTO plex_catalogue_incremental(scope) VALUES(?1)",
        [scope],
    )
    .map_err(|_| "Cannot initialize incremental catalogue")?;
    Ok(())
}
pub fn request_catchup(conn: &Connection, scope: &str) -> Result<(), String> {
    ensure_state(conn, scope)?;
    conn.execute("UPDATE plex_catalogue_incremental SET catchup_requested=1,request_version=request_version+1 WHERE scope=?1",[scope]).map_err(|_|"Cannot request catalogue catch-up")?;
    Ok(())
}
pub fn admit(conn: &Connection, scope: &str, hints: &[Hint], catchup: bool) -> Result<(), String> {
    if hints.len() > 200
        || hints
            .iter()
            .any(|h| h.id <= 0 || kind(h.media_type).is_none() || !matches!(h.state, 0 | 1 | 5 | 9))
    {
        return Err("Invalid catalogue notification".into());
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|_| "Cannot admit catalogue changes")?;
    ensure_state(&tx, scope)?;
    for h in hints {
        let kind = kind(h.media_type).unwrap();
        enqueue(&tx, scope, kind, h.id, h.state)?;
        tx.execute(
            "UPDATE plex_catalogue_changes SET priority=0 WHERE scope=?1 AND kind=?2 AND id=?3",
            params![scope, kind, h.id],
        )
        .map_err(|_| "Cannot prioritize live catalogue change")?;
    }
    if catchup {
        request_catchup(&tx, scope)?;
    }
    tx.commit()
        .map_err(|_| "Cannot commit catalogue changes".into())
}
pub fn enqueue(
    conn: &Connection,
    scope: &str,
    kind: &str,
    id: i64,
    state: i64,
) -> Result<(), String> {
    ensure_state(conn, scope)?;
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM plex_catalogue_changes WHERE scope=?1",
            [scope],
            |r| r.get(0),
        )
        .map_err(|_| "Cannot read catalogue change bounds")?;
    let existing:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM plex_catalogue_changes WHERE scope=?1 AND kind=?2 AND id=?3)",params![scope,kind,id],|r|r.get(0)).map_err(|_|"Cannot read catalogue change")?;
    if !existing && count >= MAX_QUEUE {
        request_catchup(conn, scope)?;
        conn.execute(
            "UPDATE plex_catalogue_incremental SET catchup_force=1 WHERE scope=?1",
            [scope],
        )
        .map_err(|_| "Cannot retain catalogue overflow recovery")?;
        return Ok(());
    }
    conn.execute("INSERT INTO plex_catalogue_changes(scope,kind,id,hint_state,queued_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(scope,kind,id) DO UPDATE SET version=version+1,hint_state=excluded.hint_state,queued_at=excluded.queued_at,attempted_at=0",params![scope,kind,id,state,now()]).map_err(|_|"Cannot queue catalogue change")?;
    conn.execute(
        "UPDATE plex_catalogue SET change_seq=change_seq+1 WHERE scope=?1 AND kind=?2 AND id=?3",
        params![scope, kind, id],
    )
    .map_err(|_| "Cannot fence changed catalogue detail")?;
    Ok(())
}
#[derive(Clone)]
pub struct Change {
    pub kind: String,
    pub id: i64,
    pub version: i64,
    pub state: i64,
}
/// Keep a failed playlist in the existing durable retry lane without replacing
/// a newer websocket hint or turning every bulk heartbeat into a new version.
pub fn retry_playlist(conn: &Connection, scope: &str, id: i64) -> Result<(), String> {
    let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM plex_catalogue_changes WHERE scope=?1 AND kind='playlist' AND id=?2)",params![scope,id],|r|r.get(0)).map_err(|_| "Cannot read playlist retry")?;
    if !exists {
        enqueue(conn, scope, "playlist", id, 5)?;
    }
    conn.execute("UPDATE plex_catalogue_changes SET attempted_at=?3 WHERE scope=?1 AND kind='playlist' AND id=?2",params![scope,id,now()]).map_err(|_| "Cannot defer playlist retry")?;
    Ok(())
}
pub fn next(conn: &Connection, scope: &str) -> Result<Option<Change>, String> {
    let ready=conn.query_row("SELECT kind,id,version,hint_state FROM plex_catalogue_changes WHERE scope=?1 AND attempted_at<?2 ORDER BY priority,attempted_at,queued_at,id LIMIT 1",params![scope,now()-30_000],|r|Ok(Change{kind:r.get(0)?,id:r.get(1)?,version:r.get(2)?,state:r.get(3)?})).optional().map_err(|_|"Cannot read pending catalogue change")?;
    if ready.is_some() {
        return Ok(ready);
    }
    let candidate:Option<(String,i64)>=conn.query_row("SELECT kind,id FROM plex_catalogue WHERE scope=?1 AND verify_missing=1 AND NOT EXISTS(SELECT 1 FROM plex_catalogue_changes q WHERE q.scope=plex_catalogue.scope AND q.kind=plex_catalogue.kind AND q.id=plex_catalogue.id) ORDER BY kind,id LIMIT 1",[scope],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|_|"Cannot read deletion verification candidate")?;
    if let Some((kind, id)) = candidate {
        enqueue(conn, scope, &kind, id, 9)?;
        conn.execute(
            "UPDATE plex_catalogue_changes SET priority=2 WHERE scope=?1 AND kind=?2 AND id=?3",
            params![scope, kind, id],
        )
        .map_err(|_| "Cannot prioritize deletion verification")?;
        return conn
            .query_row(
                "SELECT version FROM plex_catalogue_changes WHERE scope=?1 AND kind=?2 AND id=?3",
                params![scope, kind, id],
                |r| {
                    Ok(Change {
                        kind: kind.clone(),
                        id,
                        version: r.get(0)?,
                        state: 9,
                    })
                },
            )
            .optional()
            .map_err(|_| "Cannot admit deletion verification".into());
    }
    Ok(None)
}
pub fn current(conn: &Connection, scope: &str, change: &Change) -> Result<bool, String> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM plex_catalogue_changes WHERE scope=?1 AND kind=?2 AND id=?3 AND version=?4)",params![scope,change.kind,change.id,change.version],|r|r.get(0)).map_err(|_|"Cannot fence admitted catalogue change".into())
}
pub fn discard(conn: &Connection, scope: &str, change: &Change) -> Result<(), String> {
    conn.execute(
        "DELETE FROM plex_catalogue_changes WHERE scope=?1 AND kind=?2 AND id=?3 AND version=?4",
        params![scope, change.kind, change.id, change.version],
    )
    .map_err(|_| "Cannot retire unrelated catalogue hint")?;
    conn.execute(
        "UPDATE plex_catalogue SET verify_missing=0 WHERE scope=?1 AND kind=?2 AND id=?3",
        params![scope, change.kind, change.id],
    )
    .map_err(|_| "Cannot retire unrelated deletion candidate")?;
    Ok(())
}
pub fn defer(conn: &Connection, scope: &str, change: &Change) -> Result<(), String> {
    conn.execute("UPDATE plex_catalogue_changes SET attempted_at=?5 WHERE scope=?1 AND kind=?2 AND id=?3 AND version=?4",params![scope,change.kind,change.id,change.version,now()]).map_err(|_|"Cannot defer catalogue change")?;
    Ok(())
}
pub fn revision(raw: &Value) -> Result<String, String> {
    let mut raw = catalogue::clean_document(raw)?;
    if let Some(object) = raw.as_object_mut() {
        // Listening/rating scalar changes remain in the listing projection;
        // they don't require another full Media/Stream metadata request.
        for key in [
            "viewCount",
            "lastViewedAt",
            "skipCount",
            "lastSkippedAt",
            "userRating",
            "lastRatedAt",
            "playlistItemID",
        ] {
            object.remove(key);
        }
        object.retain(|key, _| !key.starts_with("_hibikiInvalidUtf8"));
    }
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&raw).map_err(|_| "Invalid catalogue revision")?)
    ))
}
fn publication_value(value: &Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .filter(|(key, _)| !key.starts_with("_hibikiInvalidUtf8"))
                .map(|(key, value)| (key.clone(), publication_value(value)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(publication_value).collect()),
        _ => value.clone(),
    }
}
fn covered(full: &Value, listing: &Value) -> bool {
    match (full, listing) {
        (Value::Object(full), Value::Object(listing)) => listing
            .iter()
            .filter(|(key, _)| {
                !key.starts_with("_hibikiInvalidUtf8")
                    && !matches!(
                        key.as_str(),
                        "viewCount"
                            | "lastViewedAt"
                            | "skipCount"
                            | "lastSkippedAt"
                            | "userRating"
                            | "lastRatedAt"
                            | "playlistItemID"
                    )
            })
            .all(|(key, value)| full.get(key).is_some_and(|full| covered(full, value))),
        (Value::Array(full), Value::Array(listing)) => {
            full.len() == listing.len()
                && full
                    .iter()
                    .zip(listing)
                    .all(|(full, listing)| covered(full, listing))
        }
        _ => full == listing,
    }
}
/// Always archive a sparse listing separately; never replace full raw Media.
#[cfg(test)]
pub fn listing(
    conn: &Connection,
    scope: &str,
    kind: &str,
    id: i64,
    raw: &Value,
    generation: Option<&str>,
    position: i64,
) -> Result<bool, String> {
    listing_at(conn, scope, kind, id, raw, generation, position, None)
}
fn listing_at(
    conn: &Connection,
    scope: &str,
    kind: &str,
    id: i64,
    raw: &Value,
    generation: Option<&str>,
    position: i64,
    requested_at: Option<i64>,
) -> Result<bool, String> {
    let stale:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM plex_catalogue c WHERE scope=?1 AND kind=?2 AND id=?3 AND ((?4 IS NOT NULL AND (saved_at>=?4 OR EXISTS(SELECT 1 FROM plex_catalogue_changes q WHERE q.scope=c.scope AND q.kind=c.kind AND q.id=c.id AND q.queued_at>=?4))) OR (CAST(json_extract(document,'$.updatedAt') AS INTEGER)>?5)))",params![scope,kind,id,requested_at,crate::plex::catalogue::number(&raw["updatedAt"])],|r|r.get(0)).map_err(|_|"Cannot fence catalogue listing")?;
    if stale {
        if let Some(generation) = generation {
            conn.execute("UPDATE plex_catalogue SET seen_generation=?4,position=?5 WHERE scope=?1 AND kind=?2 AND id=?3",params![scope,kind,id,generation,position]).map_err(|_|"Cannot retain census presence")?;
        }
        return Ok(false);
    }
    let digest = revision(raw)?;
    let prior:Option<(Option<String>,Option<String>,i64,i64,i64,Option<String>,String)>=conn.query_row("SELECT listing_revision,listing,detail,saved_at,listing_saved_at,detail_revision,document FROM plex_catalogue WHERE scope=?1 AND kind=?2 AND id=?3",params![scope,kind,id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional().map_err(|_|"Cannot read listing revision")?;
    let old = prior.as_ref().and_then(|p| p.0.clone()).or_else(|| {
        prior
            .as_ref()
            .and_then(|p| p.1.as_deref())
            .and_then(|v| serde_json::from_str::<Value>(v).ok())
            .and_then(|v| revision(&v).ok())
    });
    let mut detail_revision = prior.as_ref().and_then(|p| p.5.clone()).or_else(|| {
        prior
            .as_ref()
            .filter(|p| p.2 == 1 && p.3 >= p.4)
            .and_then(|_| old.clone())
    });
    if let Some(prior) = prior.as_ref().filter(|p| p.2 == 1) {
        if serde_json::from_str::<Value>(&prior.6)
            .ok()
            .is_some_and(|full| covered(&full, raw))
        {
            detail_revision = Some(digest.clone());
        }
    }
    let data_changed = prior
        .as_ref()
        .and_then(|p| p.1.as_deref().or(Some(p.6.as_str())))
        .and_then(|old| serde_json::from_str::<Value>(old).ok())
        .is_none_or(|old| {
            publication_value(&old)
                != publication_value(&catalogue::clean_document(raw).unwrap_or(Value::Null))
        });
    let changed = old.as_deref() != Some(&digest);
    let document = serde_json::to_string(&catalogue::clean_document(raw)?)
        .map_err(|_| "Invalid catalogue listing")?;
    conn.execute("INSERT INTO plex_catalogue(scope,kind,id,document,detail,saved_at,listing,listing_saved_at,seen_generation,position,removed,listing_revision) VALUES(?1,?2,?3,?4,0,?5,?4,?5,?6,?7,0,?8)
      ON CONFLICT(scope,kind,id) DO UPDATE SET listing=excluded.listing,listing_saved_at=excluded.listing_saved_at,seen_generation=coalesce(excluded.seen_generation,plex_catalogue.seen_generation),position=CASE WHEN excluded.seen_generation IS NOT NULL THEN excluded.position ELSE plex_catalogue.position END,removed=0,listing_revision=excluded.listing_revision,detail_revision=?9,change_seq=change_seq+?10",params![scope,kind,id,document,now(),generation,position,digest,detail_revision,i64::from(changed)]).map_err(|_|"Cannot publish catalogue listing")?;
    Ok(data_changed)
}
/// Starts a finite census once. A legacy partial offset scan converts once;
/// completed baselines refresh rarely, not on every connection heartbeat.
pub fn begin_keyset(
    conn: &Connection,
    scope: &str,
    name: &str,
    upper: i64,
    total: Option<i64>,
    lower_time: Option<i64>,
    upper_time: Option<i64>,
) -> Result<Task, String> {
    let prior = sync::task(conn, scope, name)?;
    if let Some(t) = prior.as_ref() {
        if t.scan_mode == "keyset" && t.status != "complete" {
            return Ok(t.clone());
        }
    }
    let generation = uuid::Uuid::new_v4().to_string();
    conn.execute("INSERT INTO plex_catalogue_tasks(scope,task,generation,status,cursor,total,updated_at,scan_mode,key_cursor,upper_id,started_at,lower_time,upper_time) VALUES(?1,?2,?3,'pending',0,?4,?5,'keyset',0,?6,?5,?7,?8)
     ON CONFLICT(scope,task) DO UPDATE SET generation=excluded.generation,status='pending',cursor=0,total=excluded.total,completed_at=NULL,error=NULL,updated_at=excluded.updated_at,scan_mode='keyset',key_cursor=0,upper_id=excluded.upper_id,started_at=excluded.started_at,lower_time=excluded.lower_time,upper_time=excluded.upper_time",params![scope,name,generation,total,now(),upper,lower_time,upper_time]).map_err(|_|"Cannot begin finite catalogue scan")?;
    sync::task(conn, scope, name)?.ok_or("Catalogue census unavailable".into())
}
#[cfg(test)]
pub fn keyset_page(
    conn: &Connection,
    scope: &str,
    task: &Task,
    kind: &str,
    items: &[Value],
    reported_total: Option<i64>,
) -> Result<Vec<i64>, String> {
    keyset_page_at(conn, scope, task, kind, items, reported_total, None)
}
pub fn keyset_page_at(
    conn: &Connection,
    scope: &str,
    task: &Task,
    kind: &str,
    items: &[Value],
    reported_total: Option<i64>,
    requested_at: Option<i64>,
) -> Result<Vec<i64>, String> {
    if task.scan_mode != "keyset" || items.len() > 200 {
        return Err("Invalid finite catalogue page".into());
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|_| "Cannot save finite catalogue page")?;
    if task.task.starts_with("catchup:") {
        let pending: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM plex_catalogue_changes WHERE scope=?1",
                [scope],
                |r| r.get(0),
            )
            .map_err(|_| "Cannot bound catch-up changes")?;
        if pending + items.len() as i64 > MAX_QUEUE {
            return Err("Catalogue change queue is full".into());
        }
    }
    let mut cursor = task.key_cursor;
    let mut changed = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let id = crate::plex::catalogue::number(&item["ratingKey"])
            .filter(|id| *id > cursor && Some(*id) <= task.upper_id)
            .ok_or("Plex ignored catalogue keyset bounds or ordering")?;
        if item["type"].as_str() != Some(kind) {
            return Err("Plex returned a different catalogue kind".into());
        }
        if task.lower_time.is_some()
            && crate::plex::catalogue::number(&item["updatedAt"])
                .is_none_or(|time| Some(time) < task.lower_time || Some(time) > task.upper_time)
        {
            return Err("Plex ignored catalogue timestamp bounds".into());
        }
        if listing_at(
            &tx,
            scope,
            kind,
            id,
            item,
            if task.task.starts_with("catchup:") {
                None
            } else {
                Some(&task.generation)
            },
            task.cursor + index as i64,
            requested_at,
        )? {
            changed.push(id);
        }
        cursor = id;
    }
    let complete = items.is_empty();
    let count = task.cursor + items.len() as i64;
    // Remaining filtered totals can change while importing/deleting. They are
    // informational; only the persisted finite key boundary decides completion.
    let total = if complete {
        Some(count)
    } else {
        reported_total
            .map(|n| task.cursor + n)
            .or(task.total)
            .map(|n| n.max(count))
    };
    let updated=tx.execute("UPDATE plex_catalogue_tasks SET key_cursor=?4,cursor=?5,total=?6,status=?7,completed_at=?8,error=NULL,updated_at=?9 WHERE scope=?1 AND task=?2 AND generation=?3 AND key_cursor=?10 AND cursor=?11",params![scope,task.task,task.generation,cursor,count,total,if complete{"complete"}else{"running"},if complete{Some(now())}else{None},now(),task.key_cursor,task.cursor]).map_err(|_|"Cannot checkpoint finite catalogue page")?;
    if updated != 1 {
        return Err("Catalogue census was superseded".into());
    }
    if task.task.starts_with("catchup:") {
        for item in items {
            let id = crate::plex::catalogue::number(&item["ratingKey"])
                .ok_or("Invalid changed identity")?;
            let dirty:bool=tx.query_row("SELECT detail=0 OR detail_revision IS NOT listing_revision FROM plex_catalogue WHERE scope=?1 AND kind=?2 AND id=?3",params![scope,kind,id],|r|r.get(0)).map_err(|_|"Cannot verify changed detail need")?;
            if dirty {
                enqueue(&tx, scope, kind, id, 0)?;
            }
        }
        if !changed.is_empty() {
            bump(&tx, scope)?;
        }
    }
    tx.commit()
        .map_err(|_| "Cannot commit finite catalogue page")?;
    Ok(changed)
}
#[derive(Clone)]
pub struct DetailJob {
    pub id: i64,
    pub revision: Option<String>,
    pub sequence: i64,
}
pub fn detail_jobs(
    conn: &Connection,
    scope: &str,
    kind: &str,
    cursor: i64,
) -> Result<Vec<DetailJob>, String> {
    let mut stmt=conn.prepare("SELECT id,listing_revision,change_seq FROM plex_catalogue WHERE scope=?1 AND kind=?2 AND removed=0 AND id>?3 AND (detail=0 OR detail_revision IS NOT listing_revision) ORDER BY id LIMIT 50").map_err(|_|"Cannot read changed details")?;
    let rows = stmt
        .query_map(params![scope, kind, cursor], |r| {
            Ok(DetailJob {
                id: r.get(0)?,
                revision: r.get(1)?,
                sequence: r.get(2)?,
            })
        })
        .map_err(|_| "Cannot read changed details")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Cannot read changed details")?;
    Ok(rows)
}
pub fn publish_detail(
    conn: &Connection,
    scope: &str,
    kind: &str,
    job: &DetailJob,
    raw: &Value,
) -> Result<bool, String> {
    let matches:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM plex_catalogue WHERE scope=?1 AND kind=?2 AND id=?3 AND change_seq=?4 AND listing_revision IS ?5)",params![scope,kind,job.id,job.sequence,job.revision],|r|r.get(0)).map_err(|_|"Cannot fence catalogue detail")?;
    if !matches {
        return Ok(false);
    }
    catalogue::save(conn, scope, kind, job.id, raw, true)?;
    conn.execute("UPDATE plex_catalogue SET detail_revision=listing_revision,removed=0 WHERE scope=?1 AND kind=?2 AND id=?3",params![scope,kind,job.id]).map_err(|_|"Cannot complete changed catalogue detail")?;
    Ok(true)
}
pub(crate) fn bump(conn: &Connection, scope: &str) -> Result<i64, String> {
    ensure_state(conn, scope)?;
    conn.execute(
        "UPDATE plex_catalogue_incremental SET changes_revision=changes_revision+1 WHERE scope=?1",
        [scope],
    )
    .map_err(|_| "Cannot version incremental catalogue")?;
    conn.query_row(
        "SELECT changes_revision FROM plex_catalogue_incremental WHERE scope=?1",
        [scope],
        |r| r.get(0),
    )
    .map_err(|_| "Cannot read incremental revision".into())
}
/// The caller has verified the scoped server/library and the item (or a genuine
/// 404). Hints never remove bytes, local_audio or download ownership records.
#[cfg(test)]
pub fn apply(
    conn: &Connection,
    scope: &str,
    change: &Change,
    raw: Option<&Value>,
) -> Result<Option<i64>, String> {
    apply_with(conn, scope, change, raw, |_| Ok(false))
}
pub fn apply_with(
    conn: &Connection,
    scope: &str,
    change: &Change,
    raw: Option<&Value>,
    publish: impl FnOnce(&Connection) -> Result<bool, String>,
) -> Result<Option<i64>, String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|_| "Cannot publish catalogue change")?;
    let current:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM plex_catalogue_changes WHERE scope=?1 AND kind=?2 AND id=?3 AND version=?4)",params![scope,change.kind,change.id,change.version],|r|r.get(0)).map_err(|_|"Cannot fence catalogue change")?;
    if !current {
        return Ok(None);
    }
    let previous:Option<(String,i64,i64)>=tx.query_row("SELECT document,detail,removed FROM plex_catalogue WHERE scope=?1 AND kind=?2 AND id=?3",params![scope,change.kind,change.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|_|"Cannot compare changed metadata")?;
    let changed = if let Some(raw) = raw {
        previous.as_ref().is_none_or(|(text, detail, removed)| {
            *detail != 1
                || *removed != 0
                || serde_json::from_str::<Value>(text).ok().is_none_or(|old| {
                    publication_value(&old)
                        != publication_value(&catalogue::clean_document(raw).unwrap_or(Value::Null))
                })
        })
    } else {
        previous
            .as_ref()
            .is_some_and(|(_, _, removed)| *removed == 0)
    };
    if let Some(raw) = raw {
        if changed {
            catalogue::save(&tx, scope, &change.kind, change.id, raw, true)?;
        }
        tx.execute("UPDATE plex_catalogue SET removed=0,verify_missing=0,change_seq=change_seq+1,detail_revision=listing_revision WHERE scope=?1 AND kind=?2 AND id=?3",params![scope,change.kind,change.id]).map_err(|_|"Cannot publish changed metadata")?;
    } else {
        tx.execute("UPDATE plex_catalogue SET removed=1,verify_missing=0,change_seq=change_seq+1 WHERE scope=?1 AND kind=?2 AND id=?3",params![scope,change.kind,change.id]).map_err(|_|"Cannot retire verified missing metadata")?;
        tx.execute("UPDATE plex_catalogue_media SET active=0 WHERE scope=?1 AND track_id=?2 AND ?3='track'",params![scope,change.id,change.kind]).map_err(|_|"Cannot retire missing analysis associations")?;
    }
    tx.execute(
        "DELETE FROM plex_catalogue_changes WHERE scope=?1 AND kind=?2 AND id=?3 AND version=?4",
        params![scope, change.kind, change.id, change.version],
    )
    .map_err(|_| "Cannot acknowledge catalogue change")?;
    let changed = publish(&tx)? || changed;
    let revision = if changed {
        Some(bump(&tx, scope)?)
    } else {
        None
    };
    tx.commit().map_err(|_| "Cannot commit catalogue change")?;
    Ok(revision)
}
pub fn reconciliation_candidates(
    conn: &Connection,
    scope: &str,
    task: &Task,
    kind: &str,
) -> Result<(), String> {
    // Absence from a finite census is only a candidate. Each deletion requires
    // another authoritative GET; downloads and concurrent event writes survive.
    conn.execute("UPDATE plex_catalogue SET verify_missing=1 WHERE scope=?1 AND kind=?2 AND removed=0 AND id<=?3 AND seen_generation IS NOT ?4 AND saved_at<?5 AND listing_saved_at<?5",params![scope,kind,task.upper_id,task.generation,task.started_at]).map_err(|_|"Cannot stage deletion verification")?;
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub pending: i64,
    pub catch_up_requested: bool,
    pub watermark: Option<i64>,
    pub changes_revision: i64,
    pub phase: String,
}
pub fn progress(conn: &Connection, scope: &str) -> Result<Progress, String> {
    super::offline::check_identity(scope, "incremental")?;
    conn.query_row("SELECT ((SELECT COUNT(*) FROM plex_catalogue_changes WHERE scope=?1)+(SELECT COUNT(*) FROM plex_catalogue WHERE scope=?1 AND verify_missing=1 AND NOT EXISTS(SELECT 1 FROM plex_catalogue_changes q WHERE q.scope=plex_catalogue.scope AND q.kind=plex_catalogue.kind AND q.id=plex_catalogue.id))),catchup_requested,watermark,changes_revision,phase FROM plex_catalogue_incremental WHERE scope=?1",[scope],|r|Ok(Progress{pending:r.get(0)?,catch_up_requested:r.get(1)?,watermark:r.get(2)?,changes_revision:r.get(3)?,phase:r.get(4)?})).optional().map(|p|p.unwrap_or(Progress{pending:0,catch_up_requested:false,watermark:None,changes_revision:0,phase:"idle".into()})).map_err(|_|"Cannot read incremental progress".into())
}
/// A completed incremental pass can restore browse freshness without another
/// full census. Its capture began after the mutation and all admitted changes
/// and deletion candidates have been resolved. Pending periodic requests do
/// not invalidate an already completed pass.
pub fn browse_reconciled_after(conn: &Connection, scope: &str, invalidated_at: i64) -> Result<bool, String> {
    super::offline::check_identity(scope, "browse-freshness")?;
    conn.query_row("SELECT EXISTS(SELECT 1 FROM plex_catalogue_incremental i WHERE i.scope=?1 AND i.watermark IS NOT NULL AND i.catchup_target IS NULL AND i.catchup_started>?2 AND (SELECT COUNT(*) FROM plex_catalogue_tasks t WHERE t.scope=i.scope AND t.task IN ('artist','album','track','playlist') AND t.status='complete')=4 AND (SELECT COUNT(*) FROM plex_catalogue_tasks t WHERE t.scope=i.scope AND t.task IN ('catchup:artist','catchup:album','catchup:track','catchup:playlist') AND t.status='complete' AND t.upper_time=i.watermark)=4 AND NOT EXISTS(SELECT 1 FROM plex_catalogue_changes WHERE scope=i.scope) AND NOT EXISTS(SELECT 1 FROM plex_catalogue WHERE scope=i.scope AND verify_missing=1))",params![scope,invalidated_at],|r|r.get(0)).map_err(|_|"Cannot verify incremental browse freshness".into())
}
pub fn phase(conn: &Connection, scope: &str, phase: &str) -> Result<(), String> {
    ensure_state(conn, scope)?;
    conn.execute("UPDATE plex_catalogue_incremental SET phase=CASE WHEN catchup_target IS NOT NULL THEN 'catchingUp' ELSE ?2 END WHERE scope=?1",params![scope,phase]).map_err(|_|"Cannot update catalogue phase")?;
    Ok(())
}
pub fn catchup_needed(conn: &Connection, scope: &str) -> Result<bool, String> {
    ensure_state(conn, scope)?;
    conn.query_row("SELECT catchup_target IS NOT NULL OR (catchup_requested=1 AND catchup_started<?2) FROM plex_catalogue_incremental WHERE scope=?1",params![scope,now()-300_000],|r|r.get(0)).map_err(|_|"Cannot read catch-up schedule".into())
}
pub fn catchup_begin(
    conn: &Connection,
    scope: &str,
    server_time: i64,
) -> Result<(i64, i64, i64), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|_| "Cannot begin atomic catch-up")?;
    ensure_state(&tx, scope)?;
    let (watermark,target,version,force,full,captured_low):(Option<i64>,Option<i64>,i64,bool,bool,Option<i64>)=tx.query_row("SELECT watermark,catchup_target,coalesce(catchup_version,request_version),catchup_force,catchup_full,catchup_lower FROM plex_catalogue_incremental WHERE scope=?1",[scope],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).map_err(|_|"Cannot begin catch-up")?;
    let high = target.unwrap_or(server_time);
    let seed:Option<i64>=tx.query_row("SELECT MIN(COALESCE(NULLIF(started_at,0),completed_at)/1000) FROM plex_catalogue_tasks WHERE scope=?1 AND task IN ('artist','album','track','playlist')",[scope],|r|r.get(0)).map_err(|_|"Cannot read prior catalogue coverage")?;
    let full = if target.is_some() { full } else { force };
    let low = if target.is_some() {
        captured_low.ok_or("Active catalogue catch-up has no captured lower bound")?
    } else if full {
        0
    } else {
        watermark
            .or(seed)
            .unwrap_or(high - 300)
            .saturating_sub(120)
            .max(0)
    };
    if target.is_none() {
        tx.execute("UPDATE plex_catalogue_incremental SET catchup_target=?2,catchup_started=?3,catchup_lower=?4,catchup_version=request_version,catchup_full=catchup_force,catchup_force=0,phase='catchingUp' WHERE scope=?1",params![scope,high,now(),low]).map_err(|_|"Cannot begin catch-up")?;
        tx.execute(
            "DELETE FROM plex_catalogue_tasks WHERE scope=?1 AND task LIKE 'catchup:%'",
            [scope],
        )
        .map_err(|_| "Cannot begin new catch-up pages")?;
    }
    tx.commit()
        .map_err(|_| "Cannot commit catch-up admission")?;
    Ok((low, high, version))
}
pub fn catchup_finish(
    conn: &Connection,
    scope: &str,
    high: i64,
    version: i64,
) -> Result<i64, String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|_| "Cannot finish catch-up")?;
    let complete:i64=tx.query_row("SELECT COUNT(*) FROM plex_catalogue_tasks WHERE scope=?1 AND task IN ('catchup:artist','catchup:album','catchup:track','catchup:playlist') AND status='complete' AND upper_time=?2 AND lower_time=(SELECT catchup_lower FROM plex_catalogue_incremental WHERE scope=?1)",params![scope,high],|r|r.get(0)).map_err(|_|"Cannot verify catch-up coverage")?;
    if complete != 4 {
        return Err("Catalogue catch-up is incomplete".into());
    }
    let updated=tx.execute("UPDATE plex_catalogue_incremental SET watermark=?2,catchup_target=NULL,catchup_lower=NULL,catchup_version=NULL,catchup_full=0,catchup_requested=CASE WHEN request_version=?3 THEN 0 ELSE 1 END,phase='idle' WHERE scope=?1 AND catchup_target=?2",params![scope,high,version]).map_err(|_|"Cannot publish catch-up watermark")?;
    if updated != 1 {
        return Err("Catalogue catch-up was superseded".into());
    }
    let revision = progress(&tx, scope)?.changes_revision;
    tx.commit()
        .map_err(|_| "Cannot commit catch-up watermark")?;
    Ok(revision)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn progress_is_a_pure_read_even_before_initialization() {
        let (conn, scope) = fixture();
        conn.pragma_update(None, "query_only", true).unwrap();
        assert_eq!(progress(&conn, &scope).unwrap().pending, 0);
        assert!(progress(&conn, &scope).unwrap().watermark.is_none());
    }
    #[test]
    fn browse_freshness_requires_a_new_complete_window_and_resolved_changes() {
        let (conn, scope) = fixture();
        ensure_state(&conn, &scope).unwrap();
        for kind in ["artist","album","track","playlist"] {
            let task = sync::begin(&conn, &scope, kind, None).unwrap();
            sync::checkpoint(&conn, &scope, &task, 0, Some(0), true).unwrap();
            let task = sync::begin(&conn, &scope, &format!("catchup:{kind}"), None).unwrap();
            sync::checkpoint(&conn, &scope, &task, 0, Some(0), true).unwrap();
        }
        conn.execute("UPDATE plex_catalogue_tasks SET upper_time=2 WHERE task LIKE 'catchup:%'",[]).unwrap();
        conn.execute("UPDATE plex_catalogue_incremental SET watermark=2,catchup_started=2000,catchup_requested=1 WHERE scope=?1",[&scope]).unwrap();
        assert!(browse_reconciled_after(&conn,&scope,1000).unwrap());
        assert!(!browse_reconciled_after(&conn,&scope,2000).unwrap());
        assert!(!browse_reconciled_after(&conn,&format!("plex-{}","b".repeat(64)),1000).unwrap());
        enqueue(&conn,&scope,"track",1,5).unwrap();
        assert!(!browse_reconciled_after(&conn,&scope,1000).unwrap());
        conn.execute("DELETE FROM plex_catalogue_changes",[]).unwrap();
        conn.execute("UPDATE plex_catalogue_tasks SET status='running' WHERE task='catchup:track'",[]).unwrap();
        assert!(!browse_reconciled_after(&conn,&scope,1000).unwrap());
    }
    fn fixture() -> (Connection, String) {
        let conn = Connection::open_in_memory().unwrap();
        super::super::schema::run_migrations(&conn).unwrap();
        (conn, format!("plex-{}", "a".repeat(64)))
    }
    fn item(id: i64) -> Value {
        serde_json::json!({"type":"track","ratingKey":id,"title":format!("Track {id}"),"updatedAt":100,"Media":[{"id":1,"Part":[{"id":2}]}]})
    }
    fn hint(id: i64, state: i64) -> Hint {
        Hint {
            id,
            media_type: 10,
            state,
        }
    }
    #[test]
    fn live_hints_take_priority_over_backfill_and_deferred_processing_retains_its_admission() {
        let (conn, scope) = fixture();
        for id in 1..=20 {
            enqueue(&conn, &scope, "track", id, 0).unwrap();
        }
        admit(&conn, &scope, &[hint(100, 1)], false).unwrap();
        let processing = next(&conn, &scope).unwrap().unwrap();
        assert_eq!(processing.id, 100);
        defer(&conn, &scope, &processing).unwrap();
        assert_eq!(next(&conn, &scope).unwrap().unwrap().id, 1);
        assert_eq!(progress(&conn, &scope).unwrap().pending, 21);
        admit(&conn, &scope, &[hint(100, 5)], false).unwrap();
        assert_eq!(next(&conn, &scope).unwrap().unwrap().id, 100);
        defer(&conn, &scope, &processing).unwrap();
        assert_eq!(next(&conn, &scope).unwrap().unwrap().id, 100);
    }
    #[test]
    fn playlist_failure_is_deferred_without_blocking_other_changes_or_replacing_newer_hints() {
        let (conn, scope) = fixture();
        admit(
            &conn,
            &scope,
            &[Hint {
                id: 7,
                media_type: 15,
                state: 1,
            }],
            false,
        )
        .unwrap();
        let hint = next(&conn, &scope).unwrap().unwrap();
        retry_playlist(&conn, &scope, 7).unwrap();
        retry_playlist(&conn, &scope, 7).unwrap();
        let (version,state):(i64,i64) = conn.query_row("SELECT version,hint_state FROM plex_catalogue_changes WHERE kind='playlist' AND id=7",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!((version, state), (hint.version, 1));
        admit(&conn, &scope, &[self::hint(8, 5)], false).unwrap();
        assert_eq!(next(&conn, &scope).unwrap().unwrap().id, 8);
        retry_playlist(&conn, &scope, 9).unwrap();
        assert_eq!(progress(&conn, &scope).unwrap().pending, 3);
    }
    #[test]
    fn unchanged_event_acknowledgements_and_catchup_windows_do_not_publish_ui_revisions() {
        let (conn, scope) = fixture();
        admit(&conn, &scope, &[hint(1, 0)], false).unwrap();
        let change = next(&conn, &scope).unwrap().unwrap();
        apply(&conn, &scope, &change, Some(&item(1))).unwrap();
        assert_eq!(progress(&conn, &scope).unwrap().changes_revision, 1);
        for state in [0, 1, 5] {
            admit(&conn, &scope, &[hint(1, state)], false).unwrap();
            let change = next(&conn, &scope).unwrap().unwrap();
            assert!(apply(&conn, &scope, &change, Some(&item(1)))
                .unwrap()
                .is_none());
        }
        assert_eq!(progress(&conn, &scope).unwrap().pending, 0);
        assert_eq!(progress(&conn, &scope).unwrap().changes_revision, 1);
        super::listing(&conn, &scope, "track", 1, &item(1), None, 0).unwrap();
        let task = begin_keyset(
            &conn,
            &scope,
            "catchup:track",
            1,
            Some(1),
            Some(0),
            Some(100),
        )
        .unwrap();
        assert!(
            keyset_page(&conn, &scope, &task, "track", &[item(1)], Some(1))
                .unwrap()
                .is_empty()
        );
        assert_eq!(progress(&conn, &scope).unwrap().changes_revision, 1);
        assert_eq!(progress(&conn, &scope).unwrap().pending, 0);
        let task = sync::task(&conn, &scope, "catchup:track").unwrap().unwrap();
        keyset_page(&conn, &scope, &task, "track", &[], Some(0)).unwrap();
        request_catchup(&conn, &scope).unwrap();
        let (low, high, version) = catchup_begin(&conn, &scope, 2000).unwrap();
        for kind in ["artist", "album", "track", "playlist"] {
            let task = begin_keyset(
                &conn,
                &scope,
                &format!("catchup:{kind}"),
                0,
                Some(0),
                Some(low),
                Some(high),
            )
            .unwrap();
            keyset_page(&conn, &scope, &task, kind, &[], Some(0)).unwrap();
        }
        catchup_finish(&conn, &scope, high, version).unwrap();
        assert_eq!(progress(&conn, &scope).unwrap().changes_revision, 1);
    }
    #[test]
    fn a_new_hint_fences_playlist_membership_publication_and_keeps_old_generation_visible() {
        let (conn, scope) = fixture();
        let first = sync::begin(&conn, &scope, "playlist:7", Some("old")).unwrap();
        sync::playlist_page(&conn, &scope, 7, &first, &[item(1)], Some(1), true).unwrap();
        admit(
            &conn,
            &scope,
            &[Hint {
                id: 7,
                media_type: 15,
                state: 5,
            }],
            false,
        )
        .unwrap();
        let old = next(&conn, &scope).unwrap().unwrap();
        let task = sync::begin(&conn, &scope, "playlist:7", Some("new")).unwrap();
        admit(
            &conn,
            &scope,
            &[Hint {
                id: 7,
                media_type: 15,
                state: 5,
            }],
            false,
        )
        .unwrap();
        assert!(sync::playlist_page_checked(
            &conn,
            &scope,
            7,
            &task,
            &[item(2)],
            Some(1),
            true,
            Some(&old)
        )
        .is_err());
        assert_eq!(
            conn.query_row::<String, _, _>(
                "SELECT generation FROM plex_catalogue_playlist_versions WHERE playlist_id=7",
                [],
                |r| r.get(0)
            )
            .unwrap(),
            "old"
        );
        assert_eq!(
            sync::task(&conn, &scope, "playlist:7")
                .unwrap()
                .unwrap()
                .cursor,
            0
        );
        let current = next(&conn, &scope).unwrap().unwrap();
        let before = progress(&conn, &scope).unwrap().changes_revision;
        assert!(sync::playlist_page_checked(
            &conn,
            &scope,
            7,
            &task,
            &[item(2)],
            Some(1),
            true,
            Some(&current)
        )
        .unwrap()
        .is_some());
        assert_eq!(
            progress(&conn, &scope).unwrap().changes_revision,
            before + 1
        );
    }
    #[test]
    fn finite_census_finishes_under_changing_totals_and_excludes_later_arrivals() {
        let (conn, scope) = fixture();
        let task = begin_keyset(&conn, &scope, "track", 4, Some(4), None, None).unwrap();
        keyset_page(&conn, &scope, &task, "track", &[item(1), item(2)], Some(4)).unwrap();
        let resumed = begin_keyset(&conn, &scope, "track", 999, Some(900), None, None).unwrap();
        assert_eq!(resumed.upper_id, Some(4));
        assert_eq!(resumed.key_cursor, 2);
        assert_eq!(resumed.generation, task.generation);
        assert!(keyset_page(&conn, &scope, &resumed, "track", &[item(2)], Some(90)).is_err());
        assert!(keyset_page(&conn, &scope, &resumed, "track", &[item(5)], Some(90)).is_err());
        keyset_page(&conn, &scope, &resumed, "track", &[item(4)], Some(1)).unwrap();
        let resumed = sync::task(&conn, &scope, "track").unwrap().unwrap();
        keyset_page(&conn, &scope, &resumed, "track", &[], Some(0)).unwrap();
        let done = sync::task(&conn, &scope, "track").unwrap().unwrap();
        assert_eq!(
            (done.status.as_str(), done.cursor, done.total),
            ("complete", 3, Some(3))
        );
        assert!(keyset_page(&conn, &scope, &task, "track", &[item(3)], Some(100)).is_err());
        assert!(catalogue::get(&conn, &scope, "track", 3).unwrap().is_none());
    }
    #[test]
    fn restart_keeps_keyset_checkpoint_and_v8_adopts_partial_v7_without_erasing_raw_or_completed_tasks(
    ) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("catalogue.db");
        let scope = format!("plex-{}", "a".repeat(64));
        let conn = Connection::open(&path).unwrap();
        for sql in [
            include_str!("migrations/V1__initial.sql"),
            include_str!("migrations/V2__offline_snapshots.sql"),
            include_str!("migrations/V3__semantic_vectors.sql"),
            include_str!("migrations/V4__local_audio.sql"),
            include_str!("migrations/V5__plex_catalogue.sql"),
            include_str!("migrations/V6__catalogue_sync.sql"),
            include_str!("migrations/V7__download_entities.sql"),
        ] {
            conn.execute_batch(sql).unwrap();
        }
        conn.pragma_update(None, "user_version", 7).unwrap();
        catalogue::save(&conn, &scope, "track", 17, &item(17), true).unwrap();
        conn.execute("INSERT INTO plex_catalogue_tasks(scope,task,generation,status,cursor,total,updated_at,completed_at) VALUES(?1,'track','old','error',20000,300000,?2,NULL),(?1,'artist','complete-old','complete',8000,8000,?2,?2)",params![scope,now()]).unwrap();
        super::super::schema::run_migrations(&conn).unwrap();
        assert_eq!(
            sync::task(&conn, &scope, "track").unwrap().unwrap().cursor,
            20000
        );
        assert_eq!(
            sync::begin(&conn, &scope, "artist", None)
                .unwrap()
                .generation,
            "complete-old"
        );
        let census = begin_keyset(&conn, &scope, "track", 100, Some(30), None, None).unwrap();
        assert_ne!(census.generation, "old");
        keyset_page(&conn, &scope, &census, "track", &[item(2)], Some(99)).unwrap();
        drop(conn);
        let conn = Connection::open(path).unwrap();
        let resumed = begin_keyset(&conn, &scope, "track", 900, Some(600), None, None).unwrap();
        assert_eq!(resumed.key_cursor, 2);
        assert_eq!(resumed.upper_id, Some(100));
        assert_eq!(resumed.generation, census.generation);
        assert!(catalogue::get(&conn, &scope, "track", 17)
            .unwrap()
            .is_some());
    }
    #[test]
    fn unchanged_listings_reuse_full_details_and_only_real_revision_changes_enter_detail_lane() {
        let (conn, scope) = fixture();
        let listing = item(1);
        super::listing(&conn, &scope, "track", 1, &listing, None, 0).unwrap();
        let job = detail_jobs(&conn, &scope, "track", 0).unwrap().remove(0);
        let mut full = listing.clone();
        full["Media"][0]["Part"][0]["Stream"] =
            serde_json::json!([{"id":8,"streamType":2,"gain":1.0}]);
        full["unknownPrivate"] = serde_json::json!({"future":true});
        assert!(publish_detail(&conn, &scope, "track", &job, &full).unwrap());
        super::listing(&conn, &scope, "track", 1, &listing, None, 0).unwrap();
        assert!(detail_jobs(&conn, &scope, "track", 0).unwrap().is_empty());
        let mut played = listing.clone();
        played["viewCount"] = Value::from(3);
        played["userRating"] = Value::from(5);
        super::listing(&conn, &scope, "track", 1, &played, None, 0).unwrap();
        assert!(detail_jobs(&conn, &scope, "track", 0).unwrap().is_empty());
        let mut changed = listing.clone();
        changed["title"] = Value::from("Renamed");
        changed["updatedAt"] = Value::from(101);
        super::listing(&conn, &scope, "track", 1, &changed, None, 0).unwrap();
        let job = detail_jobs(&conn, &scope, "track", 0).unwrap().remove(0);
        assert_eq!(
            catalogue::get(&conn, &scope, "track", 1).unwrap().unwrap()["unknownPrivate"]["future"],
            true
        );
        admit(&conn, &scope, &[hint(1, 5)], false).unwrap();
        assert!(!publish_detail(&conn, &scope, "track", &job, &changed).unwrap());
    }
    #[test]
    fn queue_coalescing_scope_and_version_fences_preserve_hints_arriving_during_get() {
        let (conn, scope) = fixture();
        admit(&conn, &scope, &[hint(1, 1)], false).unwrap();
        let old = next(&conn, &scope).unwrap().unwrap();
        admit(&conn, &scope, &[hint(1, 9)], false).unwrap();
        assert!(apply(&conn, &scope, &old, Some(&item(1)))
            .unwrap()
            .is_none());
        assert!(catalogue::get(&conn, &scope, "track", 1).unwrap().is_none());
        let current = next(&conn, &scope).unwrap().unwrap();
        assert_eq!(current.state, 9);
        assert_eq!(progress(&conn, &scope).unwrap().pending, 1);
        assert!(apply_with(&conn, &scope, &current, Some(&item(1)), |_| Err(
            "fixture association failure".into()
        ))
        .is_err());
        assert!(catalogue::get(&conn, &scope, "track", 1).unwrap().is_none());
        assert_eq!(progress(&conn, &scope).unwrap().pending, 1);
        let other = format!("plex-{}", "b".repeat(64));
        assert!(apply(&conn, &other, &current, Some(&item(1)))
            .unwrap()
            .is_none());
        assert_eq!(
            apply(&conn, &scope, &current, Some(&item(1))).unwrap(),
            Some(1)
        );
        assert_eq!(progress(&conn, &scope).unwrap().pending, 0);
        assert!(catalogue::get(&conn, &other, "track", 1).unwrap().is_none());
        assert!(admit(&conn, &scope, &[hint(-1, 1)], false).is_err());
        assert!(admit(&conn, &scope, &vec![hint(2, 1); 201], false).is_err());
        assert!(admit(&conn, &scope, &[hint(2, 2)], false).is_err());
        assert_eq!(progress(&conn, &scope).unwrap().pending, 0);
    }
    #[test]
    fn active_catchup_keeps_captured_lower_boundary_when_baseline_seed_moves() {
        let (conn, scope) = fixture();
        let baseline = begin_keyset(&conn, &scope, "artist", 20, Some(20), None, None).unwrap();
        conn.execute(
            "UPDATE plex_catalogue_tasks SET started_at=1000000 WHERE scope=?1 AND task='artist'",
            [&scope],
        )
        .unwrap();
        request_catchup(&conn, &scope).unwrap();
        let window = catchup_begin(&conn, &scope, 2000).unwrap();
        assert_eq!((window.0, window.1), (880, 2000));
        let task = begin_keyset(
            &conn,
            &scope,
            "catchup:artist",
            0,
            Some(0),
            Some(window.0),
            Some(window.1),
        )
        .unwrap();
        keyset_page(&conn, &scope, &task, "artist", &[], Some(0)).unwrap();
        // A baseline/reconciliation can advance independently while the app is
        // closed or the catch-up worker is paused. It cannot shrink this window.
        conn.execute("UPDATE plex_catalogue_tasks SET started_at=1900000,completed_at=1900000 WHERE scope=?1 AND generation=?2",params![scope,baseline.generation]).unwrap();
        assert_eq!(catchup_begin(&conn, &scope, 4000).unwrap(), window);
        for kind in ["album", "track", "playlist"] {
            let low = if kind == "track" {
                Some(1780)
            } else {
                Some(window.0)
            };
            let task = begin_keyset(
                &conn,
                &scope,
                &format!("catchup:{kind}"),
                0,
                Some(0),
                low,
                Some(window.1),
            )
            .unwrap();
            keyset_page(&conn, &scope, &task, kind, &[], Some(0)).unwrap();
        }
        assert!(catchup_finish(&conn, &scope, window.1, window.2).is_err());
        assert!(progress(&conn, &scope).unwrap().watermark.is_none());
        conn.execute(
            "UPDATE plex_catalogue_tasks SET lower_time=?2 WHERE scope=?1 AND task='catchup:track'",
            params![scope, window.0],
        )
        .unwrap();
        catchup_finish(&conn, &scope, window.1, window.2).unwrap();
        assert_eq!(progress(&conn, &scope).unwrap().watermark, Some(window.1));
        assert!(conn
            .query_row::<Option<i64>, _, _>(
                "SELECT catchup_lower FROM plex_catalogue_incremental WHERE scope=?1",
                [&scope],
                |r| r.get(0)
            )
            .unwrap()
            .is_none());
    }
    #[test]
    fn catchup_overlap_resumes_and_only_atomic_complete_windows_advance_watermark() {
        let (conn, scope) = fixture();
        request_catchup(&conn, &scope).unwrap();
        conn.execute(
            "UPDATE plex_catalogue_incremental SET watermark=1000 WHERE scope=?1",
            [&scope],
        )
        .unwrap();
        let (low, high, version) = catchup_begin(&conn, &scope, 2000).unwrap();
        assert_eq!((low, high), (880, 2000));
        assert!(catchup_finish(&conn, &scope, high, version).is_err());
        assert_eq!(progress(&conn, &scope).unwrap().watermark, Some(1000));
        request_catchup(&conn, &scope).unwrap();
        assert_eq!(
            catchup_begin(&conn, &scope, 4000).unwrap(),
            (low, high, version)
        );
        for kind in ["artist", "album", "track", "playlist"] {
            let task = begin_keyset(
                &conn,
                &scope,
                &format!("catchup:{kind}"),
                200,
                Some(0),
                Some(low),
                Some(high),
            )
            .unwrap();
            keyset_page(&conn, &scope, &task, kind, &[], Some(0)).unwrap();
        }
        catchup_finish(&conn, &scope, high, version).unwrap();
        let progress = progress(&conn, &scope).unwrap();
        assert_eq!(progress.watermark, Some(2000));
        assert!(progress.catch_up_requested);
        assert!(!catchup_needed(&conn, &scope).unwrap());
        conn.execute(
            "UPDATE plex_catalogue_incremental SET catchup_started=0 WHERE scope=?1",
            [&scope],
        )
        .unwrap();
        assert!(catchup_needed(&conn, &scope).unwrap());
        assert_eq!(catchup_begin(&conn, &scope, 3000).unwrap().0, 1880);
    }
    #[test]
    fn overflow_is_bounded_and_catchup_backpressure_never_advances_a_lost_page() {
        let (conn, scope) = fixture();
        conn.execute("WITH RECURSIVE n(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM n WHERE id<20000) INSERT INTO plex_catalogue_changes(scope,kind,id,queued_at) SELECT ?1,'track',id,1 FROM n",[&scope]).unwrap();
        admit(&conn, &scope, &[hint(30000, 1)], false).unwrap();
        assert_eq!(progress(&conn, &scope).unwrap().pending, MAX_QUEUE);
        assert!(progress(&conn, &scope).unwrap().catch_up_requested);
        assert_eq!(catchup_begin(&conn, &scope, 2000).unwrap().0, 0);
        let task = begin_keyset(
            &conn,
            &scope,
            "catchup:track",
            50000,
            Some(50000),
            Some(0),
            Some(2000),
        )
        .unwrap();
        assert!(keyset_page(&conn, &scope, &task, "track", &[item(40000)], Some(100)).is_err());
        assert_eq!(
            sync::task(&conn, &scope, "catchup:track")
                .unwrap()
                .unwrap()
                .cursor,
            0
        );
        assert!(catalogue::get(&conn, &scope, "track", 40000)
            .unwrap()
            .is_none());
    }
    #[test]
    fn census_absence_requires_verified_get_and_never_touches_shared_download_or_audio_claims() {
        let (conn, scope) = fixture();
        catalogue::save(&conn, &scope, "track", 2, &item(2), true).unwrap();
        catalogue::save(&conn, &scope, "track", 99, &item(99), true).unwrap();
        conn.execute(
            "UPDATE plex_catalogue SET saved_at=1,listing_saved_at=1",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO local_audio VALUES(?1,2,'shared','flac','{}',1)",
            [&scope],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO audio_download_claims VALUES(?1,'album',7,2),(?1,'playlist',8,2)",
            [&scope],
        )
        .unwrap();
        let task = begin_keyset(&conn, &scope, "track", 5, Some(1), None, None).unwrap();
        keyset_page(&conn, &scope, &task, "track", &[], Some(0)).unwrap();
        reconciliation_candidates(&conn, &scope, &task, "track").unwrap();
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT removed FROM plex_catalogue WHERE id=2", [], |r| r
                .get(0))
                .unwrap(),
            0
        );
        let missing = next(&conn, &scope).unwrap().unwrap();
        assert_eq!(missing.id, 2);
        apply(&conn, &scope, &missing, None).unwrap();
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT removed FROM plex_catalogue WHERE id=2", [], |r| r
                .get(0))
                .unwrap(),
            1
        );
        assert!(catalogue::get(&conn, &scope, "track", 2).unwrap().is_some());
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT COUNT(*) FROM local_audio", [], |r| r.get(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT COUNT(*) FROM audio_download_claims", [], |r| r
                .get(0))
                .unwrap(),
            2
        );
        assert!(next(&conn, &scope).unwrap().is_none());
    }
    #[test]
    fn late_bulk_pages_cannot_overwrite_newer_event_metadata_or_resurrect_confirmed_deletion() {
        let (conn, scope) = fixture();
        let task = begin_keyset(&conn, &scope, "track", 5, Some(5), None, None).unwrap();
        admit(&conn, &scope, &[hint(1, 5)], false).unwrap();
        let current = next(&conn, &scope).unwrap().unwrap();
        let mut latest = item(1);
        latest["title"] = Value::from("Newest");
        latest["updatedAt"] = Value::from(200);
        apply(&conn, &scope, &current, Some(&latest)).unwrap();
        keyset_page_at(&conn, &scope, &task, "track", &[item(1)], Some(1), Some(1)).unwrap();
        assert_eq!(
            catalogue::get(&conn, &scope, "track", 1).unwrap().unwrap()["title"],
            "Newest"
        );
        let job = detail_jobs(&conn, &scope, "track", 0).unwrap();
        assert!(job.is_empty());
        admit(&conn, &scope, &[hint(1, 9)], false).unwrap();
        let current = next(&conn, &scope).unwrap().unwrap();
        apply(&conn, &scope, &current, None).unwrap();
        let restarted = begin_keyset(&conn, &scope, "album", 10, Some(1), None, None).unwrap();
        assert_eq!(restarted.key_cursor, 0);
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT removed FROM plex_catalogue WHERE id=1", [], |r| r
                .get(0))
                .unwrap(),
            1
        );
    }
}
