//! Full-history commit search for Universal Search. Every walk is cancellable by
//! request id (the frontend cancels when its search signal aborts) and bounded
//! by a deadline, so stale per-keystroke walks cannot pile up in large repos.
use super::{git_command, git_has_head, git_repository_root, run_blocking};
use crate::{
    git_operations::GitHistoryEntry,
    git_process::{supervise, SupervisedError},
};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

const HISTORY_SEARCH_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_HISTORY_SEARCH_RESULTS: usize = 20;
const MAX_PENDING_REQUESTS: usize = 128;
const CANCELLED_TOMBSTONE_TTL: Duration = Duration::from_secs(60);
const CANCELLED: &str = "Git history search cancelled";

struct Request {
    window: String,
    token: Arc<AtomicBool>,
    created: Instant,
}

#[derive(Default)]
pub(crate) struct GitHistorySearchState(Mutex<HashMap<String, Request>>);

impl GitHistorySearchState {
    /// Look up or create the request token. A cancel can arrive before its
    /// search starts (commands may be scheduled out of order), so the cancel
    /// leaves a short-lived tombstone that the later start observes.
    fn token(&self, id: &str, window: &str) -> Result<Option<Arc<AtomicBool>>, String> {
        if id.is_empty()
            || id.len() > 80
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err("Invalid history search request id".into());
        }
        let mut requests = self
            .0
            .lock()
            .map_err(|_| "History search state is unavailable")?;
        requests.retain(|_, request| {
            Arc::strong_count(&request.token) > 1
                || request.created.elapsed() < CANCELLED_TOMBSTONE_TTL
        });
        if let Some(request) = requests.get(id) {
            // Never let another window observe or cancel this request.
            return Ok((request.window == window).then(|| Arc::clone(&request.token)));
        }
        if requests.len() >= MAX_PENDING_REQUESTS {
            return Err("Too many Git history searches are pending".into());
        }
        let token = Arc::new(AtomicBool::new(false));
        requests.insert(
            id.to_owned(),
            Request {
                window: window.to_owned(),
                token: Arc::clone(&token),
                created: Instant::now(),
            },
        );
        Ok(Some(token))
    }

    fn cancel(&self, id: &str, window: &str) -> Result<(), String> {
        if let Some(token) = self.token(id, window)? {
            token.store(true, Ordering::Release);
        }
        Ok(())
    }

    fn finish(&self, id: &str, token: &Arc<AtomicBool>) {
        if let Ok(mut requests) = self.0.lock() {
            if requests
                .get(id)
                .is_some_and(|request| Arc::ptr_eq(&request.token, token))
            {
                requests.remove(id);
            }
        }
    }
}

#[tauri::command]
pub(crate) async fn git_search_history(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, GitHistorySearchState>,
    workspace: String,
    query: String,
    request_id: String,
) -> Result<Vec<GitHistoryEntry>, String> {
    let token = state
        .token(&request_id, window.label())?
        .ok_or("History search request belongs to another window")?;
    let worker_token = Arc::clone(&token);
    let result = run_blocking(move || {
        search_history_from(
            Path::new(&workspace),
            &query,
            &worker_token,
            HISTORY_SEARCH_TIMEOUT,
        )
    })
    .await;
    state.finish(&request_id, &token);
    result
}

#[tauri::command]
pub(crate) fn git_search_history_cancel(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, GitHistorySearchState>,
    request_id: String,
) -> Result<(), String> {
    state.cancel(&request_id, window.label())
}

pub(crate) fn search_history_from(
    workspace: &Path,
    query: &str,
    cancelled: &AtomicBool,
    timeout: Duration,
) -> Result<Vec<GitHistoryEntry>, String> {
    let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    if words.is_empty() {
        return Ok(Vec::new());
    }
    if cancelled.load(Ordering::Acquire) {
        return Err(CANCELLED.into());
    }
    let root = git_repository_root(workspace)?;
    if !git_has_head(&root)? {
        return Ok(Vec::new());
    }

    // Stream all commits reachable from HEAD. Keep only the best twenty rows;
    // unlike `git_history`, this deliberately has no history-depth limit.
    let mut command = git_command(
        &root,
        &[
            "log",
            "--no-show-signature",
            "--format=%H%x00%h%x00%s%x00%an%x00%aI%x00",
        ],
    );
    let (status, ranked, ()) = supervise(
        &mut command,
        timeout,
        Some(cancelled),
        move |stdout| rank_history(BufReader::new(stdout), &words),
        |mut stderr| {
            let _ = std::io::copy(&mut stderr, &mut std::io::sink());
        },
    )
    .map_err(|error| match error {
        SupervisedError::Cancelled => CANCELLED.to_owned(),
        SupervisedError::TimedOut => format!(
            "Git history search timed out after {} seconds; refine the query.",
            timeout.as_secs()
        ),
        error => format!("failed to run git log for history search: {error}"),
    })?;
    let ranked =
        ranked.map_err(|error| format!("failed to read Git history search output: {error}"))?;
    if !status.success() {
        return Err("Git history search failed".to_owned());
    }
    Ok(ranked)
}

fn rank_history(
    mut reader: impl BufRead,
    words: &[String],
) -> std::io::Result<Vec<GitHistoryEntry>> {
    let mut field = Vec::new();
    let mut best: Vec<(usize, usize, GitHistoryEntry)> =
        Vec::with_capacity(MAX_HISTORY_SEARCH_RESULTS);
    let mut newest_order = 0usize;
    let result = (|| -> std::io::Result<()> {
        loop {
            let mut fields: Vec<String> = Vec::with_capacity(5);
            for _ in 0..5 {
                field.clear();
                if reader.read_until(0, &mut field)? == 0 {
                    return if fields.is_empty()
                        || (fields.len() == 1 && fields[0].trim().is_empty())
                    {
                        Ok(())
                    } else {
                        Err(std::io::Error::new(
                            std::io::ErrorKind::UnexpectedEof,
                            "incomplete Git history record",
                        ))
                    };
                }
                if field.last() == Some(&0) {
                    field.pop();
                }
                fields.push(String::from_utf8_lossy(&field).into_owned());
            }
            fields[0] = fields[0].trim_start_matches(['\n', '\r']).to_owned();
            if fields[0].is_empty() {
                return Ok(());
            }
            let mut fields = fields.into_iter();
            let mut next = || fields.next().unwrap_or_default();
            let entry = GitHistoryEntry {
                hash: next(),
                short_hash: next(),
                subject: next(),
                author: next(),
                date: next(),
            };
            let subject = entry.subject.to_lowercase();
            let metadata = format!("{} {}", entry.hash, entry.author).to_lowercase();
            let score: usize = words
                .iter()
                .map(|word| {
                    if subject.contains(word) {
                        2
                    } else if metadata.contains(word) {
                        1
                    } else {
                        0
                    }
                })
                .sum();
            if score > 0 {
                best.push((score, newest_order, entry));
                best.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
                best.truncate(MAX_HISTORY_SEARCH_RESULTS);
            }
            newest_order = newest_order.saturating_add(1);
        }
    })();
    if result.is_err() {
        // Drain so the writer is not blocked on a full pipe before it is reaped.
        let _ = std::io::copy(&mut reader.take(u64::MAX), &mut std::io::sink());
    }
    result.map(|()| best.into_iter().map(|(_, _, entry)| entry).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_output;
    use std::{fs, path::PathBuf, sync::atomic::AtomicU64};

    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Repository(PathBuf);
    impl Repository {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "pix-git-history-search-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            git_output(&path, &["init", "-b", "main"]).unwrap();
            git_output(&path, &["config", "user.name", "Pix Test"]).unwrap();
            git_output(&path, &["config", "user.email", "pix@example.invalid"]).unwrap();
            git_output(&path, &["config", "commit.gpgsign", "false"]).unwrap();
            Self(path)
        }
        fn commit(&self, text: &str) {
            fs::write(self.0.join("tracked.txt"), text).unwrap();
            git_output(&self.0, &["add", "tracked.txt"]).unwrap();
            git_output(&self.0, &["commit", "-m", text]).unwrap();
        }
        fn head(&self) -> String {
            String::from_utf8(git_output(&self.0, &["rev-parse", "HEAD"]).unwrap().stdout)
                .unwrap()
                .trim()
                .to_owned()
        }
    }
    impl Drop for Repository {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn search(repo: &Path, query: &str) -> Result<Vec<GitHistoryEntry>, String> {
        search_history_from(repo, query, &AtomicBool::new(false), HISTORY_SEARCH_TIMEOUT)
    }

    #[test]
    fn git_history_search_scans_all_head_ancestors_and_matches_metadata() {
        let repo = Repository::new();
        assert!(search(&repo.0, "change").unwrap().is_empty());
        repo.commit("oldest needle commit");
        let oldest_hash = repo.head();
        for index in 1..36 {
            repo.commit(&format!("ordinary change {index}"));
        }

        let by_subject = search(&repo.0, "needle").unwrap();
        assert_eq!(by_subject.len(), 1);
        assert_eq!(by_subject[0].hash, oldest_hash);
        assert_eq!(by_subject[0].subject, "oldest needle commit");
        let by_author = search(&repo.0, "pix test").unwrap();
        assert_eq!(by_author.len(), 20);
        assert_eq!(by_author[0].hash, repo.head());
        assert_eq!(
            search(&repo.0, &oldest_hash[..8]).unwrap()[0].hash,
            oldest_hash
        );
        assert!(search(&repo.0, "  ").unwrap().is_empty());
    }

    #[test]
    fn git_history_search_rejects_non_repositories() {
        let directory = std::env::temp_dir().join(format!(
            "pix-not-git-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&directory).unwrap();
        assert!(search(&directory, "needle").is_err());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn cancelled_history_search_does_not_walk_history() {
        let repo = Repository::new();
        repo.commit("needle");
        let cancelled = AtomicBool::new(true);
        assert_eq!(
            search_history_from(&repo.0, "needle", &cancelled, HISTORY_SEARCH_TIMEOUT).unwrap_err(),
            CANCELLED
        );
    }

    #[test]
    fn ranking_reports_truncated_records_and_keeps_newest_ties_first() {
        let words = vec!["fix".to_owned()];
        let stream = b"a\0a\0fix one\0me\0d\0\nb\0b\0fix two\0me\0d\0\n";
        let ranked = rank_history(&stream[..], &words).unwrap();
        assert_eq!(
            ranked
                .iter()
                .map(|entry| entry.hash.as_str())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert!(rank_history(&b"a\0a\0fix"[..], &words).is_err());
    }

    #[test]
    fn cancel_before_start_is_observed_and_finish_releases_only_its_own_request() {
        let state = GitHistorySearchState::default();
        state.cancel("late-start", "main").unwrap();
        let token = state.token("late-start", "main").unwrap().unwrap();
        assert!(token.load(Ordering::Acquire));
        state.finish("late-start", &token);
        assert!(!state.0.lock().unwrap().contains_key("late-start"));

        let running = state.token("running", "main").unwrap().unwrap();
        // A cancel from another window is ignored.
        state.cancel("running", "other").unwrap();
        assert!(!running.load(Ordering::Acquire));
        state.cancel("running", "main").unwrap();
        assert!(running.load(Ordering::Acquire));
        state.finish("running", &Arc::new(AtomicBool::new(false)));
        assert!(state.0.lock().unwrap().contains_key("running"));
        state.finish("running", &running);
        assert!(state.0.lock().unwrap().is_empty());
        assert!(state.token("bad id!", "main").is_err());
    }

    #[test]
    fn stale_cancel_tombstones_are_pruned_but_running_requests_are_kept() {
        let state = GitHistorySearchState::default();
        let running = state.token("running", "main").unwrap().unwrap();
        state.cancel("abandoned", "main").unwrap();
        for request in state.0.lock().unwrap().values_mut() {
            request.created = Instant::now() - CANCELLED_TOMBSTONE_TTL * 2;
        }
        state.token("next", "main").unwrap();
        let requests = state.0.lock().unwrap();
        assert!(requests.contains_key("running"));
        assert!(!requests.contains_key("abandoned"));
        drop(requests);
        drop(running);
    }
}
