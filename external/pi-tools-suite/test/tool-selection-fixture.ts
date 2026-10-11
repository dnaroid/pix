import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_ROOT = path.dirname(fileURLToPath(import.meta.url));

export function makeToolSelectionFixture(parentDir: string): string {
	fs.mkdirSync(parentDir, { recursive: true });
	const dir = fs.mkdtempSync(path.join(parentDir, "tool-selection-e2e-project-"));
	fs.cpSync(path.join(TEST_ROOT, "fixtures", "demo-project"), dir, { recursive: true });
	// Keep root discovery inside the fixture even under a parent checkout.
	fs.mkdirSync(path.join(dir, ".git"));
	fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".pi", "pi-tools-suite.jsonc"), JSON.stringify({
		// These cases exercise the direct audit fallback, not auditor delegation.
		disabledBuiltinAgents: ["knowledge-auditor"],
	}));
	fs.mkdirSync(path.join(dir, "specs"));
	fs.copyFileSync(path.join(TEST_ROOT, "fixtures", "tool-selection-payment-retry.md"), path.join(dir, "specs", "payment-retry.md"));
	return dir;
}
