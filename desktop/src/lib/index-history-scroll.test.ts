import { describe, expect, it } from "vitest";
import { captureHistoryPosition, createHistoryScrollTracker, isHistoryAtBottom, restoreHistoryPosition } from "./index-history-scroll";

function pane(scrollTop = 0) {
  const rows: HTMLElement[] = [];
  const node = {
    clientHeight: 100, scrollHeight: 500, scrollTop,
    getBoundingClientRect: () => ({ top: 10 } as DOMRect),
    querySelectorAll: () => rows,
    append: (item: HTMLElement) => rows.push(item),
    removeChild: (item: HTMLElement) => rows.splice(rows.indexOf(item), 1),
  } as unknown as HTMLElement;
  return node;
}
function row(node: HTMLElement, id: string, contentTop: number) {
  const item = {
    dataset: { eventId: id },
    getBoundingClientRect: () => ({ top: 10 + contentTop - node.scrollTop, bottom: 30 + contentTop - node.scrollTop } as DOMRect),
    remove: () => node.removeChild(item),
  } as unknown as HTMLElement;
  node.append(item);
  return item;
}

describe("index journal position", () => {
  it("follows appended events only from the bottom, with fractional pixel tolerance", () => {
    const node = pane(398);
    expect(isHistoryAtBottom(node)).toBe(true);
    const position = captureHistoryPosition(node);
    Object.defineProperty(node, "scrollHeight", { value: 600 });
    restoreHistoryPosition(node, position);
    expect(node.scrollTop).toBe(600);
  });
  it("leaves a reader's position unchanged while events append below", () => {
    const node = pane(105);
    row(node, "2", 100);
    const position = captureHistoryPosition(node);
    row(node, "3", 500);
    restoreHistoryPosition(node, position);
    expect(node.scrollTop).toBe(105);
    expect(position.pinned).toBe(false);
  });
  it("preserves the visible retained row when the 200-event ring evicts earlier rows", () => {
    const node = pane(105);
    const old = row(node, "1", 0);
    const visible = row(node, "2", 100);
    const position = captureHistoryPosition(node);
    old.remove(); visible.remove();
    row(node, "2", 80);
    restoreHistoryPosition(node, position);
    expect(node.scrollTop).toBe(85);
  });
  it("stays at the oldest available record if the visible record itself is evicted", () => {
    const node = pane(0);
    const old = row(node, "1", 0);
    const position = captureHistoryPosition(node);
    old.remove(); row(node, "2", 0);
    restoreHistoryPosition(node, position);
    expect(node.scrollTop).toBe(0);
  });
});

function livePane() {
  const node = pane(400);
  let top = node.scrollTop;
  Object.defineProperty(node, "scrollTop", {
    get: () => Math.min(top, Math.max(0, node.scrollHeight - node.clientHeight)),
    set: (value: number) => { top = Math.max(0, Math.min(value, node.scrollHeight - node.clientHeight)); },
  });
  const height = (value: number) => Object.defineProperty(node, "scrollHeight", { configurable: true, value });
  return { node, height, tracker: createHistoryScrollTracker(node) };
}

describe("index journal follow intent", () => {
  it("keeps following when rows grow before the capture and a queued scroll arrives", () => {
    const { node, height, tracker } = livePane();
    height(600);
    expect(isHistoryAtBottom(node)).toBe(false);
    const pending = tracker.capture();
    tracker.handleScroll();
    tracker.restore(pending);
    expect(node.scrollTop).toBe(500);
    height(700);
    tracker.handleScroll();
    tracker.restore(tracker.capture());
    expect(node.scrollTop).toBe(600);
  });

  it("does not let a pending restore override a reader scrolling up", () => {
    const { node, height, tracker } = livePane();
    const pending = tracker.capture();
    height(600);
    node.scrollTop = 250;
    tracker.handleScroll();
    tracker.restore(pending);
    tracker.resize();
    expect(node.scrollTop).toBe(250);
    expect(tracker.capture().pinned).toBe(false);
  });

  it("stays paused through growth and resumes only when the reader returns to bottom", () => {
    const { node, height, tracker } = livePane();
    node.scrollTop = 200;
    tracker.handleScroll();
    const position = tracker.capture();
    height(700);
    tracker.restore(position);
    tracker.resize();
    expect(node.scrollTop).toBe(200);
    node.scrollTop = 300;
    tracker.handleScroll();
    tracker.resize();
    expect(node.scrollTop).toBe(300);
    node.scrollTop = 600;
    tracker.handleScroll();
    height(800);
    tracker.resize();
    expect(node.scrollTop).toBe(700);
  });

  it("preserves the reading anchor through eviction and its queued programmatic scroll", () => {
    const { node, tracker } = livePane();
    node.scrollTop = 105;
    tracker.handleScroll();
    const old = row(node, "1", 0);
    const visible = row(node, "2", 100);
    const position = tracker.capture();
    old.remove(); visible.remove();
    row(node, "2", 80);
    tracker.restore(position);
    tracker.handleScroll();
    tracker.resize();
    expect(node.scrollTop).toBe(85);
    expect(tracker.capture().pinned).toBe(false);
  });

  it("follows content and viewport resizes without inferring loss of follow from geometry", () => {
    const { node, height, tracker } = livePane();
    Object.defineProperty(node, "clientHeight", { value: 80 });
    tracker.handleScroll();
    tracker.resize();
    expect(node.scrollTop).toBe(420);
    height(800);
    tracker.resize();
    expect(node.scrollTop).toBe(720);
  });

  it("does not replace reading intent with hidden geometry", () => {
    const { node, tracker } = livePane();
    node.scrollTop = 200;
    tracker.handleScroll();
    Object.defineProperty(node, "clientHeight", { configurable: true, value: 0 });
    node.scrollTop = 0;
    tracker.handleScroll();
    tracker.resize();
    expect(tracker.capture().pinned).toBe(false);
  });
});
