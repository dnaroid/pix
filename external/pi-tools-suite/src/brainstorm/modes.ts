import { parseRunModels } from "./config.js";

export type BrainstormMode = "brainstorm" | "audit";

export const COUNCIL_USAGE = "Usage: /brainstorm [--mode auto|brainstorm|audit] [--models provider/model:effort,provider/model:effort] <topic and constraints>";

export function assertMode(value: unknown): asserts value is BrainstormMode {
	if (value !== "brainstorm" && value !== "audit") throw new Error("Run mode must be brainstorm or audit; resolve auto routing before paid work.");
}

/** Only leading options are syntax; the remaining topic is opaque user data. */
export function parseCouncilCommand(args: string): { mode: BrainstormMode | "auto"; topic: string; models?: string[] } {
	let text = args.trim();
	let mode: BrainstormMode | "auto" = "auto";
	let models: string[] | undefined;
	const seen = new Set<string>();
	while (text.startsWith("--")) {
		const option = /^--(mode|models)(?:=|\s+)(\S+)(?:\s+|$)/.exec(text);
		if (!option) throw new Error(COUNCIL_USAGE);
		const [, name, value] = option;
		if (seen.has(name!)) throw new Error(`Specify --${name} only once, before the topic.`);
		seen.add(name!);
		if (name === "mode") {
			if (value !== "auto" && value !== "brainstorm" && value !== "audit") throw new Error(COUNCIL_USAGE);
			mode = value;
		} else {
			models = value!.split(",");
			parseRunModels(models);
		}
		text = text.slice(option[0].length).trim();
	}
	return { mode, topic: text, ...(models ? { models } : {}) };
}
