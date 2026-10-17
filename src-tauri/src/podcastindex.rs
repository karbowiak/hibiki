#![allow(dead_code)]
//! Podcast Index API client — free podcast directory with category browsing.
//!
//! API docs: https://podcastindex-org.github.io/docs-api/
//! Requires a free API key+secret pair (embedded at build time).

use crate::http_response::{BoundedResponseExt, MAX_JSON_BYTES};
use anyhow::{Context, Result};
use once_cell::sync::Lazy;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::podcast::{PodcastCategory, PodcastTopChart};

// ---------------------------------------------------------------------------
// Config — key/secret injected at build time
// ---------------------------------------------------------------------------

// Local builds can run the player without optional podcast-directory credentials.
#[cfg(any(debug_assertions, test))]
const PI_KEY: &str = match option_env!("PI_KEY") {
    Some(value) => value,
    None => "",
};
#[cfg(any(debug_assertions, test))]
const PI_SECRET: &str = match option_env!("PI_SECRET") {
    Some(value) => value,
    None => "",
};
#[cfg(not(any(debug_assertions, test)))]
const PI_KEY: &str = env!("PI_KEY", "Set PI_KEY in .env or environment (free from https://api.podcastindex.org/)");
#[cfg(not(any(debug_assertions, test)))]
const PI_SECRET: &str = env!("PI_SECRET", "Set PI_SECRET in .env or environment");
const PI_BASE: &str = "https://api.podcastindex.org/api/1.0";
const PI_USER_AGENT: &str = "Hibiki/1.0";

static PI_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .expect("Failed to build Podcast Index HTTP client")
});

// ---------------------------------------------------------------------------
// Auth headers
// ---------------------------------------------------------------------------

fn auth_headers() -> Vec<(&'static str, String)> {
    use sha1::{Digest, Sha1};

    let epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let epoch_str = epoch.to_string();

    let hash_input = format!("{}{}{}", PI_KEY, PI_SECRET, epoch_str);
    let hash = hex::encode(Sha1::digest(hash_input.as_bytes()));

    vec![
        ("X-Auth-Key", PI_KEY.to_string()),
        ("X-Auth-Date", epoch_str),
        ("Authorization", hash),
        ("User-Agent", PI_USER_AGENT.to_string()),
    ]
}

/// Authenticated GET helper.
async fn pi_get<T: serde::de::DeserializeOwned>(
    path: &str,
    params: &[(&str, &str)],
) -> Result<T> {
    anyhow::ensure!(!PI_KEY.is_empty() && !PI_SECRET.is_empty(), "Podcast charts are unavailable in this build. You can still search for podcasts or open a feed.");
    let url = format!("{}{}", PI_BASE, path);
    let mut req = PI_CLIENT.get(&url);
    for (k, v) in auth_headers() {
        req = req.header(k, v);
    }
    if !params.is_empty() {
        req = req.query(params);
    }
    req.send()
        .await.map_err(|error| error.without_url())
        .context("Failed to reach Podcast Index API")?
        .error_for_status().map_err(|error| error.without_url())
        .context("Podcast Index API returned error status")?
        .bounded_json::<T>(MAX_JSON_BYTES)
        .await
        .context("Failed to parse Podcast Index response")
}

// ---------------------------------------------------------------------------
// Response models
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct PiTrendingResponse {
    #[serde(default)]
    feeds: Vec<PiTrendingFeed>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all(deserialize = "camelCase"))]
struct PiTrendingFeed {
    #[serde(default)]
    id: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    image: String,
    #[serde(default)]
    artwork: String,
    #[serde(default, rename(deserialize = "itunesId"))]
    itunes_id: Option<u64>,
    #[serde(default)]
    categories: Option<HashMap<String, String>>,
}

#[derive(Debug, Deserialize)]
struct PiCategoriesResponse {
    #[serde(default)]
    feeds: Vec<PiCategory>,
}

#[derive(Debug, Deserialize)]
struct PiCategory {
    #[serde(default)]
    id: u32,
    #[serde(default)]
    name: String,
}

// ---------------------------------------------------------------------------
// Categories cache (24h TTL)
// ---------------------------------------------------------------------------

static CATEGORIES_CACHE: Lazy<Mutex<Option<(Vec<PodcastCategory>, Instant)>>> =
    Lazy::new(|| Mutex::new(None));

const CATEGORIES_TTL: Duration = Duration::from_secs(24 * 3600);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Get trending podcasts, optionally filtered by category name.
pub async fn get_trending(cat: Option<&str>, max: u32) -> Result<Vec<PodcastTopChart>> {
    let max_str = max.to_string();
    let mut params: Vec<(&str, &str)> = vec![("max", &max_str), ("lang", "en")];
    if let Some(c) = cat {
        params.push(("cat", c));
    }

    let resp: PiTrendingResponse = pi_get("/podcasts/trending", &params).await?;

    Ok(resp
        .feeds
        .into_iter()
        .map(|f| {
            let genre = f
                .categories
                .as_ref()
                .and_then(|m| m.values().next().cloned())
                .unwrap_or_default();
            let artwork = if !f.artwork.is_empty() {
                f.artwork
            } else {
                f.image
            };
            PodcastTopChart {
                itunes_id: f.itunes_id.unwrap_or(0),
                name: f.title,
                artist_name: f.author,
                artwork_url: artwork,
                feed_url: f.url,
                genre,
                itunes_url: String::new(),
            }
        })
        .collect())
}

/// Get all podcast categories from Podcast Index (cached 24h).
pub async fn get_categories() -> Result<Vec<PodcastCategory>> {
    // Check cache
    {
        let guard = CATEGORIES_CACHE.lock().unwrap();
        if let Some((ref data, ref ts)) = *guard {
            if ts.elapsed() < CATEGORIES_TTL {
                return Ok(data.clone());
            }
        }
    }

    let resp: PiCategoriesResponse = pi_get("/categories/list", &[]).await?;

    let cats: Vec<PodcastCategory> = resp
        .feeds
        .into_iter()
        .map(|c| PodcastCategory {
            id: c.id,
            name: c.name,
        })
        .collect();

    // Update cache
    {
        let mut guard = CATEGORIES_CACHE.lock().unwrap();
        *guard = Some((cats.clone(), Instant::now()));
    }

    Ok(cats)
}
