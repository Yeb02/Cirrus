import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The settings differing from the defaults (spec 19: outside the history and undo). Local for now; plan 5 syncs them.
 * A missing or unreadable file gives no override, so the app always opens.
 */
export function readSettings(dir: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(join(dir, 'settings.json'), 'utf8');
  } catch {
    return {};
  }
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // reported below
  }
  console.warn('Réglages illisibles (settings.json) : valeurs par défaut utilisées.');
  return {};
}

/** Written to a temporary file then renamed: a crash never leaves half a file. */
export function writeSettings(dir: string, overrides: Record<string, unknown>): void {
  const tmp = join(dir, `settings.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(overrides, null, 2), 'utf8');
  renameSync(tmp, join(dir, 'settings.json'));
}
