import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [mode, dir, code] = process.argv.slice(2);
const mark = (name) => writeFileSync(join(dir, name), String(process.pid));
if (mode === "leaf") {
	process.on("SIGTERM", () => {});
	mark("leaf");
	setTimeout(() => process.exit(98), 25_000);
} else {
	const leaf = spawn(process.execPath, [process.argv[1], "leaf", dir], { stdio: "ignore" });
	leaf.on("error", () => process.exit(98));
	mark("cli");
	const deadline = Date.now() + 20_000;
	const tick = () => {
		if (existsSync(join(dir, "complete"))) process.exit(Number(code));
		if (Date.now() >= deadline) process.exit(98);
		setTimeout(tick, 10);
	};
	tick();
}
