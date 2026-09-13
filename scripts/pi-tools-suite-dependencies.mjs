import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEPENDENCY_STAMP = ".pix-production-dependencies.sha256";

export async function piToolsSuiteDependenciesCurrent(sourceRoot, targetRoot) {
	const dependencies = await productionDependencyNames(join(sourceRoot, "package.json"));
	if (await pathsReferToSameEntry(sourceRoot, targetRoot)) {
		return await allDependenciesPresent(targetRoot, dependencies);
	}
	const expectedHash = await dependencyManifestHash(sourceRoot);
	const stampPath = join(targetRoot, "node_modules", DEPENDENCY_STAMP);
	const currentHash = await readFile(stampPath, "utf8").catch(() => "");
	return currentHash.trim() === expectedHash && await allDependenciesPresent(targetRoot, dependencies);
}

export async function ensurePiToolsSuiteDependencies(options) {
	const sourceRoot = options.sourceRoot;
	const targetRoot = options.targetRoot;
	const runInstall = options.runInstall ?? runNpmCi;
	if (await piToolsSuiteDependenciesCurrent(sourceRoot, targetRoot)) return false;
	if (await pathsReferToSameEntry(sourceRoot, targetRoot)) {
		throw new Error(`source dependencies are missing; run npm --prefix ${sourceRoot} install`);
	}

	console.error("[sync-pi-tools-suite] installing production dependencies");
	await runInstall(targetRoot);
	const dependencies = await productionDependencyNames(join(sourceRoot, "package.json"));
	if (!(await allDependenciesPresent(targetRoot, dependencies))) {
		throw new Error("production dependency installation completed with missing direct dependencies");
	}
	const expectedHash = await dependencyManifestHash(sourceRoot);
	await mkdir(join(targetRoot, "node_modules"), { recursive: true });
	await writeFile(join(targetRoot, "node_modules", DEPENDENCY_STAMP), `${expectedHash}\n`, "utf8");
	return true;
}

export async function dependencyManifestHash(sourceRoot) {
	const hash = createHash("sha256");
	for (const name of ["package.json", "package-lock.json"]) {
		const content = await readFile(join(sourceRoot, name));
		hash.update(name);
		hash.update("\0");
		hash.update(content);
		hash.update("\0");
	}
	return hash.digest("hex");
}

async function productionDependencyNames(packagePath) {
	const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
	return Object.keys(packageJson.dependencies ?? {});
}

async function allDependenciesPresent(targetRoot, dependencies) {
	return (await Promise.all(dependencies.map(async (name) => {
		try {
			await access(join(targetRoot, "node_modules", ...name.split("/"), "package.json"));
			return true;
		} catch {
			return false;
		}
	}))).every(Boolean);
}

async function pathsReferToSameEntry(left, right) {
	try {
		return await realpath(left) === await realpath(right);
	} catch {
		return false;
	}
}

async function runNpmCi(cwd) {
	const command = process.platform === "win32" ? "npm.cmd" : "npm";
	await new Promise((resolve, reject) => {
		const child = spawn(command, ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
			cwd,
			stdio: "inherit",
			windowsHide: true,
		});
		child.once("error", reject);
		child.once("close", (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`npm ci failed (${signal ?? `exit ${code ?? "unknown"}`})`));
		});
	});
}
