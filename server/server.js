#!/usr/bin/env node
'use strict';
// Session Hub web server: one process for every project on this machine. Usage: node server/server.js
//   /                       home page: every project that uses Session Hub
//   /p/<slug>/              one project's hub UI
//   /api/projects           project summaries for the home page
//   /api/p/<slug>/state     a project's full state; /stream is the live Server-Sent Events version
//   POST /api/p/<slug>/hubs | /membership | /work   the user's actions from the UI
// Localhost only. Projects are listed in ~/.claude-session-hub (see lib/registry.js).

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createHub, HubError } = require('../lib/core');
const registry = require('../lib/registry');

const UI_DIR = path.join(__dirname, 'ui');
const STATIC = { 'index.html': 'text/html; charset=utf-8', 'home.html': 'text/html; charset=utf-8', 'base.css': 'text/css; charset=utf-8', 'base.js': 'text/javascript; charset=utf-8' };
const FIRST_PORT = Number(process.env.HUB_PORT) || 4747;
const PUSH_MS = 1000;
const IDLE_MS = 5 * 60 * 1000;

const hubs = new Map(); // slug -> { root, hub }
function projectHub(slug) {
  const p = registry.find(slug);
  if (!p) { hubs.delete(slug); return null; }
  let h = hubs.get(slug);
  if (!h || h.root !== p.root) { h = { root: p.root, hub: createHub(p.root) }; hubs.set(slug, h); }
  return { ...h, project: p };
}

function state(slug) {
  const ph = projectHub(slug);
  if (!ph) return null;
  const { hub, project } = ph;
  const events = hub.listEvents();
  return {
    slug,
    root: project.root,
    project: project.name,
    hubs: hub.listHubs().map((h) => h.name),
    agents: hub.activeAgents().map((a) => ({ ...a, online: hub.isOnline(a), listening: hub.isListening(a.name) })),
    events,
    tasks: hub.listTasks(events),
    claims: hub.listClaims(),
  };
}

function summary(p) {
  try {
    const hub = createHub(p.root);
    const events = hub.listEvents();
    const tasks = hub.listTasks(events);
    const agents = hub.activeAgents().map((a) => ({ name: a.name, role: a.role, doing: a.doing, online: hub.isOnline(a), left: Boolean(a.left) }));
    return {
      slug: p.slug, name: p.name, root: p.root, registered: p.registered,
      hubs: hub.listHubs().length,
      agents,
      openTasks: tasks.filter((t) => t.status !== 'done' && t.status !== 'failed').length,
      doneTasks: tasks.filter((t) => t.status === 'done').length,
      openWork: tasks.filter((t) => t.work && t.status !== 'done' && t.status !== 'failed').length,
      lastActivity: events.length ? events[events.length - 1].ts : Date.parse(p.registered),
      events: events.length,
    };
  } catch { return null; }
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

// Work can carry up to 6 images of 8 MB each, sent as base64; everything else is small.
function readBody(req, limit = 20000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > limit) { reject(new HubError('the request is too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new HubError('bad JSON')); } });
    req.on('error', reject);
  });
}

// Only accept writes from our own page: right Host, JSON body. Blocks other sites posting to localhost.
function trustedWrite(req, port) {
  const okHost = [`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host);
  return okHost && (req.headers['content-type'] || '').startsWith('application/json');
}

const streams = new Map(); // slug -> { clients: Set<res>, last: string }

function push(slug) {
  const s = streams.get(slug);
  if (!s || !s.clients.size) return;
  const st = state(slug);
  if (!st) {
    for (const res of s.clients) { res.write('event: gone\ndata: {}\n\n'); res.end(); }
    streams.delete(slug);
    return;
  }
  let json;
  try { json = JSON.stringify(st); } catch { return; }
  if (json === s.last) return;
  s.last = json;
  for (const res of s.clients) res.write(`data: ${json}\n\n`);
}

async function handle(req, res, port) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  let m;

  if (req.method === 'GET' && p === '/') return send(res, 200, fs.readFileSync(path.join(UI_DIR, 'home.html')), STATIC['home.html']);
  if (req.method === 'GET' && (m = /^\/ui\/([a-z.]+)$/.exec(p)) && STATIC[m[1]] && !m[1].endsWith('.html')) {
    return send(res, 200, fs.readFileSync(path.join(UI_DIR, m[1])), STATIC[m[1]]);
  }
  if (req.method === 'GET' && p === '/api/health') return send(res, 200, { app: 'session-hub', pid: process.pid });
  if (req.method === 'GET' && p === '/api/projects') {
    return send(res, 200, { projects: registry.list().map(summary).filter(Boolean).sort((a, b) => b.lastActivity - a.lastActivity) });
  }
  if (req.method === 'GET' && (m = /^\/p\/([a-z0-9-]+)$/.exec(p))) {
    res.writeHead(301, { Location: `/p/${m[1]}/` }); return res.end();
  }
  if (req.method === 'GET' && (m = /^\/p\/([a-z0-9-]+)\/$/.exec(p))) {
    return send(res, 200, fs.readFileSync(path.join(UI_DIR, 'index.html')), STATIC['index.html']);
  }

  if (req.method === 'GET' && (m = /^\/api\/p\/([a-z0-9-]+)\/attachments\/([a-z0-9.-]+)$/.exec(p))) {
    const ph = projectHub(m[1]);
    const file = ph && ph.hub.attachmentPath(m[2]);
    if (!file) return send(res, 404, { error: 'not found' });
    const type = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[path.extname(file).slice(1)];
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    return fs.createReadStream(file).pipe(res);
  }

  if (!(m = /^\/api\/p\/([a-z0-9-]+)\/([a-z]+)$/.exec(p))) return send(res, 404, { error: 'not found' });
  const [, slug, action] = m;

  if (req.method === 'GET' && action === 'state') {
    const st = state(slug);
    return st ? send(res, 200, st) : send(res, 404, { error: 'no such project' });
  }
  if (req.method === 'GET' && action === 'stream') {
    const st = state(slug);
    if (!st) return send(res, 404, { error: 'no such project' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const json = JSON.stringify(st);
    res.write(`data: ${json}\n\n`);
    if (!streams.has(slug)) streams.set(slug, { clients: new Set(), last: json });
    streams.get(slug).clients.add(res);
    req.on('close', () => { const s = streams.get(slug); if (s) { s.clients.delete(res); if (!s.clients.size) streams.delete(slug); } });
    return undefined;
  }
  if (req.method === 'POST' && ['hubs', 'membership', 'work', 'deletehub'].includes(action)) {
    if (!trustedWrite(req, port)) return send(res, 403, { error: 'forbidden' });
    const ph = projectHub(slug);
    if (!ph) return send(res, 404, { error: 'no such project' });
    const { hub } = ph;
    try {
      const body = await readBody(req, action === 'work' ? 70 * 1024 * 1024 : 20000);
      if (action === 'deletehub') {
        const name = String(body.name || '');
        // The page asks the user to type the hub's name; the server checks it too.
        if (String(body.confirm || '').trim().toLowerCase() !== name) throw new HubError(`type the hub name "${name.toUpperCase()}" to confirm`);
        const r = hub.deleteHub(name, 'user');
        push(slug);
        return send(res, 200, { ok: true, ...r });
      }
      if (action === 'hubs') hub.createHubNamed(String(body.name || '').trim(), 'user');
      else if (action === 'work') hub.postWork({ hub: String(body.hub || ''), lead: String(body.lead || ''), title: body.title, body: body.body, images: body.images });
      else if (body.action === 'add') hub.addToHub(String(body.agent), String(body.hub), 'user');
      else if (body.action === 'remove') hub.removeFromHub(String(body.agent), String(body.hub), 'user');
      else throw new HubError('action must be add or remove');
      push(slug);
      return send(res, 200, { ok: true });
    } catch (e) {
      if (e instanceof HubError) return send(res, 400, { error: e.message });
      throw e;
    }
  }
  return send(res, 404, { error: 'not found' });
}

function listen(port, triesLeft) {
  const server = http.createServer((req, res) => {
    handle(req, res, port).catch((e) => { try { send(res, 500, { error: e.message }); } catch { /* closed */ } });
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && triesLeft > 0) listen(port + 1, triesLeft - 1);
    else { process.stderr.write(`session hub UI: ${e.message}\n`); process.exit(1); }
  });
  server.listen(port, '127.0.0.1', () => {
    const info = { pid: process.pid, port, url: `http://localhost:${port}`, started: new Date().toISOString() };
    fs.mkdirSync(registry.home(), { recursive: true });
    fs.writeFileSync(registry.serverFile(), JSON.stringify(info, null, 2));
    process.stdout.write(`Session Hub UI: ${info.url}\n`);
    setInterval(() => { for (const slug of streams.keys()) push(slug); }, PUSH_MS);
    setInterval(() => { for (const s of streams.values()) for (const res of s.clients) res.write(': keep-alive\n\n'); }, 15000);
    // Forget cached project handles nobody is watching.
    setInterval(() => { for (const slug of hubs.keys()) if (!streams.has(slug)) hubs.delete(slug); }, IDLE_MS);
  });
  const cleanup = () => {
    try {
      const s = JSON.parse(fs.readFileSync(registry.serverFile(), 'utf8'));
      if (s.pid === process.pid) fs.rmSync(registry.serverFile(), { force: true });
    } catch { /* gone */ }
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));
}

const running = registry.serverInfo();
if (running) process.stdout.write(`Session Hub UI already running: ${running.url}\n`);
else listen(FIRST_PORT, 20);
