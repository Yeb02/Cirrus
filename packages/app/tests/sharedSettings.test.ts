import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNode, createPlan, MAX_SETTING_AHEAD_MS, MAX_SETTINGS_PER_REQUEST } from '@cirrus/core';
import { MAX_SETTINGS_KEPT } from '@cirrus/server';
import { DEFAULT_PARAMS, type RenderParams, withOverrides } from '@cirrus/view';
import { afterEach, expect, test, vi } from 'vitest';
import { pcId } from '../src/main/base.ts';
import { parseSettingRows, PENDING_SETTINGS_FILE, readSettings, SharedSettings, writeSettings } from '../src/main/settings.ts';
import { swapStaged } from '../src/main/sync/firstSync.ts';
import { applyReceived, dueChanges, keepUnsaved, localChanges, withSetting } from '../src/renderer/settingChanges.ts';
import { AppPc } from './support/appPc.ts';
import { created, Lab, T0, until } from './support/virtualPc.ts';

// The shared settings (plan 5a, task 6, D9, R23, R24), between app PCs (the main process's SyncHost, its client, the
// interface's session) and a server in the process: the more recent change wins, setting by setting, then the greater
// PC identifier; a setting changed offline goes on the way back; every PC ends with the server's; a value received is
// bounded as one read from the disk; the first pairing sends this PC's (a seed, or two empty bases) or takes the
// server's (an adopt). Without a server, nothing changes.

let lab: Lab | null = null;
const apps: AppPc[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const a of apps.splice(0)) await a.close();
  await lab?.close();
  lab = null;
});

/** An app PC of the lab, its settings.json written first when given (the settings it had before). */
async function app(l: Lab, name: string, settings?: Record<string, unknown>): Promise<AppPc> {
  if (settings) {
    mkdirSync(join(l.root, name), { recursive: true });
    writeSettings(join(l.root, name), settings);
  }
  const a = new AppPc(l, name);
  apps.push(a);
  return a.open();
}

/** The app closed, then opened again on the same base (a restart, the server reachable or not). */
async function reopen(l: Lab, a: AppPc): Promise<AppPc> {
  apps.splice(apps.indexOf(a), 1);
  await a.close();
  return app(l, a.name);
}

const live = (a: AppPc) => until(() => a.status?.state === 'live' && a.status.pending === 0, 5000, () => JSON.stringify(a.statuses));

/** An empty PC paired with an empty server (D7's first case): paired at once. */
async function joined(l: Lab, name: string, settings?: Record<string, unknown>): Promise<AppPc> {
  const a = await app(l, name, settings);
  expect(await a.sync.pair(l.url, l.code(name), name)).toEqual({ ok: true });
  await live(a);
  return a;
}

/** A PC that takes the server's base (D7, adopt), then starts again on it; what its settings.json held at that start. */
async function adopted(l: Lab, name: string, settings?: Record<string, unknown>): Promise<{ pc: AppPc; atStart: Record<string, unknown> }> {
  const b = await app(l, name, settings);
  expect(await b.sync.pair(l.url, l.code(name), name)).toMatchObject({ ok: false, offer: { kind: 'adopt' } });
  expect(await b.sync.first('adopt')).toEqual({ ok: true, restarting: true });
  apps.splice(apps.indexOf(b), 1);
  await b.close();
  expect(swapStaged(b.dir, new Date(l.clock))).toBe('swapped');
  const atStart = readSettings(b.dir);
  const pc = await app(l, name);
  await live(pc);
  return { pc, atStart };
}

/** settings-pending.json of a PC: null when absent. */
const pendingOf = (a: AppPc): unknown => (existsSync(join(a.dir, PENDING_SETTINGS_FILE)) ? JSON.parse(readFileSync(join(a.dir, PENDING_SETTINGS_FILE), 'utf8')) : null);
const nothingPending = (a: AppPc) => { const p = pendingOf(a); return p === null || Object.keys(p as object).length === 0; };
/** The settings the server keeps, their values only, the resets to the default left out: what each PC's settings.json must hold. */
async function serverValues(l: Lab): Promise<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(await l.settings()).filter(([, r]) => r.value !== null).map(([k, r]) => [k, r.value]));
}
/** Every PC with nothing pending, each settings.json equal to the server's settings. */
async function converged(l: Lab, pcs: AppPc[]): Promise<void> {
  let server: Record<string, unknown> = {};
  await until(async () => {
    server = await serverValues(l);
    return pcs.every((a) => nothingPending(a) && JSON.stringify(sorted(readSettings(a.dir))) === JSON.stringify(sorted(server)));
  }, 8000, () => `serveur ${JSON.stringify(server)} ; ${pcs.map((a) => `${a.name} ${JSON.stringify(readSettings(a.dir))} en attente ${JSON.stringify(pendingOf(a))}`).join(' ; ')}`);
}
const sorted = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

test('sans serveur jumelé, rien ne change : settings.json seul, ni settings-pending.json, ni message, ni requête', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a', { textScale: 1.5 });
  a.host.setSettings({ factor: 3, textScale: null });
  expect(readSettings(a.dir)).toEqual({ factor: 3 });
  // A value the interface would never send is bounded, a key that is no setting ignored, as withOverrides reads them.
  a.host.setSettings({ boxWidth: 10_000, inconnu: 1 });
  expect(readSettings(a.dir)).toEqual({ factor: 3, boxWidth: 400 });
  expect(existsSync(join(a.dir, PENDING_SETTINGS_FILE))).toBe(false);
  expect([a.settingsTold, a.net.requests]).toEqual([[], []]);
});

test('R23 : jumelé vide à un serveur vide, un PC envoie tous ses réglages, datés du jumelage ; dissocié, il ne garde rien en attente', async () => {
  const l = (lab = await Lab.start());
  l.clock = T0 + 1000;
  const a = await joined(l, 'pc-a', { factor: 3, background: 'grid' });
  const pc = pcId(a.dir);
  await until(async () => Object.keys(await l.settings()).length === 2);
  expect(await l.settings()).toEqual({ factor: { value: 3, at: T0 + 1000, pc }, background: { value: 'grid', at: T0 + 1000, pc } });
  await until(() => nothingPending(a));
  expect(readSettings(a.dir)).toEqual({ factor: 3, background: 'grid' });
  // Changed afterwards from the settings: sent, then nothing pending.
  l.clock = T0 + 2000;
  a.host.setSettings({ toastMs: 9000 });
  await until(async () => (await l.settings()).toastMs?.value === 9000);
  await until(() => nothingPending(a));
  // Unpaired: a change stays in settings.json only.
  await a.sync.unpair();
  a.host.setSettings({ toastMs: 8000 });
  expect([readSettings(a.dir).toastMs, existsSync(join(a.dir, PENDING_SETTINGS_FILE))]).toEqual([8000, false]);
});

test('R23 : un PC qui envoie sa base envoie ses réglages, datés du jumelage', async () => {
  const l = (lab = await Lab.start());
  const a = await app(l, 'pc-a', { textScale: 2, latexPackages: ['siunitx'] });
  expect((await a.session.run((s) => createPlan(s, 'Thèse', 'plan'))).ok).toBe(true);
  l.clock = T0 + 5000;
  expect(await a.sync.pair(l.url, l.code('Portable'), 'Portable')).toMatchObject({ ok: false, offer: { kind: 'seed' } });
  // Nothing sent while the user decides (R8).
  expect(await l.settings()).toEqual({});
  l.clock = T0 + 9000;
  expect(await a.sync.first('seed')).toEqual({ ok: true });
  await live(a);
  const pc = pcId(a.dir);
  await until(async () => Object.keys(await l.settings()).length === 2);
  expect(await l.settings()).toEqual({ textScale: { value: 2, at: T0 + 5000, pc }, latexPackages: { value: ['siunitx'], at: T0 + 5000, pc } });
});

test('R25 : settings-pending.json n’est pas une marque ; un PC jumelé qui ne l’a plus prend les réglages du serveur, et n’envoie rien', async () => {
  const l = (lab = await Lab.start());
  const a = await joined(l, 'pc-a', { gridAlpha: 0.1 });
  await converged(l, [a]);
  apps.splice(apps.indexOf(a), 1);
  await a.close();
  // The file lost while paired, settings.json changed meanwhile by hand.
  rmSync(join(a.dir, PENDING_SETTINGS_FILE));
  writeSettings(a.dir, { gridAlpha: 0.1, factor: 3 });
  l.clock = T0 + 7000;
  const a2 = await app(l, 'pc-a');
  await live(a2);
  await until(() => readSettings(a2.dir).factor === undefined);
  expect(readSettings(a2.dir)).toEqual({ gridAlpha: 0.1 });
  expect(a2.net.count('POST', '/settings')).toBe(0);
  expect(await l.settings()).toEqual({ gridAlpha: { value: 0.1, at: T0, pc: pcId(a2.dir) } });
});

test('R23 : un PC qui prend la base du serveur prend ses réglages, les siens écartés, rien d’envoyé', async () => {
  const l = (lab = await Lab.start());
  const a = await joined(l, 'pc-a', { factor: 3, background: 'grid' });
  await until(async () => Object.keys(await l.settings()).length === 2);
  const kept = await l.settings();
  // A reset to the default kept at the server: not in the adopted settings.json.
  await l.putSettings({ textScale: { value: null, at: T0 + 10 } });
  const { pc: b, atStart } = await adopted(l, 'pc-b', { factor: 2, toastMs: 9000, textScale: 2 });
  // The adopted base starts with the server's settings (adoptBase), not the old base's.
  expect(atStart).toEqual({ factor: 3, background: 'grid' });
  expect(readSettings(b.dir)).toEqual({ factor: 3, background: 'grid' });
  // Nothing of B's own was sent: the server's settings are A's, as they were; its settings-pending.json says so.
  expect(b.net.count('POST', '/settings')).toBe(0);
  expect(pendingOf(b)).toEqual({});
  expect(await l.settings()).toEqual({ ...kept, textScale: { value: null, at: T0 + 10, pc: 'observateur' } });
  expect(readSettings(a.dir)).toEqual({ factor: 3, background: 'grid' });
});

test('le plus récent gagne, réglage par réglage, puis l’identifiant du PC ; un changement perdant quitte settings-pending.json', async () => {
  const l = (lab = await Lab.start());
  const a = await joined(l, 'pc-a');
  const { pc: b } = await adopted(l, 'pc-b');
  await l.stopServer();
  await until(() => a.status?.state === 'offline' && b.status?.state === 'offline');
  // Offline both: B earlier, A later, on the same setting; then both at the same time on another.
  l.clock = T0 + 100;
  b.host.setSettings({ factor: 2.5 });
  l.clock = T0 + 200;
  a.host.setSettings({ factor: 3 });
  l.clock = T0 + 300;
  a.host.setSettings({ textScale: 1.5 });
  b.host.setSettings({ textScale: 2 });
  expect(pendingOf(b)).toEqual({ factor: { value: 2.5, at: T0 + 100 }, textScale: { value: 2, at: T0 + 300 } });
  const aWins = pcId(a.dir) > pcId(b.dir);
  await l.startServer();
  await converged(l, [a, b]);
  const scale = aWins ? 1.5 : 2;
  for (const pc of [a, b]) expect(readSettings(pc.dir)).toEqual({ factor: 3, textScale: scale });
  expect(await l.settings()).toEqual({
    factor: { value: 3, at: T0 + 200, pc: pcId(a.dir) }, textScale: { value: scale, at: T0 + 300, pc: pcId(aWins ? a.dir : b.dir) },
  });
  // B's window was told the setting it lost (and A's the one it lost, if any), never one it kept.
  expect(b.settingsTold.flatMap(Object.entries)).toContainEqual(['factor', 3]);
  expect(b.settingsTold.flatMap(Object.entries)).not.toContainEqual(['factor', 2.5]);
  expect((aWins ? b : a).settingsTold.flatMap(Object.entries)).toContainEqual(['textScale', scale]);
  expect((aWins ? a : b).settingsTold.flatMap(Object.entries).filter(([k]) => k === 'textScale')).toEqual([]);
});

test('un réglage changé hors ligne attend dans settings-pending.json, même après un redémarrage, et part au retour ; l’autre PC le reçoit en un lot', async () => {
  const l = (lab = await Lab.start());
  const a = await joined(l, 'pc-a');
  const { pc: b } = await adopted(l, 'pc-b');
  await l.stopServer();
  await until(() => a.status?.state === 'offline');
  l.clock = T0 + 500;
  a.host.setSettings({ toastMs: 9000, background: 'grid' });
  expect(readSettings(a.dir)).toEqual({ toastMs: 9000, background: 'grid' });
  expect(pendingOf(a)).toEqual({ toastMs: { value: 9000, at: T0 + 500 }, background: { value: 'grid', at: T0 + 500 } });
  // The app closed and opened again, still offline: the change still waits.
  const a2 = await reopen(l, a);
  expect(pendingOf(a2)).toEqual({ toastMs: { value: 9000, at: T0 + 500 }, background: { value: 'grid', at: T0 + 500 } });
  const told = b.settingsTold.length;
  await l.startServer();
  await converged(l, [a2, b]);
  expect(readSettings(b.dir)).toEqual({ toastMs: 9000, background: 'grid' });
  // One batch for B's interface: both settings at once.
  expect(b.settingsTold.slice(told)).toEqual([{ toastMs: 9000, background: 'grid' }]);
  expect(a2.settingsTold).toEqual([]);
});

test('un glissement de curseur : seule la dernière valeur de chaque réglage attend, et part en une requête ; un changement fait après en avoir reçu un autre le suit', async () => {
  const l = (lab = await Lab.start());
  const a = await joined(l, 'pc-a');
  const { pc: b } = await adopted(l, 'pc-b');
  // The first send held: what is changed meanwhile waits, one value per setting.
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  a.net.before = (method, path) => (method === 'POST' && path === '/settings' ? gate : undefined);
  const posts = () => a.net.count('POST', '/settings');
  a.host.setSettings({ factor: 2.5 });
  await until(() => posts() === 1);
  for (const f of [2.6, 2.7, 2.8]) a.host.setSettings({ factor: f });
  a.host.setSettings({ textScale: 1.2 });
  // The clock stood still: each change of this PC is later than the one before, by a millisecond.
  expect(pendingOf(a)).toEqual({ factor: { value: 2.8, at: T0 + 3 }, textScale: { value: 1.2, at: T0 } });
  a.net.before = null;
  open();
  await converged(l, [a, b]);
  expect(posts()).toBe(2);
  expect(readSettings(b.dir)).toEqual({ factor: 2.8, textScale: 1.2 });
  // A change from B stamped ahead of this PC's clock, then A's change made after receiving it: A's comes later.
  await l.putSettings({ boxWidth: { value: 300, at: T0 + 60_000 } });
  await until(() => readSettings(a.dir).boxWidth === 300);
  a.host.setSettings({ boxWidth: 200 });
  await converged(l, [a, b]);
  expect([readSettings(a.dir).boxWidth, readSettings(b.dir).boxWidth, (await l.settings()).boxWidth]).toEqual([200, 200, { value: 200, at: T0 + 60_001, pc: pcId(a.dir) }]);
});

test('deux PC finissent avec les mêmes réglages, ceux du serveur, quel que soit l’ordre de leurs changements', async () => {
  const l = (lab = await Lab.start());
  const a = await joined(l, 'pc-a', { gridAlpha: 0.1 });
  const { pc: b } = await adopted(l, 'pc-b', { tagSuggestions: 3 });
  // Online.
  l.clock = T0 + 100;
  a.host.setSettings({ factor: 3 });
  l.clock = T0 + 110;
  b.host.setSettings({ textScale: 1.5 });
  await converged(l, [a, b]);
  // Offline both, each on its side.
  await l.stopServer();
  await until(() => a.status?.state === 'offline' && b.status?.state === 'offline');
  l.clock = T0 + 120;
  a.host.setSettings({ textScale: 2, background: 'grid' });
  l.clock = T0 + 130;
  b.host.setSettings({ factor: 2.5, toastMs: 5000, gridAlpha: 0.2 });
  l.clock = T0 + 140;
  a.host.setSettings({ factor: null });
  // B restarts offline in the meantime.
  const b2 = await reopen(l, b);
  await l.startServer();
  await converged(l, [a, b2]);
  const expected = { textScale: 2, background: 'grid', toastMs: 5000, gridAlpha: 0.2 };
  for (const pc of [a, b2]) expect(sorted(readSettings(pc.dir))).toEqual(sorted(expected));
  expect((await l.settings()).factor).toEqual({ value: null, at: T0 + 140, pc: pcId(a.dir) });
});

test('R24 : une valeur reçue hors de ses bornes y est ramenée, une clé inconnue et une valeur d’un autre genre sont ignorées, au flux comme au branchement', async () => {
  const l = (lab = await Lab.start());
  const a = await joined(l, 'pc-a', { textScale: 1.5 });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const told = a.settingsTold.length;
  await l.putSettings({
    factor: { value: 100, at: T0 + 10 }, starSpacingPx: { value: [700, 1], at: T0 + 10 }, inconnu: { value: 1, at: T0 + 10 }, textScale: { value: 'grand', at: T0 + 10 },
    // Review of task 6, Minor 7: an object for a list.
    groupHues: { value: { teinte: 30 }, at: T0 + 10 },
  });
  await until(() => readSettings(a.dir).factor !== undefined);
  // As withOverrides reads a settings file: the factor to its largest, the interval ordered and bounded.
  const p = withOverrides({ factor: 100, starSpacingPx: [700, 1] });
  expect([p.factor, p.starSpacingPx]).toEqual([4, [5, 600]]);
  expect(readSettings(a.dir)).toEqual({ factor: 4, starSpacingPx: [5, 600], textScale: 1.5 });
  expect(a.settingsTold.slice(told)).toEqual([{ factor: 4, starSpacingPx: [5, 600] }]);
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/textScale/));
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/groupHues/));
  // The same at the next connection, from GET /settings whole.
  const a2 = await reopen(l, a);
  await live(a2);
  expect(readSettings(a2.dir)).toEqual({ factor: 4, starSpacingPx: [5, 600], textScale: 1.5 });
  expect(a2.settingsTold).toEqual([]);
  // What a server could send that this one refuses: a key `__proto__` stays a key (which is no setting), a row of
  // another form is left out.
  const rows = parseSettingRows(JSON.parse('{"__proto__": {"value": 1, "at": 1, "pc": "x"}, "boxWidth": {"value": 300, "at": 1, "pc": "x"}, "factor": 3}'));
  expect([Object.getPrototypeOf(rows), Object.keys(rows)]).toEqual([Object.prototype, ['__proto__', 'boxWidth']]);
});

test('revue, Minor 4 : une heure de réglage est un nombre entier de millisecondes, de 0 à 2^53 − 1, reçue du serveur comme lue de settings-pending.json', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const row = (at: number) => ({ value: 3, at, pc: 'x' });
  expect(Object.keys(parseSettingRows({ a: row(1.5), b: row(2 ** 53), c: row(-1), d: row(1e300), e: row(2 ** 53 - 1), f: row(0) }))).toEqual(['e', 'f']);
  const dir = mkdtempSync(join(tmpdir(), 'cirrus-reglages-'));
  try {
    writeFileSync(join(dir, PENDING_SETTINGS_FILE), JSON.stringify({ factor: { value: 3, at: 1e300 }, boxWidth: { value: 300, at: 1.5 }, textScale: { value: 2, at: T0 } }));
    expect(new SharedSettings(dir, 'pc-a', () => {}).pending()).toEqual({ textScale: { value: 2, at: T0 } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('revue, Minor 5 : un changement local attend dans settings-pending.json avant d’être dans settings.json ; un arrêt entre les deux ne le perd pas', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cirrus-reglages-'));
  try {
    // settings.json cannot be written (a folder holds its place).
    mkdirSync(join(dir, 'settings.json', 'bloque'), { recursive: true });
    expect(() => new SharedSettings(dir, 'pc-a', () => {}).local({ factor: 3 }, { at: T0, latest: T0 + MAX_SETTING_AHEAD_MS })).toThrow();
    expect(JSON.parse(readFileSync(join(dir, PENDING_SETTINGS_FILE), 'utf8'))).toEqual({ factor: { value: 3, at: T0 } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('revue, Minor 6 : un réglage reçu qui ne peut pas être écrit (disque) est dit, la synchro des documents continue, et il est appliqué à la connexion suivante', async () => {
  const l = (lab = await Lab.start());
  const a = await joined(l, 'pc-a');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  mkdirSync(join(a.dir, 'settings.json', 'bloque'), { recursive: true });
  await l.putSettings({ toastMs: { value: 9000, at: T0 + 10 } });
  await until(() => warn.mock.calls.some(([m]) => /Réglages reçus non appliqués/.test(String(m))));
  // The writes still come: a node another PC makes reaches A, which stays live.
  const b = await l.pc('pc-b');
  await until(() => b.store.lastServerSeq() >= 1);
  const lobby = [...b.s.plans.values()][0].id;
  const X = created(b.act((s) => createNode(s, { plan: lobby, title: 'X', x: 0, y: 0, k: 0 })), 'node');
  await until(() => a.session.state.nodes.has(X), 5000, () => JSON.stringify(a.statuses.slice(-3)));
  expect(a.status?.state).toBe('live');
  // The disk free again: the next connection applies it.
  rmSync(join(a.dir, 'settings.json'), { recursive: true });
  const a2 = await reopen(l, a);
  await live(a2);
  await until(() => readSettings(a2.dir).toastMs === 9000);
});

test('revue, Minor 7 : un réglage changé pendant la lecture des réglages du serveur (GET en cours) passe après ce qu’elle rend', async () => {
  const l = (lab = await Lab.start());
  const a = await joined(l, 'pc-a');
  const { pc: b } = await adopted(l, 'pc-b');
  l.clock = T0 + 100;
  b.host.setSettings({ textScale: 1.5 });
  await converged(l, [a, b]);
  // A reconnects (waking), its GET /settings held; meanwhile, the setting changed here.
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  a.net.before = (method, path) => (method === 'GET' && path === '/settings' ? gate : undefined);
  const gets = a.net.count('GET', '/settings');
  await a.host.resume();
  await until(() => a.net.count('GET', '/settings') > gets);
  l.clock = T0 + 200;
  a.host.setSettings({ textScale: 2 });
  const told = a.settingsTold.length;
  a.net.before = null;
  open();
  await converged(l, [a, b]);
  // The server's older value, which the held read gave, was not applied over it.
  expect([readSettings(a.dir).textScale, readSettings(b.dir).textScale]).toEqual([2, 2]);
  expect(a.settingsTold.slice(told).flatMap(Object.entries).filter(([k]) => k === 'textScale')).toEqual([]);
  expect((await l.settings()).textScale).toEqual({ value: 2, at: T0 + 200, pc: pcId(a.dir) });
});

test('revue, Minor 2 : cirrus:settings:set rend les valeurs écrites, que l’interface adopte ; un lot reçu pendant l’envoi ne la laisse pas en retard', async () => {
  const l = (lab = await Lab.start());
  const a = await joined(l, 'pc-a');
  // What is written: bounded, the unknown key left out, null for the default.
  expect(a.host.setSettings({ boxWidth: 10_000, inconnu: 1, textScale: null })).toEqual({ boxWidth: 400, textScale: null });
  // The interface saved factor 2.5 (its timer); before main takes it, a row for factor arrives from the server.
  await l.putSettings({ factor: { value: 3, at: T0 + 10 } });
  await until(() => readSettings(a.dir).factor === 3);
  const message = a.settingsTold.at(-1)!;
  // Main then writes the local change, stamped after the row it has seen: it wins, and its answer says so.
  const written = a.host.setSettings({ factor: 2.5 });
  expect(written).toEqual({ factor: 2.5 });
  // The interface, as App does it: the message (factor 3), then the answer, each a batch over what it saved.
  let saved = withOverrides({ factor: 2.5 }), shown = saved;
  for (const batch of [message, written]) {
    const before = saved;
    saved = applyReceived(before, batch);
    shown = keepUnsaved(shown, before, saved, Object.keys(batch));
  }
  expect(shown.factor).toBe(2.5);
  await converged(l, [a]);
  expect(readSettings(a.dir).factor).toBe(2.5);
});

test('revue, tour 2 (R26) : un PC qui a vu une heure très en avance change encore ce réglage, sans jamais envoyer une heure que le serveur refuse ; ses autres réglages partent', async () => {
  const l = (lab = await Lab.start());
  const a = await joined(l, 'pc-a');
  const { pc: b } = await adopted(l, 'pc-b');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  // Another PC's factor, as far ahead as the server takes (a clock gone wrong before its offset was known).
  const ahead = l.clock + MAX_SETTING_AHEAD_MS;
  await l.putSettings({ factor: { value: 3, at: ahead } });
  await until(() => readSettings(a.dir).factor === 3);
  // A changes it, with another setting: its time is held under the server's bound (less the clock margin), not past it.
  const margin = a.params.syncClockSkewWarnMs;
  a.host.setSettings({ factor: 2.5, toastMs: 9000 });
  expect(pendingOf(a)).toEqual({ factor: { value: 2.5, at: ahead - margin }, toastMs: { value: 9000, at: l.clock } });
  await converged(l, [a, b]);
  // Older than the row it saw, the factor gives way for now; the other setting is taken; nothing was refused.
  for (const pc of [a, b]) expect(readSettings(pc.dir)).toEqual({ factor: 3, toastMs: 9000 });
  expect(warn).not.toHaveBeenCalled();
  // Once the clock has passed the margin, A's change comes after the row, and wins everywhere.
  l.clock += margin + 1;
  a.host.setSettings({ factor: 2.5 });
  await converged(l, [a, b]);
  expect([readSettings(b.dir).factor, (await l.settings()).factor]).toEqual([2.5, { value: 2.5, at: ahead + 1, pc: pcId(a.dir) }]);
});

test('revue, tour 2 : une requête de réglages refusée ne perd pas ses voisins bien formés ; chacun repart seul, seul le refusé est abandonné', async () => {
  const l = (lab = await Lab.start());
  const a = await joined(l, 'pc-a', { factor: 3 });
  await converged(l, [a]);
  // The server full (a paired PC's keys, which no PC takes): the factor is kept there, the text scale would be one too many.
  const junk = (from: number, n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${from + i}`, { value: 1, at: l.clock }]));
  for (let n = 0; n < MAX_SETTINGS_KEPT - 1; n += MAX_SETTINGS_PER_REQUEST) await l.putSettings(junk(n, Math.min(MAX_SETTINGS_PER_REQUEST, MAX_SETTINGS_KEPT - 1 - n)));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const posts = a.net.count('POST', '/settings');
  l.clock += 10;
  a.host.setSettings({ factor: 2.5, textScale: 1.5 });
  await until(() => nothingPending(a));
  // Refused whole; then each alone: the factor taken, the text scale refused, dropped and said.
  expect(a.net.count('POST', '/settings') - posts).toBe(3);
  const kept = await l.settings();
  expect([kept.factor, kept.textScale]).toEqual([{ value: 2.5, at: T0 + 10, pc: pcId(a.dir) }, undefined]);
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/« textScale »/));
  expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/« factor »/));
});

test('l’interface : seuls les réglages changés ici partent ; un lot reçu s’applique d’un coup, sans écraser un réglage changé ici et pas encore écrit', () => {
  const saved = withOverrides({ factor: 3, textScale: 1.5 });
  // Changed here: the factor back to its default, the box width; the rest as saved.
  const now = { ...saved, factor: DEFAULT_PARAMS.factor, boxWidth: 300 };
  expect(localChanges(saved, now)).toEqual({ factor: null, boxWidth: 300 });
  expect(localChanges(saved, saved)).toEqual({});
  expect(localChanges(saved, { ...saved, starSpacingPx: [...saved.starSpacingPx] })).toEqual({});
  // Received: the text scale back to its default, a new background, a box width; bounded as a file read.
  const after = applyReceived(saved, { textScale: null, background: 'grid', boxWidth: 10_000 });
  expect([after.factor, after.textScale, after.background, after.boxWidth]).toEqual([3, DEFAULT_PARAMS.textScale, 'grid', 400]);
  // Nothing changed here since the last save: the received settings, as they are (the same object, nothing written back).
  expect(keepUnsaved(saved, saved, after, ['textScale', 'background', 'boxWidth'])).toBe(after);
  // The box width changed here, not yet written: it stays; the others are received.
  const shown = keepUnsaved(now, saved, after, ['textScale', 'background', 'boxWidth']);
  expect([shown.factor, shown.textScale, shown.background, shown.boxWidth]).toEqual([DEFAULT_PARAMS.factor, DEFAULT_PARAMS.textScale, 'grid', 300]);
  // What is written next: only what changed here.
  expect(localChanges(after, shown)).toEqual({ factor: null, boxWidth: 300 });
  // A key that is no setting (review, Minor 7: own properties only) takes nothing from the prototype.
  expect(Object.hasOwn(keepUnsaved(now, saved, after, ['toString']), 'toString')).toBe(false);
  // A batch that changes nothing (the usual answer to a save, review Minor 2): the saved settings themselves, no render.
  expect(applyReceived(saved, { factor: 3, textScale: 1.5 })).toBe(saved);
});

test('revue, Important 1 : une entrée du bandeau faite juste après un lot reçu, avant son rendu, ne le défait pas', () => {
  // React applies the queued updates in order, each functional one to the state the one before left.
  type Update = RenderParams | ((p: RenderParams) => RenderParams);
  const run = (s: RenderParams, updates: Update[]) => updates.reduce<RenderParams>((p, u) => (typeof u === 'function' ? u(p) : u), s);
  const saved = withOverrides({ factor: 3 });
  // A batch received: the text scale; then, before React renders it, the box width typed in the panel, and a ↺.
  const after = applyReceived(saved, { textScale: 2 });
  const received = (p: RenderParams) => keepUnsaved(p, saved, after, ['textScale']);
  const shown = run(saved, [received, withSetting('boxWidth', 300), withSetting('factor', DEFAULT_PARAMS.factor)]);
  expect([shown.textScale, shown.boxWidth, shown.factor]).toEqual([2, 300, DEFAULT_PARAMS.factor]);
  // Only what was changed here is written: the received setting is not sent back with its old value.
  expect(localChanges(after, shown)).toEqual({ boxWidth: 300, factor: null });
  // A value is bounded as the panel's change always was.
  expect(withSetting('boxWidth', 10_000)(saved).boxWidth).toBe(400);
});

test('revue, tour 2 : la minuterie d’enregistrement n’envoie jamais une valeur qu’un lot reçu a remplacée', () => {
  // The timer was set over `base` (the settings saved then) and the params of its render: the text scale changed here.
  const base = withOverrides({ factor: 3 });
  const params = { ...base, textScale: 1.5 };
  expect(dueChanges(base, base, params)).toEqual({ textScale: 1.5 });
  // A batch arrives before it fires, before React renders it: the factor replaced. Sending now would send factor 3 back.
  const after = applyReceived(base, { factor: 2.5 });
  expect(localChanges(after, params)).toEqual({ factor: 3, textScale: 1.5 });
  // The timer stands down; the batch's render sets it again, over the received factor (keepUnsaved), the text scale kept.
  expect(dueChanges(base, after, params)).toBeNull();
  const next = keepUnsaved(params, base, after, ['factor']);
  expect(dueChanges(after, after, next)).toEqual({ textScale: 1.5 });
});
