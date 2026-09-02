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
	| { readonly kind: "name"; readonly name: string }
	| { readonly kind: "export"; readonly outputPath?: string | undefined }
	| { readonly kind: "autocompact"; readonly enabled: boolean }
	| { readonly kind: "steering"; readonly mode: "all" | "one-at-a-time" }
	| { readonly kind: "followup"; readonly mode: "all" | "one-at-a-time" }
	| { readonly kind: "model"; readonly value?: string | undefined }
	| { readonly kind: "thinking"; readonly level: string };

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
	const name = match[1]!;
	const rest = match[2]?.trim() ?? "";

	switch (name) {
		case "compact":
			return { kind: "compact", instructions: rest || undefined };
		case "name":
			return { kind: "name", name: rest };
		case "export":
			return { kind: "export", outputPath: rest || undefined };
		case "autocompact":
			return { kind: "autocompact", enabled: rest !== "off" };
		case "steering":
		case "followup":
		case "follow-up": {
			const mode = rest === "one-at-a-time" ? "one-at-a-time" : "all";
			return name === "steering"
				? { kind: "steering", mode }
				: { kind: "followup", mode };
		}
		case "model":
			return { kind: "model", value: rest || undefined };
		case "thinking":
		case "thought":
			return { kind: "thinking", level: rest };
		default:
			return undefined;
	}
}

/** Human-readable usage error for a parsed built-in, if its arguments are invalid. */
export function builtinUsageError(command: BuiltinCommand): string | undefined {
	switch (command.kind) {
		case "name":
			return command.name ? undefined : "usage: /name <session name>";
		case "model":
			if (command.value === undefined) return undefined;
			return command.value.includes("/") ? undefined : 'usage: /model <provider>/<modelId> (or no argument to cycle)';
		case "thinking":
			return command.level ? undefined : "usage: /thinking <level>";
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
	}
}
