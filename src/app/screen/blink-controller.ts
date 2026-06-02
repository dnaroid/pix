import { STATUS_BLINK_INTERVAL_MS } from "../constants.js";

export type AppBlinkRenderScope = "status-line" | "full";

export type AppBlinkControllerHost = {
	render(): void;
	renderStatusLine?(): void;
};

type BlinkConsumer = {
	active: boolean;
	visible: boolean;
	initialVisible: boolean;
	scope: AppBlinkRenderScope;
};

export class AppBlinkController {
	private readonly consumers = new Map<string, BlinkConsumer>();
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(private readonly host: AppBlinkControllerHost) {}

	setActive(key: string, active: boolean, options: { scope: AppBlinkRenderScope; initialVisible?: boolean; resetVisible?: boolean }): void {
		const initialVisible = options.initialVisible ?? true;
		const consumer = this.consumers.get(key) ?? {
			active: false,
			visible: initialVisible,
			initialVisible,
			scope: options.scope,
		};

		consumer.scope = options.scope;
		consumer.initialVisible = initialVisible;
		if (consumer.active !== active || options.resetVisible === true) {
			consumer.active = active;
			consumer.visible = initialVisible;
		}

		this.consumers.set(key, consumer);
		this.syncTimer();
	}

	visible(key: string, fallback = false): boolean {
		return this.consumers.get(key)?.visible ?? fallback;
	}

	dispose(): void {
		this.stopTimer();
		this.consumers.clear();
	}

	private syncTimer(): void {
		if (this.hasActiveConsumers()) {
			this.startTimer();
			return;
		}

		this.stopTimer();
	}

	private hasActiveConsumers(): boolean {
		return Array.from(this.consumers.values()).some((consumer) => consumer.active);
	}

	private startTimer(): void {
		if (this.timer) return;

		this.timer = setInterval(() => {
			this.tick();
		}, STATUS_BLINK_INTERVAL_MS);
		this.timer.unref?.();
	}

	private stopTimer(): void {
		if (!this.timer) return;

		clearInterval(this.timer);
		this.timer = undefined;
	}

	private tick(): void {
		let renderScope: AppBlinkRenderScope | undefined;
		for (const consumer of this.consumers.values()) {
			if (!consumer.active) continue;

			consumer.visible = !consumer.visible;
			renderScope = maxRenderScope(renderScope, consumer.scope);
		}

		if (renderScope === "full") {
			this.host.render();
			return;
		}

		if (renderScope === "status-line") {
			if (this.host.renderStatusLine) {
				this.host.renderStatusLine();
				return;
			}

			this.host.render();
		}
	}
}

function maxRenderScope(current: AppBlinkRenderScope | undefined, next: AppBlinkRenderScope): AppBlinkRenderScope {
	if (current === "full" || next === "full") return "full";
	return "status-line";
}
