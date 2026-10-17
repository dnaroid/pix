import { describe, expect, it, vi } from "vitest";
import { readDesktopTheme, startThemePreference, type DesktopTheme } from "./theme-preference";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("theme preference", () => {
  it("reads light/dark and falls back to system", () => {
    expect(readDesktopTheme('{ "desktop": { "theme": "dark" } }')).toBe("dark");
    expect(readDesktopTheme('{ "desktop": { "theme": "light", } }')).toBe("light");
    expect(readDesktopTheme('{ "desktop": { "theme": "neon" } }')).toBe("system");
    expect(readDesktopTheme("{ broken")).toBe("system");
    expect(readDesktopTheme("")).toBe("system");
  });

  it("applies on start and on config change, skipping unchanged themes", async () => {
    let source = '{ "desktop": { "theme": "dark" } }';
    const apply = vi.fn(async (_theme: DesktopTheme) => {});
    const target = new EventTarget() as Window;
    const stop = startThemePreference(vi.fn(), { read: async () => source, apply, target });
    await flush();
    target.dispatchEvent(new Event("focus"));
    await flush();
    source = '{ "desktop": { "theme": "system" } }';
    target.dispatchEvent(new Event("pix-desktop-config-changed"));
    await flush();
    expect(apply.mock.calls.map(([theme]) => theme)).toEqual(["dark", "system"]);
    stop();
    source = '{ "desktop": { "theme": "light" } }';
    target.dispatchEvent(new Event("pix-desktop-config-changed"));
    await flush();
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("ignores stale reads and reads after teardown", async () => {
    const reads = [deferred<string>(), deferred<string>()];
    let index = 0;
    const apply = vi.fn(async (_theme: DesktopTheme) => {});
    const target = new EventTarget() as Window;
    const stop = startThemePreference(vi.fn(), { read: () => reads[index++]!.promise, apply, target });
    target.dispatchEvent(new Event("focus"));
    reads[1]!.resolve('{ "desktop": { "theme": "light" } }');
    await flush();
    reads[0]!.resolve('{ "desktop": { "theme": "dark" } }');
    await flush();
    expect(apply.mock.calls.map(([theme]) => theme)).toEqual(["light"]);
    stop();
  });

  it("reports read and apply failures without throwing", async () => {
    const onError = vi.fn();
    const target = new EventTarget() as Window;
    const stop = startThemePreference(onError, {
      read: async () => { throw new Error("unreadable"); }, apply: vi.fn(), target,
    });
    await flush();
    stop();
    const stop2 = startThemePreference(onError, {
      read: async () => '{ "desktop": { "theme": "dark" } }',
      apply: async () => { throw new Error("denied"); }, target,
    });
    await flush();
    stop2();
    expect(onError.mock.calls.map(([error]) => (error as Error).message)).toEqual(["unreadable", "denied"]);
  });
});
