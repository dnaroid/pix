import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	checkPixUpdate,
	formatPixUpdateCheck,
	formatPixStartupUpdateDialog,
	getPixSelfUpdateCommand,
	parsePixUpdateArgs,
} from "../src/app/cli/update.js";

describe("pix update", () => {
	it("parses update CLI options", () => {
		assert.deepEqual(parsePixUpdateArgs(["--check", "--force"]), {
			checkOnly: true,
			force: true,
			help: false,
		});
		assert.deepEqual(parsePixUpdateArgs(["-h"]), {
			checkOnly: false,
			force: false,
			help: true,
		});
		assert.throws(() => parsePixUpdateArgs(["--bad"]), /Unknown pix update argument/u);
	});

	it("reports an available npm update", async () => {
		await withPackageJson({ name: "pi-ui-extend", version: "0.1.0" }, async (packageRoot) => {
			const result = await checkPixUpdate({
				packageRoot,
				fetchLatestVersion: async () => "0.2.0",
			});

			assert.equal(result.status, "newer");
			assert.equal(result.latestVersion, "0.2.0");
			assert.match(formatPixUpdateCheck(result), /run: pix update/u);
		});
	});

	it("formats startup update dialog instructions", () => {
		const message = formatPixStartupUpdateDialog({
			status: "newer",
			packageName: "pi-ui-extend",
			currentVersion: "0.1.0",
			latestVersion: "0.2.0",
			packageRoot: "/tmp/pi-ui-extend",
		});

		assert.match(message, /A new Pix version is available/u);
		assert.match(message, /latest: 0\.2\.0/u);
		assert.match(message, /Exit Pix/u);
		assert.match(message, /pix update/u);
		assert.match(message, /Start Pix again/u);
	});

	it("does not offer npm updates for private source packages", async () => {
		await withPackageJson({ name: "pi-ui-extend", version: "0.1.0", private: true }, async (packageRoot) => {
			const result = await checkPixUpdate({
				packageRoot,
				fetchLatestVersion: async () => "0.2.0",
			});

			assert.equal(result.status, "unavailable");
			assert.match(formatPixUpdateCheck(result), /source checkout/u);
		});
	});

	it("builds a package-manager self-update command for managed installs", () => {
		const command = getPixSelfUpdateCommand("pi-ui-extend", "0.2.0", "/tmp/prefix/lib/node_modules/pi-ui-extend");

		assert.equal(command?.command, "npm");
		assert.deepEqual(command?.args.slice(-2), ["--min-release-age=0", "pi-ui-extend@0.2.0"]);
	});

	it("does not self-update source checkouts", () => {
		assert.equal(getPixSelfUpdateCommand("pi-ui-extend", "0.2.0", "/tmp/pi-ui-extend"), undefined);
	});
});

async function withPackageJson(packageJson: Record<string, unknown>, callback: (packageRoot: string) => Promise<void>): Promise<void> {
	const packageRoot = await mkdtemp(join(tmpdir(), "pix-update-"));
	try {
		await writeFile(join(packageRoot, "package.json"), JSON.stringify(packageJson), "utf8");
		await callback(packageRoot);
	} finally {
		await rm(packageRoot, { recursive: true, force: true });
	}
}
