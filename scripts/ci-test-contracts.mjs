import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const baselinePath = join(root, "scripts/ci-test-contract-baseline.json");
const testPath = /^(?:tests\/|acp\/test\/|desktop\/src\/|external\/pi-tools-suite\/test\/)/;
const testName = /(?:\.(?:test|spec)\.[cm]?[jt]sx?|\.case\.[cm]?js)$/;

function isCallNamed(node, name) {
  if (!ts.isCallExpression(node)) return false;
  const target = node.expression;
  return (ts.isIdentifier(target) && target.text === name) ||
    (ts.isPropertyAccessExpression(target) && target.name.text === name);
}

function contains(node, predicate) {
  if (predicate(node)) return true;
  return ts.forEachChild(node, child => contains(child, predicate)) === true;
}

function isElapsedDifference(node) {
  return ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.MinusToken &&
    isCallNamed(node.left, "now") &&
    ts.isPropertyAccessExpression(node.left.expression) &&
    node.left.expression.expression.getText() === "Date";
}

/** Review-sensitive source patterns, not a blanket ban on timeout/cleanup tests. */
export function detectTestContractHazards(filename, code) {
  const source = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true,
    /\.([jt]sx)$/.test(filename) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const sqliteTest = /(?:from\s*["'](?:bun:sqlite|node:sqlite)["']|require\(["'](?:bun:sqlite|node:sqlite)["']\))/.test(code);
  const found = [];
  const push = (rule, node) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push({
      rule, path: filename, line: line + 1,
      expression: node.getText(source).replace(/\s+/g, " ").trim(),
    });
  };
  const walk = node => {
    if (isCallNamed(node, "toBeLessThan") && ts.isPropertyAccessExpression(node.expression)) {
      const expect = node.expression.expression;
      if (isCallNamed(expect, "expect") && expect.arguments.some(arg => contains(arg, isElapsedDifference))) {
        push("elapsed-time-assertion", node);
      }
    }
    if (isCallNamed(node, "endsWith") && node.arguments.length === 1) {
      const suffix = node.arguments[0];
      if (ts.isStringLiteral(suffix) && /^[\\/]/.test(suffix.text) &&
        /\.(?:jsonl|sqlite|md|ts|tsx|js|jsonc?)$/i.test(suffix.text)) {
        push("os-specific-path-suffix", node);
      }
    }
    if (sqliteTest && (isCallNamed(node, "afterEach") || isCallNamed(node, "after"))) {
      for (const cb of node.arguments) {
        const examine = candidate => {
          if ((isCallNamed(candidate, "rm") || isCallNamed(candidate, "rmSync")) &&
            candidate.arguments.some(arg => /recursive\s*:\s*true/.test(arg.getText(source)))) {
            push("sqlite-direct-fixture-removal", candidate);
          }
          ts.forEachChild(candidate, examine);
        };
        examine(cb);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return found;
}

function gitTestFiles() {
  const raw = execFileSync("git", ["ls-files", "--cached", "-z"], { cwd: root });
  return raw.toString("utf8").split("\0")
    .filter(p => testPath.test(p) && testName.test(p) && existsSync(join(root, p)));
}

export function scanRepository() {
  return gitTestFiles().flatMap(path => detectTestContractHazards(path, readFileSync(join(root, path), "utf8")));
}

export function findingsToBaseline(findings) {
  const grouped = new Map();
  for (const { rule, path, expression } of findings) {
    const key = JSON.stringify([path, rule, expression]);
    grouped.set(key, { path, rule, expression, count: (grouped.get(key)?.count || 0) + 1 });
  }
  return [...grouped.values()].sort((a, b) =>
    a.path.localeCompare(b.path) || a.rule.localeCompare(b.rule) || a.expression.localeCompare(b.expression));
}

export function addedHazards(actual, baseline) {
  const old = new Map(baseline.map(item => [JSON.stringify([item.path, item.rule, item.expression]), item.count]));
  return actual.filter(item => item.count > (old.get(JSON.stringify([item.path, item.rule, item.expression])) || 0));
}

function main(args) {
  if (args.length !== 1 || !["--check", "--report", "--baseline"].includes(args[0])) {
    console.error("Usage: node scripts/ci-test-contracts.mjs --check|--report|--baseline");
    process.exitCode = 2;
    return;
  }
  const findings = scanRepository();
  const actual = findingsToBaseline(findings);
  if (args[0] === "--baseline") {
    console.log(JSON.stringify({ version: 1, allowed: actual }, null, 2));
  } else if (args[0] === "--report") {
    const counts = Object.groupBy(findings, item => item.rule);
    console.log(`CI test-contract review: ${findings.length} existing hazards in ${new Set(findings.map(f => f.path)).size} files`);
    for (const [rule, items] of Object.entries(counts)) console.log(`  ${rule}: ${items.length}`);
  } else {
    const { version, allowed } = JSON.parse(readFileSync(baselinePath, "utf8"));
    if (version !== 1 || !Array.isArray(allowed)) throw new Error("Invalid CI test-contract baseline");
    const additions = addedHazards(actual, allowed);
    if (additions.length) {
      for (const item of additions) {
        const location = findings.find(f => f.rule === item.rule && f.path === item.path && f.expression === item.expression);
        console.error(`${item.path}:${location?.line}: ${item.rule}: ${item.expression}`);
      }
      console.error("New CI test-contract hazards. Fix the tests, or explicitly review and regenerate the baseline.");
      process.exitCode = 1;
    } else console.log(`CI test contracts: no new hazards (${findings.length} known, baseline tracked).`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
