/**
 * Parsing of Explain model answers. A well-formed `{ "summary", "notes" }`
 * object (or a bare notes array), optionally fenced or wrapped in prose, is
 * parsed strictly; anything else is salvaged field by field. Notes are
 * clamped to `[firstLine, lastLine]`, merged per line and capped.
 */
export interface FileAnnotation {
	/** 1-based source line the note is shown above. */
	readonly line: number;
	readonly text: string;
}

export interface NoteBounds {
	readonly firstLine: number;
	readonly lastLine: number;
	readonly maxNotes: number;
}
const MAX_NOTE_CHARS = 600;
const MAX_SUMMARY_CHARS = 1_500;

/**
 * Reads the model answer. A well-formed `{ "summary", "notes" }` object (or a
 * bare notes array), optionally fenced or wrapped in prose, is parsed
 * strictly. Otherwise — typically an answer cut off at the token limit, raw
 * newlines inside strings or a stray comma — fields are salvaged one by one,
 * so every complete note and the summary survive.
 */
export function parseFileExplanation(output: string, bounds: NoteBounds): { summary: string; annotations: FileAnnotation[] } {
	const strict = parseStrict(output, bounds);
	if (strict?.summary) return strict;
	const salvaged = salvageFileExplanation(output, bounds);
	// A complete notes array next to a broken object still loses no summary.
	if (strict && strict.annotations.length > 0) return { summary: salvaged.summary, annotations: strict.annotations };
	return salvaged;
}

function parseStrict(output: string, bounds: NoteBounds): { summary: string; annotations: FileAnnotation[] } | undefined {
	const start = output.indexOf("{");
	const end = output.lastIndexOf("}");
	const arrayStart = output.indexOf("[");
	if (start >= 0 && end > start && (arrayStart < 0 || start < arrayStart)) {
		try {
			const parsed = JSON.parse(output.slice(start, end + 1)) as unknown;
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				const record = parsed as Record<string, unknown>;
				const notes = Array.isArray(record.notes) ? record.notes : Array.isArray(record.annotations) ? record.annotations : [];
				return { summary: cleanSummary(typeof record.summary === "string" ? record.summary : ""), annotations: normalizeNotes(notes, bounds) };
			}
		} catch {
			// Not strict JSON; try a bare array, then salvage.
		}
	}
	const annotations = parseFileAnnotations(output, bounds);
	return annotations.length > 0 ? { summary: "", annotations } : undefined;
}

const JSON_STRING = String.raw`"((?:[^"\\]|\\.)*)"`;
const SUMMARY_FIELD = new RegExp(String.raw`"summary"\s*:\s*` + JSON_STRING, "u");
const SUMMARY_CUT_OFF = /"summary"\s*:\s*"((?:[^"\\]|\\.)*)$/u;

/**
 * Field-by-field recovery for malformed or truncated JSON answers, with no
 * guessing about field order: a scanner that understands JSON strings (so
 * braces and quotes inside note text are ignored) collects every object that
 * actually closed, repairs raw newlines and trailing commas inside it and
 * keeps those with a `line` and a `text`/`note`. An object cut off by the
 * token limit never closes and is dropped. The summary is read from its own
 * field, even when the answer stops inside it.
 */
export function salvageFileExplanation(output: string, bounds: NoteBounds): { summary: string; annotations: FileAnnotation[] } {
	const summaryMatch = SUMMARY_FIELD.exec(output) ?? SUMMARY_CUT_OFF.exec(output);
	const summary = cleanSummary(summaryMatch ? decodeJsonString(summaryMatch[1]!) : "");
	const notes: unknown[] = [];
	for (const object of closedJsonObjects(output)) {
		try {
			const parsed = JSON.parse(object) as unknown;
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && "line" in parsed) notes.push(parsed);
		} catch {
			// A malformed note is skipped; the others still count.
		}
	}
	return { summary, annotations: normalizeNotes(notes, bounds) };
}

/** Innermost-first source of every `{…}` that closes, with raw control characters in strings escaped and trailing commas removed. */
function closedJsonObjects(text: string): string[] {
	const objects: string[] = [];
	const starts: number[] = [];
	let sanitized = "";
	let inString = false;
	let escaped = false;
	for (const char of text) {
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === "\"") inString = false;
			else if (char === "\n") { sanitized += "\\n"; continue; }
			else if (char === "\r") continue;
			else if (char === "\t") { sanitized += "\\t"; continue; }
			sanitized += char;
			continue;
		}
		if (char === "\"") inString = true;
		else if (char === "{") starts.push(sanitized.length);
		else if (char === "}" && starts.length > 0) {
			const start = starts.pop()!;
			objects.push((sanitized.slice(start) + char).replace(/,(\s*[}\]])/gu, "$1"));
		}
		sanitized += char;
	}
	return objects;
}

function decodeJsonString(raw: string): string {
	try {
		return JSON.parse(`"${raw.replace(/\r?\n/gu, "\\n").replace(/\t/gu, "\\t")}"`) as string;
	} catch {
		return raw.replace(/\\n/gu, "\n").replace(/\\(["\\/])/gu, "$1");
	}
}

function cleanSummary(summary: string): string {
	return summary.replace(/[ \t]+/gu, " ").replace(/\n{3,}/gu, "\n\n").trim().slice(0, MAX_SUMMARY_CHARS);
}

/**
 * Accepts a JSON array (optionally fenced or surrounded by prose) of
 * `{ line, text }` objects.
 */
export function parseFileAnnotations(output: string, bounds: NoteBounds): FileAnnotation[] {
	const start = output.indexOf("[");
	const end = output.lastIndexOf("]");
	if (start < 0 || end <= start) return [];
	try {
		const parsed = JSON.parse(output.slice(start, end + 1)) as unknown;
		return Array.isArray(parsed) ? normalizeNotes(parsed, bounds) : [];
	} catch {
		return [];
	}
}

/** Drops invalid items, clamps to known lines and merges notes that target the same line. */
function normalizeNotes(items: readonly unknown[], bounds: NoteBounds): FileAnnotation[] {
	const byLine = new Map<number, string[]>();
	for (const item of items) {
		if (typeof item !== "object" || item === null) continue;
		const record = item as Record<string, unknown>;
		const line = typeof record.line === "number" ? record.line : typeof record.line === "string" ? Number(record.line) : Number.NaN;
		const note = typeof record.text === "string" ? record.text : typeof record.note === "string" ? record.note : "";
		const cleaned = note.replace(/\s+/gu, " ").trim().slice(0, MAX_NOTE_CHARS);
		if (!Number.isInteger(line) || line < bounds.firstLine || line > bounds.lastLine || !cleaned) continue;
		byLine.set(line, [...(byLine.get(line) ?? []), cleaned]);
	}
	return [...byLine.entries()]
		.sort(([left], [right]) => left - right)
		.slice(0, bounds.maxNotes)
		.map(([line, notes]) => ({ line, text: notes.join(" ") }));
}
