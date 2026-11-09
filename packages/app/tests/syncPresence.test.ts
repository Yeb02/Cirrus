import { MAX_ID_CHARS } from '@cirrus/core';
import { afterEach, expect, test, vi } from 'vitest';
import { AppPc } from './support/appPc.ts';
import { Lab, sleep, T0, until } from './support/virtualPc.ts';

// « .tex ouvert ailleurs » on the PC (plan 5b, task 5, D6): the .tex this PC has open in full screen, kept by its main
// process (SyncHost.texOpened, texClosed), sent to the server at each change while connected and at each connection
// (SyncClient.presence, PUT /presence); opening one that another PC has open names that PC. A server in the process
// (Lab), the app's PC without Electron (AppPc), and a virtual PC that sends its own list.

let lab: Lab | null = null;
const apps: AppPc[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const a of apps.splice(0)) await a.close();
  await lab?.close();
  lab = null;
});

/** The app's PC paired as « Portable », live. */
async function pairedApp(l: Lab): Promise<AppPc> {
  const a = new AppPc(l, 'pc-a');
  apps.push(a);
  await a.open();
  expect(await a.sync.pair(l.url, l.code('Portable'), 'Portable')).toEqual({ ok: true });
  await until(() => a.status?.state === 'live', 5000, () => JSON.stringify(a.statuses));
  return a;
}

test('un .tex ouvert sur un autre PC : son nom et son heure ; ouvert ici, l’autre PC l’apprend ; fermé, il ne l’apprend plus ; les noms comparés comme au réimport', async () => {
  const l = (lab = await Lab.start());
  const a = await pairedApp(l);
  const v = await l.pc('pc-v', { presence: true });
  await until(() => v.status?.state === 'live');
  // The virtual PC opens complexité.tex: nobody else has it.
  v.openTex.push({ node: 'n1', name: 'complexité.tex' });
  expect(await v.client.presence()).toEqual([]);
  // The app opens it a minute later, spelled otherwise: the virtual PC's name, and since when on this PC's clock.
  l.clock += 60_000;
  expect(await a.host.texOpened('n1', 'Complexité.TEX')).toEqual({ pc: 'PC-V', since: T0 });
  // Another file of the node, or the same name in another node: no other PC.
  expect(await a.host.texOpened('n1', 'autre.tex')).toBeNull();
  expect(await a.host.texOpened('n2', 'complexité.tex')).toBeNull();
  // The virtual PC hears of the app's, under its name at the server.
  expect(await v.client.presence()).toEqual([{ node: 'n1', name: 'Complexité.TEX', pc: 'Portable', since: T0 + 60_000 }]);
  // Closed by the app: the virtual PC no longer hears of it.
  a.host.texClosed('n1', 'Complexité.TEX');
  await until(async () => (await v.client.presence())?.length === 0, 5000);
  // A name or a node that is not one: nothing kept, nothing asked.
  const before = a.net.count('PUT', '/presence');
  for (const [node, name] of [['n1', 'a/b.tex'], ['', 'a.tex'], ['n'.repeat(MAX_ID_CHARS + 1), 'a.tex'], [3, 'a.tex'], ['n1', null]] as [unknown, unknown][]) {
    expect(await a.host.texOpened(node, name)).toBeNull();
    a.host.texClosed(node, name);
  }
  expect(a.net.count('PUT', '/presence')).toBe(before);
});

test('la liste renvoyée au branchement : hors ligne, ouvrir ne dit rien et n’attend pas ; le serveur revenu, il a la liste de ce moment-là', async () => {
  const l = (lab = await Lab.start());
  const a = await pairedApp(l);
  const v = await l.pc('pc-v', { presence: true });
  await until(() => v.status?.state === 'live');
  expect(await a.host.texOpened('n1', 'a.tex')).toBeNull();
  // The server stopped: the app opens b.tex and closes a.tex, offline; nothing waits on the network.
  await l.stopServer();
  await until(() => a.status?.state === 'offline');
  const t0 = Date.now();
  expect(await a.host.texOpened('n2', 'b.tex')).toBeNull();
  expect(Date.now() - t0).toBeLessThan(100);
  a.host.texClosed('n1', 'a.tex');
  // Back: at its connection the app sends what it has open then — b.tex, no longer a.tex.
  await l.startServer();
  await until(() => a.status?.state === 'live' && v.status?.state === 'live', 5000, () => JSON.stringify([a.status, v.status]));
  v.openTex.push({ node: 'n1', name: 'a.tex' }, { node: 'n2', name: 'b.tex' });
  await until(async () => JSON.stringify(await v.client.presence()) === JSON.stringify([{ node: 'n2', name: 'b.tex', pc: 'Portable', since: T0 }]), 5000);
});

test('un PC arrêté sans fermer son .tex le laisse « ouvert » jusqu’à son prochain branchement, qui envoie sa liste', async () => {
  const l = (lab = await Lab.start());
  const a = await pairedApp(l);
  const v = await l.pc('pc-v', { presence: true });
  await until(() => v.status?.state === 'live');
  v.openTex.push({ node: 'n1', name: 'a.tex' });
  expect(await v.client.presence()).toEqual([]);
  // Stopped with a.tex open (a laptop closed): still « open » for the app.
  await v.client.stop();
  expect(await a.host.texOpened('n1', 'a.tex')).toEqual({ pc: 'PC-V', since: T0 });
  a.host.texClosed('n1', 'a.tex');
  // Back, without it: its list at its connection drops it.
  v.openTex.length = 0;
  v.client.start();
  await until(() => v.status?.state === 'live');
  await until(async () => (await a.host.texOpened('n1', 'a.tex')) === null, 5000);
});

test('les envois l’un après l’autre : le serveur finit avec la dernière liste, même quand la première requête traîne', async () => {
  const l = (lab = await Lab.start());
  const a = await pairedApp(l);
  const v = await l.pc('pc-v', { presence: true });
  await until(() => v.status?.state === 'live');
  // The first PUT held 100 ms: a second sent meanwhile must not be overtaken by it.
  let first = true;
  a.net.before = async (method, path) => {
    if (method === 'PUT' && path === '/presence' && first) {
      first = false;
      await sleep(100);
    }
  };
  const opened = a.host.texOpened('n1', 'a.tex');
  a.host.texClosed('n1', 'a.tex');
  const reopened = a.host.texOpened('n2', 'b.tex');
  await Promise.all([opened, reopened]);
  await sleep(50);
  v.openTex.push({ node: 'n1', name: 'a.tex' }, { node: 'n2', name: 'b.tex' });
  expect(await v.client.presence()).toEqual([{ node: 'n2', name: 'b.tex', pc: 'Portable', since: T0 }]);
});

test('la page rechargée ou la fenêtre fermée oublie ses .tex ouverts, et le serveur l’apprend ; non jumelé, rien n’est envoyé', async () => {
  const l = (lab = await Lab.start());
  const a = await pairedApp(l);
  const v = await l.pc('pc-v', { presence: true });
  await until(() => v.status?.state === 'live');
  v.openTex.push({ node: 'n1', name: 'a.tex' });
  await a.host.texOpened('n1', 'a.tex');
  expect(await v.client.presence()).toEqual([{ node: 'n1', name: 'a.tex', pc: 'Portable', since: T0 }]);
  // The page reloaded (detach): its full screen gone.
  await a.reload();
  await until(async () => (await v.client.presence())?.length === 0, 5000);
  // Open again, then the window closed and the app quitting: the list emptied before the client stops.
  await a.host.texOpened('n1', 'a.tex');
  expect(await v.client.presence()).toHaveLength(1);
  await a.close();
  apps.splice(apps.indexOf(a), 1);
  expect(await v.client.presence()).toEqual([]);
  // A PC not paired keeps its list but sends nothing.
  const b = new AppPc(l, 'pc-b');
  apps.push(b);
  await b.open();
  expect(await b.host.texOpened('n1', 'a.tex')).toBeNull();
  b.host.texClosed('n1', 'a.tex');
  expect(b.net.requests).toEqual([]);
});
