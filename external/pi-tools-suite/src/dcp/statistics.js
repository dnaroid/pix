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

/** Read-only diagnostic reducer. Never runs the pruner, a model, or a mutation.
 * @param {import('./statistics.js').DcpStatisticsInput} input */
export function collectDcpStatistics(input) {
  const entries = input.branch ?? [];
  const blocks = new Map(), pruned = new Map(), operations = new Map(), measured = new Map();
  let journal = "absent", previous = null, anchors = [], manualMode;
  let epoch, snapshot, lastReminder, ignored, evidenceEpoch = false;
  let projections = 0, attempts = 0, completed = 0, rejected = 0;
  const publishedIds = new Set();
  const attemptIds = new Set(), completionIds = new Set(), manualFailures = new Set();
  const diagnostics = [];
  for (const entry of entries) {
    if (entry?.type === "custom" && entry.customType === "dcp-journal") {
      const op = entry.data;
      if (!record(op) || op.schemaVersion !== 1 || !["init", "delta"].includes(op.kind) || typeof op.operationId !== "string") {
        journal = "invalid/unsupported"; break;
      }
      if (operations.has(op.operationId)) {
        if (operations.get(op.operationId) !== JSON.stringify(op)) { journal = "conflicting operations"; break; }
        continue;
      }
      if ((op.kind === "init" && (previous !== null || op.previousOperationId !== null)) ||
          (op.kind === "delta" && (previous === null || op.previousOperationId !== previous))) {
        journal = "incomplete/broken chain"; break;
      }
      previous = op.operationId;
      operations.set(previous, JSON.stringify(op));
      journal = "chain verified";
      for (const b of op.blocks ?? []) {
        if (!record(b) || !finite(b.id) || typeof b.active !== "boolean" || blocks.has(b.id)) { journal = "invalid blocks"; break; }
        blocks.set(b.id, { ...b });
        const m = b.commitMetrics;
        if (record(m) && typeof m.operationId === "string" && finite(m.netGainTokens) && m.netGainTokens > 0 &&
            finite(m.beforeTokens) && finite(m.afterTokens) && m.beforeTokens - m.afterTokens === m.netGainTokens) measured.set(m.operationId, m);
      }
      if (journal !== "chain verified") break;
      for (const update of op.blockStates ?? []) {
        const b = blocks.get(update.id);
        if (!b || typeof update.active !== "boolean" || (!b.active && update.active)) { journal = "invalid block states"; break; }
        b.active = update.active;
      }
      if (journal !== "chain verified") break;
      for (const p of op.prunedTools ?? []) if (typeof p?.toolCallId === "string") pruned.set(p.toolCallId, p);
      if (Array.isArray(op.nudgeAnchors)) {
        anchors = op.nudgeAnchors;
        for (const anchor of anchors) publishedIds.add(anchor.id);
      }
      if (typeof op.manualMode === "boolean") manualMode = op.manualMode;
    }
    if (entry?.type === "custom" && entry.customType === "dcp-nudge") {
      const e = entry.data;
      if (["emitted", "reapplied", "upgraded"].includes(e?.event)) { projections++; lastReminder = e; }
    }
    if (entry?.type === "custom" && entry.customType === "dcp-diagnostic" && entry.data?.version === 1) diagnostics.push(entry.data);
    if (entry?.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "compress" && entry.message.isError) {
      manualFailures.add(entry.message.toolCallId ?? entry.id);
    }
  }
  // Epoch markers invalidate live measurements/evidence, not durable history.
  for (const d of diagnostics) {
    if (d.event === "epoch") { epoch = d.epoch; snapshot = undefined; ignored = 0; evidenceEpoch = true; }
    if (d.event === "request" && d.epoch === epoch) {
      snapshot = d.snapshot;
      if (finite(snapshot?.ignored)) ignored = snapshot.ignored;
      if (d.reminder && !attemptIds.has(d.id)) { attempts++; attemptIds.add(d.id); }
    }
    if (d.event === "completion" && d.epoch === epoch && !completionIds.has(d.id) && (!d.reminder || attemptIds.has(d.id))) {
      if (d.reminder) completed++;
      completionIds.add(d.id); ignored = d.ignored;
    }
    if (d.event === "auto-rejected") rejected++;
  }
  const valid = journal === "chain verified" && input.historyStatus !== "unavailable";
  const all = valid ? [...blocks.values()] : [];
  const active = all.filter((b) => b.active);
  const activity = { manual: new Set(), auto: new Set(), consolidation: new Set(), unknownBlocks: 0 };
  for (const b of all) {
    const kind = b.commitMetrics?.kind ?? (b.createdByToolCallId ? "manual" : b.autoSummaryRepresentation
      ? ((b.coveredBlockIds?.length ?? 0) >= 2 && b.sourceCoverage?.itemCount === b.coveredBlockIds.length ? "consolidation" : "auto") : undefined);
    const bucket = kind === "manual" ? activity.manual : kind === "auto" ? activity.auto : kind === "consolidation" ? activity.consolidation : undefined;
    if (bucket) bucket.add(b.commitMetrics?.operationId ?? (kind === "manual" ? `manual:${b.createdByToolCallId}` : `auto:${b.id}`));
    else activity.unknownBlocks++;
  }
  const currentWindow = input.model?.contextWindow;
  const snapshotMatchesModel = snapshot && modelRef(input.model) === snapshot.model &&
    (!finite(currentWindow) || currentWindow === snapshot.contextWindow);
  return { valid, journal, operations: operations.size, all, active, pruned: valid ? pruned.size : undefined,
    summaryTokens: valid && active.every((b) => finite(b.summaryTokenEstimate)) ? active.reduce((s,b) => s + b.summaryTokenEstimate, 0) : undefined,
    manualMode, activity, measured: valid ? measured.size : undefined,
    measuredGain: valid && measured.size ? [...measured.values()].reduce((s,m) => s + m.netGainTokens, 0) : valid && all.length === 0 ? 0 : undefined,
    snapshot: snapshotMatchesModel ? snapshot : undefined, snapshotStale: Boolean(snapshot && !snapshotMatchesModel),
    published: publishedIds.size, projections, attempts: evidenceEpoch ? attempts : undefined, completed: evidenceEpoch ? completed : undefined,
    ignored: snapshotMatchesModel ? ignored : undefined, anchors: valid ? anchors : [], lastReminder,
    rejected: evidenceEpoch ? rejected : undefined, manualFailures: manualFailures.size };
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
