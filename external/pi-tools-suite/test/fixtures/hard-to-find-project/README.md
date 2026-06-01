# Hard-to-find code-location benchmark fixture

This fixture is intentionally shaped like a noisy service so we can compare how
many tokens different tool strategies spend before they locate one small code
region.

## Benchmark task

Prompt the agent with:

> Support says opening the renewal-reminder preview page can make tomorrow's real
> reminder disappear. Find the exact code that marks the account as contacted
> during preview/dry-run, and explain the condition that causes it.

Ground truth is recorded in `benchmark/manifest.json`. The expected hit is not
in a file named after reminders, previews, contacts, or dry-runs. Those terms are
spread across decoy files on purpose.

## Why this is hard

- The user-facing words are translated several times: preview -> rehearsal ->
  shadow intent, reminder -> nudge, contacted -> pulse marker.
- Obvious files contain plausible policy and audit code but not the mutation.
- The bug lives in a generic transport/folding helper that looks infrastructure-
  oriented.
- Literal searches for `preview`, `dry-run`, `reminder`, or `contacted` return
  mostly decoys.
- The target assignment is small and only becomes meaningful after following the
  call chain from retention preview planning into the platform transit layer.

## Optional live benchmark harness

Run from this fixture directory or from `pi-tools-suite`:

```sh
PI_LOCATE_BENCH_MODEL=zai/glm-5-turbo \
node test/fixtures/hard-to-find-project/benchmark/run-locate-benchmark.mjs
```

The harness runs several tool allowlists, records tool calls/results with a small
Pi extension, analyzes parent and sub-agent session artifacts, and estimates
search-token cost as `ceil(serialized chars / 4)`. This is a rough comparison
metric, not provider billing data. The primary `burnedTokens` metric counts only
the parent agent's tool I/O; sub-agent session tokens are reported separately for
context. The summary also reports `totalEstimatedTokens`, which adds parent and
sub-agent token estimates for a fairer cross-mode comparison.

Default modes cover direct read/grep, AST search, semantic `repo_search`, the
broader repo-discovery surface, one delegated `subagents` search, and the
unrestricted suite. Set
`PI_LOCATE_BENCH_MODES=direct-read-grep,semantic-repo-search,subagent-search` to
run a subset. Set `PI_LOCATE_BENCH_FAKE_IDX=1` when you want deterministic
repo-search output for E2E validation instead of a real local idx index.
When fake idx is disabled, each indexed mode first runs `idx init` inside that
mode's temporary fixture copy so semantic `repo_search` uses a real index. This
is a separate preparation step before the agent process starts; it is reported
under `preparation` and is not included in the agent elapsed time or rough
tool-IO token metric.

Progress is printed to stderr as each mode starts and finishes, including the
temporary working directory used for that run. Set `PI_LOCATE_BENCH_KEEP=1` to
preserve those per-mode copies for debugging. At the end, the harness prints a
human-readable result table to stderr sorted by `totalEstimatedTokens`, while
also printing a `file://` link to the HTML report. The full JSON is always saved
to `report.json`; set `PI_LOCATE_BENCH_PRINT_JSON=1` only if you also want the
JSON echoed to stdout.
Modes run in parallel by default. Set `PI_LOCATE_BENCH_CONCURRENCY=1` for the
old sequential behavior, or another positive number to cap parallel mode runs.
If one mode exceeds `PI_LOCATE_BENCH_TIMEOUT_MS`, the harness marks that result
with `timedOut: true`, keeps any partial tool/session metrics it can read, and
continues with the remaining modes instead of aborting the full benchmark.

Every run writes a report directory. By default it is created under
`pi-tools-suite/reports/locate-benchmark/<timestamp>/` and contains:

- `report.json` — the complete machine-readable benchmark result.
- `index.html` — a standalone HTML report with the summary table sorted by
  parent tool-I/O tokens, a color bar chart for parent token spend, per-mode
  details, tool-call sequences, persisted stdout/stderr/tool event logs, answer
  previews, sub-agent metrics, raw JSON tabs, per-mode “↑ top” navigation, and
  embedded Pi HTML session exports. For the delegated sub-agent mode, exported
  sub-agent sessions are shown in a dedicated `Sub-agent HTML` tab.
- `modes/<mode>/...` — copied per-mode artifacts. When session files are
  available, the harness also copies them and asks Pi to export them to HTML via
  `pi --export`, then links/embeds those exports from the report page.

Useful report environment variables:

- `PI_LOCATE_BENCH_REPORT_DIR=/path/to/dir` — choose the output directory.
- `PI_LOCATE_BENCH_REPORT=/path/to/report.json` — choose the JSON path; if no
  report dir is provided, assets go next to it in `<name>-assets/`.
- `PI_LOCATE_BENCH_HTML=/path/to/index.html` — choose the HTML report path.
- `PI_LOCATE_BENCH_SAVE_SESSIONS=0` — run Pi with `--no-session`, disabling
  copied/exported session artifacts.
- `PI_LOCATE_BENCH_EXPORT_SESSIONS=0` — copy session JSONL files but skip
  `pi --export` HTML generation.
- `PI_LOCATE_BENCH_PRINT_JSON=1` — also print the JSON report to stdout.

The JSON report includes `sessionArtifacts` with parent/sub-agent session ids,
session file ids, paths, and byte sizes. Paths are useful for post-run analysis
when `PI_LOCATE_BENCH_KEEP=1`; otherwise the temporary fixture copy is removed
after the report is produced, but the ids remain in the report.

The opt-in Bun E2E wrapper runs all modes, asserts that each one finds the
manifest ground truth, and prints the rough token totals:

```sh
PI_LOCATE_BENCH_E2E=1 PI_LOCATE_BENCH_MODEL=zai/glm-5-turbo \
bun test test/locate-benchmark-e2e.test.ts
```
