import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [dir, mode] = process.argv.slice(2);
if (mode === "leaf") {
	writeFileSync(`${dir}/leaf`, String(process.pid));
	process.on("SIGTERM", () => {}); // resistant descendant
	setTimeout(() => process.exit(1), 15000); // fixture safety net only
} else {
	writeFileSync(`${dir}/cli`, String(process.pid));
	const leaf = spawn(process.execPath, [fileURLToPath(import.meta.url), dir, "leaf"], { detached: false, stdio: "ignore" });
	leaf.once("error", () => process.exit(1));
	if (mode === "success" || mode === "joint-race") process.on("message", (message) => {
		if (message === "complete" || message === "complete-fail") process.exit(message === "complete" ? 0 : 7);
	});
	else {
		process.on("SIGTERM", () => {});
		setTimeout(() => process.exit(1), 15000);
	}
}
