import { isIP } from 'node:net';
// The DOM's BodyInit, which this package's Node-only typings name by undici's (whose fetch is Node's).
import type { BodyInit } from 'undici-types';
import type { ConnectRequest, OpenDeps } from '../src/guard.ts';

/** What the tests of the open web share (plan 5b, D3): a fake web, its answers, bodies without end. Never the Internet. */

export const HTTPS_ONLY = 'Seules les adresses https sont acceptées.';
export const LOCAL = 'Adresse refusée : elle mène à une machine du réseau local.';
export const NO_PDF = 'Cette page ne mène à aucun PDF.';
/** Public addresses (example.com's), never reached: the connection is the fake's. */
export const PUBLIC = '93.184.215.14';
export const PUBLIC6 = '2606:2800:21f:cb07:6820:80da:af6b:8b2c';
export const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');

export const seconds = (ms: number) => `${(ms / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s`;

type Route = (req: ConnectRequest) => Response | Promise<Response>;

/**
 * A fake open web: `names`, what each name resolves to (an unknown name fails as getaddrinfo does; a function, a name
 * whose answer changes); `routes`, the answer of `<name><path>`, asked at its address. Records each resolution and each
 * connection.
 */
export function web(routes: Record<string, Route>, names: Record<string, string[] | (() => string[])> = {}, more: Partial<OpenDeps> = {}) {
  const resolved: string[] = [];
  const connected: ConnectRequest[] = [];
  const deps: OpenDeps = {
    resolve: async (host) => {
      resolved.push(host);
      const n = names[host];
      if (n === undefined) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return (typeof n === 'function' ? n() : n).map((address) => ({ address, family: isIP(address) === 6 ? 6 as const : 4 as const }));
    },
    connect: async (req) => {
      connected.push(req);
      const route = routes[`${req.hostname}${req.path}`];
      if (!route) throw Object.assign(new Error(`connect ECONNREFUSED ${req.address}:443`), { code: 'ECONNREFUSED' });
      return route(req);
    },
    timeoutMs: 2000,
    ...more,
  };
  return { deps, resolved, connected };
}

export const html = (body: BodyInit, status = 200, more: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...more } });
export const pdf = (body: BodyInit, more: Record<string, string> = {}) => new Response(body, { status: 200, headers: { 'content-type': 'application/pdf', ...more } });
export const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });

/**
 * A body of `chunk` bytes at a time (of « a », `first` first), without end or `count` of them, `everyMs` apart: the
 * chunks pulled, and whether it was cancelled.
 */
export function endless(chunk: number, count = Infinity, everyMs = 0, first?: Uint8Array) {
  const seen = { pulls: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (seen.pulls >= count) { c.close(); return; }
      seen.pulls++;
      if (everyMs > 0) await new Promise((r) => setTimeout(r, everyMs));
      c.enqueue(seen.pulls === 1 && first ? first : new Uint8Array(chunk).fill(0x61));
    },
    cancel() { seen.cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, seen };
}
