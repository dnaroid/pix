import { describe, expect, it, vi } from "vitest";
import {
  chunkDiffLines, diffChunkIntrinsicSize, diffLineTone, GIT_DIFF_CHUNKS_PER_FRAME, GIT_DIFF_INITIAL_CHUNKS, revealDiffChunks,
} from "./git-diff-chunks";
import diffPane from "../components/GitDiffPane.svelte?raw";

describe("Git diff chunking", () => {
  it("keeps every line in order across fixed-size chunks and sizes skipped chunks", () => {
    const content = Array.from({ length: 10 }, (_, index) => index === 3 ? "+\tx" : `line ${index}`).join("\n");
    const chunks = chunkDiffLines(content, 4);
    expect(chunks.map((chunk) => chunk.lines.length)).toEqual([4, 4, 2]);
    expect(chunks.flatMap((chunk) => chunk.lines).join("\n")).toBe(content);
    expect(chunks[0]!.columns).toBe(10); // "+\tx": the tab counts as eight columns
    expect(diffChunkIntrinsicSize(chunks[2]!)).toBe("contain-intrinsic-size: auto calc(6ch + 1.5rem) auto 32px");
    expect(chunkDiffLines("")).toEqual([{ lines: [""], columns: 0 }]);
  });

  it("classifies diff rows only by their column-zero marker", () => {
    expect(diffLineTone("+++ b/a")).toBe("text-muted-foreground");
    expect(diffLineTone("+added")).toContain("tool-success");
    expect(diffLineTone("-removed")).toContain("tool-error");
    expect(diffLineTone("@@ -1 +1 @@")).toContain("tool-info");
    expect(diffLineTone(" - context bullet")).toBe("text-foreground/80");
  });

  it("reveals large diffs over frames and cancels a stale reveal", () => {
    const frames: (() => void)[] = [];
    const cancel = vi.fn();
    const reveal = vi.fn();
    const total = GIT_DIFF_INITIAL_CHUNKS + GIT_DIFF_CHUNKS_PER_FRAME + 1;
    const dispose = revealDiffChunks(total, reveal, (callback) => frames.push(callback), cancel);
    expect(reveal).not.toHaveBeenCalled();
    frames.shift()!();
    expect(reveal).toHaveBeenLastCalledWith(GIT_DIFF_INITIAL_CHUNKS + GIT_DIFF_CHUNKS_PER_FRAME);
    expect(frames).toHaveLength(1);
    dispose();
    expect(cancel).toHaveBeenCalledWith(1);
    frames.shift()!(); // a frame the browser already dequeued must not publish
    expect(reveal).toHaveBeenCalledOnce();
  });

  it("finishes a large reveal and schedules nothing for small diffs", () => {
    const frames: (() => void)[] = [];
    const reveal = vi.fn();
    revealDiffChunks(GIT_DIFF_INITIAL_CHUNKS, reveal, (callback) => frames.push(callback), vi.fn());
    expect(frames).toHaveLength(0);
    const big = GIT_DIFF_INITIAL_CHUNKS + 3 * GIT_DIFF_CHUNKS_PER_FRAME;
    revealDiffChunks(big, reveal, (callback) => frames.push(callback), vi.fn());
    while (frames.length) frames.shift()!();
    expect(reveal).toHaveBeenLastCalledWith(big);
    expect(reveal).toHaveBeenCalledTimes(3);
  });

  it("renders position-keyed chunks with skipped offscreen layout instead of content keys", () => {
    expect(diffPane).not.toContain("`${index}:${line}`");
    expect(diffPane).toContain("[content-visibility:auto]");
    expect(diffPane).toContain("return revealDiffChunks(source.length");
  });
});
