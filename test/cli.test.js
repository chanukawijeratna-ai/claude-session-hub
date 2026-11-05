'use strict';
// Simulates several agents sharing one project hub. Run: node --test test/
const { test, before } = require('node:test');
const assert = require('node:assert');
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HUB = path.join(__dirname, '..', 'bin', 'hub.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-'));
const env = { ...process.env, HUB_ROOT: root, HUB_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'hub-home-')), HUB_NO_SERVER: '1' };

function hub(...args) {
  const r = spawnSync(process.execPath, [HUB, ...args], { env, encoding: 'utf8' });
  return { out: r.stdout, err: r.stderr, code: r.status };
}
const ok = (...args) => {
  const r = hub(...args);
  assert.strictEqual(r.code, 0, r.err);
  return r.out;
};
const firstId = (out) => out.match(/\(id ([0-9a-f]{8})/)[1];

before(() => {
  ok('join', 'backend', '--role', 'Backend dev', '--purpose', 'API server');
  ok('join', 'frontend', '--role', 'Frontend dev', '--purpose', 'React UI');
  ok('join', 'security', '--role', 'Security reviewer', '--purpose', 'Audits changes');
  require('../lib/core').createHub(root).createHubNamed('lab'); // private hubs are made in the web UI
  ok('join', 'alpha', '--role', 'Prototype dev', '--purpose', 'Spike A', '--hub', 'lab');
  ok('join', 'beta', '--role', 'Prototype dev', '--purpose', 'Spike B', '--hub', 'lab');
});

test('/hub with a hub name that does not exist joins main', () => {
  const out = ok('join', 'gamma', '--role', 'r', '--purpose', 'p', '--hub', 'nowhere');
  assert.match(out, /no hub named "nowhere", so you joined "main"/);
  assert.match(ok('hubs'), /main: [^\n]*gamma/);
  assert.doesNotMatch(ok('hubs'), /nowhere/);
  ok('quit', '--as', 'gamma');
});

test('agents lists every card when no --as is given', () => {
  const out = ok('agents');
  for (const n of ['backend', 'frontend', 'security', 'alpha', 'beta']) assert.match(out, new RegExp(`${n} \\[online`));
  assert.match(out, /purpose: React UI/);
});

test('hub folder ignores itself in git', () => {
  assert.strictEqual(fs.readFileSync(path.join(root, '.claude-hub', '.gitignore'), 'utf8'), '*\n');
});

test('direct message reaches only its target, once', () => {
  ok('send', 'frontend', 'hello', 'there', '--as', 'backend');
  assert.match(ok('inbox', '--as', 'frontend'), /\[DIRECT @main\] backend -> frontend[\s\S]*hello there/);
  assert.match(ok('inbox', '--as', 'frontend'), /Inbox empty/);
  assert.doesNotMatch(ok('inbox', '--as', 'security'), /hello there/);
});

test('board post reaches everyone in the hub but the sender; replies stay on the board', () => {
  ok('post', 'what is src/legacy.ts?', '--as', 'frontend');
  const id = firstId(ok('inbox', '--as', 'security'));
  assert.match(ok('inbox', '--as', 'backend'), /what is src\/legacy.ts/);
  assert.match(ok('inbox', '--as', 'frontend'), /Inbox empty/);

  ok('reply', id, 'mine, keep it', '--as', 'backend');
  assert.match(ok('inbox', '--as', 'frontend'), new RegExp(`\\[BOARD @main reply to ${id}\\] backend -> board`));
  assert.match(ok('inbox', '--as', 'security'), /mine, keep it/);
});

test('reply to a direct message goes back to the sender', () => {
  ok('send', 'security', 'ping', '--as', 'backend');
  const id = firstId(ok('inbox', '--as', 'security'));
  ok('reply', id, 'pong', '--as', 'security');
  assert.match(ok('inbox', '--as', 'backend'), /\[DIRECT @main reply to [0-9a-f]{8}\] security -> backend[\s\S]*pong/);
});

test('task lifecycle notifies the lead and shows status', () => {
  ok('task', 'frontend', 'Build orders page', '--body', 'use /orders API', '--as', 'backend');
  const inbox = ok('inbox', '--as', 'frontend');
  assert.match(inbox, /\[TASK @main\] backend -> frontend: "Build orders page"[\s\S]*use \/orders API/);
  const id = firstId(inbox);

  ok('task', 'security', 'Review orders page', '--parent', id, '--as', 'backend');
  ok('task-update', id, 'accepted', '--as', 'frontend');
  ok('task-update', id, 'done', '--report', 'page at src/Orders.tsx', '--as', 'frontend');

  const lead = ok('inbox', '--as', 'backend');
  assert.match(lead, /\[TASK ACCEPTED @main\] frontend -> backend/);
  assert.match(lead, /\[TASK DONE @main\] frontend -> backend[\s\S]*src\/Orders.tsx/);
  assert.match(ok('tasks'), new RegExp(`${id} \\[done\\] backend -> frontend`));
  assert.match(ok('tasks'), new RegExp(`\\[assigned\\] backend -> security: "Review orders page" \\(parent ${id}\\)`));
});

test('private hubs are isolated from main', () => {
  ok('post', 'lab only', '--as', 'alpha');
  assert.match(ok('inbox', '--as', 'beta'), /\[BOARD @lab\] alpha -> board[\s\S]*lab only/);
  assert.doesNotMatch(ok('inbox', '--as', 'backend'), /lab only/);
  assert.match(hub('send', 'alpha', 'hi', '--as', 'backend').err, /don't share a hub with alpha/);

  const seen = ok('agents', '--as', 'alpha');
  assert.match(seen, /^beta/m);
  assert.doesNotMatch(seen, /backend/);
});

test('an agent in several hubs must pick the board, and moves are announced', () => {
  ok('enter', 'lab', '--as', 'security');
  assert.match(hub('post', 'hello', '--as', 'security').err, /several hubs \(main, lab\)/);
  ok('post', 'hello lab', '--hub', 'lab', '--as', 'security');
  assert.match(ok('inbox', '--as', 'alpha'), /\[BOARD @lab\] security -> board/);
  assert.doesNotMatch(ok('inbox', '--as', 'frontend'), /hello lab/);

  ok('send', 'alpha', 'cross-check', '--as', 'security');
  assert.match(ok('inbox', '--as', 'alpha'), /\[DIRECT @lab\] security -> alpha/);

  assert.match(ok('hubs'), /main: backend, frontend, security\nlab: alpha, beta, security/);
  ok('leave', 'lab', '--as', 'security');
  ok('leave', 'lab', '--as', 'beta');
  assert.match(ok('hubs'), /unassigned: beta/);
  assert.match(hub('post', 'x', '--as', 'beta').err, /not in any hub/);
});

test('wait blocks until a message arrives, then exits with it', async () => {
  ok('inbox', '--as', 'security'); // drain anything earlier tests left unread
  const child = spawn(process.execPath, [HUB, 'wait', '--as', 'security'], { env });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const exited = new Promise((res) => child.on('exit', res));

  await new Promise((r) => setTimeout(r, 1500));
  assert.strictEqual(child.exitCode, null, 'wait exited before any message');
  assert.match(ok('wait', '--as', 'security'), /already running/);
  ok('send', 'security', 'wake up', '--as', 'frontend');

  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 5000))]);
  if (code === 'timeout') child.kill();
  assert.strictEqual(code, 0);
  assert.match(out, /1 new hub item\(s\) for security[\s\S]*wake up/);
  assert.ok(!fs.existsSync(path.join(root, '.claude-hub', 'waiters', 'security.json')), 'listener record not cleaned up');
});

test('wait --timeout returns when nothing arrives', () => {
  ok('inbox', '--as', 'backend');
  assert.match(ok('wait', '--timeout', '1', '--as', 'backend'), /No new items/);
});

test('claims record and report ownership', () => {
  assert.match(ok('whois', path.join(root, 'src', 'x.ts')), /src\/x.ts: unclaimed/);
  ok('claim', path.join(root, 'src', 'x.ts'), '--note', 'orders API handler', '--as', 'backend');
  const out = ok('whois', path.join(root, 'src', 'x.ts'));
  assert.match(out, /claimed by backend[\s\S]*orders API handler[\s\S]*role: {4}Backend dev/);
  assert.match(ok('whois', path.join(root, 'src', 'x.ts'), '--as', 'alpha'), /not in any of your hubs/);
});

test('errors are clear', () => {
  assert.match(hub('inbox').err, /--as/);
  assert.match(hub('inbox', '--as', 'ghost').err, /has not joined/);
  assert.match(hub('send', 'ghost', 'hi', '--as', 'backend').err, /unknown agent/);
  assert.match(hub('join', 'Bad Name', '--role', 'r', '--purpose', 'p').err, /lowercase/);
  assert.match(hub('join', 'x', '--role', 'r', '--purpose', 'p', '--hub', 'Bad Hub').err, /bad hub name/);
});
