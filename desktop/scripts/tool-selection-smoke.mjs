import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

// Real transcript disclosures, browser selection and clipboard. Synthetic tool
// results isolate CSS regressions; native Tauri menus need separate UI QA.
const root = fileURLToPath(new URL("../", import.meta.url));
const fixtureId = "\0tool-selection-smoke";
const server = await createServer({
  root, configFile: `${root}vite.config.ts`, logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [{
    name: "tool-selection-smoke",
    resolveId(id) { if (id === "/__tool-selection-fixture__.js") return fixtureId; },
    load(id) {
      if (id !== fixtureId) return;
      return `
        import { mount } from "svelte";
        import TranscriptPane from "/src/components/TranscriptPane.svelte";
        import "/src/styles.css";
        const tool = (id, overrides) => ({ type: "tool", id, toolCallId: id,
          name: "shell", title: "shell", kind: "execute", status: "completed",
          attachments: [], diffs: [], ...overrides });
        const items = [
          tool("plain", { content: "PLAIN_OUTPUT selectable text" }),
          tool("source", { name: "read", title: "Read sample.ts", kind: "read", path: "sample.ts",
            content: 'const selectable = "SOURCE_OUTPUT";' }),
          tool("markdown", { name: "read", title: "Read sample.md", kind: "read", path: "sample.md",
            content: "MARKDOWN_OUTPUT selectable text" }),
          tool("patch", { name: "apply_patch", title: "apply_patch", kind: "edit",
            content: "Success. Updated sample.ts\\nLSP diagnostics:\\nerror: DIAGNOSTIC_OUTPUT",
            rawInput: "*** Begin Patch\\n*** Update File: sample.ts\\n@@ -1 +1 @@\\n-old value\\n+DIFF_OUTPUT selectable text\\n*** End Patch" }),
        ];
        mount(TranscriptPane, { target: document.querySelector("#app"), props: {
          transcript: { items }, activeSessionId: "selection", workspace: "/test",
          promptRunning: false, operationRunning: false, historyLoading: false,
          showScrollToBottom: false, onScroll: () => {}, onScrollToBottom: () => {},
          onLoadOlderHistory: async () => false, onChooseWorkspace: () => {},
          onOpenAttachment: () => {}, onPrepareAttachment: async () => {},
          onValidateProjectFile: async () => false, onValidateLocalFile: async () => false,
          onOpenProjectFile: () => {}, onResolveProjectMedia: async () => undefined,
          onOpenLocalFile: () => {}, onResolveLocalMedia: async () => undefined,
          onLoadToolResult: () => {}, onUserMessageAction: () => {},
        }});
      `;
    },
    configureServer(vite) {
      vite.middlewares.use("/__tool-selection-test__", (_request, response) => {
        response.setHeader("Content-Type", "text/html");
        response.end('<!doctype html><html><head><title>Tool selection regression</title></head><body><div id="app" style="height:100vh;display:grid"></div><script type="module" src="/__tool-selection-fixture__.js"></script></body></html>');
      });
    },
  }],
});

async function dragText(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const points = await locator.evaluate(node => {
    document.getSelection().removeAllRanges();
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) if (walker.currentNode.textContent.length) textNodes.push(walker.currentNode);
    const first = textNodes[0], last = textNodes.at(-1);
    const range = document.createRange();
    range.setStart(first, 0); range.setEnd(first, 1);
    const start = range.getBoundingClientRect();
    range.setStart(last, last.length - 1); range.setEnd(last, last.length);
    const end = range.getBoundingClientRect();
    return { start: { x: start.left + 0.5, y: start.top + start.height / 2 },
      end: { x: end.right - 0.5, y: end.top + end.height / 2 } };
  });
  await page.mouse.move(points.start.x, points.start.y);
  await page.mouse.down();
  await page.mouse.move(points.end.x, points.end.y, { steps: 15 });
  await page.mouse.up();
  return page.evaluate(() => document.getSelection().toString());
}

let browser;
let selections = 0;
try {
  await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address !== "string");
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/__tool-selection-test__`);
  const group = page.locator("details[data-transcript-entry-id]");
  await group.locator(":scope > summary").click();
  for (const id of ["plain", "source", "markdown", "patch"]) {
    await page.locator(`[data-activity-entry-id="${id}"] summary`).click();
  }
  const surfaces = [
    ['[data-activity-entry-id="plain"] .tool-result', "PLAIN_OUTPUT selectable text"],
    ['[data-activity-entry-id="source"] .sh__line', 'const selectable = "SOURCE_OUTPUT";'],
    ['[data-activity-entry-id="markdown"] .markdown-text p', "MARKDOWN_OUTPUT selectable text"],
    ['[data-activity-entry-id="patch"] .mutation-result span:last-child', "error: DIAGNOSTIC_OUTPUT"],
    ['[data-activity-entry-id="patch"] .diff-row.added .line-content', "+DIFF_OUTPUT selectable text"],
  ];
  for (const colorScheme of ["dark", "light"]) {
    await page.emulateMedia({ colorScheme });
    for (const [selector, text] of surfaces) {
      assert.equal(await dragText(page, page.locator(selector)), text, `${colorScheme}: ${selector}`);
      await page.keyboard.press("ControlOrMeta+c");
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), text, "Copy keeps selected text only");
      selections++;
    }
    for (const locator of [group.locator(":scope > summary"),
      page.locator('[data-activity-entry-id="patch"] summary'),
      page.locator('[data-activity-entry-id="patch"] header strong'),
      page.locator('[data-activity-entry-id="patch"] .diff-row.added .line-number').last()]) {
      assert.equal(await locator.evaluate(node => getComputedStyle(node).userSelect), "none");
      assert.equal(await dragText(page, locator), "", "disclosure/diff chrome is not selectable");
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: "passed", selections,
    scenarios: ["plain output", "highlighted source", "Markdown", "mutation diagnostics", "diff body",
      "native browser Copy", "non-selectable summaries, diff headers and line numbers", "both themes"] }));
} finally {
  await browser?.close();
  await server.close();
}
