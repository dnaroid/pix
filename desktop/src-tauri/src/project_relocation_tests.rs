use super::*;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "pix-relocate-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        Self(fs::canonicalize(root).unwrap())
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn identity_is_created_once_only_inside_existing_pi_directory() {
    let scratch = Scratch::new();
    let project = scratch.0.join("project");
    fs::create_dir_all(&project).unwrap();
    assert_eq!(read_or_create_identity(&project).unwrap(), None);
    assert!(!project.join(".pi").exists(), "opening must not create .pi");

    fs::create_dir(project.join(".pi")).unwrap();
    let id = read_or_create_identity(&project).unwrap().unwrap();
    assert!(uuid::Uuid::parse_str(&id).is_ok());
    assert_eq!(read_or_create_identity(&project).unwrap(), Some(id.clone()));
    assert_eq!(
        fs::read_to_string(project.join(".pi/project-id")).unwrap(),
        format!("{id}\n")
    );
    let leftovers: Vec<_> = fs::read_dir(project.join(".pi"))
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty());
}

#[cfg(unix)]
#[test]
fn identity_ignores_symlinked_pi_and_rejects_invalid_content() {
    let scratch = Scratch::new();
    let project = scratch.0.join("project");
    let outside = scratch.0.join("outside");
    fs::create_dir_all(&project).unwrap();
    fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, project.join(".pi")).unwrap();
    assert_eq!(read_or_create_identity(&project).unwrap(), None);
    assert!(!outside.join("project-id").exists());

    let other = scratch.0.join("other");
    fs::create_dir_all(other.join(".pi")).unwrap();
    fs::write(other.join(".pi/project-id"), "not-a-uuid").unwrap();
    assert!(read_or_create_identity(&other).is_err());
}

fn header(cwd: &str) -> String {
    format!(
        "{{\"type\":\"session\",\"version\":3,\"id\":\"s1\",\"timestamp\":\"t\",\"cwd\":{}}}\n",
        serde_json::to_string(cwd).unwrap()
    )
}

#[test]
fn relocation_moves_sessions_rewrites_headers_and_preserves_times() {
    let scratch = Scratch::new();
    let agent = scratch.0.join("agent");
    let from = scratch.0.join("old name");
    let to = scratch.0.join("new-name");
    fs::create_dir_all(&to).unwrap();
    let from_text = from.to_str().unwrap();
    let to_text = to.to_str().unwrap();
    let source_dir = agent.join("sessions").join(session_dir_name(from_text));
    let target_dir = agent.join("sessions").join(session_dir_name(to_text));
    fs::create_dir_all(&source_dir).unwrap();

    let body = "{\"type\":\"message\",\"id\":\"m1\"}\n";
    let session = source_dir.join("2026_a.jsonl");
    fs::write(&session, format!("{}{body}", header(from_text))).unwrap();
    let modified = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
    File::options()
        .write(true)
        .open(&session)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    // A session that belongs elsewhere and non-session files stay in place.
    fs::write(source_dir.join("2026_b.jsonl"), header("/somewhere/else")).unwrap();
    fs::write(source_dir.join("2026_a.jsonl.bak"), "backup").unwrap();

    let tabs_path = tab_snapshot_path(&agent, from_text);
    fs::create_dir_all(tabs_path.parent().unwrap()).unwrap();
    let old_session_path = session.to_str().unwrap().to_owned();
    fs::write(
        &tabs_path,
        serde_json::json!({
            "version": 4,
            "cwd": from_text,
            "activePath": old_session_path,
            "tabs": [{ "path": old_session_path, "autoUserMessages": [] }, { "path": "/elsewhere/x.jsonl" }]
        })
        .to_string(),
    )
    .unwrap();

    let report = relocate_state(&agent, &from, &to).unwrap();
    assert_eq!(report.moved_sessions, 1);
    assert!(report.conflicts.is_empty());
    let mut skipped = report.skipped.clone();
    skipped.sort();
    assert_eq!(
        skipped,
        vec!["2026_a.jsonl.bak".to_owned(), "2026_b.jsonl".to_owned()]
    );
    assert!(report.tab_snapshot_moved);
    assert!(source_dir.join("2026_b.jsonl").exists());
    assert!(!tabs_path.exists());

    let moved = target_dir.join("2026_a.jsonl");
    assert_eq!(
        fs::read_to_string(&moved).unwrap(),
        format!("{}{body}", header(to_text))
    );
    assert_eq!(fs::metadata(&moved).unwrap().modified().unwrap(), modified);
    assert!(!target_dir.join("2026_b.jsonl").exists());
    assert!(!target_dir.join("2026_a.jsonl.bak").exists());

    let snapshot: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(tab_snapshot_path(&agent, to_text)).unwrap())
            .unwrap();
    let new_session_path = moved.to_str().unwrap();
    assert_eq!(snapshot["cwd"], to_text);
    assert_eq!(snapshot["activePath"], new_session_path);
    assert_eq!(snapshot["tabs"][0]["path"], new_session_path);
    assert_eq!(snapshot["tabs"][1]["path"], "/elsewhere/x.jsonl");
}

#[test]
fn relocation_never_overwrites_and_refuses_existing_source() {
    let scratch = Scratch::new();
    let agent = scratch.0.join("agent");
    let from = scratch.0.join("old");
    let to = scratch.0.join("new");
    fs::create_dir_all(&from).unwrap();
    fs::create_dir_all(&to).unwrap();
    assert!(relocate_state(&agent, &from, &to)
        .unwrap_err()
        .contains("still exists"));
    assert!(relocate_state(&agent, &to, &to).is_err());
    assert!(relocate_state(&agent, Path::new("relative"), &to).is_err());
    fs::remove_dir(&from).unwrap();

    let from_text = from.to_str().unwrap();
    let to_text = to.to_str().unwrap();
    let source_dir = agent.join("sessions").join(session_dir_name(from_text));
    let target_dir = agent.join("sessions").join(session_dir_name(to_text));
    fs::create_dir_all(&source_dir).unwrap();
    fs::create_dir_all(&target_dir).unwrap();
    fs::write(source_dir.join("same.jsonl"), header(from_text)).unwrap();
    fs::write(target_dir.join("same.jsonl"), "existing").unwrap();
    fs::write(source_dir.join("unique.jsonl"), header(from_text)).unwrap();

    let report = relocate_state(&agent, &from, &to).unwrap();
    assert_eq!(report.moved_sessions, 1);
    assert_eq!(report.conflicts, vec!["same.jsonl".to_owned()]);
    assert_eq!(
        fs::read_to_string(target_dir.join("same.jsonl")).unwrap(),
        "existing"
    );
    assert!(
        source_dir.join("same.jsonl").exists(),
        "conflict stays at source"
    );
    assert_eq!(
        fs::read_to_string(target_dir.join("unique.jsonl")).unwrap(),
        header(to_text)
    );
}

#[test]
fn session_map_records_keep_ids_and_follow_moved_files() {
    let scratch = Scratch::new();
    let map = scratch.0.join("sessions.json");
    fs::write(&map, serde_json::json!({"version":1,"sessions":[
        {"sessionId":"keep","piSessionPath":"/s/old/a.jsonl","cwd":"/p/old","piSessionId":"x","updatedAt":"t"},
        {"sessionId":"other","piSessionPath":"/s/old/b.jsonl","cwd":"/p/elsewhere","piSessionId":"y","updatedAt":"t"}
    ]}).to_string()).unwrap();
    let moved = vec![(
        PathBuf::from("/s/old/a.jsonl"),
        PathBuf::from("/s/new/a.jsonl"),
    )];
    assert_eq!(
        relocate_session_map(&map, "/p/old", "/p/new", &moved).unwrap(),
        1
    );
    let value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&map).unwrap()).unwrap();
    assert_eq!(value["sessions"][0]["sessionId"], "keep");
    assert_eq!(value["sessions"][0]["piSessionPath"], "/s/new/a.jsonl");
    assert_eq!(value["sessions"][0]["cwd"], "/p/new");
    assert_eq!(value["sessions"][1]["piSessionPath"], "/s/old/b.jsonl");
    assert!(!PathBuf::from(format!("{}.lock", map.display())).exists());
}

#[test]
fn encodings_match_pi_sdk_and_queue_store() {
    assert_eq!(
        session_dir_name("/Volumes/128GBSSD/Projects/pi-ui-extend"),
        "--Volumes-128GBSSD-Projects-pi-ui-extend--"
    );
    // sha256("/tmp/project")[0..24 hex]
    let digest = Sha256::digest(b"/tmp/project");
    let expected: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(
        tab_snapshot_path(Path::new("/agent"), "/tmp/project"),
        Path::new("/agent/pix/tabs").join(format!("{}.json", &expected[..24]))
    );
    assert_eq!(
        normalized_absolute(Path::new("/a/b/")).unwrap(),
        PathBuf::from("/a/b")
    );
    assert_eq!(
        normalized_absolute(Path::new("/a/./c/../b")).unwrap(),
        PathBuf::from("/a/b")
    );
}
