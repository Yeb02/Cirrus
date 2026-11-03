import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { ATLAS_URL, fetchFile, FONT_URL, loadFont } from '../src/renderer/render/font.ts';

const FNT = readFileSync(fileURLToPath(new URL('../src/renderer/public/font/inter-msdf.fnt', import.meta.url)), 'utf8');
const ATLAS = {} as ImageBitmap;

/** A fetch serving these files; any other is a 404. */
const serve = (files: Record<string, string | Blob | Error>) => async (url: string) => {
  const f = files[url];
  if (f instanceof Error) throw f;
  if (f === undefined) return new Response('', { status: 404 });
  return new Response(f, { status: 200 });
};

test('fetchFile rejette une réponse en échec par un message qui nomme le fichier', async () => {
  await expect(fetchFile(serve({}), 'font/absent.fnt')).rejects.toThrow('font/absent.fnt introuvable (statut 404)');
  await expect(fetchFile(serve({ 'x.png': new TypeError('Failed to fetch') }), 'x.png')).rejects.toThrow('x.png inaccessible : Failed to fetch');
  const r = await fetchFile(serve({ 'a.txt': 'contenu' }), 'a.txt');
  expect(await r.text()).toBe('contenu');
});

test('loadFont : la police et son atlas, ou un échec qui nomme le fichier en cause', async () => {
  const decoded: Blob[] = [];
  const decode = async (b: Blob) => { decoded.push(b); return ATLAS; };
  const ok = await loadFont(serve({ [FONT_URL]: FNT, [ATLAS_URL]: new Blob(['png']) }), decode);
  expect(ok.font.chars).toHaveLength(401);
  expect(ok.atlas).toBe(ATLAS);
  expect(await decoded[0].text()).toBe('png');
  // A missing atlas, a page served in place of the descriptor (a development server's fallback), an image that does
  // not decode: each names its file.
  await expect(loadFont(serve({ [FONT_URL]: FNT }), decode)).rejects.toThrow(`${ATLAS_URL} introuvable`);
  await expect(loadFont(serve({ [FONT_URL]: '<!doctype html><html></html>', [ATLAS_URL]: new Blob(['png']) }), decode))
    .rejects.toThrow(`Police ${FONT_URL} illisible`);
  const broken = async () => { throw new Error('The source image could not be decoded.'); };
  await expect(loadFont(serve({ [FONT_URL]: FNT, [ATLAS_URL]: new Blob(['html']) }), broken))
    .rejects.toThrow(`Atlas ${ATLAS_URL} illisible : The source image could not be decoded.`);
});
