import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareMacosHelper } from "../../src/async-subagents/agents/ui-qa/drivers/macos/helper-cache.mjs";

// The macOS helper cache enforces POSIX-only invariants (owned private real
// directories via mode bits, symlink rejection, codesign/xcrun artifacts);
// Windows cannot express them, so this storage suite is skipped on win32.

const artifacts = path.resolve(import.meta.dir, "../../../../.pi/artifacts");
fs.mkdirSync(artifacts, { recursive: true });
function fixture() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(artifacts, "helper-storage-")));
	const homeDirectory = path.join(root, "home");
	const projectRoot = path.join(root, "project-a");
	const otherProject = path.join(root, "project-b");
	for (const dir of [homeDirectory, projectRoot, otherProject]) fs.mkdirSync(dir, { mode: 0o700 });
	const source = path.join(root, "helper.swift");
	fs.writeFileSync(source, "v1");
	const calls: { command: string; args: string[] }[] = [];
	let fail = "";
	const run = async (command: string, args: string[]) => {
		calls.push({ command, args });
		await Promise.resolve();
		if (fail === command || (fail === "verify" && args.includes("--verify"))) return { code: 1, stderr: "injected failure" };
		if (command === "xcrun") fs.writeFileSync(args.at(-1)!, fs.readFileSync(source), { mode: 0o700 });
		return { code: 0, stderr: "" };
	};
	const options = { homeDirectory, projectRoot, source, run, signingIdentity: "-", deadline: Date.now() + 10_000 };
	const binary = path.join(homeDirectory, "Library/Application Support/Pix/ui-qa/helpers/macos-accessibility");
	return { root, homeDirectory, projectRoot, otherProject, source, calls, options, binary,
		setFailure(value: string) { fail = value; },
		cleanup() { fs.rmSync(root, { recursive: true, force: true }); } };
}
function stamp(source: string, signer = "adhoc") {
	return `${createHash("sha256").update(fs.readFileSync(source)).digest("hex")}\n${signer}\n`;
}
function legacy(f: ReturnType<typeof fixture>, content = "legacy") {
	const helpers = path.join(f.projectRoot, ".pi/ui-qa/helpers");
	fs.mkdirSync(helpers, { recursive: true, mode: 0o700 });
	const binary = path.join(helpers, "macos-accessibility");
	fs.writeFileSync(binary, content, { mode: 0o700 });
	fs.writeFileSync(`${binary}.sha256`, stamp(f.source), { mode: 0o600 });
	return binary;
}

test.skipIf(process.platform === "win32")("default installation follows OS-account home, not isolated HOME or agent configuration", async () => {
	const f = fixture();
	const userInfo = os.userInfo;
	const oldHome = process.env.HOME;
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		os.userInfo = (() => ({ homedir: f.homeDirectory })) as typeof os.userInfo;
		process.env.HOME = f.otherProject;
		process.env.PI_CODING_AGENT_DIR = path.join(f.otherProject, "agent");
		const { homeDirectory: _testOverride, ...options } = f.options;
		expect(await prepareMacosHelper(options)).toBe(f.binary);
		expect(fs.readdirSync(f.otherProject)).toEqual([]);
	} finally {
		os.userInfo = userInfo;
		if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		f.cleanup();
	}
});

test.skipIf(process.platform === "win32")("one installation across projects and project .pi deletion; only changed source/signer rebuilds", async () => {
	const f = fixture();
	try {
		expect(await prepareMacosHelper(f.options)).toBe(f.binary);
		fs.mkdirSync(path.join(f.projectRoot, ".pi"));
		fs.rmSync(path.join(f.projectRoot, ".pi"), { recursive: true });
		expect(await prepareMacosHelper({ ...f.options, projectRoot: f.otherProject })).toBe(f.binary);
		expect(f.calls.filter(c => c.command === "xcrun")).toHaveLength(1);
		fs.writeFileSync(f.source, "v2");
		expect(await prepareMacosHelper(f.options)).toBe(f.binary);
		expect(fs.readFileSync(f.binary, "utf8")).toBe("v2");
		await prepareMacosHelper({ ...f.options, signingIdentity: "test-certificate" });
		expect(f.calls.filter(c => c.command === "xcrun")).toHaveLength(3);
		expect(fs.readFileSync(`${f.binary}.sha256`, "utf8")).toBe(stamp(f.source, "test-certificate"));
		expect(f.calls.filter(c => c.args.includes("--verify"))).toHaveLength(4);
	} finally { f.cleanup(); }
});

test.skipIf(process.platform === "win32")("concurrent cold requests serialize across projects", async () => {
	const f = fixture();
	try {
		const results = await Promise.all([prepareMacosHelper(f.options), prepareMacosHelper({ ...f.options, projectRoot: f.otherProject })]);
		expect(results).toEqual([f.binary, f.binary]);
		expect(f.calls.filter(c => c.command === "xcrun")).toHaveLength(1);
		expect(fs.readdirSync(path.dirname(f.binary)).sort()).toEqual(["macos-accessibility", "macos-accessibility.sha256"]);
	} finally { f.cleanup(); }
});

for (const unsafe of [false, true]) {
	test.skipIf(process.platform === "win32")(`concurrent hierarchy creation revalidates EEXIST (${unsafe ? "unsafe" : "private"} directory)`, async () => {
		const f = fixture();
		const mkdir = fs.mkdirSync;
		let injected = false;
		try {
			fs.mkdirSync = ((directory, options) => {
				if (!injected && String(directory) === path.join(f.homeDirectory, "Library/Application Support/Pix")) {
					injected = true;
					mkdir(directory, { mode: unsafe ? 0o755 : 0o700 });
					throw Object.assign(new Error("created concurrently"), { code: "EEXIST" });
				}
				return mkdir(directory, options);
			}) as typeof fs.mkdirSync;
			if (unsafe) await expect(prepareMacosHelper(f.options)).rejects.toThrow("private");
			else expect(await prepareMacosHelper(f.options)).toBe(f.binary);
			expect(injected).toBe(true);
		} finally { fs.mkdirSync = mkdir; f.cleanup(); }
	});
}

test.skipIf(process.platform === "win32")("unchanged private legacy helper is copied and verified without compile/sign", async () => {
	const f = fixture();
	try {
		const old = legacy(f);
		await prepareMacosHelper(f.options);
		expect(fs.readFileSync(f.binary, "utf8")).toBe("legacy");
		expect(fs.readFileSync(old, "utf8")).toBe("legacy");
		expect(fs.statSync(f.binary).ino).not.toBe(fs.statSync(old).ino);
		expect(f.calls).toHaveLength(1);
		expect(f.calls[0].args).toContain("--verify");
		fs.rmSync(path.join(f.projectRoot, ".pi"), { recursive: true });
		expect(await prepareMacosHelper(f.options)).toBe(f.binary);
		expect(fs.readFileSync(f.binary, "utf8")).toBe("legacy");
	} finally { f.cleanup(); }
});

for (const invalid of ["changed source", "public binary", "symlink binary", "invalid signature"]) {
	test.skipIf(process.platform === "win32")(`legacy ${invalid} safely falls back to bundled source`, async () => {
		const f = fixture();
		try {
			const old = legacy(f);
			if (invalid === "changed source") fs.writeFileSync(f.source, "v2");
			if (invalid === "public binary") fs.chmodSync(old, 0o755);
			if (invalid === "symlink binary") { fs.unlinkSync(old); fs.symlinkSync(f.source, old); }
			const original = f.options.run;
			let verifications = 0;
			if (invalid === "invalid signature") f.options.run = async (command, args) => {
				if (args.includes("--verify") && verifications++ === 0) return { code: 1, stderr: "bad legacy signature" };
				return original(command, args);
			};
			await prepareMacosHelper(f.options);
			expect(f.calls.filter(c => c.command === "xcrun")).toHaveLength(1);
			expect(fs.readFileSync(f.binary, "utf8")).toBe(fs.readFileSync(f.source, "utf8"));
			expect(fs.existsSync(old)).toBe(true);
		} finally { f.cleanup(); }
	});
}

for (const failure of ["xcrun", "codesign", "verify", "publication"]) {
	test.skipIf(process.platform === "win32")(`${failure} failure preserves prior binary/stamp and releases lock`, async () => {
		const f = fixture();
		const rename = fs.renameSync;
		try {
			await prepareMacosHelper(f.options);
			const beforeStamp = fs.readFileSync(`${f.binary}.sha256`, "utf8");
			fs.writeFileSync(f.source, "v2");
			if (failure === "publication") fs.renameSync = ((from, to) => {
				if (String(to) === `${f.binary}.sha256`) throw new Error("injected publication failure");
				return rename(from, to);
			}) as typeof fs.renameSync;
			else f.setFailure(failure);
			await expect(prepareMacosHelper(f.options)).rejects.toThrow("failure");
			expect(fs.readFileSync(f.binary, "utf8")).toBe("v1");
			expect(fs.readFileSync(`${f.binary}.sha256`, "utf8")).toBe(beforeStamp);
			expect(fs.readdirSync(path.dirname(f.binary)).sort()).toEqual(["macos-accessibility", "macos-accessibility.sha256"]);
			fs.renameSync = rename;
			f.setFailure("");
			await prepareMacosHelper(f.options);
			expect(fs.readFileSync(f.binary, "utf8")).toBe("v2");
		} finally { fs.renameSync = rename; f.cleanup(); }
	});
}

test.skipIf(process.platform === "win32")("cache reuse verifies signature and fails closed without rebuilding", async () => {
	const f = fixture();
	try {
		await prepareMacosHelper(f.options);
		f.setFailure("verify");
		await expect(prepareMacosHelper(f.options)).rejects.toThrow("failure");
		expect(f.calls.filter(c => c.command === "xcrun")).toHaveLength(1);
		expect(fs.existsSync(`${f.binary}.lock`)).toBe(false);
	} finally { f.cleanup(); }
});

for (const unsafe of ["home symlink", "Library symlink", "Pix public", "binary symlink", "stamp symlink", "binary public", "stamp public", "lock symlink", "lock public", "pid symlink"]) {
	test.skipIf(process.platform === "win32")(`rejects unsafe ${unsafe}`, async () => {
		const f = fixture();
		try {
			await prepareMacosHelper(f.options);
			if (unsafe === "home symlink") {
				const link = path.join(f.root, "linked-home"); fs.symlinkSync(f.homeDirectory, link); f.options.homeDirectory = link;
			} else if (unsafe === "Library symlink") {
				const library = path.join(f.homeDirectory, "Library"); const moved = path.join(f.homeDirectory, "real-library");
				fs.renameSync(library, moved); fs.symlinkSync(moved, library);
			} else if (unsafe === "Pix public") fs.chmodSync(path.join(f.homeDirectory, "Library/Application Support/Pix"), 0o755);
			else if (unsafe.startsWith("lock") || unsafe === "pid symlink") {
				const lock = `${f.binary}.lock`;
				if (unsafe === "lock symlink") fs.symlinkSync(f.projectRoot, lock);
				else { fs.mkdirSync(lock, { mode: unsafe === "lock public" ? 0o755 : 0o700 }); if (unsafe === "pid symlink") fs.symlinkSync(f.source, path.join(lock, "pid")); }
			} else {
				const entry = unsafe.startsWith("stamp") ? `${f.binary}.sha256` : f.binary;
				if (unsafe.endsWith("public")) fs.chmodSync(entry, 0o755);
				else { fs.unlinkSync(entry); fs.symlinkSync(f.source, entry); }
			}
			await expect(prepareMacosHelper(f.options)).rejects.toThrow();
			expect(f.calls.filter(c => c.command === "xcrun")).toHaveLength(1);
		} finally { f.cleanup(); }
	});
}

test.skipIf(process.platform === "win32")("existing shared Library permissions are untouched, product directories are private", async () => {
	const f = fixture();
	try {
		const support = path.join(f.homeDirectory, "Library/Application Support");
		fs.mkdirSync(support, { recursive: true, mode: 0o755 });
		fs.chmodSync(f.homeDirectory, 0o755);
		await prepareMacosHelper(f.options);
		expect(fs.statSync(f.homeDirectory).mode & 0o777).toBe(0o755);
		expect(fs.statSync(support).mode & 0o777).toBe(0o755);
		for (const entry of ["Pix", "Pix/ui-qa", "Pix/ui-qa/helpers"]) expect(fs.statSync(path.join(support, entry)).mode & 0o777).toBe(0o700);
	} finally { f.cleanup(); }
});

for (const owner of ["dead", "live", "recent empty", "stale empty", "invalid"]) {
	test.skipIf(process.platform === "win32")(`${owner} lock is reclaimed only if safely abandoned`, async () => {
		const f = fixture();
		try {
			await prepareMacosHelper(f.options);
			const lock = `${f.binary}.lock`;
			fs.mkdirSync(lock, { mode: 0o700 });
			if (!owner.endsWith("empty")) fs.writeFileSync(path.join(lock, "pid"), owner === "live" ? String(process.pid) : owner === "dead" ? "2147483647" : "invalid", { mode: 0o600 });
			if (owner !== "recent empty") fs.utimesSync(lock, new Date(0), new Date(0));
			const options = { ...f.options, deadline: Date.now() + 150 };
			if (owner === "dead" || owner === "stale empty") {
				expect(await prepareMacosHelper(options)).toBe(f.binary);
				expect(fs.existsSync(lock)).toBe(false);
			} else {
				await expect(prepareMacosHelper(options)).rejects.toThrow(owner === "invalid" ? "invalid" : "timed out");
				expect(fs.existsSync(lock)).toBe(true);
			}
		} finally { f.cleanup(); }
	});
}
