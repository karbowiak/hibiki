//! Immutable HTTP and cache identity, constructed at trusted native ingress.

use futures::future::BoxFuture;
use sha2::{Digest, Sha256};
use std::sync::Arc;

type Resolver = dyn Fn() -> BoxFuture<'static, Result<MediaSource, String>> + Send + Sync;

pub(crate) struct MediaSource {
    pub(crate) request: Option<reqwest::RequestBuilder>,
    pub(crate) plex_fetch_lock: Option<std::sync::Arc<tokio::sync::Mutex<()>>>,
    pub(crate) cache_key: String,
    pub(crate) plex_scope: Option<String>,
    pub(crate) extension: String,
    pub(crate) local_cache: Option<std::sync::Arc<super::cache::AudioCache>>,
    /// Track-level gain derived from native provider loudness metadata.
    pub(crate) gain_db: Option<f32>,
    /// Generate a cached display waveform when this provider supplies none.
    pub(crate) prepare_waveform: bool,
    resolver: Option<Arc<Resolver>>,
}

impl MediaSource {
    pub(super) fn try_clone(&self) -> Result<Self, String> {
        Ok(Self {
            request: self
                .request
                .as_ref()
                .map(|request| request.try_clone().ok_or("Cannot clone media request"))
                .transpose()?,
            plex_fetch_lock: self.plex_fetch_lock.clone(),
            cache_key: self.cache_key.clone(),
            plex_scope: self.plex_scope.clone(),
            extension: self.extension.clone(),
            local_cache: self.local_cache.clone(),
            gain_db: self.gain_db,
            prepare_waveform: self.prepare_waveform,
            resolver: self.resolver.clone(),
        })
    }
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
            gain_db: None,
            prepare_waveform: false,
            resolver: None,
        })
    }

    pub(crate) fn with_plex_fetch_lock(
        mut self,
        lock: std::sync::Arc<tokio::sync::Mutex<()>>,
    ) -> Self {
        self.plex_fetch_lock = Some(lock);
        self
    }

    /// Admit an opaque identity immediately; resolve credentials/media only after
    /// the engine owns a cancellable play or preload request.
    pub(crate) fn deferred(
        identity: String,
        resolver: impl Fn() -> BoxFuture<'static, Result<Self, String>> + Send + Sync + 'static,
    ) -> Self {
        Self {
            request: None,
            plex_fetch_lock: None,
            cache_key: identity,
            plex_scope: None,
            extension: String::new(),
            local_cache: None,
            gain_db: None,
            prepare_waveform: false,
            resolver: Some(Arc::new(resolver)),
        }
    }

    pub(crate) fn requires_resolution(&self) -> bool {
        self.resolver.is_some()
    }

    pub(crate) fn resolve_network(
        &self,
        rt: &tokio::runtime::Handle,
        request: &super::request::PlaybackRequest,
    ) -> Result<Self, String> {
        let resolve = self
            .resolver
            .as_ref()
            .ok_or("Audio source has no network fallback")?;
        rt.block_on(async {
            tokio::select! {
                biased;
                _ = request.cancelled() => Err("Audio request superseded".into()),
                source = resolve() => source,
            }
        })
    }

    pub(crate) fn resolve(
        mut self,
        rt: &tokio::runtime::Handle,
        request: &super::request::PlaybackRequest,
    ) -> Result<Self, String> {
        if !request.is_current() {
            return Err("Audio request superseded".into());
        }
        let _fill = if self.resolver.is_some() {
            self.local_cache
                .as_ref()
                .map(|cache| cache.fill_lock(&self.cache_key))
        } else {
            None
        };
        let _guard = _fill
            .map(|lock| {
                rt.block_on(async {
                    tokio::select! {
                        biased;
                        _ = request.cancelled() => Err("Audio request superseded".to_owned()),
                        guard = lock.lock_owned() => Ok(guard),
                    }
                })
            })
            .transpose()?;
        if self.resolver.is_some() {
            if let Some(path) = self
                .local_cache
                .as_ref()
                .and_then(|cache| cache.lookup(&self.cache_key))
            {
                self.extension = path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .unwrap_or("dat")
                    .into();
                return Ok(self);
            }
        }
        if let Some(resolve) = self.resolver.take() {
            let prepare_waveform = self.prepare_waveform;
            self = rt.block_on(async {
                tokio::select! {
                    biased;
                    _ = request.cancelled() => Err("Audio request superseded".into()),
                    source = resolve() => source,
                }
            })?;
            self.prepare_waveform |= prepare_waveform;
        }
        if !request.is_current() {
            return Err("Audio request superseded".into());
        }
        Ok(self)
    }

    /// Native-only admission from a verified scoped binding. No network fallback.
    pub(crate) fn cached(
        key: String,
        extension: String,
        scope: String,
        cache: std::sync::Arc<super::cache::AudioCache>,
    ) -> Self {
        Self {
            request: None,
            plex_fetch_lock: None,
            cache_key: key,
            plex_scope: Some(scope),
            extension,
            local_cache: Some(cache),
            gain_db: None,
            prepare_waveform: false,
            resolver: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_engine::cache::AudioCache;

    #[test]
    fn cached_opaque_sources_survive_restart_without_running_the_extractor() {
        use std::sync::atomic::{AtomicU64, Ordering};
        let directory = tempfile::tempdir().unwrap();
        let key = "s1-opaque-fixture";
        {
            let cache = AudioCache::new(directory.path().into(), None);
            let mut writer = cache.begin_write(key, "wav").unwrap();
            writer
                .write_chunk(&super::super::deck::decode::tests::generate_test_wav(
                    44100, 2, 1.0,
                ))
                .unwrap();
            writer.finish(&cache).unwrap();
            cache.set_computed_gain(key, -6.0);
        }
        let cache = Arc::new(AudioCache::new(directory.path().into(), None));
        let mut source = MediaSource::deferred(key.into(), || {
            panic!("A complete cached song must not resolve a signed URL")
        });
        source.local_cache = Some(cache.clone());
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let request = super::super::request::PlaybackRequest::new(
            1,
            Arc::new(AtomicU64::new(1)),
            Arc::new(AtomicU64::new(0)),
        );
        let source = source.resolve(runtime.handle(), &request).unwrap();
        assert!(source.request.is_none());
        assert_eq!(source.extension, "wav");
        assert_eq!(cache.get_computed_gain(key), Some(-6.0));
        assert!(request.is_current());
        // The cache manager's shared fill lock also prevents a preload resolving
        // a URL while the selected occurrence is still publishing the same file.
        let fill = cache.fill_lock(key);
        let guard = runtime.block_on(fill.lock_owned());
        let epoch = Arc::new(AtomicU64::new(2));
        let pending = super::super::request::PlaybackRequest::new(
            2,
            epoch.clone(),
            Arc::new(AtomicU64::new(0)),
        );
        let cancelled = std::thread::spawn(move || {
            epoch.store(3, Ordering::SeqCst);
        });
        assert!(source.resolve(runtime.handle(), &pending).is_err());
        cancelled.join().unwrap();
        drop(guard);
    }

    #[test]
    fn slow_media_lookups_are_dropped_on_stop_selection_and_preload_replacement() {
        use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
        struct Dropped(Arc<AtomicBool>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let runtime = tokio::runtime::Runtime::new().unwrap();
        for preload in [false, true] {
            let epoch = Arc::new(AtomicU64::new(1));
            let revision = Arc::new(AtomicU64::new(0));
            let mut request = super::super::request::PlaybackRequest::new(
                1,
                epoch.clone(),
                Arc::new(AtomicU64::new(0)),
            );
            if preload {
                request = request.for_preload(revision.clone(), 0);
            }
            let dropped = Arc::new(AtomicBool::new(false));
            let observed = dropped.clone();
            let (entered, waiting) = std::sync::mpsc::channel();
            let source = MediaSource::deferred("ytmusic:fixture".into(), move || {
                let entered = entered.clone();
                let guard = Dropped(observed.clone());
                Box::pin(async move {
                    let _guard = guard;
                    entered.send(()).unwrap();
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    Err("Lookup should have been cancelled".into())
                })
            });
            let cancel = std::thread::spawn(move || {
                waiting
                    .recv_timeout(std::time::Duration::from_secs(2))
                    .unwrap();
                if preload {
                    revision.fetch_add(1, Ordering::SeqCst);
                } else {
                    epoch.fetch_add(1, Ordering::SeqCst);
                }
            });
            let started = std::time::Instant::now();
            assert!(source.resolve(runtime.handle(), &request).is_err());
            assert!(started.elapsed() < std::time::Duration::from_secs(2));
            assert!(
                dropped.load(Ordering::SeqCst),
                "Cancellation must drop the extractor future and its process/cookie file"
            );
            cancel.join().unwrap();
        }
    }

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
        let request = forged
            .request
            .as_ref()
            .unwrap()
            .try_clone()
            .unwrap()
            .build()
            .unwrap();
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
            a.request
                .as_ref()
                .unwrap()
                .try_clone()
                .unwrap()
                .build()
                .unwrap()
                .headers()["authorization"],
            "Basic dXNlci1hOnBhc3N3b3Jk"
        );
    }
}
