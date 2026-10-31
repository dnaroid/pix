import { beforeEach, describe, expect, it, vi } from "vitest";
import { nativeContextMenuItems } from "./native-context-menu";
import type { DesktopContextTarget } from "./desktop-context-target";
import type { SelectionAssistTarget } from "./selection-assist-target";
import { createSelectionAssistStore } from "../app/selection-assist.svelte";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/menu", () => ({ Menu: { new: vi.fn() } }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

const anchor = { left: 0, top: 0, bottom: 0 };
const explain: SelectionAssistTarget = { action: "explain", text: "x()", context: "a\nx()", path: "src/a.ts", anchor };
const translate: SelectionAssistTarget = { action: "translate", text: "Hello", anchor };

function context(assist?: SelectionAssistTarget): DesktopContextTarget {
  return { kind: "selection", element: { isConnected: true } as HTMLElement, editor: null, hasSelection: true, readOnly: true, ...(assist ? { assist } : {}) };
}

describe("selection assist context menu", () => {
  beforeEach(() => vi.clearAllMocks());

  it("adds Explain Code / Translate only when a target and handler exist", () => {
    const handler = vi.fn();
    const text = (assist?: SelectionAssistTarget, h?: typeof handler) =>
      nativeContextMenuItems(context(assist), false, vi.fn(), () => true, undefined, null, undefined, h)
        .map((item) => ("text" in item ? item.text : "item" in item ? item.item : ""));
    expect(text(explain, handler)).toContain("Explain Code");
    expect(text(translate, handler)).toContain("Translate");
    expect(text(undefined, handler)).not.toContain("Translate");
    expect(text(translate)).not.toContain("Translate");
  });

  it("runs the captured target and skips stale menus", async () => {
    const handler = vi.fn();
    let active = true;
    const item = nativeContextMenuItems(context(translate), false, vi.fn(), () => active, undefined, null, undefined, handler)
      .find((entry) => "id" in entry && entry.id === "desktop.selection.translate") as unknown as { action: () => void };
    active = false;
    item.action();
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
    active = true;
    item.action();
    await Promise.resolve();
    expect(handler).toHaveBeenCalledWith(translate);
  });
});

describe("selection assist store", () => {
  it("sends the request, ignores superseded answers and aborts on close", async () => {
    const resolvers: ((text: string) => void)[] = [];
    const signals: AbortSignal[] = [];
    const client = {
      selectionAssist: vi.fn((_request: unknown, signal: AbortSignal) => {
        signals.push(signal);
        return new Promise<string>((resolve) => resolvers.push(resolve));
      }),
    };
    const report = vi.fn();
    const store = createSelectionAssistStore({ client: () => client as never, workspace: () => "/w", report });
    const first = store.run(explain);
    expect(client.selectionAssist).toHaveBeenCalledWith({ cwd: "/w", action: "explain", text: "x()", context: "a\nx()", path: "src/a.ts" }, expect.any(AbortSignal), expect.any(Function));
    const second = store.run(translate);
    expect(signals[0]!.aborted).toBe(true);
    resolvers[0]!("stale");
    resolvers[1]!("Привет");
    await Promise.all([first, second]);
    expect(store.state).toMatchObject({ status: "done", result: "Привет", target: translate });
    store.close();
    expect(store.state.status).toBe("idle");
    expect(report).not.toHaveBeenCalled();
  });

  it("streams deltas, resets on fallback and ignores deltas after close", async () => {
    let push: ((delta: { text: string } | { reset: true }) => void) | undefined;
    let finish: ((text: string) => void) | undefined;
    const client = {
      selectionAssist: vi.fn((_request: unknown, _signal: AbortSignal, onDelta: typeof push) => {
        push = onDelta;
        return new Promise<string>((resolve) => { finish = resolve; });
      }),
    };
    const store = createSelectionAssistStore({ client: () => client as never, workspace: () => "/w", report: vi.fn() });
    const done = store.run(translate);
    expect(store.state.status).toBe("loading");
    push!({ text: "Пр" });
    expect(store.state).toMatchObject({ status: "streaming", result: "Пр" });
    push!({ reset: true });
    expect(store.state).toMatchObject({ status: "loading", result: "" });
    push!({ text: "При" });
    push!({ text: "вет" });
    expect(store.state.result).toBe("Привет");
    finish!("Привет");
    await done;
    expect(store.state.status).toBe("done");
    store.close();
    push!({ text: "late" });
    expect(store.state).toMatchObject({ status: "idle", result: "" });
  });

  it("reports failures and shows the error", async () => {
    const client = { selectionAssist: vi.fn().mockRejectedValue(new Error("no model")) };
    const report = vi.fn();
    const store = createSelectionAssistStore({ client: () => client as never, workspace: () => "/w", report });
    await store.run(translate);
    expect(store.state).toMatchObject({ status: "error", error: "no model" });
    expect(report).toHaveBeenCalledWith(expect.any(Error), "frontend:selection-assist:translate");
  });
});

