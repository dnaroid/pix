import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ChildProcess } from "node:child_process";
import { providerSnapshotSource, runOffline, stageSnapshot } from "./provider-offline-harness.ts";

// Default provider source: the vendored local module (no install, no account,
// no live Claude). An explicit external snapshot still works for the
// unmodified-release characterization. A requested missing/invalid external
// snapshot must FAIL, not silently skip.
const source = providerSnapshotSource();
const offline = source === undefined ? test.skip : test;
// Negative-PGID signaling is POSIX-only; the provider's Windows cleanup path is
// taskkill-based and never signals a process group.
const posixOffline = source === undefined || process.platform === "win32" ? test.skip : test;
const pinnedOnly = source?.pinned === true ? test : test.skip;
const localOnly = source?.pinned === false ? test : test.skip;
const response = (records: Record<string, any>[], id: string) => records.find((record) => record.id === id);

for (const code of [0, 7] as const) {
	offline(`real Pi + local provider: fake Claude exit ${code}`, async () => {
		const { rpc, calls } = await runOffline(source!, code);
		expect(calls).toHaveLength(4);
		expect(calls.filter((call) => JSON.stringify(call.args) === '["--version"]')).toHaveLength(1);
		expect(calls.filter((call) => JSON.stringify(call.args) === '["auth","status"]')).toHaveLength(1);
		expect(calls.filter((call) => JSON.stringify(call.args) === '["--help"]')).toHaveLength(1);
		const request = calls.find((call) => call.args.includes("--input-format"));
		if (!request) throw new Error("Fake CLI request capture is missing");
		expect(request.args).toContain("--system-prompt-file");
		expect(request.args[request.args.indexOf("--model") + 1]).toBe("sonnet");
		expect(request.args[request.args.indexOf("--tools") + 1]).toBe("");
		expect(JSON.parse(request.args[request.args.indexOf("--settings") + 1]).disableAllHooks).toBe(true);
		expect(JSON.parse(request.args[request.args.indexOf("--mcp-config") + 1])).toEqual({ mcpServers: {} });
		expect(request.env.ANTHROPIC_API_KEY).toBeNull();
		expect(request.env.CLAUDE_CODE_OAUTH_TOKEN).toBeNull();
		expect(request.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
		const input = JSON.parse(request.stdin.trim());
		expect(input.type).toBe("user");
		expect(input.message.role).toBe("user");
		expect(JSON.stringify(input.message.content)).toContain("offline transport probe");
		const state = response(rpc, "state");
		expect(state?.success).toBe(true);
		expect(state?.data?.model?.provider).toBe("pi-claude-code-provider");
		expect(state?.data?.model?.id).toBe("sonnet");
		const models = response(rpc, "models");
		expect(models?.success).toBe(true);
		expect(models?.data?.models?.some((model: any) => model.provider === "pi-claude-code-provider" && model.id === "sonnet")).toBe(true);
		expect(response(rpc, "prompt")?.success).toBe(true);
		expect(rpc.some((record) => record.type === "agent_settled")).toBe(true);
		const messages = response(rpc, "messages");
		if (!messages) throw new Error("Pi get_messages response is missing");
		expect(messages?.success).toBe(true);
		const assistant = messages.data.messages.findLast((message: any) => message.role === "assistant");
		expect(assistant?.provider).toBe("pi-claude-code-provider");
		const event = rpc.findLast((record) => record.type === "message_end" && record.message?.role === "assistant");
		expect(event?.message?.stopReason).toBe(code === 0 ? "stop" : "error");
		expect(assistant?.stopReason).toBe(code === 0 ? "stop" : "error");
		if (code === 0) expect(assistant.content).toContainEqual({ type: "text", text: "OFFLINE_PROVIDER_OK" });
		else expect(assistant.errorMessage).toContain("exited after a successful result (code 7");
	}, 25_000);
}

posixOffline("real provider terminateProcessGroup may signal an exited child's negative PGID (spy only)", async () => {
	const work = mkdtempSync(join(tmpdir(), "provider-process-spy-"));
	try {
		stageSnapshot(source!.snapshot, work, source!.pinned);
		const { terminateProcessGroup } = await import(pathToFileURL(join(work, "provider/src/process-utils.ts")).href);
		const observed: Array<[number, string | number | undefined]> = [];
		const pid = 24681357; // deliberately no real child, no real process.kill
		await terminateProcessGroup({ pid, exitCode: 0, signalCode: null } as ChildProcess, 1, (target: number, signal?: string | number) => {
			observed.push([target, signal]);
			if (signal === 0) throw Object.assign(new Error("no group"), { code: "ESRCH" });
			return true;
		});
		expect(observed[0]).toEqual([-pid, "SIGTERM"]);
		expect(observed[1]).toEqual([-pid, 0]);
	} finally { rmSync(work, { recursive: true, force: true }); }
}, 10_000);

pinnedOnly("explicitly requested snapshot with modified anchored source fails closed", () => {
	const work = mkdtempSync(join(tmpdir(), "provider-bad-snapshot-"));
	try {
		const altered = join(work, "altered");
		mkdirSync(join(altered, "src"), { recursive: true });
		cpSync(join(source!.snapshot, "package.json"), join(altered, "package.json"));
		writeFileSync(join(altered, "src/claude-process.ts"), "// not the investigated provider\n");
		expect(() => stageSnapshot(altered, work)).toThrow("Provider snapshot hash mismatch: src/claude-process.ts");
	} finally { rmSync(work, { recursive: true, force: true }); }
});

localOnly("staged vendored module carries its public standalone entry and matches its recorded source hashes", () => {
	const work = mkdtempSync(join(tmpdir(), "provider-local-stage-"));
	try {
		const extension = stageSnapshot(source!.snapshot, work, source!.pinned);
		expect(extension.endsWith(join("provider", "index.ts"))).toBe(true);
		const hashes = JSON.parse(readFileSync(join(work, "snapshot-manifest.json"), "utf8")).hashes as Record<string, string>;
		for (const [file, expected] of Object.entries(hashes)) {
			expect(createHash("sha256").update(readFileSync(join(work, "provider", file))).digest("hex")).toBe(expected);
		}
	} finally { rmSync(work, { recursive: true, force: true }); }
});
