import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const stop = (e: React.PointerEvent) => e.stopPropagation();

/**
 * The context menu (spec 9.1), at the click: the graph's (MenuItem of @cirrus/view), or a file's in a pop-up (plan 4a).
 * It stays in the window: moved up and left by what it would overflow (a file low in a pop-up at the window's bottom).
 * Escape or a click elsewhere closes it. Its Escape is taken first, and only closes it: a floating panel under it stays.
 * Closed by a press elsewhere, it hands that press to `onClose`: what the press lands on may then ignore the click it
 * begins, which only meant to close the menu (a file of a pop-up).
 */
export function ContextMenu<A extends string>(props: {
  x: number; y: number; items: { action: A; label: string }[]; onPick(action: A): void; onClose(press?: PointerEvent): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!, r = el.getBoundingClientRect();
    el.style.left = `${props.x - Math.max(0, r.right - window.innerWidth)}px`;
    el.style.top = `${props.y - Math.max(0, r.bottom - window.innerHeight)}px`;
  }, [props.x, props.y]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); props.onClose(); } };
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) props.onClose(e); };
    window.addEventListener('keydown', key, true);
    window.addEventListener('pointerdown', away, true);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('pointerdown', away, true); };
  }, []);
  return (
    <div ref={ref} className="menu context-menu" style={{ left: props.x, top: props.y }} role="menu" onPointerDown={stop} onPointerMove={stop} onPointerUp={stop}>
      {props.items.map((it) => (
        <button key={it.action} role="menuitem" onClick={() => { props.onClose(); props.onPick(it.action); }}>{it.label}</button>
      ))}
    </div>
  );
}

/** A title typed in place (creation, renaming): Enter keeps it, Escape or an empty field gives it up. */
export function TitleEditor(props: { x: number; y: number; width: number; initial: string; onDone(title: string | null): void }) {
  const [text, setText] = useState(props.initial);
  const done = useRef(false);
  const finish = (v: string | null) => { if (done.current) return; done.current = true; props.onDone(v); };
  return (
    <input
      className="title-editor"
      autoFocus
      style={{ left: props.x - props.width / 2, top: props.y - 16, width: props.width }}
      value={text}
      placeholder="Titre du nœud"
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(text);
        else if (e.key === 'Escape') finish(null);
      }}
      onBlur={() => finish(text)}
      onPointerDown={stop}
      onPointerMove={stop}
    />
  );
}

/** What follows the cursor during a gesture without a held button (spec 9.1): a node to place, a node leaving its group. */
export function Ghost(props: { x: number; y: number; text: string }) {
  return <div className="ghost" style={{ left: props.x, top: props.y }}>{props.text}</div>;
}
