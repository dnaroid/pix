//! Bounded, metadata-keyed checklist counts; plan contents never cross IPC.
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, Metadata};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use pulldown_cmark::{Event, Options, Parser};
use serde::Serialize;

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SCAN_BYTES: u64 = 8 * 1024 * 1024;
const MAX_CACHE_ENTRIES: usize = 1024;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PlanProgress {
    completed: u32,
    total: u32,
}

#[derive(Debug, PartialEq, Eq)]
struct Stamp {
    len: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}

impl Stamp {
    fn from(metadata: &Metadata) -> Self {
        Self {
            len: metadata.len(),
            modified: metadata.modified().ok(),
            #[cfg(unix)]
            identity: {
                use std::os::unix::fs::MetadataExt;
                (
                    metadata.dev(),
                    metadata.ino(),
                    metadata.ctime(),
                    metadata.ctime_nsec(),
                )
            },
        }
    }
}

struct Entry {
    stamp: Stamp,
    progress: Option<PlanProgress>,
    touched: u64,
}

#[derive(Default)]
struct Cache {
    entries: HashMap<PathBuf, Entry>,
    clock: u64,
}

fn count(content: &str) -> PlanProgress {
    let options = Options::ENABLE_TASKLISTS
        | Options::ENABLE_YAML_STYLE_METADATA_BLOCKS
        | Options::ENABLE_PLUSES_DELIMITED_METADATA_BLOCKS;
    let mut progress = PlanProgress::default();
    for event in Parser::new_ext(content, options) {
        if let Event::TaskListMarker(checked) = event {
            progress.total += 1;
            progress.completed += u32::from(checked);
        }
    }
    progress
}

impl Cache {
    fn read(&mut self, path: &Path, budget: &mut u64) -> Result<Option<PlanProgress>, String> {
        let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("plan progress requires a regular file".into());
        }
        let stamp = Stamp::from(&metadata);
        self.clock = self.clock.wrapping_add(1);
        if let Some(entry) = self.entries.get_mut(path) {
            if entry.stamp == stamp {
                entry.touched = self.clock;
                return Ok(entry.progress);
            }
        }
        if stamp.len > MAX_FILE_BYTES {
            self.insert(path, stamp, None);
            return Ok(None);
        }
        if stamp.len > *budget {
            return Ok(None); // Leave uncached so the next bounded scan can try again.
        }
        *budget -= stamp.len;
        let mut open = File::options();
        open.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            open.custom_flags(libc::O_NOFOLLOW);
        }
        let file = open.open(path).map_err(|error| error.to_string())?;
        let opened_stamp = Stamp::from(&file.metadata().map_err(|error| error.to_string())?);
        if opened_stamp != stamp {
            return Ok(None);
        }
        let mut bytes = Vec::new();
        file.take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if Stamp::from(&fs::symlink_metadata(path).map_err(|error| error.to_string())?) != stamp {
            return Ok(None); // Do not cache content read during a concurrent write/replace.
        }
        let progress = if bytes.len() as u64 > MAX_FILE_BYTES {
            None
        } else {
            std::str::from_utf8(&bytes).ok().map(count)
        };
        self.insert(path, stamp, progress);
        Ok(progress)
    }

    fn insert(&mut self, path: &Path, stamp: Stamp, progress: Option<PlanProgress>) {
        if self.entries.len() >= MAX_CACHE_ENTRIES && !self.entries.contains_key(path) {
            if let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.touched)
                .map(|(path, _)| path.clone())
            {
                self.entries.remove(&oldest);
            }
        }
        self.entries.insert(
            path.to_owned(),
            Entry {
                stamp,
                progress,
                touched: self.clock,
            },
        );
    }
}

pub(super) fn snapshot(root: &Path, plans: &[String]) -> BTreeMap<String, Option<PlanProgress>> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    let mut cache = CACHE
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut budget = MAX_SCAN_BYTES;
    plans
        .iter()
        .map(|relative| {
            let path = root.join(relative);
            let progress = fs::canonicalize(&path)
                .ok()
                .filter(|canonical| canonical == &path && canonical.starts_with(root))
                .and_then(|_| match cache.read(&path, &mut budget) {
                    Ok(progress) => progress,
                    Err(error) => {
                        // Remember a failed version too; do not warn every poll.
                        if let Ok(metadata) = fs::symlink_metadata(&path) {
                            cache.insert(&path, Stamp::from(&metadata), None);
                        }
                        crate::logging::record(
                            "warn",
                            module_path!(),
                            "plan_progress_read_failed",
                            serde_json::json!({ "path": relative, "error": error }),
                            Some(&root.to_string_lossy()),
                        );
                        None
                    }
                });
            (relative.clone(), progress)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../.pi/artifacts")
                .join(format!(
                    "plan-progress-{}-{}",
                    std::process::id(),
                    SystemTime::now()
                        .duration_since(SystemTime::UNIX_EPOCH)
                        .unwrap()
                        .as_nanos()
                ));
            fs::create_dir_all(&path).unwrap();
            Self(path.canonicalize().unwrap())
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn read(cache: &mut Cache, path: &Path) -> Option<PlanProgress> {
        let mut budget = MAX_SCAN_BYTES;
        cache.read(path, &mut budget).unwrap()
    }

    #[test]
    fn counts_markdown_tasks_not_examples_or_metadata() {
        let text = "---\nexample: |\n  - [x] metadata\n---\n# Plan\n- [x] done\n- [ ] todo\n  - [X] nested\n1. [x] ordered\n> - [ ] quoted\n\n```md\n- [x] sample\n```\n\n~~~\n- [ ] sample\n~~~\n\n<!--\n- [x] comment\n-->\n\n    - [x] indented code\n\n`- [x] inline`\n- [-] not a task\n";
        assert_eq!(
            count(text),
            PlanProgress {
                completed: 3,
                total: 5
            }
        );
        assert_eq!(count("# no tasks"), PlanProgress::default());
    }

    #[test]
    fn cache_skips_unchanged_reads_and_detects_replacements_and_deletion() {
        let fixture = Fixture::new();
        let root = &fixture.0;
        let path = root.join("plan.md");
        fs::write(&path, "- [ ] task").unwrap();
        let mut cache = Cache::default();
        assert_eq!(read(&mut cache, &path).unwrap().completed, 0);
        // With no read budget, only a cache hit can return a known result.
        assert_eq!(cache.read(&path, &mut 0).unwrap().unwrap().total, 1);
        fs::write(root.join("replacement"), "- [x] task").unwrap();
        fs::rename(root.join("replacement"), &path).unwrap();
        assert_eq!(read(&mut cache, &path).unwrap().completed, 1);
        fs::write(&path, "- [ ] task").unwrap();
        assert_eq!(read(&mut cache, &path).unwrap().completed, 0);
        fs::remove_file(&path).unwrap();
        assert!(cache.read(&path, &mut 0).is_err());
    }

    #[test]
    fn bounds_reads_and_does_not_count_binary_or_oversized_files() {
        let fixture = Fixture::new();
        let root = &fixture.0;
        let path = root.join("plan.md");
        fs::write(&path, "- [x] task").unwrap();
        let mut cache = Cache::default();
        assert_eq!(cache.read(&path, &mut 0).unwrap(), None);
        assert!(cache.entries.is_empty());
        assert!(read(&mut cache, &path).is_some());
        fs::write(&path, [0xff, 0xfe]).unwrap();
        assert_eq!(read(&mut cache, &path), None);
        File::create(&path)
            .unwrap()
            .set_len(MAX_FILE_BYTES + 1)
            .unwrap();
        assert_eq!(read(&mut cache, &path), None);
    }

    #[test]
    fn bounds_cache_and_keeps_recent_entries() {
        let mut cache = Cache::default();
        for index in 0..=MAX_CACHE_ENTRIES {
            cache.clock += 1;
            let stamp = Stamp {
                len: 0,
                modified: None,
                #[cfg(unix)]
                identity: (0, 0, 0, 0),
            };
            cache.insert(Path::new(&format!("{index}.md")), stamp, None);
        }
        assert_eq!(cache.entries.len(), MAX_CACHE_ENTRIES);
        assert!(!cache.entries.contains_key(Path::new("0.md")));
        assert!(cache
            .entries
            .contains_key(Path::new(&format!("{MAX_CACHE_ENTRIES}.md"))));
    }

    #[test]
    fn snapshots_keep_workspaces_separate_and_skip_escaping_paths() {
        let first = Fixture::new();
        let second = Fixture::new();
        fs::write(first.0.join("plan.md"), "- [x] first").unwrap();
        fs::write(second.0.join("plan.md"), "- [ ] second").unwrap();
        let plans = vec!["plan.md".to_owned()];
        assert_eq!(snapshot(&first.0, &plans)["plan.md"].unwrap().completed, 1);
        assert_eq!(snapshot(&second.0, &plans)["plan.md"].unwrap().completed, 0);
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(second.0.join("plan.md"), first.0.join("link.md")).unwrap();
            assert_eq!(snapshot(&first.0, &["link.md".into()])["link.md"], None);
        }
    }
}
