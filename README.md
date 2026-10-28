# Ask — a Paseo plugin

A floating window for quick questions, answered by Claude on the daemon.

Open it from the "Ask" button in the workspace header (also in a new-agent draft) or in an agent's composer. Follow-ups stay in the same thread. Tool calls show up as they happen, like in the main chat; while Claude works there is a Stop button, and sending follows Paseo's own setting (steer, queue or interrupt) and keys (Enter / Cmd+Enter), like the main composer. The Ask button spins while answering and shows a dot when an answer is ready. On phones it opens full screen; on desktop it can be moved and resized, and you can paste images or attach files. Select text anywhere in Paseo for a small Ask button that quotes it; click an attached image to view it full size.

![Ask open over the main window, with a tool call](assets/screenshot-overlay.png)

![The Ask buttons, outlined: workspace header and agent composer](assets/screenshot-buttons.png)

![The Ask button at the end of a text selection, outlined](assets/screenshot-selection.png)

**Runs with full access.** Each thread runs `claude -p --permission-mode bypassPermissions` (one process, kept 15 minutes after the last answer) in your home directory on the daemon, with your Claude Code settings, skills and MCP servers: it can read and change files and run commands without asking. Questions, the thread and anything Claude reads go to Anthropic through your Claude Code login.

## Install

Requires Paseo 0.13.0 or later, and the `claude` CLI installed and logged in on the daemon machine.

```bash
paseo plugin install https://github.com/puchkoff/paseo-ask
```

Or from a local clone: `paseo plugin install ./paseo-ask`. Check with `paseo plugin ls`.

## Develop

```bash
npm install
npm run typecheck
npm test
```

The in-app description shown by Paseo lives in [OVERVIEW.md](OVERVIEW.md).
