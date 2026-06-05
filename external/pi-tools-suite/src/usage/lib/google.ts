/**
 * Google Cloud 额度查询模块
 *
 * [输入]: ~/.pi/agent/auth.json 中的 Antigravity 账号信息
 * [输出]: 格式化的额度使用情况（按重置时间自动分组）
 * [定位]: 被 usage.ts 调用，处理 Google Cloud 账号
 * [同步]: usage.ts, types.ts, utils.ts
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  type QueryResult,
  type AntigravityAccount,
  HIGH_USAGE_THRESHOLD,
} from "./types";
import { createProgressBar, fetchWithTimeout, safeMax } from "./utils";

// ============================================================================
// 类型定义
// ============================================================================

interface GoogleQuotaResponse {
  models: Record<
    string,
    {
      quotaInfo?: {
        remainingFraction?: number;
        resetTime?: string;
      };
    }
  >;
}

/** 单个模型的额度信息 */
interface ModelQuota {
  displayName: string;
  remainPercent: number;
  resetTimeDisplay: string;
}

/** 账号额度信息 */
interface AccountQuotaInfo {
  email: string;
  models: ModelQuota[];
  maxUsage: number;
}

type PiAntigravityCredential = {
  type?: string;
  refresh?: string;
  email?: string;
  clientId?: string;
  clientSecret?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  oauthClient?: { clientId?: string; clientSecret?: string };
  accounts?: AntigravityAccount[];
};

type GoogleOAuthClientCredentials = { clientId: string; clientSecret?: string };

// ============================================================================
// 常量
// ============================================================================

const GOOGLE_QUOTA_API_URL =
  "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
const USER_AGENT = "antigravity/1.11.9 windows/amd64";

// Backend model keys currently exposed by the Antigravity provider.
// Keep this in sync with pi-tools-suite/src/antigravity-auth/index.ts modelDefinitions
// and resolveActualModel(). Multiple public Pi model IDs may share one backend
// quota bucket, so this list intentionally contains backend keys only.
const ENABLED_MODEL_KEYS = new Set([
  "gemini-3.1-pro-low",
  "gemini-3-flash",
  "gemini-2.5-flash",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
]);

// Display name mapping for enabled quota buckets.
const MODEL_DISPLAY_NAMES: Record<string, string> = {
  "gemini-3.1-pro-low": "G3 Pro",
  "gemini-3-flash": "G3 Flash",
  "gemini-2.5-flash": "G2.5 Flash",
  "claude-sonnet-4-6": "Claude Sonnet",
  "claude-opus-4-6-thinking": "Claude Opus",
};

function getPiAuthPath(): string {
  return process.env.NODE_ENV === "test" && process.env.PI_TOOLS_SUITE_TEST_AUTH_PATH
    ? process.env.PI_TOOLS_SUITE_TEST_AUTH_PATH
    : join(homedir(), ".pi", "agent", "auth.json");
}

function splitPiRefresh(refresh: string): AntigravityAccount | null {
  const [refreshToken = "", projectId = "", managedProjectId = ""] =
    refresh.split("|");
  if (!refreshToken) return null;
  return {
    refreshToken,
    projectId: projectId || undefined,
    managedProjectId: managedProjectId || undefined,
    addedAt: 0,
    lastUsed: 0,
  };
}

function getAccountRefreshToken(account: AntigravityAccount): string | undefined {
  if (account.refreshToken) return account.refreshToken;
  if (!account.refresh) return undefined;
  return splitPiRefresh(account.refresh)?.refreshToken;
}

function stringProperty(source: unknown, keys: string[]): string | undefined {
  if (!source || typeof source !== "object") return undefined;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function getGoogleOAuthClientCredentials(...sources: unknown[]): GoogleOAuthClientCredentials | undefined {
  for (const source of sources) {
    const nested = source && typeof source === "object"
      ? (source as Record<string, unknown>).oauthClient
      : undefined;
    const nestedClientId = stringProperty(nested, ["clientId", "client_id", "id"]);
    const nestedClientSecret = stringProperty(nested, ["clientSecret", "client_secret", "secret"]);
    const clientId = nestedClientId ?? stringProperty(source, ["clientId", "client_id", "googleClientId", "google_client_id", "oauthClientId", "oauth_client_id"]);
    const clientSecret = nestedClientSecret ?? stringProperty(source, ["clientSecret", "client_secret", "googleClientSecret", "google_client_secret", "oauthClientSecret", "oauth_client_secret"]);
    if (clientId) return { clientId, ...(clientSecret ? { clientSecret } : {}) };
  }
  return undefined;
}

async function readAntigravityAccounts(): Promise<AntigravityAccount[]> {
  try {
    const content = await readFile(getPiAuthPath(), "utf-8");
    const credential = (JSON.parse(content) as Record<string, PiAntigravityCredential>)[
      "antigravity"
    ];

    if (!credential) return [];
    const credentialClient = getGoogleOAuthClientCredentials(credential);
    const accounts = Array.isArray(credential.accounts)
      ? credential.accounts
          .filter((account) => getAccountRefreshToken(account))
          .map((account) => ({ ...credentialClient, ...account }))
      : [];
    const primaryAccount =
      credential.type === "oauth" && credential.refresh
        ? splitPiRefresh(credential.refresh)
        : null;
    if (primaryAccount) {
      primaryAccount.email = credential.email;
      Object.assign(primaryAccount, credentialClient);
      accounts.unshift(primaryAccount);
    }

    const seen = new Set<string>();
    return accounts.filter((account) => {
      const key = account.email || account.refreshToken;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

const GOOGLE_TOKEN_REFRESH_URL = "https://oauth2.googleapis.com/token";

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 格式化重置时间为简短显示（如 "4h 59m"）
 */
function formatResetTimeShort(isoTime: string): string {
  if (!isoTime) return "-";

  try {
    const resetDate = new Date(isoTime);
    const now = new Date();

    const diffMs = resetDate.getTime() - now.getTime();
    if (diffMs <= 0) return "reset";

    const diffMinutes = Math.floor(diffMs / 60000);
    const days = Math.floor(diffMinutes / 1440);
    const hours = Math.floor((diffMinutes % 1440) / 60);
    const minutes = diffMinutes % 60;

    if (days > 0) {
      return `${days}d ${hours}h`;
    }
    return `${hours}h ${minutes}m`;
  } catch {
    return "-";
  }
}

/**
 * Derive a short display name from a model key for unknown models.
 * Strips common prefixes and date suffixes to keep output readable.
 */
function deriveDisplayName(key: string): string {
  // Check known mapping first
  if (MODEL_DISPLAY_NAMES[key]) return MODEL_DISPLAY_NAMES[key];

  // For unknown models, create a readable short name
  // e.g. "gemini-2.5-flash-preview-05-20" -> "Gemini 2.5 Flash Preview"
  let name = key
    .replace(/-\d{2}-\d{2}$/, "")
    .replace(/^(gemini|claude|gpt)-/, (_, p) => p.charAt(0).toUpperCase() + p.slice(1) + " ")
    .replace(/-/g, " ");
  // Capitalize words
  name = name.replace(/\b(\w)/g, (_, c) => c.toUpperCase());
  // Collapse whitespace
  name = name.replace(/\s+/g, " ").trim();
  return name;
}

/**
 * Extract quota info for enabled provider models that have quotaInfo.
 * Models are sorted by display name and grouped implicitly by reset time.
 */
function extractModelQuotas(data: GoogleQuotaResponse): ModelQuota[] {
  const quotas: ModelQuota[] = [];

  for (const [key, modelInfo] of Object.entries(data.models)) {
    // Only show quota buckets for models exposed by our Antigravity provider.
    if (!ENABLED_MODEL_KEYS.has(key)) continue;

    // Only show models that have quota information
    if (!modelInfo?.quotaInfo) continue;

    const remainingFraction = modelInfo.quotaInfo.remainingFraction ?? 0;
    quotas.push({
      displayName: deriveDisplayName(key),
      remainPercent: Math.round(remainingFraction * 100),
      resetTimeDisplay: formatResetTimeShort(
        modelInfo.quotaInfo.resetTime || "",
      ),
    });
  }

  // Sort: group by reset time display, then by display name within each group
  quotas.sort((a, b) => {
    const resetCmp = a.resetTimeDisplay.localeCompare(b.resetTimeDisplay);
    if (resetCmp !== 0) return resetCmp;
    return a.displayName.localeCompare(b.displayName);
  });

  return quotas;
}

/**
 * 刷新 Google access token
 */
async function refreshAccessToken(
  account: AntigravityAccount,
): Promise<{ access_token: string; expires_in: number }> {
  const refreshToken = getAccountRefreshToken(account);
  if (!refreshToken) throw new Error("Missing refresh token, cannot query quota.");
  const clientCredentials = getGoogleOAuthClientCredentials(account);
  if (!clientCredentials) throw new Error(`Antigravity Google OAuth client credentials are missing in Pi auth: ${getPiAuthPath()}.`);

  const params = new URLSearchParams({
    client_id: clientCredentials.clientId,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  if (clientCredentials.clientSecret) params.set("client_secret", clientCredentials.clientSecret);

  const response = await fetch(GOOGLE_TOKEN_REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google API request failed (${response.status}): ${errorText}`);
  }

  return response.json();
}

// ============================================================================
// API 调用
// ============================================================================

/**
 * 获取 Google Cloud 使用情况
 */
async function fetchGoogleUsage(
  accessToken: string,
  projectId: string,
): Promise<GoogleQuotaResponse> {
  const response = await fetchWithTimeout(GOOGLE_QUOTA_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({ project: projectId }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google API request failed (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<GoogleQuotaResponse>;
}

/**
 * 查询单个账号的额度
 */
async function fetchAccountQuota(
  account: AntigravityAccount,
): Promise<{
  success: boolean;
  models?: ModelQuota[];
  maxUsage?: number;
  error?: string;
}> {
  try {
    // 刷新 access token
    const { access_token } = await refreshAccessToken(account);

    // 使用 projectId 或 managedProjectId
    const projectId = account.projectId || account.managedProjectId;
    if (!projectId) {
      return { success: false, error: "⚠️ Missing project_id, cannot query quota." };
    }

    // 查询额度
    const data = await fetchGoogleUsage(access_token, projectId);

    // 提取 4 个模型的额度
    const models = extractModelQuotas(data);

    if (models.length === 0) {
      return { success: true, models: undefined, maxUsage: 0 };
    }

    // 计算最大使用率
    const maxUsage = safeMax(models.map((m) => 100 - m.remainPercent));

    return { success: true, models, maxUsage };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============================================================================
// 格式化输出
// ============================================================================

/**
 * 格式化单个账号的额度（4 个模型分别显示）
 */
function formatAccountQuota(quotaInfo: AccountQuotaInfo): string {
  const lines: string[] = [];

  // 标题行
  lines.push(`### ${quotaInfo.email}`);

  if (quotaInfo.models.length === 0) {
    lines.push("");
    lines.push("No quota data available");
    return lines.join("\n");
  }

  lines.push("");

  // 每个模型一行：模型名 | 重置时间 | 百分比
  const nameWidth = Math.max(
    10,
    ...quotaInfo.models.map((model) => model.displayName.length),
  );
  const resetWidth = Math.max(
    6,
    ...quotaInfo.models.map((model) => model.resetTimeDisplay.length),
  );

  for (const model of quotaInfo.models) {
    const progressBar = createProgressBar(model.remainPercent, 20);
    lines.push(
      `${model.displayName.padEnd(nameWidth)}  ${model.resetTimeDisplay.padEnd(resetWidth)}  ${progressBar} ${model.remainPercent}%`,
    );
  }

  // 警告
  if (quotaInfo.maxUsage >= HIGH_USAGE_THRESHOLD) {
    lines.push("");
    lines.push("⚠️ Rate limit reached!");
  }

  return lines.join("\n");
}

// ============================================================================
// 导出接口
// ============================================================================

/**
 * 查询所有 Antigravity 账号的额度
 * @returns 查询结果
 */
export async function queryGoogleUsage(): Promise<QueryResult> {
  try {
    const accounts = await readAntigravityAccounts();

    if (accounts.length === 0) {
      return {
        success: true,
        output: "No quota data available",
      };
    }

    // 过滤掉没有邮箱的账号
    const validAccounts = accounts.filter((account) => account.email);

    if (validAccounts.length === 0) {
      return {
        success: true,
        output: "No quota data available",
      };
    }

    // 并行查询所有账号
    const results = await Promise.all(
      validAccounts.map((account: AntigravityAccount) =>
        fetchAccountQuota(account).then(
          (result) => ({ account, result }) as const,
        ),
      ),
    );

    // 收集输出
    const outputs: string[] = [];

    for (const { account, result } of results) {
      if (!result.success) {
        outputs.push(`${account.email || "unknown"}: ${result.error}`);
      } else if (result.models && result.models.length > 0) {
        const quotaInfo: AccountQuotaInfo = {
          email: account.email || "unknown",
          models: result.models,
          maxUsage: result.maxUsage || 0,
        };
        outputs.push(formatAccountQuota(quotaInfo));
      }
    }

    // 如果没有符合条件的账号
    if (outputs.length === 0) {
      return {
        success: true,
        output: "No quota data available",
      };
    }

    return {
      success: true,
      output: outputs.join("\n\n"),
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
