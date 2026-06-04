import { ANSI_RESET, colorize, THEMES, type Theme, type ThemeName } from "../../theme.js";
import { isToastKind, type ToastKind, type ToastNotifier } from "../../ui.js";
import type { ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import type {
	Entry,
	ExtensionInputMouseEvent,
	ExtensionWidgetComponent,
	ExtensionWidgetContent,
	ExtensionWidgetFactory,
	ExtensionWidgetRegistration,
	ExtensionWidgetTheme,
	PixExtensionUIContext,
	PixMenuController,
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

type ActiveCustomUi = {
	key: string;
	scopeKey: string;
	component: FocusedCustomComponent;
	savedInput: string;
	resolve(value: unknown): void;
	reject(error: unknown): void;
};

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
	readonly entries: readonly Entry[];
	deleteConversationEntry(entryId: string): void;
};

export class ExtensionUiController {
	private readonly extensionWidgets = new Map<string, ScopedWidgetRegistration>();
	private readonly terminalInputHandlers = new Set<ScopedTerminalInputHandler>();
	private readonly activeCustomUis = new Map<string, ActiveCustomUi>();
	constructor(private readonly host: ExtensionUiControllerHost) {}

	get widgets(): ReadonlyMap<string, ExtensionWidgetRegistration> {
		const activeScopeKey = this.activeScopeKey();
		return new Map(
			[...this.extensionWidgets.entries()]
				.filter(([, widget]) => widget.scopeKey === activeScopeKey)
				.map(([scopedKey, widget]) => [this.unscopedWidgetKey(scopedKey, widget.scopeKey), widget]),
		);
	}

	createExtensionTheme(): ExtensionWidgetTheme {
		const colors = this.host.theme.colors;
		const foreground = (color: unknown): string => extensionForegroundColor(colors, String(color));
		const background = (color: unknown): string => extensionBackgroundColor(colors, String(color));
		const prefix = (options: { foreground?: string; background?: string; bold?: boolean }): string => (
			colorize("", options).replace(new RegExp(`${escapeRegExp(ANSI_RESET)}$`), "")
		);

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
		if (options.cancelCustomUi !== false) this.cancelActiveCustomUi(normalizedScopeKey);
		for (const [key, widget] of this.extensionWidgets.entries()) {
			if (widget.scopeKey !== normalizedScopeKey) continue;
			this.invalidateWidget(widget);
			this.extensionWidgets.delete(key);
		}
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
		if (active) {
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
		if (!active) return undefined;
		try {
			return active.component.render(width);
		} catch (error) {
			return [`${active.key}: custom UI render failed: ${String(error)}`];
		}
	}

	activeCustomUiUsesEditor(): boolean {
		const active = this.activeCustomUiForActiveScope();
		if (!active) return false;
		try {
			return active.component.usesEditor?.() === true;
		} catch {
			return false;
		}
	}

	handleCustomUiMouse(event: ExtensionInputMouseEvent): boolean {
		const active = this.activeCustomUiForActiveScope();
		if (!active) return false;
		try {
			return active.component.handleMouse?.(event) === true;
		} catch (error) {
			this.rejectActiveCustomUi(error);
			return true;
		}
	}

	widgetTuiHandle(): WidgetTuiHandle {
		const activeScopeToastNotifier = this.host.toastNotifierForScope?.(this.activeScopeKey()) ?? this.host.toastNotifier;
		return {
			requestRender: () => {
				if (this.host.isRunning()) this.host.render();
			},
			showToast: activeScopeToastNotifier.show,
			toast: activeScopeToastNotifier,
			showMenu: this.host.menuController.show,
			menu: this.host.menuController,
			pix: {
				delegatedEditorInput: true,
				inputMouse: true,
			},
		};
	}

	createExtensionUIContext(scopeKey?: string): PixExtensionUIContext {
		const contextScopeKey = this.normalizeScopeKey(scopeKey);
		const scopedToastNotifier = this.host.toastNotifierForScope?.(contextScopeKey) ?? this.host.toastNotifier;
		const notify = (message: string, type?: ToastKind | string): void => {
			this.host.showToast(message, isToastKind(type) ? type : "info", { scopeKey: contextScopeKey });
		};

		const extensionTheme = this.createExtensionTheme();
		const renderIfRunning = (): void => {
			if (this.host.isRunning()) this.host.render();
		};

		return {
			select: async (title, options, opts) => await this.selectDialog(title, options, opts),
			confirm: async (title, message, opts) => await this.confirmDialog(title, message, opts),
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
			showMenu: this.host.menuController.show,
			menu: this.host.menuController,
			onTerminalInput: (handler) => {
				const terminalInputHandler = { scopeKey: contextScopeKey, handler: handler as TerminalInputHandler };
				this.terminalInputHandlers.add(terminalInputHandler);
				return () => {
					this.terminalInputHandlers.delete(terminalInputHandler);
				};
			},
			setStatus: (_key, text) => {
				if (text) this.host.showToast(text, "info", { scopeKey: contextScopeKey });
				this.host.restoreSessionStatus();
				renderIfRunning();
			},
			setWorkingMessage: (message) => {
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
				process.title = title;
				renderIfRunning();
			},
			custom: (async <T,>(factory: CustomUiFactory<T>) => await this.showCustomUi(factory, { scopeKey: contextScopeKey })) as PixExtensionUIContext["custom"],
			pasteToEditor: (text) => {
				this.host.setInput(text);
				renderIfRunning();
			},
			setEditorText: (text) => {
				this.host.setInput(text);
				renderIfRunning();
			},
			getEditorText: () => this.host.getInput(),
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
			getToolsExpanded: () => this.host.entries.some((entry) => entry.kind === "tool" && entry.expanded),
			setToolsExpanded: (expanded) => {
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

	private async selectDialog(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
		if (opts?.signal?.aborted) return undefined;
		return await this.withDialogAutoDismiss(
			this.host.menuController.select(title, options, { preserveStatus: true }),
			opts,
			() => {
				this.host.menuController.close();
			},
		);
	}

	private async confirmDialog(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> {
		if (opts?.signal?.aborted) return false;
		const selected = await this.withDialogAutoDismiss(
			this.host.menuController.show(
				[
					{ value: true, label: "Yes", description: message },
					{ value: false, label: "No" },
				],
				{ title, searchable: false, preserveStatus: true },
			),
			opts,
			() => {
				this.host.menuController.close();
			},
		);
		return selected === true;
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
		if (this.activeCustomUis.has(scopeKey)) throw new Error("Another extension custom UI is already active.");
		const savedInput = this.host.getInput();
		this.host.setInput(options.initialValue);
		const promise = this.showCustomUi<string | undefined>((_tui, _theme, _keybindings, done) => {
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
		}, { savedInput, scopeKey });

		return await this.withDialogAutoDismiss(
			promise,
			options.opts,
			() => {
				this.cancelActiveCustomUi(scopeKey);
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
		options: { savedInput?: string; scopeKey?: string } = {},
	): Promise<T> {
		if (!this.host.isRunning()) return undefined as T;
		const scopeKey = this.normalizeScopeKey(options.scopeKey);
		if (this.activeCustomUis.has(scopeKey)) throw new Error("Another extension custom UI is already active.");
		const savedInput = options.savedInput ?? this.host.getInput();

		return await new Promise<T>((resolve, reject) => {
			let settled = false;
			const done = (value: T): void => {
				if (settled) return;
				settled = true;
				this.finishActiveCustomUi(scopeKey, value, { resolve: true });
				resolve(value);
			};

			void (async () => {
				try {
					const component = await factory(
						this.widgetTuiHandle() as never,
						this.createExtensionTheme() as never,
						{} as never,
						done as never,
					);

					if (settled) {
						component.dispose?.();
						return;
					}

					this.activeCustomUis.set(scopeKey, {
						key: CUSTOM_UI_WIDGET_KEY,
						scopeKey,
						component,
						savedInput,
						resolve: (value) => {
							if (settled) return;
							settled = true;
							resolve(value as T);
						},
						reject: (error) => {
							if (settled) return;
							settled = true;
							reject(error);
						},
					});
					if (this.host.isRunning()) this.host.render();
				} catch (error) {
					if (settled) return;
					settled = true;
					reject(error);
				}
			})();
		});
	}

	private cancelActiveCustomUi(scopeKey = this.activeScopeKey()): void {
		this.finishActiveCustomUi(scopeKey, undefined, { resolve: true });
	}

	private rejectActiveCustomUi(error: unknown): void {
		const active = this.activeCustomUiForActiveScope();
		if (!active) return;
		this.finishActiveCustomUi(active.scopeKey, error, { resolve: false });
	}

	private finishActiveCustomUi(scopeKey: string, value: unknown, options: { resolve: boolean }): void {
		const active = this.activeCustomUis.get(scopeKey);
		if (!active) return;
		this.activeCustomUis.delete(scopeKey);
		if (this.host.getInput() !== active.savedInput) this.host.setInput(active.savedInput);
		try {
			active.component.dispose?.();
		} catch {
			// Ignore extension cleanup failures while closing focused UI.
		}
		try {
			active.component.invalidate?.();
		} catch {
			// Ignore extension invalidation failures while closing focused UI.
		}
		if (options.resolve) active.resolve(value);
		else active.reject(value);
		if (this.host.isRunning()) this.host.render();
	}

	private activeCustomUiForActiveScope(): ActiveCustomUi | undefined {
		return this.activeCustomUis.get(this.activeScopeKey());
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
