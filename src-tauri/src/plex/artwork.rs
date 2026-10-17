//! Only image routes may receive Plex credentials through the image protocol.

use url::Url;

pub fn public_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && !url
            .query_pairs()
            .any(|(key, _)| key.eq_ignore_ascii_case("X-Plex-Token"))
}

fn image_path(path: &str) -> bool {
    // Reject alternate path separators/encodings rather than interpreting them
    // differently from the server or a reverse proxy.
    if path.contains('%') || path.contains('\\') {
        return false;
    }
    let Some(path) = path.strip_prefix('/') else {
        return false;
    };
    let parts: Vec<_> = path.split('/').collect();
    let id = |value: &str| {
        value
            .split(',')
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
    };
    let timestamp = |value: &str| !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit());
    let element = |value: &str| {
        matches!(
            value,
            "thumb" | "art" | "clearLogo" | "squareArt" | "banner" | "poster"
        )
    };
    match parts.as_slice() {
        ["library", "metadata", key, kind] => id(key) && element(kind),
        ["library", "metadata", key, kind, time] => id(key) && element(kind) && timestamp(time),
        ["playlists", key, kind] => id(key) && matches!(*kind, "thumb" | "art" | "composite"),
        ["playlists", key, kind, time] => {
            id(key) && matches!(*kind, "thumb" | "art" | "composite") && timestamp(time)
        }
        ["library", "sections", key, "composite"] => id(key),
        ["library", "sections", key, "composite", time] => id(key) && timestamp(time),
        [":", "resources", names @ ..] if !names.is_empty() => {
            names.iter().all(|name| {
                !name.is_empty()
                    && *name != "."
                    && *name != ".."
                    && name
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
            }) && names.last().is_some_and(|name| raster_name(name))
        }
        _ => false,
    }
}

fn raster_name(name: &str) -> bool {
    name.rsplit_once('.').is_some_and(|(_, ext)| {
        matches!(
            ext.to_ascii_lowercase().as_str(),
            "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp" | "ico" | "avif"
        )
    })
}

fn server_path<'a>(base: &Url, target: &'a Url) -> Option<&'a str> {
    if base.origin() != target.origin()
        || !target.username().is_empty()
        || target.password().is_some()
    {
        return None;
    }
    let prefix = base.path().trim_end_matches('/');
    let path = target.path().strip_prefix(prefix)?;
    path.starts_with('/').then_some(path)
}

/// PlexAPI-style transcodes include a token in the nested source. Replace it
/// only for a verified image on this server; external sources stay anonymous.
pub fn normalize_source(base: &Url, target: &mut Url, token: &str) -> Option<()> {
    if server_path(base, target)? != "/photo/:/transcode" {
        return Some(());
    }
    let sources: Vec<_> = target
        .query_pairs()
        .filter(|(key, _)| key == "url")
        .collect();
    if sources.len() != 1 {
        return None;
    }
    let value = sources[0].1.as_ref();
    let relative = value.starts_with('/') && !value.starts_with("//");
    let source = if relative {
        Url::parse(&format!("http://artwork.invalid{value}")).ok()?
    } else {
        Url::parse(value).ok()?
    };
    if !source
        .query_pairs()
        .any(|(key, _)| key.eq_ignore_ascii_case("X-Plex-Token"))
    {
        return Some(());
    }
    let trusted = source.username().is_empty()
        && source.password().is_none()
        && if relative {
            image_path(source.path())
        } else {
            server_path(base, &source).is_some_and(image_path)
        };
    if !trusted {
        return None;
    }
    let mut source = Url::parse(&super::client::without_plex_token(source.as_str())).ok()?;
    source.query_pairs_mut().append_pair("X-Plex-Token", token);
    let value = if relative {
        format!("{}?{}", source.path(), source.query().unwrap_or_default())
    } else {
        source.into()
    };
    let replacement = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("url", &value)
        .finish();
    let query = target
        .query()?
        .split('&')
        .map(|pair| {
            if url::form_urlencoded::parse(pair.as_bytes())
                .next()
                .is_some_and(|(key, _)| key == "url")
            {
                replacement.as_str()
            } else {
                pair
            }
        })
        .collect::<Vec<_>>()
        .join("&");
    target.set_query(Some(&query));
    Some(())
}

pub fn allowed(base: &Url, target: &Url) -> bool {
    let Some(path) = server_path(base, target) else {
        return false;
    };
    if image_path(path) {
        return true;
    }
    if path != "/photo/:/transcode" {
        return false;
    }
    let sources: Vec<_> = target
        .query_pairs()
        .filter(|(key, _)| key == "url")
        .collect();
    if sources.len() != 1 {
        return false;
    }
    let source = sources[0].1.as_ref();
    // PMS evaluates root-relative sources on its own server, independent of
    // the reverse proxy prefix used for the outer request.
    if source.starts_with('/') && !source.starts_with("//") {
        let Ok(source) = Url::parse(&format!("http://artwork.invalid{source}")) else {
            return false;
        };
        return source.username().is_empty()
            && source.password().is_none()
            && image_path(source.path());
    }
    let Ok(source) = Url::parse(source) else {
        return false;
    };
    if base.origin() == source.origin() {
        server_path(base, &source).is_some_and(image_path)
    } else {
        // A server alias must not bypass route validation, and another
        // transcode must not hide a privileged target. Public CDN files
        // and ordinary Plex image paths are valid source images.
        public_url(&source)
            && (image_path(source.path())
                || source.path().rsplit('/').next().is_some_and(raster_name))
    }
}

pub fn redirect_policy(base: Url) -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= 10 {
            return attempt.error("too many artwork redirects");
        }
        if public_url(attempt.url()) && allowed(&base, attempt.url()) {
            attempt.follow()
        } else {
            attempt.error("refusing redirect outside Plex artwork routes")
        }
    })
}

/// Ask PMS for display-sized pixels instead of downloading an unbounded original.
/// Keep existing transcodes (including their crop) and preserve clear-logo alpha.
pub fn bounded_source(base: &Url, target: &Url) -> Option<Url> {
    if !public_url(target) || !allowed(base, target) { return None; }
    let path = server_path(base, target)?;
    if !image_path(path) { return Some(target.clone()); }
    let source = match target.query() {
        Some(query) => format!("{path}?{query}"),
        None => path.to_owned(),
    };
    let format = if path.split('/').any(|part| part == "clearLogo") { "png" } else { "jpeg" };
    let mut resized = base.clone();
    resized.set_path(&format!("{}/photo/:/transcode", base.path().trim_end_matches('/')));
    resized.set_query(None);
    resized.query_pairs_mut()
        .append_pair("url", &source)
        .append_pair("width", "2048")
        .append_pair("height", "2048")
        .append_pair("minSize", "0")
        .append_pair("upscale", "0")
        .append_pair("format", format);
    Some(resized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn original_artwork_is_bounded_without_changing_crops_or_logos() {
        let base = Url::parse("https://plex.test/plex").unwrap();
        let raw = Url::parse("https://plex.test/plex/library/metadata/42/thumb/123?signature=a%20b%2Bc").unwrap();
        let resized = bounded_source(&base, &raw).unwrap();
        let query: std::collections::HashMap<_, _> = resized.query_pairs().collect();
        assert_eq!(resized.path(), "/plex/photo/:/transcode");
        assert_eq!(query["url"], "/library/metadata/42/thumb/123?signature=a%20b%2Bc");
        assert_eq!(query["width"], "2048");
        assert_eq!(query["height"], "2048");
        assert_eq!(query["upscale"], "0");
        assert_eq!(query["format"], "jpeg");
        assert!(allowed(&base, &resized));
        let logo = Url::parse("https://plex.test/plex/library/metadata/42/clearLogo/123").unwrap();
        assert!(bounded_source(&base, &logo).unwrap().query_pairs().any(|(k, v)| k == "format" && v == "png"));
        let crop = Url::parse("https://plex.test/plex/photo/:/transcode?url=%2Flibrary%2Fmetadata%2F42%2Fthumb&width=600&crop=1").unwrap();
        assert_eq!(bounded_source(&base, &crop).unwrap(), crop);
        assert!(bounded_source(&base, &Url::parse("https://plex.test/plex/:/scrobble?key=42").unwrap()).is_none());
        assert!(bounded_source(&base, &Url::parse("https://other.test/library/metadata/42/thumb").unwrap()).is_none());
    }

    #[test]
    fn artwork_paths_cover_metadata_composites_resources_and_mounted_servers() {
        let base = Url::parse("https://plex.test/plex").unwrap();
        for path in [
            "/library/metadata/42/thumb",
            "/library/metadata/42/art/123",
            "/library/metadata/42/squareArt/123",
            "/library/metadata/42/clearLogo",
            "/playlists/5/composite/123",
            "/playlists/5/thumb",
            "/library/sections/1/composite/123",
            "/:/resources/artist-fanart.jpg",
            "/photo/:/transcode?url=%2Flibrary%2Fmetadata%2F42%2Fthumb&width=600",
            "/photo/:/transcode?url=https%3A%2F%2Fcdn.test%2Fcover.jpg",
            "/photo/:/transcode?url=http%3A%2F%2F127.0.0.1%3A32400%2Flibrary%2Fmetadata%2F42%2Fthumb",
        ] {
            assert!(
                allowed(
                    &base,
                    &Url::parse(&format!("https://plex.test/plex{path}")).unwrap()
                ),
                "{path}"
            );
        }
        for path in [
            "/library/metadata/42/theme",
            "/library/metadata/42/thumb/../refresh",
            "/library/metadata/42/thumb%2F..%2Frefresh",
            "/:/resources/../scrobble",
            "/photo/:/transcode?url=%2F%3A%2Fscrobble",
            "/photo/:/transcode?url=%2F%2Fplex.test%2F%3A%2Fscrobble",
            "/photo/:/transcode?url=https%3A%2F%2Fforeign.test%2Fcover.jpg%3FX-Plex-Token%3Dsecret",
            "/photo/:/transcode?url=%2Flibrary%2Fmetadata%2F42%2Fthumb&url=%2F%3A%2Fscrobble",
            "/photo/:/transcode?url=http%3A%2F%2F127.0.0.1%3A32400%2F%3A%2Fscrobble",
        ] {
            assert!(
                !allowed(
                    &base,
                    &Url::parse(&format!("https://plex.test/plex{path}")).unwrap()
                ),
                "{path}"
            );
        }
        assert!(!allowed(
            &base,
            &Url::parse("https://plex.test/library/metadata/42/thumb").unwrap()
        ));
        assert!(!allowed(
            &base,
            &Url::parse("https://foreign.test/plex/library/metadata/42/thumb").unwrap()
        ));
    }
}
