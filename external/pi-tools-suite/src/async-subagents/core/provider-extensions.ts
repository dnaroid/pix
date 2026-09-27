// Provider dependency injection for isolated sub-agent children. Children run
// with `--no-extensions`, so a selected model whose provider is implemented by
// an extension must have exactly that extension injected — and nothing else.
// The catalog is an explicit allowlist: a model string can never become a
// generic code-loading primitive. Resolution happens before any child
// artifact or process exists; failures are typed and permanent (a
// synchronous spawnAgent throw is already non-retryable and never falls back).
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

export const CLAUDE_PROVIDER = "pi-claude-code-provider";
const CLAUDE_PACKAGE = "pi-claude-code-provider";
/** Exactly characterized provider versions (offline lifecycle matrix, serializer/evidence gates). */
export const SUPPORTED_CLAUDE_PROVIDER_VERSIONS: readonly string[] = ["0.5.0"];
/** Only a user-scope npm source of the provider package is ever resolved (never project/local/git). */
const CLAUDE_SOURCE_RE = /^npm:pi-claude-code-provider(?:@[0-9A-Za-z.+-]+)?$/;
const PACKAGE_SEARCH_DEPTH = 6;
const MANIFEST_MAX_BYTES = 256 * 1024;

export type ProviderExtensionErrorCode = "provider_not_installed" | "provider_metadata_invalid" | "provider_version_unsupported";

/** Permanent, non-retryable launch failure for an extension-backed provider. */
export class ProviderExtensionError extends Error {
	readonly permanent = true;
	constructor(
		readonly code: ProviderExtensionErrorCode,
		readonly model: string,
		readonly provider: string,
		readonly packageName: string,
		detail: string,
		hint: string,
	) {
		super(`${code}: model ${model} requires provider package ${packageName} (${detail}). ${hint}`.slice(0, 1_000));
		this.name = "ProviderExtensionError";
	}
}

/** Subagent default model from the environment (task/CLI selections take precedence). */
export function subagentEnvModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return (env.ASYNC_SUBAGENTS_MODEL || env.PI_SUBAGENTS_MODEL)?.trim() || undefined;
}

/** Final model: configured model, then the last `--model` override (args must be normalized). */
export function resolveFinalModel(configuredModel: string | undefined, args: readonly string[]): string | undefined {
	let model = configuredModel?.trim() || undefined;
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] === "--model") {
			model = args[index + 1]?.trim() || undefined;
			index += 1;
		}
	}
	return model;
}

function lastFlag(args: readonly string[], name: string): string | undefined {
	let value: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] === name) value = args[++index]?.trim();
	}
	return value;
}

/**
 * The single Claude-provider selection predicate shared by owned launch and
 * dependency injection, evaluated on the final model and normalized args.
 */
export function selectsClaudeProvider(finalModel: string | undefined, args: readonly string[]): boolean {
	if (lastFlag(args, "--provider") === CLAUDE_PROVIDER) return true;
	if (finalModel) return finalModel.split("/")[0] === CLAUDE_PROVIDER;
	return lastFlag(args, "--models")?.split("/")[0] === CLAUDE_PROVIDER;
}

/**
 * Normalize model/provider override spellings the child Pi CLI does not accept
 * (`--model=value`, `-m value`, `--provider=value`) into the supported
 * `--flag value` form, so dependency resolution and the child always see the
 * same final selection.
 */
export function normalizeProviderArgs(args: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-m") {
			out.push("--model");
			if (i + 1 < args.length) out.push(args[++i]);
		} else if (arg.startsWith("--model=")) out.push("--model", arg.slice("--model=".length));
		else if (arg.startsWith("--provider=")) out.push("--provider", arg.slice("--provider=".length));
		else out.push(arg);
	}
	return out;
}

interface PackageRoot { root: string; manifest: Record<string, unknown> }

function readManifest(root: string): Record<string, unknown> | undefined {
	try {
		const file = path.join(root, "package.json");
		if (fs.statSync(file).size > MANIFEST_MAX_BYTES) return undefined;
		const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

/** Nearest enclosing package root of an explicit `--extension` path (bounded walk). */
function enclosingPackage(entry: string): PackageRoot | undefined {
	let dir = path.dirname(entry);
	for (let depth = 0; depth < PACKAGE_SEARCH_DEPTH; depth++) {
		if (fs.existsSync(path.join(dir, "package.json"))) {
			const manifest = readManifest(dir);
			return manifest ? { root: dir, manifest } : undefined;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

/** Explicit extension paths exactly as the child resolves them (Pi accepts `--extension`/`-e` only; relative to the child cwd). */
function explicitExtensions(args: readonly string[], cwd: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if ((args[i] === "--extension" || args[i] === "-e") && i + 1 < args.length) out.push(path.resolve(cwd, args[++i]));
	}
	return out;
}

/**
 * Locate installed copies of the provider package. The default uses Pi's
 * public package manager for the USER scope only, and only an npm source of
 * this exact package: project settings are never consulted (an untrusted
 * repository must not be able to supply "the provider"), and no local/git
 * source is ever accepted.
 */
export type InstalledPackageLocator = (packageName: string, cwd: string) => string[];

let locatorCache: { agentDir: string; settingsMtimeMs: number; roots: string[] } | undefined;

export const defaultInstalledPackageLocator: InstalledPackageLocator = (packageName, cwd) => {
	const agentDir = getAgentDir();
	const settingsMtimeMs = fs.statSync(path.join(agentDir, "settings.json"), { throwIfNoEntry: false })?.mtimeMs ?? -1;
	// Pi's npm lookup may shell out (`npm root -g`) synchronously: reuse the
	// answer until the user settings change or a cached install disappears.
	if (locatorCache && locatorCache.agentDir === agentDir && locatorCache.settingsMtimeMs === settingsMtimeMs &&
		locatorCache.roots.every((root) => fs.existsSync(root))) return [...locatorCache.roots];
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	const roots = (settingsManager.getGlobalSettings().packages ?? [])
		.map((pkg) => (typeof pkg === "string" ? pkg : pkg.source))
		.filter((source) => CLAUDE_SOURCE_RE.test(source))
		.map((source) => manager.getInstalledPath(source, "user"))
		.filter((root): root is string => typeof root === "string" && readManifest(root)?.name === packageName);
	locatorCache = { agentDir, settingsMtimeMs, roots };
	return [...roots];
};

/** Validate the package manifest and return its single declared Pi extension entrypoint. */
function claudeEntrypoint(pkg: PackageRoot, model: string): string {
	const fail = (code: ProviderExtensionErrorCode, detail: string, hint: string) =>
		new ProviderExtensionError(code, model, CLAUDE_PROVIDER, CLAUDE_PACKAGE, detail, hint);
	if (pkg.manifest.name !== CLAUDE_PACKAGE) throw fail("provider_metadata_invalid", "package name mismatch", "Reinstall the provider package.");
	const version = pkg.manifest.version;
	if (typeof version !== "string" || !SUPPORTED_CLAUDE_PROVIDER_VERSIONS.includes(version)) {
		throw fail("provider_version_unsupported", `installed version ${String(version).slice(0, 40)}`,
			`Install exactly ${SUPPORTED_CLAUDE_PROVIDER_VERSIONS.join(" or ")}.`);
	}
	const extensions = (pkg.manifest.pi as { extensions?: unknown } | undefined)?.extensions;
	if (!Array.isArray(extensions) || extensions.length !== 1 || typeof extensions[0] !== "string") {
		throw fail("provider_metadata_invalid", "pi.extensions must declare exactly one entrypoint", "Reinstall the provider package.");
	}
	const root = fs.realpathSync(pkg.root);
	const entry = path.resolve(root, extensions[0]);
	let real: string;
	try {
		real = fs.realpathSync(entry);
	} catch {
		throw fail("provider_metadata_invalid", "declared entrypoint is missing", "Reinstall the provider package.");
	}
	if (!real.startsWith(`${root}${path.sep}`) || !fs.statSync(real).isFile()) {
		throw fail("provider_metadata_invalid", "declared entrypoint escapes the package or is not a file", "Reinstall the provider package.");
	}
	return real;
}

export interface ProviderExtensionRequest {
	/** Final model the child will run (task/env model, then CLI overrides). */
	selectedModel?: string;
	/** Model chosen explicitly by this invocation (task/CLI), excluding env defaults. */
	explicitModel?: string;
	/** Whether the final selection uses the Claude provider (same predicate as owned launch). */
	claudeSelected: boolean;
	/** Normalized forwarded child args. */
	forwardedArgs: readonly string[];
	cwd: string;
	locateInstalled?: InstalledPackageLocator;
}

/** Extension entrypoints the child must load for its selected provider (zero or more, allowlisted). */
export function resolveProviderExtensions(request: ProviderExtensionRequest): string[] {
	const out: string[] = [];
	// Antigravity: only an explicitly selected model opts in (environment/default
	// models deliberately do not), preserving the existing contract.
	const explicit = request.explicitModel;
	if (explicit?.startsWith("antigravity/") && explicit.length > "antigravity/".length) out.push(antigravityEntrypoint());
	if (request.claudeSelected) {
		const model = request.selectedModel ?? CLAUDE_PROVIDER;
		// Already supplied explicitly: it must be exactly the package's declared
		// entrypoint (validated), and is never duplicated.
		for (const extension of explicitExtensions(request.forwardedArgs, request.cwd)) {
			let located = extension;
			try { located = fs.realpathSync(extension); } catch { /* validated below */ }
			const pkg = enclosingPackage(located);
			if (pkg?.manifest.name !== CLAUDE_PACKAGE) continue;
			const entry = claudeEntrypoint(pkg, model);
			let real: string | undefined;
			try { real = fs.realpathSync(extension); } catch { /* missing */ }
			if (real !== entry) {
				throw new ProviderExtensionError("provider_metadata_invalid", model, CLAUDE_PROVIDER, CLAUDE_PACKAGE,
					"explicit --extension is not the package's declared entrypoint", "Pass the declared entrypoint or omit it.");
			}
			return out;
		}
		let roots: string[];
		try {
			roots = (request.locateInstalled ?? defaultInstalledPackageLocator)(CLAUDE_PACKAGE, request.cwd);
		} catch (error) {
			throw new ProviderExtensionError("provider_metadata_invalid", model, CLAUDE_PROVIDER, CLAUDE_PACKAGE,
				`installed-package lookup failed: ${String(error).slice(0, 200)}`, "Check the Pi package configuration.");
		}
		if (roots.length === 0) {
			throw new ProviderExtensionError("provider_not_installed", model, CLAUDE_PROVIDER, CLAUDE_PACKAGE, "no user-scope npm install configured in Pi",
				`Install it with \`pi install npm:${CLAUDE_PACKAGE}@${SUPPORTED_CLAUDE_PROVIDER_VERSIONS[0]}\`.`);
		}
		const manifest = readManifest(roots[0]);
		if (!manifest) {
			throw new ProviderExtensionError("provider_metadata_invalid", model, CLAUDE_PROVIDER, CLAUDE_PACKAGE, "unreadable package.json",
				"Reinstall the provider package.");
		}
		out.push(claudeEntrypoint({ root: roots[0], manifest }, model));
	}
	return out;
}

export function antigravityEntrypoint(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "antigravity-auth", "index.ts");
}
