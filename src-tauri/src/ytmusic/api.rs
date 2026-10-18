//! Small cookie-authenticated InnerTube client. No Google OAuth credentials.
use super::*;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};

#[derive(Debug)]
pub(crate) struct Failure {
    pub auth: bool,
    pub message: &'static str,
}
impl Failure {
    fn unavailable(message: &'static str) -> Self {
        Self {
            auth: false,
            message,
        }
    }
    fn auth() -> Self {
        Self {
            auth: true,
            message: "Sign in to YouTube Music again.",
        }
    }

    pub(crate) fn report(self, app: &tauri::AppHandle, generation: u64) -> String {
        app.state::<Arc<YoutubeMusic>>()
            .failure(app, generation, self.auth, self.message);
        self.message.into()
    }
}

pub(crate) struct Context {
    state: Arc<YoutubeMusic>,
    generation: u64,
    body: Value,
    user_agent: String,
    visitor: String,
    account: String,
    delegated: Option<String>,
    data_sync_id: Option<String>,
}

impl Context {
    /// Stable account/brand identity, never a cookie or a session index. Only an
    /// opaque digest is exposed to the trusted client for durable local records.
    pub(super) fn identity(&self) -> Option<String> {
        let id = self.data_sync_id.as_deref().filter(|id| !id.trim().is_empty())?;
        Some(hex::encode(Sha1::digest(format!("hibiki-ytmusic-account-v1:{id}:{}", self.delegated.as_deref().unwrap_or("")).as_bytes())))
    }
}

pub(super) async fn context(app: &tauri::AppHandle) -> Result<Context, Failure> {
    let state = app.state::<Arc<YoutubeMusic>>().inner().clone();
    let generation = state.generation().map_err(|_| Failure::unavailable("Connect YouTube Music first."))?;
    let window = app
        .get_webview_window(WINDOW)
        .ok_or_else(|| Failure::unavailable("Open YouTube Music to sign in first."))?;
    if window.url().ok().as_ref().and_then(|url| url.host_str()) != Some("music.youtube.com") {
        return Err(Failure::unavailable("Finish signing in to YouTube Music."));
    }
    let (send, receive) = tokio::sync::oneshot::channel();
    let send = Mutex::new(Some(send));
    // Read configuration only on the music page; credentials use native cookie APIs.
    window
        .eval_with_callback(
            r#"(() => {
        const c = window.ytcfg;
        if (!c || typeof c.get !== 'function') return null;
        return { loggedIn: c.get('LOGGED_IN'), context: c.get('INNERTUBE_CONTEXT'),
          visitor: c.get('VISITOR_DATA'), account: c.get('SESSION_INDEX'),
          dataSyncId: c.get('DATASYNC_ID'),
          delegated: c.get('DELEGATED_SESSION_ID'), userAgent: navigator.userAgent };
    })()"#,
            move |value| {
                if let Ok(mut sender) = send.lock() {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(value);
                    }
                }
            },
        )
        .map_err(|_| Failure::unavailable("Could not read YouTube Music page configuration."))?;
    let text = tokio::time::timeout(std::time::Duration::from_secs(5), receive)
        .await
        .map_err(|_| Failure::unavailable("YouTube Music page is still loading. Try again."))?
        .map_err(|_| Failure::unavailable("YouTube Music page closed."))?;
    if window.url().ok().as_ref().and_then(|url| url.host_str()) != Some("music.youtube.com") {
        return Err(Failure::unavailable("Finish signing in to YouTube Music."));
    }
    let mut value: Value = serde_json::from_str(&text)
        .map_err(|_| Failure::unavailable("YouTube Music configuration changed."))?;
    if let Some(text) = value.as_str() {
        value = serde_json::from_str(text)
            .map_err(|_| Failure::unavailable("YouTube Music configuration changed."))?;
    }
    if value["loggedIn"] == false {
        return Err(Failure::auth());
    }
    if value["loggedIn"] != true || !value["context"]["client"]["clientVersion"].is_string() {
        return Err(Failure::unavailable(
            "YouTube Music page is still loading. Try again.",
        ));
    }
    let account = value["account"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| value["account"].as_u64().map(|value| value.to_string()))
        .unwrap_or_else(|| "0".into());
    if !state.owns(generation) { return Err(Failure::unavailable("YouTube Music session changed.")); }
    Ok(Context {
        state, generation,
        body: value["context"].clone(),
        user_agent: value["userAgent"].as_str().unwrap_or("Hibiki").to_owned(),
        visitor: value["visitor"].as_str().unwrap_or_default().to_owned(),
        delegated: value["delegated"].as_str().map(str::to_owned),
        account,
        data_sync_id: value["dataSyncId"].as_str().map(str::to_owned),
    })
}

pub(crate) fn authorization(cookies: &session::Cookies, timestamp: i64) -> Result<String, Failure> {
    let sapisid = cookies
        .iter()
        .find(|cookie| cookie.name() == "__Secure-3PAPISID")
        .or_else(|| cookies.iter().find(|cookie| cookie.name() == "SAPISID"))
        .filter(|cookie| !cookie.value().is_empty())
        .ok_or_else(Failure::auth)?;
    let hash = Sha1::digest(format!("{timestamp} {} {ORIGIN}", sapisid.value()).as_bytes());
    Ok(format!("SAPISIDHASH {timestamp}_{}", hex::encode(hash)))
}

pub(super) async fn request(
    context: &Context,
    cookies: &session::Cookies,
    endpoint: &str,
    body: Value,
) -> Result<Value, Failure> {
    Ok(request_with_policy(context, cookies, endpoint, body, 15 * 60).await?.value)
}

pub(crate) async fn set_song_like(app: &tauri::AppHandle, video_id: &str, liked: bool, expected_account: Option<&str>) -> Result<(), String> {
    if !valid_video_id(video_id) { return Err("Choose a valid YouTube Music song.".into()); }
    let state = app.state::<Arc<YoutubeMusic>>();
    let generation = state.generation()?;
    let lock = state.discovery_cache.request("song-like-mutation");
    let _guard = lock.lock().await;
    if !state.owns(generation) { return Err("YouTube Music connection changed.".into()); }
    let epoch = state.discovery_cache.epoch();
    let cookies = session::cookies(app).await?;
    let context = context(app).await.map_err(|failure| if failure.auth { failure.report(app, generation) } else { failure.message.into() })?;
    if expected_account.is_some_and(|expected| context.identity().as_deref() != Some(expected)) {
        return Err("YouTube Music account changed. Reconnect the original account to save this like.".into());
    }
    let response = request(&context, &cookies, if liked { "like/like" } else { "like/removelike" },
        json!({ "target": { "videoId": video_id } })).await
        .map_err(|failure| if failure.auth { failure.report(app, generation) } else { failure.message.into() })?;
    if !state.owns(generation) { return Err("YouTube Music connection changed.".into()); }
    if contains_key(&response, "showEngagementPanelEndpoint", 0) || contains_key(&response, "confirmDialogRenderer", 0) {
        return Err("Open the YouTube Music sign-in window to finish the requested account check, then try again.".into());
    }
    if response["status"].as_str().is_some_and(|status| status != "STATUS_SUCCEEDED") {
        return Err("YouTube Music could not save this like. Try again.".into());
    }
    if let Ok(directory) = app.path().app_cache_dir() {
        state.discovery_cache.song_like_changed(directory.join("ytmusic-discovery"), video_id.into(), liked, epoch).await;
    }
    if !state.owns(generation) { return Err("YouTube Music connection changed.".into()); }
    Ok(())
}

pub(super) struct Response {
    pub value: Value,
    pub policy: discovery_cache::Policy,
}

pub(super) async fn request_with_policy(
    context: &Context,
    cookies: &session::Cookies,
    endpoint: &str,
    mut body: Value,
    fallback_ttl: i64,
) -> Result<Response, Failure> {
    let started = tokio::time::Instant::now();
    let _permit = rate_limit::REQUESTS.admit(|| context.state.owns(context.generation))
        .await.map_err(Failure::unavailable)?;
    body["context"] = context.body.clone();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| Failure::unavailable("YouTube Music connection unavailable."))?;
    let mut request = client
        .post(format!("{ORIGIN}/youtubei/v1/{endpoint}?prettyPrint=false"))
        .timeout(std::time::Duration::from_secs(20).saturating_sub(started.elapsed()))
        .header("User-Agent", &context.user_agent)
        .header("Origin", ORIGIN)
        .header("X-Origin", ORIGIN)
        .header("Referer", format!("{ORIGIN}/"))
        .header("X-Goog-AuthUser", &context.account)
        .header("Authorization", authorization(cookies, now())?)
        .header("Cookie", session::cookie_header(cookies))
        .header("X-Youtube-Client-Name", "67")
        .header(
            "X-Youtube-Client-Version",
            context.body["client"]["clientVersion"]
                .as_str()
                .unwrap_or_default(),
        )
        .json(&body);
    if !context.visitor.is_empty() {
        request = request.header("X-Goog-Visitor-Id", &context.visitor);
    }
    if let Some(page) = &context.delegated {
        request = request.header("X-Goog-PageId", page);
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| Failure::unavailable("YouTube Music could not be reached. Try again."))?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(Failure::auth());
    }
    let retry_after = rate_limit::retry_after(response.headers());
    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS ||
        response.status() == reqwest::StatusCode::SERVICE_UNAVAILABLE && retry_after.is_some() {
        rate_limit::REQUESTS.throttle(retry_after);
        return Err(Failure::unavailable(rate_limit::COOLDOWN));
    }
    if !response.status().is_success() {
        return Err(Failure::unavailable(
            "YouTube Music rejected the request. Try again later.",
        ));
    }
    let policy = discovery_cache::Policy::from_headers(response.headers(), fallback_ttl, now());
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| Failure::unavailable("YouTube Music response was interrupted."))?
    {
        if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
            return Err(Failure::unavailable(
                "YouTube Music response was too large.",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| Failure::unavailable("YouTube Music response format changed."))?;
    if value.pointer("/responseContext/mainAppWebResponseContext/loggedOut")
        == Some(&Value::Bool(true))
    {
        return Err(Failure::auth());
    }
    if value.get("error").is_some() {
        if value["error"]["code"].as_u64() == Some(429) || value["error"]["status"] == "RESOURCE_EXHAUSTED" {
            rate_limit::REQUESTS.throttle(retry_after);
            return Err(Failure::unavailable(rate_limit::COOLDOWN));
        }
        return Err(Failure::unavailable(
            "YouTube Music API is temporarily unavailable.",
        ));
    }
    if !context.state.owns(context.generation) { return Err(Failure::unavailable("YouTube Music session changed.")); }
    rate_limit::REQUESTS.success();
    Ok(Response { value, policy })
}

pub(crate) async fn verify(
    app: &tauri::AppHandle,
    cookies: &session::Cookies,
) -> Result<Context, Failure> {
    let context = context(app).await?;
    let response = request(&context, cookies, "account/account_menu", json!({})).await?;
    if !contains_key(&response, "activeAccountHeaderRenderer", 0) {
        return Err(Failure::unavailable(
            "YouTube Music did not confirm the signed-in account. Retry the connection.",
        ));
    }
    Ok(context)
}

/// Optional metadata only. A failure must not turn a playable song into an error.
pub(super) async fn player(
    app: &tauri::AppHandle,
    cookies: &session::Cookies,
    id: &str,
) -> Result<Value, Failure> {
    let context = context(app).await?;
    request(
        &context,
        cookies,
        "player",
        json!({
            "videoId": id, "contentCheckOk": true, "racyCheckOk": true
        }),
    )
    .await
}

/// Prefer absolute loudness for the selected encoding, then the player's absolute
/// perceptual measurement. `loudnessDb` is relative to a client-dependent reference
/// and must not be mistaken for LUFS (or an already signed normalization gain).
pub(super) fn player_gain(value: &Value, video_id: &str, itag: Option<&str>) -> Option<f32> {
    if value.pointer("/videoDetails/videoId")?.as_str()? != video_id
        || value.pointer("/playabilityStatus/status")?.as_str()? != "OK"
    {
        return None;
    }
    let absolute = |value: &Value| {
        value
            .as_f64()
            .filter(|db| db.is_finite() && (-70.0..=5.0).contains(db))
    };
    let format_gain = itag.and_then(|itag| {
        value
            .pointer("/streamingData/adaptiveFormats")?
            .as_array()?
            .iter()
            .find_map(|format| {
                if format["itag"].as_u64()?.to_string() != itag
                    || !format["mimeType"].as_str()?.starts_with("audio/")
                {
                    return None;
                }
                absolute(&format["trackAbsoluteLoudnessLkfs"])
            })
    });
    let measured = format_gain
        .or_else(|| absolute(value.pointer("/playerConfig/audioConfig/perceptualLoudnessDb")?))?;
    Some((crate::audio_engine::loudness::REFERENCE_LUFS - measured) as f32)
}

fn contains_key(value: &Value, key: &str, depth: usize) -> bool {
    if depth > 40 {
        return false;
    }
    match value {
        Value::Object(map) => {
            map.contains_key(key)
                || map
                    .values()
                    .any(|value| contains_key(value, key, depth + 1))
        }
        Value::Array(list) => list.iter().any(|value| contains_key(value, key, depth + 1)),
        _ => false,
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Song {
    pub video_id: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration: Option<String>,
    pub thumbnail: Option<String>,
}

#[cfg(test)]
fn text(value: &Value) -> String {
    if let Some(simple) = value["simpleText"].as_str() {
        return simple.to_owned();
    }
    value["runs"]
        .as_array()
        .map(|runs| runs.iter().filter_map(|run| run["text"].as_str()).collect())
        .unwrap_or_default()
}

pub(crate) fn valid_video_id(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

#[cfg(test)]
fn songs(value: &Value, output: &mut Vec<Song>, depth: usize) {
    if depth > 40 || output.len() >= 20 {
        return;
    }
    if let Some(item) = value.get("musicResponsiveListItemRenderer") {
        let endpoint = item.pointer("/overlay/musicItemThumbnailOverlayRenderer/content/musicPlayButtonRenderer/playNavigationEndpoint/watchEndpoint")
            .or_else(|| item.pointer("/navigationEndpoint/watchEndpoint"));
        let id = endpoint.and_then(|endpoint| endpoint["videoId"].as_str());
        if let Some(id) = id.filter(|id| valid_video_id(id)) {
            if !output.iter().any(|song| song.video_id == id) {
                let columns = item["flexColumns"].as_array();
                let column = |index: usize| {
                    columns
                        .and_then(|columns| columns.get(index))
                        .and_then(|column| {
                            column.pointer("/musicResponsiveListItemFlexColumnRenderer/text")
                        })
                };
                let title = column(0).map(text).unwrap_or_default();
                let runs = column(1).and_then(|value| value["runs"].as_array());
                let mut artists = Vec::new();
                let mut album = None;
                let mut duration = None;
                for run in runs.into_iter().flatten() {
                    let label = run["text"].as_str().unwrap_or_default();
                    let browse = run
                        .pointer("/navigationEndpoint/browseEndpoint/browseId")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if browse.starts_with("UC") {
                        artists.push(label);
                    } else if browse.starts_with("MPRE") {
                        album = Some(label.to_owned());
                    } else if label.contains(':')
                        && label
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || byte == b':')
                    {
                        duration = Some(label.to_owned());
                    }
                }
                let thumbnail = item
                    .pointer("/thumbnail/musicThumbnailRenderer/thumbnail/thumbnails")
                    .and_then(Value::as_array)
                    .and_then(|images| images.last())
                    .and_then(|image| image["url"].as_str())
                    .filter(|url| url.starts_with("https://"))
                    .map(str::to_owned);
                if !title.is_empty() {
                    output.push(Song {
                        video_id: id.to_owned(),
                        title,
                        artist: artists.join(", "),
                        album,
                        duration,
                        thumbnail,
                    });
                }
            }
        }
        return;
    }
    match value {
        Value::Object(map) => {
            for value in map.values() {
                songs(value, output, depth + 1);
            }
        }
        Value::Array(list) => {
            for value in list {
                songs(value, output, depth + 1);
            }
        }
        _ => {}
    }
}

pub(crate) async fn search(app: &tauri::AppHandle, query: &str) -> Result<Vec<Song>, String> {
    let query = query.trim();
    if query.is_empty() || query.len() > 200 {
        return Err("Enter an artist or song title (up to 200 characters).".into());
    }
    let page = discovery::browse(app, "hibiki_song_search", Some(query), None, false, false, None).await?;
    Ok(page.items.into_iter().filter(|item| item.kind == "song").take(20).map(|item| Song {
        video_id: item.id, title: item.title, artist: item.artist, album: item.album,
        duration: item.duration, thumbnail: item.thumbnail,
    }).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn loudness_uses_absolute_measurements_and_the_same_target_as_local_tracks() {
        let mut value = json!({"videoDetails":{"videoId":"abcdefghijk"}, "playabilityStatus":{"status":"OK"},
            "playerConfig":{"audioConfig":{"loudnessDb":4.0,"perceptualLoudnessDb":-10.0}},
            "streamingData":{"adaptiveFormats":[{"itag":140,"mimeType":"audio/mp4","trackAbsoluteLoudnessLkfs":-9.0}]}});
        assert_eq!(player_gain(&value, "abcdefghijk", Some("140")), Some(-9.0));
        assert_eq!(player_gain(&value, "abcdefghijk", Some("251")), Some(-8.0));
        assert_eq!(player_gain(&value, "other-video", Some("140")), None);
        value["playerConfig"]["audioConfig"]["perceptualLoudnessDb"] = Value::Null;
        assert_eq!(
            player_gain(&value, "abcdefghijk", Some("251")),
            None,
            "Relative dB is not an absolute loudness or a signed gain"
        );
        value["streamingData"]["adaptiveFormats"][0]["trackAbsoluteLoudnessLkfs"] = json!(300.0);
        assert_eq!(player_gain(&value, "abcdefghijk", Some("140")), None);
        value["playerConfig"]["audioConfig"]["perceptualLoudnessDb"] = json!(-24.0);
        assert_eq!(player_gain(&value, "abcdefghijk", Some("140")), Some(6.0));
        value["playabilityStatus"]["status"] = json!("ERROR");
        assert_eq!(player_gain(&value, "abcdefghijk", Some("140")), None);
    }
    #[test]
    fn authorization_is_time_bound_to_the_music_origin() {
        let cookies = vec![
            tauri::webview::Cookie::build(("__Secure-3PAPISID", "fixture-session"))
                .domain(".youtube.com")
                .path("/")
                .build(),
        ];
        let expected = hex::encode(Sha1::digest(
            b"123 fixture-session https://music.youtube.com",
        ));
        assert_eq!(
            authorization(&cookies, 123).unwrap(),
            format!("SAPISIDHASH 123_{expected}")
        );
        assert!(authorization(&Vec::new(), 123).is_err());
    }
    #[test]
    fn search_deduplicates_stable_music_ids() {
        let item = json!({ "musicResponsiveListItemRenderer": {
            "navigationEndpoint": { "watchEndpoint": { "videoId": "abcdefghijk" } },
            "flexColumns": [{"musicResponsiveListItemFlexColumnRenderer":{"text":{"runs":[{"text":"Song"}]}}},
              {"musicResponsiveListItemFlexColumnRenderer":{"text":{"runs":[{"text":"Artist","navigationEndpoint":{"browseEndpoint":{"browseId":"UCartist"}}},{"text":"3:14"}]}}}]
        }});
        let mut found = Vec::new();
        songs(&json!([item.clone(), item]), &mut found, 0);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].artist, "Artist");
        assert_eq!(found[0].duration.as_deref(), Some("3:14"));
    }
}
