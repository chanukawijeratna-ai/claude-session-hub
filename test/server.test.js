'use strict';
// Starts the web server against a temp project and drives its API. Run: node --test test/
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const HUB = path.join(__dirname, '..', 'bin', 'hub.js');
const SERVER = path.join(__dirname, '..', 'server', 'server.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-server-'));
const port = 5100 + Math.floor(Math.random() * 400);
const env = { ...process.env, HUB_ROOT: root, HUB_PORT: String(port) };
let server;

function hub(...args) {
  const r = spawnSync(process.execPath, [HUB, ...args], { env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout;
}

function req(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      let raw = '';
      res.on('data', (d) => { raw += d; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: raw }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const json = async (...a) => { const r = await req(...a); return { ...r, json: JSON.parse(r.body) }; };

before(async () => {
  hub('join', 'backend', '--role', 'Backend dev', '--purpose', 'API');
  hub('join', 'frontend', '--role', 'Frontend dev', '--purpose', 'UI');
  server = spawn(process.execPath, [SERVER, root], { env });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => { if (String(d).includes('http://localhost:')) resolve(); });
    server.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  });
});
after(() => server.kill());

test('serves the UI page', async () => {
  const r = await req('GET', '/');
  assert.strictEqual(r.status, 200);
  assert.match(r.type, /text\/html/);
  assert.match(r.body, /<title>Session Hub<\/title>/);
});

test('state lists hubs, agents and events', async () => {
  hub('post', 'hello all', '--as', 'backend');
  const { json: s } = await json('GET', '/api/state');
  assert.deepStrictEqual(s.hubs, ['main']);
  assert.deepStrictEqual(s.agents.map((a) => a.name).sort(), ['backend', 'frontend']);
  assert.ok(s.agents.every((a) => a.online === true && a.listening === false));
  assert.ok(s.events.some((e) => e.text === 'hello all' && e.hub === 'main'));
});

test('records itself so hub init can find it', () => {
  const info = JSON.parse(fs.readFileSync(path.join(root, '.claude-hub', 'server.json'), 'utf8'));
  assert.strictEqual(info.port, port);
  assert.match(hub('init'), new RegExp(`Web UI: http://localhost:${port}`));
});

test('creating a hub and moving an agent notifies the agent', async () => {
  assert.strictEqual((await json('POST', '/api/hubs', { name: 'lab' })).status, 200);
  assert.strictEqual((await json('POST', '/api/membership', { agent: 'frontend', hub: 'lab', action: 'add' })).status, 200);
  assert.match(hub('hubs'), /lab: frontend/);
  assert.match(hub('inbox', '--as', 'frontend'), /\[HUB\] user added you to hub "lab"[\s\S]*main, lab/);

  await json('POST', '/api/membership', { agent: 'frontend', hub: 'main', action: 'remove' });
  await json('POST', '/api/membership', { agent: 'frontend', hub: 'lab', action: 'remove' });
  assert.match(hub('inbox', '--as', 'frontend'), /unassigned/);
  assert.match(hub('hubs'), /unassigned: frontend/);
});

test('bad input is a 400 with a reason', async () => {
  const r = await json('POST', '/api/hubs', { name: 'Bad Name' });
  assert.strictEqual(r.status, 400);
  assert.match(r.json.error, /bad hub name/);
  assert.strictEqual((await json('POST', '/api/membership', { agent: 'ghost', hub: 'main', action: 'add' })).status, 400);
});

test('writes from other origins are refused', async () => {
  assert.strictEqual((await req('POST', '/api/hubs', { name: 'evil' }, { Host: 'evil.example' })).status, 403);
  const plain = await new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/api/hubs', method: 'POST', headers: { 'Content-Type': 'text/plain' } }, (res) => resolve(res.statusCode));
    r.on('error', () => {}); // the server may close before reading the body
    r.end('{"name":"evil"}');
  });
  assert.strictEqual(plain, 403);
  assert.doesNotMatch(hub('hubs'), /evil/);
});

test('stream pushes the state, then changes', async () => {
  const got = [];
  await new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/api/stream' }, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!chunk.startsWith('data: ')) continue;
          got.push(JSON.parse(chunk.slice(6)));
          if (got.length === 1) hub('post', 'streamed', '--as', 'backend');
          if (got.some((s) => s.events.some((e) => e.text === 'streamed'))) { r.destroy(); resolve(); }
        }
      });
    });
    r.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    setTimeout(() => { r.destroy(); reject(new Error('no update streamed')); }, 6000);
  });
  assert.ok(got.length >= 2);
});

test('quit takes an agent out of every hub and stops its listener', async () => {
  const w = spawn(process.execPath, [HUB, 'wait', '--as', 'backend'], { env });
  const exited = new Promise((r) => w.on('exit', r));
  await new Promise((r) => setTimeout(r, 800));
  hub('quit', '--as', 'backend');
  await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error('listener still running')), 4000))]);
  const { json: s } = await json('GET', '/api/state');
  const b = s.agents.find((a) => a.name === 'backend');
  assert.deepStrictEqual(b.hubs, []);
  assert.strictEqual(b.online, false);
  hub('join', 'backend');
  assert.match(hub('hubs'), /main: backend/);
});
