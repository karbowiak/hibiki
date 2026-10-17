//! Explicit, per-user downloads. Executables never ship in Hibiki's installer.
use super::*;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tokio::io::AsyncWriteExt;

#[derive(Default)]
pub(super) struct Installer {
    lock: tokio::sync::Mutex<()>,
    progress: Mutex<Option<u8>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Helpers {
    yt_dlp: bool,
    javascript_runtime: bool,
    managed: bool,
    installing: bool,
    progress: Option<u8>,
}

fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join("youtube-music-tools"))
        .map_err(|_| "YouTube Music playback tools folder is unavailable.".into())
}

fn manifest() -> &'static serde_json::Value {
    static MANIFEST: std::sync::LazyLock<serde_json::Value> = std::sync::LazyLock::new(|| {
        serde_json::from_str(include_str!("tools.lock.json"))
            .expect("pinned playback tools manifest")
    });
    &MANIFEST
}

fn filename(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.into()
    }
}

fn managed_path(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let manifest = manifest();
    let version = manifest[if name == "yt-dlp" {
        "ytDlpVersion"
    } else {
        "nodeVersion"
    }]
    .as_str()
    .ok_or("Invalid playback tools version.")?;
    Ok(root(app)?
        .join(format!("{name}-{version}"))
        .join(filename(name)))
}

pub(super) fn executable(app: &tauri::AppHandle, name: &str) -> Option<PathBuf> {
    if let Ok(path) = managed_path(app, name) {
        if path.is_file() {
            return Some(path);
        }
    }
    // Existing tools remain usable during development and before managed setup.
    let mut directories: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    #[cfg(unix)]
    directories.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
    ]);
    directories
        .into_iter()
        .map(|directory| directory.join(filename(name)))
        .find(|path| path.is_file())
}

pub(super) fn status(app: &tauri::AppHandle) -> Helpers {
    let state = app.state::<Arc<YoutubeMusic>>();
    let installing = state.tools.lock.try_lock().is_err();
    let progress = state.tools.progress.lock().ok().and_then(|value| *value);
    Helpers {
        yt_dlp: executable(app, "yt-dlp").is_some(),
        javascript_runtime: executable(app, "node").is_some(),
        managed: ["yt-dlp", "node"]
            .iter()
            .all(|name| managed_path(app, name).is_ok_and(|path| path.is_file())),
        installing,
        progress,
    }
}

fn progress(app: &tauri::AppHandle, value: Option<u8>) {
    if let Ok(mut current) = app.state::<Arc<YoutubeMusic>>().tools.progress.lock() {
        *current = value;
    }
    let _ = app.emit_to("main", "ytmusic://tools", status(app));
}

#[cfg(test)]
fn valid_digest(bytes: &[u8], expected: &str) -> bool {
    hex::encode(Sha256::digest(bytes)) == expected
}

async fn install_one(
    app: &tauri::AppHandle,
    name: &str,
    artifact: &serde_json::Value,
    step: u8,
) -> Result<(), String> {
    let destination = managed_path(app, name)?;
    let directory = root(app)?;
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|_| "Could not create the playback tools folder.")?;
    let temporary = tempfile::Builder::new()
        .prefix(".install-")
        .tempdir_in(&directory)
        .map_err(|_| "Could not prepare the playback tools download.")?;
    let url = artifact["url"]
        .as_str()
        .ok_or("No playback tools download is available for this platform.")?;
    let expected = artifact["sha256"]
        .as_str()
        .ok_or("Missing playback tools checksum.")?;
    let mut response = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(240))
        .build()
        .map_err(|_| "Playback tools download is unavailable.")?
        .get(url)
        .send()
        .await
        .map_err(|_| "Could not download playback tools. Check your connection and retry.")?;
    if !response.status().is_success() {
        return Err("Playback tools download failed. Please retry.".into());
    }
    let total = response.content_length();
    let archive = temporary.path().join("download");
    let mut file = tokio::fs::File::create(&archive)
        .await
        .map_err(|_| "Could not save playback tools.")?;
    let mut size = 0u64;
    let mut hash = Sha256::new();
    let mut previous = None;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Playback tools download was interrupted. Please retry.")?
    {
        size += chunk.len() as u64;
        if size > 160 * 1024 * 1024 {
            return Err("Playback tools download exceeded its size limit.".into());
        }
        hash.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|_| "Could not save playback tools.")?;
        let current = total
            .filter(|total| *total > 0)
            .map(|total| step * 50 + (size.saturating_mul(50) / total).min(49) as u8);
        if previous != current {
            progress(app, current);
            previous = current;
        }
    }
    file.flush()
        .await
        .map_err(|_| "Could not save playback tools.")?;
    drop(file);
    if hex::encode(hash.finalize()) != expected {
        return Err("Playback tools checksum did not match. Please retry the download.".into());
    }
    let binary = temporary.path().join(filename(name));
    if let Some(member) = artifact["member"].as_str() {
        // Only the pinned Node executable is extracted, never archive-provided paths.
        let mut command = tokio::process::Command::new("tar");
        command
            .arg("-xzf")
            .arg(&archive)
            .arg("-C")
            .arg(temporary.path())
            .arg("--strip-components=2")
            .arg(member);
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let status = tokio::time::timeout(std::time::Duration::from_secs(30), command.status())
            .await
            .map_err(|_| "Unpacking playback tools timed out.")?
            .map_err(|_| "Could not unpack playback tools. The system tar utility is required.")?;
        if !status.success() {
            return Err("Could not unpack the playback runtime.".into());
        }
    } else {
        tokio::fs::rename(&archive, &binary)
            .await
            .map_err(|_| "Could not prepare the playback executable.")?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700))
            .await
            .map_err(|_| "Could not enable the playback executable.")?;
    }
    // Verify it starts before publishing this version for playback.
    let mut command = tokio::process::Command::new(&binary);
    command
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let status = tokio::time::timeout(std::time::Duration::from_secs(15), command.status())
        .await
        .map_err(|_| "Playback tool verification timed out.")?
        .map_err(|_| "The downloaded playback tool could not start on this device.")?;
    if !status.success() {
        return Err("The downloaded playback tool could not run on this device.".into());
    }
    tokio::fs::create_dir_all(
        destination
            .parent()
            .ok_or("Invalid playback tools folder.")?,
    )
    .await
    .map_err(|_| "Could not install playback tools.")?;
    if cfg!(windows) && destination.is_file() {
        tokio::fs::remove_file(&destination).await.map_err(|_| {
            "Could not replace playback tools. Finish the current playback and retry."
        })?;
    }
    tokio::fs::rename(&binary, &destination)
        .await
        .map_err(|_| "Could not finish installing playback tools.")?;
    Ok(())
}

pub(super) async fn install(app: &tauri::AppHandle) -> Result<Helpers, String> {
    let state = app.state::<Arc<YoutubeMusic>>();
    let guard = state
        .tools
        .lock
        .try_lock()
        .map_err(|_| "Playback tools are already downloading.")?;
    // Do not replace executables while an extractor process is using them.
    let extraction = state.extraction.lock().await;
    progress(app, Some(0));
    let result = async {
        let manifest = manifest();
        let artifacts = &manifest["targets"][env!("TAURI_ENV_TARGET_TRIPLE")];
        if artifacts.is_null() {
            return Err("Playback tool downloads are not available for this platform yet.".into());
        }
        install_one(app, "yt-dlp", &artifacts["ytDlp"], 0).await?;
        install_one(app, "node", &artifacts["node"], 1).await?;
        Ok::<_, String>(())
    }
    .await;
    drop(guard);
    drop(extraction);
    progress(app, None);
    result?;
    Ok(status(app))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tool_downloads_are_pinned_and_corrupt_bytes_are_rejected() {
        let manifest = manifest();
        for artifacts in manifest["targets"].as_object().unwrap().values() {
            for name in ["ytDlp", "node"] {
                let artifact = &artifacts[name];
                let url = url::Url::parse(artifact["url"].as_str().unwrap()).unwrap();
                assert_eq!(url.scheme(), "https");
                assert!(matches!(url.host_str(), Some("github.com" | "nodejs.org")));
                assert_eq!(artifact["sha256"].as_str().unwrap().len(), 64);
                assert!(!valid_digest(
                    b"corrupt download",
                    artifact["sha256"].as_str().unwrap()
                ));
            }
        }
        assert!(valid_digest(
            b"verified",
            &hex::encode(Sha256::digest(b"verified"))
        ));
    }
}
