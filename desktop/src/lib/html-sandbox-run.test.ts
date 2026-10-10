import { describe, expect, it } from "vitest";
import { createSandboxRun } from "./html-sandbox-run";
import type { PreparedHtmlSandbox } from "./html-sandbox";

function deferred() {
  let resolve!: (result: PreparedHtmlSandbox) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<PreparedHtmlSandbox>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("sandbox Run ownership while engines load", () => {
  it.each(["Stop", "source rewrite", "unmount"])("discards a late load after %s", async () => {
    const pending = deferred();
    const run = createSandboxRun(() => pending.promise);
    const result = run.start("old");
    run.cancel();
    pending.resolve({ srcdoc: "must not mount" });
    expect(await result).toBeUndefined();
  });

  it("keeps the latest restart even if the old request fails later", async () => {
    const old = deferred();
    const run = createSandboxRun(async source => source === "old" ? old.promise : { srcdoc: source });
    const first = run.start("old");
    expect(await run.start("new")).toEqual({ srcdoc: "new" });
    old.reject(new Error("stale failure"));
    expect(await first).toBeUndefined();
  });

  it("shows current failures and allows retry", async () => {
    const run = createSandboxRun(async source => {
      if (source === "bad") throw new Error("Local engine unavailable");
      return { srcdoc: source };
    });
    expect(await run.start("bad")).toEqual({ error: "Local engine unavailable" });
    expect(await run.start("good")).toEqual({ srcdoc: "good" });
  });
});
