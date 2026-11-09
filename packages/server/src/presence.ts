import { type Id, isObject, plainName } from '@cirrus/core';
import { MAX_ID_CHARS, MAX_PRESENCE_ENTRIES } from './bounds.ts';

// « .tex ouvert ailleurs » (plan 5b, task 5, D6): PUT /presence { open: [{ node, name }] }, the files a PC has open in
// full screen, its body checked whole before anything is written. serveur.db keeps them (tokens.ts).

/** A refused PUT /presence: its body is not one (400), in French. */
export class PresenceError extends Error {
  readonly status = 400;
}

/** A file open in full screen on a PC: its node, its name as that PC spells it. */
export interface OpenFile { node: Id; name: string }

/** The same file open on another PC, as PUT /presence answers it: that PC's name (`jumeler`'s), since when (the server's clock). */
export interface OpenElsewhere { node: Id; name: string; pc: string; since: number }

/**
 * The files of a PUT /presence body, or PresenceError for the first thing wrong: a body other than `{ open }`, `open` not
 * a list, more than MAX_PRESENCE_ENTRIES of them, an entry other than `{ node, name }` — its node an identifier of 1 to
 * MAX_ID_CHARS characters, its name a plain file name (the core's plainName: no folder, no stream, nothing Windows
 * reserves). Costs the body's size.
 */
export function parsePresence(body: unknown): OpenFile[] {
  const bad = (why: string): never => { throw new PresenceError(why); };
  if (!isObject(body) || !Array.isArray(body.open) || Object.keys(body).length !== 1) return bad('Corps attendu : { open: [{ node, name }] }, les fichiers ouverts en plein écran sur ce PC.');
  const open = body.open as unknown[];
  if (open.length > MAX_PRESENCE_ENTRIES) bad(`Au plus ${MAX_PRESENCE_ENTRIES} fichiers ouverts par PC.`);
  return open.map((e, i) => {
    if (
      !isObject(e) || Object.keys(e).length !== 2 || typeof e.node !== 'string' || e.node.length === 0 || e.node.length > MAX_ID_CHARS
      || typeof e.name !== 'string' || !plainName(e.name)
    ) {
      return bad(`Fichier ouvert ${i + 1} : { node, name } attendus, l’identifiant de son nœud (1 à ${MAX_ID_CHARS} caractères) et un nom de fichier simple.`);
    }
    return { node: e.node, name: e.name };
  });
}
