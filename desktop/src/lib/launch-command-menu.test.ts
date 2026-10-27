import { describe, expect, it, vi } from "vitest";
import { hasLaunchCommandMenu, launchCommandMenu } from "./launch-command-menu";

function fixture() {
  return {
    loading: false, startingScript: null, terminalActionId: null,
    launchRuntimes: {}, scriptRuntimes: {},
    launchCommands: [{ id: "dev", name: "Dev", command: "npm run dev" }],
    snapshot: undefined, terminals: [],
    isTerminalBusy: vi.fn(() => false),
    runLaunchCommand: vi.fn(async () => {}), launchScript: vi.fn(async () => {}), stopProcess: vi.fn(async () => {}),
  } satisfies Parameters<typeof launchCommandMenu>[0];
}

describe("Launch Commands activity menu", () => {
  it("offers start without any running terminals or health reasons", () => {
    const controller = fixture();
    const menu = launchCommandMenu(controller);
    expect(menu.groups[0]?.actions).toEqual([{ id: "scripts.command.launch:dev", label: "Run Dev", disabled: false }]);
    expect(menu.run("scripts.command.launch:dev")).toBe(true);
    expect(controller.runLaunchCommand).toHaveBeenCalledWith("dev");
    expect(menu.run("scripts.inspect")).toBe(false);
  });

  it("offers stop for each busy runtime, not an idle reusable shell", () => {
    const controller = fixture();
    const menu = launchCommandMenu({
      ...controller,
      launchRuntimes: { dev: { terminalId: "busy", state: "running" } },
      terminals: ["busy", "idle"].map((id) => ({ id, kind: "shell", launchCommandId: "dev", script: "shell", command: "sh", status: "running", output: "", outputBase64: "", startedAtMs: 1 })),
      isTerminalBusy: (terminal) => terminal.id === "busy",
    });
    expect(menu.groups[0]?.actions.map((action) => action.label)).toEqual(["Stop Dev"]);
    expect(menu.run("scripts.command.stop:busy")).toBe(true);
    expect(controller.stopProcess).toHaveBeenCalledWith("busy");
    expect(menu.run("scripts.command.stop:idle")).toBe(false);
  });

  it("keeps package and saved command identities distinct", () => {
    const controller = fixture();
    const script = { name: "dev", command: "vite" };
    const menu = launchCommandMenu({ ...controller, snapshot: {
      exists: true, packagePath: "/project/package.json", packageManager: "npm", scripts: [script],
    } });
    expect(menu.groups[0]?.actions.map((action) => action.id)).toEqual(["scripts.command.launch:dev", "scripts.command.package:dev"]);
    expect(menu.run("scripts.command.package:dev")).toBe(true);
    expect(controller.launchScript).toHaveBeenCalledWith(script);
  });

  it.each([{ loading: true }, { startingScript: "launch:dev" }, { terminalActionId: "pty" }])("disables mutations while the owner is busy: %j", (busy) => {
    const controller = fixture();
    const menu = launchCommandMenu({ ...controller, ...busy });
    expect(menu.groups[0]?.actions.every((action) => action.disabled)).toBe(true);
    expect(menu.run("scripts.command.launch:dev")).toBe(false);
    expect(controller.runLaunchCommand).not.toHaveBeenCalled();
  });

  it("has no command group when the project has no commands or busy terminals", () => {
    expect(launchCommandMenu({ ...fixture(), launchCommands: [] }).groups).toEqual([]);
  });

  it("never offers to stop unrelated interactive shells", () => {
    const controller = { ...fixture(), launchCommands: [],
      terminals: [{ id: "manual", kind: "shell" as const, script: "shell", command: "sh", status: "running" as const, output: "", outputBase64: "", startedAtMs: 1 }],
      isTerminalBusy: () => true,
    };
    expect(hasLaunchCommandMenu(controller)).toBe(false);
    expect(launchCommandMenu(controller).groups).toEqual([]);
    expect(launchCommandMenu(controller).run("scripts.command.stop:manual")).toBe(false);
    expect(controller.stopProcess).not.toHaveBeenCalled();
  });

  it("checks menu availability without building runtime maps", () => {
    const controller = { ...fixture(),
      get launchRuntimes(): never { throw new Error("should stay lazy"); },
      get scriptRuntimes(): never { throw new Error("should stay lazy"); },
    };
    expect(hasLaunchCommandMenu(controller)).toBe(true);
  });
});
