// The manifest of an official version, signed (plan 9, D4, D6): `node scripts/signer-version.mjs <dossier dist>`, the
// CI's step after electron-builder, the private key in CIRRUS_SIGNING_KEY (PKCS#8 PEM, GitHub's secret: never on the
// disk). It reads latest.yml, which electron-builder wrote beside the installer (its version, the installer's name),
// hashes the installer itself — its sha512 must be the one latest.yml gives, or nothing is signed —, then writes
// version.json { version, file, sha512, size, date } and version.json.sig, the base64 ed25519 signature of version.json's
// exact bytes. The app checks both (src/main/update/manifest.ts) with the public key it carries (update/key.ts); a
// secret that is not that key's pair is refused here, rather than published for apps that would refuse it.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const args = process.argv.slice(2);
if (args.length !== 1) fail('Usage : node scripts/signer-version.mjs <dossier dist>   (la clé privée dans la variable CIRRUS_SIGNING_KEY)');
const dist = args[0];
const pem = process.env.CIRRUS_SIGNING_KEY;
if (!pem) fail('CIRRUS_SIGNING_KEY absente : rien n’est signé.');
let key;
try {
  key = createPrivateKey(pem);
} catch (e) {
  fail(`CIRRUS_SIGNING_KEY illisible (une clé PKCS#8 PEM attendue) : ${e.message}`);
}
if (key.asymmetricKeyType !== 'ed25519') fail(`CIRRUS_SIGNING_KEY n’est pas une clé ed25519 (${key.asymmetricKeyType}).`);

// The public half, against the one the app carries: a placeholder there is only said (no key yet: the apps refuse
// every update anyway); another key fails.
const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
const keyFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main', 'update', 'key.ts');
const carried = /^export const UPDATE_PUBLIC_KEY: string = '([^']*)';\r?$/m.exec(readFileSync(keyFile, 'utf8'))?.[1];
if (carried === undefined) fail(`${keyFile} : la ligne UPDATE_PUBLIC_KEY est introuvable.`);
if (carried.startsWith('PLACEHOLDER')) console.warn(`Attention : ${keyFile} ne porte pas encore de clé ; les apps refuseront cette version.`);
else if (carried !== publicKey) fail(`CIRRUS_SIGNING_KEY n’est pas la paire de la clé publique de l’app (${keyFile}) : rien n’est signé.`);

/** A top-level scalar of latest.yml, as electron-builder writes them: plain, 'single' or "double" quoted. */
const latest = readFileSync(join(dist, 'latest.yml'), 'utf8');
function field(name) {
  const raw = new RegExp(`^${name}:[ \\t]*(.*?)[ \\t]*\\r?$`, 'm').exec(latest)?.[1];
  if (raw === undefined || raw === '') return null;
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) return raw.slice(1, -1).replaceAll("''", "'");
  if (raw.startsWith('"')) return JSON.parse(raw);
  return raw;
}
const version = field('version'), file = field('path'), announced = field('sha512');
if (!version || !/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(version)) fail(`latest.yml : version invalide (${version}).`);
if (!file || /[\\/:]/.test(file) || file === '.' || file === '..' || !/\.exe$/i.test(file)) fail(`latest.yml : installateur invalide (${file}).`);

const path = join(dist, file);
const size = statSync(path).size;
const hash = createHash('sha512');
for await (const chunk of createReadStream(path)) hash.update(chunk);
const sha512 = hash.digest('base64');
if (announced !== sha512) fail(`latest.yml annonce pour ${file} une empreinte qui n’est pas la sienne : rien n’est signé.`);

const text = `${JSON.stringify({ version, file, sha512, size, date: new Date().toISOString() }, null, 2)}\n`;
const signature = sign(null, Buffer.from(text, 'utf8'), key).toString('base64');
writeFileSync(join(dist, 'version.json'), text);
writeFileSync(join(dist, 'version.json.sig'), signature);
console.log(`version.json signé : ${version}, ${file}, ${size} octets (clé publique ${publicKey}).`);
