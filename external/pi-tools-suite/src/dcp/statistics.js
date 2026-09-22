// Shared, dependency-free presentation for the extension, TUI and ACP. Plain
// ESM is intentional: the compiled host can import the shipped extension source
// without loading TypeScript or bringing the extension runtime into the host.

/** @param {any} v */
const finite = (v) => typeof v === "number" && Number.isFinite(v);
/** @param {any} v */
const num = (v) => finite(v) ? Math.round(v).toLocaleString("en-US") : "unknown";
/** @param {any} n @param {any} d */
const percent = (n, d) => finite(n) && finite(d) && d > 0 ? `${(100 * n / d).toFixed(1)}%` : "unknown";
/** @param {any} v */
const mode = (v) => typeof v === "boolean" ? (v ? "on" : "off") : "unknown";
/** @param {any} m */
const modelRef = (m) => m?.provider && m?.id ? `${m.provider}/${m.id}` : undefined;
/** @param {any} v */
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function createState() {
  const blocks = new Map(), pruned = new Map(), operations = new Map(), measured = new Map();
  let journal = "absent", previous = null, anchors = [], manualMode;
  let epoch, snapshot, lastReminder, ignored, evidenceEpoch = false;
  let projections = 0, attempts = 0, completed = 0, rejected = 0;
  const publishedIds = new Set();
  const attemptIds = new Set(), completionIds = new Set(), manualFailures = new Set();
  const diagnostics = [];
  return { blocks, pruned, operations, measured, journal, previous, anchors, manualMode, epoch, snapshot, lastReminder, ignored, evidenceEpoch, stopped: false,
    projections, attempts, completed, rejected, publishedIds, attemptIds, completionIds, manualFailures, diagnostics };
}

/** @param {ReturnType<typeof createState>} state @param {any} entry */
function reduceEntry(state, entry) {
    if (state.stopped) return;
    let { blocks, pruned, operations, measured, journal, previous, anchors, manualMode, projections, lastReminder } = state;
    if (entry?.type === "custom" && entry.customType === "dcp-journal") {
      const op = entry.data;
      if (!record(op) || op.schemaVersion !== 1 || !["init", "delta"].includes(op.kind) || typeof op.operationId !== "string") {
        state.journal = "invalid/unsupported"; state.stopped = true; return;
      }
      if (operations.has(op.operationId)) {
        if (operations.get(op.operationId) !== JSON.stringify(op)) { state.journal = "conflicting operations"; state.stopped = true; }
        return;
      }
      if ((op.kind === "init" && (previous !== null || op.previousOperationId !== null)) ||
          (op.kind === "delta" && (previous === null || op.previousOperationId !== previous))) {
        state.journal = "incomplete/broken chain"; state.stopped = true; return;
      }
      previous = op.operationId;
      operations.set(previous, JSON.stringify(op));
      journal = state.journal = "chain verified";
      for (const b of op.blocks ?? []) {
        if (!record(b) || !finite(b.id) || typeof b.active !== "boolean" || blocks.has(b.id)) { journal = state.journal = "invalid blocks"; state.stopped = true; break; }
        blocks.set(b.id, { ...b });
        const m = b.commitMetrics;
        if (record(m) && typeof m.operationId === "string" && finite(m.netGainTokens) && m.netGainTokens > 0 &&
            finite(m.beforeTokens) && finite(m.afterTokens) && m.beforeTokens - m.afterTokens === m.netGainTokens) measured.set(m.operationId, m);
      }
      if (journal !== "chain verified") return;
      for (const update of op.blockStates ?? []) {
        const b = blocks.get(update.id);
        if (!b || typeof update.active !== "boolean" || (!b.active && update.active)) { journal = state.journal = "invalid block states"; state.stopped = true; break; }
        b.active = update.active;
      }
      if (journal !== "chain verified") return;
      for (const p of op.prunedTools ?? []) if (typeof p?.toolCallId === "string") pruned.set(p.toolCallId, p);
      if (Array.isArray(op.nudgeAnchors)) {
        anchors = op.nudgeAnchors;
        state.anchors = anchors;
        for (const anchor of anchors) state.publishedIds.add(anchor.id);
      }
      if (typeof op.manualMode === "boolean") state.manualMode = manualMode = op.manualMode;
      state.previous = previous;
    }
    if (entry?.type === "custom" && entry.customType === "dcp-nudge") {
      const e = entry.data;
      if (["emitted", "reapplied", "upgraded"].includes(e?.event)) { state.projections = ++projections; state.lastReminder = lastReminder = e; }
    }
    if (entry?.type === "custom" && entry.customType === "dcp-diagnostic" && entry.data?.version === 1) state.diagnostics.push(entry.data);
    if (entry?.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "compress" && entry.message.isError) {
      state.manualFailures.add(entry.message.toolCallId ?? entry.id);
    }
}

/** @param {ReturnType<typeof createState>} state @param {any} d */
function reduceDiagnostic(state, d) {
  // Epoch markers invalidate live measurements/evidence, not durable history.
    if (d.event === "epoch") { state.epoch = d.epoch; state.snapshot = undefined; state.ignored = 0; state.evidenceEpoch = true; }
    if (d.event === "request" && d.epoch === state.epoch) {
      state.snapshot = d.snapshot;
      if (finite(state.snapshot?.ignored)) state.ignored = state.snapshot.ignored;
      if (d.reminder && !state.attemptIds.has(d.id)) { state.attempts++; state.attemptIds.add(d.id); }
    }
    if (d.event === "completion" && d.epoch === state.epoch && !state.completionIds.has(d.id) && (!d.reminder || state.attemptIds.has(d.id))) {
      if (d.reminder) state.completed++;
      state.completionIds.add(d.id); state.ignored = d.ignored;
    }
    if (d.event === "auto-rejected") state.rejected++;
}

/** @param {ReturnType<typeof createState>} state @param {import('./statistics.js').DcpStatisticsInput} input */
function finishStatistics(state, input) {
  const valid = state.journal === "chain verified" && input.historyStatus !== "unavailable";
  const all = valid ? [...state.blocks.values()] : [];
  const active = all.filter((b) => b.active);
  const activity = { manual: new Set(), auto: new Set(), consolidation: new Set(), unknownBlocks: 0 };
  for (const b of all) {
    const kind = b.commitMetrics?.kind ?? (b.createdByToolCallId ? "manual" : b.autoSummaryRepresentation
      ? ((b.coveredBlockIds?.length ?? 0) >= 2 && b.sourceCoverage?.itemCount === b.coveredBlockIds.length ? "consolidation" : "auto") : undefined);
    const bucket = kind === "manual" ? activity.manual : kind === "auto" ? activity.auto : kind === "consolidation" ? activity.consolidation : undefined;
    if (bucket) bucket.add(b.commitMetrics?.operationId ?? (kind === "manual" ? `manual:${b.createdByToolCallId}` : `auto:${b.id}`));
    else activity.unknownBlocks++;
  }
  return statisticsResult(state, input, valid, all, active, activity);
}

function statisticsResult(state, input, valid, all, active, activity) {
  const currentWindow = input.model?.contextWindow;
  const snapshotMatchesModel = state.snapshot && modelRef(input.model) === state.snapshot.model &&
    (!finite(currentWindow) || currentWindow === state.snapshot.contextWindow);
  return { valid, journal: state.journal, operations: state.operations.size, all, active, pruned: valid ? state.pruned.size : undefined,
    summaryTokens: valid && active.every((b) => finite(b.summaryTokenEstimate)) ? active.reduce((s,b) => s + b.summaryTokenEstimate, 0) : undefined,
    manualMode: state.manualMode, activity, measured: valid ? state.measured.size : undefined,
    measuredGain: valid && state.measured.size ? [...state.measured.values()].reduce((s,m) => s + m.netGainTokens, 0) : valid && all.length === 0 ? 0 : undefined,
    snapshot: snapshotMatchesModel ? state.snapshot : undefined, snapshotStale: Boolean(state.snapshot && !snapshotMatchesModel),
    published: state.publishedIds.size, projections: state.projections, attempts: state.evidenceEpoch ? state.attempts : undefined, completed: state.evidenceEpoch ? state.completed : undefined,
    ignored: snapshotMatchesModel ? state.ignored : undefined, anchors: valid ? state.anchors : [], lastReminder: state.lastReminder,
    rejected: state.evidenceEpoch ? state.rejected : undefined, manualFailures: state.manualFailures.size };
}

/** Read-only diagnostic reducer. Never runs the pruner, a model, or a mutation.
 * @param {import('./statistics.js').DcpStatisticsInput} input */
export function collectDcpStatistics(input) {
  const state = createState();
  for (const entry of input.branch ?? []) { reduceEntry(state, entry); if (state.stopped) break; }
  for (const diagnostic of state.diagnostics) reduceDiagnostic(state, diagnostic);
  return finishStatistics(state, input);
}

const yieldToEventLoop = () => new Promise((resolve) => setTimeout(resolve, 0));

/** @param {ReturnType<typeof createState>} state @param {import('./statistics.js').DcpStatisticsInput} input @param {number} chunkSize */
async function finishStatisticsAsync(state, input, chunkSize) {
  const valid = state.journal === "chain verified" && input.historyStatus !== "unavailable";
  const active = [], activity = { manual: new Set(), auto: new Set(), consolidation: new Set(), unknownBlocks: 0 };
  const all = [];
  let summaryTokens = 0, summariesKnown = true, measuredGain = 0, blockCount = 0;
  if (valid) for (const b of state.blocks.values()) {
    all.push(b);
    if (b.active) { active.push(b); if (finite(b.summaryTokenEstimate)) summaryTokens += b.summaryTokenEstimate; else summariesKnown = false; }
    const kind = b.commitMetrics?.kind ?? (b.createdByToolCallId ? "manual" : b.autoSummaryRepresentation
      ? ((b.coveredBlockIds?.length ?? 0) >= 2 && b.sourceCoverage?.itemCount === b.coveredBlockIds.length ? "consolidation" : "auto") : undefined);
    const bucket = kind === "manual" ? activity.manual : kind === "auto" ? activity.auto : kind === "consolidation" ? activity.consolidation : undefined;
    if (bucket) bucket.add(b.commitMetrics?.operationId ?? (kind === "manual" ? `manual:${b.createdByToolCallId}` : `auto:${b.id}`)); else activity.unknownBlocks++;
    if (++blockCount % chunkSize === 0) await yieldToEventLoop();
  }
  let measuredCount = 0;
  if (valid) for (const metric of state.measured.values()) {
    measuredGain += metric.netGainTokens;
    if (++measuredCount % chunkSize === 0) await yieldToEventLoop();
  }
  const result = statisticsResult(state, input, valid, all, active, activity);
  result.summaryTokens = valid && summariesKnown ? summaryTokens : undefined;
  result.measuredGain = valid && measuredCount ? measuredGain : valid && all.length === 0 ? 0 : undefined;
  return result;
}

/** Cooperatively reduces a complete branch on the main thread. It yields between
 * bounded chunks; it does not move history parsing to another thread.
 * @param {import('./statistics.js').DcpStatisticsInput} input
 * @param {{ chunkSize?: number }} [options] */
export async function collectDcpStatisticsAsync(input, options = {}) {
  const chunkSize = Number.isSafeInteger(options.chunkSize) && options.chunkSize > 0 ? options.chunkSize : 256;
  const state = createState(), entries = input.branch ?? [];
  for (let i = 0; i < entries.length; i++) {
    reduceEntry(state, entries[i]);
    if (state.stopped) break;
    if ((i + 1) % chunkSize === 0) await yieldToEventLoop();
  }
  for (let i = 0; i < state.diagnostics.length; i++) {
    reduceDiagnostic(state, state.diagnostics[i]);
    if ((i + 1) % chunkSize === 0) await yieldToEventLoop();
  }
  return finishStatisticsAsync(state, input, chunkSize);
}

/** @param {import('./statistics.js').DcpStatisticsInput} input */
export function formatDcpStatistics(input) {
  let s;
  try { s = collectDcpStatistics(input); }
  catch { return "DCP Session Statistics\n\nHistory unavailable: malformed diagnostic/journal records. No zero statistics inferred."; }
  const usage = input.usage ?? {}, m = input.model, snap = s.snapshot;
  const window = finite(m?.contextWindow) && m.contextWindow > 0 ? m.contextWindow : usage.contextWindow;
  const lines = ["DCP Session Statistics:", "Context",
    `  Model: ${modelRef(m) ?? "unknown"}`,
    `  SDK usage: ${num(usage.tokens)} / ${num(window)} (${percent(usage.tokens, window)}; may lag)`,
  ];
  if (snap) {
    lines.push(`  Last DCP request: ~${num(snap.projectedTokens)} tokens; ${snap.pressure} (${snap.reason})`,
      `  Input capacity: ${num(snap.inputCapacityTokens)}; reserved output: ${num(snap.reservedOutputTokens)}`,
      `  Resolved thresholds: routine ${percent(snap.routineTokens, snap.contextWindow)} / strong ${percent(snap.strongTokens, snap.contextWindow)} / hard ${percent(snap.hardTokens, snap.contextWindow)}`,
      `  Modes (last request): DCP ${mode(snap.enabled)}, manual ${mode(snap.manualMode)}, auto ${mode(snap.autoEnabled)}`,
      `  Snapshot: ${finite(snap.createdAt) && Math.abs(snap.createdAt) < 8.64e15 ? new Date(snap.createdAt).toISOString() : "unknown time"} (last request)`);
  } else lines.push(`  DCP budget/thresholds: ${s.snapshotStale ? "stale (model/window changed); awaiting projection" : "not recorded; awaiting projection"}`);
  lines.push("History projection (active branch)");
  if (!s.valid) {
    lines.push(`  Unavailable: ${input.historyStatus === "unavailable" ? "full history could not be read" : s.journal}`,
      "  Blocks, gains and reminders: unknown (not zero)");
    return lines.join("\n");
  }
  lines.push(`  Blocks: ${s.active.length} active / ${s.all.length - s.active.length} retired / ${s.all.length} total`,
    `  Active summaries: ~${num(s.summaryTokens)} tokens; result bodies pruned: ${num(s.pruned)}`);
  if (snap) lines.push(`  Input/projection: ~${num(snap.rawTokens)} -> ~${num(snap.projectedTokens)} (reduction ~${num(snap.rawTokens - snap.projectedTokens)})`);
  lines.push("Compression activity",
    `  Commits: ${s.activity.manual.size} model/tool, ${s.activity.auto.size} auto, ${s.activity.consolidation.size} consolidations`);
  if (s.activity.unknownBlocks) lines.push(`  Provenance unknown: ${s.activity.unknownBlocks} blocks`);
  lines.push(`  Measured commit gain: ${num(s.measuredGain)} tokens (${num(s.measured)} measured commits)`,
    `  Rejections recorded: ${num(s.rejected)} auto; ${num(s.manualFailures)} failed compress results`,
    "Reminder delivery",
    `  Anchors journaled: ${s.published}; projection events: ${s.projections} (not sends)`,
    `  Recorded provider attempts with reminder: ${num(s.attempts)}`,
    `  confirmed completed opportunities: ${num(s.completed)}`,
    `  Outstanding consecutive opportunities (last sample): ${num(s.ignored)}`,
    `  Active anchors: ${s.anchors.length}${s.anchors.length ? " (" + s.anchors.map((/** @type {any} */ a) => `${a.type}/${a.anchorRole ?? "unknown carrier"}`).join(", ") + ")" : ""}`,
    `  Last published/reapplied: ${s.lastReminder ? `${s.lastReminder.type} / ${s.lastReminder.anchorRole ?? "unknown carrier"}` : "none recorded"}`,
    `Journal: ${s.journal} (${s.operations} records); full active branch`,
    "Estimates, not billing. Old unmeasured gains/deliveries excluded.");
  return lines.join("\n");
}
