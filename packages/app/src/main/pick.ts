/**
 * The file a test names instead of the system's dialog (CIRRUS_BIB_PICK, CIRRUS_PDF_PICK): `env[variable]`, taken only
 * on a test base in a window out of the user's way — with CIRRUS_DATA, and in capture mode or with CIRRUS_BACKGROUND=1
 * (scripts/interface.mjs, the captures), as CIRRUS_PUBLICATIONS_REPLAY (replayDirOf). Never on the user's own base, where
 * a variable left in the environment would otherwise decide which file an import takes. One rule for every picker.
 */
export function testPickOf(env: Record<string, string | undefined>, variable: string, capture: boolean): string | null {
  const path = env[variable];
  if (!path || !env.CIRRUS_DATA || !(capture || env.CIRRUS_BACKGROUND === '1')) return null;
  return path;
}

/** CIRRUS_PDF_PICK, the PDF « Choisir un PDF… » takes instead of opening the system's dialog (plan 5b, D5; testPickOf). */
export const pdfPickOf = (env: Record<string, string | undefined>, capture: boolean): string | null => testPickOf(env, 'CIRRUS_PDF_PICK', capture);
