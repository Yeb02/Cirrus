// Reading an event stream (text/event-stream, plan 5a D2), as the HTML specification reads it: lines ended by \n, \r\n
// or \r; a blank line dispatches the event; « : … » is a comment (the server's pings); data lines joined by \n; the
// last id seen kept for the next events; an event left unfinished at the end is dropped.

interface SseEvent { id: string | null; event: string; data: string }

/**
 * The events of `body`, as they come. Its bytes are decoded as UTF-8 across chunks, and each line is put together from
 * its pieces once: an event of any size costs its length, never more. `signal` aborted: the stream cancelled, the
 * reading ended. `heard`, told at each chunk received, a comment's (a ping) included: the stream is alive (plan 9,
 * review of task 2, M2).
 */
export async function* readEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal, heard?: () => void): AsyncGenerator<SseEvent> {
  const reader = body.getReader(), decoder = new TextDecoder();
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  let id: string | null = null, event = '', data: string[] = [], dataSeen = false;
  /** The current line's pieces, from the chunks it spans; whether the last chunk ended on a \r (a \n may follow). */
  let pieces: string[] = [], afterCr = false;
  /** One line: a field of the event under way, or its end. */
  const line = (text: string): SseEvent | null => {
    if (text === '') {
      const out = dataSeen ? { id, event: event || 'message', data: data.join('\n') } : null;
      event = '';
      data = [];
      dataSeen = false;
      return out;
    }
    if (text.startsWith(':')) return null;
    const colon = text.indexOf(':');
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      data.push(value);
      dataSeen = true;
    } else if (field === 'event') {
      event = value;
    } else if (field === 'id' && !value.includes('\u0000')) {
      id = value;
    }
    return null;
  };
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) return;
      if (value.length > 0) heard?.();
      // A character split between two chunks is decoded once whole (an empty text: nothing yet).
      const text = decoder.decode(value, { stream: true });
      if (text === '') continue;
      let at = 0;
      if (afterCr && text.startsWith('\n')) at = 1;
      afterCr = false;
      // The next \n and \r, each searched again only once passed (−1: none left in this chunk).
      let lf = text.indexOf('\n', at), cr = text.indexOf('\r', at);
      while (at < text.length) {
        if (lf >= 0 && lf < at) lf = text.indexOf('\n', at);
        if (cr >= 0 && cr < at) cr = text.indexOf('\r', at);
        const end = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
        if (end < 0) {
          pieces.push(text.slice(at));
          break;
        }
        pieces.push(text.slice(at, end));
        const e = line(pieces.length === 1 ? pieces[0] : pieces.join(''));
        pieces = [];
        if (e) yield e;
        at = end + 1;
        if (text.charCodeAt(end) === 13) {
          if (at === text.length) afterCr = true;
          else if (text.charCodeAt(at) === 10) at++;
        }
      }
    }
  } finally {
    // Ended early (the caller stopped reading) or not, nothing is left open.
    signal?.removeEventListener('abort', cancel);
    cancel();
  }
}
