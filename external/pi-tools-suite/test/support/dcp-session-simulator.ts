import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import dcpModule from "../../src/dcp/index.js";
import { loadConfig, type DcpConfig } from "../../src/dcp/config.js";
import { DCP_JOURNAL_CUSTOM_TYPE } from "../../src/dcp/journal.js";
import { estimateMessageTokens, messageText } from "../../src/dcp/pruner-metadata.js";
import { createState, type DcpState } from "../../src/dcp/state.js";

type Handler = (event: any, ctx: any) => any;

export interface DcpSessionSimulationSample {
  step: number;
  label: string;
  rawTokens: number;
  projectedTokens: number;
  contextWindow: number;
  inputCapacityTokens: number;
  projectedContextPercent: number;
  activeSummaryTokens: number;
  activeBlocks: number;
  totalBlocks: number;
  compressionCommitted: boolean;
  commonPrefixTokens: number;
  prefixRetention: number;
  providerSent: boolean;
  reminderCarriers: string[];
}

export interface DcpSessionSimulationReport {
  turns: number;
  rawTokenOccurrences: number;
  projectedTokenOccurrences: number;
  tokenOccurrenceReductionPercent: number;
  peakRawTokens: number;
  peakProjectedTokens: number;
  peakProjectedContextPercent: number;
  compressionCommits: number;
  activeBlocks: number;
  peakActiveBlocks: number;
  summaryOnSummaryBlocks: number;
  blockOnlyConsolidations: number;
  mixedBlockRawRollups: number;
  maxBlockSummaryTokens: number;
  activeSummaryTokens: number;
  nonRewritePrefixRetentionMean: number;
  minNonRewritePrefixRetention: number;
  aborts: number;
  providerTurns: number;
  providerCapacityViolations: number;
  journalEntries: number;
  reminderProviderTurns: number;
  toolReminderProviderTurns: number;
}

export interface DcpSessionSimulatorOptions {
  contextWindow?: number;
  maxOutputTokens?: number;
  config?: DcpConfig;
  configure?: (config: DcpConfig) => void;
  sessionId?: string;
}

function tokenCount(messages: any[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function exactCommonPrefixTokens(previous: any[] | undefined, current: any[]): number {
  if (!previous || previous.length === 0) return 0;
  const count = Math.min(previous.length, current.length);
  let tokens = 0;
  for (let index = 0; index < count; index++) {
    if (JSON.stringify(previous[index]) !== JSON.stringify(current[index])) break;
    tokens += estimateMessageTokens(previous[index]);
  }
  return tokens;
}

/**
 * Deterministic end-to-end DCP session driver.
 *
 * It uses the real SessionManager/JSONL journal plus the real DCP extension
 * lifecycle. Only the remote model is replaced by a deterministic scripted
 * provider response, so tests can measure context economics without network or
 * model variance.
 */
export class DcpSessionSimulator {
  readonly dir: string;
  readonly config: DcpConfig;
  readonly samples: DcpSessionSimulationSample[] = [];
  readonly tools = new Map<string, any>();

  private manager: SessionManager;
  private handlers = new Map<string, Handler[]>();
  private ctx: any;
  private previousProjection: any[] | undefined;
  private nativeTokens = 0;
  private contextWindow: number;
  private maxOutputTokens: number;
  private timestamp = 1;
  private toolCounter = 0;
  private abortCount = 0;

  state: DcpState = createState();

  private constructor(options: DcpSessionSimulatorOptions = {}) {
    this.dir = mkdtempSync(join(tmpdir(), "dcp-session-sim-"));
    this.contextWindow = options.contextWindow ?? 24_000;
    this.maxOutputTokens = options.maxOutputTokens ?? 1_000;
    this.config = options.config ?? loadConfig({ homeDir: "/__dcp_session_sim__" });
    options.configure?.(this.config);
    this.manager = SessionManager.create(this.dir, this.dir, { id: options.sessionId ?? "dcp-session-sim" });
  }

  static async create(options: DcpSessionSimulatorOptions = {}): Promise<DcpSessionSimulator> {
    const simulator = new DcpSessionSimulator(options);
    await simulator.install("new");
    return simulator;
  }

  private async install(reason: "new" | "resume" | "fork" | "startup"): Promise<void> {
    this.handlers = new Map();
    this.tools.clear();
    const pi = {
      on: (event: string, handler: Handler) => {
        this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      },
      registerTool: (tool: any) => { this.tools.set(tool.name, tool); },
      registerCommand() {},
      appendEntry: (customType: string, data: unknown) => this.manager.appendCustomEntry(customType, data),
      sendMessage() {},
    } as any;
    this.ctx = {
      hasUI: false,
      cwd: this.dir,
      model: {
        provider: "session-sim",
        id: "deterministic",
        contextWindow: this.contextWindow,
        maxTokens: this.maxOutputTokens,
      },
      sessionManager: this.manager,
      getContextUsage: () => ({
        tokens: this.nativeTokens,
        contextWindow: this.contextWindow,
        percent: this.contextWindow > 0 ? (this.nativeTokens / this.contextWindow) * 100 : 0,
      }),
      abort: () => { this.abortCount++; },
      ui: { notify() {} },
    };
    await dcpModule(pi, { config: this.config, state: this.state });
    await this.emit("session_start", { type: "session_start", reason });
  }

  private async emit(name: string, event: any): Promise<any> {
    let result: any;
    for (const handler of this.handlers.get(name) ?? []) result = await handler(event, this.ctx);
    return result;
  }

  private nextTimestamp(): number {
    return this.timestamp++;
  }

  appendUser(text: string): void {
    this.manager.appendMessage({
      role: "user",
      content: text,
      timestamp: this.nextTimestamp(),
    } as any);
  }

  /** Execute a model-selected compress call through the actual registered tool. */
  async compress(toolCallId: string, args: unknown): Promise<any> {
    const tool = this.tools.get("compress");
    if (!tool) throw new Error("DCP compress tool is not registered");
    return tool.execute(toolCallId, args, undefined, undefined, this.ctx);
  }

  setContextWindow(contextWindow: number, maxOutputTokens = this.maxOutputTokens): void {
    this.contextWindow = contextWindow;
    this.maxOutputTokens = maxOutputTokens;
    this.ctx.model.contextWindow = contextWindow;
    this.ctx.model.maxTokens = maxOutputTokens;
  }

  async restart(): Promise<void> {
    const sessionFile = this.manager.getSessionFile();
    if (!sessionFile) throw new Error("DCP session simulator cannot restart an unpersisted session");
    this.manager = SessionManager.open(sessionFile, this.dir, this.dir);
    this.state = createState();
    this.previousProjection = undefined;
    this.nativeTokens = 0;
    await this.install("resume");
  }

  private recordSample(label: string, raw: any[], projected: any[], blockCountBefore: number): DcpSessionSimulationSample {
    const rawTokens = tokenCount(raw);
    const projectedTokens = tokenCount(projected);
    const commonPrefixTokens = exactCommonPrefixTokens(this.previousProjection, projected);
    const previousTokens = this.previousProjection ? tokenCount(this.previousProjection) : 0;
    const activeBlocks = this.state.compressionBlocks.filter((block) => block.active);
    const sample: DcpSessionSimulationSample = {
      step: this.samples.length + 1,
      label,
      rawTokens,
      projectedTokens,
      contextWindow: this.contextWindow,
      inputCapacityTokens: Math.max(0, this.contextWindow - this.maxOutputTokens),
      projectedContextPercent: this.contextWindow > 0 ? projectedTokens / this.contextWindow : 0,
      activeSummaryTokens: activeBlocks.reduce((sum, block) => sum + (block.summaryTokenEstimate ?? 0), 0),
      activeBlocks: activeBlocks.length,
      totalBlocks: this.state.compressionBlocks.length,
      compressionCommitted: this.state.compressionBlocks.length > blockCountBefore,
      commonPrefixTokens,
      prefixRetention: previousTokens > 0 ? commonPrefixTokens / previousTokens : 1,
      providerSent: false,
      reminderCarriers: projected.filter((message) => messageText(message).includes("<dcp-system-reminder>"))
        .map((message) => message.role),
    };
    this.samples.push(sample);
    this.previousProjection = structuredClone(projected);
    this.nativeTokens = projectedTokens;
    return sample;
  }

  async project(label = "projection"): Promise<{ messages: any[]; sample: DcpSessionSimulationSample }> {
    const raw = this.manager.buildSessionContext().messages;
    const blockCountBefore = this.state.compressionBlocks.length;
    const abortedBefore = this.abortCount;
    const result = await this.emit("context", { type: "context", messages: raw }) as { messages: any[] };
    const messages = result?.messages ?? raw;
    const sample = this.recordSample(label, raw, messages, blockCountBefore);
    if (this.abortCount !== abortedBefore) {
      throw new Error(`DCP session simulator aborted during ${label}`);
    }
    return { messages, sample };
  }

  private async beginProviderTurn(label: string): Promise<{ messages: any[]; sample: DcpSessionSimulationSample }> {
    const projected = await this.project(label);
    const abortedBefore = this.abortCount;
    await this.emit("before_provider_request", {
      type: "before_provider_request",
      payload: { messages: projected.messages },
    });
    if (this.abortCount !== abortedBefore) {
      throw new Error(`DCP session simulator aborted before provider send during ${label}`);
    }
    projected.sample.providerSent = true;
    await this.emit("after_provider_response", {
      type: "after_provider_response",
      status: 200,
      headers: {},
    });
    return projected;
  }

  async toolTurn(options: {
    toolName?: string;
    input?: Record<string, unknown>;
    output: string;
    isError?: boolean;
    label?: string;
  }): Promise<DcpSessionSimulationSample> {
    const toolName = options.toolName ?? "read";
    const toolCallId = `session-sim-tool-${++this.toolCounter}`;
    const input = options.input ?? { path: `/fixture/${toolCallId}.txt` };
    const { sample } = await this.beginProviderTurn(options.label ?? `tool:${toolName}:${this.toolCounter}`);
    const assistant = {
      role: "assistant",
      api: "openai-responses",
      provider: "session-sim",
      model: "deterministic",
      stopReason: "toolUse",
      timestamp: this.nextTimestamp(),
      usage: zeroUsage(),
      content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: input }],
    };
    this.manager.appendMessage(assistant as any);
    await this.emit("message_end", { type: "message_end", message: assistant });
    await this.emit("tool_call", { type: "tool_call", toolCallId, toolName, input });

    const result = {
      role: "toolResult",
      toolCallId,
      toolName,
      isError: options.isError ?? false,
      timestamp: this.nextTimestamp(),
      content: [{ type: "text", text: options.output }],
      details: {},
    };
    this.manager.appendMessage(result as any);
    await this.emit("tool_result", {
      type: "tool_result",
      toolCallId,
      toolName,
      content: result.content,
      details: result.details,
      isError: result.isError,
    });
    return sample;
  }

  async assistantTurn(text: string, label = "assistant:stop"): Promise<DcpSessionSimulationSample> {
    const { sample } = await this.beginProviderTurn(label);
    const assistant = {
      role: "assistant",
      api: "openai-responses",
      provider: "session-sim",
      model: "deterministic",
      stopReason: "stop",
      timestamp: this.nextTimestamp(),
      usage: zeroUsage(),
      content: [{ type: "text", text }],
    };
    this.manager.appendMessage(assistant as any);
    await this.emit("message_end", { type: "message_end", message: assistant });
    return sample;
  }

  report(): DcpSessionSimulationReport {
    const rawTokenOccurrences = this.samples.reduce((sum, sample) => sum + sample.rawTokens, 0);
    const projectedTokenOccurrences = this.samples.reduce((sum, sample) => sum + sample.projectedTokens, 0);
    const nonRewrite = this.samples.slice(1).filter((sample) => !sample.compressionCommitted);
    const activeBlocks = this.state.compressionBlocks.filter((block) => block.active);
    const blockOnlyConsolidations = this.state.compressionBlocks.filter((block) => {
      const covered = block.coveredBlockIds?.length ?? 0;
      return covered > 0 && block.sourceCoverage?.itemCount === covered;
    }).length;
    const mixedBlockRawRollups = this.state.compressionBlocks.filter((block) => {
      const covered = block.coveredBlockIds?.length ?? 0;
      return covered > 0 && (block.sourceCoverage?.itemCount ?? covered + 1) > covered;
    }).length;
    const providerSamples = this.samples.filter((sample) => sample.providerSent);
    const journalEntries = this.manager.getBranch().filter((entry: any) =>
      entry?.type === "custom" && entry?.customType === DCP_JOURNAL_CUSTOM_TYPE,
    ).length;
    return {
      turns: this.samples.length,
      rawTokenOccurrences,
      projectedTokenOccurrences,
      tokenOccurrenceReductionPercent: rawTokenOccurrences > 0
        ? ((rawTokenOccurrences - projectedTokenOccurrences) / rawTokenOccurrences) * 100
        : 0,
      peakRawTokens: Math.max(0, ...this.samples.map((sample) => sample.rawTokens)),
      peakProjectedTokens: Math.max(0, ...this.samples.map((sample) => sample.projectedTokens)),
      peakProjectedContextPercent: Math.max(0, ...this.samples.map((sample) => sample.projectedContextPercent)),
      compressionCommits: this.state.compressionBlocks.length,
      activeBlocks: activeBlocks.length,
      peakActiveBlocks: Math.max(0, ...this.samples.map((sample) => sample.activeBlocks)),
      summaryOnSummaryBlocks: this.state.compressionBlocks.filter((block) => (block.coveredBlockIds ?? []).length > 0).length,
      blockOnlyConsolidations,
      mixedBlockRawRollups,
      maxBlockSummaryTokens: Math.max(0, ...this.state.compressionBlocks.map((block) => block.summaryTokenEstimate ?? 0)),
      activeSummaryTokens: activeBlocks.reduce((sum, block) => sum + (block.summaryTokenEstimate ?? 0), 0),
      nonRewritePrefixRetentionMean: nonRewrite.length > 0
        ? nonRewrite.reduce((sum, sample) => sum + sample.prefixRetention, 0) / nonRewrite.length
        : 1,
      minNonRewritePrefixRetention: nonRewrite.length > 0
        ? Math.min(...nonRewrite.map((sample) => sample.prefixRetention))
        : 1,
      aborts: this.abortCount,
      providerTurns: providerSamples.length,
      providerCapacityViolations: providerSamples.filter((sample) => sample.projectedTokens > sample.inputCapacityTokens).length,
      journalEntries,
      reminderProviderTurns: providerSamples.filter((sample) => sample.reminderCarriers.length > 0).length,
      toolReminderProviderTurns: providerSamples.filter((sample) => sample.reminderCarriers.includes("toolResult")).length,
    };
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
