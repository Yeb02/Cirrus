import { statSync } from 'node:fs';
import { readdir, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';

// The server's space (plan 5b, D8: GET /status): its base, its store — the size and the number of its files, counted
// once at the start in the background, then kept up to date at each file received —, and the free space of its disk.

const HASH = /^[0-9a-f]{64}$/;

/** The base's database files: SQLite's, and its WAL. */
const BASE_FILES = ['cirrus.db', 'cirrus.db-wal', 'cirrus.db-shm'];

/** The size of the base's database files in `baseDir` (a few stats, at each ask). */
export function baseBytes(baseDir: string): number {
  let n = 0;
  for (const f of BASE_FILES) n += statSync(join(baseDir, f), { throwIfNoEntry: false })?.size ?? 0;
  return n;
}

/** The free space of the disk that holds `dir`, for this user (bytes). */
export async function freeBytes(dir: string): Promise<number> {
  const s = await statfs(dir);
  return s.bavail * s.bsize;
}

/**
 * The store's size: its blobs (files/<2 hex>/<hash>) walked once at the start, in the background — the folders listed and
 * each blob's size read, never a file opened —, plus each blob placed since (`add`). What is known so far is given at
 * any time, `counting` until the walk ends. A blob placed while the walk runs is counted once: the walk passes over the
 * hashes `add` has had, and over those being placed (`placing`, said before the blob's rename into place: between the
 * rename and `add`, the walk could otherwise read it too — task 8a, from the review of task 7). The hashes added are
 * kept for the server's run (a few dozen bytes each), so that a blob received twice at once (two PCs sending the same
 * file) is counted once too.
 */
export class StoreSize {
  private readonly root: string;
  private walkedBytes = 0;
  private walkedFiles = 0;
  /** The blobs placed in this run, by hash: their sizes. */
  private readonly added = new Map<string, number>();
  private addedBytes = 0;
  /** The blobs being placed, by hash: how many placements of it are under way (two PCs may send the same file). */
  private readonly placingNow = new Map<string, number>();
  private closing = false;
  private counting = true;
  /** The walk, ended (it never rejects): what close awaits. */
  private readonly walked: Promise<void>;

  constructor(baseDir: string) {
    this.root = join(baseDir, 'files');
    this.walked = this.walk();
  }

  /**
   * A blob about to be placed (PUT /files), said before it can be renamed into place: the walk passes over its hash
   * until the placement ends, `add` (placed) or `abandon` (not placed). A placement made without a wait between its rename
   * and `add` (storeBytes, synchronous) needs none.
   */
  placing(hash: string): void {
    this.placingNow.set(hash, (this.placingNow.get(hash) ?? 0) + 1);
  }

  /** A placement said by `placing` that placed nothing (refused bytes, a failure): the hash no longer passed over for it. */
  abandon(hash: string): void {
    const n = (this.placingNow.get(hash) ?? 0) - 1;
    if (n > 0) this.placingNow.set(hash, n);
    else this.placingNow.delete(hash);
  }

  /** A blob just placed in the store (never one that was there before: the caller checks); its `placing`, if any, ended. */
  add(hash: string, size: number): void {
    if (this.placingNow.has(hash)) this.abandon(hash);
    if (this.added.has(hash)) return;
    this.added.set(hash, size);
    this.addedBytes += size;
  }

  /** What is known now. */
  get(): { storeBytes: number; storeFiles: number; counting: boolean } {
    return { storeBytes: this.walkedBytes + this.addedBytes, storeFiles: this.walkedFiles + this.added.size, counting: this.counting };
  }

  /** The walk stopped where it is, and awaited: the server closes. */
  async close(): Promise<void> {
    this.closing = true;
    await this.walked;
  }

  /** Each folder of two hexadecimal digits, its blobs' sizes read at once; a temporary, or a name that is not a hash, aside. */
  private async walk(): Promise<void> {
    try {
      const dirs = await readdir(this.root).catch(() => [] as string[]);
      for (const d of dirs) {
        if (this.closing) return;
        if (!/^[0-9a-f]{2}$/.test(d)) continue;
        const names = (await readdir(join(this.root, d)).catch(() => [] as string[])).filter((n) => HASH.test(n) && n.startsWith(d));
        const sizes = await Promise.all(names.map(async (n) => {
          const st = await stat(join(this.root, d, n)).catch(() => null);
          return st?.isFile() ? st.size : null;
        }));
        names.forEach((n, i) => {
          const size = sizes[i];
          // Placed meanwhile, or being placed: counted by add.
          if (size === null || this.added.has(n) || this.placingNow.has(n)) return;
          this.walkedBytes += size;
          this.walkedFiles++;
        });
      }
    } catch (e) {
      console.warn(`Taille du magasin non comptée : ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.counting = false;
    }
  }
}
