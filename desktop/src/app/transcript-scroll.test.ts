import { describe, expect, it } from "vitest";
import { reconcileTranscriptResize } from "./transcript-scroll.svelte";

function metrics(scrollHeight: number, scrollTop: number, clientHeight: number): Pick<HTMLDivElement, "clientHeight" | "scrollHeight" | "scrollTop"> {
  return { scrollHeight, scrollTop, clientHeight };
}

describe("transcript scroll resize controller", () => {
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
