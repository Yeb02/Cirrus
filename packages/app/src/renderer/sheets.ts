// The sheets as their tab shows them (plan 6b, D6): pure, read from the state.
import { SHEET_TEXT_CHARS, type SheetRec, type State } from '@cirrus/core';
import { thousands } from './agenda.ts';

/**
 * The node a sheet becomes (« En faire un nœud »): its title the first line that is not blank, cut at 200 characters,
 * its summary the rest, TeX's special characters escaped. The core's, which sheetToNode applies: the interface shows
 * the title its ghost carries by the same function.
 */
export { sheetNode } from '@cirrus/core';

/** The sheets, the most recent first (by their creation; their identifiers, uuidv7, between two of the same time). */
export const sheetsByDate = (s: State): SheetRec[] =>
  [...s.sheets.values()].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

/** Why a sheet's text cannot be written, in plain French, or null: SHEET_TEXT_CHARS checked before the core does. */
export const sheetRefusal = (text: string): string | null =>
  text.length > SHEET_TEXT_CHARS ? `Un feuillet compte au plus ${thousands(SHEET_TEXT_CHARS)} caractères.` : null;
