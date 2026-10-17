use super::{sql, Connection, Value, json, params};
use serde::Deserialize;

#[derive(Clone, Deserialize)]
pub struct Order { pub filter: String, pub sort: String, pub dir: String }

pub fn check_pin(pin: &str) -> Result<(), String> {
    if pin.len() != 36 || !pin.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-') {
        return Err("Invalid collection lease".into());
    }
    Ok(())
}

/// Membership is retained by live queue leases and saved queues. Explicit local
/// intent has separate ownership and is never evicted as disposable browsing data.
pub fn clean(conn: &Connection, scope: &str, pins: Option<&[String]>, playlists: Option<&[String]>, now: i64, clear: bool) -> Result<(), String> {
    if let Some(pins) = pins {
        if pins.len() > 4096 { return Err("Too many collection leases".into()); }
        for pin in pins { check_pin(pin)?; }
    }
    if playlists.is_some_and(|ids| ids.len() > 100_000 || ids.iter().any(|id| id.is_empty() || id.len() > 24 || !id.bytes().all(|b| b.is_ascii_digit()))) {
        return Err("Invalid playlist roster".into());
    }
    super::super::atomic_upsert(conn, |conn| {
        if let Some(pins) = pins {
            sql(conn.execute("DELETE FROM collection_cache_pins WHERE scope=?1 AND pin NOT IN (SELECT value FROM json_each(?2))", params![scope,json!(pins).to_string()]))?;
        }
        // A successful roster is the only authority for deleting playlist keys.
        // Never infer deletions from failed/offline or partial reads.
        let obsolete = if clear { "1" } else {
            "((?2 IS NOT NULL AND key GLOB 'playlist:*' AND substr(key,10) NOT IN (SELECT value FROM json_each(?2))) OR (key GLOB 'mix:*' AND (cached_at<?3 OR key IN (SELECT key FROM collection_cache WHERE scope=?1 AND key GLOB 'mix:*' ORDER BY cached_at DESC,key LIMIT -1 OFFSET 32))))"
        };
        let roster = playlists.map(|ids| json!(ids).to_string());
        let delete = format!("DELETE FROM collection_cache WHERE scope=?1 AND {obsolete} AND key NOT IN (SELECT key FROM collection_cache_pins WHERE scope=?1) AND key NOT IN (SELECT json_extract(state,'$.sourceKey') FROM playback_queue WHERE scope=?1 AND json_extract(state,'$.sourceKey') IS NOT NULL)");
        if clear {
            sql(conn.execute(&delete, [scope]))?;
            // Keep monotonic generations for captured sources while retiring
            // their browse snapshots. Existing queues hydrate by identity.
            sql(conn.execute("UPDATE collection_cache SET dirty=1,revision=revision+1,staged_count=0,stamp='' WHERE scope=?1", [scope]))?;
        } else { sql(conn.execute(&delete, params![scope,roster,now.saturating_sub(7*24*60*60*1000)]))?; }
        sql(conn.execute("DELETE FROM collection_cache_members AS m WHERE scope=?1 AND NOT EXISTS(SELECT 1 FROM collection_cache c WHERE c.scope=m.scope AND c.key=m.key AND (c.active_generation=m.generation OR c.revision=m.generation)) AND NOT EXISTS(SELECT 1 FROM collection_cache_pins p WHERE p.scope=m.scope AND p.key=m.key AND p.generation=m.generation)", [scope]))?;
        sql(conn.execute("DELETE FROM collection_cache_items AS i WHERE scope=?1 AND NOT EXISTS(SELECT 1 FROM collection_cache_members m WHERE m.scope=i.scope AND m.kind=i.kind AND m.item_id=i.id)
            AND NOT (kind='track' AND id IN (SELECT json_extract(value,'$.id') FROM playback_queue q,json_each(q.entries) WHERE q.scope=?1 AND json_extract(value,'$.id') IS NOT NULL))
            AND NOT (kind='track' AND id IN (SELECT j.value FROM favorites_entries f,json_each(f.payload,'$.localTrackIds') j WHERE f.scope=?1 AND typeof(j.value)='text'))
            AND NOT (kind='track' AND id IN (SELECT CAST(track_id AS TEXT) FROM audio_download_claims WHERE scope=?1))
            AND NOT EXISTS(SELECT 1 FROM audio_download_entities d WHERE d.scope=i.scope AND d.kind=i.kind AND CAST(d.entity_id AS TEXT)=i.id)", [scope]))?;
        Ok(())
    })
}

pub fn stats(conn: &Connection, scope: &str) -> Result<Value, String> {
    let collections: i64 = sql(conn.query_row("SELECT count(*) FROM collection_cache WHERE scope=?1 AND active_generation IS NOT NULL",[scope],|r|r.get(0)))?;
    let (items, bytes): (i64,i64) = sql(conn.query_row("SELECT count(*),coalesce(sum(length(CAST(payload AS BLOB))+length(CAST(search_text AS BLOB))),0) FROM collection_cache_items WHERE scope=?1",[scope],|r|Ok((r.get(0)?,r.get(1)?))))?;
    let snapshots = super::super::offline::info(conn, scope)?;
    Ok(json!({"collections":collections,"items":items,"snapshots":snapshots.entries,"bytes":bytes+snapshots.bytes}))
}
