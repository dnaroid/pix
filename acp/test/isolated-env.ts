import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Side-effect import for tests that read user/profile configuration. Import it
 * first so later modules see a hermetic environment: an agent or Desktop parent
 * session must not leak its profile/model selection or its real `~/.config`.
 * `node --test` runs each file in its own process, so nothing is restored.
 */
for (const key of ["PIX_CONFIG_PROFILE", "PI_MODEL", "PI_PROVIDER", "PI_REASONING_LEVEL"]) {
	delete process.env[key];
}
process.env.HOME = mkdtempSync(join(tmpdir(), "pix-acp-test-home-"));
