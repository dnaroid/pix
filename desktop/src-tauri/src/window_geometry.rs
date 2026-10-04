//! macOS desktop geometry in logical points, independent of backing scale.
//! Apply it to the builder: moving and then resizing an existing window with
//! physical pixels can race the asynchronous Cocoa display/scale transition.
use serde::{Deserialize, Serialize};
use tauri::{utils::config::WindowConfig, WebviewWindow};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub(crate) struct Geometry {
    pub width: f64,
    pub height: f64,
    pub x: f64,
    pub y: f64,
}

impl Geometry {
    pub(crate) fn valid(&self) -> bool {
        [self.width, self.height, self.x, self.y]
            .iter()
            .all(|value| value.is_finite() && value.abs() <= 100_000.0)
            && self.width > 0.0
            && self.height > 0.0
    }

    fn intersects(&self, other: &Self) -> bool {
        self.x < other.x + other.width
            && self.x + self.width > other.x
            && self.y < other.y + other.height
            && self.y + self.height > other.y
    }
}

pub(crate) fn capture(window: &WebviewWindow) -> Option<Geometry> {
    // Keep the cached normal rectangle when maximized/minimized/fullscreen.
    if window.is_maximized().ok()? || window.is_minimized().ok()? || window.is_fullscreen().ok()? {
        return None;
    }
    from_physical(
        window.inner_size().ok()?,
        window.outer_position().ok()?,
        window.scale_factor().ok()?,
    )
}

fn from_physical(
    size: tauri::PhysicalSize<u32>,
    position: tauri::PhysicalPosition<i32>,
    scale: f64,
) -> Option<Geometry> {
    if !scale.is_finite() || scale <= 0.0 {
        return None;
    }
    let size = size.to_logical::<f64>(scale);
    let position = position.to_logical::<f64>(scale);
    let geometry = Geometry {
        width: size.width,
        height: size.height,
        x: position.x,
        y: position.y,
    };
    geometry.valid().then_some(geometry)
}

pub(crate) fn logical_monitor(monitor: &tauri::Monitor) -> Geometry {
    let scale = monitor.scale_factor();
    let size = monitor.size().to_logical::<f64>(scale);
    let position = monitor.position().to_logical::<f64>(scale);
    Geometry {
        width: size.width,
        height: size.height,
        x: position.x,
        y: position.y,
    }
}

pub(crate) fn apply(config: &mut WindowConfig, saved: Option<Geometry>, monitors: &[Geometry]) {
    let Some(mut geometry) = saved.filter(Geometry::valid) else {
        // Legacy physical snapshots have no source scale. Do not guess it and
        // permanently propagate an already-shrunken rectangle.
        return;
    };
    geometry.width = geometry.width.max(config.min_width.unwrap_or(0.0));
    geometry.height = geometry.height.max(config.min_height.unwrap_or(0.0));
    config.width = geometry.width;
    config.height = geometry.height;
    if monitors.iter().any(|monitor| geometry.intersects(monitor)) {
        config.x = Some(geometry.x);
        config.y = Some(geometry.y);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> WindowConfig {
        WindowConfig {
            width: 1240.0,
            height: 820.0,
            min_width: Some(860.0),
            min_height: Some(380.0),
            ..Default::default()
        }
    }

    fn geometry(x: f64, y: f64) -> Geometry {
        Geometry {
            width: 1100.0,
            height: 750.0,
            x,
            y,
        }
    }

    #[test]
    fn mixed_dpi_coordinates_and_sizes_restore_in_points() {
        // Both monitors expose physical bounds scaled by their own DPI.
        let bounds = [
            (0.0, 0.0, 1440.0, 900.0, 2.0),
            (0.0, -1080.0, 1920.0, 1080.0, 1.0),
        ];
        let monitors: Vec<_> = bounds
            .into_iter()
            .map(|(x, y, width, height, scale)| {
                let size =
                    tauri::PhysicalSize::new((width * scale) as u32, (height * scale) as u32)
                        .to_logical::<f64>(scale);
                let position = tauri::PhysicalPosition::new((x * scale) as i32, (y * scale) as i32)
                    .to_logical::<f64>(scale);
                Geometry {
                    width: size.width,
                    height: size.height,
                    x: position.x,
                    y: position.y,
                }
            })
            .collect();
        let saved = geometry(70.0, -1000.0);
        let mut config = config();
        for _ in 0..3 {
            apply(&mut config, Some(saved), &monitors);
            assert_eq!((config.width, config.height), (1100.0, 750.0));
            assert_eq!((config.x, config.y), (Some(70.0), Some(-1000.0)));
        }
    }

    #[test]
    fn repeated_restarts_and_scale_changes_never_halve_geometry() {
        let original = geometry(70.0, -1000.0);
        let mut saved = original;
        for scale in [1.0, 2.0, 2.0, 1.0, 2.0] {
            let mut config = config();
            apply(&mut config, Some(saved), &[geometry(0.0, -1080.0)]);
            saved = from_physical(
                tauri::LogicalSize::new(config.width, config.height).to_physical(scale),
                tauri::LogicalPosition::new(config.x.unwrap(), config.y.unwrap())
                    .to_physical(scale),
                scale,
            )
            .unwrap();
            assert_eq!(saved, original);
        }
        assert!(from_physical((1100, 750).into(), (0, 0).into(), 0.0).is_none());
    }

    #[test]
    fn legacy_or_invalid_geometry_uses_defaults() {
        for saved in [
            None,
            Some(Geometry {
                width: f64::NAN,
                ..geometry(0.0, 0.0)
            }),
            Some(Geometry {
                height: 0.0,
                ..geometry(0.0, 0.0)
            }),
        ] {
            let mut config = config();
            apply(&mut config, saved, &[]);
            assert_eq!((config.width, config.height), (1240.0, 820.0));
            assert_eq!((config.x, config.y), (None, None));
        }
    }

    #[test]
    fn unavailable_display_keeps_size_but_lets_os_place_window() {
        let mut config = config();
        apply(
            &mut config,
            Some(geometry(0.0, -2000.0)),
            &[geometry(0.0, 0.0)],
        );
        assert_eq!((config.width, config.height), (1100.0, 750.0));
        assert_eq!((config.x, config.y), (None, None));
    }

    #[test]
    fn restored_size_cannot_fall_below_configured_logical_minimum() {
        let mut config = config();
        apply(
            &mut config,
            Some(Geometry {
                width: 430.0,
                height: 310.0,
                x: 0.0,
                y: 0.0,
            }),
            &[],
        );
        assert_eq!((config.width, config.height), (860.0, 380.0));
    }
}
