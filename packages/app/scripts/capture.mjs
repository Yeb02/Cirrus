// Visual check: npm run capture -w packages/app -- <image.png> [--plan=<nom>] [--view=x,y,zoom] [--hover=x,y] [--keys=ctrl+z,…]
//   [--panel] [--size=w,h] [--data=<dossier>]
// Without --data, the artificial test base is built in a temporary folder. The app quits once the image is written.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');
const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
if (!target) {
  console.error('Usage : npm run capture -w packages/app -- <image.png> [--plan=<nom>] [--view=x,y,zoom] [--hover=x,y] [--panel] [--size=w,h] [--data=<dossier>]');
  process.exit(1);
}
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const cwd = process.env.INIT_CWD ?? process.cwd();
const out = resolve(cwd, target);

let data = opt('data') && resolve(cwd, opt('data'));
if (!data) {
  data = mkdtempSync(join(tmpdir(), 'cirrus-capture-'));
  execFileSync(process.execPath, [join(appDir, '..', 'fixtures', 'scripts', 'make-fixture.ts'), data], { stdio: 'inherit' });
}

const electron = createRequire(import.meta.url)('electron');
const env = { ...process.env, CIRRUS_DATA: data, CIRRUS_CAPTURE: out };
for (const [name, key] of [['plan', 'CIRRUS_PLAN'], ['view', 'CIRRUS_VIEW'], ['hover', 'CIRRUS_HOVER'], ['size', 'CIRRUS_SIZE'], ['keys', 'CIRRUS_KEYS']]) {
  if (opt(name)) env[key] = opt(name);
}
if (args.includes('--panel')) env.CIRRUS_PANEL = '1';
delete env.ELECTRON_RUN_AS_NODE;
const r = spawnSync(electron, [appDir], { env, stdio: 'inherit' });
process.exit(r.status ?? 1);
