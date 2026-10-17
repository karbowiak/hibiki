//! Fit the first window to the usable desktop, then respect saved geometry.
use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewWindow};
use tauri_plugin_window_state::{AppHandleExt, StateFlags, WindowExt};

#[derive(Clone, Copy, Debug, PartialEq)]
struct Rect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Debug, PartialEq)]
struct Placement {
    outer: Rect,
    inner_width: u32,
    inner_height: u32,
    minimum_width: u32,
    minimum_height: u32,
}

fn intersection(a: Rect, b: Rect) -> u64 {
    let width = (i64::from(a.x) + i64::from(a.width)).min(i64::from(b.x) + i64::from(b.width))
        - i64::from(a.x).max(i64::from(b.x));
    let height = (i64::from(a.y) + i64::from(a.height)).min(i64::from(b.y) + i64::from(b.height))
        - i64::from(a.y).max(i64::from(b.y));
    width.max(0) as u64 * height.max(0) as u64
}

fn placement(work: Rect, scale: f64, frame: (u32, u32), saved: Option<Rect>) -> Placement {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let pixels = |logical: f64| (logical * scale).round() as u32;
    // Leave the desktop edges accessible, including on a small work area.
    let margin = pixels(16.0).min(work.width / 20).min(work.height / 20);
    let available_width = work.width.saturating_sub(margin * 2).max(1);
    let available_height = work.height.saturating_sub(margin * 2).max(1);
    let max_width = available_width.saturating_sub(frame.0).max(1);
    let max_height = available_height.saturating_sub(frame.1).max(1);
    let minimum_width = pixels(800.0).min(max_width);
    let minimum_height = pixels(600.0).min(max_height);
    // The user's approved desktop window, measured in logical desktop points.
    let preferred_width = pixels(1940.0);
    let preferred_height = pixels(1214.0);
    let width = saved
        .map_or(preferred_width, |r| r.width.saturating_sub(frame.0))
        .clamp(minimum_width, max_width);
    let height = saved
        .map_or(preferred_height, |r| r.height.saturating_sub(frame.1))
        .clamp(minimum_height, max_height);
    let outer_width = width.saturating_add(frame.0).min(available_width);
    let outer_height = height.saturating_add(frame.1).min(available_height);
    let left = i64::from(work.x) + i64::from(margin);
    let top = i64::from(work.y) + i64::from(margin);
    let right = i64::from(work.x) + i64::from(work.width) - i64::from(margin + outer_width);
    let bottom = i64::from(work.y) + i64::from(work.height) - i64::from(margin + outer_height);
    let x = saved
        .map_or(left + (right - left) / 2, |r| i64::from(r.x))
        .clamp(left, right);
    let y = saved
        .map_or(top + (bottom - top) / 2, |r| i64::from(r.y))
        .clamp(top, bottom);
    Placement {
        outer: Rect {
            x: x as i32,
            y: y as i32,
            width: outer_width,
            height: outer_height,
        },
        inner_width: width,
        inner_height: height,
        minimum_width,
        minimum_height,
    }
}

fn has_saved_geometry(window: &WebviewWindow) -> bool {
    let app = window.app_handle();
    let Ok(directory) = app.path().app_config_dir() else {
        return false;
    };
    let path = directory.join(app.filename());
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    use std::io::Read;
    let mut bytes = Vec::new();
    if file.take(256 * 1024).read_to_end(&mut bytes).is_err() {
        return false;
    }
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return false;
    };
    let Some(state) = value.get(window.label()) else {
        return false;
    };
    state
        .get("width")
        .and_then(|v| v.as_u64())
        .is_some_and(|v| v > 0)
        && state
            .get("height")
            .and_then(|v| v.as_u64())
            .is_some_and(|v| v > 0)
}

pub fn restore(window: &WebviewWindow) -> tauri::Result<()> {
    let saved = has_saved_geometry(window);
    // Restore once, without allowing the plugin to show a misplaced window.
    if let Err(error) = window.restore_state(StateFlags::all() & !StateFlags::VISIBLE) {
        tracing::warn!("Saved window state could not be fully restored: {error}");
    }
    let inner = window.inner_size()?;
    let outer = window.outer_size()?;
    let position = window
        .outer_position()
        .unwrap_or(PhysicalPosition::new(0, 0));
    let current = Rect {
        x: position.x,
        y: position.y,
        width: outer.width,
        height: outer.height,
    };
    let monitors = window.available_monitors()?;
    let preferred = window.current_monitor()?.or(window.primary_monitor()?);
    let monitor = monitors
        .iter()
        .filter(|m| {
            intersection(
                current,
                Rect {
                    x: m.work_area().position.x,
                    y: m.work_area().position.y,
                    width: m.work_area().size.width,
                    height: m.work_area().size.height,
                },
            ) > 0
        })
        .max_by_key(|m| {
            intersection(
                current,
                Rect {
                    x: m.work_area().position.x,
                    y: m.work_area().position.y,
                    width: m.work_area().size.width,
                    height: m.work_area().size.height,
                },
            )
        })
        .or(preferred.as_ref());
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let area = monitor.work_area();
    let plan = placement(
        Rect {
            x: area.position.x,
            y: area.position.y,
            width: area.size.width,
            height: area.size.height,
        },
        monitor.scale_factor(),
        (
            outer.width.saturating_sub(inner.width),
            outer.height.saturating_sub(inner.height),
        ),
        saved.then_some(current),
    );
    window.set_min_size(Some(PhysicalSize::new(
        plan.minimum_width,
        plan.minimum_height,
    )))?;
    if !window.is_maximized()? && !window.is_fullscreen()? {
        window.set_size(PhysicalSize::new(plan.inner_width, plan.inner_height))?;
        // Some compositors choose placement themselves; sizing must still work.
        let _ = window.set_position(PhysicalPosition::new(plan.outer.x, plan.outer.y));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn area(width: u32, height: u32) -> Rect {
        Rect {
            x: 0,
            y: 24,
            width,
            height,
        }
    }

    #[test]
    fn first_start_uses_a_comfortable_size_inside_the_work_area() {
        let p = placement(area(2560, 1400), 1.0, (0, 28), None);
        assert_eq!((p.inner_width, p.inner_height), (1940, 1214));
        assert!(p.outer.y >= 40 && p.outer.y + p.outer.height as i32 <= 1408);
    }

    #[test]
    fn small_desktop_clamps_both_initial_and_minimum_size() {
        let p = placement(area(1024, 700), 1.0, (16, 32), None);
        assert_eq!((p.inner_width, p.inner_height), (976, 636));
        assert_eq!((p.minimum_width, p.minimum_height), (800, 600));
        assert_eq!(p.outer.x, 16);
        assert_eq!(p.outer.y, 40);
    }

    #[test]
    fn retina_and_negative_monitor_coordinates_use_physical_pixels() {
        let work = Rect {
            x: -3024,
            y: 50,
            width: 3024,
            height: 1914,
        };
        let p = placement(work, 2.0, (0, 0), None);
        assert_eq!((p.inner_width, p.inner_height), (2960, 1850));
        assert!(p.outer.x >= -2992 && p.outer.x + p.outer.width as i32 <= -32);
    }

    #[test]
    fn valid_user_bounds_are_preserved() {
        let saved = Rect {
            x: 180,
            y: 150,
            width: 1280,
            height: 850,
        };
        assert_eq!(
            placement(area(1920, 1080), 1.0, (0, 28), Some(saved)).outer,
            saved
        );
    }

    #[test]
    fn deliberately_smaller_usable_window_is_not_reset_on_restart() {
        let saved = Rect {
            x: 120,
            y: 100,
            width: 900,
            height: 650,
        };
        assert_eq!(
            placement(area(1920, 1080), 1.0, (0, 28), Some(saved)).outer,
            saved
        );
    }

    #[test]
    fn disconnected_display_and_oversize_restore_are_reachable() {
        let p = placement(
            area(1440, 860),
            1.0,
            (0, 28),
            Some(Rect {
                x: 4000,
                y: -1500,
                width: 3000,
                height: 2000,
            }),
        );
        assert_eq!(
            p.outer,
            Rect {
                x: 16,
                y: 40,
                width: 1408,
                height: 828
            }
        );
        assert_eq!(
            intersection(p.outer, area(1440, 860)),
            u64::from(1408u32) * 828
        );
    }
}
