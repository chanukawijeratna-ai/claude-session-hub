#!/usr/bin/env node
'use strict';
// Claude Session Hub CLI. All state lives in <project>/.claude-hub/ — see docs/design.md.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OFFLINE_AFTER_MS = 5 * 60 * 1000;
const CURSOR_SLACK_MS = 10 * 1000; // covers events whose file appears slightly after a scan
const POLL_MS = 1000;
const HEARTBEAT_MS = 30 * 1000;

// ---------- paths ----------

function findRoot(start) {
  if (process.env.HUB_ROOT) return path.resolve(process.env.HUB_ROOT);
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.claude-hub')) || fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

const ROOT = findRoot(process.cwd());
const HUB = path.join(ROOT, '.claude-hub');

function sub(name) {
  const d = path.join(HUB, name);
  if (!fs.existsSync(d)) {
    fs.mkdirSync(d, { recursive: true });
    const gi = path.join(HUB, '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
  }
  return d;
}

// ---------- json files ----------

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, obj) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      // Windows refuses to replace a file another process has open; retry briefly.
      if (i >= 20 || (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES')) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

// ---------- agents ----------

const agentFile = (name) => path.join(sub('agents'), `${name}.json`);
const getAgent = (name) => readJson(agentFile(name));
const saveAgent = (a) => writeJson(agentFile(a.name), a);
const listAgents = () => fs.readdirSync(sub('agents')).filter((f) => f.endsWith('.json'))
  .map((f) => readJson(path.join(sub('agents'), f))).filter(Boolean);
const isOnline = (a) => Date.now() - Date.parse(a.lastSeen) < OFFLINE_AFTER_MS;

function touch(name) {
  const a = getAgent(name);
  if (!a) return;
  a.lastSeen = new Date().toISOString();
  saveAgent(a);
}

// ---------- events ----------

function addEvent(fields) {
  const e = { id: crypto.randomBytes(4).toString('hex'), ts: Date.now(), ...fields };
  writeJson(path.join(sub('events'), `${String(e.ts).padStart(15, '0')}-${e.id}.json`), e);
  return e;
}

function listEvents(sinceTs = 0) {
  const d = sub('events');
  return fs.readdirSync(d)
    .filter((f) => f.endsWith('.json') && Number(f.slice(0, 15)) >= sinceTs)
    .sort()
    .map((f) => readJson(path.join(d, f)))
    .filter(Boolean);
}

function findEvent(id) {
  const d = sub('events');
  const f = fs.readdirSync(d).find((n) => n.endsWith(`-${id}.json`));
  return f ? readJson(path.join(d, f)) : null;
}

const isForMe = (e, me) => e.from !== me && (e.to === me || e.to === '*');

// ---------- read cursors ----------

const cursorFile = (me) => path.join(sub('cursors'), `${me}.json`);

function readCursor(me) {
  return readJson(cursorFile(me)) || { ts: Date.now(), seen: {} };
}

function unread(me) {
  const c = readCursor(me);
  return listEvents(c.ts - CURSOR_SLACK_MS).filter((e) => isForMe(e, me) && !c.seen[e.id]);
}

function markRead(me, scanTs, events) {
  const c = readCursor(me);
  const floor = scanTs - CURSOR_SLACK_MS;
  const seen = {};
  for (const [id, ts] of Object.entries(c.seen)) if (ts >= floor) seen[id] = ts;
  for (const e of events) seen[e.id] = e.ts;
  writeJson(cursorFile(me), { ts: Math.max(c.ts, scanTs), seen });
}

// ---------- claims ----------

function relPath(p) {
  return path.relative(ROOT, path.resolve(p)).split(path.sep).join('/');
}

function claimFile(p) {
  const key = process.platform === 'win32' ? relPath(p).toLowerCase() : relPath(p);
  return path.join(sub('claims'), `${crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)}.json`);
}

function setClaim(p, agent, note) {
  const c = { path: relPath(p), agent, note: note || '', ts: new Date().toISOString() };
  writeJson(claimFile(p), c);
  return c;
}

const getClaim = (p) => readJson(claimFile(p));

// ---------- tasks ----------

function taskStatus(taskId, events) {
  let status = 'assigned';
  let report = '';
  for (const e of events) {
    if (e.type === 'task-update' && e.taskId === taskId) { status = e.status; report = e.report || report; }
  }
  return { status, report };
}

// ---------- output ----------

function clock(ts) {
  return new Date(ts).toTimeString().slice(0, 8);
}

function indent(text) {
  return String(text).split('\n').map((l) => `    ${l}`).join('\n');
}

function formatEvent(e) {
  const to = e.to === '*' ? 'board' : e.to;
  const meta = `(id ${e.id}, ${clock(e.ts)})`;
  if (e.type === 'message') {
    const kind = e.to === '*' ? 'BOARD' : 'DIRECT';
    const re = e.replyTo ? ` reply to ${e.replyTo}` : '';
    return `[${kind}${re}] ${e.from} -> ${to} ${meta}\n${indent(e.text)}`;
  }
  if (e.type === 'task') {
    const parent = e.parent ? `, parent ${e.parent}` : '';
    return `[TASK] ${e.from} -> ${to}: "${e.title}" (id ${e.id}${parent}, ${clock(e.ts)})` +
      (e.body ? `\n${indent(e.body)}` : '') +
      `\n    -> accept with: hub task-update ${e.id} accepted --as ${to}`;
  }
  if (e.type === 'task-update') {
    return `[TASK ${e.status.toUpperCase()}] ${e.from} -> ${to}: "${e.title}" (task ${e.taskId}, ${clock(e.ts)})` +
      (e.report ? `\n${indent(e.report)}` : '');
  }
  return JSON.stringify(e);
}

function formatAgent(a) {
  const ago = Math.round((Date.now() - Date.parse(a.lastSeen)) / 1000);
  return `${a.name} [${isOnline(a) ? 'online' : 'offline'}, seen ${ago}s ago]\n` +
    `    role:    ${a.role}\n    purpose: ${a.purpose}\n    doing:   ${a.doing || '-'}`;
}

// ---------- cli ----------

function die(msg) {
  process.stderr.write(`hub: ${msg}\n`);
  process.exit(1);
}

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

  join <name> --role "<r>" --purpose "<p>" [--doing "<d>"]   register (or rejoin) as an agent
  tag [--doing "<d>"] [--role "<r>"] [--purpose "<p>"]        update my tag
  agents                                                      list agents and their tags
  post "<text>"                                               post to the board (everyone)
  send <agent> "<text>"                                       direct message
  reply <id> "<text>"                                         reply to a message
  task <agent> "<title>" [--body "<spec>"] [--parent <id>]    hand a task to an agent
  task-update <taskId> accepted|done|failed [--report "<r>"]  update a task you were given
  tasks [--mine]                                              list tasks and their status
  inbox [--peek]                                              show unread items (and mark read)
  wait [--timeout <sec>]                                      block until something arrives for me
  claim <path> [--note "<why>"]                               record that I own a file
  whois <path>                                                who owns a file

"--as <agent>" (or env HUB_AGENT) says which agent you are. join sets it from <name>.
Hub root: ${ROOT}`;

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  const me = cmd === 'join' ? (pos[0] || flags.name) : (flags.as || process.env.HUB_AGENT);

  const needMe = () => {
    if (!me) die('say which agent you are with --as <name>');
    if (!getAgent(me)) die(`agent "${me}" has not joined; run: hub join ${me} --role ... --purpose ...`);
    touch(me);
    return me;
  };
  const text = (from) => {
    const t = pos.slice(from).join(' ').trim();
    if (!t) die('missing message text');
    return t;
  };

  switch (cmd) {
    case 'join': {
      if (!me || !/^[a-z0-9][a-z0-9-]*$/.test(me)) die('join needs a name: lowercase letters, digits and dashes');
      const prev = getAgent(me);
      const role = flags.role || prev?.role;
      const purpose = flags.purpose || prev?.purpose;
      if (!role || !purpose) die('join needs --role and --purpose');
      const now = new Date().toISOString();
      saveAgent({ name: me, role, purpose, doing: flags.doing || prev?.doing || '', joined: prev?.joined || now, lastSeen: now });
      if (!fs.existsSync(cursorFile(me))) writeJson(cursorFile(me), { ts: Date.now(), seen: {} });
      console.log(`${prev ? 'Rejoined' : 'Joined'} hub at ${ROOT} as "${me}".\n`);
      const others = listAgents().filter((a) => a.name !== me);
      console.log(others.length ? `Other agents:\n${others.map(formatAgent).join('\n')}` : 'No other agents yet.');
      break;
    }
    case 'tag': {
      needMe();
      const a = getAgent(me);
      for (const k of ['doing', 'role', 'purpose']) if (typeof flags[k] === 'string') a[k] = flags[k];
      saveAgent(a);
      console.log(formatAgent(a));
      break;
    }
    case 'agents': {
      const all = listAgents();
      console.log(all.length ? all.map(formatAgent).join('\n') : 'No agents have joined.');
      break;
    }
    case 'post': {
      const e = addEvent({ type: 'message', from: needMe(), to: '*', text: text(0) });
      console.log(`Posted to board (id ${e.id}).`);
      break;
    }
    case 'send': {
      needMe();
      const to = pos[0];
      if (!to || !getAgent(to)) die(`unknown agent "${to}"`);
      const e = addEvent({ type: 'message', from: me, to, text: text(1) });
      console.log(`Sent to ${to} (id ${e.id}).`);
      break;
    }
    case 'reply': {
      needMe();
      const orig = findEvent(pos[0] || '');
      if (!orig) die(`no message with id "${pos[0]}"`);
      const to = orig.to === '*' ? '*' : (orig.from === me ? orig.to : orig.from);
      const e = addEvent({ type: 'message', from: me, to, text: text(1), replyTo: orig.id });
      console.log(`Replied to ${orig.id} (id ${e.id}, visible to ${to === '*' ? 'board' : to}).`);
      break;
    }
    case 'task': {
      needMe();
      const to = pos[0];
      if (!to || !getAgent(to)) die(`unknown agent "${to}"`);
      const title = text(1);
      if (typeof flags.parent === 'string' && !findEvent(flags.parent)) die(`no task with id "${flags.parent}"`);
      const e = addEvent({
        type: 'task', from: me, to, title,
        body: typeof flags.body === 'string' ? flags.body : '',
        parent: typeof flags.parent === 'string' ? flags.parent : null,
      });
      console.log(`Task ${e.id} assigned to ${to}.`);
      break;
    }
    case 'task-update': {
      needMe();
      const task = findEvent(pos[0] || '');
      if (!task || task.type !== 'task') die(`no task with id "${pos[0]}"`);
      const status = pos[1];
      if (!['accepted', 'done', 'failed'].includes(status)) die('status must be accepted, done or failed');
      addEvent({
        type: 'task-update', from: me, to: task.from, taskId: task.id, title: task.title, status,
        report: typeof flags.report === 'string' ? flags.report : '',
      });
      console.log(`Task ${task.id} marked ${status}; ${task.from} has been notified.`);
      break;
    }
    case 'tasks': {
      const events = listEvents();
      let tasks = events.filter((e) => e.type === 'task');
      if (flags.mine) { needMe(); tasks = tasks.filter((t) => t.from === me || t.to === me); }
      if (!tasks.length) { console.log('No tasks.'); break; }
      for (const t of tasks) {
        const s = taskStatus(t.id, events);
        console.log(`${t.id} [${s.status}] ${t.from} -> ${t.to}: "${t.title}"${t.parent ? ` (parent ${t.parent})` : ''}` +
          (s.report ? `\n${indent(s.report)}` : ''));
      }
      break;
    }
    case 'inbox': {
      needMe();
      const scanTs = Date.now();
      const items = unread(me);
      console.log(items.length ? items.map(formatEvent).join('\n\n') : 'Inbox empty.');
      if (!flags.peek && items.length) markRead(me, scanTs, items);
      break;
    }
    case 'wait': {
      needMe();
      const deadline = flags.timeout ? Date.now() + Number(flags.timeout) * 1000 : Infinity;
      let lastBeat = Date.now();
      const tick = () => {
        const scanTs = Date.now();
        const items = unread(me);
        if (items.length) {
          markRead(me, scanTs, items);
          console.log(`${items.length} new item(s) for ${me}:\n\n${items.map(formatEvent).join('\n\n')}` +
            `\n\nWhen done handling these, start "hub wait --as ${me}" again in the background.`);
          return;
        }
        if (Date.now() >= deadline) { console.log('No new items before timeout.'); return; }
        if (Date.now() - lastBeat >= HEARTBEAT_MS) { touch(me); lastBeat = Date.now(); }
        setTimeout(tick, POLL_MS);
      };
      tick();
      break;
    }
    case 'claim': {
      needMe();
      if (!pos[0]) die('claim needs a path');
      const c = setClaim(pos[0], me, typeof flags.note === 'string' ? flags.note : '');
      console.log(`${c.path} claimed by ${me}.`);
      break;
    }
    case 'whois': {
      if (!pos[0]) die('whois needs a path');
      const c = getClaim(pos[0]);
      if (!c) { console.log(`${relPath(pos[0])}: unclaimed.`); break; }
      const a = getAgent(c.agent);
      console.log(`${c.path}: claimed by ${c.agent} at ${c.ts}` + (c.note ? `\n    note: ${c.note}` : '') +
        (a ? `\n${formatAgent(a)}` : ''));
      break;
    }
    case undefined:
    case 'help':
    case '--help':
      console.log(USAGE);
      break;
    default:
      die(`unknown command "${cmd}"\n\n${USAGE}`);
  }
}

if (require.main === module) main();

module.exports = { ROOT, HUB, getAgent, touch, setClaim, getClaim, unread, markRead, formatEvent, formatAgent, listAgents, listEvents };
