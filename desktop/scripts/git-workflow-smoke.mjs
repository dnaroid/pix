import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const screenshots = `${root}.artifacts/git-workflow`;
const server = await createServer({
  root, configFile: `${root}vite.config.ts`, logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [{ name: "git-workflow-smoke", configureServer(vite) {
    vite.middlewares.use("/__git-workflow__", (_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end('<!doctype html><html><head><title>Git workflow smoke</title></head><body><div id="app"></div></body></html>');
    });
  } }],
});
let browser;
try {
  await mkdir(screenshots, { recursive: true });
  await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address !== "string");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.goto(`http://127.0.0.1:${address.port}/__git-workflow__`);
  await page.evaluate(async () => {
    await import("/scripts/fixtures/git-workflow-entry.js");
  });
  await page.waitForFunction(() => Boolean(window.gitWorkflowSmoke));
  const panel = page.locator("#git-panel-fixture");
  const message = panel.getByRole("textbox", { name: "Commit message", exact: true });
  const calls = () => page.evaluate(() => window.gitWorkflowSmoke.calls);
  async function reset(mode = "partial") {
    await page.evaluate((value) => window.gitWorkflowSmoke.reset(value), mode);
    await page.waitForFunction(() => document.querySelector("#git-commit-message")?.value === "");
  }

  // Flow 1: generated message describes staged files, never silently adds others.
  await reset();
  await panel.getByRole("button", { name: "Generate message", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#git-commit-message")?.value.startsWith("feat:"));
  await panel.getByRole("button", { name: "Commit & push", exact: true }).click();
  assert.deepEqual(await calls(), ["generate", "commit:feat: improve Git workflows", "push"]);
  assert.equal(await message.inputValue(), "");

  // Unstaged-only input gets an explicitly named stage-all action.
  await reset("unstaged");
  await panel.getByRole("button", { name: "Stage all & generate", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#git-commit-message")?.value.startsWith("feat:"));
  assert.deepEqual(await calls(), ["stage:all", "generate"]);
  await reset("unstaged");
  await page.evaluate(() => window.gitWorkflowSmoke.stageFails());
  await panel.getByRole("button", { name: "Stage all & generate", exact: true }).click();
  assert.deepEqual(await calls(), ["stage:all"]);

  // Flow 2: review does not stage/commit; generation and explicit submit follow it.
  await reset();
  await panel.getByRole("button", { name: "Code review", exact: true }).click();
  await page.getByRole("region", { name: "Code review checkpoint" }).waitFor();
  assert.deepEqual(await calls(), ["review:staged", "diff:staged"]);
  await panel.getByRole("button", { name: "Generate message", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#git-commit-message")?.value.startsWith("feat:"));
  await message.press("Control+Enter");
  assert((await calls()).includes("push"));

  // Flow 3: findings hand off to one fix action, without commit or push.
  await reset("unstaged");
  await panel.getByRole("button", { name: "Code review", exact: true }).click();
  await panel.getByRole("button", { name: "Fix in new session", exact: true }).click();
  assert.deepEqual(await calls(), ["review:all", "diff:all", "fix-session"]);
  await page.evaluate(() => window.gitWorkflowSmoke.staleReview());
  assert.equal(await panel.getByRole("button", { name: "Fix in new session", exact: true }).count(), 0);
  assert(await page.locator("main").getByRole("button", { name: "Fix in new session", exact: true }).isDisabled());

  // A slow generator cannot overwrite a manual edit. Failed push clears only the committed draft.
  await reset();
  await page.evaluate(() => window.gitWorkflowSmoke.delayGeneration());
  await panel.getByRole("button", { name: "Generate message", exact: true }).click();
  await message.fill("my own message");
  await page.evaluate(() => window.gitWorkflowSmoke.resolveGeneration());
  await panel.getByText("Your edited message was kept.", { exact: false }).waitFor();
  assert.equal(await message.inputValue(), "my own message");
  await page.evaluate(() => window.gitWorkflowSmoke.pushFails());
  await panel.getByRole("button", { name: "Commit & push", exact: true }).click();
  assert.equal(await message.inputValue(), "");
  assert(await panel.getByRole("alert").textContent().then((text) => text.includes("Retry Push")));
  assert(!(await panel.getByRole("button", { name: "Push", exact: true }).isDisabled()));

  // A draft tab can use the workspace assistant without a model session.
  await reset("no-session");
  assert(!(await panel.getByRole("button", { name: "Generate message", exact: true }).isDisabled()));
  await panel.getByRole("button", { name: "Generate message", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#git-commit-message")?.value.startsWith("feat:"));
  assert.deepEqual(await calls(), ["generate"]);
  await page.screenshot({ path: `${screenshots}/draft-tab-generation.png`, fullPage: true });

  // A disconnected assistant still leaves ordinary local commits available.
  await reset("disconnected");
  assert(await panel.getByRole("button", { name: "Generate message", exact: true }).isDisabled());
  await message.fill("manual commit");
  await message.press("Control+Shift+Enter");
  assert.deepEqual(await calls(), ["commit:manual commit"]);
  await reset("no-remote");
  await message.fill("local only");
  assert(await panel.getByRole("button", { name: "Commit & push", exact: true }).isDisabled());
  assert(!(await panel.getByRole("button", { name: "Commit", exact: true }).isDisabled()));
  await reset("conflict");
  await message.fill("must not commit conflicts");
  assert(await panel.getByRole("button", { name: "Commit", exact: true }).isDisabled());

  // Completion must not steal the Diff view from somebody inspecting it.
  await reset();
  await page.evaluate(() => window.gitWorkflowSmoke.delayReview());
  await panel.getByRole("button", { name: "Code review", exact: true }).click();
  await page.locator("main").getByRole("button", { name: "Diff", exact: true }).click();
  await page.evaluate(() => window.gitWorkflowSmoke.resolveReview());
  await panel.getByRole("button", { name: "Fix in new session", exact: true }).waitFor();
  assert.equal(await page.locator("main").getByRole("button", { name: "Diff", exact: true }).getAttribute("aria-pressed"), "true");
  await page.locator("main").getByRole("button", { name: "Review", exact: true }).click();
  const reviewBox = await page.getByRole("region", { name: "LLM review", exact: true }).boundingBox();
  assert(reviewBox.height > 500, "review uses the full editor, not a 38% split");

  // Actual browser layout checks at the application's minimum sidebar width.
  await reset("many");
  await page.evaluate(() => window.gitWorkflowSmoke.setWidth(360));
  await message.fill("check colors and geometry");
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate(() => document.fonts.ready);
    const bounds = await panel.boundingBox();
    const footer = await panel.getByRole("region", { name: "Prepare and commit changes" }).boundingBox();
    assert(footer.y + footer.height <= 721 && footer.height < 300, "composer remains inside the viewport");
    for (const button of await panel.locator("button:visible").all()) {
      const box = await button.boundingBox();
      assert(box.x >= bounds.x - 1 && box.x + box.width <= bounds.x + bounds.width + 1, `button must fit ${await button.textContent()}`);
    }
    const primary = panel.getByRole("button", { name: "Commit & push", exact: true });
    const colors = await primary.evaluate((element) => {
      const computed = getComputedStyle(element);
      const probe = document.createElement("span");
      probe.style.cssText = "color:var(--primary-foreground);background-color:var(--primary)";
      element.append(probe);
      const expected = getComputedStyle(probe);
      const result = [computed.color, computed.backgroundColor, expected.color, expected.backgroundColor];
      probe.remove(); return result;
    });
    assert.equal(colors[0], colors[2], `${theme} primary foreground token`);
    assert.equal(colors[1], colors[3], `${theme} primary background token`);
    await page.screenshot({ path: `${screenshots}/${theme}-narrow.png` });
  }
  // Native disclosure and ordinary Git actions are keyboard reachable.
  await reset("clean");
  const tools = panel.locator("summary");
  await tools.focus(); await tools.press("Enter");
  await panel.getByRole("button", { name: "Fetch", exact: true }).click();
  await panel.getByRole("button", { name: "Pull (ff-only)", exact: true }).click();
  await panel.getByRole("button", { name: "Restore", exact: true }).click();
  assert.deepEqual(await calls(), ["fetch:all", "pull:all", "stash-apply:stash@{0}"]);
  assert.deepEqual(pageErrors, []);
  console.log("Git workflow browser smoke passed: 3 flows, staged scope, failures, draft race, keyboard, full-height review, 360px light/dark geometry and semantic colors.");
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await server.close();
}
