import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { LEDGER_STANCES } from "./ledger.mjs";
import { CouncilError } from "./storage.mjs";

export const PROMPTS_PATH = fileURLToPath(new URL("../../prompts.md", import.meta.url));
const SHARED_KEYS = ["boundaries", "spawn-task", "send-message", "brief", "continue", "round-header", "later-rounds", "ledger", "audit-rules", "peers", "gap", "draft"];
export const REQUIRED_TEMPLATE_KEYS = [...SHARED_KEYS, ...["brainstorm", "audit"].flatMap((mode) => [1, 2, 3, 4, 5].map((round) => `${mode}-${round}`))];

/** Parse `## key` / `## key — title` sections; text before the first section is documentation. */
export function parseTemplates(text) {
	const sections = new Map();
	let current;
	for (const line of text.split(/\r?\n/)) {
		const heading = /^## ([a-z0-9-]+)(?:\s+—\s+(.+))?\s*$/.exec(line);
		if (heading) {
			if (sections.has(heading[1])) throw new CouncilError(`Duplicate prompt template: ${heading[1]}`);
			current = { title: heading[2]?.trim(), lines: [] };
			sections.set(heading[1], current);
			continue;
		}
		current?.lines.push(line);
	}
	const templates = {};
	for (const [key, { title, lines }] of sections) templates[key] = { title, body: lines.join("\n").trim() };
	for (const key of REQUIRED_TEMPLATE_KEYS) {
		if (!templates[key]?.body) throw new CouncilError(`prompts.md is missing template "${key}"`);
		if (/^(brainstorm|audit)-\d$/.test(key) && !templates[key].title) throw new CouncilError(`prompts.md round template "${key}" needs a "— title"`);
	}
	return templates;
}

export async function loadTemplates(file = PROMPTS_PATH) {
	return parseTemplates(await readFile(file, "utf8"));
}

/** Single-pass substitution: inserted values are never rescanned. */
export function render(template, vars) {
	return template.replace(/\{\{([a-zA-Z]+)\}\}/g, (_match, name) => {
		if (!Object.prototype.hasOwnProperty.call(vars, name)) throw new CouncilError(`Unknown prompt placeholder {{${name}}}`);
		return String(vars[name]);
	});
}

export function roundName(templates, mode, round) {
	return templates[`${mode}-${round}`].title;
}

export function quoted(text) {
	return `<<<UNTRUSTED PARTICIPANT CONTENT>>>\n${text}\n<<<END UNTRUSTED PARTICIPANT CONTENT>>>`;
}

/**
 * Round prompt for one participant. Round 1 carries the brief; later rounds
 * only the newly completed peer round (never current-round siblings), because
 * own answers and older turns are already in the persistent session.
 */
export function roundPrompt(templates, input) {
	const { mode, round, slot, model } = input;
	const t = (key, vars = {}) => render(templates[key].body, vars);
	const parts = [];
	parts.push(round === 1
		? t("brief", { mode, topic: JSON.stringify(input.topic), brief: quoted(input.brief) })
		: t("continue"));
	parts.push(t("round-header", { round, roundName: roundName(templates, mode, round), slot, model, instructions: templates[`${mode}-${round}`].body }));
	if (mode === "audit") parts.push(t("audit-rules"));
	if (round > 1) parts.push(t("later-rounds"));
	if (round < 5) parts.push(t("ledger", { stances: LEDGER_STANCES.join("/"), slot }));
	if (round > 1) {
		const items = [
			...(input.peers ?? []).map((peer) => `${peer.id} (${peer.model}):\n${quoted(peer.text)}`),
			...(input.gaps ?? []).map((gap) => t("gap", gap)),
		];
		if (items.length) parts.push(t("peers", { round: round - 1, peers: items.join("\n\n") }));
	}
	if (input.draft !== undefined) parts.push(t("draft", { draft: quoted(input.draft) }));
	return `${parts.join("\n\n")}\n`;
}

export function boundaries(templates, slot, model) {
	return render(templates.boundaries.body, { slot, model });
}
