#!/usr/bin/env node
'use strict';
// One entry point for every Claude Code hook event. Reads the hook JSON on stdin and
// does nothing unless the project has a .claude-hub folder.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createHub, findRoot, formatEvent, formatAgent } = require('../lib/core');
const registry = require('../lib/registry');

const HUB_CLI = path.join(__dirname, '..', 'bin', 'hub.js').split(path.sep).join('/');
const CLI = `node "${HUB_CLI}"`;
const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
const SHELL_TOOLS = ['Bash', 'PowerShell'];
const GUARD_RETRY_MS = 10 * 60 * 1000;
const DESTRUCTIVE = /(?:^|[\s;&|(])(?:git\s+(?:rm|mv|restore|checkout\s+--)|rm|rmdir|del|erase|rd|mv|move|Remove-Item|Move-Item|ri|mi)\s+([^;&|\n]+)/gi;

function out(obj) { process.stdout.write(JSON.stringify(obj)); }

function context(event, text) {
  out({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
}

function inboxText(items, me) {
  return `Session Hub: ${items.length} new item(s) for you (${me}). Deal with them before going on, unless your current step must finish first.\n\n` +
    items.map(formatEvent).join('\n\n');
}

function standingRule(me) {
  return `Session Hub (you are "${me}"): other sessions work in this project too. Before you change, move or delete anything you didn't write, ` +
    `or when something unexpected happens (files you don't recognise, changes you didn't make, tests breaking for no reason), ` +
    `run ${CLI} whois <path> --as ${me} and ask its owner, or post on the board, before acting.`;
}

function protocolReminder(hub, me) {
  const a = hub.getAgent(me);
  return `You are agent "${me}" in the Session Hub of this project (hubs: ${a.hubs.join(', ') || 'none'}). ` +
    `Run hub commands as: ${CLI} <command> ... --as ${me}. ` +
    `Keep the background listener running (${CLI} wait --as ${me}, run in the background) and restart it each time it exits. ` +
    `Before changing or deleting code you don't recognise, check ${CLI} whois <path> and ask its owner or the board.`;
}

// Paths a shell command would delete or move, resolved against cwd.
function destructiveTargets(command) {
  const targets = [];
  for (const m of command.matchAll(DESTRUCTIVE)) {
    for (const t of m[1].matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
      const tok = t[1] ?? t[2] ?? t[3];
      if (tok && !tok.startsWith('-')) targets.push(tok);
    }
  }
  return targets;
}

// Claims (by other agents) that the given paths would touch. A directory or glob covers what's under it.
function claimsHit(hub, paths, cwd, me) {
  const claims = hub.listClaims().filter((c) => c.agent !== me);
  if (!claims.length) return [];
  const hits = new Map();
  for (const p of paths) {
    const star = p.indexOf('*');
    const base = hub.claimKey(hub.relPath(star === -1 ? p : p.slice(0, star) || '.', cwd));
    if (base.startsWith('..')) continue;
    const prefix = star === -1 ? (base ? `${base}/` : '') : (base === '' ? '' : base);
    for (const c of claims) {
      const key = hub.claimKey(c.path);
      if (key === base || key.startsWith(prefix)) hits.set(c.path, c);
    }
  }
  return [...hits.values()];
}

function guard(hub, input, me) {
  const ti = input.tool_input || {};
  let paths = [];
  if (EDIT_TOOLS.includes(input.tool_name)) paths = [ti.file_path || ti.notebook_path].filter(Boolean);
  else if (SHELL_TOOLS.includes(input.tool_name)) paths = destructiveTargets(ti.command || '');
  if (!paths.length) return;

  const hits = claimsHit(hub, paths, input.cwd || hub.root, me);
  if (!hits.length) return;

  // Warn once: the same session repeating the same action within GUARD_RETRY_MS goes through.
  const key = crypto.createHash('sha1').update(`${input.session_id}|${hits.map((c) => c.path).sort().join('|')}`).digest('hex').slice(0, 16);
  const marker = path.join(hub.dir, 'guard', `${key}.json`);
  try {
    const prev = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (Date.now() - prev.ts < GUARD_RETRY_MS) { fs.rmSync(marker, { force: true }); return; }
  } catch { /* no marker */ }
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ ts: Date.now() }));

  const meAgent = me ? hub.getAgent(me) : null;
  const lines = hits.slice(0, 10).map((c) => {
    const owner = hub.getAgent(c.agent);
    const reach = meAgent && owner && !hub.shared(meAgent, owner).length ? ' (not in your hubs; ask the user)' : '';
    return `- ${c.path}: owned by ${c.agent}${reach}${c.note ? `, note: ${c.note}` : ''}` + (owner ? `\n  ${formatAgent(owner, hub.isOnline).replace(/\n/g, '\n  ')}` : '');
  });
  const ask = me ? `${CLI} send <owner> "<question>" --as ${me}` : 'the user';
  out({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `Session Hub ownership guard: this would change files another agent owns.\n${lines.join('\n')}` +
        `${hits.length > 10 ? `\n...and ${hits.length - 10} more` : ''}\n\n` +
        `If you aren't sure these changes are wanted, ask the owner first (${ask}). ` +
        'If you have confirmed they are right, repeat the exact same action and it will be allowed.',
    },
  });
}

// The join command prints `Joined the hub at <root> as "<name>"`. Matching its output works
// however the command was written (full path, a shell variable, an alias...).
function joinedAs(response) {
  const text = typeof response === 'string' ? response : JSON.stringify(response || '');
  const all = [...text.matchAll(/Joined the hub at .*? as \\?"([a-z0-9][a-z0-9-]*)\\?"/g)];
  return all.length ? all[all.length - 1][1] : null;
}

// Fallback for a session that never linked: a hub command run `--as <name>` says who it is.
function asFlag(command) {
  if (!/\bhub(\.js)?\b/.test(command || '')) return null;
  const m = /--as[=\s]+["']?([a-z0-9][a-z0-9-]*)/.exec(command);
  return m ? m[1] : null;
}

function onPostToolUse(hub, input, me) {
  const ti = input.tool_input || {};
  // Link this session to the agent it just joined as.
  if (SHELL_TOOLS.includes(input.tool_name)) {
    const name = joinedAs(input.tool_response) || (!me && asFlag(ti.command));
    if (name && name !== me && hub.getAgent(name)) { hub.mapSession(input.session_id, name); me = name; }
  }
  if (!me) return;
  hub.touch(me);

  if (EDIT_TOOLS.includes(input.tool_name)) {
    const file = ti.file_path || ti.notebook_path;
    if (file && !hub.relPath(file).startsWith('..')) {
      const c = hub.getClaim(file);
      if (!c) hub.setClaim(file, me, hub.getAgent(me).doing || '');
    }
  }

  const items = hub.takeUnread(me);
  if (items.length) context('PostToolUse', inboxText(items, me));
}

function onStop(hub, input, me) {
  if (!me) return;
  const items = hub.takeUnread(me);
  if (items.length) {
    out({ decision: 'block', reason: inboxText(items, me) });
    return;
  }
  if (!hub.isListening(me) && !input.stop_hook_active) {
    out({
      decision: 'block',
      reason: `Session Hub: your listener isn't running, so other agents can't wake you. ` +
        `Start it with the Bash tool, run_in_background: true: ${CLI} wait --as ${me} — then you can stop.`,
    });
  }
}

function main(raw) {
  let input;
  try { input = JSON.parse(raw); } catch { return; }
  const root = findRoot(input.cwd || process.cwd());
  if (!fs.existsSync(path.join(root, '.claude-hub'))) return;
  const hub = createHub(root);
  let me = hub.agentForSession(input.session_id);
  if (me && (!hub.getAgent(me) || hub.getAgent(me).left)) me = null; // unknown, or ran /hub-leave

  switch (input.hook_event_name) {
    case 'SessionStart':
      if (me) { hub.touch(me); context('SessionStart', protocolReminder(hub, me)); }
      break;
    case 'UserPromptSubmit':
      // Only the user can confirm a wipe: their own message must be exactly the project's slug.
      if (typeof input.prompt === 'string' && input.prompt.trim() === registry.slugFor(hub.root)) {
        hub.recordWipeConfirmation(input.session_id);
      }
      if (me) {
        hub.touch(me);
        const items = hub.takeUnread(me);
        // A standing rule on every user turn, so the hub stays in mind even after compaction.
        context('UserPromptSubmit', standingRule(me) + (items.length ? `\n\n${inboxText(items, me)}` : ''));
      }
      break;
    case 'PreToolUse':
      guard(hub, input, me);
      break;
    case 'PostToolUse':
      onPostToolUse(hub, input, me);
      break;
    case 'Stop':
      onStop(hub, input, me);
      break;
    case 'SessionEnd':
      if (me) hub.endSession(me);
      break;
    default:
  }
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  try { main(raw); } catch (e) { process.stderr.write(`session-hub hook: ${e.message}\n`); }
});
