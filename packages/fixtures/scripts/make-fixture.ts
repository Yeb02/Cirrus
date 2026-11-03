// Builds the artificial test base in a new folder: npm run fixture -w packages/fixtures -- <dossier>
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LocalStore } from '@cirrus/store';
import { buildFixture } from '../src/build.ts';

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
const store = LocalStore.open(dir, { pc: 'fixture' });
buildFixture(store, dir);
const s = store.loadState();
console.log(`Base de test créée dans ${dir} : ${s.nodes.size} nœuds, ${s.connections.size} connexions, ${store.changesSince(0).length} lignes de journal.`);
store.close();
