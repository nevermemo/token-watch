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

// `apiUsage`: the last response's counts, which the band reads the prompt's
// size from; null before one came back.
const usage = (rateLimits: SessionRateLimit[], apiUsage: ModelUsage | null = null) => ({
  startedAt: 0,
  rateLimits,
  context: {
    tokens: 212_200,
    window: 1_000_000,
    percent: 21,
    breakdown: {
      categories: ROWS.map(([name, tokens, kind]) => ({ name, tokens, kind, color: 'inactive', isDeferred: false })),
      totalTokens: 212_200,
      maxTokens: 1_000_000,
      rawMaxTokens: 1_000_000,
      autocompactSource: 'auto' as const,
      percentage: 21,
      gridRows: [],
      model: 'claude-opus-5-5',
      memoryFiles: [],
      mcpTools: [],
      agents: [],
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
}

type Write = { path: string; text: string }

// A gate for forks held open: `open()` lets every waiting fork answer.
function gate() {
  let open = () => {}
  const opened = new Promise<void>(resolve => {
    open = resolve
  })
  return { opened, open }
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
  const saved = new Map<string, unknown>(Object.entries(options.stored ?? {}))
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
  on('session.usage', () => ({ value: usage(rateLimits, options.apiUsage ?? null) }))
  on('session.surfaces', () => ({ value: options.surfaces ?? (surface ? [surface] : []) }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: 'C:/proj' }))
  on('fs.stat', () =>
    (options.statMtimeMs === undefined
      ? { deny: 'ENOENT' }
      : { value: { kind: 'file', size: 1, mtimeMs: options.statMtimeMs, isLink: false } }),
  )
  on('ui.open', ($, e) => {
    opens.push({ ...e })
    return { value: { isPlaced: true } }
  })
  on('fs.write', ($, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  await $.session.start({ cwd: '.', surface, isInteractive: true })

  return { writes, saved, clock, forks, opens }
}

// `beneath`: text a mod beneath this one draws in the band, if any.
// `stored`: what the mod's store holds from earlier sessions.
async function start($: Engine, on: On, surface: Surface, rateLimits: SessionRateLimit[], beneath?: string, stored?: Record<string, unknown>, options: Boot = {}) {
  const { writes, saved, clock, forks, opens } = await boot($, on, surface, rateLimits, { ...options, beneath, stored })
  const ui = await $.ui.mount<Surface, 'AbovePrompt'>({ ...BAND, surface })
  await ui.resize({ columns: 116, rows: 8, in: 'band' })
  const band = async () => JSON.stringify(await ui.drawn({ in: 'band' }))

  // The whole drawing, the settings button beside the band included.
  const tree = async () => JSON.stringify(await ui.drawn())

  return { ui, band, tree, writes, saved, clock, forks, opens }
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
      expect(off.text).toBe('Token Watch hidden.')
      expect(JSON.stringify(await ui.drawn())).not.toContain('band.tsx')

      const shown = await run($, '')
      expect(shown.text).toBe('Token Watch shown.')
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
      // Four windows' meters would leave the context bar under 20 cells at 116
      // columns, so the meters go first and the detail stays; wider, they return.
      expect(collapsed).not.toContain('"width":10,"height":1')
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
      expect(await band()).toContain('keep-warm: the cache is already cold')
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
      expect(stopped).toContain('stopped: cache was cold')
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
      expect(await band()).toContain('stopped: 2 pings failed')
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
      expect(await band()).toContain('stopped: 2 pings failed')
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
    // ttlSource and the /context-bar text line.
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
      expect(after).not.toContain('stopped: 2 pings failed')
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
    expect(await band()).toContain('stopped: cache went cold')
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
    expect(after).not.toContain('stopped: 2 pings failed')
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
    expect(after).not.toContain('stopped: 2 pings failed')
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

// The settings panel as the engine raises it once open: docked, 44 columns.
const PANE = {
  plugin: 'token-watch',
  component: 'Pane',
  requestId: 'token-watch-settings',
  props: { title: 'Token Watch', isFocused: false, bodyColumns: 44, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

async function mountPanel($: Engine, surface: Surface) {
  const pane = await $.ui.mount<Surface, 'Pane'>({ ...PANE, surface })
  const drawn = async () => JSON.stringify(await pane.drawn())
  return { pane, drawn }
}

// A part's toggle as the panel draws it: the mark alone in the Button.
const toggle = (surface: Surface, part: string, isShown: boolean) =>
  `"key":"part-${part}","label":"${surface === 'terminal' ? (isShown ? '[\u25cf]' : '[\u25cb]') : isShown ? '\u2611' : '\u2610'}"`

describe('settings panel', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: a settings button beside the expanded band opens the panel; the collapsed views have none`, async ($, on) => {
      const { ui, band, tree, opens } = await start($, on, surface, RATE_LIMITS)
      // Outside the band's own drawing, so a press on it is the person's.
      expect(await tree()).toContain(`"key":"settings","label":"${surface === 'terminal' ? '[\u2261]' : '\u2630'}"`)
      expect(await band()).not.toContain('"key":"settings"')
      await ui.press({ key: 'settings' })
      expect(opens).toEqual([{ id: 'token-watch-settings', title: 'Token Watch', columns: 44 }])
      await ui.pointer(rightClick)
      expect(await tree()).not.toContain('"key":"settings"')
    })

    test(`${surface}: the panel's toggles hide parts of the band in every view, and are saved`, async ($, on) => {
      const { ui, band, saved } = await start($, on, surface, RATE_LIMITS)
      const { pane, drawn } = await mountPanel($, surface)
      for (const part of ['5H', 'WK', 'other', 'CTX', 'TTL']) expect(await drawn()).toContain(toggle(surface, part, true))
      expect(await drawn()).toContain('OTH:')

      await pane.press({ key: 'part-5H' })
      expect(saved.get('hidden')).toEqual(['5H'])
      expect(await drawn()).toContain(toggle(surface, '5H', false))
      let expanded = await band()
      expect(expanded).not.toContain('"5H"')
      expect(expanded).toContain('"WK"')

      // Hiding the context takes its legend with it.
      await pane.press({ key: 'part-CTX' })
      expanded = await band()
      expect(expanded).not.toContain('"CTX"')
      expect(expanded).not.toContain('messages 186k')
      expect(expanded).toContain('"TTL"')

      await ui.pointer(rightClick)
      const collapsed = await band()
      expect(collapsed).not.toContain('"5H"')
      expect(collapsed).not.toContain('"CTX"')
      expect(collapsed).toContain('"WK"')
      expect(collapsed).toContain('cache-timer')

      await pane.press({ key: 'part-5H' })
      expect(saved.get('hidden')).toEqual(['CTX'])
      expect(await band()).toContain('"5H"')
    })
  }

  test('hiding TTL turns keep-warm off and takes its controls; a press from before does nothing', async ($, on) => {
    const { ui, band, clock, forks, writes } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, FIVE_M)
    await turn($)
    await ui.press({ key: 'keep-warm' })
    const { pane } = await mountPanel($, 'terminal')
    await pane.press({ key: 'part-TTL' })
    expect(await band()).not.toContain('"TTL"')
    expect(snapshotOf(writes).cache.keepWarm.on).toBe(false)
    await ui.post({ action: 'keep-warm' })
    expect(snapshotOf(writes).cache.keepWarm.on).toBe(false)
    await ui.pointer(rightClick)
    expect(await band()).not.toContain('cache-timer')
    await clock.advance(10 * MINUTE)
    expect(forks.length).toBe(0)
  })

  test('with every part hidden, a collapsed view keeps the settings button, the way back', async ($, on) => {
    const { tree, band } = await start($, on, 'terminal', RATE_LIMITS, undefined, {
      view: 'bars',
      hidden: ['5H', 'WK', 'other', 'CTX', 'TTL'],
    })
    expect(await band()).not.toContain('"WK"')
    expect(await tree()).toContain('"key":"settings"')
  })

  test('saved parts are restored, and anything unknown is dropped', async ($, on) => {
    const { band, saved } = await start($, on, 'terminal', RATE_LIMITS, undefined, { hidden: ['WK', 'nonsense', 3] })
    expect(await band()).not.toContain('"WK"')
    const { pane } = await mountPanel($, 'terminal')
    await pane.press({ key: 'part-WK' })
    expect(saved.get('hidden')).toEqual([])
    expect(await band()).toContain('"WK"')
  })

  test('/context-bar settings opens the panel', async ($, on) => {
    const { opens } = await start($, on, 'terminal', RATE_LIMITS)
    expect((await run($, 'settings')).text).toBe('Token Watch settings opened.')
    expect(opens).toEqual([{ id: 'token-watch-settings', title: 'Token Watch', columns: 44 }])
  })

  test("the caps steppers move this TTL's caps a step at a time, within bounds; saved, and Reset restores them", async ($, on) => {
    const { ui, band, saved, writes } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, FIVE_M)
    await turn($)
    const { pane, drawn } = await mountPanel($, 'terminal')
    expect(await drawn()).toContain('Keep-warm caps (5m TTL)')
    await pane.press({ key: 'pings-up' })
    for (let i = 0; i < 5; i++) await pane.press({ key: 'hours-up' })
    // Six hours is the most on five minutes: one more press changes nothing.
    expect(saved.get('caps')).toEqual({ '1h': { pings: 8, hours: 8 }, '5m': { pings: 35, hours: 6 } })
    await pane.press({ key: 'hours-up' })
    expect(saved.get('caps')).toEqual({ '1h': { pings: 8, hours: 8 }, '5m': { pings: 35, hours: 6 } })
    expect(snapshotOf(writes).cache.keepWarm).toMatchObject({ maxPings: 35, maxMs: 6 * 60 * MINUTE })
    await ui.press({ key: 'keep-warm' })
    expect(await band()).toContain('Pings: 0/35  Time: 00:00 / 6:00:00')
    await pane.press({ key: 'caps-reset' })
    expect(saved.get('caps')).toEqual({ '1h': { pings: 8, hours: 8 }, '5m': { pings: 30, hours: 2 } })
    expect(await band()).toContain('Pings: 0/30  Time: 00:00 / 2:00:00')
  })

  test('keep-warm stops at the caps the panel set', { timeoutMs: 30_000 }, async ($, on) => {
    const { ui, band, clock, forks } = await start($, on, 'terminal', RATE_LIMITS, undefined, undefined, FIVE_M)
    await turn($)
    const { pane } = await mountPanel($, 'terminal')
    // Five pings is the least on five minutes: further presses stay there.
    for (let i = 0; i < 6; i++) await pane.press({ key: 'pings-down' })
    await ui.press({ key: 'keep-warm' })
    for (let i = 0; i < 6; i++) await clock.advance(PING_AT)
    expect(forks.length).toBe(5)
    expect(await band()).toContain('stopped: 5 pings')
  })

  test('saved caps are restored; a value off its stepper or out of bounds falls back to the default', async ($, on) => {
    const { writes } = await start($, on, 'terminal', RATE_LIMITS, undefined, {
      caps: { '5m': { pings: 33, hours: 4 }, '1h': { pings: 99, hours: 'x' } },
    }, FIVE_M)
    await turn($)
    // 33 pings is off the five-minute stepper's grid of 5: the default 30 stands.
    expect(snapshotOf(writes).cache.keepWarm).toMatchObject({ maxPings: 30, maxMs: 4 * 60 * MINUTE })
  })
})

const LINE = '5H 62% (2h 14m) · WK 31% (3d 4h) · CTX 21% (212k / 1M)'
const MEASURE: SessionMeasureInput = { context: { tokens: 212_200, window: 1_000_000, percent: 21 }, rateLimits: RATE_LIMITS, changed: ['context'] }
const SNAPSHOT_PATH = 'C:/Users/test/.claude/token-watch/usage.json'
const run = ($: Engine, args: string) =>
  $.command.run({
    command: 'context-bar',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
// The engine hands $.fs.write the path resolved to the platform's own form
// (backslashes on Windows), whatever string the mod gave; the mod's own
// spelling is what /context-bar file reports.
const slash = (p: string) => p.replace(/\\/g, '/')

describe('context-bar as text', () => {
  test('where nothing draws (the VS Code chat panel), /context-bar answers the reading and hides nothing', async ($, on) => {
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
    test(`${surface}: /context-bar text answers the line and leaves the band as it is`, async ($, on) => {
      const { band, saved } = await start($, on, surface, RATE_LIMITS)
      expect((await run($, 'text')).text).toBe(LINE)
      expect(await band()).toContain('"CTX"')
      expect(saved.get('isShown')).toBeUndefined()
      expect((await run($, 'nonsense')).text).toBe('Usage: /context-bar [text|file|settings]')
      expect((await run($, '')).text).toBe('Token Watch hidden.')
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
      { kind: 'five_hour', label: '5H', percentUsed: 62.4, resetsAt: FIVE_HOUR.resetsAt },
      { kind: 'seven_day', label: 'WK', percentUsed: 31, resetsAt: SEVEN_DAY.resetsAt },
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
      keepWarm: { on: false, pings: 0, maxPings: 8, startedAt: null, maxMs: 28_800_000, lastPing: null },
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

  test('with no home directory there is nowhere to write, and /context-bar file says so', async ($, on) => {
    const { writes } = await boot($, on, 'terminal', RATE_LIMITS, { env: {} })
    expect(writes.length).toBe(0)
    expect((await run($, 'file')).text).toContain('nowhere to write')
  })

  test('/context-bar file names the snapshot and its age', async ($, on) => {
    const { clock } = await boot($, on, 'terminal', RATE_LIMITS)
    await clock.advance(12_000)
    expect((await run($, 'file')).text).toBe(`Token Watch snapshot: ${SNAPSHOT_PATH} (written 12s ago).`)
  })
})