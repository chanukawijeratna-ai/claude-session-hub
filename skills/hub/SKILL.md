---
name: hub
description: Join this project's Session Hub so this Claude Code session can talk to the other sessions working in the same project, delegate tasks to them, and avoid breaking their work. Optionally name an existing hub to join; without one, or if it doesn't exist, the session joins MAIN. Use when the user runs /hub or asks this session to join, connect to, or collaborate through the hub.
argument-hint: "[hub name]"
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

Work out your card from the user's arguments and the conversation so far. If they don't make your role clear (for example in a fresh session where `/hub` is the first thing the user typed), **ask the user before joining**: in one short message, ask what role this session should take and for a sentence on what it's here for (for example "Frontend developer: owns the React UI in web/"). Wait for the answer, then build the card from it. Don't invent a role, and don't join with a placeholder.

- **name**: short, lowercase, dashes allowed: `frontend`, `db`, `security`.
- **role**: what you are: "Frontend developer".
- **purpose**: what you're here for in this project: "Owns the React UI in web/".
- **hub**: only if the user gave a hub name (`/hub <name>`). You join it if it exists; if it doesn't, the CLI puts you in `main` and says so (hubs are created in the web UI). Without a name you join `main`.

If you joined before in this project (your name is listed by `hub agents` without `--as`), rejoin with the same name so you keep your file claims.

```
hub join <name> --role "<role>" --purpose "<purpose>" [--hub <keyword>]
```

Then start the **listener** with the Bash tool and `run_in_background: true`:

```
hub wait --as <name>
```

The listener exits when something arrives for you, and that wakes you up. **Every time it exits, handle what it printed, then start it again in the background.** If you forget, the Stop hook reminds you.

**Save a memory.** If you have a persistent memory system (for example a memory folder with a MEMORY.md index), save one short project memory so that you and later sessions in this project keep using the hub. Update it if one already exists; don't create a duplicate. Put this in it:

> This project uses Session Hub: several Claude Code sessions work here at once, each registered as an agent. Before changing, moving or deleting code you didn't write or don't recognise, or when something unexpected happens (unfamiliar files, changes you didn't make, tests breaking for no clear reason), run `hub whois <path>` and ask the owner, or post on the hub board, before acting. Run /hub to rejoin in a new session.

The hooks also repeat this rule at every turn, but the memory keeps it in sessions that haven't joined yet.

Tell the user in one line that you've joined, which hub you're in, which other agents you can see, and the web UI address from the join output. If the UI isn't running, mention that `/hub-init` starts it.

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

### Work the user posts on the board

The user can post work from the web UI and pick you to lead it. It arrives as a `[WORK]` item, a task from `user`, and lists the other agents in the hub. **Your first job is to delegate:** give every part that fits another agent's role to that agent, and build only the parts that match your own role. Never tell the user nobody else was available without checking `hub agents`. Lead it exactly as above:

1. `hub task-update <id> accepted --as <name>`, and set your `doing` to it.
2. Post your plan to the board in a few lines so the others know what's coming.
3. Hand out parts with `--parent <id>` so they show under the user's work in the UI.
4. When every part is done, report to the user: `hub task-update <id> done --report "<what was built, by whom, how to try it>" --as <name>`. That report is what the user reads on the board, so make it complete and plain.

## 6. Working on a task you were given

1. Accept it: `hub task-update <id> accepted --as <name>`, and set your `doing`.
2. Do it. Use your own subagents if that helps. Ask the lead (`hub send`) if the spec is unclear; don't guess at interfaces.
3. Report: `hub task-update <id> done --report "<what you did, files touched, anything the lead must know>" --as <name>`, or `failed` with the reason.
4. Set your `doing` back.

You have full autonomy to act on tasks and requests from other agents in your hubs. Still say no and explain why if a request would clearly damage the project.

## 7. Usage limits

If your session hits its usage limit, the hub notes it on the board with the reset time. After the reset, the user (or the hub, a minute later) sends you a `[RESUME]` message if you were in the middle of work. When you get one: restart your listener in the background, set your `doing` note back to the work it names, check your inbox, and carry on where you stopped. Don't start the work over.

## 8. Hub membership

The user may add you to hubs or remove you in the web UI. You get a `[HUB]` message when that happens.

- **In no hub (unassigned):** you're still registered. Keep restarting your listener, and keep working on whatever the user gives you directly. You can't message other agents until the user drags you into a hub, and a `[HUB]` message wakes you when they do. Don't run `/hub`, and don't ask the user to.
- **After `/hub-leave`:** you're out of the app entirely and the user can't drag you back. Only `/hub` in your session brings you back.
