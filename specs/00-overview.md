# pix — As-Is Specs (high-risk / user-visible areas)

> Scope: **current behavior only**, derived from code, tests, and docs at the
> time of writing. These are **not** design docs or intended-behavior specs.
> Every important claim is tagged with its source:
> `[confirmed by code]`, `[confirmed by tests]`, `[confirmed by docs]`,
> `[inferred]`, or `[unknown]`.

## Project context

`pix` (package `pi-ui-extend`) is an SDK-first custom terminal renderer for the
pi coding agent, plus the `external/pi-tools-suite` headless extension suite that
ships alongside it. The renderer (`src/`) owns UI, input, scroll, and tool state;
the suite (`external/pi-tools-suite/`) owns the higher-risk runtime behavior
(auth, privacy, background jobs, context mutation, external commands). `[confirmed by docs: CLAUDE.md]`

## How areas were selected

Candidate areas were screened against the high-risk criteria (auth/security/
privacy, permissions, data/schema/migrations, public APIs, external integrations,
payments, background jobs, concurrency, irreversible actions, cross-cutting
architecture). The 4 retained are where the most risk and the most user-visible
behavior live, and all happen to live in `external/pi-tools-suite`.

## Areas covered

| # | Area | Primary risk class | Spec |
|---|------|--------------------|------|
| 1 | `antigravity-auth` | auth/security — OAuth, refresh-token rotation, secret file writes | [01-antigravity-auth.md](./01-antigravity-auth.md) |
| 2 | `async-subagents` | background jobs + concurrency — spawns child pi processes, registry, retry/failover | [02-async-subagents.md](./02-async-subagents.md) |
| 3 | `dcp` (dynamic context pruning) | data + cross-cutting — rewrites conversation context, persists state, irreversible pruning | [03-dcp.md](./03-dcp.md) |
| 4 | `lsp` trust & command execution | security — executes configured LSP server commands gated by a trust hash | [04-lsp-trust.md](./04-lsp-trust.md) |

## Cross-cutting observations

- **Shared secret store.** Antigravity OAuth tokens, opencode-imported accounts,
  and the LSP trust store all live under `~/.pi/agent/` (`auth.json`,
  `trust/lsp.json`). Antigravity writes `auth.json` with mode `0o600`; the LSP
  trust store does not set an explicit mode. `[confirmed by code]`
- **One inter-area data flow.** `async-subagents` writes `result.md` artifacts
  that `dcp` reads synchronously from disk during compression; deleting a run
  dir before a rollup loses that content from the summary. `[confirmed by code]`
- **No production code was changed** to produce these specs. Areas 2–4 were
  investigated by read-only sub-agents; area 1 by direct file reading. All
  claims should be re-verified against current code before relying on them.

## Caveats / known unknowns

- These specs describe behavior, not guarantees. Several tagged `[unknown]`
  items (e.g. whether `$PI_CONFIG_DIR` is attacker-controllable in the host)
  depend on the pi host environment, not this repo.
- "Confirmed by tests" means a test exists; it does **not** mean the behavior is
  fully covered for all edge cases (see each spec's *Gaps / risks*).
