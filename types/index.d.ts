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
  // The pace over the burn-rate window, in percentage points an hour, and
  // when the window fills at it (before it resets); null without either.
  // Added in 1.4.0.
  ratePerHour: number | null
  fullAt: string | null
}

// The band's three views, in the order a right click cycles them: the table,
// the collapsed line with its bars, the collapsed line without them.
export type View = 'expanded' | 'bars' | 'plain'

// A part of the band the settings panel can hide: the 5-hour and weekly
// windows, any other window (a model's allowance, a spend limit), the context
// and the prompt cache's TTL row.
export type Part = '5H' | 'WK' | 'other' | 'CTX' | 'TTL'

// The parts that are usage windows, which have a pace.
export type UsagePart = '5H' | 'WK' | 'other'

// Keep-warm's caps for one TTL as the settings panel sets them: the most
// pings, and the most hours on.
export type CapSetting = { pings: number; hours: number }

// The caps by the TTL they apply to; saved across sessions.
export type CapSettings = Record<Ttl, CapSetting>

// The caps in force: the most pings, and the most time on in milliseconds.
export type Cap = { pings: number; ms: number }

// The unit a pace is printed in: percentage points an hour, a minute or a day.
export type BurnUnit = 'h' | 'min' | 'day'

// A usage window's percentage, kept when it moved, and the windows' samples
// by kind with the reset time they belong to.
export type Sample = { at: number; percent: number }
export type History = Record<string, { resetsAt: string | null; samples: Sample[] }>

// One part's pace settings: in which views the pace and its forecast show,
// the window it is averaged over (minutes) and its unit.
export type PaceSetting = { show: Record<View, boolean>; forecast: Record<View, boolean>; windowMin: number; unit: BurnUnit }

// The settings, as one tree (../hooks/settings.ts): what each part shows in
// each view, each usage part's pace, and keep-warm's caps by TTL.
export type SettingsTree = {
  show: Record<Part, Record<View, boolean>>
  pace: Record<UsagePart, PaceSetting>
  caps: CapSettings
}

// A session's own settings: any leaf of the tree, set or not.
export type SettingsOverride = {
  show?: Partial<Record<Part, Partial<Record<View, boolean>>>>
  pace?: Partial<
    Record<
      UsagePart,
      { show?: Partial<Record<View, boolean>>; forecast?: Partial<Record<View, boolean>>; windowMin?: number; unit?: BurnUnit }
    >
  >
  caps?: Partial<Record<Ttl, Partial<CapSetting>>>
}

// What the band shows of the pace: per window kind, its rate, when it fills
// and the unit its part prints it in.
export type Pace = {
  windows: Record<string, { perHour: number; fullAt: number | null; unit: BurnUnit }>
}

// Which settings the panel edits: this session's own, or every session's.
export type Scope = 'session' | 'global'

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
// and the promptCacheTtl setting.
export type TtlInputs = {
  force5m: boolean
  envTtl: Ttl | null
  settingTtl: Ttl | null
  enable1h: boolean
}

// What the band knows of the main conversation's prompt cache.
export type CacheState = {
  ttl: Ttl
  ttlSource: TtlSource
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
  // The parts the settings panel hides in this view, and the usage parts
  // whose pace, and whose forecast, it hides.
  hidden: Part[]
  paceHidden: Part[]
  forecastHidden: Part[]
  // Keep-warm's caps in force for this session's TTL.
  cap: Cap
  // The burn rates and forecasts.
  pace: Pace
}

declare module 'claude-code' {
  interface PluginState {
    'token-watch': {
      reading: Reading | null
      limits: Limit[]
      // When the windows in `limits` were reported after a response, this
      // session's or another's (through the store); 0 until one was.
      limitsAt: number
      nowMs: number
      isShown: boolean
      view: View
      working: boolean
      ttlInputs: TtlInputs
      cache: CacheState
      keepWarm: KeepWarm
      // When the ping now out was sent, or null with none out: a second ping
      // waits for it, across a reload too.
      pingingSince: number | null
      // The settings in force in this session (../hooks/settings.ts): its
      // own over the global ones, leaf by leaf; the global settings (saved,
      // shared by every session); and this session's own (saved under its id).
      settings: SettingsTree
      globalSettings: SettingsTree
      override: SettingsOverride
      // The usage windows' samples, shared through the store, for the burn
      // rates.
      history: History
      // Which of the two the settings panel edits, and its open sections.
      scope: Scope
      openSections: string[]
    }
  }
}