import { describe, expect, test } from "bun:test";
import { registerPixEventHandlers, type PixMirrorHooks } from "../src/telegram-mirror/events.js";
import type { RendererEvent } from "../src/telegram-mirror/renderer.js";

class FakePi {
	readonly events = new Map<string, Array<(event: any, ctx?: any) => void>>();

	on(name: string, handler: (event: any, ctx?: any) => void): void {
		const handlers = this.events.get(name) ?? [];
		handlers.push(handler);
		this.events.set(name, handlers);
	}

	emit(name: string, event: any = {}, ctx?: any): void {
		for (const handler of this.events.get(name) ?? []) handler(event, ctx);
	}
}

describe("telegram mirror lifecycle events", () => {
	test("ends the mirrored turn only after agent_settled", () => {
		const pi = new FakePi();
		const rendered: RendererEvent[] = [];
		let settledNotifications = 0;
		const hooks: PixMirrorHooks = {
			getRenderer: () => ({ push: (event) => rendered.push(event) }),
			describeInstance: () => ({ label: "pix", cwd: "/tmp/project" }),
			notifyAgentSettled: () => {
				settledNotifications += 1;
			},
		};

		registerPixEventHandlers(pi as any, hooks);
		pi.emit("agent_start");
		pi.emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "first" } });
		pi.emit("agent_end", { willRetry: false });
		pi.emit("agent_start");
		pi.emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: " continued" } });
		pi.emit("agent_end", { willRetry: false });

		expect(rendered.map((event) => event.kind)).toEqual([
			"turn_start",
			"assistant_text",
			"assistant_text",
		]);
		expect(settledNotifications).toBe(0);

		pi.emit("agent_settled");
		expect(rendered[rendered.length - 1]).toEqual({ kind: "turn_end", reason: "end" });
		expect(settledNotifications).toBe(1);
	});
});
