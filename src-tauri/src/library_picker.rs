//! Read-only server/library discovery. Browsing choices never changes playback
//! or the active Plex client. Credentials remain native until an explicit switch.
use crate::{
    commands::{PlexRequestContext, PlexState},
    plex::{LibrarySection, PlexClient, PlexClientConfig},
    plextv::PlexResource,
};
use futures::{stream, StreamExt};
use serde::Serialize;
use std::{collections::HashMap, sync::Mutex};
use tauri::{Manager, State};

pub struct LibraryPicker {
    catalogue: Mutex<Catalogue>,
    slots: tokio::sync::Semaphore,
}
impl Default for LibraryPicker {
    fn default() -> Self {
        Self {
            catalogue: Mutex::new(Catalogue::default()),
            slots: tokio::sync::Semaphore::new(3),
        }
    }
}
impl LibraryPicker {
    pub(crate) fn clear(&self) {
        if let Ok(mut catalogue) = self.catalogue.lock() {
            catalogue.generation = catalogue.generation.wrapping_add(1);
            catalogue.servers.clear();
            catalogue.scope.clear();
        }
    }
}
#[derive(Default)]
struct Catalogue {
    revision: u64,
    scope: String,
    generation: u64,
    servers: HashMap<String, Server>,
}
#[derive(Clone)]
struct Server {
    machine: String,
    token: String,
    urls: Vec<String>,
    verified: Option<(PlexClient, Vec<LibrarySection>)>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerChoice {
    id: String,
    name: String,
    current: bool,
}
#[derive(Serialize)]
pub struct ServerChoices {
    servers: Vec<ServerChoice>,
    notice: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryChoice {
    key: i64,
    uuid: Option<String>,
    title: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryConnection {
    base_url: String,
    token: String,
    all_urls: Vec<String>,
    machine_identifier: String,
    section_id: i64,
    section_uuid: Option<String>,
}
fn owns(c: &Catalogue, context: &PlexRequestContext) -> bool {
    c.revision == context.connection_revision && c.scope == context.cache_scope
}
async fn owner(state: &PlexState, context: &PlexRequestContext) -> Result<PlexClient, String> {
    let guard = state.0.lock().await;
    Ok(state.checked_cache_client(context, &guard)?.clone())
}
// Try a public route alongside the first LAN route. A shared server can advertise
// several private interfaces before its only reachable public endpoint.
fn ordered_connections(mut connections: Vec<crate::plextv::PlexConnection>) -> Vec<String> {
    connections.sort_by_key(|c| (c.relay, !c.uri.starts_with("https://"), c.local));
    connections
        .into_iter()
        .filter(|c| !c.uri.is_empty())
        .map(|c| c.uri)
        .collect()
}
fn account_owns_resource(
    resources: &[PlexResource],
    account_token: &str,
    client: &PlexClient,
) -> bool {
    account_token == client.token
        || resources.iter().any(|r| {
            r.client_identifier == client.machine_identifier
                && r.access_token.as_deref() == Some(client.token.as_str())
        })
}
#[tauri::command]
pub async fn library_picker_servers(
    context: PlexRequestContext,
    state: State<'_, PlexState>,
    picker: State<'_, LibraryPicker>,
    app: tauri::AppHandle,
) -> Result<ServerChoices, String> {
    let client = owner(&state, &context).await?;
    let generation = {
        let mut catalogue = picker
            .catalogue
            .lock()
            .map_err(|_| "Library picker unavailable")?;
        catalogue.generation = catalogue.generation.wrapping_add(1);
        catalogue.generation
    };
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|_| "Plex settings unavailable")?;
    let settings =
        crate::plex::load_settings(&directory).map_err(|_| "Plex settings unavailable")?;
    let account = if settings.plex_account_token.is_empty() {
        client.token.clone()
    } else {
        settings.plex_account_token.clone()
    };
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(8),
        crate::plextv::get_resources(&client.client_id, &account),
    )
    .await;
    let (mut resources, notice) = match response {
        Ok(Ok(resources)) if account_owns_resource(&resources, &account, &client) => {
            (resources, None)
        }
        _ => (
            Vec::new(),
            Some("Sign in with Plex in Connection settings to see your other servers.".into()),
        ),
    };
    resources.truncate(32);
    let mut entries = HashMap::new();
    let mut choices = Vec::new();
    for resource in resources {
        let current = resource.client_identifier == client.machine_identifier;
        let mut urls = ordered_connections(resource.connections);
        if let Some(previous) = settings.plex_server_urls.get(&resource.client_identifier) {
            let mut preferred = previous.clone();
            preferred.extend(urls);
            urls = preferred;
        }
        if current {
            urls.insert(0, client.base_url().to_owned());
        }
        let mut seen = std::collections::HashSet::new();
        urls.retain(|url| seen.insert(url.clone()));
        urls.truncate(12);
        let id = uuid::Uuid::new_v4().to_string();
        entries.insert(
            id.clone(),
            Server {
                machine: resource.client_identifier,
                token: resource
                    .access_token
                    .filter(|token| !token.is_empty())
                    .unwrap_or_else(|| account.clone()),
                urls,
                verified: None,
            },
        );
        choices.push(ServerChoice {
            id,
            name: resource.name,
            current,
        });
    }
    if !choices.iter().any(|s| s.current) {
        let id = uuid::Uuid::new_v4().to_string();
        let mut urls = vec![client.base_url().to_owned()];
        urls.extend(settings.all_urls);
        entries.insert(
            id.clone(),
            Server {
                machine: client.machine_identifier.clone(),
                token: client.token.clone(),
                urls,
                verified: None,
            },
        );
        choices.push(ServerChoice {
            id,
            name: "Current server".into(),
            current: true,
        });
    }
    choices.sort_by(|a, b| {
        b.current
            .cmp(&a.current)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    // Retain an already-validated account credential before switching to a
    // shared server's narrower resource token. The account token never leaves native.
    let guard = state.0.lock().await;
    state.checked_cache_client(&context, &guard)?;
    if notice.is_none() && settings.plex_account_token.is_empty() {
        crate::plex::update_settings(&directory, |settings| {
            settings.plex_account_token = account.clone();
            Ok(())
        }).map_err(|_| "Cannot retain Plex account discovery")?;
    }
    let mut catalogue = picker
        .catalogue
        .lock()
        .map_err(|_| "Library picker unavailable")?;
    if catalogue.generation != generation {
        return Err("Library discovery was superseded".into());
    }
    *catalogue = Catalogue {
        revision: context.connection_revision,
        scope: context.cache_scope,
        generation,
        servers: entries,
    };
    Ok(ServerChoices {
        servers: choices,
        notice,
    })
}
#[tauri::command]
pub async fn library_picker_sections(
    context: PlexRequestContext,
    server_id: String,
    state: State<'_, PlexState>,
    picker: State<'_, LibraryPicker>,
    app: tauri::AppHandle,
) -> Result<Vec<LibraryChoice>, String> {
    let active = owner(&state, &context).await?;
    let _slot = picker
        .slots
        .acquire()
        .await
        .map_err(|_| "Library discovery unavailable")?;
    owner(&state, &context).await?;
    let (server, generation) = {
        let catalogue = picker
            .catalogue
            .lock()
            .map_err(|_| "Library picker unavailable")?;
        if !owns(&catalogue, &context) {
            return Err("Library discovery was superseded".into());
        }
        (
            catalogue
                .servers
                .get(&server_id)
                .cloned()
                .ok_or("Refresh the library picker before choosing a server")?,
            catalogue.generation,
        )
    };
    if let Some((_, sections)) = server.verified {
        return Ok(sections
            .into_iter()
            .map(|s| LibraryChoice {
                key: s.key,
                uuid: s.uuid,
                title: s.title,
            })
            .collect());
    }
    let settings = crate::plex::load_settings(
        &app.path()
            .app_config_dir()
            .map_err(|_| "Plex settings unavailable")?,
    )
    .map_err(|_| "Plex settings unavailable")?;
    let candidates = server
        .urls
        .iter()
        .take(12)
        .map(|url| {
            let origin = url::Url::parse(url)
                .ok()
                .map(|url| url.origin().ascii_serialization());
            (
                url.clone(),
                server.token.clone(),
                active.client_id.clone(),
                server.machine.clone(),
                origin.is_some_and(|origin| settings.tls_exceptions.contains(&origin)),
            )
        })
        .collect::<Vec<_>>();
    let mut attempts = stream::iter(candidates)
        .map(
            |(url, token, client_id, machine, allow_invalid)| async move {
                let attempt = async {
                    crate::plex::tls::probe(&url, allow_invalid, Some(&machine))
                        .await
                        .map_err(|_| ())?;
                    let mut client = PlexClient::new(PlexClientConfig {
                        base_url: url,
                        token,
                        client_id,
                        accept_invalid_certs: allow_invalid,
                        ..Default::default()
                    })
                    .map_err(|_| ())?;
                    client.machine_identifier = machine;
                    let mut sections = client.get_all_sections().await.map_err(|_| ())?;
                    sections.retain(|s| s.section_type == "artist");
                    if sections.len() > 512 {
                        return Err(());
                    }
                    Ok::<_, ()>((client, sections))
                };
                tokio::time::timeout(std::time::Duration::from_secs(5), attempt)
                    .await
                    .ok()
                    .and_then(Result::ok)
            },
        )
        .buffer_unordered(2);
    let mut result = None;
    while let Some(attempt) = attempts.next().await {
        if let Some(verified) = attempt {
            result = Some(verified);
            break;
        }
    }
    drop(attempts);
    let (client, sections) =
        result.ok_or("This server is unavailable. Try again or choose another server.")?;
    owner(&state, &context).await?;
    let mut catalogue = picker
        .catalogue
        .lock()
        .map_err(|_| "Library picker unavailable")?;
    if !owns(&catalogue, &context) || catalogue.generation != generation {
        return Err("Library discovery was superseded".into());
    }
    catalogue
        .servers
        .get_mut(&server_id)
        .ok_or("Server choice expired")?
        .verified = Some((client, sections.clone()));
    Ok(sections
        .into_iter()
        .map(|s| LibraryChoice {
            key: s.key,
            uuid: s.uuid,
            title: s.title,
        })
        .collect())
}
#[tauri::command]
pub async fn library_picker_resolve(
    context: PlexRequestContext,
    server_id: String,
    section_id: i64,
    section_uuid: Option<String>,
    state: State<'_, PlexState>,
    picker: State<'_, LibraryPicker>,
) -> Result<LibraryConnection, String> {
    let guard = state.0.lock().await;
    state.checked_cache_client(&context, &guard)?;
    let catalogue = picker
        .catalogue
        .lock()
        .map_err(|_| "Library picker unavailable")?;
    if !owns(&catalogue, &context) {
        return Err("Library discovery was superseded".into());
    }
    let server = catalogue
        .servers
        .get(&server_id)
        .ok_or("Server choice expired")?;
    let (client, sections) = server
        .verified
        .as_ref()
        .ok_or("Load this server's libraries before switching")?;
    let section = sections
        .iter()
        .find(|s| s.key == section_id && s.uuid == section_uuid)
        .ok_or("Music library choice expired")?;
    Ok(LibraryConnection {
        base_url: client.base_url().into(),
        token: client.token.clone(),
        all_urls: server.urls.clone(),
        machine_identifier: server.machine.clone(),
        section_id: section.key,
        section_uuid: section.uuid.clone(),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_route_is_not_hidden_behind_unreachable_private_interfaces() {
        let connection = |local: bool, relay: bool, uri: &str| crate::plextv::PlexConnection {
            protocol: "https".into(),
            address: "fixture".into(),
            port: 32400,
            uri: uri.into(),
            local,
            relay,
        };
        let mut entries = (0..5)
            .map(|i| connection(true, false, &format!("https://private-{i}.test")))
            .collect::<Vec<_>>();
        entries.push(connection(false, true, "https://relay.test"));
        entries.push(connection(false, false, "https://public.test"));
        let urls = ordered_connections(entries);
        assert_eq!(urls.first().unwrap(), "https://public.test");
        assert_eq!(urls.last().unwrap(), "https://relay.test");
        assert_eq!(urls.len(), 7);
    }
    #[test]
    fn discovery_never_adopts_an_unrelated_saved_account_or_stale_library_owner() {
        let mut client = PlexClient::new(PlexClientConfig {
            token: "server-token".into(),
            ..Default::default()
        })
        .unwrap();
        client.machine_identifier = "server".into();
        let resource = |machine: &str, token: &str| PlexResource {
            name: "Shared".into(),
            client_identifier: machine.into(),
            provides: "server".into(),
            access_token: Some(token.into()),
            owned: false,
            connections: vec![],
        };
        assert!(account_owns_resource(
            &[resource("server", "server-token")],
            "account-token",
            &client
        ));
        assert!(!account_owns_resource(
            &[resource("server", "other-user")],
            "account-token",
            &client
        ));
        assert!(!account_owns_resource(
            &[resource("other-server", "server-token")],
            "account-token",
            &client
        ));
        let context = PlexRequestContext {
            connection_revision: 1,
            cache_scope: "owner".into(),
        };
        let catalogue = Catalogue {
            revision: 1,
            scope: "owner".into(),
            ..Default::default()
        };
        assert!(owns(&catalogue, &context));
        assert!(!owns(
            &catalogue,
            &PlexRequestContext {
                connection_revision: 2,
                ..context.clone()
            }
        ));
        assert!(!owns(
            &catalogue,
            &PlexRequestContext {
                cache_scope: "other-account".into(),
                ..context
            }
        ));
    }
}
