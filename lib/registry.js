'use strict';
// Machine-wide list of projects that use Session Hub, and the one web server that shows them all.
// Lives in ~/.claude-session-hub/ (HUB_HOME overrides it, for tests):
//   projects/<slug>.json   { slug, root, name, registered }
//   server.json            { pid, port, url, started }

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { readJson, writeJson, pidAlive } = require('./core');

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

const home = () => (process.env.HUB_HOME ? path.resolve(process.env.HUB_HOME) : path.join(os.homedir(), '.claude-session-hub'));
const projectsDir = () => path.join(home(), 'projects');
const serverFile = () => path.join(home(), 'server.json');

// Windows paths are case-insensitive, so C:\X and c:\x are the same project.
const keyOf = (root) => { const r = path.resolve(root); return process.platform === 'win32' ? r.toLowerCase() : r; };

// Readable and unique: the folder name plus 4 hex characters from the full path.
function slugFor(root) {
  const base = path.basename(path.resolve(root)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
  return `${base}-${crypto.createHash('sha1').update(keyOf(root)).digest('hex').slice(0, 4)}`;
}

function register(root) {
  const slug = slugFor(root);
  const file = path.join(projectsDir(), `${slug}.json`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(projectsDir(), { recursive: true });
    writeJson(file, { slug, root: path.resolve(root), name: path.basename(path.resolve(root)), registered: new Date().toISOString() });
  }
  return slug;
}

function unregister(root) {
  fs.rmSync(path.join(projectsDir(), `${slugFor(root)}.json`), { force: true });
}

// A project whose .claude-hub folder is gone (wiped, or the project was deleted) is dropped.
function find(slug) {
  if (!SLUG_RE.test(slug || '')) return null;
  const p = readJson(path.join(projectsDir(), `${slug}.json`));
  if (!p) return null;
  if (!fs.existsSync(path.join(p.root, '.claude-hub'))) { unregister(p.root); return null; }
  return p;
}

function list() {
  if (!fs.existsSync(projectsDir())) return [];
  return fs.readdirSync(projectsDir()).filter((f) => f.endsWith('.json'))
    .map((f) => find(f.slice(0, -5))).filter(Boolean);
}

function serverInfo() {
  const s = readJson(serverFile());
  return s && pidAlive(s.pid) ? s : null;
}

module.exports = { home, slugFor, register, unregister, find, list, serverFile, serverInfo, SLUG_RE };
