// The prompt cache's rules and keep-warm's policy in one place: the two TTLs,
// how Token Watch decides which one the main conversation gets, when a ping
// goes out and when keep-warm stops. Constants and pure functions; the hooks
// module (./register.tsx) applies them and the band (./band.tsx) reads the
// constants it shows.

import type { CacheState, KeepWarm, Limit, Ttl, TtlInputs, TtlSource, View } from '../types'

export const MINUTE = 60_000

export const TTL_MS: Record<Ttl, number> = { '5m': 5 * MINUTE, '1h': 60 * MINUTE }

// How long a keep-warm ping keeps the cache warm, counted from the ping: null
// means the main conversation's own TTL.
//
// Measured in the spike. Five-minute TTL (forced): a check eight minutes after
// a response read nothing from the cache (run A0), and read 47k tokens when
// one fork had pinged at four minutes (run A1). One-hour TTL: a check at 65
// minutes read nothing (run B0), and read the 33k tokens a fork had read at
// 55 minutes (run B1), ten minutes after that ping: a fork's read renews the
// entries it hits for their original TTL, not for the fork's own five
// minutes. Set a number of milliseconds here to assume a shorter renewal.
export const PING_REFRESH_MS: number | null = null

// How long before the believed expiry a ping is sent, by the window it
// extends: 75 s on a five-minute window, 8 min on an hour. Generous, because
// the API counts a TTL from the start of the last request while the band
// counts from the end of its response, and because idle compaction can run
// about 54 minutes into an idle hour.
export function leadMs(windowMs: number) {
  return windowMs >= TTL_MS['1h'] ? 8 * MINUTE : 75_000
}

// The caps, by the window each ping buys: on five-minute refreshes 30 pings
// or two hours, on hour-long refreshes 8 pings or eight hours.
export function caps(windowMs: number) {
  return windowMs >= TTL_MS['1h'] ? { pings: 8, ms: 8 * 60 * MINUTE } : { pings: 30, ms: 2 * 60 * MINUTE }
}

// What one ping refreshes the cache for, under the TTL the conversation has.
export function refreshMs(ttl: Ttl) {
  return PING_REFRESH_MS ?? TTL_MS[ttl]
}

// The one user message a ping appends; the reply is a few tokens.
export const PING_PROMPT = 'Reply with the single word: ok'

// Keep-warm stops after this many failed pings in a row, and retries a
// failed one after RETRY_MS.
export const MAX_FAILURES = 2
export const RETRY_MS = 30_000

// A ping that reads less than this share of the last response's prompt found
// the cache cold (a warm fork read about 70% of it in the spike, since its
// request differs from the main thread's in its tail). Before the first
// breakdown, below MIN_WARM_READ tokens.
export const COLD_READ_SHARE = 0.5
export const MIN_WARM_READ = 1024

// How long the band shows a ping's counts or a stop reason.
export const NOTE_MS = 60_000

// Prompt origins that are not the person typing (PromptOrigin in the API's
// declarations): a prompt from any other origin turns keep-warm off.
export const BACKGROUND_ORIGINS: ReadonlySet<string> = new Set([
  'task-notification',
  'scheduled-trigger',
  'peer',
  'peer-send-message',
  'projects-relay',
  'channel',
  'coordinator',
  'observer',
  'observer-activity',
  'auto-continuation',
  'plugin',
])

export function isTtl(value: unknown): value is Ttl {
  return value === '5m' || value === '1h'
}

export const NO_INPUTS: TtlInputs = { force5m: false, envTtl: null, settingTtl: null, enable1h: false, idleCompaction: true }

export const NO_CACHE: CacheState = {
  ttl: '5m',
  ttlSource: 'API key or cloud',
  idleCompaction: false,
  lastResponseAt: null,
  warmUntil: null,
  windowMs: TTL_MS['5m'],
  prefixTokens: null,
  confirmed: false,
}

export const KEEP_WARM_OFF: KeepWarm = { on: false, startedAt: null, pings: 0, failures: 0, lastPing: null, note: null }

// The TTL the main conversation gets, in Claude Code's order of precedence
// (docs: prompt caching, "Choose the TTL yourself"): FORCE_PROMPT_CACHING_5M,
// then CLAUDE_CODE_PROMPT_CACHE_TTL, then the promptCacheTtl setting, then
// ENABLE_PROMPT_CACHING_1H, then the default: an hour on a subscription
// within its plan usage (a usage window past 100% means usage credits, so
// five minutes), five minutes with an API key or a cloud provider. A ping
// that found the cache warm more than five minutes after the last response
// has proved the hour, which outranks the default alone.
export function resolveTtl(inputs: TtlInputs, limits: Limit[], confirmed: boolean): { ttl: Ttl; ttlSource: TtlSource } {
  if (inputs.force5m) return { ttl: '5m', ttlSource: 'FORCE_PROMPT_CACHING_5M' }
  if (inputs.envTtl !== null) return { ttl: inputs.envTtl, ttlSource: 'CLAUDE_CODE_PROMPT_CACHE_TTL' }
  if (inputs.settingTtl !== null) return { ttl: inputs.settingTtl, ttlSource: 'promptCacheTtl' }
  if (inputs.enable1h) return { ttl: '1h', ttlSource: 'ENABLE_PROMPT_CACHING_1H' }
  if (limits.some(w => w.percentUsed >= 100)) return { ttl: '5m', ttlSource: 'over plan limit' }
  if (confirmed) return { ttl: '1h', ttlSource: 'confirmed' }
  if (limits.length === 0) return { ttl: '5m', ttlSource: 'API key or cloud' }
  return { ttl: '1h', ttlSource: 'subscription' }
}

// The view a right click moves to.
export function nextView(view: View): View {
  return view === 'expanded' ? 'bars' : view === 'bars' ? 'plain' : 'expanded'
}