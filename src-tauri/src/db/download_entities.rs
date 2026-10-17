//! Download intentions retain entity ownership and shared-file references.
use rusqlite::{params, Connection};
pub fn check(scope: &str, kind: &str, id: i64) -> Result<(), String> {
    super::offline::check_identity(scope, kind)?;
    if id <= 0 || !matches!(kind, "track" | "album" | "artist" | "playlist") {
        return Err("Invalid download entity".into());
    }
    Ok(())
}
pub fn requested_collections(
    conn: &Connection,
    scope: &str,
) -> Result<Vec<(String, i64, String)>, String> {
    super::offline::check_identity(scope, "downloads")?;
    let mut query = conn.prepare("SELECT kind,entity_id,revision FROM audio_download_entities WHERE scope=?1 AND kind!='track' ORDER BY captured_at,entity_id").map_err(|_| "Cannot read requested downloads")?;
    let result = query
        .query_map([scope], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(|_| "Cannot read requested downloads")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Cannot read requested downloads".into());
    result
}
pub fn is_current(
    conn: &Connection,
    scope: &str,
    kind: &str,
    id: i64,
    revision: &str,
) -> Result<bool, String> {
    check(scope, kind, id)?;
    conn.query_row("SELECT EXISTS(SELECT 1 FROM audio_download_entities WHERE scope=?1 AND kind=?2 AND entity_id=?3 AND revision=?4)",params![scope,kind,id,revision],|row|row.get(0)).map_err(|_| "Cannot verify requested download".into())
}
pub fn remember(
    conn: &Connection,
    scope: &str,
    kind: &str,
    id: i64,
    title: &str,
    ids: &[i64],
    entries: i64,
) -> Result<String, String> {
    remember_revision(conn, scope, kind, id, title, ids, entries, None)
}
pub fn refresh(
    conn: &Connection,
    scope: &str,
    kind: &str,
    id: i64,
    title: &str,
    ids: &[i64],
    entries: i64,
    expected: &str,
) -> Result<String, String> {
    remember_revision(conn, scope, kind, id, title, ids, entries, Some(expected))
}
fn remember_revision(
    conn: &Connection,
    scope: &str,
    kind: &str,
    id: i64,
    title: &str,
    ids: &[i64],
    entries: i64,
    expected: Option<&str>,
) -> Result<String, String> {
    check(scope, kind, id)?;
    if ids.is_empty()
        || ids.len() > 10000
        || ids.iter().any(|id| *id <= 0)
        || title.len() > 65536
        || entries < (ids.len() as i64)
    {
        return Err("Invalid download membership".into());
    }
    // Background refreshes keep the intention token, so they cannot retire
    // another batch still being admitted for that same explicit request.
    let revision = expected
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let tx = conn
        .unchecked_transaction()
        .map_err(|_| "Cannot save download intention")?;
    if let Some(revision) = expected {
        if !is_current(&tx, scope, kind, id, revision)? {
            return Err("Download request was superseded".into());
        }
    }
    tx.execute("INSERT INTO audio_download_entities(scope,kind,entity_id,title,revision,captured_at,entry_count) VALUES(?1,?2,?3,?4,?5,?6,?7)
  ON CONFLICT(scope,kind,entity_id) DO UPDATE SET title=excluded.title,revision=excluded.revision,captured_at=excluded.captured_at,entry_count=excluded.entry_count",params![scope,kind,id,title,revision,super::catalogue::now(),entries]).map_err(|_|"Cannot save download intention")?;
    // Additions are safe; old tracks remain explicit until the user removes this
    // intention, including editions that changed after a weekly playlist sync.
    tx.execute(
        "DELETE FROM audio_download_members WHERE scope=?1 AND kind=?2 AND entity_id=?3",
        params![scope, kind, id],
    )
    .map_err(|_| "Cannot save download membership")?;
    for track in ids {
        tx.execute("INSERT OR IGNORE INTO audio_download_claims(scope,kind,entity_id,track_id) VALUES(?1,?2,?3,?4)",params![scope,kind,id,track]).map_err(|_|"Cannot save download membership")?;
        tx.execute("INSERT OR IGNORE INTO audio_download_members(scope,kind,entity_id,track_id) VALUES(?1,?2,?3,?4)",params![scope,kind,id,track]).map_err(|_|"Cannot save download membership")?;
        if kind != "track" {
            release_legacy_track(&tx, scope, *track)?;
        }
    }
    tx.commit()
        .map_err(|_| "Cannot commit download intention")?;
    Ok(revision)
}

// V7 had no source provenance for old jobs and used an empty-title track
// intention. Once a verified collection owns that song, adopt the old claim.
// Named individual requests remain independent of collection removal.
fn release_legacy_track(conn: &Connection, scope: &str, track: i64) -> Result<(), String> {
    let legacy: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM audio_download_entities WHERE scope=?1 AND kind='track' AND entity_id=?2 AND title='')",params![scope,track],|r|r.get(0)).map_err(|_|"Cannot verify legacy download ownership")?;
    if legacy {
        for table in [
            "audio_download_claims",
            "audio_download_members",
            "audio_download_entities",
        ] {
            conn.execute(
                &format!("DELETE FROM {table} WHERE scope=?1 AND kind='track' AND entity_id=?2"),
                params![scope, track],
            )
            .map_err(|_| "Cannot adopt legacy download ownership")?;
        }
    }
    Ok(())
}

/// Caller owns the transaction. Only a published download-specific snapshot
/// proves that an absent playlist intention was removed. Ordinary browsing
/// snapshots and unrelated legacy downloads must never authorize deletion.
pub fn reconcile_legacy(conn: &Connection) -> Result<Vec<(String, i64)>, String> {
    let mut stmt=conn.prepare("SELECT e.scope,e.entity_id,EXISTS(SELECT 1 FROM audio_download_claims c WHERE c.scope=e.scope AND c.track_id=e.entity_id AND c.kind!='track') FROM audio_download_entities e WHERE e.kind='track' AND e.title='' AND (EXISTS(SELECT 1 FROM audio_download_claims c WHERE c.scope=e.scope AND c.track_id=e.entity_id AND c.kind!='track') OR EXISTS(SELECT 1 FROM plex_catalogue_playlist_versions v JOIN plex_catalogue_playlist_members m ON m.scope=v.scope AND m.playlist_id=v.playlist_id AND m.generation=v.generation WHERE v.scope=e.scope AND v.generation LIKE 'download:%' AND CAST(json_extract(m.document,'$.ratingKey') AS INTEGER)=e.entity_id AND NOT EXISTS(SELECT 1 FROM audio_download_entities p WHERE p.scope=v.scope AND p.kind='playlist' AND p.entity_id=v.playlist_id))) LIMIT 100001").map_err(|_|"Cannot review legacy downloads")?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, bool>(2)?,
            ))
        })
        .map_err(|_| "Cannot review legacy downloads")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Cannot review legacy downloads")?;
    if rows.len() > 100000 {
        return Err("Too many legacy downloads to reconcile".into());
    }
    let mut removed = vec![];
    for (scope, id, shared) in rows {
        check(&scope, "track", id)?;
        release_legacy_track(conn, &scope, id)?;
        if !shared {
            removed.push((scope, id));
        }
    }
    Ok(removed)
}
/// Called under the native connection and DB locks during each queue admission.
/// A removal/re-add retires old batches; individual removal excludes only that song.
pub fn admit(
    conn: &Connection,
    scope: &str,
    kind: &str,
    id: i64,
    revision: &str,
    ids: &[i64],
) -> Result<Vec<i64>, String> {
    check(scope, kind, id)?;
    let current:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM audio_download_entities WHERE scope=?1 AND kind=?2 AND entity_id=?3 AND revision=?4)",params![scope,kind,id,revision],|r|r.get(0)).map_err(|_|"Cannot verify download intention")?;
    if !current {
        return Err("Download request was superseded".into());
    }
    let mut query=conn.prepare("SELECT EXISTS(SELECT 1 FROM audio_download_claims WHERE scope=?1 AND kind=?2 AND entity_id=?3 AND track_id=?4)").map_err(|_|"Cannot verify download membership")?;
    let mut accepted = vec![];
    for track in ids {
        if query
            .query_row(params![scope, kind, id, track], |r| r.get::<_, bool>(0))
            .map_err(|_| "Cannot verify download membership")?
        {
            accepted.push(*track)
        }
    }
    Ok(accepted)
}
pub fn members(conn: &Connection, scope: &str, kind: &str, id: i64) -> Result<Vec<i64>, String> {
    check(scope, kind, id)?;
    let mut stmt=conn.prepare("SELECT track_id FROM audio_download_members WHERE scope=?1 AND kind=?2 AND entity_id=?3 ORDER BY track_id").map_err(|_|"Cannot read download membership")?;
    let ids = stmt
        .query_map(params![scope, kind, id], |row| row.get(0))
        .map_err(|_| "Cannot read download membership")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Cannot read download membership".into());
    ids
}
/// Caller owns the transaction so file publication/removal and native scope
/// checks cannot race another intention. Track removal intentionally releases
/// that song everywhere; group removal releases just this source's claims.
pub fn detach(conn: &Connection, scope: &str, kind: &str, id: i64) -> Result<Vec<i64>, String> {
    let ids = if kind == "track" {
        vec![id]
    } else {
        let mut stmt=conn.prepare("SELECT track_id FROM audio_download_claims WHERE scope=?1 AND kind=?2 AND entity_id=?3").map_err(|_|"Cannot read owned downloads")?;
        let ids = stmt
            .query_map(params![scope, kind, id], |r| r.get(0))
            .map_err(|_| "Cannot read owned downloads")?
            .collect::<Result<Vec<i64>, _>>()
            .map_err(|_| "Cannot read owned downloads")?;
        ids
    };
    check(scope, kind, id)?;
    if kind == "track" {
        conn.execute(
            "DELETE FROM audio_download_claims WHERE scope=?1 AND track_id=?2",
            params![scope, id],
        )
        .map_err(|_| "Cannot remove download intention")?;
        conn.execute(
            "DELETE FROM audio_download_entities WHERE scope=?1 AND kind='track' AND entity_id=?2",
            params![scope, id],
        )
        .map_err(|_| "Cannot remove download intention")?;
        conn.execute(
            "DELETE FROM audio_download_members WHERE scope=?1 AND kind='track' AND entity_id=?2",
            params![scope, id],
        )
        .map_err(|_| "Cannot remove download intention")?;
    } else {
        conn.execute(
            "DELETE FROM audio_download_claims WHERE scope=?1 AND kind=?2 AND entity_id=?3",
            params![scope, kind, id],
        )
        .map_err(|_| "Cannot remove download intention")?;
        conn.execute(
            "DELETE FROM audio_download_entities WHERE scope=?1 AND kind=?2 AND entity_id=?3",
            params![scope, kind, id],
        )
        .map_err(|_| "Cannot remove download intention")?;
        conn.execute(
            "DELETE FROM audio_download_members WHERE scope=?1 AND kind=?2 AND entity_id=?3",
            params![scope, kind, id],
        )
        .map_err(|_| "Cannot remove download intention")?;
    }
    let mut unclaimed = vec![];
    for track in ids {
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM audio_download_claims WHERE scope=?1 AND track_id=?2",
                params![scope, track],
                |row| row.get(0),
            )
            .map_err(|_| "Cannot verify shared download ownership")?;
        if count == 0 {
            unclaimed.push(track);
        }
    }
    Ok(unclaimed)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refreshed_membership_adds_new_jobs_without_replacing_completed_audio_and_cannot_resurrect_removals(
    ) {
        let conn = Connection::open_in_memory().unwrap();
        super::super::schema::run_migrations(&conn).unwrap();
        let scope = format!("plex-{}", "a".repeat(64));
        let original = remember(&conn, &scope, "playlist", 8, "Likes", &[1], 1).unwrap();
        super::super::audio::enqueue(&conn, &scope, &[1], 10).unwrap();
        let mut completed = super::super::audio::jobs_for_id(&conn, &scope, 1)
            .unwrap()
            .unwrap();
        completed.status = "downloaded".into();
        super::super::audio::update(&conn, &scope, &completed).unwrap();
        let request = requested_collections(&conn, &scope).unwrap();
        assert_eq!(request, vec![("playlist".into(), 8, original.clone())]);
        let next = refresh(
            &conn,
            &scope,
            "playlist",
            8,
            "Likes",
            &[1, 2, 3, 4],
            4,
            &original,
        )
        .unwrap();
        assert_eq!(next, original);
        let admitted = admit(&conn, &scope, "playlist", 8, &next, &[1, 2, 3, 4]).unwrap();
        super::super::audio::enqueue(&conn, &scope, &admitted, 20).unwrap();
        assert_eq!(
            members(&conn, &scope, "playlist", 8).unwrap(),
            vec![1, 2, 3, 4]
        );
        assert_eq!(
            super::super::audio::jobs_for_id(&conn, &scope, 1)
                .unwrap()
                .unwrap()
                .revision,
            completed.revision
        );
        assert_eq!(
            super::super::audio::next(&conn, &scope)
                .unwrap()
                .unwrap()
                .track_id,
            2
        );
        let replacement =
            remember(&conn, &scope, "playlist", 8, "Replaced", &[1, 2, 3, 4], 4).unwrap();
        assert!(refresh(
            &conn,
            &scope,
            "playlist",
            8,
            "Old result",
            &[1],
            1,
            &original
        )
        .is_err());
        detach(&conn, &scope, "playlist", 8).unwrap();
        assert!(refresh(
            &conn,
            &scope,
            "playlist",
            8,
            "Late result",
            &[1, 2],
            2,
            &replacement
        )
        .is_err());
        assert!(requested_collections(&conn, &scope).unwrap().is_empty());
    }
    #[test]
    fn existing_download_jobs_migrate_as_scoped_individual_intentions_without_changing_jobs() {
        let conn = Connection::open_in_memory().unwrap();
        for sql in [
            include_str!("migrations/V1__initial.sql"),
            include_str!("migrations/V2__offline_snapshots.sql"),
            include_str!("migrations/V3__semantic_vectors.sql"),
            include_str!("migrations/V4__local_audio.sql"),
            include_str!("migrations/V5__plex_catalogue.sql"),
            include_str!("migrations/V6__catalogue_sync.sql"),
        ] {
            conn.execute_batch(sql).unwrap();
        }
        conn.pragma_update(None, "user_version", 6).unwrap();
        let first = format!("plex-{}", "a".repeat(64));
        let second = format!("plex-{}", "b".repeat(64));
        crate::db::audio::enqueue(&conn, &first, &[1, 2], 10).unwrap();
        crate::db::audio::enqueue(&conn, &second, &[1], 20).unwrap();
        let before = crate::db::audio::jobs_for_id(&conn, &first, 1)
            .unwrap()
            .unwrap()
            .revision;
        crate::db::schema::run_migrations(&conn).unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        assert_eq!(members(&conn, &first, "track", 1).unwrap(), vec![1]);
        assert_eq!(members(&conn, &first, "track", 2).unwrap(), vec![2]);
        assert_eq!(members(&conn, &second, "track", 1).unwrap(), vec![1]);
        assert!(members(&conn, &second, "track", 2).unwrap().is_empty());
        assert_eq!(
            crate::db::audio::jobs_for_id(&conn, &first, 1)
                .unwrap()
                .unwrap()
                .revision,
            before
        );
        remember(&conn, &first, "album", 9, "Album", &[1, 2], 2).unwrap();
        let mut removed = detach(&conn, &first, "album", 9).unwrap();
        removed.sort();
        assert_eq!(removed, vec![1, 2]);
        assert_eq!(members(&conn, &second, "track", 1).unwrap(), vec![1]);
    }
    #[test]
    fn removal_and_readdition_fence_pending_batches_without_resurrecting_removed_songs() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        let scope = format!("plex-{}", "a".repeat(64));
        let old = remember(&conn, &scope, "album", 9, "Album", &[1, 2, 3], 3).unwrap();
        detach(&conn, &scope, "track", 2).unwrap();
        assert_eq!(
            admit(&conn, &scope, "album", 9, &old, &[1, 2, 3]).unwrap(),
            vec![1, 3]
        );
        detach(&conn, &scope, "album", 9).unwrap();
        assert!(admit(&conn, &scope, "album", 9, &old, &[3]).is_err());
        let new = remember(&conn, &scope, "album", 9, "Album", &[1, 2, 3], 3).unwrap();
        assert_ne!(old, new);
        assert!(admit(&conn, &scope, "album", 9, &old, &[3]).is_err());
        assert_eq!(
            admit(&conn, &scope, "album", 9, &new, &[3]).unwrap(),
            vec![3]
        );
    }
    #[test]
    fn group_removal_preserves_shared_and_explicit_individual_intentions() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        let scope = format!("plex-{}", "a".repeat(64));
        remember(&conn, &scope, "track", 1, "Song", &[1], 1).unwrap();
        remember(&conn, &scope, "album", 2, "Album", &[1, 2], 2).unwrap();
        remember(&conn, &scope, "playlist", 3, "Playlist", &[2, 3], 3).unwrap();
        assert!(detach(&conn, &scope, "album", 2).unwrap().is_empty());
        assert_eq!(detach(&conn, &scope, "playlist", 3).unwrap(), vec![2, 3]);
        assert_eq!(members(&conn, &scope, "track", 1).unwrap(), vec![1]);
        assert_eq!(detach(&conn, &scope, "track", 1).unwrap(), vec![1]);
    }
    #[test]
    fn legacy_cleanup_requires_a_removed_download_snapshot_and_preserves_other_owners() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        let scope = format!("plex-{}", "a".repeat(64));
        let other = format!("plex-{}", "b".repeat(64));
        for id in 1..=5 {
            remember(
                &conn,
                &scope,
                "track",
                id,
                if id == 3 { "Explicit song" } else { "" },
                &[id],
                1,
            )
            .unwrap();
        }
        remember(&conn, &other, "track", 1, "", &[1], 1).unwrap();
        remember(&conn, &scope, "album", 9, "Keep album", &[2], 1).unwrap();
        conn.execute("INSERT INTO plex_catalogue_playlist_versions(scope,playlist_id,generation,total,saved_at) VALUES(?1,8,'download:verified',3,1),(?1,7,'browse:verified',1,1)",[&scope]).unwrap();
        for id in 1..=4 {
            let (playlist, generation) = if id == 4 {
                (7, "browse:verified")
            } else {
                (8, "download:verified")
            };
            conn.execute("INSERT INTO plex_catalogue_playlist_members(scope,playlist_id,generation,position,document) VALUES(?1,?2,?3,?4,?5)",params![scope,playlist,generation,id,serde_json::json!({"ratingKey":id.to_string()}).to_string()]).unwrap();
        }
        assert_eq!(reconcile_legacy(&conn).unwrap(), vec![(scope.clone(), 1)]);
        assert!(members(&conn, &scope, "track", 1).unwrap().is_empty());
        assert_eq!(members(&conn, &scope, "album", 9).unwrap(), vec![2]);
        for id in [3, 4, 5] {
            assert_eq!(members(&conn, &scope, "track", id).unwrap(), vec![id]);
        }
        assert_eq!(members(&conn, &other, "track", 1).unwrap(), vec![1]);
        assert!(reconcile_legacy(&conn).unwrap().is_empty());
    }
    #[test]
    fn startup_adopts_preexisting_collection_claims_without_releasing_shared_audio() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        let scope = format!("plex-{}", "a".repeat(64));
        remember(&conn, &scope, "album", 9, "Album", &[1], 1).unwrap();
        remember(&conn, &scope, "track", 1, "", &[1], 1).unwrap();
        assert!(reconcile_legacy(&conn).unwrap().is_empty());
        assert!(members(&conn, &scope, "track", 1).unwrap().is_empty());
        assert_eq!(members(&conn, &scope, "album", 9).unwrap(), vec![1]);
        assert_eq!(detach(&conn, &scope, "album", 9).unwrap(), vec![1]);
    }
    #[test]
    fn removing_a_song_keeps_expected_membership_and_releases_old_playlist_editions() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        let scope = format!("plex-{}", "a".repeat(64));
        remember(&conn, &scope, "playlist", 8, "Weekly", &[1, 2], 2).unwrap();
        assert_eq!(detach(&conn, &scope, "track", 1).unwrap(), vec![1]);
        assert_eq!(members(&conn, &scope, "playlist", 8).unwrap(), vec![1, 2]);
        // The next weekly edition owns its new songs without deleting old bytes.
        remember(&conn, &scope, "playlist", 8, "Weekly", &[3, 4], 2).unwrap();
        assert_eq!(members(&conn, &scope, "playlist", 8).unwrap(), vec![3, 4]);
        let mut released = detach(&conn, &scope, "playlist", 8).unwrap();
        released.sort();
        assert_eq!(released, vec![2, 3, 4]);
    }
    #[test]
    fn ownership_is_scoped_and_invalid_membership_does_not_partially_publish() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        let scope = format!("plex-{}", "a".repeat(64));
        assert!(remember(&conn, &scope, "album", 2, "Album", &[1, -2], 2).is_err());
        assert!(members(&conn, &scope, "album", 2).unwrap().is_empty());
        remember(&conn, &scope, "album", 2, "Album", &[1], 1).unwrap();
        assert!(
            members(&conn, &format!("plex-{}", "b".repeat(64)), "album", 2)
                .unwrap()
                .is_empty()
        );
    }
}
