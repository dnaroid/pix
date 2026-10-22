import { ANSI_RESET, ansiStylePrefix, colorize, THEMES, type Theme, type ThemeName } from "../../theme.js";
import { isToastKind, type ToastKind, type ToastNotifier } from "../../ui.js";
import type { ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import type { InputEditorDraftState } from "../../input-editor.js";
import type {
	Entry,
	ExtensionInputMouseEvent,
	ExtensionWidgetComponent,
	ExtensionWidgetContent,
	ExtensionWidgetFactory,
	ExtensionWidgetRegistration,
	ExtensionWidgetTheme,
	PixExtensionUIContext,
	PixEditorSnapshot,
	PixMenuController,
	PixMenuItem,
	PixMenuOptions,
	WidgetPlacement,
	WidgetTuiHandle,
} from "../types.js";
import { ellipsizeDisplay, sanitizeText } from "../rendering/render-text.js";

type TerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

type TerminalInputHandlingResult = { consume?: boolean; data?: string } | void;

type FocusedCustomComponent = ExtensionWidgetComponent & {
	handleInput?(data: string): TerminalInputHandlingResult;
	handleMouse?(event: ExtensionInputMouseEvent): boolean | void;
	usesEditor?(): boolean;
};

type CustomUiFactory<T> = (
	tui: unknown,
	theme: unknown,
	keybindings: unknown,
	done: (result: T) => void,
) => FocusedCustomComponent | Promise<FocusedCustomComponent>;

type DialogBase = {
	scopeKey: string;
	settled: boolean;
	resolve(value: unknown): void;
	reject(error: unknown): void;
};

/** Focused custom UI (ctx.ui.custom, input, editor) rendered in the editor area. */
type ActiveCustomUi = DialogBase & {
	kind: "custom";
	key: string;
	component?: FocusedCustomComponent;
	savedInput?: InputEditorDraftState;
};

/** select/confirm shown through the shared host popup menu. */
type MenuDialog = DialogBase & {
	kind: "menu";
	open(): Promise<unknown>;
	/** True while this dialog owns the host popup menu. */
	showing: boolean;
	/** Bumped on every show/suspend so stale host resolutions are ignored. */
	generation: number;
};

type ExtensionDialog = ActiveCustomUi | MenuDialog;

type DialogOutcome = { resolve: true; value: unknown } | { resolve: false; error: unknown };

type ScopedWidgetRegistration = ExtensionWidgetRegistration & {
	scopeKey: string;
};

type ScopedTerminalInputHandler = {
	scopeKey: string;
	handler: TerminalInputHandler;
};

export type ExtensionTerminalInputResult = {
	consume: boolean;
	data?: string;
};

const CUSTOM_UI_WIDGET_KEY = "pix-custom-ui";

export type ExtensionUiControllerHost = {
	readonly theme: Theme;
	activeExtensionUiScope?(): string | undefined;
	isExtensionUiScopeActive?(scopeKey: string): boolean;
	isRunning(): boolean;
	render(): void;
	showToast(message: string, kind?: ToastKind, options?: { scopeKey?: string }): void;
	readonly toastNotifier: ToastNotifier;
	toastNotifierForScope?(scopeKey: string | undefined): ToastNotifier;
	readonly menuController: PixMenuController;
	setStatus(status: string): void;
	restoreSessionStatus(): void;
	setInput(value: string): void;
	getInput(): string;
	setInputState(state: InputEditorDraftState): void;
	getInputState(): InputEditorDraftState;
	setInputSnapshot(snapshot: PixEditorSnapshot): void;
	getInputSnapshot(): PixEditorSnapshot;
	readonly entries: readonly Entry[];
	deleteConversationEntry(entryId: string): void;
};

export class ExtensionUiController {
	private readonly extensionWidgets = new Map<string, ScopedWidgetRegistration>();
	private readonly quotaWaitStatuses = new Map<string, { label: string | undefined }>();
	private readonly terminalInputHandlers = new Set<ScopedTerminalInputHandler>();
	/**
	 * Per-scope dialog stacks. Only the top dialog is visible and receives input;
	 * a newer dialog hides (not settles) the one below, and settling the top shows
	 * the previous one again.
	 */
	private readonly dialogStacks = new Map<string, ExtensionDialog[]>();
	constructor(private readonly host: ExtensionUiControllerHost) {}

	get widgets(): ReadonlyMap<string, ExtensionWidgetRegistration> {
		const activeScopeKey = this.activeScopeKey();
		return new Map(
			[...this.extensionWidgets.entries()]
				.filter(([, widget]) => widget.scopeKey === activeScopeKey)
				.map(([scopedKey, widget]) => [this.unscopedWidgetKey(scopedKey, widget.scopeKey), widget]),
		);
	}

	quotaWaitStatusLabel(): string | undefined {
		return this.quotaWaitStatuses.get(this.activeScopeKey())?.label;
	}

	createExtensionTheme(): ExtensionWidgetTheme {
		const colors = this.host.theme.colors;
		const foreground = (color: unknown): string => extensionForegroundColor(colors, String(color));
		const background = (color: unknown): string => extensionBackgroundColor(colors, String(color));
		const prefix = (options: { foreground?: string; background?: string; bold?: boolean }): string => ansiStylePrefix(options);

		return {
			fg: (color: unknown, text: string) => colorize(text, { foreground: foreground(color) }),
			bg: (color: unknown, text: string) => colorize(text, { background: background(color) }),
			bold: (text: string) => colorize(text, { bold: true }),
			italic: (text: string) => text,
			underline: (text: string) => text,
			inverse: (text: string) => `\x1b[7m${text}${ANSI_RESET}`,
			strikethrough: (text: string) => colorize(text, { strikethrough: true }),
			getFgAnsi: (color: unknown) => prefix({ foreground: foreground(color) }),
			getBgAnsi: (color: unknown) => prefix({ background: background(color) }),
			getColorMode: () => "truecolor",
			getThinkingBorderColor: () => (text: string) => colorize(text, { foreground: colors.accent }),
			getBashModeBorderColor: () => (text: string) => colorize(text, { foreground: colors.info }),
			style: (text: string, options: { foreground?: unknown; background?: unknown; bold?: boolean }) => colorize(text, {
				...(options.foreground === undefined ? {} : { foreground: foreground(options.foreground) }),
				...(options.background === undefined ? {} : { background: background(options.background) }),
				...(options.bold === undefined ? {} : { bold: options.bold }),
			}),
		} as unknown as ExtensionWidgetTheme;
	}

	setWidget(key: string, content: unknown, options?: { placement?: WidgetPlacement; scopeKey?: string }): void {
		const scopeKey = this.normalizeScopeKey(options?.scopeKey);
		const scopedKey = this.scopedWidgetKey(scopeKey, key);
		const existing = this.extensionWidgets.get(scopedKey);
		if (existing) this.invalidateWidget(existing);

		if (content === undefined) {
			this.extensionWidgets.delete(scopedKey);
			if (this.host.isRunning()) this.host.render();
			return;
		}

		if (!Array.isArray(content) && typeof content !== "function") return;

		this.extensionWidgets.set(scopedKey, {
			key,
			scopeKey,
			placement: options?.placement === "belowEditor" ? "belowEditor" : "aboveEditor",
			content: content as readonly string[] | ExtensionWidgetFactory,
		});
		if (this.host.isRunning()) this.host.render();
	}

	clearWidgets(scopeKey?: string, options: { cancelCustomUi?: boolean } = {}): void {
		const normalizedScopeKey = this.normalizeScopeKey(scopeKey);
		this.quotaWaitStatuses.delete(normalizedScopeKey);
		if (options.cancelCustomUi !== false) this.cancelActiveCustomUi(normalizedScopeKey);
		for (const [key, widget] of this.extensionWidgets.entries()) {
			if (widget.scopeKey !== normalizedScopeKey) continue;
			this.invalidateWidget(widget);
			this.extensionWidgets.delete(key);
		}
	}

	cancelCustomUi(scopeKey = this.activeScopeKey()): void {
		this.cancelActiveCustomUi(this.normalizeScopeKey(scopeKey));
	}

	suppressWidget(key: string): void {
		const scopedKey = this.scopedWidgetKey(this.activeScopeKey(), key);
		const widget = this.extensionWidgets.get(scopedKey);
		if (!widget) return;
		this.invalidateWidget(widget);
		this.extensionWidgets.delete(scopedKey);
	}

	handleTerminalInput(data: string): ExtensionTerminalInputResult {
		const active = this.activeCustomUiForActiveScope();
		if (active?.component) {
			if (data === "\u0003") return { consume: false };
			try {
				const result = active.component.handleInput?.(data);
				if (result && typeof result === "object") {
					return {
						consume: result.consume !== false,
						...(result.data !== undefined ? { data: result.data } : {}),
					};
				}
			} catch (error) {
				this.rejectActiveCustomUi(error);
			}
			return { consume: true };
		}

		let current = data;
		const activeScopeKey = this.activeScopeKey();
		for (const { scopeKey, handler } of [...this.terminalInputHandlers]) {
			if (scopeKey !== activeScopeKey) continue;
			const result = handler(current);
			if (result?.data !== undefined) current = result.data;
			if (result?.consume === true) return { consume: true };
		}
		return current === data ? { consume: false } : { consume: false, data: current };
	}

	renderActiveCustomUi(width: number): string[] | undefined {
		const active = this.activeCustomUiForActiveScope();
		if (!active?.component) return undefined;
		try {
			return active.component.render(width);
		} catch (error) {
			return [`${active.key}: custom UI render failed: ${String(error)}`];
		}
	}

	activeCustomUiUsesEditor(): boolean {
		const active = this.activeCustomUiForActiveScope();
		if (!active?.component) return false;
		try {
			return active.component.usesEditor?.() === true;
		} catch {
			return false;
		}
	}

	handleCustomUiMouse(event: ExtensionInputMouseEvent): boolean {
		const active = this.activeCustomUiForActiveScope();
		if (!active?.component) return false;
		try {
			return active.component.handleMouse?.(event) === true;
		} catch (error) {
			this.rejectActiveCustomUi(error);
			return true;
		}
	}

	widgetTuiHandle(scopeKey = this.activeScopeKey()): WidgetTuiHandle {
		const activeScopeToastNotifier = this.host.toastNotifierForScope?.(scopeKey) ?? this.host.toastNotifier;
		const menuController = this.scopedMenuController(scopeKey);
		return {
			requestRender: () => {
				if (this.host.isRunning() && this.isScopeActive(scopeKey)) this.host.render();
			},
			showToast: activeScopeToastNotifier.show,
			toast: activeScopeToastNotifier,
			showMenu: menuController.show,
			menu: menuController,
			pix: {
				delegatedEditorInput: true,
				inputMouse: true,
			},
		};
	}

	createExtensionUIContext(scopeKey?: string): PixExtensionUIContext {
		const contextScopeKey = this.normalizeScopeKey(scopeKey);
		let quotaWaitStatus = this.quotaWaitStatuses.get(contextScopeKey);
		if (!quotaWaitStatus) {
			quotaWaitStatus = { label: undefined };
			this.quotaWaitStatuses.set(contextScopeKey, quotaWaitStatus);
		}
		const ownedQuotaWaitStatus = quotaWaitStatus;
		const scopedToastNotifier = this.host.toastNotifierForScope?.(contextScopeKey) ?? this.host.toastNotifier;
		const notify = (message: string, type?: ToastKind | string): void => {
			this.host.showToast(message, isToastKind(type) ? type : "info", { scopeKey: contextScopeKey });
		};

		const extensionTheme = this.createExtensionTheme();
		const menuController = this.scopedMenuController(contextScopeKey);
		const renderIfRunning = (): void => {
			if (this.host.isRunning() && this.isScopeActive(contextScopeKey)) this.host.render();
		};

		return {
			select: async (title, options, opts) => await this.selectDialog(title, options, opts, contextScopeKey),
			confirm: async (title, message, opts) => await this.confirmDialog(title, message, opts, contextScopeKey),
			input: async (title, placeholder, opts) => await this.inputDialog(title, placeholder, opts, contextScopeKey),
			notify,
			toast: scopedToastNotifier,
			aboveInput: {
				set: (key, content) => {
					this.setAboveInputWidget(key, content, contextScopeKey);
				},
				clear: (key) => {
					this.clearAboveInputWidget(key, contextScopeKey);
				},
			},
			renderAboveInput: (key, content) => {
				this.setAboveInputWidget(key, content, contextScopeKey);
			},
			showMenu: menuController.show,
			menu: menuController,
			onTerminalInput: (handler) => {
				const terminalInputHandler = { scopeKey: contextScopeKey, handler: handler as TerminalInputHandler };
				this.terminalInputHandlers.add(terminalInputHandler);
				return () => {
					this.terminalInputHandlers.delete(terminalInputHandler);
				};
			},
			setStatus: (key, text) => {
				if (key === "quota-wait") {
					// A repeating countdown belongs in status chrome, not in transient toasts.
					// Contexts invalidated by a session rebind cannot update its replacement.
					if (this.quotaWaitStatuses.get(contextScopeKey) !== ownedQuotaWaitStatus || ownedQuotaWaitStatus.label === text) return;
					ownedQuotaWaitStatus.label = text;
					renderIfRunning();
					return;
				}
				if (!this.isScopeActive(contextScopeKey)) return;
				if (text) this.host.showToast(text, "info", { scopeKey: contextScopeKey });
				this.host.restoreSessionStatus();
				renderIfRunning();
			},
			setWorkingMessage: (message) => {
				if (!this.isScopeActive(contextScopeKey)) return;
				if (message) this.host.showToast(message, "info", { scopeKey: contextScopeKey });
				this.host.restoreSessionStatus();
				renderIfRunning();
			},
			setWorkingVisible: () => undefined,
			setWorkingIndicator: () => undefined,
			setHiddenThinkingLabel: () => undefined,
			setWidget: ((key: string, content: unknown, options?: { placement?: WidgetPlacement }) => {
				this.setWidget(key, content, { ...options, scopeKey: contextScopeKey });
			}) as PixExtensionUIContext["setWidget"],
			setFooter: () => undefined,
			setHeader: () => undefined,
			setTitle: (title) => {
				if (!this.isScopeActive(contextScopeKey)) return;
				process.title = title;
				renderIfRunning();
			},
			// pi-tui 0.85 declares Component.handleMouse(TuiMouseEvent), while pix's
			// input pipeline delivers its own ExtensionInputMouseEvent shape; the
			// double cast bridges the two contracts at this adapter boundary.
			custom: (async <T,>(factory: CustomUiFactory<T>) => await this.showCustomUi(factory, { scopeKey: contextScopeKey })) as unknown as PixExtensionUIContext["custom"],
			pasteToEditor: (text) => {
				if (!this.isScopeActive(contextScopeKey)) return;
				this.host.setInputState({ text, cursor: text.length });
				renderIfRunning();
			},
			setEditorText: (text) => {
				if (!this.isScopeActive(contextScopeKey)) return;
				this.host.setInputState({ text, cursor: text.length });
				renderIfRunning();
			},
			getEditorText: () => this.isScopeActive(contextScopeKey) ? this.host.getInput() : "",
			getEditorSnapshot: () => this.isScopeActive(contextScopeKey)
				? this.host.getInputSnapshot()
				: { text: "", images: [] },
			setEditorSnapshot: (snapshot) => {
				if (!this.isScopeActive(contextScopeKey)) return;
				this.host.setInputSnapshot(snapshot);
				renderIfRunning();
			},
			editor: async (title, prefill) => await this.editorDialog(title, prefill, contextScopeKey),
			addAutocompleteProvider: () => undefined,
			setEditorComponent: () => undefined,
			getEditorComponent: () => undefined,
			get theme() {
				return extensionTheme;
			},
			getAllThemes: () => (Object.keys(THEMES) as ThemeName[]).map((themeName) => ({ name: themeName, path: undefined })),
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "Theme switching is not implemented in pix extension UI yet." }),
			getToolsExpanded: () => this.isScopeActive(contextScopeKey) && this.host.entries.some((entry) => entry.kind === "tool" && entry.expanded),
			setToolsExpanded: (expanded) => {
				if (!this.isScopeActive(contextScopeKey)) return;
				for (const entry of this.host.entries) {
					if (entry.kind === "tool") {
						entry.expanded = expanded;
						this.host.deleteConversationEntry(entry.id);
					}
				}
				renderIfRunning();
			},
		};
	}

	private setAboveInputWidget(key: string, content: ExtensionWidgetContent, scopeKey = this.activeScopeKey()): void {
		this.setWidget(key, content, { placement: "aboveEditor", scopeKey });
	}

	private clearAboveInputWidget(key: string, scopeKey = this.activeScopeKey()): void {
		this.setWidget(key, undefined, { placement: "aboveEditor", scopeKey });
	}

	private async selectDialog(title: string, options: string[], opts?: ExtensionUIDialogOptions, scopeKey = this.activeScopeKey()): Promise<string | undefined> {
		const selected = await this.menuDialog(
			() => this.host.menuController.select(title, options, { preserveStatus: true }),
			opts,
			scopeKey,
		);
		return typeof selected === "string" ? selected : undefined;
	}

	private async confirmDialog(title: string, message: string, opts?: ExtensionUIDialogOptions, scopeKey = this.activeScopeKey()): Promise<boolean> {
		const selected = await this.menuDialog(
			() => this.host.menuController.show(
				[
					{ value: true, label: "Yes", description: message },
					{ value: false, label: "No" },
				],
				{ title, searchable: false, preserveStatus: true },
			),
			opts,
			scopeKey,
		);
		return selected === true;
	}

	private async menuDialog(open: () => Promise<unknown>, opts: ExtensionUIDialogOptions | undefined, scopeKey: string): Promise<unknown> {
		if (opts?.signal?.aborted || !this.isScopeActive(scopeKey) || !this.host.isRunning()) return undefined;
		let dialog!: MenuDialog;
		const promise = new Promise<unknown>((resolve, reject) => {
			dialog = { kind: "menu", scopeKey, settled: false, resolve, reject, open, showing: false, generation: 0 };
		});
		this.pushDialog(dialog);
		this.showMenuDialog(dialog);
		return await this.withDialogAutoDismiss(promise, opts, () => {
			this.finishDialog(dialog, { resolve: true, value: undefined });
		});
	}

	private showMenuDialog(dialog: MenuDialog): void {
		const generation = ++dialog.generation;
		dialog.showing = true;
		const isCurrent = (): boolean => !dialog.settled && dialog.showing && dialog.generation === generation;
		let opened: Promise<unknown>;
		try {
			opened = dialog.open();
		} catch (error) {
			this.finishDialog(dialog, { resolve: false, error });
			return;
		}
		opened.then(
			(value) => {
				if (isCurrent()) this.finishDialog(dialog, { resolve: true, value });
			},
			(error: unknown) => {
				if (isCurrent()) this.finishDialog(dialog, { resolve: false, error });
			},
		);
	}

	/** Hide a menu dialog without settling it; its host resolution becomes stale. */
	private suspendMenuDialog(dialog: MenuDialog): void {
		if (!dialog.showing) return;
		dialog.showing = false;
		dialog.generation += 1;
		if (this.isScopeActive(dialog.scopeKey)) this.host.menuController.close();
	}

	private async inputDialog(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions, scopeKey = this.activeScopeKey()): Promise<string | undefined> {
		if (opts?.signal?.aborted) return undefined;
		return await this.editorBackedDialog({
			title,
			initialValue: "",
			mode: "input",
			...(placeholder === undefined ? {} : { placeholder }),
			...(opts === undefined ? {} : { opts }),
		}, scopeKey);
	}

	private async editorDialog(title: string, prefill = "", scopeKey = this.activeScopeKey()): Promise<string | undefined> {
		return await this.editorBackedDialog({
			title,
			initialValue: prefill,
			mode: "editor",
		}, scopeKey);
	}

	private async editorBackedDialog(options: {
		title: string;
		placeholder?: string;
		initialValue: string;
		mode: "input" | "editor";
		opts?: ExtensionUIDialogOptions;
	}, scopeKey = this.activeScopeKey()): Promise<string | undefined> {
		if (options.opts?.signal?.aborted) return undefined;
		if (!this.host.isRunning()) return undefined;
		if (!this.isScopeActive(scopeKey)) return undefined;
		const { dialog, promise } = this.pushCustomUi<string | undefined>((_tui, _theme, _keybindings, done) => {
			let settled = false;
			const finish = (value: string | undefined): void => {
				if (settled) return;
				settled = true;
				done(value);
			};

			return {
				render: (width) => this.renderEditorBackedDialog(options, width),
				usesEditor: () => true,
				handleInput: (data) => {
					if (data === "\x1b") {
						finish(undefined);
						return { consume: true };
					}
					if (data === "\r" || data === "\n") {
						finish(this.host.getInput());
						return { consume: true };
					}
					return { consume: false, data };
				},
			};
		}, { editorInput: options.initialValue, scopeKey });

		return await this.withDialogAutoDismiss(
			promise,
			options.opts,
			() => {
				this.finishDialog(dialog, { resolve: true, value: undefined });
			},
		);
	}

	private renderEditorBackedDialog(options: { title: string; placeholder?: string; mode: "input" | "editor" }, width: number): string[] {
		const hint = options.mode === "editor"
			? "Enter accepts · Shift+Enter inserts newline · Esc cancels"
			: "Enter accepts · Esc cancels";
		return [
			this.dialogLine(options.title, width),
			...(options.placeholder ? [this.dialogLine(`Placeholder: ${options.placeholder}`, width)] : []),
			this.dialogLine(hint, width),
		];
	}

	private dialogLine(text: string, width: number): string {
		return ellipsizeDisplay(sanitizeText(text), Math.max(1, width));
	}

	private async withDialogAutoDismiss<T>(
		promise: Promise<T>,
		opts: ExtensionUIDialogOptions | undefined,
		cancel: () => void,
	): Promise<T> {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const abort = (): void => {
			cancel();
		};

		if (opts?.signal) opts.signal.addEventListener("abort", abort, { once: true });
		if (opts?.timeout !== undefined && opts.timeout >= 0) {
			timeout = setTimeout(abort, opts.timeout);
			timeout.unref?.();
		}

		try {
			return await promise;
		} finally {
			if (timeout) clearTimeout(timeout);
			opts?.signal?.removeEventListener("abort", abort);
		}
	}

	private async showCustomUi<T>(
		factory: CustomUiFactory<T>,
		options: { editorInput?: string; savedInput?: InputEditorDraftState; scopeKey?: string } = {},
	): Promise<T> {
		if (!this.host.isRunning()) return undefined as T;
		return await this.pushCustomUi(factory, options).promise;
	}

	private pushCustomUi<T>(
		factory: CustomUiFactory<T>,
		options: { editorInput?: string; savedInput?: InputEditorDraftState; scopeKey?: string } = {},
	): { dialog: ActiveCustomUi; promise: Promise<T> } {
		const scopeKey = this.normalizeScopeKey(options.scopeKey);
		const savedInput = options.savedInput ?? (this.isScopeActive(scopeKey) ? this.host.getInputState() : undefined);
		let dialog!: ActiveCustomUi;
		const promise = new Promise<T>((resolve, reject) => {
			dialog = {
				kind: "custom",
				key: CUSTOM_UI_WIDGET_KEY,
				scopeKey,
				...(savedInput === undefined ? {} : { savedInput }),
				settled: false,
				resolve: (value) => resolve(value as T),
				reject,
			};
		});
		this.pushDialog(dialog);
		if (options.editorInput !== undefined) this.host.setInputState({ text: options.editorInput, cursor: options.editorInput.length });

		const done = (value: T): void => {
			this.finishDialog(dialog, { resolve: true, value });
		};

		void (async () => {
			try {
				const component = await factory(
					this.widgetTuiHandle(scopeKey) as never,
					this.createExtensionTheme() as never,
					{} as never,
					done as never,
				);

				if (dialog.settled) {
					component.dispose?.();
					return;
				}

				dialog.component = component;
				if (this.host.isRunning() && this.isScopeActive(scopeKey) && this.topDialog(scopeKey) === dialog) this.host.render();
			} catch (error) {
				this.finishDialog(dialog, { resolve: false, error });
			}
		})();
		return { dialog, promise };
	}

	private topDialog(scopeKey: string): ExtensionDialog | undefined {
		return this.dialogStacks.get(scopeKey)?.at(-1);
	}

	private pushDialog(dialog: ExtensionDialog): void {
		const previous = this.topDialog(dialog.scopeKey);
		const stack = this.dialogStacks.get(dialog.scopeKey) ?? [];
		stack.push(dialog);
		this.dialogStacks.set(dialog.scopeKey, stack);
		if (previous?.kind === "menu") this.suspendMenuDialog(previous);
	}

	/**
	 * Settle one dialog anywhere in its scope stack. Settling the top dialog shows
	 * the previous one again; settling a hidden dialog leaves the top untouched.
	 */
	private finishDialog(dialog: ExtensionDialog, outcome: DialogOutcome): void {
		if (dialog.settled) return;
		const stack = this.dialogStacks.get(dialog.scopeKey);
		const index = stack?.indexOf(dialog) ?? -1;
		if (!stack || index < 0) return;
		dialog.settled = true;
		const wasTop = index === stack.length - 1;
		stack.splice(index, 1);
		if (stack.length === 0) this.dialogStacks.delete(dialog.scopeKey);

		if (dialog.kind === "custom") {
			this.releaseCustomInput(dialog, stack.slice(index));
			this.disposeCustomUi(dialog);
		} else {
			this.suspendMenuDialog(dialog);
		}

		if (outcome.resolve) dialog.resolve(outcome.value);
		else dialog.reject(outcome.error);
		if (wasTop) this.activateTopDialog(dialog.scopeKey);
		if (this.host.isRunning() && this.isScopeActive(dialog.scopeKey)) this.host.render();
	}

	/**
	 * A custom dialog's saved draft belongs to whatever editor owner it covered.
	 * When a newer custom dialog still owns the editor, hand the draft over to it
	 * so it is restored when that dialog closes; otherwise restore it now.
	 */
	private releaseCustomInput(dialog: ActiveCustomUi, above: readonly ExtensionDialog[]): void {
		const nextEditorOwner = above.find((entry): entry is ActiveCustomUi => entry.kind === "custom");
		if (nextEditorOwner) {
			if (dialog.savedInput !== undefined) nextEditorOwner.savedInput = dialog.savedInput;
			return;
		}
		if (this.isScopeActive(dialog.scopeKey) && dialog.savedInput !== undefined) {
			this.host.setInputState(dialog.savedInput);
		}
	}

	private activateTopDialog(scopeKey: string): void {
		const top = this.topDialog(scopeKey);
		if (top?.kind !== "menu" || top.showing) return;
		// The shared host popup can only be shown for the visible scope. A hidden
		// select/confirm that resurfaces in an inactive scope is cancelled, matching
		// select/confirm requested from an inactive scope.
		if (!this.host.isRunning() || !this.isScopeActive(scopeKey)) {
			this.finishDialog(top, { resolve: true, value: undefined });
			return;
		}
		this.showMenuDialog(top);
	}

	private disposeCustomUi(dialog: ActiveCustomUi): void {
		try {
			dialog.component?.dispose?.();
		} catch {
			// Ignore extension cleanup failures while closing focused UI.
		}
		try {
			dialog.component?.invalidate?.();
		} catch {
			// Ignore extension invalidation failures while closing focused UI.
		}
	}

	/** Scope cleanup: cancel the whole dialog stack and restore the oldest saved draft. */
	private cancelActiveCustomUi(scopeKey = this.activeScopeKey()): void {
		const stack = this.dialogStacks.get(scopeKey);
		if (!stack) return;
		this.dialogStacks.delete(scopeKey);
		let restoreInput: InputEditorDraftState | undefined;
		for (const dialog of [...stack].reverse()) {
			if (dialog.settled) continue;
			dialog.settled = true;
			if (dialog.kind === "custom") {
				if (dialog.savedInput !== undefined) restoreInput = dialog.savedInput;
				this.disposeCustomUi(dialog);
			} else {
				this.suspendMenuDialog(dialog);
			}
			dialog.resolve(undefined);
		}
		const active = this.isScopeActive(scopeKey);
		if (active && restoreInput !== undefined) this.host.setInputState(restoreInput);
		if (this.host.isRunning() && active) this.host.render();
	}

	private rejectActiveCustomUi(error: unknown): void {
		const active = this.activeCustomUiForActiveScope();
		if (!active) return;
		this.finishDialog(active, { resolve: false, error });
	}

	/** The focused custom UI: the top dialog of the active scope when it is a custom UI. */
	private activeCustomUiForActiveScope(): ActiveCustomUi | undefined {
		const scopeKey = this.activeScopeKey();
		if (!this.isScopeActive(scopeKey)) return undefined;
		const active = this.topDialog(scopeKey);
		if (active?.kind !== "custom") return undefined;
		if (active.savedInput === undefined) active.savedInput = this.host.getInputState();
		return active;
	}

	private isScopeActive(scopeKey: string): boolean {
		return this.host.isExtensionUiScopeActive?.(scopeKey) ?? this.activeScopeKey() === scopeKey;
	}

	private scopedMenuController(scopeKey: string): PixMenuController {
		return {
			show: async <T,>(items: readonly PixMenuItem<T>[], options: PixMenuOptions) => {
				if (!this.isScopeActive(scopeKey)) return undefined;
				return await this.host.menuController.show(items, options);
			},
			select: async (title, options, menuOptions) => {
				if (!this.isScopeActive(scopeKey)) return undefined;
				return await this.host.menuController.select(title, options, menuOptions);
			},
			close: () => {
				if (this.isScopeActive(scopeKey)) this.host.menuController.close();
			},
		};
	}

	private activeScopeKey(): string {
		return this.normalizeScopeKey(this.host.activeExtensionUiScope?.());
	}

	private normalizeScopeKey(scopeKey: string | undefined): string {
		return scopeKey ?? "";
	}

	private scopedWidgetKey(scopeKey: string, key: string): string {
		return `${scopeKey.length}:${scopeKey}:${key}`;
	}

	private unscopedWidgetKey(scopedKey: string, scopeKey: string): string {
		return scopedKey.slice(`${scopeKey.length}:${scopeKey}:`.length);
	}

	private invalidateWidget(widget: ExtensionWidgetRegistration): void {
		try {
			widget.component?.dispose?.();
		} catch {
			// Ignore widget cleanup failures; extensions can re-register on the next session event.
		}
		try {
			widget.component?.invalidate?.();
		} catch {
			// Ignore widget invalidation failures for the same reason.
		}
	}
}

function extensionForegroundColor(colors: Theme["colors"], color: string): string {
	switch (color) {
		case "accent":
		case "borderAccent":
		case "customMessageLabel":
		case "mdHeading":
		case "mdLink":
		case "mdListBullet":
		case "selectedAccent":
		case "toolTitle":
			return colors.accent;
		case "success":
			return colors.success;
		case "error":
			return colors.error;
		case "warning":
			return colors.warning;
		case "info":
		case "bashMode":
			return colors.info;
		case "muted":
		case "dim":
		case "border":
		case "borderMuted":
			return colors.muted;
		case "selectedText":
		case "popupSelectedForeground":
			return colors.popupSelectedForeground;
		case "inputText":
			return colors.inputForeground;
		case "toolDiffAdded":
			return colors.success;
		case "toolDiffRemoved":
			return colors.error;
		case "syntaxComment":
			return colors.muted;
		case "syntaxKeyword":
		case "syntaxFunction":
		case "syntaxType":
			return colors.accent;
		case "syntaxString":
			return colors.success;
		case "syntaxNumber":
			return colors.warning;
		case "thinkingText":
		case "userMessageText":
		case "customMessageText":
		case "toolOutput":
		case "text":
		default:
			return colors.foreground;
	}
}

function extensionBackgroundColor(colors: Theme["colors"], color: string): string {
	switch (color) {
		case "selectedBg":
		case "popupSelectedBackground":
			return colors.popupSelectedBackground;
		case "popupHeaderBackground":
		case "headerBg":
			return colors.popupHeaderBackground;
		case "inputBg":
			return colors.inputBackground;
		case "toolErrorBg":
			return colors.error;
		case "toolPendingBg":
			return colors.warning;
		case "toolSuccessBg":
			return colors.success;
		case "userMessageBg":
			return colors.userMessageBackground;
		case "customMessageBg":
		case "popupBg":
		default:
			return colors.popupBackground;
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
