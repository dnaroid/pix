/** Built-in omission defaults used by the TUI DCP runtime before user config is merged. */
export const DEFAULT_DCP_CONFIG = {
  enabled: true,
  debug: false,
  issues: [],
  manualMode: {
    enabled: false,
  },
  compress: {
    maxContextPercent: 0.65,
    minContextPercent: 0.40,
    modelMaxContextPercent: {},
    modelMinContextPercent: {},
    summaryBuffer: true,
    nudgeFrequency: 2,
    iterationNudgeThreshold: 8,
    nudgeForce: "soft" as const,
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
      summarizerFallbackModels: [],
      timeoutMs: 20000,
    },
  },
  strategies: {
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
  modelOverrides: {},
}

export const DEFAULT_DCP_DEBUG_LOG_MAX_BYTES = 5 * 1024 * 1024
export const DEFAULT_DCP_DEBUG_LOG_MAX_BACKUPS = 3
