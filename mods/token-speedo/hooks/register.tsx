import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Stats, Step } from '../types'
import {
  addStep, allTokens, barsSvg, cacheHit, emptyStats, fmt, fmtMs, gaugeSvg,
  genMs, scaleFor, speedOf, textGauge,
} from './meter'

// The strip above the prompt holds the speedometer; Details there opens this
// pane beside the chat for the full view.
const PANE = 'token-speedo'
const TITLE = 'Speedo'
// Change the tag when Stats changes shape: a value an older version stored is
// then read as absent instead of as the wrong shape.
const stats = atom({ plugin: 'token-speedo', key: 'stats' } as const, emptyStats(), { shape: 'stats-1' })
const isHidden = atom({ plugin: 'token-speedo', key: 'isHidden' } as const, false)

// How often the needle moves while a reply streams.
const TICK_MS = 250
// A stream younger than this has too few pieces to give a fair speed.
const SETTLE_MS = 300
// Characters per token, for the live estimate only; each step's end puts
// the API's exact count in its place.
const CHARS_PER_TOKEN = 4

type Live = { firstAt: number; chars: number }

// The streams running now, one per model request (subagents run their own
// at the same time, so the needle shows their sum).
const streams = new Map<string, Live>()
let live = 0
let ticker: { cancel(): void } | null = null
let isPaneOpen = false

function redraw($: EngineInterface) {
  $.ui.invalidate('ui.render')
}

function tick($: EngineInterface) {
  void $.clock.now().then(now => {
    let raw = 0
    for (const s of streams.values()) {
      const age = now - s.firstAt
      if (s.firstAt > 0 && age >= SETTLE_MS) raw += s.chars / CHARS_PER_TOKEN / (age / 1000)
    }
    live = live === 0 ? raw : 0.6 * live + 0.4 * raw
    redraw($)
  })
}

function startTicker($: EngineInterface) {
  if (ticker === null) ticker = $.clock.every(TICK_MS, () => tick($))
}

function stopTickerIfIdle($: EngineInterface) {
  if (streams.size > 0 || ticker === null) return
  ticker.cancel()
  ticker = null
  live = 0
  redraw($)
}

async function togglePane($: EngineInterface) {
  if (isPaneOpen) {
    await $.ui.close({ id: PANE })
  } else {
    isPaneOpen = (await $.ui.open({ id: PANE, title: TITLE })).isPlaced
  }
  redraw($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'speedo',
      description: 'Show or hide the token speedometer',
      immediate: true,
    })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await update($, stats, st => (st.turnId === e.turnId ? st : { ...st, turnId: e.turnId, turn: { ...emptyStats().turn } }))
    return next(e)
  }).catch(($, e, next) => next(e))

  // Each model request: count what streams in for the live needle, then
  // record the API's exact usage when the response is complete.
  on('turn.step', async function* ($, e, next) {
    const key = `${e.agentId ?? 'main'}:${e.turnId}:${e.index}`
    const startedAt = await $.clock.now()
    const s: Live = { firstAt: 0, chars: 0 }
    streams.set(key, s)
    startTicker($)
    const stream = next(e)
    try {
      for await (const chunk of stream) {
        const piece = chunk.kind === 'text' || chunk.kind === 'thinking' ? chunk.text : chunk.kind === 'input' ? chunk.json : ''
        if (piece !== '') {
          if (s.firstAt === 0) s.firstAt = await $.clock.now()
          s.chars += piece.length
        }
        yield chunk
      }
      const result = await stream.result
      const usage = result.usage
      if (usage !== null) {
        const ms = (await $.clock.now()) - startedAt
        const firstTokenMs = s.firstAt > 0 ? s.firstAt - startedAt : ms
        const step: Step = {
          speed: speedOf(usage.output_tokens, genMs({ ms, firstTokenMs })),
          output: usage.output_tokens,
          input: usage.input_tokens,
          cacheRead: usage.cache_read_input_tokens,
          cacheWrite: usage.cache_creation_input_tokens,
          firstTokenMs,
          ms,
          isSubagent: e.agentId !== undefined,
        }
        await update($, stats, st => addStep(st, step, e.turnId, usage.model))
      }
      return result
    } finally {
      streams.delete(key)
      stopTickerIfIdle($)
    }
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context') || e.changed.includes('cost')) {
      await update($, stats, st => ({
        ...st,
        contextPercent: e.context.percent ?? st.contextPercent,
        costUsd: e.cost?.usd ?? st.costUsd,
      }))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      isPaneOpen = false
      redraw($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'speedo' }, async $ => {
    if (!(await read($, isHidden))) {
      await update($, isHidden, () => true)
      if (isPaneOpen) await $.ui.close({ id: PANE })
      return { text: 'Speedometer hidden. Run /speedo to bring it back.' }
    }
    await update($, isHidden, () => false)
    redraw($)
    return { text: 'Speedometer shown above the prompt.' }
  })

  // ---- drawing ---------------------------------------------------------------

  /** What the needle shows: the live estimate while streaming, else the last step. */
  function reading(st: Stats) {
    const isLive = streams.size > 0 && live > 0
    const last = st.recent[st.recent.length - 1]
    const value = Math.round(isLive ? live : last?.speed ?? 0)
    return { isLive, value, last, max: scaleFor(value, st.peak) }
  }

  /** Everything after the speed, as one line. */
  function details(st: Stats): string {
    const { last } = reading(st)
    const hit = cacheHit(st.session)
    return [
      `peak ${st.peak}`,
      hit === null ? null : `cache ${hit}%`,
      last ? `step ${fmt(last.output)} out` : null,
      st.turn.steps > 0 ? `turn ${st.turn.steps} ${st.turn.steps === 1 ? 'step' : 'steps'}` : null,
      `Σ ${fmt(allTokens(st.session))}`,
    ].filter(Boolean).join(' · ')
  }

  function summary(st: Stats): string {
    const { value, max } = reading(st)
    return `${textGauge(value, max)} ${value} tok/s · ${details(st)}`
  }

  // The strip above the prompt: a small gauge and one line on the apps, the
  // text gauge on the terminal, which draws no vectors.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const st = await read($, stats)
    if (st.session.steps === 0 || (await read($, isHidden))) return next(e)
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    if (e.surface === 'terminal' || !('Svg' in els)) {
      return (
        <Box justifyContent="flex-end">
          <Text dimColor>{summary(st)}</Text>
        </Box>
      )
    }
    const { Svg } = els
    const { isLive, value, max } = reading(st)
    return (
      <Box flexDirection="row" alignItems="center" gap={1} paddingX={1}>
        <Svg source={gaugeSvg(value, max, st.peak, isLive)} alt={`${value} tokens per second`} width={36} height={20} />
        <Text weight="medium" tabular>{value} tok/s</Text>
        <Text dimColor tabular>{details(st)}</Text>
        <Button key="details" label={isPaneOpen ? 'Hide details' : 'Details'} plain onPress={() => togglePane($)} />
      </Box>
    )
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const st = await read($, stats)
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    const { isLive, value, last, max } = reading(st)
    const hit = cacheHit(st.session)
    const Svg = 'Svg' in els ? els.Svg : null

    if (Svg === null) {
      return (
        <Box flexDirection="column">
          <Text>{st.session.steps === 0 ? 'Waiting for the first reply…' : summary(st)}</Text>
        </Box>
      )
    }

    const speedLine = (
      <Text weight="medium" tabular>
        {value} tok/s{isLive ? '' : last ? ' · last step' : ''}
      </Text>
    )

    if (e.props.placement === 'widget') {
      return (
        <Box flexDirection="column" alignItems="center">
          <Svg source={gaugeSvg(value, max, st.peak, isLive)} alt={`${value} tokens per second`} width={150} height={84} />
          {speedLine}
          <Text size="caption" dimColor tabular>
            {hit === null ? 'Cache –' : `Cache ${hit}%`} · Step {fmt(last?.output ?? 0)} · Σ {fmt(allTokens(st.session))}
          </Text>
        </Box>
      )
    }

    const turnSpeed = speedOf(st.turn.output, st.turn.genMs)
    const tile = (label: string, val: string, sub: string) => (
      <Box flexDirection="column" paddingX={1}>
        <Text size="caption" dimColor>{label}</Text>
        <Text weight="medium" tabular>{val}</Text>
        <Text size="caption" dimColor tabular>{sub}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2} flexWrap="wrap" alignItems="center">
          <Box flexDirection="column" alignItems="center">
            <Svg source={gaugeSvg(value, max, st.peak, isLive)} alt={`${value} tokens per second, peak ${st.peak}`} width={200} height={112} />
            <Text weight="medium" tabular>{value} tok/s · peak {st.peak}</Text>
            <Text size="caption" dimColor>{isLive ? 'live estimate' : last ? 'last step, exact' : 'waiting for a reply'} · scale 0–{max}</Text>
          </Box>
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="row" gap={1}>
              {tile('Cache hit', hit === null ? '–' : `${hit}%`, `${fmt(st.session.cacheRead)} read · ${fmt(st.session.cacheWrite)} written`)}
              {tile('This step', `${fmt(last?.output ?? 0)} out`, `${fmt(last?.input ?? 0)} fresh input`)}
            </Box>
            <Box flexDirection="row" gap={1}>
              {tile('First token', last ? fmtMs(last.firstTokenMs) : '–', last ? `step took ${fmtMs(last.ms)}` : '')}
              {tile('This turn', `${st.turn.steps} ${st.turn.steps === 1 ? 'step' : 'steps'}`, `${fmt(st.turn.output)} out · avg ${turnSpeed} tok/s`)}
            </Box>
          </Box>
        </Box>
        {st.recent.length > 0 && (
          <Box flexDirection="column">
            <Text size="caption" dimColor>Speed per step, last {st.recent.length}</Text>
            <Svg source={barsSvg(st.recent, scaleFor(st.peak))} alt="Output speed of the recent steps" height={50} />
          </Box>
        )}
        <Text size="caption" dimColor tabular>
          Session {fmt(allTokens(st.session))} tokens · {st.session.steps} steps
          {st.contextPercent === null ? '' : ` · context ${st.contextPercent}% full`}
          {st.costUsd === null ? '' : ` · $${st.costUsd.toFixed(2)}`}
          {st.model ? ` · ${st.model}` : ''}
        </Text>
      </Box>
    )
  })
}
