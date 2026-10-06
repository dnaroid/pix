import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = join(root, "..", ".pi", "artifacts");
await mkdir(artifacts, { recursive: true });
const output = await mkdtemp(join(artifacts, "btw-browser-"));
const server = await createServer({ root, configFile: join(root, "vite.config.ts"), logLevel: "error",
  server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "btw-smoke",
    resolveId(id) { if (id === "/__btw-fixture.js") return "\0btw-fixture"; },
    load(id) { if (id === "\0btw-fixture") return 'import {mount} from "svelte";import App from "/scripts/fixtures/BtwSmoke.svelte";import "/src/styles.css";mount(App,{target:document.getElementById("app")});'; },
    configureServer(vite) { vite.middlewares.use("/__btw_smoke__", (_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end('<!doctype html><html><body><div id="app"></div><script type="module" src="/__btw-fixture.js"></script></body></html>');
    }); },
  }] });
let browser, page;
const checks = [];
const errors = [];
try {
  await server.listen(); browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1180, height: 800 } });
  page.setDefaultTimeout(8000); page.on("pageerror", (error) => { errors.push(error.message); console.error(error.stack); });
  await page.addInitScript(() => {
    let source = '{\n // keep unrelated preferences\n "visibleModels":["fixture/fast","fixture/no-thinking"], "thinkingByModel":{"fixture/fast":"low"}, "defaultModel":{"modelRef":"fixture/main","thinkingLevel":"high"}\n}';
    window.btwPreferenceWrites = [];
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      const document = () => ({ content: source, path: "/synthetic/pix-desktop.jsonc", exists: true, schema: "{}" });
      if (command === "read_user_config") return document();
      if (command === "write_user_config_if_unchanged") {
        const written = args.expectedContent === source;
        if (written) { source = args.content; window.btwPreferenceWrites.push(source); }
        return { written, document: document() };
      }
      throw new Error(`Unexpected native call: ${command}`);
    } };
  });
  const address = server.httpServer.address();
  await page.goto(`http://127.0.0.1:${address.port}/__btw_smoke__`);
  await page.waitForFunction(() => !!window.btwSmoke);
  const main = page.locator('textarea').first();
  const pane = page.getByRole("complementary", { name: "BTW side chat" });
  const open = async () => {
    await page.getByRole("button", { name: "More composer actions", exact: true }).click();
    await page.getByRole("menuitem", { name: /Side question.*BTW/i }).click();
    await pane.waitFor();
  };
  await open();
  assert.equal(await main.inputValue(), "Keep this main draft");
  assert.equal(await page.evaluate(() => window.btwSmoke.calls.filter((call) => call.command.action === "ask").length), 0);
  const input = page.getByRole("textbox", { name: "BTW question" });
  assert(await input.evaluate((element) => document.activeElement === element));
  checks.push("composer menu opens/focuses BTW while parent runs, without inference or moving the main draft");
  await input.fill("Why the queue?"); await input.press("Enter");
  await page.waitForFunction(() => window.btwSmoke.calls.some((call) => call.command.action === "ask"));
  await page.evaluate(() => window.btwSmoke.publish("a", "The queue preserves request order.\n\n```ts\nconst queue = new Map();\n```"));
  await pane.locator('[data-btw-message="assistant"]').waitFor();
  await input.fill("Show a smaller example"); await input.press("Enter");
  await page.waitForFunction(() => window.btwSmoke.calls.filter((call) => call.command.action === "ask").length === 2);
  assert.equal(await page.evaluate(() => window.btwSmoke.calls.filter((call) => call.command.action === "ask").at(-1).command.history.length), 2);
  await pane.getByRole("button", { name: "Stop BTW response" }).click();
  assert.deepEqual(await page.evaluate(() => window.btwSmoke.counts()), { parentSubmits: 0, parentCancels: 0 });
  assert.equal(await main.inputValue(), "Keep this main draft");
  checks.push("streamed Markdown, follow-up history and independent Stop; no parent commands or cancellations");
  await pane.getByRole("button", { name: /Insert BTW answer/ }).first().click();
  assert.equal(await main.inputValue(), "Keep this main draft");
  assert.match(await pane.innerText(), /empty main composer/);
  await page.evaluate(() => { window.btwSmoke.setDraft(""); window.btwSmoke.addMainAttachment(); });
  await pane.getByRole("button", { name: /Insert BTW answer/ }).first().click();
  assert.equal(await main.inputValue(), "");
  await page.evaluate(() => window.btwSmoke.clearMainAttachments());
  await pane.getByRole("button", { name: /Insert BTW answer/ }).first().click();
  assert.match(await main.inputValue(), /^Please consider this answer/);
  assert.deepEqual(await page.evaluate(() => window.btwSmoke.counts()), { parentSubmits: 0, parentCancels: 0 });
  checks.push("explicit draft insertion preserves main text/attachments and never submits");
  const picker = page.getByRole("dialog", { name: "Select model & thinking" });
  const modelRefs = () => picker.locator('[data-model-ref]').evaluateAll((rows) => rows.map((row) => row.dataset.modelRef));
  await page.getByRole("button", { name: "Main model and effort", exact: true }).click();
  await picker.waitFor();
  const mainModels = await modelRefs();
  assert.deepEqual(mainModels, ["fixture/main", "fixture/fast", "fixture/no-thinking"]);
  await page.keyboard.press("Escape");
  const btwModelTrigger = pane.getByRole("button", { name: "BTW model and effort", exact: true });
  assert.equal(await pane.locator("header [data-btw-model-trigger]").count(), 1);
  assert.equal(await pane.locator("footer [data-btw-model-trigger]").count(), 0);
  assert.match(await btwModelTrigger.innerText(), /Main model.*high/s);
  assert.doesNotMatch(await btwModelTrigger.innerText(), /fixture\//);
  await btwModelTrigger.click(); await picker.waitFor();
  assert.deepEqual(await modelRefs(), mainModels, "BTW must use the statusbar whitelist, not the full catalogue");
  assert.equal(await picker.getByRole("button", { name: "Set default", exact: true }).count(), 0, "BTW must not change main defaults");
  const popupBox = await picker.boundingBox(); const triggerBox = await btwModelTrigger.boundingBox();
  assert(popupBox && triggerBox && Math.abs(popupBox.y - triggerBox.y - triggerBox.height) < 2, "popup opens below the BTW header, not the statusbar");
  await picker.getByRole("option", { name: /Fast model/ }).click();
  assert.equal(await page.evaluate(() => window.btwSmoke.snapshot().modelRef), null, "selection is staged until Apply");
  await picker.getByRole("radio", { name: "high", exact: true }).click();
  await page.screenshot({ path: join(output, "btw-model-effort.png") });
  // Safari/WKWebView need not focus buttons on pointer activation. Reproduce
  // that focus departure before click so Apply cannot be lost to dismissal.
  await picker.getByRole("button", { name: "Apply", exact: true }).evaluate((button) => {
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      document.activeElement?.blur();
    }, { capture: true, once: true });
  });
  await picker.getByRole("button", { name: "Apply", exact: true }).click();
  assert.equal(await page.evaluate(() => window.btwSmoke.snapshot().modelRef), "fixture/fast");
  assert.equal(await page.evaluate(() => window.btwSmoke.snapshot().thinkingLevel), "high");
  assert.match(await btwModelTrigger.innerText(), /Fast model.*high/s);
  assert.doesNotMatch(await btwModelTrigger.innerText(), /fixture\//);
  assert.deepEqual(await page.evaluate(() => window.btwPreferenceWrites), [], "Apply does not write any parent preferences");
  assert.deepEqual(await page.evaluate(() => window.btwSmoke.parentSelection()), { model: "fixture/main", effort: "high" });
  await btwModelTrigger.click(); await picker.waitFor();
  assert.equal(await picker.getByRole("radio", { name: "high", exact: true }).getAttribute("aria-checked"), "true");
  await picker.getByRole("option", { name: /No thinking model/ }).click();
  assert.deepEqual(await picker.getByRole("radio").allTextContents(), ["off"]);
  await picker.getByRole("option", { name: /Fast model/ }).click();
  assert.equal(await picker.getByRole("radio", { name: "high", exact: true }).getAttribute("aria-checked"), "true");
  await page.keyboard.press("Escape");
  await picker.waitFor({ state: "detached" });
  assert(await pane.isVisible(), "Escape closes only the inner picker");
  assert(await btwModelTrigger.evaluate((element) => element === document.activeElement));
  await page.locator("#selected-code").evaluate((element) => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await pane.getByRole("button", { name: "Add selected text" }).click();
  assert.equal(await page.evaluate(() => window.btwSmoke.snapshot().excerpts.length), 1);
  await input.fill("What does this excerpt do?"); await input.press("Enter");
  await page.waitForFunction(() => window.btwSmoke.calls.filter((call) => call.command.action === "ask").length === 3);
  const sent = await page.evaluate(() => window.btwSmoke.calls.filter((call) => call.command.action === "ask").at(-1).command);
  assert.equal(sent.modelRef, "fixture/fast"); assert.equal(sent.thinkingLevel, "high"); assert.match(sent.excerpts[0].text, /const queue/);
  await page.evaluate(() => window.btwSmoke.publish("a", "It keeps the request ordering.\n\n" + "A further explanation of cancellation and ordering.\n\n".repeat(55)));
  checks.push("shared filtered model/effort picker, correct anchor/Escape, per-model levels and explicit excerpts; no parent model/default mutations");
  await btwModelTrigger.click(); await picker.waitFor();
  await picker.getByRole("button", { name: "Manage", exact: true }).click();
  const manage = page.getByRole("dialog", { name: "Manage visible models" });
  await manage.getByRole("option", { name: /Hidden model/ }).click();
  await page.waitForFunction(() => window.btwPreferenceWrites.length === 1);
  const saved = await page.evaluate(() => window.btwPreferenceWrites[0]);
  assert.match(saved, /keep unrelated preferences/);
  assert.match(saved, /"fixture\/fast":"low"/, "side effort must not replace the main remembered preference");
  assert.match(saved, /"modelRef":"fixture\/main"/);
  await manage.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Main model and effort", exact: true }).click(); await picker.waitFor();
  assert((await modelRefs()).includes("fixture/hidden"), "BTW Manage edits the same whitelist as the main picker");
  // Opening BTW closes the main picker; only one shared popup may own the keys.
  await btwModelTrigger.click(); await picker.waitFor();
  assert.equal(await page.locator('[data-model-thinking-popover]').count(), 1);
  assert.match(await picker.innerText(), /BTW side questions only/);
  await picker.getByRole("button", { name: "Manage", exact: true }).click();
  await manage.getByRole("button", { name: "Clear all", exact: true }).click();
  await page.waitForFunction(() => window.btwPreferenceWrites.length === 2);
  await manage.getByRole("button", { name: "Select", exact: true }).click();
  assert.deepEqual(await modelRefs(), ["fixture/fast"], "empty whitelist retains only BTW's current model");
  await picker.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Main model and effort", exact: true }).click(); await picker.waitFor();
  assert.deepEqual(await modelRefs(), ["fixture/main"], "main session retains its own current-model exception");
  await page.keyboard.press("Escape");
  await pane.getByRole("button", { name: "Use main model and effort for BTW" }).click();
  assert.equal(await page.evaluate(() => window.btwSmoke.snapshot().modelRef), null);
  assert.equal(await page.evaluate(() => window.btwSmoke.snapshot().thinkingLevel), null);
  assert.equal(await page.evaluate(() => window.btwSmoke.calls.filter((call) => call.command.action === "ask").length), 3);
  checks.push("Manage shares the Desktop whitelist, Clear all retains current only, Use main resets both choices without inference");
  await page.screenshot({ path: join(output, "btw-wide.png") });
  await pane.locator('[aria-label="BTW conversation"]').evaluate((element) => { element.scrollTop = 100; });
  await page.waitForFunction(() => window.btwSmoke.snapshot().scrollTop === 100);
  await input.fill("Keep side draft"); await input.press("Escape");
  assert.equal(await pane.count(), 0); assert(await main.evaluate((element) => element === document.activeElement));
  await open(); assert.equal(await input.inputValue(), "Keep side draft");
  assert.equal(await pane.locator('[aria-label="BTW conversation"]').evaluate((element) => element.scrollTop), 100);
  await page.evaluate(() => window.btwSmoke.switchSession("b"));
  assert.equal(await pane.count(), 0); await open(); assert.equal(await input.inputValue(), "");
  await page.evaluate(() => window.btwSmoke.switchSession("a")); await pane.waitFor();
  assert.equal(await input.inputValue(), "Keep side draft");
  checks.push("hide/reopen, Escape focus restoration and independent per-session temporary chats");
  const split = page.getByRole("separator", { name: "Resize BTW pane" });
  const initialWidth = (await pane.boundingBox()).width;
  await split.focus(); await split.press("ArrowLeft"); assert((await pane.boundingBox()).width > initialWidth);
  await page.setViewportSize({ width: 600, height: 700 });
  // ResizeObserver publishes on the next layout frame, not inside setViewportSize.
  await page.waitForFunction(() => {
    const box = document.querySelector('[data-btw-pane]')?.getBoundingClientRect();
    return box && box.width <= 360 && box.right <= window.innerWidth + 1;
  });
  const narrow = await pane.boundingBox(); assert(narrow && narrow.x >= 0 && narrow.x + narrow.width <= 601 && narrow.width <= 360);
  assert(await input.isVisible()); await page.screenshot({ path: join(output, "btw-narrow.png") });
  await pane.getByRole("button", { name: "New BTW conversation" }).click();
  assert.equal(await pane.locator('[data-btw-message="assistant"]').count(), 0);
  assert.equal(await input.inputValue(), "");
  await page.setViewportSize({ width: 1180, height: 800 });
  await pane.getByRole("button", { name: "Close BTW pane" }).click();
  await main.fill("/btw Explain the current task"); await main.press("Enter");
  await pane.waitFor();
  await page.waitForFunction(() => window.btwSmoke.calls.filter((call) => call.command.action === "ask").at(-1).command.question === "Explain the current task");
  assert.equal(await main.inputValue(), "");
  const inheritedRequest = await page.evaluate(() => window.btwSmoke.calls.filter((call) => call.command.action === "ask").at(-1).command);
  assert.equal(inheritedRequest.modelRef, undefined); assert.equal(inheritedRequest.thinkingLevel, undefined);
  checks.push("keyboard resizing and narrow bounds; clear conversation; production /btw routing while parent runs");
  await page.evaluate(() => window.btwSmoke.closeSession());
  assert.equal(await pane.count(), 0);
  assert.equal(await page.evaluate(() => JSON.stringify(Object.entries(localStorage)).includes("Why the queue")), false);
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.btwSmoke.errors), []);
  assert.deepEqual(await page.evaluate(() => window.btwSmoke.counts()), { parentSubmits: 0, parentCancels: 0 });
  checks.push("session close deletes side state; no side history storage or browser errors");
  await writeFile(join(output, "report.json"), JSON.stringify({ passed: true, checks, scope: "Real Svelte/browser, synthetic model transport. No native Tauri or live provider." }, null, 2));
  console.log(`BTW browser smoke passed (${checks.length} groups). Evidence: ${output}`);
} catch (error) {
  await page?.screenshot({ path: join(output, "failure.png") }).catch(() => {});
  await writeFile(join(output, "report.json"), JSON.stringify({ passed: false, checks, errors, error: String(error) }, null, 2));
  console.error(`BTW browser evidence: ${output}`); throw error;
} finally { await browser?.close(); await server.close(); }
