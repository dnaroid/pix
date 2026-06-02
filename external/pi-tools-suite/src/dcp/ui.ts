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
