#!/usr/bin/env node
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const benchmarkDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(benchmarkDir, "..");
const suiteDir = path.resolve(fixtureDir, "../../..");
const manifest = JSON.parse(fs.readFileSync(path.join(benchmarkDir, "manifest.json"), "utf-8"));

const args = parseArgs(process.argv.slice(2));
const runsLimit = normalizePositiveInteger(args.runs ?? process.env.PI_LOCATE_ANALYSIS_RUNS ?? "10", 10);
const reportsRoot = path.resolve(args.reportsDir ?? process.env.PI_LOCATE_REPORTS_DIR ?? path.join(suiteDir, "reports", "locate-benchmark"));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = path.resolve(args.outDir ?? process.env.PI_LOCATE_ANALYSIS_DIR ?? path.join(suiteDir, "reports", "locate-benchmark-analysis", stamp));
const outputHtml = path.resolve(args.out ?? process.env.PI_LOCATE_ANALYSIS_HTML ?? path.join(outputDir, "index.html"));
const outputJson = path.join(path.dirname(outputHtml), "analysis.json");
const openReport = args.open ?? /^(1|true|yes)$/i.test(process.env.PI_LOCATE_ANALYSIS_OPEN_REPORT ?? (process.env.CI ? "0" : "1"));

const reports = latestReports(collectReportFiles(reportsRoot), runsLimit).map(loadReportRecord);
if (reports.length === 0) throw new Error(`No locate benchmark report.json files found under ${reportsRoot}`);

const analysis = buildAnalysis(reports);
fs.mkdirSync(path.dirname(outputHtml), { recursive: true });
fs.writeFileSync(outputJson, `${JSON.stringify(analysis, null, 2)}\n`, "utf-8");
fs.writeFileSync(outputHtml, renderHtml(analysis, outputHtml), "utf-8");

process.stderr.write(`[locate-analysis] analyzed ${analysis.runs.length} latest run(s) from ${reportsRoot}\n`);
process.stderr.write(`[locate-analysis] HTML report: ${toFileUrl(outputHtml)}\n`);
if (openReport) openHtmlReport(outputHtml);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-n" || arg === "--runs") parsed.runs = argv[++index];
    else if (arg === "--reports-dir") parsed.reportsDir = argv[++index];
    else if (arg === "--out-dir") parsed.outDir = argv[++index];
    else if (arg === "--out") parsed.out = argv[++index];
    else if (arg === "--open") parsed.open = true;
    else if (arg === "--no-open") parsed.open = false;
    else if (/^\d+$/.test(arg)) parsed.runs = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function collectReportFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of safeReaddir(current)) {
      const target = path.join(current, entry);
      if (safeIsDirectory(target)) stack.push(target);
      else if (entry === "report.json") files.push(target);
    }
  }
  return files;
}

function latestReports(files, limit) {
  return files
    .map((file) => ({ file, sortTime: reportSortTime(file) }))
    .sort((a, b) => b.sortTime - a.sortTime || b.file.localeCompare(a.file))
    .slice(0, limit)
    .map((item) => item.file)
    .reverse();
}

function reportSortTime(file) {
  try {
    const report = JSON.parse(fs.readFileSync(file, "utf-8"));
    const generatedAt = Date.parse(report.generatedAt ?? "");
    if (Number.isFinite(generatedAt)) return generatedAt;
  } catch {
    // Fall back to mtime below.
  }
  return fs.statSync(file).mtimeMs;
}

function loadReportRecord(file) {
  const report = JSON.parse(fs.readFileSync(file, "utf-8"));
  const runId = path.relative(reportsRoot, path.dirname(file));
  const expected = report.expected ?? manifest.expected;
  const results = (report.results ?? []).map((result) => normalizeResult(result, report, file, expected));
  return {
    id: runId,
    json: file,
    html: path.join(path.dirname(file), "index.html"),
    generatedAt: report.generatedAt ?? new Date(fs.statSync(file).mtimeMs).toISOString(),
    model: report.model ?? "unknown",
    fakeIdx: Boolean(report.fakeIdx),
    prompt: report.prompt ?? manifest.prompt,
    expected,
    results,
  };
}

function normalizeResult(result, report, reportFile, expected) {
  const mode = canonicalModeName(result.mode);
  const parentTokens = result.metrics?.burnedTokens ?? result.roughToolIoTokens ?? 0;
  const subagentTokens = result.metrics?.subagents?.totalEstimatedSessionTokens ?? 0;
  const firstCorrectEvidence = normalizeFirstEvidence(result.firstCorrectEvidence, result, reportFile, expected);
  return {
    sourceMode: result.mode,
    mode,
    success: Boolean(result.success),
    timedOut: Boolean(result.timedOut),
    parentTokens,
    subagentTokens,
    totalEstimatedTokens: parentTokens + subagentTokens,
    toolCallCount: result.toolCallCount ?? (result.toolCalls ?? []).length,
    elapsedMs: result.elapsedMs ?? 0,
    firstCorrectEvidence,
    toolCalls: result.toolCalls ?? [],
    answerPreview: result.metrics?.parent?.answerPreview ?? "",
    reportDirectory: report.report?.directory ?? path.dirname(reportFile),
  };
}

function canonicalModeName(mode) {
  return mode === "semantic-repo-search" ? "repo-search-hybrid" : mode;
}

function normalizeFirstEvidence(firstCorrectEvidence, result, reportFile, expected) {
  if (firstCorrectEvidence?.found) return firstCorrectEvidence;
  const events = loadToolEvents(result, reportFile);
  return events.length > 0 ? findFirstCorrectEvidence(events, expected) : { found: false };
}

function loadToolEvents(result, reportFile) {
  const candidates = [];
  if (result.persistedArtifacts?.files?.toolEvents?.path) candidates.push(result.persistedArtifacts.files.toolEvents.path);
  const reportDir = path.dirname(reportFile);
  candidates.push(path.join(reportDir, "modes", safeFileName(result.mode), "files", "tool-events.jsonl"));
  candidates.push(path.join(reportDir, "modes", safeFileName(canonicalModeName(result.mode)), "files", "tool-events.jsonl"));
  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    return fs.readFileSync(candidate, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }
  return [];
}

function buildAnalysis(runs) {
  const flat = runs.flatMap((run, runIndex) => run.results.map((result) => ({ ...result, runId: run.id, runIndex, runGeneratedAt: run.generatedAt })));
  const modes = [...new Set(flat.map((result) => result.mode))].sort();
  const modeStats = modes.map((mode) => summarizeMode(mode, flat.filter((result) => result.mode === mode), runs));
  addWinCounts(modeStats, runs);
  modeStats.sort((a, b) => a.totalTokens.p50 - b.totalTokens.p50);
  return {
    generatedAt: new Date().toISOString(),
    reportsRoot,
    runsRequested: runsLimit,
    runsAnalyzed: runs.length,
    output: { html: outputHtml, json: outputJson },
    prompt: runs.at(-1)?.prompt ?? manifest.prompt,
    expected: runs.at(-1)?.expected ?? manifest.expected,
    runs,
    modes: modeStats,
  };
}

function summarizeMode(mode, results, runs) {
  const evidenceResults = results.filter((result) => result.firstCorrectEvidence?.found);
  return {
    mode,
    runs: results.length,
    successes: results.filter((result) => result.success).length,
    successRate: results.length ? results.filter((result) => result.success).length / results.length : 0,
    totalTokenWins: 0,
    firstEvidenceWins: 0,
    totalTokens: describeNumbers(results.map((result) => result.totalEstimatedTokens)),
    parentTokens: describeNumbers(results.map((result) => result.parentTokens)),
    subagentTokens: describeNumbers(results.map((result) => result.subagentTokens)),
    toolCalls: describeNumbers(results.map((result) => result.toolCallCount)),
    elapsedMs: describeNumbers(results.map((result) => result.elapsedMs)),
    firstEvidenceTokens: describeNumbers(evidenceResults.map((result) => result.firstCorrectEvidence.tokensAtEvidence)),
    firstEvidenceCalls: describeNumbers(evidenceResults.map((result) => result.firstCorrectEvidence.toolCallNumber)),
    overSearchTokens: describeNumbers(evidenceResults.map((result) => Math.max(0, result.parentTokens - result.firstCorrectEvidence.tokensAtEvidence))),
    series: runs.map((run) => {
      const result = run.results.find((item) => item.mode === mode);
      return result ? {
        runId: run.id,
        totalTokens: result.totalEstimatedTokens,
        parentTokens: result.parentTokens,
        firstEvidenceTokens: result.firstCorrectEvidence?.found ? result.firstCorrectEvidence.tokensAtEvidence : null,
        toolCalls: result.toolCallCount,
        elapsedMs: result.elapsedMs,
        success: result.success,
      } : { runId: run.id, totalTokens: null, firstEvidenceTokens: null, success: false };
    }),
  };
}

function addWinCounts(modeStats, runs) {
  const byMode = new Map(modeStats.map((stat) => [stat.mode, stat]));
  for (const run of runs) {
    const successful = run.results.filter((result) => result.success);
    const totalWinner = minBy(successful, (result) => result.totalEstimatedTokens);
    if (totalWinner) byMode.get(totalWinner.mode).totalTokenWins += 1;
    const evidenceWinner = minBy(successful.filter((result) => result.firstCorrectEvidence?.found), (result) => result.firstCorrectEvidence.tokensAtEvidence);
    if (evidenceWinner) byMode.get(evidenceWinner.mode).firstEvidenceWins += 1;
  }
}

function describeNumbers(values) {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (clean.length === 0) return { count: 0, min: null, p50: null, avg: null, max: null };
  return {
    count: clean.length,
    min: clean[0],
    p50: percentile(clean, 0.5),
    avg: clean.reduce((sum, value) => sum + value, 0) / clean.length,
    max: clean.at(-1),
  };
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const index = (sortedValues.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (index - lower);
}

function findFirstCorrectEvidence(events, expected) {
  const expectedFile = normalizeEvidenceText(expected?.file);
  const expectedSymbol = normalizeEvidenceText(expected?.symbol);
  const expectedLine = normalizeEvidenceText(expected?.lineContains);
  let toolCallNumber = 0;
  let lastToolName = "";
  const serializedPrefix = [];
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex];
    serializedPrefix.push(JSON.stringify(event));
    if (event.type === "tool_call") {
      toolCallNumber += 1;
      lastToolName = event.toolName ?? "";
      continue;
    }
    if (event.type !== "tool_result") continue;
    const text = normalizeEvidenceText(event.output);
    const hasExactLine = Boolean(expectedLine && text.includes(expectedLine));
    const hasFile = Boolean(expectedFile && text.includes(expectedFile));
    const hasSymbol = Boolean(expectedSymbol && text.includes(expectedSymbol));
    const hasPulseAssignment = text.includes("lastpulseat") && text.includes("clock.iso");
    if (!hasExactLine && !(hasFile && (hasSymbol || hasPulseAssignment))) continue;
    return {
      found: true,
      eventIndex,
      toolCallNumber,
      toolName: event.toolName ?? lastToolName,
      tokensAtEvidence: estimateTokens(serializedPrefix.join("\n")),
      matched: { exactLine: hasExactLine, file: hasFile, symbol: hasSymbol, pulseAssignment: hasPulseAssignment },
      preview: previewText(stringifyEvidenceOutput(event.output), 500),
    };
  }
  return { found: false };
}

function renderHtml(analysis, targetPath) {
  const modeRows = analysis.modes.map((stat) => `<tr>
    <td><a href="#mode-${escapeAttr(safeFileName(stat.mode))}">${escapeHtml(stat.mode)}</a></td>
    <td class="num">${formatNumber(stat.successes)}/${formatNumber(stat.runs)}</td>
    <td class="num strong">${formatNumber(stat.totalTokens.p50)}</td>
    <td class="num">${formatNumber(stat.totalTokens.avg)}</td>
    <td class="num">${formatNumber(stat.firstEvidenceTokens.p50)}</td>
    <td class="num">${formatNumber(stat.overSearchTokens.avg)}</td>
    <td class="num">${formatNumber(stat.toolCalls.p50)}</td>
    <td class="num">${formatNumber(stat.elapsedMs.p50)}</td>
    <td class="num">${formatNumber(stat.totalTokenWins)}</td>
    <td class="num">${formatNumber(stat.firstEvidenceWins)}</td>
  </tr>`).join("\n");
  const runRows = analysis.runs.map((run, index) => `<tr>
    <td class="num">${index + 1}</td>
    <td><a href="${escapeAttr(relativeHref(run.html, targetPath))}">${escapeHtml(run.id)}</a></td>
    <td>${escapeHtml(run.generatedAt)}</td>
    <td>${escapeHtml(run.model)}</td>
    <td>${escapeHtml(run.results.map((result) => `${result.mode}:${formatCompact(result.totalEstimatedTokens)}`).join(" · "))}</td>
  </tr>`).join("\n");
  const modeCards = analysis.modes.map((stat) => renderModeCard(stat)).join("\n");
  const embeddedJson = escapeHtml(JSON.stringify(analysis, null, 2));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Locate benchmark analysis — latest ${formatNumber(analysis.runsAnalyzed)}</title>
  <style>
    :root { color-scheme: light dark; --bg: #0f172a; --panel: #111827; --muted: #94a3b8; --text: #e5e7eb; --line: #334155; --accent: #38bdf8; --ok: #22c55e; --bad: #ef4444; --warn: #f59e0b; }
    @media (prefers-color-scheme: light) { :root { --bg: #f8fafc; --panel: #fff; --muted: #64748b; --text: #0f172a; --line: #dbe3ef; --accent: #0369a1; } }
    body { margin: 0; font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; background: var(--bg); color: var(--text); }
    main { max-width: 1320px; margin: 0 auto; padding: 28px; }
    h1, h2, h3 { line-height: 1.15; }
    .hero, .card { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 20px; margin: 16px 0; box-shadow: 0 12px 32px #0002; }
    .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; color: var(--muted); }
    table { width: 100%; border-collapse: collapse; margin: 12px 0; }
    th, td { border-bottom: 1px solid var(--line); padding: 8px 10px; vertical-align: top; }
    th { text-align: left; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
    .num { text-align: right; font-variant-numeric: tabular-nums; } .strong { font-weight: 800; }
    .small { color: var(--muted); font-size: 12px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 16px; }
    .chart { display: grid; gap: 10px; margin: 16px 0; }
    .bar-row { display: grid; grid-template-columns: minmax(150px, 210px) 1fr minmax(88px, auto); align-items: center; gap: 10px; }
    .bar-label { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bar-track { height: 28px; border: 1px solid var(--line); border-radius: 999px; overflow: hidden; background: #00000020; }
    .bar-fill { height: 100%; min-width: 3px; border-radius: 999px; box-shadow: inset 0 0 0 1px #ffffff33; }
    .bar-value { text-align: right; font-variant-numeric: tabular-nums; font-weight: 800; }
    .spark { width: 100%; height: 120px; overflow: visible; background: #00000018; border: 1px solid var(--line); border-radius: 12px; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    pre { white-space: pre-wrap; overflow: auto; background: #00000024; border: 1px solid var(--line); border-radius: 12px; padding: 12px; }
    a { color: var(--accent); }
  </style>
</head>
<body id="top"><main>
  <section class="hero">
    <h1>Locate benchmark analysis</h1>
    <p>${escapeHtml(analysis.prompt)}</p>
    <div class="meta">
      <div><b>Runs analyzed:</b> ${formatNumber(analysis.runsAnalyzed)} latest report.json files</div>
      <div><b>Generated:</b> ${escapeHtml(analysis.generatedAt)}</div>
      <div><b>Reports root:</b> ${escapeHtml(analysis.reportsRoot)}</div>
      <div><b>JSON:</b> <a href="${escapeAttr(relativeHref(analysis.output.json, targetPath))}">${escapeHtml(path.basename(analysis.output.json))}</a></div>
    </div>
    <p class="small">Legacy <code>semantic-repo-search</code> rows are normalized to <code>repo-search-hybrid</code>. First-evidence metrics are computed from recorded tool output when old reports do not contain the metric.</p>
  </section>

  <section class="card">
    <h2>Aggregate summary</h2>
    <table>
      <thead><tr><th>Mode</th><th class="num">Success</th><th class="num">p50 total tokens</th><th class="num">avg total tokens</th><th class="num">p50 first evidence tokens</th><th class="num">avg over-search tokens</th><th class="num">p50 calls</th><th class="num">p50 ms</th><th class="num">token wins</th><th class="num">evidence wins</th></tr></thead>
      <tbody>${modeRows}</tbody>
    </table>
    <div class="grid">
      <section><h3>p50 total tokens</h3>${renderBarChart(analysis.modes, (stat) => stat.totalTokens.p50, " tokens")}</section>
      <section><h3>p50 first-evidence tokens</h3>${renderBarChart(analysis.modes, (stat) => stat.firstEvidenceTokens.p50, " tokens")}</section>
      <section><h3>Total-token wins</h3>${renderBarChart(analysis.modes, (stat) => stat.totalTokenWins, " wins")}</section>
      <section><h3>Avg over-search after evidence</h3>${renderBarChart(analysis.modes, (stat) => stat.overSearchTokens.avg, " tokens")}</section>
    </div>
  </section>

  <section class="card">
    <h2>Runs</h2>
    <table><thead><tr><th class="num">#</th><th>Run report</th><th>Generated</th><th>Model</th><th>Total tokens by mode</th></tr></thead><tbody>${runRows}</tbody></table>
  </section>

  ${modeCards}

  <section class="card"><h2>Embedded analysis JSON</h2><pre>${embeddedJson}</pre></section>
</main></body></html>`;
}

function renderModeCard(stat) {
  return `<section class="card" id="mode-${escapeAttr(safeFileName(stat.mode))}">
    <h2>${escapeHtml(stat.mode)}</h2>
    <div class="meta">
      <div><b>Success:</b> ${formatNumber(stat.successes)}/${formatNumber(stat.runs)}</div>
      <div><b>p50 total:</b> ${formatNumber(stat.totalTokens.p50)} tokens</div>
      <div><b>p50 first evidence:</b> ${formatNumber(stat.firstEvidenceTokens.p50)} tokens</div>
      <div><b>avg over-search:</b> ${formatNumber(stat.overSearchTokens.avg)} tokens</div>
    </div>
    <h3>Total tokens over runs</h3>
    ${renderSparkline(stat.series.map((point) => point.totalTokens), modeColor(stat.mode))}
    <h3>First-evidence tokens over runs</h3>
    ${renderSparkline(stat.series.map((point) => point.firstEvidenceTokens), "#f59e0b")}
    <table><thead><tr><th>Run</th><th class="num">Total tokens</th><th class="num">Parent tokens</th><th class="num">First evidence tokens</th><th class="num">Tool calls</th><th class="num">Elapsed ms</th><th>Status</th></tr></thead><tbody>${stat.series.map((point) => `<tr>
      <td>${escapeHtml(point.runId)}</td><td class="num">${formatNumber(point.totalTokens)}</td><td class="num">${formatNumber(point.parentTokens)}</td><td class="num">${formatNumber(point.firstEvidenceTokens)}</td><td class="num">${formatNumber(point.toolCalls)}</td><td class="num">${formatNumber(point.elapsedMs)}</td><td>${point.success ? "✅" : "❌"}</td>
    </tr>`).join("")}</tbody></table>
  </section>`;
}

function renderBarChart(items, valueOf, suffix) {
  const values = items.map((item) => Number(valueOf(item) ?? 0));
  const max = Math.max(1, ...values);
  return `<div class="chart">${items.map((item, index) => {
    const value = values[index];
    const width = Math.max(2, Math.round((value / max) * 100));
    const color = modeColor(item.mode);
    return `<div class="bar-row"><div class="bar-label" title="${escapeAttr(item.mode)}">${escapeHtml(item.mode)}</div><div class="bar-track"><div class="bar-fill" style="width:${width}%;background:linear-gradient(90deg,${color},${color}aa)"></div></div><div class="bar-value">${formatNumber(value)}${escapeHtml(suffix)}</div></div>`;
  }).join("\n")}</div>`;
}

function renderSparkline(values, color) {
  const clean = values.map((value, index) => ({ value, index })).filter((point) => Number.isFinite(point.value));
  if (clean.length === 0) return "<p class=\"small\">No data.</p>";
  const width = 640;
  const height = 120;
  const pad = 14;
  const min = Math.min(...clean.map((point) => point.value));
  const max = Math.max(...clean.map((point) => point.value));
  const span = Math.max(1, max - min);
  const denominator = Math.max(1, values.length - 1);
  const points = clean.map((point) => {
    const x = pad + (point.index / denominator) * (width - pad * 2);
    const y = height - pad - ((point.value - min) / span) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const circles = clean.map((point) => {
    const x = pad + (point.index / denominator) * (width - pad * 2);
    const y = height - pad - ((point.value - min) / span) * (height - pad * 2);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3"><title>run ${point.index + 1}: ${formatNumber(point.value)}</title></circle>`;
  }).join("");
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img"><polyline fill="none" stroke="${escapeAttr(color)}" stroke-width="3" points="${points}" vector-effect="non-scaling-stroke"/><g fill="${escapeAttr(color)}">${circles}</g><text x="${pad}" y="${height - 4}" fill="currentColor" font-size="10">min ${formatCompact(min)} · max ${formatCompact(max)}</text></svg>`;
}

function minBy(items, score) {
  if (items.length === 0) return undefined;
  return items.reduce((best, item) => score(item) < score(best) ? item : best, items[0]);
}

function estimateTokens(textOrBytes) {
  const length = typeof textOrBytes === "number" ? textOrBytes : String(textOrBytes ?? "").length;
  return Math.ceil(length / 4);
}

function normalizeEvidenceText(value) {
  return stringifyEvidenceOutput(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function stringifyEvidenceOutput(value) {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value ?? ""); }
}

function previewText(text, maxChars) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}…` : normalized;
}

function modeColor(modeName) {
  const colors = {
    "direct-read-grep": "#22c55e",
    "ast-structural": "#38bdf8",
    "repo-search-hybrid": "#a78bfa",
    "repo-discovery": "#f59e0b",
    "subagent-search": "#fb7185",
    "unrestricted-suite": "#14b8a6",
  };
  if (colors[modeName]) return colors[modeName];
  const palette = ["#22c55e", "#38bdf8", "#a78bfa", "#f59e0b", "#fb7185", "#14b8a6", "#e879f9", "#84cc16"];
  let hash = 0;
  for (const char of String(modeName)) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

function openHtmlReport(targetPath) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", targetPath] : [targetPath];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch (error) {
    process.stderr.write(`[locate-analysis] could not open HTML report: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function safeFileName(value) {
  return String(value ?? "unknown").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function safeIsDirectory(targetPath) {
  try { return fs.statSync(targetPath).isDirectory(); } catch { return false; }
}

function relativeHref(targetPath, fromHtmlPath) {
  return path.relative(path.dirname(fromHtmlPath), targetPath).split(path.sep).map(encodeURIComponent).join("/");
}

function toFileUrl(targetPath) {
  return `file://${path.resolve(targetPath).split(path.sep).map((part, index) => index === 0 ? part : encodeURIComponent(part)).join("/")}`;
}

function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return Math.round(Number(value)).toLocaleString("en-US");
}

function formatCompact(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}
