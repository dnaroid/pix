import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranscriptScrollController, reconcileTranscriptResize } from "./transcript-scroll.svelte";

function metrics(scrollHeight: number, scrollTop: number, clientHeight: number): Pick<HTMLDivElement, "clientHeight" | "scrollHeight" | "scrollTop"> {
  return { scrollHeight, scrollTop, clientHeight };
}

describe("transcript scroll scheduling", () => {
  afterEach(() => vi.unstubAllGlobals());

  function setup({ clampScroll = false } = {}) {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextFrame++;
      callbacks.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
    const pane = { scrollHeight: 600, scrollTop: 300, clientHeight: 300 };
    if (clampScroll) {
      let scrollTop = pane.scrollTop;
      Object.defineProperty(pane, "scrollTop", {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = Math.max(0, Math.min(value, pane.scrollHeight - pane.clientHeight));
        },
      });
    }
    let activeSessionId = "session-1";
    const controller = createTranscriptScrollController({
      activeSessionId: () => activeSessionId,
      pane: () => pane as HTMLDivElement,
      content: () => null,
    });
    function activateSession(id: string) {
      activeSessionId = id;
      controller.activateSession(id); // App's pre-effect, before DOM replacement
    }
    function runFrame() {
      // Like the browser, snapshot this frame but respect cancellations made
      // by an earlier callback; new callbacks wait for the following frame.
      for (const [id, callback] of [...callbacks]) {
        if (!callbacks.delete(id)) continue;
        callback(0);
      }
    }
    return { controller, pane, callbacks, runFrame, activateSession };
  }

  it("does not let earlier stream callbacks postpone an already pending scroll", () => {
    const { controller, pane, callbacks, runFrame } = setup();
    requestAnimationFrame(() => {
      pane.scrollHeight = 900;
      controller.scheduleScrollToLatest();
    });
    controller.scheduleScrollToLatest();
    controller.scheduleScrollToLatest(); // ResizeObserver notification

    runFrame();

    expect(pane.scrollTop).toBe(900);
    expect(callbacks.size).toBe(0);
    pane.scrollHeight = 1000;
    controller.scheduleScrollToLatest();
    runFrame();
    expect(pane.scrollTop).toBe(1000);
  });

  it("exposes pending restoration until the activated pane has usable layout", () => {
    const { controller, pane, activateSession, runFrame } = setup();
    activateSession("session-2");
    expect(controller.restoring).toBe(true);
    pane.clientHeight = 0;
    runFrame();
    expect(controller.restoring).toBe(true);
    pane.clientHeight = 300;
    controller.scheduleScrollToLatest();
    runFrame();
    expect(controller.restoring).toBe(false);
  });

  it("cancels passive following when the user scrolls up and resumes at the bottom", () => {
    const { controller, pane, callbacks, runFrame } = setup();
    controller.scheduleScrollToLatest();
    pane.scrollTop = 100;
    controller.handleScroll();
    runFrame();
    expect(pane.scrollTop).toBe(100);
    expect(controller.followsLatest).toBe(false);
    controller.scheduleScrollToLatest();
    expect(callbacks.size).toBe(0);

    pane.scrollTop = 300;
    controller.handleScroll();
    pane.scrollHeight = 900;
    controller.scheduleScrollToLatest();
    runFrame();
    expect(pane.scrollTop).toBe(900);
    expect(controller.followsLatest).toBe(true);
  });

  it("keeps the latest edge through composer growth and layout scrolls before the follow frame", () => {
    const { controller, pane, callbacks, runFrame } = setup({ clampScroll: true });
    // Multiline input shrinks the transcript viewport; its old offset is no
    // longer near the bottom, even though the reader has not scrolled upward.
    pane.clientHeight = 160;
    controller.handleScroll(); // layout scroll arrives before ResizeObserver
    controller.scheduleScrollToLatest(); // observer/stream notification
    controller.handleScroll(); // another stationary scroll before the frame
    expect(controller.followsLatest).toBe(true);
    expect(callbacks.size).toBe(1);
    runFrame();
    expect(pane.scrollTop).toBe(440);

    // The scroll event from the browser's clamped write must keep following.
    controller.handleScroll();
    pane.clientHeight = 100;
    controller.handleScroll();
    runFrame();
    expect(pane.scrollTop).toBe(500);
    expect(controller.followsLatest).toBe(true);
  });

  it("honors an upward scroll even when composer growth and a follow frame are pending", () => {
    const { controller, pane, runFrame } = setup();
    pane.clientHeight = 160;
    controller.handleScroll();
    pane.scrollTop = 100;
    controller.handleScroll();
    runFrame();
    expect(pane.scrollTop).toBe(100);
    expect(controller.followsLatest).toBe(false);
  });

  it("does not steal a scrolled-up reader's position on composer resize and can reach bottom again", () => {
    const { controller, pane, runFrame } = setup({ clampScroll: true });
    pane.scrollTop = 100;
    controller.handleScroll();
    pane.clientHeight = 160;
    controller.handleScroll();
    controller.scheduleScrollToLatest();
    runFrame();
    expect(pane.scrollTop).toBe(100);
    expect(controller.followsLatest).toBe(false);
    pane.scrollTop = pane.scrollHeight - pane.clientHeight;
    controller.handleScroll();
    expect(controller.followsLatest).toBe(true);
    pane.clientHeight = 100;
    controller.handleScroll();
    runFrame();
    expect(pane.scrollTop).toBe(500);
  });

  it("honors upward movement in the same scroll event as viewport shrink", () => {
    const { controller, pane, runFrame } = setup();
    Object.assign(pane, { clientHeight: 160, scrollTop: 100 });
    controller.handleScroll();
    controller.scheduleScrollToLatest();
    runFrame();
    expect(pane.scrollTop).toBe(100);
    expect(controller.followsLatest).toBe(false);
  });

  it("jump-to-latest resumes following and disposal cancels a pending frame", () => {
    const { controller, pane, callbacks, runFrame } = setup();
    pane.scrollTop = 100;
    controller.handleScroll();
    controller.jumpToLatest();
    runFrame();
    expect(pane.scrollTop).toBe(600);
    expect(controller.followsLatest).toBe(true);

    controller.scheduleScrollToLatest();
    controller.dispose();
    expect(callbacks.size).toBe(0);
  });

  it("returns to the new bottom after a hidden tab without losing follow mode", () => {
    const { controller, pane, callbacks, runFrame } = setup();
    controller.scheduleScrollToLatest();
    controller.setVisible(false); // before display:none
    expect(callbacks.size).toBe(0);
    Object.assign(pane, { clientHeight: 0, scrollHeight: 0, scrollTop: 0 });
    controller.handleScroll();
    controller.scheduleScrollToLatest(); // stream update while hidden
    runFrame();
    expect(pane.scrollTop).toBe(0);
    expect(controller.followsLatest).toBe(true);

    controller.setVisible(true);
    Object.assign(pane, { clientHeight: 300, scrollHeight: 1200 });
    controller.handleScroll(); // browser show event arrives before restoration
    expect(controller.followsLatest).toBe(true);
    runFrame();
    expect(pane.scrollTop).toBe(1200);
    pane.scrollHeight = 1400;
    controller.scheduleScrollToLatest();
    runFrame();
    expect(pane.scrollTop).toBe(1400);
  });

  it.each(["conversation", "auxiliary", "explicit latest"])(
    "settles the live edge when a %s restore materializes taller media entries",
    async (activation) => {
      const { controller, pane, callbacks, runFrame, activateSession } = setup({ clampScroll: true });
      activateSession("session-1");
      runFrame();
      if (activation === "conversation") {
        activateSession("session-2");
        runFrame();
        activateSession("session-1");
      } else if (activation === "auxiliary") {
        controller.setVisible(false);
        controller.setVisible(true);
      }

      // Reading scrollHeight yields estimated content-visibility geometry.
      // Moving the viewport then materializes a media-rich entry: the write
      // reaches the old bottom, but subsequent metrics expose a taller pane.
      let offset = pane.scrollTop;
      let materializations = 2;
      Object.defineProperty(pane, "scrollTop", {
        get: () => offset,
        set: (value: number) => {
          offset = Math.max(0, Math.min(value, pane.scrollHeight - pane.clientHeight));
          if (materializations-- > 0) pane.scrollHeight += 600;
        },
      });

      if (activation === "explicit latest") await controller.scrollToLatest();
      else runFrame();
      expect(pane.scrollTop).toBe(300);
      controller.handleScroll(); // queued scroll before ResizeObserver fires
      expect(controller.followsLatest).toBe(true);
      expect(callbacks.size).toBe(1);
      runFrame();
      controller.handleScroll();
      expect(controller.followsLatest).toBe(true);
      runFrame();
      controller.handleScroll();
      expect(pane.scrollTop).toBe(pane.scrollHeight - pane.clientHeight);
      expect(controller.followsLatest).toBe(true);
      expect(callbacks.size).toBe(0);

      pane.scrollTop -= 100; // actual reader input must still stop following
      controller.handleScroll();
      expect(controller.followsLatest).toBe(false);
    },
  );

  it("restores a scrolled-up reader without enabling follow mode", () => {
    const { controller, pane, runFrame } = setup();
    pane.scrollTop = 100;
    controller.handleScroll();
    controller.setVisible(false);
    Object.assign(pane, { clientHeight: 0, scrollHeight: 0, scrollTop: 0 });
    controller.handleScroll();
    expect(controller.followsLatest).toBe(false);

    controller.setVisible(true);
    Object.assign(pane, { clientHeight: 300, scrollHeight: 1200 });
    controller.handleScroll();
    runFrame();
    expect(pane.scrollTop).toBe(100);
    expect(controller.followsLatest).toBe(false);
    controller.scheduleScrollToLatest();
    runFrame();
    expect(pane.scrollTop).toBe(100);
    pane.scrollTop = 900;
    controller.handleScroll();
    expect(controller.followsLatest).toBe(true);
  });

  it("retains the saved offset across rapid hide/show/hide before restoration", () => {
    const { controller, pane, callbacks, runFrame } = setup();
    pane.scrollTop = 100;
    controller.handleScroll();
    controller.setVisible(false);
    pane.scrollTop = 0;
    controller.setVisible(true);
    controller.setVisible(false);
    expect(callbacks.size).toBe(0);
    runFrame();
    expect(pane.scrollTop).toBe(0);
    controller.setVisible(true);
    runFrame();
    expect(pane.scrollTop).toBe(100);
    expect(controller.followsLatest).toBe(false);
  });

  it("waits for nonzero layout and ignores show scroll events until restored", () => {
    const { controller, pane, runFrame } = setup();
    controller.setVisible(false);
    Object.assign(pane, { clientHeight: 0, scrollHeight: 0, scrollTop: 0 });
    controller.setVisible(true);
    runFrame();
    expect(pane.scrollTop).toBe(0);
    Object.assign(pane, { clientHeight: 300, scrollHeight: 1200 });
    controller.handleScroll();
    controller.scheduleScrollToLatest(); // ResizeObserver retries after layout
    runFrame();
    expect(pane.scrollTop).toBe(1200);
    expect(controller.followsLatest).toBe(true);
  });

  it("defers an explicit latest action while hidden until the tab is shown", async () => {
    const { controller, pane, runFrame } = setup();
    pane.scrollTop = 100;
    controller.handleScroll();
    controller.setVisible(false);
    // Even a hidden pane with stale nonzero metrics must not be written to.
    await controller.scrollToLatest();
    expect(pane.scrollTop).toBe(100);
    expect(controller.followsLatest).toBe(true);
    pane.scrollHeight = 1200;
    controller.setVisible(true);
    runFrame();
    expect(pane.scrollTop).toBe(1200);
  });

  it("keeps following a sent image through composer collapse and render-time scroll events", async () => {
    const { controller, pane, runFrame } = setup({ clampScroll: true });

    const pending = controller.scrollToLatest();
    // Clearing the attachment composer and appending the compact preview can
    // emit a layout/queued scroll before the explicit action's tick completes.
    pane.clientHeight = 380;
    pane.scrollTop = 300; // browser clamps the offset as the composer shrinks
    pane.scrollHeight = 650;
    controller.handleScroll();
    await pending;
    expect(pane.scrollTop).toBe(270);
    expect(controller.followsLatest).toBe(true);

    // The image decodes later, after the explicit scroll has finished.
    pane.scrollHeight = 970;
    controller.scheduleScrollToLatest(); // content ResizeObserver
    runFrame();
    expect(pane.scrollTop).toBe(590);
    expect(controller.followsLatest).toBe(true);

    // Delayed image growth must not override subsequent reader intent.
    pane.scrollTop = 100;
    controller.handleScroll();
    pane.scrollHeight = 1100;
    controller.scheduleScrollToLatest();
    runFrame();
    expect(pane.scrollTop).toBe(100);
    expect(controller.followsLatest).toBe(false);
  });

  it("ignores queued old-offset scroll events while an explicit latest action awaits rendering", async () => {
    const { controller, pane } = setup({ clampScroll: true });
    pane.scrollTop = 100;
    controller.handleScroll();
    const pending = controller.scrollToLatest();
    controller.handleScroll();
    await pending;
    expect(pane.scrollTop).toBe(300);
    expect(controller.followsLatest).toBe(true);
  });

  it("keeps following when explicit latest actions overlap", async () => {
    const { controller, pane } = setup({ clampScroll: true });
    pane.scrollTop = 100;
    controller.handleScroll();
    const older = controller.scrollToLatest();
    const newer = controller.scrollToLatest();
    controller.handleScroll();
    await Promise.all([older, newer]);
    expect(pane.scrollTop).toBe(300);
    expect(controller.followsLatest).toBe(true);
  });

  it("cancels pending tab restoration on disposal", () => {
    const { controller, pane, callbacks, runFrame } = setup();
    controller.setVisible(false);
    pane.scrollTop = 0;
    controller.setVisible(true);
    controller.dispose();
    expect(callbacks.size).toBe(0);
    runFrame();
    expect(pane.scrollTop).toBe(0);
  });

  it("returns a conversation to the live edge despite transcript-replacement scroll events", () => {
    const { controller, pane, runFrame, activateSession } = setup();
    activateSession("session-2");
    Object.assign(pane, { scrollHeight: 1600, scrollTop: 0 });
    controller.handleScroll(); // replacement/layout event before restoration
    runFrame();
    expect(pane.scrollTop).toBe(1600);

    activateSession("session-1");
    Object.assign(pane, { scrollHeight: 900, scrollTop: 0 });
    controller.handleScroll();
    expect(controller.followsLatest).toBe(true);
    runFrame();
    expect(pane.scrollTop).toBe(900);
    pane.scrollHeight = 1200;
    controller.scheduleScrollToLatest();
    runFrame();
    expect(pane.scrollTop).toBe(1200);

    pane.scrollTop = 100;
    controller.handleScroll();
    expect(controller.followsLatest).toBe(false);
  });

  it("cancels outgoing scroll frames during rapid conversation switches", () => {
    const { controller, pane, callbacks, runFrame, activateSession } = setup();
    controller.scheduleScrollToLatest();
    const outgoingFrame = [...callbacks.keys()][0]!;
    activateSession("session-2");
    expect(callbacks.has(outgoingFrame)).toBe(false);
    const intermediateFrame = [...callbacks.keys()][0]!;
    activateSession("session-1");
    expect(callbacks.has(intermediateFrame)).toBe(false);
    expect(callbacks.size).toBe(1);
    pane.scrollHeight = 900;
    pane.scrollTop = 0;
    controller.handleScroll();
    runFrame();
    expect(pane.scrollTop).toBe(900);
  });

  it("does not reset a user's reading position when the active session is unchanged", () => {
    const { controller, pane, callbacks, runFrame, activateSession } = setup();
    activateSession("session-1");
    runFrame();
    pane.scrollTop = 100;
    controller.handleScroll();
    activateSession("session-1"); // workbench/status changes rerun App's effect
    expect(callbacks.size).toBe(0);
    expect(pane.scrollTop).toBe(100);
    expect(controller.followsLatest).toBe(false);
  });

  it("remembers the latest reading position independently for each conversation", () => {
    const { controller, pane, runFrame, activateSession } = setup({ clampScroll: true });
    activateSession("session-1");
    runFrame();
    pane.scrollTop = 100;
    controller.handleScroll();
    activateSession("session-2");
    Object.assign(pane, { scrollHeight: 1400, scrollTop: 0 });
    controller.handleScroll(); // outgoing DOM layout must not change reader state
    runFrame();
    pane.scrollTop = 450;
    controller.handleScroll();

    activateSession("session-1");
    Object.assign(pane, { scrollHeight: 900, scrollTop: 0 });
    runFrame();
    expect(pane.scrollTop).toBe(100);
    expect(controller.followsLatest).toBe(false);
    pane.scrollTop = 200; // not the original position at session activation
    controller.handleScroll();
    activateSession("session-2");
    Object.assign(pane, { scrollHeight: 1400, scrollTop: 0 });
    runFrame();
    expect(pane.scrollTop).toBe(450);
    expect(controller.followsLatest).toBe(false);
    activateSession("session-1");
    Object.assign(pane, { scrollHeight: 900, scrollTop: 0 });
    runFrame();
    expect(pane.scrollTop).toBe(200);
  });

  it("retains reader positions through rapid switches before restoration", () => {
    const { controller, pane, runFrame, activateSession } = setup();
    activateSession("session-1");
    runFrame();
    pane.scrollTop = 100;
    controller.handleScroll();
    activateSession("session-2");
    runFrame();
    pane.scrollTop = 150;
    controller.handleScroll();
    activateSession("session-1");
    pane.scrollTop = 0;
    activateSession("session-2");
    activateSession("session-1");
    runFrame();
    expect(pane.scrollTop).toBe(100);
    expect(controller.followsLatest).toBe(false);
  });

  it("restores a previously visited live follower to its new bottom", () => {
    const { controller, pane, runFrame, activateSession } = setup({ clampScroll: true });
    activateSession("session-1");
    runFrame();
    activateSession("session-2");
    runFrame();
    pane.scrollTop = 100;
    controller.handleScroll();
    activateSession("session-1");
    Object.assign(pane, { scrollHeight: 1500, scrollTop: 0 });
    controller.handleScroll();
    runFrame();
    expect(pane.scrollTop).toBe(1200);
    expect(controller.followsLatest).toBe(true);
    pane.scrollHeight = 1800;
    controller.scheduleScrollToLatest();
    runFrame();
    expect(pane.scrollTop).toBe(1500);
  });

  it("preserves conversation positions when switching sessions through a hidden pane", () => {
    const { controller, pane, runFrame, activateSession } = setup();
    activateSession("session-1");
    runFrame();
    pane.scrollTop = 100;
    controller.handleScroll();
    controller.setVisible(false);
    Object.assign(pane, { clientHeight: 0, scrollHeight: 0, scrollTop: 0 });
    activateSession("session-2");
    controller.setVisible(true);
    Object.assign(pane, { clientHeight: 300, scrollHeight: 900 });
    runFrame();
    activateSession("session-1");
    pane.scrollTop = 0;
    runFrame();
    expect(pane.scrollTop).toBe(100);
    expect(controller.followsLatest).toBe(false);
  });

  it("does not complete an outgoing explicit latest action in a different session", async () => {
    const { controller, pane, runFrame, activateSession } = setup();
    activateSession("session-1");
    runFrame();
    pane.scrollTop = 100;
    controller.handleScroll();
    activateSession("session-2");
    runFrame();
    const pending = controller.scrollToLatest();
    activateSession("session-1");
    pane.scrollTop = 0;
    await pending;
    expect(pane.scrollTop).toBe(0);
    runFrame();
    expect(pane.scrollTop).toBe(100);
    expect(controller.followsLatest).toBe(false);
  });

  it("ignores an old latest completion after switching away and back or disposing", async () => {
    const { controller, pane, runFrame, activateSession } = setup();
    vi.stubGlobal("CSS", { escape: (id: string) => id });
    Object.assign(pane, { querySelector: () => ({ scrollIntoView: vi.fn() }) });
    activateSession("session-1");
    runFrame();
    const pending = controller.scrollToLatest();
    activateSession("session-2");
    activateSession("session-1");
    controller.scrollToEntry("entry-1");
    pane.scrollTop = 100;
    await pending;
    expect(pane.scrollTop).toBe(100);
    expect(controller.followsLatest).toBe(false);

    const disposed = controller.scrollToLatest();
    controller.dispose();
    await disposed;
    expect(pane.scrollTop).toBe(100);
  });

  it("lets entry navigation supersede an explicit latest action awaiting rendering", async () => {
    const { controller, pane, runFrame, activateSession } = setup();
    vi.stubGlobal("CSS", { escape: (id: string) => id });
    const target = { scrollIntoView: vi.fn() };
    Object.assign(pane, { querySelector: () => target });
    activateSession("session-1");
    runFrame();
    const pending = controller.scrollToLatest();
    controller.scrollToEntry("entry-1");
    pane.scrollTop = 100;
    await pending;
    expect(pane.scrollTop).toBe(100);
    expect(controller.followsLatest).toBe(false);
    expect(target.scrollIntoView).toHaveBeenCalledOnce();
  });

  it("lets explicit entry navigation supersede pending restoration", () => {
    const { controller, pane, callbacks, runFrame, activateSession } = setup();
    vi.stubGlobal("CSS", { escape: (id: string) => id });
    const target = { scrollIntoView: vi.fn() };
    Object.assign(pane, { querySelector: () => target });
    activateSession("session-2");
    controller.scrollToEntry("entry-1");
    expect(callbacks.size).toBe(0);
    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    controller.scheduleScrollToLatest(); // later resize/stream must not restore
    runFrame();
    expect(pane.scrollTop).toBe(300);
    expect(controller.followsLatest).toBe(false);
  });
});

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

  it("ignores hidden-pane resize geometry in either follow mode", () => {
    for (const followsLatest of [true, false]) {
      expect(reconcileTranscriptResize(followsLatest, metrics(0, 0, 0))).toEqual({
        followsLatest,
        scrollToLatest: false,
      });
    }
  });
});
