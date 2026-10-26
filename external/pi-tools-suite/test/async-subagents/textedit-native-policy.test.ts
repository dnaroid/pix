import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { macosHelperSources } from "../../src/async-subagents/agents/ui-qa/drivers/macos/helper-sources.mjs";
import { prepareMacosHelper } from "../../src/async-subagents/agents/ui-qa/drivers/macos/helper-cache.mjs";

const driver = path.resolve(import.meta.dir, "../../src/async-subagents/agents/ui-qa/drivers/macos");
const artifacts = process.env.PI_TEXTEDIT_TEST_ARTIFACTS ?? path.resolve(import.meta.dir, "../../../../.pi/artifacts");
function scratch() {
	fs.mkdirSync(artifacts, { recursive: true });
	return fs.realpathSync(fs.mkdtempSync(path.join(artifacts, "textedit-policy-")));
}

test.skipIf(process.platform !== "darwin")("pure native lifecycle policy compiles and runs without AppKit or a UI", () => {
	const directory = scratch();
	try {
		const binary = path.join(directory, "lease-tests");
		const compile = spawnSync("xcrun", ["swiftc", path.join(driver, "textedit-lease.swift"),
			path.resolve(import.meta.dir, "../fixtures/ui-qa/textedit-lease-tests.swift"), "-o", binary], { encoding: "utf8", timeout: 60_000 });
		expect(compile.status, compile.stderr).toBe(0);
		const result = spawnSync(binary, [], { encoding: "utf8", timeout: 10_000 });
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toMatch(/\d+ policy checks passed; no AppKit, launch, input or termination API linked/);
	} finally { fs.rmSync(directory, { recursive: true, force: true }); }
}, 80_000);

test("source discovery includes all native lease sources and rejects missing or symlink companions", () => {
	const actual = macosHelperSources(path.join(driver, "macos-accessibility.swift"));
	expect(actual.map(file => path.basename(file))).toEqual(["macos-accessibility.swift", "textedit-lease.swift", "textedit-supervisor.swift"]);
	const directory = scratch();
	try {
		const source = path.join(directory, "macos-accessibility.swift");
		fs.writeFileSync(source, "main");
		expect(() => macosHelperSources(source)).toThrow();
		fs.writeFileSync(path.join(directory, "textedit-lease.swift"), "lease");
		fs.symlinkSync(source, path.join(directory, "textedit-supervisor.swift"));
		expect(() => macosHelperSources(source)).toThrow(/regular file/);
	} finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("cache hashes every companion and compiles the same source set as release discovery", async () => {
	const directory = scratch();
	try {
		const source = path.join(directory, "macos-accessibility.swift");
		const files = [source, path.join(directory, "textedit-lease.swift"), path.join(directory, "textedit-supervisor.swift")];
		files.forEach(file => fs.writeFileSync(file, path.basename(file)));
		const calls: string[][] = [];
		const options = { source, homeDirectory: directory, projectRoot: directory, signingIdentity: "-", deadline: Date.now() + 10_000,
			run: async (command: string, args: string[]) => {
				if (command === "xcrun") { calls.push(args); fs.writeFileSync(args[args.length - 1], "fake binary", { mode: 0o700 }); }
				return { code: 0, stderr: "" };
			},
		};
		await prepareMacosHelper(options);
		await prepareMacosHelper(options);
		expect(calls.length).toBe(1);
		for (const file of files) {
			fs.appendFileSync(file, "changed");
			await prepareMacosHelper(options);
		}
		expect(calls.length).toBe(4);
		for (const args of calls) expect(args.slice(0, -1)).toEqual(["swiftc", "-O", ...macosHelperSources(source), "-o"]);
	} finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
