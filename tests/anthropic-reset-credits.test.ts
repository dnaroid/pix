import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { anthropicResetCreditsFromResponse } from "../src/app/model/model-usage-reset-credits.js";
import { anthropicUsageStatusFromResponse, markModelUsageStale } from "../src/app/model/model-usage-status.js";

const now = Date.UTC(2026, 9, 5);
const expiry = "2026-10-22T22:32:35+02:00";
const grant = { id: "grant_1", label: "Full reset", resets_left: 3, ends_at: expiry, usable_now: false };

describe("Anthropic banked reset grants", () => {
	it("maps the remaining quantity and exact expiration, independent of redemption readiness", () => {
		assert.deepEqual(anthropicResetCreditsFromResponse({ eligible: true, grants: [grant] }, now), [
			{ title: "Full reset", count: 3, expiresAt: Date.parse(expiry) },
		]);
	});

	it("keeps grant quantities rather than expanding rows and supports credits-only status", () => {
		const status = anthropicUsageStatusFromResponse({ cedar_ember: { eligible: true, grants: [grant, { ...grant, id: "other", resets_left: 2 }] } }, "anthropic/opus", now);
		assert.equal(status?.resetCreditsAvailableCount, 5);
		assert.equal(status?.resetCredits?.length, 2);
		assert.equal(status?.weekly, undefined);
		assert.equal(status?.hourly, undefined);
	});

	it("ignores spent, paused, future and expired grants, including exact time boundaries", () => {
		const expired = new Date(now).toISOString();
		const result = anthropicResetCreditsFromResponse({ eligible: true, grants: [
			{ ...grant, id: "spent", resets_left: 0 },
			{ ...grant, id: "paused", paused: true },
			{ ...grant, id: "future", starts_at: new Date(now + 1).toISOString() },
			{ ...grant, id: "expired", ends_at: expired },
			{ ...grant, starts_at: expired, paused: false },
		] }, now);
		assert.equal(result.length, 1);
		assert.equal(result[0]?.count, 3);
	});

	it("deduplicates IDs without merging distinct grants with the same label and expiry", () => {
		const rows = anthropicResetCreditsFromResponse({ eligible: true, grants: [grant, grant, { ...grant, id: "other" }] }, now);
		assert.equal(rows.length, 2);
	});

	it("requires eligibility and tolerates supplementary schema failures", () => {
		for (const data of [undefined, null, [], {}, { grants: [grant] }, { eligible: false, grants: [grant] }, { eligible: true, grants: {} }]) {
			assert.deepEqual(anthropicResetCreditsFromResponse(data, now), []);
			assert.equal(anthropicUsageStatusFromResponse({ cedar_ember: data, five_hour: { utilization: 20 } }, "anthropic/opus", now)?.hourly?.remainingPercent, 80);
		}
	});

	it("rejects malformed IDs, quantities, pause flags and ambiguous start times", () => {
		const malformed = [null, {}, { ...grant, id: "invalid/id" },
			...[undefined, null, -1, 0, 1.5, NaN, Infinity, 1e20, "3"].map((resets_left) => ({ ...grant, resets_left })),
			{ ...grant, paused: "false" }, { ...grant, starts_at: "2026-10-05" }];
		assert.deepEqual(anthropicResetCreditsFromResponse({ eligible: true, grants: malformed }, now), []);
	});

	it("preserves unknown expiry without inventing instants and defaults empty labels", () => {
		for (const ends_at of [undefined, null, "", "invalid", "2026-10-22T22:32:35", "2027-02-30T00:00:00Z", "2026-10-05T24:00:00Z", 1792701155]) {
			assert.deepEqual(anthropicResetCreditsFromResponse({ eligible: true, grants: [{ ...grant, label: " ", ends_at }] }, now), [
				{ title: "Full reset", count: 3 },
			]);
		}
	});

	it("sorts by expiry and does not overflow the safe integer total", () => {
		const rows = anthropicResetCreditsFromResponse({ eligible: true, grants: [
			{ ...grant, id: "unknown", ends_at: null, resets_left: 1 },
			{ ...grant, id: "later", ends_at: "2026-10-29T19:59:44+01:00", resets_left: 1 },
			{ ...grant, resets_left: Number.MAX_SAFE_INTEGER - 2 },
			{ ...grant, id: "overflow", resets_left: 1 },
		] }, now);
		assert.equal(rows.length, 3);
		assert.deepEqual(rows.map((row) => row.expiresAt), [Date.parse(expiry), Date.parse("2026-10-29T19:59:44+01:00"), undefined]);
	});

	it("does not retain banked grants through stale Claude quota cache", () => {
		const status = anthropicUsageStatusFromResponse({ cedar_ember: { eligible: true, grants: [grant] }, five_hour: { utilization: 20 } }, "pi-claude-code-provider/opus", now);
		const stale = markModelUsageStale(status, now);
		assert.equal(stale?.stale, true);
		assert.equal(stale?.resetCredits, undefined);
		assert.equal(stale?.resetCreditsAvailableCount, undefined);
		assert.equal(stale?.hourly?.remainingPercent, 80);
	});
});
