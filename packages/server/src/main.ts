import { PAIRING_TTL_MS } from './bounds.ts';
import { type Args, parse, USAGE, UsageError } from './cli.ts';
import { startServer } from './server.ts';
import { Tokens } from './tokens.ts';

// The command line (plan 5a): `npm run serveur -w packages/server -- [--data <dossier>] [--port 7310] [--nom <domaine>]`
// starts the server; `jumeler "<nom>"`, `pcs` and `revoquer "<nom>"` manage the paired PCs, the server running or not
// (serveur.db is in WAL: they write it beside the server), over SSH on the rented machine (plan 9, D2). Its arguments:
// cli.ts.

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
  const server = await startServer({ dataDir: args.dataDir, port: args.port, names: args.names });
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
      // A PC without Cirrus yet gets it there, by the same code (plan 9, D5).
      if (args.names.length > 0) console.log(`Page de téléchargement : https://${args.names[0]}/installer`);
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
