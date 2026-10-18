// taskboard: the agent's task list as a Kanban board in a pane.
//
// Every hook here observes. Tool calls and spawns are passed on with
// `next(e)` unchanged and their results returned as they came; the board is
// updated after, synchronously, and saved later on a timer, so no tool call
// waits on the board.

import * as board from './board.js'
import { boardDir, init as initFile, load as loadFile, readOthers, saveNow, scheduleSave } from './persist.js'
import { age, renderPane, renderText } from './view.js'

const PANE = 'taskboard'
const TITLE = 'Taskboard'
const TICK_MS = 15_000
const OTHERS_MS = 10_000

// The tools whose calls carry the task list. Everything else is "activity".
// The two `ccd_turn` tools are the Claude desktop app's task list (its Code tab
// shows it under each message), used there in place of TodoWrite.
const PLAN_TOOL = 'mcp__ccd_turn__update_plan'
const WRAP_UP_TOOL = 'mcp__ccd_turn__wrap_up'
const TASK_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', PLAN_TOOL, WRAP_UP_TOOL])
// The one argument shown beside a tool's name, and only with showFilePaths on.
const PATH_ARG = { Read: 'file_path', Edit: 'file_path', Write: 'file_path', NotebookEdit: 'notebook_path' }

// View state: module-level, like the board itself.
let filter = 'all'
let selected = null
let isPaneOpen = false
let didAutoOpen = false
let cwd = ''
let sessionId = ''
let others = []
let othersTimer = null

let showFilePaths = false
let showAgentTasks = false
// Whether the terminal docks panes beside the transcript: null until a
// render or a command says. Only then does the board open by itself.
let isFullscreen = null
// Set by a /clear or /resume: the next turn or /board reads the new session id.
let needsRebind = false

// Task times come from Date.now(), read synchronously in the tool.call hook so
// observing a call adds no `$` round trip to it. Every other time uses it too.
const now = () => Date.now()


function changed($) {
  if (isPaneOpen) $.ui.invalidate('ui.render')
  scheduleSave($)
}

function targetOf(e) {
  const key = PATH_ARG[e.tool]
  const path = key === undefined ? undefined : e[key]
  if (!showFilePaths || typeof path !== 'string') return undefined
  return cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
}

// ---- task events onto columns --------------------------------------------
//
// `tool.call`'s `e` is the tool's arguments spread beside `tool`,
// `tool_use_id` and, inside a subagent, `agentId`. `next(e)` resolves to
// `{ result, isError? }` or `{ deny }`.
//
//   TodoWrite  e.todos[{ content, status }]   whole list: each status -> its column
//   TaskCreate e.subject; result.task.id      new card in Backlog (pending)
//   TaskUpdate e.taskId, e.status, e.subject  pending -> Backlog, in_progress -> In Progress,
//                                             completed -> Done, deleted -> removed
//   TaskList   result.tasks[{ id, status }]   reconciles cards it lists
//   update_plan e.items[{ content, status }]  (desktop app) whole plan, like TodoWrite;
//              or e.advance / e.done[n] / e.start n: step moves within the plan
//   wrap_up    -                             (desktop app) the step in progress -> Done
//   any other  -                             latest activity of the loop's active cards
//
// Blocked: a call that errors or is denied moves the loop's In Progress cards
// to Blocked (a failed TaskUpdate also blocks its own card); the next call
// in that loop that succeeds moves them back, as does a new native status.
function observe($, e, ran) {
  const agent = e.agentId ?? board.MAIN
  const at = now()
  const isDenied = ran?.deny !== undefined
  const isFailed = isDenied || ran?.isError === true
  const before = board.changes()

  switch (e.tool) {
    case 'TodoWrite':
      if (!isFailed) board.applyTodoWrite(e.todos, agent, at)
      break
    case 'TaskCreate':
      if (!isFailed) board.applyTaskCreate(ran.result?.task?.id, e.subject, agent, at)
      break
    case 'TaskUpdate':
      if (isFailed || ran.result?.success === false) board.blockTask(e.taskId, at, 'TaskUpdate failed')
      else board.applyTaskUpdate({ taskId: e.taskId, status: e.status, subject: e.subject, owner: e.owner }, agent, at)
      break
    case 'TaskList':
      if (!isFailed) board.applyTaskList(ran.result?.tasks, agent, at)
      break
    case 'TaskGet':
      break
    case PLAN_TOOL:
      if (!isFailed) board.applyPlan({ items: e.items, advance: e.advance, done: e.done, start: e.start }, agent, at)
      break
    case WRAP_UP_TOOL:
      if (!isFailed) board.completePlan(agent, at)
      break
    default:
      board.recordActivity(agent, { tool: String(e.tool), target: targetOf(e), at, isError: isFailed || undefined })
  }

  if (isFailed) board.blockActive(agent, at, `${e.tool} ${isDenied ? 'denied' : 'failed'}`)
  else if (!TASK_TOOLS.has(e.tool)) board.resumeBlocked(agent, at, `${e.tool} succeeded`)

  if (board.changes() === before) return
  // The first task of the session opens the board, but only where the terminal
  // docks panes as a sidebar (fullscreen); elsewhere an unasked pane would sit
  // above the prompt, so the person opens it with /board.
  if (!didAutoOpen && isFullscreen === true && board.allTasks().length > 0) {
    didAutoOpen = true
    void $.ui.open({ id: PANE, title: TITLE }).then(r => (isPaneOpen = isPaneOpen || r.isPlaced), () => {})
  }
  changed($)
}

function stopOthers() {
  othersTimer?.cancel()
  othersTimer = null
}

/** Points the board (and its file) at the session id the process now runs under. */
async function rebind($, id) {
  needsRebind = false
  if (typeof id !== 'string' || id === '' || id === sessionId) return
  sessionId = id
  board.reset()
  selected = null
  await initFile($, sessionId)
  if (await loadFile($)) didAutoOpen = true
  if (isPaneOpen) $.ui.invalidate('ui.render')
}

function startOthers($) {
  if (othersTimer !== null) return
  othersTimer = $.clock.every(OTHERS_MS, () => void refreshOthers($))
  void refreshOthers($)
}

async function refreshOthers($) {
  others = await readOthers($)
  if (isPaneOpen) $.ui.invalidate('ui.render')
}


export function register(on, options) {
  showFilePaths = options?.showFilePaths === true
  showAgentTasks = options?.showAgentTasks === true

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    try {
      observe($, e, ran)
    } catch {
      // The board is best effort; the call's result is never touched.
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    try {
      if (typeof ran?.agentId === 'string') {
        // The agent's type and a short id; its task description only when the
        // person asked for it (it is the model's words, kept in the board file).
        const label = `${e.subagentType} ${ran.agentId.slice(0, 4)}`
        board.nameAgent(ran.agentId, showAgentTasks && e.description ? `${label}: ${e.description}` : label)
        changed($)
      }
    } catch {}
    return ran
  }).catch(($, e, next) => next(e))

  // An interrupted turn (Esc) or one an API error ended: its In Progress
  // cards move to Blocked. The main loop's interrupt stops its subagents too.
  on('turn.complete', ($, e, next) => {
    if (e.isAborted || e.reason === 'error') {
      board.blockActive(e.agentId, now(), e.isAborted ? 'turn interrupted' : 'turn ended on an error')
      changed($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.close', ($, e, next) => {
    if (e.id === PANE) {
      isPaneOpen = false
      stopOthers()
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // ---- session --------------------------------------------------------------

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    sessionId = await $.session.id()
    await initFile($, sessionId)
    if (await loadFile($)) didAutoOpen = true
    await $.command.register({
      name: 'board',
      description: 'Toggle the taskboard pane; "/board text" prints the board instead',
      argumentHint: '[text]',
      immediate: true,
    })
    await $.command.register({
      name: 'board-clear',
      description: 'Remove finished tasks from the taskboard',
      immediate: true,
    })
    isPaneOpen = (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)
    // Keeps "how long in this column" current while anything is still moving.
    $.clock.every(TICK_MS, () => {
      if (isPaneOpen && board.allTasks().some(t => t.column !== 'done')) $.ui.invalidate('ui.render')
    })
    return next(e)
  })

  // /clear, /resume and /branch end this conversation without a new
  // session.start: save, empty the board, and bind to the next session's id
  // when its classic SessionStart arrives.
  on('session.end', async ($, e, next) => {
    await saveNow($)
    if (e.reason === 'clear' || e.reason === 'resume') {
      needsRebind = true
      board.reset()
      selected = null
      didAutoOpen = false
      if (isPaneOpen) $.ui.invalidate('ui.render')
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Where an organization manages Claude Code this classic event skips
  // installed plugins; the turn.start below covers that case.
  on('classic.SessionStart', async ($, e, next) => {
    if (sessionId !== '') await rebind($, e.session_id)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (needsRebind) await rebind($, await $.session.id())
    return next(e)
  }).catch(($, e, next) => next(e))

  // The prompt's hint line is drawn on every surface that draws at all: a
  // cheap place to learn whether panes dock. It draws nothing of its own.
  on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
    if (typeof e.viewport?.isFullscreen === 'boolean') isFullscreen = e.viewport.isFullscreen
    return next(e)
  }).catch(($, e, next) => next(e))

  // ---- commands (registered `immediate`, so they run mid-turn) ---------------

  on('command.run', { command: 'board' }, async ($, e) => {
    isFullscreen = e.presentation?.isFullscreen ?? isFullscreen
    if (needsRebind) await rebind($, await $.session.id())
    let note = ''
    if ((e.args ?? '').trim().toLowerCase() !== 'text') {
      const pane = (await $.ui.panes()).find(p => p.id === PANE)
      if (pane?.isPlaced) {
        await $.ui.close({ id: PANE })
        isPaneOpen = false
        stopOthers()
        return { text: 'Taskboard closed.' }
      }
      // Asked by the person, so a drawing surface places it at any width.
      // Where nothing draws (claude -p, a surface that places no pane) it
      // stays unplaced: close it again and answer with text.
      if ((await $.session.surfaces()).length > 0) {
        const opened = await $.ui.open({ id: PANE, title: TITLE })
        if (opened.isPlaced) {
          isPaneOpen = true
          return { text: 'Taskboard opened. Run /board again to close it.' }
        }
        await $.ui.close({ id: PANE })
        note = `\n\n(No pane here: ${opened.reason})`
      }
    }
    return { text: renderText(ownCards(), now(), `Taskboard — ${board.allTasks().length} tasks`) + note }
  }).catch(() => ({ text: 'taskboard: the board could not be shown (see claude --debug).' }))

  on('command.run', { command: 'board-clear' }, async $ => {
    const removed = board.clearDone()
    if (selected !== null && !board.allTasks().some(t => t.key === selected)) selected = null
    changed($)
    return { text: removed === 0 ? 'No finished tasks to clear.' : `Cleared ${removed} finished task${removed === 1 ? '' : 's'}.` }
  }).catch(() => ({ text: 'taskboard: could not clear the board.' }))

  // ---- the pane ---------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => {
    isPaneOpen = true
    const tabs = [{ id: 'all', label: 'All' }, { id: board.MAIN, label: 'Main' }]
    for (const agent of board.agentIds()) if (agent !== board.MAIN) tabs.push({ id: agent, label: board.agentLabel(agent) })
    if (boardDir() !== null) tabs.push({ id: 'others', label: 'Other sessions' })
    if (!tabs.some(t => t.id === filter)) filter = 'all'
    // Reopened on the Other sessions tab: its refresh stopped with the close.
    if (filter === 'others') startOthers($)

    const cards = filter === 'others' ? otherCards() : ownCards(filter)
    if (selected !== null && !cards.some(c => c.key === selected)) selected = null
    return renderPane($.ui.resolve(e), {
      cards,
      now: now(),
      columns: e.props.bodyColumns,
      tabs,
      filter,
      selected,
      note: filter === 'others' ? othersNote() : undefined,
      onTab: id => {
        filter = id
        stopOthers()
        if (id === 'others') return startOthers($)
        $.ui.invalidate('ui.render')
      },
      onSelect: key => {
        selected = selected === key ? null : key
        $.ui.invalidate('ui.render')
      },
      onClear: () => {
        board.clearDone()
        changed($)
      },
    })
  }).catch(($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, { dimColor: true }, 'taskboard could not draw the board (see claude --debug).')
  })
}

// ---- cards ------------------------------------------------------------------

function labelOf(task) {
  const parts = []
  if (task.agent !== board.MAIN) parts.push(board.agentLabel(task.agent))
  if (task.owner) parts.push(`@${task.owner}`)
  return parts.join(' ')
}

function ownCards(only = 'all') {
  return board
    .allTasks()
    .filter(t => only === 'all' || t.agent === only)
    .map(t => ({ ...t, label: labelOf(t) }))
}

function othersNote() {
  if (others.length === 0) return 'No other session saved a board in the last 7 days.'
  const ages = others.map(o => `${String(o.sessionId).slice(0, 8)} ${age(now() - o.savedAt)} ago`)
  return `Read-only: ${ages.join(', ')}`
}

function otherCards() {
  const cards = []
  for (const data of others) {
    const short = String(data.sessionId).slice(0, 8)
    const names = data.agents ?? {}
    for (const t of data.tasks) {
      const agent = t.agent === board.MAIN ? '' : ` ${names[t.agent] ?? t.agent.slice(0, 6)}`
      cards.push({ ...t, key: `${data.sessionId}:${t.key}`, label: `session ${short}${agent}` })
    }
  }
  return cards
}
