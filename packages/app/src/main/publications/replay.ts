import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { basename, join } from 'node:path';
import type { ConnectRequest, FetchFn, OpenDeps } from '@cirrus/sources';

/**
 * Recorded answers instead of the network (plan 4c, task 4): the tests', and the built app's on a test base (the
 * interface's scenarios, the captures), which import a publication without touching the network. `<dir>/index.json`:
 *
 *   { "addresses": { "<name>": ["<address>", …] },
 *     "responses": [{ "url": "<address>", "accept": "<Accept>", "status": 302, "headers": { "location": "…" } },
 *                   { "url": "…", "accept": "…", "status": 200, "headers": { "content-type": "…" }, "body": "<file of dir>" }] }
 *
 * A request gets the first answer of its address whose `accept` is its Accept (or that has none); its body, if any,
 * the file's bytes. A request nothing answers fails as without a network (TypeError, « fetch failed »). `addresses`:
 * the open web's names (plan 5b, D3, replayOpen).
 */
interface Recorded { url: string; accept?: string; status: number; headers?: Record<string, string>; body?: string }
interface Index { responses: Recorded[]; addresses?: Record<string, string[]> }

/** Read at each request: a scenario may change the folder between two imports. */
const indexOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as Index;

/** A recorded answer as the network gives it: its body a file of the folder, never a path elsewhere. */
function answerOf(dir: string, r: Recorded): Response {
  if (r.body !== undefined && (r.body !== basename(r.body) || r.body === '..')) throw new Error(`Réponse enregistrée invalide : ${r.body}`);
  const body = r.body === undefined ? null : new Uint8Array(readFileSync(join(dir, r.body)));
  return new Response(body, { status: r.status, headers: r.headers });
}

export function replayFetch(dir: string): FetchFn {
  return async (url, init) => {
    if (init.signal.aborted) throw init.signal.reason;
    const r = indexOf(dir).responses.find((x) => x.url === url && (x.accept === undefined || x.accept === init.headers.Accept));
    if (!r) throw new TypeError(`fetch failed: aucune réponse enregistrée pour ${url}`);
    return answerOf(dir, r);
  };
}

/** Whether the recorded `url` is what `req` asks: its name (an IPv6 one without its brackets), its path and query. */
function asks(url: string, req: ConnectRequest): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.hostname.replace(/^\[(.*)\]$/, '$1') === req.hostname && `${u.pathname}${u.search}` === req.path;
}

/**
 * The open web replayed (plan 5b, D3): what @cirrus/sources' openFetch asks of the network, answered from the folder,
 * under its guards as they run on the network's answers (a name written with a local address is refused before any
 * answer is asked). `resolve`: the addresses `addresses` writes for a name; any other fails as getaddrinfo does.
 * `connect`: the answer recorded for its name, path and query (its Accept, if it has one), only at an address written for
 * that name (or written in the address itself): the address checked reaches the connection. Nothing reaches the network.
 */
export function replayOpen(dir: string): Pick<OpenDeps, 'resolve' | 'connect'> {
  return {
    resolve: async (host) => {
      const addresses = indexOf(dir).addresses?.[host];
      if (!Array.isArray(addresses)) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host} (aucune adresse enregistrée)`), { code: 'ENOTFOUND' });
      return addresses.map((address) => ({ address, family: isIP(address) === 6 ? 6 as const : 4 as const }));
    },
    connect: async (req) => {
      if (req.signal.aborted) throw req.signal.reason;
      const index = indexOf(dir);
      const at = req.address === req.hostname || (index.addresses?.[req.hostname] ?? []).includes(req.address);
      const r = at ? index.responses.find((x) => asks(x.url, req) && (x.accept === undefined || x.accept === req.headers.Accept)) : undefined;
      if (!r) throw new TypeError(`connect failed: aucune réponse enregistrée pour ${req.hostname}${req.path} à ${req.address}`);
      return answerOf(dir, r);
    },
  };
}

/**
 * The replay's folder, CIRRUS_PUBLICATIONS_REPLAY, taken only on a test base in a window out of the user's way: with
 * CIRRUS_DATA, and in capture mode or with CIRRUS_BACKGROUND=1 (scripts/interface.mjs). Never on the user's own base:
 * there, the network (null).
 */
export function replayDirOf(env: Record<string, string | undefined>, capture: boolean): string | null {
  const dir = env.CIRRUS_PUBLICATIONS_REPLAY;
  if (!dir || !env.CIRRUS_DATA || !(capture || env.CIRRUS_BACKGROUND === '1')) return null;
  return dir;
}
