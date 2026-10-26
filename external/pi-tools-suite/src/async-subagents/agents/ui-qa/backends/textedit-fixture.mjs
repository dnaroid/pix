import fs from "node:fs";
import path from "node:path";
import { createTextEditSupervisor } from "./textedit-supervisor-client.mjs";

export const TEXTEDIT_EXECUTABLE = "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit";
const FIXTURES = new Set(["texteditBlank", "texteditBlankLifecycle"]);

export function textEditFixtureContract(application, platform = process.platform) {
	if (application.fixture === undefined) return undefined;
	if (platform !== "darwin" || !FIXTURES.has(application.fixture)) throw new Error("only the macOS texteditBlank/texteditBlankLifecycle fixtures are supported");
	if (Object.keys(application).length !== 1) throw new Error("TextEdit fixture cannot be combined with selectors, launch, or other fields");
	return application.fixture;
}

export function validateTextEditFixtureSteps(steps, fixture) {
	const count = steps.filter((step) => step.action === "texteditSmoke").length;
	if (!fixture) {
		if (count) throw new Error("texteditSmoke requires the texteditBlank fixture");
		return;
	}
	if (count !== (fixture === "texteditBlank" ? 1 : 0)) throw new Error("texteditBlank requires exactly one smoke; texteditBlankLifecycle requires zero");
	for (const step of steps) {
		// No numeric-PID companions: unsupported producers fail before launch.
		if (!["texteditSmoke", "snapshotAccessibility"].includes(step.action)) throw new Error(`TextEdit retained-instance fixture refuses action ${step.action}; only smoke and AX snapshots are supported`);
		if (step.depth !== undefined || step.limit !== undefined) throw new Error("TextEdit snapshots use fixed depth=10 and limit=100");
		if (step.name !== undefined && !/^[A-Za-z0-9._-]{1,80}$/.test(step.name)) throw new Error("invalid TextEdit snapshot name");
		if (step.timeoutMs !== undefined && (!Number.isInteger(step.timeoutMs) || step.timeoutMs < 1 || step.timeoutMs > 30_000)) throw new Error("invalid TextEdit step timeout");
	}
}

export async function runTextEditFixture({ context, helper, steps, artifacts, createSupervisor = createTextEditSupervisor }) {
	const observations = [{ action: "windowVideo", status: "unavailable", reason: "TextEdit retained-instance fixture does not delegate PID-based evidence" }];
	const assertions = [];
	const supervisor = createSupervisor(helper, { cwd: context.projectRoot });
	let failure;
	let cleanup;
	const cancel = () => supervisor.cancel("runner signal");
	process.on("SIGTERM", cancel);
	process.on("SIGINT", cancel);
	const request = (command, limit) => {
		const remaining = context.deadline - Date.now();
		if (remaining <= 5_000) throw new Error("insufficient runner budget for fixture and helper release");
		return supervisor.request(command, Math.min(limit, remaining - 5_000));
	};
	try {
		observations.push({ action: "launch", ...await request("launch", 16_000) });
		observations.push({ action: "texteditPrepare", ...await request("prepare", 6_000), syntheticOnly: true });
		for (const [index, step] of steps.entries()) {
			context.progress("desktop_action_started", { index, action: step.action });
			if (step.action === "texteditSmoke") {
				const result = await request("smoke", step.timeoutMs ?? 9_000);
				const passed = result.text === "ghbdtn " && result.pairs === 7;
				assertions.push({ action: step.action, expected: "ghbdtn ", actual: result.text, passed });
				if (!passed) throw new Error("TextEdit smoke returned unexpected evidence");
				observations.push({ action: step.action, ...result, syntheticOnly: true });
			} else {
				const { snapshot } = await request("snapshot", step.timeoutMs ?? 4_000);
				if (typeof snapshot !== "string") throw new Error("invalid TextEdit snapshot");
				const name = `textedit-${index}-${step.name ?? "snapshot"}.accessibility.txt`;
				fs.writeFileSync(path.join(context.evidenceDir, name), `${snapshot}\n`, { flag: "wx", mode: 0o600 });
				artifacts.accessibilitySnapshots.push(context.artifact(name, "accessibility snapshot"));
			}
			context.progress("desktop_action_finished", { index, action: step.action });
		}
	} catch (error) { failure = error; }
	finally {
		cleanup = await supervisor.close();
		process.removeListener("SIGTERM", cancel);
		process.removeListener("SIGINT", cancel);
	}
	observations.push({ action: "texteditCleanup", ...cleanup, automaticAppTermination: false });
	return {
		status: failure ? "FAILED" : "PASSED",
		...(failure ? { reason: failure.message ?? String(failure) } : {}),
		assertions, observations, artifacts,
	};
}
