import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ToolAction { name: string; args: Record<string, unknown> }

// A conservative audit, not a shell parser or security sandbox. Retain every
// command for human inspection; unknown commands need review, not silent approval.
export function shellAudit(command: string): string[] {
	if (/[<>`]|\$\(|\$\{|\\\n/.test(command)) return ["shell expansion/redirection requires review"];
	const problems: string[] = [];
	for (const segment of command.split(/&&|\|\||[;\n|]/).map(value => value.trim()).filter(Boolean)) {
		const allowed = /^(?:pwd|ls|cat|head|tail|wc|nl|grep|rg)\b/.test(segment)
			|| /^git\s+(?:diff|show|status|log|ls-files|rev-parse)\b/.test(segment)
			|| /^git\s+branch\s+--show-current$/.test(segment)
			|| /^sort$/.test(segment)
			|| /^find\b/.test(segment)
			|| /^sed\b/.test(segment);
		const risky = /(?:--output|--ext-diff|--textconv|--no-index|--pre|--pre-glob)\b/.test(segment)
			|| /^find\b.*\s-(?:delete|exec|execdir|ok|okdir|fprint\w*|fprintf)\b/.test(segment)
			|| /^sed\b.*(?:\s-[^-\s]*i|--in-place|[;\s][ew]\s)/.test(segment);
		if (!allowed || risky) problems.push(`non-allowlisted inspection: ${segment}`);
	}
	return problems;
}

export function auditActions(actions: ToolAction[]): string[] {
	return actions.flatMap(action => {
		if (action.name === "bash") return shellAudit(String(action.args.command ?? ""));
		return ["read", "grep"].includes(action.name) ? [] : [`forbidden tool: ${action.name}`];
	});
}

export function snapshot(root: string): Record<string, string> {
	const files: Record<string, string> = {};
	function visit(dir: string): void {
		for (const entry of fs.readdirSync(dir).sort()) {
			if (dir === root && entry === ".git") continue;
			const full = path.join(dir, entry);
			const relative = path.relative(root, full);
			const stat = fs.lstatSync(full);
			if (stat.isSymbolicLink()) files[relative] = `link:${fs.readlinkSync(full)}`;
			else if (stat.isDirectory()) { files[`${relative}/`] = "dir"; visit(full); }
			else files[relative] = `${stat.mode}:${crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex")}`;
		}
	}
	visit(root);
	return files;
}

export function parseOutput(stdout: string): { events: any[]; actions: ToolAction[]; text: string; models: string[] } {
	const events = stdout.split(/\r?\n/).filter(Boolean).flatMap(line => {
		try { return [JSON.parse(line)]; } catch { return []; }
	});
	const actions = events.filter(event => event.type === "tool_execution_start")
		.map(event => ({ name: event.toolName, args: event.args ?? {} }));
	const messages = events.filter(event => event.type === "message_end" && event.message?.role === "assistant")
		.map(event => event.message);
	const text = messages.flatMap(message => (message.content ?? [])
		.filter((part: any) => part.type === "text").map((part: any) => part.text)).join("\n");
	return { events, actions, text, models: [...new Set<string>(messages.map(message => message.model).filter(Boolean))] };
}

export function hasConfidence(text: string): boolean {
	return /confidence[^\n]{0,30}\b(?:high|medium|low)\b/i.test(text)
		|| /\b(?:high|medium|low)\b[^\n]{0,30}confidence/i.test(text);
}
