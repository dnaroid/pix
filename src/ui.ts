export type PopupMenuItem<T> = {
	value: T;
	label: string;
	description?: string;
};

export type VisiblePopupMenuItem<T> = PopupMenuItem<T> & {
	index: number;
	selected: boolean;
};

export class PopupMenu<T> {
	readonly maxVisibleRows: number;
	items: PopupMenuItem<T>[] = [];
	selectedIndex = 0;
	scrollOffset = 0;
	open = false;

	constructor(options: { maxVisibleRows: number }) {
		this.maxVisibleRows = Math.max(1, options.maxVisibleRows);
	}

	setItems(items: readonly PopupMenuItem<T>[]): void {
		this.items = [...items];
		this.selectedIndex = clamp(this.selectedIndex, 0, Math.max(0, this.items.length - 1));
		this.scrollOffset = clamp(this.scrollOffset, 0, this.maxScrollOffset());
		this.ensureSelectedVisible();
	}

	openWithItems(items: readonly PopupMenuItem<T>[]): void {
		this.open = true;
		this.setItems(items);
	}

	close(): void {
		this.open = false;
	}

	selectedItem(): PopupMenuItem<T> | undefined {
		return this.items[this.selectedIndex];
	}

	moveSelection(delta: number): void {
		if (this.items.length === 0) return;

		this.selectedIndex = clamp(this.selectedIndex + delta, 0, this.items.length - 1);
		this.ensureSelectedVisible();
	}

	scroll(delta: number): void {
		this.scrollOffset = clamp(this.scrollOffset + delta, 0, this.maxScrollOffset());
		this.selectedIndex = clamp(
			this.selectedIndex,
			this.scrollOffset,
			Math.min(this.items.length - 1, this.scrollOffset + this.maxVisibleRows - 1),
		);
	}

	visibleItems(): VisiblePopupMenuItem<T>[] {
		return this.items.slice(this.scrollOffset, this.scrollOffset + this.maxVisibleRows).map((item, offset) => {
			const index = this.scrollOffset + offset;
			return { ...item, index, selected: index === this.selectedIndex };
		});
	}

	maxScrollOffset(): number {
		return Math.max(0, this.items.length - this.maxVisibleRows);
	}

	private ensureSelectedVisible(): void {
		if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
			return;
		}

		const lastVisibleIndex = this.scrollOffset + this.maxVisibleRows - 1;
		if (this.selectedIndex > lastVisibleIndex) {
			this.scrollOffset = this.selectedIndex - this.maxVisibleRows + 1;
		}
	}
}

export const TOAST_KINDS = ["success", "error", "warning", "info"] as const;

export type ToastKind = (typeof TOAST_KINDS)[number];

export type ToastState = {
	message: string;
	kind: ToastKind;
};

export type ToastEntry = ToastState & {
	id: number;
	createdAt: number;
};

export type ToastNotifier = {
	show(message: string, kind?: ToastKind): void;
	success(message: string): void;
	error(message: string): void;
	warning(message: string): void;
	info(message: string): void;
};

export function isToastKind(value: unknown): value is ToastKind {
	return typeof value === "string" && (TOAST_KINDS as readonly string[]).includes(value);
}

export class Toast {
	private readonly entries: ToastEntry[] = [];
	private nextId = 1;

	show(message: string, kind: ToastKind = "info"): number {
		const id = this.nextId;
		this.nextId += 1;
		this.entries.push({ id, message, kind, createdAt: Date.now() });
		return id;
	}

	hide(id?: number): void {
		if (id === undefined) {
			this.entries.splice(0, this.entries.length);
			return;
		}

		const index = this.entries.findIndex((entry) => entry.id === id);
		if (index >= 0) this.entries.splice(index, 1);
	}

	get state(): ToastState | undefined {
		const entry = this.entries.at(-1);
		return entry ? { message: entry.message, kind: entry.kind } : undefined;
	}

	get visibleStates(): readonly ToastEntry[] {
		return this.entries;
	}

	entry(toastId: number): ToastEntry | undefined {
		return this.entries.find((entry) => entry.id === toastId);
	}

	get visible(): boolean {
		return this.entries.length > 0;
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
