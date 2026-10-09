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

// What the hooks module hands the band's Client.
export type BandProps = {
  reading: Reading
  limits: Limit[]
  nowMs: number
  isCollapsed: boolean
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
    }
  }
}
