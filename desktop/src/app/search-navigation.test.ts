import { describe, expect, it, vi } from "vitest";
import type { SearchHit } from "../lib/universal-search";
import { createSearchNavigation, type SearchNavigationOptions } from "./search-navigation";

const session: SearchHit = { kind: "sessions", id: "session", sessionId: "session", title: "Session title", snippet: "Session title", score: 1 };
const file: SearchHit = { kind: "code", id: "f", path: "src/a.ts", title: "a", snippet: "", score: 1, startLine: 7, endLine: 9 };
const commit: SearchHit = {
  kind: "commits", id: "commits:0123456789abcdef0123456789abcdef01234567",
  hash: "0123456789abcdef0123456789abcdef01234567", title: "Fix issue", snippet: "", score: 1,
  commit: { hash: "0123456789abcdef0123456789abcdef01234567", shortHash: "01234567",
    subject: "Fix issue", author: "Contributor", date: "2026-10-08T16:00:00Z" },
};
function options(): SearchNavigationOptions {
  return {
    workspace: () => "/project", connection: () => "connection", activeSession: () => "session",
    openSetting: vi.fn(async () => {}), loadSession: vi.fn(async () => {}), activateSession: vi.fn(),
    taskExists: vi.fn(async () => true), openTask: vi.fn(async () => {}),
    hydrate: vi.fn(async () => {}), fileExists: vi.fn(async () => true), openFile: vi.fn(async () => {}),
    openCommit: vi.fn(async () => {}),
  };
}
describe("exact search navigation", () => {
  it("opens an exact commit diff instead of treating commit clicks as inert metadata", async () => {
    const api = options();
    await createSearchNavigation(api).open(commit);
    expect(api.openCommit).toHaveBeenCalledExactlyOnceWith(commit, expect.any(Function));
    expect(api.openFile).not.toHaveBeenCalled();
    expect(api.loadSession).not.toHaveBeenCalled();
  });
  it("invalidates pending commit navigation when scope, connection, cancellation or newer selection changes", async () => {
    for (const change of ["workspace", "connection", "cancel", "selection"] as const) {
      const api = options();
      const navigation = createSearchNavigation(api);
      let release!: () => void;
      const waiting = new Promise<void>(resolve => { release = resolve; });
      const reveal = vi.fn();
      api.openCommit = async (_hit, current) => {
        await waiting;
        if (current()) reveal();
      };
      const opening = navigation.open(commit);
      if (change === "workspace") api.workspace = () => "/elsewhere";
      if (change === "connection") api.connection = () => "replaced";
      if (change === "cancel") navigation.cancel();
      if (change === "selection") await navigation.open(file);
      release();
      await opening;
      expect(reveal).not.toHaveBeenCalled();
    }
  });
  it("reveals Tasks by stable ID without running a task or opening a session", async () => {
    const api = options();
    const hit: SearchHit = { kind: "tasks", id: "tasks:1", taskId: "1", title: "Task", snippet: "", score: 1 };
    await createSearchNavigation(api).open(hit);
    expect(api.taskExists).toHaveBeenCalledWith("1");
    expect(api.openTask).toHaveBeenCalledExactlyOnceWith("1", expect.any(Function));
    expect(api.loadSession).not.toHaveBeenCalled();
    api.taskExists = async () => false;
    await expect(createSearchNavigation(api).open(hit)).rejects.toThrow("no longer available");
  });
  it("does not reveal a task after workspace/client replacement or cancellation", async () => {
    for (const change of ["workspace", "connection", "cancel"]) {
      const api = options();
      const navigation = createSearchNavigation(api);
      api.taskExists = async () => {
        if (change === "workspace") api.workspace = () => "/other";
        if (change === "connection") api.connection = () => "other";
        if (change === "cancel") navigation.cancel();
        return true;
      };
      await navigation.open({ kind: "tasks", id: "tasks:1", taskId: "1", title: "Task", snippet: "", score: 1 });
      expect(api.openTask).not.toHaveBeenCalled();
    }
  });
  it("invalidates deferred task scrolling after scope changes, cancellation or a newer selection", async () => {
    for (const change of ["workspace", "connection", "cancel", "selection"]) {
      const api = options();
      const navigation = createSearchNavigation(api);
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      const scroll = vi.fn();
      api.openTask = async (_id, isCurrent) => {
        expect(isCurrent()).toBe(true);
        await pending;
        if (isCurrent()) scroll();
      };
      const opening = navigation.open({ kind: "tasks", id: "tasks:1", taskId: "1", title: "Task", snippet: "", score: 1 });
      await Promise.resolve();
      if (change === "workspace") api.workspace = () => "/other";
      if (change === "connection") api.connection = () => "other";
      if (change === "cancel") navigation.cancel();
      if (change === "selection") await navigation.open(file);
      release();
      await opening;
      expect(scroll).not.toHaveBeenCalled();
    }
  });
  it("activates and hydrates a session without paging or jumping to a message", async () => {
    const api = options();
    await createSearchNavigation(api).open(session);
    expect(api.loadSession).toHaveBeenCalledWith("session");
    expect(api.activateSession).toHaveBeenCalledWith("session");
    expect(api.hydrate).toHaveBeenCalledWith("session");
    expect(api.openFile).not.toHaveBeenCalled();
  });
  it("does not activate or hydrate after workspace/client replacement or cancellation while loading", async () => {
    for (const change of ["workspace", "connection", "session", "cancel"] as const) {
      const api = options();
      const navigation = createSearchNavigation(api);
      api.loadSession = async () => {
        if (change === "workspace") api.workspace = () => "/other";
        if (change === "connection") api.connection = () => "other";
        if (change === "session") api.activeSession = () => "other";
        if (change === "cancel") navigation.cancel();
      };
      if (change === "session") await expect(navigation.open(session)).rejects.toThrow("no longer available");
      else await navigation.open(session);
      expect(api.activateSession).not.toHaveBeenCalled();
      expect(api.hydrate).not.toHaveBeenCalled();
    }
  });
  it("rejects unavailable sessions and files and opens valid ranges", async () => {
    const api = options();
    api.loadSession = async () => { api.activeSession = () => "other"; };
    await expect(createSearchNavigation(api).open(session)).rejects.toThrow("no longer available");
    api.fileExists = async () => false;
    await expect(createSearchNavigation(api).open(file)).rejects.toThrow("no longer available");
    api.fileExists = async () => true;
    await createSearchNavigation(api).open(file);
    expect(api.openFile).toHaveBeenCalledWith("src/a.ts", { startLine: 7, endLine: 9 });
  });
  it("targets settings by section and stable field identity", async () => {
    const api = options();
    await createSearchNavigation(api).open({ kind: "settings", id: "s", section: "desktop-assistant", fieldId: "semantic-search", title: "Semantic search", snippet: "", score: 1 });
    expect(api.openSetting).toHaveBeenCalledWith("desktop-assistant", "semantic-search");
  });
});
