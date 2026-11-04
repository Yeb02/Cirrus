import type { FileRef, Id } from '@cirrus/core';
import type { ImportResult, OpenResult } from '../../main/files.ts';
import { filesBuild, UP_TO_DATE } from '../actions.ts';
import type { EditSession } from '../session.ts';
import { fileKind, type FileKind } from './kind.ts';
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

/** Whether a drag carries files (from the explorer): text dragged in a field is left to the field. */
export const carriesFiles = (e: { dataTransfer: DataTransfer | null }): boolean => e.dataTransfer?.types.includes('Files') === true;

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
 * show. Text, code, LaTeX and tables are only ever shown in Cirrus (task 5): a script is never handed to Windows.
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
 * An image's thumbnail in its node's pop-up: the image itself up to `thumbMaxMb` (the <img> reads it whole), the icon
 * of its kind past it, so that opening a pop-up reads no file past thumbMaxMb (ruling I3 of the task 5 review); none
 * for another kind.
 */
export function thumbFor(file: FileRef, thumbMaxMb: number): 'image' | 'icon' | null {
  if (fileKind(file.name) !== 'image') return null;
  return file.size <= thumbMaxMb * 2 ** 20 ? 'image' : 'icon';
}

/** A double-click on a file Cirrus shows: its full screen (its first click opened the preview). */
export const fileDoubleClick = (name: string): 'full' | null => (systemOnClick(name) ? null : 'full');
