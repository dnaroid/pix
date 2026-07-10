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
  debugLog?: {
    maxBytes?: number
    maxBackups?: number
  }
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
    iterationNudgeThreshold: number // nudge after N tool calls since last user msg (default: 4)
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
    /**
     * Auto-compress fallback: when the model ignores repeated context-strong
     * nudges above the emergency threshold, DCP creates a compression block
     * itself (without waiting for the model). Lossy and irreversible within a
     * session — disabled by default; opt in via config.
     */
    autoCompress: {
      enabled: boolean
      /** Number of context-strong nudges emitted (and ignored) before DCP
       * auto-compresses. The model gets `patience` genuine strong chances. */
      patience: number
      /** Models to try, in order, when producing a model-generated summary.
       * Empty array → deterministic programmatic digest (no model call). */
      summarizerModel: string[]
      /** Hard ceiling in ms for a single summarizer model call. */
      timeoutMs: number
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
    emergencyCurrentTurnPruning: {
      /** Enable same-turn candidates and lossy fallback pruning; emergency reminders remain active. */
      enabled: boolean
      /** Prune immediately at or above this model-independent context fraction. */
      hardContextPercent: number
      /** Recover enough estimated tokens to reach this fraction or a margin below the model emergency threshold. */
      targetContextPercent: number
      /** Emergency reminders allowed before pruning even below hardContextPercent. */
      patience: number
      /** Newest complete assistant tool-call/result pairs that are never selected. */
      keepRecentToolPairs: number
      /** Ignore small results whose replacement would recover little context. */
      minOutputTokens: number
      /** Maximum emergency same-turn message candidates shown in a reminder. */
      maxSuggestions: number
      protectedTools: string[]
    }
  }
  protectedFilePatterns: string[]
  pruneNotification: "off" | "minimal" | "detailed"
  modelOverrides: Record<string, DcpConfigOverride>
}

export type DcpConfigOverride = DeepPartial<Omit<DcpConfig, "modelOverrides">>

type DeepPartial<T> = T extends Array<infer U>
  ? Array<DeepPartial<U>>
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

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
    maxContextPercent: 0.65,
    minContextPercent: 0.40,
    modelMaxContextPercent: {},
    modelMinContextPercent: {},
    summaryBuffer: true,
    nudgeFrequency: 2,
    iterationNudgeThreshold: 8,
    nudgeForce: "soft",
    protectedTools: ["compress", "write", "edit"],
    protectTags: false,
    protectUserMessages: false,
    autoCandidates: {
      enabled: true,
      minContextPercent: 0.40,
      keepRecentTurns: 1,
      minMessages: 6,
      minTokens: 1500,
    },
    messageMode: {
      enabled: true,
      minContextPercent: 0.40,
      keepRecentTurns: 1,
      mediumTokens: 500,
      highTokens: 5000,
      maxSuggestions: 5,
    },
    autoCompress: {
      enabled: false,
      patience: 2,
      summarizerModel: [],
      timeoutMs: 20000,
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
      maxOutputTokens: 1200,
      keepRecentTurns: 1,
      readLikeTools: [
        "read",
        "shell",
        "bash",
        "grep",
        "find",
        "ls",
        "web_search",
        "web_fetch",
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
    emergencyCurrentTurnPruning: {
      enabled: true,
      hardContextPercent: 0.82,
      targetContextPercent: 0.70,
      patience: 2,
      keepRecentToolPairs: 8,
      minOutputTokens: 500,
      maxSuggestions: 8,
      protectedTools: [],
    },
  },
  protectedFilePatterns: [],
  pruneNotification: "detailed",
  modelOverrides: {},
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

function normalizeModelKey(key: string | undefined): string | undefined {
  if (typeof key !== "string") return undefined
  const trimmed = key.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function escapeRegExp(text: string): string {
  return text.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
}

function globToRegExp(pattern: string): RegExp {
  let source = "^"
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    if (char === "*") {
      source += ".*"
    } else if (char === "?") {
      source += "."
    } else {
      source += escapeRegExp(char)
    }
  }
  source += "$"
  return new RegExp(source)
}

function isWildcardPattern(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?")
}

function modelPatternMatches(pattern: string, candidate: string): boolean {
  return globToRegExp(pattern).test(candidate)
}

function uniqueModelCandidates(modelKeys: Array<string | undefined>): string[] {
  return modelKeys
    .map((key) => normalizeModelKey(key))
    .filter((key, index, array): key is string => typeof key === "string" && array.indexOf(key) === index)
}

export function matchingModelEntries<T>(
  record: Record<string, T> | undefined,
  modelKeys: Array<string | undefined> = [],
): Array<[string, T]> {
  if (!record || Object.keys(record).length === 0) return []

  const candidates = uniqueModelCandidates(modelKeys)
  if (candidates.length === 0) return []

  const exactEntries = new Map<string, T>()
  const wildcardEntries: Array<[string, T]> = []

  for (const [rawKey, value] of Object.entries(record)) {
    const key = normalizeModelKey(rawKey)
    if (!key) continue
    if (isWildcardPattern(key)) wildcardEntries.push([key, value])
    else exactEntries.set(key, value)
  }

  const fullCandidates = candidates.filter((candidate) => candidate.includes("/"))
  const bareCandidates = candidates.filter((candidate) => !candidate.includes("/"))
  const matches: Array<[string, T]> = []

  for (const candidate of bareCandidates) {
    for (const entry of wildcardEntries) {
      if (entry[0].includes("/")) continue
      if (modelPatternMatches(entry[0], candidate)) matches.push(entry)
    }
  }

  for (const candidate of bareCandidates) {
    const value = exactEntries.get(candidate)
    if (value !== undefined) matches.push([candidate, value])
  }

  for (const candidate of fullCandidates) {
    for (const entry of wildcardEntries) {
      if (!entry[0].includes("/")) continue
      if (modelPatternMatches(entry[0], candidate)) matches.push(entry)
    }
  }

  for (const candidate of fullCandidates) {
    const value = exactEntries.get(candidate)
    if (value !== undefined) matches.push([candidate, value])
  }

  return matches
}

export function modelKeysFromContext(ctx: unknown): string[] {
  const ctxModel = (ctx as any)?.model
  const provider = normalizeModelKey(
    ctxModel?.provider ?? ctxModel?.providerId ?? ctxModel?.providerID,
  )
  const model = normalizeModelKey(
    ctxModel?.id ?? ctxModel?.model ?? ctxModel?.modelId ?? ctxModel?.modelID,
  )

  return [provider && model ? `${provider}/${model}` : undefined, model].filter(
    (key): key is string => typeof key === "string",
  )
}

export function resolveModelConfig(
  config: DcpConfig,
  modelKeys: Array<string | undefined> = [],
): DcpConfig {
  const overrides = config.modelOverrides
  if (!overrides || Object.keys(overrides).length === 0) return config

  const matches = matchingModelEntries(overrides, modelKeys)
  if (matches.length === 0) return config

  let resolved = deepMerge(config, {})
  for (const [, override] of matches) {
    resolved = deepMerge(resolved, override as Partial<DcpConfig>)
  }

  return resolved
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
