// What the LaTeX chain shares between the interface and the main process (plan 4b): the default preamble, the tags it
// reads, the escaping of the user's texts it injects, and the types its compile IPC exchanges.
import type { FileRef, Id } from './model.ts';

/** The global preamble of a base that never set one (spec 5.6, D5): never stored, as the default values of tags. */
export const DEFAULT_PREAMBLE = [
  '\\documentclass[11pt,a4paper]{article}',
  '\\usepackage[T1]{fontenc}',
  '\\usepackage{lmodern}',
  '\\usepackage{amsmath,amssymb,amsthm}',
  '\\usepackage{graphicx}',
  '\\usepackage{xcolor}',
  '\\usepackage{hyperref}',
  '\\hypersetup{colorlinks, linkcolor=blue!50!black, citecolor=green!40!black, urlcolor=blue!60!black}',
  '',
].join('\n');

/** A publication's BibTeX key, for \cite (D7: a tag rather than the dedicated field of spec 5.4). */
export const CITE_KEY_TAG = 'clé_bibtex';
/** The label of a node's title, for \ref (D7): one per node. */
export const LABEL_TAG = 'label';

/** TeX's special characters, as text. */
const SPECIALS = new Map([
  ['\\', '\\textbackslash{}'], ['#', '\\#'], ['$', '\\$'], ['%', '\\%'], ['&', '\\&'], ['_', '\\_'], ['{', '\\{'], ['}', '\\}'],
  ['~', '\\textasciitilde{}'], ['^', '\\textasciicircum{}'],
]);

/** Typographic punctuation that pdfLaTeX reads as text, most of it beyond U+017F. */
const KEPT = new Set('‘’“”«»–—…·');
/** The letters of Latin Extended-A that LaTeX's UTF-8 input does not set up (measured under DEFAULT_PREAMBLE): an error. */
const NOT_SET_UP = new Set('ĦħĸĿŀŉŦŧſ');

/**
 * Characters drawn in math mode (\ensuremath): Greek letters and the usual symbols. Omicron and the capitals without a
 * command of their own are Latin letters, the capitals upright as \Gamma is; ¬ and ± are here rather than kept as text.
 */
const MATH = new Map(Object.entries({
  α: '\\alpha', β: '\\beta', γ: '\\gamma', δ: '\\delta', ε: '\\epsilon', ζ: '\\zeta', η: '\\eta', θ: '\\theta', ι: '\\iota', κ: '\\kappa',
  λ: '\\lambda', μ: '\\mu', ν: '\\nu', ξ: '\\xi', ο: 'o', π: '\\pi', ρ: '\\rho', σ: '\\sigma', ς: '\\varsigma', τ: '\\tau', υ: '\\upsilon',
  φ: '\\phi', χ: '\\chi', ψ: '\\psi', ω: '\\omega', ϑ: '\\vartheta', ϕ: '\\phi', ϖ: '\\varpi', ϱ: '\\varrho', ϵ: '\\epsilon',
  Α: '\\mathrm{A}', Β: '\\mathrm{B}', Γ: '\\Gamma', Δ: '\\Delta', Ε: '\\mathrm{E}', Ζ: '\\mathrm{Z}', Η: '\\mathrm{H}', Θ: '\\Theta',
  Ι: '\\mathrm{I}', Κ: '\\mathrm{K}', Λ: '\\Lambda', Μ: '\\mathrm{M}', Ν: '\\mathrm{N}', Ξ: '\\Xi', Ο: '\\mathrm{O}', Π: '\\Pi',
  Ρ: '\\mathrm{P}', Σ: '\\Sigma', Τ: '\\mathrm{T}', Υ: '\\Upsilon', Φ: '\\Phi', Χ: '\\mathrm{X}', Ψ: '\\Psi', Ω: '\\Omega',
  '≤': '\\leq', '≥': '\\geq', '≠': '\\neq', '≈': '\\approx', '≡': '\\equiv', '∼': '\\sim', '∝': '\\propto', '∞': '\\infty', '∑': '\\sum',
  '∏': '\\prod', '∫': '\\int', '∂': '\\partial', '∇': '\\nabla', '√': '\\surd', '±': '\\pm', '∓': '\\mp', '→': '\\to', '←': '\\leftarrow',
  '↔': '\\leftrightarrow', '⇒': '\\Rightarrow', '⇐': '\\Leftarrow', '⇔': '\\Leftrightarrow', '∈': '\\in', '∉': '\\notin', '⊂': '\\subset',
  '⊆': '\\subseteq', '⊃': '\\supset', '⊇': '\\supseteq', '∪': '\\cup', '∩': '\\cap', '∅': '\\emptyset', '∀': '\\forall', '∃': '\\exists',
  '¬': '\\neg', '∧': '\\wedge', '∨': '\\vee', ℓ: '\\ell', ℕ: '\\mathbb{N}', ℤ: '\\mathbb{Z}', ℚ: '\\mathbb{Q}', ℝ: '\\mathbb{R}', ℂ: '\\mathbb{C}',
}));

/**
 * A text of the user (a title, a short citation) as inert pdfLaTeX source: TeX's special characters as text, Greek
 * letters and the usual symbols in math mode, Latin letters (basic, Latin-1, Extended-A) and typographic punctuation as
 * they are; any other character becomes « ? », the control characters (U+007F to U+009F among them) and the few
 * letters LaTeX does not set up included, since each would stop the compilation. Nothing of it is a command. A letter
 * typed decomposed (« e » then a combining accent) is read composed (NFC).
 */
export function titleToTex(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    const special = SPECIALS.get(ch);
    if (special !== undefined) { out += special; continue; }
    const math = MATH.get(ch);
    if (math !== undefined) { out += `\\ensuremath{${math}}`; continue; }
    const c = ch.codePointAt(0)!;
    out += (c >= 0x20 && c < 0x7f) || (c >= 0xa0 && c <= 0x17f && !NOT_SET_UP.has(ch)) || KEPT.has(ch) ? ch : '?';
  }
  return out;
}

const MAX_LABEL = 200;
const UNSAFE_LABEL = /[\\{}%#\p{Cc}]/u;

/**
 * Whether a label may be injected into a compilation (plan 4b): 1 to 200 characters (code points, two UTF-16 units at
 * most each), none of \ { } % # nor a control character.
 */
export function safeLabel(name: string): boolean {
  return name.length > 0 && name.length <= 2 * MAX_LABEL && [...name].length <= MAX_LABEL && !UNSAFE_LABEL.test(name);
}

// The compile IPC (tasks 3 to 7).

export type CompileMode = 'snippet' | 'page';
/** A label of another source: its node's title is shown, linked to the node (D7). */
export interface InjectedRef { label: string; title: string; node: Id | null }
/** A label of this very source, from its last compile's .aux: its number, page and hyperref anchor. */
export interface KnownLabel { label: string; number: string; page: string; anchor: string }
/** text: the short citation, plain Unicode (« Li et Vitányi, 2008 »). */
export interface InjectedCite { key: string; text: string; node: Id }
export interface CompileRequest {
  slot: string;           // one per source: 'summary:<id>', 'relation:<id>', 'file:<id>:<name>', 'preamble'
  mode: CompileMode;
  source: string;
  preamble: string;
  refs: InjectedRef[];
  broken: string[];       // cited, defined nowhere
  doubled: InjectedRef[]; // cited, defined more than once: the first definition
  cites: InjectedCite[];
  unknownCites: string[];
  known: KnownLabel[];    // a hint only: never part of the cache key
  resources: FileRef[];   // the node's other files, visible under their names
}
export interface TexError { message: string; line: number | null; where: 'source' | 'preamble' }
export interface CompiledPdf { key: string; size: number; pages: number }
export type CompileAnswer =
  | { status: 'ok'; pdf: CompiledPdf; labels: KnownLabel[]; log: string; ms: number; passes: number; cached: boolean; installed?: string }
  | { status: 'error'; error: TexError; labels: KnownLabel[]; log: string; ms: number; missing?: string }
  | { status: 'cancelled' }
  | { status: 'unavailable'; reason: 'absent' | 'installing' | 'failed'; message: string };

/** The steps of TinyTeX's installation (D1): the main process's Progress (latex/tinytex.ts). */
export type InstallProgress = { step: 'download'; done: number; total: number } | { step: 'extract' } | { step: 'packages'; names: string[] };
/** The state of LaTeX on this PC, pushed by the main process (cirrus:latex:status). */
export type LatexStatus =
  | { state: 'ready' }
  | { state: 'absent' }
  | { state: 'installing'; progress: InstallProgress | { step: 'package'; name: string } }
  | { state: 'failed'; message: string };
