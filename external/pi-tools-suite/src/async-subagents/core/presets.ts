import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";

export interface SubagentPresetSelectionState {
	activePreset?: string;
}

let runtimeSessionPresetOverride: string | undefined;

export function getSessionSubagentPresetOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return runtimeSessionPresetOverride ?? trimString(env.AGENTS_PRESET);
}

export function getActiveSubagentPresetName(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return getSessionSubagentPresetOverride(env) ?? loadSubagentPresetSelection(env).activePreset;
}

export function setSessionSubagentPresetOverride(name: string | undefined): void {
	runtimeSessionPresetOverride = trimString(name);
}

export function getSubagentPresetSelectionPath(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = trimString(env.ASYNC_SUBAGENTS_ACTIVE_PRESET_FILE || env.PI_SUBAGENTS_ACTIVE_PRESET_FILE);
	return explicit ? resolve(expandHome(explicit)) : resolve(getPiAgentDir(env), "subagent-preset-selection.json");
}

export function loadSubagentPresetSelection(env: NodeJS.ProcessEnv = process.env): SubagentPresetSelectionState {
	const statePath = getSubagentPresetSelectionPath(env);
	if (!existsSync(statePath)) return {};

	const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as unknown;
	if (!isRecord(parsed)) throw new Error(`${statePath} must contain an object.`);
	return { activePreset: trimString(parsed.activePreset) };
}

export function saveSubagentPresetSelection(state: SubagentPresetSelectionState, env: NodeJS.ProcessEnv = process.env): void {
	const statePath = getSubagentPresetSelectionPath(env);
	mkdirSync(dirname(statePath), { recursive: true });
	writeFileSync(statePath, `${JSON.stringify(compactSelectionState(state), null, 2)}\n`, "utf-8");
}

export function setActiveSubagentPreset(name: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
	saveSubagentPresetSelection({ activePreset: trimString(name) }, env);
}

function compactSelectionState(state: SubagentPresetSelectionState): SubagentPresetSelectionState {
	return state.activePreset ? { activePreset: state.activePreset } : {};
}

function trimString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function expandHome(value: string): string {
	if (value === "~") return process.env.HOME || value;
	return value.startsWith("~/") ? `${process.env.HOME || "~"}/${value.slice(2)}` : value;
}

function getPiAgentDir(env: NodeJS.ProcessEnv): string {
	const getAgentDir = (piCodingAgent as { getAgentDir?: () => string }).getAgentDir;
	return getAgentDir ? getAgentDir() : resolve(env.HOME || process.cwd(), ".pi", "agent");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
