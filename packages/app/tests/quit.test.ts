import { expect, test, vi } from 'vitest';
import { quitInOrder, TypedFields } from '../src/renderer/quit.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A step that records its start and its end, and ends when `release` is called (or fails, `fail`). */
function step(events: string[], name: string, fail = false) {
  let release = () => {};
  const run = () => {
    events.push(`début ${name}`);
    return new Promise<void>((resolve, reject) => {
      release = () => { events.push(`fin ${name}`); if (fail) reject(new Error(`${name} refusé`)); else resolve(); };
    });
  };
  return { run, release: () => release() };
}

test('quitInOrder : le .tex enregistré, puis les champs LaTeX tapés, puis l’instantané, puis la fenêtre libérée (revue finale, I1)', async () => {
  const events: string[] = [];
  const tex = step(events, 'tex'), fields = step(events, 'champs'), snapshot = step(events, 'instantané');
  const done = quitInOrder({ workbench: tex.run, fields: fields.run, snapshot: snapshot.run, consultations: () => {}, ready: () => events.push('prêt'), error: () => {} });
  await tick();
  expect(events).toEqual(['début tex']);
  tex.release();
  await tick();
  expect(events).toEqual(['début tex', 'fin tex', 'début champs']);
  // The snapshot waits for the fields' commits: it must hold their actions.
  fields.release();
  await tick();
  expect(events.at(-1)).toBe('début instantané');
  snapshot.release();
  await done;
  expect(events).toEqual(['début tex', 'fin tex', 'début champs', 'fin champs', 'début instantané', 'fin instantané', 'prêt']);
});

test('quitInOrder : un échec n’arrête pas la suite, et la fenêtre est toujours libérée ; chaque échec est dit', async () => {
  const events: string[] = [], errors: string[] = [];
  const tex = step(events, 'tex', true), fields = step(events, 'champs', true), snapshot = step(events, 'instantané', true);
  const done = quitInOrder({
    workbench: tex.run, fields: fields.run, snapshot: snapshot.run, consultations: () => {}, ready: () => events.push('prêt'),
    error: (what, e) => errors.push(`${what} ${(e as Error).message}`),
  });
  for (const s of [tex, fields, snapshot]) {
    await tick();
    s.release();
  }
  await done;
  expect(events).toEqual(['début tex', 'fin tex', 'début champs', 'fin champs', 'début instantané', 'fin instantané', 'prêt']);
  expect(errors).toEqual([
    'Enregistrement du .tex à la fermeture : tex refusé',
    'Enregistrement d’un champ LaTeX à la fermeture : champs refusé',
    'Instantané à la fermeture : instantané refusé',
  ]);
});

test('TypedFields : un champ en modification est tenu jusqu’à ce qu’il en sorte ; commitAll attend chacun, un échec n’arrête pas les autres', async () => {
  const fields = new TypedFields();
  const events: string[] = [];
  const a = step(events, 'résumé'), b = step(events, 'relation', true);
  const releaseA = fields.hold(a.run);
  fields.hold(b.run);
  const gone = fields.hold(() => { events.push('parti'); return Promise.resolve(); });
  gone();
  expect(fields.size).toBe(2);
  const warn = vi.fn();
  const all = fields.commitAll(warn);
  let finished = false;
  void all.then(() => { finished = true; });
  await tick();
  // One at a time, in the order they started editing: their actions are written in that order.
  expect(events).toEqual(['début résumé']);
  a.release();
  await tick();
  expect(events).toEqual(['début résumé', 'fin résumé', 'début relation']);
  expect(finished).toBe(false);
  b.release();
  await all;
  expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'relation refusé' }));
  // Released (the field left its editor): no longer committed at closing.
  releaseA();
  expect(fields.size).toBe(1);
  // Released twice, or after its release: nothing.
  releaseA();
  expect(fields.size).toBe(1);
});

test('quitInOrder : les consultations sont envoyées avant tout le reste, de façon que même une fermeture forcée pendant l’instantané les ait ; une étape qui lèverait n’arrête rien (plan 6a, D6, tâche 5)', async () => {
  const events: string[] = [], errors: string[] = [];
  const tex = step(events, 'tex'), fields = step(events, 'champs'), snapshot = step(events, 'instantané');
  const done = quitInOrder({
    workbench: tex.run, fields: fields.run, snapshot: snapshot.run, consultations: () => { events.push('consultations'); },
    ready: () => events.push('prêt'), error: (what) => errors.push(what),
  });
  for (const s of [tex, fields, snapshot]) {
    await tick();
    s.release();
  }
  await done;
  expect(events).toEqual(['consultations', 'début tex', 'fin tex', 'début champs', 'fin champs', 'début instantané', 'fin instantané', 'prêt']);
  expect(errors).toEqual([]);
  // A step that throws (it should not: the queue swallows its failures) still lets the others run, and the window go.
  const later: string[] = [];
  await quitInOrder({
    workbench: async () => { later.push('tex'); }, fields: async () => { later.push('champs'); }, snapshot: async () => { later.push('instantané'); },
    consultations: () => { throw new Error('principal cassé'); }, ready: () => later.push('prêt'), error: (what) => later.push(`dit : ${what}`),
  });
  expect(later.filter((x) => !x.startsWith('dit'))).toEqual(['tex', 'champs', 'instantané', 'prêt']);
});
