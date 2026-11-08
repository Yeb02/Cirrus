import { useEffect, useState } from 'react';
import type { SyncStatus } from '../../../main/sync/client.ts';
import type { FirstSyncOffer } from '../../../main/sync/firstSync.ts';
import type { FirstSyncChoice, PairResult, ServerInfo } from '../../../main/sync/host.ts';
import { chipOf } from '../../sync/syncSession.ts';

/** The address proposed: a server on this machine, at the port its command line takes by default (packages/server). */
export const DEFAULT_SERVER_URL = 'http://127.0.0.1:7310';

/** « n nœuds », « 1 nœud »: a count and its noun, in the singular below 2 (French). */
const count = (n: number, noun: string) => `${n} ${noun}${n > 1 ? 's' : ''}`;

/**
 * D7's offer (task 5): its button — the brief's words, with the counts —, and what it does while it runs. The others
 * cancel.
 */
export function offerAction(o: FirstSyncOffer): { choice: FirstSyncChoice; label: string; busy: string } {
  switch (o.kind) {
    case 'seed': return { choice: 'seed', label: `Envoyer la base de ce PC au serveur (${count(o.nodes, 'nœud')}, ${count(o.files, 'fichier')})`, busy: 'Envoi de la base…' };
    case 'adopt': return { choice: 'adopt', label: `Prendre la base du serveur (${count(o.nodes, 'nœud')})`, busy: 'Téléchargement de la base…' };
    case 'replace': return { choice: 'adopt', label: `Remplacer la base de ce PC par celle du serveur (${count(o.nodes, 'nœud')})`, busy: 'Téléchargement de la base…' };
  }
}

/**
 * The head of the rubric « Serveur » (plan 5a, D3): not paired, the server's address, the pairing code its `jumeler`
 * shows, this PC's name there, and « Jumeler »; a refusal said under them. The first pairing's question (D7), in its
 * place while the main process holds it (`info.offer`: the panel closed and opened again shows it still): why, then its
 * button and « Annuler ». Paired, the server, the synchronisation's state, and « Dissocier ce PC ». `refresh` reads what the
 * main process holds at each mounting (the panel opened, the rubric unfolded): a first sync under way then shows as
 * such; until it answers, nothing can be clicked (review of task 5, round 2).
 */
export function ServerBlock(props: {
  info: ServerInfo | null; status: SyncStatus; onPair(url: string, code: string, name: string): Promise<PairResult>; onFirst(choice: FirstSyncChoice): Promise<PairResult>;
  onUnpair(): Promise<void>; refresh?(): Promise<unknown>;
}) {
  const [url, setUrl] = useState(props.info?.url || DEFAULT_SERVER_URL);
  const [code, setCode] = useState('');
  const [name, setName] = useState(props.info?.name ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  // What the block was given may be stale (a first sync started since): read again at mounting, nothing clickable before.
  const [fresh, setFresh] = useState(!props.refresh);
  useEffect(() => {
    if (props.refresh) void props.refresh().catch(() => {}).finally(() => setFresh(true));
  }, []);
  const paired = props.info?.paired === true;
  // The proposals arrive with the information (the address by default, the machine's name), or after an unpairing; the
  // same values read again leave what is typed.
  const proposal = props.info && !props.info.paired ? props.info : null;
  useEffect(() => {
    if (!proposal) return;
    setUrl(proposal.url || DEFAULT_SERVER_URL);
    setName(proposal.name);
  }, [proposal?.url, proposal?.name]);
  const blocked = busy !== null || !fresh;
  const run = (label: string, job: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    void job().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(null));
  };
  /** A pairing's outcome: paired (the block turns with `info`), a restart under way, or why not; D7's question comes with `info`. */
  const outcome = (r: PairResult) => {
    if (r.ok) {
      setCode('');
      if (r.restarting) setRestarting(true);
    } else if (!r.offer) setError(r.message);
  };
  if (!props.info) return null;
  const offer = props.info.offer;
  // A base taken from the server that waits beside this one (its swap failed at the start): said above the rest.
  const waiting = !paired && props.info.waiting ? <p className="server-error">{props.info.waiting}</p> : null;
  if (restarting) {
    return (
      <div className="param-group server-block">
        <p className="server-state">Base du serveur prise : Cirrus redémarre sur elle.</p>
      </div>
    );
  }
  if (paired) {
    const state = chipOf(props.status, false)?.text ?? 'Synchronisation arrêtée';
    // The address is not drawn in a capture (`volatile`): its port, a free one, changes from one run to the next (task 7).
    return (
      <div className="param-group server-block">
        <p className="server-state">Jumelé à <span className="server-url volatile">{props.info.url}</span>, sous le nom « {props.info.name} ».</p>
        <p className="server-state">État : {state}</p>
        <div className="server-actions">
          <button disabled={blocked} onClick={() => run('', props.onUnpair)}>Dissocier ce PC</button>
        </div>
      </div>
    );
  }
  // A first sync under way (the panel opened again meanwhile): what it does, nothing to click (review, Minor 3).
  if (props.info.busy) {
    return (
      <div className="param-group server-block">
        {waiting}
        <p className="server-state">{props.info.busy}</p>
      </div>
    );
  }
  if (offer) {
    const action = offerAction(offer.offer);
    const kept = offer.offer.kind === 'seed' ? null : offer.offer.archive;
    return (
      <div className="param-group server-block server-offer">
        {waiting}
        <p className="server-state">{offer.message}</p>
        {kept && <p className="server-state">Elle sera gardée sous « {kept} », à côté de la base.</p>}
        <div className="server-actions">
          <button disabled={blocked} onClick={() => run(action.busy, async () => outcome(await props.onFirst(action.choice)))}>{busy || action.label}</button>
          <button disabled={blocked} onClick={() => run('', async () => outcome(await props.onFirst('cancel')))}>Annuler</button>
        </div>
      </div>
    );
  }
  const submit = () => run('Jumelage…', async () => outcome(await props.onPair(url, code, name)));
  return (
    <form className="param-group server-block" onSubmit={(e) => { e.preventDefault(); if (!blocked) submit(); }}>
      {waiting}
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
        <button type="submit" disabled={blocked}>{busy ?? 'Jumeler'}</button>
      </div>
      {error && <p className="server-error">{error}</p>}
    </form>
  );
}
