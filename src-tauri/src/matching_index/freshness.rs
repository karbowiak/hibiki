//! Durable notification hints and timestamp windows. Neither can prove deletion.
use super::{
    row::Row,
    store::{self, Result},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

fn error(_: rusqlite::Error) -> String {
    "Matching freshness storage is unavailable".into()
}
#[derive(Clone, Deserialize)]
pub struct Hint {
    pub id: i64,
    #[serde(rename = "type")]
    pub media_type: i64,
    pub state: i64,
}
pub fn kind(value: i64) -> Option<&'static str> {
    match value {
        8 => Some("artist"),
        9 => Some("album"),
        10 => Some("track"),
        _ => None,
    }
}
fn ensure(conn: &Connection, scope: &str) -> Result<()> {
    store::ensure_scope(conn, scope)?;
    conn.execute(
        "INSERT OR IGNORE INTO matching_health(scope) VALUES(?1)",
        [scope],
    )
    .map_err(error)?;
    Ok(())
}
pub fn offer<G>(
    conn: &Connection,
    scope: &str,
    hints: &[Hint],
    catchup: bool,
    fence: impl FnOnce() -> Result<G>,
) -> Result<()> {
    if hints.len() > 200
        || hints.iter().any(|hint| {
            hint.id <= 0 || kind(hint.media_type).is_none() || ![0, 1, 5, 9].contains(&hint.state)
        })
    {
        return Err("Invalid matching notification batch".into());
    }
    let tx = conn.unchecked_transaction().map_err(error)?;
    ensure(&tx, scope)?;
    let mut count: i64 = tx
        .query_row(
            "SELECT count(*) FROM matching_hints WHERE scope=?1",
            [scope],
            |r| r.get(0),
        )
        .map_err(error)?;
    let mut overflow = false;
    for hint in hints {
        let kind = kind(hint.media_type).unwrap();
        let existing = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM matching_hints WHERE scope=?1 AND kind=?2 AND id=?3)",
                params![scope, kind, hint.id],
                |r| r.get::<_, bool>(0),
            )
            .map_err(error)?;
        if !existing && count >= 10000 {
            overflow = true;
            continue;
        }
        tx.execute("INSERT INTO matching_hints(scope,kind,id,queued_at) VALUES(?1,?2,?3,?4) ON CONFLICT(scope,kind,id) DO UPDATE SET version=version+1,queued_at=excluded.queued_at,attempted_at=0",params![scope,kind,hint.id,store::now()]).map_err(error)?;
        if !existing {
            count += 1
        }
    }
    if catchup || overflow {
        tx.execute("UPDATE matching_health SET wanted=wanted+1,force_census=max(force_census,?2) WHERE scope=?1",params![scope,overflow]).map_err(error)?;
    }
    let _owner = fence()?;
    tx.commit().map_err(error)?;
    Ok(())
}
#[derive(Clone)]
pub struct Lease {
    pub kind: String,
    pub id: i64,
    pub version: i64,
}
pub fn hints(conn: &Connection, scope: &str) -> Result<Vec<Lease>> {
    let mut query=conn.prepare("SELECT kind,id,version FROM matching_hints WHERE scope=?1 AND attempted_at<=?2 ORDER BY attempted_at,queued_at,id LIMIT 25").map_err(error)?;
    let rows = query
        .query_map(params![scope, store::now()], |r| {
            Ok(Lease {
                kind: r.get(0)?,
                id: r.get(1)?,
                version: r.get(2)?,
            })
        })
        .map_err(error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(error)?;
    Ok(rows)
}
pub fn apply_hints<G>(
    conn: &Connection,
    scope: &str,
    epoch: i64,
    lease: &[Lease],
    rows: &[Row],
    missing: &[i64],
    observed: i64,
    fence: impl FnOnce() -> Result<G>,
) -> Result<()> {
    store::admit(conn, scope, epoch)?;
    let tx = conn.unchecked_transaction().map_err(error)?;
    ensure(&tx, scope)?;
    for hint in lease {
        let current = tx
            .query_row(
                "SELECT version=?4 FROM matching_hints WHERE scope=?1 AND kind=?2 AND id=?3",
                params![scope, hint.kind, hint.id, hint.version],
                |r| r.get::<_, bool>(0),
            )
            .optional()
            .map_err(error)?
            .unwrap_or(false);
        if !current {
            continue;
        }
        if let Some(row) = rows
            .iter()
            .find(|row| row.kind == hint.kind && row.id == hint.id)
        {
            store::upsert(&tx, scope, row, observed)?;
        } else if missing.contains(&hint.id) {
            tx.execute(
                "UPDATE matching_health SET force_census=1,wanted=wanted+1 WHERE scope=?1",
                [scope],
            )
            .map_err(error)?;
        } else {
            return Err("Plex did not account for every requested matching identity".into());
        }
        tx.execute(
            "DELETE FROM matching_hints WHERE scope=?1 AND kind=?2 AND id=?3 AND version=?4",
            params![scope, hint.kind, hint.id, hint.version],
        )
        .map_err(error)?;
    }
    store::trim_changes(&tx, scope)?;
    let _owner = fence()?;
    tx.commit().map_err(error)?;
    Ok(())
}
pub fn defer(conn: &Connection, scope: &str, lease: &[Lease]) -> Result<()> {
    let tx = conn.unchecked_transaction().map_err(error)?;
    for hint in lease {
        tx.execute("UPDATE matching_hints SET attempted_at=?5 WHERE scope=?1 AND kind=?2 AND id=?3 AND version=?4",params![scope,hint.kind,hint.id,hint.version,store::now()+30000]).map_err(error)?;
    }
    tx.commit().map_err(error)?;
    Ok(())
}
#[derive(Clone, Deserialize, Serialize, Debug, PartialEq)]
pub struct Filter {
    pub field: String,
    pub sort: String,
    pub operator: String,
}
pub fn filters(meta: &serde_json::Value) -> std::collections::BTreeMap<String, Filter> {
    let mut output = std::collections::BTreeMap::new();
    let operators = meta["FieldType"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|row| row["type"] == "date")
        .and_then(|row| row["Operator"].as_array());
    if !operators.is_some_and(|rows| rows.iter().any(|row| row["key"] == ">>")) {
        return output;
    }
    for entity in meta["Type"].as_array().into_iter().flatten() {
        let Some(kind) = entity["type"]
            .as_str()
            .filter(|kind| ["artist", "album", "track"].contains(kind))
        else {
            continue;
        };
        for field in ["updatedAt", "addedAt"] {
            let candidate = entity["Field"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|row| {
                    row["type"] == "date"
                        && row["key"]
                            .as_str()
                            .is_some_and(|key| key == field || key == format!("{kind}.{field}"))
                });
            let sort = entity["Sort"]
                .as_array()
                .into_iter()
                .flatten()
                .find_map(|row| {
                    row["key"]
                        .as_str()
                        .filter(|key| *key == field || *key == format!("{kind}.{field}"))
                });
            if let (Some(candidate), Some(sort)) = (candidate, sort) {
                output.insert(
                    kind.into(),
                    Filter {
                        field: candidate["key"].as_str().unwrap().into(),
                        sort: format!("{sort}:desc"),
                        operator: ">>".into(),
                    },
                );
                break;
            }
        }
    }
    output
}
pub fn record_census(
    conn: &Connection,
    scope: &str,
    kind: &str,
    generation: &str,
    time: Option<i64>,
) -> Result<()> {
    let Some(time) = time.filter(|value| *value > 0) else {
        return Ok(());
    };
    conn.execute("INSERT INTO matching_refresh(scope,kind,census_generation,census_time) VALUES(?1,?2,?3,?4) ON CONFLICT(scope,kind) DO UPDATE SET census_time=CASE WHEN census_generation=excluded.census_generation THEN min(coalesce(census_time,excluded.census_time),excluded.census_time) ELSE excluded.census_time END,census_generation=excluded.census_generation",params![scope,kind,generation,time]).map_err(error)?;
    Ok(())
}
pub fn complete_census(conn: &Connection, scope: &str, kind: &str, generation: &str) -> Result<()> {
    conn.execute("INSERT OR IGNORE INTO matching_retired(scope,kind,generation) SELECT scope,kind,delta_generation FROM matching_refresh WHERE scope=?1 AND kind=?2 AND census_generation=?3 AND census_time IS NOT NULL AND delta_generation IS NOT NULL AND EXISTS(SELECT 1 FROM matching_tasks WHERE scope=?1 AND kind=?2 AND generation=?3 AND phase='complete')",params![scope,kind,generation]).map_err(error)?;
    conn.execute("UPDATE matching_refresh SET watermark=census_time,last_checked=?4,delta_generation=NULL,delta_lower=NULL,delta_upper=NULL,delta_offset=0,delta_total=NULL,retry_at=0,error=NULL WHERE scope=?1 AND kind=?2 AND census_generation=?3 AND census_time IS NOT NULL AND EXISTS(SELECT 1 FROM matching_tasks WHERE scope=?1 AND kind=?2 AND generation=?3 AND phase='complete')",params![scope,kind,generation,store::now()]).map_err(error)?;
    Ok(())
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub last_check: i64,
    pub pending: i64,
    pub reconciliation_pending: bool,
    pub error: Option<String>,
    pub filters: std::collections::BTreeMap<String, Filter>,
    pub refreshes: Vec<Refresh>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Refresh {
    pub kind: String,
    pub watermark: Option<i64>,
    pub last_checked: i64,
    pub active: bool,
    pub error: Option<String>,
}
pub fn health(conn: &Connection, scope: &str) -> Result<Health> {
    let (last_check, failure, capabilities, reconciliation_pending): (i64, Option<String>, Option<String>, bool) = conn
        .query_row(
            "SELECT last_check,error,capabilities,force_census OR wanted>checked FROM matching_health WHERE scope=?1",
            [scope],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?,r.get(3)?)),
        )
        .optional()
        .map_err(error)?
        .unwrap_or((0, None, None, false));
    let pending = conn
        .query_row(
            "SELECT count(*) FROM matching_hints WHERE scope=?1",
            [scope],
            |r| r.get(0),
        )
        .map_err(error)?;
    let mut query=conn.prepare("SELECT kind,watermark,last_checked,delta_generation IS NOT NULL,error FROM matching_refresh WHERE scope=?1 ORDER BY kind").map_err(error)?;
    let refreshes = query
        .query_map([scope], |r| {
            Ok(Refresh {
                kind: r.get(0)?,
                watermark: r.get(1)?,
                last_checked: r.get(2)?,
                active: r.get(3)?,
                error: r.get(4)?,
            })
        })
        .map_err(error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(error)?;
    Ok(Health {
        last_check,
        pending,
        reconciliation_pending,
        error: failure,
        filters: capabilities
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default(),
        refreshes,
    })
}
#[derive(Clone)]
pub struct Check {
    pub wanted: i64,
    pub old_stamp: Option<String>,
    pub force: bool,
    pub probe: bool,
}
pub fn next_check(conn: &Connection, scope: &str) -> Result<Option<Check>> {
    let saved:Option<(i64,i64,i64,Option<String>,bool,i64,i64)>=conn.query_row("SELECT wanted,checked,last_check,section_stamp,force_census,capabilities_checked,retry_at FROM matching_health WHERE scope=?1",[scope],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional().map_err(error)?;
    let (wanted, checked, last, old_stamp, force, capabilities, retry) =
        saved.unwrap_or((0, -1, 0, None, false, 0, 0));
    let now = store::now();
    Ok((retry <= now
        && (now - last >= 900000 || (wanted > checked || force) && now - last >= 30000))
        .then_some(Check {
            wanted,
            old_stamp,
            force,
            probe: now - capabilities >= 86400000,
        }))
}
pub fn checked<G>(
    conn: &Connection,
    scope: &str,
    epoch: i64,
    job: &Check,
    stamp: Option<&str>,
    scanning: bool,
    capabilities: Option<&std::collections::BTreeMap<String, Filter>>,
    fence: impl FnOnce() -> Result<G>,
) -> Result<()> {
    store::admit(conn, scope, epoch)?;
    let tx = conn.unchecked_transaction().map_err(error)?;
    ensure(&tx, scope)?;
    let changed = stamp.is_some()
        && job
            .old_stamp
            .as_deref()
            .is_some_and(|old| Some(old) != stamp);
    let now = store::now();
    // Reconciliation is listing-only and periodic, never a detail sweep on
    // launch. A complete index is reused unless its section changed or it ages.
    if !scanning {
        tx.execute("INSERT OR IGNORE INTO matching_retired(scope,kind,generation) SELECT scope,kind,generation FROM matching_tasks WHERE scope=?1 AND phase='complete' AND (?2 OR completed<?3)",params![scope,changed||job.force,now-86400000]).map_err(error)?;
        tx.execute("UPDATE matching_tasks SET phase='scan',started=0,retry_at=0,error=NULL WHERE scope=?1 AND phase='complete' AND (?2 OR completed<?3)",params![scope,changed||job.force,now-86400000]).map_err(error)?;
    }
    let raw = capabilities
        .map(serde_json::to_string)
        .transpose()
        .map_err(|_| "Invalid matching capabilities")?;
    tx.execute("UPDATE matching_health SET checked=max(checked,?2),last_check=?3,section_stamp=coalesce(?4,section_stamp),force_census=CASE WHEN wanted=?2 AND ?5=0 THEN 0 ELSE force_census END,capabilities=coalesce(?6,capabilities),capabilities_checked=CASE WHEN ?7 THEN ?3 ELSE capabilities_checked END,retry_at=CASE WHEN ?5 THEN ?3+30000 ELSE 0 END,error=NULL WHERE scope=?1",params![scope,job.wanted,now,stamp,scanning,raw,job.probe]).map_err(error)?;
    if scanning && changed {
        tx.execute(
            "UPDATE matching_health SET force_census=1 WHERE scope=?1",
            [scope],
        )
        .map_err(error)?;
    }
    let _owner = fence()?;
    tx.commit().map_err(error)?;
    Ok(())
}
pub fn defer_check(conn: &Connection, scope: &str, message: &str) -> Result<()> {
    ensure(conn, scope)?;
    conn.execute(
        "UPDATE matching_health SET retry_at=?2,error=?3 WHERE scope=?1",
        params![scope, store::now() + 60000, message],
    )
    .map_err(error)?;
    Ok(())
}
#[derive(Clone)]
pub struct Window {
    pub kind: String,
    pub generation: String,
    pub lower: i64,
    pub upper: Option<i64>,
    pub offset: i64,
    pub total: Option<i64>,
    pub filter: Filter,
}
pub fn delta_due(conn: &Connection, scope: &str, kind: &str) -> Result<bool> {
    if !health(conn, scope)?.filters.contains_key(kind) {
        return Ok(false);
    }
    conn.query_row("SELECT EXISTS(SELECT 1 FROM matching_refresh r JOIN matching_tasks t ON t.scope=r.scope AND t.kind=r.kind WHERE r.scope=?1 AND r.kind=?2 AND t.phase='complete' AND r.watermark IS NOT NULL AND r.retry_at<=?3 AND (r.delta_generation IS NOT NULL OR r.last_checked<?4))",params![scope,kind,store::now(),store::now()-900000],|r|r.get(0)).map_err(error)
}
pub fn delta(conn: &Connection, scope: &str, kind: &str, epoch: i64) -> Result<Option<Window>> {
    store::admit(conn, scope, epoch)?;
    if !delta_due(conn, scope, kind)? {
        return Ok(None);
    }
    let filter = health(conn, scope)?
        .filters
        .remove(kind)
        .ok_or("Matching filter capability changed")?;
    let state:(i64,Option<String>,Option<i64>,Option<i64>,i64,Option<i64>)=conn.query_row("SELECT watermark,delta_generation,delta_lower,delta_upper,delta_offset,delta_total FROM matching_refresh WHERE scope=?1 AND kind=?2",params![scope,kind],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).map_err(error)?;
    let generation = state.1.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    // PMS date filters may round to a calendar day. A whole prior day gives an
    // explicit overlap; no exclusive midnight boundary can hide a recent row.
    let lower = state
        .2
        .unwrap_or(((state.0 - 86400).max(0) / 86400) * 86400);
    conn.execute(
        "UPDATE matching_refresh SET delta_generation=?3,delta_lower=?4 WHERE scope=?1 AND kind=?2",
        params![scope, kind, generation, lower],
    )
    .map_err(error)?;
    Ok(Some(Window {
        kind: kind.into(),
        generation,
        lower,
        upper: state.3,
        offset: state.4,
        total: state.5,
        filter,
    }))
}
pub fn publish_delta<G>(
    conn: &Connection,
    scope: &str,
    epoch: i64,
    job: &Window,
    page: &super::transport::Page,
    observed: i64,
    fence: impl FnOnce() -> Result<G>,
) -> Result<()> {
    store::admit(conn, scope, epoch)?;
    let current=conn.query_row("SELECT delta_generation=?3 AND delta_offset=?4 FROM matching_refresh WHERE scope=?1 AND kind=?2",params![scope,job.kind,job.generation,job.offset],|r|r.get::<_,bool>(0)).optional().map_err(error)?.unwrap_or(false);
    let upper = job
        .upper
        .or(page.server_time)
        .ok_or("Plex did not provide a reliable timestamp checkpoint")?;
    let watermark: i64 = conn
        .query_row(
            "SELECT watermark FROM matching_refresh WHERE scope=?1 AND kind=?2",
            params![scope, job.kind],
            |r| r.get(0),
        )
        .map_err(error)?;
    if upper < watermark {
        return Err("Plex timestamp checkpoint moved backwards".into());
    }
    if !current
        || page.rows.len() > 500
        || page.total < 0
        || job.total.is_some_and(|total| total != page.total)
        || job.offset + page.rows.len() as i64 > page.total
        || page.rows.is_empty() && job.offset < page.total
    {
        return Err("Plex changed its incremental window; checkpoint retained".into());
    }
    let tx = conn.unchecked_transaction().map_err(error)?;
    for row in &page.rows {
        let timestamp = if job.filter.field.ends_with("updatedAt") {
            row.updated
        } else {
            row.added
        };
        if row.kind != job.kind || timestamp.is_none_or(|time| time < job.lower) {
            return Err("Plex did not honor its timestamp filter".into());
        }
        tx.execute(
            "INSERT INTO matching_seen(scope,kind,generation,id,revision) VALUES(?1,?2,?3,?4,?5)",
            params![scope, job.kind, job.generation, row.id, row.revision],
        )
        .map_err(|_| "Plex repeated an incremental identity; checkpoint retained")?;
        store::upsert(&tx, scope, row, observed)?;
    }
    let end = job.offset + page.rows.len() as i64;
    let done = end == page.total;
    if done {
        tx.execute(
            "INSERT OR IGNORE INTO matching_retired(scope,kind,generation) VALUES(?1,?2,?3)",
            params![scope, job.kind, job.generation],
        )
        .map_err(error)?;
        tx.execute("UPDATE matching_refresh SET watermark=max(watermark,?3),last_checked=?4,delta_generation=NULL,delta_lower=NULL,delta_upper=NULL,delta_offset=0,delta_total=NULL,retry_at=0,error=NULL WHERE scope=?1 AND kind=?2",params![scope,job.kind,upper,store::now()]).map_err(error)?;
    } else {
        tx.execute("UPDATE matching_refresh SET delta_upper=?3,delta_offset=?4,delta_total=?5,error=NULL,retry_at=0 WHERE scope=?1 AND kind=?2",params![scope,job.kind,upper,end,page.total]).map_err(error)?;
    }
    store::trim_changes(&tx, scope)?;
    let _owner = fence()?;
    tx.commit().map_err(error)?;
    Ok(())
}
pub fn defer_delta(
    conn: &Connection,
    scope: &str,
    job: &Window,
    reset: bool,
    message: &str,
) -> Result<()> {
    let tx = conn.unchecked_transaction().map_err(error)?;
    if reset {
        tx.execute(
            "INSERT OR IGNORE INTO matching_retired(scope,kind,generation) VALUES(?1,?2,?3)",
            params![scope, job.kind, job.generation],
        )
        .map_err(error)?;
        tx.execute("UPDATE matching_refresh SET delta_generation=NULL,delta_lower=NULL,delta_upper=NULL,delta_offset=0,delta_total=NULL WHERE scope=?1 AND kind=?2 AND delta_generation=?3",params![scope,job.kind,job.generation]).map_err(error)?;
    }
    tx.execute(
        "UPDATE matching_refresh SET retry_at=?3,error=?4 WHERE scope=?1 AND kind=?2",
        params![scope, job.kind, store::now() + 60000, message],
    )
    .map_err(error)?;
    if message.contains("timestamp filter") || message.contains("timestamp checkpoint") {
        let mut filters = health(&tx, scope)?.filters;
        filters.remove(&job.kind);
        tx.execute(
            "UPDATE matching_health SET capabilities=?2,error=?3,force_census=1 WHERE scope=?1",
            params![
                scope,
                serde_json::to_string(&filters).map_err(|_| "Invalid matching capabilities")?,
                "Timestamp filtering is unavailable. Using verified reconciliation."
            ],
        )
        .map_err(error)?;
    }
    tx.commit().map_err(error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const S: &str = "plex-refresh-fixture";
    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        ensure(&conn, S).unwrap();
        conn
    }
    fn hint(id: i64) -> Hint {
        Hint {
            id,
            media_type: 10,
            state: 5,
        }
    }
    fn row(id: i64, title: &str, time: i64) -> Row {
        super::super::row::parse(&json!({"type":"track","ratingKey":id,"title":title,"librarySectionID":4,"parentRatingKey":2,"grandparentRatingKey":1,"parentTitle":"Album","grandparentTitle":"Artist","updatedAt":time,"addedAt":time}),"track",4).unwrap()
    }
    fn capability() -> std::collections::BTreeMap<String, Filter> {
        filters(
            &json!({"FieldType":[{"type":"date","Operator":[{"key":">>"}]}],"Type":[{"type":"track","Field":[{"key":"track.updatedAt","type":"date"}],"Sort":[{"key":"track.updatedAt"}]}]}),
        )
    }
    fn ready(conn: &Connection) {
        let task = store::begin(conn, S, "track", 0).unwrap();
        for _ in 0..2 {
            let task = store::status(conn, S).unwrap().tasks[0].clone();
            store::publish(conn, S, &task, 0, &[], 0, 0).unwrap();
        }
        let prune = store::status(conn, S).unwrap().tasks[0].clone();
        store::prune_fenced(conn, S, &prune, 0, || {
            record_census(conn, S, "track", &task.generation, Some(1700000000))?;
            complete_census(conn, S, "track", &task.generation)
        })
        .unwrap();
        let job = next_check(conn, S).unwrap().unwrap();
        checked(
            conn,
            S,
            0,
            &job,
            Some("initial"),
            false,
            Some(&capability()),
            || Ok(()),
        )
        .unwrap();
        conn.execute(
            "UPDATE matching_refresh SET last_checked=0 WHERE scope=?1",
            [S],
        )
        .unwrap();
    }
    fn page(rows: Vec<Row>, total: i64, time: Option<i64>) -> super::super::transport::Page {
        super::super::transport::Page {
            rows,
            total,
            bytes: 1,
            server_time: time,
        }
    }
    fn scalar(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [S], |r| r.get(0)).unwrap()
    }

    #[test]
    fn coalesced_hints_cannot_ack_or_publish_a_successor_and_missing_is_not_deletion() {
        let conn = db();
        offer(&conn, S, &[hint(7)], false, || Ok(())).unwrap();
        let old = hints(&conn, S).unwrap();
        offer(&conn, S, &[hint(7)], false, || Ok(())).unwrap();
        apply_hints(&conn, S, 0, &old, &[row(7, "old", 1)], &[], 10, || Ok(())).unwrap();
        assert_eq!(
            scalar(&conn, "SELECT count(*) FROM matching_rows WHERE scope=?1"),
            0
        );
        assert_eq!(hints(&conn, S).unwrap()[0].version, 2);
        defer(&conn, S, &old).unwrap();
        let lease = hints(&conn, S).unwrap();
        apply_hints(&conn, S, 0, &lease, &[row(7, "fresh", 2)], &[], 20, || {
            Ok(())
        })
        .unwrap();
        assert_eq!(health(&conn, S).unwrap().pending, 0);
        // A late census/detail response cannot undo a more recent observation.
        assert!(!store::upsert(&conn, S, &row(7, "old", 1), 10).unwrap());
        offer(&conn, S, &[hint(7)], false, || Ok(())).unwrap();
        apply_hints(
            &conn,
            S,
            0,
            &hints(&conn, S).unwrap(),
            &[],
            &[7],
            30,
            || Ok(()),
        )
        .unwrap();
        assert_eq!(
            scalar(&conn, "SELECT removed FROM matching_rows WHERE scope=?1"),
            0
        );
        assert!(health(&conn, S).unwrap().reconciliation_pending);
        assert_eq!(
            scalar(
                &conn,
                "SELECT count(*) FROM matching_changes WHERE scope=?1 AND kind='track'"
            ),
            1
        );
    }

    #[test]
    fn hint_bounds_failures_and_owner_retirement_keep_work_and_rows_atomic() {
        let conn = db();
        assert!(offer(&conn, S, &[hint(-1)], false, || Ok(())).is_err());
        assert!(offer(
            &conn,
            S,
            &(1..=201).map(hint).collect::<Vec<_>>(),
            false,
            || Ok(())
        )
        .is_err());
        for first in (1..=10000).step_by(200) {
            offer(
                &conn,
                S,
                &(first..first + 200).map(hint).collect::<Vec<_>>(),
                false,
                || Ok(()),
            )
            .unwrap();
        }
        offer(&conn, S, &[hint(10001), hint(1)], false, || Ok(())).unwrap();
        assert_eq!(health(&conn, S).unwrap().pending, 10000);
        assert!(health(&conn, S).unwrap().reconciliation_pending);
        let lease = hints(&conn, S).unwrap();
        let rows: Vec<_> = lease.iter().map(|h| row(h.id, "new", 1)).collect();
        assert!(
            apply_hints(&conn, S, 0, &lease, &rows, &[], 30, || Err::<(), _>(
                "retired".into()
            ))
            .is_err()
        );
        assert_eq!(
            scalar(&conn, "SELECT count(*) FROM matching_rows WHERE scope=?1"),
            0
        );
        assert_eq!(health(&conn, S).unwrap().pending, 10000);
        defer(&conn, S, &lease).unwrap();
        assert!(hints(&conn, S)
            .unwrap()
            .iter()
            .all(|h| !lease.iter().any(|old| old.id == h.id)));
        store::control(&conn, S, "pause").unwrap();
        assert!(apply_hints(&conn, S, 0, &lease, &rows, &[], 30, || Ok(())).is_err());
    }

    #[test]
    fn rematches_reparenting_and_versions_publish_new_compact_evidence() {
        let conn = db();
        store::upsert(&conn, S, &row(7, "Original", 1), 1).unwrap();
        let before = scalar(&conn, "SELECT revision FROM matching_scopes WHERE scope=?1");
        let changed=super::super::row::parse(&json!({"type":"track","ratingKey":7,"librarySectionID":4,"title":"Rematched (Live)","parentRatingKey":22,"grandparentRatingKey":11,"parentTitle":"New release","grandparentTitle":"New artist","editionTitle":"Live","updatedAt":2,"Guid":[{"id":"musicbrainz://recording/12345678-1234-1234-1234-123456789012"}]}),"track",4).unwrap();
        offer(&conn, S, &[hint(7)], false, || Ok(())).unwrap();
        apply_hints(
            &conn,
            S,
            0,
            &hints(&conn, S).unwrap(),
            &[changed],
            &[],
            2,
            || Ok(()),
        )
        .unwrap();
        assert!(scalar(&conn, "SELECT revision FROM matching_scopes WHERE scope=?1") > before);
        assert_eq!(
            scalar(&conn, "SELECT artist_id FROM matching_rows WHERE scope=?1"),
            11
        );
        assert_eq!(
            scalar(&conn, "SELECT album_id FROM matching_rows WHERE scope=?1"),
            22
        );
        let title: String = conn
            .query_row("SELECT title FROM matching_rows WHERE scope=?1", [S], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(title, "Rematched (Live)");
        assert_eq!(scalar(&conn,"SELECT count(*) FROM matching_identifiers WHERE scope=?1 AND scheme='musicbrainz:recording'"),1);
    }

    #[test]
    fn only_advertised_whitelisted_date_filters_with_sort_and_operator_are_used() {
        let valid = capability();
        assert_eq!(valid["track"].field, "track.updatedAt");
        assert_eq!(valid["track"].sort, "track.updatedAt:desc");
        for meta in [
            json!({}),
            json!({"FieldType":[{"type":"date","Operator":[{"key":"="}]}]}),
            json!({"FieldType":[{"type":"date","Operator":[{"key":">>"}]}],"Type":[{"type":"track","Field":[{"key":"title","type":"date"}],"Sort":[{"key":"title"}]}]}),
        ] {
            assert!(filters(&meta).is_empty());
        }
    }

    #[test]
    fn incremental_window_resumes_from_disk_and_advances_only_after_all_pages() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("refresh.db");
        let conn = Connection::open(&path).unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        ensure(&conn, S).unwrap();
        ready(&conn);
        let job = delta(&conn, S, "track", 0).unwrap().unwrap();
        assert_eq!(job.lower, ((1700000000 - 86400) / 86400) * 86400);
        publish_delta(
            &conn,
            S,
            0,
            &job,
            &page(vec![row(7, "one", 1700000001)], 2, Some(1700000100)),
            30,
            || Ok(()),
        )
        .unwrap();
        assert_eq!(
            scalar(
                &conn,
                "SELECT watermark FROM matching_refresh WHERE scope=?1"
            ),
            1700000000
        );
        drop(conn);
        let conn = Connection::open(&path).unwrap();
        let resumed = delta(&conn, S, "track", 0).unwrap().unwrap();
        assert_eq!(resumed.generation, job.generation);
        assert_eq!(resumed.offset, 1);
        assert_eq!(resumed.upper, Some(1700000100));
        assert!(publish_delta(
            &conn,
            S,
            0,
            &resumed,
            &page(vec![row(8, "two", 1700000002)], 3, Some(1700000200)),
            40,
            || Ok(())
        )
        .is_err());
        publish_delta(
            &conn,
            S,
            0,
            &resumed,
            &page(vec![row(8, "two", 1700000002)], 2, Some(1700000200)),
            40,
            || Ok(()),
        )
        .unwrap();
        assert_eq!(
            scalar(
                &conn,
                "SELECT watermark FROM matching_refresh WHERE scope=?1"
            ),
            1700000100
        );
        assert!(!health(&conn, S).unwrap().refreshes[0].active);
        assert_eq!(
            scalar(&conn, "SELECT count(*) FROM matching_rows WHERE scope=?1"),
            2
        );
    }

    #[test]
    fn broken_filter_clock_rollback_and_missing_date_fall_back_without_advancing() {
        for mode in 0..3 {
            let conn = db();
            ready(&conn);
            let job = delta(&conn, S, "track", 0).unwrap().unwrap();
            let candidate = page(
                vec![row(7, "bad", if mode == 0 { 1 } else { 1700000001 })],
                1,
                match mode {
                    1 => None,
                    2 => Some(1600000000),
                    _ => Some(1700000100),
                },
            );
            let error = publish_delta(&conn, S, 0, &job, &candidate, 30, || Ok(())).unwrap_err();
            defer_delta(&conn, S, &job, true, &error).unwrap();
            assert!(health(&conn, S).unwrap().filters.is_empty());
            assert!(health(&conn, S).unwrap().reconciliation_pending);
            assert_eq!(
                scalar(
                    &conn,
                    "SELECT watermark FROM matching_refresh WHERE scope=?1"
                ),
                1700000000
            );
            assert_eq!(
                scalar(&conn, "SELECT count(*) FROM matching_rows WHERE scope=?1"),
                0
            );
        }
    }

    #[test]
    fn incremental_duplicate_storage_failure_and_retirement_retain_checkpoint() {
        let conn = db();
        ready(&conn);
        let first = delta(&conn, S, "track", 0).unwrap().unwrap();
        publish_delta(
            &conn,
            S,
            0,
            &first,
            &page(vec![row(7, "one", 1700000001)], 2, Some(1700000100)),
            30,
            || Ok(()),
        )
        .unwrap();
        let next = delta(&conn, S, "track", 0).unwrap().unwrap();
        assert!(publish_delta(
            &conn,
            S,
            0,
            &next,
            &page(vec![row(7, "one", 1700000001)], 2, Some(1700000100)),
            40,
            || Ok(())
        )
        .is_err());
        assert!(publish_delta(
            &conn,
            S,
            0,
            &next,
            &page(vec![row(8, "two", 1700000001)], 2, Some(1700000100)),
            40,
            || Err::<(), _>("retired".into())
        )
        .is_err());
        assert_eq!(
            scalar(&conn, "SELECT count(*) FROM matching_rows WHERE scope=?1"),
            1
        );
        assert_eq!(delta(&conn, S, "track", 0).unwrap().unwrap().offset, 1);
        conn.execute_batch("CREATE TRIGGER fail_refresh BEFORE UPDATE ON matching_refresh BEGIN SELECT RAISE(ABORT,'disk failed'); END").unwrap();
        assert!(publish_delta(
            &conn,
            S,
            0,
            &next,
            &page(vec![row(8, "two", 1700000001)], 2, Some(1700000100)),
            40,
            || Ok(())
        )
        .is_err());
        assert_eq!(
            scalar(&conn, "SELECT count(*) FROM matching_rows WHERE scope=?1"),
            1
        );
        conn.execute_batch("DROP TRIGGER fail_refresh").unwrap();
        defer_delta(&conn, S, &next, false, "network").unwrap();
        assert!(delta(&conn, S, "track", 0).unwrap().is_none());
        assert_eq!(
            scalar(
                &conn,
                "SELECT delta_offset FROM matching_refresh WHERE scope=?1"
            ),
            1
        );
    }

    #[test]
    fn completed_inventory_is_reused_but_changed_scanning_and_periodic_checks_reconcile() {
        let conn = db();
        ready(&conn);
        conn.execute(
            "UPDATE matching_health SET last_check=0 WHERE scope=?1",
            [S],
        )
        .unwrap();
        let same = next_check(&conn, S).unwrap().unwrap();
        checked(&conn, S, 0, &same, Some("initial"), false, None, || Ok(())).unwrap();
        assert_eq!(store::status(&conn, S).unwrap().tasks[0].phase, "complete");
        conn.execute(
            "UPDATE matching_health SET last_check=0 WHERE scope=?1",
            [S],
        )
        .unwrap();
        let changed = next_check(&conn, S).unwrap().unwrap();
        checked(
            &conn,
            S,
            0,
            &changed,
            Some("changed"),
            true,
            None,
            || Ok(()),
        )
        .unwrap();
        assert_eq!(store::status(&conn, S).unwrap().tasks[0].phase, "complete");
        assert!(health(&conn, S).unwrap().reconciliation_pending);
        conn.execute(
            "UPDATE matching_health SET last_check=0,retry_at=0 WHERE scope=?1",
            [S],
        )
        .unwrap();
        let after_scan = next_check(&conn, S).unwrap().unwrap();
        checked(
            &conn,
            S,
            0,
            &after_scan,
            Some("changed"),
            false,
            None,
            || Ok(()),
        )
        .unwrap();
        assert_eq!(store::status(&conn, S).unwrap().tasks[0].started, 0);
        assert_eq!(store::status(&conn, S).unwrap().tasks[0].phase, "scan");
        assert_eq!(
            scalar(
                &conn,
                "SELECT watermark FROM matching_refresh WHERE scope=?1"
            ),
            1700000000
        );
        // Explicit user clear owns only evidence, not arbitrary user state.
        store::control(&conn, S, "clear").unwrap();
        assert_eq!(health(&conn, S).unwrap().pending, 0);
        assert!(health(&conn, S).unwrap().refreshes.is_empty());
    }
}
