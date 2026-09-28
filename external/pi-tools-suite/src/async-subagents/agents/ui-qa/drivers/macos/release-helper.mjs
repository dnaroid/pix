import fs from "node:fs";
import path from "node:path";

const IDENTIFIER = "org.pix.ui-qa.macos-accessibility";

// The extension lives below pix/app in both the portable TUI archive and the
// Desktop resource payload. Use its marker, not the current project or cwd.
function releaseRoot(source) {
	let directory = path.dirname(source);
	while (true) {
		if (path.basename(directory) === "app" && fs.existsSync(path.join(directory, ".pix-portable.json"))) {
			return path.dirname(directory);
		}
		const parent = path.dirname(directory);
		if (parent === directory) return null;
		directory = parent;
	}
}

// An incomplete release must never compile a new TCC client in the user's project.
export async function bundledMacosHelper({ source, deadline, run }) {
	const root = releaseRoot(source);
	if (!root) return null;
	const binary = path.join(root, "helpers", "macos-accessibility");
	let manifest;
	try { manifest = JSON.parse(fs.readFileSync(path.join(root, "release.json"), "utf8")); }
	catch { throw new Error("bundled macOS accessibility helper has an invalid release manifest; reinstall the complete Pix release"); }
	if (manifest.target !== "macos-arm64" || !["tui", "desktop"].includes(manifest.variant)) {
		throw new Error("bundled macOS accessibility helper has an unexpected release target; reinstall the complete Pix release");
	}
	let stat;
	try { stat = fs.lstatSync(binary); }
	catch (error) {
		if (error.code !== "ENOENT") throw error;
		throw new Error(`bundled macOS accessibility helper is missing: ${binary}; reinstall the complete Pix release`);
	}
	// The exec bit is the tamper gate on POSIX payloads. Windows stat modes
	// never carry exec bits, so only the regular-file and symlink checks
	// apply there.
	const missingExecBit = process.platform !== "win32" && !(stat.mode & 0o111);
	if (!stat.isFile() || stat.isSymbolicLink() || missingExecBit) {
		throw new Error(`bundled macOS accessibility helper is not an executable regular file: ${binary}; reinstall the complete Pix release`);
	}
	const result = await run("codesign", ["--verify", "--strict", "--test-requirement", `=identifier "${IDENTIFIER}"`, binary], {
		cwd: root, timeoutMs: Math.max(1, deadline - Date.now()),
	});
	if (result.code !== 0) throw new Error(`bundled macOS accessibility helper signature is invalid: ${result.stderr || binary}; reinstall the complete Pix release`);
	return binary;
}
