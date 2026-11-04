import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { extensionOf } from '../../files/kind.ts';

/** Extensions @codemirror/language-data does not know, read as a language it has: a Jupyter notebook is JSON. */
const ALIASES = new Map([['ipynb', 'JSON']]);

/**
 * The language a text file is coloured as, by its name (plan 4a, D3): @codemirror/language-data's descriptions, whose
 * code is loaded only when a file of that language is shown (`load()`, a chunk of the app: nothing comes from the
 * network). A `.tex` is LaTeX; a `.txt` or a `.log` has none.
 */
export function languageFor(name: string): LanguageDescription | null {
  const alias = ALIASES.get(extensionOf(name));
  if (alias) return languages.find((l) => l.name === alias) ?? null;
  // matchFilename reads the extension in the name's case: « LISEZ-MOI.TXT » as « .txt ».
  const dot = name.lastIndexOf('.');
  return LanguageDescription.matchFilename(languages, dot < 0 ? name : name.slice(0, dot) + name.slice(dot).toLowerCase());
}

/**
 * CodeMirror's texts in French (EditorState.phrases): the search panel (Ctrl+F) — a read-only editor has no replace
 * fields, their texts are given anyway — the « go to line » panel (Ctrl+Alt+G), and a control character's title.
 */
export const PHRASES_FR: Record<string, string> = {
  'Find': 'Rechercher',
  'Replace': 'Remplacer',
  'next': 'suivant',
  'previous': 'précédent',
  'all': 'tous',
  'match case': 'respecter la casse',
  'regexp': 'expression régulière',
  'by word': 'mot entier',
  'replace': 'remplacer',
  'replace all': 'tout remplacer',
  'close': 'fermer',
  'current match': 'occurrence actuelle',
  'on line': 'à la ligne',
  'replaced $ matches': '$ occurrences remplacées',
  'replaced match on line $': 'occurrence remplacée à la ligne $',
  'Go to line': 'Aller à la ligne',
  'go': 'aller',
  'Control character': 'Caractère de contrôle',
};
