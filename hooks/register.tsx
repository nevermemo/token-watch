// Token Watch: plan usage (the 5-hour and weekly windows, and any other
// window Claude Code reports) and the context window as thin bars above the
// prompt, one colour per category the way /context breaks it down. A click
// anywhere on the band collapses it to one row; /context-bar shows or hides
// it.
//
// session.start: register /context-bar, restore the saved choices and the last
//   usage windows seen (a new session has none until its first response),
//   take a reading, and tick a clock every 30s so the reset countdowns stay
//   current and the usage snapshot says the session is alive.
// session.measure: after each main-thread turn, or when a usage window moves,
//   take a reading.
// command.run (context-bar): show or hide the band where it draws; where it
//   cannot be drawn (the VS Code extension's chat panel, a headless run),
//   answer with the reading as one line of text. `text` asks for that line
//   anywhere, `file` for the snapshot's path.
// ui.render (AbovePrompt): the band, drawn by the Client in ./band.tsx, which
//   lays itself out to the room it is given and reports clicks.
// ui.message: the band was clicked; flip collapsed.
//
// A reading is $.session.usage({ breakdown: 'summary' }): the /context rows,
// estimated locally, so it costs no token-count request, and the plan's
// rate-limit windows as the status line has them (none off a subscription).
// Each reading is also written to ~/.claude/token-watch/usage.json, the
// snapshot a companion (Token Watch for VS Code) reads; the plugin's
// `snapshot` option turns that off.

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { BandProps, Limit, Reading, Slice, Snapshot } from '../types'
import { label, readingLine, sorted } from './format'

const reading = atom({ plugin: 'token-watch', key: 'reading' } as const, null)
const isShown = atom({ plugin: 'token-watch', key: 'isShown' } as const, true)
const isCollapsed = atom({ plugin: 'token-watch', key: 'isCollapsed' } as const, false)
const limits = atom({ plugin: 'token-watch', key: 'limits' } as const, [])
const nowMs = atom({ plugin: 'token-watch', key: 'nowMs' } as const, 0)

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
const SNAPSHOT_FRESH_MS = 150_000

// Snapshot bookkeeping. Module variables: a hot reload loses them, which
// costs one extra write.
let snapshotOn = true
let snapshotPath: string | null = null
let lastWriteMs = 0
let lastKey = ''

export const register: Register = (on, options) => {
  // The plugin's `snapshot` option (/config): on unless set to false.
  snapshotOn = options.snapshot !== false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'context-bar',
      description:
        'Show or hide the Token Watch band (plan usage and context) above the prompt; "text" for the reading as a line, "file" for the usage snapshot',
      argumentHint: '[text|file]',
    })
    const shown = await $.store.get('isShown')
    const collapsed = await $.store.get('isCollapsed')
    await update($, isShown, () => shown !== false)
    await update($, isCollapsed, () => collapsed === true)
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
    await takeReading($)
    $.clock.every(HEARTBEAT_MS, () => void tick($).then(() => heartbeat($)))

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
      const text = readingLine(await read($, reading), current(await read($, limits), now), now)
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
    if ((e.data as { toggle?: boolean } | null)?.toggle !== true) {
      return next(e)
    }
    const collapsed = !(await read($, isCollapsed))
    await update($, isCollapsed, () => collapsed)
    await $.store.set('isCollapsed', collapsed)

    return {}
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
      isCollapsed: await read($, isCollapsed),
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
    }
  } catch {
    // No reading this time; the band keeps the last one.
    return
  }
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
    const snapshot: Snapshot = {
      schema: 1,
      writtenAt: new Date(now).toISOString(),
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

// Every HEARTBEAT_MS: write the snapshot again so its timestamp says this
// session is alive, unless another session wrote it more recently and its
// snapshot is still fresh. That session keeps the file while it is active;
// this one takes over once its snapshot has gone stale.
async function heartbeat($) {
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
