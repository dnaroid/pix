import { afterEach, describe, expect, it, vi } from "vitest";
import { createRegistryStartupLoader, REGISTRY_STARTUP_DELAY_MS, type RegistryStartupState } from "./registry-startup";

afterEach(() => vi.useRealTimers());

function fixture() {
  vi.useFakeTimers();
  let state: RegistryStartupState = { ready: true, client: {}, workspace: "/one", blocked: false };
  const refresh = vi.fn();
  const loader = createRegistryStartupLoader({ state: () => state, refresh });
  return { loader, refresh, set(patch: Partial<RegistryStartupState>) { state = { ...state, ...patch }; } };
}

describe("deferred Registry startup", () => {
  it("loads once after the delay, not synchronously or repeatedly", () => {
    const { loader, refresh } = fixture();
    loader.sync();
    loader.sync();
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(REGISTRY_STARTUP_DELAY_MS - 1);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    loader.sync();
    vi.advanceTimersByTime(REGISTRY_STARTUP_DELAY_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("waits for ready/client/workspace and for busy startup work to settle", () => {
    const f = fixture();
    for (const patch of [{ ready: false }, { ready: true, client: null }, { client: {}, workspace: "" }, { workspace: "/one", blocked: true }]) {
      f.set(patch);
      f.loader.sync();
      vi.advanceTimersByTime(REGISTRY_STARTUP_DELAY_MS);
      expect(f.refresh).not.toHaveBeenCalled();
    }
    f.set({ blocked: false });
    f.loader.sync();
    vi.advanceTimersByTime(REGISTRY_STARTUP_DELAY_MS);
    expect(f.refresh).toHaveBeenCalledTimes(1);
  });

  it("cancels on busy state and starts a fresh delay after it clears", () => {
    const f = fixture();
    f.loader.sync();
    vi.advanceTimersByTime(1_000);
    f.set({ blocked: true });
    f.loader.sync();
    vi.advanceTimersByTime(REGISTRY_STARTUP_DELAY_MS);
    expect(f.refresh).not.toHaveBeenCalled();
    f.set({ blocked: false });
    f.loader.sync();
    vi.advanceTimersByTime(REGISTRY_STARTUP_DELAY_MS - 1);
    expect(f.refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(f.refresh).toHaveBeenCalledTimes(1);
  });

  it("cancels old workspace/client requests and reloads after reconnect", () => {
    const f = fixture();
    f.loader.sync();
    vi.advanceTimersByTime(1_000);
    f.set({ workspace: "/two", client: {} });
    f.loader.sync();
    vi.advanceTimersByTime(REGISTRY_STARTUP_DELAY_MS - 1);
    expect(f.refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(f.refresh).toHaveBeenCalledTimes(1);
    f.set({ ready: false });
    f.loader.sync();
    f.set({ ready: true });
    f.loader.sync();
    vi.advanceTimersByTime(REGISTRY_STARTUP_DELAY_MS);
    expect(f.refresh).toHaveBeenCalledTimes(2);
  });

  it("reloads when returning to a workspace before its replacement loads", () => {
    const f = fixture();
    f.loader.sync();
    vi.advanceTimersByTime(REGISTRY_STARTUP_DELAY_MS);
    expect(f.refresh).toHaveBeenCalledTimes(1);
    f.set({ workspace: "/two" });
    f.loader.sync();
    vi.advanceTimersByTime(1_000);
    f.set({ workspace: "/one" });
    f.loader.sync();
    vi.advanceTimersByTime(REGISTRY_STARTUP_DELAY_MS);
    expect(f.refresh).toHaveBeenCalledTimes(2);
  });

  it("rechecks live readiness even before reactive effects catch up", () => {
    const f = fixture();
    f.loader.sync();
    f.set({ blocked: true });
    vi.advanceTimersByTime(REGISTRY_STARTUP_DELAY_MS);
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it("cancels on teardown", () => {
    const f = fixture();
    f.loader.sync();
    f.loader.dispose();
    vi.advanceTimersByTime(REGISTRY_STARTUP_DELAY_MS);
    f.loader.sync();
    expect(f.refresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
