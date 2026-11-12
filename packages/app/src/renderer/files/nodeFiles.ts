import type { FileRef, Id } from '@cirrus/core';
import type { ImportResult, OpenResult } from '../../main/files.ts';
import { filesBuild, UP_TO_DATE } from '../actions.ts';
import type { EditSession } from '../session.ts';
import { NODE_MIME } from './annotations.ts';
import { extensionOf, fileKind, type FileKind } from './kind.ts';
import { type Merge, mergeFiles } from './merge.ts';

/** A file not imported, and why, in French (main/files.ts importPaths). */
export type Refusal = ImportResult['refused'][number];

/**
 * What a node's files ask of App (plan 4a, task 4), for the pop-up and the graph: import files dropped on a node — their
 * paths (pathForFile), and those already refused here (a dropped file that is not on the disk) — or chosen in the
 * system's dialog, and open one with the system's application. Each says what it did, or why not, in a notification.
 */
export interface NodeFiles {
  importInto(node: Id, paths: string[], refused?: Refusal[]): Promise<void>;
  pickInto(node: Id): Promise<void>;
  openWithSystem(file: FileRef): Promise<void>;
}

/** What a drag event says of what it carries (a DragEvent, or what stands for one). */
type Dragged = { dataTransfer: { readonly types: readonly string[] } | null };

/** What a drag carries: a node dragged out of a list of annotations (NODE_MIME, plan 4c, D4), files from the explorer. */
type Carried = 'node' | 'files';

/**
 * What a drag carries (plan 4c, task 3): a node from a list of Cirrus first — a node is never taken for files —, then
 * files; null for anything else (text dragged in a field is left to the field).
 */
export function carried(e: Dragged): Carried | null {
  const types = e.dataTransfer?.types;
  if (!types) return null;
  if (types.includes(NODE_MIME)) return 'node';
  return types.includes('Files') ? 'files' : null;
}

/** Whether a drag carries files (from the explorer), and no node of a list: text dragged in a field is left to the field. */
export const carriesFiles = (e: Dragged): boolean => carried(e) === 'files';

/**
 * The window's guard (Review Focus 2): files that nothing took — no node's pop-up, not the graph, their default not
 * prevented — are refused, or Chromium would show the file in the window. Text dragged in a field is the field's.
 */
export const refusesStrayDrop = (e: Dragged & { defaultPrevented: boolean }): boolean => !e.defaultPrevented && carriesFiles(e);

/** What takes the files let go on an element: a node's pop-up, or the graph. */
type DropZone = 'popup' | 'graph';
/** What a drop lands on: an element of the page, or what stands for one (its `closest`). */
type DropTarget = { closest?(selectors: string): unknown };
/**
 * What floats over the graph and refuses files (task 4): a question; the import dialog takes its own (plan 4c). A
 * connection's pop-up is a floating panel, out of the graph, which takes none (2026-11-12).
 */
const GRAPH_REFUSES = '.ask, .publication-dialog';

/**
 * What takes the files let go on `target` (Review Focus 2): a node's pop-up, anywhere on it (its list of files, its
 * fields); the graph, but not what floats over it and refuses them (GRAPH_REFUSES); nothing elsewhere — the tabs, the
 * settings and their fields, a file's preview, the full screen, the notifications.
 */
export function dropZone(target: EventTarget | DropTarget | null): DropZone | null {
  const el = target as DropTarget | null;
  if (!el?.closest) return null;
  if (el.closest('.node-popup')) return 'popup';
  return el.closest('.graph') && !el.closest(GRAPH_REFUSES) ? 'graph' : null;
}

/**
 * Where a drop goes: files into a node's files, or to a notice, on the graph, where no node takes them (they are taken
 * all the same, so nothing shows them); a .bib alone on the graph's background, imported whole (plan 4c, D9); a PDF
 * alone there, given to the import dialog (plan 5b, D5); a node dragged out of a list, placed in the plan shown (plan
 * 4c, D4: placeDroppedBuild); or refused — files by the window's guard (refusesStrayDrop), a node by nothing taking it.
 */
type DropRoute = { to: 'node'; node: Id } | { to: 'notice' } | { to: 'bib' } | { to: 'pdf' } | { to: 'place' } | { to: 'refused' };

/** A file's name from its path, either separator's. */
export const pathName = (path: string) => path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1);
/** Whether a file's name or path is a .bib's (D9). */
const isBib = (name: string) => extensionOf(pathName(name)) === 'bib';
/** Whether a file's name or path is a PDF's (plan 5b, D5), by the extension as every view reads it (fileKind). */
const isPdf = (name: string) => fileKind(pathName(name)) === 'pdf';

/**
 * The route of what is let go on `zone` (dropZone). Files (`what`, by default), `node` being the node that zone gives
 * them to: a pop-up's own (null once it is gone: its pop-up then takes none); on the graph, the node or group under the
 * point, the one a double click there would open (nodeOpenedBy: a far node's phantom gives its node; the background, an absent
 * or a centre phantom, none) — where one .bib alone (`names`, the files' paths) is imported (plan 4c, task 6), one PDF
 * alone opens the import dialog on it (plan 5b, D5), on a node a file of it as any other. A node dragged out of a list
 * (plan 4c, task 3): placed on the graph, whatever lies under the point (the group it enters is read in the plan, by
 * placeDroppedBuild); taken nowhere else — a pop-up, what floats over the graph (the import dialog among it, which
 * takes a PDF itself), a preview, the full screen (modal, D4).
 */
export function dropRoute(zone: DropZone | null, node: Id | null, what: Carried = 'files', names?: readonly string[]): DropRoute {
  if (what === 'node') return zone === 'graph' ? { to: 'place' } : { to: 'refused' };
  if (zone === null) return { to: 'refused' };
  if (node !== null) return { to: 'node', node };
  if (zone !== 'graph') return { to: 'refused' };
  if (names?.length !== 1) return { to: 'notice' };
  return isBib(names[0]) ? { to: 'bib' } : isPdf(names[0]) ? { to: 'pdf' } : { to: 'notice' };
}

/**
 * The notice of files let go on the graph's background that it does not take (dropRoute: `notice`). Both texts name
 * what the background takes — a .bib alone, a PDF alone (plan 5b, D5) —; the one for a drop that holds a .bib says it
 * the way the .bib's import always did.
 */
export function backgroundNotice(names: readonly string[]): string {
  return names.some(isBib)
    ? 'Dépose un seul fichier .bib ou un seul PDF à la fois sur le fond du graphe pour l’importer ; un autre fichier se dépose sur un nœud.'
    : 'Dépose un seul .bib ou un seul PDF sur le fond, ou un fichier sur un nœud pour l’y ajouter.';
}

/** Why a dropped file that is not on the disk (one a web page made, dragged from a browser) is not imported. */
export const NOT_ON_DISK = 'pas un fichier du disque';

/** A drop's files: the path of each file of the disk (pathForFile), and the others refused, by name. */
export function droppedPaths(files: ArrayLike<File>, pathOf: (f: File) => string): { paths: string[]; refused: Refusal[] } {
  const out: { paths: string[]; refused: Refusal[] } = { paths: [], refused: [] };
  for (const f of Array.from(files)) {
    const path = pathOf(f);
    if (path) out.paths.push(path);
    else out.refused.push({ name: f.name, reason: NOT_ON_DISK });
  }
  return out;
}

/** Every refused file in one notification: « 2 fichiers non importés : x (c’est un dossier), y (plus de 200 Mo) ». */
export function refusalNotice(refused: Refusal[]): string | null {
  const n = refused.length;
  if (n === 0) return null;
  return `${n} ${n === 1 ? 'fichier non importé' : 'fichiers non importés'} : ${refused.map((r) => `${r.name} (${r.reason})`).join(', ')}`;
}

/**
 * What a drop did to the node `title`, as notified: the files added (« « a.txt » ajouté à « titre » », « 3 fichiers
 * ajoutés à « titre » »), then those replaced (« « nom » remplacé », « 2 fichiers remplacés »). The unchanged ones are
 * not named; null when nothing changed.
 */
export function dropNotice(m: Merge, title: string): string | null {
  const parts: string[] = [];
  const [a, r] = [m.added, m.replaced];
  if (a.length > 0) parts.push(`${a.length === 1 ? `« ${a[0]} » ajouté` : `${a.length} fichiers ajoutés`} à « ${title} »`);
  if (r.length > 0) parts.push(r.length === 1 ? `« ${r[0]} » remplacé` : `${r.length} fichiers remplacés`);
  return parts.length === 0 ? null : parts.join(' ; ');
}

/**
 * Files copied into the store (importFiles, pickFiles) added to `node` through the session, as one action, so one undo
 * step (spec 6.4): filesBuild on the session's state, its merge made again on the state the action is computed on.
 * Resolves with what to notify, in order: the refused files, then what the drop did — or « Déjà à jour. » when every
 * file is there already, or the session's refusal (the node gone, the base's).
 */
export async function addImported(session: EditSession, node: Id, r: ImportResult): Promise<string[]> {
  const notices: string[] = [];
  const refused = refusalNotice(r.refused);
  if (refused) notices.push(refused);
  if (r.refs.length === 0) return notices;
  const build = filesBuild(session.state, node, r.refs);
  if (!build) return [...notices, UP_TO_DATE];
  // What the action does, read on the state it is computed on (which the command leaves as it found it).
  let done: string | null = null;
  const res = await session.run((st) => {
    const a = build(st);
    const n = st.nodes.get(node)!;
    done = dropNotice(mergeFiles(n.files, r.refs), n.title);
    return a;
  });
  const outcome = res.ok ? done : res.message;
  return outcome ? [...notices, outcome] : notices;
}

/** What is notified once the main process opened a file (openFile): a program shown in the explorer, or why it failed. */
export const EXECUTABLE_SHOWN = 'Fichier exécutable : montré dans l’explorateur, sans l’ouvrir.';
export function openNotice(r: OpenResult): string | null {
  if (!r.ok) return r.message;
  return r.shown === 'folder' ? EXECUTABLE_SHOWN : null;
}

/**
 * The kinds handed to the system's application (controller's ruling, task 1): images, PDFs, and the kinds Cirrus cannot
 * show. Text, code, LaTeX and tables are only ever shown in Cirrus (task 5): a script is never handed to Windows —
 * scripts are text kinds (kind.ts), and of the kinds Cirrus cannot show, what Windows would run is shown in the
 * explorer by the main process (isRunnable: executables, compiled Python).
 */
const TO_SYSTEM: ReadonlySet<FileKind> = new Set(['image', 'pdf', 'other']);

/** Whether « Ouvrir avec l’application du système » is offered for the file: in its menu, in its full screen's header. */
export const offersSystem = (name: string): boolean => TO_SYSTEM.has(fileKind(name));

export type FileAction = 'full' | 'system' | 'rename' | 'remove';
/**
 * A file's menu (right click, spec 12): show it in full screen (the kinds Cirrus shows, task 5), open it with the system
 * (TO_SYSTEM kinds only), rename it, take it out of the node.
 */
export function fileMenu(name: string): { action: FileAction; label: string }[] {
  return [
    ...(systemOnClick(name) ? [] : [{ action: 'full' as const, label: 'Ouvrir en plein écran' }]),
    ...(offersSystem(name) ? [{ action: 'system' as const, label: 'Ouvrir avec l’application du système' }] : []),
    { action: 'rename', label: 'Renommer' },
    { action: 'remove', label: 'Retirer du nœud' },
  ];
}

/** A click on a file Cirrus has no view for opens it with the system's application. */
export const systemOnClick = (name: string): boolean => fileKind(name) === 'other';

/**
 * What a click on a file of a pop-up does: its preview, or, for a kind Cirrus has no view for, its system's application.
 * Once: a double-click's second click (`detail` 2) does nothing more (HTMLElement.click(), as the captures click, counts
 * 0). A click whose press closed a menu never comes here: the click guard swallows it (ui/clickGuard.ts).
 */
export function fileClick(name: string, detail: number): 'preview' | 'system' | null {
  if (detail > 1) return null;
  return systemOnClick(name) ? 'system' : 'preview';
}

/**
 * A file's thumbnail in its node's pop-up: an image itself up to `thumbMaxMb` (the <img> reads it whole), the icon of
 * its kind past it, so that opening a pop-up reads no image past thumbMaxMb (ruling I3 of the task 5 review); a PDF's
 * first page at any size, which pdf.js reads by ranges, without fetching ahead, and no more than thumbMaxMb of it
 * (pageThumbnail, task 6: past them, the PDF's icon); none for another kind.
 */
export function thumbFor(file: FileRef, thumbMaxMb: number): 'image' | 'icon' | 'pdf' | null {
  const kind = fileKind(file.name);
  if (kind === 'pdf') return 'pdf';
  if (kind !== 'image') return null;
  return file.size <= thumbMaxMb * 2 ** 20 ? 'image' : 'icon';
}

/** A double-click on a file Cirrus shows: its full screen (its first click opened the preview). */
export const fileDoubleClick = (name: string): 'full' | null => (systemOnClick(name) ? null : 'full');
