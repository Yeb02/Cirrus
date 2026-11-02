// Builds the MSDF atlas used by BitmapText from Inter (SIL Open Font License), downloaded on first run.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fontsDir = join(here, 'fonts');
const ttf = join(fontsDir, 'Inter-Regular.ttf');
const outDir = join(here, '..', 'src', 'renderer', 'public', 'font');
const INTER_ZIP = 'https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip';

mkdirSync(fontsDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

if (!existsSync(ttf)) {
  const zip = join(fontsDir, 'Inter-4.1.zip');
  const res = await fetch(INTER_ZIP);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  // Node has no unzip: extract the single entry with .NET.
  const ps = `Add-Type -AssemblyName System.IO.Compression.FileSystem;` +
    `$z=[System.IO.Compression.ZipFile]::OpenRead('${zip}');` +
    `$e=$z.GetEntry('extras/ttf/Inter-Regular.ttf');` +
    `[System.IO.Compression.ZipFileExtensions]::ExtractToFile($e,'${ttf}',$true);$z.Dispose()`;
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
}

// Latin, Latin-1, Latin Extended-A, Greek, and the symbols titles may use (spec 5.2: Unicode titles).
const ranges = [[0x20, 0x7e], [0xa0, 0xff], [0x100, 0x17f], [0x391, 0x3a9], [0x3b1, 0x3c9]];
let charset = '';
for (const [a, b] of ranges) for (let c = a; c <= b; c++) charset += String.fromCodePoint(c);
charset += '≤≥∑∫→←↔≈±×÷∞∂∇√∈∉⊂⊆∪∩∀∃¬∧∨≠≡…–—‘’“”•';
const charsetFile = join(fontsDir, 'charset.txt');
writeFileSync(charsetFile, charset, 'utf8');

const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve('msdf-bmfont-xml/package.json')), 'cli.js');
execFileSync(process.execPath, [cli, '-f', 'xml', '-o', join(outDir, 'inter-msdf.png'), '-s', '48', '-r', '6', '-t', 'msdf',
  '-m', '2048,2048', '-i', charsetFile, ttf], { stdio: 'inherit', cwd: outDir });

// The descriptor is named after the font face; give it the name the renderer loads.
for (const f of readdirSync(outDir)) {
  if (f.endsWith('.fnt') && f !== 'inter-msdf.fnt') renameSync(join(outDir, f), join(outDir, 'inter-msdf.fnt'));
}
console.log('font:', readdirSync(outDir).join(', '));
