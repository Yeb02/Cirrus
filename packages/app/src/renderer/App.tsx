import { fromSnapshot, type Id, type State } from '@cirrus/core';
import { DEFAULT_PARAMS, type RenderParams, withOverrides } from '@cirrus/view';
import { useEffect, useRef, useState } from 'react';
import { GraphView } from './ui/GraphView.tsx';
import { Tabs } from './ui/Tabs.tsx';

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
  const [error, setError] = useState<string | null>(null);
  const readySent = useRef(false);

  useEffect(() => {
    void (async () => {
      try {
        const [snap, settings] = await Promise.all([window.cirrus.snapshot(), window.cirrus.getSettings()]);
        const s = fromSnapshot(snap);
        const plans = [...s.plans.values()];
        const lobby = plans.find((p) => p.type === 'lobby')!;
        let open = loadTabs().filter((id) => s.plans.has(id) && id !== lobby.id);
        let current = lobby.id;
        const wanted = window.cirrus.launch.plan && plans.find((p) => p.name === window.cirrus.launch.plan);
        if (wanted) {
          if (wanted.type !== 'lobby' && !open.includes(wanted.id)) open = [...open, wanted.id];
          current = wanted.id;
        }
        setParams(withOverrides(settings));
        setTabs(open);
        setActive(current);
        setState(s);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  useEffect(() => { if (state) saveTabs(tabs); }, [tabs, state]);

  /** Captures wait for the first drawn frame. */
  const firstFrame = () => {
    if (readySent.current) return;
    readySent.current = true;
    window.cirrus.ready();
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
      />
      <div className="main">
        <GraphView state={state} plan={active} params={params} onFirstFrame={firstFrame} />
      </div>
    </div>
  );
}
