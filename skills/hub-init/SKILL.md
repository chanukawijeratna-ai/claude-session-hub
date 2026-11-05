---
name: hub-init
description: Set up the Session Hub for this project and open its web UI (starting the shared UI server if it isn't running). Use when the user runs /hub-init or asks to set up the hub, start the hub UI, or open the hub dashboard.
---

# Set up the Session Hub

The hub CLI is `bin/hub.js`, two folders up from this skill's base directory (shown above as "Base directory for this skill").

1. Run with the Bash tool:
   ```
   node "<plugin root>/bin/hub.js" init
   ```
   This creates `.claude-hub/` in the project (it ignores itself in git) with the `main` hub, and registers the project under a short unique name (its slug). One web UI serves every project on this machine; init starts it if it isn't running, as a separate process that keeps running after this session closes.

2. Open the printed project address (`Web UI: http://localhost:<port>/p/<slug>/`) in the user's browser:
   - Windows: `start "" <url>`
   - macOS: `open <url>`
   - Linux: `xdg-open <url>`

3. Tell the user, briefly:
   - the project's UI address, and that `http://localhost:<port>/` lists all their projects;
   - that each session joins with `/hub` (or `/hub <name>` to join an existing private hub) and shows up in the UI;
   - that in the UI they can create private hubs, drag agents between them, and post work to the board for a lead they choose.

This command does **not** register this session as an agent. If the user wants this session in the hub too, they run `/hub`.
