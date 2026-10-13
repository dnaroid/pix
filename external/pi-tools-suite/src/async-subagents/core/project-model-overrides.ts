import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectAgentsDir } from "./agents-dir.js";
import type { SubagentConfig } from "./config.js";

/** Wire format shared with ACP Registry: version 1, project agent name -> primary model ref. */
export function loadProjectModelOverrides(cwd: string, config: SubagentConfig): Record<string, string> {
	const agentsDir = projectAgentsDir(cwd);
	if (!agentsDir) return {};
	const file = join(dirname(agentsDir), "agent-model-overrides.json");
	let stat;
	try { stat = lstatSync(file); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024) {
		throw new Error(`Invalid agent-model-overrides.json: expected a regular project-local file under 64 KiB`);
	}
	const value: unknown = JSON.parse(readFileSync(file, "utf8"));
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.models)
		|| Object.keys(value).some((key) => key !== "version" && key !== "models")) {
		throw new Error("Invalid agent-model-overrides.json schema");
	}
	const result: Record<string, string> = Object.create(null);
	for (const [name, model] of Object.entries(value.models)) {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes("..")
			|| typeof model !== "string" || model.length > 512
			|| !/^[^\s/:]+\/[^\s:]+(?::(?:off|minimal|low|medium|high|xhigh|max))?$/.test(model)) {
			throw new Error(`Invalid model override for agent ${name}`);
		}
		const profile = config.types[name];
		// Removed/automatic profiles and built-ins are not editable Installed resources.
		if (config.projectAgentMetadata?.[name] && profile && profile.modelSelection !== "frontier"
			&& (profile.models?.length || profile.model || Object.keys(profile.modelByParent ?? {}).length)) {
			result[name] = model;
		}
	}
	return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
