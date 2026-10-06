import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { boundedRead, checkedPath, privateJson, readJson, safePath } from "./paths.mjs";

// Derived from pi-coding-agent/config, acp/pix-config-paths and suite/config.
const AGENT_CONFIGS = ["settings.json", "models.json"];
const USER_CONFIGS = ["pix-desktop.jsonc", "pi-tools-suite.jsonc"];

/** Keep only literal API keys. Never resolve commands, env references or OAuth. */
export function filterApiKeys(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("auth seed must be an object");
	const result = Object.create(null);
	for (const [provider, credential] of Object.entries(value)) {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(provider) || !credential || credential.type !== "api_key") continue;
		const key = credential.key;
		if (typeof key !== "string" || !key.trim() || key.length > 16384 || key.trim().startsWith("!") || key.includes("$") || /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key.trim()) || credential.env !== undefined) continue;
		result[provider] = { type: "api_key", key };
	}
	return result;
}

async function optionalInput(root, name, json = false) {
	try {
		const canonical = await realpath(checkedPath(root));
		// Reject a symlinked seed root; callers must explicitly select its canonical location.
		if (canonical !== checkedPath(root)) throw new Error("symlink seed root is not allowed");
		const path = await safePath(canonical, join(canonical, name), "file");
		return json ? await readJson(path, 1024 * 1024) : await boundedRead(path, 1024 * 1024);
	} catch (error) {
		if (error.code === "ENOENT") return undefined;
		throw new Error("seed input is unsafe, invalid or exceeds limit");
	}
}

export async function seedProfile(profile, { seedConfig = false, seedApiKeys = false, env = process.env, home = homedir() } = {}) {
	const sourceHome = checkedPath(env.HOME || home);
	const agentSource = checkedPath(env.PI_CODING_AGENT_DIR || join(sourceHome, ".pi", "agent"));
	// Pix's user files actually live under HOME/.config/pi, even when PI_CONFIG_DIR is overridden.
	const userSource = join(sourceHome, ".config", "pi");
	const agentDestination = join(profile, "home", ".pi", "agent");
	const userDestination = join(profile, "home", ".config", "pi");
	let configFiles = 0;
	if (seedConfig) {
		for (const [root, destination, names] of [[agentSource, agentDestination, AGENT_CONFIGS], [userSource, userDestination, USER_CONFIGS]]) {
			for (const name of names) {
				const content = await optionalInput(root, name);
				if (content === undefined) continue;
				await writeFile(join(destination, name), content, { mode: 0o600, flag: "wx" });
				configFiles++;
			}
		}
		// The suite also supports an explicit PI_CONFIG_DIR layer. Preserve only its one allowlisted file.
		if (env.PI_CONFIG_DIR && checkedPath(env.PI_CONFIG_DIR) !== userSource) {
			const content = await optionalInput(checkedPath(env.PI_CONFIG_DIR), "pi-tools-suite.jsonc");
			if (content !== undefined) {
				const destination = join(profile, "suite-config");
				await mkdir(destination, { mode: 0o700 });
				await writeFile(join(destination, "pi-tools-suite.jsonc"), content, { mode: 0o600, flag: "wx" });
				// Do not add a separate environment override: merge precedence would diverge from the shared contract.
				// An explicit suite layer takes precedence over its HOME layer in the private config directory.
				await writeFile(join(userDestination, "pi-tools-suite.jsonc"), content, { mode: 0o600 });
				configFiles++;
			}
		}
	}
	let apiKeys = 0;
	if (seedApiKeys) {
		const input = await optionalInput(agentSource, "auth.json", true);
		const keys = input === undefined ? {} : filterApiKeys(input);
		apiKeys = Object.keys(keys).length;
		await privateJson(join(agentDestination, "auth.json"), keys);
	}
	return { configFiles, apiKeysSeeded: apiKeys > 0, apiKeyCount: apiKeys, oauthAndEnvKeysSkipped: true };
}
