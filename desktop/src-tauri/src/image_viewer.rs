//! Transient image windows are not project windows and never own a runtime.
use crate::window_geometry::Geometry;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};
use tauri::{utils::config::WindowConfig, AppHandle, Manager, WebviewUrl, WebviewWindow};

const PREFIX: &str = "image-viewer-";
const MAX_SOURCE_BYTES: usize = 36 * 1024 * 1024;
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Image {
    src: String,
    alt: String,
    width: f64,
    height: f64,
}

impl Image {
    fn validate(&self) -> Result<(), String> {
        let local_asset = tauri::Url::parse(&self.src).ok().is_some_and(|url| {
            matches!(
                (url.scheme(), url.host_str()),
                ("asset", Some("localhost")) | ("http", Some("asset.localhost"))
            ) && url.username().is_empty()
                && url.password().is_none()
                && url.port().is_none()
        });
        let image_data = self.src.strip_prefix("data:image/").is_some_and(|data| {
            data.split_once(',').is_some_and(|(header, _)| {
                matches!(
                    header,
                    "png;base64"
                        | "jpeg;base64"
                        | "gif;base64"
                        | "webp;base64"
                        | "svg+xml;base64"
                        | "avif;base64"
                        | "bmp;base64"
                )
            })
        });
        if self.src.len() > MAX_SOURCE_BYTES
            || self.alt.len() > 4096
            || !(local_asset || image_data)
            || ![self.width, self.height]
                .iter()
                .all(|n| n.is_finite() && *n > 0.0 && *n <= 1_000_000.0)
        {
            return Err("invalid image window request".into());
        }
        Ok(())
    }
}

struct Entry {
    label: String,
    image: Image,
}

#[derive(Default)]
struct Registry(HashMap<String, Entry>);

impl Registry {
    fn is_current(&self, owner: &str, label: &str) -> bool {
        self.0.get(owner).is_some_and(|entry| entry.label == label)
    }

    fn remove_viewer(&mut self, label: &str) {
        self.0.retain(|_, entry| entry.label != label);
    }

    fn image(&self, label: &str) -> Option<Image> {
        self.0
            .values()
            .find(|entry| entry.label == label)
            .map(|entry| entry.image.clone())
    }
}

#[derive(Default)]
pub(crate) struct State(Mutex<Registry>);

pub(crate) fn is_viewer(label: &str) -> bool {
    label.starts_with(PREFIX)
}

// Frameless geometry includes our 36-point draggable header and 8-point padding.
fn geometry(width: f64, height: f64, area: Geometry) -> Geometry {
    let available_width = (area.width - 32.0).max(1.0);
    let available_height = (area.height - 32.0).max(1.0);
    let scale = ((available_width - 16.0).max(1.0) / width)
        .min((available_height - 52.0).max(1.0) / height)
        .min(1.0);
    let width = (width * scale + 16.0).max(160.0).min(available_width);
    let height = (height * scale + 52.0).max(100.0).min(available_height);
    Geometry {
        width,
        height,
        x: area.x + (area.width - width) / 2.0,
        y: area.y + (area.height - height) / 2.0,
    }
}

fn destroy(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        if let Err(error) = window.destroy() {
            crate::logging::error(
                module_path!(),
                format!("could not destroy image viewer: {error}"),
            );
        }
    }
}

#[tauri::command]
pub(crate) async fn desktop_open_image_window(
    app: AppHandle,
    window: WebviewWindow,
    image: Image,
) -> Result<(), String> {
    if window.label() != "main" && !window.label().starts_with("project-") {
        return Err("image viewer requires a project window".into());
    }
    image.validate()?;
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or(app.primary_monitor().map_err(|e| e.to_string())?)
        .ok_or("no monitor available")?;
    let work = monitor.work_area();
    let size = work.size.to_logical::<f64>(monitor.scale_factor());
    let position = work.position.to_logical::<f64>(monitor.scale_factor());
    let bounds = geometry(
        image.width,
        image.height,
        Geometry {
            width: size.width,
            height: size.height,
            x: position.x,
            y: position.y,
        },
    );
    let owner = window.label().to_owned();
    let label = format!("{PREFIX}{}", SEQUENCE.fetch_add(1, Ordering::Relaxed));
    let config = WindowConfig {
        label: label.clone(),
        url: WebviewUrl::App("index.html?imageViewer=1".into()),
        title: if image.alt.is_empty() {
            "Pix — Image".into()
        } else {
            format!("Pix — {}", image.alt)
        },
        width: bounds.width,
        height: bounds.height,
        x: Some(bounds.x),
        y: Some(bounds.y),
        decorations: false,
        resizable: true,
        accept_first_mouse: true,
        theme: window.theme().ok(),
        ..Default::default()
    };
    let state = app.state::<State>();
    let previous = state.0.lock().map_err(|e| e.to_string())?.0.insert(
        owner.clone(),
        Entry {
            label: label.clone(),
            image,
        },
    );
    if let Some(previous) = previous {
        destroy(&app, &previous.label);
    }
    // Reserve before creation: a fast frontend can request its payload immediately.
    let built = crate::startup_theme::build(&app, &config);
    match built {
        Ok(_) => {
            let accepted = state
                .0
                .lock()
                .map_err(|e| e.to_string())?
                .is_current(&owner, &label)
                && app.get_webview_window(&owner).is_some()
                && !app
                    .state::<crate::AcpProcessState>()
                    .exiting
                    .load(Ordering::Acquire);
            if !accepted {
                destroy(&app, &label);
            }
            Ok(())
        }
        Err(error) => {
            state
                .0
                .lock()
                .map_err(|e| e.to_string())?
                .remove_viewer(&label);
            Err(error.to_string())
        }
    }
}

#[tauri::command]
pub(crate) async fn desktop_image_window_payload(
    window: WebviewWindow,
    state: tauri::State<'_, State>,
) -> Result<Image, String> {
    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .image(window.label())
        .ok_or("image viewer is no longer available".into())
}

pub(crate) fn destroyed(app: &AppHandle, label: &str) {
    let state = app.state::<State>();
    let previous = {
        let mut registry = state.0.lock().unwrap();
        registry.remove_viewer(label);
        registry.0.remove(label)
    };
    if let Some(previous) = previous {
        destroy(app, &previous.label);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image() -> Image {
        Image {
            src: "asset://localhost/tmp/diagram.png".into(),
            alt: "Diagram".into(),
            width: 1600.0,
            height: 1200.0,
        }
    }
    fn area() -> Geometry {
        Geometry {
            x: 1440.0,
            y: -100.0,
            width: 1920.0,
            height: 1050.0,
        }
    }

    #[test]
    fn size_uses_monitor_not_parent_and_does_not_upscale() {
        let geometry = geometry(900.0, 700.0, area());
        assert_eq!((geometry.width, geometry.height), (916.0, 752.0));
        assert!(geometry.x > area().x);
        assert!(geometry.y > area().y);
    }

    #[test]
    fn oversized_portrait_and_landscape_fit_work_area_with_proportions() {
        for (width, height) in [(8000.0, 2000.0), (2000.0, 8000.0)] {
            let geometry = geometry(width, height, area());
            assert!(geometry.width <= area().width - 32.0);
            assert!(geometry.height <= area().height - 32.0);
            assert!(
                ((geometry.width - 16.0) / (geometry.height - 52.0) - width / height).abs()
                    < 0.0001
            );
        }
    }

    #[test]
    fn rejects_external_and_blob_sources_and_invalid_dimensions() {
        for src in [
            "https://example.com/a.png",
            "file:///etc/passwd",
            "blob:temporary",
            "data:text/html;base64,AA==",
            "http://asset.localhost.evil/a",
            "asset://other/a",
            "asset://localhost:123/a",
        ] {
            let mut image = image();
            image.src = src.into();
            assert!(image.validate().is_err());
        }
        for number in [0.0, -1.0, f64::NAN, f64::INFINITY, 1_000_001.0] {
            let mut image = image();
            image.width = number;
            assert!(image.validate().is_err());
        }
        let mut image = image();
        image.src = "data:image/png;base64,AA==".into();
        assert!(image.validate().is_ok());
        image.src = "http://asset.localhost/tmp/image.png".into();
        assert!(image.validate().is_ok());
    }

    #[test]
    fn replacing_and_destroying_viewers_cannot_erase_newer_payloads() {
        let mut registry = Registry::default();
        registry.0.insert(
            "main".into(),
            Entry {
                label: "old".into(),
                image: image(),
            },
        );
        registry.0.insert(
            "main".into(),
            Entry {
                label: "new".into(),
                image: image(),
            },
        );
        assert!(!registry.is_current("main", "old"));
        registry.remove_viewer("old");
        assert!(registry.is_current("main", "new"));
        assert!(registry.image("main").is_none());
        assert!(registry.image("new").is_some());
        registry.0.remove("main");
        assert!(!registry.is_current("main", "new"));
        assert!(registry.image("new").is_none());
    }
}
