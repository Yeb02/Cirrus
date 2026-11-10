import type { OutgoingHttpHeaders } from 'node:http';
import type { UpdateWord } from '../sync/protocol.ts';
import { checkInstaller, compareVersions, type Manifest, parseVersion, usableKey, verifyManifest } from './manifest.ts';

// The signed updates in the app (plan 9, D4; Review Focus 2): a compromised server must never install code on a PC.
// 1. Looked for at each hello that says a newer official version than this app's, at a hello refused for its format
//    (409), and every updateCheckMs while connected.
// 2. version.json and its signature asked of the server with this PC's token; the signature checked with the key the app
//    carries (key.ts), the manifest's version newer than this app's — never a downgrade, never « Cirrus Dev », never a
//    pre-release (spec 18.1).
// 3. electron-updater then downloads the installer from the server's versions/ (its generic provider, the token in a
//    header, the whole file: its own sha512 check of latest.yml stays a second layer), never installing by itself.
// 4. The file downloaded checked against the signed manifest's sha512 and size; only then is the install armed, for the
//    app's quit, silently (`--updated /S`), the app not started again: the chip says so.
// A refusal — a signature that does not match, an installer that is not the one signed — installs nothing, and is said
// once a session: one console warning, one notification. Nothing of Electron here: the tests drive it (wire.ts binds it).

/** The notification of a refused update (D4), once a session. */
export const REFUSED = 'Mise à jour refusée : sa signature ne correspond pas.';

/** The most bytes version.json or its signature may have: a server that sends more is not read further. */
const MAX_MANIFEST_BYTES = 64 * 1024;

/** The shortest pause between two periodic checks, whatever updateCheckMs says (its own floor is 300 000). */
const MIN_CHECK_MS = 60_000;

/** What electron-updater says once it has downloaded an update: the version latest.yml gave, the file it kept. */
export interface Downloaded { version: string; downloadedFile: string }

/** electron-updater's autoUpdater (NsisUpdater), as much of it as the updater drives. */
export interface FeedUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  disableDifferentialDownload: boolean;
  disableWebInstaller: boolean;
  allowDowngrade: boolean;
  requestHeaders: OutgoingHttpHeaders | null;
  setFeedURL(options: { provider: 'generic'; url: string }): void;
  checkForUpdates(): Promise<{ downloadPromise?: Promise<unknown> | null } | null>;
  install(isSilent?: boolean, isForceRunAfter?: boolean): boolean;
  on(event: 'update-downloaded', listener: (e: Downloaded) => void): unknown;
}

export interface UpdaterDeps {
  /** This app's version (app.getVersion()), and whether it is « Cirrus Dev » (identity.ts): such a build never updates. */
  version: string;
  dev: boolean;
  /** The key the manifests are checked with (key.ts: updateKeyOf). */
  publicKey: string;
  /** A file of the server's versions/ (version.json, version.json.sig), asked with this PC's token; null without a server. */
  fetchFile(name: string): Promise<Response | null>;
  /** The server paired and this PC's token, electron-updater's feed; null without one. */
  server(): { url: string; token: string } | null;
  /** Whether a connection to the server is open: the periodic check runs only then. */
  connected(): boolean;
  params(): { updateCheckMs: number };
  /** electron-updater's autoUpdater, loaded the first time an update is to be downloaded. */
  updater(): FeedUpdater | Promise<FeedUpdater>;
  /** The chip and the notification (SyncHost.updateWord). */
  tell(word: UpdateWord): void;
  /** The console's warnings: console.warn by default. */
  warn?(text: string): void;
  /** The installer's check against the manifest: checkInstaller by default. */
  checkInstaller?(path: string, m: Manifest): Promise<boolean>;
  /**
   * The end-to-end check (key.ts: devUpdatesOf): armed, but never installed — not even at a quit by accident (the
   * check's driver gone, the system shutting down): an installer run there would put a version on this machine, and
   * start it on the user's own folders.
   */
  neverInstall?: boolean;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A response's body as text, `max` bytes at most; null past them (the rest not read). */
async function boundedText(res: Response, max: number): Promise<string | null> {
  if (!res.body) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class Updater {
  private readonly deps: UpdaterDeps;
  /** The check under way: a trigger meanwhile shares it. */
  private running: Promise<void> | null = null;
  /** The installer downloaded and checked: installed at the app's quit. */
  private armed = false;
  /** The manifest whose installer electron-updater is downloading, and its text. */
  private manifest: { m: Manifest; text: string } | null = null;
  /** The text of a manifest whose installer was refused: not downloaded again this session. */
  private refusedText: string | null = null;
  /** The installer's check under way, once electron-updater has downloaded it. */
  private verifying: Promise<void> | null = null;
  private feed: FeedUpdater | null = null;
  private refusalSaid = false;
  private keySaid = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(deps: UpdaterDeps) {
    this.deps = deps;
    this.schedule();
  }

  /** A hello's official version (null: the server publishes none): looked for when newer than this app's. */
  heard(version: string | null): Promise<void> {
    if (version === null || !(compareVersions(version, this.deps.version) > 0)) return Promise.resolve();
    return this.check();
  }

  /** A hello refused for its format (409): this app is older than the server's data, its update is looked for. */
  formatRefused(): Promise<void> {
    return this.check();
  }

  /** The update looked for, one check at a time; never rejects (a failure is said in the console). */
  check(): Promise<void> {
    this.running ??= this.run()
      .catch((e: unknown) => this.warn(`Mise à jour non cherchée : ${messageOf(e)}`))
      .finally(() => { this.running = null; });
    return this.running;
  }

  /** The app quits (Electron's « quit », its exit code): armed, and quitting without error, the installer runs, silently. */
  quit(exitCode: number): void {
    const feed = this.feed;
    if (!this.armed || exitCode !== 0 || !feed?.autoInstallOnAppQuit) return;
    if (this.deps.neverInstall) {
      this.warn('Mise à jour : essai de bout en bout, l’installateur n’est pas lancé.');
      return;
    }
    feed.install(true, false);
  }

  /**
   * Not installed at this quit (the app starts again on a base taken from the server, D7: an installer running then would
   * close the app it starts). The next session finds it again, its download kept by electron-updater.
   */
  disarm(): void {
    this.armed = false;
    if (this.feed) this.feed.autoInstallOnAppQuit = false;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Whether this build may update at all: neither « Cirrus Dev » nor a pre-release (spec 18.1). */
  private allowed(): boolean {
    return !this.deps.dev && parseVersion(this.deps.version) !== null;
  }

  private warn(text: string): void {
    (this.deps.warn ?? console.warn)(text);
  }

  /** Every updateCheckMs (read each time: a change applies at the next), a check while connected. */
  private schedule(): void {
    if (this.disposed) return;
    const every = this.deps.params().updateCheckMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.deps.connected()) void this.check();
      this.schedule();
    }, Number.isFinite(every) ? Math.max(MIN_CHECK_MS, every) : MIN_CHECK_MS);
  }

  private async run(): Promise<void> {
    if (this.disposed || this.armed || !this.allowed()) return;
    if (!usableKey(this.deps.publicKey)) {
      if (!this.keySaid) this.warn('Mise à jour : cette version de Cirrus ne porte aucune clé de signature (update/key.ts) ; aucune mise à jour ne s’installe.');
      this.keySaid = true;
      return;
    }
    const server = this.deps.server();
    if (!server) return;
    const text = await this.file('version.json');
    const sig = text === null ? null : await this.file('version.json.sig');
    if (text === null || sig === null) return;
    const m = verifyManifest(text, sig, this.deps.publicKey);
    if (!m) return this.refuse('la signature de version.json ne correspond pas à la clé de Cirrus');
    // Signed, but not newer: a server that says a newer version than it serves, an old manifest served again. Nothing.
    if (!(compareVersions(m.version, this.deps.version) > 0) || text === this.refusedText) return;
    const feed = await this.feedOf();
    this.manifest = { m, text };
    feed.autoInstallOnAppQuit = false;
    feed.autoDownload = true;
    feed.disableDifferentialDownload = true;
    feed.disableWebInstaller = true;
    feed.allowDowngrade = false;
    feed.requestHeaders = { Authorization: `Bearer ${server.token}` };
    feed.setFeedURL({ provider: 'generic', url: `${server.url}/versions/` });
    const found = await feed.checkForUpdates();
    await found?.downloadPromise;
    await this.verifying;
  }

  /** A file of the server's versions/, its text; null when it has none (nothing published), or sends too much. */
  private async file(name: string): Promise<string | null> {
    const res = await this.deps.fetchFile(name);
    if (!res) return null;
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const text = await boundedText(res, MAX_MANIFEST_BYTES);
    if (text === null) this.warn(`Mise à jour : ${name} du serveur dépasse ${MAX_MANIFEST_BYTES} octets ; non lu.`);
    return text;
  }

  /** electron-updater, loaded once, its download heard. */
  private async feedOf(): Promise<FeedUpdater> {
    if (this.feed) return this.feed;
    const feed = await this.deps.updater();
    if (this.feed) return this.feed;
    feed.on('update-downloaded', (e) => this.downloaded(feed, e));
    this.feed = feed;
    return feed;
  }

  /**
   * electron-updater has downloaded an installer: not armed while it is checked — electron-updater adds its own quit
   * handler right after this event only when autoInstallOnAppQuit is set, which it never is here — then armed only if
   * it is the signed manifest's version, its sha512 and its size.
   */
  private downloaded(feed: FeedUpdater, e: Downloaded): void {
    feed.autoInstallOnAppQuit = false;
    const signed = this.manifest;
    if (!signed) return;
    this.verifying = (async () => {
      const ok = e.version === signed.m.version && await (this.deps.checkInstaller ?? checkInstaller)(e.downloadedFile, signed.m);
      if (!ok) {
        this.refusedText = signed.text;
        this.refuse(`l’installateur téléchargé (${e.version}) n’a pas l’empreinte ni la taille du manifeste signé (${signed.m.version})`);
        return;
      }
      this.armed = true;
      feed.autoInstallOnAppQuit = true;
      this.deps.tell({ updateReady: true });
    })().catch((err: unknown) => this.warn(`Mise à jour : installateur non vérifié (${messageOf(err)}) ; rien n’est installé.`));
  }

  /** Nothing installed; said once a session, in the console and by a notification. */
  private refuse(why: string): void {
    if (this.refusalSaid) return;
    this.refusalSaid = true;
    this.warn(`Mise à jour refusée : ${why}. Rien n’est installé.`);
    this.deps.tell({ updateRefused: REFUSED });
  }
}
