// Token Watch: plan usage (the 5-hour and weekly windows, and any other
// window Claude Code reports), the context window and the prompt cache's
// countdown as thin bars above the prompt. A right click cycles the band's
// three views, the cache timer and the Keep warm button turn keep-warm on and
// off, and /context-bar shows or hides it.
//
// session.start: register /context-bar, restore the saved view (or the one
//   the 1.1 keys meant) and the last usage windows seen (a new session has
//   none until its first response), read the TTL controls once (three
//   environment variables; the promptCacheTtl, idleCompaction and
//   autoCompactEnabled settings), take a reading, and tick a clock every 30s
//   so the countdowns stay current and the usage snapshot says the session
//   is alive.
// session.measure: after each main-thread turn, or when a usage window moves,
//   take a reading.
// turn.start / turn.complete (main loop): no ping while a turn runs; when a
//   response ends the countdown restarts, since its request refreshed the
//   cache. Neither hook reads the text.
// prompt.submit: a prompt from the person turns keep-warm off; a background
//   delivery does not. Only the origin is read, and the prompt passes on.
// session.compact (main loop): keep-warm off, the countdown restarts.
// session.end (clear): the cache is forgotten; keep-warm off.
// command.run (context-bar): show or hide the band where it draws; where it
//   cannot be drawn (the VS Code extension's chat panel, a headless run),
//   answer with the reading as one line of text. `text` asks for that line
//   anywhere, `file` for the snapshot's path.
// ui.render (AbovePrompt): the band, drawn by the Client in ./band.tsx, which
//   lays itself out to the room it is given and reports clicks.
// ui.message: the band was clicked: { action: 'cycle' } (right click) moves
//   to the next view, { action: 'keep-warm' } (the timer or Keep warm)
//   toggles keep-warm, { action: 'refresh-caps' } starts its caps over.
//
// A reading is $.session.usage({ breakdown: 'summary' }): the /context rows,
// estimated locally, so it costs no token-count request, and the plan's
// rate-limit windows as the status line has them (none off a subscription).
// Each reading is also written to ~/.claude/token-watch/usage.json, the
// snapshot a companion (Token Watch for VS Code) reads; the plugin's
// `snapshot` option turns that off.
//
// Keep-warm: a ping is $.model.fork with a one-word prompt, which repeats the
// main thread's last request so the API serves it from the cache and
// refreshes the entry. Pings go out a lead time before the believed expiry,
// never during a turn, and stop at the caps, when the person types, after
// two failures in a row, when a ping finds the cache cold, at compaction and
// at /clear. The rules are in ./cache.ts.

import { atom, read, update } from 'claude-code'
import type { Register, Timer } from 'claude-code'

import type { BandProps, Limit, Reading, Slice, Snapshot, TtlInputs, View } from '../types'
import {
  BACKGROUND_ORIGINS,
  COLD_READ_SHARE,
  KEEP_WARM_OFF,
  MAX_FAILURES,
  MIN_WARM_READ,
  NO_CACHE,
  NO_INPUTS,
  PING_PROMPT,
  RETRY_MS,
  TTL_MS,
  caps,
  isTtl,
  leadMs,
  nextView,
  refreshMs,
  resolveTtl,
} from './cache'
import { hmm, label, readingLine, short, sorted } from './format'

const reading = atom({ plugin: 'token-watch', key: 'reading' } as const, null)
const isShown = atom({ plugin: 'token-watch', key: 'isShown' } as const, true)
const view = atom({ plugin: 'token-watch', key: 'view' } as const, 'expanded')
const limits = atom({ plugin: 'token-watch', key: 'limits' } as const, [])
const nowMs = atom({ plugin: 'token-watch', key: 'nowMs' } as const, 0)
const working = atom({ plugin: 'token-watch', key: 'working' } as const, false)
const ttlInputs = atom({ plugin: 'token-watch', key: 'ttlInputs' } as const, NO_INPUTS)
const cache = atom({ plugin: 'token-watch', key: 'cache' } as const, NO_CACHE)
const keepWarm = atom({ plugin: 'token-watch', key: 'keepWarm' } as const, KEEP_WARM_OFF)

// /context's row names, shortened for the legend.
const LABELS: Record<string, string> = {
  'system tools': 'tools',
  'custom agents': 'agents',
  'free space': 'free',
  'autocompact buffer': 'buffer',
}

const COLORS: Record<string, string> = {
  'system prompt': '#7b9cd8',
  tools: '#7ecfc4',
  'mcp tools': '#a78bfa',
  agents: '#8fd18f',
  'memory files': '#e8c66a',
  skills: '#e89bb8',
  messages: '#d97757',
}

// The usage snapshot: where it goes under the home directory, how often it
// is written again while the session is alive, and how long another
// session's snapshot stays its own before this session takes the file over.
const SNAPSHOT_PARTS = ['.claude', 'token-watch', 'usage.json']
const HEARTBEAT_MS = 30_000
const SNAPSHOT_FRESH_MS = 120_000

// The least a ping waits once armed.
const MIN_PING_WAIT_MS = 1_000

// Snapshot bookkeeping and the armed ping. Module variables: a hot reload
// loses them, which costs one extra write, and the heartbeat arms the ping
// again.
let snapshotOn = true
let snapshotPath: string | null = null
let lastWriteMs = 0
let lastKey = ''
let pingTimer: Timer | null = null

export const register: Register = (on, options) => {
  // The plugin's `snapshot` option (/config): on unless set to false.
  snapshotOn = options.snapshot !== false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'context-bar',
      description:
        'Show or hide the Token Watch band (plan usage, context and the prompt cache countdown) above the prompt; right-click it to cycle its views; "text" for the reading as a line, "file" for the usage snapshot',
      argumentHint: '[text|file]',
    })
    const shown = await $.store.get('isShown')
    await update($, isShown, () => shown !== false)
    const restored = await restoreView($)
    await update($, view, () => restored)
    await tick($)
    // A new session has no usage windows until its first response, so start
    // from the last ones seen; any whose reset time has passed is drawn at 0%,
    // and the first response replaces them.
    const saved = await $.store.get('limits')
    if (Array.isArray(saved)) {
      await update($, limits, () => saved as Limit[])
    }
    if (snapshotOn) {
      snapshotPath = await resolveSnapshotPath($)
    }
    const inputs = await readTtlInputs($)
    await update($, ttlInputs, () => inputs)
    await settleTtl($)
    await takeReading($)
    $.clock.every(HEARTBEAT_MS, () => void tick($).then(() => heartbeat($)))
    // The ping timer is a module variable a hot reload drops, while keep-warm's state lives in $.state.
    if ((await read($, keepWarm)).on) await schedule($)

    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    // The snapshot follows every reading, band or no band.
    if (snapshotOn || (await read($, isShown))) {
      await tick($)
      await takeReading($)
    }

    return result
  })

  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    stopPingTimer()
    await update($, working, () => true)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result
    await tick($)
    await update($, working, () => false)
    // A response came back, so its request was served: the cache was
    // refreshed at that moment. An interrupted or failed turn without one
    // leaves the countdown as it was.
    if (e.usage) await rebase($)
    await schedule($)
    await writeSnapshot($)
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    // The person is back: keep-warm has done its job. A delivery from a
    // notification, a schedule, a peer or a plugin is not the person.
    const kind = (e.origin as { kind?: string } | undefined)?.kind ?? ''
    if (!BACKGROUND_ORIGINS.has(kind) && (await read($, keepWarm)).on) {
      await stopKeepWarm($, null)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    // The conversation layer is replaced; the summarizer's request read the
    // prefix, so the layers that stay are warm from now.
    if (!e.agentId && result.skip === undefined) {
      await tick($)
      if ((await read($, keepWarm)).on) await stopKeepWarm($, 'stopped: compaction')
      if ((await read($, cache)).lastResponseAt !== null) await rebase($)
    }
    return result
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    const result = await next(e)
    if (e.reason === 'clear') {
      stopPingTimer()
      await update($, keepWarm, () => KEEP_WARM_OFF)
      await update($, cache, c => ({
        ...c,
        lastResponseAt: null,
        warmUntil: null,
        windowMs: TTL_MS[c.ttl],
        prefixTokens: null,
        confirmed: false,
      }))
      await settleTtl($)
    }
    return result
  })

  on('command.run', { command: 'context-bar' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'file') {
      return { text: await snapshotStatus($) }
    }
    if (arg !== '' && arg !== 'text') {
      return { text: 'Usage: /context-bar [text|file]' }
    }
    // The band draws on the terminal and the desktop app alone. Elsewhere
    // (the VS Code extension's chat panel, a headless run) a bare
    // /context-bar answers with the reading as one line instead of toggling
    // a band nobody would see.
    const surfaces = await $.session.surfaces().catch(() => ['terminal'] as const)
    const draws = surfaces.some(s => s === 'terminal' || s === 'desktop')
    if (arg === 'text' || !draws) {
      await tick($)
      await takeReading($)
      const now = await read($, nowMs)
      const text = readingLine(await read($, reading), current(await read($, limits), now), now, {
        cache: await read($, cache),
        keepWarm: await read($, keepWarm),
        isWorking: await read($, working),
      })
      return { text: text || 'Token Watch: no reading yet.' }
    }

    const shown = !(await read($, isShown))
    await update($, isShown, () => shown)
    await $.store.set('isShown', shown)
    if (shown) {
      await takeReading($)
    }

    return { text: shown ? 'Token Watch shown.' : 'Token Watch hidden.' }
  })

  on('ui.message', async ($, e, next) => {
    const action = (e.data as { action?: string } | null)?.action
    if (action === 'cycle') {
      const moved = nextView(await read($, view))
      await update($, view, () => moved)
      await $.store.set('view', moved)
      return {}
    }
    if (action === 'keep-warm') {
      await toggleKeepWarm($)
      return {}
    }
    if (action === 'refresh-caps') {
      await refreshCaps($)
      return {}
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, reading)
    if (e.props.hasSurvey || now === null || !(await read($, isShown))) {
      return next(e)
    }

    // The band holds one drawing, so whatever the plugins beneath draw there
    // (another mod's hint) stacks above this band instead of being replaced.
    const below = await next(e)
    const { Box, Client } = $.ui.resolve(e)
    const clock = await read($, nowMs)
    const props: BandProps = {
      reading: now,
      limits: current(await read($, limits), clock),
      nowMs: clock,
      view: await read($, view),
      isWorking: e.props.isWorking || (await read($, working)),
      cache: await read($, cache),
      keepWarm: await read($, keepWarm),
      surface: e.surface,
    }

    return (
      <Box flexDirection="column">
        {below}
        <Client key="band" module="./band.tsx" props={props} width="100%" />
      </Box>
    )
  })
}

async function takeReading($) {
  try {
    const { context, rateLimits } = await $.session.usage({ breakdown: 'summary' })
    if (rateLimits.length > 0) {
      const reported: Limit[] = rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt }))
      // A window the reading leaves out keeps its last values until its reset
      // time; one still left out after that is no longer part of the plan.
      const now = await $.clock.now()
      const kept = (await read($, limits)).filter(
        w => !reported.some(r => r.kind === w.kind) && !!w.resetsAt && Date.parse(w.resetsAt) > now,
      )
      const windows = [...reported, ...kept]
      await update($, limits, () => windows)
      await $.store.set('limits', windows)
    }
    const breakdown = context.breakdown
    if (breakdown && breakdown.rawMaxTokens) {
      const slices: Slice[] = breakdown.categories
        .filter(row => row.kind !== 'deferred' && row.tokens > 0)
        .map(row => {
          const name = row.name.toLowerCase()
          const label = LABELS[name] ?? name
          return {
            label,
            tokens: row.tokens,
            color: COLORS[label] ?? row.color,
            kind: row.kind as Slice['kind'],
          }
        })
      const next: Reading = {
        slices,
        total: breakdown.totalTokens,
        window: breakdown.rawMaxTokens,
        compactsAt: breakdown.isAutoCompactEnabled ? (breakdown.autoCompactThreshold ?? null) : null,
      }
      await update($, reading, () => next)
      // The last response's prompt, what a warm ping reads most of.
      const api = breakdown.apiUsage
      if (api) {
        const prefix = api.input_tokens + api.cache_read_input_tokens + api.cache_creation_input_tokens
        await update($, cache, c => (c.prefixTokens === prefix ? c : { ...c, prefixTokens: prefix }))
      }
    }
  } catch {
    // No reading this time; the band keeps the last one.
    return
  }
  await settleTtl($)
  await writeSnapshot($)
}

async function tick($) {
  const now = await $.clock.now()
  await update($, nowMs, () => now)
}

// The windows as they stand now: one whose reset time has passed has started
// over, so it is drawn at 0% until a response reports it again.
function current(windows: Limit[], nowMs: number) {
  return windows.map(w =>
    !w.resetsAt || !nowMs || Date.parse(w.resetsAt) > nowMs ? w : { kind: w.kind, percentUsed: 0 },
  )
}

// The saved view; or the one the 1.1 keys (isCollapsed, showBars) meant,
// saved under `view` in their place.
async function restoreView($): Promise<View> {
  const saved = await $.store.get('view')
  if (saved === 'expanded' || saved === 'bars' || saved === 'plain') return saved
  const collapsed = await $.store.get('isCollapsed')
  const bars = await $.store.get('showBars')
  const migrated: View = collapsed === true ? (bars === false ? 'plain' : 'bars') : 'expanded'
  if (collapsed !== undefined || bars !== undefined) {
    await $.store.set('view', migrated)
    await $.store.delete('isCollapsed')
    await $.store.delete('showBars')
  }
  return migrated
}

// The TTL controls, read once: the three environment variables Claude Code
// honours, and from the settings promptCacheTtl, and whether idle compaction
// may run (idleCompaction and autoCompactEnabled not false). Nothing else of
// the environment or the settings is read or kept.
async function readTtlInputs($): Promise<TtlInputs> {
  const inputs: TtlInputs = { ...NO_INPUTS }
  try {
    inputs.force5m = (await $.env.get('FORCE_PROMPT_CACHING_5M')) === '1'
    const env = await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL')
    inputs.envTtl = isTtl(env) ? env : null
    inputs.enable1h = (await $.env.get('ENABLE_PROMPT_CACHING_1H')) === '1'
  } catch {
    // The environment could not be read: the defaults stand.
  }
  try {
    const settings = await $.settings.read()
    const setting = settings.promptCacheTtl
    inputs.settingTtl = isTtl(setting) ? setting : null
    inputs.idleCompaction = settings.idleCompaction !== false && settings.autoCompactEnabled !== false
  } catch {
    // No settings: the defaults stand.
  }
  return inputs
}

// The TTL as the controls and the plan say it is now.
async function settleTtl($) {
  const inputs = await read($, ttlInputs)
  const c = await read($, cache)
  const now = await read($, nowMs)
  const { ttl, ttlSource } = resolveTtl(inputs, current(await read($, limits), now), c.confirmed)
  const idleCompaction = ttl === '1h' && inputs.idleCompaction
  if (ttl !== c.ttl || ttlSource !== c.ttlSource || idleCompaction !== c.idleCompaction) {
    await update($, cache, cc => ({ ...cc, ttl, ttlSource, idleCompaction }))
  }
}

// A main-thread request was just served: the countdown restarts from now.
async function rebase($) {
  const now = await read($, nowMs)
  await update($, cache, c => ({ ...c, lastResponseAt: now, warmUntil: now + TTL_MS[c.ttl], windowMs: TTL_MS[c.ttl] }))
}

// Either button: keep-warm on, when there is a warm cache to keep (or a turn
// is making one), else off. Pressed with nothing warm to keep, a note says so.
async function toggleKeepWarm($) {
  await tick($)
  const now = await read($, nowMs)
  const k = await read($, keepWarm)
  if (k.on) {
    await stopKeepWarm($, null)
  } else {
    const c = await read($, cache)
    const isWorking = await read($, working)
    if (!isWorking && c.warmUntil === null) {
      await update($, keepWarm, kw => ({ ...kw, note: { at: now, text: 'keep-warm: nothing cached yet' } }))
    } else if (!isWorking && c.warmUntil !== null && now >= c.warmUntil) {
      await update($, keepWarm, kw => ({ ...kw, note: { at: now, text: 'keep-warm: the cache is already cold' } }))
    } else {
      await update($, keepWarm, () => ({ ...KEEP_WARM_OFF, on: true, startedAt: now }))
      await schedule($)
    }
  }
  await writeSnapshot($)
}

// Refresh caps: keep-warm starts its pings and its time over from now, as
// if just turned on, without a ping or a gap in the schedule. Only while it is on.
async function refreshCaps($) {
  await tick($)
  const now = await read($, nowMs)
  if (!(await read($, keepWarm)).on) return
  await update($, keepWarm, kw => ({ ...kw, pings: 0, failures: 0, startedAt: now, note: null }))
  await writeSnapshot($)
}

// Keep-warm off, with a note the band shows for a minute when there is a
// reason to give.
async function stopKeepWarm($, text: string | null) {
  stopPingTimer()
  const now = await read($, nowMs)
  await update($, keepWarm, k => ({ ...k, on: false, note: text === null ? null : { at: now, text } }))
}

function stopPingTimer() {
  pingTimer?.cancel()
  pingTimer = null
}

// Arms the next ping: a lead time before the believed expiry. Nothing is
// armed while keep-warm is off, before the first response, while a turn runs
// (its end arms it) or once the cache has gone cold (the heartbeat then
// turns keep-warm off).
async function schedule($) {
  stopPingTimer()
  const k = await read($, keepWarm)
  const c = await read($, cache)
  if (!k.on || c.warmUntil === null || (await read($, working))) return
  const now = await $.clock.now()
  if (now >= c.warmUntil) return
  const wait = Math.max(MIN_PING_WAIT_MS, c.warmUntil - leadMs(c.windowMs) - now)
  pingTimer = $.clock.after(wait, () => void ping($))
}

// One ping: the caps checked, the fork sent, its counts shown, the countdown
// moved on and the next ping armed; or keep-warm stopped, saying why.
async function ping($) {
  pingTimer = null
  const k = await read($, keepWarm)
  const c = await read($, cache)
  if (!k.on || c.warmUntil === null || (await read($, working))) return
  await tick($)
  const sentAt = await read($, nowMs)
  if (sentAt >= c.warmUntil) return stopKeepWarm($, 'stopped: cache went cold')
  const cap = caps(refreshMs(c.ttl))
  if (k.pings >= cap.pings) return stopKeepWarm($, `stopped: ${cap.pings} pings`)
  if (k.startedAt !== null && sentAt - k.startedAt >= cap.ms) return stopKeepWarm($, `stopped: ${hmm(cap.ms)} reached`)

  let result
  try {
    result = await $.model.fork({ prompt: PING_PROMPT })
  } catch (err) {
    // A fork that throws is a failed ping like any other.
    await tick($)
    const failedAt = await read($, nowMs)
    if (!(await read($, keepWarm)).on) return
    await pingFailed($, k.failures, String(err).slice(0, 120), failedAt)
    await writeSnapshot($)
    return
  }
  await tick($)
  const now = await read($, nowMs)
  if (!(await read($, keepWarm)).on) return
  if (result.isAnswered) {
    const got = result.usage.cache_read_input_tokens
    const wrote = result.usage.cache_creation_input_tokens
    const isCold = c.prefixTokens === null ? got < MIN_WARM_READ : got < COLD_READ_SHARE * c.prefixTokens
    await update($, keepWarm, kw => ({
      ...kw,
      pings: kw.pings + 1,
      failures: 0,
      lastPing: { at: sentAt, read: got, wrote },
      note: { at: now, text: `ping read ${short(got)} · wrote ${short(wrote)}` },
    }))
    if (isCold) {
      // The cache was already cold: the ping paid to re-cache the prefix, and
      // the next one would too. Stop, and show the cache as cold.
      await update($, cache, cc => ({ ...cc, warmUntil: sentAt }))
      await stopKeepWarm($, 'stopped: cache was cold')
    } else {
      // The first ping since the response, more than five minutes after it,
      // read the cache: that is the hour TTL at work.
      const firstSinceResponse = k.lastPing === null || (c.lastResponseAt !== null && k.lastPing.at < c.lastResponseAt)
      const confirmed =
        c.confirmed ||
        (c.ttl === '1h' && firstSinceResponse && c.lastResponseAt !== null && sentAt - c.lastResponseAt > TTL_MS['5m'] + 30_000)
      const refresh = refreshMs(c.ttl)
      await update($, cache, cc => ({
        ...cc,
        warmUntil: Math.max(cc.warmUntil ?? sentAt, sentAt + refresh),
        windowMs: refresh,
        confirmed,
      }))
      if (confirmed) await settleTtl($)
      await schedule($)
    }
  } else if (result.reason === 'nothing-to-fork') {
    await stopKeepWarm($, 'stopped: nothing cached yet')
  } else {
    await pingFailed($, k.failures, result.reason === 'api-error' ? result.error : result.reason, now)
  }
  await writeSnapshot($)
}

// A failed ping: counted, shown, and keep-warm stopped after MAX_FAILURES in a
// row, else retried after RETRY_MS.
async function pingFailed($, before: number, why: string, now: number) {
  const failures = before + 1
  await update($, keepWarm, kw => ({ ...kw, failures, note: { at: now, text: `ping failed: ${why}` } }))
  if (failures >= MAX_FAILURES) await stopKeepWarm($, `stopped: ${MAX_FAILURES} pings failed`)
  else pingTimer = $.clock.after(RETRY_MS, () => void ping($))
}

// Where the snapshot goes: ~/.claude/token-watch/usage.json, `~` being
// USERPROFILE (Windows) or else HOME, the choice Node's os.homedir() makes,
// so the companion finds it. The path is joined with the home directory's own
// separator: backslashes if it has any, else slashes. Null when neither
// variable is set.
async function resolveSnapshotPath($) {
  try {
    const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
    if (!home) return null
    const separator = home.includes('\\') ? '\\' : '/'
    return [home.replace(/[\\/]+$/, ''), ...SNAPSHOT_PARTS].join(separator)
  } catch {
    return null
  }
}

// Writes the snapshot when its figures changed, or when `force` (the
// heartbeat). $.fs.write has no atomic form, so a reader may see a torn file
// for an instant and should read again.
async function writeSnapshot($, force = false) {
  if (!snapshotPath) return
  try {
    const now = await $.clock.now()
    const latest = await read($, reading)
    const c = await read($, cache)
    const k = await read($, keepWarm)
    const cap = caps(refreshMs(c.ttl))
    const iso = (ms: number) => new Date(ms).toISOString()
    const snapshot: Snapshot = {
      schema: 1,
      writtenAt: iso(now),
      session: {
        id: await $.session.id().catch(() => null),
        cwd: await $.session.cwd().catch(() => null),
      },
      windows: sorted(await read($, limits)).map(w => ({
        kind: w.kind,
        label: label(w),
        percentUsed: w.percentUsed,
        resetsAt: w.resetsAt ?? null,
      })),
      context:
        latest === null
          ? null
          : {
              total: latest.total,
              window: latest.window,
              percent: Math.round((latest.total / latest.window) * 100),
              compactsAt: latest.compactsAt,
              categories: latest.slices,
            },
      cache: {
        ttl: c.ttl,
        ttlSource: c.ttlSource,
        expiresAt: c.warmUntil === null ? null : iso(c.warmUntil),
        warm: c.warmUntil !== null && now < c.warmUntil,
        keepWarm: {
          on: k.on,
          pings: k.pings,
          maxPings: cap.pings,
          startedAt: k.startedAt === null ? null : iso(k.startedAt),
          maxMs: cap.ms,
          lastPing: k.lastPing === null ? null : { at: iso(k.lastPing.at), read: k.lastPing.read, wrote: k.lastPing.wrote },
        },
      },
    }
    const key = JSON.stringify({ ...snapshot, writtenAt: '' })
    if (!force && key === lastKey && now - lastWriteMs < HEARTBEAT_MS) return
    await $.fs.write(snapshotPath, JSON.stringify(snapshot, null, 2) + '\n')
    lastKey = key
    lastWriteMs = now
  } catch {
    // No snapshot this time; the file keeps the last one.
  }
}

// Every HEARTBEAT_MS: keep-warm off once the cache has gone cold under it, or
// the next ping armed if none is (a reload lost it); then write the snapshot
// again so its timestamp says this session is alive, unless another session
// wrote it more recently and its snapshot is still fresh. That session keeps
// the file while it is active; this one takes over once its snapshot has
// gone stale.
async function heartbeat($) {
  try {
    const k = await read($, keepWarm)
    const c = await read($, cache)
    const now = await read($, nowMs)
    if (k.on && c.warmUntil !== null && now >= c.warmUntil && !(await read($, working))) {
      await stopKeepWarm($, 'stopped: cache went cold')
    } else if (pingTimer === null) {
      await schedule($)
    }
  } catch {
    // Try again at the next tick.
  }
  if (!snapshotPath) return
  try {
    const stat = await $.fs.stat(snapshotPath).catch(() => null)
    const now = await $.clock.now()
    if (stat !== null && stat.mtimeMs > lastWriteMs + 1_000 && now - stat.mtimeMs < SNAPSHOT_FRESH_MS) return
    await writeSnapshot($, true)
  } catch {
    // Try again at the next tick.
  }
}

// What /context-bar file answers: where the snapshot is and when it was
// last written, or why there is none.
async function snapshotStatus($) {
  if (!snapshotOn) {
    return 'Token Watch snapshot: off. Turn it on in /config ("Usage snapshot file"), or in /plugin, token-watch, Configure options.'
  }
  if (!snapshotPath) {
    return 'Token Watch snapshot: on, but neither USERPROFILE nor HOME is set, so there is nowhere to write it.'
  }
  if (!lastWriteMs) {
    return `Token Watch snapshot: ${snapshotPath} (not written yet).`
  }
  const seconds = Math.max(0, Math.round(((await $.clock.now()) - lastWriteMs) / 1000))
  return `Token Watch snapshot: ${snapshotPath} (written ${seconds}s ago).`
}