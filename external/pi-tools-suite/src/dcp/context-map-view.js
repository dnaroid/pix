// Dependency-free projection of live context capacity plus the last prepared DCP
// token categories. Kept as plain ESM so Pix can reuse it without importing the
// extension's TypeScript runtime into the renderer build.

export const DCP_CONTEXT_MAP_CELL_COUNT = 40;

/** @typedef {{tokens:number|null, contextWindow:number}} ContextUsageLike */
/** @typedef {{retained:number,candidate:number,protected:number,compressed:number}} CategoryTokens */
/** @typedef {"free"|"retained"|"candidate"|"protected"|"compressed"|"occupied"|"unknown"} DcpCapacityCellKind */
/** @typedef {{kind:DcpCapacityCellKind,tokens:number}} TokenSegment */

/**
 * @param {{tokens:number|null, contextWindow:number}|undefined} usage
 * @param {{tokenEstimates?:{retained:number,candidate:number,protected:number,compressed:number}}|undefined} telemetry
 * @param {number} [cellCount]
 */
export function buildDcpCapacityMap(usage, telemetry, cellCount = DCP_CONTEXT_MAP_CELL_COUNT) {
	const cells = Math.max(1, Math.floor(cellCount));
	if (!hasUsableContextDenominator(usage)) {
		return {
			cells: Array.from({ length: cells }, () => ({ segments: [{ kind: "unknown", share: 1 }] })),
			hasEstimates: false,
			estimatesScaled: false,
		};
	}

	const occupiedTokens = usage.tokens;
	const freeTokens = Math.max(0, usage.contextWindow - occupiedTokens);
	const estimates = telemetry?.tokenEstimates;
	const categoryTokens = validCategoryTokens(estimates)
		? fitEstimates(estimates, occupiedTokens)
		: undefined;
	const displayTokens = categoryTokens
		? scaleCategories(categoryTokens, Math.min(occupiedTokens, usage.contextWindow))
		: undefined;
	/** @type {TokenSegment[]} */
	const segments = displayTokens
		? [
			{ kind: "retained", tokens: displayTokens.retained },
			{ kind: "candidate", tokens: displayTokens.candidate },
			{ kind: "protected", tokens: displayTokens.protected },
			{ kind: "compressed", tokens: displayTokens.compressed },
			{ kind: "free", tokens: freeTokens },
		]
		: [
			{ kind: "occupied", tokens: Math.min(occupiedTokens, usage.contextWindow) },
			{ kind: "free", tokens: freeTokens },
		];

	return {
		cells: tokenizeCells(segments, usage.contextWindow, cells),
		occupiedTokens,
		freeTokens,
		...(categoryTokens ? { categoryTokens } : {}),
		occupiedPercent: (occupiedTokens / usage.contextWindow) * 100,
		hasEstimates: categoryTokens !== undefined,
		estimatesScaled: Boolean(categoryTokens && estimates && sum(estimates) > occupiedTokens),
	};
}

/** @param {TokenSegment[]} segments @param {number} window @param {number} cellCount */
function tokenizeCells(segments, window, cellCount) {
	let cursor = 0;
	const spans = segments.map((segment) => {
		const start = cursor;
		cursor += segment.tokens;
		return { ...segment, start, end: cursor };
	});
	return Array.from({ length: cellCount }, (_, index) => {
		const start = index * window / cellCount;
		const end = (index + 1) * window / cellCount;
		return {
			segments: spans.flatMap((span) => {
				const overlap = Math.max(0, Math.min(end, span.end) - Math.max(start, span.start));
				return overlap > 0 ? [{ kind: span.kind, share: overlap / (end - start) }] : [];
			}),
		};
	});
}

/** @param {CategoryTokens} estimates @param {number} occupied */
function fitEstimates(estimates, occupied) {
	const total = sum(estimates);
	if (total <= occupied) return { ...estimates, retained: estimates.retained + occupied - total };
	return scaleCategories(estimates, occupied);
}

/** @param {CategoryTokens} categories @param {number} target */
function scaleCategories(categories, target) {
	const total = sum(categories);
	if (total === target) return { ...categories };
	const scale = total > 0 ? target / total : 0;
	return {
		retained: categories.retained * scale,
		candidate: categories.candidate * scale,
		protected: categories.protected * scale,
		compressed: categories.compressed * scale,
	};
}

/** @param {CategoryTokens} categories */
function sum(categories) {
	return categories.retained + categories.candidate + categories.protected + categories.compressed;
}

/** @param {CategoryTokens|undefined} value @returns {value is CategoryTokens} */
function validCategoryTokens(value) {
	if (!value) return false;
	const values = [value.retained, value.candidate, value.protected, value.compressed];
	return values.every((token) => Number.isFinite(token) && token >= 0) && values.some((token) => token > 0);
}

/** @param {ContextUsageLike|undefined} usage @returns {usage is {tokens:number, contextWindow:number}} */
function hasUsableContextDenominator(usage) {
	return Boolean(
		usage
		&& typeof usage.tokens === "number"
		&& Number.isSafeInteger(usage.tokens)
		&& usage.tokens >= 0
		&& Number.isSafeInteger(usage.contextWindow)
		&& usage.contextWindow > 0,
	);
}
