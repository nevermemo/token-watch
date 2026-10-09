// Shared by the hooks module and the band: how Token Watch names, orders and
// spells its figures, so the band, the /context-bar reading and the usage
// snapshot all say the same thing.

import type { Limit, Reading } from '../types'

// Usage windows by kind, in the order they are shown; any other window the
// API sends comes after them.
const WINDOWS: Record<string, string> = {
  five_hour: '5H',
  seven_day: 'WK',
  spend_limit: '$$',
}
const ORDER = Object.keys(WINDOWS)

// Windows Claude Code does not list today but the API may send, such as a
// model's own allowance: named by the model when the kind mentions one.
const MODELS: [RegExp, string][] = [
  [/fable/i, 'FB'],
  [/opus/i, 'OP'],
  [/sonnet/i, 'SN'],
  [/haiku/i, 'HK'],
]

export function sorted(list: Limit[]) {
  const rank = (kind: string) => (ORDER.includes(kind) ? ORDER.indexOf(kind) : ORDER.length)
  return [...list].sort((a, b) => rank(a.kind) - rank(b.kind))
}

export function label(limit: Limit) {
  return WINDOWS[limit.kind] ?? MODELS.find(([pattern]) => pattern.test(limit.kind))?.[1] ?? limit.kind
}

// Time left until a window resets: "3d 4h", "2h 14m", "9m".
export function countdown(resetsAt: string | undefined, nowMs: number) {
  if (!resetsAt || !nowMs) return ''
  const ms = Date.parse(resetsAt) - nowMs
  if (Number.isNaN(ms)) return ''
  if (ms <= 0) return 'now'
  const minutes = Math.floor(ms / 60_000)
  const days = Math.floor(minutes / 1_440)
  const hours = Math.floor((minutes % 1_440) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
  return `${Math.max(1, minutes)}m`
}

export function short(n: number) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}k`
  return String(n)
}

// The level colour of a percentage: green below 50%, yellow from 50%, red
// from 80%.
export function levelColor(percent: number) {
  if (percent < 50) return '#8fd18f'
  if (percent < 80) return '#e8c66a'
  return '#e06c6c'
}

// The reading as one line of text, for where the band cannot be drawn:
// "5H 62% (2h 14m) · WK 31% (3d 4h) · CTX 21% (212k / 1M)". Empty before
// the first reading.
export function readingLine(reading: Reading | null, limits: Limit[], nowMs: number) {
  const parts = sorted(limits).map(limit => {
    const left = countdown(limit.resetsAt, nowMs)
    return `${label(limit)} ${Math.round(limit.percentUsed)}%${left ? ` (${left})` : ''}`
  })
  if (reading !== null) {
    const percent = Math.round((reading.total / reading.window) * 100)
    parts.push(`CTX ${percent}% (${short(reading.total)} / ${short(reading.window)})`)
  }
  return parts.join(' · ')
}
