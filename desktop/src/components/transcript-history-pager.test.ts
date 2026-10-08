import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranscriptHistoryPager } from "./transcript-history-pager";

describe("transcript history paging", () => {
  afterEach(() => vi.unstubAllGlobals());

  function setup(anchored = true) {
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    let entryTop = 10;
    const entry = {
      dataset: { transcriptEntryId: "entry" },
      getBoundingClientRect: () => ({ top: entryTop, bottom: entryTop + 100 }),
    };
    const pane = {
      scrollTop: 0, scrollHeight: 900, clientHeight: 300,
      getBoundingClientRect: () => ({ top: 0 }),
      querySelectorAll: () => anchored ? [entry] : [],
      querySelector: () => anchored ? entry : null,
    };
    let followsLatest = true;
    let restoring = false;
    let sessionId = "session-1";
    let currentPane: HTMLDivElement | null = pane as unknown as HTMLDivElement;
    const loadOlder = vi.fn(async () => false);
    const afterRender = vi.fn(async () => {});
    const pager = createTranscriptHistoryPager({
      pane: () => currentPane,
      activeSessionId: () => sessionId,
      followsLatest: () => followsLatest,
      restoring: () => restoring,
      loadOlder,
      afterRender,
    });
    return {
      pager, pane, loadOlder, afterRender,
      setEntryTop: (top: number) => { entryTop = top; },
      setFollowing: (value: boolean) => { followsLatest = value; },
      setRestoring: (value: boolean) => { restoring = value; },
      setSession: (value: string) => { sessionId = value; },
      setPane: (value: HTMLDivElement | null) => { currentPane = value; },
    };
  }

  it("does not page from the temporary top of a remounted following transcript", async () => {
    const { pager, loadOlder } = setup();
    await pager.loadAtTop(); // New Conversation destroyed the old pane; restore RAF has not run yet.
    expect(loadOlder).not.toHaveBeenCalled();
  });

  it("waits for a saved reader offset before deciding whether to fetch older history", async () => {
    const { pager, pane, loadOlder, setFollowing, setRestoring } = setup();
    setFollowing(false);
    setRestoring(true);
    await pager.loadAtTop();
    expect(loadOlder).not.toHaveBeenCalled();
    pane.scrollTop = 400;
    setRestoring(false);
    await pager.loadAtTop();
    expect(loadOlder).not.toHaveBeenCalled();
    pane.scrollTop = 50;
    await pager.loadAtTop();
    expect(loadOlder).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite latest-edge restoration with a pending prepend anchor", async () => {
    const { pager, pane, loadOlder, setEntryTop } = setup();
    pane.scrollHeight = 200; // A short or estimated tail may legitimately need another page.
    let complete!: (loaded: boolean) => void;
    loadOlder.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const pending = pager.loadAtTop();
    pane.scrollHeight = 900;
    pane.scrollTop = 600; // The scroll controller restores the latest edge while history is pending.
    setEntryTop(-200);
    complete(true);
    await pending;
    expect(pane.scrollTop).toBe(600);
  });

  it("preserves an up-scrolled reader's entry after prepend", async () => {
    const { pager, pane, loadOlder, setEntryTop, setFollowing } = setup();
    setFollowing(false);
    pane.scrollTop = 50;
    loadOlder.mockImplementation(async () => {
      pane.scrollHeight += 400;
      setEntryTop(410);
      return true;
    });
    await pager.loadAtTop();
    expect(pane.scrollTop).toBe(450);
  });

  it("does not correct a stale reader anchor after an explicit jump to latest", async () => {
    const { pager, pane, loadOlder, setEntryTop, setFollowing } = setup();
    setFollowing(false);
    loadOlder.mockImplementation(async () => {
      setFollowing(true);
      pane.scrollTop = 600;
      setEntryTop(-200);
      return true;
    });
    await pager.loadAtTop();
    expect(pane.scrollTop).toBe(600);
  });

  it("auto-fills a following short tail only until history overflows", async () => {
    const { pager, pane, loadOlder } = setup();
    pane.scrollHeight = 200;
    loadOlder.mockImplementation(async () => {
      pane.scrollHeight = loadOlder.mock.calls.length === 1 ? 250 : 900;
      return true;
    });
    await pager.loadAtTop();
    for (let turn = 0; turn < 4; turn++) await Promise.resolve();
    expect(loadOlder).toHaveBeenCalledTimes(2);
    expect(pane.scrollTop).toBe(0); // The follow controller, not an old entry anchor, owns the next scroll.
  });

  it("respects native anchoring without applying the prepend delta twice", async () => {
    const { pager, pane, loadOlder, setFollowing } = setup();
    setFollowing(false);
    loadOlder.mockImplementation(async () => {
      pane.scrollHeight += 400;
      pane.scrollTop = 400; // Browser has already kept the entry at its original viewport offset.
      return true;
    });
    await pager.loadAtTop();
    expect(pane.scrollTop).toBe(400);
  });

  it("uses height growth when the reader's concrete anchor is unavailable", async () => {
    const { pager, pane, loadOlder, setFollowing } = setup(false);
    setFollowing(false);
    pane.scrollTop = 50;
    loadOlder.mockImplementation(async () => {
      pane.scrollHeight += 400;
      return true;
    });
    await pager.loadAtTop();
    expect(pane.scrollTop).toBe(450);
  });

  it.each(["disposed", "replaced pane", "changed session"])(
    "ignores pending history completion for a %s owner", async (change) => {
      const { pager, pane, loadOlder, setEntryTop, setFollowing, setPane, setSession } = setup();
      setFollowing(false);
      let complete!: (loaded: boolean) => void;
      loadOlder.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
      const pending = pager.loadAtTop();
      if (change === "disposed") pager.dispose();
      if (change === "replaced pane") setPane({ ...pane } as unknown as HTMLDivElement);
      if (change === "changed session") setSession("session-2");
      setEntryTop(410);
      complete(true);
      await pending;
      for (let turn = 0; turn < 4; turn++) await Promise.resolve();
      expect(pane.scrollTop).toBe(0);
      expect(loadOlder).toHaveBeenCalledTimes(1);
    },
  );

  it("ignores hidden geometry and coalesces requests while a page waits", async () => {
    const { pager, pane, loadOlder, setFollowing } = setup();
    setFollowing(false);
    pane.clientHeight = 0;
    await pager.loadAtTop();
    expect(loadOlder).not.toHaveBeenCalled();
    pane.clientHeight = 300;
    let complete!: (loaded: boolean) => void;
    loadOlder.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const pending = pager.loadAtTop();
    await pager.loadAtTop();
    expect(loadOlder).toHaveBeenCalledTimes(1);
    complete(false);
    await pending;
  });
});
