//! Finite read-only discovery. A matching GUID retrieves candidates, never proves a recording ID.
use super::*;
use crate::plex::{PlexClient, Track};
static ADMISSIONS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateSource {
    pub title: String,
    pub artist: String,
    pub recording_mbid: Option<String>,
}
#[derive(Serialize, Default)]
pub struct Discovery {
    pub tracks: Vec<Track>,
    pub truncated: bool,
    pub unavailable: bool,
}
fn norm(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}
fn hints(value: &str) -> Vec<String> {
    let mut result = vec![value.trim().to_string()];
    let lower = value.to_ascii_lowercase();
    let mut depth = 0usize;
    let mut start = 0;
    let mut index = 0;
    while index < value.len() {
        let ch = value[index..].chars().next().unwrap();
        if ch == '(' {
            depth += 1
        } else if ch == ')' {
            depth = depth.saturating_sub(1)
        }
        if depth == 0 {
            if let Some(join) = [
                " & ",
                " feat. ",
                " feat ",
                " featuring ",
                " ft. ",
                " ft ",
                " with ",
                ", ",
            ]
            .into_iter()
            .find(|j| lower.get(index..).is_some_and(|s| s.starts_with(j)))
            {
                let part = value[start..index].trim();
                if !part.is_empty() && !result.iter().any(|r| norm(r) == norm(part)) {
                    result.push(part.into())
                }
                index += join.len();
                start = index;
                continue;
            }
        }
        index += ch.len_utf8();
    }
    let part = value[start..].trim();
    if !part.is_empty() && !result.iter().any(|r| norm(r) == norm(part)) {
        result.push(part.into())
    }
    result.truncate(3);
    result
}
async fn page(
    client: &PlexClient,
    section: i64,
    params: Vec<(String, String)>,
    cap: usize,
    current: &impl Fn() -> bool,
) -> Result<(Vec<Value>, bool)> {
    if !current() {
        bail!("Candidate owner changed")
    }
    let response = client
        .client
        .get(client.build_url(&format!("/library/sections/{section}/all")))
        .query(&params)
        .query(&[
            ("X-Plex-Container-Start", 0),
            ("X-Plex-Container-Size", cap),
        ])
        .header("X-Plex-Token", client.token.clone())
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("Candidate request unavailable"))?;
    if !current() {
        bail!("Candidate owner changed")
    }
    if !response.status().is_success() {
        bail!("Candidate request rejected")
    }
    let value = response.bounded_json::<Value>(MAX_JSON_BYTES).await?;
    if !current() {
        bail!("Candidate owner changed")
    }
    let container = value
        .get("MediaContainer")
        .context("Candidate envelope missing")?;
    let count = |key: &str| {
        container
            .get(key)
            .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok()))
    };
    if count("offset").is_some_and(|offset| offset != 0) {
        bail!("Candidate page changed")
    }
    let mut rows = container
        .get("Metadata")
        .or_else(|| container.get("Directory"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if rows.len() > cap {
        bail!("Candidate row cap exceeded")
    }
    // Typed /sections/{id}/all replies can put scope on the container, omitting it on artists.
    // Inherit only explicit matching container provenance; never overwrite a contradictory row.
    if let Some(scope) = count("librarySectionID") {
        if scope != section {
            bail!("Candidate container scope changed")
        }
        for row in &mut rows {
            if row.get("librarySectionID").is_none() {
                if let Some(object) = row.as_object_mut() {
                    object.insert("librarySectionID".into(), json!(section));
                }
            }
        }
    }
    let total = count("totalSize");
    if total.is_some_and(|total| total < rows.len() as i64) {
        bail!("Candidate count changed")
    }
    let truncated = total.map_or(rows.len() == cap, |total| total > cap as i64);
    Ok((rows, truncated))
}
fn tracks(rows: Vec<Value>, section: i64, artist: Option<i64>) -> Result<Vec<Track>> {
    rows.into_iter()
        .map(|row| {
            if row["type"] != "track" {
                bail!("Unexpected candidate kind")
            }
            let t: Track = serde_json::from_value(row)?;
            if t.rating_key <= 0
                || t.library_section_id != section
                || t.title.trim().is_empty()
                || t.grandparent_title.trim().is_empty()
                || artist.is_some_and(|id| {
                    t.grandparent_key
                        .rsplit('/')
                        .next()
                        .and_then(|s| s.parse::<i64>().ok())
                        != Some(id)
                })
            {
                bail!("Candidate scope changed")
            }
            Ok(t)
        })
        .collect()
}
fn retain(found: &mut std::collections::BTreeMap<i64, Track>, t: Track) -> Result<()> {
    if let Some(old) = found.get(&t.rating_key) {
        if old.title != t.title
            || old.grandparent_title != t.grandparent_title
            || old.parent_title != t.parent_title
            || old.duration != t.duration
            || old.guid != t.guid
        {
            bail!("Candidate metadata changed")
        }
    }
    found.insert(t.rating_key, t);
    Ok(())
}
pub async fn discover(
    client: &PlexClient,
    section: i64,
    source: &CandidateSource,
    current: impl Fn() -> bool,
) -> Result<Discovery> {
    let Ok(_permit) = ADMISSIONS.try_acquire() else {
        return Ok(Discovery {
            unavailable: true,
            ..Default::default()
        });
    };
    if source.title.trim().is_empty()
        || source.artist.trim().is_empty()
        || source.title.len() + source.artist.len() > 1000
        || section <= 0
        || client.offline_only
    {
        bail!("Invalid candidate source")
    }
    let mbid = source
        .recording_mbid
        .as_deref()
        .map(canonical_mbid)
        .transpose()?;
    if !current() {
        bail!("Candidate owner changed")
    }
    let verified = client.get_section(section).await?;
    if !current() {
        bail!("Candidate owner changed")
    }
    if verified.key != section
        || verified.section_type != "artist"
        || client.library_scope != client.cache_scope_for_library(section, verified.uuid.as_deref())
    {
        bail!("Candidate library changed")
    }
    let mut result = Discovery::default();
    let mut found = std::collections::BTreeMap::new();
    // Plex generic mbid GUIDs may be release-track IDs. Even a GUID-filter hit remains unverified.
    if let Some(id) = mbid.as_deref() {
        match page(
            client,
            section,
            vec![
                ("type".into(), "10".into()),
                ("guid".into(), format!("mbid://{id}")),
            ],
            50,
            &current,
        )
        .await
        {
            Ok((rows, limited)) => {
                result.truncated |= limited;
                for t in tracks(rows, section, None)? {
                    retain(&mut found, t)?;
                }
            }
            Err(_) => {
                if !current() {
                    bail!("Candidate owner changed")
                }
            }
        }
    }
    let labels = hints(&source.artist);
    let mut artists = std::collections::BTreeSet::new();
    for label in &labels {
        match page(
            client,
            section,
            vec![("type".into(), "8".into()), ("title".into(), label.clone())],
            10,
            &current,
        )
        .await
        {
            Ok((rows, limited)) => {
                result.truncated |= limited;
                for row in rows {
                    if row["type"] != "artist" {
                        bail!("Unexpected artist kind")
                    }
                    let a: crate::plex::Artist = serde_json::from_value(row)?;
                    if a.rating_key <= 0 || a.library_section_id != section {
                        bail!("Artist scope changed")
                    }
                    if labels.iter().any(|label| norm(label) == norm(&a.title)) {
                        artists.insert(a.rating_key);
                    }
                }
            }
            Err(_) => {
                if !current() {
                    bail!("Candidate owner changed")
                }
                result.unavailable = true;
            }
        }
    }
    if artists.len() > 2 {
        result.truncated = true;
    }
    for artist in artists.into_iter().take(2) {
        let params = vec![
            ("type".into(), "10".into()),
            ("artist.id".into(), artist.to_string()),
            ("title".into(), source.title.clone()),
        ];
        match page(client, section, params, 50, &current).await {
            Ok((rows, limited)) => {
                result.truncated |= limited;
                if rows.is_empty() {
                    match page(
                        client,
                        section,
                        vec![
                            ("type".into(), "10".into()),
                            ("artist.id".into(), artist.to_string()),
                            ("sort".into(), "titleSort:asc".into()),
                        ],
                        200,
                        &current,
                    )
                    .await
                    {
                        Ok((rows, limited)) => {
                            result.truncated |= limited;
                            for t in tracks(rows, section, Some(artist))? {
                                retain(&mut found, t)?;
                            }
                        }
                        Err(_) => {
                            if !current() {
                                bail!("Candidate owner changed")
                            }
                            result.unavailable = true;
                        }
                    }
                } else {
                    for t in tracks(rows, section, Some(artist))? {
                        retain(&mut found, t)?;
                    }
                }
            }
            Err(_) => {
                if !current() {
                    bail!("Candidate owner changed")
                }
                result.unavailable = true;
            }
        }
    }
    if !current() {
        bail!("Candidate owner changed")
    }
    result.truncated |= found.len() > 200;
    result.tracks = found.into_values().take(200).collect();
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    fn server(responses: Vec<Value>) -> (PlexClient, std::thread::JoinHandle<Vec<String>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let thread = std::thread::spawn(move || {
            let mut paths = Vec::new();
            for response in responses {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((s, _)) => break s,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                std::time::Instant::now() < deadline,
                                "bounded fixture accept"
                            );
                            std::thread::sleep(std::time::Duration::from_millis(1));
                        }
                        Err(e) => panic!("{e}"),
                    }
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = Vec::new();
                while !bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                    let mut b = [0; 1024];
                    let n = stream.read(&mut b).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&b[..n]);
                    assert!(bytes.len() < 16384)
                }
                let request = String::from_utf8(bytes).unwrap();
                paths.push(
                    request
                        .lines()
                        .next()
                        .unwrap()
                        .split_whitespace()
                        .nth(1)
                        .unwrap()
                        .into(),
                );
                assert!(request
                    .to_lowercase()
                    .contains("x-plex-token: fixture-token"));
                let body = response.to_string();
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
            }
            paths
        });
        let mut client = PlexClient::new(crate::plex::PlexClientConfig {
            base_url: format!("http://{address}/proxy"),
            token: "fixture-token".into(),
            ..Default::default()
        })
        .unwrap();
        client.library_scope = client.cache_scope_for_library(1, Some("section"));
        (client, thread)
    }
    fn envelope(rows: Value, total: usize) -> Value {
        json!({"MediaContainer":{"Metadata":rows,"offset":0,"totalSize":total,"librarySectionID":1}})
    }
    fn section() -> Value {
        json!({"MediaContainer":{"Directory":[{"key":"1","type":"artist","uuid":"section"}]}})
    }
    fn artist() -> Value {
        json!({"type":"artist","ratingKey":"10","title":"Artist"})
    }
    fn track(id: i64) -> Value {
        json!({"type":"track","ratingKey":id,"title":"Song & 漢字","grandparentTitle":"Artist","grandparentKey":"/library/metadata/10","parentTitle":"Album","duration":180000,"librarySectionID":1,"guid":"mbid://11111111-1111-4111-8111-111111111111"})
    }
    #[test]
    fn collaborator_hints_preserve_parentheses_unicode_and_cap() {
        assert_eq!(
            hints("A (B & C) feat. D & E"),
            vec!["A (B & C) feat. D & E", "A (B & C)", "D"]
        );
        assert_eq!(hints("İ & 漢字"), vec!["İ & 漢字", "İ", "漢字"]);
    }
    #[tokio::test]
    async fn scoped_discovery_uses_literal_filters_proxy_scope_and_bounded_guid_lookup() {
        let (client, thread) = server(vec![
            section(),
            envelope(json!([]), 0),
            envelope(json!([artist()]), 1),
            envelope(json!([track(20)]), 1),
        ]);
        let result = discover(
            &client,
            1,
            &CandidateSource {
                title: "Song & 漢字".into(),
                artist: "Artist".into(),
                recording_mbid: Some("11111111-1111-4111-8111-111111111111".into()),
            },
            || true,
        )
        .await
        .unwrap();
        assert_eq!(result.tracks.len(), 1);
        assert!(!result.truncated && !result.unavailable);
        let paths = thread.join().unwrap();
        assert_eq!(paths.len(), 4);
        let urls = paths
            .into_iter()
            .map(|p| url::Url::parse(&format!("http://fixture{p}")).unwrap())
            .collect::<Vec<_>>();
        assert!(urls.iter().all(|u| u.path().starts_with("/proxy/library/")));
        let pairs = |index: usize| {
            urls[index]
                .query_pairs()
                .into_owned()
                .collect::<std::collections::HashMap<_, _>>()
        };
        assert_eq!(
            pairs(1)["guid"],
            "mbid://11111111-1111-4111-8111-111111111111"
        );
        assert_eq!(pairs(1)["type"], "10");
        assert_eq!(pairs(3)["artist.id"], "10");
        assert_eq!(pairs(3)["title"], "Song & 漢字");
        assert_eq!(pairs(3)["X-Plex-Container-Size"], "50");
        assert_eq!(pairs(3)["includeLoudnessRamps"], "1");
    }
    #[tokio::test]
    async fn bounded_artist_catalogue_marks_truncation_and_never_paginates_whole_artist() {
        let rows = (1..=200).map(track).collect::<Vec<_>>();
        let (client, thread) = server(vec![
            section(),
            envelope(json!([artist()]), 1),
            envelope(json!([]), 0),
            envelope(json!(rows), 201),
        ]);
        let result = discover(
            &client,
            1,
            &CandidateSource {
                title: "Different punctuation".into(),
                artist: "Artist".into(),
                recording_mbid: None,
            },
            || true,
        )
        .await
        .unwrap();
        assert!(result.truncated);
        assert_eq!(result.tracks.len(), 200);
        let paths = thread.join().unwrap();
        assert_eq!(paths.len(), 4);
        assert!(paths[3].contains("X-Plex-Container-Size=200"));
    }
    #[tokio::test]
    async fn retired_owner_is_rejected_before_network_and_wrong_artist_rows_are_rejected() {
        let client = PlexClient::new(Default::default()).unwrap();
        assert!(discover(
            &client,
            1,
            &CandidateSource {
                title: "Song".into(),
                artist: "Artist".into(),
                recording_mbid: None
            },
            || false
        )
        .await
        .is_err());
        assert!(tracks(vec![track(1)], 1, Some(99)).is_err());
        assert!(tracks(vec![track(1)], 2, None).is_err());
    }
    #[tokio::test]
    async fn contradictory_container_or_artist_scope_is_rejected() {
        for container_scope in [1, 2] {
            let mut a = artist();
            a["librarySectionID"] = json!(2);
            let mut reply = envelope(json!([a]), 1);
            reply["MediaContainer"]["librarySectionID"] = json!(container_scope);
            let (client, thread) = server(vec![section(), reply]);
            let result = discover(
                &client,
                1,
                &CandidateSource {
                    title: "Song".into(),
                    artist: "Artist".into(),
                    recording_mbid: None,
                },
                || true,
            )
            .await;
            if container_scope == 1 {
                assert!(result.is_err());
            } else {
                assert!(result.unwrap().unavailable);
            }
            assert_eq!(thread.join().unwrap().len(), 2);
        }
    }
    #[test]
    fn metadata_conflict_for_one_local_id_is_not_overwritten() {
        let mut found = std::collections::BTreeMap::new();
        let t = tracks(vec![track(1)], 1, None).unwrap().pop().unwrap();
        retain(&mut found, t.clone()).unwrap();
        let mut newer = t;
        newer.duration += 2000;
        assert!(retain(&mut found, newer).is_err());
    }
}
