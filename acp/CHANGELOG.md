# Changelog

Notable changes to `pix-acp`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/). The adapter is versioned
independently of the repo-wide `pi-ui-extend` package; the
`@earendil-works/pi-coding-agent` dependency stays exactly pinned per the
constraints in [`README.md`](README.md).

## 0.1.0 — 2026-09-02

First functionally complete milestone: prompt pipeline, event translation,
extension UI bridge, session management, config options, and slash-command
interception all work end-to-end (verified live against pi 0.84.4; see
[`README.md`](README.md)).

### Added

- pi crash detection: the spawned `pi --mode rpc` process is watched; when
  it dies mid-run, the in-flight `session/prompt` rejects with
  `pi process died: …` instead of hanging until the client cancels. The
  exit reason (signal/exit code plus a stderr tail) is delivered to all
  subscribers, including ones registered after the exit.
- `session/load` history replay now includes tool calls — titles, kinds,
  raw input, locations, and their results (text, with `[image]` for image
  parts) — not just user/assistant text.
- Session-map rename tracking: the stored `piSessionPath`, `piSessionId`,
  and `title` are refreshed from pi's state after every settled run and on
  `session/load`/`session/resume`, so pi-side session-file moves (e.g.
  branching) and renamed sessions keep `session/list`, `session/load`, and
  `session/resume` pointing at the real file.

## 0.0.1

Initial port skeleton from upstream
[`pi-acp`](https://github.com/svkozak/pi-acp): ACP server wiring, per-session
`pi --mode rpc` subprocess management, and the stdio JSONL RPC client.
