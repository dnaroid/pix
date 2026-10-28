# Pix

**A workspace-first coding UI for [Pi](https://github.com/badlogic/pi-mono):
a terminal TUI and a native macOS Desktop workbench.**

Persistent project sessions, readable agent activity, repository search,
tasks, Source Control and a bundled agent toolkit.

## Quick start

Download a self-contained package from [GitHub Releases](https://github.com/dnaroid/pix/releases)
and follow [installation](wiki/getting-started/installation.md).
TUI: Windows x64, Linux x64 and macOS Apple Silicon.
Desktop: **macOS Apple Silicon only**. Release installs bundle Node.js.

```sh
pix --cwd /path/to/project
```

Source development requires Node.js `>=22.19.0 <27`:

```sh
git clone https://github.com/dnaroid/pix.git
cd pix
npm ci
npm run dev -- --cwd /path/to/project
```

## Documentation

Start at the **[Wiki](wiki/index.md)**:

- [Project overview and capabilities](wiki/overview.md)
- [Installation](wiki/getting-started/index.md) · [Desktop](wiki/desktop/index.md) · [TUI](wiki/tui/index.md)
- [Architecture](wiki/architecture/index.md) · [Development and testing](wiki/development/index.md)
- [Configuration](wiki/configuration/index.md) · [Release](wiki/development/release/index.md)
- [Decisions](wiki/decisions/index.md) · [Documentation rules](wiki/maintenance/index.md)

The Wiki contains the full guides and requirements; this README is only an entry point.
