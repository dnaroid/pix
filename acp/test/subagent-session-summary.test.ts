import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applySummaryLine, readSubagentSessionSummary } from "../src/acp/subagent-session-summary.js";

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

test("summary tracks model, thinking and last valid assistant usage", () => {
	let summary = applySummaryLine({}, JSON.stringify({ type: "model_change", provider: "openai", modelId: "gpt" }));
	summary = applySummaryLine(summary, JSON.stringify({ type: "thinking_level_change", thinkingLevel: "high" }));
	summary = applySummaryLine(summary, JSON.stringify({
		type: "message", message: { role: "assistant", provider: "openai", model: "gpt", usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0 } },
	}));
	assert.deepEqual(summary, { provider: "openai", modelId: "gpt", thinking: "high", contextTokens: 115 });
	summary = applySummaryLine(summary, JSON.stringify({
		type: "message", message: { role: "assistant", stopReason: "aborted", usage: { totalTokens: 9 } },
	}));
	assert.equal(summary.contextTokens, 115);
	summary = applySummaryLine(summary, JSON.stringify({ type: "compaction" }));
	assert.equal(summary.contextTokens, null);
	assert.equal(applySummaryLine(summary, "{broken"), summary);
});

test("incremental read ignores partial trailing lines and rescans shrunk files", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pix-subagent-summary-"));
	try {
		const file = join(dir, "s.jsonl");
		await writeFile(file, line({ type: "model_change", provider: "a", modelId: "m1" }) + '{"type":"thinking_level_change"');
		assert.deepEqual(await readSubagentSessionSummary(file), { provider: "a", modelId: "m1" });
		await appendFile(file, `,"thinkingLevel":"low"}\n` + line({
			type: "message", message: { role: "assistant", provider: "a", model: "m2", usage: { totalTokens: 42 } },
		}));
		assert.deepEqual(await readSubagentSessionSummary(file), { provider: "a", modelId: "m2", thinking: "low", contextTokens: 42 });
		await writeFile(file, line({ type: "model_change", provider: "b", modelId: "x" }));
		assert.deepEqual(await readSubagentSessionSummary(file), { provider: "b", modelId: "x" });
		assert.deepEqual(await readSubagentSessionSummary(join(dir, "missing.jsonl")), {});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
