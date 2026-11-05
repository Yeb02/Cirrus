import { type ChildProcess, execFile } from 'node:child_process';

/** Stops `pid` and every process it started: null once done, else why not. */
export type TreeKiller = (pid: number) => Promise<Error | null>;

const taskkill: TreeKiller = (pid) => new Promise((done) => {
  execFile('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true }, (e) => done(e));
});

/**
 * Stops a process and every process it started (plan 4b, final review I2): Windows stops a process alone, and what it
 * started goes on — tlmgr.bat's perl, the font tools kpathsea runs for pdfLaTeX (mktexpk, mktextfm, mf). On Windows,
 * by taskkill /t /f; should taskkill fail (not started, refused), the process itself is still stopped, so that whoever
 * waits for its exit is never left waiting. Elsewhere, the process itself. One that has exited is left alone: its pid
 * may be another process's by now.
 */
export async function killTree(child: ChildProcess, kill: TreeKiller = taskkill): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== 'win32' || child.pid === undefined) {
    child.kill();
    return;
  }
  if (await kill(child.pid)) child.kill();
}
