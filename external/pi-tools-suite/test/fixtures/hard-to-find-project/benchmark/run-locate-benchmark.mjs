#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const benchmarkDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(benchmarkDir, "..");
const suiteDir = path.resolve(fixtureDir, "../../..");
const extensionEntrypoint = path.join(suiteDir, "index.ts");
const manifest = JSON.parse(fs.readFileSync(path.join(benchmarkDir, "manifest.json"), "utf-8"));

const model = process.env.PI_LOCATE_BENCH_MODEL || process.env.TOOL_SELECTION_E2E_MODEL || "";
const piBin = process.env.PI_BIN || "pi";
const idxBin = process.env.IDX_BIN || "idx";
const keepRuns = /^(1|true|yes)$/i.test(process.env.PI_LOCATE_BENCH_KEEP ?? "");
const timeoutMs = Number(process.env.PI_LOCATE_BENCH_TIMEOUT_MS ?? 300_000);
const idxInitTimeoutMs = Number(process.env.PI_LOCATE_BENCH_IDX_INIT_TIMEOUT_MS ?? 180_000);
const useFakeIdx = /^(1|true|yes)$/i.test(process.env.PI_LOCATE_BENCH_FAKE_IDX ?? "");
const runIdxUpdate = /^(1|true|yes)$/i.test(process.env.PI_LOCATE_BENCH_IDX_UPDATE ?? (useFakeIdx ? "0" : "1"));
const idxUpdateTimeoutMs = Number(process.env.PI_LOCATE_BENCH_IDX_UPDATE_TIMEOUT_MS ?? 180_000);
const reportPath = process.env.PI_LOCATE_BENCH_REPORT || "";
const reportDir = resolveReportDir();
const reportJsonPath = reportPath ? path.resolve(reportPath) : path.join(reportDir, "report.json");
const reportHtmlPath = process.env.PI_LOCATE_BENCH_HTML ? path.resolve(process.env.PI_LOCATE_BENCH_HTML) : path.join(reportDir, "index.html");
const openReport = /^(1|true|yes)$/i.test(process.env.PI_LOCATE_BENCH_OPEN_REPORT ?? (process.env.CI ? "0" : "1"));
const saveSessions = !/^(0|false|no)$/i.test(process.env.PI_LOCATE_BENCH_SAVE_SESSIONS ?? "1");
const exportSessionHtml = !/^(0|false|no)$/i.test(process.env.PI_LOCATE_BENCH_EXPORT_SESSIONS ?? "1");
const sessionExportTimeoutMs = Number(process.env.PI_LOCATE_BENCH_SESSION_EXPORT_TIMEOUT_MS ?? 60_000);
const printJson = /^(1|true|yes)$/i.test(process.env.PI_LOCATE_BENCH_PRINT_JSON ?? "");
const requestedConcurrency = Number(process.env.PI_LOCATE_BENCH_CONCURRENCY || "0");
const requestedIterations = Number(process.env.PI_LOCATE_BENCH_ITERATIONS || "1");
const e2eRetryAttempts = readPositiveInteger(process.env.PI_TOOLS_SUITE_E2E_RETRY_ATTEMPTS, 3);
const e2eRetryDelayMs = readNonNegativeInteger(process.env.PI_TOOLS_SUITE_E2E_RETRY_DELAY_MS, 5_000);

const modes = [
  {
    name: "direct-read-grep",
    tools: ["read", "grep", "Glob", "shell"],
    indexed: false,
  },
  {
    name: "ast-structural",
    tools: ["read", "grep", "Glob", "ast_grep"],
    indexed: false,
  },
  {
    name: "repo-search-hybrid",
    aliases: ["semantic-repo-search"],
    tools: ["repo_search", "read"],
    indexed: true,
    promptSuffix: "\n\nFor this benchmark run, use repo_search first with its default hybrid ranking unless a follow-up query specifically needs another --mode, then read only the cited code.",
  },
  {
    name: "repo-discovery",
    tools: ["repo_architecture", "repo_structure", "repo_search", "repo_ast", "repo_explain", "read"],
    indexed: true,
  },
  {
    name: "subagent-search",
    tools: ["subagents"],
    indexed: false,
    promptSuffix: "\n\nFor this benchmark run, delegate the code-location work to exactly one focused sub-agent with the subagents tool. Spawn it with a scan or quick profile, wait for it if needed, read its compact result, then answer from that result. Ask the sub-agent to return the exact file, symbol, and condition.",
  },
  {
    name: "unrestricted-suite",
    tools: [],
    indexed: true,
  },
];

const commonPromptSuffix = "\n\nBenchmark discipline: answer the requested locate/debug question from source evidence. Search step-by-step: make one focused discovery pass, read the most relevant code it returns, then refine only if the exact evidence is still missing. Once you have read code that identifies the exact file, symbol or assignment, and the condition that causes the behavior, stop searching and answer. Do not continue looking for surrounding routes, controllers, persistence, callers, or tests unless the prompt explicitly asks for them or the direct mutation/cause site is still unknown.";

if (!model) {
  console.error("Set PI_LOCATE_BENCH_MODEL to run the live benchmark, for example:");
  console.error("  PI_LOCATE_BENCH_MODEL=zai/glm-5-turbo node benchmark/run-locate-benchmark.mjs");
  process.exit(2);
}

const selectedModes = (process.env.PI_LOCATE_BENCH_MODES || "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const runModes = selectedModes.length > 0 ? modes.filter((mode) => selectedModes.some((name) => modeMatchesSelection(mode, name))) : modes;
if (runModes.length === 0) throw new Error(`No benchmark modes matched: ${selectedModes.join(", ")}`);

const concurrency = normalizeConcurrency(requestedConcurrency, runModes.length);
const iterationCount = normalizeIterationCount(requestedIterations);
logProgress(`Starting hard-to-find locate benchmark with ${runModes.length} mode(s): ${runModes.map((mode) => mode.name).join(", ")}`);
logProgress(`Model: ${model}; fake idx: ${useFakeIdx ? "on" : "off"}; per-mode timeout: ${timeoutMs}ms`);
logProgress(`Mode concurrency: ${concurrency}`);
logProgress(`Iterations: ${iterationCount}`);
logProgress(`Reports directory: ${reportDir}`);
fs.mkdirSync(reportDir, { recursive: true });

const preflight = {
  idxUpdate: runIdxUpdate
    ? runIdxUpdatePreflight()
    : { skipped: true, reason: useFakeIdx ? "fake idx enabled" : "disabled by PI_LOCATE_BENCH_IDX_UPDATE" },
};

if (iterationCount > 1) {
  const iterations = await runBenchmarkIterations(iterationCount);
  const aggregate = {
    fixture: path.basename(fixtureDir),
    prompt: manifest.prompt,
    expected: manifest.expected,
    benchmarkGuidance: commonPromptSuffix.trim(),
    generatedAt: new Date().toISOString(),
    model,
    fakeIdx: useFakeIdx,
    report: { directory: reportDir, iterationsJson: path.join(reportDir, "iterations.json") },
    preflight,
    iterations,
  };
  fs.writeFileSync(aggregate.report.iterationsJson, `${JSON.stringify(aggregate, null, 2)}\n`, "utf-8");
  logProgress(`Wrote iterations manifest: ${aggregate.report.iterationsJson}`);
  process.exit(0);
}

const results = await runModesWithConcurrency(runModes, concurrency);

const report = {
  fixture: path.basename(fixtureDir),
  prompt: manifest.prompt,
  expected: manifest.expected,
  benchmarkGuidance: commonPromptSuffix.trim(),
  generatedAt: new Date().toISOString(),
  model,
  fakeIdx: useFakeIdx,
  report: {
    directory: reportDir,
    json: reportJsonPath,
    html: reportHtmlPath,
    sessionExportsEnabled: exportSessionHtml,
  },
  preflight,
  summary: summarizeResults(results),
  results,
};
const reportText = JSON.stringify(report, null, 2);
fs.mkdirSync(path.dirname(reportJsonPath), { recursive: true });
fs.writeFileSync(reportJsonPath, `${reportText}\n`, "utf-8");
writeHtmlReport(report, reportHtmlPath);
printSummaryTable(results, reportHtmlPath);
if (printJson) console.log(reportText);
openHtmlReport(reportHtmlPath);

function resolveReportDir() {
  if (process.env.PI_LOCATE_BENCH_REPORT_DIR) return path.resolve(process.env.PI_LOCATE_BENCH_REPORT_DIR);
  if (reportPath) {
    const absoluteReportPath = path.resolve(reportPath);
    const ext = path.extname(absoluteReportPath);
    return path.join(path.dirname(absoluteReportPath), `${path.basename(absoluteReportPath, ext)}-assets`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(suiteDir, "reports", "locate-benchmark", stamp);
}

function normalizeConcurrency(value, modeCount) {
  if (!Number.isFinite(value) || value <= 0) return modeCount;
  return Math.max(1, Math.min(modeCount, Math.floor(value)));
}

function normalizeIterationCount(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.max(1, Math.floor(value));
}

function readPositiveInteger(value, fallback) {
  return normalizeInteger(value === undefined ? undefined : Number(value), fallback, 1);
}

function readNonNegativeInteger(value, fallback) {
  return normalizeInteger(value === undefined ? undefined : Number(value), fallback, 0);
}

function normalizeInteger(value, fallback, min) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.floor(numeric));
}

function isRetryableRateLimitResult(result) {
  if (result.exitCode === 0 || result.timedOut) return false;
  return /(?:\b429\b[\s\S]*rate limit|rate limit[\s\S]*\b429\b|rate limit reached for requests)/i.test(`${result.stdout}\n${result.stderr}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function modeMatchesSelection(mode, selectedName) {
  return mode.name === selectedName || (mode.aliases ?? []).includes(selectedName);
}

async function runBenchmarkIterations(count) {
  const width = String(count).length;
  const iterations = [];

  for (let iteration = 1; iteration <= count; iteration += 1) {
    const label = String(iteration).padStart(width, "0");
    const iterationReportDir = path.join(reportDir, `iteration-${label}`);
    logProgress(`Starting iteration ${iteration}/${count}; report directory: ${iterationReportDir}`);

    await spawnBenchmarkIteration(iterationReportDir);
    iterations.push({
      iteration,
      directory: iterationReportDir,
      json: path.join(iterationReportDir, "report.json"),
      html: path.join(iterationReportDir, "index.html"),
    });
  }

  return iterations;
}

function spawnBenchmarkIteration(iterationReportDir) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    env.PI_LOCATE_BENCH_ITERATIONS = "1";
    env.PI_LOCATE_BENCH_REPORT_DIR = iterationReportDir;
    env.PI_LOCATE_BENCH_IDX_UPDATE = "0";
    delete env.PI_LOCATE_BENCH_REPORT;
    delete env.PI_LOCATE_BENCH_HTML;

    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: suiteDir,
      env,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`benchmark iteration failed with ${code === null ? `signal ${signal}` : `exit code ${code}`}`));
    });
  });
}

function openHtmlReport(targetPath) {
  if (!openReport) return;

  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", targetPath] : [targetPath];

  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
    logProgress(`Opening HTML report in browser: ${targetPath}`);
  } catch (error) {
    logProgress(`Could not open HTML report automatically: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function runIdxUpdatePreflight() {
  logProgress(`Running idx update before benchmark modes`);
  const startedAt = Date.now();
  const env = { ...process.env, NO_COLOR: "1" };
  delete env.CI;
  const result = spawnSync(idxBin, ["update"], {
    cwd: suiteDir,
    env,
    encoding: "utf-8",
    timeout: idxUpdateTimeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  const elapsedMs = Date.now() - startedAt;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const status = result.status ?? (result.signal ? 128 : 1);

  if (result.error || status !== 0) {
    throw new Error([
      `idx update failed before benchmark modes after ${elapsedMs}ms`,
      `status=${status}${result.signal ? ` signal=${result.signal}` : ""}`,
      result.error ? `error=${result.error.message}` : "",
      stdout ? `STDOUT:\n${stdout}` : "",
      stderr ? `STDERR:\n${stderr}` : "",
    ].filter(Boolean).join("\n"));
  }

  logProgress(`idx update finished in ${elapsedMs}ms (stdout=${Buffer.byteLength(stdout)}B, stderr=${Buffer.byteLength(stderr)}B)`);
  return {
    skipped: false,
    elapsedMs,
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
  };
}

async function runModesWithConcurrency(modeList, limit) {
  const results = new Array(modeList.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= modeList.length) return;
      results[index] = await runMode(modeList[index]);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

async function runMode(mode) {
  logProgress(`Preparing mode ${mode.name}${mode.tools.length > 0 ? ` with tools: ${mode.tools.join(",")}` : " with unrestricted tools"}`);
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-locate-${mode.name}-`));
  fs.cpSync(fixtureDir, projectDir, {
    recursive: true,
    filter: (source) => shouldCopyFixturePath(source),
  });
  assertFixtureCopied(projectDir);
  logProgress(`Mode ${mode.name} working directory: ${projectDir}`);
  const fakeIdxBin = useFakeIdx && mode.indexed ? writeFakeIdxBin(projectDir) : undefined;
  const preparationStartedAt = Date.now();
  const preparation = {
    elapsedMs: 0,
    idxInit: mode.indexed
      ? initializeIdxProject(projectDir, { fake: Boolean(fakeIdxBin) })
      : undefined,
  };
  preparation.elapsedMs = Date.now() - preparationStartedAt;

  logProgress(`Starting agent for mode ${mode.name}; index preparation is complete and excluded from agent timing/token metrics`);
  const startedAt = Date.now();
  const { stdout, stderr, exitCode, timedOut, recorder, sessionDir } = await runModeAgentWithRetry(mode, projectDir, fakeIdxBin);
  const elapsedMs = Date.now() - startedAt;
  const eventText = readOptional(recorder.logPath);
  const subagentEventText = readSubagentEvents(projectDir);
  const events = parseEvents(eventText);
  const expected = manifest.expected;
  const firstCorrectEvidence = findFirstCorrectEvidence(events, expected);
  const parentToolIoTokens = estimateTokens(eventText);
  const answerText = `${stdout}\n${stderr}`.toLowerCase();
  const success = !timedOut && answerText.includes(expected.file.toLowerCase())
    && (answerText.includes(expected.symbol.toLowerCase()) || answerText.includes("lastpulseat"));
  const idxCalls = readIdxEvents(projectDir);
  const sessionMetrics = analyzeSessionArtifacts({ projectDir, sessionDir, stdout, stderr, eventText });
  const sessionArtifacts = collectSessionArtifacts(projectDir, sessionDir, { pathsRetained: keepRuns });
  const persistedArtifacts = persistModeArtifacts({
    modeName: mode.name,
    projectDir,
    sessionArtifacts,
    stdout,
    stderr,
    eventText,
    subagentEventText,
    idxCalls,
  });

  const result = {
    mode: mode.name,
    exitCode,
    timedOut,
    success,
    elapsedMs,
    roughToolIoTokens: parentToolIoTokens,
    toolCallCount: events.filter((event) => event.type === "tool_call").length,
    toolCalls: events.filter((event) => event.type === "tool_call").map((event) => event.toolName),
    firstCorrectEvidence,
    idxCalls,
    preparation,
    sessionArtifacts,
    persistedArtifacts,
    metrics: sessionMetrics,
    subagentEventBytes: Buffer.byteLength(subagentEventText),
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    projectDir: keepRuns ? projectDir : undefined,
  };
  logProgress(`Finished mode ${mode.name}: success=${success}; exit=${exitCode}; timedOut=${timedOut}; burnedTokens=${sessionMetrics.burnedTokens}; subagentTokens=${sessionMetrics.subagents.totalEstimatedSessionTokens}; toolCalls=${result.toolCallCount}; elapsedMs=${elapsedMs}`);

  if (!keepRuns) fs.rmSync(projectDir, { recursive: true, force: true });

  return result;
}

async function runModeAgentWithRetry(mode, projectDir, fakeIdxBin) {
  let lastResult;

  for (let attempt = 1; attempt <= e2eRetryAttempts; attempt += 1) {
    const recorder = writeRecorder(projectDir);
    fs.rmSync(recorder.logPath, { force: true });
    const sessionDir = path.join(projectDir, ".pi", `session-${process.pid}-${Date.now()}-${attempt}`);
    fs.mkdirSync(sessionDir, { recursive: true });

    const args = [
      "--model", model,
      "--extension", extensionEntrypoint,
      "--extension", recorder.extensionPath,
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--session-dir", sessionDir,
    ];
    if (!saveSessions) args.push("--no-session");
    if (mode.tools.length > 0) args.push("--tools", mode.tools.join(","));
    args.push("-p", `${manifest.prompt}${commonPromptSuffix}${mode.promptSuffix ?? ""}`);

    const result = {
      ...(await spawnPi(projectDir, args, fakeIdxBin ? { PATH: `${fakeIdxBin}${path.delimiter}${process.env.PATH ?? ""}` } : undefined)),
      recorder,
      sessionDir,
    };
    lastResult = result;

    if (attempt >= e2eRetryAttempts || !isRetryableRateLimitResult(result)) return result;
    logProgress(`Mode ${mode.name} hit 429/rate-limit on attempt ${attempt}/${e2eRetryAttempts}; retrying in ${e2eRetryDelayMs}ms`);
    await sleep(e2eRetryDelayMs);
  }

  return lastResult;
}

function logProgress(message) {
  process.stderr.write(`[locate-bench] ${message}\n`);
}

function estimateTokens(textOrBytes) {
  const length = typeof textOrBytes === "number" ? textOrBytes : String(textOrBytes ?? "").length;
  return Math.ceil(length / 4);
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
    const serialized = JSON.stringify(event);
    serializedPrefix.push(serialized);
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
    const found = hasExactLine || (hasFile && (hasSymbol || hasPulseAssignment));
    if (!found) continue;

    return {
      found: true,
      eventIndex,
      toolCallNumber,
      toolName: event.toolName ?? lastToolName,
      tokensAtEvidence: estimateTokens(serializedPrefix.join("\n")),
      matched: {
        exactLine: hasExactLine,
        file: hasFile,
        symbol: hasSymbol,
        pulseAssignment: hasPulseAssignment,
      },
      preview: previewText(stringifyEvidenceOutput(event.output), 500),
    };
  }

  return { found: false };
}

function normalizeEvidenceText(value) {
  return stringifyEvidenceOutput(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function stringifyEvidenceOutput(value) {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value ?? ""); }
}

function shouldCopyFixturePath(source) {
  const relative = path.relative(fixtureDir, source);
  if (!relative) return true;
  const parts = relative.split(path.sep);
  if (parts.includes(".pi")) return false;
  if (parts[0] === "benchmark" && parts[1] === "reports") return false;
  return true;
}

function assertFixtureCopied(projectDir) {
  const expectedFile = path.join(projectDir, manifest.expected.file);
  if (fs.existsSync(expectedFile)) return;
  throw new Error([
    `Fixture copy is missing expected source file: ${manifest.expected.file}`,
    `source fixture: ${fixtureDir}`,
    `copied fixture: ${projectDir}`,
    "The copy filter must be relative to the fixture root; absolute paths may contain parent .pi directories.",
  ].join("\n"));
}

function initializeIdxProject(projectDir, options) {
  if (options.fake) {
    fs.mkdirSync(path.join(projectDir, ".indexer-cli"), { recursive: true });
    logProgress(`Fake idx enabled; created indexed-project marker for ${projectDir}`);
    return { skipped: true, fake: true, elapsedMs: 0 };
  }

  logProgress(`Running idx init in ${projectDir}`);
  const startedAt = Date.now();
  const result = spawnSync(idxBin, ["init"], {
    cwd: projectDir,
    env: { ...process.env, NO_COLOR: "1", CI: "1" },
    encoding: "utf-8",
    timeout: idxInitTimeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  const elapsedMs = Date.now() - startedAt;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const status = result.status ?? (result.signal ? 128 : 1);

  if (result.error || status !== 0) {
    throw new Error([
      `idx init failed for ${projectDir} after ${elapsedMs}ms`,
      `status=${status}${result.signal ? ` signal=${result.signal}` : ""}`,
      result.error ? `error=${result.error.message}` : "",
      stdout ? `STDOUT:\n${stdout}` : "",
      stderr ? `STDERR:\n${stderr}` : "",
    ].filter(Boolean).join("\n"));
  }

  if (!fs.existsSync(path.join(projectDir, ".indexer-cli"))) {
    throw new Error(`idx init completed but did not create .indexer-cli in ${projectDir}`);
  }

  logProgress(`idx init finished in ${elapsedMs}ms (stdout=${Buffer.byteLength(stdout)}B, stderr=${Buffer.byteLength(stderr)}B)`);
  return {
    skipped: false,
    fake: false,
    elapsedMs,
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
  };
}

function writeFakeIdxBin(projectDir) {
  const binDir = path.join(projectDir, ".pi", "fake-bin");
  const idxPath = path.join(binDir, "idx");
  const logPath = path.join(projectDir, ".pi", "idx-events.jsonl");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(idxPath, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const command = args[0] || "";
if (command === "search") {
  console.log("src/platform/transit/packet-fold.ts:20-34 foldPacketEdges updates markers.lastPulseAt when a non-commit/shadow rehearsal packet is observed; shouldAdvancePulse is input.node.intent !== \\\"commit\\\" && input.edge.disposition === \\\"observe\\\".");
  console.log("src/features/retention/renewal-preview.ts:19-27 planRenewalReminder maps preview to shadow intent and observe disposition before calling foldPacketEdges.");
} else if (command === "architecture") {
  console.log("Retention preview flow builds a rehearsal node, then platform transit folding mutates pulse markers. Target helper: src/platform/transit/packet-fold.ts::foldPacketEdges.");
} else if (command === "structure") {
  console.log("src/features/retention/renewal-preview.ts — planRenewalReminder; src/platform/transit/packet-fold.ts — foldPacketEdges; src/platform/transit/rehearsal-node.ts — makeRehearsalNode");
} else if (command === "ast" || command === "explain" || command === "deps") {
  console.log("src/platform/transit/packet-fold.ts::foldPacketEdges contains lastPulseAt: shouldAdvancePulse ? input.clock.iso() : current.markers.lastPulseAt");
} else {
  console.log("fake idx ok");
}
`, "utf-8");
  fs.chmodSync(idxPath, 0o755);
  return binDir;
}

function writeRecorder(projectDir) {
  const extensionPath = path.join(projectDir, ".pi", "locate-bench-recorder.ts");
  const logPath = path.join(projectDir, ".pi", "locate-bench-events.jsonl");
  fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
  fs.writeFileSync(extensionPath, `
import * as fs from "node:fs";
const LOG_PATH = ${JSON.stringify(logPath)};
function safe(value) {
  try { JSON.stringify(value); return value ?? null; }
  catch (error) { return String(value); }
}
function append(event) {
  fs.mkdirSync(${JSON.stringify(path.dirname(logPath))}, { recursive: true });
  fs.appendFileSync(LOG_PATH, JSON.stringify(event) + "\\n", "utf-8");
}
export default function recorder(pi) {
  pi.on("tool_call", async (event) => {
    append({ type: "tool_call", toolName: event.toolName, input: safe(event.input) });
  });
  pi.on("tool_result", async (event) => {
    append({
      type: "tool_result",
      toolName: event.toolName,
      isError: event.isError === true,
      output: safe(event.output ?? event.result ?? event.content ?? event.details ?? null),
    });
  });
}
`, "utf-8");
  return { extensionPath, logPath };
}

function spawnPi(cwd, args, envOverrides = undefined) {
  return new Promise((resolve, reject) => {
    const child = spawn(piBin, args, {
      cwd,
      env: { ...process.env, ASYNC_SUBAGENTS_MODEL: model, PI_SUBAGENTS_MODEL: model, ...envOverrides, PI_OFFLINE: "1", NO_COLOR: "1", CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      logProgress(`Agent timed out after ${timeoutMs}ms; sending SIGTERM and preserving partial output`);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) {
          logProgress("Agent did not exit after SIGTERM; sending SIGKILL");
          child.kill("SIGKILL");
        }
      }, 2_000);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf-8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf-8"); });
    child.once("error", (error) => {
      if (settled) return;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.once("exit", (exitCode) => { finish({ stdout, stderr, exitCode, timedOut }); });
  });
}

function readOptional(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
}

function readSubagentEvents(projectDir) {
  const runRoot = path.join(projectDir, ".pi", "subagents");
  if (!fs.existsSync(runRoot)) return "";
  const chunks = [];
  for (const runName of fs.readdirSync(runRoot)) {
    const runDir = path.join(runRoot, runName);
    if (!fs.statSync(runDir).isDirectory()) continue;
    for (const agentName of fs.readdirSync(runDir)) {
      const eventsPath = path.join(runDir, agentName, "events.jsonl");
      const text = readOptional(eventsPath);
      if (text) chunks.push(text);
    }
  }
  return chunks.join("\n");
}

function analyzeSessionArtifacts({ projectDir, sessionDir, stdout, stderr, eventText }) {
  const parentToolIoTokens = estimateTokens(eventText);
  const parentSession = analyzeSessionPath(sessionDir);
  const subagentRuns = analyzeSubagentRuns(projectDir);
  const answerText = `${stdout}\n${stderr}`.trim();
  const subagentSessionTokens = subagentRuns.reduce((sum, agent) => sum + agent.estimatedSessionTokens, 0);

  return {
    tokenEstimate: "ceil(serialized chars / 4); burnedTokens excludes sub-agent sessions",
    burnedTokens: parentToolIoTokens,
    parent: {
      toolIoTokens: parentToolIoTokens,
      sessionArtifactTokens: parentSession.estimatedSessionTokens,
      assistantTextTokens: parentSession.assistantTextTokens || estimateTokens(stdout),
      usageTokens: parentSession.usageTokens,
      answerPreview: previewText(answerText, 700),
    },
    subagents: {
      count: subagentRuns.length,
      totalEstimatedSessionTokens: subagentSessionTokens,
      agents: subagentRuns,
    },
  };
}

function collectSessionArtifacts(projectDir, parentSessionDir, options) {
  return {
    pathsRetained: options.pathsRetained,
    parent: {
      sessionId: path.basename(parentSessionDir),
      sessionDir: parentSessionDir,
      files: fs.existsSync(parentSessionDir) ? sessionFileRecords(collectJsonLikeFiles(parentSessionDir)) : [],
    },
    subagents: collectSubagentSessionArtifacts(projectDir),
  };
}

function collectSubagentSessionArtifacts(projectDir) {
  const runRoot = path.join(projectDir, ".pi", "subagents");
  if (!fs.existsSync(runRoot)) return [];
  const artifacts = [];
  for (const runName of safeReaddir(runRoot)) {
    const runDir = path.join(runRoot, runName);
    if (!safeIsDirectory(runDir)) continue;
    for (const agentId of safeReaddir(runDir)) {
      const agentDir = path.join(runDir, agentId);
      if (!safeIsDirectory(agentDir)) continue;
      const sessionDir = readOptional(path.join(agentDir, "session_dir")).trim();
      const sessionFile = readOptional(path.join(agentDir, "session_file")).trim();
      artifacts.push({
        id: agentId,
        runDir,
        agentDir,
        sessionId: sessionFile ? sessionArtifactId(sessionFile) : sessionDir ? path.basename(sessionDir) : undefined,
        sessionDir: sessionDir || undefined,
        sessionFile: sessionFile || undefined,
        files: sessionDir && fs.existsSync(sessionDir) ? sessionFileRecords(collectJsonLikeFiles(sessionDir)) : [],
        linkedSessionFile: sessionFile && fs.existsSync(sessionFile) ? sessionFileRecords([sessionFile])[0] : undefined,
      });
    }
  }
  return artifacts;
}

function persistModeArtifacts({ modeName, projectDir, sessionArtifacts, stdout, stderr, eventText, subagentEventText, idxCalls }) {
  const modeDir = path.join(reportDir, "modes", safeFileName(modeName));
  const filesDir = path.join(modeDir, "files");
  fs.mkdirSync(filesDir, { recursive: true });

  const files = {
    stdout: writeArtifactFile(path.join(filesDir, "stdout.txt"), stdout),
    stderr: writeArtifactFile(path.join(filesDir, "stderr.txt"), stderr),
    toolEvents: writeArtifactFile(path.join(filesDir, "tool-events.jsonl"), eventText),
    subagentEvents: writeArtifactFile(path.join(filesDir, "subagent-events.jsonl"), subagentEventText),
    idxCalls: writeArtifactFile(path.join(filesDir, "idx-calls.json"), JSON.stringify(idxCalls, null, 2)),
  };

  const sessionExports = [];
  const seen = new Set();
  const parentRecords = sessionArtifacts.parent.files ?? [];
  for (const record of parentRecords) {
    persistSessionExport({ modeDir, sessionExports, seen, kind: "parent", ownerId: "parent", record });
  }

  for (const subagent of sessionArtifacts.subagents ?? []) {
    const records = [...(subagent.files ?? [])];
    if (subagent.linkedSessionFile) records.push(subagent.linkedSessionFile);
    for (const record of records) {
      persistSessionExport({ modeDir, sessionExports, seen, kind: "subagent", ownerId: subagent.id, record });
    }
  }

  const projectSnapshot = keepRuns ? undefined : copyDebugSnapshot(projectDir, modeDir);

  return {
    directory: modeDir,
    files,
    sessionExports,
    projectSnapshot,
  };
}

function writeArtifactFile(targetPath, text) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, text ?? "", "utf-8");
  return fileRecord(targetPath);
}

function persistSessionExport({ modeDir, sessionExports, seen, kind, ownerId, record }) {
  if (!record?.path || seen.has(record.path) || !fs.existsSync(record.path)) return;
  seen.add(record.path);

  const sessionDir = path.join(modeDir, "sessions", safeFileName(kind), safeFileName(ownerId));
  const htmlDir = path.join(modeDir, "session-html", safeFileName(kind), safeFileName(ownerId));
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(htmlDir, { recursive: true });

  const copiedSessionPath = path.join(sessionDir, `${safeFileName(record.id)}${path.extname(record.path) || ".jsonl"}`);
  fs.copyFileSync(record.path, copiedSessionPath);
  const exportRecord = {
    kind,
    ownerId,
    sessionId: record.id,
    sourcePath: record.path,
    copiedSession: fileRecord(copiedSessionPath),
    html: undefined,
    exportError: undefined,
  };

  if (exportSessionHtml) {
    const htmlPath = path.join(htmlDir, `${safeFileName(record.id)}.html`);
    const exported = exportSessionToHtml(copiedSessionPath, htmlPath);
    exportRecord.html = exported.html;
    exportRecord.exportError = exported.error;
  }

  sessionExports.push(exportRecord);
}

function exportSessionToHtml(sessionFile, htmlPath) {
  fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
  const result = spawnSync(piBin, ["--export", sessionFile, htmlPath], {
    env: { ...process.env, PI_OFFLINE: "1", NO_COLOR: "1", CI: "1" },
    encoding: "utf-8",
    timeout: sessionExportTimeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  const status = result.status ?? (result.signal ? 128 : 1);
  if (!result.error && status === 0 && fs.existsSync(htmlPath)) return { html: fileRecord(htmlPath) };
  return {
    html: fs.existsSync(htmlPath) ? fileRecord(htmlPath) : undefined,
    error: [
      `pi --export failed for ${sessionFile}`,
      `status=${status}${result.signal ? ` signal=${result.signal}` : ""}`,
      result.error ? `error=${result.error.message}` : "",
      result.stdout ? `STDOUT: ${previewText(result.stdout, 600)}` : "",
      result.stderr ? `STDERR: ${previewText(result.stderr, 600)}` : "",
    ].filter(Boolean).join("\n"),
  };
}

function copyDebugSnapshot(projectDir, modeDir) {
  const snapshotDir = path.join(modeDir, "debug-snapshot");
  const candidates = [".pi/idx-events.jsonl", ".indexer-cli"];
  let copied = 0;
  for (const relative of candidates) {
    const source = path.join(projectDir, relative);
    if (!fs.existsSync(source)) continue;
    const target = path.join(snapshotDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
    copied += 1;
  }
  return copied > 0 ? { directory: snapshotDir, copiedItems: copied } : undefined;
}

function fileRecord(targetPath) {
  return {
    path: targetPath,
    bytes: fs.existsSync(targetPath) ? fs.statSync(targetPath).size : 0,
  };
}

function safeFileName(value) {
  return String(value || "unknown").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function sessionFileRecords(files) {
  return files.map((file) => ({
    id: sessionArtifactId(file),
    path: file,
    bytes: fs.existsSync(file) ? fs.statSync(file).size : 0,
  }));
}

function sessionArtifactId(file) {
  const base = path.basename(file);
  return base.replace(/\.(jsonl?|txt|md)$/i, "");
}

function analyzeSubagentRuns(projectDir) {
  const runRoot = path.join(projectDir, ".pi", "subagents");
  if (!fs.existsSync(runRoot)) return [];
  const agents = [];
  for (const runName of safeReaddir(runRoot)) {
    const runDir = path.join(runRoot, runName);
    if (!safeIsDirectory(runDir)) continue;
    for (const agentId of safeReaddir(runDir)) {
      const agentDir = path.join(runDir, agentId);
      if (!safeIsDirectory(agentDir)) continue;
      const sessionDir = readOptional(path.join(agentDir, "session_dir")).trim();
      const sessionFile = readOptional(path.join(agentDir, "session_file")).trim();
      const result = readOptional(path.join(agentDir, "result.md"));
      const stderr = readOptional(path.join(agentDir, "stderr.log"));
      const eventsText = readOptional(path.join(agentDir, "events.jsonl"));
      const session = analyzeSessionPath(sessionDir || path.join(agentDir, "session"));
      const linkedSession = sessionFile ? analyzeSessionFile(sessionFile) : emptySessionAnalysis();
      const merged = mergeSessionAnalyses(session, linkedSession);
      const fallbackTokens = merged.estimatedSessionTokens || estimateTokens(eventsText);
      agents.push({
        id: agentId,
        runDir,
        status: readOptional(path.join(agentDir, "exit_code")).trim() || "unknown",
        estimatedSessionTokens: fallbackTokens,
        sessionArtifactTokens: merged.estimatedSessionTokens,
        transcriptTokens: estimateTokens(eventsText),
        assistantTextTokens: merged.assistantTextTokens || estimateTokens(result),
        usageTokens: merged.usageTokens,
        resultPreview: previewText(result || stderr, 500),
      });
    }
  }
  return agents.sort((a, b) => b.estimatedSessionTokens - a.estimatedSessionTokens);
}

function analyzeSessionPath(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) return emptySessionAnalysis();
  const files = safeIsDirectory(targetPath) ? collectJsonLikeFiles(targetPath) : [targetPath];
  return analyzeSessionFiles(files);
}

function analyzeSessionFile(file) {
  return file && fs.existsSync(file) ? analyzeSessionFiles([file]) : emptySessionAnalysis();
}

function analyzeSessionFiles(files) {
  const analysis = emptySessionAnalysis();
  const seenFiles = new Set();
  for (const file of files) {
    if (seenFiles.has(file) || !fs.existsSync(file) || safeIsDirectory(file)) continue;
    seenFiles.add(file);
    const text = readOptional(file);
    analysis.artifactBytes += Buffer.byteLength(text);
    analysis.files += 1;
    for (const value of parseJsonArtifacts(text)) collectSessionSignals(value, analysis);
  }
  analysis.estimatedSessionTokens = estimateTokens(analysis.artifactBytes);
  analysis.assistantTextTokens = estimateTokens(analysis.assistantTextChars);
  analysis.toolIoTokens = estimateTokens(analysis.toolIoChars);
  return analysis;
}

function emptySessionAnalysis() {
  return {
    files: 0,
    artifactBytes: 0,
    estimatedSessionTokens: 0,
    assistantTextChars: 0,
    assistantTextTokens: 0,
    toolIoChars: 0,
    toolIoTokens: 0,
    usageTokens: undefined,
  };
}

function mergeSessionAnalyses(...items) {
  const merged = emptySessionAnalysis();
  let usageTokens = 0;
  let hasUsage = false;
  for (const item of items) {
    merged.files += item.files;
    merged.artifactBytes += item.artifactBytes;
    merged.assistantTextChars += item.assistantTextChars;
    merged.toolIoChars += item.toolIoChars;
    if (typeof item.usageTokens === "number") {
      usageTokens += item.usageTokens;
      hasUsage = true;
    }
  }
  merged.estimatedSessionTokens = estimateTokens(merged.artifactBytes);
  merged.assistantTextTokens = estimateTokens(merged.assistantTextChars);
  merged.toolIoTokens = estimateTokens(merged.toolIoChars);
  merged.usageTokens = hasUsage ? usageTokens : undefined;
  return merged;
}

function collectJsonLikeFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (safeIsDirectory(current)) {
      for (const name of safeReaddir(current)) stack.push(path.join(current, name));
      continue;
    }
    if (/\.(json|jsonl)$/i.test(current) || path.basename(current).includes("session")) files.push(current);
  }
  return files;
}

function parseJsonArtifacts(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    return [JSON.parse(trimmed)];
  } catch {
    const values = [];
    for (const line of trimmed.split("\n")) {
      const item = line.trim();
      if (!item) continue;
      try { values.push(JSON.parse(item)); } catch { /* ignore non-JSON session lines */ }
    }
    return values;
  }
}

function collectSessionSignals(value, analysis, depth = 0) {
  if (depth > 16 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectSessionSignals(item, analysis, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  const record = value;
  const role = typeof record.role === "string" ? record.role : "";
  if (role === "assistant") analysis.assistantTextChars += extractContentText(record.content).length;

  const eventType = typeof record.type === "string" ? record.type : "";
  if (eventType === "tool_call" || eventType === "tool_result") {
    analysis.toolIoChars += JSON.stringify(record).length;
  }

  const usage = extractUsageTokens(record);
  if (typeof usage === "number") analysis.usageTokens = (analysis.usageTokens ?? 0) + usage;

  for (const child of Object.values(record)) collectSessionSignals(child, analysis, depth + 1);
}

function extractContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const item of content) {
    if (typeof item === "string") parts.push(item);
    else if (item && typeof item === "object" && item.type === "text" && typeof item.text === "string") parts.push(item.text);
  }
  return parts.join("\n");
}

function extractUsageTokens(record) {
  const keys = ["totalTokens", "total_tokens", "tokens", "promptTokens", "prompt_tokens", "inputTokens", "input_tokens", "completionTokens", "completion_tokens", "outputTokens", "output_tokens"];
  const usage = record.usage && typeof record.usage === "object" ? record.usage : record.tokenUsage && typeof record.tokenUsage === "object" ? record.tokenUsage : undefined;
  if (!usage) return undefined;
  if (typeof usage.totalTokens === "number") return usage.totalTokens;
  if (typeof usage.total_tokens === "number") return usage.total_tokens;
  let sum = 0;
  for (const key of keys) {
    if (key === "totalTokens" || key === "total_tokens" || key === "tokens") continue;
    if (typeof usage[key] === "number") sum += usage[key];
  }
  return sum > 0 ? sum : undefined;
}

function printSummaryTable(results, htmlPath) {
  const rows = results
    .map((result) => ({
      mode: result.mode,
      ok: result.success ? "yes" : "no",
      burned: result.metrics?.burnedTokens ?? result.roughToolIoTokens,
      subagent: result.metrics?.subagents?.totalEstimatedSessionTokens ?? 0,
      total: (result.metrics?.burnedTokens ?? result.roughToolIoTokens) + (result.metrics?.subagents?.totalEstimatedSessionTokens ?? 0),
      calls: result.toolCallCount,
      evidenceCall: result.firstCorrectEvidence?.found ? result.firstCorrectEvidence.toolCallNumber : "",
      evidenceTokens: result.firstCorrectEvidence?.found ? result.firstCorrectEvidence.tokensAtEvidence : "",
      elapsed: result.elapsedMs,
    }))
    .sort((a, b) => a.total - b.total);
  const headers = ["mode", "success", "parent tokens", "subagent tokens", "total tokens", "tool calls", "evidence call", "evidence tokens", "elapsed ms"];
  const tableRows = rows.map((row) => [row.mode, row.ok, String(row.burned), String(row.subagent), String(row.total), String(row.calls), String(row.evidenceCall), String(row.evidenceTokens), String(row.elapsed)]);
  const widths = headers.map((header, index) => Math.max(header.length, ...tableRows.map((row) => row[index].length)));
  const formatRow = (row) => row.map((cell, index) => index === 0 ? cell.padEnd(widths[index]) : cell.padStart(widths[index])).join("  ");
  process.stderr.write("\n[locate-bench] Results sorted by total estimated tokens (parent + sub-agent):\n");
  process.stderr.write(`${formatRow(headers)}\n`);
  process.stderr.write(`${widths.map((width) => "-".repeat(width)).join("  ")}\n`);
  for (const row of tableRows) process.stderr.write(`${formatRow(row)}\n`);
  process.stderr.write(`\n[locate-bench] HTML report: ${toFileUrl(htmlPath)}\n`);
  process.stderr.write("\n");
}

function summarizeResults(results) {
  const rows = results.map((result) => {
    const parentTokens = result.metrics?.burnedTokens ?? result.roughToolIoTokens;
    const subagentTokens = result.metrics?.subagents?.totalEstimatedSessionTokens ?? 0;
    return {
      mode: result.mode,
      success: result.success,
      parentTokens,
      subagentTokens,
      totalEstimatedTokens: parentTokens + subagentTokens,
      toolCallCount: result.toolCallCount,
      firstCorrectEvidence: result.firstCorrectEvidence ?? { found: false },
      firstCorrectEvidenceCall: result.firstCorrectEvidence?.found ? result.firstCorrectEvidence.toolCallNumber : undefined,
      firstCorrectEvidenceTokens: result.firstCorrectEvidence?.found ? result.firstCorrectEvidence.tokensAtEvidence : undefined,
      elapsedMs: result.elapsedMs,
      timedOut: result.timedOut,
    };
  });
  const successful = rows.filter((row) => row.success);
  return {
    tokenMetric: "totalEstimatedTokens = parent tool I/O estimate + sub-agent session estimate; estimates are ceil(serialized chars / 4)",
    modes: rows.length,
    successes: successful.length,
    rows: [...rows].sort((a, b) => a.totalEstimatedTokens - b.totalEstimatedTokens),
    bestByTotalTokens: minBy(successful, (row) => row.totalEstimatedTokens),
    bestByParentTokens: minBy(successful, (row) => row.parentTokens),
    bestByFirstEvidenceTokens: minBy(successful.filter((row) => row.firstCorrectEvidence?.found), (row) => row.firstCorrectEvidenceTokens),
    fastest: minBy(successful, (row) => row.elapsedMs),
  };
}

function minBy(items, score) {
  if (items.length === 0) return undefined;
  return items.reduce((best, item) => score(item) < score(best) ? item : best, items[0]);
}

function writeHtmlReport(report, targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, renderHtmlReport(report, targetPath), "utf-8");
}

function renderHtmlReport(report, targetPath) {
  const idxUpdate = report.preflight?.idxUpdate;
  const idxUpdateText = idxUpdate?.skipped
    ? `skipped${idxUpdate.reason ? ` (${idxUpdate.reason})` : ""}`
    : idxUpdate
      ? `${idxUpdate.elapsedMs}ms`
      : "n/a";
  const rows = [...report.summary.rows].sort((a, b) => a.parentTokens - b.parentTokens);
  const resultByMode = new Map(report.results.map((result) => [result.mode, result]));
  const summaryRows = rows.map((row) => {
    const result = resultByMode.get(row.mode);
    const color = modeColor(row.mode);
    return `<tr>
      <td><a href="#mode-${escapeAttr(safeFileName(row.mode))}">${escapeHtml(row.mode)}</a></td>
      <td>${statusBadge(row.success, row.timedOut)}</td>
      <td class="num" style="color: ${color}; font-weight: 800;">${formatNumber(row.parentTokens)}</td>
      <td class="num">${formatNumber(row.subagentTokens)}</td>
      <td class="num strong">${formatNumber(row.totalEstimatedTokens)}</td>
      <td class="num">${formatNumber(row.toolCallCount)}</td>
      <td class="num">${row.firstCorrectEvidence?.found ? formatNumber(row.firstCorrectEvidenceCall) : "—"}</td>
      <td class="num">${row.firstCorrectEvidence?.found ? formatNumber(row.firstCorrectEvidenceTokens) : "—"}</td>
      <td class="num">${formatNumber(row.elapsedMs)}</td>
      <td>${escapeHtml((result?.toolCalls ?? []).join(" → "))}</td>
    </tr>`;
  }).join("\n");

  const modeCards = rows
    .map((row) => resultByMode.get(row.mode))
    .filter(Boolean)
    .map((result) => renderModeCard(result, targetPath))
    .join("\n");
  const embeddedJson = escapeHtml(JSON.stringify(report, null, 2));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Locate benchmark — ${escapeHtml(report.fixture)}</title>
  <style>
    :root { color-scheme: light dark; --bg: #0f172a; --panel: #111827; --muted: #94a3b8; --text: #e5e7eb; --line: #334155; --accent: #38bdf8; --ok: #22c55e; --bad: #ef4444; --warn: #f59e0b; }
    @media (prefers-color-scheme: light) { :root { --bg: #f8fafc; --panel: #ffffff; --muted: #64748b; --text: #0f172a; --line: #dbe3ef; --accent: #0369a1; } }
    body { margin: 0; font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; background: var(--bg); color: var(--text); }
    main { max-width: 1280px; margin: 0 auto; padding: 28px; }
    h1, h2, h3 { line-height: 1.15; }
    .hero, .card { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 20px; margin: 16px 0; box-shadow: 0 12px 32px #0002; }
    .section-head { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
    .top-link { flex: 0 0 auto; border: 1px solid var(--line); border-radius: 999px; padding: 6px 10px; text-decoration: none; background: #ffffff0d; font-weight: 700; }
    .top-link:hover { border-color: var(--accent); }
    .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; color: var(--muted); }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); background: #ffffff10; }
    .ok { color: var(--ok); font-weight: 700; } .bad { color: var(--bad); font-weight: 700; } .warn { color: var(--warn); font-weight: 700; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0; }
    th, td { border-bottom: 1px solid var(--line); padding: 8px 10px; vertical-align: top; }
    th { text-align: left; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
    .num { text-align: right; font-variant-numeric: tabular-nums; } .strong { font-weight: 800; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    pre { white-space: pre-wrap; overflow: auto; background: #00000024; border: 1px solid var(--line); border-radius: 12px; padding: 12px; }
    a { color: var(--accent); }
    .tabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 14px 0 8px; }
    .tab-button { border: 1px solid var(--line); background: #ffffff0d; color: var(--text); border-radius: 999px; padding: 6px 10px; cursor: pointer; }
    .tab-button.active { border-color: var(--accent); color: var(--accent); }
    .tab-panel { display: none; } .tab-panel.active { display: block; }
    .iframe-wrap { height: 680px; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; background: white; }
    iframe { width: 100%; height: 100%; border: 0; background: white; }
    .small { color: var(--muted); font-size: 12px; }
    .chart { display: grid; gap: 10px; margin: 18px 0 4px; }
    .bar-row { display: grid; grid-template-columns: minmax(150px, 220px) 1fr minmax(88px, auto); align-items: center; gap: 10px; }
    .bar-label { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bar-track { position: relative; height: 28px; border: 1px solid var(--line); border-radius: 999px; overflow: hidden; background: #00000020; }
    .bar-fill { height: 100%; min-width: 3px; border-radius: 999px; box-shadow: inset 0 0 0 1px #ffffff33; }
    .bar-value { text-align: right; font-variant-numeric: tabular-nums; font-weight: 800; }
  </style>
</head>
<body id="top">
<main>
  <section class="hero">
    <h1>Hard-to-find locate benchmark</h1>
    <p>${escapeHtml(report.prompt)}</p>
    <p class="small"><b>Shared guidance:</b> ${escapeHtml(report.benchmarkGuidance ?? "")}</p>
    <div class="meta">
      <div><b>Fixture:</b> ${escapeHtml(report.fixture)}</div>
      <div><b>Model:</b> ${escapeHtml(report.model)}</div>
      <div><b>Generated:</b> ${escapeHtml(report.generatedAt)}</div>
      <div><b>Fake idx:</b> ${escapeHtml(String(report.fakeIdx))}</div>
      <div><b>idx update:</b> ${escapeHtml(idxUpdateText)}</div>
      <div><b>JSON:</b> <a href="${escapeAttr(relativeHref(report.report.json, targetPath))}">${escapeHtml(path.basename(report.report.json))}</a></div>
    </div>
    <p class="small">${escapeHtml(report.summary.tokenMetric)}</p>
  </section>

  <section class="card">
    <h2>Summary</h2>
    <div class="meta">
      <div><b>Successes:</b> ${report.summary.successes}/${report.summary.modes}</div>
      <div><b>Best total tokens:</b> ${escapeHtml(report.summary.bestByTotalTokens?.mode ?? "n/a")}</div>
      <div><b>Best parent tokens:</b> ${escapeHtml(report.summary.bestByParentTokens?.mode ?? "n/a")}</div>
      <div><b>First evidence:</b> ${escapeHtml(report.summary.bestByFirstEvidenceTokens?.mode ?? "n/a")}</div>
      <div><b>Fastest:</b> ${escapeHtml(report.summary.fastest?.mode ?? "n/a")}</div>
    </div>
    <table>
      <thead><tr><th>Mode</th><th>Status</th><th class="num">Parent tokens</th><th class="num">Sub-agent tokens</th><th class="num">Total tokens</th><th class="num">Tool calls</th><th class="num">Evidence call</th><th class="num">Evidence tokens</th><th class="num">Elapsed ms</th><th>Tool sequence</th></tr></thead>
      <tbody>${summaryRows}</tbody>
    </table>
    <h3>Parent tokens chart</h3>
    ${renderParentTokenChart(rows)}
  </section>

  ${modeCards}

  <section class="card">
    <h2>Embedded JSON report</h2>
    <pre>${embeddedJson}</pre>
  </section>
</main>
<script>
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-tab-target]');
  if (!button) return;
  const group = button.getAttribute('data-tab-group');
  const target = button.getAttribute('data-tab-target');
  document.querySelectorAll('[data-tab-group="' + group + '"]').forEach((item) => item.classList.remove('active'));
  document.querySelectorAll('[data-tab-panel-group="' + group + '"]').forEach((item) => item.classList.remove('active'));
  button.classList.add('active');
  const panel = document.getElementById(target);
  if (panel) panel.classList.add('active');
});
</script>
</body>
</html>`;
}

function renderModeCard(result, targetPath) {
  const id = safeFileName(result.mode);
  const parentTokens = result.metrics?.burnedTokens ?? result.roughToolIoTokens;
  const subagentTokens = result.metrics?.subagents?.totalEstimatedSessionTokens ?? 0;
  const totalTokens = parentTokens + subagentTokens;
  const toolCounts = countItems(result.toolCalls);
  const group = `mode-${id}`;
  const persisted = result.persistedArtifacts;
  const sessionExports = persisted?.sessionExports ?? [];
  const firstSession = sessionExports.find((item) => item.html?.path);
  const subagentSessions = sessionExports.filter((item) => item.kind === "subagent" && item.html?.path);
  return `<section class="card" id="mode-${escapeAttr(id)}">
    <div class="section-head">
      <h2>${escapeHtml(result.mode)} ${statusBadge(result.success, result.timedOut)}</h2>
      <a class="top-link" href="#top" title="Scroll to top">↑ top</a>
    </div>
    <div class="meta">
      <div><b>Total tokens:</b> ${formatNumber(totalTokens)}</div>
      <div><b>Parent tokens:</b> ${formatNumber(parentTokens)}</div>
      <div><b>Sub-agent tokens:</b> ${formatNumber(subagentTokens)}</div>
      <div><b>Elapsed:</b> ${formatNumber(result.elapsedMs)}ms</div>
      <div><b>Tool calls:</b> ${formatNumber(result.toolCallCount)}</div>
      <div><b>First evidence:</b> ${result.firstCorrectEvidence?.found ? `call ${formatNumber(result.firstCorrectEvidence.toolCallNumber)}, ${formatNumber(result.firstCorrectEvidence.tokensAtEvidence)} tokens` : "not found in tool output"}</div>
      <div><b>Exit:</b> ${escapeHtml(String(result.exitCode))}</div>
    </div>
    <div class="tabs">
      ${tabButton(group, `${group}-overview`, "Overview", true)}
      ${tabButton(group, `${group}-tools`, "Tools", false)}
      ${tabButton(group, `${group}-sessions`, `Sessions (${sessionExports.length})`, false)}
      ${firstSession ? tabButton(group, `${group}-session-html`, "Session HTML", false) : ""}
      ${subagentSessions.length > 0 ? tabButton(group, `${group}-subagent-html`, `Sub-agent HTML (${subagentSessions.length})`, false) : ""}
      ${tabButton(group, `${group}-raw`, "Raw", false)}
    </div>
    <div id="${group}-overview" data-tab-panel-group="${group}" class="tab-panel active">
      <h3>Answer preview</h3>
      <pre>${escapeHtml(result.metrics?.parent?.answerPreview ?? "")}</pre>
      <h3>First correct evidence</h3>
      <pre>${escapeHtml(JSON.stringify(result.firstCorrectEvidence ?? { found: false }, null, 2))}</pre>
      <h3>Preparation</h3>
      <pre>${escapeHtml(JSON.stringify(result.preparation ?? {}, null, 2))}</pre>
    </div>
    <div id="${group}-tools" data-tab-panel-group="${group}" class="tab-panel">
      <h3>Tool sequence</h3>
      <pre>${escapeHtml(result.toolCalls.join("\n"))}</pre>
      <h3>Tool counts</h3>
      ${renderObjectTable(toolCounts)}
      <h3>Persisted tool artifacts</h3>
      ${renderArtifactLinks(persisted?.files, targetPath)}
    </div>
    <div id="${group}-sessions" data-tab-panel-group="${group}" class="tab-panel">
      ${renderSessionExports(sessionExports, targetPath)}
      <h3>Sub-agent metrics</h3>
      <pre>${escapeHtml(JSON.stringify(result.metrics?.subagents ?? {}, null, 2))}</pre>
    </div>
    ${firstSession ? `<div id="${group}-session-html" data-tab-panel-group="${group}" class="tab-panel">
      <p><a href="${escapeAttr(relativeHref(firstSession.html.path, targetPath))}">Open exported session HTML in a new tab</a></p>
      <div class="iframe-wrap"><iframe src="${escapeAttr(relativeHref(firstSession.html.path, targetPath))}" loading="lazy"></iframe></div>
    </div>` : ""}
    ${subagentSessions.length > 0 ? `<div id="${group}-subagent-html" data-tab-panel-group="${group}" class="tab-panel">
      ${renderSubagentSessionHtml(subagentSessions, targetPath)}
    </div>` : ""}
    <div id="${group}-raw" data-tab-panel-group="${group}" class="tab-panel">
      <pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre>
    </div>
  </section>`;
}

function renderParentTokenChart(rows) {
  if (rows.length === 0) return "<p class=\"small\">No benchmark rows.</p>";
  const maxParentTokens = Math.max(1, ...rows.map((row) => row.parentTokens));
  return `<div class="chart" aria-label="Parent token bar chart">${rows.map((row) => {
    const width = Math.max(2, Math.round((row.parentTokens / maxParentTokens) * 100));
    const color = modeColor(row.mode);
    return `<div class="bar-row">
      <div class="bar-label" title="${escapeAttr(row.mode)}">${escapeHtml(row.mode)}</div>
      <div class="bar-track" title="${escapeAttr(`${row.mode}: ${row.parentTokens} parent tokens`)}"><div class="bar-fill" style="width: ${width}%; background: linear-gradient(90deg, ${color}, ${color}aa);"></div></div>
      <div class="bar-value">${formatNumber(row.parentTokens)}</div>
    </div>`;
  }).join("\n")}</div>`;
}

function modeColor(modeName) {
  const colors = {
    "direct-read-grep": "#22c55e",
    "ast-structural": "#38bdf8",
    "repo-search-hybrid": "#a78bfa",
    "semantic-repo-search": "#a78bfa",
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

function tabButton(group, target, label, active) {
  return `<button type="button" class="tab-button${active ? " active" : ""}" data-tab-group="${escapeAttr(group)}" data-tab-target="${escapeAttr(target)}">${escapeHtml(label)}</button>`;
}

function renderObjectTable(object) {
  const entries = Object.entries(object);
  if (entries.length === 0) return "<p class=\"small\">No entries.</p>";
  return `<table><thead><tr><th>Name</th><th class="num">Count</th></tr></thead><tbody>${entries.map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td class="num">${formatNumber(value)}</td></tr>`).join("")}</tbody></table>`;
}

function renderArtifactLinks(files, targetPath) {
  const entries = Object.entries(files ?? {}).filter(([, record]) => record?.path);
  if (entries.length === 0) return "<p class=\"small\">No persisted files.</p>";
  return `<ul>${entries.map(([name, record]) => `<li><b>${escapeHtml(name)}:</b> <a href="${escapeAttr(relativeHref(record.path, targetPath))}">${escapeHtml(path.basename(record.path))}</a> <span class="small">${formatNumber(record.bytes)}B</span></li>`).join("")}</ul>`;
}

function renderSessionExports(exports, targetPath) {
  if (exports.length === 0) return "<p class=\"small\">No session files were found. Ensure PI_LOCATE_BENCH_SAVE_SESSIONS is not set to 0.</p>";
  return `<table><thead><tr><th>Kind</th><th>Owner</th><th>Session</th><th>Copied JSONL</th><th>HTML export</th><th>Error</th></tr></thead><tbody>${exports.map((item) => `<tr>
    <td>${escapeHtml(item.kind)}</td>
    <td>${escapeHtml(item.ownerId)}</td>
    <td>${escapeHtml(item.sessionId)}</td>
    <td>${item.copiedSession?.path ? `<a href="${escapeAttr(relativeHref(item.copiedSession.path, targetPath))}">${escapeHtml(path.basename(item.copiedSession.path))}</a>` : ""}</td>
    <td>${item.html?.path ? `<a href="${escapeAttr(relativeHref(item.html.path, targetPath))}">HTML</a>` : ""}</td>
    <td>${item.exportError ? `<pre>${escapeHtml(item.exportError)}</pre>` : ""}</td>
  </tr>`).join("")}</tbody></table>`;
}

function renderSubagentSessionHtml(exports, targetPath) {
  return exports.map((item, index) => {
    const href = relativeHref(item.html.path, targetPath);
    return `<section class="card">
      <h3>Sub-agent session: ${escapeHtml(item.ownerId)} <span class="small">${escapeHtml(item.sessionId)}</span></h3>
      <p><a href="${escapeAttr(href)}">Open exported sub-agent session HTML in a new tab</a></p>
      <div class="iframe-wrap"><iframe src="${escapeAttr(href)}" loading="${index === 0 ? "eager" : "lazy"}"></iframe></div>
    </section>`;
  }).join("\n");
}

function countItems(items) {
  const counts = {};
  for (const item of items ?? []) counts[item] = (counts[item] ?? 0) + 1;
  return counts;
}

function statusBadge(success, timedOut) {
  if (timedOut) return `<span class="warn">timeout</span>`;
  return success ? `<span class="ok">yes</span>` : `<span class="bad">no</span>`;
}

function relativeHref(targetPath, fromHtmlPath) {
  return path.relative(path.dirname(fromHtmlPath), targetPath).split(path.sep).map(encodeURIComponent).join("/");
}

function toFileUrl(targetPath) {
  return `file://${path.resolve(targetPath).split(path.sep).map((part, index) => index === 0 ? part : encodeURIComponent(part)).join("/")}`;
}

function formatNumber(value) {
  return Number(value ?? 0).toLocaleString("en-US");
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

function previewText(text, maxChars) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}…` : normalized;
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function safeIsDirectory(targetPath) {
  try { return fs.statSync(targetPath).isDirectory(); } catch { return false; }
}

function parseEvents(text) {
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function readIdxEvents(projectDir) {
  const text = readOptional(path.join(projectDir, ".pi", "idx-events.jsonl"));
  if (!text) return [];
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line).args);
}
