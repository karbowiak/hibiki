use super::row::Row;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub type Result<T> = std::result::Result<T, String>;
pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn error(_: rusqlite::Error) -> String {
    "Matching index storage is unavailable".into()
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub kind: String,
    pub generation: String,
    pub phase: String,
    pub offset: i64,
    pub total: Option<i64>,
    pub digest: String,
    pub verify_digest: String,
    pub prune_cursor: i64,
    pub started: i64,
    pub completed: Option<i64>,
    pub count: i64,
    pub requests: i64,
    pub bytes: i64,
    pub error: Option<String>,
    pub retry_at: i64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub paused: bool,
    pub epoch: i64,
    pub revision: i64,
    pub tasks: Vec<Task>,
    pub health: super::freshness::Health,
}
pub fn status(conn: &Connection, scope: &str) -> Result<Status> {
    let (paused, epoch, revision) = conn
        .query_row(
            "SELECT paused,epoch,revision FROM matching_scopes WHERE scope=?1",
            [scope],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(error)?
        .unwrap_or((false, 0, 0));
    let mut query=conn.prepare("SELECT kind,generation,phase,offset,total,digest,verify_digest,prune_cursor,started,completed,count,requests,bytes,error,retry_at FROM matching_tasks WHERE scope=?1 ORDER BY kind").map_err(error)?;
    let tasks = query
        .query_map([scope], |r| {
            Ok(Task {
                kind: r.get(0)?,
                generation: r.get(1)?,
                phase: r.get(2)?,
                offset: r.get(3)?,
                total: r.get(4)?,
                digest: r.get(5)?,
                verify_digest: r.get(6)?,
                prune_cursor: r.get(7)?,
                started: r.get(8)?,
                completed: r.get(9)?,
                count: r.get(10)?,
                requests: r.get(11)?,
                bytes: r.get(12)?,
                error: r.get(13)?,
                retry_at: r.get(14)?,
            })
        })
        .map_err(error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(error)?;
    Ok(Status {
        paused,
        epoch,
        revision,
        tasks,
        health: super::freshness::health(conn, scope)?,
    })
}
pub fn ensure_scope(conn: &Connection, scope: &str) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO matching_scopes(scope) VALUES(?1)",
        [scope],
    )
    .map_err(error)?;
    Ok(())
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub sequence: i64,
    pub kind: String,
    pub id: i64,
    pub title_key:Option<String>,
    pub artist_id:Option<i64>,
    pub album_id:Option<i64>,
    pub observed:Option<i64>,
    pub removed:Option<bool>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    pub revision: i64,
    pub coverage: String,
    pub cursor: i64,
    pub reset: bool,
    pub changes: Vec<Change>,
}
pub fn changes(conn: &Connection, scope: &str, since: i64) -> Result<Changes> {
    if since < 0 {
        return Err("Invalid matching change cursor".into());
    }
    let revision: i64 = conn
        .query_row(
            "SELECT revision FROM matching_scopes WHERE scope=?1",
            [scope],
            |r| r.get(0),
        )
        .optional()
        .map_err(error)?
        .unwrap_or(0);
    let oldest: Option<i64> = conn
        .query_row(
            "SELECT min(sequence) FROM matching_changes WHERE scope=?1",
            [scope],
            |r| r.get(0),
        )
        .map_err(error)?;
    let coverage:String=conn.query_row("SELECT coalesce(group_concat(value,'|'),'') FROM (SELECT kind||':'||phase||':'||generation||':'||coalesce(completed,0) AS value FROM matching_tasks WHERE scope=?1 ORDER BY kind)",[scope],|r|r.get(0)).map_err(error)?;
    let coverage = hex::encode(Sha256::digest(coverage.as_bytes()));
    let reset = since > revision || since < revision && oldest.is_none_or(|old| since < old - 1);
    if reset {
        return Ok(Changes {
            revision,
            coverage,
            cursor: revision,
            reset,
            changes: vec![],
        });
    }
    let mut query=conn.prepare("SELECT c.sequence,c.kind,c.id,r.title_key,r.artist_id,r.album_id,r.observed,r.removed FROM matching_changes c LEFT JOIN matching_rows r ON r.scope=c.scope AND r.kind=c.kind AND r.id=c.id WHERE c.scope=?1 AND c.sequence>?2 ORDER BY c.sequence,c.kind,c.id LIMIT 201").map_err(error)?;
    let mut changes = query
        .query_map(params![scope, since], |r| {
            Ok(Change {
                sequence: r.get(0)?,
                kind: r.get(1)?,
                id: r.get(2)?,
                title_key:r.get(3)?,artist_id:r.get(4)?,album_id:r.get(5)?,observed:r.get(6)?,removed:r.get(7)?,
            })
        })
        .map_err(error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(error)?;
    if changes.len() > 200 {
        let boundary = changes[200].sequence;
        changes.truncate(200);
        // Never split one atomic row/relationship change across cursors.
        if changes.last().is_some_and(|last| last.sequence == boundary) {
            changes.retain(|row| row.sequence != boundary)
        }
    }
    let cursor = changes.last().map(|row| row.sequence).unwrap_or(revision);
    Ok(Changes {
        revision,
        coverage,
        cursor,
        reset: false,
        changes,
    })
}
pub fn admit(conn: &Connection, scope: &str, epoch: i64) -> Result<()> {
    if !conn
        .query_row(
            "SELECT epoch=?2 AND paused=0 FROM matching_scopes WHERE scope=?1",
            params![scope, epoch],
            |r| r.get::<_, bool>(0),
        )
        .optional()
        .map_err(error)?
        .unwrap_or(false)
    {
        return Err("Matching index job was superseded".into());
    }
    Ok(())
}
pub fn control(conn: &Connection, scope: &str, action: &str) -> Result<Status> {
    let tx = conn.unchecked_transaction().map_err(error)?;
    ensure_scope(&tx, scope)?;
    match action {
        "pause" | "resume" => {
            tx.execute(
                "UPDATE matching_scopes SET paused=?2,epoch=epoch+1 WHERE scope=?1",
                params![scope, action == "pause"],
            )
            .map_err(error)?;
        }
        "rebuild" | "clear" => {
            // Clear only this evidence lifecycle; never ratings, queues or downloads.
            tx.execute("INSERT OR IGNORE INTO matching_retired(scope,kind,generation) SELECT scope,kind,generation FROM matching_tasks WHERE scope=?1",[scope]).map_err(error)?;
            tx.execute("DELETE FROM matching_tasks WHERE scope=?1", [scope])
                .map_err(error)?;
            if action == "clear" {
                tx.execute("DELETE FROM matching_seen WHERE scope=?1", [scope])
                    .map_err(error)?;
                tx.execute("DELETE FROM matching_retired WHERE scope=?1", [scope])
                    .map_err(error)?;
                tx.execute("DELETE FROM matching_changes WHERE scope=?1", [scope])
                    .map_err(error)?;
                for table in [
                    "matching_hints",
                    "matching_health",
                    "matching_refresh",
                    "matching_associations",
                    "matching_relationships",
                ] {
                    tx.execute(&format!("DELETE FROM {table} WHERE scope=?1"), [scope])
                        .map_err(error)?;
                }
                tx.execute("DELETE FROM matching_rows WHERE scope=?1", [scope])
                    .map_err(error)?;
            }
            tx.execute("UPDATE matching_scopes SET paused=?2,epoch=epoch+1,revision=revision+1 WHERE scope=?1",params![scope,action=="clear"]).map_err(error)?;
        }
        _ => return Err("Unknown matching index action".into()),
    }
    tx.commit().map_err(error)?;
    status(conn, scope)
}
pub fn begin(conn: &Connection, scope: &str, kind: &str, epoch: i64) -> Result<Task> {
    admit(conn, scope, epoch)?;
    let saved = status(conn, scope)?
        .tasks
        .into_iter()
        .find(|task| task.kind == kind);
    if let Some(saved) = saved {
        if saved.phase == "complete" || saved.retry_at > now() || now() - saved.started < 86_400_000
        {
            return Ok(saved);
        }
    }
    let tx = conn.unchecked_transaction().map_err(error)?;
    tx.execute("INSERT OR IGNORE INTO matching_retired(scope,kind,generation) SELECT scope,kind,generation FROM matching_tasks WHERE scope=?1 AND kind=?2",params![scope,kind]).map_err(error)?;
    tx.execute("INSERT INTO matching_tasks(scope,kind,generation,started) VALUES(?1,?2,?3,?4) ON CONFLICT(scope,kind) DO UPDATE SET generation=excluded.generation,phase='scan',offset=0,total=NULL,digest='',verify_digest='',prune_cursor=0,started=excluded.started,error=NULL,failures=0,retry_at=0",params![scope,kind,uuid::Uuid::new_v4().to_string(),now()]).map_err(error)?;
    tx.commit().map_err(error)?;
    status(conn, scope)?
        .tasks
        .into_iter()
        .find(|task| task.kind == kind)
        .ok_or("Matching index checkpoint missing".into())
}
pub fn current(conn: &Connection, scope: &str, task: &Task, epoch: i64) -> Result<()> {
    admit(conn, scope, epoch)?;
    let current=conn.query_row("SELECT generation=?3 AND phase=?4 AND offset=?5 FROM matching_tasks WHERE scope=?1 AND kind=?2",params![scope,task.kind,task.generation,task.phase,task.offset],|r|r.get::<_,bool>(0)).optional().map_err(error)?.unwrap_or(false);
    if !current {
        return Err("Matching index page was superseded".into());
    }
    Ok(())
}
pub fn upsert(conn: &Connection, scope: &str, row: &Row, observed: i64) -> Result<bool> {
    let old: Option<(String, bool, i64,Option<i64>,Option<i64>)> = conn
        .query_row(
            "SELECT revision,removed,observed,artist_id,album_id FROM matching_rows WHERE scope=?1 AND kind=?2 AND id=?3",
            params![scope, row.kind, row.id],
            |r| Ok((r.get(0)?, r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)),
        )
        .optional()
        .map_err(error)?;
    if old
        .as_ref()
        .is_some_and(|(_, _, previous, _, _)| *previous > observed)
    {
        return Ok(false);
    }
    let changed = old
        .as_ref()
        .is_none_or(|(revision, removed, _, _, _)| *removed || revision != &row.revision);
    let mut evidence = serde_json::to_value(row).map_err(|_| "Invalid matching evidence")?;
    // Indexed columns carry these values already. Retain only additional typed
    // evidence in JSON, without null padding or duplicated normalized strings.
    evidence
        .as_object_mut()
        .ok_or("Invalid matching evidence")?
        .retain(|field, value| {
            !value.is_null()
                && ![
                    "kind",
                    "id",
                    "title",
                    "titleKey",
                    "artistKey",
                    "artistId",
                    "albumId",
                    "duration",
                    "revision",
                ]
                .contains(&field.as_str())
        });
    let payload = serde_json::to_string(&evidence).map_err(|_| "Invalid matching evidence")?;
    conn.execute("INSERT INTO matching_rows(scope,kind,id,title,title_key,artist_key,artist_id,album_id,duration,evidence,revision,observed) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) ON CONFLICT(scope,kind,id) DO UPDATE SET title=excluded.title,title_key=excluded.title_key,artist_key=excluded.artist_key,artist_id=excluded.artist_id,album_id=excluded.album_id,duration=excluded.duration,evidence=excluded.evidence,revision=excluded.revision,observed=excluded.observed,removed=0",params![scope,row.kind,row.id,row.title,row.title_key,row.artist_key,row.artist_id,row.album_id,row.duration,payload,row.revision,observed]).map_err(error)?;
    if changed {
        if let Some((_, _, _, artist, album)) = &old {
            for (kind, previous, current) in [
                ("artist", *artist, row.artist_id),
                ("album", *album, row.album_id),
            ] {
                if previous != current {
                    if let Some(id) = previous {
                        touch_relationship(conn, scope, kind, id)?;
                    }
                }
            }
        }
        conn.execute(
            "DELETE FROM matching_identifiers WHERE scope=?1 AND kind=?2 AND id=?3",
            params![scope, row.kind, row.id],
        )
        .map_err(error)?;
        for identifier in &row.identifiers {
            conn.execute("INSERT INTO matching_identifiers(scope,kind,id,scheme,value) VALUES(?1,?2,?3,?4,?5)",params![scope,row.kind,row.id,identifier.scheme,identifier.value]).map_err(error)?;
        }
        changed_row(conn, scope, &row.kind, row.id)?;
    }
    Ok(changed)
}
pub fn changed_row(conn: &Connection, scope: &str, kind: &str, id: i64) -> Result<()> {
    let (artist, album): (Option<i64>, Option<i64>) = conn
        .query_row(
            "SELECT artist_id,album_id FROM matching_rows WHERE scope=?1 AND kind=?2 AND id=?3",
            params![scope, kind, id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(error)?;
    let mut relationships = std::collections::BTreeSet::new();
    if kind != "track" {
        relationships.insert((kind, id));
    }
    if let Some(id) = artist {
        relationships.insert(("artist", id));
    }
    if let Some(id) = album {
        relationships.insert(("album", id));
    }
    for (kind, id) in relationships {
        touch_relationship(conn, scope, kind, id)?;
    }
    conn.execute(
        "UPDATE matching_scopes SET revision=revision+1 WHERE scope=?1",
        [scope],
    )
    .map_err(error)?;
    conn.execute("INSERT OR IGNORE INTO matching_changes(scope,sequence,kind,id) SELECT scope,revision,?2,?3 FROM matching_scopes WHERE scope=?1",params![scope,kind,id]).map_err(error)?;
    Ok(())
}
fn touch_relationship(conn: &Connection, scope: &str, kind: &str, id: i64) -> Result<()> {
    conn.execute("INSERT INTO matching_relationships(scope,kind,id) VALUES(?1,?2,?3) ON CONFLICT(scope,kind,id) DO UPDATE SET revision=revision+1",params![scope,kind,id]).map_err(error)?;
    conn.execute("INSERT OR IGNORE INTO matching_changes(scope,sequence,kind,id) SELECT scope,revision+1,?2,?3 FROM matching_scopes WHERE scope=?1",params![scope,kind,id]).map_err(error)?;
    Ok(())
}
#[cfg(test)]
pub fn publish(
    conn: &Connection,
    scope: &str,
    task: &Task,
    epoch: i64,
    rows: &[Row],
    total: i64,
    bytes: i64,
) -> Result<()> {
    publish_fenced(conn, scope, task, epoch, rows, total, bytes, || Ok(()))
}
pub fn publish_fenced<G>(
    conn: &Connection,
    scope: &str,
    task: &Task,
    epoch: i64,
    rows: &[Row],
    total: i64,
    bytes: i64,
    fence: impl FnOnce() -> Result<G>,
) -> Result<()> {
    current(conn, scope, task, epoch)?;
    if !["scan", "verify"].contains(&task.phase.as_str())
        || total < 0
        || task.total.is_some_and(|n| n != total)
        || task.offset + rows.len() as i64 > total
        || rows.len() > 500
        || rows.is_empty() && task.offset < total
    {
        return Err("Plex library changed or stopped advancing during its census".into());
    }
    let tx = conn.unchecked_transaction().map_err(error)?;
    let mut digest = Sha256::new();
    digest.update(if task.phase == "scan" {
        &task.digest
    } else {
        &task.verify_digest
    });
    for row in rows {
        if row.kind != task.kind {
            return Err("Wrong matching census kind".into());
        }
        digest.update(row.id.to_be_bytes());
        digest.update(row.revision.as_bytes());
        if task.phase == "scan" {
            // Unique membership proves repeated/overlapping pages cannot advance.
            tx.execute("INSERT INTO matching_seen(scope,kind,generation,id,revision) VALUES(?1,?2,?3,?4,?5)",params![scope,task.kind,task.generation,row.id,row.revision]).map_err(|_|"Plex repeated an item during its census")?;
            upsert(&tx, scope, row, task.started)?;
        } else {
            let matches=tx.query_row("SELECT revision=?5 FROM matching_seen WHERE scope=?1 AND kind=?2 AND generation=?3 AND id=?4",params![scope,task.kind,task.generation,row.id,row.revision],|r|r.get::<_,bool>(0)).optional().map_err(error)?.unwrap_or(false);
            if !matches {
                return Err("Plex metadata changed during census verification".into());
            }
        }
    }
    let digest = hex::encode(digest.finalize());
    let end = task.offset + rows.len() as i64;
    let complete = end == total;
    // Two identical bounded listing passes prove a stable census. Neither an
    // event hint nor the end of a partial page is deletion evidence.
    if complete && task.phase == "verify" && digest != task.digest {
        return Err("Plex census verification changed its order or membership".into());
    }
    let phase = if complete {
        if task.phase == "scan" {
            "verify"
        } else {
            "prune"
        }
    } else {
        &task.phase
    };
    tx.execute("UPDATE matching_tasks SET phase=?3,offset=?4,total=?5,digest=?6,verify_digest=?7,count=?8,requests=requests+1,bytes=bytes+?9,error=NULL,failures=0,retry_at=0 WHERE scope=?1 AND kind=?2",params![scope,task.kind,phase,if complete {0}else{end},total,if task.phase=="scan" {&digest}else{&task.digest},if task.phase=="verify" {&digest}else{&task.verify_digest},if task.phase=="scan" {end}else{task.count},bytes]).map_err(error)?;
    trim_changes(&tx, scope)?;
    let _owner = fence()?;
    tx.commit().map_err(error)?;
    Ok(())
}
#[cfg(test)]
pub fn prune(conn: &Connection, scope: &str, task: &Task, epoch: i64) -> Result<bool> {
    prune_fenced(conn, scope, task, epoch, || Ok(()))
}
pub fn prune_fenced<G>(
    conn: &Connection,
    scope: &str,
    task: &Task,
    epoch: i64,
    fence: impl FnOnce() -> Result<G>,
) -> Result<bool> {
    current(conn, scope, task, epoch)?;
    if task.phase != "prune" {
        return Err("A complete verified census is required before removing index rows".into());
    }
    let mut query=conn.prepare("SELECT id,observed FROM matching_rows WHERE scope=?1 AND kind=?2 AND id>?3 ORDER BY id LIMIT 500").map_err(error)?;
    let rows = query
        .query_map(params![scope, task.kind, task.prune_cursor], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
        })
        .map_err(error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(error)?;
    drop(query);
    let tx = conn.unchecked_transaction().map_err(error)?;
    for (id, observed) in &rows {
        if *observed > task.started {
            continue;
        }
        let unseen=tx.query_row("SELECT NOT EXISTS(SELECT 1 FROM matching_seen WHERE scope=?1 AND kind=?2 AND generation=?3 AND id=?4)",params![scope,task.kind,task.generation,id],|r|r.get::<_,bool>(0)).map_err(error)?;
        if unseen && tx.execute("UPDATE matching_rows SET removed=1 WHERE scope=?1 AND kind=?2 AND id=?3 AND removed=0",params![scope,task.kind,id]).map_err(error)?>0 {changed_row(&tx,scope,&task.kind,*id)?;}
    }
    let done = rows.len() < 500;
    tx.execute("UPDATE matching_tasks SET prune_cursor=?3,phase=?4,completed=CASE WHEN ?5 THEN ?6 ELSE completed END WHERE scope=?1 AND kind=?2",params![scope,task.kind,rows.last().map(|r|r.0).unwrap_or(task.prune_cursor),if done {"complete"}else{"prune"},done,now()]).map_err(error)?;
    if done {
        tx.execute(
            "INSERT OR IGNORE INTO matching_retired(scope,kind,generation) VALUES(?1,?2,?3)",
            params![scope, task.kind, task.generation],
        )
        .map_err(error)?;
    }
    trim_changes(&tx, scope)?;
    let _owner = fence()?;
    tx.commit().map_err(error)?;
    Ok(done)
}
pub(super) fn trim_changes(conn: &Connection, scope: &str) -> Result<()> {
    conn.execute("DELETE FROM matching_changes WHERE rowid IN (SELECT rowid FROM matching_changes WHERE scope=?1 AND sequence<(SELECT max(0,revision-10000) FROM matching_scopes WHERE scope=?1) LIMIT 1000)",[scope]).map_err(error)?;
    Ok(())
}
/// Retired checkpoints are garbage collected in small transactions, rather than
/// holding native admission while deleting hundreds of thousands of rows.
pub fn tidy(conn: &Connection, scope: &str) -> Result<()> {
    let retired: Option<(String, String)> = conn
        .query_row(
            "SELECT kind,generation FROM matching_retired WHERE scope=?1 LIMIT 1",
            [scope],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(error)?;
    if let Some((kind, generation)) = retired {
        let deleted=conn.execute("DELETE FROM matching_seen WHERE rowid IN (SELECT rowid FROM matching_seen WHERE scope=?1 AND kind=?2 AND generation=?3 LIMIT 500)",params![scope,kind,generation]).map_err(error)?;
        if deleted < 500 {
            conn.execute(
                "DELETE FROM matching_retired WHERE scope=?1 AND kind=?2 AND generation=?3",
                params![scope, kind, generation],
            )
            .map_err(error)?;
        }
    }
    trim_changes(conn, scope)
}
pub fn fail(conn: &Connection, scope: &str, task: &Task, epoch: i64, message: &str) -> Result<()> {
    current(conn, scope, task, epoch)?;
    // Changed pages restart only the census checkpoint. Retained useful rows
    // remain partial and cannot be mistaken for a complete membership inventory.
    let changing =
        message.contains("census") || message.contains("repeated") || message.contains("advancing");
    conn.execute("UPDATE matching_tasks SET error=?3,failures=min(failures+1,10),retry_at=?4+min(3600000,30000*(1<<min(failures,7))),started=CASE WHEN ?5 THEN 0 ELSE started END WHERE scope=?1 AND kind=?2",params![scope,task.kind,message,now(),changing]).map_err(error)?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    const S: &str = "plex-fixture";
    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        ensure_scope(&conn, S).unwrap();
        conn
    }
    fn row(id: i64) -> Row {
        super::super::row::parse(&serde_json::json!({"type":"artist","ratingKey":id,"title":format!("Artist {id}"),"librarySectionID":4}),"artist",4).unwrap()
    }
    fn task(conn: &Connection) -> Task {
        status(conn, S)
            .unwrap()
            .tasks
            .into_iter()
            .find(|t| t.kind == "artist")
            .unwrap()
    }
    fn page(conn: &Connection, rows: &[Row], total: i64) {
        publish(conn, S, &task(conn), 0, rows, total, 100).unwrap()
    }
    fn complete(conn: &Connection, rows: &[Row]) {
        begin(conn, S, "artist", 0).unwrap();
        for _ in 0..2 {
            if rows.is_empty() {
                page(conn, &[], 0)
            } else {
                for chunk in rows.chunks(500) {
                    page(conn, chunk, rows.len() as i64)
                }
            }
        }
        while !prune(conn, S, &task(conn), 0).unwrap() {}
    }
    #[test]
    fn interrupted_large_census_resumes_and_deletes_only_after_verified_membership() {
        let conn = db();
        upsert(&conn, S, &row(9000), 0).unwrap();
        let rows: Vec<_> = (1..=3001).map(row).collect();
        let first = begin(&conn, S, "artist", 0).unwrap();
        page(&conn, &rows[..500], 3001);
        let resumed = begin(&conn, S, "artist", 0).unwrap();
        assert_eq!(resumed.generation, first.generation);
        assert_eq!(resumed.offset, 500);
        assert!(prune(&conn, S, &resumed, 0).is_err());
        for chunk in rows[500..].chunks(500) {
            page(&conn, chunk, 3001)
        }
        assert_eq!(task(&conn).phase, "verify");
        assert!(!conn
            .query_row("SELECT removed FROM matching_rows WHERE id=9000", [], |r| r
                .get::<_, bool>(0))
            .unwrap());
        for chunk in rows.chunks(500) {
            page(&conn, chunk, 3001)
        }
        assert_eq!(task(&conn).phase, "prune");
        while !prune(&conn, S, &task(&conn), 0).unwrap() {}
        assert_eq!(task(&conn).phase, "complete");
        assert_eq!(task(&conn).count, 3001);
        assert!(conn
            .query_row("SELECT removed FROM matching_rows WHERE id=9000", [], |r| r
                .get::<_, bool>(0))
            .unwrap());
        assert_eq!(
            begin(&conn, S, "artist", 0).unwrap().generation,
            first.generation,
            "unchanged completed census does not restart on launch"
        );
    }
    #[test]
    fn changing_totals_duplicates_storage_failure_and_epoch_retirement_are_atomic() {
        let conn = db();
        begin(&conn, S, "artist", 0).unwrap();
        page(&conn, &[row(1)], 3);
        let before = task(&conn);
        assert!(publish(&conn, S, &before, 0, &[row(2)], 4, 1).is_err());
        assert!(publish(&conn, S, &before, 0, &[row(2), row(1)], 3, 1).is_err());
        assert_eq!(task(&conn).offset, 1);
        assert_eq!(
            conn.query_row("SELECT count(*) FROM matching_rows", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        conn.execute_batch("CREATE TRIGGER fail_index BEFORE INSERT ON matching_rows BEGIN SELECT raise(ABORT,'fixture storage failure'); END;").unwrap();
        assert!(publish(&conn, S, &before, 0, &[row(2)], 3, 1).is_err());
        assert_eq!(task(&conn).offset, 1);
        conn.execute_batch("DROP TRIGGER fail_index").unwrap();
        control(&conn, S, "pause").unwrap();
        control(&conn, S, "resume").unwrap();
        assert!(publish(&conn, S, &before, 0, &[row(2)], 3, 1).is_err());
        assert_eq!(task(&conn).offset, 1);
    }
    #[test]
    fn verification_detects_equal_count_edits_and_reordering_without_deleting_data() {
        let conn = db();
        begin(&conn, S, "artist", 0).unwrap();
        page(&conn, &[row(1), row(2)], 2);
        assert!(publish(&conn, S, &task(&conn), 0, &[row(2), row(1)], 2, 1).is_err());
        let mut changed = row(1);
        changed.title = "Renamed".into();
        changed.revision = "changed".into();
        assert!(publish(&conn, S, &task(&conn), 0, &[changed, row(2)], 2, 1).is_err());
        assert_eq!(task(&conn).phase, "verify");
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM matching_rows WHERE removed=0",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
    }
    #[test]
    fn empty_libraries_late_observations_and_independent_lifecycle_remain_safe() {
        let conn = db();
        let late = row(9);
        upsert(&conn, S, &late, now() + 60000).unwrap();
        complete(&conn, &[]);
        assert!(!conn
            .query_row("SELECT removed FROM matching_rows WHERE id=9", [], |r| r
                .get::<_, bool>(
                0
            ))
            .unwrap());
        ensure_scope(&conn, "another").unwrap();
        upsert(&conn, "another", &row(7), 0).unwrap();
        conn.execute_batch("CREATE TABLE retained_user_rating(value INTEGER); INSERT INTO retained_user_rating VALUES(5)").unwrap();
        control(&conn, S, "clear").unwrap();
        assert!(status(&conn, S).unwrap().paused);
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM matching_rows WHERE scope='another'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT value FROM retained_user_rating", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            5
        );
    }
    #[test]
    fn focused_cache_maintenance_does_not_evict_matching_membership() {
        let conn = db();
        let scope = format!("plex-{}", "a".repeat(64));
        ensure_scope(&conn, &scope).unwrap();
        upsert(&conn, &scope, &row(1), 0).unwrap();
        let initial = begin(&conn, &scope, "artist", 0).unwrap();
        crate::db::collection_cache::clear(&conn, &scope).unwrap();
        crate::db::focused_library::maintain(&conn, &scope, |_| false).unwrap();
        assert_eq!(
            status(&conn, &scope).unwrap().tasks[0].generation,
            initial.generation
        );
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM matching_rows WHERE scope=?1",
                [scope],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }
    #[test]
    fn disk_restart_retains_checkpoint_generation_and_completed_inventory() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("restart.db");
        let conn = Connection::open(&path).unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        ensure_scope(&conn, S).unwrap();
        let initial = begin(&conn, S, "artist", 0).unwrap();
        page(&conn, &[row(1)], 2);
        drop(conn);
        let conn = Connection::open(&path).unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        let resumed = begin(&conn, S, "artist", 0).unwrap();
        assert_eq!(resumed.generation, initial.generation);
        assert_eq!(resumed.offset, 1);
        page(&conn, &[row(2)], 2);
        page(&conn, &[row(1)], 2);
        page(&conn, &[row(2)], 2);
        while !prune(&conn, S, &task(&conn), 0).unwrap() {}
        drop(conn);
        let conn = Connection::open(&path).unwrap();
        let saved = begin(&conn, S, "artist", 0).unwrap();
        assert_eq!(saved.generation, initial.generation);
        assert_eq!(saved.phase, "complete");
        assert_eq!(saved.requests, 4);
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM matching_rows WHERE removed=0",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
    }
    #[test]
    fn owner_retirement_at_commit_rolls_back_rows_and_checkpoint() {
        let conn = db();
        let task = begin(&conn, S, "artist", 0).unwrap();
        assert!(
            publish_fenced(&conn, S, &task, 0, &[row(1)], 1, 1, || Err::<(), _>(
                "Retired account".into()
            ))
            .is_err()
        );
        assert_eq!(super::status(&conn, S).unwrap().revision, 0);
        assert_eq!(
            conn.query_row("SELECT count(*) FROM matching_rows", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(super::status(&conn, S).unwrap().tasks[0].offset, 0);
    }
    #[test]
    #[ignore = "explicit large-library storage and foreground latency measurement"]
    fn large_library_benchmark() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("matching.db");
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        ensure_scope(&conn, S).unwrap();
        let rows: i64 = std::env::var("HIBIKI_MATCHING_BENCH_ROWS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(400000);
        let started = std::time::Instant::now();
        begin(&conn, S, "track", 0).unwrap();
        let mut transactions = Vec::new();
        let mut commits = Vec::new();
        let running = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let reader_running = running.clone();
        let reader_path = path.clone();
        let reader = std::thread::spawn(move || {
            let read = Connection::open_with_flags(
                reader_path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .unwrap();
            read.busy_timeout(std::time::Duration::from_millis(100))
                .unwrap();
            let mut times = Vec::new();
            let mut n = 0;
            while reader_running.load(std::sync::atomic::Ordering::Relaxed) {
                let tick = std::time::Instant::now();
                let _:i64=read.query_row("SELECT count(*) FROM matching_rows WHERE scope=?1 AND kind='track' AND title_key=?2",params![S,format!("song {}",n%400000+1)],|r|r.get(0)).unwrap();
                if times.len() < 20000 {
                    times.push(tick.elapsed().as_secs_f64() * 1000.0)
                }
                n += 379;
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            times
        });
        for _ in 0..2 {
            for first in (1..=rows).step_by(500) {
                let batch:Vec<_>=(first..=(first+499).min(rows)).map(|id| super::super::row::parse(&serde_json::json!({"type":"track","ratingKey":id,"librarySectionID":4,"title":format!("Song {id}"),"grandparentTitle":format!("Artist {}",id%8306),"grandparentRatingKey":id%8306+1,"parentTitle":format!("Album {}",id%87130),"parentRatingKey":id%87130+1,"duration":180000,"index":id%12+1,"parentIndex":1,"updatedAt":1700000000,"Guid":[{"id":format!("plex://track/{id}")}]}),"track",4).unwrap()).collect();
                let task = status(&conn, S)
                    .unwrap()
                    .tasks
                    .into_iter()
                    .find(|t| t.kind == "track")
                    .unwrap();
                let tick = std::time::Instant::now();
                let commit_start = std::cell::Cell::new(None);
                publish_fenced(&conn, S, &task, 0, &batch, rows, 0, || {
                    commit_start.set(Some(std::time::Instant::now()));
                    Ok(())
                })
                .unwrap();
                commits.push(commit_start.get().unwrap().elapsed().as_secs_f64() * 1000.0);
                transactions.push(tick.elapsed().as_secs_f64() * 1000.0);
            }
        }
        loop {
            let task = status(&conn, S)
                .unwrap()
                .tasks
                .into_iter()
                .find(|t| t.kind == "track")
                .unwrap();
            if prune(&conn, S, &task, 0).unwrap() {
                break;
            }
        }
        let mut latencies = Vec::new();
        for id in 1..=1000 {
            let tick = std::time::Instant::now();
            let count:i64=conn.query_row("SELECT count(*) FROM matching_rows WHERE scope=?1 AND kind='track' AND title_key=?2",params![S,format!("song {}",id*379)],|r|r.get(0)).unwrap();
            assert!(count <= 1);
            latencies.push(tick.elapsed().as_secs_f64() * 1000.0);
        }
        transactions.sort_by(f64::total_cmp);
        latencies.sort_by(f64::total_cmp);
        let mut resolver_times = Vec::new();
        let mut largest_payload = 0;
        let sources:Vec<super::super::resolver::Source>=(1..=16).map(|n|{let id=(n*379) % rows+1;serde_json::from_value(serde_json::json!({"id":format!("ytmusic:fixture-{id}"),"kind":"track","title":format!("Song {id}"),"artists":[format!("Artist {}",id%8306)],"duration":180000})).unwrap()}).collect();
        for pass in 0..100 {
            let tick = std::time::Instant::now();
            let tx = conn.unchecked_transaction().unwrap();
            let found: Vec<_> = sources
                .iter()
                .map(|source| {
                    super::super::resolver::resolve(&tx, S, "benchmark", source, false).unwrap()
                })
                .collect();
            tx.commit().unwrap();
            assert!(found.iter().all(|result| result.status == "matched"));
            if pass > 0 {
                assert!(found.iter().all(|result| result.cached));
            }
            largest_payload = largest_payload.max(serde_json::to_vec(&found).unwrap().len());
            resolver_times.push(tick.elapsed().as_secs_f64() * 1000.0);
        }
        resolver_times.sort_by(f64::total_cmp);
        let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
        let peak_rss = unsafe {
            if libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) == 0 {
                let max = usage.assume_init().ru_maxrss as i64;
                if cfg!(target_os = "macos") {
                    max
                } else {
                    max * 1024
                }
            } else {
                0
            }
        };
        println!("matching_resolver_benchmark batch=16 p50_ms={:.3} p95_ms={:.3} max_response_bytes={largest_payload} peak_process_rss_bytes={peak_rss} warm_network_requests=0",resolver_times[50],resolver_times[95]);
        running.store(false, std::sync::atomic::Ordering::Relaxed);
        let mut foreground = reader.join().unwrap();
        foreground.sort_by(f64::total_cmp);
        commits.sort_by(f64::total_cmp);
        let database_bytes: i64 = conn
            .query_row(
                "SELECT page_count*page_size FROM pragma_page_count(),pragma_page_size()",
                [],
                |r| r.get(0),
            )
            .unwrap();
        println!("matching_index_benchmark rows={rows} seconds={:.2} database_bytes={database_bytes} page_transaction_p50_ms={:.3} page_transaction_p95_ms={:.3} warm_exact_p50_ms={:.3} warm_exact_p95_ms={:.3}",started.elapsed().as_secs_f64(),transactions[transactions.len()/2],transactions[transactions.len()*95/100],latencies[500],latencies[950]);
        println!("matching_index_foreground reads={} p50_ms={:.3} p95_ms={:.3} commit_fence_p95_ms={:.3}",foreground.len(),foreground[foreground.len()/2],foreground[foreground.len()*95/100],commits[commits.len()*95/100]);
    }
}
