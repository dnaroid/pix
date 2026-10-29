import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
import { compile } from "svelte/compiler";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifactRoot = resolve(root, "../.pi/artifacts");
await mkdir(artifactRoot, { recursive: true });
const output = process.env.WIKI_SMOKE_OUTPUT
  ? resolve(process.env.WIKI_SMOKE_OUTPUT)
  : await mkdtemp(join(artifactRoot, "wiki-panel-browser-"));
await mkdir(output, { recursive: true });

// Compile only the fixture: the two product components and their controllers
// remain real Vite modules. The fixture replaces application/native services.
const fixture = compile(`
<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import ProjectWikiPanel from "/src/components/ProjectWikiPanel.svelte";
  import PreviewPane from "/src/components/PreviewPane.svelte";
  import { resolvePreviewWikiDirectory } from "/src/app/preview-wiki-directory";
  const workspace = "/wiki-panel-browser-smoke";
  let panel = $state<any>(null);
  let ready = $state(false);
  let file = $state<any>(undefined);
  let previewId = $state(0);
  async function openFile(path: string) {
    let contents;
    if (window.__wikiFs.directories.has(path)) {
      const target = await resolvePreviewWikiDirectory(workspace, path, () => true);
      if (target?.kind === "contents") contents = target.file;
      else if (target?.kind === "index") path = target.path;
    }
    const next = contents ?? await invoke("read_project_file", { workspace, path });
    file = next;
    previewId++;
    window.__wikiPanelEvents.opened.push(path);
  }
  async function saveFile(path: string, content: string) {
    const saved = await invoke("write_project_file", { workspace, path, expectedContent: file.content, content });
    file = saved;
    window.__wikiPanelEvents.saved.push({ path, content });
    return true;
  }
  async function validate(path: string) {
    window.__wikiPanelEvents.validated.push(path);
    return window.__wikiFs.files.has(path) ? true : window.__wikiFs.directories.has(path) ? "directory" : false;
  }
  async function resolveMedia(path: string) {
    window.__wikiPanelEvents.media.push(path);
    if (path !== "docs/game/images/map.svg" || !window.__wikiFs.files.has(path)) return undefined;
    return { id: path, name: "map.svg", path: workspace + "/" + path, kind: "image", mimeType: "image/svg+xml", size: 1, dataUrl: window.__wikiImageData };
  }
</script>
<div class="flex h-screen min-h-0 flex-col bg-background text-foreground">
  <header class="flex h-10 shrink-0 items-center border-b border-border bg-chrome px-4 text-sm font-medium">Pix · Game Wiki</header>
  <div class="flex min-h-0 flex-1">
    <aside class="flex w-[296px] shrink-0 flex-col border-r border-border bg-panel" aria-label="Wiki sidebar">
      <div class="flex h-9 shrink-0 items-center gap-1 border-b border-border px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Wiki<button type="button" title="New wiki page" aria-label="New wiki page" disabled={!ready} onclick={() => panel?.create("new-file")}>New</button><button type="button" title="New wiki section" aria-label="New wiki section" disabled={!ready} onclick={() => panel?.create("new-directory")}>New</button><button type="button" title="Refresh Wiki" aria-label="Refresh Wiki" disabled={!ready} onclick={() => panel?.refresh()}>Ref</button></div>
      <ProjectWikiPanel bind:this={panel} bind:ready {workspace} activePath={file?.virtualWikiDirectory ?? file?.path ?? null} onOpenFile={openFile}
        onOpenFiles={(path) => window.__wikiPanelEvents.files.push(path)}
        onOpenExternal={(path) => window.__wikiPanelEvents.external.push(path)}
        onBeforeMutation={async () => { window.__wikiPanelEvents.prepared++; return () => window.__wikiPanelEvents.released++; }} />
    </aside>
    <main class="flex min-h-0 min-w-0 flex-1">
      {#if file}
        <PreviewPane {workspace} {file} {previewId} markdownLinkBase="document" editable={!file.virtualWikiDirectory}
          scrollPosition={{top:0,left:0}} onOpenProjectFile={openFile} onValidateProjectFile={validate}
          onResolveProjectMedia={resolveMedia} onSaveProjectFile={saveFile}
          onDirtyChange={(dirty) => window.__wikiPanelEvents.dirty = dirty}
          onClose={() => file = undefined} />
      {:else}<p class="m-auto text-sm text-muted-foreground">Open a Wiki page to read or edit it.</p>{/if}
    </main>
  </div>
</div>
`, { filename: "WikiPanelSmoke.svelte", generate: "client", dev: true }).js.code;

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="200" viewBox="0 0 480 200"><rect width="480" height="200" fill="#223244"/><path d="M40 150L135 50L240 120L330 40L440 115" fill="none" stroke="#7fa8b9" stroke-width="3"/><g fill="#d6e4eb"><circle cx="40" cy="150" r="8"/><circle cx="135" cy="50" r="8"/><circle cx="240" cy="120" r="8"/><circle cx="330" cy="40" r="8"/><circle cx="440" cy="115" r="8"/></g><text x="20" y="185" fill="#d6e4eb" font-size="16" font-family="sans-serif">Example mission map</text></svg>';
const imageData = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
let server;
let browser;
let page;
let assertions = 0;
const pageErrors = [];
const consoleErrors = [];
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++; };
const check = (condition, message) => { assert.ok(condition, message); assertions++; };

try {
  server = await createServer({
    root, configFile: join(root, "vite.config.ts"), logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
    plugins: [{
      name: "wiki-panel-smoke",
      resolveId(id) {
        if (id === "/__wiki_panel_entry__.js") return "\0wiki-panel-entry";
        if (id === "/__wiki_panel_fixture__.js") return "\0wiki-panel-fixture";
      },
      load(id) {
        if (id === "\0wiki-panel-fixture") return fixture;
        if (id === "\0wiki-panel-entry") return 'import "/src/styles.css"; export {mount,unmount} from "svelte"; export {default as Fixture} from "/__wiki_panel_fixture__.js";';
      },
      configureServer(vite) {
        vite.middlewares.use("/__wiki-panel-test__", (_request, response) => {
          response.setHeader("Content-Type", "text/html");
          response.end('<!doctype html><html><head><meta charset="utf-8"><title>Wiki panel smoke</title><link rel="icon" href="data:,"></head><body style="margin:0"><div id="app"></div></body></html>');
        });
      },
    }],
  });
  await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address === "object");
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: "light" });
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${address.port}/__wiki-panel-test__`, { waitUntil: "domcontentloaded" });
  await page.evaluate(async ({ imageData }) => {
    const files = new Map([[".pi/workspace.jsonc", '{"wiki":{"path":"docs/game","index":"overview/home.md"}}']]);
    const directories = new Set(["", ".pi"]);
    window.__wikiFs = { files, directories };
    window.__wikiImageData = imageData;
    window.__wikiPanelEvents = { opened: [], saved: [], validated: [], media: [], files: [], external: [], calls: [], diagnostics: [], unknown: [], prepared: 0, released: 0, dirty: false };
    window.__TAURI_INTERNALS__ = { convertFileSrc: (path) => {
      if (path !== "/wiki-panel-browser-smoke/docs/game/images/map.svg") throw new Error(`Unexpected media path: ${path}`);
      return imageData;
    }, invoke: async (command, args = {}) => {
      const events = window.__wikiPanelEvents;
      events.calls.push({ command, ...args });
      if (command === "project_file_exists") {
        if (window.__wikiPausedIndex?.path === args.path) await window.__wikiPausedIndex.promise;
        return files.has(args.path);
      }
      if (command === "project_directory_exists") return directories.has(args.path);
      if (command === "read_project_file") {
        if (!files.has(args.path)) throw new Error(`Missing fixture file: ${args.path}`);
        return { path: args.path, content: files.get(args.path) };
      }
      if (command === "list_project_directory") {
        const path = args.path ?? "";
        if (!directories.has(path)) throw new Error(`Missing fixture folder: ${path}`);
        const prefix = path ? `${path}/` : "";
        const entries = [];
        for (const [kind, values] of [["directory", directories], ["file", files.keys()]]) {
          for (const child of values) {
            if (!child.startsWith(prefix) || child === path) continue;
            const name = child.slice(prefix.length);
            if (name && !name.includes("/")) entries.push({ name, path: child, kind });
          }
        }
        return entries;
      }
      if (command === "create_project_entry") {
        const parent = args.parent ?? "";
        if (!directories.has(parent)) throw new Error(`Missing fixture parent: ${parent}`);
        const path = parent ? `${parent}/${args.name}` : args.name;
        if (files.has(path) || directories.has(path)) throw new Error(`Fixture collision: ${path}`);
        if (args.kind === "directory") directories.add(path); else files.set(path, "");
        return { name: args.name, path, kind: args.kind };
      }
      if (command === "write_project_file") {
        if (!files.has(args.path) || files.get(args.path) !== args.expectedContent) throw new Error(`Fixture write conflict: ${args.path}`);
        files.set(args.path, args.content);
        return { path: args.path, content: args.content };
      }
      if (command === "log_desktop_diagnostic") { events.diagnostics.push(args); return; }
      if (command === "log_desktop_event") return;
      events.unknown.push(command);
      throw new Error(`Unexpected native command: ${command}`);
    } };
    const { mount, Fixture } = await import("/__wiki_panel_entry__.js");
    window.__wikiPanelFixture = mount(Fixture, { target: document.getElementById("app") });
  }, { imageData });

  await page.getByRole("button", { name: "Create Wiki", exact: true }).waitFor({ state: "visible" });
  check((await page.getByRole("complementary", { name: "Wiki sidebar" }).innerText()).includes("docs/game/"),
    "The empty panel must use the configured Wiki root");
  await page.getByRole("button", { name: "Create Wiki", exact: true }).click();
  await page.getByRole("region", { name: "Rendered Markdown for docs/game/overview/home.md", exact: true }).waitFor({ state: "visible" });
  const initialized = await page.evaluate(() => ({ dirs: [...window.__wikiFs.directories], content: window.__wikiFs.files.get("docs/game/overview/home.md"), opened: window.__wikiPanelEvents.opened.at(-1) }));
  check(initialized.dirs.includes("docs/game/overview") && !initialized.dirs.includes("wiki"),
    "Create Wiki must create configured nested parents without a second default folder");
  check(initialized.content.startsWith("# Project wiki"), "Create Wiki must write the Markdown index");
  equal(initialized.opened, "docs/game/overview/home.md", "Create Wiki must open its configured index");

  await page.getByRole("treeitem", { name: "Contents", exact: true }).focus();
  await page.getByRole("button", { name: "New wiki section", exact: true }).click();
  const sectionName = page.getByRole("textbox", { name: "New folder name", exact: true });
  await sectionName.fill("rules");
  await sectionName.press("Enter");
  const rules = page.getByRole("treeitem", { name: "rules", exact: true });
  await rules.waitFor({ state: "visible" });
  check(await page.evaluate(() => window.__wikiFs.directories.has("docs/game/rules")),
    "New section must create a folder under the configured root");
  await rules.focus();
  await page.getByRole("button", { name: "New wiki page", exact: true }).click();
  const pageName = page.getByRole("textbox", { name: "New file name", exact: true });
  await pageName.fill("combat");
  await pageName.press("Enter");
  await page.getByRole("region", { name: "Rendered Markdown for docs/game/rules/combat.md", exact: true }).waitFor({ state: "visible" });
  check(await page.evaluate(() => window.__wikiFs.files.has("docs/game/rules/combat.md")),
    "New page must add .md and use the focused section");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const visual = page.getByRole("textbox", { name: "Markdown document", exact: true });
  await visual.waitFor({ state: "visible" });
  equal(await page.getByRole("button", { name: "Visual", exact: true }).getAttribute("aria-pressed"), "true",
    "Preview Edit must open the WYSIWYG mode");
  await visual.click();
  await page.keyboard.type("Combat costs one action point.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).waitFor({ state: "visible" });
  const saved = await page.evaluate(() => window.__wikiPanelEvents.saved.at(-1));
  equal(saved.path, "docs/game/rules/combat.md", "Visual save must target the selected page");
  check(saved.content.includes("Combat costs one action point."), "Visual save must propagate the actual Markdown draft");
  equal(await page.evaluate(() => window.__wikiFs.files.get("docs/game/rules/combat.md")), saved.content,
    "The file service must receive the same draft as the save callback");

  // The image is an existing project asset; only its native bytes are mocked.
  await page.evaluate((svg) => {
    window.__wikiFs.directories.add("docs/game/images");
    window.__wikiFs.files.set("docs/game/images/map.svg", svg);
  }, svg);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await visual.waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await page.getByRole("textbox", { name: "Edit docs/game/rules/combat.md", exact: true }).fill(
    "# Combat rules\n\nCombat costs one action point.\n\n![Mission map](../images/map.svg)\n\n[Wiki overview](../overview/home.md)\n",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("region", { name: "Rendered Markdown for docs/game/rules/combat.md", exact: true }).waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const image = document.querySelector('.preview-text-surface img[alt="Mission map"]');
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
  });
  check(await page.evaluate(() => window.__wikiPanelEvents.media.includes("docs/game/images/map.svg")),
    "Read preview must resolve images relative to a nested page");
  await page.getByRole("link", { name: "Wiki overview", exact: true }).click();
  await page.getByRole("region", { name: "Rendered Markdown for docs/game/overview/home.md", exact: true }).waitFor({ state: "visible" });
  equal(await page.evaluate(() => window.__wikiPanelEvents.opened.at(-1)), "docs/game/overview/home.md",
    "Relative Wiki links must open the corresponding project document");

  // Index pages belong to their folder, including a custom nested Wiki home.
  const overview = page.getByRole("treeitem", { name: "overview", exact: true });
  await page.getByRole("button", { name: "Expand overview", exact: true }).click();
  await page.waitForFunction(() => window.__wikiPanelEvents.calls.some((call) =>
    call.command === "list_project_directory" && call.path === "docs/game/overview"));
  equal(await page.locator('[data-wiki-tree] [data-project-tree-path="overview/home.md"]').count(), 0,
    "The configured home page must be hidden inside its owning folder");
  await overview.click();
  await page.waitForFunction(() => window.__wikiPanelEvents.opened.at(-1) === "docs/game/overview/home.md");
  equal(await overview.getAttribute("aria-selected"), "true", "An open index must highlight its owning folder");

  await rules.focus();
  await page.getByRole("button", { name: "New wiki page", exact: true }).click();
  await pageName.fill("index");
  await pageName.press("Enter");
  await page.getByRole("region", { name: "Rendered Markdown for docs/game/rules/index.md", exact: true }).waitFor({ state: "visible" });
  equal(await page.locator('[data-wiki-tree] [data-project-tree-path="rules/index.md"]').count(), 0,
    "A newly created index must be hidden while remaining open for editing");
  equal(await rules.getAttribute("aria-selected"), "true", "Creating an index must select its folder");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await visual.waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await page.getByRole("textbox", { name: "Edit docs/game/rules/index.md", exact: true })
    .fill("# Rules\n\nChoose a page in this section.\n");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("region", { name: "Rendered Markdown for docs/game/rules/index.md", exact: true }).waitFor({ state: "visible" });

  await page.getByRole("treeitem", { name: "Contents", exact: true }).click();
  await page.getByRole("region", { name: "Rendered Markdown for docs/game/overview/home.md", exact: true }).waitFor({ state: "visible" });
  const beforeDisclosure = await page.evaluate(() => window.__wikiPanelEvents.opened.length);
  await page.getByRole("button", { name: "Collapse rules", exact: true }).click();
  equal(await rules.getAttribute("aria-expanded"), "false", "The chevron must collapse a section");
  equal(await page.evaluate(() => window.__wikiPanelEvents.opened.length), beforeDisclosure,
    "Clicking the chevron must not open the folder index");

  await rules.click();
  await page.getByRole("region", { name: "Rendered Markdown for docs/game/rules/index.md", exact: true }).waitFor({ state: "visible" });
  equal(await rules.getAttribute("aria-expanded"), "false", "Selecting an indexed folder must leave its expansion unchanged");
  let beforeKeyboard = await page.evaluate(() => window.__wikiPanelEvents.opened.length);
  await rules.press("ArrowRight");
  await page.getByRole("treeitem", { name: "combat", exact: true }).waitFor({ state: "visible" });
  equal(await page.evaluate(() => window.__wikiPanelEvents.opened.length), beforeKeyboard,
    "Right-arrow expansion must not navigate");
  equal(await page.locator('[data-wiki-tree] [data-project-tree-path="rules/index.md"]').count(), 0,
    "Expanding a section must show its pages without its index file");

  for (const key of ["Enter", "Space"]) {
    beforeKeyboard = await page.evaluate(() => window.__wikiPanelEvents.opened.length);
    await rules.press(key);
    await page.waitForFunction((count) => window.__wikiPanelEvents.opened.length > count, beforeKeyboard);
    equal(await page.evaluate(() => window.__wikiPanelEvents.opened.at(-1)), "docs/game/rules/index.md",
      key + " must open the folder's index");
  }

  await page.getByRole("button", { name: "Refresh Wiki", exact: true }).click();
  const images = page.getByRole("treeitem", { name: "images", exact: true });
  await images.waitFor({ state: "visible" });
  const beforeEmpty = await page.evaluate(() => window.__wikiFs.files.size);
  await images.click();
  await page.getByRole("region", { name: "Rendered Markdown for docs/game/images/index.md", exact: true }).waitFor({ state: "visible" });
  equal(await page.evaluate(() => window.__wikiPanelEvents.opened.at(-1)), "docs/game/images",
    "A folder without an index must open virtual contents");
  equal(await page.getByRole("button", { name: "Edit", exact: true }).count(), 0,
    "Virtual contents must be read-only");
  equal(await page.getByRole("button", { name: "Copy file", exact: true }).count(), 0,
    "Virtual contents must not expose a nonexistent file");
  equal(await page.evaluate(() => window.__wikiFs.files.size), beforeEmpty,
    "Opening virtual contents must not create an index on disk");

  await page.evaluate(() => {
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    window.__wikiPausedIndex = { path: "docs/game/rules/index.md", promise, release };
  });
  await rules.click();
  await page.getByRole("treeitem", { name: "Contents", exact: true }).click();
  await page.getByRole("region", { name: "Rendered Markdown for docs/game/overview/home.md", exact: true }).waitFor({ state: "visible" });
  await page.evaluate(async () => {
    window.__wikiPausedIndex.release();
    await window.__wikiPausedIndex.promise;
    delete window.__wikiPausedIndex;
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  equal(await page.evaluate(() => window.__wikiPanelEvents.opened.at(-1)), "docs/game/overview/home.md",
    "Contents must cancel an older folder lookup before it can replace the page");

  await page.getByRole("treeitem", { name: "combat", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await visual.waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const image = document.querySelector(".wiki-inline-image img");
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0 && !image.hidden;
  });
  equal(await page.locator(".wiki-inline-image img").getAttribute("src"), imageData,
    "Visual editing must resolve the same relative project image");
  check(!(await page.evaluate(() => window.__wikiFs.files.get("docs/game/rules/combat.md"))).includes("data:image"),
    "Rendering assets must retain relative Markdown paths on disk");
  await page.getByRole("button", { name: "Refresh Wiki", exact: true }).click();
  await page.getByRole("treeitem", { name: "images", exact: true }).waitFor({ state: "visible" });
  await page.screenshot({ path: join(output, "wiki-panel-light.png"), fullPage: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: join(output, "wiki-panel-dark.png"), fullPage: true });
  const events = await page.evaluate(() => window.__wikiPanelEvents);
  equal(events.prepared, events.released, "Wiki mutations must release their file operation reservations");
  equal(events.unknown, [], "All file access must use the expected native APIs");
  equal(events.diagnostics, [], "The integrated flow must not report operation failures");
  equal(pageErrors, [], "The browser must not emit uncaught exceptions");
  equal(consoleErrors, [], "The browser must not emit unexpected console errors");
  await writeFile(join(output, "result.json"), JSON.stringify({ passed: true, assertions, pageErrors, consoleErrors, events }, null, 2));
  console.log(JSON.stringify({ passed: true, assertions, output }));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(output, "wiki-panel-failure.png"), fullPage: true }).catch(() => {});
  await writeFile(join(output, "result.json"), JSON.stringify({ passed: false, assertions, error: error instanceof Error ? error.stack : String(error), pageErrors, consoleErrors }, null, 2));
  console.error(JSON.stringify({ passed: false, assertions, output }));
  throw error;
} finally {
  if (page && !page.isClosed()) await page.evaluate(async () => {
    if (window.__wikiPanelFixture) { const { unmount } = await import("/__wiki_panel_entry__.js"); await unmount(window.__wikiPanelFixture); }
  }).catch(() => {});
  await browser?.close();
  await server?.close();
}
