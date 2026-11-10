// The signing key of Cirrus's updates (plan 9, D4), made once by the user: `node deploy/cle-de-signature.mjs`.
// - It makes an ed25519 pair.
// - It writes the public key into packages/app/src/main/update/key.ts (UPDATE_PUBLIC_KEY), to commit and push.
// - It shows the private key (PKCS#8 PEM) in the terminal, to paste into the GitHub secret CIRRUS_SIGNING_KEY. Shown
//   only to a terminal (review of task 4, M4): its output sent to a file, a pipe or a log, it refuses, unless
//   `--fichier <chemin>` names where to write the key instead — a new file, to delete once the key is pasted.
// A key already in key.ts is replaced only with --remplacer: the apps installed carry the old one, and would refuse every
// version signed with the new one — they would have to be installed again by hand. `--source <key.ts>`: another copy
// of key.ts (the tests).
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const USAGE = 'Usage : node deploy/cle-de-signature.mjs [--remplacer] [--fichier <clé privée.pem>] [--source <key.ts>]';
const args = process.argv.slice(2);
let source = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'app', 'src', 'main', 'update', 'key.ts');
let keyFile = null;
let replace = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--remplacer') replace = true;
  else if (args[i] === '--source' && i + 1 < args.length) source = args[++i];
  else if (args[i] === '--fichier' && i + 1 < args.length) keyFile = resolve(args[++i]);
  else fail(USAGE);
}

const LINE = /^export const UPDATE_PUBLIC_KEY: string = '([^']*)';(\r?)$/m;
const text = readFileSync(source, 'utf8');
const current = LINE.exec(text);
if (!current) fail(`${source} : la ligne « export const UPDATE_PUBLIC_KEY: string = '…'; » est introuvable.`);
if (!current[1].startsWith('PLACEHOLDER') && !replace) {
  fail([
    `${source} porte déjà une clé publique. La remplacer, c'est que les Cirrus installés refuseront toute version signée`,
    'avec la nouvelle : il faudrait les réinstaller à la main, par la page de téléchargement. Pour le faire quand même :',
    '  node deploy/cle-de-signature.mjs --remplacer',
  ].join('\n'));
}
// Checked before anything is made: the private key goes to a terminal, or to the file named, never anywhere else.
if (keyFile === null && !process.stdout.isTTY) {
  fail([
    'La sortie n’est pas un terminal (un fichier, un tube, un journal) : la clé privée n’y est pas écrite. Lance le script',
    'dans un terminal, ou donne --fichier <chemin> pour l’écrire dans un fichier neuf, à effacer une fois collée.',
  ].join('\n'));
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
// The file first, new only (never one that exists): it failing, key.ts is left as it was.
if (keyFile !== null) {
  try {
    writeFileSync(keyFile, pem, { flag: 'wx', mode: 0o600 });
  } catch (e) {
    fail(`Clé privée non écrite dans ${keyFile} (${e.message}) : rien n’est changé.`);
  }
}
writeFileSync(source, text.replace(LINE, `export const UPDATE_PUBLIC_KEY: string = '${pub}';$2`));

const steps = `1. Mets la clé privée dans les secrets du dépôt GitHub, sous le nom CIRRUS_SIGNING_KEY
   (Settings > Secrets and variables > Actions > New repository secret), en copiant tout, de BEGIN à END compris.
2. Commite et pousse key.ts : la version suivante portera la clé publique.`;
if (keyFile === null) {
  console.log(`Clé publique écrite dans ${source} :
  ${pub}

${steps}
   La clé privée n'est écrite nulle part : ne la garde dans aucun fichier, ne la colle dans aucun message.

${pem}`);
} else {
  console.log(`Clé publique écrite dans ${source} :
  ${pub}
Clé privée écrite dans ${keyFile}.

${steps}
3. EFFACE ${keyFile} une fois la clé collée dans GitHub : qui la lit peut signer une version que tes PC installeront.`);
}
