import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { createMarkdownCodeCopyAction } from "./markdown-code-copy-action";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

// The action only needs this small DOM surface; clipboard/lifecycle tests run in Node.
class Element {
  children: Element[] = [];
  parent?: Element;
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  disabled = false;
  textContent = "";
  listener?: () => Promise<void>;
  append(child: Element) { this.children.push(child); child.parent = this; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  querySelectorAll() { return this.children; }
  contains(child: Element): boolean { return this.children.some((item) => item === child || item.contains(child)); }
  addEventListener(_name: string, listener: () => Promise<void>) { this.listener = listener; }
  removeEventListener() { this.listener = undefined; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
}

function setup(...sources: string[]) {
  const root = new Element();
  for (const source of sources) {
    const pre = new Element();
    pre.dataset.codeSource = source;
    root.append(pre);
  }
  const action = createMarkdownCodeCopyAction(() => undefined)(root as unknown as HTMLElement, "html");
  return { root, action };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(writeText).mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("document", { createElement: () => new Element() });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("fenced-code copy action", () => {
  it("copies raw multiline source per block, reports success and resets feedback", async () => {
    const { root, action } = setup('  <tag> & "quoted"\n\nlast\n', "second", "");
    await Promise.resolve();
    const buttons = root.children.map((pre) => pre.children[0]!);
    expect(buttons[0]!.attributes["aria-label"]).toBe("Copy code");
    for (const button of buttons) await button.listener!();
    expect(vi.mocked(writeText).mock.calls).toEqual([
      ['  <tag> & "quoted"\n\nlast\n'], ["second"], [""],
    ]);
    expect(buttons[0]!.children[0]!.textContent).toBe("Copied");
    await vi.advanceTimersByTimeAsync(2000);
    expect(buttons[0]!.children[0]!.textContent).toBe("");
    action.destroy();
  });

  it("shows clipboard errors and permits retry", async () => {
    const { root, action } = setup("code");
    await Promise.resolve();
    const button = root.children[0]!.children[0]!;
    vi.mocked(writeText).mockRejectedValueOnce(new Error("denied"));
    await button.listener!();
    expect(button.children[0]!.textContent).toBe("Copy failed");
    expect(button.disabled).toBe(false);
    await button.listener!();
    expect(button.children[0]!.textContent).toBe("Copied");
    action.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["update", "destroy"] as const)("ignores pending clipboard completion after %s", async (operation) => {
    let resolve!: () => void;
    vi.mocked(writeText).mockReturnValue(new Promise<void>((done) => { resolve = done; }));
    const { root, action } = setup("streaming code");
    await Promise.resolve();
    const oldButton = root.children[0]!.children[0]!;
    const pending = oldButton.listener!();
    expect(oldButton.disabled).toBe(true);
    await oldButton.listener!();
    expect(writeText).toHaveBeenCalledTimes(1);
    action[operation]();
    resolve();
    await pending;
    expect(oldButton.children[0]!.textContent).toBe("");
    expect(vi.getTimerCount()).toBe(0);
    action.destroy();
  });

  it("cancels scheduled hydration on teardown and coalesces repeated updates", async () => {
    const { root, action } = setup("code");
    action.update();
    action.update();
    await Promise.resolve();
    expect(root.children[0]!.children).toHaveLength(1);
    action.update();
    action.destroy();
    await Promise.resolve();
    expect(root.children[0]!.children).toHaveLength(0);
  });
});
