import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";

// Real browser events and real Svelte components; only model/IPC state is synthetic.
const root = fileURLToPath(new URL("../", import.meta.url));
const artifactRoot = join(root, "..", ".pi", "artifacts");
await mkdir(artifactRoot, { recursive: true });
const output = await mkdtemp(join(artifactRoot, "observer-ui-"));
const schema = await readFile(join(root, "..", "schemas", "pix-desktop.json"), "utf8");
const server = await createServer({ root, configFile: join(root, "vite.config.ts"), logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [{ name: "observer-smoke",
    resolveId(id) { if (id === "/__observer-fixture__.js") return "\0observer-fixture"; },
    load(id) { if (id === "\0observer-fixture") return 'import {mount} from "svelte"; import App from "/scripts/fixtures/ObserverSmoke.svelte"; import "/src/styles.css"; mount(App,{target:document.getElementById("app")});'; },
    configureServer(vite) {
    vite.middlewares.use("/__observer_smoke__", (_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end('<!doctype html><html><head><title>Observer smoke</title></head><body><div id="app"></div><script type="module" src="/__observer-fixture__.js"></script></body></html>');
    });
  } }],
});
let browser;
const checks = [];
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.setDefaultTimeout(7000);
  const errors = [];
  page.on("pageerror", (error) => { errors.push(error.message); console.error(error.message); });
  await page.addInitScript(({ schema }) => {
    const sources = { desktop: '{\n // preserve comment\n "defaultModel":{"modelRef":"provider/main-model"}\n}', "pi-tools-suite": "{}" };
    window.savedObserverConfigs = [];
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      const document = () => ({ path: `/synthetic/${args.kind}.jsonc`, content: sources[args.kind], exists: true, schema: args.kind === "desktop" ? schema : "{}" });
      if (command === "read_user_config") { await new Promise((resolve) => setTimeout(resolve, 120)); return document(); }
      if (command === "write_user_config_if_unchanged") {
        const written = sources[args.kind] === args.expectedContent;
        if (written) { sources[args.kind] = args.content; window.savedObserverConfigs.push(args.content); }
        return { written, document: document() };
      }
      throw new Error(`Unexpected native call: ${command}`);
    } };
  }, { schema });
  const address = server.httpServer.address();
  assert(address && typeof address !== "string");
  await page.goto(`http://127.0.0.1:${address.port}/__observer_smoke__`);
  await page.waitForFunction(() => !!window.observerSmoke);
  const trigger = page.locator("[data-observer-status] > button");
  assert.equal((await trigger.innerText()).trim(), "");
  assert.match(await trigger.getAttribute("class"), /text-muted-foreground/);
  assert.equal(await trigger.locator("svg.lucide-telescope").count(), 1);
  await trigger.click();
  const popup = page.getByRole("dialog", { name: "Observer status" });
  await popup.waitFor();
  assert.match(await popup.innerText(), /Not checked yet/);
  assert.doesNotMatch(await popup.innerText(), /Recorded tokens|Local feedback|Input used/);
  await popup.getByRole("button", { name: "Technical details", exact: true }).click();
  assert.match(await popup.innerText(), /Recorded tokens|Input used/);
  await page.screenshot({ path: join(output, "popup-technical-details.png") });
  await popup.getByRole("button", { name: "Hide technical details", exact: true }).click();
  assert.doesNotMatch(await popup.innerText(), /Recorded tokens|Input used/);
  assert.doesNotMatch(await popup.innerText(), /Model|Min\. interval|Input budget|required|\/ 12/);
  assert.equal(await popup.locator('input[type="checkbox"]').count(), 0);
  assert.equal(await popup.getByRole("switch", { name: "Observer for this session" }).evaluate((element) => element.tagName), "BUTTON");
  assert.deepEqual(await page.evaluate(() => window.observerSmoke.calls), ["/heads-up snapshot"]);
  const box = await popup.boundingBox();
  assert(box && box.x >= 0 && box.x + box.width <= 1100);
  await page.screenshot({ path: join(output, "popup-off.png") });
  await popup.getByRole("switch").click();
  await page.waitForFunction(() => window.observerSmoke.snapshot().enabled);
  assert.match(await trigger.getAttribute("class"), /text-primary/);
  assert.equal(await trigger.locator(".animate-pulse").count(), 0);
  await page.screenshot({ path: join(output, "popup-enabled.png") });
  await popup.getByRole("button", { name: "Check now", exact: true }).click();
  await page.waitForFunction(() => window.observerSmoke.snapshot().phase === "checking");
  // Disabling the focused Check now button can move focus outside the popup.
  // Reopen to inspect checking state without changing the inference state.
  if (!await popup.isVisible()) await trigger.click();
  assert.equal(await trigger.locator("svg.lucide-telescope.animate-pulse").count(), 1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await trigger.locator("svg").evaluate((element) => getComputedStyle(element).animationName), "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.screenshot({ path: join(output, "popup-checking.png") });
  assert(await popup.getByRole("button", { name: "Checking…", exact: true }).isDisabled());
  assert(await popup.getByRole("switch").isEnabled());
  await popup.getByRole("switch").click();
  await page.waitForFunction(() => !window.observerSmoke.snapshot().enabled);
  assert.equal(await trigger.locator(".animate-pulse").count(), 0);
  assert.match(await trigger.getAttribute("class"), /text-muted-foreground/);
  assert.match(await popup.innerText(), /Check cancelled/);
  assert.equal(await page.getByRole("textbox", { name: "Main draft" }).inputValue(), "Keep this draft");
  checks.push("open is read-only; toggle/check are explicit; Off remains available during checking; draft preserved");
  checks.push("telescope only; grey off/primary enabled; pulse only while checking with reduced-motion support; standard button switch; diagnostics disclosure");

  await popup.focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.evaluate(() => document.activeElement.textContent), "Observer settings");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), "Observer for this session");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), "Technical details");
  await page.keyboard.press("Enter");
  assert.match(await popup.innerText(), /Recorded tokens/);
  await page.keyboard.press("Escape");
  assert.equal(await popup.count(), 0);
  assert(await trigger.evaluate((element) => element === document.activeElement));
  await page.evaluate(() => { window.escapeWasPrevented = null; window.addEventListener("keydown", (event) => { if (event.key === "Escape") window.escapeWasPrevented = event.defaultPrevented; }, { once: true }); });
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => window.escapeWasPrevented), false);
  checks.push("keyboard cycle and Escape focus restoration; closed popup does not intercept Escape");

  await trigger.click();
  await page.evaluate(() => window.observerSmoke.setSession("session-b"));
  await popup.waitFor({ state: "detached" });
  await trigger.click();
  assert.match(await popup.innerText(), /Not checked yet/);
  await page.evaluate(() => window.observerSmoke.publish({ instanceId: "replacement" }));
  await popup.waitFor({ state: "detached" });
  await trigger.click();
  await page.evaluate(() => window.observerSmoke.setReady(false));
  await popup.waitFor({ state: "detached" });
  await page.evaluate(() => window.observerSmoke.setReady(true));
  checks.push("popup closes on session switch, runtime replacement and unready state");

  await trigger.click();
  await popup.getByRole("button", { name: "Observer settings" }).click();
  await page.waitForFunction(() => document.activeElement?.closest('[data-settings-section="desktop-observer"]'));
  assert.equal(await popup.count(), 0);
  await page.getByRole("button", { name: "Observer model", exact: true }).click();
  await page.getByRole("option", { name: /Observer Model/ }).click();
  await page.getByRole("spinbutton", { name: "Observer minimum interval in seconds" }).fill("75");
  await page.getByRole("switch", { name: "Enable Observer in new Desktop sessions" }).click();
  await page.getByRole("button", { name: "Save Desktop settings", exact: true }).first().click();
  await page.waitForFunction(() => window.savedObserverConfigs.length === 1);
  const saved = await page.evaluate(() => window.savedObserverConfigs[0]);
  assert.match(saved, /"minIntervalMs": 75000/); assert.match(saved, /provider\/observer-model/); assert.match(saved, /preserve comment/); assert.match(saved, /provider\/main-model/);
  assert.equal(await page.evaluate(() => window.observerSmoke.snapshot().enabled), false);
  await page.getByRole("searchbox", { name: "Search settings" }).fill("Observer timeout");
  await page.getByRole("spinbutton", { name: "Observer request timeout in seconds" }).waitFor({ state: "visible" });
  await page.getByRole("searchbox", { name: "Search settings" }).fill("");
  await page.screenshot({ path: join(output, "settings.png") });
  checks.push("cold async settings deep link; real model select and seconds conversion; CAS save preserves unrelated settings and runtime toggle; advanced search works");

  await page.evaluate(() => window.observerSmoke.closeSettings());
  await page.setViewportSize({ width: 420, height: 700 });
  await trigger.click();
  const narrow = await popup.boundingBox(); assert(narrow && narrow.x >= 0 && narrow.x + narrow.width <= 420);
  await page.screenshot({ path: join(output, "popup-narrow.png") });
  await page.locator("#outside").click();
  assert.equal(await popup.count(), 0);
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.observerSmoke.errors), []);
  checks.push("narrow viewport bounds and outside dismissal; no browser/store errors");
  await writeFile(join(output, "report.json"), JSON.stringify({ passed: true, checks, scope: "Browser components with synthetic IPC; not native Tauri or real inference" }, null, 2));
  console.log(`Observer browser smoke passed (${checks.length} groups). Evidence: ${output}`);
} catch (error) {
  await writeFile(join(output, "report.json"), JSON.stringify({ passed: false, checks, error: String(error) }, null, 2));
  console.error(`Observer smoke evidence: ${output}`);
  throw error;
} finally {
  await browser?.close(); await server.close();
}
