import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../jsonFile.ts';
import { messageOf } from './connection.ts';

// The server a PC is paired with (plan 5a, D3): its address, the token it gave, this PC's name there — kept in
// serveur.json next to the base, the token encrypted (safeStorage, DPAPI, in the app): a test base can never speak to
// the user's server, and no token is ever on the disk in clear. With them, the server's clock as last measured (plan 9,
// D7): what the writes made before the next hello are dated by.

/**
 * A server paired: its address, this PC's token and name there; `clockOffsetMs`, the server's clock minus this PC's at
 * the last hello (none before the first).
 */
export interface ServerConfig { url: string; token: string; name: string; clockOffsetMs?: number }

/** The server's configuration, read and written whole; null: no server (write(null) unpairs). */
export interface SecretStore { read(): ServerConfig | null; write(c: ServerConfig | null): void }

/** How the token is kept on the disk: safeStorage in the app, in clear in the tests. */
export interface TokenCipher { encrypt(text: string): Buffer; decrypt(data: Buffer): string }

export const SERVER_FILE = 'serveur.json';

/** What serveur.json holds: the address and the name in clear, the token encrypted, in base64; the clock's offset. */
interface StoredConfig { url: string; name: string; token: string; clockOffsetMs?: number }

/**
 * serveur.json in `dir`, its token through `cipher`; a file absent, unreadable or that `cipher` cannot open gives no
 * server. An offset that is not a whole number of milliseconds is left out, the server kept.
 */
export function fileSecrets(dir: string, cipher: TokenCipher): SecretStore {
  const file = join(dir, SERVER_FILE);
  return {
    read() {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        return null;
      }
      try {
        const c = JSON.parse(text) as Partial<StoredConfig>;
        if (typeof c.url === 'string' && typeof c.name === 'string' && typeof c.token === 'string') {
          const config: ServerConfig = { url: c.url, name: c.name, token: cipher.decrypt(Buffer.from(c.token, 'base64')) };
          if (Number.isSafeInteger(c.clockOffsetMs)) config.clockOffsetMs = c.clockOffsetMs;
          return config;
        }
      } catch {
        // reported below
      }
      console.warn(`Configuration du serveur illisible (${SERVER_FILE}) : ce PC travaille sans serveur.`);
      return null;
    },
    write(c) {
      if (c === null) {
        rmSync(file, { force: true });
        return;
      }
      const stored: StoredConfig = { url: c.url, name: c.name, token: cipher.encrypt(c.token).toString('base64') };
      if (c.clockOffsetMs !== undefined) stored.clockOffsetMs = c.clockOffsetMs;
      // Synced to the disk: neither a crash nor a power cut leaves half a file (a base taken from the server is marked
      // complete only after it, task 5).
      writeJsonAtomic(file, stored, { sync: true, space: 2 });
    },
  };
}

/**
 * A server's address as typed, without its trailing slashes: https or http, a host, no path; an Error in French
 * otherwise, which names the address of a rented server (https, plan 9) and, for one of this machine, http (R10: only
 * there is http allowed, pairing.ts).
 */
export function serverUrl(text: string): string {
  let u: URL | null = null;
  try {
    u = new URL(text.trim());
  } catch {
    // reported below
  }
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:') || u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '' || u.pathname.replace(/\/+$/, '') !== '') {
    throw new Error('Adresse du serveur invalide : https://domaine (ou http://127.0.0.1:port pour un serveur de cette machine) attendu.');
  }
  return u.origin;
}

/**
 * Pairs this PC (D3): the code `jumeler` showed on the server traded for a token (POST /pair), with this PC's
 * identifier and name; the configuration to keep (SecretStore.write). The server's refusal, in French, or why it could
 * not be reached, as an Error.
 */
export async function pair(fetchFn: typeof fetch, url: string, code: string, pc: string, name: string): Promise<ServerConfig> {
  const base = serverUrl(url);
  let res: Response;
  try {
    res = await fetchFn(`${base}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, pc, name }) });
  } catch (e) {
    throw new Error(`Serveur injoignable (${base}) : ${messageOf(e)}.`);
  }
  const body = (await res.json().catch(() => null)) as { token?: unknown; error?: unknown } | null;
  if (res.status !== 200 || typeof body?.token !== 'string') {
    throw new Error(typeof body?.error === 'string' ? body.error : `Réponse ${res.status} du serveur au jumelage.`);
  }
  return { url: base, token: body.token, name };
}
