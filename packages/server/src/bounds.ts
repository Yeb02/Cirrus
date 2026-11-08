// The server's bounds (plan 5a, Global Constraints): named constants, not settings — the server serves every PC.

/**
 * The core's, which a PC's client respects too (task 3): the largest body of a request with writes (POST /units), and
 * of the other JSON requests of a paired PC; the most writes in one POST /units; the most hashes in one POST
 * /files/missing; the most operations in one write (parseUnit applies it).
 */
export { MAX_BODY_BYTES, MAX_HASHES_PER_REQUEST, MAX_OPS_PER_UNIT, MAX_UNITS_PER_REQUEST } from '@cirrus/core';

/**
 * The core's too (task 5, D7): the largest snapshot a PC sends when it seeds an empty server (POST /seed, streamed to a
 * temporary file, never held whole in memory while it arrives); the most lines in one page of a journal — one GET
 * /journal serves, one an event stream reads to catch up, one a seeding PC sends (POST /seed/journal).
 */
export { MAX_JOURNAL_PAGE, MAX_SEED_BYTES } from '@cirrus/core';

/** The largest body of POST /pair, the only route without a token: a code, an identifier and a name. */
export const MAX_PAIR_BODY_BYTES = 4096;

/** The largest file a PC sends (PUT /files/<hash>). */
export const MAX_FILE_BYTES = 2 ** 30;

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

/**
 * The shared settings (task 6, R24). The server does not know the PCs' settings (each PC bounds what it receives, by
 * withOverrides); it checks only their form, before anything is written:
 * - the most settings in one POST /settings, the core's (the PC's client cuts its changes to it);
 * - a setting's key: a plain identifier, a letter then letters, digits or `_`, MAX_SETTING_KEY_CHARS at most (the
 *   longest of today's is 22);
 * - a setting's value: its JSON, MAX_SETTING_VALUE_BYTES at most (the longest of today's, a list of LaTeX packages,
 *   holds a few hundred bytes);
 * - its time: whole milliseconds, from 0 to 2^53 − 1 (a time past it no longer grows by 1: review of task 6, Minor 4);
 * - the most settings the server keeps, MAX_SETTINGS_KEPT: GET /settings gives them all at each connection of each
 *   PC, so a request that would keep more is refused (review of task 6, Minor 3). Today's are 173.
 * The body itself is bounded by MAX_BODY_BYTES, as every JSON request of a paired PC.
 */
export { MAX_SETTINGS_PER_REQUEST } from '@cirrus/core';
export const MAX_SETTING_KEY_CHARS = 64;
export const MAX_SETTING_VALUE_BYTES = 64 * 1024;
export const MAX_SETTINGS_KEPT = 1000;
