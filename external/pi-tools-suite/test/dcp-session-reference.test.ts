import { describe, expect, test } from "bun:test";
import { budgetProtectedToolFragments } from "../src/dcp/continuity-ledger.js";
import { continuityHash, expandContinuityReference, resolveContinuitySource } from "../src/dcp/continuity-reference.js";
import { previewCompressionContinuityRepack } from "../src/dcp/compression-blocks.js";
import { DEFAULT_DCP_CONFIG } from "../src/dcp/defaults.js";
import { buildDcpJournalDelta, createDcpJournalInit, createDcpJournalMirror, DCP_JOURNAL_CUSTOM_TYPE, replayDcpJournal } from "../src/dcp/journal.js";
import { toolRecordContinuity } from "../src/dcp/protected-continuity.js";
import { rehydrateToolRecordsFromMessages } from "../src/dcp/recovery.js";
import { createInputFingerprint, createState, type CompressionBlock, type CompressionProtectedFragment, type ToolRecord } from "../src/dcp/state.js";
import { createRecoveryHandlers } from "../src/session-recovery/index.js";
import type { DcpConfig } from "../src/dcp/config.js";
import { registerCompressTool } from "../src/dcp/compress-tool.js";
import { applyPruning } from "../src/dcp/pruner.js";

const config = (): DcpConfig => structuredClone(DEFAULT_DCP_CONFIG);
const hash = continuityHash;
function fixture() {
	const state = createState();
	const messages: any[] = [];
	const fragments: CompressionProtectedFragment[] = [];
	for (let index = 0; index < 180; index++) {
		const remote = index === 179;
		const record: ToolRecord = {
			toolCallId: `action-${index}`, toolName: remote ? "publish" : "apply_patch",
			inputArgs: remote ? { action: "send" } : { patch: `*** Update File: src/changed-${index}.ts` },
			inputFingerprint: "fixture", timestamp: index + 1, turnIndex: 0, tokenEstimate: 100,
			outputText: remote ? 'Timeout after send\noperation_id: payment-42\nlog: .pi/artifacts/remote.log\n' : `Success. Updated src/changed-${index}.ts\nsrc/changed-${index}.ts:1 error: ${"diagnostic ".repeat(20)}\n`,
			isError: remote, outputDetails: remote ? { requestId: "request-42", status: "pending" } : undefined,
		};
		state.toolCalls.set(record.toolCallId, record);
		messages.push({ role: "assistant", timestamp: record.timestamp, content: [{ type: "toolCall", id: record.toolCallId, name: record.toolName, arguments: record.inputArgs }] },
			{ role: "toolResult", timestamp: record.timestamp, toolCallId: record.toolCallId, toolName: record.toolName, isError: record.isError, details: record.outputDetails, content: [{ type: "text", text: record.outputText }] });
		const decision = toolRecordContinuity(record, config());
		fragments.push({ kind: "tool", origin: `tool:${record.toolCallId}`, hash: hash(decision.text!), text: decision.text!, representation: "receipt", policyVersion: 3, minimumText: decision.minimumText, sourceHash: decision.sourceHash, sourceBytes: decision.sourceBytes });
	}
	return { state, messages, fragments };
}

function block(id: number, fragments: CompressionProtectedFragment[]): CompressionBlock {
	return { id, topic: "Dense actions", summary: "Active objective: verify DCP. Next: recover remote outcome before retry.",
		startTimestamp: 1, endTimestamp: 400, anchorTimestamp: 401, active: true, createdAt: 1,
		version: 2, replacementMode: "range", startMessageId: "u1", endMessageId: "a1", anchorMessageId: "a1",
		sourceMembers: [{ stableId: "id:u1", hash: hash("source") }], mutationMembers: [{ stableId: "id:u1", hash: hash("source") }],
		protectedFragments: fragments, continuityFormatVersion: 2, summaryTokenEstimate: 200 };
}

function journalEntries(state: ReturnType<typeof createState>, messages: any[] = []): any[] {
	const init = createDcpJournalInit("reference-init", 1);
	const delta = buildDcpJournalDelta(state, createDcpJournalMirror(createState(), init.operationId), "reference-delta", 2)!;
	const entries: any[] = messages.map((message, index) => ({ id: `raw-${index}`, type: "message", message }));
	entries.push(...[init, delta].map((data, index) => ({ id: `journal-${index}`, type: "custom", customType: DCP_JOURNAL_CUSTOM_TYPE, data })));
	for (let index = 0; index < entries.length; index++) entries[index].parentId = index ? entries[index - 1].id : null;
	return JSON.parse(JSON.stringify(entries));
}

function context(entries: any[], sessionId = "session-reference") {
	return { sessionManager: { getSessionId: () => sessionId, getLeafId: () => entries.at(-1)?.id,
		getBranch: () => entries, getEntries: () => entries } };
}

describe("session-backed continuity", () => {
	test("public compress path commits recoverable references and leaves live state untouched on persistence failure", async () => {
		const { state, messages } = fixture();
		const cfg = config(); cfg.debug = false;
		const history = [{ id: "request", role: "user", timestamp: 0, content: "Investigate actions." },
			...messages.map((message, index) => ({ ...message, id: `raw-${index}` })),
			{ id: "current", role: "user", timestamp: 1_000, content: "Continue safely." }];
		applyPruning(history, state, cfg);
		let tool: any;
		let failPublication = true;
		registerCompressTool({ registerTool(value: any) { tool = value; }, appendEntry() {} } as any, state, cfg, {
			persistState: async (_ctx, _state, publication) => {
				publication?.beforePublish?.();
				if (failPublication) throw new Error("fixture publication failure");
				publication?.onPublished?.();
			},
		});
		const visibleId = (id: string) => [...state.messageMetaSnapshot].find(([, meta]) => meta.stableId === `id:${id}`)![0];
		const args = { topic: "Dense actions", ranges: [{ startId: visibleId("request"), endId: visibleId("raw-359"), summary: "Investigated actions. Next: recover payment outcome before retry." }] };
		const ctx = { sessionManager: {}, ui: { notify() {} } };
		await expect(tool.execute("failed-reference", args, undefined, undefined, ctx)).rejects.toThrow("publication failure");
		expect(state.compressionBlocks).toHaveLength(0);
		expect(state.nextBlockId).toBe(1);
		failPublication = false;
		const result = await tool.execute("commit-reference", args, undefined, undefined, ctx);
		expect(result.details.netGain).toBeGreaterThan(1_000);
		const reference = state.compressionBlocks[0]!.protectedFragments!.find((item) => item.representation === "reference")!;
		expect(reference.text).toContain('entry_id="dcp:b1"');
		expect(reference.continuitySources).toHaveLength(180);
		const projected = JSON.stringify(applyPruning(history, state, cfg));
		expect(projected).not.toContain("diagnostic diagnostic");
		expect(projected).toContain("UNKNOWN");
		const recovered = await createRecoveryHandlers().read("recover", { entry_id: "dcp:b1", max_body_chars: 8_000 }, undefined, undefined, context(journalEntries(state, messages)));
		expect(recovered).not.toHaveProperty("isError", true);
		expect(JSON.parse(recovered.content[0].text).recordCount).toBe(180);
	});

	test("dense >64 KiB facts stay bounded across five restart/roll-up cycles and recover all actions", () => {
		let { state, messages, fragments } = fixture();
		expect(Buffer.byteLength(fragments.map((item) => item.minimumText).join("\n"))).toBeGreaterThan(64_000);
		const pin = "<protect>  exact user decision\n</protect>";
		fragments.push({ kind: "prompt", origin: "prompt:u1:0", text: pin, hash: hash(pin) });
		for (let cycle = 0; cycle < 5; cycle++) {
			const before = JSON.stringify(state.compressionBlocks);
			const bounded = budgetProtectedToolFragments(fragments, state, config());
			expect(JSON.stringify(state.compressionBlocks)).toBe(before);
			expect(Buffer.byteLength(bounded.map((item) => item.text).join("\n"))).toBeLessThan(2_000);
			expect(bounded.some((item) => item.text === pin)).toBe(true);
			const reference = bounded.find((item) => item.representation === "reference")!;
			expect(reference.continuitySources).toHaveLength(180);
			expect(JSON.stringify(reference.continuitySources)).not.toContain("diagnostic");
			const recovered = expandContinuityReference(reference, state, config()).map((item) => item.text).join("\n");
			for (let index = 0; index < 179; index++) expect(recovered).toContain(`src/changed-${index}.ts`);
			for (const fact of ["payment-42", "request-42", "pending", "UNKNOWN", ".pi/artifacts/remote.log"]) expect(recovered).toContain(fact);
			const current = block(state.nextBlockId++, bounded);
			state.compressionBlocks.push(current);
			const entries = journalEntries(state, messages);
			state = createState();
			replayDcpJournal(entries, state);
			rehydrateToolRecordsFromMessages(messages, state);
			const old = state.compressionBlocks.at(-1)!;
			const oldBytes = JSON.stringify(old);
			const preview = previewCompressionContinuityRepack(old, state, config());
			expect(JSON.stringify(old)).toBe(oldBytes);
			fragments = preview.protectedFragments;
		}
	});

	test("bounded session read paginates through real raw entries, rejects missing sources, forks and stale cursors", async () => {
		const { state, messages, fragments } = fixture();
		const bounded = budgetProtectedToolFragments(fragments, state, config());
		state.compressionBlocks.push(block(state.nextBlockId++, bounded));
		const entries = journalEntries(state, messages);
		const read = createRecoveryHandlers().read;
		const ctx = context(entries);
		let result = await read("r", { entry_id: "dcp:b1", max_body_chars: 8_000 }, undefined, undefined, ctx);
		expect(result).not.toHaveProperty("isError", true);
		const first = JSON.parse(result.content[0].text);
		expect(first.recordCount).toBe(180);
		expect(first.nextCursor).toStartWith("dcp:");
		let text = first.text;
		let next = first.nextCursor;
		let pages = 1;
		while (next && pages < 100) {
			result = await read("r", { cursor: next, max_body_chars: 8_000 }, undefined, undefined, ctx);
			const payload = JSON.parse(result.content[0].text);
			expect(payload.text.length).toBeLessThanOrEqual(8_000);
			text += payload.text;
			next = payload.nextCursor;
			pages++;
		}
		expect(next).toBeUndefined();
		expect(text).toContain("payment-42");
		expect(text).toContain('entry_id="raw-359"');
		const foreign = await read("r", { cursor: first.nextCursor }, undefined, undefined, context(entries, "other-session"));
		expect(foreign).toHaveProperty("isError", true);
		const fork = await read("r", { entry_id: "dcp:b1" }, undefined, undefined, context(entries.filter((entry) => entry.type === "message")));
		expect(fork).toHaveProperty("isError", true);
		entries[1].message.content[0].text = "changed bytes";
		const changed = await read("r", { cursor: first.nextCursor }, undefined, undefined, ctx);
		expect(changed).toHaveProperty("isError", true);
		expect(changed.content[0].text).toContain("UNKNOWN");
	});

	test("source proof covers inputs/outcome/details and explicit pins cannot be replaced", () => {
		const { state, fragments } = fixture();
		const reference = budgetProtectedToolFragments(fragments, state, config())[0]!;
		const source = reference.continuitySources![0]!;
		const record = state.toolCalls.get("action-0")!;
		record.inputArgs = { patch: "*** Update File: WRONG.ts" };
		expect(() => resolveContinuitySource(source, state, config())).toThrow("unavailable or changed");
		const pinned = config(); pinned.compress.protectedTools = ["apply_patch"];
		const exact = fragments.map((item) => ({ ...item, representation: "exact" as const }));
		expect(() => budgetProtectedToolFragments(exact, state, pinned)).toThrow("safety floor");
		expect(createInputFingerprint("continuity", {})).toStartWith("continuity::sha256:");
	});

	test("existing immutable journal receipts can be referenced without raw records; corrupt references fail closed", () => {
		const { state, fragments } = fixture();
		state.toolCalls.clear();
		state.compressionBlocks.push(block(state.nextBlockId++, fragments));
		const bounded = budgetProtectedToolFragments(fragments, state, config());
		expect(bounded[0]!.continuitySources![0]!.kind).toBe("block");
		state.compressionBlocks.push(block(state.nextBlockId++, bounded));
		const entries = journalEntries(state);
		const restored = createState(); replayDcpJournal(entries, restored);
		expect(expandContinuityReference(bounded[0]!, restored, config())).toHaveLength(180);
		const delta = entries.at(-1).data;
		delta.blocks[1].protectedFragments[0].continuitySources[0].blockId = 2;
		expect(() => replayDcpJournal(entries, createState())).toThrow();
	});
});
