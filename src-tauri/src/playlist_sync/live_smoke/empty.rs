//! Separate, prepare-only empty-create QA plan. No remote mutation is reachable here.
use super::*;

pub(super) async fn prepare(config: &Path, run: &str) -> Result<()> {
    let run = canonical_mbid(run)?;
    let path = qa_directory(&run)?.join("manifest.json");
    if path.exists() {
        bail!("An existing QA run cannot be reused")
    }
    let settings = crate::plex::load_settings(config)
        .map_err(|_| anyhow::anyhow!("QA settings unavailable"))?;
    let owner = binding(&settings);
    let client = client(&settings)?;
    current(config, &owner)?;
    if client.get_identity().await?.machine_identifier != settings.machine_identifier {
        bail!("QA server identity changed")
    }
    current(config, &owner)?;
    let section = client.get_section(settings.section_id).await?;
    if section.section_type != "artist"
        || section.uuid.as_deref() != Some(settings.section_uuid.as_str())
    {
        bail!("QA music section identity changed")
    }
    current(config, &owner)?;
    private_write(&path, &json!({
        "schema": 1, "kind": "empty-create", "runId": run,
        "phase": "prepared", "title": format!("Hibiki QA empty {run}"),
        "nativeBinding": owner, "libraryScope": client.library_scope,
        "sectionId": settings.section_id, "libraryId": null,
        "createIntent": null, "proof": null, "cleanupIntent": null,
        "plan": {
            "createRequests": 1, "inputTrackIds": [],
            "proof": "Fresh exact owned audio playlist name and zero ordered occurrences",
            "cleanup": "Separate root-reviewed once-delete with fresh ownership proof and HTTP 404",
            "failure": "Retain intent and any returned ID; never recreate or blindly retry",
            "listenBrainzRequests": 0, "audioRequests": 0
        }
    }))?;
    println!("Empty-create QA prepared: identity verified, zero mutations, no create intent or remote ID.");
    Ok(())
}


fn load(run: &str) -> Result<(PathBuf, Value)> {
    let path = qa_directory(run)?.join("manifest.json");
    let value: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    if value["kind"] != "empty-create" || value["runId"] != run
        || value["title"] != format!("Hibiki QA empty {run}") {
        bail!("Not an exclusively owned empty-create QA manifest")
    }
    Ok((path, value))
}
async fn verified(config: &Path, manifest: &Value) -> Result<(PlexClient, i64)> {
    let owner = manifest["nativeBinding"].as_str().context("QA binding missing")?;
    current(config, owner)?;
    let settings = crate::plex::load_settings(config).map_err(|_| anyhow::anyhow!("QA settings unavailable"))?;
    let client = client(&settings)?;
    if manifest["sectionId"] != settings.section_id || manifest["libraryScope"] != client.library_scope {
        bail!("QA library binding changed")
    }
    if client.get_identity().await?.machine_identifier != settings.machine_identifier { bail!("QA server changed") }
    current(config, owner)?;
    let section = client.get_section(settings.section_id).await?;
    if section.section_type != "artist" || section.uuid.as_deref() != Some(settings.section_uuid.as_str()) { bail!("QA music section changed") }
    current(config, owner)?;
    Ok((client, settings.section_id))
}
async fn proof(config: &Path, manifest: &Value, client: &PlexClient, section: i64) -> Result<()> {
    let owner = manifest["nativeBinding"].as_str().context("QA binding missing")?;
    current(config, owner)?;
    let id = manifest["libraryId"].as_i64().filter(|id| *id > 0).context("Owned QA ID missing")?;
    let state = client.playlist_sync_state(section, id).await?;
    current(config, owner)?;
    if Some(state.title.as_str()) != manifest["title"].as_str() || !state.items.is_empty() {
        bail!("Fresh QA audio playlist title or empty occurrence proof failed")
    }
    Ok(())
}
pub(super) async fn execute(config: &Path, run: &str) -> Result<()> {
    if std::env::var("HIBIKI_QA_REVIEWED_EMPTY_RUN").ok().as_deref() != Some(run) { bail!("Explicit empty-create review required") }
    let (path, mut manifest) = load(run)?;
    if manifest["phase"] != "prepared" || !manifest["createIntent"].is_null() || !manifest["libraryId"].is_null() { bail!("Empty create cannot be replayed") }
    let (client, section) = verified(config, &manifest).await?;
    manifest["createIntent"] = json!({"state":"unconfirmed","requests":1});
    manifest["phase"] = json!("creating");
    private_write(&path, &manifest)?;
    current(config, manifest["nativeBinding"].as_str().unwrap())?;
    let created = client.create_playlist(manifest["title"].as_str().unwrap(), section, &[]).await?;
    manifest["libraryId"] = json!(created.rating_key);
    private_write(&path, &manifest)?;
    proof(config, &manifest, &client, section).await?;
    manifest["proof"] = json!({"audio":true,"exactName":true,"orderedOccurrences":0});
    manifest["phase"] = json!("proven");
    manifest["createIntent"]["state"] = json!("verified");
    private_write(&path, &manifest)?;
    println!("Empty QA create proven: one create, exact fresh audio name, zero ordered occurrences.");
    Ok(())
}
pub(super) async fn cleanup(config: &Path, run: &str, execute: bool) -> Result<()> {
    let (path, mut manifest) = load(run)?;
    if manifest["phase"] != "proven" || !manifest["cleanupIntent"].is_null()
        || manifest["createIntent"]["state"] != "verified"
        || manifest["proof"]["orderedOccurrences"] != 0
        || manifest["proof"]["exactName"] != true
        || manifest["proof"]["audio"] != true { bail!("QA cleanup cannot be replayed or target an unproven create") }
    let (client, section) = verified(config, &manifest).await?;
    proof(config, &manifest, &client, section).await?;
    let resource = json!({"runId":run,"title":manifest["title"],"id":manifest["libraryId"],"binding":manifest["nativeBinding"],"orderedOccurrences":0});
    let digest = hex::encode(Sha256::digest(resource.to_string().as_bytes()));
    if !execute {
        manifest["cleanupPlan"] = json!({"resource":resource,"digest":digest,"requests":1,"postGetStatus":404});
        private_write(&path, &manifest)?;
        println!("Empty QA cleanup prepared: one owned resource, zero writes.");
        return Ok(())
    }
    if std::env::var("HIBIKI_QA_REVIEWED_EMPTY_CLEANUP_RUN").ok().as_deref() != Some(run)
        || std::env::var("HIBIKI_QA_REVIEWED_EMPTY_CLEANUP_DIGEST").ok().as_deref() != Some(digest.as_str())
        || manifest["cleanupPlan"]["digest"] != digest { bail!("Explicit exact-resource cleanup review required") }
    manifest["cleanupIntent"] = json!({"state":"unconfirmed","resource":resource});
    private_write(&path, &manifest)?;
    current(config, manifest["nativeBinding"].as_str().unwrap())?;
    let id = manifest["libraryId"].as_i64().unwrap();
    client.mutate_params_once(reqwest::Method::DELETE, &format!("/playlists/{id}"), &[], None, None).await?;
    current(config, manifest["nativeBinding"].as_str().unwrap())?;
    let status = client.qa_playlist_status_once(id).await?;
    current(config, manifest["nativeBinding"].as_str().unwrap())?;
    if status != 404 { bail!("QA deletion was not confirmed; no retries permitted") }
    manifest["cleanupIntent"]["state"] = json!("verified");
    manifest["cleanupIntent"]["postGetStatus"] = json!(404);
    manifest["phase"] = json!("cleaned");
    private_write(&path, &manifest)?;
    println!("Empty QA cleanup proven: one DELETE, exact post-GET 404.");
    Ok(())
}
