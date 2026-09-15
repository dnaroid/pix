# Desktop right-click context menus

## Type / lifecycle

Change. Active implemented contract.

## Scope

Pix project windows must expose application commands, not WebView navigation,
reload, inspection, search, dictionary or browser text menus. The standalone Vite
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
- Selected document text offers Copy for the selected fragment, not a whole
  message. Existing user-message Copy/Fork/Fork in new tab/Undo remains available
  through right-click without a text/link context and through the ellipsis even
  when text is selected.
- External links offer Open Link and Copy Link Address. Links use the existing
  `normalizeExternalHref` protocol policy, so internal anchors, local files,
  javascript and other unsupported destinations are not passed to the URL opener.
  A selected link also offers selection Copy.
- xterm keeps its native clipboard event path; terminal menus offer Copy and,
  while the terminal accepts input, Paste. They do not offer document Select All
  or text-editor Undo. `TerminalView` exposes its read-only state explicitly.

## Native integration

macOS/Windows use Tauri predefined editing roles, not draft-value replacement,
synthetic clipboard events or a separate undo stack. This preserves the normal
WebView paste path, including composer attachment handlers and terminal paste.
The native menu owns OS rendering, placement/clamping and keyboard traversal.
The DOM menu-navigation helpers remain the contract for component-owned menus.
Context Menu / Shift+F10 routes through the same event dispatch as right-click;
other editing and system shortcuts are not intercepted.

Linux uses a closed `desktop_edit` command enum routed to WebKitGTK's
`execute_editing_command`, rather than muda's X11 key emulation or unsupported
Linux predefined Undo/Redo. It is scoped to the invoking WebView and does not
evaluate arbitrary JavaScript. The Linux branch needs a native Linux smoke pass;
macOS compilation and browser tests do not prove Wayland/native Linux behavior.

Copy Link Address uses the official native clipboard plugin. Only write-text is
permitted: no clipboard polling, read-image/read-text or clearing permission is
introduced. Clipboard and native menu errors use the existing application error
reporter.

## Focus, cancellation and resource ownership

The clicked editor is focused synchronously without replacing its value or
selection. Selected document text blurs an unrelated editor before opening the
native menu. IPC creation is generation-guarded: a newer click, input, focus
change, blur, scroll, resize or key press invalidates a pending menu. Detached
targets and creations that complete after unmount cannot open a popup.

At most one successfully opened native menu is retained by the controller.
Replacement/disposal releases it; stale creations and failed popups are also
released. A resolved popup promise is not treated as a dismissal signal because
GTK can resolve before dismissal. Resource release is idempotent, including a
late popup failure after replacement. Custom callback ids are stable within a
mounted owner and namespaced between windows/mounts because Tauri's registry is
app-wide. Native registration is serialized so a late obsolete IPC creation
cannot overwrite newer callbacks. Callbacks are invalidated on replacement or
disposal, and link actions capture their URL rather than reading a later target.

## Verification

- `desktop/src/lib/native-context-menu.test.ts`: command policies, password and
  read-only safety, link actions, failures, inactive callbacks and Linux dispatch.
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
