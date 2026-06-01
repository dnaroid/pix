import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const AstGrepParamProperties = {
	command: Type.Optional(
		StringEnum(["run", "scan"] as const, {
			description: "ast-grep subcommand. run searches/rewrites by pattern; scan uses sgconfig/rule YAML. Default: run.",
		}),
	),
	pattern: Type.Optional(
		Type.String({
			description: "AST pattern to match for command=run, e.g. 'console.log($A)'",
		}),
	),
	paths: Type.Optional(
		Type.Array(Type.String(), {
			description: "Files/directories to search. Defaults to ['.'].",
		}),
	),
	lang: Type.Optional(
		Type.String({
			description: "Language of the pattern, e.g. ts, tsx, js, python, rust, go.",
		}),
	),
	rewrite: Type.Optional(
		Type.String({
			description:
				"Optional rewrite template/fix. ast_grep previews rewrites only; use ast_apply to apply changes.",
		}),
	),
	selector: Type.Optional(
		Type.String({
			description: "Optional AST node kind selector to extract the sub-node of the pattern to match.",
		}),
	),
	strictness: Type.Optional(
		StringEnum(["cst", "smart", "ast", "relaxed", "signature", "template"] as const, {
			description: "Pattern strictness. ast-grep default is smart.",
		}),
	),
	debugQuery: Type.Optional(
		StringEnum(["pattern", "ast", "cst", "sexp"] as const, {
			description: "Print query pattern's tree-sitter AST. Requires lang be set explicitly.",
		}),
	),
	config: Type.Optional(Type.String({ description: "Path to ast-grep root config, default is sgconfig.yml." })),
	globs: Type.Optional(
		Type.Array(Type.String(), {
			description: "Include/exclude globs. Repeatable ast-grep --globs values; use !pattern to exclude.",
		}),
	),
	threads: Type.Optional(Type.Number({ description: "Approximate number of threads to use. 0 lets ast-grep choose." })),
	inspect: Type.Optional(
		StringEnum(["nothing", "summary", "entity"] as const, {
			description: "Inspect information for file/rule discovery and scanning.",
		}),
	),
	maxResults: Type.Optional(Type.Number({ description: "For command=scan, show at most N results and stop once the limit is reached." })),
	context: Type.Optional(Type.Number({ description: "Show N context lines around each match." })),
	before: Type.Optional(Type.Number({ description: "Show N lines before each match." })),
	after: Type.Optional(Type.Number({ description: "Show N lines after each match." })),
	filesWithMatches: Type.Optional(
		Type.Boolean({ description: "Only print paths with at least one match. Conflicts with rewrite and json." }),
	),
	json: Type.Optional(Type.Boolean({ description: "Return ast-grep matches as JSON." })),
	jsonStyle: Type.Optional(
		StringEnum(["pretty", "stream", "compact"] as const, {
			description: "JSON output style. Default: pretty.",
		}),
	),
	follow: Type.Optional(Type.Boolean({ description: "Follow symbolic links while traversing directories." })),
	noIgnore: Type.Optional(
		Type.Array(StringEnum(["hidden", "dot", "exclude", "global", "parent", "vcs"] as const), {
			description: "Ignore-file suppression modes passed as repeated --no-ignore values.",
		}),
	),
	rule: Type.Optional(Type.String({ description: "For command=scan, scan with a single rule file." })),
	inlineRules: Type.Optional(
		Type.String({ description: "For command=scan, rule YAML text. Separate multiple rules with --- . Conflicts with rule." }),
	),
	format: Type.Optional(
		StringEnum(["github", "sarif"] as const, {
			description: "For command=scan, output warning/error messages in a machine-readable format.",
		}),
	),
	reportStyle: Type.Optional(
		StringEnum(["rich", "medium", "short"] as const, {
			description: "For command=scan, diagnostic report style. Default: rich.",
		}),
	),
	includeMetadata: Type.Optional(Type.Boolean({ description: "For command=scan with json=true, include rule metadata." })),
	filter: Type.Optional(Type.String({ description: "For command=scan, regex for rule ids to run. Conflicts with rule." })),
	error: Type.Optional(Type.Array(Type.String(), { description: "For command=scan, set specified rule ids to error. Use [''] for bare --error." })),
	warning: Type.Optional(Type.Array(Type.String(), { description: "For command=scan, set specified rule ids to warning. Use [''] for bare --warning." })),
	info: Type.Optional(Type.Array(Type.String(), { description: "For command=scan, set specified rule ids to info. Use [''] for bare --info." })),
	hint: Type.Optional(Type.Array(Type.String(), { description: "For command=scan, set specified rule ids to hint. Use [''] for bare --hint." })),
	off: Type.Optional(Type.Array(Type.String(), { description: "For command=scan, turn off specified rule ids. Use [''] for bare --off." })),
};

export const AstGrepParams = Type.Object(AstGrepParamProperties);

export const AstApplyParams = Type.Object({
	...AstGrepParamProperties,
	rewrite: Type.Optional(
		Type.String({
			description: "Rewrite template/fix for command=run. ast_apply applies changes with ast-grep --update-all.",
		}),
	),
});
