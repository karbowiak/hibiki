use sha2::{Digest, Sha256};

/// Matches Web Crypto's digest of the same UTF-8 JSON tuple in providerCacheScope.ts.
pub fn library_scope(server: &str, credential: &str, library: &str, base: &str) -> String {
    let tuple =
        serde_json::to_vec(&["plex", server, credential, library, base]).expect("string tuple");
    format!("plex-{:x}", Sha256::digest(tuple))
}

/// Match only cryptographically identical account/server/library owners across
/// known endpoint URLs. Never infer identity from titles, numeric IDs or a URL.
/// The native connect path calls this after verifying server identity and access;
/// offline restoration uses the exact saved credential/server/library identity.
pub(crate) fn restore_endpoint_aliases(
    client: &mut super::PlexClient,
    conn: &rusqlite::Connection,
    libraries: &[(i64, Option<String>)],
    known_urls: &[String],
) -> Result<(), String> {
    let mut stmt = conn.prepare("SELECT scope,SUM(weight) FROM (SELECT scope,1000000000 AS weight FROM favorites_entries GROUP BY scope UNION ALL SELECT scope,1000000 AS weight FROM audio_download_entities GROUP BY scope UNION ALL SELECT scope,1000 AS weight FROM local_audio GROUP BY scope UNION ALL SELECT scope,1 AS weight FROM offline_snapshots GROUP BY scope) GROUP BY scope")
        .map_err(|_| "Cannot inspect saved library owners")?;
    let scores = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|_| "Cannot inspect saved library owners")?
        .collect::<Result<std::collections::BTreeMap<_, _>, _>>()
        .map_err(|_| "Cannot inspect saved library owners")?;
    let mut bases = vec![client.base_url().to_owned()];
    for url in known_urls {
        if super::tls::server_url(url).is_ok() {
            bases.push(url.clone());
            bases.push(url.trim_end_matches('/').to_owned());
            bases.push(format!("{}/", url.trim_end_matches('/')));
        }
    }
    bases.sort();
    bases.dedup();
    for (id, uuid) in libraries {
        let library = uuid
            .as_ref()
            .filter(|s| !s.is_empty())
            .cloned()
            .unwrap_or_else(|| id.to_string());
        let current = library_scope(
            &client.machine_identifier,
            &client.token,
            &library,
            client.base_url(),
        );
        let mut selected = (
            scores.get(&current).copied().unwrap_or(0),
            client.base_url().to_owned(),
        );
        for base in &bases {
            let scope = library_scope(&client.machine_identifier, &client.token, &library, base);
            let score = scores.get(&scope).copied().unwrap_or(0);
            if score > selected.0 {
                selected = (score, base.clone());
            }
        }
        if selected.0 > 0 {
            client.scope_bases.insert(library, selected.1);
        }
    }
    Ok(())
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
    #[test]
    fn verified_endpoint_aliases_reuse_owned_data_without_crossing_accounts_or_libraries() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::run_migrations(&conn).unwrap();
        let original = library_scope("server", "credential", "library", "https://old.test");
        conn.execute(
            "INSERT INTO favorites_entries VALUES(?1,'liked','{}')",
            [&original],
        )
        .unwrap();
        let make = |token: &str| {
            let mut c = crate::plex::PlexClient::new(crate::plex::PlexClientConfig {
                base_url: "https://new.test".into(),
                token: token.into(),
                ..Default::default()
            })
            .unwrap();
            c.machine_identifier = "server".into();
            c
        };
        let libraries = vec![(5, Some("library".into()))];
        let mut c = make("credential");
        restore_endpoint_aliases(&mut c, &conn, &libraries, &["https://old.test".into()]).unwrap();
        assert_eq!(c.cache_scope_for_library(5, Some("library")), original);
        assert_ne!(
            c.cache_scope_for_library(5, Some("other-library")),
            original
        );
        c.token = "other-account".into();
        assert_ne!(c.cache_scope_for_library(5, Some("library")), original);
        let mut other = make("other-account");
        restore_endpoint_aliases(&mut other, &conn, &libraries, &["https://old.test".into()])
            .unwrap();
        assert_ne!(other.cache_scope_for_library(5, Some("library")), original);
        let mut unknown = make("credential");
        restore_endpoint_aliases(&mut unknown, &conn, &libraries, &[]).unwrap();
        assert_ne!(
            unknown.cache_scope_for_library(5, Some("library")),
            original
        );
        let mut different_server = make("credential");
        different_server.machine_identifier = "other-server".into();
        restore_endpoint_aliases(
            &mut different_server,
            &conn,
            &libraries,
            &["https://old.test".into()],
        )
        .unwrap();
        assert_ne!(
            different_server.cache_scope_for_library(5, Some("library")),
            original
        );
    }
}
