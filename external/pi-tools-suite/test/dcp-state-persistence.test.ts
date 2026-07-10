import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createState, restoreState } from "../src/dcp/state.js";
import {
  cleanupStaleDcpStateFiles,
  loadDcpState,
  resetDcpPersistenceDedup,
  resolveDcpStatePath,
  saveDcpState,
} from "../src/dcp/state-persistence.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  resetDcpPersistenceDedup();
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dcp-state-persistence-"));
  tempDirs.push(dir);
  return dir;
}

function fakeContext(sessionDir: string, sessionId = "session-1"): ExtensionContext {
  return {
    cwd: "/tmp/dcp-project",
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionDir: () => sessionDir,
    },
  } as unknown as ExtensionContext;
}

describe("DCP sidecar state persistence", () => {
  test("saves state to a session-id sidecar file with overwrite semantics", async () => {
    const sessionDir = await makeTempDir();
    const ctx = fakeContext(sessionDir, "session:with/slashes");
    const state = createState();

    state.tokensSaved = 10;
    await saveDcpState(ctx, state);
    const statePath = resolveDcpStatePath(ctx)!;
    expect(statePath).toBe(join(sessionDir, "dcp-state", "session_with_slashes.json"));

    const first = await readFile(statePath, "utf8");
    expect(JSON.parse(first).tokensSaved).toBe(10);

    state.tokensSaved = 25;
    await saveDcpState(ctx, state);

    const lines = (await readFile(statePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).tokensSaved).toBe(25);
  });

  test("loads sidecar state and can restore it into runtime state", async () => {
    const sessionDir = await makeTempDir();
    const ctx = fakeContext(sessionDir, "session-2");
    const state = createState();
    state.manualMode = true;
    state.nudgeCounter = 7;
    state.consecutiveIgnoredStrongNudges = 3;
    state.toolCalls.set("provider-seen", {
      toolCallId: "provider-seen",
      toolName: "read",
      inputArgs: { path: "/tmp/example" },
      inputFingerprint: "read::provider-seen",
      isError: false,
      turnIndex: 1,
      timestamp: 1,
      tokenEstimate: 100,
    });
    state.providerSeenToolIds.add("provider-seen");

    await saveDcpState(ctx, state);

    const restored = createState();
    restoreState(restored, await loadDcpState(ctx));

    expect(restored.manualMode).toBe(true);
    expect(restored.nudgeCounter).toBe(7);
    expect(restored.consecutiveIgnoredStrongNudges).toBe(3);
    expect(restored.providerSeenToolIds).toEqual(new Set(["provider-seen"]));
  });

  test("returns undefined when the sidecar file does not exist", async () => {
    const sessionDir = await makeTempDir();
    await mkdir(join(sessionDir, "dcp-state"), { recursive: true });

    await expect(loadDcpState(fakeContext(sessionDir, "missing"))).resolves.toBeUndefined();
  });

  test("deletes sidecar files for sessions that no longer exist", async () => {
    const sessionDir = await makeTempDir();
    await writeFile(
      join(sessionDir, "2026-01-01T00-00-00-000Z_live-session.jsonl"),
      JSON.stringify({
        type: "session",
        version: 3,
        id: "live-session",
        timestamp: new Date().toISOString(),
        cwd: "/tmp/dcp-project",
      }) + "\n",
      "utf8",
    );
    const state = createState();

    await saveDcpState(fakeContext(sessionDir, "stale-session"), state);
    resetDcpPersistenceDedup();
    await saveDcpState(fakeContext(sessionDir, "live-session"), state);

    const stalePath = resolveDcpStatePath(fakeContext(sessionDir, "stale-session"))!;
    const livePath = resolveDcpStatePath(fakeContext(sessionDir, "live-session"))!;

    await expect(readFile(stalePath, "utf8")).resolves.toBeTruthy();

    await expect(
      cleanupStaleDcpStateFiles(fakeContext(sessionDir, "live-session")),
    ).resolves.toBe(1);

    await expect(readFile(stalePath, "utf8")).rejects.toThrow();
    await expect(readFile(livePath, "utf8")).resolves.toBeTruthy();
  });

  test("deletes sidecar files older than seven days while keeping the current session", async () => {
    const sessionDir = await makeTempDir();
    for (const sessionId of ["old-live-session", "current-session"]) {
      await writeFile(
        join(sessionDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`),
        JSON.stringify({
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: new Date().toISOString(),
          cwd: "/tmp/dcp-project",
        }) + "\n",
        "utf8",
      );
    }

    const state = createState();
    await saveDcpState(fakeContext(sessionDir, "old-live-session"), state);
    resetDcpPersistenceDedup();
    await saveDcpState(fakeContext(sessionDir, "current-session"), state);

    const oldLivePath = resolveDcpStatePath(fakeContext(sessionDir, "old-live-session"))!;
    const currentPath = resolveDcpStatePath(fakeContext(sessionDir, "current-session"))!;
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(oldLivePath, oldDate, oldDate);
    await utimes(currentPath, oldDate, oldDate);

    await expect(
      cleanupStaleDcpStateFiles(fakeContext(sessionDir, "current-session")),
    ).resolves.toBe(1);

    await expect(readFile(oldLivePath, "utf8")).rejects.toThrow();
    await expect(readFile(currentPath, "utf8")).resolves.toBeTruthy();
  });
});
