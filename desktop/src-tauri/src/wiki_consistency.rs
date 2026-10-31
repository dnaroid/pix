//! Saved Wiki checks are bounded historical hints tied to the exact Markdown body.
use chrono::{NaiveDate, NaiveTime};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Component, Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::SystemTime,
};

use super::{ProjectTreeEntry, ProjectTreeEntryKind};

const STAMP_PREFIX: &str = "<!-- pix:wiki-check ";
const REPORT_PREFIX: &str = "<!-- pix:wiki-report ";
const MAX_STAMP_BYTES: usize = 4096;
const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_DIRECTORY_BYTES: u64 = 8 * 1024 * 1024;
const MAX_CACHE_ENTRIES: usize = 4096;
const STAMP_KEYS: [&str; 9] = [
    "version",
    "status",
    "contentHash",
    "checkedAt",
    "modelRef",
    "scope",
    "checkedSources",
    "candidateSources",
    "reportLanguage",
];

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct CacheKey {
    workspace: PathBuf,
    path: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct FileSignature {
    size: u64,
    modified: SystemTime,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    changed_seconds: i64,
    #[cfg(unix)]
    changed_nanoseconds: i64,
}

impl FileSignature {
    fn from_metadata(metadata: &fs::Metadata) -> Option<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            Some(Self {
                size: metadata.len(),
                modified: metadata.modified().ok()?,
                device: metadata.dev(),
                inode: metadata.ino(),
                changed_seconds: metadata.ctime(),
                changed_nanoseconds: metadata.ctime_nsec(),
            })
        }
        #[cfg(not(unix))]
        {
            // Re-read when a stable file identity is unavailable; size and mtime alone
            // must not preserve a positive result across a same-size replacement.
            let _ = metadata;
            None
        }
    }
}

struct CachedStamp {
    signature: FileSignature,
    checked: bool,
    used: u64,
}

/// Metadata-only cache: no document bodies, sidecars, or unbounded access history.
struct StampCache {
    entries: HashMap<CacheKey, CachedStamp>,
    recency: BTreeMap<u64, CacheKey>,
    next_use: u64,
    capacity: usize,
}

impl StampCache {
    fn new(capacity: usize) -> Self {
        Self {
            entries: HashMap::new(),
            recency: BTreeMap::new(),
            next_use: 0,
            capacity,
        }
    }

    fn remove(&mut self, key: &CacheKey) {
        if let Some(entry) = self.entries.remove(key) {
            self.recency.remove(&entry.used);
        }
    }

    fn get(&mut self, key: &CacheKey, signature: &FileSignature) -> Option<bool> {
        let entry = self.entries.get(key)?;
        if &entry.signature != signature {
            self.remove(key);
            return None;
        }
        let checked = entry.checked;
        self.insert(key.clone(), signature.clone(), checked);
        Some(checked)
    }

    fn insert(&mut self, key: CacheKey, signature: FileSignature, checked: bool) {
        if self.capacity == 0 {
            return;
        }
        if self.next_use == u64::MAX {
            self.entries.clear();
            self.recency.clear();
            self.next_use = 0;
        }
        self.remove(&key);
        if self.entries.len() >= self.capacity {
            if let Some((_, oldest)) = self.recency.pop_first() {
                self.entries.remove(&oldest);
            }
        }
        let used = self.next_use;
        self.next_use += 1;
        self.recency.insert(used, key.clone());
        self.entries.insert(
            key,
            CachedStamp {
                signature,
                checked,
                used,
            },
        );
    }
}

fn stamp_cache() -> &'static Mutex<StampCache> {
    static CACHE: OnceLock<Mutex<StampCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(StampCache::new(MAX_CACHE_ENTRIES)))
}

fn read_document(root: &Path, relative: &Path, max_bytes: u64) -> Option<String> {
    super::read_project_file_from(root, relative, max_bytes)
        .ok()
        .map(|document| document.content)
}

/// Inspect only requested Markdown entries, on the directory command's blocking worker.
pub(super) fn annotate_project_entries(workspace: &Path, entries: &mut [ProjectTreeEntry]) {
    annotate_with_budget(workspace, entries, MAX_DIRECTORY_BYTES);
}

fn annotate_with_budget(workspace: &Path, entries: &mut [ProjectTreeEntry], remaining: u64) {
    annotate_with_cache_and_reader(workspace, entries, remaining, stamp_cache(), read_document);
}

fn annotate_with_cache_and_reader(
    workspace: &Path,
    entries: &mut [ProjectTreeEntry],
    mut remaining: u64,
    cache: &Mutex<StampCache>,
    mut read: impl FnMut(&Path, &Path, u64) -> Option<String>,
) {
    let Ok(root) = super::canonical_workspace(workspace) else {
        return;
    };
    for entry in entries {
        if !matches!(entry.kind, ProjectTreeEntryKind::File)
            || !Path::new(&entry.path)
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|extension| {
                    extension.eq_ignore_ascii_case("md")
                        || extension.eq_ignore_ascii_case("markdown")
                })
        {
            continue;
        }
        entry.wiki_checked = Some(false);
        let relative = Path::new(&entry.path);
        let Some((path, before)) = inspect_regular_file(&root, relative) else {
            continue;
        };
        if before.len() > MAX_FILE_BYTES {
            continue;
        }
        let key = CacheKey {
            workspace: root.clone(),
            path,
        };
        let signature = FileSignature::from_metadata(&before);
        let cached = signature
            .as_ref()
            .and_then(|signature| cache.lock().ok()?.get(&key, signature));
        if let Some(checked) = cached {
            // Recheck the complete safe path after lookup too: a cache hit must not
            // trust a file or symlink replacement that happened during this listing.
            if inspect_regular_file(&root, relative)
                .is_some_and(|(_, after)| same_file(&before, &after))
            {
                entry.wiki_checked = Some(checked);
            } else if let Ok(mut cache) = cache.lock() {
                cache.remove(&key);
            }
            continue;
        }
        // Reserve the bounded reader's extra growth-detection byte even on an error.
        let cost = before.len().saturating_add(1);
        if cost > remaining {
            continue;
        }
        remaining -= cost;
        // Neither filesystem I/O nor hashing holds the shared cache lock.
        let Some(document) = read(&root, relative, before.len()) else {
            continue;
        };
        let Some((_, after)) = inspect_regular_file(&root, relative) else {
            continue;
        };
        if same_file(&before, &after) {
            let checked = has_current_clear_stamp(&document);
            entry.wiki_checked = Some(checked);
            if let Some(signature) = signature {
                if let Ok(mut cache) = cache.lock() {
                    cache.insert(key, signature, checked);
                }
            }
        }
    }
}

/// The ordinary reader keeps UTF-8 bytes intact; additionally refuse every symlink ancestor.
fn inspect_regular_file(root: &Path, relative: &Path) -> Option<(PathBuf, fs::Metadata)> {
    super::validate_workspace_relative_path(relative, "Wiki page").ok()?;
    let mut path = root.to_path_buf();
    let mut components = relative.components().peekable();
    while let Some(component) = components.next() {
        let Component::Normal(name) = component else {
            return None;
        };
        path.push(name);
        let metadata = fs::symlink_metadata(&path).ok()?;
        if metadata.file_type().is_symlink() {
            return None;
        }
        if components.peek().is_some() {
            if !metadata.is_dir() {
                return None;
            }
        } else {
            if !metadata.is_file() || fs::canonicalize(&path).ok()? != path {
                return None;
            }
            return Some((path, metadata));
        }
    }
    None
}

fn same_file(before: &fs::Metadata, after: &fs::Metadata) -> bool {
    if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        before.dev() == after.dev()
            && before.ino() == after.ino()
            && before.ctime() == after.ctime()
            && before.ctime_nsec() == after.ctime_nsec()
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn has_current_clear_stamp(content: &str) -> bool {
    if content.len() as u64 > MAX_FILE_BYTES || has_report_header(content) {
        return false;
    }
    // Match the browser's bounded trailing-footer scan. Examples inside the body are ordinary text.
    let mut body = content;
    let mut count = 0;
    let mut bytes = 0;
    while !body.is_empty() {
        let end = if body.ends_with("\r\n") {
            body.len() - 2
        } else if body.ends_with('\n') {
            body.len() - 1
        } else {
            body.len()
        };
        let Some(separator) = body[..end].rfind('\n') else {
            break;
        };
        let line = &body[separator + 1..end];
        if !line.starts_with(STAMP_PREFIX) || line.contains('\r') {
            break;
        }
        bytes += body.len() - separator;
        if bytes > MAX_STAMP_BYTES {
            return false;
        }
        body = &body[..separator];
        count += 1;
    }
    let suffix = &content[body.len()..];
    let opener = format!("\n{STAMP_PREFIX}");
    if count != 1 || !suffix.starts_with(&opener) || !suffix.ends_with(" -->\n") {
        return false;
    }
    let json = &suffix[opener.len()..suffix.len() - " -->\n".len()];
    if json.chars().any(|ch| matches!(ch, '<' | '>' | '\r' | '\n')) {
        return false;
    }
    let Ok(Value::Object(stamp)) = serde_json::from_str::<Value>(json) else {
        return false;
    };
    if stamp.len() != STAMP_KEYS.len()
        || !STAMP_KEYS.iter().all(|key| stamp.contains_key(*key))
        || stamp.get("version").and_then(Value::as_f64) != Some(1.0)
        || stamp.get("status").and_then(Value::as_str) != Some("clear")
        || stamp.get("scope").and_then(Value::as_str) != Some("retrieved-passages")
        || !matches!(
            stamp.get("reportLanguage").and_then(Value::as_str),
            Some("en" | "ru")
        )
    {
        return false;
    }
    let Some(hash) = stamp.get("contentHash").and_then(Value::as_str) else {
        return false;
    };
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return false;
    }
    let Some(checked_at) = stamp.get("checkedAt").and_then(Value::as_str) else {
        return false;
    };
    if !canonical_date(checked_at) {
        return false;
    }
    let Some(model) = stamp.get("modelRef").and_then(Value::as_str) else {
        return false;
    };
    if model.trim().is_empty()
        || model.len() > 512
        || model.chars().any(|ch| ch <= '\u{1f}' || ch == '\u{7f}')
    {
        return false;
    }
    let Some(checked) = source_count(stamp.get("checkedSources")) else {
        return false;
    };
    let Some(candidates) = source_count(stamp.get("candidateSources")) else {
        return false;
    };
    candidates >= checked && hash == format!("{:x}", Sha256::digest(body.as_bytes()))
}

/// Match stamp.ts's reserved report position without parsing or hashing report JSON.
/// A report and green footer cannot coexist, even when either claims a matching hash.
/// Other comments and examples remain ordinary Markdown body bytes.
fn has_report_header(content: &str) -> bool {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    if content.starts_with(REPORT_PREFIX) {
        return true;
    }
    // The browser also tolerates a retained BOM immediately before frontmatter.
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let Some(first_end) = content.find('\n') else {
        return false;
    };
    let opener = content[..first_end].strip_suffix('\r').unwrap_or(&content[..first_end]);
    if opener != "---" && opener != "+++" {
        return false;
    }
    let mut start = first_end + 1;
    while start < content.len() {
        let end = content[start..].find('\n').map(|offset| start + offset);
        let line_end = end.unwrap_or(content.len());
        let line = content[start..line_end]
            .strip_suffix('\r')
            .unwrap_or(&content[start..line_end]);
        if line == opener || (opener == "---" && line == "...") {
            let after = &content[end.map_or(content.len(), |index| index + 1)..];
            // The owned '\n' preserves the original closing delimiter EOL.
            // An immediate comment uses the inserted bridge for an original EOF.
            return after.starts_with(REPORT_PREFIX)
                || after.strip_prefix('\n').is_some_and(|text| text.starts_with(REPORT_PREFIX));
        }
        let Some(end) = end else {
            return false;
        };
        start = end + 1;
    }
    false
}

fn source_count(value: Option<&Value>) -> Option<u64> {
    let value = value?.as_f64()?;
    (value.is_finite() && value.fract() == 0.0 && (1.0..=4096.0).contains(&value))
        .then_some(value as u64)
}

fn canonical_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 24
        || [4, 7].iter().any(|index| bytes[*index] != b'-')
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[19] != b'.'
        || bytes[23] != b'Z'
        || bytes.iter().enumerate().any(|(index, byte)| {
            ![4, 7, 10, 13, 16, 19, 23].contains(&index) && !byte.is_ascii_digit()
        })
    {
        return false;
    }
    let number = |start, end| value[start..end].parse::<u32>().ok();
    let Some(year) = number(0, 4) else {
        return false;
    };
    let Some(month) = number(5, 7) else {
        return false;
    };
    let Some(day) = number(8, 10) else {
        return false;
    };
    let Some(hour) = number(11, 13) else {
        return false;
    };
    let Some(minute) = number(14, 16) else {
        return false;
    };
    let Some(second) = number(17, 19) else {
        return false;
    };
    let Some(millis) = number(20, 23) else {
        return false;
    };
    second < 60
        && NaiveDate::from_ymd_opt(year as i32, month, day).is_some()
        && NaiveTime::from_hms_milli_opt(hour, minute, second, millis).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::cell::Cell;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn stamp(body: &str) -> Value {
        serde_json::json!({ "version": 1, "status": "clear",
            "contentHash": format!("{:x}", Sha256::digest(body.as_bytes())),
            "checkedAt": "2026-10-30T12:34:56.789Z", "modelRef": "openai-codex/gpt-6-luna",
            "scope": "retrieved-passages", "checkedSources": 12, "candidateSources": 48,
            "reportLanguage": "ru" })
    }
    fn stamped(body: &str, metadata: &Value) -> String {
        format!(
            "{body}\n{STAMP_PREFIX}{} -->\n",
            metadata
                .to_string()
                .replace('<', "\\u003c")
                .replace('>', "\\u003e")
        )
    }
    fn entry(path: &str, kind: ProjectTreeEntryKind) -> ProjectTreeEntry {
        ProjectTreeEntry {
            name: path.to_owned(),
            path: path.to_owned(),
            kind,
            wiki_checked: None,
        }
    }
    struct Workspace(PathBuf);
    impl Workspace {
        fn new() -> Self {
            let root = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../.pi/artifacts")
                .join(format!(
                    "wiki-stamp-{}-{}",
                    std::process::id(),
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_nanos()
                ));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Workspace {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    fn annotate_counted(
        workspace: &Workspace,
        entries: &mut [ProjectTreeEntry],
        cache: &Mutex<StampCache>,
        reads: &Cell<usize>,
        budget: u64,
    ) {
        annotate_with_cache_and_reader(
            &workspace.0,
            entries,
            budget,
            cache,
            |root, path, limit| {
                assert!(
                    cache.try_lock().is_ok(),
                    "a file read held the shared cache lock"
                );
                reads.set(reads.get() + 1);
                read_document(root, path, limit)
            },
        );
    }

    #[cfg(unix)]
    fn set_modified(path: &Path, modified: SystemTime) {
        fs::OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
    }

    #[test]
    fn matches_browser_saved_stamp_fixtures() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../../acp/test/fixtures/knowledge-check-stamps.json"
        ))
        .unwrap();
        for case in cases {
            assert_eq!(
                has_current_clear_stamp(case["content"].as_str().unwrap()),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn verifies_exact_utf8_body_including_crlf_and_final_newlines() {
        for body in ["", "# Page", "# Page\n", "# Привет\r\n\r\nПравило.\r\n"] {
            let saved = stamped(body, &stamp(body));
            assert!(has_current_clear_stamp(&saved));
            assert!(!has_current_clear_stamp(&format!("changed{saved}")));
            assert!(!has_current_clear_stamp(saved.trim_end_matches('\n')));
        }
        let body = "# Page\r\nText\r\n";
        assert!(!has_current_clear_stamp(
            &stamped(body, &stamp(body)).replace("\r\n", "\n")
        ));
    }

    #[test]
    fn rejects_malformed_duplicate_and_oversized_metadata_but_keeps_body_examples() {
        let body = "```html\n<!-- pix:wiki-check example -->\n```\n";
        assert!(has_current_clear_stamp(&stamped(body, &stamp(body))));
        let saved = stamped("Body", &stamp("Body"));
        assert!(!has_current_clear_stamp(&stamped(&saved, &stamp(&saved))));
        assert!(!has_current_clear_stamp(
            "Body\n<!-- pix:wiki-check {broken} -->\n"
        ));
        let malformed_body = "Body\n<!-- pix:wiki-check {broken} -->\n";
        assert!(!has_current_clear_stamp(&stamped(
            malformed_body,
            &stamp(malformed_body)
        )));
        let oversized = format!("Body\n{STAMP_PREFIX}{} -->\n", "x".repeat(MAX_STAMP_BYTES));
        assert!(!has_current_clear_stamp(&oversized));
        assert!(!has_current_clear_stamp(&stamped(
            &oversized,
            &stamp(&oversized)
        )));
    }

    #[test]
    fn report_headers_never_coexist_with_a_green_stamp() {
        let report = format!("{REPORT_PREFIX}{{\"version\":1}} -->\n");
        let cases = [
            ("# Page\n", format!("{report}# Page\n")),
            ("\u{feff}# Page\n", format!("\u{feff}{report}# Page\n")),
            ("---\ntitle: Page\n---\n# Page\n", format!("---\ntitle: Page\n---\n\n{report}# Page\n")),
            ("---\ntitle: Page\n...\n# Page\n", format!("---\ntitle: Page\n...\n\n{report}# Page\n")),
            ("+++\ntitle = 'Page'\n+++\n# Page\n", format!("+++\ntitle = 'Page'\n+++\n\n{report}# Page\n")),
            ("\u{feff}---\r\ntitle: Page\r\n---\r\n# Page\r\n", format!("\u{feff}---\r\ntitle: Page\r\n---\r\n\n{report}# Page\r\n")),
            ("\u{feff}\u{feff}---\n---\nBody\n", format!("\u{feff}\u{feff}---\n---\n\n{report}Body\n")),
            ("---\ntitle: Page\n---", format!("---\ntitle: Page\n---\n{report}")),
            ("+++\ntitle = 'Page'\n+++", format!("+++\ntitle = 'Page'\n+++\n{report}")),
        ];
        for (body, with_report) in cases {
            assert!(has_report_header(&with_report));
            // Reject both a footer matching logical body and one hashing report JSON.
            assert!(!has_current_clear_stamp(&stamped(&with_report, &stamp(body))));
            assert!(!has_current_clear_stamp(&stamped(&with_report, &stamp(&with_report))));
            // A successful recheck removes its report; original body bytes hash identically.
            assert!(has_current_clear_stamp(&stamped(body, &stamp(body))));
        }
    }

    #[test]
    fn malformed_or_oversized_report_headers_fail_closed_but_body_examples_remain_text() {
        for with_report in [
            format!("{REPORT_PREFIX}broken\nBody"),
            format!("{REPORT_PREFIX}{{}} -->\n{REPORT_PREFIX}{{}} -->\nBody"),
            format!("{REPORT_PREFIX}{} -->\nBody", "x".repeat(384 * 1024 + 1)),
        ] {
            assert!(!has_current_clear_stamp(&stamped(&with_report, &stamp(&with_report))));
        }
        for body in [
            "```html\n<!-- pix:wiki-report example -->\n```\n",
            "# Examples\n\n<!-- pix:wiki-report example -->\n",
            "---\ntitle: Examples\n---\nText.\n<!-- pix:wiki-report example -->\n",
            " <!-- pix:wiki-report indented example -->\n",
        ] {
            assert!(!has_report_header(body));
            assert!(has_current_clear_stamp(&stamped(body, &stamp(body))));
        }
    }

    #[test]
    fn rejects_invalid_shape_scope_counts_model_and_dates() {
        let body = "Body";
        for (field, invalid) in [
            ("status", serde_json::json!("conflicts")),
            ("scope", serde_json::json!("whole-wiki")),
            ("version", serde_json::json!(2)),
            ("contentHash", serde_json::json!("f".repeat(64))),
            ("checkedSources", serde_json::json!(0)),
            ("checkedSources", serde_json::json!(1.5)),
            ("candidateSources", serde_json::json!(11)),
            ("candidateSources", serde_json::json!(4097)),
            ("modelRef", serde_json::json!(" ")),
            ("modelRef", serde_json::json!("x".repeat(513))),
            ("modelRef", serde_json::json!("model\n")),
            ("reportLanguage", serde_json::json!("fr")),
            ("checkedAt", serde_json::json!("2026-02-30T12:00:00.000Z")),
            ("checkedAt", serde_json::json!("2026-10-30T12:00:00Z")),
            ("checkedAt", serde_json::json!("2026-10-30T12:00:60.000Z")),
        ] {
            let mut metadata = stamp(body);
            metadata[field] = invalid;
            assert!(
                !has_current_clear_stamp(&stamped(body, &metadata)),
                "{field}: {metadata}"
            );
        }
        let mut metadata = stamp(body);
        metadata["unknown"] = serde_json::json!(true);
        assert!(!has_current_clear_stamp(&stamped(body, &metadata)));
        let mut metadata = stamp(body);
        metadata.as_object_mut().unwrap().remove("modelRef");
        assert!(!has_current_clear_stamp(&stamped(body, &metadata)));
    }

    #[test]
    fn listing_reads_only_bounded_markdown_and_clears_changed_body_status() {
        let workspace = Workspace::new();
        let saved = stamped("Body", &stamp("Body"));
        fs::write(workspace.0.join("page.md"), &saved).unwrap();
        fs::write(workspace.0.join("asset.txt"), &saved).unwrap();
        fs::write(workspace.0.join("bad.md"), [0xff, 0xfe]).unwrap();
        let big_body = "x".repeat(MAX_FILE_BYTES as usize);
        let big_saved = stamped(&big_body, &stamp(&big_body));
        assert!(!has_current_clear_stamp(&big_saved));
        fs::write(workspace.0.join("big.md"), big_saved).unwrap();
        fs::create_dir(workspace.0.join("group.md")).unwrap();
        let mut entries = vec![
            entry("page.md", ProjectTreeEntryKind::File),
            entry("asset.txt", ProjectTreeEntryKind::File),
            entry("group.md", ProjectTreeEntryKind::Directory),
            entry("bad.md", ProjectTreeEntryKind::File),
            entry("big.md", ProjectTreeEntryKind::File),
        ];
        annotate_project_entries(&workspace.0, &mut entries);
        assert_eq!(
            entries
                .iter()
                .map(|item| item.wiki_checked)
                .collect::<Vec<_>>(),
            [Some(true), None, None, Some(false), Some(false)]
        );
        fs::write(workspace.0.join("page.md"), format!("edited{saved}")).unwrap();
        annotate_project_entries(&workspace.0, &mut entries);
        assert_eq!(entries[0].wiki_checked, Some(false));
    }

    #[test]
    fn listing_total_byte_budget_prevents_later_reads_and_default_listing_is_unannotated() {
        let workspace = Workspace::new();
        let saved = stamped("Body", &stamp("Body"));
        fs::write(workspace.0.join("a.md"), &saved).unwrap();
        fs::write(workspace.0.join("b.MARKDOWN"), &saved).unwrap();
        let mut entries = super::super::list_project_directory_from(&workspace.0, None).unwrap();
        assert!(entries.iter().all(|entry| entry.wiki_checked.is_none()));
        annotate_with_budget(&workspace.0, &mut entries, saved.len() as u64 + 1);
        assert_eq!(entries[0].wiki_checked, Some(true));
        assert_eq!(entries[1].wiki_checked, Some(false));
    }

    #[cfg(unix)]
    #[test]
    fn listing_refuses_final_and_ancestor_symlinks() {
        use std::os::unix::fs::symlink;
        let workspace = Workspace::new();
        fs::create_dir(workspace.0.join("real")).unwrap();
        fs::write(
            workspace.0.join("real/page.md"),
            stamped("Body", &stamp("Body")),
        )
        .unwrap();
        symlink(
            workspace.0.join("real/page.md"),
            workspace.0.join("linked.md"),
        )
        .unwrap();
        symlink(workspace.0.join("real"), workspace.0.join("linked-dir")).unwrap();
        let mut entries = vec![
            entry("linked.md", ProjectTreeEntryKind::File),
            entry("linked-dir/page.md", ProjectTreeEntryKind::File),
            entry("../page.md", ProjectTreeEntryKind::File),
        ];
        annotate_project_entries(&workspace.0, &mut entries);
        assert!(entries
            .iter()
            .all(|entry| entry.wiki_checked == Some(false)));
    }

    #[cfg(unix)]
    #[test]
    fn unchanged_positive_and_negative_results_do_not_reread_files() {
        let workspace = Workspace::new();
        fs::write(
            workspace.0.join("checked.md"),
            stamped("Body", &stamp("Body")),
        )
        .unwrap();
        fs::write(workspace.0.join("plain.md"), "An unchecked page.").unwrap();
        fs::write(
            workspace.0.join("malformed.md"),
            "Body\n<!-- pix:wiki-check {broken} -->\n",
        )
        .unwrap();
        let mut entries = ["checked.md", "plain.md", "malformed.md"]
            .map(|path| entry(path, ProjectTreeEntryKind::File));
        let cache = Mutex::new(StampCache::new(8));
        let reads = Cell::new(0);

        annotate_counted(
            &workspace,
            &mut entries,
            &cache,
            &reads,
            MAX_DIRECTORY_BYTES,
        );
        assert_eq!(reads.get(), 3);
        assert_eq!(
            entries.each_ref().map(|entry| entry.wiki_checked),
            [Some(true), Some(false), Some(false)]
        );
        // A warm cache needs no byte budget, even for a negative or malformed stamp.
        annotate_counted(&workspace, &mut entries, &cache, &reads, 0);
        assert_eq!(reads.get(), 3);
        assert_eq!(
            entries.each_ref().map(|entry| entry.wiki_checked),
            [Some(true), Some(false), Some(false)]
        );
    }

    #[cfg(unix)]
    #[test]
    fn cached_green_turns_off_for_an_inline_report_and_returns_after_report_removal() {
        let workspace = Workspace::new();
        let path = workspace.0.join("page.md");
        let body = "---\ntitle: Page\n---\nBody\n";
        let clear = stamped(body, &stamp(body));
        fs::write(&path, &clear).unwrap();
        let mut entries = [entry("page.md", ProjectTreeEntryKind::File)];
        let cache = Mutex::new(StampCache::new(4));
        let reads = Cell::new(0);
        annotate_counted(&workspace, &mut entries, &cache, &reads, MAX_DIRECTORY_BYTES);
        assert_eq!(entries[0].wiki_checked, Some(true));

        let report_body = format!("---\ntitle: Page\n---\n\n{REPORT_PREFIX}{{}} -->\nBody\n");
        fs::write(&path, stamped(&report_body, &stamp(&report_body))).unwrap();
        annotate_counted(&workspace, &mut entries, &cache, &reads, MAX_DIRECTORY_BYTES);
        assert_eq!(reads.get(), 2);
        assert_eq!(entries[0].wiki_checked, Some(false));
        annotate_counted(&workspace, &mut entries, &cache, &reads, 0);
        assert_eq!(reads.get(), 2);
        assert_eq!(entries[0].wiki_checked, Some(false));

        fs::write(&path, clear).unwrap();
        annotate_counted(&workspace, &mut entries, &cache, &reads, MAX_DIRECTORY_BYTES);
        assert_eq!(reads.get(), 3);
        assert_eq!(entries[0].wiki_checked, Some(true));
    }

    #[cfg(unix)]
    #[test]
    fn same_size_edits_and_replaced_inodes_invalidate_cached_results() {
        use std::os::unix::fs::MetadataExt;
        let workspace = Workspace::new();
        let path = workspace.0.join("page.md");
        let saved = stamped("Body", &stamp("Body"));
        fs::write(&path, &saved).unwrap();
        let mut entries = [entry("page.md", ProjectTreeEntryKind::File)];
        let cache = Mutex::new(StampCache::new(8));
        let reads = Cell::new(0);
        annotate_counted(
            &workspace,
            &mut entries,
            &cache,
            &reads,
            MAX_DIRECTORY_BYTES,
        );
        assert_eq!(entries[0].wiki_checked, Some(true));

        let original = fs::metadata(&path).unwrap();
        fs::write(&path, saved.replacen("Body", "Edit", 1)).unwrap();
        let edited_time = UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        set_modified(&path, edited_time);
        let edited = fs::metadata(&path).unwrap();
        assert_eq!(original.len(), edited.len());
        assert_eq!(original.ino(), edited.ino());
        assert_ne!(original.modified().unwrap(), edited.modified().unwrap());
        annotate_counted(
            &workspace,
            &mut entries,
            &cache,
            &reads,
            MAX_DIRECTORY_BYTES,
        );
        assert_eq!(reads.get(), 2);
        assert_eq!(entries[0].wiki_checked, Some(false));

        let replacement = workspace.0.join("replacement.md");
        fs::write(&replacement, &saved).unwrap();
        set_modified(&replacement, edited_time);
        let replacing = fs::metadata(&replacement).unwrap();
        assert_eq!(edited.len(), replacing.len());
        assert_eq!(edited.modified().unwrap(), replacing.modified().unwrap());
        assert_ne!(edited.ino(), replacing.ino());
        fs::rename(replacement, &path).unwrap();
        annotate_counted(
            &workspace,
            &mut entries,
            &cache,
            &reads,
            MAX_DIRECTORY_BYTES,
        );
        assert_eq!(reads.get(), 3);
        assert_eq!(entries[0].wiki_checked, Some(true));
    }

    #[cfg(unix)]
    #[test]
    fn cached_results_are_isolated_by_workspace_and_track_ctime() {
        let first = Workspace::new();
        let second = Workspace::new();
        fs::write(first.0.join("page.md"), stamped("Body", &stamp("Body"))).unwrap();
        fs::write(second.0.join("page.md"), "No check here.").unwrap();
        let cache = Mutex::new(StampCache::new(8));
        let reads = Cell::new(0);
        let mut entries = [entry("page.md", ProjectTreeEntryKind::File)];
        annotate_counted(&first, &mut entries, &cache, &reads, MAX_DIRECTORY_BYTES);
        assert_eq!(entries[0].wiki_checked, Some(true));
        annotate_counted(&second, &mut entries, &cache, &reads, MAX_DIRECTORY_BYTES);
        assert_eq!(entries[0].wiki_checked, Some(false));
        annotate_counted(&first, &mut entries, &cache, &reads, 0);
        assert_eq!(entries[0].wiki_checked, Some(true));
        assert_eq!(reads.get(), 2);

        let root = super::super::canonical_workspace(&first.0).unwrap();
        let key = CacheKey {
            path: root.join("page.md"),
            workspace: root,
        };
        let signature = FileSignature::from_metadata(&fs::metadata(&key.path).unwrap()).unwrap();
        let mut changed = signature.clone();
        // Simulate an in-place edit with restored mtime: ctime alone invalidates it.
        changed.changed_nanoseconds ^= 1;
        let mut cache = cache.lock().unwrap();
        assert_eq!(cache.get(&key, &signature), Some(true));
        assert_eq!(cache.get(&key, &changed), None);
    }

    #[cfg(unix)]
    #[test]
    fn warm_entries_do_not_spend_the_read_budget_for_uncached_files() {
        let workspace = Workspace::new();
        let saved = stamped("Body", &stamp("Body"));
        for path in ["a.md", "b.md"] {
            fs::write(workspace.0.join(path), &saved).unwrap();
        }
        let cache = Mutex::new(StampCache::new(8));
        let reads = Cell::new(0);
        let mut first = [entry("a.md", ProjectTreeEntryKind::File)];
        let one_file_budget = saved.len() as u64 + 1;
        annotate_counted(&workspace, &mut first, &cache, &reads, one_file_budget);
        let mut entries = [
            entry("a.md", ProjectTreeEntryKind::File),
            entry("b.md", ProjectTreeEntryKind::File),
        ];
        annotate_counted(&workspace, &mut entries, &cache, &reads, one_file_budget);
        assert_eq!(reads.get(), 2);
        assert!(entries.iter().all(|entry| entry.wiki_checked == Some(true)));
    }

    #[cfg(unix)]
    #[test]
    fn cached_paths_still_refuse_final_and_ancestor_symlinks() {
        use std::os::unix::fs::symlink;
        let workspace = Workspace::new();
        fs::create_dir(workspace.0.join("real")).unwrap();
        let saved = stamped("Body", &stamp("Body"));
        fs::write(workspace.0.join("real/page.md"), &saved).unwrap();
        fs::write(workspace.0.join("direct.md"), &saved).unwrap();
        let cache = Mutex::new(StampCache::new(8));
        let reads = Cell::new(0);
        let mut entries = ["real/page.md", "direct.md", "../outside.md"]
            .map(|path| entry(path, ProjectTreeEntryKind::File));
        annotate_counted(
            &workspace,
            &mut entries,
            &cache,
            &reads,
            MAX_DIRECTORY_BYTES,
        );
        assert_eq!(reads.get(), 2);
        assert_eq!(
            entries.each_ref().map(|entry| entry.wiki_checked),
            [Some(true), Some(true), Some(false)]
        );

        fs::rename(workspace.0.join("real"), workspace.0.join("moved")).unwrap();
        symlink(workspace.0.join("moved"), workspace.0.join("real")).unwrap();
        fs::rename(
            workspace.0.join("direct.md"),
            workspace.0.join("moved/direct.md"),
        )
        .unwrap();
        symlink(
            workspace.0.join("moved/direct.md"),
            workspace.0.join("direct.md"),
        )
        .unwrap();
        annotate_counted(
            &workspace,
            &mut entries,
            &cache,
            &reads,
            MAX_DIRECTORY_BYTES,
        );
        assert_eq!(reads.get(), 2);
        assert!(entries
            .iter()
            .all(|entry| entry.wiki_checked == Some(false)));
    }

    #[cfg(unix)]
    #[test]
    fn changing_and_failed_reads_are_not_cached() {
        let workspace = Workspace::new();
        let saved = stamped("Body", &stamp("Body"));
        fs::write(workspace.0.join("page.md"), &saved).unwrap();
        let mut entries = [entry("page.md", ProjectTreeEntryKind::File)];
        let cache = Mutex::new(StampCache::new(8));
        let reads = Cell::new(0);
        annotate_with_cache_and_reader(
            &workspace.0,
            &mut entries,
            MAX_DIRECTORY_BYTES,
            &cache,
            |root, path, limit| {
                assert!(cache.try_lock().is_ok());
                reads.set(reads.get() + 1);
                let content = read_document(root, path, limit);
                fs::write(root.join(path), format!("changed{saved}")).unwrap();
                content
            },
        );
        assert_eq!(entries[0].wiki_checked, Some(false));
        assert!(cache.lock().unwrap().entries.is_empty());

        fs::write(workspace.0.join("page.md"), saved).unwrap();
        annotate_with_cache_and_reader(
            &workspace.0,
            &mut entries,
            MAX_DIRECTORY_BYTES,
            &cache,
            |_, _, _| {
                reads.set(reads.get() + 1);
                None
            },
        );
        assert_eq!(entries[0].wiki_checked, Some(false));
        assert!(cache.lock().unwrap().entries.is_empty());
        annotate_counted(
            &workspace,
            &mut entries,
            &cache,
            &reads,
            MAX_DIRECTORY_BYTES,
        );
        assert_eq!(reads.get(), 3);
        assert_eq!(entries[0].wiki_checked, Some(true));
    }

    #[cfg(unix)]
    #[test]
    fn cache_evicts_least_recent_entries_and_keeps_recency_storage_bounded() {
        let workspace = Workspace::new();
        fs::write(workspace.0.join("page.md"), "Body").unwrap();
        let root = super::super::canonical_workspace(&workspace.0).unwrap();
        let signature =
            FileSignature::from_metadata(&fs::metadata(root.join("page.md")).unwrap()).unwrap();
        let key = |name: &str| CacheKey {
            workspace: root.clone(),
            path: root.join(name),
        };
        let mut cache = StampCache::new(2);
        cache.insert(key("a.md"), signature.clone(), true);
        cache.insert(key("b.md"), signature.clone(), false);
        for _ in 0..100 {
            assert_eq!(cache.get(&key("a.md"), &signature), Some(true));
            assert_eq!(cache.recency.len(), 2);
        }
        cache.insert(key("c.md"), signature.clone(), true);
        assert_eq!(cache.get(&key("b.md"), &signature), None);
        assert_eq!(cache.get(&key("a.md"), &signature), Some(true));
        for index in 0..100 {
            cache.insert(key(&format!("page-{index}.md")), signature.clone(), false);
            assert_eq!(cache.entries.len(), 2);
            assert_eq!(cache.recency.len(), 2);
        }
        cache.next_use = u64::MAX;
        cache.insert(key("after-counter-reset.md"), signature.clone(), true);
        assert_eq!(cache.entries.len(), 1);
        assert_eq!(cache.recency.len(), 1);
        assert_eq!(
            cache.get(&key("after-counter-reset.md"), &signature),
            Some(true)
        );
    }
}
