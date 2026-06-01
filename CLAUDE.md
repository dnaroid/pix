# pi-ui-extend agent notes

Small SDK-first prototype for a custom pi terminal renderer. Do not use pi's built-in `InteractiveMode` here; `src/main.ts` owns the terminal UI, input loop, scroll state, and tool expand/collapse state.

The UI uses a session-tab system scoped to the current working directory.

## Commands

```bash
npm install --ignore-scripts
npm run dev -- --cwd /path/to/workspace
PIX_RELOAD_ON_BUILD=1 pix --cwd /path/to/workspace
npm run check
npm run update-sdk-references
```

Use `--no-session` for local UI smoke tests that should not persist a session.

## Opencode source for reference
/Volumes/128GBSSD/Projects/opencode/packages/opencode/src/cli/cmd/tui/routes/session/index.ts

## Pi source for reference
/Volumes/128GBSSD/Projects/pi-mono/packages/coding-agent

## Pix extensions package
external/pi-tools-suite

## SDK references

This project keeps local SDK references in `.pi/skills/pi-sdk/references/`. After changing or updating `@earendil-works/pi-coding-agent`, run:

```bash
npm install --ignore-scripts
npm run update-sdk-references
```

Then read `.pi/skills/pi-sdk/references/metadata.json` and the relevant files under `references/` before relying on SDK APIs.

## Project rules

- Keep `@earendil-works/pi-coding-agent` pinned to an exact version.
- Prefer SDK over RPC for this renderer unless a separate process/language is required.
- Keep SDK imports top-level; do not use dynamic imports.
- Do not guess SDK types; check `.pi/skills/pi-sdk/references/types/` or `node_modules/@earendil-works/pi-coding-agent/dist/`.
- For code changes, run `npm run check`.
