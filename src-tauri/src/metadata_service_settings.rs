//! Private optional metadata service configuration. No credential discovery.
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    path::Path,
};
use tokio::sync::Mutex;
#[derive(Default, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Configuration {
    pub base_url: String,
    pub api_key: String,
    pub enabled: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub revision: String,
    pub base_url: String,
    pub configured: bool,
    pub has_api_key: bool,
    pub enabled: bool,
}
struct Current {
    configuration: Configuration,
    revision: String,
    loaded: bool,
}
impl Default for Current {
    fn default() -> Self {
        Self {
            configuration: Configuration::default(),
            revision: uuid::Uuid::new_v4().to_string(),
            loaded: false,
        }
    }
}
pub struct ServiceSettings {
    current: Mutex<Current>,
    requires_key: bool,
}
impl ServiceSettings {
    pub fn new(requires_key: bool) -> Self {
        Self {
            current: Mutex::new(Current::default()),
            requires_key,
        }
    }
    fn status(&self, current: &Current) -> Status {
        Status {
            revision: current.revision.clone(),
            base_url: current.configuration.base_url.clone(),
            configured: !current.configuration.base_url.is_empty()
                && (!self.requires_key || !current.configuration.api_key.is_empty()),
            has_api_key: !current.configuration.api_key.is_empty(),
            enabled: current.configuration.enabled,
        }
    }
    pub async fn snapshot(&self, directory: &Path) -> Result<(Status, Configuration), String> {
        let mut current = self.current.lock().await;
        let path = directory.to_path_buf();
        let required = self.requires_key;
        let saved = tokio::task::spawn_blocking(move || transaction(&path, None, required))
            .await
            .map_err(|_| "Could not read metadata service settings.")??;
        if !current.loaded || current.configuration != saved {
            current.configuration = saved;
            current.loaded = true;
            current.revision = uuid::Uuid::new_v4().to_string();
        }
        Ok((self.status(&current), current.configuration.clone()))
    }
    pub async fn publication_guard(&self, revision: &str) -> Result<impl Sized + '_, String> {
        let current = self.current.lock().await;
        if current.revision != revision || !current.configuration.enabled {
            return Err("Metadata service configuration changed. Retry the lookup.".into());
        }
        Ok(current)
    }
    pub async fn owned(&self, revision: &str) -> bool {
        self.current.lock().await.revision == revision
    }
    pub async fn update(
        &self,
        directory: &Path,
        revision: &str,
        base_url: String,
        key: Option<String>,
        enabled: bool,
        clear: bool,
    ) -> Result<Status, String> {
        self.snapshot(directory).await?;
        let mut current = self.current.lock().await;
        if current.revision != revision {
            return Err(
                "Metadata service configuration changed. Reload Settings before saving.".into(),
            );
        }
        let base = if base_url.trim().is_empty() {
            String::new()
        } else {
            plain_base(base_url.trim())?.to_string()
        };
        let old = if current.configuration.base_url.is_empty() {
            String::new()
        } else {
            plain_base(&current.configuration.base_url)?.to_string()
        };
        if !clear
            && !base.is_empty()
            && base != old
            && !current.configuration.api_key.is_empty()
            && key.as_ref().is_none_or(|v| v.is_empty())
        {
            return Err("Enter an API key when changing the server URL; the saved key stays with its original server.".into());
        }
        let api_key = if clear {
            String::new()
        } else {
            key.unwrap_or_else(|| current.configuration.api_key.clone())
        };
        if api_key.len() > 4096
            || api_key.chars().any(char::is_whitespace)
            || reqwest::header::HeaderValue::from_str(&api_key).is_err()
        {
            return Err("Metadata service API key is invalid.".into());
        }
        if enabled && !clear && (base.is_empty() || (self.requires_key && api_key.is_empty())) {
            return Err(
                "Enter the required server URL and API key before enabling this source.".into(),
            );
        }
        let previous = current.configuration.clone();
        let next = Configuration {
            base_url: base,
            api_key,
            enabled: enabled && !clear,
        };
        let saved = next.clone();
        let path = directory.to_path_buf();
        let required = self.requires_key;
        current.revision = uuid::Uuid::new_v4().to_string();
        tokio::task::spawn_blocking(move || transaction(&path, Some((saved, previous)), required))
            .await
            .map_err(|_| "Could not save metadata service settings.")??;
        current.configuration = next;
        current.revision = uuid::Uuid::new_v4().to_string();
        Ok(self.status(&current))
    }
}
fn plain_base(value: &str) -> Result<url::Url, String> {
    let mut base =
        url::Url::parse(value).map_err(|_| "Enter a valid Metadata service server URL.")?;
    if !["http", "https"].contains(&base.scheme())
        || base.host_str().is_none()
        || !base.username().is_empty()
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
    {
        return Err(
            "Metadata service URL must be HTTP(S), without credentials, query or fragment.".into(),
        );
    }
    if value.len() > 2048 {
        return Err("Metadata service URL is too long.".into());
    }
    base.set_path(&format!("{}/", base.path().trim_end_matches('/')));
    Ok(base)
}
fn private(file: &std::fs::File) -> Result<(), String> {
    if crate::cache_files::file_id(file).is_none()
        || !crate::cache_files::regular_file(
            &file
                .metadata()
                .map_err(|_| "Could not inspect Metadata service settings.")?,
        )
    {
        return Err("Metadata service settings must be a private regular file.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "Could not protect Metadata service settings.")?;
    }
    Ok(())
}
fn transaction(
    directory: &Path,
    update: Option<(Configuration, Configuration)>,
    requires_key: bool,
) -> Result<Configuration, String> {
    std::fs::create_dir_all(directory)
        .map_err(|_| "Could not open Metadata service settings directory.")?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let lock = options
        .open(directory.join(".credentials.lock"))
        .map_err(|_| "Could not lock Metadata service settings.")?;
    private(&lock)?;
    lock.lock()
        .map_err(|_| "Could not lock Metadata service settings.")?;
    let path = directory.join("credentials.json");
    let saved = match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Configuration::default(),
        Err(_) => return Err("Could not safely read Metadata service settings.".into()),
        Ok(metadata) => {
            if !crate::cache_files::regular_file(&metadata) || metadata.len() > 16384 {
                return Err("Metadata service settings are not a valid private file.".into());
            }
            let mut options = std::fs::OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                options.custom_flags(
                    windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT,
                );
            }
            let file = options
                .open(&path)
                .map_err(|_| "Could not safely read Metadata service settings.")?;
            private(&file)?;
            let mut content = String::new();
            file.take(16385)
                .read_to_string(&mut content)
                .map_err(|_| "Could not safely read Metadata service settings.")?;
            serde_json::from_str(&content).map_err(|_| {
                "Metadata service settings are invalid; existing credentials were preserved."
            })?
        }
    };
    if !saved.base_url.is_empty() {
        plain_base(&saved.base_url)?;
    }
    if saved.api_key.len() > 4096
        || saved.api_key.chars().any(char::is_whitespace)
        || reqwest::header::HeaderValue::from_str(&format!("Bearer {}", saved.api_key)).is_err()
        || (saved.enabled
            && (saved.base_url.is_empty() || (requires_key && saved.api_key.is_empty())))
    {
        return Err(
            "Metadata service settings are invalid; existing credentials were preserved.".into(),
        );
    }
    if let Some((next, expected)) = update {
        if saved != expected {
            return Err("Metadata service configuration changed in another app instance. Reload Settings before saving.".into());
        }
        let bytes =
            serde_json::to_vec(&next).map_err(|_| "Could not save Metadata service settings.")?;
        let mut temporary = tempfile::Builder::new()
            .prefix(".credentials.")
            .tempfile_in(directory)
            .map_err(|_| "Could not save Metadata service settings.")?;
        private(temporary.as_file())?;
        temporary
            .write_all(&bytes)
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|_| "Could not save Metadata service settings.")?;
        temporary.persist(path).map_err(|_| {
            "Could not replace Metadata service settings; existing credentials were preserved."
        })?;
        #[cfg(unix)]
        std::fs::File::open(directory)
            .and_then(|file| file.sync_all())
            .map_err(|_| "Could not sync Metadata service settings.")?;
        Ok(next)
    } else {
        Ok(saved)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn anonymous_heya_and_key_target_fences_preserve_private_atomic_settings() {
        let root = tempfile::tempdir().unwrap();
        let state = ServiceSettings::new(false);
        let (initial, _) = state.snapshot(root.path()).await.unwrap();
        let public = state
            .update(
                root.path(),
                &initial.revision,
                "https://synthetic.test/api".into(),
                None,
                true,
                false,
            )
            .await
            .unwrap();
        assert!(public.configured && public.enabled && !public.has_api_key);
        let protected = state
            .update(
                root.path(),
                &public.revision,
                public.base_url.clone(),
                Some("fictional-native-key".into()),
                true,
                false,
            )
            .await
            .unwrap();
        let saved = std::fs::read(root.path().join("credentials.json")).unwrap();
        for target in ["https://other.test/api", "https://synthetic.test/other"] {
            assert!(state
                .update(
                    root.path(),
                    &protected.revision,
                    target.into(),
                    None,
                    true,
                    false
                )
                .await
                .is_err());
            assert!(state.owned(&protected.revision).await);
            assert_eq!(
                std::fs::read(root.path().join("credentials.json")).unwrap(),
                saved
            );
        }
        let status_json = serde_json::to_string(&protected).unwrap();
        assert!(!status_json.contains("fictional-native-key"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(root.path().join("credentials.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        let reopened = ServiceSettings::new(false);
        let (status, config) = reopened.snapshot(root.path()).await.unwrap();
        assert!(status.has_api_key && config.api_key == "fictional-native-key");
        let cleared = reopened
            .update(
                root.path(),
                &status.revision,
                "https://new.test".into(),
                None,
                true,
                true,
            )
            .await
            .unwrap();
        assert!(!cleared.has_api_key && !cleared.enabled);
        std::fs::write(root.path().join("credentials.json"), "{original-invalid").unwrap();
        assert!(reopened.snapshot(root.path()).await.is_err());
        assert_eq!(
            std::fs::read_to_string(root.path().join("credentials.json")).unwrap(),
            "{original-invalid"
        );
    }
    #[tokio::test]
    async fn concurrent_settings_instances_require_reload_and_fanart_requires_key() {
        let root = tempfile::tempdir().unwrap();
        let first = ServiceSettings::new(true);
        let second = ServiceSettings::new(true);
        let (a, _) = first.snapshot(root.path()).await.unwrap();
        let (b, _) = second.snapshot(root.path()).await.unwrap();
        assert!(first
            .update(
                root.path(),
                &a.revision,
                "https://synthetic.test".into(),
                None,
                true,
                false
            )
            .await
            .is_err());
        first
            .update(
                root.path(),
                &a.revision,
                "https://synthetic.test".into(),
                Some("fictional-first-key".into()),
                true,
                false,
            )
            .await
            .unwrap();
        assert!(second
            .update(
                root.path(),
                &b.revision,
                "https://other.test".into(),
                Some("fictional-second-key".into()),
                true,
                false
            )
            .await
            .is_err());
        assert!(transaction(root.path(), None, true).unwrap().api_key == "fictional-first-key");
    }
}
