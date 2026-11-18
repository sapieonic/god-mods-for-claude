# token-speedo

A Claude Code mod that shows how fast tokens are being produced, in the strip above the prompt.

## What it shows

- **The strip above the prompt:** a small gauge, the speed in tokens per second, then the peak speed, the
  cache hit rate, the last step's output, the steps in this turn and the session's total tokens. It appears
  after the first reply of a session. The terminal gets the same line as text.
- **The needle:** while a reply streams, a live estimate (about 4 characters per token). When each model
  request ends, the exact speed from the API's own token count.
- **Details:** a button at the end of the strip opens a pane beside the chat with a large gauge, cache read
  and written, time to first token, the turn's average speed, bars for the last 12 steps, and the session's
  tokens, context fill, cost and model.
- Subagents count too: while several replies stream at once, the needle shows their combined speed.

## Commands

| Command | Does |
| --- | --- |
| `/speedo` | Hides the speedometer, or brings it back. Hidden stays hidden in later sessions. |

## Install

```bash
claude plugin install token-speedo@god-mods-for-claude
```

## Tests

```bash
claude plugin test mods/token-speedo
```
