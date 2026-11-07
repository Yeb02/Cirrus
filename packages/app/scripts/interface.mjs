// The interface's checks by real input: npm run interface -w packages/app
// Each scenario launches the app on a fresh artificial test base, with a profile of its own (never the user's base nor
// profile), and drives it by the mouse and keyboard events Chromium receives from the system (DevTools' Input domain):
// the browser's own default actions — the focus a press gives, a click after a press — happen as for the user, which
// the pointer replays of the captures (CIRRUS_POINTER) skip. Then it reads what the page shows and what the base kept.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const electron = createRequire(import.meta.url)('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The page of an app launched on `data`, by DevTools: evaluate, mouse, keys. */
async function launch(data, profile) {
  const env = { ...process.env, CIRRUS_DATA: data, CIRRUS_SIZE: '1600,1000' };
  delete env.ELECTRON_RUN_AS_NODE;
  // Port 0: Chromium picks a free one, and writes it in the profile (DevToolsActivePort).
  const child = spawn(electron, [appDir, `--user-data-dir=${profile}`, '--remote-debugging-port=0'], { env, stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
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
  ws.addEventListener('message', (m) => {
    const x = JSON.parse(m.data);
    if (x.id && pending.has(x.id)) { pending.get(x.id)(x); pending.delete(x.id); }
  });
  const send = (method, params = {}) => new Promise((r) => { const id = ++next; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const mouse = (type, x, y, button = 'none') =>
    send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: type === 'mouseMoved' ? 0 : 1, buttons: type === 'mousePressed' ? (button === 'right' ? 2 : 1) : 0 });
  const page = {
    evaluate,
    async click(x, y, button = 'left') {
      await mouse('mouseMoved', x, y);
      await mouse('mousePressed', x, y, button);
      await sleep(30);
      await mouse('mouseReleased', x, y, button);
      await sleep(300);
    },
    async move(x, y) { await mouse('mouseMoved', x, y); await sleep(200); },
    /** The centre of the first element matching `selector` whose text matches `text`. */
    async centre(selector, text) {
      const r = await evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${new RegExp(text)}.test(e.textContent)); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
      if (!r) throw new Error(`Pas d’élément ${selector} « ${text} ».`);
      return r;
    },
    async type(text) { await send('Input.insertText', { text }); await sleep(100); },
    async press(key, code = key, keyCode) {
      for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode });
      await sleep(600);
    },
  };
  // The graph drawn, then a moment for the first frames.
  for (let i = 0; i < 120 && !(await evaluate(`!!document.querySelector('.graph canvas')`)); i++) await sleep(250);
  await sleep(2000);
  return { page, close: async () => { ws.close(); child.kill(); await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r))); } };
}

/** A scenario: what it does in the page, then what it checks; a failure throws its reason, in French. */
const SCENARIOS = [
  {
    // « Nouveau nœud » (spec 12): the ghost put down, the title typed in place, Entrée: the node is in the base.
    name: 'nouveau nœud par le menu',
    async run(page, base) {
      await page.click(250, 850, 'right');
      const item = await page.centre('.context-menu button', 'Nouveau nœud');
      await page.click(item.x, item.y);
      await page.move(400, 800);
      if (!(await page.evaluate(`document.querySelector('.ghost')?.textContent === 'Nouveau nœud'`))) throw new Error('le fantôme ne suit pas le curseur');
      await page.click(400, 800);
      const focused = await page.evaluate(`document.activeElement?.className === 'title-editor'`);
      if (!focused) throw new Error('l’éditeur du titre n’a pas le focus après le dépôt (il s’est refermé)');
      await page.type('Nœud d’essai');
      await page.press('Enter', 'Enter', 13);
      const titles = base(`SELECT json_extract(json, '$.title') AS t FROM nodes WHERE json_extract(json, '$.title') = 'Nœud d’essai'`);
      if (titles.length !== 1) throw new Error('le nœud n’est pas dans la base');
    },
  },
];

let failed = 0;
for (const s of SCENARIOS) {
  const data = mkdtempSync(join(tmpdir(), 'cirrus-interface-'));
  const profile = mkdtempSync(join(tmpdir(), 'cirrus-interface-profil-'));
  let app = null;
  try {
    execFileSync(process.execPath, [join(appDir, '..', 'fixtures', 'scripts', 'make-fixture.ts'), data], { stdio: 'ignore' });
    app = await launch(data, profile);
    const base = (sql) => {
      const db = new DatabaseSync(join(data, 'cirrus.db'), { readOnly: true });
      try { return db.prepare(sql).all(); } finally { db.close(); }
    };
    await s.run(app.page, base);
    console.log(`ok   ${s.name}`);
  } catch (e) {
    failed++;
    console.error(`ÉCHEC ${s.name} : ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await app?.close();
    rmSync(data, { recursive: true, force: true, maxRetries: 5 });
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  }
}
console.log(`${SCENARIOS.length - failed} scénarios sur ${SCENARIOS.length} réussis`);
process.exit(failed > 0 ? 1 : 0);
