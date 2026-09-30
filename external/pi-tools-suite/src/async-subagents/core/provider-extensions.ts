// Provider dependency injection for isolated sub-agent children. Children run
// with `--no-extensions`, so a selected model whose provider is implemented by
// an extension must have exactly that extension injected — and nothing else.
// The catalog is an explicit allowlist: a model string can never become a
// generic code-loading primitive. The Claude provider is the patched 0.5.0
// module vendored inside the tools suite (`src/claude-code-provider/`); its
// public standalone entrypoint is a fixed, trusted suite-relative path. No
// user or project Pi package configuration is ever consulted for it. All
// resolution happens before any child artifact or process exists; failures
// are typed and permanent (a synchronous spawnAgent throw is already
// non-retryable and never falls back).
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const CLAUDE_PROVIDER = "pi-claude-code-provider";
const CLAUDE_PACKAGE = "pi-claude-code-provider";
/** Exactly characterized provider versions (offline lifecycle matrix, serializer/evidence gates). */
export const SUPPORTED_CLAUDE_PROVIDER_VERSIONS: readonly string[] = ["0.5.0"];
const PACKAGE_SEARCH_DEPTH = 6;
const MANIFEST_MAX_BYTES = 256 * 1024;
/** Trusted vendored module root: `<suite>/src/claude-code-provider`. */
const CLAUDE_LOCAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "claude-code-provider");
/** Public standalone entry file inside the vendored module (reexports `extensions/index.ts`). */
const CLAUDE_STANDALONE_ENTRY = "index.ts";

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
	try { if (fs.statSync(entry).isDirectory()) dir = entry; } catch { /* inspect the nearest existing parent */ }
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

/** Vendored suite-local Claude provider module root (trusted path; validated during resolution). */
export function claudeProviderLocalRoot(): string {
	return CLAUDE_LOCAL_ROOT;
}

export interface ClaudeProviderModule {
	/** Realpath of the vendored module root. */
	root: string;
	/** Manifest-declared Pi extension entrypoint (realpath, inside the module). */
	entry: string;
	/** Public standalone entrypoint (realpath, inside the module). */
	standalone: string;
}

/**
 * Resolve and validate the vendored Claude provider module and its public
 * standalone entrypoint. This is a fixed suite-relative path, never a
 * package-manager lookup: user or project package sources cannot influence
 * which provider code children load.
 */
export function localClaudeProviderModule(model: string): ClaudeProviderModule {
	const fail = (code: ProviderExtensionErrorCode, detail: string, hint: string) =>
		new ProviderExtensionError(code, model, CLAUDE_PROVIDER, CLAUDE_PACKAGE, detail, hint);
	const manifest = readManifest(CLAUDE_LOCAL_ROOT);
	if (!manifest) {
		throw fail("provider_not_installed", "vendored provider module missing or unreadable under src/claude-code-provider",
			"Restore the vendored provider module in the tools suite.");
	}
	const entry = claudeEntrypoint({ root: CLAUDE_LOCAL_ROOT, manifest }, model);
	const root = fs.realpathSync(CLAUDE_LOCAL_ROOT);
	let standalone: string;
	try {
		standalone = fs.realpathSync(path.join(CLAUDE_LOCAL_ROOT, CLAUDE_STANDALONE_ENTRY));
	} catch {
		throw fail("provider_metadata_invalid", "standalone entrypoint is missing", "Restore the vendored provider module in the tools suite.");
	}
	if (!standalone.startsWith(`${root}${path.sep}`) || !fs.statSync(standalone).isFile()) {
		throw fail("provider_metadata_invalid", "standalone entrypoint escapes the module or is not a file", "Restore the vendored provider module in the tools suite.");
	}
	return { root, entry, standalone };
}

/**
 * Validate the package manifest and return its single declared Pi extension entrypoint.
 */
function claudeEntrypoint(pkg: PackageRoot, model: string): string {
	const fail = (code: ProviderExtensionErrorCode, detail: string, hint: string) =>
		new ProviderExtensionError(code, model, CLAUDE_PROVIDER, CLAUDE_PACKAGE, detail, hint);
	if (pkg.manifest.name !== CLAUDE_PACKAGE) throw fail("provider_metadata_invalid", "package name mismatch", "Restore the suite-local Claude provider module.");
	const version = pkg.manifest.version;
	if (typeof version !== "string" || !SUPPORTED_CLAUDE_PROVIDER_VERSIONS.includes(version)) {
		throw fail("provider_version_unsupported", `installed version ${String(version).slice(0, 40)}`,
			`Restore the suite-local module based on ${SUPPORTED_CLAUDE_PROVIDER_VERSIONS.join(" or ")}.`);
	}
	const extensions = (pkg.manifest.pi as { extensions?: unknown } | undefined)?.extensions;
	if (!Array.isArray(extensions) || extensions.length !== 1 || typeof extensions[0] !== "string") {
		throw fail("provider_metadata_invalid", "pi.extensions must declare exactly one entrypoint", "Restore the suite-local Claude provider module.");
	}
	const root = fs.realpathSync(pkg.root);
	const entry = path.resolve(root, extensions[0]);
	let real: string;
	try {
		real = fs.realpathSync(entry);
	} catch {
		throw fail("provider_metadata_invalid", "declared entrypoint is missing", "Restore the suite-local Claude provider module.");
	}
	if (!real.startsWith(`${root}${path.sep}`) || !fs.statSync(real).isFile()) {
		throw fail("provider_metadata_invalid", "declared entrypoint escapes the package or is not a file", "Restore the suite-local Claude provider module.");
	}
	return real;
}

/**
 * Test seam replacing the trusted local module with explicit package roots
 * (staged copies/stubs). Production code never supplies it.
 */
export type InstalledPackageLocator = (packageName: string, cwd: string) => string[];

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
		const seam = request.locateInstalled;
		let suppliedEntry: string | undefined;
		// Already supplied explicitly: the vendored module accepts exactly its
		// public standalone entry (or the declared entrypoint it reexports) and
		// never duplicates it.
		for (const extension of explicitExtensions(request.forwardedArgs, request.cwd)) {
			let real: string | undefined;
			try { real = fs.realpathSync(extension); } catch { /* validated below */ }
			const pkg = enclosingPackage(real ?? extension);
			if (pkg?.manifest.name !== CLAUDE_PACKAGE) continue;
			if (seam) {
				// Seam-provided packages (staged copies/stubs) keep the historical
				// contract: the explicit path must be exactly the package's
				// declared entrypoint.
				const entry = claudeEntrypoint(pkg, model);
				if (real !== entry) {
					throw new ProviderExtensionError("provider_metadata_invalid", model, CLAUDE_PROVIDER, CLAUDE_PACKAGE,
						"explicit --extension is not the package's declared entrypoint", "Pass the declared entrypoint or omit it.");
				}
				if (suppliedEntry && suppliedEntry !== entry) {
					throw new ProviderExtensionError("provider_metadata_invalid", model, CLAUDE_PROVIDER, CLAUDE_PACKAGE,
						"multiple explicit provider entrypoints", "Pass only one provider extension.");
				}
				suppliedEntry = entry;
				continue;
			}
			let localRoot: string | undefined;
			try { localRoot = fs.realpathSync(CLAUDE_LOCAL_ROOT); } catch { /* missing module: the typed error below still identifies the path */ }
			if (localRoot && real?.startsWith(`${localRoot}${path.sep}`)) {
				const local = localClaudeProviderModule(model);
				if (real === local.standalone || real === local.entry) {
					if (suppliedEntry && suppliedEntry !== real) {
						throw new ProviderExtensionError("provider_metadata_invalid", model, CLAUDE_PROVIDER, CLAUDE_PACKAGE,
							"multiple explicit provider entrypoints", "Pass only one provider extension.");
					}
					suppliedEntry = real;
					continue;
				}
				throw new ProviderExtensionError("provider_metadata_invalid", model, CLAUDE_PROVIDER, CLAUDE_PACKAGE,
					"explicit --extension is not the module's standalone entrypoint", `Pass ${CLAUDE_STANDALONE_ENTRY} of the vendored module or omit it.`);
			}
			// Any other copy of the provider package (e.g. an old npm install)
			// would register the provider a second time next to the injected
			// vendored module, or silently downgrade to the unpatched release.
			throw new ProviderExtensionError("provider_metadata_invalid", model, CLAUDE_PROVIDER, CLAUDE_PACKAGE,
				"explicit --extension names another pi-claude-code-provider package; the vendored local module is injected instead",
				"Remove the explicit --extension.");
		}
		if (suppliedEntry) return out;
		if (seam) {
			let roots: string[];
			try {
				roots = seam(CLAUDE_PACKAGE, request.cwd);
			} catch (error) {
				throw new ProviderExtensionError("provider_metadata_invalid", model, CLAUDE_PROVIDER, CLAUDE_PACKAGE,
					`installed-package lookup failed: ${String(error).slice(0, 200)}`, "Check the Pi package configuration.");
			}
			if (roots.length === 0) {
				throw new ProviderExtensionError("provider_not_installed", model, CLAUDE_PROVIDER, CLAUDE_PACKAGE, "no user-scope npm install configured in Pi",
					"Provide a valid test fixture or restore the suite-local Claude provider module.");
			}
			const manifest = readManifest(roots[0]);
			if (!manifest) {
				throw new ProviderExtensionError("provider_metadata_invalid", model, CLAUDE_PROVIDER, CLAUDE_PACKAGE, "unreadable package.json",
					"Provide a valid provider test fixture.");
			}
			out.push(claudeEntrypoint({ root: roots[0], manifest }, model));
			return out;
		}
		out.push(localClaudeProviderModule(model).standalone);
	}
	return out;
}

export function antigravityEntrypoint(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "antigravity-auth", "index.ts");
}
