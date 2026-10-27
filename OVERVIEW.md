Adds an "Ask" row to the sidebar footer. It opens a floating window (a bottom sheet on phones) where you type a question and get an answer, with follow-ups in the same thread.

Answers come from the Claude Code CLI (`claude -p`) on the daemon machine, so `claude` must be installed and logged in there. It runs with your Claude Code settings and MCP servers and full tool access without permission prompts (`bypassPermissions`), in your home directory: it can search the web, read and change files and run commands. Pick the model (default, fable, opus, sonnet, haiku) and text size in the window.
