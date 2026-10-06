import { describe, expect, it, vi } from "vitest";
import { createGitIdentityEditor, type GitIdentity } from "./git-identity-editor.svelte";

const inherited: GitIdentity = { name: "Corporate", email: "work@example.invalid", localName: null, localEmail: null };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("Git identity editor", () => {
  it("loads inherited values and saves a trimmed repository override then rereads Git", async () => {
    const local = { name: "dnaroid", email: "dnaroid@gmail.com", localName: "dnaroid", localEmail: "dnaroid@gmail.com" };
    const read = vi.fn().mockResolvedValueOnce(inherited).mockResolvedValueOnce(local);
    const write = vi.fn(async () => true);
    const editor = createGitIdentityEditor(read, write);
    await editor.load();
    expect(editor.identity).toEqual(inherited);
    expect(editor.email).toBe(inherited.email);
    editor.name = " dnaroid "; editor.email = " dnaroid@gmail.com ";
    await editor.save();
    expect(write).toHaveBeenCalledWith("dnaroid", "dnaroid@gmail.com");
    expect(editor.identity).toEqual(local);
    expect(editor.saved).toBe(true);
    expect(editor.saving).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not overwrite newer edits or a disposed workspace with late reads", async () => {
    const pending = deferred<GitIdentity>();
    const editor = createGitIdentityEditor(() => pending.promise, vi.fn());
    const load = editor.load();
    editor.name = "new draft";
    pending.resolve(inherited);
    await load;
    expect(editor.name).toBe("new draft");
    const late = deferred<GitIdentity>();
    const old = createGitIdentityEditor(() => late.promise, vi.fn());
    const oldLoad = old.load();
    old.dispose();
    late.resolve(inherited);
    await oldLoad;
    expect(old.identity).toBeNull();
    expect(old.email).toBe("");
  });

  it("serializes saves and ignores stale completion after disposal", async () => {
    const pending = deferred<boolean>();
    const write = vi.fn(() => pending.promise);
    const read = vi.fn(async () => inherited);
    const editor = createGitIdentityEditor(read, write);
    await editor.load();
    const save = editor.save();
    await editor.save();
    editor.email = "cannot replace submitted draft";
    expect(editor.email).toBe(inherited.email);
    expect(write).toHaveBeenCalledOnce();
    editor.dispose();
    pending.resolve(true);
    await save;
    expect(editor.saved).toBe(false);
    expect(read).toHaveBeenCalledOnce();
  });

  it("keeps the draft on save failure, releases saving state and supports retry", async () => {
    const write = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const editor = createGitIdentityEditor(async () => inherited, write);
    await editor.load();
    editor.name = "Personal";
    await editor.save();
    expect(editor.name).toBe("Personal");
    expect(editor.error).toContain("Could not save");
    expect(editor.saving).toBe(false);
    await editor.save();
    expect(editor.saved).toBe(true);
    expect(editor.error).toBeNull();
  });

  it("shows read errors and prevents empty saves", async () => {
    const write = vi.fn();
    const editor = createGitIdentityEditor(async () => { throw new Error("config unreadable"); }, write);
    await editor.load();
    expect(editor.error).toContain("config unreadable");
    expect(editor.loading).toBe(false);
    await editor.save();
    expect(write).not.toHaveBeenCalled();
  });

  it("reports partial success if the post-save read fails", async () => {
    const read = vi.fn().mockResolvedValueOnce(inherited).mockRejectedValueOnce(new Error("read failed"));
    const editor = createGitIdentityEditor(read, async () => true);
    await editor.load();
    await editor.save();
    expect(editor.saved).toBe(true);
    expect(editor.error).toContain("Saved, but could not reload");
    expect(editor.saving).toBe(false);
  });
});
