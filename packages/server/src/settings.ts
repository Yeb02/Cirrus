import { isObject, isSettingTime } from '@cirrus/core';
import { MAX_SETTING_AHEAD_MS, MAX_SETTING_KEY_CHARS, MAX_SETTING_VALUE_BYTES, MAX_SETTINGS_PER_REQUEST } from './bounds.ts';

// The shared settings' requests (plan 5a, task 6, D9, R24): POST /settings { changes: { [key]: { value, at } } }, its
// form checked whole before anything is written. The values are the PCs' business: each bounds what it receives.

/** A refused POST /settings: its body is not one, or it would have the server keep too many settings (400), in French. */
export class SettingsError extends Error {
  readonly status = 400;
}

/** A change as serveur.db keeps it: its value's JSON (null: back to the default), its time. */
export interface StoredChange { json: string | null; at: number }

const KEY = new RegExp(`^[A-Za-z][A-Za-z0-9_]{0,${MAX_SETTING_KEY_CHARS - 1}}$`);

/**
 * The changes of a POST /settings body, by key, or SettingsError for the first thing wrong: a body other than
 * `{ changes }`; more than MAX_SETTINGS_PER_REQUEST keys; a key that is not a plain identifier of MAX_SETTING_KEY_CHARS
 * at most; a change other than `{ value, at }`, its time not whole milliseconds from 0 to 2^53 − 1, or past `latest`
 * (the server's clock plus MAX_SETTING_AHEAD_MS, R26), its value's JSON over MAX_SETTING_VALUE_BYTES. Costs the body's
 * size.
 */
export function parseSettingChanges(body: unknown, latest: number): Map<string, StoredChange> {
  const bad = (why: string): never => { throw new SettingsError(why); };
  if (!isObject(body) || !isObject(body.changes) || Object.keys(body).length !== 1) return bad('Corps attendu : { changes: { <réglage>: { value, at } } }.');
  const entries = Object.entries(body.changes);
  if (entries.length > MAX_SETTINGS_PER_REQUEST) bad(`Au plus ${MAX_SETTINGS_PER_REQUEST} réglages par requête.`);
  const out = new Map<string, StoredChange>();
  for (const [key, change] of entries) {
    const name = key.slice(0, MAX_SETTING_KEY_CHARS);
    if (!KEY.test(key)) bad(`Nom de réglage invalide (« ${name} ») : une lettre, puis des lettres, des chiffres ou _, ${MAX_SETTING_KEY_CHARS} au plus.`);
    if (!isObject(change) || !('value' in change) || Object.keys(change).length !== 2) bad(`Réglage « ${name} » : { value, at } attendu.`);
    const { value, at } = change as { value: unknown; at: unknown };
    if (!isSettingTime(at)) bad(`Réglage « ${name} » : son heure n’est pas un nombre entier de millisecondes, de 0 à 2^53 − 1.`);
    if ((at as number) > latest) bad(`Réglage « ${name} » : son heure est en avance de plus de ${MAX_SETTING_AHEAD_MS / 3_600_000} h sur celle du serveur.`);
    const json = value === null ? null : JSON.stringify(value);
    if (json !== null && Buffer.byteLength(json) > MAX_SETTING_VALUE_BYTES) bad(`Réglage « ${name} » : valeur de plus de ${MAX_SETTING_VALUE_BYTES} octets.`);
    out.set(key, { json, at: at as number });
  }
  return out;
}
