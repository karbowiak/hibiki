//! Genius API integration — search for songs and scrape lyrics from Genius pages.
//!
//! # Auth flow
//! Genius uses client credentials (client_id + client_secret) to obtain an access token
//! via `POST https://api.genius.com/oauth/token`. The token is cached with a 1h TTL.
//!
//! # Lyrics scraping
//! Genius does not provide lyrics via their API. Instead, we fetch the song page HTML
//! and extract text from `<div data-lyrics-container="true">` elements.

use crate::http_response::{BoundedResponseExt, MAX_JSON_BYTES, MAX_TEXT_BYTES};
use anyhow::{bail, Context, Result};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::Instant;

static GENIUS_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .expect("Failed to build Genius HTTP client")
});

/// Cached access token is bound to the exact client credentials and expiry.
type TokenCache = Mutex<Option<([u8; 32], String, Instant)>>;
static TOKEN_CACHE: Lazy<TokenCache> = Lazy::new(|| Mutex::new(None));

const TOKEN_TTL_SECS: u64 = 3600; // 1 hour

// ---------------------------------------------------------------------------
// Public return types (serialized to TypeScript via Tauri)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct GeniusSearchHit {
    pub id: u64,
    pub title: String,
    pub artist: String,
    pub url: String,
    pub thumbnail_url: String,
    pub pageviews: u64,
    /// Relevance score: higher = better match. Based on artist + title similarity.
    pub relevance: f64,
}

#[derive(Debug, Serialize, Clone)]
pub struct GeniusLyricLine {
    pub text: String,
}

// ---------------------------------------------------------------------------
// Private response models (deserialization only)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
}

#[derive(Debug, Deserialize)]
struct SearchResponse {
    response: SearchResponseInner,
}

#[derive(Debug, Deserialize)]
struct SearchResponseInner {
    hits: Vec<SearchHit>,
}

#[derive(Debug, Deserialize)]
struct SearchHit {
    result: SearchResult,
}

#[derive(Debug, Deserialize)]
struct SearchResult {
    id: u64,
    title: String,
    url: String,
    #[serde(default)]
    song_art_image_thumbnail_url: String,
    primary_artist: PrimaryArtist,
    stats: Option<SearchStats>,
}

#[derive(Debug, Deserialize)]
struct PrimaryArtist {
    name: String,
}

#[derive(Debug, Deserialize)]
struct SearchStats {
    #[serde(default)]
    pageviews: Option<u64>,
}

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

/// Obtain an access token using client credentials. Caches for 1 hour.
pub async fn get_access_token(client_id: &str, client_secret: &str) -> Result<String> {
    access_token_from(
        &GENIUS_CLIENT,
        "https://api.genius.com/oauth/token",
        &TOKEN_CACHE,
        client_id,
        client_secret,
    ).await
}

async fn access_token_from(
    client: &reqwest::Client,
    endpoint: &str,
    cache: &TokenCache,
    client_id: &str,
    client_secret: &str,
) -> Result<String> {
    use sha2::{Digest, Sha256};
    let credentials: [u8; 32] = Sha256::digest(serde_json::to_vec(&[client_id, client_secret])?).into();
    // Check cache
    {
        let guard = cache.lock().unwrap();
        if let Some((ref key, ref token, ref issued_at)) = *guard {
            if key == &credentials && issued_at.elapsed().as_secs() < TOKEN_TTL_SECS {
                return Ok(token.clone());
            }
        }
    }

    let resp = client
        .post(endpoint)
        .form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("grant_type", "client_credentials"),
        ])
        .send()
        .await.map_err(|error| error.without_url())
        .context("Failed to reach Genius OAuth endpoint")?
        .error_for_status().map_err(|error| error.without_url())
        .context("Genius OAuth returned error status")?
        .bounded_bytes(MAX_JSON_BYTES)
        .await
        .context("Failed to read Genius token response")?;

    let parsed: TokenResponse =
        serde_json::from_slice(&resp).context("Failed to parse Genius token response")?;

    let token = parsed.access_token;

    // Cache the token
    {
        let mut guard = cache.lock().unwrap();
        *guard = Some((credentials, token.clone(), Instant::now()));
    }

    Ok(token)
}

// ---------------------------------------------------------------------------
// Fuzzy matching
// ---------------------------------------------------------------------------

/// Normalize a string for comparison: lowercase, strip punctuation, collapse whitespace.
fn normalize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_alphanumeric() || c.is_whitespace() { c.to_ascii_lowercase() } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Check if all words in `needle` appear in `haystack` (order-independent).
fn words_match(needle: &str, haystack: &str) -> bool {
    let needle_words: Vec<&str> = needle.split_whitespace().collect();
    let haystack_lower = haystack.to_lowercase();
    needle_words.iter().all(|w| haystack_lower.contains(w))
}

/// Score how well a Genius hit matches the requested artist + title.
/// Returns 0.0–1.0 where 1.0 = perfect match, 0.0 = no match.
fn relevance_score(query_artist: &str, query_title: &str, hit_artist: &str, hit_title: &str) -> f64 {
    let qa = normalize(query_artist);
    let qt = normalize(query_title);
    let ha = normalize(hit_artist);
    let ht = normalize(hit_title);

    // Title scoring (0.0 – 0.6)
    let title_score = if ht == qt {
        0.6
    } else if ht.contains(&qt) || qt.contains(&ht) {
        0.5
    } else if words_match(&qt, &ht) {
        0.4
    } else {
        // Check word overlap ratio
        let qt_words: Vec<&str> = qt.split_whitespace().collect();
        let ht_words: Vec<&str> = ht.split_whitespace().collect();
        if qt_words.is_empty() {
            0.0
        } else {
            let matching = qt_words.iter().filter(|w| ht_words.contains(w)).count();
            (matching as f64 / qt_words.len() as f64) * 0.3
        }
    };

    // Artist scoring (0.0 – 0.4)
    let artist_score = if ha == qa {
        0.4
    } else if ha.contains(&qa) || qa.contains(&ha) {
        0.35
    } else if words_match(&qa, &ha) {
        0.3
    } else {
        // Check word overlap ratio
        let qa_words: Vec<&str> = qa.split_whitespace().collect();
        let ha_words: Vec<&str> = ha.split_whitespace().collect();
        if qa_words.is_empty() {
            0.0
        } else {
            let matching = qa_words.iter().filter(|w| ha_words.contains(w)).count();
            (matching as f64 / qa_words.len() as f64) * 0.2
        }
    };

    title_score + artist_score
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/// Search Genius for songs matching the artist + title.
/// Results are scored by relevance and filtered to only include reasonable matches.
pub async fn search(access_token: &str, artist: &str, title: &str) -> Result<Vec<GeniusSearchHit>> {
    let query = format!("{} {}", artist, title);
    let resp = GENIUS_CLIENT
        .get("https://api.genius.com/search")
        .bearer_auth(access_token)
        .query(&[("q", &query)])
        .send()
        .await.map_err(|error| error.without_url())
        .context("Failed to reach Genius search API")?
        .error_for_status().map_err(|error| error.without_url())
        .context("Genius search returned error status")?
        .bounded_bytes(MAX_JSON_BYTES)
        .await
        .context("Failed to read Genius search response")?;

    let parsed: SearchResponse =
        serde_json::from_slice(&resp).context("Failed to parse Genius search response")?;

    let mut hits: Vec<GeniusSearchHit> = parsed
        .response
        .hits
        .into_iter()
        .map(|h| {
            let r = h.result;
            let relevance = relevance_score(artist, title, &r.primary_artist.name, &r.title);
            GeniusSearchHit {
                id: r.id,
                title: r.title,
                artist: r.primary_artist.name,
                url: r.url,
                thumbnail_url: r.song_art_image_thumbnail_url,
                pageviews: r.stats.and_then(|s| s.pageviews).unwrap_or(0),
                relevance,
            }
        })
        // Filter: require at least some title OR artist match (score > 0.2)
        .filter(|h| h.relevance > 0.2)
        .collect();

    // Sort by relevance descending, then pageviews as tiebreaker
    hits.sort_by(|a, b| {
        b.relevance.partial_cmp(&a.relevance).unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.pageviews.cmp(&a.pageviews))
    });

    Ok(hits)
}

// ---------------------------------------------------------------------------
// Lyrics scraping
// ---------------------------------------------------------------------------

/// Scrape lyrics from a Genius song page URL.
///
/// Fetches the page HTML and extracts text from `<div data-lyrics-container="true">` elements.
/// Returns one `GeniusLyricLine` per line of lyrics text.
pub async fn scrape_lyrics(url: &str) -> Result<Vec<GeniusLyricLine>> {
    let html = GENIUS_CLIENT
        .get(url)
        .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
        .send()
        .await.map_err(|error| error.without_url())
        .context("Failed to fetch Genius song page")?
        .error_for_status().map_err(|error| error.without_url())
        .context("Genius song page returned error status")?
        .bounded_text(MAX_TEXT_BYTES)
        .await
        .context("Failed to read Genius page HTML")?;

    let document = scraper::Html::parse_document(&html);
    let selector = scraper::Selector::parse(r#"div[data-lyrics-container="true"]"#)
        .map_err(|e| anyhow::anyhow!("Invalid CSS selector: {:?}", e))?;

    let mut lines = Vec::new();

    for element in document.select(&selector) {
        let text = extract_text_with_newlines(&element);
        for line in text.lines() {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                lines.push(GeniusLyricLine {
                    text: trimmed.to_string(),
                });
            }
        }
    }

    if lines.is_empty() {
        bail!("No lyrics found on the Genius page");
    }

    Ok(lines)
}

/// Extract text from an HTML element, converting `<br>` tags to newlines.
fn extract_text_with_newlines(element: &scraper::ElementRef) -> String {
    let mut result = String::new();
    // Remote lyrics markup can nest elements deeply. Walk the tree without
    // consuming one Rust stack frame for every nested span.
    for node in element.descendants() {
        match node.value() {
            scraper::Node::Text(text) => {
                result.push_str(text);
            }
            scraper::Node::Element(el) if el.name() == "br" => result.push('\n'),
            _ => {}
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn deep_lyrics_preserve_text_and_line_breaks_without_recursive_traversal() {
        let html = format!(
            "<div data-lyrics-container='true'>Before<br>{}Deep{}After<br>Tail</div>",
            "<span>".repeat(5_000), "</span>".repeat(5_000),
        );
        let document = scraper::Html::parse_fragment(&html);
        let selector = scraper::Selector::parse("div[data-lyrics-container]").unwrap();
        let element = document.select(&selector).next().unwrap();
        assert_eq!(extract_text_with_newlines(&element), "Before\nDeepAfter\nTail");
    }

    #[tokio::test]
    async fn cached_oauth_tokens_are_reused_only_for_the_same_client_and_secret() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/token", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for (client_id, secret, token) in [("client-a", "secret-a", "token-a"), ("client-b", "secret-b", "token-b"), ("client-b", "secret-renewed", "token-renewed")] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                let body = loop {
                    let mut buffer = [0; 2048];
                    let n = socket.read(&mut buffer).await.unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buffer[..n]);
                    if let Some(end) = bytes.windows(4).position(|chunk| chunk == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&bytes[..end]);
                        let length = header.lines().find_map(|line| line.to_lowercase().strip_prefix("content-length:").map(|length| length.trim().parse::<usize>().unwrap())).unwrap();
                        if bytes.len() >= end + 4 + length { break bytes[end+4..end+4+length].to_vec(); }
                    }
                };
                let form: std::collections::HashMap<_, _> = url::form_urlencoded::parse(&body).into_owned().collect();
                assert_eq!(form["client_id"], client_id);
                assert_eq!(form["client_secret"], secret);
                let body = format!(r#"{{"access_token":"{token}"}}"#);
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
        });
        let cache = Mutex::new(None);
        let client = reqwest::Client::new();
        assert_eq!(access_token_from(&client, &endpoint, &cache, "client-a", "secret-a").await.unwrap(), "token-a");
        assert_eq!(access_token_from(&client, &endpoint, &cache, "client-a", "secret-a").await.unwrap(), "token-a");
        assert_eq!(access_token_from(&client, &endpoint, &cache, "client-b", "secret-b").await.unwrap(), "token-b");
        assert_eq!(access_token_from(&client, &endpoint, &cache, "client-b", "secret-renewed").await.unwrap(), "token-renewed");
        server.await.unwrap();
    }
}
