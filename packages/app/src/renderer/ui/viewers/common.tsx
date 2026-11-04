import type { FileRef } from '@cirrus/core';
import type { RenderParams } from '@cirrus/view';
import { useEffect, useRef } from 'react';
import { ReadError } from '../../files/read.ts';
import type { ViewStates } from '../../files/viewState.ts';

/** What every view is given (Viewer): the file, the settings (ceilings, sizes), the places kept (« au même endroit »). */
export interface ViewProps { file: FileRef; params: RenderParams; views: ViewStates; mode: 'preview' | 'full' }

/**
 * A text kind's view when its bytes are not text (decodeText). Text, code, LaTeX and tables are never handed to the
 * system's application (controller's ruling, task 4): no button offers it.
 */
export const BINARY = 'Fichier binaire : Cirrus ne peut pas l’afficher.';

/** A message in the middle of a view: reading, unreadable, nothing to show. */
export const Message = (props: { text: string }) => <p className="viewer-message">{props.text}</p>;

/** A view that is only a message (no view yet, or none). */
export const Notice = (props: { text: string }) => <div className="viewer"><Message text={props.text} /></div>;

/** A banner over a view: what a head read leaves out. */
export const Banner = (props: { lines: string[] }) => (props.lines.length === 0 ? null : <p className="viewer-banner">{props.lines.join(' ')}</p>);

/** Why a view could not read its file, in French (readHead's ReadError, or a generic sentence), its cause in the console. */
export function readFailure(name: string, e: unknown): string {
  console.error(`Lecture de « ${name} » :`, e);
  return e instanceof ReadError ? e.message : `« ${name} » n’a pas pu être lu.`;
}

type View = Record<string, number>;

/** The views shown now: each saves where it is (keepOpenViews). */
const open = new Set<() => void>();

/**
 * Where a view is (« au même endroit », plan 4a): the view writes its place in the ref as it changes (a scroll, a
 * zoom), and it is kept in `views` under the file's hash once the view is left — unmounted, or the window closing
 * (keepOpenViews) — never at each scroll. The view reads the place kept itself, once it opens (keptView), after a view
 * of the same file it replaces saved its own (React runs the cleanups of a commit before its new effects).
 */
export function useKeptView(views: ViewStates, hash: string): { current: View | null } {
  const now = useRef<View | null>(null);
  useEffect(() => {
    const save = () => { if (now.current) views.set(hash, now.current); };
    open.add(save);
    return () => { open.delete(save); save(); };
  }, [views, hash]);
  return now;
}

/** The window closes (App's onQuit): the views still open keep their place, as if left. */
export function keepOpenViews(): void {
  for (const save of open) save();
}

/** The place kept for `hash`, as a copy (ViewStates.get gives its own record). */
export function keptView(views: ViewStates, hash: string): View | undefined {
  const v = views.get(hash);
  return v ? { ...v } : undefined;
}
