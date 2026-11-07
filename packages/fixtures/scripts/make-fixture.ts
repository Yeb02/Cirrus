// Builds the artificial test base in a new folder: npm run fixture -w packages/fixtures -- <dossier>
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LocalStore } from '@cirrus/store';
import { buildFixture } from '../src/build.ts';
import { FIXTURE_PC, isUserBase } from '../src/testBase.ts';

const target = process.argv[2];
if (!target) {
  console.error('Usage : npm run fixture -w packages/fixtures -- <dossier>');
  process.exit(1);
}
// npm runs the script from the package folder; a relative path is meant from where npm was called.
const dir = resolve(process.env.INIT_CWD ?? process.cwd(), target);
if (existsSync(join(dir, 'cirrus.db'))) {
  console.error(`${dir} contient déjà une base : choisis un dossier vide.`);
  process.exit(1);
}
// Nor where the user's base will be (final review of plan 4c, M6): the app would open the test base as its own.
if (isUserBase(dir)) {
  console.error(`${dir} est la place de la base de l’utilisateur : choisis un autre dossier.`);
  process.exit(1);
}
// Its journal signed FIXTURE_PC: the mark of a test base (testBaseRefusal, add-reading.ts).
const store = LocalStore.open(dir, { pc: FIXTURE_PC });
buildFixture(store, dir);
const s = store.loadState();
console.log(`Base de test créée dans ${dir} : ${s.nodes.size} nœuds, ${s.connections.size} connexions, ${store.changesSince(0).length} lignes de journal.`);
store.close();
