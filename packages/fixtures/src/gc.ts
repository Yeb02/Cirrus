import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

let gc: (() => void) | null = null;

/**
 * Two full garbage collections (the second frees what the first's finalisers released), for memory measurements
 * under Node (plan 3c): read process.memoryUsage().heapUsed right after. Works without --expose-gc on the command line.
 */
export function forceGc(): void {
  if (!gc) {
    setFlagsFromString('--expose-gc');
    gc = runInNewContext('gc') as () => void;
  }
  gc();
  gc();
}
