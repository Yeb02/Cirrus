import { afterEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import type { RemoteUnit } from '@cirrus/core';
import { SSE_PING_MS } from '../src/bounds.ts';
import { Hub } from '../src/events.ts';

afterEach(() => { vi.useRealTimers(); });

/** A response that keeps what is written; `full` makes write answer that its buffer is full, until 'drain'. */
class FakeResponse extends EventEmitter {
  readonly text: string[] = [];
  full = false;
  ended = false;
  writeHead(): this { return this; }
  flushHeaders(): void {}
  write(s: string): boolean {
    this.text.push(s);
    return !this.full;
  }
  end(): void {
    this.ended = true;
    this.emit('close');
  }
  destroy(): void { this.end(); }
  /** The numbers of the writes received, in order. */
  get seqs(): number[] {
    return this.text.filter((t) => t.startsWith('id: ')).map((t) => (JSON.parse(t.split('\ndata: ')[1]) as RemoteUnit).seq);
  }
}

const unit = (seq: number): RemoteUnit => ({ unit: `u${seq}`, action: `a${seq}`, label: 'Modifier', at: seq, pc: 'pc-a', ops: [{ t: 'preamble', before: null, after: { text: String(seq) } }], seq });

test('flux : rattrape le journal, puis le direct ; un tampon plein repasse par le journal, sans trou ni doublon', async () => {
  const journal = [unit(1), unit(2)];
  const hub = new Hub((after) => journal.filter((u) => u.seq > after), () => true);
  try {
    const res = new FakeResponse(), other = new FakeResponse();
    hub.open(res as unknown as ServerResponse, 0, 'h');
    hub.open(other as unknown as ServerResponse, 2, 'h');
    expect(res.seqs).toEqual([1, 2]);
    expect(other.seqs).toEqual([]);
    // Each frame: its number as its id, one line of JSON.
    expect(res.text[0]).toBe(`id: 1\nevent: unit\ndata: ${JSON.stringify(unit(1))}\n\n`);
    journal.push(unit(3));
    hub.publish(unit(3));
    expect([res.seqs, other.seqs]).toEqual([[1, 2, 3], [3]]);
    // A slow PC: its buffer full, the next writes wait in the journal, not in the server's memory.
    res.full = true;
    journal.push(unit(4));
    hub.publish(unit(4));
    journal.push(unit(5));
    hub.publish(unit(5));
    expect([res.seqs, other.seqs]).toEqual([[1, 2, 3, 4], [3, 4, 5]]);
    res.full = false;
    res.emit('drain');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(res.seqs).toEqual([1, 2, 3, 4, 5]);
    journal.push(unit(6));
    hub.publish(unit(6));
    expect([res.seqs, other.seqs]).toEqual([[1, 2, 3, 4, 5, 6], [3, 4, 5, 6]]);
    // Gone: no more writes to it.
    other.end();
    hub.publish(unit(7));
    expect(other.seqs).toEqual([3, 4, 5, 6]);
  } finally {
    hub.closeAll();
  }
});

test('flux : un commentaire toutes les SSE_PING_MS ; le flux d’un PC révoqué entre-temps est fermé', () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const revoked = new Set<string>();
  const hub = new Hub(() => [], (hash) => !revoked.has(hash));
  try {
    const a = new FakeResponse(), b = new FakeResponse();
    hub.open(a as unknown as ServerResponse, 0, 'ha');
    hub.open(b as unknown as ServerResponse, 0, 'hb');
    vi.advanceTimersByTime(SSE_PING_MS);
    expect([a.text, b.text]).toEqual([[': ping\n\n'], [': ping\n\n']]);
    revoked.add('hb');
    vi.advanceTimersByTime(SSE_PING_MS);
    expect([a.text.length, a.ended, b.text.length, b.ended]).toEqual([2, false, 1, true]);
  } finally {
    hub.closeAll();
  }
});
