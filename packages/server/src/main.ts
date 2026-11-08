import { join, resolve } from 'node:path';
import { PAIRING_TTL_MS } from './bounds.ts';
import { startServer } from './server.ts';
import { Tokens } from './tokens.ts';

// The command line (plan 5a): `npm run serveur -w packages/server -- [--data <dossier>] [--port 7310]` starts the
// server; `jumeler "<nom>"`, `pcs` and `revoquer "<nom>"` manage the paired PCs, the server running or not (serveur.db
// is in WAL: they write it beside the server).

const USAGE = `Usage :
  npm run serveur -w packages/server -- [--data <dossier>] [--port 7310]   démarre le serveur
  npm run serveur -w packages/server -- jumeler "<nom>" [--data <dossier>]  affiche un code pour jumeler un PC
  npm run serveur -w packages/server -- pcs [--data <dossier>]              liste les PC jumelés et les codes en attente
  npm run serveur -w packages/server -- revoquer "<nom>" [--data <dossier>] retire un PC`;

const DEFAULT_PORT = 7310;

interface Args { command: 'serve' | 'jumeler' | 'pcs' | 'revoquer'; name: string | null; dataDir: string; port: number }

class UsageError extends Error {}

function parse(argv: string[]): Args {
  const words: string[] = [];
  let data: string | null = null, port = DEFAULT_PORT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data' || a === '--port') {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${a} attend une valeur.`);
      if (a === '--data') data = v;
      else {
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
  // npm runs the script in packages/server: a relative folder is the caller's.
  const base = process.env.INIT_CWD ?? process.cwd();
  const local = process.env.LOCALAPPDATA;
  if (data === null && !local) throw new UsageError('LOCALAPPDATA n’est pas défini : indique le dossier des données (--data).');
  return { command: command as Args['command'], name, dataDir: data === null ? join(local!, 'Cirrus', 'serveur') : resolve(base, data), port };
}

const when = (ms: number) => new Date(ms).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

/** Runs `fn` on serveur.db, closed after. */
function withTokens<T>(dataDir: string, fn: (t: Tokens) => T): T {
  const tokens = Tokens.open(dataDir);
  try {
    return fn(tokens);
  } finally {
    tokens.close();
  }
}

async function serve(args: Args): Promise<void> {
  const server = await startServer({ dataDir: args.dataDir, port: args.port });
  console.log(`Serveur Cirrus : ${server.url} (données : ${args.dataDir}). Ctrl+C pour l’arrêter.`);
  let stopping = false;
  const stop = () => {
    // A second Ctrl+C does not wait.
    if (stopping) process.exit(1);
    stopping = true;
    server.close().then(() => {
      console.log('Serveur arrêté.');
      process.exit(0);
    }, (e: unknown) => {
      console.error(`Arrêt du serveur : ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(signal, stop);
}

function main(): Promise<void> | void {
  const args = parse(process.argv.slice(2));
  switch (args.command) {
    case 'serve':
      return serve(args);
    case 'jumeler': {
      const { code, expiresAt } = withTokens(args.dataDir, (t) => t.createCode(args.name!, Date.now()));
      console.log(`Code de jumelage pour « ${args.name!.trim()} » : ${code}`);
      console.log(`Valable ${PAIRING_TTL_MS / 60_000} minutes (jusqu’au ${when(expiresAt)}), pour un seul PC. Dans Cirrus : Réglages › Serveur.`);
      return;
    }
    case 'pcs': {
      const { pcs, codes } = withTokens(args.dataDir, (t) => ({ pcs: t.pcs(), codes: t.codes() }));
      if (pcs.length === 0) console.log('Aucun PC jumelé.');
      else console.log(['PC jumelés :', ...pcs.map((p) => `  ${p.name} — ${p.machine}, jumelé le ${when(p.pairedAt)} (identifiant ${p.id})`)].join('\n'));
      const now = Date.now();
      if (codes.length > 0) console.log(['Codes en attente :', ...codes.map((c) => `  ${c.name} — ${c.expiresAt > now ? `jusqu’au ${when(c.expiresAt)}` : 'expiré'}`)].join('\n'));
      return;
    }
    case 'revoquer': {
      if (!withTokens(args.dataDir, (t) => t.revoke(args.name!))) {
        console.error(`Aucun PC jumelé ni code en attente ne s’appelle « ${args.name} ».`);
        process.exitCode = 1;
        return;
      }
      console.log(`« ${args.name!.trim()} » est retiré : son jeton ne vaut plus rien.`);
      return;
    }
  }
}

try {
  await main();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  if (e instanceof UsageError) console.error(USAGE);
  process.exitCode = e instanceof UsageError ? 2 : 1;
}
