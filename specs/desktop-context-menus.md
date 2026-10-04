---
kind: spec
status: active
---

# Desktop right-click context menus

## Type / lifecycle

Change. Active implemented contract.

## Scope

Pix project windows must expose application commands, not WebView navigation,
reload, inspection, search, dictionary or browser text menus, except for the
macOS prose-composer spelling menu described below. The standalone Vite
browser preview retains browser behavior; this policy belongs to the Tauri host.

## Routing and commands

- One controller is installed and disposed with each `App` mount, including
  secondary project windows. A capture listener prevents the WebView default
  without stopping propagation. Component-owned context menus can still consume
  the event; the generic native menu is the bubbling fallback.
- Empty application chrome has no context menu. Checkboxes, non-text inputs,
  disabled controls (including disabled fieldsets) and inert surfaces do not
  acquire editing commands because a selection exists elsewhere.
- Editable text inputs, textareas and contenteditable editors offer native Undo,
  Redo, Cut, Copy, Paste and Select All. Read-only text inputs offer Copy and
  Select All. Password fields never expose Cut or Copy; read-only passwords have
  only Select All.
- On macOS, a real right-click in the normal message composer uses WebKit's
  system text menu instead of the generic Tauri menu. Misspelled words offer
  OS-provided corrections when the configured system dictionaries have guesses;
  selecting a correction uses native text editing and the normal input/draft
  path. The OS owns the other spelling/text services in this menu. No Pix popup,
  dictionary service, draft-value replacement or silent autocorrection is added.
  The composer explicitly enables spellcheck and disables autocorrection.
  Code editor mode disables spellcheck and retains the application menu;
  questionnaire fields, read-only/disabled/inert controls, passwords, terminals,
  and all other surfaces retain the existing routing. Synthetic Context Menu /
  Shift+F10 requests still use the application menu because they cannot invoke
  the WebKit spelling hit test. See [decision 0007](../docs/decisions/0007-native-composer-spelling.md).
- Selected document text offers Copy for the selected fragment, not a whole
  message. Existing user-message Copy/Fork/Fork in new tab/Undo remains available
  through right-click without a text/link context and through the ellipsis even
  when text is selected.
- External links offer Open Link and Copy Link Address. Links use the existing
  `normalizeExternalHref` protocol policy, so internal anchors, local files,
  javascript and other unsupported destinations are not passed to the URL opener.
  A selected link also offers selection Copy.
- Right-clicking a source line or its line-number gutter in the built-in Preview
  offers **Copy Relative Path with Line Number**, copying plain `path:line` text
  relative to the project root (for example `src/main.ts:42`). The clicked logical
  source line determines the one-based number, regardless of wrapping, scrolling,
  or a highlighted navigation range. Selection Copy remains available alongside
  this action. Rendered Markdown, the edit textarea, and blank Preview space do
  not infer a source line. Absolute local-file previews use a workspace-relative
  path, including `../` outside the project; without a workspace they omit the action.
- Images in Markdown and the Preview tab offer Open Image in External App and
  Copy Image, taking precedence over a surrounding link. Local images use the
  backend-approved attachment path and the OS default application, not the text
  editor. Data images are cached as PNG before opening; remote images open their
  HTTP(S) URL. Copy Image writes PNG pixels, not a path or link. Conversion is
  bounded to 16 megapixels. Asset-backed local images are read through the backend's approved
  attachment reader (25 MB limit) and decoded as data images before PNG conversion,
  avoiding WebKit's asset-URL canvas security error without weakening CORS.
  Already embedded data images retain their pixels without re-reading the original file.
  Errors (including unloaded or unsupported cross-origin remote images)
  use the application error reporter. Stale conversion/cache completions cannot
  write the clipboard or open an app after replacement/disposal. Image copy also
  rejects stale completions when the same element's source or local path changes;
  temporary decode images are released on success, failure, and cancellation.
- Image menus also offer Copy Absolute Path and Copy Relative Path (relative to
  the active project root, with `../` for files outside it). These copy captured
  plain filesystem paths without URI escaping. Images without a local file path
  disable both commands; without an active project, relative-path copy is disabled.
- Local images additionally offer **Reveal in Finder**; remote/data-only images
  disable it. Attachment thumbnails expose their approved local path just like
  images inside Preview.
- The Preview tab header, its read-only content/blank space, and file/video
  attachments offer **Copy File**, **Open in External App**, and **Reveal in
  Finder**. These use the captured local file, not the tab's display title or an
  asset URL. Relative project paths resolve against the current workspace;
  missing local paths disable all three actions. Input/editing menus retain
  precedence; selected text and source-line copy remain available alongside file
  commands. Clicking an image still copies PNG pixels through **Copy Image**;
  clicking the tab header copies the underlying file.
- Embedded Markdown media uses its resolved attachment path, not the surrounding
  document's path. Pending/unavailable media blocks that enclosing-file fallback
  and disables local file actions until resolution succeeds.
- On macOS, Copy File places a native file URL on the pasteboard for Finder and
  other applications, not plain path text or Project Explorer's private
  cross-instance clipboard payload. Open uses the OS default application, not
  the configured text editor. No implicit save/export of an unsaved draft occurs.
  See [decision 0042](../docs/decisions/0042-preview-file-context-actions.md).
- xterm keeps its native clipboard event path; terminal menus offer Copy and,
  while the terminal accepts input, Paste. They do not offer document Select All
  or text-editor Undo. `TerminalView` exposes its read-only state explicitly.

## Native integration

macOS/Windows use Tauri predefined editing roles, not draft-value replacement,
synthetic clipboard events or a separate undo stack. This preserves the normal
WebView paste path, including composer attachment handlers and terminal paste.
The native menu owns OS rendering, placement/clamping and keyboard traversal.
Project Explorer also uses a component-owned native command menu in the Desktop
host, retaining DOM navigation only for standalone browser preview. Its file
commands and clipboard policy are specified in
[workspace navigation](desktop-workspace-navigation.md). Other DOM component
menus retain the shared menu-navigation helpers.
Context Menu / Shift+F10 routes through the same event dispatch as right-click;
other editing and system shortcuts are not intercepted.

Linux uses a closed `desktop_edit` command enum routed to WebKitGTK's
`execute_editing_command`, rather than muda's X11 key emulation or unsupported
Linux predefined Undo/Redo. It is scoped to the invoking WebView and does not
evaluate arbitrary JavaScript. The Linux branch needs a native Linux smoke pass;
macOS compilation and browser tests do not prove Wayland/native Linux behavior.

Copy Link Address and Copy Image use the official native clipboard plugin with
write-text and write-image permissions. The Tauri dependency enables `image-png`
so the encoded PNG bytes sent by Copy Image decode into the native RGBA image;
without that feature, the clipboard plugin rejects them as raw bytes.
Project Explorer additionally uses
read-text for action-triggered cross-instance file Copy/Paste, as specified in
[workspace navigation](desktop-workspace-navigation.md); generic context menus
do not read the clipboard. No clipboard polling, read-image or clearing permission
is introduced. Clipboard and native menu errors use the existing application
error reporter (Project Explorer uses its file-operation error surface).

## Focus, cancellation and resource ownership

The clicked editor is focused synchronously without replacing its value or
selection. Selected document text blurs an unrelated editor before opening the
native menu. IPC creation is generation-guarded: a newer click, input, focus
change, blur, scroll, resize or key press invalidates a pending menu. Detached
targets and creations that complete after unmount cannot open a popup.

A native composer spelling request also invalidates pending IPC work, releases
the previously owned application menu and disables its callbacks; the bubbling
fallback must not create a second menu. The system owns its spelling menu's
focus, placement, dismissal and native undo history.

At most one successfully opened native menu is retained by the controller.
Replacement/disposal releases it; stale creations and failed popups are also
released. A resolved popup promise is not treated as a dismissal signal because
GTK can resolve before dismissal. Resource release is idempotent, including a
late popup failure after replacement. Custom callback ids are stable within a
mounted owner and namespaced between windows/mounts because Tauri's registry is
app-wide. Native registration is serialized so a late obsolete IPC creation
cannot overwrite newer callbacks. Callbacks are invalidated on replacement or
disposal, and link actions capture their URL rather than reading a later target.

## Implementation

- `desktop/src/lib/desktop-context-menu.ts`
- `desktop/src/lib/desktop-context-target.ts`
- `desktop/src/lib/native-context-menu.ts`
- `desktop/src/lib/image-context-actions.ts`
- `desktop/src/components/PreviewPane.svelte`
- `desktop/src/components/AttachmentGrid.svelte`
- `desktop/src/components/markdown-content-action.ts`
- `desktop/src/components/WorkbenchTabs.svelte`
- `desktop/src/lib/workbench-tabs.ts`
- `desktop/src/app/workbench-model.ts`
- `desktop/src-tauri/src/preview_file_action.rs`
- `desktop/src-tauri/src/lib.rs`: Preview file action command registration and
  approved, size-bounded `read_attachment_base64` for local image copying.
- `desktop/src-tauri/Cargo.toml`: native pasteboard API flags and PNG decoding.
- `desktop/src/lib/project-explorer-native-menu.ts`
- `desktop/src/components/ProjectExplorer.svelte`
- `desktop/src/components/project-explorer-menu-controller.svelte.ts`

## Tests

- `desktop/src-tauri/tests/image_clipboard.rs`: actual Tauri clipboard payload
  decoding from PNG bytes to RGBA and invalid-byte rejection, without modifying
  the system clipboard. Run with `cargo test --manifest-path
  desktop/src-tauri/Cargo.toml --test image_clipboard` on macOS.
- `desktop/src/lib/native-context-menu.test.ts`: command policies, password and
  read-only safety, link actions, failures, inactive callbacks and Linux dispatch.
- `desktop/src/lib/project-explorer-native-menu.test.ts`: file-menu preparation,
  OS coordinates, serialized registration, stale callbacks and resource teardown.
- `desktop/src/lib/image-context-actions.test.ts`: image pixel copying, approved
  local-byte re-decoding, embedded data preservation, local/remote opening,
  conversion bounds, stale read/decode/copy/cache completions and decode cleanup.
- `desktop/src/lib/desktop-context-target.test.ts`: trusted local path resolution
  and source references.
- `desktop/src/app/workbench-model.test.ts`: Preview tab file metadata.
- `desktop/src-tauri/src/preview_file_action.rs`: closed action policy and local
  existing-file validation tests.
- `desktop/scripts/context-menu-smoke.mjs`: real DOM media/tab routing and
  keyboard invocation, preserving editable-field precedence, origin-tainted
  canvas reproduction, approved-byte PNG conversion and video file-copy dispatch
  (native IPC stubbed).
- `desktop/src/lib/desktop-context-menu.test.ts`: suppression, focus/coordinates,
  generation races, resource replacement, unmount and failure handling.
- `npm --prefix desktop run test:context-menu`: real Chromium DOM selection,
  focus, propagation, Svelte message-controller precedence, target/protocol
  filtering, Shift+F10 and listener teardown. Native IPC is stubbed; this is not
  proof of native popup appearance or clipboard delivery.
- `npm --prefix desktop test`, `npm --prefix desktop run check`,
  `npm --prefix desktop run build:web` and Cargo check/test.
- Native acceptance: right-click blank chrome, selected transcript, draft,
  read-only/password inputs, links and running/stopped terminals; verify no
  browser menu, correct clipboard content, undo after paste, image paste,
  Escape/focus return and secondary-window behavior. Windows/Linux must be
  checked on their own hosts; browser mocks do not establish OS behavior.
