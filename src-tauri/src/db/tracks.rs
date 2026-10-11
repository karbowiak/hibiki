//! Track CRUD operations (including nested media, parts, streams, lyrics).

use rusqlite::Connection;
use serde::Serialize;

use crate::plex::models::Track;

use super::artists::{get_tags, TagRow};
use super::{datetime_to_iso, parse_plex_id};

/// Track row returned from the database.
#[derive(Debug, Clone, Serialize, Default)]
pub struct TrackRow {
    pub id: i64,
    pub api_key: String,
    pub title: String,
    pub track_number: i64,
    pub duration: i64,
    pub album_id: Option<i64>,
    pub album_name: String,
    pub album_year: Option<i64>,
    pub album_studio: Option<String>,
    pub artist_id: Option<i64>,
    pub artist_name: String,
    pub library_section_id: i64,
    pub library_section_key: Option<String>,
    pub library_section_title: Option<String>,
    pub year: i64,
    pub play_count: i64,
    pub thumb: Option<String>,
    pub album_thumb: Option<String>,
    pub artist_thumb: Option<String>,
    pub thumb_blur_hash: Option<String>,
    pub summary: Option<String>,
    pub user_rating: Option<f64>,
    pub added_at: Option<String>,
    pub last_viewed_at: Option<String>,
    pub last_rated_at: Option<String>,
    pub updated_at: Option<String>,
    pub guid: Option<String>,
    pub audio_bitrate: Option<i64>,
    pub audio_channels: Option<f64>,
    pub audio_codec: Option<String>,
    pub original_title: Option<String>,
    pub primary_extra_key: Option<String>,
    pub resume_offset: Option<i64>,
    pub sonic_analysis_version: Option<i64>,
    pub rating_count: Option<i64>,
    pub skip_count: Option<i64>,
    pub tags: Vec<TagRow>,
    pub media: Vec<MediaRow>,
    pub lyrics: Vec<LyricsRow>,
}

/// Media file row.
#[derive(Debug, Clone, Serialize, Default)]
pub struct MediaRow {
    pub id: i64,
    pub duration: Option<i64>,
    pub bitrate: Option<i64>,
    pub audio_channels: Option<i64>,
    pub audio_codec: Option<String>,
    pub container: Option<String>,
    pub parts: Vec<MediaPartRow>,
}

/// Media part row.
#[derive(Debug, Clone, Serialize, Default)]
pub struct MediaPartRow {
    pub id: i64,
    pub stream_key: String,
    pub duration: Option<i64>,
    pub file_path: Option<String>,
    pub file_size: Option<i64>,
    pub container: Option<String>,
    pub audio_profile: Option<String>,
    pub streams: Vec<StreamRow>,
}

/// Audio stream row.
#[derive(Debug, Clone, Serialize, Default)]
pub struct StreamRow {
    pub id: Option<i64>,
    pub stream_type: Option<i64>,
    pub stream_key: Option<String>,
    pub format: Option<String>,
    pub gain: Option<f64>,
    pub album_gain: Option<f64>,
    pub peak: Option<f64>,
    pub loudness: Option<f64>,
    pub codec: Option<String>,
    pub channels: Option<i64>,
    pub bitrate: Option<i64>,
    pub bit_depth: Option<i64>,
    pub sampling_rate: Option<i64>,
    pub display_title: Option<String>,
}

/// Lyrics reference row.
#[derive(Debug, Clone, Serialize, Default)]
pub struct LyricsRow {
    pub id: i64,
    pub fetch_key: String,
    pub format: String,
}

/// Upsert a single track from Plex data — includes nested media/parts/streams/lyrics.
pub fn upsert(conn: &Connection, track: &Track) -> Result<(), String> {
    super::atomic_upsert(conn, |conn| upsert_inner(conn, track))
}

fn upsert_inner(conn: &Connection, track: &Track) -> Result<(), String> {
    let album_id = parse_plex_id(&track.parent_key);
    let artist_id = parse_plex_id(&track.grandparent_key);

    conn.execute(
        "INSERT INTO tracks (id, api_key, title, track_number, duration, album_id, album_name,
            album_year, album_studio, artist_id, artist_name, library_section_id,
            library_section_key, library_section_title, year, play_count, thumb, album_thumb,
            artist_thumb, thumb_blur_hash, summary, user_rating, added_at, last_viewed_at,
            last_rated_at, updated_at, guid, audio_bitrate, audio_channels, audio_codec,
            original_title, primary_extra_key, resume_offset, sonic_analysis_version,
            rating_count, skip_count)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,
                 ?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35,?36)
         ON CONFLICT(id) DO UPDATE SET
            api_key=?2, title=?3, track_number=?4, duration=?5, album_id=?6, album_name=?7,
            album_year=?8, album_studio=?9, artist_id=?10, artist_name=?11,
            library_section_id=?12, library_section_key=?13, library_section_title=?14,
            year=?15, play_count=?16, thumb=?17, album_thumb=?18, artist_thumb=?19,
            thumb_blur_hash=?20, summary=?21, user_rating=?22, added_at=?23,
            last_viewed_at=?24, last_rated_at=?25, updated_at=?26, guid=?27,
            audio_bitrate=?28, audio_channels=?29, audio_codec=?30, original_title=?31,
            primary_extra_key=?32, resume_offset=?33, sonic_analysis_version=?34,
            rating_count=?35, skip_count=?36",
        rusqlite::params![
            track.rating_key,
            track.key,
            track.title,
            track.index,
            track.duration,
            album_id,
            track.parent_title,
            track.parent_year,
            track.parent_studio,
            artist_id,
            track.grandparent_title,
            track.library_section_id,
            track.library_section_key,
            track.library_section_title,
            track.year,
            track.view_count,
            track.thumb,
            track.parent_thumb,
            track.grandparent_thumb,
            track.thumb_blur_hash,
            track.summary,
            track.user_rating,
            datetime_to_iso(&track.added_at),
            datetime_to_iso(&track.last_viewed_at),
            datetime_to_iso(&track.last_rated_at),
            datetime_to_iso(&track.updated_at),
            track.guid,
            track.audio_bitrate,
            track.audio_channels,
            track.audio_codec,
            track.original_title,
            track.primary_extra_key,
            track.view_offset,
            track.music_analysis_version,
            track.rating_count,
            track.skip_count,
        ],
    )
    .map_err(|e| format!("upsert track error: {e}"))?;

    // Tags — no tag fields on Track struct currently, but we keep the pattern.
    conn.execute(
        "DELETE FROM tags WHERE entity_type = 'track' AND entity_id = ?1",
        [track.rating_key],
    )
    .map_err(|e| format!("delete tags error: {e}"))?;

    // Media chain: delete old, insert new (cascade handles parts/streams)
    delete_media_chain(conn, track.rating_key)?;

    for m in &track.media {
        conn.execute(
            "INSERT INTO media (id, track_id, duration, bitrate, audio_channels, audio_codec, container)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            rusqlite::params![
                m.id, track.rating_key, m.duration, m.bitrate, m.audio_channels,
                m.audio_codec, m.container,
            ],
        )
        .map_err(|e| format!("insert media error: {e}"))?;

        for p in &m.parts {
            conn.execute(
                "INSERT INTO media_parts (id, media_id, stream_key, duration, file_path, file_size, container, audio_profile)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                rusqlite::params![
                    p.id, m.id, p.key, p.duration, p.file, p.size, p.container, p.audio_profile,
                ],
            )
            .map_err(|e| format!("insert media_part error: {e}"))?;

            for s in &p.streams {
                conn.execute(
                    "INSERT INTO streams (plex_stream_id, part_id, stream_type, stream_key, format,
                        gain, album_gain, peak, loudness, codec, channels, bitrate, bit_depth,
                        sampling_rate, display_title)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
                    rusqlite::params![
                        s.id, p.id, s.stream_type, s.key, s.format, s.gain,
                        s.album_gain, s.peak, s.loudness, s.codec, s.channels,
                        s.bitrate, s.bit_depth, s.sampling_rate, s.display_title,
                    ],
                )
                .map_err(|e| format!("insert stream error: {e}"))?;
            }
        }
    }

    // Lyrics references
    conn.execute(
        "DELETE FROM lyrics WHERE track_id = ?1",
        [track.rating_key],
    )
    .map_err(|e| format!("delete lyrics error: {e}"))?;

    for l in &track.lyrics {
        conn.execute(
            "INSERT INTO lyrics (id, track_id, fetch_key, format) VALUES (?1,?2,?3,?4)",
            rusqlite::params![l.id, track.rating_key, l.key, l.format],
        )
        .map_err(|e| format!("insert lyrics error: {e}"))?;
    }

    Ok(())
}

/// Upsert many tracks in a single transaction.
pub fn upsert_bulk(conn: &Connection, tracks: &[Track]) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("begin tx error: {e}"))?;
    for track in tracks {
        upsert(&tx, track)?;
    }
    tx.commit().map_err(|e| format!("commit error: {e}"))?;
    Ok(())
}

/// Get a single track by ID — includes media chain, lyrics, tags.
pub fn get(conn: &Connection, id: i64) -> Result<Option<TrackRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, api_key, title, track_number, duration, album_id, album_name,
                    album_year, album_studio, artist_id, artist_name, library_section_id,
                    library_section_key, library_section_title, year, play_count, thumb,
                    album_thumb, artist_thumb, thumb_blur_hash, summary, user_rating,
                    added_at, last_viewed_at, last_rated_at, updated_at, guid,
                    audio_bitrate, audio_channels, audio_codec, original_title,
                    primary_extra_key, resume_offset, sonic_analysis_version,
                    rating_count, skip_count
             FROM tracks WHERE id = ?1",
        )
        .map_err(|e| format!("prepare error: {e}"))?;

    let row = stmt
        .query_row([id], |row| row_to_track(row))
        .optional()
        .map_err(|e| format!("query error: {e}"))?;

    match row {
        None => Ok(None),
        Some(mut t) => {
            t.tags = get_tags(conn, "track", t.id)?;
            t.media = get_media_chain(conn, t.id)?;
            t.lyrics = get_lyrics(conn, t.id)?;
            Ok(Some(t))
        }
    }
}

/// Search tracks by title.
pub fn search(conn: &Connection, query: &str, limit: i64) -> Result<Vec<TrackRow>, String> {
    let pattern = format!("%{query}%");
    let mut stmt = conn
        .prepare(
            "SELECT id, api_key, title, track_number, duration, album_id, album_name,
                    album_year, album_studio, artist_id, artist_name, library_section_id,
                    library_section_key, library_section_title, year, play_count, thumb,
                    album_thumb, artist_thumb, thumb_blur_hash, summary, user_rating,
                    added_at, last_viewed_at, last_rated_at, updated_at, guid,
                    audio_bitrate, audio_channels, audio_codec, original_title,
                    primary_extra_key, resume_offset, sonic_analysis_version,
                    rating_count, skip_count
             FROM tracks
             WHERE title LIKE ?1 COLLATE NOCASE
             ORDER BY title COLLATE NOCASE
             LIMIT ?2",
        )
        .map_err(|e| format!("prepare error: {e}"))?;

    let rows: Vec<TrackRow> = stmt
        .query_map(rusqlite::params![pattern, limit], |row| row_to_track(row))
        .map_err(|e| format!("query error: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

/// Get all tracks for an album.
pub fn get_by_album(conn: &Connection, album_id: i64) -> Result<Vec<TrackRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, api_key, title, track_number, duration, album_id, album_name,
                    album_year, album_studio, artist_id, artist_name, library_section_id,
                    library_section_key, library_section_title, year, play_count, thumb,
                    album_thumb, artist_thumb, thumb_blur_hash, summary, user_rating,
                    added_at, last_viewed_at, last_rated_at, updated_at, guid,
                    audio_bitrate, audio_channels, audio_codec, original_title,
                    primary_extra_key, resume_offset, sonic_analysis_version,
                    rating_count, skip_count
             FROM tracks
             WHERE album_id = ?1
             ORDER BY track_number, title COLLATE NOCASE",
        )
        .map_err(|e| format!("prepare error: {e}"))?;

    let rows: Vec<TrackRow> = stmt
        .query_map([album_id], |row| row_to_track(row))
        .map_err(|e| format!("query error: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

/// Count total tracks.
pub fn count(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0))
        .map_err(|e| format!("count error: {e}"))
}

// ---- Helpers ----

fn row_to_track(row: &rusqlite::Row<'_>) -> rusqlite::Result<TrackRow> {
    Ok(TrackRow {
        id: row.get(0)?,
        api_key: row.get(1)?,
        title: row.get(2)?,
        track_number: row.get(3)?,
        duration: row.get(4)?,
        album_id: row.get(5)?,
        album_name: row.get(6)?,
        album_year: row.get(7)?,
        album_studio: row.get(8)?,
        artist_id: row.get(9)?,
        artist_name: row.get(10)?,
        library_section_id: row.get(11)?,
        library_section_key: row.get(12)?,
        library_section_title: row.get(13)?,
        year: row.get(14)?,
        play_count: row.get(15)?,
        thumb: row.get(16)?,
        album_thumb: row.get(17)?,
        artist_thumb: row.get(18)?,
        thumb_blur_hash: row.get(19)?,
        summary: row.get(20)?,
        user_rating: row.get(21)?,
        added_at: row.get(22)?,
        last_viewed_at: row.get(23)?,
        last_rated_at: row.get(24)?,
        updated_at: row.get(25)?,
        guid: row.get(26)?,
        audio_bitrate: row.get(27)?,
        audio_channels: row.get(28)?,
        audio_codec: row.get(29)?,
        original_title: row.get(30)?,
        primary_extra_key: row.get(31)?,
        resume_offset: row.get(32)?,
        sonic_analysis_version: row.get(33)?,
        rating_count: row.get(34)?,
        skip_count: row.get(35)?,
        tags: Vec::new(),
        media: Vec::new(),
        lyrics: Vec::new(),
    })
}

fn delete_media_chain(conn: &Connection, track_id: i64) -> Result<(), String> {
    // CASCADE handles parts → streams automatically
    conn.execute("DELETE FROM media WHERE track_id = ?1", [track_id])
        .map_err(|e| format!("delete media error: {e}"))?;
    Ok(())
}

fn get_media_chain(conn: &Connection, track_id: i64) -> Result<Vec<MediaRow>, String> {
    let mut media_stmt = conn
        .prepare("SELECT id, duration, bitrate, audio_channels, audio_codec, container FROM media WHERE track_id = ?1")
        .map_err(|e| format!("prepare error: {e}"))?;

    let mut medias: Vec<MediaRow> = media_stmt
        .query_map([track_id], |row| {
            Ok(MediaRow {
                id: row.get(0)?,
                duration: row.get(1)?,
                bitrate: row.get(2)?,
                audio_channels: row.get(3)?,
                audio_codec: row.get(4)?,
                container: row.get(5)?,
                parts: Vec::new(),
            })
        })
        .map_err(|e| format!("query error: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    for m in &mut medias {
        m.parts = get_parts(conn, m.id)?;
    }

    Ok(medias)
}

fn get_parts(conn: &Connection, media_id: i64) -> Result<Vec<MediaPartRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, stream_key, duration, file_path, file_size, container, audio_profile
             FROM media_parts WHERE media_id = ?1",
        )
        .map_err(|e| format!("prepare error: {e}"))?;

    let mut parts: Vec<MediaPartRow> = stmt
        .query_map([media_id], |row| {
            Ok(MediaPartRow {
                id: row.get(0)?,
                stream_key: row.get(1)?,
                duration: row.get(2)?,
                file_path: row.get(3)?,
                file_size: row.get(4)?,
                container: row.get(5)?,
                audio_profile: row.get(6)?,
                streams: Vec::new(),
            })
        })
        .map_err(|e| format!("query error: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    for p in &mut parts {
        p.streams = get_streams(conn, p.id)?;
    }

    Ok(parts)
}

fn get_streams(conn: &Connection, part_id: i64) -> Result<Vec<StreamRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT plex_stream_id, stream_type, stream_key, format, gain, album_gain, peak,
                    loudness, codec, channels, bitrate, bit_depth, sampling_rate, display_title
             FROM streams WHERE part_id = ?1",
        )
        .map_err(|e| format!("prepare error: {e}"))?;

    let rows: Vec<StreamRow> = stmt
        .query_map([part_id], |row| {
            Ok(StreamRow {
                id: row.get(0)?,
                stream_type: row.get(1)?,
                stream_key: row.get(2)?,
                format: row.get(3)?,
                gain: row.get(4)?,
                album_gain: row.get(5)?,
                peak: row.get(6)?,
                loudness: row.get(7)?,
                codec: row.get(8)?,
                channels: row.get(9)?,
                bitrate: row.get(10)?,
                bit_depth: row.get(11)?,
                sampling_rate: row.get(12)?,
                display_title: row.get(13)?,
            })
        })
        .map_err(|e| format!("query error: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

fn get_lyrics(conn: &Connection, track_id: i64) -> Result<Vec<LyricsRow>, String> {
    let mut stmt = conn
        .prepare("SELECT id, fetch_key, format FROM lyrics WHERE track_id = ?1")
        .map_err(|e| format!("prepare error: {e}"))?;

    let rows: Vec<LyricsRow> = stmt
        .query_map([track_id], |row| {
            Ok(LyricsRow {
                id: row.get(0)?,
                fetch_key: row.get(1)?,
                format: row.get(2)?,
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
    use crate::plex::models::{LyricsStream, Media, MediaPart, PlexStream};

    fn make_track(id: i64, title: &str) -> Track {
        Track {
            rating_key: id,
            key: format!("/library/metadata/{id}"),
            title: title.to_string(),
            index: 1,
            duration: 240000,
            parent_key: "/library/metadata/500".to_string(),
            parent_title: "Test Album".to_string(),
            grandparent_key: "/library/metadata/100".to_string(),
            grandparent_title: "Test Artist".to_string(),
            library_section_id: 1,
            year: 2024,
            ..Default::default()
        }
    }

    fn make_track_with_media(id: i64, title: &str) -> Track {
        let mut t = make_track(id, title);
        t.media = vec![Media {
            id: id * 10,
            duration: Some(240000),
            bitrate: Some(1411),
            audio_channels: Some(2),
            audio_codec: Some("flac".into()),
            container: Some("flac".into()),
            parts: vec![MediaPart {
                id: id * 100,
                key: format!("/library/parts/{}/file.flac", id * 100),
                duration: Some(240000),
                file: Some("/music/test.flac".into()),
                size: Some(50_000_000),
                container: Some("flac".into()),
                audio_profile: Some("lossless".into()),
                indexes: None,
                streams: vec![PlexStream {
                    id: Some(id * 1000),
                    stream_type: Some(2),
                    gain: Some(-8.5),
                    album_gain: Some(-7.2),
                    peak: Some(0.98),
                    loudness: Some(-14.0),
                    codec: Some("flac".into()),
                    channels: Some(2),
                    bitrate: Some(1411),
                    bit_depth: Some(16),
                    sampling_rate: Some(44100),
                    display_title: Some("FLAC (Stereo)".into()),
                    ..Default::default()
                }],
            }],
        }];
        t.lyrics = vec![LyricsStream {
            id: id * 10000,
            key: format!("/library/streams/{}", id * 10000),
            format: "lrc".into(),
        }];
        t
    }

    #[test]
    fn failed_child_replacement_preserves_track_and_bulk_transaction() {
        let db = DbState::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();
        let original = make_track_with_media(1, "Original");
        upsert(&conn, &original).unwrap();
        let before = serde_json::to_value(get(&conn, 1).unwrap()).unwrap();
        let mut invalid = original.clone();
        invalid.title = "Changed".into();
        invalid.media.push(invalid.media[0].clone());
        assert!(upsert(&conn, &invalid).is_err());
        assert_eq!(
            serde_json::to_value(get(&conn, 1).unwrap()).unwrap(),
            before
        );
        assert!(conn.is_autocommit());
        assert!(upsert_bulk(&conn, &[make_track_with_media(2, "New"), invalid]).is_err());
        assert_eq!(
            serde_json::to_value(get(&conn, 1).unwrap()).unwrap(),
            before
        );
        assert!(get(&conn, 2).unwrap().is_none());
        assert_eq!(count(&conn).unwrap(), 1);
        assert!(conn.is_autocommit());
    }

    #[test]
    fn test_track_round_trip() {
        let db = DbState::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();

        let track = make_track(1000, "Everything In Its Right Place");
        upsert(&conn, &track).unwrap();

        let loaded = get(&conn, 1000).unwrap().expect("should exist");
        assert_eq!(loaded.id, 1000);
        assert_eq!(loaded.title, "Everything In Its Right Place");
        assert_eq!(loaded.album_name, "Test Album");
        assert_eq!(loaded.artist_name, "Test Artist");
        assert_eq!(loaded.album_id, Some(500));
        assert_eq!(loaded.artist_id, Some(100));
        assert_eq!(loaded.duration, 240000);
    }

    #[test]
    fn test_track_with_media_chain() {
        let db = DbState::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();

        let track = make_track_with_media(2000, "Idioteque");
        upsert(&conn, &track).unwrap();

        let loaded = get(&conn, 2000).unwrap().unwrap();
        assert_eq!(loaded.media.len(), 1);
        let media = &loaded.media[0];
        assert_eq!(media.audio_codec.as_deref(), Some("flac"));
        assert_eq!(media.parts.len(), 1);

        let part = &media.parts[0];
        assert_eq!(part.file_path.as_deref(), Some("/music/test.flac"));
        assert_eq!(part.streams.len(), 1);

        let stream = &part.streams[0];
        assert_eq!(stream.gain, Some(-8.5));
        assert_eq!(stream.album_gain, Some(-7.2));
        assert_eq!(stream.sampling_rate, Some(44100));
    }

    #[test]
    fn test_track_lyrics() {
        let db = DbState::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();

        let track = make_track_with_media(3000, "How to Disappear");
        upsert(&conn, &track).unwrap();

        let loaded = get(&conn, 3000).unwrap().unwrap();
        assert_eq!(loaded.lyrics.len(), 1);
        assert_eq!(loaded.lyrics[0].format, "lrc");
    }

    #[test]
    fn test_track_search() {
        let db = DbState::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();

        upsert(&conn, &make_track(1, "Everything In Its Right Place")).unwrap();
        upsert(&conn, &make_track(2, "Kid A")).unwrap();
        upsert(&conn, &make_track(3, "The National Anthem")).unwrap();

        let results = search(&conn, "the", 10).unwrap();
        assert_eq!(results.len(), 1); // "The National Anthem"
    }

    #[test]
    fn test_track_by_album() {
        let db = DbState::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();

        let mut t1 = make_track(1, "Track 1");
        t1.parent_key = "/library/metadata/500".into();
        upsert(&conn, &t1).unwrap();

        let mut t2 = make_track(2, "Track 2");
        t2.parent_key = "/library/metadata/500".into();
        upsert(&conn, &t2).unwrap();

        let mut t3 = make_track(3, "Track 3");
        t3.parent_key = "/library/metadata/600".into();
        upsert(&conn, &t3).unwrap();

        let results = get_by_album(&conn, 500).unwrap();
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn test_track_bulk_upsert() {
        let db = DbState::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();

        let tracks: Vec<Track> = (1..=100)
            .map(|i| make_track(i, &format!("Track {i}")))
            .collect();
        upsert_bulk(&conn, &tracks).unwrap();
        assert_eq!(count(&conn).unwrap(), 100);
    }

    #[test]
    fn test_track_upsert_replaces_media() {
        let db = DbState::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();

        let track = make_track_with_media(4000, "Optimistic");
        upsert(&conn, &track).unwrap();

        // Upsert again — should replace, not duplicate
        upsert(&conn, &track).unwrap();

        let loaded = get(&conn, 4000).unwrap().unwrap();
        assert_eq!(loaded.media.len(), 1);
        assert_eq!(loaded.media[0].parts.len(), 1);
        assert_eq!(loaded.media[0].parts[0].streams.len(), 1);
        assert_eq!(loaded.lyrics.len(), 1);
    }
}
