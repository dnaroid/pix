import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifactRoot = resolve(root, "../.pi/artifacts");
await mkdir(artifactRoot, { recursive: true });
const output = process.env.WIKI_SMOKE_OUTPUT
  ? resolve(process.env.WIKI_SMOKE_OUTPUT)
  : await mkdtemp(join(artifactRoot, "wiki-browser-"));
await mkdir(output, { recursive: true });

const imageData = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
const original = "---\ntitle: Combat\nstatus: draft\n---\n\n# Combat rules\n\n[Rules][rules]\n\n[rules]: ./rules.md \"Rules\"\n\nExact ending.\n";
const gfm = "# Balance\n\n| Action | Cost |\n| --- | --- |\n| Move | 1 |\n\n- [ ] Add enemies\n\n![Map](images/map.png)\n\nAfter the table.\n";
const componentValue = "# Game Wiki\n\nSelect this sentence.\n\n## Action points\n\n| Action | Cost |\n| --- | --- |\n| Move | 1 |\n\n- [ ] Add enemies\n\n![Map](images/map.png)\n";
let assertions = 0;
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++; };
const check = (actual, message) => { assert.ok(actual, message); assertions++; };
const pageErrors = [];
const consoleErrors = [];
let server;
let browser;
let page;
let completed = false;

async function selectText(locator, collapseToEnd = false) {
  await locator.evaluate((element, collapse) => {
    element.closest('[contenteditable="true"]')?.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    if (collapse) range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  }, collapseToEnd);
}

async function mountComponent(value) {
  await page.evaluate(async ({ value, imageData }) => {
    const { mount, unmount, WikiMarkdownEditor } = await import("/__wiki_smoke_entry__.js");
    if (window.__wikiComponent) await unmount(window.__wikiComponent);
    const target = document.getElementById("app");
    target.replaceChildren();
    window.__wikiChanges = [];
    window.__wikiSaves = [];
    window.__wikiOpenedLinks = [];
    window.__wikiSourceRequests = 0;
    window.__wikiComponent = mount(WikiMarkdownEditor, {
      target,
      props: {
        value, documentPath: "wiki/index.md", workspace: "/wiki-browser-smoke",
        onChange: (markdown) => window.__wikiChanges.push(markdown),
        onSave: () => window.__wikiSaves.push(window.__wikiComponent.readMarkdown()),
        onResolveImage: async () => imageData,
        onOpenLink: (href) => window.__wikiOpenedLinks.push(href),
        onSourceRequested: () => window.__wikiSourceRequests++,
      },
    });
  }, { value, imageData });
}

try {
  server = await createServer({
    root,
    configFile: join(root, "vite.config.ts"),
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
    plugins: [{
      name: "wiki-smoke-page",
      resolveId(id) { return id === "/__wiki_smoke_entry__.js" ? "\0wiki-smoke-entry" : undefined; },
      load(id) {
        if (id !== "\0wiki-smoke-entry") return undefined;
        return 'import "/src/styles.css"; export { mount, unmount } from "svelte"; export { default as WikiMarkdownEditor } from "/src/components/WikiMarkdownEditor.svelte"; export { createWikiMarkdownEditor } from "/src/lib/wiki-markdown-editor.ts";';
      },
      configureServer(vite) {
        vite.middlewares.use("/__wiki-test__", (_request, response) => {
          response.setHeader("Content-Type", "text/html");
          response.end('<!doctype html><html><head><meta charset="utf-8"><title>Wiki editor smoke</title><link rel="icon" href="data:,"></head><body style="margin:0"><div id="app" style="height:100vh;max-width:1060px;margin:0 auto"></div></body></html>');
        });
      },
    }],
  });
  await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address === "object", "Vite must expose a TCP address");
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1180, height: 850 }, colorScheme: "light" });
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${address.port}/__wiki-test__`, { waitUntil: "domcontentloaded" });

  await page.evaluate(async ({ original, imageData }) => {
    window.__wikiDiagnostics = [];
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      if (command === "log_desktop_diagnostic") window.__wikiDiagnostics.push(args);
    } };
    const { createWikiMarkdownEditor } = await import("/__wiki_smoke_entry__.js");
    window.__wikiChanges = [];
    window.__wikiSaves = [];
    window.__wikiErrors = [];
    window.__wikiImageSources = [];
    window.__wikiRuntime = await createWikiMarkdownEditor({
      element: document.getElementById("app"), value: original,
      disabled: () => false,
      onChange: (markdown) => window.__wikiChanges.push(markdown),
      onSave: () => window.__wikiSaves.push(window.__wikiRuntime.readMarkdown()),
      onSelectionChange: () => {},
      onError: (error) => window.__wikiErrors.push(String(error)),
      onResolveImage: async (source) => { window.__wikiImageSources.push(source); return imageData; },
    });
  }, { original, imageData });

  equal(await page.evaluate(() => window.__wikiRuntime.readMarkdown()), original,
    "Opening a document must preserve exact Markdown, YAML and reference-link bytes");
  equal(await page.evaluate(() => window.__wikiChanges), [], "Opening must not mark the document dirty");
  const editor = page.getByRole("textbox", { name: "Markdown document" });
  await selectText(editor, true);
  await page.keyboard.type("Z");
  await page.keyboard.press("Meta+s");
  const immediateSave = await page.evaluate(() => window.__wikiSaves.at(-1));
  check(immediateSave?.includes("Exact ending.Z"), "Immediate Cmd+S must capture the last typed character");
  check(immediateSave.startsWith("---\ntitle: Combat\nstatus: draft\n---\n"), "Edits must retain YAML metadata");
  await page.evaluate(() => window.__wikiRuntime.action("undo"));
  equal(await page.evaluate(() => window.__wikiRuntime.readMarkdown()), original,
    "Undoing to the baseline must restore the original bytes");

  await page.evaluate((value) => window.__wikiRuntime.setValue(value), gfm);
  equal(await page.locator(".wiki-prose-editor table").count(), 1, "GFM tables must render as a table");
  const costCell = page.locator(".wiki-prose-editor td").nth(1);
  await selectText(costCell.locator("p"));
  await page.keyboard.insertText("2");
  check(/\|\s*Move\s*\|\s*2\s*\|/u.test(await page.evaluate(() => window.__wikiRuntime.readMarkdown())),
    "Editing a rendered table cell must update Markdown");
  await page.getByRole("checkbox", { name: "Mark task complete" }).check();
  check(/[-*] \[x\] Add enemies/u.test(await page.evaluate(() => window.__wikiRuntime.readMarkdown())),
    "Task checkboxes must update GFM Markdown");
  await page.waitForFunction(() => {
    const image = document.querySelector(".wiki-inline-image img");
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0 && !image.hidden;
  });
  equal(await page.evaluate(() => window.__wikiImageSources), ["images/map.png"],
    "The image resolver must receive the document's relative path");
  equal(await page.locator(".wiki-inline-image img").getAttribute("src"), imageData,
    "Resolved image bytes must render in the editor");
  const imageMarkdown = await page.evaluate(() => window.__wikiRuntime.readMarkdown());
  check(imageMarkdown.includes("images/map.png") && !imageMarkdown.includes("data:image"),
    "Image resolution must not rewrite the Markdown path");
  equal(await page.evaluate(() => window.__wikiErrors), [], "The editor runtime must not report unexpected errors");
  await page.evaluate(async () => { await window.__wikiRuntime.destroy(); delete window.__wikiRuntime; });

  await mountComponent(componentValue);
  await page.getByRole("textbox", { name: "Markdown document" }).waitFor({ state: "visible" });
  equal(await page.evaluate(() => window.__wikiComponent.readMarkdown()), componentValue,
    "The Svelte editor must preserve the input document");
  equal(await page.getByRole("toolbar", { name: "Markdown formatting" }).locator('button[tabindex="0"]').count(), 1,
    "The formatting toolbar must have one roving Tab stop");
  const sentence = page.locator(".wiki-prose-editor p").filter({ hasText: "Select this sentence." });
  await selectText(sentence);
  await page.getByRole("button", { name: "Bold (⌘B)", exact: true }).click();
  check((await page.evaluate(() => window.__wikiComponent.readMarkdown())).includes("**Select this sentence.**"),
    "The Bold toolbar button must format the actual selection");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  equal(await page.evaluate(() => window.__wikiComponent.readMarkdown()), componentValue,
    "Toolbar Undo must restore the original document");

  await selectText(sentence);
  await page.getByRole("button", { name: "Insert link", exact: true }).click();
  await page.getByLabel("Link path or URL", { exact: true }).fill("rules.md#damage");
  await page.getByLabel("Link text", { exact: true }).fill("Combat rules");
  await page.getByRole("button", { name: "Insert", exact: true }).click();
  check((await page.evaluate(() => window.__wikiComponent.readMarkdown())).includes("[Combat rules](rules.md#damage)"),
    "The link form must insert the requested Markdown target and label");
  await page.locator('.wiki-prose-editor a[href="rules.md#damage"]').click({ modifiers: ["Meta"] });
  equal(await page.evaluate(() => window.__wikiOpenedLinks), ["rules.md#damage"],
    "Cmd-click must route a Wiki link through the caller");

  await page.locator(".wiki-prose-editor td").first().click();
  await page.getByRole("toolbar", { name: "Table editing" }).waitFor({ state: "visible" });
  const rowCount = await page.locator(".wiki-prose-editor tr").count();
  await page.getByRole("button", { name: "Add row", exact: true }).click();
  equal(await page.locator(".wiki-prose-editor tr").count(), rowCount + 1,
    "Table toolbar must insert a row");
  const columnCount = await page.locator(".wiki-prose-editor tr").first().locator("th,td").count();
  await page.getByRole("button", { name: "Add column", exact: true }).click();
  equal(await page.locator(".wiki-prose-editor tr").first().locator("th,td").count(), columnCount + 1,
    "Table toolbar must insert a column");

  await page.screenshot({ path: join(output, "wiki-editor-light.png"), fullPage: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: join(output, "wiki-editor-dark.png"), fullPage: true });

  const htmlDocument = "---\ntitle: Preserve HTML\n---\n\n<div data-contract=\"keep\">Do not lose this HTML.</div>\n";
  await mountComponent(htmlDocument);
  const sourceButton = page.getByRole("button", { name: "Edit Markdown source", exact: true });
  await sourceButton.waitFor({ state: "visible" });
  check((await page.getByRole("alert").innerText()).includes("HTML or MDX"),
    "Unsupported markup must show a safe Source fallback");
  equal(await page.evaluate(() => window.__wikiComponent.readMarkdown()), htmlDocument,
    "Fallback must preserve unsupported markup byte-for-byte");
  equal(await page.evaluate(() => window.__wikiChanges), [], "Failed visual parsing must not publish a rewritten document");
  await sourceButton.click();
  equal(await page.evaluate(() => window.__wikiSourceRequests), 1, "Source action must call the host handler");
  const diagnostics = await page.evaluate(() => window.__wikiDiagnostics);
  check(diagnostics.some((entry) => entry.event === "wiki:editor-failed"),
    "The safe fallback must also record its diagnostic");
  equal(pageErrors, [], "Browser must not emit uncaught exceptions");
  equal(consoleErrors, [], "Browser must not emit unexpected console errors");
  completed = true;
  await writeFile(join(output, "result.json"), JSON.stringify({ passed: true, assertions, pageErrors, consoleErrors, diagnostics }, null, 2));
  console.log(JSON.stringify({ passed: true, assertions, output }));
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(output, "wiki-editor-failure.png"), fullPage: true }).catch(() => {});
  }
  await writeFile(join(output, "result.json"), JSON.stringify({
    passed: false, assertions, error: error instanceof Error ? error.stack : String(error), pageErrors, consoleErrors,
  }, null, 2));
  console.error(JSON.stringify({ passed: false, assertions, output }));
  throw error;
} finally {
  if (completed && page && !page.isClosed()) {
    await page.evaluate(async () => {
      if (window.__wikiComponent) { const { unmount } = await import("/__wiki_smoke_entry__.js"); await unmount(window.__wikiComponent); }
    }).catch(() => {});
  }
  await browser?.close();
  await server?.close();
}
