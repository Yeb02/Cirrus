import { createHash, createPublicKey, type KeyObject, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { plainName } from '@cirrus/core';

// The manifest of an official version (plan 9, D4): version.json, { version, file, sha512, size, date }, written and
// signed by the CI (scripts/signer-version.mjs) with the ed25519 key kept in GitHub's secrets; its signature,
// version.json.sig, the base64 of the signature of its exact bytes. The app trusts an update only through it: the
// signature checked with the public key it carries (key.ts), then the installer electron-updater downloaded checked
// against its sha512 and size. No dependency but Node's.

/** A signed manifest, checked: the version, the installer's name in the server's versions/, its sha512 (base64), its size, its date. */
export interface Manifest { version: string; file: string; sha512: string; size: number; date: string }

/** A version as the CI makes them (D3: 0.1.<n>): three numbers, without a leading zero, nine digits at most each. */
const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
/** A sha512 in base64, as electron-builder's latest.yml writes it: 64 bytes, 88 characters. */
const SHA512 = /^[A-Za-z0-9+/]{86}==$/;
/** An ed25519 signature in base64: 64 bytes. */
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;
/** The longest file name and date a manifest may give. */
const MAX_NAME_CHARS = 255;
const MAX_DATE_CHARS = 64;

/** The three numbers of a version (VERSION); null for anything else — a pre-release, a dev build's « 0.1.0-dev ». */
export function parseVersion(text: unknown): [number, number, number] | null {
  const m = typeof text === 'string' ? VERSION.exec(text) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** `a` against `b`, two versions (VERSION): negative when older, 0 when equal, positive when newer; NaN when either is none. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return Number.NaN;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** The public key of key.ts's form (SPKI DER, base64), an ed25519 one; null for anything else — the placeholder included. */
function publicKeyOf(text: string): KeyObject | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  try {
    const key = createPublicKey({ key: Buffer.from(text, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

/** Whether `text` is a public key the updates can be checked with: key.ts's placeholder is not. */
export const usableKey = (text: string): boolean => publicKeyOf(text) !== null;

/**
 * The manifest `json`, when `sig` (base64, a final newline allowed) is the ed25519 signature of its exact bytes (UTF-8)
 * by the key `publicKey` (SPKI DER, base64), and only then read: its fields checked — `version` a version (VERSION),
 * `file` a plain name (no folder, no « .. », no drive), `sha512` 64 bytes in base64, `size` a positive integer, `date`
 * a short text —, the others dropped. Null for anything else: a signature of other bytes, another key, a manifest
 * changed after it was signed, the placeholder key, a broken field.
 */
export function verifyManifest(json: string, sig: string, publicKey: string): Manifest | null {
  const key = publicKeyOf(publicKey), signature = sig.replace(/\r?\n$/, '');
  if (!key || !SIGNATURE.test(signature)) return null;
  let ok = false;
  try {
    ok = verify(null, Buffer.from(json, 'utf8'), key, Buffer.from(signature, 'base64'));
  } catch {
    return null;
  }
  if (!ok) return null;
  let m: unknown;
  try {
    m = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return null;
  const { version, file, sha512, size, date } = m as Record<string, unknown>;
  if (parseVersion(version) === null) return null;
  if (typeof file !== 'string' || file.length > MAX_NAME_CHARS || !plainName(file) || /\p{Cs}/u.test(file)) return null;
  if (typeof sha512 !== 'string' || !SHA512.test(sha512)) return null;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return null;
  if (typeof date !== 'string' || date.length > MAX_DATE_CHARS) return null;
  return { version: version as string, file, sha512, size, date };
}

/**
 * Whether the installer at `path` is the one the manifest `m` names: a file of exactly its size, whose sha512 is its
 * own (read whole, as a stream). False for anything else, a file absent or unreadable included.
 */
export async function checkInstaller(path: string, m: Manifest): Promise<boolean> {
  try {
    const st = await stat(path);
    if (!st.isFile() || st.size !== m.size) return false;
    const hash = createHash('sha512');
    let read = 0;
    for await (const chunk of createReadStream(path)) {
      read += (chunk as Buffer).length;
      if (read > m.size) return false;
      hash.update(chunk as Buffer);
    }
    return read === m.size && hash.digest('base64') === m.sha512;
  } catch {
    return false;
  }
}
