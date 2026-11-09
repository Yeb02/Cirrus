import { Readable } from 'node:stream';
import type { FetchFn } from '@cirrus/sources';

/** What requestFetch needs of Electron's net.request: a ClientRequest's few calls and events. */
interface RequestLike {
  setHeader(name: string, value: string): void;
  on(event: 'redirect', listener: (statusCode: number, method: string, redirectUrl: string) => void): this;
  on(event: 'response', listener: (response: IncomingLike) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  abort(): void;
  end(): void;
}
/** Electron's IncomingMessage: a Node Readable, with its status and headers. */
interface IncomingLike { statusCode: number; headers: Record<string, string | string[]> }
interface RequestOptions { url: string; method: 'GET'; redirect: 'manual'; credentials: 'omit'; cache: 'no-store' }

/** The statuses a Response cannot have a body with. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * The production FetchFn, over Electron's net.request (its network stack: the system's proxy and certificates, as
 * TinyTeX's download): net.fetch cannot give a redirect back (in `manual` mode, Electron 45 rejects it, « Redirect was
 * cancelled »; in `follow`, it hides where it went). A redirect is answered here as its status and its Location, the
 * request stopped before Electron follows it; @cirrus/sources (fetch.ts) checks the target and asks it, or not. No
 * cookie is sent nor kept, no cache used. The signal aborts the request, before an answer or while its body is read.
 * It stays in the app when the rest of the publications' network moved to @cirrus/sources (plan 5b, D2): Electron's.
 */
export function requestFetch(request: (options: RequestOptions) => RequestLike): FetchFn {
  return (url, init) => new Promise<Response>((resolve, reject) => {
    if (init.signal.aborted) { reject(init.signal.reason); return; }
    const req = request({ url, method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store' });
    init.signal.addEventListener('abort', () => { req.abort(); reject(init.signal.reason); }, { once: true });
    req.setHeader('Accept', init.headers.Accept);
    // A listener that throws would be an uncaught exception of the main process: what a server sent that a Response
    // cannot hold (a status out of range, a header value refused) rejects instead.
    const settle = (make: () => Response) => {
      try {
        resolve(make());
      } catch (e) {
        req.abort();
        reject(e);
      }
    };
    req.on('redirect', (status, _method, location) => {
      req.abort();
      settle(() => new Response(null, { status, headers: { location } }));
    });
    req.on('response', (res) => settle(() => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        try {
          headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
        } catch {
          // a name or a value Headers refuses: left out
        }
      }
      // The same stream at run time; Node's and the DOM's typings of it differ.
      const body = NULL_BODY.has(res.statusCode) ? null : Readable.toWeb(res as unknown as Readable) as unknown as ReadableStream<Uint8Array>;
      return new Response(body, { status: res.statusCode, headers });
    }));
    req.on('error', reject);
    req.end();
  });
}
