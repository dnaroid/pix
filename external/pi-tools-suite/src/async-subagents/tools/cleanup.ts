import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";
import { ASYNC_SUBAGENT_TOOL_DESCRIPTIONS } from "../../tool-descriptions.js";
import { deleteCleanupCandidates, findCleanupCandidates, getRunRoot, removeSubagentRunsFromRegistry, resolveRunDir } from "../lib.js";

export function registerCleanupTool(pi: ExtensionAPI): void {
	pi.registerTool({
		...ASYNC_SUBAGENT_TOOL_DESCRIPTIONS.cleanupAction,
		parameters: Type.Object({
			runRoot: Type.Optional(Type.String({ description: "Root directory (default: .pi/subagents)" })),
			days: Type.Optional(Type.Number({ description: "Remove runs older than N days (default 7)", default: 7 })),
			keep: Type.Optional(Type.Number({ description: "Always keep newest N runs (default 20)", default: 20 })),
			delete: Type.Optional(Type.Boolean({ description: "Actually delete (default: dry-run)", default: false })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const expectedRoot = getRunRoot(ctx.cwd);
			const runRoot = params.runRoot
				? resolveRunDir(ctx.cwd, params.runRoot)
				: expectedRoot;

			let canonicalExpected: string;
			try {
				fs.mkdirSync(expectedRoot, { recursive: true });
				canonicalExpected = fs.realpathSync(expectedRoot);
			} catch {
				return {
					content: [{ type: "text", text: `Could not create or resolve run root: ${expectedRoot}` }],
					details: {},
					isError: true,
				};
			}

			let canonicalRunRoot: string;
			try {
				canonicalRunRoot = fs.realpathSync(runRoot);
			} catch {
				return {
					content: [{ type: "text", text: `Run root does not exist: ${runRoot}` }],
					details: {},
				};
			}

			if (!canonicalRunRoot.startsWith(canonicalExpected + path.sep) && canonicalRunRoot !== canonicalExpected) {
				return {
					content: [{ type: "text", text: `Refusing to delete outside ${canonicalExpected}. Got: ${canonicalRunRoot}` }],
					details: {},
					isError: true,
				};
			}

			const days = params.days ?? 7;
			const keep = params.keep ?? 20;
			const doDelete = params.delete ?? false;

			const candidates = findCleanupCandidates(runRoot, days, keep);

			if (candidates.length === 0) {
				return {
					content: [{ type: "text", text: `No cleanup candidates in ${runRoot} (days>${days}, keep newest ${keep}).` }],
					details: { candidates, deleted: false },
				};
			}

			if (!doDelete) {
				return {
					content: [
						{
							type: "text",
							text: [
								`Dry run. Would delete ${candidates.length} completed run(s):`,
								...candidates.map((c) => `  ${c}`),
								"",
								"Pass delete=true to actually remove.",
							].join("\n"),
						},
					],
					details: { candidates, deleted: false },
				};
			}


			deleteCleanupCandidates(candidates);
			removeSubagentRunsFromRegistry(ctx.cwd, candidates);

			return {
				content: [
					{
						type: "text",
						text: `Deleted ${candidates.length} completed run(s):\n${candidates.map((c) => `  ${c}`).join("\n")}`,
					},
				],
				details: { candidates, deleted: true },
			};
		},
	});
}
