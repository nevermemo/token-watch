import type { ModelForkResult, ModelUsage, On, PaneOpenArgs, RenderSurface, SessionRateLimit, SessionMeasureInput, SessionMessage } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// The figures from the screenshot this mod copies: 212k of 1M, compacts at 950k.
const ROWS = [
  ['System prompt', 3_400, 'used'],
  ['System tools', 12_000, 'used'],
  ['MCP tools', 2_600, 'used'],
  ['Custom agents', 1_100, 'used'],
  ['Memory files', 4_900, 'used'],
  ['Skills', 2_200, 'used'],
  ['Messages', 186_000, 'used'],
  ['Free space', 738_000, 'free'],
  ['Autocompact buffer', 50_000, 'buffer'],
] as const

const NOW = Date.parse('2026-10-03T12:00:00Z')
const MINUTE = 60_000

// The weekly window listed first, to show the band orders them itself.
const SEVEN_DAY = { kind: 'seven_day', percentUsed: 31, resetsAt: new Date(NOW + (3 * 24 * 60 + 4 * 60) * MINUTE).toISOString() }
const FIVE_HOUR = { kind: 'five_hour', percentUsed: 62.4, resetsAt: new Date(NOW + (2 * 60 + 14) * MINUTE).toISOString() }
const RATE_LIMITS = [SEVEN_DAY, FIVE_HOUR]

// The spike's figures: the first response wrote a 47k prompt; a warm fork
// read 33.5k of it (its request differs from the main thread's in its tail)
// and wrote its own 13.7k tail.
const LAST_RESPONSE: ModelUsage = { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 47_221 }
const PING_OK: ModelForkResult = {
  isAnswered: true,
  text: 'ok',
  usage: { input_tokens: 16, output_tokens: 4, cache_read_input_tokens: 33_510, cache_creation_input_tokens: 13_714 },
}
const PING_COLD: ModelForkResult = { ...PING_OK, usage: { ...PING_OK.usage, cache_read_input_tokens: 12, cache_creation_input_tokens: 47_200 } }
const PING_FAILED: ModelForkResult = {
  isAnswered: false,
  reason: 'api-error',
  status: 529,
  error: 'overloaded',
  usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
}
const TURN_USAGE = { ...LAST_RESPONSE, model: 'claude-opus-5-5' }
const MESSAGE: SessionMessage = { role: 'user', text: 'hi', toolUses: [] }

// What a test may add to the breakdown: its lists of MCP tools, memory files,
// skills and agents (none by default).
type Extras = {
  mcpTools?: { name: string; serverName: string; tokens: number; isLoaded: boolean }[]
  memoryFiles?: { path: string; type: string; tokens: number }[]
  skills?: { totalSkills: number; includedSkills: number; tokens: number; skillFrontmatter: [] }
  agents?: { agentType: string; source: string; tokens: number }[]
}

// `apiUsage`: the last response's counts, which the band reads the prompt's
// size from; null before one came back. `total`: the context's size, 212.2k
// unless a test grows it (the messages row takes the difference).
const usage = (rateLimits: SessionRateLimit[], apiUsage: ModelUsage | null = null, total = 212_200, extras: Extras = {}) => ({
  startedAt: 0,
  rateLimits,
  context: {
    tokens: total,
    window: 1_000_000,
    percent: 21,
    breakdown: {
      categories: ROWS.map(([name, tokens, kind]) => ({
        name,
        tokens: name === 'Messages' ? tokens + total - 212_200 : tokens,
        kind,
        color: 'inactive',
        isDeferred: false,
      })),
      totalTokens: total,
      maxTokens: 1_000_000,
      rawMaxTokens: 1_000_000,
      autocompactSource: 'auto' as const,
      percentage: 21,
      gridRows: [],
      model: 'claude-opus-5-5',
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      ...extras,
      autoCompactThreshold: 950_000,
      isAutoCompactEnabled: true,
      apiUsage,
    },
  },
})

const BAND = {
  plugin: 'token-watch',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

// How many times `part` appears in `s`.
const count = (s: string, part: string) => s.split(part).length - 1

// A right click moves to the next view; a left click does nothing.
const rightClick = { type: 'up', x: 5, y: 0, button: 'right' } as const
const leftClick = { type: 'up', x: 5, y: 0, button: 'left' } as const

// The button chips, which are the indicators: grey with keep-warm off, green
// with it on, red with no warm cache (before the first response, or once the
// countdown has run out).
const CHIP_OFF = '#4a5060'
const CHIP_ON = '#2f7a4f'
const CHIP_COLD = '#a8433f'

type Surface = 'terminal' | 'desktop'

// A chip's margin, inside its Button's label: an en space on the desktop, a
// no-break space in a terminal.
const pad = (surface: Surface) => (surface === 'desktop' ? ' ' : ' ')

// A Button as the tree spells it on both surfaces: a plain Button, its label
// carrying the margins, inside a Box that fills it as a chip.
const chipOf = (surface: Surface, key: string, label: string, fill: string) =>
  `{"type":"Box","props":{"key":"${key}-chip","flexShrink":0,"backgroundColor":"${fill}"},"children":[` +
  `{"type":"Button","props":{"key":"${key}","label":"${pad(surface)}${label}${pad(surface)}","plain":true}`

// The expanded row's keep-warm label: a terminal centres it in the cells of
// the longest, "Cache Lost", any odd cell on the right; the desktop does not.
const warmLabel = (surface: Surface, label: string) => {
  if (surface === 'desktop') return label
  const gap = 10 - label.length
  return ' '.repeat(Math.floor(gap / 2)) + label + ' '.repeat(gap - Math.floor(gap / 2))
}
const keepWarmOff = (surface: Surface) => chipOf(surface, 'keep-warm', warmLabel(surface, 'Keep Warm'), CHIP_OFF)
const keepWarmOn = (surface: Surface) => chipOf(surface, 'keep-warm', warmLabel(surface, 'Let Chill'), CHIP_ON)
const keepWarmCold = (surface: Surface) => chipOf(surface, 'keep-warm', warmLabel(surface, 'Cache Lost'), CHIP_COLD)
const keepWarmNoData = (surface: Surface) => chipOf(surface, 'keep-warm', warmLabel(surface, 'No Data'), CHIP_COLD)
const refreshCapsBtn = (surface: Surface) => chipOf(surface, 'refresh-caps', 'Refresh Caps', CHIP_OFF)
// The collapsed views' timer: the countdown as a chip in the indicator's colour.
const cacheBtn = (surface: Surface, text: string, fill: string) => chipOf(surface, 'cache-timer', text, fill)
// The expanded row's timer text, "52:50 / 60:00", always in the plain colour.
const timerTxt = (text: string) => `{"type":"Text","children":["${text}"]}`
const KEEP_WARM_KEY = '"key":"keep-warm"'
const REFRESH_CAPS_KEY = '"key":"refresh-caps"'

type Boot = {
  // What $.session.surfaces() answers; [surface] by default, none for null.
  surfaces?: readonly RenderSurface[]
  // Text a mod beneath this one draws in the band, if any.
  beneath?: string
  // What the mod's store holds from earlier sessions.
  stored?: Record<string, unknown>
  // The environment; USERPROFILE set by default.
  env?: Record<string, string>
  // The snapshot file's mtime as $.fs.stat answers it; absent, no file.
  statMtimeMs?: number
  // What $.settings.read() answers; {} by default.
  settings?: Record<string, unknown>
  // What $.model.fork answers; a warm ping by default.
  fork?: ModelForkResult
  // A reason: the engine denies $.model.fork with it, so the call throws.
  forkThrows?: string
  // Holds forks open: given the fork's number (1 for the first), what that
  // fork waits for before it answers, or nothing to answer at once.
  forkGate?: (call: number) => Promise<void> | undefined
  // The last response's counts in the breakdown; none by default.
  apiUsage?: ModelUsage
  // Why no surface places a pane; every pane is placed by default.
  paneUnplaced?: string
  // The context's size, which a test may grow between readings.
  context?: { total: number }
  // The breakdown's lists: MCP tools, memory files, skills and agents.
  breakdown?: Extras
  // The directory the session is in, which a shell `cd` moves; C:/proj (its
  // root) by default.
  cwd?: string
  // False: there is no git to search a large transcript with.
  git?: false
  // False: nobody is at the prompt (a `claude -p` or SDK run).
  interactive?: false
  // Files already in the sessions folder (other sessions'), by name: each
  // one's content (an object is written as JSON) and its mtime.
  sessionFiles?: Record<string, { file: unknown; mtimeMs: number }>
}

type Write = { path: string; text: string }

// The sessions folder under the test's home directory.
const SESSIONS_DIR = 'C:/Users/test/.claude/token-watch/sessions'

// A gate for forks held open: `open()` lets every waiting fork answer.
function gate() {
  let open = () => {}
  const opened = new Promise<void>(resolve => {
    open = resolve
  })
  return { opened, open }
}

// The engine hands $.fs.write the path resolved to the platform's own form
// (backslashes on Windows), whatever string the mod gave; the mod's own
// spelling is what /token-watch file reports.
function slash(p: string) {
  return p.replace(/\\/g, '/')
}

// The i-th write (the last by default), which a test has just made happen.
function written(writes: Write[], i = writes.length - 1): Write {
  const write = writes[i]
  if (write === undefined) throw new Error(`no write ${i} of ${writes.length}`)
  return write
}

// That write's snapshot, parsed.
const snapshotOf = (writes: Write[], i?: number) => JSON.parse(written(writes, i).text)

// Starts a session with the engine's answers stubbed: the clock at NOW, the
// store (readable back as `saved`), the environment, the usage, the settings,
// the model (every fork's prompt is collected in `forks`), the session's
// surfaces, id and cwd, the turn and prompt events' bottoms, and the file
// system (every $.fs.write is collected in `writes`).
async function boot($: Engine, on: On, surface: 'terminal' | 'desktop' | null, rateLimits: SessionRateLimit[], options: Boot = {}) {
  const writes: Write[] = []
  const forks: string[] = []
  const opens: PaneOpenArgs[] = []
  const closes: string[] = []
  const notes: string[] = []
  // The sessions folder, kept in memory: what is in it and every write to it
  // (`writes` holds the usage snapshot's alone).
  const sessionWrites: Write[] = []
  const runs: (readonly string[])[] = []
  const files = new Map<string, { text: string; mtimeMs: number; size?: number }>(
    Object.entries(options.sessionFiles ?? {}).map(([name, { file, mtimeMs }]) => [
      `${SESSIONS_DIR}/${name}`,
      { text: typeof file === 'string' ? file : JSON.stringify(file), mtimeMs },
    ]),
  )
  // Most tests here are about pings, so keep-warm is in Pings mode (the
  // default is Notify) unless a test brings saved settings of its own,
  // 1.3.0's keys included.
  const stored = options.stored ?? {}
  const bringsSettings = 'settings' in stored || 'hidden' in stored || 'caps' in stored
  const saved = new Map<string, unknown>(
    Object.entries(bringsSettings ? stored : { ...stored, settings: { warm: { mode: 'pings' } } }),
  )
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, options.env ?? { USERPROFILE: 'C:/Users/test' })
  on('store.get', ($, e) => ({ value: saved.get(e.key) }))
  on('store.set', ($, e) => {
    saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    saved.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...saved.keys()] }))
  on('settings.read', () => ({ value: options.settings ?? {} }))
  on('model.fork', async ($, e) => {
    forks.push(e.prompt)
    await options.forkGate?.(forks.length)
    if (options.forkThrows) return { deny: options.forkThrows }
    return { value: options.fork ?? PING_OK }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.compact', ($, e) => ({ messages: e.messages }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return options.beneath ? <Text>{options.beneath}</Text> : <Box />
  })
  on('session.usage', () => ({ value: usage(rateLimits, options.apiUsage ?? null, options.context?.total, options.breakdown) }))
  on('ui.notify', ($, e) => {
    notes.push(e.text)
    return { value: { isSent: true, channel: 'terminal_bell' } }
  })
  on('session.surfaces', () => ({ value: options.surfaces ?? (surface ? [surface] : []) }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: options.cwd ?? 'C:/proj' }))
  on('session.root', () => ({ value: 'C:/proj' }))
  // A file of the in-memory folder by its size (`size` for one standing in
  // for a large file), else the snapshot as `statMtimeMs` says.
  on('fs.stat', ($, e) => {
    const f = files.get(slash(e.path))
    if (f !== undefined) return { value: { kind: 'file', size: f.size ?? f.text.length, mtimeMs: f.mtimeMs, isLink: false } }
    return options.statMtimeMs === undefined
      ? { deny: 'ENOENT' }
      : { value: { kind: 'file', size: 1, mtimeMs: options.statMtimeMs, isLink: false } }
  })
  // git grep over the in-memory folder, for a transcript too large to read:
  // each line's matches of the title pattern; a failure if `git` is false.
  on('process.run', ($, e) => {
    if (options.git === false || e.argv[0] !== 'git') return { deny: 'ENOENT: git' }
    const file = files.get(`${slash(e.init?.cwd ?? '')}/${e.argv[e.argv.length - 1]}`)
    const found = (file?.text ?? '').match(/"type":"custom-title","customTitle":"(\\.|[^"])*"/g) ?? []
    runs.push(e.argv)
    const stdout = found.map(f => `${f}\n`).join('')
    return { value: { exitCode: found.length > 0 ? 0 : 1, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', ($, e) => {
    opens.push({ ...e })
    return { value: options.paneUnplaced ? { isPlaced: false, reason: options.paneUnplaced } : { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    closes.push(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: opens
      .filter(pane => !closes.includes(pane.id))
      .map(pane => ({ id: pane.id, title: pane.title ?? pane.id, isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('fs.write', ($, e) => {
    const path = slash(e.path)
    if (path.startsWith(`${SESSIONS_DIR}/`)) {
      sessionWrites.push({ path, text: e.text })
      files.set(path, { text: e.text, mtimeMs: clock.now() })
    } else {
      writes.push({ path: e.path, text: e.text })
    }
    return { value: undefined }
  })
  // A folder's files, and its folders (each that holds a file further down).
  on('fs.list', ($, e) => {
    const dir = `${slash(e.path)}/`
    const under = [...files].filter(([path]) => path.startsWith(dir))
    const fileEntries = under
      .filter(([path]) => !path.slice(dir.length).includes('/'))
      .map(([path, f]) => ({ name: path.slice(dir.length), kind: 'file' as const, size: f.text.length, mtimeMs: f.mtimeMs, isLink: false }))
    const folders = [...new Set(under.map(([path]) => path.slice(dir.length)).filter(rest => rest.includes('/')).map(rest => rest.split('/')[0]!))]
    return { value: [...fileEntries, ...folders.map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }))] }
  })
  on('fs.read', ($, e) => {
    const f = files.get(slash(e.path))
    return f === undefined ? { deny: 'ENOENT' } : { value: f.text }
  })
  on('fs.exists', ($, e) => ({ value: files.has(slash(e.path)) }))
  await $.session.start({ cwd: '.', surface, isInteractive: options.interactive ?? true })

  return { writes, saved, clock, forks, opens, closes, notes, sessionWrites, files, runs }
}

// `beneath`: text a mod beneath this one draws in the band, if any.
// `stored`: what the mod's store holds from earlier sessions.
async function start($: Engine, on: On, surface: Surface, rateLimits: SessionRateLimit[], beneath?: string, stored?: Record<string, unknown>, options: Boot = {}) {
  const { writes, saved, clock, forks, opens, closes, notes, sessionWrites, files, runs } = await boot($, on, surface, rateLimits, { ...options, beneath, stored })
  const ui = await $.ui.mount<Surface, 'AbovePrompt'>({ ...BAND, surface })
  await ui.resize({ columns: 116, rows: 8, in: 'band' })
  const band = async () => JSON.stringify(await ui.drawn({ in: 'band' }))

  // The whole drawing, the settings button beside the band included.
  const tree = async () => JSON.stringify(await ui.drawn())

  return { ui, band, tree, writes, saved, clock, forks, opens, closes, notes, sessionWrites, files, runs }
}

// One main-thread turn, started and ended at the clock's time now.
async function turn($: Engine, id = 't1') {
  await $.turn.start({ text: 'hi', turnId: id })
  await $.turn.complete({ answer: 'ok', durationMs: 5_000, isAborted: false, turnId: id, reason: 'answer', usage: TURN_USAGE })
}

describe('context bar', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: usage on top of context, a right click collapses it to one row with usage first`, async ($, on) => {
      const { ui, band } = await start($, on, surface, RATE_LIMITS)

      const expanded = await band()
      expect(expanded).toContain('"5H"')
      expect(expanded).toContain('"WK"')
      expect(expanded).toContain('"CTX"')
      expect(expanded).toContain('"62%"')
      expect(expanded).toContain('"21%"')
      expect(expanded).toContain('2h 14m')
      expect(expanded).toContain('3d 4h')
      expect(expanded).toContain('212k / 1M')
      expect(expanded).toContain('"flexGrow":6240')
      expect(expanded).toContain('"flexGrow":1860')
      // Fixed columns keep two cells of slack, so "CTX" never wraps on the desktop.
      expect(expanded).toContain(
        '{"width":5,"flexShrink":0},"children":[{"type":"Text","props":{"dimColor":true,"wrap":"truncate"},"children":["CTX"]}',
      )
      expect(expanded).toContain('"width":6,"flexShrink":0,"justifyContent":"flex-end"')
      // Pure proportion: no piece keeps a minimum cell, so the fill matches the percentage.
      expect(expanded).not.toContain('"minWidth":1')
      expect(expanded).toContain('"flexGrow":1,"minWidth":4,"height":1,"alignItems":"center"')
      // One palette: no third shade, track lighter than the reserve.
      expect(expanded).not.toContain('#1f2229')
      expect(expanded).not.toContain('█')
      if (surface === 'desktop') {
        // Gapless 60%-height boxes; no glyph runs.
        expect(expanded).toContain('"height":"60%"')
        expect(expanded).not.toContain('▄')
        // Track: the two usage meters and the context's free space (the TTL
        // row has no bar); the reserve past the auto-compact point is its own
        // darker shade.
        expect(count(expanded, '"backgroundColor":"#3d4250"')).toBe(3)
        expect(count(expanded, '"backgroundColor":"#2e3139"')).toBe(1)
        // Messages: the context bar's piece and the legend's swatch.
        expect(count(expanded, '"backgroundColor":"#d97757"')).toBe(2)
        // The one other filled box is the keep-warm chip, red with nothing cached.
        expect(count(expanded, `"backgroundColor":"${CHIP_COLD}"`)).toBe(1)
        expect(expanded).not.toContain(CHIP_OFF)
        expect(expanded).not.toContain(CHIP_ON)
      } else {
        // Clipped runs of lower blocks and no 60% box; the one box background
        // is the keep-warm chip.
        expect(expanded).toContain('▄')
        expect(count(expanded, '"backgroundColor"')).toBe(1)
        expect(expanded).not.toContain('"height":"60%"')
        expect(count(expanded, '"color":"#3d4250","wrap":"wrap"')).toBe(3)
        expect(count(expanded, '"color":"#2e3139","wrap":"wrap"')).toBe(1)
        expect(count(expanded, '"color":"#d97757","wrap":"wrap"')).toBe(2)
      }
      expect(expanded).toContain('"flexGrow":3760')
      // Rows in order: usage windows, then context, then the TTL row.
      expect(expanded.indexOf('"5H"')).toBeLessThan(expanded.indexOf('"WK"'))
      expect(expanded.indexOf('"WK"')).toBeLessThan(expanded.indexOf('"CTX"'))
      expect(expanded.indexOf('"CTX"')).toBeLessThan(expanded.indexOf('"TTL"'))
      // The TTL row before the first response: "--:-- / 60:00" in the plain
      // colour and the keep-warm Button reading "No Data" in a red chip. No
      // bar, no swatch, no source (an hour on a subscription, idle compaction
      // on), no caps. It comes after the legend.
      expect(expanded).toContain(timerTxt('--:-- / 60:00'))
      expect(expanded).toContain(keepWarmNoData(surface))
      expect(expanded.indexOf('agents 1.1k')).toBeLessThan(expanded.indexOf('"TTL"'))
      expect(expanded).not.toContain('cache-timer')
      expect(expanded).not.toContain('subscription')
      expect(expanded).not.toContain('idle compaction')
      expect(expanded).not.toContain('Pings:')
      expect(expanded).not.toContain(REFRESH_CAPS_KEY)
      // 62% is a warning, 31% and 21% are plain.
      expect(expanded).toContain('{"type":"Text","props":{"wrap":"truncate","color":"#e8c66a"},"children":["62%"]}')
      expect(expanded).toContain('{"type":"Text","props":{"wrap":"truncate"},"children":["31%"]}')
      expect(expanded).toContain('{"type":"Text","props":{"wrap":"truncate"},"children":["21%"]}')
      // The legend, indented under the bars, largest first, tokens only,
      // short names, no free; it wraps onto more lines rather than
      // overflowing the band.
      expect(expanded).toContain('"flexDirection":"row","flexWrap":"wrap","alignItems":"center","columnGap":3,"paddingLeft":7')
      // The CTX bar draws its categories largest first, like the legend:
      // messages (1860), tools (120), memory (49), system (34), mcp (26),
      // skills (22), agents (11), then free space (7380).
      const ctxGrows = [1860, 120, 49, 34, 26, 22, 11, 7380].map(g => expanded.indexOf(`"flexGrow":${g},`))
      expect(ctxGrows.every(i => i >= 0)).toBe(true)
      expect([...ctxGrows].sort((a, b) => a - b)).toEqual(ctxGrows)
      expect(expanded.indexOf('messages 186k')).toBeLessThan(expanded.indexOf('tools 12k'))
      expect(expanded.indexOf('tools 12k')).toBeLessThan(expanded.indexOf('system 3.4k'))
      expect(expanded).toContain('memory 4.9k')
      expect(expanded).toContain('mcp 2.6k')
      expect(expanded).not.toContain('0.3%')
      expect(expanded).not.toContain('free')
      expect(expanded).not.toContain('788k')
      // No compaction text: the darker reserve shows it.
      expect(expanded).not.toContain('compacts at')
      expect(expanded).not.toContain('buffer')

      await ui.pointer(rightClick)
      const collapsed = await band()
      expect(collapsed).not.toContain('borderStyle')
      // The table's typography: dim labels without colons, plain percentages
      // yellow from 50%, a dim detail; nothing bold, no badge, no separator.
      expect(collapsed).toContain('{"type":"Text","props":{"dimColor":true,"wrap":"truncate"},"children":["5H"]}')
      expect(collapsed).toContain('{"type":"Text","props":{"dimColor":true,"wrap":"truncate"},"children":["CTX"]}')
      expect(collapsed).toContain('{"type":"Text","props":{"wrap":"truncate","color":"#e8c66a"},"children":["62%"]}')
      expect(collapsed).toContain('{"type":"Text","props":{"wrap":"truncate"},"children":["31%"]}')
      expect(collapsed).toContain('{"type":"Text","props":{"wrap":"truncate"},"children":["21%"]}')
      expect(collapsed).toContain('{"type":"Text","props":{"dimColor":true,"wrap":"truncate"},"children":["212k / 1M"]}')
      expect(collapsed).not.toContain('"bold":true')
      expect(collapsed).not.toContain('5H: ')
      expect(collapsed).not.toContain('CTX: ')
      expect(collapsed).not.toContain(' of 1M')
      expect(collapsed).not.toContain('│')
      // At 116 columns two windows each get a 10-cell meter in the thin style,
      // and the context bar fills the rest.
      expect(count(collapsed, '"width":10,"height":1,"flexDirection":"row","alignItems":"center","flexShrink":0')).toBe(2)
      expect(collapsed).toContain('"flexGrow":6240')
      expect(collapsed).toContain('"flexGrow":3760')
      expect(collapsed).toContain('"flexGrow":3100')
      expect(collapsed).toContain('"flexGrow":6900')
      expect(collapsed).toContain('"flexGrow":1,"minWidth":4,"height":1,"alignItems":"center"')
      // The same leaf as the table on each surface: no full-height block.
      expect(collapsed).not.toMatch(/"height":1,"backgroundColor"/)
      if (surface === 'desktop') {
        expect(collapsed).toContain('"height":"60%"')
        expect(collapsed).not.toContain('▄')
        expect(count(collapsed, '"backgroundColor":"#3d4250"')).toBe(3)
        expect(count(collapsed, '"backgroundColor":"#2e3139"')).toBe(1)
        expect(count(collapsed, '"backgroundColor":"#d97757"')).toBe(1)
      } else {
        expect(collapsed).toContain('▄')
        expect(count(collapsed, '"backgroundColor"')).toBe(1)
        expect(count(collapsed, '"color":"#3d4250","wrap":"wrap"')).toBe(3)
        expect(count(collapsed, '"color":"#2e3139","wrap":"wrap"')).toBe(1)
        expect(count(collapsed, '"color":"#d97757","wrap":"wrap"')).toBe(1)
      }
      expect(collapsed).not.toContain('messages')
      expect(collapsed).not.toContain('compacts at')
      expect(collapsed).not.toContain('2h 14m')
      // The timer ends the line: the countdown as a chip that is its own
      // indicator, red with nothing cached, with no swatch beside it and
      // nothing else of the TTL row.
      expect(collapsed).toContain(cacheBtn(surface, '--:--', CHIP_COLD))
      expect(collapsed).not.toContain(KEEP_WARM_KEY)
      expect(collapsed).not.toContain('subscription')
      // Usage first, then the context in the table's order: label, bar,
      // percentage, detail; then the timer.
      const order = ['"5H"', '"62%"', '"WK"', '"31%"', '"CTX"', '"flexGrow":1860', '"21%"', '212k / 1M', '--:--'].map(s =>
        collapsed.indexOf(s),
      )
      expect(order.every(i => i >= 0)).toBe(true)
      expect([...order].sort((a, b) => a - b)).toEqual(order)

      // The next right click takes the bars away; the one after brings the table back.
      await ui.pointer(rightClick)
      const plain = await band()
      expect(plain).not.toContain('borderStyle')
      // Without bars no bar leaf is left: the timer's chip is the one coloured piece.
      expect(count(plain, surface === 'desktop' ? '"height":"60%"' : '"wrap":"wrap"')).toBe(0)
      expect(count(plain, '"backgroundColor"')).toBe(1)
      expect(plain).toContain('212k / 1M')
      expect(plain).toContain(cacheBtn(surface, '--:--', CHIP_COLD))
      await ui.pointer(rightClick)
      expect(await band()).toContain('messages')

      const off = await run($, '')
      expect(off.text).toBe('Token Watch banner hidden.')
      expect(JSON.stringify(await ui.drawn())).not.toContain('band.tsx')

      const shown = await run($, '')
      expect(shown.text).toBe('Token Watch banner shown.')
      expect(await band()).toContain('"CTX"')
    })

    test(`${surface}: a window the API adds later, such as Fable's, is drawn after 5H and WK`, async ($, on) => {
      const extra = [
        { kind: 'seven_day_fable', percentUsed: 88, resetsAt: SEVEN_DAY.resetsAt },
        { kind: 'mystery_window', percentUsed: 5 },
      ]
      const { ui, band } = await start($, on, surface, [...extra, ...RATE_LIMITS])

      const expanded = await band()
      expect(expanded).toContain('"FB"')
      expect(expanded).toContain('"88%"')
      expect(expanded).toContain('#e06c6c')
      expect(expanded).toContain('"mystery_window"')
      expect(expanded.indexOf('"WK"')).toBeLessThan(expanded.indexOf('"FB"'))
      // One row per window, so a third and fourth still leave room for the countdowns.
      expect(expanded).toContain('2h 14m')

      await ui.pointer(rightClick)
      const collapsed = await band()
      const order = ['"5H"', '"WK"', '"FB"', '"88%"', '"mystery_window"', '"CTX"', '212k / 1M'].map(s =>
        collapsed.indexOf(s),
      )
      expect(order.every(i => i >= 0)).toBe(true)
      expect([...order].sort((a, b) => a - b)).toEqual(order)
      expect(collapsed).toContain('{"type":"Text","props":{"wrap":"truncate","color":"#e06c6c"},"children":["88%"]}')
      // At 116 columns four windows' 10-cell meters would leave the context
      // bar too little room: they narrow to 6 cells and the detail stays;
      // wider, they return at 10.
      expect(collapsed).not.toContain('"width":10,"height":1')
      expect(count(collapsed, '"width":6,"height":1,"flexDirection":"row","alignItems":"center","flexShrink":0')).toBe(4)
      await ui.resize({ columns: 150, rows: 8, in: 'band' })
      const wide = await band()
      expect(count(wide, '"width":10,"height":1,"flexDirection":"row","alignItems":"center","flexShrink":0')).toBe(4)
      expect(wide).toContain('212k / 1M')
    })

    test(`${surface}: a narrow band leaves out the detail column, and the collapsed line its meters then its detail`, async ($, on) => {
      const { ui, band } = await start($, on, surface, RATE_LIMITS)
      await ui.resize({ columns: 44, rows: 8, in: 'band' })

      // At 44 columns the table has no detail column; the TTL row keeps its
      // timer and keep-warm button at every width, and never shows the source.
      const narrow = await band()
      expect(narrow).toContain('"62%"')
      expect(narrow).not.toContain('2h 14m')
      expect(narrow).not.toContain('212k / 1M')
      expect(narrow).toContain(keepWarmNoData(surface))
      expect(narrow).toContain(timerTxt('--:-- / 60:00'))
      expect(narrow).not.toContain('subscription')
      await ui.resize({ columns: 70, rows: 8, in: 'band' })
      const middling = await band()
      expect(middling).toContain(keepWarmNoData(surface))
      expect(middling).toContain(timerTxt('--:-- / 60:00'))
      expect(middling).toContain('212k / 1M')
      expect(middling).not.toContain('subscription')
      expect(middling).not.toContain('idle compaction')

      // Collapsed at 44 columns: labels, percentages, the context bar and the
      // timer, with no room for the detail; at 60 the detail is back and the
      // meters still out.
      await ui.resize({ columns: 44, rows: 8, in: 'band' })
      await ui.pointer(rightClick)
      const collapsed = await band()
      expect(collapsed).not.toContain('borderStyle')
      expect(collapsed).toContain('"62%"')
      expect(collapsed).toContain('"31%"')
      expect(collapsed).toContain('"CTX"')
      expect(collapsed).toContain('"21%"')
      expect(collapsed).toContain('"flexGrow":1860')
      expect(collapsed).toContain(cacheBtn(surface, '--:--', CHIP_COLD))
      expect(collapsed).not.toContain('212k / 1M')
      expect(collapsed).not.toContain('"width":10,"height":1')
      await ui.resize({ columns: 60, rows: 8, in: 'band' })
      const wider = await band()
      expect(wider).toContain('212k / 1M')
      expect(wider).not.toContain('"width":10,"height":1')
    })

    test(`${surface}: another mod's drawing in the band stays, above this one`, async ($, on) => {
      // Stands for a mod beneath this one (Replay Theater's hint) drawing in the band.
      const { ui } = await start($, on, surface, RATE_LIMITS, 'Replay: 1 edit')
      const tree = JSON.stringify(await ui.drawn())
      expect(tree).toContain('Replay: 1 edit')
      expect(tree).toContain('band.tsx')
      expect(tree.indexOf('Replay: 1 edit')).toBeLessThan(tree.indexOf('band.tsx'))
    })

    test(`${surface}: a new session shows the last usage seen until its first response`, async ($, on) => {
      // Saved by an earlier session: 5H still running, and an old weekly
      // window and Fable allowance whose reset times have passed. Both have
      // started over, so they show 0% rather than their old figures.
      const past = new Date(NOW - MINUTE).toISOString()
      const saved = [
        FIVE_HOUR,
        { kind: 'seven_day', percentUsed: 90, resetsAt: past },
        { kind: 'seven_day_fable', percentUsed: 70, resetsAt: past },
      ]
      const { band } = await start($, on, surface, [], undefined, { limits: saved })
      const expanded = await band()
      expect(expanded).toContain('"5H"')
      expect(expanded).toContain('2h 14m')
      expect(expanded).toContain('"WK"')
      expect(expanded).toContain('"FB"')
      expect(count(expanded, '"0%"')).toBe(2)
      expect(expanded).not.toContain('90%')
      expect(expanded).not.toContain('70%')
    })

    test(`${surface}: a reading that leaves out a window keeps it until its reset time`, async ($, on) => {
      // Saved: 5H at 62%, still running, and a Fable allowance past its reset.
      // The first reading reports only the weekly window: 5H keeps its
      // figures, the allowance is no longer part of the plan.
      const saved = [
        FIVE_HOUR,
        { kind: 'seven_day_fable', percentUsed: 70, resetsAt: new Date(NOW - MINUTE).toISOString() },
      ]
      const { band } = await start($, on, surface, [SEVEN_DAY], undefined, { limits: saved })
      const expanded = await band()
      expect(expanded).toContain('"5H"')
      expect(expanded).toContain('"62%"')
      expect(expanded).toContain('"WK"')
      expect(expanded).toContain('"31%"')
      expect(expanded).not.toContain('"FB"')
    })

    test(`${surface}: a right click cycles the three views and saves the choice; a left click does nothing`, async ($, on) => {
      const { ui, band, saved } = await start($, on, surface, RATE_LIMITS)
      const barLeaf = surface === 'desktop' ? '"height":"60%"' : '"wrap":"wrap"'

      await ui.pointer(leftClick)
      expect(await band()).toContain('borderStyle')
      expect(saved.get('view')).toBeUndefined()

      await ui.pointer(rightClick)
      const bars = await band()
      expect(bars).not.toContain('borderStyle')
      expect(bars).toContain(barLeaf)
      expect(saved.get('view')).toBe('bars')
      await ui.pointer(leftClick)
      expect(await band()).toContain(barLeaf)

      await ui.pointer(rightClick)
      const plain = await band()
      expect(plain).not.toContain('borderStyle')
      expect(count(plain, barLeaf)).toBe(0)
      expect(plain).toContain('"62%"')
      expect(plain).toContain('"CTX"')
      expect(plain).toContain('212k / 1M')
      expect(plain).toContain(cacheBtn(surface, '--:--', CHIP_COLD))
      expect(saved.get('view')).toBe('plain')
      await ui.pointer(leftClick)
      expect(count(await band(), barLeaf)).toBe(0)

      await ui.pointer(rightClick)
      expect(await band()).toContain('borderStyle')
      expect(saved.get('view')).toBe('expanded')
    })

    test(`${surface}: a new session restores the saved view`, async ($, on) => {
      const barLeaf = surface === 'desktop' ? '"height":"60%"' : '"wrap":"wrap"'
      // Saved by 1.2: the collapsed line with its bars.
      const first = await start($, on, surface, RATE_LIMITS, undefined, { view: 'bars' })
      const bars = await first.band()
      expect(bars).not.toContain('borderStyle')
      expect(bars).toContain(barLeaf)
    })

    test(`${surface}: the 1.1 keys isCollapsed and showBars become the view they meant, and are removed`, async ($, on) => {
      const barLeaf = surface === 'desktop' ? '"height":"60%"' : '"wrap":"wrap"'
      const { ui, band, saved } = await start($, on, surface, RATE_LIMITS, undefined, { showBars: false, isCollapsed: true })
      const plain = await band()
      expect(plain).not.toContain('borderStyle')
      expect(count(plain, barLeaf)).toBe(0)
      expect(saved.get('view')).toBe('plain')
      expect(saved.has('isCollapsed')).toBe(false)
      expect(saved.has('showBars')).toBe(false)
      // Expanded, the table has its bars all the same.
      await ui.pointer(rightClick)
      expect(await band()).toContain('borderStyle')
      expect(await band()).toContain(barLeaf)
    })

    test(`${surface}: with no plan limits (an API key) only the context shows, and the TTL is five minutes`, async ($, on) => {
      const { ui, band, writes } = await start($, on, surface, [])

      const expanded = await band()
      expect(expanded).not.toContain('"5H"')
      expect(expanded).toContain('"CTX"')
      // The band shows the five minutes; the source is in the snapshot, not the band.
      expect(expanded).toContain(timerTxt('--:-- / 5:00'))
      expect(expanded).not.toContain('API key or cloud')
      expect(expanded).not.toContain('idle compaction')
      expect(snapshotOf(writes).cache).toMatchObject({ ttl: '5m', ttlSource: 'API key or cloud' })

      await ui.pointer(rightClick)
      const collapsed = await band()
      expect(collapsed).not.toContain('5H')
      expect(collapsed).not.toContain('│')
      expect(collapsed).toContain('"CTX"')
      expect(collapsed).toContain('212k / 1M')
      expect(collapsed).not.toContain('"width":10,"height":1')
    })
  }
})

// A five-minute session (FORCE_PROMPT_CACHING_5M), where a ping goes out 75 s
// before the believed expiry: 3:45 after a response, then every 3:45.
const FIVE_M = { env: { USERPROFILE: 'C:/Users/test', FORCE_PROMPT_CACHING_5M: '1' } }
const PING_AT = 3 * MINUTE + 45_000

describe('prompt cache', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: the TTL row counts down from the end of the last response, ticks each second, and goes cold`, async ($, on) => {
      const { ui, band, clock } = await start($, on, surface, RATE_LIMITS)
      await turn($)
      // An hour on a subscription: the timer at the whole TTL, over the TTL.
      const fresh = await band()
      expect(fresh).toContain(timerTxt('60:00 / 60:00'))
      expect(fresh).toContain(keepWarmOff(surface))
      expect(fresh).not.toContain('"flexGrow":10000')
      // The Client's frame clock moves the countdown between the hooks module's readings.
      await ui.advance(1000)
      expect(await band()).toContain(timerTxt('59:59 / 60:00'))
      // The hooks module's clock reads every 30 s; the frame clock carries the
      // seconds between (the kit moves the two separately).
      await clock.advance(12 * MINUTE + 30_000)
      expect(await band()).toContain(timerTxt('47:30 / 60:00'))
      await ui.advance(18_000)
      expect(await band()).toContain(timerTxt('47:12 / 60:00'))
      // Past the hour the cache is cold: the timer reads "--:--" in the plain
      // colour, and the button turns red and says "Cache Lost".
      await clock.advance(47 * MINUTE + 30_000)
      const cold = await band()
      expect(cold).toContain(timerTxt('--:-- / 60:00'))
      expect(cold).toContain(keepWarmCold(surface))
      // The text line says the cache is lost.
      expect((await run($, 'text')).text).toContain('TTL lost (1h · subscription)')
      // Pressed now, it does not start keep-warm and says why.
      await ui.press({ key: 'keep-warm' })
      expect(await band()).toContain('keep-warm: the cache is already lost')
      expect(await band()).toContain(keepWarmCold(surface))
      // The collapsed timer: "--:--" in a red chip.
      await ui.pointer(rightClick)
      const collapsed = await band()
      expect(collapsed).toContain(cacheBtn(surface, '--:--', CHIP_COLD))
      expect(collapsed).not.toContain(CHIP_OFF)
    })

    test(`${surface}: a band drawn again shows the time left, not a clock from before`, async ($, on) => {
      const { ui, band, clock } = await start($, on, surface, RATE_LIMITS)
      await turn($)
      // Twenty minutes, as a session sees them: the frame clock ticks, then
      // the hooks module's reading catches up.
      await ui.advance(20 * MINUTE)
      await clock.advance(20 * MINUTE)
      await ui.advance(1_000)
      expect(await band()).toContain(timerTxt('39:59 / 60:00'))
      // Hidden and shown: still the time left. (The kit keeps this instance,
      // so this alone passes on a module-wide clock too.)
      await run($, '')
      await run($, '')
      expect(await band()).toContain(timerTxt('39:59 / 60:00'))
      // Remounted, a new instance: the time left, not twenty minutes more.
      await ui.unmount()
      const again = await $.ui.mount<Surface, 'AbovePrompt'>({ ...BAND, surface })
      await again.resize({ columns: 116, rows: 8, in: 'band' })
      const drawn = JSON.stringify(await again.drawn({ in: 'band' }))
      expect(drawn).toContain(timerTxt('40:00 / 60:00'))
    })

    test(`${surface}: while a turn runs the timer shows the whole TTL`, async ($, on) => {
      const { band } = await start($, on, surface, RATE_LIMITS)
      await $.turn.start({ text: 'hi', turnId: 't1' })
      expect(await band()).toContain(timerTxt('60:00 / 60:00'))
    })

    test(`${surface}: pressing the button or the timer before any response leaves keep-warm off and says why`, async ($, on) => {
      const { ui, band, forks } = await start($, on, surface, RATE_LIMITS)
      await ui.press({ key: 'keep-warm' })
      const after = await band()
      expect(after).toContain(keepWarmNoData(surface))
      expect(after).toContain(timerTxt('--:-- / 60:00'))
      expect(after).toContain('keep-warm: nothing cached yet')
      expect(forks.length).toBe(0)
      // The collapsed timer is the same control: it leaves keep-warm off too.
      await ui.pointer(rightClick)
      await ui.press({ key: 'cache-timer' })
      expect(await band()).toContain(cacheBtn(surface, '--:--', CHIP_COLD))
      await ui.pointer(rightClick)
      await ui.pointer(rightClick)
      const expanded = await band()
      expect(expanded).toContain(keepWarmNoData(surface))
      expect(expanded).toContain('keep-warm: nothing cached yet')
      expect(forks.length).toBe(0)
    })

    test(`${surface}: the expanded row's button and the collapsed views' timer both toggle keep-warm`, async ($, on) => {
      const { ui, band } = await start($, on, surface, RATE_LIMITS)
      await turn($)
      await ui.press({ key: 'keep-warm' })
      const on1 = await band()
      expect(on1).toContain(keepWarmOn(surface))
      expect(on1).not.toContain(keepWarmOff(surface))
      expect(on1).toContain(timerTxt('60:00 / 60:00'))
      expect(on1).toContain('Pings: 0/8  Time: 00:00 / 8:00:00')
      expect(on1).toContain(refreshCapsBtn(surface))
      // No TTL source and no timer Button in the expanded row.
      expect(on1).not.toContain('subscription')
      expect(on1).not.toContain('cache-timer')
      await ui.press({ key: 'keep-warm' })
      const off1 = await band()
      expect(off1).toContain(keepWarmOff(surface))
      expect(off1).not.toContain('Pings:')
      expect(off1).not.toContain(REFRESH_CAPS_KEY)
      await ui.pointer(rightClick)
      await ui.press({ key: 'cache-timer' })
      expect(await band()).toContain(cacheBtn(surface, '60:00', CHIP_ON))
      await ui.pointer(rightClick)
      await ui.press({ key: 'cache-timer' })
      expect(await band()).toContain(cacheBtn(surface, '60:00', CHIP_OFF))
    })

    test(`${surface}: the button reads Let Chill in green while keep-warm is on and Keep Warm in grey while it is off`, async ($, on) => {
      const { ui, band } = await start($, on, surface, RATE_LIMITS)
      await turn($)
      expect(await band()).toContain(keepWarmOff(surface))
      await ui.press({ key: 'keep-warm' })
      const on1 = await band()
      // Both surfaces draw the same chip: a filled Box around a plain Button,
      // green while on; the Refresh Caps chip beside it stays grey.
      expect(on1).toContain(keepWarmOn(surface))
      expect(count(on1, `"backgroundColor":"${CHIP_ON}"`)).toBe(1)
      expect(count(on1, `"backgroundColor":"${CHIP_OFF}"`)).toBe(1)
      expect(on1).not.toContain('"variant"')
      await ui.press({ key: 'keep-warm' })
      const off1 = await band()
      expect(off1).toContain(keepWarmOff(surface))
      expect(off1).not.toContain(CHIP_ON)
    })

    test(`${surface}: a terminal centres the button's label in ten cells so the caps after it stay put; the desktop does not`, async ($, on) => {
      const { ui, band, clock } = await start($, on, surface, RATE_LIMITS)
      const labelOf = (s: string) => s.match(/"key":"keep-warm","label":"([^"]*)"/)?.[1] ?? ''
      const labels = [labelOf(await band())]
      await turn($)
      labels.push(labelOf(await band()))
      await ui.press({ key: 'keep-warm' })
      labels.push(labelOf(await band()))
      await ui.press({ key: 'keep-warm' })
      await clock.advance(61 * MINUTE)
      labels.push(labelOf(await band()))
      const p = pad(surface)
      if (surface === 'terminal') {
        const n = '\u00a0'
        expect(labels).toEqual([
          `${p}${n}No Data${n}${n}${p}`,
          `${p}Keep Warm${n}${p}`,
          `${p}Let Chill${n}${p}`,
          `${p}Cache Lost${p}`,
        ])
        expect(new Set(labels.map(l => l.length))).toEqual(new Set([12]))
      } else {
        expect(labels).toEqual([`${p}No Data${p}`, `${p}Keep Warm${p}`, `${p}Let Chill${p}`, `${p}Cache Lost${p}`])
      }
    })

    test(`${surface}: keep-warm pings 75 s before the expiry, shows the ping's counts, moves the countdown on, and stops at the cap`, { timeoutMs: 30_000 }, async ($, on) => {
      const { ui, band, clock, forks, writes } = await start($, on, surface, RATE_LIMITS, undefined, undefined, FIVE_M)
      await turn($)
      const first = await band()
      expect(first).toContain(timerTxt('5:00 / 5:00'))
      expect(first).not.toContain('FORCE_PROMPT_CACHING_5M')
      await ui.press({ key: 'keep-warm' })
      await clock.advance(PING_AT - 1000)
      expect(forks.length).toBe(0)
      await clock.advance(1000)
      expect(forks).toEqual(['Reply with the single word: ok'])
      const pinged = await band()
      expect(pinged).toContain('ping read 34k · wrote 14k')
      expect(pinged).toContain(timerTxt('5:00 / 5:00'))
      // Once the hooks module's 30-second clock has ticked past the note's minute,
      // the note is gone and the caps stay; the next ping comes 3:45 after the first.
      await clock.advance(75_000)
      const capped = await band()
      expect(capped).toContain('Pings: 1/30  Time: 05:00 / 2:00:00')
      expect(capped).not.toContain('ping read')
      await clock.advance(PING_AT - 75_000 - 1000)
      expect(forks.length).toBe(1)
      await clock.advance(1000)
      expect(forks.length).toBe(2)
      const snapshot = snapshotOf(writes)
      expect(snapshot.cache).toMatchObject({ ttl: '5m', ttlSource: 'FORCE_PROMPT_CACHING_5M', warm: true })
      expect(snapshot.cache.expiresAt).toBe(new Date(NOW + 2 * PING_AT + 5 * MINUTE).toISOString())
      expect(snapshot.cache.keepWarm).toMatchObject({ on: true, pings: 2, maxPings: 30, maxMs: 2 * 60 * MINUTE })
      expect(snapshot.cache.keepWarm.lastPing).toEqual({ at: new Date(NOW + 2 * PING_AT).toISOString(), read: 33_510, wrote: 13_714 })
      // 30 pings is the cap: the 31st is not sent, and keep-warm says so.
      for (let i = 2; i < 31; i++) await clock.advance(PING_AT)
      expect(forks.length).toBe(30)
      const stopped = await band()
      expect(stopped).toContain('stopped: 30 pings')
      expect(stopped).toContain(keepWarmOff(surface))
    })

    test(`${surface}: a ping that reads almost nothing stops keep-warm: the cache was cold`, async ($, on) => {
      const { ui, band, clock, forks } = await start($, on, surface, RATE_LIMITS, undefined, undefined, {
        ...FIVE_M,
        fork: PING_COLD,
        apiUsage: LAST_RESPONSE,
      })
      await turn($)
      await ui.press({ key: 'keep-warm' })
      await clock.advance(PING_AT)
      expect(forks.length).toBe(1)
      const stopped = await band()
      expect(stopped).toContain('stopped: the ping found the cache lost')
      expect(stopped).toContain(timerTxt('--:-- / 5:00'))
      expect(stopped).toContain(keepWarmCold(surface))
      await ui.pointer(rightClick)
      const collapsed = await band()
      expect(collapsed).toContain(cacheBtn(surface, '--:--', CHIP_COLD))
    })

    test(`${surface}: two failed pings in a row stop keep-warm`, async ($, on) => {
      const { ui, band, clock, forks } = await start($, on, surface, RATE_LIMITS, undefined, undefined, { ...FIVE_M, fork: PING_FAILED })
      await turn($)
      await ui.press({ key: 'keep-warm' })
      await clock.advance(PING_AT)
      expect(forks.length).toBe(1)
      expect(await band()).toContain('ping failed: overloaded')
      expect(await band()).toContain(keepWarmOn(surface))
      await clock.advance(30_000)
      expect(forks.length).toBe(2)
      expect(await band()).toContain('stopped: 2 pings failed in a row')
      expect(await band()).toContain(keepWarmOff(surface))
    })

    test(`${surface}: a fork that throws counts as a failed ping; two stop keep-warm`, async ($, on) => {
      const { ui, band, clock, forks } = await start($, on, surface, RATE_LIMITS, undefined, undefined, { ...FIVE_M, forkThrows: 'socket hang up' })
      await turn($)
      await ui.press({ key: 'keep-warm' })
      await clock.advance(PING_AT)
      expect(forks.length).toBe(1)
      const failed = await band()
      expect(failed).toContain('ping failed: ')
      expect(failed).toContain('socket hang up')
      expect(await band()).toContain(keepWarmOn(surface))
      await clock.advance(30_000)
      expect(forks.length).toBe(2)
      expect(await band()).toContain('stopped: 2 pings failed in a row')
      expect(await band()).toContain(keepWarmOff(surface))
    })

    test(`${surface}: a prompt from the person turns keep-warm off; a background delivery does not`, async ($, on) => {
      const { ui, band, clock, forks } = await start($, on, surface, RATE_LIMITS, undefined, undefined, FIVE_M)
      await turn($)
      await ui.press({ key: 'keep-warm' })
      await $.prompt.submit({ text: 'later', wait: false, origin: { kind: 'task-notification' } })
      expect(await band()).toContain(keepWarmOn(surface))
      await $.prompt.submit({ text: 'back', wait: false, origin: { kind: 'composer' } })
      expect(await band()).toContain(keepWarmOff(surface))
      await clock.advance(5 * MINUTE)
      expect(forks.length).toBe(0)
    })

    test(`${surface}: no ping while a turn runs; the response restarts the countdown`, async ($, on) => {
      const { ui, clock, forks } = await start($, on, surface, RATE_LIMITS, undefined, undefined, FIVE_M)
      await turn($)
      await ui.press({ key: 'keep-warm' })
      await clock.advance(100_000)
      await $.turn.start({ text: 'more', turnId: 't2' })
      await clock.advance(5 * MINUTE)
      expect(forks.length).toBe(0)
      await $.turn.complete({ answer: 'ok', durationMs: 5_000, isAborted: false, turnId: 't2', reason: 'answer', usage: TURN_USAGE })
      await clock.advance(PING_AT - 1000)
      expect(forks.length).toBe(0)
      await clock.advance(1000)
      expect(forks.length).toBe(1)
    })

    test(`${surface}: compaction stops keep-warm and restarts the countdown; /clear forgets the cache`, async ($, on) => {
      const { ui, band, clock } = await start($, on, surface, RATE_LIMITS, undefined, undefined, FIVE_M)
      await turn($)
      await ui.press({ key: 'keep-warm' })
      await clock.advance(MINUTE)
      expect(await band()).toContain(timerTxt('4:00 / 5:00'))
      await $.session.compact({ trigger: 'manual', messages: [MESSAGE] })
      const compacted = await band()
      expect(compacted).toContain(keepWarmOff(surface))
      expect(compacted).toContain('stopped: compaction')
      expect(compacted).toContain(timerTxt('5:00 / 5:00'))
      await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } })
      const cleared = await band()
      expect(cleared).toContain(timerTxt('--:-- / 5:00'))
      expect(cleared).toContain(keepWarmNoData(surface))
    })

    // The TTL follows Claude Code's controls in their order of precedence, then
    // the plan. The band no longer says where the TTL comes from, so the
    // precedence is asserted where the source is still reported: the snapshot's
    // ttlSource and the /token-watch text line.
    const TTL_CASES: [string, Boot, SessionRateLimit[], '5m' | '1h', string][] = [
      ['FORCE_PROMPT_CACHING_5M beats the TTL variable', { env: { USERPROFILE: 'C:/Users/test', FORCE_PROMPT_CACHING_5M: '1', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' } }, RATE_LIMITS, '5m', 'FORCE_PROMPT_CACHING_5M'],
      ['the TTL variable beats the setting', { env: { USERPROFILE: 'C:/Users/test', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, settings: { promptCacheTtl: '5m' } }, [], '1h', 'CLAUDE_CODE_PROMPT_CACHE_TTL'],
      ['the setting beats the plan', { settings: { promptCacheTtl: '5m' } }, RATE_LIMITS, '5m', 'promptCacheTtl'],
      ['ENABLE_PROMPT_CACHING_1H beats the plan', { env: { USERPROFILE: 'C:/Users/test', ENABLE_PROMPT_CACHING_1H: '1' } }, [], '1h', 'ENABLE_PROMPT_CACHING_1H'],
      ['a window at 100% means usage credits: five minutes', {}, [{ kind: 'five_hour', percentUsed: 100 }, SEVEN_DAY], '5m', 'over plan limit'],
    ]
    for (const [name, options, limits, ttl, source] of TTL_CASES) {
      test(`${surface}: TTL: ${name}`, async ($, on) => {
        const { band, writes } = await start($, on, surface, limits, undefined, undefined, options)
        await turn($)
        const full = ttl === '1h' ? '60:00' : '5:00'
        expect(snapshotOf(writes).cache).toMatchObject({ ttl, ttlSource: source })
        expect((await run($, 'text')).text).toContain(`TTL ${full} (${ttl} · ${source})`)
        // The band shows the TTL as its denominator, and neither the source
        // nor idle compaction.
        const drawn = await band()
        expect(drawn).toContain(timerTxt(`${full} / ${full}`))
        expect(drawn).not.toContain(source)
        expect(drawn).not.toContain('idle compaction')
      })
    }

    test(`${surface}: on the hour the first ping comes 8 minutes early; a hit confirms the hour and renews it, so the next ping comes 52 minutes later`, async ($, on) => {
      const { ui, band, clock, forks, writes } = await start($, on, surface, RATE_LIMITS)
      await turn($)
      await ui.press({ key: 'keep-warm' })
      await clock.advance(52 * MINUTE - 1000)
      expect(forks.length).toBe(0)
      await clock.advance(1000)
      expect(forks.length).toBe(1)
      expect(snapshotOf(writes).cache).toMatchObject({ ttl: '1h', ttlSource: 'confirmed' })
      expect(await band()).toContain(timerTxt('60:00 / 60:00'))
      // The ping renewed the entries it read for their hour (run B1), so the
      // next ping comes 8 minutes before that hour runs out: at 104 minutes.
      await clock.advance(52 * MINUTE - 1000)
      expect(forks.length).toBe(1)
      await clock.advance(1000)
      expect(forks.length).toBe(2)
    })

    test(`${surface}: keep-warm's caps, its Refresh caps button and the note need 90 columns`, async ($, on) => {
      const { ui, band, clock } = await start($, on, surface, RATE_LIMITS, undefined, undefined, FIVE_M)
      await turn($)
      await ui.press({ key: 'keep-warm' })
      await clock.advance(PING_AT)
      const wide = await band()
      expect(wide).toContain('Pings: 1/30  Time: 03:45 / 2:00:00')
      expect(wide).toContain(refreshCapsBtn(surface))
      expect(wide).toContain('ping read 34k · wrote 14k')
      await ui.resize({ columns: 89, rows: 8, in: 'band' })
      const narrow = await band()
      expect(narrow).toContain(keepWarmOn(surface))
      expect(narrow).toContain(timerTxt('5:00 / 5:00'))
      expect(narrow).not.toContain('Pings:')
      expect(narrow).not.toContain(REFRESH_CAPS_KEY)
      expect(narrow).not.toContain('ping read')
      await ui.resize({ columns: 90, rows: 8, in: 'band' })
      const edge = await band()
      expect(edge).toContain('Pings: 1/30')
      expect(edge).toContain(refreshCapsBtn(surface))
    })

    test(`${surface}: Refresh caps starts the caps over while keep-warm stays on, and the next ping keeps its time`, async ($, on) => {
      const { ui, band, clock, forks, writes } = await start($, on, surface, RATE_LIMITS, undefined, undefined, FIVE_M)
      await turn($)
      await ui.press({ key: 'keep-warm' })
      await clock.advance(PING_AT)
      expect(forks.length).toBe(1)
      await clock.advance(30_000)
      const before = await band()
      // (The band's time follows the hooks module's 30-second readings.)
      expect(before).toContain('Pings: 1/30  Time: 04:00 / 2:00:00')
      expect(before).toContain('ping read 34k · wrote 14k')

      await ui.press({ key: 'refresh-caps' })
      const after = await band()
      // The counts start over, the note goes, and keep-warm is still on.
      expect(after).toContain('Pings: 0/30  Time: 00:00 / 2:00:00')
      expect(after).not.toContain('ping read')
      expect(after).toContain(keepWarmOn(surface))
      expect(after).toContain(refreshCapsBtn(surface))
      const snapshot = snapshotOf(writes)
      expect(snapshot.cache.keepWarm).toMatchObject({ on: true, pings: 0, startedAt: new Date(NOW + PING_AT + 30_000).toISOString() })

      // The ping schedule did not move: the next ping comes 3:45 after the
      // first, as it would have without the press.
      await clock.advance(PING_AT - 30_000 - 1000)
      expect(forks.length).toBe(1)
      await clock.advance(1000)
      expect(forks.length).toBe(2)
      expect(await band()).toContain('Pings: 1/30')
    })

    test(`${surface}: Refresh caps also clears the failure count, so one more failed ping does not stop keep-warm`, async ($, on) => {
      const { ui, band, clock, forks } = await start($, on, surface, RATE_LIMITS, undefined, undefined, { ...FIVE_M, fork: PING_FAILED })
      await turn($)
      await ui.press({ key: 'keep-warm' })
      await clock.advance(PING_AT)
      expect(forks.length).toBe(1)
      expect(await band()).toContain('ping failed: overloaded')
      await ui.press({ key: 'refresh-caps' })
      expect(await band()).not.toContain('ping failed')
      // The retry still comes 30 s after the failure; with the count cleared
      // this is a first failure again, not the second.
      await clock.advance(30_000)
      expect(forks.length).toBe(2)
      const after = await band()
      expect(after).toContain('ping failed: overloaded')
      expect(after).not.toContain('stopped: 2 pings failed in a row')
      expect(after).toContain(keepWarmOn(surface))
    })

    test(`${surface}: Refresh caps does nothing while keep-warm is off, and is not drawn`, async ($, on) => {
      const { ui, band, writes, forks } = await start($, on, surface, RATE_LIMITS, undefined, undefined, FIVE_M)
      await turn($)
      const before = await band()
      expect(before).not.toContain(REFRESH_CAPS_KEY)
      expect(before).not.toContain('Pings:')
      const written = writes.length
      // There is no such Button to press, and a message that arrives anyway
      // (a stale view) changes nothing.
      await expect(ui.press({ key: 'refresh-caps' })).rejects.toThrow()
      await ui.post({ action: 'refresh-caps' })
      const after = await band()
      expect(after).toContain(keepWarmOff(surface))
      expect(after).not.toContain('Pings:')
      expect(after).not.toContain(REFRESH_CAPS_KEY)
      expect(after).not.toContain('keep-warm:')
      expect(snapshotOf(writes).cache.keepWarm).toMatchObject({ on: false, pings: 0, startedAt: null })
      expect(writes.length).toBe(written)
      expect(forks.length).toBe(0)
      // And it does not turn keep-warm on.
      await ui.pointer(rightClick)
      expect(await band()).toContain(cacheBtn(surface, '5:00', CHIP_OFF))
    })
  }
})

// What keeps keep-warm from spending when it should not. These follow the
// hooks module, the same on every surface, so they run on the terminal.
describe('keep-warm safety', () => {
  test('a ping still out holds the next: the heartbeat arms none until it answers', async ($, on) => {
    const held = gate()
    const { ui, band, clock, forks, writes } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, {
      ...FIVE_M,
      forkGate: () => held.opened,
    })
    await turn($)
    await ui.press({ key: 'keep-warm' })
    await clock.advance(PING_AT)
    expect(forks.length).toBe(1)
    // Two heartbeats while the fork is out: neither sends another.
    await clock.advance(60_000)
    expect(forks.length).toBe(1)
    held.open()
    await clock.advance(1_000)
    expect(await band()).toContain('Pings: 1/30')
    expect(snapshotOf(writes).cache.keepWarm.pings).toBe(1)
    // The answer armed the next ping 3:45 after the first was sent.
    await clock.advance(PING_AT - 61_000 - 1_000)
    expect(forks.length).toBe(1)
    await clock.advance(1_000)
    expect(forks.length).toBe(2)
  })

  test('a ping still out past the expiry decides for itself: a warm answer keeps keep-warm on', async ($, on) => {
    const held = gate()
    const { ui, band, clock, forks } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, {
      ...FIVE_M,
      forkGate: () => held.opened,
    })
    await turn($)
    await ui.press({ key: 'keep-warm' })
    await clock.advance(PING_AT)
    // Past the believed expiry while the ping is out: the heartbeat waits for it.
    await clock.advance(90_000)
    expect(await band()).not.toContain('stopped:')
    held.open()
    await clock.advance(1_000)
    const after = await band()
    expect(after).toContain('ping read 34k · wrote 14k')
    expect(after).toContain(keepWarmOn('terminal'))
    expect(forks.length).toBe(1)
  })

  test('a ping that never answers is given up on: keep-warm stops as cold, and pings resume once it is on again', async ($, on) => {
    const held = gate()
    const { ui, band, clock, forks } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, {
      ...FIVE_M,
      forkGate: () => held.opened,
    })
    await turn($)
    await ui.press({ key: 'keep-warm' })
    await clock.advance(PING_AT)
    expect(forks.length).toBe(1)
    // Two minutes unanswered, and the cache past its expiry: given up on.
    await clock.advance(2 * MINUTE + 30_000)
    expect(await band()).toContain('stopped: cache lost')
    // A new response, keep-warm on again: the lost ping holds nothing.
    await turn($, 't2')
    await ui.press({ key: 'keep-warm' })
    await clock.advance(PING_AT)
    expect(forks.length).toBe(2)
    // Both answer now. The lost one's answer is ignored: one ping counted.
    held.open()
    await clock.advance(1_000)
    const after = await band()
    expect(after).toContain('Pings: 1/30')
    expect(after).toContain(keepWarmOn('terminal'))
  })

  test('failures are counted on keep-warm as it is now: Refresh Caps during a retry forgets the first', async ($, on) => {
    const held = gate()
    const { ui, band, clock, forks } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, {
      ...FIVE_M,
      fork: PING_FAILED,
      forkGate: n => (n === 2 ? held.opened : undefined),
    })
    await turn($)
    await ui.press({ key: 'keep-warm' })
    await clock.advance(PING_AT)
    expect(await band()).toContain('ping failed: overloaded')
    // The retry goes out and is held; Refresh Caps clears the count meanwhile.
    await clock.advance(30_000)
    expect(forks.length).toBe(2)
    await ui.press({ key: 'refresh-caps' })
    held.open()
    await clock.advance(1_000)
    const after = await band()
    expect(after).toContain('ping failed: overloaded')
    expect(after).not.toContain('stopped: 2 pings failed in a row')
    expect(after).toContain(keepWarmOn('terminal'))
  })

  test('keep-warm turned off and on during a retry starts with no failures', async ($, on) => {
    const held = gate()
    const { ui, band, clock, forks } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, {
      ...FIVE_M,
      fork: PING_FAILED,
      forkGate: n => (n === 2 ? held.opened : undefined),
    })
    await turn($)
    await ui.press({ key: 'keep-warm' })
    await clock.advance(PING_AT)
    await clock.advance(30_000)
    expect(forks.length).toBe(2)
    await ui.press({ key: 'keep-warm' })
    await ui.press({ key: 'keep-warm' })
    held.open()
    await clock.advance(1_000)
    const after = await band()
    expect(after).not.toContain('stopped: 2 pings failed in a row')
    expect(after).toContain(keepWarmOn('terminal'))
  })

  test('nothing to fork stops keep-warm and says so', async ($, on) => {
    const nothing: ModelForkResult = { isAnswered: false, reason: 'nothing-to-fork' }
    const { ui, band, clock, forks } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, { ...FIVE_M, fork: nothing })
    await turn($)
    await ui.press({ key: 'keep-warm' })
    await clock.advance(PING_AT)
    const after = await band()
    expect(after).toContain('stopped: nothing cached yet')
    expect(after).toContain(keepWarmOff('terminal'))
    await clock.advance(10 * MINUTE)
    expect(forks.length).toBe(1)
  })

  test("a subagent's turn neither holds the pings nor freezes the countdown", async ($, on) => {
    const { ui, band, clock, forks } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, FIVE_M)
    await turn($)
    await ui.press({ key: 'keep-warm' })
    await clock.advance(MINUTE)
    await $.turn.start({ text: 'look around', turnId: 'a1', agentId: 'agent-1' })
    await $.turn.complete({
      answer: 'done',
      durationMs: 5_000,
      isAborted: false,
      turnId: 'a1',
      agentId: 'agent-1',
      reason: 'answer',
      usage: TURN_USAGE,
    })
    expect(await band()).toContain(timerTxt('4:00 / 5:00'))
    await clock.advance(PING_AT - MINUTE)
    expect(forks.length).toBe(1)
  })

  test('a precompute leaves keep-warm on; a compaction stops it', async ($, on) => {
    const { ui, band, clock, forks } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, FIVE_M)
    await turn($)
    await ui.press({ key: 'keep-warm' })
    await $.session.compact({ trigger: 'precompute', messages: [MESSAGE] })
    const after = await band()
    expect(after).toContain(keepWarmOn('terminal'))
    expect(after).not.toContain('stopped: compaction')
    await clock.advance(PING_AT)
    expect(forks.length).toBe(1)
    await $.session.compact({ trigger: 'auto', messages: [MESSAGE] })
    expect(await band()).toContain('stopped: compaction')
  })

  for (const reason of ['resume', 'logout', 'prompt_input_exit', 'other'] as const) {
    test(`the session ending (${reason}) turns keep-warm off`, async ($, on) => {
      const { ui, band, clock, forks, writes } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, FIVE_M)
      await turn($)
      await ui.press({ key: 'keep-warm' })
      await $.session.end({ reason, sessionId: 'sess-1', resume: { id: 'sess-1' } })
      expect(snapshotOf(writes).cache.keepWarm.on).toBe(false)
      // A resume or a logout goes on under another session: its cache is unknown.
      const goesOn = reason === 'resume' || reason === 'logout'
      expect(await band()).toContain(goesOn ? keepWarmNoData('terminal') : keepWarmOff('terminal'))
      await clock.advance(10 * MINUTE)
      expect(forks.length).toBe(0)
    })
  }

  test('an empty reply was still served: its counts are read like an answer', async ($, on) => {
    const empty: ModelForkResult = { isAnswered: false, reason: 'empty-reply', usage: PING_OK.usage }
    const { ui, band, clock } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, { ...FIVE_M, fork: empty })
    await turn($)
    await ui.press({ key: 'keep-warm' })
    await clock.advance(PING_AT)
    const after = await band()
    expect(after).toContain('ping read 34k · wrote 14k')
    expect(after).toContain('Pings: 1/30')
    expect(after).not.toContain('ping failed')
    expect(after).toContain(keepWarmOn('terminal'))
  })

  test('the time cap: turns that keep the cache warm push the pings out, and the first one past 8 hours stops keep-warm', { timeoutMs: 60_000 }, async ($, on) => {
    const { ui, band, clock, forks } = await start($, on, 'terminal', RATE_LIMITS)
    await turn($)
    await ui.press({ key: 'keep-warm' })
    // A turn every 40 minutes for 7h20: each restarts the hour, so no ping is due.
    for (let i = 1; i <= 11; i++) {
      await clock.advance(40 * MINUTE)
      await turn($, `t${i}`)
    }
    expect(forks.length).toBe(0)
    // The next ping would go out 52 minutes after the last turn, at 8h12.
    await clock.advance(52 * MINUTE)
    expect(forks.length).toBe(0)
    expect(await band()).toContain('stopped: 8:00:00 reached')
    expect(await band()).toContain(keepWarmOff('terminal'))
  })
})

// The settings panel as the engine raises it once open: docked, 52 columns.
const PANE = {
  plugin: 'token-watch',
  component: 'Pane',
  requestId: 'token-watch-settings',
  props: { title: 'TW Settings', isFocused: false, bodyColumns: 52, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

// The sub-sections a section holds, opened with it by mountPanel.
const SUBSECTIONS: Record<string, string[]> = {
  'usage-5H': ['show', 'alert', 'forecast', 'pace'].map(sub => `usage-5H-${sub}`),
  'usage-WK': ['show', 'alert', 'forecast', 'pace'].map(sub => `usage-WK-${sub}`),
  'usage-other': ['show', 'alert', 'forecast', 'pace'].map(sub => `usage-other-${sub}`),
  context: ['context-show', 'context-alert'],
  cache: ['cache-show', 'cache-warm', 'cache-limits'],
}

// The settings panel mounted: with `scope: 'global'` switched to edit every
// session's settings (it opens on this session's), and the sections in
// `open` opened, in order ('usage' before 'usage-5H'), each with its
// sub-sections (any the scope does not draw, such as a usage window's alerts
// in this session's, left alone).
async function mountPanel($: Engine, surface: Surface, options: { scope?: 'global'; open?: string[] } = {}) {
  const pane = await $.ui.mount<Surface, 'Pane'>({ ...PANE, surface })
  if (options.scope === 'global') await pane.press({ key: 'scope-global' })
  for (const id of options.open ?? []) {
    await pane.press({ key: `section-${id}` })
    for (const sub of SUBSECTIONS[id] ?? []) await pane.press({ key: `section-${sub}` }).catch(() => {})
  }
  const drawn = async () => JSON.stringify(await pane.drawn())
  return { pane, drawn }
}

// A checkbox as the panel draws it: its mark and its label in one plain
// Button; ☑ / ☐ on the desktop, ● / ○ in a terminal. The label's start, up to
// the space after the mark.
const toggle = (surface: Surface, key: string, isOn: boolean) =>
  `"key":"${key}","label":"${surface === 'terminal' ? (isOn ? '●' : '○') : isOn ? '☑' : '☐'} `
// A radio button the same way: ◉ / ○ on the desktop, ● / ○ in a terminal.
const radio = (surface: Surface, key: string, label: string, isOn: boolean) =>
  `"key":"${key}","label":"${isOn ? (surface === 'terminal' ? '●' : '◉') : '○'} ${label}","plain":true`

// Settings, as the store keeps them, that hide these parts in every view.
const hiddenEverywhere = (...parts: string[]) => ({
  show: Object.fromEntries(parts.map(part => [part, { plain: false, bars: false, expanded: false }])),
})

// The store key of this session's own settings ($.session.id answers sess-1).
const SESSION_KEY = 'session:sess-1'

describe('settings panel', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: a section's heading is one plain Button, [▸] / [▾] and its title, bold for a section, not for a row`, async ($, on) => {
      await start($, on, surface, RATE_LIMITS)
      const { pane, drawn } = await mountPanel($, surface)
      expect(await drawn()).toContain(
        '{"type":"Button","props":{"key":"section-usage","label":"[▸] Usage","plain":true},',
      )
      await pane.press({ key: 'section-usage' })
      await pane.press({ key: 'section-usage-5H' })
      const opened = await drawn()
      expect(opened).toContain('"key":"section-usage","label":"[▾] Usage","plain":true}')
      expect(opened).toContain('"children":["[▾] ",{"type":"Text","props":{"bold":true')
      expect(opened).toContain('"key":"section-usage-5H-show","label":"[▸] Show on banner","plain":true}')
      expect(opened).toContain('"children":["[▸] ",{"type":"Text","children":["Show on banner"]}]')
    })

    test(`${surface}: every Button is plain; checkboxes and radio buttons hold their labels; steppers, resets and Enable bracketed`, async ($, on) => {
      await start($, on, surface, RATE_LIMITS)
      // usage-5H opens with its rows: Show on banner, Burn rate and the rest.
      const { pane, drawn } = await mountPanel($, surface, { open: ['usage', 'usage-5H'] })
      await pane.press({ key: 'show-5H-expanded' })
      const all = await drawn()
      expect(all).toContain(`${toggle(surface, 'show-5H-plain', true)}Minimal","plain":true`)
      expect(all).toContain(`${toggle(surface, 'show-5H-expanded', false)}Expanded","plain":true`)
      expect(all).toContain(radio(surface, 'scope-session', 'Session', true))
      expect(all).toContain(radio(surface, 'scope-global', 'Global', false))
      expect(all).toContain(radio(surface, 'unit-5H-h', '%/h', true))
      expect(all).toContain('"key":"window-5H-down","label":"[-]","plain":true')
      expect(all).toContain('"key":"window-5H-up","label":"[+]","plain":true')
      expect(all).toContain('"key":"reset-show-5H","label":"[Reset]","plain":true')
      expect(all).toContain('"key":"reset-session","label":"[Reset to global]","plain":true')
      // No Button keeps the native frame; no mark is bracketed; and a label
      // is never drawn beside its mark's Button.
      expect(count(all, '"type":"Button"')).toBe(count(all, '"plain":true'))
      for (const glyph of ['−', '[●]', '[○]', '[☑]', '[☐]']) expect(all).not.toContain(glyph)
      expect(all).not.toContain('"children":["Minimal"]')
      // The terminal never draws ☑ (it may be a wide emoji there).
      if (surface === 'terminal') for (const glyph of ['☑', '☐', '◉']) expect(all).not.toContain(glyph)
      // A usage window's alert is in every session's scope alone.
      await pane.press({ key: 'scope-global' })
      await pane.press({ key: 'section-usage-5H-alert' })
      expect(await drawn()).toContain('"key":"alert-5H-enable","label":"[Enable]","plain":true')
      expect(await drawn()).toContain('"key":"reset-defaults","label":"[Reset to defaults]","plain":true')
    })

    test(`${surface}: a settings button beside the expanded band opens the panel; the collapsed views have none`, async ($, on) => {
      const { ui, band, tree, opens } = await start($, on, surface, RATE_LIMITS)
      // Outside the band's own drawing, so a press on it is the person's.
      expect(await tree()).toContain(`"key":"settings","label":"${surface === 'terminal' ? '[≡]' : '☰'}"`)
      expect(await band()).not.toContain('"key":"settings"')
      await ui.press({ key: 'settings' })
      expect(opens).toEqual([{ id: 'token-watch-settings', title: 'TW Settings', columns: 52 }])
      await ui.pointer(rightClick)
      expect(await tree()).not.toContain('"key":"settings"')
    })

    test(`${surface}: sections open and close; a part shows or hides in each view on its own, and is saved`, async ($, on) => {
      const { ui, band, saved } = await start($, on, surface, RATE_LIMITS)
      const { pane, drawn } = await mountPanel($, surface, { scope: 'global' })
      expect(await drawn()).not.toContain('"key":"show-5H-plain"')
      await pane.press({ key: 'section-usage' })
      await pane.press({ key: 'section-usage-5H' })
      // Each row is a section of its own too.
      expect(await drawn()).not.toContain('"key":"show-5H-plain"')
      await pane.press({ key: 'section-usage-5H-show' })
      for (const v of ['plain', 'bars', 'expanded']) expect(await drawn()).toContain(toggle(surface, `show-5H-${v}`, true))
      expect(await drawn()).toContain('OTH')

      await pane.press({ key: 'show-5H-expanded' })
      expect(saved.get('settings')).toMatchObject({ show: { '5H': { plain: true, bars: true, expanded: false } } })
      expect(await drawn()).toContain(toggle(surface, 'show-5H-expanded', false))
      expect(await band()).not.toContain('"5H"')
      expect(await band()).toContain('"WK"')
      // The collapsed view still shows it.
      await ui.pointer(rightClick)
      expect(await band()).toContain('"5H"')

      await pane.press({ key: 'section-usage-5H' })
      expect(await drawn()).not.toContain('"key":"show-5H-plain"')
    })
  }

  test('hiding CTX in a view takes its legend there; the other views keep it', async ($, on) => {
    const { ui, band } = await start($, on, 'terminal', RATE_LIMITS)
    const { pane } = await mountPanel($, 'terminal', { scope: 'global', open: ['context'] })
    await pane.press({ key: 'show-CTX-expanded' })
    const expanded = await band()
    expect(expanded).not.toContain('"CTX"')
    expect(expanded).not.toContain('messages 186k')
    expect(expanded).toContain('"TTL"')
    await ui.pointer(rightClick)
    expect(await band()).toContain('"CTX"')
  })

  test('keep-warm runs while a view shows the cache, the settings button marked where none does; hidden in every view, it stops', async ($, on) => {
    const { ui, band, tree, clock, forks, writes } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, FIVE_M)
    await turn($)
    await ui.press({ key: 'keep-warm' })
    const { pane } = await mountPanel($, 'terminal', { open: ['cache'] })
    await pane.press({ key: 'show-TTL-plain' })
    expect(snapshotOf(writes).cache.keepWarm.on).toBe(true)
    // The minimal view, which hides the cache: the button shows, marked.
    await ui.pointer(rightClick)
    await ui.pointer(rightClick)
    expect(await band()).not.toContain('cache-timer')
    expect(await tree()).toContain('"key":"settings","label":"[≡●]"')
    await pane.press({ key: 'show-TTL-bars' })
    await pane.press({ key: 'show-TTL-expanded' })
    expect(snapshotOf(writes).cache.keepWarm.on).toBe(false)
    expect(await tree()).not.toContain('≡●')
    await ui.post({ action: 'keep-warm' })
    expect(snapshotOf(writes).cache.keepWarm.on).toBe(false)
    await clock.advance(10 * MINUTE)
    expect(forks.length).toBe(0)
  })

  test('with every part hidden, a collapsed view keeps the settings button, the way back', async ($, on) => {
    const { tree, band } = await start($, on, 'terminal', RATE_LIMITS, undefined, {
      view: 'bars',
      settings: hiddenEverywhere('5H', 'WK', 'other', 'CTX', 'TTL'),
    })
    expect(await band()).not.toContain('"WK"')
    expect(await tree()).toContain('"key":"settings"')
  })

  test('with every part hidden, the expanded band says so', async ($, on) => {
    const { band } = await start($, on, 'terminal', RATE_LIMITS, undefined, {
      settings: hiddenEverywhere('5H', 'WK', 'other', 'CTX', 'TTL'),
    })
    expect(await band()).toContain('All parts are hidden.')
  })

  test("1.3.0's saved parts and caps carry over: a hidden part hidden in every view", async ($, on) => {
    const { ui, band, writes } = await start($, on, 'terminal', RATE_LIMITS, undefined, {
      hidden: ['WK', 'nonsense', 3],
      caps: { '1h': { pings: 12, hours: 10 }, '5m': { pings: 30, hours: 2 } },
    })
    await turn($)
    expect(await band()).not.toContain('"WK"')
    await ui.pointer(rightClick)
    expect(await band()).not.toContain('"WK"')
    expect(snapshotOf(writes).cache.keepWarm).toMatchObject({ maxPings: 12, maxMs: 10 * 60 * MINUTE })
  })

  test('saved settings are read leaf by leaf: a leaf that fails its check is its default', async ($, on) => {
    const { band, writes } = await start($, on, 'terminal', RATE_LIMITS, undefined, {
      settings: {
        show: { WK: { expanded: false, bars: 'yes' } },
        caps: { '5m': { pings: 33, hours: 4 } },
        pace: { '5H': { windowMin: 45, unit: 'day' } },
      },
    }, FIVE_M)
    await turn($)
    expect(await band()).not.toContain('"WK"')
    // 33 pings is off the five-minute stepper's grid of 5: the default 30 stands.
    expect(snapshotOf(writes).cache.keepWarm).toMatchObject({ maxPings: 30, maxMs: 4 * 60 * MINUTE })
    const { drawn } = await mountPanel($, 'terminal', { scope: 'global', open: ['usage', 'usage-5H'] })
    expect(await drawn()).toContain('"30 min"')
    expect(await drawn()).toContain(radio('terminal', 'unit-5H-h', '%/h', true))
  })

  test('saved settings that are not an object are the defaults', async ($, on) => {
    const { band, writes } = await start($, on, 'terminal', RATE_LIMITS, undefined, { settings: 'junk' })
    await turn($)
    expect(await band()).toContain('"WK"')
    expect(snapshotOf(writes).cache.keepWarm).toMatchObject({ maxPings: 8, maxMs: 8 * 60 * MINUTE })
  })

  test('/token-watch settings opens the panel', async ($, on) => {
    const { opens } = await start($, on, 'terminal', RATE_LIMITS)
    expect((await run($, 'settings')).text).toBe('TW Settings opened.')
    expect(opens).toEqual([{ id: 'token-watch-settings', title: 'TW Settings', columns: 52 }])
  })

  test('where no surface places the panel, /token-watch settings closes it and says why', async ($, on) => {
    const { closes } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, { paneUnplaced: 'no-surface' })
    expect((await run($, 'settings')).text).toBe("TW Settings: the panel can't be shown here (no-surface).")
    expect(closes).toEqual(['token-watch-settings'])
  })

  test("the cache's limits move this TTL's caps a step at a time, within bounds, and are saved", async ($, on) => {
    const { ui, band, saved, writes } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, FIVE_M)
    await turn($)
    const { pane, drawn } = await mountPanel($, 'terminal', { scope: 'global', open: ['cache'] })
    expect(await drawn()).toContain('Limits (5m TTL)')
    await pane.press({ key: 'pings-up' })
    for (let i = 0; i < 5; i++) await pane.press({ key: 'hours-up' })
    // Six hours is the most on five minutes: one more press changes nothing.
    expect(saved.get('settings')).toMatchObject({ caps: { '5m': { pings: 35, hours: 6 } } })
    await pane.press({ key: 'hours-up' })
    expect(saved.get('settings')).toMatchObject({ caps: { '5m': { pings: 35, hours: 6 } } })
    expect(snapshotOf(writes).cache.keepWarm).toMatchObject({ maxPings: 35, maxMs: 6 * 60 * MINUTE })
    await ui.press({ key: 'keep-warm' })
    expect(await band()).toContain('Pings: 0/35  Time: 00:00 / 6:00:00')
  })

  test('on the hour the limits go 1 to 24 pings and hours, a step of one', async ($, on) => {
    const { saved } = await start($, on, 'terminal', RATE_LIMITS)
    await turn($)
    const { pane, drawn } = await mountPanel($, 'terminal', { scope: 'global', open: ['cache'] })
    expect(await drawn()).toContain('Limits (1h TTL)')
    for (let i = 0; i < 8; i++) await pane.press({ key: 'pings-down' })
    for (let i = 0; i < 17; i++) await pane.press({ key: 'hours-up' })
    expect(saved.get('settings')).toMatchObject({ caps: { '1h': { pings: 1, hours: 24 }, '5m': { pings: 30, hours: 2 } } })
  })

  test('keep-warm stops at the caps the panel set', { timeoutMs: 30_000 }, async ($, on) => {
    const { ui, band, clock, forks } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, FIVE_M)
    await turn($)
    const { pane } = await mountPanel($, 'terminal', { open: ['cache'] })
    // Five pings is the least on five minutes: further presses stay there.
    for (let i = 0; i < 6; i++) await pane.press({ key: 'pings-down' })
    await ui.press({ key: 'keep-warm' })
    for (let i = 0; i < 6; i++) await clock.advance(PING_AT)
    expect(forks.length).toBe(5)
    expect(await band()).toContain('stopped: 5 pings')
  })

  test('a running keep-warm already past a lowered ping cap stops at once, saying why', async ($, on) => {
    const { ui, band, clock, forks } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, FIVE_M)
    await turn($)
    await ui.press({ key: 'keep-warm' })
    for (let i = 0; i < 7; i++) await clock.advance(PING_AT)
    expect(forks.length).toBe(7)
    const { pane } = await mountPanel($, 'terminal', { open: ['cache'] })
    // 30, 25, 20, 15, 10: still above 7 pings, so keep-warm goes on.
    for (let i = 0; i < 4; i++) await pane.press({ key: 'pings-down' })
    expect(await band()).toContain('Pings: 7/10')
    expect(await band()).toContain(keepWarmOn('terminal'))
    // 5: below what it has sent. It stops now, not at its next ping.
    await pane.press({ key: 'pings-down' })
    const after = await band()
    expect(after).toContain('stopped: 5 pings')
    expect(after).toContain(keepWarmOff('terminal'))
    await clock.advance(10 * MINUTE)
    expect(forks.length).toBe(7)
  })

  test('a running keep-warm already past a lowered time cap stops at once', { timeoutMs: 30_000 }, async ($, on) => {
    const { ui, band, clock, forks } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, FIVE_M)
    await turn($)
    await ui.press({ key: 'keep-warm' })
    for (let i = 0; i < 17; i++) await clock.advance(PING_AT)
    expect(forks.length).toBe(17)
    const { pane } = await mountPanel($, 'terminal', { open: ['cache'] })
    // On for 63:45 of a two-hour cap; one hour is less than that.
    await pane.press({ key: 'hours-down' })
    expect(await band()).toContain('stopped: 1:00:00 reached')
    await clock.advance(10 * MINUTE)
    expect(forks.length).toBe(17)
  })

  test('another session hid the cache in every view in the shared store: on reload keep-warm stops and sends nothing', async ($, on) => {
    const { ui, saved, clock, forks, writes } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, FIVE_M)
    await turn($)
    await ui.press({ key: 'keep-warm' })
    saved.set('settings', hiddenEverywhere('TTL'))
    // A hot reload runs session.start again: $.state keeps keep-warm on.
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    expect(snapshotOf(writes).cache.keepWarm.on).toBe(false)
    await clock.advance(10 * MINUTE)
    expect(forks.length).toBe(0)
  })
})

describe('settings scopes', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: the panel edits this session by default: a toggle overrides the global setting here only, and reset gives it back`, async ($, on) => {
      const { band, saved } = await start($, on, surface, RATE_LIMITS)
      const { pane, drawn } = await mountPanel($, surface, { open: ['usage', 'usage-5H'] })
      expect(await drawn()).toContain(radio(surface, 'scope-session', 'Session', true))
      expect(await drawn()).toContain(radio(surface, 'scope-global', 'Global', false))
      await pane.press({ key: 'show-5H-expanded' })
      expect(saved.get(SESSION_KEY)).toMatchObject({ settings: { show: { '5H': { expanded: false } } } })
      expect(saved.get('settings')).toEqual({ warm: { mode: 'pings' } })
      expect(await band()).not.toContain('"5H"')
      expect(await drawn()).toContain('"key":"reset-show-5H"')
      await pane.press({ key: 'reset-show-5H' })
      expect(saved.has(SESSION_KEY)).toBe(false)
      expect(await band()).toContain('"5H"')
      expect(await drawn()).not.toContain('"key":"reset-show-5H"')
    })
  }

  test('a setting put back to the global value no longer overrides it', async ($, on) => {
    const { saved } = await start($, on, 'terminal', RATE_LIMITS)
    const { pane } = await mountPanel($, 'terminal', { open: ['usage', 'usage-5H'] })
    await pane.press({ key: 'show-5H-expanded' })
    expect(saved.get(SESSION_KEY)).toMatchObject({ settings: { show: { '5H': { expanded: false } } } })
    await pane.press({ key: 'show-5H-expanded' })
    expect(saved.has(SESSION_KEY)).toBe(false)
  })

  test("a session's own setting wins over the global one; every session's view notes it", async ($, on) => {
    const { band, saved } = await start($, on, 'terminal', RATE_LIMITS, undefined, { settings: hiddenEverywhere('WK') })
    expect(await band()).not.toContain('"WK"')
    const { pane, drawn } = await mountPanel($, 'terminal', { open: ['usage', 'usage-WK'] })
    await pane.press({ key: 'show-WK-expanded' })
    expect(saved.get(SESSION_KEY)).toMatchObject({ settings: { show: { WK: { expanded: true } } } })
    expect(await band()).toContain('"WK"')
    await pane.press({ key: 'scope-global' })
    const global = await drawn()
    expect(global).toContain(toggle('terminal', 'show-WK-expanded', false))
    expect(global).toContain('overridden in Session')
    expect(global).not.toContain('"key":"reset-show-WK"')
  })

  test("another session's global change reaches this one at the next heartbeat, except where this session has its own", async ($, on) => {
    const { band, clock, saved } = await start($, on, 'terminal', RATE_LIMITS, undefined, {
      [SESSION_KEY]: { settings: { show: { CTX: { expanded: true } } }, seenAt: NOW },
    })
    expect(await band()).toContain('"5H"')
    // Another session writes the shared store.
    saved.set('settings', hiddenEverywhere('5H', 'CTX'))
    await clock.advance(30_000)
    const after = await band()
    expect(after).not.toContain('"5H"')
    expect(after).toContain('"CTX"')
  })

  test('another session hides the cache everywhere for all sessions: keep-warm here stops at the next heartbeat', async ($, on) => {
    const { ui, clock, forks, writes, saved } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, FIVE_M)
    await turn($)
    await ui.press({ key: 'keep-warm' })
    saved.set('settings', hiddenEverywhere('TTL'))
    await clock.advance(30_000)
    expect(snapshotOf(writes).cache.keepWarm.on).toBe(false)
    await clock.advance(10 * MINUTE)
    expect(forks.length).toBe(0)
  })

  test("caps in this session's scope: an override, and a reset per cap", async ($, on) => {
    const { ui, band, saved } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, FIVE_M)
    await turn($)
    const { pane } = await mountPanel($, 'terminal', { open: ['cache'] })
    await pane.press({ key: 'pings-up' })
    expect(saved.get(SESSION_KEY)).toMatchObject({ settings: { caps: { '5m': { pings: 35 } } } })
    expect(saved.get('settings')).toEqual({ warm: { mode: 'pings' } })
    await ui.press({ key: 'keep-warm' })
    expect(await band()).toContain('Pings: 0/35  Time: 00:00 / 2:00:00')
    await pane.press({ key: 'reset-caps-5m-pings' })
    expect(await band()).toContain('Pings: 0/30')
    await pane.press({ key: 'hours-up' })
    expect(saved.get(SESSION_KEY)).toMatchObject({ settings: { caps: { '5m': { hours: 3 } } } })
    await pane.press({ key: 'reset-caps-5m-hours' })
    expect(saved.has(SESSION_KEY)).toBe(false)
    expect(await band()).toContain('Time: 00:00 / 2:00:00')
  })

  test('Reset this session clears every setting of its own', async ($, on) => {
    const { band, saved } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, FIVE_M)
    await turn($)
    const { pane } = await mountPanel($, 'terminal', { open: ['usage', 'usage-5H', 'cache'] })
    await pane.press({ key: 'show-5H-expanded' })
    await pane.press({ key: 'unit-5H-min' })
    await pane.press({ key: 'pings-up' })
    expect(saved.get(SESSION_KEY)).toMatchObject({
      settings: { show: { '5H': { expanded: false } }, pace: { '5H': { unit: 'min' } }, caps: { '5m': { pings: 35 } } },
    })
    await pane.press({ key: 'reset-session' })
    expect(saved.has(SESSION_KEY)).toBe(false)
    expect(await band()).toContain('"5H"')
  })

  test("Reset to defaults puts every session's settings back; a session's own stay over them", async ($, on) => {
    const { band, saved } = await start($, on, 'terminal', RATE_LIMITS, undefined, {
      settings: { ...hiddenEverywhere('WK'), caps: { '1h': { pings: 12, hours: 10 } } },
      [SESSION_KEY]: { settings: { show: { CTX: { expanded: false } } }, seenAt: NOW },
    })
    expect(await band()).not.toContain('"WK"')
    const { pane, drawn } = await mountPanel($, 'terminal', { scope: 'global' })
    expect(await drawn()).not.toContain('"key":"reset-session"')
    await pane.press({ key: 'reset-defaults' })
    expect(saved.get('settings')).toMatchObject({
      show: { WK: { plain: true, bars: true, expanded: true } },
      caps: { '1h': { pings: 8, hours: 8 } },
    })
    const after = await band()
    expect(after).toContain('"WK"')
    expect(after).not.toContain('"CTX"')
  })

  test("a session's own settings are restored and kept fresh on start; ones left 30 days, or unreadable, are pruned", async ($, on) => {
    const { band, saved } = await start($, on, 'terminal', RATE_LIMITS, undefined, {
      [SESSION_KEY]: { settings: { show: { WK: { expanded: false } } }, seenAt: NOW - 24 * 60 * MINUTE },
      'session:old': { settings: { show: { CTX: { expanded: false } } }, seenAt: NOW - 31 * 24 * 60 * MINUTE },
      'session:junk': 'nonsense',
    })
    expect(await band()).not.toContain('"WK"')
    expect(saved.has('session:old')).toBe(false)
    expect(saved.has('session:junk')).toBe(false)
    expect(saved.get(SESSION_KEY)).toMatchObject({ settings: { show: { WK: { expanded: false } } }, seenAt: NOW })
  })
})

// The 5-hour window at a new percentage, read on the next measure.
const fiveHourAt = (limits: SessionRateLimit[], percentUsed: number) => {
  limits[1] = { ...FIVE_HOUR, percentUsed }
}

describe('burn rate', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: a window's pace and how long until it fills, or Safe; the collapsed line shows the pace where it is on`, async ($, on) => {
      const limits = [...RATE_LIMITS]
      // The pace shows in the table alone by default; here in the collapsed view too.
      const { ui, band, clock } = await start($, on, surface, limits, undefined, {
        settings: { pace: { '5H': { show: { bars: true } } } },
      })
      await clock.advance(10 * MINUTE)
      fiveHourAt(limits, 67.4)
      await $.session.measure(MEASURE)
      // 5 points in 10 minutes: 30 an hour; the 32.6 left fill in 65 minutes,
      // before the reset at 2h 14m. WK is flat: 0.0%/h, and Safe.
      const expanded = await band()
      expect(expanded).toContain('"30%/h"')
      expect(expanded).toContain('"color":"#e06c6c"},"children":["1h 05m"]')
      expect(expanded).toContain('"0.0%/h"')
      expect(expanded).toContain('"color":"#8fd18f"},"children":["Safe"]')
      // The collapsed line: the pace, and by default no forecast.
      await ui.pointer(rightClick)
      const collapsed = await band()
      expect(collapsed).toContain('"30%/h"')
      expect(collapsed).not.toContain('1h 05m')
    })
  }

  test('Safe when the window would reset before it fills', async ($, on) => {
    const limits = [...RATE_LIMITS]
    const { band, clock } = await start($, on, 'terminal', limits)
    await clock.advance(10 * MINUTE)
    fiveHourAt(limits, 62.9)
    await $.session.measure(MEASURE)
    // 3 an hour: 37.1 left takes over 12 hours, past the reset at 2h 14m.
    expect(await band()).toContain('"3.0%/h"')
    // Both windows Safe: WK is flat.
    expect(count(await band(), '"Safe"')).toBe(2)
  })

  test('no pace before the window holds 5 minutes of readings', async ($, on) => {
    const limits = [...RATE_LIMITS]
    const { band, clock } = await start($, on, 'terminal', limits)
    await clock.advance(4 * MINUTE)
    fiveHourAt(limits, 67.4)
    await $.session.measure(MEASURE)
    expect(await band()).not.toContain('%/h')
    // At 5 minutes it shows: 5 points in 5 minutes, 60 an hour.
    await clock.advance(MINUTE)
    expect(await band()).toContain('"60%/h"')
  })

  test("the panel's window and unit change a window's pace", async ($, on) => {
    const limits = [...RATE_LIMITS]
    const { band, clock } = await start($, on, 'terminal', limits)
    await clock.advance(30 * MINUTE)
    fiveHourAt(limits, 63.4)
    await $.session.measure(MEASURE)
    await clock.advance(10 * MINUTE)
    fiveHourAt(limits, 66.4)
    await $.session.measure(MEASURE)
    // The value when a window began lies on the line between the readings
    // either side of it. Over 30 minutes: from 62.73 (a third of the way from
    // 62.4 to 63.4) to 66.4, 7.3 an hour. Over 15: from 63.23 to 66.4, 12.7 an
    // hour, 0.21 a minute.
    expect(await band()).toContain('"7.3%/h"')
    const { pane } = await mountPanel($, 'terminal', { open: ['usage', 'usage-5H'] })
    await pane.press({ key: 'window-5H-down' })
    expect(await band()).toContain('"13%/h"')
    await pane.press({ key: 'unit-5H-min' })
    expect(await band()).toContain('"0.21%/min"')
  })

  test('WK offers windows of 2 to 24 hours and %/h or %/day', async ($, on) => {
    await start($, on, 'terminal', RATE_LIMITS)
    const { pane, drawn } = await mountPanel($, 'terminal', { scope: 'global', open: ['usage', 'usage-WK'] })
    expect(await drawn()).toContain('"6 h"')
    for (let i = 0; i < 3; i++) await pane.press({ key: 'window-WK-up' })
    expect(await drawn()).toContain('"24 h"')
    expect(await drawn()).toContain(radio('terminal', 'unit-WK-h', '%/h', true))
    expect(await drawn()).toContain('"key":"unit-WK-day"')
    expect(await drawn()).not.toContain('"key":"unit-WK-min"')
  })

  test('a forecast turned on for a collapsed view shows there', async ($, on) => {
    const limits = [...RATE_LIMITS]
    const { ui, band, clock } = await start($, on, 'terminal', limits)
    await clock.advance(10 * MINUTE)
    fiveHourAt(limits, 67.4)
    await $.session.measure(MEASURE)
    const { pane } = await mountPanel($, 'terminal', { open: ['usage', 'usage-5H'] })
    await pane.press({ key: 'forecast-5H-bars' })
    await ui.pointer(rightClick)
    await ui.resize({ columns: 150, rows: 8, in: 'band' })
    expect(await band()).toContain('"1h 05m"')
    // WK's forecast is still the table's alone.
    expect(await band()).not.toContain('"Safe"')
  })

  test('a window that resets starts its pace over', async ($, on) => {
    const limits = [...RATE_LIMITS]
    const { band, clock } = await start($, on, 'terminal', limits)
    await clock.advance(10 * MINUTE)
    fiveHourAt(limits, 67.4)
    await $.session.measure(MEASURE)
    expect(await band()).toContain('"30%/h"')
    const resetsAt = new Date(NOW + 5 * 60 * MINUTE).toISOString()
    limits[1] = { kind: 'five_hour', percentUsed: 2, resetsAt }
    await $.session.measure(MEASURE)
    expect(await band()).not.toContain('"30%/h"')
    // The new period's pace, from its own samples: 5 points in 10 minutes
    // (the last period's would put its start at 62.4%, and read 0).
    await clock.advance(10 * MINUTE)
    limits[1] = { kind: 'five_hour', percentUsed: 7, resetsAt }
    await $.session.measure(MEASURE)
    expect(await band()).toContain('"30%/h"')
  })

  test('a window full already reads Full in red, never Safe', async ($, on) => {
    const limits = [...RATE_LIMITS]
    const { band, clock } = await start($, on, 'terminal', limits)
    await clock.advance(10 * MINUTE)
    fiveHourAt(limits, 100)
    await $.session.measure(MEASURE)
    expect(await band()).toContain('"color":"#e06c6c"},"children":["Full"]')
  })

  test("once a window's reset time passes, its last period's pace goes, until a reading starts the new one", { timeoutMs: 30_000 }, async ($, on) => {
    const limits = [...RATE_LIMITS]
    const { band, clock } = await start($, on, 'terminal', limits)
    await clock.advance(10 * MINUTE)
    fiveHourAt(limits, 67.4)
    await $.session.measure(MEASURE)
    expect(await band()).toContain('"30%/h"')
    // Past 5H's reset at 2h 14m, with no reading since: 0%, and no pace for
    // it (WK's flat one stays).
    await clock.advance(2 * 60 * MINUTE + 5 * MINUTE)
    const after = await band()
    expect(count(after, '%/h"')).toBe(1)
    expect(after).toContain('"0.0%/h"')
  })

  test('a lower reading with the same reset time arrived out of order: left out, the pace kept', async ($, on) => {
    const limits = [...RATE_LIMITS]
    const { band, clock, saved } = await start($, on, 'terminal', limits)
    await clock.advance(10 * MINUTE)
    fiveHourAt(limits, 67.4)
    await $.session.measure(MEASURE)
    fiveHourAt(limits, 67.3)
    await $.session.measure(MEASURE)
    expect(await band()).toContain('"30%/h"')
    expect((saved.get('history') as Record<string, { samples: unknown[] }>).five_hour!.samples.length).toBe(2)
  })

  test('%/day: a weekly window by the day', async ($, on) => {
    const limits = [...RATE_LIMITS]
    const { band, clock } = await start($, on, 'terminal', limits, undefined, { settings: { warm: { mode: 'pings' }, pace: { WK: { unit: 'day' } } } })
    await clock.advance(10 * MINUTE)
    limits[0] = { ...SEVEN_DAY, percentUsed: 32 }
    await $.session.measure(MEASURE)
    // 1 point in 10 minutes: 6 an hour, 144 a day.
    expect(await band()).toContain('"144%/day"')
  })

  test('the collapsed line leaves out the forecasts before the paces: never the forecast without its pace when both are on', async ($, on) => {
    const limits = [...RATE_LIMITS]
    const { ui, band, clock } = await start($, on, 'terminal', limits, undefined, {
      settings: {
        warm: { mode: 'pings' },
        pace: { '5H': { show: { bars: true }, forecast: { bars: true } }, WK: { show: { bars: true }, forecast: { bars: true } } },
      },
    })
    await clock.advance(10 * MINUTE)
    fiveHourAt(limits, 67.4)
    await $.session.measure(MEASURE)
    await ui.pointer(rightClick)
    // The paces ("30%/h", "0.0%/h") take more cells than the forecasts
    // ("1h 05m", "Safe"): at some width the forecasts alone would fit.
    for (let columns = 56; columns <= 100; columns++) {
      await ui.resize({ columns, rows: 8, in: 'band' })
      const line = await band()
      if (line.includes('"1h 05m"')) expect(line).toContain('"30%/h"')
    }
  })

  test('a gap between readings is spread over the gap, not booked at its end: usage elsewhere reads at its pace', async ($, on) => {
    // 10% two hours ago, then nothing here while another device used 20
    // points: 10 an hour, not 40.
    const limits = [...RATE_LIMITS]
    fiveHourAt(limits, 30)
    const { band } = await start($, on, 'terminal', limits, undefined, {
      settings: { warm: { mode: 'pings' } },
      history: { five_hour: { resetsAt: FIVE_HOUR.resetsAt, samples: [{ at: NOW - 2 * 60 * MINUTE, percent: 10 }] } },
    })
    await $.session.measure(MEASURE)
    expect(await band()).toContain('"10%/h"')
  })

  test('a fall of 5 points or more in the same period starts the pace over (a plan change); a late reading of an earlier period is left out', async ($, on) => {
    const limits = [...RATE_LIMITS]
    const { band, clock, saved } = await start($, on, 'terminal', limits)
    await clock.advance(10 * MINUTE)
    fiveHourAt(limits, 67.4)
    await $.session.measure(MEASURE)
    fiveHourAt(limits, 20)
    await $.session.measure(MEASURE)
    const history = () => (saved.get('history') as Record<string, { samples: { percent: number }[] }>).five_hour!.samples
    expect(history().map(s => s.percent)).toEqual([20])
    expect(await band()).not.toContain('"30%/h"')
    // A reading from the period before (an earlier reset time) arrives late.
    limits[1] = { kind: 'five_hour', percentUsed: 95, resetsAt: new Date(NOW - MINUTE).toISOString() }
    await $.session.measure(MEASURE)
    expect(history().map(s => s.percent)).toEqual([20])
  })

  test("an idle session's older figures never go over the newer ones another session stored", async ($, on) => {
    const limits = [...RATE_LIMITS]
    const newer = [{ ...FIVE_HOUR, percentUsed: 64 }, SEVEN_DAY]
    const { saved, band } = await start($, on, 'terminal', limits, undefined, {
      settings: { warm: { mode: 'pings' } },
      limits: newer,
      limitsAt: NOW - MINUTE,
    })
    // This session's own last response said 62.4: older, a little lower, same
    // period (a fall of 5 points or more would be real).
    await $.session.measure(MEASURE)
    expect(saved.get('limits')).toEqual(newer)
    expect(saved.get('limitsAt')).toBe(NOW - MINUTE)
    expect(await band()).toContain('"64%"')
  })

  test("the samples are the account's: a new session reads the pace at once from the store", async ($, on) => {
    const { band, saved } = await start($, on, 'terminal', RATE_LIMITS, undefined, {
      history: { five_hour: { resetsAt: FIVE_HOUR.resetsAt, samples: [{ at: NOW - 20 * MINUTE, percent: 52.4 }] } },
    })
    // 10 points in the 20 minutes since the first sample: 30 an hour.
    expect(await band()).toContain('"30%/h"')
    expect(saved.get('history')).toMatchObject({
      five_hour: { samples: [{ at: NOW - 20 * MINUTE, percent: 52.4 }, { at: NOW, percent: 62.4 }] },
    })
  })

  test("the snapshot carries each window's pace and when it fills", async ($, on) => {
    const limits = [...RATE_LIMITS]
    const { clock, writes } = await start($, on, 'terminal', limits)
    await clock.advance(10 * MINUTE)
    fiveHourAt(limits, 67.4)
    await $.session.measure(MEASURE)
    const fiveHour = snapshotOf(writes).windows.find((w: { kind: string }) => w.kind === 'five_hour')
    expect(fiveHour.ratePerHour).toBe(30)
    // ISO strings drop the fraction of a millisecond; within a second will do.
    const off = Math.abs(Date.parse(fiveHour.fullAt) - (NOW + 10 * MINUTE) - (32.6 / 30) * 60 * MINUTE)
    expect(off).toBeLessThan(1000)
  })

  test('narrow, the collapsed line narrows its meters, then drops them, then the paces; the table drops its pace columns', async ($, on) => {
    const limits = [...RATE_LIMITS]
    const { ui, band, clock } = await start($, on, 'terminal', limits, undefined, {
      settings: { pace: { '5H': { show: { bars: true } }, WK: { show: { bars: true } } } },
    })
    await clock.advance(10 * MINUTE)
    fiveHourAt(limits, 67.4)
    await $.session.measure(MEASURE)
    await ui.resize({ columns: 69, rows: 8, in: 'band' })
    expect(await band()).not.toContain('%/h')
    await ui.pointer(rightClick)
    // In cells: 49 without the paces (13) and the meters (22, 14 or 10 for
    // two), the context bar keeping 8.
    const meters = (width: number) => `"width":${width},"height":1,"flexDirection":"row","alignItems":"center","flexShrink":0`
    await ui.resize({ columns: 150, rows: 8, in: 'band' })
    let line = await band()
    expect(count(line, meters(10))).toBe(2)
    expect(line).toContain('"30%/h"')
    await ui.resize({ columns: 88, rows: 8, in: 'band' })
    line = await band()
    expect(count(line, meters(6))).toBe(2)
    expect(line).toContain('"30%/h"')
    await ui.resize({ columns: 76, rows: 8, in: 'band' })
    line = await band()
    for (const width of [10, 6, 4]) expect(line).not.toContain(meters(width))
    expect(line).toContain('"30%/h"')
    await ui.resize({ columns: 66, rows: 8, in: 'band' })
    line = await band()
    expect(line).not.toContain('%/h')
    expect(line).toContain('212k / 1M')
  })

  test("a window's pace settings in this session's scope: an override and its reset", async ($, on) => {
    const { saved } = await start($, on, 'terminal', RATE_LIMITS)
    const { pane, drawn } = await mountPanel($, 'terminal', { open: ['usage', 'usage-5H'] })
    await pane.press({ key: 'unit-5H-min' })
    expect(saved.get(SESSION_KEY)).toMatchObject({ settings: { pace: { '5H': { unit: 'min' } } } })
    expect(saved.get('settings')).toEqual({ warm: { mode: 'pings' } })
    await pane.press({ key: 'reset-pace-5H-unit' })
    expect(saved.has(SESSION_KEY)).toBe(false)
    await pane.press({ key: 'scope-global' })
    await pane.press({ key: 'window-5H-up' })
    expect(saved.get('settings')).toMatchObject({ pace: { '5H': { windowMin: 60, unit: 'h' } } })
    // An hour or more reads in hours.
    expect(await drawn()).toContain('"1 h"')
  })
})

describe('usage across sessions', () => {
  test('an idle session takes the usage another session reported more recently, at the next heartbeat', async ($, on) => {
    const { band, clock, saved } = await start($, on, 'terminal', RATE_LIMITS)
    expect(await band()).toContain('"62%"')
    // Another session's response: newer figures in the shared store.
    saved.set('limits', [SEVEN_DAY, { ...FIVE_HOUR, percentUsed: 80 }])
    saved.set('limitsAt', NOW + 1)
    await clock.advance(30_000)
    expect(await band()).toContain('"80%"')
  })

  test('a reading that does not follow a response never puts older figures over newer ones', async ($, on) => {
    const { band, clock, saved } = await start($, on, 'terminal', RATE_LIMITS)
    saved.set('limits', [SEVEN_DAY, { ...FIVE_HOUR, percentUsed: 80 }])
    saved.set('limitsAt', NOW + 1)
    await clock.advance(30_000)
    // /token-watch text takes a reading: its windows are this session's last
    // response's, older than the store's.
    await run($, 'text')
    expect(await band()).toContain('"80%"')
    expect(saved.get('limits')).toEqual([SEVEN_DAY, { ...FIVE_HOUR, percentUsed: 80 }])
  })

  test('a reading after a response stamps the store, for the other sessions, when it brings something newer', async ($, on) => {
    const limits = [...RATE_LIMITS]
    const { clock, saved } = await start($, on, 'terminal', limits)
    await clock.advance(MINUTE)
    // The same figures again: nothing to share.
    await $.session.measure(MEASURE)
    expect(saved.get('limitsAt')).toBe(NOW)
    fiveHourAt(limits, 63.4)
    await $.session.measure(MEASURE)
    expect(saved.get('limitsAt')).toBe(NOW + MINUTE)
    expect(saved.get('limits')).toMatchObject([{ kind: 'seven_day' }, { kind: 'five_hour', percentUsed: 63.4 }])
  })
})

// The defaults, as a test brings them (the fixture's own store is in Pings mode).
const DEFAULTS = { settings: {} }

describe('notify and alerts', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: keep-warm reminds by default: Remind Me, then Reminding in green once on, with no caps`, async ($, on) => {
      const { ui, band } = await start($, on, surface, RATE_LIMITS, undefined, DEFAULTS)
      await turn($)
      expect(await band()).toContain(chipOf(surface, 'keep-warm', warmLabel(surface, 'Remind Me'), CHIP_OFF))
      await ui.press({ key: 'keep-warm' })
      const after = await band()
      expect(after).toContain(chipOf(surface, 'keep-warm', warmLabel(surface, 'Reminding'), CHIP_ON))
      expect(after).not.toContain('Pings:')
      expect(after).not.toContain(REFRESH_CAPS_KEY)
    })
  }

  test('Notify: one notification its lead before the countdown runs out, no pings; again after the next response', async ($, on) => {
    const { ui, clock, forks, notes, writes } = await start($, on, 'terminal', RATE_LIMITS, undefined, DEFAULTS, FIVE_M)
    await turn($)
    await ui.press({ key: 'keep-warm' })
    // Five minutes, a minute's lead: at 4:00.
    await clock.advance(4 * MINUTE - 1000)
    expect(notes).toEqual([])
    await clock.advance(1000)
    expect(notes).toEqual(['The prompt cache expires in 1m. Send a message to keep it warm.'])
    // Past the expiry: no ping, no second notification, and still on.
    await clock.advance(5 * MINUTE)
    expect(forks.length).toBe(0)
    expect(notes.length).toBe(1)
    expect(snapshotOf(writes).cache.keepWarm).toMatchObject({ on: true, mode: 'notify' })
    // The next response starts a countdown, and its reminder.
    await turn($, 't2')
    await clock.advance(4 * MINUTE)
    expect(notes.length).toBe(2)
    expect(forks.length).toBe(0)
  })

  test('in Notify mode the text reading says reminder, with no ping caps (a reminder has none)', async ($, on) => {
    const { ui } = await start($, on, 'terminal', RATE_LIMITS, undefined, DEFAULTS, FIVE_M)
    await turn($)
    await ui.press({ key: 'keep-warm' })
    const text = (await run($, 'text')).text ?? ''
    expect(text).toContain('keep-warm reminder')
    expect(text).not.toContain('pings 0/')
  })

  test('Notify stays on across a prompt from the person; Pings would not', async ($, on) => {
    const { ui, band, writes } = await start($, on, 'terminal', RATE_LIMITS, undefined, DEFAULTS, FIVE_M)
    await turn($)
    await ui.press({ key: 'keep-warm' })
    await $.prompt.submit({ text: 'back', wait: false, origin: { kind: 'composer' } })
    expect(await band()).toContain(chipOf('terminal', 'keep-warm', warmLabel('terminal', 'Reminding'), CHIP_ON))
    expect(snapshotOf(writes).cache.keepWarm).toMatchObject({ on: true, mode: 'notify' })
  })

  test('Both: pings, and one notification its lead before the first ping of an idle spell; a prompt stops it', async ($, on) => {
    const { ui, clock, forks, notes, writes } = await start($, on, 'terminal', RATE_LIMITS, undefined, { settings: { warm: { mode: 'both' } } }, FIVE_M)
    await turn($)
    await ui.press({ key: 'keep-warm' })
    // The first ping at 3:45; its reminder a minute before.
    await clock.advance(PING_AT - MINUTE)
    expect(notes).toEqual(['Token Watch pings in 1m to keep the prompt cache warm, unless you send a message first.'])
    expect(forks.length).toBe(0)
    await clock.advance(MINUTE)
    expect(forks.length).toBe(1)
    // The second ping of the spell comes without a reminder.
    await clock.advance(PING_AT)
    expect(forks.length).toBe(2)
    expect(notes.length).toBe(1)
    await $.prompt.submit({ text: 'back', wait: false, origin: { kind: 'composer' } })
    expect(snapshotOf(writes).cache.keepWarm.on).toBe(false)
  })

  test("the panel's mode and reminder lead", async ($, on) => {
    const { saved } = await start($, on, 'terminal', RATE_LIMITS, undefined, DEFAULTS, FIVE_M)
    await turn($)
    const { pane, drawn } = await mountPanel($, 'terminal', { scope: 'global', open: ['cache'] })
    expect(await drawn()).toContain('Cache time')
    expect(await drawn()).toContain(radio('terminal', 'warm-notify', 'Notify', true))
    expect(await drawn()).toContain('"1 min before"')
    await pane.press({ key: 'lead-up' })
    expect(saved.get('settings')).toMatchObject({ warm: { mode: 'notify', lead: { '5m': 2 } } })
    await pane.press({ key: 'warm-pings' })
    expect(saved.get('settings')).toMatchObject({ warm: { mode: 'pings' } })
    // Pings has no reminder to time.
    expect(await drawn()).not.toContain('"key":"lead-up"')
  })

  test("a usage window's alert: Enable to 99%, down in steps of 5 to 50%, past 99% Off; only in every session's scope", async ($, on) => {
    const { saved } = await start($, on, 'terminal', RATE_LIMITS, undefined, DEFAULTS)
    const { pane, drawn } = await mountPanel($, 'terminal', { open: ['usage', 'usage-5H'] })
    expect(await drawn()).not.toContain('alert-5H')
    // In every session's scope, its alert section, closed until opened.
    await pane.press({ key: 'scope-global' })
    await pane.press({ key: 'section-usage-5H-alert' })
    expect(await drawn()).toContain('"key":"alert-5H-enable","label":"[Enable]"')
    expect(await drawn()).not.toContain('"key":"alert-5H-up"')
    await pane.press({ key: 'alert-5H-enable' })
    expect(saved.get('settings')).toMatchObject({ alert: { '5H': 99 } })
    await pane.press({ key: 'alert-5H-down' })
    await pane.press({ key: 'alert-5H-down' })
    expect(saved.get('settings')).toMatchObject({ alert: { '5H': 90 } })
    for (let i = 0; i < 9; i++) await pane.press({ key: 'alert-5H-down' })
    expect(saved.get('settings')).toMatchObject({ alert: { '5H': 50 } })
    for (let i = 0; i < 10; i++) await pane.press({ key: 'alert-5H-up' })
    expect(saved.get('settings')).toMatchObject({ alert: { '5H': 99 } })
    await pane.press({ key: 'alert-5H-up' })
    expect(saved.get('settings')).toMatchObject({ alert: { '5H': null } })
    expect(await drawn()).toContain('"key":"alert-5H-enable"')
  })

  test('a usage alert: once a window period, noted in the store so other sessions stay quiet; a new period alerts again', async ($, on) => {
    const limits = [...RATE_LIMITS]
    const { saved, notes } = await start($, on, 'terminal', limits, undefined, { settings: { alert: { '5H': 80 } } })
    fiveHourAt(limits, 82)
    await $.session.measure(MEASURE)
    expect(notes).toEqual(['5-hour usage at 82%, resets in 2h 14m.'])
    fiveHourAt(limits, 85)
    await $.session.measure(MEASURE)
    expect(notes.length).toBe(1)
    expect(saved.get('alerted')).toEqual({ five_hour: { resetsAt: FIVE_HOUR.resetsAt, levels: [80] } })
    limits[1] = { kind: 'five_hour', percentUsed: 83, resetsAt: new Date(NOW + 5 * 60 * MINUTE).toISOString() }
    await $.session.measure(MEASURE)
    expect(notes.length).toBe(2)
  })

  test('another session already alerted for this period: this one stays quiet', async ($, on) => {
    const limits = [...RATE_LIMITS]
    const { notes } = await start($, on, 'terminal', limits, undefined, {
      settings: { alert: { '5H': 80, WK: 50 } },
      alerted: { five_hour: { resetsAt: FIVE_HOUR.resetsAt, levels: [80] } },
    })
    fiveHourAt(limits, 82)
    limits[0] = { ...SEVEN_DAY, percentUsed: 55 }
    await $.session.measure(MEASURE)
    // 5H was said already; WK, not yet.
    expect(notes).toEqual(['Weekly usage at 55%, resets in 3d 4h.'])
  })

  test("a session's own usage alert is not one: usage alerts are every session's", async ($, on) => {
    const limits = [...RATE_LIMITS]
    const { notes } = await start($, on, 'terminal', limits, undefined, {
      settings: { alert: { WK: 50 } },
      [SESSION_KEY]: { settings: { alert: { '5H': 80 } }, seenAt: NOW },
    })
    fiveHourAt(limits, 82)
    limits[0] = { ...SEVEN_DAY, percentUsed: 55 }
    await $.session.measure(MEASURE)
    // The session's own 5H alert counts for nothing; every session's WK alert does.
    expect(notes).toEqual(['Weekly usage at 55%, resets in 3d 4h.'])
  })

  test('the context alert: once, and again after the context falls back under it', async ($, on) => {
    const context = { total: 212_200 }
    const { notes } = await start($, on, 'terminal', RATE_LIMITS, undefined, { settings: { alert: { CTX: 50 } } }, { context })
    context.total = 600_000
    await $.session.measure(MEASURE)
    expect(notes).toEqual(['Context at 60% (600k / 1M).'])
    context.total = 650_000
    await $.session.measure(MEASURE)
    expect(notes.length).toBe(1)
    // A compaction: under the level, then over it again.
    context.total = 100_000
    await $.session.measure(MEASURE)
    context.total = 600_000
    await $.session.measure(MEASURE)
    expect(notes.length).toBe(2)
  })
})

// A breakdown with lists for the context's details lines.
const BREAKDOWN: Extras = {
  mcpTools: [
    { name: 'mcp__github__search', serverName: 'github', tokens: 4_100, isLoaded: true },
    { name: 'mcp__slack__post', serverName: 'slack', tokens: 8_200, isLoaded: true },
    { name: 'mcp__github__issue', serverName: 'github', tokens: 2_000, isLoaded: true },
    // Deferred: not in the context, so not in the line.
    { name: 'mcp__linear__list', serverName: 'linear', tokens: 9_000, isLoaded: false },
  ],
  memoryFiles: [
    { path: '/home/you/proj/CLAUDE.md', type: 'Project', tokens: 1_200 },
    { path: '/home/you/.claude/CLAUDE.md', type: 'User', tokens: 3_400 },
  ],
  skills: { totalSkills: 40, includedSkills: 12, tokens: 10_000, skillFrontmatter: [] },
  agents: [
    { agentType: 'reviewer', source: 'project', tokens: 40 },
    { agentType: 'planner', source: 'user', tokens: 27 },
  ],
}

describe('context details', () => {
  test('off by default', async ($, on) => {
    const { band } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, { breakdown: BREAKDOWN })
    expect(await band()).not.toContain('"MCP"')
  })

  test('turned on, a line each under the legend: MCP servers loaded, memory files by name, skills and agents', async ($, on) => {
    const { ui, band } = await start($, on, 'terminal', RATE_LIMITS, undefined, {
      settings: { details: { mcp: true, memory: true, skills: true } },
    }, { breakdown: BREAKDOWN })
    const expanded = await band()
    expect(expanded).toContain('"slack 8.2k \u00b7 github 6.1k"')
    expect(expanded).not.toContain('linear')
    expect(expanded).toContain('"CLAUDE.md 3.4k \u00b7 CLAUDE.md 1.2k"')
    expect(expanded).not.toContain('/home/you')
    expect(expanded).toContain('"12 of 40, 10k \u00b7 agents 2, 67"')
    // Under the legend, in the expanded view alone.
    expect(expanded.indexOf('agents 1.1k')).toBeLessThan(expanded.indexOf('"MCP"'))
    await ui.pointer(rightClick)
    expect(await band()).not.toContain('"MCP"')
  })

  test('a line with nothing to say is left out', async ($, on) => {
    const { band } = await start($, on, 'terminal', RATE_LIMITS, undefined, {
      settings: { details: { mcp: true, memory: true, skills: true } },
    }, { breakdown: { mcpTools: BREAKDOWN.mcpTools } })
    const expanded = await band()
    expect(expanded).toContain('"MCP"')
    expect(expanded).not.toContain('"Memory"')
    expect(expanded).not.toContain('"Skills"')
  })

  test("the panel's Details toggles, in this session's scope", async ($, on) => {
    const { band, saved } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, { breakdown: BREAKDOWN })
    const { pane, drawn } = await mountPanel($, 'terminal', { open: ['context'] })
    await pane.press({ key: 'section-context-details' })
    expect(await drawn()).toContain(toggle('terminal', 'details-mcp', false))
    await pane.press({ key: 'details-mcp' })
    expect(saved.get(SESSION_KEY)).toMatchObject({ settings: { details: { mcp: true } } })
    expect(await band()).toContain('"slack 8.2k \u00b7 github 6.1k"')
    expect(await drawn()).toContain('"key":"reset-details"')
  })
})

// Another session's file in the sessions folder, written `ago` ms before NOW.
const otherSession = (id: string, cwd: string, ago: number, extra: Record<string, unknown> = {}) => ({
  file: {
    schema: 1,
    writtenAt: new Date(NOW - ago).toISOString(),
    endedAt: null,
    session: { id, cwd, root: cwd },
    isWorking: false,
    context: { total: 640_000, window: 1_000_000, percent: 64 },
    cache: {
      ttl: '1h',
      expiresAt: new Date(NOW + 52 * MINUTE).toISOString(),
      warm: true,
      keepWarm: { on: true, mode: 'pings' },
    },
    ...extra,
  },
  mtimeMs: NOW - ago,
})

// A piece of a closed section's summary as drawn: in its colour, or dim.
const tint = (text: string, color?: string) =>
  `{"type":"Text","props":{${color ? `"color":"${color}"` : '"dimColor":true'}},"children":["${text}"]}`
// A run of pieces, as the tree spells them side by side.
const pieces = (...parts: string[]) => parts.join(',')
// The band's level colours, and the countdown's warm and cold.
const GREEN = '#8fd18f'
const YELLOW = '#e8c66a'
const RED = '#e06c6c'

const SESSIONS_PANE = { ...PANE, requestId: 'token-watch-monitor', props: { ...PANE.props, title: 'TW Monitor' } }

// The sessions panel mounted, its drawing as text.
async function mountSessions($: Engine, surface: Surface) {
  const pane = await $.ui.mount<Surface, 'Pane'>({ ...SESSIONS_PANE, surface })
  return async () => JSON.stringify(await pane.drawn())
}

const lastFile = (sessionWrites: Write[]) => {
  const write = written(sessionWrites)
  return { name: write.path.slice(SESSIONS_DIR.length + 1), file: JSON.parse(write.text) }
}

describe('TW Monitor', () => {
  test("each reading writes the session's own file: its folder, context and cache, in the first slot", async ($, on) => {
    const { sessionWrites, writes, clock } = await boot($, on, 'terminal', RATE_LIMITS)
    expect(writes.length).toBe(1)
    const { name, file } = lastFile(sessionWrites)
    expect(name).toBe('session-1.json')
    expect(file).toEqual({
      schema: 1,
      writtenAt: '2026-10-03T12:00:00.000Z',
      endedAt: null,
      session: { id: 'sess-1', cwd: 'C:/proj', root: 'C:/proj' },
      isWorking: false,
      lastActiveAt: null,
      context: { total: 212_200, window: 1_000_000, percent: 21 },
      cache: { ttl: '1h', expiresAt: null, warm: false, keepWarm: { on: false, mode: 'pings' } },
    })
    // Every 30 s again, so the others can tell it is alive.
    await clock.advance(30_000)
    expect(sessionWrites.length).toBe(2)
    expect(lastFile(sessionWrites).file.writtenAt).toBe('2026-10-03T12:00:30.000Z')
  })

  test('a slot whose session ended or went stale is reused; a live one is not', async ($, on) => {
    const { sessionWrites } = await boot($, on, 'terminal', RATE_LIMITS, {
      sessionFiles: {
        'session-1.json': otherSession('live', 'C:/a', 10_000),
        'session-2.json': otherSession('stale', 'C:/b', 5 * MINUTE),
        'session-3.json': otherSession('ended', 'C:/c', 10_000, { endedAt: new Date(NOW - 10_000).toISOString() }),
      },
    })
    expect(lastFile(sessionWrites).name).toBe('session-2.json')
  })

  test('with every slot live, a new one after them', async ($, on) => {
    const { sessionWrites } = await boot($, on, 'terminal', RATE_LIMITS, {
      sessionFiles: {
        'session-1.json': otherSession('a', 'C:/a', 10_000),
        'session-2.json': otherSession('b', 'C:/b', 10_000),
      },
    })
    expect(lastFile(sessionWrites).name).toBe('session-3.json')
  })

  test('a torn file still being written is not taken', async ($, on) => {
    const { sessionWrites } = await boot($, on, 'terminal', RATE_LIMITS, {
      sessionFiles: { 'session-1.json': { file: '{"schema":1,"writ', mtimeMs: NOW - 1_000 } },
    })
    expect(lastFile(sessionWrites).name).toBe('session-2.json')
  })

  test('after a reload the session finds its own slot by its id', async ($, on) => {
    const { sessionWrites } = await boot($, on, 'terminal', RATE_LIMITS, {
      sessionFiles: {
        'session-1.json': otherSession('stale', 'C:/b', 5 * MINUTE),
        'session-2.json': otherSession('sess-1', 'C:/proj', 10_000),
      },
    })
    expect(lastFile(sessionWrites).name).toBe('session-2.json')
  })

  test('two sessions picked the same slot: the one written over moves on', async ($, on) => {
    const { sessionWrites, files, clock } = await boot($, on, 'terminal', RATE_LIMITS)
    expect(lastFile(sessionWrites).name).toBe('session-1.json')
    const other = otherSession('other', 'C:/a', 0)
    files.set(`${SESSIONS_DIR}/session-1.json`, { text: JSON.stringify(other.file), mtimeMs: NOW + 5_000 })
    await clock.advance(30_000)
    expect(lastFile(sessionWrites).name).toBe('session-2.json')
    expect(JSON.parse(files.get(`${SESSIONS_DIR}/session-1.json`)!.text).session.id).toBe('other')
  })

  test('a session that ends says so in its file; a /clear goes on under the new id', async ($, on) => {
    const { sessionWrites, clock } = await boot($, on, 'terminal', RATE_LIMITS)
    await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } })
    expect(lastFile(sessionWrites).file.endedAt).toBeNull()
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sess-1', resume: { id: 'sess-1' } })
    expect(lastFile(sessionWrites).file.endedAt).toBe('2026-10-03T12:00:00.000Z')
    // And stays so: nothing writes it live again.
    const count = sessionWrites.length
    await clock.advance(30_000)
    expect(sessionWrites.length).toBe(count)
  })

  test('the snapshot option turns the session files off too', { options: { snapshot: false } }, async ($, on) => {
    const { sessionWrites, clock } = await boot($, on, 'terminal', RATE_LIMITS)
    await clock.advance(30_000)
    expect(sessionWrites.length).toBe(0)
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: a sessions button under the settings button in the expanded view opens the panel`, async ($, on) => {
      const { ui, tree, opens } = await start($, on, surface, RATE_LIMITS)
      expect(await tree()).toContain(`"key":"sessions","label":"${surface === 'terminal' ? '[#]' : '⊞'}"`)
      await ui.press({ key: 'sessions' })
      expect(opens).toEqual([{ id: 'token-watch-monitor', title: 'TW Monitor', columns: 52 }])
      await ui.pointer(rightClick)
      expect(await tree()).not.toContain('"key":"sessions"')
    })
  }

  test('the panel: this session first, then the live others by folder, each with its context and countdown', async ($, on) => {
    const { opens } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, {
      sessionFiles: {
        'session-1.json': otherSession('zz', 'C:/work/web', 10_000),
        'session-2.json': otherSession('aa', 'C:/work/api', 20_000, {
          cache: { ttl: '5m', expiresAt: new Date(NOW - MINUTE).toISOString(), warm: false, keepWarm: { on: false, mode: 'notify' } },
        }),
        'session-3.json': otherSession('old', 'C:/work/gone', 5 * MINUTE),
        'session-4.json': otherSession('done', 'C:/work/done', 10_000, { endedAt: new Date(NOW - 5_000).toISOString() }),
      },
    })
    expect((await run($, 'monitor')).text).toBe('TW Monitor opened.')
    expect(opens.at(-1)).toEqual({ id: 'token-watch-monitor', title: 'TW Monitor', columns: 52 })
    const drawn = await (await mountSessions($, 'terminal'))()
    const at = (text: string) => drawn.indexOf(text)
    expect(drawn).toContain('"› proj"')
    expect(drawn).not.toContain('this session')
    expect(drawn).not.toContain('(this session)')
    expect(drawn).toContain('"21%"')
    expect(drawn).toContain('"212k / 1M"')
    // This session has had no response: no countdown yet.
    expect(drawn).toContain('"No data"')
    expect(drawn).toContain('"64%"')
    expect(drawn).toContain('"52m"')
    expect(drawn).toContain('"(Ping)"')
    expect(drawn).toContain('"Cold"')
    expect(drawn).not.toContain('gone')
    expect(drawn).not.toContain('done')
    expect(at('"› proj"')).toBeLessThan(at('"api"'))
    expect(at('"api"')).toBeLessThan(at('"web"'))
    // Meters: the context at 64% is 6 of 10 cells.
    expect(drawn).toContain('"▄▄▄▄▄▄"')
    // The account's usage windows once, on top, each with its reset countdown.
    expect(at('"Usage"')).toBeLessThan(at('"› proj"'))
    expect(drawn).toContain('"5H"')
    expect(drawn).toContain('"62%"')
    expect(drawn).toContain('"2h 14m"')
    expect(drawn).toContain('"WK"')
    expect(drawn).toContain('"31%"')
    expect(drawn).toContain('"3d 4h"')
    expect(count(drawn, '"children":["5H"]')).toBe(1)
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: each usage window's burn rate, red when it would fill before its reset, green when not`, async ($, on) => {
      const limits = [...RATE_LIMITS]
      const { clock } = await start($, on, surface, limits)
      await clock.advance(10 * MINUTE)
      fiveHourAt(limits, 67.4)
      await $.session.measure(MEASURE)
      await run($, 'monitor')
      const drawn = await (await mountSessions($, surface))()
      // 5 points in 10 minutes fills the 5H window before its reset; WK is flat.
      expect(drawn).toContain('"color":"#e06c6c","wrap":"truncate"},"children":["30%/h"]')
      expect(drawn).toContain('"color":"#8fd18f","wrap":"truncate"},"children":["0.0%/h"]')
      // The labels keep two cells of slack on the desktop, so "CTX" is not cut.
      expect(drawn).toContain(`{"width":${surface === 'terminal' ? 3 : 5},"flexShrink":0}`)
    })
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: Usage, a rule, then Sessions; every section open at first, each closing to a summary`, async ($, on) => {
      await start($, on, surface, RATE_LIMITS, undefined, undefined, {
        sessionFiles: { 'session-1.json': otherSession('zz', 'C:/work/web', 10_000) },
      })
      await run($, 'monitor')
      const pane = await $.ui.mount<Surface, 'Pane'>({ ...SESSIONS_PANE, surface })
      const drawn = async () => JSON.stringify(await pane.drawn())
      // A heading's label: the glyph bracketed on both surfaces, then its words.
      const heading = (glyph: string, words: string) => `[${glyph}] ${words}`
      const open = '▾'
      const shut = '▸'
      const first = await drawn()
      // Each heading is its Button: the glyph and the words, one press.
      const headings: [string, string][] = [['usage', 'Usage'], ['sessions', 'Sessions'], ['session-sess-1', '› proj'], ['session-zz', 'web']]
      for (const [id, words] of headings) {
        expect(first).toContain(`"key":"fold-${id}","label":"${heading(open, words)}"`)
      }
      // The session's name alone is in its Button. Its pin comes first, in a
      // column of its own where the indent under Sessions was; its hide is at
      // the row's right edge, after a spacer that takes the room between.
      expect(first).toContain(`"label":"${heading(open, '› proj')}","plain":true}`)
      expect(first).toContain(
        // A minimum, not a fixed width: a fixed two clipped the desktop's flag.
        `{"type":"Box","props":{"minWidth":${surface === 'terminal' ? 3 : 2},"flexShrink":0},"children":[{"type":"Button","props":{"key":"pin-sess-1","label":"${surface === 'terminal' ? '[ ]' : '⚐'}"`,
      )
      expect(first.indexOf('"key":"pin-sess-1"')).toBeLessThan(first.indexOf('"key":"fold-session-sess-1"'))
      // Against the heading on the desktop, whose flag Button brings its own
      // room; a cell between in a terminal.
      expect(first).toContain(
        `{"type":"Box","props":{"flexDirection":"row","columnGap":${surface === 'terminal' ? 1 : 0},"flexShrink":1,"minWidth":0},"children":[{"type":"Box","props":{"minWidth"`,
      )
      expect(first).toContain(
        `{"type":"Box","props":{"flexGrow":1}},{"type":"Box","props":{"flexShrink":0},"children":[{"type":"Button","props":{"key":"hide-sess-1","label":"${surface === 'terminal' ? '[×]' : '×'}"`,
      )
      // The rule: a line of 50 cells in a terminal (the body less its
      // margins), a hairline on the desktop.
      const rule = first.indexOf(surface === 'terminal' ? `"${'─'.repeat(50)}"` : '"key":"rule"')
      expect(rule).toBeGreaterThan(first.indexOf('"Usage"'))
      expect(rule).toBeLessThan(first.indexOf('"Sessions"'))
      // A session closes to its heading and a summary.
      await pane.press({ key: 'fold-session-sess-1' })
      const one = await drawn()
      expect(one).toContain(`"key":"fold-session-sess-1","label":"${heading(shut, '› proj')}"`)
      // By default a closed session shows its countdown alone.
      expect(one).toContain(pieces(tint('TTL '), tint('No data', RED)))
      expect(one).not.toContain('"children":["CTX "]')
      expect(one).not.toContain('"212k / 1M"')
      expect(one).toContain('"640k / 1M"')
      // Usage closes to the windows' percentages; Sessions to the count.
      await pane.press({ key: 'fold-usage' })
      await pane.press({ key: 'fold-sessions' })
      const all = await drawn()
      expect(all).toContain(pieces(tint('5H '), tint('62%', YELLOW), tint(' · WK '), tint('31%', GREEN)))
      expect(all).not.toContain('"2h 14m"')
      expect(all).toContain(tint('2'))
      expect(all).not.toContain('"web"')
      // And opens again.
      await pane.press({ key: 'fold-sessions' })
      expect(await drawn()).toContain('"web"')
    })
  }

  test("a session's figures in their colours, open or closed: the context by level; the countdown green with keep-warm on, grey off, red cold or without data", async ($, on) => {
    const warmOff = { ttl: '1h', expiresAt: new Date(NOW + 20 * MINUTE).toISOString(), warm: true, keepWarm: { on: false, mode: 'notify' } }
    const cold = { ttl: '5m', expiresAt: new Date(NOW - MINUTE).toISOString(), warm: false, keepWarm: { on: false, mode: 'notify' } }
    await start($, on, 'desktop', RATE_LIMITS, undefined, monitorSettings({ lines: { collapsed: { ctx: { percent: true } } } }), {
      sessionFiles: {
        'session-1.json': otherSession('on', 'C:/work/a-on', 10_000),
        'session-2.json': otherSession('off', 'C:/work/b-off', 10_000, {
          context: { total: 900_000, window: 1_000_000, percent: 90 },
          cache: warmOff,
        }),
        'session-3.json': otherSession('cold', 'C:/work/c-cold', 10_000, { cache: cold }),
      },
    })
    await run($, 'monitor')
    const pane = await $.ui.mount<Surface, 'Pane'>({ ...SESSIONS_PANE, surface: 'desktop' })
    // Open, the TTL lines follow the same rule; a grey countdown's meter is
    // filled light grey. This session has had no response: red, no data.
    const open = JSON.stringify(await pane.drawn())
    const value = (text: string, color?: string) =>
      `{"type":"Text","props":{${color ? `"color":"${color}"` : '"dimColor":true'},"wrap":"truncate"},"children":["${text}"]}`
    expect(open).toContain(value('52m', GREEN))
    expect(open).toContain(value('20m'))
    expect(open).toContain(value('Cold', RED))
    expect(open).toContain(value('No data', RED))
    expect(count(open, '"backgroundColor":"#8a8f99"')).toBe(1)
    for (const id of ['on', 'off', 'cold']) await pane.press({ key: `fold-session-${id}` })
    const drawn = JSON.stringify(await pane.drawn())
    expect(drawn).toContain(pieces(tint('64%', YELLOW), tint(' · '), tint('TTL '), tint('52m', GREEN)))
    expect(drawn).toContain(pieces(tint('90%', RED), tint(' · '), tint('TTL '), tint('20m')))
    expect(drawn).toContain(pieces(tint('TTL '), tint('Cold', RED)))
  })

  test('a pinned session comes after this one and before the unpinned; [ ] and [*], saved for every session', async ($, on) => {
    const { saved } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, {
      sessionFiles: {
        'session-1.json': otherSession('aa', 'C:/work/alpha', 10_000),
        'session-2.json': otherSession('zz', 'C:/work/zulu', 10_000),
      },
    })
    await run($, 'monitor')
    const pane = await $.ui.mount<Surface, 'Pane'>({ ...SESSIONS_PANE, surface: 'terminal' })
    const drawn = async () => JSON.stringify(await pane.drawn())
    const order = async () => {
      const d = await drawn()
      return ['› proj', 'alpha', 'zulu'].sort((a, b) => d.indexOf(`"label":"[▾] ${a}"`) - d.indexOf(`"label":"[▾] ${b}"`))
    }
    // By folder at first; every session has a pin, this one too.
    expect(await order()).toEqual(['› proj', 'alpha', 'zulu'])
    for (const id of ['sess-1', 'aa', 'zz']) expect(await drawn()).toContain(`"key":"pin-${id}","label":"[ ]","plain":true,"dimColor":true`)
    // The desktop's are a flag, outlined and filled: the same width on and off.
    const desk = await $.ui.mount<Surface, 'Pane'>({ ...SESSIONS_PANE, surface: 'desktop' })
    expect(JSON.stringify(await desk.drawn())).toContain('"key":"pin-aa","label":"⚐","plain":true,"dimColor":true')
    await pane.press({ key: 'pin-zz' })
    expect(saved.get('pinned')).toEqual({ zz: NOW })
    expect(await drawn()).toContain('"key":"pin-zz","label":"[*]","plain":true}')
    expect(JSON.stringify(await desk.drawn())).toContain('"key":"pin-zz","label":"⚑","plain":true}')
    // Pinned: above alpha, still under this session.
    expect(await order()).toEqual(['› proj', 'zulu', 'alpha'])
    await pane.press({ key: 'pin-zz' })
    expect(saved.get('pinned')).toEqual({})
    expect(await order()).toEqual(['› proj', 'alpha', 'zulu'])
  })

  test("another session's pin reaches this one; an old pin whose session is gone is dropped, a running one kept", async ($, on) => {
    const old = NOW - 31 * 24 * 60 * MINUTE
    const { saved, clock, files } = await start($, on, 'terminal', RATE_LIMITS, undefined, {
      pinned: { gone: old, aa: old },
    }, {
      sessionFiles: {
        'session-1.json': otherSession('aa', 'C:/work/alpha', 10_000),
        'session-2.json': otherSession('zz', 'C:/work/zulu', 10_000),
      },
    })
    await run($, 'monitor')
    expect(saved.get('pinned')).toEqual({ aa: old })
    const pane = await $.ui.mount<Surface, 'Pane'>({ ...SESSIONS_PANE, surface: 'terminal' })
    expect(JSON.stringify(await pane.drawn())).toContain('"key":"pin-aa","label":"[*]"')
    // Another session pins zulu; within 30 s this one shows it.
    saved.set('pinned', { aa: old, zz: NOW })
    for (const name of ['session-1.json', 'session-2.json']) {
      const f = files.get(`${SESSIONS_DIR}/${name}`)!
      files.set(`${SESSIONS_DIR}/${name}`, { ...f, text: f.text.replace(/"writtenAt":"[^"]*"/, `"writtenAt":"${new Date(NOW + 30_000).toISOString()}"`) })
    }
    await clock.advance(30_000)
    expect(JSON.stringify(await pane.drawn())).toContain('"key":"pin-zz","label":"[*]"')
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: × dismisses a session to Hidden and ↺ restores it; Hidden is always there, closed at first`, async ($, on) => {
      const { saved } = await start($, on, surface, RATE_LIMITS, undefined, undefined, {
        sessionFiles: {
          'session-1.json': otherSession('aa', 'C:/work/alpha', 10_000),
          'session-2.json': otherSession('zz', 'C:/work/zulu', 10_000),
        },
      })
      await run($, 'monitor')
      const pane = await $.ui.mount<Surface, 'Pane'>({ ...SESSIONS_PANE, surface })
      const drawn = async () => JSON.stringify(await pane.drawn())
      const [dismiss, restore] = surface === 'terminal' ? ['[×]', '[↺]'] : ['×', '↺']
      const first = await drawn()
      // Every session has one, this one too; Hidden is there, closed, empty.
      for (const id of ['sess-1', 'aa', 'zz']) {
        expect(first).toContain(`"key":"hide-${id}","label":"${dismiss}","plain":true,"dimColor":true`)
      }
      expect(first).toContain('"key":"fold-hidden","label":"[▸] Hidden"')
      await pane.press({ key: 'fold-hidden' })
      expect(await drawn()).toContain('No hidden sessions.')
      await pane.press({ key: 'fold-hidden' })
      await pane.press({ key: 'hide-zz' })
      expect(saved.get('hiddenSessions')).toEqual({ zz: NOW })
      // Out of Sessions (one fewer there), into Hidden, still closed.
      const hidden = await drawn()
      expect(hidden).toContain('"key":"fold-hidden","label":"[▸] Hidden"')
      expect(hidden).not.toContain('zulu')
      await pane.press({ key: 'fold-sessions' })
      const counts = await drawn()
      expect(counts).toContain(pieces(tint('2')))
      expect(counts).toContain(pieces(tint('1')))
      await pane.press({ key: 'fold-sessions' })
      await pane.press({ key: 'fold-hidden' })
      const opened = await drawn()
      expect(opened.indexOf('"label":"[▾] Hidden"')).toBeLessThan(opened.indexOf('"label":"[▾] zulu"'))
      expect(opened).toContain(`"key":"hide-zz","label":"${restore}","plain":true,"dimColor":true`)
      // Restored: back in Sessions, by folder; Hidden stays, empty again.
      await pane.press({ key: 'hide-zz' })
      expect(saved.get('hiddenSessions')).toEqual({})
      const back = await drawn()
      expect(back).toContain('"key":"fold-hidden","label":"[▾] Hidden"')
      expect(back).toContain('No hidden sessions.')
      expect(back.indexOf('"label":"[▾] alpha"')).toBeLessThan(back.indexOf('"label":"[▾] zulu"'))
      expect(back.indexOf('"label":"[▾] zulu"')).toBeLessThan(back.indexOf('"label":"[▾] Hidden"'))
    })

    test(`${surface}: hiding this session keeps it here, first, and marks it hidden for the others' panels`, async ($, on) => {
      const { saved } = await start($, on, surface, RATE_LIMITS)
      await run($, 'monitor')
      const pane = await $.ui.mount<Surface, 'Pane'>({ ...SESSIONS_PANE, surface })
      await pane.press({ key: 'hide-sess-1' })
      expect(saved.get('hiddenSessions')).toEqual({ 'sess-1': NOW })
      const d = JSON.stringify(await pane.drawn())
      expect(d.indexOf('"label":"[▾] › proj"')).toBeLessThan(d.indexOf('"label":"[▸] Hidden"'))
      expect(d).toContain(`"key":"hide-sess-1","label":"${surface === 'terminal' ? '[↺]' : '↺'}"`)
    })
  }

  test("another session's hidden ones reach this one; a pinned hidden session keeps its pin there", async ($, on) => {
    const old = NOW - 31 * 24 * 60 * MINUTE
    const { saved } = await start($, on, 'terminal', RATE_LIMITS, undefined, {
      hiddenSessions: { zz: NOW, gone: old },
      pinned: { zz: NOW },
    }, {
      sessionFiles: {
        'session-1.json': otherSession('aa', 'C:/work/alpha', 10_000),
        'session-2.json': otherSession('zz', 'C:/work/zulu', 10_000),
      },
    })
    await run($, 'monitor')
    expect(saved.get('hiddenSessions')).toEqual({ zz: NOW })
    const pane = await $.ui.mount<Surface, 'Pane'>({ ...SESSIONS_PANE, surface: 'terminal' })
    await pane.press({ key: 'fold-hidden' })
    const d = JSON.stringify(await pane.drawn())
    // Pinned, but hidden: in Hidden, not above alpha in Sessions.
    expect(d.indexOf('"label":"[▾] alpha"')).toBeLessThan(d.indexOf('"label":"[▾] Hidden"'))
    expect(d.indexOf('"label":"[▾] Hidden"')).toBeLessThan(d.indexOf('"label":"[▾] zulu"'))
    expect(d).toContain('"key":"pin-zz","label":"[*]"')
  })

  test("a session is named by its project root, not the directory a shell cd took it to", async ($, on) => {
    const { sessionWrites } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, { cwd: 'C:/proj/.claude-plugin/types' })
    expect(lastFile(sessionWrites).file.session).toEqual({ id: 'sess-1', cwd: 'C:/proj/.claude-plugin/types', root: 'C:/proj' })
    await run($, 'monitor')
    const drawn = await (await mountSessions($, 'terminal'))()
    expect(drawn).toContain('"› proj"')
    expect(drawn).not.toContain('"types"')
  })

  test('an older file with no root is named by its directory', async ($, on) => {
    const older = otherSession('old-file', 'C:/work/legacy', 10_000)
    delete (older.file.session as { root?: string }).root
    await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, { sessionFiles: { 'session-1.json': older } })
    await run($, 'monitor')
    expect(await (await mountSessions($, 'terminal'))()).toContain('"legacy"')
  })

  test('with no usage windows (an API key), the panel has no Usage heading', async ($, on) => {
    await start($, on, 'terminal', [])
    await run($, 'monitor')
    const drawn = await (await mountSessions($, 'terminal'))()
    expect(drawn).not.toContain('"Usage"')
    expect(drawn).toContain('"› proj"')
  })

  test('while the panel is open, the others are read again every 30 s', async ($, on) => {
    const { files, clock } = await start($, on, 'desktop', RATE_LIMITS)
    await run($, 'monitor')
    const drawn = await mountSessions($, 'desktop')
    expect(await drawn()).toContain('No other sessions on this device')
    const other = otherSession('new', 'C:/work/new', 0)
    files.set(`${SESSIONS_DIR}/session-9.json`, { text: JSON.stringify(other.file), mtimeMs: NOW })
    await clock.advance(30_000)
    expect(await drawn()).toContain('"new"')
    expect(await drawn()).not.toContain('No other sessions on this device')
  })

  test('two sessions in one folder are told apart by id', async ($, on) => {
    await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, {
      sessionFiles: { 'session-1.json': otherSession('abcdef123456', 'D:/elsewhere/proj', 10_000) },
    })
    await run($, 'monitor')
    const drawn = await (await mountSessions($, 'terminal'))()
    expect(drawn).toContain('"children":["abcdef12"]')
    // On one line, cut at the edge, and cut before the title.
    expect(drawn).toContain(
      '{"type":"Box","props":{"flexShrink":100,"minWidth":0},"children":[{"type":"Text","props":{"dimColor":true,"wrap":"truncate"},"children":["sess-1"]}]}',
    )
    // This session is marked by a › before its name; the other is not.
    expect(count(drawn, '"label":"[▾] proj"')).toBe(1)
    expect(count(drawn, '"label":"[▾] › proj"')).toBe(1)
  })

  test('with the snapshot option off, the panel shows this session and says why no others', { options: { snapshot: false } }, async ($, on) => {
    await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, {
      sessionFiles: { 'session-1.json': otherSession('zz', 'C:/work/web', 10_000) },
    })
    await run($, 'monitor')
    const drawn = await (await mountSessions($, 'terminal'))()
    expect(drawn).toContain('"› proj"')
    expect(drawn).not.toContain('"web"')
    expect(drawn).toContain('Usage snapshot files is off')
  })
})

// A transcript in the test's projects folder, with a title line among others.
const TRANSCRIPTS = 'C:/Users/test/.claude/projects'
const transcript = (title: string, id: string) =>
  [
    JSON.stringify({ type: 'user', message: { content: 'hi' }, sessionId: id }),
    JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: id }),
    JSON.stringify({ type: 'assistant', message: { content: 'ok' }, sessionId: id }),
  ].join('\n')

// TW Monitor's settings, as the store keeps them, for a test to start with.
const monitorSettings = (monitor: Record<string, unknown>) => ({ settings: { warm: { mode: 'pings' }, monitor } })

// The order of sessions' headings in a drawing, by the names given.
const orderIn = (drawn: string, names: string[]) => {
  for (const name of names) if (!drawn.includes(`"label":"[▾] ${name}"`)) throw new Error(`${name} is not drawn`)
  return [...names].sort((a, b) => drawn.indexOf(`"label":"[▾] ${a}"`) - drawn.indexOf(`"label":"[▾] ${b}"`))
}

describe('TW Monitor settings', () => {
  test("the Monitor view: TW Monitor's settings alone, the same for every session", async ($, on) => {
    const { saved } = await start($, on, 'terminal', RATE_LIMITS)
    const { pane, drawn } = await mountPanel($, 'terminal')
    expect(await drawn()).toContain(radio('terminal', 'scope-session', 'Session', true))
    expect(await drawn()).toContain(radio('terminal', 'scope-monitor', 'Monitor', false))
    await pane.press({ key: 'scope-monitor' })
    const d = await drawn()
    expect(d).toContain(radio('terminal', 'scope-monitor', 'Monitor', true))
    for (const id of ['usage', 'lines', 'name', 'sort', 'filter', 'current']) expect(d).toContain(`"key":"section-monitor-${id}"`)
    expect(d).not.toContain('"key":"section-usage"')
    expect(d).not.toContain('"key":"reset-session"')
    expect(d).toContain('"key":"unpin-all","label":"[Unpin all sessions]","plain":true,"dimColor":true')
    expect(d).toContain('"key":"reset-monitor","label":"[Reset to default]","plain":true,"dimColor":true')
    // Under the settings, not above them.
    expect(d.indexOf('"key":"section-monitor-current"')).toBeLessThan(d.indexOf('"key":"reset-monitor"'))
    // Usage: a row per window, each piece a checkbox, every one on.
    await pane.press({ key: 'section-monitor-usage' })
    await pane.press({ key: 'section-monitor-usage-WK' })
    for (const [piece, name] of [['bar', 'Bar'], ['percent', 'Percentage'], ['reset', 'Reset timer'], ['rate', 'Burn rate']]) {
      expect(await drawn()).toContain(`${toggle('terminal', `monitor-usage-WK-${piece}`, true)}${name}"`)
    }
    // Session lines: Expanded and Collapsed, each with CTX and TTL.
    await pane.press({ key: 'section-monitor-lines' })
    await pane.press({ key: 'section-monitor-lines-collapsed' })
    const lines = await drawn()
    expect(lines).toContain(`${toggle('terminal', 'monitor-lines-collapsed-ctx-bar', false)}Bar"`)
    expect(lines).toContain(`${toggle('terminal', 'monitor-lines-collapsed-ctx-percent', false)}Percentage"`)
    expect(lines).toContain(`${toggle('terminal', 'monitor-lines-collapsed-ttl-timer', true)}Timer"`)
    expect(lines).toContain(`${toggle('terminal', 'monitor-lines-collapsed-ttl-warm', true)}Keep-warm"`)
    // Set for every session, never as this session's own.
    await pane.press({ key: 'monitor-usage-WK-rate' })
    expect(saved.get('settings')).toMatchObject({ monitor: { usage: { WK: { rate: false } } } })
    expect((saved.get(SESSION_KEY) as { settings?: { monitor?: unknown } } | undefined)?.settings?.monitor).toBeUndefined()
  })

  test('Usage: a window with nothing on is left out; with every window so, the section and its line, and the refresh moves to Sessions', async ($, on) => {
    const off = { bar: false, percent: false, reset: false, rate: false }
    await start($, on, 'terminal', RATE_LIMITS, undefined, monitorSettings({ usage: { '5H': off, WK: { bar: false, reset: false } } }))
    await run($, 'monitor')
    const monitor = await mountSessions($, 'terminal')
    const some = await monitor()
    // 5H gone; WK's percentage and burn rate, without its bar or reset time.
    expect(some).toContain('"key":"fold-usage"')
    expect(some).not.toContain('"children":["5H"]')
    expect(some).toContain('"children":["WK"]')
    expect(some).toContain('"31%"')
    expect(some).not.toContain('3d 4h')
    // WK's line: its label, then straight to its percentage, no bar.
    expect(some).toContain(
      '"children":["WK"]}]},{"type":"Box","props":{"width":8,"flexShrink":0},"children":[{"type":"Text","props":{"color":"#8fd18f","wrap":"truncate"},"children":["31%"]}',
    )
    expect(some).toContain('─'.repeat(50))
    // Every window off: no Usage, no line under it; the refresh on Sessions.
    const { pane } = await mountPanel($, 'terminal')
    await pane.press({ key: 'scope-monitor' })
    await pane.press({ key: 'section-monitor-usage' })
    await pane.press({ key: 'section-monitor-usage-WK' })
    for (const piece of ['percent', 'rate']) await pane.press({ key: `monitor-usage-WK-${piece}` })
    const none = await monitor()
    expect(none).not.toContain('"key":"fold-usage"')
    expect(none).not.toContain('─')
    expect(none.indexOf('"key":"fold-sessions"')).toBeLessThan(none.indexOf('"key":"refresh","label":"[↻]","plain":true,"dimColor":true'))
    expect(none).toContain('"key":"fold-hidden"')
  })

  test('the refresh, at the top right: on the Usage heading, and it reads the other sessions now', async ($, on) => {
    const { files } = await start($, on, 'desktop', RATE_LIMITS)
    await run($, 'monitor')
    const pane = await $.ui.mount<Surface, 'Pane'>({ ...SESSIONS_PANE, surface: 'desktop' })
    const drawn = async () => JSON.stringify(await pane.drawn())
    const first = await drawn()
    expect(first.indexOf('"key":"fold-usage"')).toBeLessThan(first.indexOf('"key":"refresh","label":"↻"'))
    expect(first.indexOf('"key":"refresh"')).toBeLessThan(first.indexOf('"key":"fold-sessions"'))
    const other = otherSession('new', 'C:/work/new', 0)
    files.set(`${SESSIONS_DIR}/session-7.json`, { text: JSON.stringify(other.file), mtimeMs: NOW })
    expect(await drawn()).not.toContain('"new"')
    await pane.press({ key: 'refresh' })
    expect(await drawn()).toContain('[▾] new')
  })

  test('Session lines: each piece of CTX and TTL, open and closed, on its own; a line with none left out', async ($, on) => {
    await start($, on, 'terminal', RATE_LIMITS, undefined, monitorSettings({
      usage: { '5H': { bar: false, percent: false, reset: false, rate: false }, WK: { bar: false, percent: false, reset: false, rate: false } },
      lines: {
        expanded: { ctx: { bar: false, tokens: false }, ttl: { bar: false, timer: false, warm: false } },
        collapsed: { ctx: { bar: true, percent: true, tokens: true }, ttl: { bar: true, warm: true } },
      },
    }), { sessionFiles: { 'session-1.json': otherSession('zz', 'C:/work/zulu', 10_000) } })
    await run($, 'monitor')
    const pane = await $.ui.mount<Surface, 'Pane'>({ ...SESSIONS_PANE, surface: 'terminal' })
    const open = JSON.stringify(await pane.drawn())
    // Open: CTX's percentage alone; no TTL line at all.
    expect(open).toContain('"64%"')
    expect(open).not.toContain('640k')
    expect(open).not.toContain('▄')
    expect(open).not.toContain('"children":["TTL"]')
    // Closed: every piece, a space between, the groups by a dot.
    await pane.press({ key: 'fold-session-zz' })
    const shut = JSON.stringify(await pane.drawn())
    expect(shut).toContain(
      '"children":["CTX "]},{"type":"Box","props":{"key":"1","flexShrink":0},"children":[{"type":"Box","props":{"flexDirection":"row","flexShrink":0},"children":[{"type":"Text","props":{"color":"#e8c66a"},"children":["▄▄▄"]}',
    )
    expect(shut).toContain('"children":["64%"]},{"type":"Text","props":{"dimColor":true,"wrap":"truncate"},"children":[" "]},{"type":"Text","props":{"dimColor":true,"wrap":"truncate"},"children":["640k / 1M"]}')
    expect(shut).toContain('"children":["52m"]},{"type":"Text","props":{"dimColor":true,"wrap":"truncate"},"children":[" "]},{"type":"Text","props":{"dimColor":true,"wrap":"truncate"},"children":["(Ping)"]}')
  })

  test('Name: titles read from the transcripts when a session is listed or the button pressed, never on a timer', async ($, on) => {
    const { saved, files, clock } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, {
      sessionFiles: { 'session-1.json': otherSession('aa', 'C:/work/alpha', 10_000) },
    })
    files.set(`${TRANSCRIPTS}/C--proj/sess-1.jsonl`, { text: transcript('Own work', 'sess-1'), mtimeMs: NOW })
    files.set(`${TRANSCRIPTS}/C--work-alpha/aa.jsonl`, { text: transcript('Alpha work', 'aa'), mtimeMs: NOW })
    await run($, 'monitor')
    const monitor = await mountSessions($, 'terminal')
    // By folder: no transcript read, nothing stored.
    expect(await monitor()).toContain('"label":"[▾] alpha"')
    expect(saved.get('titles')).toBeUndefined()
    const { pane } = await mountPanel($, 'terminal')
    await pane.press({ key: 'scope-monitor' })
    await pane.press({ key: 'section-monitor-name' })
    await pane.press({ key: 'monitor-name-title' })
    expect(saved.get('titles')).toEqual({ 'sess-1': { title: 'Own work', at: NOW }, aa: { title: 'Alpha work', at: NOW } })
    expect(await monitor()).toContain('"label":"[▾] Alpha work"')
    expect(await monitor()).toContain('"label":"[▾] › Own work"')
    // Renamed: not read again on its own, tick after tick (within the 2
    // minutes the other session's file stays fresh).
    files.set(`${TRANSCRIPTS}/C--work-alpha/aa.jsonl`, { text: transcript('Alpha, renamed', 'aa'), mtimeMs: NOW })
    await clock.advance(3 * 30_000)
    expect(await monitor()).toContain('"label":"[▾] Alpha work"')
    // The button again: every listed session read again.
    await pane.press({ key: 'monitor-name-title' })
    expect(await monitor()).toContain('"label":"[▾] Alpha, renamed"')
    await pane.press({ key: 'monitor-name-both' })
    expect(await monitor()).toContain('"label":"[▾] alpha / Alpha, renamed"')
    // A session listed later has its title read then.
    const zz = otherSession('zz', 'C:/work/zulu', 0)
    files.set(`${TRANSCRIPTS}/C--work-zulu/zz.jsonl`, { text: transcript('Zulu work', 'zz'), mtimeMs: NOW })
    files.set(`${SESSIONS_DIR}/session-5.json`, { text: JSON.stringify({ ...zz.file, writtenAt: new Date(NOW + 90_000).toISOString() }), mtimeMs: NOW + 90_000 })
    await clock.advance(30_000)
    expect(await monitor()).toContain('"label":"[▾] zulu / Zulu work"')
  })

  test('a transcript past what $.fs.read takes (4 MiB) is searched with git grep from its folder; with no git, the folder names it', async ($, on) => {
    const big = { size: 5 * 1024 * 1024, mtimeMs: NOW }
    const { files, runs } = await start($, on, 'terminal', RATE_LIMITS, undefined, monitorSettings({ name: 'title' }), {
      sessionFiles: {
        'session-1.json': otherSession('aa', 'C:/work/alpha', 10_000),
        'session-2.json': otherSession('zz', 'C:/work/zulu', 10_000),
      },
    })
    files.set(`${TRANSCRIPTS}/C--work-alpha/aa.jsonl`, { ...big, text: transcript('First', 'aa') + '\n' + transcript('Quoted "name"', 'aa') })
    files.set(`${TRANSCRIPTS}/C--work-zulu/zz.jsonl`, { text: transcript('Small one', 'zz'), mtimeMs: NOW })
    await run($, 'monitor')
    const d = await (await mountSessions($, 'terminal'))()
    expect(d).toContain('"label":"[▾] Quoted \\"name\\""')
    expect(d).toContain('"label":"[▾] Small one"')
    // git for the large one alone, run from its folder with the file's name.
    expect(runs).toEqual([['git', 'grep', '--no-index', '--no-color', '-h', '-o', '-E', '-e', '"type":"custom-title","customTitle":"(\\\\.|[^"])*"', '--', 'aa.jsonl']])
  })

  test('with no git, a large transcript leaves its session named by its folder', async ($, on) => {
    const { files } = await start($, on, 'terminal', RATE_LIMITS, undefined, monitorSettings({ name: 'title' }), {
      git: false,
      sessionFiles: { 'session-1.json': otherSession('aa', 'C:/work/alpha', 10_000) },
    })
    files.set(`${TRANSCRIPTS}/C--work-alpha/aa.jsonl`, { text: transcript('Alpha work', 'aa'), mtimeMs: NOW, size: 5 * 1024 * 1024 })
    await run($, 'monitor')
    expect(await (await mountSessions($, 'terminal'))()).toContain('"label":"[▾] alpha"')
  })

  for (const [sort, order] of [
    ['name', ['alpha', 'bravo', 'charlie']],
    ['context', ['bravo', 'charlie', 'alpha']],
    ['expiry', ['alpha', 'bravo', 'charlie']],
    ['activity', ['bravo', 'charlie', 'alpha']],
  ] as const) {
    test(`Sort by ${sort}; pinned ones first either way`, async ($, on) => {
      const session = (id: string, name: string, percent: number, expiresIn: number, activeAgo: number) =>
        otherSession(id, `C:/work/${name}`, 10_000, {
          context: { total: percent * 10_000, window: 1_000_000, percent },
          cache: { ttl: '1h', expiresAt: new Date(NOW + expiresIn).toISOString(), warm: expiresIn > 0, keepWarm: { on: false, mode: 'notify' } },
          lastActiveAt: new Date(NOW - activeAgo).toISOString(),
        })
      await start($, on, 'terminal', RATE_LIMITS, undefined, monitorSettings({ sort }), {
        sessionFiles: {
          'session-1.json': session('a', 'alpha', 30, 10 * MINUTE, 50 * MINUTE),
          'session-2.json': session('b', 'bravo', 80, 40 * MINUTE, 5 * MINUTE),
          'session-3.json': session('c', 'charlie', 55, -MINUTE, 20 * MINUTE),
        },
      })
      await run($, 'monitor')
      const pane = await $.ui.mount<Surface, 'Pane'>({ ...SESSIONS_PANE, surface: 'terminal' })
      const d = JSON.stringify(await pane.drawn())
      expect(orderIn(d, ['› proj', ...order])).toEqual(['› proj', ...order])
      await pane.press({ key: `pin-${order[2][0]}` })
      const pinnedFirst = JSON.stringify(await pane.drawn())
      expect(orderIn(pinnedFirst, ['› proj', ...order])).toEqual(['› proj', order[2], order[0], order[1]])
    })
  }

  test('Show: warm caches only, or those that answered recently, within a stepper', async ($, on) => {
    const session = (id: string, name: string, expiresIn: number, activeAgo: number) =>
      otherSession(id, `C:/work/${name}`, 10_000, {
        cache: { ttl: '1h', expiresAt: new Date(NOW + expiresIn).toISOString(), warm: expiresIn > 0, keepWarm: { on: false, mode: 'notify' } },
        lastActiveAt: new Date(NOW - activeAgo).toISOString(),
      })
    const { saved } = await start($, on, 'terminal', RATE_LIMITS, undefined, monitorSettings({ filter: 'warm' }), {
      sessionFiles: {
        'session-1.json': session('b', 'bravo', 40 * MINUTE, 5 * MINUTE),
        'session-2.json': session('c', 'charlie', -MINUTE, 20 * MINUTE),
      },
    })
    await run($, 'monitor')
    const monitor = await mountSessions($, 'terminal')
    expect(await monitor()).toContain('[▾] bravo')
    expect(await monitor()).not.toContain('charlie')
    // This session is listed whatever the filter.
    expect(await monitor()).toContain('[▾] › proj')
    const { pane, drawn } = await mountPanel($, 'terminal')
    await pane.press({ key: 'scope-monitor' })
    await pane.press({ key: 'section-monitor-filter' })
    expect(await drawn()).not.toContain('"key":"recent-up"')
    await pane.press({ key: 'monitor-filter-recent' })
    expect(await drawn()).toContain('"1 d"')
    for (let i = 0; i < 5; i++) await pane.press({ key: 'recent-down' })
    expect(await drawn()).toContain('"1 h"')
    for (let i = 0; i < 2; i++) await pane.press({ key: 'recent-down' })
    expect(saved.get('settings')).toMatchObject({ monitor: { filter: 'recent', recentMin: 15 } })
    expect(await monitor()).toContain('[▾] bravo')
    expect(await monitor()).not.toContain('charlie')
    await pane.press({ key: 'recent-up' })
    expect(await monitor()).toContain('[▾] charlie')
  })

  test('Current session, Default: this session follows the pins, Hidden and the order like any other', async ($, on) => {
    await start($, on, 'terminal', RATE_LIMITS, undefined, { ...monitorSettings({ current: 'default' }), pinned: { zz: NOW } }, {
      sessionFiles: {
        'session-1.json': otherSession('aa', 'C:/work/alpha', 10_000),
        'session-2.json': otherSession('zz', 'C:/work/zulu', 10_000),
      },
    })
    await run($, 'monitor')
    const pane = await $.ui.mount<Surface, 'Pane'>({ ...SESSIONS_PANE, surface: 'terminal' })
    const d = JSON.stringify(await pane.drawn())
    expect(orderIn(d, ['› proj', 'alpha', 'zulu'])).toEqual(['zulu', 'alpha', '› proj'])
    await pane.press({ key: 'hide-sess-1' })
    await pane.press({ key: 'fold-hidden' })
    const hidden = JSON.stringify(await pane.drawn())
    expect(hidden.indexOf('"label":"[▾] Hidden"')).toBeLessThan(hidden.indexOf('"label":"[▾] › proj"'))
  })

  test('Unpin all and Restore all hidden, for every session', async ($, on) => {
    const { saved } = await start($, on, 'terminal', RATE_LIMITS, undefined, { pinned: { aa: NOW }, hiddenSessions: { zz: NOW } })
    const { pane, drawn } = await mountPanel($, 'terminal')
    await pane.press({ key: 'scope-monitor' })
    expect(await drawn()).toContain('"key":"unpin-all","label":"[Unpin all sessions]","plain":true}')
    await pane.press({ key: 'unpin-all' })
    expect(saved.get('pinned')).toEqual({})
    await pane.press({ key: 'restore-all' })
    expect(saved.get('hiddenSessions')).toEqual({})
    expect(await drawn()).toContain('"key":"restore-all","label":"[Unhide all sessions]","plain":true,"dimColor":true')
  })

  test('Reset to default puts TW Monitor back; Reset to defaults leaves it, and the resets sit under the settings', async ($, on) => {
    const { saved } = await start($, on, 'terminal', RATE_LIMITS, undefined, {
      settings: { warm: { mode: 'pings' }, show: { WK: { expanded: false } }, monitor: { sort: 'context' } },
    })
    const { pane, drawn } = await mountPanel($, 'terminal', { scope: 'global' })
    const global = await drawn()
    expect(global.indexOf('"key":"section-cache"')).toBeLessThan(global.indexOf('"key":"reset-defaults"'))
    await pane.press({ key: 'reset-defaults' })
    expect(saved.get('settings')).toMatchObject({ monitor: { sort: 'context' }, show: { WK: { expanded: true } } })
    await pane.press({ key: 'scope-monitor' })
    await pane.press({ key: 'reset-monitor' })
    expect(saved.get('settings')).toMatchObject({ monitor: { sort: 'name' } })
  })

  test("a global change goes over the store's settings, not this session's copy: another session's change since stands", async ($, on) => {
    const { saved } = await start($, on, 'terminal', RATE_LIMITS)
    // Another session switches keep-warm to Both, after this one last read.
    saved.set('settings', { warm: { mode: 'both' } })
    const { pane } = await mountPanel($, 'terminal', { scope: 'global', open: ['context'] })
    await pane.press({ key: 'section-context-details' })
    await pane.press({ key: 'details-mcp' })
    expect(saved.get('settings')).toMatchObject({ warm: { mode: 'both' }, details: { mcp: true } })
  })

  test("keep-warm stops when its mode changes under it: another session's Pings never turn this one's reminder into pings", async ($, on) => {
    const { ui, band, clock, forks, saved } = await start($, on, 'terminal', RATE_LIMITS, undefined, DEFAULTS, FIVE_M)
    await turn($)
    await ui.press({ key: 'keep-warm' })
    expect(await band()).toContain(chipOf('terminal', 'keep-warm', warmLabel('terminal', 'Reminding'), CHIP_ON))
    saved.set('settings', { warm: { mode: 'pings' } })
    await clock.advance(30_000)
    expect(await band()).toContain('stopped: mode changed')
    await clock.advance(10 * MINUTE)
    expect(forks.length).toBe(0)
  })

  test('no reminder while a turn runs: the turn refreshes the cache', async ($, on) => {
    const { ui, clock, notes } = await start($, on, 'terminal', RATE_LIMITS, undefined, DEFAULTS, FIVE_M)
    await turn($)
    await ui.press({ key: 'keep-warm' })
    // A prompt at 3:50, its turn still running past the reminder's 4:00.
    await clock.advance(3 * MINUTE + 50_000)
    await $.turn.start({ text: 'hi', turnId: 't2' })
    await clock.advance(20_000)
    expect(notes).toEqual([])
  })

  test("after /clear the banner shows the new conversation's context, not the last one's", async ($, on) => {
    const context = { total: 212_200 }
    const { band } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, { context })
    context.total = 50_000
    await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } })
    expect(await band()).toContain('50k / 1M')
  })

  test('a run nobody is at the prompt for (claude -p, the SDK) writes no snapshot and no session file', async ($, on) => {
    const { writes, sessionWrites, clock } = await boot($, on, null, RATE_LIMITS, { surfaces: [], interactive: false })
    await clock.advance(30_000)
    expect(writes.length).toBe(0)
    expect(sessionWrites.length).toBe(0)
  })

  test('a session the desktop app draws, not interactive, writes its snapshot and its session file', async ($, on) => {
    const { writes, sessionWrites, clock } = await boot($, on, null, RATE_LIMITS, { surfaces: ['desktop'], interactive: false })
    await clock.advance(30_000)
    expect(writes.length).toBeGreaterThan(0)
    expect(sessionWrites.length).toBeGreaterThan(0)
  })

  test('a session a surface attaches to after its start writes its files from the next tick', async ($, on) => {
    const surfaces: RenderSurface[] = []
    const { writes, sessionWrites, clock } = await boot($, on, null, RATE_LIMITS, { surfaces, interactive: false })
    await clock.advance(30_000)
    expect(sessionWrites.length).toBe(0)
    surfaces.push('desktop')
    await clock.advance(30_000)
    expect(writes.length).toBeGreaterThan(0)
    expect(sessionWrites.length).toBeGreaterThan(0)
  })

  test('a transcript not found yet stores no title; looked for again 2 minutes on, it is read', async ($, on) => {
    const { saved, files, clock } = await start($, on, 'terminal', RATE_LIMITS, undefined, monitorSettings({ name: 'title' }), {
      sessionFiles: { 'session-1.json': otherSession('aa', 'C:/work/alpha', 0) },
    })
    await run($, 'monitor')
    expect(saved.get('titles')).not.toHaveProperty('aa')
    files.set(`${TRANSCRIPTS}/C--work-alpha/aa.jsonl`, { text: transcript('Alpha work', 'aa'), mtimeMs: NOW })
    const monitor = await mountSessions($, 'terminal')
    // Still fresh, the other session's file, as each tick goes by.
    const keepFresh = (at: number) => {
      const f = files.get(`${SESSIONS_DIR}/session-1.json`)!
      files.set(`${SESSIONS_DIR}/session-1.json`, { ...f, text: f.text.replace(/"writtenAt":"[^"]*"/, `"writtenAt":"${new Date(at).toISOString()}"`) })
    }
    keepFresh(NOW + 30_000)
    await clock.advance(30_000)
    expect(await monitor()).toContain('"label":"[▾] alpha"')
    keepFresh(NOW + 120_000)
    await clock.advance(90_000)
    expect(await monitor()).toContain('"label":"[▾] Alpha work"')
  })

  test('pressing Title reads every session\'s title, TW Monitor open or not', async ($, on) => {
    const { saved, files } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, {
      sessionFiles: { 'session-1.json': otherSession('aa', 'C:/work/alpha', 10_000) },
    })
    files.set(`${TRANSCRIPTS}/C--work-alpha/aa.jsonl`, { text: transcript('Alpha work', 'aa'), mtimeMs: NOW })
    const { pane } = await mountPanel($, 'terminal')
    await pane.press({ key: 'scope-monitor' })
    await pane.press({ key: 'section-monitor-name' })
    await pane.press({ key: 'monitor-name-title' })
    expect(saved.get('titles')).toMatchObject({ aa: { title: 'Alpha work' } })
  })

  test("a transcript under CLAUDE_CONFIG_DIR, or in another project's folder, is found", async ($, on) => {
    const { files } = await start($, on, 'terminal', RATE_LIMITS, undefined, monitorSettings({ name: 'title' }), {
      env: { USERPROFILE: 'C:/Users/test', CLAUDE_CONFIG_DIR: 'D:/cfg' },
      sessionFiles: {
        'session-1.json': otherSession('aa', 'C:/work/alpha', 10_000),
        'session-2.json': otherSession('zz', 'C:/work/zulu', 10_000),
      },
    })
    files.set('D:/cfg/projects/C--work-alpha/aa.jsonl', { text: transcript('Alpha work', 'aa'), mtimeMs: NOW })
    // zz's transcript in a folder its path does not name: found by looking in each.
    files.set('D:/cfg/projects/C--moved-elsewhere/zz.jsonl', { text: transcript('Zulu work', 'zz'), mtimeMs: NOW })
    await run($, 'monitor')
    const d = await (await mountSessions($, 'terminal'))()
    expect(d).toContain('"label":"[▾] Alpha work"')
    expect(d).toContain('"label":"[▾] Zulu work"')
  })

  test("a session file or stored windows that do not read as such are left out, not drawn", async ($, on) => {
    const bad = otherSession('aa', 'C:/work/alpha', 10_000)
    await start($, on, 'terminal', [], undefined, { limits: [{ kind: 5 }, { kind: 'five_hour', percentUsed: 'x' }] }, {
      sessionFiles: {
        'session-1.json': { ...bad, file: { ...bad.file, session: { id: 42, cwd: 'C:/work/alpha' } } },
        'session-2.json': otherSession('zz', 'C:/work/zulu', 10_000),
      },
    })
    await run($, 'monitor')
    const d = await (await mountSessions($, 'terminal'))()
    expect(d).not.toContain('alpha')
    expect(d).toContain('"label":"[▾] zulu"')
    // The stored windows left out: the reading has the context alone.
    expect((await run($, 'text')).text).toBe('CTX 21% (212k / 1M)')
  })

  test("the context's alert in this session's view: this session's own", async ($, on) => {
    const { saved } = await start($, on, 'terminal', RATE_LIMITS)
    const { pane } = await mountPanel($, 'terminal', { open: ['context'] })
    await pane.press({ key: 'alert-CTX-enable' })
    expect(saved.get(SESSION_KEY)).toMatchObject({ settings: { alert: { CTX: 99 } } })
    expect(saved.get('settings')).toEqual({ warm: { mode: 'pings' } })
  })

  test('with no plan usage (an API key) and CTX and TTL hidden, the banner says so, not that every part is hidden', async ($, on) => {
    const { band } = await start($, on, 'terminal', [], undefined, {
      settings: { warm: { mode: 'pings' }, show: { CTX: { expanded: false }, TTL: { expanded: false } } },
    })
    expect(await band()).toContain('CTX and TTL are hidden, and there is no plan usage to show.')
    expect(await band()).not.toContain('All parts are hidden')
  })

  test('hiding the banner with /token-watch stops pings; a reminder, which costs nothing, stays', async ($, on) => {
    const pings = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, FIVE_M)
    await turn($)
    await pings.ui.press({ key: 'keep-warm' })
    expect((await run($, '')).text).toBe('Token Watch banner hidden.')
    await pings.clock.advance(10 * MINUTE)
    expect(pings.forks.length).toBe(0)
    expect(snapshotOf(pings.writes).cache.keepWarm.on).toBe(false)
  })

  test('a reminder stays on with the banner hidden', async ($, on) => {
    const { ui, clock, notes } = await start($, on, 'terminal', RATE_LIMITS, undefined, DEFAULTS, FIVE_M)
    await turn($)
    await ui.press({ key: 'keep-warm' })
    await run($, '')
    await clock.advance(4 * MINUTE)
    expect(notes.length).toBe(1)
  })

  test("readings go on with the banner hidden and snapshot files off: the context's alert still comes", { options: { snapshot: false } }, async ($, on) => {
    const context = { total: 212_200 }
    const { notes } = await boot($, on, 'terminal', RATE_LIMITS, { stored: { isShown: false, settings: { alert: { CTX: 50 } } }, context })
    context.total = 600_000
    await $.session.measure(MEASURE)
    expect(notes).toEqual(['Context at 60% (600k / 1M).'])
  })

  test('the home folder is HOME off Windows, even with a Windows USERPROFILE carried in (WSL)', async ($, on) => {
    await boot($, on, 'terminal', RATE_LIMITS, { env: { HOME: '/home/you', USERPROFILE: 'C:\\Users\\you' } })
    expect((await run($, 'file')).text).toBe('Token Watch snapshot: /home/you/.claude/token-watch/usage.json (written 0s ago).')
  })

  test('on Windows the home folder is USERPROFILE', async ($, on) => {
    await boot($, on, 'terminal', RATE_LIMITS, { env: { OS: 'Windows_NT', HOME: '/c/Users/you', USERPROFILE: 'C:\\Users\\you' } })
    expect((await run($, 'file')).text).toBe('Token Watch snapshot: C:\\Users\\you\\.claude\\token-watch\\usage.json (written 0s ago).')
  })

  test('/token-watch file in a run nobody is at the prompt for says why there is no snapshot', async ($, on) => {
    await boot($, on, null, RATE_LIMITS, { surfaces: [], interactive: false })
    expect((await run($, 'file')).text).toContain('claude -p')
  })

  test("back to Folder, the titles read from other sessions' transcripts are not kept", async ($, on) => {
    const { saved, files } = await start($, on, 'terminal', RATE_LIMITS, undefined, monitorSettings({ name: 'title' }), {
      sessionFiles: { 'session-1.json': otherSession('aa', 'C:/work/alpha', 10_000) },
    })
    files.set(`${TRANSCRIPTS}/C--work-alpha/aa.jsonl`, { text: transcript('Alpha work', 'aa'), mtimeMs: NOW })
    await run($, 'monitor')
    expect(saved.get('titles')).toMatchObject({ aa: { title: 'Alpha work' } })
    const { pane } = await mountPanel($, 'terminal')
    await pane.press({ key: 'scope-monitor' })
    await pane.press({ key: 'section-monitor-name' })
    await pane.press({ key: 'monitor-name-folder' })
    expect(saved.get('titles')).toBeUndefined()
  })

  test('Clear all data: ten presses within 5 s, counted down, clear every stored thing; fewer, or slower, clear nothing', async ($, on) => {
    const { saved, clock } = await start($, on, 'terminal', RATE_LIMITS, undefined, {
      settings: { warm: { mode: 'pings' }, show: { WK: { expanded: false } } },
      pinned: { aa: NOW },
      view: 'plain',
    })
    const { pane, drawn } = await mountPanel($, 'terminal', { scope: 'global' })
    // Below everything, with its note.
    const first = await drawn()
    expect(first.indexOf('/token-watch settings opens this panel again')).toBeLessThan(first.indexOf('"key":"clear-all"'))
    expect(first).toContain('Press 10 times within 5 seconds to delete everything Token Watch has stored')
    for (let i = 0; i < 9; i++) await pane.press({ key: 'clear-all' })
    expect(await drawn()).toContain('"children":["[Clear all data: 1 more]"]')
    expect(saved.get('pinned')).toEqual({ aa: NOW })
    // 5 s after the first, the count starts over.
    await clock.advance(5_000)
    expect(await drawn()).toContain('"key":"clear-all","label":"[Clear all data]"')
    await pane.press({ key: 'clear-all' })
    expect(saved.get('pinned')).toEqual({ aa: NOW })
    await clock.advance(5_000)
    for (let i = 0; i < 10; i++) await pane.press({ key: 'clear-all' })
    expect([...saved.keys()]).toEqual([])
    expect(await drawn()).toContain('"key":"clear-all","label":"[Clear all data]"')
  })
})

const LINE = '5H 62% (2h 14m) · WK 31% (3d 4h) · CTX 21% (212k / 1M)'
const MEASURE: SessionMeasureInput = { context: { tokens: 212_200, window: 1_000_000, percent: 21 }, rateLimits: RATE_LIMITS, changed: ['context'] }
const SNAPSHOT_PATH = 'C:/Users/test/.claude/token-watch/usage.json'
const run = ($: Engine, args: string) =>
  $.command.run({
    command: 'token-watch',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

describe('token-watch as text', () => {
  test('where nothing draws (the VS Code chat panel), /token-watch answers the reading and hides nothing', async ($, on) => {
    const { saved } = await boot($, on, null, RATE_LIMITS, { surfaces: ['vscode'] })
    expect((await run($, '')).text).toBe(LINE)
    expect((await run($, '')).text).toBe(LINE)
    expect(saved.get('isShown')).toBeUndefined()
  })

  test('a headless run with no surface gets the same line', async ($, on) => {
    await boot($, on, null, RATE_LIMITS, { surfaces: [] })
    expect((await run($, '')).text).toBe(LINE)
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: /token-watch text answers the line and leaves the band as it is`, async ($, on) => {
      const { band, saved } = await start($, on, surface, RATE_LIMITS)
      expect((await run($, 'text')).text).toBe(LINE)
      expect(await band()).toContain('"CTX"')
      expect(saved.get('isShown')).toBeUndefined()
      expect((await run($, 'nonsense')).text).toBe('Usage: /token-watch [text|file|settings|monitor]')
      expect((await run($, '')).text).toBe('Token Watch banner hidden.')
    })
  }

  test('once there is a countdown the line ends with the TTL, and with keep-warm on, its caps and the last ping', async ($, on) => {
    const { ui, clock } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, FIVE_M)
    await turn($)
    expect((await run($, 'text')).text).toBe(`${LINE} · TTL 5:00 (5m · FORCE_PROMPT_CACHING_5M)`)
    await ui.press({ key: 'keep-warm' })
    await clock.advance(PING_AT)
    expect((await run($, 'text')).text).toBe(
      `${LINE.replace('2h 14m', '2h 10m').replace('3d 4h', '3d 3h')} · TTL 5:00 (5m · FORCE_PROMPT_CACHING_5M, keep-warm pings 1/30 · 03:45 / 2:00:00, last ping read 34k wrote 14k)`,
    )
  })

  test('without plan limits the line is the context alone', async ($, on) => {
    await boot($, on, null, [], { surfaces: ['vscode'] })
    expect((await run($, '')).text).toBe('CTX 21% (212k / 1M)')
  })

  test('extra windows follow 5H and WK, named by model where the kind names one', async ($, on) => {
    const extra = [
      { kind: 'seven_day_fable', percentUsed: 88, resetsAt: SEVEN_DAY.resetsAt },
      { kind: 'mystery_window', percentUsed: 5 },
    ]
    await boot($, on, null, [...extra, ...RATE_LIMITS], { surfaces: ['vscode'] })
    expect((await run($, '')).text).toBe(
      '5H 62% (2h 14m) · WK 31% (3d 4h) · FB 88% (3d 4h) · mystery_window 5% · CTX 21% (212k / 1M)',
    )
  })

  test('a window whose reset time has passed reads 0% with no countdown', async ($, on) => {
    const past = new Date(NOW - MINUTE).toISOString()
    const saved = [FIVE_HOUR, { kind: 'seven_day', percentUsed: 90, resetsAt: past }]
    await boot($, on, null, [], { surfaces: ['vscode'], stored: { limits: saved } })
    expect((await run($, '')).text).toBe('5H 62% (2h 14m) · WK 0% · CTX 21% (212k / 1M)')
  })
})

describe('usage snapshot', () => {
  test('the first reading writes ~/.claude/token-watch/usage.json', async ($, on) => {
    const { writes } = await boot($, on, 'terminal', RATE_LIMITS)
    expect(writes.length).toBe(1)
    expect(slash(written(writes, 0).path)).toBe(SNAPSHOT_PATH)
    expect(written(writes, 0).text.endsWith('\n')).toBe(true)
    const snapshot = snapshotOf(writes, 0)
    expect(snapshot.schema).toBe(1)
    expect(snapshot.writtenAt).toBe('2026-10-03T12:00:00.000Z')
    expect(snapshot.session).toEqual({ id: 'sess-1', cwd: 'C:/proj' })
    // The windows in the band's order with its labels, as reported: a
    // reader shows one whose reset time has passed at 0%.
    expect(snapshot.windows).toEqual([
      { kind: 'five_hour', label: '5H', percentUsed: 62.4, resetsAt: FIVE_HOUR.resetsAt, ratePerHour: null, fullAt: null },
      { kind: 'seven_day', label: 'WK', percentUsed: 31, resetsAt: SEVEN_DAY.resetsAt, ratePerHour: null, fullAt: null },
    ])
    expect(snapshot.context.total).toBe(212_200)
    expect(snapshot.context.window).toBe(1_000_000)
    expect(snapshot.context.percent).toBe(21)
    expect(snapshot.context.compactsAt).toBe(950_000)
    expect(snapshot.context.categories.map((c: { label: string }) => c.label)).toEqual([
      'system prompt', 'tools', 'mcp tools', 'agents', 'memory files', 'skills', 'messages', 'free', 'buffer',
    ])
    expect(snapshot.context.categories.find((c: { label: string }) => c.label === 'messages')).toEqual({
      label: 'messages', tokens: 186_000, color: '#d97757', kind: 'used',
    })
    // The cache before the first response: the TTL known, nothing to expire.
    expect(snapshot.cache).toEqual({
      ttl: '1h',
      ttlSource: 'subscription',
      expiresAt: null,
      warm: false,
      keepWarm: { on: false, mode: 'pings', pings: 0, maxPings: 8, startedAt: null, maxMs: 28_800_000, lastPing: null },
    })
  })

  test('a response gives the snapshot an expiry; the cache reads warm until then', async ($, on) => {
    const { writes, clock } = await boot($, on, 'terminal', RATE_LIMITS)
    await turn($)
    const warm = snapshotOf(writes)
    expect(warm.cache.expiresAt).toBe(new Date(NOW + 60 * MINUTE).toISOString())
    expect(warm.cache.warm).toBe(true)
    await clock.advance(61 * MINUTE)
    const cold = snapshotOf(writes)
    expect(cold.cache.warm).toBe(false)
  })

  test('the path is joined with the separator of the home directory', async ($, on) => {
    await boot($, on, 'terminal', RATE_LIMITS, { env: { USERPROFILE: 'C:\\Users\\you\\' } })
    expect((await run($, 'file')).text).toBe(
      'Token Watch snapshot: C:\\Users\\you\\.claude\\token-watch\\usage.json (written 0s ago).',
    )
  })

  test('on a POSIX home (HOME only) the path uses slashes', async ($, on) => {
    await boot($, on, 'terminal', RATE_LIMITS, { env: { HOME: '/home/you/' } })
    expect((await run($, 'file')).text).toBe(
      'Token Watch snapshot: /home/you/.claude/token-watch/usage.json (written 0s ago).',
    )
  })

  test('a reading with the same figures is not written again; a changed one is', async ($, on) => {
    const limits = [...RATE_LIMITS]
    const { writes } = await boot($, on, 'terminal', limits)
    await $.session.measure(MEASURE)
    expect(writes.length).toBe(1)
    limits[1] = { ...FIVE_HOUR, percentUsed: 70 }
    await $.session.measure(MEASURE)
    expect(writes.length).toBe(2)
    expect(snapshotOf(writes, 1).windows[0].percentUsed).toBe(70)
  })

  test('with the band hidden, readings still feed the snapshot', async ($, on) => {
    const limits = [...RATE_LIMITS]
    const { writes } = await boot($, on, 'terminal', limits, { stored: { isShown: false } })
    limits[1] = { ...FIVE_HOUR, percentUsed: 70 }
    await $.session.measure(MEASURE)
    expect(writes.length).toBe(2)
  })

  test('every 30s the snapshot is written again, so a reader can tell the session is alive', async ($, on) => {
    const { writes, clock } = await boot($, on, 'terminal', RATE_LIMITS)
    await clock.advance(30_000)
    expect(writes.length).toBe(2)
    expect(snapshotOf(writes, 1).writtenAt).toBe('2026-10-03T12:00:30.000Z')
  })

  test('another session that wrote more recently keeps the file until its snapshot goes stale', async ($, on) => {
    // The file's mtime is 5s past this session's own write: another session's.
    const { writes, clock } = await boot($, on, 'terminal', RATE_LIMITS, { statMtimeMs: NOW + 5_000 })
    await clock.advance(30_000)
    expect(writes.length).toBe(1)
    // 120s on, that snapshot is 115s old, still fresh: this session stays quiet.
    await clock.advance(90_000)
    expect(writes.length).toBe(1)
    // 150s on, it is 145s old, past the 120s it stays fresh: this one takes over,
    // before a reader would call the file stale at 150s.
    await clock.advance(30_000)
    expect(writes.length).toBe(2)
  })

  test('the snapshot option turns the file off', { options: { snapshot: false } }, async ($, on) => {
    const { writes, clock } = await boot($, on, 'terminal', RATE_LIMITS)
    await clock.advance(30_000)
    expect(writes.length).toBe(0)
    expect((await run($, 'file')).text).toContain('off')
  })

  test('with no home directory there is nowhere to write, and /token-watch file says so', async ($, on) => {
    const { writes } = await boot($, on, 'terminal', RATE_LIMITS, { env: {} })
    expect(writes.length).toBe(0)
    expect((await run($, 'file')).text).toContain('nowhere to write')
  })

  test('/token-watch file names the snapshot and its age', async ($, on) => {
    const { clock } = await boot($, on, 'terminal', RATE_LIMITS)
    await clock.advance(12_000)
    expect((await run($, 'file')).text).toBe(`Token Watch snapshot: ${SNAPSHOT_PATH} (written 12s ago).`)
  })
})