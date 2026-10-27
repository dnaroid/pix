import { invoke } from "@tauri-apps/api/core";
import { beforeEach, expect, it, vi } from "vitest";
import { commandHistoryFromWorkspaceConfig, mergeCommandHistory, persistCommandRun, workspaceConfigWithCommandRun } from "./project-command-history";
import { launchCommandsFromWorkspaceConfig } from "./project-launch-commands";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const send = vi.mocked(invoke);
beforeEach(() => send.mockReset());

it("stores timestamps alongside commands while retaining JSONC comments and other fields", () => {
  const command = { id: "dev", name: "Dev", command: "npm run dev" };
  const source = `// settings\n{ "color": "#abc", "launchCommands": ${JSON.stringify([command])}, }`;
  const saved = workspaceConfigWithCommandRun(source, "launch:dev", 123);
  expect(saved).toContain("// settings");
  expect(saved).toContain('"color": "#abc"');
  expect(launchCommandsFromWorkspaceConfig(saved)).toEqual([command]);
  expect(commandHistoryFromWorkspaceConfig(saved)).toEqual({ "launch:dev": 123 });
  expect(commandHistoryFromWorkspaceConfig(undefined)).toEqual({});
  expect(commandHistoryFromWorkspaceConfig(workspaceConfigWithCommandRun(undefined, "package:test", 100)))
    .toEqual({ "package:test": 100 });
});

it("rejects malformed documents and invalid history without overwriting them", () => {
  for (const source of ['{oops', '[]', '{"recentCommandRuns":[]}', '{"recentCommandRuns":{"package:test":-1}}',
    '{"recentCommandRuns":{"package:test":"yesterday"}}', '{"recentCommandRuns":{"wrong":123}}']) {
    expect(() => workspaceConfigWithCommandRun(source, "package:test", 100)).toThrow();
  }
});

it("merges out-of-order responses without demoting newer launches", () => {
  expect(mergeCommandHistory({ "package:a": 200 }, { "package:a": 100, "launch:b": 150 }))
    .toEqual({ "package:a": 200, "launch:b": 150 });
});

it("retries a conditional-write conflict against the latest settings and history", async () => {
  const newer = '// edited concurrently\n{"color":"#abc","recentCommandRuns":{"launch:other":200,"package:test":300}}';
  send.mockImplementation(async (command, args) => {
    if (command === "project_file_exists") return false;
    if (command === "write_project_workspace_config_if_unchanged") {
      const request = args as { expectedContent: string | null; content: string };
      if (request.expectedContent === null) return { written: false, document: { content: newer } };
      expect(request.expectedContent).toBe(newer);
      expect(request.content).toContain("// edited concurrently");
      expect(request.content).toMatch(/"color"\s*:\s*"#abc"/);
      return { written: true, document: { content: request.content } };
    }
  });
  expect(await persistCommandRun("/one", "package:test", 100)).toEqual({ "launch:other": 200, "package:test": 300 });
  expect(send.mock.calls.filter(([command]) => command === "write_project_workspace_config_if_unchanged")).toHaveLength(2);
});

it("logs a failed save for the original workspace without rejecting the successful launch", async () => {
  send.mockImplementation(async (command) => {
    if (command === "project_file_exists") throw new Error("disk unavailable");
  });
  expect(await persistCommandRun("/original", "package:test", 100)).toBeUndefined();
  await Promise.resolve();
  expect(send).toHaveBeenCalledWith("log_desktop_diagnostic", expect.objectContaining({
    workspace: "/original", event: "frontend:command-history-save", diagnostic: expect.stringContaining("disk unavailable"),
  }));
});

it("bounds retries when another writer keeps changing the file", async () => {
  send.mockImplementation(async (command) => {
    if (command === "project_file_exists") return false;
    if (command === "write_project_workspace_config_if_unchanged") return { written: false, document: null };
  });
  expect(await persistCommandRun("/one", "package:test", 100)).toBeUndefined();
  expect(send.mock.calls.filter(([command]) => command === "write_project_workspace_config_if_unchanged")).toHaveLength(3);
});
