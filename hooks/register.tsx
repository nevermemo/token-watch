// Token Watch: plan usage (the 5-hour and weekly windows, and any other
// window Claude Code reports), the context window and the prompt cache's
// countdown as thin bars above the prompt. A right click cycles the band's
// three views, the cache timer and the keep-warm button turn keep-warm on and
// off, and /token-watch shows or hides it.
//
// session.start: register /token-watch, restore the saved view (or the one
//   the 1.1 keys meant), the settings (the global ones and this session's
//   own, its id's settings kept 30 days) and the last usage windows seen (a new session has none until its first
//   response), read the TTL controls once (three environment variables and
//   the promptCacheTtl setting), take a reading, and tick a clock every 30s
//   so the countdowns stay current and the usage snapshot says the session
//   is alive.
// session.measure: after each main-thread turn, or when a usage window moves,
//   take a reading.
// turn.start / turn.complete (main loop): no ping while a turn runs; when a
//   response ends the countdown restarts, since its request refreshed the
//   cache. Neither hook reads the text.
// prompt.submit: a prompt from the person turns keep-warm off (in Notify
//   mode it stays on: a reminder costs nothing); a background delivery does
//   not. Only the origin is read, and the prompt passes on.
// session.compact (main loop, not a precompute): keep-warm off, the countdown
//   restarts.
// session.end: keep-warm off; where the process goes on under another session
//   (/clear, a resume, a logout), the cache is forgotten too.
// command.run (token-watch): show or hide the band where it draws; where it
//   cannot be drawn (the VS Code extension's chat panel, a headless run),
//   answer with the reading as one line of text. `text` asks for that line
//   anywhere, `file` for the snapshot's path, `settings` opens the settings
//   panel, `monitor` TW Monitor.
// ui.render (AbovePrompt): the band, drawn by the Client in ./band.tsx, which
//   lays itself out to the room it is given and reports clicks; beside it, the
//   settings button ([≡] in a terminal, ☰ on the desktop), a Button of this
//   module's own, so its press is the person's, and under it in the expanded
//   view the sessions button ([#] in a terminal, ⊞ on the desktop).
// ui.message: the band was clicked: { action: 'cycle' } (right click) moves
//   to the next view, { action: 'keep-warm' } (the timer or the keep-warm
//   button) toggles keep-warm, { action: 'refresh-caps' } starts its caps over.
// ui.render (Pane, the settings panel): in collapsible sections, what each
//   part shows in each view, each usage window's pace (in which views, over
//   which window, in which unit) and keep-warm's caps for this session's TTL,
//   for this session or for every session: a session's own setting overrides
//   the global one, leaf by leaf (./settings.ts). While no view shows the
//   cache keep-warm stays off, so nothing spends out of sight. Every 30 s the
//   global settings are read again, so a change another session made reaches
//   this one.
// ui.render (Pane, TW Monitor): every live session on this device,
//   from the sessions' files: its folder, its context and its cache's
//   countdown.
//
// Burn rates: each reading's usage windows are kept in the store where they
// moved (./burn.ts), shared by every session since the windows are the
// account's; the band shows each window's pace and when it fills.
//
// A reading is $.session.usage({ breakdown: 'summary' }): the /context rows,
// estimated locally, so it costs no token-count request, and the plan's
// rate-limit windows as the status line has them (none off a subscription).
// Each reading is also written to ~/.claude/token-watch/usage.json, the
// snapshot a companion (Token Watch for VS Code) reads, and to this session's
// own file in ~/.claude/token-watch/sessions/, which TW Monitor of
// every session on the device reads; the plugin's `snapshot` option turns
// both off.
//
// Keep-warm's mode (the settings): Pings, as below; Notify, no pings, one
// notification ($.ui.notify) a lead time before each countdown runs out,
// staying on across prompts; Both, pings, and one notification a lead time
// before the first ping of each idle spell. Alerts: a notification when a
// usage window (once per window period, shared through the store so one
// session says it) or this session's context crosses 80% or 95%.
//
// Keep-warm: a ping is $.model.fork with a one-word prompt, which repeats the
// main thread's last request so the API serves it from the cache and
// refreshes the entry. Pings go out a lead time before the believed expiry,
// never during a turn, never two at once and never while the TTL row is
// hidden, and stop at the caps, when the person types, after two failures in
// a row, when a ping finds the cache cold, at compaction and when the session
// ends. The rules are in ./cache.ts.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelForkResult, Register, Timer } from 'claude-code'

import type {
  BandProps,
  Cap,
  ContextDetails,
  MonitorCurrent,
  MonitorFilter,
  MonitorName,
  MonitorCtxPiece,
  MonitorTtlPiece,
  MonitorUsagePiece,
  MonitorSort,
  KeepWarm,
  Limit,
  Pace,
  Reading,
  Scope,
  SessionSnapshot,
  SettingsOverride,
  SettingsTree,
  Slice,
  Snapshot,
  TtlInputs,
  UsagePart,
  View,
  WarmMode,
} from '../types'
import {
  BACKGROUND_ORIGINS,
  CAP_LIMITS,
  COLD_READ_SHARE,
  DEFAULT_CAPS,
  KEEP_WARM_OFF,
  MAX_FAILURES,
  MIN_WARM_READ,
  NO_CACHE,
  NO_INPUTS,
  PING_LOST_MS,
  PING_PROMPT,
  RETRY_MS,
  SESSION_SETTINGS_KEEP_MS,
  TTL_MS,
  caps,
  isTtl,
  leadMs,
  nextView,
  refreshMs,
  resolveTtl,
} from './cache'
import {
  DEFAULT_SETTINGS,
  MONITOR_CURRENT,
  MONITOR_FILTERS,
  MONITOR_NAMES,
  MONITOR_CTX_PIECES,
  MONITOR_TTL_PIECES,
  MONITOR_USAGE_PIECES,
  MONITOR_SORTS,
  MONITOR_STATES,
  NOTIFY_LEADS,
  PACE_UNITS,
  PACE_WINDOWS,
  RECENT_STEPS,
  USAGE_PARTS,
  VIEWS,
  VIEW_NAMES,
  WARM_MODES,
  dropAt,
  forecastHiddenIn,
  fromLegacy,
  getAt,
  hiddenIn,
  isCacheHidden,
  isGlobalOnly,
  isEmptyOverride,
  merge,
  overridesUnder,
  paceHiddenIn,
  readOverride,
  readSettings,
  recentText,
  setAt,
  stepAlert,
  stepIn,
  windowText,
} from './settings'
import type { Path } from './settings'
import { addReadings, fullAt, ratePerHour, rateText, readHistory } from './burn'
import { countdown, duration, hmmss, label, levelColor, partOf, readingLine, short, sorted } from './format'

const reading = atom({ plugin: 'token-watch', key: 'reading' } as const, null)
const isShown = atom({ plugin: 'token-watch', key: 'isShown' } as const, true)
const view = atom({ plugin: 'token-watch', key: 'view' } as const, 'expanded')
const limits = atom({ plugin: 'token-watch', key: 'limits' } as const, [])
const limitsAt = atom({ plugin: 'token-watch', key: 'limitsAt' } as const, 0)
const nowMs = atom({ plugin: 'token-watch', key: 'nowMs' } as const, 0)
const working = atom({ plugin: 'token-watch', key: 'working' } as const, false)
const ttlInputs = atom({ plugin: 'token-watch', key: 'ttlInputs' } as const, NO_INPUTS)
const cache = atom({ plugin: 'token-watch', key: 'cache' } as const, NO_CACHE)
const keepWarm = atom({ plugin: 'token-watch', key: 'keepWarm' } as const, KEEP_WARM_OFF)
const pingingSince = atom({ plugin: 'token-watch', key: 'pingingSince' } as const, null)
const settings = atom({ plugin: 'token-watch', key: 'settings' } as const, DEFAULT_SETTINGS)
const globalSettings = atom({ plugin: 'token-watch', key: 'globalSettings' } as const, DEFAULT_SETTINGS)
const override = atom({ plugin: 'token-watch', key: 'override' } as const, {})
const scope = atom({ plugin: 'token-watch', key: 'scope' } as const, 'session')
const openSections = atom({ plugin: 'token-watch', key: 'openSections' } as const, [])
const ctxAlerted = atom({ plugin: 'token-watch', key: 'ctxAlerted' } as const, [])
const history = atom({ plugin: 'token-watch', key: 'history' } as const, {})
const sessions = atom({ plugin: 'token-watch', key: 'sessions' } as const, [])
const sessionsClosed = atom({ plugin: 'token-watch', key: 'sessionsClosed' } as const, [])
const pinned = atom({ plugin: 'token-watch', key: 'pinned' } as const, {})
const titles = atom({ plugin: 'token-watch', key: 'titles' } as const, {})
const clearPresses = atom({ plugin: 'token-watch', key: 'clearPresses' } as const, { count: 0, since: 0 })
const hiddenSessions = atom({ plugin: 'token-watch', key: 'hiddenSessions' } as const, {})

// The context's details lines, as the panel names them.
const DETAILS: ['mcp' | 'memory' | 'skills', string][] = [
  ['mcp', 'MCP servers'],
  ['memory', 'Memory files'],
  ['skills', 'Skills & agents'],
]

// TW Monitor's settings as the panel names and explains them.
const USAGE_NAMES: Record<UsagePart, string> = { '5H': '5H', WK: 'WK', other: 'OTH' }
const MONITOR_USAGE_NAMES: Record<MonitorUsagePiece, string> = { bar: 'Bar', percent: 'Percentage', reset: 'Reset timer', rate: 'Burn rate' }
const MONITOR_CTX_NAMES: Record<MonitorCtxPiece, string> = { bar: 'Bar', percent: 'Percentage', tokens: 'Tokens' }
const MONITOR_TTL_NAMES: Record<MonitorTtlPiece, string> = { bar: 'Bar', timer: 'Timer', warm: 'Keep-warm' }
const MONITOR_NAME_NAMES: Record<MonitorName, string> = { folder: 'Folder', title: 'Title', both: 'Folder / title' }
const MONITOR_SORT_NAMES: Record<MonitorSort, string> = { name: 'Name', context: 'Context', expiry: 'Cache expiry', activity: 'Last activity' }
const MONITOR_FILTER_NAMES: Record<MonitorFilter, string> = { all: 'All', warm: 'Warm cache', recent: 'Recent' }
const MONITOR_FILTER_NOTES: Record<MonitorFilter, string> = {
  all: 'Every session running on this device.',
  warm: 'Sessions whose prompt cache is warm, or working.',
  recent: 'Sessions that answered within this time, or are running a turn.',
}
const MONITOR_CURRENT_NAMES: Record<MonitorCurrent, string> = { default: 'Default', top: 'On top' }
const MONITOR_CURRENT_NOTES: Record<MonitorCurrent, string> = {
  default: 'Pins, Hidden and Sort apply to it like any other session; Show never leaves it out.',
  top: 'Always listed first, and never hidden here.',
}

// Keep-warm's mode as TW Monitor notes it after a session's countdown, while
// keep-warm is on.
const MONITOR_WARM_NOTES: Record<WarmMode, string> = { pings: '(Ping)', notify: '(Notify)', both: '(Ping + Notify)' }

// Keep-warm's modes as the panel names and explains them.
const WARM_MODE_NAMES: Record<WarmMode, string> = { pings: 'Pings', notify: 'Notify', both: 'Both' }
const WARM_MODE_NOTES: Record<WarmMode, string> = {
  pings: 'Pings keep the cache warm while you are away; each ping uses tokens.',
  notify: 'No pings: a free notification before the cache expires. Stays on when you type.',
  both: 'Pings, and a notification before the first ping each time you go idle.',
}

// The settings panel's pane id, and its width when docked beside the transcript.
const SETTINGS = 'token-watch-settings'
const SETTINGS_TITLE = 'TW Settings'
const SETTINGS_COLUMNS = 52

// TW Monitor's pane id and width; its meters' cells and colours (the
// band's), and its lines' label, value and note columns.
const SESSIONS = 'token-watch-monitor'
const SESSIONS_TITLE = 'TW Monitor'
const SESSIONS_COLUMNS = 52
const SESSION_METER = 10
const SESSION_GLYPH = '\u2584'
const SESSION_TRACK = '#3d4250'
const SESSION_WARM = '#8fd18f'
const SESSION_COLD = '#e06c6c'
// A warm countdown's fill with keep-warm off: grey, lighter than the track.
const SESSION_IDLE = '#8a8f99'
const SESSION_LABEL_WIDTH = 3
// A heading's notes give way this many times faster than its title when the
// row is short.
const NOTES_SHRINK = 100

// TW Monitor's mark for this session, before its name: one cell everywhere,
// where ▶ may draw as an emoji.
const THIS_SESSION = '›'

// TW Monitor's marks on sessions and their store keys: pinned, and hidden
// (`hidden` is 1.3.0's parts, still read by the settings' migration).
const MARKS = { pinned: 'pinned', hidden: 'hiddenSessions' } as const
type Mark = keyof typeof MARKS

// "Clear all data": how many presses it takes, and within how long of the
// first.
const CLEAR_PRESSES = 10
const CLEAR_WINDOW_MS = 5_000
const NO_PRESSES = { count: 0, since: 0 }

// TW Monitor's sections that start closed.
const CLOSED_FIRST = new Set(['hidden'])

// The pin's column before a session's heading, at least: [ ] in a terminal;
// two cells on the desktop, a minimum the flag's Button widens as it needs
// (a fixed two clipped it).
const PIN_WIDTH_TERMINAL = 3
const PIN_WIDTH_DESKTOP = 2

// A piece of a closed section's summary: text in its colour (dim without
// one), or a short meter filled to a share.
type SummaryPart = { text: string; color?: string } | { meter: number; color: string }

// A closed session's meters, shorter than its lines'.
const SUMMARY_METER = 5

const SESSION_VALUE_WIDTH = 'No data'.length + 1
const SESSION_NOTE_WIDTH = '23h 59m'.length + 1

// The sessions button's label: a squared plus on the desktop; in a terminal
// "#", which every monospace font centres in its cell, as it does not \u229e.
const SESSIONS_MARK = '\u229e'
const SESSIONS_MARK_TERMINAL = '#'

// The settings button's label, a "menu" glyph: U+2630 on the desktop; in a
// terminal U+2261, since recent Unicode makes the trigram U+2630 two cells
// wide while fonts draw it in one, which leaves a gap before the bracket.
const MENU = '\u2630'
const MENU_TERMINAL = '\u2261'

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
// Each session's own file, for TW Monitor: a numbered slot in this
// folder, which a later session reuses once the one before it has ended or
// gone stale (no file is ever deleted), so the folder holds as many files as
// sessions ever ran at once.
const SESSIONS_PARTS = ['.claude', 'token-watch', 'sessions']
// Where Claude Code keeps the transcripts, read for sessions' titles; the
// most $.fs.read takes; and, for a larger transcript, git grep's pattern for
// a title (a JSON string, escapes and all) and how long it may take.
const PROJECTS_PARTS = ['.claude', 'projects']
const FS_READ_MAX = 4 * 1024 * 1024
const TITLE_PATTERN = '"type":"custom-title","customTitle":"(\\\\.|[^"])*"'
const GREP_TIMEOUT_MS = 10_000
// How soon a session whose transcript was not found is looked for again.
const TITLE_RETRY_MS = 2 * 60_000
const SLOT_NAME = /^session-(\d+)\.json$/
const HEARTBEAT_MS = 30_000
const SNAPSHOT_FRESH_MS = 120_000

// A session's end after which the process goes on under another session.
const CONTINUES = new Set<string>(['clear', 'resume', 'logout'])

// How often a session's own settings are saved again, so a session open for
// weeks is never pruned.
const TOUCH_EVERY_MS = 24 * 60 * 60_000

// The least a ping waits once armed.
const MIN_PING_WAIT_MS = 1_000

// Snapshot bookkeeping, the armed ping, and the ping this module has out
// (numbered, so a ping given up on can tell another has taken its place).
// Module variables: a hot reload loses them, which costs one extra write, and
// the heartbeat arms the ping again; `pingingSince` in $.state keeps a reload
// from sending a second ping while the first is out.
let snapshotOn = true
let snapshotPath: string | null = null
let lastWriteMs = 0
let lastKey = ''
// The sessions folder, this session's slot in it (found again after a
// reload by the id in it), the id it last wrote there, and that write.
let sessionsDir: string | null = null
let slotPath: string | null = null
let slotId: string | null = null
let lastSlotMs = 0
let lastSlotKey = ''
// Whether a person is at the prompt (a `claude -p` or SDK run writes no
// files), whether this session has ended (its file says so, and stays so),
// when its own settings were last saved again, and when a session's
// transcript was last looked for and not found.
let isInteractive = true
let hasEnded = false
let lastTouchMs = 0
const titleMisses = new Map<string, number>()
let pingTimer: Timer | null = null
let notifyTimer: Timer | null = null
let pingOut: { seq: number; sentAt: number } | null = null
let pingSeq = 0

export const register: Register = (on, options) => {
  // The plugin's `snapshot` option (/config): on unless set to false.
  snapshotOn = options.snapshot !== false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    isInteractive = e.isInteractive
    hasEnded = false
    // The clock first, so a step below that fails cannot leave the session
    // without its countdowns, its file and its settings' updates.
    $.clock.every(HEARTBEAT_MS, () => void tick($).then(() => heartbeat($)).catch(() => {}))
    await $.command.register({
      name: 'token-watch',
      description:
        'Show or hide the Token Watch banner above the prompt. "text" prints the reading, "file" the snapshot\'s path, "settings" opens TW Settings, "monitor" opens TW Monitor.',
      argumentHint: '[text|file|settings|monitor]',
    })
    const shown = await $.store.get('isShown')
    await update($, isShown, () => shown !== false)
    const restored = await restoreView($)
    await update($, view, () => restored)
    await tick($)
    await pruneSessionSettings($)
    await loadSettings($, true)
    lastTouchMs = await $.clock.now()
    await setMarks($, 'pinned', readMarks(await $.store.get(MARKS.pinned)))
    await setMarks($, 'hidden', readMarks(await $.store.get(MARKS.hidden)))
    await setTitles($, readTitleStore(await $.store.get('titles')))
    const keptHistory = readHistory(await $.store.get('history'))
    await update($, history, () => keptHistory)
    // A new session has no usage windows until its first response, so start
    // from the last ones seen; any whose reset time has passed is drawn at 0%,
    // and the first response replaces them.
    const saved = readLimits(await $.store.get('limits'))
    if (saved !== null) {
      await update($, limits, () => saved)
      const savedAt = await $.store.get('limitsAt')
      if (typeof savedAt === 'number') await update($, limitsAt, () => savedAt)
    }
    await resolvePaths($)
    const inputs = await readTtlInputs($)
    await update($, ttlInputs, () => inputs)
    await settleTtl($)
    // A start's reading counts as fresh only while no session has stamped
    // one (a new store, or 1.3.0's): it never puts older figures over newer.
    await takeReading($, (await read($, limitsAt)) === 0)
    // The ping timer is a module variable a hot reload drops, while
    // keep-warm's state lives in $.state: arm it again. Unless the TTL row is
    // now hidden (another session, sharing the store, hid it): then off.
    if ((await read($, keepWarm)).on) {
      if (isCacheHidden(await read($, settings))) {
        await stopKeepWarm($, null)
        await writeSnapshot($)
      } else {
        await schedule($)
      }
    }

    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    // The snapshot follows every reading, band or no band. A reading here
    // follows a response, so its windows are fresh: the store gets them too.
    if (snapshotOn || (await read($, isShown))) {
      await tick($)
      await takeReading($, true)
    }

    return result
  })

  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    // A subagent's or teammate's turn is not the main thread's, and its
    // turn.complete is not followed either.
    if (e.agentId) return result
    stopPingTimer()
    // A turn refreshes the cache: no reminder while it runs; its end arms
    // the next.
    stopNotifyTimer()
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
    // A reminder costs nothing and stays on: it is for the next idle spell.
    const isReminder = (await read($, settings)).warm.mode === 'notify'
    if (!BACKGROUND_ORIGINS.has(e.origin.kind) && !isReminder && (await read($, keepWarm)).on) {
      await stopKeepWarm($, null)
      await writeSnapshot($)
    }
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    // The conversation layer is replaced; the summarizer's request read the
    // prefix, so the layers that stay are warm from now. A precompute
    // replaces nothing: it only prepares the next compaction.
    if (!e.agentId && e.trigger !== 'precompute' && result.skip === undefined) {
      await tick($)
      if ((await read($, keepWarm)).on) await stopKeepWarm($, 'stopped: compaction')
      if ((await read($, cache)).lastResponseAt !== null) await rebase($)
    }
    return result
  })

  on('session.end', async ($, e, next) => {
    const result = await next(e)
    // Keep-warm belongs to the conversation that ended. After /clear, a resume
    // or a logout the process goes on under another session, whose cache this
    // one's countdown says nothing about.
    stopPingTimer()
    await update($, keepWarm, () => KEEP_WARM_OFF)
    if (CONTINUES.has(e.reason)) {
      await update($, cache, c => ({
        ...c,
        lastResponseAt: null,
        warmUntil: null,
        windowMs: TTL_MS[c.ttl],
        prefixTokens: null,
        confirmed: false,
      }))
      await settleTtl($)
      // Another session's id: its own settings, if it has any; and its
      // context, so the banner and the files stop showing the last one's.
      await loadSettings($, true)
      await takeReading($)
    } else {
      // The session is over (the process goes on only under another one,
      // which keeps the slot): its file says so first, within the hook's
      // budget, and stays so; the slot is free for the next.
      await writeSessionFile($, true, true)
      hasEnded = true
    }
    await writeSnapshot($)
    return result
  })

  on('command.run', { command: 'token-watch' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'file') {
      return { text: await snapshotStatus($) }
    }
    if (arg === 'settings' || arg === 'monitor') {
      const id = arg === 'settings' ? SETTINGS : SESSIONS
      const title = arg === 'settings' ? SETTINGS_TITLE : SESSIONS_TITLE
      const opened = arg === 'settings' ? await openSettings($) : await openSessions($)
      if (opened.isPlaced) return { text: `${title} opened.` }
      // Not placed: close it rather than leave it waiting, undrawn, for a
      // surface that would show it later unasked.
      await $.ui.close({ id }).catch(() => {})
      return { text: `${title}: the panel can't be shown here (${opened.reason}).` }
    }
    if (arg !== '' && arg !== 'text') {
      return { text: 'Usage: /token-watch [text|file|settings|monitor]' }
    }
    // The band draws on the terminal and the desktop app alone. Elsewhere
    // (the VS Code extension's chat panel, a headless run) a bare
    // /token-watch answers with the reading as one line instead of toggling
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
        cap: await currentCap($),
        warmMode: (await read($, settings)).warm.mode,
      })
      return { text: text || 'Token Watch: no reading yet.' }
    }

    const shown = !(await read($, isShown))
    await update($, isShown, () => shown)
    await $.store.set('isShown', shown)
    if (shown) {
      await takeReading($)
    }

    return { text: shown ? 'Token Watch banner shown.' : 'Token Watch banner hidden.' }
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

  // The settings panel. At the top, which settings it edits: this session's
  // own, which override the global ones leaf by leaf, or every session's.
  // Then collapsible sections: Usage (a section per window: in which views it
  // shows, and its pace's views, window and unit), Context, and Cache (its
  // views and keep-warm's caps for this session's TTL). A checkbox's or a
  // radio button's Button holds its mark and its label. A row this session
  // overrides has a reset in this session's scope, and a note in every
  // session's. A docked pane, so it stays beside the transcript while
  // the band changes under it.
  on('ui.render', { component: 'Pane', requestId: SETTINGS }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    // Every Button is plain on both surfaces (no native frame on the
    // desktop). A checkbox or a radio button is its mark and its label in one
    // Button, so a press on either toggles or picks it: ☑ / ☐ and ◉ / ○ on
    // the desktop, ● / ○ for both in a terminal (☑ may draw there as a wide
    // emoji). The rest are bracketed with no spaces: [▸] / [▾] for a section,
    // [-] / [+] for a stepper, [Enable], [reset]. The desktop's font is
    // proportional: its label columns keep a cell of slack.
    const isTerminal = e.surface === 'terminal'
    const wrap = (glyph: string) => `[${glyph}]`
    const mark = (isOn: boolean) => (isTerminal ? (isOn ? '\u25cf' : '\u25cb') : isOn ? '\u2611' : '\u2610')
    const choice = (isOn: boolean) => (isOn ? (isTerminal ? '\u25cf' : '\u25c9') : '\u25cb')
    const pick = (key: string, glyph: string, label: string, onPress: () => void) => (
      <Box key={key} flexShrink={0}>
        <Button key={key} plain onPress={onPress}>
          {`${glyph} ${label}`}
        </Button>
      </Box>
    )
    const checkbox = (key: string, label: string, isOn: boolean, onPress: () => void) => pick(key, mark(isOn), label, onPress)
    const radio = (key: string, label: string, isOn: boolean, onPress: () => void) => pick(key, choice(isOn), label, onPress)
    const isGlobal = await editsGlobal($)
    const isMonitor = (await read($, scope)) === 'monitor'
    const hasSession = (await sessionKey($)) !== null
    const pressed = await read($, clearPresses)
    const presses = (await read($, nowMs)) - pressed.since < CLEAR_WINDOW_MS ? pressed.count : 0
    const pinsNow = await read($, pinned)
    const hiddenNow = await read($, hiddenSessions)
    const own = await read($, override)
    // What each leaf reads in the scope shown.
    const shown = isGlobal ? await read($, globalSettings) : await read($, settings)
    const open = await read($, openSections)
    const ttl = (await read($, cache)).ttl
    const paceWidth = 'Window:'.length + (isTerminal ? 0 : 1)

    // A row's override marker: a reset in this session's scope, a note in
    // every session's.
    const marker = (path: Path) =>
      !overridesUnder(own, path) ? null : isGlobal ? (
        <Text key={`over-${path.join('-')}`} dimColor wrap="truncate">
          overridden in Session
        </Text>
      ) : (
        <Button key={`reset-${path.join('-')}`} plain dimColor onPress={() => void resetSetting($, path)}>
          {wrap('Reset')}
        </Button>
      )
    // A section's heading, which opens and closes it, and its body indented.
    // The heading is a plain Button on both surfaces (no native frame on the
    // desktop), [▾] / [▸] and the title, so a press anywhere on it toggles,
    // as in TW Monitor. A sub-section's title is not bold, and its
    // row's override marker follows the Button, so an override shows with
    // the section closed.
    const section = (id: string, title: string, body: () => unknown, options: { isSub?: true; extra?: unknown } = {}) => {
      const isOpen = open.includes(id)
      return (
        <Box key={id} flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            <Button key={`section-${id}`} plain onPress={() => void toggleSection($, id)}>
              {`[${isOpen ? '\u25be' : '\u25b8'}] `}
              <Text bold={!options.isSub || undefined}>{title}</Text>
            </Button>
            {(options.extra ?? null) as never}
          </Box>
          {isOpen && (
            <Box flexDirection="column" paddingLeft={2}>
              {body() as never}
            </Box>
          )}
        </Box>
      )
    }
    // The three views, each toggled on its own.
    const viewChoices = (path: Path, key: string) => (
      <Box flexDirection="row" columnGap={1} flexWrap="wrap">
        {VIEWS.map(v => {
          const isOn = getAt(shown, [...path, v]) === true
          return checkbox(`${key}-${v}`, VIEW_NAMES[v], isOn, () => void setSetting($, [...path, v], !isOn))
        })}
      </Box>
    )
    const views = (id: string, title: string, path: Path, key: string) =>
      section(id, title, () => viewChoices(path, key), { isSub: true, extra: marker(path) })
    // A part's alert level: [-]80%[+], 50% to 95% in steps of 5, then 99%,
    // then Off; off, the [-] becomes Enable (to 99%) and there is no [+].
    // A usage window's alert is every session's (the window is the account's),
    // so only every session's scope shows it.
    const alerts = (id: string, part: keyof typeof shown.alert) => {
      const isShared = isGlobalOnly(['alert', part])
      if (isShared && !isGlobal) return null
      const level = shown.alert[part]
      const step = (by: 1 | -1) => void setSetting($, ['alert', part], stepAlert(level, by))
      return section(
        id,
        'Alerts',
        () => (
          <Box flexDirection="row">
            {level === null ? (
              <Button key={`alert-${part}-enable`} plain onPress={() => step(-1)}>
                {wrap('Enable')}
              </Button>
            ) : (
              <Button key={`alert-${part}-down`} plain dimColor={level <= 50} onPress={() => step(-1)}>
                [-]
              </Button>
            )}
            <Text>{level === null ? 'Off' : `${level}%`}</Text>
            {level !== null && (
              <Button key={`alert-${part}-up`} plain onPress={() => step(1)}>
                [+]
              </Button>
            )}
          </Box>
        ),
        { isSub: true, extra: isShared ? null : marker(['alert', part]) },
      )
    }
    // A stepper: label, [-], value, [+], dimmed at the ends.
    const stepper = (key: string, title: string, width: number, value: string, atMin: boolean, atMax: boolean, by: (d: 1 | -1) => void, over: Path) => (
      <Box key={key} flexDirection="row" columnGap={1}>
        <Box width={width} flexShrink={0}>
          <Text>{title}</Text>
        </Box>
        <Button key={`${key}-down`} plain dimColor={atMin} onPress={() => by(-1)}>
          [-]
        </Button>
        <Text>{value}</Text>
        <Button key={`${key}-up`} plain dimColor={atMax} onPress={() => by(1)}>
          [+]
        </Button>
        {marker(over)}
      </Box>
    )
    const usage = (part: UsagePart, name: string) => {
      const pace = shown.pace[part]
      const windows = PACE_WINDOWS[part]
      const id = `usage-${part}`
      return section(id, name, () => (
        <Box flexDirection="column">
          {views(`${id}-show`, 'Show on banner', ['show', part], `show-${part}`)}
          {alerts(`${id}-alert`, part)}
          {section(
            `${id}-pace`,
            'Burn rate',
            () => (
              <Box flexDirection="column">
                {viewChoices(['pace', part, 'show'], `pace-${part}`)}
                {stepper(
                  `window-${part}`,
                  'Window:',
                  paceWidth,
                  windowText(pace.windowMin),
                  pace.windowMin <= windows[0]!,
                  pace.windowMin >= windows[windows.length - 1]!,
                  by => void setSetting($, ['pace', part, 'windowMin'], stepIn(windows, pace.windowMin, by)),
                  ['pace', part, 'windowMin'],
                )}
                <Box flexDirection="row" columnGap={1}>
                  <Box width={paceWidth} flexShrink={0}>
                    <Text>Unit:</Text>
                  </Box>
                  {PACE_UNITS[part].map(unit =>
                    radio(`unit-${part}-${unit}`, `%/${unit}`, pace.unit === unit, () => void setSetting($, ['pace', part, 'unit'], unit)),
                  )}
                  {marker(['pace', part, 'unit'])}
                </Box>
              </Box>
            ),
            { isSub: true, extra: marker(['pace', part, 'show']) },
          )}
          {views(`${id}-forecast`, 'Burn forecast', ['pace', part, 'forecast'], `forecast-${part}`)}
        </Box>
      ))
    }
    // The Monitor view: TW Monitor's settings, the same in every session (no
    // session has its own), in collapsible rows; then the pins' and hidden
    // sessions' resets.
    const mon = shown.monitor
    const groupWidth = 'TTL:'.length + (isTerminal ? 0 : 1)
    const choices = <T extends string>(key: string, list: T[], names: Record<T, string>, at: T, pick: (value: T) => void) => (
      <Box flexDirection="row" columnGap={1} flexWrap="wrap">
        {list.map(value => radio(`${key}-${value}`, names[value], at === value, () => pick(value)))}
      </Box>
    )
    const note = (text: string) => (
      <Text dimColor wrap="wrap">
        {text}
      </Text>
    )
    // A group's pieces as checkboxes, after its label where it has one.
    const pieces = <T extends string>(key: string, label: string | null, list: T[], names: Record<T, string>, values: Record<T, boolean>, path: Path) => (
      <Box key={key} flexDirection="row" columnGap={1}>
        {label !== null && (
          <Box width={groupWidth} flexShrink={0}>
            <Text>{label}</Text>
          </Box>
        )}
        <Box flexDirection="row" columnGap={1} flexWrap="wrap" flexShrink={1} minWidth={0}>
          {list.map(piece => checkbox(`${key}-${piece}`, names[piece], values[piece], () => void setSetting($, [...path, piece], !values[piece])))}
        </Box>
      </Box>
    )
    const monitorView = () => (
      <Box flexDirection="column" rowGap={1}>
        {section('monitor-usage', 'Usage', () => (
          <Box flexDirection="column">
            {USAGE_PARTS.map(part =>
              section(
                `monitor-usage-${part}`,
                USAGE_NAMES[part],
                () => pieces(`monitor-usage-${part}`, null, MONITOR_USAGE_PIECES, MONITOR_USAGE_NAMES, mon.usage[part], ['monitor', 'usage', part]),
                { isSub: true },
              ),
            )}
            {note('A window with nothing ticked is left out, and Usage too when every window is.')}
          </Box>
        ))}
        {section('monitor-lines', 'Session lines', () => (
          <Box flexDirection="column">
            {MONITOR_STATES.map(state =>
              section(
                `monitor-lines-${state}`,
                state === 'expanded' ? 'Expanded' : 'Collapsed',
                () => (
                  <Box flexDirection="column">
                    {pieces(`monitor-lines-${state}-ctx`, 'CTX:', MONITOR_CTX_PIECES, MONITOR_CTX_NAMES, mon.lines[state].ctx, ['monitor', 'lines', state, 'ctx'])}
                    {pieces(`monitor-lines-${state}-ttl`, 'TTL:', MONITOR_TTL_PIECES, MONITOR_TTL_NAMES, mon.lines[state].ttl, ['monitor', 'lines', state, 'ttl'])}
                  </Box>
                ),
                { isSub: true },
              ),
            )}
            {note('A line with nothing on is left out.')}
          </Box>
        ))}
        {section('monitor-name', 'Name', () => (
          <Box flexDirection="column">
            {choices('monitor-name', MONITOR_NAMES, MONITOR_NAME_NAMES, mon.name, value =>
              void setSetting($, ['monitor', 'name'], value).then(() => (value === 'folder' ? undefined : rereadTitles($))),
            )}
            {note('A title is read from its session\'s transcript when the session is listed, and again for every session when Title or Folder / title is pressed. A session without one shows its folder.')}
          </Box>
        ))}
        {section('monitor-sort', 'Sort', () => (
          <Box flexDirection="column">
            {choices('monitor-sort', MONITOR_SORTS, MONITOR_SORT_NAMES, mon.sort, value => void setSetting($, ['monitor', 'sort'], value))}
            {note('Pinned sessions always come first.')}
          </Box>
        ))}
        {section('monitor-filter', 'Show', () => (
          <Box flexDirection="column">
            {choices('monitor-filter', MONITOR_FILTERS, MONITOR_FILTER_NAMES, mon.filter, value => void setSetting($, ['monitor', 'filter'], value))}
            {mon.filter === 'recent' &&
              stepper(
                'recent',
                'Within:',
                paceWidth,
                recentText(mon.recentMin),
                mon.recentMin <= RECENT_STEPS[0]!,
                mon.recentMin >= RECENT_STEPS[RECENT_STEPS.length - 1]!,
                by => void setSetting($, ['monitor', 'recentMin'], stepIn(RECENT_STEPS, mon.recentMin, by)),
                ['monitor', 'recentMin'],
              )}
            {note(MONITOR_FILTER_NOTES[mon.filter])}
          </Box>
        ))}
        {section('monitor-current', 'Current session', () => (
          <Box flexDirection="column">
            {choices('monitor-current', MONITOR_CURRENT, MONITOR_CURRENT_NAMES, mon.current, value => void setSetting($, ['monitor', 'current'], value))}
            {note(MONITOR_CURRENT_NOTES[mon.current])}
          </Box>
        ))}
      </Box>
    )
    // Under the settings, each dim with nothing to undo: in this session's
    // view, its own settings back to the global ones; in the global view,
    // those back to the defaults; in the Monitor view, TW Monitor's back to
    // the defaults, and every pin and hidden session undone.
    const resets = () => (
      <Box flexDirection="row" columnGap={1} flexWrap="wrap">
        {isMonitor ? (
          <Button key="reset-monitor" plain dimColor={JSON.stringify(mon) === JSON.stringify(DEFAULT_SETTINGS.monitor) || undefined} onPress={() => void resetMonitor($)}>
            {wrap('Reset to default')}
          </Button>
        ) : isGlobal ? (
          <Button key="reset-defaults" plain dimColor={isDefault(shown) || undefined} onPress={() => void resetDefaults($)}>
            {wrap('Reset to defaults')}
          </Button>
        ) : (
          <Button key="reset-session" plain dimColor={isEmptyOverride(own) || undefined} onPress={() => void resetSession($)}>
            {wrap('Reset to global')}
          </Button>
        )}
        {isMonitor && (
          <Button key="unpin-all" plain dimColor={Object.keys(pinsNow).length === 0 || undefined} onPress={() => void clearMarks($, 'pinned')}>
            {wrap('Unpin all sessions')}
          </Button>
        )}
        {isMonitor && (
          <Button key="restore-all" plain dimColor={Object.keys(hiddenNow).length === 0 || undefined} onPress={() => void clearMarks($, 'hidden')}>
            {wrap('Unhide all sessions')}
          </Button>
        )}
      </Box>
    )
    // Below everything in the global view: Clear all data, which takes
    // CLEAR_PRESSES presses within CLEAR_WINDOW_MS, counting them down, so
    // one press by mistake clears nothing. The note under it says so (no
    // tooltips for a Button).
    const left = CLEAR_PRESSES - presses
    const clear = () => (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Button key="clear-all" plain onPress={() => void pressClear($)}>
            {presses === 0 ? wrap('Clear all data') : <Text color={SESSION_COLD}>{wrap(`Clear all data: ${left} more`)}</Text>}
          </Button>
        </Box>
        <Text dimColor wrap="wrap">
          {`Press ${CLEAR_PRESSES} times within ${CLEAR_WINDOW_MS / 1000} seconds to delete everything Token Watch has stored: settings, pins, hidden sessions, titles and usage history. Its files in ~/.claude/token-watch stay; turn them off with Usage snapshot files in /config.`}
        </Text>
      </Box>
    )
    return (
      <Box flexDirection="column" rowGap={1} paddingX={1}>
        {/* Which settings the panel shows: this session's own (where it has
            a session), every session's, or TW Monitor's. */}
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={1} flexWrap="wrap">
            {hasSession && radio('scope-session', 'Session', !isGlobal && !isMonitor, () => void setScope($, 'session'))}
            {radio('scope-global', 'Global', isGlobal && !isMonitor, () => void setScope($, 'global'))}
            {radio('scope-monitor', 'Monitor', isMonitor, () => void setScope($, 'monitor'))}
          </Box>
          <Text dimColor wrap="wrap">
            {isMonitor
              ? 'Changes apply to TW Monitor in every session.'
              : isGlobal
                ? 'Changes apply to every session, except where one has its own setting.'
                : 'Changes apply to this session only, over Global. Usage alerts are set in Global.'}
          </Text>
        </Box>
        {isMonitor && monitorView()}
        {!isMonitor && section('usage', 'Usage', () => (
          <Box flexDirection="column">
            {usage('5H', '5H')}
            {usage('WK', 'WK')}
            {usage('other', 'OTH')}
          </Box>
        ))}
        {!isMonitor && section('context', 'Context', () => (
          <Box flexDirection="column">
            {views('context-show', 'Show on banner', ['show', 'CTX'], 'show-CTX')}
            {alerts('context-alert', 'CTX')}
            {section(
              'context-details',
              'Details',
              () => (
                <Box flexDirection="column">
                  <Box flexDirection="row" columnGap={1} flexWrap="wrap">
                    {DETAILS.map(([which, name]) => {
                      const isOn = shown.details[which]
                      return checkbox(`details-${which}`, name, isOn, () => void setSetting($, ['details', which], !isOn))
                    })}
                  </Box>
                  <Text dimColor wrap="wrap">
                    Shown under the legend in the Expanded view.
                  </Text>
                </Box>
              ),
              { isSub: true, extra: marker(['details']) },
            )}
          </Box>
        ))}
        {!isMonitor && section('cache', 'Cache time', () => (
          <Box flexDirection="column">
            {section(
              'cache-show',
              'Show on banner',
              () => (
                <Box flexDirection="column">
                  {viewChoices(['show', 'TTL'], 'show-TTL')}
                  <Text dimColor wrap="wrap">
                    Hiding it in every view turns keep-warm off.
                  </Text>
                </Box>
              ),
              { isSub: true, extra: marker(['show', 'TTL']) },
            )}
            {section(
              'cache-warm',
              'Keep-warm',
              () => (
                <Box flexDirection="column">
                  <Box flexDirection="row" columnGap={1} flexWrap="wrap">
                    {WARM_MODES.map(mode =>
                      radio(`warm-${mode}`, WARM_MODE_NAMES[mode], shown.warm.mode === mode, () => void setSetting($, ['warm', 'mode'], mode)),
                    )}
                  </Box>
                  <Text dimColor wrap="wrap">
                    {WARM_MODE_NOTES[shown.warm.mode]}
                  </Text>
                  {shown.warm.mode !== 'pings' &&
                    stepper(
                      'lead',
                      'Remind:',
                      paceWidth,
                      `${shown.warm.lead[ttl]} min before`,
                      shown.warm.lead[ttl] <= NOTIFY_LEADS[ttl][0]!,
                      shown.warm.lead[ttl] >= NOTIFY_LEADS[ttl][NOTIFY_LEADS[ttl].length - 1]!,
                      by => void setSetting($, ['warm', 'lead', ttl], stepIn(NOTIFY_LEADS[ttl], shown.warm.lead[ttl], by)),
                      ['warm', 'lead', ttl],
                    )}
                </Box>
              ),
              { isSub: true, extra: marker(['warm']) },
            )}
            {section(
              'cache-limits',
              `Limits (${ttl} TTL)`,
              () => (
                <Box flexDirection="column">
                  {(['pings', 'hours'] as const).map(which => {
                    const value = shown.caps[ttl][which]
                    const { min, max, step } = CAP_LIMITS[ttl][which]
                    return stepper(
                      which,
                      which === 'pings' ? 'Pings:' : 'Hours:',
                      paceWidth,
                      String(value),
                      value <= min,
                      value >= max,
                      by => void setSetting($, ['caps', ttl, which], Math.min(max, Math.max(min, value + by * step))),
                      ['caps', ttl, which],
                    )
                  })}
                  <Text dimColor wrap="wrap">
                    {`Defaults: ${DEFAULT_CAPS[ttl].pings} pings or ${DEFAULT_CAPS[ttl].hours} hours. Caps apply to pings, not reminders; a running keep-warm past a new cap stops.`}
                  </Text>
                </Box>
              ),
              { isSub: true, extra: marker(['caps', ttl]) },
            )}
          </Box>
        ))}
        {resets()}
        <Text dimColor wrap="wrap">
          {isMonitor
            ? '/token-watch monitor opens TW Monitor; /token-watch settings opens this panel again.'
            : 'A burn rate is averaged over its window once that holds 5 minutes of readings. /token-watch settings opens this panel again.'}
        </Text>
        {isGlobal && !isMonitor && clear()}
      </Box>
    )
  })

  // TW Monitor: the usage windows on top, then every live session on this
  // device (its file written in the last two minutes, and not ended), this
  // one with its own figures as they stand (first, by the Current session
  // setting), each with its name, its context and its prompt cache's
  // countdown, as the Monitor settings pick. The others' files are read when
  // the panel opens, every 30 s while it is open, and on its refresh.
  on('ui.render', { component: 'Pane', requestId: SESSIONS }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const isTerminal = e.surface === 'terminal'
    const closed = await read($, sessionsClosed)
    // A section: its heading, which opens and closes it, and its body
    // indented under it. The heading is a plain Button (no native frame on
    // the desktop either), [▾] / [▸] and the title, so a press anywhere on it
    // toggles; what is said about it (this session, working) follows, dim.
    // Closed, the heading keeps a summary of what it holds: its figures in
    // their colours, as the band shows them, the rest dim. Options: `lead`
    // before the heading (a session's pin), `actions` at the row's right edge
    // (its hide), and the body's `indent`.
    const fold = (
      id: string,
      title: string,
      notes: string[],
      summary: SummaryPart[],
      body: () => unknown,
      options: { lead?: unknown; actions?: unknown; indent?: number } = {},
    ) => {
      const { lead = null, actions = null, indent = 2 } = options
      // A section is open until toggled, Hidden closed until toggled.
      const isOpen = closed.includes(id) === CLOSED_FIRST.has(id)
      const glyph = isOpen ? '\u25be' : '\u25b8'
      return (
        <Box key={id} flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            {/* The lead against the heading on the desktop, where the flag's
                Button brings its own room; a cell between in a terminal. */}
            <Box flexDirection="row" columnGap={isTerminal ? 1 : 0} flexShrink={1} minWidth={0}>
              {lead as never}
              {/* The glyph bracketed on both surfaces, so it reads as a button
                  at rest too. */}
              <Box flexShrink={1} minWidth={0}>
                <Button key={`fold-${id}`} plain onPress={() => void toggleFold($, id)}>
                  {`[${glyph}] `}
                  <Text bold>{title}</Text>
                </Button>
              </Box>
            </Box>
            {/* One line, cut at the edge, and cut before the title is. */}
            {notes.length > 0 && (
              <Box flexShrink={NOTES_SHRINK} minWidth={0}>
                <Text dimColor wrap="truncate">
                  {notes.join(' · ')}
                </Text>
              </Box>
            )}
            {!isOpen &&
              (summary.some(part => 'meter' in part) ? (
                <Box flexDirection="row" flexShrink={1} minWidth={0}>
                  {summary.map((part, n) =>
                    'meter' in part ? (
                      <Box key={String(n)} flexShrink={0}>
                        {meter(part.meter, part.color, SUMMARY_METER)}
                      </Box>
                    ) : (
                      <Text key={String(n)} color={part.color} dimColor={part.color === undefined || undefined} wrap="truncate">
                        {part.text}
                      </Text>
                    ),
                  )}
                </Box>
              ) : (
                <Box flexShrink={1} minWidth={0}>
                  <Text wrap="truncate">
                    {summary.map((part, n) =>
                      'meter' in part ? null : (
                        <Text key={String(n)} color={part.color} dimColor={part.color === undefined || undefined}>
                          {part.text}
                        </Text>
                      ),
                    )}
                  </Text>
                </Box>
              ))}
            {/* No fragment: the engine lays a fragment's children out as a
                column. */}
            {actions !== null && <Box flexGrow={1} />}
            {actions as never}
          </Box>
          {isOpen && (
            <Box flexDirection="column" paddingLeft={indent}>
              {body() as never}
            </Box>
          )}
        </Box>
      )
    }
    // The line between the usage and the sessions: a run of box-drawing
    // lines in a terminal, a hairline on the desktop.
    const rule = () =>
      isTerminal ? (
        <Text key="rule" color={SESSION_TRACK} wrap="truncate">
          {'\u2500'.repeat(Math.max(1, e.props.bodyColumns - 2))}
        </Text>
      ) : (
        <Box key="rule" flexDirection="row" height={1} alignItems="center">
          <Box flexGrow={1} height="10%" backgroundColor={SESSION_TRACK} />
        </Box>
      )
    const now = await read($, nowMs)
    const m = (await read($, settings)).monitor
    const own = await sessionSnapshotOf($, now, null)
    const names = await read($, titles)
    const pins = await read($, pinned)
    const hides = await read($, hiddenSessions)
    const isPinned = (s: SessionSnapshot) => s.session.id !== null && s.session.id in pins
    const isHidden = (s: SessionSnapshot) => s.session.id !== null && s.session.id in hides
    // A session's name by the Name setting: its folder, its title (else its
    // folder), or both.
    const nameOf = (s: SessionSnapshot) => {
      const folder = folderOf(projectOf(s))
      const title = s.session.id === null ? null : (names[s.session.id] ?? null)
      if (m.name === 'title') return title ?? folder
      if (m.name === 'both' && title !== null) return `${folder} / ${title}`
      return folder
    }
    // When a session's cache expires: the whole TTL on while a turn runs;
    // null when cold or unknown.
    const expiresOf = (s: SessionSnapshot) => {
      if (s.isWorking) return now + TTL_MS[s.cache.ttl]
      const at = s.cache.expiresAt === null ? NaN : Date.parse(s.cache.expiresAt)
      return Number.isNaN(at) || at <= now ? null : at
    }
    // When it last answered: now while a turn runs; null before its first.
    const activeOf = (s: SessionSnapshot) => {
      if (s.isWorking) return now
      const at = s.lastActiveAt ? Date.parse(s.lastActiveAt) : NaN
      return Number.isNaN(at) ? null : at
    }
    // Which sessions the Show setting lists: all; those with a warm cache; or
    // those that answered within its time.
    const isListed = (s: SessionSnapshot) => {
      if (m.filter === 'warm') return expiresOf(s) !== null
      if (m.filter === 'recent') {
        const at = activeOf(s)
        return at !== null && now - at <= m.recentMin * 60_000
      }
      return true
    }
    // The Sort setting's order: by name; by context, fullest first; by when
    // the cache expires, soonest first; or by last activity, latest first.
    // Without the figure, last; the name breaks ties. Pinned ones first.
    const keyOf = (s: SessionSnapshot): number | null => {
      if (m.sort === 'context') return s.context === null ? null : -s.context.percent
      if (m.sort === 'expiry') return expiresOf(s)
      if (m.sort === 'activity') {
        const at = activeOf(s)
        return at === null ? null : -at
      }
      return 0
    }
    const group = (list: SessionSnapshot[]) => {
      const ordered = [...list].sort((a, b) => {
        const ka = keyOf(a)
        const kb = keyOf(b)
        const byKey = ka === kb ? 0 : ka === null ? 1 : kb === null ? -1 : ka - kb
        return byKey || nameOf(a).localeCompare(nameOf(b)) || (a.session.id ?? '').localeCompare(b.session.id ?? '')
      })
      return [...ordered.filter(isPinned), ...ordered.filter(s => !isPinned(s))]
    }
    // This session on top (by the Current session setting), never hidden
    // here, whatever the filter: hiding it hides it from the other sessions'
    // panels. Or as any other: by the pins, Hidden and the order, though
    // always listed, the filter aside.
    const others = await read($, sessions)
    const isOnTop = m.current === 'top'
    const pool = (isOnTop ? others : [own, ...others]).filter(s => s === own || isListed(s))
    const all = isOnTop ? [own, ...group(pool.filter(s => !isHidden(s)))] : group(pool.filter(s => !isHidden(s)))
    const tucked = group(pool.filter(isHidden))
    const everyone = [...all, ...tucked]
    // A session's pin, before its heading where the indent under Sessions
    // was, dim until pinned: a flag, ⚐ / ⚑, on the desktop, one shape
    // outlined and filled, whose font gives [ ] and [*] different widths;
    // [ ] / [*] in a terminal, where they match. Its column keeps its width
    // with no id to pin by, so the headings line up; a minimum, so a font
    // that draws the flag wider widens it rather than clipping it.
    const pinWidth = isTerminal ? PIN_WIDTH_TERMINAL : PIN_WIDTH_DESKTOP
    const pin = (s: SessionSnapshot) => {
      const id = s.session.id
      const isOn = id !== null && id in pins
      return (
        <Box minWidth={pinWidth} flexShrink={0}>
          {id !== null && (
            <Button key={`pin-${id}`} plain dimColor={!isOn || undefined} onPress={() => void toggleMark($, 'pinned', id)}>
              {isTerminal ? (isOn ? '[*]' : '[ ]') : isOn ? '⚑' : '⚐'}
            </Button>
          )}
        </Box>
      )
    }
    // Its hide, at the row's right edge, dim: × dismisses it to Hidden, ↺
    // restores it to Sessions; bracketed in a terminal, as the pin is. This
    // session has one too.
    const hide = (s: SessionSnapshot) => {
      const id = s.session.id
      if (id === null) return null
      const glyph = id in hides ? '↺' : '×'
      return (
        <Box flexShrink={0}>
          <Button key={`hide-${id}`} plain dimColor onPress={() => void toggleMark($, 'hidden', id)}>
            {isTerminal ? `[${glyph}]` : glyph}
          </Button>
        </Box>
      )
    }
    // The panel's refresh, at its first heading's right edge, dim: the
    // sessions' files read again now, rather than at the next 30 s tick.
    const refresh = (
      <Box flexShrink={0}>
        <Button key="refresh" plain dimColor onPress={() => void refreshMonitor($)}>
          {isTerminal ? '[↻]' : '↻'}
        </Button>
      </Box>
    )
    const windows = sorted(current(await read($, limits), now))
    const pace = await paceOf($, windows, now)
    // The usage windows the Usage setting leaves something on for; with
    // none, no Usage section, and no line under it.
    const usageOf = (w: Limit) => m.usage[partOf(w)]
    const shownWindows = windows.filter(w => Object.values(usageOf(w)).some(Boolean))
    const hasUsage = shownWindows.length > 0
    // The desktop's font is proportional: two cells of slack, as the band keeps.
    const labelWidth = SESSION_LABEL_WIDTH + (isTerminal ? 0 : 2)
    // A name two sessions share is told apart by the session's id.
    const labels = everyone.map(nameOf)
    const meter = (fraction: number, color: string, cells = SESSION_METER) => {
      const filled = Math.round(Math.min(1, Math.max(0, fraction)) * cells)
      if (isTerminal) {
        return (
          <Box flexDirection="row" flexShrink={0}>
            <Text color={color}>{SESSION_GLYPH.repeat(filled)}</Text>
            <Text color={SESSION_TRACK}>{SESSION_GLYPH.repeat(cells - filled)}</Text>
          </Box>
        )
      }
      return (
        <Box flexDirection="row" width={cells} height={1} alignItems="center" flexShrink={0}>
          {filled > 0 && <Box width={filled} height="60%" backgroundColor={color} />}
          {filled < cells && <Box width={cells - filled} height="60%" backgroundColor={SESSION_TRACK} />}
        </Box>
      )
    }
    // A figure's line, in columns that line up from one session to the
    // next: label, meter (unless `hasMeter` is false), value (unless
    // `hasValue` is), note. A usage window's line adds its burn rate after
    // the note, which then keeps a column of its own: green while the window
    // resets before it fills, red once it would fill first.
    const line = (
      title: string,
      fraction: number,
      fill: string,
      value: string,
      color: string | undefined,
      note: string | null,
      rate: { text: string; color: string } | null = null,
      hasMeter = true,
      hasValue = true,
    ) => (
      <Box key={title} flexDirection="row" columnGap={1}>
        <Box width={labelWidth} flexShrink={0}>
          <Text dimColor wrap="truncate">
            {title}
          </Text>
        </Box>
        {hasMeter && meter(fraction, fill)}
        {hasValue && (
          <Box width={SESSION_VALUE_WIDTH + (isTerminal ? 0 : 1)} flexShrink={0}>
            <Text color={color} dimColor={color === undefined || undefined} wrap="truncate">
              {value}
            </Text>
          </Box>
        )}
        {note !== null && (
          <Box {...(rate === null ? { flexShrink: 1, minWidth: 0 } : { width: SESSION_NOTE_WIDTH + (isTerminal ? 0 : 1), flexShrink: 0 })}>
            <Text dimColor wrap="truncate">
              {note}
            </Text>
          </Box>
        )}
        {rate !== null && (
          <Box flexShrink={1} minWidth={0}>
            <Text color={rate.color} wrap="truncate">
              {rate.text}
            </Text>
          </Box>
        )}
      </Box>
    )
    const row = (s: SessionSnapshot, i: number) => {
      const name = labels[i]!
      const isShared = labels.filter(l => l === name).length > 1
      const ttlMs = TTL_MS[s.cache.ttl]
      const expires = s.cache.expiresAt === null ? null : Date.parse(s.cache.expiresAt)
      // A turn running refreshes the cache with each request: the whole TTL.
      const left = s.isWorking ? ttlMs : expires === null ? null : expires - now
      const ttlText = left === null ? 'No data' : left <= 0 ? 'Cold' : duration(left)
      // The countdown red with no data or once cold, else green while
      // keep-warm runs and grey without (its meter's fill a light grey).
      const ttlColor = left === null || left <= 0 ? SESSION_COLD : s.cache.keepWarm.on ? SESSION_WARM : undefined
      const tokens = s.context === null ? null : `${short(s.context.total)} / ${short(s.context.window)}`
      const warmNote = s.cache.keepWarm.on ? MONITOR_WARM_NOTES[s.cache.keepWarm.mode] : null
      // Closed: what the Session lines setting picks for a closed session,
      // the figures in their colours: a group's label, then the pieces on, a
      // space between; nothing for a group with none.
      const shut = m.lines.collapsed
      const summaryOf = (title: string, pieces: SummaryPart[][]) => {
        const lit = pieces.filter(piece => piece.length > 0)
        return lit.length === 0 ? [] : [{ text: `${title} ` }, ...lit.flatMap((piece, n) => (n > 0 ? [{ text: ' ' }, ...piece] : piece))]
      }
      const ctxParts: SummaryPart[] =
        s.context === null
          ? []
          : summaryOf('CTX', [
              shut.ctx.bar ? [{ meter: s.context.percent / 100, color: levelColor(s.context.percent) }] : [],
              shut.ctx.percent ? [{ text: `${s.context.percent}%`, color: levelColor(s.context.percent) }] : [],
              shut.ctx.tokens && tokens !== null ? [{ text: tokens }] : [],
            ])
      const ttlParts: SummaryPart[] = summaryOf('TTL', [
        shut.ttl.bar ? [{ meter: left === null ? 0 : left / ttlMs, color: ttlColor ?? SESSION_IDLE }] : [],
        shut.ttl.timer ? [{ text: ttlText, color: ttlColor }] : [],
        shut.ttl.warm && warmNote !== null ? [{ text: warmNote }] : [],
      ])
      const summary = [...ctxParts, ...(ctxParts.length > 0 && ttlParts.length > 0 ? [{ text: ' · ' }] : []), ...ttlParts]
      const notes = [
        isShared && s.session.id !== null ? s.session.id.slice(0, 8) : null,
        s.isWorking ? 'working' : null,
      ].filter((note): note is string => note !== null)
      // Open: the lines the Session lines setting picks for an open session;
      // a line with none of its pieces on left out.
      const open = m.lines.expanded
      const hasCtx = Object.values(open.ctx).some(Boolean)
      const hasTtl = Object.values(open.ttl).some(Boolean)
      return fold(
        `session-${s.session.id ?? i}`,
        // This session is marked by a › before its name.
        s === own ? `${THIS_SESSION} ${name}` : name,
        notes,
        summary,
        () =>
          [
            hasCtx &&
              line(
                'CTX',
                s.context === null ? 0 : s.context.percent / 100,
                s.context === null ? SESSION_TRACK : levelColor(s.context.percent),
                s.context === null ? 'No data' : `${s.context.percent}%`,
                s.context === null ? undefined : levelColor(s.context.percent),
                open.ctx.tokens ? tokens : null,
                null,
                open.ctx.bar,
                open.ctx.percent,
              ),
            hasTtl &&
              line(
                'TTL',
                left === null ? 0 : left / ttlMs,
                ttlColor ?? SESSION_IDLE,
                ttlText,
                ttlColor,
                open.ttl.warm ? warmNote : null,
                null,
                open.ttl.bar,
                open.ttl.timer,
              ),
          ].filter(Boolean),
        // Its lines indented under its heading, past the pin's column.
        { lead: pin(s), actions: hide(s), indent: pinWidth + (isTerminal ? 1 : 0) + 2 },
      )
    }
    const usageRate = (w: Limit) => {
      const p = pace.windows[w.kind]
      return p ? { text: rateText(p.perHour, p.unit), color: p.fullAt === null ? SESSION_WARM : SESSION_COLD } : null
    }
    return (
      <Box flexDirection="column" rowGap={1} paddingX={1}>
        {/* The usage windows are the account's, the same in every session:
            once, on top, each with what the Usage setting picks of its bar,
            percentage, time until it resets and burn rate. */}
        {hasUsage &&
          fold(
            'usage',
            'Usage',
            [],
            shownWindows.flatMap((w, n) => [
              { text: `${n > 0 ? ' · ' : ''}${label(w)} ` },
              { text: `${Math.round(w.percentUsed)}%`, color: levelColor(w.percentUsed) },
            ]),
            () =>
              shownWindows.map(w => {
                const u = usageOf(w)
                return line(
                  label(w),
                  w.percentUsed / 100,
                  levelColor(w.percentUsed),
                  `${Math.round(w.percentUsed)}%`,
                  levelColor(w.percentUsed),
                  u.reset ? countdown(w.resetsAt, now) || null : null,
                  u.rate ? usageRate(w) : null,
                  u.bar,
                  u.percent,
                )
              }),
            { actions: refresh },
          )}
        {hasUsage && rule()}
        {/* Not indented: each session's pin takes the indent's place. */}
        {fold(
          'sessions',
          'Sessions',
          [],
          [{ text: `${all.length}` }],
          () => (
            <Box flexDirection="column" rowGap={1}>
              {all.map(row)}
            </Box>
          ),
          { indent: 0, ...(hasUsage ? {} : { actions: refresh }) },
        )}
        {/* The sessions dismissed out of the way, under Sessions: closed at
            first, and there with none in it too. */}
        {fold(
          'hidden',
          'Hidden',
          [],
          [{ text: `${tucked.length}` }],
          () =>
            tucked.length === 0 ? (
              <Box paddingLeft={2}>
                <Text dimColor wrap="wrap">
                  No hidden sessions. × on a session moves it here.
                </Text>
              </Box>
            ) : (
              <Box flexDirection="column" rowGap={1}>
                {tucked.map((s, n) => row(s, all.length + n))}
              </Box>
            ),
          { indent: 0 },
        )}
        <Text dimColor wrap="wrap">
          {sessionsDir === null
            ? 'Other sessions are not shown while Usage snapshot files is off in /config.'
            : others.length === 0
              ? 'No other sessions on this device. Checked every 30 seconds.'
              : 'Sessions on this device, checked every 30 seconds. /token-watch monitor opens this panel again.'}
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, reading)
    if (e.props.hasSurvey || now === null || !(await read($, isShown))) {
      return next(e)
    }

    // The band holds one drawing, so whatever the plugins beneath draw there
    // (another mod's hint) stacks above this band instead of being replaced.
    const below = await next(e)
    // The band is a Client, which only the terminal and the desktop app draw.
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return below
    const { Box, Button, Client, Text } = $.ui.resolve(e)
    const clock = await read($, nowMs)
    const inForce = await read($, settings)
    const windows = current(await read($, limits), clock)
    const bandView = await read($, view)
    const off = hiddenIn(inForce, bandView)
    const k = await read($, keepWarm)
    const props: BandProps = {
      reading: now,
      limits: windows,
      nowMs: clock,
      view: bandView,
      isWorking: e.props.isWorking || (await read($, working)),
      cache: await read($, cache),
      keepWarm: k,
      surface: e.surface,
      hidden: off,
      paceHidden: paceHiddenIn(inForce, bandView),
      forecastHidden: forecastHiddenIn(inForce, bandView),
      cap: await currentCap($),
      warmMode: inForce.warm.mode,
      details: inForce.details,
      pace: await paceOf($, windows, clock),
    }

    // The settings button sits outside the band, beside it: a press on a
    // Button inside a Client reaches the hooks module as a message, which the
    // engine does not count as the person's own, and an unasked pane opens
    // only on a terminal 144 columns wide. Drawn in the expanded view; in a
    // collapsed one with every part hidden, where it is the way back; and
    // wherever keep-warm runs in a view that hides the cache, marked (●) so
    // the pings are never wholly out of sight.
    const nothingShown = windows.every(w => off.includes(partOf(w))) && off.includes('CTX') && off.includes('TTL')
    const isWarmUnseen = k.on && off.includes('TTL')
    const hasMenu = bandView === 'expanded' || nothingShown || isWarmUnseen
    const menuMark = isWarmUnseen ? (e.surface === 'terminal' ? '\u25cf' : ' \u25cf') : ''
    return (
      <Box flexDirection="column">
        {below}
        <Box flexDirection="row" columnGap={1}>
          <Box flexGrow={1} minWidth={0}>
            <Client key="band" module="./band.tsx" props={props} width="100%" />
          </Box>
          {/* On the band's second line, under the terminal's [-] (which sits in
              a margin no mod draws in), bracketed like it with no spaces: the
              terminal's own "[ label ]" would be twice as wide. The desktop
              draws its native button around the glyph. */}
          {hasMenu && (
            <Box flexDirection="column" flexShrink={0}>
              <Text> </Text>
              <Button key="settings" plain onPress={() => void openSettings($)}>
                {e.surface === 'terminal' ? `[${MENU_TERMINAL}${menuMark}]` : `${MENU}${menuMark}`}
              </Button>
              {bandView === 'expanded' && (
                <Button key="sessions" plain onPress={() => void openSessions($)}>
                  {e.surface === 'terminal' ? `[${SESSIONS_MARK_TERMINAL}]` : SESSIONS_MARK}
                </Button>
              )}
            </Box>
          )}
        </Box>
      </Box>
    )
  })
}

// A reading: the context, and the usage windows. Claude Code reports the
// windows a session's own last response carried, so they are only as new as
// that response. A reading that follows one (`isFresh`, session.measure)
// replaces the windows, here and in the store with its time, for every
// session to pick up (the heartbeat); any other (a start, /token-watch)
// fills them only while there are none, and leaves the store alone, so it
// never puts older figures over newer ones.
async function takeReading($: EngineInterface, isFresh = false) {
  try {
    const { context, rateLimits } = await $.session.usage({ breakdown: 'summary' })
    if (rateLimits.length > 0 && (isFresh || (await read($, limits)).length === 0)) {
      const reported: Limit[] = rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt }))
      // A window the reading leaves out keeps its last values until its reset
      // time; one still left out after that is no longer part of the plan.
      const now = await $.clock.now()
      const kept = (await read($, limits)).filter(
        w => !reported.some(r => r.kind === w.kind) && !!w.resetsAt && Date.parse(w.resetsAt) > now,
      )
      const windows = [...reported, ...kept]
      await update($, limits, () => windows)
      if (isFresh) {
        await update($, limitsAt, () => now)
        await $.store.set('limits', windows)
        await $.store.set('limitsAt', now)
        // Read the store's samples first: another session may have added some.
        const before = readHistory(await $.store.get('history'))
        const after = addReadings(before, reported, now)
        await update($, history, () => after)
        if (after !== before) await $.store.set('history', after)
      }
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
        details: detailsOf(breakdown),
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
  await checkAlerts($)
  await writeSnapshot($)
}

// The context's details from a breakdown: the loaded MCP tools' tokens
// summed by server and the memory files' by name (the file's own name, never
// its path), largest first; the skills and the agents.
function detailsOf(breakdown: {
  mcpTools: readonly { serverName: string; tokens: number; isLoaded: boolean }[]
  memoryFiles: readonly { path: string; tokens: number }[]
  skills?: { includedSkills: number; totalSkills: number; tokens: number }
  agents: readonly { tokens: number }[]
}): ContextDetails {
  const servers = new Map<string, number>()
  for (const tool of breakdown.mcpTools) {
    if (tool.isLoaded) servers.set(tool.serverName, (servers.get(tool.serverName) ?? 0) + tool.tokens)
  }
  const byTokens = (a: { tokens: number }, b: { tokens: number }) => b.tokens - a.tokens
  return {
    mcp: [...servers].map(([name, tokens]) => ({ name, tokens })).sort(byTokens),
    memory: breakdown.memoryFiles
      .map(file => ({ name: file.path.split(/[\\/]/).pop() || file.path, tokens: file.tokens }))
      .sort(byTokens),
    skills: breakdown.skills
      ? { included: breakdown.skills.includedSkills, total: breakdown.skills.totalSkills, tokens: breakdown.skills.tokens }
      : null,
    agents: { count: breakdown.agents.length, tokens: breakdown.agents.reduce((n, agent) => n + agent.tokens, 0) },
  }
}

async function tick($: EngineInterface) {
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
async function restoreView($: EngineInterface): Promise<View> {
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
// honours and the promptCacheTtl setting. Nothing else of the environment or
// the settings is read or kept.
async function readTtlInputs($: EngineInterface): Promise<TtlInputs> {
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
    const setting = await $.settings.read({ key: 'promptCacheTtl' })
    inputs.settingTtl = isTtl(setting) ? setting : null
  } catch {
    // No settings: the defaults stand.
  }
  return inputs
}

// The TTL as the controls and the plan say it is now.
async function settleTtl($: EngineInterface) {
  const inputs = await read($, ttlInputs)
  const c = await read($, cache)
  const now = await read($, nowMs)
  const { ttl, ttlSource } = resolveTtl(inputs, current(await read($, limits), now), c.confirmed)
  if (ttl !== c.ttl || ttlSource !== c.ttlSource) {
    await update($, cache, cc => ({ ...cc, ttl, ttlSource }))
  }
}

// A main-thread request was just served: the countdown restarts from now.
async function rebase($: EngineInterface) {
  const now = await read($, nowMs)
  await update($, cache, c => ({ ...c, lastResponseAt: now, warmUntil: now + TTL_MS[c.ttl], windowMs: TTL_MS[c.ttl] }))
}

// The settings panel, docked beside the transcript where the surface docks
// panes (opened inline where it does not).
async function openSettings($: EngineInterface) {
  return $.ui.open({ id: SETTINGS, title: SETTINGS_TITLE, columns: SETTINGS_COLUMNS })
}

// TW Monitor, docked like the settings panel; then the other
// sessions' files read. The open comes first: only an open that answers the
// person's press or command at once counts as theirs, and a terminal places
// one that does not only from 144 columns.
async function openSessions($: EngineInterface) {
  const opened = $.ui.open({ id: SESSIONS, title: SESSIONS_TITLE, columns: SESSIONS_COLUMNS })
  await readSessions($)
  return opened
}

// Keep-warm's caps in force: the settings panel's, for this session's TTL.
async function currentCap($: EngineInterface) {
  return caps((await read($, cache)).ttl, (await read($, settings)).caps)
}

// Why keep-warm has reached its caps, as its stop note says it, or null.
function capReached(k: KeepWarm, cap: Cap, now: number) {
  if (k.pings >= cap.pings) return `stopped: ${cap.pings} pings`
  if (k.startedAt !== null && now - k.startedAt >= cap.ms) return `stopped: ${hmmss(cap.ms)} reached`
  return null
}

// The store key of this session's own settings, or null with no session id.
async function sessionKey($: EngineInterface) {
  const id = await $.session.id().catch(() => null)
  return id ? `session:${id}` : null
}

// The settings read back from the store: the global tree (1.3.0's keys read
// once into it where it has not been saved yet) and this session's own. Each
// is put in place, and the settings in force worked out again, only when
// something changed, so the band redraws and keep-warm is held to them only
// then. `touch` (a session's start) applies them whatever, and saves this
// session's own again to keep them from being pruned.
async function loadSettings($: EngineInterface, touch = false) {
  const nextGlobal = await storedGlobal($)
  const key = await sessionKey($)
  const kept = key === null ? undefined : ((await $.store.get(key)) as { settings?: unknown } | undefined)
  const nextOwn = readOverride(kept?.settings)
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  let isChanged = false
  if (!same(await read($, globalSettings), nextGlobal)) {
    await update($, globalSettings, () => nextGlobal)
    isChanged = true
  }
  if (!same(await read($, override), nextOwn)) {
    await update($, override, () => nextOwn)
    isChanged = true
  }
  if (touch && key !== null && !isEmptyOverride(nextOwn)) await saveOverride($, nextOwn)
  if (isChanged || touch) await applySettings($)
}

// The global settings as the store holds them now (1.3.0's keys read into
// a tree where none is saved yet). A change is made over these, not over
// this session's copy, which can be a heartbeat old: so it never puts back
// what another session changed meanwhile.
async function storedGlobal($: EngineInterface) {
  const saved = await $.store.get('settings')
  return saved === undefined ? fromLegacy(await $.store.get('hidden'), await $.store.get('caps')) : readSettings(saved)
}

// The settings in force, the session's leaves over the global ones; then
// keep-warm held to them: off while no view shows the cache, stopped when
// its mode changed under it, stopped if past its caps.
async function applySettings($: EngineInterface) {
  const before = await read($, settings)
  const next = merge(await read($, globalSettings), await read($, override))
  if (JSON.stringify(before) !== JSON.stringify(next)) await update($, settings, () => next)
  if (isCacheHidden(next) && (await read($, keepWarm)).on) await stopKeepWarm($, null)
  // Keep-warm runs in the mode it was turned on in: a reminder left on for
  // hours never turns into pings because the mode changed, here or in
  // another session.
  if (before.warm.mode !== next.warm.mode && (await read($, keepWarm)).on) await stopKeepWarm($, 'stopped: mode changed')
  await holdToCaps($)
  // A mode or a lead that changed arms the timers again.
  if ((await read($, keepWarm)).on) await schedule($)
}

// This session's own settings saved under its id, with when, so ones left by
// sessions long gone can be pruned; none left, the key is removed.
async function saveOverride($: EngineInterface, next: SettingsOverride) {
  await update($, override, () => next)
  const key = await sessionKey($)
  if (key === null) return
  if (isEmptyOverride(next)) await $.store.delete(key)
  else await $.store.set(key, { settings: next, seenAt: await $.clock.now() })
}

// Session settings not saved for SESSION_SETTINGS_KEEP_MS, and any that do
// not read as settings, are removed.
async function pruneSessionSettings($: EngineInterface) {
  try {
    const now = await $.clock.now()
    for (const key of await $.store.keys()) {
      if (!key.startsWith('session:')) continue
      const seenAt = ((await $.store.get(key)) as { seenAt?: unknown } | null)?.seenAt
      if (typeof seenAt !== 'number' || now - seenAt > SESSION_SETTINGS_KEEP_MS) await $.store.delete(key)
    }
  } catch {
    // Pruned next time.
  }
}

// Whether the panel edits the global settings: chosen so, or with no session
// id to keep a session's own under.
async function editsGlobal($: EngineInterface) {
  return (await read($, scope)) === 'global' || (await sessionKey($)) === null
}

async function setScope($: EngineInterface, next: Scope) {
  await update($, scope, () => next)
}

// A session pinned or unpinned, hidden or shown again, in TW Monitor, for
// every session's.
async function toggleMark($: EngineInterface, mark: Mark, id: string) {
  const now = await $.clock.now()
  const kept = readMarks(await $.store.get(MARKS[mark]))
  const { [id]: was, ...rest } = kept
  const next = was === undefined ? { ...kept, [id]: now } : rest
  await $.store.set(MARKS[mark], next)
  await setMarks($, mark, next)
}

// A mark's ids put in place. Each atom by name: the engine's scan reads an
// update's atom only where it is written out.
async function setMarks($: EngineInterface, mark: Mark, next: Record<string, number>) {
  if (mark === 'pinned') {
    if (JSON.stringify(next) !== JSON.stringify(await read($, pinned))) await update($, pinned, () => next)
  } else if (JSON.stringify(next) !== JSON.stringify(await read($, hiddenSessions))) {
    await update($, hiddenSessions, () => next)
  }
}

// Every session unpinned, or every hidden one restored.
async function clearMarks($: EngineInterface, mark: Mark) {
  await $.store.set(MARKS[mark], {})
  await setMarks($, mark, {})
}

// "Clear all data" pressed: one more press counted, the count starting
// over CLEAR_WINDOW_MS after the first; the last of CLEAR_PRESSES clears.
async function pressClear($: EngineInterface) {
  const now = await $.clock.now()
  const was = await read($, clearPresses)
  // Counted from the first press's time, which a reload keeps (its timer it
  // does not), so presses spread out never add up to a clear.
  const isOn = now - was.since < CLEAR_WINDOW_MS
  const next = { count: isOn ? was.count + 1 : 1, since: isOn ? was.since : now }
  if (next.count >= CLEAR_PRESSES) return clearAll($)
  if (next.count === 1) $.clock.after(CLEAR_WINDOW_MS, () => void update($, clearPresses, () => NO_PRESSES).catch(() => {}))
  await update($, clearPresses, () => next)
}

// TW Monitor's settings back to the defaults, for every session.
async function resetMonitor($: EngineInterface) {
  const next = setAt(await storedGlobal($), ['monitor'], DEFAULT_SETTINGS.monitor)
  await update($, globalSettings, () => next)
  await $.store.set('settings', next)
  await applySettings($)
}

// Every key in the store deleted: the settings (the global ones and every
// session's own), the pins, hidden sessions and titles, the usage windows'
// history and alert records, the view and whether the band shows. As a fresh
// install; the other sessions take the defaults at their next 30 s tick. The
// sessions' files stay (nothing can delete them) and go stale on their own.
async function clearAll($: EngineInterface) {
  for (const key of await $.store.keys()) await $.store.delete(key)
  await update($, clearPresses, () => NO_PRESSES)
  await setMarks($, 'pinned', {})
  await setMarks($, 'hidden', {})
  await setTitles($, {})
  await update($, history, () => ({}))
  await update($, ctxAlerted, () => [])
  await update($, view, () => 'expanded')
  await update($, isShown, () => true)
  await loadSettings($)
}

// A mark as the store keeps it: ids and when each was set.
function readMarks(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null) return {}
  return Object.fromEntries(Object.entries(value).filter(([, at]) => typeof at === 'number')) as Record<string, number>
}

// TW Monitor's refresh: this session's figures and the other sessions' files
// read again now. Titles are not: they are read when a session is listed.
async function refreshMonitor($: EngineInterface) {
  await tick($)
  await readSessions($)
}

// TW Monitor's section that opens or closes: open at first, save the ones in
// CLOSED_FIRST, for which the list holds the ones opened.
async function toggleFold($: EngineInterface, id: string) {
  await update($, sessionsClosed, closed => (closed.includes(id) ? closed.filter(s => s !== id) : [...closed, id]))
}

async function toggleSection($: EngineInterface, id: string) {
  await update($, openSections, open => (open.includes(id) ? open.filter(s => s !== id) : [...open, id]))
}

// One leaf set in the scope the panel edits, or in the global settings for a
// leaf only they hold. In this session's scope, a leaf set to the global
// value no longer overrides it.
async function setSetting($: EngineInterface, path: Path, value: unknown) {
  const global = await storedGlobal($)
  if (isGlobalOnly(path) || (await editsGlobal($))) {
    const next = setAt(global, path, value)
    await update($, globalSettings, () => next)
    await $.store.set('settings', next)
  } else {
    const own = await read($, override)
    await saveOverride($, getAt(global, path) === value ? dropAt(own, path) : setAt(own, path, value))
  }
  await applySettings($)
}

// Every setting of this session's own cleared: the settings for all sessions
// again, throughout.
async function resetSession($: EngineInterface) {
  await saveOverride($, {})
  await applySettings($)
}

// A row's leaves back to the global settings in this session.
async function resetSetting($: EngineInterface, path: Path) {
  await saveOverride($, dropAt(await read($, override), path))
  await applySettings($)
}

// Every session's settings back to the defaults (the button drawn in every
// session's scope); a session's own settings stay over them.
async function resetDefaults($: EngineInterface) {
  if (!(await editsGlobal($))) return
  // TW Monitor's settings are the Monitor view's to reset.
  const next = { ...DEFAULT_SETTINGS, monitor: (await storedGlobal($)).monitor }
  await update($, globalSettings, () => next)
  await $.store.set('settings', next)
  await applySettings($)
}

// Whether the settings are the defaults, TW Monitor's aside.
function isDefault(tree: SettingsTree) {
  return JSON.stringify({ ...tree, monitor: null }) === JSON.stringify({ ...DEFAULT_SETTINGS, monitor: null })
}

// The pace the band shows, now: each window's rate over its part's window,
// when it fills, and the unit its part prints it in.
async function paceOf($: EngineInterface, windows: Limit[], now: number): Promise<Pace> {
  const inForce = await read($, settings)
  const h = await read($, history)
  const pace: Pace = { windows: {} }
  for (const w of windows) {
    // A window whose reset time has passed has started over: its samples are
    // the last period's, and say nothing until a reading starts the new one.
    const kept = h[w.kind]
    if (kept?.resetsAt && Date.parse(kept.resetsAt) <= now) continue
    const { windowMin, unit } = inForce.pace[partOf(w)]
    const perHour = ratePerHour(kept?.samples ?? [], now, windowMin * 60_000)
    if (perHour !== null) pace.windows[w.kind] = { perHour, fullAt: fullAt(w.percentUsed, perHour, now, w.resetsAt), unit }
  }
  return pace
}

// Keep-warm held to the caps in force: a running keep-warm already past them
// stops now, saying why, rather than showing "7/5" until its next ping.
async function holdToCaps($: EngineInterface) {
  const k = await read($, keepWarm)
  if (k.on && (await read($, settings)).warm.mode !== 'notify') {
    await tick($)
    const reached = capReached(k, await currentCap($), await read($, nowMs))
    if (reached !== null) await stopKeepWarm($, reached)
  }
  await writeSnapshot($)
}

// Either button: keep-warm on, when there is a warm cache to keep (or a turn
// is making one), else off. Pressed with nothing warm to keep, a note says so.
// Not while the TTL row is hidden (a press from a band drawn before it was).
async function toggleKeepWarm($: EngineInterface) {
  if (isCacheHidden(await read($, settings))) return
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
      await update($, keepWarm, kw => ({ ...kw, note: { at: now, text: 'keep-warm: the cache is already lost' } }))
    } else {
      await update($, keepWarm, () => ({ ...KEEP_WARM_OFF, on: true, startedAt: now }))
      await schedule($)
    }
  }
  await writeSnapshot($)
}

// Refresh caps: keep-warm starts its pings and its time over from now, as
// if just turned on, without a ping or a gap in the schedule. Only while it is on.
async function refreshCaps($: EngineInterface) {
  await tick($)
  const now = await read($, nowMs)
  if (!(await read($, keepWarm)).on) return
  await update($, keepWarm, kw => ({ ...kw, pings: 0, failures: 0, startedAt: now, note: null }))
  await writeSnapshot($)
}

// Keep-warm off, with a note the band shows for a minute when there is a
// reason to give.
async function stopKeepWarm($: EngineInterface, text: string | null) {
  stopPingTimer()
  stopNotifyTimer()
  const now = await read($, nowMs)
  await update($, keepWarm, k => ({ ...k, on: false, note: text === null ? null : { at: now, text } }))
}

function stopPingTimer() {
  pingTimer?.cancel()
  pingTimer = null
}

function stopNotifyTimer() {
  notifyTimer?.cancel()
  notifyTimer = null
}

// Arms the next ping, unless one is out (its answer arms the next).
async function schedule($: EngineInterface) {
  stopPingTimer()
  if (await isPingOut($, await $.clock.now())) return
  await arm($)
}

// Arms the next ping, a lead time before the believed expiry, and the
// reminder by the mode: in Notify, the reminder alone, its lead before the
// expiry; in Both, the ping and, before the first ping of an idle spell, the
// reminder its lead before that. Nothing is armed while keep-warm is off,
// before the first response, while a turn runs (its end arms it) or once the
// cache has gone cold (the heartbeat then turns keep-warm off, save a
// reminder, which waits for the next response).
async function arm($: EngineInterface) {
  stopPingTimer()
  stopNotifyTimer()
  const k = await read($, keepWarm)
  const c = await read($, cache)
  if (!k.on || c.warmUntil === null || (await read($, working))) return
  const inForce = await read($, settings)
  if (isCacheHidden(inForce)) {
    await stopKeepWarm($, null)
    return await writeSnapshot($)
  }
  const now = await $.clock.now()
  if (now >= c.warmUntil) return
  const { mode } = inForce.warm
  const lead = inForce.warm.lead[c.ttl] * 60_000
  if (mode === 'notify') {
    if (k.notifiedFor !== c.warmUntil) {
      notifyTimer = $.clock.after(Math.max(MIN_PING_WAIT_MS, c.warmUntil - lead - now), () => void remind($))
    }
    return
  }
  const pingAt = c.warmUntil - leadMs(c.windowMs)
  pingTimer = $.clock.after(Math.max(MIN_PING_WAIT_MS, pingAt - now), () => void ping($))
  const isFirstOfSpell = k.lastPing === null || (c.lastResponseAt !== null && k.lastPing.at < c.lastResponseAt)
  if (mode === 'both' && isFirstOfSpell && k.notifiedFor !== c.lastResponseAt && pingAt - lead > now) {
    notifyTimer = $.clock.after(pingAt - lead - now, () => void remind($))
  }
}

// The reminder: in Notify, the countdown is about to run out; in Both, a
// ping is about to go out. One notification, and noted against what it was
// for, so it is not sent again.
async function remind($: EngineInterface) {
  notifyTimer = null
  try {
    const k = await read($, keepWarm)
    const c = await read($, cache)
    const mode = (await read($, settings)).warm.mode
    if (!k.on || c.warmUntil === null || mode === 'pings') return
    await tick($)
    const now = await read($, nowMs)
    const text =
      mode === 'notify'
        ? `The prompt cache expires in ${duration(c.warmUntil - now)}. Send a message to keep it warm.`
        : `Token Watch pings in ${duration(c.warmUntil - leadMs(c.windowMs) - now)} to keep the prompt cache warm, unless you send a message first.`
    await $.ui.notify(text, { title: 'Token Watch' }).catch(() => null)
    const notifiedFor = mode === 'notify' ? c.warmUntil : c.lastResponseAt
    await update($, keepWarm, kw => ({ ...kw, notifiedFor, note: { at: now, text: 'reminder sent' } }))
  } catch {
    // Nothing to show; the next countdown arms another.
  }
}

// Whether a ping is out and not yet given up on (after PING_LOST_MS): this
// module's own, or the one the module a reload replaced sent.
async function isPingOut($: EngineInterface, now: number) {
  if (isOwnPingOut(now)) return true
  const since = await read($, pingingSince)
  return since !== null && now - since < PING_LOST_MS
}

function isOwnPingOut(now: number) {
  return pingOut !== null && now - pingOut.sentAt < PING_LOST_MS
}

// One ping: the caps checked, the fork sent, its counts shown, the countdown
// moved on and the next ping armed; or keep-warm stopped, saying why. Only one
// is ever out: a ping claims `pingOut` right after its last check, with no
// await between, and holds it until it has finished. One unanswered after
// PING_LOST_MS is given up on, and its late answer is ignored if another has
// taken its place.
async function ping($: EngineInterface) {
  pingTimer = null
  const claimedAt = await $.clock.now()
  if ((await isPingOut($, claimedAt)) || isOwnPingOut(claimedAt)) return
  const seq = ++pingSeq
  pingOut = { seq, sentAt: claimedAt }
  const isMine = () => pingOut?.seq === seq
  try {
    const k = await read($, keepWarm)
    const c = await read($, cache)
    if (!k.on || c.warmUntil === null || (await read($, working))) return
    if ((await read($, settings)).warm.mode === 'notify') return
    await tick($)
    const sentAt = await read($, nowMs)
    // While the TTL row is hidden keep-warm stays off: however it came to be
    // on (another session hid the row, a press raced the toggle), it stops here.
    if (isCacheHidden(await read($, settings))) return await stopKeepWarm($, null)
    if (sentAt >= c.warmUntil) return await stopKeepWarm($, 'stopped: cache lost')
    const reached = capReached(k, caps(c.ttl, (await read($, settings)).caps), sentAt)
    if (reached !== null) return await stopKeepWarm($, reached)

    let result: ModelForkResult | null = null
    let thrown = ''
    await update($, pingingSince, () => sentAt)
    try {
      result = await $.model.fork({ prompt: PING_PROMPT })
    } catch (err) {
      // A fork that throws is a failed ping like any other.
      thrown = String(err).slice(0, 120)
    }
    // Given up on, and another ping has taken its place: that one decides.
    if (!isMine()) return

    await tick($)
    const now = await read($, nowMs)
    if (!(await read($, keepWarm)).on) return
    if (result === null) return await pingFailed($, thrown, now)
    // An empty reply was still served from the cache: its counts tell as much
    // as an answer's.
    if (result.isAnswered || result.reason === 'empty-reply') {
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
        // The cache was already cold: the ping paid to re-cache the prefix,
        // and the next one would too. Stop, and show the cache as cold.
        // A response during the ping (a background turn) has rebased the
        // countdown since: that one stands.
        await update($, cache, cc => (cc.lastResponseAt !== null && cc.lastResponseAt > sentAt ? cc : { ...cc, warmUntil: sentAt }))
        await stopKeepWarm($, 'stopped: the ping found the cache lost')
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
        // This ping still holds `pingOut`, so it arms the next directly.
        await arm($)
      }
    } else if (result.reason === 'nothing-to-fork') {
      await stopKeepWarm($, 'stopped: nothing cached yet')
    } else {
      await pingFailed($, result.reason === 'api-error' ? result.error : result.reason, now)
    }
  } catch {
    // Something failed around the fork; the heartbeat arms the next ping.
  } finally {
    if (isMine()) {
      pingOut = null
      await update($, pingingSince, () => null).catch(() => {})
    }
    await writeSnapshot($)
  }
}

// A failed ping: counted on keep-warm as it is now (Refresh Caps, or turning
// keep-warm off and on, may have cleared the count while the ping was out),
// shown, and keep-warm stopped after MAX_FAILURES in a row, else retried after
// RETRY_MS.
async function pingFailed($: EngineInterface, why: string, now: number) {
  await update($, keepWarm, kw => ({ ...kw, failures: kw.failures + 1, note: { at: now, text: `ping failed: ${why}` } }))
  if ((await read($, keepWarm)).failures >= MAX_FAILURES) {
    return await stopKeepWarm($, `stopped: ${MAX_FAILURES} pings failed in a row`)
  }
  stopPingTimer()
  pingTimer = $.clock.after(RETRY_MS, () => void ping($))
}

// Where the snapshot and the sessions' files go: nowhere with the snapshot
// option off, nor in a run nobody is at the prompt for (`claude -p`, the
// SDK), which would take usage.json over and fill TW Monitor. Worked out
// again each tick, so an option changed mid-session is followed.
async function resolvePaths($: EngineInterface) {
  if (!snapshotOn || !isInteractive) {
    snapshotPath = null
    sessionsDir = null
    return
  }
  snapshotPath ??= await homePath($, SNAPSHOT_PARTS)
  sessionsDir ??= await homePath($, SESSIONS_PARTS)
}

// A path under the home directory, such as the snapshot's,
// ~/.claude/token-watch/usage.json: `~` is USERPROFILE (Windows) or else
// HOME, the choice Node's os.homedir() makes, so the companion finds it. The
// path is joined with the home directory's own separator: backslashes if it
// has any, else slashes. Null when neither variable is set.
async function homePath($: EngineInterface, parts: string[]) {
  try {
    const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
    if (!home) return null
    return joinPath(home.replace(/[\\/]+$/, ''), ...parts)
  } catch {
    return null
  }
}

// Joined with the first part's own separator, as homePath joins.
function joinPath(first: string, ...rest: string[]) {
  return [first, ...rest].join(first.includes('\\') ? '\\' : '/')
}

// Where a session's name comes from: its project root, which a shell `cd`
// does not move (the directory it is in does); a file written before the
// root was kept has only that directory.
function projectOf(s: SessionSnapshot) {
  return s.session.root ?? s.session.cwd
}

// The last folder of a path: the session's folder, as the panel names it.
function folderOf(cwd: string | null) {
  return cwd?.split(/[\\/]/).filter(Boolean).pop() ?? 'unknown folder'
}

// This session as its file says it: its folder, its context and its cache.
async function sessionSnapshotOf($: EngineInterface, now: number, endedAt: string | null): Promise<SessionSnapshot> {
  const latest = await read($, reading)
  const c = await read($, cache)
  const k = await read($, keepWarm)
  const iso = (ms: number) => new Date(ms).toISOString()
  return {
    schema: 1,
    writtenAt: iso(now),
    endedAt,
    session: {
      id: await $.session.id().catch(() => null),
      cwd: await $.session.cwd().catch(() => null),
      root: await $.session.root().catch(() => null),
    },
    isWorking: await read($, working),
    lastActiveAt: c.lastResponseAt === null ? null : iso(c.lastResponseAt),
    context:
      latest === null
        ? null
        : { total: latest.total, window: latest.window, percent: Math.round((latest.total / latest.window) * 100) },
    cache: {
      ttl: c.ttl,
      expiresAt: c.warmUntil === null ? null : iso(c.warmUntil),
      warm: c.warmUntil !== null && now < c.warmUntil,
      keepWarm: { on: k.on, mode: (await read($, settings)).warm.mode },
    },
  }
}

// The titles TW Monitor can name sessions by, read from their transcripts:
// the last "custom-title" line Claude Code writes in a session's transcript
// when it is named or renamed. Those lines are Claude Code's own, not a
// documented interface: a title not found is null, and the session goes by
// its folder. Read only while the Name setting uses titles, and then only for
// a session with none stored (one just listed); or, `force` (the Title or
// Folder / title button pressed), for every session listed. Kept in the
// store, for every session's panel.
async function readTitles($: EngineInterface, list: SessionSnapshot[], force = false) {
  try {
    if (!force && (await read($, settings)).monitor.name === 'folder') return
    const now = await $.clock.now()
    const saved = readTitleStore(await $.store.get('titles'))
    let next = saved
    for (const s of list) {
      const id = s.session.id
      if (id === null || (!force && (id in saved || now - (titleMisses.get(id) ?? -Infinity) < TITLE_RETRY_MS))) continue
      // No transcript yet (a session listed before its first prompt): none
      // stored, and looked for again when the session is next listed, at
      // most every TITLE_RETRY_MS.
      const path = await findTranscript($, id, [s.session.root, s.session.cwd])
      if (path === null) {
        titleMisses.set(id, now)
        continue
      }
      titleMisses.delete(id)
      const title = await transcriptTitle($, path)
      next = { ...next, [id]: { title, at: now } }
    }
    if (next !== saved) await $.store.set('titles', next)
    await setTitles($, next)
  } catch {
    // Read again when the next session is listed.
  }
}

// Every listed session's title read again: the Title or Folder / title
// button pressed.
async function rereadTitles($: EngineInterface) {
  // The other sessions read first: TW Monitor may not have been open.
  await readSessions($, false)
  const own = await sessionSnapshotOf($, await $.clock.now(), null)
  await readTitles($, [own, ...(await read($, sessions))], true)
}

// A transcript's last title. $.fs.read takes a file of FS_READ_MAX at most,
// and a long session's transcript runs past it: such a file is searched with
// `git grep`, which prints only the title lines, whatever the file's size
// (no shell; where git is missing or finds none, null). Run from the
// transcript's folder, since git grep --no-index searches only under the
// directory it runs in.
async function transcriptTitle($: EngineInterface, path: string) {
  const stat = await $.fs.stat(path).catch(() => null)
  if (stat === null) return null
  if (stat.size <= FS_READ_MAX) return titleIn(await $.fs.read(path).catch(() => ''))
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const found = await $.process
    .run(['git', 'grep', '--no-index', '--no-color', '-h', '-o', '-E', '-e', TITLE_PATTERN, '--', path.slice(cut + 1)], {
      cwd: path.slice(0, cut),
      timeoutMs: GREP_TIMEOUT_MS,
    })
    .catch(() => null)
  if (found === null || found.exitCode !== 0) return null
  return titleIn(found.stdout.trim().split('\n').at(-1) ?? '')
}

// The last title in a transcript's text, or null.
function titleIn(text: string) {
  const at = text.lastIndexOf('"type":"custom-title"')
  if (at < 0) return null
  const quoted = /"customTitle":("(?:[^"\\]|\\.)*")/.exec(text.slice(at, at + 4_000))?.[1]
  if (!quoted) return null
  return (JSON.parse(quoted) as string).trim() || null
}

// The titles as the store keeps them: by session id, each with when it was
// read.
function readTitleStore(value: unknown): Record<string, { title: string | null; at: number }> {
  if (typeof value !== 'object' || value === null) return {}
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      const e = entry as { title?: unknown; at?: unknown } | null
      return typeof e?.at === 'number' && (e.title === null || typeof e.title === 'string')
    }),
  ) as Record<string, { title: string | null; at: number }>
}

// The titles put in place, by id.
async function setTitles($: EngineInterface, saved: Record<string, { title: string | null; at: number }>) {
  const next = Object.fromEntries(Object.entries(saved).map(([id, e]) => [id, e.title]))
  if (JSON.stringify(next) !== JSON.stringify(await read($, titles))) await update($, titles, () => next)
}

// A session's transcript, ~/.claude/projects/<folder>/<id>.jsonl: the folder
// is the project's path with every character but letters and digits as "-";
// tried for the session's root and its directory, else looked for in every
// project's folder. Null where none has it.
async function findTranscript($: EngineInterface, id: string, dirs: (string | null | undefined)[]) {
  // Under CLAUDE_CONFIG_DIR where it is set, as Claude Code keeps them.
  const config = await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)
  const projects = config ? joinPath(config.replace(/[\\/]+$/, ''), 'projects') : await homePath($, PROJECTS_PARTS)
  if (projects === null) return null
  const has = (path: string) => $.fs.exists(path).catch(() => false)
  const folders = dirs.filter((p): p is string => typeof p === 'string').map(p => p.replace(/[^a-zA-Z0-9]/g, '-'))
  for (const folder of folders) {
    const path = joinPath(projects, folder, `${id}.jsonl`)
    if (await has(path)) return path
  }
  for (const entry of await $.fs.list(projects).catch(() => [])) {
    if (entry.kind !== 'dir') continue
    const path = joinPath(projects, entry.name, `${id}.jsonl`)
    if (await has(path)) return path
  }
  return null
}

// A session's file read back, or null for one torn mid-write or of another
// shape.
function readSessionSnapshot(text: string): SessionSnapshot | null {
  try {
    const s = JSON.parse(text) as SessionSnapshot
    const isText = (v: unknown) => v === null || v === undefined || typeof v === 'string'
    const c = s?.context
    const isSession =
      s?.schema === 1 &&
      typeof s.writtenAt === 'string' &&
      isText(s.endedAt) &&
      isText(s.lastActiveAt) &&
      typeof s.session === 'object' &&
      s.session !== null &&
      isText(s.session.id) &&
      isText(s.session.cwd) &&
      isText(s.session.root) &&
      typeof s.isWorking === 'boolean' &&
      (c === null || (typeof c?.total === 'number' && typeof c.window === 'number' && typeof c.percent === 'number')) &&
      typeof s.cache === 'object' &&
      s.cache !== null &&
      isTtl(s.cache.ttl) &&
      isText(s.cache.expiresAt) &&
      typeof s.cache.keepWarm?.on === 'boolean' &&
      WARM_MODES.includes(s.cache.keepWarm.mode)
    // A file from before 1.4.0's fields reads as having none.
    return isSession ? { ...s, endedAt: s.endedAt ?? null, lastActiveAt: s.lastActiveAt ?? null } : null
  } catch {
    return null
  }
}

// The sessions folder's slots: each one's number, path, last write and
// file, null where it does not read as one.
async function listSlots($: EngineInterface) {
  if (sessionsDir === null) return []
  const entries = await $.fs.list(sessionsDir).catch(() => [])
  const slots: { n: number; path: string; mtimeMs: number; file: SessionSnapshot | null }[] = []
  for (const entry of entries) {
    const n = entry.kind === 'file' ? SLOT_NAME.exec(entry.name)?.[1] : undefined
    if (n === undefined) continue
    const path = joinPath(sessionsDir, entry.name)
    const text = await $.fs.read(path).catch(() => null)
    slots.push({ n: Number(n), path, mtimeMs: entry.mtimeMs, file: text === null ? null : readSessionSnapshot(text) })
  }
  return slots.sort((a, b) => a.n - b.n)
}

// This session's slot: the one its id is in (a reload, or the id it wrote
// last), else the first one free (its session ended, or its file has gone
// stale), else a new one numbered after the rest.
async function claimSlot($: EngineInterface, now: number) {
  if (sessionsDir === null) return null
  const id = await $.session.id().catch(() => null)
  const slots = await listSlots($)
  const own = slots.find(slot => slot.file?.session.id != null && [id, slotId].includes(slot.file.session.id))
  if (own) return own.path
  const free = slots.find(
    slot => now - slot.mtimeMs >= SNAPSHOT_FRESH_MS || (slot.file !== null && slot.file.endedAt !== null),
  )
  if (free) return free.path
  let n = 1
  while (slots.some(slot => slot.n === n)) n++
  return joinPath(sessionsDir, `session-${n}.json`)
}

// Writes this session's file when its figures changed, or when `force` (the
// heartbeat, which first checks the slot is still this session's: two
// sessions starting together may pick the same one, and the one written over
// moves on), or `isEnded` (the session ended).
async function writeSessionFile($: EngineInterface, force = false, isEnded = false) {
  if (sessionsDir === null || (hasEnded && !isEnded)) return
  try {
    const now = await $.clock.now()
    const file = await sessionSnapshotOf($, now, isEnded ? new Date(now).toISOString() : null)
    const key = JSON.stringify({ ...file, writtenAt: '' })
    if (!force && slotPath !== null && key === lastSlotKey && now - lastSlotMs < HEARTBEAT_MS) return
    if (force && slotPath !== null) {
      const text = await $.fs.read(slotPath).catch(() => null)
      const there = text === null ? null : readSessionSnapshot(text)
      if (there !== null && there.session.id !== slotId && there.session.id !== file.session.id) slotPath = null
    }
    if (slotPath === null) slotPath = await claimSlot($, now)
    if (slotPath === null) return
    await $.fs.write(slotPath, JSON.stringify(file, null, 2) + '\n')
    slotId = file.session.id
    lastSlotKey = key
    lastSlotMs = now
  } catch {
    // No file this time; the slot keeps the last one.
  }
}

// The other live sessions, read from their files for TW Monitor:
// written in the last SNAPSHOT_FRESH_MS and not ended, by folder; and the
// pins, hidden sessions and titles.
async function readSessions($: EngineInterface, withTitles = true) {
  try {
    const id = await $.session.id().catch(() => null)
    const now = await $.clock.now()
    const live = (await listSlots($))
      .map(slot => slot.file)
      .filter((s): s is SessionSnapshot => s !== null && s.endedAt === null && s.session.id !== id)
      .filter(s => now - Date.parse(s.writtenAt) < SNAPSHOT_FRESH_MS)
      .sort((a, b) => folderOf(projectOf(a)).localeCompare(folderOf(projectOf(b))) || (a.session.id ?? '').localeCompare(b.session.id ?? ''))
    if (JSON.stringify(live) !== JSON.stringify(await read($, sessions))) await update($, sessions, () => live)
    // A session just listed has its title read, while the Name setting uses
    // titles.
    if (withTitles) await readTitles($, [await sessionSnapshotOf($, now, null), ...live])
    // The marks another session set reach this one, and the titles. A mark
    // or a title is dropped once it is SESSION_SETTINGS_KEEP_MS old and its
    // session is not running.
    const running = new Set([id, ...live.map(s => s.session.id)])
    const savedTitles = readTitleStore(await $.store.get('titles'))
    const keptTitles = Object.fromEntries(
      Object.entries(savedTitles).filter(([titleId, e]) => running.has(titleId) || now - e.at <= SESSION_SETTINGS_KEEP_MS),
    )
    if (Object.keys(keptTitles).length !== Object.keys(savedTitles).length) await $.store.set('titles', keptTitles)
    await setTitles($, keptTitles)
    for (const mark of ['pinned', 'hidden'] as const) {
      const saved = readMarks(await $.store.get(MARKS[mark]))
      const kept = Object.fromEntries(
        Object.entries(saved).filter(([markId, at]) => running.has(markId) || now - at <= SESSION_SETTINGS_KEEP_MS),
      )
      if (Object.keys(kept).length !== Object.keys(saved).length) await $.store.set(MARKS[mark], kept)
      await setMarks($, mark, kept)
    }
  } catch {
    // Read again at the next tick.
  }
}

// Writes the snapshot when its figures changed, or when `force` (the
// heartbeat). $.fs.write has no atomic form, so a reader may see a torn file
// for an instant and should read again.
async function writeSnapshot($: EngineInterface, force = false) {
  await writeSessionFile($, force)
  if (!snapshotPath) return
  try {
    const now = await $.clock.now()
    const latest = await read($, reading)
    const c = await read($, cache)
    const k = await read($, keepWarm)
    const cap = caps(c.ttl, (await read($, settings)).caps)
    const iso = (ms: number) => new Date(ms).toISOString()
    const pace = await paceOf($, await read($, limits), now)
    const snapshot: Snapshot = {
      schema: 1,
      writtenAt: iso(now),
      session: {
        id: await $.session.id().catch(() => null),
        cwd: await $.session.cwd().catch(() => null),
      },
      windows: sorted(await read($, limits)).map(w => {
        const p = pace.windows[w.kind]
        return {
          kind: w.kind,
          label: label(w),
          percentUsed: w.percentUsed,
          resetsAt: w.resetsAt ?? null,
          ratePerHour: p ? Math.round(p.perHour * 100) / 100 : null,
          fullAt: p?.fullAt ? iso(p.fullAt) : null,
        }
      }),
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
          mode: (await read($, settings)).warm.mode,
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

// Every HEARTBEAT_MS: keep-warm off once the cache has gone cold under it (a
// ping still out decides that itself, by what it read), or the next ping
// armed if none is (a reload lost it); then write the snapshot
// again so its timestamp says this session is alive, unless another session
// wrote it more recently and its snapshot is still fresh. That session keeps
// the file while it is active; this one takes over once its snapshot has
// gone stale. This session's own file is written every time, and while the
// TW Monitor is open the others' files are read again.
async function heartbeat($: EngineInterface) {
  try {
    await resolvePaths($)
    // A global setting another session changed reaches this one; once a
    // day this session's own are saved again, so a session left open for
    // weeks is never pruned as gone.
    const at = await $.clock.now()
    const isDue = at - lastTouchMs >= TOUCH_EVERY_MS
    if (isDue) lastTouchMs = at
    await loadSettings($, isDue)
    await adoptUsage($)
    const k = await read($, keepWarm)
    const c = await read($, cache)
    const now = await read($, nowMs)
    const isReminder = (await read($, settings)).warm.mode === 'notify'
    const isCold = k.on && !isReminder && c.warmUntil !== null && now >= c.warmUntil && !(await read($, working))
    if (isCold && !(await isPingOut($, now))) {
      await stopKeepWarm($, 'stopped: cache lost')
    } else if (pingTimer === null) {
      await schedule($)
    }
  } catch {
    // Try again at the next tick.
  }
  if (snapshotPath) {
    try {
      const stat = await $.fs.stat(snapshotPath).catch(() => null)
      const now = await $.clock.now()
      const isOthers = stat !== null && stat.mtimeMs > lastWriteMs + 1_000 && now - stat.mtimeMs < SNAPSHOT_FRESH_MS
      // This session's own file is written either way.
      if (isOthers) await writeSessionFile($, true)
      else await writeSnapshot($, true)
    } catch {
      // Try again at the next tick.
    }
  }
  const panes = await $.ui.panes().catch(() => [])
  if (panes.some(pane => pane.id === SESSIONS)) await readSessions($)
}

// Alerts: a notification the first time a part crosses a level it alerts at.
// A usage window's levels are noted in the store against its reset time, so
// one session says it once a window period; the context's in this session,
// cleared once it falls back under them (a compaction).
async function checkAlerts($: EngineInterface) {
  try {
    const inForce = await read($, settings)
    const now = await read($, nowMs)
    // A part's level as a list: its one level, or none while it is off.
    const levelsOn = (part: keyof typeof inForce.alert) => {
      const level = inForce.alert[part]
      return level === null ? [] : [level]
    }
    const alerted = readAlerted(await $.store.get('alerted'))
    let next = alerted
    for (const w of current(await read($, limits), now)) {
      const resetsAt = w.resetsAt ?? null
      const kept = alerted[w.kind]?.resetsAt === resetsAt ? alerted[w.kind]!.levels : []
      const crossed = levelsOn(partOf(w)).filter(level => w.percentUsed >= level && !kept.includes(level))
      if (crossed.length === 0) continue
      const left = countdown(w.resetsAt, now)
      await notify($, `${usageName(w)} at ${Math.round(w.percentUsed)}%${left ? `, resets in ${left}` : ''}.`)
      next = { ...next, [w.kind]: { resetsAt, levels: [...kept, ...crossed] } }
    }
    if (next !== alerted) await $.store.set('alerted', next)
    const latest = await read($, reading)
    if (latest !== null) {
      const percent = Math.round((latest.total / latest.window) * 100)
      const kept = (await read($, ctxAlerted)).filter(level => percent >= level)
      const crossed = levelsOn('CTX').filter(level => percent >= level && !kept.includes(level))
      if (crossed.length > 0) await notify($, `Context at ${percent}% (${short(latest.total)} / ${short(latest.window)}).`)
      const levels = [...kept, ...crossed]
      if (JSON.stringify(levels) !== JSON.stringify(await read($, ctxAlerted))) await update($, ctxAlerted, () => levels)
    }
  } catch {
    // Checked again at the next reading.
  }
}

// A usage window as a notification names it, out of the banner's context:
// "5-hour usage", "Weekly usage", "FB usage".
function usageName(w: Limit) {
  return w.kind === 'five_hour' ? '5-hour usage' : w.kind === 'seven_day' ? 'Weekly usage' : `${label(w)} usage`
}

async function notify($: EngineInterface, text: string) {
  await $.ui.notify(text, { title: 'Token Watch' }).catch(() => null)
}

// The usage windows another session reported more recently than this one
// (its responses carry them, an idle session gets none), and the samples
// every session adds, taken from the store. The windows are the account's,
// so the newest figures are right for every session.
async function adoptUsage($: EngineInterface) {
  const at = await $.store.get('limitsAt')
  const saved = await $.store.get('limits')
  const windows = readLimits(saved)
  if (typeof at === 'number' && at > (await read($, limitsAt)) && windows !== null) {
    await update($, limits, () => windows)
    await update($, limitsAt, () => at)
    await checkAlerts($)
  }
  const kept = readHistory(await $.store.get('history'))
  if (JSON.stringify(kept) !== JSON.stringify(await read($, history))) await update($, history, () => kept)
}

// Usage windows as the store keeps them, each checked; null for anything
// else.
function readLimits(value: unknown): Limit[] | null {
  if (!Array.isArray(value)) return null
  return value.filter(
    (w): w is Limit =>
      typeof w?.kind === 'string' &&
      typeof w.percentUsed === 'number' &&
      (w.resetsAt === undefined || typeof w.resetsAt === 'string'),
  )
}

// The alerts already given, by window, as the store keeps them, each checked.
function readAlerted(value: unknown): Record<string, { resetsAt: string | null; levels: number[] }> {
  if (typeof value !== 'object' || value === null) return {}
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      const e = entry as { resetsAt?: unknown; levels?: unknown } | null
      return (e?.resetsAt === null || typeof e?.resetsAt === 'string') && Array.isArray(e?.levels) && e.levels.every(l => typeof l === 'number')
    }),
  ) as Record<string, { resetsAt: string | null; levels: number[] }>
}

// What /token-watch file answers: where the snapshot is and when it was
// last written, or why there is none.
async function snapshotStatus($: EngineInterface) {
  if (!snapshotOn) {
    return 'Token Watch snapshot: off. Turn it on in /config ("Usage snapshot files"), or in /plugin, token-watch, Configure options.'
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