//! Read-only, bounded inspection of the explicitly selected weekly import.
use super::*;
pub(super) async fn inspect(config: &Path) -> Result<()> {
    let settings = crate::plex::load_settings(config).map_err(|_| anyhow::anyhow!("QA settings unavailable"))?;
    let owner = binding(&settings);
    let client = client(&settings)?;
    if client.get_identity().await?.machine_identifier != settings.machine_identifier { bail!("Server changed") }
    current(config, &owner)?;
    let selected_id: i64 = std::env::var("HIBIKI_QA_WEEKLY_PLAYLIST_ID").context("Explicit selected playlist required")?.parse()?;
    let jams = client.get_playlist(selected_id).await?;
    if !jams.title.starts_with("Weekly Jams") { bail!("Selected weekly title changed") }
    let mut selected = vec![jams];
    let mut exploration = client.list_playlists(settings.section_id, Some(100)).await?.into_iter()
        .filter(|p| p.title.starts_with("Weekly Exploration") && !p.smart && p.playlist_type == "audio").collect::<Vec<_>>();
    exploration.sort_by_key(|p| p.added_at);
    if let Some(latest) = exploration.pop() { selected.push(latest); }
    let mut proof = Vec::new();
    for playlist in selected {
        current(config, &owner)?;
        let state = client.playlist_sync_state(settings.section_id, playlist.rating_key).await?;
        proof.push(json!({"kind":"local","id":playlist.rating_key,"title":playlist.title,"metadataCount":playlist.leaf_count,"orderedItems":state.items.len(),"addedAt":playlist.added_at,"updatedAt":playlist.updated_at}));
    }
    let account = credentials(config)?;
    let rows: Vec<Value> = serde_json::from_slice(&std::fs::read(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join(".tmp/lb-weekly-metadata-proof.json"))?)?;
    for family in ["Weekly Jams", "Weekly Exploration"] {
        let row = rows.iter().filter(|r| r["title"].as_str().is_some_and(|t| t.starts_with(family)))
            .max_by_key(|r| r["date"].as_str().unwrap_or("")).context("Verified weekly source missing")?;
        let id = row["identifier"].as_str().context("Source identifier missing")?.rsplit('/').next().unwrap();
        let result = response(CLIENT.get(endpoint(BASE, &["playlist", id])?).query(&[("fetch_metadata", "true")]).header("Authorization", format!("Token {}", account.token))).await?;
        let tracks = result["playlist"]["track"].as_array().context("Source songs missing")?;
        use futures::StreamExt;
        let mut searches = futures::stream::iter(tracks.iter().take(15).enumerate()).map(|(index, track)| {
            let client = &client; let owner = &owner; let section = settings.section_id;
            async move {
                current(config, owner)?;
                let title = track["title"].as_str().context("Source title missing")?;
                let artist = track["creator"].as_str().context("Source artist missing")?;
                let combined = client.search(section, &format!("{artist} {title}"), Some("track"), None, None, Some(50)).await;
                current(config, owner)?;
                let title_only = client.search(section, title, Some("track"), None, None, Some(50)).await;
                current(config, owner)?;
                let dto = |items: Vec<crate::plex::PlexMedia>| items.into_iter().filter_map(|item| match item {
                    crate::plex::PlexMedia::Track(t) if t.library_section_id == section => Some(json!({"id":t.rating_key.to_string(),"title":t.title,"artist":t.grandparent_title,"album":t.parent_title,"durationMs":t.duration,"verifiedMbid":null})), _ => None
                }).collect::<Vec<_>>();
                let combined_ok = combined.is_ok(); let title_ok = title_only.is_ok();
                Ok::<Value, anyhow::Error>(json!({"index":index,"source":{"id":format!("source-{index}"),"title":title,"artist":artist,"album":track["album"],"durationMs":track["duration"],"recordingMbid":track["identifier"]},"combinedSuccess":combined_ok,"titleSuccess":title_ok,"combined":dto(combined.unwrap_or_default()),"titleOnly":dto(title_only.unwrap_or_default())}))
            }
        }).buffer_unordered(3).collect::<Vec<_>>().await.into_iter().collect::<Result<Vec<_>>>()?;
        searches.sort_by_key(|row| row["index"].as_u64());
        proof.push(json!({"kind":"source","family":family,"sourceCount":tracks.len(),"searches":searches}));
    }
    current(config, &owner)?;
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join(".tmp/weekly-import-readonly-proof.json");
    private_write(&path, &json!(proof))?;
    println!("Read-only weekly proof retained: two local destinations, at most thirty source songs, no writes.");
    Ok(())
}
