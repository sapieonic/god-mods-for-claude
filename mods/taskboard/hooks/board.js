// The board's state and every transition on it. Pure apart from the
// module-level variables below: nothing here touches `$`, so the hooks in
// register.js decide when to call in, and tests drive it through events.

export const COLUMNS = [
  { id: 'backlog', title: 'Backlog' },
  { id: 'progress', title: 'In Progress' },
  { id: 'blocked', title: 'Blocked' },
  { id: 'done', title: 'Done' },
]

// Native task statuses onto columns. TodoWrite and TaskCreate/TaskUpdate share
// these three words; Blocked has no native status and is entered only by
// blockActive() below, when a call errors or a turn is interrupted.
const STATUS_TO_COLUMN = {
  pending: 'backlog',
  in_progress: 'progress',
  completed: 'done',
}

export const MAIN = 'main'
const COLUMN_IDS = new Set(COLUMNS.map(c => c.id))
const MAX_TASKS = 200
const MAX_HISTORY = 50

// ---- module-level state -------------------------------------------------

/** @type {Map<string, Task>} keyed by task key, in insertion order */
let tasks = new Map()
/** @type {Map<string, string>} agentId -> label ("Explore: find callers") */
let agents = new Map()
let version = 0

/**
 * @typedef {{ at: number, from: string | null, to: string, why: string }} Move
 * @typedef {{ tool: string, target?: string, at: number, isError?: boolean }} Activity
 * @typedef {{
 *   key: string, title: string, column: string, status: string, since: number,
 *   agent: string, owner?: string, source: 'todo' | 'task',
 *   activity: Activity | null, history: Move[]
 * }} Task
 */

/** Bumped by every change, so callers can tell whether to save or redraw. */
export const changes = () => version

export const allTasks = () => [...tasks.values()]
export const agentLabel = agent => (agent === MAIN ? 'main' : agents.get(agent) ?? `agent ${agent.slice(0, 6)}`)
export const agentIds = () => {
  const seen = new Set()
  for (const task of tasks.values()) seen.add(task.agent)
  return [...seen]
}

export function reset() {
  tasks = new Map()
  agents = new Map()
  version += 1
}

// ---- transitions --------------------------------------------------------

// Titles come from the model: one line, no control characters, bounded.
const clean = text => String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 300)

function move(task, to, at, why) {
  if (task.column === to) return false
  task.history.push({ at, from: task.column, to, why })
  if (task.history.length > MAX_HISTORY) task.history.splice(0, task.history.length - MAX_HISTORY)
  task.column = to
  task.since = at
  version += 1
  return true
}

function add(key, fields, at, why) {
  const task = {
    key,
    title: clean(fields.title) || '(untitled)',
    column: fields.column,
    status: fields.status,
    since: at,
    agent: fields.agent,
    owner: fields.owner,
    source: fields.source,
    activity: null,
    history: [{ at, from: null, to: fields.column, why }],
  }
  tasks.set(key, task)
  // Oldest finished tasks go first when the board is full.
  while (tasks.size > MAX_TASKS) {
    const oldest = [...tasks.values()].find(one => one.column === 'done') ?? tasks.values().next().value
    tasks.delete(oldest.key)
  }
  version += 1
  return task
}

/** A native status change: the column follows it, out of Blocked too. */
function setStatus(task, status, at, why) {
  const column = STATUS_TO_COLUMN[status]
  if (column === undefined) return
  const changed = task.status !== status
  task.status = status
  // A task re-sent with an unchanged status stays where it is, so a Blocked
  // task is not unblocked by the next TodoWrite repeating "in_progress".
  if (changed || task.column !== 'blocked') move(task, column, at, why)
}

/**
 * TodoWrite: `e.todos` is the whole list each time, [{ content, status,
 * activeForm }]. A todo is known by its text within its agent's loop; todos
 * missing from a later list are left where they were.
 */
export function applyTodoWrite(todos, agent, at) {
  for (const todo of todos ?? []) {
    if (typeof todo?.content !== 'string' || STATUS_TO_COLUMN[todo.status] === undefined) continue
    const key = `todo:${agent}:${todo.content}`
    const task = tasks.get(key)
    if (task === undefined) {
      add(key, { title: todo.content, column: STATUS_TO_COLUMN[todo.status], status: todo.status, agent, source: 'todo' }, at, `TodoWrite: ${todo.status}`)
    } else {
      setStatus(task, todo.status, at, `TodoWrite: ${todo.status}`)
    }
  }
}

/** TaskCreate: `e.subject` in, the id only in the result (`result.task.id`). New tasks are pending. */
export function applyTaskCreate(id, subject, agent, at) {
  if (typeof id !== 'string') return
  const key = `task:${id}`
  if (tasks.has(key)) return
  add(key, { title: subject || `Task ${id}`, column: 'backlog', status: 'pending', agent, source: 'task' }, at, 'TaskCreate')
}

/** TaskUpdate: `e.taskId` with optional `status` (pending|in_progress|completed|deleted), `subject`, `owner`. */
export function applyTaskUpdate(input, agent, at) {
  const key = `task:${input.taskId}`
  let task = tasks.get(key)
  if (input.status === 'deleted') {
    if (task !== undefined) {
      tasks.delete(key)
      version += 1
    }
    return
  }
  if (task === undefined) {
    // Created before the mod loaded (or on another loop it never saw).
    task = add(key, { title: input.subject || `Task ${input.taskId}`, column: 'backlog', status: 'pending', agent, source: 'task' }, at, 'seen in TaskUpdate')
  }
  if (input.subject && clean(input.subject) !== task.title) {
    task.title = clean(input.subject)
    version += 1
  }
  if (input.owner && input.owner !== task.owner) {
    task.owner = input.owner
    version += 1
  }
  // Whichever loop starts the task is the one working it: its activity and
  // its failures are the ones this card follows from now on.
  if (input.status === 'in_progress' && task.agent !== agent) {
    task.agent = agent
    version += 1
  }
  if (input.status) setStatus(task, input.status, at, `TaskUpdate: ${input.status}`)
}

/** TaskList's result is the authoritative list: create what is missing, align statuses. */
export function applyTaskList(list, agent, at) {
  for (const item of list ?? []) {
    if (typeof item?.id !== 'string') continue
    const key = `task:${item.id}`
    const task = tasks.get(key)
    if (task === undefined) {
      const column = STATUS_TO_COLUMN[item.status] ?? 'backlog'
      add(key, { title: item.subject, column, status: item.status, agent, owner: item.owner, source: 'task' }, at, 'seen in TaskList')
    } else {
      if (item.owner && item.owner !== task.owner) {
        task.owner = item.owner
        version += 1
      }
      setStatus(task, item.status, at, `TaskList: ${item.status}`)
    }
  }
}

/**
 * The desktop app's own task list, `mcp__ccd_turn__update_plan`. Its input is
 * one of: `items` [{ content, status }] (the whole plan, in order), `advance`
 * (complete the in-progress step, start the next pending one), or `done`
 * [n] / `start` n (1-based step numbers). Statuses map onto columns as
 * TodoWrite's do. The current plan of a loop is the cards of its latest
 * `items` call, so `advance` and the step numbers survive a reload.
 */
export function applyPlan(input, agent, at) {
  if (Array.isArray(input.items)) {
    const planId = at
    input.items.forEach((item, index) => {
      if (typeof item?.content !== 'string' || STATUS_TO_COLUMN[item.status] === undefined) return
      const key = `plan:${agent}:${clean(item.content)}`
      let task = tasks.get(key)
      if (task === undefined) {
        task = add(key, { title: item.content, column: STATUS_TO_COLUMN[item.status], status: item.status, agent, source: 'plan' }, at, `plan: ${item.status}`)
      } else {
        setStatus(task, item.status, at, `plan: ${item.status}`)
      }
      task.planId = planId
      task.planIndex = index
    })
    version += 1
    return
  }
  const plan = currentPlan(agent)
  const set = (task, status) => setStatus(task, status, at, `plan: ${status}`)
  if (input.advance === true) {
    const current = plan.findIndex(t => t.status === 'in_progress')
    if (current >= 0) set(plan[current], 'completed')
    const following = plan.findIndex((t, i) => i > current && t.status === 'pending')
    if (following >= 0) set(plan[following], 'in_progress')
  }
  for (const n of Array.isArray(input.done) ? input.done : []) if (plan[n - 1]) set(plan[n - 1], 'completed')
  if (typeof input.start === 'number' && plan[input.start - 1]) set(plan[input.start - 1], 'in_progress')
}

/** `mcp__ccd_turn__wrap_up` checks off the plan's step in progress. */
export function completePlan(agent, at) {
  for (const task of currentPlan(agent)) {
    if (task.status === 'in_progress') setStatus(task, 'completed', at, 'plan: wrapped up')
  }
}

function currentPlan(agent) {
  const mine = [...tasks.values()].filter(t => t.source === 'plan' && t.agent === agent && typeof t.planId === 'number')
  if (mine.length === 0) return []
  const latest = Math.max(...mine.map(t => t.planId))
  return mine.filter(t => t.planId === latest).sort((a, b) => a.planIndex - b.planIndex)
}

/** Any other tool call: becomes the latest activity of the loop's active tasks. */
export function recordActivity(agent, activity) {
  for (const task of tasks.values()) {
    if (task.agent !== agent || (task.column !== 'progress' && task.column !== 'blocked')) continue
    task.activity = activity
    version += 1
  }
}

/**
 * A tool call errored or a turn was interrupted: the loop's In Progress tasks
 * move to Blocked. `agent` undefined means every loop (the main turn was
 * interrupted, which stops its subagents with it).
 */
export function blockActive(agent, at, why) {
  for (const task of tasks.values()) {
    if (task.column !== 'progress') continue
    if (agent !== undefined && task.agent !== agent) continue
    move(task, 'blocked', at, why)
  }
}

/** A later call in the same loop succeeded: its Blocked tasks go back to their status's column. */
export function resumeBlocked(agent, at, why) {
  for (const task of tasks.values()) {
    if (task.agent === agent && task.column === 'blocked') {
      move(task, STATUS_TO_COLUMN[task.status] ?? 'backlog', at, why)
    }
  }
}

/** TaskUpdate itself failed: that one task is Blocked whatever its column. */
export function blockTask(id, at, why) {
  const task = tasks.get(`task:${id}`)
  if (task !== undefined && task.column !== 'done') move(task, 'blocked', at, why)
}

export function nameAgent(agentId, label) {
  if (agents.get(agentId) === label) return
  agents.set(agentId, label)
  version += 1
}

/** /board-clear: drop Done tasks. Returns how many went. */
export function clearDone() {
  let removed = 0
  for (const [key, task] of tasks) {
    if (task.column === 'done') {
      tasks.delete(key)
      removed += 1
    }
  }
  if (removed > 0) version += 1
  return removed
}

// ---- persistence shape ----------------------------------------------------

export function snapshot(sessionId, savedAt) {
  // Only the labels of agents that still have a card.
  const used = new Set(agentIds())
  const named = [...agents].filter(([id]) => used.has(id))
  return { version: 1, sessionId, savedAt, agents: Object.fromEntries(named), tasks: allTasks() }
}

const isMove = m => typeof m?.at === 'number' && typeof m.to === 'string' && typeof m.why === 'string'

/** A task read from a file, checked field by field; null when it cannot be drawn. */
export function checkedTask(task) {
  if (typeof task?.key !== 'string' || !COLUMN_IDS.has(task.column)) return null
  if (typeof task.title !== 'string' || typeof task.agent !== 'string' || typeof task.since !== 'number') return null
  const activity =
    task.activity && typeof task.activity.tool === 'string' && typeof task.activity.at === 'number'
      ? { tool: task.activity.tool, at: task.activity.at, target: typeof task.activity.target === 'string' ? task.activity.target : undefined, isError: task.activity.isError === true || undefined }
      : null
  return {
    key: task.key,
    title: clean(task.title) || '(untitled)',
    column: task.column,
    status: STATUS_TO_COLUMN[task.status] ? task.status : 'pending',
    since: task.since,
    agent: task.agent,
    owner: typeof task.owner === 'string' ? clean(task.owner) : undefined,
    source: task.source === 'task' || task.source === 'plan' ? task.source : 'todo',
    planId: typeof task.planId === 'number' ? task.planId : undefined,
    planIndex: typeof task.planIndex === 'number' ? task.planIndex : undefined,
    activity,
    history: Array.isArray(task.history) ? task.history.filter(isMove).slice(-MAX_HISTORY) : [],
  }
}

export function checkedAgents(data) {
  const out = {}
  for (const [id, label] of Object.entries(data && typeof data === 'object' ? data : {})) {
    if (typeof label === 'string') out[id] = clean(label)
  }
  return out
}

export function restore(data) {
  if (data?.version !== 1 || !Array.isArray(data.tasks)) return false
  tasks = new Map()
  for (const raw of data.tasks.slice(-MAX_TASKS)) {
    const task = checkedTask(raw)
    if (task !== null) tasks.set(task.key, task)
  }
  agents = new Map(Object.entries(checkedAgents(data.agents)))
  version += 1
  return true
}
