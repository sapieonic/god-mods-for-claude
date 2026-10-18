// One small JSON file per session under ~/.claude/taskboard/, written through
// `$.fs` a moment after the last change so a burst of tool calls is one write.
// Nothing leaves the machine.

import { changes, checkedAgents, checkedTask, restore, snapshot } from './board.js'

const SAVE_DELAY_MS = 500
// Boards older than this are not shown under "Other sessions" ($.fs has no delete).
const OTHERS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

let dir = null
let sessionId = null
let pending = null
let savedVersion = -1

export const boardDir = () => dir

export async function init($, id) {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  sessionId = id
  savedVersion = -1
  pending?.cancel()
  pending = null
  dir = home ? `${home.replace(/[\\/]+$/, '')}/.claude/taskboard` : null
}

const fileOf = id => `${dir}/${id}.json`

/** Loads this session's board (a resumed session, or a reload of the mod). */
export async function load($) {
  if (dir === null || sessionId === null) return false
  try {
    if (!(await $.fs.exists(fileOf(sessionId)))) return false
    const ok = restore(JSON.parse(await $.fs.read(fileOf(sessionId))))
    savedVersion = changes()
    return ok
  } catch {
    return false
  }
}

/** Queues a save; never awaited by a tool-call hook. */
export function scheduleSave($) {
  if (dir === null || pending !== null || changes() === savedVersion) return
  pending = $.clock.after(SAVE_DELAY_MS, () => {
    pending = null
    void saveNow($)
  })
}

export async function saveNow($) {
  pending?.cancel()
  pending = null
  if (dir === null || changes() === savedVersion) return
  const at = changes()
  try {
    // Date.now(), the same clock the task times use (see register.js).
    await $.fs.write(fileOf(sessionId), JSON.stringify(snapshot(sessionId, Date.now())))
    savedVersion = at
  } catch {
    // A read-only home or a full disk costs the history, never the session.
  }
}

/**
 * The other sessions' boards, newest first, for the "Other sessions" tab.
 * Read only when that tab is shown.
 */
export async function readOthers($, limit = 5) {
  if (dir === null) return []
  try {
    const cutoff = Date.now() - OTHERS_MAX_AGE_MS
    const entries = (await $.fs.list(dir))
      .filter(one => one.kind === 'file' && one.name.endsWith('.json') && one.name !== `${sessionId}.json` && one.mtimeMs >= cutoff)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit)
    const boards = []
    for (const entry of entries) {
      try {
        const data = JSON.parse(await $.fs.read(`${dir}/${entry.name}`))
        if (data?.version !== 1 || !Array.isArray(data.tasks)) continue
        const tasks = data.tasks.map(checkedTask).filter(Boolean)
        if (tasks.length === 0) continue
        boards.push({
          sessionId: typeof data.sessionId === 'string' ? data.sessionId : entry.name.replace(/\.json$/, ''),
          savedAt: typeof data.savedAt === 'number' ? data.savedAt : entry.mtimeMs,
          agents: checkedAgents(data.agents),
          tasks,
        })
      } catch {
        // A file another session is halfway through writing: skip it this time.
      }
    }
    return boards
  } catch {
    return []
  }
}
