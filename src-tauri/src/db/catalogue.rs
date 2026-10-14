//! Lossless Plex metadata archive. Raw documents stay in the private native DB.
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |time| time.as_millis().min(i64::MAX as u128) as i64)
}
fn check(scope: &str, kind: &str, id: i64) -> Result<(), String> {
    super::offline::check_identity(scope, kind)?;
    if id <= 0 || !matches!(kind, "artist" | "album" | "track" | "playlist") {
        return Err("Invalid catalogue identity".into());
    }
    Ok(())
}

/// Preserve unknown fields, all Media/Part/Stream versions, GUIDs and server
/// paths for later metadata joins. Authentication is never part of the archive.
pub fn clean_document(value: &Value) -> Result<Value, String> {
    fn clean(value: &Value, depth: usize) -> Result<Value, String> {
        if depth > 48 {
            return Err("Plex metadata is too deeply nested".into());
        }
        Ok(match value {
            Value::Object(object) => {
                let mut result = serde_json::Map::new();
                for (key, value) in object {
                    let normalized = key.replace(['-', '_'], "").to_ascii_lowercase();
                    if matches!(
                        normalized.as_str(),
                        "token"
                            | "xplextoken"
                            | "accesstoken"
                            | "authorization"
                            | "apikey"
                            | "password"
                            | "secret"
                    ) {
                        continue;
                    }
                    result.insert(key.clone(), clean(value, depth + 1)?);
                }
                Value::Object(result)
            }
            Value::Array(values) => Value::Array(
                values
                    .iter()
                    .map(|value| clean(value, depth + 1))
                    .collect::<Result<_, _>>()?,
            ),
            Value::String(text) => {
                let mut result=text.clone();
                let web=url::Url::parse(text).ok().filter(|url|matches!(url.scheme(),"http"|"https"));
                let relative=text.starts_with("/library/") || text.starts_with("/resources/");
                if web.is_some() || relative {
                    let (before_fragment,fragment)=text.split_once('#').map(|(a,b)|(a,format!("#{b}"))).unwrap_or((text.as_str(),String::new()));
                    if let Some((base,query))=before_fragment.split_once('?') {
                        let pairs=query.split('&').filter(|pair|{
                            let key=url::form_urlencoded::parse(pair.as_bytes()).next().map(|(k,_)|k.into_owned()).unwrap_or_default();
                            !matches!(key.replace(['-','_'],"").to_ascii_lowercase().as_str(),"token"|"xplextoken"|"accesstoken"|"apikey"|"authorization"|"password"|"secret")
                        }).collect::<Vec<_>>();
                        result=format!("{base}{}{fragment}",if pairs.is_empty(){String::new()}else{format!("?{}",pairs.join("&"))});
                    }
                    if let Some(mut parsed)=web {
                        if !parsed.username().is_empty() || parsed.password().is_some() {
                            let query=result.split_once('?').map(|(_,s)|s.split('#').next().unwrap_or_default().to_owned());
                            let _=parsed.set_username("");let _=parsed.set_password(None);parsed.set_query(query.as_deref());result=parsed.to_string();
                        }
                    }
                }
                Value::String(result)
            }
            _ => value.clone(),
        })
    }
    let result = clean(value, 0)?;
    if serde_json::to_vec(&result)
        .map_err(|_| "Invalid Plex metadata")?
        .len()
        > 16 * 1024 * 1024
    {
        return Err("Plex metadata document exceeds 16 MB".into());
    }
    Ok(result)
}

pub fn save(
    conn: &Connection,
    scope: &str,
    kind: &str,
    id: i64,
    document: &Value,
    detail: bool,
) -> Result<(), String> {
    check(scope, kind, id)?;
    let raw_id = document["ratingKey"].as_i64().or_else(|| {
        document["ratingKey"]
            .as_str()
            .and_then(|value| value.parse().ok())
    });
    if raw_id != Some(id) || document["type"].as_str() != Some(kind) {
        return Err("Plex returned a different catalogue item".into());
    }
    let document =
        serde_json::to_string(&clean_document(document)?).map_err(|_| "Invalid Plex metadata")?;
    conn.execute("INSERT INTO plex_catalogue(scope,kind,id,document,detail,saved_at) VALUES(?1,?2,?3,?4,?5,?6)
        ON CONFLICT(scope,kind,id) DO UPDATE SET document=excluded.document,detail=excluded.detail,saved_at=excluded.saved_at
        WHERE excluded.detail >= plex_catalogue.detail AND (json_extract(excluded.document,'$.updatedAt') IS NULL OR json_extract(plex_catalogue.document,'$.updatedAt') IS NULL OR CAST(json_extract(excluded.document,'$.updatedAt') AS INTEGER)>=CAST(json_extract(plex_catalogue.document,'$.updatedAt') AS INTEGER))", params![scope,kind,id,document,detail,now()]).map_err(|_| "Cannot save Plex metadata")?;
    Ok(())
}
pub fn get(conn: &Connection, scope: &str, kind: &str, id: i64) -> Result<Option<Value>, String> {
    check(scope, kind, id)?;
    let document: Option<String> = conn
        .query_row(
            "SELECT document FROM plex_catalogue WHERE scope=?1 AND kind=?2 AND id=?3",
            params![scope, kind, id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "Cannot read Plex metadata")?;
    document
        .map(|text| {
            serde_json::from_str(&text).map_err(|_| "Saved Plex metadata is invalid".into())
        })
        .transpose()
}
/// Optional deferred GET archival must not overwrite a publication that
/// arrived after the request began. Native owner fencing is the caller's job.
pub fn save_observation(conn: &Connection, scope: &str, kind: &str, id: i64,
    document: &Value, observed_at: i64) -> Result<bool, String> {
    check(scope, kind, id)?;
    if observed_at < 0 { return Err("Invalid catalogue observation time".into()); }
    super::atomic_upsert(conn, |conn| {
        let current: Option<i64> = conn.query_row("SELECT max(saved_at,listing_saved_at) FROM plex_catalogue WHERE scope=?1 AND kind=?2 AND id=?3",params![scope,kind,id],|r|r.get(0)).optional().map_err(|_|"Cannot fence catalogue observation")?;
        if current.is_some_and(|at| at >= observed_at) { return Ok(false); }
        save(conn, scope, kind, id, document, true)?;
        Ok(conn.changes() > 0)
    })
}

pub fn save_levels(
    conn: &Connection,
    scope: &str,
    cache_key: &str,
    stream_id: i64,
    version: &str,
    document: &Value,
) -> Result<(), String> {
    check(scope, "track", stream_id)?;
    validate_levels(document)?;
    let document =
        serde_json::to_string(&clean_document(document)?).map_err(|_| "Invalid Plex waveform")?;
    conn.execute("INSERT INTO plex_audio_analysis(scope,cache_key,stream_id,version,document,saved_at) VALUES(?1,?2,?3,?4,?5,?6)
        ON CONFLICT(scope,cache_key,stream_id,version) DO UPDATE SET document=excluded.document,saved_at=excluded.saved_at",params![scope,cache_key,stream_id,version,document,now()]).map_err(|_| "Cannot save Plex analysis")?;
    Ok(())
}
pub fn levels(
    conn: &Connection,
    scope: &str,
    cache_key: &str,
    stream_id: i64,
    version: &str,
) -> Result<Option<Value>, String> {
    check(scope, "track", stream_id)?;
    let text: Option<String> = conn.query_row("SELECT document FROM plex_audio_analysis WHERE scope=?1 AND cache_key=?2 AND stream_id=?3 AND version=?4",params![scope,cache_key,stream_id,version],|row|row.get(0)).optional().map_err(|_| "Cannot read Plex analysis")?;
    text.map(|text| {
        let value = serde_json::from_str(&text).map_err(|_| "Saved Plex analysis is invalid")?;
        validate_levels(&value)?;
        Ok(value)
    })
    .transpose()
}
pub fn validate_levels(document: &Value) -> Result<(), String> {
    let levels = document["Level"]
        .as_array()
        .ok_or("Plex returned no waveform samples")?;
    if levels.is_empty()
        || levels.len() > 864000
        || levels.iter().any(|level| {
            level["v"]
                .as_f64()
                .or_else(|| level["v"].as_str().and_then(|v| v.parse().ok()))
                .is_none_or(|v| !v.is_finite())
        })
    {
        return Err("Plex returned invalid waveform samples".into());
    }
    Ok(())
}

pub fn save_resource(
    conn: &Connection,
    scope: &str,
    id: i64,
    resource: &str,
    document: &Value,
) -> Result<(), String> {
    check(scope, "track", id)?;
    if resource.is_empty() || resource.len() > 512 {
        return Err("Invalid Plex metadata resource".into());
    }
    let document =
        serde_json::to_string(&clean_document(document)?).map_err(|_| "Invalid Plex metadata")?;
    conn.execute("INSERT INTO plex_metadata_resources(scope,item_id,resource,document,saved_at) VALUES(?1,?2,?3,?4,?5)
        ON CONFLICT(scope,item_id,resource) DO UPDATE SET document=excluded.document,saved_at=excluded.saved_at",params![scope,id,resource,document,now()]).map_err(|_|"Cannot save Plex metadata resource")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn delayed_track_observation_preserves_newer_details_and_listings() {
        let conn = Connection::open_in_memory().unwrap();
        super::super::schema::run_migrations(&conn).unwrap();
        let scope = format!("plex-{}", "a".repeat(64));
        let old = serde_json::json!({"type":"track","ratingKey":1,"title":"Old"});
        let new = serde_json::json!({"type":"track","ratingKey":1,"title":"New"});
        assert!(save_observation(&conn,&scope,"track",1,&new,now()).unwrap());
        conn.execute("UPDATE plex_catalogue SET saved_at=200,listing_saved_at=0 WHERE scope=?1",[&scope]).unwrap();
        assert!(!save_observation(&conn,&scope,"track",1,&old,100).unwrap());
        assert!(!save_observation(&conn,&scope,"track",1,&old,200).unwrap());
        conn.execute("UPDATE plex_catalogue SET saved_at=0,listing=?2,listing_saved_at=200 WHERE scope=?1",params![scope,new.to_string()]).unwrap();
        assert!(!save_observation(&conn,&scope,"track",1,&old,100).unwrap());
        assert_eq!(serde_json::from_str::<Value>(&conn.query_row("SELECT document FROM plex_catalogue WHERE scope=?1",[&scope],|r|r.get::<_,String>(0)).unwrap()).unwrap()["title"],"New");
        assert!(save_observation(&conn,&scope,"track",1,&old,300).unwrap());
    }
    #[test]
    fn older_server_revision_observation_does_not_claim_a_publication() {
        let conn=Connection::open_in_memory().unwrap();
        super::super::schema::run_migrations(&conn).unwrap();
        let scope=format!("plex-{}","a".repeat(64));
        let new=serde_json::json!({"type":"track","ratingKey":1,"updatedAt":20});
        let old=serde_json::json!({"type":"track","ratingKey":1,"updatedAt":10});
        save(&conn,&scope,"track",1,&new,true).unwrap();
        conn.execute("UPDATE plex_catalogue SET saved_at=1,listing_saved_at=0",[]).unwrap();
        assert!(!save_observation(&conn,&scope,"track",1,&old,100).unwrap());
        assert_eq!(get(&conn,&scope,"track",1).unwrap(),Some(new));
    }
    #[test]
    fn full_documents_preserve_unknown_metadata_and_all_media_without_credentials() {
        let conn = Connection::open_in_memory().unwrap();
        super::super::schema::run_migrations(&conn).unwrap();
        let scope = format!("plex-{}", "a".repeat(64));
        let document = serde_json::json!({"ratingKey":"42","type":"track","futureSonicData":{"features":[1,2,3]},"Guid":[{"id":"mbid://x"}],"Media":[{"Part":[{"file":"/storage/Artist/song.flac","Stream":[{"startRamp":"1,2","futureField":3}]}]},{"id":2}],"url":"https://user:password@server.test/data?X-Plex-Token=private&keep=1","token":"private","relative":"/library/metadata/42?sig=a%2fb+Z&X-Plex-Token=private&keep=%20"});
        save(&conn, &scope, "track", 42, &document, true).unwrap();
        let saved = get(&conn, &scope, "track", 42).unwrap().unwrap();
        assert_eq!(saved["Media"], document["Media"]);
        assert_eq!(saved["futureSonicData"], document["futureSonicData"]);
        assert_eq!(saved["Guid"], document["Guid"]);
        assert!(!saved.to_string().contains("private"));
        assert_eq!(saved["url"], "https://server.test/data?keep=1");
        assert_eq!(saved["relative"],"/library/metadata/42?sig=a%2fb+Z&keep=%20");
        save(
            &conn,
            &scope,
            "track",
            42,
            &serde_json::json!({"ratingKey":42,"type":"track","title":"Sparse listing"}),
            false,
        )
        .unwrap();
        assert_eq!(get(&conn, &scope, "track", 42).unwrap().unwrap(), saved);
        assert!(get(&conn, &format!("plex-{}", "b".repeat(64)), "track", 42)
            .unwrap()
            .is_none());
    }
    #[test]
    fn analysis_never_crosses_scope_media_stream_or_analysis_revision() {
        let conn = Connection::open_in_memory().unwrap();
        super::super::schema::run_migrations(&conn).unwrap();
        let scope = format!("plex-{}", "a".repeat(64));
        let raw =
            serde_json::json!({"totalSamples":"2","Level":[{"v":-42.2},{"v":-12.0,"future":true}]});
        save_levels(&conn, &scope, "media-a", 12, "v1", &raw).unwrap();
        assert_eq!(
            levels(&conn, &scope, "media-a", 12, "v1").unwrap(),
            Some(raw)
        );
        for (s, k, id, v) in [
            (format!("plex-{}", "b".repeat(64)), "media-a", 12, "v1"),
            (scope.clone(), "media-b", 12, "v1"),
            (scope.clone(), "media-a", 13, "v1"),
            (scope.clone(), "media-a", 12, "v2"),
        ] {
            assert!(levels(&conn, &s, k, id, v).unwrap().is_none());
        }
        assert!(save_levels(
            &conn,
            &scope,
            "media-a",
            12,
            "v1",
            &serde_json::json!({"Level":[{}]})
        )
        .is_err());
    }
}
