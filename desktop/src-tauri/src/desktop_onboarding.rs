use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::Path};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct State {
    version: u32,
    completed: bool,
}

#[tauri::command]
pub async fn desktop_onboarding_status(app: AppHandle, complete: bool) -> Result<bool, String> {
    super::run_blocking(move || {
        let result = app
            .path()
            .home_dir()
            .map_err(|error| format!("Could not resolve onboarding home: {error}"))
            .and_then(|home| status(&home, complete));
        if let Err(error) = &result {
            crate::logging::error("desktop-onboarding", error.clone());
        }
        result
    })
    .await
}

fn status(home: &Path, complete: bool) -> Result<bool, String> {
    let directory = home.join(".config/pi");
    let path = directory.join("desktop-onboarding.json");
    if !complete {
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(format!("Could not read onboarding status: {error}")),
        };
        let state: State = serde_json::from_slice(&bytes)
            .map_err(|error| format!("Invalid onboarding status: {error}"))?;
        if state.version != 1 {
            return Err("Unsupported onboarding status version".into());
        }
        return Ok(state.completed);
    }
    // Completion is monotonic: every concurrent writer publishes identical data.
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create onboarding directory: {error}"))?;
    let temporary = directory.join(format!(".desktop-onboarding-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("Could not create onboarding status: {error}"))?;
        file.write_all(b"{\"version\":1,\"completed\":true}\n")
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Could not save onboarding status: {error}"))?;
        fs::rename(&temporary, &path)
            .map_err(|error| format!("Could not publish onboarding status: {error}"))?;
        Ok(true)
    })();
    let _ = fs::remove_file(&temporary);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_onboarding_round_trip_is_global_and_monotonic() {
        let home = std::env::temp_dir().join(format!("pix-onboarding-{}", uuid::Uuid::new_v4()));
        assert!(!status(&home, false).unwrap());
        assert!(!home.exists());
        assert!(status(&home, true).unwrap());
        assert!(status(&home, false).unwrap());
        assert!(status(&home, true).unwrap());
        assert!(status(&home, false).unwrap());
        assert_eq!(fs::read_dir(home.join(".config/pi")).unwrap().count(), 1);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn desktop_onboarding_reports_invalid_storage_and_write_failure() {
        let home = std::env::temp_dir().join(format!("pix-onboarding-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(home.join(".config/pi")).unwrap();
        let path = home.join(".config/pi/desktop-onboarding.json");
        fs::write(&path, b"bad json").unwrap();
        assert!(status(&home, false).is_err());
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(status(&home, true).is_err());
        assert_eq!(fs::read_dir(home.join(".config/pi")).unwrap().count(), 1);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn desktop_onboarding_concurrent_completions_publish_one_valid_state() {
        let home = std::env::temp_dir().join(format!("pix-onboarding-{}", uuid::Uuid::new_v4()));
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let home = home.clone();
                std::thread::spawn(move || status(&home, true).unwrap())
            })
            .collect();
        for worker in workers {
            assert!(worker.join().unwrap());
        }
        assert!(status(&home, false).unwrap());
        assert_eq!(fs::read_dir(home.join(".config/pi")).unwrap().count(), 1);
        fs::remove_dir_all(home).unwrap();
    }
}
