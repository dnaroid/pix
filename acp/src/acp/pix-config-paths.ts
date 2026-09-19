import { homedir } from "node:os";
import { join } from "node:path";

export const PIX_CONFIG_PROFILE_ENV = "PIX_CONFIG_PROFILE";

export function pixConfigFileName(env: NodeJS.ProcessEnv = process.env): string {
	return env[PIX_CONFIG_PROFILE_ENV]?.trim().toLowerCase() === "desktop"
		? "pix-desktop.jsonc"
		: "pix.jsonc";
}

export function pixUserConfigPath(homeDir = homedir(), env: NodeJS.ProcessEnv = process.env): string {
	return join(homeDir, ".config", "pi", pixConfigFileName(env));
}

export function pixProjectConfigPath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
	return join(cwd, ".pi", pixConfigFileName(env));
}
