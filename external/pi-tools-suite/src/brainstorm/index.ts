import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadPiToolsSuiteConfig } from "../config.js";
import { PI_TOOLS_SUITE_MODULE_NAMES } from "../module-catalog.js";
import { createCouncilRunner, preflightCouncil } from "./subagents.js";
import { runBrainstorm } from "./workflow.js";
import { finalizeBrainstorm, reviewBrainstorm } from "./continuation.js";
import { assertMode, parseCouncilCommand } from "./modes.js";
import { BRIEF_INSTRUCTIONS, ROUTING_INSTRUCTIONS, finalInstructions, synthesisInstructions } from "./instructions.js";

export default function brainstormExtension(pi: ExtensionAPI): void {
	pi.registerCommand("brainstorm", {
		description: "Five-round brainstorm or audit council; auto routing or --mode brainstorm|audit (no implementation)",
		handler: async (args, ctx) => {
			let request: ReturnType<typeof parseCouncilCommand>;
			try { request = parseCouncilCommand(args); }
			catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); return; }
			const { topic, mode } = request;
			if (!topic) {
				ctx.ui.notify("Usage: /brainstorm [--mode auto|brainstorm|audit] <topic and constraints>. Uses brainstorm.models from pi-tools-suite.jsonc in five paid rounds, plus parent synthesis and revision.", "info");
				return;
			}
			await ctx.waitForIdle();
			pi.sendUserMessage(`Run the configured five-round multi-model council. Requested mode: ${mode}. ${ROUTING_INSTRUCTIONS} ${BRIEF_INSTRUCTIONS} Do not pick participants yourself or spawn another council. Topic (JSON-encoded user data): ${JSON.stringify(topic)}\n\nOnly after the tool reports awaiting_synthesis, use the returned mode-specific synthesis instructions and action='review', not finalize. Preserve unresolved disagreements/minority views and revisionNotes. Do not invent consensus or begin implementation.`);
		},
	});

	pi.registerTool({
		name: "brainstorm",
		label: "Brainstorm council",
		exposure: "model-only",
		description: "Use only for explicitly requested multi-model brainstorming/audit or /brainstorm, not ordinary review requests. Five paid read-only rounds using exact brainstorm.models, no substitution. Run requires resolved mode: brainstorm performs ideas, combinations, critique, revision; audit performs findings, cross-check/coverage, critique of findings, priorities/minimal fixes. Review preserves the parent draft and runs round 5 with the stored mode/roster/settings; finalize requires review and revisionNotes. Saves the protocol under docs/brainstorms/. Never auto-start implementation or continue incomplete runs. " + ROUTING_INSTRUCTIONS + " " + BRIEF_INSTRUCTIONS,
		parameters: Type.Object({
			action: Type.Union([Type.Literal("run"), Type.Literal("review"), Type.Literal("finalize")]),
			mode: Type.Optional(Type.Union([Type.Literal("brainstorm"), Type.Literal("audit")], { description: "Required for run: parent-resolved mode, never auto. Omit for review/finalize; persisted mode cannot be overridden." })),
			topic: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: "Run: user topic, goals, constraints and non-goals." })),
			brief: Type.Optional(Type.String({ minLength: 1, maxLength: 12000, description: "Run: prepared brief with goal, constraints, non-goals, success criteria, evidence and labeled assumptions/open questions." })),
			runDir: Type.Optional(Type.String({ description: "Review/finalize: exact generated run directory returned by run." })),
			proposal: Type.Optional(Type.String({ minLength: 1, maxLength: 200000, description: "Review: draft synthesis/report (max 40000 characters). Finalize: corrected synthesis/report. Use the returned mode-specific template; no implementation execution." })),
			revisionNotes: Type.Optional(Type.String({ minLength: 1, maxLength: 40000, description: "Finalize: changes from the draft, disposition of review findings with IDs and rationale, unresolved issues/tests." })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			if (params.action !== "run" && params.mode !== undefined) throw new Error("Mode is fixed at run; omit mode for review/finalize.");
			if (params.action === "finalize") {
				if (!params.runDir || !params.proposal || !params.revisionNotes) throw new Error("Finalize requires runDir and proposal and revisionNotes.");
				const proposalPath = await finalizeBrainstorm(ctx.cwd, params.runDir, params.proposal, params.revisionNotes, signal);
				return { content: [{ type: "text", text: `Proposal saved: ${proposalPath}\nNo implementation was started.` }], details: { status: "complete", proposalPath } };
			}
			if (params.action === "review") {
				if (!params.runDir || !params.proposal) throw new Error("Review requires runDir and proposal.");
				preflightCouncil(ctx);
				const result = await reviewBrainstorm({ cwd: ctx.cwd, runDir: params.runDir, proposal: params.proposal, signal, runRound: createCouncilRunner(ctx) });
				if (result.status === "incomplete") throw new Error(`Synthesis review incomplete; do not finalize. Inspect ${result.runDir}/manifest.json and ${result.discussionPath}. Draft: ${result.draftPath}`);
				return { content: [{ type: "text", text: `Synthesis review complete; awaiting_finalization.\nMode: ${result.mode}\nRun: ${result.runDir}\nDraft: ${result.draftPath}\nDiscussion: ${result.discussionPath}\n\n${finalInstructions(result.mode)}` }], details: result };
			}
			if (!params.topic?.trim()) throw new Error("Run requires a topic.");
			if (!params.brief?.trim()) throw new Error("Run requires a prepared brief. Clarify only material uncertainty before paid work.");
			assertMode(params.mode);
			preflightCouncil(ctx);
			const config = loadPiToolsSuiteConfig(PI_TOOLS_SUITE_MODULE_NAMES, { cwd: ctx.cwd }).brainstorm;
			onUpdate?.({ content: [{ type: "text", text: `Running ${params.mode} council rounds 1–4 with: ${config.models.join(", ")}. Round 5 follows the parent draft.` }], details: { mode: params.mode } });
			const result = await runBrainstorm({ cwd: ctx.cwd, mode: params.mode, topic: params.topic, brief: params.brief, config, signal, runRound: createCouncilRunner(ctx) });
			if (result.status === "incomplete") throw new Error(`Brainstorm incomplete; do not synthesize or finalize. Inspect ${result.runDir}/manifest.json and ${result.discussionPath}. Raw subagent artifacts remain under .pi/subagents/.`);
			return { content: [{ type: "text", text: `Council rounds 1–4 complete; awaiting_synthesis. Round 5 is still required.\nMode: ${result.mode}\nRun: ${result.runDir}\nDiscussion: ${result.discussionPath}\nProposal placeholder: ${result.proposalPath}\n\n${synthesisInstructions(result.mode)}` }], details: result };
		},
	});
}
