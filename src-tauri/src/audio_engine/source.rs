//! Immutable HTTP and cache identity, constructed at trusted native ingress.

use sha2::{Digest, Sha256};

pub(crate) struct MediaSource {
    pub(crate) request: Option<reqwest::RequestBuilder>,
    pub(crate) plex_fetch_lock: Option<std::sync::Arc<tokio::sync::Mutex<()>>>,
    pub(crate) cache_key: String,
    pub(crate) plex_scope: Option<String>,
    pub(crate) extension: String,
    pub(crate) local_cache: Option<std::sync::Arc<super::cache::AudioCache>>,
}

impl MediaSource {
    pub(crate) fn new(
        builder: reqwest::RequestBuilder,
        plex_scope: Option<&str>,
    ) -> Result<Self, String> {
        let (client, request) = builder.build_split();
        let mut request = request.map_err(|_| "Invalid audio request".to_string())?;
        if request.method() != reqwest::Method::GET || request.body().is_some() {
            return Err("Audio source must be a bodyless GET".into());
        }
        // Fragments never travel to the server and must not address other cache entries.
        request.url_mut().set_fragment(None);
        let mut hash = Sha256::new();
        let mut field = |bytes: &[u8]| {
            hash.update((bytes.len() as u64).to_be_bytes());
            hash.update(bytes);
        };
        field(b"hibiki-media-source-v1");
        field(if plex_scope.is_some() {
            b"plex"
        } else {
            b"public"
        });
        field(plex_scope.unwrap_or_default().as_bytes());
        field(request.url().as_str().as_bytes());
        // Use actual native request credentials, after stripping caller query tokens.
        // Length framing also keeps multiple header values unambiguous.
        for name in ["x-plex-token", "authorization", "cookie"] {
            field(name.as_bytes());
            let values = request.headers().get_all(name);
            field(&(values.iter().count() as u64).to_be_bytes());
            for value in values.iter() {
                field(value.as_bytes());
            }
        }
        let cache_key = format!("s1-{}", hex::encode(hash.finalize()));
        let extension = super::cache::extract_extension(request.url().path());
        Ok(Self {
            request: Some(reqwest::RequestBuilder::from_parts(client, request)),
            plex_fetch_lock: None,
            cache_key,
            plex_scope: plex_scope.map(str::to_owned),
            extension,
            local_cache: None,
        })
    }

    pub(crate) fn with_plex_fetch_lock(mut self, lock: std::sync::Arc<tokio::sync::Mutex<()>>) -> Self {
        self.plex_fetch_lock = Some(lock);
        self
    }

    /// Native-only admission from a verified scoped binding. No network fallback.
    pub(crate) fn cached(key: String, extension: String, scope: String,
        cache: std::sync::Arc<super::cache::AudioCache>) -> Self {
        Self { request: None, plex_fetch_lock: None, cache_key: key, plex_scope: Some(scope), extension, local_cache: Some(cache) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_engine::cache::AudioCache;

    fn source(url: &str, scope: Option<&str>, token: Option<&str>) -> MediaSource {
        let mut builder = crate::plex::client::public_media_request(url);
        if let Some(token) = token {
            builder = builder.header("X-Plex-Token", token);
        }
        MediaSource::new(builder, scope).unwrap()
    }

    #[test]
    fn cache_files_and_gain_are_isolated_by_native_credentials_and_library() {
        let dir = tempfile::tempdir().unwrap();
        let cache = AudioCache::new(dir.path().into(), None);
        let url = "https://test.invalid/file.flac?X-Plex-Token=caller-old";
        let old = source(url, Some("server/library-one"), Some("native-old"));
        let mut writer = cache.begin_write(&old.cache_key, &old.extension).unwrap();
        writer.write_chunk(b"private audio").unwrap();
        writer.finish(&cache).unwrap();
        cache.set_computed_gain(&old.cache_key, -7.0);
        assert!(cache.lookup(&old.cache_key).is_some());
        for replacement in [
            source(url, Some("server/library-one"), Some("native-new")),
            source(url, Some("server/library-two"), Some("native-old")),
            source(
                url,
                Some("replacement-server/library-one"),
                Some("native-old"),
            ),
            source(url, None, None),
            source(
                "https://test.invalid/file.flac#X-Plex-Token=caller-old",
                None,
                None,
            ),
        ] {
            assert!(cache.lookup(&replacement.cache_key).is_none());
            assert_eq!(cache.get_computed_gain(&replacement.cache_key), None);
        }
        let reconnect = source(
            "https://test.invalid/file.flac?X-Plex-Token=ignored-new#other",
            Some("server/library-one"),
            Some("native-old"),
        );
        assert_eq!(old.cache_key, reconnect.cache_key);
        assert!(cache.lookup(&reconnect.cache_key).is_some());
        assert_eq!(cache.get_computed_gain(&reconnect.cache_key), Some(-7.0));
    }

    #[test]
    fn public_identity_matches_the_sanitized_request_and_preserves_signed_queries() {
        let plain = source(
            "https://test.invalid/file.flac?signature=a%2Fb+z",
            None,
            None,
        );
        let forged = source(
            "https://test.invalid/file.flac?X-Plex-Token=ignored&signature=a%2Fb+z#file.mp3",
            None,
            None,
        );
        assert_eq!(plain.cache_key, forged.cache_key);
        assert_eq!(forged.extension, "flac");
        let request = forged.request.as_ref().unwrap().try_clone().unwrap().build().unwrap();
        assert_eq!(request.url().query(), Some("signature=a%2Fb+z"));
        assert_eq!(request.url().fragment(), None);
        assert!(!request.headers().contains_key("X-Plex-Token"));
        assert_ne!(
            plain.cache_key,
            source("https://test.invalid/file.flac?signature=other", None, None).cache_key
        );
    }

    #[test]
    fn basic_auth_and_cookie_credentials_separate_public_sources() {
        let url = "https://test.invalid/episode.mp3";
        let anonymous = source(url, None, None);
        let a = MediaSource::new(
            reqwest::Client::new()
                .get(url)
                .basic_auth("user-a", Some("password")),
            None,
        )
        .unwrap();
        let b = MediaSource::new(
            reqwest::Client::new()
                .get(url)
                .basic_auth("user-b", Some("password")),
            None,
        )
        .unwrap();
        let cookie = MediaSource::new(
            reqwest::Client::new()
                .get(url)
                .header("Cookie", "session=dummy"),
            None,
        )
        .unwrap();
        assert_ne!(a.cache_key, b.cache_key);
        assert_ne!(anonymous.cache_key, a.cache_key);
        assert_ne!(anonymous.cache_key, cookie.cache_key);
        assert_eq!(
            a.request.as_ref().unwrap().try_clone().unwrap().build().unwrap().headers()["authorization"],
            "Basic dXNlci1hOnBhc3N3b3Jk"
        );
    }
}
