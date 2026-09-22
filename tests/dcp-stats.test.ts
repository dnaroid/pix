import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatDcpStatsDialog, formatDcpStatsToast, loadDcpStatsDialog, loadDcpStatsToast } from "../src/app/rendering/dcp-stats.js";
import { collectDcpStatistics, collectDcpStatisticsAsync, formatDcpStatistics } from "../external/pi-tools-suite/src/dcp/statistics.js";
import { THEMES } from "../src/theme.js";

const custom = (customType: string, data: unknown) => ({ type: "custom", customType, data });
const init = custom("dcp-journal", { schemaVersion: 1, kind: "init", operationId: "init-one", previousOperationId: null });
const delta = (data: any = {}, operationId = "delta-one", previousOperationId = "init-one") => custom("dcp-journal", {
  schemaVersion: 1, kind: "delta", operationId, previousOperationId, ...data,
});
const diag = (event: string, data: any = {}) => custom("dcp-diagnostic", { version: 1, event, epoch: "epoch-a", ...data });
const model = { provider: "fixture", id: "model", contextWindow: 100_000, maxTokens: 4_000 };
const snapshot = { model: "fixture/model", contextWindow: 100_000, rawTokens: 50_000, projectedTokens: 20_000,
  inputCapacityTokens: 96_000, reservedOutputTokens: 4_000, routineTokens: 8_000, strongTokens: 15_000,
  hardTokens: 82_000, pressure: "strong", reason: "complete", enabled: true, manualMode: false, autoEnabled: true, createdAt: 1_700_000_000_000 };
const metrics = (operationId: string, kind: string, gain: number) => ({ operationId, kind, beforeTokens: gain + 1_000, afterTokens: 1_000, netGainTokens: gain });
function session(branch: any[], manager: any = {}) {
  return { model, getContextUsage: () => ({ tokens: 20_000, contextWindow: 100_000 }), sessionManager: { getBranch: () => branch, ...manager } } as any;
}

describe("DCP shared statistics", () => {
	it("cooperatively collects the same statistics as the synchronous reducer", async () => {
		const branch = [init, delta({ blocks: [
			{ id: 1, active: true, summaryTokenEstimate: 20, commitMetrics: metrics("auto:1", "auto", 50) },
		] }), diag("epoch"), diag("request", { id: "request", reminder: true, snapshot }), diag("completion", { id: "request", reminder: true, ignored: 0 })];
		assert.deepEqual(await collectDcpStatisticsAsync({ branch, model }, { chunkSize: 1 }), collectDcpStatistics({ branch, model }));
	});

	it("yields to timers while loading a large dialog history and suppresses a changed owner", async () => {
		const branch = [init, ...Array.from({ length: 2_000 }, () => custom("dcp-nudge", { event: "emitted" }))];
		const s = session([], { readFullBranchEntries: async () => branch });
		let timerRan = false;
		const timer = new Promise<void>((resolve) => setTimeout(() => { timerRan = true; resolve(); }, 0));
		const loading = loadDcpStatsDialog(s, THEMES.dark).then((result) => {
			assert.equal(timerRan, true, "the timer must run before dialog loading completes");
			return result;
		});
		await timer;
		assert.equal(timerRan, true);
		assert.notEqual(await loading, undefined);

		const changed = session([], { readFullBranchEntries: async () => branch });
		setTimeout(() => { changed.model = { ...model, id: "new-owner" }; }, 0);
		assert.equal(await loadDcpStatsDialog(changed, THEMES.dark), undefined);
	});

  it("reports actual journal commits, not blocks-as-operations; measures auto gains without tool results", () => {
    const branch = [init, delta({ blocks: [
      { id: 1, active: false, summaryTokenEstimate: 80, createdByToolCallId: "call-a", commitMetrics: metrics("manual:call-a", "manual", 500) },
      { id: 2, active: false, summaryTokenEstimate: 70, createdByToolCallId: "call-a" },
      { id: 3, active: true, summaryTokenEstimate: 20, autoSummaryRepresentation: "extractive", commitMetrics: metrics("auto:3", "consolidation", 100) },
      { id: 4, active: true, summaryTokenEstimate: 50, autoSummaryRepresentation: "model", commitMetrics: metrics("auto:4", "auto", 1_000) },
    ], prunedTools: [{ toolCallId: "p", tokenEstimate: 200 }] })];
    const stats = collectDcpStatistics({ branch, model });
    assert.equal(stats.activity.manual.size, 1);
    assert.equal(stats.activity.auto.size, 1);
    assert.equal(stats.activity.consolidation.size, 1);
    assert.equal(stats.measuredGain, 1_600);
    assert.equal(stats.summaryTokens, 70);
    const text = formatDcpStatsToast(session(branch));
    assert.match(text, /Blocks: 2 active \/ 2 retired \/ 4 total/);
    assert.match(text, /Measured commit gain: 1,600 tokens \(3 measured commits/);
    assert.doesNotMatch(text, /Compliance proxy|Total pruning operations|Tokens saved \(estimated\)/);
  });

  it("deduplicates journal replay and separates projection events, attempts and confirmed opportunities", () => {
    const d = delta({ nudgeAnchors: [{ id: 1, type: "iteration", anchorRole: "toolResult" }] });
    const branch = [init, d, d, diag("epoch"),
      custom("dcp-nudge", { event: "emitted", type: "iteration", anchorRole: "toolResult" }),
      ...Array.from({ length: 9 }, () => custom("dcp-nudge", { event: "reapplied", type: "iteration", anchorRole: "toolResult" })),
      diag("request", { id: "attempt-1", reminder: true, snapshot }),
      diag("request", { id: "attempt-2", reminder: true, snapshot }),
      diag("completion", { id: "attempt-2", reminder: true, ignored: 1 }),
      diag("completion", { id: "attempt-2", reminder: true, ignored: 1 }),
      diag("completion", { id: "unrelated", reminder: true, ignored: 100 }),
    ];
    const stats = collectDcpStatistics({ branch, model });
    assert.equal(stats.published, 1); assert.equal(stats.projections, 10);
    assert.equal(stats.attempts, 2); assert.equal(stats.completed, 1); assert.equal(stats.ignored, 1);
    const text = formatDcpStatsToast(session(branch));
    assert.match(text, /routine 8.0% \/ strong 15.0% \/ hard 82.0%/);
    assert.match(text, /Input capacity: 96,000/);
    assert.match(text, /iteration\/toolResult/);
    assert.match(text, /Last DCP request: ~20,000/);
  });

  it("does not turn missing old instrumentation into zero saved tokens or zero deliveries", () => {
    const text = formatDcpStatsToast(session([init, delta({ blocks: [{ id: 1, active: true, summaryTokenEstimate: 32 }] })]));
    assert.match(text, /Measured commit gain: unknown/);
    assert.match(text, /confirmed completed opportunities: unknown/);
    assert.match(text, /Provenance unknown: 1 blocks/);
  });

  it("invalidates last request policy on model changes and runtime epoch transitions", () => {
    const branch = [init, diag("epoch"), diag("request", { id: "x", snapshot })];
    const s = session(branch); s.model = { ...model, id: "small", contextWindow: 32_000 };
    s.getContextUsage = () => ({ tokens: 20_000, contextWindow: 100_000 });
    const text = formatDcpStatsToast(s);
    assert.match(text, /20,000 \/ 32,000 \(62.5%/);
    assert.match(text, /stale \(model\/window changed\)/);
    assert.doesNotMatch(text, /Input capacity: 96,000/);
    assert.equal(collectDcpStatistics({ branch, model: { ...model, contextWindow: 32_000 } }).snapshot, undefined);
    branch.push(diag("epoch", { epoch: "epoch-b" }));
    assert.equal(collectDcpStatistics({ branch, model }).snapshot, undefined);
    assert.equal(collectDcpStatistics({ branch, model }).ignored, undefined);
  });

  it("reads the full branch rather than a lazy cursor; does not fall back after full-read failure", () => {
    const branch = [init, delta({ blocks: [{ id: 1, active: true, summaryTokenEstimate: 20 }] })];
    assert.match(formatDcpStatsToast(session([], { readFullBranchEntriesSync: () => branch })), /Blocks: 1 active/);
    let tailReads = 0;
    const text = formatDcpStatsToast(session(branch, { readFullBranchEntriesSync() { throw new Error("disk read failed"); }, getBranch() { tailReads++; return branch; } }));
    assert.equal(tailReads, 0);
    assert.match(text, /full history could not be read/);
    assert.match(text, /unknown \(not zero\)/);
  });

  it("uses the injected active branch for ACP without any synchronous disk traversal", () => {
    const s = session([], { readFullBranchEntriesSync() { throw new Error("must not be called"); } });
    const text = formatDcpStatsToast(s, { branch: [init] });
    assert.match(text, /chain verified/);
    assert.equal(text, formatDcpStatistics({ branch: [init], model, usage: s.getContextUsage() }));
  });

  it("loads async full history for the TUI and refuses an obsolete model snapshot", async () => {
    let syncReads = 0;
    let finish!: (value: any[]) => void;
    const pending = new Promise<any[]>((resolve) => { finish = resolve; });
    const s = session([], { readFullBranchEntries: () => pending,
      readFullBranchEntriesSync() { syncReads++; throw new Error("not on this path"); } });
    const loading = loadDcpStatsToast(s);
    s.model = { ...model, id: "replacement" };
    finish([init]);
    assert.match(await loading, /full history could not be read/);
    assert.equal(syncReads, 0);
    assert.match(await loadDcpStatsToast(s), /chain verified/);
  });

  it("renders dialog runtime data with unavailable history without synchronously reading a lazy cursor", async () => {
    let syncReads = 0;
    let cursorReads = 0;
    const s = session([], {
      readFullBranchEntriesSync() { syncReads++; return [init]; },
      getBranch() { cursorReads++; return [init]; },
    });
    s.sessionManager[Symbol.for("pix.dcp.session-runtime-stats")] = () => ({
      tokensSaved: 321,
      contextMap: { revision: 1, sessionEpoch: 0, generatedAt: 1, tokenEstimates: { retained: 10, candidate: 20, protected: 30, compressed: 40 } },
    });

    const text = (await loadDcpStatsDialog(s, THEMES.dark) ?? "").replace(/\x1b\[[\d;:]*m/gu, "");
    assert.equal(syncReads, 0);
    assert.equal(cursorReads, 0);
    assert.match(text, /DCP saved ~321/);
    assert.match(text, /Candidates ~20/);
    assert.match(text, /full history unavailable/);
  });

  it("renders the Pix DCP dialog with live capacity categories and compact Desktop metrics", () => {
    const branch = [init, delta({ blocks: [
      { id: 1, active: true, summaryTokenEstimate: 50, autoSummaryRepresentation: "model", commitMetrics: metrics("auto:1", "auto", 1_500) },
    ] }), diag("epoch"), diag("request", { id: "x", snapshot })];
    const text = formatDcpStatsDialog(session(branch), THEMES.dark, {
      branch,
      runtimeStats: {
        tokensSaved: 24_680,
        contextMap: {
          revision: 3, sessionEpoch: 0, generatedAt: 1_700_000_000_000,
          tokenEstimates: { retained: 5_000, candidate: 7_000, protected: 3_000, compressed: 1_000 },
        },
      },
    });
    const plain = text.replace(/\x1b\[[\d;:]*m/gu, "");
    assert.match(plain, /DCP session statistics/);
    assert.match(plain, /Context\s+20% · 20K \/ 100K tokens/);
    assert.match(plain, /Other ~9K/);
    assert.match(plain, /Candidates ~7K/);
    assert.match(plain, /Protected ~3K/);
    assert.match(plain, /Summaries ~1K/);
    assert.match(plain, /Free ~80K/);
    assert.match(plain, /DCP saved ~24\.7K\s+Measured gain 1\.5K · 1 commits/);
    assert.match(plain, /Last projection\s+50K → 20K · ~30K reduction/);
    assert.match(plain, /Journal blocks\s+1 active · 0 retired/);
  });

  it("reads live DCP telemetry only from the owning session manager bridge", () => {
    const s = session([init]);
    const other = session([init]);
    const symbol = Symbol.for("pix.dcp.session-runtime-stats");
    s.sessionManager[symbol] = () => ({
      tokensSaved: 3210,
      contextMap: {
        revision: 1, sessionEpoch: 0, generatedAt: 1,
        tokenEstimates: { retained: 1000, candidate: 2000, protected: 3000, compressed: 4000 },
      },
    });
    other.sessionManager[symbol] = () => ({ tokensSaved: 999_999 });

    const text = formatDcpStatsDialog(s, THEMES.dark, { branch: [init] })
      .replace(/\x1b\[[\d;:]*m/gu, "");
    assert.match(text, /DCP saved ~3\.21K/);
    assert.match(text, /Candidates ~2K/);
    assert.doesNotMatch(text, /999K|1M/);
  });

  it("does not infer free capacity in the Pix DCP dialog when SDK usage is unknown", () => {
    const s = session([init]);
    s.getContextUsage = () => ({ tokens: null, contextWindow: 100_000 });
    const text = formatDcpStatsDialog(s, THEMES.dark, {
      branch: [init],
      runtimeStats: { contextMap: { revision: 1, sessionEpoch: 0, generatedAt: 1, tokenEstimates: { retained: 1, candidate: 1, protected: 0, compressed: 0 } } },
    }).replace(/\x1b\[[\d;:]*m/gu, "");
    assert.match(text, /Context\s+unknown/);
    assert.match(text, /Capacity unknown/);
    assert.match(text, /free space is not inferred/i);
    assert.doesNotMatch(text, /Free ~/);
  });

  for (const [name, branch] of [
    ["missing init", [delta()]],
    ["wrong predecessor", [init, delta({}, "d", "missing")]],
    ["conflicting duplicate", [init, delta(), delta({ manualMode: true })]],
    ["unsupported schema", [custom("dcp-journal", { ...init.data as any, schemaVersion: 99 })]],
  ] as const) it(`marks ${name} unknown instead of returning reassuring zeroes`, () => {
    const text = formatDcpStatsToast(session([...branch]));
    assert.match(text, /unknown \(not zero\)/);
    assert.doesNotMatch(text, /Blocks: 0 active|chain verified/);
  });
});
