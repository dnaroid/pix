//! Fail-closed, runner-owned Desktop QA isolation. No process environment mutation.
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

// Embedded capability marker used before launch; not a source hash/freshness claim.
const CONTRACT: &str = "PIX_DESKTOP_ISOLATED_QA_V1";

/// Owned by run(), not managed AppHandle state: the listener may retain an
/// AppHandle until the first signal, but cannot form an app/task ownership cycle.
#[cfg(unix)]
pub(crate) struct SignalBridge {
    signals: Option<[tokio::signal::unix::Signal; 3]>,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}

#[cfg(unix)]
fn register_signals<T>(
    mut register: impl FnMut(tokio::signal::unix::SignalKind) -> std::io::Result<T>,
) -> std::io::Result<[T; 3]> {
    use tokio::signal::unix::SignalKind;
    Ok([
        register(SignalKind::terminate())?,
        register(SignalKind::interrupt())?,
        register(SignalKind::hangup())?,
    ])
}

#[cfg(unix)]
async fn request_exit_on_signal(
    signal: impl std::future::Future<Output = ()>,
    request: impl FnOnce(),
) {
    signal.await;
    request();
}

#[cfg(unix)]
impl SignalBridge {
    pub(crate) fn register() -> std::io::Result<Self> {
        let runtime = tauri::async_runtime::handle();
        let _entered = runtime.inner().enter();
        Ok(Self {
            signals: Some(register_signals(tokio::signal::unix::signal)?),
            task: None,
        })
    }

    pub(crate) fn start(&mut self, app: tauri::AppHandle) {
        let [mut term, mut interrupt, mut hangup] =
            self.signals.take().expect("QA signal bridge started once");
        // Exactly one explicit exit request. Repeated signals must not bypass
        // the existing ExitRequested worker while it saves state/stops children.
        // Tokio's process-wide handlers stay installed after receivers drop.
        self.task = Some(tauri::async_runtime::spawn(request_exit_on_signal(
            async move {
                tokio::select! {
                    _ = term.recv() => {},
                    _ = interrupt.recv() => {},
                    _ = hangup.recv() => {},
                }
            },
            move || {
                if let Some(profile) = tauri::Manager::state::<Option<QaProfile>>(&app).as_ref() {
                    profile.shutdown_requested.store(true, Ordering::Release);
                }
                app.exit(0);
            },
        )));
    }

    pub(crate) fn stop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
        self.signals.take();
    }
}

#[cfg(unix)]
impl Drop for SignalBridge {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Debug)]
pub(crate) struct QaProfile {
    root: PathBuf,
    pub(crate) identifier: String,
    shutdown_requested: AtomicBool,
}

#[derive(Deserialize)]
struct Manifest {
    version: u8,
    id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Runtime<'a> {
    version: u8,
    contract: &'static str,
    pid: u32,
    executable: PathBuf,
    profile_dir: &'a Path,
    app_identifier: &'a str,
    isolated: bool,
}

fn read_bounded(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > 4096 {
        return Err(format!("invalid QA file: {}", path.display()));
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 4096 {
        return Err("QA file exceeds size limit".into());
    }
    Ok(bytes)
}

fn canonical_directory(path: &Path) -> Result<(), String> {
    if !path.is_absolute() || !path.is_dir() || fs::canonicalize(path).ok().as_deref() != Some(path)
    {
        return Err(format!(
            "QA directory must be existing, absolute and canonical: {}",
            path.display()
        ));
    }
    Ok(())
}

impl QaProfile {
    pub(crate) fn from_environment() -> Result<Option<Self>, String> {
        Self::from_values(|key| std::env::var_os(key))
    }

    fn from_values(env: impl Fn(&str) -> Option<OsString>) -> Result<Option<Self>, String> {
        // Legacy QA remains unchanged. Supplying a profile with QA disabled is
        // not an opt-in; an empty/non-Unicode explicit profile fails closed.
        if env("PI_UI_QA").as_deref() != Some(std::ffi::OsStr::new("1")) {
            return Ok(None);
        }
        let Some(root) = env("PI_UI_QA_PROFILE_DIR") else {
            return Ok(None);
        };
        let root = PathBuf::from(root);
        canonical_directory(&root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let metadata = fs::metadata(&root).map_err(|e| e.to_string())?;
            if metadata.mode() & 0o077 != 0 || metadata.uid() != unsafe { libc::geteuid() } {
                return Err("QA profile must be private and owned by the current user".into());
            }
        }
        #[cfg(not(target_os = "macos"))]
        if !cfg!(test) {
            return Err("isolated Desktop QA is supported only on macOS".into());
        }
        let manifest: Manifest = serde_json::from_slice(&read_bounded(&root.join("profile.json"))?)
            .map_err(|e| e.to_string())?;
        let id = uuid::Uuid::parse_str(&manifest.id).map_err(|e| e.to_string())?;
        if manifest.version != 1 || id.is_nil() || id.hyphenated().to_string() != manifest.id {
            return Err("QA profile requires version 1 and a canonical non-nil UUID".into());
        }
        for (key, suffix) in [
            ("HOME", "home"),
            ("PI_CODING_AGENT_DIR", "home/.pi/agent"),
            ("PI_CONFIG_DIR", "home/.config/pi"),
            ("XDG_CONFIG_HOME", "home/.config"),
        ] {
            let expected = root.join(suffix);
            if env(key).as_deref() != Some(expected.as_os_str()) {
                return Err(format!("{key} must point exactly inside the QA profile"));
            }
            canonical_directory(&expected)?;
        }
        Ok(Some(Self {
            root,
            identifier: format!("dev.pix.desktop.qa.{}", id.simple()),
            shutdown_requested: AtomicBool::new(false),
        }))
    }

    pub(crate) fn configure(&self, config: &mut tauri::utils::config::Config) {
        config.identifier = self.identifier.clone();
        // Do not permit auto-created windows to bypass startup_theme::build.
        for window in &mut config.app.windows {
            window.create = false;
            window.incognito = true;
        }
    }

    fn infrastructure_exit(&self, code: Option<i32>) -> bool {
        code.is_some() && self.shutdown_requested.load(Ordering::Acquire)
    }

    pub(crate) fn publish(&self) -> Result<(), Box<dyn std::error::Error>> {
        let runtime = Runtime {
            version: 1,
            contract: CONTRACT,
            pid: std::process::id(),
            executable: fs::canonicalize(std::env::current_exe()?)?,
            profile_dir: &self.root,
            app_identifier: &self.identifier,
            isolated: true,
        };
        let temporary = self
            .root
            .join(format!(".runtime-{}.tmp", std::process::id()));
        let result = (|| {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary)?;
            file.write_all(&serde_json::to_vec(&runtime)?)?;
            file.sync_all()?;
            fs::rename(&temporary, self.root.join("runtime.json"))?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }

    pub(crate) fn remove_runtime(&self) {
        let path = self.root.join("runtime.json");
        if let Ok(bytes) = read_bounded(&path) {
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                if value["pid"].as_u64() == Some(u64::from(std::process::id())) {
                    let _ = fs::remove_file(path);
                }
            }
        }
    }
}

pub(crate) fn isolated(manager: &impl tauri::Manager<tauri::Wry>) -> bool {
    manager
        .try_state::<Option<QaProfile>>()
        .is_some_and(|profile| profile.is_some())
}

/// Only infrastructure cancellation of an isolated QA process can skip the
/// active-work confirmation. User Quit/Restart and ordinary launches are unchanged.
pub(crate) fn infrastructure_exit(
    manager: &impl tauri::Manager<tauri::Wry>,
    code: Option<i32>,
) -> bool {
    manager.try_state::<Option<QaProfile>>().is_some_and(|state| {
        state.as_ref().is_some_and(|profile| profile.infrastructure_exit(code))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[cfg(unix)]
    #[test]
    fn registration_is_complete_or_fails_closed() {
        use tokio::signal::unix::SignalKind;
        let mut seen = Vec::new();
        let registered = register_signals(|kind| {
            seen.push(kind.as_raw_value());
            Ok(kind.as_raw_value())
        })
        .unwrap();
        assert_eq!(
            registered,
            [
                SignalKind::terminate().as_raw_value(),
                SignalKind::interrupt().as_raw_value(),
                SignalKind::hangup().as_raw_value(),
            ]
        );
        assert_eq!(seen, registered);
        let mut calls = 0;
        assert!(register_signals(|_| {
            calls += 1;
            if calls == 2 {
                Err(std::io::Error::other("registration failed"))
            } else {
                Ok(())
            }
        })
        .is_err());
        assert_eq!(calls, 2);
    }

    #[cfg(unix)]
    #[test]
    fn listener_requests_once_and_teardown_releases_callback() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            let requests = Arc::new(AtomicUsize::new(0));
            let callback = requests.clone();
            let (tx, rx) = tokio::sync::oneshot::channel();
            let task = tokio::spawn(request_exit_on_signal(
                async {
                    let _ = rx.await;
                },
                move || {
                    callback.fetch_add(1, Ordering::SeqCst);
                },
            ));
            tx.send(()).unwrap();
            task.await.unwrap();
            assert_eq!(requests.load(Ordering::SeqCst), 1);
            assert_eq!(Arc::strong_count(&requests), 1);

            let callback = requests.clone();
            let task = tokio::spawn(request_exit_on_signal(std::future::pending(), move || {
                callback.fetch_add(1, Ordering::SeqCst);
            }));
            let mut bridge = SignalBridge {
                signals: None,
                task: Some(tauri::async_runtime::JoinHandle::Tokio(task)),
            };
            let task = bridge.task.as_ref().unwrap().inner().abort_handle();
            bridge.stop();
            bridge.stop(); // idempotent, no blocking join on the UI thread
            tokio::task::yield_now().await;
            assert!(task.is_finished());
            assert_eq!(requests.load(Ordering::SeqCst), 1);
            assert_eq!(Arc::strong_count(&requests), 1);
        });
    }

    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn fixture() -> (Fixture, BTreeMap<String, OsString>) {
        let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.pi/artifacts");
        fs::create_dir_all(&base).unwrap();
        let root = fs::canonicalize(base)
            .unwrap()
            .join(format!("qa-native-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let mut env = BTreeMap::from([
            ("PI_UI_QA".into(), OsString::from("1")),
            ("PI_UI_QA_PROFILE_DIR".into(), root.clone().into_os_string()),
        ]);
        for (key, suffix) in [
            ("HOME", "home"),
            ("PI_CODING_AGENT_DIR", "home/.pi/agent"),
            ("PI_CONFIG_DIR", "home/.config/pi"),
            ("XDG_CONFIG_HOME", "home/.config"),
        ] {
            fs::create_dir_all(root.join(suffix)).unwrap();
            env.insert(key.into(), root.join(suffix).into_os_string());
        }
        fs::write(
            root.join("profile.json"),
            br#"{"version":1,"id":"12345678-1234-4234-8234-123456789abc"}"#,
        )
        .unwrap();
        (Fixture(root), env)
    }

    #[test]
    fn ordinary_and_legacy_qa_do_not_opt_in() {
        assert!(QaProfile::from_values(|_| None).unwrap().is_none());
        assert!(
            QaProfile::from_values(|k| (k == "PI_UI_QA").then(|| "1".into()))
                .unwrap()
                .is_none()
        );
        assert!(QaProfile::from_values(
            |k| (k == "PI_UI_QA_PROFILE_DIR").then(|| "/invalid".into())
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn only_an_owned_infrastructure_exit_can_skip_confirmation() {
        let (_fixture, env) = fixture();
        let profile = QaProfile::from_values(|k| env.get(k).cloned()).unwrap().unwrap();
        assert!(!profile.infrastructure_exit(None));
        assert!(!profile.infrastructure_exit(Some(0)));
        profile.shutdown_requested.store(true, Ordering::Release);
        assert!(!profile.infrastructure_exit(None));
        assert!(profile.infrastructure_exit(Some(0)));
    }

    #[test]
    fn validates_paths_identity_and_private_handshake() {
        let (fixture, env) = fixture();
        let profile = QaProfile::from_values(|k| env.get(k).cloned())
            .unwrap()
            .unwrap();
        let mut config = tauri::utils::config::Config::default();
        config.app.windows.push(Default::default());
        profile.configure(&mut config);
        assert_eq!(
            config.identifier,
            "dev.pix.desktop.qa.12345678123442348234123456789abc"
        );
        assert!(config.app.windows[0].incognito);
        assert!(!config.app.windows[0].create);
        profile.publish().unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(fixture.0.join("runtime.json")).unwrap()).unwrap();
        assert_eq!(value["isolated"], true);
        assert_eq!(value["pid"], std::process::id());
        assert_eq!(value["profileDir"], fixture.0.to_str().unwrap());
        profile.remove_runtime();
        assert!(!fixture.0.join("runtime.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_shared_permissions_and_symlinked_private_paths() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let (fixture, env) = fixture();
        fs::set_permissions(&fixture.0, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(QaProfile::from_values(|k| env.get(k).cloned()).is_err());
        fs::set_permissions(&fixture.0, fs::Permissions::from_mode(0o700)).unwrap();
        let agent = fixture.0.join("home/.pi/agent");
        fs::remove_dir(&agent).unwrap();
        symlink(fixture.0.join("home/.config/pi"), agent).unwrap();
        assert!(QaProfile::from_values(|k| env.get(k).cloned()).is_err());
    }

    #[test]
    fn explicit_invalid_profiles_fail_closed() {
        let (fixture, mut env) = fixture();
        env.insert("HOME".into(), "/Users/working-user".into());
        assert!(QaProfile::from_values(|k| env.get(k).cloned()).is_err());
        env.insert("HOME".into(), fixture.0.join("home").into_os_string());
        fs::write(
            fixture.0.join("profile.json"),
            br#"{"version":1,"id":"not-a-uuid"}"#,
        )
        .unwrap();
        assert!(QaProfile::from_values(|k| env.get(k).cloned()).is_err());
        env.insert("PI_UI_QA_PROFILE_DIR".into(), OsString::new());
        assert!(QaProfile::from_values(|k| env.get(k).cloned()).is_err());
    }
}
