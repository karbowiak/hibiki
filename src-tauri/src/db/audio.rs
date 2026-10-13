//! Durable download intentions and native audio bindings, independent of page eviction.
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub track_id: i64,
    pub cache_key: String,
    pub extension: String,
    pub metadata: Value,
}

fn check(scope: &str, id: i64) -> Result<(), String> {
    super::offline::check_identity(scope, &id.to_string())?;
    if id <= 0 {
        return Err("Invalid local audio track".into());
    }
    Ok(())
}

pub fn remember(conn: &Connection, scope: &str, binding: &Binding, now: i64) -> Result<(), String> {
    check(scope, binding.track_id)?;
    if binding.cache_key.len() != 67
        || !binding.cache_key.starts_with("s1-")
        || !binding.cache_key[3..]
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        || binding.extension.is_empty()
        || binding.extension.len() > 16
        || !binding.extension.bytes().all(|b| b.is_ascii_alphanumeric())
    {
        return Err("Invalid native audio binding".into());
    }
    super::offline::check_payload(&binding.metadata, 0)?;
    let json = serde_json::to_string(&binding.metadata).map_err(|_| "Cannot save local track")?;
    if json.len() > 64 * 1024 {
        return Err("Local track metadata is oversized".into());
    }
    let transaction = conn
        .unchecked_transaction()
        .map_err(|_| "Cannot save local track")?;
    transaction.execute("INSERT INTO local_audio(scope,track_id,cache_key,extension,metadata,saved_at) VALUES(?1,?2,?3,?4,?5,?6)
        ON CONFLICT(scope,track_id,cache_key) DO UPDATE SET extension=excluded.extension,metadata=excluded.metadata,saved_at=excluded.saved_at",
        params![scope,binding.track_id,binding.cache_key,binding.extension,json,now]).map_err(|_| "Cannot save local track")?;
    // Bound old media revisions while retaining the user's explicit download.
    transaction.execute("DELETE FROM local_audio WHERE scope=?1 AND track_id=?2 AND cache_key NOT IN
        (SELECT cache_key FROM local_audio WHERE scope=?1 AND track_id=?2 ORDER BY saved_at DESC,cache_key LIMIT 32)
        AND cache_key NOT IN (SELECT cache_key FROM audio_download_jobs WHERE scope=?1 AND track_id=?2 AND cache_key IS NOT NULL)",
        params![scope,binding.track_id]).map_err(|_| "Cannot save local track")?;
    transaction
        .commit()
        .map_err(|_| "Cannot save local track")?;
    Ok(())
}

pub fn bindings(conn: &Connection, scope: &str, id: i64) -> Result<Vec<Binding>, String> {
    check(scope, id)?;
    let mut query = conn.prepare("SELECT cache_key,extension,metadata FROM local_audio WHERE scope=?1 AND track_id=?2
        ORDER BY CASE WHEN cache_key=(SELECT cache_key FROM audio_download_jobs WHERE scope=?1 AND track_id=?2) THEN 0 ELSE 1 END,saved_at DESC,cache_key LIMIT 33")
        .map_err(|_| "Cannot read local track")?;
    let result = query
        .query_map(params![scope, id], |row| {
            let text: String = row.get(2)?;
            let metadata = serde_json::from_str(&text).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    2,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            Ok(Binding {
                track_id: id,
                cache_key: row.get(0)?,
                extension: row.get(1)?,
                metadata,
            })
        })
        .map_err(|_| "Cannot read local track")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Cannot read local track".to_string());
    result
}

pub fn latest(conn: &Connection, scope: &str, id: i64) -> Result<Option<Binding>, String> {
    check(scope, id)?;
    let key: Option<String> = conn.query_row("SELECT cache_key FROM local_audio WHERE scope=?1 AND track_id=?2 ORDER BY saved_at DESC,cache_key LIMIT 1",params![scope,id],|row|row.get(0)).optional().map_err(|_|"Cannot read local track")?;
    Ok(bindings(conn, scope, id)?
        .into_iter()
        .find(|binding| Some(&binding.cache_key) == key.as_ref()))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub track_id: i64,
    pub revision: String,
    pub status: String,
    pub cache_key: Option<String>,
    pub received: u64,
    pub total: Option<u64>,
    pub error: Option<String>,
}

pub fn jobs(conn: &Connection, scope: &str, offset: u32, limit: u32) -> Result<Vec<Job>, String> {
    super::offline::check_identity(scope, "downloads")?;
    let mut query=conn.prepare("SELECT track_id,revision,status,cache_key,received,total,error FROM audio_download_jobs WHERE scope=?1 ORDER BY created_at DESC,track_id LIMIT ?2 OFFSET ?3")
        .map_err(|_| "Cannot read downloads")?;
    let result = query
        .query_map(params![scope, limit.clamp(1, 200), offset], |row| {
            Ok(Job {
                track_id: row.get(0)?,
                revision: row.get(1)?,
                status: row.get(2)?,
                cache_key: row.get(3)?,
                received: row.get::<_, i64>(4)?.max(0) as u64,
                total: row.get::<_, Option<i64>>(5)?.map(|n| n.max(0) as u64),
                error: row.get(6)?,
            })
        })
        .map_err(|_| "Cannot read downloads")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Cannot read downloads".to_string());
    result
}

pub fn enqueue(conn: &Connection, scope: &str, ids: &[i64], now: i64) -> Result<(), String> {
    if ids.is_empty() || ids.len() > 256 {
        return Err("Choose between 1 and 256 tracks per download batch".into());
    }
    for id in ids {
        check(scope, *id)?;
    }
    let transaction = conn
        .unchecked_transaction()
        .map_err(|_| "Cannot queue downloads")?;
    for id in ids {
        transaction.execute("INSERT INTO audio_download_jobs(scope,track_id,revision,status,created_at) VALUES(?1,?2,?3,'queued',?4)
            ON CONFLICT(scope,track_id) DO UPDATE SET revision=excluded.revision,status='queued',received=0,total=NULL,error=NULL,created_at=excluded.created_at
            WHERE audio_download_jobs.status IN ('error','paused')",params![scope,id,uuid::Uuid::new_v4().to_string(),now]).map_err(|_| "Cannot queue downloads")?;
    }
    let count:i64=transaction.query_row("SELECT COUNT(*) FROM audio_download_jobs WHERE scope=?1 AND status IN ('queued','downloading','paused')",[scope],|row|row.get(0)).map_err(|_| "Cannot count downloads")?;
    if count > 10000 {
        return Err("The download queue is full. Let existing downloads finish first.".into());
    }
    transaction
        .commit()
        .map_err(|_| "Cannot queue downloads".to_string())
}

pub fn next(conn: &Connection, scope: &str) -> Result<Option<Job>, String> {
    let id:Option<i64>=conn.query_row("SELECT track_id FROM audio_download_jobs WHERE scope=?1 AND status='queued' ORDER BY created_at,track_id LIMIT 1",[scope],|row|row.get(0)).optional().map_err(|_| "Cannot read download queue")?;
    let Some(id) = id else { return Ok(None) };
    Ok(jobs_for_id(conn, scope, id)?)
}
pub fn jobs_for_id(conn: &Connection, scope: &str, id: i64) -> Result<Option<Job>, String> {
    check(scope, id)?;
    conn.query_row("SELECT track_id,revision,status,cache_key,received,total,error FROM audio_download_jobs WHERE scope=?1 AND track_id=?2",params![scope,id],|row|Ok(Job{track_id:row.get(0)?,revision:row.get(1)?,status:row.get(2)?,cache_key:row.get(3)?,received:row.get::<_,i64>(4)?.max(0) as u64,total:row.get::<_,Option<i64>>(5)?.map(|n|n.max(0) as u64),error:row.get(6)?})).optional().map_err(|_|"Cannot read download".to_string())
}
pub fn update(conn: &Connection, scope: &str, job: &Job) -> Result<bool, String> {
    Ok(conn.execute("UPDATE audio_download_jobs SET status=?4,cache_key=?5,received=?6,total=?7,error=?8 WHERE scope=?1 AND track_id=?2 AND revision=?3",
        params![scope,job.track_id,job.revision,job.status,job.cache_key,i64::try_from(job.received).map_err(|_|"Audio size overflow")?,job.total.map(i64::try_from).transpose().map_err(|_|"Audio size overflow")?,job.error]).map_err(|_|"Cannot update download")?==1)
}
pub fn resume(conn: &Connection, scope: &str) -> Result<(), String> {
    super::offline::check_identity(scope, "downloads")?;
    conn.execute("UPDATE audio_download_jobs SET status='queued',received=0,total=NULL WHERE scope=?1 AND status IN ('paused','downloading')",[scope]).map_err(|_|"Cannot resume downloads")?;
    Ok(())
}
pub fn remove(conn: &Connection, scope: &str, id: i64) -> Result<(), String> {
    check(scope, id)?;
    conn.execute(
        "DELETE FROM audio_download_jobs WHERE scope=?1 AND track_id=?2",
        params![scope, id],
    )
    .map_err(|_| "Cannot remove download")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Connection, String) {
        let conn = Connection::open_in_memory().unwrap();
        super::super::schema::run_migrations(&conn).unwrap();
        (conn, format!("plex-{}", "a".repeat(64)))
    }
    #[test]
    fn owned_bindings_do_not_adopt_legacy_ids_or_save_credentials() {
        let (conn, scope) = fixture();
        let mut binding = Binding {
            track_id: 42,
            cache_key: format!("s1-{}", "b".repeat(64)),
            extension: "flac".into(),
            metadata: serde_json::json!({"id":"42","title":"Saved song","streamUrl":null}),
        };
        remember(&conn, &scope, &binding, 1).unwrap();
        assert_eq!(bindings(&conn, &scope, 42).unwrap().len(), 1);
        assert!(bindings(&conn, &format!("plex-{}", "c".repeat(64)), 42)
            .unwrap()
            .is_empty());
        binding.metadata["url"] =
            serde_json::json!("https://server.test/file?X-Plex-Token=private");
        assert!(remember(&conn, &scope, &binding, 2).is_err());
    }
    #[test]
    fn intentions_survive_restart_and_cancel_fences_late_progress() {
        let (conn, scope) = fixture();
        enqueue(&conn, &scope, &[42, 42, 43], 1).unwrap();
        assert_eq!(jobs(&conn, &scope, 0, 200).unwrap().len(), 2);
        let mut old = next(&conn, &scope).unwrap().unwrap();
        old.status = "downloading".into();
        update(&conn, &scope, &old).unwrap();
        resume(&conn, &scope).unwrap();
        assert_eq!(next(&conn, &scope).unwrap().unwrap().status, "queued");
        remove(&conn, &scope, 42).unwrap();
        enqueue(&conn, &scope, &[42], 2).unwrap();
        old.status = "downloaded".into();
        assert!(!update(&conn, &scope, &old).unwrap());
        assert_eq!(
            jobs_for_id(&conn, &scope, 42).unwrap().unwrap().status,
            "queued"
        );
        assert!(enqueue(&conn, &scope, &[44, -1], 3).is_err());
        assert!(jobs_for_id(&conn, &scope, 44).unwrap().is_none());
    }
}
