---
name: hub-init
description: Set up the Session Hub for this project and start its web UI (or restart it if it stopped). Use when the user runs /hub-init or asks to set up the hub, start the hub UI, or open the hub dashboard.
---

# Set up the Session Hub

The hub CLI is `bin/hub.js`, two folders up from this skill's base directory (shown above as "Base directory for this skill").

1. Run with the Bash tool:
   ```
   node "<plugin root>/bin/hub.js" init
   ```
   This creates `.claude-hub/` in the project (it ignores itself in git), creates the `main` hub, and starts the web UI as a separate process that keeps running after this session closes. If the UI is already running, it just prints its address.

2. Open the printed URL in the user's browser:
   - Windows: `start "" <url>`
   - macOS: `open <url>`
   - Linux: `xdg-open <url>`

3. Tell the user, briefly:
   - the UI address;
   - that each session joins with `/hub` (or `/hub <keyword>` for a private hub), and shows up in the UI;
   - that in the UI they can create private hubs and drag agents between them.

This command does **not** register this session as an agent. If the user wants this session in the hub too, they run `/hub`.
