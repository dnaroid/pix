import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	ensurePiToolsSuiteDependencies,
	piToolsSuiteDependenciesCurrent,
} from "../scripts/pi-tools-suite-dependencies.mjs";

describe("pi-tools-suite dependency synchronization", () => {
	it("installs on manifest drift and repairs a missing direct dependency", async () => {
		const root = await mkdtemp(join(tmpdir(), "pix-suite-deps-"));
		const sourceRoot = join(root, "source");
		const targetRoot = join(root, "target");
		let installs = 0;
		const runInstall = async () => {
			installs += 1;
			const dependencyDir = join(targetRoot, "node_modules", "@fixture", "dependency");
			await mkdir(dependencyDir, { recursive: true });
			await writeFile(join(dependencyDir, "package.json"), "{}\n", "utf8");
		};

		try {
			await mkdir(sourceRoot, { recursive: true });
			await writeFile(join(sourceRoot, "package.json"), JSON.stringify({
				dependencies: { "@fixture/dependency": "1.0.0" },
			}), "utf8");
			await writeFile(join(sourceRoot, "package-lock.json"), "{\"lockfileVersion\":3}\n", "utf8");

			assert.equal(await piToolsSuiteDependenciesCurrent(sourceRoot, targetRoot), false);
			assert.equal(await ensurePiToolsSuiteDependencies({ sourceRoot, targetRoot, runInstall }), true);
			assert.equal(installs, 1);
			assert.equal(await piToolsSuiteDependenciesCurrent(sourceRoot, targetRoot), true);
			assert.equal(await ensurePiToolsSuiteDependencies({ sourceRoot, targetRoot, runInstall }), false);
			assert.equal(installs, 1);

			await rm(join(targetRoot, "node_modules", "@fixture", "dependency"), { recursive: true });
			assert.equal(await ensurePiToolsSuiteDependencies({ sourceRoot, targetRoot, runInstall }), true);
			assert.equal(installs, 2);

			await writeFile(join(sourceRoot, "package-lock.json"), "{\"lockfileVersion\":3,\"changed\":true}\n", "utf8");
			assert.equal(await ensurePiToolsSuiteDependencies({ sourceRoot, targetRoot, runInstall }), true);
			assert.equal(installs, 3);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
