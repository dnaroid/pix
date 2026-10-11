import { describe, expect, it, vi } from "vitest";
import { startSearchIndexSync } from "./search-index-sync";

describe("workspace search index sync", () => {
  it("registers metadata at startup/config changes, strips values, and tears down", async () => {
    const events = new EventTarget();
    const searchSync = vi.fn().mockResolvedValue({});
    const catalog = [{ id: "field", section: "section", label: "Label", synonyms: ["name"], value: "secret" }];
    const stop = startSearchIndexSync({ searchSync }, "/project", catalog, events);
    expect(searchSync).toHaveBeenCalledTimes(1);
    expect(searchSync.mock.calls[0]![0]).toEqual({ cwd: "/project", settings: [
      { id: "field", section: "section", label: "Label", description: "", synonyms: ["name"] },
    ] });
    catalog[0]!.value = "new secret";
    await Promise.resolve();
    expect(searchSync).toHaveBeenCalledTimes(1);
    const firstSignal = searchSync.mock.calls[0]![1];
    events.dispatchEvent(new Event("pix-semantic-config-changed"));
    expect(searchSync).toHaveBeenCalledTimes(2);
    expect(firstSignal.aborted).toBe(true);
    stop();
    expect(searchSync.mock.calls[1]![1].aborted).toBe(true);
    events.dispatchEvent(new Event("pix-semantic-config-changed"));
    expect(searchSync).toHaveBeenCalledTimes(2);
  });
  it("does not retry failed provider/connection work on a loop", async () => {
    const searchSync = vi.fn().mockRejectedValue(new Error("offline"));
    const stop = startSearchIndexSync({ searchSync }, "/project", [], new EventTarget());
    await Promise.resolve();
    expect(searchSync).toHaveBeenCalledTimes(1);
    stop();
  });
  it("journals sync acknowledgements, cancellations and failures without stale success or raw errors", async () => {
    const events = new EventTarget();
    const onEvent = vi.fn();
    let finish!: () => void;
    const searchSync = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }))
      .mockRejectedValueOnce(new Error("private provider error"))
      .mockResolvedValue({});
    const stop = startSearchIndexSync({ searchSync }, "/project", [], events, onEvent);
    events.dispatchEvent(new Event("pix-semantic-config-changed"));
    finish();
    await Promise.resolve(); await Promise.resolve();
    expect(onEvent.mock.calls.flat()).toEqual(["started", "cancelled", "started", "failed"]);
    events.dispatchEvent(new Event("pix-semantic-config-changed"));
    await Promise.resolve(); await Promise.resolve();
    stop();
    expect(onEvent.mock.calls.flat()).toEqual(["started", "cancelled", "started", "failed", "started", "completed"]);
  });
  it("records pending teardown once and never appends late completion", async () => {
    let finish!: () => void;
    const onEvent = vi.fn();
    const searchSync = vi.fn().mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const stop = startSearchIndexSync({ searchSync }, "/project", [], new EventTarget(), onEvent);
    stop(); stop(); finish();
    await Promise.resolve();
    expect(onEvent.mock.calls.flat()).toEqual(["started", "cancelled"]);
  });
});
