/**
 * 智谱 AI 额度查询模块
 *
 * [输入]: API Key
 * [输出]: 格式化的额度使用情况
 * [定位]: 被 usage.ts 调用，处理智谱 AI 账号
 * [同步]: usage.ts, types.ts, utils.ts
 */

import {
  type QueryResult,
  type ZhipuAuthData,
  HIGH_USAGE_THRESHOLD,
} from "./types";
import {
  formatDuration,
  createProgressBar,
  calcRemainPercent,
  fetchWithTimeout,
  safeMax,
  maskString,
} from "./utils";

// ============================================================================
// 类型定义
// ============================================================================

interface UsageLimitItem {
  /** 限制类型：TOKENS_LIMIT(Token) / TIME_LIMIT(MCP搜索次数) */
  type: "TIME_LIMIT" | "TOKENS_LIMIT";
  /** 总配额/限制数 */
  usage: number;
  /** 当前已使用 */
  currentValue: number;
  /** 使用百分比 */
  percentage: number;
  /** 下次重置时间戳 (ms，仅 TOKENS_LIMIT 有效) */
  nextResetTime?: number;
}

interface QuotaLimitResponse {
  code: number;
  msg: string;
  data: {
    limits: UsageLimitItem[];
  };
  success: boolean;
}

interface PlatformConfig {
  apiUrl: string;
  apiError: (status: number, text: string) => string;
  accountLabel: string;
}

// ============================================================================
// API 调用
// ============================================================================

const ZHIPU_QUOTA_QUERY_URL =
  "https://bigmodel.cn/api/monitor/usage/quota/limit";
const ZAI_QUOTA_QUERY_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

const ZHIPU_CONFIG: PlatformConfig = {
  apiUrl: ZHIPU_QUOTA_QUERY_URL,
  apiError: (status, text) => `Zhipu API request failed (${status}): ${text}`,
  accountLabel: "Coding Plan",
};

const ZAI_CONFIG: PlatformConfig = {
  apiUrl: ZAI_QUOTA_QUERY_URL,
  apiError: (status, text) => `Z.ai API request failed (${status}): ${text}`,
  accountLabel: "Z.ai",
};

/**
 * 获取智谱/Z.ai 使用情况
 */
async function fetchUsage(
  apiKey: string,
  config: PlatformConfig,
): Promise<QuotaLimitResponse> {
  const response = await fetchWithTimeout(config.apiUrl, {
    method: "GET",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
      "User-Agent": "OpenCode-Status-Plugin/1.0",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(config.apiError(response.status, errorText));
  }

  const data = (await response.json()) as QuotaLimitResponse;

  if (!data.success || data.code !== 200) {
    throw new Error(config.apiError(data.code, data.msg || "Unknown error"));
  }

  return data;
}

// ============================================================================
// 格式化输出
// ============================================================================

/**
 * 格式化智谱 AI 使用情况
 */
function formatZhipuUsage(
  data: QuotaLimitResponse,
  apiKey: string,
  accountLabel: string,
): string {
  const lines: string[] = [];
  const limits = data.data.limits;

  // 标题行：Account: API Key (Plan) - 显示脱敏后的 key
  const maskedKey = maskString(apiKey);
  lines.push(`Account:        ${maskedKey} (${accountLabel})`);
  lines.push("");

  // 空数组检查
  if (!limits || limits.length === 0) {
    lines.push("No quota data available");
    return lines.join("\n");
  }

  // 查找 TOKENS_LIMIT（5小时 Token 限额）
  const tokensLimit = limits.find((l) => l.type === "TOKENS_LIMIT");
  if (tokensLimit) {
    const remainPercent = calcRemainPercent(tokensLimit.percentage);
    const progressBar = createProgressBar(remainPercent);

    lines.push("5-hour token limit");
    lines.push(`${progressBar} ${remainPercent}% remaining`);
    if (Number.isFinite(tokensLimit.currentValue) && Number.isFinite(tokensLimit.usage)) {
      lines.push(
        `Used: ${(tokensLimit.currentValue / 1000000).toFixed(1)}M / ${(tokensLimit.usage / 1000000).toFixed(1)}M`,
      );
    }

    // 重置时间
    if (tokensLimit.nextResetTime) {
      const resetSeconds = Math.max(
        0,
        Math.floor((tokensLimit.nextResetTime - Date.now()) / 1000),
      );
      lines.push(`Resets in: ${formatDuration(resetSeconds)}`);
    }
  }

  // 查找 TIME_LIMIT（MCP 搜索次数）
  const timeLimit = limits.find((l) => l.type === "TIME_LIMIT");
  if (timeLimit) {
    if (tokensLimit) lines.push(""); // 分隔符

    const remainPercent = calcRemainPercent(timeLimit.percentage);
    const progressBar = createProgressBar(remainPercent);

    lines.push("MCP monthly quota");
    lines.push(`${progressBar} ${remainPercent}% remaining`);
    lines.push(`Used: ${timeLimit.currentValue} / ${timeLimit.usage}`);
  }

  // 警告：如果任一限额使用率超过阈值
  const maxPercentage = safeMax(limits.map((l) => l.percentage));
  if (maxPercentage >= HIGH_USAGE_THRESHOLD) {
    lines.push("");
    lines.push("⚠️ Rate limit reached!");
  }

  return lines.join("\n");
}

// ============================================================================
// 导出接口
// ============================================================================

export type { ZhipuAuthData };

async function queryUsage(
  authData: ZhipuAuthData | undefined,
  config: PlatformConfig,
): Promise<QueryResult | null> {
  // 检查账号是否存在且有效
  if (!authData || authData.type !== "api" || !authData.key) {
    return null;
  }

  try {
    const usage = await fetchUsage(authData.key, config);
    return {
      success: true,
      output: formatZhipuUsage(usage, authData.key, config.accountLabel),
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 查询智谱 AI 账号额度
 * @param authData 智谱认证数据
 * @returns 查询结果，如果账号不存在或无效返回 null
 */
export async function queryZhipuUsage(
  authData: ZhipuAuthData | undefined,
): Promise<QueryResult | null> {
  return queryUsage(authData, ZHIPU_CONFIG);
}

/**
 * 查询 Z.ai 账号额度
 * @param authData Z.ai 认证数据
 * @returns 查询结果，如果账号不存在或无效返回 null
 */
export async function queryZaiUsage(
  authData: ZhipuAuthData | undefined,
): Promise<QueryResult | null> {
  return queryUsage(authData, ZAI_CONFIG);
}
