import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Api, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ClaudeAccountRotationState, parseClaudeAccountRotationConfig, type ClaudeAccount } from "../../src/claude-code-provider/src/account-rotation.ts";
import type { RateLimitNoticeSink } from "../../src/claude-code-provider/src/claude-protocol.ts";
import { createOutput } from "../../src/claude-code-provider/src/output.ts";
import { waitForRotationDelay } from "../../src/claude-code-provider/src/rotation-delay.ts";
import { createRotatingClaudeStream } from "../../src/claude-code-provider/src/rotating-stream.ts";

const accounts: ClaudeAccount[] = [
  { name: "personal", configDir: "/tmp/claude-personal" },
  { name: "work", configDir: "/tmp/claude-work" },
  { name: "other", configDir: "/tmp/claude-other" },
];
const rejected = { status: "rejected", rateLimitType: "five_hour", resetsAt: Date.now() + 120_000 } as const;
const installation = { executable: "/does-not-run/claude", version: "test", subscriptionType: "pro" as const };
const model = { provider: "pi-claude-code-provider", id: "sonnet", api: "pi-claude-code-provider-headless" } as Model<Api>;
const context = { messages: [] };

type ResultKind = "rejected" | "transport" | "partial" | "success";

function fakeAttempt(
  kind: (configDir: string) => ResultKind,
  launches: string[],
): (configDir: string, onNotice: RateLimitNoticeSink) => (typeof makeStream) {
  return (configDir, onNotice) => (chosenModel) => {
    launches.push(configDir);
    return makeStream(chosenModel, kind(configDir), onNotice);
  };
}

function makeStream(chosenModel: Model<Api>, kind: ResultKind, onNotice: RateLimitNoticeSink) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const output = createOutput(chosenModel);
    stream.push({ type: "start", partial: output });
    if (kind === "partial") {
      output.content.push({ type: "text", text: "partial" });
      stream.push({ type: "text_start", contentIndex: 0, partial: output });
    }
    if (kind === "rejected" || kind === "partial") onNotice(rejected);
    if (kind !== "success") {
      output.stopReason = "error";
      output.errorMessage = kind === "transport" ? "network down" : "quota exceeded";
      stream.push({ type: "error", reason: "error", error: output });
    } else {
      output.stopReason = "stop";
      stream.push({ type: "done", reason: "stop", message: output });
    }
    stream.end();
  });
  return stream;
}

async function eventsOf(stream: ReturnType<ReturnType<typeof createRotatingClaudeStream>>) {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("Claude subscription account rotation", () => {
  test("quota warnings are opt-in and require a boolean", () => {
    expect(parseClaudeAccountRotationConfig(undefined).showRateLimitWarnings === true).toBe(false);
    expect(parseClaudeAccountRotationConfig({}).showRateLimitWarnings === true).toBe(false);
    for (const value of [false, true]) {
      expect(parseClaudeAccountRotationConfig({ showRateLimitWarnings: value }).showRateLimitWarnings).toBe(value);
      expect(parseClaudeAccountRotationConfig({ accounts, showRateLimitWarnings: value }).showRateLimitWarnings).toBe(value);
    }
    for (const value of ["true", 1, null]) {
      expect(() => parseClaudeAccountRotationConfig({ showRateLimitWarnings: value })).toThrow(/showRateLimitWarnings/);
    }
  });
  test("parses only distinct named absolute or home-relative OAuth directories", () => {
    const value = parseClaudeAccountRotationConfig({ autoRotate: true, accounts: [
      { name: "Personal", configDir: "~/.claude-a" },
      { name: "Work", configDir: "/tmp/.claude-b" },
    ] }, "/my-home");
    // Node resolves rooted paths against the current drive on Windows.
    expect(value.accounts[0]?.configDir).toBe(resolve("/my-home", ".claude-a"));
    expect(value.accounts[1]?.configDir).toBe(resolve("/tmp/.claude-b"));
    expect(value.enabled).toBe(true);
    expect(value.rotationDelaySeconds).toBe(60);
    expect(parseClaudeAccountRotationConfig({ rotationDelaySeconds: 90 }).rotationDelaySeconds).toBe(90);
    for (const invalid of [-1, 301, 2.5, "60", null]) {
      expect(() => parseClaudeAccountRotationConfig({ rotationDelaySeconds: invalid })).toThrow(/rotationDelaySeconds/);
    }
    expect(parseClaudeAccountRotationConfig({ rotationDelaySeconds: 0 }).rotationDelaySeconds).toBe(0);
    expect(parseClaudeAccountRotationConfig({ autoRotate: false, selectedAccount: "work", accounts }).selectedAccount).toBe("work");
    expect(parseClaudeAccountRotationConfig({ autoRotate: false, selectedAccount: "removed", accounts }).selectedAccount).toBeUndefined();
    expect(() => parseClaudeAccountRotationConfig({ selectedAccount: 1 })).toThrow(/selectedAccount/);
    expect(() => parseClaudeAccountRotationConfig({ autoRotate: true, accounts: [value.accounts[0]] })).toThrow(/at least two/);
    expect(() => parseClaudeAccountRotationConfig({ autoRotate: true, accounts: [accounts[0], accounts[0]] })).toThrow(/duplicates/);
    expect(() => parseClaudeAccountRotationConfig({ autoRotate: false, accounts: [{ name: "Bad", configDir: "./relative" }] })).toThrow(/absolute/);
  });

  test("marks rejected profiles unavailable until reset, then allows them again", () => {
    const state = new ClaudeAccountRotationState();
    const now = 100_000;
    expect(state.choose(accounts, new Set(), now)?.name).toBe("personal");
    state.reject(accounts, accounts[0]!, { ...rejected, resetsAt: now + 5_000 }, now);
    expect(state.choose(accounts, new Set(), now)?.name).toBe("work");
    state.reject(accounts, accounts[1]!, { ...rejected, resetsAt: now + 5_000 }, now);
    state.reject(accounts, accounts[2]!, { ...rejected, resetsAt: now + 5_000 }, now);
    expect(state.choose(accounts, new Set(), now)).toBeUndefined();
    expect(state.nextReset(accounts, now)).toBe(now + 6_000);
    expect(state.choose(accounts, new Set(), now + 6_000)?.name).toBeDefined();
  });

  test("explicit account selection gets priority and intentionally overrides prior quota cooldown", () => {
    const state = new ClaudeAccountRotationState();
    const now = Date.now();
    state.reject(accounts, accounts[1]!, { ...rejected, resetsAt: now + 60_000 }, now);
    expect(state.choose(accounts, new Set(), now, "work")?.name).not.toBe("work");
    state.selectionChanged(accounts, "work");
    expect(state.choose(accounts, new Set(), now, "work")?.name).toBe("work");
    state.reject(accounts, accounts[1]!, { ...rejected, resetsAt: now + 60_000 }, now);
    state.selectionChanged(accounts, "work");
    expect(state.choose(accounts, new Set(), now, "work")?.name).not.toBe("work");
    state.selectionChanged(accounts, undefined);
    state.selectionChanged(accounts, "work");
    expect(state.choose(accounts, new Set(), now, "work")?.name).toBe("work");
  });

  test("manual selection works with auto-rotation disabled and never launches a second profile", async () => {
    const launches: string[] = [];
    const attempted: string[] = [];
    const stream = createRotatingClaudeStream(installation, {
      loadAccounts: () => ({ enabled: false, accounts, selectedAccount: "work" }),
      attemptStream: fakeAttempt(() => "transport", launches),
      onAccountAttempt: (name) => attempted.push(name),
    });
    const events = await eventsOf(stream(model, context));
    expect(launches).toEqual([accounts[1]?.configDir]);
    expect(attempted).toEqual(["work"]);
    expect(events.at(-1)?.type).toBe("error");
  });

  test("manual preferred profile is attempted first before bounded automatic failover", async () => {
    const launches: string[] = [];
    const attempted: string[] = [];
    const stream = createRotatingClaudeStream(installation, {
      loadAccounts: () => ({ enabled: true, accounts, rotationDelaySeconds: 0, selectedAccount: "work" }),
      rotationState: new ClaudeAccountRotationState(),
      attemptStream: fakeAttempt((dir) => dir === accounts[1]?.configDir ? "rejected" : "success", launches),
      onAccountAttempt: (name) => attempted.push(name),
    });
    const events = await eventsOf(stream(model, context));
    expect(launches).toEqual([accounts[1]?.configDir, accounts[2]?.configDir]);
    expect(attempted).toEqual(["work", "other"]);
    expect(events.at(-1)?.type).toBe("done");
  });

  test("retries the same request on a different profile without leaking the first start/error", async () => {
    const launches: string[] = [];
    const state = new ClaudeAccountRotationState();
    const stream = createRotatingClaudeStream(installation, {
      loadAccounts: () => ({ enabled: true, accounts, rotationDelaySeconds: 0 }), rotationState: state,
      attemptStream: fakeAttempt((dir) => dir === accounts[0]?.configDir ? "rejected" : "success", launches),
    });
    const events = await eventsOf(stream(model, context));
    expect(launches).toEqual([accounts[0]?.configDir, accounts[1]?.configDir]);
    expect(events.map((event) => event.type)).toEqual(["start", "done"]);
    expect(state.choose(accounts)?.name).toBe("work");
  });

  test("all profiles are tried at most once, then a single terminal failure is returned", async () => {
    const launches: string[] = [];
    const stream = createRotatingClaudeStream(installation, {
      loadAccounts: () => ({ enabled: true, accounts, rotationDelaySeconds: 0 }), rotationState: new ClaudeAccountRotationState(),
      attemptStream: fakeAttempt(() => "rejected", launches),
    });
    const events = await eventsOf(stream(model, context));
    expect(launches).toEqual(accounts.map((account) => account.configDir));
    expect(events.map((event) => event.type)).toEqual(["error"]);
    expect(events[0]?.type === "error" && events[0].error.errorMessage).toContain("exhausted (3/3 tried");
  });

  test.each(["transport", "partial"] as const)("never retries %s failures", async (kind) => {
    const launches: string[] = [];
    const stream = createRotatingClaudeStream(installation, {
      loadAccounts: () => ({ enabled: true, accounts, rotationDelaySeconds: 0 }), rotationState: new ClaudeAccountRotationState(),
      attemptStream: fakeAttempt(() => kind, launches),
    });
    const events = await eventsOf(stream(model, context));
    expect(launches).toEqual([accounts[0]?.configDir]);
    expect(events.at(-1)?.type).toBe("error");
    if (kind === "partial") expect(events.map((event) => event.type)).toEqual(["start", "text_start", "error"]);
  });

  test("previously exhausted profiles cause an immediate failure without another Claude launch", async () => {
    const state = new ClaudeAccountRotationState();
    const now = Date.now();
    for (const account of accounts) state.reject(accounts, account, { ...rejected, resetsAt: now + 90_000 }, now);
    const launches: string[] = [];
    const stream = createRotatingClaudeStream(installation, {
      loadAccounts: () => ({ enabled: true, accounts, rotationDelaySeconds: 0 }), rotationState: state,
      attemptStream: fakeAttempt(() => "success", launches),
    });
    const events = await eventsOf(stream(model, context));
    expect(launches).toHaveLength(0);
    expect(events[0]?.type === "error" && events[0].error.errorMessage).toContain("exhausted (0/3 tried");
  });

  test("pauses once per confirmed failover, and announces a switch only after the pause", async () => {
    const launches: string[] = [];
    const waits: number[] = [];
    const actions: string[] = [];
    const stream = createRotatingClaudeStream(installation, {
      loadAccounts: () => ({ enabled: true, accounts, rotationDelaySeconds: 45 }),
      rotationState: new ClaudeAccountRotationState(),
      waitBeforeRetry: async (ms) => { waits.push(ms); actions.push("wait"); return true; },
      onPause: (name, seconds) => actions.push(`pause ${name} ${seconds}s`),
      onSwitch: (from, to) => actions.push(`switch ${from}->${to}`),
      attemptStream: fakeAttempt((dir) => dir === accounts[2]!.configDir ? "success" : "rejected", launches),
    });
    const events = await eventsOf(stream(model, context));
    expect(launches).toEqual(accounts.map((account) => account.configDir));
    expect(waits).toEqual([45_000, 45_000]);
    expect(actions).toEqual([
      "pause personal 45s", "wait", "switch personal->work",
      "pause work 45s", "wait", "switch work->other",
    ]);
    expect(events.map((event) => event.type)).toEqual(["start", "done"]);
  });

  test("does not wait if no other profile can be tried", async () => {
    const state = new ClaudeAccountRotationState();
    state.reject(accounts, accounts[1]!, rejected);
    const launches: string[] = [];
    let waits = 0;
    const stream = createRotatingClaudeStream(installation, {
      loadAccounts: () => ({ enabled: true, accounts: accounts.slice(0, 2), rotationDelaySeconds: 60 }),
      rotationState: state,
      waitBeforeRetry: async () => { waits++; return true; },
      attemptStream: fakeAttempt(() => "rejected", launches),
    });
    const events = await eventsOf(stream(model, context));
    expect(launches).toEqual([accounts[0]?.configDir]);
    expect(waits).toBe(0);
    expect(events.map((event) => event.type)).toEqual(["error"]);
  });

  test("a cancellation during the pause aborts without launching another profile", async () => {
    const controller = new AbortController();
    const launches: string[] = [];
    const stream = createRotatingClaudeStream(installation, {
      loadAccounts: () => ({ enabled: true, accounts, rotationDelaySeconds: 60 }),
      rotationState: new ClaudeAccountRotationState(),
      waitBeforeRetry: (ms, signal) => {
        const waiting = waitForRotationDelay(ms, signal);
        controller.abort();
        return waiting;
      },
      attemptStream: fakeAttempt(() => "rejected", launches),
    });
    const events = await eventsOf(stream(model, context, { signal: controller.signal }));
    expect(launches).toEqual([accounts[0]?.configDir]);
    expect(events.map((event) => event.type)).toEqual(["error"]);
    expect(events[0]?.type === "error" && events[0].reason).toBe("aborted");
  });

  test("stops immediately if the pause cannot fit in the request timeout", async () => {
    const launches: string[] = [];
    let waits = 0;
    const stream = createRotatingClaudeStream(installation, {
      loadAccounts: () => ({ enabled: true, accounts, rotationDelaySeconds: 60 }),
      rotationState: new ClaudeAccountRotationState(),
      waitBeforeRetry: async () => { waits++; return true; },
      attemptStream: fakeAttempt(() => "rejected", launches),
    });
    const events = await eventsOf(stream(model, context, { timeoutMs: 1000 }));
    expect(launches).toEqual([accounts[0]?.configDir]);
    expect(waits).toBe(0);
    expect(events[0]?.type === "error" && events[0].error.errorMessage).toMatch(/pause exceeds.*timeout/);
  });

  test("reselects after the pause when another request exhausts the next profile", async () => {
    const state = new ClaudeAccountRotationState();
    const launches: string[] = [];
    const stream = createRotatingClaudeStream(installation, {
      loadAccounts: () => ({ enabled: true, accounts, rotationDelaySeconds: 30 }),
      rotationState: state,
      waitBeforeRetry: async () => {
        state.reject(accounts, accounts[1]!, rejected);
        return true;
      },
      attemptStream: fakeAttempt((dir) => dir === accounts[0]?.configDir ? "rejected" : "success", launches),
    });
    const events = await eventsOf(stream(model, context));
    expect(launches).toEqual([accounts[0]?.configDir, accounts[2]?.configDir]);
    expect(events.at(-1)?.type).toBe("done");
  });
});
