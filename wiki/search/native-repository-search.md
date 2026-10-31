---
kind: spec
status: active
title: Native repository Code and Knowledge search
---

<!-- pix:wiki-report {"version":1,"checkedAt":"2026-10-31T00:50:12.080Z","result":{"path":"wiki/search/native-repository-search.md","documentHash":"c3e5ad3aac99dc163f77db4c074b2747dfb689a01294deccb9b7ba54a00a620f","modelRef":"zai/glm-5.3-flash","reportLanguage":"ru","checkedSources":12,"conflicts":[],"uncertainties":[],"reviewedSources":[{"path":"wiki/work-management/tasks/desktop.md","quote":"## Goal\n\nProvide a fully interactive, project-scoped Tasks sidebar: Quick Add, editor,\nattachments, status, priority, drag-and-drop, deletion, and task/session launch.\nUser slash commands and the restricted agent `project_tasks` API are additional\nentry points, **not replacements for the UI**. Project tasks are distinct from\nsession-local todos.\n\n## Persistent source\n\n- Only `\u003cproject\u003e/.pi/tasks.sqlite` is authoritative, using SQLite schema v1\n  (see [agent/storage contract](project-tasks-agent-tool.md)).\n- `PRAGMA journal_mode=WAL`, `foreign_keys=ON`, and five-second\n  `busy_timeout` use SQLite's own transaction/lock management.\n- No homemade lock files, advisory leases, Koffi/flock bridge or bulk task\n  JSON document replacement.\n- A nonexistent database reads as zero tasks; a corrupt/unsupported database\n  produces an actionable storage error, never an automatic reset.\n- **No legacy support or migration.** `tasks.jsonc`, `tasks.json`,\n  `tasks.d/`, and old attachment markers are not authoritative and cannot\n  supply tasks. Legacy `tasks.jsonc`/`tasks.d/` are non-canonical and are\n  removed by Desktop `.pi` cleanup.\n- Opening/reading a workspace with no `.pi` is side-effect free and returns an\n  empty task view. The first task save lazily creates only `.pi/tasks.sqlite`;\n  attachments can be staged before that first task, and the save then records\n  their SQLite associations. Plan and settings saves likewise create only\n  their required storage. Creating a new `.pi` first appends `/.pi/` to the\n  root `.gitignore` unless a literal `.pi`, `.pi/`, `/.pi` or `/.pi/` rule\n  already exists; existing rules/newline convention are preserved and Git\n  files are not thereby untracked. Existing `.pi` directories are not\n  retroactively ignored. Permission failures surface as failed saves, not\n  success. Optional full Registry initialization creates the complete\n  `.pi/tasks.sqlite`, `.pi/plans/` and `.pi/task-attachments/` scaffold; its\n  initialized marker still requires all three valid entries.\n\n## Tasks sidebar behavior\n\n- The initial activity view is Tasks, with per-workspace remembered view,\n  width, and collapsed layout. Groups are fixed in this order:\n  **In progress, Todo, Backlog, Done, Failed**.\n- Group headers display total counts regardless of filters and expose a\n  keyboard-accessible button with `aria-expanded`, `aria-controls`, and\n  **visible rotating Lucide chevron** in both states. Done starts collapsed;\n  the others start expanded. Collapse state is workspace-local UI preference,\n  never persisted in SQLite.\n- Task cards show type icon/tone, title (or description preview for untitled\n  tasks), and compact, labeled indicators for real SQLite\n  attachments, related files/tasks, a parent/subtask branch, optional assigned\n","startLine":10,"endLine":57},{"path":"wiki/decisions/0070-search-source-work-recovery.md","quote":"- `external/pi-tools-suite/test/source-work.test.mjs` exercises independent\n  processes, terminated workers in a live process, heartbeat expiry, cancellation,\n  migration interruption and retained originals using fixtures, not paid providers.\n- A process crash can leave a provider request accepted remotely but no locally\n  recorded result. Local leases cannot establish whether it was billed or stopped.\n  This uncertainty was explained before the user's recovery choice above.\n- Real provider behavior and real Desktop recovery were not verified in this task.\n\n## Decision\n\nThe governing specifications are [native repository search](../search/native-repository-search.md),\n[Desktop universal search](../search/desktop-universal-search.md), and\n[Desktop search index status](../search/desktop-search-index-status.md). The suite\n[README](../tools/suite.md) also summarizes the recovery contract.\n\nUse one database per source and a separate global SQLite coordinator, not a\ntransaction held during HTTP. Source claims and provider slots use 90-second\nrenewable leases. Expired leases can be reclaimed regardless of whether the PID\nstill exists: a terminated worker can share a live parent PID. Publication must\nvalidate ownership plus current content/model before a short commit.\n\nSource and provider leases renew every 30 seconds and expire after 90 seconds. Normal\ncancellation retains both claims and slots until the tracked transport actually settles;\nlost ownership cannot be resurrected or used to publish. A queued source keeps its claim\nrenewed and rechecks ownership after acquiring a provider slot. After two failed or\ninterrupted network attempts (initial attempt plus one automatic retry), require explicit\nContinue; a successful request resets the failure count, and Continue clears an exhausted\nbudget before reconciliation. Status polling cannot initiate recovery. Coordinate at most\nfour valid provider leases across participating processes and projects; this is not a\nprovable remote execution limit after crash or partition.\n\n## Alternatives\n\n- **Only explicit Continue after any uncertain request:** offered to the user;\n  not selected. It reduces automatic repeat billing but needs intervention after\n  the first crash.\n- **Keep a slot whenever its PID is alive:** does not recover a terminated worker\n  thread inside a live ACP/Desktop process. A renewable lease is required instead.\n- **Only increase SQLite writer timeouts:** the existing workaround; rejected by\n  the user's request because it retains cross-source contention and long writes.\n\n## Consequences\n\nIndependent sources can progress while another awaits the network. A healthy\n","startLine":28,"endLine":71},{"path":"wiki/archive/workspace.md","quote":"---\nkind: spec\nstatus: active\n---\n\n# Conversation workspace — tool removed\n\n## Behavior\n\nPix TUI and Pix Desktop do not provide the bundled `workspace` tool.\nThe former `current`, `switch` and `back` actions, return stack, transactional\nruntime rebinding and transparent model continuation are removed.\n\nOrdinary project opening, session operations, context reload and workspace undo\nare unchanged. Legacy `workspace` state envelopes do not mutate ACP session cwd,\nthe translator, persisted session-map records or Desktop catalog cwd. Historical\n`pix.workspace` journal entries remain untouched, but are no longer restored by\na workspace host. Running processes must restart to unload the removed tool.\n\nSee [the removal decision](../decisions/0023-remove-workspace-tool.md), which\nsupersedes the [rebinding](../decisions/0014-conversation-workspace-rebinding.md)\nand [handoff](../decisions/0021-transparent-workspace-handoff.md) decisions.\n\n## Implementation\n\n- `src/app/runtime.ts`\n- `src/app/app.ts`\n- `src/app/session/session-lifecycle-controller.ts`\n- `acp/src/pi/pix-rpc-entry.js`\n- `acp/src/acp/pix-acp-agent.ts`\n- `acp/src/acp/session-state-bridge.ts`\n- `acp/src/acp/session-map.ts`\n- `desktop/src/app/session-coordinator.ts`\n- `desktop/src/app/desktop-session-orchestration.ts`\n\n## Tests\n\n- `tests/bundled-question-extension.test.ts`\n- `tests/session-lifecycle-controller.test.ts`\n- `acp/test/agent.test.ts`\n- `acp/test/session-state-bridge.test.ts`\n- `desktop/src/app/session-coordinator.test.ts`\n\n## Verification\n\nRoot, ACP and Desktop typechecks plus targeted bundled extension, session\nlifecycle and state bridge/coordinator regressions. These checks do not claim\ninteractive UI QA.\n\n\n","startLine":1,"endLine":50},{"path":"wiki/search/project-search-agent-tool.md","quote":"---\nkind: spec\nstatus: active\n---\n\n# Project-wide search for Pi agents\n\n## Goal\n\nExpose project history and native repository search to the Pi agent\nthrough a single bounded `project_search` tool. Use the same project data\nsources and project-owned search-cache tables as Desktop Universal Search,\nwithout duplicating a persistent index or invoking a second answer LLM/Jev.\nAuthoritative project task/session/Git state remains read-only; explicit\nsemantic searches may update source-local SQLite stores under explicit global provider configuration.\nNative Code/Knowledge uses disposable `.pi/search/code.sqlite` and `.pi/search/knowledge.sqlite` stores;\nsee [native repository search](native-repository-search.md) and [0065](../decisions/0065-native-repository-search.md).\n\n## Behavior\nSearch indexing writes selected metadata-only diagnostics to the **shared Pix\nJSONL logger** at `~/.config/pi/logs/` (`search.index` module). The old\n`.pi/artifacts/search-diagnostics-*/events.jsonl` writer is retired: no search\ncode opens an independent diagnostic file. Each host uses the in-process Pix\nsink; standalone Pi remains functional when that optional sink is absent.\nNormal starts, per-session successful/empty passes, cancellation and five-second\nprovider-wait heartbeats are not written. Failed and incomplete index passes\ninclude bounded counts (checked/skipped sessions, discovered/cached chunks,\nsaved vectors, provider calls), elapsed duration, fixed execution phase and\nallowlisted error type/OS/SQLite code. A successful pass that saved vectors is\n`debug`-only. Skipped transcripts emit a rate-limited warning with a fixed\nreason and safe code; raw session IDs, file paths, parent/child IDs, provider\nmessages, prompts and document text never enter these events. The separate\nuser-requested manual result retains existing bounded skip details for the\ncurrent action, without building a Desktop Activity history.\n\nBackground session synchronization normally rechecks cross-host inactivity after\n30 seconds. If a worker throws or finishes with an operationally incomplete\nindex (e.g. an unreadable transcript), periodic recovery backs off to 2, 4, 8,\nthen at most 15 minutes instead of retrying every 30 seconds. Deferred or\nnot-yet-mature sessions do not trigger failure backoff. A fresh session or\nsource change can trigger a debounced earlier retry; explicit manual\nIndex/Continue is unaffected. Generic background-worker errors generate\n`search:background-failed` (warn), tagged with a fixed phase, error category\nand allowlisted OS/SQLite code; repeated causes are coalesced for five minutes\nwith a suppressed count. Per-session failures use the same safe categories\nwithout including session IDs. Ordinary cancellations, including a deliberate\nchange to the enabled search sources, are not warnings. Invalid or unreadable\nsource policies remain operational failures.\n\nThe background idle-session selection reads activity/lease metadata in one\nSQLite connection per candidate sweep instead of reopening the source database\n","startLine":1,"endLine":51},{"path":"wiki/decisions/0066-native-repository-semantic-search.md","quote":"\n- Status: accepted\n- Recorded: 2026-10-10\n- Decided: 2026-10-10\n- Owner / approval evidence: the user explicitly required semantics beyond FTS5 and selected the already configured embedding provider, with separate transmission consent and no paid verification. Storage/lifecycle choices are implementation decisions, not separately claimed user approvals.\n- Governing spec: [Native repository search](../search/native-repository-search.md)\n- Replaces / replaced by: supersedes [0065](0065-native-repository-search.md)'s lexical-only scope; retains its process and local FTS storage boundary.\n\n## Context\n\nThe approved native repository slice must support semantic retrieval as well as lexical\nsearch. Existing provider choices and paid history vectors must survive unchanged.\nThe shared suite must work in ordinary Pi as well as Desktop, without an active ACP session.\n\n## Observations and sources\n\n- [0065](0065-native-repository-search.md) records the existing history writer's long\n  transaction spanning provider work; sharing it would couple local search to that lifecycle.\n- User requirements above are conversation-only evidence, not a claim of a separate signed plan.\n- Assumption: bounded, explicit-search indexing with visible coverage is useful before a\n  persistent indexing service exists. Deterministic embeddings test mechanics, not real-model recall.\n\n## Decision\n\nKeep `.pi/search/files.sqlite` local/lexical. Add independent, consent-gated repository\n","startLine":5,"endLine":29},{"path":"wiki/search/desktop-universal-search.md","quote":"  vectors stay searchable; session queries never create document embeddings.\n  Background discovery persists a single successful pass-start watermark in\n  `pix_session_sweep` in the sessions cache, bound to embedding identity and\n  logical cache incarnation/revision; it does not persist a per-file manifest.\n  Only a fully successful title-and-chunk pass advances the checkpoint. Failed,\n  deferred, cancelled, unreadable or missing-title work cannot certify it. After\n  restart, eligible unchanged bodies can be skipped using transcript mtime/ctime,\n  activity, mapped title update time and the creation-plus-24-hour deadline, with\n  a conservative two-second overlap. Candidate discovery remains complete for\n  queries; only indexing work is filtered. Metadata and bounded identity-header\n  checks still run. A cache/model mismatch or backwards clock forces a full\n  eligible sweep; partial cache writes may invalidate the previous cutoff.\n  Manual Index/Continue is a full repair pass and seeds the same watermark only\n  on full success. Because the checkpoint is scalar, one pending mature session\n  may hold it back; successful unchanged attempts are reused in memory meanwhile.\n  Manual Index/Continue bypasses the idle delay only, not the 24-hour creation\n  minimum. Mature-file changes use directory events coalesced into dirty paths,\n  bootstrap plus bounded five-minute missed-event reconciliation, and maturity\n  deadlines that admit sessions even without events. The one-shot CLI fully\n  reconciles. Optional ACP snapshot requests can warm the digest from a bounded\n  1.5-second session snapshot; ACP reconnect falls back to native metadata.\n  Session digests cover mature file revisions and mature mapped title/id aliases.\n  Session-index logical revision is trigger-maintained and commit-coupled across\n  title, metadata, chunk and vector content tables; work heartbeat, FTS, WAL and\n  VACUUM changes do not affect it. Legacy caches remain read-only during status,\n  using a bounded metadata fingerprint until a writer installs revision tracking.\n  Shared CLI/Desktop receipts use the updated source fingerprint, so old receipts\n  require a new manual pass.\n  With a valid global provider configuration and credentials, existing and new\n  public text is uploaded in batches of 16; unchanged hashes reuse paid vectors.\n  Automatic/manual synchronization drains remaining work, checking eligibility\n  around provider requests and before publishing automatic results.\n  Failures do not create a paid polling loop; explicit Continue retries interrupted work.\n  Search indexing diagnostics use Pix's shared JSONL logger in\n  `~/.config/pi/logs/`, not a source-local `events.jsonl`. Terminal failures,\n  incomplete passes, meaningful vector saves (debug), background-worker failures\n  and repeated skipped-transcript causes are recorded with fixed, bounded\n  metadata only. No per-session heartbeat/start/empty-success spam, file path,\n  transcript ID or text, prompt, provider body or credential is logged.\n  Repeated skip/worker causes are coalesced per workspace for five minutes.\n  After a worker failure or operationally incomplete index, periodic recovery\n  backs off to 2–15 minutes, while fresh changes and explicit Index/Continue\n  can trigger earlier work. There is no separate Activity log in the index\n  status panel; its inline statuses, error banners and per-source actions remain.\n  Standalone Pi without the Pix log sink does not create separate search logs.\n  Source leases are shared with Pi/TUI; publication rechecks transcript revision and\n  provider authorization. Workspace replacement/disposal aborts owned work.\n  Local lexical message search is available without embeddings. There is no\n  message-filter setting or relation graph.\n  Obsolete `messageFilterEnabled` writes are rejected; legacy config keys are\n  ignored. Opening search polls cheap status without discovering transcripts\n  or rerunning queries.\n- Code/Knowledge use [native lexical-first repository search](native-repository-search.md)\n  through the same packaged engine as agent `project_search`, without external indexing\n  tools, keys or an active ACP session for lexical search. Native results preserve paths, line ranges and bounded content\n  for navigation/reranking/RAG. Requests own cancellation and ignore stale completion;\n  concurrent publications use SQLite generation checks. No provider setup occurs.\n  A valid `search.embedding` object in `~/.config/pi/pi-tools-suite.jsonc` enables native\n  semantic enrichment across all projects and sources, configured in ordinary Pi with\n  `/search-semantic configure \u003cembedding JSON\u003e` or in Desktop Tools Suite → Search, with\n  the shared suite draft and top Save button. Configure in Settings from Search indices\n  opens and focuses the Embedding model field, including after asynchronous config loading. There is\n  no independent consent flag or confirmation step. The shared disclosure covers eligible\n  semantic inputs and possible costs. Lexical results publish before optional hybrid\n  enrichment, with bounded incremental coverage notices. Configuration changes cancel/restart\n  search; no active ACP session is needed to read/change the global configuration.\n  Native failure reports a source-specific notice without an external backend fallback.\n  Successful empty native results remain empty. Failed semantic enrichment retains\n  already-published lexical evidence; other local source results survive.\n  Legacy search panels, setup/update commands, installers and adapters are absent;\n  existing user data is not modified.\n- Semantic settings search uses the same global configuration as all other sources.\n  Only authored settings metadata and submitted queries enter its embedding input.\n  Workspace startup registers `id`, `section`, `label`, `description` and `synonyms`\n  through `pix/search/sync`, independently of opening Settings or submitting a search.\n","startLine":452,"endLine":526},{"path":"wiki/desktop/conversations/desktop-btw.md","quote":"The request necessarily sends its question and snapshot to the selected provider;\ntemporary storage in Pix is not a promise about provider-side retention or an\nexternal provider's explicitly enabled debug logging.\n\nAnswers can be copied or explicitly inserted as a draft into the owning parent's\nempty composer without attachments. No automatic submit, overwrite, parent\nqueueing, run-state changes, tools or autonomous agent actions are allowed.\n\n## Constraints and failure cases\n\nOne provider request per parent runtime; cancellation cannot allow overlap if the\nprovider ignores abort. Requests/events have explicit runtime/request identity;\nlate completions cannot populate a replacement runtime or another session.\nQuestion/history/excerpt/context/output sizes and request duration are bounded.\nClipped context is visible as a limitation, not evidence of a bug. Offline mode\nand unavailable models fail closed. Error text must not expose prompts or provider\nsecrets. No background inference from merely opening the pane or switching tabs.\n\nThe current limits are 8,000 characters per question; 4 explicitly selected\nexcerpts of up to 8,000 characters each; 40 side-history messages (20 exchanges)\nwithin 48,000 characters; a conservative serialized parent/question/history budget\nof at most 160,000 UTF-8 bytes, reduced for smaller model context windows; at most\n4,096 output tokens and 32,000 output characters; and a 75-second deadline.\nCompleted history is trimmed by whole exchanges; long excerpt text in the newest\nexchange is shortened before retention so its question and answer do not disappear.\nPer-record tool/prose limits also apply. The UI identifies shortened context.\nContext collection is bounded per record and uses a linear serialization budget.\nBefore retaining any text it selects up to 512 recent projected entries plus\nthe first and three latest user-constraint entries; omitted history is disclosed.\n\nHistory is refreshed only on a submitted question. Plain parent appends preserve\nside history. Branch changes, context edits and compaction change its context key;\nthe next question drops obsolete side exchanges and displays a reset indication.\nAn already submitted response keeps its labelled snapshot. Tree navigation also\ncancels the side request. Runtime replacement clears the temporary conversation\nimmediately through identity-only lifecycle notifications, not a replayed snapshot.\n\nBTW reuses the statusbar's Model + Thinking popup, search, keyboard handling and\nDesktop `visibleModels` whitelist. The complete catalogue is exposed only by\nManage; the current BTW model remains visible even for an empty whitelist.\nManage edits the same Desktop visibility preference, not a separate BTW list.\nOpening waits for a pending visibility save before reloading the preference.\nThe popup anchors to BTW's own model button; opening either model popup closes\nthe other. The parent-only Auto routing action and Set default are not offered.\n\nThe selected model/effort pair and per-model BTW effort memory are temporary.\n\"Same as main session\" inherits the parent's resolved model and effort when the\nrequest is accepted. Use main restores inheritance for both. Explicit choices\nnever mutate the parent's model, effort, defaults or remembered effort profile.\nThe picker shows only the selected model's supported thinking levels, clamps\nstaged choices with the shared rules, and remembers applied choices per model\nwithin the side chat. Apply affects subsequent questions, not an active request;\nCancel/Escape discard staged changes. An explicit pair is captured before async\nsubmission preparation so a later UI selection cannot change that request.\n\nThe runtime independently validates explicit effort against the actual model.\nUnsupported/unknown values fail before inference instead of silently switching\neffort. Inherited effort is clamped to the resolved model; non-reasoning models\nuse off. Off omits the simple-stream reasoning option; every other supported\nlevel is forwarded rather than replaced by minimal. Progress carries the\ncaptured effective effort without overwriting the next question's selection.\nMissing credentials/models are errors, not fallback triggers. Inference uses\nno tools, retries or cache-retention request; warm-cache pricing is not assumed.\n\nThe pane header contains the model/effort selector: its compact button shows the\nselected model's display name without a provider prefix and the selected effort,\nnot the session title or stale response metadata. Inherited selection shows the\ncurrent parent model. The popup opens below the header when that side has more\nroom; Apply updates the header and the next question's pair. A compact reset\nbutton restores main-session inheritance. There is no duplicate selector or\nselection-description row above the composer.\nThe header uses the standard X button to hide the pane without clearing\nthe conversation. There is no metadata block with context timestamps, record\ncounts, raw model references or token usage. Context shortening remains a\nconcise notice inside the conversation only when relevant.\nThe pane has independent scrolling, keyboard/pointer resizing and Send/Stop.\nEnter submits; Shift+Enter inserts a newline; Escape hides the pane and restores\nmain-composer focus without cancelling the parent. Inner model-picker Escape is\n","startLine":35,"endLine":112},{"path":"wiki/desktop/conversations/desktop-slash-commands.md","quote":"\nPrompt enhancement (`/enhance` or the composer menu) disables the active\ncomposer's input, attachments, voice, menu and submission while the model\nrequest is pending. The send control shows an animated spinner with an\naccessible “Improving prompt” status. Success and failure release the lock;\nother sessions remain usable, and stale completions cannot unlock a newer\nrequest or overwrite another context's draft.\n\n## Implementation\n\n- `desktop/src/app/conversation-session-actions.ts`\n- `desktop/src/app/desktop-workbench-prop-builders.ts`\n- `desktop/src/components/PromptComposer.svelte`\n- `desktop/src/components/PromptComposerControls.svelte`\n\n## Tests\n\n- `desktop/src/app/conversation-session-actions.test.ts`\n- `desktop/src/app/desktop-workbench-prop-builders.test.ts`\n- `desktop/src/components/PromptComposerControls.test.ts`\n- `desktop/src/components/prompt-composer-slash-controller.test.ts`\n\n## Related files\n\n- `acp/src/acp/slash-commands.ts`\n- `acp/src/acp/pix-acp-agent.ts`\n- `acp/src/acp/config-options.ts`\n- `acp/src/pi/pi-rpc-client.ts`\n- `desktop/src/lib/fuzzy.ts`\n- `desktop/src/lib/model-display.ts`\n- `desktop/src/lib/model-thinking.ts`\n- `desktop/src/lib/command-interactions.ts`\n- `desktop/src/lib/slash-commands.ts`\n- `desktop/src/components/CommandPicker.svelte`\n- `desktop/src/components/ModelThinkingPicker.svelte`\n- `desktop/src/components/PromptComposer.svelte`\n- `desktop/src/components/prompt-composer-slash-controller.svelte.ts`\n- `desktop/src/components/SessionSelector.svelte`\n- `desktop/src/components/StatusBar.svelte`\n- `desktop/src/styles.css`\n","startLine":89,"endLine":128},{"path":"wiki/development/release/guide.md","quote":"npm install --ignore-scripts\nnpm run release:check\nnpm run smoke-test\n```\n\n`release:check` runs type checking, the test suite, a production build, and `npm pack --dry-run`.\n`smoke-test` packs the real tarball, installs it into an isolated temp directory, checks the bundled files, and runs non-interactive `pix` commands from the installed package.\n\n## CI regression guardrails\n\nThe normative CI invariants are recorded in [`wiki/development/release/ci-release.md`](ci-release.md). This section is the operational checklist for release work.\n\nThe GitHub Actions workflows have two different responsibilities and they stay separate:\n\n- `check.yml` runs the cross-platform correctness matrix on pull requests and\n  `master` pushes. It does not run on release tags.\n- `publish.yml` is release-only: a lightweight release-contract check followed by\n  the three native standalone package jobs and, for tag pushes, verified GitHub Release publication.\n- Native release smoke remains mandatory because it validates the relocated TUI\n  archive and installed Desktop application, not source or npm-package behavior.\n\nKeep CI tests deterministic across runner speed and operating systems:\n\n- Assert explicit byte/count/state thresholds instead of assuming a background producer will do enough work within a short wall-clock interval. For example, a truncation test should write a fixed amount greater than the limit rather than write repeatedly for 300 ms and assume the runner will exceed the limit.\n- Use timers only when timeout behavior itself is the contract. Do not use elapsed time as a proxy for produced output, process progress, or cleanup completion.\n- When a test needs asynchronous process teardown, wait for an observable owned-process condition rather than relying on a short sleep.\n- Run configuration-sensitive suite checks with an isolated `HOME` when reproducing CI locally. User-level Pix/pi-tools-suite config can intentionally change DCP and other opt-in behavior and must not be mistaken for a CI regression.\n\nWindows process tests have additional invariants:\n\n- `@lydell/node-pty` on Windows does not support POSIX signal arguments to `kill`; terminate an owned Windows PTY with signal-less `kill()` and release its ConPTY resources.\n- Browser/process cleanup must stay ownership-scoped. When a PowerShell helper discovers descendants, it must not select or terminate itself; kill owned child roots recursively and verify cleanup before returning.\n- Treat CRLF/LF differences as presentation differences unless line endings are the behavior under test.\n\nCurrent implementation:\n\n- `.github/workflows/check.yml` owns PR/master correctness checks.\n- `.github/workflows/publish.yml` owns tag/manual release packaging and stable Release publication.\n- `scripts/release/smoke.mjs` and `smoke-desktop.mjs` validate the actual standalone artifacts.\n\n## Create a release version\n\nThe root `package.json` version remains the authoritative application version even\nthough Pix is not published to npm. Use `npm version` because its version hook\nsynchronizes ACP, Desktop, Tauri, Cargo and lockfiles before creating the tag:\n\n```bash\nnpm version patch -m \"chore(release): %s\"\n# or an exact version\nnpm version 2.0.2 -m \"chore(release): %s\"\ngit push origin master\ngit push origin v2.0.2\n```\n\nThe root `package.json` version is authoritative. Its npm `version` hook synchronizes\nACP, Desktop, Tauri, Cargo and lockfile versions and stages them before npm creates\nthe release commit/tag. `npm run release:version:check` detects drift; use\n`npm run release:version` to repair manifests after a manual root-version edit.\n","startLine":205,"endLine":262},{"path":"wiki/tools/suite.md","quote":"`patch:` searches. The council-specific extension adds web access and its strict\ncall guard; private child `todo` is also allowed, without enabling mutations or\nnested delegation. Repository embeddings use shared global configuration/provider\nsafeguards. No shell, edits, suite setup commands or nested agents are enabled. Participants\nare instructed to research when useful, cite sources, report access gaps, and never\nsend private repository/brief content or secrets to web services. Tool selection is\nenforced; privacy and source-quality instructions are not a network/filesystem sandbox.\n\n## Repository knowledge and spec maintenance\n\nUse `project_search` for both broad repository discovery and focused lookup,\nselecting sources and options as needed. It defaults to all five sources; Code and\nKnowledge use native search exclusively. Follow\ntruncation/degradation diagnostics and read primary sources before relying on a\nsummary. The former `repo_context`, `repo_inspect`, `repo_audit` and `repo_search`\ntools and the `/idx-init` and `/idx-update` commands are removed.\n\nFor a **material behavior-changing implementation**, the\nmodel-facing contract is:\n\n1. Find the existing primary behavioral contract before or while implementing.\n2. Keep the governing spec aligned with the intended behavior in the same task.\n   If none exists, create a focused spec with normal file editing tools. For a\n   new spec, use the project's spec template (`specs/TEMPLATE.md` when present)\n   without overwriting existing documents. If no template exists, ask before creating one.\n   Declare\n   `kind: spec` and intended `status` in frontmatter and list\n   project-relative implementation/test paths in the appropriate sections.\n3. Before completion, run the available `knowledge-auditor` with the final\n   behavior/result and exact task-changed paths. It updates affected documentation\n   against relevant source/tests, makes small proven fixes and returns substantial\n   or ambiguous discrepancies to the parent. Obtain the result and resolve concrete\n   documentation questions. If the role is unavailable, maintain the docs directly.\n   This needs no knowledge dirty check, acknowledgment, index refresh or full\n   traversal of declared dependencies. Accurate documentation needs no edit;\n   do not expand into unrelated work.\n\nRetrieval is bounded: output may be truncated, hybrid mode may degrade with\ndiagnostics, and an empty result does not prove that no contract exists.\nDocument metadata and inferred purpose are navigation aids, not a semantic\ncorrectness verdict. The reviewer owns the final decision.\n\n### Decision history\n\nKeep current behavior in specs and significant rationale in `docs/decisions/`,\nfollowing the project's convention/template. Before changing a contract, read\nlinked decisions and check status/superseding links. Historical rationale does\nnot override the current spec. Plain Markdown already participates in retrieval\nsubject to normal exclusions; no special document kind or new storage is required.\n\nDefault to no new record. Record a decision only when explicitly requested by the\nuser, or when a choice involves materially different plausible alternatives,\n","startLine":224,"endLine":275},{"path":"wiki/tui/guide.md","quote":"- `/export` / `/import` — move sessions through HTML/JSONL;\n- `/share` — publish a secret GitHub gist;\n- `/compact` — manually summarize older context;\n- `/delete` — permanently delete a session after confirmation.\n\n`maxProjectSessions` controls automatic per-project session retention; `0`\nkeeps sessions indefinitely.\n\n## Bundled pi-tools-suite\n\nPix links the bundled suite into the active Pi agent directory when safe. An\nexisting non-symlink installation is preserved.\n\nMajor capabilities include:\n\n| Area | Modules / behavior |\n| --- | --- |\n| Parallel work | `async-subagents`, presets, fallback routing, `/ultrawork`, `/hyperplan` |\n| Repository search | Native Code/Knowledge retrieval via `project_search` |\n| Structural edits | `ast-grep` |\n| Feedback | LSP diagnostics and comment checks |\n| Planning | hierarchical durable todos |\n| Context | DCP compression/pruning |\n| Web | local/cloud web-search integrations |\n| Providers | usage, Antigravity auth, OpenCode credential import |\n| Reusable resources | prompt commands, Git-backed Registry, session naming |\n| Recovery | bounded session overview/search/section tools |\n| Payload hygiene | truncation normalization and opt-in credential firewall |\n\nOptional modules activate only when their host requirements are available.\nBroken module imports/factories are skipped with a startup warning instead of\nremoving the whole suite. This does not certify unfinished feature behavior or\nundo arbitrary initialization side effects; see\n[module loading](../tools/pi-tools-suite-module-loading.md).\n\nAdaptive plans keep dependencies, blockers, ownership and the active step\nvisible:\n\n![Pix adaptive todo plan with hierarchy and blockers](../assets/screenshots/pix-adaptive-todo.png)\n\nParallel sub-agents report live status without taking over the main session:\n\n![Pix running parallel sub-agents alongside the main implementation plan](../assets/screenshots/pix-subagents.png)\n\nUseful suite commands include `/todos`, `/sub-status`, `/sub-stop`,\n`/ultrawork`, `/hyperplan`, `/usage`, `/dcp`, `/opencode-import`, and\n`/antigravity-add-account`.\nThe Git-backed resource Registry is available only in Pix Desktop.\n\n## Command map\n\n| Area | Commands |\n| --- | --- |\n| Renderer/resources | `/settings`, `/hotkeys`, `/reload`, `/changelog`, `/update` |\n| Models | `/model`, `/default-model`, `/scoped-models`, `/thinking`, `/default-thinking`, `/autocomplete` |\n| Project context | `/no-context-files`, `/compact` |\n| Prompt workflow | `/enhance`, `/queue`, `/copy` |\n| Git | `/code-review`, `/commit-message` |\n| Sessions | `/new`, `/new_tab`, `/resume`, `/name`, `/session`, `/search`, `/history`, `/jump`, `/tree` |\n| Branching/files | `/fork`, `/clone`, `/delete`, `/export`, `/import`, `/share` |\n| Status/process | `/usage`, `/quit`, `/exit` |\n\nUse `/hotkeys` and the live `/` picker as the authoritative command/key\nsummary for the installed version.\n\n## Workspace undo\n\nPix records supported agent file mutations against the user message that started\n","startLine":99,"endLine":166},{"path":"wiki/decisions/0065-native-repository-search.md","quote":"  `.pi/search/index.sqlite`. Existing namespaced tables are not a file-search migration API.\n- `desktop/src-tauri/src/backend_runtime.rs` resolves the relocated tools-suite extension\n  in both development and packaged runtimes, providing a session-independent process boundary.\n- Independent repository checks confirmed that commit embedding configuration, repo context,\n  AST/dependency views and knowledge dirty/acknowledge were outside the first slice.\n- Assumption: bounded lexical retrieval is useful without semantic/AST parity. Its quality and\n  large-repository limits must be measured, not inferred from FTS5 availability.\n\n## Decision\n\nUse one standalone tools-suite JS engine and typed result contract. TUI/ACP calls it in\nan owned child process; Desktop invokes the same packaged entry through a small Tauri\ntransport, independent of ACP sessions. Parsing/hashing/SQLite never run on the UI thread.\n\nStore only local file chunks/FTS5 metadata in `.pi/search/files.sqlite`, a disposable,\nstrictly owned schema. Leave `index.sqlite` and provider settings untouched.\nRefresh on explicit search, using short atomic generation-checked publications. Retain the\nprior complete snapshot on failed scans. Do not introduce background watchers or daemons.\n\nNative lexical search is the default. [Later integration-removal work removed the\nalternative-backend fallback clauses from this historical decision; they do not describe\ncurrent behavior.]\n\n## Alternatives\n\n- Reuse `index.sqlite`: plausible after removing embedding work from write transactions and\n  defining a cross-runtime schema lifecycle, but unnecessarily expands this slice's risk.\n- Put retrieval in ACP: reuses Node, but would require a new headless service lifecycle or\n  couple Universal Search to an active session. A bounded standalone process is simpler here.\n- Separate Rust and TypeScript engines: duplicates ranking, chunking, safety and schema rules.\n","startLine":23,"endLine":52}],"notices":["Неопределённость 1 не прошла проверку: цитата отсутствует или встречается в предоставленном тексте несколько раз."],"coverage":{"scope":"retrieved-passages","checkedPassages":12,"candidateSources":62,"excerptedSources":11,"limits":["query-sampling","candidate-limit","source-limit","context-limit","passage-limit"]},"status":"incomplete"}} -->

# Native repository Code and Knowledge search

## Goal / scope

One native Code/Knowledge backend for ordinary Pi/TUI/ACP/Desktop `project_search`,
with no external-backend dependency, fallback, command, install/update, panel, or settings. Native
lexical retrieval needs no credentials. Explicit global provider configuration itself
authorizes semantic retrieval for every project and source. Credentials use
`OPENROUTER_API_KEY`, then the shared Pi auth store. Existing legacy configuration is not migrated or modified.
Repository semantic/commit embeddings use this credential path; do not read
unrelated legacy configuration or migrate providers as part of a search task.
Persistence/process rationale: [0066](../decisions/0066-native-repository-semantic-search.md),
building on [0065](../decisions/0065-native-repository-search.md). Global authorization:
[0068](../decisions/0068-global-semantic-configuration.md). Source ownership and
uncertain-work recovery: [0070](../decisions/0070-search-source-work-recovery.md).

Desktop [Wiki contradiction checks](../desktop/workbench/desktop-project-wiki.md#contradiction-checks)
reuse this engine in hybrid mode, scoped to Knowledge and the selected project's
configured Wiki. Their separate sessionless contradiction judge uses verified
source passages after retrieval and independent `knowledgeCheck.modelRef` /
`knowledgeCheck.thinking` settings, not Search RAG preferences. The Wiki spec defines the save/report flow,
completion rules and budgets; ordinary native retrieval keeps its existing
source/provider configuration and performs no answer generation.

## Canonical behavior

- The shared engine lives in the default-enabled bundled tools-suite module and works
  in ordinary Pi without Pix or Desktop registration. Its CLI takes a selected canonical
  workspace path and bounded JSON stdin; both host adapters return the same typed hits:
  kind, id, title, snippet, score, project-relative path, inclusive 1-based start/end lines,
  and optional bounded content. Desktop retains normal navigation, ranking and RAG evidence
  revalidation. The agent retains its federated source/result caps.
  The optional `status.completeForSelection` distinguishes successful snapshot
  and configured retrieval-stage completion from ordinary candidate/output caps;
  existing `status.complete` retains its conservative meaning. `limitNotices`
  identifies benign selection-limit messages while retaining them in `notices`
  for existing clients. Stale scans, generation changes, incomplete semantics and
  configured-reranker failures cannot produce a true selection-completion flag.
  Release payloads include the engine source and its `ignore` parser as a locked root
  production dependency: the standalone CLI must not rely on the checkout's suite-local
  node_modules or a dependency nested inside the SDK.
- Native lexical search has no network work or credential requirement. Code and Knowledge
  refresh separate `.pi/search/code.sqlite` and `.pi/search/knowledge.sqlite` stores
  (and SQLite sidecars); semantic vectors are published in those same source-local stores.
  The six source databases are `code.sqlite`, `knowledge.sqlite`, `settings.sqlite`,
  `sessions.sqlite`, `tasks.sqlite` and `git-commits.sqlite`. Legacy `index.sqlite`,
  `files.sqlite`, `file-vectors.sqlite` and `commits.sqlite` are not imported, migrated,
  or used as fallbacks. On first use, only those four legacy database files and their
  SQLite sidecars are physically removed from this project; the six source databases
  are preserved. The shared Settings writer validates/creates only its global
  `~/.config/pi/search` ancestor directories and never scaffolds project `.pi` directories.
  Schema-1 Settings configuration is rejected without mutation.
- Files are enumerated under the selected root, using Git's tracked/unignored file list
  where available and a bounded walker with nested `.gitignore` otherwise. Internal caches,
  `.pi`, `.git`, `.indexer-cli` (protected legacy-data exclusion), dependency/build directories, linked/nonregular files,
  binary/invalid-UTF8 and oversized sources are excluded. Search is not a secret detector;
  eligible tracked text is searchable. Generated text not covered by ignores remains eligible.
- Recognized source/config formats become Code; Markdown/plain documentation formats become
  Knowledge, without mandatory frontmatter. Markdown headings define section boundaries;
  code and large sections use bounded overlapping line chunks. These are not AST symbols.
  Godot `.gd`, `.tscn`, `.tres`, `.godot`, `.gdshader`, and `.gdshaderinc` files are Code;
  the generated `.godot/` cache directory is excluded even when not ignored by Git.
- The global suite config `~/.config/pi/pi-tools-suite.jsonc` accepts optional
  `search.codeExtensions` and `search.knowledgeExtensions` arrays (at most 128 entries
  each). When present, each list completely replaces that category's built-in list;
  there are no automatic filename special cases. An explicit empty list disables that
  category, while an omitted list uses built-in defaults. Each entry is a simple suffix of
  1–32 letters/digits/underscore/plus/hyphen, starting with a letter/digit, with an
  optional leading dot. Case and dots are normalized; duplicates within a source are
  harmless. Paths, globs and compound suffixes are not supported. Cross-source
  overlap between the effective Code and Knowledge lists is an actionable configuration
  error, not a precedence rule. Invalid/unsafe settings retain the previous local snapshot
  without publication.
  Project-local config does not override these lists. All ignore, binary, size and
  link exclusions still apply. Changes take effect on the next explicit search/index
  scan: newly eligible files are added, removed suffixes disappear, and moving a
  custom suffix between sources rechunks unchanged bytes. Reordering equivalent
  lists does not cause rechunking. A mid-scan classification change prevents publication.
  Saving lists alone does not scan, clear purchased vectors or trigger embeddings.
- FTS5 tokenization normalizes case, Unicode, camel-case and punctuation. User text is
  tokenized and safely quoted rather than interpreted as raw FTS syntax. Identifier and
  camel/snake-case phrase candidates are reserved before broad prefix matches; retrieval
  considers the first chunk from each file before alternate chunks. File/heading terms
  carry extra BM25 weight. Stable path/line ties, source filters, test filters, file dedupe,
  `pathPrefix` and bounded excerpts are supported.
- Explicit searches scan/hash current eligible files but rechunk and rewrite only changed
  hashes. Deleted/renamed/ignored files disappear in the next successful publication.
  There is no watcher, automatic provider setup or background embedding daemon.
- Each process reads a generation snapshot, scans without a writer lock, then publishes
  a short atomic SQLite transaction only if that generation still matches. A losing scanner
  must not overwrite a newer generation. Incomplete scans retain the prior snapshot and
  return freshness/completeness notices; no partial scan purges prior valid rows.
  Unchanged files use exact stored chunk counts, including Markdown heading splits;
  chunk-budget overflow retains searchable prior rows rather than failing publication.
  Paths observed missing during reads, including ignore files, are rechecked before
  marking the scan complete; delete/recreate races invalidate freshness.
- Native search has no external fallback. Empty results and failures are reported as native
  results/notices; no legacy index is queried.
- Every Pi caller, including async/provider/council children, receives the same
  unrestricted `project_search` schema and execution across sessions, tasks,
  commits, code and knowledge, including `patch:`. Children suppress suite setup
  commands and parent orchestration guidance only. Repository semantic embeddings
  use the same explicitly configured global provider. Removed `repo_*` tools are not
  part of ordinary search.

## Optional reranking

- The canonical global suite JSONC accepts optional `search.rerankerModel`, an OpenRouter
  reranker model ID (for example `voyageai/rerank-3-lite`). Empty/omitted or invalid values
  disable it. Project overrides, an API key alone, and legacy config do not enable it.
  Desktop's **Reranker model** field edits this same global draft and uses its normal Save;
  clearing the field removes the key. New default configs document it without enabling uploads.
- Saving a nonempty model authorizes sending the query and bounded eligible Code/Knowledge
  text plus Sessions/Tasks/Commits titles and snippets across projects in Pi/TUI/ACP/Desktop. Charges may
  apply. Credentials use `OPENROUTER_API_KEY`, then shared Pi auth. This permission is
  independent of `search.embedding`: hybrid/semantic queries can rerank local candidates
  without embeddings. Removing embeddings does not disable a separately configured reranker.
  Settings are excluded from remote reranking.
- Pure lexical agent/native queries and document indexing never invoke reranking.
  Desktop publishes local results first, then optionally reranks the merged selected
  Sessions/Tasks/Commits/Code/Knowledge results after all source operations complete,
  including late source replies. Embedding configuration is not required for this pass.
  `project_search` hybrid/semantic queries likewise use one shared pass before final limits.
  Up to 100 source-balanced candidates are sent once to
  `https://openrouter.ai/api/v1/rerank`. History uploads contain only titles (512 characters)
  and snippets (4096), never full sessions or diffs; native candidate content is capped
  at 7500 characters. Provider documents remain capped at 8192 UTF-8 bytes each, while
  the query plus all documents share a 32,000-byte UTF-8 budget. Native documents use
  query-focused excerpts and avoid duplicate path/title headers. Each candidate shares
  the remaining batch budget equally; truncated prefixes never split UTF-8 code points.
  Code and prose with explicit identifiers, numeric anchors or acronyms retain contiguous
  windows. Other prose uses extractive passages covering the whole question, or representative
  sentences when there is no literal overlap. Selected sentences retain source order and
  mark omissions with an ellipsis; this is not an answer-generation step.
  Knowledge documents may include an explicit leading `Document status:` label from the
  same hash-verified file used by freshness preflight. Only recognized leading `Status:`
  metadata is used (first 32 lines, before a level-two-or-deeper heading, excluding fenced
  examples); paths and incidental prose never imply status. The label shares the existing
  byte budget, does not filter archived documents and adds no index schema or separate scan.
  In-flight file changes still reject the ranking. Federated history that
  cannot be verified during preflight stays in local results but is excluded from the
  remote pool; verifiable candidates may still rerank with a partial notice. Revocation,
  cancellation or stale sent-pool validation falls back to local order.
  Candidate filters, deduplication and source policy apply before upload; native per-domain
  caps and the requested final result limit apply after reranking. Returned relevance order
  is preserved rather than re-sorted by local BM25. Desktop Settings retain their local slots.
  Standalone native requests retain their Code/Knowledge pass; federated callers set
  `skipRerank` and carry native freshness context to avoid double provider calls. Content upload does not
  depend on `includeContent`; that flag controls only the returned payload.
- Reranking has a four-second verification/slot/transport budget, bounded response size, no redirected
  provider requests and strict index/score validation. Missing credentials, timeout,
  provider errors and malformed responses retain original ranking with a redacted notice.
  Global provider concurrency slots span transport lifetime. Source policy, configured
  model, history source snapshots, native generation and current candidate bytes are checked around network work;
  stale snapshots are not reranked, changed context rejects late ranking, caller cancellation
  rejects the search. Periodic configuration/policy/generation checks cancel in-flight work;
  no native SQLite handle is retained across reranker transport. History snapshots are
  captured before retrieval and rechecked before upload and after transport. Desktop bounds
  preparation to four seconds and the final request to 4.5 seconds, discarding late replies
  even when an adapter ignores cancellation. CLI/Tauri `rerank` input is capped at 4 MiB
  for bounded Unicode documents; other operations retain their 16 KiB input cap.

## Optional semantic retrieval

- The sole provider configuration is `~/.config/pi/pi-tools-suite.jsonc` (`HOME`, then
  the operating-system home). Its valid explicit `search.embedding` object authorizes **all**
  sources/projects in ordinary Pi, TUI, ACP and Desktop. There are no separate project,
  task, session or settings opt-ins. Missing, malformed, oversized or redirected config
  fails closed to local retrieval. A key or existing vector cache alone does not enable
  semantics. Legacy project config and Desktop consent booleans are ignored, not migrated.
  JSONC comments and unrelated suite settings are preserved. Project suite overrides and
  the former standalone `semantic-search.json` do not authorize semantics and are not migrated.
  Removing the embedding object disables globally and cancels stale work, retaining caches.
  Saving configuration discloses upload/cost scope: eligible code/document chunks, paths,
  headings, queries, task title/descriptions, saved session names, commit metadata and
  settings metadata. Conversation bodies/attachments are not embedded. This is not a
  secret-detection guarantee; already transmitted bytes cannot be recalled.
- Read the optional `search.embedding` object in the global file: `embeddingProvider`,
  `embeddingModel`, optional `knowledgeEmbeddingModel`, `vectorSize`, `ollamaBaseUrl`,
  and `knowledgeEmbeddingQueryPrefix` / `knowledgeEmbeddingDocumentPrefix`. Do not read
  legacy `.indexer-cli/config.json` or `.env`; do not migrate settings or select a provider
  automatically. OpenRouter credentials use `OPENROUTER_API_KEY`, then an API key in
  shared Pi `auth.json` (`PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`); missing/invalid
  config/key/provider leaves local matches.
  Semantic mode needs saved compatible provider configuration, but neither mode requires
  a legacy `.indexer-cli` directory. Legacy configuration is never consulted.
- `/search-semantic status|configure <embedding JSON>|off|reset-history` is a suite user command in
  ordinary Pi and Pix TUI. `configure` saves the explicitly supplied provider/model/dimension
  and displays the upload/cost disclosure without another consent question. Desktop offers
  equivalent configuration under Tools Suite → Search, using the existing suite draft and
  top Save button, without requiring ACP. The provider uses a custom selector. Search
  indices → Configure in Settings opens and focuses the Embedding model field, including
  when the settings file loads asynchronously. Status never reads credentials or
  contacts a provider. Atomic writes preserve unknown fields and comments, use a shared
  non-stealable writer lock, and reject malformed/oversized/redirected storage rather than
  repairing it. `off` removes the embedding object and retains vectors. `reset-history` is an
  explicit user-only recovery action for incompatible preserved history caches: it clears
  recognized derived task/session/commit vectors and their identity metadata in only
  the current project's source-local history databases. It does not reset the shared
  all-project Settings cache. It preserves canonical tasks, sessions and Git history,
  settings documents/schema, repository `code.sqlite` and `knowledge.sqlite`, and global
  Settings vectors. The next background Tasks
  synchronization or search-driven indexing of other sources can re-embed and incur charges.
  Busy, redirected, unsafe or unrecognized storage fails closed without committing a
  reset. No automatic provider choice. Child repository tools inherit configuration but do
  not expose this user command.
- `lexical` never embeds. `hybrid` (native default) uses reciprocal-rank fusion of BM25
  and cosine-ranked current chunk vectors; `semantic` uses semantic matches when available,
  falling back visibly to lexical on unavailability. Symbol ranking is unsupported.
  Code/Knowledge semantic candidates require raw cosine similarity **>= 0.25** before
  test-file ranking penalties and RRF. This fixed retrieval threshold does not filter
  BM25 matches or require reindexing; cached vectors use the same threshold. The fused
  RRF score is not a cosine similarity.
  When configured, the optional reranker replaces final hit scores with relevance scores.
  Desktop publishes the lexical stage first and enriches when global embeddings or a reranker are configured.
  The agent awaits its one bounded final response. Pure retrieval uses no answer LLM.
- On explicit search, embed at most 128 missing scoped chunks in batches of 16, shared
  across nonempty domains. Each request is bounded to eight seconds; enrichment has a
  22-second budget and stays within the overall native request deadline. Partial coverage
  is reported with indexed/total counts; later searches resume. There is no claim that a
  large repository becomes fully semantic after one search. Path/source/test exclusions
  constrain uploads as well as matches. Document input is bounded to 8192 characters before
  the saved prefix. Query vectors are reused when input and configuration are unchanged.
- Cache identities include provider, endpoint, model, dimensions and prefixes. Document
  input hashes include paths/headings/content. Only current lexical-snapshot chunks may
  match: deleted/renamed/changed/ignored content cannot retain old references after refresh.
  Unreferenced paid vectors are retained, not silently erased; model changes get separate
  identities. The cache is bounded to 50,000 vectors and 256 MiB; exhaustion is visible and
  never triggers destructive repair or automatic purchased-vector eviction.
- Expiring, token-owned per-identity leases prevent concurrent provider publishers.
  Native vector identity leases expire after 60 seconds and renew when less than
  30 seconds remain; expired or replaced tokens cannot renew or publish.
  Source and provider leases renew every 30 seconds with a 90-second expiry. HTTP never runs
  inside SQLite write transactions. A same-database publication fence validates ownership
  when each short transaction commits; lost ownership cannot be renewed or used to publish,
  and this does not provide atomic commits across source-local databases. A queued source
  keeps renewing its claim and rechecks it after acquiring a provider slot. Cancellation
  retains claims/slots until the tracked transport actually settles. After two failed or
  interrupted network attempts (the initial attempt plus one automatic retry), work requires
  explicit Continue; success resets the failure count. Continue clears the exhausted budget
  before reconciliation. A failed-work cooldown limits immediate retries, but a crash after
  transmission can still cause duplicate provider billing. A separate global provider-work
  database coordinates at most four valid local leases across projects/processes; after a
  crash or partition this cannot prove the count of remote provider executions. Snapshot
  generation and the exact
  global configuration signature are checked before uploads, after responses and before final
  publication; in-flight work observes revocation via cancellation. Already transmitted
  bytes cannot be recalled. Lost/expired lease owners cannot publish or release successors.
  Failed/cancelled/config-stale enrichment preserves lexical results and uses redacted notices.

## Constraints and failure cases

- Parsing, hashing and synchronous SQLite are in an owned child process, not the UI/main
  event loop. No Desktop session is needed. Workspace/query changes abort the native child
  and suppress late results. In Desktop, closing the owning window or quitting the app
  also cancels native search/indexing children (see
  [native process lifecycle](../architecture/desktop-native-process-lifecycle.md)). Owners close streams/listeners/timers and terminate processes
  on cancellation, timeout, abnormal exit or output overflow.
- Storage rejects redirected directories, symlink/hardlink databases or sidecars, unknown
  native schemas/versions/identities and dangerous triggers without deleting user data.
  Workspace relocation does not silently rewrite index identity. Indexes are disposable
  caches, but automatic destructive repair is outside this slice.
- File enumeration, bytes, chunks, time, output and SQL candidates are bounded. Reaching a
  cap or losing a freshness race must be reported, not called a complete index. This version
  rehashes eligible files on warm search; incremental writes do not imply O(changes) reads.
- Explicit manual indexing is separate from search-driven enrichment: it drains all
  eligible missing documents in batches of at most 16, with no overall 128-document cap
  or overall native CLI/Rust/semantic timeout. Per-HTTP-request timeouts, cancellation
  and storage safety bounds remain. Search-driven Code/Knowledge uploads retain the shared
  128-chunk cap and search deadlines.
- File references describe an observed snapshot, not an immutable checkout. Consumers must
  re-read before editing or using evidence. No portable whole-filesystem atomic snapshot or
  defence against a hostile actor replacing ancestor directories at every syscall is promised.
- Knowledge active-spec authority, declaration relationships, dirty/acknowledge review,
  and AST/dependency views are not part of native repository search.

Files with a source line longer than the 8,000-character chunk bound are deliberately
excluded (including removal of any old indexed rows for that file), not treated as a
whole-scan failure. Other eligible files remain searchable.

## Implementation

- `external/pi-tools-suite/src/project-search/native-contract.ts`
- `external/pi-tools-suite/src/project-search/native-ranking.mjs`
- `external/pi-tools-suite/src/project-search/reranker-documents.mjs`
- `external/pi-tools-suite/src/project-search/session-read-cache.mjs`
- `external/pi-tools-suite/src/project-search/native-source-config.mjs`
- `external/pi-tools-suite/src/project-search/native-engine.mjs`
- `external/pi-tools-suite/src/project-search/native-scan.mjs`
- `external/pi-tools-suite/src/project-search/native-store.mjs`
- `external/pi-tools-suite/src/project-search/source-work.mjs`
- `external/pi-tools-suite/src/project-search/native-semantic.mjs`
- `external/pi-tools-suite/src/project-search/native-vector-store.mjs`
- `external/pi-tools-suite/src/project-search/native-embedding-provider.mjs`
- `external/pi-tools-suite/src/project-search/native-embedding-provider.d.mts`
- `external/pi-tools-suite/src/project-search/semantic-command.ts`
- `external/pi-tools-suite/src/project-search/semantic-reset.ts`
- `external/pi-tools-suite/src/project-search/native-cli.mjs`
- `external/pi-tools-suite/src/project-search/native.ts`
- `external/pi-tools-suite/src/project-search/engine.ts`
- `external/pi-tools-suite/src/project-search/index.ts`
- `external/pi-tools-suite/src/module-catalog.ts`
- `external/pi-tools-suite/src/repo-discovery/subagent.ts`
- `desktop/src/lib/native-repository-search.ts`
- `desktop/src/lib/universal-search.ts`
- `desktop/src/components/UniversalSearch.svelte`
- `desktop/src/components/NativeRepositorySemanticConsent.svelte`
- `desktop/src-tauri/src/native_repository_semantic_config.rs`
- `desktop/src-tauri/src/native_project_search.rs`
- `desktop/src-tauri/src/backend_runtime.rs`
- `desktop/src-tauri/src/lib.rs`
- `external/pi-tools-suite/package.json`
- `external/pi-tools-suite/package-lock.json`
- `package.json`
- `package-lock.json`

## Tests

- `external/pi-tools-suite/test/native-source-config.test.ts`
- `external/pi-tools-suite/test/native-project-search.test.ts`
- `external/pi-tools-suite/test/source-work.test.mjs`
- `external/pi-tools-suite/test/native-semantic-search.test.ts`
- `external/pi-tools-suite/test/native-semantic-command.test.ts`
- `external/pi-tools-suite/test/semantic-reset.test.ts`
- `external/pi-tools-suite/test/tool-descriptions.test.ts`
- `external/pi-tools-suite/test/project-search.test.ts`
- `external/pi-tools-suite/test/async-subagents/repo-tools.test.ts`
- `external/pi-tools-suite/test/async-subagents/provider-child-inventory.test.ts`
- `desktop/src/lib/native-repository-search.test.ts`
- `desktop/src/lib/universal-search.test.ts`
- `desktop/src/components/UniversalSearch.test.ts`
- `desktop/src-tauri/src/native_project_search.rs`
- `desktop/src-tauri/src/backend_runtime.rs`
- `scripts/release/test/native-search.test.mjs`
- `desktop/src-tauri/src/native_repository_semantic_config.rs`

## Verification

Use deterministic no-key fixtures for file/line correctness, incremental deletion,
ignore changes, storage rejection, competing generations and cancellation. Run the host `npm run check:ci` gate and report
blocked/incomplete legs. Real Desktop evidence is separate from unit-test success.
Semantic regressions use deterministic injected embeddings/HTTP responses, never paid
requests: no-token-overlap matches, incrementality, model isolation, scope/privacy,
bounded progression, revocation, stale publication, leases and malformed responses.

<!-- pix:wiki-check {"version":1,"status":"attempted","runId":"be10804d-802a-4a0d-81f8-ba18fd60f930","contentHash":"c3e5ad3aac99dc163f77db4c074b2747dfb689a01294deccb9b7ba54a00a620f","checkedAt":"2026-10-31T00:50:12.083Z","maxDocumentChars":128000} -->
