//! System-wide Now Playing integration via souvlaki.
//!
//! A dedicated background thread owns the `MediaControls` handle.
//! Tauri commands send updates through a bounded crossbeam channel.
//!
//! Platform support:
//! - macOS : MPRemoteCommandCenter + MPNowPlayingInfoCenter
//! - Windows: System Media Transport Controls (SMTC)
//! - Linux  : MPRIS2 via D-Bus

use crossbeam_channel::{bounded, Sender};
use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Messages sent from Tauri commands to the background souvlaki thread.
pub enum MediaUpdate {
    Metadata {
        title: String,
        artist: String,
        album: String,
        /// Full authenticated Plex thumbnail URL, built by the Rust command.
        cover_url: Option<String>,
        duration_ms: u64,
    },
    Playing {
        position_ms: u64,
    },
    Paused {
        position_ms: u64,
    },
    Stopped,
}

/// Tauri-managed state: sender half of the channel to the background thread.
pub struct MediaSessionState(pub Sender<MediaUpdate>);

impl MediaSessionState {
    /// Initialise system media controls and return the managed state.
    ///
    /// Spawns a background thread that owns the `MediaControls` instance.
    /// Media-key events from the OS are forwarded to the frontend as Tauri events.
    pub fn start<R: Runtime>(app: &AppHandle<R>) -> Self {
        let (tx, rx) = bounded::<MediaUpdate>(64);

        // Capture what we need before the thread move.
        let app_handle = app.clone();

        // On Windows souvlaki requires a window handle to attach SMTC.
        // Grab it on this thread (setup = main thread) before spawning.
        #[cfg(target_os = "windows")]
        let hwnd_isize: isize = app
            .get_webview_window("main")
            .and_then(|w| w.hwnd().ok())
            .map(|h| h.0)
            .unwrap_or(0);
        #[cfg(not(target_os = "windows"))]
        let hwnd_isize: isize = 0;

        std::thread::Builder::new()
            .name("media-session".into())
            .spawn(move || {
                let hwnd = if hwnd_isize != 0 {
                    Some(hwnd_isize as *mut std::ffi::c_void)
                } else {
                    None
                };

                let config = PlatformConfig {
                    dbus_name: "plexify",
                    display_name: "Plexify",
                    hwnd,
                };

                let mut controls = match MediaControls::new(config) {
                    Ok(c) => c,
                    Err(e) => {
                        tracing::error!("MediaControls::new failed: {:?}", e);
                        return;
                    }
                };

                // Forward OS media-key events to the frontend.
                controls
                    .attach(move |event: MediaControlEvent| {
                        match event {
                            MediaControlEvent::Play
                            | MediaControlEvent::Pause
                            | MediaControlEvent::Toggle => {
                                app_handle.emit("media://play-pause", ()).ok();
                            }
                            MediaControlEvent::Next => {
                                app_handle.emit("media://next", ()).ok();
                            }
                            MediaControlEvent::Previous => {
                                app_handle.emit("media://previous", ()).ok();
                            }
                            MediaControlEvent::Stop => {
                                app_handle.emit("media://stop", ()).ok();
                            }
                            MediaControlEvent::SetPosition(pos) => {
                                app_handle
                                    .emit("media://seek", pos.0.as_millis() as u64)
                                    .ok();
                            }
                            _ => {}
                        }
                    })
                    .ok();

                // Process metadata/playback updates from Tauri commands.
                while let Ok(update) = rx.recv() {
                    match update {
                        MediaUpdate::Metadata {
                            title,
                            artist,
                            album,
                            cover_url,
                            duration_ms,
                        } => {
                            controls
                                .set_metadata(MediaMetadata {
                                    title: Some(title.as_str()),
                                    artist: Some(artist.as_str()),
                                    album: Some(album.as_str()),
                                    cover_url: cover_url.as_deref(),
                                    duration: Some(Duration::from_millis(duration_ms)),
                                })
                                .ok();
                        }
                        MediaUpdate::Playing { position_ms } => {
                            controls
                                .set_playback(MediaPlayback::Playing {
                                    progress: Some(MediaPosition(Duration::from_millis(
                                        position_ms,
                                    ))),
                                })
                                .ok();
                        }
                        MediaUpdate::Paused { position_ms } => {
                            controls
                                .set_playback(MediaPlayback::Paused {
                                    progress: Some(MediaPosition(Duration::from_millis(
                                        position_ms,
                                    ))),
                                })
                                .ok();
                        }
                        MediaUpdate::Stopped => {
                            controls.set_playback(MediaPlayback::Stopped).ok();
                        }
                    }
                }
            })
            .expect("Failed to spawn media-session thread");

        Self(tx)
    }
}
