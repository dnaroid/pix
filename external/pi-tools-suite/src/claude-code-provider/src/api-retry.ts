/** Content-free observation only: no retry, deadline or protocol decisions. */
export interface ApiRetryNotice {
  category: "overloaded" | "server_error" | "unknown" | "rate_limit" | "billing_error" | "authentication_failed" | "invalid_request" | "other";
  httpStatus?: number;
  attempt?: number;
  retryDelayMs?: number;
}

const CATEGORIES = new Set<ApiRetryNotice["category"]>([
  "overloaded", "server_error", "unknown", "rate_limit", "billing_error",
  "authentication_failed", "invalid_request", "other",
]);

/** Unknown strings and malformed optional fields never enter diagnostics. */
export function parseApiRetryNotice(record: Record<string, unknown>): ApiRetryNotice {
  const category = typeof record.error === "string" && record.error.length > 0 ? record.error : "unknown";
  return {
    category: CATEGORIES.has(category as ApiRetryNotice["category"]) ? category as ApiRetryNotice["category"] : "other",
    ...optionalInteger("httpStatus", record.error_status, 100, 599),
    ...optionalInteger("attempt", record.attempt, 0, 2_147_483_647),
    ...optionalInteger("retryDelayMs", record.retry_delay_ms, 0, 2_147_483_647),
  };
}

function optionalInteger(key: string, value: unknown, min: number, max: number): Record<string, number> {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? { [key]: value } : {};
}
