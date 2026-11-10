import { basename, resolve } from 'node:path';
import { MAX_ID_CHARS } from '@cirrus/core';
import { type LocalStore, storedHashes } from '@cirrus/store';
import { LOBBY_NAME } from '../base.ts';
import type { ServerConfig } from './config.ts';
import { exchange, messageOf, reasonOf, type SyncInit } from './connection.ts';
import type { FirstSyncOffer } from './protocol.ts';

// The first pairing of a base (plan 5a, task 5, D7): what the PC and the server hold decides it — both empty, the sync
// starts; a full PC and an empty server, the PC sends its base (seed); an empty PC and a server holding one, the PC
// takes the server's (adopt), at once when its base is vierge (pristine, after the short review of plan 5a), on the
// user's word otherwise; both full, refused, the replacement of the PC's base proposed (adopt too, its own kept).
// A base taken is staged beside the PC's (`<base>-nouvelle`), complete once its mark is written, last; the app then
// starts again, and the next start swaps it in before the base opens, the old one kept as
// `<base>-avant-jumelage-AAAA-MM-JJ` (R17), or deleted when vierge. Nothing here depends on Electron: the network is
// given.
// Here: what decides it (firstSyncOffer, pristine), and what its parts share; the seed is seed.ts's, the adopt
// adopt.ts's, the swap at the next start swap.ts's, and the pairing that asks them pairing.ts's.

/** What /hello says of the server's base: its last number, whether it is empty (D7), its nodes. */
interface ServerBase { lastSeq: number; empty: boolean; nodes: number }

/** Where a base taken from the server is staged: beside the base, `<base>-nouvelle`. */
export const stagedDir = (dir: string): string => `${resolve(dir)}-nouvelle`;

/** A staged base's mark, written last: without it, the staged base is incomplete. */
export const READY_FILE = 'complete.json';

/** The name the base's folder takes once a base taken from the server replaces it, on `day` (local time). */
export function archiveName(dir: string, day: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${basename(resolve(dir))}-avant-jumelage-${day.getFullYear()}-${two(day.getMonth() + 1)}-${two(day.getDate())}`;
}

/**
 * D7's offer for this base and the server's (null: both empty, the sync starts as it is). This base is empty when it
 * holds nothing (isEmpty) and never received anything from a server: one that did has lines another server numbered.
 * The server holds no base when it accepted no write and its state is empty: a server holding only another PC's lobby
 * holds one (R7: an empty PC takes it, rather than bring a second lobby). Counts the nodes and the store's files: a
 * pairing's cost, never paid otherwise. A vierge base (pristine) is not asked its offer « adopt »: it takes the
 * server's base at once (Pairing.pairNow).
 */
export function firstSyncOffer(store: LocalStore, dir: string, server: ServerBase, day: Date): FirstSyncOffer | null {
  const empty = store.isEmpty() && store.lastServerSeq() === 0;
  if (server.lastSeq === 0 && server.empty) return empty ? null : { kind: 'seed', nodes: store.nodeCount(), files: storedHashes(dir).length };
  const archive = archiveName(dir, day);
  return empty ? { kind: 'adopt', nodes: server.nodes, archive } : { kind: 'replace', nodes: server.nodes, local: store.nodeCount(), archive };
}

/**
 * Whether this base is vierge (after the short review of plan 5a, 2026-11-09: the user keeps one base, and « la base
 * de donnée vide locale que crée un nouveau PC pas encore jumelé n'a aucune raison d'être envoyée au serveur »): as its
 * first opening made it, nothing since — empty in D7's sense (isEmpty), never given anything by a server, its journal
 * the one line openBase writes (the lobby's creation, pending), its store without a file. It holds nothing of the
 * user's: facing a server that holds a base, it takes it without an offer, and the swap deletes it rather than keep it
 * aside. An empty base that was used is not vierge: it keeps the offer and its archive. Costs a few index lookups, one
 * journal line and a listing of the store's folder: a pairing's, or a swap's.
 */
export function pristine(store: LocalStore, dir: string): boolean {
  if (!store.isEmpty() || store.lastServerSeq() !== 0 || store.lastSeq() !== 1) return false;
  const [line] = store.changesSince(0, 1), { op } = line;
  return line.kind === 'local' && line.serverSeq === null && !line.superseded
    && op.t === 'plan' && op.before === null && op.after?.type === 'lobby' && op.after.name === LOBBY_NAME
    && storedHashes(dir).length === 0;
}

/** The offer's explanation, in French (the block « Serveur » adds its buttons). */
export function offerMessage(o: FirstSyncOffer): string {
  switch (o.kind) {
    case 'seed': return 'Le serveur ne tient encore aucune base : ce PC peut lui envoyer la sienne, avec son historique et ses fichiers.';
    case 'adopt': return 'Le serveur tient déjà une base : ce PC peut la prendre. Cirrus redémarre alors sur elle ; la base actuelle de ce PC est gardée à part.';
    case 'replace': return 'Ce PC et le serveur tiennent chacun une base : Cirrus ne fusionne pas deux bases, le jumelage est refusé. Seule la base du serveur peut remplacer celle de ce PC, qui est alors gardée à part.';
  }
}

/** A reason as a sentence of a message: its full stop. */
export const sentence = (text: string): string => (/[.!?…]$/.test(text) ? text : `${text}.`);

/**
 * The server's requests for one first sync: its token on each, one abort for all, each within `timeoutMs`
 * (syncRequestTimeoutMs, plan 9, D7: connection.ts's exchange), or `o.timeoutMs` — a transfer's idleness for the files,
 * the snapshot and the journal's pages (`transfer`), which a slow line may take long to carry; a refused one throws its
 * reason, but the statuses `answered` lets through.
 */
export function requests(fetchFn: typeof fetch, config: ServerConfig, signal: AbortSignal, timeoutMs: number) {
  type Options = { answered?: number[]; transfer?: boolean; timeoutMs?: number };
  const send = async (path: string, init: SyncInit = {}, o: Options = {}): Promise<Response> => {
    let res: Response;
    try {
      res = await exchange(fetchFn, config.url + path, path, { ...init, headers: { Authorization: `Bearer ${config.token}`, ...init.headers } }, {
        signal, timeoutMs: o.timeoutMs ?? timeoutMs, transfer: o.transfer,
      });
    } catch (e) {
      if (signal.aborted) throw new Error('Cirrus se ferme.');
      throw new Error(`Serveur injoignable (${config.url}) : ${sentence(messageOf(e))}`);
    }
    if (res.ok || o.answered?.includes(res.status)) return res;
    throw new Error(await reasonOf(res, path));
  };
  const json = async (path: string, body?: unknown, o: Options = {}): Promise<unknown> => {
    const init = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) };
    return (await send(path, init, o)).json();
  };
  return { send, json };
}

/** R15: this PC's token revoked by itself (POST /unpair), within `ms`; at best — a server gone keeps it until `revoquer`. */
export async function revokeSelf(fetchFn: typeof fetch, config: ServerConfig, ms: number): Promise<boolean> {
  try {
    const res = await fetchFn(`${config.url}/unpair`, { method: 'POST', headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(ms) });
    await res.body?.cancel();
    return res.ok;
  } catch (e) {
    console.warn(`Jeton de ce PC non révoqué au serveur (${config.url}) : ${messageOf(e)}`);
    return false;
  }
}

/**
 * An identity of the server's base (R31) as a PC takes it from an answer: text of 1 to MAX_ID_CHARS characters. The
 * same check for a write's identifier from the interface (SyncHost.commit: re-review of the fixes, N6).
 */
export const isBaseId = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= MAX_ID_CHARS;
