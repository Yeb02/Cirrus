import type { OutgoingHttpHeaders } from 'node:http';
import type { UpdateFlow, UpdateWord } from '../sync/protocol.ts';
import { checkInstaller, compareVersions, type Manifest, parseVersion, usableKey, verifyManifest } from './manifest.ts';

// The signed updates in the app (plan 9, D4; Review Focus 2): a compromised server must never install code on a PC.
// 1. Looked for at each hello that says a newer official version than this app's, at a hello refused for its format
//    (409) and then every syncRetryMaxMs until a hello passes, connected or not (final review of plan 9, I1), and every
//    updateCheckMs while connected.
// 2. version.json and its signature asked of the server with this PC's token; the signature checked with the key the app
//    carries (key.ts), the manifest's version newer than this app's — never a downgrade, never « Cirrus Dev », never a
//    pre-release (spec 18.1).
// 3. electron-updater then reads the server's latest.yml (its generic provider, the token in a header), which must name
//    the signed manifest's version and installer — its one file, its name, its sha512, its size, neither administrator
//    rights nor a web installer's packages — before anything is downloaded (review of task 4, M2); then it downloads
//    the whole file (its own sha512 check stays a second layer), never installing by itself.
// 4. The file downloaded checked against the signed manifest's sha512 and size; only then is the install armed, for the
//    app's quit, silently and the app started again after it (`--updated /S --force-run`).
// The update is forced (2026-11-11): from the moment a signed manifest of a newer version is in hand — never before its
// signature is checked: a false announcement must not block the app — the interface shows a screen that blocks it
// (UpdateFlow: the download and its progress); once armed, the window closes by its normal path (`restart`: the
// interface's last saves, cirrus:quit), and the app's quit runs the installer. A download that fails (the network) is
// said on the screen, which the user may dismiss; the next check runs it all again. The end-to-end check's key
// (neverInstall) stops at the armed installer: never closed, never installed.
// A refusal — a signature that does not match, a latest.yml or an installer that is not the one signed, a newer version
// announced but not served — installs nothing, and is said once a session: one console warning, one notification; the
// screen says it too once it is up. A disarm (the app starting again on a base taken from the server) is final for the
// session (M1): nothing armed, nothing closed. Nothing of Electron here: the tests drive it (wire.ts binds it).

/** The notification of a refused update (D4), once a session. */
export const REFUSED = 'Mise à jour refusée : sa signature ne correspond pas.';
/** The notification of a hello that announced a newer version than the server's signed manifest (review of task 4, M3). */
export const NOT_SERVED = 'Mise à jour refusée : le serveur annonce une version qu’il ne sert pas.';

/** The most bytes version.json or its signature may have: a server that sends more is not read further. */
const MAX_MANIFEST_BYTES = 64 * 1024;

/** The shortest pause between two periodic checks, whatever updateCheckMs says (its own floor is 300 000). */
const MIN_CHECK_MS = 60_000;

/** The most characters of a failure's message the screen is told (electron-updater's may carry a whole response). */
const MAX_MESSAGE_CHARS = 300;

/** What electron-updater says once it has downloaded an update: the version latest.yml gave, the file it kept. */
export interface Downloaded { version: string; downloadedFile: string }

/** A file of latest.yml, as electron-updater reads it (builder-util-runtime's UpdateFileInfo). */
export interface LatestFile { url: string; sha512: string; size?: number; isAdminRightsRequired?: boolean }
/** latest.yml, as electron-updater read it at its check (UpdateInfo): what it would download. */
export interface LatestInfo { version: string; files: LatestFile[] }

/** electron-updater's autoUpdater (NsisUpdater), as much of it as the updater drives. */
export interface FeedUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  disableDifferentialDownload: boolean;
  disableWebInstaller: boolean;
  allowDowngrade: boolean;
  requestHeaders: OutgoingHttpHeaders | null;
  setFeedURL(options: { provider: 'generic'; url: string }): void;
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: LatestInfo } | null>;
  downloadUpdate(): Promise<unknown>;
  install(isSilent?: boolean, isForceRunAfter?: boolean): boolean;
  on(event: 'update-downloaded', listener: (e: Downloaded) => void): unknown;
  /** Its progress while it downloads (said only to a listener already there when the download starts). */
  on(event: 'download-progress', listener: (p: { percent: number }) => void): unknown;
}

/**
 * Why latest.yml, as electron-updater read it, is not the signed manifest's (review of task 4, M2); null when it is: its
 * version; exactly one file, the manifest's — its name (a plain name: no other host, no other folder), its sha512, its
 * size —; neither administrator rights (an installer started through elevate.exe) nor packages (a web installer's).
 */
export function latestMismatch(info: unknown, m: Manifest): string | null {
  if (typeof info !== 'object' || info === null) return 'latest.yml illisible';
  const i = info as Record<string, unknown>;
  if (i.version !== m.version) return `latest.yml annonce la version ${String(i.version).slice(0, 40)}, le manifeste signé la ${m.version}`;
  if (i.packages != null) return 'latest.yml nomme les paquets d’un installateur web';
  if (i.isAdminRightsRequired) return 'latest.yml demande les droits d’administrateur';
  if (!Array.isArray(i.files) || i.files.length !== 1) return 'latest.yml doit nommer un seul fichier, celui du manifeste signé';
  const f = (i.files[0] ?? {}) as Record<string, unknown>;
  if (f.url !== m.file || f.sha512 !== m.sha512 || f.size !== m.size) return 'le fichier de latest.yml n’est pas l’installateur du manifeste signé (nom, empreinte ou taille)';
  if (f.isAdminRightsRequired) return 'latest.yml demande les droits d’administrateur';
  return null;
}

/** The file that keeps the version whose install was started (wire.ts: in the app's folder, userData). */
export interface TriedStore { read(): string | null; write(version: string): void; clear(): void }

export interface UpdaterDeps {
  /** This app's version (app.getVersion()), and whether it is « Cirrus Dev » (identity.ts): such a build never updates. */
  version: string;
  dev: boolean;
  /**
   * Whether the app is installed (app.isPackaged): one run unpackaged — `npm run dev` — never updates, as « Cirrus
   * Dev » (review of the forced update, I3), but under the end-to-end check's key (neverInstall), which never installs.
   */
  packaged: boolean;
  /**
   * The version whose install the app started (a file of the app's folder, kept from one session to the next: review of
   * the forced update, I2): written just before the installer runs; read at the start, cleared once the app is at that
   * version or past it. None: nothing kept.
   */
  tried?: TriedStore;
  /** The key the manifests are checked with (key.ts: updateKeyOf). */
  publicKey: string;
  /** A file of the server's versions/ (version.json, version.json.sig), asked with this PC's token; null without a server. */
  fetchFile(name: string): Promise<Response | null>;
  /** The server paired and this PC's token, electron-updater's feed; null without one. */
  server(): { url: string; token: string } | null;
  /** Whether a connection to the server is open: the periodic check runs only then. */
  connected(): boolean;
  params(): { updateCheckMs: number; syncRetryMaxMs: number };
  /** electron-updater's autoUpdater, loaded the first time an update is to be downloaded. */
  updater(): FeedUpdater | Promise<FeedUpdater>;
  /** The screen, the chip and the notification (SyncHost.updateWord): the whole word each time. */
  tell(word: UpdateWord): void;
  /**
   * The installer armed: the app's window closed by its normal path (its last saves, cirrus:quit), the app's quit then
   * running the installer (quit). Never called in the end-to-end check (neverInstall), nor once disarmed.
   */
  restart(): void;
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
  /** Disarmed (the app starts again, D7): nothing more is looked for, downloaded nor armed this session (M1). */
  private ended = false;
  /** A newer version a hello announced, not yet compared with the manifest the server serves (M3). */
  private announced: string | null = null;
  /**
   * A hello refused for its format, none passed since (final review of plan 9, I1): the server restarts on its new
   * format before it places its manifest, so a check at the 409 may still find the old one, and the client, refused, no
   * longer connects. Looked for again every syncRetryMaxMs, connected or not.
   */
  private formatPending = false;
  /** The forced update as the screen shows it; null before any signed manifest of a newer version. */
  private flow: UpdateFlow | null = null;
  /** The runs of the forced update so far: each its attempt. */
  private attempts = 0;
  /** The refusal's notification, once said: kept in every word after. */
  private notice: string | null = null;
  /** The version a former session started to install, this app still older (I2): never closed again for it. */
  private tried: string | null = null;
  /** Its unfinished install said this session: once. */
  private triedSaid = false;

  constructor(deps: UpdaterDeps) {
    this.deps = deps;
    this.tried = this.readTried();
    this.schedule();
  }

  /**
   * The version a former session started to install, if this app is still older than it; the file cleared otherwise —
   * the app at that version or past it, or a file that does not hold a version.
   */
  private readTried(): string | null {
    const store = this.deps.tried;
    if (!store || !this.allowed()) return null;
    try {
      const v = store.read()?.trim() ?? null;
      if (v === null) return null;
      if (parseVersion(v) !== null && compareVersions(v, this.deps.version) > 0) return v;
      store.clear();
    } catch (e) {
      this.warn(`Mise à jour : version tentée illisible (${messageOf(e)}).`);
    }
    return null;
  }

  /** A hello's official version (null: the server publishes none): looked for when newer than this app's. */
  heard(version: string | null): Promise<void> {
    this.formatPending = false;
    if (version === null || !(compareVersions(version, this.deps.version) > 0)) return Promise.resolve();
    this.announced = version;
    return this.check();
  }

  /** A hello refused for its format (409): this app is older than the server's data, its update is looked for. */
  formatRefused(): Promise<void> {
    if (!this.formatPending) {
      this.formatPending = true;
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      this.schedule();
    }
    return this.check();
  }

  /** The update looked for, one check at a time; never rejects (a failure is said in the console). */
  check(): Promise<void> {
    this.running ??= this.run()
      .catch((e: unknown) => this.warn(`Mise à jour non cherchée : ${messageOf(e)}`))
      .finally(() => { this.running = null; });
    return this.running;
  }

  /**
   * The app quits (Electron's « quit », its exit code): armed, and quitting without error, the installer runs, silently,
   * and starts the app again once done (D4) — whether restart closed the window or the user did.
   */
  quit(exitCode: number): void {
    const feed = this.feed;
    if (!this.armed || exitCode !== 0 || !feed?.autoInstallOnAppQuit) return;
    if (this.deps.neverInstall) {
      this.warn('Mise à jour : essai de bout en bout, l’installateur n’est pas lancé.');
      return;
    }
    // Kept for the next session (I2): an install that does not complete leaves this app older than it, and is never
    // forced again for that version. Not written, the installer still runs: the update matters more.
    const version = this.manifest?.m.version;
    if (version) {
      try {
        this.deps.tried?.write(version);
      } catch (e) {
        this.warn(`Mise à jour : version tentée non gardée (${messageOf(e)}).`);
      }
    }
    feed.install(true, true);
  }

  /**
   * Not installed at this quit (the app starts again on a base taken from the server, D7: an installer running then would
   * close the app it starts), and final (M1): a check or an installer's verification under way arms nothing afterwards.
   * The next session finds it again, its download kept by electron-updater. Its only caller (index.ts: relaunch) quits
   * at once: a screen of a download under way stays as it is until then, without a button (review, M2).
   */
  disarm(): void {
    this.ended = true;
    this.armed = false;
    if (this.feed) this.feed.autoInstallOnAppQuit = false;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Whether this build may update at all: neither « Cirrus Dev » nor a pre-release (spec 18.1), nor an app run
   * unpackaged but under the end-to-end check's key (I3).
   */
  private allowed(): boolean {
    return !this.deps.dev && parseVersion(this.deps.version) !== null && (this.deps.packaged || this.deps.neverInstall === true);
  }

  private warn(text: string): void {
    (this.deps.warn ?? console.warn)(text);
  }

  /**
   * Every updateCheckMs (read each time: a change applies at the next), a check while connected; a format refused and
   * no hello passed since, every syncRetryMaxMs, connected or not.
   */
  private schedule(): void {
    if (this.disposed) return;
    const p = this.deps.params();
    const every = this.formatPending ? p.syncRetryMaxMs : Number.isFinite(p.updateCheckMs) ? Math.max(MIN_CHECK_MS, p.updateCheckMs) : MIN_CHECK_MS;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.formatPending || this.deps.connected()) void this.check();
      this.schedule();
    }, Number.isFinite(every) ? every : MIN_CHECK_MS);
  }

  private async run(): Promise<void> {
    if (this.disposed || this.ended || this.armed || !this.allowed()) return;
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
    // Signed, but not newer: nothing. A hello announced a newer one (M3): the server says a version it does not serve —
    // said; a periodic check, or a format refused, finds the version it has: silent.
    const announced = this.announced;
    this.announced = null;
    if (!(compareVersions(m.version, this.deps.version) > 0)) {
      if (announced !== null) this.refuse(`le serveur annonce la version ${announced} à /hello, mais son manifeste signé est la ${m.version}`, NOT_SERVED);
      return;
    }
    if (text === this.refusedText) return;
    // The version a former session started to install, this app still older (I2): its install did not complete — said
    // once, neither downloaded nor closed again; a newer version goes on as usual.
    if (m.version === this.tried) {
      if (this.triedSaid) return;
      this.triedSaid = true;
      this.warn(`Mise à jour : l’installation de la ${m.version}, lancée à une session précédente, n’a pas abouti ; elle n’est pas reprise.`);
      this.flow = { version: m.version, attempt: ++this.attempts, step: 'unfinished' };
      this.say();
      return;
    }
    // Signed and newer: the forced update begins, the screen up. A failure from here on is said on it.
    this.begin(m.version);
    try {
      await this.fetchInstaller(m, text, server);
    } catch (e) {
      this.fail(messageOf(e));
      throw e;
    }
    // electron-updater said nothing more (no download heard): never a screen left waiting.
    this.fail('electron-updater n’a rien téléchargé');
  }

  /** electron-updater set to the server, latest.yml checked against the signed manifest, then the installer downloaded. */
  private async fetchInstaller(m: Manifest, text: string, server: { url: string; token: string }): Promise<void> {
    const feed = await this.feedOf();
    if (this.ended) return;
    this.manifest = { m, text };
    feed.autoInstallOnAppQuit = false;
    // Nothing downloaded until latest.yml is known to name the signed installer (M2).
    feed.autoDownload = false;
    feed.disableDifferentialDownload = true;
    feed.disableWebInstaller = true;
    feed.allowDowngrade = false;
    feed.requestHeaders = { Authorization: `Bearer ${server.token}` };
    feed.setFeedURL({ provider: 'generic', url: `${server.url}/versions/` });
    const found = await feed.checkForUpdates();
    if (this.ended) return;
    // Null: electron-updater inactive (an app run unpackaged).
    if (!found) return this.fail('cette app n’est pas installée : electron-updater est inactif');
    const mismatch = latestMismatch(found.updateInfo, m);
    if (mismatch !== null) {
      this.refusedText = text;
      return this.refuse(mismatch);
    }
    if (!found.isUpdateAvailable) return this.fail('electron-updater ne voit pas de version plus récente');
    try {
      await feed.downloadUpdate();
    } catch (e) {
      // latest.yml pinned to the manifest, but other bytes served: electron-updater's own check failed. Refused for this
      // manifest, rather than downloaded again at each check; any other failure is the network's, tried again later.
      if ((e as { code?: unknown } | null)?.code !== 'ERR_CHECKSUM_MISMATCH') throw e;
      this.refusedText = text;
      return this.refuse('l’installateur servi n’a pas l’empreinte du manifeste signé');
    }
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
    feed.on('download-progress', (p) => this.progress(p.percent));
    this.feed = feed;
    return feed;
  }

  /** A run of the forced update begins (a signed manifest of `version`, newer): the screen says its download. */
  private begin(version: string): void {
    this.attempts++;
    this.verifying = null;
    this.flow = { version, attempt: this.attempts, step: 'downloading' };
    this.say();
  }

  /** The download's progress, each whole percent said once. */
  private progress(percent: number): void {
    const f = this.flow;
    if (f?.step !== 'downloading' || !Number.isFinite(percent)) return;
    const whole = Math.max(0, Math.min(100, Math.floor(percent)));
    if (whole === f.percent) return;
    this.flow = { ...f, percent: whole };
    this.say();
  }

  /** The download under way failed (the network, electron-updater): said on the screen; the next check runs it again. */
  private fail(message: string): void {
    const f = this.flow;
    if (f?.step !== 'downloading' || this.ended) return;
    this.flow = { version: f.version, attempt: f.attempt, step: 'failed', message: message.slice(0, MAX_MESSAGE_CHARS) };
    this.say();
  }

  /** The whole word: the screen's step, and the refusal's notification once said. */
  private say(): void {
    this.deps.tell({ ...(this.flow ? { updateFlow: this.flow } : {}), ...(this.notice !== null ? { updateRefused: this.notice } : {}) });
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
      // Disarmed meanwhile (M1): final — nothing armed, nothing closed.
      if (this.ended) return;
      this.armed = true;
      feed.autoInstallOnAppQuit = true;
      const { version, attempt } = this.flow ?? { version: signed.m.version, attempt: this.attempts };
      // The end-to-end check stops here: said, never closed nor installed.
      if (this.deps.neverInstall) {
        this.flow = { version, attempt, step: 'trial' };
        this.say();
        return;
      }
      this.flow = { version, attempt, step: 'restarting' };
      this.say();
      this.deps.restart();
    })().catch((err: unknown) => {
      this.warn(`Mise à jour : installateur non vérifié (${messageOf(err)}) ; rien n’est installé.`);
      this.fail(`installateur non vérifié (${messageOf(err)})`);
    });
  }

  /**
   * Nothing installed; said once a session, in the console and by a notification (`notice`). The forced update under
   * way, its screen says the refusal, every time.
   */
  private refuse(why: string, notice = REFUSED): void {
    const f = this.flow;
    const shown = f?.step === 'downloading' && !this.ended;
    if (shown) this.flow = { version: f.version, attempt: f.attempt, step: 'refused', message: why.slice(0, MAX_MESSAGE_CHARS) };
    if (!this.refusalSaid) {
      this.refusalSaid = true;
      this.notice = notice;
      this.warn(`Mise à jour refusée : ${why}. Rien n’est installé.`);
    } else if (!shown) return;
    this.say();
  }
}
