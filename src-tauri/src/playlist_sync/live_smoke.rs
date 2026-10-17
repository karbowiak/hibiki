//! Explicit ignored QA entrypoint. Never invoked by the app or ordinary tests.
//! Preparation is read-only. Execution requires root-reviewed manifest/run UUID.
use super::*;
use crate::plex::{PlexClient, PlexClientConfig, PlexSettings};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

fn recording_ref(value: &str) -> Option<String> {
    let raw = value
        .strip_prefix("musicbrainz://recording/")
        .or_else(|| value.strip_prefix("https://musicbrainz.org/recording/"))?;
    canonical_mbid(raw).ok()
}
fn guid(item: &Value) -> Option<String> {
    let mut values = std::collections::BTreeSet::new();
    if let Some(value) = item
        .get("guid")
        .and_then(Value::as_str)
        .and_then(recording_ref)
    {
        values.insert(value);
    }
    if let Some(array) = item.get("Guid").and_then(Value::as_array) {
        for entry in array.iter().take(32) {
            if let Some(value) = entry
                .get("id")
                .and_then(Value::as_str)
                .and_then(recording_ref)
            {
                values.insert(value);
            }
        }
    }
    if values.len() == 1 {
        values.into_iter().next()
    } else {
        None
    }
}
fn binding(settings: &PlexSettings) -> String {
    let values = json!([
        settings.base_url,
        settings.token,
        settings.machine_identifier,
        settings.section_id,
        settings.section_uuid,
        settings.tls_exceptions,
        settings.listenbrainz_username,
        settings.listenbrainz_auth_revision,
        settings.listenbrainz_token
    ]);
    hex::encode(Sha256::digest(values.to_string().as_bytes()))
}
fn current(config: &Path, expected: &str) -> Result<()> {
    let settings = crate::plex::load_settings(config)
        .map_err(|_| anyhow::anyhow!("QA settings unavailable"))?;
    if binding(&settings) != expected {
        bail!("QA connection changed; all writes stopped")
    };
    Ok(())
}
fn private_write(path: &Path, value: &Value) -> Result<()> {
    use std::io::Write;
    let directory = path.parent().context("QA manifest directory missing")?;
    let mut file = tempfile::NamedTempFile::new_in(directory)?;
    file.write_all(serde_json::to_string_pretty(value)?.as_bytes())?;
    file.as_file().sync_all()?;
    let temporary = file.into_temp_path();
    std::fs::rename(&temporary, path)?;
    #[cfg(unix)]
    std::fs::File::open(directory)?.sync_all()?;
    Ok(())
}
fn qa_directory(run: &str) -> Result<PathBuf> {
    let uuid = canonical_mbid(run)?;
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".tmp/linked-sync-live");
    std::fs::create_dir_all(&base)?;
    let target = base.join(uuid);
    if !target.exists() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new().mode(0o700).create(&target)?;
        }
        #[cfg(not(unix))]
        std::fs::create_dir(&target)?;
    }
    let metadata = std::fs::symlink_metadata(&target)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        bail!("Invalid QA directory")
    }
    Ok(target)
}
fn client(settings: &PlexSettings) -> Result<PlexClient> {
    if settings.token.is_empty()
        || settings.machine_identifier.is_empty()
        || settings.section_id <= 0
        || settings.section_uuid.is_empty()
    {
        bail!("Connect a verified Plex music library before QA")
    }
    let origin = url::Url::parse(&settings.base_url)
        .map_err(|_| anyhow::anyhow!("Invalid QA server configuration"))?
        .origin()
        .ascii_serialization();
    let mut client = PlexClient::new(PlexClientConfig {
        base_url: settings.base_url.clone(),
        token: settings.token.clone(),
        client_id: settings.client_id.clone(),
        accept_invalid_certs: settings.tls_exceptions.contains(&origin),
        ..Default::default()
    })
    .map_err(|_| anyhow::anyhow!("QA client configuration unavailable"))?;
    client.machine_identifier = settings.machine_identifier.clone();
    client.library_scope =
        client.cache_scope_for_library(settings.section_id, Some(&settings.section_uuid));
    Ok(client)
}
async fn prepare(config: &Path, run: &str) -> Result<PathBuf> {
    let settings = crate::plex::load_settings(config)
        .map_err(|_| anyhow::anyhow!("QA settings unavailable"))?;
    let owner = credentials(config)?;
    let client = client(&settings)?;
    let validated = response(
        CLIENT
            .get(endpoint(BASE, &["validate-token"])?)
            .header("Authorization", format!("Token {}", owner.token)),
    )
    .await
    .map_err(|_| anyhow::anyhow!("ListenBrainz identity could not be verified"))?;
    if validated.get("valid").and_then(Value::as_bool) != Some(true)
        || validated.get("user_name").and_then(Value::as_str) != Some(&owner.account.user)
    {
        bail!("ListenBrainz account binding could not be verified")
    }
    let identity = client
        .get_identity()
        .await
        .map_err(|_| anyhow::anyhow!("QA server identity could not be verified"))?;
    if identity.machine_identifier != settings.machine_identifier {
        bail!("QA server identity changed")
    }
    let section = client
        .get_section(settings.section_id)
        .await
        .map_err(|_| anyhow::anyhow!("QA library could not be verified"))?;
    if section.section_type != "artist" || section.uuid.as_deref() != Some(&settings.section_uuid) {
        bail!("QA music library changed")
    }
    // The reviewed source is supplied explicitly; never embed a personal ID.
    let source_playlist = std::env::var("HIBIKI_QA_SOURCE_PLAYLIST_ID")
        .context("Explicit reviewed source playlist required")?;
    let source_id = source_playlist
        .parse::<i64>()
        .ok()
        .filter(|id| *id > 0 && id.to_string() == source_playlist)
        .context("Invalid source playlist ID")?;
    let query=format!("/playlists/{source_id}/items?X-Plex-Container-Size=25&X-Plex-Container-Start=0&includeGuids=1");
    let page: Value = client
        .get(&query)
        .await
        .map_err(|_| anyhow::anyhow!("Could not read bounded liked tracks"))?;
    let items = page
        .get("Metadata")
        .and_then(Value::as_array)
        .context("Invalid liked-track page")?;
    if items.len() > 25 {
        bail!("Server exceeded QA read bound")
    }
    let mut selected = vec![];
    let mut candidates = vec![];
    let mut seen = std::collections::BTreeSet::new();
    for item in items {
        let id = item
            .get("ratingKey")
            .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok()))
            .filter(|v| *v > 0)
            .context("Invalid QA track ID")?;
        let mut details: Value = client
            .get(&format!("/library/metadata/{id}?includeGuids=1"))
            .await
            .map_err(|_| anyhow::anyhow!("Could not read QA track recording references"))?;
        let details = details
            .get_mut("Metadata")
            .and_then(Value::as_array_mut)
            .filter(|v| v.len() == 1)
            .and_then(|v| v.first())
            .context("Ambiguous QA track")?;
        let detail_id = details
            .get("ratingKey")
            .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok()));
        if detail_id != Some(id) {
            bail!("QA track item identity changed")
        }
        let section = details
            .get("librarySectionID")
            .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok()));
        if section != Some(settings.section_id)
            || details.get("type").and_then(Value::as_str) != Some("track")
        {
            bail!("QA track library changed")
        }
        let track = json!({"id":id.to_string(),"title":details.get("title").and_then(Value::as_str).unwrap_or(""),"artist":details.get("grandparentTitle").and_then(Value::as_str).unwrap_or(""),"album":details.get("parentTitle").and_then(Value::as_str).unwrap_or(""),"durationMs":details.get("duration").and_then(Value::as_i64).unwrap_or(0)});
        candidates.push(track.clone());
        if let Some(mbid) = guid(details) {
            if seen.insert(mbid.clone()) {
                selected.push(
                    json!({"libraryTrack":track,"recordingMbid":mbid,"verifiedBy":"provider-mbid"}),
                );
            }
        }
        if selected.len() == 3 {
            break;
        }
    }
    current(config, &binding(&settings))?;
    let directory = qa_directory(run)?;
    let manifest = directory.join("manifest.json");
    if manifest.exists() {
        bail!("QA run already exists; never recreate uncertain objects")
    }
    let phase = if selected.len() == 3 {
        "prepared"
    } else {
        "needs-recording-review"
    };
    private_write(
        &manifest,
        &json!({"version":1,"runId":run,"phase":phase,"title":format!("Hibiki QA {run}"),"binding":binding(&settings),"libraryAccount":{"service":"library:Plex","user":client.library_scope,"revision":"scope-v1"},"remoteAccount":owner.account,"tracks":selected,"candidates":candidates,"libraryId":null,"remoteId":null,"creationIntents":[],"proof":[],"mutationCount":0}),
    )?;
    Ok(manifest)
}

fn unverified_mbid(item: &Value) -> Option<String> {
    let references = item
        .get("Guid")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| v.get("id").and_then(Value::as_str))
        .chain(item.get("guid").and_then(Value::as_str));
    let values: std::collections::BTreeSet<_> = references
        .filter_map(|value| {
            value
                .strip_prefix("mbid://")
                .and_then(|id| canonical_mbid(id).ok())
        })
        .collect();
    if values.len() == 1 {
        values.into_iter().next()
    } else {
        None
    }
}
fn normalized(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}
fn recording_evidence(recording: &Value, id: &str, track: &Value) -> Option<Value> {
    if recording
        .get("id")
        .and_then(Value::as_str)
        .and_then(|v| canonical_mbid(v).ok())
        .as_deref()
        != Some(id)
    {
        return None;
    }
    let title = recording.get("title")?.as_str()?;
    let credits = recording.get("artist-credit")?.as_array()?;
    if credits.is_empty() || credits.len() > 16 {
        return None;
    }
    let mut artist = String::new();
    for credit in credits {
        artist.push_str(credit.get("name")?.as_str()?);
        artist.push_str(
            credit
                .get("joinphrase")
                .and_then(Value::as_str)
                .unwrap_or(""),
        );
    }
    let length = recording.get("length")?.as_i64()?;
    let duration = track.get("durationMs")?.as_i64()?;
    if normalized(title).is_empty()
        || normalized(title) != normalized(track.get("title")?.as_str()?)
        || normalized(&artist) != normalized(track.get("artist")?.as_str()?)
        || length <= 0
        || duration <= 0
        || (length - duration).abs() > 1000
    {
        return None;
    }
    Some(
        json!({"recordingMbid":id,"title":title,"artist":artist,"length":length,"toleranceMs":1000,"source":"exact MusicBrainz recording endpoint"}),
    )
}
async fn resolve_recordings(config: &Path, run: &str) -> Result<()> {
    let path = qa_directory(run)?.join("manifest.json");
    let mut manifest: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    if manifest.get("phase").and_then(Value::as_str) != Some("needs-recording-review") {
        bail!("QA plan is not awaiting recording review")
    }
    let expected = manifest
        .get("binding")
        .and_then(Value::as_str)
        .context("QA binding missing")?
        .to_owned();
    current(config, &expected)?;
    let settings = crate::plex::load_settings(config)?;
    let client = client(&settings)?;
    let candidates = manifest
        .get("candidates")
        .and_then(Value::as_array)
        .filter(|v| v.len() <= 25)
        .context("Invalid QA candidates")?
        .clone();
    let mut selected = vec![];
    let mut evidence = vec![];
    let mut negative = vec![];
    let mut statuses = std::collections::BTreeMap::<String, usize>::new();
    let mut namespaces = std::collections::BTreeMap::<String, usize>::new();
    let mut lookups = 0;
    let mut next: Option<tokio::time::Instant> = None;
    let mut seen = std::collections::BTreeSet::new();
    for track in candidates {
        let id = track
            .get("id")
            .and_then(Value::as_str)
            .and_then(|v| v.parse::<i64>().ok())
            .filter(|v| *v > 0)
            .context("Invalid QA track")?;
        let container: Value = client
            .get(&format!("/library/metadata/{id}?includeGuids=1"))
            .await
            .map_err(|_| anyhow::anyhow!("QA recording reference read failed"))?;
        let details = container
            .get("Metadata")
            .and_then(Value::as_array)
            .filter(|v| v.len() == 1)
            .and_then(|v| v.first())
            .context("Ambiguous QA recording reference")?;
        let numeric = |key: &str| {
            details
                .get(key)
                .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok()))
        };
        if numeric("ratingKey") != Some(id)
            || numeric("librarySectionID") != Some(settings.section_id)
            || details.get("type").and_then(Value::as_str) != Some("track")
        {
            bail!("QA recording identity changed")
        }
        let references = details
            .get("Guid")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|v| v.get("id").and_then(Value::as_str))
            .chain(details.get("guid").and_then(Value::as_str));
        for reference in references {
            let namespace = match reference.split("://").next().unwrap_or("") {
                "mbid" => "mbid",
                "plex" => "plex",
                "musicbrainz" => "musicbrainz",
                _ => "other",
            };
            *namespaces.entry(namespace.into()).or_default() += 1;
        }
        if lookups >= 5 {
            continue;
        }
        let Some(mbid) = unverified_mbid(details) else {
            continue;
        };
        if !seen.insert(mbid.clone()) {
            continue;
        }
        if let Some(deadline) = next {
            tokio::time::sleep_until(deadline).await
        }
        next = Some(tokio::time::Instant::now() + std::time::Duration::from_secs(1));
        lookups += 1;
        let response = CLIENT
            .get(format!("https://musicbrainz.org/ws/2/recording/{mbid}"))
            .query(&[("inc", "artist-credits"), ("fmt", "json")])
            .send()
            .await;
        let mut diagnosis = json!({"track":track,"recordingMbid":mbid});
        let mut parsed = None;
        match response {
            Err(_) => {
                *statuses.entry("transport".into()).or_default() += 1;
                diagnosis["status"] = json!("transport");
            }
            Ok(response) => {
                let status = response.status().as_u16();
                *statuses.entry(status.to_string()).or_default() += 1;
                diagnosis["status"] = json!(status);
                if response.status().is_success() {
                    match response.bounded_json::<Value>(MAX_JSON_BYTES).await {
                        Err(_) => {
                            diagnosis["reason"] = json!("invalid-or-oversized-json");
                        }
                        Ok(value) => {
                            let artist = value.get("artist-credit").and_then(Value::as_array).map(
                                |credits| {
                                    credits
                                        .iter()
                                        .take(16)
                                        .map(|credit| {
                                            format!(
                                                "{}{}",
                                                credit
                                                    .get("name")
                                                    .and_then(Value::as_str)
                                                    .unwrap_or(""),
                                                credit
                                                    .get("joinphrase")
                                                    .and_then(Value::as_str)
                                                    .unwrap_or("")
                                            )
                                        })
                                        .collect::<String>()
                                },
                            );
                            let actual_id = value
                                .get("id")
                                .and_then(Value::as_str)
                                .and_then(|v| canonical_mbid(v).ok());
                            let actual_title = value.get("title").and_then(Value::as_str);
                            let actual_length = value.get("length").and_then(Value::as_i64);
                            let expected_length = track.get("durationMs").and_then(Value::as_i64);
                            diagnosis["actual"] = json!({"id":actual_id,"title":actual_title,"artist":artist,"length":actual_length});
                            diagnosis["matches"] = json!({"id":actual_id.as_deref()==Some(&mbid),"title":actual_title.is_some_and(|v|normalized(v)==normalized(track.get("title").and_then(Value::as_str).unwrap_or(""))),"artist":artist.as_deref().is_some_and(|v|normalized(v)==normalized(track.get("artist").and_then(Value::as_str).unwrap_or(""))),"duration":matches!((actual_length,expected_length),(Some(a),Some(b))if a>0&&b>0&&(a-b).abs()<=1000)});
                            parsed = Some(value);
                        }
                    }
                }
            }
        }
        if let Some(response) = parsed {
            if let Some(proof) = recording_evidence(&response, &mbid, &track) {
                diagnosis["accepted"] = json!(true);
                selected.push(
                    json!({"libraryTrack":track,"recordingMbid":mbid,"verifiedBy":"provider-mbid"}),
                );
                evidence.push(proof);
            } else {
                diagnosis["accepted"] = json!(false);
            }
        }
        negative.push(diagnosis);
        manifest["lookupEvidence"] = json!(negative);
        manifest["lookupStatusCounts"] = json!(statuses);
        private_write(&path, &manifest)?;
        if selected.len() == 3 {
            break;
        }
    }
    current(config, &expected)?;
    manifest["tracks"] = json!(selected);
    manifest["recordingEvidence"] = json!(evidence);
    manifest["namespaceCounts"] = json!(namespaces);
    manifest["recordingLookups"] = json!(lookups);
    manifest["phase"] = json!(if selected.len() == 3 {
        "prepared"
    } else {
        "needs-recording-review"
    });
    private_write(&path, &manifest)?;
    println!("Read-only recording verification: {} accepted from {} exact lookups; namespace counts {:?}; HTTP/status counts {:?}; no remote writes.",selected.len(),lookups,namespaces,statuses);
    Ok(())
}

fn credit(value: &Value) -> Option<String> {
    let values = value.as_array()?;
    if values.is_empty() || values.len() > 16 {
        return None;
    }
    let mut out = String::new();
    for item in values {
        out.push_str(item.get("name")?.as_str()?);
        out.push_str(item.get("joinphrase").and_then(Value::as_str).unwrap_or(""));
    }
    Some(out)
}
fn exact_track_relation(value: &Value, source_id: &str, expected: &Value) -> Option<Value> {
    let releases = value.get("releases")?.as_array()?;
    if releases.len() > 5 {
        return None;
    }
    let mut matches = vec![];
    let mut recordings = std::collections::BTreeSet::new();
    for release in releases {
        let media = release.get("media")?.as_array()?;
        if media.len() > 32 {
            return None;
        }
        for medium in media {
            let tracks = medium.get("tracks")?.as_array()?;
            if tracks.len() > 1000 {
                return None;
            }
            for track in tracks {
                if track
                    .get("id")
                    .and_then(Value::as_str)
                    .and_then(|v| canonical_mbid(v).ok())
                    .as_deref()
                    != Some(source_id)
                {
                    continue;
                }
                let artist = credit(
                    track
                        .get("artist-credit")
                        .or_else(|| release.get("artist-credit"))?,
                )?;
                let title = track.get("title")?.as_str()?;
                let length = track.get("length")?.as_i64()?;
                let expected_length = expected.get("durationMs")?.as_i64()?;
                if normalized(title) != normalized(expected.get("title")?.as_str()?)
                    || normalized(&artist) != normalized(expected.get("artist")?.as_str()?)
                    || length <= 0
                    || expected_length <= 0
                    || (length - expected_length).abs() > 1000
                {
                    return None;
                }
                let recording =
                    canonical_mbid(track.get("recording")?.get("id")?.as_str()?).ok()?;
                recordings.insert(recording.clone());
                matches.push(json!({"sourceGuidId":source_id,"sourceGuidType":"release-track","recordingMbid":recording,"trackTitle":title,"trackArtist":artist,"trackLength":length,"releaseId":release.get("id")}));
            }
        }
    }
    if recordings.len() != 1 || matches.is_empty() {
        return None;
    }
    Some(json!({"recordingMbid":recordings.into_iter().next(),"relationships":matches}))
}
async fn resolve_release_tracks(config: &Path, run: &str) -> Result<()> {
    let path = qa_directory(run)?.join("manifest.json");
    let mut manifest: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    if manifest.get("phase").and_then(Value::as_str) != Some("needs-recording-review") {
        bail!("QA plan does not require relationship review")
    }
    let expected = manifest
        .get("binding")
        .and_then(Value::as_str)
        .context("QA binding missing")?
        .to_owned();
    current(config, &expected)?;
    let settings = crate::plex::load_settings(config)?;
    let client = client(&settings)?;
    let original = manifest
        .get("candidates")
        .and_then(Value::as_array)
        .context("Retained bounded candidates missing")?
        .clone();
    let mut selected = manifest
        .get("tracks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut proofs = manifest
        .get("recordingEvidence")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut diagnostics = manifest
        .get("relationshipDiagnostics")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut seen = diagnostics
        .iter()
        .filter_map(|d| {
            d.get("sourceGuidId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect::<std::collections::BTreeSet<_>>();
    let mut next: Option<tokio::time::Instant> = None;
    let mut statuses = manifest
        .get("relationshipStatusCounts")
        .cloned()
        .and_then(|v| serde_json::from_value::<std::collections::BTreeMap<String, usize>>(v).ok())
        .unwrap_or_default();
    for track in original {
        if selected.len() >= 3 || seen.len() >= 25 {
            break;
        }
        let id = track
            .get("id")
            .and_then(Value::as_str)
            .and_then(|v| v.parse::<i64>().ok())
            .filter(|v| *v > 0)
            .context("Invalid QA track")?;
        let details: Value = client
            .get(&format!("/library/metadata/{id}?includeGuids=1"))
            .await
            .map_err(|_| anyhow::anyhow!("QA source track could not be reverified"))?;
        let raw = details
            .get("Metadata")
            .and_then(Value::as_array)
            .filter(|v| v.len() == 1)
            .and_then(|v| v.first())
            .context("Ambiguous QA source")?;
        let numeric = |key: &str| {
            raw.get(key)
                .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok()))
        };
        if numeric("ratingKey") != Some(id)
            || numeric("librarySectionID") != Some(settings.section_id)
            || raw.get("type").and_then(Value::as_str) != Some("track")
        {
            bail!("QA source track identity changed")
        }
        let Some(source_id) = unverified_mbid(raw) else {
            continue;
        };
        if !seen.insert(source_id.clone()) {
            continue;
        }
        current(config, &expected)?;
        if let Some(deadline) = next {
            tokio::time::sleep_until(deadline).await
        }
        next = Some(tokio::time::Instant::now() + std::time::Duration::from_secs(1));
        let response = CLIENT
            .get("https://musicbrainz.org/ws/2/release")
            .query(&[
                ("track", source_id.as_str()),
                ("inc", "recordings+artist-credits"),
                ("fmt", "json"),
                ("limit", "5"),
            ])
            .send()
            .await;
        let mut diagnostic = json!({"track":track,"sourceGuidId":source_id});
        let Ok(response) = response else {
            diagnostic["status"] = json!("transport");
            diagnostics.push(diagnostic);
            continue;
        };
        let status = response.status().as_u16();
        diagnostic["status"] = json!(status);
        *statuses.entry(status.to_string()).or_default() += 1;
        if !response.status().is_success() {
            diagnostics.push(diagnostic);
            continue;
        }
        let relation: Value = response
            .bounded_json(MAX_JSON_BYTES)
            .await
            .map_err(|_| anyhow::anyhow!("Invalid bounded relationship response"))?;
        diagnostic["releaseCount"] = json!(relation
            .get("releases")
            .and_then(Value::as_array)
            .map(Vec::len));
        let Some(proof) = exact_track_relation(&relation, &source_id, &track) else {
            diagnostic["relationMatch"] = json!(false);
            diagnostic["relationshipResponse"] = relation;
            diagnostics.push(diagnostic);
            continue;
        };
        diagnostic["relationMatch"] = json!(true);
        diagnostic["relationshipEvidence"] = proof.clone();
        let mbid = proof
            .get("recordingMbid")
            .and_then(Value::as_str)
            .context("Canonical recording missing")?;
        if let Some(deadline) = next {
            tokio::time::sleep_until(deadline).await
        }
        next = Some(tokio::time::Instant::now() + std::time::Duration::from_secs(1));
        let response = CLIENT
            .get(format!("https://musicbrainz.org/ws/2/recording/{mbid}"))
            .query(&[("inc", "artist-credits"), ("fmt", "json")])
            .send()
            .await;
        let Ok(response) = response else {
            diagnostic["recordingStatus"] = json!("transport");
            diagnostics.push(diagnostic);
            continue;
        };
        let status = response.status().as_u16();
        diagnostic["recordingStatus"] = json!(status);
        *statuses.entry(status.to_string()).or_default() += 1;
        if !response.status().is_success() {
            diagnostics.push(diagnostic);
            continue;
        }
        let recording: Value = response
            .bounded_json(MAX_JSON_BYTES)
            .await
            .map_err(|_| anyhow::anyhow!("Invalid canonical recording response"))?;
        let canonical = recording
            .get("id")
            .and_then(Value::as_str)
            .and_then(|id| canonical_mbid(id).ok());
        let recording_artist = recording.get("artist-credit").and_then(credit);
        diagnostic["recordingEvidence"] = json!({"id":canonical,"title":recording.get("title"),"artist":recording_artist,"length":recording.get("length"),"durationProof":"exact release-track length, not recording median"});
        if canonical.as_deref() == Some(mbid)
            && recording_artist.as_deref().is_some_and(|artist| {
                normalized(artist)
                    == normalized(track.get("artist").and_then(Value::as_str).unwrap_or(""))
            })
        {
            selected.push(
                json!({"libraryTrack":track,"recordingMbid":mbid,"verifiedBy":"provider-mbid"}),
            );
            proofs.push(json!({"relationship":proof,"recording":diagnostic["recordingEvidence"]}));
            diagnostic["accepted"] = json!(true);
        } else {
            diagnostic["accepted"] = json!(false)
        }
        diagnostics.push(diagnostic);
        manifest["relationshipDiagnostics"] = json!(diagnostics);
        private_write(&path, &manifest)?;
    }
    current(config, &expected)?;
    manifest["tracks"] = json!(selected);
    manifest["recordingEvidence"] = json!(proofs);
    manifest["relationshipDiagnostics"] = json!(diagnostics);
    manifest["relationshipStatusCounts"] = json!(statuses);
    manifest["phase"] = json!(if selected.len() == 3 {
        "prepared"
    } else {
        "needs-recording-review"
    });
    private_write(&path, &manifest)?;
    println!("Read-only exact release-track verification: {} accepted; status counts {:?}; no remote writes.",selected.len(),statuses);
    Ok(())
}

#[test]
fn exact_recording_references_reject_ambiguous_or_heuristic_identifiers() {
    let a = "11111111-1111-4111-8111-111111111111";
    let b = "22222222-2222-4222-8222-222222222222";
    assert_eq!(
        guid(&json!({"Guid":[{"id":format!("musicbrainz://recording/{a}")}]})),
        Some(a.into())
    );
    assert!(guid(&json!({"guid":format!("plex://track/{a}")})).is_none());
    assert!(guid(&json!({"Guid":[{"id":format!("musicbrainz://recording/{a}")},{"id":format!("musicbrainz://recording/{b}")}]})).is_none());
}

#[test]
fn release_track_relationship_requires_exact_identity_and_occurrence_metadata() {
    let tid = "11111111-1111-4111-8111-111111111111";
    let recording = "22222222-2222-4222-8222-222222222222";
    let other = "33333333-3333-4333-8333-333333333333";
    let expected = json!({"title":"Song", "artist":"Artist", "durationMs":180000});
    let response = json!({"releases":[{"artist-credit":[{"name":"Artist"}],"media":[{"tracks":[{"id":tid,"title":"Song","length":180000,"recording":{"id":recording,"length":220000}}]}]}]});
    // The specific release-track length is authoritative; a recording's median
    // duration cannot invalidate this exact association.
    assert_eq!(
        exact_track_relation(&response, tid, &expected).unwrap()["recordingMbid"],
        recording
    );
    for (field, wrong) in [
        ("id", json!(other)),
        ("title", json!("Other Song")),
        ("length", json!(183000)),
    ] {
        let mut altered = response.clone();
        altered["releases"][0]["media"][0]["tracks"][0][field] = wrong;
        assert!(exact_track_relation(&altered, tid, &expected).is_none());
    }
    let mut wrong_artist = response.clone();
    wrong_artist["releases"][0]["artist-credit"][0]["name"] = json!("Other Artist");
    assert!(exact_track_relation(&wrong_artist, tid, &expected).is_none());
    let mut conflicting = response.clone();
    let mut second = response["releases"][0].clone();
    second["media"][0]["tracks"][0]["recording"]["id"] = json!(other);
    conflicting["releases"].as_array_mut().unwrap().push(second);
    assert!(exact_track_relation(&conflicting, tid, &expected).is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Explicit live QA requires root-reviewed fresh-run manifest; never ordinary CI"]
async fn live_owned_playlist_smoke() -> Result<()> {
    let mode = std::env::var("HIBIKI_LIVE_QA_MODE").context("Explicit QA mode required")?;
    let config = PathBuf::from(
        std::env::var("HIBIKI_QA_CONFIG_DIR").context("Native QA config path required")?,
    );
    let run =
        canonical_mbid(&std::env::var("HIBIKI_QA_RUN_ID").context("Reviewed QA UUID required")?)?;
    if mode == "inspect-weekly-candidates" {
        return weekly_diagnostic::candidates(&config).await;
    }
    if mode == "inspect-weekly-import" {
        return weekly_diagnostic::inspect(&config).await;
    }
    if mode == "prepare-empty" {
        return empty::prepare(&config, &run).await;
    }
    if mode == "execute-empty" {
        return empty::execute(&config, &run).await;
    }
    if mode == "prepare-empty-cleanup" || mode == "cleanup-empty-reviewed" {
        return empty::cleanup(&config, &run, mode == "cleanup-empty-reviewed").await;
    }
    if mode == "prepare-reviewed-copy" {
        let previous = canonical_mbid(
            &std::env::var("HIBIKI_QA_PREVIOUS_RUN").context("Reviewed previous run required")?,
        )?;
        return prepare_reviewed_copy(&config, &run, &previous).await;
    }
    if mode == "prepare" {
        let _ = prepare(&config, &run).await?;
        println!("Read-only QA plan retained; no remote writes performed.");
        return Ok(());
    }
    if mode == "resolve" {
        return resolve_recordings(&config, &run).await;
    }
    if mode == "resolve-track" {
        return resolve_release_tracks(&config, &run).await;
    }
    if mode == "inspect-created" {
        return execution::inspect_created(&config, &run).await;
    }
    if mode == "cleanup-reviewed" {
        return execution::cleanup_reviewed(&config, &run).await;
    }
    if mode == "prepare-cleanup" {
        return execution::prepare_cleanup(&config, &run).await;
    }
    if mode == "prepare-distinct" {
        return execution::prepare_distinct(&config, &run).await;
    }
    if mode == "reviewed-distinct-execute" {
        return execution::execute(&config, &run, true).await;
    }
    if mode == "execute" {
        return execution::execute(&config, &run, false).await;
    }
    bail!("Unsupported live QA mode; no writes performed")
}

mod execution;
mod empty;
mod weekly_diagnostic;

async fn prepare_reviewed_copy(config: &Path, run: &str, previous: &str) -> Result<()> {
    let source: Value = serde_json::from_slice(&std::fs::read(
        qa_directory(previous)?.join("manifest.json"),
    )?)?;
    if source["runId"] != previous
        || source["phase"] != "halted"
        || !source["initialOrderDiagnostic"]["actual"]
            .as_array()
            .is_some_and(Vec::is_empty)
        || source["mutationCount"] != 0
        || !source["remoteId"].is_null()
    {
        bail!("Reviewed empty prior QA proof required")
    }
    let expected = source["binding"].as_str().context("QA binding missing")?;
    current(config, expected)?;
    let settings = crate::plex::load_settings(config)?;
    let client = client(&settings)?;
    let account = credentials(config)?;
    if client.get_identity().await?.machine_identifier != settings.machine_identifier {
        bail!("QA machine changed")
    }
    let section = client.get_section(settings.section_id).await?;
    if section.section_type != "artist"
        || section.uuid.as_deref() != Some(settings.section_uuid.as_str())
    {
        bail!("QA section changed")
    }
    let auth = response(
        CLIENT
            .get(endpoint(BASE, &["validate-token"])?)
            .header("Authorization", format!("Token {}", account.token)),
    )
    .await?;
    if auth["valid"] != true || auth["user_name"].as_str() != Some(account.account.user.as_str()) {
        bail!("QA remote account changed")
    }
    let tracks = source["tracks"]
        .as_array()
        .filter(|a| a.len() == 3)
        .context("Reviewed three mappings missing")?;
    for mapping in tracks {
        let original = &mapping["libraryTrack"];
        let id = original["id"]
            .as_str()
            .context("QA track missing")?
            .parse::<i64>()?;
        let value: Value = client
            .get(&format!("/library/metadata/{id}?includeGuids=1"))
            .await?;
        let raw = value["Metadata"]
            .as_array()
            .filter(|a| a.len() == 1)
            .and_then(|a| a.first())
            .context("QA track missing")?;
        let numeric = |key: &str| {
            raw.get(key)
                .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok()))
        };
        let proof = source["recordingEvidence"]
            .as_array()
            .context("Relationship evidence missing")?
            .iter()
            .find(|p| p["relationship"]["recordingMbid"] == mapping["recordingMbid"])
            .context("Verified relation missing")?;
        let tid = proof["relationship"]["relationships"][0]["sourceGuidId"]
            .as_str()
            .context("Exact track reference missing")?;
        if numeric("ratingKey") != Some(id)
            || numeric("librarySectionID") != Some(settings.section_id)
            || raw["type"] != "track"
            || raw["title"] != original["title"]
            || raw["grandparentTitle"] != original["artist"]
            || numeric("duration") != original["durationMs"].as_i64()
            || unverified_mbid(raw).as_deref() != Some(tid)
        {
            bail!("Reviewed QA track changed")
        }
    }
    current(config, expected)?;
    let path = qa_directory(run)?.join("manifest.json");
    if path.exists() {
        bail!("New QA manifest already exists")
    }
    let manifest = json!({"version":1,"runId":run,"phase":"prepared","title":format!("Hibiki QA {run}"),"binding":expected,"libraryAccount":source["libraryAccount"],"remoteAccount":account.account,"tracks":tracks,"recordingEvidence":source["recordingEvidence"],"reviewedMappingOriginRun":previous,"libraryId":null,"remoteId":null,"creationIntents":[],"proof":[],"mutationCount":0});
    private_write(&path, &manifest)?;
    println!("Read-only fresh QA plan prepared: three copied reviewed mappings revalidated; no remote writes.");
    Ok(())
}
