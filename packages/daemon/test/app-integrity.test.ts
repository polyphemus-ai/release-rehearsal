import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const app = readFileSync(join(fileURLToPath(new URL('../web/app.js', import.meta.url))), 'utf8');
const sw = readFileSync(join(fileURLToPath(new URL('../web/sw.js', import.meta.url))), 'utf8');

describe('the app', () => {
  it('never sets a style attribute, which its own CSP drops', () => {
    // The app is served under default-src 'self' with no unsafe-inline, so setAttribute('style', …)
    // is blocked silently and the rule just doesn't apply. h() sets style through the CSSOM
    // instead, which isn't inline. Nothing may reintroduce the attribute.
    expect(app).not.toMatch(/setAttribute\(\s*['"]style['"]/);
  });

  it('never prints "null" where something conditional wasn’t there', () => {
    // A screen is full of `condition ? node : null`. The DOM's own replaceChildren() appends that
    // null as the text "null" — which is how a stray "null" turned up under the Grant button. fill()
    // drops it, the way h() does, so nothing in the app calls replaceChildren directly.
    const calls = app.match(/\breplaceChildren\(/g) ?? [];
    expect(calls).toHaveLength(0);
    expect(app).toMatch(/function fill\(node, \.\.\.children\)/);
  });

  it('tells the open window instead of the operating system, whatever the notification is', () => {
    // A notification on top of the app you're looking at is noise: the app already shows it. The
    // service worker hands it to the focused window, which says it in the app; nothing is dropped.
    const push = /addEventListener\('push'[\s\S]*?\n\}\);/.exec(sw)?.[0] ?? '';
    expect(push).toMatch(/visibilityState === 'visible' && client\.focused/);
    expect(push).toMatch(/postMessage\(\{ type: 'polyphemus-push'/);
    // Nothing is shown twice: the notification goes up only when no window is focused.
    expect(push.indexOf('postMessage')).toBeLessThan(push.indexOf('showNotification'));
    expect(app).toMatch(/polyphemus-push/);
  });

  it('keeps what you’ve typed when a screen is drawn again', () => {
    // A redraw builds a new message box — a reconnection, an agent joining, a deploy — and what you
    // were typing went with the old one. Both composers restore it, and sending clears it.
    for (const composer of [/const input = holdsDraft\(h\('textarea', \{ id: 'input'[^)]*\}\), 'new'/, /const input = holdsDraft\(h\('textarea', \{ id: 'input'[^)]*\}\), s\.meta\.id/]) {
      expect(app).toMatch(composer);
    }
    expect(app).toMatch(/keepDraft\('new', ''\)/);
    expect(app).toMatch(/keepDraft\(s\.meta\.id, ''\)/);
    expect(app).toMatch(/wasTyping/);
  });

  it('only follows a thread down when you’re already at the end', () => {
    // Reading back through a long reply, every streamed line used to yank you to the bottom. Nothing
    // may scroll a thread unless it's at the end already, following a reply you waited for, or you asked
    // (the jump button, your own message).
    expect(app).toMatch(/if \(!force && !atBottom\(\)\) return showJump\(true\);/);
    const forced = [...app.matchAll(/scrollDown\((true)?\)/g)].map((m) => m[1] === 'true');
    expect(forced.filter(Boolean).length).toBeGreaterThanOrEqual(2); // opening a thread, and sending
    expect(forced.filter((f) => !f).length).toBeGreaterThanOrEqual(2); // events and questions: only if you're there
    expect(app).toMatch(/id: 'jump'/);
    // It appears as soon as you scroll away from the end, not only when something new arrives.
    expect(app).toMatch(/addEventListener\('scroll', look/);
    expect(app).toMatch(/showJump\(!atBottom\(\)/);
  });

  it('opens a project beside its own list, and leaves Home as it was', () => {
    // 2026-09-18: a project has its own list in the second panel, and its threads open beside it.
    // Opening one used to narrow Home to it, and Home stayed narrowed afterwards; it doesn't now.
    expect(app).toMatch(/project: \(\) => \(\(listProject = view\.slug\), 'projectThreads'\)/);
    expect(app).toMatch(/projectThreads: \(\) => homeScreen\(projectOf\(listProject\)\)/);
    const projectScreen = /function projectScreen\([\s\S]*?\n\}/.exec(app)?.[0] ?? '';
    expect(projectScreen).not.toMatch(/setScope\(/);
    const arrival = /function scopeOnArrival\(\) \{[\s\S]*?\n\}/.exec(app)?.[0] ?? '';
    expect(arrival).not.toMatch(/setScope\(/);
  });

  it('carries a list on to the next line, and ends it on an empty item', () => {
    // The composer is where people write lists, so a new line inside one continues it the way the
    // chat apps do. Run the app's own function here, against a stand-in for the textarea.
    const source = /const BULLET = [\s\S]*?\n\}\n/.exec(app)?.[0] ?? '';
    expect(source).toContain('function bulletContinue');
    const bulletContinue = new Function(`${source}; return bulletContinue;`)() as (input: unknown) => boolean;
    class Box {
      selectionStart: number;
      selectionEnd: number;
      constructor(public value: string) {
        this.selectionStart = this.selectionEnd = value.length;
      }
      setRangeText(text: string, start: number, end: number) {
        this.value = this.value.slice(0, start) + text + this.value.slice(end);
        this.selectionStart = this.selectionEnd = start + text.length;
      }
      dispatchEvent() {}
    }
    const typed = (value: string) => {
      const box = new Box(value);
      return bulletContinue(box) ? box.value : null;
    };
    expect(typed('- milk')).toBe('- milk\n- ');
    expect(typed('1. one')).toBe('1. one\n2. ');
    expect(typed('  * a')).toBe('  * a\n  * ');
    expect(typed('3) three')).toBe('3) three\n4) ');
    expect(typed('- [x] done')).toBe('- [x] done\n- [ ] ');
    // An item with nothing on it is the way out of the list.
    expect(typed('- ')).toBe('');
    expect(typed('1. one\n2. ')).toBe('1. one\n');
    // Ordinary text is left to the browser.
    expect(typed('just text')).toBe(null);
  });

  it('keeps the conversation clear of the composer, however tall it grows', () => {
    // The composer floats over the thread and grows as you type; a fixed gap under the messages meant
    // a long message ended up behind it. Its measured height is what everything above it is laid out from.
    expect(app).toMatch(/--composer-h/);
    expect(app).toMatch(/function followComposer\(\)/);
    const css = readFileSync(join(fileURLToPath(new URL('../web/style.css', import.meta.url))), 'utf8');
    for (const rule of [/\.main\.with-composer \{ padding-bottom: calc\(var\(--composer-h/, /\.jump[\s\S]{0,200}?bottom: calc\(var\(--composer-h/]) expect(css).toMatch(rule);
  });

  it('follows a reply you’re waiting for, and says nothing about the thread you’re reading', () => {
    // A long reply grew past the bottom and stopped being followed, and the app showed a notification
    // for the very thread on screen (2026-09-19).
    expect(app).toMatch(/if \(!force && current\?\.following && view\.name === 'session'\) force = true;/);
    expect(app).toMatch(/if \(running && !current\.running\) current\.following = atBottom\(\);/);
    expect(app).toMatch(/if \(current\) current\.following = atBottom\(\);/);
    const push = /if \(event\.data\?\.type !== 'polyphemus-push'\) return;[\s\S]*?const text =/.exec(app)?.[0] ?? '';
    expect(push).toMatch(/current\?\.meta\.id === about/);
  });

  it('keeps a work group folded or open the way you left it, however often the thread redraws', () => {
    // A failed group was drawn open on every redraw, so it sprang back open while agents worked (2026-09-19).
    expect(app).toMatch(/const activityOpen = new Map\(\)/);
    expect(app).toMatch(/open: remembered \?\? failed > 0/);
    expect(app).not.toMatch(/open: failed > 0 \}/);
  });

  it('offers both ways to read a thread’s flow, and remembers which you picked', () => {
    // The graph says who passed it to whom; the timeline says when (2026-09-19, from the owner).
    expect(app).toMatch(/function drawFlow\(/);
    expect(app).toMatch(/function drawTimeline\(/);
    expect(app).toMatch(/remember\('polyphemus\.flowAs', how\)/);
    expect(app).toMatch(/remembered\('polyphemus\.flowAs'\)/);
  });

  it('opens the thread at the message you tapped in its flow', () => {
    expect(app).toMatch(/go\(`#\/s\/\$\{id\}\?at=\$\{row\.seq\}`\)/);
    expect(app).toMatch(/function showMessage\(seq\)/);
    // Once, and then the address stops saying so: while it kept saying it, every later draw of the
    // thread obeyed it again and a message you sent pulled you back up (2026-09-20).
    expect(app).toMatch(/if \(view\.at !== '' && view\.at !== undefined\) \{[\s\S]{0,240}?view = \{ \.\.\.view, at: '' \};[\s\S]{0,240}?history\.replaceState\([\s\S]{0,160}?showMessage\(seq\);/);
    // Each lane takes its actor's own colour rather than a fixed palette.
    expect(app).toMatch(/const colourOf = \(ref\) => \{/);
  });

  it('draws every screen the router can reach', () => {
    // A screen in the table with no function behind it is a blank page at runtime: the app has no
    // build step, so nothing else catches it. (`describeModel` was deleted while modelRow still
    // called it, and the Models screen died with "describeModel is not defined".)
    const table = /const SCREENS = \{([\s\S]*?)\n\};/.exec(app)?.[1] ?? '';
    expect(table).not.toBe('');
    const named = [...table.matchAll(/^\s*\w+: (?:\(\) => )?(\w+)[,(]/gm)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(8);
    for (const fn of named) expect(app, `SCREENS names ${fn}`).toMatch(new RegExp(`(?:async )?function ${fn}\\b`));
  });
});
