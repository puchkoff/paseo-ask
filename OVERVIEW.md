Adds an "Ask" row to the sidebar footer. It opens a floating window (a bottom sheet on phones) where you type a question and get an answer, with follow-ups in the same thread.

Answers come from the Claude Code CLI (`claude -p`) on the daemon machine, so `claude` must be installed and logged in there. The model gets the conversation text only: no tools, MCP servers, project settings or saved session. The thread lives in the app until you press Clear or reload.
