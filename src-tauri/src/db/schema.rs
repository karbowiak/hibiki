//! Database schema management — runs SQL migrations on startup.

use rusqlite::Connection;

const MIGRATIONS: &[(i64, &str)] = &[
    (1, include_str!("migrations/V1__initial.sql")),
    (2, include_str!("migrations/V2__offline_snapshots.sql")),
    // Retain the applied development migration for existing databases.
    // AI discovery is deferred; no active commands read/write these rows.
    (3, include_str!("migrations/V3__semantic_vectors.sql")),
    (4, include_str!("migrations/V4__local_audio.sql")),
    (5, include_str!("migrations/V5__plex_catalogue.sql")),
    (6, include_str!("migrations/V6__catalogue_sync.sql")),
    (7, include_str!("migrations/V7__download_entities.sql")),
    (8, include_str!("migrations/V8__catalogue_incremental.sql")),
    (
        9,
        include_str!("migrations/V9__catalogue_browse_projections.sql"),
    ),
    (
        10,
        include_str!("migrations/V10__catalogue_tag_duplicates.sql"),
    ),
    (11, include_str!("migrations/V11__catalogue_analysis_lookup.sql")),
    (12, include_str!("migrations/V12__favorites.sql")),
    (13, include_str!("migrations/V13__collection_cache.sql")),
    (14, include_str!("migrations/V14__collection_search.sql")),
    (15, include_str!("migrations/V15__playback_queue.sql")),
    (16, include_str!("migrations/V16__collection_query_revision.sql")),
    (17, include_str!("migrations/V17__collection_pins.sql")),
    (18, include_str!("migrations/V18__matching_index.sql")),
    (19, include_str!("migrations/V19__matching_checkpoint_cleanup.sql")),
    (20, include_str!("migrations/V20__matching_freshness.sql")),
    (21, include_str!("migrations/V21__matching_associations.sql")),
    (22, include_str!("migrations/V22__matching_relationships.sql")),
    (23, include_str!("migrations/V23__matching_reverse_lookup.sql")),
    // V24/V25 have already been used by development builds in other worktrees.
    (26, include_str!("migrations/V26__client_state.sql")),
];

/// Run all pending migrations against the given connection.
///
/// Uses a simple `schema_version` pragma to track which migrations have run.
/// Each migration is an idempotent SQL script applied in order.
pub fn run_migrations(conn: &Connection) -> Result<(), String> {
    let current_version: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| format!("Failed to read schema version: {e}"))?;

    for &(version, sql) in MIGRATIONS {
        if current_version < version {
            apply_migration(conn, version, sql)?;
        }
    }

    Ok(())
}

fn apply_migration(conn: &Connection, version: i64, sql: &str) -> Result<(), String> {
    let transaction = conn
        .unchecked_transaction()
        .map_err(|_| format!("Cannot start migration V{version}"))?;
    transaction
        .execute_batch(sql)
        .map_err(|_| format!("Migration V{version} failed"))?;
    transaction
        .pragma_update(None, "user_version", version)
        .map_err(|_| format!("Cannot record migration V{version}"))?;
    transaction
        .commit()
        .map_err(|_| format!("Cannot commit migration V{version}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_storage_is_created_after_a_newer_development_schema() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", 25).unwrap();
        run_migrations(&conn).unwrap();
        conn.execute("INSERT INTO client_state(namespace,key,value,revision,updated_at) VALUES('local','test','\"saved\"',1,0)", []).unwrap();
        run_migrations(&conn).unwrap();
        let value: String = conn.query_row("SELECT value FROM client_state WHERE key='test'", [], |row| row.get(0)).unwrap();
        assert_eq!(value, "\"saved\"");
    }

    #[test]
    fn v9_upgrade_resumes_duplicate_tag_saves_without_rewriting_metadata_or_progress() {
        let conn = Connection::open_in_memory().unwrap();
        for &(version, sql) in MIGRATIONS.iter().filter(|(version, _)| *version <= 9) {
            apply_migration(&conn, version, sql).unwrap();
        }
        let scope = format!("plex-{}", "a".repeat(64));
        let original = serde_json::json!({"type":"track","ratingKey":42,"title":"Original","updatedAt":1,"Genre":[{"tag":"Rock"}],"future":{"preserve":true}});
        crate::db::catalogue::save(&conn, &scope, "track", 42, &original, false).unwrap();
        let task = crate::db::catalogue_sync::begin(&conn, &scope, "details:track", Some("resume"))
            .unwrap();
        crate::db::catalogue_sync::checkpoint(&conn, &scope, &task, 41, None, false).unwrap();
        let next = serde_json::json!({"type":"track","ratingKey":42,"title":"Full detail","updatedAt":2,"Genre":[{"tag":"Rock"},{"tag":"Rock"},{"tag":"rock"}],"Mood":[{"tag":"Calm"},{"tag":"Calm"}],"Style":[{"tag":"Heavy"},{"tag":"Heavy"}],"Format":[{"tag":"Single"},{"tag":"Single"}],"future":{"preserve":true}});
        // This mirrors the live stalled batch: the full GET repeats a tag that
        // the earlier listing did not. V9's trigger fails inside the UPSERT.
        assert!(crate::db::catalogue::save(&conn, &scope, "track", 42, &next, true).is_err());
        run_migrations(&conn).unwrap();
        assert_eq!(
            crate::db::catalogue::get(&conn, &scope, "track", 42)
                .unwrap()
                .unwrap(),
            original
        );
        let resumed = crate::db::catalogue_sync::task(&conn, &scope, "details:track")
            .unwrap()
            .unwrap();
        assert_eq!(
            (
                resumed.generation.as_str(),
                resumed.cursor,
                resumed.status.as_str()
            ),
            ("resume", 41, "running")
        );
        assert_eq!(
            conn.query_row::<i64, _, _>(
                "SELECT count(*) FROM plex_catalogue_browse_tags",
                [],
                |r| r.get(0)
            )
            .unwrap(),
            1
        );
        crate::db::catalogue::save(&conn, &scope, "track", 42, &next, true).unwrap();
        assert_eq!(
            crate::db::catalogue::get(&conn, &scope, "track", 42)
                .unwrap()
                .unwrap(),
            next
        );
        assert_eq!(
            conn.query_row::<i64, _, _>(
                "SELECT count(*) FROM plex_catalogue_browse_tags",
                [],
                |r| r.get(0)
            )
            .unwrap(),
            5
        );
        let page = crate::db::catalogue_query::query(
            &conn,
            &scope,
            "getTrack",
            &[serde_json::json!("42")],
        )
        .unwrap()
        .unwrap();
        assert_eq!(page.items[0]["title"], "Full detail");
        run_migrations(&conn).unwrap();
        assert_eq!(
            crate::db::catalogue::get(&conn, &scope, "track", 42)
                .unwrap()
                .unwrap(),
            next
        );
    }

    #[test]
    fn test_migrations_are_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();

        // Run once
        run_migrations(&conn).expect("first run");
        let v1: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(v1, MIGRATIONS.last().unwrap().0);

        // Run again — should be a no-op
        run_migrations(&conn).expect("second run");
        let v2: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(v2, v1);
    }

    #[test]
    fn failed_migration_rolls_back_schema_and_version() {
        let conn = Connection::open_in_memory().unwrap();
        assert!(
            apply_migration(&conn, 1, "CREATE TABLE partial(id INTEGER); INVALID SQL;").is_err()
        );
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, 0);
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='partial'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
        run_migrations(&conn).unwrap();
    }

    #[test]
    fn legacy_rows_are_not_imported_into_account_snapshots() {
        let conn = Connection::open_in_memory().unwrap();
        apply_migration(&conn, 1, include_str!("migrations/V1__initial.sql")).unwrap();
        conn.execute("INSERT INTO artists(id,title) VALUES(1,'legacy')", [])
            .unwrap();
        run_migrations(&conn).unwrap();
        let legacy: i64 = conn
            .query_row("SELECT COUNT(*) FROM artists", [], |r| r.get(0))
            .unwrap();
        let scoped: i64 = conn
            .query_row("SELECT COUNT(*) FROM offline_snapshots", [], |r| r.get(0))
            .unwrap();
        assert_eq!((legacy, scoped), (1, 0));
    }

    #[test]
    fn test_all_tables_created() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        run_migrations(&conn).expect("migrations");

        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        let expected = vec![
            "album_reviews",
            "albums",
            "artist_locations",
            "artists",
            "kv",
            "lyrics",
            "media",
            "media_parts",
            "offline_snapshots",
            "play_history",
            "playlist_tracks",
            "playlists",
            "streams",
            "semantic_vectors",
            "tags",
            "tracks",
        ];

        for name in &expected {
            assert!(tables.contains(&name.to_string()), "missing table: {name}");
        }
    }
}
