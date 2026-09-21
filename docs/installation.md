# Installing Pix

<!-- markdownlint-disable MD013 -->

Pix is distributed as self-contained GitHub Release packages. End users do not
need a separate Node.js/npm installation to run the portable TUI or Pix Desktop.

For an agent-driven installation, use the dedicated
[LLM installation guide](llm-install.md).

## Release targets

| Platform | TUI | Pix Desktop |
| --- | --- | --- |
| Windows x64 | ZIP containing `pix.cmd` | NSIS `-setup.exe` |
| macOS Apple Silicon | `.tar.gz` containing `pix` | `.dmg` |
| Linux x64 | `.tar.gz` containing `pix` | `.AppImage` and `.deb` |

Download the latest stable release from
[GitHub Releases](https://github.com/dnaroid/pix/releases). Stable releases also
contain `SHA256SUMS`; verify every downloaded installer/archive before replacing
an existing installation.

If the machine is not one of the targets above, do not install a binary for a
different architecture. Build from source instead; see
[Development](development.md).

## Preserve user state

Replacing Pix must not remove user data. Preserve at least:

- `~/.config/pi/` — Pix/Pix Desktop/tools-suite configuration and credentials;
- `~/.pi/agent/` — Pi agent state, extensions and sessions;
- project-local `.pi/` directories;
- provider credentials, resource-registry configuration and session files.

The release payload is replaceable. User configuration and sessions live outside
that payload.

## Remove confirmed legacy installs

Older installations may leave a package-manager installation or a hand-written
`pix` / `pi-ui-extend` wrapper earlier on `PATH`. Inventory first and remove
only launchers whose target has been inspected and confirmed to be obsolete.
Never delete every executable named `pix` blindly.

On macOS/Linux:

```bash
type -a pix 2>/dev/null || true
type -a pi-ui-extend 2>/dev/null || true
command -v pix || true
ls -l ~/.local/bin/pix ~/.local/bin/pi-ui-extend 2>/dev/null || true
```

If a legacy package-manager installation of `pi-ui-extend` is confirmed, remove
it with the same package manager that created it. Run only the applicable
command:

```bash
npm uninstall -g pi-ui-extend
pnpm remove -g pi-ui-extend
bun remove -g pi-ui-extend
yarn global remove pi-ui-extend
```

On Windows PowerShell:

```powershell
Get-Command pix -All -ErrorAction SilentlyContinue | Format-List Name,Source,CommandType
Get-Command pi-ui-extend -All -ErrorAction SilentlyContinue | Format-List Name,Source,CommandType
```

Remove only a confirmed obsolete package-manager install or user-created wrapper.
Do **not** delete `~/.config/pi`, `~/.pi`, project `.pi` directories, or a
separately installed `pi` CLI as part of Pix legacy cleanup.

## TUI

### macOS and Linux

Extract the complete archive into a stable user-owned directory, for example:

```text
~/.local/opt/pix/
```

Keep the whole extracted tree together because the launcher uses the bundled
runtime. Expose the launcher on `PATH`:

```bash
mkdir -p ~/.local/bin
ln -sfn "$HOME/.local/opt/pix/pix" "$HOME/.local/bin/pix"
```

Verify:

```bash
pix --help
pix install --check
pix update --check
```

### Windows

Extract the complete ZIP into a stable user directory such as
`%LOCALAPPDATA%\Pix\tui`. Add that directory to the user `PATH` or invoke
`pix.cmd` directly.

Verify:

```powershell
pix.cmd --help
pix.cmd install --check
pix.cmd update --check
```

## Pix Desktop

Pix Desktop is a native Tauri application with its own bundled Pix/ACP runtime;
the TUI is not required.

- **macOS:** open the `.dmg` and copy Pix Desktop into Applications or
  `~/Applications`. Release packages require macOS 13.5 or newer.
- **Windows:** run the NSIS `-setup.exe` installer.
- **Linux:** prefer the `.deb` on Debian/Ubuntu systems when appropriate;
  otherwise use the executable `.AppImage`.

Desktop has a separate configuration profile:

```text
~/.config/pi/pix-desktop.jsonc
```

Project overrides live at `<workspace>/.pi/pix-desktop.jsonc`. See
[Pix Desktop](desktop.md) for features, first-run behavior and Linux-specific
troubleshooting.

## Checksums

On Linux:

```bash
sha256sum <downloaded-file>
```

On macOS:

```bash
shasum -a 256 <downloaded-file>
```

On Windows PowerShell:

```powershell
Get-FileHash <downloaded-file> -Algorithm SHA256
```

Compare the digest with the exact filename entry from the release's
`SHA256SUMS` file before installing/replacing the payload.

## First-run setup

The TUI health check is non-mutating:

```bash
pix install --check
```

`pix install` / `pix setup` can additionally install the recommended Nerd
Font, install the standalone `pi` CLI when missing, create non-secret config
templates and print credential-aware next steps. It never imports provider
credentials automatically.

For provider setup and configuration details, see
[Configuration and accounts](configuration.md).

## Updates

Portable TUI release installations update as a unit:

```bash
pix update --check
pix update
```

`pix update` selects the matching GitHub Release archive, verifies
`SHA256SUMS`, smoke-tests the staged bundled runtime and swaps the installation
after the updater exits.

Packaged Pix Desktop uses the native Tauri updater. Production builds check the
signed update feed and expose Update/Restart in the application; Desktop does not
fall back to the TUI/package-manager updater.
