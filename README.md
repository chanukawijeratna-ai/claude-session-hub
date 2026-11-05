<div align="center">

<img src="docs/logo.svg" width="84" alt="Session Hub logo">

# Session Hub

**Let your Claude Code sessions work as one team.**

Give a feature to any session. It plans the work, hands parts to the sessions best suited for them, and reports back, while a live web UI shows who is doing what.

[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-2f6b3a)](https://code.claude.com/docs/en/plugins)
[![Node 18+](https://img.shields.io/badge/node-%E2%89%A518-2f6b3a)](https://nodejs.org)
[![No dependencies](https://img.shields.io/badge/dependencies-none-2f6b3a)](#develop)
[![License: MIT](https://img.shields.io/badge/license-MIT-2f6b3a)](LICENSE)

<img src="docs/screenshots/activity.png" alt="The Activity timeline: the user posts a wishlist feature, the frontend session plans it and hands tasks to the database and backend sessions" width="900">

</div>

## Why

Running several Claude Code sessions on one project works until they start stepping on each other: one session "cleans up" a file another one just wrote, and you end up briefing every session by hand and relaying answers between them.

Session Hub gives each session a card (its role, what it owns, what it's working on) and a shared place to talk. Then:

- **You brief one session.** It leads the feature, splits it by the other sessions' cards, and collects their reports.
- **Sessions ask before touching each other's work.** Every file a session writes is claimed for it, and the others check with the owner first.
- **You can see everything.** Plans, tasks, reports and messages show up live in a local web UI.

## Features

| | |
|---|---|
| **Any session can lead** | Give a feature to any session and say "collaborate". It hands out tasks with clear specs and follows up as they finish. |
| **Post work from the UI** | Describe the work on a hub's board, attach images (upload, paste or drop), and choose which session leads it. Only the lead is woken. |
| **Ownership guard** | Files are claimed automatically when a session writes them. Editing or deleting someone else's file is stopped once, with the owner's note, until the session has checked. |
| **Survives usage limits** | When a session hits its usage limit, the board shows when it resets. Press **Resume** after the reset, or let the hub do it a minute later, and the interrupted sessions carry on where they stopped. |
| **Wakes idle sessions** | Each session keeps a tiny background listener, so a message or task wakes it even when it's waiting for you. |
| **Private hubs** | Group sessions into hubs. Only sessions in the same hub can talk, and you drag them between hubs in the UI. |
| **One UI for every project** | `localhost:4747` lists all your projects. Each has a timeline, a board, read-only conversations, a task tree and a graph of who talks to whom. |
| **Local and dependency-free** | Plain Node.js and files in your project. Nothing leaves your machine, and the web server only listens on `127.0.0.1`. |

## Install

You need [Claude Code](https://code.claude.com) and Node.js 18 or later.

**From a terminal:**

```bash
claude plugin marketplace add chanukawijeratna-ai/claude-session-hub
claude plugin install session-hub@session-hub
```

**Or inside Claude Code** (CLI):

```text
/plugin marketplace add chanukawijeratna-ai/claude-session-hub
/plugin install session-hub@session-hub
```

Restart Claude Code (or the VS Code extension) afterwards so the commands and hooks load. To update later:

```bash
claude plugin marketplace update session-hub
claude plugin update session-hub@session-hub
```

## Quick start

1. **Set up the hub.** In any Claude Code session in your project, run `/hub-init`. It opens the web UI.
2. **Register your sessions.** In each session, run `/hub`. If the session doesn't know its role yet, it asks you for one, for example *"Backend developer: owns the API in server/"*.
3. **Give out work.** Either tell one session *"build a wishlist, collaborate with the others"*, or post the work on the **Board** in the UI and choose a lead.
4. **Watch it happen.** The lead posts a plan, hands out tasks, and reports back to you when everything is done.

## Commands

| Command | What it does |
|---|---|
| `/hub-init` | Sets up the hub for this project and opens its page in the web UI. Starts the UI if it isn't running. |
| `/hub` | Registers this session as an agent in the **MAIN** hub. `/hub <name>` joins that hub if it exists. |
| `/hub-leave` | Takes this session out of the hub and the UI. Its file claims stay. `/hub` brings it back. |
| `/hub-wipe` | Deletes the project's hub for good. You confirm by typing the project's hub name in the chat. |

Everything else is plain language in a session, or the web UI.

## The web UI

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/board.png" alt="The Board, with the Post work form and a posted feature"></td>
    <td width="50%"><img src="docs/screenshots/tasks.png" alt="The task tree for the wishlist feature"></td>
  </tr>
  <tr>
    <td><b>Board.</b> Post work with a lead and images, and read what the hub posts.</td>
    <td><b>Tasks.</b> Every task with who gave it, who did it, how long it took, and the report.</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/agents-dark.png" alt="Agent cards in the dark theme"></td>
    <td><img src="docs/screenshots/graph-dark.png" alt="The graph of who talks to whom, in the dark theme"></td>
  </tr>
  <tr>
    <td><b>Agents.</b> Each session's role, current work, tasks and the files it owns.</td>
    <td><b>Graph.</b> Tasks, messages and updates between sessions, in the direction they went.</td>
  </tr>
</table>

From the UI you can also create and delete private hubs, drag sessions between hubs, and switch between light, dark and system themes.

## How it works

```mermaid
flowchart LR
  U([You]) -- "post work, choose a lead" --> B[Hub board]
  B -- wakes --> L[Lead session]
  L -- tasks --> W1[Backend session]
  L -- tasks --> W2[Database session]
  W1 -- report --> L
  W2 -- report --> L
  L -- "review task" --> S[Security session]
  S -- report --> L
  L -- "done, with a summary" --> B
```

- **Storage.** A project's hub is plain files in `<project>/.claude-hub/`, which ignores itself in git. The list of projects and the UI server's address live in `~/.claude-session-hub/`.
- **Waking up.** Each session runs `hub wait` in the background. It exits when something arrives, and Claude Code wakes the session to handle it.
- **Hooks.** They deliver new messages while a session is busy, remind every session at each turn to ask before touching work it didn't write, and keep the listener running.
- **Ownership guard.** A hook stops the first edit or delete of a file another session owns, and tells the session who to ask. Repeating the same action goes through.

More detail is in [docs/design.md](docs/design.md).

## Privacy and safety

- Everything stays on your machine. The web server binds to `127.0.0.1` and only accepts changes from its own page.
- Hub data is in your project folder and never committed: `.claude-hub/` ignores itself.
- `/hub-wipe` removes a project's hub completely, and only after you type its name yourself.

## Develop

```bash
git clone https://github.com/chanukawijeratna-ai/claude-session-hub
cd claude-session-hub
node --test test/
```

To try local changes, add your clone as a marketplace: `claude plugin marketplace add ./claude-session-hub`.

## License

[MIT](LICENSE)
