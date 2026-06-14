import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { parse as parseJsonc, type ParseError } from "jsonc-parser"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DcpConfig {
  enabled: boolean
  debug: boolean
  manualMode: {
    enabled: boolean
    automaticStrategies: boolean // run dedup/purge even in manual mode
  }
  compress: {
    maxContextPercent: number | string // accepts a 0-1 fraction, absolute tokens, or a percent string like "80%"
    minContextPercent: number | string // accepts a 0-1 fraction, absolute tokens, or a percent string like "40%"
    modelMaxContextPercent: Record<string, number | string> // accepts a 0-1 fraction, absolute tokens, or a percent string like "80%"
    modelMinContextPercent: Record<string, number | string> // accepts a 0-1 fraction, absolute tokens, or a percent string like "40%"
    maxContextLimit?: number | string // same formats as maxContextPercent; checked before the global percent fallback
    minContextLimit?: number | string // same formats as minContextPercent; checked before the global percent fallback
    modelMaxContextLimits?: Record<string, number | string> // same formats as modelMaxContextPercent; checked before modelMaxContextPercent
    modelMinContextLimits?: Record<string, number | string> // same formats as modelMinContextPercent; checked before modelMinContextPercent
    summaryBuffer: boolean
    nudgeFrequency: number // inject nudge every N context events (default: 2)
    iterationNudgeThreshold: number // nudge after N tool calls since last user msg (default: 8)
    nudgeForce: "strong" | "soft"
    protectedTools: string[] // these tool outputs always protected from pruning
    protectTags: boolean
    protectUserMessages: boolean
    autoCandidates: {
      enabled: boolean
      minContextPercent: number
      keepRecentTurns: number
      minMessages: number
      minTokens: number
    }
    messageMode: {
      enabled: boolean
      minContextPercent: number
      keepRecentTurns: number
      mediumTokens: number
      highTokens: number
      maxSuggestions: number
    }
  }
  strategies: {
    deduplication: {
      enabled: boolean
      protectedTools: string[]
    }
    purgeErrors: {
      enabled: boolean
      turns: number // prune error inputs after N user turns (default: 4)
      protectedTools: string[]
    }
    autoToolPruning: {
      enabled: boolean
      maxOutputTokens: number
      keepRecentTurns: number
      readLikeTools: string[]
      readLikeTurns: number
      protectedTools: string[]
    }
  }
  protectedFilePatterns: string[]
  pruneNotification: "off" | "minimal" | "detailed"
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: DcpConfig = {
  enabled: true,
  debug: false,
  manualMode: {
    enabled: false,
    automaticStrategies: true,
  },
  compress: {
    maxContextPercent: 0.55,
    minContextPercent: 0.20,
    modelMaxContextPercent: {},
    modelMinContextPercent: {},
    summaryBuffer: true,
    nudgeFrequency: 1,
    iterationNudgeThreshold: 6,
    nudgeForce: "soft",
    protectedTools: ["compress", "write", "edit"],
    protectTags: false,
    protectUserMessages: false,
    autoCandidates: {
      enabled: true,
      minContextPercent: 0.20,
      keepRecentTurns: 2,
      minMessages: 6,
      minTokens: 1500,
    },
    messageMode: {
      enabled: true,
      minContextPercent: 0.20,
      keepRecentTurns: 2,
      mediumTokens: 500,
      highTokens: 5000,
      maxSuggestions: 5,
    },
  },
  strategies: {
    deduplication: {
      enabled: true,
      protectedTools: [],
    },
    purgeErrors: {
      enabled: true,
      turns: 4,
      protectedTools: [],
    },
    autoToolPruning: {
      enabled: true,
      maxOutputTokens: 2000,
      keepRecentTurns: 2,
      readLikeTools: [
        "read",
        "grep",
        "find",
        "ls",
        "repo_architecture",
        "repo_structure",
        "repo_ast",
        "repo_search",
        "repo_explain",
        "repo_deps",
        "ast_grep",
      ],
      readLikeTurns: 3,
      protectedTools: [],
    },
  },
  protectedFilePatterns: [],
  pruneNotification: "detailed",
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively merge `override` into `base`. Arrays are union-merged (deduped).
 * Returns a new object; does not mutate inputs.
 */
function deepMerge<T>(base: T, override: Partial<T>): T {
  if (override === null || override === undefined) return base
  if (typeof base !== "object" || typeof override !== "object") {
    return override as T
  }

  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) }

  for (const key of Object.keys(override as Record<string, unknown>)) {
    const baseVal = (base as Record<string, unknown>)[key]
    const overVal = (override as Record<string, unknown>)[key]

    if (Array.isArray(baseVal) && Array.isArray(overVal)) {
      // Union merge: combine and deduplicate by value
      const combined = [...baseVal, ...overVal]
      result[key] = [...new Set(combined)]
    } else if (
      overVal !== null &&
      typeof overVal === "object" &&
      !Array.isArray(overVal) &&
      baseVal !== null &&
      typeof baseVal === "object" &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overVal as Record<string, unknown>,
      )
    } else if (overVal !== undefined) {
      result[key] = overVal
    }
  }

  return result as T
}

/**
 * Parse a JSONC file and return a plain object.
 * Returns `{}` on any error (missing file, parse error).
 */
function readJsoncFile(filePath: string): Record<string, unknown> {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, "utf8")
  } catch {
    return {}
  }

  const errors: ParseError[] = []
  const parsed = parseJsonc(raw, errors)
  if (errors.length > 0) {
    // Non-fatal: return whatever was parsed (jsonc-parser is lenient)
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {}
  }
  return parsed as Record<string, unknown>
}

/**
 * Return the nested DCP config from a shared pi-tools-suite config file.
 */
function readDcpFromSuiteConfig(filePath: string): Record<string, unknown> {
  const raw = readJsoncFile(filePath)
  const dcp = raw["dcp"]
  if (dcp === null || typeof dcp !== "object" || Array.isArray(dcp)) return {}
  return dcp as Record<string, unknown>
}

function mergeSuiteDcpConfig(config: DcpConfig, filePath: string): DcpConfig {
  const raw = readDcpFromSuiteConfig(filePath)
  if (Object.keys(raw).length === 0) return config
  return deepMerge(config, raw as Partial<DcpConfig>)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LoadConfigOptions {
  homeDir?: string
}

/**
 * Load the DCP configuration by merging built-in defaults with the `dcp` section
 * from the user-level shared pi-tools-suite config only:
 * `~/.config/pi/pi-tools-suite.jsonc`.
 */
export function loadConfig(options: LoadConfigOptions = {}): DcpConfig {
  // Layer 1: defaults (deep clone so we never mutate the constant)
  let config: DcpConfig = deepMerge(DEFAULT_CONFIG, {})

  const homeDir = options.homeDir ?? os.homedir()
  config = mergeSuiteDcpConfig(config, path.join(homeDir, ".config", "pi", "pi-tools-suite.jsonc"))

  return config
}
