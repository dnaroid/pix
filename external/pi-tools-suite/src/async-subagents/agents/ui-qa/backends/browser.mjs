import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { callChrome, chromeBlock } from "../drivers/chrome-control/bridge.mjs";
import { compileBrowserFlow, pageSource } from "../drivers/chrome-control/flow.mjs";

const DRIVER = "chrome-control";
const CAPABILITIES = ["navigate", "domSelectors", "syntheticClick", "syntheticFill", "domAssertions", "ownedTabCleanup"];

function unsupported(feature) {
	return {
		status: "BLOCKED", missingCapabilities: ["chromeControlFlow"],
		reason: `Chrome Control does not support ${feature}`,
		remediation: "use the bundled browser guide and a same-origin Chrome Control flow; do not drop a required assertion or substitute a different target",
	};
}

export async function probeBrowserBackend(context) {
	const selection = { platformDriver: DRIVER, supportedCapabilities: [] };
	if (context.shallow) return { ...selection, available: false };
	const config = compileBrowserFlow(context.flow, { probe: true });
	let blocker;
	if (config.unsupported) blocker = unsupported(config.unsupported);
	else if ((context.platform ?? process.platform) !== "darwin") {
		blocker = {
			reason: "Chrome Control browser QA requires macOS and Google Chrome",
			missingCapabilities: ["macosChrome"], remediation: "rerun browser QA on macOS with Google Chrome open",
		};
	} else {
		const availability = await (context.chrome ?? callChrome)({ command: "probe" }, context);
		if (availability.code !== "ok") blocker = chromeBlock(availability.code);
		else {
			selection.supportedCapabilities = [...CAPABILITIES, ...(availability.screenshot ? ["screenshot"] : [])];
			if (!availability.screenshot && config.steps.some((step) => step.action === "screenshot")) blocker = chromeBlock("screen-permission");
		}
	}
	if (blocker) {
		const { reason, remediation, missingCapabilities } = blocker;
		return { ...selection, available: false, reason, remediation, missingCapabilities };
	}
	return { ...selection, available: true, reason: "URL target uses an owned tab in the current Chrome profile" };
}

export async function runBrowserBackend(context) {
	const config = compileBrowserFlow(context.flow);
	if (config.unsupported) return unsupported(config.unsupported);
	const chrome = context.chrome ?? callChrome;
	const deadline = Math.min(context.deadline, Date.now() + (config.timeoutMs ?? Infinity));
	const abort = new AbortController();
	const cancel = () => abort.abort();
	const call = (request) => chrome(request, { deadline, signal: abort.signal });
	const assertions = [];
	const screenshots = [];
	let marker, instance, tabId, outcome;
	const owned = (command, args) => ({ command, instance, marker, tabId, ...args });
	const ready = pageSource(config.origin);
	const page = (source, interaction = false) => poll(async () => {
		const response = await call(owned("page", { source, interaction }));
		return response.code === "ok" ? response.value : response.code;
	}, Math.min(deadline, Date.now() + 5000), abort.signal);
	const verify = () => page(ready);
	process.on("SIGTERM", cancel);
	process.on("SIGINT", cancel);
	try {
		outcome = await execute();
	} finally {
		try {
			if (marker && instance) {
				const closed = await chrome(owned("close"), { deadline: Date.now() + 4000 });
				if (!["ok", "no-tab", "chrome-not-running"].includes(closed.code)) {
					context.progress?.("chrome_control_cleanup_failed", { code: closed.code });
					const cleanup = chromeBlock(closed.code, "Chrome Control could not close its QA tab");
					outcome = outcome?.status === "PASSED" ? cleanup : { ...outcome, cleanupWarning: cleanup.reason };
				}
			}
		} finally {
			process.off("SIGTERM", cancel);
			process.off("SIGINT", cancel);
		}
	}
	if (abort.signal.aborted) outcome = { ...outcome, status: "FAILED", reason: "Chrome Control run cancelled" };
	return { ...outcome, assertions, artifacts: { screenshots } };

	async function execute() {
		const available = await call({ command: "probe" });
		if (available.code !== "ok") return failure(available.code, "preflight");
		if (!available.screenshot && config.steps.some((step) => step.action === "screenshot")) return chromeBlock("screen-permission");
		instance = available.instance;
		if (!Number.isSafeInteger(instance?.pid) || !Number.isFinite(instance.started)) return failure("driver-error", "preflight");
		marker = `about:blank#pix-ui-qa-${randomUUID()}`;
		const opened = await call(owned("open"));
		if (opened.code !== "ok") return failure(opened.code, "open tab");
		tabId = opened.tabId;
		if (!Number.isSafeInteger(tabId)) return failure("driver-error", "open tab");
		const navigated = await call(owned("navigate", { url: config.baseUrl }));
		if (navigated.code !== "ok") return failure(navigated.code, "initial navigation");
		const loaded = await verify();
		if (loaded !== "ok") return failure(loaded, "initial navigation");

		for (const [index, step] of config.steps.entries()) {
			if (abort.signal.aborted || Date.now() >= deadline) return failure("timeout", "flow deadline");
			const code = await perform(step);
			if (step.action.startsWith("assert")) {
				assertions.push({ action: step.action, step: index + 1, ...(code === "ok" || code === "mismatch" ? { passed: code === "ok" } : {}) });
			}
			if (code !== "ok") return failure(code, `step ${index + 1} (${step.action})`);
		}
		return { status: "PASSED" };
	}

	async function perform(step) {
		if (step.action === "goto" || step.action === "reload") {
			const moved = await call(owned(step.action === "goto" ? "navigate" : "reload", { url: step.url, source: ready }));
			return moved.code === "ok" ? verify() : moved.code;
		}
		if (step.action === "screenshot") {
			const verified = await verify();
			if (verified !== "ok") return verified;
			const file = path.join(context.evidenceDir, step.name);
			// Keep partial or late output from a killed capture out of run evidence.
			const staging = fs.mkdtempSync(path.join(path.dirname(context.evidenceDir), ".chrome-capture-"));
			const pending = path.join(staging, "window.png");
			try {
				const captured = await call(owned("screenshot", { file: pending, source: ready }));
				if (captured.code !== "ok") return captured.code;
				if (abort.signal.aborted || Date.now() >= deadline) return "timeout";
				if (!fs.existsSync(pending)) return "window-unavailable";
				fs.chmodSync(pending, 0o600);
				fs.renameSync(pending, file);
				screenshots.push(context.artifact(file, "screenshot"));
				return "ok";
			} finally {
				fs.rmSync(staging, { recursive: true, force: true });
			}
		}
		const interaction = step.action === "click" || step.action === "fill";
		const code = await page(pageSource(config.origin, step), interaction);
		if (code === "ok" && interaction) return verify();
		return code;
	}
}

async function poll(check, deadline, signal) {
	let code = "not-ready";
	while (Date.now() < deadline && !signal.aborted) {
		code = await check();
		if (code !== "not-ready" && code !== "mismatch") return code;
		await pause(175, undefined, { signal }).catch(() => {});
	}
	return signal.aborted ? "timeout" : code;
}

function failure(code, stage) {
	if (code === "unconfirmed-interaction") {
		return { status: "FAILED", reason: `Chrome Control ${stage}: outcome unconfirmed; the interaction was not retried` };
	}
	const reason = `Chrome Control ${stage}: ${code}`;
	if (["mismatch", "invalid-locator", "ambiguous", "not-ready", "timeout"].includes(code)) {
		return { status: "FAILED", reason, ...(code === "timeout" ? { timedOut: true } : {}) };
	}
	return chromeBlock(code, reason);
}
