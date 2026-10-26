// The settings, as one tree: what each part of the band shows in each view,
// each usage window's pace (shown in which views, its averaging window and
// its unit), and keep-warm's caps by TTL. Every setting is a leaf with a
// check of its own. The global settings are the whole tree; a session's own
// are a sparse copy of it, holding only the leaves the session set; the
// settings in force take the session's leaf where there is one, else the
// global. Pure functions; the hooks module keeps and saves the trees.

import type {
  AlertPart,
  BurnUnit,
  CapSetting,
  MonitorCurrent,
  MonitorFilter,
  MonitorCtxPiece,
  MonitorName,
  MonitorSort,
  MonitorState,
  MonitorTtlPiece,
  MonitorUsagePiece,
  Part,
  SettingsOverride,
  SettingsTree,
  Ttl,
  UsagePart,
  View,
  WarmMode,
} from '../types'
import { DEFAULT_CAPS, isCapValue, readCaps } from './cache'

// The band's views, in the order the panel lists them, and the panel's names
// for them: the collapsed line without bars, with bars, and the table.
export const VIEWS: View[] = ['plain', 'bars', 'expanded']
export const VIEW_NAMES: Record<View, string> = { plain: 'Minimal', bars: 'Collapsed', expanded: 'Expanded' }

export const ALL_PARTS: Part[] = ['5H', 'WK', 'other', 'CTX', 'TTL']

// The parts that are usage windows, which have a pace.
export const USAGE_PARTS: UsagePart[] = ['5H', 'WK', 'other']

// Each usage part's averaging windows (minutes) and units. The 5-hour window
// moves within the hour; the weekly ones (WK, and the model allowances most
// other windows are) over hours or days.
export const PACE_WINDOWS: Record<UsagePart, number[]> = {
  '5H': [15, 30, 60, 120],
  WK: [120, 360, 720, 1440],
  other: [120, 360, 720, 1440],
}
export const PACE_UNITS: Record<UsagePart, BurnUnit[]> = { '5H': ['h', 'min'], WK: ['h', 'day'], other: ['h', 'day'] }

// Keep-warm's modes, and how many minutes before the cache expires (Notify)
// or before the first ping (Both) the reminder comes, by TTL.
export const WARM_MODES: WarmMode[] = ['pings', 'notify', 'both']
export const NOTIFY_LEADS: Record<Ttl, number[]> = { '1h': [2, 5, 10, 15], '5m': [1, 2, 3] }

// The parts that can alert, and the levels an alert's stepper goes through:
// 50% to 95% in steps of 5, then 99%, then off (null).
export const ALERT_PARTS: AlertPart[] = ['5H', 'WK', 'other', 'CTX']
export const ALERT_STEPS: (number | null)[] = [50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 99, null]

// The next alert level up (+1, towards off) or down (-1), held at the ends.
export function stepAlert(level: number | null, by: 1 | -1) {
  const i = ALERT_STEPS.indexOf(level)
  return ALERT_STEPS[Math.min(ALERT_STEPS.length - 1, Math.max(0, i + by))] ?? null
}

// TW Monitor's choices, in the order the panel lists them: what a usage
// window's line shows; what a session's context and cache show, in which
// state; the name; the order; which sessions; and how far back "recent"
// reaches (minutes, 5 minutes to 7 days).
export const MONITOR_USAGE_PIECES: MonitorUsagePiece[] = ['bar', 'percent', 'reset', 'rate']
export const MONITOR_CTX_PIECES: MonitorCtxPiece[] = ['bar', 'percent', 'tokens']
export const MONITOR_TTL_PIECES: MonitorTtlPiece[] = ['bar', 'timer', 'warm']
export const MONITOR_STATES: MonitorState[] = ['expanded', 'collapsed']
export const MONITOR_NAMES: MonitorName[] = ['folder', 'title', 'both']
export const MONITOR_SORTS: MonitorSort[] = ['name', 'context', 'expiry', 'activity']
export const MONITOR_FILTERS: MonitorFilter[] = ['all', 'warm', 'recent']
export const RECENT_STEPS = [5, 10, 15, 30, 60, 120, 240, 480, 720, 1440, 4320, 10080]
export const MONITOR_CURRENT: MonitorCurrent[] = ['default', 'top']

export type Path = readonly string[]

const everyView = (): Record<View, boolean> => ({ plain: true, bars: true, expanded: true })
const everyPiece = (): Record<MonitorUsagePiece, boolean> => ({ bar: true, percent: true, reset: true, rate: true })
// The pace and its forecast, by default, only in the table, where they have
// columns of their own.
const expandedOnly = (): Record<View, boolean> => ({ plain: false, bars: false, expanded: true })

export const DEFAULT_SETTINGS: SettingsTree = {
  show: { '5H': everyView(), WK: everyView(), other: everyView(), CTX: everyView(), TTL: everyView() },
  pace: {
    '5H': { show: expandedOnly(), forecast: expandedOnly(), windowMin: 30, unit: 'h' },
    WK: { show: expandedOnly(), forecast: expandedOnly(), windowMin: 360, unit: 'h' },
    other: { show: expandedOnly(), forecast: expandedOnly(), windowMin: 360, unit: 'h' },
  },
  caps: DEFAULT_CAPS,
  // Keep-warm reminds, free, unless pings are chosen.
  warm: { mode: 'notify', lead: { '1h': 5, '5m': 1 } },
  alert: { '5H': null, WK: null, other: null, CTX: null },
  details: { mcp: false, memory: false, skills: false },
  // 5H and WK in full, no other windows; a session open in full, closed its
  // countdown and keep-warm alone.
  monitor: {
    usage: { '5H': everyPiece(), WK: everyPiece(), other: { bar: false, percent: false, reset: false, rate: false } },
    lines: {
      expanded: { ctx: { bar: true, percent: true, tokens: true }, ttl: { bar: true, timer: true, warm: true } },
      collapsed: { ctx: { bar: false, percent: false, tokens: false }, ttl: { bar: false, timer: true, warm: true } },
    },
    name: 'folder',
    sort: 'name',
    filter: 'all',
    recentMin: 1440,
    current: 'top',
  },
}

const TTLS: Ttl[] = ['1h', '5m']
const CAP_FIELDS: (keyof CapSetting)[] = ['pings', 'hours']

const isBool = (value: unknown) => typeof value === 'boolean'

// Every leaf of the tree with its check. A leaf `isGlobalOnly` has no
// session's own value: the usage windows' alerts, the windows being the
// account's, alert the same in every session.
const LEAVES: { path: Path; isValid: (value: unknown) => boolean; isGlobalOnly?: true }[] = [
  ...ALL_PARTS.flatMap(part => VIEWS.map(v => ({ path: ['show', part, v], isValid: isBool }))),
  ...USAGE_PARTS.flatMap(part => [
    ...VIEWS.map(v => ({ path: ['pace', part, 'show', v], isValid: isBool })),
    ...VIEWS.map(v => ({ path: ['pace', part, 'forecast', v], isValid: isBool })),
    { path: ['pace', part, 'windowMin'], isValid: (value: unknown) => PACE_WINDOWS[part].includes(value as number) },
    { path: ['pace', part, 'unit'], isValid: (value: unknown) => PACE_UNITS[part].includes(value as BurnUnit) },
  ]),
  ...TTLS.flatMap(ttl =>
    CAP_FIELDS.map(which => ({ path: ['caps', ttl, which], isValid: (value: unknown) => isCapValue(ttl, which, value) })),
  ),
  { path: ['warm', 'mode'], isValid: (value: unknown) => WARM_MODES.includes(value as WarmMode) },
  ...TTLS.map(ttl => ({ path: ['warm', 'lead', ttl], isValid: (value: unknown) => NOTIFY_LEADS[ttl].includes(value as number) })),
  ...(['mcp', 'memory', 'skills'] as const).map(which => ({ path: ['details', which], isValid: isBool })),
  // TW Monitor's, the same in every session: the settings panel's Monitor
  // view edits them, with no session's own.
  ...[
    ...USAGE_PARTS.flatMap(part => MONITOR_USAGE_PIECES.map(piece => ({ path: ['monitor', 'usage', part, piece], isValid: isBool }))),
    ...MONITOR_STATES.flatMap(state => [
      ...MONITOR_CTX_PIECES.map(piece => ({ path: ['monitor', 'lines', state, 'ctx', piece], isValid: isBool })),
      ...MONITOR_TTL_PIECES.map(piece => ({ path: ['monitor', 'lines', state, 'ttl', piece], isValid: isBool })),
    ]),
    { path: ['monitor', 'name'], isValid: (value: unknown) => MONITOR_NAMES.includes(value as MonitorName) },
    { path: ['monitor', 'sort'], isValid: (value: unknown) => MONITOR_SORTS.includes(value as MonitorSort) },
    { path: ['monitor', 'filter'], isValid: (value: unknown) => MONITOR_FILTERS.includes(value as MonitorFilter) },
    { path: ['monitor', 'recentMin'], isValid: (value: unknown) => RECENT_STEPS.includes(value as number) },
    { path: ['monitor', 'current'], isValid: (value: unknown) => MONITOR_CURRENT.includes(value as MonitorCurrent) },
  ].map(leaf => ({ ...leaf, isGlobalOnly: true as const })),
  ...ALERT_PARTS.map(part => ({
    path: ['alert', part],
    isValid: (value: unknown) => ALERT_STEPS.includes(value as number | null),
    ...(part === 'CTX' ? {} : { isGlobalOnly: true as const }),
  })),
]

export function getAt(tree: unknown, path: Path): unknown {
  let node = tree
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

// The tree with one leaf set, copied along its path.
export function setAt<T>(tree: T, path: Path, value: unknown): T {
  const [key, ...rest] = path
  if (key === undefined) return value as T
  const node = (typeof tree === 'object' && tree !== null ? tree : {}) as Record<string, unknown>
  return { ...node, [key]: setAt(node[key], rest, value) } as T
}

// The tree with one leaf removed, and any branch left empty with it.
export function dropAt<T>(tree: T, path: Path): T {
  const [key, ...rest] = path
  if (key === undefined || typeof tree !== 'object' || tree === null) return tree
  const node = tree as Record<string, unknown>
  if (!(key in node)) return tree
  const { [key]: child, ...others } = node
  if (rest.length === 0) return others as T
  const pruned = dropAt(child, rest)
  const isEmpty = typeof pruned === 'object' && pruned !== null && Object.keys(pruned).length === 0
  return (isEmpty ? others : { ...others, [key]: pruned }) as T
}

// The global settings read back from the store: each leaf that passes its
// check, else the default.
export function readSettings(saved: unknown): SettingsTree {
  return LEAVES.reduce((tree, leaf) => {
    const value = getAt(saved, leaf.path)
    return leaf.isValid(value) ? setAt(tree, leaf.path, value) : tree
  }, DEFAULT_SETTINGS)
}

// A session's own settings read back: only the leaves a session may set that
// pass their check.
export function readOverride(saved: unknown): SettingsOverride {
  return LEAVES.reduce<SettingsOverride>((tree, leaf) => {
    const value = getAt(saved, leaf.path)
    return !leaf.isGlobalOnly && leaf.isValid(value) ? setAt(tree, leaf.path, value) : tree
  }, {})
}

// Whether a path names a leaf only the global settings hold.
export function isGlobalOnly(path: Path) {
  return LEAVES.some(leaf => leaf.isGlobalOnly && leaf.path.length === path.length && leaf.path.every((k, i) => k === path[i]))
}

// 1.3.0's settings, the parts it hid (hidden in every view) and its caps, as
// a tree.
export function fromLegacy(hidden: unknown, caps: unknown): SettingsTree {
  const parts = Array.isArray(hidden) ? hidden.filter((p): p is Part => ALL_PARTS.includes(p as Part)) : []
  const show = parts.reduce(
    (tree, part) => ({ ...tree, [part]: { plain: false, bars: false, expanded: false } }),
    DEFAULT_SETTINGS.show,
  )
  return { ...DEFAULT_SETTINGS, show, caps: readCaps(caps) }
}

// The settings in force: the session's leaf where it set one, else the global.
export function merge(global: SettingsTree, override: SettingsOverride): SettingsTree {
  return LEAVES.reduce((tree, leaf) => {
    const value = getAt(override, leaf.path)
    return value === undefined ? tree : setAt(tree, leaf.path, value)
  }, global)
}

export function isEmptyOverride(override: SettingsOverride) {
  return LEAVES.every(leaf => getAt(override, leaf.path) === undefined)
}

// Whether the override sets any leaf under a path (a row of the panel).
export function overridesUnder(override: SettingsOverride, path: Path) {
  return LEAVES.some(leaf => path.every((key, i) => leaf.path[i] === key) && getAt(override, leaf.path) !== undefined)
}

// The next value of a list up (+1) or down (-1), held at the ends.
export function stepIn(list: number[], value: number, by: 1 | -1) {
  const i = list.indexOf(value)
  return list[Math.min(list.length - 1, Math.max(0, i + by))] ?? value
}

// The parts a view hides, and the usage parts whose pace it hides.
export function hiddenIn(settings: SettingsTree, view: View): Part[] {
  return ALL_PARTS.filter(part => !settings.show[part][view])
}

export function paceHiddenIn(settings: SettingsTree, view: View): Part[] {
  return USAGE_PARTS.filter(part => !settings.pace[part].show[view])
}

export function forecastHiddenIn(settings: SettingsTree, view: View): Part[] {
  return USAGE_PARTS.filter(part => !settings.pace[part].forecast[view])
}

// Whether no view shows the cache, which keeps keep-warm off.
export function isCacheHidden(settings: SettingsTree) {
  return VIEWS.every(v => !settings.show.TTL[v])
}

// How far back "recent" reaches, as the panel prints it: "15 min", "4 h",
// "3 d".
export function recentText(minutes: number) {
  if (minutes < 60) return `${minutes} min`
  if (minutes < 1440) return `${minutes / 60} h`
  return `${minutes / 1440} d`
}

// An averaging window as the panel prints it: "30 min", "6 h".
export function windowText(minutes: number) {
  return minutes < 60 ? `${minutes} min` : `${minutes / 60} h`
}
