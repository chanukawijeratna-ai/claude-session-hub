#!/usr/bin/env node
'use strict';
// Claude Session Hub CLI. Logic lives in lib/core.js; this file parses arguments and prints.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { createHub, findRoot, HubError, formatEvent, formatAgent, indent, readJson, pidAlive } = require('../lib/core');
const registry = require('../lib/registry');

const POLL_MS = 1000;
const HEARTBEAT_MS = 30 * 1000;

const hub = createHub(findRoot(process.cwd()));

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[a.slice(2)] = true;
      else { flags[a.slice(2)] = next; i++; }
    } else pos.push(a);
  }
  return { pos, flags };
}

const USAGE = `Usage: hub <command> [args] --as <agent>

  init                                                       set up the hub and start the web UI
  wipe [--confirm <project>]                                 delete this project's hub for good (the user must confirm)
  quit                                                       leave every hub and stop my listener
  join <name> --role "<r>" --purpose "<p>" [--doing "<d>"] [--hub <h>]   register; no --hub means "main"
  tag [--doing "<d>"] [--role "<r>"] [--purpose "<p>"]       update my card
  agents                                                     agents I share a hub with (all, without --as)
  hubs                                                       hubs and their members
  enter <hub> / leave <hub>                                  join or leave a hub
  post "<text>" [--hub <h>]                                  post to a hub's board
  send <agent> "<text>" [--hub <h>]                          direct message
  reply <id> "<text>"                                        reply to a message
  task <agent> "<title>" [--body "<spec>"] [--parent <id>]   hand a task to an agent
  task-update <taskId> accepted|done|failed [--report "<r>"] update a task you were given
  tasks [--mine]                                             tasks and their status
  inbox [--peek]                                             unread items (marks them read)
  wait [--timeout <sec>]                                     block until something arrives
  claim <path> [--note "<why>"]                              record that I own a file
  whois <path>                                               who owns a file

"--as <agent>" (or env HUB_AGENT) says which agent you are. join sets it from <name>.
Hub root: ${hub.root}`;

const str = (v) => (typeof v === 'string' ? v : undefined);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Earlier versions ran one web server per project, recorded in .claude-hub/server.json.
// Stop it (only if it really is that project's hub server) so the shared server takes over.
function stopLegacyServer() {
  const file = path.join(hub.dir, 'server.json');
  const s = readJson(file);
  if (!s) return;
  if (pidAlive(s.pid)) {
    const probe = spawnSync(process.execPath, ['-e',
      `fetch(${JSON.stringify(`${s.url}/api/state`)}).then((r) => r.json()).then((j) => process.stdout.write(String(j.root || ''))).catch(() => {})`],
    { encoding: 'utf8', timeout: 4000 });
    if (path.resolve(probe.stdout || '.') === path.resolve(hub.root)) { try { process.kill(s.pid); } catch { /* gone */ } sleep(300); }
  }
  fs.rmSync(file, { force: true });
}

// One web server for every project on this machine. Start it if it isn't running.
function ensureServer() {
  let s = registry.serverInfo();
  if (s || process.env.HUB_NO_SERVER) return s;
  const server = path.join(__dirname, '..', 'server', 'server.js');
  spawn(process.execPath, [server], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  const until = Date.now() + 8000;
  while (!(s = registry.serverInfo()) && Date.now() < until) sleep(150);
  if (!s) throw new HubError(`the web UI did not start; try: node "${server}"`);
  return s;
}

const projectUrl = (s, slug) => `${s.url}/p/${slug}/`;

function run() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  const me = str(flags.as) || process.env.HUB_AGENT;

  const needMe = () => {
    if (!me) throw new HubError('say which agent you are with --as <name>');
    hub.mustAgent(me);
    hub.touch(me);
    return me;
  };
  const text = (from) => {
    const t = pos.slice(from).join(' ').trim();
    if (!t) throw new HubError('missing message text');
    return t;
  };
  const agentsVisibleTo = (name) => {
    const all = hub.activeAgents();
    if (!name) return all;
    const a = hub.mustAgent(name);
    return all.filter((b) => b.name !== name && hub.shared(a, b).length);
  };
  const fmt = (a) => formatAgent(a, hub.isOnline);

  // Every command except these needs a hub to exist already. Reading must not quietly recreate one
  // (for example after a wipe, from another session that is still running).
  if (cmd && !['init', 'join', 'wipe', 'help', '--help', '-h'].includes(cmd) && !hub.exists()) {
    throw new HubError('this project has no Session Hub. Run /hub to start one.');
  }

  switch (cmd) {
    case 'init': {
      hub.listHubs(); // creates .claude-hub and the main hub
      const slug = registry.register(hub.root);
      stopLegacyServer();
      const s = ensureServer();
      console.log(`Hub ready at ${hub.root}\nProject: ${slug}` +
        (s ? `\nWeb UI: ${projectUrl(s, slug)}\nAll projects: ${s.url}/` : '\nWeb UI: not started (HUB_NO_SERVER is set)'));
      return;
    }
    case 'wipe': {
      const slug = registry.slugFor(hub.root);
      if (!hub.exists()) { registry.unregister(hub.root); console.log('This project has no Session Hub. Nothing to wipe.'); return; }
      if (flags.confirm === undefined) {
        const n = hub.wipeSummary();
        console.log(`This would permanently delete the Session Hub for ${hub.root} (project "${slug}"):\n` +
          `  ${n.agents} agents, ${n.hubs} hubs, ${n.events} events (${n.tasks} tasks), ${n.claims} file claims.\n` +
          'Every listener is stopped and the project leaves the Session Hub home page. There is no undo.\n\n' +
          `To confirm, the user must type the project name in the chat, exactly:\n  ${slug}\n` +
          `Then run: hub wipe --confirm ${slug}`);
        return;
      }
      if (flags.confirm !== slug) throw new HubError(`the confirmation must be exactly "${slug}". Nothing was deleted.`);
      if (!hub.wipeConfirmed()) {
        throw new HubError(`the user has not typed "${slug}" in the chat (or did so more than 10 minutes ago). ` +
          'Only the user can confirm a wipe. Ask them to type it. Nothing was deleted.');
      }
      hub.wipe();
      registry.unregister(hub.root);
      console.log(`Wiped. The Session Hub for ${hub.root} is gone: agents, hubs, messages, tasks and file claims. ` +
        'Every listener was stopped. Run /hub to start fresh.');
      return;
    }
    case 'quit': {
      hub.leave(needMe());
      console.log(`${me} has left: it is out of every hub, hidden from the web UI, and its listener is stopped. ` +
        'Its file claims stay so others still know who wrote what. /hub in this session brings it back.');
      return;
    }
    case 'join': {
      const { agent, rejoined, missing } = hub.join({
        name: pos[0] || str(flags.name), role: str(flags.role), purpose: str(flags.purpose), doing: str(flags.doing), hub: str(flags.hub),
      });
      const slug = registry.register(hub.root);
      const s = registry.serverInfo();
      if (missing) console.log(`There is no hub named "${missing}", so you joined "main" instead. Hubs are created in the web UI; the user can move you there.`);
      console.log(`${rejoined ? 'Rejoined' : 'Joined'} the hub at ${hub.root} as "${agent.name}". Hubs: ${agent.hubs.join(', ') || 'none'}.`);
      console.log(s ? `Web UI: ${projectUrl(s, slug)}\n` : 'Web UI: not running. /hub-init starts it.\n');
      const others = agentsVisibleTo(agent.name);
      console.log(others.length ? `Agents you can talk to:\n${others.map(fmt).join('\n')}` : 'No other agents in your hubs yet.');
      return;
    }
    case 'tag':
      console.log(fmt(hub.updateTag(needMe(), { doing: str(flags.doing), role: str(flags.role), purpose: str(flags.purpose) })));
      return;
    case 'agents': {
      const list = me ? (needMe(), agentsVisibleTo(me)) : agentsVisibleTo(null);
      console.log(list.length ? list.map(fmt).join('\n') : 'No agents to show.');
      return;
    }
    case 'hubs': {
      const agents = hub.activeAgents();
      for (const h of hub.listHubs()) {
        const members = agents.filter((a) => a.hubs.includes(h.name)).map((a) => a.name);
        console.log(`${h.name}: ${members.join(', ') || '(empty)'}`);
      }
      const loose = agents.filter((a) => !a.hubs.length).map((a) => a.name);
      if (loose.length) console.log(`unassigned: ${loose.join(', ')}`);
      return;
    }
    case 'enter':
    case 'leave': {
      needMe();
      if (!pos[0]) throw new HubError(`${cmd} needs a hub name`);
      const a = cmd === 'enter' ? hub.addToHub(me, pos[0], me) : hub.removeFromHub(me, pos[0], me);
      console.log(`Hubs for ${me}: ${a.hubs.join(', ') || 'none (unassigned)'}.`);
      return;
    }
    case 'post': {
      const e = hub.post(needMe(), text(0), str(flags.hub));
      console.log(`Posted to the board of hub "${e.hub}" (id ${e.id}).`);
      return;
    }
    case 'send': {
      const e = hub.send(needMe(), pos[0], text(1), str(flags.hub));
      console.log(`Sent to ${e.to} via hub "${e.hub}" (id ${e.id}).`);
      return;
    }
    case 'reply': {
      const e = hub.reply(needMe(), pos[0], text(1));
      console.log(`Replied to ${e.replyTo} (id ${e.id}, visible to ${e.to === '*' ? `the board of hub "${e.hub}"` : e.to}).`);
      return;
    }
    case 'task': {
      const e = hub.assignTask(needMe(), pos[0], text(1), { body: str(flags.body) || '', parent: str(flags.parent) || null, hub: str(flags.hub) });
      console.log(`Task ${e.id} assigned to ${e.to}.`);
      return;
    }
    case 'task-update': {
      const e = hub.updateTask(needMe(), pos[0], pos[1], str(flags.report) || '');
      console.log(`Task ${e.taskId} marked ${e.status}; ${e.to} has been notified.`);
      return;
    }
    case 'tasks': {
      let tasks = hub.listTasks();
      if (flags.mine) { needMe(); tasks = tasks.filter((t) => t.from === me || t.to === me); }
      if (!tasks.length) { console.log('No tasks.'); return; }
      for (const t of tasks) {
        console.log(`${t.id} [${t.status}] ${t.from} -> ${t.to}: "${t.title}"${t.parent ? ` (parent ${t.parent})` : ''}` +
          (t.report ? `\n${indent(t.report)}` : ''));
      }
      return;
    }
    case 'inbox': {
      needMe();
      const items = flags.peek ? hub.unread(me) : hub.takeUnread(me);
      console.log(items.length ? items.map(formatEvent).join('\n\n') : 'Inbox empty.');
      return;
    }
    case 'wait': {
      needMe();
      if (hub.isListening(me)) { console.log(`A listener for ${me} is already running; nothing to do.`); return; }
      hub.setWaiter(me);
      process.on('exit', () => hub.clearWaiter(me));
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));
      const deadline = flags.timeout ? Date.now() + Number(flags.timeout) * 1000 : Infinity;
      let lastBeat = Date.now();
      const tick = () => {
        const items = hub.takeUnread(me);
        if (items.length) {
          console.log(`${items.length} new hub item(s) for ${me}:\n\n${items.map(formatEvent).join('\n\n')}` +
            `\n\nHandle these, then start the listener again in the background: hub wait --as ${me}`);
          return;
        }
        if (Date.now() >= deadline) { console.log('No new items before timeout.'); return; }
        if (Date.now() - lastBeat >= HEARTBEAT_MS) { hub.touch(me); lastBeat = Date.now(); }
        setTimeout(tick, POLL_MS);
      };
      tick();
      return;
    }
    case 'claim': {
      needMe();
      if (!pos[0]) throw new HubError('claim needs a path');
      const c = hub.setClaim(pos[0], me, str(flags.note) || '');
      console.log(`${c.path} claimed by ${me}.`);
      return;
    }
    case 'whois': {
      if (!pos[0]) throw new HubError('whois needs a path');
      const c = hub.getClaim(pos[0]);
      if (!c) { console.log(`${hub.relPath(pos[0])}: unclaimed.`); return; }
      const owner = hub.getAgent(c.agent);
      let reach = '';
      if (owner?.left) {
        reach = '\n    (this agent has left the hub, so nobody can answer for it; ask the user before changing it)';
      } else if (me && owner && c.agent !== me && !hub.shared(hub.mustAgent(me), owner).length) {
        reach = '\n    (not in any of your hubs, so you cannot message them; ask the user)';
      }
      console.log(`${c.path}: claimed by ${c.agent} at ${c.ts}` + (c.note ? `\n    note: ${c.note}` : '') +
        (owner ? `\n${fmt(owner)}` : '') + reach);
      return;
    }
    case undefined:
    case 'help':
    case '--help':
      console.log(USAGE);
      return;
    default:
      throw new HubError(`unknown command "${cmd}"\n\n${USAGE}`);
  }
}

try {
  run();
} catch (e) {
  if (!(e instanceof HubError)) throw e;
  process.stderr.write(`hub: ${e.message}\n`);
  process.exit(1);
}
