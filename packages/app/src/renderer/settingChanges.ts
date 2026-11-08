import { DEFAULT_PARAMS, diffFromDefaults, type RenderParams, withOverrides } from '@cirrus/view';

// The interface's side of the shared settings (plan 5a, task 6, D9): what it writes is only what the user changed here,
// key by key — never the whole of them, which may hold a value received meanwhile and not yet shown —, and what it
// receives from the server comes in batches, applied at once.

const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * The settings changed here since `saved` (those last written, read or received): each key's new value, null when it is
 * back to its default (the main process then drops it from settings.json). Empty when nothing changed.
 */
export function localChanges(saved: RenderParams, now: RenderParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(now) as (keyof RenderParams)[]) {
    if (same(now[key], saved[key])) continue;
    out[key] = same(now[key], DEFAULT_PARAMS[key]) ? null : now[key];
  }
  return out;
}

/** `saved` with a batch received (key: value, null back to the default), bounded as a settings file is read (withOverrides). */
export function applyReceived(saved: RenderParams, changes: Record<string, unknown>): RenderParams {
  const overrides: Record<string, unknown> = diffFromDefaults(saved);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete overrides[key];
    else overrides[key] = value;
  }
  return withOverrides(overrides);
}

/**
 * The settings to show once a batch is received (`before` the settings saved until then, `after` with the batch): a key
 * of the batch the user changed here and that is not written yet keeps the user's value — it is written next, later
 * than the one received —, the others take the received one. Nothing changed here: `after` itself, which is then
 * saved as it is (nothing written back).
 */
export function keepUnsaved(params: RenderParams, before: RenderParams, after: RenderParams, keys: string[]): RenderParams {
  if (params === before) return after;
  const out: Record<string, unknown> = { ...params };
  for (const key of keys as (keyof RenderParams)[]) if (key in after && same(params[key], before[key])) out[key] = after[key];
  return out as unknown as RenderParams;
}
