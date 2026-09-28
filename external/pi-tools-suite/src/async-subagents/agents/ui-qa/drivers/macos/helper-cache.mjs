import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const IDENTIFIER = "org.pix.ui-qa.macos-accessibility";
const BINARY_NAME = "macos-accessibility";

function privateDirectory(directory, requirePrivate = true) {
	if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
	const stat = fs.lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink() || (requirePrivate && (stat.mode & 0o077) !== 0)) {
		throw new Error(`macOS helper cache directory must be a private real directory: ${directory}`);
	}
}

function regularFile(file) {
	if (!fs.existsSync(file)) return false;
	const stat = fs.lstatSync(file);
	if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`macOS helper cache entry must be a regular file: ${file}`);
	return true;
}

async function checkedRun(run, command, args, options) {
	const result = await run(command, args, options);
	if (result.code !== 0) throw new Error(result.stderr || `${command} exited ${result.code}`);
	return result;
}

// The lock covers both the binary and its digest sidecar. It prevents two
// runners from publishing different builds to the same TCC client path.
async function withBuildLock(lock, deadline, work) {
	while (true) {
		try {
			fs.mkdirSync(lock, { mode: 0o700 });
			try { fs.writeFileSync(path.join(lock, "pid"), `${process.pid}\n`, { mode: 0o600 }); }
			catch (error) { fs.rmdirSync(lock); throw error; }
			break;
		}
		catch (error) { if (error.code !== "EEXIST") throw error; }
		// Reclaim only a long-abandoned lock from a process that no longer
		// exists; a recent empty lock may still be acquiring its owner record.
		try {
			const stat = fs.lstatSync(lock);
			if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("macOS helper build lock must be a real directory");
			if (Date.now() - stat.mtimeMs > 180_000) {
				let pid;
				try { pid = Number(fs.readFileSync(path.join(lock, "pid"), "utf8")); }
				catch (error) { if (error.code !== "ENOENT") throw error; }
				if (pid === undefined) { fs.rmdirSync(lock); continue; }
				if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid macOS helper build lock owner");
				try { process.kill(pid, 0); } catch (error) {
					if (error.code === "ESRCH") fs.rmSync(lock, { recursive: true });
				}
			}
		} catch (error) { if (error.code !== "ENOENT") throw error; }
		if (Date.now() >= deadline) throw new Error("timed out waiting for macOS helper build lock");
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	try { return await work(); }
	finally { fs.rmSync(lock, { recursive: true }); }
}

// projectRoot/.pi/ui-qa is deliberately independent of the per-agent workspace.
// A non-ad-hoc signing certificate (when configured) gives the same designated
// requirement on updates; ad-hoc signing only preserves grants for unchanged code.
export async function prepareMacosHelper({ projectRoot, source, deadline, run, signingIdentity = process.env.PI_UI_QA_MACOS_CODESIGN_IDENTITY }) {
	const pi = path.join(projectRoot, ".pi");
	const cache = path.join(pi, "ui-qa");
	const helpers = path.join(cache, "helpers");
	privateDirectory(pi, false);
	for (const directory of [cache, helpers]) privateDirectory(directory);
	const binary = path.join(helpers, BINARY_NAME);
	const stamp = `${binary}.sha256`;
	const lock = `${binary}.lock`;
	const digest = createHash("sha256").update(fs.readFileSync(source)).digest("hex");
	if (signingIdentity !== undefined && (typeof signingIdentity !== "string" || signingIdentity.length > 160 || /[\x00-\x1f\x7f]/.test(signingIdentity))) {
		throw new Error("PI_UI_QA_MACOS_CODESIGN_IDENTITY must be a valid keychain signing identity name or SHA-1 hash");
	}
	const signer = signingIdentity || "-";
	return withBuildLock(lock, deadline, async () => {
		const current = regularFile(binary);
		const hasStamp = regularFile(stamp);
		const expectedStamp = `${digest}\n${signer === "-" ? "adhoc" : signer}\n`;
		if (current && hasStamp && fs.readFileSync(stamp, "utf8") === expectedStamp) {
			await checkedRun(run, "codesign", ["--verify", "--strict", "--test-requirement", `=identifier "${IDENTIFIER}"`, binary], { cwd: projectRoot, timeoutMs: Math.max(1, deadline - Date.now()) });
			return binary;
		}
		const temporary = path.join(helpers, `.${BINARY_NAME}.${randomUUID()}.tmp`);
		const temporaryStamp = `${temporary}.sha256`;
		try {
			await checkedRun(run, "xcrun", ["swiftc", "-O", source, "-o", temporary], {
				cwd: projectRoot, timeoutMs: Math.max(1, Math.min(60_000, deadline - Date.now())),
			});
			fs.chmodSync(temporary, 0o700);
			await checkedRun(run, "codesign", ["--force", "--sign", signer, "--identifier", IDENTIFIER, temporary], {
				cwd: projectRoot, timeoutMs: Math.max(1, deadline - Date.now()),
			});
			await checkedRun(run, "codesign", ["--verify", "--strict", "--test-requirement", `=identifier "${IDENTIFIER}"`, temporary], {
				cwd: projectRoot, timeoutMs: Math.max(1, deadline - Date.now()),
			});
			fs.writeFileSync(temporaryStamp, expectedStamp, { flag: "wx", mode: 0o600 });
			// A failed build leaves the old binary intact; an interrupted
			// two-file publication rebuilds on the next run.
			fs.renameSync(temporary, binary);
			fs.renameSync(temporaryStamp, stamp);
			return binary;
		} finally {
			fs.rmSync(temporary, { force: true });
			fs.rmSync(temporaryStamp, { force: true });
		}
	});
}
