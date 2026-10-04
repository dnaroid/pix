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
        <a href="https://example.com/linked"><img id="linked-image" src="data:image/png;base64,AA=="></a>
        <img id="preview-image" src="data:image/png;base64,AA==" data-image-path="/project/chart.png">
        <button id="preview-tab" data-context-file-path="src/main.ts"><span id="preview-tab-label">main.ts</span></button>
        <section id="preview-surface" data-context-file-path="src/main.ts">
          <div id="preview-blank">Blank preview space</div>
          <textarea id="preview-editor">Editable preview</textarea>
        </section>
        <button data-context-file-path="/tmp/my video.mov"><video id="preview-video" src="data:video/mp4;base64,AA=="></video></button>
        <button id="missing-path" data-context-file-path="">Unavailable file</button>
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
      workspace: () => "/project",
      reportError: (error) => errors.push(String(error)),
      createMenu: async (context) => ({
        popup: async (position) => records.push({
          kind: context.kind, linkUrl: context.linkUrl, filePath: context.filePath, position,
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

  for (const id of ["linked-image", "preview-image"]) {
    result = await click(id);
    assert.equal(result.records.at(-1).kind, "image");
    assert.equal(result.records.at(-1).linkUrl, undefined, "image actions override a surrounding link");
  }

  for (const [id, path] of [["preview-tab-label", "/project/src/main.ts"], ["preview-blank", "/project/src/main.ts"], ["preview-video", "/tmp/my video.mov"], ["missing-path", undefined]]) {
    result = await click(id);
    assert.equal(result.records.at(-1).kind, "file");
    assert.equal(result.records.at(-1).filePath, path);
  }
  result = await click("preview-editor");
  assert.equal(result.records.at(-1).kind, "editable", "file context must not replace text editing");

  // Hydrate real Markdown video markup: context actions must target the media,
  // not inherit the surrounding document's path, even while resolution waits.
  // Keep media loading pending: this regression tests routing, not video decoding.
  await page.route("**/__context-video__", () => {});
  await page.evaluate(async () => {
    const { createMarkdownContentAction } = await import("/src/components/markdown-content-action.ts");
    const node = document.createElement("div");
    node.innerHTML = '<span id="embedded-video" class="markdown-media" data-project-media="video" data-project-file="clips/movie.mov"><span class="markdown-media-frame"></span></span>';
    document.querySelector("#preview-surface").append(node);
    node.scrollIntoView();
    let resolve;
    const pending = new Promise(done => { resolve = done; });
    const previousInternals = window.__TAURI_INTERNALS__;
    window.__TAURI_INTERNALS__ = { ...previousInternals, convertFileSrc: () => `${location.origin}/__context-video__` };
    const action = createMarkdownContentAction({
      externalLinkIconTemplate: () => undefined,
      onValidateProjectFile: () => undefined, onValidateLocalFile: () => undefined,
      onResolveProjectMedia: () => () => pending, onResolveLocalMedia: () => undefined,
    })(node, node.innerHTML);
    window.finishEmbeddedVideo = () => resolve({ id: "video", name: "movie.mov", kind: "video", path: "/project/clips/movie.mov" });
    window.disposeEmbeddedVideo = () => { action.destroy(); node.remove(); window.__TAURI_INTERNALS__ = previousInternals; };
  });
  await page.waitForFunction(() => document.querySelector("#embedded-video").dataset.mediaState === "loading");
  result = await click("embedded-video");
  assert.equal(result.records.at(-1).kind, "file");
  assert.equal(result.records.at(-1).filePath, undefined, "unresolved media must not act on the enclosing Markdown file");
  await page.evaluate(() => window.finishEmbeddedVideo());
  await page.waitForFunction(() => document.querySelector("#embedded-video video"));
  await page.evaluate(() => { document.querySelector("#embedded-video video").id = "hydrated-video"; });
  result = await click("hydrated-video");
  assert.equal(result.records.at(-1).filePath, "/project/clips/movie.mov");
  await page.evaluate(() => window.disposeEmbeddedVideo());

  await page.locator("#preview-tab").focus();
  const beforeFileKeyboard = result.records.length;
  await page.keyboard.press("Shift+F10");
  await page.waitForFunction((before) => window.contextSmoke.records.length > before, beforeFileKeyboard);
  assert.equal(await page.evaluate(() => window.contextSmoke.records.at(-1).filePath), "/project/src/main.ts");

  await page.locator("#draft").focus();
  const beforeKeyboard = result.records.length;
  await page.keyboard.press("Shift+F10");
  await page.waitForFunction((before) => window.contextSmoke.records.length > before, beforeKeyboard);
  assert.equal(await page.evaluate(() => window.contextSmoke.records.at(-1).kind), "editable");
  assert.deepEqual(await page.evaluate(() => window.contextSmoke.errors), []);

  // Real DOM eligibility, not proof of WebKit's native spelling popup.
  await page.evaluate(async () => {
    const { nativeSpellingContextTarget } = await import("/src/lib/desktop-context-target.ts");
    const draft = document.querySelector("#draft");
    const eligible = () => nativeSpellingContextTarget(draft);
    if (eligible()) throw new Error("unmarked editors must retain the application menu");
    draft.setAttribute("data-native-spelling-menu", "");
    draft.spellcheck = true;
    if (!eligible()) throw new Error("prose composer should opt into native spelling");
    for (const name of ["readonly", "disabled", "inert"]) {
      draft.setAttribute(name, "");
      if (eligible()) throw new Error(`${name} editors must not opt into native spelling`);
      draft.removeAttribute(name);
    }
    draft.spellcheck = false;
    if (eligible()) throw new Error("spellcheck-disabled editors must retain the application menu");
    draft.spellcheck = true;
    document.querySelector("#password").setAttribute("data-native-spelling-menu", "");
    if (nativeSpellingContextTarget(document.querySelector("#password"))) throw new Error("passwords must not opt in");
  });

  await page.evaluate(() => { window.contextSmoke.dispose(); window.contextSmoke.controller.dispose(); });
  assert.equal((await click("chrome")).prevented, false, "teardown restores the host's listeners");

  await page.evaluate(async () => {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Macintosh" });
    const { installDesktopContextMenu } = await import("/src/lib/desktop-context-menu.ts");
    window.spellingSmoke = { popups: 0, prevented: null, trusted: null };
    window.spellingSmoke.dispose = installDesktopContextMenu({
      reportError: (error) => { throw error; },
      createMenu: async () => ({ popup: async () => window.spellingSmoke.popups++, close: async () => {} }),
    });
    window.addEventListener("contextmenu", (event) => {
      window.spellingSmoke.prevented = event.defaultPrevented;
      window.spellingSmoke.trusted = event.isTrusted;
    });
  });
  await page.locator("#draft").click({ button: "right" });
  assert.deepEqual(await page.evaluate(() => [window.spellingSmoke.trusted, window.spellingSmoke.prevented, window.spellingSmoke.popups]), [true, false, 0]);
  await page.keyboard.press("Escape");
  await page.locator("#draft").focus();
  await page.keyboard.press("Shift+F10");
  await page.waitForFunction(() => window.spellingSmoke.popups === 1);
  assert.equal(await page.evaluate(() => window.spellingSmoke.prevented), true, "synthetic keyboard requests keep their application fallback");
  await page.evaluate(() => window.spellingSmoke.dispose());

  // Exercise real origin-tainted canvas failure and real SVG->PNG conversion.
  // Only approved file reads and final native clipboard delivery are stubbed.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><path fill="red" d="M0 0h2v2H0z"/></svg>';
  await page.route("https://copy-image.invalid/chart.svg", (route) => route.fulfill({
    contentType: "image/svg+xml", body: svg,
  }));
  const copyResult = await page.evaluate(async (svgSource) => {
    const { copyContextImage } = await import("/src/lib/image-context-actions.ts");
    const { nativeContextMenuItems } = await import("/src/lib/native-context-menu.ts");
    const { desktopContextTarget } = await import("/src/lib/desktop-context-target.ts");
    const img = document.createElement("img");
    img.src = "https://copy-image.invalid/chart.svg";
    img.dataset.imagePath = "/project/chart.svg";
    document.body.append(img);
    const previous = window.__TAURI_INTERNALS__;
    const calls = [];
    window.__TAURI_INTERNALS__ = { ...previous, invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "read_attachment_base64") return btoa(svgSource);
      if (command === "plugin:clipboard-manager|write_image" || command === "preview_file_action") return;
      throw new Error(`Unexpected IPC: ${command}`);
    } };
    try {
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 2;
      canvas.getContext("2d").drawImage(img, 0, 0);
      let originalError;
      try { canvas.toDataURL(); } catch (error) { originalError = error.name; }
      await copyContextImage(img, () => true);
      const encoded = calls.find(({ command }) => command === "plugin:clipboard-manager|write_image")?.args.image;
      const png = await createImageBitmap(new Blob([encoded], { type: "image/png" }));
      const clean = document.createElement("canvas");
      clean.width = clean.height = 2;
      clean.getContext("2d").drawImage(png, 0, 0);
      const pixel = Array.from(clean.getContext("2d").getImageData(0, 0, 1, 1).data);
      png.close();
      const videoTarget = desktopContextTarget(document.querySelector("#preview-video"), "/project");
      const errors = [];
      const menu = nativeContextMenuItems(videoTarget, false, (error) => errors.push(String(error)), () => true);
      menu.find((item) => item.id === "desktop.file.copy").action();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { originalError, pixel, errors, calls: calls.map(({ command, args }) => ({
        command, path: args?.path, action: args?.action,
      })) };
    } finally {
      img.remove();
      window.__TAURI_INTERNALS__ = previous;
    }
  }, svg);
  assert.equal(copyResult.originalError, "SecurityError", "fixture must reproduce origin-tainted canvas failure");
  assert.deepEqual(copyResult.pixel, [255, 0, 0, 255], "copy must deliver decoded PNG pixels, not a path");
  assert.deepEqual(copyResult.errors, []);
  assert.deepEqual(copyResult.calls.map(({ command }) => command), ["read_attachment_base64", "plugin:clipboard-manager|write_image", "preview_file_action"]);
  assert.equal(copyResult.calls[0].path, "/project/chart.svg");
  assert.deepEqual(copyResult.calls[2], { command: "preview_file_action", path: "/tmp/my video.mov", action: "copy" });
  console.log("PASS: real-DOM context routing, selection/focus, native-input scopes, message-menu precedence, safe links, Shift+F10 and teardown (Chromium; native IPC stubbed)");
} finally {
  await browser?.close();
  await server.close();
}
