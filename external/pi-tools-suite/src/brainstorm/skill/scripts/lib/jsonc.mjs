// Minimal dependency-free JSONC reader: comments and trailing commas, string-aware.

function stripComments(text) {
	let out = "";
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];
		if (inString) {
			out += ch;
			if (ch === "\\") { out += next ?? ""; i++; }
			else if (ch === "\"") inString = false;
			continue;
		}
		if (ch === "\"") { inString = true; out += ch; continue; }
		if (ch === "/" && next === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			out += "\n";
			continue;
		}
		if (ch === "/" && next === "*") {
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
			i++;
			out += " ";
			continue;
		}
		out += ch;
	}
	return out;
}

function stripTrailingCommas(text) {
	let out = "";
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			out += ch;
			if (ch === "\\") { out += text[i + 1] ?? ""; i++; }
			else if (ch === "\"") inString = false;
			continue;
		}
		if (ch === "\"") { inString = true; out += ch; continue; }
		if (ch === ",") {
			let j = i + 1;
			while (j < text.length && /\s/.test(text[j])) j++;
			if (text[j] === "}" || text[j] === "]") continue;
		}
		out += ch;
	}
	return out;
}

export function parseJsonc(text) {
	return JSON.parse(stripTrailingCommas(stripComments(text.replace(/^\uFEFF/, ""))));
}
