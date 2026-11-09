import { existsSync, readFileSync } from 'node:fs';
import { createNode, editNode, type FileRef, type Id, isCopyOf } from '@cirrus/core';
import { filePath, storeBytes } from '@cirrus/store';
import { afterEach, expect, test, vi } from 'vitest';
import { storeText } from '../src/main/files.ts';
import { saveTex, type SaveAnswer, SaveScheduler, type SaveState } from '../src/renderer/ui/latex/saveScheduler.ts';
import { AppPc } from './support/appPc.ts';
import { Lab, until } from './support/virtualPc.ts';

// A .tex changed elsewhere while its full screen is open (plan 5b, task 5, D6), the full screen's part that runs without
// a window: its SaveScheduler, as TexWorkbench makes it, over the app's session (AppPc), which the synchronisation
// reconciles; a virtual PC changes the .tex. The window's own part (the editor's text, the banner, the notifications) is
// played by the interface's suite (scripts/interface.mjs, TWO_PCS).

const MAX = 200 * 2 ** 20;
const TEX = 'note.tex';
const bytes = (text: string) => new TextEncoder().encode(text);

let lab: Lab | null = null;
const apps: AppPc[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const a of apps.splice(0)) await a.close();
  await lab?.close();
  lab = null;
});

test('le .tex changé par la synchronisation pendant qu’il est ouvert : rien de non enregistré, la nouvelle version est chargée ; du texte tapé reste, le bandeau le dit, et l’enregistrement écrit les deux versions en une action, qu’un Ctrl+Z défait', async () => {
  const l = (lab = await Lab.start());
  const a = new AppPc(l, 'pc-a');
  apps.push(a);
  await a.open();
  expect(await a.sync.pair(l.url, l.code('Portable'), 'Portable')).toEqual({ ok: true });
  await until(() => a.status?.state === 'live', 5000, () => JSON.stringify(a.statuses));
  const v = await l.pc('pc-v');
  // The app makes a node holding note.tex (v0); the virtual PC receives it.
  const lobby = [...a.session.state.plans.values()][0].id, v0 = storeText(a.dir, TEX, '\\section{v0}\n', MAX);
  const made = await a.session.run((s) => createNode(s, { plan: lobby, title: 'Note', x: 0, y: 0, k: 0, files: [v0] }));
  if (!made.ok) throw new Error(made.message);
  const node = (made.action.ops.find((o) => o.t === 'node') as { after: { id: Id } }).after.id;
  await until(() => v.s.nodes.get(node)?.files[0]?.hash === v0.hash, 5000);
  const fileOf = (): FileRef => a.session.state.nodes.get(node)!.files.find((f) => f.name === TEX)!;
  const textOf = (f: FileRef) => readFileSync(filePath(a.dir, f), 'utf8');
  /** A version of note.tex written by the virtual PC, arrived in the app's state, its bytes downloaded. */
  const changedThere = async (text: string): Promise<FileRef> => {
    const ref = storeBytes(v.dir, TEX, bytes(text));
    v.act((s) => editNode(s, node, { files: s.nodes.get(node)!.files.map((f) => (f.name === TEX ? ref : f)) }));
    await until(() => fileOf().hash === ref.hash && existsSync(filePath(a.dir, ref)), 5000);
    return ref;
  };
  // The full screen's scheduler, as TexWorkbench makes it: over the file's text, from its version.
  const answers: SaveAnswer[] = [];
  const timers = { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  const s = new SaveScheduler(textOf(v0), async (text, base) => {
    const r = await saveTex(a.session, async (name, t) => storeText(a.dir, name, t, MAX), node, TEX, text, base);
    answers.push(r);
    return r;
  }, timers, () => 10_000, v0.hash);
  let state: SaveState | null = null;
  s.onState((st) => { state = st; });

  // Nothing unsaved: the version from elsewhere is to be loaded, then is the text and the base.
  const v1 = await changedThere('\\section{v1}\n');
  expect(s.arrived(fileOf())).toBe('reload');
  expect(s.reloaded(textOf(fileOf()), fileOf().hash)).toBe(true);
  expect([s.dirty, state!.elsewhere]).toEqual([false, false]);
  expect(s.arrived(fileOf())).toBeNull();

  // Typed here, then changed there again: the text stays, and the banner says that version will be kept.
  s.edit('\\section{ici}\n');
  const v2 = await changedThere('\\section{v2}\n');
  expect(s.arrived(fileOf())).toBeNull();
  expect([s.dirty, state!.elsewhere]).toEqual([true, true]);
  const before = a.session.state.nodes.get(node)!.files, seq = a.store.lastSeq();
  // Saved: the typed text under the name, v2 under its conflict name, in one action; the answer names the copy.
  await s.flush();
  expect([s.dirty, state!.elsewhere]).toEqual([false, false]);
  const kept = answers.at(-1)!.kept!;
  expect(isCopyOf(kept, TEX)).toBe(true);
  const files = a.session.state.nodes.get(node)!.files;
  expect(files.map((f) => f.name)).toEqual([TEX, kept]);
  expect(textOf(files[0])).toBe('\\section{ici}\n');
  expect(files[1]).toEqual({ ...v2, name: kept });
  const lines = a.store.changesSince(seq);
  expect(new Set(lines.map((r) => r.actionId)).size).toBe(1);
  expect(v1.hash).not.toBe(v2.hash);
  // The virtual PC receives both.
  await until(() => v.s.nodes.get(node)!.files.length === 2, 5000);
  // A Ctrl+Z of that save: both files as before it, here and on the virtual PC.
  expect((await a.session.undo()).ok).toBe(true);
  expect(a.session.state.nodes.get(node)!.files).toEqual(before);
  await until(() => JSON.stringify(v.s.nodes.get(node)!.files) === JSON.stringify(before), 5000);
});
