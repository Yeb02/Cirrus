import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { type BrowserWindow, ipcMain } from 'electron';

/**
 * A capture (CIRRUS_CAPTURE=<png>): the window's image, written to `capture` once the interface is ready (cirrus:ready:
 * its first frame drawn, its visual checks done), then the app quits (`exit`); with no word after 30 s, the image as
 * it is, and the app quits with an error.
 */
export function captureWhenReady(win: BrowserWindow, capture: string, exit: (code: number) => void): void {
  let done = false;
  const shoot = (code: number) => {
    if (done) return;
    done = true;
    void win.webContents.capturePage().then((img) => {
      mkdirSync(dirname(capture), { recursive: true });
      writeFileSync(capture, img.toPNG());
      console.log(`Capture écrite : ${capture}`);
      exit(code);
    });
  };
  ipcMain.once('cirrus:ready', () => setTimeout(() => shoot(0), 500));
  setTimeout(() => { console.error('Pas d’image après 30 s : capture de l’état actuel.'); shoot(1); }, 30_000);
}
