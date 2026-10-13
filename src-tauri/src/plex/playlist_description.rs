//! A scoped, single-attempt weekly playlist description update with fresh proof.
use super::{playlist_sync_edit::PlaylistSyncState, PlexClient};
use anyhow::{bail, Context, Result};
use serde_json::Value;

pub struct PreparedPlaylistDescription {
    section_id: i64,
    playlist_id: i64,
    expected: PlaylistSyncState,
    description: String,
    scope: String,
}

impl PlexClient {
    async fn playlist_description(&self, id: i64, title: &str) -> Result<String> {
        let value: Value = self.get(&format!("/library/metadata/{id}")).await?;
        let rows = value["Metadata"].as_array().filter(|v| v.len() == 1)
            .context("Playlist metadata identity is ambiguous")?;
        let row = &rows[0];
        let actual_id = row["ratingKey"].as_i64()
            .or_else(|| row["ratingKey"].as_str()?.parse().ok());
        if actual_id != Some(id) || row["title"].as_str() != Some(title) {
            bail!("Playlist metadata changed; review again")
        }
        match &row["summary"] {
            Value::Null => Ok(String::new()),
            Value::String(text) if text.len() <= 5000 => Ok(text.clone()),
            _ => bail!("Invalid playlist description"),
        }
    }

    pub async fn prepare_playlist_description(
        &self, section_id: i64, playlist_id: i64, expected: &PlaylistSyncState,
        expected_description: &str, description: &str,
    ) -> Result<PreparedPlaylistDescription> {
        expected.validate()?;
        if section_id <= 0 || playlist_id <= 0 || self.offline_only {
            bail!("Reconnect to the linked Plex music library")
        }
        if expected_description.len() > 5000 || description.len() > 5000 {
            bail!("Playlist description is too long")
        }
        if self.playlist_description(playlist_id, &expected.title).await? != expected_description
            || self.playlist_sync_state(section_id, playlist_id).await? != *expected {
            bail!("Playlist changed; review the description and songs again")
        }
        Ok(PreparedPlaylistDescription {section_id, playlist_id, expected: expected.clone(),
            description: description.to_owned(), scope: self.library_scope.clone()})
    }

    /// The originating native connection guard is held only for this one PUT.
    pub async fn commit_playlist_description_once(&self, prepared: &PreparedPlaylistDescription) -> Result<()> {
        if self.offline_only || self.library_scope != prepared.scope {
            bail!("Linked Plex connection changed")
        }
        self.put_metadata_params_once(&format!("/playlists/{}", prepared.playlist_id),
            &[("summary", prepared.description.as_str())]).await
    }

    pub async fn verify_playlist_description(&self, prepared: &PreparedPlaylistDescription) -> Result<String> {
        if self.offline_only || self.library_scope != prepared.scope {
            bail!("Playlist description outcome requires reconciliation")
        }
        let actual = self.playlist_sync_state(prepared.section_id, prepared.playlist_id).await?;
        let description = self.playlist_description(prepared.playlist_id, &prepared.expected.title).await?;
        if actual != prepared.expected || description != prepared.description {
            bail!("Playlist description outcome requires reconciliation")
        }
        Ok(description)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::{PlexClientConfig, playlist_sync_edit::PlaylistSyncOccurrence};
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    #[tokio::test]
    async fn description_requires_exact_before_and_after_and_never_retries() {
        for case in 0..8 {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/proxy", listener.local_addr().unwrap());
            let (stop, mut stopped) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(async move {
                let mut description = "Original description".to_owned();
                let mut writes = 0;
                loop {
                    let (mut socket, _) = tokio::select! {
                        _ = &mut stopped => break,
                        accepted = listener.accept() => accepted.unwrap(),
                    };
                    let mut header = vec![]; let mut bytes = [0; 4096];
                    while !header.windows(4).any(|part| part == b"\r\n\r\n") {
                        let count = socket.read(&mut bytes).await.unwrap(); assert!(count > 0);
                        header.extend_from_slice(&bytes[..count]); assert!(header.len() < 65536);
                    }
                    let request = String::from_utf8(header).unwrap();
                    let first = request.lines().next().unwrap().split_whitespace().collect::<Vec<_>>();
                    let uri = url::Url::parse(&format!("http://fixture{}", first[1])).unwrap();
                    let mut status = 200;
                    let body = match (first[0], uri.path()) {
                        ("GET", "/proxy/library/sections") => json!({"MediaContainer":{"Directory":[{"key":"5","type":"artist","uuid":"library"}]}}),
                        ("GET", "/proxy/library/metadata/19") => json!({"MediaContainer":{"Metadata":[{"ratingKey":"19","title":"Weekly Jams","playlistType":"audio","smart":false,"leafCount":1,"summary":description}]}}),
                        ("GET", "/proxy/playlists/19/items") => json!({"MediaContainer":{"size":1,"totalSize":1,"offset":0,"Metadata":[{"ratingKey":"1","librarySectionID":5,"playlistItemID":"11","title":"Song"}]}}),
                        ("PUT", "/proxy/playlists/19") => {
                            writes += 1;
                            let query = uri.query_pairs().into_owned().collect::<std::collections::BTreeMap<_,_>>();
                            assert_eq!(query.len(),1);
                            assert_eq!(query["summary"],"Weekly Jams for week 2026-10-05");
                            assert!(request.to_lowercase().contains("x-plex-token: fixture-token"));
                            if case == 4 || case == 7 {status = 503;}
                            else if case != 2 && case != 6 {description = query["summary"].clone();}
                            json!({})
                        },
                        _ => panic!("Unexpected metadata transport route"),
                    };
                    let body = body.to_string();
                    socket.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
                }
                writes
            });
            let mut client = PlexClient::new(PlexClientConfig {base_url:base,token:"fixture-token".into(),..Default::default()}).unwrap();
            client.library_scope = client.cache_scope_for_library(5,Some("library"));
            let expected = PlaylistSyncState {title:"Weekly Jams".into(),items:vec![PlaylistSyncOccurrence {track_id:"1".into(),occurrence_id:"11".into()}]};
            let before = if case == 1 {"Stale description"} else {"Original description"};
            let after = if case == 3 {"x".repeat(5001)} else {"Weekly Jams for week 2026-10-05".into()};
            let result = tokio::time::timeout(std::time::Duration::from_secs(10), async {
                if case >= 5 {
                    client.edit_playlist(19,None,Some(&after)).await?;
                    return Ok(after.clone());
                }
                let prepared = client.prepare_playlist_description(5,19,&expected,before,&after).await?;
                client.commit_playlist_description_once(&prepared).await?;
                client.verify_playlist_description(&prepared).await
            }).await.expect("Bounded metadata update must finish");
            let _ = stop.send(());
            assert_eq!(server.await.unwrap(),if case == 1 || case == 3 {0} else {1});
            if case == 0 || case == 5 {assert_eq!(result.unwrap(),after)} else {assert!(result.is_err());}
        }
    }
}
