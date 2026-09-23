import { describe, expect, it } from "vitest";
import { launchCommandsFromWorkspaceConfig, workspaceConfigWithLaunchCommands } from "./project-launch-commands";

describe("workspace launch commands", () => {
  const dev = { id: "dev", name: "Dev", command: "npm run dev" };

  it("reads optional JSONC and retains unrelated settings and comments on update", () => {
    const source = '// project settings\n{\n  "color": "#abc",\n  "launchCommands": [],\n  "future": true\n}\n';
    const updated = workspaceConfigWithLaunchCommands(source, [dev]);
    expect(updated).toContain("// project settings");
    expect(updated).toContain('"color": "#abc"');
    expect(updated).toContain('"future": true');
    expect(launchCommandsFromWorkspaceConfig(updated)).toEqual([dev]);
    const removed = workspaceConfigWithLaunchCommands(updated, []);
    expect(launchCommandsFromWorkspaceConfig(removed)).toEqual([]);
    expect(launchCommandsFromWorkspaceConfig(undefined)).toEqual([]);
  });

  it("refuses to replace malformed configuration or an invalid existing field", () => {
    expect(() => workspaceConfigWithLaunchCommands("{oops", [dev])).toThrow("malformed");
    expect(() => workspaceConfigWithLaunchCommands('{"launchCommands":false}', [dev])).toThrow("invalid launchCommands");
    expect(() => workspaceConfigWithLaunchCommands('{"launchCommands":[{"id":"x"}]}', [dev])).toThrow("invalid launchCommands");
  });
});
