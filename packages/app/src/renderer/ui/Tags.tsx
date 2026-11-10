import { effectiveTags, type State, TagError, type TagKeyDef, type TagValue } from '@cirrus/core';
import { useRef, useState } from 'react';
import { parseTag, tagSuggestions, withoutTag, withTag } from '../files/tags.ts';

/** « clé : valeur », a number the French way; a word alone. */
const tagText = (t: TagValue) => (t.value === undefined ? t.key : `${t.key} : ${typeof t.value === 'number' ? t.value.toLocaleString('fr-FR') : t.value}`);

/** A change of an object's tags (withTag, withoutTag), made on the tags it has when the edit is computed. */
export type TagsChange = (tags: TagValue[], defs: ReadonlyMap<string, TagKeyDef>) => TagValue[];

/**
 * The tags (spec 5.4) of a node (its pop-up) or of a connection (its pop-up, plan 6a, D4): removable « clé : valeur »
 * chips; the required keys it lacks, greyed with their default value (effectiveTags), which a click lets choose. A field
 * adds a tag (parseTag), with suggestions from the registry's keys of this `scope` (node, or connection; a key of scope
 * « les deux » is in both), then from the values of the key's enumeration (`suggested` at most); arrows pick one, Enter
 * adds it, or adds what is typed. `onChange` writes a change (tagsBuild or connectionTagsBuild through the session) and
 * resolves with whether it was written: a tag the session refuses gives back the text that asked for it (the refusal is in
 * a toast).
 */
export function Tags(props: { s: State; scope: 'node' | 'connection'; tags: TagValue[]; suggested: number; onChange(change: TagsChange): Promise<boolean> }) {
  const defs = props.s.tagKeys;
  const missing = effectiveTags(props.tags, props.scope, defs).slice(props.tags.length);
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [pick, setPick] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const found = focused ? tagSuggestions(text, defs, props.scope, props.suggested) : [];
  const type = (v: string) => { setText(v); setPick(-1); setError(null); };
  const add = (tag: TagValue) => {
    const typed = text;
    type('');
    if (withTag(props.tags, tag, defs) === props.tags) return;
    void props.onChange((tags, d) => withTag(tags, tag, d)).then((ok) => { if (!ok) setText((t) => (t === '' ? typed : t)); });
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
            <button className="remove" title="Retirer ce tag" onClick={() => props.onChange((tags) => withoutTag(tags, t))}>×</button>
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
