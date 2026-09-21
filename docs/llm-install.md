# LLM installation command

<!-- markdownlint-disable MD013 -->

This document is intentionally written as an execution contract for a coding
agent. It installs Pix from **GitHub Releases**, not from a package registry.

## Copy/paste command for an LLM

Paste this into an agent that can use a terminal and the web:

```text
Install and configure the latest stable Pix from https://github.com/dnaroid/pix
for this machine. Follow
https://github.com/dnaroid/pix/blob/master/docs/llm-install.md exactly.

Detect the current OS and CPU first. Preserve all existing Pi/Pix configuration,
credentials, sessions and project .pi directories. Inventory every existing
"pix" and "pi-ui-extend" launcher before changing PATH. Remove only confirmed
legacy Pix wrappers/package-manager installs after inspecting what they target.
Do not remove a separate "pi" CLI or user configuration.

Install from GitHub Releases and verify the selected asset against SHA256SUMS.
Unless I explicitly requested only one frontend, install both the portable TUI
and Pix Desktop when this OS/CPU has official release assets. Reuse existing
user configuration rather than overwriting it. Run the documented health/version
checks afterwards and report exactly what was installed, removed, preserved,
and any manual authentication or OS permission step that remains.
```

## Agent execution contract

### 1. Detect the platform

Determine OS and CPU from the machine itself, not from assumptions.

Supported stable release targets are:

- Linux x64 (`x86_64` / `amd64`);
- macOS Apple Silicon (`arm64` / `aarch64`);
- Windows x64 (`AMD64` / `x86_64`).

If the detected target is unsupported, stop before downloading a foreign binary
and offer the source-development path in [Development](development.md).

### 2. Inventory and protect user state

Before changing anything:

1. locate all `pix` and `pi-ui-extend` commands;
2. inspect symlink/wrapper targets;
3. inspect relevant global package-manager entries when those tools exist;
4. record existing TUI and Desktop install locations;
5. confirm the following user data is preserved:
   - `~/.config/pi/`;
   - `~/.pi/agent/`;
   - project `.pi/` directories;
   - provider/registry credentials and session files.

Do not print secret values while inspecting configuration.

### 3. Remove only confirmed legacy Pix launchers

Legacy means an old Pix/`pi-ui-extend` package-manager install, source-checkout
wrapper, or redundant user launcher that would conflict with the new release.

Safe examples after inspection:

- uninstall a confirmed global `pi-ui-extend` package with the package manager
  that owns it;
- remove/replace a user-owned `~/.local/bin/pix` symlink after confirming it
  points to the old payload;
- replace an old Pix Desktop application/desktop entry with the new release.

Never:

- recursively delete `~/.config/pi` or `~/.pi`;
- delete project `.pi` directories;
- remove an unrelated/separately managed `pi` command;
- delete an executable merely because its filename is `pix`.

If ownership cannot be established, leave the item in place and report the
conflict.

### 4. Resolve the latest stable GitHub Release

Use GitHub Releases for `dnaroid/pix`. Prefer `gh` when already installed;
otherwise use the GitHub Releases API / normal HTTPS download.

Select assets by the **exact detected target**:

| Target | TUI asset | Desktop asset |
| --- | --- | --- |
| Linux x64 | `pix-tui-*-linux-x64.tar.gz` | `pix-desktop-*-linux-x64.AppImage` and/or `.deb` |
| macOS arm64 | `pix-tui-*-macos-arm64.tar.gz` | `pix-desktop-*-macos-arm64.dmg` |
| Windows x64 | `pix-tui-*-windows-x64.zip` | the unique Windows x64 `-setup.exe` |

Also download `SHA256SUMS`.

Do not derive trust from the filename alone. Compute SHA-256 locally and require
an exact filename/digest match in `SHA256SUMS` before installing.

### 5. Install the TUI transactionally

Use a stable per-user directory. Recommended locations:

- macOS/Linux: `~/.local/opt/pix`;
- Windows: `%LOCALAPPDATA%\Pix\tui`.

Extract into a temporary sibling directory first. Confirm the launcher and
release payload are present. Only then replace the old application directory.
Keep a rollback copy until the new launcher passes its version/health check.

Expose the launcher:

- macOS/Linux: point `~/.local/bin/pix` at the new `pix`;
- Windows: add the TUI directory to the user PATH when needed.

Do not flatten the archive: the launcher expects its bundled runtime/dependencies
to remain beside it.

### 6. Install Pix Desktop

Unless the user requested TUI-only:

- **macOS:** mount the DMG and copy the app to `~/Applications` or
  `/Applications` according to available permissions;
- **Windows:** run the NSIS installer;
- **Linux Debian/Ubuntu:** the `.deb` is preferred when package installation is
  appropriate;
- **other Linux x64:** place the AppImage in a stable user-owned directory such
  as `~/.local/opt/pix-desktop/pix-desktop.AppImage`, mark it executable and
  create/update a user desktop entry if desired.

Do not remove `~/.config/pi/pix-desktop.jsonc` during replacement.

If Linux AppImage opens a blank window and stderr contains
`Could not create default EGL display: EGL_BAD_PARAMETER`, apply the
host-`libwayland-client` workaround from
[Pix Desktop → Linux AppImage blank window](desktop.md#linux-appimage-blank-window-egl_bad_parameter).
Do not apply that workaround preemptively when the AppImage works normally.

### 7. Configure without overwriting credentials

Run the TUI checks:

```bash
pix --help
pix install --check
pix update --check
```

On Windows use `pix.cmd` when `pix` is not yet resolved by PATH.

Use existing Pix/Pi config when present. If the user wants the optional helper
setup, `pix install` / `pix setup` may install the recommended Nerd Font,
install a standalone global `pi` CLI when missing, and create non-secret config
templates. Explain those side effects before running it.

Do not invent or copy provider secrets. If no provider credential is configured,
report the supported next step (for example stock Pi `/login`) rather than
requesting or echoing tokens in terminal logs.

For Desktop, launch it once and let the first-run/settings UI inspect existing
credentials. Desktop uses `~/.config/pi/pix-desktop.jsonc`, independently from
the TUI's `pix.jsonc`.

### 8. Final verification and report

Report:

- detected OS/CPU;
- GitHub Release tag and exact downloaded assets;
- checksum verification result;
- final TUI and Desktop locations;
- every legacy item removed/replaced and why it was confirmed safe;
- preserved config/session locations;
- `pix --help`, `pix install --check`, and `pix update --check` results;
- Desktop launch result when it can be verified;
- any remaining manual provider login, microphone permission, signing warning or
  Linux AppImage compatibility step.

Do not claim Desktop UI verification if the agent could not actually launch or
observe the native application.
