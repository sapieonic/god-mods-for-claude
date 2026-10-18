import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const FILE = '/home/t/.claude/taskboard/sess-1.json'

/** Everything beneath the plugin: env, clock, files, session, panes, commands, tools. */
type Panes = { panes?: () => unknown; open?: () => unknown; close?: () => unknown; sessionId?: () => string }
function world(on: On, opts: { surfaces?: string[]; files?: Map<string, string> } & Panes = {}) {
  const files = opts.files ?? new Map<string, string>()
  const results = new Map<string, unknown>()
  mock.env(on, { HOME: '/home/t' })
  const clock = mock.clock(on, { now: 1_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: opts.sessionId?.() ?? 'sess-1' }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('session.surfaces', () => ({ value: opts.surfaces ?? ['terminal'] }))
  on('command.register', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: opts.panes?.() ?? [] }))
  on('ui.open', () => ({ value: opts.open?.() ?? { isPlaced: true } }))
  on('ui.close', () => ({ value: opts.close?.() }))
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => {
    if (!files.has(e.path)) throw new Error('ENOENT')
    return { value: files.get(e.path) }
  })
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', () => ({ value: [] }))
  on('turn.complete', () => ({ text: '' }))
  // The "engine" running each tool: a scripted result per call, keyed by tool.
  on('tool.call', ($, e) => {
    const scripted = results.get(String(e.tool))
    results.delete(String(e.tool))
    return (scripted ?? { result: {}, text: 'ok' }) as never
  })
  return { files, clock, next: (tool: string, result: unknown) => results.set(tool, result) }
}

const todos = (a: string, b: string, c: string, d: string) =>
  [
    ['Write the parser', a],
    ['Add tests', b],
    ['Update docs', c],
    ['Ship it', d],
  ].map(([content, status]) => ({ content, status, activeForm: content }))

const start = ($: any) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

const PANE = (bodyColumns: number) => ({
  plugin: 'taskboard',
  component: 'Pane' as const,
  requestId: 'taskboard',
  props: { title: 'Taskboard', isFocused: false, bodyColumns, placement: 'dock', scroll: { top: 0, bodyRows: 40, contentRows: 0 } } as never,
})

async function board($: any) {
  const out = await $.command.run({ command: 'board', args: 'text' })
  return String(out.text)
}

const column = (text: string, name: string) => {
  const lines = text.split('\n')
  const at = lines.findIndex(l => l.startsWith(`${name} (`))
  const items: string[] = []
  for (let i = at + 1; i < lines.length && lines[i].startsWith('  '); i++) {
    if (lines[i].startsWith('  • ')) items.push(lines[i].slice(4).replace(/\s+\[.*$/, ''))
  }
  return items
}

describe('a session with four tasks', () => {
  test('moves every task through every column, a failure and an interrupt included', async ($, on) => {
    const w = world(on)
    await start($)

    await $.tool.call({ tool: 'TodoWrite', todos: todos('pending', 'pending', 'pending', 'pending') } as never)
    expect(column(await board($), 'Backlog')).toEqual(['Write the parser', 'Add tests', 'Update docs', 'Ship it'])

    await $.tool.call({ tool: 'TodoWrite', todos: todos('in_progress', 'pending', 'pending', 'pending') } as never)
    await $.tool.call({ tool: 'Read', file_path: '/repo/src/app.ts' } as never)
    let text = await board($)
    expect(column(text, 'In Progress')).toEqual(['Write the parser'])
    expect(text).toContain('Write the parser  [0s · Read]')

    // A failing tool call blocks the loop's in-progress task...
    w.next('Edit', { result: 'boom', text: 'String not found', isError: true })
    await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' } as never)
    text = await board($)
    expect(column(text, 'Blocked')).toEqual(['Write the parser'])
    expect(text).toContain('✗ Edit')

    // ...and the next call that succeeds resumes it.
    await $.tool.call({ tool: 'Bash', command: 'echo SECRET-COMMAND' } as never)
    expect(column(await board($), 'In Progress')).toEqual(['Write the parser'])

    await $.tool.call({ tool: 'TodoWrite', todos: todos('completed', 'in_progress', 'pending', 'pending') } as never)
    // Esc mid-turn: the in-progress task is Blocked.
    await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 't1', reason: 'aborted' } as never)
    expect(column(await board($), 'Blocked')).toEqual(['Add tests'])

    // Re-sending an unchanged status does not unblock it; a new status does.
    await $.tool.call({ tool: 'TodoWrite', todos: todos('completed', 'in_progress', 'pending', 'pending') } as never)
    expect(column(await board($), 'Blocked')).toEqual(['Add tests'])
    await $.tool.call({ tool: 'TodoWrite', todos: todos('completed', 'completed', 'in_progress', 'pending') } as never)
    await $.tool.call({ tool: 'TodoWrite', todos: todos('completed', 'completed', 'completed', 'completed') } as never)

    text = await board($)
    expect(column(text, 'Done')).toEqual(['Write the parser', 'Add tests', 'Update docs', 'Ship it'])
    expect(column(text, 'Backlog')).toEqual([])

    // Saved a moment later, with titles, statuses, tool names and times only.
    await w.clock.advance(1_000)
    const saved = JSON.parse(w.files.get(FILE) ?? 'null')
    const parser = saved.tasks.find((t: any) => t.title === 'Write the parser')
    expect(parser.history.map((m: any) => m.to)).toEqual(['backlog', 'progress', 'blocked', 'progress', 'done'])
    expect(parser.history[2].why).toBe('Edit failed')
    expect(saved.tasks.find((t: any) => t.title === 'Add tests').history.map((m: any) => m.why)).toContain('turn interrupted')
    const raw = w.files.get(FILE) ?? ''
    expect(raw.includes('SECRET-COMMAND')).toBe(false)
    expect(raw.includes('src/app.ts')).toBe(false)
    expect(raw.includes('old_string')).toBe(false)

    expect(String((await $.command.run({ command: 'board-clear' } as never)).text)).toBe('Cleared 4 finished tasks.')
    expect(column(await board($), 'Done')).toEqual([])
  })

  test('tracks TaskCreate/TaskUpdate tasks, a failed update included', async ($, on) => {
    const w = world(on)
    await start($)
    for (const [id, subject] of [['1', 'Plan'], ['2', 'Build'], ['3', 'Test'], ['4', 'Release']]) {
      w.next('TaskCreate', { result: { task: { id, subject } }, text: `Task #${id} created` })
      await $.tool.call({ tool: 'TaskCreate', subject, description: 'not stored' } as never)
    }
    expect(column(await board($), 'Backlog')).toEqual(['Plan', 'Build', 'Test', 'Release'])

    await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' } as never)
    await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' } as never)
    await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' } as never)
    w.next('TaskUpdate', { result: { success: false, taskId: '3', updatedFields: [], error: 'nope' }, text: 'nope' })
    await $.tool.call({ tool: 'TaskUpdate', taskId: '3', status: 'in_progress' } as never)
    await $.tool.call({ tool: 'TaskUpdate', taskId: '4', status: 'deleted' } as never)

    const text = await board($)
    expect(column(text, 'Done')).toEqual(['Plan'])
    expect(column(text, 'In Progress')).toEqual(['Build'])
    expect(column(text, 'Blocked')).toEqual(['Test'])
    expect(text.includes('Release')).toBe(false)

    // TaskList reconciles: a status changed elsewhere lands on the board.
    w.next('TaskList', { result: { tasks: [{ id: '2', subject: 'Build', status: 'completed', blockedBy: [] }] }, text: '' })
    await $.tool.call({ tool: 'TaskList' } as never)
    expect(column(await board($), 'Done')).toEqual(['Plan', 'Build'])
    await w.clock.advance(1_000)
    expect((w.files.get(FILE) ?? '').includes('not stored')).toBe(false)
  })

  test('passes every tool call and its result through unchanged', async ($, on) => {
    const w = world(on)
    await start($)
    const answer = { result: { stdout: 'hi' }, text: 'hi', isError: true }
    w.next('Bash', answer)
    const ran = await $.tool.call({ tool: 'Bash', command: 'echo hi' } as never)
    expect(ran).toEqual(answer)
  })
})

test('each of four tasks goes Backlog → In Progress → Blocked → In Progress → Done', async ($, on) => {
  const w = world(on)
  await start($)
  const names = ['Write the parser', 'Add tests', 'Update docs', 'Ship it']
  const statuses = ['pending', 'pending', 'pending', 'pending']
  const write = () => $.tool.call({ tool: 'TodoWrite', todos: todos(...(statuses as [string, string, string, string])) } as never)
  await write()
  for (let i = 0; i < 4; i++) {
    statuses[i] = 'in_progress'
    await write()
    w.next('Bash', { result: {}, text: 'exit 1', isError: true })
    await $.tool.call({ tool: 'Bash', command: 'false' } as never)
    expect(column(await board($), 'Blocked')).toEqual([names[i]])
    await $.tool.call({ tool: 'Read', file_path: '/repo/x' } as never)
    statuses[i] = 'completed'
    await write()
  }
  await w.clock.advance(1_000)
  for (const task of JSON.parse(w.files.get(FILE) ?? '{}').tasks) {
    expect(task.history.map((m: any) => m.to)).toEqual(['backlog', 'progress', 'blocked', 'progress', 'done'])
  }
})

describe('the pane', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`draws columns side by side and a card's history on ${surface}`, async ($, on) => {
      world(on)
      await start($)
      await $.tool.call({ tool: 'TodoWrite', todos: todos('in_progress', 'pending', 'completed', 'pending') } as never)
      const ui = await $.ui.mount({ ...PANE(120), surface })
      expect(await ui.find({ text: 'Backlog (2)' })).toBeDefined()
      expect(await ui.find({ text: 'In Progress (1)' })).toBeDefined()
      expect(await ui.find({ text: 'Blocked (0)' })).toBeDefined()
      expect(await ui.find({ text: 'Done (1)' })).toBeDefined()
      expect((await ui.find({ key: 'board' }))?.props.flexDirection).toBe('row')

      await ui.press({ key: 'pick-todo:main:Write the parser' })
      expect(await ui.find({ text: /^History: Write the parser/ })).toBeDefined()
      expect(await ui.find({ text: /Backlog → In Progress|^\d\d:\d\d:\d\d  In Progress/ })).toBeDefined()

      await ui.press({ key: 'clear' })
      expect(await ui.find({ text: 'Done (0)' })).toBeDefined()
      await ui.unmount()
    })
  }

  test('stacks the columns in a narrow pane', async ($, on) => {
    world(on)
    await start($)
    await $.tool.call({ tool: 'TodoWrite', todos: todos('pending', 'pending', 'pending', 'pending') } as never)
    const ui = await $.ui.mount({ ...PANE(40), surface: 'terminal' })
    expect((await ui.find({ key: 'board' }))?.props.flexDirection).toBe('column')
    await ui.unmount()
  })
})

describe('/board', () => {
  test('opens the pane where a surface places it, and closes it the second time', async ($, on) => {
    let isOpen = false
    world(on, {
      panes: () => (isOpen ? [{ id: 'taskboard', title: 'Taskboard', isShown: true, isFocused: false, isPlaced: true, plugin: 'taskboard' }] : []),
      open: () => ((isOpen = true), { isPlaced: true }),
      close: () => void (isOpen = false),
    })
    await start($)
    expect((await $.command.run({ command: 'board' } as never)).text).toContain('opened')
    expect((await $.command.run({ command: 'board' } as never)).text).toBe('Taskboard closed.')
  })

  test('answers with a plain-text board where nothing draws (claude -p)', async ($, on) => {
    world(on, { surfaces: [] })
    await start($)
    await $.tool.call({ tool: 'TodoWrite', todos: todos('in_progress', 'pending', 'pending', 'completed') } as never)
    const text = String((await $.command.run({ command: 'board' } as never)).text)
    expect(text).toContain('Backlog (2)')
    expect(column(text, 'In Progress')).toEqual(['Write the parser'])
  })

  test('answers with text where the surface places no pane', async ($, on) => {
    world(on, { surfaces: ['vscode'], open: () => ({ isPlaced: false, reason: 'vscode places no pane' }) })
    await start($)
    const text = String((await $.command.run({ command: 'board' } as never)).text)
    expect(text).toContain('Done (0)')
    expect(text).toContain('No pane here: vscode places no pane')
  })
})

describe('persistence', () => {
  test('a restart of the session restores its board', async ($, on) => {
    const files = new Map<string, string>()
    files.set(
      FILE,
      JSON.stringify({
        version: 1,
        sessionId: 'sess-1',
        savedAt: 1,
        agents: {},
        tasks: [{ key: 'todo:main:Old', title: 'Old', column: 'progress', status: 'in_progress', since: 1, agent: 'main', source: 'todo', activity: null, history: [] }],
      }),
    )
    world(on, { files })
    await start($)
    expect(column(await board($), 'In Progress')).toEqual(['Old'])
  })
})

describe('subagents', () => {
  test('labels a subagent card and gives the agent a tab', async ($, on) => {
    world(on)
    on('agent.spawn', () => ({ model: 'haiku', agentId: 'ag-1234567' }))
    await start($)
    await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'p', description: 'find callers', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' } } as never)
    await $.tool.call({ tool: 'TodoWrite', agentId: 'ag-1234567', todos: [{ content: 'Grep callers', status: 'in_progress', activeForm: 'x' }] } as never)
    const text = await board($)
    expect(text).toContain('Grep callers  [0s · Explore ag-1]')
    expect(text.includes('find callers')).toBe(false)
    const ui = await $.ui.mount({ ...PANE(120), surface: 'terminal' })
    expect(await ui.find({ key: 'tab-ag-1234567' })).toBeDefined()
    await ui.press({ key: 'tab-main' })
    expect(await ui.find({ text: 'In Progress (0)' })).toBeDefined()
    await ui.press({ key: 'tab-ag-1234567' })
    expect(await ui.find({ text: 'In Progress (1)' })).toBeDefined()
    await ui.unmount()
  })
})

describe('the fixes from review', () => {
  test('/clear starts an empty board bound to the new session id', async ($, on) => {
    let id = 'sess-1'
    const w = world(on, { sessionId: () => id })
    await start($)
    w.next('TaskCreate', { result: { task: { id: '1', subject: 'Old' } }, text: '' })
    await $.tool.call({ tool: 'TaskCreate', subject: 'Old', description: '' } as never)
    await $.session.end({ reason: 'clear', sessionId: 'sess-1' } as never)
    id = 'sess-2'
    await $.turn.start({ turnId: 't2', prompt: 'hi' } as never)
    w.next('TaskCreate', { result: { task: { id: '1', subject: 'New' } }, text: '' })
    await $.tool.call({ tool: 'TaskCreate', subject: 'New', description: '' } as never)
    expect(column(await board($), 'Backlog')).toEqual(['New'])
    await w.clock.advance(1_000)
    expect(JSON.parse(w.files.get(FILE) ?? '{}').tasks.map((t: any) => t.title)).toEqual(['Old'])
    expect(JSON.parse(w.files.get('/home/t/.claude/taskboard/sess-2.json') ?? '{}').tasks.map((t: any) => t.title)).toEqual(['New'])
  })

  test('a malformed board file is skipped field by field, and /board still answers', async ($, on) => {
    const files = new Map<string, string>()
    files.set(FILE, JSON.stringify({ version: 1, tasks: [{ key: 'k', column: 'progress' }, { key: 'ok', title: 'Fine\nline', column: 'done', status: 'completed', since: 1, agent: 'main', history: [{ bad: 1 }] }] }))
    world(on, { files })
    await start($)
    expect(column(await board($), 'Done')).toEqual(['Fine line'])
    const ui = await $.ui.mount({ ...PANE(120), surface: 'terminal' })
    expect(await ui.find({ text: 'Done (1)' })).toBeDefined()
    await ui.unmount()
  })

  test('a card a failed TaskUpdate blocked goes back to its column once a call succeeds', async ($, on) => {
    const w = world(on)
    await start($)
    w.next('TaskCreate', { result: { task: { id: '7', subject: 'Later' } }, text: '' })
    await $.tool.call({ tool: 'TaskCreate', subject: 'Later', description: '' } as never)
    w.next('TaskUpdate', { result: 'x', text: 'boom', isError: true })
    await $.tool.call({ tool: 'TaskUpdate', taskId: '7', subject: 'Later!' } as never)
    expect(column(await board($), 'Blocked')).toEqual(['Later'])
    await $.tool.call({ tool: 'Read', file_path: '/repo/a' } as never)
    expect(column(await board($), 'Backlog')).toEqual(['Later'])
  })

  test('a subagent interrupt blocks only that agent; a main interrupt blocks all', async ($, on) => {
    world(on)
    await start($)
    await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Main work', status: 'in_progress', activeForm: 'x' }] } as never)
    await $.tool.call({ tool: 'TodoWrite', agentId: 'ag-9', todos: [{ content: 'Sub work', status: 'in_progress', activeForm: 'x' }] } as never)
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 's', reason: 'aborted', agentId: 'ag-9' } as never)
    let text = await board($)
    expect(column(text, 'Blocked')).toEqual(['Sub work'])
    expect(column(text, 'In Progress')).toEqual(['Main work'])
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'm', reason: 'error' } as never)
    text = await board($)
    expect(column(text, 'Blocked')).toEqual(['Main work', 'Sub work'])
  })

  test('session.end saves at once, and the file restores into a new run', async ($, on) => {
    const w = world(on)
    await start($)
    await $.tool.call({ tool: 'TodoWrite', todos: todos('in_progress', 'pending', 'pending', 'completed') } as never)
    await $.session.end({ reason: 'other', sessionId: 'sess-1' } as never)
    const saved = JSON.parse(w.files.get(FILE) ?? 'null')
    expect(saved.tasks).toHaveLength(4)
    const allowed = ['activity', 'agent', 'column', 'history', 'key', 'owner', 'since', 'source', 'status', 'title']
    for (const task of saved.tasks) expect(Object.keys(task).filter(k => !allowed.includes(k))).toEqual([])
  })

  test('showFilePaths and showAgentTasks add the path and the task description', { options: { showFilePaths: true, showAgentTasks: true } }, async ($, on) => {
    world(on)
    on('agent.spawn', () => ({ model: 'haiku', agentId: 'ag-1234567' }))
    await start($)
    await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'p', description: 'find callers', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' } } as never)
    await $.tool.call({ tool: 'TodoWrite', agentId: 'ag-1234567', todos: [{ content: 'Grep', status: 'in_progress', activeForm: 'x' }] } as never)
    await $.tool.call({ tool: 'Edit', agentId: 'ag-1234567', file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' } as never)
    expect(await board($)).toContain('Grep  [0s · Explore ag-1: find callers · Edit src/app.ts]')
  })
})

describe('the desktop app task list (ccd_turn)', () => {
  const PLAN = 'mcp__ccd_turn__update_plan'
  const plan = (statuses: string[]) =>
    ['Look around', 'Make the change', 'Run the tests'].map((content, i) => ({ content, status: statuses[i] }))

  test('update_plan items, advance, done/start and wrap_up move the cards', async ($, on) => {
    const w = world(on)
    await start($)
    await $.tool.call({ tool: PLAN, items: plan(['in_progress', 'pending', 'pending']), scope: 'first_task' } as never)
    let text = await board($)
    expect(column(text, 'In Progress')).toEqual(['Look around'])
    expect(column(text, 'Backlog')).toEqual(['Make the change', 'Run the tests'])

    await $.tool.call({ tool: 'Read', file_path: '/repo/a' } as never)
    expect(await board($)).toContain('Look around  [0s · Read]')

    await $.tool.call({ tool: PLAN, advance: true } as never)
    text = await board($)
    expect(column(text, 'Done')).toEqual(['Look around'])
    expect(column(text, 'In Progress')).toEqual(['Make the change'])

    // A failing call blocks the step; the plan tool itself never unblocks it.
    w.next('Edit', { result: 'x', text: 'boom', isError: true })
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a', old_string: 'a', new_string: 'b' } as never)
    expect(column(await board($), 'Blocked')).toEqual(['Make the change'])
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a', old_string: 'a', new_string: 'b' } as never)

    await $.tool.call({ tool: PLAN, done: [2], start: 3 } as never)
    text = await board($)
    expect(column(text, 'Done')).toEqual(['Look around', 'Make the change'])
    expect(column(text, 'In Progress')).toEqual(['Run the tests'])

    await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'done' } as never)
    text = await board($)
    expect(column(text, 'Done')).toEqual(['Look around', 'Make the change', 'Run the tests'])

    // A new plan adds its own cards and leaves the finished ones in Done.
    await $.tool.call({ tool: PLAN, items: [{ content: 'Next thing', status: 'in_progress' }], scope: 'new_task' } as never)
    await $.tool.call({ tool: PLAN, advance: true } as never)
    expect(column(await board($), 'Done')).toEqual(['Look around', 'Make the change', 'Run the tests', 'Next thing'])
  })

  test('advance still works after a reload, from the saved plan', async ($, on) => {
    const files = new Map<string, string>()
    const card = (key: string, title: string, column: string, status: string, planIndex: number) => ({
      key, title, column, status, since: 1, agent: 'main', source: 'plan', activity: null, history: [], planId: 5, planIndex,
    })
    files.set(FILE, JSON.stringify({ version: 1, sessionId: 'sess-1', savedAt: 1, agents: {}, tasks: [
      card('plan:main:A', 'A', 'progress', 'in_progress', 0),
      card('plan:main:B', 'B', 'backlog', 'pending', 1),
    ] }))
    world(on, { files })
    await start($)
    await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true } as never)
    const text = await board($)
    expect(column(text, 'Done')).toEqual(['A'])
    expect(column(text, 'In Progress')).toEqual(['B'])
  })
})
