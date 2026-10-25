// Token Watch: plan usage (the 5-hour and weekly windows, and any other
// window Claude Code reports), the context window and the prompt cache's
// countdown as thin bars above the prompt. A right click cycles the band's
// three views, the cache timer and the keep-warm button turn keep-warm on and
// off, and /context-bar shows or hides it.
//
// session.start: register /context-bar, restore the saved view (or the one
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
// prompt.submit: a prompt from the person turns keep-warm off; a background
//   delivery does not. Only the origin is read, and the prompt passes on.
// session.compact (main loop, not a precompute): keep-warm off, the countdown
//   restarts.
// session.end: keep-warm off; where the process goes on under another session
//   (/clear, a resume, a logout), the cache is forgotten too.
// command.run (context-bar): show or hide the band where it draws; where it
//   cannot be drawn (the VS Code extension's chat panel, a headless run),
//   answer with the reading as one line of text. `text` asks for that line
//   anywhere, `file` for the snapshot's path, `settings` opens the settings
//   panel.
// ui.render (AbovePrompt): the band, drawn by the Client in ./band.tsx, which
//   lays itself out to the room it is given and reports clicks; beside it, the
//   settings button ([≡] in a terminal, ☰ on the desktop), a Button of this
//   module's own, so its press is the person's.
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
//
// Burn rates: each reading's usage windows are kept in the store where they
// moved (./burn.ts), shared by every session since the windows are the
// account's; the band shows each window's pace and when it fills.
//
// A reading is $.session.usage({ breakdown: 'summary' }): the /context rows,
// estimated locally, so it costs no token-count request, and the plan's
// rate-limit windows as the status line has them (none off a subscription).
// Each reading is also written to ~/.claude/token-watch/usage.json, the
// snapshot a companion (Token Watch for VS Code) reads; the plugin's
// `snapshot` option turns that off.
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
  KeepWarm,
  Limit,
  Pace,
  Reading,
  Scope,
  SettingsOverride,
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
  NOTIFY_LEADS,
  PACE_UNITS,
  PACE_WINDOWS,
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
  setAt,
  stepAlert,
  stepIn,
  windowText,
} from './settings'
import type { Path } from './settings'
import { addReadings, fullAt, ratePerHour, readHistory } from './burn'
import { countdown, duration, hmmss, label, partOf, readingLine, short, sorted } from './format'

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

// Keep-warm's modes as the panel names and explains them.
const WARM_MODE_NAMES: Record<WarmMode, string> = { pings: 'Pings', notify: 'Notify', both: 'Both' }
const WARM_MODE_NOTES: Record<WarmMode, string> = {
  pings: 'Pings keep the cache warm while you are away.',
  notify: 'No pings: a notification before the cache expires, free. Stays on across prompts.',
  both: 'Pings, and a notification before the first ping of each idle spell.',
}

// The settings panel's pane id, and its width when docked beside the transcript.
const SETTINGS = 'token-watch-settings'
const SETTINGS_COLUMNS = 52

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
const HEARTBEAT_MS = 30_000
const SNAPSHOT_FRESH_MS = 120_000

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
let pingTimer: Timer | null = null
let notifyTimer: Timer | null = null
let pingOut: { seq: number; sentAt: number } | null = null
let pingSeq = 0

export const register: Register = (on, options) => {
  // The plugin's `snapshot` option (/config): on unless set to false.
  snapshotOn = options.snapshot !== false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'context-bar',
      description:
        'Show or hide the Token Watch band (plan usage, context and the prompt cache countdown) above the prompt; right-click it to cycle its views; "text" for the reading as a line, "file" for the usage snapshot, "settings" for the settings panel',
      argumentHint: '[text|file|settings]',
    })
    const shown = await $.store.get('isShown')
    await update($, isShown, () => shown !== false)
    const restored = await restoreView($)
    await update($, view, () => restored)
    await tick($)
    await pruneSessionSettings($)
    await loadSettings($, true)
    const keptHistory = readHistory(await $.store.get('history'))
    await update($, history, () => keptHistory)
    // A new session has no usage windows until its first response, so start
    // from the last ones seen; any whose reset time has passed is drawn at 0%,
    // and the first response replaces them.
    const saved = await $.store.get('limits')
    if (Array.isArray(saved)) {
      await update($, limits, () => saved as Limit[])
      const savedAt = await $.store.get('limitsAt')
      if (typeof savedAt === 'number') await update($, limitsAt, () => savedAt)
    }
    if (snapshotOn) {
      snapshotPath = await resolveSnapshotPath($)
    }
    const inputs = await readTtlInputs($)
    await update($, ttlInputs, () => inputs)
    await settleTtl($)
    // A start's reading counts as fresh only while no session has stamped
    // one (a new store, or 1.3.0's): it never puts older figures over newer.
    await takeReading($, (await read($, limitsAt)) === 0)
    $.clock.every(HEARTBEAT_MS, () => void tick($).then(() => heartbeat($)).catch(() => {}))
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
    if (e.reason === 'clear' || e.reason === 'resume' || e.reason === 'logout') {
      await update($, cache, c => ({
        ...c,
        lastResponseAt: null,
        warmUntil: null,
        windowMs: TTL_MS[c.ttl],
        prefixTokens: null,
        confirmed: false,
      }))
      await settleTtl($)
      // Another session's id: its own settings, if it has any.
      await loadSettings($, true)
    }
    await writeSnapshot($)
    return result
  })

  on('command.run', { command: 'context-bar' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'file') {
      return { text: await snapshotStatus($) }
    }
    if (arg === 'settings') {
      const opened = await openSettings($)
      if (opened.isPlaced) return { text: 'Token Watch settings opened.' }
      // Not placed: close it rather than leave it waiting, undrawn, for a
      // surface that would show it later unasked.
      await $.ui.close({ id: SETTINGS }).catch(() => {})
      return { text: `Token Watch settings: the panel can't be shown here (${opened.reason}).` }
    }
    if (arg !== '' && arg !== 'text') {
      return { text: 'Usage: /context-bar [text|file|settings]' }
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
        cap: await currentCap($),
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

  // The settings panel. At the top, which settings it edits: this session's
  // own, which override the global ones leaf by leaf, or every session's.
  // Then collapsible sections: Usage (a section per window: in which views it
  // shows, and its pace's views, window and unit), Context, and Cache (its
  // views and keep-warm's caps for this session's TTL). The Buttons are the
  // marks alone, the labels beside them. A row this session overrides has a
  // reset in this session's scope, and a note in every session's. A docked
  // pane, so it stays beside the transcript while the band changes under it.
  on('ui.render', { component: 'Pane', requestId: SETTINGS }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    // Marks: ☑ / ☐ for a toggle, ◉ / ○ for a choice and ▸ / ▾ for a section in
    // the desktop's native button; in a terminal bracketed with no spaces,
    // [●] / [○] for both kinds (☑ may draw as a wide emoji) and [▸] / [▾].
    const isTerminal = e.surface === 'terminal'
    const plain = isTerminal || undefined
    const wrap = (glyph: string) => (isTerminal ? `[${glyph}]` : glyph)
    const mark = (isOn: boolean) => (isTerminal ? wrap(isOn ? '\u25cf' : '\u25cb') : isOn ? '\u2611' : '\u2610')
    const choice = (isOn: boolean) => wrap(isOn ? (isTerminal ? '\u25cf' : '\u25c9') : '\u25cb')
    const isGlobal = await editsGlobal($)
    const hasSession = (await sessionKey($)) !== null
    const own = await read($, override)
    // What each leaf reads in the scope shown.
    const shown = isGlobal ? await read($, globalSettings) : await read($, settings)
    const open = await read($, openSections)
    const ttl = (await read($, cache)).ttl
    const capWidth = 'Hours:'.length + (isTerminal ? 0 : 1)
    const paceWidth = 'Window:'.length + (isTerminal ? 0 : 1)

    // A row's override marker: a reset in this session's scope, a note in
    // every session's.
    const marker = (path: Path) =>
      !overridesUnder(own, path) ? null : isGlobal ? (
        <Text key={`over-${path.join('-')}`} dimColor wrap="truncate">
          overridden here
        </Text>
      ) : (
        <Button key={`reset-${path.join('-')}`} plain={plain} dimColor onPress={() => void resetSetting($, path)}>
          {wrap('reset')}
        </Button>
      )
    // A section's heading, which opens and closes it, and its body indented.
    // A sub-section's heading is plain, and carries its row's override
    // marker, so an override shows with the section closed.
    const section = (id: string, title: string, body: () => unknown, options: { isSub?: true; extra?: unknown } = {}) => {
      const isOpen = open.includes(id)
      return (
        <Box key={id} flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            <Button key={`section-${id}`} plain={plain} onPress={() => void toggleSection($, id)}>
              {wrap(isOpen ? '\u25be' : '\u25b8')}
            </Button>
            <Text bold={!options.isSub || undefined}>{title}</Text>
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
          return (
            <Box key={v} flexDirection="row" columnGap={1} flexShrink={0}>
              <Button key={`${key}-${v}`} plain={plain} onPress={() => void setSetting($, [...path, v], !isOn)}>
                {mark(isOn)}
              </Button>
              <Text>{VIEW_NAMES[v]}</Text>
            </Box>
          )
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
          <Box flexDirection="row" columnGap={isTerminal ? 0 : 1}>
            {level === null ? (
              <Button key={`alert-${part}-enable`} plain={plain} onPress={() => step(-1)}>
                {wrap('Enable')}
              </Button>
            ) : (
              <Button key={`alert-${part}-down`} plain={plain} dimColor={level <= 50} onPress={() => step(-1)}>
                {isTerminal ? '[-]' : '\u2212'}
              </Button>
            )}
            <Text>{level === null ? 'Off' : `${level}%`}</Text>
            {level !== null && (
              <Button key={`alert-${part}-up`} plain={plain} onPress={() => step(1)}>
                {isTerminal ? '[+]' : '+'}
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
        <Button key={`${key}-down`} plain={plain} dimColor={atMin} onPress={() => by(-1)}>
          {isTerminal ? '[-]' : '\u2212'}
        </Button>
        <Text>{value}</Text>
        <Button key={`${key}-up`} plain={plain} dimColor={atMax} onPress={() => by(1)}>
          {isTerminal ? '[+]' : '+'}
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
          {views(`${id}-show`, 'Show on band', ['show', part], `show-${part}`)}
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
                  {PACE_UNITS[part].map(unit => (
                    <Box key={unit} flexDirection="row" columnGap={1} flexShrink={0}>
                      <Button key={`unit-${part}-${unit}`} plain={plain} onPress={() => void setSetting($, ['pace', part, 'unit'], unit)}>
                        {choice(pace.unit === unit)}
                      </Button>
                      <Text>{`%/${unit}`}</Text>
                    </Box>
                  ))}
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
    return (
      <Box flexDirection="column" rowGap={1} paddingX={1}>
        {hasSession && (
          <Box flexDirection="column">
            <Box flexDirection="row" columnGap={1} flexWrap="wrap">
              <Box flexDirection="row" columnGap={1} flexShrink={0}>
                <Button key="scope-session" plain={plain} onPress={() => void setScope($, 'session')}>
                  {choice(!isGlobal)}
                </Button>
                <Text>This session</Text>
              </Box>
              <Box flexDirection="row" columnGap={1} flexShrink={0}>
                <Button key="scope-global" plain={plain} onPress={() => void setScope($, 'global')}>
                  {choice(isGlobal)}
                </Button>
                <Text>All sessions</Text>
              </Box>
            </Box>
            <Text dimColor wrap="wrap">
              {isGlobal
                ? 'Changes apply to every session, except where one has its own setting.'
                : 'Changes apply to this session only, over the settings for all sessions.'}
            </Text>
            {/* In this session's scope, every setting of its own back to the
                settings for all sessions; in every session's, those back to
                the defaults. Dim with nothing to reset. */}
            <Box flexDirection="row">
              {isGlobal ? (
                <Button
                  key="reset-defaults"
                  plain={plain}
                  dimColor={JSON.stringify(shown) === JSON.stringify(DEFAULT_SETTINGS)}
                  onPress={() => void resetDefaults($)}
                >
                  {wrap('Reset to defaults')}
                </Button>
              ) : (
                <Button
                  key="reset-session"
                  plain={plain}
                  dimColor={isEmptyOverride(own)}
                  onPress={() => void resetSession($)}
                >
                  {wrap('Reset this session')}
                </Button>
              )}
            </Box>
          </Box>
        )}
        {section('usage', 'Usage', () => (
          <Box flexDirection="column">
            {usage('5H', '5H')}
            {usage('WK', 'WK')}
            {usage('other', 'OTH')}
          </Box>
        ))}
        {section('context', 'Context', () => (
          <Box flexDirection="column">
            {views('context-show', 'Show on band', ['show', 'CTX'], 'show-CTX')}
            {alerts('context-alert', 'CTX')}
          </Box>
        ))}
        {section('cache', 'Cache time', () => (
          <Box flexDirection="column">
            {section(
              'cache-show',
              'Show on band',
              () => (
                <Box flexDirection="column">
                  {viewChoices(['show', 'TTL'], 'show-TTL')}
                  <Text dimColor wrap="wrap">
                    Hidden in every view, keep-warm turns off.
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
                    {WARM_MODES.map(mode => (
                      <Box key={mode} flexDirection="row" columnGap={1} flexShrink={0}>
                        <Button key={`warm-${mode}`} plain={plain} onPress={() => void setSetting($, ['warm', 'mode'], mode)}>
                          {choice(shown.warm.mode === mode)}
                        </Button>
                        <Text>{WARM_MODE_NAMES[mode]}</Text>
                      </Box>
                    ))}
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
              { isSub: true, extra: marker(['warm', 'mode']) },
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
                      capWidth,
                      String(value),
                      value <= min,
                      value >= max,
                      by => void setSetting($, ['caps', ttl, which], Math.min(max, Math.max(min, value + by * step))),
                      ['caps', ttl, which],
                    )
                  })}
                  <Text dimColor wrap="wrap">
                    {`Defaults: ${DEFAULT_CAPS[ttl].pings} pings or ${DEFAULT_CAPS[ttl].hours} hours. A running keep-warm already past a new cap stops.`}
                  </Text>
                </Box>
              ),
              { isSub: true },
            )}
          </Box>
        ))}
        <Text dimColor wrap="wrap">
          A pace is averaged over its window, once that holds 5 minutes of readings. /context-bar settings opens this panel again.
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
// session to pick up (the heartbeat); any other (a start, /context-bar)
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
  return $.ui.open({ id: SETTINGS, title: 'Token Watch', columns: SETTINGS_COLUMNS })
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
  const saved = await $.store.get('settings')
  const nextGlobal =
    saved === undefined ? fromLegacy(await $.store.get('hidden'), await $.store.get('caps')) : readSettings(saved)
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

// The settings in force, the session's leaves over the global ones; then
// keep-warm held to them: off while no view shows the cache, stopped if past
// its caps.
async function applySettings($: EngineInterface) {
  const next = merge(await read($, globalSettings), await read($, override))
  if (JSON.stringify(await read($, settings)) !== JSON.stringify(next)) await update($, settings, () => next)
  if (isCacheHidden(next) && (await read($, keepWarm)).on) await stopKeepWarm($, null)
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

async function toggleSection($: EngineInterface, id: string) {
  await update($, openSections, open => (open.includes(id) ? open.filter(s => s !== id) : [...open, id]))
}

// One leaf set in the scope the panel edits, or in the global settings for a
// leaf only they hold. In this session's scope, a leaf set to the global
// value no longer overrides it.
async function setSetting($: EngineInterface, path: Path, value: unknown) {
  const global = await read($, globalSettings)
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
  await update($, globalSettings, () => DEFAULT_SETTINGS)
  await $.store.set('settings', DEFAULT_SETTINGS)
  await applySettings($)
}

// The pace the band shows, now: each window's rate over its part's window,
// when it fills, and the unit its part prints it in.
async function paceOf($: EngineInterface, windows: Limit[], now: number): Promise<Pace> {
  const inForce = await read($, settings)
  const h = await read($, history)
  const pace: Pace = { windows: {} }
  for (const w of windows) {
    const { windowMin, unit } = inForce.pace[partOf(w)]
    const perHour = ratePerHour(h[w.kind]?.samples ?? [], now, windowMin * 60_000)
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
        : `Token Watch pings in ${duration(c.warmUntil - leadMs(c.windowMs) - now)} to keep the prompt cache warm. Send a message to keep it yourself.`
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
    if (sentAt >= c.warmUntil) return await stopKeepWarm($, 'stopped: cache went cold')
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
    return await stopKeepWarm($, `stopped: ${MAX_FAILURES} pings failed`)
  }
  stopPingTimer()
  pingTimer = $.clock.after(RETRY_MS, () => void ping($))
}

// Where the snapshot goes: ~/.claude/token-watch/usage.json, `~` being
// USERPROFILE (Windows) or else HOME, the choice Node's os.homedir() makes,
// so the companion finds it. The path is joined with the home directory's own
// separator: backslashes if it has any, else slashes. Null when neither
// variable is set.
async function resolveSnapshotPath($: EngineInterface) {
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
async function writeSnapshot($: EngineInterface, force = false) {
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
// gone stale.
async function heartbeat($: EngineInterface) {
  try {
    // A global setting another session changed reaches this one.
    await loadSettings($)
    await adoptUsage($)
    const k = await read($, keepWarm)
    const c = await read($, cache)
    const now = await read($, nowMs)
    const isReminder = (await read($, settings)).warm.mode === 'notify'
    const isCold = k.on && !isReminder && c.warmUntil !== null && now >= c.warmUntil && !(await read($, working))
    if (isCold && !(await isPingOut($, now))) {
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
    const alerted = ((await $.store.get('alerted')) ?? {}) as Record<string, { resetsAt: string | null; levels: number[] }>
    let next = alerted
    for (const w of current(await read($, limits), now)) {
      const resetsAt = w.resetsAt ?? null
      const kept = alerted[w.kind]?.resetsAt === resetsAt ? alerted[w.kind]!.levels : []
      const crossed = levelsOn(partOf(w)).filter(level => w.percentUsed >= level && !kept.includes(level))
      if (crossed.length === 0) continue
      const left = countdown(w.resetsAt, now)
      await notify($, `${label(w)} at ${Math.round(w.percentUsed)}%${left ? `, resets in ${left}` : ''}.`)
      next = { ...next, [w.kind]: { resetsAt, levels: [...kept, ...crossed] } }
    }
    if (next !== alerted) await $.store.set('alerted', next)
    const latest = await read($, reading)
    if (latest !== null) {
      const percent = Math.round((latest.total / latest.window) * 100)
      const kept = (await read($, ctxAlerted)).filter(level => percent >= level)
      const crossed = levelsOn('CTX').filter(level => percent >= level && !kept.includes(level))
      if (crossed.length > 0) await notify($, `Context at ${percent}% (${short(latest.total)} of ${short(latest.window)}).`)
      const levels = [...kept, ...crossed]
      if (JSON.stringify(levels) !== JSON.stringify(await read($, ctxAlerted))) await update($, ctxAlerted, () => levels)
    }
  } catch {
    // Checked again at the next reading.
  }
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
  if (typeof at === 'number' && at > (await read($, limitsAt)) && Array.isArray(saved)) {
    await update($, limits, () => saved as Limit[])
    await update($, limitsAt, () => at)
    await checkAlerts($)
  }
  const kept = readHistory(await $.store.get('history'))
  if (JSON.stringify(kept) !== JSON.stringify(await read($, history))) await update($, history, () => kept)
}

// What /context-bar file answers: where the snapshot is and when it was
// last written, or why there is none.
async function snapshotStatus($: EngineInterface) {
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