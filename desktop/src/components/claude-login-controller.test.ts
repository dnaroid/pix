import { describe, expect, it, vi } from "vitest";
import { createClaudeLoginController } from "./claude-login-controller.svelte";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const options = { openTerminal: vi.fn(async (_command: string) => {}), reportError: vi.fn() };
  return { ...options, controller: createClaudeLoginController(options) };
}

describe("Claude login action lifecycle", () => {
  it("launches the default login only on explicit action, without retrying a model request", async () => {
    const f = fixture();
    expect(f.openTerminal).not.toHaveBeenCalled();
    await f.controller.login();
    expect(f.openTerminal).toHaveBeenCalledExactlyOnceWith('"${PI_CLAUDE_CODE_PROVIDER_PATH:-claude}" auth login --claudeai');
    expect(f.openTerminal.mock.calls[0]?.[0]).not.toContain("CLAUDE_CONFIG_DIR=");
    expect(f.controller.busy).toBe(false);
  });

  it("single-flights terminal launches", async () => {
    const f = fixture();
    const opened = deferred<void>();
    f.openTerminal.mockReturnValue(opened.promise);
    const first = f.controller.login();
    await f.controller.login();
    expect(f.openTerminal).toHaveBeenCalledOnce();
    opened.resolve();
    await first;
    expect(f.controller.busy).toBe(false);
  });

  it("never launches or reports after teardown", async () => {
    const f = fixture();
    f.controller.dispose();
    await f.controller.login();
    expect(f.openTerminal).not.toHaveBeenCalled();
    const g = fixture();
    const opened = deferred<void>();
    g.openTerminal.mockReturnValue(opened.promise);
    const action = g.controller.login();
    g.controller.dispose();
    opened.resolve();
    await action;
    expect(g.reportError).not.toHaveBeenCalled();
  });

  it("reports failures without leaking terminal details and permits retry", async () => {
    const f = fixture();
    f.openTerminal.mockRejectedValueOnce(new Error("private path/identity"));
    await f.controller.login();
    expect(f.controller.error).toContain("Could not start");
    expect(f.reportError.mock.calls[0]?.[0].message).not.toContain("private");
    await f.controller.login();
    expect(f.controller.error).toBe("");
    expect(f.openTerminal).toHaveBeenCalledTimes(2);
  });
});
