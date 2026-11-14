import { paletteColors, type RenderParams } from '@cirrus/view';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { clickGuard } from './clickGuard.ts';

/**
 * A group's colour in this plan (plan 6b, D4): the palette's swatches (paletteColors), « Automatique » (null: the
 * default, from the parent's hue), and « Autre… », the system's picker, whose choice counts once it is closed (its
 * `change`), not at each move of its cursor: each choice is one action.
 */
export function ColorChoices(props: { color: string | null; params: RenderParams; onPick(color: string | null): void }) {
  const palette = useMemo(() => paletteColors(props.params), [props.params.groupPaletteHues, props.params.groupPaletteChroma, props.params.groupLightness]);
  const other = useRef<HTMLInputElement>(null);
  const pick = useRef(props.onPick);
  pick.current = props.onPick;
  useEffect(() => {
    const el = other.current!;
    const changed = () => pick.current(el.value.toLowerCase());
    el.addEventListener('change', changed);
    return () => el.removeEventListener('change', changed);
  }, []);
  // « Autre… » opens on the colour as it is now (a swatch, « Automatique », an undo since): never on a stale one.
  useEffect(() => { other.current!.value = props.color ?? palette[0]; }, [props.color, palette]);
  return (
    <div className="color-choices">
      <div className="swatches">
        {palette.map((c) => (
          <button
            key={c} className={c === props.color ? 'swatch on' : 'swatch'} style={{ background: c }} title={c} aria-label={c}
            onClick={() => props.onPick(c)}
          />
        ))}
      </div>
      <button className={props.color === null ? 'auto on' : 'auto'} onClick={() => props.onPick(null)}>Automatique</button>
      <label className={props.color !== null && !palette.includes(props.color) ? 'other on' : 'other'}>
        Autre…
        <input ref={other} type="color" defaultValue={props.color ?? palette[0]} />
      </label>
    </div>
  );
}

/**
 * The colour of a group from its menu (« Couleur… »), at the menu's point: it stays open to try another, and closes at
 * Escape or a press outside it, as a menu does.
 */
export function GroupColorPicker(props: { x: number; y: number; color: string | null; params: RenderParams; onPick(color: string | null): void; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(props.onClose);
  close.current = props.onClose;
  useLayoutEffect(() => {
    const el = ref.current!, r = el.getBoundingClientRect();
    el.style.left = `${props.x - Math.max(0, r.right - window.innerWidth)}px`;
    el.style.top = `${props.y - Math.max(0, r.bottom - window.innerHeight)}px`;
  }, [props.x, props.y]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close.current(); } };
    const away = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      clickGuard.dismissedBy(e);
      close.current();
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('pointerdown', away, true);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('pointerdown', away, true); };
  }, []);
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  return (
    <div ref={ref} className="menu context-menu color-picker" style={{ left: props.x, top: props.y }} onPointerDown={stop} onPointerMove={stop} onPointerUp={stop}>
      <ColorChoices color={props.color} params={props.params} onPick={props.onPick} />
    </div>
  );
}
