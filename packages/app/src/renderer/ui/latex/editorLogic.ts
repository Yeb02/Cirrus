import type { CompileRequest, TexError } from '@cirrus/core';
import type { RenderParams } from '@cirrus/view';
import { type LatexRegistry, type Origin, slotOf } from '../../latex/registry.ts';
import { CITES, REF_LISTS, REFS, type TexMark, type TexScan } from '../../latex/scan.ts';

/**
 * The LaTeX editor's logic (plan 4b, task 5), without CodeMirror: where a reference or a citation is being typed, what
 * to suggest there, and the source's diagnostics.
 */

/** The name being typed in a ref's or a citation's braces: where it starts, and what is typed of it. */
export interface RefContext { kind: 'ref' | 'cite'; from: number; prefix: string }

const BACKSLASH = 92, PERCENT = 37, LF = 10, OPEN = 123, CLOSE = 125, STAR = 42, CLOSE_OPT = 93;
const isLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isBlank = (c: number) => c === 32 || c === 9;

/** Back from `i` past the spaces and tabs: the first other character's offset (−1 at the start). */
function blanksBack(doc: string, i: number): number {
  while (i >= 0 && isBlank(doc.charCodeAt(i))) i--;
  return i;
}

/** Whether the backslash at `at` is itself escaped: an odd number of backslashes right before it (« \\ref »). */
function escaped(doc: string, at: number): boolean {
  let n = 0;
  for (let i = at - 1; i >= 0 && doc.charCodeAt(i) === BACKSLASH; i--) n++;
  return n % 2 === 1;
}

/** Whether `at` is in a comment: an unescaped « % » before it on its line. */
function inComment(doc: string, at: number): boolean {
  for (let i = doc.lastIndexOf('\n', at - 1) + 1; i < at; i++) {
    const c = doc.charCodeAt(i);
    if (c === BACKSLASH) i++;
    else if (c === PERCENT) return true;
  }
  return false;
}

/**
 * Whether `pos` is inside the braces of a reference (REFS) or a citation (CITES) of `doc`, as scanTex reads them (task
 * 4): the command, its star, its optional arguments in brackets (a citation's two at most, none for a ref), spaces
 * between them, then the brace; on the same line, outside a comment, its backslash not escaped. A list (a citation's,
 * cleveref's) gives the name after the last comma, its spaces skipped; a single ref, its whole argument so far. Null
 * outside one, or past a brace, a backslash, a « % » or a line break typed since the brace.
 */
export function refContext(doc: string, pos: number): RefContext | null {
  let brace = pos - 1;
  for (; brace >= 0; brace--) {
    const c = doc.charCodeAt(brace);
    if (c === OPEN) break;
    if (c === CLOSE || c === BACKSLASH || c === PERCENT || c === LF) return null;
  }
  if (brace < 0) return null;
  let i = blanksBack(doc, brace - 1), optionals = 0;
  while (i >= 0 && doc.charCodeAt(i) === CLOSE_OPT) {
    const open = doc.lastIndexOf('[', i);
    if (open < 0 || doc.slice(open, i).includes('\n')) return null;
    i = blanksBack(doc, open - 1);
    optionals++;
  }
  if (i >= 0 && doc.charCodeAt(i) === STAR) i = blanksBack(doc, i - 1);
  let start = i;
  while (start >= 0 && isLetter(doc.charCodeAt(start))) start--;
  if (start === i || start < 0 || doc.charCodeAt(start) !== BACKSLASH || escaped(doc, start) || inComment(doc, start)) return null;
  const name = doc.slice(start + 1, i + 1);
  const kind = REFS.has(name) ? 'ref' : CITES.has(name) ? 'cite' : null;
  if (kind === null || optionals > (kind === 'cite' ? 2 : 0)) return null;
  let from = brace + 1;
  if (kind === 'cite' || REF_LISTS.has(name)) {
    const comma = doc.lastIndexOf(',', pos - 1);
    if (comma > brace) from = comma + 1;
    while (from < pos && isBlank(doc.charCodeAt(from))) from++;
  }
  return { kind, from, prefix: doc.slice(from, pos) };
}

/** What a name is compared by: without its accents (NFD, marks removed), in lower case. */
const folded = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const french = new Intl.Collator('fr');

interface Choice { label: string; detail: string; key: string }
/** The suggestions of a registry, built once per registry and kind. */
const choices = new WeakMap<LatexRegistry, Partial<Record<RefContext['kind'], Choice[]>>>();

function choicesOf(kind: RefContext['kind'], registry: LatexRegistry): Choice[] {
  let byKind = choices.get(registry);
  if (!byKind) choices.set(registry, (byKind = {}));
  const have = byKind[kind];
  if (have) return have;
  const out: Choice[] = [];
  // Each label or key once, with its first definition's title or its first node's citation (the registry's order).
  const seen = new Set<string>();
  const add = (label: string, detail: string) => {
    if (seen.has(label)) return;
    seen.add(label);
    out.push({ label, detail, key: folded(label) });
  };
  if (kind === 'ref') for (const d of registry.labels()) add(d.label, d.title);
  else for (const c of registry.citeKeys()) add(c.key, c.text);
  out.sort((a, b) => french.compare(a.label, b.label));
  return (byKind[kind] = out);
}

/**
 * What to suggest where `ctx` is (refContext): for a ref, the registry's labels, each with its node's title (its first
 * definition's); for a citation, its keys, each with its short citation. Those starting with what is typed, compared
 * without case nor accents, in the French order.
 */
export function completionsFor(ctx: RefContext, registry: LatexRegistry): { label: string; detail: string }[] {
  const prefix = folded(ctx.prefix);
  return choicesOf(ctx.kind, registry).filter((c) => c.key.startsWith(prefix)).map(({ label, detail }) => ({ label, detail }));
}

/**
 * How many suggestions CodeMirror draws, and how long after a key it asks for them (its maxRenderedOptions and
 * activateOnTypingDelay): settings (latexSuggestionsMax, latexSuggestionDelayMs), its own values by default.
 */
export function suggestionOptions(p: Pick<RenderParams, 'latexSuggestionsMax' | 'latexSuggestionDelayMs'>): { maxRenderedOptions: number; activateOnTypingDelay: number } {
  return { maxRenderedOptions: p.latexSuggestionsMax, activateOnTypingDelay: p.latexSuggestionDelayMs };
}

/** The first offset of a 1-based line of `text`; the text's length + 1 past its last line (diagnosticsFor's `lineStart`). */
export function lineStartOf(text: string, line: number): number {
  let at = 0;
  for (let k = 1; k < line; k++) {
    const nl = text.indexOf('\n', at);
    if (nl < 0) return text.length + 1;
    at = nl + 1;
  }
  return at;
}

/** A diagnostic of the editor (@codemirror/lint's), its offsets in the source. */
export interface Diag { from: number; to: number; severity: 'error' | 'warning'; message: string }

/**
 * The source's diagnostics (Review Focus 5), in red, by offset, from its analysis (`scan`) and the request built from it
 * (`req`, buildRequest) for the source `own`:
 * - a ref to a label defined nowhere (`broken`), or more than once (`doubled`), on its name;
 * - a label it defines that another source, or a node's title, defines too — « Ce label existe déjà dans « titre » »,
 *   the first of them —, else one it defines twice itself;
 * - a citation of a key no live node holds (`unknownCites`), or several do (`doubledCites`);
 * - the compilation's `error`, on its line when it is in the source (`lineStart`: a 1-based line's first offset, the
 *   source's length + 1 past its last line); one of the preamble, or without a line, is the banner's.
 */
export function diagnosticsFor(
  scan: TexScan, req: CompileRequest, registry: LatexRegistry, own: Origin, error: TexError | null, lineStart: (line: number) => number,
): Diag[] {
  const out: Diag[] = [];
  const mark = (m: TexMark, message: string) => out.push({ from: m.from, to: m.to, severity: 'error', message });
  const broken = new Set(req.broken), doubled = new Set(req.doubled.map((r) => r.label));
  for (const m of scan.refs) {
    if (broken.has(m.name)) mark(m, `Label inconnu : ${m.name}`);
    else if (doubled.has(m.name)) mark(m, `Label défini plusieurs fois : ${m.name}`);
  }
  const slot = slotOf(own), times = new Map<string, number>();
  for (const m of scan.labels) times.set(m.name, (times.get(m.name) ?? 0) + 1);
  for (const m of scan.labels) {
    // The registry's definitions of this very source are those of its version in the state, not of the text typed.
    const elsewhere = registry.definitions(m.name).find((d) => d.origin.kind === 'title' || slotOf(d.origin) !== slot);
    if (elsewhere) mark(m, `Ce label existe déjà dans « ${elsewhere.title} »`);
    else if (times.get(m.name)! > 1) mark(m, `Label défini plusieurs fois : ${m.name}`);
  }
  const unknown = new Set(req.unknownCites), shared = new Set(req.doubledCites.map((c) => c.key));
  for (const m of scan.cites) {
    if (unknown.has(m.name)) mark(m, `Clé de citation inconnue : ${m.name}`);
    else if (shared.has(m.name)) mark(m, `Clé de citation portée par plusieurs nœuds : ${m.name}`);
  }
  if (error !== null && error.where === 'source' && error.line !== null && error.line >= 1) {
    const from = lineStart(error.line), to = lineStart(error.line + 1) - 1;
    if (to >= from) out.push({ from, to, severity: 'error', message: error.message });
  }
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}
