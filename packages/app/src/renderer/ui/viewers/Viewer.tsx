import type { Id } from '@cirrus/core';
import { lazy, Suspense } from 'react';
import { loading } from '../../files/read.ts';
import { Message, type ViewProps } from './common.tsx';
import { ImageViewer } from './ImageViewer.tsx';
import { TableViewer } from './TableViewer.tsx';
import { viewOf } from './views.ts';

/**
 * The text view, with CodeMirror, in its own chunk: loaded the first time a text is shown, so that the app's start does
 * not read it (performance); like every chunk of the app, it is served by the app, never fetched from the network.
 */
const TextViewer = lazy(() => loading(import('./TextViewer.tsx')).then((m) => ({ default: m.TextViewer })));

/**
 * A file's view (plan 4a, task 5), the same in a preview (`mode` « preview », a floating panel) and in full screen
 * (« full », which gives it the focus): chosen by the file's kind (viewOf) — an image, text and code (LaTeX source
 * included), a table; the PDF's view comes with task 6 (its branch here). `node`: the node the file is shown for, as the
 * plan's interface gives it; no view reads it yet. Its parent keys it by the file's hash, so that a new version of the
 * file is a new view.
 */
export function Viewer(props: ViewProps & { node: Id }) {
  const view: ViewProps = { file: props.file, params: props.params, views: props.views, mode: props.mode };
  const choice = viewOf(props.file.name);
  switch (choice?.view) {
    case 'image': return <ImageViewer {...view} />;
    case 'table': return <TableViewer {...view} />;
    case 'text': return <Suspense fallback={<Message text="Lecture…" />}><TextViewer {...view} wrap={choice.wrap} /></Suspense>;
    case 'pdf': return <Message text="Aperçu du PDF : à venir" />;
    case undefined: return <Message text="Cirrus n’a pas de vue pour ce genre de fichier." />;
  }
}
