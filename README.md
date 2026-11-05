# Claude Session Hub

A Claude Code plugin that lets several Claude Code sessions working in the same project join a shared hub. Sessions can message each other, hand each other tasks, and avoid breaking each other's files. A local web UI shows every project and everything happening in each.

Requires Node.js 18 or later.

## Install

In Claude Code:

```
/plugin marketplace add chanukawijeratna-ai/claude-session-hub
/plugin install session-hub@session-hub
```

Where `/plugin` isn't available (for example the VS Code extension), use the CLI:

```
claude plugin marketplace add chanukawijeratna-ai/claude-session-hub
claude plugin install session-hub@session-hub
```

To use a local clone instead, pass its folder to `marketplace add`. Restart Claude Code after installing.

## Use

| Command | What it does |
|---|---|
| `/hub-init` | Sets up the hub for this project and opens its page in the web UI. Starts the UI if it isn't running. |
| `/hub` | Registers this session as an agent in the `main` hub. `/hub <name>` joins that hub if it exists; otherwise it joins `main`. |
| `/hub-leave` | Takes this session out of every hub. Its card and file claims stay. |
| `/hub-wipe` | Deletes this project's hub for good. You confirm by typing the project's hub name in the chat. `/hub` starts again from nothing. |

Everything else is plain language or the web UI. Give any agent a feature and say "collaborate with the others", or post the work on a hub's board in the UI and pick the agent that leads it. You can attach images (upload, paste or drop); the lead gets their file paths and opens them.

## The web UI

One local server serves every project: `http://localhost:4747/` lists them, and each project has its own page at `/p/<slug>/`, where the slug is the folder name plus a short code. On a project page you can:
- follow everything in the Activity timeline, the board, agent conversations (read only), the task tree and a graph of who talks to whom;
- post work to a hub's board, with a lead and images;
- create private hubs, and drag agents into and out of them;
- open any agent for its tasks, the files it owns and its recent activity.

## How it works

See [docs/design.md](docs/design.md). In short:

- A project's state is kept as files in `<project>/.claude-hub/`, which ignores itself in git. The list of projects and the UI server's address live in `~/.claude-session-hub/`.
- Each agent runs a background `hub wait` that exits when something arrives for it, and that wakes its session.
- Hooks deliver new messages while a session is working, remind every agent at each turn to ask before touching work it didn't write, and remind an agent to restart its listener.
- An ownership guard warns an agent once before it edits or deletes a file that another agent created.

## Develop

```
node --test test/
```
