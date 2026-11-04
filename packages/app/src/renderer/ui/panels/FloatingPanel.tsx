import { type ReactNode, useRef, useState } from 'react';
import { dragRect, type Edge, type Rect } from './geometry.ts';

/** A floating panel's place and what its gestures do (Panels): where it is, how deep, pinned or not. */
export interface Frame {
  rect: Rect; z: number; pinned: boolean;
  /** Its smallest side (panelMinPx), and the area it stays in (the window under the tabs). */
  min: number; bounds(): Rect;
  /** A move or a resize, once released. */
  onRect(rect: Rect): void;
  onFront(): void; onPin(): void; onClose(): void;
}

/** In the header, these keep their own press (the title is typed in, a button pressed): it does not move the panel. */
const OWN_PRESS = 'input, textarea, select, button, a';

const PinIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M5 1.5h6l-1 4.5 2.5 3h-4l-.5 6-.5-6h-4L6 6z" fill="currentColor" /></svg>
);

/**
 * A panel over the window (spec 12): moved by its header, resized by its right edge, its bottom edge or its corner,
 * pinned or closed by the header's buttons; a press anywhere on it brings it in front. While a gesture goes on, only
 * the frame follows the pointer (its content is not drawn again); the panel's place is written once released.
 */
export function FloatingPanel(props: { frame: Frame; title: ReactNode; className?: string; children: ReactNode }) {
  const f = props.frame;
  const [live, setLive] = useState<Rect | null>(null);
  const gesture = useRef<{ edge: Edge; x: number; y: number; start: Rect; last: Rect } | null>(null);
  const press = (edge: Edge) => (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (edge === 'move' && (e.target as Element).closest(OWN_PRESS))) return;
    // No text selected on the way.
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { edge, x: e.clientX, y: e.clientY, start: f.rect, last: f.rect };
  };
  const move = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    g.last = dragRect(g.start, g.edge, e.clientX - g.x, e.clientY - g.y, f.bounds(), f.min);
    setLive(g.last);
  };
  // Released, or the capture lost (a lost focus): the panel stays where it was shown.
  const release = () => {
    const g = gesture.current;
    if (!g) return;
    gesture.current = null;
    setLive(null);
    if (g.last !== g.start) f.onRect(g.last);
  };
  const handles = (edge: Edge) => ({ onPointerDown: press(edge), onPointerMove: move, onPointerUp: release, onLostPointerCapture: release });
  const r = live ?? f.rect;
  return (
    <section
      className={`panel${props.className ? ` ${props.className}` : ''}${f.pinned ? ' pinned' : ''}`}
      style={{ left: r.x, top: r.y, width: r.w, height: r.h, zIndex: f.z }}
      onPointerDownCapture={() => f.onFront()}
    >
      <header {...handles('move')}>
        <span className="grip" aria-hidden="true">⠿</span>
        {props.title}
        <button className={`pin${f.pinned ? ' on' : ''}`} title={f.pinned ? 'Détacher' : 'Épingler'} aria-pressed={f.pinned} onClick={() => f.onPin()}>
          <PinIcon />
        </button>
        <button className="close" title="Fermer" onClick={() => f.onClose()}>×</button>
      </header>
      <div className="body">{props.children}</div>
      <div className="resize e" {...handles('e')} />
      <div className="resize s" {...handles('s')} />
      <div className="resize se" {...handles('se')} />
    </section>
  );
}
