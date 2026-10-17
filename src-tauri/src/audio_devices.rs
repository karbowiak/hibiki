//! Cross-platform audio output device detection via cpal.
//!
//! - `get_default_output_device_name()` — returns the current default output device name
//! - `get_output_devices()` — lists all output-capable devices
//! - `start_device_listener()` — polls for default device changes and emits
//!   `audio-device-changed` Tauri events when the device switches

use cpal::traits::{DeviceTrait, HostTrait};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct AudioOutputDevice {
    pub name: String,
    pub is_default: bool,
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/// Returns the name of the current default output device.
pub fn get_default_output_device_name() -> String {
    let host = cpal::default_host();
    host.default_output_device()
        .and_then(|device| {
            device.description().ok().map(|description| description.name().to_owned())
        })
        .unwrap_or_else(|| "System default".to_string())
}

/// Lists all available audio output devices.
pub fn get_output_devices() -> Vec<AudioOutputDevice> {
    let host = cpal::default_host();
    let default_name = host
        .default_output_device()
        .and_then(|device| {
            device.description().ok().map(|description| description.name().to_owned())
        });

    let mut devices: Vec<AudioOutputDevice> = host
        .output_devices()
        .map(|iter| {
            iter.filter_map(|d| {
                d.description().ok().map(|description| {
                    let name = description.name().to_owned();
                    AudioOutputDevice {
                        is_default: default_name.as_deref() == Some(&name),
                        name,
                    }
                })
            })
            .collect()
        })
        .unwrap_or_default();

    if devices.is_empty() {
        devices.push(AudioOutputDevice {
            name: "System default".to_string(),
            is_default: true,
        });
    }

    devices
}

// ---------------------------------------------------------------------------
// Device change listener (poll-based, works on all platforms)
// ---------------------------------------------------------------------------

static LISTENER_RUNNING: AtomicBool = AtomicBool::new(false);
static LISTENER_APP: Mutex<Option<tauri::AppHandle>> = Mutex::new(None);

/// Starts a background thread that polls the default output device every 2s.
/// When a change is detected, emits `audio-device-changed` with the new device name.
pub fn start_device_listener(app: &tauri::AppHandle) {
    if LISTENER_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Ok(mut guard) = LISTENER_APP.lock() {
        *guard = Some(app.clone());
    }

    std::thread::Builder::new()
        .name("audio-device-poll".into())
        .spawn(|| {
            let mut last_name = get_default_output_device_name();
            loop {
                std::thread::sleep(Duration::from_secs(2));
                let current = get_default_output_device_name();
                if current != last_name {
                    last_name = current.clone();
                    if let Ok(guard) = LISTENER_APP.lock() {
                        if let Some(ref app) = *guard {
                            use tauri::Emitter;
                            let _ = app.emit("audio-device-changed", &current);
                        }
                    }
                }
            }
        })
        .ok();
}
