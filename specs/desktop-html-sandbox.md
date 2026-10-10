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

## Message contract

- Only assistant transcript text opts into the sandbox via a **closed** fenced
  `pix-html` or `html-sandbox` block, with either backticks or tildes.
- Ordinary `html` fences, user/system/thought messages, tool results, and
  incomplete/oversized fences retain the existing escaped Markdown behavior.
- A closed sandbox fence can be interleaved with normal explanatory Markdown.
  The iframe keeps its DOM/Canvas while the rest of the assistant message
  streams, unless that sandbox's source actually changes.
- A prototype is **never executed automatically** during replay, scroll or
  streaming. The user presses **Run** first, and can Stop/Restart, resize or
  inspect its source.
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
  available in the current conversation context: call `pix_html_sandbox_guide`
  if absent; otherwise follow it without calling again, including for another
  block or an edit to an earlier prototype.
  Capability discussions, HTML explanations, source examples, static
  diagrams and file/project edits do not trigger the guide by themselves.
  The tool description repeats these boundaries for tool-inventory discovery.
  Unsupported capabilities require an explanation and an offered alternative,
  not a silent file substitution or a claim that the sandbox supports them.
- A dedicated, read-only `pix_html_sandbox_guide` tool returns the complete
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
- The measured viewport hint described below is optional extra context for
  likely prototype requests, **not** the feature-discovery mechanism.

## Authoring

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

When an ordinary Desktop prompt appears to ask for a prototype, HTML Sandbox,
interactive game, animation, Phaser, Three.js, or Canvas implementation, the ACP prompt payload includes a
**separate agent-facing context block** with the measured inline
content width and maximum auto-fit height at submit time. This applies to
normal, opening-draft, queued, deferred, and forked user prompts through the
shared prompt builder; it does not rewrite the user's visible composer text or
force the agent to emit HTML. Normal coding prompts receive no such block.
The context explicitly asks for responsive HTML/Canvas and warns that later
window/sidebar resizing can change the actual viewport. As with other ACP
prompt content, the appended block may be recorded in the conversation's
session history; it is not a live hidden system prompt.

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
  are never evaluated in the privileged host. Only Run loads the requested
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

## Implementation

- `desktop/sandbox-engines.vite.ts`, `desktop/vite.config.ts`,
  `desktop/tsconfig.node.json`, `desktop/src/sandbox-virtual-modules.d.ts`,
  `desktop/package.json`, `desktop/package-lock.json`: pinned offline bundles.
- `desktop/src/lib/html-sandbox-engines.ts`: fixed marker allowlist and lazy imports.
- `desktop/src/lib/html-sandbox-run.ts`: pending-run cancellation/ownership.
- `desktop/src/lib/html-sandbox.ts`: fence extraction, CSP document,
  encoded guest scripts, scrollbar styling, guest height reporting, bounded
  submission parsing and ACP formatting.
- `desktop/src/lib/html-sandbox-layout.ts`: validated content-size packets,
  bounded auto-fit height calculation and prototype-only agent viewport hint.
- `desktop/src/components/HtmlSandbox.svelte`: Run/Stop/Restart UI and
  scoped message listener, theme syncing, width monitoring and auto-fit.
- `desktop/src/components/MarkdownText.svelte`:
  opt-in content segmentation; raw HTML never enters the ordinary
  Markdown renderer.
- `desktop/src/components/TranscriptPane.svelte`: assistant-only enablement.
- `desktop/src/app/prompt-submit.ts` and
  `desktop/src/app/desktop-workbench-prop-builders.ts`: scoped ACP delivery.
- `desktop/src/App.svelte`, `desktop/src/app/desktop-prompt-action-services.ts`,
  `desktop/src/app/prompt-payload.ts`, `desktop/src/app/prompt-queue-actions.svelte.ts`:
  measured snapshot passed into agent-facing prototype prompts.
- `desktop/src-tauri/tauri.conf.json`: explicit `data:` script CSP allowance.
- `desktop/src-tauri/src/startup_theme.rs`: native navigation allowlist
  for main windows and sandbox frames.
- `src/bundled-extensions/html-sandbox/index.ts` and
  `src/bundled-extensions/html-sandbox/guide.ts`,
  `src/bundled-extensions/html-sandbox/engine-reference.ts`:
  short per-turn capability advertisement plus on-demand model-facing guide.
- `acp/src/config.ts`, `acp/src/main.ts`,
  `acp/src/acp/pix-acp-agent.ts`, `desktop/src-tauri/src/backend_runtime.rs`:
  Desktop-only extension configuration, client gate and native packaging.

## Verification

- `npm --prefix desktop test -- src/lib/html-sandbox.test.ts src/lib/html-sandbox-layout.test.ts src/app/prompt-submit-html-sandbox.test.ts`
- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`
- `node --import tsx --test tests/html-sandbox-extension.test.ts`
- `node --import tsx --test acp/test/config.test.ts acp/test/agent.test.ts`
- `npm --prefix desktop test -- src/lib/html-sandbox-engines.test.ts src/lib/html-sandbox-run.test.ts`
- Native engine regression: run the guide's Phaser and Three.js examples offline,
  verify animation/input, resize, Stop/Restart, and that host globals remain absent.
  Check both engines together, a plain prototype, and blocked remote requests.
- macOS native regression: launch Pix Desktop, ask for a `pix-html` form
  and a Canvas game, Run, submit, confirm the ACP reply and queue behavior.
  Resize the Sidebar/main window, expand the sandbox, check the themed thin
  scrollbar, verify a growing and shrinking page's automatic height, and
  verify network and Pix IPC are not available inside the guest iframe.

## Tests

- `desktop/src/lib/html-sandbox.test.ts`
- `desktop/src/lib/html-sandbox-engines.test.ts`
- `desktop/src/lib/html-sandbox-run.test.ts`
- `desktop/src/lib/html-sandbox-layout.test.ts`
- `desktop/src/app/prompt-submit-html-sandbox.test.ts`
- `tests/html-sandbox-extension.test.ts`
- `acp/test/config.test.ts`
- `acp/test/agent.test.ts`
