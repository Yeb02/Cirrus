import { type Id, isObject, type Op, type Reconciliation, type RemoteUnit, SyncDivergedError, type Unit } from '@cirrus/core';
import type { HostDeps } from './host.ts';
import type { ReconcileOutcome } from './protocol.ts';

// The reconciliation's round trip through the interface, which holds the state (plan 5a, task 4): the writes the client
// received sent to the page (cirrus:sync:incoming), its answer checked then written by the base (cirrus:sync:reconciled),
// and what a page held abandoned once it goes away (R13). SyncHost's: the IPC calls it through the host.

export class Reconciliations {
  /**
   * The page holds its state and listens (cirrus:sync:start), since its last going away (detach): a reconciliation sent
   * otherwise would reach no one, and the client would wait for it for ever (R13).
   */
  ready = false;
  private readonly deps: Pick<HostDeps, 'store' | 'pc' | 'window'>;
  private nextId = 0;
  /** The reconciliations sent to the interface, awaiting its answer. */
  private readonly waiting = new Map<number, { incoming: RemoteUnit[]; resolve(): void; reject(e: unknown): void }>();

  constructor(deps: Pick<HostDeps, 'store' | 'pc' | 'window'>) {
    this.deps = deps;
  }

  /**
   * The client's reconcile (task 3): the writes received sent to the interface, which reconciles them on its state; once
   * the base has written its reconciliation (`reconciled`), resolved. Rejected with SyncDivergedError when the
   * interface's reconcile threw it, with an Error for any other failure, or at once without a window, or a page, ready to
   * answer (R13).
   */
  reconcile(incoming: RemoteUnit[], refused: { unit: Id; message: string }[]): Promise<void> {
    // A page loading (or none): rejected at once, the client tries again later, and the new page asks to start.
    if (!this.ready) return Promise.reject(new Error('Interface pas prête : réconciliation remise à plus tard.'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.waiting.set(id, { incoming, resolve, reject });
      if (!this.deps.window.incoming({ id, units: incoming, refused })) {
        this.waiting.delete(id);
        reject(new Error('Fenêtre absente : réconciliation remise à plus tard.'));
      }
    });
  }

  /**
   * The interface's answer to reconciliation `id` (cirrus:sync:reconciled). A reconciliation is checked — its received
   * writes those the server sent, the others well formed —, then written by the base, every "before" checked, in one
   * transaction: its journal number, the client's reconcile resolved. Null for a failure the interface reports. An
   * unknown identifier, or a reconciliation the base refuses, throws (the interface then reads its state again).
   */
  reconciled(id: number, outcome: ReconcileOutcome): number | null {
    const w = this.waiting.get(id);
    if (!w) throw new Error('Réconciliation inconnue ou abandonnée : rien n’est écrit.');
    this.waiting.delete(id);
    if (isObject(outcome) && 'diverged' in outcome) {
      w.reject(new SyncDivergedError(String(outcome.diverged)));
      return null;
    }
    if (!isObject(outcome) || !('reconciliation' in outcome)) {
      w.reject(new Error(isObject(outcome) && 'error' in outcome ? String(outcome.error) : 'Réponse de l’interface illisible.'));
      return null;
    }
    try {
      const seq = this.deps.store.applyReconciliation(this.checked(outcome.reconciliation, w.incoming));
      w.resolve();
      return seq;
    } catch (e) {
      w.reject(e);
      throw e;
    }
  }

  /**
   * A reconciliation as the base may write it: the received writes are this process's own copy of what the server sent
   * (the interface names the same, in order, by identifier and number); the replayed writes this PC's, as the base will
   * keep them. Their
   * operations are checked by the base as it writes them (checkRecord, each "before"), not by the server's stricter
   * parseOp: a write the server refuses must still be undone here, and dropped. Costs the lists' lengths.
   */
  private checked(r: unknown, incoming: RemoteUnit[]): Reconciliation {
    const bad = (why: string): never => { throw new Error(`Réconciliation incohérente : ${why}.`); };
    if (!isObject(r)) return bad('ce n’est pas un objet');
    const { rewind, remote, rebased, dropped, acked, notices } = r;
    if (![rewind, remote, rebased, dropped, acked, notices].every(Array.isArray)) bad('une de ses listes manque');
    const theirs = remote as unknown[];
    if (theirs.length !== incoming.length || !theirs.every((u, i) => isObject(u) && u.unit === incoming[i].unit && u.seq === incoming[i].seq)) {
      bad('les écritures reçues ne sont pas celles du serveur');
    }
    if (!(acked as unknown[]).every((u) => typeof u === 'string')) bad('un accusé n’est pas un identifiant');
    const unit = (u: unknown): boolean => isObject(u) && [u.unit, u.action, u.label].every((x) => typeof x === 'string') && Number.isFinite(u.at)
      && u.pc === this.deps.pc && Array.isArray(u.ops) && (u.ops as unknown[]).every(isObject);
    if (!(rebased as unknown[]).every(unit)) bad('une écriture rejouée est mal formée, ou n’est pas de ce PC');
    if (!(rewind as unknown[]).every(isObject)) bad('un inverse n’est pas une opération');
    return { rewind: rewind as Op[], remote: incoming, rebased: rebased as Unit[], dropped: dropped as Reconciliation['dropped'], acked: acked as Id[], notices: notices as string[] };
  }

  /**
   * The window is gone (closed, its page reloaded or crashed): the reconciliations it held rejected, so that stop() never
   * waits for them; none sent until a page asks to start again (R13).
   */
  detach(): void {
    this.ready = false;
    const waiting = [...this.waiting.values()];
    this.waiting.clear();
    for (const w of waiting) w.reject(new Error('Fenêtre fermée : réconciliation abandonnée.'));
  }
}
