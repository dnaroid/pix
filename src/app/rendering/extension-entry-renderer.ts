import { Theme as PiTheme, type EntryRenderer, type ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Theme as PixTheme } from "../../theme.js";
import type { Entry, RenderedLine } from "../types.js";
import { ansiStyledLine } from "./tool-block-renderer.js";

const themes = new WeakMap<PixTheme, PiTheme>();
const components = new WeakMap<object, {
	renderer: EntryRenderer;
	theme: PixTheme;
	expanded: boolean;
	component: NonNullable<ReturnType<EntryRenderer>>;
}>();

export function renderRegisteredExtensionEntry(
	entry: Extract<Entry, { kind: "extension-entry" }>,
	width: number,
	renderer: EntryRenderer | undefined,
	theme: PixTheme,
): RenderedLine[] {
	if (!renderer || width <= 0) return [];

	try {
		const cached = components.get(entry);
		let component = cached?.component;
		if (!cached || cached.renderer !== renderer || cached.theme !== theme || cached.expanded !== entry.expanded) {
			component = renderer(entry.sessionEntry, { expanded: entry.expanded }, extensionRendererTheme(theme)) ?? undefined;
			if (!component) {
				components.delete(entry);
				return [];
			}
			components.set(entry, { renderer, theme, expanded: entry.expanded, component });
		}
		if (!component) return [];
		return component.render(width).map((rawLine) => {
			const line = ansiStyledLine(rawLine.replace(/\r/gu, ""));
			return {
				text: line.text,
				copyText: line.text,
				target: { kind: "tool" as const, id: entry.id },
				...(line.segments.length > 0 ? { segments: line.segments } : {}),
			};
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return [{ text: `[${entry.sessionEntry.customType}] renderer failed: ${message}`, variant: "error" }];
	}
}

function extensionRendererTheme(theme: PixTheme): PiTheme {
	const cached = themes.get(theme);
	if (cached) return cached;

	const colors = theme.colors;
	const foregrounds = {
		accent: colors.accent,
		border: colors.inputBorder,
		borderAccent: colors.accent,
		borderMuted: colors.muted,
		success: colors.success,
		error: colors.error,
		warning: colors.warning,
		muted: colors.muted,
		dim: colors.muted,
		text: colors.foreground,
		thinkingText: colors.thinkingForeground,
		userMessageText: colors.userForeground,
		customMessageText: colors.foreground,
		customMessageLabel: colors.accent,
		toolTitle: colors.toolTitle,
		toolOutput: colors.foreground,
		mdHeading: colors.heading,
		mdLink: colors.info,
		mdLinkUrl: colors.muted,
		mdCode: colors.info,
		mdCodeBlock: colors.foreground,
		mdCodeBlockBorder: colors.muted,
		mdQuote: colors.foreground,
		mdQuoteBorder: colors.muted,
		mdHr: colors.muted,
		mdListBullet: colors.accent,
		toolDiffAdded: colors.success,
		toolDiffRemoved: colors.error,
		toolDiffContext: colors.muted,
		syntaxComment: colors.muted,
		syntaxKeyword: colors.toolEdit,
		syntaxFunction: colors.toolIndex,
		syntaxVariable: colors.foreground,
		syntaxString: colors.toolRead,
		syntaxNumber: colors.warning,
		syntaxType: colors.toolSearch,
		syntaxOperator: colors.muted,
		syntaxPunctuation: colors.muted,
		thinkingOff: colors.muted,
		thinkingMinimal: colors.muted,
		thinkingLow: colors.info,
		thinkingMedium: colors.accent,
		thinkingHigh: colors.warning,
		thinkingXhigh: colors.thinkingXHigh,
		thinkingMax: colors.thinkingMax,
		bashMode: colors.toolBash,
	} satisfies Record<ThemeColor, string>;
	const backgrounds: ConstructorParameters<typeof PiTheme>[1] = {
		selectedBg: colors.popupSelectedBackground,
		userMessageBg: colors.userMessageBackground || colors.background,
		customMessageBg: colors.assistantMessageBackground || colors.background,
		toolPendingBg: colors.thinkingMessageBackground || colors.background,
		toolSuccessBg: colors.assistantMessageBackground || colors.background,
		toolErrorBg: colors.assistantMessageBackground || colors.background,
	};
	const created = new PiTheme(foregrounds, backgrounds, "truecolor", { name: `pix-${theme.name}` });
	themes.set(theme, created);
	return created;
}
