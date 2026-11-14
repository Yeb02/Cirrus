// The agenda and the sheets as their tabs show them (plan 6b, D6): pure, read from the state.
import { AGENDA_NODES, AGENDA_TEXT_CHARS, AGENDA_TITLE_CHARS, type AgendaEntryRec, type Id, type State } from '@cirrus/core';

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const two = (n: number) => String(n).padStart(2, '0');
/** A count with its thousands apart, by a no-break space (« 20 000 »), whatever the system's locale. */
export const thousands = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** The local date of a time, `AAAA-MM-JJ` (an agenda entry's day). */
export const dayOf = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
};

/** A day `AAAA-MM-JJ` as its entry shows it under its month: « samedi 14 ». */
export const dayLabel = (day: string): string => {
  const [y, m, d] = day.split('-').map(Number);
  return `${WEEKDAYS[new Date(y, m - 1, d).getDay()]} ${d}`;
};

/** A node an entry links: its title; struck when it is in the trash (`trash`) or gone from the base (`missing`). */
export interface LinkedNode { id: Id; title: string; gone?: 'trash' | 'missing' }
/** A line of the timeline: an entry with its linked nodes, or the line of today. */
export type AgendaRow = { kind: 'entry'; entry: AgendaEntryRec; nodes: LinkedNode[] } | { kind: 'today'; day: string };
export interface AgendaMonth { key: string; label: string; rows: AgendaRow[] }

/** What an entry's linked node shows: a node gone keeps no title (« Nœud »). */
export function linkedNode(s: State, id: Id): LinkedNode {
  const n = s.nodes.get(id);
  if (!n) return { id, title: 'Nœud', gone: 'missing' };
  const title = n.title || 'Sans titre';
  return n.trashedAt !== undefined ? { id, title, gone: 'trash' } : { id, title };
}

/**
 * The timeline (D6): the entries from the oldest at the top to the furthest at the bottom, by day then in their order of
 * creation (their identifiers, uuidv7), grouped by month (« novembre 2026 »); the line of `today` among them, after the
 * day before and before today's entries — its month is there even without an entry.
 */
export function agendaMonths(s: State, today: string): AgendaMonth[] {
  const rows: AgendaRow[] = [...s.agenda.values()]
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((entry) => ({ kind: 'entry', entry, nodes: entry.nodes.map((id) => linkedNode(s, id)) }));
  const at = rows.findIndex((r) => r.kind === 'entry' && r.entry.day >= today);
  rows.splice(at < 0 ? rows.length : at, 0, { kind: 'today', day: today });
  const months: AgendaMonth[] = [];
  for (const r of rows) {
    const key = (r.kind === 'today' ? r.day : r.entry.day).slice(0, 7);
    if (months.at(-1)?.key !== key) months.push({ key, label: `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`, rows: [] });
    months.at(-1)!.rows.push(r);
  }
  return months;
}

/** Whether `day` is a date of the calendar `AAAA-MM-JJ`, as parseOp checks it. */
function realDay(day: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return false;
  const d = new Date(0);
  d.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/**
 * Why an entry cannot be written, in plain French, or null (D6): the core's bounds (AGENDA_TITLE_CHARS on the title
 * without its edge spaces, AGENDA_TEXT_CHARS, AGENDA_NODES, a real date) checked first, so that parseOp's technical
 * message never shows.
 */
export function agendaRefusal(e: AgendaEntryRec): string | null {
  if (!realDay(e.day)) return 'Choisissez une date valide.';
  const title = e.title.trim().length;
  if (title === 0) return 'Donnez un titre à l’entrée.';
  if (title > AGENDA_TITLE_CHARS) return `Le titre d’une entrée compte au plus ${AGENDA_TITLE_CHARS} caractères.`;
  if (e.text.length > AGENDA_TEXT_CHARS) return `Le texte d’une entrée compte au plus ${thousands(AGENDA_TEXT_CHARS)} caractères.`;
  if (e.nodes.length > AGENDA_NODES) return `Une entrée lie au plus ${AGENDA_NODES} nœuds.`;
  return null;
}

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

/**
 * A sheet's age (D6): « à l’instant » under a minute (a clock behind counts as now), then « il y a 5 min », « il y a 3 h »,
 * « il y a 2 j » under seven days, then its date, « 07/11/2026 ».
 */
export function ageOf(at: number, now: number): string {
  const d = now - at;
  if (d < MINUTE) return 'à l’instant';
  if (d < HOUR) return `il y a ${Math.floor(d / MINUTE)} min`;
  if (d < DAY) return `il y a ${Math.floor(d / HOUR)} h`;
  if (d < 7 * DAY) return `il y a ${Math.floor(d / DAY)} j`;
  const t = new Date(at);
  return `${two(t.getDate())}/${two(t.getMonth() + 1)}/${t.getFullYear()}`;
}
