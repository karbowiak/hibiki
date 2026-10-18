use super::*;
use tauri::webview::{PageLoadEvent, WebviewWindowBuilder};
use tauri::{WebviewUrl, WindowEvent};

pub(crate) type Cookies = Vec<tauri::webview::Cookie<'static>>;

// The bare WKWebView user agent gets YTM's "not optimised" page instead of
// the app. On macOS use a Safari identity matching the WebKit engine: a Firefox
// identity serves YTM but Google rejected real-account sign-in in our trial.
// Keep this confined to the isolated window (and its native API requests).
// Safari approach: https://github.com/sozercan/kaset/blob/main/Sources/Kaset/Services/WebKit/WebKitManager.swift
#[cfg(target_os = "macos")]
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
#[cfg(target_os = "windows")]
const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0";
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";

fn google_session_handoff(url: &url::Url) -> bool {
    // Google can transfer the completed sign-in through a regional Google
    // domain before returning to YouTube. Limit these hosts to session handoffs.
    // Exact domain snapshot: https://www.google.com/supported_domains
    if !matches!(
        url.path(),
        "/accounts/SetSID" | "/accounts/CheckCookie" | "/CheckCookie"
    ) {
        return false;
    }
    let host = url.host_str().unwrap_or_default();
    let domain = host
        .strip_prefix("accounts.")
        .or_else(|| host.strip_prefix("www."))
        .unwrap_or(host);
    include_str!("google_domains.txt")
        .split_whitespace()
        .any(|known| domain == known.trim_start_matches('.'))
}

pub(crate) fn allowed_navigation(url: &url::Url) -> bool {
    url.as_str() == "about:blank"
        || (url.scheme() == "https"
            && url.port().is_none()
            && url.username().is_empty()
            && url.password().is_none()
            && (google_session_handoff(url)
                || matches!(
                    url.host_str(),
                    Some(
                        "music.youtube.com"
                            | "www.youtube.com"
                            | "youtube.com"
                            | "accounts.google.com"
                            | "gds.google.com"
                            | "accounts.youtube.com"
                            | "consent.youtube.com"
                            | "consent.google.com"
                            | "myaccount.google.com"
                    )
                )))
}

pub(crate) async fn window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(WINDOW) {
        return Ok(window);
    }
    let handle = app.clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result = (|| {
            if let Some(window) = handle.get_webview_window(WINDOW) {
                return Ok(window);
            }
            let directory = handle
                .path()
                .app_data_dir()
                .map_err(|_| "YouTube Music profile unavailable")?
                .join("youtube-music-browser");
            std::fs::create_dir_all(&directory)
                .map_err(|_| "Could not create YouTube Music profile")?;
            let navigation_app = handle.clone();
            let mut builder = WebviewWindowBuilder::new(
                &handle,
                WINDOW,
                WebviewUrl::External(url::Url::parse(ORIGIN).unwrap()),
            )
            .title("YouTube Music · Sign in")
            .inner_size(1000.0, 760.0)
            .min_inner_size(600.0, 480.0)
            .visible(false)
            .data_directory(directory)
            .user_agent(USER_AGENT)
            .on_navigation(move |url| {
                let allowed = allowed_navigation(url);
                if !allowed {
                    // Never log the full URL: Google query strings contain
                    // session-transfer tokens, email addresses and flow state.
                    tracing::warn!(
                        host = url.host_str().unwrap_or_default(),
                        "YouTube Music blocked a navigation destination"
                    );
                    let state = navigation_app.state::<Arc<YoutubeMusic>>();
                    if let Ok(generation) = state.generation() {
                        state.failure(
                            &navigation_app,
                            generation,
                            false,
                            "The sign-in window blocked a redirect. Check Hibiki's log for the destination hostname.",
                        );
                    }
                }
                allowed
            })
            .on_page_load(|window, payload| {
                if payload.event() != PageLoadEvent::Finished
                    || payload.url().host_str() != Some("music.youtube.com")
                {
                    return;
                }
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    let state = app.state::<Arc<YoutubeMusic>>();
                    if let Ok(generation) = state.generation() {
                        let _ = check(&app, generation).await;
                    }
                });
            });
            // WKWebView has a persistent store identifier rather than a directory.
            #[cfg(target_os = "macos")]
            {
                builder = builder.data_store_identifier(*b"hibiki-ytmusicv1");
            }
            let window = builder
                .build()
                .map_err(|_| "Could not create YouTube Music sign-in window")?;
            let app = handle.clone();
            let hidden = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = hidden.hide();
                    if let Ok(mut current) = app.state::<Arc<YoutubeMusic>>().current.lock() {
                        current.interactive = false;
                        current.status.next_refresh_at = Some(now());
                    }
                }
            });
            Ok(window)
        })();
        let _ = send.send(result);
    })
    .map_err(|_| "Could not schedule YouTube Music window")?;
    receive
        .await
        .map_err(|_| "YouTube Music window was interrupted")?
}

pub(crate) async fn cookies(app: &tauri::AppHandle) -> Result<Cookies, String> {
    let window = app
        .get_webview_window(WINDOW)
        .ok_or("Open YouTube Music to sign in first.")?;
    // Never read WebView2 cookies in a synchronous event handler: it can deadlock.
    tauri::async_runtime::spawn_blocking(move || window.cookies())
        .await
        .map_err(|_| "Could not read YouTube Music session")?
        .map_err(|_| "Could not read YouTube Music session".to_owned())
        .map(|cookies| cookies.into_iter().filter(youtube_cookie).collect())
}

pub(crate) fn youtube_cookie(cookie: &tauri::webview::Cookie<'_>) -> bool {
    let domain = cookie.domain().unwrap_or_default().trim_start_matches('.');
    (domain == "youtube.com" || domain == "music.youtube.com" || domain == "www.youtube.com")
        && !cookie.name().is_empty()
        && !cookie.name().contains(['\t', '\r', '\n', ';'])
        && !cookie.value().contains(['\t', '\r', '\n'])
        && cookie
            .expires_datetime()
            .is_none_or(|expiry| expiry.unix_timestamp() > now())
}

pub(crate) fn cookie_header(cookies: &Cookies) -> String {
    // Prefer the longest matching domain/path; include only root-path API cookies.
    let mut selected = std::collections::BTreeMap::new();
    for cookie in cookies {
        let domain = cookie.domain().unwrap_or_default().trim_start_matches('.');
        if !matches!(domain, "youtube.com" | "music.youtube.com")
            || cookie.path().unwrap_or("/") != "/"
        {
            continue;
        }
        selected.entry(cookie.name()).or_insert(cookie.value());
        if domain == "music.youtube.com" {
            selected.insert(cookie.name(), cookie.value());
        }
    }
    selected
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("; ")
}

pub(crate) fn has_login(cookies: &Cookies) -> bool {
    cookies.iter().any(|cookie| {
        matches!(cookie.name(), "SAPISID" | "__Secure-3PAPISID") && !cookie.value().is_empty()
    })
}

pub(crate) fn next_refresh(cookies: &Cookies, time: i64) -> i64 {
    let expiry = cookies
        .iter()
        .filter(|cookie| {
            matches!(
                cookie.name(),
                "SAPISID" | "__Secure-3PAPISID" | "__Secure-3PSID"
            )
        })
        .filter_map(|cookie| {
            cookie
                .expires_datetime()
                .map(|value| value.unix_timestamp())
        })
        .min()
        .unwrap_or(time + HOUR + 300);
    time + (expiry - time - 300).clamp(300, HOUR)
}

pub(crate) async fn check(app: &tauri::AppHandle, generation: u64) -> Result<(), String> {
    let state = app.state::<Arc<YoutubeMusic>>();
    let Ok(_guard) = state.refresh.try_lock() else {
        return Ok(());
    };
    if !state.owns(generation) {
        return Err("YouTube Music session changed.".into());
    }
    let cookies = cookies(app).await.map_err(|message| {
        state.failure(app, generation, false, &message);
        message
    })?;
    if !has_login(&cookies) {
        state.update(app, generation, |current| {
            if !current.interactive {
                current.status.phase = Phase::ReauthRequired;
                current.status.message = Some("Sign in to YouTube Music again.".into());
            }
            current.status.next_refresh_at = Some(now() + HOUR);
        });
        return Ok(());
    }
    match api::verify(app, &cookies).await {
        Ok(context) => {
            if !state.owns(generation) {
                return Err("YouTube Music session changed.".into());
            }
            let identity = context.identity();
            let marker = app.path().app_config_dir().ok().map(|directory| directory.join("youtube-music-cache-account"));
            let saved_identity = marker.as_ref().and_then(|path| std::fs::read_to_string(path).ok());
            let switched = state.current.lock().is_ok_and(|current|
                current.status.account_id.is_some() && current.status.account_id != identity) ||
                saved_identity.as_ref().is_some_and(|old| Some(old.as_str()) != identity.as_deref());
            let verified_generation = if switched {
                let mut current = state.current.lock().map_err(|_| "YouTube Music session unavailable.")?;
                if current.generation != generation { return Err("YouTube Music session changed.".into()); }
                current.generation += 1;
                current.generation
            } else { generation };
            if switched {
                playback::forget_cache_owner(app);
                if let Ok(directory) = app.path().app_cache_dir() {
                    state.discovery_cache.clear(directory.join("ytmusic-discovery")).await;
                }
            }
            if let (Some(path), Some(identity)) = (marker, identity.as_ref()) {
                std::fs::create_dir_all(path.parent().unwrap()).map_err(|_| "Could not retain the YouTube Music account identity.")?;
                std::fs::write(path, identity).map_err(|_| "Could not retain the YouTube Music account identity.")?;
            }
            state.update(app, verified_generation, |current| {
                current.status.account_id = identity;
                current.status.phase = Phase::Connected;
                current.status.message = None;
                current.status.last_checked_at = Some(now());
                current.status.next_refresh_at = Some(next_refresh(&cookies, now()));
                current.interactive = false;
            });
            if let Some(window) = app.get_webview_window(WINDOW) {
                let _ = window.hide();
            }
            Ok(())
        }
        Err(error) => {
            state.failure(app, generation, error.auth, error.message);
            Err(error.message.into())
        }
    }
}

pub(crate) async fn renew(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<Arc<YoutubeMusic>>();
    let Ok(_renewal) = state.renewal.try_lock() else {
        return Ok(());
    };
    // Do not rotate the website session halfway through an extractor lookup.
    let _extraction = state.extraction.lock().await;
    let generation = state.generation()?;
    if state
        .current
        .lock()
        .is_ok_and(|current| current.interactive)
    {
        return Ok(());
    }
    let permit = rate_limit::REQUESTS.admit(|| state.owns(generation)).await.map_err(str::to_owned)?;
    let existing = app.get_webview_window(WINDOW).is_some();
    state.update(app, generation, |current| {
        current.status.phase = Phase::Refreshing;
        // Suppress overlapping startup/timer/page-load attempts.
        current.status.next_refresh_at = Some(now() + 300);
    });
    let window = window(app).await.map_err(|message| {
        state.failure(app, generation, false, &message);
        message
    })?;
    // Website JS performs Google's normal cookie rotation; native requests always
    // snapshot this same live store. Never reload an active user sign-in.
    // A newly created window already loads ORIGIN. Avoid a second startup load.
    if existing && state.owns(generation) {
        window
            .navigate(url::Url::parse(ORIGIN).unwrap())
            .map_err(|_| {
                let message = "Could not refresh YouTube Music";
                state.failure(app, generation, false, message);
                message
            })?;
    }
    drop(permit);
    tokio::time::sleep(std::time::Duration::from_secs(8)).await;
    check(app, generation).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn navigation_keeps_the_session_on_google_and_youtube() {
        for address in [
            "https://music.youtube.com/",
            "https://accounts.google.com/v3/signin",
            // Google's account suggestions can follow successful two-step verification.
            "https://gds.google.com/web/recoveryoptions",
            "https://gds.google.com/web/homeaddress",
            "https://accounts.youtube.com/accounts/SetSID",
            "https://consent.youtube.com/",
        ] {
            assert!(allowed_navigation(&url::Url::parse(address).unwrap()));
        }
        for address in [
            "http://music.youtube.com/",
            "https://music.youtube.com.attacker.test/",
            "https://accounts.google.com@attacker.test/",
            "https://accounts.google.com:444/",
            "https://gds.google.com.attacker.test/web/recoveryoptions",
            "http://gds.google.com/web/recoveryoptions",
            "https://evil.test/",
        ] {
            assert!(!allowed_navigation(&url::Url::parse(address).unwrap()));
        }
    }
    #[test]
    fn regional_google_session_handoffs_complete_without_widening_general_navigation() {
        for address in [
            "https://accounts.google.dk/accounts/SetSID?private=not-logged",
            "https://www.google.dk/accounts/SetSID",
            "https://google.com/accounts/SetSID",
            "https://accounts.google.co.uk/accounts/CheckCookie",
            "https://accounts.google.co.kr/CheckCookie",
        ] {
            assert!(allowed_navigation(&url::Url::parse(address).unwrap()));
        }
        for address in [
            "https://www.google.dk/search",
            "https://accounts.google.not-a-google-domain/accounts/SetSID",
            "https://accounts.google.dk.evil.test/accounts/SetSID",
            "https://evil.google.dk/accounts/SetSID",
            "https://accounts.google.dk:444/accounts/SetSID",
            "https://attacker@accounts.google.dk/accounts/SetSID",
            "http://accounts.google.dk/accounts/SetSID",
        ] {
            assert!(!allowed_navigation(&url::Url::parse(address).unwrap()));
        }
    }
    #[test]
    fn only_youtube_root_cookies_enter_native_api_requests() {
        let cookie = |domain: &str, name: &str, value: &str| {
            tauri::webview::Cookie::build((name.to_owned(), value.to_owned()))
                .domain(domain.to_owned())
                .path("/")
                .build()
        };
        let cookies = vec![
            cookie(".youtube.com", "SAPISID", "parent"),
            cookie("music.youtube.com", "SAPISID", "music"),
            cookie("accounts.google.com", "SID", "private"),
            cookie("youtube.com.evil.test", "SID", "wrong"),
        ];
        let filtered = cookies.into_iter().filter(youtube_cookie).collect();
        assert_eq!(cookie_header(&filtered), "SAPISID=music");
        assert!(has_login(&filtered));
        assert_eq!(next_refresh(&filtered, 1000), 4600);
    }
}
