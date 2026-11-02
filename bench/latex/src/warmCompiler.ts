import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { driverSource, texPath } from './driver.ts';

export interface CompileJob { texPath: string; refs?: { label: string; title: string }[]; resourceDir?: string }
export interface CompileResult { ok: boolean; ms: number; pdfPath?: string; logPath: string; error?: string; timedOut: boolean }
export interface WarmCompilerOptions { pdflatex: string; workDir: string; preamblePath: string; timeoutMs?: number }

interface Prepared { proc: ChildProcess; jobname: string; exited: Promise<number | null> }

/**
 * pdfLaTeX started ahead of time: the preamble is already loaded when a node arrives (spec 13, TeX-fast-recompile's
 * idea). Jobs are written under neutral names in workDir; shell escape is always off.
 */
export class WarmCompiler {
  private readonly driverPath: string;
  private readonly timeoutMs: number;
  private counter = 0;
  private next: Promise<Prepared> | null = null;
  private live = new Set<ChildProcess>();
  private readonly opts: WarmCompilerOptions;

  constructor(opts: WarmCompilerOptions) {
    this.opts = opts;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.driverPath = join(opts.workDir, 'driver.tex');
    writeFileSync(this.driverPath, driverSource(opts.preamblePath), 'utf8');
  }

  /** Starts pdfLaTeX and resolves once the preamble is loaded and the driver waits for a job. */
  prepare(): Promise<void> {
    if (!this.next) this.next = this.spawnWaiting(); // reuse the process already being prepared
    return this.next.then(() => undefined);
  }

  async compile(job: CompileJob): Promise<CompileResult> {
    const prepared = await (this.next ?? (this.next = this.spawnWaiting()));
    this.next = null;
    const body = this.writeBody(prepared.jobname, job);
    const t0 = performance.now();
    prepared.proc.stdin!.write(`${body}\n`);
    const result = await this.finish(prepared, t0);
    this.next = this.spawnWaiting(); // keep one process ready for the next job
    this.next.catch(() => undefined);
    return result;
  }

  /** Start + preamble + body, for comparison with compile(). */
  async compileCold(job: CompileJob): Promise<CompileResult> {
    const t0 = performance.now();
    const prepared = await this.spawnWaiting();
    const body = this.writeBody(prepared.jobname, job);
    prepared.proc.stdin!.write(`${body}\n`);
    return this.finish(prepared, t0);
  }

  /** Kills every pdfLaTeX still alive and waits until they have exited (their workDir can then be removed). */
  async dispose(): Promise<void> {
    const procs = [...this.live];
    this.next = null;
    await Promise.all(procs.map((p) => new Promise<void>((resolve) => {
      if (p.exitCode !== null || p.signalCode !== null) return resolve();
      p.once('exit', () => resolve());
      p.kill();
    })));
    this.live.clear();
  }

  private spawnWaiting(): Promise<Prepared> {
    const jobname = `job-${++this.counter}`;
    const proc = spawn(this.opts.pdflatex, ['-no-shell-escape', '-interaction=nonstopmode', `-jobname=${jobname}`, 'driver.tex'], {
      cwd: this.opts.workDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.live.add(proc);
    const exited = new Promise<number | null>((resolve) => proc.on('exit', (code) => { this.live.delete(proc); resolve(code); }));
    return new Promise<Prepared>((resolve, reject) => {
      let out = '';
      const onData = (d: Buffer) => {
        out += d.toString('latin1');
        if (out.includes('CIRRUS-READY')) {
          clearTimeout(timer);
          proc.stdout!.off('data', onData);
          proc.stdout!.resume(); // keep draining so pdfLaTeX never blocks on a full pipe
          resolve({ proc, jobname, exited });
        }
      };
      // A preamble that never reaches CIRRUS-READY (stuck or too slow) is killed after timeoutMs.
      const timer = setTimeout(() => { proc.kill(); reject(new Error(`preamble not loaded after ${this.timeoutMs} ms`)); }, this.timeoutMs);
      void exited.then(() => clearTimeout(timer));
      proc.stdout!.on('data', onData);
      proc.stderr!.resume();
      proc.on('error', reject);
      void exited.then((code) => { if (!out.includes('CIRRUS-READY')) reject(new Error(`pdflatex exited (${code}) before the preamble was loaded`)); });
    });
  }

  /** Neutral names only: the fragment is copied to job-<n>-src.tex, the body declares refs and resources. */
  private writeBody(jobname: string, job: CompileJob): string {
    const src = `${jobname}-src.tex`;
    copyFileSync(job.texPath, join(this.opts.workDir, src));
    const lines: string[] = [];
    if (job.refs?.length) {
      lines.push('\\makeatletter');
      // \newlabel and \@newl@bel are preamble-only: define \r@<label> directly, with the five fields hyperref reads.
      for (const r of job.refs) lines.push(`\\expandafter\\gdef\\csname r@${r.label}\\endcsname{{${r.title}}{1}{}{}{}}`);
      lines.push('\\makeatother');
    }
    if (job.resourceDir) lines.push(`\\graphicspath{{${texPath(job.resourceDir)}/}}`);
    lines.push(`\\input{${src}}`);
    const body = `${jobname}-body.tex`;
    writeFileSync(join(this.opts.workDir, body), `${lines.join('\n')}\n`, 'utf8');
    return body;
  }

  private async finish(prepared: Prepared, t0: number): Promise<CompileResult> {
    const { proc, jobname } = prepared;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill(); }, this.timeoutMs);
    const code = await prepared.exited;
    clearTimeout(timer);
    const ms = performance.now() - t0;
    const logPath = join(this.opts.workDir, `${jobname}.log`);
    const pdfPath = join(this.opts.workDir, `${jobname}.pdf`);
    const ok = !timedOut && code === 0 && existsSync(pdfPath);
    let error: string | undefined;
    if (!ok) {
      const log = existsSync(logPath) ? readFileSync(logPath, 'latin1') : '';
      error = timedOut ? `timeout after ${this.timeoutMs} ms` : (log.split('\n').find((l) => l.startsWith('!')) ?? `pdflatex exited with ${code}`);
    }
    return { ok, ms, pdfPath: ok ? pdfPath : undefined, logPath, error, timedOut };
  }
}
