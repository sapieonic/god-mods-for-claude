// The sums and the drawings, with no `$`: everything here is plain data in,
// plain data out, so the tests can check it directly.
import type { Stats, Step, Totals } from '../types'

export const RECENT = 12

export const emptyTotals = (): Totals => ({ steps: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, genMs: 0 })

export const emptyStats = (): Stats => ({
  recent: [],
  turn: emptyTotals(),
  turnId: '',
  session: emptyTotals(),
  peak: 0,
  model: '',
  contextPercent: null,
  costUsd: null,
})

/** A step's generating time: from its first piece, or the whole step when it streamed none. */
export function genMs(step: Pick<Step, 'ms' | 'firstTokenMs'>): number {
  const fromFirst = step.ms - step.firstTokenMs
  return fromFirst >= 200 ? fromFirst : step.ms
}

/** Output tokens per second; 0 for a step too short to measure. */
export function speedOf(output: number, ms: number): number {
  return ms >= 100 ? Math.round((output / ms) * 1000) : 0
}

function add(t: Totals, s: Step): Totals {
  return {
    steps: t.steps + 1,
    input: t.input + s.input,
    output: t.output + s.output,
    cacheRead: t.cacheRead + s.cacheRead,
    cacheWrite: t.cacheWrite + s.cacheWrite,
    genMs: t.genMs + genMs(s),
  }
}

export function addStep(st: Stats, step: Step, turnId: string, model: string): Stats {
  const turn = st.turnId === turnId ? st.turn : emptyTotals()
  return {
    ...st,
    recent: [...st.recent, step].slice(-RECENT),
    turn: add(turn, step),
    turnId,
    session: add(st.session, step),
    peak: Math.max(st.peak, step.speed),
    model: model || st.model,
  }
}

/** Share of input tokens the prompt cache served, 0 to 100; null with no input yet. */
export function cacheHit(t: Pick<Totals, 'input' | 'cacheRead' | 'cacheWrite'>): number | null {
  const all = t.input + t.cacheRead + t.cacheWrite
  return all > 0 ? Math.round((t.cacheRead / all) * 100) : null
}

export const allTokens = (t: Totals) => t.input + t.output + t.cacheRead + t.cacheWrite

/** 1234 → "1.2k", 182400 → "182k", 2_500_000 → "2.5M". */
export function fmt(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

export function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
}

/** The gauge's top end: the first round number comfortably above what it shows. */
export function scaleFor(...speeds: number[]): number {
  const top = Math.max(0, ...speeds) * 1.1
  for (const max of [100, 200, 400, 800, 1600]) if (top <= max) return max
  return Math.ceil(top / 1000) * 1000
}

// Fixed hex colours: an Svg is drawn as an image, so theme variables don't
// reach it. Mid-tone stops read on both light and dark backgrounds.
const TRACK = '#888780'
const FILL = '#1D9E75'
const IDLE = '#5F5E5A'
const NEEDLE = '#D85A30'
const PEAK = '#BA7517'
const BAR = '#5DCAA5'

function point(fraction: number, r: number): [number, number] {
  const angle = Math.PI * (1 - Math.min(1, Math.max(0, fraction)))
  return [100 + r * Math.cos(angle), 100 - r * Math.sin(angle)]
}

const n1 = (x: number) => x.toFixed(1)

/** A half-circle gauge, 200×112 in its own units; nothing in it is text. */
export function gaugeSvg(value: number, max: number, peak: number, isLive: boolean): string {
  const f = value / max
  const [ax, ay] = point(f, 80)
  const [nx, ny] = point(f, 66)
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 112">`,
    `<path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="${TRACK}" stroke-opacity="0.35" stroke-width="12" stroke-linecap="round"/>`,
  ]
  if (f > 0.005) {
    parts.push(`<path d="M20 100 A80 80 0 0 1 ${n1(ax)} ${n1(ay)}" fill="none" stroke="${isLive ? FILL : IDLE}" stroke-width="12" stroke-linecap="round"/>`)
  }
  if (peak > 0) {
    const [px, py] = point(peak / max, 80)
    parts.push(`<circle cx="${n1(px)}" cy="${n1(py)}" r="4" fill="${PEAK}"/>`)
  }
  parts.push(
    `<line x1="100" y1="100" x2="${n1(nx)}" y2="${n1(ny)}" stroke="${NEEDLE}" stroke-width="4" stroke-linecap="round"/>`,
    `<circle cx="100" cy="100" r="7" fill="${IDLE}"/>`,
    `</svg>`,
  )
  return parts.join('')
}

/** One bar per recent step, its height its speed; the latest one darker. */
export function barsSvg(steps: readonly Step[], max: number): string {
  const w = 600
  const h = 50
  const slot = w / RECENT
  const bars = steps.map((s, i) => {
    const bh = Math.max(2, Math.round((Math.min(s.speed, max) / max) * h))
    const x = (RECENT - steps.length + i) * slot
    const fill = i === steps.length - 1 ? FILL : BAR
    return `<rect x="${n1(x + 4)}" y="${h - bh}" width="${n1(slot - 8)}" height="${bh}" rx="3" fill="${fill}" fill-opacity="${s.isSubagent ? 0.55 : 1}"/>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${bars.join('')}</svg>`
}

/** The terminal's gauge: ten cells, filled to the speed. */
export function textGauge(value: number, max: number): string {
  const filled = Math.round(Math.min(1, value / max) * 10)
  return `◜${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)}◝`
}
