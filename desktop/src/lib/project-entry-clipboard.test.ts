import { describe, expect, it } from "vitest";
import { canPasteProjectEntry, createProjectEntryClipboardReader, decodeProjectEntryClipboard, encodeProjectEntryClipboard } from "./project-entry-clipboard";

const entry = { name: "docs", path: "src/docs", kind: "directory" as const };
const text = encodeProjectEntryClipboard("/projects/source", entry);

describe("Project Explorer shared clipboard", () => {
  it("round-trips a versioned file/folder reference between independent readers", async () => {
    const value = decodeProjectEntryClipboard(text);
    expect(value).toEqual({ workspace: "/projects/source", path: "src/docs", kind: "directory" });
    let received: unknown;
    await createProjectEntryClipboardReader(async () => text).refresh((next) => { received = next; });
    expect(received).toEqual(value);
    expect(decodeProjectEntryClipboard(encodeProjectEntryClipboard("/source", { name: "a.txt", path: "a.txt", kind: "file" }))).toEqual({ workspace: "/source", path: "a.txt", kind: "file" });
  });

  it("rejects ordinary text, malformed/unversioned references and unsafe paths", () => {
    for (const invalid of [null, "a.txt", "{", "null", "x".repeat(32_769), JSON.stringify({ workspace: "/source", path: "a" })]) {
      expect(decodeProjectEntryClipboard(invalid)).toBeNull();
    }
    const base = JSON.parse(text);
    for (const change of [{ version: 2 }, { workspace: "relative" }, { workspace: "/a\0b" }, { path: "" }, { path: "/etc/passwd" }, { path: "a/../b" }, { path: "./a" }, { path: "a//b" }, { path: "a\\b" }, { path: "a\0b" }, { kind: "symlink" }]) {
      expect(decodeProjectEntryClipboard(JSON.stringify({ ...base, ...change }))).toBeNull();
    }
  });

  it("allows different projects and rejects same-project directory descendants", () => {
    const copied = decodeProjectEntryClipboard(text);
    expect(canPasteProjectEntry(copied, "/projects/destination", "src/docs/nested")).toBe(true);
    expect(canPasteProjectEntry(copied, "/projects/source", "src/docs")).toBe(false);
    expect(canPasteProjectEntry(copied, "/projects/source", "src/docs/nested")).toBe(false);
    expect(canPasteProjectEntry(copied, "/projects/source", "src/docs-other")).toBe(true);
    expect(canPasteProjectEntry(null, "/projects/source", "")).toBe(false);
  });

  it("ignores stale reads and reads resolving after disposal/workspace replacement", async () => {
    const pending: Array<(text: string | null) => void> = [];
    const reader = createProjectEntryClipboardReader(() => new Promise((resolve) => pending.push(resolve)));
    const received: unknown[] = [];
    const first = reader.refresh((value) => received.push(value));
    const second = reader.refresh((value) => received.push(value));
    pending[1]!(null);
    await second;
    pending[0]!(text);
    await first;
    expect(received).toEqual([null]);
    const third = reader.refresh((value) => received.push(value));
    reader.invalidate();
    pending[2]!(text);
    await third;
    expect(received).toEqual([null]);
  });

  it("clears cached availability on clipboard failure or replacement by normal text", async () => {
    let received: unknown = "stale";
    await createProjectEntryClipboardReader(async () => { throw new Error("denied"); }).refresh((value) => { received = value; });
    expect(received).toBeNull();
    await createProjectEntryClipboardReader(async () => "plain text").refresh((value) => { received = value; });
    expect(received).toBeNull();
  });
});
