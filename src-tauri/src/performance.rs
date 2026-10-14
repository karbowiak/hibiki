//! Development-only, bounded local timings. Never record request arguments,
//! library identities, URLs, SQL parameters, metadata or error strings.
use serde::{Deserialize, Serialize};
use std::time::Instant;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Event {
    operation: String,
    phase: String,
    duration_ms: f64,
}
fn valid(event: &Event) -> bool {
    [&event.operation, &event.phase].iter().all(|name| {
        !name.is_empty()
            && name.len() <= 64
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.')
    }) && event.duration_ms.is_finite()
        && (0.0..=3_600_000.0).contains(&event.duration_ms)
}

#[cfg(debug_assertions)]
static SINK: std::sync::OnceLock<std::sync::mpsc::SyncSender<Event>> = std::sync::OnceLock::new();

pub fn initialize(directory: &std::path::Path) {
    #[cfg(debug_assertions)]
    {
        use std::io::Write;
        if crate::cache_files::directory_id(directory).is_none() || SINK.get().is_some() {
            return;
        }
        let path = directory.join(format!("performance-{}.jsonl", uuid::Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let Ok(mut file) = options.open(path) else {
            return;
        };
        let (sender, receiver) = std::sync::mpsc::sync_channel::<Event>(4096);
        if SINK.set(sender).is_err() {
            return;
        }
        // Logging never blocks an async worker or grows without bound. A
        // session stops recording after 4 MiB; release builds create no file.
        let _ = std::thread::Builder::new()
            .name("performance-log".into())
            .spawn(move || {
                let mut bytes = 0usize;
                for event in receiver {
                    let Ok(mut line) = serde_json::to_vec(&event) else {
                        continue;
                    };
                    line.push(b'\n');
                    bytes += line.len();
                    if bytes > 4 * 1024 * 1024 {
                        break;
                    }
                    if file.write_all(&line).is_err() {
                        break;
                    }
                }
            });
    }
    #[cfg(not(debug_assertions))]
    let _ = directory;
}
pub fn record(operation: &str, phase: &str, duration_ms: f64) {
    #[cfg(debug_assertions)]
    if let Some(sender) = SINK.get() {
        let event = Event {
            operation: operation.into(),
            phase: phase.into(),
            duration_ms,
        };
        if valid(&event) {
            let _ = sender.try_send(event);
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = (operation, phase, duration_ms);
}

pub struct Timer {
    #[cfg(debug_assertions)]
    operation: String,
    #[cfg(debug_assertions)]
    start: Instant,
    #[cfg(debug_assertions)]
    previous: Instant,
}
impl Timer {
    pub fn new(operation: &str) -> Self {
        #[cfg(debug_assertions)]
        {
            Self {
                operation: operation.into(),
                start: Instant::now(),
                previous: Instant::now(),
            }
        }
        #[cfg(not(debug_assertions))]
        {
            let _ = operation;
            Self {}
        }
    }
    pub fn phase(&mut self, phase: &str) {
        #[cfg(debug_assertions)]
        {
            record(
                &self.operation,
                phase,
                self.previous.elapsed().as_secs_f64() * 1000.0,
            );
            self.previous = Instant::now();
        }
        #[cfg(not(debug_assertions))]
        let _ = phase;
    }
}
impl Drop for Timer {
    fn drop(&mut self) {
        #[cfg(debug_assertions)]
        record(
            &self.operation,
            "total",
            self.start.elapsed().as_secs_f64() * 1000.0,
        );
    }
}

#[tauri::command]
pub fn record_performance(events: Vec<Event>) -> Result<(), String> {
    if events.len() > 128 || events.iter().any(|e| !valid(e)) {
        return Err("Invalid performance timing batch".into());
    }
    for event in events {
        record(&event.operation, &event.phase, event.duration_ms);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn timings_reject_payloads_and_unbounded_values() {
        let event = |name: &str, ms| Event {
            operation: name.into(),
            phase: "sql".into(),
            duration_ms: ms,
        };
        assert!(valid(&event("getLikedTracks", 0.0)));
        for name in [
            "",
            "Artist - Title",
            "https://server/path?token=secret",
            "SELECT * FROM tracks",
        ] {
            assert!(!valid(&event(name, 1.0)));
        }
        for ms in [-1.0, f64::NAN, f64::INFINITY, 3_600_001.0] {
            assert!(!valid(&event("query", ms)));
        }
        assert!(record_performance((0..129).map(|_| event("query", 1.0)).collect()).is_err());
    }
}
