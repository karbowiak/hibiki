//! Certificate exceptions are explicit and bound to one HTTPS origin.

use super::models::{IdentityResponse, PlexApiResponse};
use anyhow::{Context, Result};
use std::path::Path;

pub fn server_url(value: &str) -> Result<url::Url> {
    let parsed = url::Url::parse(value).context("Invalid Plex server URL")?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        anyhow::bail!(
            "Plex server URL must be HTTP or HTTPS without credentials, query or fragment"
        );
    }
    Ok(parsed)
}

pub fn preference(config_dir: &Path, base: &str, requested: Option<bool>) -> Result<bool> {
    let url = server_url(base)?;
    let origin = url.origin().ascii_serialization();
    if requested == Some(true) && url.scheme() != "https" {
        anyhow::bail!("Certificate exceptions only apply to HTTPS servers");
    }
    if let Some(allow) = requested {
        super::auth::update(config_dir, |settings| {
            settings
                .tls_exceptions
                .retain(|existing| existing != &origin);
            if allow {
                settings.tls_exceptions.push(origin);
            }
            Ok(allow)
        })
    } else {
        let settings = super::auth::load(config_dir)?;
        Ok(url.scheme() == "https" && settings.tls_exceptions.contains(&origin))
    }
}

/// Identity is public: probing a candidate never sends account/server credentials.
pub async fn probe(
    base: &str,
    allow_invalid: bool,
    expected_id: Option<&str>,
) -> Result<(u64, IdentityResponse)> {
    server_url(base)?;
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .danger_accept_invalid_certs(allow_invalid)
        .danger_accept_invalid_hostnames(allow_invalid)
        .build()
        .context("Could not initialize server probe")?;
    let start = std::time::Instant::now();
    let response = http
        .get(format!("{}/identity", base.trim_end_matches('/')))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| error.without_url())
        .context("Could not securely reach Plex server")?;
    if !response.status().is_success() {
        anyhow::bail!("Plex identity probe returned HTTP {}", response.status());
    }
    let identity = response
        .json::<PlexApiResponse<IdentityResponse>>()
        .await
        .map_err(|error| error.without_url())
        .context("Server did not return a Plex identity")?
        .container;
    if identity.machine_identifier.is_empty()
        || expected_id.is_some_and(|id| id != identity.machine_identifier)
    {
        anyhow::bail!("The responding server does not match the selected Plex server");
    }
    Ok((start.elapsed().as_millis() as u64, identity))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exceptions_are_off_by_default_and_only_apply_to_the_exact_https_origin() {
        let root = tempfile::tempdir().unwrap();
        assert!(!preference(root.path(), "https://plex.example:32400", None).unwrap());
        preference(root.path(), "https://plex.example:32400/plex", Some(true)).unwrap();
        assert!(preference(root.path(), "https://PLEX.example:32400", None).unwrap());
        for other in [
            "https://plex.example",
            "https://other.example:32400",
            "http://plex.example:32400",
        ] {
            assert!(!preference(root.path(), other, None).unwrap());
        }
        preference(root.path(), "https://plex.example:32400", Some(false)).unwrap();
        assert!(!preference(root.path(), "https://plex.example:32400", None).unwrap());
        assert!(preference(root.path(), "http://plex.example:32400", Some(true)).is_err());
    }
    #[test]
    fn server_urls_reject_embedded_credentials_and_unsupported_schemes() {
        for value in [
            "file:///tmp/secret",
            "ftp://example.test",
            "https://user:password@plex.test",
            "https://plex.test/?token=secret",
            "https://plex.test/#fragment",
        ] {
            assert!(server_url(value).is_err());
        }
        assert!(server_url("https://plex.test/plex/").is_ok());
    }

    struct TlsFixture {
        url: String,
        requests: tokio::sync::mpsc::UnboundedReceiver<String>,
        task: tokio::task::JoinHandle<()>,
    }
    impl Drop for TlsFixture {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn tls_fixture() -> TlsFixture {
        use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio_rustls::{rustls, TlsAcceptor};
        // Test-only certificate and key. They never identify a real server or user.
        let certificate =
            CertificateDer::from(include_bytes!("fixtures/test-only-certificate.der").to_vec());
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
            include_bytes!("fixtures/test-only-key.der").to_vec(),
        ));
        let config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![certificate], key)
            .unwrap();
        let acceptor = TlsAcceptor::from(std::sync::Arc::new(config));
        let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("https://{}", socket.local_addr().unwrap());
        let (sent, requests) = tokio::sync::mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = socket.accept().await {
                let acceptor = acceptor.clone();
                let sent = sent.clone();
                tokio::spawn(async move {
                    let Ok(mut stream) = acceptor.accept(stream).await else {
                        return;
                    };
                    let mut request = Vec::new();
                    let mut chunk = [0_u8; 2048];
                    while request.len() < 8192
                        && !request.windows(4).any(|window| window == b"\r\n\r\n")
                    {
                        let Ok(read) = stream.read(&mut chunk).await else {
                            return;
                        };
                        if read == 0 {
                            return;
                        }
                        request.extend_from_slice(&chunk[..read]);
                    }
                    let _ = sent.send(String::from_utf8_lossy(&request).into_owned());
                    let (mime, body) = if request.starts_with(b"GET /library/metadata/1/thumb") {
                        ("image/png", crate::image_content::test_png())
                    } else {
                        ("application/json", br#"{"MediaContainer":{"machineIdentifier":"test-server","claimed":true}}"#.to_vec())
                    };
                    let response = format!("HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                    if stream.write_all(response.as_bytes()).await.is_ok() { let _ = stream.write_all(&body).await; }
                });
            }
        });
        TlsFixture {
            url,
            requests,
            task,
        }
    }

    #[tokio::test]
    async fn tls_is_verified_by_default_and_an_exception_cannot_leak_to_other_origins() {
        use crate::plex::{PlexClient, PlexClientConfig};
        let mut server = tls_fixture().await;
        let strict = PlexClient::new(PlexClientConfig {
            base_url: server.url.clone(),
            token: "dummy-private-token".into(),
            ..Default::default()
        })
        .unwrap();
        assert!(strict.get_identity().await.is_err());
        assert!(
            server.requests.try_recv().is_err(),
            "untrusted TLS must fail before sending headers"
        );
        let exception = PlexClient::new(PlexClientConfig {
            base_url: server.url.clone(),
            token: "dummy-private-token".into(),
            accept_invalid_certs: true,
            ..Default::default()
        })
        .unwrap();
        assert_eq!(
            exception.get_identity().await.unwrap().machine_identifier,
            "test-server"
        );
        let request = server.requests.recv().await.unwrap().to_ascii_lowercase();
        assert!(request.contains("x-plex-token: dummy-private-token"));

        let mut foreign = tls_fixture().await;
        assert!(exception
            .media_request(&format!(
                "{}/cover?X-Plex-Token=dummy-private-token",
                foreign.url
            ))
            .send()
            .await
            .is_err());
        assert!(
            foreign.requests.try_recv().is_err(),
            "a server exception must not disable TLS checks on public media"
        );
        assert!(exception
            .get_url::<serde_json::Value>(&foreign.url)
            .await
            .is_err());
        assert!(exception
            .put_url::<serde_json::Value>(&foreign.url, serde_json::json!({}))
            .await
            .is_err());
        assert!(foreign.requests.try_recv().is_err());
        let image = crate::image_fetch::request(Some(&exception), &foreign.url).unwrap();
        assert!(crate::image_fetch::fetch(image).await.is_none());
        assert!(foreign.requests.try_recv().is_err());
        let image = crate::image_fetch::request(
            Some(&exception),
            &format!("{}/library/metadata/1/thumb?X-Plex-Token=dummy-private-token", server.url),
        )
        .unwrap();
        assert!(crate::image_fetch::fetch(image).await.is_some());
        let image_request = server.requests.recv().await.unwrap().to_ascii_lowercase();
        assert!(image_request.contains("x-plex-token: dummy-private-token"));
        assert!(!image_request
            .lines()
            .next()
            .unwrap()
            .contains("dummy-private-token"));
    }

    #[tokio::test]
    async fn candidate_probes_never_send_credentials_and_validate_server_identity() {
        let mut server = tls_fixture().await;
        assert!(probe(&server.url, false, Some("test-server"))
            .await
            .is_err());
        assert!(server.requests.try_recv().is_err());
        assert!(probe(&server.url, true, Some("test-server")).await.is_ok());
        assert!(!server
            .requests
            .recv()
            .await
            .unwrap()
            .to_ascii_lowercase()
            .contains("x-plex-token"));
        assert!(probe(&server.url, true, Some("wrong-server"))
            .await
            .is_err());
        assert!(!server
            .requests
            .recv()
            .await
            .unwrap()
            .to_ascii_lowercase()
            .contains("x-plex-token"));
    }
}
