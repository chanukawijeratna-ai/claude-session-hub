#!/usr/bin/env node
'use strict';
// Session Hub web UI server. Usage: node server/server.js [projectRoot]
// Serves ui/index.html, a JSON state API, a live Server-Sent Events stream, and two
// write actions: create a hub, and add/remove an agent from a hub. Localhost only.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createHub, findRoot, HubError } = require('../lib/core');

const root = findRoot(process.argv[2] || process.cwd());
const hub = createHub(root);
const UI = path.join(__dirname, 'ui', 'index.html');
const FIRST_PORT = Number(process.env.HUB_PORT) || 4747;
const PUSH_MS = 1000;

function state() {
  const events = hub.listEvents();
  return {
    root,
    project: path.basename(root),
    hubs: hub.listHubs().map((h) => h.name),
    agents: hub.listAgents().map((a) => ({ ...a, online: hub.isOnline(a), listening: hub.isListening(a.name) })),
    events,
    tasks: hub.listTasks(events),
    claims: hub.listClaims(),
  };
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > 10000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new HubError('bad JSON')); } });
    req.on('error', reject);
  });
}

// Only accept writes from our own page: right Host, JSON body. Blocks other sites posting to localhost.
function trustedWrite(req, port) {
  const okHost = [`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host);
  return okHost && (req.headers['content-type'] || '').startsWith('application/json');
}

const clients = new Set();
let lastJson = '';

function push() {
  let json;
  try { json = JSON.stringify(state()); } catch { return; }
  if (json === lastJson) return;
  lastJson = json;
  for (const res of clients) res.write(`data: ${json}\n\n`);
}

async function handle(req, res, port) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/') return send(res, 200, fs.readFileSync(UI), 'text/html; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, state());
  if (req.method === 'GET' && url.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(state())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return undefined;
  }
  if (req.method === 'POST' && (url.pathname === '/api/hubs' || url.pathname === '/api/membership')) {
    if (!trustedWrite(req, port)) return send(res, 403, { error: 'forbidden' });
    try {
      const body = await readBody(req);
      if (url.pathname === '/api/hubs') hub.createHubNamed(String(body.name || '').trim(), 'user');
      else if (body.action === 'add') hub.addToHub(String(body.agent), String(body.hub), 'user');
      else if (body.action === 'remove') hub.removeFromHub(String(body.agent), String(body.hub), 'user');
      else throw new HubError('action must be add or remove');
      push();
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
    fs.writeFileSync(hub.serverFile(), JSON.stringify(info, null, 2));
    process.stdout.write(`Session Hub UI for ${root}: ${info.url}\n`);
    setInterval(push, PUSH_MS);
    setInterval(() => { for (const res of clients) res.write(': keep-alive\n\n'); }, 15000);
  });
  const cleanup = () => {
    try {
      const s = JSON.parse(fs.readFileSync(hub.serverFile(), 'utf8'));
      if (s.pid === process.pid) fs.rmSync(hub.serverFile(), { force: true });
    } catch { /* gone */ }
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));
}

if (hub.serverInfo()) {
  process.stdout.write(`Session Hub UI already running: ${hub.serverInfo().url}\n`);
} else {
  hub.listHubs();
  listen(FIRST_PORT, 20);
}
