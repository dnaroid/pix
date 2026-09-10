import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import { appendLspDiagnosticsToMutationResult } from "../../src/lib/lsp.js";
import { getEventPaths } from "../../src/lsp/mutation-events.js";
import { applyPatch } from "../../src/model-tools/apply-patch.js";
import { classifyContextGatewayTool, observeToolResult } from "../../src/context-gateway/telemetry.js";
import { STORELESS_CAPABILITIES, storelessCapability } from "../../src/context-gateway/storeless-capabilities.js";

function tempDir(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

describe("P01-R storeless format contracts", () => {
	test("publishes one explicit storeless capability decision per measured/non-supported surface", () => {
		expect(new Set(STORELESS_CAPABILITIES.map((entry) => entry.surface)).size).toBe(STORELESS_CAPABILITIES.length);
		expect(storelessCapability("mutation-lsp")).toMatchObject({ status: "supported", strategy: "native-passthrough", lifetime: "current-result" });
		expect(storelessCapability("test-build")).toMatchObject({ status: "limited", strategy: "pure-parser-compact" });
		expect(storelessCapability("web-document")).toMatchObject({ status: "limited", strategy: "raw-session-recoverable-compact", lifetime: "raw-session" });
		expect(storelessCapability("structured-json")).toMatchObject({ status: "limited", strategy: "native-passthrough" });
		expect(storelessCapability("subagent-result")).toMatchObject({ status: "limited", lifetime: "producer-managed" });
		expect(storelessCapability("visual")).toMatchObject({ status: "supported", lifetime: "visual-message" });
		expect(storelessCapability("browser-direct")).toMatchObject({ status: "unsupported", strategy: "none", lifetime: "none" });
		expect(storelessCapability("mcp-direct")).toMatchObject({ status: "unsupported", strategy: "none", lifetime: "none" });
	});

	test("mutation provenance prefers exact changedFiles details over broader input paths", () => {
		const input = {
			file_path: "src/input-fallback.ts",
			paths: ["src/other-input.ts"],
			input: [
				"*** Begin Patch",
				"*** Update File: src/from-patch-text.ts",
				"@@",
				"-old",
				"+new",
				"*** End Patch",
			].join("\n"),
		};
		const details = { changedFiles: ["src/actual-a.ts", " src/actual-a.ts ", "src/actual-b.ts", ""] };
		expect(getEventPaths(input, details)).toEqual(["src/actual-a.ts", "src/actual-b.ts"]);
	});

	test("actual apply_patch result reports only files from that invocation, not unrelated dirty workspace files", async () => {
		const root = tempDir("p01r-mutation-provenance-");
		try {
			writeFileSync(path.join(root, "target.ts"), "export const value = 1;\n", "utf8");
			writeFileSync(path.join(root, "unrelated-dirty.ts"), "export const unrelated = 'dirty';\n", "utf8");
			const input = [
				"*** Begin Patch",
				"*** Update File: target.ts",
				"@@",
				"-export const value = 1;",
				"+export const value = 2;",
				"*** End Patch",
			].join("\n");
			const inputBefore = input;
			const result = await applyPatch(root, input);

			expect(result.changedFiles).toEqual(["target.ts"]);
			expect(result.summary).toContain("target.ts");
			expect(result.summary).not.toContain("unrelated-dirty.ts");
			expect(readFileSync(path.join(root, "target.ts"), "utf8")).toContain("value = 2");
			expect(readFileSync(path.join(root, "unrelated-dirty.ts"), "utf8")).toContain("unrelated = 'dirty'");
			expect(input).toBe(inputBefore);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("LSP enrichment is a no-op for errored/cancelled mutation results and preserves the original outcome object", async () => {
		const result = {
			content: [{ type: "text" as const, text: "Operation aborted" }],
			details: { changedFiles: ["src/a.ts"], partial: true },
		};
		const enriched = await appendLspDiagnosticsToMutationResult({
			toolName: "apply_patch",
			input: { input: "PRIVATE_PRE_APPROVAL_PATCH_TEXT" },
			result,
			ctx: { cwd: "/definitely/not/read", signal: undefined } as any,
			isError: true,
		});

		expect(enriched).toBe(result);
		expect(enriched.content).toEqual([{ type: "text", text: "Operation aborted" }]);
		expect(enriched.details).toEqual({ changedFiles: ["src/a.ts"], partial: true });
		expect(JSON.stringify(enriched)).not.toContain("PRIVATE_PRE_APPROVAL_PATCH_TEXT");
	});

	test("web/document result observation is passive and does not reinterpret or fetch its source", () => {
		const event = {
			toolCallId: "web-1",
			toolName: "web_fetch",
			content: [{ type: "text", text: "Title: Example\n\nContent:\n# Heading\n`code`\nNo extra fetch." }],
			details: {
				title: "Example",
				content: "# Heading\n`code`\nNo extra fetch.",
				contentBytes: 34,
				links: ["https://example.test/a"],
				linkCount: 1,
				truncated: false,
			},
			isError: false,
		};
		const before = structuredClone(event);
		const observation = observeToolResult(event, 8_192);

		expect(observation.toolClass).toBe("web");
		expect(observation.delivery.representation).toBe("passthrough");
		expect(observation.source.completeness).toBe("unknown");
		expect(event).toEqual(before);
		// There is deliberately no web/document parser or fetch callback in
		// observeToolResult: R-E inventories this path as native passthrough.
		expect(observation).not.toHaveProperty("testOutput");
	});

	test("structured JSON-like output remains opaque text so large integers are not parsed or rounded", () => {
		const exact = "{\"id\":9007199254740993123456789,\"status\":\"partial\"}";
		const event = {
			toolCallId: "json-1",
			toolName: "custom_structured_json",
			content: [{ type: "text", text: exact }],
			details: { upstreamPagination: { next: "opaque-cursor" } },
			isError: false,
		};
		const observation = observeToolResult(event, 8_192);
		expect(observation.toolClass).toBe("other");
		expect(observation.delivery.representation).toBe("passthrough");
		expect(event.content[0].text).toBe(exact);
		expect(event.content[0].text).toContain("9007199254740993123456789");
	});

	test("subagent result paths stay their producer's artifacts and are not promoted to Gateway grants", () => {
		expect(classifyContextGatewayTool("async_subagents_result")).toBe("subagent");
		const event = {
			toolCallId: "subagent-1",
			toolName: "async_subagents_result",
			content: [{ type: "text", text: "Status: done\nSummary: compact\nFull result: .pi/subagents/run/a/result.md" }],
			details: {
				state: { status: "done" },
				artifacts: { resultMd: ".pi/subagents/run/a/result.md", resultJson: ".pi/subagents/run/a/result.json" },
			},
			isError: false,
		};
		const before = structuredClone(event);
		const observation = observeToolResult(event, 8_192);
		expect(observation.toolClass).toBe("subagent");
		expect(observation.delivery.representation).toBe("passthrough");
		expect(event).toEqual(before);
		expect(JSON.stringify(observation)).not.toContain("result.md");
	});

	test("image parts remain visual passthrough and are accounted separately from text", () => {
		const event = {
			toolCallId: "visual-1",
			toolName: "custom_visual",
			content: [
				{ type: "text", text: "Screenshot attached" },
				{ type: "image", data: "QUJDRA==", mimeType: "image/png" },
			],
			details: { viewport: { width: 10, height: 10 } },
			isError: false,
		};
		const before = structuredClone(event);
		const observation = observeToolResult(event, 8_192);
		expect(observation.delivery.representation).toBe("passthrough");
		expect(observation.source.textBytes).toBe(new TextEncoder().encode("Screenshot attached").byteLength);
		expect(observation.source.imageBytes).toBe(6);
		expect(event).toEqual(before);
	});
});

