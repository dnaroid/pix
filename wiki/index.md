# Pix Wiki

Pix is a workspace-first coding UI for Pi, available as a terminal TUI and a
native **macOS Apple Silicon** Desktop app. It brings persistent project
sessions, readable agent activity, Source Control, repository intelligence,
tasks and bundled agent tools into one workbench.

## Start here

- **New user:** [project overview](overview.md) → [install and troubleshoot](getting-started/index.md) → [Desktop](desktop/guide.md) or [TUI](tui/guide.md).
- **Contributor or agent:** [architecture](architecture/index.md) → [development and verification](development/index.md) → the relevant feature contract → [decision rationale](decisions/index.md).
- **Looking for a requirement:** use a subject below or the [complete contract catalogue](reference/contracts.md). An as-is spec, an experiment and a proposal are not interchangeable.

## Product and subsystems

- [Desktop workbench](desktop/index.md) — navigation, Wiki, conversations, rendering and integrations; [visual design rules](desktop/design.md).
- [Terminal UI](tui/index.md) — sessions, input, commands and memory/concurrency diagnostics.
- [Configuration and model routing](configuration/index.md) · [providers and authentication](providers/index.md) · [usage and quotas](usage/index.md).
- [Repository search and knowledge](search/index.md) — native project discovery and agent workflows.
- [Tools](tools/index.md) and [sub-agents](tools/agents/index.md) — suite, APIs, roles and lifecycle.
- [Context and continuity](context/index.md) — prompt composition, DCP, recovery and statistics.
- [Work management](work-management/index.md) — saved tasks, session todos and resource registry.
- [Assistant features](assistants/index.md) — voice, brainstorm and the opt-in Observer.
- [Markdown, diagrams and links](rendering/index.md).

## Engineering and project memory

- [Architecture](architecture/index.md) — components, ACP and lifecycle boundaries.
- [Development](development/index.md), [testing and QA](development/testing/index.md), [CI and releases](development/release/index.md).
- [Safety, diagnostics and operations](operations/index.md), including unresolved [incident observations](operations/incidents/index.md).
- [Decision records](decisions/index.md) — accepted choices, alternatives and supersession.
- [Research and proposals](proposals/index.md) — not approved implementation contracts.
- [Archive](archive/index.md) — historical MVP, removed tool and superseded decision references.
- [Wiki maintenance](maintenance/index.md), [migration map](maintenance/migration-map.md) and [known conflicts](maintenance/known-conflicts.md).
- [Reference catalogue](reference/index.md) — specifications and the preserved original contract overview.

## Documentation status

The migration preserves source languages, requirements, examples, status and metadata.
It does not newly certify every behavior claim. Read each page’s scope and lifecycle
before changing code. [Known conflicts](maintenance/known-conflicts.md) remain explicit
until an evidence-backed follow-up reconciles their original texts.
