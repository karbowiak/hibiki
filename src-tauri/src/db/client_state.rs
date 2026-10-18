//! Revisioned application records. The JSON value is opaque to storage; domain
//! journals keep their validation and receipts. CAS spans all renderer workers.
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

#[derive(Serialize)]
pub struct Record {
    pub revision: i64,
    pub value: Option<String>,
}
fn error(_: rusqlite::Error) -> String { "Saved application data is unavailable.".into() }
pub fn validate(namespace: &str, key: &str, value: Option<&str>) -> Result<(), String> {
    if !matches!(namespace, "keyval" | "playlist-sync" | "local")
        || key.is_empty() || key.len() > 8192
        || value.is_some_and(|value| value.len() > 128 * 1024 * 1024 || serde_json::from_str::<serde_json::Value>(value).is_err())
    { return Err("Invalid saved application record.".into()); }
    Ok(())
}
pub fn read(conn: &Connection, namespace: &str, key: &str) -> Result<Record, String> {
    conn.query_row("SELECT revision,value FROM client_state WHERE namespace=?1 AND key=?2", params![namespace,key],
        |row| Ok(Record { revision: row.get(0)?, value: row.get(1)? }))
        .optional().map_err(error).map(|row| row.unwrap_or(Record { revision: 0, value: None }))
}
pub fn write(conn: &Connection, namespace: &str, key: &str, value: Option<&str>, expected: i64) -> Result<bool, String> {
    if expected < 0 { return Err("Invalid saved application revision.".into()); }
    let now = chrono::Utc::now().timestamp_millis();
    let changed = if expected == 0 {
        conn.execute("INSERT INTO client_state(namespace,key,value,revision,updated_at) VALUES(?1,?2,?3,1,?4) ON CONFLICT DO NOTHING",params![namespace,key,value,now])
    } else {
        conn.execute("UPDATE client_state SET value=?3,revision=revision+1,updated_at=?4 WHERE namespace=?1 AND key=?2 AND revision=?5",params![namespace,key,value,now,expected])
    }.map_err(error)?;
    Ok(changed == 1)
}
pub fn local_preferences(conn: &Connection) -> Result<Vec<(String, String)>, String> {
    let mut query = conn.prepare("SELECT key,value FROM client_state WHERE namespace='local' AND value IS NOT NULL").map_err(error)?;
    let rows = query.query_map([], |row| Ok((row.get(0)?, row.get(1)?))).map_err(error)?;
    rows.collect::<Result<_,_>>().map_err(error)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_writers_cannot_replace_newer_values_or_tombstones() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        assert!(write(&conn, "playlist-sync", "journal", Some("[1]"), 0).unwrap());
        assert!(!write(&conn, "playlist-sync", "journal", Some("[2]"), 0).unwrap());
        assert!(write(&conn, "playlist-sync", "journal", None, 1).unwrap());
        assert!(!write(&conn, "playlist-sync", "journal", Some("[3]"), 0).unwrap());
        let record = read(&conn, "playlist-sync", "journal").unwrap();
        assert_eq!(record.revision, 2);
        assert!(record.value.is_none());
        assert!(!write(&conn, "playlist-sync", "journal", Some("[4]"), 1).unwrap());
    }
}
