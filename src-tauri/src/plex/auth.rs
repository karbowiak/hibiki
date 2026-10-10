//! Atomic, private settings transactions shared by commands and app instances.

use super::models::PlexSettings;
use anyhow::{Context, Result};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub fn settings_path(config_dir: &Path) -> PathBuf {
    config_dir.join("plex_settings.json")
}

fn store_lock(config_dir: &Path) -> Result<File> {
    let mut directory = std::fs::DirBuilder::new();
    directory.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        directory.mode(0o700);
    }
    directory
        .create(config_dir)
        .context("Failed to create settings directory")?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(config_dir.join(".plex-settings.lock"))
        .context("Failed to open settings lock")?;
    make_private(&file)?;
    file.lock().context("Failed to lock settings")?;
    Ok(file)
}

fn make_private(file: &File) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if file.metadata()?.permissions().mode() & 0o7777 != 0o600 {
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
                .context("Failed to protect settings permissions")?;
        }
    }
    #[cfg(not(unix))]
    {
        let _ = file;
    }
    Ok(())
}

fn load_locked(config_dir: &Path) -> Result<PlexSettings> {
    let mut file = match File::open(settings_path(config_dir)) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PlexSettings::default())
        }
        Err(error) => return Err(error).context("Failed to open settings"),
    };
    make_private(&file)?;
    let mut content = String::new();
    file.read_to_string(&mut content)
        .context("Failed to read settings")?;
    serde_json::from_str(&content).context("Failed to parse settings")
}

fn save_locked(config_dir: &Path, settings: &PlexSettings) -> Result<()> {
    let content = serde_json::to_vec_pretty(settings).context("Failed to serialize settings")?;
    let mut pending = tempfile::Builder::new()
        .prefix(".settings.")
        .tempfile_in(config_dir)
        .context("Failed to create settings transaction")?;
    make_private(pending.as_file())?;
    pending
        .write_all(&content)
        .context("Failed to write settings transaction")?;
    pending
        .as_file()
        .sync_all()
        .context("Failed to sync settings transaction")?;
    pending
        .persist(settings_path(config_dir))
        .context("Failed to replace settings")?;
    #[cfg(unix)]
    {
        File::open(config_dir)?
            .sync_all()
            .context("Failed to sync settings directory")?;
    }
    Ok(())
}

pub fn load(config_dir: &Path) -> Result<PlexSettings> {
    let _lock = store_lock(config_dir)?;
    load_locked(config_dir)
}

/// Update the latest settings under one cross-process lock. Rejected updates do not write.
pub fn update<R>(
    config_dir: &Path,
    change: impl FnOnce(&mut PlexSettings) -> Result<R>,
) -> Result<R> {
    let _lock = store_lock(config_dir)?;
    let mut settings = load_locked(config_dir)?;
    let result = change(&mut settings)?;
    save_locked(config_dir, &settings)?;
    Ok(result)
}

pub fn ensure_client_id(config_dir: &Path) -> Result<String> {
    update(config_dir, |settings| {
        if settings.client_id.is_empty() {
            settings.client_id = uuid::Uuid::new_v4().to_string();
        }
        Ok(settings.client_id.clone())
    })
}

pub fn finish_lastfm_auth(
    config_dir: &Path,
    started: &PlexSettings,
    session_key: &str,
    username: &str,
) -> Result<()> {
    update(config_dir, |current| {
        if current.lastfm_auth_revision != started.lastfm_auth_revision
            || current.lastfm_api_key != started.lastfm_api_key
            || current.lastfm_api_secret != started.lastfm_api_secret
        {
            anyhow::bail!("Last.fm sign-in was superseded or cancelled");
        }
        current.lastfm_session_key = session_key.into();
        current.lastfm_username = username.into();
        Ok(())
    })
}

pub fn finish_listenbrainz_auth(
    config_dir: &Path,
    revision: u64,
    token: &str,
    username: &str,
) -> Result<()> {
    update(config_dir, |current| {
        if current.listenbrainz_auth_revision != revision {
            anyhow::bail!("ListenBrainz sign-in was superseded or cancelled");
        }
        current.listenbrainz_token = token.into();
        current.listenbrainz_username = username.into();
        current.listenbrainz_enabled = true;
        Ok(())
    })
}

#[cfg(test)]
fn save(config_dir: &Path, settings: &PlexSettings) -> Result<()> {
    let _lock = store_lock(config_dir)?;
    save_locked(config_dir, settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_save_and_load_settings() {
        let dir = tempfile::tempdir().expect("Failed to create temp dir");
        let settings = PlexSettings {
            base_url: "http://test.local:32400".to_string(),
            token: "test-token-abc".to_string(),
            ..Default::default()
        };

        save(dir.path(), &settings).expect("save failed");

        let loaded = load(dir.path()).expect("load failed");
        assert_eq!(loaded.base_url, settings.base_url);
        assert_eq!(loaded.token, settings.token);
    }

    #[test]
    fn test_load_missing_returns_empty_defaults() {
        let dir = tempfile::tempdir().expect("Failed to create temp dir");
        let loaded = load(dir.path()).expect("load failed");
        assert_eq!(
            loaded.base_url, "",
            "base_url should be empty when no settings file exists"
        );
        assert_eq!(
            loaded.token, "",
            "token should be empty when no settings file exists"
        );
    }

    #[test]
    fn test_settings_path() {
        let dir = tempfile::tempdir().expect("Failed to create temp dir");
        let path = settings_path(dir.path());
        assert!(path.ends_with("plex_settings.json"));
    }

    #[test]
    fn test_save_creates_directory() {
        let dir = tempfile::tempdir().expect("Failed to create temp dir");
        let nested = dir.path().join("a").join("b").join("c");
        let settings = PlexSettings {
            base_url: "http://nested.local:32400".to_string(),
            token: "nested-token".to_string(),
            ..Default::default()
        };
        save(&nested, &settings).expect("save should create parent dirs");
        assert!(nested.join("plex_settings.json").exists());
    }

    #[test]
    fn concurrent_updates_keep_unrelated_fields_and_readers_never_observe_partial_json() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Barrier,
        };
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), &PlexSettings::default()).unwrap();
        let ready = Arc::new(Barrier::new(3));
        let stopped = Arc::new(AtomicBool::new(false));
        let path = settings_path(dir.path());
        let done = stopped.clone();
        let observer = std::thread::spawn(move || {
            let mut reads = 0;
            while !done.load(Ordering::Acquire) {
                let bytes = std::fs::read(&path).unwrap();
                serde_json::from_slice::<PlexSettings>(&bytes).unwrap();
                reads += 1;
            }
            reads
        });
        let mut writers = Vec::new();
        for field in 0..2 {
            let root = dir.path().to_path_buf();
            let barrier = ready.clone();
            writers.push(std::thread::spawn(move || {
                barrier.wait();
                for _ in 0..30 {
                    update(&root, |settings| {
                        if field == 0 {
                            settings.section_id += 1;
                        } else {
                            settings.lastfm_love_threshold += 1;
                        }
                        Ok(())
                    })
                    .unwrap();
                }
            }));
        }
        ready.wait();
        for worker in writers {
            worker.join().unwrap();
        }
        stopped.store(true, Ordering::Release);
        assert!(observer.join().unwrap() > 0);
        let settings = load(dir.path()).unwrap();
        assert_eq!(settings.section_id, 30);
        assert_eq!(settings.lastfm_love_threshold, 36);
    }

    #[test]
    fn failed_mutations_and_corrupt_settings_are_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        save(
            dir.path(),
            &PlexSettings {
                token: "dummy-original".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let original = std::fs::read(settings_path(dir.path())).unwrap();
        let result: Result<()> = update(dir.path(), |settings| {
            settings.token = "dummy-new".into();
            anyhow::bail!("rejected")
        });
        assert!(result.is_err());
        assert_eq!(std::fs::read(settings_path(dir.path())).unwrap(), original);
        std::fs::write(settings_path(dir.path()), b"{incomplete").unwrap();
        assert!(update(dir.path(), |_| Ok(())).is_err());
        assert_eq!(
            std::fs::read(settings_path(dir.path())).unwrap(),
            b"{incomplete"
        );
    }

    #[test]
    fn future_fields_survive_updates_and_installation_ids_are_unique_and_stable() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        std::fs::write(
            settings_path(first.path()),
            br#"{"future-setting":{"enabled":true}}"#,
        )
        .unwrap();
        let id = ensure_client_id(first.path()).unwrap();
        assert!(uuid::Uuid::parse_str(&id).is_ok());
        assert_eq!(id, ensure_client_id(first.path()).unwrap());
        assert_ne!(id, ensure_client_id(second.path()).unwrap());
        update(first.path(), |settings| {
            settings.section_id = 42;
            Ok(())
        })
        .unwrap();
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(settings_path(first.path())).unwrap()).unwrap();
        assert_eq!(saved["future-setting"]["enabled"], true);
        assert_eq!(load(first.path()).unwrap().lastfm_love_threshold, 6);
    }

    #[cfg(unix)]
    #[test]
    fn old_and_new_credential_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = settings_path(dir.path());
        std::fs::write(&path, b"{}").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        load(dir.path()).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        update(dir.path(), |settings| {
            settings.token = "dummy-token".into();
            Ok(())
        })
        .unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        for entry in std::fs::read_dir(dir.path()).unwrap() {
            assert_eq!(
                entry.unwrap().metadata().unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn late_service_signins_cannot_restore_disconnected_or_superseded_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let started = update(dir.path(), |settings| {
            settings.lastfm_api_key = "dummy-key".into();
            settings.lastfm_api_secret = "dummy-secret".into();
            settings.lastfm_auth_revision = 1;
            settings.listenbrainz_auth_revision = 1;
            Ok(settings.clone())
        })
        .unwrap();
        update(dir.path(), |settings| {
            settings.lastfm_auth_revision += 1;
            settings.listenbrainz_auth_revision += 1;
            settings.lastfm_session_key.clear();
            settings.listenbrainz_token.clear();
            Ok(())
        })
        .unwrap();
        assert!(
            finish_lastfm_auth(dir.path(), &started, "dummy-late-session", "old-user").is_err()
        );
        assert!(finish_listenbrainz_auth(dir.path(), 1, "dummy-late-token", "old-user").is_err());
        let settings = load(dir.path()).unwrap();
        assert!(settings.lastfm_session_key.is_empty());
        assert!(settings.listenbrainz_token.is_empty());
        finish_lastfm_auth(
            dir.path(),
            &settings,
            "dummy-current-session",
            "current-user",
        )
        .unwrap();
        finish_listenbrainz_auth(dir.path(), 2, "dummy-current-token", "current-user").unwrap();
        let settings = load(dir.path()).unwrap();
        assert_eq!(settings.lastfm_username, "current-user");
        assert_eq!(settings.listenbrainz_username, "current-user");
    }

    #[test]
    fn settings_debug_output_never_contains_credentials_or_unknown_private_fields() {
        let mut settings = PlexSettings {
            token: "dummy-plex-token".into(),
            lastfm_api_secret: "dummy-api-secret".into(),
            lastfm_session_key: "dummy-session".into(),
            genius_client_secret: "dummy-genius-secret".into(),
            listenbrainz_token: "dummy-listenbrainz-token".into(),
            ..Default::default()
        };
        settings
            .extra
            .insert("future-password".into(), "dummy-future-secret".into());
        let text = format!("{settings:?}");
        assert!(!text.contains("dummy-"));
    }

    #[test]
    fn another_process_cannot_mutate_settings_until_the_transaction_lock_is_released() {
        use std::time::{Duration, Instant};
        let dir = tempfile::tempdir().unwrap();
        let lock = store_lock(dir.path()).unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "plex::auth::tests::process_lock_child",
                "--ignored",
            ])
            .env("HIBIKI_SETTINGS_LOCK_CHILD_DIR", dir.path())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !dir.path().join("started").exists() {
            assert!(Instant::now() < deadline, "child did not start");
            std::thread::sleep(Duration::from_millis(10));
        }
        std::thread::sleep(Duration::from_millis(50));
        assert!(!dir.path().join("finished").exists());
        drop(lock);
        assert!(child.wait().unwrap().success());
        assert_eq!(load(dir.path()).unwrap().section_id, 42);
    }

    #[test]
    #[ignore = "subprocess helper, invoked by the settings lock regression"]
    fn process_lock_child() {
        let root = PathBuf::from(
            std::env::var_os("HIBIKI_SETTINGS_LOCK_CHILD_DIR").expect("child directory"),
        );
        std::fs::write(root.join("started"), b"ready").unwrap();
        update(&root, |settings| {
            settings.section_id = 42;
            Ok(())
        })
        .unwrap();
        std::fs::write(root.join("finished"), b"done").unwrap();
    }
}
