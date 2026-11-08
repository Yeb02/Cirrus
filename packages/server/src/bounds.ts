// The server's bounds (plan 5a, Global Constraints): named constants, not settings — the server serves every PC.

/** The largest body of a request with writes (POST /units), and of the other JSON requests of a paired PC. */
export const MAX_BODY_BYTES = 64 * 2 ** 20;

/** The largest body of POST /pair, the only route without a token: a code, an identifier and a name. */
export const MAX_PAIR_BODY_BYTES = 4096;

/** The most writes in one POST /units. */
export const MAX_UNITS_PER_REQUEST = 100;

/** The most operations in one write: the core's (parseUnit applies it). */
export { MAX_OPS_PER_UNIT } from '@cirrus/core';

/** The largest file a PC sends (PUT /files/<hash>). */
export const MAX_FILE_BYTES = 2 ** 30;

/** The largest snapshot a PC sends when it seeds an empty server (task 5, D7). */
export const MAX_SEED_BYTES = 2 * 2 ** 30;

/** The most lines in one page of the journal (GET /journal), and in one page an event stream reads to catch up. */
export const MAX_JOURNAL_PAGE = 10_000;

/** The most hashes in one POST /files/missing. */
export const MAX_HASHES_PER_REQUEST = 10_000;

/** The longest name of a paired PC: the one `jumeler` gives, and the one the PC gives of itself. */
export const MAX_PC_NAME_CHARS = 100;

/** The pause between two comments (« : ping ») on an open event stream: it keeps the connection alive, and checks its token. */
export const SSE_PING_MS = 15_000;

/** How long a pairing code lives (D3). */
export const PAIRING_TTL_MS = 10 * 60_000;

/** The wrong /pair attempts that burn the pending codes (D3). */
export const PAIRING_TRIES = 5;

/** The writes accepted between two snapshots of the server's state (it writes one at its stop too). */
export const SERVER_SNAPSHOT_UNITS = 500;
