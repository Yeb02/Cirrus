import type { Chip } from '../sync/syncSession.ts';

/**
 * The synchronisation's chip in the tabs' bar (plan 5a, D8): « À jour », « Envoi de n actions… », « Hors ligne »,
 * « Serveur : <raison> »; a click tries again when it says so (its tooltip: « Réessayer »).
 */
export function SyncChip(props: { chip: Chip; onRetry(): void }) {
  const { chip } = props;
  return chip.retry
    ? <button className={`sync-chip ${chip.tone}`} title={chip.title} onClick={props.onRetry}>{chip.text}</button>
    : <span className={`sync-chip ${chip.tone}`} title={chip.title}>{chip.text}</span>;
}
