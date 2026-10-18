# god-mods-for-claude

A single home for all my Claude-specific customizations: plugins, mods, skills, hooks, slash commands, agents, MCP configs, and anything else that extends or changes how Claude (Claude Code) behaves.

## What belongs here

- **Plugins**: packaged Claude Code plugins
- **Mods**: changes to Claude's interface or behavior (panes, status lines, toasts, hooks modules)
- **Skills**: reusable instruction sets
- **Slash commands and agents**: custom commands and subagent definitions
- **Hooks**: scripts that run on tool calls, prompts, and other events
- **MCP configs**: server definitions and related setup
- **Settings and snippets**: useful `settings.json` fragments, prompts, and notes

## Suggested layout

```
god-mods-for-claude/
├── .claude-plugin/marketplace.json   # lists every installable plugin and mod
├── plugins/    # one folder per plugin
├── mods/       # one folder per mod
├── skills/     # one folder per skill
├── commands/   # slash commands
├── agents/     # subagent definitions
├── hooks/      # hook scripts
└── mcp/        # MCP server configs
```

Each item should live in its own folder with a short README describing what it does and how to install or enable it.

## What's here

| Name | Kind | What it does |
| --- | --- | --- |
| [taskboard](mods/taskboard/README.md) | mod | A live Kanban board of the agent's tasks in a pane beside the transcript |
| [token-weather](mods/token-weather/README.md) | mod | A live forecast of the context window above the prompt. Copied from [anthropics/claude-code-playground](https://github.com/anthropics/claude-code-playground) (Apache-2.0, see its `UPSTREAM.md`) |

## Install

The repo is a Claude Code **marketplace**: `.claude-plugin/marketplace.json` lists each plugin and mod by
name. Installing takes two steps: add the marketplace once, then install items from it by
`<name>@god-mods-for-claude`.

### Where it applies: the three scopes

| Scope | Applies to | Written to | Shared through git? |
| --- | --- | --- | --- |
| `user` (default) | You, in every project | `~/.claude/settings.json` | No |
| `project` | Everyone who opens this project | `<project>/.claude/settings.json` | Yes, commit it |
| `local` | You, in this project only | `<project>/.claude/settings.local.json` | No (gitignored) |

### Globally, for yourself (user scope)

From any shell:

```bash
claude plugin marketplace add sapieonic/god-mods-for-claude
claude plugin install taskboard@god-mods-for-claude
```

To work on the mods from your own clone instead, add the folder. A folder marketplace is read from the
folder itself, so an edit reaches your sessions with `/reload-plugins`, with no reinstall:

```bash
claude plugin marketplace add ~/Sapionic/god-mods-for-claude
claude plugin install taskboard@god-mods-for-claude
```

A GitHub marketplace runs the copy made at install time instead. Pick up new commits with:

```bash
claude plugin marketplace update god-mods-for-claude
claude plugin update taskboard@god-mods-for-claude
```

### For one project, shared with the team (project scope)

Run these inside the project:

```bash
claude plugin marketplace add sapieonic/god-mods-for-claude --scope project
claude plugin install taskboard@god-mods-for-claude --scope project
```

This writes `.claude/settings.json`. Commit it. Its two keys look like this:

```json
{
  "extraKnownMarketplaces": {
    "god-mods-for-claude": {
      "source": { "source": "github", "repo": "sapieonic/god-mods-for-claude" }
    }
  },
  "enabledPlugins": {
    "taskboard@god-mods-for-claude": true
  }
}
```

Once a teammate accepts the workspace trust dialog for the project, Claude Code registers the marketplace
for them; in an untrusted folder, including a `claude -p` run there, it ignores both keys. If the mod shows
as not installed, each teammate installs it once with the same `claude plugin install ... --scope project`
line, or from `/plugin`. To opt out on your own machine, set it to `false` under `enabledPlugins` in
`.claude/settings.local.json`; a `false` in your user settings does not override the project's `true`.

Use the GitHub source here, not a folder path: a path like `~/Sapionic/...` only exists on your machine.
A private repo installs only for people who can read it and already have a git credential for github.com
(an SSH key, or `gh auth login` then `gh auth setup-git`).

### For one project, just for you (local scope)

Run these inside the project:

```bash
claude plugin marketplace add ~/Sapionic/god-mods-for-claude --scope local
claude plugin install taskboard@god-mods-for-claude --scope local
```

This writes `.claude/settings.local.json`, which is not committed, so a folder path is fine here.

### For one session only (no install)

Load a mod straight from its folder. In an interactive session, saving a file reloads it:

```bash
claude --plugin-dir ~/Sapionic/god-mods-for-claude/mods/taskboard
```

Where no flag can be passed (the desktop app, an SDK host), list the folders in `CLAUDE_CODE_PLUGIN_DIRS`,
either in the environment or in the `env` block of `~/.claude/settings.json`. Separate several folders
with `:`, or `;` on Windows.

### Inside Claude Code and the desktop app

- **In a terminal session:** run `/plugin`, then add the marketplace and install from its tabs, or type
  `/plugin install taskboard --marketplace sapieonic/god-mods-for-claude`.
- **In the desktop app,** where `/plugin` does not run: click **+** next to the prompt box, then
  **Plugins**, **Add marketplace** with `sapieonic/god-mods-for-claude`, then **Add plugin**.

### Options, checks and removal

```bash
claude plugin configure taskboard@god-mods-for-claude
```

shows a mod's options and which are unset. Inside a session, `/plugin configure taskboard@god-mods-for-claude`
sets them, or pass `--config key=value` to `claude plugin install`.

To confirm a mod loaded, run `/plugin` in a session: it lists active mods under its tabs, and anything
that failed under **Errors**. `claude plugin list` shows each install's scope and the folder it is read
from.

To remove or pause one, use the same `--scope` you installed with:

```bash
claude plugin disable taskboard@god-mods-for-claude --scope project
claude plugin uninstall taskboard@god-mods-for-claude --scope project
claude plugin marketplace remove god-mods-for-claude
```

### Adding a new item

1. Put it in its own folder under the matching directory (`mods/<name>/`, `plugins/<name>/`), with its own
   `.claude-plugin/plugin.json` and README.
2. Add an entry to `.claude-plugin/marketplace.json`:
   `{ "name": "<name>", "source": "./mods/<name>", "description": "..." }`.
3. Run `claude plugin validate .` from the repo root, which checks the marketplace and every entry it lists.
4. Add a row to the *What's here* table.

Skills, commands, agents and hooks that are not packaged as a plugin can still be copied or symlinked into
`~/.claude/` (user level) or `<project>/.claude/` (project level).

## Status

Personal collection. Contents will grow over time.
