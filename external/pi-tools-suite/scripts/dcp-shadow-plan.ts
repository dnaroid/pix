import { createInputFingerprint, createState } from "../src/dcp/state.js"
import { loadConfig } from "../src/dcp/config.js"
import { planDcpShadow } from "../src/dcp/shadow-plan.js"

const state = createState()
const messages: any[] = [{ role: "user", content: [{ type: "text", text: "synthetic shadow rollout fixture" }], timestamp: 1 }]
for (let index = 0; index < 20; index++) {
  const id = `shadow-${index}`
  const args = { path: `/synthetic/${index}.txt` }
  state.toolCalls.set(id, {
    toolCallId: id,
    toolName: "read",
    inputArgs: args,
    inputFingerprint: createInputFingerprint("read", args),
    isError: false,
    turnIndex: 1,
    timestamp: 3 + index * 2,
    tokenEstimate: 700,
    outputText: `fixture-${index} ${"x".repeat(2500)}`,
  })
  if (index < 18) state.providerSeenToolIds.add(id)
  messages.push({ role: "assistant", content: [{ type: "toolCall", id, name: "read", input: args }], timestamp: 2 + index * 2 })
  messages.push({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: `fixture-${index} ${"x".repeat(2500)}` }], timestamp: 3 + index * 2 })
}

const config = loadConfig({ homeDir: "/tmp/dcp-shadow-no-config" })
config.compress.autoCompress.enabled = false
const plan = planDcpShadow({ messages, state, config, contextWindow: 16_000, providerUsageTokens: 1_000 })
console.log(JSON.stringify(plan, null, 2))
