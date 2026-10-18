//! yt-dlp resolves media; the existing Symphonia decoder verifies real audio.
//! Cookie files are private, short lived, and never exposed through IPC or logs.
use super::*;
use serde_json::Value;
use std::{io::Write, process::Stdio};
use tokio::io::AsyncReadExt;

fn cookie_file(cookies: &session::Cookies) -> Result<tempfile::NamedTempFile, String> {
    let mut file = tempfile::Builder::new()
        .prefix("hibiki-youtube-")
        .suffix(".txt")
        .tempfile()
        .map_err(|_| "Could not prepare the YouTube Music session for playback.")?;
    writeln!(file, "# Netscape HTTP Cookie File")
        .map_err(|_| "Could not prepare playback credentials.")?;
    for cookie in cookies
        .iter()
        .filter(|cookie| session::youtube_cookie(cookie))
    {
        let domain = cookie.domain().unwrap_or_default();
        // cookie::Cookie normalizes away the leading dot. YouTube's parent
        // session cookies must still apply to music.youtube.com and www.youtube.com.
        let subdomains = domain == "youtube.com" && !cookie.name().starts_with("__Host-");
        let domain = if subdomains {
            format!(".{domain}")
        } else {
            domain.to_owned()
        };
        let prefix = if cookie.http_only().unwrap_or(false) {
            "#HttpOnly_"
        } else {
            ""
        };
        writeln!(
            file,
            "{prefix}{domain}\t{}\t{}\t{}\t{}\t{}\t{}",
            if subdomains { "TRUE" } else { "FALSE" },
            cookie.path().unwrap_or("/"),
            if cookie.secure().unwrap_or(false) {
                "TRUE"
            } else {
                "FALSE"
            },
            cookie
                .expires_datetime()
                .map(|date| date.unix_timestamp())
                .unwrap_or(0),
            cookie.name(),
            cookie.value()
        )
        .map_err(|_| "Could not prepare playback credentials.")?;
    }
    file.flush()
        .map_err(|_| "Could not prepare playback credentials.")?;
    Ok(file)
}

async fn read_limited(
    reader: impl tokio::io::AsyncRead + Unpin,
    limit: u64,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| "YouTube Music extractor output was interrupted.")?;
    if bytes.len() as u64 > limit {
        return Err("YouTube Music extractor returned too much data.".into());
    }
    Ok(bytes)
}

pub(crate) fn media_url(url: &url::Url) -> bool {
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url
            .host_str()
            .is_some_and(|host| host == "googlevideo.com" || host.ends_with(".googlevideo.com"))
}

pub(crate) struct ResolvedStream {
    pub gain_db: Option<f32>,
    format_id: Option<String>,
    pub video_id: String,
    pub title: String,
    pub url: url::Url,
    pub headers: reqwest::header::HeaderMap,
    pub extension: String,
    pub bitrate: Option<f64>,
}

pub(crate) fn media_client() -> Result<reqwest::Client, String> {
    static CLIENT: std::sync::LazyLock<Result<reqwest::Client, String>> =
        std::sync::LazyLock::new(|| {
            reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(15))
                .read_timeout(std::time::Duration::from_secs(30))
                .redirect(reqwest::redirect::Policy::custom(|attempt| {
                    if attempt.previous().len() < 4 && media_url(attempt.url()) {
                        attempt.follow()
                    } else {
                        attempt.stop()
                    }
                }))
                .build()
                .map_err(|_| "Native audio connection unavailable.".into())
        });
    CLIENT.clone()
}

fn parse_stream(bytes: &[u8], expected_id: &str) -> Result<ResolvedStream, String> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|_| "YouTube Music extractor returned an invalid response.")?;
    if value["id"].as_str() != Some(expected_id)
        || value["vcodec"]
            .as_str()
            .is_some_and(|codec| codec != "none")
    {
        return Err("YouTube Music returned a different track or a non-audio stream.".into());
    }
    let url = value["url"]
        .as_str()
        .and_then(|value| url::Url::parse(value).ok())
        .filter(media_url)
        .ok_or("YouTube Music did not return a supported direct audio stream.")?;
    let mut headers = reqwest::header::HeaderMap::new();
    if let Some(values) = value["http_headers"].as_object() {
        for (key, value) in values {
            if !matches!(
                key.to_ascii_lowercase().as_str(),
                "user-agent" | "referer" | "origin" | "accept" | "accept-language" | "cookie"
            ) {
                continue;
            }
            if let (Ok(key), Some(value)) = (
                reqwest::header::HeaderName::from_bytes(key.as_bytes()),
                value.as_str(),
            ) {
                let value = reqwest::header::HeaderValue::from_str(value)
                    .map_err(|_| "YouTube Music returned invalid media headers.")?;
                headers.insert(key, value);
            }
        }
    }
    Ok(ResolvedStream {
        gain_db: None,
        format_id: url
            .query_pairs()
            .find(|(key, _)| key == "itag")
            .map(|(_, value)| value.into_owned()),
        video_id: expected_id.to_owned(),
        title: value["track"]
            .as_str()
            .or_else(|| value["title"].as_str())
            .unwrap_or("YouTube Music song")
            .chars()
            .take(256)
            .collect(),
        url,
        headers,
        extension: value["ext"]
            .as_str()
            .filter(|ext| matches!(*ext, "m4a" | "webm" | "opus" | "ogg"))
            .unwrap_or("m4a")
            .to_owned(),
        bitrate: value["abr"]
            .as_f64()
            .filter(|value| value.is_finite() && *value > 0.0),
    })
}

pub(crate) async fn resolve(
    app: &tauri::AppHandle,
    video_id: &str,
) -> Result<(u64, ResolvedStream), String> {
    if !api::valid_video_id(video_id) {
        return Err("Choose a valid YouTube Music song.".into());
    }
    let state = app.state::<Arc<YoutubeMusic>>();
    let started = std::time::Instant::now();
    let generation = state.generation()?;
    let _guard = state.extraction.lock().await;
    if !state.owns(generation) {
        return Err("YouTube Music session changed.".into());
    }
    let cookies = session::cookies(app).await?;
    let verified = state.current.lock().is_ok_and(|current| {
        current.status.phase == Phase::Connected
            && current
                .status
                .last_checked_at
                .is_some_and(|checked| now() - checked < 600)
    });
    if !verified {
        api::verify(app, &cookies)
            .await
            .map_err(|failure| failure.report(app, generation))?;
    }
    let verification_ms = started.elapsed().as_millis() as u64;
    let path = tools::executable(app, "yt-dlp")
        .ok_or("Install playback tools from the YouTube Music panel to play this song.")?;
    let node = tools::executable(app, "node").ok_or(
        "Install playback tools from the YouTube Music panel. The Node runtime is missing.",
    )?;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|_| "Playback cache folder unavailable.")?
        .join("youtube-music-extractor");
    tokio::fs::create_dir_all(&cache)
        .await
        .map_err(|_| "Could not prepare the playback cache.")?;
    let file = cookie_file(&cookies)?;
    let request_interval = rate_limit::REQUESTS.interval_seconds();
    let mut command = tokio::process::Command::new(path);
    command
        .args([
            "--ignore-config",
            "--no-playlist",
            "--no-progress",
            "--no-warnings",
            "--no-update",
            "--skip-download",
            "--dump-single-json",
            "--socket-timeout",
            "15",
            "--retries",
            "0",
            "--extractor-retries",
            "0",
            "--sleep-requests",
            &request_interval,
            "--format",
            "bestaudio[ext=m4a][protocol=https]/bestaudio[protocol=https]",
            "--cookies",
        ])
        .arg(file.path())
        .arg("--cache-dir")
        .arg(cache)
        .arg("--no-js-runtimes")
        .arg("--js-runtimes")
        .arg(format!("node:{}", node.display()))
        .arg("--")
        .arg(format!("{ORIGIN}/watch?v={video_id}"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let permit = rate_limit::REQUESTS.admit(|| state.owns(generation)).await.map_err(str::to_owned)?;
    let mut child = command
        .spawn()
        .map_err(|_| "Could not start yt-dlp. Check that it is installed and executable.")?;
    drop(permit);
    let stdout = child.stdout.take().ok_or("Could not read yt-dlp output.")?;
    let stderr = child.stderr.take().ok_or("Could not read yt-dlp status.")?;
    let extraction = tokio::time::timeout(std::time::Duration::from_secs(75), async {
        tokio::try_join!(
            read_limited(stdout, 2 * 1024 * 1024),
            read_limited(stderr, 64 * 1024),
            async {
                child
                    .wait()
                    .await
                    .map_err(|_| "YouTube Music extractor failed.".to_owned())
            }
        )
    });
    // Run optional loudness metadata alongside extraction, with a short independent
    // timeout. Never delay playback for another full API timeout if it is unavailable.
    let metadata = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        api::player(app, &cookies, video_id),
    );
    let (extraction, metadata) = tokio::join!(extraction, metadata);
    let (output, error, status) =
        extraction.map_err(|_| "YouTube Music stream lookup timed out. Try again.")??;
    if !state.owns(generation) {
        return Err("YouTube Music session changed. Try the song again.".into());
    }
    if !status.success() {
        // Never surface stderr: it can include signed URLs, cookies or user paths.
        let error = String::from_utf8_lossy(&error);
        if error.contains("429") || error.to_ascii_lowercase().contains("too many requests") {
            rate_limit::REQUESTS.throttle(None);
            return Err(rate_limit::COOLDOWN.into());
        }
        if error.contains("cookies are no longer valid") {
            state.update(app, generation, |current| {
                current.status.phase = Phase::ReauthRequired;
                current.status.message = Some("Sign in to YouTube Music again.".into());
            });
            return Err("YouTube Music rejected this browser session. Sign in again.".into());
        }
        let message = extraction_error(&error);
        tracing::warn!(reason = message, "YouTube Music stream lookup failed");
        return Err(message.into());
    }
    let mut stream = parse_stream(&output, video_id)?;
    stream.gain_db = metadata
        .ok()
        .and_then(Result::ok)
        .and_then(|value| api::player_gain(&value, video_id, stream.format_id.as_deref()));
    tracing::info!(
        lookup_ms = started.elapsed().as_millis() as u64,
        verification_ms,
        provider_gain_db = ?stream.gain_db,
        "YouTube Music stream resolved"
    );
    Ok((generation, stream))
}

/// Static messages only: extractor stderr may contain credentials and signed URLs.
fn extraction_error(error: &str) -> &'static str {
    let error = error.to_ascii_lowercase();
    if error.contains("no such option") || error.contains("unrecognized arguments") {
        "yt-dlp rejected a playback option. Reinstall playback tools from the YouTube Music panel."
    } else if error.contains("requested format is not available") {
        "YouTube Music returned no supported direct audio format for this song."
    } else if error.contains("sign in to confirm") || error.contains("not a bot") {
        "YouTube requires a browser check. Open the YouTube Music sign-in window, then try again."
    } else if error.contains("po token") || error.contains("potoken") {
        "YouTube requires an additional playback token for this song."
    } else if error.contains("javascript")
        || error.contains("challenge")
        || error.contains("ejs")
        || error.contains("node")
    {
        "yt-dlp could not run YouTube's JavaScript challenge. The helper runtime needs checking."
    } else if error.contains("403") {
        "YouTube rejected the audio lookup (403). Refresh the session and try again."
    } else if error.contains("429") {
        "YouTube is rate limiting playback. Wait a little before trying again."
    } else if error.contains("timed out")
        || error.contains("unable to download")
        || error.contains("urlopen")
    {
        "yt-dlp could not reach YouTube. Check your connection and try again."
    } else if error.contains("not available")
        || error.contains("unavailable")
        || error.contains("private video")
    {
        "This song is unavailable to the connected YouTube Music account."
    } else {
        "yt-dlp could not resolve this song. Install playback tools from the YouTube Music panel, or try another song."
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamTest {
    video_id: String,
    title: String,
    sample_rate: u32,
    channels: u16,
    decoded_ms: u64,
    checked_bytes: usize,
    bitrate: Option<f64>,
    checked_at: i64,
}

pub(crate) async fn test_stream(
    app: &tauri::AppHandle,
    video_id: &str,
) -> Result<StreamTest, String> {
    let (generation, stream) = resolve(app, video_id).await?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() < 4 && media_url(attempt.url()) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|_| "Native audio connection unavailable.")?;
    // A bounded read proves actual playable media without downloading the song.
    let mut response = client
        .get(stream.url)
        .headers(stream.headers)
        .header("Range", "bytes=0-2097151")
        .send()
        .await
        .map_err(|_| "Could not open the YouTube Music audio stream.")?;
    if !response.status().is_success() {
        return Err(
            "YouTube Music rejected the audio stream. Refresh the connection and try again.".into(),
        );
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "YouTube Music audio transfer was interrupted.")?
    {
        let remaining = (2 * 1024 * 1024usize).saturating_sub(bytes.len());
        bytes.extend_from_slice(&chunk[..remaining.min(chunk.len())]);
        if bytes.len() == 2 * 1024 * 1024 {
            break;
        }
    }
    let checked_bytes = bytes.len();
    let extension = stream.extension;
    let (sample_rate, channels, decoded_ms) = tauri::async_runtime::spawn_blocking(move || {
        use crate::audio_engine::deck::decode;
        let source = symphonia::core::io::MediaSourceStream::new(
            Box::new(std::io::Cursor::new(bytes)),
            Default::default(),
        );
        let mut setup = decode::probe_from_source(source, Some(&extension))
            .map_err(|_| "Symphonia could not open this audio format.")?;
        let target = setup.sample_rate as usize * setup.channels as usize;
        let pcm = decode::decode_batch(&mut setup, target)
            .map_err(|_| "Symphonia could not decode this audio stream.")?;
        if pcm.is_empty() || pcm.iter().any(|sample| !sample.is_finite()) {
            return Err("The audio stream did not decode into valid samples.");
        }
        let milliseconds =
            pcm.len() as u64 * 1000 / (setup.sample_rate as u64 * setup.channels as u64);
        Ok((setup.sample_rate, setup.channels, milliseconds))
    })
    .await
    .map_err(|_| "Native audio check was interrupted.")??;
    if !app.state::<Arc<YoutubeMusic>>().owns(generation) {
        return Err("YouTube Music session changed. Try again.".into());
    }
    Ok(StreamTest {
        video_id: stream.video_id,
        title: stream.title,
        sample_rate,
        channels,
        decoded_ms,
        checked_bytes,
        bitrate: stream.bitrate,
        checked_at: now(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn extractor_diagnostics_never_return_raw_urls_or_credentials() {
        for error in [
            "ERROR: requested format is not available https://private.test?cookie=secret",
            "ERROR: HTTP Error 403 https://private.test?signature=secret",
            "ERROR: JavaScript challenge failed /Users/private/account",
            "unexpected error: SID=private-cookie-value",
        ] {
            let message = extraction_error(error);
            assert!(!message.contains("private"));
            assert!(!message.contains("https://"));
            assert!(!message.contains("secret"));
        }
    }
    #[test]
    fn extractor_credentials_are_private_and_scoped() {
        let cookie = |domain: &str| {
            tauri::webview::Cookie::build(("SID", "fixture-secret"))
                .domain(domain.to_owned())
                .path("/")
                .secure(true)
                .http_only(true)
                .build()
        };
        let file =
            cookie_file(&vec![cookie(".youtube.com"), cookie("accounts.google.com")]).unwrap();
        let contents = std::fs::read_to_string(file.path()).unwrap();
        assert!(contents.contains("#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tfixture-secret"));
        assert!(!contents.contains("google.com"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(file.path()).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let path = file.path().to_owned();
        drop(file);
        assert!(!path.exists());
    }
    #[test]
    fn extractor_cannot_redirect_credentials_or_substitute_another_track() {
        let response = |id: &str, url: &str| {
            serde_json::to_vec(&serde_json::json!({"id":id,"url":url,"vcodec":"none","ext":"m4a"}))
                .unwrap()
        };
        assert!(parse_stream(
            &response(
                "abcdefghijk",
                "https://rr1.googlevideo.com/videoplayback?signature=fixture"
            ),
            "abcdefghijk"
        )
        .is_ok());
        for url in [
            "http://rr1.googlevideo.com/a",
            "https://googlevideo.com.attacker.test/a",
            "https://127.0.0.1/a",
            "https://rr1.googlevideo.com:444/a",
        ] {
            assert!(parse_stream(&response("abcdefghijk", url), "abcdefghijk").is_err());
        }
        assert!(parse_stream(
            &response("differentid", "https://rr1.googlevideo.com/a"),
            "abcdefghijk"
        )
        .is_err());
    }
}
