import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
	FONT_FAMILY_NAME,
	installJetBrainsNerdFont,
	isJetBrainsNerdFontInstalled,
} from "../terminal/nerd-font-controller.js";
import { clipboardInstallHint, clipboardSupportAvailable } from "../screen/clipboard.js";
import { getPixConfigPath } from "../../config.js";
import { DEFAULT_PIX_CONFIG_JSONC } from "../../default-pix-config.js";

type PixInstallTestDeps = {
	existsSync: typeof existsSync;
	readFileSync: typeof readFileSync;
	mkdirSync: typeof mkdirSync;
	writeFileSync: typeof writeFileSync;
	spawn: typeof spawn;
	isJetBrainsNerdFontInstalled: typeof isJetBrainsNerdFontInstalled;
	installJetBrainsNerdFont: typeof installJetBrainsNerdFont;
	clipboardSupportAvailable: typeof clipboardSupportAvailable;
	clipboardInstallHint: typeof clipboardInstallHint;
};

const defaultPixInstallDeps: PixInstallTestDeps = {
	existsSync,
	readFileSync,
	mkdirSync,
	writeFileSync,
	spawn,
	isJetBrainsNerdFontInstalled,
	installJetBrainsNerdFont,
	clipboardSupportAvailable,
	clipboardInstallHint,
};

let pixInstallDeps = defaultPixInstallDeps;

export function setPixInstallTestDeps(overrides?: Partial<PixInstallTestDeps>): void {
	pixInstallDeps = overrides ? { ...defaultPixInstallDeps, ...overrides } : defaultPixInstallDeps;
}

export type PixInstallCliOptions = {
	checkOnly: boolean;
	help: boolean;
};

export type PixInstallCliContext = {
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
};

export type PixOnboardingState = {
	pixConfigExists: boolean;
	toolsConfigExists: boolean;
	providerAuthConfigured: boolean;
	opencodeAuthExists: boolean;
	opencodeAntigravityExists: boolean;
	webCredentialsConfigured: boolean;
	context7Configured: boolean;
	telegramConfigured: boolean;
};

const PROVIDER_API_KEY_ENV_NAMES = [
	"ANTHROPIC_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"GROQ_API_KEY",
	"MISTRAL_API_KEY",
	"OPENAI_API_KEY",
	"OPENROUTER_API_KEY",
	"XAI_API_KEY",
	"ZAI_API_KEY",
] as const;

const DEFAULT_TOOLS_CONFIG_JSONC = `{
  "$schema": "https://unpkg.com/pi-ui-extend/schemas/pi-tools-suite.json",
  "todoThinking": true,
  "disabledModules": []
}
`;

export function inspectPixOnboarding(homeDir = homedir(), env: NodeJS.ProcessEnv = process.env): PixOnboardingState {
	const pixConfigPath = getPixConfigPath(homeDir);
	const toolsConfigPath = join(homeDir, ".config", "pi", "pi-tools-suite.jsonc");
	const agentDir = env.PI_CODING_AGENT_DIR?.trim() || join(homeDir, ".pi", "agent");
	const piAuthPath = join(agentDir, "auth.json");
	const opencodeDataDir = env.OPENCODE_DATA_DIR?.trim()
		|| join(env.XDG_DATA_HOME?.trim() || join(homeDir, ".local", "share"), "opencode");
	const opencodeConfigDir = env.OPENCODE_CONFIG_DIR?.trim()
		|| join(env.XDG_CONFIG_HOME?.trim() || join(homeDir, ".config"), "opencode");
	const webCredentialPath = env.PI_TOOLS_SUITE_WEB_CREDENTIALS_PATH?.trim()
		|| join(homeDir, ".config", "pi", "pi-tools-suite-credentials.json");
	const providerEnvConfigured = PROVIDER_API_KEY_ENV_NAMES.some((name) => Boolean(env[name]?.trim()));

	return {
		pixConfigExists: pixInstallDeps.existsSync(pixConfigPath),
		toolsConfigExists: pixInstallDeps.existsSync(toolsConfigPath),
		providerAuthConfigured: providerEnvConfigured || jsonObjectHasEntries(piAuthPath),
		opencodeAuthExists: Boolean(env.OPENCODE_AUTH_CONTENT?.trim()) || pixInstallDeps.existsSync(join(opencodeDataDir, "auth.json")),
		opencodeAntigravityExists: pixInstallDeps.existsSync(join(opencodeConfigDir, "antigravity-accounts.json")),
		webCredentialsConfigured: Boolean(env.OLLAMA_API_KEY?.trim() || env.TAVILY_API_KEY?.trim()) || jsonObjectHasEntries(webCredentialPath),
		context7Configured: Boolean(env.CONTEXT7_API_KEY?.trim()),
		telegramConfigured: Boolean(env.PI_TERMINAL_BELL_TELEGRAM_BOT_TOKEN?.trim() && env.PI_TERMINAL_BELL_TELEGRAM_CHAT_ID?.trim()),
	};
}

export function ensurePixSetupFiles(homeDir = homedir()): { created: string[]; existing: string[] } {
	const files = [
		{ path: getPixConfigPath(homeDir), content: DEFAULT_PIX_CONFIG_JSONC },
		{ path: join(homeDir, ".config", "pi", "pi-tools-suite.jsonc"), content: DEFAULT_TOOLS_CONFIG_JSONC },
	];
	const created: string[] = [];
	const existing: string[] = [];
	for (const file of files) {
		if (pixInstallDeps.existsSync(file.path)) {
			existing.push(file.path);
			continue;
		}
		pixInstallDeps.mkdirSync(dirname(file.path), { recursive: true });
		try {
			pixInstallDeps.writeFileSync(file.path, file.content, { encoding: "utf8", flag: "wx" });
			created.push(file.path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			existing.push(file.path);
		}
	}
	return { created, existing };
}

export function formatPixInstallNextSteps(homeDir = homedir(), state = inspectPixOnboarding(homeDir)): string {
	const pixConfigPath = getPixConfigPath(homeDir);
	const toolsConfigPath = join(homeDir, ".config", "pi", "pi-tools-suite.jsonc");
	const opencodeDetected = state.opencodeAuthExists || state.opencodeAntigravityExists;
	const providerStep = formatProviderSetupStep(state.providerAuthConfigured, opencodeDetected);
	return [
		"",
		"First-run setup:",
		providerStep,
		...(opencodeDetected ? [
			"    /opencode-import safely preserves existing Pi credentials unless --force is used.",
			"    Supported migration: OpenAI/Codex, GitHub Copilot, Z.ai, and Antigravity credentials; OpenCode models, MCP, plugins, and tool settings are reported as manual work.",
		] : []),
		`  ${state.pixConfigExists ? "✓" : "→"} Pix config: ${pixConfigPath}`,
		`  ${state.toolsConfigExists ? "✓" : "→"} Tools config: ${toolsConfigPath}`,
		"",
		"Optional integrations:",
		`  ${state.webCredentialsConfigured ? "✓ Web credentials detected." : "○ Web search: use local Ollama without a key, or run /web-credentials for Ollama Cloud/Tavily."}`,
		`  ${state.context7Configured ? "✓ Context7 API key detected." : "○ Context7 docs skill: export CONTEXT7_API_KEY."}`,
		`  ${state.telegramConfigured ? "✓ Telegram terminal-bell credentials detected in the environment." : "○ Telegram bell: set terminalBell.telegram in Pix config or PI_TERMINAL_BELL_TELEGRAM_* env vars."}`,
		"  ○ Model-backed helpers: review promptEnhancer, autocomplete, and sessionTitle model refs; each provider needs its own credentials.",
		"  ○ Voice: set dictation.language in Pix config. LSP: configure and trust servers under lsp.servers in tools config.",
		"",
		"Pix never imports or overwrites credentials during install. Optional tokens remain opt-in.",
	].join("\n");
}

function formatProviderSetupStep(providerAuthConfigured: boolean, opencodeDetected: boolean): string {
	if (providerAuthConfigured) return "  ✓ Model provider credentials detected. Start Pix and use /model to choose a model.";
	if (opencodeDetected) return "  → OpenCode credentials detected. Start Pix, run /opencode-import, then /model.";
	return "  → Configure a model provider first: run `npx @earendil-works/pi-coding-agent`, use /login, then start Pix and use /model.";
}

export function pixInstallUsage(): string {
	return `Usage: pix install [--check]
       pix setup [--check]

Check and install Pix runtime helpers for this user.

It also creates non-secret Pix and pi-tools-suite config templates and prints a
credential-aware first-run checklist. It never imports credentials automatically.

What it checks:
  - ${FONT_FAMILY_NAME} icon font for Pix glyphs
  - pi CLI availability, including Pix's bundled Pi dependency
  - Linux clipboard helpers / native clipboard fallback

Options:
  --check    Only report missing helpers, do not install
  -h, --help Show this help`;
}

export function parsePixInstallArgs(argv: readonly string[]): PixInstallCliOptions {
	let checkOnly = false;
	let help = false;

	for (const arg of argv) {
		if (arg === "--check") {
			checkOnly = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			help = true;
			continue;
		}
		throw new Error(`Unknown pix install argument: ${arg}\n\n${pixInstallUsage()}`);
	}

	return { checkOnly, help };
}

export async function runPixInstallCli(argv: readonly string[] = process.argv.slice(2), context: PixInstallCliContext = {}): Promise<number> {
	let options: PixInstallCliOptions;
	try {
		options = parsePixInstallArgs(argv);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}

	if (options.help) {
		console.log(pixInstallUsage());
		return 0;
	}

	const env = context.env ?? process.env;
	let failures = 0;

	console.log("Pix install checks");

	if (await pixInstallDeps.isJetBrainsNerdFontInstalled()) {
		console.log(`✓ ${FONT_FAMILY_NAME} is installed`);
	} else if (options.checkOnly) {
		console.log(`! ${FONT_FAMILY_NAME} is missing`);
	} else {
		try {
			await pixInstallDeps.installJetBrainsNerdFont();
			console.log(`✓ Installed ${FONT_FAMILY_NAME}`);
		} catch (error) {
			console.warn(`! Failed to install optional ${FONT_FAMILY_NAME}: ${errorMessage(error)}`);
		}
	}

	const piCli = await resolvePiCliStatus(env);
	if (piCli.available) {
		console.log(`✓ pi CLI is available${piCli.detail ? ` (${piCli.detail})` : ""}`);
	} else if (options.checkOnly) {
		console.log("! pi CLI is missing");
		failures += 1;
	} else {
		try {
			await installPiCli();
			console.log("✓ Installed pi CLI globally");
		} catch (error) {
			console.error(`✗ Failed to install pi CLI: ${errorMessage(error)}`);
			console.error("  Pix can still use its bundled SDK, but sub-agent helpers may need `pi` on PATH.");
			failures += 1;
		}
	}

	if (await pixInstallDeps.clipboardSupportAvailable(env)) {
		console.log("✓ Clipboard support is available");
	} else {
		console.log(`! Clipboard support is missing. ${pixInstallDeps.clipboardInstallHint()}`);
	}

	const homeDir = context.homeDir ?? homedir();
	if (!options.checkOnly) {
		try {
			const setupFiles = ensurePixSetupFiles(homeDir);
			for (const path of setupFiles.created) console.log(`✓ Created ${path}`);
			for (const path of setupFiles.existing) console.log(`✓ Kept existing ${path}`);
		} catch (error) {
			console.error(`✗ Failed to create setup config: ${errorMessage(error)}`);
			failures += 1;
		}
	}

	console.log(formatPixInstallNextSteps(homeDir, inspectPixOnboarding(homeDir, env)));

	return failures === 0 ? 0 : 1;
}

function jsonObjectHasEntries(path: string): boolean {
	if (!pixInstallDeps.existsSync(path)) return false;
	try {
		const parsed = JSON.parse(pixInstallDeps.readFileSync(path, "utf8")) as unknown;
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length > 0;
	} catch {
		return false;
	}
}

async function resolvePiCliStatus(env: NodeJS.ProcessEnv): Promise<{ available: boolean; detail?: string }> {
	const bundledBin = env.PIX_BUNDLED_PI_BIN;
	if (bundledBin && (pixInstallDeps.existsSync(join(bundledBin, process.platform === "win32" ? "pi.cmd" : "pi")) || pixInstallDeps.existsSync(join(bundledBin, "pi")))) {
		return { available: true, detail: "bundled with Pix" };
	}
	if (commandExists("pi", env)) return { available: true, detail: "PATH" };
	return { available: false };
}

async function installPiCli(): Promise<void> {
	await runRequired("npm", ["install", "-g", "--ignore-scripts", "--min-release-age=0", "@earendil-works/pi-coding-agent"]);
}

function commandExists(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const pathValue = env.PATH ?? "";
	const dirs = pathValue.split(process.platform === "win32" ? ";" : ":").filter(Boolean);
	const names = process.platform === "win32" ? [command, `${command}.cmd`, `${command}.exe`, `${command}.bat`] : [command];
	return dirs.some((dir) => names.some((name) => pixInstallDeps.existsSync(join(dir, name))));
}

async function runRequired(command: string, args: string[]): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = pixInstallDeps.spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString("utf8")}`.slice(-800);
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(stderr.trim() || `${command} exited with code ${code ?? "unknown"}`));
		});
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
