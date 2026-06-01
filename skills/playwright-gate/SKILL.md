---
name: playwright-gate
description: >-
  Use this skill whenever the user provides a Browser Gate or Playwright Gate
  control packet, clipboard text containing PLAYWRIGHT_GATE=, “Browser Gate
  control packet”, or asks to inspect/control the already-open current browser
  tab through the extension gate without launching a separate Chrome. Prefer
  token-efficient Browser Gate workflows: snapshot-to-file, raw/json output,
  element refs, scoped snapshots, inspect, role/text/label locators, and
  secret-safe helpers.
allowed-tools: Bash(node:*) Bash(npm:*) Bash(pbpaste:*) Bash(mkdir:*) Bash(rm:*)
---

# Playwright Gate

Use this when the user wants you to operate on the browser tab they selected with the Playwright Gate / Browser Gate extension. The gate controls the existing tab through the extension and native-message file queue; it is not a normal Playwright browser session.

Primary goal: **minimize tokens while staying precise and safe**. Prefer file-backed snapshots, compact summaries, stable element refs, scoped inspection, and raw/json output over dumping full DOM/text into chat.

## Paths and setup

- Root: `/Volumes/128GBSSD/Projects/playwright-gate`
- CLI: `/Volumes/128GBSSD/Projects/playwright-gate/dist/cli/src/index.js`
- Do not set shell/tool cwd to the project root unless the harness allows it. Prefer `npm --prefix` and absolute CLI paths.
- If the built CLI is missing, run:

```bash
npm --prefix /Volumes/128GBSSD/Projects/playwright-gate install
npm --prefix /Volumes/128GBSSD/Projects/playwright-gate run build
```

## Gate payload handling

The payload may be a full instruction block, not just raw JSON, but it must contain `PLAYWRIGHT_GATE=`.

For pasted clipboard payloads, save the whole block to a file and use `PLAYWRIGHT_GATE_FILE`:

```bash
pbpaste > /tmp/playwright-gate.txt
PLAYWRIGHT_GATE_FILE=/tmp/playwright-gate.txt node /Volumes/128GBSSD/Projects/playwright-gate/dist/cli/src/index.js --raw health
```

Use this shell helper in examples below:

```bash
pg() { PLAYWRIGHT_GATE_FILE=/tmp/playwright-gate.txt node /Volumes/128GBSSD/Projects/playwright-gate/dist/cli/src/index.js "$@"; }
```

If the payload is expired or rejected, ask the user to click the extension again on the target tab and paste a fresh block.

## Token-efficient workflow

1. Check connection with minimal output:

```bash
pg --raw health
pg --raw title
pg --raw url
```

2. Take a **snapshot to file** instead of printing the tree. This is the default behavior for `snapshot`; stdout should only contain a path/summary.

```bash
pg snapshot --max-items 80 --max-text 80 --depth 4
```

3. Use refs from the snapshot/query output (`e12`, `e48`) for future actions. This avoids repeating long selectors/text:

```bash
pg inspect e12
pg click e12 --snapshot changed
pg fill e8 'value' --snapshot never
```

4. When more detail is needed, inspect or snapshot only a region/ref instead of the whole page:

```bash
pg inspect e12
pg snapshot e12 --max-items 40 --max-text 120 --depth 3
pg query 'form, dialog, [role=dialog]' --limit 10
```

5. After actions, prefer compact changed-only output:

```bash
pg click-role button 'Generate token' --changed
pg click-text 'Save' --snapshot changed
pg fill-label 'Token name' 'ci-release' --snapshot never
```

Only use `--inline` when you truly need the snapshot content in stdout. Otherwise read the saved snapshot file selectively outside the chat context.

## Output modes and budgets

Use global compact flags whenever possible:

```bash
pg --raw title
pg --json health
pg --raw text --max-text 500
```

Budget flags for snapshots/text-heavy commands:

- `--max-items N` limits flattened item count.
- `--max-text N` truncates per-item or page text.
- `--depth N` / `--max-depth N` limits tree depth.
- `--boxes` includes bounding boxes only when needed.
- `--inline` prints snapshot content; avoid by default.
- `--path PATH` or `--filename NAME` controls snapshot file location/name.

Prefer small budgets first, then zoom into a ref/region.

## Locators and actions

Prefer Playwright-like locators and refs over brittle CSS:

```bash
pg query-text 'Generate token' --limit 10
pg query-role button 'Generate token' --limit 10
pg click-text 'Generate token'
pg click-role button 'Generate token'
pg fill-label 'Token name' 'ci-release'
pg click-nth 'button' 2
pg click 'button' --index 2
pg press Enter
```

Use CSS selectors only when role/text/label/ref is insufficient:

```bash
pg query 'button, [role=button]' --limit 20
pg click 'button[type=submit]' --snapshot changed
```

Ask before destructive actions, submissions, purchases, account changes, or sending messages.

## Accessibility snapshot

For forms/admin UIs, prefer accessibility snapshots over raw DOM dumps when looking for labels, roles, names, checked/selected state, or disabled state:

```bash
pg a11y --max-items 80 --max-text 80 --depth 4
pg accessibility-snapshot e12 --max-items 40 --depth 3
```

## Secret-safe workflow

Never print tokens, passwords, cookies, localStorage secrets, credentials, or private page content unless the user explicitly requests the specific data.

For generated tokens or secrets, use the secret helper so the value is not logged. It reports redacted metadata only:

```bash
pg copy-secret-from-selector e12 --command 'gh secret set NPM_TOKEN --repo OWNER/REPO'
pg copy-secret-from-selector 'input[type=password]' --out /tmp/secret-value.txt
```

Prefer passing secrets through stdin to the destination command. Do not use `text`, `query --include-value`, `inspect`, screenshots, or shell echo in a way that would reveal a secret.

## Screenshots

Use screenshots sparingly because they can be large. Save to a file and report the path:

```bash
pg screenshot --path /tmp/playwright-gate-page.png
```

## What not to do

- Do not run `playwright-cli open`, launch a new Chrome, or attach by CDP for this task.
- Do not use browser `eval`/`page.evaluate` as a primary strategy; Browser Gate avoids eval because page CSP can block it.
- Do not assume the payload is just JSON; pass the whole copied block or store it in `PLAYWRIGHT_GATE_FILE`.
- Do not dump full snapshots/text into chat when a saved snapshot path, ref, `inspect`, or scoped snapshot is enough.
- Do not dump cookies, localStorage, tokens, credentials, or private page content unless explicitly requested.

## Troubleshooting

- Expired/rejected payload: ask the user to click the extension again on the target tab and paste the new block.
- Native host error:

```bash
npm --prefix /Volumes/128GBSSD/Projects/playwright-gate run native:health
```

If the host is not installed, tell the user to run:

```bash
npm --prefix /Volumes/128GBSSD/Projects/playwright-gate run native:install -- --extension-id <extension_id>
```

- Timeout: keep the target tab open and visible, reload the extension if it was rebuilt, then retry.

## Report back

Keep the report concise and token-light:

- Which current tab/page was controlled.
- The important commands or command classes used, not every raw output line.
- What changed on the page.
- Any saved snapshot/screenshot paths that may be useful.
- Any remaining user action needed.
