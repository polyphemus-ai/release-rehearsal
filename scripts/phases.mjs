#!/usr/bin/env node
// One loop of an animation, held still at several moments, side by side in one picture. A
// screenshot of something moving shows one frame, which says nothing about where it went — the
// comet around a working agent's mark was fixed three times off single frames before this existed,
// and the grid showed in one look that it never crossed the mark and turned over a quarter-lap
// early (2026-09-21).
//
//   node scripts/phases.mjs                 # every subject, into a temp folder
//   node scripts/phases.mjs alive           # one
//   node scripts/phases.mjs alive --shots <dir> --steps 12 --size 120
//
// Each subject names the real markup and the real stylesheet: what's drawn here is what the app
// draws. To add one, put it in SUBJECTS below.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = fileURLToPath(new URL('../packages/daemon/web/', import.meta.url));

/**
 * What can be held still. `markup` is the app's own, `seconds` is the loop being judged, and
 * `holds` names the elements whose animations are paused at each moment — a pseudo-element's
 * animation is delayed through its own rule, so they're listed as selectors, not nodes.
 */
const SUBJECTS = {
  alive: {
    about: 'An agent’s mark while it works: the comet’s orbit, and whether it passes in front or behind.',
    seconds: 2.6,
    holds: ['.swoosh', '.swoosh::after', '.alive-body', '.visor'],
    markup: (size) => `
      <span class="alive on">
        <span class="swoosh" aria-hidden="true"></span>
        <span class="alive-body">
          <svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">
            <polygon points="12,2 21,7 21,17 12,22 3,17 3,7" fill="#e8873a"></polygon>
            <rect class="visor" x="8" y="10.6" width="8" height="2.8" rx="1.4" fill="#fff"></rect>
          </svg>
        </span>
      </span>`,
  },
};

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const wanted = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true);
const steps = Number(flag('steps', 8));
const size = Number(flag('size', 96));
const shots = flag('shots', undefined) ?? mkdtempSync(join(tmpdir(), 'polyphemus-phases-'));

const names = wanted ? [wanted] : Object.keys(SUBJECTS);
for (const name of names) {
  if (!SUBJECTS[name]) {
    console.error(`No subject called ${name}. There is: ${Object.keys(SUBJECTS).join(', ')}`);
    process.exit(2);
  }
}

const CHROME = ['google-chrome', 'chromium', 'chromium-browser'];
const BROWSER = CHROME.find((name) => spawnSync('which', [name], { stdio: 'ignore' }).status === 0);
if (!BROWSER) {
  console.error(`Needs Chrome: ${CHROME.join(', ')}.`);
  process.exit(2);
}

/** The page: one cell per moment, each holding the same animation at a different point in its loop. */
const page = (subject, scheme) => {
  const at = (i) => (i / steps) * subject.seconds;
  const cells = Array.from({ length: steps }, (_, i) => `<div class="cell">${subject.markup(size)}<small>${Math.round((i / steps) * 100)}%</small></div>`).join('');
  // Paused with a negative delay, so each cell sits at its own moment of the loop.
  const held = Array.from({ length: steps }, (_, i) =>
    subject.holds.map((sel) => `.cell:nth-child(${i + 1}) ${sel} { animation-delay: -${at(i).toFixed(3)}s; animation-play-state: paused; }`).join('\n'),
  ).join('\n');
  return `<!doctype html><meta charset="utf-8"><title>phases</title>
<link rel="stylesheet" href="style.css">
<style>
  :root { color-scheme: ${scheme}; }
  body { margin: 0; padding: 26px; background: var(--bg, ${scheme === 'dark' ? '#0b0e14' : '#fff'}); display: grid; grid-template-columns: repeat(${Math.min(steps, 8)}, 1fr); gap: 26px 14px; }
  .cell { display: grid; place-items: center; gap: 8px; }
  .cell small { color: var(--muted, #7b8496); font: 12px system-ui, sans-serif; }
${held}
</style>
${cells}`;
};

mkdirSync(shots, { recursive: true });
for (const name of names) {
  const subject = SUBJECTS[name];
  for (const scheme of ['light', 'dark']) {
    // Beside the stylesheet, so it loads the real one without a server.
    const file = join(WEB, `.phases-${name}-${scheme}.html`);
    writeFileSync(file, page(subject, scheme));
    const out = join(shots, `${name}-${scheme}.png`);
    const width = Math.min(steps, 8) * (size + 60) + 60;
    const rows = Math.ceil(steps / 8);
    await new Promise((done) => {
      const child = spawn(
        BROWSER,
        ['--headless', '--disable-gpu', '--no-sandbox', `--force-prefers-color-scheme=${scheme}`, '--virtual-time-budget=3000', `--window-size=${width},${rows * (size + 90) + 60}`, `--screenshot=${out}`, file],
        { stdio: 'ignore' },
      );
      child.on('exit', done);
      child.on('error', done);
    });
    spawnSync('rm', ['-f', file]);
    console.log(`✓ ${name} (${scheme}): ${out}`);
  }
  console.log(`  ${subject.about}`);
}
console.log(`\n${steps} moments of one loop, left to right. Look at them.`);
