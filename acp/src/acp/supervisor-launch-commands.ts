import { createHash, randomUUID } from "node:crypto";
import { applyEdits, getNodeValue, modify, parseTree } from "jsonc-parser";
import { editWorkspaceConfig, readWorkspaceConfig } from "../search/source-policy.js";
import type { SupervisorSetupRequest } from "./supervisor-setup-contract.js";

type LaunchEdit = Extract<SupervisorSetupRequest, { op: "launch-add" | "launch-edit" }>;
type LaunchCommand = { id: string; name: string; command: string };

function commandsOf(content: string): LaunchCommand[] {
	const rows = parseTree(content, [], { allowTrailingComma: true })?.children?.find(
		(property) => property.children?.[0]?.value === "launchCommands",
	)?.children?.[1];
	if (!rows) return [];
	const commands = rows.children?.map((node) => {
		const keys = node.children?.map((field) => field.children?.[0]?.value);
		const value: unknown = getNodeValue(node);
		if (node.type !== "object" || !keys || new Set(keys).size !== keys.length || !validCommand(value)) {
			throw new Error("Invalid launchCommands entry in .pi/workspace.jsonc");
		}
		return value;
	}) ?? [];
	if (rows.type !== "array" || new Set(commands.map(({ id }) => id)).size !== commands.length) {
		throw new Error("Invalid launchCommands array or duplicate command id in .pi/workspace.jsonc");
	}
	return commands;
}

function validCommand(value: unknown): value is LaunchCommand {
	if (!value || typeof value !== "object") return false;
	const row = value as Record<string, unknown>;
	return [row.id, row.name, row.command].every((field) => typeof field === "string" && field.trim());
}

function withRevision({ id, name, command }: LaunchCommand) {
	const revision = createHash("sha256").update(JSON.stringify([id, name, command])).digest("hex");
	return { id, name, command, revision };
}

export async function listSupervisorLaunchCommands(cwd: string) {
	return commandsOf(await readWorkspaceConfig(cwd)).map(withRevision);
}

export function saveSupervisorLaunchCommand(cwd: string, request: LaunchEdit, beforeCommit: () => Promise<void>) {
	return editWorkspaceConfig(cwd, (content) => {
		const commands = commandsOf(content);
		const formattingOptions = { insertSpaces: true, tabSize: 2, eol: content.includes("\r\n") ? "\r\n" : "\n" };
		const set = (source: string, path: (string | number)[], value: unknown) => applyEdits(source, modify(source, path, value, { formattingOptions }));
		if (request.op === "launch-add") {
			const command = { id: randomUUID(), name: request.name, command: request.command };
			return [set(content, ["launchCommands", -1], command), withRevision(command)];
		}
		const index = commands.findIndex(({ id }) => id === request.commandId);
		const existing = commands[index];
		if (!existing || withRevision(existing).revision !== request.revision) {
			throw new Error("Launch Command changed or was removed; use launch-list and review before editing");
		}
		const updated = { ...existing };
		for (const key of ["name", "command"] as const) {
			const value = request[key];
			if (value !== undefined && value !== existing[key]) {
				updated[key] = value;
				content = set(content, ["launchCommands", index, key], value);
			}
		}
		return [content, withRevision(updated)];
	}, beforeCommit);
}
