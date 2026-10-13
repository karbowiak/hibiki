//! Read-only, exact-ID recording proof for an explicitly selected playlist row.
use super::*;
use crate::musicbrainz::{exact_playlist_identity_json, ExactPlaylistIdentity};
use crate::plex::PlexClient;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
static ADMISSIONS: Lazy<tokio::sync::Semaphore> = Lazy::new(|| tokio::sync::Semaphore::new(4));
#[cfg(test)]
static TEST_ADMISSION_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingExpected {
    pub title: String,
    pub artist: String,
    pub duration_ms: Option<i64>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum RecordingResolution {
    Verified {
        #[serde(rename = "recordingMbid")]
        recording_mbid: String,
        proof: &'static str,
        #[serde(rename = "metadataFingerprint")]
        metadata_fingerprint: String,
    },
    Unmatched {
        reason: &'static str,
    },
    Unavailable {
        reason: &'static str,
    },
}
fn norm(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}
fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key)?
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 2000)
        .map(str::to_owned)
}
fn number(v: &Value, key: &str) -> Option<i64> {
    v.get(key)
        .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok()))
}
fn credits(v: &Value) -> Option<String> {
    let a = v.as_array()?;
    if a.is_empty() || a.len() > 16 {
        return None;
    }
    let mut out = String::new();
    for c in a {
        out.push_str(&text(c, "name")?);
        out.push_str(
            c.get("joinphrase")
                .and_then(Value::as_str)
                .filter(|s| s.len() <= 100)
                .unwrap_or(""),
        );
    }
    Some(out)
}
fn current(check: &impl Fn() -> bool) -> Result<()> {
    if !check() {
        bail!("Playlist recording connection changed")
    };
    Ok(())
}
#[derive(Clone)]
struct Source {
    title: String,
    artist: String,
    duration: i64,
    recordings: BTreeSet<String>,
    tracks: BTreeSet<String>,
    fingerprint: String,
}
fn source(
    raw: &Value,
    id: i64,
    section: i64,
    expected: &RecordingExpected,
) -> Result<Source, &'static str> {
    if number(raw, "ratingKey") != Some(id)
        || number(raw, "librarySectionID") != Some(section)
        || raw["type"] != "track"
    {
        return Err("metadata-changed");
    }
    let title = text(raw, "title").ok_or("incomplete-metadata")?;
    let artist = text(raw, "grandparentTitle").ok_or("incomplete-metadata")?;
    let duration = number(raw, "duration")
        .filter(|n| *n > 0 && *n <= 86400000)
        .ok_or("incomplete-metadata")?;
    if norm(&title) != norm(&expected.title)
        || norm(&artist) != norm(&expected.artist)
        || expected.duration_ms.is_some_and(|n| n != duration)
    {
        return Err("metadata-changed");
    }
    let refs = raw.get("Guid").and_then(Value::as_array);
    if refs.is_some_and(|a| a.len() > 32) {
        return Err("ambiguous-reference");
    }
    let mut recordings = BTreeSet::new();
    let mut tracks = BTreeSet::new();
    for reference in refs
        .into_iter()
        .flatten()
        .filter_map(|v| v.get("id").and_then(Value::as_str))
        .chain(raw.get("guid").and_then(Value::as_str))
    {
        let recording = reference
            .strip_prefix("musicbrainz://recording/")
            .or_else(|| reference.strip_prefix("mbid://recording/"))
            .or_else(|| reference.strip_prefix("https://musicbrainz.org/recording/"));
        if let Some(id) = recording.and_then(|id| canonical_mbid(id).ok()) {
            recordings.insert(id);
        } else if let Some(id) = reference
            .strip_prefix("mbid://")
            .and_then(|id| canonical_mbid(id).ok())
        {
            tracks.insert(id);
        }
    }
    if recordings.len() > 1 || tracks.len() > 1 || (!recordings.is_empty() && !tracks.is_empty()) {
        return Err("ambiguous-reference");
    }
    let fingerprint = format!(
        "{:x}",
        Sha256::digest(
            json!([
                id,
                section,
                title,
                artist,
                duration,
                text(raw,"parentTitle"),
                recordings,
                tracks
            ])
            .to_string()
            .as_bytes()
        )
    );
    Ok(Source {
        title,
        artist,
        duration,
        recordings,
        tracks,
        fingerprint,
    })
}
fn recording_matches(value: &Value, id: &str, source: &Source, require_length: bool) -> bool {
    value
        .get("id")
        .and_then(Value::as_str)
        .and_then(|s| canonical_mbid(s).ok())
        .as_deref()
        == Some(id)
        && text(value, "title").is_some_and(|t| norm(&t) == norm(&source.title))
        && value
            .get("artist-credit")
            .and_then(credits)
            .is_some_and(|a| norm(&a) == norm(&source.artist))
        && (!require_length
            || number(value, "length")
                .is_some_and(|n| n > 0 && (n - source.duration).abs() <= 1000))
}
fn relation(value: &Value, id: &str, source: &Source) -> Result<String, &'static str> {
    let releases = value
        .get("releases")
        .and_then(Value::as_array)
        .filter(|a| a.len() <= 5)
        .ok_or("invalid-relationship")?;
    let mut matches = BTreeSet::new();
    for release in releases {
        let media = release
            .get("media")
            .and_then(Value::as_array)
            .filter(|a| a.len() <= 32)
            .ok_or("invalid-relationship")?;
        for medium in media {
            let tracks = medium
                .get("tracks")
                .and_then(Value::as_array)
                .filter(|a| a.len() <= 1000)
                .ok_or("invalid-relationship")?;
            for track in tracks {
                if track
                    .get("id")
                    .and_then(Value::as_str)
                    .and_then(|s| canonical_mbid(s).ok())
                    .as_deref()
                    != Some(id)
                {
                    continue;
                }
                let artist = track
                    .get("artist-credit")
                    .or_else(|| release.get("artist-credit"))
                    .and_then(credits)
                    .ok_or("invalid-relationship")?;
                if text(track, "title").is_none_or(|t| norm(&t) != norm(&source.title))
                    || norm(&artist) != norm(&source.artist)
                    || number(track, "length")
                        .is_none_or(|n| n <= 0 || (n - source.duration).abs() > 1000)
                {
                    return Err("metadata-mismatch");
                }
                let recording = track
                    .get("recording")
                    .and_then(|v| v.get("id"))
                    .and_then(Value::as_str)
                    .and_then(|s| canonical_mbid(s).ok())
                    .ok_or("invalid-relationship")?;
                matches.insert(recording);
            }
        }
    }
    if matches.len() > 1 {
        return Err("ambiguous-relationship");
    }
    matches.into_iter().next().ok_or("missing-relationship")
}
pub async fn resolve(
    client: &PlexClient,
    section_id: i64,
    track_id: i64,
    expected: &RecordingExpected,
    check: impl Fn() -> bool,
) -> Result<RecordingResolution> {
    let Ok(_permit) = ADMISSIONS.try_acquire() else {
        return Ok(RecordingResolution::Unavailable { reason: "busy" });
    };
    if section_id <= 0
        || track_id <= 0
        || expected.title.is_empty()
        || expected.title.len() > 2000
        || expected.artist.is_empty()
        || expected.artist.len() > 2000
    {
        bail!("Invalid selected recording row")
    }
    current(&check)?;
    let section = client.get_section(section_id).await?;
    current(&check)?;
    if section.key != section_id
        || section.section_type != "artist"
        || (client.library_scope
            != client.cache_scope_for_library(section_id, section.uuid.as_deref())
            && client.library_scope != client.cache_scope_for_library(section_id, None))
    {
        bail!("Selected music library changed")
    }
    current(&check)?;
    let value: Value = client
        .get(&format!("/library/metadata/{track_id}?includeGuids=1"))
        .await?;
    current(&check)?;
    let raw = value
        .get("Metadata")
        .and_then(Value::as_array)
        .filter(|a| a.len() == 1)
        .and_then(|a| a.first())
        .context("Selected track metadata missing")?;
    let source = match source(raw, track_id, section_id, expected) {
        Ok(s) => s,
        Err(reason) => return Ok(RecordingResolution::Unmatched { reason }),
    };
    let (id, proof, require_length) = if let Some(id) = source.recordings.iter().next() {
        (id.clone(), "explicit-recording-guid", true)
    } else if let Some(tid) = source.tracks.iter().next() {
        current(&check)?;
        let value =
            exact_playlist_identity_json(ExactPlaylistIdentity::ReleaseTrack, tid, &check).await;
        current(&check)?;
        let value = match value {
            Ok(v) => v,
            Err(_) => {
                return Ok(RecordingResolution::Unavailable {
                    reason: "service-unavailable",
                })
            }
        };
        match relation(&value, tid, &source) {
            Ok(id) => (id, "release-track-relationship", false),
            Err(reason) => return Ok(RecordingResolution::Unmatched { reason }),
        }
    } else {
        return Ok(RecordingResolution::Unmatched {
            reason: "missing-reference",
        });
    };
    current(&check)?;
    let value = exact_playlist_identity_json(ExactPlaylistIdentity::Recording, &id, &check).await;
    current(&check)?;
    let value = match value {
        Ok(v) => v,
        Err(_) => {
            return Ok(RecordingResolution::Unavailable {
                reason: "service-unavailable",
            })
        }
    };
    if !recording_matches(&value, &id, &source, require_length) {
        return Ok(RecordingResolution::Unmatched {
            reason: "metadata-mismatch",
        });
    }
    Ok(RecordingResolution::Verified {
        recording_mbid: id,
        proof,
        metadata_fingerprint: source.fingerprint,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    const TID: &str = "11111111-1111-4111-8111-111111111111";
    const RID: &str = "22222222-2222-4222-8222-222222222222";
    const OTHER: &str = "33333333-3333-4333-8333-333333333333";
    fn expected() -> RecordingExpected {
        RecordingExpected {
            title: "Song".into(),
            artist: "Artist".into(),
            duration_ms: Some(180000),
        }
    }
    fn raw() -> Value {
        json!({"ratingKey":"42","librarySectionID":5,"type":"track","title":"Song","grandparentTitle":"Artist","duration":180000,"Guid":[{"id":format!("mbid://{TID}")}]})
    }
    fn recording() -> Value {
        json!({"id":RID,"title":"Song","artist-credit":[{"name":"Artist"}],"length":180000})
    }
    fn release() -> Value {
        json!({"releases":[{"artist-credit":[{"name":"Artist"}],"media":[{"tracks":[{"id":TID,"title":"Song","length":180000,"recording":{"id":RID}}]}]}]})
    }
    #[test]
    fn generic_plex_mbid_is_a_relation_candidate_never_a_recording_proof() {
        let input = source(&raw(), 42, 5, &expected()).unwrap();
        assert!(input.recordings.is_empty());
        assert_eq!(input.tracks.iter().next().unwrap(), TID);
        let mut direct = raw();
        direct["Guid"][0]["id"] = json!(format!("musicbrainz://recording/{RID}"));
        let input = source(&direct, 42, 5, &expected()).unwrap();
        assert!(input.tracks.is_empty());
        assert_eq!(input.recordings.iter().next().unwrap(), RID);
        direct["Guid"][0]["id"] = json!(format!("plex://track/{RID}"));
        assert!(source(&direct, 42, 5, &expected())
            .unwrap()
            .recordings
            .is_empty());
    }
    #[test]
    fn exact_library_row_and_unambiguous_references_are_required() {
        for (field, value) in [
            ("ratingKey", json!(43)),
            ("librarySectionID", json!(6)),
            ("type", json!("album")),
            ("title", json!("Other")),
            ("grandparentTitle", json!("Other")),
            ("duration", json!(181000)),
        ] {
            let mut changed = raw();
            changed[field] = value;
            assert!(source(&changed, 42, 5, &expected()).is_err());
        }
        let mut ambiguous = raw();
        ambiguous["Guid"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":format!("mbid://{OTHER}")}));
        assert!(source(&ambiguous, 42, 5, &expected()).is_err());
        let mut changed = raw();
        changed["Guid"][0]["id"] = json!(format!("mbid://{OTHER}"));
        assert_ne!(
            source(&changed, 42, 5, &expected()).unwrap().fingerprint,
            source(&raw(), 42, 5, &expected()).unwrap().fingerprint
        );
    }
    #[test]
    fn release_track_identity_credit_and_duration_not_recording_median_prove_the_relationship() {
        let input = source(&raw(), 42, 5, &expected()).unwrap();
        assert_eq!(relation(&release(), TID, &input).unwrap(), RID);
        let mut median = recording();
        median["length"] = json!(210000);
        assert!(recording_matches(&median, RID, &input, false));
        assert!(!recording_matches(&median, RID, &input, true));
        for (field, value) in [
            ("id", json!(OTHER)),
            ("title", json!("Other")),
            ("length", json!(181001)),
        ] {
            let mut changed = release();
            changed["releases"][0]["media"][0]["tracks"][0][field] = value;
            assert!(relation(&changed, TID, &input).is_err());
        }
        let mut changed = release();
        changed["releases"][0]["artist-credit"][0]["name"] = json!("Other");
        assert!(relation(&changed, TID, &input).is_err());
        let mut conflict = release();
        let mut second = conflict["releases"][0].clone();
        second["media"][0]["tracks"][0]["recording"]["id"] = json!(OTHER);
        conflict["releases"].as_array_mut().unwrap().push(second);
        assert_eq!(
            relation(&conflict, TID, &input).unwrap_err(),
            "ambiguous-relationship"
        );
    }
    #[test]
    fn canonical_detail_requires_exact_id_title_credit_and_direct_duration() {
        let input = source(&raw(), 42, 5, &expected()).unwrap();
        assert!(recording_matches(&recording(), RID, &input, true));
        for (field, value) in [
            ("id", json!(OTHER)),
            ("title", json!("Song Live")),
            ("length", json!(181001)),
            ("artist-credit", json!([{"name":"Other"}])),
        ] {
            let mut changed = recording();
            changed[field] = value;
            assert!(!recording_matches(&changed, RID, &input, true));
        }
        let mut boundary = recording();
        boundary["length"] = json!(181000);
        assert!(recording_matches(&boundary, RID, &input, true));
    }
    #[tokio::test]
    async fn retired_context_is_rejected_before_any_metadata_or_public_read() {
        let _test = TEST_ADMISSION_LOCK.lock().await;
        let client = PlexClient::new(crate::plex::PlexClientConfig {
            base_url: "http://127.0.0.1:1".into(),
            token: "fixture".into(),
            ..Default::default()
        })
        .unwrap();
        assert!(resolve(&client, 5, 42, &expected(), || false)
            .await
            .unwrap_err()
            .to_string()
            .contains("changed"));
    }
}

#[cfg(test)]
mod admission_tests {
    use super::*;
    #[tokio::test]
    async fn exhausted_admission_rejects_before_any_read() {
        let _test = TEST_ADMISSION_LOCK.lock().await;
        let _slots = ADMISSIONS.acquire_many(4).await.unwrap();
        let client = PlexClient::new(crate::plex::PlexClientConfig {
            base_url: "http://127.0.0.1:1".into(),
            token: "fixture".into(),
            ..Default::default()
        })
        .unwrap();
        let expected = RecordingExpected {
            title: "Song".into(),
            artist: "Artist".into(),
            duration_ms: Some(180000),
        };
        let result = resolve(&client, 5, 42, &expected, || {
            panic!("Busy admission must not issue reads")
        })
        .await
        .unwrap();
        assert!(matches!(
            result,
            RecordingResolution::Unavailable { reason: "busy" }
        ));
    }
}
