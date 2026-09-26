import type { WorkspaceToolId } from "../types.js";

export type WorkspaceToolSurfaceLine = {
	text: string;
	variant?: "normal" | "muted" | "error" | "accent";
	action?: string;
	control?: "button";
};

export type WorkspaceToolSurfaceSnapshot = {
	title: string;
	subtitle?: string;
	lines: readonly WorkspaceToolSurfaceLine[];
	footer?: string;
};

export interface WorkspaceToolSurface {
	readonly id: WorkspaceToolId;
	open(): void | Promise<void>;
	close?(): void;
	canClose?(): boolean;
	snapshot(): WorkspaceToolSurfaceSnapshot;
	handleInput?(data: string): boolean;
	activate?(action: string): void | Promise<void>;
	scroll?(delta: number): void;
}

export type WorkspaceToolControllerHost = {
	render(): void;
};

const FALLBACK_SURFACES: Record<WorkspaceToolId, WorkspaceToolSurfaceSnapshot> = {
	tasks: {
		title: "Tasks",
		subtitle: "Project tasks",
		lines: [{ text: "Loading Tasks support…", variant: "muted" }],
	},
	registry: {
		title: "Registry",
		subtitle: "Workspace resource registry",
		lines: [{ text: "Loading Registry support…", variant: "muted" }],
	},
	idx: {
		title: "IDX",
		subtitle: "Repository intelligence",
		lines: [{ text: "Loading IDX support…", variant: "muted" }],
	},
	settings: {
		title: "Settings",
		subtitle: "Pix and tools configuration",
		lines: [{ text: "Loading Settings support…", variant: "muted" }],
	},
};

export class WorkspaceToolController {
	private active: WorkspaceToolId | undefined;
	private generation = 0;
	private readonly surfaces = new Map<WorkspaceToolId, WorkspaceToolSurface>();
	private readonly scrollOffsets = new Map<WorkspaceToolId, number>();

	constructor(private readonly host: WorkspaceToolControllerHost) {}

	get activeTool(): WorkspaceToolId | undefined {
		return this.active;
	}

	get isOpen(): boolean {
		return this.active !== undefined;
	}

	register(surface: WorkspaceToolSurface): void {
		this.surfaces.set(surface.id, surface);
	}

	isActive(tool: WorkspaceToolId): boolean {
		return this.active === tool;
	}

	toggle(tool: WorkspaceToolId): void {
		if (this.active === tool) {
			this.close();
			return;
		}

		const previous = this.active;
		if (previous) {
			const previousSurface = this.surfaces.get(previous);
			if (previousSurface?.canClose?.() === false) return;
			previousSurface?.close?.();
		}
		this.active = tool;
		this.scrollOffsets.set(tool, 0);
		const generation = ++this.generation;
		this.host.render();
		const opened = this.surfaces.get(tool)?.open();
		if (opened && typeof (opened as Promise<void>).then === "function") {
			void Promise.resolve(opened).catch(() => undefined).finally(() => {
				if (this.active === tool && this.generation === generation) this.host.render();
			});
		}
	}

	close(): void {
		const active = this.active;
		if (!active) return;
		if (this.surfaces.get(active)?.canClose?.() === false) return;
		this.generation += 1;
		this.active = undefined;
		this.surfaces.get(active)?.close?.();
		this.host.render();
	}

	snapshot(): WorkspaceToolSurfaceSnapshot | undefined {
		if (!this.active) return undefined;
		const snapshot = this.surfaces.get(this.active)?.snapshot() ?? FALLBACK_SURFACES[this.active];
		const offset = this.scrollOffsets.get(this.active) ?? 0;
		if (offset <= 0) return snapshot;
		return {
			...snapshot,
			lines: snapshot.lines.slice(offset),
			footer: `${snapshot.footer ?? "Esc/q close"} · ↑ ${offset} hidden row${offset === 1 ? "" : "s"}`,
		};
	}

	handleTerminalInput(data: string): { consume: boolean; data?: string } {
		if (!this.active) return { consume: false, data };
		const handled = this.surfaces.get(this.active)?.handleInput?.(data) ?? false;
		if (handled) {
			this.host.render();
			return { consume: true };
		}
		if (data === "\x1b[5~") {
			this.scroll(-10);
			return { consume: true };
		}
		if (data === "\x1b[6~") {
			this.scroll(10);
			return { consume: true };
		}
		if (data === "\x1b" || data === "q" || data === "Q") {
			this.close();
			return { consume: true };
		}
		return { consume: true };
	}

	activate(action: string): void {
		if (action === "close") {
			this.close();
			return;
		}
		if (!this.active) return;
		const result = this.surfaces.get(this.active)?.activate?.(action);
		if (result && typeof (result as Promise<void>).then === "function") {
			void Promise.resolve(result).catch(() => undefined).finally(() => this.host.render());
		} else {
			this.host.render();
		}
	}

	scroll(delta: number): void {
		if (!this.active) return;
		const surface = this.surfaces.get(this.active);
		if (surface?.scroll) {
			surface.scroll(delta);
		} else {
			const maxOffset = Math.max(0, (surface?.snapshot() ?? FALLBACK_SURFACES[this.active]).lines.length - 1);
			const current = this.scrollOffsets.get(this.active) ?? 0;
			this.scrollOffsets.set(this.active, Math.max(0, Math.min(maxOffset, current + delta)));
		}
		this.host.render();
	}
}
