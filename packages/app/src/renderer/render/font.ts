import { type FontData, parseBmFont } from '@cirrus/view';

/** The MSDF font built by scripts/build-font.mjs from Inter (Latin, Greek, the symbols titles use): descriptor and atlas. */
export const FONT_URL = 'font/inter-msdf.fnt';
export const ATLAS_URL = 'font/inter-msdf.png';

type Fetch = (url: string) => Promise<Response>;
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One of the app's own files: a request that fails, or a response that is not ok, rejects with a message naming it. */
export async function fetchFile(fetchFn: Fetch, url: string): Promise<Response> {
  let r: Response;
  try {
    r = await fetchFn(url);
  } catch (e) {
    throw new Error(`Fichier ${url} inaccessible : ${reason(e)}`);
  }
  if (!r.ok) throw new Error(`Fichier ${url} introuvable (statut ${r.status}).`);
  return r;
}

/**
 * The titles' font and its atlas, read before the first scene (its boxes are measured with the font). Every failure
 * names its file: absent, not a BMFont descriptor (a development server's fallback page), an image that does not decode.
 */
export async function loadFont(fetchFn: Fetch, decode: (blob: Blob) => Promise<ImageBitmap>): Promise<{ font: FontData; atlas: ImageBitmap }> {
  const [xml, blob] = await Promise.all([fetchFile(fetchFn, FONT_URL).then((r) => r.text()), fetchFile(fetchFn, ATLAS_URL).then((r) => r.blob())]);
  let font: FontData;
  try {
    font = parseBmFont(xml);
  } catch (e) {
    throw new Error(`Police ${FONT_URL} illisible : ${reason(e)}`);
  }
  try {
    return { font, atlas: await decode(blob) };
  } catch (e) {
    throw new Error(`Atlas ${ATLAS_URL} illisible : ${reason(e)}`);
  }
}
