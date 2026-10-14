import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { loadConfig } from "../src/dcp/config.js";
import { previewCompressionContinuityRepack } from "../src/dcp/compression-blocks.js";
import { buildDcpJournalDelta, createDcpJournalInit, createDcpJournalMirror, DCP_JOURNAL_CUSTOM_TYPE, replayDcpJournal } from "../src/dcp/journal.js";
import { estimateTokens } from "../src/dcp/pruner-metadata.js";
import { rehydrateToolRecordsFromMessages } from "../src/dcp/recovery.js";
import { createState, type CompressionBlock, type CompressionProtectedFragment, type ToolRecord } from "../src/dcp/state.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

describe("DCP observed exact-ledger failure replay", () => {
	test("legacy exact accumulation clears below 16 KiB across five repacks/restarts without losing action facts", () => {
		// Deterministic model of the reported failure, not a copy of private JSONL:
		// inherited small exact outputs outgrow the default ledger budget while
		// the semantic core shrinks. Every output ends in whitespace to exercise
		// the live/restart sourceHash mismatch found during independent review.
		const config = loadConfig({ homeDir: "/__dcp_fact_replay__" });
		expect(config.compress.maxProtectedToolContinuityBytes).toBe(16 * 1024);
		let state = createState();
		const records: ToolRecord[] = [];
		const add = (id: string, toolName: string, inputArgs: Record<string, unknown>, outputText: string, isError = false) => {
			records.push({ toolCallId: id, toolName, inputArgs, outputText, isError, inputFingerprint: id, timestamp: records.length + 1, turnIndex: 0, tokenEstimate: estimateTokens(outputText) });
		};
		for (let index = 0; index < 160; index++) {
			add(`inspect-${index}`, "shell", { command: "git status --short" }, `M src/file-${index}.ts\n${" M src/observed.ts\n".repeat(10)} `);
		}
		for (let index = 0; index < 4; index++) add(`edit-${index}`, "apply_patch", { patch: `*** Update File: src/changed-${index}.ts` }, `Success\nM src/changed-${index}.ts\n`);
		add("remote", "publish", { action: "send" }, "Timeout after submission\noperation_id: paid-42\nlog: .pi/artifacts/replay/request.log\n", true);
		for (const revision of ["old-code", "new-code"]) add(`test-${revision}`, "shell", { command: "bun test", revision }, "bun test v1.3.14\n 25 pass\n 0 fail\nRan 25 tests across 1 file. [7.00ms]\n");
		for (const record of records) state.toolCalls.set(record.toolCallId, record);
		const fragments: CompressionProtectedFragment[] = records.map((record) => ({
			kind: "tool", origin: `tool:${record.toolCallId}`, text: `### Tool: ${record.toolName}\n${record.outputText}`,
			hash: hash(`### Tool: ${record.toolName}\n${record.outputText}`), sourceHash: hash(record.outputText!),
			sourceBytes: Buffer.byteLength(record.outputText!), representation: "exact", policyVersion: 2,
		}));
		const pin = "<protect>Keep this user decision exact.\n  including whitespace.</protect>";
		fragments.push({ kind: "prompt", origin: "prompt:user:0", text: pin, hash: hash(pin) });
		const baselineBytes = fragments.reduce((sum, fragment) => sum + Buffer.byteLength(fragment.text), 0);
		expect(baselineBytes).toBeGreaterThan(24_000);
		const core = "Active objective: finish DCP policy. Next step: verify new changes.";
		const legacy: CompressionBlock = {
			id: 1, topic: "Observed exact-ledger accumulation", summary: core,
			startTimestamp: 1, endTimestamp: records.length, anchorTimestamp: records.length + 1,
			startMessageId: "id:user", endMessageId: "id:user", anchorMessageId: "id:next-user",
			active: true, createdAt: 1, version: 2, replacementMode: "range",
			sourceMembers: [{ stableId: "id:user", hash: hash("source") }],
			mutationMembers: [{ stableId: "id:user", hash: hash("source") }],
			summaryTokenEstimate: estimateTokens(core) + estimateTokens(fragments.map((fragment) => fragment.text).join("\n")),
			protectedFragments: fragments,
		};
		state.compressionBlocks.push(legacy);
		state.nextBlockId = 2;
		const original = JSON.stringify(legacy);
		const rawMessages = records.flatMap((record) => [
			{ role: "assistant", timestamp: record.timestamp, content: [{ type: "toolCall", id: record.toolCallId, name: record.toolName, input: record.inputArgs }] },
			{ role: "toolResult", timestamp: record.timestamp, toolCallId: record.toolCallId, toolName: record.toolName, isError: record.isError,
				content: [{ type: "text", text: record.outputText!.slice(0, 7) }, { type: "text", text: record.outputText!.slice(7) }] },
		]);
		let lastLedger: string | undefined;
		for (let cycle = 0; cycle < 5; cycle++) {
			// Serialize/replay actual journal operations, then rehydrate exact raw
			// tool records. No provider-seen evidence may be invented by restart.
			const init = createDcpJournalInit(`replay-init-${cycle}`, cycle);
			const delta = buildDcpJournalDelta(state, createDcpJournalMirror(createState(), init.operationId), `replay-delta-${cycle}`, cycle)!;
			const entries = [init, delta].map((data) => ({ type: "custom", customType: DCP_JOURNAL_CUSTOM_TYPE, data }));
			state = createState();
			replayDcpJournal(JSON.parse(JSON.stringify(entries)), state);
			rehydrateToolRecordsFromMessages(rawMessages, state);
			expect(state.providerSeenToolIds.size).toBe(0);
			const previous = state.compressionBlocks.at(-1)!;
			const before = JSON.stringify(previous);
			const preview = previewCompressionContinuityRepack(previous, state, config);
			expect(JSON.stringify(previous)).toBe(before);
			expect(preview.summaryCore).toBe(core);
			const ledger = preview.protectedFragments.map((fragment) => fragment.text).join("\n");
			expect(Buffer.byteLength(ledger)).toBeLessThan(16 * 1024);
			expect(ledger).not.toContain("tool:inspect-");
			for (const fact of [pin, "paid-42", "effect UNKNOWN", ".pi/artifacts/replay/request.log", "old-code", "new-code", "Not current verification"]) expect(ledger).toContain(fact);
			for (let index = 0; index < 4; index++) expect(ledger).toContain(`src/changed-${index}.ts`);
			if (lastLedger !== undefined) expect(ledger).toBe(lastLedger);
			lastLedger = ledger;
			const replacement = { ...previous, id: state.nextBlockId++, summary: preview.summaryCore, summaryTokenEstimate: preview.estimatedTokens,
				protectedFragments: preview.protectedFragments, active: true };
			previous.active = false;
			state.compressionBlocks.push(replacement);
		}
		expect(JSON.stringify(legacy)).toBe(original);
	});
});
