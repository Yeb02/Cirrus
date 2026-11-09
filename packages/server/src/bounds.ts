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

/**
 * The core's too, which parseOp and parseUnit apply to every write and journal line received (final review, Minor 3):
 * the longest identifier — a record's, a write's, an action's, a PC's (/pair's `pc` too), a tag key or a registry key a
 * write adds (R32: one its "before" holds already is not judged again) —, uuidv7 giving 36 characters; the longest label
 * of a write, in UTF-16 units (R20: the PC cuts a longer one before it leaves, the server refuses it).
 */
export { MAX_ID_CHARS, MAX_LABEL_CHARS } from '@cirrus/core';

/** The largest body of POST /pair, the only route without a token: a code, an identifier and a name. */
export const MAX_PAIR_BODY_BYTES = 4096;

/**
 * The longest pairing code /pair reads (an input without a token, final review, Minor 3): a code is 16 characters, 19
 * with its dashes; a longer one, spaces and all, is a body of the wrong shape (400), which counts against no code.
 */
export const MAX_PAIR_CODE_CHARS = 64;

/**
 * How long a write of serveur.db waits for another one (SQLite's busy timeout): the command line (`jumeler`,
 * `revoquer`) writes it while the server runs. Final review, Minor 3.
 */
export const SERVER_DB_BUSY_MS = 5000;

/** The largest file a PC sends (PUT /files/<hash>); a PDF the server imports for a PC too (POST /publications, plan 5b). */
export const MAX_FILE_BYTES = 2 ** 30;

/**
 * A publication imported by the server for a paired PC (plan 5b, task 3, D2: POST /publications), its network reached
 * only so, at the PC's explicit request:
 * - the request's body, MAX_PUBLICATION_BODY_BYTES at most: the text the user typed, MAX_ADDRESS_CHARS at most (the
 *   bound of @cirrus/sources, which the PC's own import holds to; an identifier, MAX_IDENTIFIER_CHARS), and the PC's caps.
 *   16 KiB holds the worst such body (final review of plan 5b, M1): each of the text's 2 048 UTF-16 units 6 bytes at most
 *   once in JSON (« \u0001 », a lone surrogate), 12 288 bytes, and four caps of 23 characters each at most;
 * - the imports under way at once, all PCs together, MAX_PUBLICATION_FETCHES at most (a 503 beyond): each holds a
 *   PDF whole in memory until it is stored;
 * - the PC's caps, its shared settings, brought under the server's: a metadata answer, or a page, MAX_PUBLICATION_META_BYTES
 *   at most (publicationMaxKb); a metadata exchange's delay, and a PDF's wait for data, MAX_PUBLICATION_TIMEOUT_MS
 *   (publicationTimeoutMs); a PDF's whole download, MAX_PUBLICATION_PDF_MS (publicationPdfMaxMs); a PDF's size,
 *   MAX_FILE_BYTES (maxImportMb), as a file a PC sends.
 */
export { MAX_ADDRESS_CHARS } from '@cirrus/sources';
export const MAX_PUBLICATION_BODY_BYTES = 16 * 1024;
export const MAX_PUBLICATION_FETCHES = 2;
export const MAX_PUBLICATION_META_BYTES = 8 * 2 ** 20;
export const MAX_PUBLICATION_TIMEOUT_MS = 60_000;
export const MAX_PUBLICATION_PDF_MS = 10 * 60_000;

/**
 * « .tex ouvert ailleurs » (plan 5b, task 5, D6: PUT /presence): the files a PC has open in full screen, its whole list
 * at each change, MAX_PRESENCE_ENTRIES at most (a PC has one full screen open: the bound only keeps serveur.db small);
 * its body, MAX_PRESENCE_BODY_BYTES at most (413 beyond). That is not room for every list the entry bound allows — 100
 * entries with long names, Chinese or Japanese ones of 3 bytes a character in UTF-8, would exceed it —, but a PC sends
 * one entry per full screen open, one at a time, a few hundred bytes: far below it.
 */
export const MAX_PRESENCE_ENTRIES = 100;
export const MAX_PRESENCE_BODY_BYTES = 64 * 1024;

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
 * - its time: whole milliseconds, from 0 to 2^53 − 1 (a time past it no longer grows by 1: review of task 6, Minor 4),
 *   and MAX_SETTING_AHEAD_MS (one day, the core's: the PC never stamps past it) ahead of the server's clock at most —
 *   a stamp further ahead would hold its setting against every other PC for as long (R26);
 * - the most settings the server keeps, MAX_SETTINGS_KEPT: GET /settings gives them all at each connection of each
 *   PC, so a request that would keep more is refused (review of task 6, Minor 3). Today's are 173.
 * The body itself is bounded by MAX_BODY_BYTES, as every JSON request of a paired PC.
 */
export { MAX_SETTING_AHEAD_MS, MAX_SETTINGS_PER_REQUEST } from '@cirrus/core';
export const MAX_SETTING_KEY_CHARS = 64;
export const MAX_SETTING_VALUE_BYTES = 64 * 1024;
export const MAX_SETTINGS_KEPT = 1000;
