import { describe, expect, it, vi } from "vitest";
import { createDeletionConfirmation, type DeletionRequest } from "./confirm-deletion";

function harness() {
  const report = vi.fn();
  const controller = createDeletionConfirmation(report);
  let request: DeletionRequest | null = null;
  const detach = controller.attach(next => { request = next; });
  return { ...controller, report, detach, current: () => request! };
}

describe("Pix deletion confirmation", () => {
  it("waits for explicit consent and preserves the action's context", async () => {
    const h = harness();
    const settled = vi.fn();
    const consent = h.confirm("Delete file “example.txt”?", { title: "Delete file?" });
    void consent.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(h.current()).toMatchObject({ title: "Delete file?", message: "Delete file “example.txt”?" });
    h.current().finish(true);
    await expect(consent).resolves.toBe(true);
    expect(h.current()).toBeNull();
  });

  it("cancels and allows a fresh request without stale consent affecting it", async () => {
    const h = harness();
    const first = h.confirm("First", { title: "Delete?" });
    const retired = h.current();
    retired.finish(false);
    await expect(first).resolves.toBe(false);
    const second = h.confirm("Second", { title: "Clear?", okLabel: "Clear" });
    retired.finish(true);
    expect(h.current().message).toBe("Second");
    expect(h.current().okLabel).toBe("Clear");
    h.current().finish(false);
    await expect(second).resolves.toBe(false);
  });

  it("fails closed on overlapping requests without replacing pending consent", async () => {
    const h = harness();
    const first = h.confirm("First", { title: "Delete?" });
    await expect(h.confirm("Second", { title: "Delete?" })).resolves.toBe(false);
    expect(h.current().message).toBe("First");
    h.current().finish(true);
    await expect(first).resolves.toBe(true);
  });

  it("cancels on teardown and ignores a retired host's cleanup and callbacks", async () => {
    const h = harness();
    const first = h.confirm("First", { title: "Delete?" });
    const retired = h.current();
    h.detach();
    await expect(first).resolves.toBe(false);
    let next: DeletionRequest | null = null;
    const detach = h.attach(request => { next = request; });
    const second = h.confirm("Second", { title: "Delete?" });
    h.detach();
    retired.finish(true);
    expect(next).toMatchObject({ message: "Second" });
    detach();
    await expect(second).resolves.toBe(false);
  });

  it("fails closed and logs a missing or failed presenter", async () => {
    const report = vi.fn();
    const h = createDeletionConfirmation(report);
    await expect(h.confirm("File", { title: "Delete?" })).resolves.toBe(false);
    expect(report).toHaveBeenCalledOnce();
    const failure = new Error("Unable to present modal");
    h.attach(request => { if (request) throw failure; });
    await expect(h.confirm("File", { title: "Delete?" })).resolves.toBe(false);
    expect(report).toHaveBeenLastCalledWith(failure);
  });
});
