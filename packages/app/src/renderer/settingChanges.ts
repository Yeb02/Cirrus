import { DEFAULT_PARAMS, diffFromDefaults, type RenderParams, sameSetting, withOverrides } from '@cirrus/view';

// The interface's side of the shared settings (plan 5a, task 6, D9): what it writes is only what the user changed here,
// key by key — never the whole of them, which may hold a value received meanwhile and not yet shown —, and what it
// receives from the server comes in batches, applied at once.

/**
 * The change of one setting in the panel (its field, its ↺), as an update of App's state: applied to the latest
 * settings, never to those of the render the panel was drawn from — a batch received just before, not yet rendered,
 * stays (review of task 6, Important 1). Bounded as the panel's change always was (withOverrides).
 */
export const withSetting = (key: keyof RenderParams, value: unknown) => (p: RenderParams): RenderParams => withOverrides({ ...p, [key]: value });

/**
 * The settings changed here since `saved` (those last written, read or received): each key's new value, null when it is
 * back to its default (the main process then drops it from settings.json). Empty when nothing changed.
 */
export function localChanges(saved: RenderParams, now: RenderParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(now) as (keyof RenderParams)[]) {
    if (sameSetting(now[key], saved[key])) continue;
    out[key] = sameSetting(now[key], DEFAULT_PARAMS[key]) ? null : now[key];
  }
  return out;
}

/**
 * What App's save timer sends when it fires (review of task 6, round 2): the changes of `params`, those of the render
 * that set the timer, over `saved` as it is now — or nothing (null) when `saved` is no longer `base`, the settings saved
 * when the timer was set. A batch received meanwhile, not rendered yet, would otherwise be sent back with its old values;
 * its render sets the timer again, over it.
 */
export function dueChanges(base: RenderParams, saved: RenderParams, params: RenderParams): Record<string, unknown> | null {
  return saved === base ? localChanges(saved, params) : null;
}

/**
 * `saved` with a batch received (key: value, null back to the default), bounded as a settings file is read
 * (withOverrides); `saved` itself when the batch changes nothing (the usual answer to a save).
 */
export function applyReceived(saved: RenderParams, changes: Record<string, unknown>): RenderParams {
  const overrides: Record<string, unknown> = diffFromDefaults(saved);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete overrides[key];
    else overrides[key] = value;
  }
  const after = withOverrides(overrides);
  return Object.keys(changes).every((key) => sameSetting(after[key as keyof RenderParams], saved[key as keyof RenderParams])) ? saved : after;
}

/**
 * The settings to show once a batch is received (`before` the settings saved until then, `after` with the batch): a key
 * of the batch the user changed here and that is not written yet keeps the user's value — it is written next, later
 * than the one received —, the others take the received one. Nothing changed here: `after` itself, which is then
 * saved as it is (nothing written back). A key that is no setting takes nothing.
 */
export function keepUnsaved(params: RenderParams, before: RenderParams, after: RenderParams, keys: string[]): RenderParams {
  if (params === before) return after;
  const out: Record<string, unknown> = { ...params };
  for (const key of keys as (keyof RenderParams)[]) if (Object.hasOwn(after, key) && sameSetting(params[key], before[key])) out[key] = after[key];
  return out as unknown as RenderParams;
}
