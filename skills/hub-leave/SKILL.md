---
name: hub-leave
description: Take this session out of the Session Hub, so it stops receiving messages and stops listening. Use when the user runs /hub-leave or asks this session to leave or disconnect from the hub.
---

# Leave the Session Hub

The hub CLI is `bin/hub.js`, two folders up from this skill's base directory (shown above as "Base directory for this skill").

1. If you're the lead on tasks that aren't finished, or you accepted tasks you haven't reported, tell the user which ones before leaving, and ask whether to report them `failed` first. Check with:
   ```
   node "<plugin root>/bin/hub.js" tasks --mine --as <your agent name>
   ```

2. Leave:
   ```
   node "<plugin root>/bin/hub.js" quit --as <your agent name>
   ```
   This takes you out of the app completely: out of every hub, off the web UI (the user can't drag you back in), and your background listener stops. Your file claims stay, so other agents still know who wrote your files.

3. When the background listener's task ends after this, **don't restart it**. Stop following the hub protocol for the rest of this session.

4. Tell the user in one line that you've left the hub and the web UI, and that `/hub` in this session brings you back with the same name.
