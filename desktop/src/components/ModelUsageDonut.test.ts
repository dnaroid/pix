import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import ModelUsageDonut from "./ModelUsageDonut.svelte";

describe("ModelUsageDonut", () => {
  it("distinguishes models from the same provider and matches segment colors to legend dots", () => {
    const { body } = render(ModelUsageDonut, { props: { models: [
      { provider: "openai-codex", model: "sol", totalTokens: 900 },
      { provider: "openai-codex", model: "luna", totalTokens: 100 },
    ] } });
    const strokes = [...body.matchAll(/class="stroke-([^\"]+)"/g)]
      .map((match) => match[1]).filter((tone) => tone !== "border");
    const dots = [...body.matchAll(/rounded-full bg-([^\"]+)/g)].map((match) => match[1]);
    expect(strokes).toHaveLength(2);
    expect(new Set(strokes).size).toBe(2);
    expect(dots).toEqual(strokes);
    expect(body.match(/data-model-separator/g)).toHaveLength(2);
    expect(body).toContain('rotate(0 18 18)');
    expect(body).toContain('rotate(324 18 18)');
    expect(body).toContain('stroke="var(--popover)" stroke-width="0.5"');
  });
  it("renders a legend row and ring segment per model with nonzero tokens", () => {
    const { body } = render(ModelUsageDonut, {
      props: {
        models: [
          { provider: "pi-claude-code-provider", model: "sonnet", totalTokens: 8_080_000 },
          { provider: "openai-codex", model: "gpt-6.1-sol", totalTokens: 1_660_000 },
          { provider: "openai-codex", model: "gpt-6-luna", totalTokens: 356_100 },
        ],
      },
    });
    expect(body).toContain('aria-label="Token usage by model"');
    expect(body).toContain("sonnet");
    expect(body).toContain("gpt-6.1-sol");
    expect(body).toContain("gpt-6-luna");
    expect(body.match(/<circle/g)?.length).toBeGreaterThanOrEqual(4); // track + 3 segments
    expect(body).toContain("10.1M");
  });

  it("renders nothing with zero or one priced model", () => {
    const zero = render(ModelUsageDonut, { props: { models: [] } }).body;
    expect(zero).not.toContain("data-model-usage-donut");

    const one = render(ModelUsageDonut, {
      props: { models: [{ provider: "pi-claude-code-provider", model: "sonnet", totalTokens: 100 }] },
    }).body;
    expect(one).not.toContain("data-model-usage-donut");
  });

  it("excludes models with zero tokens from the legend and share calculation", () => {
    const { body } = render(ModelUsageDonut, {
      props: {
        models: [
          { provider: "pi-claude-code-provider", model: "sonnet", totalTokens: 900 },
          { provider: "openai-codex", model: "gpt-6-luna", totalTokens: 100 },
          { provider: "openai-codex", model: "idle-model", totalTokens: 0 },
        ],
      },
    });
    expect(body).toContain("sonnet");
    expect(body).toContain("gpt-6-luna");
    expect(body).not.toContain("idle-model");
  });
});
