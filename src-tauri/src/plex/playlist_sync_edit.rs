//! One-verb, non-retrying linked playlist edits with ordered occurrence preflight.
use super::PlexClient;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistSyncOccurrence {
    pub track_id: String,
    pub occurrence_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct PlaylistSyncState {
    pub title: String,
    pub items: Vec<PlaylistSyncOccurrence>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PlaylistSyncOperation {
    Append {
        #[serde(rename = "trackId")]
        track_id: String,
    },
    Move {
        from: usize,
        to: usize,
    },
    Delete {
        index: usize,
    },
}
pub struct PreparedPlaylistSyncEdit {
    section_id: i64,
    playlist_id: i64,
    expected: PlaylistSyncState,
    operation: PlaylistSyncOperation,
    after: Vec<String>,
    scope: String,
}
fn positive(value: &str) -> Result<i64> {
    let id = value
        .parse::<i64>()
        .context("Invalid playlist occurrence ID")?;
    if id <= 0 || id.to_string() != value {
        bail!("Invalid playlist occurrence ID")
    }
    Ok(id)
}
impl PlaylistSyncState {
    pub fn validate(&self) -> Result<()> {
        if self.title.is_empty() || self.title.len() > 2000 || self.items.len() > 1000 {
            bail!("Invalid or oversized playlist")
        };
        let mut ids = HashSet::new();
        for item in &self.items {
            positive(&item.track_id)?;
            positive(&item.occurrence_id)?;
            if !ids.insert(&item.occurrence_id) {
                bail!("Repeated playlist occurrence")
            }
        }
        Ok(())
    }
    pub fn after_ids(&self, operation: &PlaylistSyncOperation) -> Result<Vec<String>> {
        self.validate()?;
        let mut ids: Vec<_> = self
            .items
            .iter()
            .map(|item| item.track_id.clone())
            .collect();
        match operation {
            PlaylistSyncOperation::Append { track_id } => {
                positive(track_id)?;
                if ids.len() >= 1000 {
                    bail!("Playlist item limit reached")
                };
                ids.push(track_id.clone())
            }
            PlaylistSyncOperation::Move { from, to } => {
                if *from >= ids.len() || *to >= ids.len() || from == to {
                    bail!("Invalid playlist move")
                };
                let id = ids.remove(*from);
                ids.insert(*to, id)
            }
            PlaylistSyncOperation::Delete { index } => {
                if *index >= ids.len() {
                    bail!("Invalid playlist occurrence")
                };
                ids.remove(*index);
            }
        };
        Ok(ids)
    }
}
impl PlexClient {
    pub async fn playlist_sync_state(
        &self,
        section_id: i64,
        playlist_id: i64,
    ) -> Result<PlaylistSyncState> {
        if self.offline_only || section_id <= 0 || playlist_id <= 0 {
            bail!("Reconnect to the linked Plex music library")
        }
        let section = self.get_section(section_id).await?;
        if section.key != section_id
            || section.section_type != "artist"
            || (self.library_scope
                != self.cache_scope_for_library(section_id, section.uuid.as_deref())
                && self.library_scope != self.cache_scope_for_library(section_id, None))
        {
            bail!("Linked Plex music library changed")
        }
        let playlist = self.get_playlist(playlist_id).await?;
        if playlist.rating_key != playlist_id
            || playlist.smart
            || playlist.radio
            || playlist.playlist_type != "audio"
        {
            bail!("Linked sync requires a regular music playlist")
        }
        // One bounded server response avoids mixing occurrence order across pages.
        let page = self
            .get_playlist_items_page(playlist_id, Some(1000), Some(0))
            .await?;
        if page.total < 0
            || page.total > 1000
            || page.total != page.items.len() as i64
            || playlist.leaf_count != page.total
            || page.offset.is_some_and(|offset| offset != 0)
        {
            bail!("Incomplete or changed playlist snapshot")
        }
        let mut items = Vec::with_capacity(page.items.len());
        for track in page.items {
            if track.library_section_id != section_id {
                bail!("Playlist contains tracks from another music library")
            };
            let occurrence = track
                .playlist_item_id
                .filter(|id| *id > 0)
                .context("Playlist occurrence handle missing")?;
            items.push(PlaylistSyncOccurrence {
                track_id: track.rating_key.to_string(),
                occurrence_id: occurrence.to_string(),
            })
        }
        let state = PlaylistSyncState {
            title: playlist.title,
            items,
        };
        state.validate()?;
        Ok(state)
    }
    pub async fn prepare_playlist_sync_edit(
        &self,
        section_id: i64,
        playlist_id: i64,
        expected: &PlaylistSyncState,
        operation: &PlaylistSyncOperation,
    ) -> Result<PreparedPlaylistSyncEdit> {
        let after = expected.after_ids(operation)?;
        if let PlaylistSyncOperation::Append { track_id } = operation {
            let track = self.get_track(positive(track_id)?).await?;
            if track.library_section_id != section_id {
                bail!("New track belongs to another library")
            }
            if self.machine_identifier.is_empty() {
                bail!("Plex server identity unavailable")
            }
        }
        if self.playlist_sync_state(section_id, playlist_id).await? != *expected {
            bail!("Playlist changed. Review again before updating")
        }
        Ok(PreparedPlaylistSyncEdit {
            section_id,
            playlist_id,
            expected: expected.clone(),
            operation: operation.clone(),
            after,
            scope: self.library_scope.clone(),
        })
    }
    /// Send the admitted verb once using its captured original client.
    pub async fn commit_playlist_sync_edit_once(
        &self,
        prepared: &PreparedPlaylistSyncEdit,
    ) -> Result<()> {
        if self.offline_only || self.library_scope != prepared.scope {
            bail!("Linked Plex connection changed")
        }
        let playlist_id = prepared.playlist_id;
        let expected = &prepared.expected;
        let operation = &prepared.operation;
        match operation {
            PlaylistSyncOperation::Append { track_id } => {
                let uri = format!(
                    "server://{}/com.plexapp.plugins.library/library/metadata/{track_id}",
                    self.machine_identifier
                );
                self.mutate_params_once(
                    reqwest::Method::PUT,
                    &format!("/playlists/{playlist_id}/items"),
                    &[("uri", &uri)],
                    None,
                    None,
                )
                .await?;
            }
            PlaylistSyncOperation::Move { from, to } => {
                let item = &expected.items[*from];
                let after_id = if *to == 0 {
                    "0"
                } else {
                    // Plex inserts after an occurrence in the remaining list.
                    // Removing a source before the destination shifts that
                    // predecessor one position forward in the original list.
                    let predecessor = if from < to { *to } else { *to - 1 };
                    &expected.items[predecessor].occurrence_id
                };
                self.mutate_params_once(
                    reqwest::Method::PUT,
                    &format!("/playlists/{playlist_id}/items/{}/move", item.occurrence_id),
                    &[("after", after_id)],
                    None,
                    None,
                )
                .await?;
            }
            PlaylistSyncOperation::Delete { index } => {
                self.mutate_params_once(
                    reqwest::Method::DELETE,
                    &format!(
                        "/playlists/{playlist_id}/items/{}",
                        expected.items[*index].occurrence_id
                    ),
                    &[],
                    None,
                    None,
                )
                .await?;
            }
        }
        Ok(())
    }
    pub async fn verify_playlist_sync_edit(
        &self,
        prepared: &PreparedPlaylistSyncEdit,
    ) -> Result<PlaylistSyncState> {
        if self.offline_only || self.library_scope != prepared.scope {
            bail!("Linked Plex connection changed")
        }
        let actual = self
            .playlist_sync_state(prepared.section_id, prepared.playlist_id)
            .await?;
        if actual.title != prepared.expected.title
            || actual
                .items
                .iter()
                .map(|item| &item.track_id)
                .ne(prepared.after.iter())
        {
            bail!("Playlist update outcome requires reconciliation")
        }
        Ok(actual)
    }
}

#[cfg(test)]
mod tests {
    use super::super::PlexClientConfig;
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};
    fn state() -> PlaylistSyncState {
        PlaylistSyncState {
            title: "Ordered".into(),
            items: vec![
                PlaylistSyncOccurrence {
                    track_id: "1".into(),
                    occurrence_id: "11".into(),
                },
                PlaylistSyncOccurrence {
                    track_id: "2".into(),
                    occurrence_id: "12".into(),
                },
                PlaylistSyncOccurrence {
                    track_id: "1".into(),
                    occurrence_id: "13".into(),
                },
            ],
        }
    }
    fn loopback(
        operation: PlaylistSyncOperation,
    ) -> (PlexClient, std::thread::JoinHandle<Vec<String>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/proxy", listener.local_addr().unwrap());
        let count = if matches!(&operation, PlaylistSyncOperation::Append { .. }) {
            8
        } else {
            7
        };
        let thread = std::thread::spawn(move || {
            let mut items = vec![(1_i64, 11_i64), (2, 12), (1, 13)];
            let mut requests = Vec::new();
            for _ in 0..count {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut chunk = [0; 2048];
                loop {
                    let size = stream.read(&mut chunk).unwrap();
                    if size == 0 {
                        break;
                    };
                    bytes.extend_from_slice(&chunk[..size]);
                    if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.strip_prefix("content-length:")
                                    .and_then(|value| value.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                let request = String::from_utf8(bytes).unwrap();
                let first = request.lines().next().unwrap();
                let parts: Vec<_> = first.split_whitespace().collect();
                let method = parts[0];
                let url = url::Url::parse(&format!("http://test{}", parts[1])).unwrap();
                let path = url.path();
                let body = if method == "GET" && path == "/proxy/library/sections" {
                    json!({"MediaContainer":{"Directory":[{"key":"5","type":"artist","uuid":"library"}]}})
                } else if method == "GET" && path == "/proxy/library/metadata/19" {
                    json!({"MediaContainer":{"Metadata":[{"ratingKey":"19","title":"Ordered","playlistType":"audio","smart":false,"radio":false,"leafCount":items.len()}]}})
                } else if method == "GET" && path == "/proxy/playlists/19/items" {
                    let query: std::collections::HashMap<_, _> =
                        url.query_pairs().into_owned().collect();
                    assert_eq!(
                        query.get("X-Plex-Container-Size").map(String::as_str),
                        Some("1000")
                    );
                    assert_eq!(
                        query.get("X-Plex-Container-Start").map(String::as_str),
                        Some("0")
                    );
                    json!({"MediaContainer":{"size":items.len(),"totalSize":items.len(),"offset":0,"Metadata":items.iter().map(|(track,occurrence)|json!({"ratingKey":track.to_string(),"title":"Song","librarySectionID":5,"playlistItemID":occurrence.to_string()})).collect::<Vec<_>>()}})
                } else if method == "GET" && path == "/proxy/library/metadata/1" {
                    json!({"MediaContainer":{"Metadata":[{"ratingKey":"1","title":"Song","librarySectionID":5}]}})
                } else {
                    match &operation {
                        PlaylistSyncOperation::Append { track_id } => {
                            assert_eq!(method, "PUT");
                            assert_eq!(path, "/proxy/playlists/19/items");
                            let uri = url
                                .query_pairs()
                                .find(|(key, _)| key == "uri")
                                .unwrap()
                                .1
                                .into_owned();
                            assert_eq!(uri,format!("server://machine/com.plexapp.plugins.library/library/metadata/{track_id}"));
                            items.push((track_id.parse().unwrap(), 14));
                        }
                        PlaylistSyncOperation::Move { from, to: _ } => {
                            assert_eq!(method, "PUT");
                            assert_eq!(
                                path,
                                format!("/proxy/playlists/19/items/{}/move", items[*from].1)
                            );
                            let after = url
                                .query_pairs()
                                .find(|(key, _)| key == "after")
                                .unwrap()
                                .1
                                .parse::<i64>()
                                .unwrap();
                            let item = items.remove(*from);
                            // Simulate the API's actual insert-after semantics,
                            // rather than moving to the implementation's target.
                            let insertion = if after == 0 {
                                0
                            } else {
                                items
                                    .iter()
                                    .position(|(_, id)| *id == after)
                                    .expect("predecessor must remain after source removal")
                                    + 1
                            };
                            items.insert(insertion, item);
                        }
                        PlaylistSyncOperation::Delete { index } => {
                            assert_eq!(method, "DELETE");
                            assert_eq!(
                                path,
                                format!("/proxy/playlists/19/items/{}", items[*index].1)
                            );
                            items.remove(*index);
                        }
                    };
                    json!({})
                };
                assert!(request
                    .to_lowercase()
                    .contains("x-plex-token: offline-token"));
                assert_eq!(
                    url.query_pairs()
                        .filter(|(key, _)| key == "includeLoudnessRamps")
                        .count(),
                    if method == "GET" { 1 } else { 0 }
                );
                requests.push(request);
                let body = body.to_string();
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
            }
            requests
        });
        let mut client = PlexClient::new(PlexClientConfig {
            base_url: base,
            token: "offline-token".into(),
            ..Default::default()
        })
        .unwrap();
        client.machine_identifier = "machine".into();
        client.library_scope = client.cache_scope_for_library(5, Some("library"));
        (client, thread)
    }
    #[tokio::test]
    async fn fresh_smart_playlist_flag_blocks_sync_write_after_regular_source_read() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/proxy", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut methods = Vec::new();
            for index in 0..3 {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                    .unwrap();
                let mut request = Vec::new();
                let mut chunk = [0; 2048];
                while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    let size = stream.read(&mut chunk).unwrap();
                    assert!(size > 0);
                    request.extend_from_slice(&chunk[..size]);
                }
                let request = String::from_utf8(request).unwrap();
                let first = request.lines().next().unwrap();
                let parts: Vec<_> = first.split_whitespace().collect();
                methods.push(parts[0].to_owned());
                assert_eq!(parts[0], "GET", "Smart preflight must not issue a mutation");
                let path = url::Url::parse(&format!("http://test{}", parts[1])).unwrap();
                let body = if index == 1 {
                    assert_eq!(path.path(), "/proxy/library/sections");
                    json!({"MediaContainer":{"Directory":[{"key":"5","type":"artist","uuid":"library"}]}})
                } else {
                    assert_eq!(path.path(), "/proxy/library/metadata/19");
                    json!({"MediaContainer":{"Metadata":[{"ratingKey":"19","title":"Ordered","playlistType":"audio","smart":index == 2,"radio":false,"leafCount":3}]}})
                }.to_string();
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
            }
            methods
        });
        let mut client = PlexClient::new(PlexClientConfig {
            base_url: base,
            token: "offline-token".into(),
            ..Default::default()
        })
        .unwrap();
        client.machine_identifier = "machine".into();
        client.library_scope = client.cache_scope_for_library(5, Some("library"));
        assert!(!client.get_playlist(19).await.unwrap().smart);
        let result = client
            .prepare_playlist_sync_edit(
                5,
                19,
                &state(),
                &PlaylistSyncOperation::Move { from: 0, to: 1 },
            )
            .await;
        assert!(result
            .err()
            .unwrap()
            .to_string()
            .contains("regular music playlist"));
        assert_eq!(server.join().unwrap(), vec!["GET", "GET", "GET"]);
    }

    #[tokio::test]
    async fn one_verb_transport_preserves_duplicate_handles_proxy_paths_and_postproof() {
        for operation in [
            PlaylistSyncOperation::Append {
                track_id: "1".into(),
            },
            PlaylistSyncOperation::Move { from: 2, to: 1 },
            PlaylistSyncOperation::Move { from: 0, to: 1 },
            PlaylistSyncOperation::Move { from: 0, to: 2 },
            PlaylistSyncOperation::Move { from: 1, to: 0 },
            PlaylistSyncOperation::Move { from: 1, to: 2 },
            PlaylistSyncOperation::Move { from: 2, to: 0 },
            PlaylistSyncOperation::Delete { index: 1 },
        ] {
            let expected = state();
            let after = expected.after_ids(&operation).unwrap();
            let (client, server) = loopback(operation.clone());
            let prepared = client
                .prepare_playlist_sync_edit(5, 19, &expected, &operation)
                .await
                .unwrap();
            client
                .commit_playlist_sync_edit_once(&prepared)
                .await
                .unwrap();
            let actual = client.verify_playlist_sync_edit(&prepared).await.unwrap();
            assert_eq!(
                actual
                    .items
                    .iter()
                    .map(|item| item.track_id.clone())
                    .collect::<Vec<_>>(),
                after
            );
            let requests = server.join().unwrap();
            assert_eq!(
                requests
                    .iter()
                    .filter(|request| !request.starts_with("GET "))
                    .count(),
                1
            );
        }
    }
    #[test]
    fn invalid_occurrence_and_duplicate_handle_inputs_are_rejected_before_io() {
        let expected = state();
        assert!(expected
            .after_ids(&PlaylistSyncOperation::Append {
                track_id: "01".into()
            })
            .is_err());
        assert!(expected
            .after_ids(&PlaylistSyncOperation::Move { from: 2, to: 2 })
            .is_err());
        assert!(expected
            .after_ids(&PlaylistSyncOperation::Move { from: 0, to: 3 })
            .is_err());
        assert!(expected
            .after_ids(&PlaylistSyncOperation::Delete { index: 3 })
            .is_err());
        let mut duplicate = expected;
        duplicate.items[1].occurrence_id = "11".into();
        assert!(duplicate.validate().is_err());
    }
}
