import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadSubagentConfig, type SubagentConfig } from "../../src/async-subagents/core/config.js";
import { routeSubagentTasks, type SubagentRoutingContext } from "../../src/async-subagents/core/routing.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function config(): SubagentConfig {
	return {
		defaultType: "quick",
		routing: { model: "test/router", fallbackModels: [], maxRetries: 0 },
		types: { quick: {}, review: {}, deep: {} },
	};
}

function response(text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return { content: [{ type: "text", text }], stopReason: "stop", ...extra } as AssistantMessage;
}

function context(respond: (model: Model<Api>, prompt: Context) => Promise<AssistantMessage>) {
	const complete = mock(respond);
	const find = mock((provider: string, id: string) => ({ provider, id }) as Model<Api>);
	const getApiKeyAndHeaders = mock(async () => ({ ok: true as const }));
	const ctx: SubagentRoutingContext = { modelRegistry: { find, getApiKeyAndHeaders, complete } };
	return { ctx, complete, find, getApiKeyAndHeaders };
}

describe("parent-first sub-agent routing", () => {
	test("preserves explicit roles without any router/auth calls even when routing is disabled", async () => {
		const live = context(async () => { throw new Error("must not call the router"); });
		const tasks = [{ id: "r", task: "Review changes", subagentType: "review" }];
		const cfg = config();
		cfg.routing!.enabled = false;
		expect(await routeSubagentTasks(tasks, cfg, live.ctx)).toEqual({ tasks, usedLlm: false, routes: {}, warnings: [] });
		expect(live.complete).not.toHaveBeenCalled();
		expect(live.find).not.toHaveBeenCalled();
		expect(live.getApiKeyAndHeaders).not.toHaveBeenCalled();
	});

	for (const subagentType of ["rewiev", "toString", "__proto__"]) {
		test(`rejects unknown explicit type ${subagentType} before routing a mixed batch`, async () => {
			const live = context(async () => response('{"routes":[{"id":"auto","subagentType":"deep"}]}'));
			await expect(routeSubagentTasks([
				{ id: "explicit", task: "Review changes", subagentType },
				{ id: "auto", task: "Investigate the race" },
			], config(), live.ctx)).rejects.toThrow(/Unknown subagentType/);
			expect(live.complete).not.toHaveBeenCalled();
		});
	}

	test("routes only omitted roles and cannot overwrite the parent's explicit choice", async () => {
		const live = context(async (_model, prompt) => {
			const text = JSON.stringify(prompt.messages);
			expect(text).toContain("Investigate the race");
			expect(text).not.toContain("Explicit task stays private");
			return response('{"routes":[{"id":"auto","subagentType":"deep"},{"id":"explicit","subagentType":"quick"}]}');
		});
		const result = await routeSubagentTasks([
			{ id: "explicit", task: "Explicit task stays private", subagentType: "review" },
			{ id: "auto", task: "Investigate the race" },
		], config(), live.ctx);
		expect(result.routes).toEqual({ auto: "deep" });
		expect(result.tasks.map((task) => task.subagentType)).toEqual(["review", "deep"]);
		expect(live.complete).toHaveBeenCalledTimes(1);
	});

	test("treats parent-model-gated roles as unavailable for explicit and automatic routing", async () => {
		const cfg = config();
		cfg.types.review = {
			forParentModels: ["test/*"],
			notForParentModels: ["test/frontier"],
		};
		const blocked = context(async () => { throw new Error("must not call the router"); });
		blocked.ctx.model = { provider: "test", id: "frontier" };
		await expect(routeSubagentTasks([
			{ id: "explicit", task: "Review changes", subagentType: "review" },
		], cfg, blocked.ctx)).rejects.toThrow(/subagentType unavailable for parent model test\/frontier/);
		expect(blocked.complete).not.toHaveBeenCalled();

		const auto = context(async (_model, prompt) => {
			const text = JSON.stringify(prompt.messages);
			expect(text).not.toContain("review:");
			return response('{"routes":[{"id":"auto","subagentType":"deep"}]}');
		});
		auto.ctx.model = { provider: "test", id: "frontier" };
		const result = await routeSubagentTasks([{ id: "auto", task: "Investigate the race" }], cfg, auto.ctx);
		expect(result.routes).toEqual({ auto: "deep" });
	});

	test("frontier-review is routable for a non-frontier parent and rejected for a frontier parent", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-frontier-review-test-"));
		tempDirs.push(cwd);
		const cfg = loadSubagentConfig(cwd, {});
		cfg.routing = config().routing;

		const nonFrontier = context(async (_model, prompt) => {
			expect(JSON.stringify(prompt.messages)).toContain("frontier-review:");
			return response('{"routes":[{"id":"review","subagentType":"frontier-review"}]}');
		});
		nonFrontier.ctx.model = { provider: "openai-codex", id: "gpt-5.6-luna" };
		const routed = await routeSubagentTasks([{ id: "review", task: "Review the implementation" }], cfg, nonFrontier.ctx);
		expect(routed.tasks[0]?.subagentType).toBe("frontier-review");

		const frontier = context(async () => { throw new Error("must not call the router"); });
		frontier.ctx.model = { provider: "openai-codex", id: "gpt-5.6-sol" };
		await expect(routeSubagentTasks([
			{ id: "review", task: "Review the implementation", subagentType: "frontier-review" },
		], cfg, frontier.ctx)).rejects.toThrow(/subagentType unavailable for parent model openai-codex\/gpt-5\.6-sol/);
		expect(frontier.complete).not.toHaveBeenCalled();
	});

	test("errors on omitted roles with no runtime rather than silently choosing quick", async () => {
		await expect(routeSubagentTasks([{ id: "audit", task: "Audit the payment flow" }], config(), {}))
			.rejects.toThrow(/Set an explicit valid subagentType/);
	});

	test("requires explicit roles when the LLM router is disabled, regardless of defaultType", async () => {
		const cfg = config();
		cfg.routing!.enabled = false;
		await expect(routeSubagentTasks([{ id: "audit", task: "Audit the payment flow" }], cfg, {}))
			.rejects.toThrow(/routing is disabled/);
	});

	for (const text of ["", "not JSON", '{"routes":[]}', '{"routes":[{"id":"audit","subagentType":"invented"}]}']) {
		test(`rejects invalid/missing routes: ${JSON.stringify(text)}`, async () => {
			const live = context(async () => response(text));
			await expect(routeSubagentTasks([{ id: "audit", task: "Audit the payment flow" }], config(), live.ctx))
				.rejects.toThrow(/valid route/);
		});
	}

	test("does not return a partially routed batch as a successful spawn plan", async () => {
		const live = context(async () => response('{"routes":[{"id":"first","subagentType":"review"}]}'));
		await expect(routeSubagentTasks([
			{ id: "first", task: "Audit" },
			{ id: "second", task: "Root cause" },
		], config(), live.ctx)).rejects.toThrow(/1\/2 valid route/);
	});

	test("treats a provider error response as failure, not successful LLM routing", async () => {
		const live = context(async () => response("", { stopReason: "error", errorMessage: "Provider is not configured" }));
		await expect(routeSubagentTasks([{ id: "audit", task: "Audit" }], config(), live.ctx))
			.rejects.toThrow(/Provider is not configured/);
	});

	for (const failure of ["provider-error", "invalid-json", "exception"]) {
		test(`tries the configured fallback router after ${failure}`, async () => {
			const live = context(async (model) => {
				if (model.id === "router") {
					if (failure === "exception") throw new Error("Request failed");
					return failure === "provider-error"
						? response("", { stopReason: "error", errorMessage: "Provider failed" })
						: response("invalid JSON");
				}
				return response('{"routes":[{"id":"audit","subagentType":"review"}]}');
			});
			const cfg = config();
			cfg.routing!.fallbackModels = ["test/backup"];
			const result = await routeSubagentTasks([{ id: "audit", task: "Audit" }], cfg, live.ctx);
			expect(result.routes).toEqual({ audit: "review" });
			expect(live.complete.mock.calls.map(([model]) => model.id)).toEqual(["router", "backup"]);
		});
	}

	test("propagates cancellation instead of falling back or returning a spawn plan", async () => {
		const live = context(async () => response("", { stopReason: "aborted" }));
		const cfg = config();
		cfg.routing!.fallbackModels = ["test/backup"];
		await expect(routeSubagentTasks([{ id: "audit", task: "Audit" }], cfg, live.ctx)).rejects.toThrow(/Aborted/);
		expect(live.complete).toHaveBeenCalledTimes(1);
		const controller = new AbortController();
		controller.abort();
		await expect(routeSubagentTasks([{ id: "r", task: "Review", subagentType: "review" }], cfg, live.ctx, controller.signal))
			.rejects.toThrow(/Aborted/);
	});

	test("uses the same project-local catalog for explicit and automatic roles", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-router-test-"));
		tempDirs.push(cwd);
		const dir = path.join(cwd, ".pi", "agents");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "house-review.md"), "---\ndescription: Review the house rules and repository conventions.\n---\nFollow the house checklist.\n");
		const cfg = loadSubagentConfig(cwd, {});
		cfg.routing = config().routing;
		const live = context(async (_model, prompt) => {
			expect(JSON.stringify(prompt.messages)).toContain("house-review: Review the house rules and repository conventions.");
			return response('{"routes":[{"id":"auto","subagentType":"house-review"}]}');
		});
		const result = await routeSubagentTasks([
			{ id: "explicit", task: "House review", subagentType: "house-review" },
			{ id: "auto", task: "Review the house rules" },
		], cfg, live.ctx);
		expect(result.tasks.map((task) => task.subagentType)).toEqual(["house-review", "house-review"]);
		expect(result.routes).toEqual({ auto: "house-review" });
	});
});
