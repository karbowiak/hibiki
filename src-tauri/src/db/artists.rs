//! Artist CRUD operations.

use rusqlite::Connection;
use serde::Serialize;

use crate::plex::models::{Artist, PlexTag};

use super::datetime_to_iso;

/// Artist row returned from the database — includes tags and locations.
#[derive(Debug, Clone, Serialize, Default)]
pub struct ArtistRow {
    pub id: i64,
    pub api_key: String,
    pub title: String,
    pub title_sort: Option<String>,
    pub library_section_id: i64,
    pub album_sort: i64,
    pub rating: Option<f64>,
    pub thumb: Option<String>,
    pub summary: Option<String>,
    pub user_rating: Option<f64>,
    pub added_at: Option<String>,
    pub last_viewed_at: Option<String>,
    pub last_rated_at: Option<String>,
    pub updated_at: Option<String>,
    pub guid: Option<String>,
    pub theme: Option<String>,
    pub art: Option<String>,
    pub tags: Vec<TagRow>,
    pub locations: Vec<String>,
}

/// A tag from the shared `tags` table.
#[derive(Debug, Clone, Serialize, Default)]
pub struct TagRow {
    pub tag_type: String,
    pub tag: String,
    pub tag_id: Option<i64>,
    pub filter: Option<String>,
}

/// Upsert a single artist (from a Plex `Artist` struct) into the database.
pub fn upsert(conn: &Connection, artist: &Artist) -> Result<(), String> {
    super::atomic_upsert(conn, |conn| upsert_inner(conn, artist))
}

fn upsert_inner(conn: &Connection, artist: &Artist) -> Result<(), String> {
    conn.execute(
        "INSERT INTO artists (id, api_key, title, title_sort, library_section_id, album_sort,
            rating, thumb, summary, user_rating, added_at, last_viewed_at, last_rated_at,
            updated_at, guid, theme, art)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
         ON CONFLICT(id) DO UPDATE SET
            api_key = ?2, title = ?3, title_sort = ?4, library_section_id = ?5,
            album_sort = ?6, rating = ?7, thumb = ?8, summary = ?9, user_rating = ?10,
            added_at = ?11, last_viewed_at = ?12, last_rated_at = ?13, updated_at = ?14,
            guid = ?15, theme = ?16, art = ?17",
        rusqlite::params![
            artist.rating_key,
            artist.key,
            artist.title,
            artist.title_sort,
            artist.library_section_id,
            artist.album_sort,
            artist.rating,
            artist.thumb,
            artist.summary,
            artist.user_rating,
            datetime_to_iso(&artist.added_at),
            datetime_to_iso(&artist.last_viewed_at),
            datetime_to_iso(&artist.last_rated_at),
            datetime_to_iso(&artist.updated_at),
            artist.guid,
            artist.theme,
            artist.art,
        ],
    )
    .map_err(|e| format!("upsert artist error: {e}"))?;

    // Locations — replace all
    conn.execute(
        "DELETE FROM artist_locations WHERE artist_id = ?1",
        [artist.rating_key],
    )
    .map_err(|e| format!("delete locations error: {e}"))?;

    for loc in &artist.locations {
        conn.execute(
            "INSERT INTO artist_locations (artist_id, path) VALUES (?1, ?2)",
            rusqlite::params![artist.rating_key, loc],
        )
        .map_err(|e| format!("insert location error: {e}"))?;
    }

    // Tags — no tag fields on Artist struct currently, but we keep the pattern
    // for future extension. If artist genre/mood/style tags are added to the
    // Plex model, they'll be inserted here.
    conn.execute(
        "DELETE FROM tags WHERE entity_type = 'artist' AND entity_id = ?1",
        [artist.rating_key],
    )
    .map_err(|e| format!("delete tags error: {e}"))?;

    Ok(())
}

/// Upsert many artists in a single transaction.
pub fn upsert_bulk(conn: &Connection, artists: &[Artist]) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("begin tx error: {e}"))?;
    for artist in artists {
        upsert(&tx, artist)?;
    }
    tx.commit().map_err(|e| format!("commit error: {e}"))?;
    Ok(())
}

/// Get a single artist by ID, including tags and locations.
pub fn get(conn: &Connection, id: i64) -> Result<Option<ArtistRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, api_key, title, title_sort, library_section_id, album_sort,
                    rating, thumb, summary, user_rating, added_at, last_viewed_at,
                    last_rated_at, updated_at, guid, theme, art
             FROM artists WHERE id = ?1",
        )
        .map_err(|e| format!("prepare error: {e}"))?;

    let row = stmt
        .query_row([id], |row| {
            Ok(ArtistRow {
                id: row.get(0)?,
                api_key: row.get(1)?,
                title: row.get(2)?,
                title_sort: row.get(3)?,
                library_section_id: row.get(4)?,
                album_sort: row.get(5)?,
                rating: row.get(6)?,
                thumb: row.get(7)?,
                summary: row.get(8)?,
                user_rating: row.get(9)?,
                added_at: row.get(10)?,
                last_viewed_at: row.get(11)?,
                last_rated_at: row.get(12)?,
                updated_at: row.get(13)?,
                guid: row.get(14)?,
                theme: row.get(15)?,
                art: row.get(16)?,
                tags: Vec::new(),
                locations: Vec::new(),
            })
        })
        .optional()
        .map_err(|e| format!("query error: {e}"))?;

    match row {
        None => Ok(None),
        Some(mut a) => {
            a.locations = get_locations(conn, a.id)?;
            a.tags = get_tags(conn, "artist", a.id)?;
            Ok(Some(a))
        }
    }
}

/// Search artists by title (case-insensitive LIKE).
pub fn search(conn: &Connection, query: &str, limit: i64) -> Result<Vec<ArtistRow>, String> {
    let pattern = format!("%{query}%");
    let mut stmt = conn
        .prepare(
            "SELECT id, api_key, title, title_sort, library_section_id, album_sort,
                    rating, thumb, summary, user_rating, added_at, last_viewed_at,
                    last_rated_at, updated_at, guid, theme, art
             FROM artists
             WHERE title LIKE ?1 COLLATE NOCASE
             ORDER BY title COLLATE NOCASE
             LIMIT ?2",
        )
        .map_err(|e| format!("prepare error: {e}"))?;

    let rows: Vec<ArtistRow> = stmt
        .query_map(rusqlite::params![pattern, limit], |row| {
            Ok(ArtistRow {
                id: row.get(0)?,
                api_key: row.get(1)?,
                title: row.get(2)?,
                title_sort: row.get(3)?,
                library_section_id: row.get(4)?,
                album_sort: row.get(5)?,
                rating: row.get(6)?,
                thumb: row.get(7)?,
                summary: row.get(8)?,
                user_rating: row.get(9)?,
                added_at: row.get(10)?,
                last_viewed_at: row.get(11)?,
                last_rated_at: row.get(12)?,
                updated_at: row.get(13)?,
                guid: row.get(14)?,
                theme: row.get(15)?,
                art: row.get(16)?,
                tags: Vec::new(),
                locations: Vec::new(),
            })
        })
        .map_err(|e| format!("query error: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

/// Count total artists.
pub fn count(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT COUNT(*) FROM artists", [], |r| r.get(0))
        .map_err(|e| format!("count error: {e}"))
}

// ---- Helpers ----

fn get_locations(conn: &Connection, artist_id: i64) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT path FROM artist_locations WHERE artist_id = ?1")
        .map_err(|e| format!("prepare error: {e}"))?;
    let rows: Vec<String> = stmt
        .query_map([artist_id], |row| row.get(0))
        .map_err(|e| format!("query error: {e}"))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// Get tags for any entity type.
pub fn get_tags(conn: &Connection, entity_type: &str, entity_id: i64) -> Result<Vec<TagRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT tag_type, tag, tag_id, filter FROM tags WHERE entity_type = ?1 AND entity_id = ?2",
        )
        .map_err(|e| format!("prepare error: {e}"))?;
    let rows: Vec<TagRow> = stmt
        .query_map(rusqlite::params![entity_type, entity_id], |row| {
            Ok(TagRow {
                tag_type: row.get(0)?,
                tag: row.get(1)?,
                tag_id: row.get(2)?,
                filter: row.get(3)?,
            })
        })
        .map_err(|e| format!("query error: {e}"))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// Insert tags for an entity — used by albums and tracks modules too.
pub fn insert_tags(
    conn: &Connection,
    entity_type: &str,
    entity_id: i64,
    tag_type: &str,
    tags: &[PlexTag],
) -> Result<(), String> {
    for t in tags {
        conn.execute(
            "INSERT OR IGNORE INTO tags (entity_type, entity_id, tag_type, tag, tag_id, filter)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![entity_type, entity_id, tag_type, t.tag, t.id, t.filter],
        )
        .map_err(|e| format!("insert tag error: {e}"))?;
    }
    Ok(())
}

/// rusqlite optional helper
trait Optional<T> {
    fn optional(self) -> Result<Option<T>, rusqlite::Error>;
}

impl<T> Optional<T> for Result<T, rusqlite::Error> {
    fn optional(self) -> Result<Option<T>, rusqlite::Error> {
        match self {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::DbState;

    fn make_artist(id: i64, title: &str) -> Artist {
        Artist {
            rating_key: id,
            key: format!("/library/metadata/{id}"),
            title: title.to_string(),
            library_section_id: 1,
            locations: vec!["/music/artist1".to_string()],
            ..Default::default()
        }
    }

    #[test]
    fn failed_child_replacement_preserves_artist_and_bulk_transaction() {
        let db = DbState::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();
        let mut original = make_artist(1, "Original");
        original.locations = vec!["/original".into()];
        upsert(&conn, &original).unwrap();
        let before = serde_json::to_value(get(&conn, 1).unwrap()).unwrap();
        let mut invalid = make_artist(1, "Changed");
        invalid.locations = vec!["/duplicate".into(), "/duplicate".into()];
        assert!(upsert(&conn, &invalid).is_err());
        assert_eq!(
            serde_json::to_value(get(&conn, 1).unwrap()).unwrap(),
            before
        );
        assert!(conn.is_autocommit());
        assert!(upsert_bulk(&conn, &[make_artist(2, "New"), invalid]).is_err());
        assert_eq!(
            serde_json::to_value(get(&conn, 1).unwrap()).unwrap(),
            before
        );
        assert!(get(&conn, 2).unwrap().is_none());
        assert_eq!(count(&conn).unwrap(), 1);
        assert!(conn.is_autocommit());
    }

    #[test]
    fn test_artist_round_trip() {
        let db = DbState::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();

        let artist = make_artist(100, "Test Artist");
        upsert(&conn, &artist).unwrap();

        let loaded = get(&conn, 100).unwrap().expect("should exist");
        assert_eq!(loaded.id, 100);
        assert_eq!(loaded.title, "Test Artist");
        assert_eq!(loaded.api_key, "/library/metadata/100");
        assert_eq!(loaded.locations, vec!["/music/artist1"]);
    }

    #[test]
    fn test_artist_upsert_overwrites() {
        let db = DbState::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();

        upsert(&conn, &make_artist(200, "Original")).unwrap();
        upsert(&conn, &make_artist(200, "Updated")).unwrap();

        let loaded = get(&conn, 200).unwrap().unwrap();
        assert_eq!(loaded.title, "Updated");
        assert_eq!(count(&conn).unwrap(), 1);
    }

    #[test]
    fn test_artist_bulk_upsert() {
        let db = DbState::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();

        let artists: Vec<Artist> = (1..=50).map(|i| make_artist(i, &format!("Artist {i}"))).collect();
        upsert_bulk(&conn, &artists).unwrap();
        assert_eq!(count(&conn).unwrap(), 50);
    }

    #[test]
    fn test_artist_search() {
        let db = DbState::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();

        upsert(&conn, &make_artist(1, "Radiohead")).unwrap();
        upsert(&conn, &make_artist(2, "The Beatles")).unwrap();
        upsert(&conn, &make_artist(3, "Beach House")).unwrap();

        let results = search(&conn, "bea", 10).unwrap();
        assert_eq!(results.len(), 2); // Beatles + Beach House
    }

    #[test]
    fn test_artist_not_found() {
        let db = DbState::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();
        assert!(get(&conn, 999).unwrap().is_none());
    }

    #[test]
    fn test_artist_locations() {
        let db = DbState::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();

        let mut artist = make_artist(300, "Multi-Location Artist");
        artist.locations = vec!["/music/loc1".into(), "/music/loc2".into()];
        upsert(&conn, &artist).unwrap();

        let loaded = get(&conn, 300).unwrap().unwrap();
        assert_eq!(loaded.locations.len(), 2);

        // Update with fewer locations
        artist.locations = vec!["/music/loc3".into()];
        upsert(&conn, &artist).unwrap();

        let loaded2 = get(&conn, 300).unwrap().unwrap();
        assert_eq!(loaded2.locations, vec!["/music/loc3"]);
    }
}
