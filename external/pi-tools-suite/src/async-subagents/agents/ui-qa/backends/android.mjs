import fs from "node:fs";
import path from "node:path";
import { androidInputCommand, createAndroidClient, validateAndroidTarget } from "../drivers/android/adb.mjs";
import { androidTapPoint, parseAndroidHierarchy, rotatedAndroidSize, selectAndroidNodes, validateAndroidPng, validateAndroidSelector } from "../drivers/android/hierarchy.mjs";
import { noIdleHierarchyCommand, noIdleHierarchyFailure, parseNoIdleHierarchyResult, requireStableAndroidNode, verifyNoIdleHelperBundle } from "../drivers/android/no-idle.mjs";
import { createAndroidLifecycle, resumesAndroidApp, validateAndroidLifecycle } from "../drivers/android/lifecycle.mjs";

const CAPABILITIES = ["attach", "boundedActions", "coordinateInput", "accessibilitySnapshot", "semanticActivation", "keyboardInput", "valueInput", "stateAssertions", "windowScreenshot"];
const FIELDS = {
	snapshotAccessibility: ["name"], screenshot: ["name"], capture: ["name"],
	assertText: ["text"], waitForText: ["text"],
	assertState: ["selector", "attribute", "equals"], tap: ["selector"],
	pressKey: ["key"], inputText: ["text"],
	tapPoint: ["x", "y", "name"], swipe: ["startX", "startY", "endX", "endY", "durationMs", "name"],
	assertHelperCleanup: ["runId"],
	appLifecycle: ["operation", "name"], wait: ["durationMs"],
};
const STATE_ATTRIBUTES = new Set(["enabled", "checked", "selected", "focused", "clickable"]);
const REMEDIATION = "Establish the explicitly selected Android target through its documented setup and open the target app, then retry. Physical devices require deviceType: physical, an explicit transport serial and hardware deviceSerial. Never discover or substitute another target, install an APK, change permissions/settings, or run raw ADB outside the unified runner.";

function validateTargetActions(target, steps) {
	if (target.deviceType !== "physical") return;
	if (steps.some((step) => step.action === "assertHelperCleanup"
		|| step.action === "appLifecycle" && step.operation === "restart")) {
		throw new Error("physical Android QA does not support restart or helper cleanup actions");
	}
}

export async function probeAndroidBackend(context = {}) {
	const base = { platformDriver: "adb-screenshot", guideTopic: "adb", supportedCapabilities: CAPABILITIES, missingCapabilities: [] };
	// Non-Android QA must never start ADB or contact a device.
	if (context.shallow) return { ...base, available: true, reason: "explicit Android target attachment available; prerequisites not probed" };
	try {
		const target = validateAndroidTarget(context.flow.target.android);
		validateTargetActions(target, context.flow.steps);
		if (target.hierarchyMode === "no-idle") verifyNoIdleHelperBundle();
		const client = createAndroidClient(target, context);
		const boot = await client.identity();
		if (resumesAndroidApp(context.flow.steps)) await createAndroidLifecycle(client, target, boot, context).guardBackground();
		else await client.foreground();
		await client.screenSize();
		return { ...base, available: true, reason: "explicit Android target identity and foreground package verified" };
	} catch (error) {
		return { ...base, available: false, reason: error.message, remediation: REMEDIATION };
	}
}

export function validateAndroidSteps(steps) {
	if (!Array.isArray(steps) || !steps.length || steps.length > 100) throw new Error("Android flow requires 1..100 steps");
	for (const step of steps) {
		if (!step || !Object.hasOwn(FIELDS, step.action) || Object.keys(step).some((key) => !["action", "timeoutMs", ...FIELDS[step.action]].includes(key))) throw new Error("unsupported Android action or fields");
		if (step.timeoutMs !== undefined && (!Number.isInteger(step.timeoutMs) || step.timeoutMs < 100 || step.timeoutMs > 30_000)) throw new Error("invalid Android step timeoutMs");
		if (step.name !== undefined && (typeof step.name !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(step.name))) throw new Error("invalid Android evidence name");
		if (["assertText", "waitForText"].includes(step.action) && (typeof step.text !== "string" || !step.text || step.text.length > 512)) throw new Error("invalid Android assertion text");
		if (["tap", "assertState"].includes(step.action)) validateAndroidSelector(step.selector);
		if (step.action === "assertState" && (!STATE_ATTRIBUTES.has(step.attribute) || typeof step.equals !== "boolean")) throw new Error("invalid Android state assertion");
		if (["pressKey", "inputText", "tapPoint", "swipe"].includes(step.action)) androidInputCommand(step);
		validateAndroidLifecycle(step);
		if (step.runId !== undefined && (typeof step.runId !== "string" || !/^[0-9a-f]{32}$/.test(step.runId))) throw new Error("invalid Android helper runId");
	}
}

export async function runAndroidBackend(context) {
	const artifacts = { screenshots: [], accessibilitySnapshots: [] };
	const assertions = [];
	const observations = [];
	const helperRuns = new Set();
	let boot;
	let client;
	let target;
	let size;
	let lifecycle;
	let background = resumesAndroidApp(context.flow.steps);
	const stepContext = { ...context, stageTimeoutMs: Math.min(15_000, context.stageTimeoutMs ?? 15_000) };
	async function guard() {
		if (await client.identity() !== boot) throw new Error("Android target identity changed during QA; no further input allowed");
		if (background) await lifecycle.guardBackground();
		else await client.foreground();
	}
	async function hierarchy() {
		await guard();
		await client.foreground();
		const temporary = target.hierarchyMode === "no-idle";
		let raw;
		if (temporary) {
			if (stepContext.stageTimeoutMs < 13_000 || stepContext.deadline - Date.now() < 13_000) throw new Error("no-idle Android hierarchy requires at least 13000ms remaining; helper not started");
			const command = noIdleHierarchyCommand(target.package);
			helperRuns.add(command.runId);
			const lease = { action: "temporaryHelperCleanup", runId: command.runId, status: "unverified" };
			observations.push(lease);
			context.progress?.("android_helper", { runId: command.runId });
			const completion = parseNoIdleHierarchyResult(await client.command(command.args), command.runId);
			lease.status = "confirmed";
			if (completion.status !== 0) throw new Error(noIdleHierarchyFailure(completion.status, completion.body));
			raw = completion.body;
		} else raw = await client.command(["exec-out", "uiautomator", "dump", "/proc/self/fd/1"]);
		await guard();
		await client.foreground();
		const output = raw.toString("utf8");
		try {
			const view = parseAndroidHierarchy(output);
			if (temporary && !view.rotationPresent) throw new Error("no-idle Android hierarchy requires explicit rotation");
			return { ...view, size: rotatedAndroidSize(size, view.rotation) };
		} catch (error) {
			// Format diagnostics only: never retain a raw failed hierarchy which
			// has not passed password redaction and XML validation.
			observations.push({ action: "hierarchyParseFailure", stdoutBytes: raw.length,
				xmlDeclaration: output.trimStart().startsWith("<?xml"), hierarchyTag: /<hierarchy\b/.test(output),
				uiautomatorError: /ERROR:|Error while dumping|could not get idle state/.test(output) });
			throw error;
		}
	}
	function save(data, name, extension, bucket) {
		const file = `${name}.${extension}`;
		fs.writeFileSync(path.join(context.evidenceDir, file), data, { mode: 0o600, flag: "wx" });
		artifacts[bucket].push(context.artifact(file, bucket));
	}
	async function snapshot(name) {
		const view = await hierarchy();
		save(view.xml, name, "xml", "accessibilitySnapshots");
		return view;
	}
	async function screenshot(name) {
		await guard();
		const png = await client.command(["exec-out", "screencap", "-p"]);
		await guard();
		// Screenshot capture must remain available when an animated app prevents
		// UIAutomator from reaching idle. Validate the physical screen's two
		// possible dimension orders directly; no coordinates are derived here.
		const transposed = png.length >= 24 && png.readUInt32BE(16) === size.height && png.readUInt32BE(20) === size.width;
		validateAndroidPng(png, transposed ? { width: size.height, height: size.width } : size);
		save(png, name, "png", "screenshots");
		return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
	}
	try {
		validateAndroidSteps(context.flow.steps);
		target = validateAndroidTarget(context.flow.target.android);
		validateTargetActions(target, context.flow.steps);
		if (target.hierarchyMode === "no-idle") verifyNoIdleHelperBundle();
		client = createAndroidClient(target, stepContext);
		boot = await client.identity();
		lifecycle = createAndroidLifecycle(client, target, boot, stepContext);
		await guard();
		size = await client.screenSize();
		observations.push({ action: "attach", platformDriver: "adb-screenshot", adbPath: target.adbPath });
		for (const [index, step] of context.flow.steps.entries()) {
			stepContext.deadline = Math.min(context.deadline, Date.now() + (step.timeoutMs ?? (target.hierarchyMode === "no-idle" ? 30_000 : 15_000)));
			context.progress?.("android_step", { index, action: step.action });
			await guard();
			const name = `${String(index + 1).padStart(3, "0")}-${step.name ?? step.action}`;
			if (step.action === "appLifecycle") {
				await screenshot(`${name}-before`);
				await lifecycle.run(step.operation);
				background = step.operation === "background";
				await screenshot(`${name}-after`);
			} else if (step.action === "wait") {
				const until = Date.now() + step.durationMs;
				if (until + 100 > stepContext.deadline) throw new Error("Android wait exceeds remaining step deadline");
				while (Date.now() < until) {
					await guard();
					await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(0, until - Date.now()))));
				}
			} else if (step.action === "assertHelperCleanup") {
				const runs = step.runId ? [step.runId] : [...helperRuns];
				if (!runs.length) throw new Error("Android helper cleanup assertion requires an owned run or explicit runId");
				for (const runId of runs) {
					const dir = `/data/local/tmp/pi-ui-qa-${runId}`;
					const ack = (await client.command(["shell", `if test ! -e ${dir} && test ! -L ${dir}; then printf 'PIQA-CLEAN:${runId}\\n'; fi`])).toString("utf8");
					if (ack !== `PIQA-CLEAN:${runId}\n`) throw new Error("Android helper namespace cleanup unverified");
				}
				const processes = (await client.command(["shell", "ps -A -o ARGS && printf '\\nPIQA-PS-DONE\\n'"])).toString("utf8");
				const end = "\nPIQA-PS-DONE\n";
				if (!processes.endsWith(end) || !processes.slice(0, -end.length).trim()) throw new Error("Android helper process inspection unavailable");
				const passed = !/(?:^|\s)dev\.pix\.uiqa\.HierarchyDump(?:\s|$)/m.test(processes.slice(0, -end.length));
				assertions.push({ action: step.action, helpersChecked: runs.length, passed });
				if (!passed) throw new Error("Android hierarchy helper process is still present; no input sent");
				let nonzeroPropagated = false;
				try { await client.command(["exec-out", "false"]); }
				catch (error) {
					if (error.message !== "Android ADB command failed (exit 1)") throw error;
					nonzeroPropagated = true;
				}
				observations.push({ action: "execOutExitStatus", nonzeroPropagated });
			} else if (step.action === "screenshot") await screenshot(name);
			else if (step.action === "snapshotAccessibility") await snapshot(name);
			else if (step.action === "capture") { await screenshot(name); await snapshot(name); }
			else if (["tapPoint", "swipe"].includes(step.action)) {
				// Use current PNG pixels, not natural wm size or accessibility geometry.
				// Retain the before image even when bounds/foreground/input fail.
				size = await client.screenSize();
				const pixels = await screenshot(`${name}-before`);
				const command = androidInputCommand(step, pixels);
				await guard();
				await client.foreground();
				await client.command(command);
				await screenshot(`${name}-after`);
			}
			else if (["assertText", "waitForText"].includes(step.action)) {
				let found = false;
				do {
					const view = await hierarchy();
					found = selectAndroidNodes(view.nodes, { text: step.text }, target.package).length > 0
						|| selectAndroidNodes(view.nodes, { contentDesc: step.text }, target.package).length > 0;
					if (found || step.action === "assertText") break;
					await new Promise((resolve) => setTimeout(resolve, 100));
				} while (Date.now() < stepContext.deadline);
				assertions.push({ action: step.action, text: step.text, passed: found });
				if (!found) throw new Error(`Android text assertion failed at step ${index + 1}`);
			} else if (["tap", "assertState"].includes(step.action)) {
				const view = await hierarchy();
				const nodes = selectAndroidNodes(view.nodes, step.selector, target.package);
				if (nodes.length !== 1) throw new Error(`Android selector must match exactly one app node (matched ${nodes.length})`);
				if (step.action === "tap") {
					if (target.hierarchyMode === "no-idle") {
						const next = await hierarchy();
						const matches = selectAndroidNodes(next.nodes, step.selector, target.package);
						if (matches.length !== 1) throw new Error("Android target changed between no-idle snapshots; no input sent");
						requireStableAndroidNode(nodes[0], matches[0], view.rotation, next.rotation);
					}
					const point = androidTapPoint(nodes[0], view.size);
					await guard();
					await client.foreground();
					await client.command(["shell", "input", "tap", ...point.map(String)]);
				} else {
					const passed = nodes[0][step.attribute] === String(step.equals);
					assertions.push({ action: step.action, selector: step.selector, attribute: step.attribute, equals: step.equals, passed });
					if (!passed) throw new Error(`Android state assertion failed at step ${index + 1}`);
				}
			} else {
				if (step.action === "inputText") {
					const view = await hierarchy();
					const focused = (nodes) => nodes.filter((node) => node.package === target.package && node.focused === "true" && node.password !== "true" && node.class?.endsWith("EditText"));
					const nodes = focused(view.nodes);
					if (nodes.length !== 1) throw new Error("Android text input requires one focused non-password app EditText");
					if (target.hierarchyMode === "no-idle") {
						const next = await hierarchy();
						const matches = focused(next.nodes);
						if (matches.length !== 1) throw new Error("Android target changed between no-idle snapshots; no input sent");
						requireStableAndroidNode(nodes[0], matches[0], view.rotation, next.rotation);
					}
				}
				await guard();
				await client.foreground();
				await client.command(androidInputCommand(step));
			}
			await guard();
			observations.push({ action: step.action, step: index + 1, ...(step.action === "appLifecycle" ? { operation: step.operation } : {}) });
		}
		return { status: "PASSED", artifacts, assertions, observations };
	} catch (error) {
		// Preserve preceding captures; never try to interact after a failed guard.
		return { status: "FAILED", reason: error.message, timedOut: /timed out|deadline/.test(error.message), artifacts, assertions, observations };
	}
}
