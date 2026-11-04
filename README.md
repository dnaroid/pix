# Pix

**A native macOS workspace for coding with AI, built on
[Pi](https://github.com/badlogic/pi-mono).**

**Pix Desktop is the project's primary focus.** It brings agent conversations,
project files, tasks, plans, Wiki, Git and terminals into one workbench — with
the models and tools you choose. A terminal frontend is also available.

[Download Pix Desktop](https://github.com/dnaroid/pix/releases) ·
[Desktop guide](wiki/desktop/guide.md) · [Wiki](wiki/index.md)

## Get started with Desktop

**Supported platform: macOS 13.5+ on Apple Silicon.** Windows and Linux Desktop
builds are not currently supported.

1. Download the `.dmg` from [GitHub Releases](https://github.com/dnaroid/pix/releases)
   and verify it against the release's `SHA256SUMS`.
2. Open the disk image and copy Pix Desktop to Applications or `~/Applications`.
3. Launch Pix Desktop, connect your model providers and choose your
   **Main / Fast / Strong** models in the setup wizard, then open your project.

Desktop bundles its own Node.js and Pix/ACP runtime: **no separate Node.js,
npm or TUI installation is required**. Packaged production builds offer signed
native updates from inside the app.

See [installation and upgrades](wiki/getting-started/installation.md) for
verification, credentials and existing-install cleanup.

## What you can do in Pix Desktop

### Keep your project and conversations together

- **Persistent project sessions** — switch between conversations, reopen saved
  sessions, restore tabs after restart, and fork conversations to explore a
  different direction. Pause and continue the agent without leaving the chat.
- **Readable agent activity** — expandable thinking and tool results, diffs,
  session todos and sub-agent progress instead of an undifferentiated log.
- **Rich input** — file and folder mentions, attachments, pasted images,
  prompt autocomplete, slash commands, selection assistance and voice input.
- **Side questions (BTW)** — ask follow-up questions in a separate pane without
  interrupting the main agent. This temporary side chat has no tools and is
  not retained after restart.
- **Interactive answers** — structured questions and next-step checklists,
  Markdown, code, diagrams and media. Sandboxed HTML/CSS/JavaScript prototypes,
  forms and games run directly in chat, including local Phaser and Three.js
  support, without network access.

Details: [conversations and input](wiki/desktop/conversations/index.md) ·
[rich content](wiki/desktop/rendering/index.md).

### Work beyond the chat

| Workspace feature | What it provides |
| --- | --- |
| **Work: Tasks and Plans** | Project task management with Quick Add, status/priority, drag-and-drop, attachments and linked agent sessions; project plans alongside tasks. |
| **Project Explorer** | Keyboard-friendly file navigation, previews and external-editor actions; files and media open in workbench tabs. |
| **Project Wiki** | Browse project knowledge, edit Markdown visually and inspect consistency findings. |
| **Source Control** | Branch/status, stage and unstage, diffs, AI-assisted review and commit messages, commit, publish/push and repository tools. |
| **Launch Commands and terminals** | Saved launch commands, package scripts and interactive terminals; run shell commands from the composer with `!` / `!!`. |
| **Registry** | Private Git-backed synchronization for skills, agents and project resources, including tasks and plans. |
| **Repository search** | Native project search across enabled code, knowledge, sessions, tasks and commits; inspect local/semantic index status. Semantic retrieval is optional and requires embedding configuration. |
| **Usage** | Cost, token and call metrics for a project or all projects, with time ranges and interactive chart filters. |
| **LSP and diagnostics** | Language-server status and controls, plus diagnostic logs when enabled. |

Details: [Desktop workspace](wiki/desktop/guide.md#desktop-workspace) ·
[Git and terminal integrations](wiki/desktop/integrations/index.md) ·
[work management](wiki/work-management/index.md) · [repository search](wiki/search/index.md).

### Choose your models and workflow

- **Pi's provider ecosystem** — choose models and thinking levels, configure
  routing and fallbacks, and assign models to individual features and agents.
  The model wizard can replace a configured model across its uses.
- **Bundled agent tools** — repository discovery, AST search and rewrites,
  LSP diagnostics, parallel sub-agents, planning, session recovery and context
  compression. Optional integrations require their own configuration or credentials.
- **Voice and assistant workflows** — dictate prompts and use multi-model
  brainstorming. **Observer is experimental and opt-in**: it checks the session
  for potential issues and offers findings, consuming provider tokens/quota.
- **Native workspace controls** — command palette, keyboard navigation,
  context menus, light/dark/system appearance, project colors and logos,
  window-state restoration, notifications and an optional menu-bar icon.
- **Independent Desktop settings** — global preferences plus project overrides
  for models, voice, editor and Git workflows; no dependency on the TUI profile.

Details: [configuration](wiki/configuration/index.md) ·
[agent tools](wiki/tools/index.md) · [assistant features](wiki/assistants/index.md) ·
[workbench and navigation](wiki/desktop/workbench/index.md).

## Also available: Pix TUI

Prefer a terminal? Pix TUI provides persistent project sessions, readable agent
activity and the bundled toolkit on **Windows x64, Linux x64 and macOS Apple
Silicon**. Install its separate self-contained release package, then run:

```sh
pix --cwd /path/to/project
```

Desktop and TUI use Pi sessions, but maintain their own configuration and
open-tab state. You can install either or both.
See the [TUI guide](wiki/tui/guide.md).

## Development

Source development requires Node.js `>=22.19.0 <27`. For source setup and the native macOS Desktop toolchain,
follow the [development guide](wiki/development/guide.md).

## Documentation

Start at the **[Wiki](wiki/index.md)**:

- [Project overview and capabilities](wiki/overview.md)
- [Installation](wiki/getting-started/index.md) · [Desktop](wiki/desktop/index.md) · [TUI](wiki/tui/index.md)
- [Architecture](wiki/architecture/index.md) · [Development and testing](wiki/development/index.md)
- [Configuration](wiki/configuration/index.md) · [Release](wiki/development/release/index.md)
- [Decisions](wiki/decisions/index.md) · [Documentation rules](wiki/maintenance/index.md)

This page summarizes Desktop's main capabilities. The Wiki contains detailed
behavior, configuration, limitations and feature contracts.
