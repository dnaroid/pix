# 0071 — Brainstorm council as a skill on ordinary sub-agents

- Status: accepted
- Recorded: 2026-10-17
- Decided: 2026-10-17
- Owner / approval evidence: user request in the Pi session ("перевести брейншторм на субагенты, без всякого хардкода и сделать его вообще скиллом") plus structured answers: skill + helper script; one agent per participant with rounds via `send`; delete the tool, ACP host and Desktop council UI; the helper reads `pi-tools-suite.jsonc` itself.
- Governing spec: [brainstorm](../assistants/brainstorm.md)
- Replaces / replaced by: replaces the tool and host parts of [0019](0019-desktop-persistent-council-sessions.md); the five rounds ([0009](0009-five-round-brainstorm.md)), audit mode ([0010](0010-audit-council-modes.md)), the v4 storage/quorum/ledger ideas ([0017](0017-brainstorm-v4-protocol-storage.md)) and the run-only roster ([0022](0022-brainstorm-run-roster.md)) carry over.

## Context

The council was implemented as a TypeScript `brainstorm` tool with hardcoded
workflow and prompts, plus a Desktop-specific ACP `BrainstormHost` and council
HUD and banner. Desktop now has generic read-only sub-agent session viewers,
so participants no longer need dedicated hosting.

## Decision

Ship the council as the `brainstorm` skill (registered through
`resources_discover`). The parent follows SKILL.md. Each model is one
persistent `research` sub-agent: spawned in round 1, then sent follow-ups in
rounds 2–5. A Node helper does all the deterministic work: roster from config,
manifest, hashes, quorum, gaps, ledgers and storage. Prompts live in
editable Markdown templates. The tool, ACP host and Desktop council UI are
deleted. `/brainstorm` stays as a shortcut to the skill.

## Alternatives

- A pure prompt skill without a helper: the manifest, hashes and quorum would
  depend on the model following instructions; rejected.
- Keeping the tool and adding a skill wrapper: keeps the hardcoding; rejected.
- A fresh agent per round: loses each participant's context; rejected in
  favour of `send`.

## Consequences

- Participants are visible and inspectable like any sub-agent. There is no
  council-specific UI or ACP lifecycle code.
- Integrity depends on the helper checking `launch.json`, turn counts and
  `result.json`. Parent mistakes produce refusals and incomplete runs, not
  silent substitution.
- Duplicated config reading (helper and suite), including the mirrored
  built-in frontier list, is covered by parity tests.
- Old v4 and earlier protocols cannot continue. Carrying over the storage,
  quorum and ledger ideas from 0017 does not carry over its legacy roots or
  v2/v3-to-v4 continuation behavior; the current helper validates its own
  current manifest format.

## Revisit when

The SDK offers skill-scoped tools or helpers, or the config-parity test drifts
often enough to justify a shared loader package.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"5e5bcd7070c9dff8d121f3d20213e24a01933b2c5206715808c54304dff401d7","checkedAt":"2026-10-31T12:39:30.969Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":51,"reportLanguage":"ru"} -->
