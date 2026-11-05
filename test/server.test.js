'use strict';
// Starts the shared web server against a temp project and drives its API. Run: node --test test/
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
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-home-'));
const port = 5100 + Math.floor(Math.random() * 400);
const env = { ...process.env, HUB_ROOT: root, HUB_HOME: home, HUB_PORT: String(port), HUB_AUTO_RESUME_MS: '300' };
let server;
let slug;
const api = (p) => `/api/p/${slug}/${p}`;

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
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: raw, headers: res.headers }));
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
  server = spawn(process.execPath, [SERVER], { env });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => { if (String(d).includes('http://localhost:')) resolve(); });
    server.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  });
  slug = /Project: (\S+)/.exec(hub('init'))[1];
});
after(() => server.kill());

test('a project gets a readable, unique slug and its own address', () => {
  assert.match(slug, new RegExp(`^${path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-[0-9a-f]{4}$`));
  assert.match(hub('init'), new RegExp(`Web UI: http://localhost:${port}/p/${slug}/`));
  assert.match(hub('join', 'backend'), new RegExp(`/p/${slug}/`));
});

test('the home page lists every project that uses the hub', async () => {
  const page = await req('GET', '/');
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /<title>Session Hub<\/title>/);
  const { json: j } = await json('GET', '/api/projects');
  const p = j.projects.find((x) => x.slug === slug);
  assert.ok(p, 'project listed');
  assert.strictEqual(p.root, path.resolve(root));
  assert.deepStrictEqual(p.agents.map((a) => a.name).sort(), ['backend', 'frontend']);
});

test('serves a project UI under its slug, and 404s unknown projects', async () => {
  const r = await req('GET', `/p/${slug}/`);
  assert.strictEqual(r.status, 200);
  assert.match(r.type, /text\/html/);
  assert.strictEqual((await req('GET', `/p/${slug}`)).headers.location, `/p/${slug}/`);
  assert.strictEqual((await req('GET', '/api/p/nope-0000/state')).status, 404);
  assert.match((await req('GET', '/ui/base.css')).type, /text\/css/);
});

test('state lists hubs, agents and events', async () => {
  hub('post', 'hello all', '--as', 'backend');
  const { json: s } = await json('GET', api('state'));
  assert.strictEqual(s.slug, slug);
  assert.deepStrictEqual(s.hubs, ['main']);
  assert.deepStrictEqual(s.agents.map((a) => a.name).sort(), ['backend', 'frontend']);
  assert.ok(s.agents.every((a) => a.online === true && a.listening === false));
  assert.ok(s.events.some((e) => e.text === 'hello all' && e.hub === 'main'));
});

test('records itself once for the whole machine', () => {
  const info = JSON.parse(fs.readFileSync(path.join(home, 'server.json'), 'utf8'));
  assert.strictEqual(info.port, port);
  assert.ok(!fs.existsSync(path.join(root, '.claude-hub', 'server.json')));
});

test('creating a hub and moving an agent notifies the agent', async () => {
  assert.strictEqual((await json('POST', api('hubs'), { name: 'lab' })).status, 200);
  assert.strictEqual((await json('POST', api('membership'), { agent: 'frontend', hub: 'lab', action: 'add' })).status, 200);
  assert.match(hub('hubs'), /lab: frontend/);
  assert.match(hub('inbox', '--as', 'frontend'), /\[HUB\] user added you to hub "lab"[\s\S]*main, lab/);

  await json('POST', api('membership'), { agent: 'frontend', hub: 'main', action: 'remove' });
  await json('POST', api('membership'), { agent: 'frontend', hub: 'lab', action: 'remove' });
  assert.match(hub('inbox', '--as', 'frontend'), /in no hub/);
  assert.match(hub('hubs'), /unassigned: frontend/);
});

test('work posted on the board goes to the chosen lead only', async () => {
  hub('enter', 'main', '--as', 'frontend');
  const r = await json('POST', api('work'), { hub: 'main', lead: 'backend', title: 'Add login', body: 'Email and password.' });
  assert.strictEqual(r.status, 200);
  const inbox = hub('inbox', '--as', 'backend');
  assert.match(inbox, /\[WORK @main\] user -> backend: "Add login"/);
  assert.match(inbox, /chose you to LEAD it[\s\S]*delegate/);
  assert.match(inbox, /Other agents in hub main when this was posted:\n\s+- frontend: Frontend dev\. UI/);
  assert.match(inbox, /Only do yourself the parts that match your own role \(Backend dev\)/);
  assert.doesNotMatch(hub('inbox', '--as', 'frontend'), /Add login/);
  const id = /id ([0-9a-f]{8})/.exec(inbox)[1];
  hub('task-update', id, 'done', '--report', 'Built it', '--as', 'backend');
  const { json: s } = await json('GET', api('state'));
  const t = s.tasks.find((x) => x.id === id);
  assert.strictEqual(t.work, true);
  assert.strictEqual(t.status, 'done');

  assert.match((await json('POST', api('work'), { hub: 'main', lead: '', title: 'x' })).json.error, /choose an agent/);
  assert.match((await json('POST', api('work'), { hub: 'main', lead: 'backend', title: '  ' })).json.error, /title/);
  await json('POST', api('hubs'), { name: 'lab2' }); // hubs are made in the UI
  hub('enter', 'lab2', '--as', 'frontend');
  assert.match((await json('POST', api('work'), { hub: 'lab2', lead: 'backend', title: 'x' })).json.error, /not in hub/);
  hub('leave', 'lab2', '--as', 'frontend');
});

test('images attached to work are saved, served, and listed for the lead', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex'); // a PNG header is enough here
  const r = await json('POST', api('work'), { hub: 'main', lead: 'backend', title: 'Match this mockup', images: [{ name: 'mockup.png', type: 'image/png', data: png.toString('base64') }] });
  assert.strictEqual(r.status, 200, r.body);
  const inbox = hub('inbox', '--as', 'backend');
  assert.match(inbox, /attached 1 image\(s\)[\s\S]*attachments[\\/][0-9a-f]{12}-0\.png {2}\(mockup\.png\)/);
  const file = /([0-9a-f]{12}-0\.png)/.exec(inbox)[1];
  assert.ok(fs.existsSync(path.join(root, '.claude-hub', 'attachments', file)));
  const img = await req('GET', api(`attachments/${file}`));
  assert.strictEqual(img.status, 200);
  assert.strictEqual(img.type, 'image/png');
  assert.strictEqual((await req('GET', api('attachments/..%2Fagents%2Fbackend.json'))).status, 404);
  assert.match((await json('POST', api('work'), { hub: 'main', lead: 'backend', title: 'x', images: [{ name: 'a.svg', type: 'image/svg+xml', data: 'PHN2Zz4=' }] })).json.error, /not a PNG/);
});

test('bad input is a 400 with a reason', async () => {
  const r = await json('POST', api('hubs'), { name: 'Bad Name' });
  assert.strictEqual(r.status, 400);
  assert.match(r.json.error, /bad hub name/);
  assert.strictEqual((await json('POST', api('membership'), { agent: 'ghost', hub: 'main', action: 'add' })).status, 400);
  const dup = await json('POST', api('hubs'), { name: 'main' });
  assert.strictEqual(dup.status, 400);
  assert.match(dup.json.error, /already exists/);
});

test('writes from other origins are refused', async () => {
  assert.strictEqual((await req('POST', api('hubs'), { name: 'evil' }, { Host: 'evil.example' })).status, 403);
  const plain = await new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: api('hubs'), method: 'POST', headers: { 'Content-Type': 'text/plain' } }, (res) => resolve(res.statusCode));
    r.on('error', () => {}); // the server may close before reading the body
    r.end('{"name":"evil"}');
  });
  assert.strictEqual(plain, 403);
  assert.doesNotMatch(hub('hubs'), /evil/);
});

test('stream pushes the state, then changes', async () => {
  const got = [];
  await new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port, path: api('stream') }, (res) => {
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
  const { json: s } = await json('GET', api('state'));
  assert.ok(!s.agents.some((a) => a.name === 'backend'), 'an agent that left is not shown');
  hub('join', 'backend');
  assert.match(hub('hubs'), /main: backend/);
});

test('unassigned agents stay in the app; agents that left are gone from it until /hub', async () => {
  await json('POST', api('membership'), { agent: 'frontend', hub: 'main', action: 'remove' });
  assert.match(hub('inbox', '--as', 'frontend'), /no hub[\s\S]*keep restarting your listener[\s\S]*Do not run \/hub/);
  assert.ok((await json('GET', api('state'))).json.agents.some((a) => a.name === 'frontend' && a.hubs.length === 0));
  await json('POST', api('membership'), { agent: 'frontend', hub: 'main', action: 'add' }); // drag back in
  assert.match(hub('hubs'), /main: [^\n]*frontend/);

  hub('quit', '--as', 'frontend'); // /hub-leave
  const s = (await json('GET', api('state'))).json;
  assert.ok(!s.agents.some((a) => a.name === 'frontend'), 'hidden from the UI');
  assert.ok(!(await json('GET', '/api/projects')).json.projects[0].agents.some((a) => a.name === 'frontend'));
  assert.doesNotMatch(hub('agents'), /^frontend/m);
  const r = await json('POST', api('membership'), { agent: 'frontend', hub: 'main', action: 'add' });
  assert.strictEqual(r.status, 400);
  assert.match(r.json.error, /has left[\s\S]*\/hub/);
  hub('join', 'frontend'); // /hub brings it back
  assert.ok((await json('GET', api('state'))).json.agents.some((a) => a.name === 'frontend'));
});

test('deleting a hub needs its name typed, wipes its data and takes its agents out; MAIN stays', async () => {
  await json('POST', api('hubs'), { name: 'temp' });
  await json('POST', api('membership'), { agent: 'frontend', hub: 'temp', action: 'add' });
  hub('post', 'temp news', '--hub', 'temp', '--as', 'frontend');
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  await json('POST', api('work'), { hub: 'temp', lead: 'frontend', title: 'temp work', images: [{ name: 'a.png', type: 'image/png', data: png }] });
  const before = (await json('GET', api('state'))).json;
  const img = before.tasks.find((t) => t.title === 'temp work').images[0].file;
  hub('inbox', '--as', 'frontend');

  assert.match((await json('POST', api('deletehub'), { name: 'temp', confirm: 'tmp' })).json.error, /type the hub name "TEMP"/);
  assert.match((await json('POST', api('deletehub'), { name: 'main', confirm: 'main' })).json.error, /MAIN hub cannot be deleted/);
  const r = await json('POST', api('deletehub'), { name: 'temp', confirm: 'TEMP' });
  assert.strictEqual(r.status, 200, r.body);
  assert.deepStrictEqual(r.json.members, ['frontend']);

  const after = (await json('GET', api('state'))).json;
  assert.ok(!after.hubs.includes('temp'));
  assert.ok(!after.events.some((e) => e.hub === 'temp'));
  assert.ok(!after.agents.find((a) => a.name === 'frontend').hubs.includes('temp'));
  assert.ok(!fs.existsSync(path.join(root, '.claude-hub', 'attachments', img)));
  assert.match(hub('inbox', '--as', 'frontend'), /\[HUB\] user deleted hub "temp"/);
  await json('POST', api('hubs'), { name: 'temp' }); // a new hub with the same name starts empty
  assert.ok(!(await json('GET', api('state'))).json.events.some((e) => e.hub === 'temp'));
});

test('usage limits: the board shows them, Resume wakes only interrupted agents, and the hub resumes after the reset', async () => {
  const core = require('../lib/core').createHub(root);
  hub('tag', '--doing', 'Building the login API', '--as', 'backend');
  hub('tag', '--doing', 'Idle', '--as', 'frontend');
  hub('inbox', '--as', 'backend'); hub('inbox', '--as', 'frontend');
  const soon = Date.now() + 60 * 60 * 1000;
  core.recordLimit('backend', { resetsAt: soon });
  core.recordLimit('frontend', { resetsAt: soon });
  core.recordLimit('backend', { resetsAt: soon }); // a repeat in the same window adds nothing

  let s = (await json('GET', api('state'))).json;
  const limits = s.events.filter((e) => e.type === 'limit');
  assert.deepStrictEqual(limits.map((e) => e.from).sort(), ['backend', 'frontend']);
  assert.strictEqual(s.agents.find((a) => a.name === 'backend').limit.interrupted, true);
  assert.strictEqual(s.agents.find((a) => a.name === 'frontend').limit.interrupted, false);
  assert.doesNotMatch(hub('inbox', '--peek', '--as', 'frontend'), /LIMIT/); // notices are for the user, not agents

  const r = await json('POST', api('resume'), { hub: 'main' });
  assert.deepStrictEqual(r.json.resumed, ['backend']);
  assert.match(hub('inbox', '--as', 'backend'), /\[RESUME @main\] The user says your usage limit has reset[\s\S]*Building the login API[\s\S]*carry on/);
  assert.match(hub('inbox', '--as', 'frontend'), /Inbox empty/);

  // A limit whose reset passed is resumed by the hub itself.
  core.recordLimit('backend', { resetsAt: Date.now() - 2 * 60 * 1000 });
  const deadline = Date.now() + 5000;
  let out = '';
  while (Date.now() < deadline && !/RESUME/.test(out)) { await new Promise((res) => setTimeout(res, 250)); out = hub('inbox', '--as', 'backend'); }
  assert.match(out, /\[RESUME @main\] The hub says your usage limit has reset/);
  s = (await json('GET', api('state'))).json;
  assert.ok(s.agents.find((a) => a.name === 'backend').limit.resumed);
  hub('tag', '--doing', 'Idle', '--as', 'backend');
});

test('wipe needs the user to type the slug, then deletes everything', async () => {
  const run = (...args) => spawnSync(process.execPath, [HUB, ...args], { env, encoding: 'utf8' });
  const w = spawn(process.execPath, [HUB, 'wait', '--as', 'backend'], { env });
  const exited = new Promise((r) => w.on('exit', r));
  await new Promise((r) => setTimeout(r, 800));

  assert.match(hub('wipe'), new RegExp(`type the project name in the chat, exactly:\\s+${slug}`));
  assert.match(run('wipe', '--confirm', 'wrong').stderr, /must be exactly/);
  assert.match(run('wipe', '--confirm', slug).stderr, /has not typed/); // the agent alone can't confirm
  assert.ok(fs.existsSync(path.join(root, '.claude-hub', 'agents')));

  // The user types the slug as their own message; the prompt hook records it.
  const HOOK = path.join(__dirname, '..', 'hooks', 'hook.js');
  spawnSync(process.execPath, [HOOK], { env, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'S1', cwd: root, prompt: `  ${slug}\n` }) });
  assert.match(hub('wipe', '--confirm', slug), /Wiped/);
  await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error('listener survived the wipe')), 4000))]);

  assert.ok(!fs.existsSync(path.join(root, '.claude-hub')));
  assert.ok(!(await json('GET', '/api/projects')).json.projects.some((p) => p.slug === slug));
  assert.strictEqual((await req('GET', api('state'))).status, 404);
  assert.match(run('agents').stderr, /no Session Hub/);
  assert.ok(!fs.existsSync(path.join(root, '.claude-hub')), 'reading must not recreate the hub');

  hub('join', 'fresh', '--role', 'r', '--purpose', 'p'); // /hub starts over
  assert.match(hub('agents'), /fresh/);
  assert.doesNotMatch(hub('agents'), /backend/);
});
