//! Plex lyrics fetching and TTML/LRC parsing.
#![allow(dead_code)]

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

use crate::plex::client::PlexClient;
use crate::plex::models::{LyricsStream, MediaContainer};

/// A single timed lyric line.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LyricLine {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

/// Fetch lyrics for a track and return parsed lines sorted by start time.
///
/// Returns `Ok(vec![])` when the track has no lyrics streams.
/// Prefers TTML over LRC over plain text.
pub async fn get_lyrics(client: &PlexClient, rating_key: i64) -> Result<Vec<LyricLine>> {
    let path = format!("/library/metadata/{}?includeLyrics=1", rating_key);
    let container: MediaContainer<crate::plex::models::Track> = client.get(&path).await?;

    let track = container.metadata.into_iter().next()
        .ok_or_else(|| anyhow::anyhow!("track {} not found", rating_key))?;

    // Strategy 1: top-level Lyrics array (present on some Plex versions).
    // Strategy 2: streamType=4 inside Media.Part.Stream (the format used by
    //             Plex Media Server with LyricFind / external providers).
    let (key, format) = if let Some(s) = pick_lyrics_stream(&track.lyrics) {
        debug!("get_lyrics: track {} using Lyrics array (format={:?})", rating_key, s.format);
        (s.key.clone(), s.format.clone())
    } else {
        // Walk Media → Part → Stream looking for streamType=4 with a key.
        let found = track.media.iter()
            .flat_map(|m| &m.parts)
            .flat_map(|p| &p.streams)
            .find(|s| s.stream_type == Some(4) && s.key.as_deref().unwrap_or("").starts_with('/'));

        match found {
            Some(s) => {
                let k = s.key.clone().unwrap_or_default();
                let f = s.format.clone().unwrap_or_default();
                debug!("get_lyrics: track {} using Part.Stream streamType=4 (format={:?} key={:?})", rating_key, f, k);
                (k, f)
            }
            None => {
                debug!("get_lyrics: track {} has no lyrics streams", rating_key);
                return Ok(vec![]);
            }
        }
    };

    let raw = client.get_text(&key).await
        .map_err(|e| { warn!("get_lyrics: failed to fetch stream {:?}: {}", key, e); e })?;

    let mut lines = match format.to_lowercase().as_str() {
        "ttml" => parse_ttml(&raw),
        "lrc"  => parse_lrc(&raw),
        _      => parse_plain(&raw),
    };
    lines.sort_by_key(|l| l.start_ms);
    debug!("get_lyrics: track {} parsed {} lines (format={})", rating_key, lines.len(), format);
    Ok(lines)
}

/// Pick the best available lyrics stream (prefer ttml, then lrc, then any).
fn pick_lyrics_stream(streams: &[LyricsStream]) -> Option<&LyricsStream> {
    let lower = |s: &&LyricsStream| s.format.to_lowercase();
    streams.iter().find(|s| lower(s) == "ttml")
        .or_else(|| streams.iter().find(|s| lower(s) == "lrc"))
        .or_else(|| streams.first())
}

// ---------------------------------------------------------------------------
// TTML parser
// ---------------------------------------------------------------------------

/// Parse a TTML XML document into lyric lines.
pub fn parse_ttml(xml: &str) -> Vec<LyricLine> {
    let doc = match roxmltree::Document::parse(xml) {
        Ok(d) => d,
        Err(_) => return vec![],
    };

    let mut raw: Vec<(u64, u64, String)> = Vec::new();
    for node in doc.descendants() {
        if node.tag_name().name() != "p" { continue; }
        let begin = node.attribute("begin").unwrap_or("");
        let end   = node.attribute("end").unwrap_or("");
        // Collect all text nodes inside <p> (handles inline spans)
        let text: String = node.descendants()
            .filter(|n| n.is_text())
            .map(|n| n.text().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("")
            .trim()
            .to_string();
        if text.is_empty() { continue; }
        let start_ms = match parse_ttml_time(begin) { Some(t) => t, None => continue };
        let end_ms   = parse_ttml_time(end).unwrap_or(start_ms + 3000);
        raw.push((start_ms, end_ms, text));
    }
    raw.into_iter().map(|(start_ms, end_ms, text)| LyricLine { start_ms, end_ms, text }).collect()
}

/// Parse a TTML timestamp: `hh:mm:ss.mmm`, `mm:ss.mmm`, `ss.mmm`, or plain ms integer.
pub(crate) fn parse_ttml_time(s: &str) -> Option<u64> {
    if !s.contains(':') && !s.contains('.') {
        return s.parse::<u64>().ok();
    }
    let colon_parts: Vec<&str> = s.split(':').collect();
    let (hh, mm, ss_frac) = match colon_parts.len() {
        1 => (0u64, 0u64, colon_parts[0]),
        2 => (0u64, colon_parts[0].parse().ok()?, colon_parts[1]),
        _ => (colon_parts[0].parse().ok()?, colon_parts[1].parse().ok()?, colon_parts[2]),
    };
    let (secs, frac_ms) = parse_seconds_frac(ss_frac)?;
    Some(hh * 3_600_000 + mm * 60_000 + secs * 1000 + frac_ms)
}

// ---------------------------------------------------------------------------
// LRC parser
// ---------------------------------------------------------------------------

/// Parse an LRC file into lyric lines.
pub fn parse_lrc(text: &str) -> Vec<LyricLine> {
    let mut raw: Vec<(u64, String)> = Vec::new();

    for line in text.lines() {
        let line = line.trim();
        // Skip LRC metadata tags
        if matches!(line.get(..4), Some("[ar:") | Some("[ti:") | Some("[al:") | Some("[by:")) { continue; }
        if line.starts_with("[offset:") { continue; }

        let mut rest = line;
        let mut timestamps: Vec<u64> = Vec::new();
        while rest.starts_with('[') {
            let close = match rest.find(']') { Some(i) => i, None => break };
            let ts_str = &rest[1..close];
            if let Some(ms) = parse_lrc_time(ts_str) {
                timestamps.push(ms);
                rest = &rest[close + 1..];
            } else {
                break;
            }
        }
        if timestamps.is_empty() { continue; }
        let lyric_text = rest.trim().to_string();
        if lyric_text.is_empty() { continue; }
        for ts in timestamps {
            raw.push((ts, lyric_text.clone()));
        }
    }

    raw.sort_by_key(|(ts, _)| *ts);
    let n = raw.len();
    (0..n).map(|i| {
        let (start_ms, ref t) = raw[i];
        let end_ms = if i + 1 < n { raw[i + 1].0 } else { start_ms + 3000 };
        LyricLine { start_ms, end_ms, text: t.clone() }
    }).collect()
}

/// Parse LRC timestamp `mm:ss.xx` or `mm:ss.xxx`.
fn parse_lrc_time(s: &str) -> Option<u64> {
    let colon = s.find(':')?;
    let mm: u64 = s[..colon].parse().ok()?;
    let (secs, frac_ms) = parse_seconds_frac(&s[colon + 1..])?;
    Some(mm * 60_000 + secs * 1000 + frac_ms)
}

// ---------------------------------------------------------------------------
// Plain text fallback
// ---------------------------------------------------------------------------

/// Treat each non-empty line as a lyric with sequential synthetic timestamps.
pub fn parse_plain(text: &str) -> Vec<LyricLine> {
    text.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .enumerate()
        .map(|(i, line)| LyricLine {
            start_ms: (i as u64) * 4000,
            end_ms:   (i as u64) * 4000 + 3800,
            text: line.to_string(),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Parse `"ss.mmm"` or `"ss.xx"` (hundredths) into (whole_seconds, frac_ms).
pub(crate) fn parse_seconds_frac(s: &str) -> Option<(u64, u64)> {
    if let Some(dot) = s.find('.') {
        let secs: u64 = s[..dot].parse().ok()?;
        let frac_str = &s[dot + 1..];
        let frac_ms = match frac_str.len() {
            0 => 0,
            1 => frac_str.parse::<u64>().ok()? * 100,
            2 => frac_str.parse::<u64>().ok()? * 10,
            3 => frac_str.parse::<u64>().ok()?,
            _ => frac_str[..3].parse::<u64>().ok()?,
        };
        Some((secs, frac_ms))
    } else {
        Some((s.parse().ok()?, 0))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plex::client::{PlexClient, PlexClientConfig};
    use crate::plex::models::PlexMedia;

    // -----------------------------------------------------------------------
    // Test helpers
    // -----------------------------------------------------------------------

    fn get_client() -> PlexClient {
        let url   = std::env::var("PLEX_URL").expect("PLEX_URL required for integration tests");
        let token = std::env::var("PLEX_TOKEN").expect("PLEX_TOKEN required for integration tests");
        PlexClient::new(PlexClientConfig {
            base_url: url,
            token,
            accept_invalid_certs: true,
            ..Default::default()
        })
        .expect("Failed to create PlexClient")
    }

    async fn get_music_section_id(c: &PlexClient) -> i64 {
        let sections = c.get_all_sections().await.expect("get_all_sections failed");
        sections.iter()
            .find(|s| s.title == "Music")
            .map(|s| s.key)
            .expect("No 'Music' section found")
    }

    /// Find a recently-added track that has lyrics streams (using includeLyrics=1).
    /// Returns the rating_key of the first track that has at least one lyrics stream.
    async fn find_track_with_lyrics(c: &PlexClient, section_id: i64) -> Option<i64> {
        // Fetch recently added tracks
        let items = match c.recently_added(section_id, Some("track"), Some(50)).await {
            Ok(v) => v,
            Err(e) => { println!("recently_added failed: {}", e); return None; }
        };

        for item in items {
            let PlexMedia::Track(t) = item else { continue };
            // Re-fetch with includeLyrics=1 to see the Lyrics field
            let path = format!("/library/metadata/{}?includeLyrics=1", t.rating_key);
            let container: crate::plex::models::MediaContainer<crate::plex::models::Track> =
                match c.get(&path).await {
                    Ok(v) => v,
                    Err(_) => continue,
                };
            if let Some(track) = container.metadata.into_iter().next() {
                if !track.lyrics.is_empty() {
                    println!("Found track with lyrics: '{}' (id={})", track.title, t.rating_key);
                    return Some(t.rating_key);
                }
            }
        }
        None
    }

    // -----------------------------------------------------------------------
    // Unit tests: TTML time parsing
    // -----------------------------------------------------------------------

    #[test]
    fn test_ttml_time_hh_mm_ss_ms() {
        assert_eq!(parse_ttml_time("00:01:30.500"), Some(90_500));
        assert_eq!(parse_ttml_time("01:00:00.000"), Some(3_600_000));
        assert_eq!(parse_ttml_time("00:00:00.000"), Some(0));
    }

    #[test]
    fn test_ttml_time_mm_ss_ms() {
        assert_eq!(parse_ttml_time("01:30.500"), Some(90_500));
        assert_eq!(parse_ttml_time("00:03.250"), Some(3_250));
        assert_eq!(parse_ttml_time("02:00.000"), Some(120_000));
    }

    #[test]
    fn test_ttml_time_ss_ms() {
        assert_eq!(parse_ttml_time("3.5"),   Some(3_500));
        assert_eq!(parse_ttml_time("0.000"), Some(0));
        assert_eq!(parse_ttml_time("90.25"), Some(90_250));
    }

    #[test]
    fn test_ttml_time_plain_ms() {
        assert_eq!(parse_ttml_time("1000"), Some(1000));
        assert_eq!(parse_ttml_time("0"),    Some(0));
    }

    // -----------------------------------------------------------------------
    // Unit tests: LRC time parsing
    // -----------------------------------------------------------------------

    #[test]
    fn test_lrc_time_hundredths() {
        // [mm:ss.xx] — hundredths
        assert_eq!(parse_lrc_time("01:30.50"), Some(90_500));
        assert_eq!(parse_lrc_time("00:03.25"), Some(3_250));
        assert_eq!(parse_lrc_time("00:00.00"), Some(0));
    }

    #[test]
    fn test_lrc_time_milliseconds() {
        // [mm:ss.xxx] — milliseconds
        assert_eq!(parse_lrc_time("01:30.500"), Some(90_500));
        assert_eq!(parse_lrc_time("00:03.250"), Some(3_250));
    }

    // -----------------------------------------------------------------------
    // Unit tests: LRC parser
    // -----------------------------------------------------------------------

    #[test]
    fn test_parse_lrc_basic() {
        let lrc = "\
[ar:PassCode]
[ti:Ray]
[00:01.00]First line
[00:04.50]Second line
[00:08.00]Third line
";
        let lines = parse_lrc(lrc);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].text, "First line");
        assert_eq!(lines[0].start_ms, 1_000);
        assert_eq!(lines[0].end_ms, 4_500);   // = next line's start
        assert_eq!(lines[1].text, "Second line");
        assert_eq!(lines[1].start_ms, 4_500);
        assert_eq!(lines[1].end_ms, 8_000);
        assert_eq!(lines[2].text, "Third line");
        assert_eq!(lines[2].end_ms, 11_000);  // last line: start + 3000
    }

    #[test]
    fn test_parse_lrc_skips_empty_lines() {
        let lrc = "[00:01.00]\n[00:04.00]Hello\n";
        let lines = parse_lrc(lrc);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].text, "Hello");
    }

    #[test]
    fn test_parse_lrc_multi_timestamp() {
        // Same lyric at two timestamps (chorus repeat)
        let lrc = "[00:05.00][01:05.00]Chorus line\n";
        let lines = parse_lrc(lrc);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].start_ms, 5_000);
        assert_eq!(lines[1].start_ms, 65_000);
        assert_eq!(lines[0].text, "Chorus line");
        assert_eq!(lines[1].text, "Chorus line");
    }

    // -----------------------------------------------------------------------
    // Unit tests: TTML parser
    // -----------------------------------------------------------------------

    #[test]
    fn test_parse_ttml_basic() {
        let ttml = r#"<?xml version="1.0"?>
<tt xmlns="http://www.w3.org/ns/ttml">
  <body><div>
    <p begin="00:00:01.000" end="00:00:04.000">First line</p>
    <p begin="00:00:04.500" end="00:00:08.000">Second line</p>
    <p begin="00:00:08.000" end="00:00:11.000">Third line</p>
  </div></body>
</tt>"#;
        let lines = parse_ttml(ttml);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].text, "First line");
        assert_eq!(lines[0].start_ms, 1_000);
        assert_eq!(lines[0].end_ms, 4_000);
        assert_eq!(lines[1].text, "Second line");
        assert_eq!(lines[2].text, "Third line");
    }

    #[test]
    fn test_parse_ttml_inline_spans() {
        let ttml = r#"<?xml version="1.0"?>
<tt xmlns="http://www.w3.org/ns/ttml">
  <body><div>
    <p begin="00:00:01.000" end="00:00:04.000"><span>Word1</span> <span>Word2</span></p>
  </div></body>
</tt>"#;
        let lines = parse_ttml(ttml);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].text.contains("Word1"));
        assert!(lines[0].text.contains("Word2"));
    }

    #[test]
    fn test_parse_ttml_empty_p_skipped() {
        let ttml = r#"<?xml version="1.0"?>
<tt xmlns="http://www.w3.org/ns/ttml">
  <body><div>
    <p begin="00:00:01.000" end="00:00:02.000">  </p>
    <p begin="00:00:03.000" end="00:00:06.000">Real line</p>
  </div></body>
</tt>"#;
        let lines = parse_ttml(ttml);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].text, "Real line");
    }

    #[test]
    fn test_parse_ttml_invalid_xml_returns_empty() {
        let lines = parse_ttml("this is not xml");
        assert!(lines.is_empty());
    }

    // -----------------------------------------------------------------------
    // Unit tests: plain text fallback
    // -----------------------------------------------------------------------

    #[test]
    fn test_parse_plain() {
        let text = "Line one\n\nLine two\nLine three\n";
        let lines = parse_plain(text);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].text, "Line one");
        assert_eq!(lines[0].start_ms, 0);
        assert_eq!(lines[1].text, "Line two");
        assert_eq!(lines[1].start_ms, 4_000);
        assert_eq!(lines[2].text, "Line three");
        assert_eq!(lines[2].start_ms, 8_000);
    }

    // -----------------------------------------------------------------------
    // Integration tests
    // -----------------------------------------------------------------------

    /// Diagnostic: fetch the raw Plex JSON for a recently-added track with
    /// `includeLyrics=1` and print what Plex returns in the `Lyrics` field.
    /// This lets us confirm whether Plex is returning lyrics at all.
    #[tokio::test]
    async fn test_raw_plex_response_for_lyrics() {
        let client = get_client();
        let section_id = get_music_section_id(&client).await;

        let items = match client.recently_added(section_id, Some("track"), Some(5)).await {
            Ok(v) => v,
            Err(e) => { println!("recently_added failed: {}", e); return; }
        };

        let Some(track_key) = items.into_iter().find_map(|m| {
            if let PlexMedia::Track(t) = m { Some(t.rating_key) } else { None }
        }) else {
            println!("No tracks found — skipping");
            return;
        };

        let path = format!("/library/metadata/{}?includeLyrics=1", track_key);
        let raw = match client.get_raw(&path).await {
            Ok(r) => r,
            Err(e) => { println!("get_raw failed: {}", e); return; }
        };

        // Parse just enough to find the Lyrics section
        let v: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => { println!("JSON parse error: {}", e); return; }
        };

        let lyrics_val = &v["MediaContainer"]["Metadata"][0]["Lyrics"];
        println!("--- raw Lyrics field for track {} ---", track_key);
        println!("{}", serde_json::to_string_pretty(lyrics_val).unwrap_or_default());

        let media_val = &v["MediaContainer"]["Metadata"][0]["Media"];
        println!("--- Media (first part streams) ---");
        println!("{}", serde_json::to_string_pretty(&media_val[0]["Part"][0]["Stream"]).unwrap_or_default());
    }

    /// End-to-end: find a track with lyrics and confirm we can parse them.
    #[tokio::test]
    async fn test_get_lyrics_for_track_with_lyrics() {
        let client = get_client();
        let section_id = get_music_section_id(&client).await;

        let Some(key) = find_track_with_lyrics(&client, section_id).await else {
            println!("No tracks with lyrics found in recently_added — skipping");
            return;
        };

        match get_lyrics(&client, key).await {
            Ok(lines) if lines.is_empty() => println!("get_lyrics returned 0 lines for track {}", key),
            Ok(lines) => {
                println!("get_lyrics returned {} lines for track {}", lines.len(), key);
                println!("  First: {:?}", lines.first());
                println!("  Last:  {:?}", lines.last());
            }
            Err(e) => println!("get_lyrics error: {}", e),
        }
    }

    /// Search recently added tracks and report lyrics status for each.
    #[tokio::test]
    async fn test_lyrics_coverage_report() {
        let client = get_client();
        let section_id = get_music_section_id(&client).await;

        let items = match client.recently_added(section_id, Some("track"), Some(20)).await {
            Ok(v) => v,
            Err(e) => { println!("recently_added failed: {}", e); return; }
        };

        let mut has_lyrics = 0usize;
        let mut no_lyrics  = 0usize;

        for item in items {
            let PlexMedia::Track(t) = item else { continue };
            let path = format!("/library/metadata/{}?includeLyrics=1", t.rating_key);
            let container: crate::plex::models::MediaContainer<crate::plex::models::Track> =
                match client.get(&path).await {
                    Ok(v) => v,
                    Err(e) => { println!("  track {} fetch error: {}", t.rating_key, e); continue; }
                };
            if let Some(track) = container.metadata.into_iter().next() {
                if track.lyrics.is_empty() {
                    println!("  NO LYRICS  — {:?} (id={})", track.title, t.rating_key);
                    no_lyrics += 1;
                } else {
                    let fmts: Vec<_> = track.lyrics.iter().map(|s| s.format.as_str()).collect();
                    println!("  HAS LYRICS — {:?} (id={}) formats={:?}", track.title, t.rating_key, fmts);
                    has_lyrics += 1;
                }
            }
        }

        println!("\n--- Summary: {} with lyrics, {} without ---", has_lyrics, no_lyrics);
    }
}
