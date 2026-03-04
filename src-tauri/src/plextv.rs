//! plex.tv cloud API — PIN-based OAuth and server discovery.
//!
//! Flow:
//!   1. POST /api/v2/pins         → get {id, code}
//!   2. Open browser to app.plex.tv/auth#?clientID=…&code=…
//!   3. Poll GET /api/v2/pins/{id} until authToken is Some
//!   4. GET /api/v2/resources     → list of user's Plex servers

use anyhow::{Context, Result};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

const PLEX_TV_BASE: &str = "https://plex.tv";
const PLEX_APP_AUTH: &str = "https://app.plex.tv/auth";
const PRODUCT: &str = "Plexify";

static PLEX_TV_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .expect("Failed to build plex.tv HTTP client")
});

// ---------------------------------------------------------------------------
// plex.tv response models (private — only used for deserialization)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct PinResponse {
    id: u64,
    code: String,
    #[serde(rename = "authToken")]
    auth_token: Option<String>,
}

// ---------------------------------------------------------------------------
// Public types returned to the Tauri command layer / frontend
// ---------------------------------------------------------------------------

/// Returned after starting the PIN flow — frontend opens `auth_url` in a browser.
#[derive(Debug, Serialize, Clone)]
pub struct PinInfo {
    pub pin_id: u64,
    pub auth_url: String,
}

/// A Plex Media Server resource from plex.tv/api/v2/resources.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlexResource {
    pub name: String,
    #[serde(rename(deserialize = "clientIdentifier"))]
    pub client_identifier: String,
    #[serde(default)]
    pub provides: String,
    pub connections: Vec<PlexConnection>,
}

/// A network connection endpoint for a Plex resource.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlexConnection {
    pub protocol: String,
    pub address: String,
    pub port: u16,
    pub uri: String,
    pub local: bool,
    #[serde(default)]
    pub relay: bool,
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

/// Create a PIN on plex.tv.
///
/// Returns `PinInfo` containing the pin ID (for polling) and the URL to open
/// in the user's browser so they can authenticate.
pub async fn create_pin(client_id: &str) -> Result<PinInfo> {
    let resp: PinResponse = PLEX_TV_CLIENT
        .post(format!("{}/api/v2/pins", PLEX_TV_BASE))
        .header("X-Plex-Product", PRODUCT)
        .header("X-Plex-Client-Identifier", client_id)
        .header("Accept", "application/json")
        .form(&[("strong", "true")])
        .send()
        .await
        .context("Failed to reach plex.tv")?
        .error_for_status()
        .context("plex.tv /pins returned an error status")?
        .json()
        .await
        .context("Failed to parse PIN response from plex.tv")?;

    let auth_url = format!(
        "{}#?clientID={}&code={}&context[device][product]={}",
        PLEX_APP_AUTH, client_id, resp.code, PRODUCT
    );

    Ok(PinInfo { pin_id: resp.id, auth_url })
}

/// Poll plex.tv to check whether the user has completed authentication.
///
/// Returns `Some(token)` once the user logs in, `None` while still waiting.
/// Call this roughly once every 2 seconds from the frontend until a token
/// arrives or the user cancels.
pub async fn poll_pin(client_id: &str, pin_id: u64) -> Result<Option<String>> {
    let resp: PinResponse = PLEX_TV_CLIENT
        .get(format!("{}/api/v2/pins/{}", PLEX_TV_BASE, pin_id))
        .header("X-Plex-Product", PRODUCT)
        .header("X-Plex-Client-Identifier", client_id)
        .header("Accept", "application/json")
        .send()
        .await
        .context("Failed to reach plex.tv")?
        .error_for_status()
        .context("plex.tv /pins/{id} returned an error status")?
        .json()
        .await
        .context("Failed to parse PIN poll response")?;

    Ok(resp.auth_token)
}

/// Fetch the authenticated user's Plex servers from plex.tv.
///
/// Filters out relay connections and non-server resources (Plex clients, etc.).
/// Local connections are listed first within each resource's connection list.
pub async fn get_resources(client_id: &str, token: &str) -> Result<Vec<PlexResource>> {
    let mut resources: Vec<PlexResource> = PLEX_TV_CLIENT
        .get(format!("{}/api/v2/resources", PLEX_TV_BASE))
        .header("X-Plex-Product", PRODUCT)
        .header("X-Plex-Client-Identifier", client_id)
        .header("X-Plex-Token", token)
        .header("Accept", "application/json")
        .query(&[
            ("includeHttps", "1"),
            ("includeRelay", "1"),
            ("includeIPv6", "0"),
        ])
        .send()
        .await
        .context("Failed to reach plex.tv")?
        .error_for_status()
        .context("plex.tv /resources returned an error status")?
        .json()
        .await
        .context("Failed to parse resources response")?;

    // Keep only server resources that have at least one connection.
    resources.retain(|r| r.provides.contains("server") && !r.connections.is_empty());
    for r in &mut resources {
        // Sort: local non-relay first, then remote non-relay, then relay last.
        r.connections.sort_by_key(|c| (c.relay, !c.local));
    }

    Ok(resources)
}
