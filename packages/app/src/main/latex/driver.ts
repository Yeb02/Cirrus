import { type CompileRequest, type InjectedRef, safeLabel, titleToTex, withoutComments } from '@cirrus/core';

/**
 * What the main process writes for pdfLaTeX (plan 4b, D2, D4, D7): the warm driver, read once per process with the
 * preamble, and each job's body, which declares the other sources' labels and citations, then reads the source. TeX only
 * ever gets relative names: the driver, the preamble and the source are in its work folder, the node's files in the
 * links folder that TEXINPUTS names.
 */

/**
 * Part of the cache key: raised whenever the driver or a job's body changes what a compilation gives. 2: doubledCites;
 * 3: a snippet's page at least a strut deep under its last baseline.
 */
export const DRIVER_VERSION = 3;

/**
 * The bench's driver (bench/latex/src/driver.ts), the preamble read by its relative name. Then the app's macros:
 * \cirrus@label{name}{number}{page}{anchor} defines \r@<name> in the five fields of today's kernel and of hyperref (the
 * kernel's \ref reads the first two); \cirrus@cite defines \b@<key>, which hyperref leaves unlinked; \cirrus@link{node}
 * links to cirrus://node/<id>, its prefix detokenized here so that no active character of babel reaches the address.
 * Then fallbacks, for injected titles to compile whatever the preamble loads: \mathbb (amssymb) as \mathbf, red without
 * xcolor as plain text, a link without hyperref as plain text. pdfLaTeX starts in nonstopmode, so that an error in the
 * preamble never waits for input; \scrollmode only lasts the reading of the job's name on standard input, without its
 * end of line (\endlinechar=-1).
 */
export function driverSource(): string {
  return [
    '\\input{preamble}',
    '\\makeatletter',
    '\\newbox\\cirrus@box',
    '\\def\\cirrus@label#1#2#3#4{\\expandafter\\gdef\\csname r@#1\\endcsname{{#2}{#3}{}{#4}{}}}',
    '\\def\\cirrus@cite#1#2{\\expandafter\\gdef\\csname b@#1\\endcsname{#2}}',
    '\\def\\cirrus@red#1{\\textcolor{red}{#1}}',
    '\\edef\\cirrus@url{\\detokenize{cirrus://node/}}',
    '\\def\\cirrus@link#1#2{\\expandafter\\href\\expandafter{\\cirrus@url#1}{#2}}',
    '\\makeatother',
    '\\providecommand\\mathbb[1]{\\mathbf{#1}}',
    '\\providecommand\\textcolor[2]{#2}',
    '\\providecommand\\href[2]{#2}',
    '\\begin{document}',
    '\\message{CIRRUS-READY}',
    '\\scrollmode',
    '{\\endlinechar=-1 \\global\\read16 to \\cirrusjob}',
    '\\nonstopmode',
    '\\input{\\cirrusjob}',
    '\\end{document}',
    '',
  ].join('\n');
}

/**
 * A name TeX may receive inside \detokenize: safeLabel's, without « ^^ », which TeX reads as a character code before
 * anything else (« a^^7bb » would be « a{b »).
 */
const injectable = (name: string) => safeLabel(name) && !name.includes('^^');
/** A node id as an address: uuidv7's characters only, else no link. */
const NODE_ID = /^[0-9A-Za-z_-]{1,100}$/;

/**
 * A field of a label of this very source, from its .aux (TeX's own text, given back as the `known` hint): kept only if
 * its braces balance and it holds no « # », « % », « ^^ » nor control character, any of which would break the body.
 */
function texField(s: string): boolean {
  if (/[#%\p{Cc}]|\^\^/u.test(s)) return false;
  let depth = 0;
  for (const c of s) {
    if (c === '{') depth++;
    else if (c === '}' && --depth < 0) return false;
  }
  return depth === 0;
}

const linked = (node: string | null, text: string) => (node !== null && NODE_ID.test(node) ? `\\cirrus@link{${node}}{${text}}` : text);
const red = (text: string) => `\\cirrus@red{${text}}`;
const label = (name: string, number: string, page: string, anchor = '') => `\\cirrus@label{\\detokenize{${name}}}{${number}}{${page}}{${anchor}}`;

/**
 * A job's body (D7), in this order: this source's labels as its last compilation numbered them (`known`); the labels of
 * other sources, as their node's title linked to it; the broken ones in red, their name followed by « ? »; the doubled
 * ones in red, with the title of their first definition; the citations, as their short text linked to the publication's
 * node; the keys held by several nodes in red, with the first's short text, linked to it, as a doubled label is; the
 * unknown keys in red. Every text of the user goes through titleToTex; a label or a key that cannot be
 * injected is left out (the source then shows LaTeX's « ?? »). A label of another source shows « ? » as its page.
 * Then the source: as is in `page` mode; in `snippet` mode, set in a box the request's `widthCm` wide, without indent,
 * and shipped alone on a page of the box's size (D3), at least a strut deep under the last baseline.
 */
export function jobBody(req: CompileRequest, src: string): string {
  const lines = ['\\makeatletter'];
  for (const k of req.known) {
    if (injectable(k.label) && [k.number, k.page, k.anchor].every(texField)) lines.push(label(k.label, k.number, k.page, k.anchor));
  }
  const other = (refs: InjectedRef[], show: (r: InjectedRef) => string) => {
    for (const r of refs) if (injectable(r.label)) lines.push(label(r.label, linked(r.node, show(r)), '?'));
  };
  other(req.refs, (r) => titleToTex(r.title));
  for (const b of req.broken) if (injectable(b)) lines.push(label(b, red(`${titleToTex(b)}~?`), '?'));
  other(req.doubled, (r) => red(titleToTex(r.title)));
  for (const c of req.cites) if (injectable(c.key)) lines.push(`\\cirrus@cite{\\detokenize{${c.key}}}{${linked(c.node, titleToTex(c.text))}}`);
  for (const c of req.doubledCites) if (injectable(c.key)) lines.push(`\\cirrus@cite{\\detokenize{${c.key}}}{${linked(c.node, red(titleToTex(c.text)))}}`);
  for (const k of req.unknownCites) if (injectable(k)) lines.push(`\\cirrus@cite{\\detokenize{${k}}}{${red(`${titleToTex(k)}~?`)}}`);
  if (req.mode === 'page') {
    lines.push('\\makeatother', `\\input{${src}}`);
  } else {
    // The source is read with « @ » a letter no more (\makeatother, local to the box); the page's origin is its corner.
    lines.push(
      `\\setbox\\cirrus@box=\\vbox{\\hsize=${cm(req.widthCm!)}\\relax\\linewidth=\\hsize\\textwidth=\\hsize\\columnwidth=\\hsize\\parindent=0pt\\relax`
        + `\\makeatother\\input{${src}}\\par}%`,
      '\\begingroup\\pdfhorigin=0pt\\pdfvorigin=0pt\\hoffset=0pt\\voffset=0pt',
      // Under the last baseline, at least a strut's depth: a last line without descenders (« en bits. ») has none in
      // TeX's box, and the round letters' ink under it was cut by the page's edge (plan 4b, task 6).
      '\\dimen@=\\dp\\cirrus@box\\relax\\ifdim\\dimen@<\\dp\\strutbox\\dimen@=\\dp\\strutbox\\fi',
      '\\pdfpagewidth=\\wd\\cirrus@box\\pdfpageheight=\\dimexpr\\ht\\cirrus@box+\\dimen@\\relax',
      '\\ifdim\\pdfpageheight<1pt \\pdfpageheight=1pt\\fi',
      '\\shipout\\box\\cirrus@box\\endgroup',
      '\\makeatother',
    );
  }
  return `${lines.join('\n')}\n`;
}

/** A width for TeX: never in exponent notation. */
const cm = (x: number) => `${Number(x.toFixed(3))}cm`;

// The source as the main process reads it: withoutComments and isStandalone are in @cirrus/core, shared with the
// interface's scanTex (task 4).

/** The labels the source refers to, by any command ending in « ref » (\ref, \eqref, \pageref, \autoref, \cref{a,b}…). */
export function citedLabels(source: string): Set<string> {
  const out = new Set<string>();
  for (const m of withoutComments(source).matchAll(/\\[A-Za-z]*ref\*?\s*(?:\[[^\]]*\]\s*)*\{([^{}]*)\}/g)) {
    for (const name of m[1].split(',')) if (name.trim() !== '') out.add(name.trim());
  }
  return out;
}
