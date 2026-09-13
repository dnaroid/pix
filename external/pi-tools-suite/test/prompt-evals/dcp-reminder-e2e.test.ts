import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import { SYSTEM_PROMPT } from "../../src/dcp/prompts.js";
import { completeWithModelRegistry } from "../../src/model-completion.js";
import { createLiveModelContext, resolveLiveModelRef } from "../support/live-model.js";
import { prepareDcpReminderScenario } from "../support/dcp-reminder-scenario.js";

const enabled = /^(1|true|yes)$/i.test(process.env.DCP_REMINDER_E2E ?? process.env.PROMPT_EVAL_E2E ?? "");
const liveTest = enabled ? test : test.skip;

describe("DCP live reminder response", () => {
  liveTest("model calls compress from a real mid-turn reminder and the call commits positive gain", async () => {
    const live = await createLiveModelContext(resolveLiveModelRef("DCP_REMINDER_E2E_MODEL"));
    const { sim, projected } = await prepareDcpReminderScenario();
    try {
      expect(projected.sample.reminderCarriers).toEqual(["toolResult"]);
      expect(sim.state.compressionBlocks).toHaveLength(0);
      const tool = sim.tools.get("compress");
      const auth = await live.modelRegistry.getApiKeyAndHeaders(live.model);
      if (!auth.ok) throw new Error("Live DCP reminder eval authentication unavailable");
      // No forced tool_choice, no extra user asking for compression and no
      // behavioral retries: the genuine DCP reminder must cause the tool call.
      const response = await completeWithModelRegistry(live.modelRegistry, live.model, {
        systemPrompt: `You are a coding agent. Choose the next useful tool action from the conversation.\n\n${SYSTEM_PROMPT}`,
        messages: projected.messages,
        tools: [
          { name: tool.name, description: tool.description, parameters: tool.parameters },
          { name: "read", description: "Inspect a source file.", parameters: Type.Object({ path: Type.String() }) },
          { name: "shell", description: "Run a targeted verification command.", parameters: Type.Object({ command: Type.String() }) },
        ],
      }, { apiKey: auth.apiKey, headers: auth.headers, env: auth.env,
        signal: AbortSignal.timeout(60_000), maxTokens: 2_048 } as any);
      if (response.stopReason === "error") {
        const reason = (response.errorMessage ?? "unspecified provider failure")
          .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
          .replace(/https?:\/\/[^\s]+/g, "[provider URL]");
        throw new Error(`Live DCP provider failure (${live.model.provider}/${live.model.id}): ${reason}`);
      }
      expect(response.stopReason).toBe("toolUse");
      const calls = response.content.filter((part) => part.type === "toolCall");
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((call: any) => call.name === "compress")).toBe(true);
      for (const call of calls) {
        const result = await sim.compress(call.id, call.arguments);
        expect(result.details?.committed).toBe(true);
        expect(result.details?.netGain).toBeGreaterThan(0);
      }
      expect(sim.state.compressionBlocks.length).toBeGreaterThan(0);
      const after = await sim.project("after-model-compress");
      expect(after.sample.projectedTokens).toBeLessThan(projected.sample.projectedTokens);
      expect(JSON.stringify(after.messages)).toContain("Keep the public API unchanged");
    } finally { sim.dispose(); }
  }, 120_000);
});
