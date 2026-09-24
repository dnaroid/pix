import { describe, expect, it } from "vitest";
import { reconcileTranscriptResize } from "./transcript-scroll.svelte";

function metrics(scrollHeight: number, scrollTop: number, clientHeight: number): Pick<HTMLDivElement, "clientHeight" | "scrollHeight" | "scrollTop"> {
  return { scrollHeight, scrollTop, clientHeight };
}

describe("transcript scroll resize controller", () => {
  it("forces explicit scroll-to-latest actions back into follow mode", async () => {
    // @ts-expect-error Node fs import in Vitest runner
    const fs = (await import(/* @vite-ignore */ "node:fs")).default;
    // @ts-expect-error Node path import in Vitest runner
    const path = (await import(/* @vite-ignore */ "node:path")).default;
    // @ts-expect-error Node __dirname in Vitest runner
    const sourcePath = path.resolve(__dirname, "transcript-scroll.svelte.ts");
    const transcriptScrollSource = fs.readFileSync(sourcePath, "utf-8");

    expect(transcriptScrollSource).toContain("async function scrollToLatest(): Promise<void> {");
    expect(transcriptScrollSource).toContain("followsLatest = true;\n    await tick();");
    expect(transcriptScrollSource).not.toContain("async function scrollToLatest(): Promise<void> {\n    if (!followsLatest) return;");
  });

  it("returns to latest when a content shrink removes overflow without a scroll event", () => {
    expect(reconcileTranscriptResize(false, metrics(300, 0, 300))).toEqual({
      followsLatest: true,
      scrollToLatest: false,
    });
  });

  it("keeps the jump control visible when resized content still overflows above the bottom", () => {
    expect(reconcileTranscriptResize(false, metrics(500, 100, 300))).toEqual({
      followsLatest: false,
      scrollToLatest: false,
    });
  });

  it("keeps following and schedules a scroll when content grows", () => {
    expect(reconcileTranscriptResize(true, metrics(600, 200, 300))).toEqual({
      followsLatest: true,
      scrollToLatest: true,
    });
  });
});
