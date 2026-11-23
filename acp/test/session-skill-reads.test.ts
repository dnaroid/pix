import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scanSessionSkillReads } from "../src/acp/session-skill-reads.js";

test("streams codemode skill loads from persisted history, not script or failure text", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pix-skill-reads-"));
	try {
		const path = join(dir, "session.jsonl");
		const rows = [
			{ role: "toolResult", toolName: "codemode", isError: true, nestedCalls: { calls: [
				{ name: "Read", status: "ok", arguments: { file_path: "/repo/.pi/skills/game-designer/SKILL.md" } },
				{ name: "read", status: "error", arguments: { path: "/skills/failed/SKILL.md" } },
				{ name: "read", status: "ok", arguments: { path: "/skills/game-designer/references/critique.md" } },
			] } },
			{ role: "toolResult", toolName: "codemode", details: { calls: [
				{ name: "read", status: "ok", args: '{"path":"/skills/game-designer/SKILL.md"}' },
				{ name: "read", status: "ok", args: '{"path":"/skills/legacy/SKILL.md"}' },
				{ name: "read", status: "ok", args: '{"path":"/skills/truncated/SKILL.md' },
			] } },
			{ role: "assistant", content: [
				{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "/skills/direct/SKILL.md" } },
				{ type: "toolCall", id: "read-2", name: "read", arguments: { path: "/skills/incomplete/SKILL.md" } },
				{ type: "toolCall", id: "script", name: "codemode", arguments: { code: 'tools.read({path:"/skills/mention/SKILL.md"})' } },
				{ type: "toolCall", id: "bash-1", name: "Bash", arguments: { command: "pwd\ncat /skills/godot/SKILL.md; ls" } },
			] },
			{ role: "toolResult", toolCallId: "read-1", toolName: "read", isError: false },
			{ role: "toolResult", toolCallId: "bash-1", toolName: "Bash", isError: false },
			{ role: "user", content: '<skill name="explicit" location="/skills/explicit/SKILL.md">\nInstructions\n</skill>' },
		];
		await writeFile(path, `${rows.map((message) => JSON.stringify({ type: "message", message })).join("\n")}\n{"type":"message"`);
		assert.deepEqual(await scanSessionSkillReads(path), ["game-designer", "legacy", "direct", "godot", "explicit"]);
		await assert.rejects(scanSessionSkillReads(join(dir, "missing.jsonl")), { code: "ENOENT" });
		await assert.rejects(scanSessionSkillReads(path, AbortSignal.abort()), { name: "AbortError" });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
