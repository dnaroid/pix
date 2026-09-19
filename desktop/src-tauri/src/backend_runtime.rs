//! Packaged builds never resolve backend files against the build machine's checkout.
#[cfg(any(test, not(feature = "bundled-runtime")))]
use std::ffi::OsString;
use std::{
    env,
    path::{Path, PathBuf},
    process::Command,
};

pub struct BackendRuntime {
    node: PathBuf,
    entry: PathBuf,
    bootstrap: PathBuf,
    extensions: Vec<(&'static str, PathBuf)>,
    bundled_root: Option<PathBuf>,
}

const EXTENSIONS: [(&str, &str); 3] = [
    ("PIX_ACP_QUESTION_EXTENSION", "question"),
    ("PIX_ACP_SESSION_TITLE_EXTENSION", "session-title"),
    ("PIX_ACP_WORKSPACE_UNDO_EXTENSION", "workspace-undo"),
];

impl BackendRuntime {
    pub fn resolve(resource_dir: &Path) -> Result<Self, String> {
        #[cfg(feature = "bundled-runtime")]
        {
            Self::bundled(&resource_dir.join("pix-runtime"))
        }
        #[cfg(not(feature = "bundled-runtime"))]
        {
            let _ = resource_dir;
            Self::development(
                &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
                |key| env::var_os(key),
            )
        }
    }

    #[cfg(any(test, feature = "bundled-runtime"))]
    fn bundled(root: &Path) -> Result<Self, String> {
        let app = root.join("app");
        let mut extensions: Vec<(&'static str, PathBuf)> = EXTENSIONS
            .iter()
            .map(|(key, name)| {
                (
                    *key,
                    app.join(format!("dist/bundled-extensions/{name}/index.js")),
                )
            })
            .collect();
        extensions.push((
            "PIX_ACP_TOOLS_SUITE_EXTENSION",
            app.join("external/pi-tools-suite/index.ts"),
        ));
        let runtime = Self {
            node: root
                .join("runtime")
                .join(if cfg!(windows) { "node.exe" } else { "node" }),
            entry: app.join("acp/dist/main.js"),
            bootstrap: root.join("bootstrap.mjs"),
            extensions,
            bundled_root: Some(root.to_owned()),
        };
        for path in [
            root.join("release.json"),
            app.join(".pix-portable.json"),
            runtime.node.clone(),
        ] {
            require_file(&path)?;
        }
        runtime.validate()?;
        Ok(runtime)
    }

    #[cfg(any(test, not(feature = "bundled-runtime")))]
    fn development(root: &Path, lookup: impl Fn(&str) -> Option<OsString>) -> Result<Self, String> {
        let mut extensions: Vec<(&'static str, PathBuf)> = EXTENSIONS
            .iter()
            .map(|(key, name)| {
                (
                    *key,
                    lookup(key).map(PathBuf::from).unwrap_or_else(|| {
                        root.join(format!("dist/bundled-extensions/{name}/index.js"))
                    }),
                )
            })
            .collect();
        extensions.push((
            "PIX_ACP_TOOLS_SUITE_EXTENSION",
            lookup("PIX_ACP_TOOLS_SUITE_EXTENSION")
                .map(PathBuf::from)
                .unwrap_or_else(|| root.join("external/pi-tools-suite/index.ts")),
        ));
        let runtime = Self {
            node: lookup("PIX_ACP_NODE_BINARY")
                .map(PathBuf::from)
                .unwrap_or_else(|| "node".into()),
            entry: lookup("PIX_ACP_ENTRY")
                .map(PathBuf::from)
                .unwrap_or_else(|| root.join("acp/dist/main.js")),
            bootstrap: root.join("scripts/release/bootstrap.mjs"),
            extensions,
            bundled_root: None,
        };
        runtime.validate()?;
        Ok(runtime)
    }

    fn validate(&self) -> Result<(), String> {
        require_file(&self.entry)?;
        require_file(&self.bootstrap)?;
        for (_, path) in &self.extensions {
            require_file(path)?;
        }
        Ok(())
    }

    pub fn command(&self) -> Result<Command, String> {
        self.command_for(&self.entry)
    }

    pub(crate) fn bootstrap_command(&self, action: &str) -> Result<Command, String> {
        let mut command = self.command_for(&self.bootstrap)?;
        command.arg(action);
        Ok(command)
    }

    pub(crate) fn script_command(&self, entry: &Path) -> Result<Command, String> {
        require_file(entry)?;
        self.command_for(entry)
    }

    #[cfg(feature = "bundled-runtime")]
    pub fn verification_command(&self) -> Result<Command, String> {
        let root = self
            .bundled_root
            .as_ref()
            .ok_or("Release verification needs a bundled runtime")?;
        let entry = root.join("verify.mjs");
        require_file(&entry)?;
        self.command_for(&entry)
    }

    fn command_for(&self, entry: &Path) -> Result<Command, String> {
        let mut command = Command::new(&self.node);
        command.arg(entry);
        for (key, path) in &self.extensions {
            command.env(key, path);
        }
        if let Some(root) = &self.bundled_root {
            command.env_remove("PIX_ACP_PI_ENTRY");
            command.env_remove("PIX_ACP_PI_BIN");
            let mut paths = Vec::new();
            if let Some(home) = home_dir_from_environment() {
                paths.push(home.join(".pi/pix-desktop-tools/node_modules/.bin"));
            }
            paths.push(root.join("runtime"));
            paths.push(root.join("app/node_modules/.bin"));
            paths.extend(env::split_paths(&env::var_os("PATH").unwrap_or_default()));
            command.env(
                "PATH",
                env::join_paths(paths).map_err(|error| error.to_string())?,
            );
            command.env("PIX_BUNDLED_PI_BIN", root.join("app/node_modules/.bin"));
            command.env(
                "PIX_BUNDLED_NPM_CLI",
                root.join("runtime/npm/bin/npm-cli.js"),
            );
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW for the background ACP process.
        }
        Ok(command)
    }
}

fn home_dir_from_environment() -> Option<PathBuf> {
    #[cfg(windows)]
    let value = env::var_os("USERPROFILE").or_else(|| env::var_os("HOME"));
    #[cfg(not(windows))]
    let value = env::var_os("HOME");
    value.map(PathBuf::from)
}

fn require_file(path: &Path) -> Result<(), String> {
    if path.is_file() {
        return Ok(());
    }
    Err(format!("Pix backend file is missing: {}. Reinstall the complete release, or rebuild Pix/ACP for a development checkout.", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
    };
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = env::temp_dir().join(format!(
                "pix runtime {} {}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn file(&self, path: &str) {
            let path = self.0.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"fixture").unwrap();
        }
        fn payload(&self) {
            for file in [
                "release.json",
                "bootstrap.mjs",
                "app/.pix-portable.json",
                "app/acp/dist/main.js",
            ] {
                self.file(file);
            }
            self.file(if cfg!(windows) {
                "runtime/node.exe"
            } else {
                "runtime/node"
            });
            for (_, name) in EXTENSIONS {
                self.file(&format!("app/dist/bundled-extensions/{name}/index.js"));
            }
            self.file("app/external/pi-tools-suite/index.ts");
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn bundled_runtime_uses_only_relocated_resources() {
        let fixture = Fixture::new();
        fixture.payload();
        let runtime = BackendRuntime::bundled(&fixture.0).unwrap();
        let command = runtime.command().unwrap();
        assert!(Path::new(command.get_program()).starts_with(&fixture.0));
        assert_eq!(
            command.get_args().next().unwrap(),
            fixture.0.join("app/acp/dist/main.js")
        );
        assert_eq!(runtime.extensions.len(), 4);
        for (_, path) in runtime.extensions {
            assert!(path.starts_with(&fixture.0));
        }
    }

    #[test]
    fn missing_bundle_never_falls_back_to_source_or_system_node() {
        let fixture = Fixture::new();
        fixture.payload();
        fs::remove_file(fixture.0.join("app/acp/dist/main.js")).unwrap();
        assert!(BackendRuntime::bundled(&fixture.0)
            .err()
            .unwrap()
            .contains("Reinstall"));
    }

    #[test]
    fn development_retains_explicit_overrides() {
        let fixture = Fixture::new();
        fixture.payload();
        fixture.file("app/scripts/release/bootstrap.mjs");
        let runtime = BackendRuntime::development(&fixture.0.join("app"), |key| {
            (key == "PIX_ACP_NODE_BINARY").then(|| OsString::from("custom-node"))
        })
        .unwrap();
        assert_eq!(runtime.node, PathBuf::from("custom-node"));
        assert!(runtime.bundled_root.is_none());
    }
}
