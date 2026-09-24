// The polyphemus phone app. Home (what needs you), Projects, Team, and You, plus each session's
// live conversation (docs/design/app.md). Plain JavaScript, no build step, served by the daemon.

const $ = (selector) => document.querySelector(selector);
const NS = 'http://www.w3.org/2000/svg';

/** Creates an element: h('button', { class: 'x', onclick }, 'text', child). */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') el.className = value;
    // Not setAttribute: a style attribute is inline CSS, and the app's Content-Security-Policy is
    // default-src 'self' with no unsafe-inline, so the browser drops it. Setting each property
    // through the CSSOM is the same result and isn't inline.
    else if (key === 'style') for (const rule of String(value).split(';')) {
      const at = rule.indexOf(':');
      if (at > 0) el.style.setProperty(rule.slice(0, at).trim(), rule.slice(at + 1).trim());
    }
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (value === true) el.setAttribute(key, '');
    else if (value !== false && value != null) el.setAttribute(key, value);
  }
  return fill(el, children);
}

/**
 * Puts children in a node, replacing what was there. The DOM's own replaceChildren prints "null"
 * for a child that isn't there, which is how a stray "null" turns up under a button; this drops
 * those, and flattens nested lists, the way h() does. Everything in the app fills through here.
 */
function fill(node, ...children) {
  node.textContent = '';
  // Screens nest lists of children (sections of cards); flatten all the way down.
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// ── Icons and marks (fixed strings only) ─────────────────────────────────

const ICONS = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  copy: '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/>',
  home: '<path d="M4 11 12 4l8 7v8.5a.5.5 0 0 1-.5.5H15v-6H9v6H4.5a.5.5 0 0 1-.5-.5z"/>',
  projects: '<rect x="3.5" y="4" width="17" height="6.5" rx="2"/><rect x="3.5" y="13.5" width="17" height="6.5" rx="2"/>',
  team: '<circle cx="9" cy="9" r="3.4"/><circle cx="17" cy="10" r="2.6"/><path d="M3 19.5c.9-3.1 3.2-4.7 6-4.7s5.1 1.6 6 4.7M15.6 14.8c2.2.1 3.9 1.4 4.6 3.9"/>',
  // Setup is settings, not a person (finding-your-way decisions): two tracks with a knob on each.
  you: '<path d="M4 7.5h8.5M17.5 7.5H20M4 16.5h2.5M11.5 16.5H20"/><circle cx="15" cy="7.5" r="2.5"/><circle cx="9" cy="16.5" r="2.5"/>',
  send: '<path d="M5 12 19 5l-4 14-3.5-5.5z"/><path d="M11.5 13.5 19 5"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
  thread: '<path d="M5 6.5h14M5 12h14M5 17.5h8"/>',
  direct: '<path d="M20 12a7.5 7.5 0 0 1-7.5 7.5c-1.2 0-2.4-.3-3.4-.8L4.5 20l1.3-4.2A7.5 7.5 0 1 1 20 12Z"/>',
  bank: '<path d="M4 10h16M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18M12 3.5 20.5 8h-17Z"/>',
  // Collapsing: the rows fold up to the heading. Expanding: they open back out.
  collapse: '<path d="M4 5h16M4 19h16M9.5 14.5 12 12l2.5 2.5M9.5 9.5 12 12l2.5-2.5"/>',
  expand: '<path d="M4 5h16M4 19h16M9.5 11 12 8.5l2.5 2.5M9.5 13 12 15.5l2.5-2.5"/>',
  doc: '<path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10.5a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5z"/><path d="M14 3.5V8h4M9 12h6M9 15.5h6"/>',
  inbox: '<path d="M4 13.5 6.6 6h10.8L20 13.5V18a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M4 13.5h4.5l1 2h5l1-2H20"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>',
  auto: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none"/>',
  phone: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/>',
  screen: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20"/>',
  spark: '<path d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4M6 6l2.6 2.6M15.4 15.4 18 18M6 18l2.6-2.6M15.4 8.6 18 6"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
  smile: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 14.2a4.3 4.3 0 0 0 7 0"/><circle cx="9.3" cy="10" r="0.6" fill="currentColor"/><circle cx="14.7" cy="10" r="0.6" fill="currentColor"/>',
  clip: '<path d="M20 11.5 12.5 19a5 5 0 0 1-7-7l8-8a3.3 3.3 0 0 1 4.7 4.7l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.3-7.3"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.7"/><path d="m4 17.5 5-4.5 4 3.5 2.5-2 4.5 3.5"/>',
  close: '<path d="M7 7l10 10M17 7 7 17"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/>',
  more: '<circle cx="6" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18" cy="12" r="1.3"/>',
};

function icon(name, cls = 'ico') {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name];
  return svg;
}

/**
 * The Polyphemus mark on its tile: one eye — a ring with a pupil, and the stroke that used to run
 * straight through the old mark now running out either side of it (docs/brand). It's drawn at
 * 28–40px, so it's the small variant — heavier stroke, bigger pupil — as the brand rules ask below
 * 32px, and in the brand's own colours rather than the theme's.
 */
function logo() {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    '<rect width="32" height="32" rx="8" fill="#1A1A18"/><g transform="translate(4,7) scale(0.25)" fill="none" stroke="#FF4B1F" stroke-width="13" stroke-linecap="round"><circle cx="48" cy="36" r="24.5"/><path d="M6.5,36 H17.5"/><path d="M78.5,36 H89.5"/></g><circle cx="16" cy="16" r="2.25" fill="#FF4B1F"/>';
  return svg;
}

// A mark is a shape and a colour with one visor slit — how you tell twenty agents apart in a
// list. An agent carries its own (picked, or the one its name gets: roster.ts decides, never
// this file). A thread that isn't an agent's falls back to its provider's mark.
// MARK_SHAPES and MARK_COLORS must match roster.ts — a test holds the two lists together.
const SHAPES = {
  circle: '<circle cx="24" cy="24" r="20.5"/>',
  square: '<rect x="4.5" y="4.5" width="39" height="39" rx="12"/>',
  pill: '<rect x="2.5" y="10.5" width="43" height="27" rx="13.5"/>',
  diamond: '<path d="M24 3.5 44.5 24 24 44.5 3.5 24z"/>',
  hex: '<path d="M24 3.5 42 14v20L24 44.5 6 34V14z"/>',
  tri: '<path d="M24 6 43 40.5H5z"/>',
  cloud: '<path d="M14 39a10 10 0 0 1-.7-20 12.5 12.5 0 0 1 23.2 2.1A9 9 0 0 1 34.5 39z"/>',
  drop: '<path d="M24 4c7.5 9.5 14 15.5 14 22.5a14 14 0 0 1-28 0C10 19.5 16.5 13.5 24 4z"/>',
};
// Where the visor sits: shapes that taper at the top wear it lower.
const SLIT_Y = { tri: 26, drop: 24, cloud: 24, pill: 21 };
const MARK_SHAPES = ['circle', 'square', 'pill', 'diamond', 'hex', 'tri', 'cloud', 'drop'];
const MARK_COLORS = ['slate', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'violet', 'pink'];
const MARK_HEX = {
  slate: '#5B6475',
  red: '#D9534F',
  orange: '#E2612F',
  amber: '#E98A12',
  green: '#1FA866',
  teal: '#0F9F90',
  blue: '#3E7BFA',
  indigo: '#5B5BD6',
  violet: '#8A5CF6',
  pink: '#E0439B',
};
const PROVIDER_MARKS = {
  'claude-code': { shape: 'hex', color: '#D9774B' },
  anthropic: { shape: 'hex', color: '#B65F3B' },
  codex: { shape: 'circle', color: '#1FA37A' },
  openai: { shape: 'circle', color: '#16835F' },
  'grok-build': { shape: 'tri', color: '#5B6475' },
  xai: { shape: 'tri', color: '#3E4654' },
};
/** A provider keeps its own mark; a name with none gets one, the same way roster.ts does. */
const markSpec = (what) => {
  if (what && typeof what === 'object') return { shape: what.shape, color: MARK_HEX[what.color] ?? MARK_HEX.slate };
  if (PROVIDER_MARKS[what]) return PROVIDER_MARKS[what];
  const spec = defaultMark(String(what));
  return { shape: spec.shape, color: MARK_HEX[spec.color] };
};

/** What a name is shown as when it hasn't said: "release-manager" → "Release Manager". */
const titleFromName = (name) => name.replace(/(^|-)([a-z])/g, (_, dash, letter) => (dash ? ' ' : '') + letter.toUpperCase());

/** The mark a name gets when nobody picked one. Mirrors defaultMark in roster.ts. */
function defaultMark(name) {
  let shapeSum = 0;
  let colorSum = 0;
  for (let i = 0; i < name.length; i++) {
    shapeSum += name.charCodeAt(i);
    colorSum += name.charCodeAt(i) * (i + 1);
  }
  return { shape: MARK_SHAPES[shapeSum % MARK_SHAPES.length], color: MARK_COLORS[colorSum % MARK_COLORS.length] };
}

/**
 * `what` is an agent's {shape, color}, or a provider or name to derive one from. `bare` leaves
 * off the visor: in the shape picker you're comparing silhouettes, and the visor is the part
 * they all have in common.
 */
function mark(what, size = 44, bare = false) {
  const spec = markSpec(what);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 48 48');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.style.flex = 'none';
  const body = `<g fill="${spec.color}" stroke="${spec.color}" stroke-width="4" stroke-linejoin="round">${SHAPES[spec.shape] ?? SHAPES.circle}</g>`;
  const visor = `<rect class="visor" x="15" y="${SLIT_Y[spec.shape] ?? 18}" width="18" height="5.5" rx="2.75" fill="#fff"/>`;
  svg.innerHTML = bare ? body : body + visor;
  return svg;
}

/**
 * Pick a shape and a colour. `onpick` fires only when a person taps one — never when the picker
 * is redrawn or set from outside — so a caller can tell "they chose this" from "this is just the
 * default", and only write a mark into the file when it was actually chosen.
 */
function markPicker(current, onpick) {
  let picked = { ...current };
  const preview = h('div', { class: 'mark-preview' }, mark(picked, 84));
  const draw = () => {
    fill(preview, mark(picked, 84));
    for (const button of shapes) {
      button.setAttribute('aria-pressed', String(button.dataset.shape === picked.shape));
      // The shape buttons wear the colour you're on, so you're choosing between real options.
      fill(button, mark({ shape: button.dataset.shape, color: picked.color }, 40, true));
    }
    for (const swatch of colors) swatch.setAttribute('aria-pressed', String(swatch.dataset.color === picked.color));
  };
  const choose = (part) => {
    picked = { ...picked, ...part };
    draw();
    onpick(picked);
  };
  const shapes = MARK_SHAPES.map((shape) =>
    h('button', { type: 'button', class: 'pick-shape', 'data-shape': shape, 'aria-label': shape, title: shape, onclick: () => choose({ shape }) }),
  );
  const colors = MARK_COLORS.map((color) => {
    const swatch = h('button', { type: 'button', class: 'pick-color', 'data-color': color, 'aria-label': color, title: color, onclick: () => choose({ color }) });
    swatch.style.background = MARK_HEX[color];
    return swatch;
  });
  draw();
  return {
    node: h('div', { class: 'mark-pick' }, preview, h('div', { class: 'pick-row' }, shapes), h('div', { class: 'pick-row' }, colors)),
    /** Show a different mark without claiming anyone picked it. */
    set: (next) => ((picked = { ...next }), draw()),
  };
}

const PROJECT_COLORS = ['#E98A12', '#0F9F90', '#3E7BFA', '#E0439B', '#8A5CF6', '#1FA866', '#D9534F'];
function squircle(project, size = 48) {
  const hash = [...project.slug].reduce((sum, c) => sum + c.charCodeAt(0), 0);
  const words = project.name.split(/\s+/).filter(Boolean);
  const initials = words.length > 1 ? `${words[0][0]}${words[1][0]}` : project.name.slice(0, 1);
  const el = h('span', { class: 'squircle' }, initials.toUpperCase());
  el.style.background = PROJECT_COLORS[hash % PROJECT_COLORS.length];
  el.style.width = el.style.height = `${size}px`;
  if (size < 40) {
    el.style.fontSize = `${Math.max(8, Math.round(size * 0.38))}px`;
    el.style.borderRadius = `${Math.round(size * 0.3)}px`;
  }
  return el;
}

// ── Data ─────────────────────────────────────────────────────────────────

let state = { sessions: [], models: [], projects: [], questions: [], capacity: [], devices: [], push: {} };
/** Notifications on this device: 'on', 'off' (can be turned on), 'insecure' (needs the https address), 'blocked', or 'unsupported'. */
let push = 'unsupported';
/** Why turning notifications on last failed; stays on screen (and in the daemon's log) until it works. */
let pushProblem = '';
let live = false;
/** A CLI sign-in running now: where to put the lines it prints. */
let signingIn = null;
/** A vendor CLI being installed from this screen: whose, where its output goes, what to do after. */
let installing = null;
/** Setup was skipped this visit, so Models is Models rather than a way back into setup. */
let setupSkipped = false;
/** The CLI just installed or signed in from setup: picked for you when setup redraws. */
let setupPick = null;

/** The screen being shown, from the address (#/p/polyphemus, #/s/3cdf80b3, …). */
let view = { name: 'home' };
/** The open session's details, while a session is on screen. */
let current = null;
/** The reply bubble text is streaming into, per agent: more than one can answer at a time. */
const streaming = new Map();
/** How many screens deep we've gone inside the app, so Back never leaves it. */
let depth = 0;

const STATUS_LINE = /<polyphemus_status>[\s\S]*?<\/polyphemus_status>\s*/g;
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** fetch, with the browser's "Failed to fetch" said as what it means and what to do. */
/** A key no other request will have: crypto.randomUUID only exists over HTTPS, and a tailnet address may not be. */
function onceKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * fetch, riding out a blink in the network. Chrome cancels a request in flight whenever this
 * computer's network changes, which a Docker container starting is enough for; a machine starting
 * them every few seconds turned typing a message into "Failed to fetch" (2026-09-23). So it tries
 * again, quietly, for a couple of seconds. An action carries a key, and the daemon answers a retry of
 * it with the first answer, so nothing is ever done twice.
 */
function reach(path, init = {}) {
  const method = (init.method ?? 'GET').toUpperCase();
  const sent = method === 'GET' ? init : { ...init, headers: { ...(init.headers ?? {}), 'Idempotency-Key': onceKey() } };
  const attempt = (tries) =>
    fetch(path, sent).catch(() => {
      if (tries < 4 && navigator.onLine !== false) return new Promise((r) => setTimeout(r, [250, 750, 1500, 3000][tries])).then(() => attempt(tries + 1));
      throw Object.assign(new Error(navigator.onLine === false ? 'You’re offline. Try again once you’re back.' : 'Couldn’t reach Polyphemus. Check that Tailscale is on, or wait a moment if it’s restarting, and try again.'), { status: 0 });
    });
  return attempt(0);
}

async function api(path, body, method) {
  const init =
    body === undefined && !method
      ? {}
      : { method: method ?? 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) };
  const res = await reach(path, init);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) location.reload(); // unpaired or revoked: the server shows how to pair
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
  return data;
}

// ── Images ───────────────────────────────────────────────────────────────

const MAX_IMAGES = 6;

/** Phone photos are shrunk to what models use (about 1600px on the long side); small screenshots go as they are. */
async function prepareImage(file) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error(`${file.name || 'That file'} isn’t an image polyphemus can send (PNG, JPEG, GIF, or WebP).`);
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap || file.type === 'image/gif') return file;
  const longest = Math.max(bitmap.width, bitmap.height);
  if (file.size <= 1.5 * 1024 * 1024 && longest <= 2000) return file;
  const scale = Math.min(1, 1600 / longest);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return (await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))) ?? file;
}

/** Sends an image's bytes to the daemon; the id it returns goes with the message. */
async function uploadImage(file) {
  const body = await prepareImage(file);
  const res = await reach('/api/images', { method: 'POST', headers: { 'Content-Type': body.type, 'X-File-Name': encodeURIComponent(file.name || 'image') }, body });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) location.reload();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data.id;
}

const MAX_FILES = 10;
const MAX_FILE_MB = 50;

/** Any other file: its bytes go to the daemon, which puts it in the thread's folder when the message is sent. */
async function uploadFile(file) {
  if (file.size > MAX_FILE_MB * 1024 * 1024) throw new Error(`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB; attach up to ${MAX_FILE_MB} MB.`);
  const res = await reach('/api/files', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name || 'file') }, body: file });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) location.reload();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data.id;
}

/**
 * The attach button and the row of what's waiting to go with the next message. A picture goes to
 * the model to look at; any other file — a statement, a spreadsheet — lands in the thread's folder
 * for the agent to open. Pasting an image into `input` adds it too.
 */
function attachments(input) {
  let items = [];
  const strip = h('div', { class: 'attach-strip', hidden: true });
  const picker = h('input', { type: 'file', multiple: true, hidden: true });
  const remove = (item) => {
    items = items.filter((x) => x !== item);
    if (item.url) URL.revokeObjectURL(item.url);
    draw();
  };
  const draw = () => {
    strip.hidden = items.length === 0;
    fill(strip, 
      ...items.map((item) =>
        item.kind === 'file'
          ? h(
              'div',
              { class: `file-chip${item.id ? '' : ' uploading'}`, title: item.name },
              icon('doc', 'ico mini'),
              h('span', {}, item.name),
              h('button', { type: 'button', class: 'thumb-x', 'aria-label': `Remove ${item.name}`, onclick: () => remove(item) }, icon('close', 'ico mini')),
            )
          : h(
              'div',
              { class: `thumb${item.id ? '' : ' uploading'}` },
              h('img', { src: item.url, alt: item.name }),
              h('button', { type: 'button', class: 'thumb-x', 'aria-label': `Remove ${item.name}`, onclick: () => remove(item) }, icon('close', 'ico mini')),
            ),
      ),
    );
  };
  const add = async (files) => {
    for (const file of files) {
      const kind = /^image\/(png|jpeg|gif|webp)$/.test(file.type) ? 'image' : 'file';
      if (items.filter((x) => x.kind === kind).length >= (kind === 'image' ? MAX_IMAGES : MAX_FILES)) {
        toast(kind === 'image' ? `Up to ${MAX_IMAGES} images per message.` : `Up to ${MAX_FILES} files per message.`, 'error');
        continue;
      }
      const item = { kind, url: kind === 'image' ? URL.createObjectURL(file) : '', name: file.name || kind, id: null };
      items.push(item);
      draw();
      try {
        item.id = await (kind === 'image' ? uploadImage(file) : uploadFile(file));
        draw();
      } catch (err) {
        remove(item);
        showError(err);
      }
    }
  };
  picker.addEventListener('change', () => {
    add([...picker.files]);
    picker.value = '';
  });
  // Dragging files from a desktop: anywhere on the page will do, and the message box says so while
  // they're over it — a marching dashed ring and "Drop to attach" — so the drop has somewhere to go
  // rather than the browser opening the file in place of the app.
  if (input) {
    let depth = 0;
    const carriesFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    const showing = (on) => {
      const box = input.closest('.box');
      if (!box) return;
      if (on && !box.querySelector('.drop-ring')) {
        const ring = document.createElementNS(NS, 'svg');
        ring.setAttribute('class', 'drop-ring');
        ring.setAttribute('aria-hidden', 'true');
        ring.innerHTML = '<rect x="1" y="1" rx="25" ry="25"/>';
        box.append(ring, h('span', { class: 'drop-label' }, 'Drop to attach'));
      }
      box.classList.toggle('dropping', on);
    };
    const gone = () => {
      if (input.isConnected) return false;
      for (const [type, fn] of listeners) window.removeEventListener(type, fn);
      return true;
    };
    const listeners = [
      ['dragenter', (e) => {
        if (gone() || !carriesFiles(e)) return;
        depth++;
        showing(true);
      }],
      ['dragleave', (e) => {
        if (gone() || !carriesFiles(e)) return;
        depth = Math.max(0, depth - 1);
        if (!depth) showing(false);
      }],
      ['dragover', (e) => {
        if (!gone() && carriesFiles(e)) e.preventDefault();
      }],
      ['drop', (e) => {
        if (gone()) return;
        depth = 0;
        showing(false);
        const files = [...(e.dataTransfer?.files ?? [])];
        if (!files.length) return;
        e.preventDefault();
        add(files);
      }],
    ];
    for (const [type, fn] of listeners) window.addEventListener(type, fn);
  }
  input?.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    add(files);
  });
  const pick = () => picker.click();
  return {
    strip,
    picker,
    pick,
    button: h('button', { type: 'button', class: 'round', 'aria-label': 'Attach pictures or files', title: 'Attach pictures or files', onclick: pick }, icon('clip')),
    busy: () => items.some((item) => !item.id),
    ids: () => items.filter((item) => item.kind === 'image').map((item) => ({ id: item.id, name: item.name })),
    files: () => items.filter((item) => item.kind === 'file').map((item) => ({ id: item.id, name: item.name })),
    clear: () => {
      for (const item of items) if (item.url) URL.revokeObjectURL(item.url);
      items = [];
      draw();
    },
  };
}

function ago(ts) {
  const minutes = Math.round((Date.now() - ts) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days < 7 ? `${days}d` : new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function summarize(input) {
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url']) if (typeof input?.[key] === 'string') return input[key];
  return JSON.stringify(input ?? {});
}

const projectOf = (slug) => state.projects.find((p) => p.slug === slug);
const activeProjects = () => state.projects.filter((p) => p.status === 'active');
const waitingIds = () => new Set(state.questions.map((q) => q.sessionId));
const sessionById = (id) => state.sessions.find((s) => s.id === id);
/** The agent a thread is with when nobody picked another. */
const defaultAgentOf = () => (state.defaultAgent ? (state.agents ?? []).find((a) => a.id === state.defaultAgent) : undefined);

// Per-device conveniences only; the app works the same if storage is unavailable.
function remembered(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
function forget(key) {
  try {
    localStorage.removeItem(key);
  } catch {}
}

/**
 * What you've typed but not sent, by thread ("new" for a thread being started). A redraw builds a new
 * message box — a reconnection, a member joining, a deploy — and without this your words went with the
 * old one. Kept on this device until it's sent or cleared.
 */
const draftKey = (id) => `polyphemus.draft.${id}`;
const keepDraft = (id, text) => (text.trim() ? remember(draftKey(id), text) : forget(draftKey(id)));
const keptDraft = (id) => remembered(draftKey(id)) ?? '';
/** Restores what was typed, and keeps it as it's typed. */
function holdsDraft(input, id, grow) {
  input.value = keptDraft(id);
  if (input.value) setTimeout(grow, 0);
  input.addEventListener('input', () => keepDraft(id, input.value));
  return input;
}

/**
 * Light, dark, or whatever this device is set to. Applied before the first paint by a line in
 * index.html, so there's no flash of the other one; kept per device, like the other view settings.
 */
const THEMES = [
  { id: 'system', label: 'System', icon: 'auto' },
  { id: 'light', label: 'Light', icon: 'sun' },
  { id: 'dark', label: 'Dark', icon: 'moon' },
];
const theme = () => THEMES.find((t) => t.id === remembered('polyphemus.theme'))?.id ?? 'system';
function setTheme(id) {
  remember('polyphemus.theme', id);
  applyTheme();
}
function applyTheme() {
  const id = theme();
  if (id === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', id);
  // The browser's own chrome (the address bar, the task switcher) follows the app.
  const dark = id === 'dark' || (id === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.remove();
  document.head.append(h('meta', { name: 'theme-color', content: dark ? '#151a21' : '#ffffff' }));
}

/** Cycles System → Light → Dark, and says which it landed on. */
function themeButton() {
  const next = () => THEMES[(THEMES.findIndex((t) => t.id === theme()) + 1) % THEMES.length];
  const current = () => THEMES.find((t) => t.id === theme());
  const button = round(current().icon, `Theme: ${current().label}. Tap for ${next().label}.`, () => {
    const picked = next();
    setTheme(picked.id);
    fill(button, icon(current().icon));
    button.title = button.ariaLabel = `Theme: ${picked.label}. Tap for ${THEMES[(THEMES.findIndex((t) => t.id === picked.id) + 1) % THEMES.length].label}.`;
    toast(`${picked.label} theme.`);
  });
  return button;
}

let toastTimer;
function toast(text, kind = '', goThere) {
  const el = $('#toast');
  el.textContent = text;
  el.className = `toast show ${kind}${goThere ? ' tappable' : ''}`;
  el.onclick = goThere ? () => (toastTimer && clearTimeout(toastTimer), (el.className = 'toast'), goThere()) : null;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), goThere ? 7000 : kind === 'error' ? 5000 : 2600);
}
const showError = (err) => toast(err.message, 'error');

// ── Navigation ───────────────────────────────────────────────────────────

function parseRoute() {
  const hash = location.hash.replace(/^#/, '');
  if (/^[0-9a-f]{8}$/.test(hash)) return { name: 'session', id: hash }; // links from older notifications
  const [path, query = ''] = hash.split('?');
  const [first, second] = path.split('/').filter(Boolean);
  const params = new URLSearchParams(query);
  if (first === 'projects' || first === 'team' || first === 'you') return { name: first };
  if (first === 'p' && second) return { name: 'project', slug: decodeURIComponent(second), tab: params.get('tab') ?? '', from: params.get('from') ?? '' };
  if (first === 's' && second) return { name: 'session', id: second, at: params.get('at') ?? '' };
  if (first === 'flow' && second) return { name: 'flow', id: second, as: params.get('as') ?? '' };
  if (first === 'threads') return { name: 'threads', q: params.get('q') ?? '', archived: params.get('archived') === '1', project: params.get('project') ?? '', agent: params.get('agent') ?? '' };
  if (first === 'direct') return { name: 'direct' };
  if (first === 'new') return { name: 'new', project: params.get('project') ?? '', agent: params.get('agent') ?? '', with: params.get('with') ?? '' };
  if (first === 'new-project') return { name: 'newProject' };
  if (first === 'new-agent') return { name: 'newAgent' };
  // Providers are a tab of Models & providers now; old links and notifications still land there.
  if (first === 'providers') return { name: 'models', tab: 'providers' };
  if (first === 'setup' || (first === 'models' && second === 'setup')) return { name: 'setup' };
  if (first === 'models' && second) return { name: 'model', label: decodeURIComponent(second) };
  // ?tab=connections is what this tab was called before connections meant outside services.
  if (first === 'models') return { name: 'models', tab: params.get('tab') === 'connections' ? 'providers' : (params.get('tab') ?? 'models') };
    if (first === 'add-provider') return { name: 'addProvider', provider: second ? decodeURIComponent(second) : '' };
  if (first === 'choose') return { name: 'choose', provider: second ? decodeURIComponent(second) : '' };
  if (first === 'connections' && second === 'new') return { name: 'addConnection', entry: params.get('service') ?? '' };
  if (first === 'connections' && second && path.split('/').filter(Boolean)[2] === 'live') return { name: 'liveSignIn', id: decodeURIComponent(second), live: path.split('/').filter(Boolean)[3] ?? '', site: params.get('site') ?? '', question: params.get('question') ?? '' };
  if (first === 'connections' && second) return { name: 'connection', id: decodeURIComponent(second) };
  if (first === 'connections') return { name: 'connections' };
  if (first === 'a' && second && path.split('/').filter(Boolean)[2] === 'computer') return { name: 'computer', agent: decodeURIComponent(second) };
  if (first === 'a' && second) return { name: 'agent', agent: decodeURIComponent(second), edit: params.get('edit') === '1' };
  if (first === 'u' && second) return { name: 'person', person: decodeURIComponent(second) };
  if (first === 'skills') return second === 'browse' ? { name: 'skillsBrowse', to: params.get('to') ?? '' } : { name: 'skills' };
  if (first === 'review' && second) return { name: 'review', slug: decodeURIComponent(second) };
  return { name: 'home' };
}

const TOP = new Set(['home', 'direct', 'projects', 'team', 'you']);
/** Everything under Setup, so the rail marks it wherever you are inside. */
const SETUP_VIEWS = new Set(['you', 'models', 'setup', 'model', 'choose', 'addProvider', 'connections', 'connection', 'addConnection', 'liveSignIn']);

/**
 * Which top-level list contains a view. On a wide screen that list stays on the left while the
 * view opens beside it; on a phone it's just where Back goes. "you" is settings, not a list, so
 * it has no sidebar and takes the whole pane.
 */
/** Home or Direct, whichever list you were last in: an open thread keeps the list you came from beside it. */
let lastList = 'home';
/** The project whose list is beside what's open, when it's a project's own list. */
let listProject = null;
const cameFrom = () => {
  const kept = remembered('polyphemus.list');
  // A thread opened from a project's list keeps that list beside it — while it's that project's thread.
  if (kept?.startsWith('project:')) {
    const slug = kept.slice(8);
    const open = view.name === 'session' ? sessionById(view.id) : null;
    if (projectOf(slug) && (view.name !== 'session' || open?.project === slug)) {
      listProject = slug;
      return 'projectThreads';
    }
  }
  return kept === 'direct' ? 'direct' : lastList;
};

const SIDEBAR_OF = {
  home: 'home', direct: 'direct', projects: 'projects', team: 'team', you: null,
  session: cameFrom, new: cameFrom, threads: cameFrom, flow: cameFrom,
  // A project opens beside Home, scoped to it — not in place of the list you were using.
  // A project opens beside its own list: its threads, and what's waiting on you there.
  project: () => ((listProject = view.slug), 'projectThreads'), newProject: 'projects', review: 'home',
  agent: 'team', newAgent: 'team', person: 'team', skills: 'team', skillsBrowse: 'team', computer: null,
  models: null, setup: null, model: null, choose: null, addProvider: null,
  connections: null, connection: null, addConnection: null, liveSignIn: null,
};

/** Smooth scrolling, unless the person asked for less motion. */
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const scrollMotion = () => (reducedMotion.matches ? 'auto' : 'smooth');

/** Wide enough for the list and the thing you opened to sit side by side. */
const wideScreen = matchMedia('(min-width: 900px)');
const wide = () => wideScreen.matches;

/** Where screen() writes. Always #content except while the sidebar is being drawn. */
let pane = '#content';
/** The list currently in the sidebar, so its scroll survives a redraw that doesn't change it. */
let sidebarList = null;

function go(hash) {
  depth += 1;
  if (location.hash === hash) show();
  else location.hash = hash;
}

/** Back inside the app: to where you came from, or the natural parent if you arrived from a link. */
function goBack() {
  if (depth > 0) {
    depth -= 1;
    return history.back();
  }
  const session = view.name === 'session' ? sessionById(view.id) : null;
  const parent =
    view.name === 'session' ? (session?.project ? `#/p/${session.project}` : '#/')
    : view.name === 'review' ? `#/p/${view.slug}`
    : view.name === 'threads' ? (view.project ? `#/p/${encodeURIComponent(view.project)}` : view.agent ? `#/a/${encodeURIComponent(view.agent)}` : '#/')
    : view.name === 'project' || view.name === 'newProject' ? '#/projects'
    : view.name === 'agent' || view.name === 'newAgent' ? '#/team'
    : view.name === 'choose' || view.name === 'model' ? '#/models'
    : view.name === 'addProvider' ? '#/models?tab=providers'
    : view.name === 'connection' || view.name === 'addConnection' ? '#/connections'
    : view.name === 'models' || view.name === 'setup' || view.name === 'connections' ? '#/you'
    : '#/';
  location.replace(parent);
}

wideScreen.addEventListener('change', () => show());
// The run pane moves beside the conversation, or back above it, as the window grows or shrinks.
matchMedia('(min-width: 1280px)').addEventListener('change', () => view.name === 'session' && current && renderSession());

function show() {
  // A sheet belongs to the screen it opened over; going somewhere else closes it.
  document.querySelector('.sheet-wrap')?.remove();
  view = parseRoute();
  scopeOnArrival();
  if (view.name !== 'session') current = null;
  streaming.clear();
  render();
  window.scrollTo({ top: 0 });
}

/**
 * Opening a project scopes Home to it (finding-your-way decisions §2) — on arrival, not on every draw.
 * Beside an open project the list is Home, so re-applying it each time meant clearing the chip there
 * put it straight back.
 */
function scopeOnArrival() {
  // A project has its own list beside it now (2026-09-18): opening one no longer narrows Home.
}

/** Re-draws the screen with fresh data, keeping your place (never over a form you're typing in). */
function redraw() {
  const redrawable = TOP.has(view.name) || view.name === 'project';
  // Beside an open thread the list still has to stay live, even though the thread isn't redrawn.
  if (!redrawable) return wide() && sidebarList ? drawSidebar(sidebarList) : undefined;
  const y = window.scrollY;
  render();
  window.scrollTo({ top: y });
}

/** Draws a top-level list into the left pane, keeping where it was scrolled to. */
function drawSidebar(list) {
  // Drawn again live, a project's list comes back as its key.
  if (list.startsWith('projectThreads:')) {
    listProject = list.slice('projectThreads:'.length);
    list = 'projectThreads';
  }
  // Another project's list is another list: it starts at the top.
  const key = list === 'projectThreads' ? `projectThreads:${listProject}` : list;
  const keptScroll = sidebarList === key ? $('#sidebar').scrollTop : 0;
  pane = '#sidebar';
  SCREENS[list]();
  pane = '#content';
  sidebarList = key;
  $('#sidebar').scrollTop = keptScroll;
}

const SCREENS = {
  home: () => homeScreen(),
  projectThreads: () => homeScreen(projectOf(listProject)),
  direct: directScreen,
  projects: projectsScreen,
  team: teamScreen,
  you: youScreen,
  project: () => projectScreen(view.slug),
  session: () => openSession(view.id),
  flow: () => flowScreen(view.id),
  threads: () => threadsScreen(view),
  new: () => newThreadScreen(view.project, view.agent, view.with),
  newProject: newProjectScreen,
  newAgent: newAgentScreen,
  agent: () => (view.edit ? agentScreen(view.agent) : agentReadingScreen(view.agent)),
  person: () => personScreen(view.person),
  skills: () => skillsScreen(),
  computer: () => computerView(view.agent),
  skillsBrowse: () => skillsBrowseScreen(view.to),
  review: () => reviewScreen(view.slug),
  models: () => modelsHomeScreen(view.tab),
  setup: setupScreen,
  model: () => modelDetailScreen(view.label),
  choose: () => chooseModelsScreen(view.provider),
  addProvider: () => addProviderScreen(view.provider),
  connections: connectionsScreen,
  connection: () => connectionScreen(view.id),
  liveSignIn: () => liveSignInScreen(view.id, view.live, view.site, view.question),
  addConnection: () => (view.entry === 'other' ? addConnectionScreen() : connectionCatalogueScreen(view.entry)),
};

function render() {
  const screens = SCREENS;
  forgetComposer();
  // The computer beside a chat stays while you're in that chat; anywhere else, it closes.
  const paneStays = paneAgent && view.name === 'session' && view.id === paneSession;
  if (view.name !== 'computer' && !paneStays) leaveComputer();
  if (paneAgent && !paneStays) closeComputerPane();
  $('#app').classList.remove('run-pane-open');
  document.title = waitingTotal() ? `(${waitingTotal()}) polyphemus` : 'polyphemus';
  const of = SIDEBAR_OF[view.name];
  const list = wide() ? (typeof of === 'function' ? of() : of) : null;
  if (view.name === 'home' || view.name === 'direct') {
    lastList = view.name;
    remember('polyphemus.list', view.name);
  }
  if (view.name === 'project' && projectOf(view.slug)) remember('polyphemus.list', `project:${view.slug}`);
  $('#app').classList.toggle('no-sidebar', wide() && !list);
  if (!wide()) {
    sidebarList = null;
    pane = '#content';
    return screens[view.name]();
  }
  fill($('#rail'), rail());
  if (list) {
    // Only the four top-level screens are ever a sidebar, and all four draw synchronously — so
    // pane is back to #content before any detail screen that awaits gets to call screen().
    drawSidebar(list);
  } else {
    sidebarList = null;
    fill($('#sidebar'));
  }
  pane = '#content';
  return TOP.has(view.name) && list ? nothingOpen(list) : screens[view.name]();
}

/** The right-hand pane before you've opened anything. */
function nothingOpen(list) {
  // Nothing set up yet: the right-hand pane shouldn't ask you to pick from nothing.
  if (list === 'home' && !state.models.some((m) => m.ready)) {
    return fill($('#content'), 
      h(
        'div',
        { class: 'nothing' },
        logo(),
        h('b', {}, 'Nothing to run on yet'),
        h('span', {}, 'Connect a provider and choose a model, then start a thread.'),
        h('button', { class: 'btn primary', style: 'margin-top:14px', onclick: () => go('#/models') }, 'Set up models'),
      ),
    );
  }
  const said = {
    home: ['Pick a thread', 'Or start one with + — it opens here.'],
    direct: ['Pick a conversation', 'Or say hello to an agent — it opens here.'],
    projects: ['Pick a project', 'Its threads, roster and setup open here.'],
    team: ['Pick an agent', 'What it is, who it is, and what it does here.'],
  }[list];
  fill($('#content'), h('div', { class: 'nothing' }, logo(), h('b', {}, said[0]), h('span', {}, said[1])));
}

// ── Building blocks ──────────────────────────────────────────────────────

function screen(bar, children, { tabs = false, mainClass = '' } = {}) {
  // On a wide screen the rail carries the sections, so the bottom tab bar isn't drawn.
  fill($(pane), bar, h('main', { class: `main ${mainClass}` }, children), tabs && !wide() ? tabBar() : null);
}

function bar(left, mid, right = []) {
  return h('header', { class: 'bar' }, left, h('div', { class: 'bar-mid' }, mid), h('div', { class: 'bar-side' }, right));
}

const round = (name, label, onclick, cls = '') => h('button', { class: `round ${cls}`, 'aria-label': label, title: label, onclick }, icon(name));
// Beside its own list there's nothing to go back to; a review is two deep, so it keeps one.
// Back disappears only when the list it would take you to is already on screen beside it. On a
// settings screen there's no sidebar at all, so hiding it left no way out — which is exactly what
// happened on the choose-models screen.
// A project's or an agent's threads sit beside Home, not beside where you came from, so they keep one too.
const backButton = () => (wide() && SIDEBAR_OF[view.name] && view.name !== 'review' && !(view.name === 'threads' && (view.project || view.agent)) ? null : round('back', 'Back', goBack));
const title = (text) => h('span', { class: 'screen-title' }, text);
const sec = (label, count) => h('div', { class: 'sec' }, label, count ? h('span', { class: 'count' }, count) : null);
const dot = (kind) => (kind ? h('span', { class: `dot ${kind}`, title: kind === 'needs' ? 'Waiting on a person' : 'Working' }) : null);

function brand() {
  // On a wide screen the rail already carries the logo and the live dot; the list just needs its name.
  if (wide()) return title('Home');
  return h(
    'button',
    { class: 'brand', 'aria-label': 'Home', onclick: () => (view.name === 'home' ? window.scrollTo({ top: 0, behavior: scrollMotion() }) : go('#/')) },
    logo(),
    h('span', {}, 'polyphemus'),
    h('span', { class: `live ${live ? 'on' : ''}`, title: live ? 'Live' : 'Reconnecting…' }),
  );
}

const SECTIONS = [['home', 'Home', '#/'], ['direct', 'Direct', '#/direct'], ['projects', 'Projects', '#/projects'], ['team', 'Team', '#/team'], ['you', 'Setup', '#/you']];

/** The sections, stood up beside the list on a wide screen. Marks the one you're inside. */
function rail() {
  const count = waitingTotal();
  const of = SIDEBAR_OF[view.name];
  const list = typeof of === 'function' ? of() : of;
  const here = SETUP_VIEWS.has(view.name) ? 'you' : list === 'projectThreads' ? 'projects' : list;
  return h(
    'nav',
    { class: 'rail-inner', 'aria-label': 'Sections' },
    // Connected or not, on the logo where the eye already goes — as the phone shows it beside the name.
    h('button', { class: 'rail-brand', 'aria-label': live ? 'Home · connected' : 'Home · reconnecting', title: live ? 'polyphemus · connected' : 'polyphemus · reconnecting…', onclick: () => go('#/') }, logo(), h('span', { class: `live ${live ? 'on' : ''}` })),
    SECTIONS.map(([name, label, hash]) =>
      h(
        'button',
        { 'aria-current': here === name ? 'page' : 'false', onclick: () => (name === 'home' && here === 'home' && homeScope() ? (setScope(null), render()) : location.replace(hash)) },
        icon(name),
        label,
        name === 'home' && count ? h('span', { class: 'badge' }, count) : null,
      ),
    ),
  );
}

function tabBar() {
  const tabs = SECTIONS;
  const count = waitingTotal();
  return h(
    'nav',
    { class: 'tabs', 'aria-label': 'Sections' },
    tabs.map(([name, label, hash]) =>
      h(
        'button',
        { 'aria-current': view.name === name ? 'page' : 'false', onclick: () => (view.name === name && name === 'home' && homeScope() ? (setScope(null), render()) : view.name === name ? window.scrollTo({ top: 0, behavior: scrollMotion() }) : location.replace(hash)) },
        icon(name),
        label,
        name === 'home' && count ? h('span', { class: 'badge' }, count) : null,
      ),
    ),
  );
}

/**
 * Asks before something that costs, can't be undone, or changes a lot — in the app, never in a
 * browser dialog. Resolves true only for the confirming button; closing it any other way is a no.
 */
function confirmSheet(heading, body, { yes = 'Continue', no = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    document.querySelector('.sheet-wrap')?.remove();
    let settled = false;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      wrap.remove();
      document.removeEventListener('keydown', onKey);
      resolve(answer);
    };
    const onKey = (e) => e.key === 'Escape' && finish(false);
    const confirmButton = h('button', { class: `btn wide ${danger ? 'danger-solid' : 'primary'}`, onclick: () => finish(true) }, yes);
    const wrap = h(
      'div',
      { class: 'sheet-wrap', onclick: (e) => e.target === wrap && finish(false) },
      h(
        'div',
        { class: 'sheet confirm', role: 'alertdialog', 'aria-label': heading },
        h('div', { class: 'sheet-top' }, h('b', {}, heading), round('close', 'Close', () => finish(false))),
        h('div', { class: 'sheet-body' }, (Array.isArray(body) ? body : [body]).map((line) => (typeof line === 'string' ? h('p', { class: 'confirm-text' }, line) : line)), h('div', { class: 'confirm-buttons' }, confirmButton, h('button', { class: 'btn wide', onclick: () => finish(false) }, no))),
      ),
    );
    document.addEventListener('keydown', onKey);
    document.body.append(wrap);
    confirmButton.focus();
  });
}

/**
 * Shapes a credential takes, the same ones the vault’s redaction watches for (tools/redact.ts).
 * A message that contains one is offered the vault before it’s sent. The match is the value; it is
 * not drawn.
 */
function secretIn(text) {
  const shapes = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/,
    /\bsk-ant-[A-Za-z0-9_-]{20,}/,
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/,
    /\bxai-[A-Za-z0-9]{20,}/,
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/,
    /\bgithub_pat_[A-Za-z0-9_]{30,}/,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
    /aws_secret_access_key\s*[=:]\s*["']?[A-Za-z0-9/+]{40}/i,
  ];
  for (const shape of shapes) {
    const found = text.match(shape);
    if (found) return found[0];
  }
  return '';
}

/** Save the key in a message, send the message anyway, or leave it in the box. */
function offerVault({ value, sessionId, project, agent }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (choice) => {
      if (settled) return;
      settled = true;
      wrap.remove();
      document.removeEventListener('keydown', onKey);
      resolve(choice);
    };
    const onKey = (e) => e.key === 'Escape' && finish('cancel');
    const name = h('input', { autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: 'aws/site', 'aria-label': 'Name' });
    const purpose = h('input', { autocomplete: 'off', placeholder: 'What it’s for', 'aria-label': 'What it’s for' });
    const options = [...(agent ? [['agent', `Only ${agent.title}`]] : []), ...(project ? [['project', `Anyone working in ${project.name}`]] : [])];
    const who = options.length > 1 ? h('select', { 'aria-label': 'Who it’s kept for' }, options.map(([id, label]) => h('option', { value: id }, label))) : null;
    const save = h('button', { class: 'btn primary wide' }, 'Save in the vault');
    save.addEventListener('click', async () => {
      const chosen = name.value.trim();
      if (!chosen) return toast('Give it a name, like aws/site.', 'error');
      save.disabled = true;
      try {
        const saved = await api('/api/secrets', {
          ...(sessionId && { session: sessionId }),
          ...(project && { project: project.slug }),
          ...(agent && { agent: agent.id }),
          name: chosen,
          value,
          purpose: purpose.value.trim(),
          who: who ? who.value : options[0]?.[0] ?? 'keep',
        });
        toast(`Saved as ${saved.ref}.`);
        finish('saved');
      } catch (err) {
        save.disabled = false;
        showError(err);
      }
    });
    const wrap = h(
      'div',
      { class: 'sheet-wrap', onclick: (e) => e.target === wrap && finish('cancel') },
      h(
        'div',
        { class: 'sheet', role: 'dialog', 'aria-label': 'Save this in the vault?' },
        h('div', { class: 'sheet-top' }, h('b', {}, 'Save this in the vault?'), round('close', 'Close', () => finish('cancel'))),
        h(
          'div',
          { class: 'sheet-body' },
          h('p', {}, 'That message has something that looks like a key. It can go into the vault instead of the thread. The thread never sees the value.'),
          h('label', { class: 'field' }, h('span', {}, 'Name'), name),
          h('label', { class: 'field' }, h('span', {}, 'What it’s for'), purpose),
          who ? h('label', { class: 'field' }, h('span', {}, 'Who it’s kept for'), who) : null,
          h('div', { class: 'buttons' }, save, h('button', { class: 'btn wide', onclick: () => finish('send') }, 'Send it anyway')),
        ),
      ),
    );
    document.addEventListener('keydown', onKey);
    document.body.append(wrap);
    name.focus();
  });
}

/** A panel over the current screen, for a choice that shouldn't lose your place in the thread. */
function sheet(heading, children) {
  document.querySelector('.sheet-wrap')?.remove();
  const close = () => wrap.remove();
  const wrap = h(
    'div',
    { class: 'sheet-wrap', onclick: (e) => e.target === wrap && close() },
    h(
      'div',
      { class: 'sheet', role: 'dialog', 'aria-label': heading },
      h('div', { class: 'sheet-top' }, h('b', {}, heading), round('close', 'Close', close)),
      h('div', { class: 'sheet-body' }, children),
    ),
  );
  document.body.append(wrap);
  return wrap;
}

/**
 * Who's in this thread, and how to change it. A thread has nought or more agents: one is the
 * ordinary case, several is a group discussion, and `@name` decides who answers.
 */
function membersButton(s) {
  const members = s.members ?? [];
  return h(
    'button',
    { class: 'round', 'aria-label': 'Who’s in this thread', title: 'Who’s in this thread', onclick: () => showMembers(s) },
    members.length ? h('span', { class: 'member-count' }, String(members.length)) : icon('team'),
  );
}

function showMembers(s) {
  const members = s.members ?? [];
  const roster = s.roster ?? [];
  const change = async (name, remove) => {
    try {
      const { members: now } = await api(`/api/sessions/${s.meta.id}/members`, { agent: name, remove });
      if (current) current.members = now;
      showMembers(current ?? { ...s, members: now });
      toast(remove ? `${name} left the thread.` : `${name} joined.`);
    } catch (err) {
      showError(err);
    }
  };
  const leadId = s.lead ?? (members.length > 1 ? members[0]?.id : null);
  const makeLead = async (agent) => {
    try {
      await api(`/api/sessions/${s.meta.id}/lead`, { agent: agent.id });
      if (current) current.lead = agent.id;
      drawThreadState();
      renderLog();
      showMembers(current ?? { ...s, lead: agent.id });
      toast(`${agent.title} leads.`);
    } catch (err) {
      showError(err);
    }
  };
  const row = (agent, inThread) => {
    const action = h('button', { class: `btn small ${inThread ? 'danger' : ''}` }, inThread ? 'Remove' : 'Add');
    action.addEventListener('click', () => change(agent.id ?? agent.name, inThread));
    const leading = inThread && members.length > 1 && agent.id === leadId;
    const leadButton = inThread && members.length > 1 && !leading ? h('button', { class: 'btn small', onclick: () => makeLead(agent) }, 'Make lead') : null;
    return h(
      'div',
      { class: 'row with-actions' },
      mark(agent.mark ?? agent.name),
      h(
        'span',
        { class: 'row-main' },
        h('span', { class: 'row-top' }, h('b', {}, agent.title), leading ? h('span', { class: 'lead-tag' }, 'lead') : null),
        h('span', { class: 'row-sub' }, h('span', { class: 'text' }, inThread ? `@${agent.name}` : 'Not in this thread')),
      ),
      h('div', { class: 'row-actions' }, leadButton, action),
    );
  };
  const others = roster.filter((a) => !members.some((m) => (m.id ?? m.name) === (a.id ?? a.name)));
  // With more than one agent or person here, agents answer only when named, unless this is turned on.
  const answerAll = members.length && (members.length > 1 || peopleTalking(s))
    ? toggle('Agents answer everything here', members.length > 1 ? 'Off: an agent answers only when someone @mentions it. On: a message that names nobody goes to the lead.' : 'Off: with more than one person in the thread, an agent answers only when someone @mentions it.', s.agentsAnswerAll === true, async (on) => {
        try {
          await api(`/api/sessions/${s.meta.id}/answer-all`, { on });
          if (current) current.agentsAnswerAll = on;
          drawThreadState();
          toast(on ? 'Agents answer every message here.' : 'Agents answer here when someone @mentions them.');
        } catch (err) {
          showError(err);
        }
      })
    : null;
  sheet('Who’s in this thread', [
    members.length ? h('div', { class: 'list' }, members.map((a) => row(a, true))) : h('p', { class: 'empty' }, 'Nobody yet — this is you and a bare model.'),
    members.length > 1 ? h('p', { class: 'hint' }, `@${members.map((m) => m.name).join(' or @')} to say who a message is for. One that names nobody isn’t answered${s.agentsAnswerAll ? ' — except here, where it goes to the lead, who can hand it on' : ''}.`) : null,
    answerAll ? h('div', { class: 'card' }, answerAll) : null,
    others.length ? sec('Bring someone in', others.length) : null,
    others.length ? h('div', { class: 'list' }, others.map((a) => row(a, false))) : null,
  ]);
}

/** People who can see a thread in this project — its members and the install's owner — other than you. */
function peopleHere(slug) {
  if (!multiplePeople()) return [];
  const project = slug ? projectOf(slug) : null;
  const owner = (state.people ?? []).filter((person) => person.owner);
  const members = (project?.people ?? []).map((person) => ({ id: person.id, name: person.name }));
  const seen = new Set();
  return [...owner, ...members].filter((person) => person.id !== state.me?.id && !seen.has(person.id) && seen.add(person.id)).map((person) => ({ kind: 'person', id: person.id, name: person.name, title: person.name }));
}

/** Two or more people have been in this thread, counting you. */
const peopleTalking = (s) => new Set([...(s?.people ?? []).map((p) => p.id), state.me?.id].filter(Boolean)).size >= 2;

/** Who answers what you type, said in the message box: an agent answers only when named once people are talking. */
function composerHint() {
  const input = $('#input');
  if (!input || !current) return;
  const members = current.members ?? [];
  // Agents answer when named — unless it's one agent and only you, or the thread says they answer everything.
  const quiet = members.length && !current.agentsAnswerAll && (members.length > 1 || peopleTalking(current));
  const who = members.length === 1 ? `@${members[0].title.replace(/\s+/g, '')}` : '@ an agent';
  // While it works, what you send is held: say so, whoever would answer.
  input.placeholder = current.running ? 'Queue a message…' : quiet ? `Message… ${who} for an answer` : 'Message…';
}

// ── People ───────────────────────────────────────────────────────────────
// With one person in the install, none of this shows (settled brief §7). With more, what someone
// else did is attributed, and a member or viewer isn't offered what only the owner can do.

const multiplePeople = () => (state.people?.length ?? 0) > 1;
const isOwner = () => state.me?.owner !== false;
const personById = (id) => (current?.people ?? []).find((p) => p.id === id) ?? (state.people ?? []).find((p) => p.id === id);
/** Who an actor string names, in words: "Sam", "a routine". */
function actorName(actor) {
  if (!actor) return 'Someone';
  if (actor.startsWith('person:')) return actor === `person:${state.me?.id}` ? 'You' : (personById(actor.slice(7))?.name ?? 'Someone');
  if (actor.startsWith('routine:')) return 'A routine';
  return 'Someone';
}
/** A person's face: round, initials — never an agent's shape. */
const face = (name, cls = 'xs') => h('span', { class: `face ${cls}` }, (name ?? '?').trim().charAt(0).toUpperCase());
/** What someone typed. Yours on the right; someone else's on the left with their name, once there are two of you. */
function userBubble(text, actor, seq) {
  const mine = !actor || actor === `person:${state.me?.id}` || !multiplePeople();
  const big = onlyEmoji(text) ? ' jumbo' : '';
  const body = pasteBody(text, seq);
  if (mine) return [reactable(h('div', { class: `msg you${big}` }, body), seq)];
  const name = actorName(actor);
  return [h('div', { class: 'speaker' }, face(name), h('b', {}, name)), reactable(h('div', { class: `msg them${big}${mentionsMe(text) ? ' mentions-me' : ''}` }, body), seq)];
}

/** A long paste stays a short bubble. Opened or closed by you stays that way when the thread redraws. */
const PASTE_LINES = 8;
const PASTE_CHARS = 700;
const pasteOpen = new Set();
function pasteBody(text, seq) {
  const raw = String(text ?? '');
  const lines = raw.split('\n');
  const long = lines.length > PASTE_LINES || raw.length > PASTE_CHARS;
  if (!long) return withMentions(raw);
  const key = `${current?.meta?.id ?? ''}:${seq ?? ''}`;
  const open = pasteOpen.has(key);
  const shown = open ? raw : clipPaste(raw, lines);
  const hidden = Math.max(0, lines.length - PASTE_LINES);
  const label = open ? 'Show less' : hidden > 0 ? `Show the rest (${hidden} more ${hidden === 1 ? 'line' : 'lines'})` : 'Show the rest';
  const toggle = h('button', { type: 'button', class: 'paste-more' }, label);
  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    if (open) pasteOpen.delete(key);
    else pasteOpen.add(key);
    renderLog();
  });
  return [...withMentions(shown), toggle];
}
function clipPaste(raw, lines) {
  const head = lines.slice(0, PASTE_LINES).join('\n');
  return (head.length > PASTE_CHARS ? head.slice(0, PASTE_CHARS) : head).trimEnd();
}

/** Just an emoji or three, and nothing else: shown big, the way a chat app does. */
const graphemes = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
function onlyEmoji(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 40 || !/^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\u200d|\ufe0f|\u20e3|[#*0-9]|\s)+$/u.test(t) || !/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(t)) return false;
  const count = graphemes ? [...graphemes.segment(t.replace(/\s+/g, ''))].length : t.length;
  return count <= 3;
}

/** A message you can react to: it knows which one it is. */
function reactable(bubble, seq) {
  if (seq === undefined) return bubble;
  bubble.classList.add('reactable');
  bubble.dataset.seq = String(seq);
  return bubble;
}

// ── @mentions, the way a chat app shows them ─────────────────────────
// A name someone @mentioned is a chip, for everyone reading; your own is brighter, and a message
// that names you is marked down its side, so it stands out when you scroll back (like Discord).

const handleWords = (name) => (name ?? '').replace(/\s+/g, '').toLowerCase();
const myHandle = () => handleWords(state.me?.name);

/** Every handle that reaches someone: the people you know of, and agents by name and by title. */
function knownHandles() {
  const handles = new Set();
  for (const p of [...(state.people ?? []), ...(current?.people ?? [])]) if (p?.name) handles.add(handleWords(p.name));
  for (const a of [...(state.agents ?? []), ...(current?.members ?? []), ...(current?.roster ?? [])]) {
    if (a?.name) handles.add(handleWords(a.name));
    if (a?.title) handles.add(handleWords(a.title));
  }
  handles.delete('');
  return handles;
}

const MENTION = /(^|[^\w@])@([\w-]+)/g;

/** Plain text with its @mentions as chips. Anything that isn't someone stays as it was typed. */
function withMentions(text) {
  if (!text || !text.includes('@')) return [text];
  const known = knownHandles();
  const me = myHandle();
  const out = [];
  let last = 0;
  for (const m of text.matchAll(MENTION)) {
    const handle = m[2].toLowerCase();
    if (!known.has(handle)) continue;
    const at = m.index + m[1].length;
    if (at > last) out.push(text.slice(last, at));
    out.push(h('span', { class: `mention${handle === me ? ' me' : ''}` }, `@${m[2]}`));
    last = at + 1 + m[2].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Does this text @mention whoever's reading? Code and quotes aside, the way a hand-off counts one. */
function mentionsMe(text) {
  const me = myHandle();
  if (!me || !text?.includes('@')) return false;
  const spoken = text.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
  return [...spoken.matchAll(MENTION)].some((m) => m[2].toLowerCase() === me);
}
const isTheirs = (actor) => multiplePeople() && actor && actor !== `person:${state.me?.id}`;
/** Can this person act in a thread from the list: the owner, a member of its project, or who started one with none. */
function canActIn(session) {
  if (!session || isOwner()) return true;
  if (session.project) return projectOf(session.project)?.role === 'member';
  return session.startedBy === `person:${state.me?.id}`;
}

/** An agent by id, or by bare name as older threads stored it. */
const agentByRef = (ref) => (state.agents ?? []).find((a) => a.id === ref) ?? (state.agents ?? []).find((a) => a.name === ref);

/**
 * Whose face a conversation wears: the agent you're talking with, if there is one. Only a thread
 * with nobody on the other side falls back to the provider's mark.
 */
/**
 * The top of a thread. A direct message — you and one agent, outside any project — is headed by who
 * it's with, and tapping them opens their profile, the way a chat app does. Anything else is headed
 * by what it's about: its title.
 */
function threadHead(s) {
  const members = s.members ?? [];
  // Between you and one other person, with no agent: headed by them.
  const others = (s.people ?? []).filter((p) => p.id !== state.me?.id);
  if (!s.project && !members.length && others.length === 1) return h('div', { class: 'pill' }, face(others[0].name, 'md'), h('span', {}, others[0].name));
  const dm = !s.project && members.length === 1 && (s.people ?? []).length <= 1;
  if (!dm) return h('div', { class: 'pill' }, headMark(threadMark(s.meta, 34), s.running), h('span', { id: 'thread-title' }, s.meta.title || '(untitled)'));
  const agent = members[0];
  return h(
    'button',
    { type: 'button', class: 'pill pill-link', 'aria-label': `${agent.title}’s profile`, onclick: () => go(`#/a/${encodeURIComponent(agent.id)}`) },
    headMark(mark(agent.mark ?? agent.name, 34), s.running),
    h('span', {}, agent.title),
  );
}

/** In a DM with an agent, its computer is a tap away at the top, the way Grok Bot does it. */
function computerButton(s) {
  const members = s.members ?? [];
  if (!isOwner() || s.project || members.length !== 1 || (s.people ?? []).length > 1) return null;
  const agent = members[0];
  return round('screen', `${agent.title}’s computer`, () => toggleComputerPane(agent));
}

/** The thread's own mark at its head, alive while a turn runs; setRunning flips it. */
function headMark(markEl, on) {
  const el = alive(markEl, on);
  el.id = 'head-mark';
  return el;
}

/**
 * A mark that comes alive while its agent works: a rainbow comet goes round it on a tilted orbit,
 * behind the mark on the far half and over it on the near half, while the mark itself keeps still
 * and blinks now and then. Always wrapped, so a turn starting or ending only toggles `on` —
 * nothing is redrawn under you.
 */
function alive(markEl, on) {
  // A group of agents: each mark comes alive on its own, with its own comet on its own clock. One
  // comet round the whole pile, and three faces blinking together, read as one thing (2026-09-21).
  if (markEl.classList?.contains('marks')) {
    for (const [i, child] of [...markEl.children].entries()) {
      const body = h('span', { class: 'alive-body' });
      const one = h('span', { class: 'alive-one' }, h('span', { class: 'swoosh', 'aria-hidden': 'true' }), body);
      child.replaceWith(one);
      body.append(child);
      one.style.setProperty('--mark-n', String(markClock(child.dataset.who || String(i), i)));
    }
    return h('span', { class: `alive stack${on ? ' on' : ''}` }, markEl);
  }
  return h('span', { class: `alive${on ? ' on' : ''}` }, h('span', { class: 'swoosh', 'aria-hidden': 'true' }), h('span', { class: 'alive-body' }, markEl));
}

/**
 * Where in its loops a mark in a group starts: from its agent, so the same agent keeps its rhythm
 * wherever it's drawn, and its place, so two agents that hash alike still don't move together.
 */
function markClock(who, place) {
  let hash = 0;
  for (const ch of who) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return (hash + place * 4) % 11;
}

function threadMark(session, size = 44) {
  return whoMark((session?.id && sessionById(session.id)) || session, size);
}

/**
 * Whose a thread is, never which model it runs on (finding-your-way decisions §3): its agents,
 * composed when there are several; else the other person in it; else its project's squircle; else a
 * dashed outline. When most threads run on one model, a model's mark made every row look the same.
 */
function whoMark(s, size = 44) {
  const members = s?.members ?? [];
  if (members.length >= 2) {
    const shown = members.slice(0, 3);
    return h('span', { class: `marks ${shown.length === 2 ? 'two' : 'three'}` }, shown.map((m) => {
      const el = mark(m.mark ?? m.name, Math.round(size * 0.68));
      el.dataset.who = m.id ?? m.name ?? ''; // each one's own clock when they come alive
      return el;
    }));
  }
  if (members.length === 1) return mark(members[0].mark ?? members[0].name, size);
  const agent = s?.agent ? agentByRef(s.agent) : undefined;
  if (agent) return mark(agent.mark ?? agent.name, size);
  const other = multiplePeople() ? (s?.people ?? []).find((id) => id !== state.me?.id) : undefined;
  if (other) return face(personById(other)?.name, size >= 40 ? 'md' : 'sm');
  const project = s?.project ? projectOf(s.project) : s?.cwd ? state.projects.find((p) => p.path === s.cwd) : undefined;
  if (project) return squircle(project, Math.round(size * 0.86));
  const none = h('span', { class: 'mark-none', 'aria-hidden': 'true' });
  none.style.width = none.style.height = `${Math.round(size * 0.8)}px`;
  return none;
}

// ── The row ──────────────────────────────────────────────────────────────
// Three signals and nothing else (settled brief §3): the mark says who, one glyph says the state,
// the amber dot says it's on a person. Everything else is the second line, in words.

const STATE_GLYPHS = {
  kept: ['Kept', '<path d="M12 3v10M8 7l4-4 4 4M5 20h14"/>'],
  finished: ['Finished', '<path d="m5 13 4 4 10-10"/>'],
  paused: ['Paused', '<path d="M9 6v12M15 6v12"/>'],
};

/** The one state glyph: a pin, a tick, a pause — or a word for what started it. */
function stateGlyph(state) {
  if (!state) return null;
  if (state === 'routine' || state === 'run') return h('span', { class: 'state', title: state === 'run' ? 'A run' : 'Started by a routine' }, state);
  const [label, path] = STATE_GLYPHS[state] ?? [];
  if (!label) return null;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = path;
  return h('span', { class: 'state', title: label, 'aria-label': label }, svg);
}

/**
 * Who a thread is with. Its agents' marks, composed when there are several; otherwise the face of
 * the other person in it; otherwise the model's provider. Agents are shapes and people are faces,
 * and the two never share a mark.
 */
function rowMark(s) {
  return whoMark(s, 44);
}

/** Started by polyphemus rather than a person: a request an agent proposed, a run's work item, a routine's thread. */
const madeByPolyphemus = (s) => /^(agent|session|run|routine):/.test(s.startedBy ?? '') || Boolean(s.spunFrom && s.work && !s.work.status);

/** The second line: what's on a person, else the last thing said — naming who, when there's more than one who. */
function rowLine(s) {
  if (s.snippet) return s.snippet;
  if (s.work) return workLine(s.work);
  if (s.pausedWhy) return s.pausedWhy;
  const line = s.lastLine;
  if (!line) return s.preview || (madeByPolyphemus(s) ? 'polyphemus started this' : 'you started this');
  if (/^(agent|session|run):/.test(s.startedBy ?? '') && !(s.members ?? []).length) return `polyphemus · ${line.text}`;
  const speakerMatters = (s.members ?? []).length > 1 || (line.actor?.startsWith('person:') && line.actor !== `person:${state.me?.id}` && multiplePeople());
  return speakerMatters && line.speaker ? `${line.speaker}: ${line.text}` : line.text;
}

function sessionRow(s, showProject) {
  const onAPerson = s.waiting || s.state === 'paused';
  const project = showProject && s.project ? projectOf(s.project)?.name : null;
  const detail = [project ?? (showProject && !s.project ? s.cwd.split('/').pop() : null), rowLine(s)].filter(Boolean).join(' · ');
  return h(
    'button',
    { class: `row ${s.state === 'finished' ? 'done' : ''}`, onclick: () => go(`#/s/${s.id}`) },
    alive(rowMark(s), s.running),
    h(
      'span',
      { class: 'row-main' },
      h('span', { class: 'row-top' }, h('b', {}, s.title || '(untitled)'), s.archivedAt ? h('span', { class: 'tag' }, 'Archived') : s.work?.status ? statusTag(s.work.status) : stateGlyph(s.state), h('time', {}, s.running ? 'now' : ago(s.updatedAt))),
      h('span', { class: 'row-sub' }, h('span', { class: 'text' }, detail), dot(onAPerson ? 'needs' : s.running ? 'working' : '')),
    ),
  );
}

/**
 * What an approval does, as far as polyphemus can honestly say. It can't see inside a command, so it
 * says what kind of thing it is and whether it can be taken back — and "can't tell" when it can't.
 */
function approvalImpact(tool, where) {
  // Isolated: it runs in the project's container, but the project's folder there is the real one.
  const inWorker = where === 'worker';
  if (/^(bash|shell|exec|command|local_shell|terminal|run_terminal_command)$/i.test(tool)) return inWorker ? 'Runs a command in the project’s container, with only what it was granted. What it changes in the project is real, and Polyphemus can’t undo it.' : 'Runs a command on this computer. Polyphemus can’t undo it.';
  if (/^(edit|write|write_file|edit_file|multi_?edit|notebook_?edit|apply_patch|str_replace.*)$/i.test(tool)) return inWorker ? 'Changes a file in the project.' : 'Changes a file on this computer.';
  if (/fetch|web|http|browser/i.test(tool)) return 'Reaches the internet.';
  return 'Polyphemus can’t tell what this changes.';
}

const waitedFor = (at) => (at ? (ago(at) === 'now' ? 'Asked just now' : `Waiting ${ago(at)}`) : null);

function questionCard(q, inSession = false) {
  const s = sessionById(q.sessionId);
  const project = s?.project ? projectOf(s.project) : null;
  const me = `person:${state.me?.id}`;
  const settle = async (path, body, button) => {
    if (button) button.disabled = true;
    try {
      const result = await api(path, body);
      // Saying yes in a DM opens the new thread, and leaves the conversation you were in as it was.
      if (result?.thread) go(`#/s/${result.thread}`);
      // An accepted routine or profile shows straight away.
      else if (q.kind === 'routine' || q.kind === 'profile') await refresh().then(render, () => {});
    } catch (err) {
      // A proposed skill with the name of one that's already there: a revision. Replace it, if you say so.
      if (q.kind === 'skill' && err.status === 409 && /already a skill/i.test(err.message) && !body.replace) {
        if (button) button.disabled = false;
        if (await confirmSheet(`Replace ${q.name}?`, h('p', {}, `There’s already a skill called ${q.name} there. Replacing it keeps this version; the one there now is moved to the trash in Polyphemus’s folder, not deleted.`), { yes: 'Replace it' })) return settle(path, { ...body, replace: true }, button);
        return;
      }
      // Someone else got there first, or has it: say so, and show what's true now.
      if (button) button.disabled = false;
      showError(err);
      refresh().catch(() => {});
    }
  };
  const answer = (value, button) => settle(`/api/questions/${q.id}`, { answer: value }, button);
  const btn = (label, value, cls = '') => {
    const button = h('button', { class: `btn ${cls}` }, label);
    button.addEventListener('click', () => answer(value, button));
    return button;
  };
  const head = inSession
    ? null
    : h('button', { class: 'ask-head', onclick: () => go(`#/s/${q.sessionId}`) }, s ? threadMark(s, 24) : null, h('b', {}, s?.title || 'A session'), project ? h('span', { class: 'tag' }, project.name) : null);
  // A viewer sees it's waiting, and who can answer — but gets no buttons that would be refused.
  if (!canActIn(s)) {
    // The same line the thread and the push use, including a guard. A viewer reads it and doesn't get buttons.
    return h('div', { class: 'ask', 'data-question': q.id }, head, h('p', {}, q.line || 'Waiting for a decision'), q.kind === 'approval' ? h('code', {}, q.summary) : null, h('p', { class: 'hint tight' }, 'You’re a viewer here, so a member or the owner answers this.'));
  }
  // Who's handling it — shown only once there's someone else who could be (settled brief §7).
  const others = (q.canAnswer ?? []).filter((id) => `person:${id}` !== me);
  const shared = multiplePeople() && others.length > 0;
  const theirs = shared && q.claimedBy && q.claimedBy !== me;
  const mine = shared && q.claimedBy === me;
  const claim = (body, button) => settle(`/api/questions/${q.id}/claim`, body, button);
  const claimLine = !shared
    ? null
    : theirs
      ? h('div', { class: 'claim' }, face(actorName(q.claimedBy)), h('b', {}, actorName(q.claimedBy)), ` is handling this · claimed ${ago(q.claimedAt) === 'now' ? 'just now' : `${ago(q.claimedAt)} ago`}`)
      : mine
        ? h('div', { class: 'claim' }, face(state.me?.name), 'You’re handling this')
        : h('div', { class: 'claim' }, h('span', { class: 'faces' }, others.slice(0, 3).map((id) => face(personById(id)?.name))), `${others.map((id) => personById(id)?.name ?? 'Someone').slice(0, 2).join(' and ')}${others.length > 2 ? ' and others' : ''} can ${q.kind === 'approval' ? 'approve' : 'answer'} this too`);
  const claimButton = (() => {
    if (!shared) return null;
    const button = h('button', { class: 'btn ghost' }, theirs ? 'Take it over' : mine ? 'Let go' : 'I’ll handle it');
    button.addEventListener('click', () => claim(theirs ? { takeOver: true } : mine ? { release: true } : {}, button));
    return button;
  })();
  // While someone else has it, the answer buttons wait: taking it over is one deliberate tap.
  const answerable = (b) => {
    if (theirs) b.disabled = true;
    return b;
  };
  const cost = h('p', { class: 'cost' }, [q.kind === 'approval' ? approvalImpact(q.tool, q.where) : null, waitedFor(q.askedAt)].filter(Boolean).join(' '));
  const sendBack = (button) => {
    // Sending a gate back ends the run; the note is its reason, where everyone sees it.
    const note = h('input', { placeholder: 'What should change? (optional)', 'aria-label': 'Note', maxlength: 300 });
    const confirmBack = h('button', { class: 'btn danger' }, 'Send back');
    confirmBack.addEventListener('click', () => settle(`/api/questions/${q.id}`, { answer: 'decline', note: note.value.trim() }, confirmBack));
    button.replaceWith(h('div', { class: 'key-form' }, note, confirmBack));
    note.focus();
  };
  // A gate with choices: you keep the ones you tick, and allowing needs at least one.
  const picks = new Set((q.options ?? []).map((o) => o.id));
  const allowButton = (() => {
    if (!q.options?.length) return btn('Allow', 'approve', 'primary');
    const button = h('button', { class: 'btn primary' });
    const label = () => {
      button.textContent = picks.size === q.options.length ? `Keep all ${picks.size}` : `Keep ${picks.size}`;
      button.disabled = picks.size === 0 || theirs;
    };
    label();
    button.addEventListener('click', () => settle(`/api/questions/${q.id}`, { answer: 'approve', picked: [...picks] }, button));
    button.relabel = label;
    return button;
  })();
  const optionList = q.options?.length
    ? h(
        'div',
        { class: 'picks' },
        q.options.map((o) => {
          const box = h('input', { type: 'checkbox', checked: true, 'aria-label': o.label });
          box.addEventListener('change', () => {
            if (box.checked) picks.add(o.id);
            else picks.delete(o.id);
            allowButton.relabel();
          });
          return h('label', { class: 'pick' }, box, h('span', {}, h('b', {}, o.label), o.detail ? h('small', {}, o.detail) : null));
        }),
      )
    : null;
  const sendBackButton = h('button', { class: 'btn' }, 'Send back');
  sendBackButton.addEventListener('click', () => sendBack(sendBackButton));
  const body =
    q.kind === 'guard'
      ? [h('p', {}, `Paused — ${q.count} messages between agents`), h('p', { class: 'cost' }, [`${(q.between ?? []).join(' and ')} have gone back and forth ${q.count} times without anything for you.`, q.tokens ? `About ${tokens(q.tokens)} tokens so far${q.models?.length ? ` on ${q.models.join(' and ')}` : ''}.` : null, `Continuing allows ${q.limit} more.`, waitedFor(q.askedAt)].filter(Boolean).join(' ')), claimLine, h('div', { class: 'buttons' }, answerable(btn('Continue', 'continue', 'primary')), answerable(btn('Continue and stop asking here', 'always')), answerable(btn('Stop', 'stop', 'danger')), claimButton)]
      : q.kind === 'gate'
      ? [h('p', {}, q.options?.length ? q.asks : `Waiting for an OK: ${q.asks}`), optionList, h('p', { class: 'cost' }, [`${q.outcome} · run ${q.run}, step ${q.step} of ${q.of}.`, q.options?.length ? 'Untick what you don’t want; sending it back ends this run with your note as the reason.' : 'Allowing it carries the run on to what comes next; sending it back ends this run with your note as the reason.', waitedFor(q.askedAt)].filter(Boolean).join(' ')), claimLine, h('div', { class: 'buttons' }, answerable(allowButton), answerable(sendBackButton), claimButton)]
      : q.kind === 'incoming'
      ? [
          h('p', {}, `${q.kindTitle} from ${q.fromName}`),
          h('blockquote', { class: 'incoming' }, q.text.length > 700 ? `${q.text.slice(0, 700)}…` : q.text),
          h('p', { class: 'cost' }, ['Making work of it has an agent read the project and shape this into pieces you choose from. Dismissing puts it away.', waitedFor(q.askedAt)].filter(Boolean).join(' ')),
          claimLine,
          h('div', { class: 'buttons' }, answerable(btn('Make work of it', 'work', 'primary')), answerable(btn('Dismiss', 'dismiss')), claimButton),
        ]
      : q.kind === 'note'
      ? [
          h('p', {}, `${q.agentTitle ?? 'An agent'} asks to remember `, h('b', {}, q.name)),
          h('p', { class: 'cost' }, q.description ?? ''),
          h('blockquote', { class: 'incoming' }, q.text.length > 900 ? `${q.text.slice(0, 900)}…` : q.text),
          h('p', { class: 'cost' }, [`Keeping it decides where it comes back${q.scope === 'craft' ? '' : ''}.`, waitedFor(q.askedAt)].filter(Boolean).join(' ')),
          claimLine,
          h('div', { class: 'buttons' }, [
            ...(q.scopes ?? []).map((scope) => answerable(btn(NOTE_SCOPES[scope].label, scope, scope === q.scope ? 'primary' : ''))),
            answerable(btn('Forget it', 'decline')),
            claimButton,
          ]),
          h('p', { class: 'hint tight' }, (q.scopes ?? []).map((scope) => `${NOTE_SCOPES[scope].label}: ${NOTE_SCOPES[scope].where}`).join(' · ')),
        ]
      : q.kind === 'skill'
      ? [
          h('p', {}, `${q.agentTitle ?? 'An agent'} proposes a skill: `, h('b', {}, q.name)),
          h('p', { class: 'cost' }, `Used when: ${q.description}`),
          q.why ? h('p', { class: 'cost' }, `Why: ${q.why}`) : null,
          h('details', { class: 'routine-prompt' }, h('summary', {}, 'The skill'), h('div', { class: 'prose md' }, markdown(q.body ?? ''))),
          h('p', { class: 'cost' }, ['Keeping it writes it as a skill, opened whenever that work comes up. Its own goes wherever the agent goes; every agent’s is shared by all of them.', waitedFor(q.askedAt)].filter(Boolean).join(' ')),
          claimLine,
          h('div', { class: 'buttons' }, [
            ...(q.places ?? []).map((place) => answerable(btn(place === 'agent' ? `${q.agentTitle}’s own` : place === 'library' ? 'Every agent' : `${q.projectName ?? 'This project'}’s`, place, place === q.where ? 'primary' : ''))),
            answerable(btn('Decline', 'decline')),
            claimButton,
          ]),
        ]
      : q.kind === 'signin'
      ? (() => {
          const open = h('button', { class: 'btn primary' }, q.how === 'browser' ? `Open ${q.site}` : `Sign in to ${q.where}`);
          open.addEventListener('click', async () => {
            open.disabled = true;
            try {
              if (q.how === 'browser') {
                const main = document.querySelector('#content main') ?? document.body;
                const { live } = await api(`/api/connections/${encodeURIComponent(q.connection)}/sign-ins`, { url: q.url, width: Math.min(main.clientWidth - 32, 1280), height: Math.round(Math.min(innerHeight * 0.62, 1000)) });
                go(`#/connections/${encodeURIComponent(q.connection)}/live/${live}?site=${encodeURIComponent(q.site)}&question=${encodeURIComponent(q.id)}`);
              } else {
                const { authorizeUrl } = await api(`/api/connections/${encodeURIComponent(q.connection)}/signin`, { question: q.id });
                location.assign(authorizeUrl);
              }
            } catch (err) {
              open.disabled = false;
              showError(err);
            }
          });
          const done = h('button', { class: 'btn' }, 'I’m done, continue');
          done.addEventListener('click', () => answer('done', done));
          const decline = h('button', { class: 'btn' }, 'Not now');
          decline.addEventListener('click', () => answer('decline', decline));
          return [
            h('p', {}, `${q.agentTitle ?? 'An agent'} asks you to sign in to `, h('b', {}, q.where)),
            h('p', { class: 'cost' }, q.purpose),
            h('p', { class: 'hint tight' }, q.how === 'browser' ? 'It opens in a browser on this computer. Your password goes to the site. Keep the sign-in there, then come back and continue. The agent never sees the password or the cookies.' : `It opens ${q.where}’s own sign-in page. Polyphemus keeps the token. The agent never sees it. Come back here when you’re done.`),
            claimLine,
            h('div', { class: 'buttons' }, open, done, decline, claimButton),
          ];
        })()
      : q.kind === 'secret'
      ? (() => {
          const scopes = q.scopes ?? [];
          const secret = h('input', { type: 'password', class: 'secret-input', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'The secret' });
          const who = scopes.length > 1
            ? h('select', { 'aria-label': 'Who it’s kept for' }, scopes.map((scope) => h('option', { value: scope }, scope === 'agent' ? `Only ${q.agentTitle}` : `Anyone working in ${q.projectName}`)))
            : null;
          const save = h('button', { class: 'btn primary' }, q.exists ? 'Replace it' : 'Save in the vault');
          save.addEventListener('click', () => {
            if (!secret.value) return toast('Type the secret first.', 'error');
            const value = secret.value;
            secret.value = '';
            settle(`/api/questions/${q.id}`, { value, who: who ? who.value : scopes[0] ?? 'keep' }, save);
          });
          const decline = h('button', { class: 'btn' }, 'Don’t save it');
          decline.addEventListener('click', () => answer('decline', decline));
          const keptFor = scopes.length === 1 && scopes[0] === 'agent' ? `Only ${q.agentTitle} is recorded as who it’s for.` : scopes.length === 1 ? `Anyone working in ${q.projectName} is recorded as who it’s for.` : 'Nothing can put it into a command yet. Who it’s for is recorded for when that exists.';
          return [
            h('p', {}, `${q.agentTitle ?? 'An agent'} asks for a secret: `, h('b', {}, q.name)),
            h('p', { class: 'cost' }, q.purpose),
            q.exists ? h('p', { class: 'cost' }, 'Saving replaces the one already kept under this name.') : null,
            h('label', { class: 'field tight' }, h('span', {}, 'The secret'), secret),
            who ? h('label', { class: 'field tight' }, h('span', {}, 'Who it’s kept for'), who) : null,
            h('p', { class: 'hint tight' }, `It goes into the vault. The agent is told the name, not the value. ${keptFor}`),
            claimLine,
            h('div', { class: 'buttons' }, save, decline, claimButton),
          ];
        })()
      : q.kind === 'invite'
      ? (s && !s.project && (s.members ?? []).length < 2) || q.newThread
      ? [
          h('p', {}, `${q.from} wants to start a thread with `, h('b', {}, q.agent)),
          q.about ? h('p', { class: 'cost' }, `${q.agent}: ${q.about}`) : null,
          h('p', { class: 'cost' }, [`This conversation stays just you and ${q.from}. The new thread has both of them, and ${q.agent} picks up there from what ${q.from} said.`, waitedFor(q.askedAt)].filter(Boolean).join(' ')),
          claimLine,
          h('div', { class: 'buttons' }, answerable(btn('Start the thread', 'bring', 'primary')), answerable(btn('Not now', 'dismiss')), claimButton),
        ]
      : [
          h('p', {}, `${q.from} wants to bring `, h('b', {}, q.agent), ' into this thread'),
          q.about ? h('p', { class: 'cost' }, `${q.agent}: ${q.about}`) : null,
          h('p', { class: 'cost' }, [`Bringing them in adds them to the thread, and they pick up from what ${q.from} said. Anyone can take them out again from who’s here.`, waitedFor(q.askedAt)].filter(Boolean).join(' ')),
          claimLine,
          h('div', { class: 'buttons' }, answerable(btn(`Bring in ${q.agent}`, 'bring', 'primary')), answerable(btn('Not now', 'dismiss')), claimButton),
        ]
      : q.kind === 'profile'
      ? [
          h('p', {}, `${q.agentTitle ?? 'An agent'} proposes a change to its own profile`),
          h('p', { class: 'cost' }, q.why ?? ''),
          h('div', { class: 'changes' }, (q.fields ?? []).map((f) => h('details', { class: 'routine-prompt' },
            h('summary', {}, `${{ persona: 'Who it is', instructions: 'What it does here', description: 'One line' }[f.field] ?? f.field}`),
            h('div', { class: 'prose md' }, markdown(f.after)),
            f.before?.trim() ? h('details', {}, h('summary', {}, 'What it says now'), h('div', { class: 'prose md muted' }, markdown(f.before))) : null,
          ))),
          h('p', { class: 'cost' }, ['Accepting rewrites its profile, which every later thread with it starts from. Threads already open keep what they started with.', waitedFor(q.askedAt)].filter(Boolean).join(' ')),
          claimLine,
          h('div', { class: 'buttons' }, answerable(btn('Accept', 'accept', 'primary')), answerable(btn('Decline', 'decline')), claimButton),
        ]
      : q.kind === 'routine' && q.stop
      ? [
          h('p', {}, `${q.agentTitle ?? 'An agent'} proposes stopping the routine `, h('b', {}, q.name), q.projectName ? ` in ${q.projectName}` : ' outside every project'),
          q.description ? h('p', { class: 'cost' }, q.description) : null,
          h('p', { class: 'cost' }, ['It keeps running until you accept. Accepting moves it to the trash in Polyphemus’s folder, not deletes it.', waitedFor(q.askedAt)].filter(Boolean).join(' ')),
          claimLine,
          h('div', { class: 'buttons' }, answerable(btn('Stop it', 'accept', 'primary')), answerable(btn('Keep it', 'decline')), claimButton),
        ]
      : q.kind === 'routine'
      ? [
          h('p', {}, `${q.agentTitle ?? 'An agent'} proposes ${q.replaces ? 'a change to the routine' : 'a routine'} ${q.projectName ? `for ${q.projectName}` : 'outside every project'}: `, h('b', {}, q.name)),
          h('p', { class: 'cost' }, [q.description, `Runs ${q.schedule}${q.agentTitle ? `, as ${q.agentTitle}` : ''}. ${q.mode === 'read-only' ? 'It can only read.' : q.mode === 'yolo' ? 'It runs without asking.' : q.asks === false ? 'It runs on Codex, which doesn’t ask before changes.' : 'Anything it changes or posts asks first.'}`].filter(Boolean).join(' ')),
          h('details', { class: 'routine-prompt' }, h('summary', {}, 'What it does each time'), h('blockquote', { class: 'incoming' }, q.prompt.length > 1500 ? `${q.prompt.slice(0, 1500)}…` : q.prompt)),
          h('p', { class: 'cost' }, [q.replaces ? 'Accepting puts this in place of the routine there now, which goes to the trash in Polyphemus’s folder. Until then the old one keeps running.' : 'Accepting saves it with the routines, where it can be run now, paused or removed. Nothing is scheduled until then.', waitedFor(q.askedAt)].filter(Boolean).join(' ')),
          claimLine,
          h('div', { class: 'buttons' }, answerable(btn('Accept', 'accept', 'primary')), answerable(btn('Decline', 'decline')), claimButton),
        ]
      : q.kind === 'outcome'
        ? [h('p', {}, `${q.agentTitle ?? 'The agent'} offers to track this as work: “${q.text}”`), h('p', { class: 'cost' }, [q.why, 'It would show on Home with a status instead of a last message. Nothing runs until someone starts it.'].filter(Boolean).join(' ')), claimLine, h('div', { class: 'buttons' }, answerable(btn('Track it', 'track', 'primary')), answerable(btn('Just answer me', 'decline')), claimButton)]
      : q.kind === 'approval'
      ? [h('p', {}, `Waiting for your OK to run ${q.tool}`), h('code', {}, q.summary), cost, claimLine, h('div', { class: 'buttons' }, answerable(btn('Allow', 'allow', 'primary')), answerable(btn('Always this one', 'always')), answerable(btn('Deny', 'deny', 'danger')), claimButton)]
      : [h('p', {}, q.reason), cost, claimLine, h('div', { class: 'buttons' }, q.candidates.map((c) => answerable(btn(`Use ${c.label}`, c.label, 'primary'))), answerable(btn('Stay', '')), claimButton)];
  // Identified by attribute, not id: the same question is drawn on Home and inside its thread,
  // and duplicate ids meant answering it cleared whichever copy came first in the document.
  return h('div', { class: `ask ${theirs ? 'taken' : ''}`, 'data-question': q.id }, head, body);
}

/** Everything else waiting on a person, as the same card: proposals to review, routines that stopped. */
function otherWaitingCards() {
  const cards = [...connectionIssueCards()];
  for (const p of activeProjects()) {
    if (!p.inbox || !(isOwner() || p.role === 'member')) continue;
    cards.push(
      h(
        'div',
        { class: 'ask calm' },
        h('button', { class: 'ask-head', onclick: () => go(`#/review/${encodeURIComponent(p.slug)}`) }, squircle(p, 24), h('b', {}, p.name), h('span', { class: 'tag' }, 'Proposals')),
        h('p', {}, 'Suggested edits to its rules and notes'),
        h('p', { class: 'cost' }, `${p.inbox} waiting. Nothing changes until you keep one.`),
        h('div', { class: 'buttons' }, h('button', { class: 'btn primary', onclick: () => go(`#/review/${encodeURIComponent(p.slug)}`) }, 'Review')),
      ),
    );
  }
  for (const r of state.routines ?? []) {
    const p = r.project ? projectOf(r.project) : null;
    // New or changed in the project's folder, where agents write: it runs only once a person says yes.
    if (r.waiting && (isOwner() || p?.role === 'member')) {
      cards.push(
        h(
          'div',
          { class: 'ask' },
          h('div', { class: 'ask-head' }, h('b', {}, `Routine: ${r.name}`), p ? h('span', { class: 'tag' }, p.name) : null),
          h('p', {}, 'Waiting for your OK to run'),
          h('p', { class: 'cost' }, `Runs ${r.schedule}. It’s new or changed in the project’s folder since anyone accepted it, so it doesn’t run until someone reads it and says yes.`),
          h('div', { class: 'buttons' }, h('button', { class: 'btn primary', onclick: () => routineSheet(r) }, 'Read it')),
        ),
      );
      continue;
    }
    // A routine someone paused on purpose isn't waiting on you: it stayed here with no way to clear it
    // (2026-09-22). One polyphemus paused, after failures or with its agent gone, is.
    const stopped = r.paused && !r.pausedOnPurpose;
    const failed = stopped || (!r.paused && r.last?.outcome === 'failed');
    if (!failed || !(isOwner() || p?.role === 'member')) continue;
    cards.push(
      h(
        'div',
        { class: 'ask' },
        h('div', { class: 'ask-head' }, h('b', {}, r.paused ? `Routine paused: ${r.name}` : `Routine failed: ${r.name}`), p ? h('span', { class: 'tag' }, p.name) : null),
        h('p', {}, r.paused ? (r.pausedReason ?? 'It stopped running on its schedule.') : (r.last?.reason ?? 'Its last run failed.')),
        h('p', { class: 'cost' }, r.paused ? 'It won’t run again until it’s resumed.' : 'It runs again on its schedule; the thread says what went wrong.'),
        h('div', { class: 'buttons' }, r.paused ? h('button', { class: 'btn primary', onclick: async (e) => {
          e.currentTarget.disabled = true;
          await api(`/api/routines/${encodeURIComponent(r.id)}/pause`, { paused: false }).catch(showError);
          await refresh().then(render, () => {});
        } }, 'Resume') : null, r.last?.sessionId ? h('button', { class: 'btn', onclick: () => go(`#/s/${r.last.sessionId}`) }, 'See what happened') : null, p ? h('button', { class: 'btn', onclick: () => go(`#/p/${encodeURIComponent(p.slug)}`) }, 'Open project') : null),
      ),
    );
  }
  return cards;
}

function toggle(label, hint, on, onchange) {
  const button = h('button', { class: 'switcher', role: 'switch', 'aria-label': label, 'aria-checked': String(on) });
  button.addEventListener('click', () => {
    const next = button.getAttribute('aria-checked') !== 'true';
    button.setAttribute('aria-checked', String(next));
    onchange(next);
  });
  return h('div', { class: 'item' }, h('span', { class: 'grow' }, h('span', {}, label), hint ? h('small', {}, hint) : null), button);
}

// ── Home: what needs you, what's working, what's recent ──────────────────

const WEEK = 7 * 24 * 3600 * 1000;

/** Everything waiting on this person — the same number on Home's heading, the tab badge and the page title. */
const waitingTotal = () => state.questions.length + otherWaitingCards().length;

/** Recency, in the words people use: working now, today, yesterday, earlier. */
function whenGroup(s) {
  if (s.running) return 'Working now';
  const d = new Date(s.updatedAt);
  const today = new Date();
  const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86400000);
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : 'Earlier';
}

// ── Arranging the list (finding-your-way decisions §2) ───────────────────
// One list, from one endpoint, with one row. You may group it — by time, project or agent, and
// inside a project by kind — but never sort it, and a filter always says what it hides.

/** The project Home is scoped to on this device, if it's still one you can see. */
/**
 * Narrowing a list you're looking at, as you type: rows only, on this screen, cleared when you leave.
 * Deep search — archived threads, by agent, by project — is its own screen and stays one tap away.
 */
const filters = new Map();
const filterFor = (key) => filters.get(key) ?? '';
function filterStrip(key, placeholder, { hidden = 0, more } = {}) {
  const input = h('input', { type: 'search', class: 'filter-input', placeholder, value: filterFor(key), 'aria-label': placeholder, autocomplete: 'off' });
  let typing;
  input.addEventListener('input', () => {
    filters.set(key, input.value);
    clearTimeout(typing);
    // Redrawn a beat after you stop, so a long list doesn't rebuild on every keystroke.
    typing = setTimeout(() => {
      redraw();
      const again = $('.filter-input');
      if (again) {
        again.focus();
        again.setSelectionRange(again.value.length, again.value.length);
      }
    }, 140);
  });
  const clear = h('button', { class: 'filter-clear', 'aria-label': 'Clear', onclick: () => (filters.delete(key), redraw()) }, '×');
  return h(
    'div',
    { class: 'filter-strip' },
    h('div', { class: 'filter-box' }, icon('search', 'ico mini'), input, filterFor(key) ? clear : null),
    filterFor(key) ? h('small', { class: 'hint tight' }, hidden ? `Hiding ${hidden}.` : 'Nothing hidden.', more ? [' ', h('button', { class: 'linky inline', onclick: more.go }, more.label)] : null) : null,
  );
}

/** Everything about a thread worth matching against: what it's called, who's in it, where it is, its last line. */
const threadText = (s) => [s.title, s.preview, s.lastLine?.text, projectOf(s.project ?? '')?.name, (s.members ?? []).map((m) => m.title).join(' '), s.agent].filter(Boolean).join(' ');

/** Whether a row matches what's typed: every word has to appear somewhere in it. */
function matches(text, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = text.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

function homeScope() {
  const slug = remembered('polyphemus.scope');
  return slug ? activeProjects().find((p) => p.slug === slug) ?? null : null;
}
function setScope(slug) {
  remember('polyphemus.scope', slug ?? '');
  steady.clear();
}

/** Rows in the order they were first shown, until you ask for the new order (or reload). */
const steady = new Map();
function steadyOrder(key, rows) {
  const kept = steady.get(key);
  if (!kept) {
    steady.set(key, rows.map((r) => r.id));
    return { rows, pending: 0, moved: 0 };
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const waiting = waitingIds();
  const shown = kept.filter((id) => byId.has(id)).map((id) => byId.get(id));
  const fresh = rows.filter((r) => !kept.includes(r.id));
  // Something waiting on you is the one thing worth interrupting for: it comes straight in.
  const arriving = fresh.filter((r) => waiting.has(r.id));
  kept.unshift(...arriving.map((r) => r.id));
  const natural = new Map(rows.map((r, i) => [r.id, i]));
  const wouldMove = shown.filter((r, i) => (natural.get(r.id) ?? i) < i).length;
  // New threads and ones that would move up are said apart: an agent at work moves its thread up with
  // every update, and "1 new" came straight back after a tap, with nothing new (2026-09-22).
  return { rows: [...arriving, ...shown], pending: fresh.length - arriving.length, moved: wouldMove };
}

const VIEW_LABELS = { time: 'Time', project: 'Project', agent: 'Agent', kind: 'Kind' };

/** Which group a row belongs to under a view: exactly one, always. */
function groupOf(s, view) {
  if (view === 'project') {
    const p = s.project ? projectOf(s.project) : null;
    return p ? { key: `p:${p.slug}`, label: p.name, project: p } : { key: 'p:', label: 'No project', last: true };
  }
  if (view === 'agent') {
    const members = s.members ?? [];
    const id = s.lead ?? (members.length === 1 ? members[0].id : undefined) ?? (members.length ? undefined : s.agent);
    const agent = id ? members.find((m) => m.id === id) ?? agentByRef(id) : undefined;
    // The default agent's threads come after the ones you picked someone for, like "no one" did.
    return agent ? { key: `a:${agent.id}`, label: agent.title, agent, ...(agent.id === state.defaultAgent && { last: true }) } : { key: 'a:', label: 'No agent', last: true };
  }
  if (view === 'kind') return s.work ? { key: 'k:work', label: 'Work', order: 0 } : { key: 'k:chat', label: 'Conversations', order: 1 };
  const when = whenGroup(s);
  return { key: `t:${when}`, label: when, order: ['Working now', 'Today', 'Yesterday', 'Earlier'].indexOf(when) };
}

/** Three or more quiet threads polyphemus started, of one kind, in a row, become one row that opens in place. */
const openRollups = new Set();
function withRollups(rows) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= 3 && !openRollups.has(run[0].id)) out.push({ rollup: run });
    else out.push(...run);
    run = [];
  };
  for (const s of rows) {
    const quiet = madeByPolyphemus(s) && !s.waiting && s.state !== 'paused';
    if (quiet && (!run.length || Boolean(run[0].work) === Boolean(s.work))) run.push(s);
    else {
      flush();
      if (quiet) run.push(s);
      else out.push(s);
    }
  }
  flush();
  return out;
}

function rollupRow(run, showProject) {
  const projects = [...new Set(run.map((s) => (s.project ? projectOf(s.project)?.name : null)).filter(Boolean))];
  return h(
    'button',
    { class: 'row rollup', onclick: () => (openRollups.add(run[0].id), redraw()) },
    h('span', { class: 'mark-none stack', 'aria-hidden': 'true' }, String(run.length)),
    h(
      'span',
      { class: 'row-main' },
      h('span', { class: 'row-top' }, h('b', {}, `${run.length} ${run[0].work ? 'work items' : 'threads'} polyphemus started`), h('time', {}, ago(run[0].updatedAt))),
      h('span', { class: 'row-sub' }, h('span', { class: 'text' }, [showProject && projects.length ? projects.join(', ') : null, 'Show them'].filter(Boolean).join(' · '))),
    ),
  );
}

/**
 * The thread list, arranged: Home's, or a project's Work tab. `scope` is a project, or null for
 * everything. Waiting on you stays above the groups, and a filter never hides one without a line.
 */
function threadList({ scope, rows, place, empty, filter }) {
  const viewKey = scope ? 'polyphemus.scopedView' : 'polyphemus.homeView';
  const views = scope ? ['kind', 'time', 'agent'] : ['time', 'project', 'agent'];
  const view = views.includes(remembered(viewKey)) ? remembered(viewKey) : views[0];
  const listKey = `${place}:${scope?.slug ?? ''}:${view}`;
  const { rows: ordered, pending, moved } = steadyOrder(listKey, rows);

  // Outside every project, only what's waiting out here: a gate in a project belongs to that project.
  const loose = place === 'direct';
  const questions = scope
    ? state.questions.filter((q) => sessionById(q.sessionId)?.project === scope.slug)
    : loose
      ? state.questions.filter((q) => !sessionById(q.sessionId)?.project)
      : state.questions;
  const others = scope || loose ? [] : otherWaitingCards();
  const hiddenWaiting = scope || loose ? waitingTotal() - questions.length : 0;
  const waitingCount = questions.length + others.length;

  // Collapsing is only offered where there are headings to collapse: grouped by project or agent.
  const groupedByHeadings = view === 'project' || view === 'agent';

  const groups = [];
  for (const s of ordered) {
    const g = groupOf(s, view);
    const found = groups.find((x) => x.key === g.key) ?? (groups.push({ ...g, rows: [] }), groups.at(-1));
    found.rows.push(s);
  }
  // Groups in the order of their newest thread (the list is newest first), with "none" last;
  // time and kind keep their own fixed order.
  groups.sort((a, b) => (a.order !== undefined && b.order !== undefined ? a.order - b.order : Number(Boolean(a.last)) - Number(Boolean(b.last))));
  const collapsed = new Set((remembered('polyphemus.collapsed') ?? '').split('\n').filter(Boolean));
  const toggle = (key) => {
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    remember('polyphemus.collapsed', [...collapsed].join('\n'));
    redraw();
  };
  const allShut = groupedByHeadings && groups.length > 1 && groups.every((g) => collapsed.has(`${view}|${g.key}`));
  const control = h(
    'div',
    { class: 'view-control' },
    h('span', { class: 'label' }, 'View'),
    h(
      'div',
      { class: 'segmented small', role: 'tablist', 'aria-label': 'Arrange the list' },
      views.map((v) => h('button', { type: 'button', role: 'tab', 'aria-pressed': String(v === view), onclick: () => (remember(viewKey, v), steady.delete(listKey), redraw()) }, VIEW_LABELS[v])),
    ),
    groupedByHeadings && groups.length > 1
      ? h('button', { class: 'fold', 'aria-label': allShut ? 'Expand all' : 'Collapse all', title: allShut ? 'Expand all' : 'Collapse all', onclick: () => {
          for (const g of groups) {
            if (allShut) collapsed.delete(`${view}|${g.key}`);
            else collapsed.add(`${view}|${g.key}`);
          }
          remember('polyphemus.collapsed', [...collapsed].join('\n'));
          redraw();
        } }, icon(allShut ? 'expand' : 'collapse', 'ico'))
      : null,
  );

  const showProject = !scope && view !== 'project';
  const drawGroup = (g) => {
    const shut = collapsed.has(`${view}|${g.key}`);
    const heading =
      view === 'project' || view === 'agent'
        ? h(
            'div',
            { class: 'group-head' },
            h(
              'button',
              { class: 'group-toggle', 'aria-expanded': String(!shut), onclick: () => toggle(`${view}|${g.key}`) },
              g.project ? squircle(g.project, 20) : g.agent ? mark(g.agent.mark ?? g.agent.name, 20) : h('span', { class: 'mark-none tiny' }),
              h('b', {}, g.label),
              h('span', { class: 'count' }, String(g.rows.length)),
            ),
            g.project ? h('button', { class: 'linky', onclick: () => go(`#/p/${encodeURIComponent(g.project.slug)}`) }, 'Open') : null,
          )
        : sec(g.label, g.label === 'Working now' || view === 'kind' ? g.rows.length : '');
    return [heading, shut ? null : h('div', { class: 'list' }, withRollups(g.rows).map((item) => (item.rollup ? rollupRow(item.rollup, showProject) : sessionRow(item, showProject))))];
  };

  return [
    sec('Waiting on you', waitingCount || ''),
    waitingCount ? [questions.map((q) => questionCard(q)), others] : h('p', { class: 'empty' }, scope ? `Nothing is waiting on you in ${scope.name}.` : loose ? 'Nothing is waiting on you out here.' : 'Nothing is waiting on you.'),
    hiddenWaiting > 0
      ? h('div', { class: 'elsewhere' }, h('span', {}, `${hiddenWaiting} more waiting ${loose ? 'in your projects' : 'in other projects'}`), h('button', { class: 'linky', onclick: () => (setScope(null), location.hash === '#/' ? render() : go('#/')) }, 'Show all'))
      : null,
    rows.length || filter ? control : null,
    filter,
    pending || moved
      ? h('button', { class: 'new-pill', onclick: () => (steady.delete(listKey), redraw()) }, pending ? `${pending} new · tap to show ${pending === 1 ? 'it' : 'them'}` : 'Newer activity · tap to reorder')
      : null,
    groups.length ? groups.map(drawGroup) : h('p', { class: 'empty' }, empty ?? (scope ? 'No threads here yet. Start one with +.' : 'No threads yet. Start one with +, or in the terminal with polyphemus.')),
  ];
}

/**
 * Home — or, given a project, that project's own list: the same waiting cards and threads, headed by
 * the project (a tap opens its overview) with the way back to Projects, and no filter chip, since
 * it isn't a filter. Beside it, the project's overview or the thread you picked.
 */
function homeScreen(fixed) {
  const active = new Set(activeProjects().map((p) => p.slug));
  const waiting = waitingIds();
  // A finished thread leaves Home a week after it finished — it's still in search and in its
  // project — and a kept one never does.
  const visible = state.sessions.filter((s) => {
    if (s.project && !active.has(s.project) && !s.running && !waiting.has(s.id)) return false;
    return !(s.state === 'finished' && s.finishedAt && Date.now() - s.finishedAt > WEEK);
  });
  const scope = fixed ?? homeScope();
  const scoped = scope ? visible.filter((s) => s.project === scope.slug) : visible;
  const query = filterFor(fixed ? `project:${fixed.slug}` : 'home');
  const rows = query ? scoped.filter((s) => matches(threadText(s), query)) : scoped;
  const hidden = visible.length - scoped.length;
  const hiddenProjects = new Set(visible.filter((s) => s.project !== scope?.slug).map((s) => s.project ?? '')).size;
  const canStart = isOwner() || state.projects.some((p) => p.role === 'member');
  const head = fixed
    ? bar(
        round('back', 'All projects', () => go('#/projects')),
        h('button', { type: 'button', class: 'list-project', title: `${fixed.name}: its overview and setup`, onclick: () => go(`#/p/${encodeURIComponent(fixed.slug)}`) }, squircle(fixed, 26), h('span', {}, fixed.name)),
        [round('search', `Search ${fixed.name}`, () => go(`#/threads?project=${encodeURIComponent(fixed.slug)}`)), canStart && (isOwner() || fixed.role === 'member') ? round('plus', `New thread in ${fixed.name}`, () => go(`#/new?project=${encodeURIComponent(fixed.slug)}`)) : null],
      )
    : bar(brand(), null, [themeButton(), round('search', 'Search every thread', () => go('#/threads')), canStart ? round('plus', 'New thread', () => go(scope ? `#/new?project=${encodeURIComponent(scope.slug)}` : '#/new')) : null]);
  screen(
    head,
    [
      fixed ? null : firstRun(),
      fixed ? null : pushBanner(),
      // The filter is always on screen while it's on, with what it hides in words.
      scope && !fixed
        ? h(
            'div',
            { class: 'scope' },
            h(
              'span',
              { class: 'scope-chip' },
              h('button', { class: 'scope-name', onclick: () => go(`#/p/${encodeURIComponent(scope.slug)}`) }, squircle(scope, 20), scope.name),
              h('button', { class: 'scope-clear', 'aria-label': `Show every project, not only ${scope.name}`, title: 'Show everything', onclick: () => (setScope(null), render()) }, '×'),
            ),
            hidden ? h('small', {}, `hiding ${hidden} thread${hidden === 1 ? '' : 's'} in ${hiddenProjects} other project${hiddenProjects === 1 ? '' : 's'}`) : null,
          )
        : null,
      threadList({
        scope,
        rows,
        place: 'home',
        // Under the View row: it narrows this list, and deep search is its own screen.
        filter: scoped.length > 4 || query
          ? filterStrip(fixed ? `project:${fixed.slug}` : 'home', 'Filter threads', {
              hidden: scoped.length - rows.length,
              more: { label: 'Search everything, including archived', go: () => go(`#/threads?q=${encodeURIComponent(query)}`) },
            })
          : null,
      }),
      fixed ? h('button', { class: 'linky', onclick: () => go(`#/threads?project=${encodeURIComponent(fixed.slug)}`) }, 'Every thread here') : state.archivedCount ? h('button', { class: 'linky', onclick: () => go('#/threads?archived=1') }, `Archived (${state.archivedCount})`) : null,
    ],
    { tabs: true },
  );
}

/**
 * Direct: the conversations that belong to no project — one per agent, per person, or per group, the
 * way a messaging app lists them. There's one thread with each of them, not a list of threads: opening
 * a row opens that conversation, and a name you haven't talked to yet starts one on your first message.
 */
function directScreen() {
  const loose = state.sessions.filter((s) => !s.project && !s.archivedAt);
  // Who a thread is with: its agents and the other people in it, as one key.
  const whoOf = (s) => [...(s.members ?? []).map((m) => m.id), ...(s.people ?? []).filter((id) => id !== state.me?.id).map((id) => `person:${id}`)].sort();
  const conversations = new Map();
  for (const s of loose) {
    const key = whoOf(s).join('+') || `thread:${s.id}`;
    const found = conversations.get(key);
    if (!found || s.updatedAt > found.thread.updatedAt) conversations.set(key, { key, thread: s, who: whoOf(s), older: found ? found.older + 1 : 0 });
    else found.older += 1;
  }
  const named = (c) => {
    const agents = (c.thread.members ?? []).map((m) => m.title);
    const people = (c.thread.people ?? []).filter((id) => id !== state.me?.id).map((id) => personById(id)?.name ?? 'someone');
    return [...agents, ...people].join(', ') || c.thread.title || 'A conversation';
  };
  const query = filterFor('direct');
  // Recent is the default; by name is for finding someone you talk to rarely.
  const sorts = [['recent', 'Recent'], ['name', 'Name']];
  const sort = sorts.some(([id]) => id === remembered('polyphemus.directSort')) ? remembered('polyphemus.directSort') : 'recent';
  const order = (a, b) => (sort === 'name' ? named(a).localeCompare(named(b)) : a.thread.updatedAt < b.thread.updatedAt ? 1 : -1);
  // Who it's with, as a kind: one agent, one person, or a group of more than one.
  const kindOf = (who) => (who.length > 1 ? 'groups' : who[0]?.startsWith('person:') ? 'people' : 'agents');
  const shows = [['all', 'All'], ['agents', 'Agents'], ['people', 'People'], ['groups', 'Groups']];
  const everyKind = new Set([...conversations.values()].map((c) => kindOf(c.who)));
  const show = shows.some(([id]) => id === remembered('polyphemus.directShow')) ? remembered('polyphemus.directShow') : 'all';
  const showing = (kind) => show === 'all' || show === kind;
  const rows = [...conversations.values()].sort(order).filter((c) => showing(kindOf(c.who)) && (!query || matches(`${named(c)} ${threadText(c.thread)}`, query)));
  // Who you haven't talked to outside a project yet: the rest of the address book, agents and people.
  const talkedTo = new Set([...conversations.values()].flatMap((c) => c.who));
  const others = [
    // An agent that belongs to a project is that project's: you talk to it there, with its rules and memory.
    ...(state.agents ?? []).filter((a) => !a.project && !talkedTo.has(a.id)).map((a) => ({ id: a.id, kind: 'agent', title: a.title, sub: a.description || 'No messages yet', agent: a })),
    ...(state.people ?? []).filter((p) => p.id !== state.me?.id && !talkedTo.has(`person:${p.id}`)).map((p) => ({ id: `person:${p.id}`, kind: 'person', title: p.name, sub: p.owner ? 'Owner of this install' : 'No messages yet', person: p })),
  ];
  for (const o of others) everyKind.add(o.kind === 'person' ? 'people' : 'agents');
  const rest = others.filter((o) => showing(o.kind === 'person' ? 'people' : 'agents') && (!query || matches(`${o.title} ${o.sub}`, query))).sort((a, b) => a.title.localeCompare(b.title));
  const waiting = state.questions.filter((q) => !sessionById(q.sessionId)?.project);
  const elsewhere = waitingTotal() - waiting.length;

  const row = (c) => {
    const s = c.thread;
    const onAPerson = s.waiting || s.state === 'paused';
    return h(
      'button',
      { class: 'row', onclick: () => go(`#/s/${s.id}`) },
      alive(whoMark(s), s.running),
      h(
        'span',
        { class: 'row-main' },
        h('span', { class: 'row-top' }, h('b', {}, named(c)), h('time', {}, s.running ? 'now' : ago(s.updatedAt))),
        h('span', { class: 'row-sub' }, h('span', { class: 'text' }, rowLine(s)), dot(onAPerson ? 'needs' : s.running ? 'working' : '')),
      ),
    );
  };
  const startRow = (o) =>
    h(
      'button',
      { class: 'row', onclick: () => go(o.kind === 'person' ? `#/new?with=${encodeURIComponent(o.id)}` : `#/new?direct=1&agent=${encodeURIComponent(o.id)}`) },
      o.kind === 'person' ? face(o.title, 'md') : mark(o.agent.mark ?? o.agent.name),
      h('span', { class: 'row-main' }, h('span', { class: 'row-top' }, h('b', {}, o.title)), h('span', { class: 'row-sub' }, h('span', { class: 'text' }, o.sub))),
    );

  screen(
    bar(title('Direct'), null, [themeButton(), round('search', 'Search every thread', () => go('#/threads')), round('plus', 'New conversation', () => go('#/new?direct=1'))]),
    [
      waiting.length ? [sec('Waiting on you', waiting.length), waiting.map((q) => questionCard(q))] : null,
      elsewhere > 0 && waiting.length
        ? h('div', { class: 'elsewhere' }, h('span', {}, `${elsewhere} more waiting in your projects`), h('button', { class: 'linky', onclick: () => go('#/') }, 'Show all'))
        : null,
      conversations.size + others.length > 4 || query
        ? filterStrip('direct', 'Filter conversations', { hidden: conversations.size + others.length - (rows.length + rest.length) })
        : null,
      // Only when there's more than one kind to tell apart: agents, people, groups.
      everyKind.size > 1
        ? h(
            'div',
            { class: 'view-control' },
            h('span', { class: 'label' }, 'Show'),
            h(
              'div',
              { class: 'segmented small', role: 'tablist', 'aria-label': 'Show conversations with' },
              shows.filter(([id]) => id === 'all' || everyKind.has(id)).map(([id, label]) => h('button', { type: 'button', role: 'tab', 'aria-pressed': String(id === show), onclick: () => (remember('polyphemus.directShow', id), redraw()) }, label)),
            ),
          )
        : null,
      rows.length > 1
        ? h(
            'div',
            { class: 'view-control' },
            h('span', { class: 'label' }, 'Sort'),
            h(
              'div',
              { class: 'segmented small', role: 'tablist', 'aria-label': 'Sort conversations' },
              sorts.map(([id, label]) => h('button', { type: 'button', role: 'tab', 'aria-pressed': String(id === sort), onclick: () => (remember('polyphemus.directSort', id), redraw()) }, label)),
            ),
          )
        : null,
      rows.length ? [sec('Conversations', rows.length), h('div', { class: 'list' }, rows.map(row))] : null,
      rest.length ? [sec(rows.length ? 'Say hello' : 'Start a conversation', rest.length), h('div', { class: 'list' }, rest.map(startRow))] : null,
      !rows.length && !rest.length ? h('p', { class: 'empty' }, query ? 'Nobody matches that.' : show !== 'all' ? `No ${show === 'groups' ? 'group conversations' : show} here yet.` : 'Nobody to talk to yet. Make an agent under Team, or pair someone under Setup.') : null,
    ],
    { tabs: true },
  );
}

/**
 * A fresh install has nothing to run on, and everything else now assumes it does: an agent
 * inherits a route, and a sentence is written up on one. So say so first, rather than letting
 * the first thing you try fail.
 */
function firstRun() {
  // What matters is whether anything is picked, not whether anything is listed: a new install ships
  // six providers to choose between, so counting the list hid this card from the people it's for.
  if (state.defaultModel || state.models.some((m) => m.chosen)) return null;
  return h(
    'div',
    { class: 'first-run' },
    h('b', {}, 'Nothing to run on yet'),
    h('p', {}, 'Sign in to a provider and name a model. Everything else — threads, agents, routines — uses it unless you say otherwise.'),
    h('div', { class: 'buttons' }, h('button', { class: 'btn primary', onclick: () => go('#/models') }, 'Set up models')),
  );
}

// ── Projects ─────────────────────────────────────────────────────────────

function projectCard(p) {
  const threads = state.sessions.filter((s) => s.project === p.slug);
  const needs = state.questions.filter((q) => sessionById(q.sessionId)?.project === p.slug).length;
  const stats = [
    h('span', {}, `${threads.length} thread${threads.length === 1 ? '' : 's'}`),
    needs ? h('span', { class: 'warn' }, `${needs} need${needs === 1 ? 's' : ''} you`) : null,
    p.needsOrientation && p.status === 'active' ? h('span', { class: 'warn' }, 'Needs setup') : null,
    p.inbox ? h('span', { class: 'warn' }, `${p.inbox} to review`) : null,
  ];
  return h(
    'button',
    { class: `proj ${p.status === 'active' ? '' : 'faded'}`, onclick: () => go(`#/p/${p.slug}`) },
    squircle(p),
    h('span', { style: 'min-width:0' }, h('b', {}, p.name), p.description ? h('small', {}, p.description) : null, h('span', { class: 'stats' }, stats)),
  );
}

function projectsScreen() {
  const query = filterFor('projects');
  const text = (p) => [p.name, p.description, p.path].filter(Boolean).join(' ');
  const active = query ? activeProjects().filter((p) => matches(text(p), query)) : activeProjects();
  const shelved = state.projects.filter((p) => p.status !== 'active').filter((p) => !query || matches(text(p), query));
  screen(
    bar(title('Projects'), null, [themeButton(), ...(isOwner() ? [round('plus', 'New project', () => go('#/new-project'))] : [])]),
    [
      state.projects.length > 3 ? filterStrip('projects', 'Filter projects', { hidden: activeProjects().length - active.length }) : null,
      active.length ? active.map(projectCard) : h('p', { class: 'empty' }, query ? 'No project matches that.' : 'No projects yet. Tap + to start one, or add a folder with poly projects add.'),
      shelved.length ? [sec('Parked'), shelved.map(projectCard)] : null,
    ],
    { tabs: true },
  );
}

function projectScreen(slug) {
  const p = projectOf(slug);
  if (!p) {
    screen(bar(backButton(), title('Project')), h('p', { class: 'empty' }, 'That project isn’t here anymore.'), { mainClass: 'plain' });
    return;
  }
  const canWork = p.status === 'active' && (isOwner() || p.role === 'member');
  // It opens on Setup until it's set up, and on Work after that.
  const tab = view.tab === 'setup' || view.tab === 'work' ? view.tab : p.needsOrientation && p.status === 'active' ? 'setup' : 'work';
  const from = view.from ? sessionById(view.from) : null;
  const tabs = h(
    'div',
    { class: 'segmented tabbed', role: 'tablist' },
    [['work', 'Work'], ['setup', 'Setup']].map(([id, label]) =>
      h('button', { type: 'button', role: 'tab', 'aria-pressed': String(id === tab), 'aria-selected': String(id === tab), onclick: () => location.replace(`#/p/${encodeURIComponent(p.slug)}?tab=${id}${from ? `&from=${from.id}` : ''}`) }, label),
    ),
  );
  screen(
    bar(backButton(), title(p.name), canWork ? [round('plus', 'Start something here', () => projectStartSheet(p))] : []),
    [
      // Came here from a thread: the way back names it.
      from ? h('button', { class: 'return-bar', onclick: () => go(`#/s/${from.id}`) }, h('span', {}, 'Back to ', h('b', {}, from.title || 'the thread')), h('span', { class: 'linky' }, 'Return')) : null,
      p.status === 'active' ? null : h('p', { class: 'empty' }, `${p.status === 'parked' ? 'Parked' : 'Archived'}: hidden from pickers. Bring it back with poly projects activate ${p.slug}.`),
      tabs,
      tab === 'work' ? projectWork(p) : projectSetup(p),
    ],
  );
}

/**
 * A project's Work. On a phone it's the list, filtered to this project. Beside an open project on a
 * wide screen that list is already the sidebar, so here it's what's happening instead: what's going,
 * what runs on a schedule, and what the threads add up to — the same facts, not the same rows.
 */
function projectWork(p) {
  const rows = state.sessions.filter((s) => s.project === p.slug);
  if (!rows.length && p.needsOrientation) {
    return [h('p', { class: 'empty' }, 'Nothing here yet — finish setting it up first.'), h('button', { class: 'btn wide', onclick: () => location.replace(`#/p/${encodeURIComponent(p.slug)}?tab=setup`) }, 'Go to Setup')];
  }
  const every = h('button', { class: 'linky', onclick: () => go(`#/threads?project=${encodeURIComponent(p.slug)}`) }, 'Every thread here');
  // The list is the sidebar's job when it's on screen; repeating it here would say the same thing
  // twice. On a phone there is no beside, so the list comes after the brief — which is the screen
  // that answers "who's working, what changed, what needs me", and used to be the wide one's only.
  const beside = wide() && sidebarList === `projectThreads:${p.slug}`;
  const waiting = state.questions.filter((q) => sessionById(q.sessionId)?.project === p.slug);
  const going = rows.filter((s) => s.running || s.work?.status === 'running');
  const onYou = rows.filter((s) => s.waiting || s.state === 'paused');
  const line = (label, value, cls = '') => h('div', { class: 'item' }, h('span', { class: 'grow' }, h('small', {}, label), h('span', { class: cls }, value)));
  return [
    handoffCard(p),
    sec('What’s happening'),
    h(
      'div',
      { class: 'card' },
      line('Waiting on you', waiting.length ? `${waiting.length} to answer` : 'Nothing', waiting.length ? 'warnish' : ''),
      line('Threads', String(rows.length)),
      line('Working now', going.length ? `${going.length} going` : 'Nothing going', going.length ? 'warnish' : ''),
      onYou.length ? line('Stopped for you', `${onYou.length} thread${onYou.length === 1 ? '' : 's'}`, 'warnish') : null,
      p.inbox ? line('To review', `${p.inbox} proposed`, 'warnish') : null,
    ),
    going.length ? [sec('Going now', going.length), h('div', { class: 'list' }, going.map((s) => sessionRow(s, false)))] : null,
    madeCard(p),
    routinesCard(p),
    beside ? h('p', { class: 'hint tight' }, 'Its threads, and anything waiting on you, are in the list beside this one.') : [sec('Threads'), threadList({ scope: p, rows, place: 'project' })],
    every,
  ];
}

/**
 * Where the project stands, in its own words: the handoff its agents rewrite at the end of a turn,
 * which every session starts from. It was written for models and never shown to anyone
 * (2026-09-20). Fetched when the tab draws, because it's a file, not part of the state everyone
 * polls.
 */
function handoffCard(p) {
  const body = h('p', { class: 'handoff-text' }, 'Reading…');
  const card = h('div', { class: 'card handoff' }, body);
  const when = h('small', { class: 'meta' }, '');
  void api(`/api/projects/${encodeURIComponent(p.slug)}/handoff`)
    .then(({ text, at }) => {
      if (!text) {
        card.remove();
        return;
      }
      // Its first heading is the project's name, which is already the title of this screen.
      const lines = text.split('\n').filter((l, i) => !(i === 0 && /^#\s/.test(l)));
      fill(body, ...lines.join('\n').trim().split(/\n{2,}/).slice(0, 4).map((para) => h('span', { class: 'para' }, para.trim())));
      if (at) {
        when.textContent = `From the last turn here, ${ago(at)} ago`;
        card.append(when);
      }
    })
    .catch(() => card.remove());
  return [sec('Where it stands'), card];
}

/** A project's Setup: what needs doing first, then what it can reach, its rules and memory, people and agents. */
function projectSetup(p) {
  const threads = state.sessions.filter((s) => s.project === p.slug);
  const agents = (state.agents ?? []).filter((a) => a.project === p.slug || threads.some((t) => t.agent === a.id || (t.members ?? []).some((m) => m.id === a.id)));
  const ownerName = (state.people ?? []).find((person) => person.owner)?.name ?? 'The owner';
  const todo = [
    p.needsOrientation && p.status === 'active'
      ? h(
          'div',
          { class: 'setup' },
          h('p', {}, h('b', {}, 'Set this project up'), h('br'), 'An agent reads what’s in the folder and drafts the rules and first notes. Nothing changes until you review them.'),
          h('button', { class: 'btn primary', onclick: () => orient(p) }, 'Set up with an agent'),
        )
      : null,
    p.inbox
      ? h('div', { class: 'setup' }, h('p', {}, h('b', {}, `${p.inbox} proposal${p.inbox === 1 ? '' : 's'} to review`), h('br'), 'Rules and notes an agent drafted. Nothing is used until you keep it.'), h('button', { class: 'btn primary', onclick: () => go(`#/review/${encodeURIComponent(p.slug)}`) }, 'Review them'))
      : null,
  ].filter(Boolean);
  return [
    sec('Name'),
    h(
      'div',
      { class: 'card' },
      isOwner()
        ? h('button', { class: 'item', onclick: () => renameProjectSheet(p) }, h('span', { class: 'grow' }, h('span', {}, p.name), h('small', {}, `Short name ${p.slug}. The address and the folder stay.`)), icon('chev', 'ico chev'))
        : h('div', { class: 'item' }, h('span', { class: 'grow' }, h('span', {}, p.name), h('small', {}, `Short name ${p.slug}`))),
    ),
    todo.length ? [sec('To do', todo.length), todo] : null,
    state.isolation ? [sec('Where agents run'), projectIsolation(p)] : null,
    sec('What it can reach'),
    reachSection(`/api/projects/${encodeURIComponent(p.slug)}/reach`, { empty: isOwner() ? 'No connection is granted here yet.' : 'No connection is granted here.' }),
    isOwner() ? h('button', { class: 'linky', onclick: () => go('#/connections') }, 'Grant a connection from Connections') : null,
    sec('Rules and memory'),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'item' }, icon('doc'), h('span', { class: 'grow' }, h('span', {}, 'Rules'), h('small', {}, p.needsOrientation ? 'AGENTS.md is still the blank template' : 'AGENTS.md · every agent here reads it first'))),
      h(
        'button',
        { class: `item ${p.inbox ? 'warn' : ''}`, onclick: () => (p.inbox ? go(`#/review/${encodeURIComponent(p.slug)}`) : toast('Nothing waiting for review.')) },
        icon('inbox'),
        h('span', { class: 'grow' }, h('span', {}, 'Review'), h('small', {}, 'What agents proposed: rules and notes')),
        h('span', { class: 'value' }, p.inbox ? `${p.inbox} waiting` : 'None'),
        icon('chev', 'ico chev'),
      ),
      // Only shown to whoever works in it: the daemon leaves the folder out for a viewer.
      ...(p.path ? [h('div', { class: 'item' }, icon('folder'), h('span', { class: 'grow' }, h('span', {}, 'Folder'), h('small', { class: 'path' }, p.path)))] : []),
    ),
    routinesCard(p),
    sec('People'),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'item' }, face(ownerName, 'sm'), h('span', { class: 'grow' }, h('span', {}, ownerName), h('small', {}, 'Owns this install, so sees every project'))),
      (p.people ?? []).map((person) => h('div', { class: 'item' }, face(person.name, 'sm'), h('span', { class: 'grow' }, h('span', {}, person.id === state.me?.id ? `${person.name} (you)` : person.name), h('small', {}, person.role === 'viewer' ? 'Viewer · reads, and can’t act' : 'Member · works, messages and approves here')))),
    ),
    ...(isOwner() ? projectPeopleActions(p) : []),
    sec('Agents', agents.length || ''),
    agents.length
      ? h('div', { class: 'list' }, agents.map((a) => h('button', { class: 'row chevroned', onclick: () => go(`#/a/${encodeURIComponent(a.id)}`) }, mark(a.mark ?? a.name), h('span', { class: 'row-main' }, h('span', { class: 'row-top' }, h('b', {}, a.title), h('span', { class: 'tag' }, a.project ? 'This project’s' : 'From your library')), h('span', { class: 'row-sub' }, h('span', { class: 'text' }, a.description || ''))), icon('chev', 'ico mini'))))
      : h('p', { class: 'empty' }, 'No agent has worked here yet.'),
  ];
}

/** The name people see. The short name, the folder, and the address stay. */
function renameProjectSheet(p) {
  const name = h('input', { value: p.name, maxlength: 80, 'aria-label': 'Name', autocomplete: 'off' });
  const save = h('button', { class: 'btn primary wide' }, 'Save');
  const submit = async () => {
    const text = name.value.trim();
    if (!text) return name.focus();
    save.disabled = true;
    try {
      const saved = await api(`/api/projects/${encodeURIComponent(p.slug)}/name`, { name: text });
      p.name = saved.name;
      document.querySelector('.sheet-wrap')?.remove();
      toast('Renamed.');
      await refresh().catch(() => {});
    } catch (err) {
      save.disabled = false;
      showError(err);
    }
  };
  save.addEventListener('click', submit);
  name.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  sheet('Rename', [h('label', { class: 'field' }, h('span', {}, 'Name'), name), h('p', { class: 'hint' }, `This is the name everywhere. The address stays ${p.slug}, and the folder stays where it is.`), save]);
  name.focus();
  name.select();
}

/** The one way to start something in a project: a message, something that came in, or a workflow. */
function projectStartSheet(p) {
  const choice = (label, about, onclick) => h('button', { class: 'row chevroned unmarked', onclick: () => (document.querySelector('.sheet-wrap')?.remove(), onclick()) }, h('span', { class: 'row-main' }, h('span', { class: 'row-top' }, h('b', {}, label)), h('span', { class: 'row-sub' }, h('span', { class: 'text' }, about))), icon('chev', 'ico mini'));
  sheet(`Start something in ${p.name}`, [
    h(
      'div',
      { class: 'list' },
      choice('Message an agent', 'A new thread here, with the agent or model you pick.', () => go(`#/new?project=${encodeURIComponent(p.slug)}`)),
      choice('Add feedback or an idea', 'It waits on you until someone makes work of it. Nothing runs yet.', () => incomingSheet(p)),
      choice('Start a workflow', 'Loop until a check passes, ship an issue, write a spec, or make work of a request.', () => startWorkflowSheet(p)),
    ),
  ]);
}

/**
 * Something came in for a project — feedback, an idea, a finding. It waits on Home until someone
 * makes work of it or dismisses it; nothing runs yet.
 */
function incomingSheet(p) {
  const kinds = [['feedback', 'Feedback'], ['idea', 'Idea'], ['finding', 'Finding']];
  let kind = 'feedback';
  const modes = h('div', { class: 'segmented' });
  const buttons = kinds.map(([id, label]) => {
    const b = h('button', { type: 'button', 'aria-pressed': String(id === kind) }, label);
    b.addEventListener('click', () => {
      kind = id;
      for (const x of buttons) x.setAttribute('aria-pressed', String(x === b));
    });
    return b;
  });
  modes.append(...buttons);
  const text = h('textarea', { id: 'incoming-text', rows: 5, placeholder: 'In the words it came in: what someone said, what you noticed, what you’d like.' });
  const add = h('button', { class: 'btn primary wide' }, 'Add it');
  add.addEventListener('click', async () => {
    if (!text.value.trim()) return text.focus();
    add.disabled = true;
    try {
      await api(`/api/projects/${encodeURIComponent(p.slug)}/incoming`, { kind, text: text.value.trim() });
      document.querySelector('.sheet-wrap')?.remove();
      await refresh();
      toast('It’s waiting on Home: make work of it when you’re ready.');
      render();
    } catch (err) {
      add.disabled = false;
      showError(err);
    }
  });
  sheet(`Add to ${p.name}`, [h('div', { class: 'field' }, h('span', {}, 'What it is'), modes), h('label', { class: 'field' }, h('span', {}, 'What came in'), text), h('p', { class: 'hint' }, 'Nothing is spent on it until someone makes work of it: then an agent shapes it into pieces, and you keep the ones you want.'), add]);
  text.focus();
}

/**
 * Starting a workflow in a project: pick one, fill in what it needs, and it becomes a work item whose
 * run the engine drives — every node's status from what happened, not from what an agent says.
 */
async function startWorkflowSheet(p, preset) {
  let workflows;
  try {
    ({ workflows } = await api('/api/workflows'));
  } catch (err) {
    return showError(err);
  }
  const pick = (w) => {
    const fields = Object.entries(w.input.properties).map(([key, shape]) => {
      const command = key === 'until' || key === 'checks';
      const placeholder = { until: 'pnpm test', checks: 'Leave empty to use the repository’s own', repo: 'owner/name', base: 'main', paths: 'docs/specs/', then: '13, 14, 15' }[key] ?? '';
      const input = h(shape.type === 'string' && /goal|about|what|idea|checks|text/i.test(key) ? 'textarea' : 'input', { id: `wf-${key}`, rows: 2, ...(shape.type === 'number' ? { type: 'number', min: 1 } : {}), placeholder, autocomplete: 'off', spellcheck: command || key === 'repo' || key === 'base' || key === 'paths' ? 'false' : 'true' });
      // Started from somewhere (Ship #12), or the commands you used last time in this project.
      const kept = command || key === 'paths' ? remembered(`polyphemus.wf.${p.slug}.${w.id}.${key}`) : null;
      const given = preset?.workflow === w.id ? preset.input?.[key] : undefined;
      if (given !== undefined || kept) input.value = String(given ?? kept);
      return { key, shape, input, node: h('label', { class: 'field' }, h('span', {}, `${key.charAt(0).toUpperCase()}${key.slice(1)}${(w.input.required ?? []).includes(key) ? '' : ' (optional)'}`), input, shape.description ? h('small', { class: 'hint' }, shape.description) : null) };
    });
    const agents = (state.agents ?? []).filter((a) => a.project === null || a.project === p.slug);
    const agent = h('select', { id: 'wf-agent' }, h('option', { value: '' }, defaultAgentOf() ? `${defaultAgentOf().title} (the default)` : 'The default model, no agent'), agents.filter((a) => a.id !== state.defaultAgent).map((a) => h('option', { value: a.id }, a.title)));
    let yolo = false;
    const modes = h('div', { class: 'segmented' });
    const ask = h('button', { type: 'button', 'aria-pressed': 'true' }, 'Asks first');
    const free = h('button', { type: 'button', class: 'yolo', 'aria-pressed': 'false' }, 'YOLO');
    ask.addEventListener('click', () => ((yolo = false), ask.setAttribute('aria-pressed', 'true'), free.setAttribute('aria-pressed', 'false')));
    free.addEventListener('click', () => ((yolo = true), ask.setAttribute('aria-pressed', 'false'), free.setAttribute('aria-pressed', 'true')));
    modes.append(ask, free);
    const installButton = h('button', { class: 'btn primary wide' }, `Start ${w.name.toLowerCase()}`);
    installButton.addEventListener('click', async () => {
      const input = {};
      for (const f of fields) {
        const raw = f.input.value.trim();
        if (!raw) {
          if ((w.input.required ?? []).includes(f.key)) return f.input.focus();
          continue;
        }
        input[f.key] = f.shape.type === 'number' ? Number(raw) : raw;
        if (f.key === 'until' || f.key === 'checks' || f.key === 'paths') remember(`polyphemus.wf.${p.slug}.${w.id}.${f.key}`, raw);
      }
      installButton.disabled = true;
      try {
        const { id } = await api(`/api/workflows/${encodeURIComponent(w.id)}/start`, { project: p.slug, input, agent: agent.value, yolo });
        document.querySelector('.sheet-wrap')?.remove();
        await refresh();
        go(`#/s/${id}`);
      } catch (err) {
        installButton.disabled = false;
        showError(err);
      }
    });
    sheet(w.name, [
      h('p', { class: 'hint', style: 'margin-top:0' }, w.about),
      fields.map((f) => f.node),
      agents.length ? h('label', { class: 'field' }, h('span', {}, 'Who does the work'), agent) : null,
      h('div', { class: 'field' }, h('span', {}, 'Before commands that change things'), modes, h('small', { class: 'hint' }, 'A workflow runs while you’re away: with Asks first it waits for you at each change — except steps on Codex, which doesn’t ask and works within its sandbox.')),
      installButton,
    ]);
  };
  const presetWorkflow = preset && workflows.find((w) => w.id === preset.workflow);
  if (presetWorkflow) return pick(presetWorkflow);
  if (workflows.length === 1) return pick(workflows[0]);
  const wrap = sheet('Start a workflow', [h('div', { class: 'list' }, workflows.map((w) => h('button', { class: 'row chevroned unmarked', onclick: () => (wrap.remove(), pick(w)) }, h('span', { class: 'row-main' }, h('span', { class: 'row-top' }, h('b', {}, w.name)), h('span', { class: 'row-sub' }, h('span', { class: 'text' }, w.about))), icon('chev', 'ico mini'))))]);
}

/** A project's routines: when each runs next, how the last run went, and Run now. */
/**
 * The routines of a place: a project's, or — given a list — the install's own, which belong to no
 * project and used to be visible only on the page of whichever agent runs them (2026-09-20).
 */
/**
 * What a routine asks before doing, and whether a clean run says so — the two things about a
 * routine a person actually changes. They were only in its file: an agent that wanted its own
 * scheduled work to run at 7am had to ask the owner to go and edit YAML (2026-09-20).
 */
function modeAndNotice(routine, summary) {
  const set = async (change, undo) => {
    try {
      await api(`/api/routines/${encodeURIComponent(routine.id)}/settings`, change);
      await refresh();
    } catch (err) {
      undo();
      showError(err);
    }
  };
  const modes = [
    ['ask', 'Asks first'],
    ['read-only', 'Only reads'],
    ...(isOwner() || routine.mode === 'yolo' ? [['yolo', 'No asking']] : []),
  ];
  const box = h('div', { class: 'segmented' });
  for (const [value, label] of modes) {
    const button = h('button', { type: 'button', class: value === 'yolo' ? 'yolo' : '', 'aria-pressed': String(value === routine.mode) }, label);
    button.addEventListener('click', () => {
      if (value === routine.mode) return;
      const was = [...box.children].find((b) => b.getAttribute('aria-pressed') === 'true');
      for (const other of box.children) other.setAttribute('aria-pressed', String(other === button));
      void set({ mode: value }, () => {
        for (const other of box.children) other.setAttribute('aria-pressed', String(other === was));
      });
    });
    box.append(button);
  }
  let tells = (routine.notify ?? []).includes('finish');
  const tell = h('button', { type: 'button', class: 'choice check', 'aria-pressed': String(tells) }, h('span', { class: 'box' }), h('span', {}, h('b', {}, 'Tell me when it finishes'), h('small', {}, 'Not only when it fails')));
  tell.addEventListener('click', () => {
    const was = tells;
    tells = !tells;
    tell.setAttribute('aria-pressed', String(tells));
    void set({ notify: tells }, () => {
      tells = was;
      tell.setAttribute('aria-pressed', String(was));
    });
  });
  return h(
    'div',
    { class: 'routine-settings' },
    h('label', { class: 'field' }, h('span', {}, 'Before it changes anything'), box),
    tell,
    // A routine runs when nobody's watching: saying so is the point of the setting above.
    routine.mode === 'ask' && !summary.paused
      ? h('p', { class: 'hint tight' }, 'Asking first means it stops and waits for you, however long that is — a run at 7am waits until you’re up.')
      : null,
  );
}

function routinesCard(where) {
  const routines = Array.isArray(where) ? where : (state.routines ?? []).filter((r) => r.project === where.slug);
  if (!routines.length) return null;
  const lastText = (last) => {
    if (!last) return 'never run';
    if (last.status !== 'started') return `${last.status}: ${last.reason ?? ''}`;
    if (!last.outcome) return 'running now';
    return last.outcome === 'succeeded' ? `✓ ${ago(last.finishedAt ?? last.createdAt)} ago` : `✗ failed: ${last.reason ?? ''}`;
  };
  const run = async (r, button) => {
    button.disabled = true;
    try {
      const { fire } = await api(`/api/routines/${encodeURIComponent(r.id)}/run`, {});
      if (fire?.status === 'started') {
        await refresh();
        go(`#/s/${fire.sessionId}`);
      } else {
        toast(fire ? `Didn’t run: ${fire.reason}` : 'Nothing ran.');
        button.disabled = false;
      }
    } catch (err) {
      button.disabled = false;
      showError(err);
    }
  };
  return [
    sec('Routines', routines.length),
    h(
      'div',
      { class: 'card' },
      routines.map((r) => {
        const button = h('button', { class: 'btn', style: 'min-height:36px;padding:6px 12px;font-size:13.5px' }, 'Run now');
        button.addEventListener('click', () => run(r, button));
        const when = r.waiting
          ? 'Waiting for your OK'
          : r.paused
          ? `Paused: ${r.pausedReason ?? ''}`
          : r.next
            ? `Next ${new Date(r.next).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`
            : 'Not scheduled';
        return h(
          'div',
          { class: `item ${r.paused || r.last?.outcome === 'failed' ? 'warn' : ''}` },
          icon('clock'),
          h('button', { type: 'button', class: 'grow linky-block', 'aria-label': `${r.name}: open`, onclick: () => routineSheet(r) }, h('span', {}, r.name), h('small', {}, `${r.schedule} · ${when}`), h('small', {}, lastText(r.last))),
          h('div', { class: 'row-actions' }, button),
        );
      }),
    ),
  ];
}

/**
 * One routine: what it does and when, and everything a person can do with it — run it now, pause or
 * resume it, change its file, or remove it. Edits are checked like the file is when polyphemus reads it.
 */
async function routineSheet(summary) {
  let routine;
  try {
    ({ routine } = await api(`/api/routines/${encodeURIComponent(summary.id)}`));
  } catch (err) {
    return showError(err);
  }
  const path = `/api/routines/${encodeURIComponent(routine.id)}`;
  const agent = summary.agent ? agentByRef(summary.agent) : null;
  const done = async (message) => {
    wrap.remove();
    await refresh();
    render();
    if (message) toast(message);
  };
  const act = async (button, work) => {
    button.disabled = true;
    try {
      await work();
    } catch (err) {
      button.disabled = false;
      showError(err);
    }
  };
  const when = summary.waiting ? 'Waiting for your OK' : summary.paused ? `Paused: ${summary.pausedReason ?? ''}` : summary.next ? `Next ${new Date(summary.next).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : 'Not scheduled';
  const modeWords = {
    ask: routine.asks === false ? 'It runs on Codex, which doesn’t ask before changes: it works within its sandbox, or the worker where agents are isolated.' : 'Anything it changes or posts asks first.',
    'read-only': 'It can only read.',
    yolo: 'It runs without asking.',
  }[routine.mode];
  const runNow = h('button', { class: 'btn' }, 'Run now');
  runNow.addEventListener('click', () => act(runNow, async () => {
    const { fire } = await api(`${path}/run`, {});
    if (fire?.status === 'started') {
      await done();
      go(`#/s/${fire.sessionId}`);
    } else {
      toast(fire ? `Didn’t run: ${fire.reason}` : 'Nothing ran.');
      runNow.disabled = false;
    }
  }));
  const pause = h('button', { class: 'btn' }, summary.paused ? 'Resume' : 'Pause');
  pause.addEventListener('click', () => act(pause, async () => {
    await api(`${path}/pause`, { paused: !summary.paused });
    await done(summary.paused ? `${routine.name} runs on its schedule again.` : `${routine.name} is paused: it won’t run until you resume it.`);
  }));
  const remove = h('button', { class: 'btn danger' }, 'Remove');
  remove.addEventListener('click', async () => {
    if (!(await confirmSheet(`Remove ${routine.name}?`, ['Its file is deleted and it won’t run again. Threads it already ran stay.'], { yes: 'Remove it', danger: true }))) return;
    await act(remove, async () => {
      await api(`${path}/remove`, {});
      await done(`${routine.name} is removed.`);
    });
  });
  const accept = h('button', { class: 'btn primary' }, 'Accept it');
  accept.addEventListener('click', () => act(accept, async () => {
    try {
      await api(`${path}/accept`, { digest: routine.digest });
    } catch (err) {
      // Changed while it was open: show the new version rather than accept one nobody read.
      if (err.status === 409) {
        wrap.remove();
        toast(err.message);
        return routineSheet(summary);
      }
      throw err;
    }
    await done(`${routine.name} is accepted: it runs on its schedule.`);
  }));
  const edit = h('button', { class: 'btn' }, 'Edit');
  const body = h('div', { class: 'routine-sheet' });
  const show = () => {
    fill(body, 
      h('p', { class: 'hint tight' }, [summary.schedule, when, agent ? `As ${agent.title}` : null].filter(Boolean).join(' · ')),
      h('p', { class: 'hint tight' }, modeWords ?? ''),
      // Waiting for a yes: the whole file, settings and all, exactly as it will run — that's what Accept accepts.
      routine.waiting
        ? h('pre', { class: 'mono routine-text routine-file' }, routine.text)
        : h('details', { class: 'routine-prompt', open: true }, h('summary', {}, 'What it does each time'), h('div', { class: 'prose md' }, markdown(routine.prompt))),
      routine.canChange ? modeAndNotice(routine, summary) : null,
      h('p', { class: 'hint tight path' }, routine.file),
      routine.waiting
        ? h('div', { class: 'note warn' }, routine.mode === 'yolo' && !isOwner()
          ? 'This is new or changed since anyone accepted it, and it would run without asking: only the owner can accept it.'
          : 'This is new or changed since anyone accepted it. Read what it does and when; it runs only once you accept it.')
        : null,
      routine.canChange ? h('div', { class: 'buttons' }, routine.waiting && (routine.mode !== 'yolo' || isOwner()) ? accept : runNow, pause, edit, remove) : h('p', { class: 'hint tight' }, 'You can read this routine; people who work in the project change it.'),
    );
  };
  edit.addEventListener('click', () => {
    const text = h('textarea', { class: 'mono routine-text', rows: 18, spellcheck: 'false', 'aria-label': `${routine.name} file` });
    text.value = routine.text;
    const save = h('button', { class: 'btn primary' }, 'Save');
    save.addEventListener('click', () => act(save, async () => {
      await api(path, { text: text.value });
      await done(`${routine.name} is saved; its next run uses it.`);
    }));
    const cancel = h('button', { class: 'btn', onclick: show }, 'Cancel');
    fill(body, 
      h('p', { class: 'hint tight' }, 'The settings between the --- lines (schedule, agent, mode), then what it does each time. It’s checked before it’s saved.'),
      text,
      h('div', { class: 'buttons' }, save, cancel),
    );
    text.focus();
  });
  show();
  const wrap = sheet(routine.name, [body]);
}

/** Giving someone a role here, changing it, or taking it away — the owner's, from the app. */
function projectPeopleActions(p) {
  const here = new Set((p.people ?? []).map((one) => one.id));
  const others = (state.people ?? []).filter((one) => !one.owner && !here.has(one.id));
  const set = async (person, role) => {
    try {
      await api(`/api/projects/${encodeURIComponent(p.slug)}/people`, { person: person.id, role });
      await refresh();
      render();
      toast(role ? `${person.name} is a ${role} of ${p.name}.` : `${person.name} no longer belongs to ${p.name}.`);
    } catch (err) {
      showError(err);
    }
  };
  const change = (person) => {
    const role = (p.people ?? []).find((one) => one.id === person.id)?.role;
    const wrap = sheet(person.name, [
      h('div', { class: 'choices' }, [['member', 'Member', 'Works, messages and approves here'], ['viewer', 'Viewer', 'Reads; can’t send, start or approve'], [null, 'Not in this project', 'They stop seeing it']].map(([value, label, hint]) =>
        h('button', { type: 'button', class: 'choice', 'aria-pressed': String(value === (role ?? null)), onclick: () => (wrap.remove(), set(person, value)) }, h('span', { class: 'radio' }), h('span', {}, h('b', {}, label), h('small', {}, hint))),
      )),
    ]);
  };
  const add = h('button', { class: 'btn small' }, others.length ? 'Add someone' : 'Invite someone');
  add.addEventListener('click', () => {
    if (!others.length) return go('#/team');
    const wrap = sheet(`Who joins ${p.name}?`, [
      h('div', { class: 'list' }, others.map((person) =>
        h('button', { class: 'row', onclick: () => (wrap.remove(), set(person, 'member')) }, face(person.name), h('span', { class: 'row-main' }, h('span', { class: 'row-top' }, h('b', {}, person.name)), h('span', { class: 'row-sub' }, h('span', { class: 'text' }, 'Joins as a member; change it after')))),
      )),
    ]);
  });
  return [
    (p.people ?? []).length ? h('div', { class: 'buttons' }, (p.people ?? []).map((person) => h('button', { class: 'btn small', onclick: () => change(person) }, `Change ${person.name}`))) : null,
    h('div', { class: 'buttons' }, add),
  ];
}

async function orient(project) {
  if (!(await confirmSheet(`Set up ${project.name}?`, 'An agent reads what’s in the folder and drafts its rules and first notes. Nothing changes until you review them.', { yes: 'Start' }))) return;
  try {
    const { id } = await api(`/api/projects/${project.slug}/orient`, { model: state.defaultModel });
    await refresh();
    go(`#/s/${id}`);
  } catch (err) {
    showError(err);
  }
}

async function reviewScreen(slug) {
  const p = projectOf(slug);
  let items = [];
  try {
    ({ items } = await api(`/api/projects/${encodeURIComponent(slug)}/inbox`));
  } catch (err) {
    showError(err);
  }
  const list = h('div', {});
  const resolve = async (item, action, card) => {
    try {
      await api(`/api/projects/${encodeURIComponent(slug)}/inbox/${encodeURIComponent(item.name)}`, { action });
      card.remove();
      toast(action === 'accept' ? (item.kind === 'rules' ? 'Rules updated.' : 'Note kept.') : 'Discarded.');
      if (!list.children.length) list.append(h('p', { class: 'empty' }, 'All reviewed.'));
      refresh();
    } catch (err) {
      showError(err);
    }
  };
  for (const item of items) {
    const card = h(
      'div',
      { class: 'ask' },
      h('p', {}, item.kind === 'rules' ? 'AGENTS.md: replaces the project’s rules' : `Note: ${item.name}`),
      h('pre', { class: 'proposal' }, item.content),
    );
    card.append(
      h(
        'div',
        { class: 'buttons' },
        h('button', { class: 'btn primary', onclick: () => resolve(item, 'accept', card) }, item.kind === 'rules' ? 'Use it' : 'Keep'),
        h('button', { class: 'btn danger', onclick: () => resolve(item, 'discard', card) }, 'Discard'),
      ),
    );
    list.append(card);
  }
  if (!items.length) list.append(h('p', { class: 'empty' }, 'Nothing waiting.'));
  screen(bar(backButton(), title(`Review · ${p?.name ?? slug}`)), [h('p', { class: 'hint', style: 'margin-bottom:12px' }, 'Proposed by agents. Nothing here is used until you keep it.'), list], { mainClass: 'plain' });
}

// ── Team: what your sessions run on (named bots come later) ──────────────


/**
 * The people who use this install, and how to invite one: a name, then a code they type into polyphemus on
 * their own phone. They see nothing until they're given a role in a project (or brought into a thread).
 */
function peopleSection() {
  const people = state.people ?? [];
  const invite = h('button', { class: 'btn small primary' }, 'Invite someone');
  invite.addEventListener('click', async () => {
    const name = h('input', { type: 'text', placeholder: 'Their name', autocapitalize: 'words' });
    const add = h('button', { class: 'btn primary wide' }, 'Make their code');
    const wrap = sheet('Invite someone', [
      h('label', { class: 'field' }, h('span', {}, 'Name'), name),
      h('p', { class: 'hint tight' }, 'They get a code to type into polyphemus on their own phone. They can message you straight away; they see no project until you give them a role in one.'),
      add,
    ]);
    name.focus();
    add.addEventListener('click', async () => {
      if (!name.value.trim()) return name.focus();
      add.disabled = true;
      try {
        const { person, code, url } = await api('/api/people', { name: name.value });
        wrap.remove();
        await refresh();
        render();
        showCode(person, code, url);
      } catch (err) {
        add.disabled = false;
        showError(err);
      }
    });
  });
  // A person is a row like an agent: it opens their profile, where the rest is.
  const row = (person) =>
    h(
      'div',
      { class: 'row with-actions person-row' },
      h('button', { type: 'button', class: 'person-open', onclick: () => go(`#/u/${encodeURIComponent(person.id)}`) }, face(person.name, 'md'), h('span', { class: 'row-main' }, h('span', { class: 'row-top' }, h('b', {}, person.id === state.me?.id ? `${person.name} (you)` : person.name), person.owner ? h('span', { class: 'tag accent' }, 'Owner') : null), h('span', { class: 'row-sub' }, h('span', { class: 'text' }, personWhere(person))))),
      person.id === state.me?.id ? icon('chev', 'ico mini') : round('direct', `Message ${person.name}`, () => messagePerson(person)),
    );
  return [sec('People', people.length), h('div', { class: 'card' }, people.map(row)), isOwner() ? h('div', { class: 'buttons' }, invite) : null];
}

/** Where someone is, in a line: every project for the owner, else each of theirs with their role. */
function personWhere(person) {
  const where = (state.projects ?? []).filter((p) => (p.people ?? []).some((one) => one.id === person.id));
  if (person.owner) return 'Owns this install, and sees every project';
  return where.length ? where.map((p) => `${p.name} · ${(p.people ?? []).find((one) => one.id === person.id)?.role}`).join(', ') : 'No project yet: they can message people here, and see nothing else';
}

/** A person's profile: who they are here, what they can see, and your conversations with them. */
function personScreen(id) {
  const person = (state.people ?? []).find((p) => p.id === id);
  if (!person) return location.replace('#/team');
  const me = person.id === state.me?.id;
  const projects = (state.projects ?? []).filter((p) => (p.people ?? []).some((one) => one.id === person.id));
  const together = (state.sessions ?? []).filter((s) => !s.project && (s.people ?? []).includes(person.id) && (me || (s.people ?? []).includes(state.me?.id))).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  screen(
    bar(backButton(), h('div', { class: 'pill' }, face(person.name, 'sm'), h('span', {}, me ? `${person.name} (you)` : person.name))),
    [
      h('div', { class: 'person-hero' }, h('span', { class: 'face lg' }, person.name.trim().charAt(0).toUpperCase()), h('b', {}, person.name), h('span', { class: 'meta' }, person.owner ? 'Owner of this install' : projects.length ? 'Works in projects here' : 'Can message people here')),
      me ? null : h('div', { class: 'talk' }, h('button', { class: 'btn primary wide', onclick: () => messagePerson(person) }, `Message ${person.name}`)),
      sec('What they can see'),
      person.owner
        ? h('p', { class: 'hint tight' }, 'Everything: every project, every agent, and this install’s setup.')
        : projects.length
          ? h('div', { class: 'card' }, projects.map((p) => h('button', { type: 'button', class: 'item', onclick: () => go(`#/p/${encodeURIComponent(p.slug)}`) }, squircle(p, 30), h('span', { class: 'grow' }, h('span', {}, p.name), h('small', {}, (p.people ?? []).find((one) => one.id === person.id)?.role === 'viewer' ? 'Viewer: reads, and can’t act' : 'Member: works with its agents')), icon('chev', 'ico mini'))))
          : h('p', { class: 'hint tight' }, 'No project yet. They can message people here and talk with agents someone brings into a conversation, and see nothing else. Give them a role from a project’s People to let them work there.'),
      me ? null : [sec(`Conversations with ${person.name}`, together.length || ''), together.length ? h('div', { class: 'list' }, together.slice(0, 6).map((t) => sessionRow(t))) : h('p', { class: 'empty' }, 'None yet.')],
      isOwner() && !person.owner && !me
        ? [
            sec('Their access'),
            h('div', { class: 'buttons' }, h('button', { class: 'btn', onclick: () => pairAgain(person) }, 'Pair a device'), h('button', { class: 'btn danger', onclick: () => removePerson(person) }, `Remove ${person.name}`)),
            h('p', { class: 'hint tight' }, 'Pairing gives them a code for another phone or browser. Removing signs out every device of theirs; what they wrote stays.'),
          ]
        : null,
    ],
    { mainClass: 'plain' },
  );
}

/** Your conversation with just this person, outside any project — carried on if there is one, else started. */
function messagePerson(person) {
  const same = (s) => !s.project && !(s.members ?? []).length && new Set((s.people ?? []).filter((id) => id !== state.me?.id)).size === 1 && (s.people ?? []).includes(person.id);
  const existing = (state.sessions ?? []).filter(same).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
  go(existing ? `#/s/${existing.id}` : `#/new?with=${encodeURIComponent(`person:${person.id}`)}`);
}

/** The code, big enough to read out, with where to type it. */
function showCode(person, code, url) {
  sheet(`${person.name}’s code`, [
    h('p', { class: 'code-big' }, code),
    h('p', { class: 'hint tight' }, url ? ['They open ', h('b', {}, url), ' on their phone and type this in. It works once, in the next ten minutes.'] : 'They open polyphemus on your tailnet and type this in. It works once, in the next ten minutes.'),
    h('button', { class: 'btn wide', onclick: async () => {
      try {
        await navigator.clipboard.writeText(url ? `${url} — code ${code}` : code);
        toast('Copied.');
      } catch {
        toast('Couldn’t copy: read it out instead.', 'error');
      }
    } }, 'Copy'),
  ]);
}

async function pairAgain(person) {
  try {
    const { code, url } = await api(`/api/people/${encodeURIComponent(person.id)}/pair`, {});
    showCode(person, code, url);
  } catch (err) {
    showError(err);
  }
}

async function removePerson(person) {
  if (!(await confirmSheet(`Remove ${person.name}?`, ['Their devices are cut off and their roles are gone. What they did stays attributed to them.'], { yes: 'Remove', danger: true }))) return;
  try {
    await api(`/api/people/${encodeURIComponent(person.id)}/remove`, {});
    await refresh();
    render();
    toast(`${person.name} is removed.`);
  } catch (err) {
    showError(err);
  }
}

/** The agents shown under Team, once what's typed in the filter is applied. */
function teamRows() {
  const query = filterFor('team');
  const agents = state.agents ?? [];
  if (!query) return agents;
  return agents.filter((a) => matches([a.title, a.name, a.description, projectOf(a.project ?? '')?.name].filter(Boolean).join(' '), query));
}

function teamScreen() {
  screen(
    bar(title('Team'), [], [themeButton(), ...(isOwner() ? [round('plus', 'New agent', () => go('#/new-agent'), 'primary')] : [])]),
    [
      h('p', { class: 'hint', style: 'margin-top:0' }, 'Agents are experts you work with, each with its own instructions, skills, and model.'),
      (state.agents?.length ?? 0) > 3 ? filterStrip('team', 'Filter agents', { hidden: (state.agents?.length ?? 0) - teamRows().length }) : null,
      ...((state.people ?? []).some((p) => p.id !== state.me?.id) || isOwner() ? peopleSection() : []),
      h('div', { class: 'list' }, h('button', { class: 'row chevroned', onclick: () => go('#/skills') }, h('span', { class: 'skill-tile' }, icon('spark')), h('span', { class: 'row-main' }, h('span', { class: 'row-top' }, h('b', {}, 'Skills')), h('span', { class: 'row-sub' }, h('span', { class: 'text' }, 'What your agents know how to do, and a library of hundreds more'))), icon('chev', 'ico mini'))),
      ...(teamRows().length
        ? [
            sec('Agents', teamRows().length),
            h(
              'div',
              { class: 'list' },
              teamRows().map((a) =>
                h(
                  'button',
                  { class: 'row chevroned', onclick: () => go(`#/a/${encodeURIComponent(a.id)}`) },
                  mark(a.mark ?? a.name),
                  h(
                    'span',
                    { class: 'row-main' },
                    h('span', { class: 'row-top' }, h('b', {}, a.title), a.scope === 'project' ? h('span', { class: 'tag' }, 'project') : a.id === state.defaultAgent ? h('span', { class: 'tag accent' }, 'Default') : null),
                    h('span', { class: 'row-sub' }, h('span', { class: 'text' }, a.model === 'default' ? `${a.description} · follows the default` : a.model ? `${a.description} · ${a.model}` : a.description)),
                  ),
                  icon('chev', 'ico mini'),
                ),
              ),
            ),
          ]
        : [h('p', { class: 'hint' }, isOwner() ? 'No agents yet. Tap + to make one from a template.' : 'No agents here yet. The owner of this install makes them.')]),
    ],
    { tabs: true },
  );
}

// ── Agents: make one from a template, and edit what it is ────────────────

/** Make an agent here rather than at a keyboard: pick what it starts from, and name it. */
function newAgentScreen() {
  // Identity first, then what it runs on. A template is a starting point for who it is; the model
  // is chosen the way you'd say it out loud — a provider, then one of that provider's models.
  const name = h('input', { id: 'agent-name', placeholder: 'rowan', autocapitalize: 'none', spellcheck: 'false' });
  const slugOf = () => name.value.trim().toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const slugNote = h('small', { class: 'hint', style: 'padding-left:4px;display:block' }, '');
  const description = h('input', { id: 'agent-description', placeholder: 'chasing the pipeline and keeping the CRM honest' });

  let picked = null; // null until you tap one: the name's own mark until then.
  const picker = markPicker(defaultMark('agent'), (value) => (picked = value));
  name.addEventListener('input', () => {
    const slug = slugOf();
    slugNote.textContent = slug && slug !== name.value.trim() ? `Saved as ${slug}` : '';
    if (!picked) picker.set(defaultMark(slug || 'agent'));
  });

  const shipped = state.agentTemplates ?? [];
  let from = '';
  const describeField = h(
    'label',
    { class: 'field' },
    h('span', {}, 'What it’s for'),
    description,
    h('small', { class: 'hint' }, 'One line, in your words. Its persona gets written from this — you can edit it after.'),
  );
  const templateRows = shipped.map((template) =>
    h(
      'button',
      {
        type: 'button',
        class: 'row pick',
        'data-template': template.name,
        'aria-pressed': 'false',
        onclick: () => {
          from = from === template.name ? '' : template.name;
          for (const row of templateRows) row.setAttribute('aria-pressed', String(row.dataset.template === from));
          describeField.hidden = from !== '';
        },
      },
      mark(template.name),
      h(
        'span',
        { class: 'row-main' },
        h('span', { class: 'row-top' }, h('b', {}, template.title ?? template.name)),
        h('span', { class: 'row-sub' }, h('span', { class: 'text' }, template.description)),
      ),
    ),
  );

  const model = modelPicker('agent-model', '', state.defaultModel ? `${state.defaultModel} — the default` : 'Whatever a thread would use');
  const fallback = modelPicker('agent-fallback', '', 'None — stop and ask me');
  const project = h(
    'select',
    { id: 'agent-project' },
    h('option', { value: '' }, 'Everywhere (your library)'),
    activeProjects().map((p) => h('option', { value: p.slug }, `Only in ${p.name}`)),
  );

  const create = async (event) => {
    const button = event.currentTarget;
    const named = slugOf();
    if (!named) return name.focus();
    button.disabled = true;
    button.textContent = 'Creating…';
    try {
      await api('/api/agents', {
        name: named,
        from: from || undefined,
        description: from ? undefined : description.value.trim(),
        model: model.value || undefined,
        fallback: fallback.value ? [fallback.value] : undefined,
        project: project.value || undefined,
        mark: picked ?? undefined,
      });
      // And straight into a thread with them, because that's what making one is for.
      const { id } = await api('/api/sessions', { agent: named, project: project.value || undefined, introduce: true, title: titleFromName(named) });
      await refresh();
      location.replace(`#/s/${id}`);
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Create';
      showError(err);
    }
  };

  screen(
    bar(backButton(), title('New agent')),
    [
      picker.node,
      h('label', { class: 'field' }, h('span', {}, 'Called'), name, slugNote),
      describeField,
      sec('What it runs on'),
      h('label', { class: 'field' }, h('span', {}, 'Model'), model),
      h('label', { class: 'field' }, h('span', {}, 'If that one can’t take a turn'), fallback),
      h('label', { class: 'field' }, h('span', {}, 'Available'), project),
      h('button', { class: 'btn primary wide', onclick: create }, 'Create'),
      ...(templateRows.length
        ? [h('details', { class: 'more' }, h('summary', {}, 'Start from one of ours instead'), h('div', { class: 'list' }, templateRows))]
        : []),
      h('p', { class: 'hint' }, 'Lowercase letters, numbers and dashes. You can change everything about it afterwards.'),
    ],
    { mainClass: 'plain' },
  );
  name.focus();
}

/**
 * Talking with an agent is one conversation, not a new form each time (docs/design/agents.md):
 * this opens the last thread with it, and only starts a new one when there isn't one.
 */
function talkButton(agent) {
  const latest = state.sessions.filter((s) => s.agent === agent.id || s.agent === agent.name).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
  return h(
    'div',
    { class: 'talk' },
    h('button', { class: 'btn primary wide', onclick: () => go(latest ? `#/s/${latest.id}` : `#/new?agent=${encodeURIComponent(agent.id)}`) }, `Message ${agent.title}`),
    latest ? h('button', { class: 'linky', onclick: () => go(`#/new?agent=${encodeURIComponent(agent.id)}`) }, 'Start a separate thread') : null,
    h('button', { class: 'linky', onclick: () => go(`#/threads?agent=${encodeURIComponent(agent.id)}`) }, `Every thread with ${agent.title}`),
  );
}

/**
 * An agent, read like a colleague's profile (settled brief phase 6): who it is, what it does, what it
 * runs on, what it can reach and why, and where it's working. Editing is one tap away, not the page.
 */
async function agentReadingScreen(name) {
  let agent;
  try {
    ({ agent } = await api(`/api/agents/${encodeURIComponent(name)}`));
  } catch (err) {
    showError(err);
    return go('#/team');
  }
  const project = agent.project ? projectOf(agent.project) : null;
  const threads = state.sessions.filter((s) => s.agent === agent.id || (s.members ?? []).some((m) => m.id === agent.id));
  const routines = (state.routines ?? []).filter((r) => r.agent === agent.id);
  const runsOn = agent.model === 'default' ? `Follows the default${state.defaultModel ? ` — now ${state.defaultModel}` : ''}` : agent.model ?? `Whatever the thread uses${state.defaultModel ? ` — now ${state.defaultModel}` : ''}`;
  const fact = (label, value) => h('div', { class: 'item' }, h('span', { class: 'grow' }, h('small', {}, label), h('span', {}, value)));
  const prose = (text, empty) => (text?.trim() ? h('div', { class: 'prose md' }, markdown(text)) : h('p', { class: 'empty' }, empty));
  const remove = async () => {
    let dependents;
    try {
      dependents = await api(`/api/agents/${encodeURIComponent(agent.id)}/dependents`);
    } catch (err) {
      return showError(err);
    }
    // A destructive action names what depends on it before it runs (settled brief §8).
    const lines = [
      dependents.threads.length
        ? `${dependents.threads.length === 1 ? 'Its thread stays' : `Its ${dependents.threads.length} threads stay`}, without ${agent.title}: ${dependents.threads.slice(0, 4).map((t) => `“${t.title || 'untitled'}”`).join(', ')}${dependents.threads.length > 4 ? ` and ${dependents.threads.length - 4} more` : ''}.`
        : 'It isn’t in any thread.',
      dependents.routines.length
        ? `${dependents.routines.map((r) => r.name).join(', ')} ${dependents.routines.length === 1 ? 'stops' : 'stop'} until you point ${dependents.routines.length === 1 ? 'it' : 'them'} at another agent.`
        : 'No routine uses it.',
      `Its folder moves to polyphemus’s trash, so it can be put back by hand.`,
    ];
    if (!(await confirmSheet(`Delete ${agent.title}?`, lines, { yes: 'Delete', danger: true }))) return;
    try {
      await api(`/api/agents/${encodeURIComponent(agent.id)}/delete`, {});
      await refresh();
      toast(`${agent.title} deleted.`);
      location.replace('#/team');
    } catch (err) {
      showError(err);
    }
  };
  screen(
    bar(backButton(), h('div', { class: 'pill' }, mark(agent.mark ?? agent.name, 34), h('span', {}, agent.title)), isOwner() ? [h('button', { class: 'btn small', onclick: () => go(`#/a/${encodeURIComponent(agent.id)}?edit=1`) }, 'Edit')] : []),
    [
      agent.description ? h('p', { class: 'lead-line' }, agent.description) : null,
      talkButton(agent),
      h('div', { class: 'card' }, fact('Works', project ? `In ${project.name}` : 'Everywhere'), fact('Runs on', runsOn), fact('If that can’t take a turn', (agent.fallback ?? []).length ? agent.fallback.join(', then ') : 'It pauses and asks you'), fact('Skills', agent.skills?.length ? agent.skills.join(', ') : 'Every skill in scope')),
      isOwner() ? [sec('Its computer'), computerBlock(agent)] : null,
      sec('Its skills'),
      agentSkillsBlock(agent),
      sec('Who it is'),
      prose(agent.persona, 'Nothing written yet.'),
      sec('What it does here'),
      prose(agent.instructions, 'Nothing written yet.'),
      sec('What it can reach, and why'),
      reachSection(`/api/agents/${encodeURIComponent(agent.id)}/reach`, { perProject: true, empty: 'Nothing outside polyphemus: no connection is granted to a project it works in, and it carries none of its own.' }),
      isOwner() ? h('button', { class: 'linky', onclick: () => carrySheet(agent) }, `Give ${agent.title} a connection of its own`) : null,
      sec('Threads with it', threads.length || ''),
      threads.length ? h('div', { class: 'list' }, threads.slice(0, 5).map((t) => sessionRow(t, true))) : h('p', { class: 'empty' }, 'None yet.'),
      routines.length ? [sec('Routines', routines.length), h('div', { class: 'card' }, routines.map((r) => h('button', { type: 'button', class: `item ${r.paused ? 'warn' : ''}`, onclick: () => routineSheet(r) }, icon('clock'), h('span', { class: 'grow' }, h('span', {}, r.name), h('small', {}, r.paused ? `Paused: ${r.pausedReason ?? ''}` : r.schedule)), icon('chev', 'ico mini'))))] : null,
      h('p', { class: 'hint' }, `On your computer: ${agent.file}`),
      isOwner() ? h('button', { class: 'btn wide danger', onclick: remove }, `Delete ${agent.title}`) : null,
    ],
    { mainClass: 'plain' },
  );
}

// ── An agent's computer ──────────────────────────────────────────────────
// Its own Linux desktop in a container (docs/design/desktop.md), streamed here with noVNC. Watching
// is the default; taking over gives you the mouse and keyboard.

let openRfb = null;
function leaveComputer() {
  if (!openRfb) return;
  try {
    openRfb.disconnect();
  } catch {
    // already gone
  }
  openRfb = null;
}

const COMPUTER_WORDS = { asleep: 'Asleep', waking: 'Waking up…', awake: 'Awake' };

/** On an agent's profile: whether its computer is awake, and the way in. */
function computerBlock(agent) {
  const block = h('div', {}, h('p', { class: 'hint tight' }, 'Asking…'));
  api(`/api/agents/${encodeURIComponent(agent.id)}/computer`)
    .then((c) => {
      if (!c.runtime) return fill(block, h('p', { class: 'hint tight' }, 'This computer has no Docker or Podman, so agents can’t have computers of their own here.'));
      const allow = toggle(`${agent.title} can use it`, 'Looking at the screen, clicking, typing and running commands on its own computer. In Ask mode, anything that acts asks first.', c.allowed === true, async (on) => {
        try {
          await api(`/api/agents/${encodeURIComponent(agent.id)}/computer`, { action: 'allow', on });
          toast(on ? `${agent.title} can use its computer.` : `${agent.title} can’t use its computer now.`);
        } catch (err) {
          showError(err);
        }
      });
      fill(
        block,
        h('p', { class: 'hint tight' }, `A Linux desktop of ${agent.title}’s own, with a browser, a terminal and files — kept between visits. ${COMPUTER_WORDS[c.state]}${c.imageReady ? '' : ' · the first time takes a few minutes to set up'}.`),
        h('div', { class: 'card' }, allow),
        h('button', { class: 'btn wide', style: 'margin-top:8px', onclick: () => go(`#/a/${encodeURIComponent(agent.id)}/computer`) }, icon('screen'), ` Open ${agent.title}’s computer`),
      );
    })
    .catch(() => fill(block));
  return block;
}

/**
 * An agent's computer as a thing you can put anywhere — full-screen, or in the panel beside a chat:
 * its screen, a line saying what's happening, and the controls (watch or take over, sleep). Only one
 * is connected at a time; opening another closes the last.
 */
function computerSurface(agent, stillHere) {
  const base = `/api/agents/${encodeURIComponent(agent.id)}/computer`;
  const stage = h('div', { class: 'computer-stage' });
  const status = h('p', { class: 'computer-status' }, 'Asking…');
  // Opening the computer isn't letting the agent use it: said here, where you're looking, with the way to.
  const permit = h('div', { class: 'computer-permit', hidden: true });
  const drawPermit = (c) => {
    permit.hidden = c.allowed || !c.canUse;
    if (permit.hidden) return;
    fill(
      permit,
      h('span', {}, `${agent.title} can’t use this computer yet — you can, but it can’t look or click.`),
      h('button', { class: 'btn small primary', onclick: async (e) => {
        e.currentTarget.disabled = true;
        try {
          await api(base, { action: 'allow', on: true });
          toast(`${agent.title} can use its computer. Ask it to open something.`);
          permit.hidden = true;
        } catch (err) {
          e.currentTarget.disabled = false;
          showError(err);
        }
      } }, `Let ${agent.title} use it`),
    );
  };
  let taking = false;
  const mode = h('div', { class: 'segmented small', role: 'tablist', 'aria-label': 'Watch or take over' });
  const setTaking = (on) => {
    taking = on;
    // The agent's hands wait while you have it; giving it back lets them carry on.
    api(base, { action: taking ? 'take' : 'give' }).catch(() => {});
    if (openRfb) openRfb.viewOnly = !taking;
    status.textContent = taking ? 'You have the mouse and keyboard.' : 'Watching. Take over to use it yourself.';
    if (!taking) trackpadOff();
    drawMode();
  };
  const drawMode = () =>
    fill(
      mode,
      [['watch', 'Watch'], ['take', 'Take over']].map(([id, label]) =>
        h('button', { type: 'button', role: 'tab', 'aria-pressed': String((id === 'take') === taking), onclick: () => {
          setTaking(id === 'take');
          if (taking) openRfb?.focus();
        } }, label),
      ),
    );
  drawMode();
  // Keyboard, keys, clipboard and trackpad all mean taking over: using it is taking it.
  const takeIfWatching = () => {
    if (!taking) setTaking(true);
  };
  const phone = computerPhoneControls({ stage, rfb: () => openRfb, takeIfWatching, agentTitle: agent.title, agentId: agent.id, base });
  const trackpadOff = () => phone.trackpadOff();
  const sleepButton = h('button', { class: 'btn small', onclick: async () => {
    if (!(await confirmSheet(`Put ${agent.title}’s computer to sleep?`, ['What’s open closes. Its files and sign-ins stay, and it wakes where they left off.'], { yes: 'Sleep' }))) return;
    leaveComputer();
    await api(base, { action: 'sleep' }).catch(showError);
    load();
  } }, 'Sleep');
  const connect = async () => {
    fill(stage);
    status.textContent = 'Connecting…';
    let RFB;
    try {
      ({ default: RFB } = await import('/vendor/novnc/core/rfb.js'));
    } catch (err) {
      status.textContent = `The viewer couldn’t load: ${err.message}`;
      return;
    }
    if (!stillHere()) return;
    leaveComputer();
    const rfb = new RFB(stage, `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${base}/screen`, { wsProtocols: ['binary'] });
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.viewOnly = !taking;
    rfb.background = 'transparent';
    rfb.addEventListener('connect', () => {
      status.textContent = taking ? 'You have the mouse and keyboard.' : 'Watching. Take over to use it yourself.';
      phone.bar.hidden = false;
    });
    rfb.addEventListener('clipboard', (e) => phone.remoteCopied(e.detail?.text ?? ''));
    rfb.addEventListener('disconnect', () => {
      if (openRfb === rfb) openRfb = null;
      if (stillHere()) status.textContent = 'Disconnected.';
    });
    openRfb = rfb;
  };
  const load = async () => {
    let c;
    try {
      c = await api(base);
    } catch (err) {
      status.textContent = err.message;
      return;
    }
    if (!stillHere()) return;
    drawPermit(c);
    // Watching, taking over and sleeping only mean something while it's awake.
    mode.hidden = sleepButton.hidden = c.state !== 'awake';
    phone.bar.hidden = true;
    if (c.state === 'awake') return connect();
    fill(stage, h('div', { class: 'computer-asleep' },
      mark(agent.mark ?? agent.name, 56),
      h('b', {}, c.state === 'waking' ? `Waking ${agent.title}’s computer…` : `${agent.title}’s computer is asleep`),
      h('p', { class: 'hint' }, c.state === 'waking' ? (c.imageReady ? 'A few seconds.' : 'Setting it up for the first time: a few minutes while the desktop downloads. You can leave; it carries on.') : 'Waking it starts its desktop where it left off.'),
      c.state === 'asleep' && c.canUse ? h('button', { class: 'btn primary', onclick: async () => {
        await api(base, { action: 'wake' }).catch(showError);
        load();
      } }, 'Wake it') : null,
    ));
    status.textContent = COMPUTER_WORDS[c.state];
    if (c.state === 'waking') setTimeout(() => stillHere() && load(), 3000);
  };
  return { stage, status, permit, mode, sleepButton, controls: phone.bar, placeTool: phone.place, load };
}

/**
 * Using an agent's computer from a phone (desktop.md, D3). Touch already works the direct way —
 * tap to click, two fingers to scroll, press and hold to right-click. On top of that: the phone's own
 * keyboard, a row of keys phones don't have, the clipboard both ways, a trackpad for precise
 * pointing, and a sheet saying how it all works.
 */
function computerPhoneControls({ stage, rfb, takeIfWatching, agentTitle, agentId, base }) {
  const KEY = { Escape: 0xff1b, Tab: 0xff09, Enter: 0xff0d, Backspace: 0xff08, Delete: 0xffff, ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54, Home: 0xff50, End: 0xff57, PageUp: 0xff55, PageDown: 0xff56, Control: 0xffe3, Alt: 0xffe9, Shift: 0xffe1 };
  let keysym = null;
  import('/vendor/novnc/core/input/keysymdef.js').then((m) => (keysym = m.default)).catch(() => {});
  const tap = (sym) => rfb()?.sendKey(sym, undefined);
  const chord = (mods, sym) => {
    const r = rfb();
    if (!r) return;
    for (const m of mods) r.sendKey(m, undefined, true);
    r.sendKey(sym, undefined);
    for (const m of [...mods].reverse()) r.sendKey(m, undefined, false);
  };
  const typeText = (text) => {
    for (const ch of text) {
      if (ch === '\n') tap(KEY.Enter);
      else {
        const sym = keysym?.lookup(ch.codePointAt(0)) ?? ch.codePointAt(0);
        tap(sym);
      }
    }
  };

  // The phone's keyboard: a box off to the side that keeps focus, and passes on what's typed.
  const kbd = h('textarea', { class: 'computer-kbd', 'aria-label': `Type on ${agentTitle}’s computer`, autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false' });
  kbd.addEventListener('beforeinput', (e) => {
    e.preventDefault();
    if (e.inputType === 'insertText' || e.inputType === 'insertReplacementText' || e.inputType === 'insertFromPaste') typeText(e.data ?? e.dataTransfer?.getData('text/plain') ?? '');
    else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') tap(KEY.Enter);
    else if (e.inputType.startsWith('deleteContentBackward') || e.inputType === 'deleteWordBackward') tap(KEY.Backspace);
    else if (e.inputType.startsWith('deleteContentForward')) tap(KEY.Delete);
  });
  kbd.addEventListener('keydown', (e) => {
    // A hardware keyboard's named keys, which don't come through as text.
    if (['Escape', 'Tab', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
      e.preventDefault();
      tap(KEY[e.key]);
    }
  });

  // The phone's clipboard and the computer's, both ways.
  let copied = '';
  const remoteCopied = (text) => (copied = text);
  const clipboardSheet = () => {
    takeIfWatching();
    const pasteBox = h('textarea', { rows: 3, placeholder: 'Or paste here, then Send' });
    const wrap = sheet('Clipboard', [
      h('button', { class: 'btn wide', onclick: async () => {
        // Copy whatever's selected there first, then hand it over.
        chord([KEY.Control], 0x63);
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (!copied) return toast('Nothing came back — select something on the computer first.');
        try {
          await navigator.clipboard.writeText(copied);
          toast('Copied to your phone.');
          wrap.remove();
        } catch {
          toast('Your browser wouldn’t let polyphemus copy.', 'error');
        }
      } }, 'Copy to phone'),
      h('button', { class: 'btn wide', onclick: async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (!text) return toast('Your clipboard is empty.');
          rfb()?.clipboardPasteFrom(text);
          setTimeout(() => chord([KEY.Control], 0x76), 150);
          toast('Pasted.');
          wrap.remove();
        } catch {
          pasteBox.focus();
          toast('Paste it into the box below instead.');
        }
      } }, 'Paste from phone'),
      h('label', { class: 'field' }, h('span', {}, 'Send text'), pasteBox),
      h('button', { class: 'btn wide', onclick: () => {
        if (!pasteBox.value) return pasteBox.focus();
        rfb()?.clipboardPasteFrom(pasteBox.value);
        setTimeout(() => chord([KEY.Control], 0x76), 150);
        wrap.remove();
      } }, 'Send'),
    ]);
  };

  // Keys a phone doesn't have.
  const keysSheet = () => {
    takeIfWatching();
    const k = (label, act) => h('button', { type: 'button', class: 'btn small', onclick: act }, label);
    sheet('Keys', [
      h('div', { class: 'computer-keys' },
        k('Esc', () => tap(KEY.Escape)), k('Tab', () => tap(KEY.Tab)), k('Enter', () => tap(KEY.Enter)), k('⌫', () => tap(KEY.Backspace)),
        k('←', () => tap(KEY.ArrowLeft)), k('↑', () => tap(KEY.ArrowUp)), k('↓', () => tap(KEY.ArrowDown)), k('→', () => tap(KEY.ArrowRight)),
        k('Page up', () => tap(KEY.PageUp)), k('Page down', () => tap(KEY.PageDown)), k('Home', () => tap(KEY.Home)), k('End', () => tap(KEY.End)),
        k('Ctrl+C', () => chord([KEY.Control], 0x63)), k('Ctrl+V', () => chord([KEY.Control], 0x76)), k('Ctrl+A', () => chord([KEY.Control], 0x61)), k('Ctrl+Z', () => chord([KEY.Control], 0x7a)),
        k('Ctrl+L', () => chord([KEY.Control], 0x6c)), k('Ctrl+T', () => chord([KEY.Control], 0x74)), k('Ctrl+W', () => chord([KEY.Control], 0x77)), k('Alt+Tab', () => chord([KEY.Alt], KEY.Tab)),
      ),
      h('p', { class: 'hint tight' }, 'Ctrl+L goes to the browser’s address bar; Ctrl+T opens a tab.'),
    ]);
  };

  // Trackpad: your finger moves a pointer, like a laptop's. Tap clicks where it is; tap then hold drags.
  let pad = null;
  const trackpadOff = () => {
    pad?.remove();
    pad = null;
    padButton.setAttribute('aria-pressed', 'false');
  };
  const trackpadOn = () => {
    takeIfWatching();
    const canvas = stage.querySelector('canvas');
    if (!canvas) return toast('Wait for the screen to come up.');
    const box = () => canvas.getBoundingClientRect();
    let x = box().width / 2;
    let y = box().height / 2;
    const pointer = h('div', { class: 'trackpad-pointer' });
    pad = h('div', { class: 'trackpad' }, pointer);
    const place = () => {
      const b = box();
      const s = stage.getBoundingClientRect();
      pointer.style.left = `${b.left - s.left + x}px`;
      pointer.style.top = `${b.top - s.top + y}px`;
    };
    const send = (mask) => rfb()?._sendMouse(x, y, mask);
    let last = null;
    let moved = 0;
    let lastTap = 0;
    let dragging = false;
    pad.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      pad.setPointerCapture(e.pointerId);
      last = { x: e.clientX, y: e.clientY };
      moved = 0;
      // A tap and then holding: press the button, and what you move next drags.
      if (Date.now() - lastTap < 300) {
        dragging = true;
        send(1);
      }
    });
    pad.addEventListener('pointermove', (e) => {
      if (!last) return;
      const b = box();
      const dx = (e.clientX - last.x) * 1.6;
      const dy = (e.clientY - last.y) * 1.6;
      last = { x: e.clientX, y: e.clientY };
      moved += Math.abs(dx) + Math.abs(dy);
      x = Math.min(Math.max(x + dx, 0), b.width - 1);
      y = Math.min(Math.max(y + dy, 0), b.height - 1);
      place();
      send(dragging ? 1 : 0);
    });
    pad.addEventListener('pointerup', () => {
      last = null;
      if (dragging) {
        dragging = false;
        send(0);
        return;
      }
      if (moved < 8) {
        send(1);
        send(0);
        lastTap = Date.now();
      }
    });
    stage.append(pad);
    place();
    padButton.setAttribute('aria-pressed', 'true');
  };

  const bytesWords = (n) => (n < 1024 ? `${n} bytes` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
  // Files in and out: what's in its Downloads and on its Desktop, to take, and a way to put one there.
  const filesSheet = async () => {
    const list = h('div', { class: 'card' }, h('p', { class: 'hint', style: 'margin:12px' }, 'Looking…'));
    const picker = h('input', { type: 'file', multiple: true, hidden: true });
    const draw = async () => {
      let files = [];
      try {
        ({ files } = await api(`${base}/files`));
      } catch (err) {
        return fill(list, h('p', { class: 'hint', style: 'margin:12px' }, err.message));
      }
      fill(
        list,
        files.length
          ? files.map((f) => h('a', { class: 'item', href: `${base}/files/download?in=${encodeURIComponent(f.in)}&name=${encodeURIComponent(f.name)}`, download: f.name },
              icon('doc'),
              h('span', { class: 'grow' }, h('span', {}, f.name), h('small', {}, `${f.in} · ${bytesWords(f.bytes)} · ${ago(f.at)} ago`)),
              icon('chev', 'ico mini'),
            ))
          : h('p', { class: 'hint', style: 'margin:12px' }, `Nothing in ${agentTitle}’s Downloads or on its Desktop yet.`),
      );
    };
    picker.addEventListener('change', async () => {
      for (const file of picker.files) {
        try {
          const res = await reach(`${base}/files`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
          toast(`${data.name} is in ${agentTitle}’s Downloads.`);
        } catch (err) {
          showError(err);
        }
      }
      picker.value = '';
      draw();
    });
    sheet('Files', [
      h('p', { class: 'hint tight' }, `${agentTitle}’s Downloads and Desktop. Tap one to take it; what you send lands in Downloads.`),
      list,
      h('button', { class: 'btn wide', style: 'margin-top:10px', onclick: () => picker.click() }, 'Send a file to it'),
      picker,
    ]);
    draw();
  };

  // Record: you do the task, polyphemus notes each step, and the agent learns it from that.
  let recordingOn = false;
  let steps = 0;
  const NAMED = { 0xff0d: 'Return', 0xff09: 'Tab', 0xff1b: 'Escape', 0xff08: 'BackSpace', 0xffff: 'Delete', 0xff51: 'Left', 0xff52: 'Up', 0xff53: 'Right', 0xff54: 'Down', 0xff50: 'Home', 0xff57: 'End', 0xff55: 'Page_Up', 0xff56: 'Page_Down' };
  const MODS = { 0xffe3: 'ctrl', 0xffe4: 'ctrl', 0xffe9: 'alt', 0xffea: 'alt', 0xffe1: 'shift', 0xffe2: 'shift', 0xffeb: 'super', 0xffec: 'super' };
  // One at a time, in order: sent together, typing arrived shuffled.
  let queue = Promise.resolve();
  const note = (step) => {
    if (!recordingOn) return;
    queue = queue
      .then(() => api(base, { action: 'record', phase: 'step', step }))
      .then((r) => {
        steps = r.steps;
        drawRecord();
      })
      .catch(() => {});
  };
  const listen = (r) => {
    if (!r || r._polyphemusRecording) return;
    r._polyphemusRecording = true;
    let mask = 0;
    const held = new Set();
    const sendMouse = r._sendMouse.bind(r);
    r._sendMouse = (x, y, next) => {
      const pressed = next & ~mask;
      mask = next;
      if (recordingOn && pressed) {
        if (pressed & 1 || pressed & 4) note({ kind: 'click', x: r._display.absX(x), y: r._display.absY(y), button: pressed & 4 ? 'right' : 'left' });
        if (pressed & 8) note({ kind: 'scroll', direction: 'up' });
        if (pressed & 16) note({ kind: 'scroll', direction: 'down' });
      }
      return sendMouse(x, y, next);
    };
    const sendKey = r.sendKey.bind(r);
    r.sendKey = (sym, code, down) => {
      if (MODS[sym]) {
        if (down === false) held.delete(MODS[sym]);
        else if (down === true) held.add(MODS[sym]);
      } else if (recordingOn && down === true) {
        // A press arrives as sendKey(sym) and noVNC turns it into down-then-up through this same
        // method: only the down is the keystroke.
        const cp = sym >= 0x01000000 ? sym - 0x01000000 : sym >= 0x20 && sym <= 0xff ? sym : null;
        const mods = [...held].filter((m) => m !== 'shift');
        if (cp !== null && !mods.length) note({ kind: 'type', text: String.fromCodePoint(cp) });
        else if (cp !== null || NAMED[sym]) note({ kind: 'key', keys: [...mods, cp !== null ? String.fromCodePoint(cp).toLowerCase() : NAMED[sym]].join('+') });
      }
      return sendKey(sym, code, down);
    };
  };
  const recordButton = h('button', { type: 'button', class: 'computer-tool record', 'aria-pressed': 'false' });
  const drawRecord = () => fill(recordButton, h('span', { class: 'rec-dot' }), recordingOn ? `Stop · ${steps}` : 'Record');
  drawRecord();
  recordButton.addEventListener('click', async () => {
    if (!recordingOn) {
      takeIfWatching();
      try {
        await api(base, { action: 'record', phase: 'start' });
      } catch (err) {
        return showError(err);
      }
      listen(rfb());
      recordingOn = true;
      steps = 0;
      recordButton.setAttribute('aria-pressed', 'true');
      drawRecord();
      return toast(`Recording. Do the task on ${agentTitle}’s computer, then Stop.`);
    }
    recordingOn = false;
    recordButton.setAttribute('aria-pressed', 'false');
    drawRecord();
    let done;
    try {
      await queue; // every step in before it ends
      done = await api(base, { action: 'record', phase: 'stop' });
    } catch (err) {
      return showError(err);
    }
    const about = h('input', { type: 'text', placeholder: 'Checking the bank balance every morning', 'aria-label': 'What the task was' });
    const teach = h('button', { class: 'btn primary wide' }, `Teach ${agentTitle} this`);
    const wrap = sheet(`Recorded ${done.steps} step${done.steps === 1 ? '' : 's'}`, [
      h('label', { class: 'field' }, h('span', {}, 'What was it? (it helps)'), about),
      h('p', { class: 'hint tight' }, `${agentTitle} gets the steps and pictures of what you clicked, and turns them into a skill you approve — and a routine, if it’s for a schedule.`),
      teach,
    ]);
    teach.addEventListener('click', async () => {
      teach.disabled = true;
      try {
        const { session } = await api(base, { action: 'record', phase: 'teach', recording: done.recording, about: about.value });
        wrap.remove();
        go(`#/s/${session}`);
      } catch (err) {
        teach.disabled = false;
        showError(err);
      }
    });
  });

  const helpSheet = () =>
    sheet('Using the computer', [
      sec('Moving around'),
      h('ul', { class: 'steps-list' }, [
        'Tap to click where you tapped. One finger drags.',
        'Two fingers drag to scroll.',
        'Tap with two fingers, or press and hold, to right-click.',
      ].map((t) => h('li', {}, t))),
      sec('Typing and the clipboard'),
      h('ul', { class: 'steps-list' }, [
        'Keyboard brings up your phone’s keyboard; what you type goes to the computer.',
        'Keys has the ones a phone doesn’t: Esc, Tab, arrows, Ctrl shortcuts.',
        'Clipboard copies what’s selected there to your phone, or pastes from your phone.',
        'Files has what’s in its Downloads and on its Desktop, to take, and sends a file to it.',
      ].map((t) => h('li', {}, t))),
      sec('When a pointer is easier'),
      h('ul', { class: 'steps-list' }, [
        'Trackpad turns the screen into one: your finger moves the pointer, tap clicks where it is, and tap-then-hold drags. Tap Trackpad again to go back.',
        'Zoom shows the desktop at its full size; drag to look around. While zoomed a drag moves the view, not the mouse — tap Zoom again to fit it back.',
      ].map((t) => h('li', {}, t))),
      sec('Teaching it'),
      h('ul', { class: 'steps-list' }, [
        `Record, then do the task yourself on ${agentTitle}’s computer, then Stop. ${agentTitle} gets each step with pictures of what you clicked, and drafts a skill for you to approve — so next time it can do it on its own.`,
      ].map((t) => h('li', {}, t))),
      sec('Handing it back'),
      h('ul', { class: 'steps-list' }, [
        `Using any of these takes the computer over: ${agentTitle}’s hands wait. Watch hands it back, and so does closing it.`,
      ].map((t) => h('li', {}, t))),
    ]);

  const padButton = h('button', { type: 'button', class: 'computer-tool', 'aria-pressed': 'false', onclick: () => (pad ? trackpadOff() : trackpadOn()) }, icon('screen', 'ico mini'), 'Trackpad');
  // Zoom: the desktop at its own size, dragged around to see the part you want — a phone shows a
  // 1280-wide screen at a third of that. Watching, one finger pans; taking over, it clicks, so
  // pan with two fingers' worth of patience: tap Zoom again to see it all.
  let zoomed = false;
  const zoomButton = h('button', { type: 'button', class: 'computer-tool', 'aria-pressed': 'false', onclick: () => {
    const r = rfb();
    if (!r) return;
    zoomed = !zoomed;
    r.scaleViewport = !zoomed;
    r.clipViewport = zoomed;
    r.dragViewport = zoomed;
    zoomButton.setAttribute('aria-pressed', String(zoomed));
    // Zoomed, the view takes the height a phone has, not just a strip the desktop's shape.
    stage.classList.toggle('zoomed', zoomed);
    if (zoomed) trackpadOff();
    toast(zoomed ? 'Full size: drag to look around. Tap Zoom again to fit it.' : 'Fitted to the screen.');
  } }, icon('search', 'ico mini'), 'Zoom');
  const bar = h(
    'div',
    { class: 'computer-tools', hidden: true },
    h('button', { type: 'button', class: 'computer-tool', onclick: () => (takeIfWatching(), kbd.focus()) }, icon('thread', 'ico mini'), 'Keyboard'),
    h('button', { type: 'button', class: 'computer-tool', onclick: keysSheet }, 'Keys'),
    h('button', { type: 'button', class: 'computer-tool', onclick: clipboardSheet }, icon('doc', 'ico mini'), 'Clipboard'),
    h('button', { type: 'button', class: 'computer-tool', onclick: filesSheet }, icon('folder', 'ico mini'), 'Files'),
    recordButton,
    padButton,
    zoomButton,
    h('button', { type: 'button', class: 'computer-tool help', 'aria-label': 'How to use the computer', onclick: helpSheet }, '?'),
    kbd,
  );
  return { bar, remoteCopied, trackpadOff, place: (el) => bar.insertBefore(el, bar.querySelector('.help')) };
}

/** The computer itself, full-screen: watch, take over, and put it to sleep. */
function computerView(ref) {
  const agent = agentByRef(ref);
  if (!agent) return location.replace('#/team');
  closeComputerPane();
  const surface = computerSurface(agent, () => view.name === 'computer' && view.agent === ref);
  // A phone's header has room for the name or for Sleep, not both: Sleep joins the tools there.
  const narrow = !matchMedia('(min-width: 640px)').matches;
  if (narrow) surface.placeTool(surface.sleepButton);
  screen(
    bar(backButton(), h('div', { class: 'pill' }, mark(agent.mark ?? agent.name, 30), h('span', {}, narrow ? agent.title : `${agent.title}’s computer`)), narrow ? [surface.mode] : [surface.mode, surface.sleepButton]),
    [surface.permit, surface.status, surface.stage, surface.controls],
    { mainClass: 'plain computer-main' },
  );
  surface.load();
}

// Beside a chat: the third panel. Wide screens only — on a phone the computer takes the screen.
const roomForComputer = matchMedia('(min-width: 1100px)');
let paneAgent = null;
/** Chats where you've been offered the computer this visit: once is enough. */
const offeredComputer = new Set();
let paneSession = null;

function closeComputerPane() {
  if (!paneAgent) return;
  paneAgent = null;
  leaveComputer();
  $('#computer-pane')?.remove();
  $('#app').classList.remove('computer-open');
}

/** How wide you left the panel on this device, within what leaves the chat room to read. */
function paneWidth(px) {
  const most = Math.max(360, window.innerWidth - 640);
  const width = Math.min(Math.max(Math.round(px), 360), most);
  document.documentElement.style.setProperty('--computer-w', `${width}px`);
  return width;
}
{
  const kept = Number(remembered('polyphemus.computerW'));
  if (kept) paneWidth(kept);
}

/** The panel's left edge: drag it to give the chat or the computer more room; the desktop scales to fit. */
function paneDivider() {
  const divider = h('div', { class: 'pane-divider', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Drag to resize', title: 'Drag to resize' });
  divider.addEventListener('pointerdown', (down) => {
    down.preventDefault();
    divider.setPointerCapture(down.pointerId);
    document.body.classList.add('resizing');
    const move = (e) => paneWidth(window.innerWidth - e.clientX);
    const up = (e) => {
      divider.releasePointerCapture(down.pointerId);
      divider.removeEventListener('pointermove', move);
      divider.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing');
      remember('polyphemus.computerW', String(paneWidth(window.innerWidth - e.clientX)));
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', up);
  });
  // Twice to put it back to the width it starts at.
  divider.addEventListener('dblclick', () => {
    document.documentElement.style.removeProperty('--computer-w');
    remember('polyphemus.computerW', '');
  });
  return divider;
}

function toggleComputerPane(agent) {
  if (!roomForComputer.matches) return go(`#/a/${encodeURIComponent(agent.id)}/computer`);
  if (paneAgent === agent.id) return closeComputerPane();
  closeComputerPane();
  paneAgent = agent.id;
  const session = current?.meta.id;
  paneSession = session;
  const surface = computerSurface(agent, () => paneAgent === agent.id && current?.meta.id === session);
  const pane = h(
    'aside',
    { class: 'computer-pane', id: 'computer-pane', 'aria-label': `${agent.title}’s computer` },
    paneDivider(),
    h('div', { class: 'computer-pane-top' },
      mark(agent.mark ?? agent.name, 22),
      h('b', {}, `${agent.title}’s computer`),
      surface.mode,
      round('expand', 'Full screen', () => go(`#/a/${encodeURIComponent(agent.id)}/computer`), 'small'),
      round('close', 'Close the computer', closeComputerPane, 'small'),
    ),
    surface.permit,
    surface.status,
    surface.stage,
    surface.controls,
    h('div', { class: 'computer-pane-foot' }, surface.sleepButton),
  );
  $('#app').append(pane);
  $('#app').classList.add('computer-open');
  surface.load();
}

// ── Skills ───────────────────────────────────────────────────────────────
// Three places a skill lives: shared by every agent, one agent's own (it goes wherever the agent
// goes), or a project's. The library is skills published in the open, installed into any of them.

const skillWhere = (to) => (to === 'library' ? 'every agent' : to.startsWith('agent:') ? (agentByRef(to.slice(6))?.title ?? 'that agent') : to.startsWith('project:') ? (projectOf(to.slice(8))?.name ?? 'that project') : to);

function skillRow(skill, from) {
  const remove = isOwner()
    ? round('close', `Remove ${skill.name}`, async () => {
        if (!(await confirmSheet(`Remove ${skill.name}?`, [`${skillWhere(from) === 'every agent' ? 'No agent' : skillWhere(from)} will see it anymore.`, 'It moves to polyphemus’s trash, so it can be put back by hand.'], { yes: 'Remove', danger: true }))) return;
        try {
          await api('/api/skills/remove', { name: skill.name, from });
          toast(`${skill.name} removed.`);
          render();
        } catch (err) {
          showError(err);
        }
      }, 'small')
    : null;
  return h(
    'div',
    { class: 'row with-actions' },
    h('span', { class: 'skill-tile' }, icon('spark')),
    h('span', { class: 'row-main' }, h('span', { class: 'row-top' }, h('b', {}, skill.name), skill.from ? h('span', { class: 'tag' }, skill.from.id.split('/')[0]) : h('span', { class: 'tag' }, 'yours')), h('span', { class: 'row-sub' }, h('span', { class: 'text' }, skill.description))),
    remove,
  );
}

/** Everything installed, by where it lives. */
async function skillsScreen() {
  let installed;
  try {
    installed = await api('/api/skills');
  } catch (err) {
    return showError(err);
  }
  if (view.name !== 'skills') return;
  const withOwn = installed.agents.filter((a) => a.skills.length);
  screen(
    bar(backButton(), title('Skills'), isOwner() ? [h('button', { class: 'btn small primary', onclick: () => go('#/skills/browse?to=library') }, 'Browse the library')] : []),
    [
      h('p', { class: 'hint', style: 'margin-top:0' }, 'A skill is instructions an agent opens when the work calls for it. Only each one’s name and one line are in every prompt, so a long list costs little.'),
      sec('Shared by every agent', installed.library.length || ''),
      installed.library.length ? h('div', { class: 'card' }, installed.library.map((k) => skillRow(k, 'library'))) : h('p', { class: 'empty' }, 'None yet.'),
      sec('Agents’ own', withOwn.reduce((n, a) => n + a.skills.length, 0) || ''),
      h('p', { class: 'hint tight' }, 'An agent’s own skills go wherever it goes, like a person’s craft.'),
      withOwn.length
        ? withOwn.map((a) => [h('div', { class: 'skill-owner' }, mark(a.mark ?? a.title, 22), h('b', {}, a.title), isOwner() ? h('button', { class: 'linky', onclick: () => go(`#/skills/browse?to=${encodeURIComponent(`agent:${a.id}`)}`) }, 'Add') : null), h('div', { class: 'card' }, a.skills.map((k) => skillRow(k, `agent:${a.id}`)))])
        : h('p', { class: 'empty' }, 'None yet. Open an agent and add one, or pick one in the library for a particular agent.'),
      installed.projects.length ? [sec('Projects’ own'), installed.projects.map((p) => [h('div', { class: 'skill-owner' }, h('b', {}, p.name)), h('div', { class: 'card' }, p.skills.map((k) => skillRow(k, `project:${p.slug}`)))])] : null,
    ],
    { mainClass: 'plain' },
  );
}

/** An agent's own skills on its profile, and the way to add one. */
function agentSkillsBlock(agent) {
  const block = h('div', {}, h('p', { class: 'hint tight' }, agent.skills?.length ? `Of the shared skills, only: ${agent.skills.join(', ')}.` : 'Every shared skill, plus any of its own.'));
  api('/api/skills')
    .then((installed) => {
      const own = installed.agents.find((a) => a.id === agent.id)?.skills ?? [];
      block.append(
        own.length ? h('div', { class: 'card' }, own.map((k) => skillRow(k, `agent:${agent.id}`))) : h('p', { class: 'empty' }, 'None of its own yet.'),
        isOwner() ? h('button', { class: 'linky', onclick: () => go(`#/skills/browse?to=${encodeURIComponent(`agent:${agent.id}`)}`) }, `Add a skill for ${agent.title}`) : null,
      );
    })
    .catch(() => {});
  return block;
}

/** The library: search it, narrow it by who publishes, and install a skill where it's wanted. */
async function skillsBrowseScreen(to) {
  const search = h('input', { type: 'search', class: 'catalogue-search', placeholder: 'Search the skill library', 'aria-label': 'Search skills' });
  const sources = h('div', { class: 'scope' });
  const results = h('div', {});
  let source = '';
  let timer;
  const destination = to || 'library';
  const install = (skill) => {
    const choices = [
      ['library', 'Every agent', 'Shared: in every agent’s list'],
      ...(state.agents ?? []).map((a) => [`agent:${a.id}`, a.title, a.project ? `${a.title}’s own, in ${projectOf(a.project)?.name ?? a.project}` : `${a.title}’s own, wherever it works`]),
      ...(state.projects ?? []).map((p) => [`project:${p.slug}`, p.name, 'Every agent working in this project']),
    ];
    const pick = h('select', { id: 'skill-to' }, choices.map(([value, label]) => h('option', { value, selected: value === destination }, label)));
    const installButton = h('button', { class: 'btn primary wide' }, `Install ${skill.name}`);
    const wrap = sheet(skill.name, [
      h('p', {}, skill.description),
      h('p', { class: 'hint tight' }, `From ${skill.sourceName} (${skill.repo}) · ${skill.license}. Its licence is kept with it. Skills can include scripts an agent may run; they run under the same approvals as anything else.`),
      h('label', { class: 'field' }, h('span', {}, 'Who gets it'), pick),
      installButton,
    ]);
    installButton.addEventListener('click', async () => {
      installButton.disabled = true;
      installButton.textContent = 'Installing…';
      try {
        const done = await api('/api/skills/install', { id: skill.id, to: pick.value });
        wrap.remove();
        toast(`${skill.name} installed for ${done.for}.`);
      } catch (err) {
        installButton.disabled = false;
        installButton.textContent = `Install ${skill.name}`;
        if (/already a skill/.test(err.message) && (await confirmSheet('Replace it?', [err.message], { yes: 'Replace' }))) {
          try {
            const done = await api('/api/skills/install', { id: skill.id, to: pick.value, replace: true });
            wrap.remove();
            toast(`${skill.name} replaced for ${done.for}.`);
          } catch (again) {
            showError(again);
          }
        } else showError(err);
      }
    });
  };
  const load = async () => {
    let lib;
    try {
      lib = await api(`/api/skills/library?q=${encodeURIComponent(search.value.trim())}&source=${encodeURIComponent(source)}`);
    } catch (err) {
      return showError(err);
    }
    if (view.name !== 'skillsBrowse') return;
    fill(
      sources,
      h('button', { type: 'button', class: `chip ${source ? '' : 'on'}`, onclick: () => ((source = ''), load()) }, `All ${lib.total || ''}`),
      lib.sources.filter((s) => s.count).map((s) => h('button', { type: 'button', class: `chip ${source === s.id ? 'on' : ''}`, onclick: () => ((source = s.id), load()) }, `${s.name} ${s.count}`)),
    );
    if (!lib.total) {
      fill(results, h('p', { class: 'hint' }, lib.building ? `Reading the library from its sources${lib.building.of ? ` — ${lib.building.done} of ${lib.building.of}` : ''}…` : 'The library couldn’t be read. Try again in a minute.'));
      if (lib.building) setTimeout(() => view.name === 'skillsBrowse' && load(), 1500);
      return;
    }
    fill(
      results,
      lib.skills.map((k) =>
        h(
          'button',
          { class: 'row chevroned', onclick: () => (isOwner() ? install(k) : null) },
          h('span', { class: 'skill-tile' }, icon('spark')),
          h('span', { class: 'row-main' }, h('span', { class: 'row-top' }, h('b', {}, k.name), h('span', { class: 'tag' }, k.sourceName)), h('span', { class: 'row-sub' }, h('span', { class: 'text' }, k.description))),
          icon('chev', 'ico mini'),
        ),
      ),
      lib.more ? h('p', { class: 'hint' }, `${lib.more} more — search to narrow it down.`) : null,
      lib.skills.length ? null : h('p', { class: 'empty' }, 'Nothing matches that.'),
      h('p', { class: 'hint' }, `Only openly licensed skills are listed${lib.withheld ? ` (${lib.withheld} others aren’t)` : ''}. Read ${lib.builtAt ? ago(lib.builtAt) : 'just now'} ago from each source.`),
    );
  };
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(load, 200);
  });
  screen(
    bar(backButton(), title(to && to !== 'library' ? `Skills for ${skillWhere(to)}` : 'Skill library')),
    [h('p', { class: 'hint lead' }, 'Skills published in the open by Anthropic, OpenAI, GitHub, Microsoft, Hugging Face and others. Pick one to install it.'), search, sources, results],
    { mainClass: 'plain' },
  );
  load();
}

/** One agent's settings: what it is, who it is, and what it does here — all editable from the phone. */
async function agentScreen(name) {
  let agent;
  try {
    ({ agent } = await api(`/api/agents/${encodeURIComponent(name)}`));
  } catch (err) {
    showError(err);
    return go('#/team');
  }
  const description = h('input', { id: 'agent-description', value: agent.description });
  // Made from the name unless you say otherwise: "bd" becomes "Bd", which is right for a word
  // and wrong for an acronym, and only you know which it is.
  const title = h('input', { id: 'agent-title', value: agent.title, placeholder: titleFromName(agent.name) });
  // An agent keeps the model it was made with. "Follow the default" is the one way to have it move
  // when the default does — chosen, never assumed.
  const model = modelPicker('agent-model', agent.model === 'default' ? '' : (agent.model ?? ''), 'Whatever the thread uses');
  const follow = h('option', { value: 'default', selected: agent.model === 'default' }, `Follow the default${state.defaultModel ? ` (now ${state.defaultModel})` : ''}`);
  // After the blank choice; options[1] may sit inside a provider's optgroup, so go by direct children.
  model.insertBefore(follow, model.children[1] ?? null);
  // What it tries when its own model can't take a turn — out of quota, or a provider that's down.
  const fallbacks = (agent.fallback ?? []).slice(0, 2);
  const fallbackPickers = [0, 1].map((slot) =>
    modelPicker(`agent-fallback-${slot}`, fallbacks[slot] ?? '', slot === 0 ? 'None — stop and ask me' : 'None'),
  );
  const persona = h('textarea', { id: 'agent-persona', rows: 8, placeholder: 'Who it is and how it works.' });
  const instructions = h('textarea', { id: 'agent-instructions', rows: 8, placeholder: 'What it does here, and where it stops.' });
  persona.value = agent.persona;
  instructions.value = agent.instructions;

  // null while you haven't tapped one, so Save doesn't pin a mark you never chose.
  let picked = null;
  const picker = markPicker(agent.mark, (value) => (picked = value));
  const resetMark = h('button', { type: 'button', class: 'linky', onclick: async () => {
    try {
      const { agent: updated } = await api(`/api/agents/${encodeURIComponent(agent.id)}`, { mark: null });
      picked = null;
      picker.set(updated.mark);
      await refresh();
      toast('Back to the mark its name gets.');
    } catch (err) {
      showError(err);
    }
  } }, 'Reset to default');

  // The persona may have been written from the description rather than by you — say so, and say
  // it while it's still being written, because creation didn't wait for it.
  const drafting = new URLSearchParams(location.hash.split('?')[1] ?? '').get('drafting') === '1' && !agent.persona;
  const personaNote = h('small', { class: 'hint' }, drafting ? 'Writing it from what you said…' : '');

  const save = async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await api(`/api/agents/${encodeURIComponent(agent.id)}`, {
        description: description.value.trim(),
        title: title.value.trim(),
        model: model.value,
        fallback: fallbackPickers.map((picker) => picker.value).filter(Boolean),
        persona: persona.value,
        instructions: instructions.value,
        ...(picked ? { mark: picked } : {}),
      });
      await refresh();
      toast('Saved');
    } catch (err) {
      showError(err);
    }
    button.disabled = false;
  };

  screen(
    bar(backButton(), h('div', { class: 'pill' }, mark(agent.mark ?? agent.name, 34), h('span', {}, agent.title))),
    [
      talkButton(agent),
      h('div', { class: 'field' }, h('span', {}, 'What it can reach, and why'), reachSection(`/api/agents/${encodeURIComponent(agent.id)}/reach`, { perProject: true, empty: 'Nothing outside: no connection is granted to a project it works in.' })),
      h('label', { class: 'field' }, h('span', {}, 'What it’s for'), description),
      h('label', { class: 'field' }, h('span', {}, 'Called'), title, h('small', { class: 'hint' }, `Its name on your computer stays ${agent.name}. Empty goes back to ${titleFromName(agent.name)}.`)),
      h('div', { class: 'field' }, h('span', {}, 'Its mark'), picker.node, resetMark),
      h('label', { class: 'field' }, h('span', {}, 'Model'), model),
      h(
        'div',
        { class: 'field' },
        h('span', {}, 'If that one can’t take a turn'),
        h('div', { class: 'controls' }, ...fallbackPickers),
        h('small', { class: 'hint' }, 'Tried in order when its model is out of quota or failing. Without one, the thread pauses and asks you.'),
      ),
      h('label', { class: 'field' }, h('span', {}, 'Who it is'), persona, personaNote),
      h('label', { class: 'field' }, h('span', {}, 'What it does here'), instructions),
      isOwner() ? h('button', { class: 'btn wide', onclick: save }, 'Save') : h('p', { class: 'hint' }, 'Only the owner of this install can change an agent.'),
      h('p', { class: 'hint' }, `${agent.scope === 'project' ? 'In this project only' : 'Available everywhere'} · on your computer: ${agent.file}`),
    ],
    { mainClass: 'plain' },
  );
}


// ── Work: a thread with an outcome, its runs, steps and evidence ─────────
//
// Settled brief §3–4. The strip is worn by a thread that's tracking an outcome; a chat doesn't have
// one. Every status on it came from something polyphemus saw happen, and every piece of evidence says
// whether anything outside polyphemus vouches for it: a receipt, or local.

const STATUS_WORDS = { queued: 'queued', running: 'running', waiting: 'waiting', retrying: 'retrying', failed: 'failed', interrupted: 'interrupted', done: 'done', unknown: 'unknown' };
const statusTag = (status) => (status ? h('span', { class: `st ${status}` }, STATUS_WORDS[status] ?? status) : null);
const KIND_WORDS = { work: null, think: 'Answer only', verify: 'Checks an earlier step', gate: 'Needs a person', check: 'Checked by polyphemus', action: 'Done by polyphemus, once' };

/** A work item's second line: where its run is, in facts. */
function workLine(w) {
  if (!w.run) return `Tracking: ${w.outcome} · no run yet`;
  if (w.status === 'done') return `run ${w.run} · done · ${w.evidence} confirmed${w.receipts ? `, ${w.receipts} with receipts` : ''}`;
  const where = w.step ? `step ${w.step} of ${w.steps}` : 'planning';
  // The run's reason names the step already; the row only needs what went wrong.
  const why = ['failed', 'interrupted', 'unknown'].includes(w.status) && w.reason ? w.reason.replace(/^Step \d+, [^:]+: /, '') : null;
  return [`run ${w.run}`, where, w.gate ? 'gate' : null, why].filter(Boolean).join(' · ');
}

/** What someone did with a question, in words. */
/** Where a kept memory can come back: the same words the agent was given. */
const NOTE_SCOPES = {
  private: { label: 'Only with you', where: 'only in your own threads with it' },
  project: { label: 'In this project', where: 'any thread in the project' },
  craft: { label: 'Anywhere', where: 'any thread with it, with anyone' },
};

function answerVerb(answer) {
  return (
    { bring: 'brought them in', thread: 'started a new thread', agent: 'kept it as the agent’s own', library: 'kept it for every agent', allow: 'allowed it', always: 'allowed it (always)', approve: 'allowed it', work: 'made work of it', dismiss: 'dismissed it', track: 'tracked it as work', accept: 'accepted it', private: 'kept it privately', craft: 'kept it for anywhere', project: 'kept it in the project', continue: 'let it continue', stop: 'stopped it', saved: 'saved it in the vault', 'signed-in': 'finished signing in' }[answer] ??
    (!answer || answer === 'deny' || answer === 'decline' ? 'declined it' : `chose ${answer}`)
  );
}

/**
 * The run marker in the conversation, in place of the instructions polyphemus gave the agent.
 */
const TAG = 'polyphemus';
function runMarker(m) {
  const text = userText(m);
  const node = new RegExp(`^<${TAG}_node title="([^"]*)">\n?([\s\S]*?)\n?</${TAG}_node>$`).exec(text);
  // A workflow step's instructions: polyphemus wrote them, so they're shown as that, folded away.
  if (node) return h('details', { class: 'node-instructions' }, h('summary', {}, `Polyphemus’s instructions for ${node[1]}`), h('div', { class: 'md' }, markdown(node[2])));
  // Words that came in from somewhere — a request, what a work item is for — shown open, as what they are.
  const note = new RegExp(`^<${TAG}_note title="([^"]*)">\n?([\s\S]*?)\n?</${TAG}_note>$`).exec(text);
  if (note) return h('div', { class: 'thread-note' }, h('b', {}, note[1]), h('div', { class: 'md' }, markdown(note[2])));
  if (!new RegExp(`^<${TAG}_run>`).test(text)) return null;
  const planning = /starting run (\d+)/.exec(text);
  if (planning) return h('div', { class: 'day run-marker' }, `polyphemus asked it to plan run ${planning[1]}`);
  const step = /Run (\d+), step (\d+) of (\d+) for "[^"]*": ([^\n]*)/.exec(text);
  return h('div', { class: 'day run-marker' }, step ? `Run ${step[1]} · step ${step[2]} of ${step[3]}: ${step[4]}` : 'polyphemus moved the run on');
}

function evidenceRow(e) {
  const noun = e.kind === 'file' ? 'doc' : e.kind === 'commit' ? 'thread' : e.kind === 'check' ? 'screen' : 'spark';
  return h(
    'div',
    { class: `evi ${e.ok ? '' : 'bad'}` },
    icon(noun, 'ico mini'),
    h('span', { class: 'grow' }, h('span', { class: e.kind === 'call' ? '' : 'mono' }, e.label), e.detail ? h('small', {}, e.detail) : null),
    e.ok ? h('span', { class: `receipt ${e.receipt ? '' : 'none'}`, title: e.receipt ?? 'It exists; nothing outside polyphemus vouches for it.' }, e.receipt ? 'receipt' : 'local') : h('span', { class: 'receipt failed' }, 'failed'),
  );
}

/** Pictures a step took — pages it opened, at each width — each opening full size. */
function stepPictures(step) {
  if (!step.pictures?.length) return null;
  return h(
    'div',
    { class: 'step-pictures' },
    step.pictures.map((p) => h('a', { class: 'step-picture', href: `/artifacts/${p.id}/file`, target: '_blank', rel: 'noopener noreferrer' }, h('img', { src: `/artifacts/${p.id}/file`, alt: p.title, loading: 'lazy' }), h('small', {}, p.title))),
  );
}

/** Issues a step filed on GitHub, each one tap from shipping. */
function shipButtons(step) {
  const filed = step.filedIssues;
  const project = current ? projectOf(current.project ?? sessionById(current.meta.id)?.project ?? '') : null;
  if (!filed?.numbers?.length || !project || project.status !== 'active' || !(isOwner() || project.role === 'member')) return null;
  return h(
    'div',
    { class: 'buttons ship-filed' },
    filed.numbers.length > 1 ? h('button', { class: 'btn small', onclick: () => startWorkflowSheet(project, { workflow: 'ship-issue', input: { issue: filed.numbers[0], then: filed.numbers.slice(1).join(', '), repo: filed.repo } }) }, 'Ship all, in order') : null,
    filed.numbers.map((n) => h('button', { class: 'btn small', onclick: () => startWorkflowSheet(project, { workflow: 'ship-issue', input: { issue: n, repo: filed.repo } }) }, `Ship #${n}`)),
  );
}

function stepCard(step) {
  const kind = KIND_WORDS[step.kind];
  // Unknown isn't failed: nothing went wrong that polyphemus saw, and nothing confirmed it either.
  const cls = step.status === 'done' ? 'done' : step.status === 'failed' || step.status === 'interrupted' ? 'failed' : step.status === 'unknown' ? 'unsure' : step.status === 'waiting' ? 'gate' : step.status === 'queued' ? 'todo' : '';
  const said = step.status === 'queued' ? (step.kind === 'verify' ? `Checks step ${step.verifies}. Not started.` : 'Not started.') : step.reason;
  const took = step.startedAt && step.endedAt ? duration(step.endedAt - step.startedAt) : null;
  // A workflow's agent step ran in its own fresh session: open that thread. A planned run's step is in this one.
  const read = step.sessionId
    ? h('button', { class: 'step-link', onclick: () => go(`#/s/${step.sessionId}`) }, step.attempt > 1 ? `Read attempt ${step.attempt}` : 'Read what it did')
    : step.seqStart !== undefined && !['gate', 'check', 'action'].includes(step.kind) ? h('button', { class: 'step-link', onclick: () => readStep(step) }, 'Read what it did') : null;
  return h(
    'div',
    { class: `run-step ${cls}` },
    h('span', { class: 'step-n' }, step.status === 'done' ? '✓' : step.status === 'failed' ? '!' : step.status === 'unknown' ? '?' : String(step.n)),
    h(
      'div',
      { class: 'step-body' },
      h('div', { class: 'step-head' }, h('b', {}, step.title), statusTag(step.status)),
      [kind, step.answeredByName && step.kind === 'gate' ? `answered by ${step.answeredByName}` : null, took].filter(Boolean).length
        ? h('small', {}, [kind, step.answeredByName && step.kind === 'gate' ? `answered by ${step.answeredByName}` : null, took].filter(Boolean).join(' · '))
        : null,
      said ? h('small', { class: step.status === 'failed' ? 'said bad' : 'said' }, said) : null,
      step.check ? h('small', {}, `It recorded: ${step.check.passed ? 'passed' : 'failed'} — ${step.check.what}`) : null,
      (step.evidence ?? []).map(evidenceRow),
      stepPictures(step),
      shipButtons(step),
      // A gate waiting on a person is answered right where it sits in the run.
      step.kind === 'gate' && step.status === 'waiting' ? gateCardFor(step) : null,
      read,
    ),
  );
}

function gateCardFor(step) {
  const q = state.questions.find((x) => x.kind === 'gate' && x.stepId === step.id);
  return q ? questionCard(q, true) : null;
}

/** Scrolls the conversation to where a step's turn began. */
function readStep(step) {
  const markers = [...document.querySelectorAll('#log .run-marker')];
  const target = markers.find((node) => node.textContent.includes(`step ${step.n} of`) && node.textContent.startsWith('Run'));
  (target ?? $('#log'))?.scrollIntoView({ behavior: scrollMotion(), block: 'start' });
}

/** The strip, and the run under it. Redrawn in place when the work changes, never over what you're typing. */
function workPanel(s) {
  const w = s.work;
  if (!w?.outcome && !w?.runs?.length) return h('div', { id: 'work' });
  const latest = w.runs[0];
  const outcome = w.outcome;
  const active = Boolean(w.active);
  const segments = latest?.steps ?? [];
  // A workflow loops and retries, so it's wherever its latest step is; a planned run, at its first unfinished one.
  const current = latest?.workflow ? segments.at(-1) : segments.find((x) => ['running', 'retrying', 'waiting', 'failed', 'interrupted', 'unknown'].includes(x.status));
  const act = async (path, body, button) => {
    button.disabled = true;
    try {
      const { work } = await api(`/api/sessions/${s.meta.id}/${path}`, body);
      current_work(s, work);
    } catch (err) {
      button.disabled = false;
      showError(err);
    }
  };
  const startButton = h('button', { class: 'btn small primary' }, latest ? `Start run ${latest.n + 1}` : 'Plan and start');
  startButton.addEventListener('click', () => act('run', {}, startButton));
  const stopButton = h('button', { class: 'btn small danger' }, 'Stop the run');
  stopButton.addEventListener('click', async () => {
    if (!(await confirmSheet('Stop this run?', ['What it’s doing now is interrupted and says so. Evidence it gathered stays.', 'You can start another run afterwards.'], { yes: 'Stop it', danger: true }))) return;
    act('run', { stop: true }, stopButton);
  });
  const foot = latest
    ? [`Run ${latest.n}`, active ? (current ? `step ${current.n} of ${segments.length}${current.status === 'waiting' ? ' · at a gate' : ''}` : 'planning') : latest.status === 'done' ? 'every step confirmed' : null].filter(Boolean).join(' · ')
    : 'Not started. Starting it asks the agent to plan steps; nothing else happens until then.';
  const canAct = s.canAct !== false;
  const strip = outcome
    ? h(
        'div',
        { class: 'outcome' },
        h('div', { class: 'outcome-top' }, h('b', {}, outcome.text), latest ? statusTag(latest.status) : h('span', { class: 'st queued' }, 'no run yet')),
        h('div', { class: 'where' }, `Tracking since ${agoWords(outcome.setAt)} · ${outcome.proposedBy ? `proposed by ${actorName(outcome.proposedBy)}, accepted by ${outcome.setByName}` : `set by ${outcome.setByName}`}`),
        segments.length ? h('div', { class: 'outcome-bar', 'aria-hidden': 'true' }, segments.map((x) => h('i', { class: x.status === 'done' ? 'ok' : ['running', 'retrying', 'waiting'].includes(x.status) ? 'now' : ['failed', 'interrupted'].includes(x.status) ? 'bad' : x.status === 'unknown' ? 'unsure' : '' }))) : null,
        h('div', { class: 'outcome-foot' }, h('span', {}, foot), canAct ? (active ? stopButton : startButton) : null),
        latest && !active && latest.reason && latest.status !== 'done' ? h('div', { class: `note ${latest.status === 'failed' ? 'bad' : 'warn'}` }, h('b', {}, `Run ${latest.n} ${latest.status}. `), latest.reason) : null,
        // A queue that stopped here: what's waiting, one tap from going on.
        latest && !active && latest.upNext && canAct ? shipTheRest(s, latest.upNext) : null,
      )
    : h('div', { class: 'outcome dropped' }, h('div', { class: 'where' }, `No longer tracking an outcome. ${w.runs.length} run${w.runs.length === 1 ? '' : 's'} kept below.`));
  const runBlock = (run, open) =>
    h(
      'details',
      { class: 'run', ...(open ? { open: true } : {}) },
      h('summary', {}, h('span', {}, `Run ${run.n}`), statusTag(run.status), h('small', {}, `started ${agoWords(run.startedAt)} by ${run.startedByName}`)),
      run.steps.length ? h('div', { class: 'run-steps' }, run.steps.map(stepCard)) : h('p', { class: 'hint tight' }, run.status === 'running' ? 'Planning…' : (run.reason ?? 'No steps were planned.')),
    );
  return h('div', { id: 'work' }, strip, latest ? runBlock(latest, active || latest.status !== 'done') : null, w.runs.slice(1).map((run) => runBlock(run, false)));
}

/** The rest of a queue that stopped behind a run, offered — never started on its own. */
function shipTheRest(s, next) {
  const project = s.project ?? sessionById(s.meta.id)?.project;
  const issues = [next.input.issue, ...(String(next.input.then ?? '').match(/\d+/g) ?? [])].map((n) => `#${n}`);
  const button = h('button', { class: 'btn small primary' }, `Ship the rest: ${issues.join(', ')}`);
  button.addEventListener('click', async () => {
    if (!project) return toast('This thread isn’t in a project any more.', 'error');
    button.disabled = true;
    try {
      const { id } = await api(`/api/workflows/${encodeURIComponent(next.workflow)}/start`, { project, input: next.input, yolo: s.autoApprove === true });
      await refresh();
      go(`#/s/${id}`);
    } catch (err) {
      button.disabled = false;
      showError(err);
    }
  });
  return h('div', { class: 'note warn queue-rest' }, h('span', {}, `The queue stopped here. ${issues.length === 1 ? 'One issue is' : `${issues.length} issues are`} waiting.`), button);
}

/** Room beside the conversation for a run: only on a screen wide enough for both. */
const roomyScreen = matchMedia('(min-width: 1280px)');
const runPaneClosed = () => remembered('polyphemus.runPane') === 'closed';

/**
 * The desktop run pane: on a big screen a work item's strip and steps sit beside the conversation.
 * Closing it is remembered on this device, so it stays closed; the thread's status line reopens it.
 * On a phone it's the same panel above the conversation, and there's nothing to close.
 */
function runPane(s) {
  const hasWork = Boolean(s.work?.outcome || s.work?.runs?.length);
  const open = hasWork && roomyScreen.matches && !runPaneClosed();
  $('#app').classList.toggle('run-pane-open', open);
  const close = h('button', { class: 'round small', 'aria-label': 'Close the run pane', title: 'Close', onclick: () => {
    remember('polyphemus.runPane', 'closed');
    $('#app').classList.remove('run-pane-open');
    drawThreadState();
  } }, icon('close'));
  return h('aside', { class: 'run-pane', id: 'run-pane', 'aria-label': 'The run' }, hasWork ? h('div', { class: 'run-pane-top' }, h('b', {}, 'Work'), close) : null, workPanel(s));
}

/** New work detail for the open thread: swap the panel, leave the rest alone. */
function current_work(s, work) {
  s.work = work;
  $('#work')?.replaceWith(workPanel(s));
  refreshSoon();
}

// ── Connections: outside services, what each may do, and who it's granted to ──
//
// Settled brief §5. A connection is an account at a service (a CRM, a database, GitHub), reached
// through its MCP server. The ceiling is the most its credential permits, and the screen always says
// how anyone knows. A grant gives a project, or an agent inside one, part of that — and never more:
// the sheets here only offer what the thing being narrowed already has, and the daemon refuses the rest.

/** "3m ago", or "just now" — never "now ago". Dates past a week read as dates. */
const agoWords = (ts) => {
  const said = ago(ts);
  return said === 'now' ? 'just now' : /\d[mhd]$/.test(said) ? `${said} ago` : `on ${said}`;
};

const HEALTH = { ok: ['good', 'Working'], failing: ['bad', 'Not working'], untested: ['', 'Not tested'] };
const PROVENANCE = { checked: ['good', 'Checked'], declared: ['accent', 'Declared'], unknown: ['warn', 'Unknown'] };
const toolTag = (t) => h('span', { class: `tag ${t.reads ? '' : 'warn'}` }, t.reads ? 'Reads' : 'Changes');
const toolsSummary = (tools) => {
  const reads = tools.filter((t) => t.reads).length;
  if (!tools.length) return 'nothing';
  return reads === tools.length ? `${tools.length === 1 ? 'reads' : `${tools.length} tools, all reads`}` : `${tools.length} tool${tools.length === 1 ? '' : 's'}, ${tools.length - reads} that change${tools.length - reads === 1 ? 's' : ''} things`;
};
const connectionMark = (c) => mark({ shape: 'hex', color: MARK_COLORS[[...c.id].reduce((n, ch) => n + ch.charCodeAt(0), 0) % MARK_COLORS.length] }, 40);

/** The line that says what a connection is doing lately, for Setup's row and the list. */
function connectionsRow() {
  const issues = (state.connectionIssues ?? []).length;
  return h(
    'button',
    { class: 'row chevroned', onclick: () => go('#/connections') },
    mark({ shape: 'hex', color: 'teal' }),
    h(
      'span',
      { class: 'row-main' },
      h('span', { class: 'row-top' }, h('b', {}, 'Connections'), issues ? h('span', { class: 'tag bad' }, `${issues} not working`) : null),
      h('span', { class: 'row-sub' }, h('span', { class: 'text' }, state.connectionCount ? `${state.connectionCount} connected · outside services agents can reach` : 'Outside services agents can reach: a CRM, a database, GitHub')),
    ),
    icon('chev', 'ico mini'),
  );
}

async function connectionsScreen() {
  let data;
  try {
    data = await api('/api/connections');
  } catch (err) {
    showError(err);
    return location.replace('#/you');
  }
  const cards = data.connections.map((c) =>
    h(
      'button',
      { class: 'provider conn-card', onclick: () => go(`#/connections/${encodeURIComponent(c.id)}`) },
      h(
        'div',
        { class: 'provider-head' },
        connectionMark(c),
        h(
          'div',
          { class: 'row-main' },
          h('span', { class: 'chip-line' }, h('b', {}, c.name), h('span', { class: `tag ${HEALTH[c.health][0]}` }, HEALTH[c.health][1])),
          h(
            'span',
            { class: 'meta' },
            [
              `Owned by ${c.owner.you ? 'you' : c.owner.name}`,
              `offers ${toolsSummary(c.tools)}`,
              c.grants.length ? `granted to ${[...new Set(c.grants.map((g) => g.project ? g.projectName : g.agentTitle))].join(', ')}` : 'not granted anywhere yet',
            ].join(' · '),
          ),
        ),
      ),
      c.health === 'failing' ? h('div', { class: 'method' }, h('div', { class: 'note bad' }, clip(c.error ?? 'It stopped working.', 200))) : null,
    ),
  );
  screen(
    bar(backButton(), title('Connections'), data.canAdd ? [round('plus', 'Connect a service', () => go('#/connections/new'))] : []),
    [
      h('p', { class: 'hint lead' }, 'Accounts at outside services, reached through their MCP servers. Polyphemus makes every call itself, checks it against what was granted, and keeps a record of which work it was for.'),
      cards.length ? cards : h('p', { class: 'empty' }, data.canAdd ? 'Nothing connected yet.' : 'Nothing is connected to a project you’re in.'),
      data.canAdd && !cards.length ? h('button', { class: 'btn primary wide', onclick: () => go('#/connections/new') }, 'Connect a service') : null,
    ],
    { mainClass: 'plain' },
  );
}

/** A service's tile: its brand colour and initial, until there are logos. */
const serviceTile = (entry, size = 40) => {
  const tile = h('span', { class: 'service-tile', 'aria-hidden': 'true' }, entry.name.charAt(0));
  tile.style.setProperty('--tile', entry.color);
  tile.style.setProperty('--size', `${size}px`);
  return tile;
};

/**
 * Connecting a service polyphemus knows: pick it, and its address and how it signs in are already
 * filled in. Notion signs in; GitHub takes a token, with the steps to make one no wider than it needs;
 * Google starts with a sign-in client of your own, once.
 */
async function connectionCatalogueScreen(open) {
  if (!isOwner()) return location.replace('#/connections');
  let catalogue;
  let google;
  let xApp;
  let plaid;
  let simplefin;
  try {
    ({ catalogue, google, x: xApp, plaid, simplefin } = await api('/api/connections/catalogue'));
  } catch (err) {
    showError(err);
    return location.replace('#/connections');
  }
  const entry = open ? catalogue.find((e) => e.id === open) : null;
  if (!entry) {
    // Ninety-odd services: grouped the way you'd look for one, with a search over the lot.
    const ORDER = ['Email & messages', 'Files', 'Docs & knowledge', 'Projects & tasks', 'Meetings & calendars', 'Design', 'Sales & support', 'Money', 'Websites & marketing', 'Data & analytics', 'Developer', 'Automation', 'Research & web', 'Travel & life'];
    const tagFor = (e) =>
      e.connected.length ? h('span', { class: 'tag good' }, 'Connected')
      : h('span', { class: 'tag' }, e.signIn === 'token' ? 'Token' : e.signIn === 'none' ? (e.builtin ? 'Built in' : 'Open') : (e.signIn === 'google' && !google.client) || (e.signIn === 'x' && !xApp?.client) || (e.signIn === 'plaid' && !plaid?.client && !simplefin?.linked) ? 'Set up once' : e.signIn === 'plaid' ? 'Ready' : 'Sign in');
    const row = (e) =>
      h(
        'button',
        { class: 'row chevroned', onclick: () => go(`#/connections/new?service=${e.id}`) },
        serviceTile(e),
        h('span', { class: 'row-main' }, h('span', { class: 'row-top' }, h('b', {}, e.name), tagFor(e)), h('span', { class: 'row-sub' }, h('span', { class: 'text' }, e.about))),
        icon('chev', 'ico mini'),
      );
    const other = h(
      'button',
      { class: 'row chevroned', onclick: () => go('#/connections/new?service=other') },
      serviceTile({ name: '+', color: '#6b7280' }),
      h('span', { class: 'row-main' }, h('span', { class: 'row-top' }, h('b', {}, 'Something else')), h('span', { class: 'row-sub' }, h('span', { class: 'text' }, 'Any MCP server: a web address, or a command on this computer'))),
      icon('chev', 'ico mini'),
    );
    const search = h('input', { type: 'search', class: 'catalogue-search', placeholder: `Search ${catalogue.length} services`, 'aria-label': 'Search services' });
    const body = h('div', {});
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const shown = catalogue.filter((e) => !q || `${e.name} ${e.about} ${e.category ?? ''}`.toLowerCase().includes(q));
      const connected = shown.filter((e) => e.connected.length);
      const groups = [...new Set([...ORDER, ...shown.map((e) => e.category ?? 'More')])]
        .map((cat) => [cat, shown.filter((e) => !e.connected.length && (e.category ?? 'More') === cat)])
        .filter(([, list]) => list.length);
      fill(
        body,
        connected.length ? [sec('Connected', connected.length), h('div', { class: 'list' }, connected.map(row))] : null,
        groups.map(([cat, list]) => [sec(cat, list.length), h('div', { class: 'list' }, list.map(row))]),
        shown.length ? null : h('p', { class: 'empty' }, `Nothing called “${search.value.trim()}”. It may still have an MCP server: add it as something else.`),
        [sec('Not listed'), h('div', { class: 'list' }, other)],
      );
    };
    search.addEventListener('input', draw);
    draw();
    return screen(
      bar(backButton(), title('Connect a service')),
      [h('p', { class: 'hint lead' }, 'Pick one and polyphemus fills in the rest. Nothing can use it until you grant it to a project.'), search, body],
      { mainClass: 'plain' },
    );
  }
  if (entry.signIn === 'google' && !google.client) return googleClientSetup(entry, google.callback);
  if (entry.signIn === 'x' && !xApp?.client) return xClientSetup(entry, xApp.callback);
  if (entry.signIn === 'plaid' && !plaid?.client && !simplefin?.linked) return financeSetup(entry);
  if (entry.id === 'github' && new URLSearchParams(location.hash.split('?')[1] ?? '').get('with') !== 'token') return githubIdentityScreen(entry);
  const label = () => (entry.signIn === 'oauth' ? `Sign in to ${entry.name}` : entry.signIn === 'google' ? 'Sign in with Google' : entry.signIn === 'x' ? 'Sign in with X' : entry.signIn === 'plaid' ? 'Connect Finance' : `Connect ${entry.name}`);
  const connect = h('button', { class: 'btn primary wide' }, label());
  const token = entry.signIn === 'token' ? h('input', { id: 'service-token', type: 'password', placeholder: entry.token.placeholder, autocomplete: 'off', spellcheck: 'false', 'aria-label': `${entry.name} token` }) : null;
  connect.addEventListener('click', async () => {
    if (token && !token.value.trim()) return token.focus();
    connect.disabled = true;
    connect.textContent = entry.signIn === 'token' || entry.signIn === 'none' ? 'Connecting…' : 'Opening sign-in…';
    try {
      const { connection, authorizeUrl, problem } = await api('/api/connections', { catalogue: entry.id, ...(token ? { secrets: { TOKEN: token.value.trim() } } : {}) });
      if (authorizeUrl) return location.assign(authorizeUrl);
      await refresh();
      if (problem) toast(problem, 'error');
      else toast(connection.health === 'ok' ? `${entry.name} connected: it offers ${toolsSummary(connection.tools)}.` : `${entry.name} added, but it isn’t working yet: ${connection.error ?? ''}`, connection.health === 'ok' ? undefined : 'error');
      location.replace(`#/connections/${encodeURIComponent(connection.id)}`);
    } catch (err) {
      connect.disabled = false;
      connect.textContent = label();
      showError(err);
    }
  });
  const apiName = entry.google === 'gmail' ? 'Gmail' : 'Google Drive';
  screen(
    bar(backButton(), h('div', { class: 'pill' }, serviceTile(entry, 30), h('span', {}, entry.name))),
    [
      h('p', { class: 'lead-line' }, entry.about),
      entry.connected.length ? h('div', { class: 'note warn' }, `Already connected as ${entry.connected.join(', ')}. Connecting again adds a second account.`) : null,
      entry.signIn === 'google'
        ? [
            h('p', { class: 'hint' }, `You’ll sign in with Google and come straight back. Polyphemus runs its own ${entry.name} server on this computer and hands it an hour’s access at a time — never your password, refresh token or client secret.`),
            h('div', { class: 'note' }, `The ${apiName} API has to be enabled in the Google Cloud project your client is in. `, h('a', { href: `https://console.cloud.google.com/apis/library/${entry.google === 'gmail' ? 'gmail' : 'drive'}.googleapis.com`, target: '_blank', rel: 'noopener noreferrer' }, 'Enable it'), '.'),
            h('button', { class: 'linky', onclick: () => googleClientSetup(entry, google.callback, true) }, 'Use a different Google client'),
          ]
        : entry.signIn === 'plaid'
          ? [
              h('p', { class: 'hint' }, plaid?.client
                ? `Your Plaid app is set up (${plaid.environment}). Connect Finance, then link a bank: you sign in at Plaid’s own page, and polyphemus never sees the bank’s password.`
                : 'Your SimpleFIN token is saved. Connect Finance, and it reads the accounts you linked at SimpleFIN.'),
              h('ul', { class: 'steps-list' }, [
                'It reads balances, transactions, investments and bills. Nothing here can move money.',
                'Every bank you link is kept in your vault, on this computer. No model, agent or server is ever handed one.',
                'Grant it where you want it, like any connection: an agent only sees it in a project you grant it to.',
              ].map((t) => h('li', {}, t))),
              h('button', { class: 'linky', onclick: () => financeSetup(entry, true) }, plaid?.client ? 'Use a different Plaid app' : 'Use a different SimpleFIN token, or Plaid instead'),
            ]
        : entry.signIn === 'x'
          ? [
              h('p', { class: 'hint' }, 'You’ll sign in with X and come straight back. Polyphemus runs its own X server on this computer and hands it two hours’ access at a time — never your password, refresh token or app secret.'),
              h('ul', { class: 'steps-list' }, [
                'It can post, reply and delete posts as you, and read your own posts and mentions. Nothing else: no DMs, follows, likes or reposts.',
                'Posting and deleting are separate tools from reading: grant a project only what it needs, and they ask first in Ask mode.',
                'Reading posts and mentions needs an X API plan that includes reads; on the free plan, expect posting only.',
              ].map((t) => h('li', {}, t))),
              h('button', { class: 'linky', onclick: () => xClientSetup(entry, xApp.callback, true) }, 'Use a different X app'),
            ]
        : entry.signIn === 'none' && !entry.builtin
          ? h('p', { class: 'hint' }, `${entry.name} is open: no account, nothing to sign in to. Once it’s connected, grant it to a project and agents there can use it.`)
        : entry.builtin === 'computer'
          ? h('p', { class: 'hint' }, 'Nothing to sign in to: each agent gets a Linux desktop of its own, in a container on this computer, reaching public sites only through polyphemus’s proxy. Grant it to an agent (or a project) and that agent can look, click, type and run commands on its own computer — never another’s. The simplest way: turn on “can use it” on an agent’s page.')
        : entry.signIn === 'none'
          ? [
              h('p', { class: 'hint' }, 'Nothing to sign in to: polyphemus runs Chrome on this computer, headless. Once it’s connected, grant it to a project, and agents there can use it.'),
              h('ul', { class: 'steps-list' }, [
                'Only public web pages. Nothing on this computer, your home or office network, or your tailnet — every request a page makes is checked.',
                'A fresh browser for each thread. It’s signed in only where you sign in by hand and keep it, for projects you pick. No downloads or uploads.',
                'Reading is one grant; clicking and typing are separate tools, and ask first in Ask mode.',
                'What a page says is passed to the agent as the web’s words, not instructions. Treat pages as untrusted anyway: grant it where you’d let an agent read the web.',
              ].map((line) => h('li', {}, line))),
            ]
          : entry.signIn === 'oauth'
          ? h('p', { class: 'hint' }, `You’ll sign in at ${entry.name} and come straight back. Polyphemus keeps the tokens in your vault and refreshes them itself; no model or agent ever sees them.`)
          : [
              sec('Make a token'),
              h('ol', { class: 'steps-list' }, entry.token.steps.map((step) => h('li', {}, step))),
              h('a', { class: 'btn wide', href: entry.token.where, target: '_blank', rel: 'noopener noreferrer' }, `Open ${entry.name}’s token page`),
              h('label', { class: 'field' }, h('span', {}, 'Paste it'), token),
            ],
      connect,
      h('p', { class: 'hint' }, entry.url ? `Its MCP server: ${entry.url}. Checked ${entry.checked}.` : entry.builtin ? 'Needs Chrome or Chromium on this computer.' : `Read-only. Checked ${entry.checked}.`),
    ],
    { mainClass: 'plain' },
  );
}

/**
 * GitHub, the recommended way: an identity of polyphemus's own. Pick a role, and where it lives; GitHub
 * creates the app from polyphemus's description, you pick repositories, and you're back. It acts as its own
 * bot, with tokens that last an hour, and no identity merges work only it approved.
 */
function githubIdentityScreen(entry) {
  const roles = [
    ['planner', 'Planner', 'Writes specs on a branch, opens spec pull requests, creates and labels issues. Merges its spec PRs once another identity approves them.'],
    ['builder', 'Builder', 'Pushes code branches, opens and updates pull requests. Can’t approve its own work.'],
    ['reviewer', 'Reviewer', 'Reads code, reviews and approves pull requests. polyphemus gives it no way to push.'],
  ];
  let role = 'builder';
  let where = 'account';
  const roleButtons = roles.map(([id, title, does]) => {
    const b = h('button', { type: 'button', class: 'choice', 'aria-pressed': String(id === role) }, h('span', { class: 'radio' }), h('span', {}, h('b', {}, title), h('small', {}, does)));
    b.addEventListener('click', () => {
      role = id;
      for (const [i, other] of roleButtons.entries()) other.setAttribute('aria-pressed', String(roles[i][0] === role));
    });
    return b;
  });
  const org = h('input', { id: 'github-org', placeholder: 'your-org', autocapitalize: 'none', spellcheck: 'false', autocomplete: 'off', hidden: true });
  const places = h('div', { class: 'segmented' });
  const mine = h('button', { type: 'button', 'aria-pressed': 'true' }, 'My account');
  const orgButton = h('button', { type: 'button', 'aria-pressed': 'false' }, 'An organization');
  mine.addEventListener('click', () => ((where = 'account'), mine.setAttribute('aria-pressed', 'true'), orgButton.setAttribute('aria-pressed', 'false'), (org.hidden = true)));
  orgButton.addEventListener('click', () => ((where = 'org'), mine.setAttribute('aria-pressed', 'false'), orgButton.setAttribute('aria-pressed', 'true'), (org.hidden = false), org.focus()));
  places.append(mine, orgButton);
  const create = h('button', { class: 'btn primary wide' }, 'Create it on GitHub');
  create.addEventListener('click', async () => {
    if (where === 'org' && !org.value.trim()) return org.focus();
    create.disabled = true;
    try {
      const { action, manifest } = await api('/api/connections/github-app', { role, ...(where === 'org' && { org: org.value.trim() }) });
      // GitHub's manifest flow takes the description as a form post, from your browser.
      const form = h('form', { method: 'post', action, hidden: true }, h('input', { type: 'hidden', name: 'manifest', value: manifest }));
      document.body.append(form);
      form.submit();
    } catch (err) {
      create.disabled = false;
      showError(err);
    }
  });
  screen(
    bar(backButton(), h('div', { class: 'pill' }, serviceTile(entry, 30), h('span', {}, 'GitHub'))),
    [
      h('p', { class: 'lead-line' }, 'An identity of polyphemus’s own on GitHub: its own bot, on repositories you pick, with tokens that last an hour. Make one per role, and grant each to the projects or agents that should act as it.'),
      h('div', { class: 'field' }, h('span', {}, 'Its role'), h('div', { class: 'choices' }, roleButtons)),
      h('div', { class: 'field' }, h('span', {}, 'Where it lives'), places, org),
      create,
      h('p', { class: 'hint' }, 'GitHub opens with the app already described — its name, what it may do, where to come back. Click Create, choose repositories, and you’re back here. Its private key stays in your vault.'),
      h('div', { class: 'note' }, 'So no identity merges work only it approved: on each repository, add a branch rule that requires a pull request with one approval. GitHub never lets an author approve their own.'),
      h('button', { class: 'linky', onclick: () => go('#/connections/new?service=github&with=token') }, 'Or connect with a token of yours (acts as you)'),
    ],
    { mainClass: 'plain' },
  );
}

/**
 * Google doesn't let apps register themselves, so the first Google connection starts with making a
 * sign-in client of your own, once. Every step says where to click, and the return address to paste
 * is shown exactly as Google needs it.
 */
function googleClientSetup(entry, callback, replacing = false) {
  const clientId = h('input', { id: 'google-client-id', placeholder: '1234-abc.apps.googleusercontent.com', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'none' });
  const clientSecret = h('input', { id: 'google-client-secret', type: 'password', placeholder: 'GOCSPX-…', autocomplete: 'off', spellcheck: 'false' });
  const service = entry.google === 'gmail' ? 'gmail' : 'drive';
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
  const copy = h('button', { class: 'btn small', onclick: async () => {
    try {
      await navigator.clipboard.writeText(callback);
      toast('Copied.');
    } catch {
      toast('Couldn’t copy: select it and copy it yourself.', 'error');
    }
  } }, 'Copy');
  const save = h('button', { class: 'btn primary wide' }, 'Save and continue');
  save.addEventListener('click', async () => {
    if (!clientId.value.trim()) return clientId.focus();
    if (!clientSecret.value.trim()) return clientSecret.focus();
    save.disabled = true;
    try {
      await api('/api/connections/google-client', { clientId: clientId.value, clientSecret: clientSecret.value });
      toast('Your Google client is saved.');
      connectionCatalogueScreen(entry.id);
    } catch (err) {
      save.disabled = false;
      showError(err);
    }
  });
  screen(
    bar(backButton(), h('div', { class: 'pill' }, serviceTile(entry, 30), h('span', {}, replacing ? 'Your Google client' : `Set up ${entry.name}`))),
    [
      h('p', { class: 'lead-line' }, replacing ? 'Replace the Google client every Google connection signs in with.' : 'Google needs a sign-in client of your own before polyphemus can connect. It takes about five minutes, once — Drive and Gmail share it.'),
      h(
        'ol',
        { class: 'steps-list' },
        h('li', {}, link('https://console.cloud.google.com/projectcreate', 'Create a Google Cloud project'), ' (or pick one you have). Call it polyphemus.'),
        h('li', {}, link(`https://console.cloud.google.com/apis/library/${service}.googleapis.com`, `Enable the ${entry.google === 'gmail' ? 'Gmail' : 'Google Drive'} API`), ' in that project. Enable the other one too if you’ll connect both.'),
        h('li', {}, link('https://console.cloud.google.com/auth/overview', 'Set up Google Auth Platform'), ': app name polyphemus, your email for support. Audience: External. Under Audience, add yourself as a test user.'),
        h('li', {}, link('https://console.cloud.google.com/auth/clients/create', 'Create a client'), ': type Web application. Under Authorized redirect URIs, add exactly this address:'),
      ),
      h('div', { class: 'callback-line' }, h('code', {}, callback), copy),
      h('p', { class: 'hint' }, 'It’s the address you’re using polyphemus at now. Google only sends you back to addresses you list, so if you use polyphemus from another address, add that one too.'),
      h('ol', { class: 'steps-list', start: 5 }, h('li', {}, 'Copy the client ID and client secret Google shows you, and paste them here.')),
      h('label', { class: 'field' }, h('span', {}, 'Client ID'), clientId),
      h('label', { class: 'field' }, h('span', {}, 'Client secret'), clientSecret),
      save,
      h('p', { class: 'hint' }, 'They go to your vault, shared by every Google connection. While the app is in testing, Google asks you to confirm each sign-in and only lets in the test users you listed — that’s expected.'),
    ],
    { mainClass: 'plain' },
  );
}

/**
 * X doesn't let apps register themselves either, so the X connection starts with an app of your own at
 * developer.x.com, once. The return address to paste is shown exactly as X needs it.
 */
function xClientSetup(entry, callback, replacing = false) {
  const clientId = h('input', { id: 'x-client-id', placeholder: 'OAuth 2.0 Client ID', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'none' });
  const clientSecret = h('input', { id: 'x-client-secret', type: 'password', placeholder: 'Only if X showed you one', autocomplete: 'off', spellcheck: 'false' });
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
  const copy = h('button', { class: 'btn small', onclick: async () => {
    try {
      await navigator.clipboard.writeText(callback);
      toast('Copied.');
    } catch {
      toast('Couldn’t copy: select it and copy it yourself.', 'error');
    }
  } }, 'Copy');
  const save = h('button', { class: 'btn primary wide' }, 'Save and continue');
  save.addEventListener('click', async () => {
    if (!clientId.value.trim()) return clientId.focus();
    save.disabled = true;
    try {
      await api('/api/connections/x-client', { clientId: clientId.value, ...(clientSecret.value.trim() && { clientSecret: clientSecret.value }) });
      toast('Your X app is saved.');
      connectionCatalogueScreen(entry.id);
    } catch (err) {
      save.disabled = false;
      showError(err);
    }
  });
  screen(
    bar(backButton(), h('div', { class: 'pill' }, serviceTile(entry, 30), h('span', {}, replacing ? 'Your X app' : `Set up ${entry.name}`))),
    [
      h('p', { class: 'lead-line' }, replacing ? 'Replace the X app the X connection signs in with.' : 'X needs an app of your own before polyphemus can connect. It takes a few minutes, once.'),
      h(
        'ol',
        { class: 'steps-list' },
        h('li', {}, link('https://console.x.com', 'Open the X Developer Console'), ', sign up if you haven’t, and open your app under Apps (make one if there’s none).'),
        h('li', {}, 'Open its Authentication settings (from the app’s Keys page). App permissions: Read and write. Type of App: Web App, Automated App or Bot.'),
        h('li', {}, 'Under Callback URI / Redirect URL, add exactly this address. For Website URL, any page of yours will do:'),
      ),
      h('div', { class: 'callback-line' }, h('code', {}, callback), copy),
      h('p', { class: 'hint' }, 'It’s the address you’re using polyphemus at now. X only sends you back to addresses you list, so if you use polyphemus from another address, add that one too.'),
      h('ol', { class: 'steps-list', start: 4 }, h('li', {}, 'Save Changes, then Back to Keys: copy the OAuth 2.0 Client ID and Client Secret and paste both here — not the API Key or Access Token, and not in a thread. X may show the secret only once.')),
      h('label', { class: 'field' }, h('span', {}, 'Client ID'), clientId),
      h('label', { class: 'field' }, h('span', {}, 'Client secret'), clientSecret),
      save,
      h('p', { class: 'hint' }, 'They go to your vault. Nobody and nothing in polyphemus sees them again: X’s sign-in happens in your browser.'),
    ],
    { mainClass: 'plain' },
  );
}

/**
 * Finance reads your banks two ways, and you pick one. SimpleFIN is a consumer service: link your banks
 * there, paste one token, done. Plaid is the developer product: an app of your own, keys, and approval
 * before real banks — more setup, more banks, and investments and bills as well.
 */
function financeSetup(entry, replacing = false) {
  const ways = [
    { id: 'simplefin', title: 'SimpleFIN', sub: 'Paste one token. No developer account, about $15 a year, read-only. Accounts, balances and transactions.' },
    { id: 'plaid', title: 'Plaid', sub: 'An app of your own and its keys. Sandbox is Plaid’s fake banks; your own need Production access, which Plaid approves. Adds investments and bills.' },
  ];
  screen(
    bar(backButton(), h('div', { class: 'pill' }, serviceTile(entry, 30), h('span', {}, 'Set up Finance'))),
    [
      h('p', { class: 'lead-line' }, 'Two ways to reach your banks. Either way it’s read-only, and what polyphemus keeps stays in your vault on this computer.'),
      h('div', { class: 'choices' }, ways.map((way) =>
        h('button', { type: 'button', class: 'choice chevroned', onclick: () => (way.id === 'plaid' ? plaidAppSetup(entry, replacing) : simplefinSetup(entry, replacing)) },
          h('span', { class: 'radio' }),
          h('span', {}, h('b', {}, way.title), h('small', {}, way.sub))),
      )),
    ],
    { mainClass: 'plain' },
  );
}

/** SimpleFIN: the whole setup is one token, claimed once. */
function simplefinSetup(entry, replacing = false) {
  const token = h('textarea', { id: 'simplefin-token', rows: 3, class: 'mono', placeholder: 'the long base64 token from SimpleFIN', spellcheck: 'false', autocapitalize: 'none' });
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
  const save = h('button', { class: 'btn primary wide' }, 'Claim it');
  save.addEventListener('click', async () => {
    if (!token.value.trim()) return token.focus();
    save.disabled = true;
    try {
      await api('/api/connections/simplefin', { token: token.value });
      toast('SimpleFIN is set up.');
      connectionCatalogueScreen(entry.id);
    } catch (err) {
      save.disabled = false;
      showError(err);
    }
  });
  screen(
    bar(backButton(), h('div', { class: 'pill' }, serviceTile(entry, 30), h('span', {}, replacing ? 'Your SimpleFIN token' : 'Set up Finance'))),
    [
      h('p', { class: 'lead-line' }, 'SimpleFIN links your banks for you and hands you one token. No developer account, nothing to be approved for.'),
      h(
        'ol',
        { class: 'steps-list' },
        h('li', {}, link('https://beta-bridge.simplefin.org/', 'Open SimpleFIN Bridge'), ' and make an account (about $15 a year).'),
        h('li', {}, 'Connect your banks there, then choose Create a Setup Token — it’s one long string, and it works once.'),
        h('li', {}, 'Paste it here. Polyphemus trades it for a read-only address and keeps that in your vault.'),
      ),
      h('label', { class: 'field' }, h('span', {}, 'Setup token'), token),
      save,
      h('p', { class: 'hint' }, 'SimpleFIN is read-only by design: the protocol has no way to move money. Polyphemus reads accounts, balances and transactions; for investments and bills, use Plaid instead.'),
      h('button', { class: 'linky', onclick: () => plaidAppSetup(entry, replacing) }, 'Use Plaid instead'),
    ],
    { mainClass: 'plain' },
  );
}

/**
 * Finance through Plaid needs an app of your own, once: Plaid's keys are per developer account, and per
 * environment (Sandbox is free and fake; Production is real banks, after Plaid approves you).
 */
function plaidAppSetup(entry, replacing = false) {
  const clientId = h('input', { id: 'plaid-client-id', placeholder: 'client_id', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'none' });
  const secret = h('input', { id: 'plaid-secret', type: 'password', placeholder: 'the secret for that environment', autocomplete: 'off', spellcheck: 'false' });
  let environment = 'sandbox';
  const envButtons = [['sandbox', 'Sandbox'], ['production', 'Production']].map(([id, label]) => h('button', { type: 'button', 'aria-pressed': String(id === environment) }, label));
  envButtons.forEach((button, i) =>
    button.addEventListener('click', () => {
      environment = ['sandbox', 'production'][i];
      envButtons.forEach((b, n) => b.setAttribute('aria-pressed', String(n === i)));
    }),
  );
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
  const save = h('button', { class: 'btn primary wide' }, 'Save and continue');
  save.addEventListener('click', async () => {
    if (!clientId.value.trim()) return clientId.focus();
    if (!secret.value.trim()) return secret.focus();
    save.disabled = true;
    try {
      await api('/api/connections/plaid-app', { clientId: clientId.value, secret: secret.value, environment });
      toast('Your Plaid app is saved.');
      connectionCatalogueScreen(entry.id);
    } catch (err) {
      save.disabled = false;
      showError(err);
    }
  });
  screen(
    bar(backButton(), h('div', { class: 'pill' }, serviceTile(entry, 30), h('span', {}, replacing ? 'Your Plaid app' : 'Set up Finance'))),
    [
      h('p', { class: 'lead-line' }, replacing ? 'Replace the Plaid app polyphemus links banks with.' : 'Finance reads your accounts through Plaid, which needs an app of your own. Sandbox works straight away with fake banks; real banks need Plaid to approve your account.'),
      h(
        'ol',
        { class: 'steps-list' },
        h('li', {}, link('https://dashboard.plaid.com/signup', 'Make a Plaid account'), ' (free), or sign in to the one you have.'),
        h('li', {}, 'Open ', link('https://dashboard.plaid.com/developers/keys', 'Developers → Keys'), ': copy the client_id, and the secret for the environment you want.'),
        h('li', {}, 'Sandbox has only Plaid’s test banks (First Platypus Bank and friends), not yours: sign in with user_good / pass_good. For your own accounts, ask Plaid for Production access in the dashboard, then paste the Production secret here.'),
      ),
      h('div', { class: 'field' }, h('span', {}, 'Environment'), h('div', { class: 'segmented' }, envButtons)),
      h('label', { class: 'field' }, h('span', {}, 'Client ID'), clientId),
      h('label', { class: 'field' }, h('span', {}, 'Secret'), secret),
      save,
      h('p', { class: 'hint' }, 'They go to your vault on this computer. Polyphemus talks to Plaid itself: no model, agent or server is handed these, or the banks you link.'),
      h('button', { class: 'linky', onclick: () => simplefinSetup(entry, replacing) }, 'Use SimpleFIN instead — one token, no developer account'),
    ],
    { mainClass: 'plain' },
  );
}

function addConnectionScreen() {
  if (!isOwner()) return location.replace('#/connections');
  let kind = 'http';
  let signIn = 'oauth';
  const name = h('input', { id: 'conn-name', placeholder: 'Ledger', autocomplete: 'off' });
  const command = h('input', { id: 'conn-command', placeholder: 'npx -y @hubspot/mcp-server', autocapitalize: 'none', spellcheck: 'false', autocomplete: 'off' });
  const url = h('input', { id: 'conn-url', placeholder: 'https://app.example.com', autocapitalize: 'none', spellcheck: 'false', autocomplete: 'off', inputmode: 'url' });
  const found = h('small', { class: 'hint' }, 'Its address, or just the site: polyphemus looks for how it signs in.');
  const token = h('input', { id: 'conn-token', type: 'password', placeholder: 'Paste the key or token', autocomplete: 'off', spellcheck: 'false' });

  // Remote: how it signs in. Detected from the address when the service says; otherwise your choice.
  const ways = h('div', { class: 'segmented' });
  const tokenField = h('label', { class: 'field', hidden: true }, h('span', {}, 'API key or token'), token, h('small', { class: 'hint' }, 'Sent to the server as a bearer token. Goes to your vault; polyphemus never shows it again.'));
  const oauthNote = h('p', { class: 'hint' }, 'You’ll sign in at the service next, and come straight back here. Polyphemus keeps the tokens in your vault and refreshes them itself.');
  const pickWay = (next) => {
    signIn = next;
    for (const b of ways.children) b.setAttribute('aria-pressed', String(b.dataset.way === signIn));
    tokenField.hidden = signIn !== 'token';
    oauthNote.hidden = signIn !== 'oauth';
    submit.textContent = signIn === 'oauth' ? 'Continue to sign in' : 'Connect and test';
  };
  ways.append(
    h('button', { type: 'button', 'data-way': 'oauth', 'aria-pressed': 'true', onclick: () => pickWay('oauth') }, 'Sign in'),
    h('button', { type: 'button', 'data-way': 'token', 'aria-pressed': 'false', onclick: () => pickWay('token') }, 'Key or token'),
    h('button', { type: 'button', 'data-way': 'none', 'aria-pressed': 'false', onclick: () => pickWay('none') }, 'Nothing'),
  );
  let checked = '';
  const check = async () => {
    const address = url.value.trim();
    if (!address || address === checked) return;
    checked = address;
    found.textContent = 'Looking for how it signs in…';
    try {
      const withScheme = /^https?:\/\//.test(address) ? address : `https://${address}`;
      const answer = await api(`/api/connections/discover?url=${encodeURIComponent(withScheme)}`);
      if (url.value.trim() !== address) return;
      if (answer.oauth) {
        url.value = answer.url;
        checked = answer.url;
        if (!name.value.trim()) name.value = (answer.host.split(/[.-]/).find((part) => !/^(www|app|api|mcp|staging|dev|test|beta|auth)$/i.test(part)) ?? answer.host).replace(/^\w/, (c) => c.toUpperCase());
        found.textContent = `It signs in with OAuth at ${answer.host}${answer.scopes.length ? `, asking for ${answer.scopes.join(', ')}` : ''}. Its MCP server is at the address above.`;
        pickWay('oauth');
      } else {
        found.textContent = 'It didn’t say how it signs in. If it gave you a key or token, use that.';
        pickWay('token');
      }
    } catch (err) {
      found.textContent = err.message;
    }
  };
  url.addEventListener('blur', check);
  url.addEventListener('keydown', (e) => e.key === 'Enter' && check());

  const remote = h('div', {}, h('label', { class: 'field' }, h('span', {}, 'Where it is'), url, found), h('div', { class: 'field' }, h('span', {}, 'How it signs in'), ways), tokenField, oauthNote);

  // On this computer: a command, and whatever credentials it reads from its environment.
  const secretRows = h('div', { class: 'secret-rows' });
  const addSecret = () =>
    secretRows.append(
      h(
        'div',
        { class: 'secret-row' },
        h('input', { placeholder: 'HUBSPOT_TOKEN', 'aria-label': 'Name', autocapitalize: 'characters', spellcheck: 'false', autocomplete: 'off' }),
        h('input', { type: 'password', placeholder: 'Value', 'aria-label': 'Value', autocomplete: 'off', spellcheck: 'false' }),
      ),
    );
  addSecret();
  const local = h(
    'div',
    { hidden: true },
    h('label', { class: 'field' }, h('span', {}, 'Command that starts its server'), command, h('small', { class: 'hint' }, 'It runs on the computer polyphemus runs on.')),
    h('div', { class: 'field' }, h('span', {}, 'Credentials it reads'), secretRows, h('button', { type: 'button', class: 'linky', onclick: addSecret }, 'Add another'), h('small', { class: 'hint' }, 'Passed to the server as environment variables — its instructions say their names. Values go to your vault.')),
  );

  const kinds = h('div', { class: 'segmented' });
  const pickKind = (next) => {
    kind = next;
    for (const b of kinds.children) b.setAttribute('aria-pressed', String(b.dataset.kind === kind));
    local.hidden = kind !== 'stdio';
    remote.hidden = kind !== 'http';
    submit.textContent = kind === 'http' && signIn === 'oauth' ? 'Continue to sign in' : 'Connect and test';
  };
  kinds.append(
    h('button', { type: 'button', 'data-kind': 'http', 'aria-pressed': 'true', onclick: () => pickKind('http') }, 'A web address'),
    h('button', { type: 'button', 'data-kind': 'stdio', 'aria-pressed': 'false', onclick: () => pickKind('stdio') }, 'On this computer'),
  );
  const owner = h('select', { id: 'conn-owner' }, (state.people ?? []).map((p) => h('option', { value: p.id, selected: p.id === state.me?.id }, p.id === state.me?.id ? `${p.name} (you)` : p.name)));
  const submit = h('button', { class: 'btn primary wide' }, 'Continue to sign in');
  submit.addEventListener('click', async () => {
    if (kind === 'http' && !url.value.trim()) return url.focus();
    if (kind === 'http') await check();
    if (!name.value.trim()) return name.focus();
    const body = { name: name.value.trim(), kind, owner: owner.value };
    if (kind === 'http') {
      body.url = /^https?:\/\//.test(url.value.trim()) ? url.value.trim() : `https://${url.value.trim()}`;
      if (signIn === 'oauth') body.auth = 'oauth';
      if (signIn === 'token') {
        if (!token.value) return token.focus();
        body.secrets = { TOKEN: token.value };
      }
    } else {
      const [cmd, ...args] = command.value.trim().split(/\s+/);
      if (!cmd) return command.focus();
      Object.assign(body, { command: cmd, args, secrets: Object.fromEntries([...secretRows.children].map((row) => [...row.querySelectorAll('input')].map((i) => i.value.trim())).filter(([k, v]) => k && v)) });
    }
    submit.disabled = true;
    submit.textContent = signIn === 'oauth' && kind === 'http' ? 'Opening sign-in…' : 'Connecting…';
    try {
      const { connection, authorizeUrl, problem } = await api('/api/connections', body);
      if (authorizeUrl) return location.assign(authorizeUrl);
      await refresh();
      if (problem) toast(problem, 'error');
      else toast(connection.health === 'ok' ? `${connection.name} connected: it offers ${toolsSummary(connection.tools)}.` : `${connection.name} added, but it isn’t working yet.`);
      location.replace(`#/connections/${encodeURIComponent(connection.id)}`);
    } catch (err) {
      showError(err);
      submit.disabled = false;
      pickKind(kind);
    }
  });
  screen(
    bar(backButton(), title('Connect a service')),
    [
      h('div', { class: 'field' }, h('span', {}, 'Its MCP server is'), kinds),
      remote,
      local,
      h('label', { class: 'field' }, h('span', {}, 'Called'), name),
      h('label', { class: 'field' }, h('span', {}, 'Whose account it is'), owner, h('small', { class: 'hint' }, 'They’re asked to fix it when it stops working, and they say what its credential can do.')),
      submit,
      h('p', { class: 'hint' }, 'Nothing can use it until you grant it to a project. No model or agent ever sees its credentials.'),
    ],
    { mainClass: 'plain' },
  );
}

async function connectionScreen(id) {
  let data;
  try {
    data = await api(`/api/connections/${encodeURIComponent(id)}`);
  } catch (err) {
    showError(err);
    return location.replace('#/connections');
  }
  const { connection: c, activity } = data;
  const act = (path, body, done) => async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await api(`/api/connections/${encodeURIComponent(c.id)}/${path}`, body ?? {});
      await refresh();
      if (done) toast(done(result));
      if (view.name === 'connection') connectionScreen(c.id);
    } catch (err) {
      button.disabled = false;
      showError(err);
    }
  };

  // Reconnect: a new value for each credential it has, then a test.
  const reconnectForm = h(
    'div',
    { class: 'key-form', hidden: true },
    (c.secrets.length ? c.secrets : ['TOKEN']).map((k) => h('input', { type: 'password', 'data-secret': k, placeholder: `New ${k}`, 'aria-label': `New ${k}`, autocomplete: 'off', spellcheck: 'false' })),
  );
  const saveReconnect = h('button', { class: 'btn small primary' }, 'Save and test');
  saveReconnect.addEventListener('click', (e) => {
    const secrets = Object.fromEntries([...reconnectForm.querySelectorAll('input')].filter((i) => i.value).map((i) => [i.dataset.secret, i.value]));
    return act('reconnect', { secrets }, (r) => (r.connection.health === 'ok' ? `${c.name} is working.` : `Still not working: ${r.connection.error}`))(e);
  });
  reconnectForm.append(saveReconnect);
  const reconnect = h('button', { class: `btn small ${c.health === 'failing' || c.signedIn === false ? 'primary' : ''}` }, c.auth === 'oauth' ? (c.signedIn ? 'Sign in again' : 'Sign in') : 'Reconnect');
  reconnect.addEventListener('click', async () => {
    if (c.auth === 'oauth') {
      reconnect.disabled = true;
      try {
        const { authorizeUrl } = await api(`/api/connections/${encodeURIComponent(c.id)}/signin`, {});
        return location.assign(authorizeUrl);
      } catch (err) {
        reconnect.disabled = false;
        return showError(err);
      }
    }
    reconnectForm.hidden = false;
    reconnect.remove();
    reconnectForm.querySelector('input')?.focus();
  });
  const disconnect = h('button', { class: 'btn small danger' }, 'Disconnect');
  disconnect.addEventListener('click', async (e) => {
    const granted = [...new Set(c.grants.map((g) => g.projectName))];
    if (!(await confirmSheet(`Disconnect ${c.name}?`, [
      granted.length ? `${granted.join(', ')} ${granted.length === 1 ? 'loses' : 'lose'} it straight away.` : 'Nothing is granted it.',
      'Its saved credentials are deleted; its activity is kept.',
      ...((c.alsoForgets ?? []).length ? [`This also forgets ${c.alsoForgets.join(' and ')}.`] : []),
    ], { yes: 'Disconnect', danger: true }))) return;
    // The click is over by the time the sheet is answered, so the button is named rather than read from it.
    void e;
    await act('disconnect', {}, () => `${c.name} disconnected.`)({ currentTarget: disconnect });
    location.replace('#/connections');
  });

  const head = h(
    'section',
    { class: 'provider' },
    h(
      'div',
      { class: 'provider-head' },
      connectionMark(c),
      h(
        'div',
        { class: 'row-main' },
        h('span', { class: 'chip-line' }, h('b', {}, c.name), h('span', { class: `tag ${HEALTH[c.health][0]}` }, HEALTH[c.health][1])),
        h('span', { class: 'meta' }, [`Owned by ${c.owner.you ? 'you' : c.owner.name}`, c.healthAt ? `${c.health === 'failing' ? 'failed' : 'checked'} ${agoWords(c.healthAt)}` : null].filter(Boolean).join(' · ')),
      ),
    ),
    h(
      'div',
      { class: 'method' },
      c.health === 'failing'
        ? h(
            'div',
            { class: 'note bad' },
            h('b', {}, c.errorKind === 'auth' ? 'Its credential was refused. ' : 'It can’t be reached. '),
            c.error ?? '',
            c.errorSession ? [' · during ', h('button', { class: 'linky inline', onclick: () => go(`#/s/${c.errorSession.id}`) }, c.errorSession.title)] : null,
          )
        : null,
      c.where ? h('div', { class: 'meta mono' }, c.where) : null,
      c.github
        ? [
            h('div', { class: 'meta' }, `${c.github.roleTitle}: ${c.github.does}`),
            c.github.app ? h('div', { class: 'meta' }, 'On GitHub as ', h('a', { href: c.github.app.url, target: '_blank', rel: 'noopener noreferrer' }, c.github.app.name), c.github.app.owner ? ` · ${c.github.app.owner}` : '') : null,
            c.github.installed
              ? h('a', { class: 'linky', href: c.github.manageUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Change which repositories it’s on')
              : h('button', { class: 'btn small primary', onclick: async (event) => {
                  event.currentTarget.disabled = true;
                  try {
                    location.assign((await api(`/api/connections/${encodeURIComponent(c.id)}/github-install`, {})).url);
                  } catch (err) {
                    showError(err);
                  }
                } }, 'Install it on repositories'),
          ]
        : null,
      c.github ? null : c.auth === 'oauth'
        ? h('div', { class: 'meta' }, c.signedIn ? 'Signed in with OAuth · the tokens are in your vault, and polyphemus refreshes them' : 'Not signed in yet — nothing can reach it until someone who looks after it signs in.')
        : c.secrets.length ? h('div', { class: 'meta' }, `${c.secrets.join(', ')} saved in your vault`) : null,
      c.canManage ? h('div', { class: 'buttons' }, h('button', { class: 'btn small', onclick: act('test', {}, (r) => (r.connection.health === 'ok' ? `${c.name} is working: it offers ${toolsSummary(r.connection.tools)}.` : `Not working: ${r.connection.error}`)) }, 'Test'), c.github || c.kind === 'builtin' ? null : reconnect, disconnect) : null,
      c.canManage ? (c.github ? null : reconnectForm) : h('p', { class: 'hint tight' }, `${c.owner.name} looks after this connection.`),
    ),
  );

  // The ceiling, and how anyone knows it. Never "limited" when nobody checked.
  const ceiling = h(
    'div',
    { class: 'panel pad' },
    h('div', { class: 'chip-line' }, h('b', {}, 'The most its credential can do'), h('span', { class: `tag ${PROVENANCE[c.ceiling.provenance][0]}` }, PROVENANCE[c.ceiling.provenance][1])),
    h('p', { class: 'meta' }, c.ceiling.says),
    c.ceiling.provenance !== 'unknown' && c.ceiling.tools.length < c.tools.length ? h('p', { class: 'meta' }, `Within it: ${c.ceiling.tools.join(', ')}`) : null,
    c.canManage && c.tools.length && c.ceiling.provenance !== 'checked' ? h('div', { class: 'buttons' }, h('button', { class: 'btn small', onclick: () => declareSheet(c) }, c.ceiling.provenance === 'declared' ? 'Change what you declared' : 'Say what the credential can do')) : null,
  );

  const offers = h(
    'div',
    { class: 'card' },
    c.tools.length
      ? c.tools.map((t) => h('div', { class: 'item' }, h('span', { class: 'grow' }, h('span', { class: 'mono' }, t.name), t.description ? h('small', {}, t.description) : null), toolTag(t)))
      : h('p', { class: 'empty', style: 'padding:12px 14px' }, c.health === 'failing' ? 'Unknown until it works.' : 'It offers no tools.'),
  );

  const byProject = new Map();
  // A grant with no project is one an agent carries: it goes with the agent, not with a project.
  const carried = c.grants.filter((g) => !g.project && g.agent);
  for (const g of c.grants) {
    if (!g.project) continue;
    if (!byProject.has(g.project)) byProject.set(g.project, { project: null, agents: [] });
    if (g.agent) byProject.get(g.project).agents.push(g);
    else byProject.get(g.project).project = g;
  }
  const grants = [...byProject.values()].filter((x) => x.project).map(({ project: g, agents }) =>
    h(
      'div',
      { class: 'panel pad grant' },
      h('div', { class: 'chip-line' }, h('b', {}, g.projectName), h('span', { class: 'tag' }, toolsSummary(c.tools.filter((t) => g.tools.includes(t.name))))),
      h('p', { class: 'meta' }, `${g.tools.join(', ')} · granted by ${g.by} · ${agoWords(g.at)}`),
      h('p', { class: 'meta' }, agents.length ? 'Every agent there has this, except:' : 'Every agent there has this.'),
      agents.map((a) =>
        h(
          'div',
          { class: 'grant-agent' },
          h('span', { class: 'grow' }, h('b', {}, a.agentTitle), h('small', {}, ` only ${a.tools.join(', ')} · by ${a.by}`)),
          c.canGrant ? h('button', { class: 'btn small', onclick: () => grantSheet(c, { project: g.project, agent: a.agent }) }, 'Change') : null,
        ),
      ),
      c.canGrant
        ? h(
            'div',
            { class: 'buttons' },
            h('button', { class: 'btn small', onclick: () => grantSheet(c, { project: g.project }) }, 'Change'),
            h('button', { class: 'btn small', onclick: () => grantSheet(c, { project: g.project, agent: '' }) }, 'Narrow it for an agent'),
            h('button', { class: 'btn small danger', onclick: act('revoke', { project: g.project }, () => `${c.name} revoked from ${g.projectName}.`) }, 'Revoke'),
          )
        : null,
    ),
  );

  const carriedPanels = carried.map((g) =>
    h(
      'div',
      { class: 'panel pad grant' },
      h('div', { class: 'chip-line' }, h('b', {}, g.agentTitle), h('span', { class: 'tag' }, toolsSummary(c.tools.filter((t) => g.tools.includes(t.name))))),
      h('p', { class: 'meta' }, `${g.tools.join(', ')} · granted by ${g.by} · ${agoWords(g.at)}`),
      h('p', { class: 'meta' }, 'It carries this wherever it works, a direct thread with it included.'),
      c.canGrant
        ? h(
            'div',
            { class: 'buttons' },
            h('button', { class: 'btn small', onclick: () => grantSheet(c, { carry: true, agent: g.agent }) }, 'Change'),
            h('button', { class: 'btn small danger', onclick: act('revoke', { agent: g.agent }, () => `${c.name} taken back from ${g.agentTitle}.`) }, 'Revoke'),
          )
        : null,
    ),
  );

  const OUTCOME = { ok: ['good', 'Done'], refused: ['warn', 'Refused'], failed: ['bad', 'Failed'] };
  const log = activity.length
    ? h(
        'div',
        { class: 'card' },
        activity.map((a) =>
          h(
            'div',
            { class: 'item activity' },
            h(
              'span',
              { class: 'grow' },
              h('span', {}, h('span', { class: 'mono' }, a.tool), a.agent ? ` · ${a.agent}` : '', a.by ? ` for ${a.by}` : ''),
              a.session ? h('button', { class: 'linky inline', onclick: () => go(`#/s/${a.session.id}`) }, a.session.title) : h('small', {}, 'in a thread you can’t see'),
              a.detail ? h('small', {}, a.detail) : null,
            ),
            h('span', { class: 'activity-side' }, h('span', { class: `tag ${OUTCOME[a.outcome][0]}` }, OUTCOME[a.outcome][1]), h('small', {}, `${agoWords(a.at)}`)),
          ),
        ),
      )
    : h('p', { class: 'empty' }, 'Nothing yet.');

  screen(
    bar(backButton(), title(c.name)),
    [
      head,
      c.signIns ? signInsSection(c) : null,
      c.banks ? banksSection(c) : null,
      sec('What it may do'),
      ceiling,
      sec('Tools it offers', c.tools.length || ''),
      offers,
      sec('Granted to', grants.length + carriedPanels.length || ''),
      grants.length || carriedPanels.length ? [grants, carriedPanels] : h('p', { class: 'empty' }, 'Nothing yet. Nothing can use it until it’s granted to a project, or to an agent to carry.'),
      c.canGrant ? h('div', { class: 'buttons' }, h('button', { class: 'btn grow', onclick: () => grantSheet(c, {}) }, 'Grant to a project'), (state.agents ?? []).length ? h('button', { class: 'btn grow', onclick: () => grantSheet(c, { carry: true }) }, 'Grant to an agent') : null) : null,
      h('p', { class: 'hint' }, 'A grant to a project is for everyone working in it; a grant to an agent goes with that agent, direct threads included. A grant says what may happen at all — whether polyphemus asks before a call that changes something is separate, and turning asking off never widens a grant.'),

      sec('Recent activity'),
      log,
    ],
    { mainClass: 'plain' },
  );
}

/**
 * The browser's kept sign-ins: a person signs in to a site by hand, and agents' browsers in the projects
 * they pick start out signed in. A sign-in is its owner's: only they say where it's used.
 */
/** Which banks are open on the Finance page, and what each last said: kept across a re-render. */
const openBanks = new Set();
const bankAccounts = new Map();

/** A bank's accounts, under its row: what each is, and its balance — what's owed, for a card or loan. */
function bankAccountsPanel(c, bank) {
  const panel = h('div', { class: 'accounts' });
  const KIND = { depository: 'Cash', credit: 'Card', loan: 'Loan', investment: 'Investment', brokerage: 'Investment' };
  const draw = (known) => {
    fill(panel);
    if (!known) return panel.append(h('p', { class: 'meta' }, 'Asking Plaid…'));
    if (known.problem) return panel.append(h('p', { class: 'meta' }, known.problem));
    if (!known.accounts.length) return panel.append(h('p', { class: 'meta' }, 'Plaid lists no accounts here.'));
    for (const a of known.accounts) {
      const owed = a.type === 'credit' || a.type === 'loan';
      const cash = (n) => new Intl.NumberFormat(undefined, { style: 'currency', currency: a.currency }).format(n);
      // Plaid's subtype says it best (checking, credit card, 401k, mortgage); the type when there's none.
      const kind = a.subtype ? a.subtype[0].toUpperCase() + a.subtype.slice(1) : KIND[a.type] ?? a.type;
      const extra = !owed && a.available !== null && a.current !== null && a.available !== a.current ? `${cash(a.available)} available` : owed && a.current !== null ? 'owed' : '';
      panel.append(
        h(
          'div',
          { class: 'account' },
          h('span', { class: 'grow' }, h('b', {}, a.name, a.mask ? h('small', {}, ` ••${a.mask}`) : null), h('small', {}, kind)),
          h('span', { class: 'amount' }, h('b', {}, a.current === null ? '—' : cash(a.current)), extra ? h('small', {}, extra) : null),
        ),
      );
    }
  };
  draw(bankAccounts.get(bank.id));
  api(`/api/connections/${encodeURIComponent(c.id)}/plaid/accounts`, { bank: bank.id })
    .then((known) => {
      bankAccounts.set(bank.id, known);
      draw(known);
    })
    .catch((err) => draw({ accounts: [], problem: err.message }));
  return panel;
}

/** Finance: the banks linked through Plaid, and how to link or unlink one. */
function banksSection(c) {
  const linkBank = h('button', { class: 'btn small primary' }, 'Link a bank');
  linkBank.addEventListener('click', async () => {
    if (c.financeEnvironment === 'sandbox') {
      const go = await confirmSheet('This is Plaid’s Sandbox: the banks aren’t real', [
        'Sandbox has only Plaid’s test institutions — First Platypus Bank, Tartan Bank and the like. Your own bank isn’t there, and the phone step is fake.',
        'Sign in to one with user_good and pass_good to see how it works.',
        'For your real accounts: ask Plaid for Production access and paste those keys here, or use SimpleFIN instead — one token, no approval.',
      ], { yes: 'Open Sandbox anyway', no: 'Not now' });
      if (!go) return;
    }
    linkBank.disabled = true;
    try {
      const { url, linkToken } = await api(`/api/connections/${encodeURIComponent(c.id)}/plaid/link`, {});
      window.open(url, '_blank', 'noopener');
      const done = await confirmSheet('Linking a bank at Plaid', [
        'Finish signing in on the page that opened. Polyphemus is watching for the result, so banks appear here on their own — you can close that tab when Plaid is done.',
        'Tap below if you’d rather not wait.',
      ], { yes: 'Check now', no: 'Close' });
      const { linked } = await api(`/api/connections/${encodeURIComponent(c.id)}/plaid/finish`, { linkToken });
      if (done) toast(linked.length ? `Linked ${linked.map((b) => b.name).join(', ')}.` : 'Nothing back from Plaid yet — it appears here when it is.');
      connectionScreen(c.id);
    } catch (err) {
      linkBank.disabled = false;
      showError(err);
    }
  });
  const rows = c.banks.map((bank) => {
    const unlink = h('button', { class: 'btn small danger' }, 'Unlink');
    unlink.addEventListener('click', async () => {
      if (!(await confirmSheet(`Unlink ${bank.name}?`, ['polyphemus ends the link at Plaid too, and forgets its access token. Nothing that read it is affected otherwise.'], { yes: 'Unlink', danger: true }))) return;
      unlink.disabled = true;
      try {
        await api(`/api/connections/${encodeURIComponent(c.id)}/plaid/remove`, { bank: bank.id });
        toast(`${bank.name} unlinked.`);
        connectionScreen(c.id);
      } catch (err) {
        unlink.disabled = false;
        showError(err);
      }
    });
    // Plaid answers only for what a bank was consented for when it was linked. Widening it means
    // going back to Plaid, so the row says what it covers and offers that trip.
    const WORDS = { transactions: 'transactions', investments: 'investments', liabilities: 'cards, loans and mortgages', auth: 'account numbers', identity: 'who you are' };
    // Only what polyphemus reads: Plaid also reports products (identity_match, signal…) nobody here uses.
    const covers = bank.unknown
      ? 'Linked before polyphemus recorded what it covers'
      : `Covers ${bank.products.filter((p) => ['transactions', 'investments', 'liabilities'].includes(p)).map((p) => WORDS[p]).join(', ') || 'balances only'}`;
    const add = bank.missing?.length
      ? h('button', { class: 'btn small', onclick: async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            const { url } = await api(`/api/connections/${encodeURIComponent(c.id)}/plaid/consent`, { bank: bank.id });
            window.open(url, '_blank', 'noopener');
            await confirmSheet(`Adding ${bank.missing.map((p) => WORDS[p] ?? p).join(' and ')} at ${bank.name}`, [
              'Approve it on the page that opened. Polyphemus watches for the result, so this updates here on its own — you can close that tab when Plaid is done.',
            ], { yes: 'Check now', no: 'Close' });
            connectionScreen(c.id);
          } catch (err) {
            button.disabled = false;
            showError(err);
          }
        } }, 'Add investments and bills')
      : null;
    // Tapping the bank opens it to its accounts; the buttons beside it stay buttons.
    const wrap = h('div', { class: 'bank' });
    const toggle = h(
      'button',
      { class: 'row-main bank-toggle', 'aria-expanded': String(openBanks.has(bank.id)) },
      h('span', { class: 'row-top' }, h('b', {}, bank.name), icon('chev', 'ico mini')),
      h('span', { class: 'row-sub' }, h('span', { class: 'text' }, `Linked ${ago(bank.at)} ago · ${covers}`)),
    );
    toggle.addEventListener('click', () => {
      const open = !openBanks.has(bank.id);
      if (open) openBanks.add(bank.id);
      else openBanks.delete(bank.id);
      toggle.setAttribute('aria-expanded', String(open));
      wrap.querySelector('.accounts')?.remove();
      if (open) wrap.append(bankAccountsPanel(c, bank));
    });
    wrap.append(h('div', { class: 'row with-actions' }, icon('bank', 'ico'), toggle, h('div', { class: 'row-actions' }, add, unlink)));
    if (openBanks.has(bank.id)) wrap.append(bankAccountsPanel(c, bank));
    return wrap;
  });
  return [
    sec('Banks', c.banks.length || ''),
    c.financeEnvironment === 'sandbox'
      ? h('div', { class: 'note warn' }, 'Plaid Sandbox: test banks only, not your own. Ask Plaid for Production access and paste those keys, or use SimpleFIN — one token, no approval.')
      : null,
    h('div', { class: 'card' }, rows.length ? rows : h('p', { class: 'empty', style: 'padding:12px 14px' }, 'No bank linked yet.')),
    h('div', { class: 'buttons' }, linkBank),
    h('p', { class: 'hint tight' }, 'You sign in at Plaid’s own page; polyphemus never sees the bank’s password, and reads only balances, transactions, investments and bills. A bank answers for what you consented to at Plaid — a bank linked for transactions alone says so above, and “Add investments and bills” takes you back to Plaid to widen it.'),
    h('button', { class: 'linky', onclick: () => go(`#/connections/new?service=finance`) }, c.financeEnvironment === 'sandbox' ? 'Switch to Production keys, or to SimpleFIN' : 'Use different keys, or SimpleFIN'),
  ];
}

function signInsSection(c) {
  const rows = c.signIns.map((s) => {
    const used = s.projects.filter((p) => !p.heldBack);
    const held = s.projects.filter((p) => p.heldBack);
    const remove = async (event) => {
      const button = event.currentTarget;
      if (!(await confirmSheet(`Forget the sign-in to ${s.site}?`, [`Its cookies are deleted from the vault. Browsers already signed in with it start fresh on their next step${s.owner.you ? '' : `, and ${s.owner.name} will have to sign in again to use it`}.`, `You stay signed in at ${s.site} itself: sign out there to end the session.`], { yes: 'Forget it', danger: true }))) return;
      button.disabled = true;
      try {
        await api(`/api/connections/${encodeURIComponent(c.id)}/sign-ins/${s.id}/remove`, {});
        toast(`Forgot the sign-in to ${s.site}.`);
        connectionScreen(c.id);
      } catch (err) {
        button.disabled = false;
        showError(err);
      }
    };
    return h(
      'div',
      { class: 'panel pad' },
      h('div', { class: 'chip-line' }, h('b', {}, s.site), h('span', { class: `tag ${used.length ? 'good' : ''}` }, used.length ? 'In use' : 'Not used anywhere')),
      h('p', { class: 'meta' }, [s.owner.you ? 'Yours' : `${s.owner.name}’s`, `kept ${agoWords(s.updatedAt)}`, s.usedAt ? `last used ${agoWords(s.usedAt)}` : null].filter(Boolean).join(' · ')),
      used.length ? h('p', { class: 'meta' }, `Agents’ browsers in ${used.map((p) => p.name).join(', ')} start signed in.`) : null,
      held.map((p) => h('div', { class: 'note warn' }, h('b', {}, `Not used in ${p.name}: `), `${p.heldBack}.`)),
      h(
        'div',
        { class: 'buttons' },
        s.owner.you ? h('button', { class: 'btn small', onclick: () => signInProjectsSheet(c, s) }, 'Where it’s used') : null,
        s.owner.you ? h('button', { class: 'btn small', onclick: (e) => startSignIn(c, { url: `https://${s.site}`, signIn: s.id, button: e.currentTarget }) }, 'Sign in again') : null,
        h('button', { class: 'btn small danger', onclick: remove }, 'Forget'),
      ),
    );
  });
  const canSignIn = c.signInProjects.length > 0;
  return [
    sec('Sign-ins it keeps', rows.length || ''),
    rows.length ? rows : h('p', { class: 'empty' }, 'None. Agents’ browsers aren’t signed in anywhere.'),
    canSignIn ? h('button', { class: 'btn wide', onclick: () => signInAddressSheet(c) }, 'Sign in to a site') : null,
    h('p', { class: 'hint' }, canSignIn
      ? 'You sign in by hand, in a browser on polyphemus’s computer. Your password goes to the site and nowhere else; polyphemus keeps the cookies the site sets, in the vault. No agent sees either. A sign-in is used only in projects nobody but you can see into.'
      : 'Grant the browser to a project you work in, and you can keep a sign-in for agents there.'),
  ];
}

function signInAddressSheet(c) {
  const address = h('input', { type: 'url', placeholder: 'github.com/login', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', inputmode: 'url' });
  const open = h('button', { class: 'btn primary wide' }, 'Open it');
  const submit = () => (address.value.trim() ? startSignIn(c, { url: address.value.trim(), button: open }) : address.focus());
  open.addEventListener('click', submit);
  address.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  sheet('Sign in to a site', [
    h('p', { class: 'hint' }, 'The site’s sign-in page. It opens in a browser on polyphemus’s computer, shown here, and you sign in as you would anywhere.'),
    h('label', { class: 'field' }, h('span', {}, 'Address'), address),
    open,
  ]);
  address.focus();
}

async function startSignIn(c, { url, signIn, button }) {
  if (button) button.disabled = true;
  const main = document.querySelector('#content main') ?? document.body;
  try {
    const { live } = await api(`/api/connections/${encodeURIComponent(c.id)}/sign-ins`, { url, width: Math.min(main.clientWidth - 32, 1280), height: Math.round(Math.min(innerHeight * 0.62, 1000)), ...(signIn && { signIn }) });
    document.querySelector('.sheet-wrap')?.remove();
    go(`#/connections/${encodeURIComponent(c.id)}/live/${live}?site=${encodeURIComponent(url.replace(/^https?:\/\//, '').split('/')[0])}`);
  } catch (err) {
    if (button) button.disabled = false;
    showError(err);
  }
}

/** Which projects a sign-in is used in: the ones the browser is granted to, that you work in. */
function signInProjectsSheet(c, s, { justKept = false } = {}) {
  const picked = new Set(s.projects.map((p) => p.slug));
  const choices = c.signInProjects.map((p) => {
    const b = h('button', { type: 'button', class: 'choice check', 'aria-pressed': String(picked.has(p.slug)) }, h('span', { class: 'box' }), h('span', {}, h('b', {}, p.name)));
    b.addEventListener('click', () => {
      if (picked.has(p.slug)) picked.delete(p.slug);
      else picked.add(p.slug);
      b.setAttribute('aria-pressed', String(picked.has(p.slug)));
    });
    return b;
  });
  const save = h('button', { class: 'btn primary wide' }, 'Save');
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const { signIn } = await api(`/api/connections/${encodeURIComponent(c.id)}/sign-ins/${s.id}/projects`, { projects: [...picked] });
      document.querySelector('.sheet-wrap')?.remove();
      const held = signIn.projects.filter((p) => p.heldBack);
      toast(held.length ? `Saved. Not used in ${held.map((p) => p.name).join(', ')} while other people can see into it.` : signIn.projects.length ? `Agents’ browsers in ${signIn.projects.map((p) => p.name).join(', ')} are signed in to ${s.site}.` : `The sign-in to ${s.site} isn’t used anywhere.`);
      connectionScreen(c.id);
    } catch (err) {
      save.disabled = false;
      showError(err);
    }
  });
  sheet(justKept ? `Kept: ${s.site}` : `Where ${s.site} is used`, [
    h('p', { class: 'hint' }, 'Agents’ browsers in the projects you pick start out signed in, and can do anything you could there — in Ask mode, clicking and typing ask first. It’s held back in any project where someone besides you can see what agents do.'),
    h('div', { class: 'choices' }, choices),
    save,
  ]);
}

/**
 * Signing in by hand: a picture of a browser on polyphemus’s computer that you tap and type into. Only
 * you can see it. What you type goes to the page; polyphemus keeps the cookies, never the password.
 */
function liveSignInScreen(id, live, site, question = '') {
  const base = `/api/connections/${encodeURIComponent(id)}/live/${encodeURIComponent(live)}`;
  const shown = view;
  const still = () => view === shown;
  const picture = h('img', { class: 'live-view', tabindex: '0', alt: `The page, as the browser on polyphemus’s computer shows it. Click it, then type into it.` });
  const address = h('span', { class: 'meta mono grow' }, site || 'Opening…');
  const said = h('p', { class: 'hint tight', 'aria-live': 'polite' }, '');
  const typed = h('input', { type: 'text', placeholder: 'Type into the page', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Type into the page' });
  let busy = Promise.resolve();
  let closed = false;
  let touched = 0;

  const lost = () => {
    if (closed || !still()) return;
    closed = true;
    toast('That sign-in closed: it was idle, or polyphemus restarted. Start again.', 'error');
    location.replace(`#/connections/${encodeURIComponent(id)}`);
  };
  // One thing at a time, in order, and a fresh picture after each.
  const send = (body) => {
    touched = Date.now();
    busy = busy.then(async () => {
      try {
        await api(`${base}/input`, body);
      } catch (err) {
        if (/isn’t open any more/.test(err.message)) return lost();
        showError(err);
      }
      await frame();
    });
    return busy;
  };

  let lastUrl = null;
  async function frame() {
    if (closed || !still()) return;
    const res = await fetch(base, { cache: 'no-store' }).catch(() => null);
    if (!res) return;
    if (res.status === 404) return lost();
    if (!res.ok) return;
    const page = JSON.parse(decodeURIComponent(res.headers.get('x-page') ?? '%7B%7D'));
    const url = URL.createObjectURL(await res.blob());
    const old = picture.src;
    picture.src = url;
    if (old.startsWith('blob:')) URL.revokeObjectURL(old);
    if (page.url && page.url !== lastUrl) {
      lastUrl = page.url;
      address.textContent = page.url;
    }
    // A password field has focus: what's typed isn't shown on this screen either.
    typed.type = page.secret ? 'password' : 'text';
    typed.placeholder = page.secret ? 'Type the password' : 'Type into the page';
  }
  // Keep the picture moving: a page changes by itself (a redirect, a code arriving).
  (async function loop() {
    while (!closed && still()) {
      await busy;
      await frame();
      // Straight after something you did, the page is likely still changing: look sooner.
      await new Promise((r) => setTimeout(r, Date.now() - touched < 4000 ? 250 : 700));
    }
  })();

  // The pointer as the page would see one: moving it hovers, pressing and releasing where you pressed
  // clicks, and a double-click is a double-click. A tap used to be all there was, which made
  // checkboxes, menus and small targets a fight (2026-09-22).
  const at = (e) => {
    const box = picture.getBoundingClientRect();
    const scale = picture.naturalWidth / box.width;
    return { x: Math.round((e.clientX - box.left) * scale), y: Math.round((e.clientY - box.top) * scale) };
  };
  let moved = 0;
  picture.addEventListener('pointermove', (e) => {
    // Hover follows the pointer, at a rate a page can keep up with.
    if (!picture.naturalWidth || e.pointerType === 'touch' || Date.now() - moved < 70) return;
    moved = Date.now();
    send({ kind: 'move', ...at(e) });
  });
  picture.addEventListener('pointerdown', (e) => {
    if (!picture.naturalWidth) return;
    e.preventDefault();
    picture.focus({ preventScroll: true });
    send({ kind: 'down', ...at(e) });
  });
  picture.addEventListener('pointerup', (e) => {
    if (!picture.naturalWidth) return;
    send({ kind: 'up', ...at(e) });
  });
  picture.addEventListener('dblclick', (e) => {
    if (!picture.naturalWidth) return;
    e.preventDefault();
    send({ kind: 'double', ...at(e) });
  });
  picture.addEventListener('wheel', (e) => {
    e.preventDefault();
    send({ kind: 'scroll', dy: e.deltaY, ...(picture.naturalWidth ? at(e) : {}) });
  }, { passive: false });
  // With the page in focus, a keyboard types into it: no side box, and every key, with modifiers.
  const MODIFIERS = (e) => (e.altKey ? 1 : 0) + (e.ctrlKey ? 2 : 0) + (e.metaKey ? 4 : 0) + (e.shiftKey ? 8 : 0);
  picture.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && e.shiftKey) return; // leaving the picture stays possible
    e.preventDefault();
    send({ kind: 'press', key: e.key, modifiers: MODIFIERS(e) });
  });
  let touchY = null;
  picture.addEventListener('touchstart', (e) => (touchY = e.touches[0]?.clientY ?? null), { passive: true });
  picture.addEventListener('touchend', (e) => {
    const endY = e.changedTouches[0]?.clientY;
    if (touchY !== null && endY !== undefined && Math.abs(endY - touchY) > 30) send({ kind: 'scroll', dy: (touchY - endY) * 2 });
    touchY = null;
  });

  const typeIt = async (thenEnter) => {
    const text = typed.value;
    typed.value = '';
    if (text) await send({ kind: 'text', text });
    if (thenEnter) await send({ kind: 'key', key: 'Enter' });
  };
  typed.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    typeIt(true);
  });
  const key = (name, label = name) => h('button', { class: 'btn small', onclick: () => send({ kind: 'key', key: name }) }, label);
  // A phone-sized page fits a phone; a desktop-sized one is what some sign-ins (and their checkboxes)
  // are drawn for. Switching keeps the page and the sign-in in progress.
  let wide = false;
  const size = h('button', { class: 'btn small' }, 'Desktop size');
  size.addEventListener('click', async () => {
    wide = !wide;
    size.disabled = true;
    size.textContent = wide ? 'Phone size' : 'Desktop size';
    try {
      await api(`${base}/size`, wide ? { width: 1280, height: 800 } : { width: 390, height: 700 });
      await frame();
    } catch (err) {
      showError(err);
    }
    size.disabled = false;
  });

  const backTo = () => {
    const waiting = question ? state.questions.find((q) => q.id === question) : undefined;
    location.replace(waiting ? `#/s/${waiting.sessionId}` : `#/connections/${encodeURIComponent(id)}`);
  };
  const cancel = async () => {
    closed = true;
    await api(`${base}/cancel`, {}).catch(() => {});
    backTo();
  };
  const keep = h('button', { class: 'btn primary wide' }, 'Keep this sign-in');
  keep.addEventListener('click', async () => {
    keep.disabled = true;
    await busy;
    try {
      const reply = await api(`${base}/keep`, question ? { question } : {});
      closed = true;
      if (reply.question && reply.thread) {
        await api(`/api/questions/${reply.question}`, { answer: 'done' }).catch(showError);
        location.replace(`#/s/${reply.thread}`);
        toast(`Kept the sign-in to ${reply.signIn.site}.`);
        return;
      }
      const signIn = reply.signIn;
      location.replace(`#/connections/${encodeURIComponent(id)}`);
      const { connection } = await api(`/api/connections/${encodeURIComponent(id)}`);
      const kept = connection.signIns.find((s) => s.id === signIn.id) ?? signIn;
      if (connection.signInProjects.length && !kept.projects.length) signInProjectsSheet(connection, kept, { justKept: true });
      else toast(`Kept the sign-in to ${kept.site}.`);
    } catch (err) {
      keep.disabled = false;
      said.textContent = err.message;
    }
  });

  screen(
    bar(round('close', 'Cancel', cancel), title(site ? `Sign in to ${site}` : 'Sign in')),
    [
      h('p', { class: 'hint lead' }, 'This is a browser on polyphemus’s computer, in a window on its screen. Click the page to use it — hovering, checkboxes and menus all work — and type straight into it once it’s outlined. The box below types for a phone. If a site asks you to prove you’re human, you can also do it in that window, at the computer itself. Your password goes to the site, not to polyphemus or any agent.'),
      h('div', { class: 'live-address' }, round('back', 'Back a page', () => send({ kind: 'back' })), address),
      h('div', { class: 'live-frame' }, picture),
      h('div', { class: 'buttons live-keys' }, size),
      h('div', { class: 'live-type' }, typed, h('button', { class: 'btn small primary', onclick: () => typeIt(false) }, 'Type')),
      h('div', { class: 'buttons live-keys' }, key('Tab'), key('Enter'), key('Backspace', 'Delete'), h('button', { class: 'btn small', onclick: () => send({ kind: 'scroll', dy: -500 }) }, 'Scroll up'), h('button', { class: 'btn small', onclick: () => send({ kind: 'scroll', dy: 500 }) }, 'Scroll down')),
      h('p', { class: 'hint' }, 'Signed in? Keep it: polyphemus saves the cookies the site set, and nothing else.'),
      keep,
      said,
    ],
    { mainClass: 'plain' },
  );
}

/** Checkboxes over a set of tools; only the ones offered can be picked. */
function toolChoices(tools, chosen) {
  const picked = new Set(chosen);
  const nodes = tools.map((t) => {
    const b = h('button', { type: 'button', class: 'choice check', 'aria-pressed': String(picked.has(t.name)), 'data-tool': t.name }, h('span', { class: 'box' }), h('span', {}, h('b', { class: 'mono' }, t.name), h('small', {}, `${t.reads ? 'Reads' : 'Changes things'}${t.description ? ` · ${t.description}` : ''}`)));
    b.addEventListener('click', () => {
      if (picked.has(t.name)) picked.delete(t.name);
      else picked.add(t.name);
      b.setAttribute('aria-pressed', String(picked.has(t.name)));
    });
    return b;
  });
  const set = (names) => {
    picked.clear();
    for (const n of names) picked.add(n);
    for (const b of nodes) b.setAttribute('aria-pressed', String(picked.has(b.dataset.tool)));
  };
  const shortcuts = h(
    'div',
    { class: 'buttons' },
    h('button', { type: 'button', class: 'btn small', onclick: () => set(tools.filter((t) => t.reads).map((t) => t.name)) }, 'Only reads'),
    h('button', { type: 'button', class: 'btn small', onclick: () => set(tools.map((t) => t.name)) }, 'All of these'),
  );
  return { node: h('div', { class: 'choices' }, shortcuts, nodes), picked: () => [...picked] };
}

function declareSheet(c) {
  const choices = toolChoices(c.tools, c.ceiling.provenance === 'declared' ? c.ceiling.tools : c.tools.map((t) => t.name));
  const save = h('button', { class: 'btn primary wide' }, 'Declare');
  const post = async (tools) => {
    try {
      await api(`/api/connections/${encodeURIComponent(c.id)}/ceiling`, { tools });
      document.querySelector('.sheet-wrap')?.remove();
      await refresh();
      connectionScreen(c.id);
    } catch (err) {
      showError(err);
    }
  };
  save.addEventListener('click', () => post(choices.picked()));
  sheet('What the credential can do', [
    h('p', { class: 'hint' }, `Tick what you made ${c.name}’s credential able to do. It’s recorded as declared by you, not checked — polyphemus can’t confirm it with the service — and no grant can go past it.`),
    choices.node,
    save,
    c.ceiling.provenance === 'declared' ? h('button', { class: 'btn wide', onclick: () => post(null) }, 'Clear it: back to unknown') : null,
  ]);
}

/**
 * From an agent: pick a connection for it to carry. Granting still happens in grantSheet, so what's
 * offered and what it says are the same wherever you came from.
 */
async function carrySheet(agent) {
  let data;
  try {
    data = await api('/api/connections');
  } catch (err) {
    return showError(err);
  }
  const grantable = data.connections.filter((c) => c.canGrant);
  if (!grantable.length) {
    return sheet(`Give ${agent.title} a connection`, [
      h('p', { class: 'hint' }, 'Nothing is connected yet that you can grant.'),
      h('button', { class: 'btn wide', onclick: () => (document.querySelector('.sheet-wrap')?.remove(), go('#/connections')) }, 'Open Connections'),
    ]);
  }
  sheet(`Give ${agent.title} a connection`, [
    h('p', { class: 'hint' }, `It carries what you grant here wherever it works — in a direct thread with it, and in every project it works in, on top of what those projects grant.`),
    h(
      'div',
      { class: 'card' },
      grantable.map((c) =>
        h('button', { type: 'button', class: 'item', onclick: async () => {
          document.querySelector('.sheet-wrap')?.remove();
          try {
            grantSheet((await api(`/api/connections/${encodeURIComponent(c.id)}`)).connection, { carry: true, agent: agent.id });
          } catch (err) {
            showError(err);
          }
        } },
          connectionMark(c),
          h('span', { class: 'grow' }, h('span', {}, c.name), h('small', {}, toolsSummary(c.tools))),
          icon('chev', 'ico mini')),
      ),
    ),
  ]);
}

/**
 * Grant a connection to a project, to an agent that carries it wherever it works (a direct thread
 * included), or narrow a project's grant for one agent. What's offered is what the thing being
 * narrowed already has: the ceiling for a project or a carried grant, the project's grant for an agent.
 */
function grantSheet(c, { project = '', agent, carry = false }) {
  const forAgent = agent !== undefined && !carry;
  const projectGrant = (slug) => c.grants.find((g) => g.project === slug && !g.agent);
  const carriedBy = (id) => c.grants.find((g) => !g.project && g.agent === id);
  const projects = activeProjects().filter((p) => (forAgent ? projectGrant(p.slug) : true));
  const projectSelect = h('select', { id: 'grant-project' }, projects.map((p) => h('option', { value: p.slug, selected: p.slug === project }, p.name)));
  if (project) projectSelect.disabled = true;
  const agentSelect = h('select', { id: 'grant-agent' });
  const body = h('div', {});
  const draw = () => {
    const slug = carry ? '' : projectSelect.value;
    const existing = carry
      ? carriedBy(agentSelect.value)
      : forAgent
        ? c.grants.find((g) => g.project === slug && g.agent === (agentSelect.value || agent))
        : projectGrant(slug);
    const within = forAgent ? (projectGrant(slug)?.tools ?? []) : c.ceiling.tools;
    const offered = c.tools.filter((t) => within.includes(t.name));
    const choices = toolChoices(offered, existing?.tools ?? offered.filter((t) => t.reads).map((t) => t.name));
    const save = h('button', { class: 'btn primary wide' }, existing ? 'Save' : 'Grant');
    save.addEventListener('click', async () => {
      const tools = choices.picked();
      if (!tools.length) return toast('Pick at least one — or revoke it instead.', 'error');
      save.disabled = true;
      try {
        await api(`/api/connections/${encodeURIComponent(c.id)}/grant`, { project: slug, ...(forAgent || carry ? { agent: agentSelect.value } : {}), tools });
        document.querySelector('.sheet-wrap')?.remove();
        await refresh();
        // The sheet opens from the connection and from an agent's profile: go back to whichever it was.
        if (view.name === 'connection') connectionScreen(c.id);
        else render();
      } catch (err) {
        save.disabled = false;
        showError(err);
      }
    });
    const revoke = (forAgent || carry) && existing
      ? h('button', { class: 'btn wide', onclick: async () => {
          try {
            await api(`/api/connections/${encodeURIComponent(c.id)}/revoke`, { project: slug, agent: agentSelect.value });
            document.querySelector('.sheet-wrap')?.remove();
            await refresh();
            if (view.name === 'connection') connectionScreen(c.id);
            else render();
          } catch (err) {
            showError(err);
          }
        } }, carry ? 'Take it back: it carries nothing' : 'Remove the narrowing: back to the project’s grant')
      : null;
    fill(body,
      h('p', { class: 'hint' }, forAgent
        ? `Only what ${projectOf(slug)?.name ?? slug} was granted can be offered here. An agent’s grant can narrow its project’s, never widen it.`
        : carry
          ? `${agentByRef(agentSelect.value)?.title ?? 'This agent'} carries this wherever it works — in a direct thread with it, and in every project it works in, on top of what that project grants. Within what the credential can do.`
          : c.ceiling.provenance === 'unknown'
          ? 'Nobody has said what this credential can do, so these are everything its server offers. Polyphemus will refuse calls outside what you grant either way.'
          : `Within what the credential can do (${PROVENANCE[c.ceiling.provenance][1].toLowerCase()}).`),
      offered.length ? choices.node : h('p', { class: 'empty' }, 'Nothing to grant.'),
      offered.length ? h('p', { class: 'hint' }, 'A change takes effect from each agent’s next turn here. It doesn’t reach back into what already ran, and a question already waiting on you stays as it is.') : null,
      offered.length ? save : null,
      revoke,
    );
  };
  if (forAgent || carry) {
    const fillAgents = () => {
      const slug = carry ? '' : projectSelect.value;
      const agents = (state.agents ?? []).filter((a) => carry || a.project === null || a.project === slug);
      fill(agentSelect, agents.map((a) => h('option', { value: a.id, selected: a.id === agent }, a.title)));
      if (agent) agentSelect.disabled = true;
    };
    fillAgents();
    if (!carry) projectSelect.addEventListener('change', () => (fillAgents(), draw()));
    agentSelect.addEventListener('change', draw);
  } else projectSelect.addEventListener('change', draw);
  draw();
  sheet(carry ? `${c.name} for an agent to carry` : forAgent ? `${c.name} for one agent` : `Grant ${c.name}`, [
    carry ? null : h('label', { class: 'field' }, h('span', {}, 'Project'), projectSelect),
    forAgent || carry ? h('label', { class: 'field' }, h('span', {}, 'Agent'), agentSelect) : null,
    body,
  ]);
}

/** "What can this reach, and why?" — for a project page or an agent's profile. */
function reachSection(path, { empty, perProject }) {
  const box = h('div', { class: 'reach' }, h('p', { class: 'empty' }, 'Looking…'));
  api(path)
    .then((data) => {
      const groups = perProject ? data.projects.map((p) => ({ heading: p.name, reach: p.reach })) : [{ heading: null, reach: data.reach, agents: data.agents }];
      const lines = groups.flatMap((g) => [
        g.heading ? h('div', { class: 'reach-project' }, g.heading) : null,
        ...g.reach.map((r) =>
          h(
            'button',
            { class: 'panel pad reach-item', onclick: () => go(`#/connections/${encodeURIComponent(r.connection)}`) },
            h('div', { class: 'chip-line' }, h('b', {}, r.name), h('span', { class: `tag ${HEALTH[r.health][0]}` }, HEALTH[r.health][1])),
            h('div', { class: 'meta' }, toolsSummary(r.tools)),
            (() => {
              // The ones that change things, by name; the rest as a count (finding-your-way decisions).
              const changing = r.tools.filter((t) => !t.reads);
              const named = changing.slice(0, 4);
              const more = r.tools.length - named.length;
              return named.length ? h('div', { class: 'tool-chips' }, named.map((t) => h('span', { class: 'tool-chip' }, t.name)), more ? h('span', { class: 'tool-chip more' }, `+${more} more`) : null) : null;
            })(),
            h('div', { class: 'meta' }, r.why),
            r.ceiling.provenance !== 'checked' ? h('div', { class: 'meta' }, `Credential: ${r.ceiling.says}`) : null,
          ),
        ),
        ...(g.agents ?? [])
          .flatMap((a) => a.reach.filter((r) => !r.inherited).map((r) => h('p', { class: 'meta reach-narrow' }, h('b', {}, a.title), ` only ${r.tools.map((t) => t.name).join(', ')} on ${r.name}`))),
      ]);
      fill(box, ...(groups.some((g) => g.reach.length) ? lines.filter(Boolean) : [h('p', { class: 'empty' }, empty)]));
    })
    .catch(() => fill(box, h('p', { class: 'empty' }, 'Couldn’t load what it can reach.')));
  return box;
}

function connectionIssueCards() {
  return (state.connectionIssues ?? []).map((c) =>
    h(
      'div',
      { class: 'ask' },
      h('button', { class: 'ask-head', onclick: () => go(`#/connections/${encodeURIComponent(c.id)}`) }, h('b', {}, `${c.name} isn’t working`), h('span', { class: 'tag' }, 'Connection')),
      h('p', {}, c.errorKind === 'auth' ? 'Its credential was refused — reconnect it with a new one.' : 'Its server can’t be reached.'),
      h('code', {}, clip(c.error ?? 'No error was given.', 240)),
      h('p', { class: 'cost' }, c.session ? `It came up in “${c.session.title}”. Anything granted it is failing until it’s fixed.` : 'Anything granted it is failing until it’s fixed.'),
      h(
        'div',
        { class: 'buttons' },
        h('button', { class: 'btn primary', onclick: () => go(`#/connections/${encodeURIComponent(c.id)}`) }, 'Reconnect'),
        c.session ? h('button', { class: 'btn', onclick: () => go(`#/s/${c.session.id}`) }, 'See the thread') : null,
        // Something you can't fix right now shouldn't sit on top of Home forever. A new problem brings it back.
        h('button', { class: 'btn ghost', onclick: async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            await api(`/api/connections/${encodeURIComponent(c.id)}/dismiss`, {});
            await refresh();
            toast(`Dismissed. It comes back if ${c.name} fails some other way.`);
          } catch (err) {
            button.disabled = false;
            showError(err);
          }
        } }, 'Dismiss'),
      ),
    ),
  );
}

// ── Providers and models: getting something to run on, without a terminal ──






/**
 * Everything polyphemus knows how to set up. Not the whole world — the frontier labs, what people
 * actually reach for, the gateways, and servers you run yourself. Connecting one writes its
 * config block for you, which is the part that used to mean editing TOML on your computer.
 */
async function addProviderScreen(open) {
  let catalogue;
  let more;
  try {
    ({ catalogue, more } = await api('/api/catalogue'));
  } catch (err) {
    showError(err);
    return location.replace('#/models?tab=providers');
  }
  if (open) {
    const entry = catalogue.find((e) => e.id === open);
    return screen(bar(backButton(), title(entry?.name ?? 'Add a provider')), [entry ? connectPanel(entry) : h('p', { class: 'empty' }, 'Not in the catalogue.')], { mainClass: 'plain' });
  }
  const groups = [
    ['Frontier labs', 'frontier'],
    ['Popular', 'popular'],
    ['One key, many models', 'gateway'],
    ['On your own machine', 'local'],
  ];
  screen(
    bar(backButton(), title('Add a provider')),
    [
      h('p', { class: 'hint', style: 'margin-top:0' }, 'Polyphemus writes the setup for you. You still need a key, or the provider’s own CLI signed in.'),
      ...groups.flatMap(([label, tier]) => {
        const rows = catalogue.filter((e) => e.tier === tier);
        if (!rows.length) return [];
        return [sec(label, rows.length), h('div', { class: 'list' }, rows.map(catalogueRow))];
      }),
      sec('Not set up yet', more.length),
      h('p', { class: 'hint' }, `${more.join(', ')}. Polyphemus can reach any of these through a gateway, or with an OpenAI-compatible server URL — they just aren’t one-tap yet.`),
    ],
    { mainClass: 'plain' },
  );
}

function catalogueRow(e) {
  return h(
    'button',
    { class: 'row', onclick: () => (e.configured ? go('#/models?tab=providers') : go(`#/add-provider/${encodeURIComponent(e.id)}`)) },
    mark(e.id),
    h(
      'span',
      { class: 'row-main' },
      h('span', { class: 'row-top' }, h('b', {}, e.name), e.offered ? h('span', { class: 'tag' }, 'Offered') : e.configured ? h('span', { class: 'tag good' }, 'Set up') : null),
      h('span', { class: 'row-sub' }, h('span', { class: 'text' }, `${e.vendor} · ${e.about}`)),
    ),
  );
}

/** Confirm what will be written, correct the server URL, then add it. */
function connectPanel(e) {
  const url = h('input', { id: 'connect-url', type: 'url', value: e.baseUrl ?? '', placeholder: 'https://…', autocapitalize: 'none', spellcheck: 'false' });
  const needsUrl = e.adapter === 'openai-chat';
  const add = async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Adding…';
    try {
      await api('/api/providers', { id: e.id, baseUrl: needsUrl ? url.value.trim() : undefined });
      await refresh();
      toast(`${e.name} added.`);
      location.replace('#/models?tab=providers');
    } catch (err) {
      showError(err);
      button.disabled = false;
      button.textContent = 'Add it';
    }
  };
  return h(
    'div',
    { class: 'field' },
    h('p', { class: 'hint', style: 'margin-top:0' }, `${e.vendor} · ${e.about}`),
    needsUrl
      ? h(
          'label',
          { class: 'field' },
          h('span', {}, 'Server URL'),
          url,
          h('small', { class: 'hint' }, e.baseUrl ? 'This is what polyphemus believes it to be. Check it against their docs — endpoints move, and a wrong one fails at the first turn.' : 'Polyphemus has no reliable URL for this one. Get it from their docs and paste it here.'),
        )
      : null,
    e.connect === 'key'
      ? h('p', { class: 'hint' }, `After this, paste an API key on its screen${e.env ? `, or set ${e.env} in your environment` : ''}.`)
      : e.connect === 'cli'
        ? h('p', { class: 'hint' }, 'This one signs in through its own CLI on your computer.')
        : h('p', { class: 'hint' }, 'A server you run: no key needed.'),
    e.docs ? h('p', { class: 'hint' }, `Their docs: ${e.docs}`) : null,
    h('button', { class: 'btn primary wide', onclick: add }, 'Add it'),
  );
}

/**
 * What a provider says about one of its models. Providers differ: Anthropic's list endpoint gives
 * a display name and a context window, OpenAI's gives an id and little else. Whatever came back is
 * shown; nothing is filled in, because a wrong context window fails a request polyphemus said would fit.
 */
const bigTokens = (n) => (n >= 1_000_000 ? `${Math.round((n / 1_000_000) * 10) / 10}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

function describeOffer(m, connection) {
  const parts = [`${connection.vendor} · ${connection.label}`];
  if (m.name && m.name !== m.id) parts.push(m.name);
  if (m.contextWindow) parts.push(`${bigTokens(m.contextWindow)} context`);
  if (m.maxOutput) parts.push(`${bigTokens(m.maxOutput)} out`);
  return parts.join(' · ');
}

/**
 * Choose which models you want. Pick a provider, tick its models — that's the whole interaction.
 * There's no name to invent: a model is its provider and its id, and the provider is only there
 * to narrow the list down.
 */
async function chooseModelsScreen(preset = '') {
  let providers;
  try {
    ({ providers } = await api('/api/providers'));
  } catch (err) {
    showError(err);
    return go('#/models');
  }
  const ready = providers.flatMap((v) => v.connections.filter((c) => c.ready).map((c) => ({ ...c, vendor: v.name })));
  if (!ready.length) {
    return screen(
      bar(backButton(), title('Choose models')),
      [h('p', { class: 'empty' }, 'Nothing is signed in yet.'), h('button', { class: 'btn primary wide', onclick: () => go('#/models?tab=providers') }, 'Providers and sign-in')],
      { mainClass: 'plain' },
    );
  }
  const which = preset && ready.some((c) => c.id === preset) ? preset : ready[0].id;
  const connection = ready.find((c) => c.id === which);
  const chosen = new Set(state.selected ?? []);

  const list = h('div', { class: 'list' }, h('p', { class: 'hint' }, `Asking ${connection.vendor}…`));
  const picker = h(
    'select',
    { id: 'choose-provider', onchange: () => go(`#/choose/${encodeURIComponent(picker.value)}`) },
    ...ready.map((c) => h('option', { value: c.id, selected: c.id === which }, `${c.vendor} · ${c.label}`)),
  );
  // Where you are and what to do next: ticking saved immediately but said nothing, so the screen
  // dead-ended with no sense of having finished.
  const tally = h('p', { class: 'hint', style: 'margin-top:0' }, '');
  const picked = h('div', { class: 'picked' });
  const onward = h('div', { class: 'buttons' });
  const nameOf = (ref) => ref.slice(ref.indexOf(':') + 1);
  const vendorOf = (ref) => ready.find((c) => c.id === ref.slice(0, ref.indexOf(':')))?.vendor ?? ref.slice(0, ref.indexOf(':'));
  const showProgress = () => {
    const count = chosen.size;
    tally.textContent = count
      ? `Tick as many as you like, from as many providers as you like.`
      : 'Nothing chosen yet. Tick a model to make it available in polyphemus.';
    // What you've chosen everywhere, not only on the provider you're looking at — otherwise
    // picking a second one looks impossible, because the first one isn't on screen.
    fill(picked, 
      ...(count
        ? [
            sec('Chosen so far', count),
            h(
              'div',
              { class: 'chips' },
              ...[...chosen].map((ref) =>
                h('span', { class: `chip ${state.defaultModel === ref ? 'is-default' : ''}` }, `${vendorOf(ref)} · ${nameOf(ref)}${state.defaultModel === ref ? ' · default' : ''}`),
              ),
            ),
          ]
        : []),
    );
    fill(onward, 
      ...(count
        ? [
            h('button', { class: 'btn primary', onclick: () => go('#/models') }, 'Done'),
            h('button', { class: 'btn', onclick: () => go('#/new-agent') }, 'Make an agent'),
          ]
        : []),
    );
  };
  screen(
    bar(backButton(), title('Choose models')),
    [
      tally,
      picked,
      h('label', { class: 'field' }, h('span', {}, 'Provider'), picker),
      list,
      onward,
      h('p', { class: 'hint' }, 'What you tick is what polyphemus offers — for a thread, for an agent, and as a fallback.'),
    ],
    { mainClass: 'plain' },
  );
  showProgress();

  let offered = [];
  let problem;
  try {
    ({ models: offered, problem } = await api(`/api/providers/${encodeURIComponent(which)}/models`));
  } catch (err) {
    return showError(err);
  }
  if (view.name !== 'choose') return;
  const save = async (ref, on, switcher) => {
    const next = new Set(chosen);
    if (on) next.add(ref);
    else next.delete(ref);
    try {
      const before = chosen.size;
      const { selected, defaultModel } = await api('/api/selected', { selected: [...next] });
      chosen.clear();
      for (const each of selected) chosen.add(each);
      await refresh();
      // The first one becomes the default, and saying so is the point of choosing it.
      if (on && before === 0 && defaultModel) toast(`${ref.slice(ref.indexOf(':') + 1)} is your default model.`);
      showProgress();
    } catch (err) {
      switcher?.setAttribute('aria-checked', String(!on));
      showError(err);
    }
  };
  const rows = offered.map((m) => {
    const ref = `${which}:${m.id}`;
    const row = toggle(m.id === 'default' ? 'default — let it choose' : m.id, describeOffer(m, connection), chosen.has(ref), (on) =>
      save(ref, on, row.querySelector('.switcher')),
    );
    return row;
  });
  fill(list, 
    ...(problem ? [h('p', { class: 'hint' }, problem)] : []),
    ...(rows.length ? rows : [h('p', { class: 'empty' }, 'It didn’t list any models.')]),
  );
}








/** Models grouped under the company they come from, which is how you think about picking one. */
function byProvider(models) {
  const groups = new Map();
  for (const m of models) groups.set(m.provider, [...(groups.get(m.provider) ?? []), m]);
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}





// ── Models & providers ───────────────────────────────────────────────────
// One place, three questions (Alex's mockup, 2026-09-12): which models can run, how polyphemus
// reaches each provider, and what happens when one can't. Each model says how it's actually been
// going — from real turns and tests you pressed, never from a probe polyphemus sent on its own.

const MODEL_TABS = [
  ['models', 'Models'],
  ['providers', 'Providers'],
  ['defaults', 'Defaults & fallback'],
];

/** The id a model is known by: its id, or what a CLI picked last when it's left to choose. */
const modelName = (m) => m.modelId ?? (m.lastReplyModel ? `whichever it picks (last: ${m.lastReplyModel})` : 'whichever it picks');
/** Whose, which way in, and how it's paid for: "Anthropic · Claude Code CLI · your Claude subscription". */
const modelWay = (m) => [m.provider, m.how, m.billedAs].filter(Boolean).join(' · ');
/** Your models, then any an agent runs on that isn't on your list — it still runs, and says so. */
const everyModel = () => [...state.models, ...(state.agentModels ?? [])];
const modelByLabel = (label) => everyModel().find((m) => m.label === label);
/** A model named by its label or by provider:model, as it's listed. */
const modelByRef = (ref) => everyModel().find((m) => m.label === ref || m.target === ref);
/** A model in a few words, for a chip: "Claude Code · claude-opus-5", "Anthropic API · claude-opus-5". */
const modelShort = (m) => `${m.how === 'API key' ? `${m.provider} API` : m.how.replace(/ CLI$/, '')} · ${m.modelId ?? 'its pick'}`;

/**
 * How a model is doing, in one word and a colour. Not signed in beats everything: nothing else
 * matters until it can run. Then the latest real outcome — a failure newer than the last success
 * needs you, unless it was only busy or out of allowance, which the allowance already says.
 */
function modelHealth(m) {
  const r = m.result ?? {};
  if (m.agentOnly) return { kind: 'warn', label: 'Not on your list', text: 'Nothing runs on it until you add it to your models.' };
  if (!m.ready) return { kind: 'warn', label: 'Not signed in', text: m.note || 'Nothing is signed in behind it, so it can’t run.' };
  if (m.out) return { kind: 'warn', label: 'Out for now', text: `It ${m.unavailable ?? 'is out'}.` };
  const failedLast = r.lastErrorAt && r.lastErrorAt > (r.lastOkAt ?? 0);
  if (failedLast && !['rate_limited', 'overloaded', 'quota_exhausted'].includes(r.errorClass)) {
    return { kind: 'bad', label: 'Needs attention', text: `Failed ${ago(r.lastErrorAt) === 'now' ? 'just now' : `${ago(r.lastErrorAt)} ago`}: ${r.lastError}` };
  }
  if (r.lastOkAt) return { kind: 'good', label: 'Working', text: `Last worked ${ago(r.lastOkAt) === 'now' ? 'just now' : `${ago(r.lastOkAt)} ago`}.` };
  return { kind: '', label: 'Not run yet', text: 'It’s confirmed the first time it runs, or when you test it — your plan decides what you can reach, not this list.' };
}

function usedByLine(m) {
  const parts = [];
  if (state.defaultModel === m.label) parts.push('the default');
  if (m.usedBy?.backup) parts.push(`backup #${m.usedBy.backup}`);
  const agents = m.usedBy?.agents ?? [];
  if (agents.length) parts.push(agents.length === 1 ? `${agents[0]}` : `${agents.length} agents`);
  if (m.usedBy?.threads) parts.push(`${m.usedBy.threads} thread${m.usedBy.threads === 1 ? '' : 's'}`);
  return parts.length ? `Used by ${parts.join(' · ')}` : 'Nothing uses it yet';
}

/** Tests cost something real, so the price is said before anything is sent. */
async function runTest(button, cost, send, subject) {
  if (!(await confirmSheet(`Test ${subject}?`, `This sends one real request. It uses ${cost}.`, { yes: 'Send the test' }))) return undefined;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Testing…';
  try {
    const result = await send();
    const test = result.test;
    const used = test.usage ? test.usage.inputTokens + test.usage.outputTokens + test.usage.cacheReadTokens + test.usage.cacheWriteTokens : 0;
    const spent = used ? ` · ${used.toLocaleString()} tokens` : '';
    toast(test.ok ? `It works (${(test.ms / 1000).toFixed(1)}s${spent}).` : `It didn’t work: ${clip(test.said, 160)}`, test.ok ? '' : 'error');
    await refresh();
    return result;
  } catch (err) {
    showError(err);
    return undefined;
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

async function makeDefault(m) {
  try {
    await api('/api/routing', { defaultModel: m.label });
    await refresh();
    toast(`${modelName(m)} is the default.`);
  } catch (err) {
    showError(err);
  }
}

function modelsHomeScreen(tab) {
  // Nothing to run on and nothing chosen: this isn't a settings page yet, it's setup.
  if (!state.models.some((m) => m.chosen) && tab === 'models' && !setupSkipped) return location.replace('#/setup');
  const which = MODEL_TABS.some(([id]) => id === tab) ? tab : 'models';
  const tabs = h(
    'div',
    { class: 'segmented tabbed', role: 'tablist' },
    ...MODEL_TABS.map(([id, label]) =>
      h('button', { type: 'button', role: 'tab', 'aria-pressed': String(id === which), 'aria-selected': String(id === which), onclick: () => location.replace(id === 'models' ? '#/models' : `#/models?tab=${id}`) }, label),
    ),
  );
  const body = h('div', { id: 'models-tab' });
  screen(
    bar(backButton(), title('Models & providers')),
    [h('p', { class: 'hint lede' }, 'Which models polyphemus can run, how it reaches them, and what happens when one can’t.'), tabs, body],
    { mainClass: 'plain' },
  );
  if (which === 'models') fill(body, modelsTab());
  if (which === 'defaults') fill(body, defaultsTab());
  if (which === 'providers') connectionsTab(body);
}

// ── Models tab ──

function modelsTab() {
  const chosen = state.models.filter((m) => m.chosen);
  const profiles = state.models.filter((m) => !m.chosen);
  return [
    h(
      'div',
      { class: 'sec-head' },
      h('div', {}, h('b', {}, 'Your models'), h('p', {}, 'Threads and agents can use any model here.')),
      h('button', { class: 'btn primary small', onclick: () => go('#/choose') }, 'Add models'),
    ),
    chosen.length ? h('div', { class: 'panel-list' }, chosen.map(modelCard)) : h('p', { class: 'empty' }, 'None yet. Add models from a provider you’re connected to.'),
    (state.agentModels ?? []).length
      ? [
          h('div', { class: 'sec-head' }, h('div', {}, h('b', {}, 'Not on your list'), h('p', {}, 'Agents are set to these, but your list is the limit on what anything runs on: they won’t run until you add the model, or give the agent one that’s on your list.'))),
          h('div', { class: 'panel-list' }, state.agentModels.map(modelCard)),
        ]
      : null,
    profiles.length
      ? [
          h('div', { class: 'sec-head' }, h('div', {}, h('b', {}, 'Model profiles'), h('p', {}, 'A name that points at a model, so repointing it moves everything using the name at once.'))),
          h('div', { class: 'panel-list' }, profiles.map(modelCard)),
        ]
      : null,
  ];
}

function modelCard(m) {
  const health = modelHealth(m);
  const isDefault = state.defaultModel === m.label;
  const open = () => go(`#/models/${encodeURIComponent(m.label)}`);
  const top = h(
    'button',
    { class: 'mcard-top', onclick: open },
    mark(m.connection),
    h(
      'span',
      { class: 'row-main' },
      h(
        'span',
        { class: 'chip-line' },
        h('b', {}, m.chosen || m.agentOnly ? modelName(m) : m.label),
        isDefault ? h('span', { class: 'tag accent' }, 'Default') : null,
        h('span', { class: `tag ${health.kind}` }, health.label),
      ),
      h('span', { class: 'meta' }, m.chosen || m.agentOnly ? modelWay(m) : `${modelWay(m)} · ${modelName(m)}`),
      h('span', { class: 'meta faint' }, [m.result?.lastOkAt && health.kind === 'good' ? `Last worked ${ago(m.result.lastOkAt)} ago` : null, usedByLine(m)].filter(Boolean).join(' · ')),
    ),
    icon('chev', 'ico mini chev'),
  );
  const actions = [];
  if (m.agentOnly) {
    const add = h('button', { class: 'btn small' }, 'Add to your models');
    add.addEventListener('click', async () => {
      add.disabled = true;
      try {
        await api('/api/selected', { selected: [...new Set([...(state.selected ?? []), m.label])] });
        await refresh();
        toast(`${modelName(m)} is on your list now.`);
      } catch (err) {
        add.disabled = false;
        showError(err);
      }
    });
    actions.push(add);
  } else if (health.kind === 'bad') {
    const again = h('button', { class: 'btn small' }, 'Test again');
    again.addEventListener('click', () => runTest(again, m.testCost, () => api('/api/models/test', { ref: m.label }), modelName(m)));
    actions.push(again, h('button', { class: 'btn small', onclick: open }, 'Switch way in'));
  } else if (health.label === 'Not signed in') {
    actions.push(h('button', { class: 'btn small primary', onclick: () => location.replace('#/models?tab=providers') }, `Sign in to ${m.provider}`));
  } else if (!isDefault && m.ready) {
    actions.push(h('button', { class: 'btn small', onclick: () => makeDefault(m) }, 'Make default'));
  }
  return h(
    'div',
    { class: 'mcard' },
    top,
    health.kind === 'bad' || health.kind === 'warn' ? h('div', { class: `note ${health.kind}` }, health.text) : null,
    actions.length ? h('div', { class: 'buttons mcard-actions' }, actions) : null,
  );
}

// ── Providers tab ──

/** A provider polyphemus offers and isn't using: what it is, whether its CLI is already signed in here, and Use it. */
function offeredBlock(v, c) {
  const here =
    c.signIn === 'cli' ? (c.signedIn ? `Signed in on this computer${c.account ? ` as ${c.account}` : ''}` : c.installed ? 'Installed here, not signed in' : c.installed === false ? 'Not installed here' : null)
    : c.signIn === 'key' ? (c.hasKey ? 'A key is already saved' : 'Needs an API key, after you accept it')
    : null;
  const facts = [c.how ? c.how.charAt(0).toUpperCase() + c.how.slice(1) : null, here].filter(Boolean);
  const use = h('button', { class: 'btn small primary' }, 'Use it');
  use.addEventListener('click', async () => {
    use.disabled = true;
    try {
      await api(`/api/providers/${encodeURIComponent(c.id)}/accept`, {});
      await refresh();
      toast(`${v.name} through ${c.label} is in use. Choose its models under Models.`);
      render();
    } catch (err) {
      use.disabled = false;
      showError(err);
    }
  });
  const remove = h('button', { class: 'btn small' }, 'Remove');
  remove.addEventListener('click', async () => {
    if (!(await confirmSheet(`Remove ${c.label}?`, `It won’t be offered any more. You can add ${v.name} again from Add a provider.`, { yes: 'Remove' }))) return;
    try {
      await api(`/api/providers/${encodeURIComponent(c.id)}`, undefined, 'DELETE');
      await refresh();
      render();
    } catch (err) {
      showError(err);
    }
  });
  return h(
    'div',
    { class: 'method offered' },
    h('div', { class: 'chip-line' }, h('b', {}, c.label), h('span', { class: 'tag' }, 'Not in use')),
    facts.length ? h('div', { class: 'meta' }, facts.join(' · ')) : null,
    h('div', { class: 'buttons' }, use, remove),
  );
}

async function connectionsTab(body) {
  fill(body, h('p', { class: 'hint' }, 'Asking what’s signed in…'));
  let providers;
  try {
    ({ providers } = await api('/api/providers'));
  } catch (err) {
    return showError(err);
  }
  if (view.name !== 'models' || view.tab !== 'providers') return;
  const offered = providers.filter(allOffered);
  const inUse = providers.filter((v) => !allOffered(v));
  fill(body, 
    h(
      'div',
      { class: 'sec-head' },
      h('div', {}, h('b', {}, 'Providers'), h('p', {}, 'Whose models you can run, and the ways in to each. A provider can have more than one way in, and they don’t always behave — or bill — the same.')),
      h('button', { class: 'btn small', onclick: () => go('#/add-provider') }, 'Add a provider'),
    ),
    ...inUse.map(providerGroup),
    offered.length
      ? h('div', { class: 'sec-head' }, h('div', {}, h('b', {}, 'Offered'), h('p', {}, 'Polyphemus comes ready for these, but doesn’t use one until you say so: nothing runs on it and nobody can pick its models.')))
      : null,
    ...offered.map(providerGroup),
  );
}

/** Every way in to it is still an offer: polyphemus knows it, and hasn't been told to use it. */
const allOffered = (v) => v.connections.every((c) => c.offered);

function providerGroup(v) {
  const set = v.connections.filter((c) => c.ready).length;
  const chosen = v.connections.flatMap((c) => c.chosen ?? []);
  const attention = state.models.filter((m) => v.connections.some((c) => c.id === m.connection) && m.chosen && modelHealth(m).kind === 'bad').length;
  const needsSignIn = !set && v.connections.some((c) => c.installed);
  const status = allOffered(v) ? ['', 'Offered'] : set ? ['good', 'Signed in'] : needsSignIn ? ['warn', 'Needs sign-in'] : ['', 'Not signed in'];
  return h(
    'section',
    { class: 'provider', id: `provider-${v.id}` },
    h(
      'div',
      { class: 'provider-head' },
      mark(v.connections[0].id),
      h(
        'div',
        { class: 'row-main' },
        h('span', { class: 'chip-line' }, h('b', {}, v.name), h('span', { class: `tag ${status[0]}` }, status[1])),
        h(
          'span',
          { class: 'meta' },
          [
            allOffered(v) ? `${v.connections.length} way${v.connections.length === 1 ? '' : 's'} in, none in use` : `${set} of ${v.connections.length} way${v.connections.length === 1 ? '' : 's'} in set up`,
            chosen.length ? `${chosen.length} model${chosen.length === 1 ? '' : 's'}` : null,
            attention ? `${attention} need${attention === 1 ? 's' : ''} attention` : null,
          ]
            .filter(Boolean)
            .join(' · '),
        ),
      ),
    ),
    ...v.connections.map((c) => connectionBlock(v, c)),
  );
}

/**
 * Installs a vendor CLI: the vendor's own installer into the home folder, or npm into Polyphemus's
 * own folder — never the system's, and never with a password. The command is on screen before the
 * click, and what it prints streams into `log`. `after` runs once it's installed.
 */
function installButton(id, label, log, after) {
  const button = h('button', { class: 'btn small primary' }, `Install ${label}`);
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Installing…';
    log.hidden = false;
    log.textContent = 'Starting…';
    try {
      const { command } = await api(`/api/providers/${encodeURIComponent(id)}/install`, {});
      log.textContent = `$ ${command}\n`;
      installing = { id, label, log, button, after };
    } catch (err) {
      button.disabled = false;
      button.textContent = `Install ${label}`;
      showError(err);
    }
  });
  return button;
}

/** Starts a vendor CLI's own sign-in, streaming what it prints into `log`. `after` runs once it's done. */
function signInButton(id, log, { again = false, primary = true, after } = {}) {
  const button = h('button', { class: `btn small ${primary ? 'primary' : ''}` }, again ? 'Sign in again' : 'Sign in');
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Signing in…';
    log.hidden = false;
    log.textContent = 'Starting…';
    try {
      // The browser opens on the computer polyphemus runs on, not necessarily the one you're
      // holding — so whatever the CLI prints is streamed here, URL or code included.
      const { command } = await api(`/api/providers/${encodeURIComponent(id)}/signin`, {});
      log.textContent = `$ ${command}\n`;
      signingIn = { id, log, button, after };
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Sign in';
      showError(err);
    }
  });
  return button;
}

/** What installing a CLI does, said before anyone clicks: where it comes from and where it goes. */
function installHint(c) {
  return h(
    'p',
    { class: 'hint tight' },
    c.onWindows ? 'It’s installed on Windows, but Polyphemus runs in Linux (WSL) and needs its own copy there. ' : '',
    'Installing runs ',
    h('code', {}, c.install),
    ': into your home folder, with no password.',
  );
}

function connectionBlock(v, c) {
  if (c.offered) return offeredBlock(v, c);
  const status =
    c.ready && c.sandbox?.ok === false ? ['warn', 'Can’t run commands here']
    : c.ready ? ['good', 'Signed in']
    : c.signIn === 'cli' && c.installed === false ? ['', 'Not installed']
    : c.signIn === 'cli' && c.installed ? ['warn', 'Installed, not signed in']
    : ['', 'Not set up'];
  const facts = [
    c.account,
    c.how ? c.how.charAt(0).toUpperCase() + c.how.slice(1) : null,
    c.signIn === 'cli' && c.installed ? 'On this computer' : null,
    c.metered ? 'Separate from any subscription' : null,
  ].filter(Boolean);
  const troubled = state.models.filter((m) => m.connection === c.id && m.chosen && modelHealth(m).kind === 'bad');
  const log = h('pre', { class: 'proposal', hidden: true });
  const buttons = h('div', { class: 'buttons' });

  const test = h('button', { class: 'btn small' }, 'Test sign-in');
  const costOf = c.signIn === 'cli' ? 'about 20–40k tokens of your plan’s allowance (a CLI sends its own setup with every request)' : c.signIn === 'key' ? 'a few dozen tokens, billed per token' : 'nothing billed';
  test.addEventListener('click', () => runTest(test, costOf, () => api(`/api/providers/${encodeURIComponent(c.id)}/test`, {}), c.label).then(() => view.name === 'models' && render()));

  const disconnect = h('button', { class: 'btn small danger' }, 'Remove');
  disconnect.addEventListener('click', async () => {
    const also = c.signIn === 'cli' ? ` It doesn’t sign you out of ${c.label} itself${c.command ? ` — run ${c.command.replace(' login', ' logout')} for that` : ''}.` : ' Its saved key is deleted too.';
    if (!(await confirmSheet(`Remove ${c.label}?`, `Polyphemus stops using ${v.name} through ${c.label}.${also}`, { yes: 'Remove', danger: true }))) return;
    try {
      await api(`/api/providers/${encodeURIComponent(c.id)}`, undefined, 'DELETE');
      await refresh();
      toast(`${c.label} removed.`);
      render();
    } catch (err) {
      showError(err);
    }
  });

  let form = null;
  if (c.signIn === 'cli') {
    if (c.installed === false && c.install) buttons.append(installButton(c.id, c.label, log));
    if (c.installed !== false) buttons.append(signInButton(c.id, log, { again: c.signedIn, primary: !c.ready }));
    if (c.ready) buttons.append(test);
    buttons.append(disconnect);
  } else if (c.signIn === 'key') {
    const key = h('input', { type: 'password', placeholder: c.hasKey ? 'Paste a new key to replace it' : 'Paste the API key', autocapitalize: 'none', spellcheck: 'false', autocomplete: 'off', 'aria-label': `${v.name} API key` });
    const save = h('button', { class: 'btn small primary' }, c.hasKey ? 'Replace and test' : 'Save and test key');
    save.addEventListener('click', async () => {
      if (!key.value.trim()) return key.focus();
      save.disabled = true;
      save.textContent = 'Checking…';
      try {
        const { models, problem } = await api(`/api/providers/${encodeURIComponent(c.id)}/key`, { key: key.value.trim() });
        key.value = '';
        await refresh();
        toast(problem ?? `Key saved — ${models.length} models available.`);
        render();
      } catch (err) {
        showError(err);
        save.disabled = false;
        save.textContent = c.hasKey ? 'Replace and test' : 'Save and test key';
      }
    });
    // Closed until asked for: a box per provider you might one day add a key to is a wall of
    // inputs, and a saved key is the settled case.
    form = h('div', { class: 'key-form', hidden: true }, key, save);
    const reveal = h('button', { class: `btn small ${c.hasKey || v.ready ? '' : 'primary'}` }, c.hasKey ? 'Replace key' : 'Add API key');
    reveal.addEventListener('click', () => {
      form.hidden = false;
      reveal.remove();
      key.focus();
    });
    buttons.append(reveal);
    if (c.hasKey) {
      const signOut = h('button', { class: 'btn small' }, 'Forget key');
      signOut.addEventListener('click', async () => {
        try {
          await api(`/api/providers/${encodeURIComponent(c.id)}/key`, {}, 'DELETE');
          await refresh();
          toast('Key forgotten.');
          render();
        } catch (err) {
          showError(err);
        }
      });
      buttons.append(test, signOut);
    }
    buttons.append(disconnect);
  } else {
    if (c.ready) buttons.append(test);
    buttons.append(disconnect);
  }

  return h(
    'div',
    { class: 'method' },
    h('div', { class: 'chip-line' }, h('b', {}, c.label), h('span', { class: `tag ${status[0]}` }, status[1])),
    facts.length ? h('div', { class: 'meta' }, facts.join(' · ')) : null,
    c.sandbox?.ok === false && !c.sandboxOff ? sandboxNote(c) : null,
    c.sandboxOff !== null && c.sandboxOff !== undefined && (c.sandboxOff || c.sandbox?.ok === false) ? sandboxSwitch(c) : null,
    c.ready ? allowance(c) : null,
    ...troubled.map((m) => h('div', { class: 'note bad' }, h('b', {}, modelName(m)), ` isn’t working through ${c.label}, though the sign-in is: ${clip(m.result.lastError, 200)}`)),
    form,
    c.signIn === 'key' ? h('p', { class: 'hint tight' }, c.hasKey ? 'A key is saved in your vault. Polyphemus never shows it again.' : 'The key goes to your vault and is tested before it’s kept.') : null,
    c.signIn === 'cli' && c.installed === false && c.install ? installHint(c) : null,
    buttons,
    log,
    c.signIn === 'cli' && !c.ready && c.installed !== false
      ? h('p', { class: 'hint tight' }, `Sign-in opens a browser on the computer polyphemus runs on. On your phone? Run ${c.command ?? 'its login'} there instead.`)
      : null,
  );
}

/**
 * Codex's sandbox can't start on this computer, so every command it runs fails. What's wrong, why,
 * and the machine-level fix for the owner to make themselves — polyphemus never changes the machine.
 */
function sandboxNote(c) {
  const e = c.sandbox.explanation;
  if (!e) return h('div', { class: 'note bad' }, 'Codex’s sandbox can’t start on this computer, so the commands it runs fail.');
  return h(
    'div',
    { class: 'note bad sandbox' },
    h('b', {}, e.problem),
    h('p', {}, e.why),
    ...e.fixes.map((fix) =>
      h('details', { class: 'more' }, h('summary', {}, fix.title), h('pre', { class: 'proposal' }, fix.steps.join('\n')), h('p', { class: 'hint tight' }, fix.tradeoff)),
    ),
    h('p', { class: 'hint tight' }, 'Run these yourself in a terminal on this computer: polyphemus doesn’t change system settings. It checks again every couple of minutes.'),
  );
}

/**
 * Codex without its sandbox: for a computer where the sandbox can't start and the owner would rather
 * Codex ran commands than not. Offered only there, off unless the owner turns it on, and said plainly.
 */
function sandboxSwitch(c) {
  const flip = async (on) => {
    if (!on && !(await confirmSheet(`Run ${c.label} without its sandbox?`, [
      'Every command Codex runs will have your full permissions on this computer: your files, your credentials, your network. Nothing asks you first, in any thread.',
      'Read-only work, like reviews, keeps its sandbox, so it still can’t run here.',
      'Fixing the machine instead (the steps above) keeps the sandbox. You can turn this back on any time.',
    ], { yes: 'Run without the sandbox', danger: true }))) return render();
    try {
      await api(`/api/providers/${encodeURIComponent(c.id)}/sandbox`, { on });
      await refresh();
      toast(on ? `${c.label} runs in its sandbox again.` : `${c.label} runs without its sandbox.`);
      render();
    } catch (err) {
      showError(err);
    }
  };
  return h(
    'div',
    { class: c.sandboxOff ? 'note warn' : '' },
    c.sandboxOff ? h('p', {}, h('b', {}, 'Running without its sandbox. '), 'Commands Codex runs have your full permissions, and nothing asks first. Threads say so when Codex starts work.') : null,
    toggle('Use the sandbox', c.sandboxOff ? 'Off, as you set. Turn it back on once the machine is fixed.' : 'On. Turning it off lets Codex run commands on this computer with your full permissions.', !c.sandboxOff, (on) => flip(on)),
  );
}

/** One connection's usage windows, shared by every model on it — so they're shown once, here. */
function allowance(c) {
  const readings = state.capacity.find((x) => x.provider === c.id)?.readings ?? [];
  const noun = c.signIn === 'cli' ? 'Plan allowance' : 'Usage';
  if (!readings.length) {
    return h('div', { class: 'allow' }, h('div', { class: 'allow-title' }, `${noun} — shared by every model using this way in`), h('p', { class: 'hint tight' }, c.usageFrom?.unknown ? `Unknown: ${c.usageFrom.unknown}.` : `${c.label} hasn’t reported any usage yet. It isn’t zero — it’s unknown until a turn runs.`));
  }
  return h(
    'div',
    { class: 'allow' },
    h('div', { class: 'allow-title' }, `${noun} — shared by every model using this way in`),
    ...readings.map((r) => {
      const pct = r.usedPct == null ? null : Math.round(r.usedPct);
      const stale = r.forecast?.stale === true;
      const fill = h('i', { class: pct != null && pct >= 90 && !stale ? 'high' : '' });
      fill.style.width = stale || pct == null ? '0%' : `${pct}%`;
      // The label leads with the window's name, which is already on the left.
      const label = r.label.startsWith(`${r.window} `) ? r.label.slice(r.window.length + 1) : r.label;
      const said = pct == null ? 'Not reported' : stale ? `last seen ${pct}%` : label;
      return h(
        'div',
        { class: `meter flat ${stale || pct == null ? 'stale' : ''}` },
        h('div', { class: 'meter-top' }, h('span', {}, r.window), h('span', {}, said)),
        h('div', { class: 'track' }, fill),
        r.forecast && r.forecast.status !== 'out' ? h('small', { class: `forecast ${stale ? 'stale' : r.forecast.status}` }, r.forecast.text.charAt(0).toUpperCase() + r.forecast.text.slice(1)) : null,
      );
    }),
    c.usageFrom ? h('p', { class: 'hint tight' }, `From ${c.usageFrom.source}${c.usageFrom.unknown ? ` Last look: unknown — ${c.usageFrom.unknown}.` : ''}`) : null,
  );
}

// ── Defaults & fallback tab ──

function defaultsTab() {
  const routing = { fallback: [], onFallback: 'ask', allowMetered: false, quotaRetryMinutes: 60, ...state.routing };
  const usable = state.models.filter((m) => m.ready);
  const current = modelByLabel(state.defaultModel);
  const save = async (body, said) => {
    try {
      await api('/api/routing', body);
      await refresh();
      if (said) toast(said);
      render();
    } catch (err) {
      showError(err);
    }
  };

  const pick = h('select', { id: 'default-model' }, state.defaultModel ? null : h('option', { value: '' }, 'Pick one…'));
  for (const m of usable) pick.append(h('option', { value: m.label, selected: m.label === state.defaultModel }, `${m.chosen ? modelName(m) : m.label} — ${m.provider} · ${m.how}`));
  if (state.defaultModel && !usable.some((m) => m.label === state.defaultModel)) pick.append(h('option', { value: state.defaultModel, selected: true }, `${state.defaultModel} (not connected)`));
  pick.addEventListener('change', () => pick.value && save({ defaultModel: pick.value }, 'Default saved.'));

  const choice = (value, label, detail) =>
    h(
      'button',
      { type: 'button', class: 'choice', 'aria-pressed': String(routing.onFallback === value), onclick: () => save({ onFallback: value }, null) },
      h('span', { class: 'radio' }),
      h('span', {}, h('b', {}, label), h('small', {}, detail)),
    );

  const chain = routing.fallback;
  const move = (i, by) => {
    const next = [...chain];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    save({ fallback: next }, null);
  };
  const orderRow = (label, i) => {
    const m = modelByLabel(label);
    const notes = [];
    if (m && current && m.connection === current.connection) notes.push('same allowance as the default');
    if (m?.metered && !routing.allowMetered && !current?.metered) notes.push('billed per token — skipped while that’s off');
    return h(
      'div',
      { class: 'order' },
      h('span', { class: 'rank' }, String(i + 1)),
      mark(m?.connection ?? label.split(':')[0]),
      h('span', { class: 'row-main' }, h('b', {}, m ? (m.chosen ? modelName(m) : m.label) : label), h('span', { class: 'meta' }, [m ? modelWay(m) : 'not one of your models', ...notes].join(' · '))),
      h(
        'span',
        { class: 'order-actions' },
        h('button', { class: 'nudge', 'aria-label': 'Move up', disabled: i === 0, onclick: () => move(i, -1) }, '▲'),
        h('button', { class: 'nudge', 'aria-label': 'Move down', disabled: i === chain.length - 1, onclick: () => move(i, 1) }, '▼'),
        h('button', { class: 'btn small', onclick: () => save({ fallback: chain.filter((x) => x !== label) }, null) }, 'Remove'),
      ),
    );
  };
  const spare = usable.filter((m) => m.label !== state.defaultModel && !chain.includes(m.label));
  const add = h('select', { 'aria-label': 'Add a backup' }, h('option', { value: '' }, 'Add a backup…'), ...spare.map((m) => h('option', { value: m.label }, `${m.chosen ? modelName(m) : m.label} — ${m.provider} · ${m.how}`)));
  add.addEventListener('change', () => add.value && save({ fallback: [...chain, add.value] }, null));

  const shared = chain.map(modelByLabel).filter((m) => m && current && m.connection === current.connection);
  const metered = h('button', { type: 'button', class: 'choice check', 'aria-pressed': String(routing.allowMetered), onclick: () => save({ allowMetered: !routing.allowMetered }, null) },
    h('span', { class: 'box' }),
    h('span', {}, h('b', {}, 'Allow falling back to per-token billing'), h('small', {}, routing.allowMetered
      ? 'On. If nothing on a plan can run, polyphemus may use an API key and you’ll be charged for it.'
      : 'Off. From a subscription, backups are limited to plans and your own servers — a fallback never starts a bill without your say-so.')),
  );

  return [
    h('div', { class: 'panel' },
      h('label', { class: 'field' }, h('span', {}, 'Default model'), pick,
        h('small', { class: 'hint tight' }, 'New threads use it straight away, and so does anything that doesn’t name its own model. Agents and threads with their own model keep it.'))),
    h('div', { class: 'panel' },
      h('b', { class: 'panel-title' }, 'When the default can’t run'),
      h('p', { class: 'hint tight' }, 'Because its allowance is spent, it’s down, or the sign-in has expired.'),
      h('div', { class: 'choices' },
        choice('ask', 'Ask me', 'The turn pauses and you choose from what’s ready.'),
        choice('continue', 'Use backups automatically', 'Tries the list below in order, then says what it switched to.'),
        choice('pause', 'Stop', 'The turn stops with the reason. Nothing is swapped in.'),
      ),
      h('div', { class: 'field' }, h('span', {}, 'Backups, in order'),
        chain.length ? h('div', { class: 'orders' }, chain.map(orderRow)) : h('p', { class: 'hint tight' }, routing.onFallback === 'continue' ? 'No backups yet, so there’s nothing to switch to: polyphemus will ask instead.' : 'None. When asked, polyphemus offers whatever else is ready.'),
        spare.length ? add : null),
      shared.length && current
        ? h('div', { class: 'note warn' }, h('b', {}, shared.map((m) => modelName(m)).join(', ')), ` ${shared.length === 1 ? 'shares' : 'share'} ${current.how}’s allowance with the default. If the default stops because that allowance is spent, ${shared.length === 1 ? 'this backup' : 'these backups'} will be out too.`)
        : null,
      metered,
      h('div', { class: 'summary' }, plainTerms(routing, current, chain)),
    ),
    h('div', { class: 'panel' },
      h('label', { class: 'field' }, h('span', {}, 'After a quota error that doesn’t say when it resets'), retryPick(routing, save),
        h('small', { class: 'hint tight' }, 'How long polyphemus leaves that provider alone before its next turn tries it again. Nothing is sent just to check: the next real turn is the test. A provider that says when it resets is tried again then.'))),
  ];
}

function retryPick(routing, save) {
  const words = (m) => (m < 60 ? `${m} minutes` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} hour${m === 60 ? '' : 's'}`);
  const options = [...new Set([15, 30, 60, 120, 240, 720, 1440, routing.quotaRetryMinutes])].sort((a, b) => a - b);
  const pick = h('select', { id: 'quota-retry' }, options.map((m) => h('option', { value: String(m), selected: m === routing.quotaRetryMinutes }, `Try again after ${words(m)}${m === 60 ? ' (the default)' : ''}`)));
  pick.addEventListener('change', () => save({ quotaRetryMinutes: Number(pick.value) }, `Saved: polyphemus tries again after ${words(Number(pick.value))}.`));
  return pick;
}

/** The whole policy as one sentence you could read out, so the settings above can be checked. */
function plainTerms(routing, current, chain) {
  if (!current) return 'No default yet: pick one above.';
  const way = current.metered ? `${current.how}, billed per token` : current.billedAs ? `${current.how} on ${current.billedAs}` : current.how;
  const first = `Anything that doesn’t name its own model runs ${modelName(current)} through ${current.provider}’s ${way}.`;
  const usable = chain.map(modelByLabel).filter((m) => m && (routing.allowMetered || current.metered || !m.metered));
  const names = usable.map((m) => modelName(m));
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')}, then ${names.at(-1)}` : names[0];
  const then =
    routing.onFallback === 'pause' ? ' If that can’t run, the turn stops and says why.'
    : routing.onFallback === 'continue' && names.length ? ` If that can’t run, polyphemus tries ${list} and tells you which it used.`
    : ' If that can’t run, polyphemus asks you what to use.';
  const bill = routing.allowMetered || current.metered ? ' It may fall back to a way in billed per token.' : ' It will never switch you onto per-token billing.';
  return h('span', {}, h('b', {}, 'In plain terms: '), first + then + bill);
}

// ── One model ──

async function modelDetailScreen(label) {
  const m = modelByLabel(label);
  if (!m) return location.replace('#/models');
  const health = modelHealth(m);
  const isDefault = state.defaultModel === m.label;
  const test = h('button', { class: 'btn small' }, 'Test this model');
  test.addEventListener('click', () => runTest(test, m.testCost, () => api('/api/models/test', { ref: m.label }), modelName(m)).then((r) => r && view.name === 'model' && render()));

  const connection = h('div', { id: 'model-connection' }, h('p', { class: 'hint tight' }, 'Asking which ways in there are…'));
  const agents = m.usedBy?.agents ?? [];
  const usedBy = [
    isDefault ? 'The default for new threads, and for anything that doesn’t name a model' : null,
    m.usedBy?.backup ? `Backup #${m.usedBy.backup}` : null,
    agents.length ? `${agents.length === 1 ? 'Agent' : `${agents.length} agents`}: ${agents.join(', ')}` : null,
    m.usedBy?.threads ? `${m.usedBy.threads} thread${m.usedBy.threads === 1 ? '' : 's'} on your lists` : null,
  ].filter(Boolean);

  const remove = h('button', { class: 'btn small danger', disabled: isDefault }, m.chosen ? 'Remove model' : 'Remove this profile');
  remove.addEventListener('click', async () => {
    const warn = agents.length ? `\n\n${agents.join(', ')} still name${agents.length === 1 ? 's' : ''} it: ${agents.length === 1 ? 'that agent' : 'those agents'} will need another model.` : '';
    if (!(await confirmSheet(`Remove ${m.chosen ? modelName(m) : m.label}?`, ['It comes off your models and the backup list. Nothing is signed out, and poly config undo brings it back.', warn.trim()].filter(Boolean), { yes: 'Remove', danger: true }))) return;
    try {
      if (m.chosen) await api('/api/models/remove', { ref: m.label });
      else await api(`/api/models/${encodeURIComponent(m.label)}`, undefined, 'DELETE');
      await refresh();
      toast('Removed.');
      location.replace('#/models');
    } catch (err) {
      showError(err);
    }
  });

  screen(
    bar(backButton(), h('div', { class: 'pill' }, mark(m.connection, 34), h('span', {}, m.chosen ? modelName(m) : m.label))),
    [
      h('p', { class: 'hint lede' }, modelWay(m)),
      h('div', { class: 'panel' },
        h('div', { class: 'chip-line' }, h('b', { class: 'panel-title' }, 'Status'), isDefault ? h('span', { class: 'tag accent' }, 'Default') : null, h('span', { class: `tag ${health.kind}` }, health.label)),
        h('p', { class: 'hint tight' }, health.text),
        h('div', { class: 'buttons' }, m.ready ? test : null, !isDefault && m.ready ? h('button', { class: 'btn small', onclick: () => makeDefault(m).then(() => render()) }, 'Make default') : null),
        m.ready ? h('p', { class: 'hint tight' }, `A test sends one real request: ${m.testCost}.`) : null),
      h('div', { class: 'panel' }, h('b', { class: 'panel-title' }, m.chosen ? 'Way in' : 'Points at'), connection),
      h('div', { class: 'panel' }, h('b', { class: 'panel-title' }, 'Used by'),
        usedBy.length ? h('ul', { class: 'plain-list' }, usedBy.map((line) => h('li', {}, line))) : h('p', { class: 'hint tight' }, 'Nothing uses it yet.')),
      h('div', { class: 'panel' }, h('b', { class: 'panel-title' }, 'Remove'),
        h('p', { class: 'hint tight' }, isDefault ? 'It’s the default. Make another model the default first.' : 'Takes it off your models and the backup list. It never signs you out of anything.'),
        h('div', { class: 'buttons' }, remove)),
    ],
    { mainClass: 'plain' },
  );

  if (!m.chosen) return profileTarget(m, connection);
  let providers;
  try {
    ({ providers } = await api('/api/providers'));
  } catch {
    return;
  }
  const box = $('#model-connection');
  if (!box || view.name !== 'model' || view.label !== label) return;
  const vendor = providers.find((v) => v.connections.some((c) => c.id === m.connection));
  const ways = vendor?.connections ?? [];
  const select = h('select', { id: 'connection-pick', 'aria-label': 'Way in' },
    ...ways.map((c) => h('option', { value: c.id, selected: c.id === m.connection }, `${c.label} — ${c.how}${c.ready ? '' : ' (not set up)'}`)));
  select.addEventListener('change', async () => {
    const to = ways.find((c) => c.id === select.value);
    if (!to) return;
    const extra = to.metered ? ' It’s billed per token.' : '';
    if (!(await confirmSheet(`Run ${modelName(m)} through ${to.label}?`, [extra.trim(), 'This changes it everywhere it’s named — your models, the default, the backups, and any agent on it. Threads already open keep their way in until you switch their model.'].filter(Boolean), { yes: 'Switch' }))) {
      select.value = m.connection;
      return;
    }
    try {
      const { to: ref, changed } = await api('/api/models/move', { ref: m.label, connection: to.id });
      await refresh();
      toast(`Moved to ${to.label}${changed.length > 1 ? `: ${changed.join(', ')}` : ''}.`);
      location.replace(`#/models/${encodeURIComponent(ref)}`);
    } catch (err) {
      select.value = m.connection;
      showError(err);
    }
  });
  fill(box, 
    ways.length > 1
      ? h('label', { class: 'field tight' }, select, h('small', { class: 'hint tight' }, 'Which way in this model uses. What it can do and how it’s billed can differ between them.'))
      : h('p', { class: 'hint tight' }, `${m.how} is the only way in to ${m.provider} set up. Add another under Providers to move it.`),
  );
}

/** A profile points at a model on one connection; pointing it elsewhere moves everything using the name. */
async function profileTarget(m, box) {
  let offered = [];
  try {
    ({ models: offered } = await api(`/api/providers/${encodeURIComponent(m.connection)}/models`));
  } catch {
    // Offline or signed out: say what it points at, without a picker.
  }
  if (view.name !== 'model' || view.label !== m.label) return;
  const current = m.target.slice(m.connection.length + 1);
  const ids = offered.map((x) => x.id);
  if (!ids.length) return fill(box, h('p', { class: 'hint tight' }, `${m.target}`));
  const pick = h('select', { id: 'model-id' }, ...(ids.includes(current) ? ids : [current, ...ids]).map((id) => h('option', { value: id, selected: id === current }, id === 'default' ? 'default — let it choose' : id)));
  pick.addEventListener('change', async () => {
    try {
      await api(`/api/models/${encodeURIComponent(m.label)}`, { model: pick.value });
      await refresh();
      toast(`${m.label} now uses ${pick.value}.`);
      render();
    } catch (err) {
      showError(err);
    }
  });
  fill(box, h('label', { class: 'field tight' }, pick, h('small', { class: 'hint tight' }, `On ${m.how}. Change it and everything using ${m.label} follows.`)));
}

// ── First run ──
// Four steps, in the order the thing works: where models come from, which ones, which is the
// default, and done. What's already signed in on this computer is offered first — for most people
// that's the whole of step one — and nothing is added to the config until you accept it.

async function setupScreen() {
  const wizard = { step: 1, source: null, picked: new Set(), offered: [], def: null };
  const holder = h('div', { class: 'wizard' });
  screen(bar(backButton(), title('Set up your models')), holder, { mainClass: 'plain' });

  let sources = [];
  try {
    const [{ catalogue }, { providers }] = await Promise.all([api('/api/catalogue'), api('/api/providers')]);
    const configured = new Map(providers.flatMap((v) => v.connections.map((c) => [c.id, { ...c, vendor: v.name }])));
    // CLIs on this computer, whether or not polyphemus knows them yet, then any key already saved.
    sources = [
      // Every subscription CLI, installed or not: one that isn't can be installed from here, and one
      // that is but isn't signed in can be signed in to — setup used to stop at "nothing is signed in".
      ...catalogue.filter((e) => e.connect === 'cli' && (e.installed || e.install)).map((e) => ({
        id: e.id,
        name: e.name,
        vendor: e.vendor,
        detail: [e.vendor, e.account, e.about].filter(Boolean).join(' · '),
        // "Ready" for a CLI used to mean installed, so a signed-out Grok could be picked, and the
        // first message failed with "Authentication required" (2026-09-23).
        ready: e.installed === true && e.signedIn !== false && (e.signedIn === true || configured.get(e.id)?.ready === true),
        install: e.installed ? null : e.install,
        onWindows: e.onWindows === true,
        signIn: e.installed === true && e.signedIn === false,
        about: e.about,
        why: !e.installed ? (e.onWindows ? 'installed on Windows, not in Linux' : 'not installed here') : e.signedIn === false ? 'installed, not signed in' : null,
        // Usable, but worth knowing before picking it; the fix is on its card in Models & providers.
        warn: e.sandbox?.ok === false ? 'Its sandbox can’t start on this computer, so commands it runs will fail — Models & providers shows the fix.' : null,
        configured: e.configured,
        offered: configured.get(e.id)?.offered === true,
      })),
      ...[...configured.values()].filter((c) => c.signIn !== 'cli' && (c.ready || (c.offered && c.hasKey))).map((c) => ({ id: c.id, name: `${c.vendor} ${c.label}`, vendor: c.vendor, detail: `${c.vendor} · ${c.how}`, ready: true, configured: true, offered: c.offered })),
    ];
  } catch (err) {
    showError(err);
  }
  if (view.name !== 'setup') return;
  if (setupPick) {
    wizard.source = sources.find((s) => s.id === setupPick && s.ready) ?? null;
    setupPick = null;
  }

  const steps = () => h('div', { class: 'wiz-steps', 'aria-label': `Step ${wizard.step} of 5` }, [1, 2, 3, 4, 5].map((n) => h('i', { class: n <= wizard.step ? 'on' : '' })));
  const foot = (back, next, skip = true) =>
    h('div', { class: 'wiz-foot' },
      back ? h('button', { class: 'btn', onclick: back }, 'Back') : h('span'),
      h('div', { class: 'buttons' },
        // Remembered, or Models, which sends anyone with no model picked into setup, sent them straight back.
        skip ? h('button', { class: 'btn', onclick: () => { setupSkipped = true; location.replace('#/models'); } }, 'Skip for now') : null,
        next));

  const draw = async () => {
    const nextButton = (label, onclick, disabled = false) => h('button', { class: 'btn primary', disabled, onclick }, label);
    if (wizard.step === 1) {
      // Ready ones are choices; the rest say what they need, and do it here.
      const needs = (s) => {
        const log = h('pre', { class: 'proposal', hidden: true });
        // Back to this step with what was just set up already picked: redrawn from the top with
        // nothing chosen, it read as being taken through setup a second time (2026-09-23).
        const again = () => { setupPick = s.id; setupScreen(); };
        const action = s.install ? installButton(s.id, s.name, log, again) : s.signIn ? signInButton(s.id, log, { after: again }) : null;
        return h('div', { class: 'choice needs' },
          h('span', {}, h('b', {}, s.name), h('small', {}, s.install ? (s.about ?? s.vendor) : `${s.about ?? s.vendor} · ${s.why ?? 'not ready'}`), s.install ? installHint(s) : null),
          action ? h('div', { class: 'buttons' }, action) : null,
          log);
      };
      const options = [...sources.filter((s) => s.ready), ...sources.filter((s) => !s.ready)].map((s) =>
        !s.ready ? needs(s) :
        h('button', { type: 'button', class: 'choice', 'aria-pressed': String(wizard.source?.id === s.id), onclick: () => { wizard.source = s; draw(); } },
          h('span', { class: 'radio' }),
          h('span', {}, h('b', {}, s.name), h('small', {}, s.detail), s.warn ? h('small', { class: 'warn-text' }, s.warn) : null)));
      fill(holder, 
        steps(),
        h('h2', { class: 'wiz-title' }, 'Where should models come from?'),
        h('p', { class: 'hint tight' }, sources.some((s) => s.ready)
          ? 'Pick one to start with — you can add more later.'
          : 'Nothing is signed in on this computer yet. Have a Claude, ChatGPT or SuperGrok plan? Install its CLI below and sign in. Only have an API key? Connect a provider instead.'),
        options.length ? h('div', { class: 'choices' }, options) : null,
        h('button', { class: 'linky', onclick: () => go('#/add-provider') }, sources.some((s) => s.ready) ? 'Connect a different provider instead' : 'Connect a provider with an API key'),
        foot(null, nextButton('Continue', async (e) => {
          const s = wizard.source;
          e.currentTarget.disabled = true;
          try {
            // Accepting an offer is what puts it in use — not having it installed.
            if (!s.configured) await api('/api/providers', { id: s.id });
            else if (s.offered) await api(`/api/providers/${encodeURIComponent(s.id)}/accept`, {});
            ({ models: wizard.offered } = await api(`/api/providers/${encodeURIComponent(s.id)}/models`));
            wizard.step = 2;
          } catch (err) {
            showError(err);
          }
          draw();
        }, !wizard.source)),
      );
    } else if (wizard.step === 2) {
      const s = wizard.source;
      const rows = wizard.offered.map((o) => {
        const ref = `${s.id}:${o.id}`;
        return h('button', { type: 'button', class: 'choice check', 'aria-pressed': String(wizard.picked.has(ref)), onclick: () => { wizard.picked.has(ref) ? wizard.picked.delete(ref) : wizard.picked.add(ref); draw(); } },
          h('span', { class: 'box' }),
          h('span', {}, h('b', {}, o.id === 'default' ? 'Let it choose' : o.id), h('small', {}, [o.name && o.name !== o.id ? o.name : null, o.contextWindow ? `${bigTokens(o.contextWindow)} context` : null].filter(Boolean).join(' · ') || s.vendor)));
      });
      fill(holder, 
        steps(),
        h('h2', { class: 'wiz-title' }, 'Choose models to use'),
        h('p', { class: 'hint tight' }, `Available through ${s.name}. Tick as many as you like.`),
        rows.length ? h('div', { class: 'choices' }, rows) : h('p', { class: 'empty' }, 'It didn’t list any models.'),
        h('div', { class: 'note' }, 'Each one is confirmed the first time it runs — your plan decides what you can reach, not this list.'),
        foot(() => { wizard.step = 1; draw(); }, nextButton('Continue', async (e) => {
          e.currentTarget.disabled = true;
          try {
            const { defaultModel } = await api('/api/selected', { selected: [...new Set([...(state.selected ?? []), ...wizard.picked])] });
            await refresh();
            wizard.def = defaultModel && wizard.picked.has(defaultModel) ? defaultModel : [...wizard.picked][0];
            wizard.step = 3;
          } catch (err) {
            showError(err);
          }
          draw();
        }, wizard.picked.size === 0)),
      );
    } else if (wizard.step === 3) {
      const options = [...wizard.picked].map((ref) =>
        h('button', { type: 'button', class: 'choice', 'aria-pressed': String(wizard.def === ref), onclick: () => { wizard.def = ref; draw(); } },
          h('span', { class: 'radio' }),
          h('span', {}, h('b', {}, ref.slice(ref.indexOf(':') + 1)), h('small', {}, wizard.source.name))));
      fill(holder, 
        steps(),
        h('h2', { class: 'wiz-title' }, 'Pick a default'),
        h('p', { class: 'hint tight' }, 'Used by any thread or agent that doesn’t name its own model.'),
        h('div', { class: 'choices' }, options),
        h('p', { class: 'hint tight' }, 'If it can’t run, polyphemus will ask you what to do. Automatic backups are under Defaults & fallback.'),
        foot(() => { wizard.step = 2; draw(); }, nextButton('Continue', async (e) => {
          e.currentTarget.disabled = true;
          try {
            await api('/api/routing', { defaultModel: wizard.def });
            await refresh();
            wizard.step = 4;
          } catch (err) {
            showError(err);
          }
          draw();
        }, !wizard.def)),
      );
    } else if (wizard.step === 4) {
      // The agent you talk to when you haven't picked another: never no one.
      const existing = state.defaultAgent ? (state.agents ?? []).find((a) => a.id === state.defaultAgent) : null;
      wizard.agentTitle ??= existing?.title ?? 'Helm';
      wizard.personality ??= 'plain';
      const name = h('input', { id: 'wiz-agent-name', value: wizard.agentTitle, maxlength: 40, autocomplete: 'off', spellcheck: 'false' });
      name.addEventListener('input', () => (wizard.agentTitle = name.value));
      const own = h('textarea', { id: 'wiz-agent-words', rows: 2, placeholder: 'Like: dry, a little funny, never wordy.' }, wizard.words ?? '');
      own.addEventListener('input', () => (wizard.words = own.value));
      const voices = [['plain', 'Plain and direct', 'The answer first, short sentences, no filler.'], ['warm', 'Warm and encouraging', 'Friendly, explains the why when it helps.'], ['thorough', 'Curious and thorough', 'Checks its work and asks what matters first.'], ['own', 'In your own words', 'Describe how it should come across.']];
      fill(holder, 
        steps(),
        h('h2', { class: 'wiz-title' }, 'Who you’ll be talking to'),
        h('p', { class: 'hint tight' }, 'A thread you start without picking an agent is with this one. You can rename it, change how it comes across, or make more agents in Team.'),
        h('label', { class: 'field' }, h('span', {}, 'Its name'), name),
        h('div', { class: 'choices' }, voices.map(([id, label, about]) =>
          h('button', { type: 'button', class: 'choice', 'aria-pressed': String(wizard.personality === id), onclick: () => { wizard.personality = id; wizard.agentTitle = name.value; draw(); } },
            h('span', { class: 'radio' }), h('span', {}, h('b', {}, label), h('small', {}, about))))),
        h('div', {}, wizard.personality === 'own' ? h('label', { class: 'field' }, h('span', {}, 'How it comes across'), own) : null),
        foot(() => { wizard.step = 3; draw(); }, nextButton('Continue', async (e) => {
          e.currentTarget.disabled = true;
          try {
            await api('/api/default-agent', { title: name.value.trim(), personality: wizard.personality, words: wizard.words ?? '' });
            await refresh();
            wizard.step = 5;
          } catch (err) {
            showError(err);
          }
          draw();
        })),
      );
    } else {
      const ready = [...wizard.picked].map(modelByLabel).filter(Boolean);
      fill(holder, 
        steps(),
        h('div', { class: 'done-mark' }, '✓'),
        h('h2', { class: 'wiz-title' }, `${ready.length === 1 ? 'One model is' : `${ready.length} models are`} ready`),
        h('p', { class: 'hint tight' }, `Connected to ${wizard.source.vendor} through ${wizard.source.name}.`),
        h('div', { class: 'panel-list' }, ready.map((m) =>
          h('div', { class: 'mcard' }, h('div', { class: 'mcard-top static' }, mark(m.connection), h('span', { class: 'row-main' },
            h('span', { class: 'chip-line' }, h('b', {}, modelName(m)), state.defaultModel === m.label ? h('span', { class: 'tag accent' }, 'Default') : null),
            h('span', { class: 'meta' }, modelWay(m))))))),
        // Setup asks where agents run (isolation.md, decided): the owner's risk, chosen knowingly.
        state.isolation ? [h('h2', { class: 'wiz-title' }, 'Where should agents run?'), isolationSetting()] : null,
        foot(null, nextButton('Start working', () => location.replace('#/')), false),
      );
    }
  };
  draw();
}

// ── You: usage, notifications, devices ───────────────────────────────────

function youScreen() {
  const ready = state.models.filter((m) => m.ready);
  const notReady = state.models.filter((m) => !m.ready);
  // Only providers a chosen model uses: a meter for something nobody picked from is noise.
  const using = new Set(state.models.map((m) => m.connection ?? m.target.split(':')[0]));
  const meters = state.capacity.filter((c) => using.has(c.provider)).flatMap((c) =>
    c.readings.map((r) => {
      const pct = r.usedPct == null ? null : Math.round(r.usedPct);
      const forecast = r.forecast && r.forecast.status !== 'out' ? r.forecast : null;
      // A reading only arrives when a turn runs, so it can be hours old. Showing a frozen number
      // as though it were live is how polyphemus claimed codex was at 98% after it had reset.
      const stale = forecast?.stale === true;
      const fill = h('i', { class: pct != null && pct >= 90 && !stale ? 'high' : '' });
      fill.style.width = stale ? '0%' : `${pct ?? 0}%`;
      return h(
        'div',
        { class: `meter ${stale ? 'stale' : ''}` },
        h(
          'div',
          { class: 'meter-top' },
          h('span', {}, `${c.provider} · ${r.window}`),
          h('span', {}, stale ? `last seen ${pct}%` : r.label),
        ),
        h('div', { class: 'track' }, fill),
        forecast ? h('small', { class: `forecast ${stale ? 'stale' : forecast.status}` }, forecast.text.charAt(0).toUpperCase() + forecast.text.slice(1)) : null,
      );
    }),
  );
  const devices = state.devices.map((d) =>
    h(
      'div',
      { class: 'item' },
      icon(/phone|Android|iPhone/i.test(d.name) ? 'phone' : 'screen'),
      h('span', { class: 'grow' }, h('span', {}, d.name), h('small', {}, d.current ? 'This device' : d.lastSeenAt ? `Last seen ${agoWords(d.lastSeenAt)}` : 'Never connected')),
      d.current
        ? null
        : h('button', { class: 'btn ghost small danger-text', onclick: async (event) => {
            const button = event.currentTarget;
            if (!(await confirmSheet(`Sign out ${d.name}?`, ['It stops getting updates and notifications straight away, and has to be paired again to come back.', 'Nothing on it is deleted from polyphemus.'], { yes: 'Sign it out', danger: true }))) return;
            button.disabled = true;
            try {
              await api(`/api/devices/${encodeURIComponent(d.id)}/revoke`, {});
              await refresh();
              render();
              toast(`${d.name} is signed out.`);
            } catch (err) {
              button.disabled = false;
              showError(err);
            }
          } }, 'Sign out'),
    ),
  );
  const update = state.update;
  const updateBanner = update?.newer
    ? h(
        'div',
        { class: 'banner update' },
        h('p', {}, h('b', {}, `polyphemus ${update.latest} is out`), ` — you have ${update.current}.`),
        h('p', {}, 'On this computer, run ', h('code', {}, 'poly update'), '. It installs it and restarts the service.'),
        h('a', { class: 'linky', href: 'https://www.npmjs.com/package/polyphemus?activeTab=versions', target: '_blank', rel: 'noopener' }, 'What’s new'),
      )
    : null;
  const about = update
    ? h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'item' },
          h('span', { class: 'grow' }, h('span', {}, `polyphemus ${update.current}`), h('small', {},
            update.installedFrom === 'checkout' ? 'Run from a checkout of its repository: updated with git, then poly service update.'
            : !update.checking ? 'Not checking for updates (updates.check = false).'
            : update.newer ? `${update.latest} is out.`
            : update.checkedAt ? `The newest — checked ${agoWords(update.checkedAt)}.`
            : 'Checks npm for a newer version once a day.')),
        ),
        update.installedFrom === 'npm'
          ? h('div', { class: 'item' }, h('span', { class: 'grow' }, h('span', {}, update.channel === 'beta' ? 'Betas, and stable releases' : 'Stable releases'), h('small', {}, update.channel === 'beta' ? 'Switch back: poly update --channel stable' : 'For betas too: poly update --channel beta')))
          : null,
        h('a', { class: 'item', href: 'https://polyphemus.ai', target: '_blank', rel: 'noopener' }, h('span', { class: 'grow' }, h('span', {}, 'polyphemus.ai'), h('small', {}, 'What it is, how to install it, and the docs'))),
      )
    : null;
  screen(
    bar(title('Setup')),
    [
      updateBanner,
      isOwner() ? sec('Models', ready.length) : null,
      !isOwner() ? null : h(
        'button',
        { class: 'row chevroned', onclick: () => go('#/models') },
        mark(state.defaultModel ? (state.models.find((m) => m.label === state.defaultModel)?.target ?? '').split(':')[0] : 'models'),
        h(
          'span',
          { class: 'row-main' },
          h('span', { class: 'row-top' }, h('b', {}, 'Models & providers'), notReady.length ? h('span', { class: 'tag warn' }, `${notReady.length} not running`) : null),
          h(
            'span',
            { class: 'row-sub' },
            h('span', { class: 'text' }, ready.length ? `${ready.length} ready · ${state.defaultModel ?? 'no default yet'}` : 'Nothing ready yet — set one up'),
          ),
        ),
        icon('chev', 'ico mini'),
      ),
      isOwner() && state.isolation ? [sec('Where agents run'), isolationSetting()] : null,
      // Routines that belong to no project are the install's own: this is where they live, and each
      // one is also on the page of the agent that runs it.
      isOwner() ? routinesCard((state.routines ?? []).filter((r) => !r.project)) : null,
      sec('Connections', state.connectionCount || ''),
      connectionsRow(),
      isOwner() ? sec('Usage') : null,
      isOwner() ? (meters.length ? h('div', { class: 'card' }, meters) : h('p', { class: 'empty' }, 'Usage shows up after a turn.')) : null,
      sec('Notifications'),
      notificationSettings(),
      sec('Conversations'),
      viewSetting(),
      sec('Theme'),
      themeSetting(),
      sec('Devices', devices.length || ''),
      h('div', { class: 'card' }, devices.length ? devices : h('p', { class: 'empty', style: 'padding:12px 14px' }, 'No devices.')),
      h('p', { class: 'hint' }, isOwner() ? 'Pair another device from your computer: poly pair.' : 'To add another device, ask the owner of this install to pair it for you.'),
      about ? [sec('About'), about] : null,
    ],
    { tabs: true },
  );
}

/**
 * Where agents' commands and file changes run, for the whole install: the owner's risk tolerance
 * (docs/design/isolation.md). Loosening it is confirmed; isolating needs Docker or Podman here.
 */
function isolationSetting() {
  const iso = state.isolation;
  const pick = async (level) => {
    if (level === iso.level) return;
    if (level !== 'host' && !iso.runtime) {
      return confirmSheet('Isolating needs Docker or Podman', ['There’s no container runtime on this computer, so agents can’t run in a worker yet.', 'Install Docker (docs.docker.com/engine/install) or Podman, then choose this again. Until then, agents run on this computer.'], { yes: 'OK', no: 'Close' });
    }
    const looser = iso.levels.findIndex((l) => l.id === level) > iso.levels.findIndex((l) => l.id === iso.level);
    const words = iso.levels.find((l) => l.id === level);
    if (looser && !(await confirmSheet(`Run agents ${words.title.toLowerCase()}?`, [words.says, 'Projects set to something stricter keep their own setting.'], { yes: `Use ${words.title}`, danger: level === 'host' }))) return;
    try {
      await api('/api/isolation', { level });
      await refresh();
      toast(`Agents now run: ${words.title}.`);
      render();
    } catch (err) {
      showError(err);
    }
  };
  const runtime = iso.runtime
    ? `${iso.runtime.name} ${iso.runtime.version}${iso.runtime.rootless ? ', rootless' : ' (anything that can use it is root on this computer: polyphemus never gives its socket to an agent)'}`
    : 'No Docker or Podman on this computer, so only “On this computer” is available.';
  return h(
    'div',
    { class: 'panel' },
    h('div', { class: 'choices' },
      iso.levels.map((l) =>
        h('button', { type: 'button', class: 'choice', 'aria-pressed': String(l.id === iso.level), disabled: l.id !== 'host' && !iso.runtime && l.id !== iso.level, onclick: () => pick(l.id) },
          h('span', { class: 'radio' }),
          h('span', {}, h('b', {}, l.title), h('small', {}, l.says))),
      ),
    ),
    h('p', { class: 'hint tight' }, `Workers run with ${runtime}. A project can be set stricter on its Setup tab. Claude Code, Codex and Grok Build run isolated too; each is checked once per version, and isn’t used isolated if a command slips past its worker. Workflow runs work in a clone of their own, with their checks, previews and pages in a worker too. While isolated, Codex can’t use connections.`),
  );
}

/** Where agents run in a project (or outside one): its level's id, title and what it means. */
function isolationHere(project) {
  const iso = state.isolation;
  if (!iso) return null;
  const id = project?.isolation?.applies ?? iso.level;
  return iso.levels.find((l) => l.id === id) ?? null;
}

/** Why a model won't start where agents run here, or null. */
const isolationStops = (level, m) => (level && level.id !== 'host' && m?.notIsolated ? m.notIsolated : null);

/** Where a thread's commands and file changes run, what that means, and where it's changed. */
function isolationSheet(project, m) {
  const level = isolationHere(project);
  if (!level) return;
  const stops = isolationStops(level, m);
  const change = project ? `#/p/${encodeURIComponent(project.slug)}?tab=setup` : '#/setup';
  const wrap = sheet(`Agents run: ${level.title}`, [
    h('p', { class: 'hint tight' }, level.says),
    stops ? h('p', { class: 'hint tight warnish' }, `${stops} Pick another model for this thread, or run agents on this computer here.`) : null,
    h('p', { class: 'hint tight' }, project ? `Set for ${project.name}${project.isolation?.own ? '' : ', from this install’s setting'}.` : 'This install’s setting, for threads outside a project.'),
    isOwner() ? h('button', { class: 'btn wide', onclick: () => (wrap.remove(), go(change)) }, project ? `Change it for ${project.name}` : 'Change it in Setup') : null,
  ]);
}

/** A project's own level: the install's, or stricter. */
function projectIsolation(p) {
  const iso = state.isolation;
  if (!iso || !p.isolation) return null;
  const install = iso.levels.find((l) => l.id === iso.level);
  const stricter = iso.levels.slice(0, iso.levels.findIndex((l) => l.id === iso.level));
  const applies = iso.levels.find((l) => l.id === p.isolation.applies);
  const select = h('select', { 'aria-label': 'Where agents run here', disabled: !isOwner() },
    h('option', { value: '', selected: !p.isolation.own }, `Same as this install: ${install.title}`),
    ...stricter.map((l) => h('option', { value: l.id, selected: p.isolation.own === l.id }, l.title)),
  );
  select.addEventListener('change', async () => {
    try {
      await api(`/api/projects/${encodeURIComponent(p.slug)}/isolation`, { level: select.value || null });
      await refresh();
      render();
    } catch (err) {
      showError(err);
    }
  });
  // Only stricter than the install is offered here; say where looser is chosen, or a one-option list looks broken.
  const looser = iso.levels.findIndex((l) => l.id === iso.level) > 0
    ? null
    : h('small', { class: 'hint tight' }, 'A project can only be stricter than this install, and Isolated is the strictest. To let agents here reach more, grant hosts below, or change the install’s level in ', isOwner() ? h('button', { type: 'button', class: 'linky inline', onclick: () => go('#/setup') }, 'Setup') : 'Setup', '.');
  return h('div', { class: 'panel' }, h('label', { class: 'field' }, h('span', {}, 'Where agents run here'), select, h('small', { class: 'hint tight' }, applies.says), looser), projectNetwork(p));
}

/**
 * What agents here may reach on the network while isolated: nothing, unless a preset or a host is
 * granted. Hosts agents were refused lately are offered, so a grant follows from what actually happened.
 */
function projectNetwork(p) {
  const applies = p.isolation.applies;
  if (applies === 'host') return null;
  if (applies === 'isolated-open') return h('p', { class: 'hint tight' }, 'Network: any public host, through polyphemus’s proxy. Never this computer or your local network.');
  const net = p.network ?? { presets: [], hosts: [], refused: [] };
  const owner = isOwner();
  const save = async (next) => {
    try {
      await api(`/api/projects/${encodeURIComponent(p.slug)}/network`, next);
      await refresh();
      render();
    } catch (err) {
      showError(err);
    }
  };
  const presets = (state.isolation?.presets ?? []).map((preset) => {
    const on = net.presets.includes(preset.id);
    return h('button', { type: 'button', class: 'choice check', 'aria-pressed': String(on), disabled: !owner, onclick: () => save({ presets: on ? net.presets.filter((id) => id !== preset.id) : [...net.presets, preset.id], hosts: net.hosts }) },
      h('span', { class: 'box' }), h('span', {}, h('b', {}, preset.title), h('small', {}, preset.says)));
  });
  const input = h('input', { type: 'text', placeholder: 'api.example.com or *.example.com', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Host to grant' });
  const add = () => {
    const host = input.value.trim();
    if (!host) return input.focus();
    save({ presets: net.presets, hosts: [...net.hosts, host] });
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), add()));
  return h('div', { class: 'network' },
    h('b', { class: 'network-title' }, 'Network'),
    h('small', { class: 'hint tight' }, 'None unless granted. Granted hosts are reached through polyphemus’s proxy on ports 80 and 443 — never this computer or your local network.'),
    h('div', { class: 'choices' }, presets),
    net.hosts.length ? h('div', { class: 'chips' }, net.hosts.map((host) => h('span', { class: 'chip host' }, h('span', { class: 'mono' }, host), owner ? h('button', { type: 'button', class: 'linky inline', 'aria-label': `Stop granting ${host}`, onclick: () => save({ presets: net.presets, hosts: net.hosts.filter((x) => x !== host) }) }, '×') : null))) : null,
    owner ? h('div', { class: 'network-add' }, input, h('button', { type: 'button', class: 'btn', onclick: add }, 'Grant')) : null,
    net.refused?.length
      ? h('div', { class: 'network-refused' },
          h('small', { class: 'hint tight' }, 'Refused lately:'),
          h('div', { class: 'chips' }, net.refused.map((r) => owner
            ? h('button', { type: 'button', class: 'chip', title: ago(r.at) === 'now' ? 'Refused just now' : `Refused ${ago(r.at)} ago`, onclick: () => save({ presets: net.presets, hosts: [...net.hosts, r.host] }) }, `Grant ${r.host}`)
            : h('span', { class: 'chip mono' }, r.host))))
      : null,
  );
}

/** Compact or Detailed, for this device. */
/** Light, dark or this device's own setting: the same choice as the button in the top bar. */
function themeSetting() {
  const buttons = THEMES.map((t) => h('button', { type: 'button', 'aria-pressed': String(theme() === t.id) }, t.label));
  buttons.forEach((button, i) =>
    button.addEventListener('click', () => {
      setTheme(THEMES[i].id);
      buttons.forEach((b, n) => b.setAttribute('aria-pressed', String(n === i)));
      render();
    }),
  );
  return h(
    'div',
    { class: 'card', style: 'padding:12px 14px;display:grid;gap:10px' },
    h('div', { class: 'segmented', style: 'background:var(--surface)' }, buttons),
    h('small', { style: 'color:var(--muted);font-size:13px' }, 'System follows this device. It’s kept on this device, so your phone and your computer can differ.'),
  );
}

function viewSetting() {
  const compact = h('button', { type: 'button', 'aria-pressed': String(viewMode() === 'compact') }, 'Compact');
  const detailed = h('button', { type: 'button', 'aria-pressed': String(viewMode() === 'detailed') }, 'Detailed');
  const pick = (mode) => {
    setViewMode(mode);
    compact.setAttribute('aria-pressed', String(mode === 'compact'));
    detailed.setAttribute('aria-pressed', String(mode === 'detailed'));
  };
  compact.addEventListener('click', () => pick('compact'));
  detailed.addEventListener('click', () => pick('detailed'));
  return h(
    'div',
    { class: 'card', style: 'padding:12px 14px;display:grid;gap:10px' },
    h('div', { class: 'segmented', style: 'background:var(--surface)' }, compact, detailed),
    h('small', { style: 'color:var(--muted);font-size:13px' }, 'Compact folds each reply’s steps into one line with the time and tokens; tap it to see them. Detailed shows every command and file. Approvals and errors always show.'),
  );
}

function notificationSettings() {
  const kinds = state.push.kinds ?? ['questions', 'finished'];
  const saveKind = (kind) => async (on) => {
    const next = on ? [...new Set([...kinds, kind])] : kinds.filter((k) => k !== kind);
    try {
      state.push.kinds = (await api('/api/push/settings', { kinds: next })).kinds;
    } catch (err) {
      showError(err);
    }
  };
  if (push === 'on') {
    return [
      h(
        'div',
        { class: 'card' },
        toggle('When a thread needs you', 'Approvals, questions and model switches', kinds.includes('questions'), saveKind('questions')),
        toggle('When a thread finishes', 'Skipped while polyphemus is open on screen', kinds.includes('finished'), saveKind('finished')),
        h('button', { class: 'item link', onclick: sendTest }, 'Send a test'),
        h('button', { class: 'item', style: 'color:var(--danger)', onclick: disablePush }, 'Turn off on this device'),
      ),
    ];
  }
  const message = {
    off: 'Off on this device.',
    blocked: 'Blocked in this browser. Allow notifications in its site settings, then come back.',
    insecure: 'Notifications need the secure address.',
    unsupported: 'This browser can’t show notifications from polyphemus.',
  }[push];
  return h(
    'div',
    { class: 'banner' },
    h('p', {}, message),
    pushProblem ? h('p', { class: 'problem' }, pushProblem) : null,
    push === 'off' ? h('button', { class: 'btn primary', onclick: enablePush }, pushProblem ? 'Try again' : 'Turn on') : null,
    push === 'insecure' ? h('a', { class: 'btn primary', href: `${state.push.httpsUrl}/`, style: 'text-align:center;text-decoration:none' }, 'Switch to it') : null,
  );
}

function pushBanner() {
  if (push !== 'off' || remembered('polyphemus.pushOff') === '1') return null;
  return h(
    'div',
    { class: 'banner' },
    h('p', {}, 'Get a notification when a session needs you or finishes.'),
    pushProblem ? h('p', { class: 'problem' }, pushProblem) : null,
    h(
      'div',
      { class: 'buttons' },
      h('button', { class: 'btn primary', onclick: enablePush }, pushProblem ? 'Try again' : 'Turn on'),
      h('button', { class: 'btn', onclick: () => (remember('polyphemus.pushOff', '1'), redraw()) }, 'Not now'),
    ),
  );
}

async function setupPush() {
  if (!window.isSecureContext) return (push = state.push.httpsUrl ? 'insecure' : 'unsupported');
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !state.push.publicKey) return (push = 'unsupported');
  const registration = await navigator.serviceWorker.register('/sw.js');
  // While you're looking at the app, a notification comes here instead of the operating system.
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type !== 'polyphemus-push') return;
    // Not for the thread you're reading: you can see it happen (2026-09-19).
    const about = /#\/s\/(\w+)/.exec(String(event.data.url ?? ''))?.[1];
    if (about && view.name === 'session' && current?.meta.id === about) return;
    const text = [event.data.title, event.data.body].filter(Boolean).join(' · ');
    toast(clip(text, 140), '', event.data.url ? () => go(event.data.url.replace(/^\//, '')) : undefined);
  });
  if (Notification.permission === 'denied') return (push = 'blocked');
  const subscription = await registration.pushManager.getSubscription();
  if (subscription && Notification.permission === 'granted') {
    await api('/api/push/subscribe', { subscription: subscription.toJSON() }); // keeps it tied to this device
    return (push = 'on');
  }
  push = 'off';
}

async function enablePush(event) {
  // Signing up with the push service can take a while the first time: show that it's working.
  const button = event?.currentTarget;
  if (button) {
    button.disabled = true;
    button.textContent = 'Turning on…';
  }
  let step = 'asking for permission';
  try {
    if ((await Notification.requestPermission()) !== 'granted') {
      push = 'blocked';
      return redraw();
    }
    step = 'starting the notification helper';
    const registration = await withTimeout(navigator.serviceWorker.ready, 10000, 'it didn’t start');
    step = 'signing up with the browser’s push service';
    // A subscription the browser kept from before may have expired (reinstalling the app does
    // that), and reusing it fails quietly. Always start fresh.
    await (await registration.pushManager.getSubscription())?.unsubscribe();
    const subscription = await withTimeout(
      registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(state.push.publicKey) }),
      30000,
      'no answer after 30 seconds',
    );
    step = 'saving it on your computer';
    await api('/api/push/subscribe', { subscription: subscription.toJSON() });
    step = 'sending a test notification';
    const { delivered } = await api('/api/push/test', {});
    if (!delivered) throw new Error('the push service turned it away');
    state.push.kinds = (await api('/api/state')).push.kinds;
    push = 'on';
    pushProblem = '';
    remember('polyphemus.pushOff', '');
    toast('Notifications are on.');
  } catch (err) {
    pushProblem = `Couldn’t turn on notifications while ${step}: ${err.name && err.name !== 'Error' ? `${err.name}: ` : ''}${err.message}`;
    api('/api/push/problem', { message: pushProblem, userAgent: navigator.userAgent }).catch(() => {});
  }
  redraw();
}

async function disablePush() {
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    await api('/api/push/unsubscribe', {});
    await subscription?.unsubscribe();
    push = 'off';
    state.push.kinds = null;
    remember('polyphemus.pushOff', '1'); // you chose this: no "turn on" banner on Home
    toast('Notifications are off on this device.');
  } catch (err) {
    showError(err);
  }
  redraw();
}

async function sendTest() {
  try {
    await api('/api/push/test', {});
    toast('Sent. It should arrive in a few seconds.');
  } catch (err) {
    showError(err);
  }
}

function withTimeout(promise, ms, message) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}

function base64UrlToBytes(text) {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

// ── Starting something ───────────────────────────────────────────────────


function modelOptions(selected) {
  return state.models.map((m) => h('option', { value: m.label, selected: m.label === selected }, `${m.label}${m.ready ? (m.out ? ' (out)' : '') : ' (not set up)'}`));
}

/**
 * Pick a model the way you'd say it out loud: the company first, then one of its models. Grouped
 * rather than one flat list of ids, because "Anthropic → Opus" is how the choice is actually made.
 * `blank` is what an empty value means here — inheriting, or no fallback.
 */
function modelPicker(id, current, blank) {
  const usable = state.models.filter((m) => m.ready);
  const picker = h('select', { id }, h('option', { value: '' }, blank));
  for (const [provider, list] of byProvider(usable)) {
    const group = h('optgroup', { label: provider });
    for (const m of list) {
      const which = m.modelId ?? (m.lastReplyModel ? `it picks (last: ${m.lastReplyModel})` : 'it picks');
      group.append(h('option', { value: m.label, selected: m.label === current }, `${which}${m.chosen ? '' : ` · ${m.label}`}`));
    }
    picker.append(group);
  }
  // A model that isn't usable but is still set has to stay selectable, or saving would clear it. One
  // an agent was made on that isn't on your list runs fine, and is said as that rather than broken.
  if (current && !usable.some((m) => m.label === current)) {
    const own = (state.agentModels ?? []).find((m) => m.label === current);
    picker.append(h('option', { value: current, selected: true }, own ? `${own.provider} · ${modelName(own)} — not on your list, so it won’t run` : `${current} (not set up)`));
  }
  return picker;
}

/**
 * The @ picker: type @ at the start of a word and what you can bring in appears above the composer —
 * agents, then connections (settled brief §5), each saying whether it's granted where this thread
 * sits. Arrow keys move, Enter or Tab picks, Escape closes. Picking puts @Name in the text and tells
 * the caller what was picked.
 */
function mentionPicker(input, candidates, onPick) {
  const box = h('div', { class: 'mention', role: 'listbox', hidden: true });
  let options = [];
  let active = 0;
  let span = null;
  const handle = (item) => {
    if (item.kind === 'connection' || item.kind === 'person') return item.name.replace(/\s+/g, '');
    return item.title.replace(/\s+/g, '').toLowerCase() === item.name.toLowerCase() ? item.title.replace(/\s+/g, '') : item.name;
  };
  const close = () => {
    box.hidden = true;
    options = [];
    span = null;
  };
  const optionRow = (item, i) => {
    if (item.kind === 'person') {
      return h(
        'button',
        { type: 'button', class: 'row', role: 'option', 'aria-selected': String(i === active), onmousedown: (e) => e.preventDefault(), onclick: () => pick(item) },
        face(item.name, 'md'),
        h('span', { class: 'row-main' }, h('span', { class: 'row-top' }, h('b', {}, item.name), h('span', { class: 'tag' }, 'Person')), h('span', { class: 'row-sub' }, h('span', { class: 'text' }, 'Gets a notification. No agent answers for them.'))),
      );
    }
    const agent = item.kind !== 'connection';
    return h(
      'button',
      { type: 'button', class: `row ${!agent && !item.granted ? 'dim' : ''}`, role: 'option', 'aria-selected': String(i === active), onmousedown: (e) => e.preventDefault(), onclick: () => pick(item) },
      agent ? mark(item.mark ?? item.name, 30) : connectionMark(item),
      h(
        'span',
        { class: 'row-main' },
        h('span', { class: 'row-top' }, h('b', {}, agent ? item.title : item.name), h('span', { class: `tag ${!agent && item.health === 'failing' ? 'bad' : ''}` }, agent ? (item.joins ? 'Brings them in' : item.project ? (projectOf(item.project)?.name ?? item.project) : 'everywhere') : item.granted ? (item.health === 'failing' ? 'Not working' : 'Granted here') : 'Not granted here')),
        h('span', { class: 'row-sub' }, h('span', { class: 'text' }, agent ? item.description || '' : item.granted ? toolsSummary(item.tools) : 'Its tools aren’t available in this thread')),
      ),
    );
  };
  const draw = () => {
    const groups = [['Agents', options.filter((o) => o.kind !== 'connection' && o.kind !== 'person')], ['People', options.filter((o) => o.kind === 'person')], ['Connections', options.filter((o) => o.kind === 'connection')]].filter(([, items]) => items.length);
    let i = 0;
    fill(box, 
      ...groups.flatMap(([heading, items]) => [h('div', { class: 'mention-head' }, heading, h('span', { class: 'count' }, String(items.length))), ...items.map((item) => optionRow(item, i++))]),
    );
    box.hidden = options.length === 0;
  };
  const pick = (item) => {
    if (!span) return;
    const text = input.value;
    const inserted = `@${handle(item)} `;
    input.value = text.slice(0, span.start) + inserted + text.slice(span.end);
    const caret = span.start + inserted.length;
    input.setSelectionRange(caret, caret);
    close();
    input.focus();
    input.dispatchEvent(new Event('input'));
    onPick(item);
  };
  input.addEventListener('input', async () => {
    const upto = input.value.slice(0, input.selectionStart ?? input.value.length);
    const match = /(^|\s)@([\w-]*)$/.exec(upto);
    if (!match) return close();
    const query = match[2].toLowerCase();
    const matches = (item) => {
      const words = [item.name, item.title].filter(Boolean).map((w) => w.toLowerCase());
      return !query || words.some((w) => w.startsWith(query) || w.replace(/\s+/g, '').startsWith(query) || w.includes(query));
    };
    span = { start: upto.length - match[2].length - 1, end: upto.length };
    const all = await candidates();
    if (!span) return;
    // Agents first, then connections — the granted ones before the rest.
    const found = all.filter(matches).sort((a, b) => (a.kind === 'connection') - (b.kind === 'connection') || (b.granted ? 1 : 0) - (a.granted ? 1 : 0));
    options = found.slice(0, 8);
    active = Math.min(active, Math.max(0, options.length - 1));
    draw();
  });
  input.addEventListener('keydown', (e) => {
    if (box.hidden || !options.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length;
      draw();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      e.stopImmediatePropagation();
      pick(options[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
  box.isOpen = () => !box.hidden && options.length > 0;
  return box;
}

/**
 * Connections as the @ picker offers them: every one this person can see, marked granted or not in
 * the project a thread sits in. Fetched once per screen, when @ is first typed.
 */
function connectionCandidates(projectOfDraft) {
  let loaded;
  return async () => {
    loaded ??= Promise.all([api('/api/connections').catch(() => ({ connections: [] }))]).then(([{ connections }]) => connections);
    const connections = await loaded;
    const project = projectOfDraft();
    return connections.map((c) => {
      const grant = project ? c.grants.find((g) => g.project === project && !g.agent) : undefined;
      // What's granted here, not everything it offers.
      return { kind: 'connection', id: c.id, name: c.name, title: c.name, health: c.health, tools: grant ? c.tools.filter((t) => grant.tools.includes(t.name)) : [], granted: Boolean(grant) };
    });
  };
}

// A line that's part of a list: its indent, its marker, the space after it, and a task box if any.
const BULLET = /^([ \t]*)(?:([-*•])|(\d+)([.)]))([ \t]+)(\[[ xX]\][ \t]+)?/;

/**
 * A new line inside a list carries the list on, the way the chat apps do: "- " again, or the next
 * number. A new line on an item you haven't typed anything into ends the list instead, so there's a
 * way out without reaching for backspace. Returns true when it handled the newline itself.
 */
function bulletContinue(input) {
  const at = input.selectionStart ?? 0;
  // With something selected, a new line is a new line: replacing a selection isn't carrying a list on.
  if (at !== (input.selectionEnd ?? at)) return false;
  const lineStart = input.value.lastIndexOf('\n', at - 1) + 1;
  const line = input.value.slice(lineStart, at);
  const marked = BULLET.exec(line);
  if (!marked) return false;
  const [marker, indent, dash, number, dot, space, box] = marked;
  if (line.length === marker.length) {
    // Nothing on this item: take the marker away rather than making another empty one.
    input.setRangeText('', lineStart, at, 'end');
    input.dispatchEvent(new Event('input'));
    return true;
  }
  const next = dash ? `${indent}${dash}${space}` : `${indent}${Number(number) + 1}${dot}${space}`;
  input.setRangeText(`\n${next}${box ? '[ ] ' : ''}`, at, at, 'end');
  input.dispatchEvent(new Event('input'));
  return true;
}

/**
 * Enter sends, the way chat apps do; Shift+Enter or Alt+Enter starts a new line. On a touch keyboard
 * Enter stays a new line, since there's a send button under your thumb. Either way a new line inside
 * a list carries the list on.
 */
function enterSends(input, send, isPicking) {
  const touch = matchMedia('(pointer: coarse)');
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || isPicking()) return;
    if (e.altKey) {
      // Alt+Enter doesn't make a new line on its own in every browser.
      e.preventDefault();
      if (bulletContinue(input)) return;
      const at = input.selectionStart ?? input.value.length;
      input.setRangeText('\n', at, input.selectionEnd ?? at, 'end');
      input.dispatchEvent(new Event('input'));
      return;
    }
    if (e.shiftKey || (touch.matches && !(e.metaKey || e.ctrlKey))) {
      // The browser would make the new line; only a list needs taking over.
      if (bulletContinue(input)) e.preventDefault();
      return;
    }
    e.preventDefault();
    send();
  });
}

/**
 * Starting something (settled brief §5 phase): not a form. An empty thread with a composer, where the
 * first thing you choose is who — by typing @. The draft line above the composer says what it'll be:
 * agent, project, mode, and "more" for the rest. Nothing is saved until you send, so backing out
 * leaves nothing behind.
 */
function newThreadScreen(preset, preselectedAgent = '', withPerson = '') {
  // A thread needs something to run on. A composer that can only fail is worse than saying so.
  if (!state.models.some((m) => m.ready)) {
    return screen(
      bar(backButton(), title('New thread')),
      [
        h('p', { class: 'hint', style: 'margin-top:0' }, 'A thread runs on a model, and none are set up yet.'),
        h('button', { class: 'btn primary wide', onclick: () => go('#/models') }, 'Set up models'),
      ],
      { mainClass: 'plain' },
    );
  }
  const workable = activeProjects().filter((p) => isOwner() || p.role === 'member');
  const canUse = (slug) => !slug ? isOwner() : workable.some((p) => p.slug === slug);
  const start = remembered('polyphemus.project') ?? '';
  const draft = {
    agent: preselectedAgent ? agentByRef(preselectedAgent) ?? null : null,
    /** Everyone else brought in from the start: as many as are picked. */
    also: [],
    /** People brought in: a conversation with someone, which belongs to no project. */
    people: withPerson.startsWith('person:') && personById(withPerson.slice(7)) ? [personById(withPerson.slice(7))] : [],
    // Messaging an agent that belongs to no project is a thread with it, not work in whichever project
    // you were last in: only its own project, or none.
    // With someone else in it, it belongs to no project: a project's threads are the project's people's.
    project: withPerson ? '' : preset && canUse(preset) ? preset : preselectedAgent ? (agentByRef(preselectedAgent)?.project ?? '') : start && canUse(start) ? start : isOwner() ? '' : (workable[0]?.slug ?? ''),
    // Chosen on the chip, rather than inferred from the agent.
    projectChosen: Boolean(preset),
    yolo: remembered('polyphemus.mode') === 'yolo',
    model: '',
    note: '',
  };

  /** Where an agent's thread belongs: its own project, else where you last worked with it, else where you were. */
  const inferProject = (agent) => {
    if (agent.project) return { slug: agent.project, why: 'works in' };
    const last = state.sessions.find((s) => s.agent === agent.id && s.project && canUse(s.project));
    if (last) return { slug: last.project, why: 'last worked in' };
    return null;
  };
  const chooseAgent = (agent) => {
    const named = (a) => input.value.match(new RegExp(`@${a.title.replace(/\s+/g, '')}\\b|@${a.name}\\b`, 'i'));
    if (draft.agent && agent && draft.agent.id !== agent.id && named(draft.agent)) {
      // Another @ in the same message brings them in too, however many.
      if (!draft.also.some((a) => a.id === agent.id)) draft.also.push(agent);
    } else draft.agent = agent;
    const inferred = agent && !draft.projectChosen ? inferProject(agent) : null;
    if (inferred) draft.project = inferred.slug;
    draft.note = !agent
      ? ''
      : inferred
        ? `${agent.title} ${inferred.why} ${projectOf(inferred.slug)?.name ?? inferred.slug}, so this thread will sit there. Change it on the chip.`
        : agent.project && !draft.project
          ? `${agent.title} belongs to ${projectOf(agent.project)?.name ?? agent.project}; out here it works without that project’s rules, memory or connections.`
          : `${agent.title} works anywhere; this thread will sit in ${draft.project ? (projectOf(draft.project)?.name ?? draft.project) : 'Direct'}.`;
    drawDraft();
  };

  /** What the thread will run on: the model picked for it, else its agent's own, else the default. */
  const draftModel = () => {
    const agent = draft.agent ?? defaultAgentOf();
    const ref = draft.model || (agent?.model && agent.model !== 'default' ? agent.model : '') || state.defaultModel || '';
    return modelByRef(ref) ?? null;
  };
  const chip = (label, onclick, cls = '') => h('button', { type: 'button', class: `chip ${cls}`, onclick }, label);
  const draftLine = h('div', { class: 'draft', 'aria-label': 'What this thread will be' });
  const noteLine = h('p', { class: 'draft-note' });
  /** Just people, no agent: a conversation between them, where nothing runs and nothing answers. */
  const betweenPeople = () => draft.people.length > 0 && !draft.agent && !draft.also.length;
  const drawDraft = () => {
    if (betweenPeople()) {
      const names = draft.people.map((p) => p.name).join(' and ');
      fill(draftLine, ...draft.people.map((p) => chip([face(p.name, 'sm'), p.name], () => ((draft.people = draft.people.filter((x) => x.id !== p.id)), drawDraft()))), chip('more', moreSheet, 'ghost'));
      noteLine.textContent = `Just between you and ${names}: no agent answers, and they’re told when you write.${isOwner() ? ' @ an agent to bring one in.' : ''}`;
      noteLine.classList.remove('warnish');
      noteLine.hidden = false;
      input.placeholder = `Message ${names}…`;
      return;
    }
    const project = draft.project ? projectOf(draft.project) : null;
    const runsOn = draftModel();
    const level = isolationHere(project);
    const stops = isolationStops(level, runsOn);
    fill(draftLine, ...[
      draft.agent ? chip([mark(draft.agent.mark ?? draft.agent.name, 18), draft.agent.title], pickAgentSheet) : defaultAgentOf() ? chip([mark(defaultAgentOf().mark ?? defaultAgentOf().name, 18), defaultAgentOf().title], pickAgentSheet) : chip('no agent yet', pickAgentSheet, 'ghost'),
      ...draft.also.map((a) => chip([mark(a.mark ?? a.name, 18), `+ ${a.title}`], () => ((draft.also = draft.also.filter((x) => x.id !== a.id)), drawDraft()))),
      ...draft.people.map((p) => chip([face(p.name, 'sm'), `+ ${p.name}`], () => ((draft.people = draft.people.filter((x) => x.id !== p.id)), drawDraft()))),
      runsOn ? chip(modelShort(runsOn), pickModelSheet) : chip('no model yet', pickModelSheet, 'ghost'),
      // No project means Direct: the place it will actually show up in, rather than a negative.
      chip(project ? project.name : isOwner() ? [icon('direct', 'ico mini'), 'Direct'] : 'pick a project', pickProjectSheet, project || isOwner() ? '' : 'ghost'),
      level ? chip(level.title, () => isolationSheet(project, runsOn), stops ? 'warn' : '') : null,
      // Codex never asks about an action, whatever the mode: say so rather than promise it.
      chip(draft.yolo ? 'YOLO' : runsOn?.asks === false ? 'Doesn’t ask (Codex)' : 'Asks first', toggleYolo, draft.yolo ? 'yolo' : ''),
      chip('more', moreSheet, 'ghost'),
    ].filter(Boolean));
    // A model that can't run where agents run here is said now, not after sending.
    noteLine.textContent = stops
      ? `${stops} Pick another model, or tap ${level.title} to see where that’s set.`
      : draft.note || (!project && isOwner() ? 'This sits in Direct: outside every project, with no project’s rules, memory or connections, and its own folder to work in.' : '');
    noteLine.classList.toggle('warnish', Boolean(stops));
    noteLine.hidden = !noteLine.textContent;
    input.placeholder = draft.agent ? `Message ${draft.agent.title}…` : 'Type, or start with @ to bring in an agent';
  };

  const listSheet = (heading, items, current, onChoose) => {
    const wrap = sheet(heading, [
      h(
        'div',
        { class: 'choices' },
        items.map((item) =>
          h('button', { type: 'button', class: 'choice', 'aria-pressed': String(item.value === current), onclick: () => (wrap.remove(), onChoose(item.value)) }, h('span', { class: 'radio' }), h('span', {}, h('b', {}, item.label), item.hint ? h('small', {}, item.hint) : null)),
        ),
      ),
    ]);
  };
  function pickAgentSheet() {
    listSheet('Who is it with?', [{ value: '', label: 'No agent', hint: 'Just the model' }, ...(state.agents ?? []).map((a) => ({ value: a.id, label: a.title, hint: `${a.project ? (projectOf(a.project)?.name ?? a.project) : 'Everywhere'} · ${a.description}` }))], draft.agent?.id ?? '', (id) => chooseAgent(id ? agentByRef(id) : null));
  }
  function pickModelSheet() {
    const agent = draft.agent ?? defaultAgentOf();
    const own = agent?.model && agent.model !== 'default' ? modelByRef(agent.model) : null;
    const level = isolationHere(draft.project ? projectOf(draft.project) : null);
    listSheet('What does it run on?', [
      { value: '', label: own ? `${agent.title}’s own: ${modelShort(own)}` : `The default${modelByRef(state.defaultModel ?? '') ? `: ${modelShort(modelByRef(state.defaultModel))}` : ''}`, hint: own ? 'What this agent works on' : 'What any thread would use' },
      ...state.models.filter((m) => m.ready).map((m) => ({ value: m.label, label: modelShort(m), hint: isolationStops(level, m) ?? modelWay(m) })),
    ], draft.model, (label) => {
      draft.model = label;
      drawDraft();
    });
  }
  function pickProjectSheet() {
    if (draft.people.length) return toast(`A conversation with ${draft.people.map((p) => p.name).join(' and ')} belongs to no project.`);
    listSheet('Where does it sit?', [...(isOwner() ? [{ value: '', label: 'Direct', hint: 'Outside every project: no project’s rules, memory or connections' }] : []), ...workable.map((p) => ({ value: p.slug, label: p.name, hint: p.description || p.path }))], draft.project, (slug) => {
      draft.project = slug;
      draft.projectChosen = true;
      draft.note = '';
      drawDraft();
    });
  }
  async function toggleYolo() {
    if (!draft.yolo && !(await confirmSheet('YOLO in this thread?', ['Every command runs without asking you first, for as long as it’s on.', 'It never widens what an agent was granted.'], { yes: 'Turn on YOLO', danger: true }))) return;
    draft.yolo = !draft.yolo;
    drawDraft();
  }
  function moreSheet() {
    // The old form's other choices, for the people who want them.
    const picked = new Set(draft.also.map((a) => a.id));
    const lead = draft.agent ?? defaultAgentOf();
    const others = (state.agents ?? []).filter((a) => a.id !== lead?.id).map((a) => {
      const b = h('button', { type: 'button', class: 'choice check', 'aria-pressed': String(picked.has(a.id)), onclick: () => {
        if (picked.has(a.id)) picked.delete(a.id);
        else picked.add(a.id);
        b.setAttribute('aria-pressed', String(picked.has(a.id)));
      } }, h('span', { class: 'box' }), h('span', {}, h('b', {}, a.title), a.description ? h('small', {}, a.description) : null));
      return b;
    });
    const wrap = sheet('More', [
      h('div', { class: 'field' }, h('span', {}, 'Also bring in'), others.length ? h('div', { class: 'choices', id: 'new-also' }, others) : h('p', { class: 'hint tight' }, 'There’s no one else on the team yet.'), h('small', { class: 'hint' }, 'Several agents make a group thread: start each message with @ to say who it’s for.')),
      h('button', { class: 'btn primary wide', onclick: () => {
        draft.also = (state.agents ?? []).filter((a) => picked.has(a.id));
        wrap.remove();
        drawDraft();
      } }, 'Done'),
    ]);
  }

  const input = holdsDraft(h('textarea', { id: 'input', rows: 1, 'aria-label': 'Message' }), 'new', () => grow());
  const attach = attachments(input);
  const connectionsHere = connectionCandidates(() => draft.project);
  const picker = mentionPicker(
    input,
    async () => [...(state.agents ?? []).map((a) => ({ ...a, kind: 'agent' })), ...(await connectionsHere())],
    (item) => (item.kind === 'connection' ? (!item.granted && toast(`${item.name} isn’t granted ${draft.project ? `in ${projectOf(draft.project)?.name ?? draft.project}` : 'outside a project'}, so its tools won’t be there.`)) : chooseAgent(item)),
  );
  const grow = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  };
  input.addEventListener('input', grow);
  const send = async () => {
    const text = input.value.trim();
    if (attach.busy()) return toast('Still uploading…');
    const images = attach.ids();
    const files = attach.files();
    if (!text && !images.length && !files.length) return input.focus();
    const caught = secretIn(text);
    if (caught) {
      const choice = await offerVault({ value: caught, project: draft.project ? projectOf(draft.project) : null, agent: draft.agent });
      if (choice === 'saved') {
        input.value = text.replace(caught, '').trim();
        keepDraft('new', input.value);
        grow();
        return;
      }
      if (choice !== 'send') return;
    }
    if (!draft.project && !isOwner() && !betweenPeople()) return pickProjectSheet();
    sendButton.disabled = true;
    remember('polyphemus.mode', draft.yolo ? 'yolo' : 'ask');
    remember('polyphemus.project', draft.project);
    try {
      const { id } = await api('/api/sessions', { text, images, files, project: betweenPeople() ? '' : draft.project, agent: draft.agent?.id ?? '', model: draft.model, yolo: draft.yolo, with: [...draft.also.map((a) => a.id), ...draft.people.map((p) => `person:${p.id}`)] });
      keepDraft('new', '');
      await refresh();
      location.replace(`#/s/${id}`);
    } catch (err) {
      sendButton.disabled = false;
      showError(err);
    }
  };
  enterSends(input, send, () => picker.isOpen());
  const sendButton = round('send', 'Send', send, 'primary');

  if (draft.agent) chooseAgent(draft.agent);
  else drawDraft();
  fill($(pane), 
    bar(backButton(), title('New thread')),
    h(
      'main',
      { class: 'main with-composer start' },
      h('div', { class: 'nothing start-empty' }, logo(), h('b', {}, 'Start something'), h('span', {}, 'Type, or start with @ to bring in an agent. Nothing is saved until you send.')),
    ),
    h('div', { class: 'composer drafting' }, picker, attach.picker, h('div', { class: 'box' }, noteLine, draftLine, attach.strip, h('div', { class: 'box-row' }, attach.button, emojiButton(input), h('label', {}, input), sendButton))),
  );
  followComposer();
  input.focus();
}

function newProjectScreen() {
  const name = h('input', { id: 'project-name', type: 'text', placeholder: 'e.g. Side Quest', autocapitalize: 'words' });
  const about = h('textarea', { id: 'project-about', rows: 3, placeholder: 'What is it, and who is it for? Agents read this first.' });
  const from = h('input', { id: 'project-from', type: 'url', placeholder: 'https://github.com/you/repo', autocapitalize: 'off', spellcheck: 'false' });
  const repo = h('label', { class: 'field', hidden: true }, h('span', {}, 'Repository'), from);
  // Git is offered, never assumed: a project is a folder of work, and plenty of them aren't code.
  const source = h(
    'select',
    { id: 'project-source', onchange: () => ((repo.hidden = source.value !== 'clone'), (hint.textContent = hintFor())) },
    h('option', { value: 'empty' }, 'An empty folder'),
    h('option', { value: 'git' }, 'An empty folder, tracked with git'),
    h('option', { value: 'clone' }, 'A copy of a GitHub repo'),
  );
  const hintFor = () =>
    `It goes in ${state.projectsRoot ?? 'your projects folder'}, with an AGENTS.md every agent reads first and a private memory folder on your computer.${
      source.value === 'empty' ? ' No git repo — add one later if it turns out to be code.' : ''
    }`;
  const hint = h('p', { class: 'hint' }, hintFor());
  const create = async (event) => {
    const button = event.currentTarget;
    if (!name.value.trim()) return name.focus();
    button.disabled = true;
    button.textContent = source.value === 'clone' ? 'Cloning…' : 'Creating…';
    try {
      const { project } = await api('/api/projects', { name: name.value, about: about.value, from: source.value === 'clone' ? from.value : undefined, git: source.value === 'git' });
      remember('polyphemus.project', project.slug);
      await refresh();
      location.replace(`#/p/${project.slug}`);
    } catch (err) {
      showError(err);
      button.disabled = false;
      button.textContent = 'Create project';
    }
  };
  screen(
    bar(backButton(), title('New project')),
    [
      h('label', { class: 'field' }, h('span', {}, 'Name'), name),
      h('label', { class: 'field' }, h('span', {}, 'About'), about),
      h('label', { class: 'field' }, h('span', {}, 'Start from'), source),
      repo,
      h('button', { class: 'btn primary wide', onclick: create }, 'Create project'),
      hint,
    ],
    { mainClass: 'plain' },
  );
  name.focus();
}

// ── One conversation ─────────────────────────────────────────────────────

/**
 * Lines between messages that say what happened around them: who answered a question, a spin-out,
 * and who came and went — agents added or removed, people given or losing the project.
 */
function threadNotes(s) {
  s.notes = [];
  s.times ??= [];
  s.turns ??= [];
  const seqAt = (at) => s.times.filter((t) => t <= at).length;
  // Who answered what, where it happened in the conversation — only once there's someone else to credit.
  if (multiplePeople()) {
    for (const answer of s.answers ?? []) {
      if (!answer.by) continue;
      const verb = answerVerb(answer.answer);
      s.notes.push({ seq: seqAt(answer.at), kind: 'info', text: `${actorName(answer.by)} ${verb}${answer.summary ? `: ${answer.summary}` : ''}` });
    }
  }
  for (const child of s.spinOuts ?? []) {
    s.notes.push({ seq: seqAt(child.createdAt), kind: 'info', text: 'Spun out:', link: { label: child.title, href: `#/s/${child.id}` } });
  }
  for (const a of s.attendance ?? []) attendanceNote(s, a, seqAt(a.at));
}

function attendanceNote(s, a, seq) {
  // Who a thread started with — its agents, the people a conversation was started with — isn't news.
  const created = typeof s.meta.createdAt === 'number' ? s.meta.createdAt : Date.parse(s.meta.createdAt);
  if (a.change === 'joined' && a.at === created && (a.kind === 'agent' || !a.role)) return;
  s.notes.push({ seq, kind: 'info', text: `${attendanceText(a)} · ${new Date(a.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` });
}

/** "You added Helm", "Sam removed Crank", "Sam became a viewer of the project". */
function attendanceText(a) {
  const by = a.by?.startsWith('person:') ? actorName(a.by) : a.by?.startsWith('routine:') ? 'A routine' : a.by?.startsWith('run:') ? 'A run' : null;
  const who = a.kind === 'person' && a.subject === `person:${state.me?.id}` ? 'you' : a.who;
  const Who = who.charAt(0).toUpperCase() + who.slice(1);
  if (a.kind === 'agent') {
    if (a.change === 'joined') return by ? `${by} added ${who}` : `${Who} joined`;
    return by ? `${by} removed ${who}` : `${Who} left`;
  }
  // Brought into a conversation outside every project: there's no role, just who's in it.
  if (!a.role && a.change !== 'role') {
    if (a.change === 'joined') return by ? `${by} added ${who}` : `${Who} joined`;
    return by ? `${by} took ${who} out of the conversation` : `${Who} left the conversation`;
  }
  if (a.change === 'joined') return by ? `${by} gave ${who} access to the project, as a ${a.role}` : `${Who} joined the project, as a ${a.role}`;
  if (a.change === 'role') return by ? `${by} made ${who} a ${a.role} of the project` : `${Who} became a ${a.role} of the project`;
  return by ? `${by} removed ${who} from the project` : `${Who} left the project`;
}

async function openSession(id) {
  try {
    current = await api(`/api/sessions/${id}`);
  } catch (err) {
    current = null;
    showError(err);
    return location.replace('#/');
  }
  if (view.name !== 'session' || view.id !== id) return; // you moved on while it loaded
  streaming.clear();
  renderSession();
}

function renderSession() {
  const s = current;
  const listed = sessionById(s.meta.id);
  const project = listed?.project ? projectOf(listed.project) : null;
  const model = h('select', { id: 'model', class: 'chip-select', 'aria-label': 'Model', onchange: (e) => api(`/api/sessions/${s.meta.id}/model`, { model: e.target.value }).catch(showError) }, modelOptions(s.model.label));
  const mode = h('button', { id: 'mode', class: 'chip', onclick: toggleMode });
  const viewChip = h('button', { class: 'chip', title: 'How much of the work to show' }, viewLabel());
  viewChip.addEventListener('click', () => {
    setViewMode(viewMode() === 'compact' ? 'detailed' : 'compact');
    viewChip.textContent = viewLabel();
    renderLog();
  });
  const log = h('div', { id: 'log' });
  reactionsOn(log);
  threadNotes(s);
  // How long it's really been going, from polyphemus, not from when you opened the thread.
  if (s.running) s.liveStartedAt = s.workingSince ?? Date.now();
  const input = holdsDraft(h('textarea', { id: 'input', rows: 1, placeholder: 'Message…', 'aria-label': 'Message' }), s.meta.id, () => grow());
  const attach = attachments(input);
  const send = async () => {
    const text = input.value.trim();
    if (attach.busy()) return toast('Still uploading…');
    const images = attach.ids();
    const files = attach.files();
    if (!text && !images.length && !files.length) return input.focus();
    const caught = secretIn(text);
    if (caught) {
      const choice = await offerVault({ value: caught, sessionId: s.meta.id, project: listed?.project ? projectOf(listed.project) : null, agent: (s.members ?? [])[0] });
      if (choice === 'saved') {
        input.value = text.replace(caught, '').trim();
        keepDraft(s.meta.id, input.value);
        grow();
        return;
      }
      if (choice !== 'send') return;
    }
    try {
      const sent = await api(`/api/sessions/${s.meta.id}/messages`, { text, images, files });
      // Sent while it's working: held, shown under the thread, and sent when it stops.
      if (sent.queued) await refreshQueue(s.meta.id);
      input.value = '';
      keepDraft(s.meta.id, '');
      attach.clear();
      grow();
      // Your own message always takes you to the end: you meant to be there.
      scrollDown(true);
    } catch (err) {
      showError(err);
    }
  };
  const grow = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  };
  input.addEventListener('input', grow);
  // In a thread, @ offers the agents in it — who a message can be for — and the connections.
  const connectionsHere = connectionCandidates(() => listed?.project ?? null);
  const picker = mentionPicker(
    input,
    async () => {
      // Those in the thread first; then teammates who aren't — naming one brings them in.
      const here = (current?.members ?? []).map((m) => ({ ...(agentByRef(m.id) ?? { ...m, description: '', project: null }), kind: 'agent' }));
      const inIt = new Set(here.map((a) => a.id));
      const project = listed?.project ?? null;
      const others = (state.agents ?? []).filter((a) => !inIt.has(a.id) && (a.project === null || a.project === project)).map((a) => ({ ...a, kind: 'agent', joins: true }));
      return [...here, ...peopleHere(project), ...others, ...(await connectionsHere())];
    },
    (item) => item.kind === 'connection' && !item.granted && toast(`${item.name} isn’t granted in this thread’s project, so its tools won’t be there.`),
  );
  enterSends(input, send, () => picker.isOpen());
  const sendButton = round('send', 'Send', send, 'primary');
  sendButton.id = 'send';
  const stopButton = round('stop', 'Stop', () => api(`/api/sessions/${s.meta.id}/interrupt`, {}).catch(showError), 'danger');
  stopButton.id = 'stop';
  // Redrawing mid-sentence shouldn't take the keyboard away either: it goes back where it was.
  const wasTyping = document.activeElement?.id === 'input';
  const caret = wasTyping ? document.activeElement.selectionStart : null;
  fill($(pane), 
    bar(backButton(), threadHead(s), [computerButton(s), membersButton(s), round('more', 'This thread', () => threadActions(s))].filter(Boolean)),
    h(
      'main',
      { class: 'main with-composer' },
      h('div', { class: 'thread-state', id: 'thread-state' }),
      runPane(s),
      log,
      h('div', { id: 'questions' }),
      h('div', { id: 'alongside', class: 'alongside-list' }),
      h('div', { id: 'queued', class: 'queued-list' }),
    ),
    h('button', { id: 'jump', class: 'jump', 'aria-label': 'Jump to the newest message', title: 'Jump to the newest message', onclick: () => scrollDown(true) }, icon('chev', 'ico')),
    s.canAct === false
      ? h('div', { class: 'composer read-only' }, h('p', { class: 'hint tight' }, `You can read this thread${project ? ` — you’re a viewer in ${project.name}` : ''}.`))
      : h('div', { class: 'composer' }, picker, attach.picker, h('div', { class: 'box' }, attach.strip, h('div', { class: 'box-row' }, attach.button, emojiButton(input), h('label', {}, input), stopButton, sendButton))),
  );
  renderLog();
  watchScroll();
  followComposer();
  if (wasTyping) {
    input.focus();
    if (caret !== null) input.setSelectionRange(caret, caret);
  }
  for (const q of s.questions) showQuestion(q);
  renderAlongside();
  renderQueue();
  // While it works you can still write: Send holds it, and it goes when they're done.
  input.addEventListener('input', () => {
    const button = $('#send');
    if (button && current?.running) button.hidden = !input.value.trim();
  });
  setRunning(s.running);
  showMode();
  void model;
  void mode;
  void viewChip;
  // Opened from the flow at a particular message: go there and mark it, rather than to the end.
  // Once. The address stops carrying it as soon as it's done, so a reply arriving — or a message you
  // send, which draws the thread again — doesn't drag you back up to it.
  if (view.at !== '' && view.at !== undefined) {
    const seq = Number(view.at);
    view = { ...view, at: '' };
    history.replaceState(null, '', `#/s/${s.meta.id}`);
    showMessage(seq);
  } else scrollDown(true);
}

/** Puts a message in the middle of the screen and marks it for a moment: where the flow sends you. */
function showMessage(seq) {
  const found = document.querySelector(`#log [data-seq="${CSS.escape(String(seq))}"]`) ?? [...document.querySelectorAll('#log [data-seq]')].reverse().find((node) => Number(node.dataset.seq) <= seq);
  if (!found) return scrollDown(true);
  found.scrollIntoView({ block: 'center', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  found.classList.add('found');
  setTimeout(() => found.classList.remove('found'), 2200);
}

/** Agents answering alongside the thread's own turn: each with how long it's been at it, and its own stop. */
function renderAlongside() {
  const list = $('#alongside');
  if (!list || !current) return;
  const others = (current.working ?? []).filter((w) => w.alongside);
  fill(list, ...others.map((w) => {
    const agent = w.agent ? (agentByRef(w.agent) ?? { name: w.title ?? w.agent, title: w.title ?? w.agent, mark: null }) : null;
    return h(
      'div',
      { class: 'alongside' },
      alive(agent ? mark(agent.mark ?? agent.name, 18) : threadMark(current.meta, 18), true),
      h('span', { class: 'sum-text' }, h('span', { class: 'what' }, `${w.title ?? 'An agent'} is working `, h('span', { class: 'since', 'data-since': String(w.since ?? Date.now()) }, duration(Date.now() - (w.since ?? Date.now()))))),
      h('button', { type: 'button', class: 'linky', onclick: () => api(`/api/sessions/${current.meta.id}/interrupt`, { agent: w.agent }).catch(showError) }, 'Stop'),
    );
  }));
  tick();
  followComposer();
}

/** Messages sent while the thread was working, waiting their turn: yours can be taken back. */
function renderQueue() {
  const list = $('#queued');
  if (!list || !current) return;
  fill(list, ...(current.queued ?? []).map((q) => {
    const unqueue = async () => {
      try {
        await api(`/api/sessions/${current.meta.id}/unqueue`, { id: q.id });
        await refreshQueue(current.meta.id);
      } catch (err) {
        showError(err);
      }
    };
    const sendNow = async () => {
      // For an agent that isn't working, it goes alongside and stops nothing. Otherwise the thread's
      // own turn is stopped to let it through, which is worth asking about first.
      const busy = new Set((current.working ?? []).map((w) => w.agent).filter(Boolean));
      const free = (current.members ?? []).find((m) => !busy.has(m.id) && new RegExp(`@${m.name.replace(/[^\w-]/g, '')}\\b`, 'i').test(q.text || ''));
      if (current.running && !free && !(await confirmSheet('Send it now?', ['Nobody else in this thread was named, so what’s working now is stopped and this goes instead. What it did so far stays.'], { yes: 'Send it now' }))) return;
      try {
        await api(`/api/sessions/${current.meta.id}/send-now`, { id: q.id });
        await refreshQueue(current.meta.id);
      } catch (err) {
        showError(err);
      }
    };
    const mine = q.mine || isOwner();
    return h(
      'div',
      { class: `queued ${q.mine ? 'mine' : ''}` },
      h('div', { class: 'queued-text' }, q.text || (q.attachments ? `${q.attachments} attached` : '')),
      h('div', { class: 'queued-meta' },
        h('span', {}, q.mine ? 'Waiting' : `${q.by} · waiting`),
        mine ? h('button', { type: 'button', class: 'linky', onclick: sendNow }, 'Send now') : null,
        mine ? h('button', { type: 'button', class: 'linky', onclick: unqueue }, 'Take back') : null),
    );
  }));
  followComposer();
}

async function refreshQueue(id) {
  try {
    const { queued } = await api(`/api/sessions/${id}?light=1`);
    if (current?.meta.id !== id) return;
    current.queued = queued ?? [];
    renderQueue();
  } catch {
    // Next event tries again.
  }
}

/**
 * How a thread flowed: a row per actor, time left to right, a bar for every turn, arrows where one
 * agent handed on to another, and marks where it waited on a person. Tapping anything says what it
 * was; it's for reviewing a conversation several agents took part in.
 */
async function flowScreen(id) {
  let flow;
  try {
    flow = await api(`/api/sessions/${id}/flow`);
  } catch (err) {
    return showError(err);
  }
  if (view.name !== 'flow' || view.id !== id) return;
  const holder = h('div', { class: 'flow-holder' });
  const detail = h('p', { class: 'hint flow-detail' }, 'Tap anything to see what it was, and to open it in the thread.');
  // Two ways to read the same thread: the graph says who passed it to whom, the timeline says when.
  const draw = (how) => {
    remember('polyphemus.flowAs', how);
    (how === 'timeline' ? drawTimeline : drawFlow)(holder, detail, flow, id);
  };
  const as = (view.as || remembered('polyphemus.flowAs')) === 'timeline' ? 'timeline' : 'graph';
  const ways = h('div', { class: 'segmented' }, [['graph', 'Graph'], ['timeline', 'Timeline']].map(([value, label]) => {
    const button = h('button', { type: 'button', 'aria-pressed': String(value === as) }, label);
    button.addEventListener('click', () => {
      for (const other of ways.children) other.setAttribute('aria-pressed', String(other === button));
      draw(value);
    });
    return button;
  }));
  screen(
    bar(backButton(), title('How it flowed'), [round('direct', 'Open the thread', () => go(`#/s/${id}`))]),
    [ways, detail, holder],
    { mainClass: 'plain' },
  );
  draw(as);
}

/**
 * The other way to read it: a row per actor and time left to right, so two agents working at once
 * are two bars side by side, and a gap is the thread waiting. Zooming in makes it wider.
 */
function drawTimeline(holder, detail, flow, id, zoom = 1) {
  const rows = flow.actors.filter((a) => a.kind !== 'thread');
  const lane = (ref) => Math.max(0, rows.findIndex((a) => a.id === ref));
  const ends = [...flow.turns.map((t) => t.until), ...flow.says.map((m) => m.at), flow.startedAt];
  const from = flow.startedAt;
  const to = Math.max(...ends, from + 60_000);
  const span = to - from;
  // The whole thread fits to begin with; zooming in makes it wider and it scrolls.
  const room = Math.max(320, (holder.clientWidth || holder.parentElement?.clientWidth || window.innerWidth) - 170);
  const width = Math.max(320, Math.min(24_000, Math.round(room * zoom)));
  const top = 34;
  const rowH = 46;
  const height = top + rows.length * rowH + 24;
  const x = (at) => 8 + ((at - from) / span) * (width - 24);
  const y = (i) => top + i * rowH + rowH / 2;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'flow');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const add = (tag, attrs, title) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    if (title) {
      const t = document.createElementNS(NS, 'title');
      t.textContent = title;
      node.append(t);
    }
    svg.append(node);
    return node;
  };
  const say = (text) => (detail.textContent = text);
  const when = (at) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

  // The hour and minute marks along the top, and a line down each.
  // Far enough apart to read: the first step that leaves about 90px between marks.
  const steps = [5_000, 15_000, 30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000, 3600_000, 3 * 3600_000, 6 * 3600_000, 12 * 3600_000, 24 * 3600_000];
  const step = steps.find((ms) => (ms / span) * width >= 90) ?? steps.at(-1);
  for (let at = Math.ceil(from / step) * step; at < to; at += step) {
    add('line', { x1: x(at), y1: top - 12, x2: x(at), y2: height - 14, class: 'flow-grid' });
    add('text', { x: x(at) + 4, y: top - 16, class: 'flow-time' }).textContent = new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  // A line per actor, so an empty row still reads as someone who was here.
  rows.forEach((_, i) => add('line', { x1: 8, y1: y(i), x2: width - 16, y2: y(i), class: 'flow-lane' }));

  // Hand-offs: from whoever asked, to whoever answered.
  for (const turn of flow.turns) {
    if (!turn.speaker || !turn.sender) continue;
    const a = lane(turn.sender);
    const b = lane(`agent:${turn.speaker}`);
    if (a === b) continue;
    const x0 = x(turn.at);
    add('path', { d: `M ${x0 - 10} ${y(a)} C ${x0 - 2} ${y(a)}, ${x0 - 2} ${y(b)}, ${x0} ${y(b)}`, class: 'flow-arrow' }, `${flow.actors.find((p) => p.id === turn.sender)?.name ?? 'Someone'} → ${flow.actors.find((p) => p.id === `agent:${turn.speaker}`)?.name ?? 'an agent'}`);
  }

  // A bar per turn, in its agent's row.
  for (const turn of flow.turns) {
    const i = lane(turn.speaker ? `agent:${turn.speaker}` : flow.actors[0]?.id);
    const left = x(turn.at);
    const w = Math.max(6, x(turn.until) - left);
    const cost = turn.costUsd === null || turn.costUnknown ? '' : ` · ${turn.billing === 'plan' ? '≈' : ''}$${turn.costUsd.toFixed(2)}`;
    const words = `${rows[i]?.name ?? 'An agent'} · ${duration(turn.until - turn.at)} · ${turn.model}${cost}${turn.stopReason === 'aborted' ? ' · stopped' : ''}`;
    const bar = add('rect', { x: left, y: y(i) - 9, width: w, height: 18, rx: 6, class: `flow-turn ${turn.stopReason === 'aborted' ? 'stopped' : ''}` }, words);
    bar.addEventListener('click', () => {
      say(`${words} · started ${when(turn.at)}`);
      go(`#/s/${id}?at=${Math.max(0, turn.endSeq - 1)}`);
    });
  }

  // What people and agents said: a dot where each message landed.
  for (const said of flow.says) {
    const i = lane(said.actor);
    const dot = add('circle', { cx: x(said.at), cy: y(i), r: 4.5, class: `flow-say ${said.role === 'user' ? 'person' : ''}` }, said.preview);
    dot.addEventListener('click', () => {
      say(`${when(said.at)} · ${flow.actors.find((a) => a.id === said.actor)?.name ?? 'Someone'}: ${said.preview}`);
      go(`#/s/${id}?at=${said.seq}`);
    });
  }

  // Where it waited on a person, and who answered.
  for (const wait of flow.waits) {
    const i = lane(wait.by ?? rows[0]?.id);
    const size = 7;
    const mark = add('rect', { x: x(wait.at) - size / 2, y: y(i) - size / 2, width: size, height: size, transform: `rotate(45 ${x(wait.at)} ${y(i)})`, class: 'flow-wait' }, `${wait.kind}: ${wait.summary}`);
    mark.addEventListener('click', () => say(`${when(wait.at)} · waited on a person (${wait.kind}): ${wait.summary}${wait.answer ? ` — ${wait.answer}` : ''}`));
  }

  // Who came and went.
  for (const coming of flow.comings) {
    if (coming.change === 'role') continue;
    const i = lane(coming.who);
    add('line', { x1: x(coming.at), y1: y(i) - 14, x2: x(coming.at), y2: y(i) + 14, class: `flow-coming ${coming.change}` }, `${flow.actors.find((a) => a.id === coming.who)?.name ?? 'Someone'} ${coming.change}`);
  }

  const names = h('div', { class: 'flow-names' }, rows.map((a, i) => h('div', { class: 'flow-name', style: `top:${y(i) - 14}px` }, a.kind === 'agent' ? mark(a.mark ?? a.name, 20) : face(a.name, 'sm'), h('span', {}, a.name))));
  const totals = costOf(flow.turns);
  const zoomOut = h('button', { class: 'btn small', onclick: () => drawTimeline(holder, detail, flow, id, Math.max(0.25, zoom / 1.6)) }, 'Zoom out');
  const zoomIn = h('button', { class: 'btn small', onclick: () => drawTimeline(holder, detail, flow, id, Math.min(8, zoom * 1.6)) }, 'Zoom in');
  fill(holder,
    h('div', { class: 'flow-wrap' }, names, h('div', { class: 'flow-scroll' }, svg)),
    h('p', { class: 'hint tight' }, `${rows.length} here · ${totals.turns} turn${totals.turns === 1 ? '' : 's'} · ${duration(to - from)}${totals.said}`),
    h('div', { class: 'buttons' }, zoomOut, zoomIn),
  );
}

/**
 * The drawing: a lane per actor and a row per thing said, like a git graph. A dot sits in its
 * speaker's lane, lanes carry on as lines while they're in it, and a curve joins one lane to the
 * next wherever the thread passed from one to another — a hand-off, or a person asking.
 */
function drawFlow(holder, detail, flow, id) {
  const rows = flow.says.map((say) => ({ ...say, kind: 'say' }));
  if (!rows.length) return fill(holder, h('p', { class: 'empty' }, 'Nothing has been said in this thread yet.'));
  // A lane per actor, in the order each first appears — the same idea as a branch's column.
  const lanes = [];
  const laneOf = (ref) => {
    const at = lanes.indexOf(ref);
    return at === -1 ? lanes.push(ref) - 1 : at;
  };
  for (const row of rows) laneOf(row.actor ?? 'thread');
  const who = (ref) => flow.actors.find((a) => a.id === ref);
  // Each lane in its actor's own colour — an agent's mark, or the one a person's name gets.
  const colourOf = (ref) => {
    const actor = who(ref);
    return markSpec(actor?.mark ?? actor?.name ?? ref).color;
  };
  // The turn a reply came out of: the first that ended after it, and only if it was that agent's.
  // The turn a reply came out of: the one that ended on it (its last message), and only that agent's.
  const turnFor = (seq, actor) => flow.turns.find((t) => t.endSeq === seq + 1 && `agent:${t.speaker}` === actor);

  const rowH = 30;
  const gap = 16;
  const left = 14;
  const width = left + lanes.length * gap + 10;
  const height = rows.length * rowH + 12;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'graph');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const x = (lane) => left + lane * gap;
  const y = (i) => i * rowH + rowH / 2;
  const add = (tag, attrs) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    svg.append(node);
    return node;
  };

  // Each lane runs from the first time it speaks to the last: the line down the side.
  lanes.forEach((ref, lane) => {
    const first = rows.findIndex((r) => (r.actor ?? 'thread') === ref);
    const last = rows.findLastIndex((r) => (r.actor ?? 'thread') === ref);
    if (first < 0) return;
    add('line', { x1: x(lane), y1: y(first), x2: x(lane), y2: y(last), class: 'graph-lane', stroke: colourOf(ref) });
  });

  // Where it passed from one lane to another: the curve, as a branch joins another in a git graph.
  rows.forEach((row, i) => {
    if (i === 0) return;
    const from = laneOf(rows[i - 1].actor ?? 'thread');
    const to = laneOf(row.actor ?? 'thread');
    if (from === to) return;
    add('path', { d: `M ${x(from)} ${y(i - 1)} C ${x(from)} ${y(i - 1) + rowH * 0.6}, ${x(to)} ${y(i) - rowH * 0.6}, ${x(to)} ${y(i)}`, class: 'graph-join', stroke: colourOf(row.actor ?? 'thread') });
  });

  // A dot per thing said, in its lane.
  rows.forEach((row, i) => {
    const lane = laneOf(row.actor ?? 'thread');
    add('circle', { cx: x(lane), cy: y(i), r: row.role === 'user' ? 5 : 4, class: `graph-dot ${row.role === 'user' ? 'person' : ''}`, fill: colourOf(row.actor ?? 'thread') });
  });

  const list = h('div', { class: 'graph-rows' }, rows.map((row, i) => {
    const speaker = who(row.actor);
    const turn = row.role === 'assistant' ? turnFor(row.seq, row.actor) : undefined;
    const cost = turn?.costUsd && !turn.costUnknown ? ` · ${turn.billing === 'plan' ? '≈' : ''}$${turn.costUsd.toFixed(2)}` : '';
    const took = turn ? ` · ${duration(turn.until - turn.at)}` : '';
    const line = h(
      'button',
      {
        type: 'button',
        class: `graph-row ${turn?.stopReason === 'aborted' ? 'stopped' : ''}`,
        style: `height:${rowH}px`,
        title: 'Open it in the thread',
        onclick: () => {
          detail.textContent = `${new Date(row.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${speaker?.name ?? 'Someone'}${took}${cost}: ${row.preview}`;
          go(`#/s/${id}?at=${row.seq}`);
        },
      },
      h('b', {}, speaker?.name ?? 'Someone'),
      h('span', { class: 'graph-said' }, row.preview),
      h('span', { class: 'graph-when' }, `${new Date(row.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${took}${cost}`),
    );
    void i;
    return line;
  }));

  const legend = h('div', { class: 'graph-legend' }, lanes.map((ref, lane) => {
    const actor = who(ref);
    void lane;
    return h('span', { class: 'graph-key' }, h('i', { style: `background:${colourOf(ref)}` }), actor?.name ?? 'The thread');
  }));
  const totals = costOf(flow.turns);
  fill(holder,
    legend,
    h('div', { class: 'graph-wrap' }, svg, list),
    h('p', { class: 'hint tight' }, `${lanes.length} here · ${totals.turns} turn${totals.turns === 1 ? '' : 's'} · ${rows.length} messages${totals.said}`),
  );
}

/** Rename, archive, or delete a thread: housekeeping, kept out of the way of the conversation. */
function threadActions(s) {
  const id = s.meta.id;
  const name = h('input', { id: 'thread-rename', value: s.meta.title, maxlength: 80, 'aria-label': 'Title' });
  const rename = async () => {
    const text = name.value.trim();
    if (!text) return name.focus();
    try {
      const { title } = await api(`/api/sessions/${id}/title`, { text });
      s.meta.title = title;
      if ($('#thread-title')) $('#thread-title').textContent = title;
      wrap.remove();
      toast('Renamed.');
      refreshSoon();
    } catch (err) {
      showError(err);
    }
  };
  name.addEventListener('keydown', (e) => e.key === 'Enter' && rename());
  const archived = Boolean(s.meta.archivedAt);
  const archive = async () => {
    try {
      await api(`/api/sessions/${id}/archive`, { on: !archived });
      wrap.remove();
      if (archived) {
        s.meta.archivedAt = undefined;
        toast('Back on your lists.');
        refreshSoon();
      } else {
        toast('Archived. Search still finds it, and a new message brings it back.');
        await refresh().catch(() => {});
        goBack();
      }
    } catch (err) {
      showError(err);
    }
  };
  const remove = async () => {
    if (!(await confirmSheet(`Delete “${s.meta.title || 'this thread'}”?`, 'Its whole conversation goes. This can’t be undone.', { yes: 'Delete', danger: true }))) return;
    try {
      await api(`/api/sessions/${id}/delete`, {});
      wrap.remove();
      toast('Deleted.');
      await refresh().catch(() => {});
      location.replace('#/');
    } catch (err) {
      showError(err);
    }
  };
  function toggleAction(label, hint, action, on) {
    const button = h('button', { class: 'btn wide' }, label);
    button.addEventListener('click', async () => {
      try {
        await api(`/api/sessions/${id}/${action}`, { on });
        if (action === 'keep') s.meta.kept = on;
        else s.meta.finishedAt = on ? Date.now() : undefined;
        wrap.remove();
        toast(action === 'keep' ? (on ? 'Kept.' : 'No longer kept.') : on ? 'Marked finished.' : 'Not finished.');
        refresh().catch(() => {});
      } catch (err) {
        showError(err);
      }
    });
    return [button, h('p', { class: 'hint' }, hint)];
  }
  const outcomeText = h('input', { id: 'thread-outcome', value: s.work?.outcome?.text ?? '', maxlength: 120, placeholder: 'What it’s trying to achieve', 'aria-label': 'Outcome' });
  const track = async () => {
    const text = outcomeText.value.trim();
    if (!text) return outcomeText.focus();
    try {
      const { work } = await api(`/api/sessions/${id}/outcome`, { text });
      wrap.remove();
      current_work(s, work);
      toast('Tracking it as work. Start a run when you’re ready.');
    } catch (err) {
      showError(err);
    }
  };
  const drop = async () => {
    if (!(await confirmSheet('Drop the outcome?', ['It goes back to being a chat, in the same place.', 'Its runs and everything they gathered stay.'], { yes: 'Drop it' }))) return;
    try {
      const { work } = await api(`/api/sessions/${id}/outcome`, { drop: true });
      current_work(s, work);
      toast('Back to a chat.');
    } catch (err) {
      showError(err);
    }
  };
  const canWork = s.canAct !== false;
  // Settings that used to be chips on the thread: they're still one tap from here.
  const modelPick = h('select', { id: 'thread-model', 'aria-label': 'Model', onchange: (e) => api(`/api/sessions/${id}/model`, { model: e.target.value }).then(({ model }) => { s.model = model; drawThreadState(); }).catch(showError) }, modelOptions(s.model?.label));
  const segmented = (options, currentValue, onpick) => {
    const box = h('div', { class: 'segmented' });
    for (const [value, label, cls] of options) {
      const b = h('button', { type: 'button', class: cls ?? '', 'aria-pressed': String(value === currentValue) }, label);
      b.addEventListener('click', async () => {
        if ((await onpick(value)) === false) return;
        for (const other of box.children) other.setAttribute('aria-pressed', String(other === b));
      });
      box.append(b);
    }
    return box;
  };
  const views = segmented([['compact', 'Compact'], ['detailed', 'Detailed']], viewMode(), (value) => {
    setViewMode(value);
    renderLog();
  });
  const modes = segmented([[false, s.asks === false ? 'Doesn’t ask (Codex)' : 'Asks first'], [true, 'YOLO', 'yolo']], Boolean(s.autoApprove), async (on) => {
    if (on === Boolean(current?.autoApprove)) return;
    await toggleMode();
    return Boolean(current?.autoApprove) === on;
  });
  const group = (s.members ?? []).length > 1;
  const guardPick = h(
    'select',
    { id: 'thread-guard', 'aria-label': 'Pause between agents', onchange: async (e) => {
      const limit = e.target.value === 'default' ? null : Number(e.target.value);
      try {
        const answer = await api(`/api/sessions/${id}/guard`, { limit });
        s.guard = { limit: answer.guardLimit, default: answer.default };
        drawThreadState();
      } catch (err) {
        showError(err);
      }
    } },
    [['default', `After ${s.guard?.default ?? 6} exchanges (the default)`], ...[...new Set([2, 12, s.guard?.limit].filter((n) => n > 0))].sort((a, b) => a - b).map((n) => [String(n), `After ${n} exchanges`]), ['0', 'Don’t pause in this thread']].map(([value, label]) => h('option', { value, selected: String(s.guard?.limit ?? 'default') === value }, label)),
  );
  const spinTitle = h('input', { id: 'thread-spinout', maxlength: 60, placeholder: 'What the new thread is for', 'aria-label': 'Spin out' });
  const spinOut = async () => {
    const text = spinTitle.value.trim();
    if (!text) return spinTitle.focus();
    try {
      const { id: child } = await api(`/api/sessions/${id}/spinout`, { text });
      wrap.remove();
      await refresh().catch(() => {});
      go(`#/s/${child}`);
    } catch (err) {
      showError(err);
    }
  };
  // Its id, faint, for pointing someone (or an agent working on polyphemus) at exactly this thread.
  const idLine = h('button', { type: 'button', class: 'thread-id', title: 'Copy the thread’s id', onclick: async () => {
    try {
      await navigator.clipboard.writeText(id);
      toast(`Copied ${id}.`);
    } catch {
      toast(`The thread’s id is ${id}.`);
    }
  } }, `Thread ${id}`, icon('copy', 'ico mini'));
  const wrap = sheet('This thread', [
    idLine,
    h('label', { class: 'field' }, h('span', {}, 'Called'), name),
    h('button', { class: 'btn wide', onclick: rename }, 'Rename'),
    canWork ? sec('Settings') : null,
    canWork ? h('label', { class: 'field' }, h('span', {}, 'Model'), modelPick) : null,
    canWork ? h('div', { class: 'field' }, h('span', {}, 'Before commands that change things'), modes, h('small', { class: 'hint' }, 'Turning off asking never widens what an agent was granted.')) : null,
    h('div', { class: 'field' }, h('span', {}, 'Show the work'), views),
    h('button', { class: 'btn wide', onclick: () => (wrap.remove(), go(`#/flow/${id}`)) }, 'See how it flowed'),
    canWork && group ? h('label', { class: 'field' }, h('span', {}, 'When agents talk among themselves, pause and ask'), guardPick) : null,
    canWork ? sec('Spin out') : null,
    canWork ? h('label', { class: 'field' }, h('span', {}, 'A new thread for part of this one'), spinTitle) : null,
    canWork ? h('button', { class: 'btn wide', onclick: spinOut }, 'Spin it out') : null,
    canWork ? h('p', { class: 'hint' }, 'Same agents and project. Each links to the other.') : null,
    canWork ? sec('Work') : null,
    canWork ? h('label', { class: 'field' }, h('span', {}, s.work?.outcome ? 'Its outcome' : 'Track it as work'), outcomeText) : null,
    canWork ? h('button', { class: 'btn wide', onclick: track }, s.work?.outcome ? 'Change the outcome' : 'Track it') : null,
    canWork ? h('p', { class: 'hint' }, s.work?.outcome ? 'Runs so far stay with the outcome they were for.' : 'It stays this thread, in the same place. It gains a status, and runs you start plan steps and keep evidence.') : null,
    canWork && s.work?.outcome ? h('button', { class: 'btn wide', onclick: drop }, 'Drop the outcome') : null,
    sec('Keep or finish'),
    toggleAction(s.meta.kept ? 'Stop keeping it' : 'Keep it', s.meta.kept ? 'It can leave Home again once it’s finished.' : 'A thread you come back to: it never leaves Home on its own.', 'keep', !s.meta.kept),
    toggleAction(s.meta.finishedAt ? 'It isn’t finished' : 'Mark it finished', s.meta.finishedAt ? 'Back to an ordinary thread.' : 'It ended. Still openable; it leaves Home after a week, and stays in search and its project.', 'finish', !s.meta.finishedAt),
    sec('Put it away'),
    h('button', { class: 'btn wide', onclick: archive }, archived ? 'Unarchive' : 'Archive'),
    h('p', { class: 'hint' }, archived ? 'It’s archived: off your lists, still in search.' : 'Off your lists, nothing lost. Search still finds it, and sending it a message brings it back.'),
    h('button', { class: 'btn wide danger', onclick: remove }, 'Delete'),
    h('p', { class: 'hint' }, 'Gone for good, with everything said in it.'),
  ]);
}

/**
 * Every thread, not only the recent ones Home shows: a search, the archive, a project's, or an
 * agent's. One screen, because they're the same list with a different question asked of it.
 */
async function threadsScreen({ q, archived, project, agent }) {
  const p = project ? projectOf(project) : null;
  const who = agent ? agentByRef(agent) : null;
  const heading = archived ? 'Archived' : p ? p.name : agent ? `With ${who?.title ?? agent}` : 'Search';
  const results = h('div', { id: 'thread-results' });
  const searching = !archived && !project && !agent;
  const box = searching ? h('input', { id: 'thread-search', type: 'search', value: q, placeholder: 'Titles and what was said', 'aria-label': 'Search threads', enterkeyhint: 'search' }) : null;
  const draw = (sessions, empty) => fill(results, sessions.length ? h('div', { class: 'list' }, sessions.map((s) => sessionRow(s, !project))) : h('p', { class: 'empty' }, empty));
  let asked = 0;
  const load = async () => {
    const mine = ++asked;
    const words = box?.value.trim() ?? '';
    if (searching && !words) return draw([], 'Search every thread, archived ones too.');
    const query = searching ? `q=${encodeURIComponent(words)}` : archived ? 'archived=1' : project ? `project=${encodeURIComponent(project)}` : `agent=${encodeURIComponent(agent)}`;
    try {
      const { sessions } = await api(`/api/sessions?${query}`);
      if (mine !== asked || view.name !== 'threads') return; // a newer search, or you left
      draw(sessions, searching ? `Nothing mentions “${words}”.` : archived ? 'Nothing archived.' : 'No threads yet.');
    } catch (err) {
      showError(err);
    }
  };
  let timer;
  box?.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      // Kept in the address, so Back from a result returns to the same search.
      history.replaceState(null, '', box.value.trim() ? `#/threads?q=${encodeURIComponent(box.value.trim())}` : '#/threads');
      load();
    }, 200);
  });
  screen(bar(backButton(), title(heading)), [box ? h('label', { class: 'field' }, box) : null, results], { mainClass: 'plain' });
  box?.focus();
  await load();
}

/** YOLO runs every tool without asking, for this session only (until the daemon restarts). */
function showMode() {
  drawThreadState();
}

/**
 * Who and what, in one calm line: who's in it and who leads, the project, where it was spun out
 * from — and only the settings that aren't the default, in words. Everything else is in ⋯.
 */
function drawThreadState() {
  const line = $('#thread-state');
  const s = current;
  if (!line || !s) return;
  const members = s.members ?? [];
  const listed = sessionById(s.meta.id);
  const project = listed?.project ? projectOf(listed.project) : s.meta.cwd ? state.projects.find((p) => p.path === s.meta.cwd) : null;
  const lead = members.find((m) => m.id === s.lead);
  const bullet = () => h('span', { class: 'bullet' });
  // A conversation between people runs nothing: no agent, model or computer to speak of.
  const betweenPeople = !project && !members.length && (s.people ?? []).some((p) => p.id !== state.me?.id);
  line.hidden = betweenPeople;
  if (betweenPeople) {
    fill(line);
    return composerHint();
  }
  const parts = [
    h('button', { class: 'linky inline', onclick: () => showMembers(s) }, members.length > 1 ? `${members.length} agents${lead ? ` · ${lead.title} leads` : ''}` : members.length === 1 ? `With ${members[0].title}` : 'No agent'),
    project ? h('button', { class: 'linky inline muted', title: `${project.name}: its setup`, onclick: () => go(`#/p/${encodeURIComponent(project.slug)}?tab=setup&from=${s.meta.id}`) }, project.name) : null,
    threadRunsOn(s, project),
    s.spunFrom ? (s.spunFrom.visible ? h('button', { class: 'linky inline muted', onclick: () => go(`#/s/${s.spunFrom.id}`) }, `Spun out of ${s.spunFrom.title}`) : h('span', {}, 'Spun out of another thread')) : null,
    s.autoApprove ? h('button', { class: 'linky inline warnish', title: 'Tap to ask again', onclick: toggleMode }, 'YOLO — no approvals') : null,
    members.length > 1 && s.guard?.limit === 0 ? h('span', { class: 'warnish' }, 'Not pausing between agents') : null,
    (s.work?.outcome || s.work?.runs?.length) && roomyScreen.matches && !$('#app').classList.contains('run-pane-open')
      ? h('button', { class: 'linky inline', onclick: () => {
          remember('polyphemus.runPane', 'open');
          $('#app').classList.add('run-pane-open');
          drawThreadState();
        } }, 'Show the run')
      : null,
  ].filter(Boolean);
  fill(line, ...parts.flatMap((p, i) => (i ? [bullet(), p] : [p])));
  composerHint();
}

/** On what, and where: "Claude Code · claude-opus-5 · Isolated", tapped for what isolation means. */
function threadRunsOn(s, project) {
  const m = s.model ? (modelByRef(s.model.label) ?? modelByRef(`${s.model.provider}:${s.model.model}`)) : null;
  const level = state.isolation?.levels.find((l) => l.id === s.isolation) ?? null;
  if (!m && !level) return null;
  const stops = isolationStops(level, m);
  const words = [m ? modelShort(m) : null, level?.title].filter(Boolean).join(' · ');
  return h('button', { class: `linky inline ${stops ? 'warnish' : 'muted'}`, title: 'Where its commands and file changes run', onclick: () => isolationSheet(project, m) }, words);
}

async function toggleMode() {
  const on = !current.autoApprove;
  if (on && !(await confirmSheet('YOLO in this thread?', ['Every command runs without asking you first, for as long as it’s on.', 'It never widens what an agent was granted.'], { yes: 'Turn on YOLO', danger: true }))) return;
  try {
    current.autoApprove = (await api(`/api/sessions/${current.meta.id}/yolo`, { on })).autoApprove;
    showMode();
  } catch (err) {
    showError(err);
  }
}

// ── How a conversation shows its work ────────────────────────────────────
// Compact (the default) folds each reply's steps into one summary line you can open; Detailed
// shows every command and file in order. Approvals, errors, and notices always show.

const viewMode = () => (remembered('polyphemus.view') === 'detailed' ? 'detailed' : 'compact');
const setViewMode = (mode) => remember('polyphemus.view', mode);
const viewLabel = () => (viewMode() === 'compact' ? 'Compact' : 'Detailed');

/** The nudge polyphemus sends so a new agent speaks first. Shown as a note, never as your message. */
const INTRODUCE_YOURSELF_PREFIX = "You've just been added to polyphemus and this is the first thing";
const isIntroNudge = (m) => m.role === 'user' && (userText(m) ?? '').startsWith(INTRODUCE_YOURSELF_PREFIX);

const userText = (m) => m.content.filter((b) => b.type === 'text').map((b) => b.text.replace(STATUS_LINE, '')).join('\n').trim();
const hasImages = (m) => m.content.some((b) => b.type === 'image');

/** The pictures you attached to a message; tap one to see it full size. */
function imageRow(m) {
  const images = m.content.filter((b) => b.type === 'image');
  if (!images.length) return null;
  return h(
    'div',
    { class: 'msg-images' },
    images.map((b) => {
      const src = `/api/images/${b.path.split('/').pop()}`;
      return h('a', { href: src, target: '_blank', rel: 'noopener' }, h('img', { src, alt: b.name || 'Attached image', loading: 'lazy' }));
    }),
  );
}

/** Splits a conversation into turns: each starts at a message you typed and runs until the next. */
function spans(messages, turns, notes, times = [], actors = [], artifacts = []) {
  const out = [];
  messages.forEach((m, i) => {
    if (!out.length || (m.role === 'user' && (userText(m) || hasImages(m)))) out.push({ start: i, messages: [], times: [], actors: [], turns: [], notes: [], artifacts: [] });
    out.at(-1).messages.push(m);
    out.at(-1).times.push(times[i]);
    out.at(-1).actors.push(actors[i] ?? null);
  });
  const home = (seq) => out.findLast((span) => span.start < seq) ?? out[0];
  for (const t of turns ?? []) home(t.endSeq)?.turns.push(t);
  for (const n of notes ?? []) home(n.seq)?.notes.push(n);
  for (const a of artifacts ?? []) home(a.seq)?.artifacts.push(a);
  return out;
}

const READS = /^(read|read_file|grep|glob|ls|list|search|web_?fetch|web_?search|view)$/i;
const EDITS = /^(edit|write|write_file|edit_file|multi_?edit|notebook_?edit|apply_patch|str_replace.*)$/i;
const RUNS = /^(bash|shell|exec|command|local_shell|terminal)$/i;
const toolLine = (b) => h('div', { class: 'tool' }, '● ', h('b', {}, b.name), ' ', summarize(b.input));
// A tool's result, and any pictures it handed the model (a page it looked at), small.
const resultLine = (b) => h('div', { class: `result ${b.isError ? 'error' : ''}` }, clip(b.content, 400), b.images?.length ? imageRow({ content: b.images }) : null);

function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
const tokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

/**
 * What a set of turns cost, and how many of them can't be counted: polyphemus kept a vendor CLI's
 * running total as the turn's cost until 2026-09-20, so those turns hold the session's total so far
 * and nothing may add them up. Said out loud rather than quietly left out of a number.
 */
function costOf(turns) {
  const counted = turns.filter((t) => t.costUsd != null && !t.costUnknown);
  const unknown = turns.filter((t) => t.costUnknown).length;
  const cost = counted.reduce((sum, t) => sum + t.costUsd, 0);
  const said = [cost ? `≈$${cost.toFixed(2)}` : '', unknown ? `${unknown} turn${unknown === 1 ? '' : 's'} before polyphemus counted cost per turn` : ''].filter(Boolean).join(' · ');
  return { turns: turns.length, cost, unknown, said: said ? ` · ${said}` : '' };
}

/** "Worked 1m 12s", and "20.1k in (10.1k cached) · 293 out · ≈$0.11 on your plan", for a turn's records. */
function turnStats(turns) {
  if (!turns.length) return { time: '', usage: '' };
  const sum = turns.reduce(
    (a, t) => ({
      ms: a.ms + (t.endedAt - t.startedAt),
      in: a.in + t.usage.inputTokens + t.usage.cacheReadTokens + t.usage.cacheWriteTokens,
      cached: a.cached + t.usage.cacheReadTokens,
      out: a.out + t.usage.outputTokens,
      cost: a.cost + (t.costUnknown ? 0 : (t.costUsd ?? 0)),
      plan: a.plan || t.billing === 'plan',
    }),
    { ms: 0, in: 0, cached: 0, out: 0, cost: 0, plan: false },
  );
  const parts = [];
  if (sum.in + sum.out > 0) parts.push(`${tokens(sum.in)} in${sum.cached ? ` (${tokens(sum.cached)} cached)` : ''}`, `${tokens(sum.out)} out`);
  if (sum.cost > 0) parts.push(sum.plan ? `≈$${sum.cost.toFixed(2)} on your plan` : `$${sum.cost.toFixed(2)}`);
  return { time: duration(sum.ms), usage: parts.join(' · ') };
}

// ── Times and dates ──────────────────────────────────────────────────────

const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function dayLabel(ts) {
  const day = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (day.toDateString() === today.toDateString()) return 'Today';
  if (day.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return day.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...(day.getFullYear() !== today.getFullYear() && { year: 'numeric' }) });
}
/** A small time under a message; the full date and time when you hold or hover on it. */
const stamp = (ts, side) => (ts ? h('time', { class: `stamp ${side}`, datetime: new Date(ts).toISOString(), title: new Date(ts).toLocaleString() }, clock(ts)) : null);

function renderLog() {
  const log = $('#log');
  if (!log || !current) return;
  const all = spans(current.messages, current.turns, current.notes, current.times, current.actors, current.artifacts);
  const compact = viewMode() === 'compact';
  let lastDay = '';
  const nodes = all.flatMap((span, i) => {
    // A date divider wherever the day changes, so every time has its date.
    const first = span.times.find(Boolean);
    const day = first ? new Date(first).toDateString() : '';
    const divider = day && day !== lastDay ? h('div', { class: 'day' }, dayLabel(first)) : null;
    if (day) lastDay = day;
    return [divider, ...(compact ? compactSpan(span, current.running && i === all.length - 1) : detailedSpan(span))].filter(Boolean);
  });
  fill(log, ...nodes);
  spokeIn = new WeakSet();
  if (streaming.size) for (const bubble of streaming.values()) log.append(bubble);
  // Thinking, unless the live summary of its steps is already showing who's working.
  else if (current.running && !log.querySelector('.activity.working-now')) log.append(thinkingRow());
}

/**
 * Something an agent made, drawn where it showed it: an image or SVG as an image, a CSV as a table,
 * Markdown as text, and an HTML page in a sandboxed frame that can run its own scripts but can't
 * reach polyphemus, your cookies, or the network.
 */
function artifactCard(a) {
  const file = `/artifacts/${a.id}/file`;
  const open = a.kind === 'html' ? `/artifacts/${a.id}/frame` : file;
  const kinds = { image: 'Image', svg: 'Image', html: 'Page', csv: 'Table', markdown: 'Document', text: 'Text' };
  const body = h('div', { class: `artifact-body ${a.kind}` });
  if (a.kind === 'image' || a.kind === 'svg') body.append(h('img', { src: file, alt: a.title, loading: 'lazy' }));
  else if (a.kind === 'html') body.append(h('iframe', { src: open, title: a.title, sandbox: 'allow-scripts', loading: 'lazy', referrerpolicy: 'no-referrer' }));
  else {
    body.append(h('p', { class: 'hint tight' }, 'Loading…'));
    fetch(file)
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((text) => fill(body, a.kind === 'csv' ? csvTable(text) : a.kind === 'markdown' ? h('div', { class: 'md' }, markdown(text)) : h('pre', { class: 'code' }, h('code', {}, clip(text, 20000)))))
      .catch((err) => fill(body, h('p', { class: 'hint tight' }, `Couldn’t load it: ${err.message}`)));
  }
  const speaker = a.by?.startsWith('agent:') ? agentByRef(a.by.slice(6))?.title : null;
  return h(
    'figure',
    { class: 'artifact' },
    h(
      'figcaption',
      {},
      h('span', { class: 'grow' }, h('b', {}, a.title), h('small', {}, [kinds[a.kind] ?? a.kind, speaker ? `from ${speaker}` : null, a.bytes < 1024 ? `${a.bytes} bytes` : `${Math.round(a.bytes / 1024)} KB`].filter(Boolean).join(' · '))),
      h('a', { class: 'btn small', href: open, target: '_blank', rel: 'noopener noreferrer' }, 'Open'),
      h('a', { class: 'btn small', href: `/artifacts/${a.id}/download`, download: a.name }, 'Download'),
    ),
    body,
  );
}

/**
 * What's been made here: the files agents produced across the project's threads, newest first, each
 * saying which thread it came out of. They existed only inside that thread before, so a document or
 * a page you asked for last week was findable only by remembering where you asked for it.
 */
function madeCard(p) {
  const list = h('div', { class: 'list' });
  const section = h('div', {}, sec('What’s been made'), list);
  const kinds = { image: 'Image', svg: 'Image', html: 'Page', csv: 'Table', markdown: 'Document', text: 'Text' };
  void api(`/api/projects/${encodeURIComponent(p.slug)}/artifacts`)
    .then(({ artifacts }) => {
      if (!artifacts?.length) {
        section.remove();
        return;
      }
      fill(
        list,
        ...artifacts.slice(0, 8).map((a) => {
          const made = a.by?.startsWith('agent:') ? agentByRef(a.by.slice(6))?.title : null;
          return h(
            'a',
            { class: 'item made', href: a.kind === 'html' ? `/artifacts/${a.id}/frame` : `/artifacts/${a.id}/file`, target: '_blank', rel: 'noopener noreferrer' },
            icon(a.kind === 'image' || a.kind === 'svg' ? 'image' : 'doc'),
            h(
              'span',
              { class: 'grow' },
              h('span', {}, a.title),
              h('small', {}, [kinds[a.kind] ?? a.kind, made ? `from ${made}` : null, a.in ? `in “${clip(a.in, 40)}”` : null, `${ago(a.createdAt)} ago`].filter(Boolean).join(' · ')),
            ),
          );
        }),
      );
      if (artifacts.length > 8) list.append(h('p', { class: 'hint tight' }, `${artifacts.length - 8} more in their own threads.`));
    })
    .catch(() => section.remove());
  return section;
}

/** A CSV as a table: the first 200 rows, with the header row as headings. */
function csvTable(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length && rows.length <= 200; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') row.push(cell), (cell = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell]);
  const [head = [], ...rest] = rows.filter((r) => r.some((x) => x !== ''));
  return h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, head.map((x) => h('th', {}, x)))), h('tbody', {}, rest.slice(0, 200).map((r) => h('tr', {}, r.map((x) => h('td', {}, x)))))));
}

const noteLines = (span) =>
  span.notes.map((n) => h('div', { class: n.kind === 'notice' ? 'notice' : 'info' }, n.text, n.link ? [' ', h('button', { class: 'linky inline', onclick: () => go(n.link.href) }, n.link.label)] : null));

/**
 * Whoever is answering, thinking: their own mark, breathing, where their reply will appear — not a
 * dot by the message box. A thread with no agent shows its model's mark.
 */
function thinkingRow() {
  const id = current?.speaker ?? current?.meta?.agent;
  const agent = id ? (agentByRef(id) ?? (current?.members ?? []).find((m) => m.id === id)) : null;
  const who = agent?.title ?? current?.model?.label ?? 'It';
  return h(
    'div',
    { class: 'thinking', id: 'thinking', role: 'status', 'aria-live': 'polite' },
    alive(agent ? mark(agent.mark ?? agent.name, 28) : threadMark(current?.meta, 28), true),
    h('span', { class: 'thinking-words' }, `${who} is thinking`, h('span', { class: 'thinking-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'))),
  );
}

/** A hand-off from one agent to another, as polyphemus wrote it: shown with the reply, not as a message. */
function handoffOf(m) {
  if (m.role !== 'user') return null;
  const match = new RegExp(`^<${TAG}_handoff from="([^"]*)" to="([^"]*)">`).exec(userText(m));
  return match ? { from: match[1], to: match[2] } : null;
}

/**
 * An agent's reply. In a thread with several agents it says who's speaking (and who leads); a reply
 * to another agent rather than to a person is inset — quieter, and always visible.
 */
function agentReply(span, k, text, first) {
  const actor = span.actors[k];
  const id = actor?.startsWith('agent:') ? actor.slice(6) : null;
  const agent = id ? (agentByRef(id) ?? (current?.members ?? []).find((m) => m.id === id)) : null;
  const handoff = handoffOf(span.messages[0]);
  if (handoff) {
    return [
      h(
        'div',
        { class: 'aside-msg' },
        first ? h('div', { class: 'who' }, agent ? mark(agent.mark ?? agent.name, 16) : null, h('b', {}, agent?.title ?? handoff.to), h('span', {}, `to ${handoff.from}`)) : null,
        h('div', { class: 'what md' }, markdown(text)),
      ),
    ];
  }
  const bubble = reactable(h('div', { class: `msg bot md${onlyEmoji(text) ? ' jumbo' : ''}${multiplePeople() && mentionsMe(text) ? ' mentions-me' : ''}` }, markdown(text)), span.start + k);
  if (!first || !agent || (current?.members?.length ?? 0) < 2) return [bubble];
  return [h('div', { class: 'speaker' }, mark(agent.mark ?? agent.name, 18), h('b', {}, agent.title), current.lead === agent.id ? h('span', { class: 'lead' }, 'lead') : null), bubble];
}

/** Spans whose speaker line has been drawn, so a speaker is named once per turn. */
let spokeIn = new WeakSet();

function detailedSpan(span) {
  const nodes = [];
  span.messages.forEach((m, k) => {
    const at = span.times[k];
    if (m.role === 'user') {
      for (const b of m.content) if (b.type === 'tool_result') nodes.push(resultLine(b));
      const text = userText(m);
      const pictures = imageRow(m);
      if (pictures) nodes.push(pictures);
      if (handoffOf(m)) {
        // shown with the reply it led to
      } else if (runMarker(m)) nodes.push(runMarker(m));
      else if (isIntroNudge(m)) nodes.push(h('div', { class: 'day' }, 'polyphemus asked it to introduce itself'));
      else if (text) nodes.push(...userBubble(text, span.actors[k], span.start + k));
      if ((text || pictures) && !handoffOf(m)) nodes.push(stamp(at, isTheirs(span.actors[k]) ? 'bot' : 'you'), reactionRow(span.start + k, isTheirs(span.actors[k]) ? 'bot' : 'you'));
      return;
    }
    let said = false;
    for (const b of m.content) {
      if (b.type === 'text' && b.text.trim()) {
        nodes.push(...agentReply(span, k, b.text, !spokeIn.has(span)));
        spokeIn.add(span);
        said = true;
      } else if (b.type === 'tool_call') nodes.push(toolLine(b));
    }
    if (said) nodes.push(stamp(at, 'bot'), reactionRow(span.start + k, 'bot'));
  });
  const { time, usage } = turnStats(span.turns);
  if (time || usage) nodes.push(h('div', { class: 'stats-line' }, [time && `Took ${time}`, usage].filter(Boolean).join(' · ')));
  return [...nodes, ...(span.artifacts ?? []).map(artifactCard), ...noteLines(span)];
}

function compactSpan(span, live) {
  const asked = [];
  const steps = [];
  const replies = [];
  const counts = { read: 0, edit: 0, run: 0, other: 0 };
  let failed = 0;
  let lastStep = '';
  let repliedAt;
  let lastReplySeq;
  for (const [k, m] of span.messages.entries()) {
    if (m.role === 'user') {
      for (const b of m.content) {
        if (b.type !== 'tool_result') continue;
        steps.push(resultLine(b));
        if (b.isError) failed += 1;
      }
      const text = userText(m);
      const pictures = imageRow(m);
      if (pictures) asked.push(pictures);
      if (handoffOf(m)) {
        // shown with the reply it led to
      } else if (runMarker(m)) asked.push(runMarker(m));
      else if (isIntroNudge(m)) asked.push(h('div', { class: 'day' }, 'polyphemus asked it to introduce itself'));
      else if (text) asked.push(...userBubble(text, span.actors[k], span.start + k));
      if ((text || pictures) && !handoffOf(m)) asked.push(stamp(span.times[k], isTheirs(span.actors[k]) ? 'bot' : 'you'), reactionRow(span.start + k, isTheirs(span.actors[k]) ? 'bot' : 'you'));
      continue;
    }
    for (const b of m.content) {
      if (b.type === 'text' && b.text.trim()) {
        replies.push(...agentReply(span, k, b.text, replies.length === 0));
        repliedAt = span.times[k];
        lastReplySeq = span.start + k;
      } else if (b.type === 'tool_call') {
        steps.push(toolLine(b));
        counts[READS.test(b.name) ? 'read' : EDITS.test(b.name) ? 'edit' : RUNS.test(b.name) ? 'run' : 'other'] += 1;
        lastStep = `${b.name} ${summarize(b.input)}`;
      }
    }
  }
  const { time, usage } = turnStats(span.turns);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const did = [
    counts.read ? `read ${plural(counts.read, 'file', 'files')}` : '',
    counts.run ? `ran ${plural(counts.run, 'command', 'commands')}` : '',
    counts.edit ? `edited ${plural(counts.edit, 'file', 'files')}` : '',
    counts.other ? `used ${plural(counts.other, 'tool', 'tools')}` : '',
  ].filter(Boolean);
  let summary = null;
  // Opened or closed by you stays that way: the thread is drawn again on every event while agents
  // work, and a folded group used to spring back open (a failed one always did).
  const key = `${current?.meta?.id ?? ''}:${span.start}`;
  const remembered = activityOpen.get(key);
  const keepOpen = (details) => {
    details.addEventListener('toggle', () => activityOpen.set(key, details.open));
    return details;
  };
  // Before it's done anything, the thinking row shows who's at it; once it has, this line does.
  if (live && steps.length) {
    summary = keepOpen(h(
      'details',
      { class: 'activity working-now', open: remembered === true },
      h('summary', {}, alive((() => {
        const id = current?.speaker ?? current?.meta?.agent;
        const agent = id ? (agentByRef(id) ?? (current?.members ?? []).find((m) => m.id === id)) : null;
        return agent ? mark(agent.mark ?? agent.name, 18) : threadMark(current?.meta, 18);
      })(), true), h('span', { class: 'sum-text' }, h('span', { class: 'what' }, 'Working ', h('span', { id: 'live-time' }, current.liveStartedAt ? duration(Date.now() - current.liveStartedAt) : ''), lastStep ? ` · ${clip(lastStep, 80)}` : ''))),
      h('div', { class: 'activity-body' }, steps),
    ));
  } else if (steps.length) {
    summary = keepOpen(h(
      'details',
      { class: `activity ${failed ? 'has-error' : ''}`, open: remembered ?? failed > 0 },
      h(
        'summary',
        {},
        icon('chev', 'ico mini chev-down'),
        h(
          'span',
          { class: 'sum-text' },
          h('span', { class: 'what' }, [time ? `Worked ${time}` : 'Worked', ...did].join(' · '), failed ? h('span', { class: 'failed' }, ` · ${failed} failed`) : null),
          usage ? h('span', { class: 'tokens' }, usage) : null,
        ),
      ),
      h('div', { class: 'activity-body' }, steps),
    ));
  } else if (time || usage) {
    summary = h('div', { class: 'stats-line' }, [time && `Took ${time}`, usage].filter(Boolean).join(' · '));
  }
  // Your message, what it did (folded), what it said (with when it finished), then anything polyphemus had to tell you.
  return [...asked, summary, ...(span.artifacts ?? []).map(artifactCard), ...replies, replies.length ? stamp(repliedAt, 'bot') : null, replies.length ? reactionRow(lastReplySeq, 'bot') : null, ...noteLines(span)].filter(Boolean);
}

/** Which work groups you opened or closed, by thread and where the group starts: kept across redraws. */
const activityOpen = new Map();

// ── Emoji: the picker, reactions, and big emoji ──────────────────────────
// Every emoji comes from the daemon (emojibase, MIT), loaded the first time the picker opens.

let emojiData = null;
async function emojiList() {
  if (!emojiData) {
    emojiData = api('/api/emoji').then((rows) => rows.map(([u, label, group, tags]) => ({ u, label, group, words: `${label} ${tags}`.toLowerCase() })));
    emojiData.catch(() => (emojiData = null));
  }
  return emojiData;
}
const EMOJI_GROUPS = [[0, '😀', 'Smileys'], [1, '👋', 'People'], [3, '🐻', 'Animals & nature'], [4, '🍔', 'Food & drink'], [5, '✈️', 'Travel & places'], [6, '⚽', 'Activities'], [7, '💡', 'Objects'], [8, '🔣', 'Symbols'], [9, '🏁', 'Flags']];
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const recentEmoji = () => {
  try {
    return JSON.parse(remembered('polyphemus.recentEmoji') || '[]');
  } catch {
    return [];
  }
};
const useEmoji = (u) => remember('polyphemus.recentEmoji', JSON.stringify([u, ...recentEmoji().filter((x) => x !== u)].slice(0, 24)));

/** The picker: search, a row of groups, and a grid. Opens above (or below) `anchor`; `onPick` gets the character. */
function emojiPicker(anchor, onPick) {
  document.querySelector('.emoji-pop')?.remove();
  const search = h('input', { type: 'search', class: 'emoji-search', placeholder: 'Find an emoji', 'aria-label': 'Find an emoji' });
  const grid = h('div', { class: 'emoji-grid', role: 'listbox' });
  const tabs = h('div', { class: 'emoji-tabs' });
  const pop = h('div', { class: 'emoji-pop', role: 'dialog', 'aria-label': 'Emoji' }, search, tabs, grid);
  let group = recentEmoji().length ? 'recent' : 0;
  const close = () => {
    pop.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', escape, true);
  };
  const outside = (e) => !pop.contains(e.target) && !anchor.contains(e.target) && close();
  const escape = (e) => e.key === 'Escape' && (e.stopPropagation(), close());
  const cell = (e) => h('button', { type: 'button', class: 'emoji-cell', title: e.label, 'aria-label': e.label, onclick: () => {
    useEmoji(e.u);
    onPick(e.u);
    close();
  } }, e.u);
  const draw = async () => {
    const all = await emojiList().catch(() => []);
    const q = search.value.trim().toLowerCase();
    fill(tabs, [['recent', '🕘', 'Recently used'], ...EMOJI_GROUPS].map(([id, icon_, label]) => h('button', { type: 'button', class: `emoji-tab ${!q && group === id ? 'on' : ''}`, title: label, 'aria-label': label, onclick: () => {
      group = id;
      search.value = '';
      draw();
    } }, icon_)));
    const byChar = new Map(all.map((e) => [e.u, e]));
    const shown = q
      ? all.filter((e) => q.split(/\s+/).every((w) => e.words.includes(w))).slice(0, 240)
      : group === 'recent' ? recentEmoji().map((u) => byChar.get(u) ?? { u, label: u }) : all.filter((e) => e.group === group);
    fill(grid, shown.length ? shown.map(cell) : h('p', { class: 'hint', style: 'grid-column:1/-1;margin:8px' }, all.length ? 'Nothing matches that.' : 'Loading…'));
  };
  search.addEventListener('input', draw);
  document.body.append(pop);
  // Placed beside what opened it: above when there's room, otherwise below; kept on screen.
  const r = anchor.getBoundingClientRect();
  const width = Math.min(352, window.innerWidth - 16);
  pop.style.width = `${width}px`;
  // Starting at the button when there's room to the right, as a message box's picker does; else ending at it.
  const left = r.left + width <= window.innerWidth - 8 ? r.left : r.right - width;
  pop.style.left = `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`;
  if (r.top > 380) pop.style.bottom = `${window.innerHeight - r.top + 8}px`;
  else pop.style.top = `${r.bottom + 8}px`;
  setTimeout(() => {
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
  });
  draw();
  if (matchMedia('(pointer: fine)').matches) search.focus();
}

/** The message box's emoji button. */
const emojiButton = (input) => h('button', { type: 'button', class: 'round', 'aria-label': 'Emoji', title: 'Emoji', onclick: (e) => emojiPicker(e.currentTarget, (u) => insertAtCursor(input, u)) }, icon('smile'));

/** Puts an emoji where the cursor is in a message box, as if it were typed. */
function insertAtCursor(input, text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  input.selectionStart = input.selectionEnd = start + text.length;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
}

/** The reactions under a message: each emoji once, with how many, and yours marked. Tap to add or take back yours. */
function reactionRow(seq, side) {
  const mine = `person:${state.me?.id}`;
  const on = (current?.reactions ?? []).filter((r) => r.seq === seq);
  if (!on.length) return h('div', { class: `reactions ${side}`, 'data-reactions': String(seq), hidden: true });
  const groups = new Map();
  for (const r of on) groups.set(r.emoji, [...(groups.get(r.emoji) ?? []), r.actor]);
  return h(
    'div',
    { class: `reactions ${side}`, 'data-reactions': String(seq) },
    [...groups].map(([emoji, actors]) =>
      h('button', {
        type: 'button',
        class: `reaction ${actors.includes(mine) ? 'mine' : ''}`,
        title: actors.map((a) => (a === mine ? 'You' : actorName(a))).join(', '),
        onclick: () => react(seq, emoji),
      }, h('span', {}, emoji), actors.length > 1 ? h('b', {}, String(actors.length)) : null),
    ),
    h('button', { type: 'button', class: 'reaction add', 'aria-label': 'Add a reaction', onclick: (e) => emojiPicker(e.currentTarget, (u) => react(seq, u)) }, icon('smile', 'ico mini')),
  );
}

async function react(seq, emoji) {
  if (!current) return;
  try {
    const { reactions } = await api(`/api/sessions/${current.meta.id}/react`, { seq, emoji });
    current.reactions = reactions;
    redrawReactions();
  } catch (err) {
    showError(err);
  }
}

/** Every reaction row in the open thread, drawn again from what's known — nothing else moves. */
function redrawReactions() {
  for (const row of document.querySelectorAll('[data-reactions]')) row.replaceWith(reactionRow(Number(row.dataset.reactions), row.classList.contains('you') ? 'you' : 'bot'));
}

/**
 * Reacting to a message: hovering one (or pressing and holding on a phone) offers a few quick
 * reactions and the full picker. One bar, moved to whichever message you're on.
 */
function reactionsOn(log) {
  document.querySelector('.react-bar')?.remove();
  const bar = h('div', { class: 'react-bar', hidden: true });
  let seq = null;
  const show = (bubble) => {
    seq = Number(bubble.dataset.seq);
    fill(
      bar,
      QUICK_REACTIONS.map((u) => h('button', { type: 'button', class: 'emoji-cell small', 'aria-label': `React ${u}`, onclick: () => (react(seq, u), (bar.hidden = true)) }, u)),
      h('button', { type: 'button', class: 'emoji-cell small more', 'aria-label': 'More reactions', onclick: (e) => emojiPicker(e.currentTarget, (u) => react(seq, u)) }, icon('smile', 'ico mini')),
    );
    const r = bubble.getBoundingClientRect();
    bar.hidden = false;
    const width = bar.offsetWidth;
    const mineSide = bubble.classList.contains('you');
    bar.style.left = `${Math.max(8, Math.min(mineSide ? r.right - width : r.left, window.innerWidth - width - 8))}px`;
    bar.style.top = `${Math.max(8, r.top - bar.offsetHeight - 4)}px`;
  };
  document.body.append(bar);
  log.addEventListener('mouseover', (e) => {
    const bubble = e.target.closest?.('.reactable');
    if (bubble && canActIn(sessionById(current?.meta.id) ?? current?.meta)) show(bubble);
  });
  log.addEventListener('mouseleave', (e) => {
    if (!bar.contains(e.relatedTarget)) bar.hidden = true;
  });
  bar.addEventListener('mouseleave', (e) => {
    if (!e.relatedTarget?.closest?.('.reactable')) bar.hidden = true;
  });
  // A phone: press and hold a message.
  log.addEventListener('contextmenu', (e) => {
    const bubble = e.target.closest?.('.reactable');
    if (!bubble || matchMedia('(pointer: fine)').matches) return;
    e.preventDefault();
    show(bubble);
  });
  window.addEventListener('scroll', () => (bar.hidden = true), { passive: true });
  return bar;
}

// ── Markdown, built as elements (never HTML strings) ────────────────────

function markdown(text) {
  const root = document.createDocumentFragment();
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) root.append(h('p', {}, inline(paragraph.join(' '))));
    paragraph = [];
  };
  const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code = [];
      for (i += 1; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i += 1) code.push(lines[i]);
      i += 1;
      root.append(h('div', { class: 'code-wrap' }, h('pre', { class: 'code' }, h('code', {}, code.join('\n'))), copyButton(code.join('\n'), 'Copy this')));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      root.append(h(`h${Math.min(heading[1].length + 2, 6)}`, {}, inline(heading[2])));
      i += 1;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      root.append(h('hr'));
      i += 1;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      flush();
      const rows = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i += 1) rows.push(lines[i]);
      const [head, , ...body] = rows;
      root.append(
        h(
          'div',
          { class: 'table-wrap' },
          h('table', {}, h('thead', {}, h('tr', {}, cells(head).map((c) => h('th', {}, inline(c))))), h('tbody', {}, body.map((r) => h('tr', {}, cells(r).map((c) => h('td', {}, inline(c))))))),
        ),
      );
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/;
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/;
    if (bullet.test(line) || numbered.test(line)) {
      flush();
      const ordered = !bullet.test(line);
      const list = h(ordered ? 'ol' : 'ul');
      const first = numbered.exec(line);
      if (ordered && first && first[1] !== '1') list.setAttribute('start', first[1]);
      for (; i < lines.length; i += 1) {
        const item = ordered ? numbered.exec(lines[i]) : bullet.exec(lines[i]);
        if (!item) break;
        list.append(h('li', {}, inline(ordered ? item[2] : item[1])));
      }
      root.append(list);
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const quote = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i += 1) quote.push(lines[i].replace(/^\s*>\s?/, ''));
      root.append(h('blockquote', {}, inline(quote.join(' '))));
      continue;
    }
    if (!line.trim()) flush();
    else paragraph.push(line.trim());
    i += 1;
  }
  flush();
  return root;
}

/**
 * Something that reads as a file's path: a slash, no spaces, no scheme. Agents name the files they
 * made this way, and on a phone the useful thing to do with one is copy it.
 */
const isPath = (s) => s.length > 2 && s.includes('/') && /^[\w.@+~/-]+$/.test(s) && !s.startsWith('//');

/** A path as someone would paste it in a terminal: relative ones from the thread's folder, when they can see it. */
function fullPath(path) {
  const cwd = current?.meta?.cwd;
  if (path.startsWith('/') || path.startsWith('~') || !cwd) return path;
  return `${cwd.replace(/\/$/, '')}/${path.replace(/^\.\//, '')}`;
}

/** A small copy icon, beside a path or on a block of code. */
function copyButton(text, label = `Copy ${text}`) {
  return h('button', { type: 'button', class: 'copy-btn', title: label, 'aria-label': label, onclick: async (e) => {
    e.preventDefault();
    e.stopPropagation(); // not a tap on the message
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied.');
    } catch {
      toast('Couldn’t copy: select it and copy it yourself.', 'error');
    }
  } }, icon('copy', 'ico'));
}

/** Bold, italics, code, and links inside a line. Links only to http(s); a link to a file is its words and a copy icon. */
function inline(text) {
  const out = [];
  const pattern = /(`+)([^`]+?)\1|\*\*(.+?)\*\*|__(.+?)__|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])|(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])|\[([^\]]+)\]\(([^\s)]+)\)/g;
  let last = 0;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    if (m.index > last) out.push(...withMentions(text.slice(last, m.index)));
    if (m[2] !== undefined) out.push(isPath(m[2]) ? h('span', { class: 'file-ref' }, h('code', {}, m[2]), copyButton(fullPath(m[2]))) : h('code', {}, m[2]));
    else if (m[3] !== undefined || m[4] !== undefined) out.push(h('strong', {}, inline(m[3] ?? m[4])));
    else if (m[5] !== undefined) out.push(h('a', { href: m[6], target: '_blank', rel: 'noopener noreferrer' }, m[5]));
    else if (m[9] !== undefined) out.push(...(isPath(m[10]) ? [h('span', { class: 'file-ref' }, ...inline(m[9]), copyButton(fullPath(m[10])))] : withMentions(m[0])));
    else out.push(h('em', {}, inline(m[7] ?? m[8])));
    last = pattern.lastIndex;
  }
  if (last < text.length) out.push(...withMentions(text.slice(last)));
  return out;
}

let ticker;
function setRunning(running) {
  if (current) {
    // At the end when it starts: follow what comes in, until you scroll away.
    if (running && !current.running) current.following = atBottom();
    // An agent handing on to another within moments is the same work: its clock keeps going, as polyphemus's does.
    if (running && !current.running && !(current.liveStartedAt && current.stoppedAt && Date.now() - current.stoppedAt < 5000)) current.liveStartedAt = Date.now();
    // Done: if you were following it, land on the end of what it said.
    if (!running && current.running && current.following) setTimeout(() => scrollDown(true), 0);
    if (!running && current.running) current.stoppedAt = Date.now();
    current.running = running;
  }
  const stop = $('#stop');
  const send = $('#send');
  $('#head-mark')?.classList.toggle('on', running);
  if (stop) stop.hidden = !running;
  // Working: Send is there once there's something to send, and holds it for when they're done.
  if (send) send.hidden = running && !$('#input')?.value.trim();
  composerHint();
  tick();
}

/** The working times, ticking while anyone here is at work — the thread's own turn or an agent alongside. */
function tick() {
  clearInterval(ticker);
  if (!current?.running && !(current?.working ?? []).some((w) => w.alongside)) return;
  ticker = setInterval(() => {
    const el = $('#live-time');
    if (el && current?.liveStartedAt) el.textContent = duration(Date.now() - current.liveStartedAt);
    for (const since of document.querySelectorAll('.alongside .since')) since.textContent = duration(Date.now() - Number(since.dataset.since));
  }, 1000);
}

/** Within a screenful-ish of the end: close enough that new lines should follow you down. */
const atBottom = () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 120;

/**
 * Follows the conversation down only while you're already at the end. Reading back through a long
 * reply used to be interrupted by every streamed line; now the thread waits, and says there's more
 * below (the jump button).
 */
function scrollDown(force = false) {
  // Following a reply you're waiting for: you were at the end when it started and haven't scrolled away,
  // so a long one that grows past the bottom still follows down (2026-09-19).
  if (!force && current?.following && view.name === 'session') force = true;
  if (!force && !atBottom()) return showJump(true);
  requestAnimationFrame(() => {
    window.scrollTo({ top: document.body.scrollHeight });
    showJump(false);
  });
}

/**
 * What's under the composer has to know how tall it is right now: the box floats over the
 * conversation and grows as you type, and a long message ended up behind it (so did the jump button).
 * The measured height goes on #app as --composer-h, which the padding and the button are laid out from.
 */
let composerWatch;
/** Between screens: no composer, so nothing is laid out around one until the next screen says so. */
function forgetComposer() {
  composerWatch?.disconnect();
  composerWatch = undefined;
  $('#app')?.style.removeProperty('--composer-h');
}

function followComposer() {
  const app = $('#app');
  const composer = $('.composer');
  composerWatch?.disconnect();
  composerWatch = undefined;
  if (!app) return;
  if (!composer) return app.style.removeProperty('--composer-h');
  const set = () => {
    const end = atBottom();
    app.style.setProperty('--composer-h', `${Math.ceil(composer.getBoundingClientRect().height)}px`);
    // Growing the box shouldn't push the newest message behind it when you were reading the end.
    if (end && view.name === 'session') scrollDown(true);
  };
  if (typeof ResizeObserver === 'function') {
    composerWatch = new ResizeObserver(set);
    composerWatch.observe(composer);
  }
  set();
}

/** The button back to the newest message, while you're reading further up. */
function showJump(on) {
  const button = $('#jump');
  if (button) button.classList.toggle('show', on);
}

/** Watches where you are in a thread: the jump button appears when you leave the end, and goes when you're back. */
function watchScroll() {
  if (watchScroll.on) return;
  watchScroll.on = true;
  const look = () => {
    if (view.name !== 'session') return;
    // Only worth offering where there's something above to have scrolled past.
    showJump(!atBottom() && document.body.scrollHeight > window.innerHeight + 200);
    // Scrolling up while a reply comes in says you're reading: it stops following until you're back at the end.
    if (current) current.following = atBottom();
  };
  window.addEventListener('scroll', look, { passive: true });
  window.addEventListener('resize', look, { passive: true });
}

function showQuestion(q) {
  const box = $('#questions');
  // Scoped to this box: a copy of the same question on Home isn't a reason to skip drawing it here.
  if (!box || box.querySelector(`[data-question="${CSS.escape(q.id)}"]`)) return;
  // A gate is drawn inside its run, where the step is; not a second time below the conversation.
  if (q.kind === 'gate' && $('#work')) return;
  // The same question as Home's, with who has it and who else can answer: one card, one truth.
  box.append(questionCard(state.questions.find((x) => x.id === q.id) ?? q, true));
  scrollDown();
}

// ── Live updates ─────────────────────────────────────────────────────────

let refreshTimer;
async function refresh() {
  state = await api('/api/state');
  // The daemon drops a subscription the push service refuses; show that honestly as off.
  if (push === 'on' && state.push && state.push.kinds === null) push = 'off';
  document.title = waitingTotal() ? `(${waitingTotal()}) polyphemus` : 'polyphemus';
  redraw();
}
/** Several events often arrive together; fetch the state once for all of them. */
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh().catch(() => {}), 250);
}

function onEvent(data) {
  if (data.type === 'question') {
    state.questions.push(data);
    if (current?.meta.id === data.sessionId) showQuestion(data);
    redraw();
    if (navigator.vibrate) navigator.vibrate(200);
    return;
  }
  if (data.type === 'question_claimed') {
    const q = state.questions.find((x) => x.id === data.id);
    if (q) {
      q.claimedBy = data.by;
      q.claimedAt = data.at;
      // Redraw every copy of the card: on Home and inside its thread.
      for (const card of document.querySelectorAll(`[data-question="${CSS.escape(data.id)}"]`)) card.replaceWith(questionCard(q, card.closest('#questions') !== null));
      if (data.by && data.by !== `person:${state.me?.id}` && data.tookOverFrom === `person:${state.me?.id}`) toast(`${actorName(data.by)} took this over from you.`);
    }
    return;
  }
  if (data.type === 'question_resolved') {
    state.questions = state.questions.filter((q) => q.id !== data.id);
    // Someone else answered it: say who, where it happened.
    if (current?.meta.id === data.sessionId && isTheirs(data.by)) {
      current.notes.push({ seq: current.messages.length, kind: 'info', text: `${actorName(data.by)} ${answerVerb(data.answer)}.` });
      renderLog();
    }
    for (const card of document.querySelectorAll(`[data-question="${CSS.escape(data.id)}"]`)) card.remove();
    redraw();
    return;
  }
  if (data.type === 'signin' && signingIn?.id === data.provider) {
    signingIn.log.textContent += `${data.line}\n`;
    signingIn.log.scrollTop = signingIn.log.scrollHeight;
    // The link a CLI prints is the whole of the next step, and in a box of text it was easy to miss
    // and couldn't be tapped: it's a button too, the first one it prints (2026-09-23).
    const url = /https?:\/\/[^\s'"<>]+/.exec(data.line)?.[0];
    if (url && !signingIn.link) {
      signingIn.link = h('a', { class: 'btn small primary', href: url, target: '_blank', rel: 'noopener' }, 'Open the sign-in page');
      signingIn.log.after(h('div', { class: 'buttons' }, signingIn.link));
    }
    return;
  }
  if (data.type === 'signin_done' && signingIn?.id === data.provider) {
    const done = signingIn;
    signingIn = null;
    toast(data.signedIn ? `Signed in${data.account ? ` as ${data.account}` : ''}.` : 'Not signed in.');
    if (done.after) done.after();
    else refresh().then(() => view.name === 'models' && render());
    return;
  }
  if (data.type === 'install' && installing?.id === data.provider) {
    installing.log.textContent += `${data.line}\n`;
    installing.log.scrollTop = installing.log.scrollHeight;
    return;
  }
  if (data.type === 'install_done' && installing?.id === data.provider) {
    const done = installing;
    installing = null;
    // A failed install keeps its output on screen: that's where the reason is.
    if (!data.installed) {
      done.button.disabled = false;
      done.button.textContent = `Install ${done.label}`;
      toast(`${done.label} didn’t install. Its output above says why.`);
      return;
    }
    toast(`${done.label} is installed. Sign in next.`);
    if (done.after) done.after();
    else refresh().then(() => view.name === 'models' && render());
    return;
  }
  if (data.type === 'connection_changed') {
    refreshSoon();
    // Only redraw a connection's page that isn't mid-edit: a half-typed credential is never thrown away.
    if (view.name === 'connection' && view.id === data.connection && !document.querySelector('.sheet-wrap') && ![...document.querySelectorAll('.key-form input')].some((i) => i.value)) connectionScreen(data.connection);
    return;
  }
  if (data.type === 'project_changed') {
    refreshSoon();
    return;
  }
  if (data.type === 'agent_changed') {
    refreshSoon();
    // You're most likely looking at it: creation went straight here without waiting for the
    // words. Only fill an empty persona, though — never redraw over something being written.
    if (data.deleted) return;
    if (view.name === 'agent' && view.agent === data.name) {
      if (!view.edit) agentReadingScreen(data.name);
      else if (!$('#agent-persona')?.value.trim()) agentScreen(data.name);
    }
    return;
  }
  if (data.type === 'work_changed') {
    refreshSoon();
    if (current?.meta.id === data.sessionId) {
      api(`/api/sessions/${data.sessionId}?light=1`)
        .then((detail) => {
          if (current?.meta.id !== data.sessionId) return;
          current.work = detail.work;
          $('#work')?.replaceWith(workPanel(current));
        })
        .catch(() => {});
    }
    return;
  }
  if (data.type === 'session_changed') {
    refreshSoon();
    if (current?.meta.id !== data.sessionId) return;
    if (data.deleted) {
      toast('This thread was deleted.');
      return location.replace('#/');
    }
    if (data.title && $('#thread-title')) $('#thread-title').textContent = current.meta.title = data.title;
    // Lead, guard, spin-outs: fetched fresh rather than pieced together from the event.
    api(`/api/sessions/${data.sessionId}?light=1`)
      .then((detail) => {
        if (current?.meta.id !== data.sessionId) return;
        const seen = current.attendance?.length ?? 0;
        const knownSpins = new Set((current.spinOuts ?? []).map((child) => child.id));
        Object.assign(current, { lead: detail.lead, guard: detail.guard, spinOuts: detail.spinOuts, members: detail.members, agentsAnswerAll: detail.agentsAnswerAll, people: detail.people, attendance: detail.attendance ?? [] });
        drawThreadState();
        // Someone came or went, or a thread spun out: said where the conversation is, without redrawing what's streaming.
        const fresh = current.attendance.slice(seen);
        current.notes ??= [];
        for (const a of fresh) attendanceNote(current, a, current.messages.length);
        for (const child of current.spinOuts ?? []) {
          if (!knownSpins.has(child.id)) current.notes.push({ seq: current.messages.length, kind: 'info', text: 'Spun out:', link: { label: child.title, href: `#/s/${child.id}` } });
        }
        if (fresh.length || (current.spinOuts ?? []).some((child) => !knownSpins.has(child.id))) renderLog();
      })
      .catch(() => {});
    if (data.archived !== undefined) current.meta.archivedAt = data.archived ? Date.now() : undefined;
    return;
  }
  if (data.type === 'queue') {
    if (current?.meta.id === data.sessionId) void refreshQueue(data.sessionId);
    return;
  }
  if (data.type === 'queue_failed') {
    if (current?.meta.id === data.sessionId && data.personId === state.me?.id) toast(`Your held message wasn’t sent: ${data.error}`, 'error');
    return;
  }
  if (data.type === 'reactions') {
    if (current?.meta.id === data.sessionId) {
      current.reactions = data.reactions;
      redrawReactions();
    }
    return;
  }
  if (data.type === 'computer') {
    // An agent at work on its computer, in the chat you're in: offer to show it, once per turn.
    if (data.active) {
      const agent = agentByRef(data.agent);
      if (agent && view.name === 'session' && current?.meta.id === data.sessionId && paneAgent !== agent.id && !offeredComputer.has(data.sessionId)) {
        offeredComputer.add(data.sessionId);
        toast(`${agent.title} is using its computer. Tap to watch.`, 'info', () => toggleComputerPane(agent));
      }
      return;
    }
    if (view.name === 'computer' && agentByRef(view.agent)?.id === data.agent) render();
    else if (data.error && view.name === 'agent') toast(`Its computer didn’t wake: ${data.error}`, 'error');
    return;
  }
  if (data.type === 'skills_changed') {
    if (view.name === 'skills' || view.name === 'agent') render();
    return;
  }
  if (data.type === 'turn_state') {
    if (current?.meta.id === data.sessionId) {
      if (data.running && !data.alongside) current.speaker = data.speaker ?? null;
      current.working = data.working ?? [];
      renderAlongside();
      // An agent answering alongside doesn't change whether the thread's own turn is running.
      if (!data.alongside) setRunning(data.running);
      renderLog();
    }
    refreshSoon();
    return;
  }
  if (!data.sessionId || current?.meta.id !== data.sessionId) return;
  const log = $('#log');
  const e = data.event;
  if (!log || !e) return;
  switch (e.type) {
    case 'text_delta': {
      $('#thinking')?.remove();
      // One bubble per agent: two answering at once don't land in the same one.
      const who = data.agent ?? '';
      if (!streaming.has(who)) log.append(streaming.set(who, h('div', { class: 'msg bot streaming' })).get(who));
      streaming.get(who).textContent += e.text;
      break;
    }
    case 'message':
      streaming.get(data.agent ?? '')?.remove();
      streaming.delete(data.agent ?? '');
      current.messages.push(e.message);
      current.times.push(Date.now());
      (current.actors ??= []).push(e.actor ?? null);
      renderLog();
      break;
    case 'notice':
    case 'info':
      current.notes.push({ seq: current.messages.length, kind: e.type, text: e.text });
      renderLog();
      break;
    case 'turn_done':
      current.turns.push({
        endSeq: current.messages.length,
        startedAt: current.liveStartedAt ?? Date.now(),
        endedAt: Date.now(),
        stopReason: e.stopReason,
        usage: e.usage,
        costUsd: e.costUsd,
        billing: e.billing,
      });
      renderLog();
      break;
    case 'model':
      current.model = e.model;
      if ($('#model')) $('#model').value = e.model.label;
      break;
    case 'artifact':
      (current.artifacts ??= []).push(e.artifact);
      renderLog();
      break;
  }
  scrollDown();
}

function connect() {
  const source = new EventSource('/api/events');
  const setLive = (on) => {
    live = on;
    for (const el of document.querySelectorAll('.live')) el.className = `live ${on ? 'on' : ''}`;
  };
  source.onopen = () => {
    setLive(true);
    // Catch up on anything missed while away.
    refresh()
      .then(() => (view.name === 'session' ? openSession(view.id) : undefined))
      .catch(() => {});
  };
  source.onerror = () => setLive(false);
  source.onmessage = (message) => onEvent(JSON.parse(message.data));
}

window.addEventListener('hashchange', show);
applyTheme();
// Following the device: when it changes, so does the app (and the browser chrome's colour).
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => theme() === 'system' && applyTheme());
view = parseRoute();
refresh()
  .then(scopeOnArrival)
  .catch(showError)
  .then(setupPush)
  .catch(() => (push = 'unsupported'))
  .then(show);
connect();
