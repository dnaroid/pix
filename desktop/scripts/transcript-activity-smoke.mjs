import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

// Exercise the real Svelte components and native details events with synthetic
// transcripts. All backend/attachment callbacks are stubbed; no Pi session runs.
const root = fileURLToPath(new URL("../", import.meta.url));
const fixtureId = "\0transcript-activity-smoke";
const server = await createServer({
  root, configFile: `${root}vite.config.ts`, logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [{
    name: "transcript-activity-smoke",
    resolveId(id) { if (id === "/__activity-fixture__.js") return fixtureId; },
    load(id) {
      if (id !== fixtureId) return;
      return `
        import { mount, tick } from "svelte";
        import TranscriptPane from "/src/components/TranscriptPane.svelte";
        import { createActiveSessionState } from "/src/app/active-session-state.svelte.ts";
        import { createSessionHistory } from "/src/app/session-history.svelte.ts";
        import { applySessionUpdate, emptyTranscript, finalizeTranscriptActivity } from "/src/lib/transcript.ts";
        import "/src/styles.css";
        let clockNow = 100;
        let nextTimerId = 0;
        const activityTimers = new Map();
        Date.now = () => clockNow;
        window.setInterval = callback => {
          const id = ++nextTimerId;
          activityTimers.set(id, callback);
          return id;
        };
        window.clearInterval = id => activityTimers.delete(id);
        const state = createActiveSessionState();
        const requests = [], pending = [], validations = [];
        const client = { toolResult: (sessionId, toolCallId) => {
          requests.push({ sessionId, toolCallId });
          return new Promise(resolve => pending.push({ toolCallId, resolve }));
        }};
        const history = createSessionHistory({ client: () => client, state, workspace: () => "/test",
          ensureRuntime: async () => {}, runtimeReady: () => true, scheduleScrollToLatest: () => {},
          recoverUnavailableSession: () => {}, reportError: error => { throw error; } });
        const validate = async path => { validations.push(path); return false; };
        const props = {
          get transcript() { return state.transcript; }, get activeSessionId() { return state.sessionId; },
          workspace: "/test", promptRunning: false, operationRunning: false, historyLoading: false,
          showScrollToBottom: false, onScroll: () => {}, onScrollToBottom: () => {},
          onLoadOlderHistory: async () => false, onChooseWorkspace: () => {},
          onOpenAttachment: () => {}, onPrepareAttachment: async () => {},
          onValidateProjectFile: validate, onValidateLocalFile: validate,
          onOpenProjectFile: () => {}, onResolveProjectMedia: async () => undefined,
          onOpenLocalFile: () => {}, onResolveLocalMedia: async () => undefined,
          onLoadToolResult: id => void history.loadDeferredToolResult(id), onUserMessageAction: () => {},
        };
        mount(TranscriptPane, { target: document.querySelector("#app"), props });
        window.activitySmoke = {
          requests, validations,
          get timerCount() { return activityTimers.size; },
          async advanceClock(milliseconds) {
            clockNow += milliseconds;
            for (const callback of [...activityTimers.values()]) callback();
            await tick();
          },
          async setSynthetic(sessionId, count = 400) {
            history.cancel(); state.setSessionId(sessionId);
            const items = Array.from({ length: count }, (_, i) => i % 2 === 0
              ? { type: "message", id: "thought:" + i, role: "thought", text: "HIDDENTHOUGHT" + i,
                  attachments: [], startedAtMs: i * 10, endedAtMs: i * 10 + 5 }
              : { type: "tool", id: "tool:" + i, toolCallId: "tool-" + i, name: "read", title: "Read",
                  kind: "read", status: "completed", content: "", attachments: [], diffs: [],
                  deferredResult: true, startedAtMs: i * 10, endedAtMs: i * 10 + 5 });
            state.setTranscript({ items }); await tick();
          },
          async finish(toolCallId, text) {
            const index = pending.findIndex(request => request.toolCallId === toolCallId);
            if (index < 0) throw new Error("No pending tool " + toolCallId);
            pending.splice(index, 1)[0].resolve({ sessionUpdate: "tool_call_update", toolCallId,
              status: "completed", content: [{ type: "content", content: { type: "text", text } }] });
            await tick(); await tick();
          },
          async startLive() {
            history.cancel(); state.setSessionId("live");
            state.setTranscript(applySessionUpdate(emptyTranscript, { sessionUpdate: "agent_thought_chunk",
              messageId: "live-thought", content: { type: "text", text: "LIVE_THOUGHT" } }, Date.now()));
            await tick();
          },
          async update(update) { state.setTranscript(applySessionUpdate(state.transcript, update, Date.now())); await tick(); },
          async settle() { state.setTranscript(finalizeTranscriptActivity(state.transcript, Date.now())); await tick(); },
        };
      `;
    },
    configureServer(vite) {
      vite.middlewares.use("/__activity-test__", (_request, response) => {
        response.setHeader("Content-Type", "text/html");
        response.end('<!doctype html><html><head><title>Activity smoke</title></head><body><div id="app" style="height:100vh;display:grid"></div><script type="module" src="/__activity-fixture__.js"></script></body></html>');
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
  const page = await browser.newPage({ viewport: { width: 900, height: 700 }, colorScheme: "dark" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/__activity-test__`);
  await page.waitForFunction(() => !!window.activitySmoke);
  await page.evaluate(() => window.activitySmoke.setSynthetic("session-a"));

  const outer = page.locator("details[data-transcript-entry-id]");
  const outerSummary = outer.locator(":scope > summary");
  assert.equal(await outer.count(), 1);
  assert.equal(await page.locator("[data-activity-entry-id]").count(), 0, "collapsed groups must not mount child rows");
  assert.equal(await page.locator(".tool-result").count(), 0);
  assert.deepEqual(await page.evaluate(() => window.activitySmoke.requests), []);
  assert.equal(await page.evaluate(() => document.body.textContent.includes("HIDDENTHOUGHT0")), false);

  await outerSummary.click();
  await page.waitForFunction(() => document.querySelectorAll("[data-activity-entry-id]").length === 400);
  assert.deepEqual(await page.evaluate(() => window.activitySmoke.requests), [], "opening a group must not fetch all tool bodies");
  assert.equal(await page.evaluate(() => document.body.textContent.includes("HIDDENTHOUGHT0")), false);

  const toolSummary = page.locator('[data-activity-entry-id="tool:1"] summary');
  await toolSummary.click();
  await page.waitForFunction(() => window.activitySmoke.requests.length === 1);
  await toolSummary.click();
  await toolSummary.click();
  assert.equal(await page.evaluate(() => window.activitySmoke.requests.length), 1, "repeat open must coalesce in-flight loads");

  await outerSummary.click();
  await page.waitForFunction(() => document.querySelectorAll("[data-activity-entry-id]").length === 0);
  await page.evaluate(() => window.activitySmoke.finish("tool-1", "HYDRATED_BODY"));
  assert.equal(await page.locator(".tool-result").count(), 0, "late result must not mount a collapsed body");
  await outerSummary.click();
  await page.waitForFunction(() => document.body.textContent.includes("HYDRATED_BODY"));
  assert.equal(await page.evaluate(() => window.activitySmoke.requests.length), 1, "hydrated result is reused");

  await page.locator('[data-activity-entry-id="thought:0"] > summary').click();
  await page.waitForFunction(() => document.body.textContent.includes("HIDDENTHOUGHT0"));
  await page.locator('[data-activity-entry-id="tool:3"] summary').click();
  await page.waitForFunction(() => window.activitySmoke.requests.length === 2);
  await page.evaluate(() => window.activitySmoke.setSynthetic("session-b"));
  assert.equal(await outer.evaluate(node => node.open), false, "same row IDs in another session must reset disclosure ownership");
  await page.evaluate(() => window.activitySmoke.finish("tool-3", "STALE_SESSION_BODY"));
  assert.equal(await page.evaluate(() => document.body.textContent.includes("STALE_SESSION_BODY")), false);
  assert.equal(await page.locator("[data-activity-entry-id]").count(), 0);

  const inactiveTimerCount = await page.evaluate(() => window.activitySmoke.timerCount);
  await page.evaluate(() => window.activitySmoke.startLive());
  assert.equal(await page.locator('[data-activity-name="thinking"]').getAttribute("data-activity-active"), "true");
  assert.equal(await page.locator("[data-activity-duration]").textContent(), "<0.1s");
  assert.equal(await page.evaluate(() => window.activitySmoke.timerCount), inactiveTimerCount + 1, "one pane clock serves live groups");
  await page.evaluate(() => window.activitySmoke.advanceClock(1_300));
  assert.equal(await page.locator("[data-activity-duration]").textContent(), "1.3s");
  await page.evaluate(() => window.activitySmoke.update({ sessionUpdate: "tool_call", toolCallId: "running-read",
    name: "read", title: "Read", status: "in_progress" }));
  assert.equal(await page.locator('[data-activity-name="thinking"]').getAttribute("data-activity-active"), "false");
  assert.equal(await page.locator('[data-activity-name="read"]').getAttribute("data-activity-active"), "true");
  assert.equal(await outer.count(), 1);
  await page.evaluate(() => window.activitySmoke.advanceClock(700));
  assert.equal(await page.locator("[data-activity-duration]").textContent(), "2.0s");
  await page.evaluate(async () => {
    await window.activitySmoke.update({ sessionUpdate: "tool_call_update", toolCallId: "running-read", status: "completed" });
    await window.activitySmoke.settle();
  });
  assert.equal(await page.locator('[data-activity-active="true"]').count(), 0);
  assert.equal(await page.locator("[data-activity-duration]").textContent(), "2.0s");
  assert.equal(await page.evaluate(() => window.activitySmoke.timerCount), inactiveTimerCount, "settled activity clears the pane clock");
  await page.evaluate(() => window.activitySmoke.advanceClock(10_000));
  assert.equal(await page.locator("[data-activity-duration]").textContent(), "2.0s", "final duration does not advance");

  await outerSummary.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("details[data-transcript-entry-id]").open);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.querySelector("details[data-transcript-entry-id]").open);

  const stress = await page.evaluate(async () => {
    const start = performance.now();
    await window.activitySmoke.setSynthetic("stress", 10000);
    return { entries: 10000, updateMs: Number((performance.now() - start).toFixed(2)),
      mountedActivityRows: document.querySelectorAll("[data-activity-entry-id]").length,
      mountedElements: document.querySelectorAll("#app *").length };
  });
  assert.equal(stress.mountedActivityRows, 0);
  assert(stress.mountedElements < 80, "collapsed DOM size must not grow with tool count");
  assert.equal(await page.evaluate(() => window.activitySmoke.requests.length), 2);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: "passed", scenarios: ["lazy DOM", "per-tool hydration", "duplicate toggles",
    "late result after collapse", "session replacement", "live highlights and duration", "duration freeze and timer teardown",
    "keyboard disclosure", "large collapsed history"], stress }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
