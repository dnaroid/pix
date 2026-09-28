import { beforeEach, describe, expect, it, vi } from "vitest";
import lifecycleServicesSource from "./desktop-lifecycle-services.ts?raw";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
import {
  RECENT_PROJECTS_STORAGE_KEY,
  WORKSPACE_STORAGE_KEY,
} from "../lib/recent-projects";
import { SESSION_TABS_STORAGE_KEY } from "../lib/session-tabs";
import { createProjectWorkspaceStore, restoreProjectWorkspace } from "./project-workspace.svelte";

beforeEach(() => tauri.invoke.mockReset());

describe("project workspace startup restore", () => {
  it("gives an encoded URL workspace precedence over stale localStorage", () => {
    const restored = restoreProjectWorkspace(
      "http://127.0.0.1:1420/?workspace=%2Fqa%2Fproject%20with%20spaces",
      {
        getItem(key) {
          if (key === WORKSPACE_STORAGE_KEY) return "/stale/project";
          if (key === RECENT_PROJECTS_STORAGE_KEY) return JSON.stringify(["/stale/project"]);
          return null;
        },
      },
    );

    expect(restored.workspace).toBe("/qa/project with spaces");
    expect(restored.recentProjects).toEqual(["/qa/project with spaces", "/stale/project"]);
  });

  it("preserves a valid URL workspace when localStorage is unavailable", () => {
    const restored = restoreProjectWorkspace("http://127.0.0.1:1420/?workspace=%2Fqa%2Fproject", {
      getItem() {
        throw new Error("storage disabled");
      },
    });

    expect(restored.workspace).toBe("/qa/project");
    expect(restored.recentProjects).toEqual(["/qa/project"]);
    expect(restored.activeSessionIds).toEqual(new Map());
    expect(restored.sessionTabIds).toEqual(new Map());
  });

  it("restores the Desktop-owned session-tab snapshot independently of the workspace URL", () => {
    const restored = restoreProjectWorkspace("http://127.0.0.1:1420/?workspace=%2Fqa%2Fproject", {
      getItem(key) {
        if (key === SESSION_TABS_STORAGE_KEY) {
          return JSON.stringify({ "/qa/project": ["session-b", "session-a"] });
        }
        return null;
      },
    });

    expect(restored.sessionTabIds).toEqual(new Map([
      ["/qa/project", ["session-b", "session-a"]],
    ]));
  });
});

describe("project color loading", () => {
  it("refreshes only the active project at startup, not every restored recent project", () => {
    expect(lifecycleServicesSource).toContain("refreshColors([options.workspace()])");
    expect(lifecycleServicesSource).not.toContain("refreshColors(\n      options.projectServices.workspace.recentProjects");
  });

  it("reads only the newly remembered project and loads other colors when explicitly requested", () => {
    vi.stubGlobal("localStorage", { setItem: vi.fn() });
    try {
      tauri.invoke.mockResolvedValue(undefined);
      const store = createProjectWorkspaceStore({ workspace: () => "/active", reportError: vi.fn() });
      store.remember("/inactive");
      expect(tauri.invoke).not.toHaveBeenCalled();
      tauri.invoke.mockClear();

      store.remember("/active");
      expect(tauri.invoke).toHaveBeenCalledTimes(1);
      expect(tauri.invoke).toHaveBeenCalledWith("read_project_file", {
        workspace: "/active", path: ".pi/workspace.jsonc",
      });

      store.refreshColors(store.recentProjects);
      expect(tauri.invoke).toHaveBeenCalledTimes(3);
      expect(tauri.invoke).toHaveBeenCalledWith("read_project_file", {
        workspace: "/inactive", path: ".pi/workspace.jsonc",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps cached recent colors when refreshing only the active project", async () => {
    vi.stubGlobal("localStorage", { setItem: vi.fn() });
    try {
      tauri.invoke.mockImplementation(async (_command: string, args?: { workspace: string }) =>
        args?.workspace === "/inactive" ? { content: '{"color":"#abc"}' } : undefined);
      const store = createProjectWorkspaceStore({ workspace: () => "/active", reportError: vi.fn() });
      store.remember("/inactive");
      store.refreshColors(store.recentProjects);
      await vi.waitFor(() => expect(store.projectColors.get("/inactive")).toBe("#abc"));

      store.remember("/active");
      expect(store.projectColors.get("/inactive")).toBe("#abc");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("remembering an inactive project does not cancel the active project's pending color", async () => {
    vi.stubGlobal("localStorage", { setItem: vi.fn() });
    try {
      let resolveActive!: (preview: { content: string }) => void;
      tauri.invoke.mockImplementation((command: string) => command === "read_project_file"
        ? new Promise((resolve) => { resolveActive = resolve; })
        : Promise.resolve(undefined));
      const store = createProjectWorkspaceStore({ workspace: () => "/active", reportError: vi.fn() });
      store.remember("/active");
      store.remember("/other-window");
      expect(tauri.invoke).toHaveBeenCalledWith("read_project_file", {
        workspace: "/active", path: ".pi/workspace.jsonc",
      });
      expect(tauri.invoke).not.toHaveBeenCalledWith("read_project_file", {
        workspace: "/other-window", path: ".pi/workspace.jsonc",
      });

      resolveActive({ content: '{"color":"#abc"}' });
      await vi.waitFor(() => expect(store.projectColors.get("/active")).toBe("#abc"));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not wait for color IO and discards a stale result after switching projects", async () => {
    vi.stubGlobal("localStorage", { setItem: vi.fn() });
    try {
      let resolveOld!: (preview: { content: string }) => void;
      tauri.invoke.mockImplementation((_command: string, args?: { workspace: string }) =>
        args?.workspace === "/inactive"
          ? new Promise((resolve) => { resolveOld = resolve; })
          : Promise.resolve({ content: '{"color":"#123"}' }));
      let workspace = "/inactive";
      const store = createProjectWorkspaceStore({ workspace: () => workspace, reportError: vi.fn() });
      store.remember("/inactive");
      expect(store.recentProjects).toEqual(["/inactive"]);

      workspace = "/active";
      store.remember("/active");
      expect(store.recentProjects).toEqual(["/active", "/inactive"]);
      await vi.waitFor(() => expect(store.projectColors.get("/active")).toBe("#123"));

      resolveOld({ content: '{"color":"#abc"}' });
      await Promise.resolve();
      expect(store.projectColors.get("/inactive")).toBeUndefined();
      expect(store.projectColors.get("/active")).toBe("#123");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not let a pre-save color read repaint the saved override", async () => {
    vi.stubGlobal("localStorage", { setItem: vi.fn() });
    try {
      let resolveOld!: (preview: { content: string }) => void;
      let reads = 0;
      tauri.invoke.mockImplementation((command: string) => {
        if (command === "read_project_file") {
          reads += 1;
          return reads === 1
            ? new Promise((resolve) => { resolveOld = resolve; })
            : Promise.resolve({ content: '{"color":"#abc"}' });
        }
        if (command === "project_file_exists") return Promise.resolve(false);
        if (command === "write_project_workspace_config_if_unchanged") {
          return Promise.resolve({ written: true, document: { content: '{"color":"#abc"}' } });
        }
        return Promise.resolve(undefined);
      });
      const store = createProjectWorkspaceStore({ workspace: () => "/active", reportError: vi.fn() });
      store.remember("/active");
      expect(await store.saveColor("#abc")).toBeUndefined();
      expect(store.projectColors.get("/active")).toBe("#abc");

      resolveOld({ content: '{"color":"#def"}' });
      await Promise.resolve();
      expect(store.projectColors.get("/active")).toBe("#abc");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
