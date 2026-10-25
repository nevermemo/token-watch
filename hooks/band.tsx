// The band itself, drawn as a Client so the whole thing is one pointer target
// and its two Buttons are its own.
//
// Every bar is a row of Boxes that grow in proportion to what they measure, so
// the layout engine fits it to whatever width the band has, on the terminal
// and the desktop alike, instead of the module counting characters.
//
// One layout and one palette on every surface; only the leaf that paints a
// coloured piece depends on the surface (see `pieces`). The desktop paints a
// Box background gaplessly, where any run of glyphs would leave a sliver of
// remainder per piece in its proportional font, so there each piece is an
// empty Box 60% as tall as its line. A terminal can only shade whole cells,
// and only a glyph shape gives it less than a cell of height, so there each
// piece is a run of lower blocks clipped to its Box. Either way the bars are
// thinner than their line and stacked bars keep a gap between them.
//
// Expanded: one aligned table in a rounded box. A row per usage window (5H, WK
//   and any other window the API sends, such as a model's own allowance), then
//   CTX, each as label, bar, percentage and a dim detail (the time to reset,
//   or the tokens of the window). Every bar starts and ends in the same
//   columns, over a track in one quiet colour for what is still available.
//   On the context bar the reserve past the auto-compact point is a darker
//   shade than the free space before it. Pieces are pure proportion, with no
//   one-cell minimum, so a bar's fill matches the printed percentage. Then the
//   TTL row: the prompt cache's time left over its whole TTL, "52:50 /
//   60:00", and a Keep warm Button; while keep-warm is on, its caps, "Pings:
//   0/8  Time: 00:26 / 8:00:00", and a Refresh caps Button; for a minute after
//   a ping or a stop, a dim note. The caps and the note go below 90 columns.
//   Under CTX, the legend, largest category first, with 2-cell swatches,
//   wrapping onto more lines when it does not fit.
// Collapsed with bars ('bars'): one line in the table's language. Each usage
//   window as label, a 10-cell meter and percentage; then CTX as label, the
//   context bar filling the rest, percentage and "212k / 1M"; then the timer.
//   Counted in cells against the width: the meters are drawn only while the
//   context bar keeps 20 cells, the detail only while it keeps 8, and below
//   that the bar takes what is left, so the line never wraps.
// Collapsed without bars ('plain'): the line's labels, percentages, detail
//   and timer alone.
//
// The collapsed views' timer: a 2-cell swatch in keep-warm's colour (green
// on, grey off, red once the cache has gone cold) and the countdown as a
// Button, "47:12". It reads "--:--" before the first
// response, the whole TTL while a turn runs, "cold" once the countdown has
// run out. Pressing it, or Keep warm, posts { action: 'keep-warm' }. Between
// the hooks module's clock readings (every 30 s) the countdown ticks on the
// Client's frame clock.
//
// The pointer: a right click posts { action: 'cycle' }, which moves to the
// next view; a left click does nothing but press a Button; hover brightens
// the labels.

import type { ClientModule } from 'claude-code'

import type { BandProps, Limit, Reading } from '../types'
import { NOTE_MS } from './cache'
import { cacheLabel, capsLine, countdown, label, levelColor, short, sorted, timerText } from './format'

// Local state: whether the pointer is over the band, and the frame clock's
// milliseconds since the instance started (what the countdown ticks on).
type Local = { isHovered: boolean; frameMs: number }
const INITIAL: Local = { isHovered: false, frameMs: 0 }

// The hooks module's clock reading when the frame clock was last anchored to
// it, and the frame clock then: the display clock is props.nowMs plus the
// frames since. The latest props, for the ticker. Module variables: the
// instance is one per band and outlives its redraws, and nothing here needs
// to survive a reload.
let anchor: { nowMs: number; frameMs: number } | null = null
let latest: BandProps | null = null

type Row = { label: string; bar: unknown[]; percent: number; detail: string }

// One palette for both views and both surfaces: what is still available (the
// usage tracks, the context's free space), and the reserve past the
// auto-compact point a step darker.
const TRACK = '#3d4250'

// The desktop's button chips: a grey one, and green while what it controls is on.
const CHIP_OFF = '#4a5060'
const CHIP_ON = '#2f7a4f'
const RESERVE = '#2e3139'

// Keep-warm's colours: on, off, and a cache that has gone cold.
const WARM_ON = '#7fd4a0'
const WARM_OFF = '#6e7383'
const WARM_COLD = '#e06c6c'

// What a terminal draws a piece with: the lower half block, shorter than its
// cell, and one every console font has (the finer ▆ is missing from Consolas
// and Lucida Console, so the classic Windows console drew boxes).
const GLYPH = '▄'

// The legend's shorter names for the longer category labels.
const LEGEND: Record<string, string> = {
  'system prompt': 'system',
  'memory files': 'memory',
  'mcp tools': 'mcp',
}

// Below this many columns the expanded table leaves out the detail column.
const DETAIL_MIN_COLUMNS = 50

// Below this many columns the TTL row leaves out keep-warm's caps and notes.
const CAPS_MIN_COLUMNS = 90

// Cells of slack in each fixed column: the desktop draws text in a
// proportional font, where "CTX" or "100%" can be wider than its characters.
const SLACK = 2

// The percentage column: "100%" and its slack.
const PERCENT_WIDTH = 6

// The collapsed line: the gap between its cells, the width of a usage
// window's meter, the room the context bar keeps before the line gives up
// the detail, and the room it keeps before the meters are drawn.
const CELL_GAP = 3
const METER_WIDTH = 10
const BAR_MIN = 8
const METERS_BAR_MIN = 20

// The timer on the collapsed line: its gap, the 2-cell swatch, a space and
// "47:12".
const TIMER_CELLS = CELL_GAP + 2 + 1 + 5

const Band: ClientModule<BandProps, Local> = (props, surface) => {
  const { Box, Text, Button } = surface.elements
  latest = props
  if (surface.state === undefined) {
    surface.setState(INITIAL)
    // One ticker per instance, started on the first call: a redraw a second
    // while there is a countdown to move.
    surface.every(1000, () => {
      if (latest === null || latest.cache.warmUntil === null || latest.isWorking) return
      const s = surface.state ?? INITIAL
      surface.setState({ ...s, frameMs: s.frameMs + 1000 })
    })
  }
  const state = surface.state ?? INITIAL
  if (anchor === null || anchor.nowMs !== props.nowMs) anchor = { nowMs: props.nowMs, frameMs: state.frameMs }
  const now = props.nowMs + (state.frameMs - anchor.frameMs)
  const { reading: current, view, isWorking, cache, keepWarm } = props
  const limits = sorted(props.limits)
  const isHovered = state.isHovered

  surface.onPointer(event => {
    if (event.type === 'up' && event.button === 'right') {
      surface.post({ action: 'cycle' })
    } else if (event.type === 'enter' || event.type === 'leave') {
      // Read the state as it is now: an enter and a leave can both arrive
      // before the next frame.
      const hovered = event.type === 'enter'
      const s = surface.state ?? INITIAL
      if (s.isHovered !== hovered) surface.setState({ ...s, isHovered: hovered })
    }
  })

  const percent = Math.round((current.total / current.window) * 100)

  const draw = pieces(Box, Text, props.surface, surface.columns)

  // A Button inside a Client draws as plain text on the desktop app (measured),
  // so there each Button sits on a filled chip to read as a button: grey, or
  // green while what it controls is on. A terminal already draws "[ label ]".
  const chip = (key: string, text: string, isOn: boolean, action: string) => {
    const button = (
      <Button key={key} onPress={() => surface.post({ action })}>
        {text}
      </Button>
    )
    if (props.surface !== 'desktop') return button
    return (
      <Box key={`${key}-chip`} flexShrink={0} paddingX={1} backgroundColor={isOn ? CHIP_ON : CHIP_OFF}>
        {button}
      </Box>
    )
  }

  const isCold = cache.warmUntil !== null && !isWorking && now >= cache.warmUntil
  const warmColor = isCold ? WARM_COLD : keepWarm.on ? WARM_ON : WARM_OFF
  const timer = (
    <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
      <Box width={2} height={1} flexDirection="row" alignItems="center" flexShrink={0}>
        {draw(warmColor, { grow: 1 })}
      </Box>
      {chip('cache-timer', cacheLabel(cache, now, isWorking), false, 'keep-warm')}
    </Box>
  )

  if (view !== 'expanded') {
    const showBars = view === 'bars'
    const detail = `${short(current.total)} / ${short(current.window)}`
    const { showDetail, showMeters } = fit(surface.columns, limits, percent, detail, showBars)
    return (
      <Box flexDirection="row" alignItems="center" columnGap={CELL_GAP} paddingX={1}>
        {limits.map(limit => (
          <Box key={limit.kind} flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
            <Text dimColor={!isHovered} wrap="truncate">
              {label(limit)}
            </Text>
            {showMeters && (
              <Box width={METER_WIDTH} height={1} flexDirection="row" alignItems="center" flexShrink={0}>
                {meter(draw, limit.percentUsed)}
              </Box>
            )}
            <Text wrap="truncate" {...warning(limit.percentUsed)}>{`${Math.round(limit.percentUsed)}%`}</Text>
          </Box>
        ))}
        {/* With bars the context bar fills the line and the timer ends it;
            without, the texts follow one another and the timer comes last. */}
        <Box flexDirection="row" alignItems="center" columnGap={1} flexGrow={showBars ? 1 : 0}>
          {/* The label and percentage keep their width; the bar gives way. */}
          <Box flexShrink={0}>
            <Text dimColor={!isHovered} wrap="truncate">
              CTX
            </Text>
          </Box>
          {showBars && (
            <Box flexDirection="row" flexGrow={1} minWidth={4} height={1} alignItems="center">
              {bar(draw, current, TRACK, RESERVE)}
            </Box>
          )}
          <Box flexShrink={0}>
            <Text wrap="truncate" {...warning(percent)}>{`${percent}%`}</Text>
          </Box>
          {showDetail && (
            <Box marginLeft={1} flexShrink={0}>
              <Text dimColor wrap="truncate">
                {detail}
              </Text>
            </Box>
          )}
        </Box>
        {timer}
      </Box>
    )
  }

  const rows: Row[] = [
    ...limits.map(limit => ({
      label: label(limit),
      bar: meter(draw, limit.percentUsed),
      percent: limit.percentUsed,
      detail: countdown(limit.resetsAt, nowMsOf(props)),
    })),
    {
      label: 'CTX',
      bar: bar(draw, current, TRACK, RESERVE),
      percent,
      detail: `${short(current.total)} / ${short(current.window)}`,
    },
  ]
  const labelWidth = Math.max(3, ...rows.map(row => row.label.length)) + SLACK
  const showDetail = surface.columns >= DETAIL_MIN_COLUMNS
  const detailWidth = Math.max(...rows.map(row => row.detail.length)) + SLACK
  const legend = current.slices.filter(s => s.kind === 'used').sort((a, b) => b.tokens - a.tokens)
  // A legend swatch: a 2-cell bar, drawn the way the bars are.
  const swatch = (color: string) => (
    <Box width={2} height={1} flexDirection="row" alignItems="center" flexShrink={0}>
      {draw(color, { grow: 1 })}
    </Box>
  )
  // While keep-warm is on, its caps follow, then a minute's note (a ping's
  // counts, why it stopped) when there is one. Both go below CAPS_MIN_COLUMNS.
  const showCaps = keepWarm.on && surface.columns >= CAPS_MIN_COLUMNS
  const note =
    surface.columns >= CAPS_MIN_COLUMNS && keepWarm.note !== null && now - keepWarm.note.at < NOTE_MS ? keepWarm.note.text : ''

  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor={!isHovered} paddingX={1}>
      {rows.map(row => (
        <Box key={row.label} flexDirection="row" alignItems="center" columnGap={2}>
          <Box width={labelWidth} flexShrink={0}>
            <Text dimColor wrap="truncate">
              {row.label}
            </Text>
          </Box>
          <Box flexDirection="row" flexGrow={1} minWidth={4} height={1} alignItems="center">
            {row.bar}
          </Box>
          <Box width={PERCENT_WIDTH} flexShrink={0} justifyContent="flex-end">
            <Text wrap="truncate" {...warning(row.percent)}>{`${Math.round(row.percent)}%`}</Text>
          </Box>
          {showDetail && (
            <Box width={detailWidth} flexShrink={0}>
              <Text dimColor wrap="truncate">
                {row.detail}
              </Text>
            </Box>
          )}
        </Box>
      ))}
      <Box flexDirection="row" alignItems="center" columnGap={2}>
        <Box width={labelWidth} flexShrink={0}>
          <Text dimColor wrap="truncate">
            TTL
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text {...(isCold ? { color: WARM_COLD } : {})}>{timerText(cache, now, isWorking)}</Text>
        </Box>
        {chip('keep-warm', 'Keep warm', keepWarm.on, 'keep-warm')}
        {showCaps && (
          <Box flexShrink={0} marginLeft={1}>
            <Text dimColor>{capsLine(keepWarm, cache, now)}</Text>
          </Box>
        )}
        {showCaps && (
          chip('refresh-caps', 'Refresh caps', false, 'refresh-caps')
        )}
        {note !== '' && (
          <Box flexShrink={1} minWidth={0}>
            <Text dimColor wrap="truncate">
              {note}
            </Text>
          </Box>
        )}
      </Box>
      <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={3} paddingLeft={labelWidth + 2}>
        {legend.map(slice => (
          <Box key={slice.label} flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
            {swatch(slice.color)}
            <Text dimColor>{`${LEGEND[slice.label] ?? slice.label} ${short(slice.tokens)}`}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

export default Band

// The hooks module's clock, for the reset countdowns: those move by the
// minute, so they follow its 30-second readings rather than the frame clock.
function nowMsOf(props: BandProps) {
  return props.nowMs
}

// How a bar draws one piece: a colour over a share of the bar (`grow`) or a
// fixed number of cells (`width`). No minimum size: the share is exact, so a
// bar's fill matches the percentage printed beside it.
type Size = { grow?: number; width?: number }
type Draw = (color: string, size: Size) => unknown

const box = (size: Size) => ({
  width: size.width ?? 0,
  flexGrow: size.grow ?? 0,
  flexShrink: size.width ? 0 : 1,
  minWidth: 0,
})

// A piece shorter than its line, for both views. The surface chooses
// the leaf, and only here: on the desktop an empty Box 60% as tall as its row
// with a background, which is gapless; in a terminal a Box one cell tall
// holding a run of GLYPH, which wraps exactly at the Box's width and whose
// overflow is clipped. (The run is longer than any piece can be, so it fills
// the Box whatever share it has.)
function pieces(Box, Text, surface: BandProps['surface'], columns: number): Draw {
  if (surface === 'desktop') {
    return (color, size) => <Box {...box(size)} height="60%" backgroundColor={color} />
  }

  return (color, size) => (
    <Box {...box(size)} height={1} overflow="hidden">
      <Text color={color} wrap="wrap">
        {GLYPH.repeat(size.width ?? Math.max(columns, 80) + 2)}
      </Text>
    </Box>
  )
}

// The context bar: a piece per category, each growing by its tokens from a
// zero base, so the widths stay proportional at any size. Free space is drawn
// in `free`, the reserve past the auto-compact point in `reserveColor`.
function bar(draw: Draw, now: Reading, free: string, reserveColor: string) {
  // Largest category first, as the legend lists them, then the free space.
  const used = now.slices.filter(s => s.kind === 'used').sort((a, b) => b.tokens - a.tokens)
  const segments = [...used, ...now.slices.filter(s => s.kind === 'free')].map(s =>
    draw(s.kind === 'free' ? free : s.color, { grow: grow(s.tokens, now.window) }),
  )
  const reserve = now.compactsAt !== null ? Math.max(0, now.window - now.compactsAt) : 0
  if (reserve > 0) {
    segments.push(draw(reserveColor, { grow: grow(reserve, now.window) }))
  }

  return segments
}

// A usage window's meter: the used share in its level colour and what is
// still available as track, both growing from a zero base like the context
// bar.
function meter(draw: Draw, percentUsed: number) {
  const used = Math.max(0, Math.min(100, percentUsed))
  return [draw(levelColor(used), { grow: used * 100 }), draw(TRACK, { grow: (100 - used) * 100 })]
}

// Which of the collapsed line's extras fit: the detail, then the usage
// meters. Counted in cells, the bar's room being what is left after the
// padding, labels, percentages, gaps and the timer; the desktop's
// proportional text measures a little wider, which the bar absorbs.
function fit(columns: number, limits: Limit[], percent: number, detail: string, showBars: boolean) {
  const usage = limits.reduce(
    (n, limit) => n + label(limit).length + 1 + `${Math.round(limit.percentUsed)}%`.length + CELL_GAP,
    0,
  )
  const base = 2 + usage + 'CTX'.length + 1 + 1 + `${percent}%`.length + TIMER_CELLS
  const withDetail = base + 2 + detail.length
  const withMeters = withDetail + limits.length * (METER_WIDTH + 1)
  // Without bars there is no context bar to keep room for, and no meters.
  const showDetail = columns - withDetail >= (showBars ? BAR_MIN : 0)
  const showMeters = showBars && showDetail && columns - withMeters >= METERS_BAR_MIN
  return { showDetail, showMeters }
}

// A share of the window in parts per 10,000, the most flexGrow takes.
function grow(tokens: number, window: number) {
  return Math.min(10_000, Math.round((tokens / window) * 10_000 * 100) / 100)
}

// The percentages in both views: plain text, yellow from 50%, red from 80%.
function warning(percent: number) {
  return percent < 50 ? {} : { color: levelColor(percent) }
}