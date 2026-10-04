//! Bounded, deterministic tiling in logical points. Native Cocoa frames avoid
//! asynchronous DPI changes when moving windows between different displays.
use crate::window_geometry::Geometry;

/// Areas are ordered current-display first; coordinates use Cocoa's bottom-left
/// origin. Returned slots are ordered visually left-to-right, top-to-bottom.
fn plan(areas: &[Geometry], count: usize, minimum: (f64, f64)) -> Vec<Geometry> {
    let mut slots = Vec::new();
    if !minimum.0.is_finite() || !minimum.1.is_finite() || minimum.0 <= 0.0 || minimum.1 <= 0.0 {
        return slots;
    }
    for area in areas.iter().filter(|area| area.valid()) {
        let columns = (area.width / minimum.0).floor().min(3.0) as usize;
        let rows = (area.height / minimum.1).floor().min(3.0) as usize;
        let n = (count - slots.len()).min(columns * rows);
        if n == 0 {
            continue;
        }
        // Prefer a roughly square layout (two columns for three windows),
        // constrained by native minimum sizes and the display's capacity.
        let cols = (1..=columns)
            .find(|cols| cols * cols >= n)
            .unwrap_or(columns)
            .max(n.div_ceil(rows));
        let width = area.width / cols as f64;
        let mut display_slots = Vec::with_capacity(n);
        for col in 0..cols {
            // Put fewer, taller windows on the left. Each column independently
            // fills the work area's height, so partial grids leave no holes.
            let column_rows = n / cols + usize::from(col >= cols - n % cols);
            let height = area.height / column_rows as f64;
            for row in 0..column_rows {
                display_slots.push((
                    row as f64 / column_rows as f64,
                    Geometry {
                        x: area.x + col as f64 * width,
                        y: area.y + area.height - (row + 1) as f64 * height,
                        width,
                        height,
                    },
                ));
            }
        }
        // Preserve visual row-major order, including unequal-height columns.
        display_slots.sort_by(|(a_top, a), (b_top, b)| {
            a_top.total_cmp(b_top).then_with(|| a.x.total_cmp(&b.x))
        });
        slots.extend(display_slots.into_iter().map(|(_, slot)| slot));
        if slots.len() == count {
            break;
        }
    }
    slots
}

#[cfg(target_os = "macos")]
pub(crate) fn setup(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    const ID: &str = "pix-tile-windows";
    // Preserve all standard macOS editing/services/quit items.
    let menu = Menu::default(app.handle())?;
    if let Some(submenu) = menu.items()?.first().and_then(|item| item.as_submenu()) {
        submenu.insert(
            &MenuItem::with_id(app, ID, "Разложить окна", true, None::<&str>)?,
            2,
        )?;
        submenu.insert(&PredefinedMenuItem::separator(app)?, 3)?;
    }
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id().as_ref() == ID {
            let handle = app.clone();
            if let Err(error) = app.run_on_main_thread(move || native::arrange(&handle)) {
                eprintln!("failed to arrange Pix windows: {error}");
            }
        }
    });
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn setup(_app: &tauri::App) -> tauri::Result<()> {
    Ok(())
}

#[cfg(target_os = "macos")]
mod native {
    use super::{plan, Geometry};
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSScreen, NSWindow, NSWindowStyleMask};
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    use tauri::Manager;

    pub(super) fn arrange(app: &tauri::AppHandle) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let native_app = NSApplication::sharedApplication(mtm);
        let key = native_app.keyWindow().or_else(|| native_app.mainWindow());
        let mut windows = app.webview_windows().into_iter().collect::<Vec<_>>();
        // HashMap iteration must not determine the order of the other windows.
        windows.sort_by(|a, b| a.0.cmp(&b.0));
        let windows = windows
            .iter()
            .filter_map(|(label, window)| {
                let pointer = window.ns_window().ok()?;
                // SAFETY: the WebviewWindow remains owned by `windows` for this
                // synchronous main-thread operation. Never retain the raw pointer.
                let native = unsafe { pointer.cast::<NSWindow>().as_ref() }?;
                // Fullscreen windows occupy separate Spaces; do not trigger an
                // asynchronous transition or resize them while it is in progress.
                if native.styleMask().contains(NSWindowStyleMask::FullScreen) {
                    return None;
                }
                Some((label, native))
            })
            .collect::<Vec<_>>();
        let mut windows = windows;
        if let Some(index) = windows
            .iter()
            .position(|(_, window)| key.as_deref() == Some(*window))
        {
            let active = windows.remove(index);
            windows.insert(0, active);
        }
        let Some((_, active)) = windows.first() else {
            return;
        };
        let current = active.screen();
        let screens = NSScreen::screens(mtm);
        let mut screens = screens.iter().collect::<Vec<_>>();
        if let Some(index) = screens
            .iter()
            .position(|screen| current.as_deref() == Some(&**screen))
        {
            let screen = screens.remove(index);
            screens.insert(0, screen);
        }
        let areas = screens
            .iter()
            .map(|screen| {
                let frame = screen.visibleFrame();
                Geometry {
                    x: frame.origin.x,
                    y: frame.origin.y,
                    width: frame.size.width,
                    height: frame.size.height,
                }
            })
            .collect::<Vec<_>>();
        let config = app.config().app.windows.first();
        let min_width = config.and_then(|config| config.min_width).unwrap_or(860.0);
        let min_height = config.and_then(|config| config.min_height).unwrap_or(380.0);
        // Native minimums constrain content; tiles contain the entire frame.
        let minimum = windows
            .iter()
            .fold((min_width, min_height), |minimum, (_, window)| {
                let frame = window.frameRectForContentRect(NSRect::new(
                    NSPoint::new(0.0, 0.0),
                    NSSize::new(min_width, min_height),
                ));
                (
                    minimum.0.max(frame.size.width),
                    minimum.1.max(frame.size.height),
                )
            });
        let slots = plan(&areas, windows.len(), minimum);
        for ((_, window), slot) in windows.iter().zip(&slots) {
            if window.isMiniaturized() {
                window.deminiaturize(None);
            }
            if window.isZoomed() {
                window.zoom(None);
            }
            window.setFrame_display(
                NSRect::new(
                    NSPoint::new(slot.x, slot.y),
                    NSSize::new(slot.width, slot.height),
                ),
                true,
            );
        }
        // Deminiaturizing other windows must not steal the user's active window.
        if !slots.is_empty() {
            active.makeKeyAndOrderFront(None);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn area(x: f64, y: f64, width: f64, height: f64) -> Geometry {
        Geometry {
            x,
            y,
            width,
            height,
        }
    }
    const MIN: (f64, f64) = (860.0, 380.0);

    #[test]
    fn two_and_four_windows_use_horizontal_and_square_grids() {
        let screen = area(0.0, 25.0, 1800.0, 1000.0);
        assert_eq!(
            plan(&[screen], 2, MIN),
            vec![
                area(0.0, 25.0, 900.0, 1000.0),
                area(900.0, 25.0, 900.0, 1000.0)
            ]
        );
        assert_eq!(
            plan(&[screen], 4, MIN),
            vec![
                area(0.0, 525.0, 900.0, 500.0),
                area(900.0, 525.0, 900.0, 500.0),
                area(0.0, 25.0, 900.0, 500.0),
                area(900.0, 25.0, 900.0, 500.0)
            ]
        );
    }

    #[test]
    fn fills_current_then_second_then_third_leaving_overflow_unassigned() {
        let screens = [
            area(0.0, 0.0, 1800.0, 800.0),
            area(-1200.0, 50.0, 1200.0, 800.0),
            area(0.0, -900.0, 1200.0, 800.0),
        ];
        let slots = plan(&screens, 10, MIN);
        assert_eq!(slots.len(), 8);
        assert_eq!(slots[4], area(-1200.0, 450.0, 1200.0, 400.0));
        assert_eq!(slots[6], area(0.0, -500.0, 1200.0, 400.0));
    }

    #[test]
    fn three_windows_use_tall_left_and_stacked_right_tiles() {
        for width in [1800.0, 2700.0] {
            let half = width / 2.0;
            assert_eq!(
                plan(&[area(-900.0, 25.0, width, 1200.0)], 3, MIN),
                vec![
                    area(-900.0, 25.0, half, 1200.0),
                    area(-900.0 + half, 625.0, half, 600.0),
                    area(-900.0 + half, 25.0, half, 600.0),
                ]
            );
        }
    }

    #[test]
    fn partial_last_display_is_filled_and_repeated_layout_is_stable() {
        let screens = [
            area(0.0, 0.0, 1800.0, 800.0),
            area(-2700.0, -1200.0, 2700.0, 1200.0),
        ];
        let slots = plan(&screens, 7, MIN);
        assert_eq!(slots, plan(&screens, 7, MIN));
        assert_eq!(slots.len(), 7);
        assert_eq!(slots[4], area(-2700.0, -1200.0, 1350.0, 1200.0));
        assert_eq!(slots[5], area(-1350.0, -600.0, 1350.0, 600.0));
        assert_eq!(slots[6], area(-1350.0, -1200.0, 1350.0, 600.0));
    }

    #[test]
    fn narrow_and_short_displays_use_full_height_or_width_strips() {
        let vertical = plan(&[area(0.0, 0.0, 1000.0, 1200.0)], 3, MIN);
        assert_eq!(vertical.len(), 3);
        assert!(vertical
            .iter()
            .all(|slot| slot.width == 1000.0 && slot.height == 400.0));
        let horizontal = plan(&[area(0.0, 0.0, 2700.0, 400.0)], 3, MIN);
        assert_eq!(horizontal.len(), 3);
        assert!(horizontal
            .iter()
            .all(|slot| slot.width == 900.0 && slot.height == 400.0));
    }

    #[test]
    fn nine_windows_require_enough_logical_space_and_are_row_major() {
        let slots = plan(&[area(0.0, 0.0, 2700.0, 1200.0)], 9, MIN);
        assert_eq!(slots.len(), 9);
        assert_eq!(slots[0], area(0.0, 800.0, 900.0, 400.0));
        assert_eq!(slots[8], area(1800.0, 0.0, 900.0, 400.0));
        assert_eq!(plan(&[area(0.0, 0.0, 1440.0, 900.0)], 9, MIN).len(), 2);
    }

    #[test]
    fn unusable_areas_and_empty_requests_do_not_move_any_windows() {
        assert!(plan(&[area(0.0, 0.0, 800.0, 1000.0)], 2, MIN).is_empty());
        assert!(plan(&[area(0.0, 0.0, f64::NAN, 1000.0)], 2, MIN).is_empty());
        assert!(plan(&[area(0.0, 0.0, 1800.0, 1000.0)], 0, MIN).is_empty());
        assert!(plan(&[area(0.0, 0.0, 1800.0, 1000.0)], 2, (0.0, 380.0)).is_empty());
    }

    #[test]
    fn allocated_tiles_fill_work_area_without_overlap_or_undersizing() {
        for width in [859.0, 860.0, 1720.0, 2580.0, 4000.0, 4001.5] {
            for height in [379.0, 380.0, 760.0, 1140.0, 2000.0, 2001.5] {
                for count in 0..15 {
                    let screen = area(-2000.0, 30.0, width, height);
                    let slots = plan(&[screen], count, MIN);
                    let capacity = ((width / MIN.0).floor().min(3.0)
                        * (height / MIN.1).floor().min(3.0))
                        as usize;
                    assert_eq!(slots.len(), count.min(capacity));
                    if !slots.is_empty() {
                        let covered: f64 = slots.iter().map(|slot| slot.width * slot.height).sum();
                        assert!((covered - width * height).abs() < 0.001);
                        assert_eq!(slots[0].x, screen.x);
                        assert!((slots[0].y + slots[0].height - screen.y - height).abs() < 0.001);
                    }
                    for (i, slot) in slots.iter().enumerate() {
                        assert!(slot.width >= MIN.0 && slot.height >= MIN.1);
                        assert!(slot.x >= screen.x && slot.y >= screen.y);
                        assert!(slot.x + slot.width <= screen.x + width + 0.001);
                        assert!(slot.y + slot.height <= screen.y + height + 0.001);
                        for other in &slots[..i] {
                            assert!(
                                slot.x >= other.x + other.width - 0.001
                                    || other.x >= slot.x + slot.width - 0.001
                                    || slot.y >= other.y + other.height - 0.001
                                    || other.y >= slot.y + slot.height - 0.001
                            );
                        }
                    }
                }
            }
        }
    }
}
