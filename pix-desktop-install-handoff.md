# Pix Desktop Linux AppImage: installation and blank-window workaround

<!-- markdownlint-disable MD013 -->

> Historical diagnostic handoff for the reproduced Linux host. The generalized
> user-facing workaround now lives in
> [docs/desktop.md](docs/desktop.md#linux-appimage-blank-window-egl_bad_parameter).

## User environment

- OS: Bazzite/Fedora-family Linux, AMD BC-250 graphics, Wayland/Mesa stack.
- User wanted Pix from `https://github.com/dnaroid/pix`: both TUI and Linux Desktop.

## Installed software

### TUI

- GitHub Release: `v2.0.6`, asset `pix-tui-2.0.6-linux-x64.tar.gz`.
- Installed at `~/opt/pix`; command symlink is `~/.local/bin/pix`.
- Verified against release `SHA256SUMS`; TUI `pix update --check` reported current `v2.0.6`.
- Removed a redundant/conflicting user-owned wrapper: `/home/linuxbrew/.linuxbrew/bin/pix`.

### Desktop

- GitHub Release: `v2.0.6`, asset `pix-desktop-2.0.6-linux-x64.AppImage`.
- Installed at `~/opt/pix-desktop/pix-desktop.AppImage` and made executable.
- User desktop entry: `~/.local/share/applications/pix-desktop.desktop`, symlinked to `~/opt/pix-desktop/pix-desktop.desktop`.
- AppImage SHA-256 was verified against the release `SHA256SUMS`:
  `a43cced0396328ace85fbb73e5acc7113fe331c859a5c8233fa9219e73797436`.

## Failure and diagnostic

On its initial launch, Desktop opened an empty window. Manual stderr log:

```text
Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...

** (pix-desktop:13230): WARNING **: 13:59:57.532: atk-bridge: get_device_events_reply: unknown signature
```

The relevant problem is `EGL_BAD_PARAMETER`, not the `atk-bridge` warning. It is an AppImage/Wayland/Mesa compatibility issue: the AppImage’s bundled `libwayland-client` is incompatible with the host EGL/Mesa stack, so the WebKit process aborts and the window remains empty.

Relevant upstream context: Tauri AppImage issue `https://github.com/tauri-apps/tauri/issues/15665` documents the same symptom and cause: AppImages bundling `libwayland-client` can fail with `Could not create default EGL display: EGL_BAD_PARAMETER` on newer Wayland/Mesa systems.

## Applied workaround (works; user confirmed)

A launcher wrapper was added at `~/opt/pix-desktop/pix-desktop` and marked executable:

```sh
#!/bin/sh
# Use the host Wayland client library with Mesa/EGL instead of the copy bundled
# into the AppImage. This avoids EGL_BAD_PARAMETER on current Wayland systems.
set -eu

app_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
wayland_lib=$(ldconfig -p 2>/dev/null | awk '/libwayland-client\.so\.0/{print $NF; exit}')

if [ -n "${wayland_lib:-}" ] && [ -r "$wayland_lib" ]; then
  export LD_PRELOAD="$wayland_lib${LD_PRELOAD:+:$LD_PRELOAD}"
fi

exec "$app_dir/pix-desktop.AppImage" "$@"
```

On this host `ldconfig -p` resolves the host library to:

```text
/usr/lib64/libwayland-client.so.0
```

The desktop entry was changed from launching the AppImage directly to launching the wrapper:

```ini
Exec=/home/bc250/opt/pix-desktop/pix-desktop %U
TryExec=/home/bc250/opt/pix-desktop/pix-desktop
```

`desktop-file-validate` and shell syntax validation passed. User then confirmed: “так работает”.

## ACP note

The user subsequently mentioned an “ACP warning”, but no ACP-related message appears in the supplied log. The only remaining log line is the `atk-bridge` accessibility warning above; it is not ACP and ordinarily harmless. Ask for the exact ACP warning text or a new post-fix stderr log before diagnosing it.

## UI automation constraint

Automated desktop UI verification was attempted but blocked because `at-spi-bus-launcher`/the accessibility bus was unavailable in the agent session. No screenshots, traces, or UI logs were produced. The functional result is nevertheless confirmed manually by the user.

## Suggested next steps for the project agent

1. Ask for the exact ACP warning, preferably the post-fix terminal log.
2. Consider fixing the AppImage packaging upstream rather than relying on a local wrapper: do not bundle `libwayland-client` (and related Wayland infrastructure) for Linux AppImage builds, or apply an upstream-supported compatibility hook.
3. Do not remove the wrapper unless the Desktop AppImage is updated and manually tested on this Wayland/Mesa host.

## Suggested skills

- `context7` only if current Tauri/WebKitGTK API or packaging documentation is required.
- `playwright-cli` is not applicable to native desktop verification; use a desktop-capable UI QA workflow with AT-SPI available.
