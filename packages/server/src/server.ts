import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { encodeState, isObject, SNAPSHOT_VERSION, SYNC_PROTOCOL_VERSION, type UnitResult } from '@cirrus/core';
import { BlobError, filePath, lockBase, receiveBlob, SCHEMA_VERSION } from '@cirrus/store';
import {
  MAX_BODY_BYTES, MAX_FILE_BYTES, MAX_HASHES_PER_REQUEST, MAX_JOURNAL_PAGE, MAX_PAIR_BODY_BYTES, MAX_SEED_BYTES, MAX_SETTING_AHEAD_MS, MAX_UNITS_PER_REQUEST,
} from './bounds.ts';
import { Canon, ForbiddenError } from './canon.ts';
import { Hub } from './events.ts';
import { SeedError, Seeds } from './seed.ts';
import { parseSettingChanges, SettingsError } from './settings.ts';
import { hashToken, PairingError, Tokens } from './tokens.ts';

// The server (plan 5a, D1 to D3, D10): HTTP on this machine only, JSON but for files and the snapshot, the token of a
// paired PC on every route but /pair, no CORS header (no browser is answered), every body bounded and checked before
// anything is written. Its data: `dataDir/base/` (a base in a PC's format, its files with it), `dataDir/serveur.db` (the
// paired PCs, the shared settings), and `dataDir/seed/` while a PC sends its base to it, empty (task 5, D7).

interface ServerOptions { dataDir: string; port: number; host?: string; now?: () => number }
export interface RunningServer { url: string; close(): Promise<void> }

/** The addresses it listens on: this machine's, until HTTPS (plan 9). */
const LOOPBACK = new Set(['127.0.0.1', '::1']);
/** The names a request may give the server (its Host header): this machine's; another is a page that rebound its domain to it. */
const LOCAL_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
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
 * it passes `max` — what follows is then read and dropped, so that the answer still reaches the client.
 */
function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  if (Number(req.headers['content-length']) > max) return Promise.reject(tooBig(max));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0, over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > max) {
        over = true;
        chunks.length = 0;
        reject(tooBig(max));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    req.on('close', () => { if (!req.complete) reject(new Error('requête interrompue')); });
  });
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
 * Starts the server on `host` (127.0.0.1 by default, or ::1: refused otherwise) and `port` (0: a free one), its data in
 * `dataDir`, one server per data (the base's lock). `now`: its clock (pairing codes, /hello).
 */
export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const host = opts.host ?? '127.0.0.1';
  if (!LOOPBACK.has(host)) throw new Error("Le serveur n'écoute que sur cette machine tant qu'il n'a pas de HTTPS (plan 9).");
  const now = opts.now ?? Date.now;
  const baseDir = join(opts.dataDir, 'base');
  const lock = lockBase(baseDir);
  if (!lock) throw new Error(`Un autre serveur tourne déjà sur ces données (${opts.dataDir}).`);
  let tokens: Tokens | null = null, canon: Canon | null = null, hub: Hub | null = null;
  try {
    tokens = Tokens.open(opts.dataDir);
    // The streams relay what the base accepts, and read its journal to catch up.
    canon = Canon.open(baseDir, (u) => hub?.publish(u));
    const t = tokens, c = canon;
    hub = new Hub((after, minLines) => c.base.unitsAfter(after, minLines), (hash) => t.pcOfHash(hash) !== null);
    return await listen({ port: opts.port, host, now, baseDir, tokens: t, canon: c, hub, seeds: new Seeds(join(opts.dataDir, 'seed')), lock });
  } catch (e) {
    hub?.closeAll();
    canon?.close();
    tokens?.close();
    lock.release();
    throw e;
  }
}

/** What a started server holds, opened by startServer: closed by its `close`. */
interface Parts { port: number; host: string; now: () => number; baseDir: string; tokens: Tokens; canon: Canon; hub: Hub; seeds: Seeds; lock: { release(): void } }

/** A seed's steps, to a server that holds a base already (task 5, D7, R16). */
const NOT_FRESH = 'Le serveur tient déjà une base : il ne reçoit celle d’un PC que vide.';

/** Listens, and serves the routes. */
async function listen({ port: wanted, host, now, baseDir, tokens, canon, hub, seeds, lock }: Parts): Promise<RunningServer> {
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
      GET: (req, res) => {
        const refusal = formatRefusal(req);
        if (refusal) throw new HttpError(409, refusal);
        // The nodes it holds: the first pairing's offer to take its base names them (task 5, D7). Its base's identity:
        // a PC that follows it picks up where it stopped, one that follows another stops (R31).
        reply(res, 200, { serverTime: now(), lastSeq: canon.seq, empty: canon.empty(), nodes: canon.state.nodes.size, baseId: canon.baseId });
      },
    },
    // R15: a PC revokes its own token — a pairing it cancels, a first sync that fails, « Dissocier ce PC » —, never another's.
    '/unpair': {
      POST: (req, res, _url, who) => {
        req.resume();
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
        reply(res, 200, { baseId: await seeds.begin(who.tokenHash, req, seq) });
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
    '/files/missing': {
      POST: async (req, res) => {
        const body = await readJson(req, MAX_BODY_BYTES);
        const hashes = isObject(body) && Array.isArray(body.hashes) ? (body.hashes as unknown[]) : null;
        if (!hashes || hashes.length > MAX_HASHES_PER_REQUEST) throw new HttpError(400, `Corps attendu : { hashes: [...] }, ${MAX_HASHES_PER_REQUEST} empreintes au plus.`);
        if (!hashes.every((h) => typeof h === 'string' && HASH.test(h))) throw new HttpError(400, 'Empreinte mal formée : 64 chiffres hexadécimaux en minuscules attendus.');
        reply(res, 200, { missing: [...new Set(hashes as string[])].filter((h) => !existsSync(blob(h))) });
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
        try {
          await receiveBlob(baseDir, hash, req, MAX_FILE_BYTES);
        } catch (e) {
          if (e instanceof BlobError) throw e.tooBig ? tooBig(MAX_FILE_BYTES) : new HttpError(400, e.message);
          throw e;
        }
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

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Another name than this machine's: a page that rebound its domain to 127.0.0.1 (DNS rebinding).
    if (!LOCAL_NAMES.has((req.headers.host ?? '').toLowerCase().replace(/:\d+$/, ''))) {
      throw new HttpError(403, 'Hôte refusé : ce serveur ne répond qu’à cette machine (127.0.0.1, localhost ou ::1).');
    }
    const url = new URL(req.url ?? '/', 'http://serveur'), method = req.method ?? 'GET';
    const allow = (methods: string[]) => {
      if (!methods.includes(method)) throw new HttpError(405, 'Méthode non permise.', { Allow: methods.join(', ') });
    };
    if (url.pathname === '/pair') {
      allow(['POST']);
      const token = tokens.pair(await readJson(req, MAX_PAIR_BODY_BYTES), now());
      reply(res, 200, { token });
      return;
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
  const server = createServer((req, res) => {
    const p: Promise<void> = (async () => {
      try {
        await handle(req, res);
      } catch (e) {
        const known = e instanceof HttpError ? e : e instanceof PairingError || e instanceof SeedError || e instanceof SettingsError ? new HttpError(e.status, e.message)
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
      seeds.drop();
      canon.close();
      tokens.close();
      lock.release();
    })(),
  };
}
