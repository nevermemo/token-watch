// Burn rates: how fast each usage window fills, from the readings Token
// Watch already takes, averaged over a window the settings panel sets. Pure
// functions; the hooks module keeps the readings and the band draws the
// results.
//
// A window's percentage is kept only when it moves, so it is a step function:
// its value at any moment is the newest sample at or before that moment. The
// pace over the window is the step from the window's start to now, over the
// time between them. The 5-hour and weekly windows are the account's, so the
// samples are shared by every session through the store.

import type { BurnUnit, History, Limit, Sample } from '../types'
import { MINUTE } from './cache'

const HOUR = 60 * MINUTE

// The least time a rate is worked out over: less, and a single step of one
// reading would read as a pace.
export const MIN_SPAN_MS = 5 * MINUTE

// How long samples are kept: the longest averaging window the panel offers,
// plus the newest older sample, which says where that window started.
export const KEEP_MS = 24 * 60 * MINUTE

// A fall in the same period this many points or more is a reset (a plan
// change, a correction), not a reading that arrived out of order.
export const DROP_RESET = 5

// Reset times this close are the same one, however each was spelled.
const RESET_TOLERANCE_MS = 60_000

// Whether two reset times are the same period's.
export function isSameReset(a: string | null | undefined, b: string | null | undefined) {
  if (!a || !b) return !a && !b
  const at = Date.parse(a)
  const bt = Date.parse(b)
  return Number.isNaN(at) || Number.isNaN(bt) ? a === b : Math.abs(at - bt) < RESET_TOLERANCE_MS
}

// Whether a reset time is an earlier period's than another.
export function isEarlier(a: string | null | undefined, b: string | null | undefined) {
  if (!a || !b) return false
  const at = Date.parse(a)
  const bt = Date.parse(b)
  return !Number.isNaN(at) && !Number.isNaN(bt) && at < bt - RESET_TOLERANCE_MS
}

// Samples kept: those newer than KEEP_MS, and the newest older one.
function trim<T extends { at: number }>(samples: T[], now: number): T[] {
  const cut = samples.findIndex(s => s.at > now - KEEP_MS)
  if (cut === -1) return samples.slice(-1)
  return samples.slice(Math.max(0, cut - 1))
}

// A reading's windows added to the history: a sample where a window's
// percentage moved. A window whose reset time moved on has reset, and starts
// over; a reading from an earlier period arrived late, and is left out. In
// the same period, a small fall is a reading that arrived out of order (two
// sessions' responses crossing), left out too; a fall of DROP_RESET points
// or more (a plan change, a correction), or any fall in a window with no
// reset time to tell by, starts over. Unchanged, the history comes back as
// it was.
export function addReadings(history: History, limits: Limit[], at: number): History {
  let next = history
  for (const limit of limits) {
    const resetsAt = limit.resetsAt ?? null
    const kept = history[limit.kind]
    const last = kept?.samples[kept.samples.length - 1]
    if (kept && isEarlier(resetsAt, kept.resetsAt)) continue
    const fall = last === undefined ? 0 : last.percent - limit.percentUsed
    const isSamePeriod = kept !== undefined && isSameReset(kept.resetsAt, resetsAt)
    const hasReset = !isSamePeriod || (fall > 0 && (resetsAt === null || fall >= DROP_RESET))
    if (!hasReset && (fall > 0 || last?.percent === limit.percentUsed)) continue
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

// The change from the window's start to now: the value at the start and the
// newest value, with the time between. The value at the start lies on the
// line between the samples either side of it, so a gap between readings
// (usage elsewhere, on another device) is spread over the gap rather than
// booked at its end; with tracking begun later, the start is the oldest
// sample.
function stepOver(samples: Sample[], now: number, windowMs: number) {
  const last = samples[samples.length - 1]
  const first = samples[0]
  if (last === undefined || first === undefined) return null
  const start = now - windowMs
  if (first.at >= start) return { base: first.percent, last: last.percent, span: now - first.at }
  const after = samples.findIndex(s => s.at > start)
  if (after === -1) return { base: last.percent, last: last.percent, span: windowMs }
  const a = samples[after - 1]!
  const b = samples[after]!
  const base = a.percent + ((b.percent - a.percent) * (start - a.at)) / (b.at - a.at)
  return { base, last: last.percent, span: windowMs }
}

// Percentage points an hour over the window, or null with less than
// MIN_SPAN_MS of readings in it.
export function ratePerHour(samples: Sample[], now: number, windowMs: number): number | null {
  const step = stepOver(samples, now, windowMs)
  if (step === null || step.span < MIN_SPAN_MS) return null
  return Math.max(0, (step.last - step.base) / (step.span / HOUR))
}

// When a window fills at this pace: now when it is full already; null at no
// pace, or when it would reset first.
export function fullAt(percent: number, perHour: number | null, now: number, resetsAt: string | undefined): number | null {
  if (perHour === null) return null
  if (percent >= 100) return now
  if (perHour <= 0) return null
  const at = now + ((100 - percent) / perHour) * HOUR
  const reset = resetsAt ? Date.parse(resetsAt) : NaN
  return !Number.isNaN(reset) && at >= reset ? null : at
}

// A rate as the band prints it: "12%/h", "3.2%/h", "0.20%/min", "14%/day".
export function rateText(perHour: number, unit: BurnUnit) {
  // The precision chosen by the value as printed: 9.96 is "10%/h", not
  // "10.0%/h".
  if (unit === 'min') {
    const perMin = perHour / 60
    return `${Number(perMin.toFixed(2)) >= 1 ? perMin.toFixed(1) : perMin.toFixed(2)}%/min`
  }
  const value = unit === 'day' ? perHour * 24 : perHour
  return `${Number(value.toFixed(1)) >= 10 ? Math.round(value) : value.toFixed(1)}%/${unit}`
}
