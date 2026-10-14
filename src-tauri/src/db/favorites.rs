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
            json!({"version":1,"settings":{"plex":false,"listenbrainz":false,"lastfm":false,"ratingThreshold":6},"bindings":{}}),
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
}
