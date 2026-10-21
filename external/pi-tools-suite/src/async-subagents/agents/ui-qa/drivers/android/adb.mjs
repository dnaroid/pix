import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const MAX_OUTPUT = 3 * 1024 * 1024;
const TARGET_FIELDS = new Set(["adbPath", "serial", "avdName", "package", "hierarchyMode", "deviceType", "deviceSerial"]);
const KEYS = new Set(["BACK", "ENTER", "DEL", "TAB", "DPAD_UP", "DPAD_DOWN", "DPAD_LEFT", "DPAD_RIGHT", "DPAD_CENTER", "ESCAPE"]);

export function validateAndroidTarget(target) {
	if (!target || typeof target !== "object" || Array.isArray(target)
		|| Object.keys(target).some((key) => !TARGET_FIELDS.has(key))) throw new Error("invalid target.android fields");
	if (target.hierarchyMode !== undefined && !["stock", "no-idle"].includes(target.hierarchyMode)) throw new Error("invalid Android hierarchyMode");
	const deviceType = target.deviceType === undefined ? "emulator" : target.deviceType;
	if (!["emulator", "physical"].includes(deviceType)) throw new Error("invalid Android deviceType");
	if (deviceType === "physical") {
		// Explicit opt-in only: never infer a physical target from a serial.
		if (typeof target.serial !== "string" || !/^[A-Za-z0-9\[][-A-Za-z0-9._:\[\]]{0,254}$/.test(target.serial)
			|| /^(?:emulator-|(?:usb|model|product|device|tcp|udp):)/.test(target.serial)) throw new Error("physical Android QA requires an explicit safe non-emulator serial");
		if (typeof target.deviceSerial !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(target.deviceSerial)) throw new Error("physical Android target requires its exact hardware deviceSerial (ro.serialno)");
		if (Object.hasOwn(target, "avdName")) throw new Error("physical Android target cannot specify avdName");
		if (target.hierarchyMode === "no-idle") throw new Error("no-idle helper is supported only on an approved AVD");
	} else {
		if (Object.hasOwn(target, "deviceSerial")) throw new Error("deviceSerial is only valid for physical Android targets");
		if (typeof target.serial !== "string" || !/^emulator-\d{4,5}$/.test(target.serial)) throw new Error("Android QA accepts only an explicit emulator serial unless deviceType is physical");
		if (typeof target.avdName !== "string" || !/^[A-Za-z0-9._-]{1,120}$/.test(target.avdName)) throw new Error("explicit avdName required");
	}
	if (typeof target.package !== "string" || !/^[A-Za-z]\w*(?:\.[A-Za-z]\w*)+$/.test(target.package)) throw new Error("invalid Android package");
	if (typeof target.adbPath !== "string" || !path.isAbsolute(target.adbPath)) throw new Error("adbPath must be absolute");
	const adbPath = fs.realpathSync(target.adbPath);
	if (!fs.statSync(adbPath).isFile() || !/^adb(?:\.exe)?$/.test(path.basename(adbPath))) throw new Error("adbPath must resolve to the adb executable");
	fs.accessSync(adbPath, fs.constants.X_OK);
	return { ...target, deviceType, adbPath };
}

// adb shell itself interprets a command string. Only fixed templates and
// restricted values may cross this boundary, even though spawn uses no shell.
export function androidInputCommand(step, size = { width: 16384, height: 16384 }) {
	if (["tapPoint", "swipe"].includes(step.action)) {
		const values = step.action === "tapPoint" ? [step.x, step.y] : [step.startX, step.startY, step.endX, step.endY];
		if (values.some((value, index) => !Number.isInteger(value) || value < 0 || value >= (index % 2 ? size.height : size.width))) throw new Error("Android coordinates must be integers inside the current screenshot");
		if (step.action === "tapPoint") return ["shell", "input", "tap", ...values.map(String)];
		const duration = step.durationMs ?? 300;
		if (!Number.isInteger(duration) || duration < 100 || duration > 2000) throw new Error("Android swipe durationMs must be 100..2000");
		return ["shell", "input", "swipe", ...values.map(String), String(duration)];
	}
	if (step.action === "pressKey" && KEYS.has(step.key)) return ["shell", "input", "keyevent", `KEYCODE_${step.key}`];
	if (step.action === "inputText" && typeof step.text === "string" && /^[A-Za-z0-9 .,_@:+-]{1,200}$/.test(step.text)) {
		return ["shell", "input", "text", `'${step.text.replaceAll(" ", "%s")}'`];
	}
	throw new Error("unsupported Android key or input text (ASCII safe subset only)");
}

export async function requireAdbServer(deadline, expectedVersion) {
	if (deadline <= Date.now()) throw new Error("Android QA deadline expired");
	if (!Number.isInteger(expectedVersion) || expectedVersion < 1 || expectedVersion > 0xffff) throw new Error("invalid local ADB protocol version");
	await new Promise((resolve, reject) => {
		const socket = net.createConnection({ host: "127.0.0.1", port: 5037 });
		let response = Buffer.alloc(0);
		let settled = false;
		const done = (error) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(); };
		socket.setTimeout(Math.max(1, Math.min(1000, deadline - Date.now())), () => done(new Error("existing local ADB server required")));
		// Speak only the read-only smart-socket version protocol. Unlike an adb
		// client connection this cannot start, kill or restart a shared daemon.
		socket.once("connect", () => socket.write("000chost:version"));
		socket.on("data", (chunk) => {
			response = Buffer.concat([response, chunk]);
			if (response.length > 64 || response.length >= 4 && response.toString("ascii", 0, 4) !== "OKAY") return done(new Error("local ADB server version handshake failed"));
			if (response.length < 12) return;
			const message = response.toString("ascii");
			if (!/^OKAY0004[0-9a-fA-F]{4}$/.test(message)) return done(new Error("invalid ADB server version response"));
			if (parseInt(message.slice(8), 16) !== expectedVersion) return done(new Error("ADB client/server protocol mismatch; no device command sent and daemon left untouched"));
			done();
		});
		socket.once("end", () => done(new Error("local ADB server closed its version handshake")));
		socket.once("error", () => done(new Error("existing local ADB server required; establish the explicitly selected Android target through its documented setup")));
	});
}

export function createAndroidClient(target, context) {
	const env = { ...process.env };
	let protocolVersion;
	for (const key of ["ANDROID_SERIAL", "ADB_SERVER_SOCKET", "ADB_VENDOR_KEYS", "ANDROID_ADB_SERVER_PORT", "ANDROID_ADB_SERVER_ADDRESS", "ADB_SERVER_PORT"]) delete env[key];
	async function command(args) {
		if (args[0] !== "version") await requireAdbServer(context.deadline, await version());
		const timeout = Math.min(context.stageTimeoutMs ?? 15_000, context.deadline - Date.now());
		if (timeout <= 0) throw new Error("Android QA deadline expired");
		return await new Promise((resolve, reject) => {
			const child = spawn(target.adbPath, ["-H", "127.0.0.1", "-P", "5037", "-s", target.serial, ...args], {
				cwd: context.projectRoot, env, stdio: ["ignore", "pipe", "pipe"], shell: false,
			});
			const stdout = [];
			let size = 0;
			let failure;
			let killTimer;
			function abort(reason) {
				if (failure) return;
				failure = new Error(reason);
				child.kill("SIGTERM");
				killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
			}
			const timer = setTimeout(() => abort("Android ADB command timed out"), timeout);
			child.stdout.on("data", (chunk) => { size += chunk.length; if (size > MAX_OUTPUT) abort("Android ADB output exceeds limit"); else stdout.push(chunk); });
			// Never echo device stderr (which can contain private screen text).
			child.stderr.on("data", (chunk) => { size += chunk.length; if (size > MAX_OUTPUT) abort("Android ADB output exceeds limit"); });
			child.once("error", (error) => { failure = error; });
			child.once("close", (code) => {
				clearTimeout(timer); clearTimeout(killTimer);
				if (failure) reject(failure);
				else if (code !== 0) reject(new Error(`Android ADB command failed (exit ${code})`));
				else resolve(Buffer.concat(stdout));
			});
		});
	}
	async function text(args) { return (await command(args)).toString("utf8").trim(); }
	async function version() {
		if (protocolVersion === undefined) {
			const result = await text(["version"]);
			const match = result.match(/^Android Debug Bridge version 1\.0\.(\d+)\s*$/m);
			if (!match) throw new Error("unrecognized local ADB client version");
			protocolVersion = Number(match[1]);
		}
		return protocolVersion;
	}
	async function property(name) { return text(["shell", "getprop", name]); }
	async function identity() {
		if (await text(["get-state"]) !== "device") throw new Error("expected Android target is not online");
		if (target.deviceType === "physical") {
			// -s also understands transport selectors. Require the exact transport
			// label AND the independent hardware serial, including for Wi-Fi ADB.
			if (await text(["get-serialno"]) !== target.serial) throw new Error("Android transport serial mismatch; no input sent");
			if (await property("ro.serialno") !== target.deviceSerial) throw new Error("Android hardware serial mismatch or missing; no input sent");
			const kernelQemu = await property("ro.kernel.qemu");
			const bootQemu = await property("ro.boot.qemu");
			if (![kernelQemu, bootQemu].every((value) => value === "" || value === "0")
				|| await property("ro.boot.qemu.avd_name") || await property("ro.kernel.qemu.avd_name")) throw new Error("target is not a verified non-emulator Android device");
		} else {
			const qemu = await property("ro.kernel.qemu") || await property("ro.boot.qemu");
			if (qemu !== "1") throw new Error("target is not a verified Android emulator");
			const avd = await property("ro.boot.qemu.avd_name") || await property("ro.kernel.qemu.avd_name");
			if (avd !== target.avdName) throw new Error("AVD name mismatch or missing identity property");
		}
		const boot = await text(["shell", "cat", "/proc/sys/kernel/random/boot_id"]);
		if (!/^[a-f0-9-]{36}$/i.test(boot)) throw new Error("Android boot identity missing");
		return boot;
	}
	async function focusedPackage() {
		let windows = await text(["shell", "dumpsys", "window", "windows"]);
		// Android versions differ in whether the windows-only section includes
		// display-owned focus. Query the complete dump only if the field is absent.
		if (!windows.includes("mCurrentFocus=")) windows = await text(["shell", "dumpsys", "window"]);
		const lines = windows.split(/\r?\n/).filter((entry) => entry.includes("mCurrentFocus="));
		if (!lines.length) throw new Error("Android window dump has no mCurrentFocus field; foreground could not be verified; no input sent");
		const packages = lines.map((line) => line.match(/\s([A-Za-z][\w.]*)\/[\w.$]+\}/)?.[1]);
		if (packages.some((name) => !name || name !== packages[0])) throw new Error("Android focused package is null, unparseable or inconsistent; no input sent");
		return packages[0];
	}
	async function foreground() {
		const focused = await focusedPackage();
		if (focused !== target.package) {
			throw new Error(`target Android package is not the focused application (observed: ${focused}); no input sent`);
		}
	}
	async function screenSize() {
		const value = await text(["shell", "wm", "size"]);
		const matches = [...value.matchAll(/(?:Physical|Override) size: (\d+)x(\d+)/g)];
		const [, width, height] = matches.at(-1) ?? [];
		if (!width || +width < 1 || +height < 1 || +width > 16384 || +height > 16384) throw new Error("invalid Android screen size");
		return { width: +width, height: +height };
	}
	return { command, identity, foreground, focusedPackage, screenSize };
}
