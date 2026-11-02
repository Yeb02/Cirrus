import { fromSnapshot, type Id, type Snapshot, type State } from '@cirrus/core';
import { DEFAULT_PARAMS, diffFromDefaults, type RenderParams, withOverrides } from '@cirrus/view';
import { useEffect, useRef, useState } from 'react';
import { GraphView } from './ui/GraphView.tsx';
import { SettingsPanel } from './ui/SettingsPanel.tsx';
import { Tabs } from './ui/Tabs.tsx';
import { type Toast, Toasts } from './ui/Toasts.tsx';
import { EditSession, type Result } from './session.ts';

const TABS_KEY = 'cirrus.tabs';

/** Open tabs are a per-PC convenience: kept in localStorage, which may be unavailable. */
function loadTabs(): Id[] {
  try {
    const v = JSON.parse(localStorage.getItem(TABS_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function saveTabs(tabs: Id[]): void {
  try { localStorage.setItem(TABS_KEY, JSON.stringify(tabs)); } catch { /* not kept */ }
}

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [params, setParams] = useState<RenderParams>(DEFAULT_PARAMS);
  const [tabs, setTabs] = useState<Id[]>([]);
  const [active, setActive] = useState<Id | null>(null);
  const [panel, setPanel] = useState(window.cirrus.launch.panel === true);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const readySent = useRef(false);
  /** The settings just read are not written back. */
  const loadedParams = useRef<RenderParams | null>(null);
  const session = useRef<EditSession | null>(null);
  const activeRef = useRef<Id | null>(null);
  activeRef.current = active;
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const toast = (text: string) => {
    const id = Math.random();
    setToasts((t) => [...t, { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), paramsRef.current.toastMs);
  };
  /** Reports a refused edit, or names the plan an undone step changed if it is not the one on screen (spec 6.4). */
  const report = (r: Result, verb?: string) => {
    if (!r.ok) { toast(r.message); return; }
    const elsewhere = r.plans.filter((p) => p !== activeRef.current);
    if (verb && elsewhere.length > 0 && !r.plans.includes(activeRef.current!)) {
      const names = elsewhere.map((p) => `« ${session.current!.state.plans.get(p)?.name ?? '?'} »`).join(', ');
      toast(`${verb} dans ${elsewhere.length > 1 ? 'les plans' : 'le plan'} ${names} : ${r.action.label}`);
    }
  };

  // Ctrl+Z / Ctrl+Y (and Ctrl+Maj+Z) for the whole app; inside a text field they belong to the text (spec 6.4).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (!session.current || !e.ctrlKey || (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)))) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); void session.current.undo().then((r) => report(r, 'Annulé')); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); void session.current.redo().then((r) => report(r, 'Rétabli')); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [snap, settings] = await Promise.all([window.cirrus.snapshot(), window.cirrus.getSettings()]);
        const s = fromSnapshot(JSON.parse(snap) as Snapshot);
        const plans = [...s.plans.values()];
        const lobby = plans.find((p) => p.type === 'lobby')!;
        let open = loadTabs().filter((id) => s.plans.has(id) && id !== lobby.id);
        let current = lobby.id;
        const wanted = window.cirrus.launch.plan && plans.find((p) => p.name === window.cirrus.launch.plan);
        if (wanted) {
          if (wanted.type !== 'lobby' && !open.includes(wanted.id)) open = [...open, wanted.id];
          current = wanted.id;
        }
        const p = withOverrides(settings);
        loadedParams.current = p;
        session.current = new EditSession(s, (a) => window.cirrus.commit(a), (next) => setState(next));
        setParams(p);
        setTabs(open);
        setActive(current);
        setState(s);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  useEffect(() => { if (state) saveTabs(tabs); }, [tabs, state]);

  // Settings are written a moment after the last change (spec 19: outside the history and undo).
  useEffect(() => {
    if (!state || params === loadedParams.current) return;
    const timer = setTimeout(() => { void window.cirrus.setSettings(diffFromDefaults(params)); }, params.settingsSaveDelayMs);
    return () => clearTimeout(timer);
  }, [params, state]);

  /** Captures wait for the first drawn frame. */
  const firstFrame = () => {
    if (readySent.current) return;
    readySent.current = true;
    // Visual checks: CIRRUS_CLICK=".gear" clicks those elements, CIRRUS_KEYS="ctrl+z,Delete" presses those keys.
    const clicks = (window.cirrus.launch.click ?? '').split(',').filter(Boolean);
    const keys = (window.cirrus.launch.keys ?? '').split(',').filter(Boolean);
    void (async () => {
      for (const sel of clicks) {
        document.querySelector<HTMLElement>(sel)?.click();
        await new Promise((r) => setTimeout(r, 300));
      }
      for (const combo of keys) {
        const parts = combo.split('+');
        const key = parts.pop()!;
        window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: parts.includes('ctrl'), shiftKey: parts.includes('shift'), altKey: parts.includes('alt') }));
        await new Promise((r) => setTimeout(r, 150));
      }
      window.cirrus.ready();
    })();
  };
  useEffect(() => { if (error) firstFrame(); }, [error]);

  if (error) return <div className="app"><div className="placeholder">Impossible d’ouvrir la base : {error}</div></div>;
  if (!state || !active) return <div className="app"><div className="placeholder">Ouverture de la base…</div></div>;
  return (
    <div className="app">
      <Tabs
        plans={[...state.plans.values()]}
        open={tabs}
        active={active}
        onSelect={setActive}
        onOpen={(id) => { setTabs((t) => [...t, id]); setActive(id); }}
        onClose={(id) => {
          setTabs((t) => t.filter((x) => x !== id));
          if (active === id) setActive([...state.plans.values()].find((p) => p.type === 'lobby')!.id);
        }}
        settingsOpen={panel}
        onSettings={() => setPanel((o) => !o)}
      />
      <div className="main">
        <GraphView
          state={state} plan={active} params={params} onFirstFrame={firstFrame} session={session.current} onResult={(r) => report(r)}
          // The lobby has its own tab, always there: only another plan is added to the open ones.
          onOpenPlan={(id) => { if (state.plans.get(id)?.type !== 'lobby') setTabs((t) => (t.includes(id) ? t : [...t, id])); setActive(id); }}
        />
        {panel && <SettingsPanel params={params} onChange={(p) => setParams(withOverrides(p))} onClose={() => setPanel(false)} />}
        <Toasts toasts={toasts} />
      </div>
    </div>
  );
}
