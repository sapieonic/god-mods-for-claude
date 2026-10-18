# taskboard

A Claude Code mod that shows the agent's tasks as a Kanban board in a pane beside the transcript. Cards move between **Backlog → In Progress → Blocked → Done** by themselves as the agent works.

## What it does

- **Tracks tasks** from `TodoWrite` and the task tools (`TaskCreate`, `TaskUpdate`, `TaskList`):
  `pending` → Backlog, `in_progress` → In Progress, `completed` → Done (`deleted` removes the card).
- **In the Claude desktop app** too, where the agent keeps its plan with the app's own task list
  (`mcp__ccd_turn__update_plan`) instead of `TodoWrite`: each step is a card, `advance`, `done` and `start`
  move them, and the closing `mcp__ccd_turn__wrap_up` moves the step in progress to Done.
- **Blocked**: when a tool call errors or is denied, the In Progress cards of that agent's loop move to
  Blocked. An interrupted turn (Esc) or one an API error ends does the same. The next call in that loop
  that succeeds moves them back, and so does a new status from the agent.
- **Cards** show the title, how long the card has been in its column, the latest tool activity
  (`Edit`, `Bash`, `✗ Edit` when it failed) and, for a subagent, its type and a short id (`Explore ag-1`).
  A task tool card follows the loop that last set it `in_progress`.
- **Tabs**: All · Main · one per subagent · Other sessions (the boards other sessions saved in the last
  7 days, read-only, refreshed every 10 s while the tab is open).
- **History**: select a card to see each move with its time and reason.
- **Persists** to `~/.claude/taskboard/<session-id>.json`, so a resumed session or a reloaded mod keeps
  its board. `/clear` and an in-session `/resume` start the new conversation's own board. Boards from
  earlier sessions appear under *Other sessions*.

## Commands

Both are registered `immediate`, so they run even while Claude is working.

| Command | Does |
| --- | --- |
| `/board` | Toggles the pane. Where no pane can be drawn (`claude -p`, a surface that places no pane), it answers with a plain-text board. |
| `/board text` | Prints the plain-text board. |
| `/board-clear` | Removes the Done cards. The pane has a **Clear done** button too. |

The pane opens on its own with the first task only in the terminal's fullscreen layout, where it docks as a
sidebar. Everywhere else, run `/board`, so the board never takes room above the prompt unasked.

## Privacy

Everything stays local, and there is no telemetry. By default the board file holds task titles, statuses,
tool names, timestamps, the move reasons in each card's history (such as `Edit failed`), subagent types with
a short agent id, and a task tool's `owner` (a teammate name) when one is set. It never holds tool inputs or
outputs: no commands, no file contents, no task descriptions.

## Options

Both are off by default. With either one on, what it adds is saved in the board file too.

| Option | Adds |
| --- | --- |
| `showFilePaths` | The file a `Read`, `Edit`, `Write` or `NotebookEdit` touched, as in `Edit src/app.ts` |
| `showAgentTasks` | A subagent's short task description (the Agent call's `description`), as in `Explore ag-1: find callers` |

To set them, run `/plugin configure taskboard@god-mods-for-claude` in a terminal session, or pass
`--config showFilePaths=true` to `claude plugin install`. A `--plugin-dir` copy reads them from
`pluginConfigs` in settings, under `taskboard@inline`.

## The mod never gets in the way

Every hook passes its event on with `next(e)` unchanged and returns the result exactly as it came back. The
board updates synchronously after the call, timed with `Date.now()` rather than a `$` call, and is saved
half a second later on a timer, so no tool call waits on it. Each hook also has a `.catch` that passes the
event through, so a bug in the mod cannot block anything. A broken board file is read field by field, and
the pane and commands fall back to a one-line message rather than failing.

## Try it

```bash
claude --plugin-dir ~/Sapionic/god-mods-for-claude/mods/taskboard
```

Then run `/reload-plugins` after an edit, and `/plugin` to see `taskboard` listed as an active mod.

## Install permanently (local marketplace)

The repository root, `god-mods-for-claude/`, is a marketplace: its `.claude-plugin/marketplace.json` lists
this mod at `./mods/taskboard`. A folder marketplace with a relative source is read from the folder
itself, so edits reach every session on `/reload-plugins`, with no reinstall.

```bash
claude plugin marketplace add ~/Sapionic/god-mods-for-claude
claude plugin install taskboard@god-mods-for-claude
```

After editing the folder, run `/reload-plugins`. In the session that is also loading the folder through
`--plugin-dir` or hot reload, `/plugin` → Errors may show that one of the two copies was not loaded. That
is expected: one plugin name loads one hooks module.

## Develop

```bash
claude plugin validate .
claude plugin test .
```

Layout: `hooks/register.js` holds the hooks, `hooks/board.js` the state and column mapping,
`hooks/view.js` the pane and text views, and `hooks/persist.js` the JSON file. Tests are in `test/`.

## Limitations

- Which call blocked a card is inferred: with parallel tool calls, a failure can be undone at once by a
  sibling call that succeeded, so a short failure may never show as Blocked.
- Interrupting the main turn blocks every loop's in-progress cards, background subagents' included. Their
  next successful call moves them back.
- A subagent that finishes without marking its todos completed leaves them In Progress.
- Two todos with the same text in one loop are one card.
- A hot reload of the mod loses at most the last half second of changes, since the pending save is dropped
  with the old module.
- Old board files are not deleted (the mod API has no delete). *Other sessions* ignores files older than
  7 days; remove `~/.claude/taskboard/` by hand to reclaim the space.

- A todo is identified by its text within its loop. If the agent rewords a todo, it shows up as a new card.
- Todos the agent drops from its list stay on the board until `/board-clear` (when Done) or a restart.
- Blocked is an inference: any failing call in a loop blocks that loop's in-progress cards, even when the
  failure was unrelated (for example, a `grep` that found nothing and exited 1).
- Parallel sessions each keep their own file. *Other sessions* shows them read-only, refreshed every 10 seconds.
- Tasks created before the mod loaded show up once a `TaskUpdate` or `TaskList` mentions them.
