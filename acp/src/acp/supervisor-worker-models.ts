import { readFile } from "node:fs/promises";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { PIX_CONFIG_PROFILE_ENV, pixProjectConfigPath, pixUserConfigPath } from "./pix-config-paths.js";
import { MAX_MODEL_REF } from "./supervisor-contract.js";

const TIERS = ["simple", "standard", "complex"] as const;
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const DESKTOP_PROFILE = { [PIX_CONFIG_PROFILE_ENV]: "desktop" };

type WorkerModels = Partial<Record<typeof TIERS[number], string>>;
type Report = (message: string) => void;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function readWorkerModels(path: string, profile: string, report: Report): Promise<WorkerModels> {
	let source: string;
	try {
		source = await readFile(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") report(`Cannot read ${profile} Desktop worker models (${code ?? "unknown error"})`);
		return {};
	}
	const errors: ParseError[] = [];
	const config = record(parseJsonc(source, errors));
	if (!config || errors.length) {
		report(`Invalid ${profile} Desktop model configuration`);
		return {};
	}
	const tiers = record(record(config.supervisor)?.workerModels);
	const models: WorkerModels = {};
	for (const tier of TIERS) {
		if (tiers?.[tier] === undefined) continue;
		const entry = record(tiers[tier]);
		const model = typeof entry?.modelRef === "string" ? entry.modelRef.trim() : "";
		const thinking = entry?.thinking;
		const ref = typeof thinking === "string" ? `${model}:${thinking}` : model;
		if (!/^[\w.~-]+\/[\w./@+~-]+$/u.test(model) || ref.length > MAX_MODEL_REF
			|| (thinking !== undefined && (typeof thinking !== "string" || !THINKING.includes(thinking)))) {
			report(`Invalid ${tier} supervisor worker model in ${profile} Desktop configuration`);
			continue;
		}
		models[tier] = ref;
	}
	return models;
}

/** A project can replace individual assignments. Read on demand so open supervisors see edits. */
export async function loadSupervisorWorkerModels(cwd: string, report: Report, homeDir?: string): Promise<WorkerModels> {
	const [user, project] = await Promise.all([
		readWorkerModels(pixUserConfigPath(homeDir, DESKTOP_PROFILE), "user", report),
		readWorkerModels(pixProjectConfigPath(cwd, DESKTOP_PROFILE), "project", report),
	]);
	return { ...user, ...project };
}

export function supervisorWorkerModelGuidance(models: WorkerModels): string | undefined {
	const assignments = TIERS.flatMap((tier) => models[tier] ? [`- ${tier}: ${models[tier]}`] : []);
	if (!assignments.length) return undefined;
	return [
		"Choose a worker model yourself before each supervisor start. Pass the exact configured modelRef (including thinking) for the task's complexity:",
		...assignments,
		"Simple: clear, small or mechanical work. Standard: typical features and localized debugging. Complex: architecture, hard diagnosis or risky cross-module work.",
		"If the matching tier is not configured, omit modelRef; Desktop uses standard if configured, otherwise its normal default. A saved task's own model always takes precedence.",
	].join("\n");
}
