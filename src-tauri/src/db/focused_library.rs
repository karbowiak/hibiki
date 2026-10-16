//! Metadata retention follows offline audio and favorites, never a library crawl.
use rusqlite::{params, Connection};
use std::collections::HashSet;

pub const PRUNE_SQL: &str = include_str!("focused_library.sql");

pub fn favorite_ids(conn: &Connection, scope: &str) -> Result<HashSet<i64>, String> {
    let mut stmt = conn.prepare("SELECT DISTINCT CAST(j.value AS INTEGER) FROM favorites_entries f,json_each(f.payload,'$.localTrackIds') j WHERE f.scope=?1 AND CAST(j.value AS INTEGER)>0")
        .map_err(|_| "Cannot read favorite identities")?;
    let result = stmt
        .query_map([scope], |r| r.get(0))
        .map_err(|_| "Cannot read favorite identities")?
        .collect::<Result<_, _>>()
        .map_err(|_| "Cannot read favorite identities".into());
    result
}

/// Called at reconnect on the blocking DB lane. Completed files are retained;
/// evicted playback metadata has only a small recent working set. Explicit
/// download jobs/claims remain protected even while their files are unavailable.
pub fn maintain(
    conn: &Connection,
    scope: &str,
    present: impl Fn(&str) -> bool,
) -> Result<(), String> {
    super::offline::check_identity(scope, "maintenance")?;
    let mut stmt = conn.prepare("SELECT l.track_id,l.cache_key FROM local_audio l WHERE l.scope=?1 AND NOT EXISTS(SELECT 1 FROM audio_download_jobs j WHERE j.scope=l.scope AND j.track_id=l.track_id) AND NOT EXISTS(SELECT 1 FROM audio_download_claims c WHERE c.scope=l.scope AND c.track_id=l.track_id) ORDER BY l.saved_at DESC,l.track_id,l.cache_key LIMIT -1 OFFSET 256")
        .map_err(|_| "Cannot inspect evicted audio metadata")?;
    let rows = stmt
        .query_map([scope], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|_| "Cannot inspect evicted audio metadata")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Cannot inspect evicted audio metadata")?;
    drop(stmt);
    super::atomic_upsert(conn, |conn| {
        for (id, key) in &rows {
            if !present(key) {
                conn.execute(
                    "DELETE FROM local_audio WHERE scope=?1 AND track_id=?2 AND cache_key=?3",
                    params![scope, id, key],
                )
                .map_err(|_| "Cannot retire evicted audio metadata")?;
            }
        }
        conn.execute_batch("CREATE TEMP TABLE IF NOT EXISTS focused_scope(scope TEXT PRIMARY KEY); DELETE FROM focused_scope;")
            .map_err(|_| "Cannot prepare focused metadata retention")?;
        conn.execute("INSERT INTO focused_scope VALUES(?1)", [scope])
            .map_err(|_| "Cannot select focused metadata owner")?;
        conn.execute_batch(PRUNE_SQL)
            .map_err(|_| "Cannot retire library mirror")?;
        conn.execute_batch("DROP TABLE focused_scope;")
            .map_err(|_| "Cannot finish focused metadata retention")?;
        Ok(())
    })
}

/// A partial offline collection can still be browsed without ever claiming to
/// cover the server's complete artist/album inventory.
pub fn related_page(
    conn: &Connection,
    scope: &str,
    method: &str,
    args: &[serde_json::Value],
) -> Result<Option<super::catalogue_query::Page>, String> {
    let (kind, parent) = match method {
        "getAlbumTracks" => ("track", "download_album"),
        "getArtistAlbums" | "getArtistAlbumsInSection" => ("album", "download_album"),
        _ => return Ok(None),
    };
    let id = args
        .first()
        .and_then(serde_json::Value::as_str)
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|id| *id > 0)
        .ok_or("Invalid offline collection")?;
    // Optional album-format filters are applied by Plex online. Do not present
    // an unfiltered archive as a filtered result when that exact page is absent.
    if kind == "album"
        && args
            .get(1)
            .and_then(serde_json::Value::as_str)
            .is_some_and(|v| !v.is_empty())
    {
        return Ok(None);
    }
    let mut stmt = conn.prepare(&format!("SELECT document,saved_at FROM plex_catalogue WHERE scope=?1 AND kind=?2 AND removed=0 AND {parent}=?3 ORDER BY CAST(json_extract(document,'$.parentIndex') AS INTEGER),CAST(json_extract(document,'$.index') AS INTEGER),id LIMIT 10001"))
        .map_err(|_| "Cannot read offline collection")?;
    let rows = stmt
        .query_map(params![scope, kind, id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })
        .map_err(|_| "Cannot read offline collection")?;
    let mut items = Vec::new();
    let mut cached_at = 0;
    let mut bytes = 0;
    for row in rows {
        let (raw, at) = row.map_err(|_| "Cannot read offline collection")?;
        let projected = super::catalogue_query::project(
            kind,
            serde_json::from_str(&raw).map_err(|_| "Invalid offline metadata")?,
        )?;
        bytes += projected.to_string().len();
        if items.len() >= 10000 || bytes > 32 * 1024 * 1024 {
            return Err("This offline collection exceeds the response limit".into());
        }
        items.push(projected);
        cached_at = cached_at.max(at);
    }
    Ok(Some(super::catalogue_query::Page {
        total: items.len() as i64,
        items,
        cached_at,
        complete: false,
        server_total: None,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn retiring_mirror_preserves_owned_state_offline_documents_and_exact_analysis() {
        let db = Connection::open_in_memory().unwrap();
        super::super::schema::run_migrations(&db).unwrap();
        let scope = format!("plex-{}", "a".repeat(64));
        let other = format!("plex-{}", "b".repeat(64));
        for (kind, id, parent, artist) in [
            ("artist", 9, 0, 0),
            ("album", 7, 9, 0),
            ("track", 42, 7, 9),
            ("track", 43, 8, 10),
            ("track", 99, 8, 10),
            ("playlist", 5, 0, 0),
            ("playlist", 6, 0, 0),
        ] {
            super::super::catalogue::save(&db,&scope,kind,id,&json!({"ratingKey":id,"type":kind,"title":"Saved","parentRatingKey":parent,"grandparentRatingKey":artist}),true).unwrap();
        }
        super::super::catalogue::save(
            &db,
            &other,
            "track",
            99,
            &json!({"ratingKey":99,"type":"track","title":"Other"}),
            true,
        )
        .unwrap();
        db.execute(
            "INSERT INTO local_audio VALUES(?1,42,'kept','flac',?2,1)",
            params![scope, json!({"albumId":"7","artistId":"9"}).to_string()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO audio_download_entities VALUES(?1,'playlist',5,'Mine','revision',1,1)",
            [&scope],
        )
        .unwrap();
        db.execute(
            "INSERT INTO audio_download_members VALUES(?1,'playlist',5,42,'{}')",
            [&scope],
        )
        .unwrap();
        db.execute(
            "INSERT INTO audio_download_claims VALUES(?1,'playlist',5,42)",
            [&scope],
        )
        .unwrap();
        db.execute(
            "INSERT INTO plex_catalogue_playlist_versions VALUES(?1,5,'download:revision',2,1)",
            [&scope],
        )
        .unwrap();
        for pos in 0..2 {
            db.execute("INSERT INTO plex_catalogue_playlist_members(scope,playlist_id,generation,position,document) VALUES(?1,5,'download:revision',?2,?3)",params![scope,pos,json!({"ratingKey":42,"type":"track"}).to_string()]).unwrap();
        }
        let meta = json!({"version":1,"settings":{"lastfm":true},"bindings":{"lastfm":{"test":"retained"}}});
        super::super::favorites::save(&db,&scope,0,&meta,&[super::super::favorites::FavoriteRow{id:"favorite".into(),payload:json!({"id":"favorite","liked":true,"likedAt":1234,"localTrackIds":["43"]})}]).unwrap();
        super::super::offline::put(&db, &scope, "visited", &json!({"title":"Visited"}), 1).unwrap();
        for key in ["kept", "unrelated"] {
            super::super::catalogue::save_levels(
                &db,
                &scope,
                key,
                1,
                "exact-v1",
                &json!({"Level":[{"v":0.5}],"unknown":"preserved"}),
            )
            .unwrap();
        }
        db.execute("INSERT INTO plex_catalogue_tasks(scope,task,generation,status,updated_at) VALUES(?1,'track','old','running',1)",[&scope]).unwrap();
        maintain(&db, &scope, |_| true).unwrap();
        assert!(super::super::catalogue::get(&db, &scope, "track", 99)
            .unwrap()
            .is_none());
        for (kind, id) in [
            ("track", 42),
            ("track", 43),
            ("album", 7),
            ("artist", 9),
            ("playlist", 5),
        ] {
            assert!(super::super::catalogue::get(&db, &scope, kind, id)
                .unwrap()
                .is_some());
        }
        assert!(super::super::catalogue::get(&db, &scope, "playlist", 6)
            .unwrap()
            .is_none());
        assert!(super::super::catalogue::get(&db, &other, "track", 99)
            .unwrap()
            .is_some());
        assert_eq!(
            super::super::catalogue::levels(&db, &scope, "kept", 1, "exact-v1")
                .unwrap()
                .unwrap()["unknown"],
            "preserved"
        );
        assert!(
            super::super::catalogue::levels(&db, &scope, "unrelated", 1, "exact-v1")
                .unwrap()
                .is_none()
        );
        assert_eq!(
            super::super::favorites::load(&db, &scope).unwrap().metadata,
            meta
        );
        assert_eq!(
            super::super::favorites::page(&db, &scope, 0, 100).unwrap()[0].payload["likedAt"],
            1234
        );
        assert!(super::super::offline::peek(&db, &scope, "visited")
            .unwrap()
            .is_some());
        assert_eq!(
            db.query_row("SELECT count(*) FROM audio_download_claims", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            super::super::catalogue_query::query(
                &db,
                &scope,
                "getPlaylistItems",
                &[json!("5"), json!(0), json!(100)]
            )
            .unwrap()
            .unwrap()
            .items
            .len(),
            2
        );
        assert_eq!(
            related_page(&db, &scope, "getArtistAlbumsInSection", &[json!("9")])
                .unwrap()
                .unwrap()
                .items
                .len(),
            1
        );
        assert!(super::super::catalogue_sync::task(&db, &scope, "track")
            .unwrap()
            .is_none());
        maintain(&db, &scope, |_| true).unwrap(); // idempotent and no foreign-scope adoption
        assert_eq!(
            db.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
    }
    #[test]
    fn cleanup_is_atomic_and_evicts_only_unplayable_unowned_old_metadata() {
        let db = Connection::open_in_memory().unwrap();
        super::super::schema::run_migrations(&db).unwrap();
        let scope = format!("plex-{}", "a".repeat(64));
        for id in 1..=300 {
            db.execute(
                "INSERT INTO local_audio VALUES(?1,?2,?3,'flac','{}',?2)",
                params![scope, id, format!("key-{id}")],
            )
            .unwrap();
        }
        super::super::audio::enqueue(&db, &scope, &[1], 1).unwrap();
        super::super::catalogue::save(
            &db,
            &scope,
            "track",
            999,
            &json!({"ratingKey":999,"type":"track","title":"Unrelated"}),
            true,
        )
        .unwrap();
        db.execute_batch("CREATE TRIGGER fail_cleanup BEFORE DELETE ON plex_catalogue BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
        assert!(maintain(&db, &scope, |key| key == "key-2").is_err());
        assert_eq!(
            db.query_row("SELECT count(*) FROM local_audio", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            300,
            "failed pruning must roll back prior metadata deletions"
        );
        db.execute_batch("DROP TRIGGER fail_cleanup;").unwrap();
        maintain(&db, &scope, |key| key == "key-2").unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM local_audio", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            258,
            "256 recent bindings plus an actual cached file and an explicit job"
        );
        assert_eq!(
            super::super::audio::bindings(&db, &scope, 1).unwrap().len(),
            1
        );
        assert_eq!(
            super::super::audio::bindings(&db, &scope, 2).unwrap().len(),
            1
        );
        assert!(super::super::audio::bindings(&db, &scope, 3)
            .unwrap()
            .is_empty());
    }
}
