import {
  type Action, type Anchor, connKind, connTrashed, effectiveTags, type FileRef, type Id, KNOWLEDGE, memberOf, type NodeRec, nodeRow, placedIn, planId,
  type PlanRec, type State, subjectOf, TagError, type TagValue,
} from '@cirrus/core';
import type { RenderParams } from '@cirrus/view';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { HistorySummary } from '../../main/files.ts';
import { type Build, removeFileBuild, renameBuild, renameFileBuild, summaryBuild, tagsBuild } from '../actions.ts';
import { type AnnotationEntry, type AnnotationIndex, type AnnotationSource, annotationSource, titleChars } from '../files/annotations.ts';
import { type FileKind, fileKind, fileUrl, formatSize } from '../files/kind.ts';
import { checkFileName } from '../files/merge.ts';
import { absentVersion, blobSize, loading } from '../files/read.ts';
import {
  droppedPaths, dropRoute, type FileAction, fileClick, fileDoubleClick, fileMenu, type NodeFiles, systemOnClick, thumbFor,
} from '../files/nodeFiles.ts';
import { parseTag, tagSuggestions, withoutTag, withTag } from '../files/tags.ts';
import type { LatexRegistry, Origin } from '../latex/registry.ts';
import { ContextMenu } from './ContextMenu.tsx';
import { LatexField } from './latex/LatexField.tsx';
import { FloatingPanel, type Frame } from './panels/FloatingPanel.tsx';
import { type AnnotationActions, AnnotationItem, EARLIER_VERSION, useAnnotationMenu } from './viewers/AnnotationMargin.tsx';

const KIND: Record<FileKind, string> = { image: 'image', pdf: 'PDF', tex: 'LaTeX', text: 'texte', table: 'tableau', other: 'autre' };
const DATE = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' });
/**
 * When this window opened: a date of the history written since (an edit of this session) differs from one capture to
 * the next, so it is `volatile` (not drawn in captures), as the identifier is.
 */
const OPENED_AT = Date.now();

/** « clé : valeur », a number the French way; a word alone. */
const tagText = (t: TagValue) => (t.value === undefined ? t.key : `${t.key} : ${typeof t.value === 'number' ? t.value.toLocaleString('fr-FR') : t.value}`);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The node's history in three figures (historyOf), read at opening, then again after each action on it — its record or
 * its places, undo and redo included. Several actions gathered into one render are not told apart, nor a state read
 * again from the base (no action, plan 5a): read again. Null while it is read; « failed » when it could not be (Minor 3
 * of the review).
 */
function useHistory(id: Id, rev: number, action: Action | null): HistorySummary | 'failed' | null {
  const [summary, setSummary] = useState<HistorySummary | 'failed' | null>(null);
  const seen = useRef<number | null>(null), asked = useRef(0);
  useEffect(() => {
    const before = seen.current;
    seen.current = rev;
    if (before !== null && rev === before + 1 && action && !action.ops.some((op) => subjectOf(op) === id)) return;
    const n = ++asked.current;
    window.cirrus.historyOf(id).then(
      (h) => { if (asked.current === n) setSummary(h); },
      (e: unknown) => { console.error('Historique du nœud illisible :', e); if (asked.current === n) setSummary('failed'); },
    );
  }, [id, rev]);
  return summary;
}

/**
 * The tags (spec 5.4): removable « clé : valeur » chips; the required keys it lacks, greyed with their default value
 * (effectiveTags), which a click lets choose. A field adds a tag (parseTag), with suggestions from the registry's keys,
 * then from the values of the key's enumeration (`suggested` at most); arrows pick one, Enter adds it, or adds what is typed.
 * A tag the session refuses gives back the text that asked for it (the refusal is in a toast).
 */
function Tags(props: { s: State; id: Id; tags: TagValue[]; suggested: number; onEdit(build: Build): Promise<boolean> }) {
  const defs = props.s.tagKeys;
  const missing = effectiveTags(props.tags, 'node', defs).slice(props.tags.length);
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [pick, setPick] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const found = focused ? tagSuggestions(text, defs, 'node', props.suggested) : [];
  const type = (v: string) => { setText(v); setPick(-1); setError(null); };
  const add = (tag: TagValue) => {
    const typed = text;
    type('');
    if (withTag(props.tags, tag, defs) === props.tags) return;
    void props.onEdit(tagsBuild(props.id, (tags, d) => withTag(tags, tag, d))).then((ok) => { if (!ok) setText((t) => (t === '' ? typed : t)); });
  };
  const submit = (input: string) => {
    try {
      add(parseTag(input, defs));
    } catch (e) {
      if (!(e instanceof TagError)) throw e;
      setError(e.message);
    }
  };
  // A key that takes a value is written with its colon, for its value to be typed (or picked) next.
  const choose = (sug: { key: string; value?: string }) => {
    if (sug.value !== undefined) add({ key: sug.key, value: sug.value });
    else if (defs.get(sug.key)?.type === 'word') add({ key: sug.key });
    else type(`${sug.key}:`);
    field.current?.focus();
  };
  return (
    <>
      <ul className="tags">
        {props.tags.map((t, i) => (
          <li key={i} className="tag">
            {tagText(t)}
            <button className="remove" title="Retirer ce tag" onClick={() => props.onEdit(tagsBuild(props.id, (tags) => withoutTag(tags, t)))}>×</button>
          </li>
        ))}
        {missing.map((t) => (
          <li key={`défaut ${t.key}`} className="tag default" title="Valeur par défaut, non enregistrée : clique pour en choisir une">
            <button onClick={() => { type(`${t.key}:`); field.current?.focus(); }}>{tagText(t)}</button>
          </li>
        ))}
      </ul>
      <input
        ref={field} className="tag-field" value={text} placeholder="Ajouter un tag : mot, ou clé:valeur" spellCheck={false}
        onChange={(e) => type(e.target.value)} onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); setPick(-1); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (found.length > 0) setPick((i) => (e.key === 'ArrowDown' ? (i + 1) % found.length : (i <= 0 ? found.length : i) - 1));
          } else if (e.key === 'Enter') {
            if (pick >= 0 && pick < found.length) choose(found[pick]);
            else if (text.trim() !== '') submit(text);
          } else if (e.key === 'Escape') {
            // The field's: it empties, then lets go; the panel stays (a next Escape closes it).
            e.preventDefault();
            if (text !== '') type('');
            else e.currentTarget.blur();
          }
        }}
      />
      {error && <p className="error">{error}</p>}
      {found.length > 0 && (
        <div className="suggestions" role="listbox">
          {found.map((sug, i) => (
            // Pressed, a suggestion keeps the focus in the field.
            <button key={`${sug.key}:${sug.value ?? ''}`} role="option" aria-selected={i === pick} className={i === pick ? 'pick on' : 'pick'}
              onMouseDown={(e) => e.preventDefault()} onClick={() => choose(sug)}>
              {sug.value === undefined ? sug.key : `${sug.value} (${sug.rank})`}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** The icon of an image too large for its thumbnail (thumbMaxMb): a frame, a hill and a sun. */
const ImageIcon = (props: { px: number }) => (
  <svg className="thumb icon" viewBox="0 0 24 24" width={props.px} height={props.px} aria-hidden="true">
    <rect x="3.5" y="5.5" width="17" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <path d="M5 17l4.5-5 3.5 3.5 2.5-2.5L19 17z" fill="currentColor" opacity="0.55" />
    <circle cx="15.5" cy="9.5" r="1.5" fill="currentColor" opacity="0.7" />
  </svg>
);

/** The icon of a PDF whose first page could not be drawn: a sheet, its corner folded, lines of text. */
const PdfIcon = (props: { px: number }) => (
  <svg className="thumb icon" viewBox="0 0 24 24" width={props.px} height={props.px} aria-hidden="true">
    <path d="M6.5 3.5h8l3.5 3.5v13.5h-11.5z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    <path d="M14.5 3.5v3.5h3.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    <path d="M9 11h6.5M9 13.5h6.5M9 16h4.5" stroke="currentColor" strokeWidth="1" opacity="0.6" />
  </svg>
);

/**
 * An image as its own thumbnail, read once in view; by a thumbnail's request (plan 5a, D6), which never downloads it:
 * an image the store does not hold yet shows its kind's icon.
 */
function ImageThumb(props: { file: FileRef; px: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [props.file.hash]);
  if (failed) return <ImageIcon px={props.px} />;
  return (
    <img
      className="thumb" src={fileUrl(props.file, { thumbnail: true })} alt="" loading="lazy" decoding="async" draggable={false}
      width={props.px} height={props.px} onError={() => setFailed(true)}
    />
  );
}

/**
 * A PDF's first page as its thumbnail (pageThumbnail: read by ranges whatever the file's size, at most thumbMaxMb),
 * drawn once per session; pdf.js comes with the reader's chunk, loaded with the first of them. Its box keeps its size
 * meanwhile; the PDF icon if it cannot be drawn, or not within thumbMaxMb.
 */
function PdfThumb(props: { file: FileRef; px: number; kept: number; maxMb: number }) {
  const [src, setSrc] = useState<string | 'failed' | null>(null);
  useEffect(() => {
    let live = true;
    void loading((async () => {
      try {
        const m = await import('../files/pdf.ts');
        const url = await m.pageThumbnail(props.file, props.px, props.kept, props.maxMb * 2 ** 20);
        if (live) setSrc(url);
      } catch (e) {
        // Past thumbMaxMb is no fault (BudgetError): pdf.ts says it in the console.
        if (!(e instanceof Error && e.name === 'BudgetError')) console.error(`Vignette de « ${props.file.name} » :`, e);
        if (live) setSrc('failed');
      }
    })());
    return () => { live = false; };
  }, [props.file.hash, props.px, props.maxMb]);
  if (src === 'failed') return <PdfIcon px={props.px} />;
  if (src === null) return <span className="thumb" style={{ width: props.px, height: props.px }} />;
  return <img className="thumb" src={src} alt="" draggable={false} width={props.px} height={props.px} />;
}

/** How a file of the pop-up is opened: its preview beside the pop-up, or its full screen (Panels). */
type OpenFile = (name: string, how: 'preview' | 'full') => void;
/** An annotation opened from a pop-up (plan 4c, D4): the preview of `name`, a file of node `pdf`, beside it, showing `anchor`. */
type RevealAnnotation = (pdf: Id, name: string, anchor: Anchor) => void;

/** A version the store does not hold: why, and whether it cannot be opened (absentVersion). */
type Absent = { text: string; blocks: boolean };
/** Versions the store cannot give: none. */
const ALL_READ: ReadonlyMap<string, Absent> = new Map();

/**
 * The versions among `refs` the store does not hold — a blob missing: a base copied without it, a PC never sent it
 * (Review Focus 4); or not downloaded yet from the server paired (plan 5a, R12), which opens and is downloaded then —
 * each with why, in French. Each is asked once per list of versions shown, by its size only (blobSize, `sizeOnly`: the
 * body is not read, nothing downloaded); counted among what the views load, which the captures wait for.
 */
function useAbsent(refs: readonly { name: string; hash: string }[]): ReadonlyMap<string, Absent> {
  const key = refs.map((r) => `${r.hash}:${r.name}`).join('|');
  const [out, setOut] = useState(ALL_READ);
  useEffect(() => {
    if (refs.length === 0) { setOut(ALL_READ); return; }
    const stop = new AbortController();
    void loading(Promise.all(refs.map((r) => blobSize(r, stop.signal, { sizeOnly: true }).then(
      () => null,
      (e: unknown): [string, Absent] => [r.hash, absentVersion(e, r.name)],
    )))).then((found) => {
      if (stop.signal.aborted) return;
      const m = new Map(found.filter((x) => x !== null));
      setOut(m.size === 0 ? ALL_READ : m);
    });
    return () => stop.abort();
  }, [key]);
  return out;
}

/** Why an annotation cannot be opened, or null: its source missing (annotationSource), or its version (useAbsent). */
const missing = (src: AnnotationSource, hash: string, absent: ReadonlyMap<string, Absent>): string | null => {
  if ('why' in src) return src.why;
  const a = absent.get(hash);
  return a?.blocks ? a.text : null;
};
/** What is said of an annotation that opens: its version not downloaded yet (plan 5a, R12), or null. */
const pendingNote = (hash: string, absent: ReadonlyMap<string, Absent>): string | null => {
  const a = absent.get(hash);
  return a && !a.blocks ? a.text : null;
};

/**
 * An annotation's node (plan 4c, D1): « Annotation de « <PDF> », p. <n> », a click opening its PDF there — its file's
 * preview beside the pop-up, on its version, its passage blinking (`onReveal`). What is missing says so instead, and it
 * does not open (Review Focus 4): the PDF's node in the trash or gone, its file no longer in it, the version missing
 * from the store.
 */
function AnnotationOf(props: { s: State; anchor: Anchor; onReveal: RevealAnnotation }) {
  const a = props.anchor, src = annotationSource(props.s, a);
  const absent = useAbsent('file' in src ? [{ name: src.file.name, hash: a.hash }] : []);
  const why = missing(src, a.hash, absent), note = pendingNote(a.hash, absent);
  const text = `Annotation de « ${props.s.nodes.get(a.pdf)?.title ?? '?'} », p. ${a.page}`;
  return (
    <p className="annotation-of">
      {why === null && 'file' in src
        ? <><button title="Ouvrir le PDF à cette page" onClick={() => props.onReveal(a.pdf, src.file.name, a)}>{text}</button>{note && <span className="why">{note}</span>}</>
        : <>{text}<span className="why">{why}</span></>}
    </p>
  );
}

/**
 * A PDF's node's annotations (plan 4c, D4): those of its files, every version, in the order of the pages, as the
 * reader's margin lists them (AnnotationItem). A click opens one in its file's preview, beside the pop-up, at its page,
 * its passage blinking (`onReveal`); each is dragged out onto the graph, to be put down in the plan shown (task 3). One
 * whose file is no longer in the node, or whose version the store cannot give, says so and does not open (Review
 * Focus 4); it is still dragged out. A right click opens its menu (`actions`, final review I2): its node's pop-up
 * beside this one, its deletion everywhere.
 */
function Annotations(props: { s: State; entries: readonly AnnotationEntry[]; titleChars: number; onReveal: RevealAnnotation; actions: AnnotationActions }) {
  const sources = props.entries.map((e) => annotationSource(props.s, e.anchor));
  const refs = new Map<string, { name: string; hash: string }>();
  sources.forEach((src, i) => { const hash = props.entries[i].anchor.hash; if ('file' in src) refs.set(hash, { name: src.file.name, hash }); });
  const absent = useAbsent([...refs.values()]);
  const { onMenu, menu } = useAnnotationMenu(props.actions);
  return (
    <>
      <ol className="annotation-list">
        {props.entries.map((e, i) => {
          const src = sources[i], why = missing(src, e.anchor.hash, absent);
          const earlier = 'file' in src && src.earlier ? EARLIER_VERSION : null, note = pendingNote(e.anchor.hash, absent);
          return (
            <AnnotationItem
              key={e.node.id} entry={e} titleChars={props.titleChars} here={false} draggable
              note={why ?? (note && earlier ? `${earlier} ; ${note}` : note ?? earlier)}
              onOpen={why === null && 'file' in src ? () => props.onReveal(e.anchor.pdf, src.file.name, e.anchor) : undefined} onMenu={onMenu}
            />
          );
        })}
      </ol>
      {menu}
    </>
  );
}

/**
 * The node's files (spec 12; plan 4a, tasks 4 to 6): name, kind, size, an image's thumbnail (thumbPx, read only once
 * in view, and only up to thumbMaxMb: thumbFor), a PDF's first page (PdfThumb, at most thumbMaxMb read). A click on
 * a file opens its preview, a double-click its full screen (`onOpen`); a click on a file Cirrus has no view for opens
 * it with the system (fileClick). A right click opens the file's menu (fileMenu): full screen, open it with the
 * system's application, rename it in place, take it out of the node (its copy stays in the store). The click that
 * closes the menu does nothing else: the click guard swallows it (clickGuard.ts). « Ajouter des fichiers… » takes
 * files chosen in the system's dialog; files dropped on the pop-up come in too (NodePopup). A new name is checked on
 * Enter (checkFileName), its refusal said under the list; leaving the field keeps it, a refusal then in a toast;
 * Escape gives it up.
 */
function Files(props: {
  id: Id; files: FileRef[]; thumbPx: number; thumbMaxMb: number; pdfDocsKept: number; actions: NodeFiles; onOpen: OpenFile;
  onEdit(build: Build): Promise<boolean>;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; file: FileRef } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The rename given up by Escape: leaving the field then keeps the old name. */
  const givenUp = useRef(false);
  const pick = (action: FileAction, f: FileRef) => {
    if (action === 'full') props.onOpen(f.name, 'full');
    else if (action === 'system') void props.actions.openWithSystem(f);
    else if (action === 'rename') { givenUp.current = false; setError(null); setRenaming(f.name); }
    else void props.onEdit(removeFileBuild(props.id, f.name));
  };
  const renamed = (f: FileRef, value: string) => {
    setRenaming(null);
    setError(null);
    const v = value.trim();
    if (!givenUp.current && v !== f.name) void props.onEdit(renameFileBuild(props.id, f.name, v));
  };
  return (
    <>
      {props.files.length === 0 ? <p className="dim">Aucun fichier.</p> : (
        <ul className="files">
          {props.files.map((f) => {
            const system = systemOnClick(f.name), thumb = thumbFor(f, props.thumbMaxMb);
            return (
              <li
                key={f.name} className={`file${system ? ' system' : ''}${thumb ? ' with-thumb' : ''}`} data-name={f.name}
                // A double-click opens the full screen, without selecting the name on the way.
                onMouseDown={(e) => { if (e.detail > 1 && renaming !== f.name) e.preventDefault(); }}
                // Once, a double-click's second click aside (it would open a second copy of the application).
                onClick={(e) => {
                  if (renaming === f.name) return;
                  const act = fileClick(f.name, e.detail);
                  if (act === 'system') void props.actions.openWithSystem(f);
                  else if (act === 'preview') props.onOpen(f.name, 'preview');
                }}
                onDoubleClick={() => { if (renaming !== f.name && fileDoubleClick(f.name)) props.onOpen(f.name, 'full'); }}
                onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, file: f }); }}
              >
                {thumb === 'image' && <ImageThumb file={f} px={props.thumbPx} />}
                {thumb === 'icon' && <ImageIcon px={props.thumbPx} />}
                {thumb === 'pdf' && <PdfThumb file={f} px={props.thumbPx} kept={props.pdfDocsKept} maxMb={props.thumbMaxMb} />}
                {renaming === f.name ? (
                  <input
                    className="name rename" autoFocus defaultValue={f.name} spellCheck={false} aria-label="Nouveau nom du fichier"
                    // The name without its extension is selected, as in the explorer.
                    onFocus={(e) => { const dot = f.name.lastIndexOf('.'); e.currentTarget.setSelectionRange(0, dot > 0 ? dot : f.name.length); }}
                    onChange={() => setError(null)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const why = checkFileName(e.currentTarget.value.trim(), props.files, f.name);
                        if (why) setError(why);
                        else e.currentTarget.blur();
                      } else if (e.key === 'Escape') {
                        // The field's: the panel stays.
                        e.preventDefault();
                        givenUp.current = true;
                        e.currentTarget.blur();
                      }
                    }}
                    onBlur={(e) => renamed(f, e.target.value)}
                  />
                ) : (
                  <span
                    className="name"
                    title={`${f.name}\n${system ? 'Un clic l’ouvre avec l’application du système.' : 'Un clic montre son aperçu, un double-clic le plein écran.'}`}
                  >
                    {f.name}
                  </span>
                )}
                <span className="kind">{KIND[fileKind(f.name)]}</span>
                <span className="size">{formatSize(f.size)}</span>
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="error">{error}</p>}
      <button className="add-files" onClick={() => void props.actions.pickInto(props.id)}>Ajouter des fichiers…</button>
      {menu && (
        <ContextMenu
          x={menu.x} y={menu.y} items={fileMenu(menu.file.name)} onPick={(a) => pick(a, menu.file)}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

/**
 * A node's pop-up (spec 12), in a floating panel: its title in the header, typed in place (Enter or leaving the field
 * keeps it, Escape gives it up); its summary compiled, edited in place with its preview under it (LatexField, plan 4b,
 * task 6: kept on leaving the field, given up by Escape), a link in it opening its node's pop-up (`onNodeLink`); its
 * tags; its metadata (history, plans, knowledge connections, identifier); its files (Files), each opened in a preview
 * or in full screen (`onOpenFile`), which files dropped anywhere on the pop-up join (importInto). A PDF's node lists
 * its annotations (plan 4c: `annotations`, App's index), an annotation's node names its PDF and page; either opens an
 * annotation beside the pop-up (`onReveal`). A line of its annotations has its menu (final review, I2): the
 * annotation's pop-up beside this one (`onNodeLink`, as a link), its deletion everywhere (`onDeleteAnnotation`).
 * `found`: the node as resolveTarget finds it, null once it is gone (Review Focus 5). An edit the session refuses (in
 * a toast) puts its field back to the node's value.
 */
export function NodePopup(props: {
  frame: Frame; id: Id; found: NodeRec | null; state: State; rev: number; action: Action | null; params: RenderParams;
  onEdit(build: Build): Promise<boolean>; onOpenPlan(plan: Id): void; files: NodeFiles; onOpenFile: OpenFile;
  registry: LatexRegistry | null; onNodeLink(node: Id): void; annotations: AnnotationIndex | null; onReveal: RevealAnnotation;
  onDeleteAnnotation(node: Id): void;
}) {
  const { id, found: n, state: s } = props;
  const latestProps = useRef(props);
  latestProps.current = props;
  const annotationActions = useMemo<AnnotationActions>(() => ({
    onOpenNode: (node) => latestProps.current.onNodeLink(node),
    onDelete: (node) => latestProps.current.onDeleteAnnotation(node),
  }), []);
  const summary = useMemo<Origin>(() => ({ kind: 'summary', node: id }), [id]);
  const history = useHistory(id, props.rev, props.action);
  // The last title seen stays in the header once the node is gone; a refused edit reads the node as it is by then.
  const lastTitle = useRef('');
  if (n) lastTitle.current = n.title;
  const latest = useRef(n);
  latest.current = n;
  /** Runs an edit from this field; refused, the field shows the node's value again, as it is once answered. */
  const commit = (el: HTMLInputElement | HTMLTextAreaElement, build: Build, value: (node: NodeRec) => string) => {
    void props.onEdit(build).then((ok) => { if (!ok && el.isConnected && latest.current) el.value = value(latest.current); });
  };

  const title = n
    ? (
      <input
        key={`t${n.title}`} className="title" defaultValue={n.title} placeholder="Titre du nœud" spellCheck={false}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v && v !== n.title) commit(e.target, renameBuild(id, v), (x) => x.title);
          else e.target.value = n.title;
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          else if (e.key === 'Escape') { e.preventDefault(); e.currentTarget.value = n.title; e.currentTarget.blur(); }
        }}
      />
    )
    : <span className="title gone">{lastTitle.current}</span>;

  const body = (() => {
    if (!n) return <p className="dim">Ce nœud n’existe plus.</p>;
    const row = nodeRow(s, id);
    const plans: PlanRec[] = row < 0 ? [] : Array.from(placedIn(s, row), (p) => s.plans.get(planId(s, p))).filter((p) => p !== undefined);
    let knowledge = 0;
    if (row >= 0) for (const c of memberOf(s, row)) if (connKind(s, c) === KNOWLEDGE && !connTrashed(s, c)) knowledge++;
    // « … » while it is read, « — » with no history or when it could not be read.
    const h = history === 'failed' ? { created: null, modified: null, changes: null } : history;
    const date = (ms: number | null | undefined) => (ms === undefined ? '…' : ms === null ? '—' : DATE.format(ms));
    const fresh = (ms: number | null | undefined) => (ms != null && ms >= OPENED_AT ? 'volatile' : undefined);
    const annotations = props.annotations?.of(id) ?? [];
    return (
      <>
        {n.anchor && <AnnotationOf s={s} anchor={n.anchor} onReveal={props.onReveal} />}
        <h4>Résumé (LaTeX)</h4>
        <LatexField
          origin={summary} value={n.summary} placeholder="Résumé, en LaTeX" rows={4} state={s} registry={props.registry} params={props.params}
          onCommit={(t) => props.onEdit(summaryBuild(id, t))} onNodeLink={props.onNodeLink}
        />
        <h4>Tags</h4>
        <Tags s={s} id={id} tags={n.tags} suggested={props.params.tagSuggestions} onEdit={props.onEdit} />
        <h4>Métadonnées</h4>
        <dl className="meta">
          <dt>Créé le</dt><dd className={fresh(h?.created)}>{date(h?.created)}</dd>
          <dt>Modifié le</dt><dd className={fresh(h?.modified)}>{date(h?.modified)}</dd>
          <dt>Historique</dt><dd>{!h ? '…' : h.changes === null ? '—' : plural(h.changes, 'modification', 'modifications')}</dd>
          <dt>Plans</dt>
          <dd>
            {plans.length === 0 ? 'aucun' : plans.map((p) => <button key={p.id} className="plan" title="Ouvrir ce plan" onClick={() => props.onOpenPlan(p.id)}>{p.name}</button>)}
          </dd>
          <dt>Connexions</dt><dd>{plural(knowledge, 'connexion de connaissance', 'connexions de connaissance')}</dd>
          <dt>Identifiant</dt><dd className="id volatile">{id}</dd>
        </dl>
        <h4>Fichiers</h4>
        <Files
          id={id} files={n.files} thumbPx={props.params.thumbPx} thumbMaxMb={props.params.thumbMaxMb} pdfDocsKept={props.params.pdfDocsKept}
          actions={props.files} onOpen={props.onOpenFile} onEdit={props.onEdit}
        />
        {annotations.length > 0 && (
          <>
            <h4>Annotations</h4>
            <Annotations
              s={s} entries={annotations} titleChars={titleChars(props.params.annotationTitleChars)} onReveal={props.onReveal} actions={annotationActions}
            />
          </>
        )}
      </>
    );
  })();
  // Files dropped anywhere on the pop-up go to its node, if it is there (dropRoute); else the pop-up takes none, and the
  // window refuses them.
  const route = dropRoute('popup', n ? id : null);
  const drop = route.to === 'node' ? (dt: DataTransfer) => {
    const d = droppedPaths(dt.files, (f) => window.cirrus.pathForFile(f));
    if (d.paths.length + d.refused.length > 0) void props.files.importInto(route.node, d.paths, d.refused);
  } : undefined;
  return <FloatingPanel frame={props.frame} className="node-popup" title={title} onDropFiles={drop}>{body}</FloatingPanel>;
}
