import type { Graph } from './core.ts';

/**
 * Bench and capture modes (plan 3c, task 1): their windows may not hold the OS focus, and nothing they measure or show
 * may depend on it, nor on where the user's mouse lies. They lift the pause of the drawing and the gesture abandoned on
 * a lost focus, and ignore the physical pointer and keyboard; the normal mode keeps all three.
 */
export const measuring = () => window.cirrus.launch.bench !== undefined || window.cirrus.launch.capture === true;
/** A real input event in bench or capture mode: ignored (their replayed events are not trusted, the user's are). */
export const ignored = (ev: { isTrusted: boolean }) => ev.isTrusted && measuring();

/**
 * One phase of the pointer events a visual check replays (CIRRUS_POINTER, GraphView's drawing loop): « down 700 370
 * ctrl », « move », « up », « key », « wheel », « dbl » (a double click), and « click <selector> » or « press ctrl+c » for
 * what is not the pointer.
 */
export function replayPointer(graph: Graph, script: string): void {
  const { root, gestures, handles, feed, hitAt } = graph;
  for (const step of script.split(';').map((x) => x.trim()).filter(Boolean)) {
    if (step.startsWith('click ')) { document.querySelector<HTMLElement>(step.slice(6))?.click(); continue; }
    if (step.startsWith('press ')) {
      // Keys to the graph itself (Ctrl+C, Suppr…), where window-wide keys (--keys) do not go.
      const parts = step.slice(6).split('+');
      root.current?.dispatchEvent(new KeyboardEvent('keydown', { key: parts.pop()!, ctrlKey: parts.includes('ctrl'), bubbles: true }));
      continue;
    }
    const [t, xs, ys, ...mods] = step.split(/\s+/);
    const sx = Number(xs), sy = Number(ys), button = mods.includes('right') ? 2 : 0;
    // The same paths as the real pointer: a layout handle first, else the gesture machine.
    if (t === 'down') {
      if (button === 0 && !mods.includes('ctrl') && !gestures.current.busy && handles.grabHandle(sx, sy)) continue;
      feed({ t: 'down', button, sx, sy, ctrl: mods.includes('ctrl'), alt: mods.includes('alt'), shift: mods.includes('shift'), hit: hitAt(sx, sy) });
    } else if (t === 'move') {
      if (handles.held()) handles.dragHandle(sx, sy);
      else feed({ t: 'move', sx, sy });
    } else if (t === 'up') {
      if (handles.held()) handles.dropHandle(true);
      else feed({ t: 'up', button, sx, sy });
    }
    else if (t === 'key') feed({ t: 'key', key: xs });
    // The browser's dblclick after a « down; up » that was a click: the pop-up it opens (2026-11-11).
    else if (t === 'dbl') root.current?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
    else if (t === 'wheel') {
      const r = root.current!.getBoundingClientRect();
      root.current!.dispatchEvent(new WheelEvent('wheel', { clientX: sx + r.left, clientY: sy + r.top, deltaY: Number(mods[0] ?? -120), ctrlKey: mods.includes('ctrl'), cancelable: true }));
    }
  }
}
