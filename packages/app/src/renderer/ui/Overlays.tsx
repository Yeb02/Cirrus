const stop = (e: React.PointerEvent) => e.stopPropagation();

/** The groups under the cursor, from the top level down; a click frames one of them (spec 8.4, rappel discret). */
export function HierarchyCorner(props: { chain: { item: number; title: string }[]; onPick(item: number): void }) {
  if (props.chain.length === 0) return null;
  return (
    // Its pointer events stay here (I2 of the review): the graph below must not pan or re-hover while it is used.
    <div className="hierarchy" aria-label="Groupes sous le curseur" onPointerDown={stop} onPointerMove={stop} onPointerUp={stop}>
      {props.chain.map((g, i) => (
        <span key={g.item}>
          {i > 0 && <span className="sep">›</span>}
          <button onClick={() => props.onPick(g.item)}>{g.title}</button>
        </span>
      ))}
    </div>
  );
}

/** Names what a stub or a phantom stands for (spec 8.5, 11.3). */
export function Tooltip(props: { tip: { x: number; y: number; text: string } | null }) {
  if (!props.tip) return null;
  return <div className="tooltip" style={{ left: props.tip.x + 14, top: props.tip.y + 14 }}>{props.tip.text}</div>;
}
