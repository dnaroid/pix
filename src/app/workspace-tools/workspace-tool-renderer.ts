import { colorize, type Theme } from "../../theme.js";
import { stringDisplayWidth } from "../../terminal-width.js";
import { padOrTrimPlain } from "../rendering/render-text.js";
import type { WorkspaceToolModalTarget } from "../types.js";
import type { WorkspaceToolSurfaceSnapshot } from "./workspace-tool-controller.js";

export type WorkspaceToolModalOverlay = {
	row: number;
	column: number;
	text: string;
	output: string;
	background: string;
	target?: WorkspaceToolModalTarget;
};

export function renderWorkspaceToolModal(
	snapshot: WorkspaceToolSurfaceSnapshot | undefined,
	width: number,
	startRow: number,
	endRow: number,
	theme: Theme,
): WorkspaceToolModalOverlay[] {
	if (!snapshot || width <= 4 || endRow < startRow) return [];
	const availableRows = endRow - startRow + 1;
	if (availableRows < 3) return [];

	const modalWidth = Math.max(12, width - 4);
	const column = Math.max(1, Math.floor((width - modalWidth) / 2) + 1);
	const modalRows = Math.max(3, availableRows - 2);
	const row = startRow + Math.max(0, Math.floor((availableRows - modalRows) / 2));
	const bodyWidth = Math.max(1, modalWidth - 4);
	const bodyRows = Math.max(0, modalRows - 4);
	const title = snapshot.subtitle ? `${snapshot.title} · ${snapshot.subtitle}` : snapshot.title;
	const close = "[×]";
	const closeWidth = stringDisplayWidth(close);
	const titleWidth = Math.max(0, modalWidth - closeWidth - 5);
	const top = `╭─ ${padOrTrimPlain(title, titleWidth)} ${close}╮`;
	const separator = `├${"─".repeat(Math.max(0, modalWidth - 2))}┤`;
	const bottom = `╰${"─".repeat(Math.max(0, modalWidth - 2))}╯`;
	const visible = snapshot.lines.slice(0, bodyRows);
	const hidden = Math.max(0, snapshot.lines.length - visible.length);
	const body = visible.map((line) => {
		const content = line.control === "button" ? `[ ${line.text} ]` : line.text;
		return {
			text: `│ ${padOrTrimPlain(content, bodyWidth)} │`,
			variant: line.control === "button" ? "accent" as const : line.variant ?? "normal",
			action: line.action,
			actionWidth: line.action ? Math.min(bodyWidth, stringDisplayWidth(content)) : 0,
		};
	});
	while (body.length < bodyRows) body.push({ text: `│ ${" ".repeat(bodyWidth)} │`, variant: "normal" as const, action: undefined, actionWidth: 0 });
	const footerText = snapshot.footer ?? (hidden > 0 ? `… ${hidden} more rows` : "Esc/q close");
	const footer = `│ ${padOrTrimPlain(footerText, bodyWidth)} │`;

	const rows = [
		{ text: top, variant: "accent" as const, action: "close", actionWidth: closeWidth },
		{ text: separator, variant: "muted" as const, action: undefined, actionWidth: 0 },
		...body,
		{ text: footer, variant: "muted" as const, action: undefined, actionWidth: 0 },
		{ text: bottom, variant: "muted" as const, action: undefined, actionWidth: 0 },
	].slice(0, modalRows);

	return rows.map((item, index) => {
		const foreground = item.variant === "error"
			? theme.colors.error
			: item.variant === "accent"
				? theme.colors.info
				: item.variant === "muted"
					? theme.colors.muted
					: theme.colors.popupForeground;
		const target = item.action === "close"
			? {
				kind: "workspace-tool" as const,
				action: item.action,
				startColumn: column + modalWidth - closeWidth - 2,
				endColumn: column + modalWidth - 2,
			}
			: item.action
				? {
				kind: "workspace-tool" as const,
				action: item.action,
				startColumn: column + 2,
				endColumn: column + 2 + item.actionWidth,
				}
				: undefined;
		return {
			row: row + index,
			column,
			text: item.text,
			output: colorize(padOrTrimPlain(item.text, modalWidth), {
				foreground,
				background: theme.colors.popupBackground,
				bold: item.variant === "accent",
			}),
			background: theme.colors.popupBackground,
			...(target ? { target } : {}),
		};
	});
}
