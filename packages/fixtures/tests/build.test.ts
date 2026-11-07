import { afterEach, beforeEach, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ancestors, ANNOTATION_TITLE_CHARS, annotationTitle, canonical, checkState, CITE_KEY_TAG, groupOf, LABEL_TAG, placementKey, type State, validAnchor,
} from '@cirrus/core';
import { filePath, LocalStore } from '@cirrus/store';
import { buildFixture } from '../src/build.ts';
import { chapterPdf } from '../src/pdf.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cirrus-fixture-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// Sorted: Map/Set iteration order depends on insertion history, not on content.
const sorted = <T>(xs: Iterable<T>) => [...xs].map((x) => canonical(x)).sort();
const snapshot = (s: State) => canonical({
  n: sorted(s.nodes), c: sorted(s.connections), p: sorted(s.plans), t: sorted(s.tagKeys), pl: sorted(s.placements),
  b: sorted(s.branches), l: sorted(s.connLayouts), ph: sorted(s.phantoms),
});

test('la base de test se construit sans violation', () => {
  const store = LocalStore.open(dir, { pc: 'fixture' });
  buildFixture(store, dir);
  expect(checkState(store.loadState())).toEqual([]);
  store.close();
});

test('chaque fonctionnalité est présente', () => {
  const store = LocalStore.open(dir, { pc: 'fixture' });
  const ids = buildFixture(store, dir);
  const s = store.loadState();
  const live = [...s.connections.values()].filter((c) => c.trashedAt === undefined);
  const roles = (id: string) => s.connections.get(id)!.members.map((m) => m.role).sort().join(',');
  const placedIn = (node: string) => [...s.placements.values()].filter((p) => p.node === node).map((p) => p.plan);

  // Plans, by type: « Thèse » and « Lecture » (plan 4c) are ordinary plans.
  expect([...s.plans.values()].map((p) => p.type).sort()).toEqual(['document', 'lobby', 'plan', 'plan']);

  // Tag registry.
  for (const key of ['statut_epistémique', 'pertinence', 'nature', 'provenance', 'auteur', 'date_de_publication']) expect(s.tagKeys.has(key)).toBe(true);
  expect(s.tagKeys.get('statut_epistémique')).toMatchObject({ type: 'enum', required: true });
  expect(s.tagKeys.get('auteur')!.multi).toBe(true);

  // The user's example.
  const mdl = s.nodes.get(ids.nodes.mdl)!;
  expect(mdl.title).toBe('Minimum Description Length Principle (MDL)');
  expect(mdl.tags).toContainEqual({ key: 'statut_epistémique', value: 'consensus_scientifique' });
  expect(mdl.files.map((f) => f.name)).toEqual(['Enoncé_détaillé.tex', 'calcul_mdl_séquence_aléatoire.py', 'mesures_compression.csv', 'notes_lecture.md']);
  for (const f of mdl.files) expect(existsSync(filePath(dir, f))).toBe(true);
  for (const k of ['solomonoff', 'universalite', 'monde'] as const) expect(s.nodes.has(ids.nodes[k])).toBe(true);
  expect(s.nodes.size).toBeGreaterThanOrEqual(24);

  // Connections, by kind and shape.
  const ms = s.connections.get(ids.connections.mdlSolomonoff)!;
  expect(ms.tags).toContainEqual({ key: 'parallèle' });
  expect(ms.relation).not.toBe('');
  expect(roles(ids.connections.mdlSolomonoff)).toBe('associate,associate');
  expect(roles(ids.connections.twoToOne)).toBe('source,source,target');
  expect(roles(ids.connections.twoToTwo)).toBe('source,source,target,target');
  for (const kind of ['knowledge', 'inclusion', 'structure']) expect(live.some((c) => c.kind === kind)).toBe(true);

  // Groups: three levels in the lobby, another group for the same node in "Thèse", a node only in "Thèse".
  expect(Math.max(...[...s.nodes.keys()].map((n) => ancestors(s, ids.plans.lobby, n).length))).toBe(3);
  const g1 = groupOf(s, ids.plans.lobby, ids.nodes.mdl), g2 = groupOf(s, ids.plans.these, ids.nodes.mdl);
  expect(g1 && g2 && g1 !== g2).toBe(true);
  expect(placedIn(ids.nodes.theseOnly)).toEqual([ids.plans.these]);

  // A stub: a branch shown in "Thèse" whose node is not placed there.
  const stubs = [...s.branches].filter((b) => b.plan === ids.plans.these && !s.placements.has(placementKey(b.plan, b.node)));
  expect(stubs.length).toBeGreaterThan(0);

  // Split arm: two phantoms, one of them in a group.
  const phantoms = [...s.phantoms.values()];
  expect(phantoms.map((p) => p.of.kind).sort()).toEqual(['center', 'node']);
  expect(phantoms.some((p) => p.group !== undefined)).toBe(true);

  // Document: parts 1 to 3, a sub-part, a chain of "suivant".
  const structure = live.filter((c) => c.kind === 'structure');
  const parts = structure.filter((c) => c.tags.some((t) => t.key === 'partie'));
  const rootParts = parts.filter((c) => c.members.some((m) => m.role === 'source' && m.node === ids.nodes.docRoot));
  expect(rootParts.map((c) => c.tags.find((t) => t.key === 'partie')!.value).sort()).toEqual([1, 2, 3]);
  expect(parts.length).toBeGreaterThan(rootParts.length);
  expect(structure.filter((c) => c.tags.some((t) => t.key === 'suivant')).length).toBeGreaterThanOrEqual(2);

  // Files and publications.
  const pub = s.nodes.get(ids.nodes.publication)!;
  expect(pub.tags.filter((t) => t.key === 'auteur')).toHaveLength(2);
  expect(pub.tags.some((t) => t.key === 'date_de_publication')).toBe(true);
  // A one-page PDF and a three-page one (plan 4a, task 6: the reader's capture shows two pages).
  expect(pub.files.map((f) => f.name)).toEqual(['Li_Vitányi_extrait.pdf', 'Li_Vitányi_chapitre_1.pdf']);
  expect([...s.nodes.values()].some((n) => n.files.some((f) => f.name.endsWith('.png')))).toBe(true);
  // A format the app does not show (plan 4a): opened by the system's application.
  expect(s.nodes.get(ids.nodes.theseOnly)!.files.map((f) => f.name)).toEqual(['présentation.pptx']);

  // Trash and history.
  expect(store.trash().map((n) => n.id)).toEqual([ids.nodes.trashed]);
  expect(store.changesSince(0).some((r) => r.label.startsWith('Annuler : '))).toBe(true);
  store.close();
});

test('le CSV est en octets Windows-1252, à points-virgules et virgules décimales, comme l’écrit l’Excel français ; les notes en UTF-8', () => {
  const store = LocalStore.open(dir, { pc: 'fixture' });
  const ids = buildFixture(store, dir);
  const files = store.loadState().nodes.get(ids.nodes.mdl)!.files;
  const blob = (name: string) => readFileSync(filePath(dir, files.find((f) => f.name === name)!));
  const csv = blob('mesures_compression.csv');
  // « Éléments;Durée », one byte per accented letter.
  expect([...csv.subarray(0, 14)]).toEqual([0xc9, 0x6c, 0xe9, 0x6d, 0x65, 0x6e, 0x74, 0x73, 0x3b, 0x44, 0x75, 0x72, 0xe9, 0x65]);
  // €, ’ and œ: bytes Windows-1252 has and Latin-1 has not.
  for (const b of [0x80, 0x92, 0x9c]) expect(csv.includes(b), b.toString(16)).toBe(true);
  expect(csv.includes(0xc3)).toBe(false); // no UTF-8 « é » (C3 A9) nor « É » (C3 89)
  expect(() => new TextDecoder('utf-8', { fatal: true }).decode(csv)).toThrow();
  const lines = new TextDecoder('windows-1252').decode(csv).split('\r\n');
  expect(lines.at(-1)).toBe('');
  expect(lines[0]).toBe('Éléments;Durée (s);Taux de compression;Méthode;Coût (€);Remarque');
  expect(lines[1]).toMatch(/^\d+;\d+,\d+;\d+,\d+;/);
  const md = blob('notes_lecture.md');
  expect([...md.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
  expect(new TextDecoder('utf-8', { fatal: true }).decode(md)).toMatch(/^# Notes de lecture/);
  store.close();
});

test('le PDF de trois pages est celui qu’écrit chapterPdf, sans dépendance : xref exacte, trois pages de texte, liens internes et externes (plan 4a, tâche 6)', () => {
  const store = LocalStore.open(dir, { pc: 'fixture' });
  const ids = buildFixture(store, dir);
  const f = store.loadState().nodes.get(ids.nodes.publication)!.files.find((x) => x.name === 'Li_Vitányi_chapitre_1.pdf')!;
  const bytes = readFileSync(filePath(dir, f));
  store.close();
  // The asset is the script's output (scripts/make-pdf.ts), byte for byte: the two never drift apart.
  expect(Buffer.from(chapterPdf()).equals(bytes)).toBe(true);
  // Written in ASCII only (accents as octal escapes): a byte offset is a character offset.
  expect(bytes.every((b) => b < 0x80)).toBe(true);
  const text = bytes.toString('latin1');
  expect(text.startsWith('%PDF-1.4\n')).toBe(true);
  expect(text.endsWith('%%EOF\n')).toBe(true);
  // startxref points at the table, and each entry at its object.
  const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)![1]);
  expect(text.slice(start, start + 5)).toBe('xref\n');
  const [, count] = /^xref\n0 (\d+)\n/.exec(text.slice(start))!.map(Number);
  const entries = text.slice(start).split('\n').slice(2, 2 + count);
  expect(entries[0]).toBe('0000000000 65535 f ');
  for (let i = 1; i < count; i++) {
    expect(entries[i], `objet ${i}`).toMatch(/^\d{10} 00000 n $/);
    const at = Number(entries[i].slice(0, 10));
    expect(text.slice(at, at + `${i} 0 obj`.length), `objet ${i}`).toBe(`${i} 0 obj`);
  }
  expect(text).toContain(`trailer\n<< /Size ${count} /Root 1 0 R >>`);
  // Three pages, each with its text; links to pages 2 and 3, back to page 1, to a web page and to an address.
  expect(text).toContain('/Type /Pages /Kids [');
  expect(text).toContain('/Count 3');
  expect(text.match(/\/Type \/Page /g)).toHaveLength(3);
  expect(text.match(/\/Subtype \/Link/g)!.length).toBeGreaterThanOrEqual(5);
  expect(text).toContain('/URI (https://example.org/complexite-de-kolmogorov)');
  expect(text).toContain('/URI (mailto:auteur@example.org)');
  expect(text.match(/\/Dest \[\d+ 0 R \/XYZ /g)!.length).toBeGreaterThanOrEqual(3);
  // « Préliminaires », in Windows-1252 (WinAnsiEncoding): « é » is byte E9, written \351.
  expect(text).toContain('(Chapitre 1 \\227 Pr\\351liminaires)');
});

test('le matériau LaTeX (plan 4b) : clé BibTeX, label de titre, .tex et image de Kolmogorov, résumé et relation en LaTeX', () => {
  const store = LocalStore.open(dir, { pc: 'fixture' });
  const ids = buildFixture(store, dir);
  const s = store.loadState();
  const node = (k: keyof typeof ids.nodes) => s.nodes.get(ids.nodes[k])!;
  const text = { type: 'text', scope: 'node', multi: false, required: false };
  expect([s.tagKeys.get(CITE_KEY_TAG), s.tagKeys.get(LABEL_TAG)]).toEqual([{ key: 'clé_bibtex', ...text }, { key: 'label', ...text }]);
  expect(node('publication').tags).toContainEqual({ key: 'clé_bibtex', value: 'li2008' });
  expect(node('solomonoff').tags).toContainEqual({ key: 'label', value: 'solomonoff' });
  // Kolmogorov's .tex, and the very bytes of Compression's image: one copy in the store, under one hash.
  const files = node('kolmogorov').files;
  expect(files.map((f) => f.name)).toEqual(['complexité.tex', 'schéma_compression.png']);
  expect(files[1]).toEqual(node('compression').files.find((f) => f.name === 'schéma_compression.png'));
  const tex = readFileSync(filePath(dir, files[0]), 'utf8');
  expect(tex.startsWith('\\section{Complexité de Kolmogorov}\\label{kc:section}\n')).toBe(true);
  expect(tex).toContain('\\includegraphics[width=3cm]{schéma_compression.png}');
  expect(node('entropie').summary).toBe(String.raw`Pour une source $X$ de loi $p$ :\begin{equation}\label{ent:def}H(X) = -\sum_x p(x) \log_2 p(x)\end{equation}en bits.`);
  const deduction = [...s.connections.values()].filter((c) => c.title === 'Déduction jointe');
  expect(deduction.map((c) => c.relation)).toEqual([String.raw`Ensemble, $K(x) \le L_{\mathrm{MDL}}(x) + O(1)$.`]);
  // What complexité.tex refers to is defined in the base (a .tex of a node, a summary, a relation, a label tag), but
  // for the one link meant to be broken; what it cites is a BibTeX key of the base.
  const defined = new Set<string>();
  const labels = (t: string) => { for (const m of t.matchAll(/\\label\{([^}]*)\}/g)) defined.add(m[1]); };
  for (const n of s.nodes.values()) {
    labels(n.summary);
    for (const t of n.tags) if (t.key === LABEL_TAG) defined.add(String(t.value));
    for (const f of n.files) if (f.name.endsWith('.tex')) labels(readFileSync(filePath(dir, f), 'utf8'));
  }
  for (const c of s.connections.values()) labels(c.relation);
  const refs = [...tex.matchAll(/\\(?:eq)?ref\{([^}]*)\}/g)].map((m) => m[1]);
  expect(refs.filter((r) => defined.has(r)).sort()).toEqual(['ent:def', 'kc:def', 'mdl:enonce', 'solomonoff']);
  expect(refs.filter((r) => !defined.has(r))).toEqual(['absent:label']);
  const keys = [...s.nodes.values()].flatMap((n) => n.tags.filter((t) => t.key === CITE_KEY_TAG).map((t) => t.value));
  expect([...tex.matchAll(/\\cite\{([^}]*)\}/g)].map((m) => m[1])).toEqual(keys);
  store.close();
});

test('les annotations de PDF (plan 4c) : pages 1 et 2 du chapitre, une sur sa version d’avant la réimportation ; la publication groupe la première dans « Lecture »', () => {
  const store = LocalStore.open(dir, { pc: 'fixture' });
  const ids = buildFixture(store, dir);
  const s = store.loadState(), labels = store.changesSince(0).map((r) => r.label);
  store.close();
  const pub = s.nodes.get(ids.nodes.publication)!, chapter = pub.files.find((f) => f.name === 'Li_Vitányi_chapitre_1.pdf')!;
  const [page1, page2, earlier] = (['annotationPage1', 'annotationPage2', 'annotationEarlier'] as const).map((k) => s.nodes.get(ids.nodes[k])!);
  for (const n of [page1, page2, earlier]) {
    expect(validAnchor(n.anchor), n.title).toBe(true);
    expect(n.anchor).toMatchObject({ pdf: pub.id, file: 'Li_Vitányi_chapitre_1.pdf' });
    expect(n.title).toBe(annotationTitle(n.anchor!.text, ANNOTATION_TITLE_CHARS));
    expect(n.trashedAt).toBeUndefined();
  }
  // The passages, as a selection gives them: lines joined by a line break, one rectangle per line, inside the page.
  expect([page1, page2, earlier].map((n) => [n.anchor!.page, n.anchor!.text])).toEqual([
    [1, 'La complexité de Kolmogorov d’une\nchaîne est la longueur du plus court programme qui l’écrit, à une constante près.'],
    [2, 'Un code est préfixe si aucun de ses mots n’est le début\nd’un autre : il se lit sans séparateur.'],
    [1, 'La complexité de Kolmogorov d’une\nchaîne est la taille du plus petit programme qui l’engendre.'],
  ]);
  expect(earlier.title).toBe('La complexité de Kolmogorov d’une chaîne est la taille du plus petit programme q…');
  for (const n of [page1, page2, earlier]) {
    const r = n.anchor!.rects;
    expect(r).toHaveLength(2);
    for (const [x0, y0, x1, y1] of r) expect(0 < x0 && x0 < x1 && x1 < 595 && 0 < y0 && y0 < y1 && y1 < 842, JSON.stringify(r)).toBe(true);
    // A selection from the middle of a line to the middle of the next: the second line from its start, above none of the first.
    expect(r[0][0]).toBeGreaterThan(72);
    expect(r[1][0]).toBe(72);
    expect(r[1][3]).toBeLessThan(r[0][1]);
  }
  // Two on the chapter as it is; one on its first version, other bytes, kept in the store under their hash (D2).
  expect([page1.anchor!.hash, page2.anchor!.hash]).toEqual([chapter.hash, chapter.hash]);
  const old = readFileSync(filePath(dir, { name: chapter.name, hash: earlier.anchor!.hash, size: 0 }));
  expect(earlier.anchor!.hash).not.toBe(chapter.hash);
  expect(createHash('sha256').update(old).digest('hex')).toBe(earlier.anchor!.hash);
  expect(Buffer.from(chapterPdf({ earlier: true })).equals(old)).toBe(true);
  // Re-imported by the fixture as the app does (plan 4a): the file replaced in its place, after the first annotation.
  expect(pub.files.map((f) => f.name)).toEqual(['Li_Vitányi_extrait.pdf', 'Li_Vitányi_chapitre_1.pdf']);
  const at = (label: string) => labels.indexOf(label);
  expect(at('Remplacer « Li_Vitányi_chapitre_1.pdf »')).toBeGreaterThan(at(`Annoter « ${earlier.title} », p. 1`));
  expect(at(`Annoter « ${page1.title} », p. 1`)).toBeGreaterThan(at('Remplacer « Li_Vitányi_chapitre_1.pdf »'));
  // Page 1's in « Lecture », in the publication's node, a group there only; the other two in no plan.
  const placed = (node: string) => [...s.placements.values()].filter((p) => p.node === node).map((p) => p.plan).sort();
  expect(s.plans.get(ids.plans.lecture)).toMatchObject({ name: 'Lecture', type: 'plan' });
  expect(placed(page1.id)).toEqual([ids.plans.lecture]);
  expect([placed(page2.id), placed(earlier.id)]).toEqual([[], []]);
  expect(placed(pub.id)).toEqual([ids.plans.lobby, ids.plans.lecture].sort());
  expect(groupOf(s, ids.plans.lecture, page1.id)).toBe(pub.id);
  expect([...s.nodes.keys()].filter((n) => groupOf(s, ids.plans.lobby, n) === pub.id)).toEqual([]);
  // A publication's identifiers (D7): text tags of a node, one value.
  const text = { type: 'text', scope: 'node', multi: false, required: false };
  expect([s.tagKeys.get('doi'), s.tagKeys.get('arxiv')]).toEqual([{ key: 'doi', ...text }, { key: 'arxiv', ...text }]);
});

test('réouverture identique', () => {
  const store = LocalStore.open(dir, { pc: 'fixture' });
  buildFixture(store, dir);
  const before = snapshot(store.loadState());
  store.close();
  const again = LocalStore.open(dir, { pc: 'fixture' });
  expect(snapshot(again.loadState())).toBe(before);
  again.close();
});
