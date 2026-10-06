import type { ModelUsageResetCredit } from "./model-usage-status.js";

/** Only explicit RFC3339 instants are expiry evidence; never guess local dates. */
function expiryInstant(value: unknown): number | undefined {
	if (typeof value !== "string"
		|| !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/iu.test(value)) return undefined;
	const instant = Date.parse(value);
	// Date.parse normalizes February 30 instead of rejecting it.
	if (!Number.isFinite(instant)
		|| new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10)) return undefined;
	return instant;
}

function sortCredits(credits: ModelUsageResetCredit[]): ModelUsageResetCredit[] {
	return credits.sort((a, b) => (a.expiresAt ?? Number.POSITIVE_INFINITY) - (b.expiresAt ?? Number.POSITIVE_INFINITY));
}

export function openAIResetCreditsFromResponse(data: unknown, now = Date.now()): ModelUsageResetCredit[] {
	if (!data || typeof data !== "object" || !("credits" in data) || !Array.isArray(data.credits)) return [];
	const seenIds = new Set<string>();
	return sortCredits(data.credits
		.filter((credit) => credit && typeof credit === "object" && credit.status === "available")
		.filter((credit) => {
			if (typeof credit.id !== "string" || !credit.id) return true;
			if (seenIds.has(credit.id)) return false;
			seenIds.add(credit.id);
			return true;
		})
		.map((credit): ModelUsageResetCredit => {
			const title = typeof credit.title === "string" && credit.title.trim() ? credit.title.trim() : "Reset credit";
			const expiresAt = expiryInstant(credit.expires_at);
			return { title, ...(expiresAt === undefined ? {} : { expiresAt }) };
		})
		.filter((credit) => credit.expiresAt === undefined || credit.expiresAt > now));
}

/** Banked grants are not necessarily redeemable now (e.g. no quota is exhausted). */
export function anthropicResetCreditsFromResponse(data: unknown, now = Date.now()): ModelUsageResetCredit[] {
	if (!data || typeof data !== "object" || !("eligible" in data) || data.eligible !== true
		|| !("grants" in data) || !Array.isArray(data.grants)) return [];
	const seenIds = new Set<string>();
	const credits: ModelUsageResetCredit[] = [];
	let total = 0;
	for (const grant of data.grants) {
		if (!grant || typeof grant !== "object" || typeof grant.id !== "string"
			|| !/^[a-z0-9_-]{1,40}$/u.test(grant.id) || seenIds.has(grant.id)
			|| !Number.isSafeInteger(grant.resets_left) || grant.resets_left <= 0
			|| (grant.paused !== undefined && grant.paused !== false)) continue;
		const startsAt = expiryInstant(grant.starts_at);
		if (grant.starts_at != null && (startsAt === undefined || startsAt > now)) continue;
		const expiresAt = expiryInstant(grant.ends_at);
		if (expiresAt !== undefined && expiresAt <= now) continue;
		if (!Number.isSafeInteger(total + grant.resets_left)) continue;
		seenIds.add(grant.id);
		total += grant.resets_left;
		credits.push({
			title: typeof grant.label === "string" && grant.label.trim() ? grant.label.trim() : "Full reset",
			count: grant.resets_left,
			...(expiresAt === undefined ? {} : { expiresAt }),
		});
	}
	return sortCredits(credits);
}
