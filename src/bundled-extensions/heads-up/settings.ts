import { homedir } from "node:os";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse, type ParseError } from "jsonc-parser";
import { DEFAULT_HEADS_UP_MODEL, normalizeHeadsUpConfig, type HeadsUpConfig } from "./config.js";

export function offline(env: NodeJS.ProcessEnv = process.env): boolean {
	return ["1", "true", "yes", "on"].includes((env.PI_OFFLINE ?? "").trim().toLowerCase());
}
async function readConfig(path: string, maxBytes = 16_384): Promise<Record<string, unknown>> {
	let file: Awaited<ReturnType<typeof open>> | undefined;
	try {
		file = await open(path, "r");
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > maxBytes) return {};
		const bytes = Buffer.alloc(maxBytes + 1);
		const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
		if (bytesRead > maxBytes) return {};
		const errors: ParseError[] = [];
		const value: unknown = parse(bytes.subarray(0, bytesRead).toString("utf8"), errors, { allowTrailingComma: true });
		return errors.length === 0 && value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	} catch { return {}; } finally { await file?.close().catch(() => {}); }
}
function desktopProfile(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.PIX_CONFIG_PROFILE?.trim().toLowerCase() === "desktop";
}

function observerSection(value: Record<string, unknown>): Record<string, unknown> {
	const section = value.headsUp;
	return section && typeof section === "object" && !Array.isArray(section)
		? section as Record<string, unknown>
		: {};
}

export async function loadHeadsUpSettings(cwd: string, trusted: boolean): Promise<{ enabled: boolean; model: string; config: HeadsUpConfig }> {
	// Desktop deliberately has a separate profile. Do not fall back to the
	// standalone heads-up.jsonc or the TUI pix.jsonc in this branch.
	if (desktopProfile()) {
		// This file contains the entire Desktop profile, not only observer settings.
		const global = await readConfig(join(homedir(), ".config", "pi", "pix-desktop.jsonc"), 1_048_576);
		const project = trusted ? await readConfig(join(cwd, ".pi", "pix-desktop.jsonc"), 1_048_576) : {};
		const raw = { ...observerSection(global), ...observerSection(project) };
		const model = typeof raw.model === "string" && /^[^\s/]+\/[^\s]+$/.test(raw.model) && raw.model.length <= 256 ? raw.model : DEFAULT_HEADS_UP_MODEL;
		return { enabled: raw.enabled === true && !offline(), model, config: normalizeHeadsUpConfig(raw) };
	}

	const global = await readConfig(join(getAgentDir(), "heads-up.jsonc"));
	const project = trusted ? await readConfig(join(cwd, ".pi", "heads-up.jsonc")) : {};
	const raw = { ...global, ...project };
	const model = typeof raw.model === "string" && /^[^\s/]+\/[^\s]+$/.test(raw.model) && raw.model.length <= 256 ? raw.model : DEFAULT_HEADS_UP_MODEL;
	return { enabled: raw.enabled === true && !offline(), model, config: normalizeHeadsUpConfig(raw) };
}
