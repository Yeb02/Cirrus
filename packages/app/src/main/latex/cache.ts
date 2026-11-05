import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CompiledPdf, CompileRequest, KnownLabel } from '@cirrus/core';
import { DRIVER_VERSION, isStandalone } from './driver.ts';

/** What the cache keeps beside a PDF, in <key>.json. */
export interface CacheMeta { pages: number; labels: KnownLabel[]; log: string; passes: number }

const KEY = /^[0-9a-f]{64}$/;
const ENTRY = /^([0-9a-f]{64})\.(pdf|json)$/;

/** A PDF of the cache: its bytes and its description's, and when it was last used (an order, not a date). */
interface Entry { bytes: number; used: number }

/**
 * The compiled PDFs (plan 4b, D2): <dir>/<key>.pdf, and its labels, log and passes in <key>.json, the key being the hash
 * of everything that goes into the compilation. Capped at maxBytes(), the PDF used longest ago leaving first. The
 * entries are listed once, from the folder (a PDF's date says when it was last used, a read refreshing it), then kept in
 * memory: a compilation never lists the folder. Local to this PC: never synced (spec 13).
 */
export class PdfCache {
  readonly dir: string;
  private readonly maxBytes: () => number;
  private index: Map<string, Entry> | null = null;
  private total = 0;
  private clock = 0;

  constructor(dir: string, maxBytes: () => number) {
    this.dir = dir;
    this.maxBytes = maxBytes;
  }

  /**
   * The SHA-256 of the driver's version, the engine, the mode, the snippet's width (in that mode only), the preamble (but
   * for a standalone document, compiled without it), the source, the injected labels and citations, and the node's files
   * by name (name and hash). Never the slot nor the `known` hint: a compilation that receives other numbers redoes them.
   */
  key(req: CompileRequest, engine: string, widthCm: number): string {
    const ref = (r: { label: string; title: string; node: string | null }) => ({ label: r.label, title: r.title, node: r.node });
    const resources = [...req.resources].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((r) => ({ name: r.name, hash: r.hash }));
    return createHash('sha256').update(JSON.stringify([
      DRIVER_VERSION, engine, req.mode, req.mode === 'snippet' ? widthCm : null, isStandalone(req.source) ? null : req.preamble, req.source,
      req.refs.map(ref), req.broken, req.doubled.map(ref), req.cites.map((c) => ({ key: c.key, text: c.text, node: c.node })), req.unknownCites, resources,
    ])).digest('hex');
  }

  /** The PDF of `key` and what goes with it, now the one used last; null if either file is missing or unreadable (both then go). */
  get(key: string): { pdf: CompiledPdf; labels: KnownLabel[]; log: string; passes: number } | null {
    if (!KEY.test(key)) return null;
    const entries = this.entries();
    if (!entries.has(key)) return null;
    const pdf = this.pdfPath(key);
    try {
      const size = statSync(pdf).size;
      const meta = JSON.parse(readFileSync(this.metaPath(key), 'utf8')) as Partial<CacheMeta>;
      if (typeof meta.pages !== 'number' || !Array.isArray(meta.labels) || typeof meta.log !== 'string' || typeof meta.passes !== 'number') throw new Error('meta');
      entries.get(key)!.used = ++this.clock;
      const now = new Date();
      utimesSync(pdf, now, now); // for the next session's order
      return { pdf: { key, size, pages: meta.pages }, labels: meta.labels, log: meta.log, passes: meta.passes };
    } catch {
      this.remove(key);
      return null;
    }
  }

  /**
   * Moves the PDF pdfLaTeX just wrote into the cache under `key` (its date is now), with its description, then trims the
   * cache if it is over its ceiling (never this PDF).
   */
  put(key: string, pdfPath: string, meta: CacheMeta): CompiledPdf {
    const entries = this.entries();
    mkdirSync(this.dir, { recursive: true });
    const pdf = this.pdfPath(key);
    try {
      renameSync(pdfPath, pdf);
    } catch {
      // another volume, or a file held: copied instead
      copyFileSync(pdfPath, pdf);
      unlinkSync(pdfPath);
    }
    // After the PDF: a description without its PDF is never read; one cut short is a miss (get).
    const json = JSON.stringify(meta);
    writeFileSync(this.metaPath(key), json);
    const size = statSync(pdf).size;
    this.total -= entries.get(key)?.bytes ?? 0;
    entries.set(key, { bytes: size + Buffer.byteLength(json), used: ++this.clock });
    this.total += size + Buffer.byteLength(json);
    if (this.total > this.maxBytes()) this.trim(key);
    return { key, size, pages: meta.pages };
  }

  /** Down to the ceiling, the PDF used longest ago first (`keep` excepted). */
  trim(keep?: string): void {
    const entries = this.entries();
    if (this.total <= this.maxBytes()) return;
    for (const [key] of [...entries].filter(([k]) => k !== keep).sort((a, b) => a[1].used - b[1].used)) {
      if (this.total <= this.maxBytes()) break;
      this.remove(key);
    }
  }

  /**
   * The entries, listed from the folder the first time, the oldest PDF first; a PDF without its description, a
   * description without its PDF, and any other file go.
   */
  private entries(): Map<string, Entry> {
    if (this.index) return this.index;
    const found = new Map<string, { bytes: number; time: number; pdf: boolean; meta: boolean }>();
    let names: string[] = [];
    try {
      names = readdirSync(this.dir);
    } catch {
      // not made yet
    }
    for (const name of names) {
      const m = ENTRY.exec(name);
      let st;
      try {
        st = statSync(join(this.dir, name));
      } catch {
        continue;
      }
      if (!m || !st.isFile()) {
        rmSync(join(this.dir, name), { recursive: true, force: true });
        continue;
      }
      const e = found.get(m[1]) ?? { bytes: 0, time: 0, pdf: false, meta: false };
      e.bytes += st.size;
      if (m[2] === 'pdf') {
        e.pdf = true;
        e.time = st.mtimeMs;
      } else e.meta = true;
      found.set(m[1], e);
    }
    this.index = new Map();
    this.total = 0;
    for (const [key, e] of [...found].sort((a, b) => a[1].time - b[1].time)) {
      if (!e.pdf || !e.meta) {
        for (const p of [this.pdfPath(key), this.metaPath(key)]) rmSync(p, { force: true });
        continue;
      }
      this.index.set(key, { bytes: e.bytes, used: ++this.clock });
      this.total += e.bytes;
    }
    return this.index;
  }

  private pdfPath(key: string): string {
    return join(this.dir, `${key}.pdf`);
  }

  private metaPath(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  private remove(key: string): void {
    const e = this.index?.get(key);
    if (e) {
      this.total -= e.bytes;
      this.index!.delete(key);
    }
    for (const p of [this.pdfPath(key), this.metaPath(key)]) {
      try {
        rmSync(p, { force: true });
      } catch (err) {
        console.warn(`Cache LaTeX : ${p} n’a pas pu être effacé :`, err);
      }
    }
  }
}
