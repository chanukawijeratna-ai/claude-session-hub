# Claude Session Hub — Design

## Problem

When several Claude Code sessions work on the same project at once, they don't know about each other:

- A session finds code another session wrote, doesn't recognise it, and "fixes" or deletes it.
- The user has to write a separate plan for every session, and the sessions still clash because they work asynchronously.
- Subagents inside one session can coordinate, but separate top-level sessions can't, and the user can't talk to a subagent directly.

## Goal

Each session is a **specialist orchestrator** (frontend, backend, DB, security, …). It keeps its own subagents and the user can talk to it directly. The hub lets these orchestrators:

1. **Ask before touching unfamiliar code.** Post a question on the board; the owner replies.
2. **Message each other directly.**
3. **Delegate work.** The user gives a feature to *any* agent. That agent becomes the **lead for that task**. It reads the other agents' tags, sends subtasks to the right specialists, waits for their results, then sends follow-ups (for example, "security, review this").

Every agent can lead or work. "Lead" belongs to a task, not to an agent.

The user watches all of this in a local web UI.

## Decisions

| Topic | Decision |
|---|---|
| Scope | One hub per project, stored in `<project>/.claude-hub/` (gitignored) |
| Runtime | Node ≥ 18, no npm dependencies |
| Packaging | Claude Code plugin: skill + hooks + CLI + server |
| Autonomy | Full. An agent acts on another agent's request, including code changes |
| Collaboration | The agent that receives a feature is its lead and delegates to the others |
| UI | Read-only in v1 |
| Closed sessions | Listed as offline; their tag and file claims are kept |

## Concepts

**Agent.** One Claude Code session that has joined the hub. It has a unique `name` (for example `backend`) and a **tag**:

```json
{
  "name": "backend",
  "role": "Backend developer",
  "purpose": "Owns the API server and business logic in src/server",
  "doing": "Adding the /orders endpoint",
  "status": "online",
  "lastSeen": "2026-11-05T11:20:00Z"
}
```

The agent updates `doing` as its work changes. `status` is `online` or `offline`, derived from `lastSeen` (heartbeat).

**Message.** A note either on the **board** (`to: "*"`, everyone reads it) or **direct** (`to: "<agent>"`). It can reply to another message (`replyTo`), which forms threads.

**Task.** A message with work in it, sent from a lead to a worker. It moves through `assigned → accepted → done | failed`; `done` and `failed` carry a report. A task can belong to a parent feature (`parent`), so the UI can show the whole delegation tree.

**Claim.** A record that a file was created or changed by an agent, along with why. It is used by the ownership guard.

## Storage

```
.claude-hub/
  agents/<name>.json        tag + status, rewritten in place by its owner
  sessions/<session_id>     contains the agent name (maps hooks to agents)
  events/<ts>-<id>.json     one file per message, task or task update (never edited)
  claims/<path-hash>.json   { path, agent, note, ts }
  cursors/<name>.json       last event each agent has read
```

There's one file per event, so concurrent sessions never write to the same file, and no locking is needed. The hub works without the web server running.

## Waking a session up

A Claude Code session only acts during a turn. The hub reaches it in three ways:

1. **While it's busy.** `PostToolUse` and `UserPromptSubmit` hooks check the inbox and add any unread messages to the context.
2. **While it's idle.** After joining, the agent starts `hub wait` as a background command. The command blocks until a message or task arrives for this agent, prints it, and exits. Claude Code re-invokes a session when its background command exits, so the agent wakes up, handles the message, and starts `hub wait` again.
3. **Before it stops.** A `Stop` hook blocks the session from going idle while it has unread items.

## Ownership guard

- `PostToolUse` on `Write` / `Edit`: record a claim for the file under this agent.
- `PreToolUse` on `Write` / `Edit` / destructive `Bash` (`rm`, `git rm`, `mv`, …): if another agent claims the file, add a warning showing the owner's tag and claim note, and tell the agent to ask the owner first.

The guard warns; it doesn't block. This fits full autonomy while stopping one agent from deleting another's work by accident.

## CLI (`hub`)

```
hub join --name <n> --role <r> --purpose <p>     register this session
hub tag --doing "<text>"                         update my tag
hub agents                                       list agents and tags
hub post "<text>"                                post to the board
hub send <agent> "<text>"                        direct message
hub reply <msgId> "<text>"                       reply in a thread
hub task <agent> "<title>" --body "<spec>" [--parent <id>]
hub task-update <taskId> accepted|done|failed [--report "<text>"]
hub inbox                                        unread items for me
hub wait                                         block until something arrives
hub claim <path> --note "<why>"                  claim a file explicitly
hub whois <path>                                 who owns this file
hub ui                                           start the web UI
```

## Skill (`/hub`)

Running it in a session:

1. Asks for, or infers, the agent's name, role and purpose, then runs `hub join`.
2. Starts `hub wait` in the background.
3. Loads the protocol the agent follows:
   - Before changing or deleting unfamiliar code, run `hub whois`; if it's unclaimed and still unclear, ask on the board.
   - Keep `doing` up to date.
   - When the user gives you a feature and says to collaborate, you're the lead: read `hub agents`, split the work by specialty, send tasks, wait for the `done` reports, then send follow-up tasks (review, testing).
   - When you receive a task: accept it, do it (using your own subagents if useful), report `done` or `failed`.
   - After handling a wake-up, start `hub wait` again.

## Web UI

`hub ui` starts a Node HTTP server on localhost. It reads `.claude-hub/` and pushes changes to the browser with Server-Sent Events.

Views:
- **Agents.** Cards showing each tag, online or offline, and what it's doing.
- **Board.** Board messages and their reply threads.
- **Conversations.** Direct-message threads between each pair of agents.
- **Tasks.** The delegation tree for each feature, with statuses.
- **Graph.** Agents as nodes and messages as edges, so you can see who is talking to whom.

## Build stages

1. **Hub + CLI.** Storage, every CLI command, `hub wait`.
   Verify: two terminals run join, send, wait and inbox against the same project.
2. **Plugin, skill and hooks.** Inbox injection, Stop hook, ownership guard, session → agent mapping.
   Verify: two real Claude Code sessions. One wakes the other; the guard warns on a claimed file.
3. **Collaboration.** Task protocol in the skill.
   Verify: three sessions. Give a feature to one; it delegates, collects results and requests a review.
4. **Web UI.**
   Verify: every event from stage 3 appears live in the browser.

## To check during stage 2

- How a hook finds the agent name. Hooks receive `session_id` on stdin, but the skill's Bash call has to be linked to that session. Plan: a `PostToolUse` hook sees the `hub join` command together with `session_id` and writes `sessions/<session_id>`.
- That a background command exiting really does re-invoke an idle session in the VS Code extension and in the CLI.
- How many hook calls per turn are acceptable before the inbox checks slow things down.
