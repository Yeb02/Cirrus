/** TeX paths use forward slashes, even on Windows. */
export const texPath = (p: string): string => p.replace(/\\/g, '/');

/**
 * pdfLaTeX starts in nonstopmode, so an error in the preamble can never wait for input. The driver loads the
 * preamble, announces CIRRUS-READY, switches to \scrollmode only to read the job name from standard input, then
 * back to \nonstopmode for the node itself.
 */
export function driverSource(preamblePath: string): string {
  return [
    `\\input{${texPath(preamblePath)}}`,
    '\\begin{document}',
    '\\message{CIRRUS-READY}',
    '\\scrollmode',
    '{\\endlinechar=-1 \\global\\read16 to \\cirrusjob}',
    '\\nonstopmode',
    '\\input{\\cirrusjob}',
    '\\end{document}',
    '',
  ].join('\n');
}
