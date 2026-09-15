import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

// Real DOM/event propagation and Svelte controller integration; native IPC is
// deliberately stubbed. OS menu rendering/clipboard require a Tauri smoke pass.
const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({
  root,
  configFile: `${root}vite.config.ts`,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [{
    name: "context-menu-smoke-fixture",
    configureServer(vite) {
      vite.middlewares.use("/__context-menu-test__", (_request, response) => {
        response.setHeader("Content-Type", "text/html");
        response.end('<!doctype html><html><head><title>Context menu smoke</title></head><body><div id="app"></div></body></html>');
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address !== "string");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/__context-menu-test__`);
  await page.evaluate(async () => {
    await import("/src/styles.css");
    const { installDesktopContextMenu } = await import("/src/lib/desktop-context-menu.ts");
    const { desktopContextTarget } = await import("/src/lib/desktop-context-target.ts");
    const { createTranscriptUserMessageMenuController } = await import("/src/components/transcript-user-message-menu-controller.svelte.ts");
    document.querySelector("#app").innerHTML = `
      <button id="chrome">Application chrome</button>
      <textarea id="draft">hello draft</textarea>
      <input id="readonly" readonly value="read-only text">
      <input id="password" type="password" value="secret">
      <fieldset disabled><input id="disabled" value="disabled"></fieldset>
      <input id="checkbox" type="checkbox">
      <div id="editable" contenteditable="true">editable <span id="editable-child">content</span></div>
      <section class="transcript-pane">
        <article id="message"><span id="text">selected fragment of a message</span></article>
        <a id="link" href="https://example.com/path?q=test">Example</a>
        <a id="unsafe" href="javascript:alert(1)">Unsafe</a>
        <a id="anchor" href="#heading">Internal anchor</a>
        <a id="local" href="file:///tmp/example.txt">Local file</a>
      </section>`;
    const records = [];
    const errors = [];
    const controller = createTranscriptUserMessageMenuController({
      items: () => [{ id: "m1", type: "message", role: "user", text: "selected fragment of a message" }],
      activeSessionId: () => "session-1", promptRunning: () => false,
      operationRunning: () => false, historyLoading: () => false,
      onScroll: () => {}, onAction: () => {},
    });
    document.querySelector("#message").addEventListener("contextmenu", (event) => controller.openContextMenu(event, "m1"));
    const dispose = installDesktopContextMenu({
      reportError: (error) => errors.push(String(error)),
      createMenu: async (context) => ({
        popup: async (position) => records.push({
          kind: context.kind, linkUrl: context.linkUrl, position,
          focus: document.activeElement?.id, selected: document.getSelection()?.toString(),
        }),
        close: async () => {},
      }),
    });
    window.contextSmoke = { records, errors, controller, dispose, desktopContextTarget };
  });

  const click = async (id) => page.evaluate(async (targetId) => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 60 });
    document.getElementById(targetId).dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { prevented: event.defaultPrevented, records: window.contextSmoke.records.slice(), messageMenu: window.contextSmoke.controller.state.activeId };
  }, id);

  let result = await click("chrome");
  assert.equal(result.prevented, true);
  assert.equal(result.records.length, 0);

  await page.evaluate(() => document.querySelector("#draft").setSelectionRange(0, 5));
  result = await click("draft");
  assert.equal(result.records.at(-1).kind, "editable");
  assert.equal(result.records.at(-1).focus, "draft");
  assert.deepEqual(await page.locator("#draft").evaluate((input) => [input.value, input.selectionStart, input.selectionEnd]), ["hello draft", 0, 5]);

  for (const [id, kind] of [["readonly", "readonly"], ["password", "password"], ["editable-child", "editable"]]) {
    result = await click(id);
    assert.equal(result.records.at(-1).kind, kind);
  }
  const count = result.records.length;
  for (const id of ["disabled", "checkbox", "unsafe", "anchor", "local"]) {
    result = await click(id);
    assert.equal(result.prevented, true);
    assert.equal(result.records.length, count, id);
  }

  await page.evaluate(() => {
    const range = document.createRange();
    const text = document.querySelector("#text").firstChild;
    range.setStart(text, 0); range.setEnd(text, 17);
    const selection = document.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
  });
  result = await click("text");
  assert.equal(result.records.at(-1).kind, "selection");
  assert.equal(result.records.at(-1).selected, "selected fragment");
  assert.equal(result.messageMenu, null);
  const selectionCount = result.records.length;
  result = await click("chrome");
  assert.equal(result.records.length, selectionCount, "a stale transcript selection must not hijack chrome");

  await page.evaluate(() => document.getSelection().removeAllRanges());
  result = await click("message");
  assert.equal(result.prevented, true);
  assert.equal(result.messageMenu, "m1");
  assert.equal(result.records.length, selectionCount, "component stopPropagation must prevent a second menu");

  result = await click("link");
  assert.equal(result.records.at(-1).linkUrl, "https://example.com/path?q=test");

  await page.locator("#draft").focus();
  const beforeKeyboard = result.records.length;
  await page.keyboard.press("Shift+F10");
  await page.waitForFunction((before) => window.contextSmoke.records.length > before, beforeKeyboard);
  assert.equal(await page.evaluate(() => window.contextSmoke.records.at(-1).kind), "editable");
  assert.deepEqual(await page.evaluate(() => window.contextSmoke.errors), []);

  await page.evaluate(() => { window.contextSmoke.dispose(); window.contextSmoke.controller.dispose(); });
  assert.equal((await click("chrome")).prevented, false, "teardown restores the host's listeners");
  console.log("PASS: real-DOM context routing, selection/focus, native-input scopes, message-menu precedence, safe links, Shift+F10 and teardown (Chromium; native IPC stubbed)");
} finally {
  await browser?.close();
  await server.close();
}
