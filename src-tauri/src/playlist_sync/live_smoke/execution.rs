//! Ignored live QA bridge. No arbitrary resource identifiers or delete route.
use super::*;
use crate::plex::playlist_sync_edit::{PlaylistSyncOperation, PlaylistSyncState};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
struct Bridge {
    config: PathBuf,
    path: PathBuf,
    manifest: Value,
    client: PlexClient,
    section: i64,
    account: Credentials,
    stopped: bool,
}
impl Bridge {
    fn guard(&self) -> Result<()> {
        if self.stopped {
            bail!("QA halted; inspect retained manifest")
        }
        current(
            &self.config,
            self.manifest["binding"]
                .as_str()
                .context("Binding missing")?,
        )?;
        owned(&self.config, &self.account.account)?;
        Ok(())
    }
    fn retain(&self) -> Result<()> {
        private_write(&self.path, &self.manifest)
    }
    fn library_id(&self) -> Result<i64> {
        self.manifest["libraryId"]
            .as_str()
            .context("Fresh QA library ID missing")?
            .parse()
            .context("Invalid QA ID")
    }
    fn remote_id(&self) -> Result<&str> {
        self.manifest["remoteId"]
            .as_str()
            .context("Fresh QA remote ID missing")
    }
    fn mappings(&self) -> Result<&Vec<Value>> {
        self.manifest["tracks"]
            .as_array()
            .filter(|v| v.len() == 3)
            .context("Three verified mappings required")
    }
    fn allowed(&self, id: &str, remote: bool) -> bool {
        self.mappings().is_ok_and(|m| {
            m.iter().any(|t| {
                if remote {
                    t["recordingMbid"].as_str() == Some(id)
                } else {
                    t["libraryTrack"]["id"].as_str() == Some(id)
                }
            })
        })
    }
    fn title(&self) -> Result<&str> {
        self.manifest["title"].as_str().context("QA title missing")
    }
    async fn library(&self) -> Result<Value> {
        self.guard()?;
        let state = self
            .client
            .playlist_sync_state(self.section, self.library_id()?)
            .await?;
        if state.title != self.title()?
            || state.items.len() > 12
            || state
                .items
                .iter()
                .any(|i| !self.allowed(&i.track_id, false))
        {
            bail!("QA library resource ownership changed")
        }
        self.guard()?;
        let items = state
            .items
            .iter()
            .map(|i| {
                let mapping = self
                    .mappings()
                    .unwrap()
                    .iter()
                    .find(|m| m["libraryTrack"]["id"].as_str() == Some(i.track_id.as_str()))
                    .unwrap();
                let mut track = mapping["libraryTrack"].clone();
                track["recordingMbid"] = mapping["recordingMbid"].clone();
                json!({"occurrenceId":i.occurrence_id,"track":track})
            })
            .collect::<Vec<_>>();
        Ok(
            json!({"account":self.manifest["libraryAccount"],"id":self.manifest["libraryId"],"title":state.title,"items":items}),
        )
    }
    async fn remote(&self) -> Result<Value> {
        self.guard()?;
        let id = self.remote_id()?;
        let value = read_from(&CLIENT, BASE, &self.account.token, id).await?;
        if value.pointer("/playlist/title").and_then(Value::as_str) != Some(self.title()?)
            || value.pointer("/playlist/creator").and_then(Value::as_str)
                != Some(self.account.account.user.as_str())
            || value
                .pointer("/playlist/extension/https:~1~1musicbrainz.org~1doc~1jspf#playlist/public")
                .and_then(Value::as_bool)
                != Some(false)
            || recording_ids(&value, id)?
                .iter()
                .any(|i| !self.allowed(i, true))
        {
            bail!("QA remote resource ownership changed")
        }
        self.guard()?;
        Ok(value)
    }
    fn intent(&mut self, service: &str, operation: &Value) -> Result<()> {
        self.guard()?;
        let count = self.manifest["mutationCount"].as_u64().unwrap_or(0);
        if count
            >= if self.manifest["setupAppendIntent"].is_null() {
                7
            } else {
                8
            }
        {
            bail!("QA mutation budget exhausted")
        }
        self.manifest["mutationCount"] = json!(count + 1);
        self.manifest["pendingMutation"] =
            json!({"service":service,"operation":operation,"state":"unconfirmed"});
        self.retain()
    }
    async fn dispatch(&mut self, action: &str, payload: Value) -> Result<Value> {
        self.guard()?;
        match action {
            "session" => Ok(
                json!({"runId":self.manifest["runId"],"title":self.manifest["title"],"libraryId":self.manifest["libraryId"],"remoteId":self.manifest["remoteId"],"libraryAccount":self.manifest["libraryAccount"],"remoteAccount":self.manifest["remoteAccount"],"tracks":self.manifest["tracks"],"initialLayout":self.manifest["initialLayout"]}),
            ),
            "library.read" => self.library().await,
            "remote.read" => self.remote().await,
            "remote.account" => Ok(serde_json::to_value(&self.account.account)?),
            "journal.retain" => {
                let rows = payload
                    .as_array()
                    .filter(|v| v.len() == 1)
                    .context("One QA link required")?;
                let link = &rows[0];
                if link["libraryPlaylistId"] != self.manifest["libraryId"]
                    || link["listenbrainzPlaylistId"] != self.manifest["remoteId"]
                    || link["library"] != self.manifest["libraryAccount"]
                    || link["listenbrainz"] != self.manifest["remoteAccount"]
                {
                    bail!("Unowned journal")
                }
                self.manifest["journal"] = payload;
                self.retain()?;
                Ok(json!(null))
            }
            "proof.stage" => {
                let stages = self.manifest["proof"]
                    .as_array_mut()
                    .context("QA proof missing")?;
                if stages.len() >= 5 {
                    bail!("QA stage budget exhausted")
                }
                stages.push(payload);
                self.retain()?;
                Ok(json!(null))
            }
            "library.mutate" => {
                let before = self.library().await?;
                if payload["before"] != before {
                    bail!("QA library preview changed")
                }
                let operation: PlaylistSyncOperation =
                    serde_json::from_value(payload["operation"].clone())?;
                if let PlaylistSyncOperation::Append { track_id } = &operation {
                    if !self.allowed(track_id, false) {
                        bail!("Unverified QA track")
                    }
                }
                if matches!(operation, PlaylistSyncOperation::Delete { .. }) {
                    bail!("No QA deletion route")
                }
                let expected: PlaylistSyncState = serde_json::from_value(
                    json!({"title":before["title"],"items":before["items"].as_array().unwrap().iter().map(|i|json!({"trackId":i["track"]["id"],"occurrenceId":i["occurrenceId"]})).collect::<Vec<_>>()}),
                )?;
                let prepared = self
                    .client
                    .prepare_playlist_sync_edit(
                        self.section,
                        self.library_id()?,
                        &expected,
                        &operation,
                    )
                    .await?;
                self.intent("library", &payload["operation"])?;
                self.guard()?;
                self.client
                    .commit_playlist_sync_edit_once(&prepared)
                    .await?;
                self.guard()?;
                self.client.verify_playlist_sync_edit(&prepared).await?;
                let result = self.library().await?;
                self.manifest["pendingMutation"] = json!(null);
                self.retain()?;
                Ok(result)
            }
            "remote.mutate" => {
                let before = self.remote().await?;
                let supplied = &payload["before"];
                if supplied["account"] != self.manifest["remoteAccount"]
                    || supplied["id"] != self.manifest["remoteId"]
                    || supplied["title"] != before["playlist"]["title"]
                {
                    bail!("QA remote preview changed")
                }
                let mbids = supplied["items"]
                    .as_array()
                    .context("QA items missing")?
                    .iter()
                    .map(|i| {
                        i["track"]["recordingMbid"]
                            .as_str()
                            .map(str::to_owned)
                            .context("Verified recording missing")
                    })
                    .collect::<Result<Vec<_>>>()?;
                if recording_ids(&before, self.remote_id()?)? != mbids {
                    bail!("QA remote order changed")
                }
                let operation: ListenBrainzOperation =
                    serde_json::from_value(payload["operation"].clone())?;
                if let ListenBrainzOperation::Append { track_id } = &operation {
                    if !self.allowed(track_id, true) {
                        bail!("Unverified QA recording")
                    }
                }
                if matches!(operation, ListenBrainzOperation::Delete { .. }) {
                    bail!("No QA deletion route")
                }
                let expected = ListenBrainzExpected {
                    title: self.title()?.to_owned(),
                    mbids,
                };
                self.intent("listenbrainz", &payload["operation"])?;
                let result = mutate_from(
                    &CLIENT,
                    BASE,
                    &self.account.token,
                    self.remote_id()?,
                    &expected,
                    &operation,
                    || self.guard(),
                )
                .await?;
                self.remote().await?;
                self.manifest["pendingMutation"] = json!(null);
                self.retain()?;
                Ok(result)
            }
            _ => bail!("Unsupported QA action"),
        }
    }
}
async fn read_request(stream: &mut tokio::net::TcpStream, nonce: &str) -> Result<Value> {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let count =
            tokio::time::timeout(std::time::Duration::from_secs(5), stream.read(&mut chunk))
                .await??;
        if count == 0 {
            bail!("Incomplete QA request")
        }
        bytes.extend_from_slice(&chunk[..count]);
        if bytes.len() > 131072 {
            bail!("Oversized QA request")
        }
        if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            let header = std::str::from_utf8(&bytes[..end])?;
            if !header.starts_with("POST /qa HTTP/1.1\r\n") {
                bail!("Invalid QA route")
            }
            let mut length = None;
            let mut authorized = false;
            for line in header.lines().skip(1) {
                let (key, value) = line.split_once(':').context("Invalid QA header")?;
                if key.eq_ignore_ascii_case("authorization") {
                    if authorized || value.trim() != format!("Bearer {nonce}") {
                        bail!("Invalid QA lease")
                    };
                    authorized = true;
                }
                if key.eq_ignore_ascii_case("content-length") {
                    if length.is_some() {
                        bail!("Ambiguous QA body")
                    };
                    length = Some(value.trim().parse::<usize>()?);
                }
                if key.eq_ignore_ascii_case("transfer-encoding") {
                    bail!("Unsupported QA body")
                }
            }
            let length = length
                .filter(|v| *v <= 65536)
                .context("Bounded QA body required")?;
            if !authorized {
                bail!("QA authorization required")
            }
            if bytes.len() >= end + 4 + length {
                return Ok(serde_json::from_slice(&bytes[end + 4..end + 4 + length])?);
            }
        }
    }
}
pub(super) async fn execute(config: &Path, run: &str, distinct_continuation: bool) -> Result<()> {
    let path = qa_directory(run)?.join("manifest.json");
    let manifest: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    let common = manifest["runId"] == run
        && manifest["title"] == format!("Hibiki QA {run}")
        && manifest["remoteId"].is_null();
    let admitted = if distinct_continuation {
        std::env::var("HIBIKI_QA_REVIEWED_DISTINCT_CONTINUATION")
            .ok()
            .as_deref()
            == Some(run)
            && manifest["phase"] == "halted"
            && manifest["libraryId"].as_str().is_some()
            && manifest["mutationCount"] == 1
            && manifest["metadataIntent"].is_null()
            && manifest["setupAppendIntent"]["state"] == "unconfirmed"
            && manifest["distinctContinuationIntent"].is_null()
            && manifest["distinctContinuationPlan"]["state"] == "prepared-read-only"
            && manifest["setupAppendIntent"]["appendTrackId"]
                == manifest["tracks"][0]["libraryTrack"]["id"]
            && manifest["initialOrderDiagnostic"]["actual"]
                .as_array()
                .is_some_and(|a| a.len() == 2)
            && manifest["creationIntents"]
                .as_array()
                .is_some_and(|a| a.len() == 1 && a[0]["service"] == "library")
    } else {
        std::env::var("HIBIKI_QA_REVIEWED_RUN").ok().as_deref() == Some(run)
            && manifest["phase"] == "prepared"
            && manifest["libraryId"].is_null()
            && manifest["creationIntents"]
                .as_array()
                .is_some_and(Vec::is_empty)
    };
    if !common || !admitted {
        bail!("Exact reviewed fresh or known two-track QA setup required")
    }
    let settings = crate::plex::load_settings(config)?;
    let mut state = Bridge {
        config: config.to_owned(),
        path,
        manifest,
        client: client(&settings)?,
        section: settings.section_id,
        account: credentials(config)?,
        stopped: false,
    };
    state.guard()?;
    let mappings = state.mappings()?.clone();
    if mappings
        .iter()
        .map(|m| m["recordingMbid"].as_str())
        .collect::<std::collections::BTreeSet<_>>()
        .len()
        != 3
    {
        bail!("Distinct recording proof required")
    }
    // Recheck actual machine, section, and LB authenticated identity before any create.
    if state.client.get_identity().await?.machine_identifier != settings.machine_identifier {
        bail!("QA machine changed")
    }
    let section = state.client.get_section(settings.section_id).await?;
    if section.section_type != "artist"
        || section.uuid.as_deref() != Some(settings.section_uuid.as_str())
    {
        bail!("QA library changed")
    }
    let auth = response(
        CLIENT
            .get(endpoint(BASE, &["validate-token"])?)
            .header("Authorization", format!("Token {}", state.account.token)),
    )
    .await?;
    if auth["valid"] != true
        || auth["user_name"].as_str() != Some(state.account.account.user.as_str())
    {
        bail!("QA remote account changed")
    }
    let tracks = [&mappings[0], &mappings[1], &mappings[0]];
    let ids = tracks
        .iter()
        .map(|m| {
            m["libraryTrack"]["id"]
                .as_str()
                .context("QA track missing")?
                .parse::<i64>()
                .context("Invalid QA track")
        })
        .collect::<Result<Vec<_>>>()?;
    state.manifest["phase"] = json!("executing");
    if distinct_continuation {
        let before = state.library().await?;
        let actual = before["items"]
            .as_array()
            .context("QA reconciliation items missing")?
            .iter()
            .map(|i| {
                i["track"]["id"]
                    .as_str()
                    .map(str::to_owned)
                    .context("QA track missing")
            })
            .collect::<Result<Vec<_>>>()?;
        if actual != ids[..2].iter().map(i64::to_string).collect::<Vec<_>>() {
            bail!("Reviewed unchanged QA [A,B] proof changed")
        }
        state.manifest["reviewedSetupReceipt"] = json!({"originalIntent":state.manifest["setupAppendIntent"],"originalMutation":state.manifest["pendingMutation"],"decision":"reviewed-not-applied","proof":before});
        state.manifest["pendingMutation"] = json!(null);
        state.manifest["distinctContinuationIntent"] =
            json!({"state":"admitted","initialTrackIds":ids[..2],"workflowWrites":7});
        state.manifest["initialLayout"] = json!("distinct");
        state.retain()?;
    } else {
        state.manifest["creationIntents"] = json!([{"service":"library","state":"unconfirmed"}]);
        state.retain()?;
        state.guard()?;
        let created = state
            .client
            .create_playlist(state.title()?, state.section, &ids)
            .await?;
        state.manifest["libraryId"] = json!(created.rating_key.to_string());
        state.retain()?;
    }
    let wanted = if distinct_continuation {
        &ids[..2]
    } else {
        &ids[..]
    };
    let initial = state.library().await?;
    if initial["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["track"]["id"].as_str().unwrap())
        .collect::<Vec<_>>()
        != wanted
            .iter()
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
    {
        bail!("QA initial duplicate order failed")
    }
    // Playlist-only metadata smoke: direct one-request transport, then exact fresh proof.
    let edited = format!("{} · metadata verified", state.title()?);
    let summary =
        "Disposable Hibiki QA playlist. Ordered sync and metadata proof; not user library content.";
    state.manifest["metadataIntent"] =
        json!({"state":"unconfirmed","title":edited,"summary":summary});
    state.retain()?;
    state.library().await?;
    state.guard()?;
    state
        .client
        .put_metadata_params_once(
            &format!("/playlists/{}", state.library_id()?),
            &[("title", edited.as_str()), ("summary", summary)],
        )
        .await?;
    let item: Value = state
        .client
        .get(&format!("/playlists/{}", state.library_id()?))
        .await?;
    let rows = item["Metadata"]
        .as_array()
        .filter(|a| a.len() == 1)
        .context("QA metadata proof missing")?;
    if rows[0]["ratingKey"]
        .as_i64()
        .or_else(|| rows[0]["ratingKey"].as_str()?.parse().ok())
        != Some(state.library_id()?)
        || rows[0]["type"] != "playlist"
        || rows[0]["title"] != edited
        || rows[0]["summary"] != summary
    {
        bail!("QA metadata not confirmed")
    }
    // Restore original unique name, also once and proven; shared TS session expects it.
    state.manifest["metadataRestoreIntent"] =
        json!({"state":"unconfirmed","title":state.manifest["title"]});
    state.retain()?;
    state.guard()?;
    state
        .client
        .put_metadata_params_once(
            &format!("/playlists/{}", state.library_id()?),
            &[("title", state.title()?)],
        )
        .await?;
    state.library().await?;
    state.manifest["metadataIntent"]["state"] = json!("verified");
    state.manifest["metadataRestoreIntent"]["state"] = json!("verified");
    state.retain()?;
    state.manifest["creationIntents"]
        .as_array_mut()
        .unwrap()
        .push(json!({"service":"listenbrainz","state":"unconfirmed"}));
    state.retain()?;
    state.guard()?;
    let mbids = tracks[..if distinct_continuation { 2 } else { 3 }]
        .iter()
        .map(|m| {
            m["recordingMbid"]
                .as_str()
                .map(str::to_owned)
                .context("Recording missing")
        })
        .collect::<Result<Vec<_>>>()?;
    let id = create_from(&CLIENT, BASE, &state.account.token, state.title()?, &mbids, || state.guard()).await?;
    state.manifest["remoteId"] = json!(id);
    state.retain()?;
    let value = state.remote().await?;
    if recording_ids(&value, state.remote_id()?)? != mbids {
        bail!("QA initial remote order failed")
    }
    state.manifest["creationIntents"] = json!([{"service":"library","state":"verified"},{"service":"listenbrainz","state":"verified"}]);
    state.retain()?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let nonce = uuid::Uuid::new_v4().to_string();
    let mut child = tokio::process::Command::new("bun")
        .arg("tests/fixtures/livePlaylistSync/entry.ts")
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut input = child.stdin.take().context("QA child input missing")?;
    input
        .write_all(
            serde_json::to_string(
                &json!({"origin":format!("http://{}",listener.local_addr()?),"access":nonce}),
            )?
            .as_bytes(),
        )
        .await?;
    input.shutdown().await?;
    drop(input);
    let deadline = tokio::time::sleep(std::time::Duration::from_secs(240));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _=&mut deadline=>{state.stopped=true;state.manifest["phase"]=json!("halted");state.retain()?;bail!("QA deadline reached; retained objects require review")},
            status=child.wait()=>{if !status?.success(){state.manifest["phase"]=json!("halted");state.retain()?;bail!("QA child stopped; inspect private retained evidence")};break;},
            accepted=listener.accept()=>{
                let (mut stream,peer)=accepted?;if !peer.ip().is_loopback(){continue}
                let result=match read_request(&mut stream,&nonce).await {Ok(v)=>state.dispatch(v["action"].as_str().unwrap_or(""),v["payload"].clone()).await,Err(e)=>Err(e)};
                let (status,body)=match result {Ok(v)=>("200 OK",v),Err(_)=>{state.stopped=true;state.manifest["phase"]=json!("halted");state.retain()?;("409 Conflict",json!({"error":"QA halted; inspect retained manifest"}))}};
                let body=serde_json::to_vec(&body)?;stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).as_bytes()).await?;stream.write_all(&body).await?;
            }
        }
    }
    state.library().await?;
    state.remote().await?;
    if state.manifest["proof"].as_array().map(Vec::len) != Some(5)
        || state.manifest["mutationCount"]
            != if distinct_continuation {
                json!(8)
            } else {
                json!(7)
            }
        || state.manifest["journal"][0]["paused"] != true
        || !state.manifest["journal"][0]["job"]["step"].is_null()
    {
        bail!("Incomplete QA stage proof")
    }
    state.manifest["phase"] = json!("verified-paused");
    state.retain()?;
    println!("Live disposable QA verified: five stages, seven workflow occurrence writes plus {} retained setup attempt; objects retained for root review.",usize::from(distinct_continuation));
    Ok(())
}

#[tokio::test]
async fn loopback_bridge_requires_nonce_and_unambiguous_bounded_body() {
    for (authorization, extra, accepted) in [
        ("Bearer reviewed-nonce", "", true),
        ("Bearer wrong-nonce", "", false),
        ("Bearer reviewed-nonce", "Content-Length: 2\r\n", false),
        (
            "Bearer reviewed-nonce",
            "Transfer-Encoding: chunked\r\n",
            false,
        ),
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let client = tokio::spawn(async move {
            let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
            let body = r#"{"action":"session"}"#;
            socket.write_all(format!("POST /qa HTTP/1.1\r\nAuthorization: {authorization}\r\nContent-Length: {}\r\n{extra}\r\n{body}",body.len()).as_bytes()).await.unwrap();
        });
        let (mut stream, _) = listener.accept().await.unwrap();
        let result = read_request(&mut stream, "reviewed-nonce").await;
        assert_eq!(result.is_ok(), accepted);
        client.await.unwrap();
    }
}

pub(super) async fn inspect_created(config: &Path, run: &str) -> Result<()> {
    let path = qa_directory(run)?.join("manifest.json");
    let manifest: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    if manifest["runId"] != run || manifest["libraryId"].is_null() {
        bail!("Retained QA resource required")
    }
    let settings = crate::plex::load_settings(config)?;
    let mut state = Bridge {
        config: config.to_owned(),
        path,
        manifest,
        client: client(&settings)?,
        section: settings.section_id,
        account: credentials(config)?,
        stopped: false,
    };
    let snapshot = state.library().await?;
    let expected = [
        &state.mappings()?[0],
        &state.mappings()?[1],
        &state.mappings()?[0],
    ]
    .iter()
    .map(|m| m["libraryTrack"]["id"].clone())
    .collect::<Vec<_>>();
    let actual = snapshot["items"]
        .as_array()
        .context("QA snapshot missing")?
        .iter()
        .map(|i| i["track"]["id"].clone())
        .collect::<Vec<_>>();
    state.manifest["initialOrderDiagnostic"] =
        json!({"expected":expected,"actual":actual,"snapshot":snapshot});
    state.manifest["phase"] = json!("halted");
    state.retain()?;
    println!(
        "Read-only retained QA snapshot: expected {} occurrences, actual {}; no writes.",
        expected.len(),
        actual.len()
    );
    Ok(())
}

pub(super) async fn prepare_distinct(config: &Path, run: &str) -> Result<()> {
    let path = qa_directory(run)?.join("manifest.json");
    let manifest: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    if manifest["phase"] != "halted"
        || manifest["mutationCount"] != 1
        || manifest["setupAppendIntent"]["state"] != "unconfirmed"
        || !manifest["remoteId"].is_null()
        || !manifest["metadataIntent"].is_null()
        || !manifest["distinctContinuationIntent"].is_null()
    {
        bail!("Unchanged reviewed QA setup receipt required")
    }
    let settings = crate::plex::load_settings(config)?;
    let mut state = Bridge {
        config: config.to_owned(),
        path,
        manifest,
        client: client(&settings)?,
        section: settings.section_id,
        account: credentials(config)?,
        stopped: false,
    };
    let snapshot = state.library().await?;
    let actual = snapshot["items"]
        .as_array()
        .context("QA proof missing")?
        .iter()
        .map(|i| i["track"]["id"].clone())
        .collect::<Vec<_>>();
    let expected = state.mappings()?[..2]
        .iter()
        .map(|m| m["libraryTrack"]["id"].clone())
        .collect::<Vec<_>>();
    if actual != expected {
        bail!("QA known unchanged state changed")
    }
    state.manifest["distinctContinuationPlan"] = json!({"state":"prepared-read-only","initialProof":snapshot,"initialLayout":"distinct","reconcileSetup":"explicit reviewed-not-applied, original receipt retained","newPlexCreates":0,"newPrivateListenBrainzCreates":1,"metadataPuts":2,"libraryWorkflowWrites":3,"remoteWorkflowWrites":4,"totalWorkflowOccurrenceWrites":7,"previousSetupRequests":1,"fiveStages":["initial-distinct-order","library-to-listenbrainz","listenbrainz-to-library","both-sided-conflict","simulated-ack-loss-read-only-recovery"]});
    state.retain()?;
    println!("Read-only distinct continuation plan retained: exact [A,B], no new writes.");
    Ok(())
}

pub(super) async fn prepare_cleanup(config: &Path, run: &str) -> Result<()> {
    let path = qa_directory(run)?.join("manifest.json");
    let mut manifest: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    if manifest["phase"] != "verified-paused" {
        bail!("Completed retained QA run required")
    }
    let previous = manifest["reviewedMappingOriginRun"]
        .as_str()
        .context("Prior QA provenance missing")?
        .to_owned();
    let settings = crate::plex::load_settings(config)?;
    let verified_client = client(&settings)?;
    if verified_client.get_identity().await?.machine_identifier != settings.machine_identifier {
        bail!("Cleanup machine changed")
    }
    let section = verified_client.get_section(settings.section_id).await?;
    if section.section_type != "artist"
        || section.uuid.as_deref() != Some(settings.section_uuid.as_str())
    {
        bail!("Cleanup section changed")
    }
    let account = credentials(config)?;
    let auth = response(
        CLIENT
            .get(endpoint(BASE, &["validate-token"])?)
            .header("Authorization", format!("Token {}", account.token)),
    )
    .await?;
    if auth["valid"] != true || auth["user_name"].as_str() != Some(account.account.user.as_str()) {
        bail!("Cleanup remote account changed")
    }
    let mut resources = Vec::new();
    for owner_run in [&previous, run] {
        let owner_path = qa_directory(owner_run)?.join("manifest.json");
        let owner: Value = serde_json::from_slice(&std::fs::read(owner_path)?)?;
        if owner["runId"] != owner_run
            || owner["title"] != format!("Hibiki QA {owner_run}")
            || owner["creationIntents"]
                .as_array()
                .is_none_or(|a| !a.iter().any(|i| i["service"] == "library"))
        {
            bail!("QA creation provenance missing")
        }
        let state = Bridge {
            config: config.to_owned(),
            path: path.clone(),
            manifest: owner,
            client: client(&settings)?,
            section: settings.section_id,
            account: credentials(config)?,
            stopped: false,
        };
        let snapshot = state.library().await?;
        resources.push(json!({"service":"library:Plex","runId":owner_run,"id":state.manifest["libraryId"],"title":snapshot["title"],"occurrenceCount":snapshot["items"].as_array().map(Vec::len),"binding":state.manifest["binding"],"state":"proven-read-only","deleteIntent":"planned-once-not-authorized","postGetExpectedStatus":404}));
        if !state.manifest["remoteId"].is_null() {
            let remote = state.remote().await?;
            resources.push(json!({"service":"listenbrainz","runId":owner_run,"id":state.manifest["remoteId"],"title":remote["playlist"]["title"],"occurrenceCount":recording_ids(&remote,state.remote_id()?)?.len(),"private":true,"account":state.account.account,"state":"proven-read-only","deleteIntent":"planned-once-not-authorized","postGetExpectedStatus":404}));
        }
    }
    if resources.len() != 3 {
        bail!("Expected exactly three test-created resources")
    }
    manifest["cleanupPlan"] =
        json!({"state":"prepared-read-only","resources":resources,"deletionAuthorized":false});
    private_write(&path, &manifest)?;
    println!("Read-only cleanup plan prepared: two test-created Plex QA playlists, one private LB QA playlist; no deletes.");
    Ok(())
}

pub(super) async fn cleanup_reviewed(config: &Path, run: &str) -> Result<()> {
    let path = qa_directory(run)?.join("manifest.json");
    let mut manifest: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    if std::env::var("HIBIKI_QA_REVIEWED_CLEANUP_RUN")
        .ok()
        .as_deref()
        != Some(run)
        || manifest["runId"] != run
        || manifest["phase"] != "verified-paused"
        || manifest["cleanupPlan"]["state"] != "prepared-read-only"
        || !manifest["cleanupExecution"].is_null()
    {
        bail!("Exact fresh reviewed cleanup required; never resume unknown deletes")
    }
    let resources = manifest["cleanupPlan"]["resources"]
        .as_array()
        .filter(|r| r.len() == 3)
        .context("Three reviewed QA resources required")?
        .clone();
    let digest = hex::encode(Sha256::digest(serde_json::to_vec(&resources)?));
    if std::env::var("HIBIKI_QA_REVIEWED_CLEANUP_DIGEST")
        .ok()
        .as_deref()
        != Some(digest.as_str())
    {
        bail!("Reviewed exact cleanup resource digest required")
    }
    let settings = crate::plex::load_settings(config)?;
    let verified_client = client(&settings)?;
    if verified_client.get_identity().await?.machine_identifier != settings.machine_identifier {
        bail!("Cleanup machine changed")
    }
    let section = verified_client.get_section(settings.section_id).await?;
    if section.section_type != "artist"
        || section.uuid.as_deref() != Some(settings.section_uuid.as_str())
    {
        bail!("Cleanup section changed")
    }
    let account = credentials(config)?;
    let auth = response(
        CLIENT
            .get(endpoint(BASE, &["validate-token"])?)
            .header("Authorization", format!("Token {}", account.token)),
    )
    .await?;
    if auth["valid"] != true || auth["user_name"].as_str() != Some(account.account.user.as_str()) {
        bail!("Cleanup authenticated account changed")
    }
    let mut unique = std::collections::BTreeSet::new();
    // Prove all selected resources before admitting any deletion.
    for resource in &resources {
        let owner_run = canonical_mbid(
            resource["runId"]
                .as_str()
                .context("QA provenance missing")?,
        )?;
        if owner_run != run && manifest["reviewedMappingOriginRun"].as_str()!=Some(owner_run.as_str()) {bail!("Cleanup run outside reviewed provenance")};
        if resource["service"]=="listenbrainz" && owner_run!=run {bail!("Foreign QA remote cleanup")};
        let owner_path = qa_directory(&owner_run)?.join("manifest.json");
        let owner: Value = serde_json::from_slice(&std::fs::read(owner_path)?)?;
        if owner["runId"] != owner_run
            || owner["title"] != format!("Hibiki QA {owner_run}")
            || resource["title"] != owner["title"]
            || resource["deleteIntent"] != "planned-once-not-authorized"
        {
            bail!("Cleanup resource provenance changed")
        }
        let state = Bridge {
            config: config.to_owned(),
            path: path.clone(),
            manifest: owner,
            client: client(&settings)?,
            section: settings.section_id,
            account: credentials(config)?,
            stopped: false,
        };
        state.guard()?;
        let service = resource["service"]
            .as_str()
            .context("Cleanup service missing")?;
        let id = resource["id"]
            .as_str()
            .context("Cleanup resource ID missing")?;
        if !unique.insert((service.to_owned(), id.to_owned())) {
            bail!("Duplicate cleanup resource")
        }
        let count = match service {
            "library:Plex" => {
                if resource["id"] != state.manifest["libraryId"] {
                    bail!("Unowned Plex cleanup ID")
                };
                state.library().await?["items"]
                    .as_array()
                    .context("QA snapshot missing")?
                    .len()
            }
            "listenbrainz" => {
                if resource["id"] != state.manifest["remoteId"] {
                    bail!("Unowned LB cleanup ID")
                };
                recording_ids(&state.remote().await?, state.remote_id()?)?.len()
            }
            _ => bail!("Unsupported cleanup service"),
        };
        if resource["occurrenceCount"].as_u64() != Some(count as u64) {
            bail!("QA resource changed since cleanup review")
        }
    }
    manifest["cleanupExecution"] = json!({"state":"admitted","digest":digest,"receipts":[]});
    private_write(&path, &manifest)?;
    for resource in resources {
        let owner_run = resource["runId"].as_str().unwrap();
        let owner: Value = serde_json::from_slice(&std::fs::read(
            qa_directory(owner_run)?.join("manifest.json"),
        )?)?;
        let state = Bridge {
            config: config.to_owned(),
            path: path.clone(),
            manifest: owner,
            client: client(&settings)?,
            section: settings.section_id,
            account: credentials(config)?,
            stopped: false,
        };
        state.guard()?;
        let service = resource["service"].as_str().unwrap();
        let id = resource["id"].as_str().unwrap();
        // Fresh resource proof immediately before each once-only delete.
        if service == "library:Plex" {
            state.library().await?;
        } else {
            state.remote().await?;
        }
        manifest["cleanupExecution"]["receipts"]
            .as_array_mut()
            .unwrap()
            .push(json!({"resource":resource,"state":"unconfirmed"}));
        private_write(&path, &manifest)?;
        state.guard()?;
        let status = if service == "library:Plex" {
            state
                .client
                .mutate_params_once(
                    reqwest::Method::DELETE,
                    &format!("/playlists/{}", state.library_id()?),
                    &[],
                    None,
                    None,
                )
                .await?;
            state.guard()?;
            state
                .client
                .qa_playlist_status_once(state.library_id()?)
                .await?
        } else {
            let ack = response(
                CLIENT
                    .post(endpoint(BASE, &["playlist", id, "delete"])?)
                    .header("Authorization", format!("Token {}", state.account.token)),
            )
            .await?;
            if ack["status"] != "ok" {
                bail!("QA deletion unconfirmed")
            }
            state.guard()?;
            CLIENT
                .get(endpoint(BASE, &["playlist", id])?)
                .header("Authorization", format!("Token {}", state.account.token))
                .send()
                .await
                .map_err(|e| e.without_url())?
                .status()
                .as_u16()
        };
        state.guard()?;
        if status != 404 {
            bail!("QA deletion not confirmed by exact 404; no retry")
        }
        let receipt = manifest["cleanupExecution"]["receipts"]
            .as_array_mut()
            .unwrap()
            .last_mut()
            .unwrap();
        receipt["state"] = json!("verified-not-found");
        receipt["postGetStatus"] = json!(status);
        private_write(&path, &manifest)?;
    }
    manifest["cleanupExecution"]["state"] = json!("verified");
    private_write(&path, &manifest)?;
    println!("Reviewed QA cleanup verified: three once-only deletes, three exact 404 proofs.");
    Ok(())
}
