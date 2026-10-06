import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const IDENTIFIER = "org.pix.ui-qa.macos-accessibility";
const BINARY_NAME = "macos-accessibility";
const uid = process.getuid?.();

function statIfPresent(entry) {
	try { return fs.lstatSync(entry); }
	catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

function owned(stat) { return uid === undefined || stat.uid === uid; }

function privateDirectory(directory, requirePrivate = true, create = true) {
	if (!statIfPresent(directory) && create) {
		try { fs.mkdirSync(directory, { mode: 0o700 }); }
		catch (error) { if (error.code !== "EEXIST") throw error; }
		// Another process may have created it before our mkdir. Always recheck
		// its type, owner and mode rather than treating EEXIST as proof of safety.
	}
	const stat = fs.lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat) || (requirePrivate && (stat.mode & 0o077) !== 0)) {
		throw new Error(`macOS helper cache directory must be an owned ${requirePrivate ? "private " : ""}real directory: ${directory}`);
	}
	return stat;
}

function regularFile(file) {
	const stat = statIfPresent(file);
	if (!stat) return false;
	if (stat.isSymbolicLink() || !stat.isFile() || !owned(stat) || (stat.mode & 0o077) !== 0) {
		throw new Error(`macOS helper cache entry must be an owned private regular file: ${file}`);
	}
	return true;
}

function installationDirectory(homeDirectory) {
	const home = path.resolve(homeDirectory);
	// Reject symlinks even in ancestors; do not chmod the account home or
	// existing Library/Application Support directories.
	let ancestor = home;
	while (true) {
		const stat = fs.lstatSync(ancestor);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`macOS helper home must use real directories: ${ancestor}`);
		const parent = path.dirname(ancestor);
		if (parent === ancestor) break;
		ancestor = parent;
	}
	privateDirectory(home, false, false);
	let directory = home;
	for (const [component, privateMode] of [["Library", false], ["Application Support", false], ["Pix", true], ["ui-qa", true], ["helpers", true]]) {
		directory = path.join(directory, component);
		privateDirectory(directory, privateMode);
	}
	return directory;
}

async function checkedRun(run, command, args, options) {
	const result = await run(command, args, options);
	if (result.code !== 0) throw new Error(result.stderr || `${command} exited ${result.code}`);
	return result;
}

// Shared by all projects using this OS account. Recent empty locks may still
// be acquiring their owner record; old locks are reclaimed only for dead PIDs.
async function withBuildLock(lock, deadline, work) {
	let acquired;
	while (true) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for macOS helper build lock");
		try {
			fs.mkdirSync(lock, { mode: 0o700 });
			acquired = fs.lstatSync(lock);
			try { fs.writeFileSync(path.join(lock, "pid"), `${process.pid}\n`, { flag: "wx", mode: 0o600 }); }
			catch (error) { fs.rmSync(lock, { recursive: true }); throw error; }
			break;
		}
		catch (error) { if (error.code !== "EEXIST") throw error; }
		try {
			const stat = privateDirectory(lock, true, false);
			const owner = path.join(lock, "pid");
			const hasOwner = regularFile(owner);
			if (Date.now() - stat.mtimeMs > 180_000) {
				const pid = hasOwner ? Number(fs.readFileSync(owner, "utf8")) : undefined;
				if (pid !== undefined && (!Number.isSafeInteger(pid) || pid <= 0)) throw new Error("invalid macOS helper build lock owner");
				let dead = pid === undefined;
				if (pid !== undefined) {
					try { process.kill(pid, 0); }
					catch (error) { if (error.code === "ESRCH") dead = true; else if (error.code !== "EPERM") throw error; }
				}
				if (dead && fs.lstatSync(lock).ino === stat.ino) {
					// Remove only the known owner entry, never arbitrary contents.
					if (hasOwner) fs.unlinkSync(owner);
					// A competing reclaimer may already have removed/replaced it.
					if (statIfPresent(lock)?.ino === stat.ino) {
						try { fs.rmdirSync(lock); } catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error; }
					}
					continue;
				}
			}
		} catch (error) { if (error.code !== "ENOENT") throw error; }
		await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
	}
	try { return await work(); }
	finally {
		const stat = statIfPresent(lock);
		if (stat?.ino === acquired.ino) fs.rmSync(lock, { recursive: true });
	}
}

function legacyCandidate(projectRoot, expectedStamp) {
	const helpers = path.join(projectRoot, ".pi", "ui-qa", "helpers");
	try {
		privateDirectory(projectRoot, false, false);
		privateDirectory(path.join(projectRoot, ".pi"), false, false);
		privateDirectory(path.join(projectRoot, ".pi", "ui-qa"), true, false);
		privateDirectory(helpers, true, false);
		const binary = path.join(helpers, BINARY_NAME);
		if (regularFile(binary) && regularFile(`${binary}.sha256`) && fs.readFileSync(`${binary}.sha256`, "utf8") === expectedStamp) return binary;
	} catch { /* Unsafe or missing legacy caches are not migration candidates. */ }
	return undefined;
}

// Atomically replace the executable. Keep a hard-linked copy of the prior
// executable so a failed sidecar publication can roll back without recompiling.
function publish(temporary, temporaryStamp, binary, stamp, current) {
	const backup = `${temporary}.previous`;
	if (current) fs.linkSync(binary, backup);
	let replaced = false;
	let keepBackup = false;
	try {
		fs.renameSync(temporary, binary);
		replaced = true;
		fs.renameSync(temporaryStamp, stamp);
	} catch (error) {
		if (replaced) {
			try { if (current) fs.renameSync(backup, binary); else fs.unlinkSync(binary); }
			catch (rollbackError) { keepBackup = true; throw new AggregateError([error, rollbackError], `macOS helper publication rollback failed; previous executable retained at ${backup}`); }
		}
		throw error;
	} finally { if (!keepBackup) fs.rmSync(backup, { force: true }); }
}

// homeDirectory is an explicit test seam, never an environment/executable
// override. userInfo avoids QA launches' synthetic HOME changing the TCC path.
export async function prepareMacosHelper({ projectRoot, source, deadline, run, signingIdentity = process.env.PI_UI_QA_MACOS_CODESIGN_IDENTITY, homeDirectory = os.userInfo().homedir }) {
	const helpers = installationDirectory(homeDirectory);
	const binary = path.join(helpers, BINARY_NAME);
	const stamp = `${binary}.sha256`;
	const lock = `${binary}.lock`;
	const digest = createHash("sha256").update(fs.readFileSync(source)).digest("hex");
	if (signingIdentity !== undefined && (typeof signingIdentity !== "string" || signingIdentity.length > 160 || /[\x00-\x1f\x7f]/.test(signingIdentity))) {
		throw new Error("PI_UI_QA_MACOS_CODESIGN_IDENTITY must be a valid keychain signing identity name or SHA-1 hash");
	}
	const signer = signingIdentity || "-";
	const expectedStamp = `${digest}\n${signer === "-" ? "adhoc" : signer}\n`;
	const verify = (file) => checkedRun(run, "codesign", ["--verify", "--strict", "--test-requirement", `=identifier "${IDENTIFIER}"`, file], { cwd: projectRoot, timeoutMs: Math.max(1, deadline - Date.now()) });
	return withBuildLock(lock, deadline, async () => {
		const current = regularFile(binary);
		const hasStamp = regularFile(stamp);
		if (current && hasStamp && fs.readFileSync(stamp, "utf8") === expectedStamp) {
			await verify(binary);
			return binary;
		}
		const temporary = path.join(helpers, `.${BINARY_NAME}.${randomUUID()}.tmp`);
		const temporaryStamp = `${temporary}.sha256`;
		try {
			const legacy = !current && !hasStamp ? legacyCandidate(projectRoot, expectedStamp) : undefined;
			let migrated = false;
			if (legacy) {
				try {
					fs.copyFileSync(legacy, temporary, fs.constants.COPYFILE_EXCL);
					fs.chmodSync(temporary, 0o700);
					await verify(temporary);
					migrated = true;
				} catch { fs.rmSync(temporary, { force: true }); }
			}
			if (!migrated) {
				await checkedRun(run, "xcrun", ["swiftc", "-O", source, "-o", temporary], {
					cwd: projectRoot, timeoutMs: Math.max(1, Math.min(60_000, deadline - Date.now())),
				});
				const compiled = fs.lstatSync(temporary);
				if (!compiled.isFile() || compiled.isSymbolicLink() || !owned(compiled)) throw new Error("macOS helper compiler output must be an owned regular file");
				fs.chmodSync(temporary, 0o700);
				regularFile(temporary);
				await checkedRun(run, "codesign", ["--force", "--sign", signer, "--identifier", IDENTIFIER, temporary], {
					cwd: projectRoot, timeoutMs: Math.max(1, deadline - Date.now()),
				});
				await verify(temporary);
			}
			fs.writeFileSync(temporaryStamp, expectedStamp, { flag: "wx", mode: 0o600 });
			publish(temporary, temporaryStamp, binary, stamp, current);
			return binary;
		} finally {
			fs.rmSync(temporary, { force: true });
			fs.rmSync(temporaryStamp, { force: true });
		}
	});
}
