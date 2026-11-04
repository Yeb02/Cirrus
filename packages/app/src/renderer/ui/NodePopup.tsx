import {
  type Action, connKind, connTrashed, effectiveTags, type Id, KNOWLEDGE, memberOf, type NodeRec, nodeRow, placedIn, planId, type PlanRec, type State,
  subjectOf, TagError, type TagValue,
} from '@cirrus/core';
import type { RenderParams } from '@cirrus/view';
import { useEffect, useRef, useState } from 'react';
import type { HistorySummary } from '../../main/files.ts';
import { type Build, renameBuild, summaryBuild, tagsBuild } from '../actions.ts';
import { type FileKind, fileKind, formatSize } from '../files/kind.ts';
import { parseTag, tagSuggestions, withoutTag, withTag } from '../files/tags.ts';
import { FloatingPanel, type Frame } from './panels/FloatingPanel.tsx';

const KIND: Record<FileKind, string> = { image: 'image', pdf: 'PDF', tex: 'LaTeX', text: 'texte', table: 'tableau', other: 'autre' };
const DATE = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' });

/** « clé : valeur », a number the French way; a word alone. */
const tagText = (t: TagValue) => (t.value === undefined ? t.key : `${t.key} : ${typeof t.value === 'number' ? t.value.toLocaleString('fr-FR') : t.value}`);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The node's history in three figures (historyOf), read at opening, then again after each action on it — its record or
 * its places, undo and redo included. Several actions gathered into one render are not told apart: read again.
 */
function useHistory(id: Id, rev: number, action: Action | null): HistorySummary | null {
  const [summary, setSummary] = useState<HistorySummary | null>(null);
  const seen = useRef<number | null>(null), asked = useRef(0);
  useEffect(() => {
    const before = seen.current;
    seen.current = rev;
    if (before !== null && rev === before + 1 && !action?.ops.some((op) => subjectOf(op) === id)) return;
    const n = ++asked.current;
    window.cirrus.historyOf(id).then((h) => { if (asked.current === n) setSummary(h); }, (e: unknown) => console.error('Historique du nœud illisible :', e));
  }, [id, rev]);
  return summary;
}

/**
 * The tags (spec 5.4): removable « clé : valeur » chips; the required keys it lacks, greyed with their default value
 * (effectiveTags), which a click lets choose. A field adds a tag (parseTag), with suggestions from the registry's keys,
 * then from the values of the key's enumeration (`suggested` at most); arrows pick one, Enter adds it, or adds what is typed.
 */
function Tags(props: { s: State; id: Id; tags: TagValue[]; suggested: number; onEdit(build: Build): void }) {
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
    if (withTag(props.tags, tag, defs) !== props.tags) props.onEdit(tagsBuild(props.id, (tags, d) => withTag(tags, tag, d)));
    type('');
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
 * A node's pop-up (spec 12), in a floating panel: its title in the header, typed in place (Enter or leaving the field
 * keeps it, Escape gives it up); its summary as LaTeX source, kept on leaving the field; its tags; its metadata (history,
 * plans, knowledge connections, identifier); its files (their actions come with task 4, their previews with tasks 5 and
 * 6). `found`: the node as resolveTarget finds it, null once it is gone (Review Focus 5).
 */
export function NodePopup(props: {
  frame: Frame; id: Id; found: NodeRec | null; state: State; rev: number; action: Action | null; params: RenderParams;
  onEdit(build: Build): void; onOpenPlan(plan: Id): void;
}) {
  const { id, found: n, state: s } = props;
  const history = useHistory(id, props.rev, props.action);
  // The last title seen stays in the header once the node is gone.
  const lastTitle = useRef('');
  if (n) lastTitle.current = n.title;

  const title = n
    ? (
      <input
        key={`t${n.title}`} className="title" defaultValue={n.title} placeholder="Titre du nœud" spellCheck={false}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v && v !== n.title) props.onEdit(renameBuild(id, v));
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
    const date = (ms: number | null | undefined) => (ms === undefined ? '…' : ms === null ? '—' : DATE.format(ms));
    return (
      <>
        <h4>Résumé (LaTeX)</h4>
        <textarea
          key={`r${n.summary}`} defaultValue={n.summary} rows={4} placeholder="Résumé, en LaTeX" spellCheck={false}
          onBlur={(e) => { const v = e.target.value; if (v !== n.summary) props.onEdit(summaryBuild(id, v)); }}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.currentTarget.blur(); } }}
        />
        <h4>Tags</h4>
        <Tags s={s} id={id} tags={n.tags} suggested={props.params.tagSuggestions} onEdit={props.onEdit} />
        <h4>Métadonnées</h4>
        <dl className="meta">
          <dt>Créé le</dt><dd>{date(history?.created)}</dd>
          <dt>Modifié le</dt><dd>{date(history?.modified)}</dd>
          <dt>Historique</dt><dd>{history ? plural(history.changes, 'modification', 'modifications') : '…'}</dd>
          <dt>Plans</dt>
          <dd>
            {plans.length === 0 ? 'aucun' : plans.map((p) => <button key={p.id} className="plan" title="Ouvrir ce plan" onClick={() => props.onOpenPlan(p.id)}>{p.name}</button>)}
          </dd>
          <dt>Connexions</dt><dd>{plural(knowledge, 'connexion de connaissance', 'connexions de connaissance')}</dd>
          <dt>Identifiant</dt><dd className="id volatile">{id}</dd>
        </dl>
        <h4>Fichiers</h4>
        {n.files.length === 0 ? <p className="dim">Aucun fichier.</p> : (
          <ul className="files">
            {n.files.map((f) => (
              <li key={f.name} className="file" data-name={f.name}>
                <span className="name" title={f.name}>{f.name}</span>
                <span className="kind">{KIND[fileKind(f.name)]}</span>
                <span className="size">{formatSize(f.size)}</span>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  })();
  return <FloatingPanel frame={props.frame} className="node-popup" title={title}>{body}</FloatingPanel>;
}
