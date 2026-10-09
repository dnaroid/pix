import type { RepoDiscoveryOutputMode, RepoDiscoveryProfile, RepoIdxCommand } from "./native-compact.js";

export const INSPECT_MODES = ["architecture", "structure", "ast", "explain", "deps"] as const;

export interface InspectRequest {
	command: RepoIdxCommand;
	target?: string;
	args: string[];
	projectPath?: string;
	maxLines?: number;
	maxBytes?: number;
	outputMode?: RepoDiscoveryOutputMode;
}

const text = (description: string) => ({ type: "string", minLength: 1, description });
const integer = (description: string, minimum = 1) => ({ type: "integer", minimum, description });
const flag = (description: string) => ({ type: "boolean", description });
const choice = (values: string[], description: string) => ({ type: "string", enum: values, description });

const OPTIONS = {
	scope: { modes: ["architecture", "structure", "explain"], schema: text("Project-relative directory scope (architecture/structure/explain).") },
	limit: { modes: ["structure", "ast", "explain"], schema: integer("Maximum files (structure, default 20), nodes (ast, 40), or body lines (explain with includeBody, 20).") },
	depth: { modes: ["structure", "ast", "deps"], schema: integer("Traversal depth: structure default 2, ast 3, deps 1.") },
	cursor: { modes: ["structure", "ast"], schema: integer("Continuation cursor returned by structure/ast.", 0) },
	kind: { modes: ["structure"], schema: text("Structure kind filter.") },
	includeInternal: { modes: ["structure"], schema: flag("Include internal symbols in structure.") },
	tests: { modes: ["structure", "deps"], schema: choice(["include", "exclude", "summary"], "Structure test filter; deps accepts only include.") },
	includeBody: { modes: ["explain"], schema: flag("Explain implementation body; otherwise signature only.") },
	relations: { modes: ["deps"], schema: choice(["modules", "module-imports", "calls", "call-graph"], "Dependency view (deps).") },
	direction: { modes: ["deps"], schema: choice(["callers", "callees", "both"], "Dependency direction (deps, default callers).") },
	showEdges: { modes: ["deps"], schema: flag("Show dependency edges (deps).") },
};

export function inspectParameters(outputProperties: Record<string, unknown>) {
	return {
		type: "object",
		properties: {
			mode: choice([...INSPECT_MODES], "architecture: area map; structure: file inventory; ast: file outline; explain: symbol; deps: relationships."),
			target: text("Required for ast/explain/deps: project-relative file or file::symbol (explain also accepts a symbol). Use scope for an area."),
			...Object.fromEntries(Object.entries(OPTIONS).map(([name, option]) => [name, option.schema])),
			...outputProperties,
		},
		required: ["mode"],
		additionalProperties: false,
	};
}

function safeValue(value: unknown): value is string {
	return typeof value === "string" && !!value.trim() && !value.trim().startsWith("-") && !value.includes("\0");
}

function relativeValue(value: string): boolean {
	const normalized = value.replaceAll("\\", "/");
	return !normalized.startsWith("/") && !/^[A-Za-z]:/.test(normalized) && !normalized.split("/").includes("..");
}

/** Validate even direct/codemode calls, then adapt typed options to the existing idx engine. */
export function buildInspectRequest(input: unknown, profile: RepoDiscoveryProfile): InspectRequest | string {
	const fail = (message: string) => `repo_inspect ${message}`;
	if (!input || typeof input !== "object" || Array.isArray(input)) return fail("requires an object.");
	const params = input as Record<string, unknown>;
	if (!INSPECT_MODES.includes(params.mode as RepoIdxCommand)) return fail(`mode must be one of: ${INSPECT_MODES.join(", ")}.`);
	const mode = params.mode as RepoIdxCommand;
	const common = ["mode", "target", "projectPath", "maxLines", "maxBytes", ...(profile === "native-compact" ? ["outputMode"] : [])];
	for (const [key, value] of Object.entries(params)) {
		if (common.includes(key)) continue;
		if (!Object.hasOwn(OPTIONS, key)) return fail(`does not accept ${key}; use typed options, not raw args.`);
		if (value === undefined) continue;
		const option = OPTIONS[key as keyof typeof OPTIONS];
		if (!option.modes.includes(mode)) return fail(`${key} is not supported for mode=${mode}.`);
		const schema = option.schema;
		if (schema.type === "integer" && (!Number.isSafeInteger(value) || (value as number) < ("minimum" in schema ? schema.minimum : 1))) return fail(`${key} must be an integer within its documented range.`);
		if (schema.type === "boolean" && typeof value !== "boolean") return fail(`${key} must be boolean.`);
		if (schema.type === "string" && (!safeValue(value) || ("enum" in schema && !schema.enum.includes(value)))) return fail(`${key} has an invalid value.`);
	}
	const needsTarget = ["ast", "explain", "deps"].includes(mode);
	if (needsTarget && (!safeValue(params.target) || !relativeValue(params.target.trim()))) return fail(`mode=${mode} requires a project-relative target or symbol, not an option or traversal.`);
	if (!needsTarget && params.target !== undefined) return fail(`mode=${mode} uses scope, not target.`);
	if (params.scope !== undefined && !relativeValue((params.scope as string).trim())) return fail("scope must be project-relative without traversal.");
	if (mode === "deps" && params.tests !== undefined && params.tests !== "include") return fail("deps tests accepts only include.");
	if (mode === "explain" && params.limit !== undefined && params.includeBody !== true) return fail("explain limit requires includeBody=true.");
	for (const key of ["maxLines", "maxBytes"] as const) {
		const max = key === "maxLines" ? 2000 : 50_000;
		if (params[key] !== undefined && (!Number.isSafeInteger(params[key]) || (params[key] as number) < 1 || (params[key] as number) > max)) return fail(`${key} must be a positive integer <=${max}.`);
	}
	if (profile === "native-compact" && params.outputMode !== undefined && !["compact", "full"].includes(params.outputMode as string)) return fail("outputMode must be compact or full.");
	const args: string[] = [];
	const add = (name: string, value: unknown) => { if (value !== undefined) args.push(name, String(value).trim()); };
	add("--path-prefix", params.scope);
	if (mode === "structure") {
		add("--max-files", params.limit ?? 20);
		add("--max-depth", params.depth ?? 2);
		add("--cursor", params.cursor);
		add("--kind", params.kind);
		if (params.includeInternal) args.push("--include-internal");
		if (params.tests === "exclude") args.push("--no-tests");
		if (params.tests === "summary") args.push("--include-tests-summary");
	} else if (mode === "ast") {
		add("--max-depth", params.depth ?? 3);
		add("--max-nodes", params.limit ?? 40);
		add("--cursor", params.cursor);
		args.push("--no-include-text");
	} else if (mode === "explain") {
		args.push(params.includeBody ? "--include-body" : "--signature-only");
		if (params.includeBody) add("--body-lines", params.limit ?? 20);
	} else if (mode === "deps") {
		add("--mode", params.relations);
		add("--direction", params.direction ?? "callers");
		add("--depth", params.depth ?? 1);
		if (params.showEdges) args.push("--show-edges");
		if (params.tests === "include") args.push("--tests");
	}
	return {
		command: mode, args,
		target: needsTarget ? (params.target as string).trim() : undefined,
		projectPath: params.projectPath as string | undefined,
		maxLines: params.maxLines as number | undefined,
		maxBytes: params.maxBytes as number | undefined,
		outputMode: params.outputMode as RepoDiscoveryOutputMode | undefined,
	};
}
