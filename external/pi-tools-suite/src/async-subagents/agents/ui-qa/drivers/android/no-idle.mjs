import { createHash, randomBytes } from "node:crypto";
import { HELPER_BASE64, HELPER_SHA256 } from "./helper-bundle.mjs";

export function verifyNoIdleHelperBundle() {
	const bytes = Buffer.from(HELPER_BASE64, "base64");
	if (bytes.length < 4 || bytes.length > 32 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(HELPER_BASE64) || bytes.readUInt32LE(0) !== 0x04034b50
		|| createHash("sha256").update(bytes).digest("hex") !== HELPER_SHA256) throw new Error("trusted Android helper bundle integrity check failed");
}

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

/** No flow-controlled code, paths, helper bytes or options cross this boundary. */
export function noIdleHierarchyCommand(expectedPackage, runId = randomBytes(16).toString("hex")) {
	if (typeof expectedPackage !== "string" || expectedPackage.length > 255 || !/^[A-Za-z]\w*(?:\.[A-Za-z]\w*)+$/.test(expectedPackage)
		|| typeof runId !== "string" || !/^[0-9a-f]{32}$/.test(runId)) throw new Error("invalid temporary Android helper identity");
	verifyNoIdleHelperBundle();
	const directory = `/data/local/tmp/pi-ui-qa-${runId}`;
	// One noninteractive remote transaction: a host-side hard exit cannot leave
	// a gap between upload and launch. The Java watchdog and outer timeout bound
	// an orphaned app_process; this shell then removes only its exclusive dir.
	const script = [
		"umask 077",
		`d=${directory}`,
		'mkdir -m 700 "$d" || exit 73',
		'cleanup() { rm -rf -- "$d" && [ ! -e "$d" ] && [ ! -L "$d" ]; }',
		"trap 'cleanup || exit 76' EXIT",
		"trap 'exit 74' HUP INT TERM PIPE",
		`printf %s ${quote(HELPER_BASE64)} | base64 -d > "$d/h.jar" || exit 75`,
		'chmod 400 "$d/h.jar" || exit 75',
		'hash=$(sha256sum "$d/h.jar") || exit 75',
		`[ "\${hash%% *}" = ${quote(HELPER_SHA256)} ] || exit 75`,
		'mkdir -m 700 "$d/dalvik-cache" || exit 75',
		`CLASSPATH="$d/h.jar" ANDROID_DATA="$d" timeout -s KILL 10 app_process /system/bin dev.pix.uiqa.HierarchyDump ${quote(expectedPackage)} 2>/dev/null`,
		"result=$?",
		"if ! cleanup; then trap - EXIT HUP INT TERM PIPE; exit 76; fi",
		"trap - EXIT HUP INT TERM PIPE",
		`printf '\\nPIQA-DONE:%s:%s\\n' ${quote(runId)} "$result"`,
		"exit 0",
	].join("\n");
	if (Buffer.byteLength(script) > 60_000) throw new Error("Android helper command exceeds limit");
	return { args: ["exec-out", script], directory, runId };
}

// exec: has no remote-exit-status framing. An adb client exit of zero does
// NOT prove the script succeeded. Only this exact per-lease terminal marker,
// printed after verified cleanup, confirms completion independently of ADB.
export function parseNoIdleHierarchyResult(bytes, runId) {
	const output = bytes.toString("utf8");
	const trailer = /\nPIQA-DONE:([0-9a-f]{32}):(0|[1-9]\d{0,2})\n$/.exec(output);
	const body = trailer ? output.slice(0, trailer.index) : "";
	if (!trailer || trailer[1] !== runId || Number(trailer[2]) > 255 || /(?:^|\n)PIQA-DONE:/.test(body)) throw new Error("Android helper completion trailer missing or invalid; cleanup unverified");
	return { body: Buffer.from(body, "utf8"), status: Number(trailer[2]) };
}

export function noIdleHierarchyFailure(status, body) {
	if ([124, 137].includes(status)) return "Android hierarchy helper timed out";
	const token = body.toString("utf8").trim().match(/^PIQA-ERR:([A-Z_]{1,32})$/)?.[1];
	return token ? `Android hierarchy helper failed: ${token}` : `Android hierarchy helper failed (status ${status})`;
}

export function requireStableAndroidNode(before, after, beforeRotation, afterRotation) {
	const fields = ["node-path", "window-id", "package", "class", "resource-id", "text", "content-desc", "bounds", "enabled", "focused", "checked", "selected", "password"];
	if (!before || !after || !/^0(?:\.\d+)*$/.test(before["node-path"] ?? "") || !/^\d+$/.test(before["window-id"] ?? "")
		|| beforeRotation !== afterRotation || fields.some((field) => before[field] !== after[field])) throw new Error("Android target changed between no-idle snapshots; no input sent");
}
