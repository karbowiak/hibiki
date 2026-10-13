//! Atomic catalogue checkpoints and playlist generations.
use super::catalogue::{self, now};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub task: String,
    pub generation: String,
    pub status: String,
    pub cursor: i64,
    pub total: Option<i64>,
    pub completed_at: Option<i64>,
    pub error: Option<String>,
    pub scan_mode: String,
    pub key_cursor: i64,
    pub upper_id: Option<i64>,
    pub started_at: i64,
    pub lower_time: Option<i64>,
    pub upper_time: Option<i64>,
}
pub fn task(conn: &Connection, scope: &str, name: &str) -> Result<Option<Task>, String> {
    super::offline::check_identity(scope, name)?;
    conn.query_row("SELECT task,generation,status,cursor,total,completed_at,error,scan_mode,key_cursor,upper_id,started_at,lower_time,upper_time FROM plex_catalogue_tasks WHERE scope=?1 AND task=?2",params![scope,name],|r|Ok(Task{task:r.get(0)?,generation:r.get(1)?,status:r.get(2)?,cursor:r.get(3)?,total:r.get(4)?,completed_at:r.get(5)?,error:r.get(6)?,scan_mode:r.get(7)?,key_cursor:r.get(8)?,upper_id:r.get(9)?,started_at:r.get(10)?,lower_time:r.get(11)?,upper_time:r.get(12)?})).optional().map_err(|_|"Cannot read catalogue progress".into())
}
pub fn begin(
    conn: &Connection,
    scope: &str,
    name: &str,
    generation: Option<&str>,
) -> Result<Task, String> {
    let previous = task(conn, scope, name)?;
    if let Some(previous) = previous {
        let needs_restart = previous.scan_mode == "offset"
            && previous.status == "error"
            && previous.error.as_deref().is_some_and(|e| {
                e.contains("changed") || e.contains("repeated") || e.contains("nonadvancing")
            });
        let same = !needs_restart && generation.is_none_or(|g| g == previous.generation);
        let fresh = generation.is_some()
            || previous
                .completed_at
                .is_some_and(|t| now().saturating_sub(t) < 30 * 24 * 60 * 60 * 1000);
        if same && (previous.status != "complete" || fresh) {
            return Ok(previous);
        }
    }
    let generation = generation
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if let Some(id) = name
        .strip_prefix("playlist:")
        .and_then(|s| s.parse::<i64>().ok())
    {
        conn.execute("DELETE FROM plex_catalogue_playlist_members WHERE scope=?1 AND playlist_id=?2 AND generation IS NOT (SELECT generation FROM plex_catalogue_playlist_versions WHERE scope=?1 AND playlist_id=?2)",params![scope,id]).map_err(|_|"Cannot retire interrupted staging")?;
    }
    conn.execute("INSERT INTO plex_catalogue_tasks(scope,task,generation,status,updated_at) VALUES(?1,?2,?3,'pending',?4)
       ON CONFLICT(scope,task) DO UPDATE SET generation=excluded.generation,status='pending',cursor=0,total=NULL,completed_at=NULL,error=NULL,scan_mode='offset',key_cursor=0,upper_id=NULL,started_at=0,lower_time=NULL,upper_time=NULL,updated_at=excluded.updated_at",params![scope,name,generation,now()]).map_err(|_|"Cannot begin catalogue sync")?;
    task(conn, scope, name)?.ok_or("Catalogue task unavailable".into())
}
pub fn checkpoint(
    conn: &Connection,
    scope: &str,
    task: &Task,
    cursor: i64,
    total: Option<i64>,
    complete: bool,
) -> Result<(), String> {
    if cursor < task.cursor || total.is_some_and(|n| n < cursor) {
        return Err("Invalid catalogue checkpoint".into());
    }
    let updated=conn.execute("UPDATE plex_catalogue_tasks SET cursor=?4,total=?5,status=?6,completed_at=?7,error=NULL,updated_at=?8 WHERE scope=?1 AND task=?2 AND generation=?3 AND cursor=?9",
       params![scope,task.task,task.generation,cursor,total,if complete{"complete"}else{"running"},if complete{Some(now())}else{None},now(),task.cursor]).map_err(|_|"Cannot save catalogue checkpoint")?;
    if updated != 1 {
        return Err("Catalogue task was superseded".into());
    }
    Ok(())
}
pub fn stop(
    conn: &Connection,
    scope: &str,
    task: &Task,
    error: Option<&str>,
) -> Result<(), String> {
    conn.execute("UPDATE plex_catalogue_tasks SET status=?4,error=?5,updated_at=?6 WHERE scope=?1 AND task=?2 AND generation=?3 AND cursor=?7 AND status!='complete'",params![scope,task.task,task.generation,if error.is_some(){"error"}else{"paused"},error,now(),task.cursor]).map_err(|_|"Cannot pause catalogue sync")?;
    Ok(())
}

#[cfg(test)]
pub fn roster_page(
    conn: &Connection,
    scope: &str,
    task: &Task,
    items: &[Value],
    total: Option<i64>,
    complete: bool,
) -> Result<(), String> {
    if !matches!(
        task.task.as_str(),
        "artist" | "album" | "track" | "playlist"
    ) {
        return Err("Invalid catalogue kind".into());
    }
    if task.total.is_some() && total.is_some() && task.total != total {
        return Err("Plex catalogue changed during sync. Refresh to start a new scan.".into());
    }
    let transaction = conn
        .unchecked_transaction()
        .map_err(|_| "Cannot save catalogue page")?;
    let mut seen = std::collections::HashSet::new();
    for (index, item) in items.iter().enumerate() {
        let id = crate::plex::catalogue::number(&item["ratingKey"])
            .filter(|id| *id > 0)
            .ok_or("Invalid Plex catalogue identity")?;
        if item["type"].as_str() != Some(task.task.as_str()) || !seen.insert(id) {
            return Err("Plex returned a different or repeated catalogue item".into());
        }
        let position = task.cursor + index as i64;
        let prior:Option<(String,i64)>=transaction.query_row("SELECT seen_generation,position FROM plex_catalogue WHERE scope=?1 AND kind=?2 AND id=?3 AND seen_generation IS NOT NULL AND position IS NOT NULL",params![scope,task.task,id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|_|"Cannot verify catalogue page")?;
        if prior.is_some_and(|(generation, old_position)| {
            generation == task.generation && old_position != position
        }) {
            return Err(
                "Plex repeated an earlier catalogue page. Refresh to start a new scan.".into(),
            );
        }
        let document = serde_json::to_string(&catalogue::clean_document(item)?)
            .map_err(|_| "Invalid Plex metadata")?;
        transaction.execute("INSERT INTO plex_catalogue(scope,kind,id,document,detail,saved_at,listing,listing_saved_at,seen_generation,position,removed)
          VALUES(?1,?2,?3,?4,0,?5,?4,?5,?6,?7,0)
          ON CONFLICT(scope,kind,id) DO UPDATE SET listing=excluded.listing,listing_saved_at=excluded.listing_saved_at,seen_generation=excluded.seen_generation,position=excluded.position,removed=0",
          params![scope,task.task,id,document,now(),task.generation,position]).map_err(|_|"Cannot save catalogue item")?;
    }
    let cursor = task.cursor + items.len() as i64;
    if complete {
        let count:i64=transaction.query_row("SELECT COUNT(*) FROM plex_catalogue WHERE scope=?1 AND kind=?2 AND seen_generation=?3",params![scope,task.task,task.generation],|r|r.get(0)).map_err(|_|"Cannot verify catalogue completion")?;
        if count != cursor || total.is_some_and(|total| total != count) {
            return Err(
                "Plex catalogue count changed during sync. Refresh to start a new scan.".into(),
            );
        }
        // Retain removed documents for downloaded files and later provenance.
        transaction.execute("UPDATE plex_catalogue SET removed=1 WHERE scope=?1 AND kind=?2 AND seen_generation IS NOT ?3",params![scope,task.task,task.generation]).map_err(|_|"Cannot finish catalogue scan")?;
    }
    checkpoint(
        &transaction,
        scope,
        task,
        cursor,
        total.or(task.total),
        complete,
    )?;
    transaction
        .commit()
        .map_err(|_| "Cannot commit catalogue page".into())
}

pub fn pending_details(
    conn: &Connection,
    scope: &str,
    kind: &str,
    cursor: i64,
) -> Result<Vec<i64>, String> {
    let mut query=conn.prepare("SELECT id FROM plex_catalogue WHERE scope=?1 AND kind=?2 AND removed=0 AND id>?3 AND (kind='playlist' OR detail=0 OR detail_revision IS NOT listing_revision) ORDER BY id LIMIT 50").map_err(|_|"Cannot read detail queue")?;
    let rows = query
        .query_map(params![scope, kind, cursor], |row| row.get(0))
        .map_err(|_| "Cannot read detail queue")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Cannot read detail queue".into());
    rows
}
#[cfg(test)]
pub fn detail_page(
    conn: &Connection,
    scope: &str,
    task: &Task,
    kind: &str,
    ids: &[i64],
    items: &[Value],
) -> Result<(), String> {
    let transaction = conn
        .unchecked_transaction()
        .map_err(|_| "Cannot save catalogue details")?;
    for item in items {
        let id = crate::plex::catalogue::number(&item["ratingKey"])
            .ok_or("Invalid Plex metadata identity")?;
        if !ids.contains(&id) || item["type"].as_str() != Some(kind) {
            return Err("Plex returned a different detail item".into());
        }
        catalogue::save(&transaction, scope, kind, id, item, true)?;
    }
    for id in ids {
        if !items
            .iter()
            .any(|item| crate::plex::catalogue::number(&item["ratingKey"]) == Some(*id))
        {
            transaction
                .execute(
                    "UPDATE plex_catalogue SET removed=1 WHERE scope=?1 AND kind=?2 AND id=?3",
                    params![scope, kind, id],
                )
                .map_err(|_| "Cannot retire missing detail")?;
        }
    }
    let cursor = ids.last().copied().unwrap_or(task.cursor);
    checkpoint(&transaction, scope, task, cursor, None, ids.is_empty())?;
    transaction
        .commit()
        .map_err(|_| "Cannot commit catalogue details".into())
}

#[cfg(test)]
pub fn playlist_page(
    conn: &Connection,
    scope: &str,
    id: i64,
    task: &Task,
    items: &[Value],
    total: Option<i64>,
    complete: bool,
) -> Result<(), String> {
    playlist_page_checked(conn, scope, id, task, items, total, complete, None).map(|_| ())
}
pub fn playlist_page_checked(
    conn: &Connection,
    scope: &str,
    id: i64,
    task: &Task,
    items: &[Value],
    total: Option<i64>,
    complete: bool,
    admission: Option<&super::catalogue_incremental::Change>,
) -> Result<Option<i64>, String> {
    playlist_page_impl(
        conn, scope, id, task, items, total, complete, admission, None,
    )
}
pub fn playlist_finish_checked(
    conn: &Connection,
    scope: &str,
    id: i64,
    task: &Task,
    admission: Option<&super::catalogue_incremental::Change>,
    document: &Value,
) -> Result<Option<i64>, String> {
    playlist_page_impl(
        conn,
        scope,
        id,
        task,
        &[],
        Some(task.cursor),
        true,
        admission,
        Some(document),
    )
}
fn playlist_page_impl(
    conn: &Connection,
    scope: &str,
    id: i64,
    task: &Task,
    items: &[Value],
    total: Option<i64>,
    complete: bool,
    admission: Option<&super::catalogue_incremental::Change>,
    document: Option<&Value>,
) -> Result<Option<i64>, String> {
    if task.total.is_some() && total.is_some() && task.total != total {
        return Err("Playlist changed during catalogue sync".into());
    }
    let transaction = conn
        .unchecked_transaction()
        .map_err(|_| "Cannot save playlist catalogue")?;
    if let Some(change) = admission {
        if !super::catalogue_incremental::current(&transaction, scope, change)? {
            return Err("Catalogue change was superseded".into());
        }
    }
    if let Some(document) = document {
        catalogue::save(&transaction, scope, "playlist", id, document, true)?;
    }
    let mut revision = None;
    for (index, item) in items.iter().enumerate() {
        if item["type"].as_str() != Some("track")
            || crate::plex::catalogue::number(&item["ratingKey"]).is_none_or(|id| id <= 0)
        {
            return Err("Invalid playlist catalogue track".into());
        }
        let document = serde_json::to_string(&catalogue::clean_document(item)?)
            .map_err(|_| "Invalid playlist metadata")?;
        transaction.execute("INSERT INTO plex_catalogue_playlist_members(scope,playlist_id,generation,position,document) VALUES(?1,?2,?3,?4,?5)
          ON CONFLICT(scope,playlist_id,generation,position) DO UPDATE SET document=excluded.document",params![scope,id,task.generation,task.cursor+index as i64,document]).map_err(|_|"Cannot save playlist catalogue")?;
    }
    let cursor = task.cursor + items.len() as i64;
    if complete {
        let count:i64=transaction.query_row("SELECT COUNT(*) FROM plex_catalogue_playlist_members WHERE scope=?1 AND playlist_id=?2 AND generation=?3",params![scope,id,task.generation],|r|r.get(0)).map_err(|_|"Cannot verify playlist catalogue")?;
        if count != cursor || total.is_some_and(|total| total != cursor) {
            return Err("Incomplete playlist catalogue".into());
        }
        let previous:Option<String>=transaction.query_row("SELECT generation FROM plex_catalogue_playlist_versions WHERE scope=?1 AND playlist_id=?2",params![scope,id],|r|r.get(0)).optional().map_err(|_|"Cannot compare playlist publication")?;
        // Retries and artwork regeneration can produce a new staging owner
        // without changing membership. Only actual ordered occurrences wake UI.
        let unchanged = if let Some(previous) = &previous {
            let prior_count: i64 = transaction.query_row("SELECT COUNT(*) FROM plex_catalogue_playlist_members WHERE scope=?1 AND playlist_id=?2 AND generation=?3", params![scope,id,previous], |r| r.get(0)).map_err(|_| "Cannot compare playlist membership")?;
            let different: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM plex_catalogue_playlist_members n LEFT JOIN plex_catalogue_playlist_members p ON p.scope=n.scope AND p.playlist_id=n.playlist_id AND p.position=n.position AND p.generation=?4 WHERE n.scope=?1 AND n.playlist_id=?2 AND n.generation=?3 AND (p.position IS NULL OR CAST(json_extract(n.document,'$.ratingKey') AS INTEGER) IS NOT CAST(json_extract(p.document,'$.ratingKey') AS INTEGER) OR CAST(json_extract(n.document,'$.playlistItemID') AS INTEGER) IS NOT CAST(json_extract(p.document,'$.playlistItemID') AS INTEGER)))",params![scope,id,task.generation,previous],|r|r.get(0)).map_err(|_| "Cannot compare playlist membership")?;
            prior_count == cursor && !different
        } else {
            false
        };
        if !unchanged {
            revision = Some(super::catalogue_incremental::bump(&transaction, scope)?);
        }
        transaction.execute("INSERT INTO plex_catalogue_playlist_versions(scope,playlist_id,generation,total,saved_at) VALUES(?1,?2,?3,?4,?5)
          ON CONFLICT(scope,playlist_id) DO UPDATE SET generation=excluded.generation,total=excluded.total,saved_at=excluded.saved_at",params![scope,id,task.generation,cursor,now()]).map_err(|_|"Cannot publish playlist catalogue")?;
        transaction.execute("DELETE FROM plex_catalogue_playlist_members WHERE scope=?1 AND playlist_id=?2 AND generation!=?3",params![scope,id,task.generation]).map_err(|_|"Cannot retire playlist staging")?;
    }
    checkpoint(
        &transaction,
        scope,
        task,
        cursor,
        total.or(task.total),
        complete,
    )?;
    transaction
        .commit()
        .map_err(|_| "Cannot commit playlist catalogue")?;
    Ok(revision)
}

/// Bounded raw staging reads for a second membership pass. Reading the live
/// projection here would hide occurrence changes behind newer track metadata.
pub fn playlist_staging_page(
    conn: &Connection,
    scope: &str,
    id: i64,
    task: &Task,
    offset: i64,
    limit: i64,
) -> Result<Vec<Value>, String> {
    let current =
        self::task(conn, scope, &format!("playlist:{id}"))?.ok_or("Missing playlist task")?;
    if current.generation != task.generation || current.cursor != task.cursor {
        return Err("Catalogue task was superseded".into());
    }
    let mut stmt = conn.prepare("SELECT document FROM plex_catalogue_playlist_members WHERE scope=?1 AND playlist_id=?2 AND generation=?3 AND position>=?4 AND position<?5 ORDER BY position").map_err(|_| "Cannot read playlist staging")?;
    let rows = stmt
        .query_map(
            params![scope, id, task.generation, offset, offset + limit],
            |r| r.get::<_, String>(0),
        )
        .map_err(|_| "Cannot read playlist staging")?;
    rows.map(|row| {
        serde_json::from_str(&row.map_err(|_| "Cannot read playlist staging")?)
            .map_err(|_| "Invalid playlist staging".into())
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Connection, String) {
        let conn = Connection::open_in_memory().unwrap();
        super::super::schema::run_migrations(&conn).unwrap();
        (conn, format!("plex-{}", "a".repeat(64)))
    }
    fn item(id: i64) -> Value {
        serde_json::json!({"type":"track","ratingKey":id,"title":format!("Track {id}")})
    }
    #[test]
    fn verified_playlist_publication_is_atomic_and_unchanged_membership_does_not_emit() {
        let (conn, scope) = fixture();
        let meta =
            serde_json::json!({"type":"playlist","ratingKey":7,"title":"Saved","updatedAt":1});
        let a = serde_json::json!({"type":"track","ratingKey":1,"playlistItemID":10});
        let b = serde_json::json!({"type":"track","ratingKey":1,"playlistItemID":11});
        let first = begin(&conn, &scope, "playlist:7", Some("first")).unwrap();
        playlist_page(
            &conn,
            &scope,
            7,
            &first,
            &[a.clone(), b.clone()],
            Some(2),
            false,
        )
        .unwrap();
        let first = task(&conn, &scope, "playlist:7").unwrap().unwrap();
        assert_eq!(
            playlist_staging_page(&conn, &scope, 7, &first, 0, 1).unwrap(),
            vec![a.clone()]
        );
        assert_eq!(
            playlist_staging_page(&conn, &scope, 7, &first, 1, 1).unwrap(),
            vec![b.clone()]
        );
        assert!(
            playlist_finish_checked(&conn, &scope, 7, &first, None, &meta)
                .unwrap()
                .is_some()
        );
        let mut updated = meta.clone();
        updated["updatedAt"] = serde_json::json!(2);
        let second = begin(&conn, &scope, "playlist:7", Some("second")).unwrap();
        playlist_page(
            &conn,
            &scope,
            7,
            &second,
            &[a.clone(), b.clone()],
            Some(2),
            false,
        )
        .unwrap();
        let staged = task(&conn, &scope, "playlist:7").unwrap().unwrap();
        assert!(
            playlist_finish_checked(&conn, &scope, 7, &staged, None, &updated)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            catalogue::get(&conn, &scope, "playlist", 7)
                .unwrap()
                .unwrap()["updatedAt"],
            2
        );
        let third = begin(&conn, &scope, "playlist:7", Some("third")).unwrap();
        playlist_page(&conn, &scope, 7, &third, &[b, a], Some(2), false).unwrap();
        let staged = task(&conn, &scope, "playlist:7").unwrap().unwrap();
        assert!(
            playlist_finish_checked(&conn, &scope, 7, &staged, None, &updated)
                .unwrap()
                .is_some()
        );
        assert!(playlist_staging_page(&conn, &scope, 7, &first, 0, 200).is_err());
        assert!(playlist_staging_page(
            &conn,
            &format!("plex-{}", "b".repeat(64)),
            7,
            &staged,
            0,
            200
        )
        .is_err());
    }
    #[test]
    fn stale_failure_cannot_pause_a_playlist_that_has_already_advanced() {
        let (conn, scope) = fixture();
        let first = begin(&conn, &scope, "playlist:7", Some("first")).unwrap();
        playlist_page(&conn, &scope, 7, &first, &[item(1)], Some(2), false).unwrap();
        stop(&conn, &scope, &first, Some("stale failure")).unwrap();
        assert_eq!(
            task(&conn, &scope, "playlist:7").unwrap().unwrap().status,
            "running"
        );
    }
    #[test]
    fn interrupted_pages_resume_atomically_and_repeated_pages_cannot_claim_complete_coverage() {
        let (conn, scope) = fixture();
        let task = begin(&conn, &scope, "track", None).unwrap();
        roster_page(&conn, &scope, &task, &[item(1), item(2)], Some(3), false).unwrap();
        let resumed = begin(&conn, &scope, "track", None).unwrap();
        assert_eq!(resumed.cursor, 2);
        assert_eq!(resumed.generation, task.generation);
        assert!(roster_page(&conn, &scope, &resumed, &[item(1)], Some(3), true).is_err());
        assert_eq!(task_cursor(&conn, &scope), 2);
        roster_page(&conn, &scope, &resumed, &[item(3)], Some(3), true).unwrap();
        assert_eq!(
            super::task(&conn, &scope, "track").unwrap().unwrap().status,
            "complete"
        );
        assert!(
            super::task(&conn, &format!("plex-{}", "b".repeat(64)), "track")
                .unwrap()
                .is_none()
        );
    }
    fn task_cursor(conn: &Connection, scope: &str) -> i64 {
        task(conn, scope, "track").unwrap().unwrap().cursor
    }
    #[test]
    fn playlist_generations_publish_only_when_complete_and_preserve_duplicate_occurrences() {
        let (conn, scope) = fixture();
        let task = begin(&conn, &scope, "playlist:7", Some("first")).unwrap();
        let mut a = item(1);
        a["playlistItemID"] = serde_json::json!(10);
        let mut b = item(1);
        b["playlistItemID"] = serde_json::json!(11);
        playlist_page(&conn, &scope, 7, &task, &[a.clone()], Some(2), false).unwrap();
        assert_eq!(
            conn.query_row::<i64, _, _>(
                "SELECT COUNT(*) FROM plex_catalogue_playlist_versions",
                [],
                |r| r.get(0)
            )
            .unwrap(),
            0
        );
        let task = super::task(&conn, &scope, "playlist:7").unwrap().unwrap();
        playlist_page(&conn, &scope, 7, &task, &[b], Some(2), true).unwrap();
        let next = begin(&conn, &scope, "playlist:7", Some("second")).unwrap();
        playlist_page(&conn, &scope, 7, &next, &[a], Some(3), false).unwrap();
        assert_eq!(
            conn.query_row::<String, _, _>(
                "SELECT generation FROM plex_catalogue_playlist_versions",
                [],
                |r| r.get(0)
            )
            .unwrap(),
            "first"
        );
        assert_eq!(
            conn.query_row::<i64, _, _>(
                "SELECT COUNT(*) FROM plex_catalogue_playlist_members WHERE generation='first'",
                [],
                |r| r.get(0)
            )
            .unwrap(),
            2
        );
    }
    #[test]
    fn completion_marks_removed_entities_without_discarding_download_metadata() {
        let (conn, scope) = fixture();
        catalogue::save(&conn, &scope, "track", 99, &item(99), true).unwrap();
        let task = begin(&conn, &scope, "track", None).unwrap();
        roster_page(&conn, &scope, &task, &[item(1)], Some(1), true).unwrap();
        assert!(catalogue::get(&conn, &scope, "track", 99)
            .unwrap()
            .is_some());
        assert_eq!(
            conn.query_row::<i64, _, _>(
                "SELECT removed FROM plex_catalogue WHERE id=99",
                [],
                |r| r.get(0)
            )
            .unwrap(),
            1
        );
    }
    #[test]
    fn changed_totals_restart_and_retired_checkpoints_cannot_write_a_new_generation() {
        let (conn, scope) = fixture();
        let old = begin(&conn, &scope, "track", None).unwrap();
        roster_page(&conn, &scope, &old, &[item(1)], Some(2), false).unwrap();
        let resumed = task(&conn, &scope, "track").unwrap().unwrap();
        assert!(roster_page(&conn, &scope, &resumed, &[item(2)], Some(3), false).is_err());
        stop(
            &conn,
            &scope,
            &resumed,
            Some("Plex catalogue changed during sync"),
        )
        .unwrap();
        let replacement = begin(&conn, &scope, "track", None).unwrap();
        assert_ne!(replacement.generation, old.generation);
        assert_eq!(replacement.cursor, 0);
        assert!(roster_page(&conn, &scope, &resumed, &[item(2)], Some(2), true).is_err());
        assert!(catalogue::get(&conn, &scope, "track", 2).unwrap().is_none());
        roster_page(&conn, &scope, &replacement, &[item(3)], Some(1), true).unwrap();
    }
    #[test]
    fn disappeared_details_are_not_claimed_as_full_metadata_and_missing_batches_resume() {
        let (conn, scope) = fixture();
        let roster = begin(&conn, &scope, "track", None).unwrap();
        roster_page(&conn, &scope, &roster, &[item(1), item(2)], Some(2), true).unwrap();
        let details = begin(&conn, &scope, "details:track", Some(&roster.generation)).unwrap();
        detail_page(&conn, &scope, &details, "track", &[1, 2], &[item(1)]).unwrap();
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT detail FROM plex_catalogue WHERE id=2", [], |r| r
                .get(0))
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT removed FROM plex_catalogue WHERE id=2", [], |r| r
                .get(0))
                .unwrap(),
            1
        );
        let next = task(&conn, &scope, "details:track").unwrap().unwrap();
        assert_eq!(next.cursor, 2);
        assert_ne!(next.status, "complete");
        detail_page(&conn, &scope, &next, "track", &[], &[]).unwrap();
        assert_eq!(
            task(&conn, &scope, "details:track")
                .unwrap()
                .unwrap()
                .status,
            "complete"
        );
    }
}
