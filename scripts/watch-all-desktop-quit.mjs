import { execFile } from "node:child_process";

const QUIT_WAIT_MS = 30_000;

/** AppKit targets the real app PID, not another instance sharing its bundle ID. */
export function macDesktopQuitScript(pid) {
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid Desktop PID");
	return `ObjC.import('AppKit');
const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid});
if (!app || Number(app.processIdentifier) !== ${pid}) throw new Error('Desktop PID is no longer running');
if (!app.terminate) throw new Error('Desktop refused the Quit request');`;
}

function requestMacDesktopQuit(pid) {
	const script = macDesktopQuitScript(pid);
	return new Promise((resolve, reject) => {
		execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], {
			timeout: 5_000,
			maxBuffer: 4_096,
		}, (error) => error ? reject(error) : resolve());
	});
}

/** Never escalate a refused/slow Quit into a signal that bypasses persistence. */
export async function quitMacDesktopApp(pid, waitForExit, requestQuit = requestMacDesktopQuit) {
	// The app may already have exited naturally since the supervisor resolved it.
	if (await waitForExit(pid, 0)) return;
	await requestQuit(pid);
	if (!(await waitForExit(pid, QUIT_WAIT_MS))) {
		throw new Error("Desktop did not finish its clean Quit; leaving it alive to preserve window state");
	}
}
