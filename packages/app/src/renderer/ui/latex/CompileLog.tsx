import type { TexError } from '@cirrus/core';
import { useEffect, useRef } from 'react';

/** The banner's words for a compilation's error: its line when it is the source's. */
export function errorText(e: TexError): string {
  if (e.where === 'preamble') return e.message;
  return e.line !== null ? `Erreur ligne ${e.line} : ${e.message}` : `Erreur : ${e.message}`;
}

/**
 * A compilation's log (plan 4b, task 5), over its preview: the error TeX stopped at first — a click on it, when it is
 * on a line of the source, takes the editor there (`onJump`) —, then pdfLaTeX's log as it is, its error lines marked,
 * scrolled to its end. Escape or × closes it, and only it.
 */
export function CompileLog(props: { log: string; error: TexError | null; onJump?(line: number): void; onClose(): void }) {
  const { error } = props;
  const body = useRef<HTMLPreElement>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = body.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [props.log]);
  useEffect(() => { root.current?.focus({ preventScroll: true }); }, []);
  const jump = error && error.where === 'source' && error.line !== null && props.onJump ? error.line : null;
  return (
    <div
      ref={root} className="compile-log" role="dialog" aria-label="Journal de compilation" tabIndex={-1}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); props.onClose(); } }}
    >
      <header>
        <span className="title">Journal de compilation</span>
        <span className="spacer" />
        <button className="close" title="Fermer le journal (Échap)" onClick={() => props.onClose()}>×</button>
      </header>
      {error && (
        jump !== null
          ? <button className="error" title="Aller à cette ligne" onClick={() => props.onJump!(jump)}>{errorText(error)}</button>
          : <p className="error">{errorText(error)}</p>
      )}
      <pre ref={body}>
        {props.log === '' ? <span className="dim">Aucun journal.</span> : props.log.split(/\r?\n/).map((line, i) => (
          <span key={i} className={line.startsWith('!') ? 'bang' : undefined}>{line}{'\n'}</span>
        ))}
      </pre>
    </div>
  );
}
