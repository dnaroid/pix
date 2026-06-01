export interface ContextUsageSnapshot {
	tokens?: number | null
	contextWindow?: number
	percent?: number | null
}

export interface ContextUsageProvider {
	getContextUsage?: () => ContextUsageSnapshot | undefined
}

export function isStaleExtensionContextError(error: unknown): boolean {
	if (!(error instanceof Error)) return false
	return /ctx is stale|stale after session replacement|stale after.*reload/i.test(error.message)
}

export function ignoreStaleExtensionContextError(error: unknown): void {
	if (!isStaleExtensionContextError(error)) throw error
}

// Fork/newSession/switchSession/reload can invalidate a runner while late UI or
// context events from the old runner are still unwinding. In that race,
// ctx.getContextUsage() throws the Pi stale-ctx guard; treat it as unavailable
// usage instead of failing the replacement flow.
export function safeGetContextUsage(ctx: ContextUsageProvider | undefined): ContextUsageSnapshot | undefined {
	try {
		return ctx?.getContextUsage?.()
	} catch (error) {
		ignoreStaleExtensionContextError(error)
		return undefined
	}
}
