import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";

import { x as extractTar } from "tar";
import * as yauzl from "yauzl";

import {
	fetchLatestStableRelease,
	PIX_RELEASE_TARGETS,
	readReleaseInstallInfo,
	type GitHubReleaseAsset,
	type StableGitHubRelease,
} from "./release-update.js";
import type { PortableUpdateSwap } from "./portable-update-helper.js";

const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 4 * 1024 * 1024;

export type PortableUpdateResult = {
	version: string;
	assetName: string;
};

export function portableTuiAssetName(version: string, target: string): string {
	if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error(`Invalid release version: ${version}`);
	if (!PIX_RELEASE_TARGETS.includes(target as typeof PIX_RELEASE_TARGETS[number])) throw new Error(`Invalid release target: ${target}`);
	return `pix-tui-${version}-${target}.${target.startsWith("windows-") ? "zip" : "tar.gz"}`;
}

export function parseSha256Sums(text: string, assetName: string): string {
	const matches = text.split(/\r?\n/u).flatMap((line): string[] => {
		const match = /^([a-f0-9]{64})\s+\*?(.+)$/u.exec(line);
		return match?.[2] === assetName ? [match[1]!] : [];
	});
	if (matches.length !== 1) throw new Error(`Missing or ambiguous SHA256SUMS entry for ${assetName}`);
	return matches[0]!;
}

export function portableReleaseAssets(release: StableGitHubRelease, target: string): { archive: GitHubReleaseAsset; checksums: GitHubReleaseAsset } {
	const archiveName = portableTuiAssetName(release.version, target);
	const exact = (name: string): GitHubReleaseAsset => {
		const matches = release.assets.filter((asset) => asset.name === name);
		if (matches.length !== 1) throw new Error(`Release ${release.tag} must contain exactly one ${name}`);
		return matches[0]!;
	};
	return { archive: exact(archiveName), checksums: exact("SHA256SUMS") };
}

async function download(url: string, destination: string, limit: number, expectedSize?: number): Promise<void> {
	if (expectedSize !== undefined && expectedSize > limit) throw new Error(`Release asset exceeds ${limit} bytes`);
	const response = await fetch(url, {
		headers: { accept: "application/octet-stream", "User-Agent": "pix-portable-updater" },
		signal: AbortSignal.timeout(5 * 60_000),
	});
	if (!response.ok || !response.body) throw new Error(`Release asset download failed (${response.status})`);
	let received = 0;
	const limiter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			received += chunk.length;
			if (received > limit) callback(new Error(`Release asset exceeds ${limit} bytes`));
			else callback(null, chunk);
		},
	});
	await pipeline(response.body, limiter, createWriteStream(destination, { flags: "wx" }));
	if (expectedSize !== undefined && received !== expectedSize) throw new Error(`Release asset size mismatch: expected ${expectedSize}, got ${received}`);
}

async function sha256(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

export function safeZipEntryPath(root: string, name: string): string {
	if (!name || name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/u.test(name)) {
		throw new Error(`Unsafe ZIP entry: ${name}`);
	}
	const parts = name.split("/").filter(Boolean);
	if (parts.some((part) => part === "." || part === "..")) throw new Error(`Unsafe ZIP entry: ${name}`);
	const path = resolve(root, ...parts);
	const rel = relative(root, path);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		if (name.endsWith("/") && !rel) return root;
		throw new Error(`Unsafe ZIP entry: ${name}`);
	}
	return path;
}

function zipMode(entry: yauzl.Entry): number {
	return (entry.externalFileAttributes >>> 16) & 0xffff;
}

async function extractZip(archive: string, destination: string): Promise<void> {
	const zip = await new Promise<yauzl.ZipFile>((resolvePromise, reject) => {
		yauzl.open(archive, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, value) => {
			if (error) reject(error);
			else resolvePromise(value);
		});
	});
	await new Promise<void>((resolvePromise, reject) => {
		let settled = false;
		const finish = (error?: unknown) => {
			if (settled) return;
			settled = true;
			zip.close();
			error ? reject(error) : resolvePromise();
		};
		zip.on("error", finish);
		zip.on("end", () => finish());
		zip.on("entry", (entry: yauzl.Entry) => {
			void (async () => {
				const path = safeZipEntryPath(destination, entry.fileName);
				const mode = zipMode(entry);
				const kind = mode & 0o170000;
				if (kind === 0o120000) throw new Error(`ZIP symlinks are not allowed in Pix portable updates: ${entry.fileName}`);
				if (entry.fileName.endsWith("/")) {
					await mkdir(path, { recursive: true });
					zip.readEntry();
					return;
				}
				if (kind !== 0 && kind !== 0o100000) throw new Error(`Unsupported ZIP entry type: ${entry.fileName}`);
				await mkdir(dirname(path), { recursive: true });
				const stream = await new Promise<NodeJS.ReadableStream>((resolveStream, rejectStream) => {
					zip.openReadStream(entry, (error, value) => error ? rejectStream(error) : resolveStream(value));
				});
				await pipeline(stream, createWriteStream(path, { flags: "wx", mode: mode & 0o777 || 0o644 }));
				zip.readEntry();
			})().catch(finish);
		});
		zip.readEntry();
	});
}

function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function validatePortableLinks(root: string, directory = root): Promise<void> {
	const { readdir } = await import("node:fs/promises");
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		const stat = await lstat(path);
		if (stat.isSymbolicLink()) {
			const destination = resolve(dirname(path), await readlink(path));
			if (!inside(root, destination) || !inside(root, await realpath(destination))) throw new Error(`Portable update contains an external link: ${relative(root, path)}`);
		} else if (stat.isDirectory()) {
			await validatePortableLinks(root, path);
		}
	}
}

export async function validateStagedPortableTui(root: string, version: string, target: string): Promise<void> {
	const manifest = JSON.parse(await readFile(join(root, "release.json"), "utf8")) as Record<string, unknown>;
	if (manifest.format !== 2 || manifest.variant !== "tui" || manifest.version !== version || manifest.target !== target) {
		throw new Error("Downloaded Pix release manifest does not match the requested TUI update");
	}
	const marker = JSON.parse(await readFile(join(root, "app/.pix-portable.json"), "utf8")) as Record<string, unknown>;
	if (marker.variant !== "tui" || marker.version !== version || marker.target !== target) throw new Error("Downloaded Pix portable marker is inconsistent");
	for (const path of ["app/package.json", "app/bin/pix.mjs", "verify.mjs", process.platform === "win32" ? "runtime/node.exe" : "runtime/node"]) {
		const stat = await lstat(join(root, path));
		if (!stat.isFile()) throw new Error(`Downloaded Pix release is missing ${path}`);
	}
	await validatePortableLinks(root);
}

function verificationEnvironment(home: string, runtime: string): NodeJS.ProcessEnv {
	const allowed = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined
		&& /^(SystemRoot|WINDIR|ComSpec|PATHEXT|TEMP|TMP|TMPDIR|LANG|LC_.*|TERM|COLORTERM|DISPLAY|WAYLAND_DISPLAY|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR|SHELL|USER|USERNAME|LOGNAME|ProgramFiles|ProgramW6432|ProgramFiles\(x86\))$/iu.test(key)));
	return {
		...allowed,
		HOME: home,
		USERPROFILE: home,
		APPDATA: join(home, "AppData/Roaming"),
		LOCALAPPDATA: join(home, "AppData/Local"),
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_CACHE_HOME: join(home, ".cache"),
		PI_CODING_AGENT_DIR: join(home, ".pi/agent"),
		PI_OFFLINE: "1",
		PIX_RELEASE_SMOKE: "1",
		PIX_SKIP_VERSION_CHECK: "1",
		PIX_ACP_LOG: "error",
		PATH: [runtime, process.env.PATH ?? ""].filter(Boolean).join(delimiter),
	};
}

async function verifyStagedPortableTui(root: string, scratch: string): Promise<void> {
	const runtime = join(root, "runtime");
	const node = join(runtime, process.platform === "win32" ? "node.exe" : "node");
	const home = join(scratch, "verify-home");
	const cwd = join(scratch, "verify-workspace");
	await mkdir(home, { recursive: true });
	await mkdir(cwd, { recursive: true });
	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn(node, [join(root, "verify.mjs")], {
			cwd,
			env: verificationEnvironment(home, runtime),
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let output = "";
		const timer = setTimeout(() => child.kill(), 120_000);
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => output = (output + chunk).slice(-32_000));
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => output = (output + chunk).slice(-32_000));
		child.once("error", reject);
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			if (code === 0 && /PIX_RELEASE_RUNTIME_OK/u.test(output)) resolvePromise();
			else reject(new Error(`Downloaded Pix verification failed (${signal ?? code}): ${output}`));
		});
	});
}

async function extractArchive(archive: string, destination: string): Promise<void> {
	await mkdir(destination, { recursive: true });
	if (archive.endsWith(".zip")) await extractZip(archive, destination);
	else await extractTar({ file: archive, cwd: destination, strict: true, preservePaths: false });
}

export async function schedulePortableTuiUpdate(packageRoot: string, currentVersion: string, timeoutMs = 10_000): Promise<PortableUpdateResult> {
	const install = readReleaseInstallInfo(packageRoot);
	if (!install) throw new Error("Portable release marker is missing or invalid; automatic update is disabled");
	if (install.variant !== "tui") throw new Error("This is a Desktop installation; use the native Desktop updater");
	const release = await fetchLatestStableRelease(currentVersion, timeoutMs);
	if (!release) throw new Error("No stable GitHub Release is available");
	const { archive: asset, checksums } = portableReleaseAssets(release, install.target);
	const scratch = await mkdtemp(join(tmpdir(), "pix portable update "));
	let helperRoot: string | undefined;
	let stagedSibling: string | undefined;
	try {
		const archive = join(scratch, asset.name);
		const checksumFile = join(scratch, "SHA256SUMS");
		await Promise.all([
			download(asset.url, archive, MAX_ARCHIVE_BYTES, asset.size),
			download(checksums.url, checksumFile, MAX_CHECKSUM_BYTES, checksums.size),
		]);
		const expected = parseSha256Sums(await readFile(checksumFile, "utf8"), asset.name);
		const actual = await sha256(archive);
		if (actual !== expected) throw new Error(`Downloaded Pix checksum mismatch for ${asset.name}`);

		const extraction = join(scratch, "extracted");
		await extractArchive(archive, extraction);
		const staged = join(extraction, "pix");
		await validateStagedPortableTui(staged, release.version, install.target);
		await verifyStagedPortableTui(staged, scratch);

		const realPackageRoot = await realpath(packageRoot);
		const installRoot = dirname(realPackageRoot);
		if (inside(installRoot, resolve(process.cwd()))) {
			throw new Error("Run `pix update` from outside the Pix installation directory so it can be replaced safely after exit");
		}
		const parent = dirname(installRoot);
		const suffix = `${process.pid}-${Date.now()}`;
		stagedSibling = join(parent, `.${basename(installRoot)}.update-${suffix}`);
		const backupRoot = join(parent, `.${basename(installRoot)}.backup-${suffix}`);
		await rm(stagedSibling, { recursive: true, force: true });
		await cp(staged, stagedSibling, { recursive: true, verbatimSymlinks: true });
		await validateStagedPortableTui(stagedSibling, release.version, install.target);

		helperRoot = await mkdtemp(join(tmpdir(), "pix updater helper "));
		const nodeRelativePath = process.platform === "win32" ? "runtime/node.exe" : "runtime/node";
		const helperNode = join(helperRoot, process.platform === "win32" ? "node.exe" : "node");
		const helperScript = join(helperRoot, "portable-update-helper.js");
		const helperConfig = join(helperRoot, "update.json");
		await copyFile(join(installRoot, nodeRelativePath), helperNode);
		if (process.platform !== "win32") await chmod(helperNode, 0o755);
		await copyFile(fileURLToPath(new URL("./portable-update-helper.js", import.meta.url)), helperScript);
		const swap: PortableUpdateSwap = {
			parentPid: process.pid,
			installRoot,
			stagedRoot: stagedSibling,
			backupRoot,
			helperRoot,
			nodeRelativePath,
		};
		await writeFile(helperConfig, `${JSON.stringify(swap)}\n`, { mode: 0o600 });
		const child = spawn(helperNode, [helperScript, helperConfig], {
			cwd: helperRoot,
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
		child.unref();
		stagedSibling = undefined;
		helperRoot = undefined;
		return { version: release.version, assetName: asset.name };
	} finally {
		await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		if (stagedSibling) await rm(stagedSibling, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		if (helperRoot) await rm(helperRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
}
