'use strict';
// Shared by the home page and the project page: icons, small helpers, theme switch, camo texture.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Replace markup only when it changed, so hover states and running animations survive live updates.
function setHTML(el, html) { if (el._html === html) return false; el.innerHTML = html; el._html = html; return true; }

// ---------- icons (24px line set) ----------
const P = {
  home: '<path d="M4 11 12 4.5 20 11"/><path d="M6 9.5v10h12v-10"/><path d="M10 19.5v-5h4v5"/>',
  inbox: '<path d="M3.5 13.5 6 5h12l2.5 8.5V19a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z"/><path d="M3.5 13.5h5l1.5 2.5h4l1.5-2.5h5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  hubs: '<circle cx="12" cy="12" r="3"/><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="20" r="2"/><path d="m6.6 7.3 3.1 2.6M17.4 7.3l-3.1 2.6M12 15v3"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c2 .6 3.2 2.3 3.6 5.2"/>',
  userOut: '<circle cx="10" cy="8" r="3.5"/><path d="M3.5 20c.8-3.6 3.4-5.5 6.5-5.5 1.6 0 3 .5 4.2 1.4M16 18h6"/>',
  activity: '<path d="M3 12h4l3-7.5 4 15 3-7.5h4"/>',
  board: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M7.5 9.5h9M7.5 13.5h6"/>',
  chat: '<path d="M20 12.5a7.5 7.5 0 0 1-11 6.6L4 20l1-4.4A7.5 7.5 0 1 1 20 12.5z"/>',
  tasks: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="m8.5 12.2 2.4 2.4 4.6-5.1"/>',
  graph: '<circle cx="6" cy="6.5" r="2.5"/><circle cx="18" cy="7.5" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="m8.5 6.7 7 .6M7.2 8.8l3.6 6.9M16.8 9.8l-3.6 6"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  x: '<path d="m7 7 10 10M17 7 7 17"/>',
  check: '<circle cx="12" cy="12" r="8.5"/><path d="m8.3 12.4 2.5 2.5 5-5.3"/>',
  fail: '<circle cx="12" cy="12" r="8.5"/><path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  spin: '<circle cx="12" cy="12" r="8.5" opacity=".25"/><path class="spin" d="M20.5 12A8.5 8.5 0 0 0 12 3.5"/>',
  alert: '<path d="M12 4.5 3 19.5h18z"/><path d="M12 10.5v4M12 17.3v.2"/>',
  dot: '<circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none"/>',
  ring: '<circle cx="12" cy="12" r="4.5"/>',
  out: '<path d="M14 4.5h4a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-4M10 16l-4-4 4-4M6 12h10"/>',
  file: '<path d="M6.5 3.5h7.5l4 4v12.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5z"/><path d="M14 3.5V8h4"/>',
  arrow: '<path d="M5 12h14M13.5 6.5 19 12l-5.5 5.5"/>',
  chev: '<path d="m9.5 6 6 6-6 6"/>',
  down: '<path d="m6 9.5 6 6 6-6"/>',
  clip: '<rect x="5" y="4.5" width="14" height="16" rx="2.5"/><path d="M9 3.5h6v3H9zM8.5 11h7M8.5 15h5"/>',
  msg: '<path d="M4 5.5h16v10.5H9.5L4 20z"/>',
  post: '<path d="M4 10v4l11 4.5V5.5L4 10zM15 9h3a2 2 0 0 1 0 6h-3M7 14.5 8.5 20"/>',
  flag: '<path d="M5 21V4.5M5 5h11.5l-2 4 2 4H5"/>',
  me: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c.9-3.9 3.8-6 7.5-6s6.6 2.1 7.5 6"/>',
  send: '<path d="M4 12 20 4l-6 16-3-7z"/><path d="m11 13 9-9"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  crown: '<path d="m4 8 4 4 4-6 4 6 4-4-1.5 10h-13z"/>',
  folder: '<path d="M3.5 7a1.5 1.5 0 0 1 1.5-1.5h4.2l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18z"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  monitor: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20"/>',
};
const ic = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[n]}</svg>`;

// ---------- small helpers ----------
const tsOf = (ts) => (typeof ts === 'number' ? ts : Date.parse(ts));
function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - tsOf(ts)) / 1000));
  if (s < 60) return s < 10 ? 'just now' : `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
const clock = (ts) => new Date(tsOf(ts)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const term = (name, desc) => `<b title="${esc(String(desc).replace(/<[^>]*>/g, ''))}">${name}</b>`;

const EARTH = ['#3f7d4e', '#6b7f2a', '#2c7a74', '#8a6a3a', '#a8643a', '#4f7591', '#5f8a3c', '#7d5a74', '#99502f', '#37698a'];
function nameHash(name) { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
function initials(name) { const p = name.split('-'); return (p.length > 1 ? p[0][0] + p[1][0] : name.slice(0, 2)).toUpperCase(); }

function toast(msg) {
  const t = $('toast'); t.innerHTML = `${ic('check')}<span>${esc(msg)}</span>`; t.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- camo texture ----------
// Seamless tile of soft, irregular blobs in three tones close to the background. Drawn per theme.
// Each patch is a cluster of 2 to 4 lobes, so the shapes read as woodland camo rather than spots.
function camoTile(base, tones, size = 640, seed = 11) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = base; g.fillRect(0, 0, size, size);
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  function lobe(cx, cy, r, rot) {
    const k = 11 + Math.floor(rnd() * 5);
    const pts = [];
    for (let j = 0; j < k; j++) {
      const a = (j / k) * Math.PI * 2, rr = r * (0.5 + rnd() * 0.65);
      const x = Math.cos(a) * rr * 1.6, y = Math.sin(a) * rr * 0.75; // stretched
      pts.push([x * Math.cos(rot) - y * Math.sin(rot), x * Math.sin(rot) + y * Math.cos(rot)]);
    }
    for (const dx of [-size, 0, size]) for (const dy of [-size, 0, size]) { // wrap so the tile repeats without seams
      const q = pts.map(([x, y]) => [x + cx + dx, y + cy + dy]);
      g.beginPath();
      const m0 = mid(q[k - 1], q[0]);
      g.moveTo(m0[0], m0[1]);
      for (let j = 0; j < k; j++) { const m = mid(q[j], q[(j + 1) % k]); g.quadraticCurveTo(q[j][0], q[j][1], m[0], m[1]); }
      g.fill();
    }
  }
  tones.forEach((tone, layer) => {
    g.fillStyle = tone;
    const count = 16 - layer * 3;
    for (let i = 0; i < count; i++) {
      const cx = rnd() * size, cy = rnd() * size, rot = rnd() * Math.PI, r = size * (0.03 + rnd() * 0.035);
      const lobes = 2 + Math.floor(rnd() * 3);
      for (let l = 0; l < lobes; l++) {
        const along = (rnd() - 0.5) * r * 3.2, across = (rnd() - 0.5) * r * 1.2;
        lobe(cx + along * Math.cos(rot) - across * Math.sin(rot), cy + along * Math.sin(rot) + across * Math.cos(rot), r * (0.7 + rnd() * 0.5), rot + (rnd() - 0.5) * 0.9);
      }
    }
  });
  return c.toDataURL('image/png');
}

function paintCamo() {
  const css = getComputedStyle(document.documentElement);
  const v = (n) => css.getPropertyValue(n).trim();
  try {
    document.documentElement.style.setProperty('--camo', `url(${camoTile(v('--bg'), [v('--camo-a'), v('--camo-b'), v('--camo-c')])})`);
    document.documentElement.style.setProperty('--camo-side', `url(${camoTile(v('--side'), [v('--side-camo-a'), v('--side-camo-b'), v('--side-camo-c')], 640, 29)})`);
  } catch { /* canvas unavailable: plain colours still work */ }
}

// ---------- theme: system, light or dark ----------
const THEMES = ['system', 'light', 'dark'];
const THEME_ICON = { system: 'monitor', light: 'sun', dark: 'moon' };
const THEME_LABEL = { system: 'Theme follows your system', light: 'Light theme', dark: 'Dark theme' };
function getTheme() { try { return localStorage.getItem('hub-theme') || 'system'; } catch { return 'system'; } }
// Colours switch in one frame: transitions are off while the theme changes, so nothing is left half-changed.
function switchColours(change) {
  const root = document.documentElement;
  root.classList.add('theme-switching');
  change();
  paintCamo();
  void root.offsetWidth;
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
}
function applyTheme(t) {
  switchColours(() => {
    if (t === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  });
  const b = $('themeBtn');
  if (b) { b.innerHTML = ic(THEME_ICON[t]); b.title = `${THEME_LABEL[t]}. Click to change.`; b.setAttribute('aria-label', b.title); }
}
function initTheme() {
  applyTheme(getTheme());
  $('themeBtn')?.addEventListener('click', () => {
    const next = THEMES[(THEMES.indexOf(getTheme()) + 1) % THEMES.length];
    try { localStorage.setItem('hub-theme', next); } catch { /* not saved, still applied */ }
    applyTheme(next);
    toast(THEME_LABEL[next]);
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (getTheme() === 'system') switchColours(() => {}); });
}
