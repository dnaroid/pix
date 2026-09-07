import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

import { RECOVERY_CASES } from "./recovery-corpus.js";
import { buildRecoveryRunIdentity } from "./recovery-run-identity.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "..", "..");

describe("Context Gateway recovery run identity", () => {
	test("pins dirty source, harness, validator, corpus, SDK/runtime/config, and arm order without absolute paths", () => {
		const identity = buildRecoveryRunIdentity({
			packageRoot: PACKAGE_ROOT,
			repoRoot: REPO_ROOT,
			models: ["zai/glm-5.3"],
			caseIds: RECOVERY_CASES.map((evalCase) => evalCase.id),
		});
		const sha256 = /^[a-f0-9]{64}$/;
		expect(identity.reportVersion).toBe(2);
		expect(identity.harnessVersion).toBe(2);
		expect(identity.validatorVersion).toBe(2);
		expect(identity.corpusVersion).toBe(2);
		expect(identity.testedPackage.entrypoint).toBe("index.ts");
		expect(identity.testedPackage.entrypointSha256).toMatch(sha256);
		expect(identity.testedPackage.sourceSha256).toMatch(sha256);
		expect(identity.testedPackage.sourceFileCount).toBeGreaterThan(10);
		for (const hash of Object.values(identity.hashes)) expect(hash).toMatch(sha256);
		expect(identity.sdk.piCodingAgentVersion).toBe("0.85.1");
		expect(identity.runtime.command).toBe("pi");
		expect(identity.runtime.bun).toBeTruthy();
		expect(identity.effectiveConfig).toMatchObject({
			contextGatewayMode: "observe",
			repoDiscoveryProfile: "native-compact",
			truncationMetadataNormalizer: true,
			piOffline: true,
			noSession: true,
		});
		expect(identity.armOrder.map((arm) => arm.caseId)).toEqual(RECOVERY_CASES.map((evalCase) => evalCase.id));
		expect(identity.armOrder.every((arm) => arm.provider === "zai")).toBe(true);
		const serialized = JSON.stringify(identity);
		expect(serialized).not.toContain(PACKAGE_ROOT);
		expect(serialized).not.toContain(REPO_ROOT);
	});
});
