import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";

it("pix-watch resolves global symlinks and execs npm from the checkout without starting real watchers", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "pix-watch-launcher-"));
	try {
		const bin = join(temporary, "bin");
		await mkdir(bin);
		const output = join(temporary, "invocation");
		const npm = join(bin, "npm");
		await writeFile(npm, '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@" > "$CAPTURE"\nexit 7\n');
		await chmod(npm, 0o755);
		await symlink(resolve("scripts/pix-watch"), join(bin, "launcher"));
		await symlink("launcher", join(bin, "pix-watch"));
		const result = spawnSync(join(bin, "pix-watch"), ["--", "argument with spaces"], {
			cwd: temporary,
			env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, CAPTURE: output },
			encoding: "utf8",
		});
		assert.equal(result.error, undefined);
		assert.equal(result.status, 7, result.stderr);
		assert.equal(await readFile(output, "utf8"), `${resolve(".")}\nrun\nwatch:all\n--\nargument with spaces\n`);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});
