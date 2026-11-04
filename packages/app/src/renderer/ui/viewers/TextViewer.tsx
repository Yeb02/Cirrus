import { defaultKeymap } from '@codemirror/commands';
import { syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view';
import { classHighlighter } from '@lezer/highlight';
import { useEffect, useRef, useState } from 'react';
import { decodeText } from '../../files/decode.ts';
import { loading, MB, readHead } from '../../files/read.ts';
import { Banner, BINARY, keptView, Message, readFailure, useKeptView, type ViewProps } from './common.tsx';
import { languageFor, PHRASES_FR } from './language.ts';
import { truncationNotice } from './views.ts';

/**
 * The editor's look, in the palette of styles.css (its variables); the tokens' colours are there too, by the classes of
 * classHighlighter (`.tok-keyword`…).
 */
const THEME = EditorView.theme({
  '&': { height: '100%', color: 'var(--ink)', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'Consolas, monospace', fontSize: '12.5px', lineHeight: '1.45' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--muted)', borderRight: '1px solid rgba(143, 184, 255, 0.14)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 10px', opacity: '0.7' },
  '.cm-cursor': { borderLeftColor: 'var(--ink)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'rgba(143, 184, 255, 0.3)' },
  '.cm-selectionMatch': { backgroundColor: 'rgba(143, 184, 255, 0.16)' },
  '.cm-searchMatch': { backgroundColor: 'rgba(255, 217, 160, 0.22)', outline: '1px solid rgba(255, 217, 160, 0.45)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(255, 217, 160, 0.5)' },
  '.cm-panels': { backgroundColor: 'var(--sky1)', color: 'var(--ink)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid rgba(143, 184, 255, 0.25)' },
  '.cm-panel.cm-search': { padding: '4px 8px 6px', fontSize: '12.5px' },
  '.cm-textfield': { backgroundColor: 'var(--sky0)', border: '1px solid rgba(143, 184, 255, 0.3)', borderRadius: '5px', color: 'var(--ink)' },
  '.cm-button': {
    backgroundImage: 'none', backgroundColor: 'var(--sky2)', border: '1px solid var(--edge)', borderRadius: '5px', color: 'var(--ink)',
  },
  '.cm-panel.cm-search [name=close]': { color: 'var(--muted)', fontSize: '16px' },
}, { dark: true });

/** Escape leaves the full screen or closes the panel (it is CodeMirror's only to close its search panel). */
const KEYS = keymap.of([...searchKeymap, ...defaultKeymap.filter((b) => b.key !== 'Escape')]);

/**
 * Text and code (plan 4a, D3): the first textViewMaxMb of the file (readHead), decoded (decodeText: a binary is said so),
 * in a read-only CodeMirror 6 — line numbers, search (Ctrl+F), only the lines in view drawn —, coloured by its
 * language (languageFor, loaded once the text is shown), long lines wrapped for prose (`wrap`). Its first visible line
 * is kept by its hash. In full screen it has the focus, so that Ctrl+F and the keys work at once.
 */
export function TextViewer(props: ViewProps & { wrap: boolean }) {
  const { file, params } = props;
  const host = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<{ message: string } | { banner: string[] } | null>(null);
  const kept = useKeptView(props.views, file.hash);

  useEffect(() => {
    const stop = new AbortController();
    let view: EditorView | null = null;
    void loading((async () => {
      try {
        const maxMb = params.textViewMaxMb;
        const { bytes, truncated } = await readHead(file, maxMb * MB, stop.signal);
        if (stop.signal.aborted) return;
        const d = decodeText(bytes, truncated);
        if ('binary' in d) { setShown({ message: BINARY }); return; }
        const language = new Compartment();
        let state = EditorState.create({
          doc: d.text,
          extensions: [
            EditorState.readOnly.of(true),
            EditorState.phrases.of(PHRASES_FR),
            lineNumbers(),
            highlightSpecialChars(),
            search({ top: true }),
            highlightSelectionMatches(),
            KEYS,
            syntaxHighlighting(classHighlighter),
            language.of([]),
            props.wrap ? EditorView.lineWrapping : [],
            EditorView.contentAttributes.of({ 'aria-label': file.name }),
            THEME,
          ],
        });
        // Where it was left: that line at the top, the cursor on it (the focus does not scroll the view back).
        const line = state.doc.line(Math.min(Math.max(1, Math.round(keptView(props.views, file.hash)?.line ?? 1)), state.doc.lines));
        state = state.update({ selection: { anchor: line.from } }).state;
        view = new EditorView({ state, parent: host.current!, scrollTo: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 0 }) });
        const v = view;
        v.scrollDOM.addEventListener('scroll', () => {
          const top = v.scrollDOM.getBoundingClientRect().top - v.documentTop;
          kept.current = { line: v.state.doc.lineAt(v.lineBlockAtHeight(Math.max(0, top)).from).number };
        }, { passive: true });
        setShown({ banner: truncated ? [truncationNotice(maxMb)] : [] });
        if (props.mode === 'full') v.focus();
        const desc = languageFor(file.name);
        if (desc) {
          const support = await loading(desc.load());
          if (!stop.signal.aborted) v.dispatch({ effects: language.reconfigure(support) });
        }
      } catch (e) {
        if (!stop.signal.aborted) setShown({ message: readFailure(file.name, e) });
      }
    })());
    return () => { stop.abort(); view?.destroy(); };
  }, []);

  return (
    <div className="viewer viewer-text">
      {shown && 'banner' in shown && <Banner lines={shown.banner} />}
      {(shown === null || 'message' in shown) && <Message text={shown?.message ?? 'Lecture…'} />}
      <div ref={host} className="text-host" />
    </div>
  );
}
