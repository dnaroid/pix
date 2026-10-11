import { describe, expect, it } from "vitest";
import { createSearchIndexHistory } from "./search-index-history";
import { observeSearchIndexEvents } from "./search-index-events";
import { emptySearchIndexView } from "./search-index-controller";

describe("bounded index activity history", () => {
  it("records a start once without inventing an intermediate completion", () => {
    const history = createSearchIndexHistory();
    const observer = observeSearchIndexEvents(history, "/a");
    observer.actions({ knowledge: { running: true } });
    observer.actions({ knowledge: { running: true } });
    observer.actions({ knowledge: { running: false, result: { source: "knowledge", complete: true } } });
    expect(history.entries("/a").map(e => e.message)).toEqual([
      "Manual indexing started", "Manual indexing complete",
    ]);
  });
  it("keeps newest 200 events in memory, scoped to workspace, with bounded messages", () => {
    const history = createSearchIndexHistory(() => 42);
    for (let i = 0; i < 205; i++) history.append(i % 2 ? "/a" : "/b", "tasks", "info", "x".repeat(400));
    const all = [...history.entries("/a"), ...history.entries("/b")];
    expect(all).toHaveLength(200);
    expect(Math.min(...all.map(event => event.id))).toBe(6);
    expect(all.every(event => event.time === 42 && event.message.length === 300)).toBe(true);
    expect(createSearchIndexHistory().entries("/a")).toEqual([]);
  });
  it("ignores repeated polling and distinguishes observed idle from successful completion", () => {
    const history = createSearchIndexHistory();
    const observer = observeSearchIndexEvents(history, "/a");
    const snapshot = emptySearchIndexView().snapshot;
    const active = { ...snapshot, activity: { indexingSources: { settings: false, tasks: true, sessions: false } } };
    observer.snapshot(active);
    observer.snapshot({ ...active, reading: true });
    observer.snapshot({ ...active, reading: false });
    expect(history.entries("/a")).toHaveLength(1);
    observer.snapshot({ ...active, activity: { indexingSources: { settings: false, tasks: false, sessions: false } } });
    expect(history.entries("/a").map(e => e.message)).toEqual(["Background index activity observed", "Background index activity now idle"]);
  });
  it("records manual partial/error/cancel results without leaking raw errors or provider messages", () => {
    const history = createSearchIndexHistory();
    const observer = observeSearchIndexEvents(history, "/a");
    observer.actions({ code: { running: true } });
    observer.actions({ code: { running: false, result: { source: "code", complete: false, indexed: 128, total: 500, message: "secret" } } });
    observer.actions({ code: { running: true } });
    observer.actions({ code: { running: false, error: "secret" } });
    observer.actions({ tasks: { running: true } });
    observer.actions({});
    expect(history.entries("/a").map(e => e.level)).toEqual(["info", "warning", "info", "error", "info", "warning"]);
    expect(history.entries("/a")[1]?.message).toContain("128/500");
    expect(JSON.stringify(history.entries("/a"))).not.toContain("secret");
  });
  it("records diagnostic failures once, recovery, and count changes without interpreting them as indexing", () => {
    const history = createSearchIndexHistory();
    const observer = observeSearchIndexEvents(history, "/a");
    const snapshot = { ...emptySearchIndexView().snapshot, activityError: "secret" };
    observer.snapshot(snapshot);
    observer.snapshot({ ...snapshot });
    observer.snapshot({ ...snapshot, activityError: "", stores: { stores: [{ id: "tasks", state: "present", counts: { taskVectors: 3 } }] } });
    expect(history.entries("/a").map(e => e.message)).toEqual(["Search activity unavailable", "Search activity restored", "tasks store: present", "tasks counts: taskVectors: 3"]);
  });
  it("does not relabel a manually observed operation as background work", () => {
    const history = createSearchIndexHistory();
    const observer = observeSearchIndexEvents(history, "/a");
    observer.actions({ tasks: { running: true } });
    const active = { ...emptySearchIndexView().snapshot, activity: { indexingSources: { settings: false, tasks: true, sessions: false } } };
    observer.snapshot(active);
    observer.actions({ tasks: { running: false, result: { source: "tasks", complete: true, indexed: 3, total: 3, message: "Done" } } });
    observer.snapshot({ ...active, activity: { indexingSources: { settings: false, tasks: false, sessions: false } } });
    expect(history.entries("/a").map(e => e.message)).toEqual(["Manual indexing started", "Manual indexing complete (3/3)"]);
  });
});
