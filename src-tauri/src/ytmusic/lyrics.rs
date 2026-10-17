//! Track lyrics follow the watch response's lyric destination, never a title search.
use super::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Line { start_ms: u64, end_ms: u64, text: String }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Lyrics {
    pub lines: Vec<Line>,
    pub attribution: Option<String>,
    pub missing: bool,
}
fn find<'a>(value: &'a Value, key: &str, depth: usize) -> Option<&'a Value> {
    if depth > 40 { return None; }
    match value {
        Value::Object(map) => map.get(key).or_else(|| map.values().find_map(|v| find(v, key, depth + 1))),
        Value::Array(list) => list.iter().find_map(|v| find(v, key, depth + 1)),
        _ => None,
    }
}
fn text(value: &Value) -> String {
    value.as_str().or_else(|| value["simpleText"].as_str()).map(str::to_owned).unwrap_or_else(||
        value["runs"].as_array().map(|runs| runs.iter().filter_map(|run| run["text"].as_str()).collect()).unwrap_or_default())
}
fn milliseconds(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_str()?.parse().ok()).filter(|ms| *ms <= 86_400_000)
}
fn parse(value: &Value) -> Result<Lyrics, String> {
    if let Some(data) = find(value, "timedLyricsData", 0).and_then(Value::as_array) {
        let mut lines = Vec::new();
        let timed = data.iter().all(|line| line.get("cueRange").is_some());
        for raw in data.iter().take(5000) {
            let content = raw["lyricLine"].as_str().ok_or("YouTube Music lyrics format changed.")?;
            let (start_ms, end_ms) = if timed {
                let start = milliseconds(&raw["cueRange"]["startTimeMilliseconds"]).ok_or("YouTube Music lyrics timing changed.")?;
                let end = milliseconds(&raw["cueRange"]["endTimeMilliseconds"]).ok_or("YouTube Music lyrics timing changed.")?;
                if end < start { return Err("YouTube Music lyrics timing changed.".into()); }
                (start, end)
            } else { (0, 0) };
            lines.push(Line { start_ms, end_ms, text: content.into() });
        }
        return Ok(Lyrics { missing: lines.iter().all(|line| line.text.trim().is_empty()), lines,
            attribution: find(value, "sourceMessage", 0).map(text).filter(|v| !v.is_empty()) });
    }
    if let Some(shelf) = find(value, "musicDescriptionShelfRenderer", 0) {
        let content = text(&shelf["description"]);
        if content.trim().is_empty() { return Err("YouTube Music returned an empty lyrics response. Try again.".into()); }
        return Ok(Lyrics { lines: content.lines().take(5000).map(|line| Line { start_ms: 0, end_ms: 0, text: line.into() }).collect(),
            attribution: Some(text(&shelf["footer"])).filter(|v| !v.is_empty()), missing: false });
    }
    Err("YouTube Music lyrics format changed. Other lyrics sources will be tried.".into())
}
pub(super) async fn load(app: &tauri::AppHandle, generation: u64, context: &api::Context, cookies: &session::Cookies, watch: &Value) -> Result<(Lyrics, Option<discovery_cache::Policy>), String> {
    let tabs = find(watch, "watchNextTabbedResultsRenderer", 0).or_else(|| find(watch, "musicWatchNextTabbedResultsRenderer", 0)).and_then(|v| v["tabs"].as_array())
        .ok_or("YouTube Music did not return lyrics availability. Other sources will be tried.")?;
    let endpoint = tabs.iter().filter_map(|tab| tab.pointer("/tabRenderer/endpoint/browseEndpoint"))
        .find(|endpoint| endpoint["browseId"].as_str().is_some_and(|id| id.starts_with("MPLY")) ||
            endpoint.pointer("/browseEndpointContextSupportedConfigs/browseEndpointContextMusicConfig/pageType").and_then(Value::as_str) == Some("MUSIC_PAGE_TYPE_TRACK_LYRICS"));
    let Some(id) = endpoint.and_then(|e| e["browseId"].as_str()).filter(|id| id.starts_with("MPLY") && id.len() <= 256) else {
        if tabs.get(1).is_some_and(|tab| tab["tabRenderer"]["unselectable"] == true) {
            return Ok((Lyrics { lines: Vec::new(), attribution: None, missing: true }, None));
        }
        return Err("YouTube Music did not return a lyrics destination. Other sources will be tried.".into());
    };
    let response = api::request_with_policy(context, cookies, "browse", json!({ "browseId": id }), 2 * 3600).await
        .map_err(|failure| if failure.auth { failure.report(app, generation) } else { failure.message.into() })?;
    Ok((parse(&response.value)?, Some(response.policy)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn timed_and_plain_lyrics_are_distinct_from_changed_responses() {
        let timed = parse(&json!({ "timedLyricsData": [{ "lyricLine": "Hello", "cueRange": { "startTimeMilliseconds": "1200", "endTimeMilliseconds": 2400 }}]})).unwrap();
        assert_eq!(timed.lines[0].start_ms, 1200);
        assert!(!timed.missing);
        let plain = parse(&json!({ "musicDescriptionShelfRenderer": { "description": { "runs": [{ "text": "One\nTwo" }] } }})).unwrap();
        assert_eq!(plain.lines.len(), 2);
        assert!(parse(&json!({})).is_err());
        assert!(parse(&json!({ "timedLyricsData": [{ "lyricLine": "Bad", "cueRange": { "startTimeMilliseconds": 12, "endTimeMilliseconds": 1 }}]})).is_err());
    }
}
