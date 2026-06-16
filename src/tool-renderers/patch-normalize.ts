/**
 * Normalize OpenAI-style `*** Begin Patch` hunks for display.
 *
 * Problem: in the `Begin Patch` format the model often emits a hunk that
 * reproduces a whole block of a file with the old version as `-` lines and the
 * new version as `+` lines, even when most of those lines are identical. This is
 * the "contextless / loose hunk matching" behavior. A patch that effectively
 * only adds one line can therefore look like it deletes several existing rules.
 *
 * The naive per-line renderer (`diffLineStyle`) faithfully colors every `-` red
 * and every `+` green, which misleads the user.
 *
 * Fix: for each `*** Update File:` hunk we reconstruct the old side
 * (context + `-` lines) and the new side (context + `+` lines), compute a
 * minimal LCS line diff between them, and re-emit the hunk so that:
 *   - lines present in both sides become plain context (no `-`),
 *   - truly removed lines stay `-`,
 *   - truly added lines stay `+`.
 *
 * This is a display-only transformation. Well-formed minimal hunks (and any
 * non-`Begin Patch` unified diffs) are left untouched.
 */

const MAX_NORMALIZE_LINES = 4000;

type DiffOp = "equal" | "delete" | "insert";

type HunkLine = {
	type: "context" | "del" | "add";
	text: string;
};

type PatchSection =
	| { kind: "marker"; line: string }
	| { kind: "hunk-header"; line: string }
	| { kind: "hunk-body"; lines: HunkLine[] }
	| { kind: "raw"; line: string };

/** Re-emit a `*** Begin Patch` string with loose hunks re-minimized. */
export function normalizeBeginPatchForDisplay(patch: string): string {
	if (!patch.includes("*** Begin Patch")) return patch;

	const lines = patch.split("\n");
	if (lines.length > MAX_NORMALIZE_LINES) return patch;

	const sections = parseBeginPatchSections(lines);
	return sections.map(renderSection).filter((line): line is string => line !== null).join("\n");
}

function parseBeginPatchSections(lines: readonly string[]): PatchSection[] {
	const sections: PatchSection[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";

		if (line.startsWith("*** Update File:")) {
			sections.push({ kind: "marker", line });
			i += 1;
			while (i < lines.length) {
				const inner = lines[i] ?? "";
				if (inner.startsWith("*** ")) break;
				if (inner.startsWith("@@")) {
					sections.push({ kind: "hunk-header", line: inner });
					i += 1;
					const body: HunkLine[] = [];
					while (i < lines.length) {
						const bodyLine = lines[i] ?? "";
						if (bodyLine.startsWith("@@") || bodyLine.startsWith("*** ")) break;
						body.push(parseHunkLine(bodyLine));
						i += 1;
					}
					sections.push({ kind: "hunk-body", lines: body });
				} else {
					sections.push({ kind: "raw", line: inner });
					i += 1;
				}
			}
			continue;
		}

		if (line.startsWith("*** Add File:") || line.startsWith("*** Delete File:") || line.startsWith("*** Begin Patch") || line.startsWith("*** End Patch")) {
			sections.push({ kind: "marker", line });
			i += 1;
			continue;
		}

		// Stray line outside any file section (e.g. a loose @@ without an Update
		// File header). Keep it verbatim to preserve structure.
		sections.push({ kind: "raw", line });
		i += 1;
	}
	return sections;
}

function parseHunkLine(line: string): HunkLine {
	if (line.startsWith("+")) return { type: "add", text: line.slice(1) };
	if (line.startsWith("-")) return { type: "del", text: line.slice(1) };
	if (line.startsWith(" ")) return { type: "context", text: line.slice(1) };
	// Lines without a prefix inside a Begin Patch hunk body are treated as
	// context (the format uses a leading space for context, but loose patches
	// sometimes omit it).
	return { type: "context", text: line };
}

function renderSection(section: PatchSection): string | null {
	switch (section.kind) {
		case "marker":
		case "hunk-header":
		case "raw":
			return section.line;
		case "hunk-body": {
			const oldLines = section.lines.filter((entry) => entry.type !== "add").map((entry) => entry.text);
			const newLines = section.lines.filter((entry) => entry.type !== "del").map((entry) => entry.text);
			const ops = diffLines(oldLines, newLines);
			const rendered: string[] = [];
			for (const op of ops) {
				rendered.push(renderDiffOp(op));
			}
			return rendered.length > 0 ? rendered.join("\n") : null;
		}
	}
}

function renderDiffOp(op: { type: DiffOp; text: string }): string {
	if (op.type === "delete") return `-${op.text}`;
	if (op.type === "insert") return `+${op.text}`;
	// Context marker is a leading space. Loose `-`/`+` blocks carry the space
	// that separated the marker from the content (e.g. `- rule one`), so reuse
	// that space instead of emitting a second one.
	return op.text.startsWith(" ") ? op.text : ` ${op.text}`;
}

/** Minimal LCS-based line diff. */
function diffLines(oldLines: readonly string[], newLines: readonly string[]): Array<{ type: DiffOp; text: string }> {
	const m = oldLines.length;
	const n = newLines.length;
	if (m === 0 && n === 0) return [];

	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
	for (let i = m - 1; i >= 0; i -= 1) {
		for (let j = n - 1; j >= 0; j -= 1) {
			const oldLine = oldLines[i] ?? "";
			const newLine = newLines[j] ?? "";
			dp[i]![j] = oldLine === newLine
				? (dp[i + 1]?.[j + 1] ?? 0) + 1
				: Math.max(dp[i + 1]?.[j] ?? 0, dp[i]?.[j + 1] ?? 0);
		}
	}

	const result: Array<{ type: DiffOp; text: string }> = [];
	let i = 0;
	let j = 0;
	while (i < m && j < n) {
		const oldLine = oldLines[i] ?? "";
		const newLine = newLines[j] ?? "";
		if (oldLine === newLine) {
			result.push({ type: "equal", text: oldLine });
			i += 1;
			j += 1;
		} else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
			result.push({ type: "delete", text: oldLine });
			i += 1;
		} else {
			result.push({ type: "insert", text: newLine });
			j += 1;
		}
	}
	while (i < m) {
		result.push({ type: "delete", text: oldLines[i] ?? "" });
		i += 1;
	}
	while (j < n) {
		result.push({ type: "insert", text: newLines[j] ?? "" });
		j += 1;
	}
	return result;
}
