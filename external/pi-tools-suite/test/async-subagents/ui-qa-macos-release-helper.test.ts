import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundledMacosHelper } from "../../src/async-subagents/agents/ui-qa/drivers/macos/release-helper.mjs";

function fixture(variant: "tui" | "desktop") {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ui-qa-release-helper-"));
	const app = path.join(root, "app");
	const source = path.join(app, "external/pi-tools-suite/src/async-subagents/agents/ui-qa/drivers/macos/macos-accessibility.swift");
	const binary = path.join(root, "helpers/macos-accessibility");
	fs.mkdirSync(path.dirname(source), { recursive: true });
	fs.mkdirSync(path.dirname(binary));
	fs.writeFileSync(source, "// packaged source");
	fs.writeFileSync(path.join(app, ".pix-portable.json"), "{}");
	fs.writeFileSync(path.join(root, "release.json"), JSON.stringify({ target: "macos-arm64", variant }));
	fs.writeFileSync(binary, "signed binary", { mode: 0o755 });
	return { root, source, binary };
}

for (const variant of ["tui", "desktop"] as const) {
	test(`installed ${variant} selects and verifies its bundled helper independent of project cwd`, async () => {
		const { root, source, binary } = fixture(variant);
		try {
			const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
			const run = async (command: string, args: string[], options: { cwd: string }) => {
				calls.push({ command, args, cwd: options.cwd });
				return { code: 0, stderr: "" };
			};
			expect(await bundledMacosHelper({ source, deadline: Date.now() + 10_000, run })).toBe(binary);
			expect(calls).toEqual([{ command: "codesign", args: ["--verify", "--strict", "--test-requirement", '=identifier "org.pix.ui-qa.macos-accessibility"', binary], cwd: root }]);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});
}

test("development source has no release helper and does not run codesign", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ui-qa-dev-helper-"));
	try {
		const source = path.join(root, "drivers/macos-accessibility.swift");
		fs.mkdirSync(path.dirname(source), { recursive: true });
		fs.writeFileSync(source, "// development source");
		expect(await bundledMacosHelper({ source, deadline: Date.now() + 10_000, run: () => { throw new Error("unexpected codesign"); } })).toBeNull();
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("incomplete or modified release fails closed instead of compiling a project helper", async () => {
	const { root, source, binary } = fixture("tui");
	const run = async () => ({ code: 1, stderr: "invalid signature" });
	const options = { source, deadline: Date.now() + 10_000, run };
	try {
		await expect(bundledMacosHelper(options)).rejects.toThrow("signature is invalid");
		fs.unlinkSync(binary);
		await expect(bundledMacosHelper(options)).rejects.toThrow("helper is missing");
		fs.symlinkSync(source, binary);
		await expect(bundledMacosHelper(options)).rejects.toThrow("not an executable regular file");
		fs.unlinkSync(binary);
		fs.writeFileSync(binary, "binary", { mode: 0o755 });
		fs.writeFileSync(path.join(root, "release.json"), JSON.stringify({ target: "linux-x64", variant: "tui" }));
		await expect(bundledMacosHelper(options)).rejects.toThrow("unexpected release target");
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});
