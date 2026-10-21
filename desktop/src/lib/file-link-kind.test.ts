import { describe, expect, it } from "vitest";
import { fileLinkIconKind } from "./file-link-kind";

describe("Markdown file link icons", () => {
  it.each([
    ["src/main.ts", "code"], ["config.JSON", "code"], ["Dockerfile", "code"],
    ["report.html", "globe"], ["REPORT.HTM", "globe"],
    ["README.md", "text"], ["notes.txt", "text"], ["photo.PNG", "image"],
    ["track.mp3", "audio"], ["movie.mov", "video"], ["backup.tar.gz", "archive"],
    ["guide.pdf", "pdf"], ["LICENSE", "file"], ["C:\\files\\code.py", "code"],
    ["folder.with.dots/unknown", "file"],
  ])("classifies %s as %s", (path, expected) => {
    expect(fileLinkIconKind(path, true)).toBe(expected);
  });

  it("uses validated directory metadata rather than guessing from extensions", () => {
    expect(fileLinkIconKind("folder.with.ts", "directory")).toBe("folder");
    expect(fileLinkIconKind("reports.html", "directory")).toBe("folder");
    expect(fileLinkIconKind("extensionless", true)).toBe("file");
  });
});
