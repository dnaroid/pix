import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import {
	FONT_DOWNLOAD_URL,
	FONT_FILE_NAME,
	installJetBrainsNerdFont,
	isJetBrainsNerdFontInstalled,
	NerdFontController,
	setNerdFontControllerTestDeps,
	userFontInstallPath,
} from "../src/app/terminal/nerd-font-controller.js";

describe("NerdFontController", () => {
	it("detects installed fonts through brew, fc-match, and scanned font directories", async () => {
		const restoreBrew = setNerdFontControllerTestDeps({
			commandExists: async (command) => command === "brew",
			runProcess: async () => processResult(0),
		});
		try {
			assert.equal(await isJetBrainsNerdFontInstalled(), true);
		} finally {
			restoreBrew();
		}

		const restoreScan = setNerdFontControllerTestDeps({
			commandExists: async () => false,
			existsSync: () => true,
			readdir: async () => [file("JetBrainsMonoNerd-Regular.ttf")],
		});
		try {
			assert.equal(await isJetBrainsNerdFontInstalled(), true);
		} finally {
			restoreScan();
		}
	});

	it("ignores missing or unreadable font directories while scanning", async () => {
		const restore = setNerdFontControllerTestDeps({
			commandExists: async () => false,
			existsSync: (path) => !String(path).includes(".local"),
			readdir: async () => { throw new Error("permission denied"); },
		});
		try {
			assert.equal(await isJetBrainsNerdFontInstalled(), false);
		} finally {
			restore();
		}
	});

	it("downloads and writes a font without running real network or filesystem operations", async () => {
		const calls: string[] = [];
		const restore = setNerdFontControllerTestDeps({
			commandExists: async () => false,
			fetch: (async (url) => {
				calls.push(`fetch:${url}`);
				return { ok: true, arrayBuffer: async () => new Uint8Array(100_001).buffer } as Response;
			}) as never,
			mkdir: (async (path) => { calls.push(`mkdir:${path}`); return undefined; }) as never,
			writeFile: async (path, data) => { calls.push(`write:${path}:${(data as Uint8Array).byteLength}`); },
			runProcess: async (command, args = []) => {
				calls.push(`run:${command}:${args.join(" ")}`);
				return processResult(0);
			},
		});
		try {
			const path = await installJetBrainsNerdFont();
			assert.equal(path.endsWith(FONT_FILE_NAME), true);
			assert.equal(calls.some((call) => call === `fetch:${FONT_DOWNLOAD_URL}`), true);
			assert.equal(calls.some((call) => call.startsWith("write:") && call.endsWith(":100001")), true);
		} finally {
			restore();
		}
	});

	it("rejects failed or suspiciously small font downloads", async () => {
		const restoreFailed = setNerdFontControllerTestDeps({
			commandExists: async () => false,
			mkdir: (async () => undefined) as never,
			fetch: (async () => ({ ok: false, status: 503 } as Response)) as never,
		});
		try {
			await assert.rejects(() => installJetBrainsNerdFont(), /HTTP 503/u);
		} finally {
			restoreFailed();
		}

		const restoreSmall = setNerdFontControllerTestDeps({
			commandExists: async () => false,
			mkdir: (async () => undefined) as never,
			fetch: (async () => ({ ok: true, arrayBuffer: async () => new Uint8Array(12).buffer } as Response)) as never,
		});
		try {
			await assert.rejects(() => installJetBrainsNerdFont(), /unexpectedly small/u);
		} finally {
			restoreSmall();
		}
	});

	it("reports startup install success, warning, and errors only once", async () => {
		let installed = false;
		const host = fakeHost();
		const restore = setNerdFontControllerTestDeps({
			commandExists: async () => false,
			existsSync: () => installed,
			readdir: async () => [file("JetBrainsNerdFontMono-Regular.ttf")],
			fetch: (async () => ({ ok: true, arrayBuffer: async () => {
				installed = true;
				return new Uint8Array(100_001).buffer;
			} } as Response)) as never,
			mkdir: (async () => undefined) as never,
			writeFile: async () => {},
			runProcess: async () => processResult(0),
		});
		try {
			const controller = new NerdFontController(host);
			controller.ensureInstalledOnStartup();
			controller.ensureInstalledOnStartup();
			await waitFor(() => host.renders === 1);
			assert.deepEqual(host.toasts.map((toast) => toast.kind), ["info", "success"]);
		} finally {
			restore();
		}
	});

	it("handles brew install stderr and exposes platform user font paths", async () => {
		const restore = setNerdFontControllerTestDeps({
			commandExists: async (command) => command === "brew",
			spawn: (() => {
				const child = new EventEmitter() as EventEmitter & { stderr: PassThrough };
				child.stderr = new PassThrough();
				queueMicrotask(() => {
					child.stderr.emit("data", Buffer.from("brew failed"));
					child.emit("close", 1);
				});
				return child;
			}) as never,
		});
		try {
			if (process.platform === "darwin") await assert.rejects(() => installJetBrainsNerdFont(), /brew failed/u);
			assert.equal(userFontInstallPath().endsWith(FONT_FILE_NAME), true);
		} finally {
			restore();
		}
	});
});

function file(name: string): never {
	return { name, isFile: () => true, isDirectory: () => false } as never;
}

function processResult(status: number): never {
	return { status, signal: null, stdout: "", stderr: "" } as never;
}

function fakeHost() {
	return {
		toasts: [] as Array<{ message: string; kind: string }>,
		renders: 0,
		showToast(message: string, kind: "success" | "error" | "warning" | "info") {
			this.toasts.push({ message, kind });
		},
		requestRender() {
			this.renders += 1;
		},
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 500;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for predicate");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
