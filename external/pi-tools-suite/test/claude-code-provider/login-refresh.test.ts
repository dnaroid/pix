import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { createLoginRefresher, createLoginRefreshState, loginExpiryFromCredential } from "../../src/claude-code-provider/src/login-refresh.ts";
import { CLAUDE_TERMINATION_GRACE_MS, superviseProcess, terminateProcessGroup } from "../../src/claude-code-provider/src/process-utils.ts";

// No real Claude, Keychain or credentials: expiry and refresh are injected.
const NOW = 1_000_000;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

test("concurrent requests near expiry share exactly one refresh", async () => {
  const gate = deferred();
  let reads = 0;
  let refreshes = 0;
  const refresh = createLoginRefresher("claude", {
    state: createLoginRefreshState(),
    now: () => NOW,
    readExpiry: async () => { reads++; return NOW + 60_000; },
    runRefresh: async () => { refreshes++; await gate.promise; },
  });
  const waits = [refresh(), refresh(), refresh()];
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(refreshes, 1);
  gate.resolve();
  await Promise.all(waits);
  assert.equal(reads, 1);
  assert.equal(refreshes, 1);
});

test("a login outside Claude's refresh window launches nothing and is not reread", async () => {
  let reads = 0;
  let refreshes = 0;
  const refresh = createLoginRefresher("claude", {
    state: createLoginRefreshState(),
    now: () => NOW,
    readExpiry: async () => { reads++; return NOW + 3_600_000; },
    runRefresh: async () => { refreshes++; },
  });
  await refresh();
  await refresh();
  assert.equal(refreshes, 0);
  assert.equal(reads, 1);
});

test("an unknown expiry launches nothing", async () => {
  let refreshes = 0;
  const refresh = createLoginRefresher("claude", {
    state: createLoginRefreshState(), now: () => NOW,
    readExpiry: async () => undefined,
    runRefresh: async () => { refreshes++; },
  });
  await refresh();
  assert.equal(refreshes, 0);
});

test("an aborted caller stops waiting but never cancels the shared refresh", async () => {
  const gate = deferred();
  let finished = false;
  const refresh = createLoginRefresher("claude", {
    state: createLoginRefreshState(), now: () => NOW,
    readExpiry: async () => NOW,
    runRefresh: async () => { await gate.promise; finished = true; },
  });
  const controller = new AbortController();
  const aborted = refresh(controller.signal);
  const other = refresh();
  controller.abort();
  await aborted;
  assert.equal(finished, false);
  gate.resolve();
  await other;
  assert.equal(finished, true);
});

test("refresh failures are reported and never fail the request", async () => {
  const failures: unknown[] = [];
  const refresh = createLoginRefresher("claude", {
    state: createLoginRefreshState(), now: () => NOW,
    readExpiry: async () => NOW,
    runRefresh: async () => { throw new Error("refresh exploded"); },
    onFailure: (error) => failures.push(error),
  });
  await refresh();
  assert.equal(failures.length, 1);
});

test("a failed refresh is not relaunched or reread until the retry spacing elapses", async () => {
  let clock = NOW;
  let reads = 0;
  let refreshes = 0;
  const refresh = createLoginRefresher("claude", {
    state: createLoginRefreshState(), now: () => clock, retryMs: 60_000,
    readExpiry: async () => { reads++; return clock; },
    runRefresh: async () => { refreshes++; throw new Error("revoked"); },
  });
  await refresh();
  clock += 59_999;
  await refresh();
  await refresh();
  assert.equal(refreshes, 1);
  assert.equal(reads, 1);
  clock += 1;
  await refresh();
  assert.equal(refreshes, 2);
  assert.equal(reads, 2);
});

test("retry spacing is shared by every session of the process", async () => {
  const state = createLoginRefreshState();
  let refreshes = 0;
  const options = {
    state, now: () => NOW,
    readExpiry: async () => NOW,
    runRefresh: async () => { refreshes++; },
  };
  await createLoginRefresher("claude", options)();
  await createLoginRefresher("claude", options)();
  assert.equal(refreshes, 1);
});

test("credential expiry parsing never exposes tokens", () => {
  assert.equal(loginExpiryFromCredential(JSON.stringify({ claudeAiOauth: { accessToken: "secret", expiresAt: 42 } })), 42);
  assert.equal(loginExpiryFromCredential("not json"), undefined);
  assert.equal(loginExpiryFromCredential(JSON.stringify({ claudeAiOauth: { expiresAt: "soon" } })), undefined);
  assert.equal(loginExpiryFromCredential(undefined), undefined);
});

// The race behind revoked logins: Claude receives SIGTERM while its refreshed
// (rotated) token is not yet persisted. Claude waits up to 2 s on exit for that
// write; SIGKILL before then loses the only valid refresh token.
test("supervised termination lets an in-flight credential write finish before SIGKILL", async () => {
  assert.ok(CLAUDE_TERMINATION_GRACE_MS > 2_000);
  if (process.platform === "win32") return;
  const dir = await mkdtemp(join(tmpdir(), "claude-refresh-race-"));
  const stored = join(dir, "credentials.json");
  const body = `
    const fs = require("node:fs");
    process.on("SIGTERM", () => {
      // Simulate Claude's bounded exit wait for a refresh still being persisted.
      setTimeout(() => { fs.writeFileSync(${JSON.stringify(stored)}, "rotated"); process.exit(0); }, 1800);
    });
    process.send("ready");
    setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["-e", body], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const supervisor = superviseProcess(child, { idleTimeoutMs: 30_000, totalTimeoutMs: 30_000, onFailure() {} });
  try {
    await once(child, "message");
    await supervisor.terminate();
    const result = await supervisor.wait();
    assert.deepEqual(result.terminationSignals, ["SIGTERM"]);
    assert.equal(await readFile(stored, "utf8"), "rotated");
  } finally {
    supervisor.dispose();
    await terminateProcessGroup(child).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
