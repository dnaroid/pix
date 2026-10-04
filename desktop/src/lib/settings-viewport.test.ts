import { afterEach, describe, expect, it, vi } from "vitest";
import { settingsViewport } from "./settings-viewport";

// A small DOM port exercises the action's filtering/scheduling, not UI QA.
function harness() {
  let frame: FrameRequestCallback | undefined;
  let mutation: () => void = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => { frame = undefined; });
  vi.stubGlobal("MutationObserver", class {
    constructor(callback: () => void) { mutation = callback; }
    observe() {}
    disconnect = disconnect;
  });
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect = disconnect;
  });
  const notifications = { closest: () => null, hidden: false, dataset: { settingsField: "System notifications Send native notifications" } };
  const ignoreContext = { closest: () => null, hidden: false, dataset: { settingsField: "Ignore context files Do not discover AGENTS.md" } };
  const voice = { closest: () => null, hidden: false, dataset: { settingsField: "API key Speech service authentication" }, value: "secret-needle" };
  function section(id: string, title: string, rows: unknown[], top: number) {
    return { hidden: false, dataset: { settingsSection: id, settingsTitle: title }, querySelectorAll: () => rows, getBoundingClientRect: () => ({ top }) };
  }
  const sections = [section("general", "General", [notifications, ignoreContext], 20), section("voice", "Voice", [voice], 200)];
  const config = { hidden: false, querySelectorAll: () => sections };
  const listeners = new Map<string, () => void>();
  const node = {
    scrollTop: 30, scrollHeight: 800, clientHeight: 400,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: vi.fn((selector: string) => selector === "[data-settings-section]" ? sections : selector === "[data-settings-config]" ? [config] : []),
    addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
    removeEventListener: (name: string) => listeners.delete(name),
  };
  const onChange = vi.fn();
  const action = settingsViewport(node as unknown as HTMLElement, { query: "", onChange });
  function flush() { const callback = frame; frame = undefined; callback?.(0); }
  return { action, node, sections, config, notifications, ignoreContext, voice, onChange, disconnect, flush, mutation: () => mutation(), scroll: () => listeners.get("scroll")?.() };
}

afterEach(() => vi.unstubAllGlobals());

describe("settings viewport lifecycle", () => {
  it("filters rows/empty chapters, ignores secret values and restores the same mounted controls", () => {
    const h = harness();
    h.flush();
    expect(h.onChange).toHaveBeenLastCalledWith(["general", "voice"], "general");
    h.action.update({ query: "native", onChange: h.onChange });
    h.flush();
    expect(h.node.scrollTop).toBe(0);
    expect(h.notifications.hidden).toBe(false);
    expect(h.ignoreContext.hidden).toBe(true);
    expect(h.sections[1]!.hidden).toBe(true);
    expect(h.onChange).toHaveBeenLastCalledWith(["general"], "general");
    h.action.update({ query: "secret-needle", onChange: h.onChange });
    h.flush();
    expect(h.config.hidden).toBe(true);
    expect(h.onChange).toHaveBeenLastCalledWith([], "");
    h.action.update({ query: "", onChange: h.onChange });
    h.flush();
    expect(h.config.hidden).toBe(false);
    expect(h.voice.hidden).toBe(false);
    expect(h.voice.value).toBe("secret-needle");
    h.action.destroy();
  });

  it("does not refilter fields on scrolling and cancels callbacks at teardown", () => {
    const h = harness();
    h.flush();
    h.node.querySelectorAll.mockClear();
    h.scroll();
    h.flush();
    expect(h.node.querySelectorAll).not.toHaveBeenCalledWith("[data-settings-section]");
    const calls = h.onChange.mock.calls.length;
    h.mutation();
    h.action.destroy();
    h.flush();
    h.mutation();
    h.flush();
    expect(h.disconnect).toHaveBeenCalledTimes(2);
    expect(h.onChange).toHaveBeenCalledTimes(calls);
  });
});
