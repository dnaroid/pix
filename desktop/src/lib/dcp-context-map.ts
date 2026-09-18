/** Cached token-volume estimates from the last prepared DCP projection. */
export interface PreparedDcpContextMap {
  readonly revision: number;
  readonly sessionEpoch: number;
  readonly generatedAt: number;
  readonly tokenEstimates: {
    readonly candidate: number;
    readonly protected: number;
    readonly compressed: number;
    readonly retained: number;
  };
}

export function parseDcpContextMap(value: unknown): PreparedDcpContextMap | undefined {
  if (!value || typeof value !== "object") return undefined;
  const map = value as PreparedDcpContextMap;
  if (!Number.isSafeInteger(map.revision) || map.revision <= 0
    || !Number.isSafeInteger(map.sessionEpoch) || map.sessionEpoch < 0
    || !Number.isSafeInteger(map.generatedAt) || map.generatedAt <= 0
    || !Number.isFinite(new Date(map.generatedAt).getTime())
    || !map.tokenEstimates || typeof map.tokenEstimates !== "object") return undefined;
  const estimates = map.tokenEstimates;
  const values = [estimates.candidate, estimates.protected, estimates.compressed, estimates.retained];
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)
    || !Number.isSafeInteger(values.reduce((sum, value) => sum + value, 0))
    || values.every((value) => value === 0)) return undefined;
  return {
    revision: map.revision,
    sessionEpoch: map.sessionEpoch,
    generatedAt: map.generatedAt,
    tokenEstimates: {
      candidate: estimates.candidate,
      protected: estimates.protected,
      compressed: estimates.compressed,
      retained: estimates.retained,
    },
  };
}

export function newerDcpContextMap(
  previous: PreparedDcpContextMap | undefined,
  next: PreparedDcpContextMap | undefined,
): PreparedDcpContextMap | undefined {
  if (!previous || !next) return next;
  if (next.sessionEpoch < previous.sessionEpoch
    || (next.sessionEpoch === previous.sessionEpoch && next.revision < previous.revision)) return previous;
  return next;
}
