import { describe, expect, test } from "bun:test"
import type { DcpConfig } from "../src/dcp/config.js"
import { planDcpShadow } from "../src/dcp/shadow-plan.js"
import { createInputFingerprint, createState, serializeState } from "../src/dcp/state.js"

function config(): DcpConfig {
  return {
    enabled: true,
    debug: false,
    manualMode: { enabled: false, automaticStrategies: true },
    compress: {
      minContextPercent: 0.4,
      maxContextPercent: 0.65,
      modelMinContextPercent: {},
      modelMaxContextPercent: {},
      summaryBuffer: true,
      nudgeFrequency: 2,
      iterationNudgeThreshold: 8,
      nudgeForce: "soft",
      protectedTools: ["compress", "write", "edit"],
      protectTags: false,
      protectUserMessages: false,
      autoCandidates: { enabled: true, minContextPercent: 0.1, keepRecentTurns: 1, minMessages: 2, minTokens: 100 },
      messageMode: { enabled: true, minContextPercent: 0.1, keepRecentTurns: 1, mediumTokens: 100, highTokens: 500, maxSuggestions: 5 },
      autoCompress: { enabled: false, patience: 2, summarizerModel: [], timeoutMs: 20_000 },
    },
    strategies: {
      deduplication: { enabled: false, protectedTools: [] },
      purgeErrors: { enabled: false, turns: 4, protectedTools: [] },
      autoToolPruning: { enabled: false, maxOutputTokens: 1200, keepRecentTurns: 1, readLikeTools: ["read"], readLikeTurns: 3, protectedTools: [] },
      emergencyCurrentTurnPruning: { enabled: true, hardContextPercent: 0.82, targetContextPercent: 0.7, patience: 2, keepRecentToolPairs: 1, minOutputTokens: 100, maxSuggestions: 8, protectedTools: [] },
    },
    protectedFilePatterns: [],
    pruneNotification: "off",
    modelOverrides: {},
  }
}

describe("DCP shadow planner", () => {
  test("plans pressure/candidates on a detached clone with zero live-state mutation", () => {
    const state = createState()
    const messages: any[] = [{ role: "user", content: [{ type: "text", text: "single task" }], timestamp: 1 }]
    for (let index = 0; index < 12; index++) {
      const id = `shadow-${index}`
      state.toolCalls.set(id, {
        toolCallId: id,
        toolName: "read",
        inputArgs: { path: `/repo/${index}.txt` },
        inputFingerprint: createInputFingerprint("read", { path: `/repo/${index}.txt` }),
        isError: false,
        turnIndex: 1,
        timestamp: 3 + index * 2,
        tokenEstimate: 700,
        outputText: `shadow output ${index} ${"x".repeat(2500)}`,
      })
      if (index < 10) state.providerSeenToolIds.add(id)
      messages.push({ role: "assistant", content: [{ type: "toolCall", id, name: "read", input: { path: `/repo/${index}.txt` } }], timestamp: 2 + index * 2 })
      messages.push({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: `shadow output ${index} ${"x".repeat(2500)}` }], timestamp: 3 + index * 2 })
    }
    const before = JSON.stringify(serializeState(state))
    const beforeSnapshots = {
      messageIds: [...state.messageIdSnapshot],
      messageMeta: [...state.messageMetaSnapshot],
      conversationIndex: JSON.stringify(state.conversationIndexSnapshot),
    }

    const result = planDcpShadow({
      messages,
      state,
      config: config(),
      contextWindow: 10_000,
      providerUsageTokens: 1_000,
    })

    expect(result.budget.projectionOrigin).toBe("repo-over-provider")
    expect(result.budget.pressured).toBe(true)
    expect(result.routineCandidate ?? result.emergencyCandidate).not.toBe(null)
    expect(JSON.stringify(serializeState(state))).toBe(before)
    expect([...state.messageIdSnapshot]).toEqual(beforeSnapshots.messageIds)
    expect([...state.messageMetaSnapshot]).toEqual(beforeSnapshots.messageMeta)
    expect(JSON.stringify(state.conversationIndexSnapshot)).toBe(beforeSnapshots.conversationIndex)
  })
})
