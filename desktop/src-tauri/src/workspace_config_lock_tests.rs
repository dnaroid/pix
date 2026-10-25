use super::*;

struct Fixture(PathBuf);
struct ChildGuard(std::process::Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
impl Fixture {
    fn new() -> Self {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../.pi/artifacts/workspace-lock-tests")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        initialize_project_pi_from(&root).unwrap();
        Self(fs::canonicalize(root).unwrap())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn workspace_lock_and_policy_survive_manual_and_ttl_cleanup_including_sidecars() {
    let fixture = Fixture::new();
    let workspace = &fixture.0;
    write_project_workspace_config_from(workspace, "{\"search\":{\"sources\":{\"tasks\":true}}}")
        .unwrap();
    let lock = workspace.join(".pi/workspace.jsonc.lock");
    let content = fs::read(workspace.join(".pi/workspace.jsonc")).unwrap();
    let old = SystemTime::now() - PROJECT_PI_AUTO_CLEAN_TTL - Duration::from_secs(60);
    for name in [
        "writer.sqlite-wal",
        "writer.sqlite-shm",
        "writer.sqlite-journal",
        ".DS_Store",
        ".workspace.jsonc.stray.tmp",
    ] {
        fs::write(lock.join(name), b"keep").unwrap();
    }
    for child in fs::read_dir(&lock).unwrap() {
        fs::File::open(child.unwrap().path())
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(old))
            .unwrap();
    }
    fs::File::open(&lock)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(old))
        .unwrap();
    fs::File::open(workspace.join(".pi/workspace.jsonc"))
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(old))
        .unwrap();
    for automatic in [true, false] {
        if automatic {
            auto_clean_project_pi_from(workspace).unwrap();
        } else {
            clean_project_pi_from(workspace).unwrap();
        }
        assert_eq!(
            fs::read(workspace.join(".pi/workspace.jsonc")).unwrap(),
            content
        );
        for name in [
            "writer.sqlite",
            "writer.sqlite-wal",
            "writer.sqlite-shm",
            "writer.sqlite-journal",
            ".DS_Store",
            ".workspace.jsonc.stray.tmp",
        ] {
            assert!(lock.join(name).exists(), "cleanup removed {name}");
        }
        assert_eq!(project_pi_storage_from(workspace).unwrap().cleanup_bytes, 0);
    }
}

#[test]
fn workspace_lock_serializes_node_source_writer_with_desktop_cas_and_editor() {
    use std::io::{BufRead, BufReader};
    let fixture = Fixture::new();
    let workspace = &fixture.0;
    let initial = write_project_workspace_config_from(workspace, "{}").unwrap();
    let module =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../acp/src/search/source-policy.js");
    let script = r#"
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const rename = fs.promises.rename;
fs.promises.rename = async (...args) => {
  console.log('ready');
  await new Promise(resolve => process.stdin.once('data', resolve));
  return rename(...args);
};
syncBuiltinESMExports();
const { writeSourcePolicy } = await import(process.argv[1]);
await writeSourcePolicy(process.argv[2], 'tasks', true);
"#;
    let child = Command::new("node")
        .args(["--input-type=module", "-e", script])
        .arg(format!("file://{}", module.display()))
        .arg(workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut child = ChildGuard(child);
    let mut ready = String::new();
    BufReader::new(child.0.stdout.take().unwrap())
        .read_line(&mut ready)
        .unwrap();
    assert_eq!(ready.trim(), "ready");
    let root = workspace.clone();
    let expected = initial.content.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let writer = thread::spawn(move || {
        let result = write_project_workspace_config_if_unchanged_from(
            &root,
            Some(&expected),
            "{\"color\":\"#123456\"}",
        );
        let _ = tx.send(result);
    });
    assert!(
        rx.recv_timeout(Duration::from_millis(100)).is_err(),
        "Desktop CAS bypassed the Node mutex"
    );
    child
        .0
        .stdin
        .take()
        .unwrap()
        .write_all(b"continue\n")
        .unwrap();
    assert!(child.0.wait().unwrap().success());
    let result = rx.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
    writer.join().unwrap();
    assert!(!result.written, "a stale CAS overwrote a source selection");
    assert!(result.document.unwrap().content.contains("tasks"));
    let lock = workspace_config_lock::WorkspaceConfigLock::acquire(&workspace.join(".pi")).unwrap();
    assert!(
        write_project_file_with_expected_from(
            workspace,
            Path::new(".pi/workspace.jsonc"),
            "{}",
            Some(&initial.content)
        )
        .err()
        .unwrap()
        .contains("busy"),
        "generic editor bypassed workspace mutex"
    );
    drop(lock);
}

#[test]
fn workspace_editor_rejects_stale_loaded_content_and_aliases() {
    let fixture = Fixture::new();
    let workspace = &fixture.0;
    let before = write_project_workspace_config_from(workspace, "{}").unwrap();
    let changed = write_project_workspace_config_from(
        workspace,
        "{\"search\":{\"sources\":{\"tasks\":true}}}",
    )
    .unwrap();
    for path in [
        ".pi/workspace.jsonc",
        "./.pi/workspace.jsonc",
        ".pi/WORKSPACE.JSONC",
    ] {
        if !workspace.join(path).exists() {
            continue;
        }
        assert!(write_project_file_with_expected_from(
            workspace,
            Path::new(path),
            "{}",
            Some(&before.content)
        )
        .is_err());
        assert_eq!(
            fs::read_to_string(workspace.join(".pi/workspace.jsonc")).unwrap(),
            changed.content
        );
    }
    let saved = write_project_file_with_expected_from(
        workspace,
        Path::new(".pi/workspace.jsonc"),
        &format!("{} ", changed.content),
        Some(&changed.content),
    )
    .unwrap();
    assert_eq!(saved.content.trim_end(), changed.content);
}
