import { resolve } from "node:path";

import {
	analyzeSessionFile,
	loadLocalDcpConfigForEfficiencyReplay,
	measureDcpControlPlane,
	renderSessionEfficiencySummary,
} from "./session-token-efficiency.js";

const filePath = process.argv[2] ?? process.env.PI_SESSION_TOKEN_EFFICIENCY_PATH;
if (!filePath) {
	console.error("Usage: bun test/evals/run-session-token-efficiency.ts <session.jsonl>");
	process.exit(2);
}

const report = analyzeSessionFile(resolve(filePath), {
	dcpConfig: loadLocalDcpConfigForEfficiencyReplay(),
});
const output = {
	session: report,
	controlPlane: measureDcpControlPlane(),
};

console.log(JSON.stringify(output, null, 2));
console.error("\n" + renderSessionEfficiencySummary(report));
