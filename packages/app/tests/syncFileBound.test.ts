import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNode, createPlan, MAX_FILE_BYTES } from '@cirrus/core';
import { LocalStore, storeBytes } from '@cirrus/store';
import { afterEach, expect, test, vi } from 'vitest';
import { seedBase } from '../src/main/sync/seed.ts';
import { created, Lab } from './support/virtualPc.ts';

// The largest file the server takes (plan 9, review of task 2, M6): the core's MAX_FILE_BYTES, which the server and the
// PC share — lowered here to 64 Kio for both (the lab's server runs in this process), so that a test file passes it.

vi.mock('@cirrus/core', async (original) => ({ ...(await original<typeof import('@cirrus/core')>()), MAX_FILE_BYTES: 64 * 1024 }));

let lab: Lab | null = null;
afterEach(async () => {
  await lab?.close();
  lab = null;
});

test('M6 : un fichier plus gros que MAX_FILE_BYTES n’est pas envoyé ; l’écriture qui l’ajoute est écartée sur ce PC, avec un message qui dit pourquoi ; les autres passent', async () => {
  expect(MAX_FILE_BYTES).toBe(64 * 1024);
  const l = (lab = await Lab.start());
  const a = await l.pc('pc-a'), b = await l.pc('pc-b');
  const P = created(a.act((s) => createPlan(s, 'P', 'plan')), 'plan');
  await l.settle();
  const big = storeBytes(a.dir, 'énorme.bin', new Uint8Array(100_000).map((_, i) => i % 13));
  const small = storeBytes(a.dir, 'petit.txt', new TextEncoder().encode('petit'));
  const tooBig = created(a.act((s) => createNode(s, { plan: P, title: 'Énorme', x: 0, y: 0, k: 0, files: [big] })), 'node');
  const fine = created(a.act((s) => createNode(s, { plan: P, title: 'Petit', x: 300, y: 0, k: 0, files: [small] })), 'node');
  await l.settle();
  // Never sent, nor asked about: this PC knows the server would refuse it.
  expect(a.net.count('PUT', `/files/${big.hash}`)).toBe(0);
  expect(a.dropped).toEqual([expect.stringMatching(/écartée : Le fichier « énorme\.bin » fait 97,7 Ko, et le serveur en prend 64,0 Ko au plus\.$/)]);
  const server = await l.state();
  expect([server.nodes.has(tooBig), server.nodes.has(fine), b.s.nodes.has(tooBig), b.s.nodes.has(fine), a.s.nodes.has(tooBig)]).toEqual([false, true, false, true, false]);
}, 30_000);

test('M6 : un premier envoi de la base qui tient un fichier plus gros que MAX_FILE_BYTES s’arrête avant toute requête, en le nommant', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cirrus-borne-'));
  const store = LocalStore.open(dir, { pc: 'pc-s' });
  try {
    const plan = createPlan(store.loadState(), 'P', 'plan');
    store.commit(plan);
    const P = (plan.ops.find((op) => op.t === 'plan' && op.before === null) as { after: { id: string } }).after.id;
    const big = storeBytes(dir, 'énorme.bin', new Uint8Array(100_000).map((_, i) => i % 13));
    store.commit(createNode(store.loadState(), { plan: P, title: 'Énorme', x: 0, y: 0, k: 0, files: [big] }));
    const f = vi.fn<typeof fetch>();
    await expect(seedBase({ fetch: f, store, dir, config: { url: 'http://127.0.0.1:7310', token: 't'.repeat(43), name: 'S' }, pairedAt: 0, signal: new AbortController().signal, timeoutMs: 1000 }))
      .rejects.toThrow('Le fichier « énorme.bin » fait 97,7 Ko, et le serveur en prend 64,0 Ko au plus : retire-le de son nœud, puis jumelle ce PC de nouveau.');
    expect(f).not.toHaveBeenCalled();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
