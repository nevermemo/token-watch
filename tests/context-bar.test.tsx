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

const usage = (rateLimits: unknown[]) => ({
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
      apiUsage: null,
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

// A right click expands or collapses the band; a left click turns the bars on or off.
const rightClick = { type: 'up', x: 5, y: 0, button: 'right' } as const
const leftClick = { type: 'up', x: 5, y: 0, button: 'left' } as const

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
}

type Write = { path: string; text: string }

// Starts a session with the engine's answers stubbed: the clock at NOW, the
// store (readable back as `saved`), the environment, the usage, the
// session's surfaces, id and cwd, and the file system (every $.fs.write is
// collected in `writes`).
async function boot($, on, surface: 'terminal' | 'desktop' | null, rateLimits: unknown[], options: Boot = {}) {
  const writes: Write[] = []
  const saved = new Map<string, unknown>(Object.entries(options.stored ?? {}))
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, options.env ?? { USERPROFILE: 'C:/Users/test' })
  on('store.get', ($, e) => ({ value: saved.get(e.key) }) as never)
  on('store.set', ($, e) => {
    saved.set(e.key, e.value)
    return { value: undefined } as never
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return options.beneath ? <Text>{options.beneath}</Text> : <Box />
  })
  on('session.usage', () => ({ value: usage(rateLimits) }) as never)
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

  return { writes, saved, clock }
}

// `beneath`: text a mod beneath this one draws in the band, if any.
// `stored`: what the mod's store holds from earlier sessions.
async function start($, on, surface, rateLimits: unknown[], beneath?: string, stored?: Record<string, unknown>) {
  const { writes, saved, clock } = await boot($, on, surface, rateLimits, { beneath, stored })
  const ui = await $.ui.mount({ ...BAND, surface } as never)
  await ui.resize({ columns: 116, rows: 6, in: 'band' })
  const band = async () => JSON.stringify(await ui.drawn({ in: 'band' }))

  return { ui, band, writes, saved, clock }
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
        // Track: the two usage meters and the context's free space; the
        // reserve past the auto-compact point is its own darker shade.
        expect(count(expanded, '"backgroundColor":"#3d4250"')).toBe(3)
        expect(count(expanded, '"backgroundColor":"#2e3139"')).toBe(1)
        // Messages: the context bar's piece and the legend's swatch.
        expect(count(expanded, '"backgroundColor":"#d97757"')).toBe(2)
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
      // Rows in order: usage windows, then context.
      expect(expanded.indexOf('"5H"')).toBeLessThan(expanded.indexOf('"WK"'))
      expect(expanded.indexOf('"WK"')).toBeLessThan(expanded.indexOf('"CTX"'))
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
      // Usage first, then the context in the table's order: label, bar, percentage, detail.
      const order = ['"5H"', '"62%"', '"WK"', '"31%"', '"CTX"', '"flexGrow":1860', '"21%"', '212k / 1M'].map(s =>
        collapsed.indexOf(s),
      )
      expect(order.every(i => i >= 0)).toBe(true)
      expect([...order].sort((a, b) => a - b)).toEqual(order)

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
      await ui.resize({ columns: 150, rows: 6, in: 'band' })
      const wide = await band()
      expect(count(wide, '"width":10,"height":1,"flexDirection":"row","alignItems":"center","flexShrink":0')).toBe(4)
      expect(wide).toContain('212k / 1M')
    })

    test(`${surface}: a narrow band leaves out the detail column, and the collapsed line its meters then its detail`, async ($, on) => {
      const { ui, band } = await start($, on, surface, RATE_LIMITS)
      await ui.resize({ columns: 44, rows: 6, in: 'band' })

      const narrow = await band()
      expect(narrow).toContain('"62%"')
      expect(narrow).not.toContain('2h 14m')
      expect(narrow).not.toContain('212k / 1M')

      // Collapsed at 44 columns: labels, percentages and the context bar, with
      // no room for the detail; at 50 the detail is back and the meters still out.
      await ui.pointer(rightClick)
      const collapsed = await band()
      expect(collapsed).not.toContain('borderStyle')
      expect(collapsed).toContain('"62%"')
      expect(collapsed).toContain('"31%"')
      expect(collapsed).toContain('"CTX"')
      expect(collapsed).toContain('"21%"')
      expect(collapsed).toContain('"flexGrow":1860')
      expect(collapsed).not.toContain('212k / 1M')
      expect(collapsed).not.toContain('"width":10,"height":1')
      await ui.resize({ columns: 50, rows: 6, in: 'band' })
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

    test(`${surface}: a left click turns the collapsed line's bars off and on; the table keeps them`, async ($, on) => {
      const { ui, band } = await start($, on, surface, RATE_LIMITS)
      const barLeaf = surface === 'desktop' ? '"height":"60%"' : '▄'

      // On the expanded table a left click does nothing: it always has bars.
      await ui.pointer(leftClick)
      const expanded = await band()
      expect(expanded).toContain('borderStyle')
      expect(expanded).toContain(barLeaf)

      await ui.pointer(rightClick)
      expect(await band()).toContain(barLeaf)
      await ui.pointer(leftClick)
      const collapsed = await band()
      expect(collapsed).not.toContain('borderStyle')
      expect(collapsed).not.toContain(barLeaf)
      expect(collapsed).toContain('"62%"')
      expect(collapsed).toContain('"CTX"')
      expect(collapsed).toContain('212k / 1M')

      // Expanded again, the table still has its bars.
      await ui.pointer(rightClick)
      expect(await band()).toContain(barLeaf)
      await ui.pointer(rightClick)
      await ui.pointer(leftClick)
      expect(await band()).toContain(barLeaf)
    })

    test(`${surface}: a new session keeps the collapsed line's bars off when they were turned off`, async ($, on) => {
      const barLeaf = surface === 'desktop' ? '"height":"60%"' : '▄'
      const { ui, band } = await start($, on, surface, RATE_LIMITS, undefined, { showBars: false, isCollapsed: true })
      expect(await band()).not.toContain(barLeaf)
      // Expanded, the table has its bars all the same.
      await ui.pointer(rightClick)
      expect(await band()).toContain(barLeaf)
    })

    test(`${surface}: with no plan limits (an API key) only the context shows`, async ($, on) => {
      const { ui, band } = await start($, on, surface, [])

      const expanded = await band()
      expect(expanded).not.toContain('"5H"')
      expect(expanded).toContain('"CTX"')

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
  })

  test('the path is joined with the separator of the home directory', async ($, on) => {
    await boot($, on, 'terminal', RATE_LIMITS, { env: { USERPROFILE: 'C:\\Users\\micro\\' } })
    expect((await run($, 'file')).text).toBe(
      'Token Watch snapshot: C:\\Users\\micro\\.claude\\token-watch\\usage.json (written 0s ago).',
    )
  })

  test('on a POSIX home (HOME only) the path uses slashes', async ($, on) => {
    await boot($, on, 'terminal', RATE_LIMITS, { env: { HOME: '/home/micro/' } })
    expect((await run($, 'file')).text).toBe(
      'Token Watch snapshot: /home/micro/.claude/token-watch/usage.json (written 0s ago).',
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
