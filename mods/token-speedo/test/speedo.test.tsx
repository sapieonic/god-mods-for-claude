import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { cacheHit, fmt, gaugeSvg, scaleFor, speedOf, textGauge } from '../hooks/meter'

const pane = (placement: 'widget' | 'dock') => ({
  plugin: 'token-speedo',
  component: 'Pane',
  requestId: 'token-speedo',
  props: {
    title: 'Speedo',
    isFocused: false,
    bodyColumns: 60,
    placement,
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
}) as const

const BAND = {
  plugin: 'token-speedo',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, rows: 10 },
} as const

type Reply = { firstMs: number; text: string; genMs: number; usage: Record<string, number> }

/** Everything beneath the mod. The engine's model step streams `reply`. */
function world(on: On, opts: { surfaces?: string[]; reply?: () => Reply } = {}) {
  const clock = mock.clock(on, { now: 10_000 })
  const opened: unknown[] = []
  const closed: unknown[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: (opts.surfaces ?? ['desktop']) as never }))
  on('command.register', () => ({ value: { command: 'speedo' } }))
  on('ui.open', ($, e) => {
    opened.push(e)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    closed.push(e)
    return { value: undefined } as never
  })
  on('ui.panes', () => ({ value: [] }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    const r = opts.reply?.() ?? { firstMs: 500, text: 'x'.repeat(400), genMs: 2000, usage: { output_tokens: 200, input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } }
    await clock.sleep(r.firstMs)
    yield { kind: 'text', index: 0, text: r.text } as never
    await clock.sleep(r.genMs)
    return { turnId: e.turnId, index: e.index, answer: r.text, toolUses: [], stopReason: 'end_turn', usage: { ...r.usage, model: 'claude-opus-5-5' } } as never
  })
  return { clock, opened, closed }
}

// `turn.step` is dispatched by the engine, so the kit's `$` types no method for it.
type Steps = { turn: { step(e: never): AsyncGenerator<unknown, unknown> } }
const stepOf = ($: unknown) => ($ as Steps).turn

async function step($: unknown, clock: { advance(ms: number): Promise<void> }, turnId = 't1', index = 0) {
  const stream = stepOf($).step({ turnId, index, model: 'claude-opus-5-5', messageCount: 1 } as never)
  const done = (async () => {
    for await (const _ of stream) { /* drain */ }
  })()
  await clock.advance(5_000)
  await done
}

describe('the meter', () => {
  test('a step records its exact speed and cache hit, shown in the strip above the prompt', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
    expect(w.opened).toEqual([])
    await $.turn.start({ turnId: 't1', prompt: 'hi' } as never)
    await step($, w.clock)

    const band = await $.ui.mount({ ...BAND, surface: 'desktop' } as never)
    expect(await band.find({ type: 'Svg' })).toBeTruthy()
    expect((await band.find({ type: 'Text', text: /tok\/s$/ }))?.text).toBe('100 tok/s')
    expect((await band.find({ type: 'Text', text: /^peak/ }))?.text).toBe('peak 100 · cache 90% · step 200 out · turn 1 step · Σ 1.2k')
    await band.unmount()
  })

  test('a minimized pane draws the small gauge', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
    await $.turn.start({ turnId: 't1', prompt: 'hi' } as never)
    await step($, w.clock)

    const ui = await $.ui.mount({ ...pane('widget'), surface: 'desktop' } as never)
    expect((await ui.find({ type: 'Text', text: /tok\/s/ }))?.text).toBe('100 tok/s · last step')
    expect((await ui.find({ type: 'Text', text: /Cache/ }))?.text).toBe('Cache 90% · Step 200 · Σ 1.2k')
    expect(await ui.find({ type: 'Svg' })).toBeTruthy()
    await ui.unmount()
  })

  test('Details opens the docked pane, and Hide details closes it', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
    await step($, w.clock)
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' } as never)
    await band.press({ key: 'details' })
    expect(w.opened).toEqual([expect.objectContaining({ id: 'token-speedo' })])
    expect(w.opened[0]).not.toHaveProperty('placement')
    await band.press({ key: 'details' })
    expect(w.closed).toEqual([expect.objectContaining({ id: 'token-speedo' })])
    await band.unmount()
  })

  test('the needle moves while a reply is still streaming', async ($, on) => {
    const w = world(on, { reply: () => ({ firstMs: 100, text: 'y'.repeat(800), genMs: 60_000, usage: { output_tokens: 1, input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) })
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
    const stream = stepOf($).step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 } as never)
    void (async () => {
      for await (const _ of stream) { /* drain */ }
    })()
    await w.clock.advance(1_100)

    const ui = await $.ui.mount({ ...pane('widget'), surface: 'desktop' } as never)
    const speed = (await ui.find({ type: 'Text', text: /tok\/s/ }))?.text ?? ''
    expect(speed).not.toContain('last step')
    expect(Number(speed.split(' ')[0])).toBeGreaterThan(0)
    await ui.unmount()
    await w.clock.advance(60_000)
  })

  test('the full pane shows the turn, the step bars and the session line', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true } as never)
    await $.turn.start({ turnId: 't1', prompt: 'hi' } as never)
    await step($, w.clock, 't1', 0)
    await step($, w.clock, 't1', 1)

    const ui = await $.ui.mount({ ...pane('dock'), surface: 'desktop' } as never)
    expect((await ui.find({ type: 'Text', text: /steps$/ }))?.text).toBe('2 steps')
    expect((await ui.find({ type: 'Text', text: /^Session/ }))?.text).toContain('Session 2.4k tokens · 2 steps')
    expect((await ui.find({ type: 'Text', text: /^Speed per step/ }))?.text).toBe('Speed per step, last 2')
    await ui.unmount()
  })

  test('the terminal gets a text line in the band and no pane', async ($, on) => {
    const w = world(on, { surfaces: ['terminal'] })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
    expect(w.opened).toEqual([])
    await step($, w.clock)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect((await ui.find({ type: 'Text', text: /tok\/s/ }))?.text).toBe('◜▰▰▰▰▰▱▱▱▱▱◝ 100 tok/s · peak 100 · cache 90% · step 200 out · turn 1 step · Σ 1.2k')
    await ui.unmount()
  })

  test('/speedo hides the band, and runs again to bring it back', async ($, on) => {
    const w = world(on, { surfaces: ['terminal'] })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
    await step($, w.clock)
    expect((await $.command.run({ command: 'speedo', args: '' } as never) as { text: string }).text).toMatch(/hidden/)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await ui.find({ type: 'Text', text: /tok\/s/ })).toBeFalsy()
    await ui.unmount()
    expect((await $.command.run({ command: 'speedo', args: '' } as never) as { text: string }).text).toMatch(/shown/)
  })
})

describe('the sums', () => {
  test('formats, cache share, speed and scale', () => {
    expect([fmt(999), fmt(1234), fmt(182_400), fmt(2_500_000)]).toEqual(['999', '1.2k', '182k', '2.5M'])
    expect(cacheHit({ input: 100, cacheRead: 900, cacheWrite: 0 })).toBe(90)
    expect(cacheHit({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull()
    expect(speedOf(200, 2000)).toBe(100)
    expect(speedOf(5, 50)).toBe(0)
    expect([scaleFor(78, 112), scaleFor(10), scaleFor(500)]).toEqual([200, 100, 800])
    expect(textGauge(50, 100)).toBe('◜▰▰▰▰▰▱▱▱▱▱◝')
  })

  test('the gauge draws no fill arc at zero and one at speed', () => {
    expect(gaugeSvg(0, 100, 0, false)).not.toContain('stroke="#5F5E5A"')
    expect(gaugeSvg(50, 100, 80, true)).toContain('A80 80 0 0 1 100.0 20.0')
  })
})
