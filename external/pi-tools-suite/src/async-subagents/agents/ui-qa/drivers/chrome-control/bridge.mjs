import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./chrome.jxa.js", import.meta.url));
const FIXES = {
	"chrome-not-running": ["runningChrome", "open Google Chrome with the intended profile and an open window"],
	"no-window": ["chromeWindow", "open a Chrome window in the intended profile"],
	"automation-permission": ["appleEvents", "grant the launching app permission to control Google Chrome in macOS Privacy & Security → Automation"],
	"javascript-permission": ["chromeJavaScriptAppleEvents", "enable View → Developer → Allow JavaScript from Apple Events in Chrome"],
	"screen-permission": ["screenRecording", "grant Screen Recording to the launching app in macOS Privacy & Security"],
	"window-unavailable": ["chromeWindowCapture", "keep the Chrome window visible and unminimized; do not switch tabs during capture"],
	"no-tab": ["ownedChromeTab", "keep the QA tab open until the run finishes"],
	"outside-origin": ["approvedPage", "use the intended origin and sign in manually in Chrome if needed"],
	"unsupported-interaction": ["chromeControlInteraction", "use a supported same-tab, same-origin control with a non-sensitive value"],
	"driver-error": ["chromeControl", "check that Google Chrome is running and macOS Automation and Chrome JavaScript from Apple Events are enabled"],
};

export function chromeBlock(code, reason = `Chrome Control: ${code}`) {
	const [capability, fix] = FIXES[code] ?? FIXES["driver-error"];
	return { status: "BLOCKED", reason, remediation: `${fix}, then rerun UI QA`, missingCapabilities: [capability] };
}

export function callChrome(request, { deadline, signal }) {
	return new Promise((resolve) => {
		const timeout = Math.min(8000, deadline - Date.now());
		if (signal?.aborted || timeout <= 0) return resolve({ code: "timeout" });
		const child = spawn("/usr/bin/osascript", ["-l", "JavaScript", SCRIPT, JSON.stringify(request)], {
			detached: true, stdio: ["ignore", "pipe", "ignore"],
		});
		let output = "";
		let stopped;
		const stop = (code) => {
			stopped ??= code;
			if (child.pid) {
				try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
			}
		};
		const cancel = () => stop("timeout");
		const timer = setTimeout(cancel, timeout);
		signal?.addEventListener("abort", cancel, { once: true });
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			if (output.length + chunk.length > 8192) stop("driver-error");
			else output += chunk;
		});
		child.on("error", () => stop("driver-error"));
		child.once("close", (exit) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
			if (stopped || exit !== 0) return resolve({ code: stopped ?? "driver-error" });
			try { resolve(JSON.parse(output)); }
			catch { resolve({ code: "driver-error" }); }
		});
	});
}
