// Burn rates: how fast each usage window fills and the context grows, from
// the readings Token Watch already takes, averaged over a window the settings
// panel sets. Pure functions; the hooks module keeps the readings and the
// band draws the results.
//
// A window's percentage is kept only when it moves, so it is a step function:
// its value at any moment is the newest sample at or before that moment. The
// pace over the window is the step from the window's start to now, over the
// time between them. The 5-hour and weekly windows are the account's, so the
// samples are shared by every session through the store.

import type { CtxSample, History, Limit, Sample } from '../types'
import { MINUTE } from './cache'

const HOUR = 60 * MINUTE

// The least time a rate is worked out over: less, and a single step of one
// reading would read as a pace.
export const MIN_SPAN_MS = 5 * MINUTE

// How long samples are kept: the longest averaging window the panel offers,
// plus the newest older sample, which says where that window started.
export const KEEP_MS = 120 * MINUTE

// Samples kept: those newer than KEEP_MS, and the newest older one.
function trim<T extends { at: number }>(samples: T[], now: number): T[] {
  const cut = samples.findIndex(s => s.at > now - KEEP_MS)
  if (cut === -1) return samples.slice(-1)
  return samples.slice(Math.max(0, cut - 1))
}

// A reading's windows added to the history: a sample where a window's
// percentage moved; a window whose percentage fell or whose reset time moved
// has reset, and starts over. Unchanged, the history comes back as it was.
export function addReadings(history: History, limits: Limit[], at: number): History {
  let next = history
  for (const limit of limits) {
    const resetsAt = limit.resetsAt ?? null
    const kept = history[limit.kind]
    const last = kept?.samples[kept.samples.length - 1]
    const hasReset = !kept || kept.resetsAt !== resetsAt || (last !== undefined && limit.percentUsed < last.percent)
    if (!hasReset && last !== undefined && last.percent === limit.percentUsed) continue
    const sample: Sample = { at, percent: limit.percentUsed }
    const samples = hasReset || !kept ? [sample] : trim([...kept.samples, sample], at)
    next = { ...next, [limit.kind]: { resetsAt, samples } }
  }
  return next
}

// A history read back from the store: each window's samples in time order,
// anything that does not read as one left out.
export function readHistory(saved: unknown): History {
  const history: History = {}
  if (typeof saved !== 'object' || saved === null) return history
  for (const [kind, value] of Object.entries(saved as Record<string, unknown>)) {
    const v = value as { resetsAt?: unknown; samples?: unknown } | null
    if (!v || !Array.isArray(v.samples)) continue
    const samples = v.samples.filter(
      (s): s is Sample => typeof s?.at === 'number' && typeof s?.percent === 'number',
    )
    if (samples.length === 0) continue
    samples.sort((a, b) => a.at - b.at)
    history[kind] = { resetsAt: typeof v.resetsAt === 'string' ? v.resetsAt : null, samples }
  }
  return history
}

// The step from the window's start to now: the value at the start (the newest
// sample at or before it, else the oldest, when tracking began later) and the
// newest value, with the time between the start used and now, and how many
// samples came after the start's (by position: readings can share a moment).
function stepOver<T extends { at: number }>(samples: T[], now: number, windowMs: number) {
  const last = samples[samples.length - 1]
  if (last === undefined) return null
  const start = now - windowMs
  let baseIndex = 0
  samples.forEach((s, i) => {
    if (s.at <= start) baseIndex = i
  })
  const base = samples[baseIndex]!
  const from = Math.max(base.at, start)
  return { base, last, span: now - from, after: samples.length - 1 - baseIndex }
}

// Percentage points an hour over the window, or null with less than
// MIN_SPAN_MS of readings in it.
export function ratePerHour(samples: Sample[], now: number, windowMs: number): number | null {
  const step = stepOver(samples, now, windowMs)
  if (step === null || step.span < MIN_SPAN_MS) return null
  return Math.max(0, (step.last.percent - step.base.percent) / (step.span / HOUR))
}

// When a window fills at this pace: null at no pace, already full, or when
// it would reset first.
export function fullAt(percent: number, perHour: number | null, now: number, resetsAt: string | undefined): number | null {
  if (perHour === null || perHour <= 0 || percent >= 100) return null
  const at = now + ((100 - percent) / perHour) * HOUR
  const reset = resetsAt ? Date.parse(resetsAt) : NaN
  return !Number.isNaN(reset) && at >= reset ? null : at
}

// The context's total added to this session's samples when it moved; a total
// that fell (compaction, /clear) starts over.
export function addContext(samples: CtxSample[], total: number, at: number): CtxSample[] {
  const last = samples[samples.length - 1]
  if (last !== undefined && last.total === total) return samples
  if (last !== undefined && total < last.total) return [{ at, total }]
  return trim([...samples, { at, total }], at)
}

// Readings until auto-compact at the mean growth per reading over the window
// (a reading follows each turn), or null with fewer than two readings in it,
// no growth, or no compaction point.
export function turnsToCompact(samples: CtxSample[], now: number, windowMs: number, compactsAt: number | null): number | null {
  const step = stepOver(samples, now, windowMs)
  if (step === null || compactsAt === null || step.after < 2) return null
  const growth = step.last.total - step.base.total
  if (growth <= 0) return null
  const left = compactsAt - step.last.total
  return left > 0 ? Math.ceil(left / (growth / step.after)) : null
}

// A rate as the band prints it: "+12%/h", "+3.2%/h", "+0.20%/min".
export function rateText(perHour: number, unit: 'h' | 'min') {
  if (unit === 'min') {
    const perMin = perHour / 60
    return `+${perMin >= 1 ? perMin.toFixed(1) : perMin.toFixed(2)}%/min`
  }
  return `+${perHour >= 10 ? Math.round(perHour) : perHour.toFixed(1)}%/h`
}
