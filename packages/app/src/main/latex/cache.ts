import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type CompiledPdf, type CompileRequest, isStandalone, type KnownLabel } from '@cirrus/core';
import { DRIVER_VERSION } from './driver.ts';

/** What the cache keeps beside a PDF, in <key>.json. */
interface CacheMeta { pages: number; labels: KnownLabel[]; log: string; passes: number }

const KEY = /^[0-9a-f]{64}$/;
const ENTRY = /^([0-9a-f]{64})\.(pdf|json)$/;
/**
 * The files of the folder statted at once while it is listed (load): enough to keep the disk busy, few enough that
 * the main process serves its other work between two batches. Not a setting: it changes nothing one sees.
 */
const STAT_BATCH = 256;

/** A PDF of the cache: its bytes and its description's. */
interface Entry { bytes: number }

/**
 * The compiled PDFs (plan 4b, D2): <dir>/<key>.pdf, and its labels, log and passes in <key>.json, the key being the hash
 * of everything that goes into the compilation. Local to this PC: never synced (spec 13).
 *
 * Capped at maxBytes(): once over it, the PDFs used longest ago go, down to trimToBytes() (latexCacheTrimPercent of
 * the ceiling), so that the next puts find room without trimming again (final review, I3). The entries are kept in
 * memory in the order they were last used, the one used longest ago first (a Map, each use moving its entry to the
 * end): trimming takes the first ones, and sorts nothing. Their files are deleted in the background, one entry at a
 * time (a tenth of the cache is hundreds of files, about 0.35 ms each, measured, which the main process would wait
 * for); one put or read again meanwhile is kept. The folder is listed once a session, by load(), in the background
 * (its PDFs' dates give the earlier sessions' order, a read refreshing its PDF's date); meanwhile a get looks for its
 * key's two files alone, and what is used, put or removed is kept as it happens.
 */
export class PdfCache {
  readonly dir: string;
  private readonly maxBytes: () => number;
  private readonly trimToBytes: () => number;
  private index = new Map<string, Entry>();
  private total = 0;
  /** The listing of the folder, once started; `listed` once it is merged into the index. */
  private loading: Promise<void> | null = null;
  private listed = false;
  /** The keys removed while the folder is listed: the listing may have seen their files. */
  private readonly removedWhileListing = new Set<string>();
  /** The keys trimmed whose files are still to delete (deleteTrimmed); one used again leaves the set, and is kept. */
  private readonly trimmed = new Set<string>();
  private deleting: Promise<void> = Promise.resolve();

  constructor(dir: string, maxBytes: () => number, trimToBytes: () => number = maxBytes) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.trimToBytes = trimToBytes;
  }

  /** The bytes the cache holds, as far as it knows: every entry once listed. */
  get bytes(): number {
    return this.total;
  }

  /** Resolves once the files of every entry trimmed so far are deleted. */
  settled(): Promise<void> {
    return this.deleting;
  }

  /**
   * The SHA-256 of the driver's version, the engine, the mode, the snippet's width (in that mode only), the preamble (but
   * for a standalone document, compiled without it), the source, the injected labels and citations, and the node's files
   * by name (name and hash). Never the slot nor the `known` hint: a compilation that receives other numbers redoes them.
   */
  key(req: CompileRequest, engine: string): string {
    const ref = (r: { label: string; title: string; node: string | null }) => ({ label: r.label, title: r.title, node: r.node });
    const cite = (c: { key: string; text: string; node: string }) => ({ key: c.key, text: c.text, node: c.node });
    const resources = [...req.resources].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((r) => ({ name: r.name, hash: r.hash }));
    return createHash('sha256').update(JSON.stringify([
      DRIVER_VERSION, engine, req.mode, req.mode === 'snippet' ? req.widthCm : null, isStandalone(req.source) ? null : req.preamble, req.source,
      req.refs.map(ref), req.broken, req.doubled.map(ref), req.cites.map(cite), req.doubledCites.map(cite), req.unknownCites, resources,
    ])).digest('hex');
  }

  /**
   * The PDF of `key` and what goes with it, now the one used last; null if either file is missing or unreadable (both
   * then go). Once the folder is listed, a key it does not hold is a miss without a look at the disk.
   */
  get(key: string): { pdf: CompiledPdf; labels: KnownLabel[]; log: string; passes: number } | null {
    if (!KEY.test(key)) return null;
    const known = this.index.get(key);
    if (!known && this.listed) return null;
    const pdf = this.pdfPath(key);
    try {
      const size = statSync(pdf).size;
      const json = readFileSync(this.metaPath(key), 'utf8');
      const meta = JSON.parse(json) as Partial<CacheMeta>;
      if (typeof meta.pages !== 'number' || !Array.isArray(meta.labels) || typeof meta.log !== 'string' || typeof meta.passes !== 'number') throw new Error('meta');
      this.use(key, known ?? { bytes: size + Buffer.byteLength(json) });
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
    this.use(key, { bytes: size + Buffer.byteLength(json) });
    if (this.total > this.maxBytes()) this.trim(key);
    return { key, size, pages: meta.pages };
  }

  /**
   * Once over the ceiling, down to trimToBytes(), the PDF used longest ago first (`keep` excepted): the entries leave the
   * index at once, their files are deleted in the background (deleteTrimmed).
   */
  trim(keep?: string): void {
    if (this.total <= this.maxBytes()) return;
    const low = Math.min(this.trimToBytes(), this.maxBytes());
    const gone: string[] = [];
    for (const [key, e] of this.index) {
      if (this.total <= low) break;
      if (key === keep) continue;
      this.index.delete(key);
      this.total -= e.bytes;
      if (this.loading && !this.listed) this.removedWhileListing.add(key);
      this.trimmed.add(key);
      gone.push(key);
    }
    if (gone.length > 0) this.deleting = this.deleting.then(() => this.deleteTrimmed(gone));
  }

  /** The files of `keys`, one entry at a time, but for an entry put or read again since it was trimmed. */
  private async deleteTrimmed(keys: string[]): Promise<void> {
    for (const key of keys) {
      if (!this.trimmed.delete(key)) continue;
      for (const p of [this.pdfPath(key), this.metaPath(key)]) {
        await rm(p, { force: true }).catch((err: unknown) => console.warn(`Cache LaTeX : ${p} n’a pas pu être effacé :`, err));
      }
    }
  }

  /**
   * Lists the folder, once a session, in the background (the service's start), STAT_BATCH files at a time: its entries
   * join the index as used before any of this session, the oldest PDF first, then the cache is trimmed if it is over
   * its ceiling. A PDF without its description, a description without its PDF, and any other file go — but for a key
   * this session used, put or removed meanwhile, which the index knows better.
   */
  load(): Promise<void> {
    this.loading ??= this.list();
    return this.loading;
  }

  private async list(): Promise<void> {
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch {
      // not made yet
    }
    const found = new Map<string, { bytes: number; time: number; pdf: boolean; meta: boolean }>();
    const strays: string[] = [];
    for (let i = 0; i < names.length; i += STAT_BATCH) {
      await Promise.all(names.slice(i, i + STAT_BATCH).map(async (name) => {
        const m = ENTRY.exec(name);
        let st;
        try {
          st = await stat(join(this.dir, name));
        } catch {
          return;
        }
        if (!m || !st.isFile()) {
          strays.push(name);
          return;
        }
        const e = found.get(m[1]) ?? { bytes: 0, time: 0, pdf: false, meta: false };
        e.bytes += st.size;
        if (m[2] === 'pdf') {
          e.pdf = true;
          e.time = st.mtimeMs;
        } else e.meta = true;
        found.set(m[1], e);
      }));
    }
    const fresh = (key: string) => !this.index.has(key) && !this.removedWhileListing.has(key);
    const listed = new Map<string, Entry>();
    for (const [key, e] of [...found].filter(([key]) => fresh(key)).sort((a, b) => a[1].time - b[1].time)) {
      if (!e.pdf || !e.meta) {
        this.remove(key);
        continue;
      }
      listed.set(key, { bytes: e.bytes });
      this.total += e.bytes;
    }
    // Before this session's: used longer ago.
    for (const [key, e] of this.index) listed.set(key, e);
    this.index = listed;
    this.listed = true;
    this.removedWhileListing.clear();
    for (const name of strays) await rm(join(this.dir, name), { recursive: true, force: true }).catch(() => {});
    this.trim();
  }

  /** `key` is the entry used last, now `e` (no longer to delete, if it was trimmed). */
  private use(key: string, e: Entry): void {
    this.trimmed.delete(key);
    const before = this.index.get(key);
    if (before) {
      this.total -= before.bytes;
      this.index.delete(key);
    }
    this.index.set(key, e);
    this.total += e.bytes;
  }

  private pdfPath(key: string): string {
    return join(this.dir, `${key}.pdf`);
  }

  private metaPath(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  private remove(key: string): void {
    this.trimmed.delete(key);
    const e = this.index.get(key);
    if (e) {
      this.total -= e.bytes;
      this.index.delete(key);
    }
    if (this.loading && !this.listed) this.removedWhileListing.add(key);
    for (const p of [this.pdfPath(key), this.metaPath(key)]) {
      try {
        rmSync(p, { force: true });
      } catch (err) {
        console.warn(`Cache LaTeX : ${p} n’a pas pu être effacé :`, err);
      }
    }
  }
}
