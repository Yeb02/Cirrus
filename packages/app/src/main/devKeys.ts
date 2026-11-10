/** A key as Electron's `before-input-event` gives it (the fields read here). */
interface DevInput { type: string; key: string; control: boolean; shift: boolean; alt: boolean; meta: boolean }

/**
 * What the window keeps of the default menu's shortcuts in development (plan 6a, fix round 1: the window has no menu, so
 * that Alt makes no menu bar appear): Ctrl+R reloads the page, Ctrl+Maj+I opens the DevTools. Nothing else, on a key
 * going down only; in the built app, none (window.ts reads it with ELECTRON_RENDERER_URL set only).
 */
export function devShortcut(input: DevInput): 'reload' | 'devtools' | null {
  if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return null;
  const key = input.key.toLowerCase();
  if (key === 'r' && !input.shift) return 'reload';
  if (key === 'i' && input.shift) return 'devtools';
  return null;
}
