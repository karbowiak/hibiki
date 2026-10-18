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
    pub id: String,
    pub stable: bool,
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputIdentity {
    pub id: String,
    pub name: String,
    pub stable: bool,
    /// Native stream incarnation, serialized losslessly for JavaScript.
    pub key: String,
    pub available: bool,
}

pub fn identity(device: &cpal::Device) -> OutputIdentity {
    let name = device.description().map(|description| description.name().to_owned())
        .unwrap_or_else(|_| "System default".into());
    let native = device.id().ok().map(|id| id.to_string()).filter(|id| !id.is_empty());
    let stable = native.as_deref().is_some_and(stable_id);
    OutputIdentity { id: native.unwrap_or_else(|| format!("name:{name}")), name,
        stable, key: "0".into(), available: false }
}

fn stable_id(id: &str) -> bool {
    // ALSA aliases follow the system route, rather than a physical endpoint.
    let value = id.to_ascii_lowercase();
    if let Some(pcm) = value.strip_prefix("alsa:") {
        if pcm.strip_prefix("hw:").or_else(|| pcm.strip_prefix("plughw:"))
            .is_some_and(|card| card.starts_with(|ch: char| ch.is_ascii_digit())) { return false; }
    }
    !["default", "pulse", "pipewire", "sysdefault"].iter().any(|alias|
        value == *alias || value.ends_with(&format!(":{alias}")))
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
    let default_id = host.default_output_device().map(|device| identity(&device).id);

    let mut devices: Vec<AudioOutputDevice> = host
        .output_devices()
        .map(|iter| {
            iter.map(|d| {
                    let output = identity(&d);
                    AudioOutputDevice {
                        is_default: default_id.as_deref() == Some(&output.id),
                        id: output.id, stable: output.stable, name: output.name,
                    }
            })
            .collect()
        })
        .unwrap_or_default();

    if devices.is_empty() {
        devices.push(AudioOutputDevice {
            id: "unavailable".into(), stable: false,
            name: "System default".to_string(),
            is_default: true,
        });
    }

    devices
}

#[cfg(test)]
mod tests {
    #[test]
    fn route_aliases_are_not_treated_as_physical_headphone_identities() {
        for id in ["alsa:default", "alsa:pipewire", "default", "alsa:pulse", "alsa:hw:0,0", "alsa:plughw:1,0"] {
            assert!(!super::stable_id(id));
        }
        assert!(super::stable_id("coreaudio:AppleUSBAudioEngine:manufacturer:serial:1"));
        assert!(super::stable_id("alsa:hw:CARD=USB,DEV=0"));
    }
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
