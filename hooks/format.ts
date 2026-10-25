// Shared by the hooks module and the band: how Token Watch names, orders and
// spells its figures, so the band, the /context-bar reading and the usage
// snapshot all say the same thing.

import type { CacheState, KeepWarm, Limit, Reading } from '../types'
import { TTL_MS, caps, refreshMs } from './cache'

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

// A countdown as minutes and seconds, rounded up: "47:12", "4:05", "0:59".
export function mmss(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

// A span as hours and minutes, rounded down: "0:42", "2:00".
export function hmm(ms: number) {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
}

// The cache timer's label: the whole TTL while a turn runs (its requests
// refresh the cache), "--:--" before the first response, "cold" once the
// countdown has run out, else the time left.
export function cacheLabel(cache: CacheState, nowMs: number, isWorking: boolean) {
  if (isWorking) return mmss(TTL_MS[cache.ttl])
  if (cache.warmUntil === null) return '--:--'
  if (nowMs >= cache.warmUntil) return 'cold'
  return mmss(cache.warmUntil - nowMs)
}

// The TTL and where it comes from: "1h · subscription".
export function ttlText(cache: CacheState) {
  return `${cache.ttl} · ${cache.ttlSource}`
}

// Keep-warm's caps: pings sent of the most allowed, and time on of the most
// allowed, "pings 3/30 · 0:42/2:00".
// A span as hours, minutes and seconds: "8:00:00", "0:42:05".
export function hmmss(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}:${String(m).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

// A span as minutes and seconds under the hour, "00:26", "42:05", and as
// hours, minutes and seconds from there, "1:02:03".
export function clockText(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds >= 3600) return hmmss(ms)
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

// The expanded TTL row's timer: the time left over the whole TTL, "52:50 /
// 60:00", or "--:-- / 60:00" before the first response, "cold / 60:00" once
// it has run out, the whole TTL over itself while a turn runs.
export function timerText(cache: CacheState, nowMs: number, isWorking: boolean) {
  return `${cacheLabel(cache, nowMs, isWorking)} / ${mmss(TTL_MS[cache.ttl])}`
}

// Keep-warm's caps on the expanded TTL row: "Pings: 0/8  Time: 00:26 / 8:00:00".
export function capsLine(keepWarm: KeepWarm, cache: CacheState, nowMs: number) {
  const cap = caps(refreshMs(cache.ttl))
  const elapsed = keepWarm.startedAt === null ? 0 : nowMs - keepWarm.startedAt
  return `Pings: ${keepWarm.pings}/${cap.pings}  Time: ${clockText(elapsed)} / ${hmmss(cap.ms)}`
}

export function capsText(keepWarm: KeepWarm, cache: CacheState, nowMs: number) {
  const cap = caps(refreshMs(cache.ttl))
  const elapsed = keepWarm.startedAt === null ? 0 : nowMs - keepWarm.startedAt
  return `pings ${keepWarm.pings}/${cap.pings} · ${hmm(elapsed)}/${hmm(cap.ms)}`
}

// What the text reply knows of the cache beside the reading.
export type CacheLine = { cache: CacheState; keepWarm: KeepWarm; isWorking: boolean }

// The reading as one line of text, for where the band cannot be drawn:
// "5H 62% (2h 14m) · WK 31% (3d 4h) · CTX 21% (212k / 1M)", then once there
// is a countdown, "· TTL 47:12 (1h · subscription)", with keep-warm's caps
// and the last ping's counts while they apply. Empty before the first reading.
export function readingLine(reading: Reading | null, limits: Limit[], nowMs: number, cacheLine?: CacheLine) {
  const parts = sorted(limits).map(limit => {
    const left = countdown(limit.resetsAt, nowMs)
    return `${label(limit)} ${Math.round(limit.percentUsed)}%${left ? ` (${left})` : ''}`
  })
  if (reading !== null) {
    const percent = Math.round((reading.total / reading.window) * 100)
    parts.push(`CTX ${percent}% (${short(reading.total)} / ${short(reading.window)})`)
  }
  if (cacheLine && (cacheLine.cache.warmUntil !== null || cacheLine.keepWarm.on)) {
    const { cache, keepWarm, isWorking } = cacheLine
    const extras = [ttlText(cache)]
    if (keepWarm.on) extras.push(`keep-warm ${capsText(keepWarm, cache, nowMs)}`)
    if (keepWarm.lastPing !== null) {
      extras.push(`last ping read ${short(keepWarm.lastPing.read)} wrote ${short(keepWarm.lastPing.wrote)}`)
    }
    parts.push(`TTL ${cacheLabel(cache, nowMs, isWorking)} (${extras.join(', ')})`)
  }
  return parts.join(' · ')
}