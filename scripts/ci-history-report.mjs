import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const knownCodes = /\b(?:EBUSY|EPERM|EPIPE|ECONNRESET|EFAULT|ENOENT|ETIMEDOUT)\b/g;

export function failingTests(log) {
  const tests = new Set();
  for (const line of log.split(/\r?\n/)) {
    const bun = /^\(fail\) (.+?)(?: \[\d[\d.]*ms\])?$/.exec(line);
    const node = /^\s*✖ (.+?)(?: \([\d.]+ms\))?$/.exec(line);
    if (bun || node) {
      const name = (bun || node)[1].trim();
      if (name !== "failing tests:") tests.add(name);
    }
  }
  return [...tests];
}

export function summarizeRuns(runs) {
  const platforms = new Map();
  const tests = new Map();
  const codes = new Map();
  const timings = new Map();
  for (const run of runs) {
    const { platform, status, results = [] } = run.summary;
    const gate = results.some(step => step.id === "test-contracts") ? "preflight" : "full";
    const platformKey = JSON.stringify([platform, gate]);
    const group = platforms.get(platformKey) || { platform, gate, runs: 0, passed: 0, failed: 0, incomplete: 0 };
    group.runs++;
    group[status === "passed" ? "passed" : status === "incomplete" ? "incomplete" : "failed"]++;
    platforms.set(platformKey, group);
    for (const step of results.filter(step => step.status !== "passed")) {
      const log = run.logs?.[step.id] || "";
      for (const name of failingTests(log)) {
        const key = JSON.stringify([platform, gate, name]);
        const entry = tests.get(key) || { platform, gate, name, occurrences: 0 };
        entry.occurrences++;
        tests.set(key, entry);
      }
      for (const code of new Set(log.match(knownCodes) || [])) {
        const key = JSON.stringify([platform, gate, code]);
        const entry = codes.get(key) || { platform, gate, code, runs: 0 };
        entry.runs++;
        codes.set(key, entry);
      }
    }
    const suiteLog = run.logs?.["tools-suite"] || "";
    const durations = [...suiteLog.matchAll(/Ran \d+ tests? across \d+ files\. \[([\d.]+)s\]/g)];
    if (durations.length) {
      const seconds = Number(durations.at(-1)[1]);
      if (Number.isFinite(seconds)) {
        const values = timings.get(platform) || [];
        values.push(seconds);
        timings.set(platform, values);
      }
    }
  }
  return {
    platforms: [...platforms.values()].sort((a, b) => a.platform.localeCompare(b.platform) || a.gate.localeCompare(b.gate)),
    tests: [...tests.values()].sort((a, b) => b.occurrences - a.occurrences || a.name.localeCompare(b.name)),
    codes: [...codes.values()].sort((a, b) => b.runs - a.runs || a.code.localeCompare(b.code)),
    bunSuiteSeconds: [...timings.entries()].map(([platform, values]) => {
      const sorted = values.sort((a, b) => a - b);
      return {
        platform, samples: sorted.length,
        median: sorted[Math.floor(sorted.length / 2)],
        max: sorted.at(-1),
      };
    }).sort((a, b) => a.platform.localeCompare(b.platform)),
  };
}

function readRun(summaryPath) {
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  if (!summary.platform || !Array.isArray(summary.results)) return undefined;
  const folder = dirname(summaryPath);
  const logs = {};
  for (const step of summary.results) {
    try { logs[step.id] = readFileSync(join(folder, `${step.id}.log`), "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return { summary, logs, source: summaryPath };
}

export function loadRuns(paths) {
  const files = [];
  const visit = (location, depth) => {
    if (depth > 8) return;
    const stats = lstatSync(location);
    if (stats.isSymbolicLink()) return;
    if (stats.isFile()) {
      if (basename(location) === "summary.json") files.push(location);
      return;
    }
    if (!stats.isDirectory()) return;
    for (const name of readdirSync(location)) {
      if (name === "node_modules" || name === ".git") continue;
      visit(join(location, name), depth + 1);
    }
  };
  for (const location of paths) visit(resolve(location), 0);
  return files.map(readRun).filter(Boolean);
}

function markdown(report) {
  const rows = [
    "# CI gate artifact history",
    "",
    "Statuses below are from gate summaries, not the enclosing GitHub Actions jobs. A job may still fail or be cancelled after its gate passes.",
    "",
    "| Platform | Gate | Runs | Passed | Failed | Incomplete |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
    ...report.platforms.map(p => `| ${p.platform} | ${p.gate} | ${p.runs} | ${p.passed} | ${p.failed} | ${p.incomplete} |`),
    "", "## Most frequent failed tests", "",
    "| Platform | Gate | Failure | Runs |", "| --- | --- | --- | ---: |",
    ...report.tests.slice(0, 20).map(t => `| ${t.platform} | ${t.gate} | ${t.name.replace(/\|/g, "\\|")} | ${t.occurrences} |`),
    "", "## Error-code signatures in failed-step logs", "",
    "| Platform | Gate | Code | Runs |", "| --- | --- | --- | ---: |",
    ...report.codes.map(c => `| ${c.platform} | ${c.gate} | ${c.code} | ${c.runs} |`),
    "", "## Bun tools-suite runtime (seconds)", "",
    "| Platform | Samples | Median | Max |", "| --- | ---: | ---: | ---: |",
    ...report.bunSuiteSeconds.map(t => `| ${t.platform} | ${t.samples} | ${t.median.toFixed(1)} | ${t.max.toFixed(1)} |`),
    "",
    "Only local downloaded CI gate artifacts were analyzed. Correlate with GitHub job status; repeated signatures are observations, not proof of flakiness.",
  ];
  return rows.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const json = args[0] === "--json";
  const inputs = json ? args.slice(1) : args;
  if (!inputs.length) {
    console.error("Usage: node scripts/ci-history-report.mjs [--json] <downloaded-artifact-directory>...");
    process.exitCode = 2;
  } else {
    try {
      const runs = loadRuns(inputs);
      if (!runs.length) throw new Error("No CI gate summary.json artifacts were found");
      const result = summarizeRuns(runs);
      console.log(json ? JSON.stringify(result, null, 2) : markdown(result));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
