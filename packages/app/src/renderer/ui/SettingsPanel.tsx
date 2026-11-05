import type { LatexStatus } from '@cirrus/core';
import { DEFAULT_PARAMS, hexToRgb, PARAM_SPECS, type ParamSpec, type RenderParams, rgbToHex, type Rgb, WORD } from '@cirrus/view';
import { useEffect, useState } from 'react';
import { latexStateText } from '../latex/install.ts';

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

function Section(props: { title: string; specs: ParamSpec[]; params: RenderParams; onChange(key: keyof RenderParams, v: Value): void }) {
  const groups = [...new Set(props.specs.map((s) => s.group))];
  return (
    <>
      {groups.map((g) => (
        <div key={g} className="param-group">
          <h3>{g}</h3>
          {props.specs.filter((s) => s.group === g).map((s) => (
            // A div, not a label: a label would pass any click on its text to the reset button inside (I3 of the review).
            <div key={s.key} className="param">
              <span className="label">
                {s.label}
                {!same(props.params[s.key], DEFAULT_PARAMS[s.key]) && (
                  <button className="reset" title="Valeur par défaut" aria-label={`Remettre « ${s.label} » par défaut`}
                    onClick={(e) => { e.preventDefault(); props.onChange(s.key, DEFAULT_PARAMS[s.key]); }}>↺</button>
                )}
              </span>
              <Control spec={s} value={props.params[s.key]} onChange={(v) => props.onChange(s.key, v)} />
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

/**
 * The graphic settings side panel (spec 19): generated from PARAM_SPECS, the main settings first, every other rendering
 * or interaction constant under « Avancés ». Changes apply at once; they are not in the history nor undoable. Its
 * « LaTeX » section (task 7) says LaTeX's state on this PC (`latex`), offers « Installer LaTeX » when it is absent or
 * its installation failed, and opens the preamble's full screen.
 */
export function SettingsPanel(props: {
  params: RenderParams; onChange(p: RenderParams): void; onClose(): void; latex: LatexStatus | null; onInstallLatex(): void; onEditPreamble(): void;
}) {
  const [advanced, setAdvanced] = useState(false);
  const set = (key: keyof RenderParams, v: Value) => props.onChange({ ...props.params, [key]: v });
  const state = props.latex?.state;
  return (
    <aside className="settings" aria-label="Paramètres graphiques">
      <header>
        <h2>Paramètres graphiques</h2>
        <button className="close" aria-label="Fermer le bandeau" onClick={props.onClose}>×</button>
      </header>
      <Section title="graphique" specs={PARAM_SPECS.filter((s) => s.section === 'graphique')} params={props.params} onChange={set} />
      <div className="param-group latex-setup">
        <h3>LaTeX</h3>
        <p className="latex-state">{latexStateText(props.latex)}</p>
        <div className="latex-actions">
          {(state === 'absent' || state === 'failed') && <button onClick={props.onInstallLatex}>Installer LaTeX</button>}
          <button onClick={props.onEditPreamble}>Modifier le préambule…</button>
        </div>
      </div>
      <button className="toggle" onClick={() => setAdvanced((a) => !a)}>{advanced ? '▾' : '▸'} Avancés</button>
      {advanced && <Section title="avancé" specs={PARAM_SPECS.filter((s) => s.section === 'avancé')} params={props.params} onChange={set} />}
      <button className="reset-all" onClick={() => props.onChange({ ...DEFAULT_PARAMS })}>Tout réinitialiser</button>
    </aside>
  );
}
