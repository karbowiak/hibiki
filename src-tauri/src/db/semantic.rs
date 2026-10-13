//! Real local text-embedding index, restricted to already saved scoped metadata.
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

pub const MODEL_ID: &str = "minilm-l6-v2-q8@751bff37182d3f1213fa05d7196b954e230abad9";
const DIMENSIONS: usize = 384;
const MAX_ENTITIES: usize = 2000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub kind: String,
    pub id: String,
    pub title: String,
    pub artist: String,
    pub text: String,
    pub text_hash: String,
    pub indexed: bool,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Embedding {
    pub kind: String,
    pub id: String,
    pub text_hash: String,
    pub vector: Vec<f32>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Match {
    pub kind: String,
    pub id: String,
    pub title: String,
    pub artist: String,
    pub score: f32,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub indexed: i64,
    pub model_id: &'static str,
}

fn text(value: &Value, key: &str, limit: usize) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .chars()
        .take(limit)
        .collect()
}
fn kind_for(method: &str) -> Option<&'static str> {
    match method {
        "getArtist" | "getArtistSimilar" | "getLikedArtists" | "getAllArtists" => Some("artist"),
        "getAlbum"
        | "getArtistAlbums"
        | "getArtistAlbumsInSection"
        | "getLikedAlbums"
        | "getAllAlbums"
        | "getLatestReleases" => Some("album"),
        "getTrack"
        | "getAlbumTracks"
        | "getArtistPopularTracks"
        | "getArtistPopularTracksInSection"
        | "getPlaylistItems"
        | "getLikedTracks"
        | "getAllTracks"
        | "getMixTracks" => Some("track"),
        "getPlaylists" => Some("playlist"),
        _ => None,
    }
}
fn collect(value: &Value, hint: Option<&str>, found: &mut HashMap<(String, String), Document>) {
    if found.len() >= MAX_ENTITIES {
        return;
    }
    match value {
        Value::Array(items) => {
            for item in items {
                collect(item, hint, found);
                if found.len() >= MAX_ENTITIES {
                    break;
                }
            }
        }
        Value::Object(_) => {
            let kind = value.get("type").and_then(Value::as_str).or(hint);
            if let Some(kind) =
                kind.filter(|k| matches!(*k, "artist" | "album" | "track" | "playlist"))
            {
                let id = text(value, "id", 256);
                let title = text(value, "title", 512);
                let artist = text(value, "artistName", 512);
                if !id.is_empty()
                    && !title.is_empty()
                    && !found.contains_key(&(kind.into(), id.clone()))
                {
                    let mut fields = vec![
                        format!("{kind}: {}", title.chars().take(160).collect::<String>()),
                        format!("Artist: {}", artist.chars().take(160).collect::<String>()),
                    ];
                    for key in ["genres", "moods", "styles"] {
                        if let Some(tags) = value.get(key).and_then(Value::as_array) {
                            fields.push(format!(
                                "{key}: {}",
                                tags.iter()
                                    .take(8)
                                    .filter_map(Value::as_str)
                                    .map(|s| s.chars().take(40).collect::<String>())
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            ))
                        }
                    }
                    fields.push(text(value, "summary", 4096));
                    let description = fields.join(". ");
                    // URLs and raw HTML are not meaningful embedding evidence.
                    let mut in_tag = false;
                    let plain = description
                        .chars()
                        .map(|character| {
                            if character == '<' {
                                in_tag = true;
                                return ' ';
                            }
                            if character == '>' {
                                in_tag = false;
                                return ' ';
                            }
                            if in_tag { ' ' } else { character }
                        })
                        .collect::<String>();
                    let description = plain
                        .split_whitespace()
                        .filter(|word| !word.contains("http://") && !word.contains("https://"))
                        .collect::<Vec<_>>()
                        .join(" ");
                    let text_hash = format!("{:x}", Sha256::digest(description.as_bytes()));
                    found.insert(
                        (kind.into(), id.clone()),
                        Document {
                            kind: kind.into(),
                            id,
                            title,
                            artist,
                            text: description,
                            text_hash,
                            indexed: false,
                        },
                    );
                }
            }
            if let Some(items) = value.get("items") {
                collect(items, hint, found)
            }
        }
        _ => {}
    }
}

pub fn documents(conn: &Connection, scope: &str) -> Result<Vec<Document>, String> {
    super::offline::check_identity(scope, "semantic")?;
    let mut statement=conn.prepare("SELECT cache_key,payload FROM offline_snapshots WHERE scope=?1 ORDER BY cached_at DESC,cache_key LIMIT 2000").map_err(|_|"Cannot inspect saved semantic documents")?;
    let rows = statement
        .query_map([scope], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|_| "Cannot read saved semantic documents")?;
    let mut pages = Vec::new();
    for row in rows {
        let (key, payload) = row.map_err(|_| "Cannot read saved semantic document")?;
        let Ok(key) = serde_json::from_str::<Value>(&key) else {
            continue;
        };
        let method = key.get(1).and_then(Value::as_str).unwrap_or("").to_owned();
        let detail = matches!(method.as_str(), "getArtist" | "getAlbum" | "getTrack");
        pages.push((detail, method, payload));
    }
    // Prefer visited full detail metadata over newer, sparse home-page cards.
    pages.sort_by_key(|(detail, _, _)| !*detail);
    let mut found = HashMap::new();
    for (_, method, payload) in pages {
        let payload: Value =
            serde_json::from_str(&payload).map_err(|_| "Invalid saved semantic page")?;
        super::offline::check_payload(&payload, 0)?;
        collect(&payload, kind_for(&method), &mut found);
        if found.len() >= MAX_ENTITIES {
            break;
        }
    }
    let mut indexed_statement = conn
        .prepare(
            "SELECT kind,item_id,text_hash FROM semantic_vectors WHERE scope=?1 AND model_id=?2",
        )
        .map_err(|_| "Cannot inspect local semantic revisions")?;
    let indexed_rows = indexed_statement
        .query_map(params![scope, MODEL_ID], |r| {
            Ok((
                (r.get::<_, String>(0)?, r.get::<_, String>(1)?),
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|_| "Cannot read local semantic revisions")?;
    let indexed = indexed_rows
        .collect::<Result<HashMap<_, _>, _>>()
        .map_err(|_| "Cannot read local semantic revision")?;
    for (identity, document) in &mut found {
        document.indexed = indexed.get(identity) == Some(&document.text_hash);
    }
    let mut result = found.into_values().collect::<Vec<_>>();
    result.sort_by(|a, b| (&a.kind, &a.id).cmp(&(&b.kind, &b.id)));
    Ok(result)
}
fn validate_vector(vector: &[f32]) -> Result<(), String> {
    if vector.len() != DIMENSIONS || vector.iter().any(|v| !v.is_finite()) {
        return Err("Invalid local semantic vector".into());
    }
    let norm = vector.iter().map(|v| (*v as f64).powi(2)).sum::<f64>();
    if (norm - 1.0).abs() > 0.01 {
        return Err("Local semantic vector must be normalized".into());
    }
    Ok(())
}
fn check_model(model: &str) -> Result<(), String> {
    if model == MODEL_ID {
        Ok(())
    } else {
        Err("Unsupported local semantic model".into())
    }
}
pub fn put(
    conn: &Connection,
    scope: &str,
    model: &str,
    embeddings: &[Embedding],
    now: i64,
) -> Result<(), String> {
    check_model(model)?;
    super::offline::check_identity(scope, "semantic")?;
    if embeddings.len() > 32 {
        return Err("Local semantic batch exceeds its limit".into());
    }
    let available = documents(conn, scope)?
        .into_iter()
        .map(|d| ((d.kind.clone(), d.id.clone()), d))
        .collect::<HashMap<_, _>>();
    for embedding in embeddings {
        validate_vector(&embedding.vector)?;
        let doc = available
            .get(&(embedding.kind.clone(), embedding.id.clone()))
            .ok_or("Semantic item is not in saved browsing metadata")?;
        if doc.text_hash != embedding.text_hash {
            return Err("Saved semantic metadata changed; retry indexing".into());
        }
    }
    super::atomic_upsert(conn, |conn| {
        for embedding in embeddings {
            let doc = &available[&(embedding.kind.clone(), embedding.id.clone())];
            let bytes = embedding
                .vector
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect::<Vec<_>>();
            conn.execute("INSERT INTO semantic_vectors(scope,model_id,kind,item_id,text_hash,title,artist,vector,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(scope,model_id,kind,item_id) DO UPDATE SET text_hash=excluded.text_hash,title=excluded.title,artist=excluded.artist,vector=excluded.vector,updated_at=excluded.updated_at",params![scope,model,doc.kind,doc.id,doc.text_hash,doc.title,doc.artist,bytes,now]).map_err(|_|"Cannot save local semantic vector")?;
        }
        conn.execute("DELETE FROM semantic_vectors WHERE scope=?1 AND rowid NOT IN (SELECT rowid FROM semantic_vectors WHERE scope=?1 ORDER BY updated_at DESC,rowid DESC LIMIT 2000)",[scope]).map_err(|_|"Cannot bound local semantic index")?;
        conn.execute("DELETE FROM semantic_vectors WHERE rowid NOT IN (SELECT rowid FROM semantic_vectors ORDER BY updated_at DESC,rowid DESC LIMIT 8000)",[]).map_err(|_|"Cannot bound global semantic index")?;
        Ok(())
    })
}
pub fn search(
    conn: &Connection,
    scope: &str,
    model: &str,
    query: &[f32],
    limit: usize,
) -> Result<Vec<Match>, String> {
    check_model(model)?;
    super::offline::check_identity(scope, "semantic")?;
    validate_vector(query)?;
    if limit == 0 || limit > 30 {
        return Err("Invalid local semantic result limit".into());
    }
    let current = documents(conn, scope)?
        .into_iter()
        .map(|d| ((d.kind, d.id), d.text_hash))
        .collect::<HashMap<_, _>>();
    let mut statement=conn.prepare("SELECT kind,item_id,title,artist,text_hash,vector FROM semantic_vectors WHERE scope=?1 AND model_id=?2 LIMIT 2000").map_err(|_|"Cannot search local semantic index")?;
    let rows = statement
        .query_map(params![scope, model], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Vec<u8>>(5)?,
            ))
        })
        .map_err(|_| "Cannot read local semantic index")?;
    let mut results = Vec::new();
    for row in rows {
        let (kind, id, title, artist, hash, bytes) =
            row.map_err(|_| "Cannot read local semantic vector")?;
        if current.get(&(kind.clone(), id.clone())) != Some(&hash) || bytes.len() != DIMENSIONS * 4
        {
            continue;
        }
        let vector = bytes
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
            .collect::<Vec<_>>();
        if validate_vector(&vector).is_err() {
            continue;
        }
        let query_norm = query
            .iter()
            .map(|value| (*value as f64).powi(2))
            .sum::<f64>()
            .sqrt();
        let vector_norm = vector
            .iter()
            .map(|value| (*value as f64).powi(2))
            .sum::<f64>()
            .sqrt();
        let score = (query
            .iter()
            .zip(&vector)
            .map(|(a, b)| *a as f64 * *b as f64)
            .sum::<f64>()
            / (query_norm * vector_norm))
            .clamp(-1.0, 1.0) as f32;
        results.push(Match {
            kind,
            id,
            title,
            artist,
            score,
        });
    }
    results.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| (&a.kind, &a.id).cmp(&(&b.kind, &b.id)))
    });
    results.truncate(limit);
    Ok(results)
}
pub fn info(conn: &Connection, scope: &str) -> Result<IndexInfo, String> {
    super::offline::check_identity(scope, "semantic")?;
    let indexed = conn
        .query_row(
            "SELECT COUNT(*) FROM semantic_vectors WHERE scope=?1 AND model_id=?2",
            params![scope, MODEL_ID],
            |r| r.get(0),
        )
        .map_err(|_| "Cannot inspect local semantic index")?;
    Ok(IndexInfo {
        indexed,
        model_id: MODEL_ID,
    })
}
pub fn clear(conn: &Connection, scope: &str) -> Result<(), String> {
    super::offline::check_identity(scope, "semantic")?;
    conn.execute("DELETE FROM semantic_vectors WHERE scope=?1", [scope])
        .map_err(|_| "Cannot clear local semantic index")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scope(c: char) -> String {
        format!("plex-{}", c.to_string().repeat(64))
    }
    fn vector(index: usize) -> Vec<f32> {
        let mut result = vec![0.; 384];
        result[index] = 1.;
        result
    }
    fn seed(conn: &Connection, scope: &str, id: &str, title: &str) {
        super::super::offline::put(conn,scope,&format!("[\"v1\",\"getAlbum\",[\"{id}\"]]"),&serde_json::json!({"id":id,"title":title,"artistName":"Artist","summary":"<b>Calm</b> textures https://private.test/?token=hidden","genres":["Ambient"],"_alternateIds":["other-version"]}),1).unwrap()
    }
    #[test]
    fn derived_documents_vectors_and_search_are_account_scoped() {
        let db = crate::db::DbState::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();
        let a = scope('a');
        let b = scope('b');
        seed(&conn, &a, "1", "Calm");
        seed(&conn, &a, "2", "Metal");
        seed(&conn, &b, "1", "Other account");
        let docs = documents(&conn, &a).unwrap();
        assert_eq!(docs.len(), 2);
        assert!(!docs[0].text.contains("https://"));
        assert!(!docs[0].text.contains("<b>"));
        let embeddings = docs
            .iter()
            .enumerate()
            .map(|(index, doc)| Embedding {
                kind: doc.kind.clone(),
                id: doc.id.clone(),
                text_hash: doc.text_hash.clone(),
                vector: vector(index),
            })
            .collect::<Vec<_>>();
        put(&conn, &a, MODEL_ID, &embeddings, 1).unwrap();
        let matches = search(&conn, &a, MODEL_ID, &vector(0), 20).unwrap();
        assert_eq!(matches[0].id, "1");
        assert_eq!(matches[0].score, 1.);
        assert!(
            search(&conn, &b, MODEL_ID, &vector(0), 20)
                .unwrap()
                .is_empty()
        );
        assert!(documents(&conn, &a).unwrap().iter().all(|d| d.indexed));
        clear(&conn, &b).unwrap();
        assert_eq!(info(&conn, &a).unwrap().indexed, 2);
    }
    #[test]
    fn changed_or_removed_metadata_never_uses_stale_embeddings() {
        let db = crate::db::DbState::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();
        let a = scope('a');
        seed(&conn, &a, "1", "Original");
        let doc = documents(&conn, &a).unwrap().remove(0);
        let embedding = Embedding {
            kind: doc.kind,
            id: doc.id,
            text_hash: doc.text_hash,
            vector: vector(0),
        };
        put(&conn, &a, MODEL_ID, &[embedding], 1).unwrap();
        seed(&conn, &a, "1", "Changed");
        assert!(
            search(&conn, &a, MODEL_ID, &vector(0), 20)
                .unwrap()
                .is_empty()
        );
        assert!(!documents(&conn, &a).unwrap()[0].indexed);
        super::super::offline::clear(&conn, &a).unwrap();
        assert!(
            search(&conn, &a, MODEL_ID, &vector(0), 20)
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn malformed_vectors_unknown_models_and_uncached_entities_are_rejected_atomically() {
        let db = crate::db::DbState::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();
        let a = scope('a');
        seed(&conn, &a, "1", "Known");
        let doc = documents(&conn, &a).unwrap().remove(0);
        let mut embedding = Embedding {
            kind: doc.kind,
            id: doc.id,
            text_hash: doc.text_hash,
            vector: vector(0),
        };
        assert!(
            put(
                &conn,
                &a,
                "untrusted-model",
                &[Embedding {
                    kind: embedding.kind.clone(),
                    id: embedding.id.clone(),
                    text_hash: embedding.text_hash.clone(),
                    vector: embedding.vector.clone()
                }],
                1
            )
            .is_err()
        );
        for bad in [
            vec![0.; 384],
            vec![f32::NAN; 384],
            vec![f32::INFINITY; 384],
            vec![1.; 383],
        ] {
            embedding.vector = bad;
            assert!(put(&conn, &a, MODEL_ID, std::slice::from_ref(&embedding), 1).is_err());
        }
        embedding.vector = vector(0);
        embedding.id = "unvisited".into();
        assert!(put(&conn, &a, MODEL_ID, &[embedding], 1).is_err());
        assert_eq!(info(&conn, &a).unwrap().indexed, 0);
        assert!(search(&conn, &a, MODEL_ID, &vector(0), 31).is_err());
    }
}
