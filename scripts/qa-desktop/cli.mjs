import { boundedTimeout, prepareDesktop } from "./prepare.mjs";
import { launchDesktop } from "./launch.mjs";
import { checkedPath } from "./paths.mjs";
import { doctorDesktop } from "./doctor.mjs";

export function parseArguments(args) {
	const [command, ...rest] = args;
	if (!["prepare", "launch", "doctor"].includes(command)) throw new Error("usage: qa:desktop prepare [--state PATH] [--timeout-ms 100..300000] [--run-dir PATH] [--seed-config] [--seed-api-keys] | launch --manifest PATH | doctor [--prompt]");
	const allowed = command === "doctor" ? { "--prompt": "prompt" }
		: command === "prepare" ? { "--state": "state", "--timeout-ms": "timeoutMs", "--run-dir": "runDir", "--seed-config": "seedConfig", "--seed-api-keys": "seedApiKeys" } : { "--manifest": "manifest" };
	const result = { command };
	for (let i = 0; i < rest.length; i++) {
		const key = Object.hasOwn(allowed, rest[i]) ? allowed[rest[i]] : undefined;
		if (!key || key in result) throw new Error("unknown or duplicate QA option");
		if (key === "seedConfig" || key === "seedApiKeys" || key === "prompt") result[key] = true;
		else {
			const value = rest[++i];
			if (!value || value.startsWith("--")) throw new Error("QA option requires a value");
			result[key] = key === "timeoutMs" ? boundedTimeout(value) : checkedPath(value);
		}
	}
	if (command === "launch" && !result.manifest) throw new Error("launch requires --manifest");
	return result;
}

export async function runCli(args, checkout, dependencies = {}) {
	if ((dependencies.platform ?? process.platform) !== "darwin") throw new Error("isolated Pix Desktop QA is supported only on macOS");
	const options = { ...parseArguments(args), checkout };
	if (options.command === "doctor") {
		const result = await (dependencies.doctor || doctorDesktop)(options);
		console.log(`UI QA helper: ${result.helperPath}`);
		console.log(result.output);
		if (result.code === 2) console.log("Approve this helper in System Settings > Privacy & Security > Accessibility / Screen Recording, then rerun doctor. Requests do not grant permission automatically.");
		return result.code;
	}
	if (options.command === "prepare") {
		const result = await (dependencies.prepare || prepareDesktop)(options);
		console.log(JSON.stringify(result, null, 2));
		console.log("OAuth/session and env-backed keys are not seeded. Pin covers native/embedded web; dev ACP still resolves from checkout.");
		return 0;
	}
	const result = await (dependencies.launch || launchDesktop)(options, {
		onReady: (identity) => console.log(`QA isolation verified: ${JSON.stringify(identity)}`),
	});
	return result.code ?? (result.signal ? 1 : 0);
}
