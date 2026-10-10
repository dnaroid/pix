import { DEFAULT_HEADS_UP_CONFIG, DEFAULT_HEADS_UP_MODEL } from "../../src/bundled-extensions/heads-up/config.js";

export interface EvalOptions {
	live: boolean;
	help: boolean;
	models: string[];
	caseIds: string[];
	repeat: number;
	maxCalls: number;
	timeoutMs: number;
}
export const EVAL_HELP = `Heads up eval (run from the repository checkout)
  npm run eval:heads-up                         Validate/list synthetic fixtures; zero model calls
  npm run eval:heads-up -- --live               Evaluate with the configured default candidate
  npm run eval:heads-up -- --live --model provider/id --case api-break
  npm run eval:heads-up -- --live --repeat 3 --max-calls 54

Options:
  --live                 Explicit network/billing opt-in; never reads conversation histories
  --model provider/id    Repeat to compare up to 3 exact model refs; no fallback
  --case id             Repeat to select scenarios; unknown IDs are errors
  --repeat N            1..5 independent passes (default 1)
  --max-calls N         Explicit upper bound for the whole matrix, 1..120 (default 34)
  --timeout-ms N        1000..120000 (default production timeout ${DEFAULT_HEADS_UP_CONFIG.timeoutMs})
  --help                Show this help

Live reports: unique .pi/artifacts/heads-up-eval-*/ (JSON, JSONL, Markdown).
Exit 0: fixture validation / all live cases pass; 1: quality regression; 2: incomplete/invalid run.
PI_OFFLINE forbids live runs. Repeats/case labels/expected answers are not sent to the model.
`;

export function parseOptions(args: readonly string[]): EvalOptions {
	const options: EvalOptions = { live: false, help: false, models: [], caseIds: [], repeat: 1, maxCalls: 34, timeoutMs: DEFAULT_HEADS_UP_CONFIG.timeoutMs };
	const seen = new Set<string>();
	for (let i = 0; i < args.length; i++) {
		const flag = args[i]!;
		if (flag === "--help") { options.help = true; continue; }
		if (flag === "--live") { options.live = true; continue; }
		if (!["--model", "--case", "--repeat", "--max-calls", "--timeout-ms"].includes(flag)) throw new Error(`Unknown option: ${flag}`);
		const value = args[++i];
		if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
		if (flag === "--model") {
			if (value.length > 256 || !/^[a-zA-Z0-9_.-]+\/[^\s\x00-\x1f]+$/.test(value)) throw new Error("Model must be provider/model-id");
			if (!options.models.includes(value)) options.models.push(value);
		} else if (flag === "--case") {
			if (!/^[a-z0-9-]+$/.test(value)) throw new Error("Invalid case ID");
			if (!options.caseIds.includes(value)) options.caseIds.push(value);
		} else {
			if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
			seen.add(flag);
			const maximums: Record<string, number> = { "--repeat": 5, "--max-calls": 120, "--timeout-ms": 120000 };
			const max = maximums[flag]!;
			const min = flag === "--timeout-ms" ? 1000 : 1;
			const number = Number(value);
			if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${flag} must be ${min}..${max}`);
			if (flag === "--repeat") options.repeat = number;
			else if (flag === "--max-calls") options.maxCalls = number;
			else options.timeoutMs = number;
		}
	}
	if (!options.models.length) options.models.push(DEFAULT_HEADS_UP_MODEL);
	if (options.models.length > 3) throw new Error("At most 3 models per run");
	return options;
}

export function validateCallBudget(caseCount: number, options: EvalOptions): number {
	const calls = caseCount * options.repeat * options.models.length;
	if (calls > options.maxCalls) throw new Error(`Matrix needs ${calls} requests, above --max-calls ${options.maxCalls}; select fewer cases or explicitly raise the cap`);
	return calls;
}
