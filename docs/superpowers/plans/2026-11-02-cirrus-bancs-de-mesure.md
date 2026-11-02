# Cirrus, plan 1 : bancs de mesure — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** mesurer, avant toute autre construction, si Electron + PixiJS tiennent le rendu du graphe au volume visé, et si un pdfLaTeX préchauffé compile un nœud en moins de 300 ms.

**Architecture :** deux bancs jetables dans `bench/`, sans aucun code partagé avec la future app.
- `bench/rendu` est une app Electron qui charge une scène synthétique de 50 000 nœuds et 500 000 connexions. Elle la dessine avec PixiJS, en ne traitant que ce qui est visible et déplié, rejoue un parcours de caméra, mesure les temps par image et écrit un rapport.
- `bench/latex` est un module Node qui pilote un pdfLaTeX TinyTeX local, à froid et préchauffé, sur des fragments types, et écrit un rapport.

Le dernier livrable est une synthèse des résultats. Elle décide de la suite : continuer, prévoir un mode performance, ou ajouter `mylatexformat`.

**Tech Stack :** Node.js LTS, TypeScript (strict), npm workspaces, Electron, electron-vite, PixiJS v8, flatbush, Vitest, TinyTeX (pdfLaTeX), msdf-bmfont-xml.

**Spec :** `C:\Users\alpha\Desktop\Cirrus\2026-11-02-cirrus-design.md`, sections 3, 8, 13, 19 et 21. Les exécutants lisent la spec et ce plan.

## Place dans le projet (feuille de route)

Le design est découpé en plans successifs. Chacun produit un logiciel testable, et chacun ne sera écrit qu'une fois le précédent terminé, pour tenir compte de ce qu'il a appris.

1. **Bancs de mesure** : ce plan.
2. **Socle :** dépôt de l'app, modèle de données partagé, base locale SQLite, historique, annulation, base de test artificielle.
3. **Rendu et interactions :** plans, groupes, connexions, sélection, collage, répercussions entre plans, paramètres graphiques.
4. **Contenu des nœuds :** pop-ups, plein écran, chaîne LaTeX, PDF et annotations, import de publications.
5. **Serveur local et synchro :** synchro multi-PC, conflits, paramètres partagés, versions et « Cirrus Dev ».
6. **Navigation et outils :** recherche, précédent et suivant, santé du graphe, agenda, feuillets, analytics.
7. **Documents :** plan document, panneau sommaire, génération et export.
8. **LLM :** serveur MCP, veille, journal.
9. **Mise en production :** serveur loué, sécurité, intégration continue GitHub, mises à jour signées.

## Global Constraints

- Ce plan crée un dépôt git local dans `C:\Users\alpha\Desktop\Cirrus`. On n'y pousse rien vers GitHub sans demande de l'utilisateur.
- Tout le code des bancs vit sous `bench/`. Il est jetable, et la future app ne l'importera jamais. On y recopiera seulement les techniques validées.
- Identifiants et commentaires du code en anglais. Rapports et textes destinés à l'utilisateur en français.
- TypeScript en mode `strict`. Versions des dépendances : la dernière stable au moment de l'installation, figée par `package-lock.json`.
- Toutes les constantes de rendu sont regroupées dans un seul objet de paramètres, sans valeur en dur ailleurs, pour préfigurer les « paramètres graphiques avancés » de la spec (section 19).
- Défauts de rendu (spec 8.1, 8.2 et 8.5) :

| Paramètre | Valeur |
|---|---|
| Facteur entre crans `f` | 2 |
| Taille de base du texte | 16 px |
| Échelle de texte | 1 |
| Disparition du texte des nœuds | entre 6 et 8 px |
| Repli des groupes | entre 4,5 et 6,5 px |
| Titres de connexion | entre 6,5 et 9 px |
| Largeur de base d'une connexion | 1,5 px |
| Bornes de largeur | entre 1 et 5 px |
| Décalage d'un nouveau groupe | 2 crans |

- Volume de la scène synthétique : 50 000 nœuds et 500 000 connexions (spec 3 : « quelques dizaines de milliers de nœuds, et environ dix fois plus de connexions »).
- Critères du rendu (spec 21), mesurés sur le portable principal (RTX 4070 Laptop, 2560×1600, 165 Hz) :
  - p95 de l'intervalle entre images, sans synchronisation verticale, d'au plus 2 ms. C'est l'approximation du temps de la carte graphique.
  - p95 du temps processeur par image d'au plus 16 ms, avec un ralentissement ×4 du processeur.
  - Viser 165 images par seconde avec la synchronisation verticale. Ce dernier point est informatif.
- Critères LaTeX (spec 13) :
  - pdfLaTeX de TinyTeX installé dans `bench/latex/vendor/`, jamais sur le système ;
  - toujours `-no-shell-escape` ;
  - compilation sous des noms neutres (`job-<n>.tex`) ;
  - médiane préchauffée d'au plus 300 ms pour les fragments ordinaires.
- Windows est la plateforme de mesure. Linux n'est pas visé par ce plan.

## Review Focus

1. **Images plafonnées :** si la synchronisation verticale ou la limite d'images reste active, l'intervalle mesuré vaut 1000/165 ms et masque le temps réel de la carte graphique. Le rapport doit signaler une mesure plafonnée au lieu de conclure. Test dans la tâche 6.
2. **Mauvaise carte graphique :** le rendu peut tourner sur un rendu logiciel ou une autre carte. Le rapport doit nommer la carte utilisée, et le banc refuse de conclure si ce n'est pas la NVIDIA. Test dans la tâche 6.
3. **À-coups aux transitions :** l'ouverture d'un groupe, la reconstruction des connexions ou la génération des glyphes créent des pics que la médiane cache. Les critères portent sur le p95, et le rapport affiche aussi le maximum. Test dans la tâche 6.
4. **Compilation bloquée :** un fichier manquant ou une erreur fatale dans un nœud ne doit jamais laisser pdfLaTeX attendre une saisie. L'appel doit échouer vite, avec un message. Test dans la tâche 7.
5. **Noms accentués :** `\includegraphics{courbes_été.png}` doit produire un résultat déterminé, réussite ou erreur expliquée, jamais un blocage. Le rapport le consigne. Test dans la tâche 7.

---

### Task 1 : Socle du dépôt de bancs

**Files :**
- Create: `C:\Users\alpha\Desktop\Cirrus\package.json` (workspaces `bench/*`)
- Create: `C:\Users\alpha\Desktop\Cirrus\tsconfig.base.json`
- Create: `C:\Users\alpha\Desktop\Cirrus\.gitignore` (`node_modules/`, `out/`, `dist/`, `bench/latex/vendor/`, `bench/latex/work/`)
- Create: `bench/rendu/package.json`, `bench/rendu/tsconfig.json`, `bench/rendu/vitest.config.ts`
- Create: `bench/latex/package.json`, `bench/latex/tsconfig.json`, `bench/latex/vitest.config.ts`
- Test: `bench/rendu/tests/smoke.test.ts`

**Interfaces :**
- Produces : `npm test -w bench/rendu` et `npm test -w bench/latex` lancent Vitest.

- [ ] **Step 1 : installer Node.js LTS s'il est absent**

Run: `winget install OpenJS.NodeJS.LTS`, puis ouvrir un nouveau terminal et lancer `node --version`.
Expected : une version LTS paire (`v24.x` ou plus récente).

- [ ] **Step 2 : initialiser git et les fichiers racine**

Run: `git init`, à la racine `C:\Users\alpha\Desktop\Cirrus`. Le `tsconfig.base.json` contient `"strict": true`, `"target": "ES2022"` et `"module": "ESNext"`.

- [ ] **Step 3 : écrire le test de fumée**

```ts
// bench/rendu/tests/smoke.test.ts
import { test, expect } from 'vitest';
test('vitest tourne', () => { expect(1 + 1).toBe(2); });
```

- [ ] **Step 4 : installer et lancer**

Run: `npm install`, puis `npm test -w bench/rendu`.
Expected : 1 test PASS.

- [ ] **Step 5 : commit**

```bash
git add -A
git commit -m "chore: socle des bancs de mesure"
```

---

### Task 2 : Générateur de scène synthétique

**Files :**
- Create: `bench/rendu/src/scene/types.ts`
- Create: `bench/rendu/src/scene/params.ts`
- Create: `bench/rendu/src/scene/rng.ts`
- Create: `bench/rendu/src/scene/generate.ts`
- Test: `bench/rendu/tests/generate.test.ts`

**Interfaces :**
- Produces :

```ts
// types.ts
export interface Vec2 { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }
export type Role = 'source' | 'target' | 'associate';
export interface SceneNode { id: number; x: number; y: number; k: number; parent: number; r: number; title: string }
// parent = -1 au premier niveau ; r > 0 seulement pour un groupe (rayon du disque où sont placés ses membres)
export interface SceneConnection { id: number; members: { node: number; role: Role }[] }
export interface Scene { nodes: SceneNode[]; connections: SceneConnection[]; children: number[][] }
export interface Camera { x: number; y: number; zoom: number; widthPx: number; heightPx: number } // (x,y) = point du monde au centre ; zoom = px par unité monde
// params.ts
export interface RenderParams {
  factor: number; baseFontPx: number; textScale: number;
  textFade: [number, number]; groupFold: [number, number]; titleFade: [number, number];
  minNodePx: number; widthBasePx: number; widthMinPx: number; widthMaxPx: number;
  groupOffsetSteps: number; viewMarginPx: number;
  starCellWorld: number; starSpacingPx: [number, number]; starSizePx: number;
}
export const DEFAULT_PARAMS: RenderParams; // valeurs des Global Constraints ; minNodePx 4, viewMarginPx 200, starCellWorld 40, starSpacingPx [40, 160], starSizePx 1
export interface SceneSpec { seed: number; nodeCount: number; connectionCount: number; minChildren: number; maxChildren: number; groupShare: number; multiMemberShare: number; locality: [number, number, number] }
export const BENCH_SCENE: SceneSpec; // { seed: 1, nodeCount: 50_000, connectionCount: 500_000, minChildren: 4, maxChildren: 12, groupShare: 0.15, multiMemberShare: 0.1, locality: [0.8, 0.15, 0.05] }
// rng.ts
export function mulberry32(seed: number): () => number;
// generate.ts
export function generateScene(spec: SceneSpec, params: RenderParams): Scene;
```

- **Règles de la scène :**
  - Les membres d'un même groupe partagent le même cran.
  - Un groupe est `groupOffsetSteps` crans au-dessus de ses membres.
  - Les membres sont placés dans le disque de rayon `r` de leur groupe, sans se chevaucher : un espacement d'au moins 1,5 × la largeur de boîte à leur cran, avec 210 unités monde au cran 0, multipliées par `factor^k`.
- **Localité :** `locality` donne la part de connexions dont tous les membres ont le même parent, la part dont ils ont le même grand-parent, et la part quelconque.
- **Multi-membres :** une part `multiMemberShare` des connexions a de 3 à 5 membres, les autres 2.

- [ ] **Step 1 : écrire les tests qui échouent**

```ts
// bench/rendu/tests/generate.test.ts
import { test, expect } from 'vitest';
import { generateScene } from '../src/scene/generate';
import { DEFAULT_PARAMS } from '../src/scene/params';
const spec = { seed: 42, nodeCount: 2000, connectionCount: 20000, minChildren: 4, maxChildren: 12, groupShare: 0.15, multiMemberShare: 0.1, locality: [0.8, 0.15, 0.05] as [number, number, number] };

test('déterministe pour une graine donnée', () => {
  expect(JSON.stringify(generateScene(spec, DEFAULT_PARAMS))).toBe(JSON.stringify(generateScene(spec, DEFAULT_PARAMS)));
});
test('respecte les volumes', () => {
  const s = generateScene(spec, DEFAULT_PARAMS);
  expect(s.nodes.length).toBe(2000);
  expect(s.connections.length).toBe(20000);
});
test('chaque membre est dans le disque de son groupe', () => {
  const s = generateScene(spec, DEFAULT_PARAMS);
  for (const n of s.nodes) if (n.parent >= 0) {
    const g = s.nodes[n.parent];
    expect(Math.hypot(n.x - g.x, n.y - g.y)).toBeLessThanOrEqual(g.r);
  }
});
test('un groupe est groupOffsetSteps crans au-dessus de ses membres', () => {
  const s = generateScene(spec, DEFAULT_PARAMS);
  s.children.forEach((kids, g) => kids.forEach(c => expect(s.nodes[g].k - s.nodes[c].k).toBe(2)));
});
test('connexions valides et proportions', () => {
  const s = generateScene(spec, DEFAULT_PARAMS);
  let multi = 0, sameParent = 0;
  for (const c of s.connections) {
    const ids = c.members.map(m => m.node);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    if (ids.length >= 3) multi++;
    if (new Set(ids.map(i => s.nodes[i].parent)).size === 1) sameParent++;
  }
  expect(multi / s.connections.length).toBeGreaterThan(0.08);
  expect(multi / s.connections.length).toBeLessThan(0.12);
  expect(sameParent / s.connections.length).toBeGreaterThanOrEqual(0.75);
});
```

- [ ] **Step 2 : vérifier l'échec**

Run: `npm test -w bench/rendu -- generate`
Expected : FAIL (module introuvable).

- [ ] **Step 3 : implémenter `mulberry32`, `DEFAULT_PARAMS`, `BENCH_SCENE` et `generateScene(spec, params): Scene`**

Construction de haut en bas : on répartit `nodeCount` en une hiérarchie où chaque groupe a entre `minChildren` et `maxChildren` membres, dont une part `groupShare` sont eux-mêmes des groupes. On place les membres sur une grille légèrement perturbée à l'intérieur du disque, puis on tire les connexions selon `locality`. Titres : `Nœud <id>`, avec quelques accents et symboles (θ, ∑, ≤) pour exercer la police.

- [ ] **Step 4 : vérifier le succès**

Run: `npm test -w bench/rendu -- generate`
Expected : 5 tests PASS.

- [ ] **Step 5 : commit**

```bash
git add bench/rendu/src/scene bench/rendu/tests/generate.test.ts
git commit -m "feat(bench): scène synthétique déterministe"
```

---

### Task 3 : Visibilité et niveaux de détail

**Files :**
- Create: `bench/rendu/src/scene/lod.ts`
- Create: `bench/rendu/src/scene/visibility.ts`
- Test: `bench/rendu/tests/visibility.test.ts`

**Interfaces :**
- Consumes : `Scene`, `Camera`, `RenderParams` (tâche 2).
- Produces :

```ts
// lod.ts
export function textPx(k: number, zoom: number, p: RenderParams): number; // p.baseFontPx * p.textScale * p.factor ** k * zoom
export function isGroupOpen(scene: Scene, g: number, zoom: number, p: RenderParams): boolean; // max des textPx des membres >= p.groupFold[0]
// visibility.ts
export interface VisibleBranch { node: number; role: Role; hollow: boolean } // node = nœud dessiné (le membre lui-même ou son ancêtre fermé visible)
export interface VisibleConnection { ids: number[]; branches: VisibleBranch[] } // ids : connexions agrégées (length >= 1)
export interface VisibleSet { nodes: number[]; closedGroups: number[]; openGroups: number[]; connections: VisibleConnection[] }
export interface SceneIndex { /* flatbush des nœuds par niveau, listes de connexions par plus bas ancêtre commun */ }
export function buildIndex(scene: Scene): SceneIndex;
export function computeVisible(scene: Scene, index: SceneIndex, cam: Camera, p: RenderParams): VisibleSet;
export function lowestCommonGroup(scene: Scene, nodeIds: number[]): number; // -1 = racine
```

**Algorithme imposé.** Il conditionne le temps processeur, que le critère ×4 rend serré.
- **Nœuds :** on descend la hiérarchie depuis la racine. On n'entre dans un groupe que s'il est ouvert (`isGroupOpen`) et qu'il recoupe la vue élargie de `viewMarginPx`. Les éléments de premier niveau sont toujours candidats. Un index `flatbush` par niveau limite le test de la vue.
- **Connexions :** `buildIndex` range chaque connexion dans la liste de son plus bas groupe commun. `computeVisible` ne parcourt que les listes de la racine et des groupes ouverts visibles, ce qui masque d'office une connexion interne à un groupe fermé.
- **Redirection :** chaque membre est redirigé vers son ancêtre dessiné le plus haut parmi les groupes fermés. La branche est alors évidée (`hollow: true`).
- **Agrégation :** une connexion dont il reste moins de deux extrémités distinctes après redirection est masquée. Les connexions qui ont le même ensemble d'extrémités et de rôles sont agrégées.
- **Recalcul :** le renderer ne rappelle `computeVisible` que si l'ensemble des groupes ouverts change, ou si la vue sort de la marge depuis le dernier calcul.

- [ ] **Step 1 : écrire les tests qui échouent**

On utilise une petite scène construite à la main dans le fichier de test :
- un groupe G (cran 2) contenant A et B (cran 0) ;
- un nœud libre C (cran 0) ;
- une connexion A→B (id 0), une connexion A→C (id 1), une connexion B→C (id 2).

```ts
test('textPx suit la formule de la spec', () => {
  expect(textPx(0, 1, DEFAULT_PARAMS)).toBe(16);
  expect(textPx(3, 0.5, DEFAULT_PARAMS)).toBe(64);
});
test('un groupe est fermé quand le texte de ses membres passe sous 4,5 px', () => {
  expect(isGroupOpen(scene, G, 4 / 16, DEFAULT_PARAMS)).toBe(false); // membres à 4 px
  expect(isGroupOpen(scene, G, 5 / 16, DEFAULT_PARAMS)).toBe(true);  // membres à 5 px
});
test('groupe fermé : membres non dessinés, connexion interne masquée', () => {
  const v = computeVisible(scene, buildIndex(scene), camAtZoom(4 / 16), DEFAULT_PARAMS);
  expect(v.closedGroups).toContain(G);
  expect(v.nodes).not.toContain(A);
  expect(v.connections.flatMap(c => c.ids)).not.toContain(0);
});
test('extrémité redirigée vers le groupe fermé, branche évidée', () => {
  const v = computeVisible(scene, buildIndex(scene), camAtZoom(4 / 16), DEFAULT_PARAMS);
  const c = v.connections.find(c => c.ids.includes(1))!;
  expect(c.branches.find(b => b.node === G)!.hollow).toBe(true);
});
test('A→C et B→C agrégées une fois redirigées vers G', () => {
  const v = computeVisible(scene, buildIndex(scene), camAtZoom(4 / 16), DEFAULT_PARAMS);
  expect(v.connections.find(c => c.ids.includes(1))!.ids.sort()).toEqual([1, 2]);
});
test('groupe ouvert : membres dessinés, rien de redirigé', () => {
  const v = computeVisible(scene, buildIndex(scene), camAtZoom(1), DEFAULT_PARAMS);
  expect(v.nodes).toEqual(expect.arrayContaining([A, B, C]));
  expect(v.connections.every(c => c.branches.every(b => !b.hollow))).toBe(true);
});
test('hors de la vue et de sa marge : non dessiné', () => {
  const v = computeVisible(scene, buildIndex(scene), { ...camAtZoom(1), x: 1e7 }, DEFAULT_PARAMS);
  expect(v.nodes).toHaveLength(0);
});
test('plus bas groupe commun', () => {
  expect(lowestCommonGroup(scene, [A, B])).toBe(G);
  expect(lowestCommonGroup(scene, [A, C])).toBe(-1);
});
test('scène du banc : calcul en moins de 50 ms vue d\'ensemble', () => {
  const s = generateScene(BENCH_SCENE, DEFAULT_PARAMS); const idx = buildIndex(s);
  const t0 = performance.now(); computeVisible(s, idx, overviewCamera(s), DEFAULT_PARAMS);
  expect(performance.now() - t0).toBeLessThan(50);
});
```

`camAtZoom(z)` est centrée sur G, en 2560×1600. `overviewCamera(s)` cadre toute la scène. Ces deux aides sont définies dans le fichier de test.

- [ ] **Step 2 : vérifier l'échec**

Run: `npm test -w bench/rendu -- visibility`
Expected : FAIL.

- [ ] **Step 3 : implémenter `lod.ts` et `visibility.ts` selon l'algorithme ci-dessus**

Ajouter la dépendance `flatbush` au workspace `bench/rendu`.

- [ ] **Step 4 : vérifier le succès**

Run: `npm test -w bench/rendu -- visibility`
Expected : 9 tests PASS.

- [ ] **Step 5 : commit**

```bash
git add bench/rendu
git commit -m "feat(bench): visibilité par niveaux de détail et agrégation des connexions"
```

---

### Task 4 : Géométrie (rubans, enveloppes, étoiles)

**Files :**
- Create: `bench/rendu/src/geometry/ribbon.ts`
- Create: `bench/rendu/src/geometry/hull.ts`
- Create: `bench/rendu/src/geometry/stars.ts`
- Test: `bench/rendu/tests/geometry.test.ts`

**Interfaces :**
- Produces :

```ts
// ribbon.ts — la largeur se calcule dans le shader ; ces fonctions en sont la référence CPU testée
export function widthPx(scale: number, zoom: number, p: RenderParams): { width: number; alpha: number };
// raw = p.widthBasePx * scale * zoom ; width = clamp(raw, widthMinPx, widthMaxPx) ; alpha = min(1, raw / widthMinPx)
export function localScale(t: number, kA: number, kB: number, factor: number): number; // factor ** (kA + (kB - kA) * t)
export function sampleBranch(p0: Vec2, c0: Vec2, c1: Vec2, p1: Vec2, segments: number): Vec2[]; // Bézier cubique
export function ribbonAttributes(centerline: Vec2[], scales: number[]): { position: Float32Array; normal: Float32Array; scale: Float32Array; index: Uint32Array };
// 2 sommets par point (normale +n et -n), normales unitaires perpendiculaires à la tangente
export function bundleBranches(members: { pos: Vec2; role: Role; k: number }[], segments: number): { centerline: Vec2[]; scales: number[] }[];
// une entrée par membre, dans l'ordre reçu ; chaque ligne va de la position du membre jusqu'au marqueur.
// Le marqueur est au milieu entre le centre des sources et celui des cibles. Chaque ligne arrive au marqueur
// tangente à l'axe sources→cibles (spec 8.5). Une connexion à deux membres donne une seule courbe, sans marqueur visible.
// hull.ts
export function convexHull(points: Vec2[]): Vec2[]; // chaîne monotone, sens trigonométrique
export function featherRing(hull: Vec2[], padding: number, feather: number): { position: Float32Array; alpha: Float32Array; index: Uint32Array };
// stars.ts
export function starsInRect(rect: Rect, layerK: number, seed: number, p: RenderParams): Vec2[]; // déterministe, fixe dans le monde
export function starLayerAlpha(layerK: number, zoom: number, p: RenderParams): number; // 1 au milieu de starSpacingPx, 0 hors de l'intervalle
```

**Technique imposée pour les enveloppes :** un polygone plein entouré d'un anneau dont l'alpha passe de 1 à 0. Pas de `BlurFilter`, dont le coût en remplissage par groupe est le premier risque sur une carte intégrée. L'enveloppe est calculée une fois au chargement, car les membres ne bougent pas dans le banc.

- [ ] **Step 1 : écrire les tests qui échouent**

```ts
test('largeur bornée et fondu sous le minimum (exemples de la spec)', () => {
  expect(widthPx(8, 1, DEFAULT_PARAMS)).toEqual({ width: 5, alpha: 1 });     // brut 12 px
  expect(widthPx(1, 1, DEFAULT_PARAMS)).toEqual({ width: 1.5, alpha: 1 });
  const far = widthPx(1, 0.1, DEFAULT_PARAMS);                               // brut 0,15 px
  expect(far.width).toBe(1); expect(far.alpha).toBeCloseTo(0.15);
});
test('échelle locale géométrique le long d\'une branche', () => {
  expect(localScale(0.5, 3, 0, 2)).toBeCloseTo(2.828, 3); // de 8 à 1
});
test('ruban : deux sommets par point, normales unitaires et perpendiculaires', () => {
  const line = sampleBranch({x:0,y:0},{x:10,y:0},{x:20,y:10},{x:30,y:10}, 16);
  const a = ribbonAttributes(line, line.map(() => 1));
  expect(a.position.length).toBe(line.length * 2 * 2);
  for (let i = 0; i < a.normal.length; i += 2) expect(Math.hypot(a.normal[i], a.normal[i + 1])).toBeCloseTo(1);
});
test('faisceau : marqueur au milieu des centres, arrivée tangente au tronc', () => {
  const b = bundleBranches([{pos:{x:0,y:0},role:'source',k:0},{pos:{x:0,y:100},role:'source',k:0},{pos:{x:200,y:50},role:'target',k:0}], 16);
  for (const { centerline: l } of b) {
    const end = l[l.length - 1], prev = l[l.length - 2];
    expect(end.x).toBeCloseTo(100); expect(end.y).toBeCloseTo(50);           // marqueur
    expect(Math.abs(Math.sin(Math.atan2(end.y - prev.y, end.x - prev.x)))).toBeLessThan(0.05); // axe horizontal
  }
});
test('enveloppe convexe', () => {
  expect(convexHull([{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1},{x:0.5,y:0.5}])).toHaveLength(4);
});
test('étoiles déterministes et fixes dans le monde', () => {
  const a = starsInRect({x:0,y:0,w:1000,h:1000}, 2, 7, DEFAULT_PARAMS);
  const b = starsInRect({x:500,y:0,w:1000,h:1000}, 2, 7, DEFAULT_PARAMS);
  const inOverlap = (s: Vec2) => s.x >= 500 && s.x < 1000;
  expect(a.filter(inOverlap)).toEqual(b.filter(inOverlap));
});
test('couche d\'étoiles visible seulement dans son intervalle d\'espacement', () => {
  // espacement écran = starCellWorld * 2^k * zoom
  expect(starLayerAlpha(0, 30 / 40, DEFAULT_PARAMS)).toBe(0);  // 30 px < 40
  expect(starLayerAlpha(0, 100 / 40, DEFAULT_PARAMS)).toBeGreaterThan(0.9);
  expect(starLayerAlpha(0, 200 / 40, DEFAULT_PARAMS)).toBe(0); // 200 px > 160
});
```

Le point (100, 50) est le milieu entre le centre des sources (0, 50) et la cible (200, 50).

- [ ] **Step 2 : vérifier l'échec**

Run: `npm test -w bench/rendu -- geometry`
Expected : FAIL.

- [ ] **Step 3 : implémenter les trois modules**

`starLayerAlpha` : un fondu linéaire sur le premier et le dernier quart de l'intervalle `starSpacingPx`, et 1 entre les deux.

- [ ] **Step 4 : vérifier le succès**

Run: `npm test -w bench/rendu -- geometry`
Expected : 7 tests PASS.

- [ ] **Step 5 : commit**

```bash
git add bench/rendu/src/geometry bench/rendu/tests/geometry.test.ts
git commit -m "feat(bench): géométrie des rubans, enveloppes et étoiles"
```

---

### Task 5 : Rendu PixiJS dans Electron

**Files :**
- Create: `bench/rendu/electron.vite.config.ts`
- Create: `bench/rendu/src/main/index.ts`
- Create: `bench/rendu/src/preload/index.ts`
- Create: `bench/rendu/src/renderer/index.html`
- Create: `bench/rendu/src/renderer/main.ts`
- Create: `bench/rendu/src/render/sceneRenderer.ts`
- Create: `bench/rendu/src/render/ribbonShader.ts`
- Create: `bench/rendu/src/render/font/` (atlas MSDF généré et commité)
- Create: `bench/rendu/scripts/build-font.mjs`

**Interfaces :**
- Consumes : `computeVisible`, `buildIndex` (tâche 3) ; `bundleBranches`, `ribbonAttributes`, `convexHull`, `featherRing`, `starsInRect`, `starLayerAlpha` (tâche 4).
- Produces :

```ts
export class SceneRenderer {
  constructor(app: PIXI.Application, scene: Scene, params: RenderParams);
  setCamera(cam: Camera): void;   // recalcule la visibilité seulement si nécessaire (règle de la tâche 3)
  renderFrame(): { cpuMs: number; rebuilt: boolean }; // cpuMs = temps JS de mise à jour de cette image
}
// preload expose window.bench = { saveReport(json: string, markdown: string, png?: ArrayBuffer): Promise<void>; setCpuThrottle(rate: number): Promise<void>; quit(): void }
```

**Décisions imposées :**
- **Processus principal :** il ajoute les options Chromium `disable-gpu-vsync`, `disable-frame-rate-limit` et `force_high_performance_gpu` quand la variable `BENCH_UNCAPPED=1` est présente. Il ouvre une fenêtre plein écran, avec `contextIsolation: true` et `nodeIntegration: false`. Le ralentissement passe par `webContents.debugger` avec `Emulation.setCPUThrottlingRate`.
- **Résolution :** l'application Pixi est créée en `resolution: window.devicePixelRatio` et `autoDensity: true`, pour rendre en 2560×1600 réels.
- **Texte :** `BitmapText` avec une police MSDF générée par `scripts/build-font.mjs`, qui appelle `msdf-bmfont-xml` à partir d'Inter (licence OFL). Le jeu de caractères couvre le latin étendu, le grec, et les signes ≤ ≥ ∑ ∫ → ≈ ±. Les objets texte sont recyclés dans un pool. Leur opacité suit `textFade`.
- **Connexions :** un seul `Mesh` regroupe toutes les connexions visibles, avec les attributs de `ribbonAttributes`. Le shader de `ribbonShader.ts` décale chaque sommet de `normal × largeur / zoom`, la largeur étant calculée comme `widthPx` à partir de l'uniforme `zoom`. Le maillage n'est reconstruit que lorsque l'ensemble visible change.
- **Groupes :** polygone et anneau (`featherRing`) en `Mesh`, couleur opaque par niveau (deux teintes alternées suffisent pour le banc). L'opacité suit le repli (`groupFold`). Le titre d'un groupe fermé est en `BitmapText`.
- **Étoiles :** un `ParticleContainer` par couche visible, régénéré quand la vue change de cellule.

- [ ] **Step 1 : générer l'atlas de police**

Run: `node bench/rendu/scripts/build-font.mjs`
Expected : `bench/rendu/src/render/font/inter-msdf.fnt` et sa ou ses images existent.

- [ ] **Step 2 : implémenter le shell Electron et `SceneRenderer`**

Au démarrage, la page génère `BENCH_SCENE`, construit l'index, cadre la vue d'ensemble et laisse naviguer à la souris : clic gauche enfoncé pour déplacer, molette pour zoomer autour du curseur. Cela permet un contrôle à l'œil.

- [ ] **Step 3 : contrôle visuel**

Run: `npm run dev -w bench/rendu`. Zoomer de la vue d'ensemble jusqu'à un nœud de plus bas niveau.
Expected :
- les groupes se replient et s'ouvrent sans trou ;
- les rubans s'amincissent et s'effacent vers les petits nœuds ;
- les titres restent nets aux grandes tailles ;
- les étoiles sont fixes, sans scintillement.
Une capture automatique est écrite dans `docs/bancs/rendu-capture.png` à la touche F12.

- [ ] **Step 4 : les tests existants passent toujours**

Run: `npm test -w bench/rendu`
Expected : tous les tests PASS.

- [ ] **Step 5 : commit**

```bash
git add bench/rendu docs/bancs/rendu-capture.png
git commit -m "feat(bench): rendu PixiJS de la scène synthétique"
```

---

### Task 6 : Harnais de mesure du rendu et rapport

**Files :**
- Create: `bench/rendu/src/bench/scenario.ts`
- Create: `bench/rendu/src/bench/metrics.ts`
- Create: `bench/rendu/src/bench/report.ts`
- Modify: `bench/rendu/src/renderer/main.ts` (mode `?bench=1` : jouer le scénario puis quitter)
- Modify: `bench/rendu/package.json` (script `bench`)
- Test: `bench/rendu/tests/metrics.test.ts`

**Interfaces :**
- Consumes : `SceneRenderer.renderFrame()`, `window.bench` (tâche 5).
- Produces :

```ts
export interface Keyframe { t: number; cam: Omit<Camera, 'widthPx' | 'heightPx'> } // t en secondes
export function benchScenario(scene: Scene): Keyframe[]; // vue d'ensemble → zoom à travers 4 niveaux de groupes jusqu'à un nœud → déplacement → dézoom ; 40 s en tout, interpolation log du zoom
export interface Stats { p50: number; p95: number; max: number; n: number }
export function summarize(samples: number[]): Stats;
export interface RunResult { label: 'uncapped' | 'throttled-x4' | 'vsync'; gpuName: string; canvasPx: [number, number]; frameIntervalMs: Stats; cpuMs: Stats; rebuilds: number; loadMs: number; memoryMb: number }
export interface Criteria { maxIntervalP95Uncapped: number; maxCpuP95Throttled: number; targetHz: number }
export const CRITERIA: Criteria; // { maxIntervalP95Uncapped: 2, maxCpuP95Throttled: 16, targetHz: 165 }
export interface Verdict { pass: boolean | 'invalide'; lines: string[] }
export function evaluate(runs: RunResult[], c: Criteria): Verdict;
// 'invalide' si une passe a un gpuName sans « NVIDIA », ou si la passe uncapped est plafonnée ; sinon pass = les deux critères tenus
export function toMarkdown(runs: RunResult[], v: Verdict, date: string): string; // en français
```

- **Script `bench` :** il lance trois passes Electron successives et écrit `docs/bancs/rendu-<AAAA-MM-JJ>.json` et `.md`.
  - `uncapped` : avec `BENCH_UNCAPPED=1` ;
  - `throttled-x4` : sans limite d'images, avec un ralentissement ×4 ;
  - `vsync` : normal.
- **Carte graphique :** son nom est lu via `WEBGL_debug_renderer_info`.
- **Chargement :** `loadMs` va de la fin de la génération à la première image.

- [ ] **Step 1 : écrire les tests qui échouent**

```ts
test('percentiles', () => {
  const s = summarize(Array.from({ length: 100 }, (_, i) => i + 1));
  expect(s.p50).toBe(50); expect(s.p95).toBe(95); expect(s.max).toBe(100);
});
const ok: RunResult[] = [
  { label: 'uncapped', gpuName: 'ANGLE (NVIDIA GeForce RTX 4070 Laptop GPU ...)', canvasPx: [2560, 1600], frameIntervalMs: { p50: 1.2, p95: 1.8, max: 6, n: 9000 }, cpuMs: { p50: 0.6, p95: 1.1, max: 9, n: 9000 }, rebuilds: 40, loadMs: 900, memoryMb: 600 },
  { label: 'throttled-x4', gpuName: 'ANGLE (NVIDIA ...)', canvasPx: [2560, 1600], frameIntervalMs: { p50: 4, p95: 9, max: 30, n: 5000 }, cpuMs: { p50: 2.5, p95: 12, max: 40, n: 5000 }, rebuilds: 40, loadMs: 900, memoryMb: 600 },
];
test('critères tenus', () => { expect(evaluate(ok, CRITERIA).pass).toBe(true); });
test('processeur trop lent sous ×4', () => {
  const bad = structuredClone(ok); bad[1].cpuMs.p95 = 17;
  expect(evaluate(bad, CRITERIA).pass).toBe(false);
});
test('mesure plafonnée détectée (Review Focus 1)', () => {
  const capped = structuredClone(ok); capped[0].frameIntervalMs.p50 = 1000 / 165;
  const v = evaluate(capped, CRITERIA);
  expect(v.pass).toBe('invalide'); expect(v.lines.join(' ')).toMatch(/plafonn/);
});
test('carte graphique autre que la NVIDIA refusée (Review Focus 2)', () => {
  const sw = structuredClone(ok); sw[0].gpuName = 'ANGLE (Google SwiftShader)';
  expect(evaluate(sw, CRITERIA).pass).toBe('invalide');
});
test('le rapport montre p95 et maximum (Review Focus 3)', () => {
  const md = toMarkdown(ok, evaluate(ok, CRITERIA), '2026-11-02');
  expect(md).toMatch(/p95/); expect(md).toMatch(/max/);
});
```

Une mesure est « plafonnée » si le p50 de l'intervalle sans limite est à moins de 3 % de 1000/165 ou de 1000/60.

- [ ] **Step 2 : vérifier l'échec**

Run: `npm test -w bench/rendu -- metrics`
Expected : FAIL.

- [ ] **Step 3 : implémenter `scenario.ts`, `metrics.ts`, `report.ts` et le mode `?bench=1`**

- [ ] **Step 4 : vérifier le succès des tests**

Run: `npm test -w bench/rendu -- metrics`
Expected : 6 tests PASS.

- [ ] **Step 5 : lancer le banc**

Run: `npm run bench -w bench/rendu`. Machine branchée sur secteur, en mode performances de Windows.
Expected :
- `docs/bancs/rendu-<date>.md` existe ;
- la carte nommée est la RTX 4070 ;
- la résolution est 2560×1600 ;
- un verdict apparaît (réussi, échoué ou invalide), avec les chiffres.
Un verdict invalide se corrige avant de continuer.

- [ ] **Step 6 : commit**

```bash
git add bench/rendu docs/bancs
git commit -m "feat(bench): harnais de mesure du rendu et premier rapport"
```

---

### Task 7 : TinyTeX et compilateur préchauffé

**Files :**
- Create: `bench/latex/scripts/install-tinytex.ps1`
- Create: `bench/latex/tex/preamble.tex`
- Create: `bench/latex/tex/fragments/` (`court.tex`, `equations.tex`, `references.tex`, `tikz.tex`, `accents.tex` et l'image `courbes_été.png`)
- Create: `bench/latex/src/driver.ts`
- Create: `bench/latex/src/warmCompiler.ts`
- Test: `bench/latex/tests/warmCompiler.test.ts`

**Interfaces :**
- Produces :

```ts
export interface CompileJob { texPath: string; refs?: { label: string; title: string }[]; resourceDir?: string }
export interface CompileResult { ok: boolean; ms: number; pdfPath?: string; logPath: string; error?: string; timedOut: boolean }
export function driverSource(preamblePath: string): string; // contenu du fichier pilote
export class WarmCompiler {
  constructor(opts: { pdflatex: string; workDir: string; preamblePath: string; timeoutMs: number }); // timeoutMs par défaut 10000
  prepare(): Promise<void>;                  // lance pdflatex et attend le marqueur CIRRUS-READY sur stdout
  compile(job: CompileJob): Promise<CompileResult>; // attend prepare() si aucun processus n'est prêt ; ms mesuré depuis l'envoi du nom du job
  compileCold(job: CompileJob): Promise<CompileResult>; // lancement + préambule + corps, pour comparaison
  dispose(): void;
}
```

**Mécanisme imposé** (inspiré de TeX-fast-recompile) :
- `prepare()` lance `pdflatex -no-shell-escape -interaction=scrollmode -jobname=job-<n> driver.tex` dans `workDir`. Le pilote charge le préambule, écrit `\message{CIRRUS-READY}`, puis lit le nom du job sur l'entrée standard.
- `compile()` écrit le job dans `workDir` sous le nom neutre `job-<n>-body.tex`. Ce fichier contient les `\newlabel` des références injectées, puis le `\input` du fragment. `compile()` envoie ensuite ce nom, suivi d'un retour à la ligne, sur l'entrée standard.
- Au-delà de `timeoutMs`, le processus est tué et le résultat porte `timedOut: true`.
- Après chaque compilation, un nouveau processus est préparé en arrière-plan.

Le pilote :

```latex
% driver.tex — généré par driverSource()
\input{<preamble>}
\begin{document}
\message{CIRRUS-READY}
\read16 to \cirrusjob
\nonstopmode % plus jamais d'attente de saisie : une erreur fatale termine le processus
\input{\cirrusjob}
\end{document}
```

- **Préambule :** il charge `amsmath`, `amssymb`, `graphicx`, `xcolor`, `tikz` et `hyperref`, avec l'encodage UTF-8 par défaut de LaTeX.
- **Installation :** `install-tinytex.ps1` télécharge la dernière archive TinyTeX-1 pour Windows depuis `github.com/rstudio/tinytex-releases`, en vérifiant le nom exact du fichier sur la page des versions. Il l'extrait dans `bench/latex/vendor/TinyTeX`, puis lance `tlmgr install pgf xcolor hyperref amsmath amsfonts graphics`, que `tlmgr` ignore s'ils sont déjà présents.

- [ ] **Step 1 : installer TinyTeX**

Run: `powershell -File bench/latex/scripts/install-tinytex.ps1`
Expected : `bench/latex/vendor/TinyTeX/bin/windows/pdflatex.exe --version` affiche pdfTeX.

- [ ] **Step 2 : écrire les tests qui échouent**

```ts
test('compile un fragment court et produit un PDF', async () => {
  const r = await compiler.compile({ texPath: frag('court.tex') });
  expect(r.ok).toBe(true); expect(existsSync(r.pdfPath!)).toBe(true);
});
test('préchauffé plus rapide qu\'à froid', async () => {
  const cold = await compiler.compileCold({ texPath: frag('court.tex') });
  await compiler.prepare();
  const warm = await compiler.compile({ texPath: frag('court.tex') });
  expect(warm.ms).toBeLessThan(cold.ms);
});
test('fichier manquant : échec rapide, sans blocage (Review Focus 4)', async () => {
  const r = await compiler.compile({ texPath: writeTmp('\\input{inexistant}') });
  expect(r.ok).toBe(false); expect(r.timedOut).toBe(false); expect(r.ms).toBeLessThan(5000);
});
test('référence externe injectée résolue', async () => {
  const r = await compiler.compile({ texPath: frag('references.tex'), refs: [{ label: 'ext:mdl', title: 'Minimum Description Length' }] });
  expect(r.ok).toBe(true); expect(readFileSync(r.logPath, 'utf8')).not.toMatch(/undefined/i);
});
test('shell escape refusé', async () => {
  const r = await compiler.compile({ texPath: writeTmp('\\immediate\\write18{echo pwned > pwned.txt}x') });
  expect(existsSync(join(workDir, 'pwned.txt'))).toBe(false);
});
test('nom de fichier accentué : résultat déterminé (Review Focus 5)', async () => {
  const r = await compiler.compile({ texPath: frag('accents.tex'), resourceDir: fragDir });
  expect(r.timedOut).toBe(false);
  expect(r.ok || (r.error ?? '').length > 0).toBe(true);
});
```

`compiler`, `frag()`, `writeTmp()`, `workDir` et `fragDir` sont préparés dans `beforeEach` et `afterEach`, avec un dossier de travail temporaire par test. Le délai Vitest de ces tests est de 30 s.

- [ ] **Step 3 : vérifier l'échec**

Run: `npm test -w bench/latex`
Expected : FAIL.

- [ ] **Step 4 : implémenter `driver.ts` et `warmCompiler.ts`**

- [ ] **Step 5 : vérifier le succès**

Run: `npm test -w bench/latex`
Expected : 6 tests PASS.

- [ ] **Step 6 : commit**

```bash
git add bench/latex .gitignore
git commit -m "feat(bench): compilateur pdfLaTeX préchauffé"
```

---

### Task 8 : Banc LaTeX et synthèse des résultats

**Files :**
- Create: `bench/latex/src/run.ts`
- Modify: `bench/latex/package.json` (script `bench`)
- Create: `docs/bancs/latex-<AAAA-MM-JJ>.md` (généré)
- Create: `docs/bancs/resultats.md` (écrit à la main à partir des deux rapports)

**Interfaces :**
- Consumes : `WarmCompiler` (tâche 7), `summarize` (tâche 6, recopiée, car les bancs ne partagent pas de code).

- **Protocole de `run.ts` :**
  - pour chaque fragment : 10 compilations à froid, puis 20 compilations préchauffées, en préparant le processus avant chaque mesure ;
  - consigner la médiane, le p95 et le maximum ;
  - critère : médiane préchauffée d'au plus 300 ms pour `court`, `equations` et `references` ;
  - `tikz` est seulement consigné ;
  - `accents` consigne réussite ou erreur.

- [ ] **Step 1 : implémenter `run.ts`**

- [ ] **Step 2 : lancer le banc**

Run: `npm run bench -w bench/latex`
Expected : `docs/bancs/latex-<date>.md` existe, avec un tableau par fragment, le verdict et le résultat du cas accentué.

- [ ] **Step 3 : écrire `docs/bancs/resultats.md`**

En français, une page au plus :
- verdict du rendu et verdict LaTeX, avec les chiffres clés ;
- si le rendu échoue : quels effets du mode performance essayer d'abord (spec 19), dans l'ordre enveloppes, rubans, étoiles, résolution ;
- si LaTeX échoue : essayer `mylatexformat` en complément (spec 13) ;
- conséquence pour le cas des noms accentués ;
- marges d'extrapolation vers le petit PC, rappelées comme estimations.

- [ ] **Step 4 : commit**

```bash
git add bench/latex docs/bancs
git commit -m "docs(bench): rapports de mesure et synthèse"
```
