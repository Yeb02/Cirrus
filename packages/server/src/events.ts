import type { ServerResponse } from 'node:http';
import type { RemoteUnit } from '@cirrus/core';
import { MAX_JOURNAL_PAGE, SSE_PING_MS } from './bounds.ts';

// The event streams (plan 5a, D2): GET /events pushes each write accepted, numbered, to every paired PC listening,
// from where it resumes (Last-Event-ID). One frame per write, its number as its id: `id: <seq>`, `event: unit`,
// `data: <RemoteUnit as JSON>`. A comment (« : ping ») every SSE_PING_MS keeps the connection alive.

/** A write's frame: its number as its id, the write as one line of JSON (JSON.stringify writes no line break). */
const unitFrame = (u: RemoteUnit): string => `id: ${u.seq}\nevent: unit\ndata: ${JSON.stringify(u)}\n\n`;

interface Stream {
  res: ServerResponse;
  /** The number of the last write sent: the stream follows on from it. */
  cursor: number;
  /**
   * Live, it takes each write as it is accepted; otherwise it reads them from the journal, after `cursor`: while it
   * catches up, and when its connection holds no more for now (its buffer full), so that a slow PC never piles writes
   * up in the server's memory.
   */
  live: boolean;
  closed: boolean;
  /** Its token's hash, checked again at each ping: a PC revoked meanwhile has its stream closed. */
  tokenHash: string;
}

/** Resolves once `res` can take more (drain), or is gone (close). */
function drained(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

/**
 * The open streams. A write accepted goes to the live ones, serialised once for all; a stream that opens, or whose
 * buffer is full, reads the journal from its cursor by pages, and turns live only when a page comes back empty — read
 * and switched in one synchronous step, while every write is committed to the base before it is relayed (Canon.accept):
 * no write falls between the journal and the live relay, none is sent twice.
 */
export class Hub {
  private readonly streams = new Set<Stream>();
  /** The numbered writes after a number, whole, at least so many lines (LocalStore.unitsAfter). */
  private readonly read: (after: number, minLines: number) => RemoteUnit[];
  /** Whether a token's hash is still a paired PC's. */
  private readonly valid: (tokenHash: string) => boolean;
  private readonly timer: NodeJS.Timeout;

  constructor(read: (after: number, minLines: number) => RemoteUnit[], valid: (tokenHash: string) => boolean) {
    this.read = read;
    this.valid = valid;
    this.timer = setInterval(() => this.ping(), SSE_PING_MS);
    this.timer.unref();
  }

  /** A stream on `res`, following on from `after` (checked by the caller: a number of the journal, at the end of a write). */
  open(res: ServerResponse, after: number, tokenHash: string): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.flushHeaders();
    const st: Stream = { res, cursor: after, live: false, closed: false, tokenHash };
    this.streams.add(st);
    res.on('close', () => {
      st.closed = true;
      this.streams.delete(st);
    });
    void this.catchUp(st);
  }

  /** A write just accepted: to every live stream, serialised once. */
  publish(u: RemoteUnit): void {
    let frame: string | undefined;
    for (const st of this.streams) {
      if (!st.live || st.closed || u.seq <= st.cursor) continue;
      frame ??= unitFrame(u);
      st.cursor = u.seq;
      this.write(st, frame);
    }
  }

  /** Every stream ended (the server stops). */
  closeAll(): void {
    clearInterval(this.timer);
    for (const st of this.streams) {
      st.closed = true;
      st.res.end();
    }
    this.streams.clear();
  }

  /** Writes to `st`; a live stream whose buffer is full turns to reading the journal once it drains. */
  private write(st: Stream, text: string): void {
    if (st.res.write(text) || !st.live) return;
    st.live = false;
    void drained(st.res).then(() => this.catchUp(st));
  }

  /** Sends what the journal has after the stream's cursor, page by page, each page once the last has drained; then live. */
  private async catchUp(st: Stream): Promise<void> {
    while (!st.closed) {
      let units: RemoteUnit[];
      try {
        units = this.read(st.cursor, MAX_JOURNAL_PAGE);
      } catch (e) {
        console.error(`Flux d’événements interrompu : ${e instanceof Error ? e.message : String(e)}`);
        st.res.destroy();
        return;
      }
      if (units.length === 0) {
        st.live = true;
        return;
      }
      let room = true;
      for (const u of units) {
        room = st.res.write(unitFrame(u));
        st.cursor = u.seq;
      }
      if (!room) await drained(st.res);
    }
  }

  /** The comment that keeps each stream alive; a stream whose PC was revoked since (serveur.db, the command line) is ended. */
  private ping(): void {
    for (const st of this.streams) {
      if (st.closed) continue;
      if (!this.valid(st.tokenHash)) {
        st.closed = true;
        st.res.end();
        continue;
      }
      this.write(st, ': ping\n\n');
    }
  }
}
