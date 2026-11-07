import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { FetchFn } from './fetch.ts';

/**
 * Recorded answers instead of the network (plan 4c, task 4): the tests', and the built app's on a test base (the
 * interface's scenarios, the captures), which import a publication without touching the network. `<dir>/index.json`:
 *
 *   { "responses": [{ "url": "<address>", "accept": "<Accept>", "status": 302, "headers": { "location": "…" } },
 *                   { "url": "…", "accept": "…", "status": 200, "headers": { "content-type": "…" }, "body": "<file of dir>" }] }
 *
 * A request gets the first answer of its address whose `accept` is its Accept (or that has none); its body, if any,
 * the file's bytes. A request nothing answers fails as without a network (TypeError, « fetch failed »).
 */
interface Recorded { url: string; accept?: string; status: number; headers?: Record<string, string>; body?: string }

export function replayFetch(dir: string): FetchFn {
  return async (url, init) => {
    if (init.signal.aborted) throw init.signal.reason;
    // Read at each request: a scenario may change the folder between two imports.
    const { responses } = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { responses: Recorded[] };
    const r = responses.find((x) => x.url === url && (x.accept === undefined || x.accept === init.headers.Accept));
    if (!r) throw new TypeError(`fetch failed: aucune réponse enregistrée pour ${url}`);
    // A body is a file of the folder, never a path elsewhere.
    if (r.body !== undefined && (r.body !== basename(r.body) || r.body === '..')) throw new Error(`Réponse enregistrée invalide : ${r.body}`);
    const body = r.body === undefined ? null : new Uint8Array(readFileSync(join(dir, r.body)));
    return new Response(body, { status: r.status, headers: r.headers });
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
