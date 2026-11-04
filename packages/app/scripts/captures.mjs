// The reference captures (plan 3c): npm run captures -w packages/app -- <dossier> [--replace]
// Every scene below is captured on a fresh artificial test base, in a window of a fixed size, into <dossier>.
// compare-captures.mjs then compares two such folders: after each task that touches the rendering, a new suite (in a
// new folder) against the reference, docs/captures/plan4a since plan 4a's task 3 (the whole suite; reference-3c before
// it). A folder that already holds files is refused, so the reference is never replaced by mistake; --replace removes
// its captures first (to remake the reference on purpose).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const targets = args.filter((a) => !a.startsWith('--'));
const replace = args.includes('--replace');
if (targets.length !== 1 || args.some((a) => a.startsWith('--') && a !== '--replace')) {
  console.error('Usage : npm run captures -w packages/app -- <dossier> [--replace]');
  process.exit(2);
}
const out = resolve(process.env.INIT_CWD ?? process.cwd(), targets[0]);
if (existsSync(out) && readdirSync(out).length > 0) {
  if (!replace) {
    console.error(`${out} n’est pas vide : choisis un dossier neuf, ou --replace pour remplacer ses captures.`);
    process.exit(2);
  }
  for (const f of readdirSync(out)) if (f.toLowerCase().endsWith('.png')) rmSync(join(out, f));
}
const electron = createRequire(import.meta.url)('electron');

// The window's content is 1584×961 px at this size, its graph 1584×923 (under the tabs): the view's centre is at
// (792, 461), and a world point (x, y) at zoom z is drawn at (792 + (x − cx)·z, 461 + (y − cy)·z).
const SIZE = '1600,1000';
/** One scene: launch options of the app (src/main/index.ts), and settings written next to the base. */
const SCENES = [
  { name: 'lobby-vue-ensemble' },
  { name: 'zoom-profond', view: '175,140,4' },
  { name: 'groupe-mi-repli', view: '0,0,0.3' },
  // MDL, then Solomonoff with Ctrl.
  { name: 'selection', view: '0,140,1', pointer: 'down 967 461; up 967 461; down 617 461 ctrl; up 617 461 ctrl' },
  { name: 'apercu-glissement', view: '0,140,1', pointer: 'down 967 461; move 990 470 | move 1060 520' },
  // A click on « Analogue bayésien », between MDL and Solomonoff.
  { name: 'fenetre-connexion', view: '0,140,1', pointer: 'down 792 461; up 792 461' },
  { name: 'survol-connexion', view: '0,140,1', hover: '792,461' },
  // The fixture's stubs are in « Thèse » (Entropie's branch), its phantoms in the lobby (Universality's split arm).
  { name: 'amorces-these', plan: 'Thèse' },
  { name: 'fantomes-lobby', view: '480,420,1' },
  { name: 'fond-grille', settings: { background: 'grid' } },
  { name: 'plan-document', plan: 'Article MDL' },
  // Plan 4a: a click on MDL opens its pop-up, to the right of and below the click.
  { name: 'popup-noeud', view: '0,140,1', pointer: 'down 967 461; up 967 461' },
];

/**
 * The test base's history at fixed times, one action a minute from 2026-01-05 09:00 UTC in the order they were written,
 * instead of the moment it was built: a pop-up's dates then read the same at every capture (the identifiers, random,
 * are not drawn in captures: `.volatile`).
 */
const HISTORY_FROM = Date.UTC(2026, 0, 5, 9, 0);
function fixHistoryTimes(dir) {
  const db = new DatabaseSync(join(dir, 'cirrus.db'));
  try {
    db.exec(`WITH ranked AS (SELECT action_id, ROW_NUMBER() OVER (ORDER BY MIN(local_seq)) AS n FROM changes GROUP BY action_id)
      UPDATE changes SET at = ${HISTORY_FROM} + 60000 * (SELECT n FROM ranked WHERE ranked.action_id = changes.action_id)`);
  } finally {
    db.close();
  }
}

mkdirSync(out, { recursive: true });
const env0 = { ...process.env };
delete env0.ELECTRON_RUN_AS_NODE;
let failed = 0;
for (const s of SCENES) {
  const data = mkdtempSync(join(tmpdir(), 'cirrus-captures-'));
  try {
    execFileSync(process.execPath, [join(appDir, '..', 'fixtures', 'scripts', 'make-fixture.ts'), data], { stdio: 'ignore' });
    fixHistoryTimes(data);
    if (s.settings) writeFileSync(join(data, 'settings.json'), JSON.stringify(s.settings), 'utf8');
    const env = { ...env0, CIRRUS_DATA: data, CIRRUS_CAPTURE: join(out, `${s.name}.png`), CIRRUS_SIZE: SIZE };
    for (const [key, name] of [['plan', 'CIRRUS_PLAN'], ['view', 'CIRRUS_VIEW'], ['hover', 'CIRRUS_HOVER'], ['pointer', 'CIRRUS_POINTER'], ['keys', 'CIRRUS_KEYS'], ['click', 'CIRRUS_CLICK']]) {
      if (s[key]) env[name] = s[key];
    }
    const r = spawnSync(electron, [appDir], { env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 120_000 });
    if (r.status !== 0) {
      failed++;
      console.error(`${s.name} : échec (${r.status ?? r.signal})\n${r.stdout}${r.stderr}`);
    } else console.log(`${s.name}.png`);
  } finally {
    rmSync(data, { recursive: true, force: true, maxRetries: 5 });
  }
}
console.log(`${SCENES.length - failed} captures sur ${SCENES.length} dans ${out}`);
process.exit(failed > 0 ? 1 : 0);
