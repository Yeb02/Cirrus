import type { FileRef } from '@cirrus/core';
import { MAX_IDENTIFIER_CHARS } from '@cirrus/sources/identifier';
import type { RenderParams } from '@cirrus/view';
import { useEffect, useRef, useState } from 'react';
import { carriesFiles, droppedPaths, pathName, refusalNotice } from '../files/nodeFiles.ts';
import {
  choosePdf, createFromPdf, type ImportDeps, importByIdentifier, type ImportOutcome, type PdfDeps, type PdfTaken, readPdf, takePdfPath,
} from '../publications/build.ts';

const stop = (e: React.SyntheticEvent) => e.stopPropagation();
type Tone = 'hint' | 'busy' | 'error' | 'found';
const HINT = 'Un DOI, un identifiant arXiv ou l’adresse d’un article ; ou dépose un PDF ici.';
const UNEXPECTED = 'L’import de la publication a échoué : erreur inattendue.';
const reading = (name: string) => `Lecture de « ${name} »…`;
/** pdf.js in its own chunk, loaded at the first PDF taken, as the views load it. */
const pdfjs = () => import('../publications/pdfClues.ts');

/**
 * « Importer une publication… » (plan 4c, D5 to D8), from the graph background's menu: a field for a DOI, an arXiv
 * identifier or the address of an article (plan 5b, D3), « Importer », what is under way or why it failed, and a PDF to
 * give — dropped on the dialog, chosen by « Choisir un PDF… », or dropped on the graph's background, which opens the
 * dialog with it (`initialPdf`, plan 5b, D5). It blocks nothing: the graph stays usable, and « Fermer » or Escape closes
 * it at any time, a result still to come then dropped. Only « Importer » reaches the network (the user's explicit
 * request). A PDF given goes into the store as a dropped file does, then its metadata and first pages are read (pdf.js):
 * an identifier found fills the field, and « Importer » keeps this PDF (arXiv's is not downloaded again); none found,
 * « Créer le nœud » makes the node of its title (its metadata's, or its file's name), the PDF attached, which the user
 * completes. An address that leads to a PDF without identifier gives one the same way (D3: readPdf).
 */
export function PublicationDialog(props: {
  params: RenderParams;
  deps: Omit<ImportDeps, 'open'>;
  /** A notification: a duplicate, a refusal, a publication imported without its PDF. */
  onNotify(message: string): void;
  onClose(): void;
  /** The path of a PDF dropped on the graph's background, taken at once as one dropped on the dialog (plan 5b, D5). */
  initialPdf?: string;
}) {
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [text, setText] = useState('');
  const [status, setStatus] = useState<{ text: string; tone: Tone }>(() => (props.initialPdf === undefined
    ? { text: HINT, tone: 'hint' }
    : { text: reading(pathName(props.initialPdf)), tone: 'busy' }));
  // Opened with a PDF to take: busy from the first render, so that nothing shows the dialog idle meanwhile.
  const [busy, setBusyState] = useState(props.initialPdf !== undefined);
  /** What runs, at once (two quick presses import once); `busy`, what the buttons show. */
  const running = useRef(false);
  const setBusy = (on: boolean) => { running.current = on; setBusyState(on); };
  const [pdf, setPdf] = useState<{ ref: FileRef; title: string; found: boolean } | null>(null);
  const [over, setOver] = useState(false);
  const deps: ImportDeps = { ...props.deps, open: () => alive.current };
  const say = (t: string, tone: Tone) => setStatus({ text: t, tone });
  /** What taking a PDF asks of the system: the store, and pdf.js (PdfDeps). */
  const pdfDeps: PdfDeps = {
    importFiles: (paths) => window.cirrus.importFiles(paths),
    readClues: async (ref) => (await pdfjs()).readPdfClues(ref, props.params.publicationPdfPages, props.params.pdfDocsKept),
    unreadable: (name, e) => pdfjs().then((m) => m.pdfFailure(name, e), () => `« ${name} » n’a pas pu être lu.`),
    open: () => alive.current,
    log: (what, e) => console.error(what, e),
  };

  const outcome = (o: ImportOutcome) => {
    if (o.kind === 'dropped' || !alive.current) return;
    // An address that led to a PDF without identifier (plan 5b, D3): read as a PDF dropped on the dialog, busy still.
    if (o.kind === 'pdf') {
      say(reading(o.pdf.name), 'busy');
      void readPdf(o.pdf, pdfDeps).then(shown, failed);
      return;
    }
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

  /** A PDF read (D8): the field filled with its identifier, or « Créer le nœud » offered. */
  const shown = (t: PdfTaken) => {
    if (t.kind === 'dropped' || !alive.current) return;
    setBusy(false);
    if (t.kind === 'failed') { say(t.message, 'error'); return; }
    const { found, title } = t;
    setPdf({ ref: t.ref, title, found: found !== null });
    if (found === null) {
      // The identifier an earlier PDF filled in is not this one's.
      if (pdf?.found) setText('');
      say(`${t.unreadable}Aucun DOI ni identifiant arXiv dans ce PDF : « Créer le nœud » le crée sous le titre « ${title} », le PDF attaché ; ou saisis son identifiant.`, 'hint');
      return;
    }
    setText('doi' in found ? found.doi : `arXiv:${found.arxiv}`);
    say(`${'doi' in found ? `DOI trouvé dans le PDF : ${found.doi}` : `Identifiant arXiv trouvé dans le PDF : ${found.arxiv}`}. « Importer » demande ses métadonnées ; le nœud gardera ce PDF.`, 'found');
  };
  /** Reading the PDF at `path` begins: the dialog waits, and says so; pdf.js's chunk is asked for meanwhile. */
  const begin = (path: string) => {
    setBusy(true);
    say(reading(pathName(path)), 'busy');
    void pdfjs().catch(() => undefined);
  };
  /** A PDF dropped on the dialog (D8), or on the graph's background (plan 5b, D5): into the store, then read. */
  const take = (path: string) => {
    begin(path);
    void takePdfPath(path, pdfDeps).then(shown, failed);
  };
  const dropFiles = (files: FileList) => {
    const d = droppedPaths(files, (f) => window.cirrus.pathForFile(f));
    if (d.paths.length + d.refused.length !== 1) { say('Dépose un seul PDF à la fois.', 'error'); return; }
    if (d.refused.length > 0) { say(refusalNotice(d.refused)!, 'error'); return; }
    take(d.paths[0]);
  };
  /** « Choisir un PDF… » (plan 5b, D5): the system's dialog, the PDF chosen taken as one dropped; cancelled, nothing is done. */
  const choose = () => {
    if (running.current) return;
    void choosePdf(() => window.cirrus.pickPdf(), pdfDeps, begin).then((t) => { if (t !== null) shown(t); }, failed);
  };
  // Opened by a PDF dropped on the graph's background: taken as soon as the dialog is there.
  useEffect(() => { if (props.initialPdf !== undefined) take(props.initialPdf); }, []);

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
        if (!running.current) dropFiles(e.dataTransfer.files);
      }}
    >
      <h3>Importer une publication</h3>
      <div className="identifier">
        <input
          autoFocus value={text} maxLength={MAX_IDENTIFIER_CHARS} spellCheck={false} placeholder="DOI, identifiant arXiv ou adresse d’un article"
          aria-label="DOI, identifiant arXiv ou adresse d’un article" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
        />
        <button className="import" disabled={busy || text.trim() === ''} onClick={submit}>Importer</button>
      </div>
      {pdf && <p className="pdf">PDF : {pdf.ref.name}</p>}
      <p className={`status ${status.tone}`} role="status">{status.text}</p>
      <div className="choices">
        <button className="pick" disabled={busy} onClick={choose}>Choisir un PDF…</button>
        {pdf && !pdf.found && <button className="create" disabled={busy} onClick={create}>Créer le nœud</button>}
        <button className="cancel" onClick={props.onClose}>Fermer</button>
      </div>
    </div>
  );
}
