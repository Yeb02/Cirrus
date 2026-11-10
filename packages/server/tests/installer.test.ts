import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { type IncomingHttpHeaders, request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MAX_INSTALLER_BODY_BYTES, MAX_PAIR_CODE_CHARS, MAX_SMALL_BODY_MS, MIN_BODY_BYTES_PER_S, PAIRING_TRIES, PAIRING_TTL_MS } from '../src/bounds.ts';
import { type RunningServer, startServer } from '../src/server.ts';
import { newCode, pair, T0 } from './support.ts';

// The download page (plan 9, task 5, D5, Review Focus 5): GET /installer, a form without script; POST /installer, the
// pairing code checked as /pair checks it — a wrong try counts against every pending code — but not spent, and the
// official installer of <data>/versions/ (version.json, D4) streamed for a good one. The only route without a token
// besides /pair: the same Host check, its body bounded and within a deadline (here brought down, as in limits.test.ts).

vi.mock('../src/bounds.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/bounds.ts')>()),
  MAX_SMALL_BODY_MS: 400,
}));

let dir: string;
/** The server's clock (its `now`). */
let clock: number;
const running: RunningServer[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cirrus-serveur-installateur-'));
  clock = T0;
});
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

async function start(names?: string[]): Promise<RunningServer> {
  const s = await startServer({ dataDir: dir, port: 0, now: () => clock, names });
  running.push(s);
  return s;
}

const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const FORM = 'application/x-www-form-urlencoded';
const WRONG = 'Code inconnu ou expiré.';
const NONE = 'Aucune version n’est encore publiée sur ce serveur.';

/** The installer as the server's update script lays it out (D4, D6): its bytes in <data>/versions/. */
function installer(file: string, bytes: Buffer): void {
  mkdirSync(join(dir, 'versions'), { recursive: true });
  writeFileSync(join(dir, 'versions', file), bytes);
}

/** <data>/versions/version.json: `fields` over a manifest of `file`, or the text as it is. */
function manifest(fields: Record<string, unknown> | string): void {
  mkdirSync(join(dir, 'versions'), { recursive: true });
  const text = typeof fields === 'string' ? fields : JSON.stringify({ version: '0.1.7', sha512: 'ab'.repeat(64), date: '2026-11-10T09:00:00.000Z', ...fields });
  writeFileSync(join(dir, 'versions', 'version.json'), text);
}

/** An installer published whole: its file and its manifest. */
function publish(file: string, bytes: Buffer): void {
  installer(file, bytes);
  manifest({ file, size: bytes.length });
}

/** POST /installer, a form's body: `code=…` (URL-encoded), or `body` as it is. */
function download(url: string, code: string | null, init: { contentType?: string; body?: string } = {}): Promise<Response> {
  const body = init.body ?? (code === null ? '' : new URLSearchParams({ code }).toString());
  return fetch(`${url}/installer`, { method: 'POST', headers: { 'Content-Type': init.contentType ?? FORM }, body });
}

/** The pending codes, by name, and the wrong tries counted against each (serveur.db, as the server keeps them). */
function codes(): { name: string; failures: number }[] {
  const db = new DatabaseSync(join(dir, 'serveur.db'));
  try {
    return (db.prepare('SELECT name, failures FROM codes ORDER BY name').all() as { name: string; failures: number }[]).map((r) => ({ ...r }));
  } finally {
    db.close();
  }
}

/** What a reader of the page reads: its text, tags taken out, entities read, spaces collapsed. */
const text = (html: string): string => html.replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&').replace(/\s+/g, ' ');

/** The page's headers (D5): HTML in UTF-8, its CSP, neither framed nor a referrer, never kept, never sniffed. */
function expectPage(headers: { get(name: string): string | null }): void {
  expect(headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(headers.get('content-security-policy')).toBe(CSP);
  expect(headers.get('x-frame-options')).toBe('DENY');
  expect(headers.get('referrer-policy')).toBe('no-referrer');
  expect(headers.get('cache-control')).toBe('no-store');
  expect(headers.get('x-content-type-options')).toBe('nosniff');
  expect(headers.get('content-disposition')).toBeNull();
}

/** A page's answer: checked to be the page (status 200, its headers), and its HTML. */
async function page(res: Response): Promise<string> {
  expect(res.status).toBe(200);
  expectPage(res.headers);
  return res.text();
}

/** An installer's answer: checked to be one, and its bytes. */
async function got(res: Response): Promise<Buffer> {
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/octet-stream');
  return Buffer.from(await res.arrayBuffer());
}

interface Answer { status: number; headers: IncomingHttpHeaders; body: Buffer }

/**
 * A request to /installer by node:http: its own Host header (as Caddy passes the client's on), and its body written in
 * `pieces`, its length not announced (chunked) — fetch sets Host from the address, and announces the length.
 */
function call(url: string, opts: { method?: string; host?: string; headers?: Record<string, string>; pieces?: string[] } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers = { ...opts.headers, ...(opts.host === undefined ? {} : { Host: opts.host }) };
    const req = request(`${url}/installer`, { method: opts.method ?? 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    for (const p of opts.pieces ?? []) req.write(p);
    req.end();
  });
}

/**
 * A raw connection that writes `head`, then a byte every `everyMs`, never all its announced body: the status of its
 * answer, and when the server cut it (null: still open when `windowMs` ends).
 */
function trickle(url: string, head: string, everyMs: number, windowMs: number): Promise<{ status: number | null; closedMs: number | null }> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const socket = connect(Number(port), hostname);
    let received = '', closedMs: number | null = null;
    const timer = setInterval(() => {
      if (closedMs === null) socket.write('0');
    }, everyMs);
    const done = () => {
      clearInterval(timer);
      clearTimeout(limit);
      socket.destroy();
      resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(received)?.[1]) || null, closedMs });
    };
    const limit = setTimeout(done, windowMs);
    socket.on('data', (d: Buffer) => { received += d.toString('latin1'); });
    socket.on('error', () => { closedMs ??= Date.now() - t0; });
    socket.on('close', () => {
      closedMs ??= Date.now() - t0;
      done();
    });
    socket.write(head);
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The page

test('GET /installer (D5) : la page, sans jeton ; un champ, un bouton, ni script ni ressource externe ; sa CSP, ni cadre ni référent', async () => {
  const { url } = await start();
  const html = await page(await fetch(`${url}/installer`));
  expect(html).toMatch(/^<!doctype html>/i);
  expect(html).toContain('<html lang="fr">');
  expect(html).toContain('<meta charset="utf-8">');
  expect(html).toContain('<title>Cirrus : installer</title>');
  expect(text(html)).toContain('Tape le code de jumelage que t’a donné jumeler sur le serveur.');
  // One form, posted here; one field, the code, which the browser does not keep; one button.
  expect(html.match(/<form\b[^>]*>/g)).toEqual([expect.stringMatching(/method="post" action="\/installer"/)]);
  const inputs = html.match(/<input\b[^>]*>/g) ?? [];
  expect(inputs).toHaveLength(1);
  const input = inputs[0] ?? '';
  expect(input).toMatch(/\bname="code"/);
  expect(input).toMatch(/\bautocomplete="off"/);
  // A hint only (the server checks): a code longer than /pair's bound is not typed.
  expect(/\bmaxlength="(\d+)"/.exec(input)?.[1]).toBe(String(MAX_PAIR_CODE_CHARS));
  expect(html.match(/<button\b[^>]*>[^<]*<\/button>/g)?.map(text)).toEqual([' Télécharger l’installateur ']);
  // Nothing that runs, nothing fetched, no message yet.
  expect(html).not.toMatch(/<script|<link|<img|<iframe|<object|<embed|<svg|<base|\bsrc=|\bhref=|url\(|@import|\bon[a-z]+=|javascript:/i);
  expect(text(html)).not.toContain(WRONG);
  expect(text(html)).not.toContain(NONE);
  // Whatever its query, the same page.
  expect(await page(await fetch(`${url}/installer?code=1234`))).toBe(html);
});

test('/installer : une autre méthode que GET ou POST, 405 ; aucun essai compté', async () => {
  const { url } = await start();
  const code = newCode(dir, 'Portable', clock);
  for (const method of ['PUT', 'DELETE', 'PATCH', 'HEAD']) {
    const res = await fetch(`${url}/installer`, { method, ...(method === 'HEAD' ? {} : { headers: { 'Content-Type': FORM }, body: `code=${code}` }) });
    expect(res.status, method).toBe(405);
    expect(res.headers.get('allow'), method).toBe('GET, POST');
  }
  expect(codes()).toEqual([{ name: 'Portable', failures: 0 }]);
});

// ---------------------------------------------------------------------------------------------------------------------
// The code

test('POST /installer (D5) : un bon code, tel qu’affiché ou en minuscules sans tirets, rend l’installateur ; il n’est pas consommé, /pair le prend ensuite', async () => {
  const { url } = await start();
  const bytes = randomBytes(300_000), file = 'Cirrus Setup 0.1.7 (é).exe';
  publish(file, bytes);
  const code = newCode(dir, 'Portable', clock);
  for (const typed of [code, ` ${code.replaceAll('-', '').toLowerCase()} `, code.replaceAll('-', ' ')]) {
    const res = await download(url, typed);
    expect(res.headers.get('content-disposition'), typed).toBe(`attachment; filename="Cirrus Setup 0.1.7 (_).exe"; filename*=UTF-8''Cirrus%20Setup%200.1.7%20%28%C3%A9%29.exe`);
    expect(res.headers.get('content-length'), typed).toBe(String(bytes.length));
    expect(res.headers.get('cache-control'), typed).toBe('no-store');
    expect(res.headers.get('x-content-type-options'), typed).toBe('nosniff');
    expect((await got(res)).equals(bytes), typed).toBe(true);
  }
  // A browser's form says its charset: accepted.
  expect((await got(await download(url, code, { contentType: `${FORM};charset=UTF-8` }))).equals(bytes)).toBe(true);
  // Neither spent nor counted as a wrong try: the PC pairs with it next, and then it is gone.
  expect(codes()).toEqual([{ name: 'Portable', failures: 0 }]);
  expect((await pair(url, { code, pc: 'pc-a', name: 'DESKTOP-A' })).status).toBe(200);
  expect(codes()).toEqual([]);
  expect(text(await page(await download(url, code)))).toContain(WRONG);
});

test('POST /installer (D5) : un code faux, ou expiré, rend la page et « Code inconnu ou expiré. » ; l’essai compte contre chaque code en attente', async () => {
  const { url } = await start();
  publish('Cirrus Setup 0.1.7.exe', randomBytes(1000));
  newCode(dir, 'Portable', clock);
  const bureau = newCode(dir, 'Bureau', clock);
  const html = await page(await download(url, 'ABCD-EFGH-JKMN-PQRS'));
  expect(text(html)).toContain(WRONG);
  // The form again, to try once more.
  expect(html.match(/<form\b/g)).toHaveLength(1);
  expect(codes()).toEqual([{ name: 'Bureau', failures: 1 }, { name: 'Portable', failures: 1 }]);
  // Expired: ten minutes later, a wrong try too.
  clock += PAIRING_TTL_MS + 1;
  expect(text(await page(await download(url, bureau)))).toContain(WRONG);
  expect(codes()).toEqual([]);
});

test('POST /installer : un formulaire sans code, ou un code plus long que MAX_PAIR_CODE_CHARS, rend la page et le message, sans essai compté (comme le 400 de /pair)', async () => {
  const { url } = await start();
  const code = newCode(dir, 'Portable', clock);
  for (const body of ['', 'autre=1', `code=${'0'.repeat(MAX_PAIR_CODE_CHARS + 1)}`]) {
    expect(text(await page(await download(url, null, { body }))), body).toContain(WRONG);
  }
  expect(codes()).toEqual([{ name: 'Portable', failures: 0 }]);
  // At the bound, a code is tried; the other fields are ignored, the first `code` read.
  expect(text(await page(await download(url, null, { body: `x=1&code=${'0'.repeat(MAX_PAIR_CODE_CHARS)}&code=${code}` })))).toContain(WRONG);
  expect(codes()).toEqual([{ name: 'Portable', failures: 1 }]);
});

test('POST /installer (Review Focus 5) : quatre codes faux laissent le code, cinq le brûlent ; les essais de /pair et de /installer s’additionnent', async () => {
  const { url } = await start();
  const bytes = randomBytes(1000);
  publish('Cirrus Setup 0.1.7.exe', bytes);
  const code = newCode(dir, 'Portable', clock);
  for (let i = 0; i < PAIRING_TRIES - 1; i++) expect(text(await page(await download(url, '0000-0000-0000-0000')))).toContain(WRONG);
  expect(codes()).toEqual([{ name: 'Portable', failures: PAIRING_TRIES - 1 }]);
  // Still alive: it downloads, which neither spends it nor clears its tries.
  expect((await got(await download(url, code))).equals(bytes)).toBe(true);
  expect(codes()).toEqual([{ name: 'Portable', failures: PAIRING_TRIES - 1 }]);
  // The fifth burns it: neither the installer nor a pairing with it.
  expect(text(await page(await download(url, '0000-0000-0000-0000')))).toContain(WRONG);
  expect(codes()).toEqual([]);
  expect(text(await page(await download(url, code)))).toContain(WRONG);
  expect((await pair(url, { code, pc: 'pc-a', name: 'DESKTOP-A' })).status).toBe(403);
  // One count for both routes: four wrong here and one wrong /pair burn a new code.
  const other = newCode(dir, 'Bureau', clock);
  for (let i = 0; i < PAIRING_TRIES - 1; i++) await download(url, '0000-0000-0000-0000');
  expect((await pair(url, { code: '0000-0000-0000-0000', pc: 'pc-a', name: 'DESKTOP-A' })).status).toBe(403);
  expect(codes()).toEqual([]);
  expect(text(await page(await download(url, other)))).toContain(WRONG);
});

// ---------------------------------------------------------------------------------------------------------------------
// The body, the Host

test('POST /installer : un corps plus gros que MAX_INSTALLER_BODY_BYTES, annoncé ou non, reçoit 413 ; aucun code essayé ; à la borne, il est lu', async () => {
  expect(MAX_INSTALLER_BODY_BYTES).toBe(1024);
  const { url } = await start();
  publish('Cirrus Setup 0.1.7.exe', randomBytes(1000));
  const code = newCode(dir, 'Portable', clock);
  // Announced: refused before anything is read.
  const announced = await download(url, null, { body: `code=${code}&x=${'0'.repeat(MAX_INSTALLER_BODY_BYTES)}` });
  expect(announced.status).toBe(413);
  expect(announced.headers.get('content-type')).toBe('application/json; charset=utf-8');
  // Not announced: refused as soon as it passes the bound.
  const chunked = await call(url, { method: 'POST', headers: { 'Content-Type': FORM }, pieces: [`code=${code}&x=`, '0'.repeat(600), '0'.repeat(600)] });
  expect(chunked.status).toBe(413);
  expect(codes()).toEqual([{ name: 'Portable', failures: 0 }]);
  // At the bound exactly: read, its code tried.
  const body = `code=${code}&x=`;
  expect((await got(await download(url, null, { body: body + '0'.repeat(MAX_INSTALLER_BODY_BYTES - body.length) }))).length).toBe(1000);
});

test('POST /installer : un corps au compte-gouttes reçoit 408 à son échéance (courte : la borne est petite), puis la connexion est coupée ; aucun code essayé', async () => {
  const { url } = await start();
  newCode(dir, 'Portable', clock);
  const { host } = new URL(url);
  // 100 bytes announced: the deadline is MAX_SMALL_BODY_MS, and a second per MIN_BODY_BYTES_PER_S of them.
  const deadline = MAX_SMALL_BODY_MS + Math.ceil((100 / MIN_BODY_BYTES_PER_S) * 1000);
  const head = `POST /installer HTTP/1.1\r\nHost: ${host}\r\nContent-Type: ${FORM}\r\nContent-Length: 100\r\n\r\ncode=`;
  const r = await trickle(url, head, 50, deadline + 2000);
  expect(r.status).toBe(408);
  expect(r.closedMs).not.toBeNull();
  expect(r.closedMs!).toBeGreaterThanOrEqual(deadline - 50);
  expect(r.closedMs!).toBeLessThan(deadline + 1000);
  expect(codes()).toEqual([{ name: 'Portable', failures: 0 }]);
});

test('POST /installer : un autre type que le formulaire reçoit 415, avant le code ; aucun essai compté, rien ne sort', async () => {
  const { url } = await start();
  publish('Cirrus Setup 0.1.7.exe', randomBytes(1000));
  const code = newCode(dir, 'Portable', clock);
  for (const type of ['application/json', 'text/plain', 'multipart/form-data; boundary=x', 'application/x-www-form-urlencodedx', 'text/html; application/x-www-form-urlencoded']) {
    const res = await download(url, code, { contentType: type });
    expect(res.status, type).toBe(415);
    expect(res.headers.get('content-type'), type).toBe('application/json; charset=utf-8');
  }
  // No Content-Type at all.
  expect((await call(url, { method: 'POST', pieces: [`code=${code}`] })).status).toBe(415);
  expect(codes()).toEqual([{ name: 'Portable', failures: 0 }]);
});

test('/installer (Review Focus 5) : un Host étranger est refusé (403), GET comme POST, avant le code ; le nom admis est servi, casse et port ignorés', async () => {
  const { url } = await start(['cirrus.exemple.fr']);
  const bytes = randomBytes(1000);
  publish('Cirrus Setup 0.1.7.exe', bytes);
  const code = newCode(dir, 'Portable', clock);
  const post = (host: string) => call(url, { method: 'POST', host, headers: { 'Content-Type': FORM }, pieces: [`code=${code}`] });
  for (const host of ['pirate.example', 'cirrus.exemple.fr.pirate.org', 'exemple.fr', 'cirrus.exemple.fr.']) {
    const get = await call(url, { host });
    expect(get.status, host).toBe(403);
    expect(get.body.toString(), host).not.toContain('<form');
    const p = await post(host);
    expect(p.status, host).toBe(403);
    expect(p.headers['content-type'], host).toBe('application/json; charset=utf-8');
  }
  expect(codes()).toEqual([{ name: 'Portable', failures: 0 }]);
  const get = await call(url, { host: 'cirrus.exemple.fr' });
  expect(get.status).toBe(200);
  expect(get.headers['content-security-policy']).toBe(CSP);
  const p = await post('Cirrus.Exemple.FR:443');
  expect(p.status).toBe(200);
  expect(p.body.equals(bytes)).toBe(true);
});

// ---------------------------------------------------------------------------------------------------------------------
// What the page shows

test('injection (Review Focus 5) : une valeur hostile dans le formulaire n’est jamais renvoyée ; la page est celle d’un code faux, octet pour octet', async () => {
  const { url } = await start();
  const plain = await page(await download(url, 'ABCD-EFGH-JKMN-PQRS'));
  const hostile = [
    '<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', "'><svg onload=alert(1)>", '</form><form action="https://pirate.example">',
    '&lt;script&gt;', '{{7*7}}${7*7}', 'javascript:alert(1)', '\r\nSet-Cookie: x=1',
  ];
  for (const value of hostile) {
    expect(await page(await download(url, value)), value).toBe(plain);
  }
  // Sent raw, not encoded as a browser would: the same.
  expect(await page(await download(url, null, { body: 'code=<script>alert(1)</script>' }))).toBe(plain);
  expect(plain).not.toMatch(/<script|onerror|onload|alert|pirate/i);
});

test('injection : ce que la page affiche passe par escapeHtml ; les cinq caractères de HTML sont échappés', async () => {
  const { escapeHtml, installerPage } = await import('../src/installer.ts');
  expect(escapeHtml(`<script>"x" & 'y'</script>`)).toBe('&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;');
  const html = installerPage('<script>alert("x")</script>');
  expect(html).not.toContain('<script');
  expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
});

// ---------------------------------------------------------------------------------------------------------------------
// The version published

test('aucune version publiée : un bon code rend la page et « Aucune version n’est encore publiée sur ce serveur. », sans être consommé ; un faux, « Code inconnu… »', async () => {
  const { url } = await start();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const code = newCode(dir, 'Portable', clock);
  // No versions/ folder, then an empty one.
  expect(text(await page(await download(url, code)))).toContain(NONE);
  mkdirSync(join(dir, 'versions'));
  expect(text(await page(await download(url, code)))).toContain(NONE);
  // Nothing is said of the versions to a wrong code.
  const wrong = text(await page(await download(url, '0000-0000-0000-0000')));
  expect(wrong).toContain(WRONG);
  expect(wrong).not.toContain(NONE);
  // Nothing broken: nothing written to the server's log.
  expect(warn).not.toHaveBeenCalled();
  expect(codes()).toEqual([{ name: 'Portable', failures: 1 }]);
  expect((await pair(url, { code, pc: 'pc-a', name: 'DESKTOP-A' })).status).toBe(200);
});

test('version.json (D4, D5) : un nom qui sort de versions/ (../x), un chemin, un dossier, un fichier absent, une taille fausse, un JSON abîmé : rien n’est servi, la page le dit, le serveur l’écrit', async () => {
  const { url } = await start();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  // A file beside versions/, which ../x names; another in a folder of versions/.
  const secret = Buffer.from('SECRET : hors de versions/');
  writeFileSync(join(dir, 'x'), secret);
  installer('ok.exe', randomBytes(1000));
  mkdirSync(join(dir, 'versions', 'dossier'));
  writeFileSync(join(dir, 'versions', 'dossier', 'x'), secret);
  const code = newCode(dir, 'Portable', clock);
  const size = secret.length;
  const broken: (Record<string, unknown> | string)[] = [
    { file: '../x', size }, { file: '..\\x', size }, { file: '..', size }, { file: '.', size }, { file: join(dir, 'x'), size }, { file: 'dossier/x', size },
    { file: 'dossier\\x', size }, { file: 'C:x', size }, { file: 'x/', size }, { file: '', size }, { file: 42, size }, { size },
    { file: '\ud800.exe', size }, { file: 'absent.exe', size }, { file: 'dossier', size: 0 }, { file: 'dossier', size },
    { file: 'ok.exe', size: 1001 }, { file: 'ok.exe', size: 999 }, { file: 'ok.exe', size: '1000' }, { file: 'ok.exe', size: 1000.5 }, { file: 'ok.exe', size: -1 },
    { file: 'ok.exe' }, '{', '[]', 'null', '"ok.exe"', '',
  ];
  for (const m of broken) {
    manifest(m);
    const html = await page(await download(url, code));
    expect(text(html), JSON.stringify(m)).toContain(NONE);
    expect(html, JSON.stringify(m)).not.toContain('SECRET');
  }
  // Each written to the server's log, for whoever runs it.
  expect(warn).toHaveBeenCalledTimes(broken.length);
  expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('version.json'));
  // A link in versions/ to the file beside it, where the system lets one be made: refused too.
  let linked = false;
  try {
    symlinkSync(join(dir, 'x'), join(dir, 'versions', 'lien.exe'), 'file');
    linked = true;
  } catch {
    // Windows without the right to make links: nothing to try.
  }
  if (linked) {
    manifest({ file: 'lien.exe', size });
    const html = await page(await download(url, code));
    expect(text(html)).toContain(NONE);
    expect(html).not.toContain('SECRET');
  }
  // The code tried each time, good each time: neither spent nor counted. A good manifest, and the installer comes.
  expect(codes()).toEqual([{ name: 'Portable', failures: 0 }]);
  manifest({ file: 'ok.exe', size: 1000 });
  expect((await got(await download(url, code))).length).toBe(1000);
});
