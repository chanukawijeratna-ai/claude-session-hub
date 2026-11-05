---
name: hub-wipe
description: Permanently delete this project's Session Hub (all agents, hubs, messages, tasks and file claims). Use only when the user runs /hub-wipe or explicitly asks to wipe or delete the whole Session Hub for this project.
---

# Wipe the Session Hub

This deletes everything the Session Hub knows about this project. It cannot be undone. The user must confirm by **typing the project's hub name in the chat**. Do not use AskUserQuestion for this, and never treat "yes", "ok" or "go ahead" as confirmation.

The hub CLI is `bin/hub.js`, two folders up from this skill's base directory (shown above as "Base directory for this skill").

1. Run with the Bash tool, without `--confirm`:
   ```
   node "<plugin root>/bin/hub.js" wipe
   ```
   This deletes nothing. It prints what would be lost and the project's hub name (its slug, for example `my-app-3f2a`).

2. Tell the user, in a few lines:
   - what will be deleted (use the numbers it printed) and that there is no undo;
   - that every agent's listener stops and the project leaves the Session Hub home page;
   - that to use the hub again they run `/hub` and start from nothing;
   - to confirm, they type the hub name exactly, as their whole message: show it on its own line in a code span.

   Then stop and wait for their reply. Do not run anything else.

3. When they reply:
   - If their message is exactly the hub name, run:
     ```
     node "<plugin root>/bin/hub.js" wipe --confirm <slug>
     ```
     The CLI checks that the user typed it (a hook records the user's message), so it refuses if you try to confirm on their behalf.
   - Anything else, including a near miss: say the wipe is cancelled and nothing was deleted.

4. After a successful wipe:
   - do not start a hub listener, and do not run other hub commands;
   - if you saved a Session Hub memory for this project, delete it (and its line in your memory index);
   - tell the user it's gone and that `/hub` starts a fresh hub.
