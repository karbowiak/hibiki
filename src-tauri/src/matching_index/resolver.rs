//! Local candidate discovery and revision-bound identity proofs. No remote writes.
use super::{
    row::{self, Identifier, Row},
    store::{self, Result},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashSet};
use unicode_normalization::UnicodeNormalization;

// Version 2 rejects unusable target names even for typed-ID matches. Retire
// earlier positive proofs too: an already-partial census can keep the same
// coverage string and unchanged punctuation-only row across that policy change.
pub const ALGORITHM: i64 = 2;
const CANDIDATES: usize = 64;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Example {
    pub title: String,
    pub kind: String,
    pub duration: Option<i64>,
    pub year: Option<i64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub artists: Vec<String>,
    #[serde(default)]
    pub identifiers: Vec<Identifier>,
    pub album: Option<String>,
    pub duration: Option<i64>,
    pub explicit: Option<bool>,
    pub version: Option<String>,
    pub date: Option<String>,
    pub year: Option<i64>,
    pub release_type: Option<String>,
    #[serde(default)]
    pub catalog: Vec<Example>,
    #[serde(default)]
    pub track_list: Vec<Example>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub row: Row,
    pub score: f64,
    pub verified: bool,
    pub evidence: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    pub source_id: String,
    pub status: String,
    pub candidates: Vec<Candidate>,
    pub selected: Option<i64>,
    pub recording_identity: Option<String>,
    pub coverage: String,
    pub revision: i64,
    pub cached: bool,
    pub limited: bool,
}
#[derive(Serialize, Deserialize)]
struct Dependency {
    kind: String,
    id: i64,
    revision: Option<String>,
    relationship: i64,
}
#[derive(Serialize, Deserialize)]
struct CandidateRef {
    kind: String,
    id: i64,
    score: f64,
    verified: bool,
    evidence: Vec<String>,
}
#[derive(Serialize, Deserialize)]
struct Proof {
    result: Resolution,
    candidates: Vec<CandidateRef>,
    dependencies: Vec<Dependency>,
}
fn error(_: rusqlite::Error) -> String {
    "Matching associations are unavailable".into()
}
// Candidate keys may fold accents; identity evidence preserves non-Latin marks,
// punctuation qualifiers and original labels. Broad keys alone never prove identity.
fn label(value: &str) -> String {
    value
        .nfkc()
        .flat_map(char::to_lowercase)
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
fn words(value: &str) -> String {
    label(value)
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || unicode_normalization::char::is_combining_mark(c) {
                c
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
fn compact(value: &str) -> String {
    words(value).replace(' ', "")
}
fn credits(values: &[String]) -> BTreeSet<String> {
    values
        .iter()
        .map(|v| words(v))
        .filter(|v| !v.is_empty())
        .collect()
}
fn fingerprint(source: &Source) -> Result<String> {
    Ok(hex::encode(Sha256::digest(
        serde_json::to_vec(source).map_err(|_| "Invalid association source")?,
    )))
}
pub fn validate(source: &Source) -> Result<()> {
    if source.identifiers.iter().any(|id| {
        id.scheme.starts_with("musicbrainz:") && uuid::Uuid::parse_str(&id.value).is_err()
            || id.scheme == "isrc"
                && (id.value.len() != 12 || !id.value.chars().all(|c| c.is_ascii_alphanumeric()))
    }) {
        return Err("Invalid typed matching identifier".into());
    }
    if !["artist", "album", "track"].contains(&source.kind.as_str())
        || source.id.is_empty()
        || source.id.len() > 512
        || source.title.trim().is_empty()
        || source.title.len() > 512
        || source.artists.len() > 32
        || source.artists.iter().any(|v| v.is_empty() || v.len() > 256)
        || source.identifiers.len() > 32
        || source
            .identifiers
            .iter()
            .any(|v| v.scheme.len() > 64 || v.value.len() > 256)
        || source.catalog.len() > 64
        || source.track_list.len() > 100
        || source
            .catalog
            .iter()
            .chain(&source.track_list)
            .any(|v| v.title.len() > 512 || !["album", "track"].contains(&v.kind.as_str()))
        || source.album.as_ref().is_some_and(|v| v.len() > 512)
        || source.version.as_ref().is_some_and(|v| v.len() > 256)
        || source.release_type.as_ref().is_some_and(|v| v.len() > 64)
        || source.date.as_ref().is_some_and(|v| v.len() > 32)
        || source.duration.is_some_and(|v| v <= 0 || v > 86400000)
    {
        return Err("Invalid bounded association source".into());
    }
    Ok(())
}
pub fn load(conn: &Connection, scope: &str, kind: &str, id: i64) -> Result<Option<Row>> {
    let saved:Option<(String,String,String,String,Option<i64>,Option<i64>,Option<i64>,String)>=conn.query_row("SELECT evidence,title,title_key,artist_key,artist_id,album_id,duration,revision FROM matching_rows WHERE scope=?1 AND kind=?2 AND id=?3 AND removed=0",params![scope,kind,id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?))).optional().map_err(error)?;
    let Some((raw, title, title_key, artist_key, artist_id, album_id, duration, revision)) = saved
    else {
        return Ok(None);
    };
    let mut value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|_| "Invalid retained matching evidence")?;
    let object = value.as_object_mut().ok_or("Invalid matching row")?;
    for (key, value) in [
        ("kind", serde_json::json!(kind)),
        ("id", serde_json::json!(id)),
        ("title", serde_json::json!(title)),
        ("titleKey", serde_json::json!(title_key)),
        ("artistKey", serde_json::json!(artist_key)),
        ("artistId", serde_json::json!(artist_id)),
        ("albumId", serde_json::json!(album_id)),
        ("duration", serde_json::json!(duration)),
        ("revision", serde_json::json!(revision)),
    ] {
        object.insert(key.into(), value);
    }
    // Compact JSON omits optional nulls; serde Option fields restore them.
    serde_json::from_value(value)
        .map(Some)
        .map_err(|_| "Invalid retained matching row".into())
}
fn query_ids(conn: &Connection, sql: &str, args: impl rusqlite::Params) -> Result<Vec<i64>> {
    let mut query = conn.prepare_cached(sql).map_err(error)?;
    let rows = query
        .query_map(args, |r| r.get(0))
        .map_err(error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(error)?;
    Ok(rows)
}
fn identity_scheme(kind: &str, scheme: &str) -> bool {
    scheme == format!("plex:{kind}")
        || scheme
            == match kind {
                "artist" => "musicbrainz:artist",
                "album" => "musicbrainz:release",
                _ => "musicbrainz:recording",
            }
        || kind == "track" && scheme == "isrc"
}
fn typed_match(source: &Source, row: &Row) -> bool {
    source
        .identifiers
        .iter()
        .filter(|id| identity_scheme(&source.kind, &id.scheme))
        .any(|id| {
            row.identifiers
                .iter()
                .any(|other| same_identifier(id, other))
        })
}
fn same_identifier(left: &Identifier, right: &Identifier) -> bool {
    left.scheme == right.scheme
        && if left.scheme.starts_with("musicbrainz:") || left.scheme == "isrc" {
            left.value.eq_ignore_ascii_case(&right.value)
        } else {
            left.value == right.value
        }
}
fn typed_conflict(source: &Source, row: &Row) -> bool {
    source
        .identifiers
        .iter()
        .filter(|id| identity_scheme(&source.kind, &id.scheme))
        .any(|id| {
            row.identifiers
                .iter()
                .any(|other| other.scheme == id.scheme)
                && !row
                    .identifiers
                    .iter()
                    .any(|other| same_identifier(id, other))
        })
}
fn similarity(left: &str, right: &str) -> f64 {
    let a: Vec<_> = compact(left).chars().collect();
    let b: Vec<_> = compact(right).chars().collect();
    if a.is_empty() || b.is_empty() || a.len() > 256 || b.len() > 256 {
        return 0.0;
    }
    if a == b {
        return 1.0;
    }
    if a.len().min(b.len()) < 6 {
        return 0.0;
    }
    let mut previous: Vec<_> = (0..=b.len()).collect();
    for (i, a) in a.iter().enumerate() {
        let mut next = vec![i + 1];
        for (j, b) in b.iter().enumerate() {
            next.push(
                (next[j] + 1)
                    .min(previous[j + 1] + 1)
                    .min(previous[j] + usize::from(a != b)),
            )
        }
        previous = next;
    }
    1.0 - previous[b.len()] as f64 / a.len().max(b.len()) as f64
}
fn versions(value: &str) -> BTreeSet<String> {
    words(value)
        .split_whitespace()
        .map(|word| match word {
            "remixes" => "remix",
            "mixes" => "mix",
            "edits" => "edit",
            "versions" => "version",
            "remastered" | "remasters" => "remaster",
            _ => word,
        })
        .filter(|v| {
            [
                "live",
                "remix",
                "mix",
                "edit",
                "acoustic",
                "instrumental",
                "karaoke",
                "demo",
                "extended",
                "radio",
                "sped",
                "slowed",
                "nightcore",
                "mono",
                "stereo",
                "remastered",
                "remaster",
                "bootleg",
                "rework",
                "vip",
                "dub",
                "cover",
                "clean",
                "explicit",
                "version",
                "unplugged",
                "deluxe",
            ]
            .contains(v)
        })
        .map(str::to_owned)
        .collect()
}
fn compatible(source: &Source, row: &Row) -> bool {
    if typed_conflict(source, row)
        || source
            .explicit
            .zip(row.explicit)
            .is_some_and(|(a, b)| a != b)
    {
        return false;
    }
    let source_version = format!(
        "{} {} {}",
        source.title,
        source.version.as_deref().unwrap_or(""),
        source
            .album
            .as_deref()
            .filter(|_| source.kind == "track")
            .unwrap_or("")
    );
    let target_version = format!(
        "{} {} {}",
        row.title,
        row.version.as_deref().unwrap_or(""),
        row.album
            .as_deref()
            .filter(|_| source.kind == "track")
            .unwrap_or("")
    );
    // A matching typed recording ID establishes a recording, not an edition.
    if versions(&source_version) != versions(&target_version) {
        return false;
    }
    if source.kind == "track"
        && (!versions(source.album.as_deref().unwrap_or("")).is_empty()
            || !versions(row.album.as_deref().unwrap_or("")).is_empty())
        && source.album.as_ref().map(|v| words(v)) != row.album.as_ref().map(|v| words(v))
    {
        return false;
    }
    if source.kind == "track"
        && !versions(&source.title).is_empty()
        && words(&source.title) != words(&row.title)
    {
        return false;
    }
    if source.kind == "track"
        && source.duration.zip(row.duration).is_some_and(|(a, b)| {
            (a - b).abs() > 3000 || (a - b).abs() as f64 / a.min(b) as f64 > 0.02
        })
    {
        return false;
    }
    if source.kind == "album"
        && (source.year.zip(row.year).is_some_and(|(a, b)| a != b)
            || source
                .date
                .as_ref()
                .zip(row.date.as_ref())
                .is_some_and(|(a, b)| a != b)
            || source
                .release_type
                .as_ref()
                .zip(row.release_type.as_ref())
                .is_some_and(|(a, b)| words(a) != words(b)))
    {
        return false;
    }
    true
}
fn children(conn: &Connection, scope: &str, row: &Row) -> Result<(Vec<Row>, bool)> {
    let ids = if row.kind == "artist" {
        query_ids(conn,"SELECT id FROM matching_rows WHERE scope=?1 AND artist_id=?2 AND kind IN ('album','track') AND removed=0 ORDER BY kind,id LIMIT 65",params![scope,row.id])?
    } else {
        query_ids(conn,"SELECT id FROM matching_rows WHERE scope=?1 AND album_id=?2 AND kind='track' AND removed=0 ORDER BY id LIMIT 101",params![scope,row.id])?
    };
    let limit = if row.kind == "artist" { 64 } else { 100 };
    let limited = ids.len() > limit;
    let mut rows = Vec::new();
    for id in ids.into_iter().take(limit) {
        for kind in if row.kind == "artist" {
            vec!["album", "track"]
        } else {
            vec!["track"]
        } {
            if let Some(row) = load(conn, scope, kind, id)? {
                rows.push(row);
                break;
            }
        }
    }
    rows.sort_by_key(|r| (r.disc.unwrap_or(1), r.track.unwrap_or(0), r.id));
    Ok((rows, limited))
}
fn catalog_score(source: &Source, rows: &[Row]) -> usize {
    let mut distinct = HashSet::new();
    let mut score = 0;
    for example in &source.catalog {
        if rows.iter().any(|row| {
            row.kind == example.kind
                && words(&row.title) == words(&example.title)
                && !example.year.zip(row.year).is_some_and(|(a, b)| a != b)
                && !example
                    .duration
                    .zip(row.duration)
                    .is_some_and(|(a, b)| (a - b).abs() > 5000)
        }) && distinct.insert((example.kind.clone(), words(&example.title)))
        {
            score += if example.kind == "album" { 3 } else { 2 }
        }
    }
    score
}
fn rank(conn: &Connection, scope: &str, source: &Source, row: Row) -> Result<Candidate> {
    let exact_id = typed_match(source, &row);
    let names = words(&source.title) == words(&row.title);
    let performers =
        !source.artists.is_empty() && credits(&source.artists) == credits(&row.artists);
    let mut evidence = Vec::new();
    let mut score = 0.0;
    let mut verified = false;
    let parent_removed=removed_parent(conn,scope,&row)?;
    // Untitled identities still participate in membership reconciliation, but
    // even a typed identifier cannot verify their missing version/name evidence.
    if !row.title_key.is_empty() && !parent_removed && compatible(source, &row) {
        if exact_id {
            score = 100.0;
            verified = true;
            evidence.push("typed-identifier".into())
        } else if source.kind == "artist" {
            let name = similarity(&source.title, &row.title);
            if name >= 0.93 {
                let overlap = if source.catalog.is_empty() {
                    0
                } else {
                    let (children, _) = children(conn, scope, &row)?;
                    catalog_score(source, &children)
                };
                score = name * 10.0 + overlap.min(30) as f64;
                verified = names || compact(&source.title) == compact(&row.title) || overlap > 0;
                if overlap > 0 {
                    evidence.push("catalog-overlap".into())
                }
            }
        } else if names && performers {
            score = 10.0;
            if source.kind == "track" {
                verified = source.duration.zip(row.duration).is_some();
                if verified {
                    score += 2.0;
                    evidence.push("duration".into())
                }
                if source
                    .album
                    .as_ref()
                    .zip(row.album.as_ref())
                    .is_some_and(|(a, b)| words(a) == words(b))
                {
                    score += 1.0;
                    evidence.push("release-label".into())
                }
            } else {
                verified = match (&source.version, &row.version) {
                    (Some(a), Some(b)) => words(a) == words(b),
                    (None, None) => true,
                    (Some(version), None) => words(&row.title).contains(&words(version)),
                    (None, Some(version)) => words(&source.title).contains(&words(version)),
                };
                if !source.track_list.is_empty() {
                    let (children, limited) = children(conn, scope, &row)?;
                    let mut positions = HashSet::new();
                    verified = verified
                        && !limited
                        && !children.is_empty()
                        && children.len() <= source.track_list.len()
                        && children.iter().all(|row| {
                            let positions_matching: Vec<_> = source
                                .track_list
                                .iter()
                                .enumerate()
                                .filter(|(index, item)| {
                                    words(&row.title) == words(&item.title)
                                        && !item
                                            .duration
                                            .zip(row.duration)
                                            .is_some_and(|(a, b)| (a - b).abs() > 3000)
                                        && !(row.disc.unwrap_or(1) == 1
                                            && row.track.is_some_and(|position| {
                                                position != *index as i64 + 1
                                            }))
                                })
                                .map(|(index, _)| index)
                                .collect();
                            positions_matching.len() == 1 && positions.insert(positions_matching[0])
                        });
                    if verified {
                        score += 5.0;
                        evidence.push(
                            if children.len() == source.track_list.len() {
                                "track-list"
                            } else {
                                "track-list-subset"
                            }
                            .into(),
                        )
                    }
                }
            }
        }
        if names {
            evidence.push("title".into())
        }
        if performers {
            evidence.push("credits".into())
        }
    }
    Ok(Candidate {
        row,
        score,
        verified,
        evidence,
    })
}
fn removed_parent(conn:&Connection,scope:&str,row:&Row)->Result<bool> {
    if row.kind=="artist" {return Ok(false)}
    conn.query_row("SELECT EXISTS(SELECT 1 FROM matching_rows WHERE scope=?1 AND removed=1 AND ((kind='artist' AND id=?2) OR (kind='album' AND id=?3)))",params![scope,row.artist_id,row.album_id],|r|r.get(0)).map_err(error)
}
#[derive(Serialize)]
pub struct Entry {pub id:i64,pub state:String,pub row:Option<Row>}
pub fn entries(conn:&Connection,scope:&str,kind:&str,ids:&[i64])->Result<Vec<Entry>> {
    if !["artist","album","track"].contains(&kind)||ids.len()>64||ids.iter().any(|id|*id<=0) {return Err("Invalid matching metadata batch".into())}
    let mut entries=Vec::new();
    for id in ids {
        let row=load(conn,scope,kind,*id)?;
        let state=if let Some(row)=&row {if removed_parent(conn,scope,row)? {"removed"}else{"active"}}else {
            if conn.query_row("SELECT removed FROM matching_rows WHERE scope=?1 AND kind=?2 AND id=?3",params![scope,kind,id],|r|r.get::<_,bool>(0)).optional().map_err(error)?.unwrap_or(false){"removed"}else{"unknown"}
        };
        entries.push(Entry{id:*id,state:state.into(),row});
    }
    Ok(entries)
}
fn coverage(conn: &Connection, scope: &str, kind: &str) -> Result<String> {
    // A complete membership census is not complete matching evidence when Plex
    // has unnamed items. Use the existing scoped name index to keep this bounded
    // and preserve remote fallback instead of declaring authoritative absence.
    let unnamed: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM matching_rows WHERE scope=?1 AND kind=?2 AND title_key='' AND removed=0)",
        params![scope, kind], |row| row.get(0),
    ).map_err(error)?;
    if unnamed {
        return Ok("incomplete".into());
    }
    let state:Option<(String,Option<i64>,i64)>=conn.query_row("SELECT phase,completed,coalesce((SELECT last_checked FROM matching_refresh r WHERE r.scope=t.scope AND r.kind=t.kind),0) FROM matching_tasks t WHERE scope=?1 AND kind=?2",params![scope,kind],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(error)?;
    Ok(match state {
        Some((phase, Some(at), _)) if phase == "complete" && store::now() - at < 86400000 => {
            "complete"
        }
        Some((phase, Some(_), _)) if phase == "complete" => "stale",
        _ => "incomplete",
    }
    .into())
}
fn revision(conn: &Connection, scope: &str) -> Result<i64> {
    conn.query_row(
        "SELECT revision FROM matching_scopes WHERE scope=?1",
        [scope],
        |r| r.get(0),
    )
    .map_err(error)
}
fn row_revision(conn: &Connection, scope: &str, kind: &str, id: i64) -> Result<Option<String>> {
    conn.query_row(
        "SELECT revision FROM matching_rows WHERE scope=?1 AND kind=?2 AND id=?3 AND removed=0",
        params![scope, kind, id],
        |r| r.get(0),
    )
    .optional()
    .map_err(error)
}
fn dependency(conn: &Connection, scope: &str, kind: &str, id: i64) -> Result<Dependency> {
    Ok(Dependency {
        kind: kind.into(),
        id,
        revision: row_revision(conn, scope, kind, id)?,
        relationship: relationship_revision(conn, scope, kind, id)?,
    })
}
fn relationship_revision(conn: &Connection, scope: &str, kind: &str, id: i64) -> Result<i64> {
    Ok(conn
        .query_row(
            "SELECT revision FROM matching_relationships WHERE scope=?1 AND kind=?2 AND id=?3",
            params![scope, kind, id],
            |r| r.get(0),
        )
        .optional()
        .map_err(error)?
        .unwrap_or(0))
}
fn retrieve(
    conn: &Connection,
    scope: &str,
    owner: &str,
    source: &Source,
    hash: &str,
    revision: i64,
    coverage: &str,
) -> Result<Option<Resolution>> {
    let saved:Option<(String,String,i64,String,i64,i64)>=conn.query_row("SELECT fingerprint,proof,revision,coverage,expires,algorithm FROM matching_associations WHERE scope=?1 AND source_owner=?2 AND source_kind=?3 AND source_id=?4",params![scope,owner,source.kind,source.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional().map_err(error)?;
    let Some((fingerprint, raw, old_revision, old_coverage, expires, algorithm)) = saved else {
        return Ok(None);
    };
    if fingerprint != hash
        || expires < store::now()
        || algorithm != ALGORITHM
        || coverage != old_coverage
    {
        return Ok(None);
    }
    let Ok(mut proof) = serde_json::from_str::<Proof>(&raw) else {
        return Ok(None);
    };
    // Negative/limited proofs are short-lived and expire on any coverage/content
    // revision. Positive proofs additionally validate all parent dependencies.
    if old_revision != revision {
        if proof.result.status != "matched" {
            return Ok(None);
        }
        let oldest: Option<i64> = conn
            .query_row(
                "SELECT min(sequence) FROM matching_changes WHERE scope=?1",
                [scope],
                |r| r.get(0),
            )
            .map_err(error)?;
        if oldest.is_none_or(|v| v > old_revision + 1) {
            return Ok(None);
        }
        let affected:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM matching_changes c JOIN matching_rows r ON r.scope=c.scope AND r.kind=c.kind AND r.id=c.id WHERE c.scope=?1 AND c.sequence>?2 AND (r.kind=?3 AND (r.title_key=?4 OR replace(r.title_key,' ','')=?5 OR (?3='artist' AND substr(replace(r.title_key,' ',''),1,4)=substr(?5,1,4)))))",params![scope,old_revision,source.kind,row::key(&source.title),row::key(&source.title).replace(' ',"")],|r|r.get(0)).map_err(error)?;
        if affected {
            return Ok(None);
        }
    }
    for dep in &proof.dependencies {
        if row_revision(conn, scope, &dep.kind, dep.id)? != dep.revision
            || relationship_revision(conn, scope, &dep.kind, dep.id)? != dep.relationship
        {
            return Ok(None);
        }
    }
    for candidate in proof.candidates {
        let Some(row) = load(conn, scope, &candidate.kind, candidate.id)? else {
            return Ok(None);
        };
        proof.result.candidates.push(Candidate {
            row,
            score: candidate.score,
            verified: candidate.verified,
            evidence: candidate.evidence,
        });
    }
    proof.result.cached = true;
    proof.result.revision = revision;
    Ok(Some(proof.result))
}
pub fn resolve(
    conn: &Connection,
    scope: &str,
    owner: &str,
    source: &Source,
    force: bool,
) -> Result<Resolution> {
    resolve_confirmed(conn, scope, owner, source, force, false, false)
}
pub fn reverse(
    conn: &Connection,
    scope: &str,
    owner: &str,
    kind: &str,
    id: i64,
) -> Result<Vec<Source>> {
    if !["artist", "album", "track"].contains(&kind)
        || id <= 0
        || owner.is_empty()
        || owner.len() > 256
    {
        return Err("Invalid reverse association lookup".into());
    }
    let mut query=conn.prepare("SELECT source FROM matching_associations WHERE scope=?1 AND source_owner=?2 AND source_kind=?3 AND outcome='matched' AND json_valid(proof) AND json_extract(proof,'$.result.selected')=?4 ORDER BY checked DESC LIMIT 8").map_err(error)?;
    let sources = query
        .query_map(params![scope, owner, kind, id], |r| r.get::<_, String>(0))
        .map_err(error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(error)?;
    let mut matches = Vec::new();
    for raw in sources {
        if let Ok(source) = serde_json::from_str::<Source>(&raw) {
            if !source.id.starts_with("ytmusic:") {
                continue;
            }
            let result = resolve(conn, scope, owner, &source, false)?;
            if result.status == "matched" && result.selected == Some(id) {
                matches.push(source)
            }
        }
    }
    Ok(matches)
}
pub fn resolve_confirmed(
    conn: &Connection,
    scope: &str,
    owner: &str,
    source: &Source,
    force: bool,
    query_complete: bool,
    query_limited: bool,
) -> Result<Resolution> {
    validate(source)?;
    if owner.len() > 256 || owner.is_empty() {
        return Err("Invalid association owner".into());
    }
    store::ensure_scope(conn, scope)?;
    let revision = revision(conn, scope)?;
    let coverage = coverage(conn, scope, &source.kind)?;
    let hash = fingerprint(source)?;
    if !force {
        if let Some(saved) = retrieve(conn, scope, owner, source, &hash, revision, &coverage)? {
            return Ok(saved);
        }
    }
    let mut ids = BTreeSet::new();
    let mut limited = query_limited;
    for identifier in source
        .identifiers
        .iter()
        .filter(|v| identity_scheme(&source.kind, &v.scheme))
    {
        let value = if identifier.scheme.starts_with("musicbrainz:") {
            identifier.value.to_lowercase()
        } else if identifier.scheme == "isrc" {
            identifier.value.to_uppercase()
        } else {
            identifier.value.clone()
        };
        let found=query_ids(conn,"SELECT m.id FROM matching_identifiers i JOIN matching_rows m ON m.scope=i.scope AND m.kind=i.kind AND m.id=i.id WHERE i.scope=?1 AND i.kind=?2 AND i.scheme=?3 AND i.value=?4 AND m.removed=0 LIMIT 65",params![scope,source.kind,identifier.scheme,value])?;
        limited |= found.len() > CANDIDATES;
        ids.extend(found.into_iter().take(CANDIDATES));
    }
    let key = row::key(&source.title);
    let mut artist_keys: Vec<_> = source.artists.iter().map(|name| row::key(name)).collect();
    artist_keys.sort();
    artist_keys.dedup();
    let found = if source.kind != "artist" && !artist_keys.is_empty() {
        query_ids(conn,"SELECT id FROM matching_rows WHERE scope=?1 AND kind=?2 AND title_key=?3 AND artist_key=?4 AND removed=0 ORDER BY id LIMIT 65",params![scope,source.kind,key,artist_keys.join("; ")])?
    } else {
        query_ids(conn,"SELECT id FROM matching_rows WHERE scope=?1 AND kind=?2 AND replace(title_key,' ','')=?3 AND removed=0 ORDER BY id LIMIT 65",params![scope,source.kind,key.replace(' ',"")])?
    };
    limited |= found.len() > CANDIDATES;
    ids.extend(found.into_iter().take(CANDIDATES));
    // FTS handles candidate discovery only. Literal quoted tokens prevent query
    // syntax in provider labels; prefixes help spaced names and close spellings.
    let tokens: Vec<_> = key.split_whitespace().take(8).collect();
    if !tokens.is_empty() && ids.len() < CANDIDATES && (ids.is_empty() || source.kind == "artist") {
        let query = tokens
            .iter()
            .map(|token| {
                format!(
                    "\"{}\"*",
                    token
                        .chars()
                        .take(if source.kind == "artist" { 4 } else { 64 })
                        .collect::<String>()
                )
            })
            .collect::<Vec<_>>()
            .join(" AND ");
        let found=query_ids(conn,"SELECT id FROM matching_fts WHERE matching_fts MATCH ?1 AND scope=?2 AND kind=?3 ORDER BY rank LIMIT 65",params![query,scope,source.kind])?;
        limited |= found.len() > CANDIDATES;
        ids.extend(found.into_iter().take(CANDIDATES));
    }
    limited |= ids.len() > CANDIDATES;
    let mut candidates = Vec::new();
    for id in ids.into_iter().take(CANDIDATES) {
        if let Some(row) = load(conn, scope, &source.kind, id)? {
            let candidate = rank(conn, scope, source, row)?;
            if candidate.score > 0.0 {
                candidates.push(candidate)
            }
        }
    }
    candidates.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.row.id.cmp(&b.row.id)));
    let verified: Vec<_> = candidates.iter().filter(|c| c.verified).collect();
    let selected = if limited {
        None
    } else if verified.len() == 1 {
        Some(verified[0].row.id)
    } else if source.kind == "track" {
        let same: Vec<_> = verified
            .iter()
            .filter(|c| {
                source
                    .album
                    .as_ref()
                    .zip(c.row.album.as_ref())
                    .is_some_and(|(a, b)| words(a) == words(b))
            })
            .collect();
        (same.len() == 1).then(|| same[0].row.id)
    } else if source.kind == "artist"
        && verified.len() > 1
        && verified[0].score - verified[1].score >= 2.0
        && !source.catalog.is_empty()
    {
        Some(verified[0].row.id)
    } else {
        None
    };
    let source_complete = source.kind == "artist"
        || source
            .identifiers
            .iter()
            .any(|id| identity_scheme(&source.kind, &id.scheme))
        || !source.artists.is_empty() && (source.kind == "album" || source.duration.is_some());
    let status = if !source_complete {
        "incomplete"
    } else if limited {
        "limited"
    } else if selected.is_some()
        && (coverage == "complete"
            || query_complete
            || verified
                .iter()
                .any(|c| Some(c.row.id) == selected && typed_match(source, &c.row)))
    {
        "matched"
    } else if verified.len() > 1 {
        "ambiguous"
    } else if coverage != "complete" {
        coverage.as_str()
    } else if !candidates.is_empty() {
        "candidate"
    } else {
        "missing"
    };
    let recording_identity = if source.kind == "track" {
        source
            .identifiers
            .iter()
            .chain(
                candidates
                    .iter()
                    .filter(|c| Some(c.row.id) == selected)
                    .flat_map(|c| c.row.identifiers.iter()),
            )
            .find(|id| id.scheme == "musicbrainz:recording")
            .map(|id| format!("{}:{}", id.scheme, id.value))
    } else {
        None
    };
    let result = Resolution {
        source_id: source.id.clone(),
        status: status.into(),
        selected: if status == "matched" { selected } else { None },
        recording_identity,
        coverage,
        revision,
        candidates: candidates.into_iter().take(24).collect(),
        cached: false,
        limited,
    };
    let mut dependencies = Vec::new();
    let mut seen = HashSet::new();
    for candidate in &result.candidates {
        for (kind, id) in [
            (candidate.row.kind.as_str(), Some(candidate.row.id)),
            ("artist", candidate.row.artist_id),
            ("album", candidate.row.album_id),
        ] {
            if let Some(id) = id {
                if seen.insert((kind.to_owned(), id)) {
                    dependencies.push(dependency(conn, scope, kind, id)?);
                }
            }
        }
    }
    let mut compact = result.clone();
    compact.candidates.clear();
    let raw = serde_json::to_string(&Proof {
        result: compact,
        candidates: result
            .candidates
            .iter()
            .map(|c| CandidateRef {
                kind: c.row.kind.clone(),
                id: c.row.id,
                score: c.score,
                verified: c.verified,
                evidence: c.evidence.clone(),
            })
            .collect(),
        dependencies,
    })
    .map_err(|_| "Invalid matching proof")?;
    conn.execute("INSERT INTO matching_associations(scope,source_owner,source_kind,source_id,fingerprint,algorithm,source,outcome,proof,revision,coverage,checked,expires) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ON CONFLICT(scope,source_owner,source_kind,source_id) DO UPDATE SET fingerprint=excluded.fingerprint,algorithm=excluded.algorithm,source=excluded.source,outcome=excluded.outcome,proof=excluded.proof,revision=excluded.revision,coverage=excluded.coverage,checked=excluded.checked,expires=excluded.expires",params![scope,owner,source.kind,source.id,hash,ALGORITHM,serde_json::to_string(source).map_err(|_|"Invalid matching source")?,result.status,raw,revision,result.coverage,store::now(),store::now()+if result.status=="matched" {86400000}else{60000}]).map_err(error)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const S: &str = "resolver-fixture";
    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        store::ensure_scope(&conn, S).unwrap();
        conn
    }
    fn source(kind: &str, title: &str) -> Source {
        serde_json::from_value(json!({"id":"ytmusic:original","kind":kind,"title":title,"artists":["Artist"],"duration":180000,"album":"Album"})).unwrap()
    }
    fn row(kind: &str, id: i64, title: &str) -> Row {
        row::parse(&json!({"type":kind,"ratingKey":id,"title":title,"librarySectionID":4,"parentRatingKey":if kind=="album"{1}else{2},"grandparentRatingKey":1,"parentTitle":if kind=="album"{"Artist"}else{"Album"},"grandparentTitle":"Artist","duration":180000}),kind,4).unwrap()
    }
    fn put(conn: &Connection, row: &Row) {
        let mut row = row.clone();
        row.revision.clear();
        row.revision = hex::encode(Sha256::digest(serde_json::to_vec(&row).unwrap()));
        store::upsert(conn, S, &row, store::now()).unwrap();
    }
    fn complete(conn: &Connection, kind: &str) {
        store::begin(conn, S, kind, 0).unwrap();
        conn.execute(
            "UPDATE matching_tasks SET phase='complete',completed=?3 WHERE scope=?1 AND kind=?2",
            params![S, kind, store::now()],
        )
        .unwrap();
    }
    fn lookup(conn: &Connection, source: &Source) -> Resolution {
        resolve(conn, S, "ytm-account", source, false).unwrap()
    }

    #[test]
    fn rows_round_trip_without_repeating_compact_columns_and_proofs_survive_restart() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("index.db");
        let conn = Connection::open(&path).unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        store::ensure_scope(&conn, S).unwrap();
        let original = row("track", 7, "Song");
        put(&conn, &original);
        complete(&conn, "track");
        assert_eq!(load(&conn, S, "track", 7).unwrap().unwrap(), original);
        let input = source("track", "Song");
        let first = lookup(&conn, &input);
        assert_eq!(first.status, "matched");
        assert_eq!(first.selected, Some(7));
        assert!(!first.cached);
        let proof: String = conn
            .query_row(
                "SELECT proof FROM matching_associations WHERE scope=?1",
                [S],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!proof.contains("titleKey"));
        assert!(!proof.contains("artistKey"));
        assert!(!proof.contains("\"duration\":"));
        drop(conn);
        let conn = Connection::open(&path).unwrap();
        let cached = lookup(&conn, &input);
        assert!(cached.cached);
        assert_eq!(cached.source_id, "ytmusic:original");
        assert_eq!(cached.candidates[0].row.id, 7);
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT count(*) FROM matching_associations", [], |r| r
                .get(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn collaboration_versions_explicit_and_duration_are_identity_fences() {
        let conn = db();
        complete(&conn, "track");
        let input = source("track", "Song");
        let mut wrong = row("track", 7, "Song");
        wrong.artists = vec!["Other artist".into()];
        put(&conn, &wrong);
        assert_ne!(lookup(&conn, &input).status, "matched");
        let mut source = input.clone();
        source.artists = vec!["Artist".into(), "Guest".into()];
        let mut collaboration = row("track", 8, "Song");
        collaboration.artists = vec!["Guest".into(), "Artist".into()];
        put(&conn, &collaboration);
        assert_eq!(lookup(&conn, &source).selected, Some(8));
        for mut changed in [
            source.clone(),
            source.clone(),
            source.clone(),
            source.clone(),
        ]
        .into_iter()
        .enumerate()
        {
            match changed.0 {
                0 => changed.1.title = "Song (Live)".into(),
                1 => changed.1.duration = Some(190000),
                2 => changed.1.explicit = Some(true),
                _ => changed.1.artists = vec!["Artist".into(), "Different guest".into()],
            }
            collaboration.explicit = Some(false);
            put(&conn, &collaboration);
            assert_ne!(lookup(&conn, &changed.1).status, "matched");
        }
    }

    #[test]
    fn folded_non_latin_candidate_keys_do_not_prove_identity_and_homonyms_remain_ambiguous() {
        let conn = db();
        complete(&conn, "artist");
        put(&conn, &row("artist", 1, "はな"));
        assert_ne!(lookup(&conn, &source("artist", "ばな")).status, "matched");
        put(&conn, &row("artist", 2, "Aron Chupa"));
        assert_eq!(
            lookup(&conn, &source("artist", "AronChupa")).selected,
            Some(2)
        );
        put(&conn, &row("artist", 3, "Aron Chupa"));
        assert_eq!(
            lookup(&conn, &source("artist", "AronChupa")).status,
            "ambiguous"
        );
        assert_eq!(lookup(&conn, &source("artist", "AronChupa")).selected, None);
    }

    #[test]
    fn release_editions_dates_and_track_lists_do_not_collapse() {
        let conn = db();
        complete(&conn, "album");
        let mut album = row("album", 2, "Album");
        album.year = Some(2024);
        put(&conn, &album);
        let mut input = source("album", "Album");
        input.year = Some(2025);
        assert_ne!(lookup(&conn, &input).status, "matched");
        input.year = Some(2024);
        assert_eq!(lookup(&conn, &input).selected, Some(2));
        input.track_list = vec![Example {
            title: "Missing".into(),
            kind: "track".into(),
            duration: Some(180000),
            year: None,
        }];
        assert_ne!(lookup(&conn, &input).status, "matched");
        let mut track = row("track", 7, "Missing");
        track.track = Some(1);
        put(&conn, &track);
        assert_eq!(lookup(&conn, &input).selected, Some(2));
        input.track_list.push(Example {
            title: "Extra YTM song".into(),
            kind: "track".into(),
            duration: Some(180000),
            year: None,
        });
        let subset = lookup(&conn, &input);
        assert_eq!(subset.selected, Some(2));
        assert!(subset.candidates[0]
            .evidence
            .contains(&"track-list-subset".into()));
        album.version = Some("Japanese Edition".into());
        put(&conn, &album);
        assert_ne!(lookup(&conn, &input).status, "matched");
        input.title = "Album (Deluxe)".into();
        assert_ne!(lookup(&conn, &input).status, "matched");
    }

    #[test]
    fn partial_misses_are_not_absence_and_new_rows_retire_negative_proofs() {
        let conn = db();
        let input = source("track", "Song");
        assert_eq!(lookup(&conn, &input).status, "incomplete");
        assert!(lookup(&conn, &input).cached);
        complete(&conn, "track");
        assert_eq!(lookup(&conn, &input).status, "missing");
        put(&conn, &row("track", 7, "Song"));
        let found = lookup(&conn, &input);
        assert_eq!(found.selected, Some(7));
        assert!(!found.cached);
        assert!(lookup(&conn, &input).cached);
        // An unrelated track outside this relationship does not evict the proof.
        let mut other = row("track", 9, "Unrelated");
        other.artist_id = Some(99);
        other.album_id = Some(98);
        put(&conn, &other);
        assert!(lookup(&conn, &input).cached);
        let mut changed = row("track", 7, "Rematched (Live)");
        changed.artist_id = Some(10);
        changed.album_id = Some(20);
        put(&conn, &changed);
        let lost = lookup(&conn, &input);
        assert!(!lost.cached);
        assert_ne!(lost.status, "matched");
        let old_parent:i64=conn.query_row("SELECT revision FROM matching_relationships WHERE scope=?1 AND kind='album' AND id=2",[S],|r|r.get(0)).unwrap();
        assert!(old_parent >= 2);
    }

    #[test]
    fn copies_are_separate_items_and_typed_recording_ids_never_become_edition_ids() {
        let conn = db();
        complete(&conn, "track");
        let mut input = source("track", "Song");
        let mut one = row("track", 7, "Song");
        let mut two = row("track", 8, "Song");
        let id = Identifier {
            scheme: "musicbrainz:recording".into(),
            value: "12345678-1234-1234-1234-123456789012".into(),
        };
        one.identifiers = vec![id.clone()];
        two.identifiers = vec![id.clone()];
        input.identifiers = vec![id];
        put(&conn, &one);
        put(&conn, &two);
        let result = lookup(&conn, &input);
        assert_eq!(result.status, "ambiguous");
        assert_eq!(result.candidates.len(), 2);
        assert_eq!(result.selected, None);
        two.album = Some("Other album".into());
        two.album_id = Some(3);
        two.revision = "copy-revision".into();
        put(&conn, &two);
        let result = lookup(&conn, &input);
        assert_eq!(result.selected, Some(7));
        assert!(result
            .recording_identity
            .unwrap()
            .starts_with("musicbrainz:recording:"));
        input.title = "Totally different".into();
        input.identifiers[0].scheme = "musicbrainz:untyped".into();
        assert_ne!(lookup(&conn, &input).status, "matched");
    }

    #[test]
    fn query_limits_scope_and_parent_revisions_remain_explicit() {
        let conn = db();
        complete(&conn, "artist");
        let input = source("artist", "Artist");
        put(&conn, &row("artist", 1, "Artist"));
        assert_eq!(lookup(&conn, &input).selected, Some(1));
        assert!(lookup(&conn, &input).cached);
        put(&conn, &row("track", 7, "New child"));
        assert!(!lookup(&conn, &input).cached);
        let other = resolve(&conn, "other-scope", "ytm-account", &input, false).unwrap();
        assert_eq!(other.status, "incomplete");
        assert!(other.candidates.is_empty());
        for id in 2..=70 {
            put(&conn, &row("artist", id, "Artist"));
        }
        let result = lookup(&conn, &input);
        assert_eq!(result.status, "limited");
        assert_eq!(result.selected, None);
        assert!(result.candidates.len() <= 24);
        let mut invalid = input.clone();
        invalid.artists = vec!["x".repeat(300)];
        assert!(validate(&invalid).is_err());
    }
    #[test]
    fn reverse_proofs_revalidate_deleted_targets_and_source_accounts() {
        let conn = db();
        complete(&conn, "track");
        let input = source("track", "Song");
        put(&conn, &row("track", 7, "Song"));
        assert_eq!(lookup(&conn, &input).selected, Some(7));
        assert_eq!(
            reverse(&conn, S, "ytm-account", "track", 7).unwrap()[0].id,
            "ytmusic:original"
        );
        assert!(reverse(&conn, S, "other-account", "track", 7)
            .unwrap()
            .is_empty());
        conn.execute(
            "UPDATE matching_rows SET removed=1 WHERE scope=?1 AND kind='track' AND id=7",
            [S],
        )
        .unwrap();
        store::changed_row(&conn, S, "track", 7).unwrap();
        assert!(reverse(&conn, S, "ytm-account", "track", 7)
            .unwrap()
            .is_empty());
        assert_eq!(lookup(&conn, &input).status, "missing");
    }
    #[test]
    fn complete_bounded_fallback_can_verify_partial_coverage_but_truncation_cannot() {
        let conn = db();
        let input = source("track", "Song");
        put(&conn, &row("track", 7, "Song"));
        assert_eq!(lookup(&conn, &input).status, "incomplete");
        let confirmed =
            resolve_confirmed(&conn, S, "ytm-account", &input, true, true, false).unwrap();
        assert_eq!(confirmed.selected, Some(7));
        assert_eq!(confirmed.coverage, "incomplete");
        assert!(lookup(&conn, &input).cached);
        let limited =
            resolve_confirmed(&conn, S, "ytm-account", &input, true, false, true).unwrap();
        assert_eq!(limited.status, "limited");
        assert_eq!(limited.selected, None);
        let saved = lookup(&conn, &input);
        assert!(saved.cached);
        assert_eq!(saved.status, "limited");
    }
    #[test]
    fn exact_recording_candidates_are_not_limited_by_unrelated_title_prefixes() {
        let conn = db();
        complete(&conn, "track");
        put(&conn, &row("track", 7, "Song 7"));
        for id in 70..=170 {
            put(&conn, &row("track", id, &format!("Song 7{id}")));
        }
        let result = lookup(&conn, &source("track", "Song 7"));
        assert_eq!(result.selected, Some(7));
        assert!(!result.limited);
    }
    #[test]
    fn incomplete_source_evidence_cannot_be_reported_as_confirmed_absence() {
        let conn = db();
        complete(&conn, "track");
        let mut input = source("track", "Song");
        input.artists.clear();
        input.duration = None;
        let result = lookup(&conn, &input);
        assert_eq!(result.status, "incomplete");
        assert_eq!(result.coverage, "complete");
        assert_eq!(result.selected, None);
    }
    #[test]
    fn unnamed_membership_cannot_verify_identifiers_or_authoritative_absence() {
        let conn = db();
        complete(&conn, "track");
        let mut target = row("track", 7, "...");
        let identifier = Identifier { scheme: "musicbrainz:recording".into(),
            value: "22222222-2222-4222-8222-222222222222".into() };
        target.identifiers.push(identifier.clone());
        put(&conn, &target);
        let mut input = source("track", "Song");
        input.identifiers.push(identifier);
        let result = resolve_confirmed(&conn, S, "ytm-account", &input, true, true, false).unwrap();
        assert_eq!(result.coverage, "incomplete");
        assert_eq!(result.status, "incomplete");
        assert_eq!(result.selected, None);
        assert!(result.candidates.is_empty());
        assert_eq!(entries(&conn, S, "track", &[7]).unwrap()[0].state, "active");

        // A version-1 typed-ID proof could have selected this row while census
        // coverage was already incomplete. Unchanged coverage/dependencies must
        // not keep that older, more permissive selection alive after upgrade.
        conn.execute("UPDATE matching_associations SET algorithm=1,outcome='matched',proof=json_set(proof,'$.result.status','matched','$.result.selected',7) WHERE scope=?1", [S]).unwrap();
        let upgraded = lookup(&conn, &input);
        assert!(!upgraded.cached);
        assert_eq!(upgraded.status, "incomplete");
        assert_eq!(upgraded.selected, None);

        // Once a targeted refresh supplies the missing name, both coverage and
        // the old negative proof are re-evaluated without rebuilding membership.
        target.title = "Song".into();
        target.title_key = "song".into();
        put(&conn, &target);
        let restored = lookup(&conn, &input);
        assert!(!restored.cached);
        assert_eq!(restored.coverage, "complete");
        assert_eq!(restored.selected, Some(7));
    }
    #[test]
    fn version_qualifiers_in_release_labels_cannot_select_other_remixes() {
        let conn = db();
        complete(&conn, "track");
        let mut target = row("track", 7, "Song");
        target.album = Some("Song (Bob Remix)".into());
        put(&conn, &target);
        let mut input = source("track", "Song");
        input.album = Some("Song (Alice Remix)".into());
        assert_ne!(lookup(&conn, &input).status, "matched");
        input.album = Some("Song (Remixes)".into());
        target.album = Some("Album".into());
        put(&conn, &target);
        assert_ne!(lookup(&conn, &input).status, "matched");
    }
    #[test]
    fn common_titles_are_narrowed_by_credited_artists_before_candidate_limits() {
        let conn = db();
        complete(&conn, "track");
        put(&conn, &row("track", 7, "Intro"));
        for id in 70..=170 {
            let mut other = row("track", id, "Intro");
            other.artists = vec![format!("Other {id}")];
            other.artist_key = format!("other {id}");
            put(&conn, &other);
        }
        let result = lookup(&conn, &source("track", "Intro"));
        assert_eq!(result.selected, Some(7));
        assert!(!result.limited);
    }
    #[test]
    fn known_removed_parents_cannot_be_reverified_from_a_retained_child() {
        let conn = db();
        complete(&conn, "track");
        put(&conn, &row("artist", 1, "Artist"));
        put(&conn, &row("album", 2, "Album"));
        put(&conn, &row("track", 7, "Song"));
        let input = source("track", "Song");
        assert_eq!(lookup(&conn, &input).selected, Some(7));
        conn.execute(
            "UPDATE matching_rows SET removed=1 WHERE scope=?1 AND kind='artist' AND id=1",
            [S],
        )
        .unwrap();
        store::changed_row(&conn, S, "artist", 1).unwrap();
        assert_eq!(lookup(&conn, &input).selected, None);
        put(&conn, &row("artist", 1, "Artist"));
        assert_eq!(lookup(&conn, &input).selected, Some(7));
    }
    #[test]
    fn typed_recordings_use_their_index_without_promoting_release_or_generic_mbids() {
        let conn = db();
        let mut target = row("track", 7, "Song");
        let recording = Identifier {
            scheme: "musicbrainz:recording".into(),
            value: "12345678-1234-1234-abcd-123456789012".into(),
        };
        target.identifiers = vec![recording.clone()];
        put(&conn, &target);
        let mut input = source("track", "Different source label");
        input.duration = None;
        input.identifiers = vec![Identifier {
            value: recording.value.to_uppercase(),
            ..recording
        }];
        let found = lookup(&conn, &input);
        assert_eq!(found.status, "matched");
        assert_eq!(found.selected, Some(7));
        assert_eq!(found.coverage, "incomplete");
        input.identifiers[0].scheme = "musicbrainz:release".into();
        assert_eq!(lookup(&conn, &input).selected, None);
        input.identifiers[0].scheme = "musicbrainz:untyped".into();
        assert_eq!(lookup(&conn, &input).selected, None);
    }
    #[test]
    fn targeted_change_pages_preserve_atomic_relationship_groups_and_reset_old_cursors() {
        let conn = db();
        for id in 1..=150 {
            put(&conn, &row("track", id, "Song"));
        }
        let mut cursor = 0;
        let mut events = Vec::new();
        loop {
            let page = store::changes(&conn, S, cursor).unwrap();
            assert!(!page.reset);
            assert!(page.changes.len() <= 200);
            events.extend(page.changes);
            cursor = page.cursor;
            if cursor == page.revision {
                break;
            }
        }
        assert_eq!(events.iter().filter(|row| row.kind == "track").count(), 150);
        for sequence in 1..=150 {
            assert_eq!(
                events.iter().filter(|row| row.sequence == sequence).count(),
                3
            )
        }
        conn.execute(
            "DELETE FROM matching_changes WHERE scope=?1 AND sequence<100",
            [S],
        )
        .unwrap();
        assert!(store::changes(&conn, S, 1).unwrap().reset);
    }
}
