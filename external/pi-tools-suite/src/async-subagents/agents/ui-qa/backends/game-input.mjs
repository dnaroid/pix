// A single bounded command, never a persistent keyDown lease across steps.
const KEYS = new Set([..."abcdefghijklmnopqrstuvwxyz0123456789", "space", "shift", "ctrl", "escape", "enter", "tab", "left", "right", "up", "down"]);

export function gameInputArgs(step, timeoutMs = 15_000) {
	const delivery = step.delivery ?? "pid";
	if (!["pid", "foreground"].includes(delivery)) throw new Error("gameInput.delivery must be pid or foreground");
	const keys = step.keys ?? [];
	if (!Array.isArray(keys) || keys.length > 8 || keys.some((key) => !KEYS.has(key)) || new Set(keys).size !== keys.length) {
		throw new Error("gameInput.keys requires at most 8 distinct supported lowercase keys");
	}
	const duration = step.durationMs ?? 100;
	if (!Number.isInteger(duration) || duration < 20 || duration > 5000) throw new Error("gameInput.durationMs must be 20..5000");
	if (timeoutMs < duration + 2000) throw new Error("gameInput timeout must allow durationMs plus 2000ms for setup and release");
	const dx = step.dx ?? 0;
	const dy = step.dy ?? 0;
	for (const value of [dx, dy]) {
		if (!Number.isInteger(value) || Math.abs(value) > 2000) throw new Error("gameInput dx/dy must be integers in -2000..2000");
	}
	if (step.button !== undefined && !["left", "right"].includes(step.button)) throw new Error("gameInput.button must be left or right");
	return ["--keys", keys.join(","), "--duration", String(duration / 1000), "--dx", String(dx), "--dy", String(dy), ...(step.button ? ["--button", step.button] : []), ...(step.delivery !== undefined ? ["--delivery", delivery] : [])];
}
