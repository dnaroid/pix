import { describe, expect, it, vi } from "vitest";
import { createClaudeLoginController } from "./claude-login-controller.svelte";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(source = "{}") {
  const options = { readConfig: vi.fn(async () => source), openTerminal: vi.fn(async (_command: string) => {}), reportError: vi.fn() };
  return { ...options, controller: createClaudeLoginController(options) };
}

const named = JSON.stringify({ claudeCodeProvider: { selectedAccount: "Work", accounts: [{ name: "Work", configDir: "~/.work" }] } });

describe("Claude login action lifecycle", () => {
  it("launches default login only on explicit action, without retrying a model request", async () => {
    const f = fixture();
    expect(f.readConfig).not.toHaveBeenCalled();
    await f.controller.login();
    expect(f.openTerminal).toHaveBeenCalledExactlyOnceWith('"${PI_CLAUDE_CODE_PROVIDER_PATH:-claude}" auth login --claudeai');
    expect(f.controller.busy).toBe(false);
  });

  it("asks for profile confirmation and rereads the path before launch", async () => {
    const f = fixture(named);
    await f.controller.login();
    expect(f.controller.selected).toBe("Work");
    expect(f.openTerminal).not.toHaveBeenCalled();
    f.readConfig.mockResolvedValue(named.replace("~/.work", "~/.updated"));
    await f.controller.login();
    expect(f.openTerminal).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('CLAUDE_CONFIG_DIR="$HOME/.updated"'));
    expect(f.readConfig).toHaveBeenCalledTimes(2);
  });

  it("supports explicit default selection even with named profiles", async () => {
    const f = fixture(named);
    await f.controller.login();
    f.controller.select("");
    await f.controller.login();
    expect(f.openTerminal.mock.calls[0]?.[0]).not.toContain("CLAUDE_CONFIG_DIR=");
  });

  it("does not silently log into default after a selected account is removed", async () => {
    const f = fixture(named);
    await f.controller.login();
    f.readConfig.mockResolvedValue("{}");
    await f.controller.login();
    expect(f.openTerminal).not.toHaveBeenCalled();
    expect(f.controller.error).toContain("profiles changed");
    expect(f.controller.selected).toBe("");
    expect(f.reportError).toHaveBeenCalledOnce();
  });

  it("single-flights reads and terminal launches", async () => {
    const f = fixture();
    const read = deferred<string>();
    const opened = deferred<void>();
    f.readConfig.mockReturnValue(read.promise);
    f.openTerminal.mockReturnValue(opened.promise);
    const first = f.controller.login();
    await f.controller.login();
    expect(f.readConfig).toHaveBeenCalledOnce();
    read.resolve("{}");
    await Promise.resolve();
    await f.controller.login();
    expect(f.openTerminal).toHaveBeenCalledOnce();
    opened.resolve();
    await first;
    expect(f.controller.busy).toBe(false);
  });

  it("never launches after teardown while config is loading", async () => {
    const f = fixture();
    const read = deferred<string>();
    f.readConfig.mockReturnValue(read.promise);
    const action = f.controller.login();
    f.controller.dispose();
    read.resolve("{}");
    await action;
    expect(f.openTerminal).not.toHaveBeenCalled();
    await f.controller.login();
    expect(f.readConfig).toHaveBeenCalledOnce();
  });

  it("reports failures without leaking config paths and permits retry", async () => {
    const f = fixture();
    f.readConfig.mockRejectedValueOnce(new Error("private path/identity"));
    await f.controller.login();
    expect(f.controller.error).toContain("Could not start");
    expect(f.reportError.mock.calls[0]?.[0].message).not.toContain("private");
    expect(f.openTerminal).not.toHaveBeenCalled();
    f.openTerminal.mockRejectedValueOnce(new Error("failed terminal"));
    await f.controller.login();
    expect(f.reportError).toHaveBeenCalledTimes(2);
    await f.controller.login();
    expect(f.controller.error).toBe("");
  });
});
