// The signing key of Cirrus's updates (plan 9, D4), made once by the user: `node deploy/cle-de-signature.mjs`.
// - It makes an ed25519 pair.
// - It writes the public key into packages/app/src/main/update/key.ts (UPDATE_PUBLIC_KEY), to commit and push.
// - It prints the private key (PKCS#8 PEM), to paste into the GitHub secret CIRRUS_SIGNING_KEY. It never writes it to
//   the disk: copied, it is gone once this window is closed.
// A key already in key.ts is replaced only with --remplacer: the apps installed carry the old one, and would refuse every
// version signed with the new one — they would have to be installed again by hand. `--fichier <key.ts>`: another copy
// of key.ts (the tests).
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const args = process.argv.slice(2);
let file = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'app', 'src', 'main', 'update', 'key.ts');
let replace = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--remplacer') replace = true;
  else if (args[i] === '--fichier' && i + 1 < args.length) file = args[++i];
  else fail('Usage : node deploy/cle-de-signature.mjs [--remplacer] [--fichier <key.ts>]');
}

const LINE = /^export const UPDATE_PUBLIC_KEY: string = '([^']*)';(\r?)$/m;
const source = readFileSync(file, 'utf8');
const current = LINE.exec(source);
if (!current) fail(`${file} : la ligne « export const UPDATE_PUBLIC_KEY: string = '…'; » est introuvable.`);
if (!current[1].startsWith('PLACEHOLDER') && !replace) {
  fail([
    `${file} porte déjà une clé publique. La remplacer, c'est que les Cirrus installés refuseront toute version signée`,
    'avec la nouvelle : il faudrait les réinstaller à la main, par la page de téléchargement. Pour le faire quand même :',
    '  node deploy/cle-de-signature.mjs --remplacer',
  ].join('\n'));
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
writeFileSync(file, source.replace(LINE, `export const UPDATE_PUBLIC_KEY: string = '${pub}';$2`));

console.log(`Clé publique écrite dans ${file} :
  ${pub}

1. Mets la clé privée ci-dessous dans les secrets du dépôt GitHub, sous le nom CIRRUS_SIGNING_KEY
   (Settings > Secrets and variables > Actions > New repository secret), en copiant tout, de BEGIN à END compris.
   Elle n'est écrite nulle part : ne la garde dans aucun fichier, ne la colle dans aucun message.
2. Commite et pousse key.ts : la version suivante portera la clé publique.

${pem}`);
