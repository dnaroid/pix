import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

function skillName(path: unknown): string | undefined {
	if (typeof path !== "string") return undefined;
	const name = /(?:^|[\\/])([^\\/\x00-\x1f]+)[\\/]SKILL\.md$/i.exec(path.trim())?.[1];
	return name !== "." && name !== ".." ? name : undefined;
}

function parseJson(text: string) {
	try { return JSON.parse(text); } catch { return undefined; }
}

function toolLeaf(name: unknown): string | undefined {
	return typeof name === "string" ? name.toLowerCase().split(/[.:/]/u).at(-1) : undefined;
}

function directRead(name: unknown, args: Record<string, unknown> | undefined): string | undefined {
	const leaf = toolLeaf(name);
	if (leaf === "read") return skillName(args?.path ?? args?.file_path);
	if (leaf !== "bash" && leaf !== "shell" && leaf !== "shell_command") return undefined;
	const command = args?.command ?? args?.cmd ?? args?.script;
	if (typeof command !== "string") return undefined;
	// Recognize explicit reads, not arbitrary mentions or write redirections.
	const reads = command.matchAll(/(?:^|[;&|\n])\s*(?:cat|bat|batcat|less|more|head|tail|sed|awk|grep|rg|ripgrep|nl|wc|file)\s+([^;&|\n]+)/gi);
	for (const [, operands] of reads) {
		if (!operands || /[<>]|(?:^|\s)-i(?:\s|$)/.test(operands)) continue;
		const name = skillName(/(?:^|[\s'"`])([^\s'"`]+[\\/]SKILL\.md)(?=$|[\s'"`])/i.exec(operands)?.[1]);
		if (name) return name;
	}
	return undefined;
}

/** Search the persisted file (all branches), retaining only skill names and pending read IDs. */
export async function scanSessionSkillReads(path: string, signal?: AbortSignal): Promise<string[]> {
	signal?.throwIfAborted();
	const input = createReadStream(path, { encoding: "utf8", signal });
	const lines = createInterface({ input, crlfDelay: Infinity });
	const names = new Set<string>();
	const pending = new Map<string, string>();
	try {
		for await (const line of lines) {
			signal?.throwIfAborted();
			// Skip large irrelevant rows without decoding them to objects.
			const mentionsSkill = /SKILL\.md|<skill name=/i.test(line);
			if (!mentionsSkill && !(pending.size && line.includes('"toolResult"'))) continue;
			const entry = parseJson(line);
			if (entry?.type !== "message") continue;
			const message = entry.message;
			if (message?.role === "assistant" && mentionsSkill && Array.isArray(message.content)) {
				for (const part of message.content) {
					if (part?.type !== "toolCall" || typeof part.id !== "string") continue;
					const name = directRead(part.name, part.arguments);
					if (name) pending.set(part.id, name);
				}
			} else if (message?.role === "toolResult") {
				const name = pending.get(message.toolCallId);
				pending.delete(message.toolCallId);
				if (name && message.isError === false) names.add(name);
				if (mentionsSkill && toolLeaf(message.toolName) === "codemode") {
					const calls = message.nestedCalls?.calls ?? message.details?.calls;
					if (!Array.isArray(calls)) continue;
					for (const call of calls) {
						if (call?.status !== "ok" || toolLeaf(call.name) !== "read") continue;
						const args = call.arguments ?? (typeof call.args === "string" ? parseJson(call.args) : undefined);
						const nestedName = skillName(args?.path ?? args?.file_path);
						if (nestedName) names.add(nestedName);
					}
				}
			} else if (message?.role === "user") {
				const text = typeof message.content === "string" ? message.content : message.content?.[0]?.text;
				if (typeof text !== "string") continue;
				const name = /^<skill name="([^"\r\n]+)" location="[^"\r\n]+">\n/.exec(text)?.[1];
				if (name && text.includes("\n</skill>")) names.add(name);
			}
		}
		signal?.throwIfAborted();
		return [...names];
	} finally {
		lines.close();
		input.destroy();
	}
}
