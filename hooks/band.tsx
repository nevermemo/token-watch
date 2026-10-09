// The band itself, drawn as a Client so the whole thing is one click target.
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
//   one-cell minimum, so a bar's fill matches the printed percentage. Under
//   CTX, the legend, largest category first, with 2-cell swatches, wrapping
//   onto more lines when it does not fit.
// Collapsed: one line in the table's language. Each usage window as label, a
//   10-cell meter and percentage; then CTX as label, the context bar filling
//   the rest, percentage and "212k / 1M". Counted in cells against the width:
//   the meters are drawn only while the context bar keeps 20 cells, the
//   detail only while it keeps 8, and below that the bar takes what is left,
//   so the line never wraps.
// Without bars (a left click on the collapsed line): the line's labels,
//   percentages and detail alone. The expanded table always has its bars.
//
// The pointer, as in Token Watch for VS Code:
// - left click on the collapsed line: its bars on or off; posts
//   { action: 'bars' }. On the expanded table it does nothing.
// - right click: expand or collapse; posts { action: 'collapse' }.
// - hover: the labels brighten while the pointer is over the band.

import type { ClientModule } from 'claude-code'

import type { BandProps, Limit, Reading } from '../types'
import { countdown, label, levelColor, short, sorted } from './format'

// Local state: whether the pointer is over the band.
type Local = { isHovered: boolean }

type Row = { label: string; bar: unknown[]; percent: number; detail: string }

// One palette for both views and both surfaces: what is still available (the
// usage tracks, the context's free space), and the reserve past the
// auto-compact point a step darker.
const TRACK = '#3d4250'
const RESERVE = '#2e3139'

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

const Band: ClientModule<BandProps, Local> = (props, surface) => {
  const { Box, Text } = surface.elements
  const { reading: now, nowMs, showBars, isCollapsed } = props
  const limits = sorted(props.limits)
  const isHovered = surface.state?.isHovered ?? false

  surface.onPointer(event => {
    if (event.type === 'up' && event.button === 'left') {
      // The expanded table always has its bars, so a left click on it does nothing.
      if (isCollapsed) surface.post({ action: 'bars' })
    } else if (event.type === 'up' && event.button === 'right') {
      surface.post({ action: 'collapse' })
    } else if (event.type === 'enter' || event.type === 'leave') {
      // Read the state as it is now: an enter and a leave can both arrive
      // before the next frame.
      const hovered = event.type === 'enter'
      if ((surface.state?.isHovered ?? false) !== hovered) surface.setState({ isHovered: hovered })
    }
  })

  const percent = Math.round((now.total / now.window) * 100)

  const draw = pieces(Box, Text, props.surface, surface.columns)

  if (isCollapsed) {
    const detail = `${short(now.total)} / ${short(now.window)}`
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
        <Box flexDirection="row" alignItems="center" columnGap={1} flexGrow={1}>
          {/* The label and percentage keep their width; the bar gives way. */}
          <Box flexShrink={0}>
            <Text dimColor={!isHovered} wrap="truncate">
              CTX
            </Text>
          </Box>
          {showBars && (
            <Box flexDirection="row" flexGrow={1} minWidth={4} height={1} alignItems="center">
              {bar(draw, now, TRACK, RESERVE)}
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
      </Box>
    )
  }

  const rows: Row[] = [
    ...limits.map(limit => ({
      label: label(limit),
      bar: meter(draw, limit.percentUsed),
      percent: limit.percentUsed,
      detail: countdown(limit.resetsAt, nowMs),
    })),
    {
      label: 'CTX',
      bar: bar(draw, now, TRACK, RESERVE),
      percent,
      detail: `${short(now.total)} / ${short(now.window)}`,
    },
  ]
  const labelWidth = Math.max(3, ...rows.map(row => row.label.length)) + SLACK
  const showDetail = surface.columns >= DETAIL_MIN_COLUMNS
  const detailWidth = Math.max(...rows.map(row => row.detail.length)) + SLACK
  const legend = now.slices.filter(s => s.kind === 'used').sort((a, b) => b.tokens - a.tokens)
  // A legend swatch: a 2-cell bar, drawn the way the bars are.
  const swatch = (color: string) => (
    <Box width={2} height={1} flexDirection="row" alignItems="center" flexShrink={0}>
      {draw(color, { grow: 1 })}
    </Box>
  )

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
// padding, labels, percentages and gaps; the desktop's proportional text
// measures a little wider, which the bar absorbs.
function fit(columns: number, limits: Limit[], percent: number, detail: string, showBars: boolean) {
  const usage = limits.reduce(
    (n, limit) => n + label(limit).length + 1 + `${Math.round(limit.percentUsed)}%`.length + CELL_GAP,
    0,
  )
  const base = 2 + usage + 'CTX'.length + 1 + 1 + `${percent}%`.length
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
