import { describe, expect, mock, test } from 'claude-code/testing'

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
const RATE_LIMITS = [
  { kind: 'seven_day', percentUsed: 31, resetsAt: new Date(NOW + (3 * 24 * 60 + 4 * 60) * MINUTE).toISOString() },
  { kind: 'five_hour', percentUsed: 62.4, resetsAt: new Date(NOW + (2 * 60 + 14) * MINUTE).toISOString() },
]

// The spike's figures: the first response wrote a 47k prompt; a warm fork
// read 33.5k of it (its request differs from the main thread's in its tail)
// and wrote its own 13.7k tail.
const LAST_RESPONSE = { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 47_221 }
const PING_OK = {
  isAnswered: true,
  text: 'ok',
  usage: { input_tokens: 16, output_tokens: 4, cache_read_input_tokens: 33_510, cache_creation_input_tokens: 13_714 },
}
const PING_COLD = { ...PING_OK, usage: { ...PING_OK.usage, cache_read_input_tokens: 12, cache_creation_input_tokens: 47_200 } }
const PING_FAILED = {
  isAnswered: false,
  reason: 'api-error',
  status: 529,
  error: 'overloaded',
  usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
}
const TURN_USAGE = { ...LAST_RESPONSE, model: 'claude-opus-5-5' }
const MESSAGE = { role: 'user', text: 'hi', toolUses: [] }

// `apiUsage`: the last response's counts, which the band reads the prompt's
// size from; null before one came back.
const usage = (rateLimits: unknown[], apiUsage: unknown = null) => ({
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
      autocompactSource: 'auto',
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
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120 },
} as const

// How many times `part` appears in `s`.
const count = (s: string, part: string) => s.split(part).length - 1

// A right click moves to the next view; a left click does nothing.
const rightClick = { type: 'up', x: 5, y: 0, button: 'right' } as const
const leftClick = { type: 'up', x: 5, y: 0, button: 'left' } as const

// How a surface paints a coloured piece: a Box background on the desktop, a
// run of glyphs in a terminal.
const paint = (surface: 'terminal' | 'desktop', color: string) =>
  surface === 'desktop' ? `"backgroundColor":"${color}"` : `"color":"${color}","wrap":"wrap"`

// Keep-warm's colours and the countdown's labels as the tree spells them.
const WARM_ON = '#7fd4a0'
const WARM_OFF = '#6e7383'
const WARM_COLD = '#e06c6c'
// The desktop's button chips: grey, and green for Keep warm while it is on.
const CHIP_OFF = '#4a5060'
const CHIP_ON = '#2f7a4f'

// A Button as the tree spells it. On the terminal it stands bare, a plain
// Button with just its key and label (no plain, dim or variant props). On the
// desktop it sits inside a Box that fills it as a chip.
const buttonJson = (key: string, label: string) => `{"type":"Button","props":{"key":"${key}","label":"${label}"}`
const chipOf = (surface: 'terminal' | 'desktop', key: string, label: string, fill: string) =>
  surface === 'desktop'
    ? `{"type":"Box","props":{"key":"${key}-chip","flexShrink":0,"paddingX":1,"backgroundColor":"${fill}"},"children":[${buttonJson(key, label)}`
    : buttonJson(key, label)
const keepWarmOn = (surface: 'terminal' | 'desktop') => chipOf(surface, 'keep-warm', 'Keep warm', CHIP_ON)
const keepWarmOff = (surface: 'terminal' | 'desktop') => chipOf(surface, 'keep-warm', 'Keep warm', CHIP_OFF)
const refreshCapsBtn = (surface: 'terminal' | 'desktop') => chipOf(surface, 'refresh-caps', 'Refresh caps', CHIP_OFF)
// The collapsed views' timer: the countdown as a chip, always grey.
const cacheBtn = (surface: 'terminal' | 'desktop', text: string) => chipOf(surface, 'cache-timer', text, CHIP_OFF)
// The expanded row's timer text, "52:50 / 60:00", plain, or red once the cache is cold.
const timerTxt = (text: string) => `{"type":"Text","children":["${text}"]}`
const coldTxt = (text: string) => `{"type":"Text","props":{"color":"${WARM_COLD}"},"children":["${text}"]}`
const REFRESH_CAPS = '"label":"Refresh caps"'

type Boot = {
  // What $.session.surfaces() answers; [surface] by default, none for null.
  surfaces?: readonly string[]
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
  fork?: unknown
  // A reason: the engine denies $.model.fork with it, so the call throws.
  forkThrows?: string
  // The last response's counts in the breakdown; none by default.
  apiUsage?: unknown
}

type Write = { path: string; text: string }

// Starts a session with the engine's answers stubbed: the clock at NOW, the
// store (readable back as `saved`), the environment, the usage, the settings,
// the model (every fork's prompt is collected in `forks`), the session's
// surfaces, id and cwd, the turn and prompt events' bottoms, and the file
// system (every $.fs.write is collected in `writes`).
async function boot($, on, surface: 'terminal' | 'desktop' | null, rateLimits: unknown[], options: Boot = {}) {
  const writes: Write[] = []
  const forks: string[] = []
  const saved = new Map<string, unknown>(Object.entries(options.stored ?? {}))
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, options.env ?? { USERPROFILE: 'C:/Users/test' })
  on('store.get', ($, e) => ({ value: saved.get(e.key) }) as never)
  on('store.set', ($, e) => {
    saved.set(e.key, e.value)
    return { value: undefined } as never
  })
  on('store.delete', ($, e) => {
    saved.delete(e.key)
    return { value: undefined } as never
  })
  on('settings.read', () => ({ value: options.settings ?? {} }) as never)
  on('model.fork', ($, e) => {
    forks.push(e.prompt)
    if (options.forkThrows) return { deny: options.forkThrows } as never
    return { value: options.fork ?? PING_OK } as never
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.compact', ($, e) => ({ messages: e.messages }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return options.beneath ? <Text>{options.beneath}</Text> : <Box />
  })
  on('session.usage', () => ({ value: usage(rateLimits, options.apiUsage ?? null) }) as never)
  on('session.surfaces', () => ({ value: options.surfaces ?? (surface ? [surface] : []) }) as never)
  on('session.id', () => ({ value: 'sess-1' }) as never)
  on('session.cwd', () => ({ value: 'C:/proj' }) as never)
  on('fs.stat', () =>
    (options.statMtimeMs === undefined
      ? { deny: 'ENOENT' }
      : { value: { kind: 'file', size: 1, mtimeMs: options.statMtimeMs, isLink: false } }) as never,
  )
  on('fs.write', ($, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined } as never
  })
  await $.session.start({ cwd: '.', surface, isInteractive: true } as never)

  return { writes, saved, clock, forks }
}

// `beneath`: text a mod beneath this one draws in the band, if any.
// `stored`: what the mod's store holds from earlier sessions.
async function start($, on, surface, rateLimits: unknown[], beneath?: string, stored?: Record<string, unknown>, options: Boot = {}) {
  const { writes, saved, clock, forks } = await boot($, on, surface, rateLimits, { ...options, beneath, stored })
  const ui = await $.ui.mount({ ...BAND, surface } as never)
  await ui.resize({ columns: 116, rows: 8, in: 'band' })
  const band = async () => JSON.stringify(await ui.drawn({ in: 'band' }))

  return { ui, band, writes, saved, clock, forks }
}

// One main-thread turn, started and ended at the clock's time now.
async function turn($, id = 't1') {
  await $.turn.start({ text: 'hi', turnId: id } as never)
  await $.turn.complete({ answer: 'ok', durationMs: 5_000, isAborted: false, turnId: id, reason: 'answer', usage: TURN_USAGE } as never)
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
        // The one other filled box is Keep warm's grey chip.
        expect(count(expanded, `"backgroundColor":"${CHIP_OFF}"`)).toBe(1)
        expect(expanded).not.toContain(CHIP_ON)
      } else {
        // Clipped runs of lower blocks; no box background and no 60% box.
        expect(expanded).toContain('▄')
        expect(expanded).not.toMatch(/"type":"Box","props":{[^}]*"backgroundColor"/)
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
      // The TTL row before the first response: "--:-- / 60:00" and a Keep
      // warm Button (a grey chip on the desktop). No bar, no swatch, no source
      // (an hour on a subscription, idle compaction on), no caps.
      expect(expanded).toContain(timerTxt('--:-- / 60:00'))
      expect(expanded).toContain(keepWarmOff(surface))
      expect(expanded).not.toContain('cache-timer')
      expect(expanded).not.toContain(paint(surface, WARM_OFF))
      expect(expanded).not.toContain('subscription')
      expect(expanded).not.toContain('idle compaction')
      expect(expanded).not.toContain('Pings:')
      expect(expanded).not.toContain('Refresh caps')
      // 62% is a warning, 31% and 21% are plain.
      expect(expanded).toContain('{"type":"Text","props":{"wrap":"truncate","color":"#e8c66a"},"children":["62%"]}')
      expect(expanded).toContain('{"type":"Text","props":{"wrap":"truncate"},"children":["31%"]}')
      expect(expanded).toContain('{"type":"Text","props":{"wrap":"truncate"},"children":["21%"]}')
      // One legend line, clipped not wrapped, indented under the bars,
      // largest first, tokens only, short names, no free.
      // The legend wraps onto more lines rather than overflowing the band.
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
      // No header or badge, and no compaction text: the marker shows it.
      expect(expanded).not.toContain('◆')
      expect(expanded).not.toContain('" 21% "')
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
      expect(collapsed).not.toContain('#111111')
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
        expect(collapsed).not.toMatch(/"type":"Box","props":{[^}]*"backgroundColor"/)
        expect(count(collapsed, '"color":"#3d4250","wrap":"wrap"')).toBe(3)
        expect(count(collapsed, '"color":"#2e3139","wrap":"wrap"')).toBe(1)
        expect(count(collapsed, '"color":"#d97757","wrap":"wrap"')).toBe(1)
      }
      expect(collapsed).not.toContain('▏')
      expect(collapsed).not.toContain('messages')
      expect(collapsed).not.toContain('compacts at')
      expect(collapsed).not.toContain('2h 14m')
      // The timer ends the line: the swatch and the countdown as a chip, and
      // nothing else of the TTL row.
      expect(collapsed).toContain(cacheBtn(surface, '--:--'))
      expect(collapsed).toContain(paint(surface, WARM_OFF))
      expect(collapsed).not.toContain('Keep warm')
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
      // Without bars the one coloured piece left is the timer's swatch.
      expect(count(plain, surface === 'desktop' ? '"height":"60%"' : '"wrap":"wrap"')).toBe(1)
      expect(plain).toContain('212k / 1M')
      expect(plain).toContain(cacheBtn(surface, '--:--'))
      await ui.pointer(rightClick)
      expect(await band()).toContain('messages')

      const off = await $.command.run({ command: 'context-bar', args: '' } as never)
      expect(off.text).toBe('Token Watch hidden.')
      expect(JSON.stringify(await ui.drawn())).not.toContain('band.tsx')

      const shown = await $.command.run({ command: 'context-bar', args: '' } as never)
      expect(shown.text).toBe('Token Watch shown.')
      expect(await band()).toContain('"CTX"')
    })

    test(`${surface}: a window the API adds later, such as Fable's, is drawn after 5H and WK`, async ($, on) => {
      const extra = [
        { kind: 'seven_day_fable', percentUsed: 88, resetsAt: RATE_LIMITS[0].resetsAt },
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
      // timer and Keep warm button at every width, and never shows the source.
      const narrow = await band()
      expect(narrow).toContain('"62%"')
      expect(narrow).not.toContain('2h 14m')
      expect(narrow).not.toContain('212k / 1M')
      expect(narrow).toContain(keepWarmOff(surface))
      expect(narrow).toContain(timerTxt('--:-- / 60:00'))
      expect(narrow).not.toContain('subscription')
      await ui.resize({ columns: 70, rows: 8, in: 'band' })
      const middling = await band()
      expect(middling).toContain(keepWarmOff(surface))
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
      expect(collapsed).toContain(cacheBtn(surface, '--:--'))
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
        RATE_LIMITS[1],
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
        RATE_LIMITS[1],
        { kind: 'seven_day_fable', percentUsed: 70, resetsAt: new Date(NOW - MINUTE).toISOString() },
      ]
      const { band } = await start($, on, surface, [RATE_LIMITS[0]], undefined, { limits: saved })
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
      expect(count(plain, barLeaf)).toBe(1)
      expect(plain).toContain('"62%"')
      expect(plain).toContain('"CTX"')
      expect(plain).toContain('212k / 1M')
      expect(plain).toContain(cacheBtn(surface, '--:--'))
      expect(saved.get('view')).toBe('plain')
      await ui.pointer(leftClick)
      expect(count(await band(), barLeaf)).toBe(1)

      await ui.pointer(rightClick)
      expect(await band()).toContain('borderStyle')
      expect(saved.get('view')).toBe('expanded')
    })

    test(`${surface}: a new session restores the saved view, and reads the 1.1 keys once in its place`, async ($, on) => {
      const barLeaf = surface === 'desktop' ? '"height":"60%"' : '"wrap":"wrap"'
      // Saved by 1.2: the collapsed line with its bars.
      const first = await start($, on, surface, RATE_LIMITS, undefined, { view: 'bars' })
      const bars = await first.band()
      expect(bars).not.toContain('borderStyle')
      expect(bars).toContain(barLeaf)
      await first.ui.unmount()
    })

    test(`${surface}: the 1.1 keys isCollapsed and showBars become the view they meant, and are removed`, async ($, on) => {
      const barLeaf = surface === 'desktop' ? '"height":"60%"' : '"wrap":"wrap"'
      const { ui, band, saved } = await start($, on, surface, RATE_LIMITS, undefined, { showBars: false, isCollapsed: true })
      const plain = await band()
      expect(plain).not.toContain('borderStyle')
      expect(count(plain, barLeaf)).toBe(1)
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
      expect(JSON.parse(writes[writes.length - 1].text).cache).toMatchObject({ ttl: '5m', ttlSource: 'API key or cloud' })

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
      // Past the hour the cache is cold: "cold / 60:00" in red.
      await clock.advance(47 * MINUTE + 30_000)
      const cold = await band()
      expect(cold).toContain(coldTxt('cold / 60:00'))
      expect(cold).not.toContain(timerTxt('cold / 60:00'))
      // The expanded row has no swatch; the collapsed timer's swatch goes red.
      expect(cold).not.toContain(paint(surface, WARM_COLD))
      await ui.pointer(rightClick)
      const collapsed = await band()
      expect(collapsed).toContain(cacheBtn(surface, 'cold'))
      expect(collapsed).toContain(paint(surface, WARM_COLD))
      expect(collapsed).not.toContain(paint(surface, WARM_OFF))
    })

    test(`${surface}: while a turn runs the timer shows the whole TTL`, async ($, on) => {
      const { band } = await start($, on, surface, RATE_LIMITS)
      await $.turn.start({ text: 'hi', turnId: 't1' } as never)
      expect(await band()).toContain(timerTxt('60:00 / 60:00'))
    })

    test(`${surface}: pressing Keep warm or the timer before any response leaves keep-warm off and says why`, async ($, on) => {
      const { ui, band, forks } = await start($, on, surface, RATE_LIMITS)
      await ui.press({ key: 'keep-warm' })
      const after = await band()
      expect(after).toContain(keepWarmOff(surface))
      expect(after).toContain(timerTxt('--:-- / 60:00'))
      expect(after).toContain('keep-warm: nothing cached yet')
      expect(forks.length).toBe(0)
      // The collapsed timer is the same control: it leaves keep-warm off too.
      await ui.pointer(rightClick)
      await ui.press({ key: 'cache-timer' })
      expect(await band()).toContain(paint(surface, WARM_OFF))
      await ui.pointer(rightClick)
      await ui.pointer(rightClick)
      const expanded = await band()
      expect(expanded).toContain(keepWarmOff(surface))
      expect(expanded).toContain('keep-warm: nothing cached yet')
      expect(forks.length).toBe(0)
    })

    test(`${surface}: Keep warm and the collapsed views' timer both toggle keep-warm`, async ($, on) => {
      const { ui, band } = await start($, on, surface, RATE_LIMITS)
      await turn($)
      await ui.press({ key: 'keep-warm' })
      const on1 = await band()
      expect(on1).toContain(keepWarmOn(surface))
      if (surface === 'desktop') expect(on1).not.toContain(keepWarmOff(surface))
      expect(on1).toContain(timerTxt('60:00 / 60:00'))
      expect(on1).toContain('Pings: 0/8  Time: 00:00 / 8:00:00')
      expect(on1).toContain(refreshCapsBtn(surface))
      // No swatch, no TTL source and no timer Button in the expanded row.
      expect(on1).not.toContain(paint(surface, WARM_ON))
      expect(on1).not.toContain('subscription')
      expect(on1).not.toContain('cache-timer')
      await ui.press({ key: 'keep-warm' })
      const off1 = await band()
      expect(off1).toContain(keepWarmOff(surface))
      expect(off1).not.toContain('Pings:')
      expect(off1).not.toContain('Refresh caps')
      await ui.pointer(rightClick)
      await ui.press({ key: 'cache-timer' })
      expect(await band()).toContain(paint(surface, WARM_ON))
      await ui.pointer(rightClick)
      await ui.press({ key: 'cache-timer' })
      expect(await band()).toContain(paint(surface, WARM_OFF))
    })

    test(`${surface}: Keep warm's chip is green while keep-warm is on and grey while it is off`, async ($, on) => {
      const { ui, band } = await start($, on, surface, RATE_LIMITS)
      await turn($)
      expect(await band()).toContain(keepWarmOff(surface))
      await ui.press({ key: 'keep-warm' })
      const on1 = await band()
      expect(on1).toContain(keepWarmOn(surface))
      if (surface === 'desktop') {
        // The chip is a Box around the Button: green while on; the Refresh
        // caps chip beside it stays grey.
        expect(on1).toContain(
          `"backgroundColor":"${CHIP_ON}"},"children":[{"type":"Button","props":{"key":"keep-warm","label":"Keep warm"}`,
        )
        expect(count(on1, `"backgroundColor":"${CHIP_ON}"`)).toBe(1)
        expect(count(on1, `"backgroundColor":"${CHIP_OFF}"`)).toBe(1)
      } else {
        // A terminal draws its own "[ label ]": no Box background to colour.
        expect(on1).not.toMatch(/"type":"Box","props":{[^}]*"backgroundColor"/)
        expect(on1).not.toContain('"variant"')
        expect(on1).not.toContain('"plain"')
      }
      await ui.press({ key: 'keep-warm' })
      const off1 = await band()
      expect(off1).toContain(keepWarmOff(surface))
      if (surface === 'desktop') {
        expect(off1).toContain(
          `"backgroundColor":"${CHIP_OFF}"},"children":[{"type":"Button","props":{"key":"keep-warm","label":"Keep warm"}`,
        )
        expect(off1).not.toContain(CHIP_ON)
      } else {
        expect(off1).not.toMatch(/"type":"Box","props":{[^}]*"backgroundColor"/)
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
      const snapshot = JSON.parse(writes[writes.length - 1].text)
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
      expect(stopped).toContain(coldTxt('cold / 5:00'))
      expect(stopped).toContain(keepWarmOff(surface))
      await ui.pointer(rightClick)
      const collapsed = await band()
      expect(collapsed).toContain(cacheBtn(surface, 'cold'))
      expect(collapsed).toContain(paint(surface, WARM_COLD))
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
      expect(await band()).toContain('ping failed: HooksError: token-watch: $.model.fork: socket hang up')
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
      await $.prompt.submit({ text: 'later', wait: false, origin: { kind: 'task-notification' } } as never)
      expect(await band()).toContain(keepWarmOn(surface))
      await $.prompt.submit({ text: 'back', wait: false, origin: { kind: 'composer' } } as never)
      expect(await band()).toContain(keepWarmOff(surface))
      await clock.advance(5 * MINUTE)
      expect(forks.length).toBe(0)
    })

    test(`${surface}: no ping while a turn runs; the response restarts the countdown`, async ($, on) => {
      const { ui, clock, forks } = await start($, on, surface, RATE_LIMITS, undefined, undefined, FIVE_M)
      await turn($)
      await ui.press({ key: 'keep-warm' })
      await clock.advance(100_000)
      await $.turn.start({ text: 'more', turnId: 't2' } as never)
      await clock.advance(5 * MINUTE)
      expect(forks.length).toBe(0)
      await $.turn.complete({ answer: 'ok', durationMs: 5_000, isAborted: false, turnId: 't2', reason: 'answer', usage: TURN_USAGE } as never)
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
      await $.session.compact({ trigger: 'manual', messages: [MESSAGE] } as never)
      const compacted = await band()
      expect(compacted).toContain(keepWarmOff(surface))
      expect(compacted).toContain('stopped: compaction')
      expect(compacted).toContain(timerTxt('5:00 / 5:00'))
      await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } } as never)
      expect(await band()).toContain(timerTxt('--:-- / 5:00'))
    })

    // The TTL follows Claude Code's controls in their order of precedence, then
    // the plan. The band no longer says where the TTL comes from, so the
    // precedence is asserted where the source is still reported: the snapshot's
    // ttlSource and the /context-bar text line.
    const TTL_CASES: [string, Boot, unknown[], '5m' | '1h', string][] = [
      ['FORCE_PROMPT_CACHING_5M beats the TTL variable', { env: { USERPROFILE: 'C:/Users/test', FORCE_PROMPT_CACHING_5M: '1', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' } }, RATE_LIMITS, '5m', 'FORCE_PROMPT_CACHING_5M'],
      ['the TTL variable beats the setting', { env: { USERPROFILE: 'C:/Users/test', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, settings: { promptCacheTtl: '5m' } }, [], '1h', 'CLAUDE_CODE_PROMPT_CACHE_TTL'],
      ['the setting beats the plan', { settings: { promptCacheTtl: '5m' } }, RATE_LIMITS, '5m', 'promptCacheTtl'],
      ['ENABLE_PROMPT_CACHING_1H beats the plan', { env: { USERPROFILE: 'C:/Users/test', ENABLE_PROMPT_CACHING_1H: '1' } }, [], '1h', 'ENABLE_PROMPT_CACHING_1H'],
      ['a window at 100% means usage credits: five minutes', {}, [{ kind: 'five_hour', percentUsed: 100 }, RATE_LIMITS[0]], '5m', 'over plan limit'],
      ['idle compaction off leaves the hour on a subscription', { settings: { idleCompaction: false } }, RATE_LIMITS, '1h', 'subscription'],
    ]
    for (const [name, options, limits, ttl, source] of TTL_CASES) {
      test(`${surface}: TTL: ${name}`, async ($, on) => {
        const { band, writes } = await start($, on, surface, limits, undefined, undefined, options)
        await turn($)
        const full = ttl === '1h' ? '60:00' : '5:00'
        expect(JSON.parse(writes[writes.length - 1].text).cache).toMatchObject({ ttl, ttlSource: source })
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
      expect(JSON.parse(writes[writes.length - 1].text).cache).toMatchObject({ ttl: '1h', ttlSource: 'confirmed' })
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
      expect(narrow).not.toContain('Refresh caps')
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
      const snapshot = JSON.parse(writes[writes.length - 1].text)
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
      expect(before).not.toContain('Refresh caps')
      expect(before).not.toContain('Pings:')
      const written = writes.length
      // There is no such Button to press, and a message that arrives anyway
      // (a stale view) changes nothing.
      await expect(ui.press({ key: 'refresh-caps' })).rejects.toThrow('refresh-caps')
      await ui.post({ action: 'refresh-caps' })
      const after = await band()
      expect(after).toContain(keepWarmOff(surface))
      expect(after).not.toContain('Pings:')
      expect(after).not.toContain('Refresh caps')
      expect(after).not.toContain('keep-warm:')
      expect(JSON.parse(writes[writes.length - 1].text).cache.keepWarm).toMatchObject({ on: false, pings: 0, startedAt: null })
      expect(writes.length).toBe(written)
      expect(forks.length).toBe(0)
      // And it does not turn keep-warm on.
      await ui.pointer(rightClick)
      expect(await band()).toContain(paint(surface, WARM_OFF))
    })
  }
})

const LINE = '5H 62% (2h 14m) · WK 31% (3d 4h) · CTX 21% (212k / 1M)'
const MEASURE = { context: { tokens: 212_200, window: 1_000_000, percent: 21 }, rateLimits: RATE_LIMITS, changed: ['context'] }
const SNAPSHOT_PATH = 'C:/Users/test/.claude/token-watch/usage.json'
const run = ($, args: string) => $.command.run({ command: 'context-bar', args } as never)
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
      expect((await run($, 'nonsense')).text).toBe('Usage: /context-bar [text|file]')
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
      `${LINE.replace('2h 14m', '2h 10m').replace('3d 4h', '3d 3h')} · TTL 5:00 (5m · FORCE_PROMPT_CACHING_5M, keep-warm pings 1/30 · 0:03/2:00, last ping read 34k wrote 14k)`,
    )
  })

  test('without plan limits the line is the context alone', async ($, on) => {
    await boot($, on, null, [], { surfaces: ['vscode'] })
    expect((await run($, '')).text).toBe('CTX 21% (212k / 1M)')
  })

  test('extra windows follow 5H and WK, named by model where the kind names one', async ($, on) => {
    const extra = [
      { kind: 'seven_day_fable', percentUsed: 88, resetsAt: RATE_LIMITS[0].resetsAt },
      { kind: 'mystery_window', percentUsed: 5 },
    ]
    await boot($, on, null, [...extra, ...RATE_LIMITS], { surfaces: ['vscode'] })
    expect((await run($, '')).text).toBe(
      '5H 62% (2h 14m) · WK 31% (3d 4h) · FB 88% (3d 4h) · mystery_window 5% · CTX 21% (212k / 1M)',
    )
  })

  test('a window whose reset time has passed reads 0% with no countdown', async ($, on) => {
    const past = new Date(NOW - MINUTE).toISOString()
    const saved = [RATE_LIMITS[1], { kind: 'seven_day', percentUsed: 90, resetsAt: past }]
    await boot($, on, null, [], { surfaces: ['vscode'], stored: { limits: saved } })
    expect((await run($, '')).text).toBe('5H 62% (2h 14m) · WK 0% · CTX 21% (212k / 1M)')
  })
})

describe('usage snapshot', () => {
  test('the first reading writes ~/.claude/token-watch/usage.json', async ($, on) => {
    const { writes } = await boot($, on, 'terminal', RATE_LIMITS)
    expect(writes.length).toBe(1)
    expect(slash(writes[0].path)).toBe(SNAPSHOT_PATH)
    expect(writes[0].text.endsWith('\n')).toBe(true)
    const snapshot = JSON.parse(writes[0].text)
    expect(snapshot.schema).toBe(1)
    expect(snapshot.writtenAt).toBe('2026-10-03T12:00:00.000Z')
    expect(snapshot.session).toEqual({ id: 'sess-1', cwd: 'C:/proj' })
    // The windows in the band's order with its labels, as reported: a
    // reader shows one whose reset time has passed at 0%.
    expect(snapshot.windows).toEqual([
      { kind: 'five_hour', label: '5H', percentUsed: 62.4, resetsAt: RATE_LIMITS[1].resetsAt },
      { kind: 'seven_day', label: 'WK', percentUsed: 31, resetsAt: RATE_LIMITS[0].resetsAt },
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
    const warm = JSON.parse(writes[writes.length - 1].text)
    expect(warm.cache.expiresAt).toBe(new Date(NOW + 60 * MINUTE).toISOString())
    expect(warm.cache.warm).toBe(true)
    await clock.advance(61 * MINUTE)
    const cold = JSON.parse(writes[writes.length - 1].text)
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
    await $.session.measure(MEASURE as never)
    expect(writes.length).toBe(1)
    limits[1] = { ...RATE_LIMITS[1], percentUsed: 70 }
    await $.session.measure(MEASURE as never)
    expect(writes.length).toBe(2)
    expect(JSON.parse(writes[1].text).windows[0].percentUsed).toBe(70)
  })

  test('with the band hidden, readings still feed the snapshot', async ($, on) => {
    const limits = [...RATE_LIMITS]
    const { writes } = await boot($, on, 'terminal', limits, { stored: { isShown: false } })
    limits[1] = { ...RATE_LIMITS[1], percentUsed: 70 }
    await $.session.measure(MEASURE as never)
    expect(writes.length).toBe(2)
  })

  test('every 30s the snapshot is written again, so a reader can tell the session is alive', async ($, on) => {
    const { writes, clock } = await boot($, on, 'terminal', RATE_LIMITS)
    await clock.advance(30_000)
    expect(writes.length).toBe(2)
    expect(JSON.parse(writes[1].text).writtenAt).toBe('2026-10-03T12:00:30.000Z')
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