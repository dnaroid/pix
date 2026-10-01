import { describe, expect, it, vi } from "vitest";
import { createProjectGitIgnoreEligibility } from "./project-git-ignore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Project Explorer ignore eligibility", () => {
  it("keeps the item visible during same-target status refreshes and applies fresh changes", async () => {
    const refresh = deferred<boolean>();
    const check = vi.fn().mockResolvedValueOnce(true).mockImplementationOnce(() => refresh.promise);
    const publish = vi.fn();
    const eligibility = createProjectGitIgnoreEligibility(check, publish);
    await eligibility.request("A", "file");
    eligibility.invalidate(); // Svelte effect cleanup before the next snapshot.
    const request = eligibility.request("A", "file");
    expect(publish.mock.calls).toEqual([[false], [true]]);
    refresh.resolve(false); // Now tracked or ignored: hide only on confirmation.
    await request;
    expect(publish.mock.calls).toEqual([[false], [true], [false]]);
  });

  it("does not flicker across repeated eligible snapshots", async () => {
    const publish = vi.fn();
    const eligibility = createProjectGitIgnoreEligibility(async () => true, publish);
    await eligibility.request("A", "file");
    for (let index = 0; index < 3; index += 1) {
      eligibility.invalidate();
      await eligibility.request("A", "file");
    }
    expect(publish.mock.calls).toEqual([[false], [true], [true], [true], [true]]);
  });

  it("hides on a current refresh failure but ignores stale failures", async () => {
    let reject!: (error: Error) => void;
    const stale = new Promise<boolean>((_, fail) => { reject = fail; });
    const check = vi.fn().mockResolvedValueOnce(true).mockImplementationOnce(() => stale)
      .mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("Git unavailable"));
    const publish = vi.fn();
    const eligibility = createProjectGitIgnoreEligibility(check, publish);
    await eligibility.request("A", "file");
    const old = eligibility.request("A", "file");
    await eligibility.request("A", "file");
    reject(new Error("Stale failure"));
    await old;
    expect(publish.mock.calls).toEqual([[false], [true], [true]]);
    await eligibility.request("A", "file");
    expect(publish).toHaveBeenLastCalledWith(false);
  });

  it("rejects stale A→B→A workspace/menu and status reads", async () => {
    const reads = [deferred<boolean>(), deferred<boolean>(), deferred<boolean>()] as const;
    const check = vi.fn().mockImplementationOnce(() => reads[0].promise)
      .mockImplementationOnce(() => reads[1].promise)
      .mockImplementationOnce(() => reads[2].promise);
    const publish = vi.fn();
    const eligibility = createProjectGitIgnoreEligibility(check, publish);
    const requests = [eligibility.request("A", "file"), eligibility.request("B", "file"), eligibility.request("A", "file")];
    reads[2].resolve(false);
    await requests[2];
    reads[0].resolve(true);
    reads[1].resolve(true);
    await Promise.all(requests);
    expect(publish.mock.calls).toEqual([[false], [false], [false], [false]]);
  });

  it("invalidates in-flight checks when a menu or panel closes", async () => {
    const read = deferred<boolean>();
    const publish = vi.fn();
    const eligibility = createProjectGitIgnoreEligibility(() => read.promise, publish);
    const request = eligibility.request("A", "file");
    eligibility.invalidate();
    read.resolve(true);
    await request;
    expect(publish.mock.calls).toEqual([[false]]);
  });

  it("publishes fresh eligibility and hides root/non-repository/unavailable states", async () => {
    const check = vi.fn().mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("No repository"));
    const publish = vi.fn();
    const eligibility = createProjectGitIgnoreEligibility(check, publish);
    await eligibility.request("A", "file");
    expect(publish).toHaveBeenLastCalledWith(true);
    await eligibility.request("A", "");
    await eligibility.request("", "file");
    expect(check).toHaveBeenCalledTimes(1);
    await eligibility.request("B", "file");
    expect(publish).toHaveBeenLastCalledWith(false);
  });
});
