// A server of this machine for the scripts (plan 5a): @cirrus/server started in the script's process on 127.0.0.1 and a
// free port, its data in a temporary folder (never %LOCALAPPDATA%\Cirrus, never the user's base); a pairing code made
// as `jumeler` makes it. With it, the virtual PC of the tests (tests/support/virtualPc.ts), and what drives an app's page
// (cdp.mjs) against such a server: the pairing by the block « Serveur », the chip, a title seen. Shared by the
// interface's checks (interface.mjs), the captures of a paired state (captures.mjs) and the measures (mesures-synchro.mjs).
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, Tokens } from '@cirrus/server';

/** A pairing code for `name`, as `jumeler` makes it, from the server's data in `dir` (it may run in another process). */
export function pairingCode(dir, name) {
  const tokens = Tokens.open(dir);
  try { return tokens.createCode(name, Date.now()).code; } finally { tokens.close(); }
}

export async function localServer() {
  const dir = mkdtempSync(join(tmpdir(), 'cirrus-serveur-local-'));
  let server = await startServer({ dataDir: dir, port: 0 });
  const url = server.url, port = Number(new URL(url).port);
  return {
    url,
    code: (name) => pairingCode(dir, name),
    /** The server's journal, its operations in order (read from its base, running or stopped). */
    journal() {
      const db = new DatabaseSync(join(dir, 'base', 'cirrus.db'), { readOnly: true });
      try { return db.prepare('SELECT op FROM changes ORDER BY local_seq').all().map((r) => JSON.parse(r.op)); } finally { db.close(); }
    },
    hasBlob: (hash) => existsSync(join(dir, 'base', 'files', hash.slice(0, 2), hash)),
    /** Another PC paired with it (« Observateur »): its shared settings read and changed (task 6). */
    async observer() {
      const body = JSON.stringify({ code: pairingCode(dir, 'Observateur'), pc: 'observateur', name: 'Observateur' });
      const { token } = await (await fetch(`${url}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).json();
      const call = async (method, body) => (await fetch(`${url}/settings`, {
        method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body && JSON.stringify(body),
      })).json();
      return { settings: () => call('GET'), put: (changes) => call('POST', { changes }) };
    },
    /** Stopped, its event streams closed (every PC goes offline); its data kept. */
    async stop() {
      await server?.close();
      server = null;
    },
    /** Started again on its data and its port: the PCs keep its address. */
    async restart() {
      if (!server) server = await startServer({ dataDir: dir, port });
    },
    async close() {
      await server?.close();
      server = null;
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

/**
 * A PC without Electron (tests/support/virtualPc.ts: its base, its state reconciled as the interface does, its sync
 * client on Node's fetch), paired with `server` ({ url, code(name) }) under the identifier `id`, its client started.
 * Its token stays in its temporary folder, as in the tests.
 */
export async function virtualPc(server, id) {
  const { PLAIN, VirtualPc } = await import('../tests/support/virtualPc.ts');
  const { fileSecrets, pair } = await import('../src/main/sync/config.ts');
  const dir = mkdtempSync(join(tmpdir(), 'cirrus-pc-virtuel-'));
  const name = id.toUpperCase();
  fileSecrets(dir, PLAIN).write(await pair(fetch, server.url, server.code(name), id, name));
  const pc = new VirtualPc({ id, dir, now: Date.now });
  pc.client.start();
  return {
    pc,
    async close() {
      await pc.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

// ——— The page of an app (cdp.mjs) against such a server ———

/** The centre of the `i`-th field of the block « Serveur ». */
export const serverField = (page, i) => page.evaluate(`(() => { const b = document.querySelectorAll('.server-block input')[${i}]?.getBoundingClientRect(); return b && { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);

/** The block « Serveur » of the settings: the panel opened by the gear, the rubric unfolded. */
export async function openServerBlock(page) {
  if (!(await page.evaluate(`!!document.querySelector('.settings')`))) {
    const gear = await page.centre('.tabs .gear', '⚙');
    await page.click(gear.x, gear.y);
  }
  if (!(await page.evaluate(`!!document.querySelector('.server-block')`))) {
    const rubric = await page.centre('.settings .rubric-title', 'Serveur');
    await page.click(rubric.x, rubric.y);
  }
  if (!(await page.until(`!!document.querySelector('.server-block')`))) throw new Error('le bloc « Serveur » ne s’ouvre pas');
}

/**
 * A pairing by the block, as the user makes it: the server's address typed over the one proposed, the code `jumeler`
 * showed, this PC's name typed over the machine's if `name` is given, « Jumeler ».
 */
export async function pairThrough(page, url, code, name) {
  await openServerBlock(page);
  if (!(await page.until(`document.querySelectorAll('.server-block input').length === 3`))) throw new Error('le bloc « Serveur » ne montre pas ses trois champs');
  const typeOver = async (i, text) => {
    const field = await serverField(page, i);
    await page.click(field.x, field.y);
    await page.press('a', 'KeyA', 65, 2);
    await page.type(text);
  };
  await typeOver(0, url);
  await typeOver(1, code);
  if (name !== undefined) await typeOver(2, name);
  const pair = await page.centre('.server-block button', '^Jumeler$');
  await page.click(pair.x, pair.y);
}

/** Whether the chip of the tabs' bar says `text` within `ms`. */
export const chipSays = (page, text, ms = 10_000) => page.until(`document.querySelector('.tabs .sync-chip')?.textContent === ${JSON.stringify(text)}`, ms);

/**
 * Watches the title of the node's pop-up: `window.__shown` resolves with the page's absolute time (its clock's origin
 * plus now, as `performance.timeOrigin + performance.now()` in Node) at which it first shows `title`, or null after 10 s.
 */
export const TITLE_PROBE = (title) => `(() => {
  const want = ${JSON.stringify(title)}, now = () => performance.timeOrigin + performance.now();
  const shown = () => document.querySelector('.node-popup input.title')?.value === want;
  window.__shown = new Promise((resolve) => {
    if (shown()) return resolve(now());
    const o = new MutationObserver(() => { if (shown()) { o.disconnect(); resolve(now()); } });
    o.observe(document.body, { subtree: true, childList: true });
    setTimeout(() => { o.disconnect(); resolve(null); }, 10_000);
  });
  return true;
})()`;
