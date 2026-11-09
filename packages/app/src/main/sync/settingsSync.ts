import { MAX_SETTINGS_PER_REQUEST, type SettingChange, type SettingRow } from '@cirrus/core';
import { parseSettingRows } from '../settings.ts';
import { type Connection, JSON_BODY, json, messageOf, reasonOf, Refusal } from './connection.ts';

// The settings shared through the server (plan 5a, task 6, D9), as the sync client carries them: the server's read
// whole at each connection, those changed elsewhere received by its stream (event `settings`), this PC's sent before
// its writes. This PC's side of them, settings.json and the changes waiting, is main/settings.ts's SharedSettings.

/** What the client asks of this PC's shared settings (task 6, D9). */
export interface SettingsSync {
  /** The changes made here that the server has not answered for, by key, none stamped past `latest` (R26). */
  pending(latest: number): Record<string, SettingChange>;
  /** Settings the server gave: `whole`, all it keeps (GET /settings); otherwise some (its stream). */
  receive(rows: Record<string, SettingRow>, whole: boolean): void;
  /** The server's answer to the changes `sent`: the setting as kept there now, for each key sent. */
  acknowledge(sent: Record<string, SettingChange>, rows: Record<string, SettingRow>): void;
}

/**
 * Settings the server gave, handed to this PC's (receive, acknowledge). A failure there — the disk refusing
 * settings.json — is only said: a setting is never worth stopping the writes, and the next connection's whole read
 * applies them again (review of task 6, Minor 6).
 */
function applySettings(apply: () => void): void {
  try {
    apply();
  } catch (e) {
    console.warn(`Réglages reçus non appliqués : ${messageOf(e)}`);
  }
}

/** All the settings the server keeps (GET /settings, at each connection), handed to this PC's; unreadable, a Refusal. */
export function receiveAllSettings(shared: SettingsSync, rows: unknown): void {
  let settings: Record<string, SettingRow>;
  try {
    settings = parseSettingRows(rows);
  } catch (e) {
    throw new Refusal(messageOf(e));
  }
  applySettings(() => shared.receive(settings, true));
}

/**
 * Shared settings changed elsewhere (event `settings`, task 6), applied at once, one batch per event. One the client
 * cannot read is only said: a setting is never worth stopping the writes.
 */
export function settingsEvent(shared: SettingsSync | undefined, data: string): void {
  if (!shared) return;
  let rows: Record<string, SettingRow>;
  try {
    rows = parseSettingRows(JSON.parse(data));
  } catch (e) {
    console.warn(`Réglages reçus illisibles, ignorés : ${messageOf(e)}`);
    return;
  }
  applySettings(() => shared.receive(rows, false));
}

/**
 * The shared settings changed here (task 6, D9): their latest values, none stamped past `latest` (R26:
 * SyncClient.latestSettingTime), MAX_SETTINGS_PER_REQUEST at most per POST /settings; the server's answer handed back
 * (acknowledge), a change that lost giving way to the winner's. Any failure but a refusal ends the connection, and
 * they go at the next one.
 */
export async function sendSettings(conn: Connection, settings: SettingsSync | undefined, latest: () => number): Promise<void> {
  if (!settings) return;
  const pending = settings.pending(latest()), keys = Object.keys(pending);
  for (let i = 0; i < keys.length && !conn.closed; i += MAX_SETTINGS_PER_REQUEST) {
    await postSettings(conn, settings, Object.fromEntries(keys.slice(i, i + MAX_SETTINGS_PER_REQUEST).map((k) => [k, pending[k]])));
  }
}

/**
 * One POST /settings of `sent`. The server refuses a request whole (400, 413) for one setting it will not take: then
 * each setting goes again alone (review of task 6, round 2), so that its well-formed neighbours are never lost; one
 * refused alone would be refused again, and is dropped, said in the console.
 */
async function postSettings(conn: Connection, settings: SettingsSync, sent: Record<string, SettingChange>): Promise<void> {
  const res = await conn.request('/settings', { method: 'POST', headers: JSON_BODY, body: JSON.stringify({ changes: sent }) });
  if (res.status === 400 || res.status === 413) {
    const reason = await reasonOf(res), keys = Object.keys(sent);
    if (keys.length === 1) {
      console.warn(`Réglage « ${keys[0]} » refusé par le serveur, abandonné : ${reason}`);
      applySettings(() => settings.acknowledge(sent, {}));
      return;
    }
    for (const key of keys) if (!conn.closed) await postSettings(conn, settings, { [key]: sent[key] });
    return;
  }
  const answer = await json(res);
  let rows: Record<string, SettingRow>;
  try {
    rows = parseSettingRows((answer as { settings?: unknown } | null)?.settings);
  } catch (e) {
    throw new Refusal(messageOf(e));
  }
  applySettings(() => settings.acknowledge(sent, rows));
}
