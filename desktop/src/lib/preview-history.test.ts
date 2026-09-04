import { describe, expect, it } from "vitest";
import {
  canMovePreviewHistory,
  currentPreview,
  emptyPreviewHistory,
  movePreviewHistory,
  pushPreviewHistory,
  replaceCurrentPreview,
  resetPreviewHistory,
} from "./preview-history";

describe("preview history", () => {
  it("moves backward and forward through pushed previews", () => {
    let history = resetPreviewHistory("README.md");
    history = pushPreviewHistory(history, "docs/setup.md");

    expect(currentPreview(history)).toBe("docs/setup.md");
    expect(canMovePreviewHistory(history, -1)).toBe(true);
    history = movePreviewHistory(history, -1);
    expect(currentPreview(history)).toBe("README.md");
    expect(canMovePreviewHistory(history, 1)).toBe(true);
  });

  it("drops forward entries after navigating to a new preview", () => {
    let history = resetPreviewHistory("one");
    history = pushPreviewHistory(history, "two");
    history = pushPreviewHistory(history, "three");
    history = movePreviewHistory(history, -1);
    history = pushPreviewHistory(history, "replacement");

    expect(history).toEqual({ entries: ["one", "two", "replacement"], index: 2 });
    expect(canMovePreviewHistory(history, 1)).toBe(false);
  });

  it("keeps empty history stable", () => {
    const history = emptyPreviewHistory<string>();
    expect(movePreviewHistory(history, -1)).toBe(history);
    expect(replaceCurrentPreview(history, "missing")).toBe(history);
    expect(currentPreview(history)).toBeUndefined();
  });

  it("retains independent state for each history entry", () => {
    type Entry = { path: string; scrollTop: number };
    let history = resetPreviewHistory<Entry>({ path: "README.md", scrollTop: 0 });
    history = replaceCurrentPreview(history, { path: "README.md", scrollTop: 240 });
    history = pushPreviewHistory(history, { path: "docs/setup.md", scrollTop: 0 });
    history = replaceCurrentPreview(history, { path: "docs/setup.md", scrollTop: 480 });

    history = movePreviewHistory(history, -1);
    expect(currentPreview(history)).toEqual({ path: "README.md", scrollTop: 240 });
    history = movePreviewHistory(history, 1);
    expect(currentPreview(history)).toEqual({ path: "docs/setup.md", scrollTop: 480 });
  });
});
