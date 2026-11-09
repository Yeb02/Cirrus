import { fetchPublication } from '../src/fetch.ts';
import { openFetch } from '../src/guard.ts';

/**
 * A body of `count` one-byte pieces after « %PDF- », each its own buffer as a chunked server's are, read by openFetch
 * (`open`) or by the arXiv PDF's exchange (`arxiv`). Run by transfer.test.ts in a Node of its own, its heap bounded:
 * memory must follow the bytes, not the pieces (review of task 2, I1). Prints its result as JSON.
 */
const count = Number(process.argv[2]);
const which = process.argv[3];

function pieces(): ReadableStream<Uint8Array> {
  let i = 0;
  // `empty`: `count` empty pieces first, then « %PDF- » alone (an injected network may send them; none is kept).
  return new ReadableStream<Uint8Array>(which === 'empty'
    ? { pull(c) { if (i < count) c.enqueue(new Uint8Array(0)); else if (i === count) c.enqueue(new TextEncoder().encode('%PDF-')); else c.close(); i++; } }
    : {
      pull(c) {
        if (i === 0) c.enqueue(new TextEncoder().encode('%PDF-'));
        else if (i <= count) c.enqueue(new Uint8Array([0x61]));
        else c.close();
        i++;
      },
    }, { highWaterMark: 0 });
}
const pdf = () => new Response(pieces(), { headers: { 'content-type': 'application/pdf' } });
const limits = { timeoutMs: 60_000, pdfMaxMs: 600_000 };

const t0 = performance.now();
let result: { ok: boolean; size?: number; message?: string };
if (which === 'open' || which === 'empty') {
  const a = await openFetch('https://editeur.example/a.pdf', {
    ...limits, resolve: async () => [{ address: '93.184.215.14', family: 4 }], connect: async () => pdf(),
  }, 'application/pdf', { page: 1024, pdf: 4 * 2 ** 20 });
  result = a.ok ? { ok: a.pdf, size: a.bytes.length } : { ok: false, message: a.message };
} else {
  const meta = (accept: string) => new Response(accept.includes('csl') ? '{"title":"T"}' : '@misc{x, title={T}}', { headers: { 'content-type': accept } });
  const r = await fetchPublication({ arxiv: '1706.03762' }, {
    ...limits, maxKb: 64, maxPdfBytes: 4 * 2 ** 20,
    fetch: async (url, init) => (url.includes('/pdf/') ? pdf() : meta(init.headers.Accept)),
    store: (name, bytes) => ({ name, hash: 'h', size: bytes.length }),
  });
  result = r.ok ? { ok: r.pdf !== undefined, size: r.pdf?.size, message: r.pdfMessage } : { ok: false, message: r.message };
}
console.log(JSON.stringify({ ...result, ms: Math.round(performance.now() - t0) }));
