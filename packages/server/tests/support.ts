import { createHash } from 'node:crypto';
import { type Action, type RemoteUnit, SNAPSHOT_VERSION, SYNC_PROTOCOL_VERSION, type Unit, type UnitResult, uuidv7 } from '@cirrus/core';
import { SCHEMA_VERSION } from '@cirrus/store';
import { Tokens } from '../src/tokens.ts';

// What the server's tests share: a code made as the command line makes one, the requests of a paired PC, a reader of
// the event stream.

export const T0 = Date.UTC(2026, 10, 8, 9);

export const sha256 = (b: string | Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** The format headers of /hello (D10), this build's. */
export const FORMAT = { 'Cirrus-Protocol': String(SYNC_PROTOCOL_VERSION), 'Cirrus-Schema': String(SCHEMA_VERSION), 'Cirrus-Snapshot': String(SNAPSHOT_VERSION) };

/** A pairing code for `name`, made in serveur.db as `jumeler` makes it (another connection, the server running or not). */
export function newCode(dataDir: string, name: string, now: number): string {
  const tokens = Tokens.open(dataDir);
  try {
    return tokens.createCode(name, now).code;
  } finally {
    tokens.close();
  }
}

export function pair(url: string, body: unknown): Promise<Response> {
  return fetch(`${url}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

/** A paired PC's requests: its token on each. */
export class Client {
  readonly url: string;
  readonly token: string;
  readonly pc: string;
  /** The time its writes carry. */
  at = T0;

  constructor(url: string, token: string, pc: string) {
    this.url = url;
    this.token = token;
    this.pc = pc;
  }

  get(path: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(this.url + path, { headers: { Authorization: `Bearer ${this.token}`, ...headers } });
  }

  send(method: string, path: string, body: unknown, contentType = 'application/json'): Promise<Response> {
    const data = typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body);
    return fetch(this.url + path, { method, headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': contentType }, body: data });
  }

  /** POST /units: the results, the answer checked to be a 200. */
  async units(units: unknown[]): Promise<UnitResult[]> {
    const res = await this.send('POST', '/units', { units });
    if (res.status !== 200) throw new Error(`POST /units : ${res.status} ${await res.text()}`);
    return ((await res.json()) as { results: UnitResult[] }).results;
  }

  async hello(): Promise<{ serverTime: number; lastSeq: number; empty: boolean; nodes: number }> {
    const res = await this.get('/hello', FORMAT);
    if (res.status !== 200) throw new Error(`GET /hello : ${res.status} ${await res.text()}`);
    return (await res.json()) as { serverTime: number; lastSeq: number; empty: boolean; nodes: number };
  }

  /** An action of this PC as one write. */
  unit(a: Action): Unit {
    return { unit: uuidv7(), action: a.id, label: a.label, at: this.at++, pc: this.pc, ops: a.ops };
  }
}

export interface SseEvent { id?: string; event?: string; data?: string }

/** An open event stream (GET /events): its events as they come, read by a fetch that `close` aborts. */
export class EventReader {
  private readonly events: SseEvent[] = [];
  private readonly abort = new AbortController();
  private wake: (() => void) | null = null;
  private ended = false;
  private buffer = '';

  private constructor() {}

  static async open(c: Client, from: { after?: number; lastEventId?: number } = {}): Promise<EventReader> {
    const r = new EventReader();
    const headers: Record<string, string> = { Authorization: `Bearer ${c.token}` };
    if (from.lastEventId !== undefined) headers['Last-Event-ID'] = String(from.lastEventId);
    const res = await fetch(`${c.url}/events${from.after === undefined ? '' : `?after=${from.after}`}`, { headers, signal: r.abort.signal });
    if (res.status !== 200) throw new Error(`GET /events : ${res.status} ${await res.text()}`);
    if (!res.headers.get('content-type')?.startsWith('text/event-stream')) throw new Error('GET /events : pas un flux');
    void r.pump(res.body!.pipeThrough(new TextDecoderStream()).getReader());
    return r;
  }

  private async pump(reader: ReadableStreamDefaultReader<string>): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this.buffer += value;
        for (let end; (end = this.buffer.indexOf('\n\n')) >= 0; ) {
          const frame = this.buffer.slice(0, end);
          this.buffer = this.buffer.slice(end + 2);
          const e: SseEvent = {};
          for (const line of frame.split('\n')) {
            if (line.startsWith(':')) continue;
            const at = line.indexOf(':'), field = line.slice(0, at), value = line.slice(at + 1).replace(/^ /, '');
            if (field === 'id' || field === 'event' || field === 'data') e[field] = value;
          }
          if (e.event !== undefined || e.data !== undefined) this.events.push(e);
        }
        this.wake?.();
      }
    } catch {
      // aborted by close, or the server gone
    } finally {
      this.ended = true;
      this.wake?.();
    }
  }

  /** The next `n` events, whatever they are. */
  async next(n: number, timeoutMs = 4000): Promise<SseEvent[]> {
    const limit = Date.now() + timeoutMs;
    while (this.events.length < n) {
      if (this.ended) throw new Error(`flux fermé après ${this.events.length} événements sur ${n}`);
      const left = limit - Date.now();
      if (left <= 0) throw new Error(`${this.events.length} événements sur ${n} reçus`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.wake = () => { clearTimeout(t); resolve(); };
      });
      this.wake = null;
    }
    return this.events.splice(0, n);
  }

  /** The next `n` writes relayed (event: unit), each checked to carry its number as its id. */
  async units(n: number, timeoutMs = 4000): Promise<RemoteUnit[]> {
    return (await this.next(n, timeoutMs)).map((e) => {
      if (e.event !== 'unit') throw new Error(`événement ${e.event} inattendu`);
      const u = JSON.parse(e.data!) as RemoteUnit;
      if (e.id !== String(u.seq)) throw new Error(`id ${e.id} pour le numéro ${u.seq}`);
      return u;
    });
  }

  /** The next shared settings changed (event: settings, task 6), without an id: the stream's numbers are the writes'. */
  async settings(timeoutMs = 4000): Promise<Record<string, unknown>> {
    const [e] = await this.next(1, timeoutMs);
    if (e.event !== 'settings' || e.id !== undefined) throw new Error(`événement ${e.event} (id ${e.id}) au lieu de réglages`);
    return JSON.parse(e.data!) as Record<string, unknown>;
  }

  /** The events received and not yet taken. */
  get queued(): number {
    return this.events.length;
  }

  /** Whether the server ended the stream. */
  get closed(): boolean {
    return this.ended;
  }

  close(): void {
    this.abort.abort();
  }
}
