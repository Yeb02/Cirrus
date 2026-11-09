import type { RenderParams } from '@cirrus/view';
import {
  autocompletion, closeCompletion, type CompletionContext, completionKeymap, type CompletionResult, completionStatus,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching, syntaxHighlighting } from '@codemirror/language';
import { lintGutter, lintKeymap, setDiagnostics } from '@codemirror/lint';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Annotation, Compartment, EditorState, type Extension, Prec } from '@codemirror/state';
import { EditorView, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view';
import { classHighlighter } from '@lezer/highlight';
import { useEffect, useRef } from 'react';
import { loading } from '../../files/read.ts';
import type { LatexRegistry } from '../../latex/registry.ts';
import { languageFor, PHRASES_FR } from '../viewers/language.ts';
import { THEME } from '../viewers/TextViewer.tsx';
import { completionsFor, type Diag, refContext, suggestionOptions } from './editorLogic.ts';

/** The editable parts of the look, over the text view's (THEME): the suggestions and the diagnostics, in its palette. */
const EDITING = EditorView.theme({
  '.cm-content': { caretColor: 'var(--ink)' },
  '.cm-tooltip': { backgroundColor: 'var(--sky1)', color: 'var(--ink)', border: '1px solid rgba(143, 184, 255, 0.35)', borderRadius: '6px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'Consolas, monospace', fontSize: '12.5px', maxHeight: '16em' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '1px 8px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--sky2)', color: 'var(--ink)' },
  '.cm-completionDetail': { marginLeft: '1.2em', fontStyle: 'normal', color: 'var(--muted)', fontFamily: 'system-ui, sans-serif' },
  '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--accent)' },
  '.cm-diagnostic': { padding: '3px 8px', fontSize: '12.5px' },
  '.cm-diagnostic-error': { borderLeft: '4px solid #ff8a7a' },
  '.cm-diagnostic-warning': { borderLeft: '4px solid var(--warn)' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy #ff6f61', textUnderlineOffset: '3px' },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy var(--warn)', textUnderlineOffset: '3px' },
  '.cm-gutter-lint': { width: '10px' },
  '.cm-panel.cm-panel-lint ul [aria-selected]': { backgroundColor: 'var(--sky2)' },
  '.cm-matchingBracket': { backgroundColor: 'rgba(143, 184, 255, 0.22)', outline: 'none' },
  '.cm-nonmatchingBracket': { color: '#ff8a7a' },
}, { dark: true });

/**
 * The suggestions' keys (completionKeymap), but Escape only closes them when they are shown: CodeMirror's own also
 * takes it while a query is pending, right after a key, and the full screen or the panel would then miss it.
 */
const SUGGESTION_KEYS = Prec.highest(keymap.of([
  ...completionKeymap.filter((b) => b.key !== 'Escape'),
  { key: 'Escape', run: (v) => completionStatus(v.state) === 'active' && closeCompletion(v) },
]));

/** A change made by the editor's owner (a new `value`), not typed: not told back to it. */
const fromOutside = Annotation.define<boolean>();

/** Where a 1-based line starts, clamped to the document. */
const lineStartIn = (state: EditorState, line: number) => state.doc.line(Math.min(Math.max(1, Math.round(line)), state.doc.lines)).from;

/**
 * The LaTeX editor (plan 4b, task 5), a CodeMirror 6 to type in: coloured as LaTeX (the legacy `stex` mode, loaded once
 * it shows), the search (Ctrl+F) and CodeMirror's texts in French, its own history (Ctrl+Z and Ctrl+Y act on the text),
 * long lines wrapped, line numbers and a gutter of diagnostics except when `compact`. In a ref's or a citation's braces,
 * the registry's labels and keys are suggested (refContext, completionsFor; none while it is not built); `diagnostics` are shown as they are given,
 * in red, once they belong to the text the editor has. Ctrl+S calls `onSave`. Its keys stay its own: the app's
 * shortcuts (Delete, Ctrl+Z…) skip an editable field, and Escape is left to the full screen or the panel, unless the
 * suggestions or a panel of the editor take it. `value` is the text: one that is not what the editor last told
 * (`onChange`) replaces its text, the cursor kept on its line and column, clamped. `jumpTo`: a line to put the cursor on, again at each new `seq`. How many suggestions
 * are drawn, and how soon, are settings (`params`: suggestionOptions). `autoFocus`: the focus at once, the cursor at
 * the end of the text when `compact` (a summary, a relation: task 6). `focusSeq`: the focus back, the cursor where it
 * was, at each new value.
 */
export function LatexEditor(props: {
  value: string; onChange(text: string): void; registry: LatexRegistry | null; diagnostics: Diag[]; params: RenderParams; compact?: boolean;
  autoFocus?: boolean; onSave?(): void; ariaLabel: string; jumpTo?: { line: number; seq: number }; focusSeq?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;
  /** The text the editor last told, or was given. */
  const told = useRef(props.value);
  /** The suggestions' extension, configured again when their settings change. */
  const suggestions = useRef<{ compartment: Compartment; of(p: RenderParams): Extension } | null>(null);

  useEffect(() => {
    const language = new Compartment(), suggesting = new Compartment();
    const suggest = (ctx: CompletionContext): CompletionResult | null => {
      const line = ctx.state.doc.lineAt(ctx.pos);
      const at = refContext(line.text, ctx.pos - line.from), registry = latest.current.registry;
      if (!at || !registry) return null;
      const options = completionsFor(at, registry).map((c) => ({ label: c.label, detail: c.detail, type: at.kind === 'ref' ? 'variable' : 'text' }));
      // In our order (French, the label's own), and asked again at each key: CodeMirror neither filters nor sorts them.
      return { from: line.from + at.from, options, filter: false };
    };
    const suggestionsOf = (p: RenderParams) => autocompletion({ override: [suggest], defaultKeymap: false, ...suggestionOptions(p) });
    suggestions.current = { compartment: suggesting, of: suggestionsOf };
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          EditorState.phrases.of(PHRASES_FR),
          props.compact ? [] : [lineNumbers(), lintGutter()],
          history(),
          highlightSpecialChars(),
          bracketMatching(),
          search({ top: true }),
          highlightSelectionMatches(),
          suggesting.of(suggestionsOf(props.params)),
          SUGGESTION_KEYS,
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => { latest.current.onSave?.(); return true; } },
            ...searchKeymap, ...historyKeymap, ...lintKeymap, ...defaultKeymap.filter((b) => b.key !== 'Escape'),
          ]),
          syntaxHighlighting(classHighlighter),
          language.of([]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': props.ariaLabel, spellcheck: 'false' }),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged || u.transactions.some((t) => t.annotation(fromOutside))) return;
            const text = u.state.doc.toString();
            told.current = text;
            latest.current.onChange(text);
          }),
          THEME,
          EDITING,
        ],
      }),
    });
    view.current = v;
    if (props.autoFocus) {
      if (props.compact) v.dispatch({ selection: { anchor: v.state.doc.length } });
      v.focus();
    }
    let live = true;
    // A language that could not be loaded leaves the text uncoloured.
    const desc = languageFor('source.tex');
    if (desc) {
      void loading(desc.load()).then(
        (support) => { if (live) v.dispatch({ effects: language.reconfigure(support) }); },
        (e: unknown) => console.error('Langage LaTeX de l’éditeur :', e),
      );
    }
    return () => { live = false; v.destroy(); view.current = null; };
  }, []);

  // New settings of the suggestions: CodeMirror's autocompletion configured again.
  const { latexSuggestionsMax, latexSuggestionDelayMs } = props.params;
  useEffect(() => {
    const v = view.current, s = suggestions.current;
    if (v && s) v.dispatch({ effects: s.compartment.reconfigure(s.of(props.params)) });
  }, [latexSuggestionsMax, latexSuggestionDelayMs]);

  // A text given from outside (not the one the editor told): the whole text replaced, the cursor kept as well as it can
  // be — on its line, at its column, each clamped to the new text (plan 5b, D6: a .tex's version from elsewhere loaded).
  useEffect(() => {
    const v = view.current;
    if (!v || props.value === told.current) return;
    told.current = props.value;
    const head = v.state.selection.main.head, line = v.state.doc.lineAt(head), doc = v.state.toText(props.value);
    const at = doc.line(Math.min(line.number, doc.lines));
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: doc }, selection: { anchor: at.from + Math.min(head - line.from, at.length) }, annotations: fromOutside.of(true),
    });
  }, [props.value]);

  // The diagnostics, once they are those of the editor's text (the owner computes them from the text it was told).
  useEffect(() => {
    const v = view.current;
    if (!v || props.value !== told.current) return;
    const n = v.state.doc.length, at = (x: number) => Math.min(Math.max(0, x), n);
    v.dispatch(setDiagnostics(v.state, props.diagnostics.map((d) => ({ from: at(d.from), to: at(Math.max(d.from, d.to)), severity: d.severity, message: d.message }))));
  }, [props.diagnostics, props.value]);

  // CodeMirror's own focus: it puts its selection back in the page.
  useEffect(() => { if (props.focusSeq) view.current?.focus(); }, [props.focusSeq]);

  useEffect(() => {
    const v = view.current, j = props.jumpTo;
    if (!v || !j) return;
    const at = lineStartIn(v.state, j.line);
    v.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }) });
    v.focus();
  }, [props.jumpTo?.seq]);

  return <div ref={host} className={`latex-editor${props.compact ? ' compact' : ''}`} />;
}
