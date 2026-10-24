// One category of the context window, as the bar and the legend draw it.
export type Slice = {
  label: string
  tokens: number
  color: string
  kind: 'used' | 'free' | 'buffer'
}

// The last reading of the window, broken down the way /context breaks it down.
export type Reading = {
  slices: Slice[]
  total: number
  window: number
  compactsAt: number | null
}

// One plan usage window (five_hour, seven_day), as the status line has it.
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

// One usage window as the snapshot lists it: the band's label beside the kind.
export type SnapshotWindow = {
  kind: string
  label: string
  percentUsed: number
  resetsAt: string | null
}

// The band's three views, in the order a right click cycles them: the table,
// the collapsed line with its bars, the collapsed line without them.
export type View = 'expanded' | 'bars' | 'plain'

// The prompt cache's time to live, as Claude Code requests it.
export type Ttl = '5m' | '1h'

// Where the band's TTL comes from: one of Claude Code's controls, in their
// order of precedence; the plan's default bucket; or a keep-warm ping that
// found the cache warm more than five minutes after the last response.
export type TtlSource =
  | 'FORCE_PROMPT_CACHING_5M'
  | 'CLAUDE_CODE_PROMPT_CACHE_TTL'
  | 'promptCacheTtl'
  | 'ENABLE_PROMPT_CACHING_1H'
  | 'over plan limit'
  | 'confirmed'
  | 'API key or cloud'
  | 'subscription'

// The TTL controls, read once at session start: three environment variables
// and the promptCacheTtl setting, plus whether idle compaction is allowed
// (the idleCompaction and autoCompactEnabled settings not false).
export type TtlInputs = {
  force5m: boolean
  envTtl: Ttl | null
  settingTtl: Ttl | null
  enable1h: boolean
  idleCompaction: boolean
}

// What the band knows of the main conversation's prompt cache.
export type CacheState = {
  ttl: Ttl
  ttlSource: TtlSource
  // Whether Claude Code may compact this conversation while it idles: the
  // hour TTL, and the settings allow it.
  idleCompaction: boolean
  // When the last main-thread response ended, in ms since the epoch: the
  // countdown counts from here. Null before the first response and after
  // /clear.
  lastResponseAt: number | null
  // Until when the cache is believed warm: the last response plus the TTL, or
  // later after a keep-warm ping. Null with lastResponseAt.
  warmUntil: number | null
  // The length of the window that set warmUntil (the TTL, or what a ping
  // refreshes): what the next ping's lead time is read from.
  windowMs: number
  // The last response's prompt in tokens (input, cache read and cache written
  // together), from the context breakdown: what a warm ping reads most of.
  // Null before the first breakdown.
  prefixTokens: number | null
  // True once a ping read the cache more than five minutes after the last
  // response: the hour TTL is confirmed.
  confirmed: boolean
}

// Keep-warm: on or off for this session (never saved), and what its pings did.
export type KeepWarm = {
  on: boolean
  startedAt: number | null
  pings: number
  failures: number
  lastPing: { at: number; read: number; wrote: number } | null
  // A line the band shows for a minute: the last ping's counts, a failure, or
  // why keep-warm stopped.
  note: { at: number; text: string } | null
}

// The cache as the snapshot lists it.
export type SnapshotCache = {
  ttl: Ttl
  ttlSource: TtlSource
  expiresAt: string | null
  warm: boolean
  keepWarm: {
    on: boolean
    pings: number
    maxPings: number
    startedAt: string | null
    maxMs: number
    lastPing: { at: string; read: number; wrote: number } | null
  }
}

// The usage snapshot written to ~/.claude/token-watch/usage.json after each
// reading, for Token Watch for VS Code or any other local reader. A window
// whose resetsAt has passed has started over: show it at 0%. A snapshot
// whose writtenAt is more than a few minutes old was left by a session that
// has ended. `cache` was added in 1.2.0; schema 1 only gains fields.
export type Snapshot = {
  schema: 1
  writtenAt: string
  session: { id: string | null; cwd: string | null }
  windows: SnapshotWindow[]
  context: {
    total: number
    window: number
    percent: number
    compactsAt: number | null
    categories: Slice[]
  } | null
  cache: SnapshotCache
}

// What the hooks module hands the band's Client.
export type BandProps = {
  reading: Reading
  limits: Limit[]
  nowMs: number
  view: View
  // True while a model turn runs: its requests refresh the cache, so the
  // countdown shows the whole TTL.
  isWorking: boolean
  cache: CacheState
  keepWarm: KeepWarm
  surface: 'terminal' | 'desktop' | 'mobile' | 'vscode'
}

declare module 'claude-code' {
  interface PluginState {
    'token-watch': {
      reading: Reading | null
      limits: Limit[]
      nowMs: number
      isShown: boolean
      view: View
      working: boolean
      ttlInputs: TtlInputs
      cache: CacheState
      keepWarm: KeepWarm
    }
  }
}