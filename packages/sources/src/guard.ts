import { promises as dns } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';
import {
  type BodyRule, duration, MAX_REDIRECTS, mediaType, messageOf, NOT_FOUND, OFFLINE, readBody, REDIRECTS, Refusal, seconds, Transfer,
} from './transfer.ts';

/**
 * The open web, guarded (plan 5b, D3): the address of an article or of a PDF of any site, which the user gave. No list
 * of sites (each new conference would need a version of the app): any https address, on port 443, without credentials,
 * whose name resolves to public addresses only. The connection is made to the address checked, never to the name
 * again (a DNS that changes its mind between the check and the connection reaches nothing else); the name serves TLS
 * only. Each redirect is checked the same, 5 at most; every body is read under its cap, within a delay; the answers are
 * data. Reached only by an import the user asks for (fetch.ts), at the app's main process or at the server.
 */

/** A connection to make, to an address already checked (isPublic): what ConnectFn receives. */
export interface ConnectRequest {
  /** The address checked: the only one the connection may reach. */
  address: string;
  family: 4 | 6;
  /** The name, for TLS (its server name, the certificate's check) and the Host header only: never resolved again. */
  hostname: string;
  /** The path and the query asked. */
  path: string;
  headers: Record<string, string>;
  /** Aborts the connection (the delay, the end of the exchange). */
  signal: AbortSignal;
}

/** A GET to a checked address, its redirects never followed (a 3xx comes back as it is). */
export type ConnectFn = (req: ConnectRequest) => Promise<Response>;

/** The open web's network, handed in: the system's (systemResolve, httpsConnect), a replay, a test's fake. */
export interface OpenDeps {
  /** Every address of a name (dns.promises.lookup with `all`). */
  resolve(host: string): Promise<{ address: string; family: 4 | 6 }[]>;
  connect: ConnectFn;
  /** publicationTimeoutMs: the whole exchange's delay; a PDF's wait for data, once it is known to be one. */
  timeoutMs: number;
  /** publicationPdfMaxMs: a PDF's whole download at most, however steadily its data come (review of task 2, I2). */
  pdfMaxMs: number;
  /** Which addresses may be reached: D3's rule (isPublic) unless a test that serves on 127.0.0.1 says otherwise. */
  isPublic?(address: string): boolean;
  /** Where the causes the user is not shown go (the console). */
  log?(message: string): void;
}

/**
 * The caps of an answer, whose kind is known only from it: a page's text is read up to `page` bytes and no further
 * (its <meta> tags are in its head: the rest is let go); a PDF, said so by its type or its first bytes, up to `pdf`
 * bytes, refused beyond (a PDF cut short is none).
 */
export interface OpenCaps { page: number; pdf: number }

/**
 * An answer of the open web: its final address (after its redirects), its media type, whether it is a PDF (by its
 * first bytes, « %PDF- »), its bytes; or why not, in French.
 */
export type OpenAnswer =
  | { ok: true; url: string; type: string; pdf: boolean; bytes: Uint8Array }
  | { ok: false; message: string };

const HTTPS_ONLY = 'Seules les adresses https sont acceptées.';
const LOCAL = 'Adresse refusée : elle mène à une machine du réseau local.';
const PORT = 'Adresse refusée : seul le port 443 est accepté.';
const CREDENTIALS = 'Adresse refusée : elle contient un nom d’utilisateur ou un mot de passe.';
const USER_AGENT = 'Cirrus (import de publication)';
const mb = (bytes: number) => (bytes / 2 ** 20).toLocaleString('fr-FR', { maximumFractionDigits: 1 });

/** « %PDF- »: a PDF's first bytes. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];
const PDF_TYPES = new Set(['application/pdf', 'application/x-pdf']);

/**
 * D3's ranges, refused. IPv4: « this network », private, shared (CGNAT), loopback, link-local (the cloud's metadata,
 * 169.254.169.254), IETF protocol assignments, documentation, benchmarking, multicast, reserved and broadcast. IPv6:
 * D3's `::` and `::1` as all of `::/96` (with the deprecated IPv4-compatible addresses: no host of the Internet has
 * one), unique local, link-local, multicast, documentation, discard-only; and, since the review of task 2, the
 * local-use NAT64 prefix (`64:ff9b:1::/48`, RFC 8215, whose translator sits on the local network) and the deprecated
 * site-local addresses (`fec0::/10`). The IPv4 inside an IPv6 is judged as itself (isPublic).
 */
const BLOCKED = new BlockList();
for (const [a, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED.addSubnet(a, prefix, 'ipv4');
for (const [a, prefix] of [
  ['::', 96], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64], ['64:ff9b:1::', 48],
] as const) BLOCKED.addSubnet(a, prefix, 'ipv6');

/** The eight 16-bit groups of an IPv6 address (net.isIP says 6), its dotted IPv4 tail read as two groups. */
function groupsOf(address: string): number[] {
  let s = address.toLowerCase();
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (dotted) {
    const [b0, b1, b2, b3] = dotted.slice(1).map(Number);
    s = `${s.slice(0, dotted.index)}${((b0 << 8) | b1).toString(16)}:${((b2 << 8) | b3).toString(16)}`;
  }
  const halves = s.split('::');
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length < 2 || halves[1] === '' ? [] : halves[1].split(':');
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  return [...head, ...Array<string>(fill).fill('0'), ...tail].map((g) => parseInt(g, 16));
}

/** The IPv4 written in two 16-bit groups. */
const ipv4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * The IPv4 an IPv6 address carries, to be judged as itself, or null: IPv4-mapped (`::ffff:0:0/96`), SIIT
 * (`::ffff:0:0:0/96`) and NAT64 (`64:ff9b::/96`), in their last 32 bits; 6to4 (`2002::/16`), in its bits 16 to 47.
 */
function carriedIpv4(g: number[]): string | null {
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if ((zero(0, 5) && g[5] === 0xffff) || (zero(0, 4) && g[4] === 0xffff && g[5] === 0) || (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6))) {
    return ipv4Of(g[6], g[7]);
  }
  return g[0] === 0x2002 ? ipv4Of(g[1], g[2]) : null;
}

/**
 * Whether `address` may be reached (plan 5b, D3): an IPv4 or IPv6 address as a resolver writes one, out of every range
 * of BLOCKED; an IPv6 that carries an IPv4 (carriedIpv4) judged by that IPv4. Anything else (a name, an address with a
 * zone, a number the URL parser would read as one) is refused: never guessed.
 */
export function isPublic(address: string): boolean {
  if (typeof address !== 'string' || address.includes('%')) return false;
  const family = isIP(address);
  if (family === 4) return !BLOCKED.check(address, 'ipv4');
  if (family !== 6) return false;
  const v4 = carriedIpv4(groupsOf(address));
  if (v4 !== null) return !BLOCKED.check(v4, 'ipv4');
  return !BLOCKED.check(address, 'ipv6');
}

/** `href` as an address the open web may ask (D3): https, on port 443, without credentials. */
function checked(href: string): URL {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    throw new Refusal(HTTPS_ONLY);
  }
  if (url.protocol !== 'https:') throw new Refusal(HTTPS_ONLY);
  if (url.username !== '' || url.password !== '') throw new Refusal(CREDENTIALS);
  if (url.port !== '') throw new Refusal(PORT);
  return url;
}

const startsAsPdf = (bytes: Uint8Array) => bytes.length >= PDF_MAGIC.length && PDF_MAGIC.every((b, i) => bytes[i] === b);

/**
 * One answer of the open web to `href` (plan 5b, D3), whatever it does: never throws, a refusal is its message.
 * - The address is checked (checked); its name resolved, once, and every address it gives must be public (isPublic,
 *   or `deps.isPublic`), else nothing is asked; an address written in the URL (`https://2130706433/`, which the URL
 *   parser writes 127.0.0.1) is judged without resolution. The connection gets those addresses, an IPv4 first, the
 *   next only when a connection to one fails (review of task 2, M2); the name serves TLS only.
 * - A redirect is checked the same way, resolved again and judged again, 5 at most.
 * - A 404 or 410 is « Publication introuvable. », another status than 200 an error with its code.
 * - The body (readBody): its type tells what it is until its first bytes are in, then they do (a page said to be a PDF
 *   is a page: review of task 2, M3). A PDF is read up to `cap.pdf`, refused beyond (its declared length refused before
 *   any read); anything else up to `cap.page`, read no further.
 * - The delays (Transfer): the whole exchange's (`deps.timeoutMs`); once the body is a PDF, the longest wait for data,
 *   and `deps.pdfMaxMs` for its whole download.
 * Whatever the network does, the exchange is aborted once the answer is read or given up. `accept`: the Accept sent.
 */
export async function openFetch(href: string, deps: OpenDeps, accept: string, cap: OpenCaps): Promise<OpenAnswer> {
  const judge = deps.isPublic ?? isPublic;
  let site = '';
  let asked = href;
  const t = new Transfer(deps, {
    late: () => new Refusal(`Le site « ${site} » ne répond pas (délai de ${seconds(deps.timeoutMs)} dépassé).`),
    tooLong: () => new Refusal(`Le téléchargement du PDF a dépassé ${duration(deps.pdfMaxMs)} : arrêté.`),
    offline: (e) => {
      deps.log?.(`Publication, ${asked} : ${messageOf(e)}`);
      return new Refusal(OFFLINE);
    },
  });
  const drop = (res: Response) => { void res.body?.cancel().catch(() => {}); };
  const asPdf: BodyRule = { cap: cap.pdf, tooBig: new Refusal(`Le PDF fait plus de ${mb(cap.pdf)} Mo.`), stall: true };
  const asPage: BodyRule = { cap: cap.page, tooBig: null, stall: false };
  try {
    let url = checked(href);
    for (let redirects = 0; ; redirects++) {
      site = url.host;
      const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
      let found: string[];
      if (isIP(host) !== 0) found = [host];
      else {
        asked = host;
        const answer: unknown = await t.network(() => deps.resolve(host));
        found = Array.isArray(answer) ? answer.map((a: { address?: unknown } | null) => (typeof a?.address === 'string' ? a.address : '')) : [];
      }
      if (found.length === 0) throw new Refusal(OFFLINE);
      // Every address, not only the one used: a name that gives a public one and a local one is refused (D3).
      if (!found.every((a) => isIP(a) !== 0 && judge(a))) throw new Refusal(LOCAL);
      asked = url.href;
      let res: Response | null = null;
      for (const address of [...found.filter((a) => isIP(a) === 4), ...found.filter((a) => isIP(a) !== 4)]) {
        try {
          res = await t.network(() => deps.connect({
            address, family: isIP(address) === 6 ? 6 : 4, hostname: host, path: `${url.pathname}${url.search}`,
            headers: { Accept: accept, 'User-Agent': USER_AGENT }, signal: t.signal,
          }));
          break;
        } catch (e) {
          // The delay (or the exchange stopped otherwise): no other address. Else this connection failed, its cause
          // logged (`offline`): the next address checked is asked.
          if (t.signal.aborted) throw e;
        }
      }
      if (res === null) throw new Refusal(OFFLINE);
      if (REDIRECTS.has(res.status)) {
        drop(res);
        const location = res.headers.get('location');
        let next: URL;
        try {
          if (location === null) throw new Error();
          next = new URL(location, url);
        } catch {
          throw new Refusal(`Réponse inattendue du site « ${site} ».`);
        }
        if (redirects >= MAX_REDIRECTS) throw new Refusal(`Trop de redirections depuis « ${site} ».`);
        url = checked(next.href);
        continue;
      }
      if (res.status === 404 || res.status === 410) { drop(res); throw new Refusal(NOT_FOUND); }
      if (res.status !== 200) { drop(res); throw new Refusal(`Le site « ${site} » a répondu par une erreur (HTTP ${res.status}).`); }
      const type = mediaType(res.headers.get('content-type'));
      const typedPdf = PDF_TYPES.has(type);
      const { bytes, head } = await readBody(res, t, (first) => ((first === null ? typedPdf : startsAsPdf(first)) ? asPdf : asPage));
      return { ok: true, url: url.href, type, pdf: startsAsPdf(head), bytes };
    }
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, message: e.message };
    deps.log?.(`Publication, ${href} : ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return { ok: false, message: 'L’import de la publication a échoué : erreur inattendue.' };
  } finally {
    t.close();
  }
}

/** Every address of `host`, as the system resolves it (dns.promises.lookup, all of them): the production `resolve`. */
export async function systemResolve(host: string): Promise<{ address: string; family: 4 | 6 }[]> {
  const found = await dns.lookup(host, { all: true });
  return found.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
}

/** What httpsConnect asks of `https.request`. */
interface HttpsOptions {
  host: string;
  family: 4 | 6;
  port: 443;
  path: string;
  method: 'GET';
  servername?: string;
  agent: false;
  headers: Record<string, string>;
}
/** What httpsConnect needs of a ClientRequest. */
interface RequestLike {
  on(event: 'response', listener: (res: IncomingLike) => void): this;
  on(event: 'error', listener: (e: Error) => void): this;
  end(): void;
  destroy(error?: Error): void;
}
/** Node's IncomingMessage: a Readable, with its status and headers. */
interface IncomingLike { statusCode?: number; headers: Record<string, string | string[] | undefined> }

/** The statuses a Response cannot have a body with. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * The production ConnectFn (plan 5b, D3), over Node's `https.request`: to `req.address` itself, given as the host, so
 * that no resolution happens (the name of D3's `lookup` fixed to the address checked, without a lookup at all); the
 * name as the TLS server name, which the certificate is checked against (none for an address written in the URL), and
 * as Host. No shared agent (a pooled connection was made to another address), no cookie sent nor kept, no redirect
 * followed. The signal destroys the request, before an answer or while its body is read. Node's own certificates and
 * no proxy: Electron's net.request cannot be told which address to reach.
 */
export function httpsConnect(request: (options: HttpsOptions) => RequestLike = (options) => httpsRequest(options)): ConnectFn {
  return (req) => new Promise<Response>((resolve, reject) => {
    if (req.signal.aborted) { reject(req.signal.reason); return; }
    const literal = isIP(req.hostname);
    const r = request({
      host: req.address, family: req.family, port: 443, path: req.path, method: 'GET',
      ...(literal === 0 ? { servername: req.hostname } : {}),
      agent: false,
      headers: { Host: literal === 6 ? `[${req.hostname}]` : req.hostname, ...req.headers },
    });
    req.signal.addEventListener('abort', () => { r.destroy(req.signal.reason instanceof Error ? req.signal.reason : undefined); reject(req.signal.reason); }, { once: true });
    // A listener that throws would be an uncaught exception: what a server sent that a Response cannot hold rejects instead.
    r.on('response', (res) => {
      try {
        const status = res.statusCode ?? 0;
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          try {
            headers.set(k, Array.isArray(v) ? v.join(', ') : v);
          } catch {
            // a name or a value Headers refuses: left out
          }
        }
        // The same stream at run time; Node's and the DOM's typings of it differ.
        const body = NULL_BODY.has(status) ? null : Readable.toWeb(res as unknown as Readable) as unknown as ReadableStream<Uint8Array>;
        resolve(new Response(body, { status, headers }));
      } catch (e) {
        r.destroy();
        reject(e);
      }
    });
    r.on('error', reject);
    r.end();
  });
}
