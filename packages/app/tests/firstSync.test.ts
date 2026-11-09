import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Action, applyOps, createNode, createPlan, editNode, encodeState, type FileRef, type Id, type State } from '@cirrus/core';
import { Tokens } from '@cirrus/server';
import { filePath, storeBytes } from '@cirrus/store';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, test, vi } from 'vitest';
import { openBase, pcId } from '../src/main/base.ts';
import { readSettings } from '../src/main/settings.ts';
import { SERVER_FILE } from '../src/main/sync/config.ts';
import { DOWNLOADS_FILE } from '../src/main/sync/downloads.ts';
import { pristine, quitsInsteadOfRelaunch, READY_FILE, stagedDir, stagedWaiting, startBase, swapStaged } from '../src/main/sync/firstSync.ts';
import type { ServerInfo } from '../src/main/sync/protocol.ts';
import { ServerBlock } from '../src/renderer/ui/settings/ServerBlock.tsx';
import { AppPc } from './support/appPc.ts';
import { image, Lab, until } from './support/virtualPc.ts';

// The first pairing (plan 5a, task 5, D7): a PC whose base is not empty sends it to an empty server (seed); an empty
// PC, or one that agrees to replace its base, takes the server's (adopt), staged beside its own and swapped in at the
// next start — a vierge one at once, its base then deleted rather than kept aside (after the short review of plan 5a);
// two full bases are refused, the replacement proposed; an interruption leaves the old base as it was.

let lab: Lab | null = null;
const apps: AppPc[] = [];
const dirs: string[] = [];
/** Other servers a test starts (a second one, new). */
const labs: Lab[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const a of apps.splice(0)) await a.close();
  await lab?.close();
  lab = null;
  for (const l of labs.splice(0)) await l.close();
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

  // B, a new PC (vierge): the server's base taken at once, no offer (after the short review of plan 5a); staged beside
  // its own, which stays until the restart.
  const b = await app(l, 'pc-b');
  const ownId = pcId(b.dir);
  expect(await b.sync.pair(l.url, l.code('Fixe'), 'Fixe')).toEqual({ ok: true, restarting: true });
  expect(b.relaunched).toBe(1);
  // The block says the restart, as the main process words it (short review after plan 5a, D4), not a base waiting.
  const restarting = { paired: false, url: l.url, name: 'Fixe', busy: 'Base du serveur prise : Cirrus redémarre sur elle.' };
  expect([b.host.info(), b.servers.at(-1)]).toEqual([restarting, restarting]);
  expect(existsSync(join(stagedDir(b.dir), READY_FILE))).toBe(true);
  expect([b.host.paired(), existsSync(join(b.dir, SERVER_FILE))]).toEqual([false, false]);
  const b2 = await restart(l, b);
  // The same PC (its identifier, the token's), paired, its old base, vierge, deleted (a used one is kept aside: below).
  expect(pcId(b2.dir)).toBe(ownId);
  expect(b2.host.paired()).toBe(true);
  expect(leftBeside(b2)).toEqual([]);
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
    expect(() => swapStaged(dir, new Date(2026, 10, 8), QUICK)).toThrow();
    expect([readFileSync(join(dir, 'cirrus.db'), 'utf8'), existsSync(join(root, 'base-avant-jumelage-2026-11-08')), existsSync(join(staged, READY_FILE))]).toEqual(['ancienne', false, true]);
  } finally {
    closeSync(held);
  }
  expect(swapStaged(dir, new Date(2026, 10, 8), QUICK)).toBe('swapped');
  expect(readFileSync(join(dir, 'cirrus.db'), 'utf8')).toBe('prise');
});

// ---------------------------------------------------------------------------------------------------------------------
// Review of task 5, round 1.

/** A gate on `pc`'s first request to `path`: `reached` once it waits there, `release` lets it go. */
function holdFirst(pc: AppPc, path: string) {
  let release!: () => void, entered!: () => void, first = true;
  const held = new Promise<void>((r) => { release = r; }), reached = new Promise<void>((r) => { entered = r; });
  pc.net.before = async (_method, p) => {
    if (!first || p !== path) return;
    first = false;
    entered();
    await held;
  };
  return { reached, release };
}

/** The files the server's state names that the server does not hold. */
async function missingOnServer(l: Lab): Promise<FileRef[]> {
  const s = await l.state();
  return [...s.nodes.values()].flatMap((n) => n.files).filter((f) => !serverBlob(l, f));
}

test('revue, Important 1 : un fichier enregistré pendant l’envoi arrive au serveur ; pendant l’envoi, le bloc le dit (Minor 3)', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  const { X, notes, pdf } = await fill(a);
  expect(await a.sync.pair(l.url, l.code('Portable'), 'Portable')).toMatchObject({ offer: { kind: 'seed' } });
  const gate = holdFirst(a, '/files/missing');
  const sending = a.sync.first('seed');
  await gate.reached;
  // Under way: the block shows it, and offers no new pairing.
  expect(a.host.info()).toEqual({ paired: false, url: l.url, name: 'Portable', busy: 'Envoi de la base au serveur…' });
  // A .tex saved meanwhile: its file stored, then the write that names it.
  const tex = storeBytes(a.dir, 'pendant.tex', bytes('\\section{Écrit pendant l’envoi}'));
  await run(a, (s) => editNode(s, X, { files: [notes, pdf, tex] }));
  gate.release();
  expect(await sending).toEqual({ ok: true });
  await until(() => a.status?.state === 'live' && a.status.pending === 0 && a.store.pendingCount() === 0, 5000, () => JSON.stringify(a.statuses));
  expect((await l.state()).nodes.get(X)?.files.map((f) => f.name)).toEqual(['notes.txt', 'Article.pdf', 'pendant.tex']);
  expect(await missingOnServer(l)).toEqual([]);
});

test('revue, tour 2, Minor 3 : le bloc « Serveur » remonté pendant un envoi (panneau rouvert, rubrique dépliée) relit l’état du principal : l’envoi en cours, aucun bouton ; à la fin, jumelé', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  await fill(a);
  expect(await a.sync.pair(l.url, l.code('Portable'), 'Portable')).toMatchObject({ offer: { kind: 'seed' } });
  // What the interface kept after the pairing (App's state): the offer.
  const kept = a.servers.at(-1)!;
  expect(kept.offer?.offer.kind).toBe('seed');
  const gate = holdFirst(a, '/files/missing');
  const sending = a.sync.first('seed');
  await gate.reached;
  const block = (info: ServerInfo) => renderToStaticMarkup(createElement(ServerBlock, {
    info, status: { state: 'off' }, onPair: (u, c, n) => a.sync.pair(u, c, n), onFirst: (c) => a.sync.first(c), onUnpair: () => a.sync.unpair(), refresh: () => a.sync.server(),
  }));
  // Mounted again: until it has read the main process, nothing to click in the offer it was left with…
  expect(block(kept)).toContain('Envoyer la base de ce PC au serveur');
  expect(block(kept)).not.toMatch(/<button(?![^>]*disabled)/);
  // …then its reading (the block's mounting): the seed under way, which the interface now holds; no button at all.
  const now = await a.sync.server();
  expect(now).toEqual({ paired: false, url: l.url, name: 'Portable', busy: 'Envoi de la base au serveur…' });
  expect(a.servers.at(-1)).toEqual(now);
  expect(block(now)).toContain('Envoi de la base au serveur…');
  expect(block(now)).not.toContain('<button');
  gate.release();
  expect(await sending).toEqual({ ok: true });
  // Done: the interface holds the server paired.
  expect(a.servers.at(-1)).toMatchObject({ paired: true, url: l.url, name: 'Portable' });
});

test('revue courte du plan 5a, B2 : la page rechargée (Ctrl+R) pendant un envoi s’ouvre non jumelée ; l’envoi fini, le principal le lui dit, et elle démarre la synchro, ses écritures en attente envoyées', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  const { X } = await fill(a);
  expect(await a.sync.pair(l.url, l.code('Portable'), 'Portable')).toMatchObject({ offer: { kind: 'seed' } });
  const gate = holdFirst(a, '/files/missing');
  // « Envoyer », asked by the page about to go: its answer reaches no one (the reloaded page is another), so the call
  // is the host's own.
  const sending = a.host.first('seed');
  await gate.reached;
  // Ctrl+R: the new page opens while the seed runs, not paired yet — nothing to follow, nothing started.
  await a.reload();
  expect(a.host.info()).toMatchObject({ paired: false, busy: 'Envoi de la base au serveur…' });
  // A write on the new page meanwhile: pending, after the lines the seed sends.
  await run(a, (s) => editNode(s, X, { title: 'X pendant l’envoi' }));
  gate.release();
  expect(await sending).toEqual({ ok: true });
  // The new page told (cirrus:sync:server): it takes the pending writes and starts; the write reaches the server.
  await until(() => a.status?.state === 'live' && a.status.pending === 0 && a.store.pendingCount() === 0, 3000, () => `état ${JSON.stringify(a.statuses.slice(-3))}, ${a.store.pendingCount()} en attente`);
  expect((await l.state()).nodes.get(X)?.title).toBe('X pendant l’envoi');
  expect(a.servers.at(-1)).toMatchObject({ paired: true, url: l.url, name: 'Portable' });
  expect(a.view?.chip?.text).toBe('À jour');
});

test('R19, R20 : une ligne au libellé trop long (écrite avant la borne) et une violation déjà dans la base n’empêchent pas l’envoi ; le libellé arrive coupé', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  const { X } = await fill(a);
  // As an older version wrote them: a label past the bound, a connection of one member (commit checks records, not rules).
  await run(a, (s) => ({ ...editNode(s, X, { summary: 'Un résumé.' }), label: 'L'.repeat(800) }));
  const lone = { id: 'c-seule', kind: 'knowledge' as const, title: '', relation: '', tags: [], members: [{ node: X, role: 'source' as const }] };
  await run(a, () => ({ id: 'a-seule', label: 'Connexion d’un seul membre', ops: [{ t: 'connection', before: null, after: lone }] }));
  expect(await a.sync.pair(l.url, l.code('Portable'), 'Portable')).toMatchObject({ offer: { kind: 'seed' } });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(await a.sync.first('seed')).toEqual({ ok: true });
  expect(image(await l.state())).toBe(image(a.session.state));
  const long = (await l.journal()).find((r) => r.label.startsWith('LLL'))!;
  expect([long.label.length, long.label.endsWith('…')]).toEqual([500, true]);
  // The server says what it kept (R19).
  expect(warn.mock.calls.some((c) => /1 violation/.test(String(c[0])))).toBe(true);
});

test('revue, Important 3 : un instantané rangé qui ne se rejoue pas jusqu’au bout du journal : l’envoi prend l’état des tables', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  await fill(a);
  // The whole state, said to cover the first line only: the journal's tail does not replay on it.
  a.store.dropSnapshot();
  a.store.writeSnapshot(encodeState(a.session.state), 1);
  expect(await a.sync.pair(l.url, l.code('Portable'), 'Portable')).toMatchObject({ offer: { kind: 'seed' } });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(await a.sync.first('seed')).toEqual({ ok: true });
  expect(image(await l.state())).toBe(image(a.session.state));
  expect(warn.mock.calls.some((c) => String(c[0]).startsWith('Instantané de cette base inutilisable pour l’envoi'))).toBe(true);
});

test('revue, Important 3 : une ligne vraiment mal formée arrête l’envoi avant toute requête, en le disant', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  await fill(a);
  // A plan of a type the model does not have: the store keeps it (it checks nodes and connections), parseOp does not.
  a.store.commit({ id: 'a-abimee', label: 'Plan abîmé', ops: [{ t: 'plan', before: null, after: { id: 'p-abime', name: 'Abîmé', type: 'autre' as 'plan' } }] });
  const line = a.store.lastSeq();
  expect(await a.sync.pair(l.url, l.code('Portable'), 'Portable')).toMatchObject({ offer: { kind: 'seed' } });
  const before = a.net.requests.length;
  const r = await a.sync.first('seed');
  expect(r).toEqual({ ok: false, message: expect.stringMatching(new RegExp(`^Base non envoyée : Ligne ${line} du journal de ce PC : Opération mal formée : plan\\.after\\.type .* Ce PC n’est pas jumelé, et sa base reste telle quelle\\.$`)) });
  // Nothing of the base was sent: only the revocation (R15).
  expect(a.net.requests.slice(before)).toEqual([{ method: 'POST', path: '/unpair' }]);
  expect(await l.lastSeq()).toBe(0);
});

test('R20 : une écriture en attente au libellé trop long (faite avant la borne) part coupée, et passe', async () => {
  const l = (lab = await Lab.start());
  const v = await l.pc('pc-v');
  const u = v.act((s) => ({ ...createPlan(s, 'Thèse', 'plan'), label: 'L'.repeat(700) }));
  await l.settle([v]);
  const row = (await l.journal()).find((x) => x.unit === u!.unit);
  expect([row?.label.length, row?.label.endsWith('…'), v.dropped]).toEqual([500, true, []]);
});

/** The swap's retries for the tests: two, a millisecond apart. */
const QUICK = { tries: 2, pauseMs: 1 };

/** The fake rename of the swap: the moves `fails` names refuse (EBUSY) so many times, then rename for real. */
function flaky(fails: Map<string, number>) {
  return (from: string, to: string) => {
    const key = `${from} → ${to}`, left = fails.get(key) ?? 0;
    if (left > 0) {
      fails.set(key, left - 1);
      throw Object.assign(new Error(`EBUSY: resource busy or locked, rename '${from}'`), { code: 'EBUSY' });
    }
    renameSync(from, to);
  };
}

/** A base folder (`oldBase`: holding a base) and a complete staged one beside it. */
function staging(oldBase: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'cirrus-echange-'));
  dirs.push(root);
  const dir = join(root, 'base'), staged = stagedDir(dir), archive = join(root, 'base-avant-jumelage-2026-11-08');
  if (oldBase) {
    mkdirSync(dir);
    writeFileSync(join(dir, 'cirrus.db'), 'ancienne');
  }
  mkdirSync(staged);
  writeFileSync(join(staged, 'cirrus.db'), 'prise');
  writeFileSync(join(staged, READY_FILE), '{}');
  return { root, dir, staged, archive };
}

const DAY = new Date(2026, 10, 8, 12);

test('revue, Important 2 : la base prise refusée à sa place, l’ancienne est remise en réessayant ; le démarrage ouvre l’ancienne, et une base attend', () => {
  const { dir, staged, archive } = staging(true);
  const rename = flaky(new Map([[`${staged} → ${dir}`, 99], [`${archive} → ${dir}`, 1]]));
  expect(startBase(dir, DAY, { tries: 3, pauseMs: 1, rename })).toEqual({ open: true, log: expect.stringMatching(/attend dans « .*base-nouvelle »/) });
  expect([readFileSync(join(dir, 'cirrus.db'), 'utf8'), existsSync(archive), existsSync(join(staged, READY_FILE))]).toEqual(['ancienne', false, true]);
  expect(stagedWaiting(dir)).toBe(true);
});

test('revue, Important 2 : sans base à sa place après un échange manqué, le démarrage s’arrête et dit où sont les bases ; il n’en ouvre pas une neuve', () => {
  // The old base could not be put back.
  const one = staging(true);
  const stuck = startBase(one.dir, DAY, { ...QUICK, rename: flaky(new Map([[`${one.staged} → ${one.dir}`, 99], [`${one.archive} → ${one.dir}`, 99]])) });
  expect(stuck).toEqual({ open: false, message: expect.stringContaining(`« ${one.archive} »`) });
  expect((stuck as { message: string }).message).toContain(`« ${one.staged} »`);
  expect(existsSync(join(one.dir, 'cirrus.db'))).toBe(false);
  // No old base (an earlier interruption), and the staged one cannot take its place.
  const two = staging(false);
  expect(startBase(two.dir, DAY, { ...QUICK, rename: flaky(new Map([[`${two.staged} → ${two.dir}`, 99]])) })).toEqual({ open: false, message: expect.stringContaining(`« ${two.staged} »`) });
  // Nothing staged: open, nothing said.
  expect(startBase(join(two.root, 'autre'), DAY)).toEqual({ open: true, log: null });
});

test('revue, Important 2 : une base prise qui attend est dite à l’ouverture (une notification) et dans le bloc « Serveur »', async () => {
  const l = (lab = await Lab.start());
  const staged = stagedDir(join(l.root, 'pc-a'));
  mkdirSync(staged, { recursive: true });
  writeFileSync(join(staged, READY_FILE), '{}');
  const a = await app(l, 'pc-a');
  expect(a.host.info()).toEqual({ paired: false, url: '', name: 'PORTABLE', waiting: expect.stringMatching(/^Une base prise du serveur attend dans « .*pc-a-nouvelle » .*relance Cirrus/) });
  await until(() => a.toasts.length > 0);
  expect(a.toasts).toEqual([a.host.info().waiting]);
});

test('R27 : CIRRUS_NO_RELAUNCH fait seulement quitter l’app après une prise, et seulement sur une base de test en arrière-plan ou en capture', () => {
  const env = { CIRRUS_NO_RELAUNCH: '1', CIRRUS_DATA: 'D:\\base-de-test' };
  expect(quitsInsteadOfRelaunch({ ...env, CIRRUS_BACKGROUND: '1' }, false)).toBe(true);
  expect(quitsInsteadOfRelaunch(env, true)).toBe(true);
  // Inert by default, on the user's own base, in a window in front, or for another value.
  expect(quitsInsteadOfRelaunch({}, false)).toBe(false);
  expect(quitsInsteadOfRelaunch({ CIRRUS_NO_RELAUNCH: '1', CIRRUS_BACKGROUND: '1' }, true)).toBe(false);
  expect(quitsInsteadOfRelaunch(env, false)).toBe(false);
  expect(quitsInsteadOfRelaunch({ ...env, CIRRUS_NO_RELAUNCH: 'oui', CIRRUS_BACKGROUND: '1' }, false)).toBe(false);
});

// ---------------------------------------------------------------------------------------------------------------------
// Final review of plan 5a: pairing a PC again with the server it follows (R31), a history that today's bounds would
// refuse (R32), a base already numbered by an earlier server (Minor 7).

/** What a first sync left beside the base: an archive (`…-avant-jumelage-…`) or a staged base (`…-nouvelle`). */
const leftBeside = (a: AppPc): string[] => readdirSync(dirname(a.dir)).filter((d) => d.startsWith(`${a.name}-`));

/**
 * A, paired with the lab's server through a seed (its full base), then cut from it by `cut`; offline, it renames X and
 * adds a node — and a setting changed in Réglages —; then it is dissociated and paired again with a new code: no offer,
 * paired at once; the writes made meanwhile reach the server, nothing goes aside, the settings are not stamped again.
 */
async function rejoin(cut: (l: Lab, a: AppPc) => Promise<void>): Promise<void> {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  const { X } = await fill(a);
  await seeded(l, a);
  const id = await l.baseId();
  expect(a.store.baseId()).toBe(id);
  await cut(l, a);
  await run(a, (s) => editNode(s, X, { title: 'X entre-temps' }));
  const P = [...a.session.state.plans.values()].find((p) => p.name === 'Thèse')!.id;
  const N = createdId(await run(a, (s) => createNode(s, { plan: P, title: 'Nouveau entre-temps', x: 600, y: 0, k: 0 })), 'node');
  if (a.host.paired()) await a.sync.unpair();
  a.host.setSettings({ syncDownloads: 7 });
  expect(a.store.pendingCount()).toBe(2);
  const sentSettings = a.net.count('POST', '/settings');
  expect(await a.sync.pair(l.url, l.code('Portable'), 'Portable')).toEqual({ ok: true });
  await until(() => a.status?.state === 'live' && a.status.pending === 0 && a.store.pendingCount() === 0, 5000, () => JSON.stringify(a.statuses.slice(-3)));
  const server = await l.state();
  expect([server.nodes.get(X)?.title, server.nodes.get(N)?.title]).toEqual(['X entre-temps', 'Nouveau entre-temps']);
  expect(image(server)).toBe(image(a.session.state));
  expect([a.store.baseId(), await l.baseId()]).toEqual([id, id]);
  // Nothing aside, nothing staged, no restart; the settings not stamped again at the pairing, nor sent (R31).
  expect([leftBeside(a), a.relaunched]).toEqual([[], 0]);
  expect(a.net.count('POST', '/settings')).toBe(sentSettings);
  expect((await l.settings()).syncDownloads).toBeUndefined();
}

test('R31 : jumelé de nouveau après « Dissocier ce PC » : aucune offre, les écritures faites entre-temps partent, rien n’est mis à part', async () => {
  await rejoin(async (_l, a) => { await a.sync.unpair(); });
});

test('R31 : jumelé de nouveau après une révocation au serveur (revoquer) : de même', async () => {
  await rejoin(async (l, a) => {
    l.revoke('Portable');
    // Its next connection is refused: the chip says it.
    await a.host.client.stop();
    a.host.retry();
    await until(() => a.status?.state === 'refused', 5000, () => JSON.stringify(a.statuses.slice(-3)));
    expect(a.status).toMatchObject({ message: 'Jeton absent, inconnu ou révoqué : jumelle ce PC de nouveau.' });
  });
});

test('R31 : jumelé de nouveau après la remise à zéro de serveur.db (la base du serveur gardée) : de même', async () => {
  await rejoin(async (l, a) => {
    await l.resetServerDb();
    await until(() => a.status?.state === 'refused', 5000, () => JSON.stringify(a.statuses.slice(-3)));
  });
});

test('revue courte du plan 5a, B1 : la réponse de /seed/done perdue, le serveur ayant pris la base ; jumelé de nouveau, le PC reprend (R31), sans offre de remplacement, et rien ne reste en rade : ni les écritures faites pendant l’envoi, ni ses réglages', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  const { X } = await fill(a);
  a.host.setSettings({ syncDownloads: 7 });
  expect(await a.sync.pair(l.url, l.code('Portable'), 'Portable')).toMatchObject({ offer: { kind: 'seed' } });
  // A write while the base is sent, just before done; then done's answer lost: the server takes the base, the PC
  // never hears it.
  a.net.before = async (_method, path) => {
    if (path !== '/seed/done') return;
    a.net.before = null;
    await run(a, (s) => editNode(s, X, { title: 'X pendant l’envoi' }));
  };
  a.net.loses = (method, path) => method === 'POST' && path === '/seed/done';
  expect(await a.sync.first('seed')).toEqual({ ok: false, message: expect.stringMatching(/^Base non envoyée : Serveur injoignable/) });
  a.net.loses = null;
  const id = await l.baseId(), lines = await l.lastSeq();
  expect([a.host.paired(), lines > 0, (await l.state()).nodes.get(X)?.title]).toEqual([false, true, 'X2']);
  // Paired again: the server's base is the one this PC sent (its identity, given at the seed's start) — no offer, no
  // replacement; the lines it sent numbered as done's answer would have, the write made meanwhile sent.
  expect(await a.sync.pair(l.url, l.code('Portable'), 'Portable')).toEqual({ ok: true });
  await until(() => a.status?.state === 'live' && a.status.pending === 0 && a.store.pendingCount() === 0, 3000, () => `état ${JSON.stringify(a.statuses.slice(-3))}, ${a.store.pendingCount()} en attente`);
  const server = await l.state();
  expect(server.nodes.get(X)?.title).toBe('X pendant l’envoi');
  expect(image(server)).toBe(image(a.session.state));
  expect([a.store.baseId(), await l.baseId()]).toEqual([id, id]);
  expect(a.store.changesSince(0).map((r) => [r.localSeq, r.serverSeq, r.unit])).toEqual((await l.journal()).map((r) => [r.localSeq, r.serverSeq, r.unit]));
  expect([leftBeside(a), a.relaunched]).toEqual([[], 0]);
  // Its settings sent, as a seed sends them (R23): stamped at the first pairing.
  await until(async () => (await l.settings()).syncDownloads?.value === 7);
  expect(readSettings(a.dir).syncDownloads).toBe(7);
});

test('Minor 7 et R31 : une base déjà numérotée par un serveur s’envoie à un serveur neuf (l’offre de D7, pas une reprise) : ses numéros effacés puis redonnés, le serveur et le PC d’accord, et la synchro continue', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  expect(await a.sync.pair(l.url, l.code('Portable'), 'Portable')).toEqual({ ok: true });
  await until(() => a.status?.state === 'live' && a.store.pendingCount() === 0);
  expect(a.store.baseId()).toBe(await l.baseId());
  // Another PC writes while A's writes wait: A's journal gets received lines, inverses and replayed ones — its own
  // numbers no longer the server's.
  const v = await l.pc('pc-v');
  await until(() => v.store.lastServerSeq() === 1);
  const lobby = [...v.s.plans.values()][0].id;
  await a.host.client.stop();
  for (let i = 0; i < 3; i++) await run(a, (s) => createNode(s, { plan: lobby, title: `A${i}`, x: i * 200, y: 0, k: 0 }));
  for (let i = 0; i < 3; i++) v.act((s) => createNode(s, { plan: lobby, title: `V${i}`, x: i * 200, y: 300, k: 0 }));
  await l.settle([v]);
  a.host.retry();
  await until(() => a.status?.state === 'live' && a.store.pendingCount() === 0 && a.session.state.nodes.size === 6, 5000, () => JSON.stringify(a.statuses.slice(-3)));
  const before = a.store.changesSince(0);
  expect(before.some((r) => r.serverSeq !== null && r.serverSeq !== r.localSeq)).toBe(true);
  expect(before.some((r) => r.kind === 'rewind')).toBe(true);
  // A new server, fresh: the offer of D7 (its base sent), not a rejoin — another base identity.
  await a.sync.unpair();
  const l2 = await Lab.start();
  labs.push(l2);
  expect(await a.sync.pair(l2.url, l2.code('Portable'), 'Portable')).toMatchObject({ ok: false, offer: { kind: 'seed', nodes: 6 } });
  expect(await a.sync.first('seed')).toEqual({ ok: true });
  const last = before.length;
  expect(a.store.lastServerSeq()).toBe(last);
  expect(a.store.changesSince(0).map((r) => [r.localSeq, r.serverSeq])).toEqual(before.map((r) => [r.localSeq, r.localSeq]));
  expect((await l2.journal()).map((r) => [r.localSeq, r.serverSeq, r.unit, r.kind])).toEqual(before.map((r) => [r.localSeq, r.localSeq, r.unit, r.kind]));
  expect(a.store.baseId()).toBe(await l2.baseId());
  expect(await l2.baseId()).not.toBe(await l.baseId());
  // And it goes on: the next write numbered after them, on both sides.
  await until(() => a.status?.state === 'live');
  await run(a, (s) => createNode(s, { plan: lobby, title: 'Après', x: 0, y: 600, k: 0 }));
  await until(() => a.store.pendingCount() === 0 && a.store.lastServerSeq() === last + 2);
  expect(await l2.lastSeq()).toBe(last + 2);
  expect(image(await l2.state())).toBe(image(a.session.state));
});

/**
 * A base as an older app left it: a plan, X, then X given a word tag of 200 characters (past MAX_ID_CHARS), then that
 * tag removed — all written straight to the base, before the app opens it; its snapshot stored before that line or
 * after it (`snapshotAfter`).
 */
function oldBase(l: Lab, name: string, snapshotAfter: boolean): { a: AppPc; X: Id; line: number } {
  const a = new AppPc(l, name);
  apps.push(a);
  const s = a.store.loadState(), long = 'mot'.repeat(70);
  const commit = (x: Action) => { a.store.commit(x); applyOps(s, x.ops); return x; };
  const P = createdId(commit(createPlan(s, 'Thèse', 'plan')), 'plan');
  const X = createdId(commit(createNode(s, { plan: P, title: 'X', x: 0, y: 0, k: 0 })), 'node');
  if (!snapshotAfter) a.store.writeSnapshot(encodeState(s), a.store.lastSeq());
  const x = s.nodes.get(X)!;
  commit({ id: 'a-ancien', label: 'Tag d’une version ancienne', ops: [{ t: 'node', before: x, after: { ...x, tags: [{ key: long }] } }] });
  const line = a.store.lastSeq();
  commit(editNode(s, X, { tags: [] }));
  if (snapshotAfter) a.store.writeSnapshot(encodeState(s), a.store.lastSeq());
  return { a, X, line };
}

test.each([
  ['dans l’historique que couvre l’instantané', true],
  ['dans la fin du journal (l’instantané n’est pas pris : l’état des tables part)', false],
])('R32 : une base dont une ligne passée tient une clé de tag trop longue, %s, s’envoie puis se prend ; la numérotation est la même au serveur, chez celui qui envoie et chez celui qui prend', async (_where, snapshotAfter) => {
  const l = (lab = await Lab.start());
  const { a, X, line } = oldBase(l, 'pc-a', snapshotAfter);
  await a.open();
  await run(a, (s) => editNode(s, X, { title: 'X2' }));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await seeded(l, a);
  // Its tail refused as a write, the tables' state goes, whole (said); covered by the snapshot, the snapshot goes.
  expect(warn.mock.calls.some((c) => String(c[0]).startsWith('Instantané de cette base inutilisable pour l’envoi'))).toBe(!snapshotAfter);
  const numbered = (rows: { localSeq: number; serverSeq: number | null; unit: string }[]) => rows.map((r) => [r.localSeq, r.serverSeq, r.unit]);
  const sent = numbered(a.store.changesSince(0));
  expect(sent.every(([local, server]) => local === server)).toBe(true);
  expect(numbered(await l.journal())).toEqual(sent);
  // B, vierge, takes it at once: the same lines, the same numbers, the old one too.
  const b = await app(l, 'pc-b');
  expect(await b.sync.pair(l.url, l.code('Fixe'), 'Fixe')).toEqual({ ok: true, restarting: true });
  const b2 = await restart(l, b);
  await until(() => b2.status?.state === 'live');
  expect(numbered(b2.store.changesSince(0))).toEqual(sent);
  expect(b2.store.changesSince(line - 1, 1)[0].op).toEqual(a.store.changesSince(line - 1, 1)[0].op);
  expect([b2.store.baseId(), a.store.baseId()]).toEqual([await l.baseId(), await l.baseId()]);
  expect(image(b2.session.state)).toBe(image(a.session.state));
});

// ---------------------------------------------------------------------------------------------------------------------
// After the short review of plan 5a: the first pairing of a vierge PC (2026-11-09). A base as its first opening made
// it, nothing touched since (pristine), takes the server's at once, without an offer, and the swap deletes it rather
// than keep it aside; an empty base that was used keeps the offer and the archive.

/** What the main process tells the block while a PC takes the server's base, then once it is taken (B2, D4). */
const downloading = (l: Lab, name: string): ServerInfo => ({ paired: false, url: l.url, name, busy: 'Téléchargement de la base du serveur…' });
const restartingOn = (l: Lab, name: string): ServerInfo => ({ paired: false, url: l.url, name, busy: 'Base du serveur prise : Cirrus redémarre sur elle.' });

/** The block « Serveur » as `info` draws it, read from the main process already (nothing clicked here). */
const drawn = (info: ServerInfo) => renderToStaticMarkup(createElement(ServerBlock, {
  info, status: { state: 'off' }, onPair: async () => ({ ok: true as const }), onFirst: async () => ({ ok: true as const }), onUnpair: async () => {},
}));

test('PC vierge face à un serveur plein : aucune offre, la base du serveur prise dès le code accepté (le bloc ne dit que le téléchargement), l’app redémarre sur elle ; la base vierge est effacée, aucun dossier -avant-jumelage-', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  await fill(a);
  await seeded(l, a);
  // B, as its first opening made it: its lobby, nothing else.
  const b = await app(l, 'pc-b');
  const ownId = pcId(b.dir);
  expect(await b.sync.pair(l.url, l.code('Fixe'), 'Fixe')).toEqual({ ok: true, restarting: true });
  // What the window was told: the download, then the restart — never an offer, nothing to click.
  expect(b.serversTold).toEqual([downloading(l, 'Fixe'), restartingOn(l, 'Fixe')]);
  expect(drawn(b.serversTold[0])).toContain('Téléchargement de la base du serveur…');
  expect(drawn(b.serversTold[0])).not.toContain('<button');
  expect([b.relaunched, b.host.paired(), existsSync(join(b.dir, SERVER_FILE)), existsSync(join(stagedDir(b.dir), READY_FILE))]).toEqual([1, false, false, true]);
  const b2 = await restart(l, b);
  // Deleted, not kept aside: nothing beside the base, neither an archive nor a staged one.
  expect(leftBeside(b2)).toEqual([]);
  expect([pcId(b2.dir), b2.host.paired()]).toEqual([ownId, true]);
  await until(() => b2.status?.state === 'live', 5000, () => JSON.stringify(b2.statuses));
  expect(image(b2.session.state)).toBe(image(await l.state()));
  expect([b2.store.baseId(), b2.store.pendingCount()]).toEqual([await l.baseId(), 0]);
});

test('PC vide mais déjà servi (un nœud créé puis annulé) face à un serveur plein : l’offre, comme avant ; prise, sa base gardée à part sous <nom>-avant-jumelage-AAAA-MM-JJ', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  await fill(a);
  await seeded(l, a);
  const c = await app(l, 'pc-c');
  const lobby = [...c.session.state.plans.values()][0].id;
  await run(c, (s) => createNode(s, { plan: lobby, title: 'Essai', x: 0, y: 0, k: 0 }));
  expect((await c.session.undo()).ok).toBe(true);
  // Empty in D7's sense, never synced, but not vierge: its journal holds more than its lobby's creation.
  expect([c.store.isEmpty(), c.store.lastServerSeq(), c.store.lastSeq() > 1, pristine(c.store, c.dir)]).toEqual([true, 0, true, false]);
  const journal = JSON.stringify(c.store.changesSince(0));
  expect(await c.sync.pair(l.url, l.code('Bureau'), 'Bureau')).toEqual({
    ok: false, offer: { kind: 'adopt', nodes: 2, archive: 'pc-c-avant-jumelage-2026-11-08' },
    message: 'Le serveur tient déjà une base : ce PC peut la prendre. Cirrus redémarre alors sur elle ; la base actuelle de ce PC est gardée à part.',
  });
  // Nothing taken nor kept while the user decides (R8).
  expect([c.host.paired(), existsSync(stagedDir(c.dir)), c.net.count('GET', '/snapshot'), c.relaunched]).toEqual([false, false, 0, 0]);
  expect(await c.sync.first('adopt')).toEqual({ ok: true, restarting: true });
  const c2 = await restart(l, c);
  await until(() => c2.status?.state === 'live', 5000, () => JSON.stringify(c2.statuses));
  expect(image(c2.session.state)).toBe(image(await l.state()));
  // Kept aside, whole, without a list of downloads to do nor a server.
  expect(leftBeside(c2)).toEqual(['pc-c-avant-jumelage-2026-11-08']);
  const archive = join(dirname(c.dir), 'pc-c-avant-jumelage-2026-11-08');
  expect([existsSync(join(archive, 'cirrus.db')), existsSync(join(archive, SERVER_FILE)), existsSync(join(archive, DOWNLOADS_FILE))]).toEqual([true, false, false]);
  const kept = new AppPc(l, 'pc-c-avant-jumelage-2026-11-08');
  try {
    expect(JSON.stringify(kept.store.changesSince(0))).toBe(journal);
  } finally {
    kept.store.close();
  }
});

test('PC vierge, la prise interrompue au milieu (un fichier perdu en route) : son jeton révoqué, sa base vierge intacte, l’erreur dite ; rien à côté', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a');
  await fill(a);
  await seeded(l, a);
  const b = await app(l, 'pc-b');
  const bId = pcId(b.dir), mine = image(b.session.state), journal = JSON.stringify(b.store.changesSince(0));
  expect(pristine(b.store, b.dir)).toBe(true);
  // The snapshot and the journal staged, the answer of a file's download lost: the server, reachable, keeps the token.
  b.net.loses = (method, path) => method === 'GET' && path.startsWith('/files/');
  expect(await b.sync.pair(l.url, l.code('Fixe'), 'Fixe')).toEqual({
    ok: false, message: expect.stringMatching(/^Base du serveur non prise : Serveur injoignable .* Ce PC n’est pas jumelé, et sa base reste telle quelle\.$/s),
  });
  expect(b.net.count('GET', '/snapshot')).toBe(1);
  // Revoked by the PC itself (R15): the server no longer knows it.
  expect(b.net.count('POST', '/unpair')).toBe(1);
  expect(pairedPcs(l)).not.toContain(bId);
  // The block: the download, then the form again, under which the pairing's message is said (ServerBlock: outcome).
  expect(b.serversTold).toEqual([downloading(l, 'Fixe'), { paired: false, url: '', name: 'PORTABLE' }]);
  expect([leftBeside(b), b.relaunched, b.host.paired(), existsSync(join(b.dir, SERVER_FILE))]).toEqual([[], 0, false, false]);
  expect([image(b.session.state), JSON.stringify(b.store.changesSince(0)), pristine(b.store, b.dir)]).toEqual([mine, journal, true]);
  // Paired again, the server reachable: taken this time.
  b.net.loses = null;
  expect(await b.sync.pair(l.url, l.code('Fixe'), 'Fixe')).toEqual({ ok: true, restarting: true });
});

test('au démarrage, une base vierge que la base prise ne peut pas remplacer (son renommage refusé) est remise à sa place, pas effacée ; l’échange fait au démarrage suivant, elle l’est', () => {
  const root = mkdtempSync(join(tmpdir(), 'cirrus-echange-'));
  dirs.push(root);
  const dir = join(root, 'base'), staged = stagedDir(dir);
  // As its first opening made it.
  openBase(dir).close();
  mkdirSync(staged);
  writeFileSync(join(staged, 'cirrus.db'), 'prise');
  writeFileSync(join(staged, READY_FILE), '{}');
  const refused = flaky(new Map([[`${staged} → ${dir}`, 99]]));
  expect(startBase(dir, DAY, { ...QUICK, rename: refused })).toEqual({ open: true, log: expect.stringMatching(/attend dans « .*base-nouvelle »/) });
  expect([existsSync(join(dir, 'cirrus.db')), stagedWaiting(dir), readdirSync(root).sort()]).toEqual([true, true, ['base', 'base-nouvelle']]);
  const back = openBase(dir);
  try {
    expect(pristine(back, dir)).toBe(true);
  } finally {
    back.close();
  }
  expect(swapStaged(dir, DAY, QUICK)).toBe('swapped');
  expect([readFileSync(join(dir, 'cirrus.db'), 'utf8'), readdirSync(root)]).toEqual(['prise', ['base']]);
});
