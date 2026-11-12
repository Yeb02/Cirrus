import { useEffect, useRef } from 'react';
import { passesKey, type UpdateScreen as Screen } from '../sync/updateScreen.ts';

/** The keys the screen holds: none reaches the page under it; Enter and Space on its button, and Alt+F4, act (passesKey). */
const HELD = ['keydown', 'keyup', 'keypress'] as const;

/** The screen up: its button, if it has one. */
let shown: { button: HTMLButtonElement | null } | null = null;

// Heard at the window, in its capture, before any other listener: this module is loaded with App, before any component
// listens — so that a question's Enter (AskDialog), a context menu's keys or Ctrl+K, which listen there too, never act
// under the screen.
for (const type of HELD) {
  window.addEventListener(type, (e: KeyboardEvent) => {
    if (!shown) return;
    e.stopImmediatePropagation();
    if (!passesKey(e.key, shown.button !== null && e.target === shown.button, e.altKey)) e.preventDefault();
  }, { capture: true });
}

/**
 * The forced update's screen (2026-11-11; plan 9, D4: sync/updateScreen.ts): over the whole window, above everything —
 * the veil, the full screens, the notifications —, it blocks the app. The pointer stops on it; every key is taken at the
 * window, before anything else, and goes no further — Enter and Space on its button still press it. The focus goes to
 * its button when it has one, to itself otherwise, out of any field being edited.
 */
export function UpdateScreen(props: { screen: Screen; onContinue(): void }) {
  const { screen } = props;
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    shown = { button: button.current };
    (button.current ?? box.current)?.focus();
  }, [screen.action]);
  useEffect(() => () => { shown = null; }, []);
  return (
    <div
      ref={box} className="update-screen" role="alertdialog" aria-modal="true" aria-labelledby="update-screen-title" tabIndex={-1}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="update-box">
        <h2 id="update-screen-title">{screen.title}</h2>
        <p>{screen.line}</p>
        {screen.percent !== null && (
          <div className="update-progress" role="progressbar" aria-valuenow={screen.percent} aria-valuemin={0} aria-valuemax={100}>
            <div style={{ width: `${screen.percent}%` }} />
            <span>{`${screen.percent} %`}</span>
          </div>
        )}
        {screen.action && <button ref={button} type="button" onClick={props.onContinue}>{screen.action}</button>}
      </div>
    </div>
  );
}
