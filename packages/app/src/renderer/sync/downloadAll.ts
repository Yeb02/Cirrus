import type { FileRef, State } from '@cirrus/core';
import type { DownloadAllPlan, DownloadAllProgress, DownloadAllStart, ServerStatus } from '../../main/sync/protocol.ts';
import { fileKind, formatSize } from '../files/kind.ts';
import { sameName } from '../files/merge.ts';

// « Tout télécharger » and the server's state in the interface (plan 5b, D8): the PDFs the base refers to, counted here
// — the main process downloads those this PC lacks —, and the texts of the block « Serveur ». Without the DOM.

const isPdf = (name: string) => fileKind(name) === 'pdf';

/**
 * The PDFs the base refers to now (D8): those in the folders of the nodes outside the trash, and the versions the
 * anchors of the live annotations are on — one re-imported since keeps its own —, each hash once; never a version only
 * the history keeps, nor the anchor of an annotation whose PDF node is in the trash or absent (task 8a: no more than
 * that node's PDF). An anchor's version that no folder holds any more has no size of its own: it counts as much as the
 * file under its name in its PDF's node (the version that replaced it), 0 without one — an estimate, for the plan's
 * volume only: the main process checks each file by its hash, its length by the server's answer.
 */
export function referencedPdfs(s: State): FileRef[] {
  const out = new Map<string, FileRef>();
  for (const n of s.nodes.values()) {
    if (n.trashedAt !== undefined) continue;
    for (const f of n.files) if (isPdf(f.name) && !out.has(f.hash)) out.set(f.hash, f);
  }
  for (const n of s.nodes.values()) {
    const a = n.anchor;
    if (a === undefined || n.trashedAt !== undefined || out.has(a.hash)) continue;
    const pdf = s.nodes.get(a.pdf);
    if (pdf === undefined || pdf.trashedAt !== undefined) continue;
    const named = pdf.files.find((f) => sameName(f.name, a.file));
    out.set(a.hash, { name: a.file, hash: a.hash, size: named?.size ?? 0 });
  }
  return [...out.values()];
}

/** A size the French way (formatSize), a non-breaking space before its unit: « 1,2 Go », « 340 Mo ». */
export const sizeText = (bytes: number): string => formatSize(Math.round(bytes)).replace(' ', ' ');

/** The bytes downloadAllReserveMb keeps free (Mo: mebibytes, as formatSize counts them). */
const reserveBytes = (mb: number) => Math.max(0, mb) * 2 ** 20;

/**
 * The question of « Télécharger tous les PDF… » (D8), `ok` when it may start: the PDFs missing here and their volume,
 * and the free space of this disk; refused when they would leave less than `reserveMb` (downloadAllReserveMb) free —
 * the main process refuses it too (SyncClient.downloadAllStart). Refused by the reserve only (the disk holds them), the
 * refusal says the reserve and where it is set (task 8a): « libres » alone would read as room enough.
 */
export function planText(p: DownloadAllPlan, reserveMb: number): { ok: boolean; text: string } {
  if (p.count === 0) return { ok: false, text: 'Tous les PDF de la base sont déjà sur ce PC.' };
  const reserve = reserveBytes(reserveMb);
  if (p.bytes > p.freeBytes - reserve) {
    const short = `Pas assez de place : ${sizeText(p.bytes)} à télécharger, ${sizeText(p.freeBytes)} libres`;
    if (p.bytes > p.freeBytes) return { ok: false, text: `${short}.` };
    return { ok: false, text: `${short} dont ${sizeText(reserve)} gardés en réserve (Réglages › Serveur › Synchronisation).` };
  }
  return { ok: true, text: `${p.count} PDF à télécharger, ${sizeText(p.bytes)} ; ${sizeText(p.freeBytes)} libres sur ce disque.` };
}

/** Why a start was refused, in French; null for one under way already (its progress says it). */
export function startRefusal(r: DownloadAllStart, reserveMb: number): string | null {
  if (r.ok) return null;
  if ('plan' in r) return planText(r.plan, reserveMb).text;
  return r.reason === 'offline' ? 'Pas de connexion au serveur : les PDF ne peuvent pas être téléchargés maintenant.' : null;
}

/** Where « Tout télécharger » is (« 12 PDF sur 37, 340 Mo sur 1,2 Go »), or how it ended. */
export function progressText(p: DownloadAllProgress): string {
  const at = `${p.done} PDF sur ${p.total}`, s = p.done > 1 ? 's' : '';
  switch (p.end) {
    case undefined: return `${at}, ${sizeText(p.doneBytes)} sur ${sizeText(p.totalBytes)}`;
    case 'done':
      if (p.failed === 0) return `${p.done} PDF téléchargé${s}.`;
      return `${at} téléchargé${s} ; ${p.failed} ${p.failed > 1 ? 'n’ont pas pu l’être (absents du serveur, ou abîmés)' : 'n’a pas pu l’être (absent du serveur, ou abîmé)'}.`;
    case 'stopped': return `Téléchargement arrêté : ${at}.`;
    case 'lost': return `Serveur perdu : téléchargement arrêté à ${at}.`;
    case 'disk': return `PDF non enregistré sur ce PC : le disque est plein, ou Windows y refuse l’écriture. Téléchargement arrêté à ${at}.`;
    case 'interrupted': return `Téléchargement interrompu à ${at}.`;
  }
}

/**
 * The server's state asked while the block « Serveur » shows a server paired (D8; review of task 7: out of the block, to
 * be tested): at once, then `pollMs()` (serverStatusPollMs, read at each turn) after each answer — one chain of
 * timers, never two asks piled up behind a slow server —, each answer told (`tell`), a failure as unknown (null). The
 * function returned stops it (the block unmounted): an answer still to come is not told, nothing more is asked.
 * `timers`: the real ones, or a test's.
 */
export function pollServerState(
  ask: () => Promise<ServerStatus>, pollMs: () => number, tell: (s: ServerStatus | null) => void,
  timers: { set(cb: () => void, ms: number): unknown; clear(timer: unknown): void } = {
    set: (cb, ms) => setTimeout(cb, ms), clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  },
): () => void {
  let live = true, timer: unknown = null;
  const poll = () => {
    timer = null;
    void ask().catch(() => null).then((s) => {
      if (!live) return;
      tell(s);
      timer = timers.set(poll, pollMs());
    });
  };
  poll();
  return () => {
    live = false;
    if (timer !== null) timers.clear(timer);
  };
}

const NONE = '—';

/** A latency: to a tenth under 10 ms (a server of this machine answers in less than one), whole beyond. */
const msText = (ms: number) => (ms < 10 ? `${ms.toFixed(1).replace('.', ',')} ms` : `${Math.round(ms)} ms`);

/**
 * The server's state, line by line under the synchronisation's (D8): each label and its value, « — » until it is known
 * — not connected, no answer yet, no transfer of throughputMinMb yet.
 */
export function statusLines(st: ServerStatus | null): [string, string][] {
  const s = st?.server ?? null;
  const files = s && `${s.storeFiles.toLocaleString('fr-FR')} fichier${s.storeFiles > 1 ? 's' : ''}, ${sizeText(s.storeBytes)}${s.counting ? ' (décompte en cours)' : ''}`;
  return [
    ['Latence', st?.latencyMs != null ? msText(st.latencyMs) : NONE],
    ['Débit', st?.throughput != null ? `${sizeText(st.throughput)}/s` : NONE],
    ['Base du serveur', s ? sizeText(s.baseBytes) : NONE],
    ['Magasin du serveur', files || NONE],
    ['Espace libre du serveur', s ? sizeText(s.freeBytes) : NONE],
  ];
}
