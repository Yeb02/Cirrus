// The app's window driven by DevTools (CDP), out of the user's way: shared by the interface's checks (interface.mjs), the
// measures of plans 4c and 5a (mesures-annotations.mjs, mesures-synchro.mjs) and the captures of a paired PC
// (captures.mjs). Each launch takes a base and a profile of its own, never the user's.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const electron = createRequire(import.meta.url)('electron');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** For the measures: the value under which a share `q` of the sorted values falls. */
export const quantile = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s.length === 0 ? Number.NaN : s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

/**
 * The page of an app launched on `data`, by DevTools: evaluate, mouse, keys. `more`: launch options (CIRRUS_VIEW…).
 * `exe`: a packaged app's executable (dist/win-unpacked, paquet-essai.mjs) instead of Electron on this folder's build.
 * `log`: a file descriptor that receives the main process's output (maj-essai.mjs: electron-updater's journal).
 */
export async function launch(data, profile, more = {}, { exe, log } = {}) {
  // CIRRUS_BACKGROUND: the window beyond the screens, without the focus (src/main/window.ts); the page is told it has it.
  const env = { ...process.env, CIRRUS_DATA: data, CIRRUS_SIZE: '1600,1000', CIRRUS_BACKGROUND: '1', ...more };
  delete env.ELECTRON_RUN_AS_NODE;
  // Port 0: Chromium picks a free one, and writes it in the profile (DevToolsActivePort) — the file an earlier launch on
  // the same profile left removed first, so that its port is never read.
  const portFile = join(profile, 'DevToolsActivePort');
  rmSync(portFile, { force: true });
  const args = [`--user-data-dir=${profile}`, '--remote-debugging-port=0'];
  const child = spawn(exe ?? electron, exe ? args : [appDir, ...args], { env, stdio: log === undefined ? 'ignore' : ['ignore', log, log] });
  let target;
  for (let i = 0; i < 120 && !target; i++) {
    await sleep(250);
    if (!existsSync(portFile)) continue;
    const port = readFileSync(portFile, 'utf8').split('\n')[0].trim();
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
    } catch {}
  }
  if (!target) throw new Error('La fenêtre de Cirrus n’est pas apparue.');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let next = 0;
  const pending = new Map();
  /** The app gone (it quits by itself: plan 5a, a base taken from the server): what waits for an answer gets none. */
  let gone = false;
  const exited = new Promise((r) => (child.exitCode !== null ? r(child.exitCode) : child.once('exit', r)));
  ws.addEventListener('close', () => {
    gone = true;
    for (const answer of pending.values()) answer({ error: { message: 'DevTools fermé' } });
    pending.clear();
  });
  /** DevTools' events by method: each waiter takes the next one. */
  const waiting = new Map();
  ws.addEventListener('message', (m) => {
    const x = JSON.parse(m.data);
    if (x.id && pending.has(x.id)) { pending.get(x.id)(x); pending.delete(x.id); }
    else if (x.method && waiting.has(x.method)) { const take = waiting.get(x.method); waiting.delete(x.method); take(x.params); }
  });
  /** The next event `method`, or null after `ms`. */
  const nextEvent = (method, ms) => new Promise((r) => {
    const timer = setTimeout(() => { waiting.delete(method); r(null); }, ms);
    waiting.set(method, (params) => { clearTimeout(timer); r(params); });
  });
  const send = (method, params = {}) => new Promise((r) => {
    if (gone) return r({ error: { message: 'DevTools fermé' } });
    const id = ++next;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  // The focus as if the window had it: its focus events, document.hasFocus() (the drawing pauses without it).
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const mouse = (type, x, y, button = 'none') =>
    send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: type === 'mouseMoved' ? 0 : 1, buttons: type === 'mousePressed' ? (button === 'right' ? 2 : 1) : 0 });
  const page = {
    evaluate,
    /** A DevTools command, as is (the measures' wheel). */
    send,
    /** Whether `expr` becomes true within `ms`: a first launch after a build is slower than the next ones. */
    async until(expr, ms = 5000) {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await evaluate(expr)) return true;
      return false;
    },
    async click(x, y, button = 'left') {
      await mouse('mouseMoved', x, y);
      await mouse('mousePressed', x, y, button);
      await sleep(30);
      await mouse('mouseReleased', x, y, button);
      await sleep(300);
    },
    async move(x, y) { await mouse('mouseMoved', x, y); await sleep(200); },
    /** A left click with Ctrl held: an element selected without its pop-up (spec 9.1). */
    async ctrlClick(x, y) {
      await mouse('mouseMoved', x, y);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, modifiers: 2 });
      await sleep(30);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, modifiers: 2 });
      await sleep(300);
    },
    /** The centre of the first element matching `selector` whose text matches `text`. */
    async centre(selector, text) {
      const r = await evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${new RegExp(text)}.test(e.textContent)); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
      if (!r) throw new Error(`Pas d’élément ${selector} « ${text} ».`);
      return r;
    },
    async type(text) { await send('Input.insertText', { text }); await sleep(100); },
    /** The window's content as a PNG (the captures of plan 5a, whose states need a server: captures.mjs). */
    async screenshot() {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      if (!r.result?.data) throw new Error(`Pas de capture : ${r.error?.message ?? 'réponse vide'}`);
      return Buffer.from(r.result.data, 'base64');
    },
    /** A key; `modifiers` as DevTools counts them: Alt 1, Ctrl 2, Meta 4, Maj 8. */
    async press(key, code = key, keyCode, modifiers = 0) {
      for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, modifiers });
      await sleep(600);
    },
    /** The left button pressed at `from`, moved in `steps` to `to`, and let go there: a selection made by the mouse. */
    async drag(from, to, steps = 12) {
      await mouse('mouseMoved', from.x, from.y);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= steps; i++) {
        const x = from.x + ((to.x - from.x) * i) / steps, y = from.y + ((to.y - from.y) * i) / steps;
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
        await sleep(20);
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(400);
    },
    /**
     * A drag and drop (HTML5) by the mouse, from `from` to `to`: the left button pressed on the element at `from`, moved
     * until Chromium starts its drag — the element's own dragstart fills it —, then that drag, intercepted by DevTools
     * (Input.setInterceptDrags) instead of the system's, entered, moved over and let go at `to` (Input.dispatchDragEvent),
     * the page's dragenter, dragover and drop handlers receiving it as from the system. Resolves with what the drag
     * carried (its items), or throws if Chromium started none.
     */
    async dragDrop(from, to) {
      await send('Input.setInterceptDrags', { enabled: true });
      try {
        const intercepted = nextEvent('Input.dragIntercepted', 4000);
        await mouse('mouseMoved', from.x, from.y);
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
        for (let i = 1; i <= 10; i++) {
          const x = from.x + ((to.x - from.x) * i) / 10, y = from.y + ((to.y - from.y) * i) / 10;
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
          await sleep(30);
        }
        const drag = await intercepted;
        if (!drag) throw new Error('Chromium n’a commencé aucun glisser-déposer depuis cet élément');
        for (const [type, at] of [['dragEnter', to], ['dragOver', { x: to.x - 2, y: to.y }], ['dragOver', to]]) {
          await send('Input.dispatchDragEvent', { type, x: at.x, y: at.y, data: drag.data });
          await sleep(60);
        }
        await send('Input.dispatchDragEvent', { type: 'drop', x: to.x, y: to.y, data: drag.data });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
        await sleep(400);
        return drag.data.items;
      } finally {
        await send('Input.setInterceptDrags', { enabled: false });
      }
    },
    /**
     * Files of the disk dragged from the system and let go at `at` (plan 4c, task 5): entered, moved over and dropped
     * by DevTools' Input domain, the page's dragover and drop handlers receiving them as from the explorer.
     */
    async dropFiles(at, paths) {
      const data = { items: [], files: paths, dragOperationsMask: 1 };
      for (const type of ['dragEnter', 'dragOver', 'dragOver', 'drop']) {
        await send('Input.dispatchDragEvent', { type, x: at.x, y: at.y, data });
        await sleep(60);
      }
      await sleep(300);
    },
    /**
     * The client rectangle of the `k`-th character of `needle`, found in the text of the first element `scope` (its
     * text nodes joined: pdf.js may split a line into runs), or null.
     */
    async charRect(scope, needle, k) {
      return evaluate(`(() => {
        const root = document.querySelector(${JSON.stringify(scope)});
        if (!root) return null;
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), parts = [];
        let all = '';
        for (let n = w.nextNode(); n; n = w.nextNode()) { parts.push([n, all.length]); all += n.data; }
        const i = all.indexOf(${JSON.stringify(needle)});
        if (i < 0) return null;
        const at = i + ${k}, [node, start] = parts.findLast(([, s]) => s <= at);
        const r = document.createRange();
        r.setStart(node, at - start);
        r.setEnd(node, at - start + 1);
        const b = r.getBoundingClientRect();
        return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
      })()`);
    },
  };
  // The graph drawn, then a moment for the first frames.
  for (let i = 0; i < 120 && !(await evaluate(`!!document.querySelector('.graph canvas')`)); i++) await sleep(250);
  await sleep(2000);
  return {
    page,
    /** Resolves with the app's exit code once it has quit: by itself, or closed. */
    exited,
    /**
     * Quits by `window.close()` from the page, which destroys the window at once: the app exits by itself, but the window's
     * « close » handler (src/main/window.ts) does not run — no last snapshot from the interface, no last consultations. To
     * close as the user's click on the window's button does, with the app's own closing, send `Browser.close` (interface.mjs:
     * closeAsUser). Killed if it is still there after `ms`. Whether it quit by itself.
     */
    async quit(ms = 20_000) {
      void evaluate('window.close()');
      const code = await Promise.race([exited, sleep(ms).then(() => null)]);
      ws.close();
      if (code !== null) return true;
      child.kill();
      await exited;
      return false;
    },
    close: async () => { ws.close(); child.kill(); await exited; },
    /** The app's process id: its children are looked for by it (maj-essai.mjs). */
    pid: child.pid,
  };
}
