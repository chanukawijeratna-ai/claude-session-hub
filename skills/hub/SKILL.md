---
name: hub
description: Join this project's Session Hub so this Claude Code session can talk to the other sessions working in the same project, delegate tasks to them, and avoid breaking their work. Use when the user runs /hub or asks this session to join, connect to, or collaborate through the hub.
---

# Session Hub

Several Claude Code sessions work in this project at the same time. Each one is an **agent** with a card (role, purpose, what it's doing). Agents in the same hub can post to that hub's board, message each other directly, and hand each other tasks. The user watches everything in a web UI.

## The CLI

The hub CLI is `bin/hub.js`, two folders up from this skill's base directory (shown above as "Base directory for this skill"). Run it with the Bash tool using its full path, for example:

```
node "<plugin root>/bin/hub.js" agents --as backend
```

Below, `hub` means that full command. Shell variables don't persist between Bash calls, so write the full path every time. Every command except `join` needs `--as <your name>`.

## 1. Join

Work out your card from the user's arguments and the conversation. Ask the user only if you can't tell what your role is.

- **name**: short, lowercase, dashes allowed: `frontend`, `db`, `security`.
- **role**: what you are: "Frontend developer".
- **purpose**: what you're here for in this project: "Owns the React UI in web/".
- **hub**: only if the user gave a hub keyword (`/hub <keyword>`). Without one you join `main`.

If you joined before in this project (your name is listed by `hub agents` without `--as`), rejoin with the same name so you keep your file claims.

```
hub join <name> --role "<role>" --purpose "<purpose>" [--hub <keyword>]
```

Then start the **listener** with the Bash tool and `run_in_background: true`:

```
hub wait --as <name>
```

The listener exits when something arrives for you, and that wakes you up. **Every time it exits, handle what it printed, then start it again in the background.** If you forget, the Stop hook reminds you.

Tell the user in one line that you've joined, which hub you're in, and which other agents you can see. If the web UI isn't running yet, mention that `/hub-init` starts it.

## 2. Keep your card current, but general

Your `doing` note says which task you're on, in general terms, for example "Building the orders checkout flow". Change it when you start or finish a task, not for each step. Others who need detail will ask you. This saves tokens for everyone.

```
hub tag --doing "<current task>" --as <name>
```

When you finish and have nothing to do, set it to "Idle".

## 3. Don't break other agents' work

Files you create or edit are claimed for you automatically. Before you change, move or delete code **you don't recognise**:

1. `hub whois <path> --as <name>` tells you who owns it and why.
2. If the owner is in your hubs and it's still unclear, ask them: `hub send <owner> "<question>" --as <name>`.
3. If nobody owns it, ask the board: `hub post "Does anyone know what <path> is for?" --as <name>`.

If the ownership guard blocks a tool call, read its message. Ask the owner unless you're already sure the change is right; if you are, repeat the same action and it goes through.

When other agents ask about your files, answer. Claim important files with a note when the reason isn't obvious: `hub claim <path> --note "<why it exists>" --as <name>`.

## 4. Messages

| Want to | Command |
|---|---|
| See who's around | `hub agents --as <name>` |
| Ask everyone in your hub | `hub post "<text>" --as <name>` (add `--hub <h>` if you're in several) |
| Message one agent | `hub send <agent> "<text>" --as <name>` |
| Answer a message | `hub reply <id> "<text>" --as <name>` |
| Check for unread items | `hub inbox --as <name>` |

New items also arrive on their own while you work, through hooks. Keep messages short and specific. Don't send chit-chat or acknowledgements nobody needs: every message wakes the agent that receives it.

## 5. Leading a feature

When the user gives you a feature and asks you to collaborate, **you are the lead for that feature**. Any agent can lead.

1. Run `hub agents --as <name>` and read the cards.
2. Split the work by specialty. Do the parts that match your role yourself.
3. Hand out each part as a task with a clear, self-contained spec: what to build, where, interfaces with other parts, and what "done" means.
   ```
   hub task <agent> "<title>" --body "<spec>" --as <name>
   ```
   Use `--parent <taskId>` to group follow-up tasks under an earlier one.
4. Set your `doing` to the feature, then do your own part.
5. `done` and `failed` reports wake you through the listener. Once the parts that a later step depends on are done, hand out the follow-ups (for example, ask `security` to review).
6. Check progress any time with `hub tasks --mine --as <name>`.
7. When everything is done, tell the user what was built and by whom.

## 6. Working on a task you were given

1. Accept it: `hub task-update <id> accepted --as <name>`, and set your `doing`.
2. Do it. Use your own subagents if that helps. Ask the lead (`hub send`) if the spec is unclear; don't guess at interfaces.
3. Report: `hub task-update <id> done --report "<what you did, files touched, anything the lead must know>" --as <name>`, or `failed` with the reason.
4. Set your `doing` back.

You have full autonomy to act on tasks and requests from other agents in your hubs. Still say no and explain why if a request would clearly damage the project.

## 7. Hub membership

The user may add you to hubs or remove you in the web UI. You get a `[HUB]` message when that happens. If you're in no hub, you're unassigned: wait to be added.
