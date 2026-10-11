//! Album CRUD operations.

use rusqlite::Connection;
use serde::Serialize;

use crate::plex::models::Album;

use super::artists::{get_tags, insert_tags, TagRow};
use super::{datetime_to_iso, parse_plex_id};

/// Album row returned from the database.
#[derive(Debug, Clone, Serialize, Default)]
pub struct AlbumRow {
    pub id: i64,
    pub api_key: String,
    pub title: String,
    pub artist_id: Option<i64>,
    pub artist_name: String,
    pub year: i64,
    pub library_section_id: i64,
    pub track_count: i64,
    pub played_track_count: i64,
    pub studio: Option<String>,
    pub thumb: Option<String>,
    pub summary: Option<String>,
    pub user_rating: Option<f64>,
    pub added_at: Option<String>,
    pub last_viewed_at: Option<String>,
    pub last_rated_at: Option<String>,
    pub updated_at: Option<String>,
    pub originally_available_at: Option<String>,
    pub guid: Option<String>,
    pub artist_guid: Option<String>,
    pub artist_theme: Option<String>,
    pub artist_thumb: Option<String>,
    pub loudness_analysis_version: Option<i64>,
    pub tags: Vec<TagRow>,
    pub reviews: Vec<ReviewRow>,
}

/// A review row from `album_reviews`.
#[derive(Debug, Clone, Serialize, Default)]
pub struct ReviewRow {
    pub id: i64,
    pub review_id: Option<i64>,
    pub tag: Option<String>,
    pub text: Option<String>,
    pub image: Option<String>,
    pub link: Option<String>,
    pub source: Option<String>,
}

/// Upsert a single album from Plex data.
pub fn upsert(conn: &Connection, album: &Album) -> Result<(), String> {
    super::atomic_upsert(conn, |conn| upsert_inner(conn, album))
}

fn upsert_inner(conn: &Connection, album: &Album) -> Result<(), String> {
    let artist_id = parse_plex_id(&album.parent_key);

    conn.execute(
        "INSERT INTO albums (id, api_key, title, artist_id, artist_name, year,
            library_section_id, track_count, played_track_count, studio, thumb, summary,
            user_rating, added_at, last_viewed_at, last_rated_at, updated_at,
            originally_available_at, guid, artist_guid, artist_theme, artist_thumb,
            loudness_analysis_version)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23)
         ON CONFLICT(id) DO UPDATE SET
            api_key=?2, title=?3, artist_id=?4, artist_name=?5, year=?6,
            library_section_id=?7, track_count=?8, played_track_count=?9, studio=?10,
            thumb=?11, summary=?12, user_rating=?13, added_at=?14, last_viewed_at=?15,
            last_rated_at=?16, updated_at=?17, originally_available_at=?18, guid=?19,
            artist_guid=?20, artist_theme=?21, artist_thumb=?22, loudness_analysis_version=?23",
        rusqlite::params![
            album.rating_key,
            album.key,
            album.title,
            artist_id,
            album.parent_title,
            album.year,
            album.library_section_id,
            album.leaf_count,
            album.viewed_leaf_count,
            album.studio,
            album.thumb,
            album.summary,
            album.user_rating,
            datetime_to_iso(&album.added_at),
            datetime_to_iso(&album.last_viewed_at),
            datetime_to_iso(&album.last_rated_at),
            datetime_to_iso(&album.updated_at),
            album.originally_available_at,
            album.guid,
            album.parent_guid,
            album.parent_theme,
            album.parent_thumb,
            album.loudness_analysis_version,
        ],
    )
    .map_err(|e| format!("upsert album error: {e}"))?;

    // Tags — delete and re-insert
    conn.execute(
        "DELETE FROM tags WHERE entity_type = 'album' AND entity_id = ?1",
        [album.rating_key],
    )
    .map_err(|e| format!("delete tags error: {e}"))?;

    insert_tags(conn, "album", album.rating_key, "genre", &album.genre)?;
    insert_tags(conn, "album", album.rating_key, "style", &album.style)?;
    insert_tags(conn, "album", album.rating_key, "mood", &album.mood)?;
    insert_tags(conn, "album", album.rating_key, "label", &album.label)?;
    insert_tags(conn, "album", album.rating_key, "collection", &album.collection)?;
    insert_tags(conn, "album", album.rating_key, "format", &album.subformat)?;

    // Reviews — delete and re-insert
    conn.execute(
        "DELETE FROM album_reviews WHERE album_id = ?1",
        [album.rating_key],
    )
    .map_err(|e| format!("delete reviews error: {e}"))?;

    for r in &album.reviews {
        conn.execute(
            "INSERT INTO album_reviews (album_id, review_id, tag, text, image, link, source)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                album.rating_key,
                r.id,
                r.tag,
                r.text,
                r.image,
                r.link,
                r.source,
            ],
        )
        .map_err(|e| format!("insert review error: {e}"))?;
    }

    Ok(())
}

/// Upsert many albums in a single transaction.
pub fn upsert_bulk(conn: &Connection, albums: &[Album]) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("begin tx error: {e}"))?;
    for album in albums {
        upsert(&tx, album)?;
    }
    tx.commit().map_err(|e| format!("commit error: {e}"))?;
    Ok(())
}

/// Get a single album by ID.
pub fn get(conn: &Connection, id: i64) -> Result<Option<AlbumRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, api_key, title, artist_id, artist_name, year,
                    library_section_id, track_count, played_track_count, studio, thumb,
                    summary, user_rating, added_at, last_viewed_at, last_rated_at,
                    updated_at, originally_available_at, guid, artist_guid,
                    artist_theme, artist_thumb, loudness_analysis_version
             FROM albums WHERE id = ?1",
        )
        .map_err(|e| format!("prepare error: {e}"))?;

    let row = stmt
        .query_row([id], |row| row_to_album(row))
        .optional()
        .map_err(|e| format!("query error: {e}"))?;

    match row {
        None => Ok(None),
        Some(mut a) => {
            a.tags = get_tags(conn, "album", a.id)?;
            a.reviews = get_reviews(conn, a.id)?;
            Ok(Some(a))
        }
    }
}

/// Search albums by title.
pub fn search(conn: &Connection, query: &str, limit: i64) -> Result<Vec<AlbumRow>, String> {
    let pattern = format!("%{query}%");
    let mut stmt = conn
        .prepare(
            "SELECT id, api_key, title, artist_id, artist_name, year,
                    library_section_id, track_count, played_track_count, studio, thumb,
                    summary, user_rating, added_at, last_viewed_at, last_rated_at,
                    updated_at, originally_available_at, guid, artist_guid,
                    artist_theme, artist_thumb, loudness_analysis_version
             FROM albums
             WHERE title LIKE ?1 COLLATE NOCASE
             ORDER BY title COLLATE NOCASE
             LIMIT ?2",
        )
        .map_err(|e| format!("prepare error: {e}"))?;

    let rows: Vec<AlbumRow> = stmt
        .query_map(rusqlite::params![pattern, limit], |row| row_to_album(row))
        .map_err(|e| format!("query error: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

/// Get all albums by a given artist ID.
pub fn get_by_artist(conn: &Connection, artist_id: i64) -> Result<Vec<AlbumRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, api_key, title, artist_id, artist_name, year,
                    library_section_id, track_count, played_track_count, studio, thumb,
                    summary, user_rating, added_at, last_viewed_at, last_rated_at,
                    updated_at, originally_available_at, guid, artist_guid,
                    artist_theme, artist_thumb, loudness_analysis_version
             FROM albums
             WHERE artist_id = ?1
             ORDER BY year DESC, title COLLATE NOCASE",
        )
        .map_err(|e| format!("prepare error: {e}"))?;

    let rows: Vec<AlbumRow> = stmt
        .query_map([artist_id], |row| row_to_album(row))
        .map_err(|e| format!("query error: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

/// Count total albums.
pub fn count(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT COUNT(*) FROM albums", [], |r| r.get(0))
        .map_err(|e| format!("count error: {e}"))
}

// ---- Helpers ----

fn row_to_album(row: &rusqlite::Row<'_>) -> rusqlite::Result<AlbumRow> {
    Ok(AlbumRow {
        id: row.get(0)?,
        api_key: row.get(1)?,
        title: row.get(2)?,
        artist_id: row.get(3)?,
        artist_name: row.get(4)?,
        year: row.get(5)?,
        library_section_id: row.get(6)?,
        track_count: row.get(7)?,
        played_track_count: row.get(8)?,
        studio: row.get(9)?,
        thumb: row.get(10)?,
        summary: row.get(11)?,
        user_rating: row.get(12)?,
        added_at: row.get(13)?,
        last_viewed_at: row.get(14)?,
        last_rated_at: row.get(15)?,
        updated_at: row.get(16)?,
        originally_available_at: row.get(17)?,
        guid: row.get(18)?,
        artist_guid: row.get(19)?,
        artist_theme: row.get(20)?,
        artist_thumb: row.get(21)?,
        loudness_analysis_version: row.get(22)?,
        tags: Vec::new(),
        reviews: Vec::new(),
    })
}

fn get_reviews(conn: &Connection, album_id: i64) -> Result<Vec<ReviewRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, review_id, tag, text, image, link, source
             FROM album_reviews WHERE album_id = ?1",
        )
        .map_err(|e| format!("prepare error: {e}"))?;

    let rows: Vec<ReviewRow> = stmt
        .query_map([album_id], |row| {
            Ok(ReviewRow {
                id: row.get(0)?,
                review_id: row.get(1)?,
                tag: row.get(2)?,
                text: row.get(3)?,
                image: row.get(4)?,
                link: row.get(5)?,
                source: row.get(6)?,
            })
        })
        .map_err(|e| format!("query error: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

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
    use crate::plex::models::{PlexTag, Review};

    fn make_album(id: i64, title: &str, artist_key: &str, artist_name: &str) -> Album {
        Album {
            rating_key: id,
            key: format!("/library/metadata/{id}"),
            title: title.to_string(),
            parent_key: artist_key.to_string(),
            parent_title: artist_name.to_string(),
            year: 2024,
            library_section_id: 1,
            leaf_count: 12,
            ..Default::default()
        }
    }

    #[test]
    fn failed_child_replacement_preserves_album_and_bulk_transaction() {
        let db = DbState::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();
        let mut original = make_album(1, "Original", "/library/metadata/100", "Artist");
        original.genre = vec![PlexTag {
            tag: "Original genre".into(),
            id: None,
            filter: None,
        }];
        original.reviews = vec![Review {
            id: Some(1),
            tag: None,
            text: Some("Original review".into()),
            image: None,
            link: None,
            source: None,
        }];
        upsert(&conn, &original).unwrap();
        let before = serde_json::to_value(get(&conn, 1).unwrap()).unwrap();
        conn.execute_batch("CREATE TRIGGER fail_review BEFORE INSERT ON album_reviews WHEN NEW.text='Rejected' BEGIN SELECT RAISE(ABORT,'synthetic review failure'); END").unwrap();
        let mut invalid = original.clone();
        invalid.title = "Changed".into();
        invalid.genre.clear();
        invalid.reviews[0].text = Some("Rejected".into());
        assert!(upsert(&conn, &invalid).is_err());
        assert_eq!(
            serde_json::to_value(get(&conn, 1).unwrap()).unwrap(),
            before
        );
        assert!(conn.is_autocommit());
        assert!(upsert_bulk(&conn, &[make_album(2, "New", "", ""), invalid]).is_err());
        assert_eq!(
            serde_json::to_value(get(&conn, 1).unwrap()).unwrap(),
            before
        );
        assert!(get(&conn, 2).unwrap().is_none());
        assert_eq!(count(&conn).unwrap(), 1);
        assert!(conn.is_autocommit());
    }

    #[test]
    fn test_album_round_trip() {
        let db = DbState::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();

        let album = make_album(500, "OK Computer", "/library/metadata/100", "Radiohead");
        upsert(&conn, &album).unwrap();

        let loaded = get(&conn, 500).unwrap().expect("should exist");
        assert_eq!(loaded.id, 500);
        assert_eq!(loaded.title, "OK Computer");
        assert_eq!(loaded.artist_name, "Radiohead");
        assert_eq!(loaded.artist_id, Some(100));
        assert_eq!(loaded.year, 2024);
        assert_eq!(loaded.track_count, 12);
    }

    #[test]
    fn test_album_tags() {
        let db = DbState::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();

        let mut album = make_album(501, "Kid A", "/library/metadata/100", "Radiohead");
        album.genre = vec![
            PlexTag { tag: "Alternative Rock".into(), id: Some(1), filter: None },
            PlexTag { tag: "Electronic".into(), id: Some(2), filter: None },
        ];
        album.mood = vec![PlexTag { tag: "Melancholic".into(), id: None, filter: None }];

        upsert(&conn, &album).unwrap();

        let loaded = get(&conn, 501).unwrap().unwrap();
        let genres: Vec<&str> = loaded.tags.iter()
            .filter(|t| t.tag_type == "genre")
            .map(|t| t.tag.as_str())
            .collect();
        assert_eq!(genres.len(), 2);
        assert!(genres.contains(&"Alternative Rock"));
        assert!(genres.contains(&"Electronic"));

        let moods: Vec<&str> = loaded.tags.iter()
            .filter(|t| t.tag_type == "mood")
            .map(|t| t.tag.as_str())
            .collect();
        assert_eq!(moods, vec!["Melancholic"]);
    }

    #[test]
    fn test_album_reviews() {
        let db = DbState::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();

        let mut album = make_album(502, "In Rainbows", "/library/metadata/100", "Radiohead");
        album.reviews = vec![Review {
            id: Some(1),
            tag: Some("Excellent".into()),
            text: Some("A masterpiece".into()),
            image: None,
            link: Some("https://example.com".into()),
            source: Some("AllMusic".into()),
        }];

        upsert(&conn, &album).unwrap();

        let loaded = get(&conn, 502).unwrap().unwrap();
        assert_eq!(loaded.reviews.len(), 1);
        assert_eq!(loaded.reviews[0].source.as_deref(), Some("AllMusic"));
        assert_eq!(loaded.reviews[0].text.as_deref(), Some("A masterpiece"));
    }

    #[test]
    fn test_album_search() {
        let db = DbState::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();

        upsert(&conn, &make_album(1, "OK Computer", "/library/metadata/100", "Radiohead")).unwrap();
        upsert(&conn, &make_album(2, "Kid A", "/library/metadata/100", "Radiohead")).unwrap();
        upsert(&conn, &make_album(3, "Computation Theory", "/library/metadata/200", "Someone")).unwrap();

        let results = search(&conn, "comput", 10).unwrap();
        assert_eq!(results.len(), 2); // OK Computer + Computation Theory
    }

    #[test]
    fn test_album_by_artist() {
        let db = DbState::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();

        upsert(&conn, &make_album(1, "OK Computer", "/library/metadata/100", "Radiohead")).unwrap();
        upsert(&conn, &make_album(2, "Kid A", "/library/metadata/100", "Radiohead")).unwrap();
        upsert(&conn, &make_album(3, "Abbey Road", "/library/metadata/200", "The Beatles")).unwrap();

        let results = get_by_artist(&conn, 100).unwrap();
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn test_album_bulk_upsert() {
        let db = DbState::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();

        let albums: Vec<Album> = (1..=30)
            .map(|i| make_album(i, &format!("Album {i}"), "/library/metadata/100", "Artist"))
            .collect();
        upsert_bulk(&conn, &albums).unwrap();
        assert_eq!(count(&conn).unwrap(), 30);
    }
}
