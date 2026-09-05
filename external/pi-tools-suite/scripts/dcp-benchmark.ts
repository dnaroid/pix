import { performance } from "node:perf_hooks";
import { applyPruning } from "../src/dcp/pruner.js";
import { createState } from "../src/dcp/state.js";
import { loadConfig } from "../src/dcp/config.js";

interface BenchmarkResult {
  messages: number;
  textBytes: number;
  repetitions: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q));
  return sorted[index]!;
}

function fixture(messageCount: number, totalTextBytes: number): any[] {
  const perMessage = Math.max(1, Math.floor(totalTextBytes / messageCount));
  return Array.from({ length: messageCount }, (_, index) => ({
    role: index % 7 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `m${index}:` + "x".repeat(perMessage) }],
    timestamp: index + 1,
  }));
}

function benchmark(messageCount: number, totalTextBytes: number, repetitions: number): BenchmarkResult {
  const config = loadConfig({ homeDir: "/tmp/dcp-benchmark-no-config" });
  config.debug = false;
  config.strategies.deduplication.enabled = false;
  config.strategies.purgeErrors.enabled = false;
  config.strategies.autoToolPruning.enabled = false;
  config.strategies.emergencyCurrentTurnPruning.enabled = false;
  const state = createState();
  const messages = fixture(messageCount, totalTextBytes);

  for (let index = 0; index < 3; index++) applyPruning(messages, state, config);
  const samples: number[] = [];
  for (let index = 0; index < repetitions; index++) {
    const started = performance.now();
    applyPruning(messages, state, config);
    samples.push(performance.now() - started);
  }

  return {
    messages: messageCount,
    textBytes: totalTextBytes,
    repetitions,
    p50Ms: Number(quantile(samples, 0.50).toFixed(3)),
    p95Ms: Number(quantile(samples, 0.95).toFixed(3)),
    p99Ms: Number(quantile(samples, 0.99).toFixed(3)),
    maxMs: Number(Math.max(...samples).toFixed(3)),
  };
}

const results = [
  benchmark(100, 100_000, 40),
  benchmark(1_000, 1_048_576, 30),
  benchmark(10_000, 5_000_000, 12),
];

for (const result of results) console.log(JSON.stringify(result));
