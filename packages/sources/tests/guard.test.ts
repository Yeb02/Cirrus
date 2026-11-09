import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { expect, test } from 'vitest';
import { type ConnectRequest, httpsConnect, isPublic, openFetch } from '../src/guard.ts';
import { endless, html, HTTPS_ONLY, LOCAL, pdf, PDF_BYTES, PUBLIC, PUBLIC6, redirect, seconds, web } from './support.ts';

const CAPS = { page: 64 * 1024, pdf: 2 ** 20 };
const ACCEPT = 'text/html';

test('isPublic : chaque plage de D3, à ses deux bouts, est refusée ; ses voisines et une adresse publique sont permises', () => {
  const blocked: [string, string][] = [
    ['0.0.0.0', '0.255.255.255'], ['10.0.0.0', '10.255.255.255'], ['100.64.0.0', '100.127.255.255'], ['127.0.0.0', '127.255.255.255'],
    ['169.254.0.0', '169.254.255.255'], ['172.16.0.0', '172.31.255.255'], ['192.0.0.0', '192.0.0.255'], ['192.0.2.0', '192.0.2.255'],
    ['192.168.0.0', '192.168.255.255'], ['198.18.0.0', '198.19.255.255'], ['198.51.100.0', '198.51.100.255'], ['203.0.113.0', '203.0.113.255'],
    ['224.0.0.0', '239.255.255.255'], ['240.0.0.0', '255.255.255.255'],
    ['::', '::'], ['::1', '::1'], ['fc00::', 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'], ['fe80::', 'febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['ff00::', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'], ['2001:db8::', '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff'], ['100::', '100::ffff:ffff:ffff:ffff'],
    // Review of task 2: the local-use NAT64 prefix (RFC 8215), the deprecated site-local addresses.
    ['64:ff9b:1::', '64:ff9b:1:ffff:ffff:ffff:ffff:ffff'], ['fec0::', 'feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ];
  for (const [first, last] of blocked) {
    expect(isPublic(first), first).toBe(false);
    expect(isPublic(last), last).toBe(false);
  }
  // Just outside each range.
  for (const a of [
    '1.0.0.0', '9.255.255.255', '11.0.0.0', '100.63.255.255', '100.128.0.0', '126.255.255.255', '128.0.0.0', '169.253.255.255', '169.255.0.0',
    '172.15.255.255', '172.32.0.0', '192.0.1.0', '192.0.3.0', '192.167.255.255', '192.169.0.0', '198.17.255.255', '198.20.0.0', '198.51.99.255',
    '198.51.101.0', '203.0.112.255', '203.0.114.0', '223.255.255.255',
    'fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'fe00::', 'fe00:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '2001:db7:ffff:ffff:ffff:ffff:ffff:ffff', '2001:db9::',
    '100:0:0:1::', 'ff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '64:ff9b:0:ffff:ffff:ffff:ffff:ffff', '64:ff9b:2::', '64:ff9a:ffff:ffff:ffff:ffff:ffff:ffff',
  ]) {
    expect(isPublic(a), a).toBe(true);
  }
  for (const a of [PUBLIC, '8.8.8.8', '1.1.1.1', PUBLIC6, '2001:4860:4860::8888', '2a00:1450:4007:80e::200e']) expect(isPublic(a), a).toBe(true);
});

test('isPublic : une IPv4 incluse dans une IPv6 est jugée comme son IPv4 ; ce qui n’est pas une adresse est refusé', () => {
  for (const a of [
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::FFFF:10.0.0.5', '::ffff:0.0.0.0', '::ffff:169.254.169.254', '::ffff:255.255.255.255', '0:0:0:0:0:ffff:c0a8:101',
    '64:ff9b::a00:1', '64:ff9b::127.0.0.1', '64:ff9b::', '64:ff9b::a9fe:a9fe', '64:ff9b:0:0:0:0:c0a8:0101',
    // The IPv4-compatible addresses (::/96, deprecated): none is a host of the Internet.
    '::127.0.0.1', '::8.8.8.8', '::2',
  ]) {
    expect(isPublic(a), a).toBe(false);
  }
  for (const a of ['::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808', '64:ff9b::93.184.215.14']) expect(isPublic(a), a).toBe(true);
  // Review of task 2: 6to4 (2002::/16, its IPv4 in its bits 16 to 47) and SIIT (::ffff:0:0:0/96) judged by their IPv4.
  for (const a of [
    '2002:7f00:1::', '2002:7f00:1:ffff:ffff:ffff:ffff:ffff', '2002:c0a8:101::1', '2002:a00:5::', '2002:a9fe:a9fe::', '2002::', '2002:e000::',
    '::ffff:0:7f00:1', '::ffff:0:a00:5', '0:0:0:0:ffff:0:c0a8:101', '::ffff:0:0:0', '::ffff:0:127.0.0.1',
  ]) {
    expect(isPublic(a), a).toBe(false);
  }
  for (const a of ['2002:808:808::', '2002:5db8:d70e::1', '::ffff:0:808:808', '::ffff:0:93.184.215.14']) expect(isPublic(a), a).toBe(true);
  // Not an address as a resolver writes one: refused, never guessed.
  for (const a of ['', 'localhost', 'example.org', '127.1', '0x7f.0.0.1', '2130706433', '017700000001', 'fe80::1%eth0', '::1%1', '[::1]', ' 8.8.8.8', '8.8.8.8 ', '1.2.3.4.5', ':::', 'fffff::']) {
    expect(isPublic(a), JSON.stringify(a)).toBe(false);
  }
});

test('openFetch : un nom résolu vers une adresse du réseau local, ou vers une publique et une locale, est refusé sans connexion', async () => {
  const names = {
    'interne.example': ['10.0.0.5'], 'mixte.example': [PUBLIC, '192.168.1.10'], 'mixte6.example': [PUBLIC6, 'fd12:3456::1'], 'meta.example': ['169.254.169.254'],
    'boucle6.example': ['::1'], 'incluse.example': ['::ffff:127.0.0.1'], 'nat64.example': ['64:ff9b::a00:1'], 'cgnat.example': ['100.64.0.1'], 'bizarre.example': ['pas une adresse'],
  };
  for (const host of Object.keys(names)) {
    const w = web({ [`${host}/`]: () => html('<html></html>') }, names);
    expect(await openFetch(`https://${host}/`, w.deps, ACCEPT, CAPS), host).toEqual({ ok: false, message: LOCAL });
    expect(w.resolved, host).toEqual([host]);
    expect(w.connected, host).toEqual([]);
  }
  // A name that resolves to nothing: as without a network.
  const none = web({}, { 'vide.example': [] });
  expect(await openFetch('https://vide.example/', none.deps, ACCEPT, CAPS)).toEqual({ ok: false, message: 'Pas de connexion.' });
  const unknown = web({});
  expect(await openFetch('https://inconnu.example/', unknown.deps, ACCEPT, CAPS)).toEqual({ ok: false, message: 'Pas de connexion.' });
  expect(none.connected.length + unknown.connected.length).toBe(0);
});

test('openFetch : une adresse IP écrite telle quelle ou sous une forme numérique est jugée sans résolution, et refusée si elle est locale', async () => {
  // The URL parser writes these as the address they are.
  expect(new URL('https://2130706433/').hostname).toBe('127.0.0.1');
  expect(new URL('https://0x7f.1/').hostname).toBe('127.0.0.1');
  for (const href of [
    'https://2130706433/', 'https://0x7f.1/', 'https://127.1/', 'https://0177.0.0.1/', 'https://127.0.0.1/', 'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://[::ffff:7f00:1]/', 'https://[fd00::1]/', 'https://[fe80::1]/', 'https://[64:ff9b::a00:1]/', 'https://0/',
    'https://10.1.2.3/papier.pdf', 'https://192.168.1.1/',
  ]) {
    const w = web({}, {});
    expect(await openFetch(href, w.deps, ACCEPT, CAPS), href).toEqual({ ok: false, message: LOCAL });
    expect(w.resolved, href).toEqual([]);
    expect(w.connected, href).toEqual([]);
  }
  // A public address written as such: asked at that address, without resolution.
  const w = web({ [`${PUBLIC}/a`]: () => html('ok') }, {});
  expect((await openFetch(`https://${PUBLIC}/a`, w.deps, ACCEPT, CAPS)).ok).toBe(true);
  expect(w.resolved).toEqual([]);
  expect(w.connected.map((c) => [c.address, c.hostname])).toEqual([[PUBLIC, PUBLIC]]);
  const v6 = web({ [`${PUBLIC6}/a`]: () => html('ok') }, {});
  expect((await openFetch(`https://[${PUBLIC6}]/a`, v6.deps, ACCEPT, CAPS)).ok).toBe(true);
  expect(v6.connected.map((c) => [c.address, c.family, c.hostname])).toEqual([[PUBLIC6, 6, PUBLIC6]]);
});

test('openFetch : seulement https, sur le port 443, sans identifiants ; rien n’est résolu sinon', async () => {
  const cases: [string, string][] = [
    ['http://public.example/', HTTPS_ONLY], ['ftp://public.example/x.pdf', HTTPS_ONLY], ['file:///C:/x.pdf', HTTPS_ONLY], ['javascript:alert(1)', HTTPS_ONLY],
    ['pas une adresse', HTTPS_ONLY], ['https://', HTTPS_ONLY],
    ['https://public.example:8443/', 'Adresse refusée : seul le port 443 est accepté.'], ['https://public.example:80/', 'Adresse refusée : seul le port 443 est accepté.'],
    ['https://moi@public.example/', 'Adresse refusée : elle contient un nom d’utilisateur ou un mot de passe.'],
    ['https://moi:secret@public.example/', 'Adresse refusée : elle contient un nom d’utilisateur ou un mot de passe.'],
  ];
  for (const [href, message] of cases) {
    const w = web({ 'public.example/': () => html('ok') }, { 'public.example': [PUBLIC] });
    expect(await openFetch(href, w.deps, ACCEPT, CAPS), href).toEqual({ ok: false, message });
    expect(w.resolved.length + w.connected.length, href).toBe(0);
  }
  // Port 443 written out is the default port.
  const w = web({ 'public.example/': () => html('ok') }, { 'public.example': [PUBLIC] });
  expect((await openFetch('https://public.example:443/', w.deps, ACCEPT, CAPS)).ok).toBe(true);
});

test('openFetch : la connexion reçoit l’adresse vérifiée, jamais le nom ; une IPv4 d’abord ; le nom ne sert qu’au TLS et à Host', async () => {
  const w = web({ 'public.example/article?id=1': () => html('<html></html>') }, { 'public.example': [PUBLIC6, PUBLIC] });
  const r = await openFetch('https://public.example/article?id=1#resume', w.deps, ACCEPT, CAPS);
  expect(r).toEqual({ ok: true, url: 'https://public.example/article?id=1#resume', type: 'text/html', pdf: false, bytes: new TextEncoder().encode('<html></html>') });
  expect(w.connected).toHaveLength(1);
  const { signal, ...req } = w.connected[0];
  expect(req).toEqual({
    address: PUBLIC, family: 4, hostname: 'public.example', path: '/article?id=1', headers: { Accept: ACCEPT, 'User-Agent': 'Cirrus (import de publication)' },
  });
  expect(signal).toBeInstanceOf(AbortSignal);
  // Only IPv6: that one.
  const v6 = web({ 'v6.example/': () => html('ok') }, { 'v6.example': [PUBLIC6] });
  await openFetch('https://v6.example/', v6.deps, ACCEPT, CAPS);
  expect(v6.connected.map((c) => [c.address, c.family])).toEqual([[PUBLIC6, 6]]);
});

test('openFetch : une connexion qui échoue passe à l’adresse vérifiée suivante, jamais à une autre (relecture de la tâche 2)', async () => {
  const fails = (bad: Set<string>, w: ReturnType<typeof web>) => {
    w.deps.connect = async (req) => {
      w.connected.push(req);
      if (bad.has(req.address)) throw Object.assign(new Error(`connect ETIMEDOUT ${req.address}:443`), { code: 'ETIMEDOUT' });
      return html('ok');
    };
  };
  // The IPv4 first; it fails: the IPv6 of the same name.
  const w = web({}, { 'double.example': [PUBLIC6, PUBLIC] });
  fails(new Set([PUBLIC]), w);
  expect((await openFetch('https://double.example/', w.deps, ACCEPT, CAPS)).ok).toBe(true);
  expect(w.connected.map((c) => [c.address, c.hostname])).toEqual([[PUBLIC, 'double.example'], [PUBLIC6, 'double.example']]);
  // All fail: as without a network, each tried once, the causes logged.
  const logged: string[] = [];
  const all = web({}, { 'double.example': [PUBLIC6, PUBLIC, '1.1.1.1'] }, { log: (m) => logged.push(m) });
  fails(new Set([PUBLIC, PUBLIC6, '1.1.1.1']), all);
  expect(await openFetch('https://double.example/', all.deps, ACCEPT, CAPS)).toEqual({ ok: false, message: 'Pas de connexion.' });
  expect(all.connected.map((c) => c.address)).toEqual([PUBLIC, '1.1.1.1', PUBLIC6]);
  expect(logged.filter((m) => m.includes('ETIMEDOUT'))).toHaveLength(3);
  // An answer of the first, even an error, is final: the next is not asked.
  const answered = web({ 'double.example/': () => html('', 503) }, { 'double.example': [PUBLIC, '1.1.1.1'] });
  expect((await openFetch('https://double.example/', answered.deps, ACCEPT, CAPS)).ok).toBe(false);
  expect(answered.connected.map((c) => c.address)).toEqual([PUBLIC]);
});

test('openFetch : une réponse dite application/pdf qui ne commence pas par %PDF- est lue comme une page, sous son plafond (relecture de la tâche 2)', async () => {
  const body = endless(16 * 1024, Infinity, 0, new TextEncoder().encode('<html><body>Connectez-vous pour lire le PDF.'));
  const w = web({ 'public.example/a.pdf': () => pdf(body.stream) }, { 'public.example': [PUBLIC] });
  const r = await openFetch('https://public.example/a.pdf', w.deps, ACCEPT, { page: 64 * 1024, pdf: 2 ** 20 });
  expect(r.ok && [r.pdf, r.bytes.length]).toEqual([false, 64 * 1024]);
  expect(body.seen.pulls).toBeLessThanOrEqual(7);
  expect(body.seen.cancelled).toBe(true);
});

test('openFetch : un nom dont la seconde résolution diffère — une seule résolution par adresse demandée, la connexion à celle-là', async () => {
  let n = 0;
  const flip = () => (n++ === 0 ? [PUBLIC] : ['127.0.0.1']);
  const w = web({ 'changeant.example/': () => html('ok') }, { 'changeant.example': flip });
  expect((await openFetch('https://changeant.example/', w.deps, ACCEPT, CAPS)).ok).toBe(true);
  expect(w.resolved).toEqual(['changeant.example']);
  expect(w.connected.map((c) => c.address)).toEqual([PUBLIC]);
  // Redirected to itself: resolved again, judged again, refused.
  n = 0;
  const again = web({ 'changeant.example/': () => redirect('/suite'), 'changeant.example/suite': () => html('ok') }, { 'changeant.example': flip });
  expect(await openFetch('https://changeant.example/', again.deps, ACCEPT, CAPS)).toEqual({ ok: false, message: LOCAL });
  expect(again.resolved).toEqual(['changeant.example', 'changeant.example']);
  expect(again.connected.map((c) => c.path)).toEqual(['/']);
});

test('openFetch : chaque redirection est vérifiée de même, 5 au plus', async () => {
  const names = { 'public.example': [PUBLIC], 'interne.example': ['10.0.0.5'], 'autre.example': [PUBLIC] };
  for (const [location, message] of [
    ['https://interne.example/', LOCAL], ['https://10.0.0.1/', LOCAL], ['https://[::1]/', LOCAL], ['https://2130706433/', LOCAL],
    ['http://public.example/x', HTTPS_ONLY], ['file:///C:/Windows/win.ini', HTTPS_ONLY], ['https://autre.example:8443/', 'Adresse refusée : seul le port 443 est accepté.'],
  ] as const) {
    const w = web({ 'public.example/': () => redirect(location) }, names);
    expect(await openFetch('https://public.example/', w.deps, ACCEPT, CAPS), location).toEqual({ ok: false, message });
    expect(w.connected.map((c) => c.hostname), location).toEqual(['public.example']);
  }
  // A permitted chain, relative or absolute, of each status: followed, each target resolved and judged.
  for (const status of [301, 302, 303, 307, 308]) {
    const w = web({
      'public.example/': () => redirect('/relai', status), 'public.example/relai': () => redirect('https://autre.example/fin', status), 'autre.example/fin': () => html('fin'),
    }, names);
    const r = await openFetch('https://public.example/', w.deps, ACCEPT, CAPS);
    expect(r.ok && r.url, String(status)).toBe('https://autre.example/fin');
    expect(w.resolved).toEqual(['public.example', 'public.example', 'autre.example']);
  }
  // Without end: the 6th answer is a redirect, refused; 6 connections.
  const loop = web({}, names);
  loop.deps.connect = async (req) => { loop.connected.push(req); return redirect(`${req.path}x`); };
  expect(await openFetch('https://public.example/', loop.deps, ACCEPT, CAPS)).toEqual({ ok: false, message: 'Trop de redirections depuis « public.example ».' });
  expect(loop.connected).toHaveLength(6);
  // Five are followed.
  const five = web({}, names);
  five.deps.connect = async (req) => { five.connected.push(req); return req.path.length > 5 ? html('ok') : redirect(`${req.path}x`); };
  expect((await openFetch('https://public.example/', five.deps, ACCEPT, CAPS)).ok).toBe(true);
  // Without Location, or with one that is no address.
  for (const r of [new Response(null, { status: 302 }), redirect('https://[zz')]) {
    const w = web({ 'public.example/': () => r.clone() }, names);
    expect(await openFetch('https://public.example/', w.deps, ACCEPT, CAPS)).toEqual({ ok: false, message: 'Réponse inattendue du site « public.example ».' });
  }
});

test('openFetch : une réponse plus longue que son plafond — un PDF refusé, une page lue jusqu’à son plafond seulement', async () => {
  const names = { 'public.example': [PUBLIC] };
  // A PDF: refused past its cap, the reading stopped there.
  const big = endless(64 * 1024, Infinity, 0, PDF_BYTES);
  let w = web({ 'public.example/gros.pdf': () => pdf(big.stream) }, names);
  expect(await openFetch('https://public.example/gros.pdf', w.deps, ACCEPT, { page: 1024, pdf: 512 * 1024 })).toEqual({ ok: false, message: `Le PDF fait plus de ${(0.5).toLocaleString('fr-FR')} Mo.` });
  expect(big.seen.pulls).toBeLessThanOrEqual(10);
  expect(big.seen.cancelled).toBe(true);
  // Said too big by its length: not read at all.
  const declared = endless(1024);
  w = web({ 'public.example/gros.pdf': () => pdf(declared.stream, { 'content-length': String(10 * 2 ** 20) }) }, names);
  expect((await openFetch('https://public.example/gros.pdf', w.deps, ACCEPT, CAPS)).ok).toBe(false);
  expect(declared.seen.pulls).toBe(0);
  // A PDF by its first bytes, whatever its type says: under the PDF's cap.
  const sniffed = endless(64 * 1024, Infinity, 0, PDF_BYTES);
  w = web({ 'public.example/x': () => html(sniffed.stream) }, names);
  expect(await openFetch('https://public.example/x', w.deps, ACCEPT, { page: 1024, pdf: 512 * 1024 })).toEqual({ ok: false, message: `Le PDF fait plus de ${(0.5).toLocaleString('fr-FR')} Mo.` });
  // A page: its first `page` bytes, no more read, the rest let go.
  const page = endless(16 * 1024);
  w = web({ 'public.example/page': () => html(page.stream) }, names);
  const r = await openFetch('https://public.example/page', w.deps, ACCEPT, { page: 64 * 1024, pdf: 2 ** 20 });
  expect(r.ok && [r.pdf, r.bytes.length]).toEqual([false, 64 * 1024]);
  expect(page.seen.pulls).toBeLessThanOrEqual(6);
  expect(page.seen.cancelled).toBe(true);
  // Exactly at its cap, and a PDF exactly at its own: whole.
  w = web({ 'public.example/p': () => html('a'.repeat(1024)), 'public.example/d': () => pdf(PDF_BYTES) }, names);
  const exact = await openFetch('https://public.example/p', w.deps, ACCEPT, { page: 1024, pdf: PDF_BYTES.length });
  expect(exact.ok && exact.bytes.length).toBe(1024);
  const whole = await openFetch('https://public.example/d', w.deps, ACCEPT, { page: 1024, pdf: PDF_BYTES.length });
  expect(whole.ok && [whole.pdf, whole.bytes.length]).toEqual([true, PDF_BYTES.length]);
});

test('openFetch : un PDF par son type ou ses premiers octets ; les statuts ; sans réseau', async () => {
  const names = { 'public.example': [PUBLIC] };
  const w = web({
    'public.example/vrai.pdf': () => pdf(PDF_BYTES), 'public.example/deguise': () => html(PDF_BYTES), 'public.example/faux.pdf': () => pdf('<html>Connectez-vous</html>'),
    'public.example/sans-type': () => new Response(PDF_BYTES, { status: 200 }), 'public.example/vide': () => html(''),
    'public.example/absent': () => html('<html>404</html>', 404), 'public.example/parti': () => html('', 410), 'public.example/panne': () => html('', 503),
  }, names);
  const ask = (path: string) => openFetch(`https://public.example${path}`, w.deps, ACCEPT, CAPS);
  for (const [path, isPdf] of [['/vrai.pdf', true], ['/deguise', true], ['/faux.pdf', false], ['/sans-type', true], ['/vide', false]] as const) {
    const r = await ask(path);
    expect(r.ok && r.pdf, path).toBe(isPdf);
  }
  expect(await ask('/absent')).toEqual({ ok: false, message: 'Publication introuvable.' });
  expect(await ask('/parti')).toEqual({ ok: false, message: 'Publication introuvable.' });
  expect(await ask('/panne')).toEqual({ ok: false, message: 'Le site « public.example » a répondu par une erreur (HTTP 503).' });
  // Refused by the network: as without one; the cause to the log only.
  const logged: string[] = [];
  const off = web({}, names, { log: (m) => logged.push(m) });
  expect(await openFetch('https://public.example/rien', off.deps, ACCEPT, CAPS)).toEqual({ ok: false, message: 'Pas de connexion.' });
  expect(logged.join('\n')).toContain('ECONNREFUSED');
});

test('openFetch : un site qui ne répond pas, ou s’arrête, est abandonné après son délai ; un PDF lent mais jamais muet aussi longtemps est reçu', async () => {
  const message = `Le site « public.example » ne répond pas (délai de ${seconds(200)} dépassé).`;
  // Never answers, and ignores its signal: given up all the same, the signal aborted.
  let aborted = false;
  const never = web({ 'public.example/': (req) => { req.signal.addEventListener('abort', () => { aborted = true; }); return new Promise<Response>(() => {}); } }, { 'public.example': [PUBLIC] }, { timeoutMs: 200 });
  let t0 = performance.now();
  expect(await openFetch('https://public.example/', never.deps, ACCEPT, CAPS)).toEqual({ ok: false, message });
  expect(performance.now() - t0).toBeLessThan(2000);
  expect(aborted).toBe(true);
  // A resolution that never ends.
  const dns = web({}, {}, { timeoutMs: 200, resolve: () => new Promise(() => {}) });
  expect(await openFetch('https://public.example/', dns.deps, ACCEPT, CAPS)).toEqual({ ok: false, message });
  // A page that starts then stops; a page that trickles longer than the delay, never idle that long.
  const stalled = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('<html>')); } });
  const half = web({ 'public.example/': () => html(stalled) }, { 'public.example': [PUBLIC] }, { timeoutMs: 200 });
  t0 = performance.now();
  expect(await openFetch('https://public.example/', half.deps, ACCEPT, CAPS)).toEqual({ ok: false, message });
  expect(performance.now() - t0).toBeLessThan(2000);
  const trickle = endless(8, 10, 60);
  const slow = web({ 'public.example/': () => html(trickle.stream) }, { 'public.example': [PUBLIC] }, { timeoutMs: 300 });
  expect(await openFetch('https://public.example/', slow.deps, ACCEPT, CAPS)).toEqual({ ok: false, message: `Le site « public.example » ne répond pas (délai de ${seconds(300)} dépassé).` });
  // A PDF: the delay is a wait for data (re-armed at each piece), not its whole download.
  const pdfTrickle = endless(8, 10, 60, PDF_BYTES);
  const slowPdf = web({ 'public.example/a.pdf': () => pdf(pdfTrickle.stream) }, { 'public.example': [PUBLIC] }, { timeoutMs: 300 });
  const r = await openFetch('https://public.example/a.pdf', slowPdf.deps, ACCEPT, CAPS);
  expect(r.ok && [r.pdf, r.bytes.length]).toEqual([true, PDF_BYTES.length + 9 * 8]);
});

test('httpsConnect : https.request vers l’adresse vérifiée, le nom pour le TLS et Host seulement, sans agent partagé ni cookie', async () => {
  class FakeRequest extends EventEmitter {
    ended = false;
    destroyed: unknown = null;
    end() { this.ended = true; }
    destroy(e?: unknown) { this.destroyed = e ?? true; }
  }
  const made: { options: Record<string, unknown>; req: FakeRequest }[] = [];
  const connect = httpsConnect((options) => {
    const req = new FakeRequest();
    made.push({ options: { ...options }, req });
    return req as never;
  });
  const req = (more: Partial<ConnectRequest> = {}): ConnectRequest => ({
    address: PUBLIC, family: 4, hostname: 'public.example', path: '/a?b=1', headers: { Accept: ACCEPT, 'User-Agent': 'Cirrus (import de publication)' },
    signal: new AbortController().signal, ...more,
  });
  let p = connect(req());
  expect(made[0].options).toEqual({
    host: PUBLIC, family: 4, port: 443, path: '/a?b=1', method: 'GET', servername: 'public.example', agent: false,
    headers: { Host: 'public.example', Accept: ACCEPT, 'User-Agent': 'Cirrus (import de publication)' },
  });
  // No lookup of the name: the address is the host.
  expect('lookup' in made[0].options).toBe(false);
  expect(made[0].req.ended).toBe(true);
  made[0].req.emit('response', Object.assign(Readable.from([Buffer.from('<html>'), Buffer.from('</html>')]), {
    statusCode: 200, headers: { 'content-type': 'text/html', 'set-cookie': ['a=1'], 'x-plusieurs': ['a', 'b'] },
  }));
  const res = await p;
  expect([res.status, res.headers.get('content-type'), res.headers.get('x-plusieurs'), await res.text()]).toEqual([200, 'text/html', 'a, b', '<html></html>']);
  // An address written in the URL: no server name (TLS takes none for an address), Host as the URL writes it.
  p = connect(req({ address: PUBLIC6, family: 6, hostname: PUBLIC6 }));
  expect(made[1].options).toMatchObject({ host: PUBLIC6, family: 6, headers: { Host: `[${PUBLIC6}]` } });
  expect('servername' in made[1].options).toBe(false);
  made[1].req.emit('response', Object.assign(Readable.from([]), { statusCode: 302, headers: { location: '/ailleurs' } }));
  expect([(await p).status, (await p).headers.get('location')]).toEqual([302, '/ailleurs']);
  // The network's error; the signal destroys the request.
  p = connect(req());
  made[2].req.emit('error', new Error('connect ECONNREFUSED'));
  await expect(p).rejects.toThrow('ECONNREFUSED');
  const abort = new AbortController();
  p = connect(req({ signal: abort.signal }));
  abort.abort(new Error('délai'));
  await expect(p).rejects.toThrow('délai');
  expect(made[3].req.destroyed).toBeTruthy();
  // A status a Response cannot hold: refused, not thrown in a listener.
  p = connect(req());
  made[4].req.emit('response', Object.assign(Readable.from([]), { statusCode: 101, headers: {} }));
  await expect(p).rejects.toThrow();
});
