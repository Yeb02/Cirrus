# Cirrus, plan 3 : rendu — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** l'application de bureau ouvre la base locale et affiche n'importe quel plan avec le rendu validé par la maquette : nœuds, groupes imbriqués qui se replient, faisceaux de connexions, amorces, fantômes, ciel étoilé. On y navigue (zoom, déplacement, onglets), le survol illumine les connexions, et tous les paramètres graphiques se règlent dans un bandeau latéral. Les gestes d'édition (sélection, déplacement, création, connexion, groupes, copier-coller) forment le plan 3b.

**Architecture :**
- `packages/view` (`@cirrus/view`) est pur, sans DOM ni PixiJS : paramètres, caméra, couleurs, scène d'un plan tirée de l'état du socle, géométrie des faisceaux et des enveloppes, visibilité, tests de survol, placement des titres. Tout s'y teste sous Node.
- `packages/app` (`@cirrus/app`) est l'application Electron :
  - le processus principal ouvre la base (`@cirrus/store`) et les réglages, et répond par IPC ;
  - le préchargement expose une API minimale ;
  - l'interface React contient les onglets, le bandeau des paramètres, le rappel de hiérarchie et les infobulles ;
  - le moteur PixiJS dessine ce que `view` calcule.
- Le processus d'interface n'a aucun accès au système (spec 4, cloisonnement). Il reçoit une copie de l'état au démarrage. Les commandes et leur envoi au processus principal viendront avec le plan 3b.

**Tech Stack :** Electron 45.2.1 (Node 24.22, `node:sqlite` vérifié), electron-vite 6.0.0, Vite 8.3.5, React 19.3.1, @vitejs/plugin-react 6.2.1, PixiJS 8.22.0 (WebGL), Flatbush 4.7.0, Vitest, TypeScript strict.

**Spec :** `C:\Users\alpha\Desktop\Cirrus\2026-11-02-cirrus-design.md`, sections 4, 8, 9.1 (navigation seulement), 10 (enveloppes), 11.3, 19 et 21. Les leçons du banc sont dans `docs/bancs/resultats.md` (« Ce que le renderer de l'app doit reprendre »). Le code du banc (`bench/rendu/src`) et la maquette (`maquettes/faisceaux-v2.html`) servent de référence pour les principes, pas de base de code.

## Global Constraints

- **Git :** on travaille sur `main`, sans branche, avec un commit puis un push sur `origin` à la fin de chaque tâche.
- **TypeScript :** syntaxe effaçable (`erasableSyntaxOnly`), imports relatifs avec leur extension (`.ts`, `.tsx`), identifiants et commentaires en anglais, textes destinés à l'utilisateur en français.
- **Paramètres (spec 19, consigne de l'utilisateur) :** toute constante de rendu ou d'interaction est un champ de `RenderParams`, avec sa valeur par défaut dans `DEFAULT_PARAMS` et sa fiche dans `PARAM_SPECS`. Aucun nombre magique de rendu dans `packages/app`. Un test vérifie que chaque champ a sa fiche.
- **Stabilité (anti-objectif) :** le rendu ne déplace jamais rien et n'écrit jamais de position. Il ne fait que lire l'état.
- **Cloisonnement :** fenêtre avec `contextIsolation: true`, `sandbox: true` et `nodeIntegration: false`. La politique de sécurité du contenu (CSP) est `default-src 'self'`, avec `style-src 'self' 'unsafe-inline'` et `img-src 'self' data: blob:`. Seul le processus principal touche aux fichiers et à SQLite.
- **Dépendances :** les versions de la pile ci-dessus, exactes. Aucun module natif.
- **Rendu (leçons du banc) :**
  - anticrénelage calculé dans les shaders (`antialias: false` à l'initialisation de PixiJS) ;
  - shaders préchauffés au chargement ;
  - géométrie de tout maillage remplacé libérée (`disposeMesh`) ;
  - réserve d'objets texte ;
  - coordonnées relatives à une origine locale ;
  - enveloppes dessinées dans une texture à résolution réduite.
- **Niveaux de détail (spec 8.2) :** tout dépend de la taille du texte à l'écran, `textPx(k) = baseFontPx × textScale × factor^k × zoom`. Par défaut, en dézoomant, disparaissent d'abord le marqueur et le titre des connexions (6,5 à 9 px), puis le texte des nœuds (6 à 8 px), puis les groupes se replient (4,5 à 6,5 px).

## Review Focus

1. **Plan vide ou presque :** un lobby neuf sans nœud, ou un plan d'un seul nœud. Le ciel s'affiche, rien ne plante, et la caméra se cadre sur l'origine au zoom 1 ou sur le nœud. Testé dans les tâches 1 et 2.
2. **Titres réels :**
   - un titre très long garde toutes ses lignes et sa boîte grandit en hauteur, sans troncature ;
   - accents, θ, ≤ et ∑ s'affichent ;
   - un caractère absent de l'atlas ne fait pas planter.
   Testé dans les tâches 2 et 6.
3. **Groupe absent du plan :** les membres d'un groupe retiré du plan se dessinent dans le plus proche ancêtre placé (spec 7). Un groupe dont un membre est un fantôme replie aussi ce fantôme. Testé dans la tâche 2.
4. **Géométrie dégénérée :** deux membres au même point, sources et cibles de même centre, crans très éloignés (−3 et 5), connexion réduite à un membre et une amorce. Aucune valeur NaN ou infinie ne doit entrer dans un tampon. Testé dans les tâches 3 et 4.
5. **Zoom extrême et redimensionnement :** du zoom 10⁻³ à 10³, l'origine locale garde la précision et les couches d'étoiles restent bornées. Une fenêtre redimensionnée redessine sans déformation. Testé dans les tâches 1, 3 et 6.

---

### Task 1 : Paquet `@cirrus/view` — paramètres, niveaux de détail, caméra, couleurs

**Files :**
- Create: `packages/view/package.json` (`@cirrus/view`, `"type": "module"`, `"exports": "./src/index.ts"`, script `test`, dépendances `@cirrus/core` et `flatbush@4.7.0`), `packages/view/tsconfig.json`, `packages/view/vitest.config.ts` (comme `packages/core`)
- Create: `packages/view/src/index.ts`, `params.ts`, `lod.ts`, `camera.ts`, `color.ts`
- Test: `packages/view/tests/params.test.ts`, `lod.test.ts`, `camera.test.ts`, `color.test.ts`

**Interfaces :**
- Produces :
  - `type Rgb = [number, number, number]` (sRGB, de 0 à 1).
  - `interface RenderParams` et `DEFAULT_PARAMS`. Champs et défauts :
    - **échelles :** `factor` 2, `textScale` 1, `baseFontPx` 16 ;
    - **niveaux de détail :**
      - `textFade` [6, 8], `groupFold` [4.5, 6.5], `titleFade` [6.5, 9] ;
      - `minNodePx` 4 ;
      - `zoomMin` 1e-3, `zoomMax` 1e3 ;
    - **boîtes :** `boxWidth` 210, `boxPadX` 12, `boxPadY` 13, `lineHeight` 1.25, `boxRadius` 11, `boxBorderPx` 1.2 ;
    - **groupes :**
      - `groupOffsetSteps` 2 ;
      - `envelopePad` 44, `featherOpenPx` 10, `featherClosedPx` 1.5, `envelopeOpacityOpen` 0.32, `envelopeResolution` 0.5 ;
      - `groupLightnessStep` 0.06, `groupChroma` 0.09, `groupLightness` 0.45, `groupHues` [255, 290, 200, 330, 160, 60] ;
      - `groupTitleOpenScale` 0.95, `groupTitleClosedScale` 1.2 ;
    - **connexions :**
      - `trunkTension` 0.55, `trunkLength` 50, `anchorGap` 3 ;
      - `widthBasePx` 1.5, `widthMinPx` 1, `widthMaxPx` 5 ;
      - `arrowLength` 8, `arrowHalfWidth` 3, `arrowNotch` 0.66, `dotRadius` 2.2 (en largeurs de trait), `hollowInset` 0.55 ;
      - `markerRadiusPx` 6.5, `titleFontPx` 13, `titleGap` 11 ;
      - `stubLength` 150, `stubAngle` 0.6, `dashPx` [4, 5] ;
      - `curveTolerancePx` 0.2, `curveZoomHeadroom` 2, `connectionFadePx` 150, `ribbonCullAlpha` 0.03, `hoverBoostPx` 1 ;
    - **fantômes :** `centerRadius` 9, `badgeRadiusPx` 3 ;
    - **vue :** `viewMarginPx` 200, `hitTolerancePx` 6, `wheelZoomSpeed` 0.0015, `keyZoomStep` 1.25, `keyPanPx` 80, `fitMarginPx` 60 ;
    - **fond :**
      - `background` `'stars' | 'grid'` (défaut `'stars'`), `backgroundOpacity` 1 ;
      - `starCellWorld` 40, `starSpacingPx` [40, 160], `starSizePx` 1, `starBrightness` 0.7 ;
      - `gridSpacingPx` [24, 96], `gridAlpha` 0.06 ;
    - **couleurs :**
      - `skyColor` #0a1120, `skyColor2` #14213a ;
      - `nodeColor` #1b2b49, `nodeEdgeColor` #4d6a9a, `inkColor` #e9effb ;
      - `connectionColor` #8fb8ff, `connectionAlpha` 0.75 ;
      - `absentColor` #8494ae, `markerColor` #14213a, `titleColor` #cfdcf5.

      Les couleurs sont stockées en `Rgb` et écrites en hexadécimal dans `PARAM_SPECS` pour l'affichage.
  - `interface ParamSpec { key: keyof RenderParams; label: string; section: 'graphique' | 'avancé'; group: string; kind: 'number' | 'range' | 'color' | 'choice' | 'list'; min?: number; max?: number; step?: number; choices?: { value: string; label: string }[] }` et `PARAM_SPECS: ParamSpec[]`.
    - Les libellés sont en français.
    - La section « graphique » contient la liste de la spec 19 : distance du titre, seuils de disparition, transition des groupes, tension et longueur du tronc, largeurs, facteur, échelle de texte, fond et opacité, couleurs.
    - Tout le reste va dans « avancé ».
  - `withOverrides(overrides: unknown): RenderParams` : part des défauts et applique chaque clé connue dont la valeur a le bon type, ou la bonne longueur pour un intervalle ou une couleur. Les clés inconnues et les mauvais types sont ignorés, ce qui protège d'un fichier de réglages corrompu.
  - `lod.ts` :
    - `smooth(a, b, v)` : le smoothstep de la maquette ;
    - `textPx(k, zoom, p)` ;
    - `foldT(maxChildK, zoom, p)`, qui vaut 1 si le groupe est replié et 0 s'il est ouvert, soit `1 − smooth(groupFold[0], groupFold[1], textPx(maxChildK))` ;
    - `stepScale(k, p) = p.textScale × p.factor^k`.
  - `camera.ts` :
    - `interface Camera { x: number; y: number; zoom: number; widthPx: number; heightPx: number }`, où (x, y) est le point du monde au centre de l'écran ;
    - `screenToWorld(c, sx, sy): Vec2` et `worldToScreen(c, wx, wy): Vec2` ;
    - `zoomAt(c, sx, sy, factor, p): Camera`, qui garde fixe le point du monde sous (sx, sy) et borne le zoom entre `zoomMin` et `zoomMax` ;
    - `panBy(c, dxPx, dyPx): Camera` ;
    - `fitBounds(b: Bounds | null, widthPx, heightPx, p): Camera`, qui donne l'origine au zoom 1 si `b` est nul ;
    - `interface Bounds { minX: number; minY: number; maxX: number; maxY: number }`.
  - `color.ts` :
    - `oklchToRgb(L, C, hDeg): Rgb`, ramené dans le gamut sRGB ;
    - `hexToRgb(hex): Rgb` et `rgbToHex(c): string` ;
    - `mixRgb(a, b, t): Rgb` ;
    - `groupPalette(depthHue: { depth: number; hue: number }, p): { open: Rgb; closed: Rgb }`.
      - La couleur repliée a la luminosité `groupLightness + depth × groupLightnessStep`. Le décalage alterne vers le bas dès qu'il dépasserait 0,85.
      - La couleur ouverte vaut `mixRgb(skyColor, repliée, envelopeOpacityOpen)`, ce qui donne des intérieurs opaques non miscibles (spec 8.4).

- [ ] **Step 1 : tests**

```ts
// params.test.ts
test('chaque paramètre a sa fiche, et une seule (spec 19)', () => {
  const keys = Object.keys(DEFAULT_PARAMS).sort();
  expect(PARAM_SPECS.map((s) => s.key).sort()).toEqual(keys);
});
test('les réglages corrompus sont ignorés clé par clé', () => {
  const p = withOverrides({ factor: 3, textFade: [1], skyColor: 'rouge', inconnu: 4, trunkLength: '50' });
  expect(p.factor).toBe(3);
  expect(p.textFade).toEqual(DEFAULT_PARAMS.textFade);
  expect(p.skyColor).toEqual(DEFAULT_PARAMS.skyColor);
  expect(p.trunkLength).toBe(DEFAULT_PARAMS.trunkLength);
  expect(withOverrides(null)).toEqual(DEFAULT_PARAMS);
});
// lod.test.ts
test('ordre de disparition par défaut : titres de connexion, texte, puis repli des groupes (spec 8.2)', () => {
  const p = DEFAULT_PARAMS;
  expect(p.titleFade[0]).toBeGreaterThan(p.textFade[0]);
  expect(p.textFade[0]).toBeGreaterThan(p.groupFold[0]);
  expect(foldT(0, 4 / 16, p)).toBe(1);
  expect(foldT(0, 7 / 16, p)).toBe(0);
});
// camera.test.ts
test('zoomAt garde fixe le point sous le curseur', () => {
  const c = { x: 10, y: -5, zoom: 2, widthPx: 800, heightPx: 600 };
  const before = screenToWorld(c, 100, 50);
  const after = screenToWorld(zoomAt(c, 100, 50, 3.7, DEFAULT_PARAMS), 100, 50);
  expect(after.x).toBeCloseTo(before.x, 9);
  expect(after.y).toBeCloseTo(before.y, 9);
});
test('zoom borné et cadrage d’un plan vide', () => {
  const c = { x: 0, y: 0, zoom: 900, widthPx: 800, heightPx: 600 };
  expect(zoomAt(c, 0, 0, 10, DEFAULT_PARAMS).zoom).toBe(DEFAULT_PARAMS.zoomMax);
  expect(fitBounds(null, 800, 600, DEFAULT_PARAMS)).toMatchObject({ x: 0, y: 0, zoom: 1 });
  const f = fitBounds({ minX: 0, minY: 0, maxX: 1000, maxY: 100 }, 800, 600, DEFAULT_PARAMS);
  expect(f.x).toBe(500);
  expect(f.zoom).toBeCloseTo((800 - 2 * DEFAULT_PARAMS.fitMarginPx) / 1000, 9);
});
// color.test.ts
test('OKLCH : blanc, noir, et teinte conservée entre niveaux', () => {
  expect(oklchToRgb(1, 0, 0).map((v) => Math.round(v * 255))).toEqual([255, 255, 255]);
  expect(oklchToRgb(0, 0, 0)).toEqual([0, 0, 0]);
  const a = groupPalette({ depth: 0, hue: 255 }, DEFAULT_PARAMS), b = groupPalette({ depth: 1, hue: 255 }, DEFAULT_PARAMS);
  expect(a.closed).not.toEqual(b.closed);
  for (const c of [...a.closed, ...a.open, ...b.closed]) expect(c).toBeGreaterThanOrEqual(0);
});
```

- [ ] **Step 2 : lancer, constater l'échec**

Run : `npm install` à la racine, puis `npm test -w packages/view`.
Expected : FAIL, modules introuvables.

- [ ] **Step 3 : implémenter.** OKLCH → sRGB par les matrices d'Ottosson (OKLab → LMS → sRGB linéaire → gamma), avec un écrêtage entre 0 et 1.

- [ ] **Step 4 : tests et types**

Run : `npm test -w packages/view` et `npx tsc --noEmit -p packages/view`.
Expected : tout passe.

- [ ] **Step 5 : commit et push** (`feat(view): paramètres de rendu, niveaux de détail, caméra et couleurs`).

---

### Task 2 : Scène d'un plan

**Files :**
- Create: `packages/view/src/scene.ts`, `packages/view/src/geometry/hull.ts` (`convexHull`, `offsetPolygon`, `centroid`)
- Test: `packages/view/tests/scene.test.ts`, `packages/view/tests/hull.test.ts`

**Interfaces :**
- Consumes : `State`, `groupIndex`, `ancestors`, `placementKey`, `branchKey`, `layoutKey` (`@cirrus/core`) ; `buildFixture` (`@cirrus/fixtures`, en dépendance de développement) ; `RenderParams`, `stepScale`.
- Produces :

```ts
/** Lines of a title at base size: font baseFontPx, wrap width boxWidth − 2·boxPadX (layout is scale-invariant). */
export type Measure = (title: string) => number;
export type ItemKind = 'node' | 'group' | 'phantom';
export interface SceneItem {
  id: Id;                  // node id, or phantom id
  kind: ItemKind;
  node: Id;                // represented node (a phantom's of.node)
  phantom?: 'node' | 'center' | 'absent';
  connection?: Id;         // phantoms only
  title: string;
  lines: number;
  x: number; y: number;    // world centre; a group's is derived from its members
  k: number;
  halfW: number; halfH: number; // world half sizes of the box (group: of its closed title box, unused for hit)
  parent: number;          // drawn parent group, -1 at top level
  children: number[];
  depth: number;
  badge: boolean;          // connections existing but absent from this plan (spec 11.3)
  hull?: Vec2[];           // group: convex hull of its members' footprints (world), before padding
  pad?: number;            // group: envelopePad × stepScale(maxChildK)
  maxChildK?: number;      // group: largest member step (drives the fold, spec 8.2)
}
export interface SceneEnd { item: number; role: Role; key: Id; dashed: boolean }
export interface SceneStub { role: Role; node: Id; title: string }
export interface SceneConnection {
  index: number;
  id: Id;
  part: 'main' | 'far';
  title: string;
  ends: SceneEnd[];
  stubs: SceneStub[];
  center?: number;          // 'far' part: the centre phantom, a fixed marker
  layout?: ConnectionLayout;
}
export interface PlanScene {
  plan: PlanRec;
  items: SceneItem[];
  byId: Map<Id, number>;
  roots: number[];
  connections: SceneConnection[];
  bounds: Bounds | null;
}
export function buildScene(s: State, plan: Id, measure: Measure, p: RenderParams): PlanScene;
```

**Règles (spec 5.5, 7, 8.4, 8.5, 10, 11.3) :**
- **Éléments :** les nœuds placés dans le plan et non jetés, plus tous les fantômes du plan.
  - Un nœud est un groupe s'il a au moins un membre dessiné, nœud ou fantôme.
  - Un groupe vide reste un nœud simple.
- **Parent dessiné :**
  - pour un nœud, le premier élément placé de `ancestors(s, plan, node, index)` ;
  - pour un fantôme, `phantom.group` s'il est placé, sinon le plus proche ancêtre placé de ce groupe.
- **Boîtes :**
  - demi-largeur : `boxWidth/2 × stepScale(k)` ;
  - demi-hauteur : `(lines × lineHeight × baseFontPx + 2 × boxPadY)/2 × stepScale(k)` ;
  - fantôme `'node'` : la boîte du nœud représenté, au cran du fantôme ;
  - fantômes `'center'` et `'absent'` : un disque de rayon `centerRadius × stepScale(k)`.
- **Groupes, calculés de bas en haut :**
  - **position :** le barycentre des centres des enfants ;
  - **enveloppe brute (`hull`) :** l'enveloppe convexe des quatre coins de chaque boîte enfant et du polygone de chaque sous-groupe, élargi de sa marge par `offsetPolygon` ;
  - **`maxChildK` :** le plus grand cran des enfants ;
  - **`pad` :** `envelopePad × stepScale(maxChildK)`.
- **Profondeur :** 0 au premier niveau.
- **Connexions :**
  - On prend les connexions non jetées de type `knowledge` dans un lobby ou un plan ordinaire, et de type `structure` dans un plan document. Les inclusions ne se dessinent jamais.
  - **Partie `'main'` :** ses extrémités sont :
    - les membres qui ont une branche dans le plan et sont placés ;
    - les fantômes `'node'` de la connexion, avec le rôle du nœud lointain ;
    - les fantômes `'absent'`, en pointillés.

    Un membre qui a une branche mais n'est ni placé ni représenté par un fantôme `'absent'` devient une amorce (`SceneStub`).
  - La partie `'main'` n'existe que si au moins deux extrémités ne sont pas en pointillés (spec 11.2).
  - **Partie `'far'` :** une par fantôme `'center'`. Son unique extrémité est le nœud lointain s'il est placé, et `center` vaut l'indice du fantôme.
- **Badge :** un nœud placé porte un badge s'il est membre d'une connexion `knowledge` non jetée qui n'a pas de branche (connexion, nœud) dans ce plan.
- **`bounds` :** la réunion des boîtes et des enveloppes élargies, ou `null` pour un plan vide.

- [ ] **Step 1 : tests.**
  - Les tests utilisent une mesure factice, `const measure: Measure = (t) => Math.max(1, Math.ceil(t.length / 23))`.
  - La base de test est construite dans un dossier temporaire avec `LocalStore.open(mkdtempSync(...))` et `buildFixture`.

```ts
test('lobby de la base de test : hiérarchie à trois niveaux', () => {
  const sc = buildScene(s, ids.plans.lobby, measure, DEFAULT_PARAMS);
  const it = (id: Id) => sc.items[sc.byId.get(id)!];
  expect(it(ids.nodes.groupeTheorie).kind).toBe('group');
  expect(sc.items[it(ids.nodes.groupeInduction).parent].id).toBe(ids.nodes.groupeComplexite);
  expect(sc.items[it(ids.nodes.groupeComplexite).parent].id).toBe(ids.nodes.groupeTheorie);
  expect(it(ids.nodes.groupeTheorie).depth).toBe(0);
  expect(it(ids.nodes.trashed)).toBeUndefined(); // sc.byId has no trashed node
});
test('un groupe déduit sa position et son enveloppe de ses membres (spec 10)', () => {
  const g = it(ids.nodes.groupeInduction);
  const kids = g.children.map((i) => sc.items[i]);
  expect(g.x).toBeCloseTo(kids.reduce((a, c) => a + c.x, 0) / kids.length, 9);
  expect(g.maxChildK).toBe(0);
  expect(g.pad).toBe(DEFAULT_PARAMS.envelopePad);
});
test('un long titre agrandit la boîte en hauteur sans tronquer', () => {
  const long = 'Un titre vraiment très long qui ne tient pas sur une seule ligne de boîte';
  // a one-node plan built with createPlan/createNode on a fresh state
  expect(item.lines).toBe(measure(long));
  expect(item.halfH).toBeGreaterThan(oneLineItem.halfH);
});
test('le fantôme du bras scindé est dans le groupe de MDL, et la partie lointaine relie Universalité au centre', () => {
  const ph = sc.items[sc.byId.get(ids.phantoms.node)!];
  expect(ph.kind).toBe('phantom');
  expect(sc.items[ph.parent].id).toBe(ids.nodes.groupeComplexite);
  const parts = sc.connections.filter((c) => c.id === ids.connections.split);
  expect(parts.map((c) => c.part).sort()).toEqual(['far', 'main']);
  const far = parts.find((c) => c.part === 'far')!;
  expect(sc.items[far.ends[0].item].id).toBe(ids.nodes.universalite);
  expect(sc.items[far.center!].id).toBe(ids.phantoms.center);
});
test('Thèse : Entropie absente devient une amorce, et le badge signale les connexions absentes', () => {
  const th = buildScene(s, ids.plans.these, measure, DEFAULT_PARAMS);
  const c = th.connections.find((x) => x.id === ids.connections.twoToOne)!;
  expect(c.stubs).toEqual([{ role: 'source', node: ids.nodes.entropie, title: 'Entropie de Shannon' }]);
  expect(th.items[th.byId.get(ids.nodes.mdl)!].badge).toBe(true); // MDL has lobby connections absent here
});
test('document : structure dessinée, connaissance masquée ; inclusion jamais dessinée', () => {
  const doc = buildScene(s, ids.plans.article, measure, DEFAULT_PARAMS);
  expect(doc.connections.every((c) => s.connections.get(c.id)!.kind === 'structure')).toBe(true);
  expect(sc.connections.some((c) => s.connections.get(c.id)!.kind === 'inclusion')).toBe(false);
});
test('groupe retiré du plan : ses membres se dessinent dans le plus proche ancêtre placé (spec 7)', () => {
  // removeFromPlan(groupeInduction) on a copy of the fixture state
  expect(sc2.items[sc2.items[sc2.byId.get(ids.nodes.solomonoff)!].parent].id).toBe(ids.nodes.groupeComplexite);
});
test('plan vide : aucun élément, bornes nulles', () => {
  const empty = buildScene(stateWithEmptyPlan, planId, measure, DEFAULT_PARAMS);
  expect(empty.items).toEqual([]);
  expect(empty.bounds).toBeNull();
});
```

  `hull.test.ts` :
  - `convexHull` d'un carré avec son centre donne les quatre coins dans le sens trigonométrique.
  - `offsetPolygon(carré, 10)` éloigne chaque sommet de 10 le long de sa normale moyenne.
  - Un ou deux points donnent un octogone, comme le banc.

- [ ] **Step 2 : lancer, constater l'échec.** `npm test -w packages/view`. Expected : FAIL.
- [ ] **Step 3 : implémenter `buildScene`.**
  - Un seul `groupIndex(s)` pour toute la scène.
  - Groupes calculés dans l'ordre postfixe des profondeurs.
  - Une connexion n'est lue qu'une fois : on regroupe d'abord les branches du plan par connexion, en un seul passage sur `s.branches`.
- [ ] **Step 4 : tests et types.** Expected : tout passe.
- [ ] **Step 5 : commit et push** (`feat(view): scène d'un plan tirée de l'état (groupes, fantômes, amorces, badges)`).

---

### Task 3 : Géométrie des faisceaux, des enveloppes et du fond

**Files :**
- Create: `packages/view/src/geometry/bundle.ts`, `geometry/ribbon.ts`, `geometry/envelope.ts`, `geometry/stars.ts`, `geometry/grid.ts`, `geometry/arrays.ts`
- Test: `packages/view/tests/bundle.test.ts`, `ribbon.test.ts`, `envelope.test.ts`, `background.test.ts`

**Interfaces :**
- Produces :

```ts
// arrays.ts: growable typed arrays, so a rebuild fills existing storage instead of allocating per element.
export class FloatList { constructor(initial?: number); push(...v: number[]): void; get length(): number; view(): Float32Array; clear(): void }
export class IndexList { /* same with Uint32Array */ }

// bundle.ts — the maquette's geom() (spec 8.5)
export interface BundleEnd {
  pos: Vec2; halfW: number; halfH: number;       // box to anchor on
  hull?: { poly: Vec2[]; centre: Vec2; pad: number }; // a closed group: anchor on its padded envelope
  role: Role; k: number; hollow: boolean; dashed: boolean; key: Id;
}
export interface BundleInput {
  ends: BundleEnd[];
  stubs: { role: Role }[];          // absent members without a phantom
  centre?: Vec2;                    // 'far' part: fixed marker (the centre phantom)
  layout?: Pick<ConnectionLayout, 'marker' | 'angle' | 'handles'>;
}
export interface Branch { p0: Vec2; b1: Vec2; b2: Vec2; p3: Vec2; nodeEnd: 'p0' | 'p3'; role: Role; kNode: number; kMarker: number; hollow: boolean; dashed: boolean; stub: boolean }
export interface BundleGeometry { marker: Vec2; u: Vec2; kMax: number; trunk: [Vec2, Vec2] | null; branches: Branch[]; multi: boolean }
export function bundleGeometry(input: BundleInput, p: RenderParams): BundleGeometry;

// ribbon.ts
export function bezierSegments(p0: Vec2, c0: Vec2, c1: Vec2, p3: Vec2, pxPerUnit: number, tolPx: number): number; // port of the bench
/**
 * Per-vertex attributes of the connection meshes; one call appends one visible connection. position2/normal2 hold the
 * same vertex once the fading group level is closed: the shader slides from one to the other (spec 8.5, "glisse en
 * continu du membre vers le bord du groupe").
 */
export interface ConnectionMeshes {
  ribbons: { position: FloatList; position2: FloatList; normal: FloatList; normal2: FloatList; scale: FloatList; side: FloatList; dist: FloatList; end0: FloatList; end1: FloatList; fold: FloatList; conn: FloatList; index: IndexList };
  glyphs:  { position: FloatList; position2: FloatList; offset: FloatList; offset2: FloatList; scale: FloatList; fill: FloatList; end0: FloatList; end1: FloatList; fold: FloatList; conn: FloatList; index: IndexList };
}
export function newConnectionMeshes(): ConnectionMeshes;
export interface AppendOptions {
  pxPerUnit: number;               // zoom × curveZoomHeadroom: flattening stays valid until then
  end0: [number, number, number];  // two endpoints (x, y, half extent) for the off-screen fade (spec 8.5)
  end1: [number, number, number];
  fade: 'none' | 'slide' | 'out';  // Task 4; fold = (mode code, foldK) per vertex
  foldK: number;
  conn: number;                    // visible connection index (hover)
}
/**
 * Appends ribbons (trunk + branches) and glyphs (arrows, dots, hollow arrows) of one bundle; returns each branch's
 * centerline (open state). `closed` is the same bundle with the fading level closed: same branches in the same order,
 * sampled with the same segment counts (the larger of the two), so vertex i of one matches vertex i of the other.
 */
export function appendBundle(m: ConnectionMeshes, open: BundleGeometry, closed: BundleGeometry | null, o: AppendOptions, p: RenderParams): Vec2[][];

// envelope.ts
export interface EnvelopeMeshes { position: FloatList; normal: FloatList; alpha: FloatList; open: FloatList; closed: FloatList; foldK: FloatList; index: IndexList }
export function appendEnvelope(m: EnvelopeMeshes, hull: Vec2[], pad: number, colors: { open: Rgb; closed: Rgb }, maxChildK: number): void;

// stars.ts (port of the bench) and grid.ts
export function starsInRect(rect: { x: number; y: number; w: number; h: number }, layerK: number, seed: number, p: RenderParams): Vec2[];
export function starLayerAlpha(layerK: number, zoom: number, p: RenderParams): number;
export function gridLevels(zoom: number, p: RenderParams): { spacingWorld: number; alpha: number }[];
```

**Géométrie, reprise de la maquette (`geom`, `anchor`, `hullAnchor`, `glyphOf`) :**
- **Deux associés seuls :** sans source ni cible, deux associés se traitent comme une source et une cible, avec un point aux deux bouts (`pairNeu`).
- **Centres :**
  - `cs` est le centre des sources, `ct` celui des cibles ;
  - si l'un des deux manque, on prend le centre de toutes les extrémités ;
  - `u = norm(ct − cs)`, ou (1, 0) si c'est dégénéré.
- **Réglages du plan :** `layout.angle` impose u. `layout.marker` impose M en position absolue. Sinon M = (cs + ct)/2. Pour la partie `'far'`, M est le centre fixe, et u part du centre vers le nœud.
- **Tronc :**
  - `kMax` est le plus grand cran des extrémités, et `sc = stepScale(kMax)` ;
  - le faisceau est multiple (`multi`) s'il a plus de deux extrémités et amorces au total ;
  - h vaut `trunkLength/2 × sc` si `multi`, sinon 0 ;
  - A = M − u·h et B = M + u·h, et le tronc va de A à B.
- **Branches :**
  - **ancrage :** le bord de la boîte, plus `anchorGap × stepScale(k)`. Pour un groupe replié, c'est le rayon du centroïde vers le point, coupé par le polygone, plus la marge.
  - **source :** de l'ancrage a vers A, avec `t = trunkTension × |A − a|`, `b1 = a + norm(A − a)·0.6t` et `b2 = A − u·t`.
  - **cible :** de B vers l'ancrage, symétriquement.
  - **associé :** vers M, avec `b2 = M + n·t`, où n est perpendiculaire à u, du côté de l'extrémité.
  - **décalages :** ceux de `layout.handles[key]` s'ajoutent à b1 et b2.
- **Amorces :**
  - **source :** le bout est `A + rot(−u, ±stubAngle) × stubLength × sc`, avec un angle qui alterne d'une amorce à l'autre ;
  - **cible :** symétriquement depuis B ;
  - **associé :** perpendiculairement depuis M.

  Elles sont en pointillés, avec `stub: true`.
- **Échelle le long d'une branche :** `factor^(kNode + (kMarker − kNode)·s)`, où s va de 0 à 1 du nœud au marqueur.
- **Rubans :**
  - deux sommets par point de la ligne médiane, avec `side` = ±1 pour l'anticrénelage ;
  - `dist` est la longueur cumulée dans le monde pour les pointillés, et vaut −1 pour un trait plein ;
  - les points sont aplatis par `bezierSegments` avec `curveTolerancePx` ;
  - une branche plus fine que `ribbonCullAlpha` au zoom de validité n'est pas construite.
- **Glyphes**, en unités de largeur de trait, mis à l'échelle par le shader :
  - **flèche échancrée :** longueur `arrowLength`, demi-largeur `arrowHalfWidth` et échancrure `arrowNotch` ;
    - pour une source, elle sort du nœud, pointe à `arrowLength` de l'ancrage, dans la direction de b1 ;
    - pour une cible, elle entre, pointe sur l'ancrage, dans la direction p3 − b2 ;
  - **point d'un associé :** un disque de rayon `dotRadius`, en 12 côtés ;
  - **flèche évidée :** quand l'extrémité vient de l'intérieur d'un groupe replié, on ajoute une seconde flèche réduite de `hollowInset` et remplie de la couleur du ciel (`fill` = 0).
- **Enveloppe :**
  - un éventail intérieur d'alpha 1 sur `offsetPolygon(hull, pad)` ;
  - un anneau extérieur dont les sommets portent la normale sortante et un alpha de 0 ;
  - le shader repousse l'anneau de `mix(featherOpenPx, featherClosedPx, foldT)` pixels.

- [ ] **Step 1 : tests**

```ts
test('1 vers 1 : pas de tronc, les deux branches se rejoignent en M, tangentes à u', () => {
  const g = bundleGeometry({ ends: [end({ x: 0, y: 0 }, 'source'), end({ x: 1000, y: 0 }, 'target')], stubs: [] }, P);
  expect(g.trunk).toBeNull();
  expect(g.marker).toEqual({ x: 500, y: 0 });
  expect(g.branches[0].p3).toEqual(g.branches[1].p0);
  expect(g.branches[0].b2.y).toBeCloseTo(0, 9); // b2 on the axis: tangent
});
test('faisceau 3 → 1 : tronc de trunkLength à l’échelle du plus grand cran', () => {
  const g = bundleGeometry({ ends: [src(0, 0, 0), src(0, 200, 1), src(0, 400, 0), tgt(1000, 200, 0)], stubs: [] }, P);
  expect(g.multi).toBe(true);
  expect(dist(g.trunk![0], g.trunk![1])).toBeCloseTo(P.trunkLength * 2, 9);
});
test('les ancrages sont sur le bord des boîtes', () => {
  // end at (0,0) halfW 105 halfH 23, target to the right: anchor x = 105 + anchorGap
});
test('géométrie dégénérée : jamais de NaN (Review Focus 4)', () => {
  for (const input of [sameSpot, sameCentres, farSteps, oneEndOneStub, onlyAssociates]) {
    const m = newConnectionMeshes();
    appendBundle(m, bundleGeometry(input, P), opts, P);
    for (const list of Object.values(m.ribbons)) expect([...list.view()].every(Number.isFinite)).toBe(true);
  }
});
test('aplatissement : une droite tient en un segment, une courbe en plusieurs', () => {
  expect(bezierSegments({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 90, y: 0 }, { x: 100, y: 0 }, 1, 0.2)).toBe(1);
  expect(bezierSegments({ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 0 }, 1, 0.2)).toBeGreaterThan(4);
});
test('amorce en pointillés : dist croissant, flèche de la source à son bout', () => {
  const g = bundleGeometry({ ends: [src(0, 0, 0), tgt(1000, 0, 0)], stubs: [{ role: 'source' }] }, P);
  const stub = g.branches.find((b) => b.stub)!;
  expect(stub.dashed).toBe(true);
});
test('enveloppe : anneau extérieur à alpha 0 avec normales unitaires', () => { /* appendEnvelope on a square */ });
test('étoiles déterministes, une couche bornée en densité (Review Focus 5)', () => {
  expect(starsInRect(r, 0, 7, P)).toEqual(starsInRect(r, 0, 7, P));
  // at zoom 1e-3 and 1e3 the visible layers are at most 2 and each holds < 10 000 stars for a 2560×1600 screen
});
```

- [ ] **Step 2 : lancer, constater l'échec.**
- [ ] **Step 3 : implémenter.** Le tableau des sommets ne reçoit jamais de NaN : toute normalisation d'un vecteur de longueur inférieure à 1e-9 renvoie (1, 0).
- [ ] **Step 4 : tests et types.** Expected : tout passe.
- [ ] **Step 5 : commit et push** (`feat(view): géométrie des faisceaux, enveloppes et fond`).

---

### Task 4 : Visibilité, survol, placement des titres

**Files :**
- Create: `packages/view/src/visibility.ts`, `packages/view/src/hit.ts`, `packages/view/src/titles.ts`, `packages/view/src/frame.ts`
- Test: `packages/view/tests/visibility.test.ts`, `hit.test.ts`, `titles.test.ts`, `frame.test.ts`, `scale.test.ts`

**Interfaces :**
- Produces :

```ts
// visibility.ts
export interface SceneIndex { /* flat arrays like the bench: parent, x, y, extent, maxChildK, roots Flatbush, connections by lowest common group */ }
export function buildIndex(scene: PlanScene, p: RenderParams): SceneIndex;
export type LevelState = 'open' | 'fading' | 'closed';
/** One letter per distinct maxChildK: the visible set only changes when this string does. */
export function foldSignature(index: SceneIndex, zoom: number, p: RenderParams): string;
/** item: drawn endpoint with the fading level open; item2: with it closed (equal outside a fold transition). */
export interface VisibleEnd { item: number; item2: number; role: Role; key: Id; hollow: boolean; hollow2: boolean; dashed: boolean }
export interface VisibleConnection {
  conns: number[];            // scene connection indices merged into this line (length ≥ 1, spec 8.5 "2 connexions")
  ends: VisibleEnd[];
  stubs: SceneStub[];
  center?: number;
  /** none: static; slide: endpoints glide from item to item2 as the level folds; out: internal to the folding group, fades with it. */
  fade: 'none' | 'slide' | 'out';
  foldK: number;              // maxChildK of the fading level, NaN when fade is 'none'
}
export interface VisibleSet { items: number[]; groups: number[]; connections: VisibleConnection[]; signature: string }
export function computeVisible(scene: PlanScene, index: SceneIndex, cam: Camera, p: RenderParams): VisibleSet;

// frame.ts — everything a rebuild needs, pure (Task 9 runs it in a worker)
export interface FrameGeometry {
  connections: ConnectionMeshes;
  envelopes: EnvelopeMeshes;
  centerlines: { conn: number; points: Vec2[] }[];
  markers: { conn: number; pos: Vec2; kMax: number; multi: boolean }[];
  titles: { conn: number; text: string; box: { x: number; y: number; w: number; h: number }; kMax: number }[];
}
export function buildFrame(scene: PlanScene, visible: VisibleSet, cam: Camera, origin: Vec2, p: RenderParams): FrameGeometry;

// hit.ts
export type Hit =
  | { kind: 'item'; item: number }
  | { kind: 'connection'; conn: number }        // visible connection index
  | { kind: 'stub'; conn: number; stub: number }
  | { kind: 'background' };
export interface HitIndex { hit(wx: number, wy: number, zoom: number): Hit; openGroupsAt(wx: number, wy: number): number[] /* deepest first */ }
export function buildHitIndex(scene: PlanScene, visible: VisibleSet, frame: FrameGeometry, origin: Vec2, p: RenderParams): HitIndex;

// titles.ts — the maquette's placeTitles()
export type TitleSide = 'up' | 'upright' | 'upleft' | 'down' | 'downright' | 'downleft' | 'right' | 'left' | 'upfar' | 'downfar';
export function placeTitle(marker: Vec2, w: number, h: number, gap: number, samples: Vec2[], obstacles: Rect[], previous?: TitleSide): { side: TitleSide; rect: Rect };
```

**Règles :**
- **État d'un groupe**, d'après `t = foldT(maxChildK)` :
  - `closed` si t = 1 ;
  - `fading` si 0 < t < 1 ;
  - `open` si t = 0.

  Avec les défauts, `groupFold[1]/groupFold[0]` vaut environ 1,44, moins que `factor`, donc au plus un cran à la fois est en transition.
- **Éléments :**
  - on parcourt depuis les racines dans la vue, élargie de `viewMarginPx`, et on descend dans tout groupe qui n'est pas `closed` ;
  - `items` reçoit les nœuds et les fantômes rencontrés, `groups` tous les groupes rencontrés, parents d'abord.
- **Extrémité d'un membre :**
  - `item` est l'ancêtre `closed` le plus haut, ou le membre lui-même ;
  - `item2` est l'ancêtre `closed` ou `fading` le plus haut, ou le membre ;
  - `hollow` et `hollow2` valent vrai si l'extrémité correspondante n'est pas le membre lui-même.
- **`fade` :**
  - `'none'` si toutes les extrémités ont `item = item2` ;
  - `'out'` si les `item2` donnent moins de deux extrémités distinctes, amorces comptées : la connexion est interne au groupe qui se replie, elle reste en place et s'efface avec lui ;
  - `'slide'` sinon : les bouts glissent du membre vers le bord du groupe (spec 8.5) ;
  - `foldK` vaut le `maxChildK` de l'ancêtre `fading` en cause.
- **Une connexion est écartée si :**
  - elle est `'none'` et ses `item` donnent moins de deux extrémités distinctes (interne à un groupe replié) ;
  - ou aucune de ses extrémités (`item` ou `item2`) n'est dans la vue élargie (le centre d'une partie `'far'` compte comme une extrémité).
- **Doublons pendant un glissement :** les extrémités en double ne fusionnent pas ; elles convergent vers le même bord et ne fusionnent qu'une fois le groupe `closed`, comme dans la maquette (`dup` à t ≥ 0,999).
- **Agrégation :** seulement pour `fade: 'none'`. Les connexions sans `layout`, sans amorce et sans centre qui relient les mêmes couples (extrémité, rôle) fusionnent, et `conns` les liste.
- **`buildFrame` :**
  - il dessine chaque connexion visible par `bundleGeometry` sur les `item`, et pour `'slide'` une seconde fois sur les `item2`, puis `appendBundle`, dans un repère relatif à `origin` ;
  - il ajoute chaque groupe de `groups` à `envelopes`, parents d'abord ;
  - il place les titres avec `placeTitle` :
    - le texte est le titre de la connexion, ou « n connexions » pour une agrégation ;
    - la largeur est estimée à `0,52 × taille × longueur` ;
    - la taille vaut `titleFontPx × stepScale(kMax)` ;
    - les obstacles sont les boîtes visibles.
- **`hit` :**
  - **ordre de priorité :** élément (le plus profond d'abord), puis amorce (son bout), puis connexion (distance à une ligne médiane inférieure à `hitTolerancePx/zoom`), puis fond ;
  - un groupe replié se touche dans son enveloppe élargie ;
  - le fond d'un groupe ouvert compte comme du fond (spec 9.1).
- **`openGroupsAt` :** les groupes ouverts dont l'enveloppe élargie contient le point, du plus profond au plus haut. Il sert au rappel de hiérarchie (spec 8.4).

- [ ] **Step 1 : tests**

```ts
test('dézoom : le groupe Induction se replie et ses connexions sortantes partent de son bord (évidées)', () => {
  const cam = camAtTextPx(0, 4); // members' text at 4 px: groupeInduction (maxChildK 0) closed
  const v = computeVisible(sc, idx, cam, P);
  expect(v.items).not.toContain(iSolomonoff);
  const c = v.connections.find((x) => x.conns.some((i) => sc.connections[i].id === solUni))!;
  expect(c.ends.find((e) => e.role === 'source')).toMatchObject({ item: iGroupeInduction, hollow: true });
});
test('en transition, les bouts glissent vers le bord, et un seul cran est en transition', () => {
  const v = computeVisible(sc, idx, camAtTextPx(0, 5.5), P);
  const c = v.connections.find((x) => x.conns.some((i) => sc.connections[i].id === solUni))!;
  expect(c.fade).toBe('slide');
  expect(c.ends.find((e) => e.role === 'source')).toMatchObject({ item: iSolomonoff, item2: iGroupeInduction, hollow2: true });
  expect(new Set(v.connections.filter((x) => x.fade !== 'none').map((x) => x.foldK)).size).toBe(1);
});
test('connexion interne à un groupe qui se replie : en place, puis effacée', () => {
  // priore → solomonoff inside groupeInduction: 'out' while fading, absent once closed
});
test('deux connexions entre les mêmes extrémités repliées fusionnent en « 2 connexions »', () => {
  // groupeComplexite closed (camAtTextPx(1, 4)): MDL→Universalité (split: excluded, has a centre) and Solomonoff→Universalité…
  // use a dedicated small state: two sources in one group, both → the same outside node
  expect(v.connections.find((c) => c.conns.length === 2)).toBeDefined();
});
test('hors écran : une connexion dont aucune extrémité n’est dans la vue élargie n’est pas visible', () => { /* camera far away */ });
test('survol : nœud avant connexion avant fond ; fond d’un groupe ouvert = fond', () => { /* buildHitIndex on the lobby */ });
test('titre : « up » si libre, autre côté si une boîte le recouvre, côté précédent préféré', () => { /* placeTitle */ });
test('cadre complet sans NaN sur les trois plans de la base de test, à cinq zooms', () => { /* buildFrame */ });
test('grande base : scène, index, visibilité et cadre sous 300 ms (10 000 nœuds, 60 000 connexions)', () => { /* like core scale.test */ }, 120_000);
```

- [ ] **Step 2 : lancer, constater l'échec.**
- [ ] **Step 3 : implémenter.**
  - On reprend `bench/rendu/src/scene/visibility.ts` (tableaux plats, Flatbush sur les racines, connexions rangées par plus bas groupe commun, chemin rapide à deux membres) et on y ajoute les deux extrémités (`item`, `item2`) et le mode `fade`.
  - L'index des survols est un Flatbush des boîtes, plus un Flatbush des segments des lignes médianes.
- [ ] **Step 4 : tests et types.** Expected : tout passe, dont le test de grande base.
- [ ] **Step 5 : commit et push** (`feat(view): visibilité avec transitions de repli, survol et titres`).

---

### Task 5 : Coquille Electron

**Files :**
- Create: `packages/core/src/snapshot.ts` (exporté par l'index), test `packages/core/tests/snapshot.test.ts`
- Create: `packages/app/package.json` (`@cirrus/app`, `"main": "./out/main/index.js"`, scripts `dev`, `build`, `start`, `test`, `capture`, `font`), `packages/app/electron.vite.config.ts`, `tsconfig.json`, `vitest.config.ts`
- Create: `packages/app/src/main/index.ts`, `src/main/base.ts`, `src/main/settings.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/main.tsx`, `src/renderer/App.tsx`, `src/renderer/bridge.ts`, `src/renderer/ui/Tabs.tsx`, `src/renderer/env.d.ts`
- Create: `packages/app/scripts/capture.mjs`, `packages/app/scripts/build-font.mjs` (copie de celui du banc), `packages/app/src/renderer/public/font/inter-msdf.fnt`, `inter-msdf.png` (copies)
- Test: `packages/app/tests/settings.test.ts`, `packages/app/tests/base.test.ts`

**Interfaces :**
- Consumes : `LocalStore` (`@cirrus/store`), `createPlan` et `uuidv7` (`@cirrus/core`).
- Produces :
  - **`core/snapshot.ts` :**
    - `interface Snapshot { nodes: NodeRec[]; connections: ConnectionRec[]; plans: PlanRec[]; tagKeys: TagKeyDef[]; placements: Placement[]; branches: string[]; connLayouts: ConnectionLayout[]; phantoms: PhantomRec[] }` ;
    - `toSnapshot(s: State): Snapshot` et `fromSnapshot(x: Snapshot): State`.

    C'est un format sans Map, pour l'IPC et la synchro future.
  - **`main/base.ts` :**
    - `openBase(dir: string): LocalStore` crée le dossier.
      - L'identifiant du PC est lu dans `pc.json`, ou créé avec `uuidv7()` à la première ouverture.
      - S'il n'existe aucun plan `lobby`, il crée le lobby par `createPlan(s, 'Lobby', 'lobby')`.
    - `dataDir(): string` vaut `process.env.CIRRUS_DATA`, ou à défaut `join(app.getPath('userData'), 'base')`.
  - **`main/settings.ts` :**
    - `readSettings(dir): Record<string, unknown>` lit `settings.json`. Un fichier absent ou illisible donne `{}`, et une alerte est écrite dans la console.
    - `writeSettings(dir, overrides)` écrit un fichier temporaire puis le renomme.
    - Le fichier ne contient que les valeurs différentes des défauts (spec 19 : paramètres hors historique). La synchro viendra au plan 5.
  - **IPC (`ipcMain.handle`) :**
    - `cirrus:snapshot` renvoie un `Snapshot` ;
    - `cirrus:settings:get` renvoie les surcharges ;
    - `cirrus:settings:set` reçoit `(overrides)` ;
    - `cirrus:ready` signale la première image dessinée.
  - **Préchargement :** `window.cirrus = { snapshot(): Promise<Snapshot>; getSettings(): Promise<Record<string, unknown>>; setSettings(o): Promise<void>; ready(): void; launch: { plan?: string; view?: string } }`. `launch` vient des variables `CIRRUS_PLAN` et `CIRRUS_VIEW` (« x,y,zoom »), transmises par les arguments de la fenêtre (`additionalArguments`).
  - **Capture :** si `CIRRUS_CAPTURE=<chemin.png>`, le processus principal capture la page 500 ms après `cirrus:ready`, écrit le PNG et quitte. `npm run capture -w packages/app -- <png> [--plan=<nom>] [--view=x,y,zoom] [--data=<dossier>]` compile, construit la base de test dans un dossier temporaire si `--data` est absent, puis lance l'app.
  - **Interface :**
    - `App` charge l'instantané et les réglages ;
    - les onglets montrent le lobby, toujours ouvert, et les plans ouverts ;
    - un bouton + liste les plans à ouvrir, et une croix ferme un onglet de plan ;
    - les onglets ouverts sont gardés dans `localStorage`, dans un try/catch [C] ;
    - la zone du graphe est un `div` qui accueillera le moteur de la tâche 6, et affiche pour l'instant le nom du plan et son nombre de nœuds ;
    - le style suit la maquette : ciel, encre et bleus.

- [ ] **Step 1 : tests**

```ts
// core/tests/snapshot.test.ts
test('instantané aller-retour sur la base de test', () => {
  expect(canonical(stateParts(fromSnapshot(toSnapshot(s))))).toBe(canonical(stateParts(s)));
});
// app/tests/base.test.ts
test('première ouverture : un lobby et un identifiant de PC stable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cirrus-'));
  const a = openBase(dir); const pcA = readFileSync(join(dir, 'pc.json'), 'utf8'); a.close();
  const b = openBase(dir);
  expect([...b.state.plans.values()].filter((p) => p.type === 'lobby')).toHaveLength(1);
  expect(readFileSync(join(dir, 'pc.json'), 'utf8')).toBe(pcA);
  b.close();
});
// app/tests/settings.test.ts
test('réglages : absents, corrompus, puis écrits', () => {
  expect(readSettings(dir)).toEqual({});
  writeFileSync(join(dir, 'settings.json'), '{pas du json');
  expect(readSettings(dir)).toEqual({});
  writeSettings(dir, { factor: 3 });
  expect(readSettings(dir)).toEqual({ factor: 3 });
});
```

- [ ] **Step 2 : lancer, constater l'échec.** `npm test -w packages/core` et `npm test -w packages/app`. Expected : FAIL.
- [ ] **Step 3 : implémenter.**
  - La configuration d'electron-vite suit celle du banc : préchargement en CommonJS (`index.cjs`), extension React pour l'interface.
  - `node:sqlite` reste externe.
  - L'import de PixiJS passe par `pixi.js/unsafe-eval`, car la CSP interdit `eval`.
- [ ] **Step 4 : vérifier.**
  - `npm test -w packages/core` et `npm test -w packages/app` passent.
  - `npx tsc --noEmit -p packages/app` est propre.
  - `npm run capture -w packages/app -- <scratchpad>/coquille.png` produit une image qui montre les onglets « Lobby » et le nom du plan. On la regarde.
- [ ] **Step 5 : commit et push** (`feat(app): coquille Electron (base locale, réglages, onglets, capture)`).

---

### Task 6 : Moteur de rendu PixiJS

**Files :**
- Create: `packages/app/src/renderer/render/PlanRenderer.ts`, `render/shaders.ts`, `render/meshes.ts`, `render/texts.ts`, `render/dispose.ts`, `render/measure.ts`
- Create: `packages/app/src/renderer/ui/GraphView.tsx` (héberge le canevas, transmet caméra et taille)
- Modify: `packages/app/src/renderer/App.tsx`

**Interfaces :**
- Consumes : tout `@cirrus/view` (tâches 1 à 4).
- Produces :
  - `class PlanRenderer` :
    - `constructor(app: Application, p: RenderParams)` ;
    - `setScene(scene: PlanScene): void` ;
    - `setParams(p: RenderParams): void`, qui reconstruit les shaders si nécessaire et force une reconstruction ;
    - `setCamera(c: Camera): void` ;
    - `setHover(conn: number | null): void` ;
    - `renderFrame(): void` ;
    - `warmUp(): number` ;
    - `get hitIndex(): HitIndex | null` ;
    - `destroy(): void`.
  - `measureTitle(p): Measure` compte les lignes avec `BitmapFontManager.getLayout` (Inter MSDF, `baseFontPx`, largeur de coupure `boxWidth − 2·boxPadX`), avec un cache par titre.
  - `MeshSlot` (`meshes.ts`) garde un `Mesh` et ses tampons d'une reconstruction à l'autre :
    - `update(arrays)` réécrit les données en place si la capacité suffit ;
    - sinon il réalloue avec une capacité doublée ;
    - le nombre d'indices dessinés suit les données ;
    - `dispose()` appelle `disposeMesh`.

**Couches, du fond vers l'avant :**
1. **Fond :**
   - étoiles en couches, par cran, calculées pour la vue élargie et refaites à la sortie de celle-ci ;
   - ou grille fractale, des lignes d'opacité `gridAlpha` aux espacements de `gridLevels` ;
   - opacité `backgroundOpacity`, sur le dégradé du ciel (`skyColor`, `skyColor2`).
2. **Enveloppes :**
   - dessinées dans une `RenderTexture` à `envelopeResolution` de la taille de l'écran, puis étirées par un sprite ;
   - la couleur interpole de la couleur ouverte à la couleur repliée selon `foldT(maxChildK)` ;
   - l'anneau extérieur s'étend de `mix(featherOpenPx, featherClosedPx, t)/zoom`.
3. **Rubans :**
   - la largeur à l'écran vaut `clamp(widthBasePx × scale × zoom, widthMinPx, widthMaxPx)`, plus `hoverBoostPx` sur la connexion survolée ;
   - la position est `mix(position, position2, s)` (de même pour la normale), avec s = `foldT(foldK)` en mode `'slide'` et 0 sinon ;
   - l'alpha vaut `min(1, brut/min) × fondu hors écran`, multiplié par `1 − foldT(foldK)` en mode `'out'` ;
   - l'anticrénelage vient de `side`, avec un pixel de dégradé ;
   - les pointillés alternent `dashPx` à l'écran à partir de `dist` ;
   - les amorces prennent `absentColor`.
4. **Glyphes :** même calcul de largeur et même glissement, avec un décalage `mix(offset, offset2, s) × largeur/zoom`. `fill` = 0 donne la couleur du ciel ; l'intérieur évidé d'une flèche qui ne l'est qu'une fois repliée (`hollow2` sans `hollow`) n'apparaît qu'au-delà de s = 0,5, comme dans la maquette.
5. **Boîtes :**
   - rectangle arrondi calculé en distance signée dans le fragment, avec bord `boxBorderPx` et anticrénelage d'un pixel ;
   - alpha `1 − foldT(maxChildK du parent)` ;
   - un nœud de premier niveau garde au moins `minNodePx` à l'écran (spec 8.2) ;
   - un fantôme `'node'` a un bord en pointillés ;
   - un fantôme `'center'` est un disque de `markerColor` cerclé de `connectionColor` ;
   - un fantôme `'absent'` est un petit disque d'`absentColor` ;
   - le badge est un disque de `badgeRadiusPx` en haut à droite de la boîte.
6. **Marqueurs des faisceaux multiples :**
   - disque de `markerRadiusPx` ;
   - alpha `smooth(titleFade, textPx(kMax))`, ou 1 au survol.
7. **Textes (`BitmapText`, réserve) :**
   - **titre des nœuds et des fantômes `'node'` :** alpha `smooth(textFade, textPx(k)) × (1 − foldT(parent))` ;
   - **titre d'un groupe ouvert,** en haut de l'enveloppe : taille × `groupTitleOpenScale`, alpha `(1 − t) × smooth(textFade, textPx(k))` ;
   - **titre d'un groupe replié,** centré : taille × `groupTitleClosedScale`, alpha `smooth(0.45, 0.95, t) × smooth(textFade, …)` ;
   - **titre des connexions :** `titleColor`, alpha `smooth(titleFade, textPx(kMax))`, ou 1 au survol.

**Reconstruction :**
- Elle a lieu quand la vue sort du rectangle élargi, quand `foldSignature` change, quand la scène ou les paramètres changent, ou quand le zoom dépasse `curveZoomHeadroom` fois celui de la dernière construction.
- Elle recentre l'origine locale sur la caméra.
- Elle refait `computeVisible`, `buildFrame` et `buildHitIndex`, puis met à jour les `MeshSlot` et les textes.
- Entre deux reconstructions, seuls les uniformes changent (zoom, rectangle de l'écran, survol).

**Écran :** `Application.init({ antialias: false, resolution: devicePixelRatio, autoDensity: true, preference: 'webgl', resizeTo: hôte })`. Le moteur est préchauffé avant la première image et `cirrus:ready` est envoyé après elle.

- [ ] **Step 1 : vérifier la mesure des titres.** Un test unitaire n'est pas possible sans WebGL, d'où cette vérification visuelle. On lance la capture du lobby au zoom où le texte fait 16 px : `npm run capture -w packages/app -- <scratchpad>/lobby-16px.png --view=0,0,1`.
  - Expected avant implémentation : pas de graphe.
  - Expected après :
    - les trois niveaux d'enveloppes sont visibles, de couleurs distinctes et de même teinte ;
    - les boîtes de MDL et de Biais ont un titre sur plusieurs lignes, entier ;
    - le faisceau « Déduction jointe » montre un tronc, et « Source, cible et associé » un point d'associé ;
    - le fantôme du bras scindé est dans le groupe « Complexité et induction ».
- [ ] **Step 2 : implémenter les couches dans l'ordre, en recapturant après chacune.** Le Step 3 donne les captures de contrôle.
- [ ] **Step 3 : captures de contrôle à regarder une à une :**
  - lobby repliant `groupeInduction` : `--view=0,0,0.3` ;
  - lobby tout replié : `--view=400,200,0.08` ;
  - Thèse, avec l'amorce d'Entropie en pointillés et le badge de MDL : `--plan=Thèse` ;
  - Article MDL, avec les connexions de structure seulement : `--plan="Article MDL"` ;
  - zooms extrêmes : `--view=0,0,0.001` et `--view=0,0,1000`. Aucune erreur dans la console du processus d'interface, qui est relayée au terminal.
- [ ] **Step 4 :** `npx tsc --noEmit -p packages/app` et `npm test --workspaces --if-present`. Expected : propre et vert.
- [ ] **Step 5 : commit et push** (`feat(app): moteur de rendu PixiJS (enveloppes basse résolution, rubans anticrénelés, glyphes, textes)`), avec les captures de contrôle sous `docs/captures/plan3/`.

---

### Task 7 : Navigation, survol, rappel de hiérarchie

**Files :**
- Create: `packages/view/src/navigation.ts`, test `packages/view/tests/navigation.test.ts`
- Create: `packages/app/src/renderer/ui/HierarchyCorner.tsx`, `ui/Tooltip.tsx`
- Modify: `packages/app/src/renderer/ui/GraphView.tsx`, `App.tsx`

**Interfaces :**
- Produces :
  - `type NavInput = { t: 'wheel'; sx: number; sy: number; deltaY: number; ctrl: boolean } | { t: 'key'; key: string } | { t: 'drag'; dxPx: number; dyPx: number } | { t: 'resize'; widthPx: number; heightPx: number }`.
  - `navigate(c: Camera, input: NavInput, p: RenderParams): Camera` :
    - **molette :** `zoomAt(exp(−deltaY × wheelZoomSpeed))`. Avec Ctrl, la caméra ne change pas : Ctrl+molette change le cran d'échelle, au plan 3b ;
    - **+ et = :** zoom × `keyZoomStep` au centre ;
    - **− :** zoom ÷ `keyZoomStep` ;
    - **flèches :** déplacement de `keyPanPx` ;
    - **glisser :** déplacement de la vue ;
    - **redimensionnement :** le centre est conservé.
  - `fitItem(scene, item, cam, p): Camera` cadre un élément, ou un groupe avec son enveloppe élargie.
  - Caméra par plan : elle est gardée en mémoire tant que l'app tourne. Un plan ouvert pour la première fois est cadré sur ses bornes.
  - **Survol :**
    - le moteur reçoit `setHover(conn)` dès que `hitIndex.hit` touche une connexion ;
    - une amorce ou un fantôme montre une infobulle « absent : <titre> », « fantôme : <titre> » ou « centre : <titre de la connexion> » ;
    - le rappel de hiérarchie, en bas à gauche, liste `openGroupsAt` du plus haut au plus profond, et un clic y cadre le groupe.
  - **Glisser :** un clic gauche enfoncé sur le fond déplace la vue. Sur un élément, rien ne se passe dans ce plan ; le déplacement d'éléments vient au plan 3b.

- [ ] **Step 1 : tests de `navigate`.**
  - Zoom molette autour du curseur.
  - Ctrl+molette sans effet.
  - Les touches + et − sont inverses l'une de l'autre.
  - Une flèche déplace de `keyPanPx/zoom` dans le monde.
  - Le redimensionnement conserve le centre.
  - `fitItem` contient l'enveloppe élargie du groupe.
- [ ] **Step 2 : constater l'échec, implémenter, tests verts.**
- [ ] **Step 3 : brancher dans `GraphView`.**
  - Les gestionnaires de pointeur et de molette sont non passifs, et le clavier est actif quand le graphe a le focus.
  - Un seul `requestAnimationFrame` tourne, et il ne dessine que si quelque chose a changé : caméra, survol, scène ou paramètres.
- [ ] **Step 4 : vérification par capture.** `CIRRUS_HOVER=<x,y>`, en pixels de l'écran, simule un survol pour la capture. On capture le lobby avec le survol sur le tronc de « Déduction jointe ».
  - Expected : la connexion est plus brillante et plus large que les autres ;
  - Expected : le rappel en bas à gauche montre « Théorie algorithmique de l'information › Complexité et induction ».
- [ ] **Step 5 : commit et push** (`feat(app): navigation, survol et rappel de hiérarchie`).

---

### Task 8 : Bandeau des paramètres graphiques

**Files :**
- Create: `packages/app/src/renderer/ui/SettingsPanel.tsx`, `ui/controls.tsx`
- Modify: `App.tsx`, `GraphView.tsx`
- Test: `packages/view/tests/params.test.ts` (ajouts)

**Interfaces :**
- Consumes : `PARAM_SPECS`, `withOverrides`, `rgbToHex`, `hexToRgb`, et l'IPC des réglages de la tâche 5.
- Produces :
  - `diffFromDefaults(p: RenderParams): Partial<RenderParams>` dans `params.ts`, pour n'écrire que les écarts.
  - Le bandeau latéral, à droite, s'ouvre par un bouton ⚙ et se replie.
    - Il a deux sections, « Paramètres graphiques » puis « Avancés » (repliée par défaut), rangées par `group`.
    - Les contrôles dépendent du type :
      - un nombre a un curseur et un champ numérique ;
      - un intervalle a deux champs ;
      - une couleur a un sélecteur de couleur ;
      - un choix a une liste ;
      - une liste a un champ texte de nombres séparés par des virgules.
    - Chaque paramètre a un bouton ↺ qui le remet à sa valeur par défaut, et un bouton « Tout réinitialiser » remet tout.
  - Une modification s'applique tout de suite au moteur (`setParams`) et s'écrit 300 ms après la dernière frappe [C].
  - Les paramètres ne sont ni dans l'historique ni dans l'annulation (spec 19).

- [ ] **Step 1 : test de `diffFromDefaults`.** Les défauts donnent `{}`. Un facteur à 3 donne `{ factor: 3 }`. Un aller-retour par `withOverrides` redonne les mêmes paramètres.
- [ ] **Step 2 : constater l'échec, implémenter, test vert.**
- [ ] **Step 3 : vérification par capture.**
  - Avec `--data` pointant vers une base dont `settings.json` vaut `{"background":"grid","factor":3}`, la capture montre la grille au lieu des étoiles.
  - Une capture avec le bandeau ouvert (`CIRRUS_PANEL=1`) montre les deux sections et les libellés français.
- [ ] **Step 4 :** `npx tsc --noEmit -p packages/app` et la suite complète. Expected : vert.
- [ ] **Step 5 : commit et push** (`feat(app): bandeau des paramètres graphiques`).

---

### Task 9 : Grande base, rubans hors du fil principal, mesure

**Files :**
- Create: `packages/fixtures/src/large.ts` (`buildLargeState(spec)`), test `packages/fixtures/tests/large.test.ts`
- Create: `packages/app/src/renderer/render/frameWorker.ts`, plus `render/frameClient.ts`
- Create: `packages/app/src/renderer/bench/` (passe de mesure), `packages/app/scripts/bench.mjs`
- Modify: `PlanRenderer.ts` (construction asynchrone)
- Create: `docs/bancs/app-rendu-<date>.md` (rapport)

**Interfaces :**
- Produces :
  - `buildLargeState(spec: { seed: number; nodes: number; connections: number }): { state: State; lobby: Id }` construit directement par des opérations, sans commande, pour aller vite :
    - groupes imbriqués sur cinq niveaux au plus ;
    - connexions locales à 80 % ;
    - 10 % de faisceaux de trois à cinq membres ;
    - 5 % de bras scindés avec leurs fantômes.

    Il reprend les principes du générateur du banc.
  - **Travailleur :** `buildFrame` s'exécute dans un `Worker` de module, avec en entrée la scène, la caméra, l'origine et les paramètres, en clone structuré. Les `FloatList` reviennent en `Float32Array` transférés.
    - Le moteur garde l'image précédente tant que la nouvelle n'est pas prête.
    - Une demande périmée, dont le numéro est dépassé, est ignorée.
    - Le premier cadre d'un plan reste synchrone, pour que `cirrus:ready` corresponde à une vraie image.
  - **Banc :**
    - `npm run bench -w packages/app` charge une grande base de 50 000 nœuds et 500 000 connexions.
    - Il rejoue le parcours de caméra du banc : survol, plongée à travers les niveaux, déplacement.
    - Il mesure le temps de la carte graphique par `EXT_disjoint_timer_query_webgl2` et le temps du processeur sous ×4.
    - Il écrit `docs/bancs/app-rendu-<date>.md` et compare aux critères de la spec 21 : 2 ms de carte graphique au p95 et 16 ms de processeur au p95 sous ×4.

- [ ] **Step 1 : test de `buildLargeState`.** Avec `{ seed: 1, nodes: 2000, connections: 20000 }` :
  - `checkState` ne renvoie aucune violation ;
  - la profondeur est au plus 5 ;
  - la base contient des fantômes ;
  - deux appels avec la même graine donnent le même état (`canonical`).
- [ ] **Step 2 : constater l'échec, implémenter, test vert.**
- [ ] **Step 3 : travailleur.** On le branche, on vérifie par capture que le rendu est identique au rendu synchrone sur le lobby de la base de test (comparaison visuelle), et que les types sont propres.
- [ ] **Step 4 : banc.**
  - On lance `npm run bench -w packages/app` et on lit le rapport.
  - Si le critère de la carte graphique n'est pas tenu, on consigne le poste fautif d'après la mesure par couches (`?hide=`, comme le banc) et on ne corrige pas dans cette tâche. La correction ira au mode performance, ou à une tâche du plan 3b.
- [ ] **Step 5 : commit et push** (`perf(app): rubans hors du fil principal, grande base et banc du rendu`).
