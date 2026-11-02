/** TeX paths use forward slashes, even on Windows. */
export const texPath = (p: string): string => p.replace(/\\/g, '/');

/**
 * The driver loads the preamble, announces CIRRUS-READY, then waits on standard input for the name of the job to
 * compile. After the read it switches to \nonstopmode: an error in a node can never wait for input again.
 */
export function driverSource(preamblePath: string): string {
  return [
    `\\input{${texPath(preamblePath)}}`,
    '\\begin{document}',
    '\\message{CIRRUS-READY}',
    '{\\endlinechar=-1 \\global\\read16 to \\cirrusjob}',
    '\\nonstopmode',
    '\\input{\\cirrusjob}',
    '\\end{document}',
    '',
  ].join('\n');
}
