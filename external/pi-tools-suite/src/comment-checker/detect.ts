/**
 * Pure-TypeScript comment-slop detector.
 *
 * No external binary, no network, no fs. Given the added/removed lines of a
 * file edit, it finds net-new code comments (present in the added lines but
 * not in the removed lines) that look unnecessary, while leaving genuinely
 * valuable comments (TODO/FIXME, license headers, docstrings, pragmas, linter
 * directives, shebangs, decorators) untouched.
 *
 * The mechanism mirrors oh-my-opencode comment-checker hook (the
 * hasNewCommentsOnly heuristic) but replaces its external binary with an
 * in-process classifier so the suite stays headless and pure-TS.
 *
 * Language-agnostic: recognizes comment markers from many languages:
 *   // /* *   (C/C++/Java/C#/JS/TS/Rust/Go/Swift/Scala/Kotlin, JSDoc continuation)
 *   #          (Python, Ruby, Shell, Perl, YAML, TOML, Makefile, PowerShell, R)
 *   --         (SQL, Lua, Haskell, Ada, Elm)
 *   <!-- -->   (HTML, XML, SVG, Markdown)
 *   triple quotes (Python docstrings)
 *   :          (some config/scripting dialects)
 */

export type Strictness = "conservative" | "balanced" | "aggressive";

export interface CommentFinding {
	filePath: string;
	/** Absolute 1-based line number when resolvable from the written file. */
	line?: number;
	/** Full original comment line. */
	text: string;
	/** Classifier reason: restate-code | filler | decorative | generic-explanation | non-essential-comment. */
	reason: string;
}

/**
 * An extracted edit. removedLines are the lines being replaced (old text),
 * addedLines are the new lines. For full-file writes, removedLines is empty
 * because every comment in the new content is by definition newly added.
 */
export interface Edit {
	filePath: string;
	removedLines: readonly string[];
	addedLines: readonly string[];
	/**
	 * Absolute 1-based line number of the FIRST line in `addedLines` within the
	 * target file, when known. Used to report accurate finding line numbers.
	 * For full-file writes this is 1; for edits/apply_patch it is resolved by
	 * locating the block in the already-written file; when unknown, undefined.
	 */
	baseLineNumber?: number;
}

const MARKER_RE = /^\s*(\/\/+|\/\*+|\*+|#+|--+|<!--|:\s*)/;
const PY_STRING_OPEN_RE = /^\s*("""|''')/;

/**
 * Strip the comment marker and surrounding whitespace from a line.
 * Returns the comment body, or null when the line is not a comment.
 */
export function commentBody(line: string): string | null {
	const pyString = line.match(PY_STRING_OPEN_RE);
	if (pyString) {
		const body = line.slice(pyString[0].length).replace(/("""|''')\s*$/, "").trim();
		return body.length > 0 ? body : null;
	}

	const match = line.match(MARKER_RE);
	if (!match) return null;

	const body = line.slice(match[0].length).replace(/\*\/\s*$/, "").trim();
	return body.length > 0 ? body : null;
}

const VALUABLE_RE: readonly RegExp[] = [
	// Task / review markers with optional context.
	/\b(TODO|FIXME|XXX|HACK|NOTE|WARNING|WARN|BUG|OPTIMIZE|OPTIMISE|REFACTOR|DEPRECATED|SAFETY|SECURITY|PERF|PERFORMANCE|CHANGED|REVIEW|QUESTION|IDEA)\b[:\s()]/i,
	// License / copyright headers.
	/\bspdx-license-identifier\b/i,
	/\b(copyright|\(c\))\b/i,
	/\blicensed under\b/i,
	/\blicense(d)?\b.*\b(MIT|Apache|GPL|LGPL|AGPL|BSD|MPL|ISC|Unlicense)\b/i,
	// Linter / formatter directives.
	/\b(eslint|tslint|biome|prettier|stylelint|jshint|jscs|cspell|spellcheck)\b[-:]/i,
	/@typescript-eslint\//i,
	// Hash-prefixed directives: C/C++ preprocessor, Python/SQL pragmas, tool ignores.
	/^\s*#\s*(include|define|undef|ifdef|ifndef|if|elif|else|endif|error|warning|pragma|import|line|region|endregion|type:\s*ignore|noqa|nosec|pyright|mypy|isort|ruff|flake8|bandit|safety)\b/i,
	// Shebang.
	/^\s*#!/,
	// Decorators and JSDoc/annotation tags.
	/^\s*@/,
	/\b@(param|returns?|throws?|see|example|deprecated|internal|public|private|protected|readonly|override|ts-ignore|ts-expect-error|ts-check|ts-nocheck|abstract|generic|type|template|hidden|alpha|beta|experimental|since|version|author|license|category|remarks)\b/i,
	// File-disable / allow bypass markers.
	/comment-checker-disable-file/i,
	/^\s*@allow\b/i,
	// JSDoc / block docstring openers and rust doc.
	/^\s*(\/\*\*|\/\/!|\/\/\/)/,
	// Editor modelines and schema hints.
	/\bvim:|\bex: set|\bmodeline\b|\bsts=|\bts=\d/i,
	/\$schema\b/i,
	/@type\b/i,
	// Region / folding markers.
	/{#[^}]*#}|^\s*#?(end )?region\b/i,
];

function isValuable(body: string, rawLine: string): boolean {
	if (body.length === 0) return true;
	for (const re of VALUABLE_RE) {
		if (re.test(rawLine) || re.test(body)) return true;
	}
	return false;
}

const SYMBOL_RUN_RE = /[-=*_~#]{3,}/;
const SYMBOLS_ONLY_RE = /^[=\-*_~#|<>.,:;\s]+$/;

function decorativeReason(body: string): "decorative" | null {
	if (body.length < 3) return null;
	if (SYMBOLS_ONLY_RE.test(body) && SYMBOL_RUN_RE.test(body)) return "decorative";
	return null;
}

const FILLER_RE =
	/^(simply|obviously|clearly|just|basically|note that|please note|as you can see|as mentioned|as discussed|as shown|needless to say|of course|it goes without saying|important to note|worth noting|keep in mind|bear in mind|this (is|was|will|should|does|has|had))\b/i;

const RESTATE_RE =
	/^(returns?|creates?|sets?|gets?|fetches?|checks? if|checks? whether|loops? (over|through|around)|iterates? (over|through)|increments?|decrements?|initializes?|initialises?|defines?|declares?|calls?|invokes?|imports?|exports?|logs?|prints?|assigns?|updates?|removes?|adds?|deletes?|handles?|processes?|computes?|calculates?|reads?|writes?|opens?|closes?|starts?|stops?|begins?|ends?|stores?|saves?|loads?|parses?|validates?|verifies?)\b/i;

const GENERIC_RE =
	/^(this (function|method|code|line|block|class|module|file|variable|constant|loop|statement|section|part|snippet|component|hook|handler|guard|helper|util|utility|wrapper|factory)|here we|here i|now we|now let'?s|let'?s|in this|the (above|following|next|previous|code|function|method|loop|block|statement)|with this|using this|first|then|finally|next|after that|step \d|a (helper|utility|wrapper|factory) (that|to|for)|workaround|hack:|note:|caveat:|disclaimer:)/i;

function classifySlop(body: string, strictness: Strictness): string | null {
	const decorative = decorativeReason(body);
	if (decorative) return decorative;

	if (FILLER_RE.test(body)) return "filler";

	if (strictness === "conservative") return null;

	if (RESTATE_RE.test(body)) return "restate-code";

	if (strictness === "balanced") {
		if (GENERIC_RE.test(body)) return "generic-explanation";
		return null;
	}

	// aggressive: any remaining non-valuable comment is flagged.
	return "non-essential-comment";
}

function removedCommentSignatures(removedLines: readonly string[]): Set<string> {
	const set = new Set<string>();
	for (const line of removedLines) {
		const body = commentBody(line);
		if (body !== null) set.add(line.trim());
	}
	return set;
}

/**
 * Detect net-new unnecessary comments across a set of edits.
 * Returns at most maxFindings findings (per file, then overall) to keep the
 * tool-result nudge concise.
 */
export function detectSlopComments(edits: readonly Edit[], strictness: Strictness, maxFindings = 8): CommentFinding[] {
	const findings: CommentFinding[] = [];

	for (const edit of edits) {
		if (!edit.filePath) continue;
		const removed = removedCommentSignatures(edit.removedLines);

		// Track /* ... */ block comments (including /** JSDoc/docstrings) so that
		// interior continuation lines (e.g. ` * Adds two numbers.`) are not
		// individually flagged. Block-comment content is evaluated as a whole;
		// only single-line `/* foo */` inline comments fall through to classification.
		let inBlockComment = false;

		let indexInBlock = 0;
		for (const line of edit.addedLines) {
			if (findings.length >= maxFindings) break;

			const hasOpen = line.includes("/*");
			const hasClose = line.includes("*/");

			if (inBlockComment) {
				if (hasClose) inBlockComment = false;
				indexInBlock++;
				continue;
			}

			if (hasOpen && !hasClose) {
				// Opener of a multi-line block comment / docstring. Skip it and the
				// following continuation lines until the matching `*/`.
				inBlockComment = true;
				indexInBlock++;
				continue;
			}

			const body = commentBody(line);
			const lineOffset = indexInBlock;
			indexInBlock++;
			if (body === null) continue;
			if (removed.has(line.trim())) continue;
			if (isValuable(body, line)) continue;
			const reason = classifySlop(body, strictness);
			if (!reason) continue;

			const absoluteLine = edit.baseLineNumber !== undefined ? edit.baseLineNumber + lineOffset : undefined;
			findings.push({ filePath: edit.filePath, line: absoluteLine, text: line.trim(), reason });
		}

		if (findings.length >= maxFindings) break;
	}

	return findings;
}
