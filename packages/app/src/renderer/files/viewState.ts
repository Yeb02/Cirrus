/** The key the views are kept under in the interface's storage. */
const KEY = 'cirrus.fileViews';

type View = Record<string, number>;

const isEntry = (e: unknown): e is [string, View] =>
  Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && typeof e[1] === 'object' && e[1] !== null && !Array.isArray(e[1])
  && Object.values(e[1]).every((x) => typeof x === 'number');

/**
 * Where each file was left in its view, by hash (plan 4a, « au même endroit »): a text's first visible line, a table's
 * scroll, an image's zoom and centre, a PDF's page. At most `max`: past it, the one saved longest ago goes. Kept in
 * `storage` (localStorage) from one session to the next, each access to it guarded: a storage that throws (full,
 * forbidden), is missing or holds something else leaves the views in memory only. One instance for the app: it reads
 * the storage once, and writes it whole at each set, so a view is saved when it is left, not at each scroll.
 */
export class ViewStates {
  private readonly storage: Storage | null;
  private readonly max: number;
  /** The oldest first: a Map keeps its insertion order. */
  private readonly views = new Map<string, View>();

  constructor(storage: Storage | null, max: number) {
    this.storage = storage;
    this.max = max;
    let saved: unknown = null;
    try {
      saved = JSON.parse(storage?.getItem(KEY) ?? 'null');
    } catch {
      // unreadable or refused: none kept
    }
    if (Array.isArray(saved)) for (const e of saved) if (isEntry(e)) this.views.set(e[0], e[1]);
    this.trim();
  }

  get(hash: string): View | undefined {
    return this.views.get(hash);
  }

  set(hash: string, v: View): void {
    this.views.delete(hash);
    this.views.set(hash, { ...v });
    this.trim();
    try {
      this.storage?.setItem(KEY, JSON.stringify([...this.views]));
    } catch {
      // full or refused: kept for this session only
    }
  }

  private trim(): void {
    for (const hash of this.views.keys()) {
      if (this.views.size <= this.max) break;
      this.views.delete(hash);
    }
  }
}
