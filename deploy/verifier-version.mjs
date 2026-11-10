// The checks of the server's update (plan 9, D6), with the app's own code: deploy/mettre-a-jour.sh calls it, as root,
// from the code deployed in /opt/cirrus. The key trusted is the one of the code deployed (key.ts), never the one of the
// version being installed. The manifest is checked by verifyManifest and the installer by checkInstaller
// (packages/app/src/main/update/manifest.ts, which Node reads, stripping its types): the same checks as the app's.
//
//   node deploy/verifier-version.mjs publication <réponse.json> <propriétaire/dépôt>
//     GitHub's answer for the latest release (api.github.com/repos/<dépôt>/releases/latest). Prints `tag\t<tag>`, then
//     `<rôle>\t<adresse>\t<taille>` for version.json, version.json.sig, latest.yml and the installer. The installer is
//     the release's only .exe: GitHub renames « Cirrus Setup 0.1.7.exe » into « Cirrus.Setup.0.1.7.exe », so its name
//     there is never relied on; it is placed under the name the signed manifest gives.
//   node deploy/verifier-version.mjs verifier <dépôt> <tag> <dossier>
//     <dossier>/version.json and version.json.sig checked with <dépôt>'s public key; the manifest's version that of
//     <tag>; <dossier>/installateur of the manifest's size and sha512. Prints the installer's name in the manifest.
//   node deploy/verifier-version.mjs posee <dépôt> <dossier>
//     The version of the manifest placed in <dossier> (the server's versions/), when its signature holds with <dépôt>'s
//     key; nothing otherwise.
//
// Exit codes: 0 done; 1 refused (said on stderr, for the journal); 2 usage; 3 the public key is still the placeholder.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The manifest's checks, next to this script in the same checkout: loaded only by the commands that need them. */
const MANIFEST = new URL('../packages/app/src/main/update/manifest.ts', import.meta.url);
/** key.ts's line, as deploy/cle-de-signature.mjs writes it and scripts/signer-version.mjs reads it. */
const KEY_LINE = /^export const UPDATE_PUBLIC_KEY: string = '([^']*)';\r?$/m;
/** A version tag as the CI makes them (D6: v0.1.<n>): three numbers, without a leading zero, nine digits at most each. */
const TAG = /^v(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
/** The release's small files, with the most each may weigh (the server serves 64 KiB at most of each), and the installer's. */
const SMALL = { 'version.json': 65_536, 'version.json.sig': 1_024, 'latest.yml': 65_536 };
const MAX_INSTALLER_BYTES = 1_073_741_824;
/** Names the installer may not take in versions/: those of the small files. */
const RESERVED = new Set(Object.keys(SMALL));

const USAGE = `Usage :
  node deploy/verifier-version.mjs publication <réponse.json> <propriétaire/dépôt>
  node deploy/verifier-version.mjs verifier <dépôt> <tag> <dossier>
  node deploy/verifier-version.mjs posee <dépôt> <dossier>`;

const refuse = (message) => {
  console.error(message);
  process.exit(1);
};

/** The public key of the checkout `depot` (SPKI DER, base64); exit 3 while it is the placeholder. */
function keyOf(depot) {
  const file = join(depot, 'packages', 'app', 'src', 'main', 'update', 'key.ts');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    refuse(`${file} illisible : ${e.message}`);
  }
  const key = KEY_LINE.exec(text)?.[1];
  if (key === undefined) refuse(`${file} : la ligne UPDATE_PUBLIC_KEY est introuvable.`);
  if (key.startsWith('PLACEHOLDER')) {
    console.error(`La clé publique de ${file} est encore provisoire : aucune version n’est installée. Fais la clé de signature (node deploy/cle-de-signature.mjs), commite key.ts, puis relance installer-serveur.sh une fois la version suivante publiée.`);
    process.exit(3);
  }
  return key;
}

/** A small file of `dir`, read whole: `max` bytes at most; null when absent. */
function small(dir, name, max) {
  const path = join(dir, name);
  let size;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }
  if (size > max) refuse(`${name} pèse ${size} octets, ${max} au plus.`);
  return readFileSync(path, 'utf8');
}

/** The latest release, as GitHub's API describes it: its tag and the four files to download, checked. */
function publication(file, repo) {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) refuse(`Dépôt GitHub invalide : ${repo}.`);
  let release;
  try {
    release = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    refuse(`Réponse de GitHub illisible : ${e.message}`);
  }
  if (typeof release !== 'object' || release === null) refuse('Réponse de GitHub illisible : un objet attendu.');
  const tag = release.tag_name;
  if (typeof tag !== 'string' || !TAG.test(tag)) refuse(`La dernière version publiée porte un tag inattendu : ${JSON.stringify(tag)}.`);
  if (release.draft === true || release.prerelease === true) refuse(`${tag} est un brouillon ou une pré-version.`);
  if (!Array.isArray(release.assets)) refuse(`${tag} : la liste de ses fichiers manque.`);
  // Every file of the release comes from its own folder of github.com; curl then follows GitHub's redirection, in https only.
  const prefix = `https://github.com/${repo}/releases/download/${tag}/`;
  const found = new Map(), installers = [];
  for (const asset of release.assets) {
    const { name, browser_download_url: url, size } = asset ?? {};
    if (typeof name !== 'string' || typeof url !== 'string') refuse(`${tag} : un fichier sans nom ni adresse.`);
    if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(name) || !url.startsWith(prefix) || /[\s\p{Cc}]/u.test(url)) refuse(`${tag} : le fichier ${JSON.stringify(name)} a un nom ou une adresse inattendus.`);
    if (!Number.isSafeInteger(size) || size <= 0) refuse(`${tag} : le fichier ${name} a une taille invalide.`);
    if (Object.hasOwn(SMALL, name)) found.set(name, { url, size });
    else if (/\.exe$/i.test(name)) installers.push({ url, size });
  }
  for (const [name, max] of Object.entries(SMALL)) {
    const f = found.get(name);
    if (!f) refuse(`${tag} : ${name} manque à la version publiée.`);
    if (f.size > max) refuse(`${tag} : ${name} pèse ${f.size} octets, ${max} au plus.`);
  }
  if (installers.length !== 1) refuse(`${tag} : ${installers.length} installateurs (.exe) au lieu d’un.`);
  if (installers[0].size > MAX_INSTALLER_BYTES) refuse(`${tag} : l’installateur pèse ${installers[0].size} octets, ${MAX_INSTALLER_BYTES} au plus.`);
  const lines = [`tag\t${tag}`, ...[...found].map(([name, f]) => `${name}\t${f.url}\t${f.size}`), `installateur\t${installers[0].url}\t${installers[0].size}`];
  console.log(lines.join('\n'));
}

/** The release downloaded into `dir`, checked against the key of the checkout `depot`; prints the installer's name. */
async function verifier(depot, tag, dir) {
  if (!TAG.test(tag)) refuse(`Tag invalide : ${tag}.`);
  const key = keyOf(depot);
  const { verifyManifest, checkInstaller } = await import(MANIFEST.href);
  const json = small(dir, 'version.json', SMALL['version.json']);
  const sig = small(dir, 'version.json.sig', SMALL['version.json.sig']);
  if (json === null || sig === null) refuse('version.json ou sa signature manque.');
  const m = verifyManifest(json, sig, key);
  if (m === null) refuse(`${tag} : la signature de version.json ne tient pas avec la clé du code en place (ou le manifeste est abîmé) : rien n’est installé.`);
  if (`v${m.version}` !== tag) refuse(`${tag} : le manifeste signé est celui de la version ${m.version} : rien n’est installé.`);
  if (!/\.exe$/i.test(m.file) || RESERVED.has(m.file)) refuse(`${tag} : le manifeste nomme un installateur inattendu (${m.file}) : rien n’est installé.`);
  if (!(await checkInstaller(join(dir, 'installateur'), m))) refuse(`${tag} : l’installateur téléchargé n’est pas celui du manifeste signé (taille ou empreinte sha512) : rien n’est installé.`);
  console.log(m.file);
}

/** The version of the manifest placed in `dir`, its signature holding with the key of `depot`; nothing otherwise. */
async function posee(depot, dir) {
  const key = keyOf(depot);
  const { verifyManifest } = await import(MANIFEST.href);
  const json = small(dir, 'version.json', SMALL['version.json']);
  const sig = small(dir, 'version.json.sig', SMALL['version.json.sig']);
  if (json === null || sig === null) return;
  const m = verifyManifest(json, sig, key);
  if (m !== null) console.log(m.version);
}

const [command, ...args] = process.argv.slice(2);
if (command === 'publication' && args.length === 2) publication(args[0], args[1]);
else if (command === 'verifier' && args.length === 3) await verifier(args[0], args[1], args[2]);
else if (command === 'posee' && args.length === 2) await posee(args[0], args[1]);
else {
  console.error(USAGE);
  process.exit(2);
}
