import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareMacosHelper } from "../../src/async-subagents/agents/ui-qa/drivers/macos/helper-cache.mjs";

const macTest = process.platform === "darwin" ? test : test.skip;

function run(command: string, args: string[], options: { cwd: string; timeoutMs: number }) {
	const result = spawnSync(command, args, { cwd: options.cwd, timeout: options.timeoutMs, encoding: "utf8" });
	return Promise.resolve({ code: result.status ?? 1, stderr: result.stderr || result.error?.message || "", stdout: result.stdout || "" });
}

function signature(binary: string) {
	const display = spawnSync("codesign", ["--display", "--verbose=4", binary], { encoding: "utf8" });
	expect(display.status, display.stderr).toBe(0);
	return display.stderr;
}

function designatedRequirement(binary: string) {
	const display = spawnSync("codesign", ["--display", "--requirements", "-", binary], { encoding: "utf8" });
	expect(display.status, display.stderr).toBe(0);
	return display.stdout.match(/^#? ?designated => (.+)$/m)?.[1];
}

macTest("macOS helper preserves its executable path and signing identifier across runs and source updates", async () => {
	const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ui-qa-helper-cache-")));
	try {
		const source = path.join(projectRoot, "helper.swift");
		fs.writeFileSync(source, "print(\"v1\")\n");
		const options = { projectRoot, source, run, signingIdentity: "-", deadline: Date.now() + 120_000 };
		const first = await prepareMacosHelper(options);
		const before = signature(first);
		const firstRequirement = designatedRequirement(first);
		expect(firstRequirement).toContain("cdhash");
		expect(before).toContain("Identifier=org.pix.ui-qa.macos-accessibility");
		expect(fs.statSync(first).mode & 0o077).toBe(0);
		const firstTime = fs.statSync(first).mtimeMs;
		const repeat = await prepareMacosHelper(options);
		expect(repeat).toBe(first);
		expect(fs.statSync(repeat).mtimeMs).toBe(firstTime);
		fs.writeFileSync(source, "print(\"v2\")\n");
		const updated = await prepareMacosHelper(options);
		expect(updated).toBe(first);
		expect(signature(updated)).toContain("Identifier=org.pix.ui-qa.macos-accessibility");
		expect(designatedRequirement(updated)).not.toBe(firstRequirement);
		expect(spawnSync(updated, [], { encoding: "utf8" }).stdout.trim()).toBe("v2");
		const nextRun = await prepareMacosHelper(options);
		expect(nextRun).toBe(first);
		expect(fs.statSync(nextRun).mtimeMs).toBe(fs.statSync(updated).mtimeMs);
		const helpers = path.dirname(first);
		expect(fs.readdirSync(helpers).sort()).toEqual(["macos-accessibility", "macos-accessibility.sha256"]);
	} finally {
		fs.rmSync(projectRoot, { recursive: true, force: true });
	}
}, 150_000);

const certificateTest = process.platform === "darwin" && process.env.PI_UI_QA_TEST_SIGNING_IDENTITY ? test : test.skip;
certificateTest("certificate-signed helper retains its designated requirement after a source update", async () => {
	const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ui-qa-helper-cert-")));
	try {
		const source = path.join(projectRoot, "helper.swift");
		fs.writeFileSync(source, "print(\"v1\")\n");
		const options = { projectRoot, source, run, signingIdentity: process.env.PI_UI_QA_TEST_SIGNING_IDENTITY!, deadline: Date.now() + 120_000 };
		const binary = await prepareMacosHelper(options);
		const requirement = designatedRequirement(binary);
		expect(requirement).toContain("certificate");
		fs.writeFileSync(source, "print(\"v2\")\n");
		expect(await prepareMacosHelper(options)).toBe(binary);
		expect(designatedRequirement(binary)).toBe(requirement);
		expect(spawnSync(binary, [], { encoding: "utf8" }).stdout.trim()).toBe("v2");
	} finally {
		fs.rmSync(projectRoot, { recursive: true, force: true });
	}
}, 150_000);

macTest("macOS helper fails closed on a symlink cache and retains the old executable after a failed update", async () => {
	const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ui-qa-helper-safety-")));
	try {
		const source = path.join(projectRoot, "helper.swift");
		fs.writeFileSync(source, "print(\"v1\")\n");
		const options = { projectRoot, source, run, signingIdentity: "-", deadline: Date.now() + 120_000 };
		const binary = await prepareMacosHelper(options);
		fs.writeFileSync(source, "this is invalid Swift\n");
		await expect(prepareMacosHelper(options)).rejects.toThrow();
		expect(spawnSync(binary, [], { encoding: "utf8" }).stdout.trim()).toBe("v1");
		const stamp = `${binary}.sha256`;
		fs.unlinkSync(stamp);
		fs.symlinkSync(source, stamp);
		await expect(prepareMacosHelper(options)).rejects.toThrow("regular file");
	} finally {
		fs.rmSync(projectRoot, { recursive: true, force: true });
	}
}, 150_000);
