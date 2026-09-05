import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createState, restoreState } from "../src/dcp/state.js";
import {
  captureDcpPersistenceTarget,
  cleanupStaleDcpStateFiles,
  loadDcpState,
  readSessionIdFromFile,
  resetDcpPersistenceDedup,
  resolveDcpStatePath,
  saveDcpState,
  saveDcpStateToTarget,
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

async function readEnvelope(statePath: string): Promise<any> {
  return JSON.parse(await readFile(statePath, "utf8"));
}

async function readPersistedPayload(statePath: string): Promise<any> {
  const doc = await readEnvelope(statePath);
  return doc?.kind === "dcp-state" ? doc.payload : doc;
}

describe("DCP sidecar state persistence", () => {
  test("reads only the bounded header of a session file", async () => {
    const sessionDir = await makeTempDir();
    const sessionPath = join(sessionDir, "large-session.jsonl");
    await writeFile(
      sessionPath,
      `${JSON.stringify({ type: "session", id: "large-session" })}\n${"x".repeat(1024 * 1024)}`,
      "utf8",
    );

    await expect(readSessionIdFromFile(sessionPath)).resolves.toBe("large-session");
  });

  test("rejects a session header larger than the bounded read", async () => {
    const sessionDir = await makeTempDir();
    const sessionPath = join(sessionDir, "oversized-header.jsonl");
    await writeFile(sessionPath, `${"x".repeat(64 * 1024)}\n`, "utf8");

    await expect(readSessionIdFromFile(sessionPath)).resolves.toBeUndefined();
  });

  test("saves state to a session-id sidecar file with overwrite semantics", async () => {
    const sessionDir = await makeTempDir();
    const ctx = fakeContext(sessionDir, "session:with/slashes");
    const state = createState();

    state.tokensSaved = 10;
    await saveDcpState(ctx, state);
    const statePath = resolveDcpStatePath(ctx)!;
    expect(statePath).toBe(join(sessionDir, "dcp-state", "session_with_slashes.json"));

    const first = await readFile(statePath, "utf8");
    expect(JSON.parse(first).payload.tokensSaved).toBe(10);

    state.tokensSaved = 25;
    await saveDcpState(ctx, state);

    const lines = (await readFile(statePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).payload.tokensSaved).toBe(25);
  });

  test("serializes immutable bytes before enqueue and publishes through a private atomic file", async () => {
    const sessionDir = await makeTempDir();
    const ctx = fakeContext(sessionDir, "immutable-snapshot");
    const state = createState();
    state.tokensSaved = 10;

    const pendingSave = saveDcpState(ctx, state);
    state.tokensSaved = 999;
    await pendingSave;

    const statePath = resolveDcpStatePath(ctx)!;
    expect((await readPersistedPayload(statePath)).tokensSaved).toBe(10);
    const info = await stat(statePath);
    expect(info.mode & 0o777).toBe(0o600);
    expect((await readdir(join(sessionDir, "dcp-state"))).some((name) => name.includes(".tmp-"))).toBe(false);

    await saveDcpState(ctx, state);
    expect((await readPersistedPayload(statePath)).tokensSaved).toBe(999);
  });

  test("deduplicates persistence per sidecar path instead of across sessions", async () => {
    const sessionDir = await makeTempDir();
    const state = createState();
    state.tokensSaved = 42;
    const ctxA = fakeContext(sessionDir, "session-a");
    const ctxB = fakeContext(sessionDir, "session-b");

    await saveDcpState(ctxA, state);
    await saveDcpState(ctxB, state);

    const pathA = resolveDcpStatePath(ctxA)!;
    const pathB = resolveDcpStatePath(ctxB)!;
    expect((await readPersistedPayload(pathA)).tokensSaved).toBe(42);
    expect((await readPersistedPayload(pathB)).tokensSaved).toBe(42);
  });

  test("refuses last-writer-wins publication while another process owns the sidecar lock", async () => {
    const sessionDir = await makeTempDir();
    const ctx = fakeContext(sessionDir, "cross-process-session");
    const statePath = resolveDcpStatePath(ctx)!;
    await mkdir(join(sessionDir, "dcp-state"), { recursive: true });
    const lockPath = `${statePath}.lock`;
    const childCode = `
      const fs = require("node:fs");
      const lockPath = ${JSON.stringify(lockPath)};
      const fd = fs.openSync(lockPath, "wx", 0o600);
      process.stdout.write("locked\\n");
      const cleanup = () => { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(lockPath); } catch {} process.exit(0); };
      process.on("SIGTERM", cleanup);
      process.on("SIGINT", cleanup);
      setTimeout(cleanup, 10000);
    `;
    const child = spawn(process.execPath, ["-e", childCode], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("child lock timeout")), 3000);
      child.stdout!.once("data", (chunk) => {
        clearTimeout(timer);
        expect(String(chunk)).toContain("locked");
        resolve();
      });
      child.once("error", reject);
    });

    try {
      const state = createState();
      state.tokensSaved = 9;
      await expect(saveDcpState(ctx, state)).rejects.toThrow(/Concurrent DCP writer|last-writer-wins/i);
      await expect(readFile(statePath, "utf8")).rejects.toThrow();
    } finally {
      child.kill("SIGTERM");
      await once(child, "exit").catch(() => {});
    }
  });

  test("captured persistence targets do not follow a later session switch", async () => {
    const sessionDir = await makeTempDir();
    let sessionId = "session-a";
    const ctx = {
      cwd: "/tmp/dcp-project",
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionDir: () => sessionDir,
      },
    } as unknown as ExtensionContext;
    const targetA = captureDcpPersistenceTarget(ctx)!;
    sessionId = "session-b";
    const state = createState();
    state.tokensSaved = 77;

    await saveDcpStateToTarget(targetA, state);

    expect((await readPersistedPayload(join(sessionDir, "dcp-state", "session-a.json"))).tokensSaved).toBe(77);
    await expect(readFile(join(sessionDir, "dcp-state", "session-b.json"), "utf8")).rejects.toThrow();
  });

  test("loads sidecar state and can restore it into runtime state", async () => {
    const sessionDir = await makeTempDir();
    const ctx = fakeContext(sessionDir, "session-2");
    const state = createState();
    state.manualMode = true;
    state.nudgeCounter = 7;
    state.consecutiveIgnoredStrongNudges = 3;
    state.messageIdsByStableId.set("id:user-1", "m009");
    state.nextMessageId = 10;
    state.lastAutomaticPruneTurn = 6;
    state.lastAutomaticPruneBlockId = 2;
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
    expect(restored.messageIdsByStableId).toEqual(new Map([["id:user-1", "m009"]]));
    expect(restored.nextMessageId).toBe(10);
    expect(restored.lastAutomaticPruneTurn).toBe(6);
    expect(restored.lastAutomaticPruneBlockId).toBe(2);
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

  test("keeps paused live sidecars even when they are older than seven days", async () => {
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
    ).resolves.toBe(0);

    await expect(readFile(oldLivePath, "utf8")).resolves.toBeTruthy();
    await expect(readFile(currentPath, "utf8")).resolves.toBeTruthy();
  });

  test("writes a versioned envelope with monotonic generation and session identity", async () => {
    const sessionDir = await makeTempDir();
    const ctx = fakeContext(sessionDir, "generation-session");
    const state = createState();
    state.tokensSaved = 11;
    await saveDcpState(ctx, state);
    const statePath = resolveDcpStatePath(ctx)!;
    const first = await readEnvelope(statePath);
    expect(first.kind).toBe("dcp-state");
    expect(first.schemaVersion).toBe(1);
    expect(first.sessionId).toBe("generation-session");
    expect(first.generation).toBe(1);
    expect(first.revision).toBe(first.payloadHash);
    expect(first.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.payload.tokensSaved).toBe(11);

    state.tokensSaved = 12;
    await saveDcpState(ctx, state);
    const second = await readEnvelope(statePath);
    expect(second.generation).toBe(2);
    expect(second.payload.tokensSaved).toBe(12);
    const previous = await readEnvelope(`${statePath}.prev`);
    expect(previous.generation).toBe(1);
    expect(previous.payload.tokensSaved).toBe(11);
  });

  test("loads legacy flat sidecars through the migration adapter", async () => {
    const sessionDir = await makeTempDir();
    const ctx = fakeContext(sessionDir, "legacy-session");
    const state = createState();
    state.tokensSaved = 123;
    const { serializeState } = await import("../src/dcp/state.js");
    const statePath = resolveDcpStatePath(ctx)!;
    await mkdir(join(sessionDir, "dcp-state"), { recursive: true });
    await writeFile(statePath, JSON.stringify(serializeState(state)), "utf8");

    const loaded = await loadDcpState(ctx);
    expect(loaded?.tokensSaved).toBe(123);
  });

  test("loads an older legacy payload missing later accounting fields", async () => {
    const sessionDir = await makeTempDir();
    const ctx = fakeContext(sessionDir, "old-legacy-session");
    const statePath = resolveDcpStatePath(ctx)!;
    await mkdir(join(sessionDir, "dcp-state"), { recursive: true });
    const legacy = {
      compressionBlocks: [{
        id: 1,
        topic: "legacy block",
        summary: "legacy summary",
        startTimestamp: 1,
        endTimestamp: 2,
        anchorTimestamp: 3,
        active: true,
        summaryTokenEstimate: 5,
        createdAt: 1,
      }],
      prunedToolIds: ["old-pruned"],
      tokensSaved: 17,
      totalPruneCount: 2,
    };
    await writeFile(statePath, JSON.stringify(legacy), "utf8");

    const loaded = await loadDcpState(ctx);
    expect(loaded?.compressionBlocks).toHaveLength(1);
    const restored = createState();
    restoreState(restored, loaded);
    expect(restored.nextBlockId).toBe(2);
    expect(restored.tokensSaved).toBe(17);
    expect(restored.accountedCompressionBlockIds).toEqual(new Set([1]));
    expect(restored.accountedPrunedToolIds).toEqual(new Set(["old-pruned"]));
    expect(restored.manualMode).toBe(false);
  });

  test("quarantines a corrupt primary and recovers the last valid generation", async () => {
    const sessionDir = await makeTempDir();
    const ctx = fakeContext(sessionDir, "recover-session");
    const state = createState();
    state.tokensSaved = 10;
    await saveDcpState(ctx, state);
    state.tokensSaved = 20;
    await saveDcpState(ctx, state);
    const statePath = resolveDcpStatePath(ctx)!;

    await writeFile(statePath, "{corrupt", "utf8");
    resetDcpPersistenceDedup();
    const recovered = await loadDcpState(ctx);
    expect(recovered?.tokensSaved).toBe(10);
    const names = await readdir(join(sessionDir, "dcp-state"));
    expect(names.some((name) => name.startsWith("recover-session.json.corrupt-"))).toBe(true);

    const restored = createState();
    restoreState(restored, recovered);
    restored.tokensSaved = 15;
    await saveDcpState(ctx, restored);
    const repaired = await readEnvelope(statePath);
    expect(repaired.generation).toBe(2);
    expect(repaired.payload.tokensSaved).toBe(15);
  });

  test("does not overwrite unrecoverable corrupt state with an empty generation", async () => {
    const sessionDir = await makeTempDir();
    const ctx = fakeContext(sessionDir, "unrecoverable-session");
    const statePath = resolveDcpStatePath(ctx)!;
    await mkdir(join(sessionDir, "dcp-state"), { recursive: true });
    await writeFile(statePath, "not-json", "utf8");

    await expect(loadDcpState(ctx)).resolves.toBeUndefined();
    const fresh = createState();
    await expect(saveDcpState(ctx, fresh)).rejects.toThrow(/recovery is blocked|unrecovered generation/i);
    const names = await readdir(join(sessionDir, "dcp-state"));
    expect(names.some((name) => name.startsWith("unrecoverable-session.json.corrupt-"))).toBe(true);
  });

  test("rejects an envelope owned by a different session identity", async () => {
    const sessionDir = await makeTempDir();
    const ctx = fakeContext(sessionDir, "expected-session");
    const state = createState();
    await saveDcpState(ctx, state);
    const statePath = resolveDcpStatePath(ctx)!;
    const envelope = await readEnvelope(statePath);
    envelope.sessionId = "other-session";
    await writeFile(statePath, JSON.stringify(envelope), "utf8");
    await rm(`${statePath}.prev`, { force: true });
    resetDcpPersistenceDedup();

    await expect(loadDcpState(ctx)).resolves.toBeUndefined();
    const names = await readdir(join(sessionDir, "dcp-state"));
    expect(names.some((name) => name.startsWith("expected-session.json.corrupt-"))).toBe(true);
  });

  test("rejects cyclic compression block graphs before restore", async () => {
    const sessionDir = await makeTempDir();
    const ctx = fakeContext(sessionDir, "cycle-session");
    const state = createState();
    await saveDcpState(ctx, state);
    const statePath = resolveDcpStatePath(ctx)!;
    const envelope = await readEnvelope(statePath);
    envelope.payload.compressionBlocks = [
      {
        id: 1, topic: "one", summary: "one", startTimestamp: 1, endTimestamp: 2,
        anchorTimestamp: 3, active: true, summaryTokenEstimate: 1, createdAt: 1, coveredBlockIds: [2],
      },
      {
        id: 2, topic: "two", summary: "two", startTimestamp: 1, endTimestamp: 2,
        anchorTimestamp: 3, active: false, summaryTokenEstimate: 1, createdAt: 1, coveredBlockIds: [1],
      },
    ];
    envelope.payload.nextBlockId = 3;
    const payloadHash = createHash("sha256").update(JSON.stringify(envelope.payload)).digest("hex");
    envelope.payloadHash = payloadHash;
    envelope.revision = payloadHash;
    await writeFile(statePath, JSON.stringify(envelope), "utf8");
    await rm(`${statePath}.prev`, { force: true });
    resetDcpPersistenceDedup();

    await expect(loadDcpState(ctx)).resolves.toBeUndefined();
    const names = await readdir(join(sessionDir, "dcp-state"));
    expect(names.some((name) => name.startsWith("cycle-session.json.corrupt-"))).toBe(true);
  });

  test("fails cleanup closed when any session header cannot be verified", async () => {
    const sessionDir = await makeTempDir();
    await writeFile(join(sessionDir, "broken.jsonl"), "not-json\n", "utf8");
    const orphanCtx = fakeContext(sessionDir, "orphan-session");
    const state = createState();
    await saveDcpState(orphanCtx, state);
    const orphanPath = resolveDcpStatePath(orphanCtx)!;

    await expect(cleanupStaleDcpStateFiles(fakeContext(sessionDir, "current-session"))).resolves.toBe(0);
    await expect(readFile(orphanPath, "utf8")).resolves.toBeTruthy();
  });
});
