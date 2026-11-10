import { createReadStream, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { encodeState, isObject, SNAPSHOT_VERSION, SYNC_PROTOCOL_VERSION, type UnitResult } from '@cirrus/core';
import { unreachable } from '@cirrus/sources';
import { BlobError, filePath, lockBase, receiveBlob, SCHEMA_VERSION } from '@cirrus/store';
import {
  DRAIN_LINGER_MS, DRAIN_MAX_BYTES, DRAIN_MAX_MS, MAX_BODY_BYTES, MAX_FILE_BYTES, MAX_HASHES_PER_REQUEST, MAX_HOST_NAME_CHARS, MAX_INSTALLER_BODY_BYTES, MAX_JOURNAL_PAGE,
  MAX_PAIR_BODY_BYTES, MAX_PRESENCE_BODY_BYTES, MAX_PUBLICATION_BODY_BYTES, MAX_SEED_BYTES, MAX_SETTING_AHEAD_MS, MAX_SMALL_BODY_MS, MAX_UNITS_PER_REQUEST,
  MIN_BODY_BYTES_PER_S, SERVER_HEADERS_TIMEOUT_MS, SERVER_IDLE_MS, SERVER_KEEP_ALIVE_MS, SERVER_REQUEST_TIMEOUT_MS,
} from './bounds.ts';
import { Canon, ForbiddenError } from './canon.ts';
import { Hub } from './events.ts';
import {
  contentDisposition, installerPage, ManifestError, NOTHING_PUBLISHED, officialVersion, type OpenInstaller, openInstaller, PAGE_HEADERS, readVersionFile, WRONG_CODE,
} from './installer.ts';
import { parsePresence, PresenceError } from './presence.ts';
import { parsePublicationRequest, PublicationError, PublicationImports, type PublicationNetwork, serverNetwork } from './publications.ts';
import { SeedError, Seeds } from './seed.ts';
import { parseSettingChanges, SettingsError } from './settings.ts';
import { baseBytes, freeBytes, StoreSize } from './storeSize.ts';
import { hashToken, PairingError, Tokens } from './tokens.ts';

// The server (plan 5a, D1 to D3, D10): HTTP on this machine only, JSON but for files and the snapshot, the token of a
// paired PC on every route but /pair and the download page (/installer, plan 9, D5: installer.ts, a form, and the
// installer for a pairing code) — the signed updates (/versions/*, plan 9, D4) included —, no CORS header (no browser
// is answered but there), every body bounded and checked
// before anything is written. Its data: `dataDir/base/` (a base in a PC's format, its files with it), `dataDir/serveur.db` (the
// paired PCs, the shared settings, the files each PC has open in full screen), and `dataDir/seed/` while a PC sends its base to it, empty (task 5, D7). Its network
// serves only a paired PC's import of a publication (plan 5b, D2: publications.ts). Its space, which GET /status gives
// (plan 5b, D8), is storeSize.ts's.

/**
 * `names`: the names it answers to besides this machine's (plan 9, D1): the domain Caddy serves, which passes the
 * client's Host header on as it is; checked by hostName, refused otherwise.
 * `sources`: the network of a publication's import (plan 5b, task 3), the server's own by default (serverNetwork: Node's
 * fetch, the system's resolver, httpsConnect); a test's replay, so that no test reaches the Internet.
 */
interface ServerOptions { dataDir: string; port: number; host?: string; names?: string[]; now?: () => number; sources?: PublicationNetwork }
export interface RunningServer { url: string; close(): Promise<void> }

/** The addresses it listens on: this machine's only. From the Internet, Caddy carries HTTPS and passes it on (plan 9, D1). */
const LOOPBACK = new Set(['127.0.0.1', '::1']);
/**
 * The names a request may give the server (its Host header): this machine's, and those of `names`; another is a page
 * that rebound its domain to it (DNS rebinding). Nothing a proxy says of the client is read (no X-Forwarded-*).
 */
const LOCAL_NAMES = ['127.0.0.1', 'localhost', '[::1]'];
/** A label of a domain name: letters, digits and inner hyphens, 63 characters at most. */
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST_NAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`, 'i');

/**
 * A name the server may answer to (`--nom`, plan 9, D1), lower-cased: a domain name alone, ASCII (an international
 * name in its xn-- form), without scheme, path, port nor final dot, MAX_HOST_NAME_CHARS at most; null otherwise.
 */
export function hostName(text: string): string | null {
  return text.length <= MAX_HOST_NAME_CHARS && HOST_NAME.test(text) ? text.toLowerCase() : null;
}
const HASH = /^[0-9a-f]{64}$/;
const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/;

/** A refusal: its status, its reason in French (the body `{ error }`), and headers to add. */
class HttpError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;

  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(Buffer.byteLength(text)), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

const tooBig = (max: number) => new HttpError(413, `Requête trop grosse : ${max} octets au plus.`);

/**
 * A request's body, `max` bytes at most: refused (413) by its announced length before anything is read, or as soon as
 * it passes `max`; what follows is drain's, after the answer. Whole within its deadline (MAX_SMALL_BODY_MS, and a second
 * per MIN_BODY_BYTES_PER_S of its announced length, or of `max`), or 408, and the connection closed after the answer
 * (review of task 1, I2): a body trickled a byte at a time would escape SERVER_IDLE_MS.
 */
function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const announced = Number(req.headers['content-length']);
  if (announced > max) return Promise.reject(tooBig(max));
  const deadline = MAX_SMALL_BODY_MS + Math.ceil((Math.min(announced || max, max) / MIN_BODY_BYTES_PER_S) * 1000);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        chunks.length = 0;
        stop(tooBig(max));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      clearTimeout(late);
      resolve(Buffer.concat(chunks));
    };
    const onClose = () => {
      if (!req.complete) stop(new Error('requête interrompue'));
    };
    /** Reading stops: the body is left where it is, for drain. */
    const stop = (e: Error) => {
      clearTimeout(late);
      req.off('data', onData).off('end', onEnd).off('error', stop).off('close', onClose);
      req.pause();
      reject(e);
    };
    const late = setTimeout(() => stop(new HttpError(408, `Corps trop lent : il doit arriver entier en ${Math.round(deadline / 1000)} s.`, { Connection: 'close' })), deadline);
    req.on('data', onData).on('end', onEnd).on('error', stop).on('close', onClose);
  });
}

/**
 * A request's body read as a stream (PUT /files, POST /seed), its reader stopping short — past its bound, refused —
 * without cutting the connection: the answer (413) still reaches the client, what follows is drain's (plan 9, D8).
 */
const bodyOf = (req: IncomingMessage): AsyncIterable<Uint8Array> => req.iterator({ destroyOnReturn: false });

/**
 * The rest of a request's body once it is answered — a refusal, before its body was read or while it was; an answer
 * that did not need it —, read and dropped, so that a client which sends its whole body before it reads gets the
 * answer (plan 9, D8). DRAIN_MAX_BYTES within DRAIN_MAX_MS at most, whoever the client is, a token or not: past either,
 * the server cuts the connection itself (review of task 1, I1) — it reads no more, ends the connection after the answer,
 * and destroys it DRAIN_LINGER_MS later, so that a client reading while it sends gets the answer before the reset. A
 * body read whole: nothing to do.
 */
function drain(req: IncomingMessage): void {
  if (req.complete || req.destroyed) return;
  const socket = req.socket;
  let dropped = 0, cutting = false;
  const onData = (chunk: Buffer) => {
    dropped += chunk.length;
    if (dropped > DRAIN_MAX_BYTES) cut();
  };
  const cut = () => {
    if (cutting) return;
    cutting = true;
    clearTimeout(timer);
    req.off('data', onData);
    req.pause();
    socket.end();
    setTimeout(() => socket.destroy(), DRAIN_LINGER_MS).unref();
  };
  const timer = setTimeout(cut, DRAIN_MAX_MS);
  const done = () => clearTimeout(timer);
  req.on('data', onData);
  req.once('end', done).once('close', done);
  req.resume();
}

/** A JSON body (Content-Type application/json: a page of another site cannot send one without a preflight, which is refused). */
async function readJson(req: IncomingMessage, max: number): Promise<unknown> {
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Corps JSON attendu (Content-Type: application/json).');
  const body = await readBody(req, max);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON invalide.');
  }
}

/**
 * A form's body (Content-Type application/x-www-form-urlencoded, what a page's <form> sends: POST /installer), `max`
 * bytes at most, read as readBody reads a small body: its fields.
 */
async function readForm(req: IncomingMessage, max: number): Promise<URLSearchParams> {
  if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Formulaire attendu (Content-Type: application/x-www-form-urlencoded).');
  return new URLSearchParams((await readBody(req, max)).toString('utf8'));
}

/** The download page (plan 9, D5), with `message` or without, and its headers (installer.ts). */
function sendPage(res: ServerResponse, message: string | null): void {
  const html = installerPage(message);
  res.writeHead(200, { ...PAGE_HEADERS, 'Content-Length': String(Buffer.byteLength(html)) });
  res.end(html);
}

/** A non-negative integer of a query or a header; `fallback` when absent; 400 otherwise. */
function count(value: string | null | undefined, fallback: number, what: string): number {
  if (value === null || value === undefined || value === '') return fallback;
  const n = /^\d{1,16}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n)) throw new HttpError(400, `${what} invalide : un entier positif ou nul attendu.`);
  return n;
}

/** The message of D10 for each version that differs between the PC (its headers) and this server. */
function formatRefusal(req: IncomingMessage): string | null {
  const versions: [string, string, number][] = [['protocole', 'cirrus-protocol', SYNC_PROTOCOL_VERSION], ['schéma', 'cirrus-schema', SCHEMA_VERSION], ['instantané', 'cirrus-snapshot', SNAPSHOT_VERSION]];
  const differ = versions.flatMap(([what, header, ours]) => {
    const theirs = req.headers[header];
    return theirs === String(ours) ? [] : [`${what} ${ours}, ici ${typeof theirs === 'string' && theirs !== '' ? theirs.slice(0, 16) : '?'}`];
  });
  return differ.length === 0 ? null : `Ce serveur garde ses données dans un autre format (${differ.join(' ; ')}) : mets à jour Cirrus, ou travaille sur un serveur local.`;
}

/**
 * The small files of versions/ a PC asks for (plan 9, D4), and their types: the manifest of the official version, its
 * signature (base64), and latest.yml, which electron-updater reads first.
 */
const VERSION_FILES: Record<string, string> = {
  'version.json': 'application/json; charset=utf-8', 'version.json.sig': 'text/plain; charset=utf-8', 'latest.yml': 'text/yaml; charset=utf-8',
};

/** The store's temporaries (`.import-` and 16 hexadecimal digits: receiveBlob's, an import's). */
const TEMPORARY = /^\.import-[0-9a-f]{16}$/;

/**
 * What a server stopped short — killed, the machine off — left of an upload under way: its store's temporaries,
 * removed at the next start, the base locked (no other server writes there). A stop in order leaves none (Review
 * Focus 1): its uploads are cut, and each removes its own.
 */
function dropTemporaries(baseDir: string): void {
  const files = join(baseDir, 'files');
  // One that will not go (another program holds it) never keeps the server from starting: the next start tries again.
  const failed = (what: string, e: unknown) => console.warn(`Temporaire non ôté, ${what} : ${e instanceof Error ? e.message : String(e)} ; le prochain démarrage réessaiera.`);
  let names: string[];
  try {
    names = existsSync(files) ? readdirSync(files) : [];
  } catch (e) {
    failed(files, e);
    return;
  }
  for (const name of names) {
    if (!TEMPORARY.test(name)) continue;
    try {
      rmSync(join(files, name), { force: true });
    } catch (e) {
      failed(join(files, name), e);
    }
  }
}

/**
 * Starts the server on `host` (127.0.0.1 by default, or ::1: refused otherwise) and `port` (0: a free one), its data in
 * `dataDir`, one server per data (the base's lock), answering to this machine's names and to `names`. `now`: its clock
 * (pairing codes, /hello).
 */
export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const host = opts.host ?? '127.0.0.1';
  if (!LOOPBACK.has(host)) throw new Error("Le serveur n'écoute que sur cette machine : Caddy, devant lui, porte le HTTPS (plan 9, D1).");
  const names = new Set(LOCAL_NAMES);
  for (const n of opts.names ?? []) {
    const name = hostName(n);
    if (name === null) throw new Error(`Nom refusé : « ${n} ». Un nom de domaine seul est attendu, sans https://, chemin ni port (cirrus.exemple.fr).`);
    names.add(name);
  }
  const now = opts.now ?? Date.now;
  const baseDir = join(opts.dataDir, 'base');
  const lock = lockBase(baseDir);
  if (!lock) throw new Error(`Un autre serveur tourne déjà sur ces données (${opts.dataDir}).`);
  let tokens: Tokens | null = null, canon: Canon | null = null, hub: Hub | null = null, sizes: StoreSize | null = null;
  try {
    dropTemporaries(baseDir);
    tokens = Tokens.open(opts.dataDir);
    // The streams relay what the base accepts, and read its journal to catch up.
    canon = Canon.open(baseDir, (u) => hub?.publish(u));
    const t = tokens, c = canon;
    hub = new Hub((after, minLines) => c.base.unitsAfter(after, minLines), (hash) => t.pcOfHash(hash) !== null);
    // The store's size (plan 5b, D8), counted from now on, in the background; kept up to date at each file placed.
    const s = (sizes = new StoreSize(baseDir));
    const imports = new PublicationImports(baseDir, opts.sources ?? serverNetwork(), (hash, size) => s.add(hash, size));
    return await listen({
      port: opts.port, host, names, now, dataDir: opts.dataDir, baseDir, tokens: t, canon: c, hub, seeds: new Seeds(join(opts.dataDir, 'seed')), imports, sizes: s, lock,
    });
  } catch (e) {
    await sizes?.close();
    hub?.closeAll();
    canon?.close();
    tokens?.close();
    lock.release();
    throw e;
  }
}

/** What a started server holds, opened by startServer: closed by its `close`. */
interface Parts {
  port: number; host: string; names: ReadonlySet<string>; now: () => number; dataDir: string; baseDir: string; tokens: Tokens; canon: Canon; hub: Hub; seeds: Seeds;
  imports: PublicationImports; sizes: StoreSize; lock: { release(): void };
}

/** A seed's steps, to a server that holds a base already (task 5, D7, R16). */
const NOT_FRESH = 'Le serveur tient déjà une base : il ne reçoit celle d’un PC que vide.';

/** Listens, and serves the routes. */
async function listen({ port: wanted, host, names, now, dataDir, baseDir, tokens, canon, hub, seeds, imports, sizes, lock }: Parts): Promise<RunningServer> {
  /** The PC of the request's token, and the token's hash; 401 otherwise, checked before anything of the body is read. */
  const authenticate = (req: IncomingMessage): { pc: string; tokenHash: string } => {
    const token = BEARER.exec(req.headers.authorization ?? '')?.[1];
    const tokenHash = token === undefined ? null : hashToken(token);
    const pc = tokenHash === null ? null : tokens.pcOfHash(tokenHash);
    if (pc === null || tokenHash === null) throw new HttpError(401, 'Jeton absent, inconnu ou révoqué : jumelle ce PC de nouveau.', { 'WWW-Authenticate': 'Bearer' });
    return { pc, tokenHash };
  };
  const blob = (hash: string) => filePath(baseDir, { name: '', hash, size: 0 });
  /** A seed's every step: only to a server that holds no base yet (D7, R16). */
  const fresh = () => {
    if (!canon.fresh()) throw new HttpError(409, NOT_FRESH);
  };

  const routes: Record<string, Record<string, (req: IncomingMessage, res: ServerResponse, url: URL, who: { pc: string; tokenHash: string }) => Promise<void> | void>> = {
    '/hello': {
      GET: async (req, res) => {
        const refusal = formatRefusal(req);
        if (refusal) throw new HttpError(409, refusal);
        // The nodes it holds: the first pairing's offer to take its base names them (task 5, D7). Its base's identity:
        // a PC that follows it picks up where it stopped, one that follows another stops (R31). The official version it
        // serves (plan 9, D4), or null: a PC older than it looks for its update — which it trusts only once signed.
        const version = await officialVersion(dataDir);
        reply(res, 200, { serverTime: now(), lastSeq: canon.seq, empty: canon.empty(), nodes: canon.state.nodes.size, baseId: canon.baseId, version });
      },
    },
    // R15: a PC revokes its own token — a pairing it cancels, a first sync that fails, « Dissocier ce PC » —, never another's.
    '/unpair': {
      POST: (_req, res, _url, who) => {
        tokens.revokeToken(who.tokenHash);
        seeds.drop(who.tokenHash);
        res.writeHead(204).end();
      },
    },
    /**
     * The first sync (task 5, D7, R16): a PC sends its base to this server, which holds none yet. POST /seed: its
     * snapshot (raw bytes, MAX_SEED_BYTES at most, streamed into a temporary file), the journal line it covers in
     * Cirrus-Seq; the seed under way, another PC's included, is dropped (the last to start owns it). Its answer,
     * `{ baseId }`: the identity the base will have once taken, drawn by the server (short review after plan 5a, B1).
     * Then its journal by pages (POST /seed/journal), then POST /seed/done, which takes the whole and makes the server
     * not empty. Until then, nothing of it shows.
     */
    '/seed': {
      POST: async (req, res, _url, who) => {
        if (!/^application\/octet-stream\s*(;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Corps attendu : l’instantané de la base (Content-Type: application/octet-stream).');
        const header = req.headers['cirrus-seq'];
        if (typeof header !== 'string' || header === '') throw new HttpError(400, 'En-tête Cirrus-Seq attendu : la ligne du journal que couvre l’instantané.');
        const seq = count(header, 0, 'Cirrus-Seq');
        if (Number(req.headers['content-length']) > MAX_SEED_BYTES) throw tooBig(MAX_SEED_BYTES);
        fresh();
        reply(res, 200, { baseId: await seeds.begin(who.tokenHash, bodyOf(req), seq) });
      },
    },
    '/seed/journal': {
      POST: async (req, res, _url, who) => {
        fresh();
        seeds.owned(who.tokenHash);
        const body = await readJson(req, MAX_BODY_BYTES);
        fresh();
        reply(res, 200, { received: seeds.page(who.tokenHash, body) });
      },
    },
    '/seed/done': {
      POST: async (req, res, _url, who) => {
        // A server no longer fresh will never take this seed: its staging (up to MAX_SEED_BYTES) goes now (review, Minor 5).
        const stillFresh = () => {
          if (canon.fresh()) return;
          seeds.drop(who.tokenHash);
          throw new HttpError(409, NOT_FRESH);
        };
        stillFresh();
        seeds.owned(who.tokenHash);
        const body = await readJson(req, MAX_BODY_BYTES);
        stillFresh();
        // From here to the answer, synchronous: no write comes in between.
        const taken = seeds.take(who.tokenHash, body);
        try {
          canon.seed(taken.state, taken.last, taken.lines, taken.baseId);
        } finally {
          seeds.drop();
        }
        // A stream live on the empty base would miss the seed's lines: each reconnects and catches up (or, a PC that
        // followed the empty base, stops: its identity has changed, R31).
        hub.endStreams();
        reply(res, 200, { lastSeq: canon.seq, baseId: canon.baseId });
      },
    },
    '/events': {
      GET: (req, res, url, who) => {
        const header = req.headers['last-event-id'];
        const after = count(typeof header === 'string' && header !== '' ? header : url.searchParams.get('after'), 0, 'Numéro de reprise');
        if (after > canon.seq) throw new HttpError(409, `Ce PC a reçu jusqu’au numéro ${after}, mais le serveur s’arrête au ${canon.seq} : ses données ont été remplacées ou restaurées.`);
        try {
          canon.base.unitsAfter(after, 0);
        } catch (e) {
          if (e instanceof RangeError) throw new HttpError(400, e.message);
          throw e;
        }
        hub.open(res, after, who.tokenHash);
      },
    },
    '/units': {
      POST: async (req, res, _url, who) => {
        const body = await readJson(req, MAX_BODY_BYTES);
        if (!isObject(body) || !Array.isArray(body.units)) throw new HttpError(400, 'Corps attendu : { units: [...] }.');
        const units = body.units as unknown[];
        if (units.length > MAX_UNITS_PER_REQUEST) throw new HttpError(400, `Au plus ${MAX_UNITS_PER_REQUEST} écritures par requête.`);
        // One write signed by another PC refuses the whole request, before any is accepted.
        if (units.some((u) => isObject(u) && typeof u.pc === 'string' && u.pc !== who.pc)) {
          throw new HttpError(403, 'Écriture signée d’un autre PC que celui du jeton : la requête est refusée.');
        }
        const results: UnitResult[] = [];
        let blocked = false;
        for (const u of units) {
          // In order: after the first one not accepted, the rest wait for the PC to have caught up.
          const r: UnitResult = blocked ? { stale: canon.seq } : canon.accept(u, who.pc);
          blocked ||= !('accepted' in r);
          results.push(r);
        }
        reply(res, 200, { results });
      },
    },
    /**
     * The shared settings (task 6, D9, R23, R24): GET, every one the server keeps, `{ [key]: { value, at, pc } }`; POST
     * `{ changes: { [key]: { value, at } } }`, each kept if more recent than the setting's last change (then the
     * greater PC identifier), the request checked whole before anything is written. Its answer: the setting as kept
     * now, for every key sent (a change that lost gives the winner's); the event streams hear of those it changed.
     */
    '/settings': {
      GET: (_req, res) => reply(res, 200, tokens.settings()),
      POST: async (req, res, _url, who) => {
        const changes = parseSettingChanges(await readJson(req, MAX_BODY_BYTES), now() + MAX_SETTING_AHEAD_MS);
        const { rows, changed } = tokens.putSettings(changes, who.pc);
        if (Object.keys(changed).length > 0) hub.publishSettings(changed);
        reply(res, 200, { settings: rows });
      },
    },
    /**
     * « .tex ouvert ailleurs » (plan 5b, task 5, D6): PUT `{ open: [{ node, name }] }`, the files this PC has open in full
     * screen, its whole list, sent at each change and at each connection; checked whole before anything is written
     * (parsePresence: MAX_PRESENCE_ENTRIES at most, plain names), it replaces the one serveur.db keeps of this PC. Its
     * answer, `{ others }`: the same files open on the other PCs, by name as the reimport compares them, each with that
     * PC's name and since when (the server's clock).
     */
    '/presence': {
      PUT: async (req, res, _url, who) => {
        const open = parsePresence(await readJson(req, MAX_PRESENCE_BODY_BYTES));
        reply(res, 200, { others: tokens.putPresence(who.pc, open, now()) });
      },
    },
    '/files/missing': {
      POST: async (req, res) => {
        const body = await readJson(req, MAX_BODY_BYTES);
        const hashes = isObject(body) && Array.isArray(body.hashes) ? (body.hashes as unknown[]) : null;
        if (!hashes || hashes.length > MAX_HASHES_PER_REQUEST) throw new HttpError(400, `Corps attendu : { hashes: [...] }, ${MAX_HASHES_PER_REQUEST} empreintes au plus.`);
        if (!hashes.every((h) => typeof h === 'string' && HASH.test(h))) throw new HttpError(400, 'Empreinte mal formée : 64 chiffres hexadécimaux en minuscules attendus.');
        reply(res, 200, { missing: [...new Set(hashes as string[])].filter((h) => !existsSync(blob(h))) });
      },
    },
    /**
     * A publication imported for this PC (plan 5b, task 3, D2): its body, MAX_PUBLICATION_BODY_BYTES at most, checked whole
     * (parsePublicationRequest: its text, the PC's caps brought under the server's bounds) before anything is asked;
     * MAX_PUBLICATION_FETCHES imports at once, 503 beyond; the import made by the server's network, under D3's guards,
     * its PDF into the server's store. Its answer, the PublicationResult the PC's own import would give, what the
     * network answered included (`{ ok: false, message }`, a 200 too: not found, an address refused). The server's own
     * network not reached — no connection, no answer within the delay (`unreachable` of @cirrus/sources) —: 502, its
     * reason as the error, and the PC imports it by its own network (review of task 3, I1: a proxy, a TLS inspection
     * that Electron passes and Node does not). The PC gone, or the server stopping, the import is aborted, and answers
     * no one.
     */
    '/publications': {
      POST: async (req, res) => {
        const request = parsePublicationRequest(await readJson(req, MAX_PUBLICATION_BODY_BYTES));
        // The PC waits, silent, while the server imports: the idle delay (SERVER_IDLE_MS) is lifted, the import's own
        // delays bound it (plan 9, D1), and put back before the answer — a request pipelined behind this one on the
        // connection falls under it again (review of task 1, M1: Node does not reset it then).
        res.setTimeout(0);
        const gone = new AbortController();
        res.on('close', () => { if (!res.writableEnded) gone.abort(new Error('Demande d’import abandonnée.')); });
        let result: Awaited<ReturnType<typeof imports.run>>;
        try {
          result = await imports.run(request, gone.signal);
        } finally {
          res.setTimeout(SERVER_IDLE_MS);
        }
        if (gone.signal.aborted) return;
        if (!result.ok && unreachable(result.message)) throw new HttpError(502, result.message);
        reply(res, 200, result);
      },
    },
    /**
     * The server's state (plan 5b, D8), which the block « Serveur » of a paired PC asks every serverStatusPollMs while it
     * is shown, its round trip the latency: the size of its base's database files, of its store and the number of its
     * files (what is known so far: `counting` until their first count, at the start, ends), and the free space of its
     * disk. Nothing read but sizes.
     */
    '/status': {
      GET: async (_req, res) => {
        reply(res, 200, { baseBytes: baseBytes(baseDir), ...sizes.get(), freeBytes: await freeBytes(dataDir) });
      },
    },
    '/snapshot': {
      GET: (_req, res) => {
        const data = Buffer.from(encodeState(canon.state));
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(data.length), 'Cirrus-Seq': String(canon.seq), 'Cache-Control': 'no-store' });
        res.end(data);
      },
    },
    '/journal': {
      GET: (_req, res, url) => {
        const after = count(url.searchParams.get('after'), 0, 'Numéro');
        const limit = Math.min(count(url.searchParams.get('limit'), MAX_JOURNAL_PAGE, 'Nombre de lignes'), MAX_JOURNAL_PAGE);
        if (limit === 0) throw new HttpError(400, 'Nombre de lignes invalide : au moins 1.');
        reply(res, 200, { rows: canon.base.changesSince(after, limit) });
      },
    },
  };
  /** /files/<hash>: a blob, received (PUT, raw bytes, checked against its hash) or served (GET). */
  const fileRoutes: Record<string, (req: IncomingMessage, res: ServerResponse, hash: string) => Promise<void>> = {
    PUT: async (req, res, hash) => {
      if (Number(req.headers['content-length']) > MAX_FILE_BYTES) throw tooBig(MAX_FILE_BYTES);
      if (!existsSync(blob(hash))) {
        // Counted in the store's size once placed (plan 5b, D8); passed over by its first count until then, which could
        // otherwise read it between its rename into place and `add` (task 8a).
        sizes.placing(hash);
        try {
          sizes.add(hash, (await receiveBlob(baseDir, hash, bodyOf(req), MAX_FILE_BYTES)).size);
        } catch (e) {
          sizes.abandon(hash);
          if (e instanceof BlobError) throw e.tooBig ? tooBig(MAX_FILE_BYTES) : new HttpError(400, e.message);
          throw e;
        }
      } else {
        // Already there (two PCs sending it at once): its bytes read to the end and dropped, MAX_FILE_BYTES at most — a
        // sending of its own, not a rest for drain, which would cut it past DRAIN_MAX_BYTES.
        let size = 0;
        for await (const chunk of bodyOf(req)) if ((size += chunk.length) > MAX_FILE_BYTES) throw tooBig(MAX_FILE_BYTES);
      }
      res.writeHead(204).end();
    },
    GET: async (_req, res, hash) => {
      const path = blob(hash), st = statSync(path, { throwIfNoEntry: false });
      if (!st) throw new HttpError(404, 'Fichier absent du serveur.');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(st.size), 'Cache-Control': 'no-store' });
      await pipeline(createReadStream(path), res);
    },
  };

  /**
   * POST /installer (plan 9, D5): the form's code checked as /pair checks it, a wrong try counted against every pending
   * code, a good one not spent (Tokens.checkCode). A good code gets the official installer, streamed from the file
   * opened (openInstaller); a wrong one, the page and WRONG_CODE. Nothing is said of the version published but to a good
   * code: none, or a manifest that names nothing it can serve (written to the server's log), the page and
   * NOTHING_PUBLISHED.
   */
  const installer = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const code = (await readForm(req, MAX_INSTALLER_BODY_BYTES)).get('code');
    if (code === null || !tokens.checkCode(code, now())) return sendPage(res, WRONG_CODE);
    const found = await official('Page de téléchargement');
    if (!found) return sendPage(res, NOTHING_PUBLISHED);
    await sendInstaller(res, found, { 'Content-Disposition': contentDisposition(found.file) });
  };

  /** The official installer opened (openInstaller), or null; a manifest that names nothing it can serve, written to the log for `who`. */
  const official = async (who: string): Promise<OpenInstaller | null> => {
    try {
      return await openInstaller(dataDir);
    } catch (e) {
      if (!(e instanceof ManifestError)) throw e;
      console.warn(`${who} : ${e.message}`);
      return null;
    }
  };

  /** The installer opened, streamed from its handle — its checked size and no more, were the file to grow under it —, then closed. */
  const sendInstaller = async (res: ServerResponse, found: OpenInstaller, headers: Record<string, string> = {}): Promise<void> => {
    try {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream', 'Content-Length': String(found.size), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers,
      });
      await pipeline(found.handle.createReadStream({ start: 0, end: found.size - 1, autoClose: false }), res);
    } finally {
      await found.handle.close();
    }
  };

  /**
   * GET /versions/<name> (plan 9, D4), with a paired PC's token: what the app's updater and electron-updater ask for —
   * version.json, its signature, latest.yml, read whole (MAX_VERSION_FILE_BYTES at most); the installer version.json
   * names, streamed, and no other file. `name` decoded from the path (electron-updater asks for « Cirrus Setup
   * 0.1.7.exe » as %20s); each opened as it is checked (installer.ts: a regular file of versions/, its only name). Any
   * other name, or a file not served: 404, the reason in the log.
   */
  const versionFile = async (res: ServerResponse, name: string): Promise<void> => {
    const absent = new HttpError(404, 'Fichier absent des versions publiées.');
    const type = Object.hasOwn(VERSION_FILES, name) ? VERSION_FILES[name] : null;
    if (type === null) {
      const found = await official('Versions');
      if (found?.file !== name) {
        await found?.handle.close();
        throw absent;
      }
      return sendInstaller(res, found);
    }
    let bytes: Buffer | null;
    try {
      bytes = await readVersionFile(dataDir, name);
    } catch (e) {
      if (!(e instanceof ManifestError)) throw e;
      console.warn(`Versions : ${e.message}`);
      bytes = null;
    }
    if (!bytes) throw absent;
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': String(bytes.length), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(bytes);
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Another name than this machine's or its own (--nom): a page that rebound its domain to 127.0.0.1 (DNS rebinding).
    // The refusal names none of them.
    if (!names.has((req.headers.host ?? '').toLowerCase().replace(/:\d+$/, ''))) {
      throw new HttpError(403, 'Hôte refusé : ce serveur ne répond qu’à cette machine et aux noms qu’on lui a donnés.');
    }
    const url = new URL(req.url ?? '/', 'http://serveur'), method = req.method ?? 'GET';
    const allow = (methods: string[]) => {
      if (!methods.includes(method)) throw new HttpError(405, 'Méthode non permise.', { Allow: methods.join(', ') });
    };
    // The download page (D5), the other route without a token: its body read for POST only.
    if (url.pathname === '/installer') {
      allow(['GET', 'POST']);
      return method === 'GET' ? sendPage(res, null) : installer(req, res);
    }
    if (url.pathname === '/pair') {
      allow(['POST']);
      const token = tokens.pair(await readJson(req, MAX_PAIR_BODY_BYTES), now());
      reply(res, 200, { token });
      return;
    }
    // The signed updates (plan 9, D4): GET only, the token before anything of the folder is looked at.
    if (url.pathname.startsWith('/versions/')) {
      allow(['GET']);
      authenticate(req);
      let name: string;
      try {
        name = decodeURIComponent(url.pathname.slice('/versions/'.length));
      } catch {
        throw new HttpError(400, 'Nom de fichier mal encodé.');
      }
      return versionFile(res, name);
    }
    if (url.pathname.startsWith('/files/') && url.pathname !== '/files/missing') {
      allow(Object.keys(fileRoutes));
      authenticate(req);
      const hash = url.pathname.slice('/files/'.length);
      if (!HASH.test(hash)) throw new HttpError(400, 'Empreinte mal formée : 64 chiffres hexadécimaux en minuscules attendus.');
      return fileRoutes[method](req, res, hash);
    }
    const route = Object.hasOwn(routes, url.pathname) ? routes[url.pathname] : undefined;
    if (!route) throw new HttpError(404, 'Route inconnue.');
    allow(Object.keys(route));
    return route[method](req, res, url, authenticate(req));
  }

  /** The requests under way, awaited by close: none is cut while it writes. */
  const inflight = new Set<Promise<void>>();
  // Its delays, explicit (D1, bounds.ts): headers within a minute, a whole request without limit, a silent connection cut.
  const server = createServer({ headersTimeout: SERVER_HEADERS_TIMEOUT_MS, requestTimeout: SERVER_REQUEST_TIMEOUT_MS, keepAliveTimeout: SERVER_KEEP_ALIVE_MS }, (req, res) => {
    // Once answered — a refusal, before or while its body was read; an answer that did not need the body —, what is
    // left of the body is drain's, bounded, token or not (review of task 1, I1). Before Node's own listener: Node would
    // otherwise read it all and drop it, unbounded.
    res.prependOnceListener('finish', () => drain(req));
    const p: Promise<void> = (async () => {
      try {
        await handle(req, res);
      } catch (e) {
        const known = e instanceof HttpError ? e
          : e instanceof PairingError || e instanceof SeedError || e instanceof SettingsError || e instanceof PublicationError || e instanceof PresenceError
            ? new HttpError(e.status, e.message)
          : e instanceof ForbiddenError ? new HttpError(403, e.message) : null;
        if (res.headersSent) {
          res.destroy();
        } else if (known) {
          reply(res, known.status, { error: known.message }, known.headers);
        } else if (!req.destroyed) {
          console.error(e);
          reply(res, 500, { error: 'Erreur interne du serveur.' });
        }
      }
    })().finally(() => inflight.delete(p));
    inflight.add(p);
  });
  server.timeout = SERVER_IDLE_MS;
  await new Promise<void>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => reject(e.code === 'EADDRINUSE' ? new Error(`Le port ${wanted} est déjà pris sur ${host}.`) : e));
    server.listen(wanted, host, () => resolve());
  });
  server.removeAllListeners('error');
  server.on('error', (e) => console.error(`Serveur : ${e.message}`));
  const port = (server.address() as AddressInfo).port;
  let closing: Promise<void> | null = null;
  return {
    url: host.includes(':') ? `http://[${host}]:${port}` : `http://${host}:${port}`,
    close: () => closing ??= (async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      hub.closeAll();
      server.closeAllConnections();
      await closed;
      await Promise.allSettled([...inflight]);
      await sizes.close();
      seeds.drop();
      canon.close();
      tokens.close();
      lock.release();
    })(),
  };
}
