import { afterEach, expect, test } from "bun:test";
import { access, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertRunnableConfig, defaultBrainstormConfig, mergeBrainstormConfig, normalizeOutputDir, resolvedQuorum, thinkingForModel } from "../../src/brainstorm/config.js";
import { finalizeBrainstormRun, reviewBrainstorm } from "../../src/brainstorm/continuation.js";
import { extractLedger, parseLedgerRows, renderPositionMatrix, scriptWarnings } from "../../src/brainstorm/ledger.js";
import { runBrainstorm, type RunRound } from "../../src/brainstorm/workflow.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function temp(): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "brainstorm-v4-"));
	dirs.push(dir);
	return dir;
}

const brief = "Goal: durable storage. Constraints: bounded cost. Non-goals: implementation. Success: testable options.";
const config = { models: ["one/a", "two/b", "three/c"], thinking: "high", timeoutSeconds: 30 };
const ledgerText = (round: number, slot: number, body = "") => `${body}Round ${round} body from P${slot}\n\n## Ledger\n\n| ID | Stance | Refs | Note |\n| --- | --- | --- | --- |\n| P${slot}-H1 | ${round === 1 ? "new" : "keep"} | - | idea ${slot} r${round} |\n`;
const goodRound: RunRound = async ({ round, tasks }) => tasks.map(({ id, model }, i) => ({ id, model, text: ledgerText(round, i + 1) }));

test("a declared missing participant is a recorded coverage gap while the quorum holds", async () => {
	const cwd = await temp();
	const runner: RunRound = async (input) => {
		const third = input.tasks[2]!;
		return { responses: (await goodRound(input) as any[]).slice(0, 2), missing: [{ id: third.id, model: third.model, reason: "participant failed" }] };
	};
	const result = await runBrainstorm({ cwd, topic: "quorum", brief, config, runRound: runner });
	expect(result.status).toBe("awaiting_synthesis");
	const manifest = JSON.parse(await readFile(path.join(result.runDir, "manifest.json"), "utf8"));
	expect(manifest.missing["1"]).toEqual([{ id: "round-1-participant-3", model: "three/c", reason: "participant failed" }]);
	expect(manifest.rounds["1"]).toHaveLength(2);
	expect(await readFile(result.discussionPath, "utf8")).toContain("> Missing (coverage gap): participant failed");
	// The stored gap is honoured by continuation instead of failing validation.
	const reviewed = await reviewBrainstorm({ cwd, runDir: result.runDir, proposal: "# Draft", runRound: goodRound });
	expect(reviewed.status).toBe("awaiting_finalization");
});

test("losing more participants than the quorum allows makes the run incomplete", async () => {
	const cwd = await temp();
	const runner: RunRound = async ({ tasks }) => ({
		responses: [{ id: tasks[0]!.id, model: tasks[0]!.model, text: "only one" }],
		missing: tasks.slice(1).map(({ id, model }) => ({ id, model, reason: "timed out" })),
	});
	const result = await runBrainstorm({ cwd, topic: "quorum", brief, config, runRound: runner });
	expect(result.status).toBe("incomplete");
	const manifest = JSON.parse(await readFile(path.join(result.runDir, "manifest.json"), "utf8"));
	expect(manifest.error).toContain("quorum not met");
	// An explicit quorum equal to the roster requires everyone.
	const strict = await runBrainstorm({ cwd, topic: "strict", brief, config: { ...config, quorum: 3 }, runRound: async (input) => ({
		responses: (await goodRound(input) as any[]).slice(0, 2), missing: [{ id: input.tasks[2]!.id, model: input.tasks[2]!.model, reason: "failed" }],
	}) });
	expect(strict.status).toBe("incomplete");
});

test("later rounds see the previous round in full, older rounds as ledgers, and own earlier answers in round 4", async () => {
	const cwd = await temp();
	const calls: Parameters<RunRound>[0][] = [];
	const runner: RunRound = async (input) => {
		calls.push(input);
		return input.tasks.map(({ id, model }, i) => ({ id, model, text: ledgerText(input.round, i + 1, `SECRET-BODY-R${input.round}-P${i + 1}\n`) }));
	};
	const result = await runBrainstorm({ cwd, topic: "history", brief, config, runRound: runner });
	expect(result.status).toBe("awaiting_synthesis");
	const round3 = calls[2]!.tasks[0]!.task;
	expect(round3).toContain("SECRET-BODY-R2-P2");
	expect(round3).not.toContain("SECRET-BODY-R1-P2");
	expect(round3).toContain("[ledger only]");
	expect(round3).toContain("| P2-H1 | new |");
	const round4 = calls[3]!.tasks[0]!.task;
	expect(round4).toContain("SECRET-BODY-R1-P1");
	expect(round4).not.toContain("SECRET-BODY-R1-P2");
	expect(round4).toContain("SECRET-BODY-R3-P2");
	for (const call of calls) for (const task of call.tasks) expect(task.task).toContain("## Ledger");
	const discussion = await readFile(result.discussionPath, "utf8");
	expect(discussion).toContain("## Position matrix");
	expect(discussion).toContain("| P1-H1 | new |");
	// Full texts stay out of the manifest and live in integrity-checked files.
	const manifest = JSON.parse(await readFile(path.join(result.runDir, "manifest.json"), "utf8"));
	expect(JSON.stringify(manifest)).not.toContain("SECRET-BODY");
	expect(await readFile(path.join(result.runDir, manifest.rounds["2"][1].file), "utf8")).toContain("SECRET-BODY-R2-P2");
});

test("a response file edited after recording blocks continuation", async () => {
	const cwd = await temp();
	const result = await runBrainstorm({ cwd, topic: "tamper", brief, config, runRound: goodRound });
	await writeFile(path.join(result.runDir, "rounds", "round-2-participant-1.md"), "forged");
	await expect(reviewBrainstorm({ cwd, runDir: result.runDir, proposal: "# Draft", runRound: async () => { throw new Error("must not launch"); } })).rejects.toThrow("changed after it was recorded");
	await expect(access(path.join(result.runDir, "draft-proposal.md"))).rejects.toThrow();
});

test("ledger parsing is bounded and tolerant of missing ledgers", () => {
	const text = "intro\n## Ledger\n| ID | Stance | Refs | Note |\n|---|---|---|---|\n| `P1-H1` | KEEP | P2-H3 | a \\| b |\n## After\nignored";
	expect(extractLedger(text)).toEqual({ found: true, text: "## Ledger\n| ID | Stance | Refs | Note |\n|---|---|---|---|\n| `P1-H1` | KEEP | P2-H3 | a \\| b |" });
	expect(parseLedgerRows(text)).toEqual([{ id: "P1-H1", stance: "keep", refs: "P2-H3", note: "a \\ | b" }]);
	const noLedger = extractLedger("x".repeat(2_000));
	expect(noLedger.found).toBe(false);
	expect(noLedger.text).toContain("no ledger supplied");
	expect(parseLedgerRows("no table")).toEqual([]);
	expect(renderPositionMatrix([{ round: 1, responses: [{ slot: 1, text: "no ledger" }] }])).toBe("");
	const matrix = renderPositionMatrix([{ round: 1, responses: [{ slot: 1, text }, { slot: 2, text: "none" }] }]);
	expect(matrix).toContain("| ID | R1·P1 | R1·P2 | Latest note |");
	expect(matrix).toContain("| P1-H1 | keep |  |");
});

test("stray foreign-script tokens are advisory warnings, never rejections", async () => {
	expect(scriptWarnings("Русский бриф", "ответ 中文")).toEqual(["2 Han/Kana character(s) absent from the brief's script"]);
	expect(scriptWarnings("бриф 中文", "ответ 中文")).toEqual([]);
	const cwd = await temp();
	const result = await runBrainstorm({ cwd, topic: "script", brief, config, runRound: async (input) => input.tasks.map(({ id, model }) => ({ id, model, text: "answer with 漢" })) });
	expect(result.status).toBe("awaiting_synthesis");
	const manifest = JSON.parse(await readFile(path.join(result.runDir, "manifest.json"), "utf8"));
	expect(manifest.rounds["1"][0].warnings).toEqual(["1 Han/Kana character(s) absent from the brief's script"]);
	expect(await readFile(result.discussionPath, "utf8")).toContain("⚠ Script check");
});

test("per-model thinking overrides apply to exact refs and bare model ids", async () => {
	const overrides = { thinking: "high", thinkingOverrides: { "two/b": "max", "other-provider/c": "low" } };
	expect(thinkingForModel(overrides, "one/a")).toBe("high");
	expect(thinkingForModel(overrides, "two/b")).toBe("max");
	expect(thinkingForModel(overrides, "three/c")).toBe("low");
	const cwd = await temp();
	const calls: Parameters<RunRound>[0][] = [];
	const result = await runBrainstorm({ cwd, topic: "thinking", brief, config: { ...config, ...overrides }, runRound: async (input) => { calls.push(input); return goodRound(input); } });
	expect(calls[0]!.tasks.map((task) => task.thinking)).toEqual(["high", "max", "low"]);
	expect(await readFile(path.join(result.runDir, "brief.md"), "utf8")).toContain("Thinking: one/a: high, two/b: max, three/c: low");
});

test("outputDir is confined to the project and continuation honours it", async () => {
	for (const bad of ["../x", "/abs", ".", "..", "", "a/../../b"]) expect(() => normalizeOutputDir(bad)).toThrow();
	expect(normalizeOutputDir("notes\\councils/")).toBe("notes/councils");
	const cwd = await temp();
	const result = await runBrainstorm({ cwd, topic: "custom", brief, config: { ...config, outputDir: "notes/councils" }, runRound: goodRound });
	expect(path.dirname(result.runDir)).toBe(path.join(await realpath(cwd), "notes/councils"));
	await expect(access(path.join(cwd, ".pi"))).rejects.toThrow();
	await expect(reviewBrainstorm({ cwd, runDir: result.runDir, proposal: "# Draft", runRound: goodRound })).rejects.toThrow("direct child");
	const reviewed = await reviewBrainstorm({ cwd, runDir: result.runDir, proposal: "# Draft", runRound: goodRound, outputDir: "notes/councils" });
	expect(reviewed.status).toBe("awaiting_finalization");
});

test("publish copies only the final proposal into docs/brainstorms; default finalize leaves docs untouched", async () => {
	const cwd = await temp();
	const quiet = await runBrainstorm({ cwd, topic: "quiet", brief, config, runRound: goodRound });
	await reviewBrainstorm({ cwd, runDir: quiet.runDir, proposal: "# Draft", runRound: goodRound });
	expect(await finalizeBrainstormRun(cwd, quiet.runDir, "# Final quiet", "none")).toEqual({ proposalPath: quiet.proposalPath });
	await expect(access(path.join(cwd, "docs"))).rejects.toThrow();

	const loud = await runBrainstorm({ cwd, topic: "loud", brief, config, runRound: goodRound });
	await reviewBrainstorm({ cwd, runDir: loud.runDir, proposal: "# Draft", runRound: goodRound });
	const { publishedPath } = await finalizeBrainstormRun(cwd, loud.runDir, "# Final loud\n\n", "none", { publish: true });
	expect(publishedPath).toBe(path.join(await realpath(cwd), "docs/brainstorms", `${path.basename(loud.runDir)}.md`));
	const published = await readFile(publishedPath!, "utf8");
	expect(published).toStartWith(`# Final loud\n\n---\n\nCouncil protocol (local, not published): \`${path.join(".pi", "brainstorms")}${path.sep}`);
	expect(published).not.toContain("Round 1 body");
	const manifest = JSON.parse(await readFile(path.join(loud.runDir, "manifest.json"), "utf8"));
	expect(manifest).toMatchObject({ status: "complete", publishedPath });
	expect(await readdir(path.join(cwd, "docs/brainstorms"))).toEqual([path.basename(publishedPath!)]);
});

test("legacy docs/brainstorms runs still continue, and publishing there points at the proposal itself", async () => {
	const cwd = await temp();
	const result = await runBrainstorm({ cwd, topic: "legacy root", brief, config: { ...config, outputDir: "docs/brainstorms" }, runRound: goodRound });
	await reviewBrainstorm({ cwd, runDir: result.runDir, proposal: "# Draft", runRound: goodRound });
	const { publishedPath } = await finalizeBrainstormRun(cwd, result.runDir, "# Final", "none", { publish: true });
	expect(publishedPath).toBe(result.proposalPath);
});

test("roster derivation, quorum defaults and runnable validation", () => {
	const frontier = [{ model: "x/one" }, { model: "y/two", enabled: false }, { model: "z/three" }] as any;
	const derived = mergeBrainstormConfig(defaultBrainstormConfig(), { models: null }, frontier);
	expect(derived).toMatchObject({ models: ["x/one", "z/three"], modelsExplicit: false });
	// A later frontier change re-derives a non-explicit roster but never an explicit one.
	expect(mergeBrainstormConfig(derived, {}, [{ model: "q/a" }, { model: "q/b" }, { model: "q/c" }] as any).models).toEqual(["q/a", "q/b", "q/c"]);
	const explicit = mergeBrainstormConfig(defaultBrainstormConfig(), { models: ["e/a", "e/b"] });
	expect(mergeBrainstormConfig(explicit, {}, frontier).models).toEqual(["e/a", "e/b"]);
	expect(resolvedQuorum({ models: ["a/1", "b/2"] })).toBe(2);
	expect(resolvedQuorum({ models: ["a/1", "b/2", "c/3", "d/4"] })).toBe(3);
	for (const quorum of [1, 7, 2.5, "2"]) expect(() => mergeBrainstormConfig(explicit, { quorum })).toThrow("quorum");
	expect(() => assertRunnableConfig(mergeBrainstormConfig(explicit, { quorum: 3 }))).toThrow("cannot exceed");
	expect(() => assertRunnableConfig(mergeBrainstormConfig(defaultBrainstormConfig(), { models: null }, [{ model: "only/one" }] as any))).toThrow("at least 2 models");
	expect(() => mergeBrainstormConfig(explicit, { thinkingOverrides: { "a/b": "huge" } })).toThrow("thinkingOverrides");
	expect(mergeBrainstormConfig(explicit, { thinkingOverrides: { "zai/glm-5.3": null, "a/b": "low" } }).thinkingOverrides).toEqual({ "a/b": "low" });
	expect(mergeBrainstormConfig(explicit, { thinkingOverrides: null }).thinkingOverrides).toEqual({});
});
