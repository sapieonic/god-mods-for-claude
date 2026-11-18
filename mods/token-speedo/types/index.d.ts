/** One finished model request (a step of a turn), main loop or subagent. */
export type Step = {
  /** Output tokens per second while it generated, from the API's own count. */
  speed: number
  output: number
  /** Uncached input tokens. */
  input: number
  cacheRead: number
  cacheWrite: number
  /** Milliseconds from sending the request to its first streamed piece. */
  firstTokenMs: number
  /** Milliseconds the whole step took. */
  ms: number
  isSubagent: boolean
}

/** Counts summed over many steps. */
export type Totals = {
  steps: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Milliseconds spent generating, for the average speed. */
  genMs: number
}

export type Stats = {
  /** The last steps, oldest first, at most 12. */
  recent: Step[]
  turn: Totals
  turnId: string
  session: Totals
  /** The fastest step this session, tokens per second. */
  peak: number
  model: string
  /** How full the context window is, 0 to 100; null before the first reading. */
  contextPercent: number | null
  /** US dollars so far; null where the host keeps no ledger. */
  costUsd: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'token-speedo': {
      stats: Shaped<Stats>
      /** /speedo hid the speedometer: it stays hidden, across sessions too, until /speedo again. */
      isHidden: boolean
    }
  }
}
