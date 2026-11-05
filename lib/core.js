'use strict';
// Hub storage and rules, shared by the CLI, the hooks and the web server.
// A project's state lives in <project>/.claude-hub/. See docs/design.md.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OFFLINE_AFTER_MS = 5 * 60 * 1000;
const CURSOR_SLACK_MS = 10 * 1000; // covers events whose file appears slightly after a scan
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const MAIN = 'main';

class HubError extends Error {}

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

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeJson(file, obj) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      // Windows refuses to replace a file another process has open; retry briefly.
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      sleepSync(25);
    }
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

function createHub(root) {
  const dir = path.join(root, '.claude-hub');

  function sub(name) {
    const d = path.join(dir, name);
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
      const gi = path.join(dir, '.gitignore');
      if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
    }
    return d;
  }
  const filesIn = (name) => fs.readdirSync(sub(name)).filter((f) => f.endsWith('.json'));

  // ---------- hubs ----------

  function ensureHub(name, by = 'user') {
    if (!NAME_RE.test(name || '')) throw new HubError(`bad hub name "${name}": use lowercase letters, digits and dashes`);
    const f = path.join(sub('hubs'), `${name}.json`);
    if (!fs.existsSync(f)) writeJson(f, { name, created: new Date().toISOString(), by });
  }

  // Creating a hub on purpose (the web UI): a name that is already taken is an error.
  function createHubNamed(name, by = 'user') {
    if (NAME_RE.test(name || '') && fs.existsSync(path.join(sub('hubs'), `${name}.json`))) {
      throw new HubError(`a hub named "${name}" already exists`);
    }
    ensureHub(name, by);
  }

  // Deletes a hub and everything said or assigned in it (board, messages, tasks, attached images).
  // Its members stay registered and are told; one left in no hub becomes unassigned. MAIN stays.
  function deleteHub(name, by = 'user') {
    if (name === MAIN) throw new HubError('the MAIN hub cannot be deleted');
    const file = path.join(sub('hubs'), `${name}.json`);
    if (!NAME_RE.test(name || '') || !fs.existsSync(file)) throw new HubError(`no hub named "${name}"`);
    let removed = 0;
    for (const f of filesIn('events')) {
      const e = readJson(path.join(sub('events'), f));
      if (!e || e.hub !== name) continue;
      for (const im of e.images || []) fs.rmSync(path.join(dir, 'attachments', path.basename(im.file)), { force: true });
      fs.rmSync(path.join(sub('events'), f), { force: true });
      removed++;
    }
    const members = [];
    for (const a of listAgents()) {
      if (!a.hubs.includes(name)) continue;
      a.hubs = a.hubs.filter((h) => h !== name);
      saveAgent(a);
      members.push(a.name);
      // Filed under no hub, so nothing of the deleted hub reappears if a new hub gets the same name.
      addEvent({ type: 'membership', from: by, to: a.name, hub: null, deletedHub: name, action: 'removed', hubs: a.hubs });
    }
    fs.rmSync(file, { force: true });
    return { members, events: removed };
  }

  function listHubs() {
    ensureHub(MAIN);
    return filesIn('hubs').map((f) => readJson(path.join(sub('hubs'), f))).filter(Boolean)
      .sort((a, b) => (a.name === MAIN ? -1 : b.name === MAIN ? 1 : a.name.localeCompare(b.name)));
  }

  // ---------- agents ----------

  const agentFile = (name) => path.join(sub('agents'), `${name}.json`);
  const normalize = (a) => (a && !Array.isArray(a.hubs) ? { ...a, hubs: [MAIN] } : a); // records from before hubs existed
  const getAgent = (name) => (NAME_RE.test(name || '') ? normalize(readJson(agentFile(name))) : null);
  const saveAgent = (a) => writeJson(agentFile(a.name), a);
  const listAgents = () => filesIn('agents').map((f) => normalize(readJson(path.join(sub('agents'), f)))).filter(Boolean);
  // Agents that ran /hub-leave are out of the app: hidden everywhere until they run /hub again.
  const activeAgents = () => listAgents().filter((a) => !a.left);
  const isOnline = (a) => !a.ended && !a.left && Date.now() - Date.parse(a.lastSeen) < OFFLINE_AFTER_MS;
  const shared = (a, b) => a.hubs.filter((h) => b.hubs.includes(h));

  function mustAgent(name) {
    const a = getAgent(name);
    if (!a) throw new HubError(`agent "${name}" has not joined; run: hub join ${name} --role ... --purpose ...`);
    return a;
  }

  function touch(name) {
    const a = getAgent(name);
    if (!a) return;
    a.lastSeen = new Date().toISOString();
    delete a.ended;
    saveAgent(a);
  }

  function endSession(name) {
    const a = getAgent(name);
    if (!a) return;
    a.ended = new Date().toISOString();
    saveAgent(a);
  }

  function join({ name, role, purpose, doing, hub }) {
    if (!NAME_RE.test(name || '')) throw new HubError('join needs a name: lowercase letters, digits and dashes');
    const prev = getAgent(name);
    role = role || prev?.role;
    purpose = purpose || prev?.purpose;
    if (!role || !purpose) throw new HubError('join needs --role and --purpose');
    const hubs = [...(prev?.hubs || [])];
    // /hub <name> joins that hub only if it exists; hubs are created in the web UI. Otherwise: main.
    if (hub && !NAME_RE.test(hub)) throw new HubError(`bad hub name "${hub}": use lowercase letters, digits and dashes`);
    const missing = hub && !listHubs().some((h) => h.name === hub) ? hub : null;
    const target = (hub && !missing) ? hub : (missing || !hubs.length ? MAIN : null);
    if (target) { ensureHub(target, name); if (!hubs.includes(target)) hubs.push(target); }
    const now = new Date().toISOString();
    const a = { name, role, purpose, doing: doing || prev?.doing || '', hubs, joined: prev?.joined || now, lastSeen: now };
    saveAgent(a);
    if (!fs.existsSync(cursorFile(name))) writeJson(cursorFile(name), { ts: Date.now(), seen: {} });
    return { agent: a, rejoined: !!prev, missing };
  }

  // /hub-leave: out of every hub, listener stopped, hooks go quiet. Card and claims stay; join undoes it.
  function leave(name) {
    const a = mustAgent(name);
    a.hubs = [];
    a.left = new Date().toISOString();
    saveAgent(a);
    const w = readJson(waiterFile(name));
    if (w && pidAlive(w.pid)) { try { process.kill(w.pid); } catch { /* already gone */ } }
    fs.rmSync(waiterFile(name), { force: true });
    return a;
  }

  function updateTag(name, fields) {
    const a = mustAgent(name);
    for (const k of ['doing', 'role', 'purpose']) if (typeof fields[k] === 'string') a[k] = fields[k];
    saveAgent(a);
    return a;
  }

  function addToHub(name, hub, by = 'user') {
    const a = mustAgent(name);
    // An agent that ran /hub-leave is out of the app; only /hub in its own session brings it back.
    if (a.left) throw new HubError(`${name} has left the hub. Run /hub in its session to bring it back.`);
    ensureHub(hub, by);
    if (a.hubs.includes(hub)) return a;
    a.hubs.push(hub);
    saveAgent(a);
    addEvent({ type: 'membership', from: by, to: name, hub, action: 'added', hubs: a.hubs });
    return a;
  }

  function removeFromHub(name, hub, by = 'user') {
    const a = mustAgent(name);
    if (!a.hubs.includes(hub)) return a;
    a.hubs = a.hubs.filter((h) => h !== hub);
    saveAgent(a);
    addEvent({ type: 'membership', from: by, to: name, hub, action: 'removed', hubs: a.hubs });
    return a;
  }

  // ---------- events ----------

  function addEvent(fields) {
    const e = { id: crypto.randomBytes(4).toString('hex'), ts: Date.now(), ...fields };
    writeJson(path.join(sub('events'), `${String(e.ts).padStart(15, '0')}-${e.id}.json`), e);
    return e;
  }

  function listEvents(sinceTs = 0) {
    return filesIn('events').filter((f) => Number(f.slice(0, 15)) >= sinceTs).sort()
      .map((f) => readJson(path.join(sub('events'), f))).filter(Boolean);
  }

  function findEvent(id) {
    const f = filesIn('events').find((n) => n.endsWith(`-${id}.json`));
    return f ? readJson(path.join(sub('events'), f)) : null;
  }

  // The hub a direct message or task travels through: one both agents are in.
  function routeHub(from, to, wanted) {
    const common = shared(from, to);
    if (wanted) {
      if (!common.includes(wanted)) throw new HubError(`you and ${to.name} are not both in hub "${wanted}"`);
      return wanted;
    }
    if (!common.length) throw new HubError(`you don't share a hub with ${to.name}, so you can't message them`);
    return common.includes(MAIN) ? MAIN : common[0];
  }

  function post(me, text, hub) {
    const a = mustAgent(me);
    if (!a.hubs.length) throw new HubError('you are not in any hub; ask the user to add you to one');
    if (hub && !a.hubs.includes(hub)) throw new HubError(`you are not in hub "${hub}"`);
    if (!hub && a.hubs.length > 1) throw new HubError(`you are in several hubs (${a.hubs.join(', ')}); say which with --hub`);
    return addEvent({ type: 'message', hub: hub || a.hubs[0], from: me, to: '*', text });
  }

  function send(me, toName, text, hub) {
    const a = mustAgent(me);
    const b = getAgent(toName);
    if (!b) throw new HubError(`unknown agent "${toName}"`);
    return addEvent({ type: 'message', hub: routeHub(a, b, hub), from: me, to: toName, text });
  }

  function reply(me, id, text) {
    const a = mustAgent(me);
    const orig = findEvent(id);
    if (!orig || !['message', 'task'].includes(orig.type)) throw new HubError(`no message with id "${id}"`);
    if (orig.to === '*') {
      if (!a.hubs.includes(orig.hub)) throw new HubError(`that message is on hub "${orig.hub}", which you are not in`);
      return addEvent({ type: 'message', hub: orig.hub, from: me, to: '*', text, replyTo: orig.id });
    }
    const other = mustAgent(orig.from === me ? orig.to : orig.from);
    return addEvent({ type: 'message', hub: routeHub(a, other), from: me, to: other.name, text, replyTo: orig.id });
  }

  function assignTask(me, toName, title, { body = '', parent = null, hub } = {}) {
    const a = mustAgent(me);
    const b = getAgent(toName);
    if (!b) throw new HubError(`unknown agent "${toName}"`);
    if (parent && findEvent(parent)?.type !== 'task') throw new HubError(`no task with id "${parent}"`);
    return addEvent({ type: 'task', hub: routeHub(a, b, hub), from: me, to: toName, title, body, parent });
  }

  // Work the user posts on a hub's board from the web UI. It goes to the chosen lead as a task,
  // so only the lead is woken; the lead plans it, delegates sub-tasks and reports back to the user.
  function postWork({ hub, lead, title, body = '', images = [] }) {
    title = String(title || '').trim();
    if (!title) throw new HubError('describe the work in the title');
    if (title.length > 200) throw new HubError('keep the title under 200 characters; put details in the body');
    if (!listHubs().some((h) => h.name === hub)) throw new HubError(`no hub named "${hub}"`);
    const a = getAgent(lead);
    if (!a) throw new HubError('choose an agent to lead this work');
    if (!a.hubs.includes(hub)) throw new HubError(`${lead} is not in hub "${hub}"`);
    const saved = saveImages(images);
    // The lead gets the hub's other agents with the work itself, so it delegates without having to look them up.
    const team = activeAgents().filter((x) => x.hubs.includes(hub) && x.name !== lead)
      .map((x) => ({ name: x.name, role: x.role, purpose: x.purpose, online: isOnline(x) }));
    return addEvent({
      type: 'task', hub, from: 'user', to: lead, title, body: String(body || '').trim(), parent: null, work: true,
      leadRole: a.role, team, ...(saved.length ? { images: saved } : {}),
    });
  }

  // ---------- image attachments (for work the user posts) ----------

  const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
  const MAX_IMAGES = 6;
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const ATTACHMENT_RE = /^[0-9a-f]{12}-\d\.(png|jpg|gif|webp)$/;

  function saveImages(images) {
    if (!Array.isArray(images) || !images.length) return [];
    if (images.length > MAX_IMAGES) throw new HubError(`attach at most ${MAX_IMAGES} images`);
    const decoded = images.map((im, i) => {
      const ext = IMAGE_TYPES[im && im.type];
      if (!ext) throw new HubError(`image ${i + 1} is not a PNG, JPEG, GIF or WebP`);
      const buf = Buffer.from(String(im.data || ''), 'base64');
      if (!buf.length) throw new HubError(`image ${i + 1} is empty`);
      if (buf.length > MAX_IMAGE_BYTES) throw new HubError(`image ${i + 1} is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
      return { buf, ext, name: String(im.name || `image ${i + 1}`).slice(0, 120) };
    });
    const stem = crypto.randomBytes(6).toString('hex');
    return decoded.map(({ buf, ext, name }, i) => {
      const file = `${stem}-${i}.${ext}`;
      fs.writeFileSync(path.join(sub('attachments'), file), buf);
      return { file, name, path: path.join(dir, 'attachments', file), bytes: buf.length };
    });
  }

  // Absolute path of a stored attachment, or null for anything that isn't one.
  function attachmentPath(file) {
    if (!ATTACHMENT_RE.test(file || '')) return null;
    const p = path.join(dir, 'attachments', file);
    return fs.existsSync(p) ? p : null;
  }

  function updateTask(me, taskId, status, report = '') {
    mustAgent(me);
    const task = findEvent(taskId);
    if (!task || task.type !== 'task') throw new HubError(`no task with id "${taskId}"`);
    if (!['accepted', 'done', 'failed'].includes(status)) throw new HubError('status must be accepted, done or failed');
    return addEvent({ type: 'task-update', hub: task.hub, from: me, to: task.from, taskId: task.id, title: task.title, status, report });
  }

  function listTasks(events = listEvents()) {
    return events.filter((e) => e.type === 'task').map((t) => {
      let status = 'assigned';
      let report = '';
      for (const e of events) {
        if (e.type === 'task-update' && e.taskId === t.id) { status = e.status; report = e.report || report; }
      }
      return { ...t, status, report };
    });
  }

  // ---------- inbox ----------

  const cursorFile = (me) => path.join(sub('cursors'), `${me}.json`);
  const readCursor = (me) => readJson(cursorFile(me)) || { ts: Date.now(), seen: {} };

  function isForMe(e, a) {
    if (e.from === a.name) return false;
    if (e.to === '*') return a.hubs.includes(e.hub);
    return e.to === a.name;
  }

  function unread(me) {
    const a = mustAgent(me);
    const c = readCursor(me);
    return listEvents(c.ts - CURSOR_SLACK_MS).filter((e) => isForMe(e, a) && !c.seen[e.id]);
  }

  function markRead(me, scanTs, events) {
    const c = readCursor(me);
    const floor = scanTs - CURSOR_SLACK_MS;
    const seen = {};
    for (const [id, ts] of Object.entries(c.seen)) if (ts >= floor) seen[id] = ts;
    for (const e of events) seen[e.id] = e.ts;
    writeJson(cursorFile(me), { ts: Math.max(c.ts, scanTs), seen });
  }

  // Read and mark in one step; returns the items.
  function takeUnread(me) {
    const scanTs = Date.now();
    const items = unread(me);
    if (items.length) markRead(me, scanTs, items);
    return items;
  }

  // ---------- listeners (hub wait) ----------

  const waiterFile = (me) => path.join(sub('waiters'), `${me}.json`);

  function isListening(me) {
    const w = readJson(waiterFile(me));
    return !!w && pidAlive(w.pid);
  }

  function setWaiter(me) { writeJson(waiterFile(me), { pid: process.pid, since: new Date().toISOString() }); }

  function clearWaiter(me) {
    const w = readJson(waiterFile(me));
    if (w && w.pid === process.pid) fs.rmSync(waiterFile(me), { force: true });
  }

  // ---------- sessions ----------

  const sessionFile = (sid) => path.join(sub('sessions'), `${hash(sid)}.json`);
  const agentForSession = (sid) => (sid ? readJson(sessionFile(sid))?.agent || null : null);
  const mapSession = (sid, agent) => writeJson(sessionFile(sid), { session: sid, agent, ts: new Date().toISOString() });

  // ---------- claims ----------

  function relPath(p, cwd = root) {
    return path.relative(root, path.resolve(cwd, p)).split(path.sep).join('/');
  }
  const claimKey = (rel) => (process.platform === 'win32' ? rel.toLowerCase() : rel);
  const claimFile = (rel) => path.join(sub('claims'), `${hash(claimKey(rel))}.json`);

  function setClaim(p, agent, note = '') {
    const rel = relPath(p);
    if (rel.startsWith('..')) throw new HubError(`${p} is outside the project`);
    const c = { path: rel, agent, note, ts: new Date().toISOString() };
    writeJson(claimFile(rel), c);
    return c;
  }

  const getClaim = (p) => readJson(claimFile(relPath(p)));
  const listClaims = () => filesIn('claims').map((f) => readJson(path.join(sub('claims'), f))).filter(Boolean);

  // ---------- usage limits ----------
  // A hook records a hit (it runs even when the model can't). The board shows it; the user, or the
  // server a minute after the reset time, resumes the agents that were interrupted mid-work.

  function openTasksOf(name) {
    return listTasks().filter((t) => t.to === name && t.status !== 'done' && t.status !== 'failed');
  }

  function recordLimit(name, { resetsAt = null, message = '' } = {}) {
    const a = getAgent(name);
    if (!a || a.left) return null;
    const reset = resetsAt ? Number(resetsAt) : null;
    // One hit per limit window: repeated failures before the reset don't add more notices.
    if (a.limit && !a.limit.resumed && (a.limit.resetsAt || null) === reset) return a.limit;
    const open = openTasksOf(name);
    const interrupted = Boolean((a.doing && a.doing !== 'Idle') || open.length);
    a.limit = { hitAt: Date.now(), resetsAt: reset, interrupted, doing: a.doing || '', tasks: open.map((t) => t.id), message: String(message).slice(0, 300) };
    saveAgent(a);
    for (const h of a.hubs) addEvent({ type: 'limit', hub: h, from: name, to: 'user', resetsAt: reset, interrupted });
    return a.limit;
  }

  // Wakes each interrupted agent with a note to carry on. Returns the names resumed.
  function resumeLimited({ hub = null, by = 'user', names = null } = {}) {
    const resumed = [];
    for (const a of activeAgents()) {
      if (!a.limit || a.limit.resumed) continue;
      if (hub && !a.hubs.includes(hub)) continue;
      if (names && !names.includes(a.name)) continue;
      a.limit.resumed = Date.now();
      saveAgent(a);
      if (!a.limit.interrupted) continue;
      addEvent({ type: 'resume', hub: a.hubs[0] || null, from: by, to: a.name, doing: a.limit.doing, tasks: a.limit.tasks, auto: by === 'auto' });
      resumed.push(a.name);
    }
    return resumed;
  }

  // The agent is working again (its session ran a turn after the reset): the limit is over.
  function clearLimitIfPast(name) {
    const a = getAgent(name);
    if (!a || !a.limit || a.limit.resumed) return;
    if (a.limit.resetsAt && Date.now() < a.limit.resetsAt) return;
    a.limit.resumed = Date.now();
    saveAgent(a);
  }

  // ---------- wipe ----------

  const exists = () => fs.existsSync(dir);
  const confirmFile = () => path.join(dir, 'wipe-confirm.json');
  const WIPE_CONFIRM_MS = 10 * 60 * 1000;

  // Written by the UserPromptSubmit hook when the user's own message is exactly the project slug.
  function recordWipeConfirmation(sessionId) { if (exists()) writeJson(confirmFile(), { ts: Date.now(), session: sessionId || null }); }
  function wipeConfirmed() {
    const c = readJson(confirmFile());
    return Boolean(c && Date.now() - c.ts < WIPE_CONFIRM_MS);
  }

  function wipeSummary() {
    const events = listEvents();
    return {
      agents: listAgents().length, hubs: listHubs().length, events: events.length,
      tasks: events.filter((e) => e.type === 'task').length, claims: listClaims().length,
    };
  }

  // Deletes everything: stops every listener, then removes .claude-hub. There is no undo.
  function wipe() {
    for (const f of filesIn('waiters')) {
      const w = readJson(path.join(sub('waiters'), f));
      if (w && w.pid !== process.pid && pidAlive(w.pid)) { try { process.kill(w.pid); } catch { /* already gone */ } }
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  return {
    root, dir, MAIN, exists,
    recordWipeConfirmation, wipeConfirmed, wipeSummary, wipe,
    recordLimit, resumeLimited, clearLimitIfPast,
    ensureHub, createHubNamed, deleteHub, listHubs, postWork, attachmentPath,
    getAgent, mustAgent, listAgents, activeAgents, isOnline, shared, touch, endSession, join, leave, updateTag, addToHub, removeFromHub,
    addEvent, listEvents, findEvent, post, send, reply, assignTask, updateTask, listTasks,
    unread, markRead, takeUnread,
    isListening, setWaiter, clearWaiter,
    agentForSession, mapSession,
    relPath, claimKey, setClaim, getClaim, listClaims,
  };
}

// ---------- text formatting (used by CLI and hooks) ----------

function clock(ts) { return new Date(ts).toTimeString().slice(0, 8); }
function indent(text) { return String(text).split('\n').map((l) => `    ${l}`).join('\n'); }

// Reads the reset time out of Claude Code's usage-limit message, e.g. "You've hit your session limit · resets 3:45pm"
// or "... · resets Mon 12:00am" (local time), or an older "...|1730000000" epoch. Returns epoch ms, or null.
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
function parseLimitReset(text, now = Date.now()) {
  const s = String(text || '');
  const epoch = /\|(\d{10})\b/.exec(s);
  if (epoch) return Number(epoch[1]) * 1000;
  const m = /resets?\s+(?:at\s+)?(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*,?\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/i.exec(s);
  if (!m) return null;
  let hour = Number(m[2]) % 12;
  if (m[4].toLowerCase() === 'p') hour += 12;
  const at = new Date(now);
  at.setHours(hour, Number(m[3] || 0), 0, 0);
  if (m[1]) {
    const ahead = (DAYS.indexOf(m[1].toLowerCase()) - at.getDay() + 7) % 7;
    at.setDate(at.getDate() + ahead);
    if (at.getTime() <= now) at.setDate(at.getDate() + 7);
  } else if (at.getTime() <= now) {
    at.setDate(at.getDate() + 1);
  }
  return at.getTime();
}

function formatEvent(e) {
  const at = `@${e.hub}`;
  if (e.type === 'message') {
    const kind = e.to === '*' ? 'BOARD' : 'DIRECT';
    const re = e.replyTo ? ` reply to ${e.replyTo}` : '';
    return `[${kind} ${at}${re}] ${e.from} -> ${e.to === '*' ? 'board' : e.to} (id ${e.id}, ${clock(e.ts)})\n${indent(e.text)}`;
  }
  if (e.type === 'task' && e.work) {
    return `[WORK ${at}] user -> ${e.to}: "${e.title}" (id ${e.id}, ${clock(e.ts)})` +
      (e.body ? `\n${indent(e.body)}` : '') +
      (e.images?.length ? `\n    The user attached ${e.images.length} image(s). Look at them with the Read tool before planning:` +
        e.images.map((im) => `\n      ${im.path}  (${im.name})`).join('') +
        '\n    Pass these paths on in the specs of any sub-task they matter to.' : '') +
      `\n    The user posted this work on the board and chose you to LEAD it. Your first job is to delegate, not to build it all yourself.` +
      (e.team?.length
        ? `\n    Other agents in hub ${e.hub} when this was posted:` +
          e.team.map((t) => `\n      - ${t.name}${t.online ? '' : ' (offline)'}: ${t.role}. ${t.purpose}`).join('') +
          `\n    (hub agents --as ${e.to} shows their current cards.)`
        : `\n    No other agents were in hub ${e.hub} when this was posted (check hub agents --as ${e.to}); if that's still so, do it yourself and say so in your report.`) +
      `\n    1. Accept it: hub task-update ${e.id} accepted --as ${e.to}` +
      `\n    2. Split the work into parts. Give each part to the agent whose role fits it best: hub task <agent> "<title>" --body "<spec>" --parent ${e.id} --as ${e.to}` +
      `\n       Only do yourself the parts that match your own role${e.leadRole ? ` (${e.leadRole})` : ''}. If a part fits nobody, say so in your plan.` +
      `\n    3. Post your plan to the board in a few lines: who does what.` +
      `\n    4. When every part is done, report to the user: hub task-update ${e.id} done --report "<what was built, by whom, how to try it>" --as ${e.to}`;
  }
  if (e.type === 'task') {
    return `[TASK ${at}] ${e.from} -> ${e.to}: "${e.title}" (id ${e.id}${e.parent ? `, parent ${e.parent}` : ''}, ${clock(e.ts)})` +
      (e.body ? `\n${indent(e.body)}` : '') +
      `\n    You are the worker. Accept it, do it, then report done or failed with hub task-update ${e.id} ...`;
  }
  if (e.type === 'task-update') {
    return `[TASK ${e.status.toUpperCase()} ${at}] ${e.from} -> ${e.to}: "${e.title}" (task ${e.taskId}, ${clock(e.ts)})` +
      (e.report ? `\n${indent(e.report)}` : '');
  }
  if (e.type === 'resume') {
    return `[RESUME ${at}] ${e.auto ? 'The hub' : 'The user'} says your usage limit has reset (${clock(e.ts)}). Your work was cut off when the limit was hit.` +
      (e.doing ? `\n    You were working on: ${e.doing}` : '') +
      (e.tasks?.length ? `\n    Open tasks: ${e.tasks.join(', ')} (hub tasks --mine shows them)` : '') +
      '\n    Restart your listener in the background, set your doing note back to that work with hub tag --doing, check your inbox, and carry on where you stopped.';
  }
  if (e.type === 'limit') return `[LIMIT ${at}] ${e.from} hit its usage limit${e.resetsAt ? `; it resets at ${clock(e.resetsAt)}` : ''}.`;
  if (e.type === 'membership') {
    let now = e.hubs.length ? `Your hubs are now: ${e.hubs.join(', ')}.`
      : 'You are now in no hub, so you can\'t message other agents for now. You are still registered: keep restarting your listener as usual ' +
        'and carry on with any work the user gives you. When the user adds you to a hub in the web UI, a [HUB] message wakes you. ' +
        'Do not run /hub or ask the user to.';
    if (e.deletedHub) return `[HUB] ${e.from} deleted hub "${e.deletedHub}" (${clock(e.ts)}), with its board, messages and tasks, so you are out of it. ${now}`;
    return `[HUB] ${e.from} ${e.action} you ${e.action === 'added' ? 'to' : 'from'} hub "${e.hub}" (${clock(e.ts)}). ${now}`;
  }
  return JSON.stringify(e);
}

function formatAgent(a, isOnline) {
  const ago = Math.round((Date.now() - Date.parse(a.lastSeen)) / 1000);
  return `${a.name} [${isOnline(a) ? 'online' : 'offline'}, seen ${ago}s ago, hubs: ${a.hubs.join(', ') || 'none'}]\n` +
    `    role:    ${a.role}\n    purpose: ${a.purpose}\n    doing:   ${a.doing || '-'}`;
}

module.exports = { createHub, findRoot, HubError, formatEvent, parseLimitReset, formatAgent, indent, MAIN, NAME_RE, readJson, writeJson, pidAlive };
