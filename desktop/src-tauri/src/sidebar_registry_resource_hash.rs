use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::{
    sidebar_registry_fingerprint_visit, sidebar_registry_hash_path,
    sidebar_registry_tree_fingerprint,
};

fn companion(path: &Path) -> Result<Option<PathBuf>, String> {
    let companion = path.with_extension("");
    match fs::symlink_metadata(&companion) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            Ok(Some(companion))
        }
        Ok(_) => Err(format!(
            "Agent companion must be a regular directory: {}",
            companion.display()
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "failed to inspect agent companion {}: {error}",
            companion.display()
        )),
    }
}

pub(super) fn fingerprint(
    path: &Path,
    include_agent_companion: bool,
) -> Result<(u64, u64), String> {
    if !include_agent_companion {
        return sidebar_registry_tree_fingerprint(path);
    }
    let mut hasher = DefaultHasher::new();
    let mut count = 0;
    let mut bytes = 0;
    sidebar_registry_fingerprint_visit(path, "", &mut count, &mut bytes, &mut hasher)?;
    let companion = companion(path)?;
    companion.is_some().hash(&mut hasher);
    if let Some(companion) = companion {
        sidebar_registry_fingerprint_visit(&companion, "", &mut count, &mut bytes, &mut hasher)?;
    }
    Ok((hasher.finish(), bytes))
}

pub(super) fn hash(path: &Path, include_agent_companion: bool) -> Result<String, String> {
    let file_hash = sidebar_registry_hash_path(path)?;
    if include_agent_companion {
        if let Some(companion) = companion(path)? {
            // Match ACP hashResource: provenance covers the entire agent package.
            let mut hasher = Sha256::new();
            hasher.update(format!("agent-file\0{file_hash}\0companion\0").as_bytes());
            hasher.update(sidebar_registry_hash_path(&companion)?.as_bytes());
            return Ok(format!("{:x}", hasher.finalize()));
        }
    }
    Ok(file_hash)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        sidebar_registry_cached_path_changed, sidebar_registry_indicator_state,
        SidebarIndicatorState, MAX_SIDEBAR_REGISTRY_HASH_BYTES,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);

    // Golden values produced by ACP's hashResource("agent", path).
    const SYNCED: &str = "353e275e0f9e81c0ec6219d84f31588aa20408c8a494d8bc24de04730090d3ff";
    const EDITED: &str = "b766f5cc91490b3cc9a7ba2839f3268f47cfb153cd67330cfb79debed59899ff";
    const FILE_ONLY: &str = "e0c0585d74d320cd99bd7c743624eb06b91abb9a1604716ea8c952efcd4a99e4";

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../.pi/artifacts/registry-agent-hash-tests")
                .join(format!(
                    "pix-agent-indicator-{}-{}-{}",
                    std::process::id(),
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_nanos(),
                    NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
                ));
            fs::create_dir_all(root.join(".pi/agents/demo/scripts")).unwrap();
            fs::write(
                root.join(".pi/agents/demo.md"),
                "---\nname: demo\n---\nAgent\n",
            )
            .unwrap();
            fs::write(root.join(".pi/agents/demo/scripts/check.ts"), "check-v1\n").unwrap();
            Self(root)
        }
        fn agent(&self) -> PathBuf {
            self.0.join(".pi/agents/demo.md")
        }
        fn provenance(&self, hash: &str) {
            fs::write(self.0.join(".pi/registry.json"), format!(r#"{{"version":1,"resources":{{"agent:demo":{{"type":"agent","name":"demo","hash":"{hash}","publicationScope":"project"}}}},"projectResources":{{}}}}"#)).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn agent_package_hash_matches_acp_and_clears_indicator_after_sync() {
        let fixture = Fixture::new();
        fixture.provenance(SYNCED);
        let state = SidebarIndicatorState::default();
        let poll = || sidebar_registry_indicator_state(&state, &fixture.0, &fixture.0.join("home"));
        let assert_clean = || {
            let snapshot = poll();
            assert!(snapshot.stable && snapshot.error.is_none(), "{snapshot:?}");
            assert!(!snapshot.local_changes);
        };
        let before = fingerprint(&fixture.agent(), true).unwrap();
        assert_eq!(hash(&fixture.agent(), true).unwrap(), SYNCED);
        assert_eq!(before, fingerprint(&fixture.agent(), true).unwrap());
        assert_clean();
        assert_clean(); // Cached verdict must include companion metadata too.

        fs::write(
            fixture.0.join(".pi/agents/demo/scripts/check.ts"),
            "check-v2\n",
        )
        .unwrap();
        assert_eq!(hash(&fixture.agent(), true).unwrap(), EDITED);
        assert!(poll().local_changes);
        fixture.provenance(EDITED);
        assert_clean();

        fs::remove_dir_all(fixture.0.join(".pi/agents/demo")).unwrap();
        assert!(poll().local_changes);
        assert_eq!(hash(&fixture.agent(), true).unwrap(), FILE_ONLY);
        fixture.provenance(FILE_ONLY);
        assert_clean();

        fs::create_dir_all(fixture.0.join(".pi/agents/demo/scripts")).unwrap();
        fs::write(
            fixture.0.join(".pi/agents/demo/scripts/check.ts"),
            "check-v1\n",
        )
        .unwrap();
        assert!(poll().local_changes);
        fixture.provenance(SYNCED);
        assert_clean();
    }

    #[test]
    fn companion_content_participates_in_hash_budget() {
        let fixture = Fixture::new();
        let state = SidebarIndicatorState::default();
        let mut budget = fs::metadata(fixture.agent()).unwrap().len();
        assert_eq!(
            sidebar_registry_cached_path_changed(
                &state,
                &fixture.0,
                "agent:demo",
                &fixture.agent(),
                true,
                SYNCED,
                &mut budget
            )
            .unwrap(),
            None
        );
        let mut budget = MAX_SIDEBAR_REGISTRY_HASH_BYTES;
        assert_eq!(
            sidebar_registry_cached_path_changed(
                &state,
                &fixture.0,
                "agent:demo",
                &fixture.agent(),
                true,
                SYNCED,
                &mut budget
            )
            .unwrap(),
            Some(false)
        );
    }

    #[cfg(unix)]
    #[test]
    fn companion_symlinks_and_non_directory_entries_fail_closed() {
        let fixture = Fixture::new();
        let dir = fixture.0.join(".pi/agents/demo");
        fs::remove_dir_all(&dir).unwrap();
        fs::write(&dir, "not a directory").unwrap();
        assert!(fingerprint(&fixture.agent(), true).is_err());
        assert!(hash(&fixture.agent(), true).is_err());
        fs::remove_file(&dir).unwrap();
        std::os::unix::fs::symlink(fixture.0.join(".pi/agents"), &dir).unwrap();
        assert!(fingerprint(&fixture.agent(), true).is_err());
        assert!(hash(&fixture.agent(), true).is_err());
        fs::remove_file(&dir).unwrap();
        fs::create_dir_all(&dir).unwrap();
        std::os::unix::fs::symlink(fixture.agent(), dir.join("linked.md")).unwrap();
        assert!(fingerprint(&fixture.agent(), true).is_err());
        assert!(hash(&fixture.agent(), true).is_err());
    }
}
