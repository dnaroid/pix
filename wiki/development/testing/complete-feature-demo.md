# Pix demo: a connected agent workspace

**Status: production script, not a recorded or verified demonstration.**
This document authorizes no recording, UI automation, provider calls, publication,
or changes to the demonstration project. Those are a separate execution stage.

[Testing and QA](index.md) · [60–90 second task-to-diff teaser](task-to-diff-demo.md) ·
[English subtitle track](complete-feature-demo.en.srt)

## Editorial decision

Show **one project moving through a complete workflow**, not a tour of menus.
The distinctive story is how Pix connects project knowledge, saved work, live
agents, human decisions, reusable resources, and evidence. Do not spend scenes
explaining generic chat, model streaming, file editing, shell commands, ordinary
Git diffs, or merely having multiple providers.

- **Complete master:** an 18-minute editorial target; allow 18–22 minutes for
  readable evidence. Every scene below belongs to this version, including the
  integrations and TUI chapter. This is screen time, not execution time.
- **Short derivative:** a 2–3 minute trailer selected from the master, not a
  replacement for complete coverage. Use S01 → S03 → S05 → S09 → S12 → S24.
- **Language:** English UI, prompts, replies, file comments, task names, captions,
  and narration. Do not paint translated text over actual application results.
- **Format:** native macOS Apple Silicon Desktop for S01–S22 and S24; a clearly
  labelled real Pix TUI chapter for S23. Do not imply other Desktop platforms
  are supported or substitute a browser preview for the native application.
- **Scope of “all”:** the current user-facing differentiators in the coverage
  ledger below. Low-level implementation details, generic harness functions,
  historical/proposed features, and every provider permutation are not separate
  demonstrations. Update the ledger when the product changes.

The full claim is conditional on recording every ledger row. A missing provider,
service, permission, or live result means **blocked/not demonstrated**, not
permission to replace it with a mock success. A settings tour is not proof of a
working integration. Experimental behavior stays explicitly labelled.

## Project and narrative

Use a disposable public **Greeting Lab** project based on the
[small demo fixture](task-to-diff-demo.md#prepare-off-camera). Its simple code
keeps attention on Pix rather than on understanding a large application.

The story: **“Take a small requirement from an idea to a verified change, keep
the reasoning discoverable, and reuse the workflow.”** The change is whitespace
normalization in `greeting(name)`, preserving the default `QA` name. The feature
is deliberately ordinary; the surrounding workflow is the demonstration.

### Prepare once, off camera

1. Prepare the fixture's English-only baseline as described in the teaser.
   Keep its two original tests and a local baseline commit. No dependency
   installation, remote, push, or customer files in this primary fixture.
   Do not pre-implement the whitespace change or fabricate agent/test results.
2. Add a small English Wiki with `index.md`, `greeting-policy.md`, and
   `release-checklist.md`. Seed a **declared documentation fixture**:
   the policy specifies `QA` for an empty name, while the checklist incorrectly
   says `Guest`. The policy is the designated authority. This is a staged input,
   not a pre-generated checker finding. Create genuine reports during execution.
3. Prepare a public Markdown attachment containing the acceptance cases, a
   project task epic `Greeting release`, and a small source file worth explaining.
   Leave the actual task creation, linked plan, implementation, and review for
   their scenes. Seed only navigation/history fixtures explicitly labelled as
   such; never pass them off as work just completed on camera.
4. Configure English output, provider credentials, Main/Fast/Strong roles,
   assistant models, a coding model, and the supported thinking levels off camera.
   ZAI was used in earlier smoke QA; use the actually configured model's name,
   not a scripted claim about a model that is unavailable at recording time.
5. Enable the selected project search sources explicitly. Default to lexical
   retrieval. Use one distinctive token, `greeting-policy`, across code, Wiki,
   a saved task, a genuine completed session, and a baseline commit message for
   the cross-source search shot. Session indexing may lag; prepare completed
   history in advance or explicitly index it, never claim an active session was
   immediately indexed. Keep Settings search as a separate global source.
6. Prepare integration prerequisites from the table below, plus a harmless
   finite background command and a project launch command `Run greeting tests`.
   Keep recorded script output small and English. Don't show account identifiers.
7. Record **sequential chapters**, with one persistent isolated Desktop profile
   and **one app lifetime per chapter**. This is the user-approved capture mode:
   the QA supervisor has a nonrenewable 15-minute limit, shorter than the full
   master even before generation waits. Preserve drafts while navigating within
   a chapter; finish or explicitly save valuable draft text before closing it
   because in-memory drafts are not restart-persistent. Keep saved sessions and
   history between chapters. Do not kill/relaunch between short probes or bypass
   the supervisor deadline. The separate TUI has its own session; never open a
   still-running Desktop session for concurrent writes.
8. Check capture scale and caption safe area. Close unrelated projects and
   notifications. Preserve the build identifier and real execution timestamps.
   Rehearsal screenshots/AX evidence can use `recordWindowVideo: false`; recording
   itself must be explicitly authorized later. Export evidence needed for the
   final edit from disposable `.pi/artifacts/<unique-run>/` before cleanup.

### Integration gates (required for a complete master)

| Scenes | Prerequisite and boundary |
| --- | --- |
| S02 | Search works without embeddings. RAG sends question and retrieved excerpts to its configured model. Auto additionally needs OpenRouter for query-only intent classification; disclose cost and fallback. Semantic indexing/reranking is a separately enabled, paid/data-sharing demonstration, not a prerequisite for lexical search. |
| S07 | BTW model available. Observer is explicitly opted into, experimental, and may return no suggestion. |
| S09 | Local bundled engines; no CDN or network assets. Three.js needs working WebGL2; a fallback notice is not a successful 3D demonstration. |
| S15/S19 | Configured role models and at least two actually available council models. Model discovery/council requests may cost money; use current identifiers, not obsolete scripted ones. |
| S16 | Disposable, separately approved Registry destination and project/global test resources. Publication/sync writes remote state; do not point this scene at a production Registry. |
| S18 | Real native target and supported QA permissions. No fabricated/browser substitute. Record only this explicit test's evidence. |
| S20 | Deepgram configured off camera; microphone consent. Audio goes to Deepgram. Native F5 additionally requires Accessibility; microphone-button input does not. |
| S21 | Authorized private Telegram forum and bot, with test-only participants. Topic messages become real prompts. Keep Desktop running and awake. |
| S22 | A **second**, expressly approved disposable remote repository, authenticated `gh`/`glab`, and a reproducible failing CI run at its current full HEAD. The repair action authorizes commit, push, and monitoring. Never use the no-remote main fixture or the Pix repository. |
| S23 | Working Pix TUI and public fixture copy. Snapshot undo must be enabled/supported before demonstrating restoration. |

If a gate is unavailable, retain the scene in this script, mark the production
checklist blocked, and do not advertise the resulting shorter video as complete.
No credentials or authorization flows belong in footage or subtitle files.

## Run order versus edit order

The timeline below is the **edit order**. Reduce dead time without falsifying it:

Capture 3–5 observable checks per chapter, reserving time for owned graceful
cleanup before the 15-minute deadline. Scene boundaries are editorial, not a
requirement to finish four complex workflows in one launch: carry unfinished
scenes into the next chapter using saved state and honest continuation labels.
Do not leave implementation running across shutdown merely to meet the budget;
pause at a safe boundary, verify settlement, and preserve its saved session.

1. Capture S01–S04 in sequence. Let the implementation/research work start.
2. During real background work, capture read-only BTW, Preview, Usage, and model
   configuration views in the same app lifetime. Do not alter an executing
   session's model, files, or decision while shooting an unrelated insert.
3. Start costly independent council and integration preparation early in their
   own clearly named sessions. Keep all writers serialized by project/file;
   the council, reviews, and research tracks are read-only.
4. Capture the actual implementation/test/review/Wiki outcomes when available.
   Use chapter cuts, not animations that suggest an instantaneous response.
5. Finish remote/Registry/Telegram segments only in their designated sandboxes;
   return to the primary project for the closing shot. Capture TUI separately.

Keep the prompt, active work, and actual result visible at least once per live
feature. Cut repetitive typing, idle waits, redundant panel opening, and long
logs. Show `Waiting shortened · actual elapsed: …` whenever removing substantial
execution time. Retakes use fresh declared inputs; don't loop a completed run
and present it as fresh execution.

## Storyboard

Times are target edit positions. `C01`–`C48` map to the subtitle cue table and
the accompanying `.srt`. Each scene needs its observable result, not just its
title card. Longer generation time changes the edit, not the acceptance check.

| Scene / target | Actions and framing | Observable payoff / stop condition | Cues |
| --- | --- | --- | --- |
| **S01 · 00:00–00:25** Connected workspace | Open Greeting Lab. Sweep once across Project, Wiki, Work, Source Control; leave a typed draft, navigate away, return. Show project identity briefly, not a theme tour. | Same editable draft survives navigation in this lifetime; one coherent project, no fabricated restart-persistence claim. | C01–02 |
| **S02 · 00:25–01:05** Search to evidence | Submit `greeting-policy` in Search; use enabled source filters and open code, task, Wiki, commit, and historical session hits. Ask the policy question in RAG, click its citation; show Auto's decision or honest fallback. | Correct original source opens. RAG answer remains outside chat and cites supplied evidence; citation validation is not a truth guarantee. Optional semantic/reranking insert must show its actual configuration/result and disclosure. | C03–04 |
| **S03 · 01:05–01:50** Saved work → plan → run | Quick-add `Normalize greeting names`; attach acceptance cases, link the epic/related task, choose model/thinking. Use Create plan, inspect saved checklist, then Run the task. Follow Task → Plan → session breadcrumbs. | Plan authoring is separate from execution; Run starts/opens the linked session with saved inputs. Show saved-plan progress versus live Steps. Do not create duplicate sessions by retrying Run blindly. | C05–06 |
| **S04 · 01:50–02:25** Human control in the composer | The task's P2 gate asks a two-question decision, including multi-select plus custom text. Switch tabs while it waits; return, inspect Preview, submit. In a separate idle draft show a ghost completion accepted with Tab, dismissed with Esc, and an idle next-message suggestion if one is produced. | Question stays owned by its session; user explicitly submits the answers. Autocomplete may abstain and never sends by itself. This is not a generic “AI can ask questions” segment. | C07–08 |
| **S05 · 02:25–03:15** Inspectable parallel work | Run P3. Show independent roles/models in live HUD, Steps with blockers, a step's jump-to-start, and a child transcript. Open a completed child from its tool card/statistics; Continue in new session, then return to parent. | Separate read-only child viewers expose real progress/results; continuation creates a normal independent session, not a writable child. Parent implements only after findings. | C09–10 |
| **S06 · 03:15–03:55** Branch without disruption | During real work, type the non-mutating alternative prompt P4 and Send to fork. Keep focus on the parent until its safe boundary. Separately request Pause; show pending state and Continue after settlement. | Fork opens in background without submitting the draft to the parent. Pause finishes the current turn/tools and may wait for live children; Continue adds no synthetic prompt. If work ends too quickly, retake a real bounded task, not a fake busy indicator. | C11–12 |
| **S07 · 03:55–04:30** Side thinking | In BTW ask why the fallback matters, optionally include a selected completed excerpt. Close it and show unchanged main transcript. Enable labelled experimental Observer, Check now, inspect any grounded suggestion before Insert into an empty draft. | BTW has no tools and is temporary. Observer may abstain; a real no-suggestion result is honest evidence, not a guaranteed finding or autonomous fix. | C13–14 |
| **S08 · 04:30–05:10** Read without a new chat | Preview the implementation, Explain Code on a selection, then whole-file Explain. Toggle notes without regeneration. Prepare translation from a public non-English document off camera; capture only the resulting English selection popover and whole-document Markdown preview, preserving code. | Inline notes and translation stay in Preview, with cache reuse; no extra conversation. Label the translation input as prepared off camera; never overlay a translated screenshot or expose non-English input in the English master. | C15–16 |
| **S09 · 05:10–06:00** Working outputs in chat | Use P5: operate the inline form, a local Phaser interaction, and a procedural Three.js view. Submit the form and show the acknowledgement/agent response. Then select a completed-turn `pix-actions` follow-up. | Real interaction and submitted values; no standalone-file substitution, CDN, or fictional sandbox capability. Show Run/Stop/Restart briefly. Follow-up checklist is distinct from a blocking question. | C17–18 |
| **S10 · 06:00–06:40** Processes without extra chats | Run the saved project launch command; focus its existing terminal instead of duplicating it, stop/restart if appropriate. Use `!!` for a terminal-only action. In an agent session start a finite background job, inspect output and explicitly stop an owned long-lived test job. | Workspace terminal and shell-tool job are visibly different; neither implies a second conversation. Shell-capable child roles can own jobs; jobs are not inherited after the child exits. | C19–20 |
| **S11 · 06:40–07:30** Review → scoped repair | Show actual focused test results and the diff. Request Source Control review for all changes/staged scope. Open a finding and Fix in new session only if a real actionable finding exists. Stage selected demo files and generate a message without committing. | Advisory review and bounded repair handoff; unrelated work stays intact. If no finding, use a separately declared deliberately flawed review input; never invent a reviewer finding. Avoid Stage all & generate on an empty index. | C21–22 |
| **S12 · 07:30–08:45** Knowledge that can disagree | Show Wiki visual/source editing, search, and a rendered source highlight. Run consistency check on seeded contradictory policy pages. Inspect quotes in Conflicts, select findings/basket, Resolve in new session, and recheck the actual correction. Export/open self-contained HTML. | Grounded quote pair, human authority decision, real fix and new check; no claim of exhaustive truth. Show incomplete/no-conflict honestly if that is the result. Export is browser-readable without a server. | C23–24 |
| **S13 · 08:45–09:20** Cost and quota context | Open Usage: project/time-filtered token history, session details, live provider limits/reset timeline, and child-run statistics where available. In the paused test session use Schedule continuation with a short future deadline; show countdown, Hide/reopen, and Cancel auto-resume. | Historical consumption is distinct from account quota and elapsed reset time. Scheduled continuation preserves the task/draft; automatic quota wait requires a real exhausted limit, not a generic 429. Do not deliberately exhaust an account or fake exhaustion. No timer runs while the app is closed. | C25–26 |
| **S14 · 09:20–10:00** Continuity, not amnesia | In a genuinely completed longer demo branch, selectively compress closed work while retaining the current requirement and evidence paths. Show compression result/statistics; ask for a prior decision through session overview/read/search. | Actual raw-history recovery with source identity, not a guessed recollection. Report observed change, not a scripted token saving or guaranteed lower cost. Active work is not thrown away for a dramatic graph. | C27–28 |
| **S15 · 10:00–10:45** Models by responsibility | Show Main/Fast/Strong and assistant-specific routing/fallbacks/thinking. Show In use/replacement preview and current model-discovery suggestions if available. Return to the visibly selected coding model and a real response. | Roles and per-feature models are clear. Do not change shared defaults during live work or claim discovery installed anything. A single provider dropdown is not the feature. | C29–30 |
| **S16 · 10:45–11:35** Reuse project intelligence | In the disposable Registry, inspect a skill/agent and companion-file Diff, tags and project/global scope. With separate approval, publish a test project-scoped resource and sync tasks/plans/attachments/workspace to a second disposable copy. Inspect the received saved plan; show launch/resume history back in its original workspace. | Read-only comparison first, explicit publication second; portable project state actually arrives. Do not imply launch history or private transcripts were synchronized, publish credentials, or present Registry as a generic folder backup. | C31–32 |
| **S17 · 11:35–12:20** Tools with structure | Use P6 to demonstrate AST search → preview → bounded rewrite in a separate public snippet; inspect the diff. Batch independent lookups via codemode and discover one preconfigured MCP tool on demand. | Structural matching is not regex; codemode combines tool results without a separate second LLM. Tool discovery alone is not MCP execution proof; invoke only a safe read operation. Generic shell/web-search output gets no standalone scene. | C33–34 |
| **S18 · 12:20–13:10** Evidence-producing QA | Explicitly delegate P7 against the real native application: preserve draft, navigate, select coding model, submit a non-mutating prompt, inspect response. Open retained screenshot/AX/report evidence. | Real UI, one lifetime, named postconditions. No synthetic target or “tests passed, therefore UI works” substitution. Recording is separately controlled; evidence links are preserved/exported. | C35–36 |
| **S19 · 13:10–14:00** Multi-model council | Invoke `/brainstorm` with P8 and exact available models. Show model/round records, disagreement, synthesis, and one research viewer. | Two to six models, five genuine read-only rounds; show real elapsed time. It is a skill coordinating research agents, not a new tool or automatic implementation. | C37–38 |
| **S20 · 14:00–14:40** Voice where work happens | Dictate P9 into composer, correct text, submit explicitly. Dictate a Search query. If configured, demonstrate native F5; show TUI Ctrl+G in S23 rather than switching here. | Actual recognized draft/query; consent and service use disclosed. No voice-triggered silent execution or claim of offline recognition. | C39–40 |
| **S21 · 14:40–15:25** Remote session access | In the private Telegram test topic, send P10 to an already running Desktop session; return to its settled response. Show a second topic's separate session identity. | Authorized prompts reach the correct live session. No streamed intermediate tool claims, headless cloud-hosting claim, or promise of permanent topic history. Don't close the Desktop owner during the shot. | C41–42 |
| **S22 · 15:25–16:15** Exact-commit CI repair | Switch visibly to the approved disposable remote fixture. Show failed CI for full HEAD, jobs/details, then Fix with AI and its actual repair/check/commit/push/monitor cycle. | Final CI belongs to the new exact HEAD. This action is broader than review repair; record remote side effects and actual outcome. Never silently substitute an older green branch run. | C43–44 |
| **S23 · 16:15–17:20** TUI is a real workspace | Label the host switch. Show Pix TUI tabs, sidebar, command menu, adaptive Steps/agent panels, the same structured question/voice workflow, then a harmless fixture edit with supported snapshot undo. Brief inserts: a new unmaterialized draft tab, fuzzy `@` file mention, and staged combined model/thinking selector confirmed with Enter. | Real renderer and live runtime, not README MockModel captures. A mention inserts a path, not file contents; a draft has no runtime until materialized. Undo restores only its documented workspace scope; never equate transcript rewind with arbitrary filesystem rollback. | C45–46 |
| **S24 · 17:20–18:00** Close the loop | Return to Greeting Lab. Show task/plan/session chain, actual tests and review, corrected Wiki citation, QA evidence, and received Registry resource. Show completed/blocked ledger counts. | Mark task Done only with authorized outcome or explicit user action. Distinguish saved checklist marks from proof. Finish with actual coverage, costs/time where known, and labelled experimental/blocked items. | C47–48 |

## Copyable prompts

These prompts are **future recording inputs**, not instructions to execute while
editing this document. Use English throughout. When a prompt mentions a capability
that is not configured, stop and disclose it rather than inventing a result.

### P1 — Task description / acceptance attachment

Include P2 and P3 as ordered phases in the saved task/plan before Run: first
question and wait, then research and implement. They are written separately
below for framing, not to be submitted as competing prompts while the task runs.
Plan authoring remains planning-only; these phases govern later execution.

```text
Normalize greeting(name) by trimming surrounding whitespace. Empty or
whitespace-only names must use QA. Preserve the default and named cases.
Acceptance: greeting("  Ada  ") is "Hello, Ada!"; greeting("") and
greeting("   ") are "Hello, QA!". Add focused regression tests and run npm test.
Keep changes in this disposable project. No dependencies, commits, pushes,
or changes to Pix. Use English for all replies, plans, comments and tests.
```

### P2 — Structured decision

```text
Before continuing, use the question tool for two decisions. First ask which
empty-name policy to use: QA (the existing policy) or a validation error.
Then ask which edge cases to cover, allowing multiple selections and a custom
answer. Wait for my answers. Do not edit files yet.
```

Choose the existing QA policy; select spaces and tabs plus custom `line breaks`.
The custom answer adds test scope, not permission to change the established API.

### P3 — Independent research and implementation

```text
Spawn two independent read-only research tracks: trace the greeting contract,
and identify missing whitespace tests. Show scoped findings and source paths.
Then implement the agreed requirement yourself, run focused tests, and report
the real diff and result. Track live steps separately from the saved project
task. Preserve unrelated changes. No commit, push or dependency installation.
```

### P4 — Send to fork (composer draft, not a parent submission)

```text
Explore a validation-error alternative without changing files. Compare it with
the agreed QA fallback and give the tradeoffs in three bullets. Do not implement.
```

### P5 — Interactive deliverable and follow-up

```text
Build a small working Greeting Lab experience here in chat, not in files.
Include a name form with a live greeting preview and explicit Submit to Pix,
a tiny locally bundled Phaser interaction, and a procedural Three.js object
with rotation control and a visible unsupported-renderer fallback. Use no
network, CDN or remote assets. Keep controls readable and release resources
when stopped. Submitted form values are a request for explanation only, not
permission to edit files. Afterwards offer a pix-actions checklist with two
non-mutating follow-ups: explain the greeting cases, or summarize the controls.
```

### P6 — Structured tools (separate scratch snippet)

```text
In the declared disposable snippet only, use ast_grep first to find calls of
legacyGreeting with one argument; preview replacement with greeting, then use
ast_apply only on the confirmed matches. Show the diff and a focused check.
In a separate read-only step use codemode to batch two independent tool reads.
Discover the preconfigured documentation MCP tool and execute one harmless
lookup; do not install tools, configure providers, or send private content.
```

### P7 — Real UI QA (only after execution is authorized)

```text
Use ui-qa to test the real Pix Desktop application in Greeting Lab. In one app
lifetime, create an editable English draft, navigate away and back, and verify
the exact text remains. Visibly select the configured coding model, submit
"Explain this project's README in three bullets; do not change files", and
verify an actual response. Keep the profile, use no automatic window video,
and return screenshot, accessibility and report links for the postconditions.
Report a concrete blocker rather than substituting a mock or browser preview.
```

### P8 — Council

```text
/brainstorm Compare three ways to handle empty user names in this small
public library. Use these exact configured models: <model A>, <model B>.
Follow the five-round read-only council protocol. Separate compatibility,
usability and testing tradeoffs; preserve disagreement and cite project facts.
Do not implement, commit, push, or change the accepted task's scope.
```

Replace placeholders off camera with actual available models. Do not describe
a partially completed council as a final five-round synthesis.

### P9 — Voice

```text
Summarize the verified greeting behavior in three short bullets. Do not edit files.
```

### P10 — Telegram

```text
Report the current greeting task status and the latest actual test result.
Do not modify files, start a new implementation, commit or push.
```

## Coverage ledger and contract references

Before recording, check these source pages against the target build. A recording
worksheet should add `not started / captured / blocked`, evidence path, actual
elapsed time, and retake notes to every row. Only captured observable behavior
counts. Configuration-only views are identified as such above.

| Distinctive feature family | Scene | Authoritative contract |
| --- | --- | --- |
| Native project workbench, identity, navigation with draft retention | S01 | [Desktop guide](../../desktop/guide.md) |
| Unified project sources, lexical/optional semantic retrieval, Auto/Search/RAG, citations | S02 | [Universal Search](../../search/desktop-universal-search.md), [agent search](../../search/project-search-agent-tool.md) |
| Persistent tasks, attachments, relations, model/thinking, plan authoring and separate launch | S03/S24 | [Tasks](../../work-management/tasks/desktop.md), [Plans](../../work-management/registry/desktop-registry-plans.md) |
| Inline multi-question/multi-select/custom answers, ownership, preview; typed/idle autocomplete | S04 | [Questions](../../desktop/conversations/desktop-question-tool.md), [autocomplete](../../desktop/conversations/desktop-autocomplete.md) |
| Async role/model agents, live Steps, jump-to-start, child viewers and continuation | S05 | [Session activity](../../desktop/conversations/desktop-session-sidebar.md) |
| Safe-boundary Pause/Continue and Send to fork without focus steal | S06 | [Pause](../../desktop/conversations/desktop-agent-pause.md), [Send to fork](../../desktop/conversations/desktop-send-to-fork.md) |
| Tool-free BTW, opt-in experimental Observer | S07 | [Assistants](../../assistants/index.md) |
| Selection/file Explain, selection/document Translate, cached inline results | S08 | [Selection assistant](../../desktop/conversations/desktop-selection-assist.md) |
| Inline HTML/form bridge, local Phaser/Three.js, sandbox controls, next-step checklists | S09 | [HTML sandbox and actions](../../desktop/rendering/desktop-html-sandbox.md) |
| Saved launch commands, reusable workspace terminals, `!!`, agent/child background jobs | S10 | [Launch Commands](../../desktop/integrations/desktop-package-scripts.md), [background shell](../../tools/background-shell.md) |
| Scope-aware review, repair session handoff, staged-message generation | S11 | [Git workflows](../../desktop/integrations/desktop-git-workflows.md) |
| Wiki visual/source editing, grounded checks, conflicts/batches, resolution, recheck, HTML export | S12 | [Project Wiki](../../desktop/workbench/desktop-project-wiki.md) |
| Project/session usage, provider quota/reset timeline, child-run statistics | S13 | [Usage statistics](../../usage/desktop-usage-stats.md), [quota calendar](../../usage/desktop-quota-calendar.md) |
| Scheduled continuation, retained task/countdown, quota-aware wait controls | S13 | [Session quota wait](../../providers/session-quota-wait.md) |
| Selective context compression, statistics, protected continuity, raw-session recovery | S14 | [DCP](../../context/dcp.md), [statistics](../../context/dcp-statistics.md), [session tool](../../context/session-recovery.md) |
| Role/feature routing, thinking/fallbacks, in-use replacement/model discovery | S15 | [Desktop guide](../../desktop/guide.md), [providers](../../providers/index.md) |
| Resource/companion diff, tags, publication scope, portable tasks/plans/attachments/workspace | S16 | [Resource diff](../../work-management/registry/desktop-registry-resource-diff.md), [publication](../../work-management/registry/resource-registry-publication-tags.md), [project state](../../work-management/registry/resource-registry-project-state.md) |
| AST search/rewrite, code-mode composition, on-demand tool discovery | S17 | [Tools](../../tools/index.md), [codemode](../../tools/suite-codemode.md) |
| Delegated real UI QA with inspectable evidence and lifecycle ownership | S18 | [UI QA](ui-qa-subagent.md), [isolated native QA](desktop-qa-isolated-launch.md) |
| Five-round multi-model research council | S19 | [Brainstorm](../../assistants/brainstorm.md) |
| Voice for composer/search/TUI | S20/S23 | [Deepgram voice](../../assistants/deepgram-voice-input.md) |
| Authorized Telegram topics mapped to running sessions | S21 | [Telegram bridge](../../assistants/telegram-bridge.md) |
| Full-HEAD CI status and explicitly authorized autonomous repair/push | S22 | [Git workflows](../../desktop/integrations/desktop-git-workflows.md) |
| Pix TUI workspace/panels, lazy drafts, fuzzy path mentions, combined model/thinking selection, structured interaction, bounded filesystem undo | S23 | [TUI guide](../../tui/guide.md), [mentions](../../tui/tui-file-mentions.md), [selector](../../tui/tui-model-thinking-selector.md), [draft tabs](../../tui/tui-session-tabs.md) |

### Deliberate exclusions

Do not pad the master with generic file read/write, normal chat, ordinary model
selection, basic terminal/Git commands, themes, notifications, or Markdown code
blocks. Mention provider compatibility only when it explains a demonstrated
workflow. Do not promote archived proposals or low-level cache/race safeguards
as separate visible features. Historical thinking pruning and other experiments
without a reliable user-visible shot are not advertised as completed features.
The explicitly included Observer remains experimental, even if its shot succeeds.
Provider-specific transport safeguards (for example Claude image-count handling
and attachment-read recovery) are implementation/resilience details, not separate
feature claims. Do not manufacture a provider error to fill a dramatic scene.

## Subtitles and presentation

The `.srt` is a **feature-description track**, not a transcript and not evidence
that the actions occurred. Use a restrained lower-third: at most two lines,
roughly 42 characters per line, strong contrast, no opaque overlay over the
composer, status HUD, citations, or evidence under discussion. Move the caption
to a free top-safe area for bottom-of-window interactions. Briefly hold each
result before the next cut; do not cover an error with a marketing caption.

Retiming is mandatory after capture. These 48 cues anchor a nominal 18-minute
master and intentionally leave quiet gaps for reading actual UI. They describe
capabilities, not fabricated success statements. Burn in an English copy for
silent autoplay and also ship the selectable `.srt`; keep an uncaptioned master.
Optional Russian localization belongs in a separate track, not mixed into the
English master. If a scene is blocked, replace its claim with an explicit status
card and remove/retime its feature cues; do not silently leave its success claim.

The cue table is the editorial source for `complete-feature-demo.en.srt`.
` / ` marks a subtitle line break. Keep the two files synchronized.

| Cue | In | Out | English text |
| --- | --- | --- | --- |
| C01 | 00:00:02 | 00:00:09 | A project workspace, not just a chat. |
| C02 | 00:00:13 | 00:00:21 | Keep your draft while moving / between project views. |
| C03 | 00:00:28 | 00:00:36 | Search code, knowledge, work / and project history together. |
| C04 | 00:00:47 | 00:00:56 | Ask with retrieved evidence. / Open the sources behind the answer. |
| C05 | 00:01:09 | 00:01:18 | Turn a saved task into a linked plan / and a separate execution session. |
| C06 | 00:01:31 | 00:01:40 | Saved plan progress and live steps / are different views of the work. |
| C07 | 00:01:54 | 00:02:03 | Answer structured questions in place. / The decision stays with its session. |
| C08 | 00:02:12 | 00:02:21 | Accept a suggestion, or ignore it. / You decide what gets sent. |
| C09 | 00:02:29 | 00:02:38 | Delegate independent research / to scoped roles and models. |
| C10 | 00:02:55 | 00:03:05 | Inspect a child's real transcript. / Continue in a new session. |
| C11 | 00:03:19 | 00:03:28 | Explore an alternative in a fork / without interrupting the parent. |
| C12 | 00:03:39 | 00:03:49 | Pause at a safe boundary. / Continue the same conversation. |
| C13 | 00:03:59 | 00:04:08 | Ask a tool-free side question / without changing the main history. |
| C14 | 00:04:17 | 00:04:26 | Experimental Observer: / inspect suggestions before using them. |
| C15 | 00:04:34 | 00:04:43 | Explain code directly in Preview. / Keep the main conversation focused. |
| C16 | 00:04:55 | 00:05:04 | Translate a document in place. / Preserve its code and structure. |
| C17 | 00:05:14 | 00:05:23 | Working forms, 2D and 3D / directly inside the conversation. |
| C18 | 00:05:43 | 00:05:53 | Submit an interaction back to Pix. / Choose the next action explicitly. |
| C19 | 00:06:04 | 00:06:13 | Run project commands in reusable / workspace terminals, not new chats. |
| C20 | 00:06:25 | 00:06:35 | Agent-owned background jobs / keep output and lifecycle explicit. |
| C21 | 00:06:44 | 00:06:53 | Review the chosen change scope. / Keep findings tied to the actual diff. |
| C22 | 00:07:14 | 00:07:24 | Hand a real finding to a fix session. / Review is not permission to publish. |
| C23 | 00:07:34 | 00:07:43 | Project knowledge is editable Markdown / with evidence-backed conflict checks. |
| C24 | 00:08:23 | 00:08:33 | Compare quotes, resolve, and recheck. / Export a browsable Wiki. |
| C25 | 00:08:49 | 00:08:58 | See usage by project and session, / alongside provider limits. |
| C26 | 00:09:07 | 00:09:16 | Quota remaining is not elapsed time / or measured daily consumption. |
| C27 | 00:09:24 | 00:09:33 | Compress closed work selectively. / Preserve the current objective. |
| C28 | 00:09:46 | 00:09:56 | Recover earlier decisions / from the original session history. |
| C29 | 00:10:04 | 00:10:13 | Different responsibilities can use / different models and thinking levels. |
| C30 | 00:10:29 | 00:10:39 | Inspect model use and replacements / before changing shared defaults. |
| C31 | 00:10:49 | 00:10:58 | Compare reusable skills and agents, / including their companion files. |
| C32 | 00:11:18 | 00:11:28 | Share approved project resources / and portable work through Registry. |
| C33 | 00:11:39 | 00:11:48 | Find and rewrite code by structure, / not by a fragile text substitution. |
| C34 | 00:12:02 | 00:12:12 | Compose tool calls in code. / Discover extra tools when needed. |
| C35 | 00:12:24 | 00:12:33 | Delegate tests of the real interface / with explicit observable outcomes. |
| C36 | 00:12:51 | 00:13:01 | Inspect screenshots, accessibility / evidence and the actual QA report. |
| C37 | 00:13:14 | 00:13:23 | Let multiple models challenge an idea / through five research rounds. |
| C38 | 00:13:42 | 00:13:52 | Keep disagreement and synthesis. / Research does not authorize edits. |
| C39 | 00:14:04 | 00:14:13 | Dictate into the composer or search. / Review the text before submitting. |
| C40 | 00:14:24 | 00:14:34 | Voice uses the configured service. / Credentials stay off camera. |
| C41 | 00:14:44 | 00:14:53 | Reach a running Desktop session / through its private Telegram topic. |
| C42 | 00:15:08 | 00:15:18 | Authorized messages are real prompts. / Desktop remains the running host. |
| C43 | 00:15:29 | 00:15:38 | CI status belongs to the exact HEAD, / not an older run on the same branch. |
| C44 | 00:15:56 | 00:16:06 | CI repair can commit and push. / Use an explicitly approved sandbox. |
| C45 | 00:16:19 | 00:16:28 | The Pix terminal UI is a workspace, / with tabs and live activity panels. |
| C46 | 00:16:58 | 00:17:08 | Snapshot undo restores its scope. / Chat history is not a disk backup. |
| C47 | 00:17:24 | 00:17:33 | Task, plan, session, diff and evidence: / one connected project workflow. |
| C48 | 00:17:45 | 00:17:55 | Show what actually ran. / Keep limits and blockers visible. |

## Recording acceptance checklist

- [ ] Every coverage-ledger row has genuine evidence or an explicit blocker;
  a blocked row prevents a claim of complete demonstrated coverage.
- [ ] All visible UI/results/captions are English; translation source preparation
  stays off camera. No credentials, private history, or unrelated projects appear.
- [ ] The primary fixture has no remote; publication and CI use only their
  separately approved disposable destinations.
- [ ] Actual tests, source citations, task status, child transcripts, and final
  CI SHA are readable. No pre-generated output stands in for live work.
- [ ] One Desktop lifetime per chapter is maintained within its bounded deadline;
  background writers do not collide. Valuable drafts are saved/finished, and
  child jobs and owned processes are cleaned up without losing the profile/history.
- [ ] Experimental, unavailable, cached, incomplete and failed states remain honest.
- [ ] Long waits carry actual elapsed-time labels; subtitle timing matches the
  final edit and never obscures the controls being demonstrated.
- [ ] Raw recordings and evidence needed for retention are exported; each media
  artifact has its own link. Earlier TUI mock screenshots are not reused as proof.
- [ ] No commit, push, release, account change or publication occurred outside
  the explicitly authorized recording scope.
