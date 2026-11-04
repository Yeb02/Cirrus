import { type ReactNode, useRef, useState } from 'react';
import { carriesFiles } from '../../files/nodeFiles.ts';
import { dragRect, type Edge, type Rect } from './geometry.ts';

/** A floating panel's place and what its gestures do (Panels): where it is, how deep, pinned or not. */
export interface Frame {
  /** The panel's id, on its element (`data-panel`): Panels leaves a field of a panel it closes. */
  id: number;
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
 * the frame follows the pointer (its content is not drawn again); the panel's place is written once released. With
 * `onDropFiles`, files dragged over it are taken anywhere on it (a node's pop-up: plan 4a, task 4), the panel lit meanwhile.
 * `tools`: the panel's own buttons, before « épingler » (a file's preview: its full screen, task 5).
 */
export function FloatingPanel(props: {
  frame: Frame; title: ReactNode; tools?: ReactNode; className?: string; onDropFiles?(dt: DataTransfer): void; children: ReactNode;
}) {
  const f = props.frame;
  const [live, setLive] = useState<Rect | null>(null);
  // Files dragged over it: enter and leave come for each element crossed inside, counted.
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const takes = (e: React.DragEvent) => props.onDropFiles !== undefined && carriesFiles(e);
  const drops = {
    onDragEnter: (e: React.DragEvent) => { if (takes(e)) { depth.current++; setOver(true); } },
    onDragLeave: (e: React.DragEvent) => { if (takes(e) && --depth.current <= 0) { depth.current = 0; setOver(false); } },
    onDragOver: (e: React.DragEvent) => { if (takes(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } },
    onDrop: (e: React.DragEvent) => {
      if (!takes(e)) return;
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      props.onDropFiles!(e.dataTransfer);
    },
  };
  // The area it stays in is read once, when pressed, not at each move of the pointer.
  const gesture = useRef<{ edge: Edge; x: number; y: number; start: Rect; last: Rect; bounds: Rect } | null>(null);
  const press = (edge: Edge) => (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (edge === 'move' && (e.target as Element).closest(OWN_PRESS))) return;
    // No text selected on the way.
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { edge, x: e.clientX, y: e.clientY, start: f.rect, last: f.rect, bounds: f.bounds() };
  };
  const move = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    g.last = dragRect(g.start, g.edge, e.clientX - g.x, e.clientY - g.y, g.bounds, f.min);
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
      className={`panel${props.className ? ` ${props.className}` : ''}${f.pinned ? ' pinned' : ''}${over ? ' dropping' : ''}`} data-panel={f.id}
      style={{ left: r.x, top: r.y, width: r.w, height: r.h, zIndex: f.z }}
      onPointerDownCapture={() => f.onFront()}
      {...drops}
    >
      <header {...handles('move')}>
        <span className="grip" aria-hidden="true">⠿</span>
        {props.title}
        {/* Room to take the panel by, however long the title (it shrinks first). */}
        <span className="drag" aria-hidden="true" />
        {props.tools}
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
