use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    artist_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    album_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thumb_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    album_thumb_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    artist_thumb_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    playlist_item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_index: Option<usize>,
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Request {
    Load,
    Save { entries: Vec<Entry>, state: Value },
    Position { state: Value },
    Clear,
}
impl Request {
    pub fn read_only(&self) -> bool {
        matches!(self, Self::Load)
    }
}
fn db<T>(value: rusqlite::Result<T>) -> Result<T, String> {
    value.map_err(|_| "Saved queue is unavailable".into())
}
fn check_state(state: &Value, total: usize) -> Result<(), String> {
    super::offline::check_payload(state, 0)?;
    let index = state["index"]
        .as_u64()
        .ok_or("Invalid saved queue position")?;
    let position = state["positionMs"]
        .as_f64()
        .ok_or("Invalid saved playback position")?;
    if index >= total as u64 || !(0.0..=604800000.0).contains(&position) {
        return Err("Invalid saved queue position".into());
    }
    if serde_json::to_vec(state)
        .map_err(|_| "Invalid saved queue context")?
        .len()
        > 16384
    {
        return Err("Saved queue context is too large".into());
    }
    Ok(())
}
pub fn run(conn: &Connection, scope: &str, request: &Request) -> Result<Value, String> {
    super::offline::check_identity(scope, "playback-queue")?;
    match request {
        Request::Load => {
            let row: Option<(String, String)> = db(conn
                .query_row(
                    "SELECT entries,state FROM playback_queue WHERE scope=?1",
                    [scope],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional())?;
            let Some((entries, state)) = row else {
                return Ok(Value::Null);
            };
            let entries: Vec<Entry> =
                serde_json::from_str(&entries).map_err(|_| "Saved queue is invalid")?;
            let state: Value =
                serde_json::from_str(&state).map_err(|_| "Saved queue context is invalid")?;
            check_state(&state, entries.len())?;
            Ok(json!({ "entries": entries, "state": state }))
        }
        Request::Save { entries, state } => {
            if entries.is_empty() || entries.len() > 1_000_000 {
                return Err("Invalid saved queue size".into());
            }
            check_state(&state, entries.len())?;
            for entry in entries {
                if !entry.id.is_empty() && entry.id.parse::<u64>().ok().is_none_or(|id| id == 0)
                    && !crate::ytmusic::valid_track_id(&entry.id) {
                    return Err("Invalid saved music identity".into());
                }
                if entry.id.is_empty() && entry.source_index.is_none()
                    || entry.source_index.is_some_and(|i| i >= 1_000_000)
                {
                    return Err("Invalid saved queue reference".into());
                }
                if [
                    &entry.title,
                    &entry.artist_name,
                    &entry.album_name,
                    &entry.playlist_item_id,
                ]
                .iter()
                .any(|v| v.as_ref().is_some_and(|v| v.len() > 4096))
                    || entry
                        .duration
                        .is_some_and(|d| !d.is_finite() || !(0.0..=604800000.0).contains(&d))
                {
                    return Err("Invalid saved queue metadata".into());
                }
                for artwork in [
                    &entry.thumb_url,
                    &entry.album_thumb_url,
                    &entry.artist_thumb_url,
                ]
                .into_iter()
                .flatten()
                {
                    if artwork.len() > 4096
                        || url::Url::parse(artwork).ok().is_none_or(|url| {
                            !matches!(url.scheme(), "image" | "http" | "https")
                                || url.host_str().is_none()
                        })
                    {
                        return Err("Invalid saved queue artwork".into());
                    }
                    super::offline::check_payload(&Value::String(artwork.clone()), 0)?;
                }
            }
            let total = entries.len() as i64;
            let entries =
                serde_json::to_string(&entries).map_err(|_| "Cannot encode saved queue")?;
            if entries.len() > 64 * 1024 * 1024 {
                return Err("Saved queue exceeds its limit".into());
            }
            let state = serde_json::to_string(&state).map_err(|_| "Cannot encode queue context")?;
            db(conn.execute("INSERT INTO playback_queue(scope,total,entries,state) VALUES(?1,?2,?3,?4) ON CONFLICT(scope) DO UPDATE SET total=excluded.total,entries=excluded.entries,state=excluded.state", params![scope,total,entries,state]))?;
            Ok(Value::Null)
        }
        Request::Position { state } => {
            let total: Option<i64> = db(conn
                .query_row(
                    "SELECT total FROM playback_queue WHERE scope=?1",
                    [scope],
                    |r| r.get(0),
                )
                .optional())?;
            if let Some(total) = total {
                check_state(&state, total as usize)?;
                db(conn.execute(
                    "UPDATE playback_queue SET state=?2 WHERE scope=?1",
                    params![
                        scope,
                        serde_json::to_string(&state)
                            .map_err(|_| "Cannot encode playback position")?
                    ],
                ))?;
            }
            Ok(Value::Null)
        }
        Request::Clear => {
            db(conn.execute("DELETE FROM playback_queue WHERE scope=?1", [scope]))?;
            Ok(Value::Null)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn artwork_is_durable_but_cannot_persist_credentials_or_media_payloads() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("queue.db");
        let conn = Connection::open(&path).unwrap();
        super::super::schema::run_migrations(&conn).unwrap();
        let scope = format!("plex-{}", "a".repeat(64));
        let artwork = "image://localhost/ext/img?src=https%3A%2F%2Flh3.googleusercontent.com%2Falbum-cover%3Dw600-h600";
        let entry = |artwork: &str| serde_json::from_value::<Entry>(json!({
            "id": "ytmusic:abcdefghijk", "thumbUrl": artwork, "albumThumbUrl": artwork,
            "artistThumbUrl": "https://images.test/artist.jpg"
        })).unwrap();
        let save = |conn: &Connection, artwork: &str| run(conn, &scope, &Request::Save {
            entries: vec![entry(artwork)], state: json!({"index":0,"positionMs":12345})
        });
        save(&conn, artwork).unwrap();
        drop(conn);
        let conn = Connection::open(&path).unwrap();
        assert_eq!(run(&conn, &scope, &Request::Load).unwrap()["entries"][0]["albumThumbUrl"], artwork);
        for invalid in [
            "https://user:password@images.test/cover.jpg",
            "https://images.test/cover.jpg?X-Plex-Token=secret",
            "image://localhost/ext/img?src=https%3A%2F%2Fimages.test%2Fcover.jpg%3Faccess_token%3Dsecret",
            "data:image/png;base64,AAAA", "file:///private/cover.jpg", &"x".repeat(4097),
        ] {
            assert!(save(&conn, invalid).is_err());
        }
        let restored = run(&conn, &scope, &Request::Load).unwrap();
        assert_eq!(restored["entries"][0]["thumbUrl"], artwork);
        assert_eq!(restored["entries"][0]["artistThumbUrl"], "https://images.test/artist.jpg");
        // Pre-artwork queues remain readable without a migration.
        assert!(serde_json::from_value::<Entry>(json!({"id":"7"})).unwrap().thumb_url.is_none());
    }
    #[test]
    fn mixed_queues_keep_opaque_video_ids_but_reject_playback_urls() {
        let conn = Connection::open_in_memory().unwrap();
        super::super::schema::run_migrations(&conn).unwrap();
        let scope = format!("plex-{}", "a".repeat(64));
        let entry = |id: &str| serde_json::from_value::<Entry>(json!({"id": id, "title": "Song"})).unwrap();
        run(&conn, &scope, &Request::Save { entries: vec![entry("7"), entry("ytmusic:abcdefghijk")], state: json!({"index":1,"positionMs":12345}) }).unwrap();
        let saved = run(&conn, &scope, &Request::Load).unwrap();
        assert_eq!(saved["entries"][1]["id"], "ytmusic:abcdefghijk");
        for id in ["ytmusic:abcdefghijk?cookie=secret", "https://rr1.googlevideo.com?signature=secret", "ytmusic:invalid"] {
            assert!(run(&conn, &scope, &Request::Save { entries: vec![entry(id)], state: json!({"index":0,"positionMs":0}) }).is_err());
        }
    }
    #[test]
    fn full_order_duplicate_occurrences_and_position_are_durable_and_scoped() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("queue.db");
        let conn = Connection::open(&path).unwrap();
        super::super::schema::run_migrations(&conn).unwrap();
        let scope = format!("plex-{}", "a".repeat(64));
        let other = format!("plex-{}", "b".repeat(64));
        let entries = (0..1831)
            .map(|i| Entry {
                id: ((i / 2) + 1).to_string(),
                title: None,
                artist_name: None,
                album_name: None,
                thumb_url: None,
                album_thumb_url: None,
                artist_thumb_url: None,
                duration: None,
                playlist_item_id: Some(i.to_string()),
                source_index: Some(i),
            })
            .collect();
        run(
            &conn,
            &scope,
            &Request::Save {
                entries,
                state: json!({"index":900,"positionMs":12345}),
            },
        )
        .unwrap();
        run(
            &conn,
            &scope,
            &Request::Position {
                state: json!({"index":1800,"positionMs":23456}),
            },
        )
        .unwrap();
        drop(conn);
        let conn = Connection::open(&path).unwrap();
        let restored = run(&conn, &scope, &Request::Load).unwrap();
        assert_eq!(restored["entries"].as_array().unwrap().len(), 1831);
        assert_eq!(restored["entries"][1830]["playlistItemId"], "1830");
        assert_eq!(restored["state"]["positionMs"], 23456);
        assert!(run(&conn, &other, &Request::Load).unwrap().is_null());
        assert!(run(
            &conn,
            &scope,
            &Request::Position {
                state: json!({"index":1831,"positionMs":0})
            }
        )
        .is_err());
        assert_eq!(
            run(&conn, &scope, &Request::Load).unwrap()["state"]["index"],
            1800
        );
        run(&conn, &other, &Request::Clear).unwrap();
        assert!(!run(&conn, &scope, &Request::Load).unwrap().is_null());
    }
}
