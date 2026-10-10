use sha2::{Digest, Sha256};

/// Matches Web Crypto's digest of the same UTF-8 JSON tuple in providerCacheScope.ts.
pub fn library_scope(server: &str, credential: &str, library: &str, base: &str) -> String {
    let tuple =
        serde_json::to_vec(&["plex", server, credential, library, base]).expect("string tuple");
    format!("plex-{:x}", Sha256::digest(tuple))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scopes_separate_account_server_library_and_endpoint_without_exposing_credentials() {
        let scope = library_scope("server", "dummy-token", "music", "https://plex.test");
        assert_eq!(
            scope,
            "plex-0792f0fa6f74358dbdacfac79e241543d63725c9b7e26f8c64b5c6e5f7814358"
        );
        assert_eq!(scope.len(), 69);
        assert!(!scope.contains("dummy-token"));
        for other in [
            library_scope("server", "other-token", "music", "https://plex.test"),
            library_scope("other-server", "dummy-token", "music", "https://plex.test"),
            library_scope(
                "server",
                "dummy-token",
                "other-library",
                "https://plex.test",
            ),
            library_scope("server", "dummy-token", "music", "https://other.test"),
        ] {
            assert_ne!(scope, other);
        }
    }
}
