'use strict';
// Feeds hook JSON to hooks/hook.js the way Claude Code does. Run: node --test test/
const { test, before } = require('node:test');
const assert = require('node:assert');
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', 'hooks', 'hook.js');
const HUB = path.join(__dirname, '..', 'bin', 'hub.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-hooks-'));
fs.mkdirSync(path.join(root, '.git'));
const env = { ...process.env, HUB_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'hub-home-')), HUB_NO_SERVER: '1' };
delete env.HUB_ROOT;

function hub(...args) {
  const r = spawnSync(process.execPath, [HUB, ...args], { cwd: root, env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout;
}

function hook(input, cwd = root) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd, ...input }), env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stderr, '');
  return r.stdout ? JSON.parse(r.stdout) : null;
}

// Real sessions often run the CLI through a shell variable, so the link must come from the output.
const joinCmd = (name) => `H="C:/x/bin/hub.js"; node "$H" agents; node "$H" join ${name} --role "r" --purpose "p"`;

function link(session, name) {
  const stdout = hub('join', name, '--role', `${name} role`, '--purpose', `${name} purpose`);
  hook({ hook_event_name: 'PostToolUse', session_id: session, tool_name: 'Bash', tool_input: { command: joinCmd(name) }, tool_response: { stdout, stderr: '', interrupted: false } });
}

test('a session that never linked is linked by a hub command run --as its name', () => {
  hub('join', 'late', '--role', 'r', '--purpose', 'p');
  hook({ hook_event_name: 'PostToolUse', session_id: 'S-late', tool_name: 'Bash', tool_input: { command: 'H="C:/x/bin/hub.js"; node "$H" inbox --as late' }, tool_response: { stdout: '' } });
  const sessions = fs.readdirSync(path.join(root, '.claude-hub', 'sessions')).map((f) => fs.readFileSync(path.join(root, '.claude-hub', 'sessions', f), 'utf8'));
  assert.ok(sessions.some((s) => s.includes('late')));
  hub('quit', '--as', 'late');
});

before(() => {
  link('S-backend', 'backend');
  link('S-frontend', 'frontend');
});

test('does nothing in a project without a hub', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-bare-'));
  assert.strictEqual(hook({ hook_event_name: 'Stop', session_id: 'x' }, bare), null);
  assert.strictEqual(hook({ hook_event_name: 'PreToolUse', session_id: 'x', tool_name: 'Bash', tool_input: { command: 'rm -rf .' } }, bare), null);
  assert.ok(!fs.existsSync(path.join(bare, '.claude-hub')));
});

test('unlinked sessions get nothing injected', () => {
  hub('send', 'frontend', 'for frontend', '--as', 'backend');
  assert.strictEqual(hook({ hook_event_name: 'UserPromptSubmit', session_id: 'S-unknown' }), null);
});

test('PostToolUse delivers unread items once', () => {
  const r = hook({ hook_event_name: 'PostToolUse', session_id: 'S-frontend', tool_name: 'Read', tool_input: {} });
  assert.strictEqual(r.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(r.hookSpecificOutput.additionalContext, /1 new item\(s\) for you \(frontend\)[\s\S]*for frontend/);
  assert.strictEqual(hook({ hook_event_name: 'PostToolUse', session_id: 'S-frontend', tool_name: 'Read', tool_input: {} }), null);
});

test('UserPromptSubmit delivers unread items', () => {
  hub('post', 'board news', '--as', 'backend');
  const r = hook({ hook_event_name: 'UserPromptSubmit', session_id: 'S-frontend' });
  assert.match(r.hookSpecificOutput.additionalContext, /\[BOARD @main\] backend -> board[\s\S]*board news/);
});

test('every user turn carries the standing rule to ask before touching unfamiliar work', () => {
  const r = hook({ hook_event_name: 'UserPromptSubmit', session_id: 'S-frontend' });
  assert.match(r.hookSpecificOutput.additionalContext, /you are "frontend"[\s\S]*didn't write[\s\S]*whois[\s\S]*board/);
  assert.doesNotMatch(r.hookSpecificOutput.additionalContext, /new item/); // nothing unread this time
});

test('StopFailure records a usage limit with the reset time from the message; other errors are ignored', () => {
  const core = require('../lib/core');
  hook({ hook_event_name: 'StopFailure', session_id: 'S-backend', error: 'server_error', last_assistant_message: 'API Error: 500' });
  assert.ok(!core.createHub(root).getAgent('backend').limit);

  hook({ hook_event_name: 'StopFailure', session_id: 'S-backend', error: 'rate_limit', last_assistant_message: 'You’ve hit your session limit · resets 3:45pm' });
  const l = core.createHub(root).getAgent('backend').limit;
  assert.ok(l, 'limit recorded');
  const at = new Date(l.resetsAt);
  assert.strictEqual(`${at.getHours()}:${at.getMinutes()}`, '15:45');
  assert.ok(l.resetsAt > Date.now() && l.resetsAt - Date.now() <= 24 * 3600 * 1000);

  // Once the reset has passed, the agent's next turn clears it.
  const h = core.createHub(root);
  const a = h.getAgent('backend'); a.limit.resetsAt = Date.now() - 1000;
  require('fs').writeFileSync(require('path').join(root, '.claude-hub', 'agents', 'backend.json'), JSON.stringify(a));
  hook({ hook_event_name: 'UserPromptSubmit', session_id: 'S-backend' });
  assert.ok(core.createHub(root).getAgent('backend').limit.resumed);
});

test('the reset parser reads times, weekdays and epochs', () => {
  const { parseLimitReset: p } = require('../lib/core');
  const now = new Date(2026, 10, 5, 14, 0).getTime(); // a Thursday, 2 pm
  const hm = (t) => { const d = new Date(p(t, now)); return [d.getDate(), d.getHours(), d.getMinutes()]; };
  assert.deepStrictEqual(hm('resets 3:45pm'), [5, 15, 45]);
  assert.deepStrictEqual(hm('resets 1pm'), [6, 13, 0]); // already past today, so tomorrow
  assert.deepStrictEqual(hm('resets Mon 12:00am'), [9, 0, 0]);
  assert.strictEqual(p('usage limit reached|1793869200', now), 1793869200000);
  assert.strictEqual(p('429 Too Many Requests', now), null);
});

test('a session that left goes quiet and cannot be added back except by /hub', () => {
  link('S-tmp', 'tmpagent');
  hub('quit', '--as', 'tmpagent');
  assert.strictEqual(hook({ hook_event_name: 'UserPromptSubmit', session_id: 'S-tmp' }), null); // left: hooks ignore it
  assert.throws(() => require('../lib/core').createHub(root).addToHub('tmpagent', 'main', 'user'), /has left/);
  link('S-tmp', 'tmpagent'); // /hub again
  assert.match(hook({ hook_event_name: 'UserPromptSubmit', session_id: 'S-tmp' }).hookSpecificOutput.additionalContext, /you are "tmpagent"/);
  hub('quit', '--as', 'tmpagent');
});

test('Stop blocks while items are unread, then asks for the listener once', () => {
  hub('send', 'frontend', 'late news', '--as', 'backend');
  const first = hook({ hook_event_name: 'Stop', session_id: 'S-frontend' });
  assert.strictEqual(first.decision, 'block');
  assert.match(first.reason, /late news/);

  const second = hook({ hook_event_name: 'Stop', session_id: 'S-frontend' });
  assert.strictEqual(second.decision, 'block');
  assert.match(second.reason, /listener isn't running[\s\S]*wait --as frontend/);

  assert.strictEqual(hook({ hook_event_name: 'Stop', session_id: 'S-frontend', stop_hook_active: true }), null);
});

test('Stop lets the session go idle while its listener runs', async () => {
  const child = spawn(process.execPath, [HUB, 'wait', '--as', 'frontend'], { cwd: root, env });
  await new Promise((r) => setTimeout(r, 800));
  try {
    assert.strictEqual(hook({ hook_event_name: 'Stop', session_id: 'S-frontend' }), null);
  } finally { child.kill(); }
});

test('edits auto-claim files for the editing agent, without stealing claims', () => {
  const file = path.join(root, 'src', 'api.ts');
  hook({ hook_event_name: 'PostToolUse', session_id: 'S-backend', tool_name: 'Write', tool_input: { file_path: file } });
  assert.match(hub('whois', file), /claimed by backend/);
  hook({ hook_event_name: 'PostToolUse', session_id: 'S-frontend', tool_name: 'Edit', tool_input: { file_path: file } });
  assert.match(hub('whois', file), /claimed by backend/);
});

test('guard blocks editing another agent\'s file once, then allows the retry', () => {
  const file = path.join(root, 'src', 'api.ts');
  const input = { hook_event_name: 'PreToolUse', session_id: 'S-frontend', tool_name: 'Edit', tool_input: { file_path: file } };
  const r = hook(input);
  assert.strictEqual(r.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /src\/api.ts: owned by backend[\s\S]*role: {4}backend role[\s\S]*send <owner>.*--as frontend/);
  assert.strictEqual(hook(input), null, 'retry should be allowed');
  assert.ok(hook(input), 'warns again after the retry was used');
  hook(input);
});

test('guard leaves the owner alone', () => {
  const file = path.join(root, 'src', 'api.ts');
  assert.strictEqual(hook({ hook_event_name: 'PreToolUse', session_id: 'S-backend', tool_name: 'Edit', tool_input: { file_path: file } }), null);
});

test('guard catches shell deletes of claimed files, folders and globs', () => {
  const run = (session, command, tool = 'Bash') => hook({ hook_event_name: 'PreToolUse', session_id: session, tool_name: tool, tool_input: { command } });
  for (const [i, cmd] of ['rm src/api.ts', 'rm -rf src', 'rm -rf "src"/*', 'git rm -r src', 'echo hi && del src\\api.ts'].entries()) {
    const r = run(`S-shell-${i}`, cmd);
    assert.ok(r, `not caught: ${cmd}`);
    assert.match(r.hookSpecificOutput.permissionDecisionReason, /src\/api.ts: owned by backend/, cmd);
  }
  assert.ok(run('S-shell-ps', 'Remove-Item -Recurse src', 'PowerShell'));
  assert.strictEqual(run('S-shell-x', 'rm -rf docs'), null);
  assert.strictEqual(run('S-shell-y', 'ls src'), null);
});

test('SessionStart reminds a linked session who it is; SessionEnd marks it offline', () => {
  const r = hook({ hook_event_name: 'SessionStart', session_id: 'S-backend', source: 'compact' });
  assert.match(r.hookSpecificOutput.additionalContext, /You are agent "backend"[\s\S]*wait --as backend/);
  hook({ hook_event_name: 'SessionEnd', session_id: 'S-backend' });
  assert.match(hub('agents'), /backend \[offline/);
  hook({ hook_event_name: 'UserPromptSubmit', session_id: 'S-backend' });
  assert.match(hub('agents'), /backend \[online/);
});
