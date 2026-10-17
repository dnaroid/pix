// Compact per-response position ledgers and the discussion position matrix.
// Participants end rounds 1–4 with a `## Ledger` table; the protocol builds a
// matrix of stances from them for the parent synthesis.

export const LEDGER_MAX_CHARS = 4_000;
const FALLBACK_CHARS = 1_500;
export const LEDGER_STANCES = ["new", "keep", "merge", "reject", "open"];

/** Text of the last `Ledger` section, or a bounded excerpt marked as such. */
export function extractLedger(text) {
	const lines = text.split(/\r?\n/);
	let start = -1, level = 0;
	for (let i = 0; i < lines.length; i++) {
		const match = /^(#{1,6})\s+Ledger\b/i.exec(lines[i].trim());
		if (match) { start = i; level = match[1].length; }
	}
	if (start < 0) {
		const excerpt = text.slice(0, FALLBACK_CHARS);
		return { text: `${excerpt}${text.length > FALLBACK_CHARS ? "\n[…no ledger supplied; excerpt truncated…]" : ""}`, found: false };
	}
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		const match = /^(#{1,6})\s/.exec(lines[i].trim());
		if (match && match[1].length <= level) { end = i; break; }
	}
	const body = lines.slice(start, end).join("\n").trim();
	return { text: body.length > LEDGER_MAX_CHARS ? `${body.slice(0, LEDGER_MAX_CHARS)}\n[…ledger truncated…]` : body, found: true };
}

function cells(line) {
	return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim().replace(/^`|`$/g, ""));
}

export function parseLedgerRows(text) {
	const { text: ledger, found } = extractLedger(text);
	if (!found) return [];
	const rows = [];
	for (const line of ledger.split(/\r?\n/)) {
		if (!line.trim().startsWith("|")) continue;
		const [id = "", stance = "", refs = "", ...rest] = cells(line);
		if (!id || /^:?-{2,}:?$/.test(id) || /^id$/i.test(id)) continue;
		rows.push({ id: id.slice(0, 40), stance: stance.toLowerCase().slice(0, 12), refs: refs.slice(0, 80), note: rest.join(" | ").slice(0, 160) });
	}
	return rows;
}

function escapeCell(value) {
	return value.replaceAll("|", "\\|").replace(/\s+/g, " ");
}

/** Rows: option/finding IDs; columns: round × participant slot. */
export function renderPositionMatrix(rounds) {
	const columns = [];
	const stances = new Map();
	const notes = new Map();
	const order = [];
	for (const { round, responses } of rounds) {
		for (const { slot, text } of responses) {
			columns.push({ round, slot });
			for (const row of parseLedgerRows(text)) {
				if (!stances.has(row.id)) { stances.set(row.id, new Map()); order.push(row.id); }
				stances.get(row.id).set(`${round}:${slot}`, row.stance || "?");
				if (row.note) notes.set(row.id, row.note);
			}
		}
	}
	if (order.length === 0) return "";
	const header = `| ID | ${columns.map(({ round, slot }) => `R${round}·P${slot}`).join(" | ")} | Latest note |`;
	const divider = `|${" --- |".repeat(columns.length + 2)}`;
	const body = order.slice(0, 200).map((id) => `| ${escapeCell(id)} | ${columns.map(({ round, slot }) => escapeCell(stances.get(id).get(`${round}:${slot}`) ?? "")).join(" | ")} | ${escapeCell(notes.get(id) ?? "")} |`);
	return `## Position matrix\n\nBuilt from participant ledgers (stances: ${LEDGER_STANCES.join("/")}). Empty cell = not addressed. Verify contested rows against the full responses below.\n\n${[header, divider, ...body].join("\n")}\n`;
}

/** Scripts that signal stray tokens when the brief itself uses none of them. */
const FOREIGN_SCRIPTS = [
	["Han/Kana", /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u],
	["Hangul", /\p{Script=Hangul}/u],
	["Thai", /\p{Script=Thai}/u],
	["Arabic", /\p{Script=Arabic}/u],
	["Devanagari", /\p{Script=Devanagari}/u],
];

/** Advisory only: never rejects a response. */
export function scriptWarnings(brief, text) {
	const warnings = [];
	for (const [name, pattern] of FOREIGN_SCRIPTS) {
		if (pattern.test(text) && !pattern.test(brief)) {
			const count = (text.match(new RegExp(pattern.source, "gu")) ?? []).length;
			warnings.push(`${count} ${name} character(s) absent from the brief's script`);
		}
	}
	return warnings;
}
