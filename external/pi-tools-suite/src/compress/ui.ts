import type { ExtensionContext, ExtensionUIContext, Theme } from "@mariozechner/pi-coding-agent"
import type { DcpState } from "./state.js"

export interface DcpCompressionVisualDetails {
	topic: string
	blockIds: number[]
	ranges: number
	messages: number
	itemCount: number
	totalSummaryTokens: number
	activeBlocks: number
	totalBlocks: number
	prunedTools: number
	tokensSaved: number
	contextTokens?: number | null
	contextWindow?: number
	contextPercent?: number | null
	skippedMessages?: number
	skippedMessageIssues?: string[]
}

export interface DcpContextUsage {
	tokens: number | null
	contextWindow: number
	percent?: number | null
}

type RawDcpContextUsage = {
	tokens?: number | null
	contextWindow?: number
	percent?: number | null
} | undefined

interface DcpVisualSnapshot {
	manualMode: boolean
	tokensSaved: number
	prunedTools: number
	activeBlocks: number
}

function fg(theme: Theme | undefined, color: string, text: string): string {
	return theme ? theme.fg(color as any, text) : text
}

function rgb(r: number, g: number, b: number, text: string): string {
	return text ? `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m` : ""
}

function contextUsageRgb(used: number, total: number): [number, number, number] {
	const ratio = total > 0 ? Math.max(0, used) / total : 0
	if (ratio <= 0.30) return [21, 128, 61]
	if (ratio <= 0.50) return [161, 98, 7]
	return [185, 28, 28]
}

function colorOccupiedContext(used: number, total: number, text: string): string {
	return rgb(...contextUsageRgb(used, total), text)
}

function colorFreedContext(text: string): string {
	return rgb(15, 118, 110, text)
}

function colorEmptyContext(text: string): string {
	return rgb(55, 65, 81, text)
}

export function formatDcpTokenCount(n: number): string {
	const safe = Math.max(0, Math.round(n || 0))
	if (safe >= 1_000_000) return `${(safe / 1_000_000).toFixed(1)}M`
	if (safe >= 1_000) return `${(safe / 1_000).toFixed(1)}K`
	return String(safe)
}

function snapshotFromState(state: DcpState): DcpVisualSnapshot {
	const activeBlocks = state.compressionBlocks.filter((block) => block.active)
	return {
		manualMode: state.manualMode,
		tokensSaved: state.tokensSaved,
		prunedTools: state.prunedToolIds.size,
		activeBlocks: activeBlocks.length,
	}
}

export function normalizeDcpContextUsage(usage: RawDcpContextUsage): DcpContextUsage | undefined {
	if (!usage || typeof usage.contextWindow !== "number" || usage.contextWindow <= 0) return undefined
	const contextWindow = usage.contextWindow
	const percent = typeof usage.percent === "number" && Number.isFinite(usage.percent)
		? Math.max(0, usage.percent)
		: usage.percent === null
			? null
			: undefined
	const tokens = typeof percent === "number"
		? Math.round((contextWindow * percent) / 100)
		: typeof usage.tokens === "number"
			? usage.tokens
			: null
	return { tokens, contextWindow, percent }
}

function usageTokens(usage: DcpContextUsage): number {
	if (usage.contextWindow > 0 && typeof usage.percent === "number" && Number.isFinite(usage.percent)) {
		return Math.round((usage.contextWindow * Math.max(0, usage.percent)) / 100)
	}
	return usage.tokens ?? 0
}

function contextRatio(usage: DcpContextUsage | undefined): string | undefined {
	if (!usage || typeof usage.contextWindow !== "number" || usage.contextWindow <= 0) return undefined
	const used = usageTokens(usage)
	return `${formatDcpTokenCount(used)}/${formatDcpTokenCount(usage.contextWindow)}`
}

function compressionContextScale(details: Pick<DcpCompressionVisualDetails, "contextTokens" | "contextWindow" | "contextPercent">): string | undefined {
	const total = Math.max(0, Math.round(details.contextWindow ?? 0))
	if (total <= 0) return undefined
	if (typeof details.contextPercent === "number" && Number.isFinite(details.contextPercent)) {
		return `${Math.max(0, details.contextPercent).toFixed(1)}%/${formatDcpTokenCount(total)}`
	}
	return `${formatDcpTokenCount(compressionContextTokens(details))}/${formatDcpTokenCount(total)}`
}

export function renderDcpStatusLabel(state: DcpState, theme?: Theme, usage?: DcpContextUsage): string {
	const normalizedUsage = normalizeDcpContextUsage(usage)
	const snapshot = snapshotFromState(state)
	const parts: string[] = []

	const ratio = contextRatio(normalizedUsage)
	const headline = [
		fg(theme, "accent", "DCP"),
		ratio ? fg(theme, "customMessageText", ratio) : undefined,
		normalizedUsage ? renderDcpUsageBar(theme, normalizedUsage, 14) : undefined,
		snapshot.manualMode ? fg(theme, "warning", "manual") : undefined,
	].filter(Boolean).join(" ")
	parts.push(headline)

	if (snapshot.tokensSaved > 0) {
		parts.push(`${fg(theme, "success", `-${formatDcpTokenCount(snapshot.tokensSaved)}`)} ${fg(theme, "dim", "saved")}`)
	}

	if (snapshot.prunedTools > 0) {
		parts.push(`${fg(theme, "warning", String(snapshot.prunedTools))} ${fg(theme, "dim", "pruned")}`)
	}

	if (snapshot.activeBlocks > 0) {
		parts.push(`${fg(theme, "accent", String(snapshot.activeBlocks))} ${fg(theme, "dim", snapshot.activeBlocks === 1 ? "block" : "blocks")}`)
	}

	return parts.join(fg(theme, "dim", " │ "))
}

function compressionContextTokens(details: Pick<DcpCompressionVisualDetails, "contextTokens" | "contextWindow" | "contextPercent">): number {
	const total = Math.max(0, Math.round(details.contextWindow ?? 0))
	if (total > 0 && typeof details.contextPercent === "number" && Number.isFinite(details.contextPercent)) {
		return Math.round((total * Math.max(0, details.contextPercent)) / 100)
	}
	return Math.round(details.contextTokens ?? 0)
}

function contextParts(details: Pick<DcpCompressionVisualDetails, "contextTokens" | "contextWindow" | "contextPercent" | "tokensSaved">): { used: number; freed: number; empty: number; total: number } {
	const total = Math.max(0, Math.round(details.contextWindow ?? 0))
	if (total <= 0) {
		const freed = Math.max(0, Math.round(details.tokensSaved ?? 0))
		return { used: 0, freed, empty: 0, total: Math.max(1, freed) }
	}

	const footprint = Math.max(0, Math.min(total, compressionContextTokens(details)))
	const freed = Math.max(0, Math.min(footprint, Math.round(details.tokensSaved ?? 0)))
	const used = Math.max(0, footprint - freed)
	const empty = Math.max(0, total - footprint)
	return { used, freed, empty, total }
}

function singleLine(value: string): string {
	return value.replace(/\s+/g, " ").trim()
}

function truncateLabel(value: string, maxChars: number): string {
	const chars = Array.from(singleLine(value))
	if (chars.length <= maxChars) return chars.join("")
	if (maxChars <= 0) return ""
	if (maxChars === 1) return "…"
	return `${chars.slice(0, maxChars - 1).join("")}…`
}

function distributeBar(width: number, parts: { used: number; freed: number; empty: number; total: number }): { used: number; freed: number; empty: number } {
	const safeWidth = Math.max(1, width)
	const footprint = Math.max(0, parts.used + parts.freed)
	const occupied = footprint > 0
		? Math.min(safeWidth, Math.max(1, Math.round((footprint / Math.max(1, parts.total)) * safeWidth)))
		: 0
	const empty = safeWidth - occupied
	if (occupied === 0) return { used: 0, freed: 0, empty }
	if (parts.used <= 0) return { used: 0, freed: occupied, empty }
	if (parts.freed <= 0) return { used: occupied, freed: 0, empty }
	if (occupied === 1) {
		return parts.freed >= parts.used
			? { used: 0, freed: 1, empty }
			: { used: 1, freed: 0, empty }
	}
	const used = Math.min(occupied - 1, Math.max(1, Math.round((parts.used / footprint) * occupied)))
	return { used, freed: occupied - used, empty }
}

export function renderDcpUsageBar(_theme: Theme | undefined, usage: DcpContextUsage, width: number): string {
	const total = Math.max(0, Math.round(usage.contextWindow ?? 0))
	const used = Math.max(0, Math.round(usageTokens(usage)))
	const totalCells = Math.max(1, width)
	const safeTotal = Math.max(1, total)
	const clampedUsed = Math.max(0, Math.min(safeTotal, used))
	const usedCells = clampedUsed > 0 ? Math.max(1, Math.round((clampedUsed / safeTotal) * totalCells)) : 0
	const occupied = Math.min(totalCells, usedCells)
	return colorOccupiedContext(used, total, "█".repeat(occupied)) + colorEmptyContext("░".repeat(totalCells - occupied))
}

export function renderDcpContextBar(_theme: Theme | undefined, details: Pick<DcpCompressionVisualDetails, "contextTokens" | "contextWindow" | "contextPercent" | "tokensSaved">, width: number): string {
	const parts = contextParts(details)
	const cells = distributeBar(width, parts)
	return [
		colorOccupiedContext(parts.used, parts.total, "█".repeat(cells.used)),
		colorFreedContext("░".repeat(cells.freed)),
		colorEmptyContext("░".repeat(cells.empty)),
	].join("")
}

export function formatDcpCompressionMessageText(
	details: DcpCompressionVisualDetails,
	theme: Theme | undefined,
	expanded: boolean,
): string {
	const ratio = compressionContextScale(details)
	const bar = renderDcpContextBar(theme, details, expanded ? 24 : 18)
	return [
		fg(theme, "success", "✓"),
		fg(theme, "accent", "compressed"),
		fg(theme, "success", `saved ${formatDcpTokenCount(details.tokensSaved)}`),
		bar,
		ratio ? fg(theme, "customMessageText", ratio) : undefined,
		details.topic ? fg(theme, "dim", `· ${truncateLabel(details.topic, expanded ? 64 : 36)}`) : undefined,
	].filter(Boolean).join(fg(theme, "dim", "  "))
}

export function normalizeDcpCompressionDetails(content: unknown, details: unknown): DcpCompressionVisualDetails {
	const raw = details && typeof details === "object" ? details as Partial<DcpCompressionVisualDetails> : {}
	const topic = typeof raw.topic === "string"
		? raw.topic
		: typeof content === "string"
			? content
			: "Compressed context"
	const blockIds = Array.isArray(raw.blockIds) ? raw.blockIds.filter((id): id is number => typeof id === "number") : []
	const ranges = typeof raw.ranges === "number" ? raw.ranges : 0
	const messages = typeof raw.messages === "number" ? raw.messages : 0
	return {
		topic,
		blockIds,
		ranges,
		messages,
		itemCount: typeof raw.itemCount === "number" ? raw.itemCount : ranges + messages,
		totalSummaryTokens: typeof raw.totalSummaryTokens === "number" ? raw.totalSummaryTokens : 0,
		activeBlocks: typeof raw.activeBlocks === "number" ? raw.activeBlocks : blockIds.length,
		totalBlocks: typeof raw.totalBlocks === "number" ? raw.totalBlocks : blockIds.length,
		prunedTools: typeof raw.prunedTools === "number" ? raw.prunedTools : 0,
		tokensSaved: typeof raw.tokensSaved === "number" ? raw.tokensSaved : 0,
		contextTokens: typeof raw.contextTokens === "number" || raw.contextTokens === null ? raw.contextTokens : undefined,
		contextWindow: typeof raw.contextWindow === "number" ? raw.contextWindow : undefined,
		contextPercent: typeof raw.contextPercent === "number" || raw.contextPercent === null ? raw.contextPercent : undefined,
		skippedMessages: typeof raw.skippedMessages === "number" ? raw.skippedMessages : undefined,
		skippedMessageIssues: Array.isArray(raw.skippedMessageIssues)
			? raw.skippedMessageIssues.filter((issue): issue is string => typeof issue === "string")
			: undefined,
	}
}

export class DcpUiController {
	private uiCtx: ExtensionUIContext | undefined

	constructor(_state: DcpState) {}

	setUICtx(ctx: ExtensionUIContext): void {
		if (ctx === this.uiCtx) return
		this.uiCtx = ctx
	}

	update(_ctx?: ExtensionContext): void {
		// DCP should not render a footer/status-line label. Compression result
		// messages are still rendered by formatDcpCompressionMessageText().
	}

	dispose(): void {
		this.uiCtx = undefined
	}
}

export const __formatDcpCompressionMessageTextForTest = formatDcpCompressionMessageText
export const __renderDcpStatusLabelForTest = renderDcpStatusLabel
