import type { FileRef } from '@cirrus/core';
import type { RenderParams } from '@cirrus/view';
import { useEffect, useRef, useState } from 'react';
import { MAX_IDENTIFIER_CHARS } from '../../main/publications/identifier.ts';
import { fileKind } from '../files/kind.ts';
import { carriesFiles, droppedPaths, refusalNotice } from '../files/nodeFiles.ts';
import { createFromPdf, type ImportDeps, importByIdentifier, type ImportOutcome } from '../publications/build.ts';
import { findIdentifier } from '../publications/identify.ts';

const stop = (e: React.SyntheticEvent) => e.stopPropagation();
type Tone = 'hint' | 'busy' | 'error' | 'found';
const HINT = 'Un DOI, un identifiant arXiv ou un lien vers l’un d’eux ; ou dépose le PDF ici.';
const UNEXPECTED = 'L’import de la publication a échoué : erreur inattendue.';

/**
 * « Importer une publication… » (plan 4c, D5 to D8), from the graph background's menu: a field for a DOI, an arXiv
 * identifier or a link, « Importer », what is under way or why it failed, and a drop zone for a PDF — the whole dialog.
 * It blocks nothing: the graph stays usable, and « Fermer » or Escape closes it at any time, a result still to come
 * then dropped. Only « Importer » reaches the network (the user's explicit request). A PDF dropped goes into the store
 * as a dropped file does, then its metadata and first pages are read (pdf.js): an identifier found fills the field, and
 * « Importer » keeps this PDF (arXiv's is not downloaded again); none found, « Créer le nœud » makes the node of its
 * title (its metadata's, or its file's name), the PDF attached, which the user completes.
 */
export function PublicationDialog(props: {
  params: RenderParams;
  deps: Omit<ImportDeps, 'open'>;
  /** A notification: a duplicate, a refusal, a publication imported without its PDF. */
  onNotify(message: string): void;
  onClose(): void;
}) {
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [text, setText] = useState('');
  const [status, setStatus] = useState<{ text: string; tone: Tone }>({ text: HINT, tone: 'hint' });
  const [busy, setBusyState] = useState(false);
  /** What runs, at once (two quick presses import once); `busy`, what the buttons show. */
  const running = useRef(false);
  const setBusy = (on: boolean) => { running.current = on; setBusyState(on); };
  const [pdf, setPdf] = useState<{ ref: FileRef; title: string; found: boolean } | null>(null);
  const [over, setOver] = useState(false);
  const deps: ImportDeps = { ...props.deps, open: () => alive.current };
  const say = (t: string, tone: Tone) => setStatus({ text: t, tone });

  const outcome = (o: ImportOutcome) => {
    if (o.kind === 'dropped' || !alive.current) return;
    setBusy(false);
    if (o.kind === 'failed') { say(o.message, 'error'); return; }
    if (o.kind === 'notified') props.onNotify(o.message);
    else if (o.notice) props.onNotify(o.notice);
    props.onClose();
  };
  const failed = (e: unknown) => {
    console.error('Import de la publication :', e);
    outcome({ kind: 'failed', message: UNEXPECTED });
  };
  const submit = () => {
    if (running.current || text.trim() === '') return;
    setBusy(true);
    say('Recherche…', 'busy');
    void importByIdentifier(text, pdf?.ref ?? null, deps).then(outcome, failed);
  };
  const create = () => {
    if (running.current || !pdf) return;
    setBusy(true);
    void createFromPdf(pdf.ref, pdf.title, deps).then(outcome, failed);
  };

  /** A PDF dropped (D8): into the store, then read for its identifier; the field filled, or « Créer le nœud » offered. */
  const dropPdf = async (files: FileList) => {
    const d = droppedPaths(files, (f) => window.cirrus.pathForFile(f));
    if (d.paths.length + d.refused.length !== 1) { say('Dépose un seul PDF à la fois.', 'error'); return; }
    if (d.refused.length > 0) { say(refusalNotice(d.refused)!, 'error'); return; }
    const path = d.paths[0], name = path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1);
    if (fileKind(name) !== 'pdf') { say(`« ${name} » n’est pas un PDF.`, 'error'); return; }
    setBusy(true);
    say(`Lecture de « ${name} »…`, 'busy');
    let ref: FileRef;
    try {
      const r = await window.cirrus.importFiles([path]);
      if (!alive.current) return;
      if (r.refs.length === 0) {
        setBusy(false);
        say(refusalNotice(r.refused) ?? `« ${name} » n’a pas pu être importé.`, 'error');
        return;
      }
      ref = r.refs[0];
    } catch (e) {
      console.error(`Import de « ${name} » :`, e);
      if (alive.current) { setBusy(false); say(`« ${name} » n’a pas pu être importé.`, 'error'); }
      return;
    }
    const fallback = name.replace(/\.pdf$/i, '');
    let found: ReturnType<typeof findIdentifier> = null, title = fallback, unreadable = '';
    // pdf.js in its own chunk, loaded at the first PDF dropped, as the views load it.
    const pdfjs = import('../publications/pdfClues.ts');
    try {
      const clues = await (await pdfjs).readPdfClues(ref, props.params.publicationPdfPages, props.params.pdfDocsKept);
      found = findIdentifier(clues.text, clues.meta);
      title = clues.title ?? fallback;
    } catch (e) {
      unreadable = await pdfjs.then((m) => `${m.pdfFailure(name, e)} `, () => `« ${name} » n’a pas pu être lu. `);
    }
    if (!alive.current) return;
    setBusy(false);
    setPdf({ ref, title, found: found !== null });
    if (found === null) {
      // The identifier an earlier PDF filled in is not this one's.
      if (pdf?.found) setText('');
      say(`${unreadable}Aucun DOI ni identifiant arXiv dans ce PDF : « Créer le nœud » le crée sous le titre « ${title} », le PDF attaché ; ou saisis son identifiant.`, 'hint');
      return;
    }
    setText('doi' in found ? found.doi : `arXiv:${found.arxiv}`);
    say(`${'doi' in found ? `DOI trouvé dans le PDF : ${found.doi}` : `Identifiant arXiv trouvé dans le PDF : ${found.arxiv}`}. « Importer » demande ses métadonnées ; le nœud gardera ce PDF.`, 'found');
  };

  return (
    <div
      className={over ? 'publication-dialog over' : 'publication-dialog'} role="dialog" aria-label="Importer une publication"
      onPointerDown={stop} onPointerMove={stop} onPointerUp={stop} onContextMenu={stop}
      // Its keys are its own: the graph's (arrows, Suppr, Escape) and the panels' never see them.
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); props.onClose(); }
      }}
      // The whole dialog takes a PDF (the graph refuses files over it: dropZone).
      onDragOver={(e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = busy ? 'none' : 'copy';
        setOver(true);
      }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }}
      onDrop={(e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        if (!running.current) void dropPdf(e.dataTransfer.files);
      }}
    >
      <h3>Importer une publication</h3>
      <div className="identifier">
        <input
          autoFocus value={text} maxLength={MAX_IDENTIFIER_CHARS} spellCheck={false} placeholder="10.1007/978-0-387-49820-1, arXiv:1706.03762…"
          aria-label="DOI, identifiant arXiv ou lien" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
        />
        <button className="import" disabled={busy || text.trim() === ''} onClick={submit}>Importer</button>
      </div>
      {pdf && <p className="pdf">PDF : {pdf.ref.name}</p>}
      <p className={`status ${status.tone}`} role="status">{status.text}</p>
      <div className="choices">
        {pdf && !pdf.found && <button className="create" disabled={busy} onClick={create}>Créer le nœud</button>}
        <button className="cancel" onClick={props.onClose}>Fermer</button>
      </div>
    </div>
  );
}
