import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CompileRequest, DEFAULT_PREAMBLE } from '@cirrus/core';
import { DEFAULT_PARAMS, type RenderParams } from '@cirrus/view';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PdfCache } from '../src/main/latex/cache.ts';
import { LatexService } from '../src/main/latex/compiler.ts';
import { killTree } from '../src/main/latex/kill.ts';
import { runFile } from '../src/main/latex/tinytex.ts';

/**
 * A pdfLaTeX that starts a long child, as kpathsea starts mktexpk or mf for a missing font (plan 4b, final review I2):
 * the service's spawn of FAKE runs this script instead, under node. The child is detached, so that stopping its parent
 * alone leaves it running, as Windows does for pdfLaTeX's; its pid is written to <dir>/<parent's pid>.txt.
 */
const fake = vi.hoisted(() => ({ FAKE: 'C:\\faux\\pdflatex.exe', dir: '', taskkillFails: false, spawned: [] as ChildProcess[] }));
vi.mock('node:child_process', async (original) => {
  const cp = await original<typeof import('node:child_process')>();
  const script = () => [
    "const { spawn } = require('node:child_process');",
    "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true });",
    `require('node:fs').writeFileSync(require('node:path').join(${JSON.stringify(fake.dir)}, process.pid + '.txt'), String(g.pid));`,
    "process.stdout.write('CIRRUS-READY\\n');",
    'process.stdin.resume();',
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const spawn = ((file: string, args: string[], opts: object) => {
    const p = file === fake.FAKE ? cp.spawn(process.execPath, ['-e', script()], opts) : cp.spawn(file, args, opts);
    fake.spawned.push(p);
    return p;
  }) as unknown as typeof cp.spawn;
  // taskkill made to fail (not found, refused): the fallback stops the process itself.
  const execFile = ((file: string, args: string[], opts: object, cb: (e: Error | null) => void) => {
    if (file === 'taskkill' && fake.taskkillFails) {
      setImmediate(() => cb(new Error('taskkill introuvable')));
      return undefined;
    }
    return (cp.execFile as (...a: unknown[]) => ChildProcess)(file, args, opts, cb);
  }) as unknown as typeof cp.execFile;
  return { ...cp, spawn, execFile, default: { ...cp, spawn, execFile } };
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  for (const t0 = performance.now(); !cond(); await sleep(20)) if (performance.now() - t0 > ms) throw new Error('attente trop longue');
}
const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let base: string;
let svc: LatexService | null = null;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'cirrus-arbre-'));
  fake.dir = join(base, 'enfants');
  fake.taskkillFails = false;
  fake.spawned.length = 0;
  mkdirSync(fake.dir);
});
/** The children the fake pdfLaTeX started, by their parent's pid. */
const children = () => new Map(readdirSync(fake.dir).map((f) => [Number(f.slice(0, -4)), Number(readFileSync(join(fake.dir, f), 'utf8'))]));
afterEach(async () => {
  await svc?.dispose();
  svc = null;
  // Whatever a failing test left running.
  if (existsSync(fake.dir)) for (const pid of children().values()) if (running(pid)) process.kill(pid);
  for (const p of fake.spawned) p.kill();
  rmSync(base, { recursive: true, force: true, maxRetries: 10 });
});

function start(over: Partial<RenderParams> = {}): LatexService {
  const params = { ...DEFAULT_PARAMS, latexWarmProcesses: 1, ...over };
  svc = new LatexService({
    binaries: async () => ({ root: base, pdflatex: fake.FAKE, tlmgr: 'tlmgr.bat', version: 'faux pdfTeX' }),
    root: join(base, 'latex'), store: base, params: () => params,
    cache: new PdfCache(join(base, 'latex', 'cache'), () => params.latexCacheMb * 2 ** 20),
  });
  return svc;
}
const req = (over: Partial<CompileRequest> = {}): CompileRequest => ({
  slot: 'summary:n1', mode: 'snippet', source: 'Bonjour.', preamble: DEFAULT_PREAMBLE, refs: [], broken: [], doubled: [], cites: [],
  doubledCites: [], unknownCites: [], known: [], resources: [], widthCm: 9, ...over,
});
/** The child of the process the job runs in: the first one started, given to the first request. */
async function jobChild(): Promise<number> {
  await until(() => fake.spawned.length > 0 && children().has(fake.spawned[0].pid!));
  const pid = children().get(fake.spawned[0].pid!)!;
  expect(running(pid)).toBe(true);
  return pid;
}

const onWindows = process.platform === 'win32';

test.skipIf(!onWindows)('pdfLaTeX annulé : son processus et ceux qu’il a lancés s’arrêtent (revue finale, I2)', async () => {
  const s = start({ latexTimeoutMs: 60_000 });
  const answer = s.compile(req());
  const child = await jobChild();
  s.cancel('summary:n1');
  expect(await answer).toEqual({ status: 'cancelled' });
  await until(() => !running(child), 5000);
}, 30_000);

test.skipIf(!onWindows)('pdfLaTeX trop long : arrêté avec ce qu’il a lancé', async () => {
  const s = start({ latexTimeoutMs: 1000 });
  const answer = s.compile(req());
  const child = await jobChild();
  expect(await answer).toMatchObject({ status: 'error', error: { message: 'Compilation trop longue (plus de 1 s) : arrêtée.' } });
  await until(() => !running(child), 5000);
}, 30_000);

test.skipIf(!onWindows)('fermeture de l’app : chaque pdfLaTeX, au travail ou en réserve, s’arrête avec ce qu’il a lancé', async () => {
  const s = start({ latexTimeoutMs: 60_000 });
  void s.compile(req());
  await jobChild();
  // The pool topped up: a second process waits, with its own child.
  await until(() => fake.spawned.length === 2 && children().size === 2);
  await s.dispose();
  svc = null;
  for (const [parent, child] of children()) {
    expect(running(parent), `pdfLaTeX ${parent}`).toBe(false);
    await until(() => !running(child), 5000);
  }
}, 30_000);

test.skipIf(!onWindows)('runFile : un taskkill qui échoue arrête tout de même le programme, et l’appel finit (il restait suspendu)', async () => {
  fake.taskkillFails = true;
  const t0 = performance.now();
  await expect(runFile(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], 500)).rejects.toThrow(/ne répond plus \(plus de 0,5 s\) : arrêté\.$/);
  expect(performance.now() - t0).toBeLessThan(5000);
}, 30_000);

/** A ChildProcess as killTree sees it. */
function fakeChild(pid: number | undefined) {
  const kills: unknown[] = [];
  return { child: { pid, exitCode: null, signalCode: null, kill: (s?: unknown) => { kills.push(s); return true; } } as unknown as ChildProcess, kills };
}

test('killTree : taskkill /t /f sous Windows ; s’il échoue, le processus lui-même ; ailleurs, ou sans pid, le processus lui-même', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const asked: number[] = [];
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const ok = fakeChild(42);
    await killTree(ok.child, async (pid) => { asked.push(pid); return null; });
    expect([asked, ok.kills]).toEqual([[42], []]);
    const refused = fakeChild(43);
    await killTree(refused.child, async (pid) => { asked.push(pid); return new Error('Accès refusé.'); });
    expect([asked, refused.kills.length]).toEqual([[42, 43], 1]);
    const unstarted = fakeChild(undefined);
    await killTree(unstarted.child, async () => { throw new Error('jamais appelé'); });
    expect(unstarted.kills.length).toBe(1);
    // Exited already: its pid may be another process's by now, never given to taskkill.
    const gone = fakeChild(44);
    (gone.child as { exitCode: number | null }).exitCode = 0;
    await killTree(gone.child, async () => { throw new Error('jamais appelé'); });
    expect(asked).toEqual([42, 43]);
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const elsewhere = fakeChild(45);
    await killTree(elsewhere.child, async () => { throw new Error('jamais appelé'); });
    expect(elsewhere.kills.length).toBe(1);
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});
