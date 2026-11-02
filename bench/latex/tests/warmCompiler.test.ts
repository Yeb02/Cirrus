import { afterEach, beforeEach, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WarmCompiler } from '../src/warmCompiler';

const here = dirname(fileURLToPath(import.meta.url));
const fragDir = join(here, '..', 'tex', 'fragments');
const preamblePath = join(here, '..', 'tex', 'preamble.tex');
const pdflatex = join(here, '..', 'vendor', 'TinyTeX', 'bin', 'windows', 'pdflatex.exe');
const frag = (name: string) => join(fragDir, name);

let workDir: string;
let compiler: WarmCompiler;
const writeTmp = (body: string) => {
  const p = join(workDir, `tmp-${Math.random().toString(36).slice(2)}.tex`);
  writeFileSync(p, body, 'utf8');
  return p;
};

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'cirrus-tex-'));
  compiler = new WarmCompiler({ pdflatex, workDir, preamblePath, timeoutMs: 10_000 });
});
afterEach(async () => {
  await compiler.dispose();
  rmSync(workDir, { recursive: true, force: true });
});

test('compile un fragment court et produit un PDF', async () => {
  const r = await compiler.compile({ texPath: frag('court.tex') });
  expect(r.ok).toBe(true);
  expect(existsSync(r.pdfPath!)).toBe(true);
});

test("préchauffé plus rapide qu'à froid", async () => {
  const cold = await compiler.compileCold({ texPath: frag('court.tex') });
  await compiler.prepare();
  const warm = await compiler.compile({ texPath: frag('court.tex') });
  expect(cold.ok && warm.ok).toBe(true);
  expect(warm.ms).toBeLessThan(cold.ms);
});

test('fichier manquant : échec rapide, sans blocage (Review Focus 4)', async () => {
  const r = await compiler.compile({ texPath: writeTmp('\\input{inexistant}') });
  expect(r.ok).toBe(false);
  expect(r.timedOut).toBe(false);
  expect(r.ms).toBeLessThan(5000);
});

test('référence externe injectée résolue', async () => {
  const r = await compiler.compile({ texPath: frag('references.tex'), refs: [{ label: 'ext:mdl', title: 'Minimum Description Length' }] });
  expect(r.ok).toBe(true);
  expect(readFileSync(r.logPath, 'utf8')).not.toMatch(/undefined/i);
});

test('shell escape refusé', async () => {
  await compiler.compile({ texPath: writeTmp('\\immediate\\write18{echo pwned > pwned.txt}x') });
  expect(existsSync(join(workDir, 'pwned.txt'))).toBe(false);
});

test('préambule invalide : prepare échoue vite au lieu de bloquer', async () => {
  const badPreamble = join(workDir, 'bad-preamble.tex');
  writeFileSync(badPreamble, '\\documentclass{article}\n\\usepackage{paquet-inexistant-xyz}\n', 'utf8');
  const bad = new WarmCompiler({ pdflatex, workDir, preamblePath: badPreamble, timeoutMs: 5_000 });
  const t0 = performance.now();
  await expect(bad.prepare()).rejects.toThrow();
  expect(performance.now() - t0).toBeLessThan(6_000);
  await bad.dispose();
});

test('nom de fichier accentué : résultat déterminé (Review Focus 5)', async () => {
  const r = await compiler.compile({ texPath: frag('accents.tex'), resourceDir: fragDir });
  expect(r.timedOut).toBe(false);
  expect(r.ok || (r.error ?? '').length > 0).toBe(true);
});
