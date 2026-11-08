import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Action, createNode, createPlan, editNode, encodeState, type FileRef, type Id, type State } from '@cirrus/core';
import { Tokens } from '@cirrus/server';
import { filePath, storeBytes } from '@cirrus/store';
import { afterEach, expect, test, vi } from 'vitest';
import { pcId } from '../src/main/base.ts';
import { SERVER_FILE } from '../src/main/sync/config.ts';
import { DOWNLOADS_FILE } from '../src/main/sync/downloads.ts';
import { READY_FILE, stagedDir, swapStaged } from '../src/main/sync/firstSync.ts';
import { AppPc } from './support/appPc.ts';
import { image, Lab, until } from './support/virtualPc.ts';

// The first pairing (plan 5a, task 5, D7): a PC whose base is not empty sends it to an empty server (seed); an empty
// PC, or one that agrees to replace its base, takes the server's (adopt), staged beside its own and swapped in at the
// next start; two full bases are refused, the replacement proposed; an interruption leaves the old base as it was.

let lab: Lab | null = null;
const apps: AppPc[] = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const a of apps.splice(0)) await a.close();
  await lab?.close();
  lab = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function app(l: Lab, name: string): Promise<AppPc> {
  const a = new AppPc(l, name);
  apps.push(a);
  return a.open();
}

/** The app quits (a relaunch), then starts again on the same folder: the staged base swapped in first, as index.ts does. */
async function restart(l: Lab, a: AppPc): Promise<AppPc> {
  apps.splice(apps.indexOf(a), 1);
  await a.close();
  expect(swapStaged(a.dir, new Date(l.clock))).toBe('swapped');
  return app(l, a.name);
}

const bytes = (text: string) => new TextEncoder().encode(text);

/** An action of the interface, which must pass. */
async function run(a: AppPc, build: (s: State) => Action): Promise<Action> {
  const r = await a.session.run(build);
  if (!r.ok) throw new Error(r.message);
  return r.action;
}
const createdId = (a: Action, t: 'node' | 'plan'): Id => (a.ops.find((o) => o.t === t && o.before === null) as { after: { id: Id } }).after.id;

/**
 * A full base: a plan, X and G in it; X renamed, then given a .txt and a PDF, then a new version of the .txt (the old
 * one only in its history). Returns X and the three files.
 */
async function fill(a: AppPc): Promise<{ X: Id; notes: FileRef; old: FileRef; pdf: FileRef }> {
  const P = createdId(await run(a, (s) => createPlan(s, 'Thèse', 'plan')), 'plan');
  const X = createdId(await run(a, (s) => createNode(s, { plan: P, title: 'X', x: 0, y: 0, k: 0 })), 'node');
  await run(a, (s) => createNode(s, { plan: P, title: 'G', x: 300, y: 0, k: 0 }));
  // The interface's snapshot at rest (SnapshotSaver): what follows is the journal's tail, which the server replays on it.
  a.store.writeSnapshot(encodeState(a.session.state), a.store.lastSeq());
  await run(a, (s) => editNode(s, X, { title: 'X2' }));
  const old = storeBytes(a.dir, 'notes.txt', bytes('première version'));
  const pdf = storeBytes(a.dir, 'Article.pdf', bytes('%PDF-1.4\n% un article\n%%EOF\n'));
  await run(a, (s) => editNode(s, X, { files: [old, pdf] }));
  const notes = storeBytes(a.dir, 'notes.txt', bytes('seconde version'));
  await run(a, (s) => editNode(s, X, { files: [notes, pdf] }));
  return { X, notes, old, pdf };
}

/** A seeds the lab's empty server with its full base: its offer, then « Envoyer ». */
async function seeded(l: Lab, a: AppPc): Promise<void> {
  const r = await a.sync.pair(l.url, l.code('Portable'), 'Portable');
  expect(r).toMatchObject({ ok: false, offer: { kind: 'seed' } });
  expect(await a.sync.first('seed')).toEqual({ ok: true });
  await until(() => a.status?.state === 'live' && a.status.pending === 0, 5000, () => JSON.stringify(a.statuses));
}

const serverBlob = (l: Lab, f: FileRef) => existsSync(filePath(join(l.dataDir, 'base'), f));
const pairedPcs = (l: Lab) => {
  const tokens = Tokens.open(l.dataDir);
  try { return tokens.pcs().map((p) => p.id); } finally { tokens.close(); }
};

test('envoyer sa base puis la prendre sur un autre PC : les états égaux, l’historique d’un nœud complet, les fichiers là, les PDF à part', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  const { X, notes, old, pdf } = await fill(a);
  const lines = a.store.lastSeq();
  // A full PC, an empty server: the offer to send, its counts; nothing kept nor started while the user decides.
  const r = await a.sync.pair(l.url, l.code('Portable'), 'Portable');
  expect(r).toEqual({ ok: false, message: expect.any(String), offer: { kind: 'seed', nodes: 2, files: 3 } });
  expect([a.host.paired(), existsSync(join(a.dir, SERVER_FILE)), a.net.count('GET', '/events')]).toEqual([false, false, 0]);
  expect(await a.sync.first('seed')).toEqual({ ok: true });
  // Its lines numbered by the seed, before the sync started: nothing pending, nothing sent write by write.
  expect([a.store.lastServerSeq(), a.store.pendingCount()]).toEqual([lines, 0]);
  await until(() => a.status?.state === 'live' && a.status.pending === 0, 5000, () => JSON.stringify(a.statuses));
  expect(a.net.count('POST', '/units')).toBe(0);
  expect(image(await l.state())).toBe(image(a.session.state));
  expect((await l.journal()).map((x) => [x.localSeq, x.unit])).toEqual(a.store.changesSince(0).map((x) => [x.localSeq, x.unit]));
  // Every file of its store, the version only the history names included.
  expect([notes, old, pdf].map((f) => serverBlob(l, f))).toEqual([true, true, true]);

  // B, a new PC: the offer to take the server's base; staged beside its own, which stays until the restart.
  const b = await app(l, 'pc-b');
  const ownId = pcId(b.dir);
  const rb = await b.sync.pair(l.url, l.code('Fixe'), 'Fixe');
  expect(rb).toEqual({ ok: false, message: expect.any(String), offer: { kind: 'adopt', nodes: 2, archive: 'pc-b-avant-jumelage-2026-11-08' } });
  expect(await b.sync.first('adopt')).toEqual({ ok: true, restarting: true });
  expect(b.relaunched).toBe(1);
  expect(existsSync(join(stagedDir(b.dir), READY_FILE))).toBe(true);
  expect([b.host.paired(), existsSync(join(b.dir, SERVER_FILE))]).toEqual([false, false]);
  const b2 = await restart(l, b);
  // The same PC (its identifier, the token's), paired, its old base kept aside.
  expect(pcId(b2.dir)).toBe(ownId);
  expect(b2.host.paired()).toBe(true);
  const archive = join(dirname(b.dir), 'pc-b-avant-jumelage-2026-11-08');
  expect([existsSync(join(archive, 'cirrus.db')), existsSync(join(archive, SERVER_FILE)), existsSync(join(archive, DOWNLOADS_FILE))]).toEqual([true, false, false]);
  await until(() => b2.status?.state === 'live', 5000, () => JSON.stringify(b2.statuses));
  expect(image(b2.session.state)).toBe(image(await l.state()));
  expect([b2.store.lastServerSeq(), b2.store.pendingCount()]).toEqual([lines, 0]);
  // X's history, whole, as A wrote it: another PC's lines here.
  const history = a.store.historyOf(X);
  expect(history.length).toBeGreaterThanOrEqual(5);
  expect(b2.store.historyOf(X).map((x) => [x.unit, x.serverSeq, x.pc, x.kind, x.op])).toEqual(history.map((x) => [x.unit, x.serverSeq, x.pc, 'remote', x.op]));
  // The current files but the PDFs: the PDF at its first reading, the old version when opened.
  expect([notes, old, pdf].map((f) => existsSync(filePath(b2.dir, f)))).toEqual([true, false, false]);
  // Then they sync, both ways.
  await run(a, (s) => editNode(s, X, { title: 'X3' }));
  await until(() => b2.session.state.nodes.get(X)?.title === 'X3');
  await run(b2, (s) => editNode(s, X, { summary: 'par B' }));
  await until(() => a.session.state.nodes.get(X)?.summary === 'par B');
});

test('deux bases pleines : refusé, avec l’explication et le remplacement proposé ; annulé, le PC se révoque et garde sa base ; accepté, il prend celle du serveur et garde la sienne à part', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  await fill(a);
  await seeded(l, a);
  const c = await app(l, 'pc-c');
  const M = createdId(await run(c, (s) => createPlan(s, 'Mémoire', 'plan')), 'plan');
  await run(c, (s) => createNode(s, { plan: M, title: 'Seul ici', x: 0, y: 0, k: 0 }));
  const mine = image(c.session.state), journal = JSON.stringify(c.store.changesSince(0));
  const cId = pcId(c.dir);
  const r = await c.sync.pair(l.url, l.code('Bureau'), 'Bureau');
  expect(r).toEqual({
    ok: false, offer: { kind: 'replace', nodes: 2, local: 1, archive: 'pc-c-avant-jumelage-2026-11-08' },
    message: 'Ce PC et le serveur tiennent chacun une base : Cirrus ne fusionne pas deux bases, le jumelage est refusé. Seule la base du serveur peut remplacer celle de ce PC, qui est alors gardée à part.',
  });
  // Only the replacement is offered.
  expect(await c.sync.first('seed')).toEqual({ ok: false, message: 'Ce choix n’est pas proposé : jumelage annulé, ce PC n’est pas jumelé.' });
  expect(pairedPcs(l)).not.toContain(cId);
  // Cancelled (R15): the token revoked by the PC itself; nothing kept, the base as it was.
  const again = await c.sync.pair(l.url, l.code('Bureau'), 'Bureau');
  expect(again).toMatchObject({ ok: false, offer: { kind: 'replace' } });
  expect(pairedPcs(l)).toContain(cId);
  expect(await c.sync.first('cancel')).toEqual({ ok: false, message: 'Jumelage annulé : ce PC n’est pas jumelé.' });
  expect(pairedPcs(l)).not.toContain(cId);
  expect([c.host.paired(), existsSync(join(c.dir, SERVER_FILE)), existsSync(stagedDir(c.dir))]).toEqual([false, false, false]);
  expect([image(c.session.state), JSON.stringify(c.store.changesSince(0))]).toEqual([mine, journal]);
  expect(await c.sync.first('cancel')).toEqual({ ok: false, message: 'Aucun jumelage n’attend de réponse.' });
  // Accepted: the server's base staged, then swapped in at the restart; C's own kept aside, whole.
  expect(await c.sync.pair(l.url, l.code('Bureau'), 'Bureau')).toMatchObject({ offer: { kind: 'replace' } });
  expect(await c.sync.first('adopt')).toEqual({ ok: true, restarting: true });
  const c2 = await restart(l, c);
  await until(() => c2.status?.state === 'live');
  expect(image(c2.session.state)).toBe(image(await l.state()));
  expect([...c2.session.state.plans.values()].some((p) => p.name === 'Mémoire')).toBe(false);
  const archive = join(dirname(c.dir), 'pc-c-avant-jumelage-2026-11-08');
  const kept = new AppPc(l, 'pc-c-avant-jumelage-2026-11-08');
  try {
    expect(kept.dir).toBe(archive);
    expect(JSON.stringify(kept.store.changesSince(0))).toBe(journal);
  } finally {
    kept.store.close();
  }
});

test('envoyer sa base à un serveur qui n’est plus vide : refusé, le PC se révoque, sa base telle quelle (journal non numéroté, rien de gardé)', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  await fill(a);
  const r = await a.sync.pair(l.url, l.code('Portable'), 'Portable');
  expect(r).toMatchObject({ ok: false, offer: { kind: 'seed' } });
  // Meanwhile another PC, empty, joins the empty server: its lobby is the server's first write.
  const v = await l.pc('pc-v');
  v.act((s) => createPlan(s, 'Lobby', 'lobby'));
  await l.settle([v]);
  const journal = JSON.stringify(a.store.changesSince(0)), aId = pcId(a.dir);
  expect(await a.sync.first('seed')).toEqual({
    ok: false, message: 'Base non envoyée : Le serveur tient déjà une base : il ne reçoit celle d’un PC que vide. Ce PC n’est pas jumelé, et sa base reste telle quelle.',
  });
  expect(a.net.count('POST', '/unpair')).toBe(1);
  expect(pairedPcs(l)).not.toContain(aId);
  expect([a.host.paired(), existsSync(join(a.dir, SERVER_FILE)), a.store.lastServerSeq(), a.net.count('GET', '/events')]).toEqual([false, false, 0, 0]);
  expect(JSON.stringify(a.store.changesSince(0))).toBe(journal);
  expect(await l.lastSeq()).toBe(1);
});

test('prendre la base du serveur, interrompu au milieu (le serveur arrêté pendant les fichiers) : la base prise est effacée, l’ancienne intacte ; au démarrage, une base prise incomplète est effacée', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  await fill(a);
  await seeded(l, a);
  const b = await app(l, 'pc-b');
  const M = createdId(await run(b, (s) => createPlan(s, 'Mémoire', 'plan')), 'plan');
  await run(b, (s) => createNode(s, { plan: M, title: 'À garder', x: 0, y: 0, k: 0 }));
  const mine = image(b.session.state), journal = JSON.stringify(b.store.changesSince(0));
  expect(await b.sync.pair(l.url, l.code('Fixe'), 'Fixe')).toMatchObject({ offer: { kind: 'replace' } });
  b.net.holdFiles();
  const taking = b.sync.first('adopt');
  // The snapshot and the journal staged, a file under way: the server stops.
  await until(() => b.net.count('GET', /^\/files\//) > 0);
  expect(existsSync(join(stagedDir(b.dir), 'cirrus.db'))).toBe(true);
  expect(existsSync(join(stagedDir(b.dir), READY_FILE))).toBe(false);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await l.stopServer();
  b.net.releaseFiles();
  expect(await taking).toEqual({ ok: false, message: expect.stringMatching(/^Base du serveur non prise : Serveur injoignable .* Ce PC n’est pas jumelé, et sa base reste telle quelle\.$/s) });
  // The server gone, its token could not be revoked: said, at best (R15).
  expect(warn.mock.calls.some((c) => String(c[0]).startsWith('Jeton de ce PC non révoqué'))).toBe(true);
  expect([existsSync(stagedDir(b.dir)), b.relaunched, b.host.paired(), existsSync(join(b.dir, SERVER_FILE))]).toEqual([false, 0, false, false]);
  expect([image(b.session.state), JSON.stringify(b.store.changesSince(0))]).toEqual([mine, journal]);
  await l.startServer();
  // A crash mid-adopt leaves a staged base without its completion mark: the next start removes it, the base kept.
  const staged = stagedDir(b.dir);
  mkdirSync(join(staged, 'files'), { recursive: true });
  writeFileSync(join(staged, 'cirrus.db'), 'à moitié écrite');
  expect(swapStaged(b.dir, new Date(l.clock))).toBe('dropped');
  expect([existsSync(staged), existsSync(join(b.dir, 'cirrus.db'))]).toEqual([false, true]);
});

test('au démarrage : une base prise complète remplace l’ancienne, gardée sous <nom>-avant-jumelage-AAAA-MM-JJ (« (2) » si le nom est pris), sans liste de téléchargements ; sinon rien', () => {
  const root = mkdtempSync(join(tmpdir(), 'cirrus-echange-'));
  dirs.push(root);
  const dir = join(root, 'base'), staged = stagedDir(dir);
  expect(staged).toBe(join(root, 'base-nouvelle'));
  expect(swapStaged(dir)).toBe('none');
  mkdirSync(dir);
  writeFileSync(join(dir, 'cirrus.db'), 'ancienne');
  writeFileSync(join(dir, DOWNLOADS_FILE), '{"hashes":[]}');
  mkdirSync(staged);
  writeFileSync(join(staged, 'cirrus.db'), 'prise');
  writeFileSync(join(staged, READY_FILE), '{}');
  mkdirSync(join(root, 'base-avant-jumelage-2026-11-08'));
  const day = new Date(2026, 10, 8, 23, 30);
  expect(swapStaged(dir, day)).toBe('swapped');
  expect(readFileSync(join(dir, 'cirrus.db'), 'utf8')).toBe('prise');
  expect(existsSync(join(dir, READY_FILE))).toBe(false);
  const archive = join(root, 'base-avant-jumelage-2026-11-08 (2)');
  expect(readFileSync(join(archive, 'cirrus.db'), 'utf8')).toBe('ancienne');
  expect(existsSync(join(archive, DOWNLOADS_FILE))).toBe(false);
  // Interrupted between its two renames (the old base moved, the staged not yet): the staged one comes in, nothing archived twice.
  mkdirSync(staged);
  writeFileSync(join(staged, 'cirrus.db'), 'reprise');
  writeFileSync(join(staged, READY_FILE), '{}');
  rmSync(dir, { recursive: true });
  expect(swapStaged(dir, day)).toBe('swapped');
  expect(readFileSync(join(dir, 'cirrus.db'), 'utf8')).toBe('reprise');
  expect(existsSync(join(root, 'base-avant-jumelage-2026-11-08 (3)'))).toBe(false);
});

test.runIf(process.platform === 'win32')('au démarrage, la base prise ne peut pas prendre la place (un fichier tenu ouvert dedans) : l’ancienne est remise, et s’ouvre ; l’échange attend le démarrage suivant', () => {
  const root = mkdtempSync(join(tmpdir(), 'cirrus-echange-'));
  dirs.push(root);
  const dir = join(root, 'base'), staged = stagedDir(dir);
  mkdirSync(dir);
  writeFileSync(join(dir, 'cirrus.db'), 'ancienne');
  mkdirSync(staged);
  writeFileSync(join(staged, 'cirrus.db'), 'prise');
  writeFileSync(join(staged, READY_FILE), '{}');
  const held = openSync(join(staged, 'cirrus.db'), 'r');
  try {
    expect(() => swapStaged(dir, new Date(2026, 10, 8))).toThrow();
    expect([readFileSync(join(dir, 'cirrus.db'), 'utf8'), existsSync(join(root, 'base-avant-jumelage-2026-11-08')), existsSync(join(staged, READY_FILE))]).toEqual(['ancienne', false, true]);
  } finally {
    closeSync(held);
  }
  expect(swapStaged(dir, new Date(2026, 10, 8))).toBe('swapped');
  expect(readFileSync(join(dir, 'cirrus.db'), 'utf8')).toBe('prise');
});
