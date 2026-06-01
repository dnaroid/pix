import * as fs from "node:fs";
import * as path from "node:path";
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
- If the task explicitly asks for verbatim/raw file contents, command output, logs, or exact text, output only that content exactly and do not summarize it.
- If requested raw content is very large, include the requested relevant portion and clearly say what was omitted.

Output format:
- If the task explicitly requests a raw/verbatim/exact output format, follow that request instead and do not add the standard summary sections below.
- Otherwise use:
  1. Summary, max 5 bullets
  2. Evidence / files inspected, paths first
  3. Recommended changes or patch plan
  4. Files changed, if any
  5. Tests/commands run, with short results
  6. Risks / open questions
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

export function writePromptFile(runDir: string, task: AgentTask): string {
	const promptDir = path.join(runDir, "prompts");
	fs.mkdirSync(promptDir, { recursive: true });
	const promptPath = path.join(promptDir, `${task.id}.md`);
	fs.writeFileSync(promptPath, generatePrompt(task), "utf-8");
	return promptPath;
}
