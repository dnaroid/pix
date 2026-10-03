export type BrainstormMode = "brainstorm" | "audit";

export function assertMode(value: unknown): asserts value is BrainstormMode {
	if (value !== "brainstorm" && value !== "audit") throw new Error("Run mode must be brainstorm or audit; resolve auto routing before paid work.");
}

/** Only a leading option is syntax; the remaining topic is opaque user data. */
export function parseCouncilCommand(args: string): { mode: BrainstormMode | "auto"; topic: string } {
	const text = args.trim();
	if (!text.startsWith("--")) return { mode: "auto", topic: text };
	const option = /^--mode(?:=|\s+)(auto|brainstorm|audit)(?:\s+|$)/.exec(text);
	if (!option) throw new Error("Usage: /brainstorm [--mode auto|brainstorm|audit] <topic and constraints>");
	const topic = text.slice(option[0].length).trim();
	if (topic.startsWith("--mode")) throw new Error("Specify --mode only once, before the topic.");
	return { mode: option[1] as BrainstormMode | "auto", topic };
}
