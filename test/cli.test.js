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
const env = { ...process.env, HUB_ROOT: root };

function hub(...args) {
  const r = spawnSync(process.execPath, [HUB, ...args], { env, encoding: 'utf8' });
  return { out: r.stdout, err: r.stderr, code: r.status };
}
const ok = (...args) => {
  const r = hub(...args);
  assert.strictEqual(r.code, 0, r.err);
  return r.out;
};

before(() => {
  ok('join', 'backend', '--role', 'Backend dev', '--purpose', 'API server');
  ok('join', 'frontend', '--role', 'Frontend dev', '--purpose', 'React UI');
  ok('join', 'security', '--role', 'Security reviewer', '--purpose', 'Audits changes');
});

test('agents lists every tag', () => {
  const out = ok('agents');
  for (const n of ['backend', 'frontend', 'security']) assert.match(out, new RegExp(`${n} \\[online`));
  assert.match(out, /role: {4}React UI|purpose: React UI/);
});

test('hub folder ignores itself in git', () => {
  assert.strictEqual(fs.readFileSync(path.join(root, '.claude-hub', '.gitignore'), 'utf8'), '*\n');
});

test('direct message reaches only its target, once', () => {
  ok('send', 'frontend', 'hello', 'there', '--as', 'backend');
  assert.match(ok('inbox', '--as', 'frontend'), /\[DIRECT\] backend -> frontend[\s\S]*hello there/);
  assert.match(ok('inbox', '--as', 'frontend'), /Inbox empty/);
  assert.doesNotMatch(ok('inbox', '--as', 'security'), /hello there/);
});

test('board post reaches everyone but the sender; replies stay on the board', () => {
  ok('post', 'what is src/legacy.ts?', '--as', 'frontend');
  const sec = ok('inbox', '--as', 'security');
  const id = sec.match(/\(id ([0-9a-f]{8})/)[1];
  assert.match(ok('inbox', '--as', 'backend'), /what is src\/legacy.ts/);
  assert.match(ok('inbox', '--as', 'frontend'), /Inbox empty/);

  ok('reply', id, 'mine, keep it', '--as', 'backend');
  assert.match(ok('inbox', '--as', 'frontend'), new RegExp(`\\[BOARD reply to ${id}\\] backend -> board`));
  assert.match(ok('inbox', '--as', 'security'), /mine, keep it/);
});

test('reply to a direct message goes back to the sender', () => {
  ok('send', 'security', 'ping', '--as', 'backend');
  const id = ok('inbox', '--as', 'security').match(/\(id ([0-9a-f]{8})/)[1];
  ok('reply', id, 'pong', '--as', 'security');
  assert.match(ok('inbox', '--as', 'backend'), /\[DIRECT reply to [0-9a-f]{8}\] security -> backend[\s\S]*pong/);
});

test('task lifecycle notifies the lead and shows status', () => {
  ok('task', 'frontend', 'Build orders page', '--body', 'use /orders API', '--as', 'backend');
  const inbox = ok('inbox', '--as', 'frontend');
  assert.match(inbox, /\[TASK\] backend -> frontend: "Build orders page"[\s\S]*use \/orders API/);
  const id = inbox.match(/\[TASK\].*\(id ([0-9a-f]{8})/)[1];

  ok('task', 'security', 'Review orders page', '--parent', id, '--as', 'backend');
  ok('task-update', id, 'accepted', '--as', 'frontend');
  ok('task-update', id, 'done', '--report', 'page at src/Orders.tsx', '--as', 'frontend');

  const lead = ok('inbox', '--as', 'backend');
  assert.match(lead, /\[TASK ACCEPTED\] frontend -> backend/);
  assert.match(lead, /\[TASK DONE\] frontend -> backend[\s\S]*src\/Orders.tsx/);
  assert.match(ok('tasks'), new RegExp(`${id} \\[done\\] backend -> frontend`));
  assert.match(ok('tasks'), new RegExp(`\\[assigned\\] backend -> security: "Review orders page" \\(parent ${id}\\)`));
});

test('wait blocks until a message arrives, then exits with it', async () => {
  ok('inbox', '--as', 'security'); // drain anything earlier tests left unread
  const child = spawn(process.execPath, [HUB, 'wait', '--as', 'security'], { env });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const exited = new Promise((res) => child.on('exit', res));

  await new Promise((r) => setTimeout(r, 1500));
  assert.strictEqual(child.exitCode, null, 'wait exited before any message');
  ok('send', 'security', 'wake up', '--as', 'frontend');

  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 5000))]);
  if (code === 'timeout') child.kill();
  assert.strictEqual(code, 0);
  assert.match(out, /1 new item\(s\) for security[\s\S]*wake up/);
});

test('wait --timeout returns when nothing arrives', () => {
  assert.match(ok('wait', '--timeout', '1', '--as', 'backend'), /No new items/);
});

test('claims record and report ownership', () => {
  assert.match(ok('whois', path.join(root, 'src', 'x.ts')), /src\/x.ts: unclaimed/);
  ok('claim', path.join(root, 'src', 'x.ts'), '--note', 'orders API handler', '--as', 'backend');
  const out = ok('whois', path.join(root, 'src', 'x.ts'));
  assert.match(out, /claimed by backend[\s\S]*orders API handler[\s\S]*role: {4}Backend dev/);
});

test('errors are clear', () => {
  assert.match(hub('inbox').err, /--as/);
  assert.match(hub('inbox', '--as', 'ghost').err, /has not joined/);
  assert.match(hub('send', 'ghost', 'hi', '--as', 'backend').err, /unknown agent/);
  assert.match(hub('join', 'Bad Name', '--role', 'r', '--purpose', 'p').err, /lowercase/);
});
