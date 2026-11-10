import { homedir } from 'node:os';
import { posix, resolve, win32 } from 'node:path';
import { hostName } from './server.ts';

// The command line's arguments (plan 5a, plan 9; main.ts runs them): its commands, its options, the data's folder and
// the names the server answers to. What it reads of the system is injected (System), so that its tests run anywhere.

export const USAGE = `Usage :
  npm run serveur -w packages/server -- [--data <dossier>] [--port 7310] [--nom <domaine>]    démarre le serveur
  npm run serveur -w packages/server -- jumeler "<nom>" [--data <dossier>] [--nom <domaine>]  affiche un code pour jumeler un PC
  npm run serveur -w packages/server -- pcs [--data <dossier>]                                liste les PC jumelés et les codes en attente
  npm run serveur -w packages/server -- revoquer "<nom>" [--data <dossier>]                   retire un PC
--nom, répétable : un nom de domaine auquel le serveur répond derrière Caddy (sinon la variable CIRRUS_NOM) ;
jumeler donne alors l’adresse de la page de téléchargement.
Le dossier des données par défaut : %LOCALAPPDATA%\\Cirrus\\serveur sous Windows ; /var/lib/cirrus pour root,
sinon $XDG_DATA_HOME/cirrus ou ~/.local/share/cirrus ailleurs.`;

const DEFAULT_PORT = 7310;

/** `names`: the names the server answers to besides this machine's (--nom, or CIRRUS_NOM), lower-cased; the first is the download page's. */
export interface Args { command: 'serve' | 'jumeler' | 'pcs' | 'revoquer'; name: string | null; dataDir: string; port: number; names: string[] }

export class UsageError extends Error {}

/** What the command line reads of the system it runs on: the process's own, a test's. `uid`: null where there is none (Windows). */
export interface System { platform: NodeJS.Platform; env: Record<string, string | undefined>; uid: number | null; home: string; cwd: string }

export const system = (): System => ({ platform: process.platform, env: process.env, uid: process.getuid?.() ?? null, home: homedir(), cwd: process.cwd() });

/**
 * The data's folder when --data is not given (plan 9, D2): %LOCALAPPDATA%\Cirrus\serveur under Windows; elsewhere
 * /var/lib/cirrus for root (a server's data, as on the rented machine), otherwise the user's data folder of the XDG
 * specification ($XDG_DATA_HOME, absolute, or ~/.local/share), its `cirrus`.
 */
export function defaultDataDir(sys: System): string {
  if (sys.platform === 'win32') {
    const local = sys.env.LOCALAPPDATA;
    if (!local) throw new UsageError('LOCALAPPDATA n’est pas défini : indique le dossier des données (--data).');
    return win32.join(local, 'Cirrus', 'serveur');
  }
  if (sys.uid === 0) return '/var/lib/cirrus';
  const xdg = sys.env.XDG_DATA_HOME;
  if (xdg && posix.isAbsolute(xdg)) return posix.join(xdg, 'cirrus');
  if (!sys.home) throw new UsageError('Aucun dossier personnel connu : indique le dossier des données (--data).');
  return posix.join(sys.home, '.local', 'share', 'cirrus');
}

export function parse(argv: string[], sys: System = system()): Args {
  const words: string[] = [], names: string[] = [];
  let data: string | null = null, port = DEFAULT_PORT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data' || a === '--port' || a === '--nom') {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${a} attend une valeur.`);
      if (a === '--data') data = v;
      else if (a === '--nom') {
        const name = hostName(v);
        if (name === null) throw new UsageError(`--nom attend un nom de domaine seul, sans https://, chemin ni port : ${v}.`);
        names.push(name);
      } else {
        port = /^\d{1,5}$/.test(v) ? Number(v) : Number.NaN;
        if (!(port >= 0 && port <= 65535)) throw new UsageError(`Port invalide : ${v}.`);
      }
    } else if (a.startsWith('--')) {
      throw new UsageError(`Option inconnue : ${a}.`);
    } else {
      words.push(a);
    }
  }
  const [command = 'serve', name = null, ...rest] = words;
  if (!['serve', 'jumeler', 'pcs', 'revoquer'].includes(command)) throw new UsageError(`Commande inconnue : ${command}.`);
  const wantsName = command === 'jumeler' || command === 'revoquer';
  if (rest.length > 0 || (wantsName ? name === null : name !== null)) throw new UsageError(wantsName ? `${command} attend un nom, entre guillemets s’il a des espaces.` : `${command} n’attend pas d’argument.`);
  // Without --nom, the machine's own setting (the rented machine's service and its SSH commands share it).
  const fromEnv = sys.env.CIRRUS_NOM;
  if (names.length === 0 && fromEnv) {
    const n = hostName(fromEnv);
    if (n === null) throw new UsageError(`CIRRUS_NOM n’est pas un nom de domaine seul (sans https://, chemin ni port) : ${fromEnv}.`);
    names.push(n);
  }
  // npm runs the script in packages/server: a relative folder is the caller's.
  const base = sys.env.INIT_CWD ?? sys.cwd;
  return { command: command as Args['command'], name, dataDir: data === null ? defaultDataDir(sys) : resolve(base, data), port, names };
}
