import { RegistryExecutor } from "./context.js";
import { loadRegistryConfig } from "./config-reader.js";
import { pathExists, projectArtifactRelativePaths, projectKeyFromGitRemote, registryResourceRelativePath, validateName } from "./paths.js";
import { ProjectArtifact, RegistryRuntime, ResourceType } from "./model.js";
import { dirname, join } from "node:path";
import { promises as fs } from "node:fs";

export async function runGit(
	executor: RegistryExecutor,
	cwd: string,
	args: string[],
	options: { allowFailure?: boolean; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
	const result = await executor.exec("git", args, { cwd, timeout: options.timeout ?? 120_000 });
	const code = result.code ?? 0;
	const stdout = result.stdout ?? "";
	const stderr = result.stderr ?? "";
	if (code !== 0 && !options.allowFailure) {
		throw new Error(stderr.trim() || stdout.trim() || `git ${args[0] ?? "command"} failed with exit code ${code}`);
	}
	return { stdout, stderr, code };
}

export async function resolveProjectKey(executor: RegistryExecutor, cwd: string): Promise<string> {
	const configured = loadRegistryConfig(cwd).projectKey?.trim();
	if (configured) {
		validateName(configured);
		return configured;
	}
	const origin = (await runGit(executor, cwd, ["remote", "get-url", "origin"], { allowFailure: true })).stdout.trim();
	const derived = projectKeyFromGitRemote(origin);
	if (derived) return derived;
	throw new Error(
		`Project state needs a registry key. Git origin can provide one automatically; otherwise set a project key in Desktop Registry.`,
	);
}

export async function gitRefExists(executor: RegistryExecutor, cwd: string, ref: string): Promise<boolean> {
	return (await runGit(executor, cwd, ["rev-parse", "--verify", "--quiet", ref], { allowFailure: true })).code === 0;
}

export async function ensureRegistryCache(executor: RegistryExecutor, runtime: RegistryRuntime): Promise<void> {
	const gitDir = join(runtime.cacheDir, ".git");
	if (await pathExists(gitDir)) {
		const currentRemote = (await runGit(executor, runtime.cacheDir, ["remote", "get-url", "origin"], { allowFailure: true })).stdout.trim();
		if (currentRemote !== runtime.remote) await fs.rm(runtime.cacheDir, { recursive: true, force: true });
	} else if (await pathExists(runtime.cacheDir)) {
		await fs.rm(runtime.cacheDir, { recursive: true, force: true });
	}

	if (!(await pathExists(gitDir))) {
		await fs.mkdir(dirname(runtime.cacheDir), { recursive: true });
		// --config applies during the clone's own initial checkout and persists in
		// the new repository, keeping the cache working tree byte-faithful on
		// platforms whose global git config enables core.autocrlf (e.g. Windows).
		await runGit(executor, dirname(runtime.cacheDir), [
			"clone",
			"--origin",
			"origin",
			"--config",
			"core.autocrlf=false",
			runtime.remote,
			runtime.cacheDir,
		], { timeout: 180_000 });
	}
	// Caches cloned by older versions lack the local override; re-assert it so
	// reset/checkout/add below never smudge line endings on such platforms.
	await runGit(executor, runtime.cacheDir, ["config", "core.autocrlf", "false"]);

	await runGit(executor, runtime.cacheDir, ["reset", "--hard"], { allowFailure: true });
	await runGit(executor, runtime.cacheDir, ["clean", "-fd"]);
	await runGit(executor, runtime.cacheDir, ["fetch", "origin", "--prune"], { timeout: 180_000 });

	const remoteRef = `refs/remotes/origin/${runtime.branch}`;
	if (await gitRefExists(executor, runtime.cacheDir, remoteRef)) {
		await runGit(executor, runtime.cacheDir, ["checkout", "-B", runtime.branch, `origin/${runtime.branch}`]);
		return;
	}

	if (await gitRefExists(executor, runtime.cacheDir, "HEAD")) {
		throw new Error(`Registry branch "${runtime.branch}" does not exist on ${runtime.remote}. Configure the correct branch.`);
	}

	const currentBranch = (await runGit(executor, runtime.cacheDir, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true })).stdout.trim();
	if (currentBranch !== runtime.branch) {
		await runGit(executor, runtime.cacheDir, ["checkout", "--orphan", runtime.branch]);
	}
}

export async function pathRevision(executor: RegistryExecutor, runtime: RegistryRuntime, rel: string): Promise<string | undefined> {
	const result = await runGit(executor, runtime.cacheDir, ["log", "-1", "--format=%H", "--", rel], { allowFailure: true });
	const revision = result.stdout.trim();
	return revision || undefined;
}

export async function projectArtifactRevision(
	executor: RegistryExecutor,
	runtime: RegistryRuntime,
	projectKey: string,
	artifact: ProjectArtifact,
): Promise<string | undefined> {
	const result = await runGit(
		executor,
		runtime.cacheDir,
		["log", "-1", "--format=%H", "--", ...projectArtifactRelativePaths(projectKey, artifact)],
		{ allowFailure: true },
	);
	const revision = result.stdout.trim();
	return revision || undefined;
}

export async function resourceRevision(executor: RegistryExecutor, runtime: RegistryRuntime, type: ResourceType, name: string): Promise<string | undefined> {
	if (type === "skill") return pathRevision(executor, runtime, registryResourceRelativePath(type, name, runtime));
	const file = registryResourceRelativePath(type, name, runtime);
	const paths = type === "agent" ? [file, file.slice(0, -3)] : [file];
	const result = await runGit(executor, runtime.cacheDir, ["log", "-1", "--format=%H", "--", ...paths], { allowFailure: true });
	return result.stdout.trim() || undefined;
}
