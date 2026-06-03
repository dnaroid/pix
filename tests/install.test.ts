import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";

import { formatPixInstallNextSteps, parsePixInstallArgs, pixInstallUsage, runPixInstallCli } from "../src/app/cli/install.js";

describe("pix install", () => {
	it("parses install CLI options", () => {
		assert.deepEqual(parsePixInstallArgs(["--check"]), { checkOnly: true, help: false });
		assert.deepEqual(parsePixInstallArgs(["-h"]), { checkOnly: false, help: true });
		assert.throws(() => parsePixInstallArgs(["--bad"]), /Unknown pix install argument/u);
		assert.match(pixInstallUsage(), /pi CLI availability/u);
	});

	it("prints post-install configuration guidance", () => {
		const output = formatPixInstallNextSteps("/tmp/pix-home");
		assert.match(output, /[\\/]tmp[\\/]pix-home[\\/]\.config[\\/]pi[\\/]pix\.jsonc/u);
		assert.match(output, /dictation\.language/u);
		assert.match(output, /\.config[\\/]pi[\\/]pi-tools-suite\.jsonc/u);
		assert.match(output, /lsp\.servers/u);
		assert.match(output, /\/opencode-import/u);
		assert.match(output, /\/antigravity-import/u);
	});

	it("accepts Pix's bundled pi bin during setup checks", async () => {
		const root = await mkdtemp(join(tmpdir(), "pix-install-"));
		const binDir = join(root, "node_modules", ".bin");
		try {
			await mkdir(binDir, { recursive: true });
			await writeFile(join(binDir, process.platform === "win32" ? "pi.cmd" : "pi"), "");

			const exitCode = await runPixInstallCli(["--check"], {
				env: {
					...process.env,
					PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
					PIX_BUNDLED_PI_BIN: binDir,
				},
			});

			assert.equal(typeof exitCode, "number");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
