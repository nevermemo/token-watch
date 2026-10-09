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

// The usage snapshot written to ~/.claude/token-watch/usage.json after each
// reading, for Token Watch for VS Code or any other local reader. A window
// whose resetsAt has passed has started over: show it at 0%. A snapshot
// whose writtenAt is more than a few minutes old was left by a session that
// has ended.
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
}

// What the hooks module hands the band's Client.
export type BandProps = {
  reading: Reading
  limits: Limit[]
  nowMs: number
  isCollapsed: boolean
  // Whether the collapsed line draws its bars; without them, its labels,
  // percentages and detail alone. The expanded table always has them.
  showBars: boolean
  surface: 'terminal' | 'desktop' | 'mobile' | 'vscode'
}

declare module 'claude-code' {
  interface PluginState {
    'token-watch': {
      reading: Reading | null
      limits: Limit[]
      nowMs: number
      isShown: boolean
      isCollapsed: boolean
      showBars: boolean
    }
  }
}
