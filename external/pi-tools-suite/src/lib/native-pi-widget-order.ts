import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

import { isNativePiTui } from "./native-pi-tui.js";

export type NativePiWidgetFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };

type NearEditorRegistration = {
	key: string;
	factory: NativePiWidgetFactory;
	sessionManager: ExtensionContext["sessionManager"];
};

let nearEditorRegistration: NearEditorRegistration | undefined;

/**
 * Register a normal suite widget above the editor, then restore the transient
 * near-editor widget (questionnaire) as the last above-editor entry. Pi keeps
 * extension widgets in insertion order, so this makes the questionnaire remain
 * immediately adjacent to the composer even while todo/subagent state updates.
 */
export function setNativePiAboveWidget(
	ctx: ExtensionContext,
	key: string,
	factory: NativePiWidgetFactory | undefined,
): void {
	if (!isNativePiTui(ctx)) return;
	ctx.ui.setWidget(key, factory, { placement: "aboveEditor" });
	if (!factory) return;
	const near = nearEditorRegistration;
	if (!near || near.key === key || near.sessionManager !== ctx.sessionManager) return;
	ctx.ui.setWidget(near.key, near.factory, { placement: "aboveEditor" });
}

export function setNativePiNearEditorWidget(
	ctx: ExtensionContext,
	key: string,
	factory: NativePiWidgetFactory,
): void {
	if (!isNativePiTui(ctx)) return;
	nearEditorRegistration = { key, factory, sessionManager: ctx.sessionManager };
	ctx.ui.setWidget(key, factory, { placement: "aboveEditor" });
}

export function clearNativePiNearEditorWidget(ctx: ExtensionContext, key: string): void {
	if (!isNativePiTui(ctx)) return;
	if (
		nearEditorRegistration?.key === key
		&& nearEditorRegistration.sessionManager === ctx.sessionManager
	) {
		nearEditorRegistration = undefined;
	}
	ctx.ui.setWidget(key, undefined, { placement: "aboveEditor" });
}
