import { REPO_DISCOVERY_TOOLS } from "../../tool-descriptions.js";
import { selectSuitableToolsForModel } from "../../lib/tool-args.js";

export const SUBAGENT_COMMON_TOOLS = ["todo", ...REPO_DISCOVERY_TOOLS.map((tool) => tool.name)];
const commonTools = new Set(SUBAGENT_COMMON_TOOLS);

export const SUBAGENT_OPTIONAL_TOOLS = ["ast_grep", "web_search", "web_fetch"] as const;
export const SUBAGENT_WORK_TOOLS_ENV = "PI_SUBAGENT_WORK_TOOLS";
const optionalTools = new Set<string>(SUBAGENT_OPTIONAL_TOOLS);
const readOnlyTools = new Set(["read", "grep", "find", "ls", "Read", "Grep", "Glob", ...SUBAGENT_COMMON_TOOLS, ...SUBAGENT_OPTIONAL_TOOLS]);

export interface SubagentWorkTools {
	optional: string[];
	readOnlySelection?: string[];
}

/** Extension names are not builtin aliases; keep them in restricted CLI lists. */
export function selectSubagentToolsForModel(model: unknown, tools: readonly string[]): string[] {
	if (tools.some((name) => optionalTools.has(name)) && tools.every((name) => readOnlyTools.has(name))) return [...new Set(tools)];
	return [...new Set(tools.flatMap((name) => optionalTools.has(name) || commonTools.has(name)
		? [name] : selectSuitableToolsForModel(model, [name])))];
}

/** Inspect the final normalized CLI selection, including caller overrides. */
export function subagentWorkTools(args: readonly string[]): SubagentWorkTools {
	const selection = args.indexOf("--tools");
	const exclusion = args.indexOf("--exclude-tools");
	const excluded = new Set(exclusion < 0 ? [] : args[exclusion + 1].split(","));
	const tools = selection < 0 ? [] : args[selection + 1].split(",").filter((name) => !excluded.has(name));
	const optional = tools.filter((name) => optionalTools.has(name));
	return { optional, ...(optional.length && tools.every((name) => readOnlyTools.has(name)) ? { readOnlySelection: tools } : {}) };
}

/** Keep work-tool restrictions, with universal planning and read-only queries. */
export function withSubagentCapabilities(args: readonly string[]): string[] {
	const result: string[] = [];
	let tools: string[] | undefined;
	let excluded: string[] | undefined;
	let noTools = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--no-tools" || arg === "-nt") {
			noTools = true;
		} else if ((arg === "--tools" || arg === "-t") && i + 1 < args.length) {
			tools = args[++i].split(",").map((name) => name.trim()).filter(Boolean);
		} else if ((arg === "--exclude-tools" || arg === "-xt") && i + 1 < args.length) {
			excluded = args[++i].split(",").map((name) => name.trim()).filter((name) => name && !commonTools.has(name));
		} else {
			result.push(arg);
		}
	}
	// Pi treats --no-tools as overriding --tools regardless of their order.
	if (noTools || tools) result.push("--tools", [...new Set([...(noTools ? [] : tools ?? []), ...SUBAGENT_COMMON_TOOLS])].join(","));
	if (excluded?.length) result.push("--exclude-tools", excluded.join(","));
	return result;
}
