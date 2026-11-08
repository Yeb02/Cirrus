import type { LatexStatus } from '@cirrus/core';
import { DEFAULT_PARAMS, hexToRgb, type ParamSpec, type RenderParams, rgbToHex, type Rgb, WORD } from '@cirrus/view';
import { useEffect, useState } from 'react';
import type { SyncStatus } from '../../main/sync/client.ts';
import type { FirstSyncChoice, PairResult, ServerInfo } from '../../main/sync/host.ts';
import { latexStateText } from '../latex/install.ts';
import { ServerBlock } from './settings/ServerBlock.tsx';
import { type RubricView, settingsTree } from './settingsTree.ts';

type Value = RenderParams[keyof RenderParams];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A number typed in a field: kept as text while it is being typed, applied once it parses. */
function NumberField(props: { value: number; step?: number; onChange(v: number): void }) {
  const [text, setText] = useState(String(props.value));
  useEffect(() => { if (Number(text) !== props.value) setText(String(props.value)); }, [props.value]);
  return (
    <input
      type="number" className="num" value={text} step={props.step}
      onChange={(e) => { setText(e.target.value); const v = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(v)) props.onChange(v); }}
    />
  );
}

function ListField(props: { value: number[]; onChange(v: number[]): void }) {
  const [text, setText] = useState(props.value.join(', '));
  useEffect(() => { setText(props.value.join(', ')); }, [props.value]);
  const apply = () => {
    const v = text.split(',').map((x) => Number(x.trim()));
    if (v.length > 0 && v.every(Number.isFinite)) props.onChange(v);
    else setText(props.value.join(', '));
  };
  return <input type="text" className="list" value={text} onChange={(e) => setText(e.target.value)} onBlur={apply} onKeyDown={(e) => { if (e.key === 'Enter') apply(); }} />;
}

/** Words separated by spaces, applied like a list; a word outside WORD puts the text back. */
function WordsField(props: { value: string[]; onChange(v: string[]): void }) {
  const [text, setText] = useState(props.value.join(' '));
  useEffect(() => { setText(props.value.join(' ')); }, [props.value]);
  const apply = () => {
    const v = [...new Set(text.split(/\s+/).filter((w) => w !== ''))];
    if (v.every((w) => WORD.test(w))) props.onChange(v);
    else setText(props.value.join(' '));
  };
  return <input type="text" className="list" value={text} onChange={(e) => setText(e.target.value)} onBlur={apply} onKeyDown={(e) => { if (e.key === 'Enter') apply(); }} />;
}

function Control(props: { spec: ParamSpec; value: Value; onChange(v: Value): void }) {
  const { spec, value } = props;
  switch (spec.kind) {
    case 'number':
      return (
        <div className="control">
          <input type="range" min={spec.min} max={spec.max} step={spec.step} value={value as number} onChange={(e) => props.onChange(Number(e.target.value))} />
          <NumberField value={value as number} step={spec.step} onChange={props.onChange} />
        </div>
      );
    case 'range': {
      const [a, b] = value as [number, number];
      return (
        <div className="control">
          <NumberField value={a} step={spec.step} onChange={(v) => props.onChange([v, b])} />
          <span className="to">à</span>
          <NumberField value={b} step={spec.step} onChange={(v) => props.onChange([a, v])} />
        </div>
      );
    }
    case 'color':
      return <div className="control"><input type="color" value={rgbToHex(value as Rgb)} onChange={(e) => props.onChange(hexToRgb(e.target.value))} /></div>;
    case 'choice':
      return (
        <div className="control">
          <select value={value as string} onChange={(e) => props.onChange(e.target.value as Value)}>
            {spec.choices!.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>
      );
    case 'list':
      return <div className="control"><ListField value={value as number[]} onChange={props.onChange} /></div>;
    case 'words':
      return <div className="control"><WordsField value={value as string[]} onChange={props.onChange} /></div>;
  }
}

type Change = (key: keyof RenderParams, v: Value) => void;

function Param(props: { spec: ParamSpec; params: RenderParams; onChange: Change }) {
  const s = props.spec;
  return (
    // A div, not a label: a label would pass any click on its text to the reset button inside (I3 of the review).
    <div className="param">
      <span className="label">
        {s.label}
        {!same(props.params[s.key], DEFAULT_PARAMS[s.key]) && (
          <button className="reset" title="Valeur par défaut" aria-label={`Remettre « ${s.label} » par défaut`}
            onClick={(e) => { e.preventDefault(); props.onChange(s.key, DEFAULT_PARAMS[s.key]); }}>↺</button>
        )}
      </span>
      <Control spec={s} value={props.params[s.key]} onChange={(v) => props.onChange(s.key, v)} />
    </div>
  );
}

/** Groups and their settings, those of `pick` (the main ones, the advanced ones, or both in a search). */
function Groups(props: { groups: RubricView['groups']; pick: 'main' | 'advanced' | 'both'; params: RenderParams; onChange: Change; prefix?: string }) {
  return (
    <>
      {props.groups.map((g) => {
        const specs = props.pick === 'main' ? g.main : props.pick === 'advanced' ? g.advanced : [...g.main, ...g.advanced];
        if (specs.length === 0) return null;
        return (
          <div key={g.name} className="param-group">
            <h4>{props.prefix ? `${props.prefix} › ${g.name}` : g.name}</h4>
            {specs.map((s) => <Param key={s.key} spec={s} params={props.params} onChange={props.onChange} />)}
          </div>
        );
      })}
    </>
  );
}

/** The rubrics open, and those whose advanced settings show: kept from one opening of the panel to the next. */
const opened = new Set<string>();
const advancedShown = new Set<string>();

/**
 * The settings side panel (spec 19): generated from PARAM_SPECS, under the rubrics of PARAM_RUBRICS (settingsTree), each
 * folded until clicked; in each, its main settings, then « Avancés » for every other rendering or interaction constant.
 * A search shows every setting it finds, advanced ones included. Changes apply at once; they are not in the history nor
 * undoable. The « LaTeX » rubric (plan 4b, task 7) says LaTeX's state on this PC (`latex`), offers « Installer LaTeX »
 * when it is absent or its installation failed, and opens the preamble's full screen. The « Serveur » rubric (plan 5a)
 * begins with its block: pairing this PC, or its server and « Dissocier ce PC » (`server`).
 */
export function SettingsPanel(props: {
  params: RenderParams; onChange(p: RenderParams): void; onClose(): void; latex: LatexStatus | null; onInstallLatex(): void; onEditPreamble(): void;
  server: { info: ServerInfo | null; status: SyncStatus; onPair(url: string, code: string, name: string): Promise<PairResult>;
    onFirst(choice: FirstSyncChoice): Promise<PairResult>; onUnpair(): Promise<void>;
  };
}) {
  const [query, setQuery] = useState('');
  const [, refresh] = useState(0);
  const toggle = (set: Set<string>, title: string) => { if (!set.delete(title)) set.add(title); refresh((n) => n + 1); };
  const set: Change = (key, v) => props.onChange({ ...props.params, [key]: v });
  const state = props.latex?.state;
  const tree = settingsTree(query);
  const latexSetup = (
    <div className="param-group latex-setup">
      <p className="latex-state">{latexStateText(props.latex)}</p>
      <div className="latex-actions">
        {(state === 'absent' || state === 'failed') && <button onClick={props.onInstallLatex}>Installer LaTeX</button>}
        <button onClick={props.onEditPreamble}>Modifier le préambule…</button>
      </div>
    </div>
  );
  return (
    <aside className="settings" aria-label="Réglages">
      <header>
        <h2>Réglages</h2>
        <button className="close" aria-label="Fermer le bandeau" onClick={props.onClose}>×</button>
      </header>
      <input type="search" className="search" placeholder="Chercher un réglage" aria-label="Chercher un réglage" value={query} onChange={(e) => setQuery(e.target.value)} />
      {query.trim() !== ''
        ? tree.length === 0
          ? <p className="none">Aucun réglage ne correspond.</p>
          : tree.map((r) => <Groups key={r.title} groups={r.groups} pick="both" params={props.params} onChange={set} prefix={r.title} />)
        : tree.map((r) => {
          const open = opened.has(r.title), advanced = advancedShown.has(r.title);
          const count = r.groups.reduce((n, g) => n + g.advanced.length, 0);
          return (
            <section key={r.title} className="rubric" data-rubric={r.title}>
              <button className="rubric-title" aria-expanded={open} onClick={() => toggle(opened, r.title)}>{open ? '▾' : '▸'} {r.title}</button>
              {open && (
                <div className="rubric-body">
                  {r.title === 'LaTeX' && latexSetup}
                  {r.title === 'Serveur' && <ServerBlock {...props.server} />}
                  <Groups groups={r.groups} pick="main" params={props.params} onChange={set} />
                  {count > 0 && <button className="toggle" aria-expanded={advanced} onClick={() => toggle(advancedShown, r.title)}>{advanced ? '▾' : '▸'} Avancés ({count})</button>}
                  {advanced && <Groups groups={r.groups} pick="advanced" params={props.params} onChange={set} />}
                </div>
              )}
            </section>
          );
        })}
      <button className="reset-all" onClick={() => props.onChange({ ...DEFAULT_PARAMS })}>Tout réinitialiser</button>
    </aside>
  );
}
