// Drawing: the pane's tree and the plain-text board. Both take plain data
// and return a value; neither calls `$`, so a redraw is one pass over at most
// a few hundred tasks.

import { COLUMNS } from './board.js'

export function age(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const hours = Math.floor(m / 60)
  return hours < 24 ? `${hours}h ${m % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`
}

export function clock(at) {
  const d = new Date(at)
  const pad = n => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export const activityText = activity =>
  activity == null ? '' : `${activity.isError ? '✗ ' : ''}${activity.tool}${activity.target ? ` ${activity.target}` : ''}`

const columnTitle = id => COLUMNS.find(c => c.id === id)?.title ?? id

function cut(text, width) {
  if (width <= 1) return ''
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`
}

/**
 * The pane.
 *
 * @param {Record<string, any>} el the surface's element table
 * @param {{
 *   cards: Array<{ key: string, title: string, column: string, since: number,
 *     label: string, activity: any, history: any[] }>,
 *   now: number, columns: number, tabs: Array<{ id: string, label: string }>,
 *   filter: string, selected: string | null, note?: string,
 *   onTab: (id: string) => void, onSelect: (key: string) => void,
 *   onClear: () => void,
 * }} m
 */
export function renderPane(el, m) {
  const { Box, Text, Button } = el
  const isWide = m.columns >= 64
  const colWidth = isWide ? Math.max(14, Math.floor((m.columns - (COLUMNS.length - 1)) / COLUMNS.length)) : m.columns
  const inner = colWidth - 2

  const tabs = h(
    Box,
    { key: 'tabs', flexDirection: 'row', flexWrap: 'wrap', columnGap: 1 },
    ...m.tabs.map(tab =>
      h(Button, {
        key: `tab-${tab.id}`,
        label: tab.label,
        variant: tab.id === m.filter ? 'primary' : 'secondary',
        onPress: () => m.onTab(tab.id),
      }),
    ),
  )

  const card = c => {
    const isSelected = c.key === m.selected
    const meta = [age(m.now - c.since), c.label].filter(Boolean).join(' · ')
    const activity = activityText(c.activity)
    return h(
      Box,
      { key: `card-${c.key}`, flexDirection: 'column', marginBottom: 1 },
      h(
        Button,
        { key: `pick-${c.key}`, plain: true, onPress: () => m.onSelect(c.key) },
        h(Text, { inverse: isSelected, weight: 'semibold' }, cut(`${isSelected ? '▸ ' : ''}${c.title}`, inner)),
      ),
      h(Text, { dimColor: true, wrap: 'truncate-end' }, cut(meta, inner)),
      activity ? h(Text, { dimColor: true, wrap: 'truncate-end', color: c.activity.isError ? 'red' : undefined }, cut(activity, inner)) : null,
    )
  }

  const COLOR = { backlog: undefined, progress: 'yellow', blocked: 'red', done: 'green' }
  const column = col => {
    const list = m.cards.filter(c => c.column === col.id)
    return h(
      Box,
      { key: `col-${col.id}`, flexDirection: 'column', width: colWidth, paddingX: isWide ? 1 : 0 },
      h(Text, { weight: 'semibold', color: COLOR[col.id] }, `${col.title} (${list.length})`),
      ...(list.length === 0 ? [h(Text, { dimColor: true }, '—')] : list.map(card)),
    )
  }

  const board = h(Box, { key: 'board', flexDirection: isWide ? 'row' : 'column', marginTop: 1 }, ...COLUMNS.map(column))

  const chosen = m.cards.find(c => c.key === m.selected)
  const history = chosen
    ? h(
        Box,
        { key: 'history', flexDirection: 'column', marginTop: 1 },
        h(Text, { weight: 'semibold' }, cut(`History: ${chosen.title}`, m.columns)),
        ...chosen.history
          .slice()
          .reverse()
          .map((move, i) =>
            h(
              Text,
              { key: `h-${i}`, dimColor: i > 0, wrap: 'truncate-end' },
              cut(`${clock(move.at)}  ${move.from ? `${columnTitle(move.from)} → ` : ''}${columnTitle(move.to)}  (${move.why})`, m.columns),
            ),
          ),
      )
    : h(Text, { key: 'hint', dimColor: true }, 'Select a card to see its history.')

  const footer = h(
    Box,
    { key: 'footer', flexDirection: 'row', columnGap: 1, marginTop: 1 },
    h(Button, { key: 'clear', label: 'Clear done', onPress: m.onClear }),
    m.note ? h(Text, { dimColor: true }, m.note) : null,
  )

  return h(Box, { flexDirection: 'column' }, tabs, board, history, footer)
}

/** The same board as text, for surfaces that draw no pane. */
export function renderText(cards, now, heading) {
  const lines = [heading]
  for (const col of COLUMNS) {
    const list = cards.filter(c => c.column === col.id)
    lines.push('', `${col.title} (${list.length})`)
    if (list.length === 0) lines.push('  —')
    for (const c of list) {
      const activity = activityText(c.activity)
      lines.push(`  • ${c.title}  [${age(now - c.since)}${c.label ? ` · ${c.label}` : ''}${activity ? ` · ${activity}` : ''}]`)
    }
  }
  return lines.join('\n')
}
