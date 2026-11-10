/**
 * The bench's calls (plan 9, D8), exposed to the page in bench mode only — `launch.bench`, the pass's label, which the
 * main process gives with CIRRUS_BENCH — and absent otherwise: the main process wires them in that mode only.
 */
export function benchCalls(launch: { bench?: unknown }, invoke: (channel: string, ...args: unknown[]) => Promise<unknown>): {
  benchMemory?: () => Promise<unknown>;
  benchDone?: (run: unknown) => Promise<unknown>;
} {
  if (typeof launch.bench !== 'string' || launch.bench === '') return {};
  return {
    benchMemory: () => invoke('cirrus:bench:memory'),
    benchDone: (run: unknown) => invoke('cirrus:bench:done', run),
  };
}
