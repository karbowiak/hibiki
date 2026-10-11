#![allow(dead_code)]
//! Podcast discovery & feed parsing — iTunes Search API + RSS feeds.
//!
//! No API key or authentication required. All endpoints are public.
//! Uses `roxmltree` for RSS/XML parsing (same as lyrics parsing).

use crate::http_response::{BoundedResponseExt, MAX_JSON_BYTES, MAX_TEXT_BYTES};
use anyhow::{Context, Result};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

static PODCAST_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .expect("Failed to build podcast HTTP client")
});

// ---------------------------------------------------------------------------
// Public types (serialized to TypeScript via Tauri)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct PodcastSearchResult {
    pub id: u64,
    pub name: String,
    pub artist_name: String,
    pub artwork_url: String,
    pub feed_url: String,
    pub genre: String,
    pub track_count: u32,
    pub itunes_url: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct PodcastDetail {
    pub feed_url: String,
    pub title: String,
    pub author: String,
    pub description: String,
    pub artwork_url: String,
    pub link: String,
    pub language: String,
    pub categories: Vec<String>,
    pub episodes: Vec<PodcastEpisode>,
}

#[derive(Debug, Serialize, Clone)]
pub struct PodcastEpisode {
    pub guid: String,
    pub title: String,
    pub description: String,
    pub pub_date: String,
    pub duration_secs: u64,
    pub audio_url: String,
    pub audio_type: String,
    pub audio_size: u64,
    pub episode_number: Option<u32>,
    pub season_number: Option<u32>,
    pub artwork_url: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct PodcastCategory {
    pub id: u32,
    pub name: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct PodcastTopChart {
    pub itunes_id: u64,
    pub name: String,
    pub artist_name: String,
    pub artwork_url: String,
    pub feed_url: String,
    pub genre: String,
    pub itunes_url: String,
}

// ---------------------------------------------------------------------------
// iTunes response models (deserialization only)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all(deserialize = "camelCase"))]
struct ItunesSearchResponse {
    results: Vec<ItunesPodcastResult>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all(deserialize = "camelCase"))]
struct ItunesPodcastResult {
    #[serde(default)]
    collection_id: u64,
    #[serde(default)]
    collection_name: String,
    #[serde(default)]
    artist_name: String,
    #[serde(default)]
    artwork_url600: String,
    #[serde(default)]
    feed_url: String,
    #[serde(default)]
    primary_genre_name: String,
    #[serde(default)]
    track_count: u32,
    #[serde(default)]
    collection_view_url: String,
}

// Apple RSS feed generator response
#[derive(Debug, Deserialize)]
struct AppleRssFeedResponse {
    feed: AppleRssFeed,
}

#[derive(Debug, Deserialize)]
struct AppleRssFeed {
    #[serde(default)]
    results: Vec<AppleRssResult>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all(deserialize = "camelCase"))]
struct AppleRssResult {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    artist_name: String,
    #[serde(default)]
    artwork_url100: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    genres: Vec<AppleRssGenre>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all(deserialize = "camelCase"))]
struct AppleRssGenre {
    #[serde(default)]
    genre_id: String,
    #[serde(default)]
    name: String,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Strip HTML tags from a string with a simple approach.
fn strip_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    // Decode common HTML entities
    out.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
}

/// Parse iTunes duration string (HH:MM:SS, MM:SS, or raw seconds).
fn parse_duration(s: &str) -> u64 {
    let s = s.trim();
    if s.is_empty() {
        return 0;
    }
    // Raw seconds
    if !s.contains(':') {
        return s.parse::<u64>().unwrap_or(0);
    }
    let parts: Vec<&str> = s.split(':').collect();
    match parts.len() {
        2 => {
            let m = parts[0].parse::<u64>().unwrap_or(0);
            let s = parts[1].parse::<u64>().unwrap_or(0);
            m * 60 + s
        }
        3 => {
            let h = parts[0].parse::<u64>().unwrap_or(0);
            let m = parts[1].parse::<u64>().unwrap_or(0);
            let s = parts[2].parse::<u64>().unwrap_or(0);
            h * 3600 + m * 60 + s
        }
        _ => 0,
    }
}

/// Get text content of the first matching child element.
fn child_text<'a>(node: &'a roxmltree::Node, tag: &str) -> &'a str {
    node.children()
        .find(|n| n.has_tag_name(tag))
        .and_then(|n| n.text())
        .unwrap_or("")
}

/// Get text content of the first matching namespaced child element (e.g. itunes:author).
fn ns_child_text<'a>(node: &'a roxmltree::Node, ns: &str, tag: &str) -> &'a str {
    node.children()
        .find(|n| {
            n.tag_name().name() == tag
                && n.tag_name()
                    .namespace()
                    .map_or(false, |u| u.contains(ns))
        })
        .and_then(|n| n.text())
        .unwrap_or("")
}

/// Get an attribute from a namespaced child element (e.g. itunes:image href).
fn ns_child_attr<'a>(node: &'a roxmltree::Node, ns: &str, tag: &str, attr: &str) -> &'a str {
    node.children()
        .find(|n| {
            n.tag_name().name() == tag
                && n.tag_name()
                    .namespace()
                    .map_or(false, |u| u.contains(ns))
        })
        .and_then(|n| n.attribute(attr))
        .unwrap_or("")
}

/// Collect itunes:category text values.
fn collect_categories(node: &roxmltree::Node) -> Vec<String> {
    node.children()
        .filter(|n| {
            n.tag_name().name() == "category"
                && n.tag_name()
                    .namespace()
                    .map_or(false, |u| u.contains("itunes"))
        })
        .filter_map(|n| n.attribute("text").map(|s| s.to_string()))
        .collect()
}

/// Scale an iTunes artwork URL to a larger size.
fn scale_artwork(url: &str, size: u32) -> String {
    if url.is_empty() {
        return String::new();
    }
    // iTunes CDN URLs end with a segment like "100x100bb.jpg"
    if let Some(bb_pos) = url.rfind("bb.") {
        let before = &url[..bb_pos];
        if let Some(slash_pos) = before.rfind('/') {
            let size_segment = &before[slash_pos + 1..];
            if size_segment.contains('x') {
                return format!(
                    "{}/{}x{}bb.{}",
                    &before[..slash_pos],
                    size,
                    size,
                    &url[bb_pos + 3..]
                );
            }
        }
    }
    url.to_string()
}

// ---------------------------------------------------------------------------
// Public API functions
// ---------------------------------------------------------------------------

/// Search for podcasts by query using the iTunes Search API.
pub async fn search_podcasts(query: &str, limit: u32) -> Result<Vec<PodcastSearchResult>> {
    let limit_str = limit.to_string();
    let resp = crate::itunes_throttle::itunes_get(
        "https://itunes.apple.com/search",
        &[
            ("term", query),
            ("media", "podcast"),
            ("entity", "podcast"),
            ("limit", &limit_str),
        ],
    )
    .await
    .context("Failed to reach iTunes podcast search")?
    .bounded_json::<ItunesSearchResponse>(MAX_JSON_BYTES)
    .await
    .context("Failed to parse iTunes podcast search response")?;

    Ok(resp
        .results
        .into_iter()
        .filter(|r| !r.feed_url.is_empty())
        .map(|r| PodcastSearchResult {
            id: r.collection_id,
            name: r.collection_name,
            artist_name: r.artist_name,
            artwork_url: scale_artwork(&r.artwork_url600, 600),
            feed_url: r.feed_url,
            genre: r.primary_genre_name,
            track_count: r.track_count,
            itunes_url: r.collection_view_url,
        })
        .collect())
}

/// Get top podcasts.
///
/// - `None` category → Apple RSS charts (overall top, not rate-limited)
/// - `Some(name)` → Podcast Index trending filtered by category name
pub async fn get_top_podcasts(category: Option<String>, limit: u32) -> Result<Vec<PodcastTopChart>> {
    if let Some(ref cat) = category {
        return crate::podcastindex::get_trending(Some(cat), limit).await;
    }

    // Overall top chart — Apple RSS (unchanged)
    let url = format!(
        "https://rss.marketingtools.apple.com/api/v2/us/podcasts/top/{}/podcasts.json",
        limit
    );
    let resp = PODCAST_CLIENT
        .get(&url)
        .send()
        .await.map_err(|error| error.without_url())
        .context("Failed to reach Apple podcast charts")?
        .error_for_status().map_err(|error| error.without_url())
        .context("Apple podcast charts returned error status")?
        .bounded_json::<AppleRssFeedResponse>(MAX_JSON_BYTES)
        .await
        .context("Failed to parse Apple podcast charts response")?;

    let results: Vec<PodcastTopChart> = resp
        .feed
        .results
        .into_iter()
        .take(limit as usize)
        .map(|r| {
            let genre = r
                .genres
                .first()
                .map(|g| g.name.clone())
                .unwrap_or_default();
            PodcastTopChart {
                itunes_id: r.id.parse::<u64>().unwrap_or(0),
                name: r.name,
                artist_name: r.artist_name,
                artwork_url: scale_artwork(&r.artwork_url100, 600),
                feed_url: String::new(), // Apple RSS chart doesn't include feed URLs
                genre,
                itunes_url: r.url,
            }
        })
        .collect();

    Ok(results)
}

/// Fetch and parse an RSS podcast feed into a PodcastDetail with episodes.
pub async fn get_podcast_feed(feed_url: &str) -> Result<PodcastDetail> {
    let body = PODCAST_CLIENT
        .get(feed_url)
        .send()
        .await.map_err(|error| error.without_url())
        .context("Failed to fetch podcast feed")?
        .error_for_status().map_err(|error| error.without_url())
        .context("Podcast feed returned error status")?
        .bounded_text(MAX_TEXT_BYTES)
        .await
        .context("Failed to read podcast feed body")?;

    parse_feed(feed_url, &body)
}

fn parse_feed(feed_url: &str, body: &str) -> Result<PodcastDetail> {
    let doc = roxmltree::Document::parse_with_options(body, roxmltree::ParsingOptions {
        nodes_limit: 250_000,
        ..Default::default()
    }).context("Failed to parse podcast RSS XML")?;

    let channel = doc
        .descendants()
        .find(|n| n.has_tag_name("channel"))
        .context("No <channel> element in RSS feed")?;

    let title = child_text(&channel, "title").to_string();
    let author = ns_child_text(&channel, "itunes", "author").to_string();
    let description = strip_html(child_text(&channel, "description"));
    let artwork_url = ns_child_attr(&channel, "itunes", "image", "href").to_string();
    let link = child_text(&channel, "link").to_string();
    let language = child_text(&channel, "language").to_string();
    let categories = collect_categories(&channel);

    let episodes: Vec<PodcastEpisode> = channel
        .children()
        .filter(|n| n.has_tag_name("item"))
        .map(|item| {
            let ep_title = child_text(&item, "title").to_string();
            let ep_desc = strip_html(child_text(&item, "description"));
            let pub_date = child_text(&item, "pubDate").to_string();
            let duration_str = ns_child_text(&item, "itunes", "duration");
            let duration_secs = parse_duration(duration_str);

            // <enclosure url="..." type="..." length="..." />
            let enclosure = item
                .children()
                .find(|n| n.has_tag_name("enclosure"));
            let audio_url = enclosure
                .and_then(|n| n.attribute("url"))
                .unwrap_or("")
                .to_string();
            let audio_type = enclosure
                .and_then(|n| n.attribute("type"))
                .unwrap_or("audio/mpeg")
                .to_string();
            let audio_size = enclosure
                .and_then(|n| n.attribute("length"))
                .unwrap_or("0")
                .parse::<u64>()
                .unwrap_or(0);

            let guid = child_text(&item, "guid").to_string();
            let episode_number = ns_child_text(&item, "itunes", "episode")
                .parse::<u32>()
                .ok();
            let season_number = ns_child_text(&item, "itunes", "season")
                .parse::<u32>()
                .ok();
            let ep_artwork = ns_child_attr(&item, "itunes", "image", "href");
            let ep_artwork_url = if ep_artwork.is_empty() {
                None
            } else {
                Some(ep_artwork.to_string())
            };

            PodcastEpisode {
                guid,
                title: ep_title,
                description: ep_desc,
                pub_date,
                duration_secs,
                audio_url,
                audio_type,
                audio_size,
                episode_number,
                season_number,
                artwork_url: ep_artwork_url,
            }
        })
        .collect();

    Ok(PodcastDetail {
        feed_url: feed_url.to_string(),
        title,
        author,
        description,
        artwork_url,
        link,
        language,
        categories,
        episodes,
    })
}

/// Look up a single podcast by its iTunes ID.
pub async fn lookup_podcast(itunes_id: u64) -> Result<Option<PodcastSearchResult>> {
    let id_str = itunes_id.to_string();
    let resp = crate::itunes_throttle::itunes_get(
        "https://itunes.apple.com/lookup",
        &[("id", &id_str), ("entity", "podcast")],
    )
    .await
    .context("Failed to reach iTunes podcast lookup")?
    .bounded_json::<ItunesSearchResponse>(MAX_JSON_BYTES)
    .await
    .context("Failed to parse iTunes podcast lookup response")?;

    Ok(resp.results.into_iter().next().and_then(|r| {
        if r.feed_url.is_empty() {
            return None;
        }
        Some(PodcastSearchResult {
            id: r.collection_id,
            name: r.collection_name,
            artist_name: r.artist_name,
            artwork_url: scale_artwork(&r.artwork_url600, 600),
            feed_url: r.feed_url,
            genre: r.primary_genre_name,
            track_count: r.track_count,
            itunes_url: r.collection_view_url,
        })
    }))
}

/// Returns podcast categories from the Podcast Index API (cached 24h).
pub async fn get_podcast_categories() -> Result<Vec<PodcastCategory>> {
    crate::podcastindex::get_categories().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn oversized_declared_feeds_are_rejected_before_waiting_for_the_body() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let uri = format!("http://{}/feed?token=dummy-private-token", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 2048];
            socket.read(&mut buffer).await.unwrap();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/xml\r\nContent-Length: {}\r\n\r\n", MAX_TEXT_BYTES + 1).as_bytes()).await.unwrap();
            // A client that tries buffering this body would wait for the server.
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        });
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), get_podcast_feed(&uri)).await;
        server.abort();
        let error = format!("{:#}", result.expect("oversized feed waited for its body").unwrap_err());
        assert!(error.contains("exceeds"));
        assert!(!error.contains("dummy-private-token"));
    }

    #[test]
    fn feed_node_limits_reject_small_dense_inputs_and_keep_normal_episode_fields() {
        let crowded = format!("<rss><channel>{}</channel></rss>", "<item/>".repeat(250_000));
        let error = parse_feed("https://feed.example.test", &crowded).unwrap_err();
        assert_eq!(error.downcast_ref::<roxmltree::Error>(), Some(&roxmltree::Error::NodesLimitReached));
        let feed = parse_feed("https://feed.example.test", r#"<rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>Café</title><itunes:author>Author</itunes:author><item><guid>episode-1</guid><title>Episode</title><itunes:duration>01:02:03</itunes:duration><enclosure url="https://audio.example.test/1.mp3" type="audio/mpeg" length="1234"/></item></channel></rss>"#).unwrap();
        assert_eq!(feed.title, "Café");
        assert_eq!(feed.author, "Author");
        assert_eq!(feed.episodes[0].duration_secs, 3723);
        assert_eq!(feed.episodes[0].guid, "episode-1");
        assert_eq!(feed.episodes[0].audio_size, 1234);
        assert_eq!(feed.episodes[0].audio_url, "https://audio.example.test/1.mp3");
        let dtd = "<!DOCTYPE rss [<!ENTITY word 'text'>]><rss><channel><title>&word;</title></channel></rss>";
        assert_eq!(parse_feed("https://feed.example.test", dtd).unwrap_err().downcast_ref::<roxmltree::Error>(), Some(&roxmltree::Error::DtdDetected));
    }
}
