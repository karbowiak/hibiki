//! Bounded waveform queue; full native levels remain keyed by exact media revision.
use rusqlite::{params, Connection};
use serde_json::Value;

#[derive(Clone, Debug)]
pub struct Pending {
    pub track_id: i64,
    pub cache_key: String,
    pub stream_id: i64,
    pub version: String,
    pub cached: bool,
}

/// Detail and live-change publications already discover media atomically.
/// Only legacy/previously visited tracks without a discovery need this pass.
pub fn discovery_page(
    conn: &Connection,
    scope: &str,
    cursor: i64,
) -> Result<Vec<(i64, String)>, String> {
    let mut stmt = conn.prepare("SELECT c.id,c.document FROM (SELECT c.scope,c.id FROM plex_catalogue c INDEXED BY plex_catalogue_detail WHERE c.scope=?1 AND c.kind='track' AND c.detail=1 AND c.removed=0 AND c.id>?2 AND NOT EXISTS(SELECT 1 FROM plex_catalogue_media m INDEXED BY plex_catalogue_active_media WHERE m.scope=c.scope AND m.track_id=c.id AND m.active=1) ORDER BY c.id LIMIT 50) missing JOIN plex_catalogue c ON c.scope=missing.scope AND c.kind='track' AND c.id=missing.id").map_err(|_| "Cannot read analysis discovery")?;
    let rows = stmt
        .query_map(params![scope, cursor], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|_| "Cannot read analysis discovery")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Cannot read analysis discovery".to_owned());
    rows
}

pub fn pending(conn: &Connection, scope: &str, limit: usize) -> Result<Vec<Pending>, String> {
    if !(1..=32).contains(&limit) {
        return Err("Invalid waveform batch".into());
    }
    let mut stmt = conn.prepare("SELECT m.track_id,m.cache_key,m.stream_id,m.version,EXISTS(SELECT 1 FROM plex_audio_analysis a WHERE a.scope=m.scope AND a.cache_key=m.cache_key AND a.stream_id=m.stream_id AND a.version=m.version) FROM plex_catalogue_media m WHERE m.scope=?1 AND m.active=1 AND m.stream_id>0 AND m.status='pending' ORDER BY m.track_id LIMIT ?2").map_err(|_| "Cannot read pending analysis")?;
    let rows = stmt
        .query_map(params![scope, limit as i64], |row| {
            Ok(Pending {
                track_id: row.get(0)?,
                cache_key: row.get(1)?,
                stream_id: row.get(2)?,
                version: row.get(3)?,
                cached: row.get(4)?,
            })
        })
        .map_err(|_| "Cannot read pending analysis")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Cannot read pending analysis".to_owned());
    rows
}

pub fn publish(
    conn: &Connection,
    scope: &str,
    batch: &[(Pending, Result<Option<Value>, String>)],
) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|_| "Cannot save waveform batch")?;
    for (item, result) in batch {
        let Ok(raw) = result else { continue };
        let current: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM plex_catalogue_media WHERE scope=?1 AND track_id=?2 AND cache_key=?3 AND stream_id=?4 AND version=?5 AND active=1 AND status='pending')",params![scope,item.track_id,item.cache_key,item.stream_id,item.version],|r|r.get(0)).map_err(|_| "Cannot fence waveform result")?;
        if !current {
            continue;
        }
        if let Some(raw) = raw {
            super::catalogue::save_levels(
                &tx,
                scope,
                &item.cache_key,
                item.stream_id,
                &item.version,
                raw,
            )?;
        }
        // Foreground playback may have saved the same levels while the GET
        // was in flight. A missing/404 result must never overwrite that fact.
        tx.execute("UPDATE plex_catalogue_media SET status=CASE WHEN EXISTS(SELECT 1 FROM plex_audio_analysis a WHERE a.scope=?1 AND a.cache_key=?3 AND a.stream_id=?4 AND a.version=?5) THEN 'saved' ELSE 'unavailable' END,attempted_at=?6 WHERE scope=?1 AND track_id=?2 AND cache_key=?3 AND stream_id=?4 AND version=?5 AND (?7=0 OR EXISTS(SELECT 1 FROM plex_audio_analysis a WHERE a.scope=?1 AND a.cache_key=?3 AND a.stream_id=?4 AND a.version=?5))",params![scope,item.track_id,item.cache_key,item.stream_id,item.version,super::catalogue::now(),item.cached]).map_err(|_| "Cannot checkpoint waveform result")?;
    }
    tx.commit()
        .map_err(|_| "Cannot commit waveform batch".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn fixture() -> (Connection, String) {
        let conn = Connection::open_in_memory().unwrap();
        super::super::schema::run_migrations(&conn).unwrap();
        (conn, format!("plex-{}", "a".repeat(64)))
    }
    fn enqueue(conn: &Connection, scope: &str, id: i64) {
        conn.execute("INSERT INTO plex_catalogue_media(scope,track_id,cache_key,stream_id,version) VALUES(?1,?2,?3,?2,'v1')",params![scope,id,format!("key-{id}")]).unwrap();
    }
    #[test]
    fn discovery_skips_published_identities_and_preserves_unknown_full_metadata() {
        let (conn, scope) = fixture();
        for id in 1..=6 {
            super::super::catalogue::save(
                &conn,
                &scope,
                "track",
                id,
                &json!({"type":"track","ratingKey":id,"future":{"retain":[1,2,3]}}),
                id != 5,
            )
            .unwrap();
        }
        enqueue(&conn, &scope, 1);
        enqueue(&conn, &scope, 2);
        conn.execute(
            "UPDATE plex_catalogue_media SET active=0 WHERE track_id=2",
            [],
        )
        .unwrap();
        enqueue(&conn, &format!("plex-{}", "b".repeat(64)), 3);
        conn.execute("UPDATE plex_catalogue SET removed=1 WHERE id=4", [])
            .unwrap();
        let rows = discovery_page(&conn, &scope, 0).unwrap();
        assert_eq!(rows.iter().map(|r| r.0).collect::<Vec<_>>(), [2, 3, 6]);
        assert_eq!(
            serde_json::from_str::<Value>(&rows[0].1).unwrap()["future"]["retain"],
            json!([1, 2, 3])
        );
        assert_eq!(
            discovery_page(&conn, &scope, 3)
                .unwrap()
                .iter()
                .map(|r| r.0)
                .collect::<Vec<_>>(),
            [6]
        );
    }
    #[test]
    fn batches_resume_failures_reuse_foreground_levels_and_fence_retired_revisions() {
        let (conn, scope) = fixture();
        for id in 1..=7 {
            enqueue(&conn, &scope, id);
        }
        let levels = json!({"Level":[{"v":0.1},{"v":0.3}],"future":"retain"});
        super::super::catalogue::save_levels(&conn, &scope, "key-5", 5, "v1", &levels).unwrap();
        let jobs = pending(&conn, &scope, 6).unwrap();
        assert_eq!(jobs.len(), 6);
        assert!(jobs[4].cached);
        assert!(!jobs[0].cached);
        assert!(pending(&conn, &scope, 33).is_err());
        conn.execute(
            "UPDATE plex_catalogue_media SET active=0 WHERE track_id=4",
            [],
        )
        .unwrap();
        // The foreground fills job 6 after the bulk read; 404 cannot undo it.
        super::super::catalogue::save_levels(&conn, &scope, "key-6", 6, "v1", &levels).unwrap();
        let results = jobs
            .into_iter()
            .enumerate()
            .map(|(i, j)| {
                (
                    j,
                    match i {
                        0 | 3 => Ok(Some(levels.clone())),
                        1 => Ok(None),
                        2 => Err("timeout".into()),
                        _ => Ok(None),
                    },
                )
            })
            .collect::<Vec<_>>();
        publish(&conn, &scope, &results).unwrap();
        let statuses = conn
            .prepare("SELECT track_id,status FROM plex_catalogue_media ORDER BY track_id")
            .unwrap()
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            statuses,
            vec![
                (1, "saved".into()),
                (2, "unavailable".into()),
                (3, "pending".into()),
                (4, "pending".into()),
                (5, "saved".into()),
                (6, "saved".into()),
                (7, "pending".into())
            ]
        );
        assert!(
            super::super::catalogue::levels(&conn, &scope, "key-4", 4, "v1")
                .unwrap()
                .is_none()
        );
        assert_eq!(
            super::super::catalogue::levels(&conn, &scope, "key-1", 1, "v1").unwrap(),
            Some(levels)
        );
        let other = format!("plex-{}", "b".repeat(64));
        enqueue(&conn, &other, 1);
        assert_eq!(
            pending(&conn, &scope, 24)
                .unwrap()
                .iter()
                .map(|p| p.track_id)
                .collect::<Vec<_>>(),
            [3, 7]
        );
        assert_eq!(pending(&conn, &other, 24).unwrap().len(), 1);
    }
}
