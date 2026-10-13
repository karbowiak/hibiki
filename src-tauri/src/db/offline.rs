//! Bounded, account/library-scoped browsing snapshots. Never imports legacy IDs.
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::Value;

pub const MAX_PAYLOAD_BYTES: usize = 1024 * 1024;
const MAX_SCOPE_ENTRIES: i64 = 2000;
const MAX_SCOPE_BYTES: i64 = 32 * 1024 * 1024;
const MAX_GLOBAL_BYTES: i64 = 128 * 1024 * 1024;
const MAX_GLOBAL_ENTRIES: i64 = 8000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub payload: Value,
    pub cached_at: i64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheInfo {
    pub entries: i64,
    pub bytes: i64,
    pub oldest_at: Option<i64>,
}

pub(super) fn check_identity(scope: &str, key: &str) -> Result<(), String> {
    if scope.len() != 69
        || !scope.starts_with("plex-")
        || !scope[5..]
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        return Err("Invalid saved library scope".into());
    }
    if key.is_empty() || key.len() > 512 || key.chars().any(char::is_control) {
        return Err("Invalid saved browsing key".into());
    }
    Ok(())
}
pub(super) fn check_payload(value: &Value, depth: usize) -> Result<(), String> {
    if depth > 24 {
        return Err("Saved browsing data is too deeply nested".into());
    }
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                let normalized = key.replace(['_', '-'], "").to_ascii_lowercase();
                if matches!(
                    normalized.as_str(),
                    "token"
                        | "accesstoken"
                        | "authorization"
                        | "password"
                        | "secret"
                        | "apikey"
                        | "providerdata"
                ) || (normalized == "streamurl" && !child.is_null())
                {
                    return Err("Credentials and playback data cannot be saved for browsing".into());
                }
                check_payload(child, depth + 1)?;
            }
        }
        Value::Array(array) => {
            for child in array {
                check_payload(child, depth + 1)?;
            }
        }
        Value::String(text) => {
            if text.len() > 64 * 1024 {
                return Err("Saved browsing field exceeds its limit".into());
            }
            // Inspect nested custom-protocol src URLs too; do not persist URL credentials.
            if let Ok(url) = url::Url::parse(text) {
                if !url.username().is_empty() || url.password().is_some() {
                    return Err("Saved browsing URL contains credentials".into());
                }
                for (key, value) in url.query_pairs() {
                    if matches!(
                        key.to_ascii_lowercase().as_str(),
                        "x-plex-token" | "token" | "api_key" | "apikey" | "access_token"
                    ) {
                        return Err("Saved browsing URL contains credentials".into());
                    }
                    if key == "src" {
                        check_payload(&Value::String(value.into_owned()), depth + 1)?;
                    }
                }
            }
        }
        _ => {}
    }
    Ok(())
}

pub fn get(
    conn: &Connection,
    scope: &str,
    key: &str,
    now: i64,
) -> Result<Option<Snapshot>, String> {
    check_identity(scope, key)?;
    let row: Option<(String, i64)> = conn
        .query_row(
            "SELECT payload,cached_at FROM offline_snapshots WHERE scope=?1 AND cache_key=?2",
            params![scope, key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|_| "Cannot read saved browsing data")?;
    let Some((payload, cached_at)) = row else {
        return Ok(None);
    };
    let payload: Value =
        serde_json::from_str(&payload).map_err(|_| "Saved browsing data is invalid")?;
    check_payload(&payload, 0)?;
    conn.execute(
        "UPDATE offline_snapshots SET accessed_at=?3 WHERE scope=?1 AND cache_key=?2",
        params![scope, key, now],
    )
    .map_err(|_| "Cannot update saved browsing access")?;
    Ok(Some(Snapshot { payload, cached_at }))
}

pub fn put(
    conn: &Connection,
    scope: &str,
    key: &str,
    payload: &Value,
    now: i64,
) -> Result<(), String> {
    check_identity(scope, key)?;
    check_payload(payload, 0)?;
    let serialized =
        serde_json::to_string(payload).map_err(|_| "Cannot encode saved browsing data")?;
    if serialized.len() > MAX_PAYLOAD_BYTES {
        return Err("Saved browsing page exceeds its limit".into());
    }
    super::atomic_upsert(conn, |conn| {
        conn.execute("INSERT INTO offline_snapshots(scope,cache_key,payload,byte_count,cached_at,accessed_at) VALUES(?1,?2,?3,?4,?5,?5) ON CONFLICT(scope,cache_key) DO UPDATE SET payload=excluded.payload,byte_count=excluded.byte_count,cached_at=excluded.cached_at,accessed_at=excluded.accessed_at", params![scope,key,serialized,serialized.len() as i64,now]).map_err(|_| "Cannot save browsing page")?;
        loop {
            let info = info(conn, scope)?;
            if info.entries <= MAX_SCOPE_ENTRIES && info.bytes <= MAX_SCOPE_BYTES {
                break;
            }
            conn.execute("DELETE FROM offline_snapshots WHERE (scope,cache_key) IN (SELECT scope,cache_key FROM offline_snapshots WHERE scope=?1 ORDER BY accessed_at,cache_key LIMIT 1)", [scope]).map_err(|_| "Cannot bound saved library pages")?;
        }
        loop {
            let (bytes, entries): (i64, i64) = conn
                .query_row(
                    "SELECT COALESCE(SUM(byte_count),0),COUNT(*) FROM offline_snapshots",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(|_| "Cannot inspect saved browsing size")?;
            if bytes <= MAX_GLOBAL_BYTES && entries <= MAX_GLOBAL_ENTRIES {
                break;
            }
            conn.execute("DELETE FROM offline_snapshots WHERE (scope,cache_key) IN (SELECT scope,cache_key FROM offline_snapshots ORDER BY accessed_at,scope,cache_key LIMIT 1)", []).map_err(|_| "Cannot bound saved browsing size")?;
        }
        Ok(())
    })
}

pub fn info(conn: &Connection, scope: &str) -> Result<CacheInfo, String> {
    check_identity(scope, "info")?;
    conn.query_row("SELECT COUNT(*),COALESCE(SUM(byte_count),0),MIN(cached_at) FROM offline_snapshots WHERE scope=?1", [scope], |r| Ok(CacheInfo {entries:r.get(0)?,bytes:r.get(1)?,oldest_at:r.get(2)?})).map_err(|_| "Cannot inspect saved library pages".into())
}
pub fn clear(conn: &Connection, scope: &str) -> Result<(), String> {
    check_identity(scope, "clear")?;
    conn.execute("DELETE FROM offline_snapshots WHERE scope=?1", [scope])
        .map_err(|_| "Cannot clear saved library pages")?;
    Ok(())
}

/// Literal prefixes, never LIKE patterns. A playlist ID cannot match another ID.
pub fn invalidate(conn: &Connection, scope: &str, prefixes: &[String]) -> Result<(), String> {
    check_identity(scope, "invalidate")?;
    if prefixes.len() > 32
        || prefixes.iter().any(|prefix| {
            prefix.is_empty() || prefix.len() > 512 || prefix.chars().any(char::is_control)
        })
    {
        return Err("Invalid saved browsing invalidation".into());
    }
    super::atomic_upsert(conn, |conn| {
        for prefix in prefixes {
            conn.execute("DELETE FROM offline_snapshots WHERE scope=?1 AND substr(cache_key,1,length(?2))=?2", params![scope,prefix])
                .map_err(|_| "Cannot invalidate saved browsing pages")?;
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scope(c: char) -> String {
        format!("plex-{}", c.to_string().repeat(64))
    }
    #[test]
    fn scoped_pages_preserve_occurrences_and_versions() {
        let db = crate::db::DbState::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();
        let a = scope('a');
        let b = scope('b');
        let page = serde_json::json!({"items":[{"id":"1","playlistItemId":"10"},{"id":"1","playlistItemId":"11"}],"total":5,"offset":0,"_alternateIds":["2","3"]});
        put(&conn, &a, "playlist:1:0:2", &page, 10).unwrap();
        assert!(get(&conn, &b, "playlist:1:0:2", 20).unwrap().is_none());
        assert!(get(&conn, &a, "playlist:1:2:2", 20).unwrap().is_none());
        assert_eq!(
            get(&conn, &a, "playlist:1:0:2", 20)
                .unwrap()
                .unwrap()
                .payload,
            page
        );
        put(&conn, &b, "playlist:1:0:2", &serde_json::json!([]), 30).unwrap();
        clear(&conn, &a).unwrap();
        assert_eq!(info(&conn, &a).unwrap().entries, 0);
        assert_eq!(info(&conn, &b).unwrap().entries, 1);
    }
    #[test]
    fn credentials_and_oversized_pages_never_replace_success() {
        let db = crate::db::DbState::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();
        let a = scope('a');
        put(
            &conn,
            &a,
            "album:1",
            &serde_json::json!({"title":"safe"}),
            1,
        )
        .unwrap();
        for value in [
            serde_json::json!({"token":"secret"}),
            serde_json::json!({"thumbUrl":"image://localhost/ext/img?src=https%3A%2F%2Fexample.test%2Fimage%3FX-Plex-Token%3Dsecret"}),
            serde_json::json!({"_providerData":{"id":1}}),
            serde_json::json!({"streamUrl":"https://example.test/stream"}),
        ] {
            assert!(put(&conn, &a, "album:1", &value, 2).is_err());
        }
        let oversized = serde_json::json!(vec!["x".repeat(16384); 65]);
        assert!(put(&conn, &a, "album:1", &oversized, 3).is_err());
        assert_eq!(get(&conn, &a, "album:1", 4).unwrap().unwrap().cached_at, 1);
    }
    #[test]
    fn eviction_respects_access_and_account_isolation() {
        let db = crate::db::DbState::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();
        let a = scope('a');
        let b = scope('b');
        put(&conn, &b, "other", &serde_json::json!([]), 0).unwrap();
        for n in 0..MAX_SCOPE_ENTRIES {
            put(&conn, &a, &format!("page:{n}"), &serde_json::json!([n]), n).unwrap();
        }
        get(&conn, &a, "page:0", 5000).unwrap();
        put(&conn, &a, "new", &serde_json::json!([]), 5001).unwrap();
        assert!(get(&conn, &a, "page:1", 5002).unwrap().is_none());
        assert!(get(&conn, &a, "page:0", 5002).unwrap().is_some());
        assert!(get(&conn, &b, "other", 5002).unwrap().is_some());
        assert_eq!(info(&conn, &a).unwrap().entries, MAX_SCOPE_ENTRIES);
    }
    #[test]
    fn invalidation_is_literal_scoped_and_transactional() {
        let db = crate::db::DbState::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();
        let a = scope('a');
        let b = scope('b');
        for (scope, key) in [
            (&a, "playlist:1:"),
            (&a, "playlist:10:"),
            (&a, "album:1"),
            (&a, "literal_%:"),
            (&b, "playlist:1:"),
        ] {
            put(&conn, scope, key, &serde_json::json!([]), 1).unwrap();
        }
        invalidate(&conn, &a, &["playlist:1:".into(), "literal_%:".into()]).unwrap();
        assert_eq!(info(&conn, &a).unwrap().entries, 2);
        assert!(get(&conn, &a, "playlist:10:", 2).unwrap().is_some());
        assert!(get(&conn, &b, "playlist:1:", 2).unwrap().is_some());
        assert!(invalidate(&conn, &a, &["".into()]).is_err());
        assert!(invalidate(&conn, &a, &vec!["prefix".into(); 33]).is_err());
        conn.execute_batch("CREATE TRIGGER forbid_album BEFORE DELETE ON offline_snapshots WHEN OLD.cache_key='album:1' BEGIN SELECT RAISE(ABORT,'test'); END;").unwrap();
        assert!(invalidate(&conn, &a, &["playlist:10:".into(), "album:".into()]).is_err());
        assert!(get(&conn, &a, "playlist:10:", 2).unwrap().is_some());
    }

    #[test]
    fn failed_eviction_rolls_back_new_page() {
        let db = crate::db::DbState::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();
        let a = scope('a');
        for n in 0..MAX_SCOPE_ENTRIES {
            put(&conn, &a, &format!("page:{n}"), &serde_json::json!([n]), n).unwrap();
        }
        conn.execute_batch("CREATE TRIGGER forbid_eviction BEFORE DELETE ON offline_snapshots BEGIN SELECT RAISE(ABORT,'test'); END;").unwrap();
        assert!(put(&conn, &a, "new", &serde_json::json!([]), 5001).is_err());
        assert!(get(&conn, &a, "new", 5002).unwrap().is_none());
        assert_eq!(info(&conn, &a).unwrap().entries, MAX_SCOPE_ENTRIES);
    }
}
