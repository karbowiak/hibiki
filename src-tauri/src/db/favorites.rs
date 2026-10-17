use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Deserialize, Serialize)]
pub struct FavoriteRow {
    pub id: String,
    pub payload: Value,
}
#[derive(Serialize)]
pub struct FavoriteProfile {
    pub revision: i64,
    pub metadata: Value,
    pub total: i64,
}
pub fn load(conn: &Connection, scope: &str) -> Result<FavoriteProfile, String> {
    let row: Option<(i64, String)> = conn
        .query_row(
            "SELECT revision,metadata FROM favorites_profiles WHERE scope=?1",
            [scope],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|_| "Cannot read favorite settings")?;
    let (revision, metadata) = match row {
        Some((r, v)) => (
            r,
            serde_json::from_str(&v).map_err(|_| "Favorite settings are invalid")?,
        ),
        None => (
            0,
            json!({"version":1,"ratingModel":1,"settings":{"plex":false,"listenbrainz":false,"lastfm":false,"ratingThreshold":6},"bindings":{}}),
        ),
    };
    let total = conn
        .query_row(
            "SELECT count(*) FROM favorites_entries WHERE scope=?1",
            [scope],
            |r| r.get(0),
        )
        .map_err(|_| "Cannot count favorites")?;
    Ok(FavoriteProfile {
        revision,
        metadata,
        total,
    })
}
pub fn page(
    conn: &Connection,
    scope: &str,
    offset: usize,
    limit: usize,
) -> Result<Vec<FavoriteRow>, String> {
    if limit == 0 || limit > 1000 || offset > 100000 {
        return Err("Invalid favorite page".into());
    }
    let mut stmt = conn.prepare("SELECT id,payload FROM favorites_entries WHERE scope=?1 ORDER BY id LIMIT ?2 OFFSET ?3").map_err(|_| "Cannot read favorites")?;
    let rows = stmt
        .query_map(params![scope, limit as i64, offset as i64], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|_| "Cannot read favorites")?;
    rows.map(|r| {
        let (id, v) = r.map_err(|_| "Cannot read favorite")?;
        Ok(FavoriteRow {
            id,
            payload: serde_json::from_str(&v).map_err(|_| "Invalid saved favorite")?,
        })
    })
    .collect()
}
fn safe(value: &Value, depth: usize) -> bool {
    if depth > 12 {
        return false;
    }
    match value {
        Value::Object(values) => values.iter().all(|(key, value)| {
            ![
                "token",
                "apikey",
                "apisecret",
                "sessionkey",
                "providerdata",
                "streamurl",
                "accesstoken",
                "xplextoken",
            ]
            .contains(&key.to_ascii_lowercase().replace(['_', '-'], "").as_str())
                && safe(value, depth + 1)
        }),
        Value::Array(values) => values.iter().all(|value| safe(value, depth + 1)),
        _ => true,
    }
}
pub fn save(
    conn: &Connection,
    scope: &str,
    expected: i64,
    metadata: &Value,
    rows: &[FavoriteRow],
) -> Result<i64, String> {
    if expected < 0
        || rows.len() > 1000
        || !safe(metadata, 0)
        || metadata.to_string().len() > 262144
        || metadata.get("version").and_then(Value::as_i64) != Some(1)
    {
        return Err("Invalid favorite settings".into());
    }
    for row in rows {
        if row.id.is_empty()
            || row.id.len() > 2048
            || row.payload.to_string().len() > 16384
            || !safe(&row.payload, 0)
            || row.payload.get("id").and_then(Value::as_str) != Some(&row.id)
            || !row.payload.get("liked").is_some_and(Value::is_boolean)
        {
            return Err("Invalid favorite record".into());
        }
    }
    crate::db::atomic_upsert(conn, |tx| {
        let current = load(tx, scope)?;
        if current.revision != expected {
            return Err("Favorites changed; reload before saving".into());
        }
        let revision = expected
            .checked_add(1)
            .ok_or("Favorite revision exhausted")?;
        tx.execute("INSERT INTO favorites_profiles(scope,revision,metadata) VALUES(?1,?2,?3) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,metadata=excluded.metadata",params![scope,revision,metadata.to_string()]).map_err(|_| "Cannot save favorite settings")?;
        let mut stmt=tx.prepare("INSERT INTO favorites_entries(scope,id,payload) VALUES(?1,?2,?3) ON CONFLICT(scope,id) DO UPDATE SET payload=excluded.payload").map_err(|_| "Cannot save favorites")?;
        for row in rows {
            stmt.execute(params![scope, row.id, row.payload.to_string()])
                .map_err(|_| "Cannot save favorite")?;
        }
        Ok(revision)
    })
}

/// Reimport this library's service observations without discarding local intent.
pub fn reset(conn: &Connection, scope: &str, expected: i64) -> Result<i64, String> {
    crate::db::atomic_upsert(conn, |tx| {
        let profile = load(tx, scope)?;
        if expected < 0 || profile.revision != expected {
            return Err("Favorites changed; reload before resetting".into());
        }
        let mut metadata = profile.metadata;
        let bindings = metadata
            .get_mut("bindings")
            .and_then(Value::as_object_mut)
            .ok_or("Favorite settings are invalid")?;
        for binding in bindings.values_mut() {
            let binding = binding
                .as_object_mut()
                .ok_or("Favorite settings are invalid")?;
            if binding.get("pending").is_some_and(|v| !v.is_null())
                || binding.get("creation").is_some_and(|v| !v.is_null())
            {
                return Err("Review pending sync changes before resetting liked sync".into());
            }
            binding.insert("initialized".into(), json!(false));
        }
        metadata["ratingsImported"] = json!(false);
        let revision = expected
            .checked_add(1)
            .ok_or("Favorite revision exhausted")?;
        tx.execute("DELETE FROM favorites_entries WHERE scope=?1 AND json_extract(payload,'$.explicit') IS NOT 1", [scope])
            .map_err(|_| "Cannot reset imported favorites")?;
        tx.execute("UPDATE favorites_entries SET payload=json_remove(json_set(payload,'$.sources',json('{}')),'$.matchCheckedAt') WHERE scope=?1", [scope])
            .map_err(|_| "Cannot reset favorite observations")?;
        tx.execute("INSERT INTO favorites_profiles(scope,revision,metadata) VALUES(?1,?2,?3) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,metadata=excluded.metadata", params![scope,revision,metadata.to_string()])
            .map_err(|_| "Cannot reset favorite settings")?;
        Ok(revision)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_defaults_scopes_cas_and_tombstones_survive_reload() {
        let db = Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&db).unwrap();
        let initial = load(&db, "one").unwrap();
        assert_eq!(initial.metadata["settings"]["plex"], false);
        let row = FavoriteRow {
            id: "track".into(),
            payload: json!({"id":"track","liked":true,"title":"Song"}),
        };
        assert_eq!(
            save(&db, "one", 0, &initial.metadata, &[row.clone()]).unwrap(),
            1
        );
        assert!(save(&db, "one", 0, &initial.metadata, &[row.clone()]).is_err());
        assert!(page(&db, "other", 0, 100).unwrap().is_empty());
        let mut removed = row.clone();
        removed.payload["liked"] = json!(false);
        save(&db, "one", 1, &initial.metadata, &[removed]).unwrap();
        assert_eq!(page(&db, "one", 0, 100).unwrap()[0].payload["liked"], false);
        let mut secret = row;
        secret.payload["token"] = json!("never store");
        assert!(save(&db, "one", 2, &initial.metadata, &[secret]).is_err());
        assert_eq!(load(&db, "one").unwrap().revision, 2);
    }
    #[test]
    fn reset_reimports_only_the_owned_library_and_preserves_explicit_intent_and_settings() {
        let db = Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&db).unwrap();
        let metadata = json!({"version":1,"settings":{"plex":true,"lastfm":true,"listenbrainz":false,"ratingThreshold":8},"ratingsImported":true,"bindings":{"plex":{"account":{"user":"library"},"playlistId":"12","initialized":true},"lastfm":{"account":{"user":"listener"},"initialized":true}}});
        let rows = vec![
            FavoriteRow {
                id: "imported".into(),
                payload: json!({"id":"imported","liked":true,"explicit":false,"localTrackIds":["42"]}),
            },
            FavoriteRow {
                id: "heart".into(),
                payload: json!({"id":"heart","liked":true,"explicit":true,"localTrackIds":["43"],"likedAt":1000,"matchCheckedAt":2000,"sources":{"lastfm":{"liked":true}}}),
            },
            FavoriteRow {
                id: "unlike".into(),
                payload: json!({"id":"unlike","liked":false,"explicit":true,"localTrackIds":["44"],"sources":{"lastfm":{"liked":false}}}),
            },
        ];
        save(&db, "one", 0, &metadata, &rows).unwrap();
        save(&db, "other", 0, &metadata, &rows).unwrap();
        assert!(reset(&db, "one", 0).is_err());
        assert_eq!(load(&db, "one").unwrap().total, 3);
        assert_eq!(reset(&db, "one", 1).unwrap(), 2);
        let after = load(&db, "one").unwrap();
        assert_eq!(after.total, 2);
        assert_eq!(after.metadata["settings"], metadata["settings"]);
        assert_eq!(after.metadata["ratingsImported"], false);
        assert_eq!(after.metadata["bindings"]["plex"]["playlistId"], "12");
        assert_eq!(
            after.metadata["bindings"]["lastfm"]["account"],
            metadata["bindings"]["lastfm"]["account"]
        );
        assert_eq!(after.metadata["bindings"]["lastfm"]["initialized"], false);
        let kept = page(&db, "one", 0, 100).unwrap();
        assert_eq!(kept[0].id, "heart");
        assert_eq!(kept[0].payload["localTrackIds"], json!(["43"]));
        assert_eq!(kept[0].payload["likedAt"], 1000);
        assert_eq!(kept[0].payload["sources"], json!({}));
        assert!(kept[0].payload.get("matchCheckedAt").is_none());
        assert_eq!(kept[1].payload["liked"], false);
        assert_eq!(load(&db, "other").unwrap().total, 3);
        assert_eq!(load(&db, "other").unwrap().metadata, metadata);
        assert!(save(&db, "one", 1, &metadata, &rows).is_err());
    }
    #[test]
    fn reset_keeps_uncertain_write_receipts_and_all_rows_until_reviewed() {
        let db = Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&db).unwrap();
        for field in ["pending", "creation"] {
            let metadata = json!({"version":1,"settings":{},"bindings":{"plex":{"initialized":true,field:{"state":"unknown"}}}});
            let rows = [FavoriteRow {
                id: "imported".into(),
                payload: json!({"id":"imported","liked":true,"explicit":false}),
            }];
            let revision = load(&db, "one").unwrap().revision;
            save(&db, "one", revision, &metadata, &rows).unwrap();
            assert!(reset(&db, "one", revision + 1)
                .unwrap_err()
                .contains("pending"));
            let after = load(&db, "one").unwrap();
            assert_eq!(after.revision, revision + 1);
            assert_eq!(after.metadata, metadata);
            assert_eq!(after.total, 1);
        }
    }
}
