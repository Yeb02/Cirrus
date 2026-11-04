import {
  type Action, connKind, connTrashed, effectiveTags, type FileRef, type Id, KNOWLEDGE, memberOf, type NodeRec, nodeRow, placedIn, planId, type PlanRec,
  type State, subjectOf, TagError, type TagValue,
} from '@cirrus/core';
import type { RenderParams } from '@cirrus/view';
import { useEffect, useRef, useState } from 'react';
import type { HistorySummary } from '../../main/files.ts';
import { type Build, removeFileBuild, renameBuild, renameFileBuild, summaryBuild, tagsBuild } from '../actions.ts';
import { type FileKind, fileKind, formatSize } from '../files/kind.ts';
import { checkFileName } from '../files/merge.ts';
import { droppedPaths, type FileAction, fileMenu, type NodeFiles, systemOnClick } from '../files/nodeFiles.ts';
import { parseTag, tagSuggestions, withoutTag, withTag } from '../files/tags.ts';
import { ContextMenu } from './ContextMenu.tsx';
import { FloatingPanel, type Frame } from './panels/FloatingPanel.tsx';

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
 * its places, undo and redo included. Several actions gathered into one render are not told apart: read again. Null
 * while it is read; « failed » when it could not be (Minor 3 of the review).
 */
function useHistory(id: Id, rev: number, action: Action | null): HistorySummary | 'failed' | null {
  const [summary, setSummary] = useState<HistorySummary | 'failed' | null>(null);
  const seen = useRef<number | null>(null), asked = useRef(0);
  useEffect(() => {
    const before = seen.current;
    seen.current = rev;
    if (before !== null && rev === before + 1 && !action?.ops.some((op) => subjectOf(op) === id)) return;
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

/**
 * The node's files (spec 12; plan 4a, task 4): name, kind, size. A right click opens the file's menu (fileMenu): open it
 * with the system's application, rename it in place, take it out of the node (its copy stays in the store). A click on
 * a file Cirrus has no view for opens it with the system. « Ajouter des fichiers… » takes files chosen in the system's
 * dialog; files dropped on the pop-up come in too (NodePopup). A new name is checked on Enter (checkFileName), its
 * refusal said under the list; leaving the field keeps it, a refusal then in a toast; Escape gives it up.
 */
function Files(props: { id: Id; files: FileRef[]; actions: NodeFiles; onEdit(build: Build): Promise<boolean> }) {
  const [menu, setMenu] = useState<{ x: number; y: number; file: FileRef } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The rename given up by Escape: leaving the field then keeps the old name. */
  const givenUp = useRef(false);
  const pick = (action: FileAction, f: FileRef) => {
    if (action === 'system') void props.actions.openWithSystem(f);
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
            const system = systemOnClick(f.name);
            return (
              <li
                key={f.name} className={system ? 'file system' : 'file'} data-name={f.name}
                // Once, a double-click's second click aside (it would open a second copy of the application).
                onClick={(e) => { if (system && e.detail <= 1 && renaming !== f.name) void props.actions.openWithSystem(f); }}
                onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, file: f }); }}
              >
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
                ) : <span className="name" title={system ? `${f.name}\nUn clic l’ouvre avec l’application du système.` : f.name}>{f.name}</span>}
                <span className="kind">{KIND[fileKind(f.name)]}</span>
                <span className="size">{formatSize(f.size)}</span>
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="error">{error}</p>}
      <button className="add-files" onClick={() => void props.actions.pickInto(props.id)}>Ajouter des fichiers…</button>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={fileMenu(menu.file.name)} onClose={() => setMenu(null)} onPick={(a) => pick(a, menu.file)} />}
    </>
  );
}

/**
 * A node's pop-up (spec 12), in a floating panel: its title in the header, typed in place (Enter or leaving the field
 * keeps it, Escape gives it up); its summary as LaTeX source, kept on leaving the field; its tags; its metadata (history,
 * plans, knowledge connections, identifier); its files (Files; their previews come with tasks 5 and 6), which files
 * dropped anywhere on the pop-up join (importInto). `found`: the node as resolveTarget finds it, null once it is gone
 * (Review Focus 5). An edit the session refuses (in a toast) puts its field back to the node's value.
 */
export function NodePopup(props: {
  frame: Frame; id: Id; found: NodeRec | null; state: State; rev: number; action: Action | null; params: RenderParams;
  onEdit(build: Build): Promise<boolean>; onOpenPlan(plan: Id): void; files: NodeFiles;
}) {
  const { id, found: n, state: s } = props;
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
    return (
      <>
        <h4>Résumé (LaTeX)</h4>
        <textarea
          key={`r${n.summary}`} defaultValue={n.summary} rows={4} placeholder="Résumé, en LaTeX" spellCheck={false}
          onBlur={(e) => { const v = e.target.value; if (v !== n.summary) commit(e.target, summaryBuild(id, v), (x) => x.summary); }}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.currentTarget.blur(); } }}
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
        <Files id={id} files={n.files} actions={props.files} onEdit={props.onEdit} />
      </>
    );
  })();
  // Files dropped anywhere on the pop-up of a node that is there.
  const drop = n ? (dt: DataTransfer) => {
    const d = droppedPaths(dt.files, (f) => window.cirrus.pathForFile(f));
    if (d.paths.length + d.refused.length > 0) void props.files.importInto(id, d.paths, d.refused);
  } : undefined;
  return <FloatingPanel frame={props.frame} className="node-popup" title={title} onDropFiles={drop}>{body}</FloatingPanel>;
}
