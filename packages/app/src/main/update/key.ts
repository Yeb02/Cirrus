import { testPickOf } from '../pick.ts';

// The public key of the signed updates (plan 9, D4): ed25519, SPKI DER in base64. Its private half is in GitHub's
// secrets only (CIRRUS_SIGNING_KEY), where the CI signs each version's manifest (scripts/signer-version.mjs). The pair
// is made once by `node deploy/cle-de-signature.mjs`, which writes the public key below and prints the private one,
// never written to the disk. Until then the placeholder stands, and no update is ever installed: no key, no update.

/** What UPDATE_PUBLIC_KEY holds until the pair is made: no key at all (manifest.ts: usableKey). */
export const KEY_PLACEHOLDER = 'PLACEHOLDER: run node deploy/cle-de-signature.mjs';

/** Written by deploy/cle-de-signature.mjs: keep this line as it is. */
export const UPDATE_PUBLIC_KEY: string = 'MCowBQYDK2VwAyEAOl80zoWGJ8rrb0joYa9vVWPsCoR7v1VjlUe5dWb5LAI=';

/**
 * The key the updates are checked with: UPDATE_PUBLIC_KEY; for the end-to-end check of task 4 only, a test pair's
 * (CIRRUS_UPDATE_PUBLIC_KEY), taken under testPickOf's rule — on a test base (CIRRUS_DATA) in a window out of the user's
 * way (capture, or CIRRUS_BACKGROUND=1) —, never on the user's own base.
 */
export function updateKeyOf(env: Record<string, string | undefined>, capture: boolean): string {
  return testPickOf(env, 'CIRRUS_UPDATE_PUBLIC_KEY', capture) ?? UPDATE_PUBLIC_KEY;
}

/**
 * Whether « Cirrus Dev » may update: never (spec 18.1), but for the end-to-end check, which runs « Cirrus Dev » so that
 * nothing it does can reach the user's base (%APPDATA%\@cirrus\app): CIRRUS_UPDATE_DEV=1, taken only together with the
 * test key (updateKeyOf's rule).
 */
export function devUpdatesOf(env: Record<string, string | undefined>, capture: boolean): boolean {
  return testPickOf(env, 'CIRRUS_UPDATE_PUBLIC_KEY', capture) !== null && testPickOf(env, 'CIRRUS_UPDATE_DEV', capture) === '1';
}

/** How this app updates (update/wire.ts): the key its manifests are checked with, whether it is held as « Cirrus Dev », whether it may install. */
export interface UpdateMode { publicKey: string; dev: boolean; neverInstall: boolean }

/**
 * The updater's mode, for a build that is « Cirrus Dev » (`dev`) or not. Any key but UPDATE_PUBLIC_KEY — a test key —
 * never installs, whatever the variant (review of task 4, I1): signed by a test pair, an update may be found, checked,
 * downloaded and armed, but its installer never runs, not even at a quit by accident, so that no check can put a
 * version on the machine. « Cirrus Dev » looks for updates only with CIRRUS_UPDATE_DEV=1 and the test key (devUpdatesOf).
 */
export function updateModeOf(env: Record<string, string | undefined>, capture: boolean, dev: boolean): UpdateMode {
  const publicKey = updateKeyOf(env, capture);
  return { publicKey, dev: dev && !devUpdatesOf(env, capture), neverInstall: publicKey !== UPDATE_PUBLIC_KEY };
}
