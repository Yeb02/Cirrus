import { useEffect, useState } from 'react';
import type { SyncStatus } from '../../../main/sync/client.ts';
import type { PairResult, ServerInfo } from '../../../main/sync/host.ts';
import { chipOf } from '../../sync/syncSession.ts';

/** The address proposed: a server on this machine, at the port its command line takes by default (packages/server). */
export const DEFAULT_SERVER_URL = 'http://127.0.0.1:7310';

/**
 * The head of the rubric « Serveur » (plan 5a, D3): not paired, the server's address, the pairing code its `jumeler`
 * shows, this PC's name there, and « Jumeler »; a refusal said under them. Paired, the server, the synchronisation's
 * state, and « Dissocier ce PC ».
 */
export function ServerBlock(props: {
  info: ServerInfo | null; status: SyncStatus; onPair(url: string, code: string, name: string): Promise<PairResult>; onUnpair(): Promise<void>;
}) {
  const [url, setUrl] = useState(props.info?.url || DEFAULT_SERVER_URL);
  const [code, setCode] = useState('');
  const [name, setName] = useState(props.info?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paired = props.info?.paired === true;
  // The proposals arrive with the information (the address by default, the machine's name), or after an unpairing.
  useEffect(() => {
    if (!props.info || props.info.paired) return;
    setUrl(props.info.url || DEFAULT_SERVER_URL);
    setName(props.info.name);
  }, [props.info]);
  const run = (job: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    void job().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false));
  };
  if (!props.info) return null;
  if (paired) {
    const state = chipOf(props.status, false)?.text ?? 'Synchronisation arrêtée';
    return (
      <div className="param-group server-block">
        <p className="server-state">Jumelé à <span className="server-url">{props.info.url}</span>, sous le nom « {props.info.name} ».</p>
        <p className="server-state">État : {state}</p>
        <div className="server-actions">
          <button disabled={busy} onClick={() => run(props.onUnpair)}>Dissocier ce PC</button>
        </div>
      </div>
    );
  }
  const submit = () => run(async () => {
    const r = await props.onPair(url, code, name);
    if (!r.ok) setError(r.message);
    else setCode('');
  });
  return (
    <form className="param-group server-block" onSubmit={(e) => { e.preventDefault(); if (!busy) submit(); }}>
      <label className="param">
        <span className="label">Adresse du serveur</span>
        <input type="text" className="list" value={url} spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <label className="param">
        <span className="label">Code de jumelage</span>
        <input type="text" className="list" value={code} spellCheck={false} autoComplete="off" placeholder="ABCD-EFGH-JKMN-PQRS" onChange={(e) => setCode(e.target.value)} />
      </label>
      <label className="param">
        <span className="label">Nom de ce PC</span>
        <input type="text" className="list" value={name} spellCheck={false} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="server-actions">
        <button type="submit" disabled={busy}>{busy ? 'Jumelage…' : 'Jumeler'}</button>
      </div>
      {error && <p className="server-error">{error}</p>}
    </form>
  );
}
