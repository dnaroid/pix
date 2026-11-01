---
kind: spec
status: active
---

# Pix Desktop interactive HTML sandbox

<!-- markdownlint-disable MD013 -->

## Goal

Allow Pix's assistant to show runnable, self-contained HTML/CSS/JavaScript
prototypes and games *inside assistant transcript messages*. Forms and scripts
can send bounded JSON data back into the same ACP conversation without
overwriting a user's unfinished composer draft.

Desktop also supports assistant-authored quick-choice actions: a closed
`pix-actions` fence can present a short checklist of agent-executable next
steps, and submit the selected steps as a normal user message. This is separate
from the HTML sandbox and uses its shared generated-prompt submission path.

## Message contract

- Only assistant transcript text opts into the sandbox via a **closed** fenced
  `pix-html` or `html-sandbox` block, with either backticks or tildes.
- Ordinary `html` fences, user/system/thought messages, tool results, and
  oversized closed fences retain the existing escaped Markdown behavior.
- An unclosed assistant `pix-html`/`html-sandbox` fence shows a compact
  awaiting-completion status instead of streaming its source as code. Once the
  opening language is recognized, its body is neither rendered as Markdown nor
  executed; the preview mounts only when a matching closing fence arrives.
  Adjacent Markdown and earlier previews remain visible. Interrupted or replayed
  incomplete blocks retain the same placeholder, not a running iframe.
- A closed sandbox fence can be interleaved with normal explanatory Markdown.
  The iframe keeps its DOM/Canvas while the rest of the assistant message
  streams, unless that sandbox's source actually changes.
- Messages containing an HTML sandbox are excluded from transcript
  `content-visibility: auto` rendering skips so live iframe surfaces remain
  painted across scroll boundaries. Ordinary messages retain the optimization.
- A closed prototype starts automatically when its component mounts, including
  history replay, and restarts when its source changes. Unchanged source keeps
  its running state during adjacent streaming updates. Stop remains effective
  until manual Run, a source change or remount; users can also Restart, resize
  or inspect its source. Incomplete fences do not execute.
- Autorun ownership compares the HTML string through a scalar derived value,
  not the identity of its Markdown segment object. Replacing a segment wrapper
  with equal HTML must not run effect cleanup, remove the iframe, or undo Stop.
- The sandbox measures the actual page's content height using a guest-side
  `ResizeObserver` plus window/load events and sends `content-size` to its
  containing Desktop component. Short pages fit naturally, while tall pages
  grow inline up to a cap scaled to the window height (480–1100 CSS px).
  Expanded mode permits a higher cap (900–1600 CSS px). Larger documents
  retain internal scrolling; the main transcript must not grow unbounded.
  A changing game layout can grow **or shrink** the iframe without restarting
  its JavaScript, losing its Canvas state, or moving it to another tab.
  Reported sizes are bounded, validated, and accepted only from the currently
  running iframe. The header displays the actual measured viewport width
  and current rendered height.
- The internal iframe scrollbar uses the same thin 10px WebKit thumb with a
  transparent track and 38%/58%/72% muted-foreground role for
  default/hover/active as `desktop/src/styles.css`. The parent shares only its
  current computed `--muted-foreground` color via a scoped `theme` message,
  including when the system light/dark appearance changes. This does not
  transmit arbitrary user content or allow guest JS to read parent DOM.

## Scroll-triggered iframe reload regression

The reported symptom was iframe recreation and a white flash when scrolling
the transcript. Excluding sandbox messages from `content-visibility: auto`
alone did not resolve it; keep that rendering safeguard, but do not treat it
as sufficient protection against executable-document restarts.

The autorun effect previously read the source prop directly. That getter could
depend on a reactive Markdown segment object: replacing the object invalidated
the effect even when its HTML string was unchanged. Effect cleanup called
`stop()`, clearing `running` and `srcdoc` and removing the iframe before startup
created a new document.

`desktop/src/lib/html-sandbox-autorun.svelte.ts` now inserts a scalar
`$derived(source())` boundary before the effect. Equal HTML suppresses effect
cleanup and startup despite wrapper replacement. Startup is untracked so runtime
state does not become an autorun dependency. Changed HTML still cleans up and
restarts; component destruction still stops the run and cancels pending work.
Manual Stop remains effective across equal-HTML wrapper updates.

The compiled client-runes regressions in
`desktop/src/lib/html-sandbox-autorun.test.ts` failed before this boundary was
added and passed afterward. They cover repeated equal-HTML wrapper replacement,
changed HTML, manual Stop, unrelated runtime updates and destruction cleanup.
The user subsequently confirmed that the fix resolved the scrolling symptom.
This is user-observed confirmation, not an automated native UI QA pass: the QA
attempts did not reach the prototype conversation.

For a future native regression check, scroll a running prototype out of view
and back repeatedly and confirm its document and live state survive without
white restart flashes. Stop it and repeat; it must stay stopped. Change its HTML
and confirm that the new document starts. This fix does not promise preservation
across actual component destruction/remount or tab switching.

## Desktop agent capability discovery

- Pix Desktop advertises the feature **on every agent turn**, not just when
  a keyword such as `canvas` or `game` appears. The bundled
  `html-sandbox` Pi extension adds a short, idempotent notice through
  `before_agent_start` to the effective system prompt, without editing the
  user's prompt or writing files.
- The notice routes explicit requests for a working interactive experience
  in chat (games, live animations, 2D/3D scenes, forms, calculators, controls or prototypes) to `pix-html`,
  not a standalone file. Explicit file/project requests keep their requested
  deliverable. Static visual explanations prefer SVG; mentioning "in chat"
  alone is not an interactive-UI trigger.
- Before emitting `pix-html`, the agent must check whether the full guide is
  available in the current conversation context: call `pix_html_guide`
  if absent; otherwise follow it without calling again, including for another
  block or an edit to an earlier prototype.
  Capability discussions, HTML explanations, source examples, static
  diagrams and file/project edits do not trigger the guide by themselves.
  The tool description repeats these boundaries for tool-inventory discovery.
  Unsupported capabilities require an explanation and an offered alternative,
  not a silent file substitution or a claim that the sandbox supports them.
- The same Desktop-only capability notice (and, in the TUI, the bundled
  `choice-actions` extension) recommends a `pix-actions` checklist
  when the assistant is ending with one or more next steps it would
  carry out. Each line should be a GFM task item (`- [x] step` recommended,
  or `- [ ] step`); steps the user must perform remain ordinary text.
- A dedicated, read-only `pix_html_guide` tool returns the complete
  fenced-code syntax, JavaScript form-submit bridge, responsive layout
  requirements, examples and sandbox restrictions **only on request**. The
  guide ships with Pix and can be used in an arbitrary workspace; it does not
  rely on workspace-local documentation or shell commands.
  The short notice advertises local Phaser/Three.js support; the full guide
  includes pinned-version references and runnable, asset-free examples.
- The macOS native host supplies the bundled extension's path as
  `PIX_ACP_HTML_SANDBOX_EXTENSION`. ACP accepts it only for Pi RPC sessions
  whose initialized client name is exactly `pix-desktop`. Other ACP clients
  and the Pix TUI do not load this bundled capability by default.

## Authoring

### Quick-choice actions

Choice rule: `pix-actions` offers optional next steps after the turn's work is
finished; the checklist is the last content of the final message, with no tool
calls or further work after it, and the selection arrives as a new user prompt. When the
agent needs the user's answer before it can continue, it calls the blocking
`question` tool instead. The same choice is never offered both ways.
Ending a turn with a closed `pix-actions` checklist counts as waiting on the
user: the todo extension (`external/pi-tools-suite/src/todo/`) does not send its
unfinished-todo auto-nudge after such a reply, just as it waits on a pending
`question`/`ask_user` call. Otherwise the nudge would push the agent past the
checklist it just offered.

Use a closed `pix-actions` fenced block with a button label on the opening
line. The label must not appear as a standalone title in the body. Its body
must contain only 1–8 GFM task items (a single item is a one-click
confirmation); checked items are recommended defaults. For example:

~~~~markdown
Choose what I should do next:

```pix-actions Continue with
- [x] Add the missing tests
- [ ] Update the documentation
```
~~~~

The shared prompt explicitly forbids JSON/`label`/`prompt` output: each item
is the complete instruction to send and its prerequisites must already hold.
Desktop additionally tolerates legacy JSON menus as a compatibility fallback,
not an advertised generation format: a standalone trailing array (at message
start or after a blank line), a trailing closed `json` fence, or JSON inside a
closed `pix-actions` fence. Each of 1–4 objects must have exactly string `label`
and `prompt` fields: nonblank labels are single-line, at most 40 characters;
nonblank prompts are at most 300 characters. JSON source is capped at 16 KiB
(characters); malformed, incomplete or out-of-bounds input stays ordinary text.
Only assistant action-enabled rendering recognizes menus; other code fences
are skipped. These menus reuse the reply-button UI, activity guards and
submission lock. A click sends the selected object's full `prompt` verbatim,
not its label, and the prompt is available as the button tooltip. No actions
execute automatically and no checkbox receipt is reconstructed for buttons.
Bare/trailing-`json` fallback is Desktop-only; TUI continues to require the
canonical list syntax in a `pix-actions` fence.

When the agent stops for the user to do something themselves (install a tool,
sign in, export a file) and then reply, use a **closed `pix-actions` fence**
whose body contains only plain list items without checkboxes — 1–4 short
replies of at most 40 characters. The shared Desktop/TUI prompt states this
requirement and includes a fenced reply-button example. Unfenced Markdown lists
remain ordinary text, including in historical messages; they are not inferred
to be buttons:

~~~~markdown
```pix-actions
- Готово
- Пропустить
```
~~~~

Such a block is a row of reply buttons: the first is the primary action, the
rest are secondary. Clicking one sends its label verbatim as the user message,
then the row locks like a submitted checklist. Mixing plain and checkbox items
makes the block invalid. The opening-line label serves only as the group's
accessible name. The same activity rules apply; reply buttons produce no
checkbox receipt. In the Pix TUI the row renders as `[ Готово ]  [ Пропустить ]`
and the widget sends a button on its digit (or Enter when there is a single one).

Desktop renders a valid checklist as checkboxes and a submit button. A standalone
title or other non-checklist body content makes the block invalid, so it stays
ordinary escaped Markdown/code. Only the latest assistant message that contains
a valid block is interactive, and only when no prompt is running and no later
user message exists; older choices are read-only. Later assistant replies
without a block (the agent kept working despite the rule) do not disable it,
so an offered checklist never becomes unreachable; a reply submitted from it is
still recognized as a receipt. An
inactive assistant checklist still allows native text selection and copy of
option labels, with the transcript's visible selection highlight, without
toggling or submitting the choice. An
incomplete or malformed block remains ordinary escaped Markdown/code.
Submitting sends the selected steps as a normal user message, formatted as
`<button label>:\n1. item\n3. item` (numbering follows original checklist
positions). It uses the ordinary prompt path, preserving the composer draft;
when a prompt is already running at submission, the generated message is
queued.

The Pix TUI supports the same contract through the bundled `choice-actions`
extension (`src/bundled-extensions/choice-actions/`, parser shared with
Desktop via its `contract.ts`). In `tui` mode it appends the same choice-rule
guidance to the system prompt. The transcript renders a valid block as
`☑ 1. item` / `☐ 2. item` lines plus `↳ <button label>`, and malformed blocks
stay code. After an agent run ends, the last valid block of the latest assistant
message that has one (since the last user message) appears as a non-blocking widget above the editor. While the composer
is empty, digits 1–8 toggle items, Enter submits the selection through
`sendUserMessage` (it refuses an empty selection), and Esc dismisses the widget.
Typing a printable character dismisses the widget and keeps the keystroke. A
non-empty draft owns every key. A new run, user input, session start or
shutdown clears the widget. TUI selection state is not persisted.

Checkbox edits (including an empty selection) survive transcript remounts when
switching session tabs within the same Desktop window. State is scoped to the
session, assistant message, block position and parsed block content; identical
checklists in other sessions/messages do not share edits. Changed blocks start
from their recommended defaults. Pending/submitted status and submission errors
also survive remounts, so switching away and back cannot re-enable a pending
submission. This is a window-local, 512-block LRU cache, not durable session
history: restarting Desktop or evicting an old entry resets it. In-flight
submissions are not evicted.

In user-message history, an exact generated quick-choice reply is displayed as
a static checkbox receipt: all source options are shown, checked only if they
were actually selected in the reply. These rows have no interactive controls or
submit button. Receipt text supports native selection and copy, including after
the choice has been answered. This is presentation-only; stored/sent user text, copy/edit and
agent input retain the original numbered-list payload. Receipts are reconstructed
from the preceding assistant's parsed block and the exact reply, independently
of the window-local selection cache, including after restart. If the source is
not loaded, the reply differs from the generated format, or multiple blocks
match ambiguously, the user message remains ordinary Markdown.

When a user reply is recognized as a receipt, Desktop hides only its matched
source `pix-actions` block in the assistant message to avoid a duplicate checklist.
Other assistant text and unanswered blocks remain visible. This is reconstructed
from loaded history after restart as well; ambiguous or altered replies do not
hide source blocks, and stored conversation text is unchanged.

Use a fully self-contained block. For example:

~~~~markdown
Here is an interactive choice screen:

```pix-html
<style>body{font-family:sans-serif;padding:24px}</style>
<form>
  <label>Name <input name="name" required></label>
  <label>Difficulty <select name="difficulty">
    <option value="easy">Easy</option><option value="hard">Hard</option>
  </select></label>
  <button type="submit">Submit to Pix</button>
</form>
<button id="score">Report score</button>
<script>
document.querySelector("#score").addEventListener("click", () => {
  window.pix.submit({event: "game_over", score: 100, level: 3});
});
</script>
```
~~~~

Native form submit is intercepted and converted to an object of field names
and string values. Repeated names produce arrays. File inputs are not sent.
Calling `window.pix.submit(anyJsonValue)` manually works for Canvas games
and custom interfaces. Async handlers can listen for the
`{channel:"pix-html-sandbox",type:"ack",status:"sent"|"queued"|"error"}`
window message if they need confirmation. Otherwise the native sandbox footer
shows feedback.

Desktop does **not** append any keyword-triggered layout context to user
prompts; the user's submitted text is sent unchanged. The `pix-html` guide
instead tells the agent to design for the maximum chat-column width (about
850 CSS px, narrower on small windows) and a reasonable height no taller than
that width. Persisted history from older builds may still contain the legacy
`[Pix Desktop HTML Sandbox layout context …]` block; Desktop strips it from
user message bubbles and restored composer drafts.

## Offline animation engines

- CSS/SVG animation and Canvas/requestAnimationFrame require no engine.
  Optional **Phaser 3.90.0** provides 2D games; **Three.js 0.186.1** (r186)
  provides core 3D/WebGL. Versions are exact Desktop dependencies, locked by npm.
- An empty classic `<script src="pix:phaser"></script>` or
  `<script src="pix:three"></script>` requests a local bundle, exposing `Phaser`
  or `THREE` before authored scripts. Use these exact markers, without module,
  async or other attributes. Unknown canonical `pix:` engine names and nonempty
  declarations fail visibly. Duplicate requests load once; both are allowed.
- Vite creates inert, encoded script strings in separate lazy chunks. Engines
  are never evaluated in the privileged host. Starting a prototype loads the requested
  packaged chunk; plain prototypes load neither. Encoding/bundling happens at
  build time rather than synchronously on the UI thread. Engine bytes are not
  part of the 200k authored-source limit.
- Loading can be stopped/restarted. Source changes and unmount invalidate the
  pending run; stale success or failure must not mount or overwrite current UI.
  Local chunk loading may finish and remain cached, but canceled work cannot run.
- No CDN, arbitrary library/path loader, remote/workspace assets, addons,
  Phaser plugins, eval, or new permissions. Three.js addons such as OrbitControls
  and GLTFLoader are not bundled. Use procedural or embedded assets. Phaser
  Canvas rendering works without WebGL; Three.js requires WebGL2 and examples
  must provide a visible renderer-creation fallback. WebGPU/XR and Photon/network
  multiplayer are not promised. Stop removes the iframe; resource use still has
  no hard CPU/GPU/memory quota.
- The shipped guide includes responsive examples and cleanup patterns, plus
  official API reference links for authoring, not runtime imports.

## Isolation and limits

- The iframe has `sandbox="allow-scripts allow-forms"` with no same-origin,
  top-navigation, downloads, popups, or host bridge permissions.
- Source documents install a restrictive CSP **before** user markup:
  no network connects, remote assets, frame nesting, workers, objects,
  or form actions. Local Canvas, inline CSS, data/blob images and embedded JS
  are supported. Browser CSP by itself does **not** prevent the frame from
  navigating itself to an external URL; the macOS native window installs
  an `on_navigation` allowlist to reject those requests for all frames
  before WebKit issues the navigation. This navigation restriction also
  applies to Pix's main windows; external links still use the OS opener.
- Srcdoc frames inherit the Tauri parent's CSP. The Desktop parent explicitly
  enables `data:` external script URLs, **not** `unsafe-inline` or eval.
  The guest's inline `<script>` content becomes an encoded `data:` script
  URL. Blob URLs created by the parent cannot load in an opaque-origin frame
  in Chromium, hence they are intentionally not used. HTML inline handler
  attributes (e.g. `onclick`) do not work: register event listeners in a
  `<script>` tag instead. External imports and CDN resources are blocked.
  The two `pix:` markers are replaced with packaged `data:` scripts; neither
  the parent nor guest CSP is relaxed for engine support.
  **Security tradeoff:** permitting `data:` in the parent script CSP widens
  the risk of an otherwise exploitable host-side HTML-injection bug; keep all
  host Markdown escaped and reassess with an independent-origin protocol
  before treating the sandbox as hardened for arbitrary untrusted inputs.
  Tauri 2's main-frame-only IPC script and invoke-key enforcement prevent
  guest frames from invoking native APIs; do not change those protections.
- At most 200k source characters, 16k JSON submission characters, ten
  submissions per Run, and one submission per second. The parent only accepts
  messages originating from the exact running iframe WindowProxy with opaque
  `null` origin, with `channel` and `type` validation.
- An accepted form payload becomes a normal attributed user message sent via
  ACP. If the source session is running, Pix sends it through its existing
  persistent ACP queue; if the session changed, was closed, or isn't ready, Pix
  rejects the submission. The composer draft/attachments remain intact.
- Untrusted iframe JS is still CPU-capable; Stop kills the iframe and frees
  its resources, but no browser-only sandbox can promise a hard CPU/memory
  quota inside one WebView process. Do not describe this as a hardened
  multi-process isolation boundary.

## Verification

- Native Desktop regression: render a valid checklist, verify its checked
  defaults and formatting, confirm only the latest settled assistant message is
  interactive, and verify malformed/incomplete fences remain code.
- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`
- Native engine regression: run the guide's Phaser and Three.js examples offline,
  verify animation/input, resize, Stop/Restart, and that host globals remain absent.
  Check both engines together, a plain prototype, and blocked remote requests.
- macOS native regression: launch Pix Desktop, ask for a `pix-html` form
  and a Canvas game, confirm automatic startup, Stop/Run/Restart, submit, confirm the ACP reply and queue behavior.
  Resize the Sidebar/main window, expand the sandbox, check the themed thin
  scrollbar, verify a growing and shrinking page's automatic height, and
  verify network and Pix IPC are not available inside the guest iframe.

## Regression coverage

- Compiled client-runes regression for equal-HTML wrapper updates, changed HTML, manual Stop, untracked runtime state and destruction cleanup.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"0bac3d56141be91c8b0a0443ca8786261a742fb8b4119f2a9384231948f07fb7","checkedAt":"2026-10-31T14:58:59.241Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":65,"reportLanguage":"ru"} -->
