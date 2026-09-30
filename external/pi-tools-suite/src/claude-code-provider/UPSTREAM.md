# Origin and maintenance

This is a **Pix-maintained fork**, not an unmodified npm installation.

- Upstream: [chem/pi-claude-code-provider](https://github.com/chem/pi-claude-code-provider).
- Author: **chem <sineverbisnon@gmail.com>**.
- License: **MIT, Copyright (c) 2026 chem**; the original [LICENSE](LICENSE) is
  retained verbatim and applies to imported code/tests. Pix changes retain it.
- Base release: **0.5.0**, changelog date 2026-09-24.
- Commit: [`a87b98539f57945b8a6df8c26db4cdcf3ed38a7a`](https://github.com/chem/pi-claude-code-provider/commit/a87b98539f57945b8a6df8c26db4cdcf3ed38a7a).
  npm's `gitHead` equals the peeled `v0.5.0` tag; annotated tag object:
  `3b7c324f0fd2a9832afb2a36d608d3aa28889618`.
- Archive: `https://registry.npmjs.org/pi-claude-code-provider/-/pi-claude-code-provider-0.5.0.tgz`.
- npm SRI (verified against downloaded bytes):
  `sha512-kt7FXHCnKHlQSk8JRgmrH3cbpNUbQ7QyXnPE/Vybc6U+ni4Ocq0cK74y6pwpOUFOfhD28anwvWWEjQ0ZWt5Z4A==`.
- [UPSTREAM.json](UPSTREAM.json) records baseline SHA256 hashes for runtime,
  bridge, entrypoints, manifest and license. npm runtime source matched the
  pinned GitHub commit. Tests come from that commit (npm omits them).

## Import boundary and local differences

The starting installation was
`~/.pi/agent/npm/node_modules/pi-claude-code-provider`, already locally patched.
Comparison against the freshly downloaded SRI-verified npm archive found only
these runtime differences: `src/context-serializer.ts`, `src/provider.ts`, added
`src/image-read-recovery.ts`, and the two `.pix-original-*` backups. Installed
`extensions/` and `bridge/` matched upstream. Backups were **not** imported.

Maintained differences:

1. `src/context-serializer.ts`: default image count is unbounded, not 20;
   internal explicit limit seam, validation, byte/transcript guards and metrics
   remain. No promise of remote acceptance of arbitrary image counts.
2. `src/provider.ts` + `src/image-read-recovery.ts`: bounded attachment-read
   recovery, private-transport suppression, same-session leases, one deadline,
   verified termination/cleanup and combined accounting. These are the
   pre-existing Pix recovery patch, now normal source.
3. `src/doctor.ts`: narrow SDK chat/image model union before `contextWindow`.
4. `index.ts`: suite/isolated-child entrypoint. Catalog registration and child
   injection use this local module, not npm resolution. Public provider/API/model
   identifiers and environment variables are unchanged. No auth changes.
5. `package.json`: original identity/version/author/license retained for origin;
   marked private, removed upstream publish/file lists and scripts whose tooling
   is not vendored. It is not independently published or installed.
6. Offline upstream behavioral tests live in the suite's
   `test/claude-code-provider/upstream/`; local image regressions are alongside
   them. Test imports/fixture paths target this module; obsolete count-cap
   expectations use the explicit limit seam. Upstream release/paid-runner and
   repository-policy tests are not Pix runtime contracts.

`DESIGN.md`, `SECURITY.md` and `CHANGELOG.md` are retained upstream reference
documents, **not** current Pix contracts. Upstream command/install instructions
and the old image cap in them are historical. Current contracts:
`specs/claude-code-provider.md`, `specs/claude-image-count.md`,
`specs/claude-image-read-recovery.md` at the Pix root.

## Updating upstream

1. Fetch public npm release metadata/archive and the exact Git commit into an
   isolated temporary directory. Verify SRI, release tag/commit, license and
   author; never use an installed mutable package as the clean baseline.
2. Compare the old baseline hashes/commit with the new upstream source. Review
   auth/env allowlists, CLI flags/protocol, MCP/private paths, process ownership,
   abort/timeout/cleanup and session-image-store lifecycle before merging.
3. Merge deliberately into this cohesive module; reapply/review each local
   difference above. Do not overwrite recovery or silently reintroduce the cap.
   Preserve MIT and author notices; update `UPSTREAM.json` and this document.
4. Port relevant upstream offline tests and fixtures. Run the suite source
   typecheck, imported Node tests, local image/recovery tests, config/search
   guard tests, and async-subagent offline registration/owned-launch matrix.
   Tests must not require the old npm package or user credentials.
5. Run root migration tests. Disable legacy provider resources with
   `npm run migrate:claude-provider` (also pass `-- --project-settings FILE` for
   trusted project overrides), then `npm run sync:pi-tools-suite` and its
   `-- --check` variant. Restart all hosts. Retain the npm copy until verification
   is successful; uninstalling it is optional and is not part of migration.
6. Independent code review and task-scoped knowledge audit are required.
   Real Desktop/TUI testing uses `ui-qa`; real Claude service requests are
   separate, potentially metered work and need explicit user consent.
