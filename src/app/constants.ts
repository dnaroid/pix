import { join } from "node:path";
import type { ResolvedToolRule } from "../config.js";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export const THINKING_MENU_MAX_ROWS = THINKING_LEVELS.length + 1;
export const PI_FAVORITE_MODEL_REFS = [
	"amazon-bedrock/us.anthropic.claude-opus-4-6-v1",
	"anthropic/claude-opus-4-8",
	"openai/gpt-5.4",
	"azure-openai-responses/gpt-5.4",
	"openai-codex/gpt-5.5",
	"deepseek/deepseek-v4-pro",
	"google/gemini-3.1-pro-preview",
	"google-vertex/gemini-3.1-pro-preview",
	"github-copilot/gpt-5.4",
	"openrouter/moonshotai/kimi-k2.6",
	"vercel-ai-gateway/zai/glm-5.2",
	"xai/grok-4.20-0309-reasoning",
	"groq/openai/gpt-oss-120b",
	"cerebras/zai-glm-4.7",
	"zai/glm-5.2",
	"mistral/devstral-medium-latest",
	"minimax/MiniMax-M2.7",
	"minimax-cn/MiniMax-M2.7",
	"moonshotai/kimi-k2.6",
	"moonshotai-cn/kimi-k2.6",
	"huggingface/moonshotai/Kimi-K2.6",
	"fireworks/accounts/fireworks/models/kimi-k2p6",
	"together/moonshotai/Kimi-K2.6",
	"opencode/kimi-k2.6",
	"opencode-go/kimi-k2.6",
	"kimi-coding/kimi-for-coding",
	"cloudflare-workers-ai/@cf/moonshotai/kimi-k2.6",
	"cloudflare-ai-gateway/workers-ai/@cf/moonshotai/kimi-k2.6",
	"xiaomi/mimo-v2.5-pro",
	"xiaomi-token-plan-cn/mimo-v2.5-pro",
	"xiaomi-token-plan-ams/mimo-v2.5-pro",
	"xiaomi-token-plan-sgp/mimo-v2.5-pro",
] as const;
export const SLASH_COMMAND_MENU_MAX_ROWS = 6;
export const RESUME_MENU_MAX_ROWS = 20;
export const RESUME_MENU_INITIAL_SESSION_ROWS = 30;
export const RESUME_MENU_LOAD_BATCH_ROWS = 10;
export const RESUME_MENU_LOAD_THRESHOLD_ROWS = 10;
export const SLASH_COMMAND_DESCRIPTION_COLUMN = 36;
export const INPUT_MAX_ROWS = 8;
export const RUNTIME_DISPOSE_GRACE_MS = 250;
export const PASTE_DUPLICATE_WINDOW_MS = 1200;
export const TOAST_DURATION_MS = 5000;
export const STATUS_BLINK_INTERVAL_MS = 500;
export const MODEL_USAGE_STATUS_TICK_MS = 60_000;
export const MODEL_USAGE_POLL_INTERVAL_MS = 5 * 60_000;
export const REQUEST_HISTORY_VERSION = 1;
export const REQUEST_HISTORY_MAX_ENTRIES = 200;
export const REQUEST_HISTORY_MAX_BYTES = 128 * 1024;
export const REQUEST_HISTORY_MAX_ENTRY_BYTES = 16 * 1024;
// Match pi/@earendil-works/pi-tui keyboard setup: request Kitty keyboard
// protocol flags, query the terminal response, and use xterm modifyOtherKeys
// only as a response-driven fallback. Enabling both protocols blindly can make
// terminals disagree about modified Enter reporting.
export const ENABLE_TERMINAL_KEY_REPORTING = "\x1b[>7u\x1b[?u\x1b[c";
export const ENABLE_TERMINAL_MODIFY_OTHER_KEYS = "\x1b[>4;2m";
export const DISABLE_TERMINAL_KEY_REPORTING = "\x1b[<u\x1b[>4;0m";
export const ENABLE_BRACKETED_PASTE = "\x1b[?2004h";
export const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";
export const DISABLE_TERMINAL_WRAP = "\x1b[?7l";
export const ENABLE_TERMINAL_WRAP = "\x1b[?7h";
export const HIDE_CURSOR = "\x1b[?25l";
export const SHOW_CURSOR = "\x1b[?25h";
export const RESET_TERMINAL_VIEWPORT_STATE = "\x1b[?6l\x1b[?69l\x1b[r";
export const CLEAR_TERMINAL = "\x1b[2J\x1b[3J\x1b[H";
export const THINKING_TOOL_NAME = "thinking";
export const SUBAGENTS_TOOL_NAME = "subagents";
export const SUBAGENTS_TOOL_NAME_PREFIX = "async_subagents_";
export const SUBAGENTS_RUN_ROOT = join(".pi", "subagents");
export const SUBAGENTS_REGISTRY_FILE = "registry.json";
export const SUBAGENT_PARENT_SESSION_FILE = "parent_session";
export const SUBAGENTS_POLL_INTERVAL_MS = 1_500;
export const SUBAGENTS_WIDGET_MAX_ROWS = 8;
export const DEFAULT_THINKING_TOOL_RULE: ResolvedToolRule = {
	previewLines: 0,
	direction: "head",
	color: "thinkingForeground",
};
export const TERMINAL_COMMAND_MODIFIER_FLAG = 8;
export const GIT_BRANCH_CACHE_MS = 30_000;
export const TODO_TOOL_NAME = "todo";

export const TODO_ACTIONS = [
	"create",
	"update",
	"batch_create",
	"batch_update",
	"list",
	"get",
	"delete",
	"clear",
	"export",
	"import",
] as const;

export const TODO_STATUSES = ["pending", "in_progress", "deferred", "completed", "deleted"] as const;

export const SUBAGENT_STATUSES = ["planned", "running", "retrying", "done", "failed", "stopped"] as const;
export const SUBAGENT_ACTIVE_STATUSES = ["planned", "running", "retrying"] as const;
export const SUBAGENT_TERMINAL_STATUSES = ["done", "failed", "stopped"] as const;
export const SUBAGENT_RENDER_MODES = ["spawn", "status", "wait", "stop", "completion"] as const;

export const ABOVE_EDITOR_WIDGET_KEY_GROUPS: readonly (readonly string[])[] = [
	["rpiv-todos", "plan-todos"],
	["async-subagents-live"],
];
export const LEGACY_TODO_WIDGET_KEYS = new Set(["rpiv-todos", "plan-todos"]);
export const BUILT_IN_SUBAGENTS_WIDGET_KEYS = new Set(["async-subagents-live"]);
