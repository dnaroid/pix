import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import ResetCreditsSection from "./ResetCreditsSection.svelte";

const now = new Date(2026, 9, 4, 22, 0, 0).getTime();

describe("ResetCreditsSection", () => {
  it("shows banked grant quantities and a visible expiration date without duplicate rows", () => {
    const expiresAt = new Date(2026, 9, 22, 22, 32, 35).getTime();
    const { body } = render(ResetCreditsSection, { props: { now, availableCount: 3, credits: [{ title: "Full reset", count: 3, expiresAt }] } });
    expect(body).toContain("3 available");
    expect(body).toContain("Full reset ×3");
    expect(body).toContain(new Date(expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " · Expires in");
    expect(body.match(/Full reset/g)).toHaveLength(1);
    expect(body).not.toContain("Expiry details unavailable");
    expect(body).not.toContain("<button");
  });

  it("expires every reset in a grant at once and counts missing details by resets", () => {
    const credits = [{ title: "Early", count: 3, expiresAt: now + 1 }, { title: "Later", count: 2 }];
    const before = render(ResetCreditsSection, { props: { now, credits, availableCount: 6 } }).body;
    expect(before).toContain("6 available");
    expect(before).toContain("Expiry details unavailable for 1 credit");
    const after = render(ResetCreditsSection, { props: { now: now + 1, credits, availableCount: 6 } }).body;
    expect(after).toContain("3 available");
    expect(after).not.toContain("Early");
    expect(after).toContain("Later ×2");
    expect(after).toContain("Expiry details unavailable for 1 credit");
  });

  it("caps displayed grant quantities at the available total", () => {
    const body = render(ResetCreditsSection, { props: { now, credits: [{ title: "Full reset", count: 5 }], availableCount: 2 } }).body;
    expect(body).toContain("2 available");
    expect(body).toContain("Full reset ×2");
    expect(body).not.toContain("×5");
    expect(body).not.toContain("Expiry details unavailable");
  });
  it("uses plain compact rows and colors only credits expiring in less than 24 hours", () => {
    for (const [remaining, urgent] of [[1, true], [86_399_999, true], [86_400_000, false], [86_400_001, false]] as const) {
      const { body } = render(ResetCreditsSection, { props: { now, credits: [{ title: "Full reset", expiresAt: now + remaining }] } });
      expect(body).not.toContain("<details");
      expect(body).not.toContain("<summary");
      expect(body).toContain("truncate");
      expect(body.match(/text-tool-error/g) ?? []).toHaveLength(urgent ? 2 : 0);
    }
    const unknown = render(ResetCreditsSection, { props: { now, credits: [{ title: "Full reset" }] } }).body;
    expect(unknown).not.toContain("text-tool-error");
  });
  it("shows live credits with exact local expiry and countdown while hiding expired credits", () => {
    const firstExpiry = new Date(2026, 9, 5, 6, 19, 37).getTime();
    const secondExpiry = new Date(2026, 9, 22, 22, 32, 35).getTime();
    const { body } = render(ResetCreditsSection, {
      props: {
        now,
        credits: [
          { title: "Full reset", expiresAt: firstExpiry },
          { title: "Full reset", expiresAt: secondExpiry },
          { title: "Old reset", expiresAt: now - 1 },
        ],
      },
    });

    expect(body).toContain('aria-label="Available reset credits"');
    expect(body).toContain("2 available");
    expect(body).toContain(new Date(firstExpiry).toLocaleString(undefined, {
      month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }));
    expect(body).toContain("Expires in 8h20m");
    expect(body).not.toContain("Local time");
    expect(body).not.toContain("Old reset");
  });

  it("keeps available credits whose expiry is missing without inventing a time", () => {
    const { body } = render(ResetCreditsSection, {
      props: { now, credits: [{ title: "Full reset" }] },
    });
    expect(body).toContain("1 available");
    expect(body).toContain("Expiry unavailable");
    expect(body).not.toContain("text-tool-error");
  });

  it("renders nothing when every known credit has expired", () => {
    const { body } = render(ResetCreditsSection, {
      props: { now, credits: [{ title: "Full reset", expiresAt: now - 1 }] },
    });
    expect(body).not.toContain("Reset credits");
    expect(body).not.toContain("Available reset credits");
  });

  it("removes a credit exactly at expiry and rounds sub-minute countdowns up", () => {
    const credits = [{ title: "Full reset", expiresAt: now + 1 }];
    expect(render(ResetCreditsSection, { props: { now, credits } }).body).toContain("Expires in 1m");
    expect(render(ResetCreditsSection, { props: { now: now + 1, credits } }).body).not.toContain("Reset credits");
  });

  it("renders three credits, truncates long titles, and never renders title markup", () => {
    const title = "<script>" + "x".repeat(200);
    const { body } = render(ResetCreditsSection, { props: { now, credits: [
      { title }, { title: "Full reset" }, { title: "Full reset" },
    ] } });
    expect(body).toContain("3 available");
    expect(body).toContain("truncate");
    expect(body).toContain("&lt;script>");
    expect(body).not.toContain("<script>");
  });

  it("preserves the backend total when details are capped or unavailable", () => {
    const partial = render(ResetCreditsSection, { props: { now, availableCount: 3, credits: [{ title: "Full reset" }] } }).body;
    expect(partial).toContain("3 available");
    expect(partial).toContain("Expiry details unavailable for 2 credits");
    const summary = render(ResetCreditsSection, { props: { now, availableCount: 3, credits: [] } }).body;
    expect(summary).toContain("3 available");
    expect(summary).not.toContain("Full reset");
  });

  it("decrements the snapshot total for known expirations and respects zero availability", () => {
    const credits = [{ title: "Full reset", expiresAt: now + 1 }, { title: "Full reset" }];
    const expired = render(ResetCreditsSection, { props: { now: now + 1, availableCount: 3, credits } }).body;
    expect(expired).toContain("2 available");
    expect(expired).toContain("Expiry details unavailable for 1 credit");
    expect(render(ResetCreditsSection, { props: { now, availableCount: 0, credits } }).body).not.toContain("Reset credits");
  });

  it.runIf(Intl.DateTimeFormat().resolvedOptions().timeZone === "Europe/Berlin")("uses local CEST/CET across the October DST transition", () => {
    const epochs = [1791173977, 1792701155, 1793300384];
    const expected = [[5, 6, 19, 37, -120], [22, 22, 32, 35, -120], [29, 19, 59, 44, -60]];
    for (const [index, epoch] of epochs.entries()) {
      const date = new Date(epoch * 1000);
      expect([date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getTimezoneOffset()]).toEqual(expected[index]);
      const { body } = render(ResetCreditsSection, { props: { now, credits: [{ title: "Full reset", expiresAt: epoch * 1000 }] } });
      expect(body).toContain(date.toLocaleString(undefined, {
        month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
      }));
    }
  });
});
