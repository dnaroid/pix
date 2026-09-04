/**
 * Built-in slash command interception for `session/prompt`.
 *
 * pi's RPC mode natively expands prompt templates, `/skill:*` commands and
 * extension commands when text starting with "/" is passed to `prompt()`.
 * However, the classic TUI built-ins (/compact, /name, /model, ...) have no
 * RPC counterpart — they are implemented by the TUI, not by the agent.
 *
 * ACP has no slash-command surface, so this module recognizes those
 * built-ins inside `session/prompt` and maps them onto dedicated RPC
 * commands. Anything else (including unknown "/..." text) is forwarded to
 * pi's own command handling.
 */

/** Commands recognized locally by the adapter (pi TUI built-ins). */
export type BuiltinCommand =
	| { readonly kind: "compact"; readonly instructions?: string | undefined }
	| { readonly kind: "name"; readonly name?: string | undefined }
	| { readonly kind: "export"; readonly outputPath?: string | undefined }
	| { readonly kind: "autocompact"; readonly enabled: boolean }
	| { readonly kind: "steering"; readonly mode: "all" | "one-at-a-time" }
	| { readonly kind: "followup"; readonly mode: "all" | "one-at-a-time" }
	| { readonly kind: "model"; readonly value?: string | undefined }
	| { readonly kind: "thinking"; readonly level: string }
	| { readonly kind: "session"; readonly argumentsText: string }
	| { readonly kind: "clone"; readonly argumentsText: string }
	| { readonly kind: "copy"; readonly argumentsText: string };

/** Metadata for built-ins the ACP adapter can execute without the TUI. */
export interface BuiltinSlashCommandDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputHint?: string;
	readonly inputRequired?: boolean;
	readonly aliases?: readonly string[];
}

/**
 * The public command catalog and parser share this list so Desktop never
 * advertises a renderer-only command that the ACP adapter cannot execute.
 */
export const BUILTIN_SLASH_COMMANDS: readonly BuiltinSlashCommandDefinition[] = [
	{ name: "compact", description: "Compact the conversation context", inputHint: "[instructions]" },
	{
		name: "name",
		description: "Show or set the conversation name",
		inputHint: "[conversation name]",
	},
	{ name: "export", description: "Export the conversation as HTML", inputHint: "[output path]" },
	{ name: "autocompact", description: "Enable or disable automatic compaction", inputHint: "[on | off]" },
	{ name: "steering", description: "Set how steering messages are delivered", inputHint: "[all | one-at-a-time]" },
	{
		name: "follow-up",
		description: "Set how follow-up messages are delivered",
		inputHint: "[all | one-at-a-time]",
		aliases: ["followup"],
	},
	{ name: "model", description: "Cycle or select the active model", inputHint: "[provider/model]" },
	{
		name: "thinking",
		description: "Set the model thinking level",
		inputHint: "<level>",
		inputRequired: true,
		aliases: ["thought"],
	},
	{ name: "session", description: "Show session info and usage statistics" },
	{ name: "clone", description: "Duplicate the current session at its current position" },
	{ name: "copy", description: "Copy the last assistant message to the clipboard" },
];

const BUILTIN_CANONICAL_NAME = new Map(
	BUILTIN_SLASH_COMMANDS.flatMap((command) => [
		[command.name, command.name] as const,
		...(command.aliases ?? []).map((alias) => [alias, command.name] as const),
	]),
);

const PIX_RENDERER_COMMAND_NAMES = new Set([
	"settings",
	"default-model",
	"autocomplete",
	"no-context-files",
	"scoped-models",
	"default-thinking",
	"enhance",
	"import",
	"share",
	"queue",
	"usage",
	"changelog",
	"update",
	"hotkeys",
	"fork",
	"tree",
	"jump",
	"history",
	"search",
	"trust",
	"login",
	"logout",
	"reload",
	"resume",
	"new",
	"new_tab",
	"delete",
	"quit",
	"exit",
]);

/**
 * Parse the first word of a prompt as a built-in command.
 * Returns `undefined` when the text is not a recognized built-in (it may
 * still be a pi extension/template/skill command — passthrough).
 *
 * Parsing never throws; argument validation errors are reported by
 * `builtinUsageError` so that callers can turn them into protocol errors.
 */
export function parseBuiltinCommand(text: string): BuiltinCommand | undefined {
	const match = /^\/(\S+)(?:[\s]+([\s\S]*))?$/.exec(text);
	if (!match) return undefined;
	const name = BUILTIN_CANONICAL_NAME.get(match[1]!.toLowerCase());
	if (!name) return undefined;
	const rest = match[2]?.trim() ?? "";

	switch (name) {
		case "compact":
			return { kind: "compact", instructions: rest || undefined };
		case "name":
			return { kind: "name", name: rest || undefined };
		case "export":
			return { kind: "export", outputPath: rest || undefined };
		case "autocompact":
			return { kind: "autocompact", enabled: rest !== "off" };
		case "steering":
		case "follow-up": {
			const mode = rest === "one-at-a-time" ? "one-at-a-time" : "all";
			return name === "steering"
				? { kind: "steering", mode }
				: { kind: "followup", mode };
		}
		case "model":
			return { kind: "model", value: rest || undefined };
		case "thinking":
			return { kind: "thinking", level: rest };
		case "session":
			return { kind: "session", argumentsText: rest };
		case "clone":
			return { kind: "clone", argumentsText: rest };
		case "copy":
			return { kind: "copy", argumentsText: rest };
		default:
			return undefined;
	}
}

/** Return the name of a Pix command that requires renderer/client UI. */
export function rendererCommandName(text: string): string | undefined {
	const match = /^\/(\S+)/.exec(text);
	const name = match?.[1]?.toLowerCase();
	return name && PIX_RENDERER_COMMAND_NAMES.has(name) ? name : undefined;
}

/** Human-readable usage error for a parsed built-in, if its arguments are invalid. */
export function builtinUsageError(command: BuiltinCommand): string | undefined {
	switch (command.kind) {
		case "model":
			if (command.value === undefined) return undefined;
			return command.value.includes("/") ? undefined : 'usage: /model <provider>/<modelId> (or no argument to cycle)';
		case "thinking":
			return command.level ? undefined : "usage: /thinking <level>";
		case "session":
			return command.argumentsText ? "usage: /session" : undefined;
		case "clone":
			return command.argumentsText ? "usage: /clone" : undefined;
		case "copy":
			return command.argumentsText ? "usage: /copy" : undefined;
		default:
			return undefined;
	}
}

/** Feedback text describing what a built-in execution did. */
export function builtinFeedback(command: BuiltinCommand, detail: string): string {
	return `${describeCommand(command)} — ${detail}`;
}

function describeCommand(command: BuiltinCommand): string {
	switch (command.kind) {
		case "compact":
			return "/compact";
		case "name":
			return "/name";
		case "export":
			return "/export";
		case "autocompact":
			return "/autocompact";
		case "steering":
			return "/steering";
		case "followup":
			return "/follow-up";
		case "model":
			return "/model";
		case "thinking":
			return "/thinking";
		case "session":
			return "/session";
		case "clone":
			return "/clone";
		case "copy":
			return "/copy";
	}
}
