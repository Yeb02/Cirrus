/**
 * Where the LaTeX chain downloads from (plan 4b, D1), in this one place: the pinned TinyTeX installer, which provision
 * fetches after the user's consent, and the package repository, which provision sets tlmgr on and Packages names at
 * each call that reaches the network. Internet sources for now; plan 5/9 points them at Cirrus's own server, so that
 * the user fetches nothing elsewhere. No other module names an address or a repository (a test checks it).
 */

export interface TinyTexRelease { version: string; asset: string; url: string; sha256: string; bytes: number }

interface LatexSources {
  tinytex: TinyTexRelease;
  /**
   * tlmgr's repository (ruling R2.4): `ctan`, which tlmgr reads as CTAN's mirror network for TeX Live's own tlnet. An
   * address goes as it is (runFile lets « : » through to a .bat).
   */
  repository: string;
}

export const LATEX_SOURCES: LatexSources = {
  // TinyTeX-1 for Windows, v2026.11 (TeX Live 2026, pdfTeX 1.40.29): the bench's, downloaded and hashed on 2026-11-05.
  tinytex: {
    version: 'v2026.11',
    asset: 'TinyTeX-1-windows-v2026.11.exe',
    url: 'https://github.com/rstudio/tinytex-releases/releases/download/v2026.11/TinyTeX-1-windows-v2026.11.exe',
    sha256: '375e8adec0177cd9ec6a1f8c76efe0c22b1a0c260e76a00386bcea52d88e5354',
    bytes: 73_710_178,
  },
  repository: 'ctan',
};
