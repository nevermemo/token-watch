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
//   one-cell minimum, so a bar's fill matches the printed percentage. Under
//   CTX, the legend, largest category first, with 2-cell swatches, wrapping
//   onto more lines when it does not fit. Then the TTL row: the prompt
//   cache's time left over its whole TTL, "52:50 / 60:00", and the keep-warm
//   Button, which says what pressing it would do or why it cannot ("Keep
//   Warm", "Let Chill", "Cache Lost", "No Data"; "Remind Me" and "Reminding"
//   in Notify mode); while pings are on, their caps, "Pings: 0/8  Time:
//   00:26 / 8:00:00", and a Refresh Caps Button (a reminder has no caps); for
//   a minute after a ping or a stop, a dim note. The caps and the note go
//   below 90 columns, and cut at the edge above it.
// Collapsed with bars ('bars'): one line in the table's language. Each usage
//   window as label, a meter (10 cells, narrower where the line is short)
//   and percentage; then CTX as label, the context bar filling the rest,
//   percentage and "212k / 1M"; then the timer.
//   Counted in cells against the width (see `fit`): the detail, each
//   window's pace and forecast, then the meters, each while the context bar
//   keeps 8 cells; below that the bar takes what is left, so the line never
//   wraps.
// Collapsed without bars ('plain'): the line's labels, percentages, detail
//   and timer alone.
//
// Burn rates (props.pace): in the table, after a window's reset countdown,
// its pace ("12%/h") and its forecast: how long until it fills, in red
// ("1h 20m"), or "Safe" in green when it would not fill before it resets; in
// two more fixed columns so the bars still line up. On a collapsed line, the
// pace and the forecast after the window's percentage.
// Each shows in the views the settings panel picks (props.paceHidden,
// props.forecastHidden).
//
// The settings panel can hide parts (props.hidden): the 5H and WK windows,
// any other window, CTX (with its legend) and TTL (with the timer and
// keep-warm's buttons). A hidden part is left out of every view; with
// everything hidden the table says so and the collapsed line is empty, the
// settings button the hooks module draws beside the band being the way back.
//
// The collapsed views' timer: the countdown as a Button, "47:12", whose chip
// is its own indicator (grey with keep-warm off, green on, red with no warm
// cache). It reads the whole TTL while a turn runs, and "--:--" before the
// first response or once the countdown has run out. Pressing it, or the
// expanded row's button, posts { action: 'keep-warm' }. Between the hooks
// module's clock readings (every 30 s) the countdown ticks on the Client's
// frame clock.
//
// Every Button is a chip: a Box filled with the indicator's colour around a
// plain Button, the same on both surfaces.
//
// The pointer: a right click posts { action: 'cycle' }, which moves to the
// next view; a left click does nothing but press a Button; hover brightens
// the labels.

import type { ClientElements, ClientModule, RenderElement } from 'claude-code'

import type { BandProps, ContextDetails, DetailsSetting, Limit, Part, Reading } from '../types'
import { NOTE_MS } from './cache'
import { rateText } from './burn'
import { bandTimerLabel, capsLine, countdown, duration, label, levelColor, partOf, short, sorted, timerText } from './format'

// Local state: whether the pointer is over the band; the frame clock's
// milliseconds since the instance started (what the countdown ticks on); and
// the anchor, the hooks module's clock reading the frame clock was last
// lined up with and the frame clock then. The display clock is that reading
// plus the frames since. Kept in the instance's state, so a band drawn again
// (hidden and shown, or after a survey) starts from its own frame clock.
type Local = { isHovered: boolean; frameMs: number; anchorNowMs: number; anchorFrameMs: number }
const INITIAL: Local = { isHovered: false, frameMs: 0, anchorNowMs: 0, anchorFrameMs: 0 }

// The latest props, for the ticker, whose callback outlives the call that
// started it. A module variable: nothing here needs to survive a reload.
let latest: BandProps | null = null

// The display clock: the hooks module's reading, plus the frames since the
// anchor while the anchor is that reading. A new reading counts from itself
// until the ticker lines the anchor up with it.
function displayNow(props: BandProps, state: Local) {
  return props.nowMs + (state.anchorNowMs === props.nowMs ? state.frameMs - state.anchorFrameMs : 0)
}

// A row of the table, keyed by its window's kind (two kinds may share a label).
type Row = { key: string; label: string; bar: RenderElement[]; percent: number; detail: string; rate: string; forecast: string }

// A forecast's colour: "Safe" calm, a time until full a warning.
const forecastColor = (forecast: string) => (forecast === 'Safe' ? SAFE : FORECAST)

// One palette for both views and both surfaces: what is still available (the
// usage tracks, the context's free space), and the reserve past the
// auto-compact point a step darker.
const TRACK = '#3d4250'

// The button chips: grey, green while keep-warm is on, and red for
// the timer once the cache has gone cold.
const CHIP_OFF = '#4a5060'
const CHIP_ON = '#2f7a4f'
const CHIP_COLD = '#a8433f'

// A chip's margin, inside its Button's label so the whole chip is clickable.
// The desktop draws a proportional font, where an ordinary space is a few
// pixels wide, so there an en space (U+2002), about the width of the cell of
// padding a chip would otherwise have; a terminal cell takes a non-breaking
// space. Neither is trimmed the way an ordinary space may be.
const PAD_DESKTOP = ' '
const PAD_TERMINAL = ' '

// The cells of the expanded row's longest button label, "Cache Lost".
const WARM_CELLS = 10

// A terminal label centred in so many cells with non-breaking spaces, any odd
// one on the right.
function centred(text: string, cells: number) {
  const gap = Math.max(0, cells - text.length)
  const left = Math.floor(gap / 2)
  return PAD_TERMINAL.repeat(left) + text + PAD_TERMINAL.repeat(gap - left)
}

// The reserve past the auto-compact point, a step darker than the track.
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

// The details lines' label column: "Memory" and a cell (and the desktop's
// slack).
const DETAIL_LABEL_WIDTH = 7

// Below this many columns the table leaves out the burn rates and forecasts.
const RATE_MIN_COLUMNS = 70

// A forecast that a window fills before it resets, in the warning colour,
// and one that it would not, in the calm one.
const FORECAST = '#e06c6c'
const SAFE = '#8fd18f'

// Below this many columns the TTL row leaves out keep-warm's caps and notes;
// short of room above it, the note gives way this many times faster than
// the caps.
const CAPS_MIN_COLUMNS = 90
const NOTE_SHRINK = 100

// Cells of slack in each fixed column: the desktop draws text in a
// proportional font, where "CTX" or "100%" can be wider than its characters.
const SLACK = 2

// The percentage column: "100%" and its slack.
const PERCENT_WIDTH = 6

// The collapsed line: the gap between its cells, the width of a usage
// window's meter, and the room the context bar keeps before the line gives
// up its extras.
const CELL_GAP = 3
// A usage window's meter: 10 cells, or 6 or 4 where the line is short.
const METER_WIDTHS = [10, 6, 4]
const BAR_MIN = 8

// The timer on the collapsed line: its gap and its chip, "47:12" between a
// cell of margin each side.
const TIMER_CELLS = CELL_GAP + 1 + 5 + 1

const Band: ClientModule<BandProps, Local> = (props, surface) => {
  const { Box, Text, Button } = surface.elements
  latest = props
  if (surface.state === undefined) {
    surface.setState(INITIAL)
    // One ticker per instance, started on the first call: a redraw a second
    // while there is a countdown to move, none once it has run out.
    surface.every(1000, () => {
      const s = surface.state ?? INITIAL
      if (latest === null || latest.cache.warmUntil === null || latest.isWorking) return
      if (displayNow(latest, s) >= latest.cache.warmUntil) return
      const anchored = s.anchorNowMs === latest.nowMs ? s : { ...s, anchorNowMs: latest.nowMs, anchorFrameMs: s.frameMs }
      surface.setState({ ...anchored, frameMs: anchored.frameMs + 1000 })
    })
  }
  const state = surface.state ?? INITIAL
  const now = displayNow(props, state)
  const { reading: current, view, isWorking, cache, keepWarm } = props
  // The parts the settings panel leaves shown.
  const shows = (part: Part) => !props.hidden.includes(part)
  const limits = sorted(props.limits).filter(limit => shows(partOf(limit)))
  const showCtx = shows('CTX')
  const showTtl = shows('TTL')
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
  // so every Button sits on a filled chip to read as a button, the chip's
  // colour saying its state. The terminal gets the same chip, its Button
  // drawn plain (the label alone, without "[ ]"), so both surfaces look alike.
  // The chip's margins are spaces inside the label, not padding, so the whole
  // chip is the Button and a click anywhere on it presses it.
  const pad = props.surface === 'desktop' ? PAD_DESKTOP : PAD_TERMINAL
  const chip = (key: string, text: string, fill: string, action: string) => (
    <Box key={`${key}-chip`} flexShrink={0} backgroundColor={fill}>
      <Button key={key} plain onPress={() => surface.post({ action })}>
        {`${pad}${text}${pad}`}
      </Button>
    </Box>
  )

  // The buttons are the indicators: the collapsed views' timer is grey with
  // keep-warm off, green with it on, red with no warm cache (before the first
  // response, or once the countdown has run out, when the timer reads "--:--").
  const isUnknown = !isWorking && cache.warmUntil === null
  const isCold = isUnknown || (!isWorking && now >= cache.warmUntil!)
  const timerFill = isCold ? CHIP_COLD : keepWarm.on ? CHIP_ON : CHIP_OFF

  // The expanded row's button, in the timer's colour, says what pressing it
  // would do, or why it cannot: "No Data" before the first response, "Cache
  // Lost" once the cache has gone cold, "Let Chill" while keep-warm is on,
  // else "Keep Warm"; in Notify mode "Reminding" and "Remind Me". The terminal centres it in the longest label's cells so
  // the caps after it stay put; the desktop's proportional font cannot.
  const isReminder = props.warmMode === 'notify'
  const warmText = isUnknown
    ? 'No Data'
    : isCold
      ? 'Cache Lost'
      : keepWarm.on
        ? isReminder
          ? 'Reminding'
          : 'Let Chill'
        : isReminder
          ? 'Remind Me'
          : 'Keep Warm'
  const warmLabel = props.surface === 'desktop' ? warmText : centred(warmText, WARM_CELLS)
  const timer = chip('cache-timer', bandTimerLabel(cache, now, isWorking), timerFill, 'keep-warm')

  // A window's pace, and its forecast (how long until it fills, or "Safe" if
  // it would not before it resets), as the band prints them; empty without a
  // pace or where the settings hide them.
  const rateOf = (limit: Limit) => {
    const p = props.pace.windows[limit.kind]
    return p && !props.paceHidden.includes(partOf(limit)) ? rateText(p.perHour, p.unit) : ''
  }
  const forecastOf = (limit: Limit) => {
    if (props.forecastHidden.includes(partOf(limit))) return ''
    const p = props.pace.windows[limit.kind]
    if (!p) return ''
    return p.fullAt === null ? 'Safe' : p.fullAt <= props.nowMs ? 'Full' : duration(p.fullAt - props.nowMs)
  }

  if (view !== 'expanded') {
    const showBars = view === 'bars'
    const detail = `${short(current.total)} / ${short(current.window)}`
    const cells = (text: string) => (text ? text.length + 1 : 0)
    const ratesCells = limits.reduce((n, limit) => n + cells(rateOf(limit)), 0)
    const forecastCells = limits.reduce((n, limit) => n + cells(forecastOf(limit)), 0)
    const { showDetail, meterWidth, showRates, showForecasts } = fit(
      surface.columns,
      limits,
      percent,
      detail,
      showBars,
      showCtx,
      showTtl,
      ratesCells,
      forecastCells,
    )
    // With every part hidden the line is empty; the settings button beside
    // the band (drawn by the hooks module) is the way back.
    if (limits.length === 0 && !showCtx && !showTtl) return <Box height={1} />
    return (
      <Box flexDirection="row" alignItems="center" columnGap={CELL_GAP} paddingX={1}>
        {limits.map(limit => (
          <Box key={limit.kind} flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
            <Text dimColor={!isHovered} wrap="truncate">
              {label(limit)}
            </Text>
            {meterWidth > 0 && (
              <Box width={meterWidth} height={1} flexDirection="row" alignItems="center" flexShrink={0}>
                {meter(draw, limit.percentUsed)}
              </Box>
            )}
            <Text wrap="truncate" {...warning(limit.percentUsed)}>{`${Math.round(limit.percentUsed)}%`}</Text>
            {showRates && rateOf(limit) !== '' && (
              <Text dimColor wrap="truncate">
                {rateOf(limit)}
              </Text>
            )}
            {showForecasts && forecastOf(limit) !== '' && (
              <Text wrap="truncate" color={forecastColor(forecastOf(limit))}>
                {forecastOf(limit)}
              </Text>
            )}
          </Box>
        ))}
        {/* With bars the context bar fills the line and the timer ends it;
            without, the texts follow one another and the timer comes last. */}
        {showCtx && (
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
        )}
        {showTtl && timer}
      </Box>
    )
  }

  const rows: Row[] = [
    ...limits.map(limit => ({
      key: limit.kind,
      label: label(limit),
      bar: meter(draw, limit.percentUsed),
      percent: limit.percentUsed,
      // The reset countdowns move by the minute, so they follow the hooks
      // module's 30-second readings rather than the frame clock.
      detail: countdown(limit.resetsAt, props.nowMs),
      rate: rateOf(limit),
      forecast: forecastOf(limit),
    })),
    ...(showCtx
      ? [
          {
            key: 'CTX',
            label: 'CTX',
            bar: bar(draw, current, TRACK, RESERVE),
            percent,
            detail: `${short(current.total)} / ${short(current.window)}`,
            rate: '',
            forecast: '',
          },
        ]
      : []),
  ]
  const labelWidth = Math.max(3, ...rows.map(row => row.label.length)) + SLACK
  const showDetail = surface.columns >= DETAIL_MIN_COLUMNS
  const detailWidth = Math.max(0, ...rows.map(row => row.detail.length)) + SLACK
  // The pace and forecast columns, each as wide as its longest entry, so the
  // bars end in the same column on every row; none without either.
  const showRates = showDetail && surface.columns >= RATE_MIN_COLUMNS
  const rateWidth = Math.max(0, ...rows.map(row => row.rate.length))
  const forecastWidth = Math.max(0, ...rows.map(row => row.forecast.length))
  const legend = current.slices.filter(s => s.kind === 'used').sort((a, b) => b.tokens - a.tokens)
  // A legend swatch: a 2-cell bar, drawn the way the bars are.
  const swatch = (color: string) => (
    <Box width={2} height={1} flexDirection="row" alignItems="center" flexShrink={0}>
      {draw(color, { grow: 1 })}
    </Box>
  )
  // While keep-warm is on, its caps follow, then a minute's note (a ping's
  // counts, why it stopped) when there is one. Both go below CAPS_MIN_COLUMNS.
  // Caps are the pings': a reminder has none.
  const showCaps = keepWarm.on && !isReminder && surface.columns >= CAPS_MIN_COLUMNS
  const note =
    surface.columns >= CAPS_MIN_COLUMNS && keepWarm.note !== null && now - keepWarm.note.at < NOTE_MS ? keepWarm.note.text : ''

  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor={!isHovered} paddingX={1}>
      {rows.length === 0 && !showTtl && (
        <Text dimColor>
          {props.limits.length === 0
            ? 'CTX and TTL are hidden, and there is no plan usage to show. TW Settings shows them again.'
            : 'All parts are hidden. TW Settings shows them again.'}
        </Text>
      )}
      {rows.map(row => (
        <Box key={row.key} flexDirection="row" alignItems="center" columnGap={2}>
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
          {showRates && rateWidth > 0 && (
            <Box width={rateWidth + SLACK} flexShrink={0}>
              <Text dimColor wrap="truncate">
                {row.rate}
              </Text>
            </Box>
          )}
          {showRates && forecastWidth > 0 && (
            <Box width={forecastWidth + SLACK} flexShrink={0}>
              <Text wrap="truncate" color={forecastColor(row.forecast)}>
                {row.forecast}
              </Text>
            </Box>
          )}
        </Box>
      ))}
      {showCtx && (
        <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={3} paddingLeft={labelWidth + 2}>
          {legend.map(slice => (
            <Box key={slice.label} flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
              {swatch(slice.color)}
              <Text dimColor>{`${LEGEND[slice.label] ?? slice.label} ${short(slice.tokens)}`}</Text>
            </Box>
          ))}
        </Box>
      )}
      {showCtx &&
        detailLines(current.details, props.details).map(([title, text]) => (
          <Box key={title} flexDirection="row" columnGap={1} paddingLeft={labelWidth + 2}>
            <Box width={DETAIL_LABEL_WIDTH + (props.surface === 'terminal' ? 0 : SLACK)} flexShrink={0}>
              <Text dimColor>{title}</Text>
            </Box>
            <Box flexShrink={1} minWidth={0}>
              <Text dimColor wrap="truncate">
                {text}
              </Text>
            </Box>
          </Box>
        ))}
      {showTtl && (
        <Box flexDirection="row" alignItems="center" columnGap={2}>
          <Box width={labelWidth} flexShrink={0}>
            <Text dimColor wrap="truncate">
              TTL
            </Text>
          </Box>
          <Box flexShrink={0}>
            <Text>{timerText(cache, now, isWorking)}</Text>
          </Box>
          {chip('keep-warm', warmLabel, timerFill, 'keep-warm')}
          {/* The caps cut at the edge, rather than push the row past it. */}
          {showCaps && (
            <Box flexShrink={1} minWidth={0} marginLeft={1}>
              <Text dimColor wrap="truncate">
                {capsLine(keepWarm, props.cap, now)}
              </Text>
            </Box>
          )}
          {showCaps && chip('refresh-caps', 'Refresh Caps', CHIP_OFF, 'refresh-caps')}
          {/* The note gives way first, the caps after it. */}
          {note !== '' && (
            <Box flexShrink={NOTE_SHRINK} minWidth={0}>
              <Text dimColor wrap="truncate">
                {note}
              </Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  )
}

export default Band

// How a bar draws one piece: a colour over a share of the bar (`grow`) or a
// fixed number of cells (`width`). No minimum size: the share is exact, so a
// bar's fill matches the percentage printed beside it.
type Size = { grow?: number; width?: number }
type Draw = (color: string, size: Size) => RenderElement

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
function pieces(
  Box: ClientElements['Box'],
  Text: ClientElements['Text'],
  surface: BandProps['surface'],
  columns: number,
): Draw {
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

// Which of the collapsed line's extras fit, kept in this order: the detail,
// the paces (`ratesCells`, each with its gap), the forecasts
// (`forecastCells`), then the usage meters, which narrow (10, 6, 4 cells)
// before they go, the first to, since they only repeat the percentage beside
// them. Counted in cells, the bar's room being
// what is left after the padding, labels, percentages, gaps and the timer;
// the desktop's proportional text measures a little wider, which the bar
// absorbs. Without the context there is no bar to keep room for: the extras
// need only fit.
function fit(
  columns: number,
  limits: Limit[],
  percent: number,
  detail: string,
  showBars: boolean,
  showCtx: boolean,
  showTtl: boolean,
  ratesCells: number,
  forecastCells: number,
) {
  const usage = limits.reduce(
    (n, limit) => n + label(limit).length + 1 + `${Math.round(limit.percentUsed)}%`.length + CELL_GAP,
    0,
  )
  const base = 2 + usage + (showTtl ? TIMER_CELLS : 0)
  const withCtx = showCtx ? base + 'CTX'.length + 1 + 1 + `${percent}%`.length : base
  // The room the context bar keeps; none without bars or without the context.
  const keep = showCtx && showBars ? BAR_MIN : 0
  const showDetail = showCtx && columns - (withCtx + 2 + detail.length) >= keep
  let used = showDetail ? withCtx + 2 + detail.length : withCtx
  const showRates = ratesCells > 0 && columns - used - ratesCells >= keep
  if (showRates) used += ratesCells
  // Forecasts only after the paces (when there are paces), in that order.
  const showForecasts = forecastCells > 0 && (ratesCells === 0 || showRates) && columns - used - forecastCells >= keep
  if (showForecasts) used += forecastCells
  // The widest meters that leave the context bar its room; none if even the
  // narrowest do not.
  const meterWidth = !showBars
    ? 0
    : (METER_WIDTHS.find(width => columns - used - limits.length * (width + 1) >= keep) ?? 0)
  return { showDetail, meterWidth, showRates, showForecasts }
}

// The context's details lines the settings turn on and the reading has
// something for: "MCP  slack 8.2k · github 6.1k", "Memory  CLAUDE.md 1.2k",
// "Skills  12 of 40, 10k · agents 3, 67". Each is one line, cut at the band's
// edge.
function detailLines(details: ContextDetails | undefined, on: DetailsSetting): [string, string][] {
  // A reading kept from before a reload may have no details yet.
  if (details === undefined) return []
  const list = (items: { name: string; tokens: number }[]) => items.map(i => `${i.name} ${short(i.tokens)}`).join(' \u00b7 ')
  const lines: [string, string][] = []
  if (on.mcp && details.mcp.length > 0) lines.push(['MCP', list(details.mcp)])
  if (on.memory && details.memory.length > 0) lines.push(['Memory', list(details.memory)])
  if (on.skills && (details.skills !== null || details.agents.count > 0)) {
    const parts = []
    if (details.skills !== null) parts.push(`${details.skills.included} of ${details.skills.total}, ${short(details.skills.tokens)}`)
    if (details.agents.count > 0) parts.push(`agents ${details.agents.count}, ${short(details.agents.tokens)}`)
    lines.push(['Skills', parts.join(' \u00b7 ')])
  }
  return lines
}

// A share of the window in parts per 10,000, the most flexGrow takes.
function grow(tokens: number, window: number) {
  return Math.min(10_000, Math.round((tokens / window) * 10_000 * 100) / 100)
}

// The percentages in both views: plain text, yellow from 50%, red from 80%.
function warning(percent: number) {
  return percent < 50 ? {} : { color: levelColor(percent) }
}