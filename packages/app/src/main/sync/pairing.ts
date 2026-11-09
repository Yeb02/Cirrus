import { isObject } from '@cirrus/core';
import type { SharedSettings } from '../settings.ts';
import { adoptBase } from './adopt.ts';
import { pair, type ServerConfig, serverUrl } from './config.ts';
import { FORMAT } from './connection.ts';
import { firstSyncOffer, isBaseId, messageOf, offerMessage, pristine, revokeSelf, sentence, stagedDir } from './firstSync.ts';
import type { HostDeps } from './host.ts';
import type { FirstSyncOffer, PairResult, ServerInfo } from './protocol.ts';
import { seedBase } from './seed.ts';
import { stagedWaiting, waitingMessage } from './swap.ts';

// This PC's pairing (plan 5a, D3), as SyncHost runs it, one step at a time: the server paired (serveur.json), a
// pairing and its first sync (task 5, D7: firstSync.ts, seed.ts, adopt.ts), the unpairing's revocation (R15), and what
// the block « Serveur » shows of them (info, told to the window at each change).

/** A first sync that did not happen: this PC unpaired (its token revoked, R15), its base as it was. */
const UNTOUCHED = 'Ce PC n’est pas jumelé, et sa base reste telle quelle.';

/** The hosts a server without HTTPS may have (R10): this machine's. */
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** R10: an http: address that leaves this machine, where the pairing code and the token would travel in clear. */
export function insecureServer(url: string): boolean {
  const u = new URL(url);
  return u.protocol === 'http:' && !LOOPBACK.has(u.hostname.toLowerCase());
}

export class Pairing {
  /** The server paired now (serveur.json read, its token opened); null: none. */
  private config: ServerConfig | null;
  private readonly deps: HostDeps;
  /** This PC's settings: stamped with the pairing's time once paired (R23). */
  private readonly settings: SharedSettings;
  /** Cirrus quits (close): nothing of a pairing begins any more. */
  private closed = false;
  /**
   * A pairing done (/pair, /hello) that awaits the user's answer to D7's offer (`first`): its server and token, in
   * memory only — nothing is written, nothing starts, until the base's first sync is settled (R8).
   */
  private offered: { config: ServerConfig; offer: FirstSyncOffer; at: number; baseId: string } | null = null;
  /** The first sync under way (seed, adopt): aborted if the app quits meanwhile. */
  private firstSync: AbortController | null = null;
  /** The first sync under way, for the block (info): its server, and what it does (review of task 5, Minor 3). */
  private working: { config: ServerConfig; busy: string } | null = null;
  /**
   * The server whose base was taken in this run (D7): the app restarts on it, and the block says only that — not the
   * base waiting beside this one as if its swap had failed (short review after plan 5a, B2).
   */
  private restarting: ServerConfig | null = null;

  constructor(deps: HostDeps, settings: SharedSettings, config: ServerConfig | null) {
    this.deps = deps;
    this.settings = settings;
    this.config = config;
  }

  /** Whether a server is paired (serveur.json read, its token opened). */
  paired(): boolean {
    return this.config !== null;
  }

  /** What the block « Serveur » shows: the server paired; otherwise a restart, a first sync under way, an offer, or none. */
  info(): ServerInfo {
    if (this.config) return { paired: true, url: this.config.url, name: this.config.name };
    const r = this.restarting;
    if (r) return { paired: false, url: r.url, name: r.name, busy: 'Base du serveur prise : Cirrus redémarre sur elle.' };
    const waiting = stagedWaiting(this.deps.dir) ? { waiting: waitingMessage(this.deps.dir) } : {};
    const w = this.working, o = this.offered;
    if (w) return { paired: false, url: w.config.url, name: w.config.name, busy: w.busy, ...waiting };
    if (o) return { paired: false, url: o.config.url, name: o.config.name, offer: { message: offerMessage(o.offer), offer: o.offer }, ...waiting };
    return { paired: false, url: '', name: this.deps.machineName, ...waiting };
  }

  /** The block's information told to the window: after each change of the pairing (B2). */
  tell(): void {
    this.deps.window.server(this.info());
  }

  /**
   * Pairs this PC (D3), the code `jumeler` showed traded for a token. Refused, in French, before anything is asked of
   * the server: without encryption (no token in clear), an http: address off this machine (R10), without a code or a
   * name. Then /pair and /hello, which tells the server's base (its identity too, R31) and format (D10). The base this
   * PC follows already, paired again: at once, no offer (R31). Otherwise D7 decides: both empty, paired at once — the
   * token kept encrypted in serveur.json, the interface then takes its pending writes and starts the sync (start), and
   * this PC's lobby becomes the server's first write —; a vierge base (pristine) and a server holding one, the server's
   * taken at once, without an offer, then the app restarts on it (adopt: after the short review of plan 5a,
   * 2026-11-09); otherwise the offer (`first` answers it). A refusal after /pair revokes the token (R15): nothing is
   * kept.
   */
  async pairNow(url: unknown, code: unknown, name: unknown): Promise<PairResult> {
    const no = (message: string): PairResult => ({ ok: false, message });
    if (this.closed) return no('Cirrus se ferme.');
    if (this.config) return no('Ce PC est déjà jumelé à un serveur : dissocie-le d’abord.');
    if (!this.deps.canEncrypt()) return no('Windows ne peut pas chiffrer le jeton de ce PC ici : jumelage refusé, aucun jeton n’est gardé en clair.');
    let base: string;
    try {
      base = serverUrl(typeof url === 'string' ? url : '');
    } catch (e) {
      return no(messageOf(e));
    }
    if (insecureServer(base)) return no('Adresse refusée : sans HTTPS, seul un serveur de cette machine (127.0.0.1, localhost ou ::1) peut être jumelé, pour que le code et le jeton ne passent jamais en clair sur le réseau.');
    const typedCode = typeof code === 'string' ? code.trim() : '', typedName = typeof name === 'string' ? name.trim() : '';
    if (typedCode === '') return no('Donne le code de jumelage affiché par le serveur.');
    if (typedName === '') return no('Donne un nom à ce PC.');
    // An offer left unanswered (a page reloaded meanwhile): given up, its token revoked.
    await this.giveUp();
    // Each request within syncConnectTimeoutMs: a server that never answers holds neither the block nor the quit.
    const ms = this.deps.params().syncConnectTimeoutMs;
    const bounded: typeof fetch = (input, init) => this.deps.fetch(input, { ...init, signal: AbortSignal.timeout(ms) });
    let config: ServerConfig;
    try {
      config = await pair(bounded, base, typedCode, this.deps.pc, typedName);
    } catch (e) {
      return no(messageOf(e));
    }
    // Refused from here: the token just given revoked (R15), so that the PC is not left registered.
    const refuse = async (message: string): Promise<PairResult> => {
      await revokeSelf(this.deps.fetch, config, ms);
      return no(message);
    };
    // The server's base (D7) and format (D10), which only a token may ask.
    let hello: unknown;
    try {
      const res = await bounded(`${config.url}/hello`, { headers: { ...FORMAT, Authorization: `Bearer ${config.token}` } });
      hello = await res.json().catch(() => null);
      if (!res.ok) return refuse(isObject(hello) && typeof hello.error === 'string' ? hello.error : `Réponse ${res.status} du serveur.`);
    } catch (e) {
      return refuse(`Serveur injoignable (${config.url}) : ${messageOf(e)}.`);
    }
    if (
      !isObject(hello) || typeof hello.empty !== 'boolean' || !Number.isSafeInteger(hello.lastSeq) || !Number.isSafeInteger(hello.nodes)
      || typeof hello.serverTime !== 'number' || !Number.isFinite(hello.serverTime)
      || !isBaseId(hello.baseId)
    ) {
      return refuse('Réponse du serveur illisible à /hello : mets à jour Cirrus, ou le serveur.');
    }
    const server = { lastSeq: hello.lastSeq as number, empty: hello.empty, nodes: hello.nodes as number }, baseId = hello.baseId;
    // A seed this PC sent, which the server took, its done's answer lost (the app quit, the network failed: short
    // review after plan 5a, B1): the server's base has the identity it gave that seed at its start. Its lines numbered
    // now, as the answer would have done, and its settings stamped at that pairing's time (R23): then it rejoins.
    const seed = this.deps.store.pendingSeed();
    const seeded = seed !== null && seed.id === baseId && seed.last <= server.lastSeq;
    if (seeded) this.deps.store.numberSeeded(seed.last, seed.id);
    // R31: the base this PC follows, its token lost since (dissociated, revoked, serveur.db reset), the server holding
    // every line this PC received: paired again at once, no offer — the sync picks up where it stopped, and the writes
    // made meanwhile go as any pending write. Its settings are not stamped again: the server's, newer maybe, stay.
    if (this.deps.store.baseId() === baseId && this.deps.store.lastServerSeq() <= server.lastSeq) {
      this.joined(config, seeded ? seed.at : null, null);
      return { ok: true };
    }
    const offer = firstSyncOffer(this.deps.store, this.deps.dir, server, new Date(this.deps.now()));
    // A vierge base holds nothing of the user's, nothing to keep nor ask: it takes the server's at once, as « adopt ».
    if (offer?.kind === 'adopt' && pristine(this.deps.store, this.deps.dir)) return this.adopt(config, baseId);
    // The pairing's time, the server's: this PC's settings are stamped with it when they are sent (R23).
    const at = Math.round(hello.serverTime);
    if (offer) {
      this.offered = { config, offer, at, baseId };
      return { ok: false, message: offerMessage(offer), offer };
    }
    this.joined(config, at, baseId);
    return { ok: true };
  }

  /**
   * Paired, the first sync settled (R8): this PC's settings wait, stamped `at`, the pairing's time (R23: two empty
   * bases, or this PC's sent — a seed whose done's answer was lost too, at its own pairing's time, B1; null for a
   * rejoin, R31: nothing stamped); the server's base identity kept, `baseId` (two empty bases; a seed keeps the one the
   * server gave it with the numbers, numberSeeded; null: kept already) — both before
   * serveur.json: a stop between leaves them for no server, and the next pairing writes them again —, then the server.
   * A seed still pending is dropped (numbered already when this join settles it): the base now follows this server,
   * and pairing the seed's server again later must not renumber it (re-review of the fixes, N1).
   */
  private joined(config: ServerConfig, at: number | null, baseId: string | null): void {
    if (at !== null) this.settings.pairedAt(at);
    if (baseId !== null) this.deps.store.setBaseId(baseId);
    this.deps.store.setPendingSeed(null);
    this.deps.secrets.write(config);
    this.config = config;
  }

  /** An offer left unanswered given up: its token revoked, at best (R15). */
  private async giveUp(): Promise<void> {
    const left = this.offered;
    this.offered = null;
    if (left) await revokeSelf(this.deps.fetch, left.config, this.deps.params().syncConnectTimeoutMs);
  }

  /**
   * The user's answer to D7's offer (the block « Serveur »):
   * - « seed », to a server that holds no base: this PC's sent (seedBase), its lines numbered, then paired — the
   *   interface takes its pending writes (those made meanwhile) and starts the sync;
   * - « adopt », to a server that holds one (this PC's base empty but used, or to be replaced): taken (adopt);
   * - « cancel », or a choice not offered: given up.
   * Any failure, and a cancel, revoke the token (R15): this PC stays unpaired, its base as it was.
   */
  async firstNow(choice: unknown): Promise<PairResult> {
    const no = (message: string): PairResult => ({ ok: false, message });
    const offered = this.offered;
    if (!offered) return no('Aucun jumelage n’attend de réponse.');
    this.offered = null;
    const { config, offer, at, baseId } = offered, { deps } = this;
    const revoke = () => revokeSelf(deps.fetch, config, deps.params().syncConnectTimeoutMs);
    if (choice === 'cancel') {
      await revoke();
      return no('Jumelage annulé : ce PC n’est pas jumelé.');
    }
    if (this.closed || !(choice === 'seed' ? offer.kind === 'seed' : choice === 'adopt' && offer.kind !== 'seed')) {
      await revoke();
      return no('Ce choix n’est pas proposé : jumelage annulé, ce PC n’est pas jumelé.');
    }
    if (choice === 'adopt') return this.adopt(config, baseId);
    const abort = (this.firstSync = new AbortController());
    this.working = { config, busy: 'Envoi de la base au serveur…' };
    this.tell();
    try {
      try {
        await seedBase({ fetch: deps.fetch, store: deps.store, dir: deps.dir, config, pairedAt: at, signal: abort.signal });
      } catch (e) {
        if (!this.closed) await revoke();
        return no(`Base non envoyée : ${sentence(messageOf(e))} ${UNTOUCHED}`);
      }
      this.joined(config, at, null);
      return { ok: true };
    } finally {
      this.firstSync = null;
      this.working = null;
    }
  }

  /**
   * Takes the server's base (D7): staged beside this one (adoptBase), then the app starts again on it (relaunch),
   * paired; this base is never touched here. The answer « adopt » to the offer (firstNow), or at once for a vierge base
   * (pairNow), inside their step. The block says the download meanwhile (`working`). A failure revokes the token (R15):
   * this PC stays unpaired, its base as it was; the app quitting meanwhile gives it up, as an offer left unanswered.
   */
  private async adopt(config: ServerConfig, baseId: string): Promise<PairResult> {
    const { deps } = this;
    if (this.closed) return { ok: false, message: 'Cirrus se ferme.' };
    const abort = (this.firstSync = new AbortController());
    this.working = { config, busy: 'Téléchargement de la base du serveur…' };
    this.tell();
    try {
      try {
        await adoptBase({ fetch: deps.fetch, dir: deps.dir, pc: deps.pc, config, baseId, secrets: deps.secretsAt(stagedDir(deps.dir)), signal: abort.signal });
      } catch (e) {
        if (!this.closed) await revokeSelf(deps.fetch, config, deps.params().syncConnectTimeoutMs);
        return { ok: false, message: `Base du serveur non prise : ${sentence(messageOf(e))} ${UNTOUCHED}` };
      }
      this.restarting = config;
      deps.relaunch();
      return { ok: true, restarting: true };
    } finally {
      this.firstSync = null;
      this.working = null;
    }
  }

  /** Unpaired: serveur.json removed, then its token revoked by itself at the server (R15, at best, within syncConnectTimeoutMs). */
  async unpair(): Promise<void> {
    const config = this.config;
    this.deps.secrets.write(null);
    this.config = null;
    if (config) await revokeSelf(this.deps.fetch, config, this.deps.params().syncConnectTimeoutMs);
  }

  /** Quitting: an offer left unanswered given up, a first sync under way aborted, none begun after. */
  close(): void {
    this.closed = true;
    this.offered = null;
    this.firstSync?.abort();
  }
}
