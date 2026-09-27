import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/dcp/config.js";
import { estimateTokens } from "../src/dcp/pruner-metadata.js";
import { previewCompressionContinuityRepack } from "../src/dcp/compression-blocks.js";
import { createState, type CompressionBlock, type ToolRecord } from "../src/dcp/state.js";

function record(
	id: string,
	toolName: string,
	outputText: string,
	inputArgs: Record<string, unknown>,
	outputDetails?: unknown,
): ToolRecord {
	return {
		toolCallId: id,
		toolName,
		inputArgs,
		inputFingerprint: `${toolName}::${id}`,
		isError: false,
		turnIndex: 0,
		timestamp: 1,
		tokenEstimate: estimateTokens(outputText),
		outputText,
		outputDetails,
	};
}

describe("DCP protected continuity marathon", () => {
	test("b193-shaped legacy ledger repacks into one bounded continuation instead of becoming immortal context", () => {
		const config = loadConfig({ homeDir: "/__dcp_continuity_marathon__" });
		config.compress.maxProtectedToolContinuityBytes = 64 * 1024;
		const state = createState();
		const fragments: NonNullable<CompressionBlock["protectedFragments"]> = [];

		for (let index = 0; index < 195; index++) {
			const id = `shell-${index}`;
			const output = index % 9 === 0
				? `custom runner output ${index}\n${"diagnostic detail\n".repeat(260)}`
				: `short shell result ${index}\n${"ok\n".repeat(20)}`;
			state.toolCalls.set(id, record(id, "shell", output, { command: `node custom-runner-${index}.mjs` }));
			const text = `### Tool: shell\n${output.trim()}`;
			fragments.push({ kind: "tool", origin: `tool:${id}`, hash: index.toString(16).padStart(64, "0"), text });
		}
		for (let index = 0; index < 101; index++) {
			const id = `patch-${index}`;
			const output = `Success. Updated the following files:\nsrc/file-${index}.ts\n${"LSP diagnostic detail\n".repeat(140)}`;
			state.toolCalls.set(id, record(
				id,
				"apply_patch",
				output,
				{ patch: `*** Update File: src/file-${index}.ts` },
				{ changedFiles: [`src/file-${index}.ts`], summary: `Updated src/file-${index}.ts` },
			));
			const text = `### Tool: apply_patch\n${output.trim()}`;
			fragments.push({ kind: "tool", origin: `tool:${id}`, hash: (index + 500).toString(16).padStart(64, "0"), text });
		}

		const ledgerText = fragments.map((fragment) => `\n\n${fragment.text}`).join("");
		const semanticCore = [
			"Completed implementation and verification work.",
			"Active objective: continue from the verified repository state.",
			"Next step: inspect only new failures or requested follow-up changes.",
		].join("\n");
		const legacySummary = semanticCore +
			"\n\nThe following protected continuity fragments were preserved verbatim:" + ledgerText;
		const block: CompressionBlock = {
			id: 193,
			topic: "Long coding marathon",
			summary: legacySummary,
			startTimestamp: 1,
			endTimestamp: 2,
			anchorTimestamp: 3,
			active: true,
			summaryTokenEstimate: estimateTokens(legacySummary),
			createdAt: 1,
			version: 2,
			replacementMode: "range",
			protectedFragments: fragments,
		};

		const preview = previewCompressionContinuityRepack(block, state, config);
		const projectedToolBytes = preview.protectedFragments
			.filter((fragment) => fragment.kind === "tool")
			.reduce((sum, fragment) => sum + Buffer.byteLength(fragment.text, "utf8"), 0);
		const baselineToolBytes = fragments.reduce((sum, fragment) => sum + Buffer.byteLength(fragment.text, "utf8"), 0);

		expect(fragments).toHaveLength(296);
		expect(baselineToolBytes).toBeGreaterThan(200_000);
		expect(preview.summaryCore).toBe(semanticCore);
		expect(projectedToolBytes).toBeLessThanOrEqual(64 * 1024);
		expect(preview.protectedFragments.length).toBeLessThanOrEqual(fragments.length);
		expect(preview.estimatedTokens).toBeLessThan(block.summaryTokenEstimate / 2);
		expect(preview.estimatedGainTokens).toBeGreaterThan(20_000);
	});
});
