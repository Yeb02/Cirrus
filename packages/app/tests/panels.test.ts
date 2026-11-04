import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOps, CommandError, deleteEverywhere, invertAction, type State, TagError, type TagValue } from '@cirrus/core';
import { buildFixture, type FixtureIds } from '@cirrus/fixtures';
import { LocalStore } from '@cirrus/store';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { filesBuild, removeFileBuild, summaryBuild, tagsBuild } from '../src/renderer/actions.ts';
import { parseTag, tagSuggestions, withoutTag, withTag } from '../src/renderer/files/tags.ts';
import { clampRect, dragRect, HEADER_PX, placeAt, type Rect } from '../src/renderer/ui/panels/geometry.ts';
import {
  closedIds, inFront, nodeOpenedBy, openingRect, type Panel, resolveTarget, withNode, withoutLoose, withoutTopLoose,
} from '../src/renderer/ui/panels/Panels.tsx';

// One test base for the whole file, never the user's: each test reads its state from the store again.
let dir: string, store: LocalStore, ids: FixtureIds;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cirrus-panels-'));
  store = LocalStore.open(dir, { pc: 'test' });
  ids = buildFixture(store, dir);
});
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The captures' window: the area under the tabs, 1584 × 923 from y = 38. */
const SCREEN: Rect = { x: 0, y: 38, w: 1584, h: 923 };
const right = (b: Rect) => b.x + b.w, bottom = (b: Rect) => b.y + b.h;
const inside = (r: Rect, b: Rect) => r.x >= b.x && r.y >= b.y && right(r) <= right(b) && bottom(r) <= bottom(b);
const SIZE = { w: 380, h: 460 };

test('placeAt : à droite et en dessous du clic ; au coin bas-droit, retourné à gauche et au-dessus, entier dans l’écran', () => {
  expect(placeAt({ x: 100, y: 100 }, SIZE, SCREEN, 12)).toEqual({ x: 112, y: 112, w: 380, h: 460 });
  const corner = placeAt({ x: 1580, y: 955 }, SIZE, SCREEN, 12);
  expect(corner).toEqual({ x: 1580 - 12 - 380, y: 955 - 12 - 460, w: 380, h: 460 });
  expect(inside(corner, SCREEN)).toBe(true);
  // Room on neither side: against the edge it would cross, still whole.
  const tall = placeAt({ x: 100, y: 500 }, { w: 380, h: 800 }, SCREEN, 12);
  expect(tall).toEqual({ x: 112, y: bottom(SCREEN) - 800, w: 380, h: 800 });
  // Larger than the screen: as large as the screen.
  expect(placeAt({ x: 10, y: 50 }, { w: 3000, h: 2000 }, SCREEN, 12)).toEqual(SCREEN);
});

test('clampRect : un panneau tiré hors de l’écran garde son en-tête visible, et sa taille ne descend pas sous min', () => {
  const down = clampRect({ x: -900, y: 5000, w: 50, h: 20 }, SCREEN, 200);
  expect(down).toEqual({ x: 0, y: bottom(SCREEN) - HEADER_PX, w: 200, h: 200 });
  const up = clampRect({ x: 3000, y: -400, w: 380, h: 460 }, SCREEN, 200);
  expect(up).toEqual({ x: right(SCREEN) - 380, y: SCREEN.y, w: 380, h: 460 });
  for (const r of [down, up]) expect(inside({ ...r, h: HEADER_PX }, SCREEN)).toBe(true);
  // Inside already: unchanged; larger than the screen: as large as it.
  expect(clampRect({ x: 100, y: 100, w: 380, h: 460 }, SCREEN, 200)).toEqual({ x: 100, y: 100, w: 380, h: 460 });
  expect(clampRect({ x: 0, y: 0, w: 4000, h: 4000 }, SCREEN, 200)).toEqual(SCREEN);
});

test('dragRect : déplacer, élargir par le bord droit, allonger par le bas, les deux par le coin', () => {
  const r: Rect = { x: 100, y: 100, w: 380, h: 460 };
  expect(dragRect(r, 'move', 30, -20, SCREEN, 200)).toEqual({ x: 130, y: 80, w: 380, h: 460 });
  expect(dragRect(r, 'move', -500, -500, SCREEN, 200)).toEqual({ x: 0, y: SCREEN.y, w: 380, h: 460 });
  expect(dragRect(r, 'move', 0, 5000, SCREEN, 200).y).toBe(bottom(SCREEN) - HEADER_PX);
  // An edge moves its own side only, never under min, never out of the screen.
  expect(dragRect(r, 'e', 50, 999, SCREEN, 200)).toEqual({ x: 100, y: 100, w: 430, h: 460 });
  expect(dragRect(r, 'e', -400, 0, SCREEN, 200)).toEqual({ x: 100, y: 100, w: 200, h: 460 });
  expect(dragRect(r, 'e', 5000, 0, SCREEN, 200)).toEqual({ x: 100, y: 100, w: right(SCREEN) - 100, h: 460 });
  expect(dragRect(r, 's', 999, 40, SCREEN, 200)).toEqual({ x: 100, y: 100, w: 380, h: 500 });
  expect(dragRect(r, 's', 0, -1000, SCREEN, 200)).toEqual({ x: 100, y: 100, w: 380, h: 200 });
  expect(dragRect(r, 's', 0, 5000, SCREEN, 200)).toEqual({ x: 100, y: 100, w: 380, h: bottom(SCREEN) - 100 });
  expect(dragRect(r, 'se', 20, 30, SCREEN, 200)).toEqual({ x: 100, y: 100, w: 400, h: 490 });
  expect(dragRect(r, 'se', -1000, -1000, SCREEN, 200)).toEqual({ x: 100, y: 100, w: 200, h: 200 });
});

test('resolveTarget (Review Focus 5) : null après la suppression du nœud partout, le retrait du fichier, l’annulation de son ajout', () => {
  const s: State = store.loadState(), mdl = ids.nodes.mdl;
  const node = { kind: 'node', node: mdl } as const, notes = { kind: 'file', node: mdl, name: 'notes_lecture.md' } as const;
  expect(resolveTarget(s, node)?.node.id).toBe(mdl);
  expect(resolveTarget(s, notes)?.file?.name).toBe('notes_lecture.md');
  // The file taken out: its target is gone, the node's stays.
  applyOps(s, removeFileBuild(mdl, 'notes_lecture.md')!(s).ops);
  expect(resolveTarget(s, notes)).toBeNull();
  expect(resolveTarget(s, node)?.node.id).toBe(mdl);
  // A file added, then the addition undone.
  const added = filesBuild(s, mdl, [{ name: 'nouveau.txt', hash: 'a'.repeat(64), size: 3 }])!(s);
  applyOps(s, added.ops);
  const nouveau = { kind: 'file', node: mdl, name: 'nouveau.txt' } as const;
  expect(resolveTarget(s, nouveau)?.file?.size).toBe(3);
  applyOps(s, invertAction(added).ops);
  expect(resolveTarget(s, nouveau)).toBeNull();
  // The node deleted everywhere (in the trash): neither it nor its files.
  applyOps(s, deleteEverywhere(s, mdl).ops);
  expect(resolveTarget(s, node)).toBeNull();
  expect(resolveTarget(s, { kind: 'file', node: mdl, name: 'Enoncé_détaillé.tex' })).toBeNull();
  expect(resolveTarget(s, { kind: 'node', node: 'jamais-vu' })).toBeNull();
});

test('panneaux : un nœud ouvert ferme les non épinglés, garde les épinglés, n’a jamais deux pop-ups ; Échap ferme le plus haut', () => {
  const at = (x: number): Rect => ({ x, y: 100, w: 380, h: 460 });
  let ps: Panel[] = withNode([], 'a', at(10), 1);
  expect(ps).toEqual([{ id: 1, target: { kind: 'node', node: 'a' }, rect: at(10), pinned: false, z: 1 }]);
  // Another node: the loose one closes; each new one goes above every panel there was.
  ps = withNode(ps, 'b', at(20), 2);
  expect(ps.map((p) => [p.id, p.z])).toEqual([[2, 2]]);
  // Pinned, it stays when a third opens; the third is in front.
  ps = withNode(ps.map((p) => ({ ...p, pinned: true })), 'c', at(30), 3);
  expect(ps.map((p) => [p.id, p.pinned, p.z])).toEqual([[2, true, 2], [3, false, 3]]);
  // The pinned node's pop-up asked for again: no second one, it comes in front where it was; the loose one closes.
  ps = withNode(ps, 'b', at(99), 4);
  expect(ps.map((p) => [p.id, p.rect.x, p.z])).toEqual([[2, 20, 4]]);
  // The loose node's own pop-up asked for again: it stays, in front.
  ps = withNode(ps, 'd', at(40), 5);
  const again = withNode(ps, 'd', at(77), 6);
  expect(again.map((p) => [p.id, p.rect.x])).toEqual([[2, 20], [5, 40]]);
  // A click on a panel brings it in front; on the front one, nothing changes.
  expect(inFront(ps, 2).find((p) => p.id === 2)!.z).toBe(6);
  expect(inFront(ps, 5)).toBe(ps);
  // Escape closes the top-most loose panel, never a pinned one; a click elsewhere, every loose one.
  const loose2 = withNode(ps.map((p) => ({ ...p, pinned: p.id === 2 })), 'e', at(50), 7);
  expect(withoutTopLoose([...loose2, { id: 8, target: { kind: 'node', node: 'f' }, rect: at(60), pinned: false, z: 1 }]).map((p) => p.id)).toEqual([2, 8]);
  expect(withoutTopLoose(loose2.filter((p) => p.pinned))).toEqual(loose2.filter((p) => p.pinned));
  expect(withoutLoose(loose2).map((p) => p.id)).toEqual([2]);
});

test('fermeture : les panneaux qu’une règle ferme, dont un champ en cours de saisie est quitté d’abord (I1 de la relecture)', () => {
  const at: Rect = { x: 10, y: 100, w: 380, h: 460 };
  const ps: Panel[] = [
    { id: 1, target: { kind: 'node', node: 'a' }, rect: at, pinned: true, z: 1 },
    { id: 2, target: { kind: 'node', node: 'b' }, rect: at, pinned: false, z: 2 },
    { id: 3, target: { kind: 'node', node: 'c' }, rect: at, pinned: false, z: 3 },
  ];
  expect(closedIds(ps, withoutLoose(ps))).toEqual([2, 3]);
  expect(closedIds(ps, withoutTopLoose(ps))).toEqual([3]);
  // A new node's pop-up closes the loose ones; asked again, a loose pop-up stays (only the others close).
  expect(closedIds(ps, withNode(ps, 'd', at, 4))).toEqual([2, 3]);
  expect(closedIds(ps, withNode(ps, 'b', at, 4))).toEqual([3]);
  expect(closedIds(ps, inFront(ps, 2))).toEqual([]);
  expect(closedIds(ps, ps.filter((p) => p.id !== 1))).toEqual([1]);
});

test('clic dans le graphe : un nœud, un groupe ou le fantôme d’un nœud lointain ouvre un pop-up ; tout autre clic ferme les non épinglés', () => {
  const node = { kind: 'node', id: 'n', node: 'n' } as const, group = { kind: 'group', id: 'g', node: 'g' } as const;
  const far = { kind: 'phantom', id: 'ph1', node: 'loin', phantom: 'node' } as const;
  expect(nodeOpenedBy(node, false)).toBe('n');
  expect(nodeOpenedBy(group, false)).toBe('g');
  // Spec 8.5: the far node's phantom opens that node's pop-up, as the original would.
  expect(nodeOpenedBy(far, false)).toBe('loin');
  // An absent phantom brings its node in, a centre phantom opens its connection's pop-up: no node pop-up.
  expect(nodeOpenedBy({ kind: 'phantom', id: 'ph2', node: 'loin', phantom: 'absent' }, false)).toBeNull();
  expect(nodeOpenedBy({ kind: 'phantom', id: 'ph3', node: 'loin', phantom: 'center' }, false)).toBeNull();
  // Ctrl+click builds a selection; the background, a connection or a stub designate no item.
  expect(nodeOpenedBy(node, true)).toBeNull();
  expect(nodeOpenedBy(undefined, false)).toBeNull();
});

test('openingRect : la taille d’ouverture n’est jamais sous panelMinPx (Minor 2 de la relecture)', () => {
  const p = { popupWidthPx: 380, popupHeightPx: 460, panelMinPx: 200, panelGapPx: 12 };
  expect(openingRect({ x: 100, y: 100 }, p, SCREEN)).toEqual({ x: 112, y: 112, w: 380, h: 460 });
  expect(openingRect({ x: 100, y: 100 }, { ...p, popupHeightPx: 160, popupWidthPx: 150 }, SCREEN)).toEqual({ x: 112, y: 112, w: 200, h: 200 });
  expect(openingRect({ x: 1580, y: 955 }, { ...p, panelMinPx: 600 }, SCREEN)).toEqual({ x: 1580 - 12 - 600, y: 955 - 12 - 600, w: 600, h: 600 });
});

test('parseTag, sur le registre de la base de test : mot, nombre à virgule, énumération par nom et par rang', () => {
  const defs = store.loadState().tagKeys;
  expect(parseTag('algorithmie', defs)).toEqual({ key: 'algorithmie' });
  expect(parseTag('  théorie de l’information ', defs)).toEqual({ key: 'théorie de l’information' });
  expect(parseTag('provenance:externe', defs)).toEqual({ key: 'provenance', value: 'externe' });
  expect(parseTag('nature : principe premier', defs)).toEqual({ key: 'nature', value: 'principe premier' });
  expect(parseTag('partie:1,5', defs)).toEqual({ key: 'partie', value: 1.5 });
  expect(parseTag('partie : -2.25', defs)).toEqual({ key: 'partie', value: -2.25 });
  expect(parseTag('partie:3', defs)).toEqual({ key: 'partie', value: 3 });
  expect(parseTag('pertinence:central', defs)).toEqual({ key: 'pertinence', value: 'central' });
  expect(parseTag('pertinence:5', defs)).toEqual({ key: 'pertinence', value: 'central' });
  expect(parseTag('statut_epistémique : 2', defs)).toEqual({ key: 'statut_epistémique', value: 'hypothèse' });
  // A key the registry does not know is kept as typed; the value runs from the first colon.
  expect(parseTag('couleur:bleu', defs)).toEqual({ key: 'couleur', value: 'bleu' });
  expect(parseTag('lien:https://example.org', defs)).toEqual({ key: 'lien', value: 'https://example.org' });
});

test('parseTag : une erreur lève TagError, avec un message français', () => {
  const defs = store.loadState().tagKeys;
  const refusal = (input: string): string => {
    try {
      parseTag(input, defs);
    } catch (e) {
      expect(e).toBeInstanceOf(TagError);
      return (e as Error).message;
    }
    throw new Error(`« ${input} » accepté`);
  };
  expect(refusal('pertinence:capitale')).toBe('Valeur « capitale » inconnue pour le tag « pertinence ».');
  expect(refusal('pertinence:9')).toBe('Valeur « 9 » inconnue pour le tag « pertinence ».');
  expect(refusal('partie:deux')).toBe('Le tag « partie » demande un nombre : « deux » n’en est pas un.');
  expect(refusal('pertinence')).toBe('Le tag « pertinence » demande une valeur : « pertinence:… ».');
  expect(refusal('nature:')).toBe('Le tag « nature » demande une valeur : « nature:… ».');
  expect(refusal('parallèle:oui')).toBe('Le tag « parallèle » ne prend pas de valeur.');
  expect(refusal('mot:')).toBe('Il manque la valeur après « mot: ».');
  expect(refusal(':valeur')).toBe('Il manque le nom du tag avant « : ».');
  expect(refusal('   ')).toBe('Le tag est vide.');
});

test('withTag et withoutTag : une clé non multiple remplace sa valeur, une clé multiple s’ajoute', () => {
  const defs = store.loadState().tagKeys;
  const tags: TagValue[] = [{ key: 'pertinence', value: 'utile' }, { key: 'axiome' }, { key: 'auteur', value: 'Ming Li' }];
  // Replaced in its place.
  expect(withTag(tags, { key: 'pertinence', value: 'central' }, defs)).toEqual([{ key: 'pertinence', value: 'central' }, tags[1], tags[2]]);
  expect(withTag(tags, { key: 'auteur', value: 'Paul Vitányi' }, defs)).toEqual([...tags, { key: 'auteur', value: 'Paul Vitányi' }]);
  expect(withTag(tags, { key: 'nature', value: 'principe' }, defs)).toEqual([...tags, { key: 'nature', value: 'principe' }]);
  // A key the registry does not know takes one value, like a key declared single.
  expect(withTag([{ key: 'couleur', value: 'bleu' }], { key: 'couleur', value: 'vert' }, defs)).toEqual([{ key: 'couleur', value: 'vert' }]);
  // Already there: the same list, nothing to write.
  expect(withTag(tags, { key: 'auteur', value: 'Ming Li' }, defs)).toBe(tags);
  expect(withTag(tags, { key: 'axiome' }, defs)).toBe(tags);
  expect(withTag(tags, { key: 'pertinence', value: 'utile' }, defs)).toBe(tags);
  // Taken out: that tag only, one value of a multiple key.
  const two = withTag(tags, { key: 'auteur', value: 'Paul Vitányi' }, defs);
  expect(withoutTag(two, { key: 'auteur', value: 'Ming Li' })).toEqual([tags[0], tags[1], { key: 'auteur', value: 'Paul Vitányi' }]);
  expect(withoutTag(tags, { key: 'axiome' })).toEqual([tags[0], tags[2]]);
  expect(withoutTag(tags, { key: 'auteur', value: 'Anon' })).toBe(tags);
});

test('suggestions de tags : les clés du registre pour un nœud, puis les valeurs de l’énumération', () => {
  const defs = store.loadState().tagKeys;
  const keys = (text: string) => tagSuggestions(text, defs, 'node', 8).map((t) => t.key);
  // The connections' keys (parallèle, partie…) are not offered to a node.
  expect(keys('')).toEqual(['statut_epistémique', 'pertinence', 'nature', 'provenance', 'auteur', 'date_de_publication']);
  // Those that begin with the text first, without case or accents.
  expect(keys('P')).toEqual(['pertinence', 'provenance', 'statut_epistémique', 'date_de_publication']);
  expect(keys('epis')).toEqual(['statut_epistémique']);
  expect(tagSuggestions('pertinence:', defs, 'node', 3)).toEqual([
    { key: 'pertinence', value: 'anecdotique', rank: 1 }, { key: 'pertinence', value: 'secondaire', rank: 2 }, { key: 'pertinence', value: 'utile', rank: 3 },
  ]);
  expect(tagSuggestions('pertinence : imp', defs, 'node', 8)).toEqual([{ key: 'pertinence', value: 'important', rank: 4 }]);
  expect(tagSuggestions('pertinence:5', defs, 'node', 8)).toEqual([{ key: 'pertinence', value: 'central', rank: 5 }]);
  expect(tagSuggestions('nature:', defs, 'node', 8)).toEqual([]);
});

test('tagsBuild et summaryBuild : calculés sur l’état du moment ; un tag déjà là est refusé plutôt qu’écrit vide', () => {
  const s = store.loadState(), mdl = ids.nodes.mdl;
  const tagsOf = () => s.nodes.get(mdl)!.tags;
  const before = tagsOf();
  expect(() => tagsBuild(mdl, (t, d) => withTag(t, { key: 'axiome' }, d))!(s)).toThrow(new CommandError('Ces tags sont déjà à jour.'));
  const added = tagsBuild(mdl, (t, d) => withTag(t, { key: 'pertinence', value: 'utile' }, d))!(s);
  applyOps(s, added.ops);
  expect(tagsOf()).toEqual(before.map((t) => (t.key === 'pertinence' ? { key: 'pertinence', value: 'utile' } : t)));
  applyOps(s, tagsBuild(mdl, (t) => withoutTag(t, { key: 'axiome' }))!(s).ops);
  expect(tagsOf().some((t) => t.key === 'axiome')).toBe(false);
  applyOps(s, summaryBuild(mdl, '$K(x) \\leq |x| + c$')!(s).ops);
  expect(s.nodes.get(mdl)!.summary).toBe('$K(x) \\leq |x| + c$');
  expect(() => tagsBuild('jamais-vu', (t) => t)!(s)).toThrow(new CommandError('Nœud introuvable.'));
});
