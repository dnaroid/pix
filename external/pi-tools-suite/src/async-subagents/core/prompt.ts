import { PROJECT_ARTIFACTS_DIR } from "../../artifact-paths.js";
import type { AgentTask } from "./types.js";

export function generatePrompt(task: AgentTask): string {
	const parentObjective = task.parentObjective || "current user task";
	const scopeLine = task.scope ? `- Relevant files/areas: ${task.scope}\n` : "";
	const imagePaths = task.imagePaths && task.imagePaths.length > 0 ? task.imagePaths.join(", ") : "";
	const imageLine = imagePaths ? `- Attached image files: ${imagePaths}\n` : "";
	const focusLine = task.focus ? `\nVisual focus / attention instructions:\n${task.focus}\n` : "";

	const basePrompt = task.promptOverride ? renderPromptTemplate(task.promptOverride, task) : `You are a pi sub-agent launched by a parent agent.

Parent objective:
${parentObjective}

Your focused task:
${task.task}
${focusLine}

Scope and constraints:
- Work in the current repository only.
- Do not spawn other agents or background jobs unless explicitly allowed.
${scopeLine}${imageLine}- Follow the parent task's constraints and repository instructions.
- Keep output compact by default.
- Stay within the assigned scope and preserve unrelated work. Do not re-plan the project.
- Report concrete blockers and gathered evidence rather than widening the task or escalating models yourself.
- Keep disposable logs, scratch reports, mockups and captures in unique task/run directories under the current project's ${PROJECT_ARTIFACTS_DIR}/; never use project-root artifacts/ or .artifacts/ for scratch output. ${PROJECT_ARTIFACTS_DIR}/ is temporary storage and may be cleaned up at any time; save durable deliverables elsewhere and export evidence that must be retained. Harness-owned sub-agent/QA workspaces live in ${PROJECT_ARTIFACTS_DIR}/subagents/; explicit release/build paths and user-requested deliverable paths are exceptions. Return only decision-relevant evidence and artifact paths to the parent.
- If the task explicitly asks for verbatim/raw file contents, command output, logs, or exact text, output only that content exactly and do not summarize it.
- If requested raw content is very large, include the requested relevant portion and clearly say what was omitted.

Output format:
- If the task explicitly requests a raw/verbatim/exact output format, follow that request instead and do not add the standard summary sections below.
- Otherwise use:
  1. Result: answer or completion status, briefly.
  2. Evidence: relevant file:line references, changed files, check results and artifact paths.
  3. Limits: blockers, unverified assumptions, risks or necessary next action; omit when empty.
- Do not repeat the task or paste full logs/diffs unless requested. Preserve required QA artifact links.
`;

	return task.promptAppend
		? `${basePrompt.trimEnd()}\n\nAdditional instructions from sub-agent profile:\n${renderPromptTemplate(task.promptAppend, task).trimEnd()}\n`
		: basePrompt;
}

function renderPromptTemplate(template: string, task: AgentTask): string {
	const values: Record<string, string> = {
		id: task.id,
		task: task.task,
		scope: task.scope ?? "",
		parentObjective: task.parentObjective || "current user task",
		subagentType: task.subagentType ?? "",
		model: task.model ?? "",
		thinking: task.thinking ?? "",
		focus: task.focus ?? "",
		imagePaths: task.imagePaths?.join(", ") ?? "",
	};
	return template.replace(/\{(id|task|scope|parentObjective|subagentType|model|thinking|focus|imagePaths)\}/g, (_match, key: string) => values[key] ?? "");
}
