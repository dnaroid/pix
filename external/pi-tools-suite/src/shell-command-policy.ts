export type ShellCommandScope = "simple" | "compound" | "unknown";
export type ShellCommandKind = "inspection" | "test-build" | "mutation" | "unknown";

export interface ShellCommandClassification {
	scope: ShellCommandScope;
	kind: ShellCommandKind;
}

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*$/;
const SAFE_EPHEMERAL_WRITE_RE = /^\/(?:private\/)?tmp\/[^\0\r\n]+$/;
const COMMAND_SEPARATORS = new Set([";", "&&", "||", "|"]);
const REDIRECT_OPERATORS = new Set([">", ">>", "<"]);

interface ShellScan {
	scope: ShellCommandScope;
	commands: string[][];
	unsafeWrite: boolean;
	unsupported: boolean;
}

function safeEphemeralWriteTarget(target: string): boolean {
	return target === "/dev/null" || SAFE_EPHEMERAL_WRITE_RE.test(target);
}

/**
 * Minimal conservative shell lexer. It understands quoting only well enough to
 * keep metacharacters inside quotes literal and to prove a small allowlisted
 * inspection pipeline safe. Unsupported shell syntax remains unknown.
 */
function scanShell(command: string): ShellScan {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let unsupported = false;
	const flush = () => {
		if (current.length > 0) tokens.push(current);
		current = "";
	};

	for (let index = 0; index < command.length; index++) {
		const char = command[index]!;
		const next = command[index + 1];
		if (quote) {
			if (char === quote) {
				quote = undefined;
				continue;
			}
			if (quote === '"' && char === "\\" && next !== undefined) {
				current += next;
				index++;
				continue;
			}
			if (quote === '"' && (char === "`" || (char === "$" && next === "("))) unsupported = true;
			current += char;
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char === "\\" && next !== undefined) {
			current += next;
			index++;
			continue;
		}
		if (char === "`" || (char === "$" && next === "(") || ((char === "<" || char === ">") && next === "(")) {
			unsupported = true;
		}
		if (char === "\r" || char === "\n" || char === "&" && next !== "&" || char === "(" || char === ")") {
			unsupported = true;
		}
		if (/\s/.test(char)) {
			flush();
			continue;
		}
		if (char === ";" || char === "|" || char === ">" || char === "<" || (char === "&" && next === "&")) {
			flush();
			let operator = char;
			if ((char === "&" && next === "&") || (char === "|" && next === "|") || (char === ">" && next === ">") || (char === "<" && next === "<")) {
				operator += next;
				index++;
			}
			if (operator === "<<") unsupported = true;
			tokens.push(operator);
			continue;
		}
		current += char;
	}
	flush();
	if (quote) unsupported = true;

	const commands: string[][] = [];
	let currentCommand: string[] = [];
	let unsafeWrite = false;
	let compound = false;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (COMMAND_SEPARATORS.has(token)) {
			compound = true;
			if (currentCommand.length === 0) unsupported = true;
			else commands.push(currentCommand);
			currentCommand = [];
			continue;
		}
		if (REDIRECT_OPERATORS.has(token)) {
			compound = true;
			const target = tokens[++index];
			if (!target || COMMAND_SEPARATORS.has(target) || REDIRECT_OPERATORS.has(target)) {
				unsupported = true;
				continue;
			}
			if ((token === ">" || token === ">>") && !safeEphemeralWriteTarget(target)) unsafeWrite = true;
			continue;
		}
		currentCommand.push(token);
	}
	if (currentCommand.length > 0) commands.push(currentCommand);
	else if (tokens.length > 0 && COMMAND_SEPARATORS.has(tokens.at(-1)!)) unsupported = true;

	for (const words of commands) {
		while (words.length > 0 && (ENV_ASSIGNMENT_RE.test(words[0]!) || /^\d+$/.test(words[0]!))) words.shift();
		if (words.length === 0) unsupported = true;
	}
	return {
		scope: unsupported ? "unknown" : compound ? "compound" : "simple",
		commands,
		unsafeWrite,
		unsupported,
	};
}

function baseName(value: string): string {
	return value.replace(/\\/g, "/").split("/").at(-1)?.toLowerCase() ?? "";
}

function isKnownInspection(words: readonly string[]): boolean {
	const exe = baseName(words[0]!);
	if (["pwd", "ls", "grep", "cat", "head", "tail", "wc", "stat", "du", "which", "sort", "uniq", "cut", "tr", "printf", "echo", "basename", "dirname"].includes(exe)) {
		return true;
	}
	if (exe === "find") {
		return !words.some((word) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(word));
	}
	if (exe === "fd") {
		return !words.some((word) => ["-x", "--exec", "-X", "--exec-batch"].includes(word));
	}
	if (exe === "rg") {
		return !words.some((word) => word === "--pre" || word.startsWith("--pre="));
	}
	if (exe === "command" && words[1] === "-v") return true;
	if (exe === "sed") return words.includes("-n") && !words.some((word) => /^-.*i/.test(word));
	if (exe === "jq") return !words.some((word) => word === "-i" || word === "--in-place");
	if (exe !== "git") return false;
	const sub = words[1]?.toLowerCase();
	if (["status", "diff", "log", "show", "grep", "rev-parse", "ls-files", "ls-tree"].includes(sub ?? "")) return true;
	if (sub === "branch") return words.includes("--show-current");
	if (sub === "remote") {
		const action = words[2]?.toLowerCase();
		return action === undefined || action === "-v" || action === "--verbose" || action === "get-url";
	}
	return false;
}

function isKnownTestBuild(words: readonly string[]): boolean {
	const exe = baseName(words[0]!);
	const first = words[1]?.toLowerCase();
	if (["pytest", "vitest", "jest", "tsc", "eslint", "stylelint"].includes(exe)) return true;
	if (exe === "biome") return first === "check" || first === "lint";
	if (exe === "cargo") return ["test", "check", "build", "clippy", "fmt"].includes(first ?? "");
	if (exe === "go") return first === "test" || first === "vet";
	if (exe === "bun") {
		if (first === "test") return true;
		if (first === "run") return /^(test|check|lint|typecheck|build)(:|$)/.test(words[2]?.toLowerCase() ?? "");
	}
	if (["npm", "pnpm", "yarn"].includes(exe)) {
		if (first === "test") return true;
		if (first === "run") return /^(test|check|lint|typecheck|build)(:|$)/.test(words[2]?.toLowerCase() ?? "");
	}
	return false;
}

function isKnownMutation(words: readonly string[]): boolean {
	const exe = baseName(words[0]!);
	if (["rm", "mv", "cp", "mkdir", "rmdir", "touch", "chmod", "chown", "ln", "install"].includes(exe)) return true;
	if (exe === "sed" && words.some((word) => /^-.*i/.test(word))) return true;
	if (exe === "git") {
		return [
			"add", "commit", "reset", "checkout", "switch", "restore", "clean", "merge", "rebase",
			"cherry-pick", "revert", "tag", "push", "pull", "fetch", "stash", "worktree",
		].includes(words[1]?.toLowerCase() ?? "");
	}
	if (["npm", "pnpm", "yarn", "bun"].includes(exe)) {
		return ["install", "add", "remove", "uninstall", "update", "upgrade", "link", "publish"].includes(words[1]?.toLowerCase() ?? "");
	}
	return false;
}

export function shellCommandText(input: unknown): string | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
	const command = (input as Record<string, unknown>).command;
	return typeof command === "string" && command.trim().length > 0 ? command.trim() : undefined;
}

/**
 * Conservative, non-executing shell classifier. A command is considered
 * inspection/test-build only when both its structure and executable/subcommand
 * are allowlisted. Everything ambiguous fails closed to unknown.
 */
export function classifyShellCommand(input: unknown): ShellCommandClassification {
	const command = shellCommandText(input);
	if (!command) return { scope: "unknown", kind: "unknown" };
	const scan = scanShell(command);
	if (scan.unsupported || scan.commands.length === 0) return { scope: "unknown", kind: "unknown" };
	if (scan.unsafeWrite || scan.commands.some(isKnownMutation)) return { scope: scan.scope, kind: "mutation" };
	if (scan.commands.length === 1 && isKnownTestBuild(scan.commands[0]!)) return { scope: scan.scope, kind: "test-build" };
	if (scan.commands.every(isKnownInspection)) return { scope: scan.scope, kind: "inspection" };
	return { scope: scan.scope, kind: "unknown" };
}
