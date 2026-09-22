export const DCP_CONTEXT_MAP_CELL_COUNT: 40;

export interface DcpContextUsageView {
	tokens: number | null;
	contextWindow: number;
}

export type DcpCapacityCellKind =
	| "free"
	| "retained"
	| "candidate"
	| "protected"
	| "compressed"
	| "occupied"
	| "unknown";

export interface DcpCapacityCell {
	segments: Array<{ kind: DcpCapacityCellKind; share: number }>;
}

export interface DcpContextMapTelemetryView {
	revision: number;
	sessionEpoch: number;
	generatedAt: number;
	tokenEstimates: {
		candidate: number;
		protected: number;
		compressed: number;
		retained: number;
	};
}

export interface DcpCapacityMap {
	cells: DcpCapacityCell[];
	occupiedTokens?: number;
	freeTokens?: number;
	categoryTokens?: DcpContextMapTelemetryView["tokenEstimates"];
	occupiedPercent?: number;
	hasEstimates: boolean;
	estimatesScaled: boolean;
}

export function buildDcpCapacityMap(
	usage: DcpContextUsageView | undefined,
	telemetry: DcpContextMapTelemetryView | undefined,
	cellCount?: number,
): DcpCapacityMap;
