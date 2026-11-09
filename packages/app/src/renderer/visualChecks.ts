import { viewsSettled } from './files/read.ts';
import type { GraphHandle } from './ui/GraphView.tsx';

/**
 * Visual checks, once the first frame is drawn (App): CIRRUS_IMPORT="sx,sy|path" drops that file at that point of the
 * graph, by the drop's own path (captures only); then CIRRUS_CLICK=".gear" clicks those elements — an entry
 * "type:<text>" types that text where the focus is, as the keyboard would (an editor: plan 4b, task 8) —,
 * CIRRUS_KEYS="ctrl+z,Delete" presses those keys; the capture waits for the files' views they opened to settle (their
 * file read, their code and language loaded). Then, the views settled, the page says it is ready (cirrus:ready).
 */
export async function replayLaunch(graph: { readonly current: GraphHandle | null }): Promise<void> {
  const [at, ...dropped] = (window.cirrus.launch.import ?? '').split('|').filter(Boolean);
  const clicks = (window.cirrus.launch.click ?? '').split(',').filter(Boolean);
  const keys = (window.cirrus.launch.keys ?? '').split(',').filter(Boolean);
  if (dropped.length > 0) {
    const [sx, sy] = at.split(',').map(Number);
    await graph.current?.dropFilesAt(sx, sy, dropped);
  }
  // Each click waits for what the views it opened load (a PDF's reader, its pages, a compilation): the next one
  // acts on them.
  for (const sel of clicks) {
    if (sel.startsWith('type:')) document.execCommand('insertText', false, sel.slice(5));
    else document.querySelector<HTMLElement>(sel)?.click();
    await new Promise((r) => setTimeout(r, 300));
    await viewsSettled();
  }
  for (const combo of keys) {
    const parts = combo.split('+');
    const key = parts.pop()!;
    window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: parts.includes('ctrl'), shiftKey: parts.includes('shift'), altKey: parts.includes('alt') }));
    await new Promise((r) => setTimeout(r, 150));
  }
  await viewsSettled();
  window.cirrus.ready();
}
