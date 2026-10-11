#![allow(dead_code)]
//! Radio Browser API integration — search and browse 45,000+ internet radio stations.
//!
//! Uses the free, open-source Radio Browser API. No API key or authentication required.
//! API docs: https://de1.api.radio-browser.info/

use crate::http_response::{BoundedResponseExt, MAX_JSON_BYTES};
use anyhow::{Context, Result};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

const RB_BASE: &str = "https://de1.api.radio-browser.info";

static RB_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("PlexMusicClient/1.0")
        .build()
        .expect("Failed to build Radio Browser HTTP client")
});

// ---------------------------------------------------------------------------
// Private response models (deserialization only)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct RbStationRaw {
    #[serde(rename = "stationuuid")]
    station_uuid: String,
    name: String,
    #[serde(rename = "url_resolved", default)]
    url_resolved: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    homepage: String,
    #[serde(default)]
    favicon: String,
    #[serde(default)]
    tags: String,
    #[serde(default)]
    country: String,
    #[serde(rename = "countrycode", default)]
    country_code: String,
    #[serde(default)]
    language: String,
    #[serde(default)]
    codec: String,
    #[serde(default)]
    bitrate: u32,
    #[serde(rename = "hls", default)]
    hls: u8,
    #[serde(default)]
    votes: u32,
    #[serde(rename = "clickcount", default)]
    click_count: u32,
    #[serde(rename = "clicktrend", default)]
    click_trend: i32,
}

#[derive(Debug, Deserialize)]
struct RbCountryRaw {
    name: String,
    #[serde(rename = "iso_3166_1", default)]
    iso_3166_1: String,
    #[serde(rename = "stationcount", default)]
    station_count: u32,
}

#[derive(Debug, Deserialize)]
struct RbTagRaw {
    name: String,
    #[serde(rename = "stationcount", default)]
    station_count: u32,
}

// ---------------------------------------------------------------------------
// Public return types (serialized to TypeScript via Tauri)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct RadioStation {
    pub uuid: String,
    pub name: String,
    pub stream_url: String,
    pub homepage: String,
    pub favicon: String,
    pub tags: Vec<String>,
    pub country: String,
    pub country_code: String,
    pub language: String,
    pub codec: String,
    pub bitrate: u32,
    pub is_hls: bool,
    pub votes: u32,
    pub click_count: u32,
    pub click_trend: i32,
}

#[derive(Debug, Serialize, Clone)]
pub struct RadioCountry {
    pub name: String,
    pub code: String,
    pub station_count: u32,
}

#[derive(Debug, Serialize, Clone)]
pub struct RadioTag {
    pub name: String,
    pub station_count: u32,
}

/// Search parameters for station lookup.
#[derive(Debug, Deserialize)]
pub struct SearchParams {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub country: String,
    #[serde(default)]
    pub country_code: String,
    #[serde(default)]
    pub language: String,
    #[serde(default)]
    pub order: String,
    #[serde(default)]
    pub limit: u32,
    #[serde(default)]
    pub offset: u32,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn to_station(raw: RbStationRaw) -> RadioStation {
    let stream_url = if raw.url_resolved.is_empty() {
        raw.url
    } else {
        raw.url_resolved
    };
    RadioStation {
        uuid: raw.station_uuid,
        name: raw.name,
        stream_url,
        homepage: raw.homepage,
        favicon: raw.favicon,
        tags: raw
            .tags
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        country: raw.country,
        country_code: raw.country_code,
        language: raw.language,
        codec: raw.codec,
        bitrate: raw.bitrate,
        is_hls: raw.hls == 1,
        votes: raw.votes,
        click_count: raw.click_count,
        click_trend: raw.click_trend,
    }
}

// ---------------------------------------------------------------------------
// Public API functions
// ---------------------------------------------------------------------------

/// Search for radio stations by name, tag, country, etc.
pub async fn search_stations(params: SearchParams) -> Result<Vec<RadioStation>> {
    let limit = if params.limit == 0 { 30 } else { params.limit };

    let mut query: Vec<(&str, String)> = vec![
        ("hidebroken", "true".to_string()),
        ("limit", limit.to_string()),
        ("offset", params.offset.to_string()),
    ];

    if !params.name.is_empty() {
        query.push(("name", params.name));
    }
    if !params.tag.is_empty() {
        query.push(("tag", params.tag));
    }
    if !params.country.is_empty() {
        query.push(("country", params.country));
    }
    if !params.country_code.is_empty() {
        query.push(("countrycode", params.country_code));
    }
    if !params.language.is_empty() {
        query.push(("language", params.language));
    }
    if !params.order.is_empty() {
        query.push(("order", params.order.clone()));
        query.push(("reverse", "true".to_string()));
    } else {
        query.push(("order", "votes".to_string()));
        query.push(("reverse", "true".to_string()));
    }

    let raw: Vec<RbStationRaw> = RB_CLIENT
        .get(format!("{}/json/stations/search", RB_BASE))
        .query(&query)
        .send()
        .await.map_err(|error| error.without_url())
        .context("Failed to reach Radio Browser station search")?
        .error_for_status().map_err(|error| error.without_url())
        .context("Radio Browser station search returned error status")?
        .bounded_json(MAX_JSON_BYTES)
        .await
        .context("Failed to parse Radio Browser station search response")?;

    Ok(raw.into_iter().map(to_station).collect())
}

/// Get top stations by category: "topvote", "topclick", or "lastclick".
pub async fn top_stations(category: &str, count: u32) -> Result<Vec<RadioStation>> {
    let count = if count == 0 { 15 } else { count };
    let cat = match category {
        "topclick" | "lastclick" | "topvote" => category,
        _ => "topvote",
    };

    let raw: Vec<RbStationRaw> = RB_CLIENT
        .get(format!("{}/json/stations/{}/{}", RB_BASE, cat, count))
        .query(&[("hidebroken", "true")])
        .send()
        .await.map_err(|error| error.without_url())
        .context("Failed to reach Radio Browser top stations")?
        .error_for_status().map_err(|error| error.without_url())
        .context("Radio Browser top stations returned error status")?
        .bounded_json(MAX_JSON_BYTES)
        .await
        .context("Failed to parse Radio Browser top stations response")?;

    Ok(raw.into_iter().map(to_station).collect())
}

/// Get all countries with station counts, ordered by station count descending.
pub async fn get_countries() -> Result<Vec<RadioCountry>> {
    let raw: Vec<RbCountryRaw> = RB_CLIENT
        .get(format!("{}/json/countries", RB_BASE))
        .query(&[("order", "stationcount"), ("reverse", "true")])
        .send()
        .await.map_err(|error| error.without_url())
        .context("Failed to reach Radio Browser countries")?
        .error_for_status().map_err(|error| error.without_url())
        .context("Radio Browser countries returned error status")?
        .bounded_json(MAX_JSON_BYTES)
        .await
        .context("Failed to parse Radio Browser countries response")?;

    Ok(raw
        .into_iter()
        .filter(|c| !c.name.is_empty() && c.station_count > 0)
        .map(|c| RadioCountry {
            name: c.name,
            code: c.iso_3166_1,
            station_count: c.station_count,
        })
        .collect())
}

/// Get popular tags (genres), ordered by station count descending.
pub async fn get_tags(limit: u32) -> Result<Vec<RadioTag>> {
    let limit = if limit == 0 { 100 } else { limit };

    let raw: Vec<RbTagRaw> = RB_CLIENT
        .get(format!("{}/json/tags", RB_BASE))
        .query(&[
            ("order", "stationcount"),
            ("reverse", "true"),
            ("hidebroken", "true"),
            ("limit", &limit.to_string()),
        ])
        .send()
        .await.map_err(|error| error.without_url())
        .context("Failed to reach Radio Browser tags")?
        .error_for_status().map_err(|error| error.without_url())
        .context("Radio Browser tags returned error status")?
        .bounded_json(MAX_JSON_BYTES)
        .await
        .context("Failed to parse Radio Browser tags response")?;

    Ok(raw
        .into_iter()
        .filter(|t| !t.name.is_empty() && t.station_count > 0)
        .map(|t| RadioTag {
            name: t.name,
            station_count: t.station_count,
        })
        .collect())
}

/// Register a click for community stats. Fire-and-forget — errors are silently ignored.
pub async fn register_click(uuid: &str) -> Result<()> {
    let _ = RB_CLIENT
        .get(format!("{}/json/url/{}", RB_BASE, uuid))
        .send()
        .await.map_err(|error| error.without_url());
    Ok(())
}
