import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

import { isNativePiTui } from "../lib/native-pi-tui.js";
import type { DcpContextMapTelemetry } from "./context-map-telemetry.js";
import {
	buildDcpCapacityMap,
	DCP_CONTEXT_MAP_CELL_COUNT,
	type DcpCapacityCell,
	type DcpCapacityCellKind,
	type DcpContextUsageView,
} from "./context-map-view.js";

export { buildDcpCapacityMap, DCP_CONTEXT_MAP_CELL_COUNT } from "./context-map-view.js";
export type { DcpCapacityCell, DcpCapacityCellKind, DcpCapacityMap } from "./context-map-view.js";

export const DCP_NATIVE_WIDGET_KEY = "pi-tools-suite:dcp-context";

export function updateDcpNativeWidget(
	ctx: ExtensionContext,
	tokensSaved: number,
	telemetry: DcpContextMapTelemetry | undefined,
): void {
	if (!isNativePiTui(ctx)) return;
	let usage: DcpContextUsageView | undefined;
	try {
		const current = ctx.getContextUsage();
		if (current) usage = { tokens: current.tokens, contextWindow: current.contextWindow };
	} catch {
		usage = undefined;
	}
	if (!usage) {
		ctx.ui.setWidget(DCP_NATIVE_WIDGET_KEY, undefined);
		return;
	}

	ctx.ui.setWidget(DCP_NATIVE_WIDGET_KEY, (_tui, theme) => ({
		invalidate() {},
		render(width: number): string[] {
			const cellCount = width >= 90 ? 40 : width >= 65 ? 28 : width >= 45 ? 18 : 10;
			const map = buildDcpCapacityMap(usage, telemetry, cellCount);
			const percent = map.occupiedPercent === undefined ? "?%" : Math.round(map.occupiedPercent) + "%";
			const bar = map.cells.map((cell) => renderCell(cell, theme)).join("");
			const used = map.occupiedTokens === undefined ? "?" : formatCompactTokens(map.occupiedTokens);
			const capacity = formatCompactTokens(usage.contextWindow);
			const saved = tokensSaved > 0 ? " · DCP ~" + formatCompactTokens(tokensSaved) + " saved" : "";
			const label = theme.fg("dim", "Context ");
			const percentText = theme.fg(contextTone(map.occupiedPercent), percent);
			return [
				truncateToWidth(
					label + percentText + " " + bar + theme.fg("dim", " " + used + "/" + capacity + saved),
					width,
				),
			];
		},
	}), { placement: "belowEditor" });
}

export function clearDcpNativeWidget(ctx: ExtensionContext): void {
	if (!isNativePiTui(ctx)) return;
	ctx.ui.setWidget(DCP_NATIVE_WIDGET_KEY, undefined);
}

function renderCell(
	cell: DcpCapacityCell,
	theme: ExtensionContext["ui"]["theme"],
): string {
	const kind = dominantKind(cell);
	if (kind === "free") return theme.fg("dim", "░");
	if (kind === "candidate") return theme.fg("warning", "█");
	if (kind === "protected") return theme.fg("error", "█");
	if (kind === "compressed") return theme.fg("success", "█");
	if (kind === "retained") return theme.fg("muted", "█");
	if (kind === "occupied") return theme.fg("accent", "█");
	return theme.fg("dim", "?");
}

function dominantKind(cell: DcpCapacityCell): DcpCapacityCellKind {
	return cell.segments.reduce(
		(best, segment) => segment.share > best.share ? segment : best,
		cell.segments[0] ?? { kind: "unknown" as const, share: 1 },
	).kind;
}

function contextTone(percent: number | undefined): "success" | "warning" | "error" | "dim" {
	if (percent === undefined) return "dim";
	if (percent <= 30) return "success";
	if (percent <= 50) return "warning";
	return "error";
}

function formatCompactTokens(value: number): string {
	if (value >= 1_000_000) return trimDecimal(value / 1_000_000) + "M";
	if (value >= 1_000) return trimDecimal(value / 1_000) + "K";
	return String(Math.round(value));
}

function trimDecimal(value: number): string {
	return value.toFixed(1).replace(/\.0$/, "");
}
