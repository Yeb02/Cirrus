import { applyOps, createPlan, emptyState, type Id, invertAction } from '@cirrus/core';
import { expect, test } from 'vitest';
import { liveTabs } from '../src/renderer/tabs.ts';

const created = (ops: { t: string; after?: unknown }[]) => (ops[0].after as { id: Id }).id;

test('onglets : le plan affiché disparu (création de plan annulée), son onglet s’en va et le lobby s’affiche (F4)', () => {
  const s = emptyState();
  const lobbyAction = createPlan(s, 'Lobby', 'lobby');
  applyOps(s, lobbyAction.ops);
  const lobby = created(lobbyAction.ops);
  const kept = createPlan(s, 'Gardé', 'plan');
  applyOps(s, kept.ops);
  const made = createPlan(s, 'Nouveau', 'plan');
  applyOps(s, made.ops);
  const keptId = created(kept.ops), madeId = created(made.ops);
  const open = [keptId, madeId];
  // Nothing gone: the same tabs, the same arrays.
  const same = liveTabs(s.plans, open, madeId);
  expect(same.open).toBe(open);
  expect(same.active).toBe(madeId);
  // Ctrl+Z of the creation while its tab is shown.
  applyOps(s, invertAction(made).ops);
  expect(liveTabs(s.plans, open, madeId)).toEqual({ open: [keptId], active: lobby });
  // Shown elsewhere: its tab goes, the active one stays.
  expect(liveTabs(s.plans, open, keptId)).toEqual({ open: [keptId], active: keptId });
});
