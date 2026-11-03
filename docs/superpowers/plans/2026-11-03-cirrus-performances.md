# Cirrus, plan 3c : performances — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** à 50 000 nœuds et 550 000 connexions, le coût du chargement, d'une édition, d'un glissement et la mémoire ne dépendent plus de la taille de la base. Seul ce qui change, ou ce qui est visible, se calcule. On mesure aussi la carte graphique sans le plancher du chronomètre.

**Pourquoi (mesures du 2026-11-03 sur la base du banc) :**

| Poste | Mesure | Cause |
|---|---|---|
| Chargement : 9,2 s | 0,7 s de texte JSON côté principal ; 0,9 s de lecture ; 1,2 s de reconstruction de l'état ; 3,8 s de scène ; 0,4 s d'index ; jusqu'à 3,7 s de copie de la scène au travailleur (3,3 s pour les seules connexions) | tout est converti trois fois, copié deux fois, et la scène couvre tout le plan |
| Une édition : plusieurs secondes | la session recopie toutes les collections (dont 1,18 million de branches) ; chaque commande clone l'état (`cloneState`), comme l'annulation et le magasin ; les invariants relisent toutes les branches ; `groupIndex` relit tout (0,5 s) ; puis scène, index et copie complets | aucun index, des copies à chaque pas |
| Une image de glissement : 0,36 s | dont 0,32 s pour recalculer l'index complet | l'aperçu passe par « nouvelle scène » |
| Recherche du visible : 29 à 66 ms | elle examine 47 000 connexions pour en garder 40 à 170 | les connexions sont rangées par groupe commun, sans lien avec la vue |
| Carte graphique : 2,42 / 4,79 ms (médiane / p95, hors reconstructions) | écran vide : 0,78 / 1,58 ms ; textes : 0,6 / 1,2 ms ; ciel : 0,3 ms ; tout le reste : 0,75 ms | plancher du chronomètre, titres dessinés un par un par Pixi |
| Mémoire | état : 332 Mo sous Node (connexions 268, branches 93) ; scène : 283 Mo ; plus une copie de la scène dans le travailleur et une de l'état dans le principal | objets JS et clés texte ; le relevé de 1,44 Go ne forçait pas le ramasse-miettes |

**Architecture :**
- **Cœur :**
  - l'état se modifie sur place. Commandes, `combine`, annulation et magasin travaillent sur une **surcouche** qui lit l'état sans le copier : le coût est celui des opérations, pas celui de la base ;
  - les branches sont rangées par connexion, sans clé texte ;
  - des index dérivés (membres, groupes, fantômes par connexion, placements par nœud) sont tenus à jour par `applyOp`.
- **Échanges :** l'état passe du principal à l'interface en instantané compact, avec une table d'identifiants qui rend les chaînes partagées.
- **Scène :**
  - ses emplacements sont stables ;
  - une action la met à jour à partir de ses opérations (`updateScene`), et `buildScene` ne sert plus qu'à l'ouverture d'un plan ;
  - l'index du rendu devient topologique : chaque connexion est rangée sous le « sommet » de chacune de ses extrémités, c'est-à-dire l'ancêtre directement sous leur groupe commun. Le visible se trouve à partir des éléments visités.
- **Rendu :**
  - le fil principal décide du visible, en une milliseconde ;
  - le travailleur ne reçoit plus que la sous-scène visible, et la tessellation reste chez lui ;
  - les aperçus (glissement, échelle, poignées) ne refont que ce qu'ils touchent ;
  - les titres deviennent un seul maillage sur l'atlas MSDF de la police.

**Tech Stack :** celle des plans 3 et 3b, sans nouvelle dépendance.

**Spec :** `C:\Users\alpha\Desktop\Cirrus\2026-11-02-cirrus-design.md`, sections 4 (seul le principal touche le disque), 6.4 (une action, un pas), 8 (rendu), 19 (réglages) et 21 (bancs et critères).

## Global Constraints

- Les contraintes des plans 3 et 3b valent toujours :
  - travail sur `main`, sans branche, avec un commit puis un push par tâche, jamais en force ;
  - syntaxe effaçable, avec l'extension dans les imports ;
  - toute constante de rendu ou d'interaction est un paramètre avancé de `RenderParams` ;
  - cloisonnement de l'interface ;
  - seul le processus principal touche le disque.
- **Aucune fonctionnalité ne change.** Les captures de `docs/captures/plan3b/` restent identiques à l'œil, sauf la coupure de quelques titres à la tâche 8, consignée.
- **Base de référence :** `buildLargeState({ seed: 1, nodes: 50_000, connections: 500_000 })`, avec les identifiants de 36 caractères de la tâche 1. Les tests de coût tournent sous Node (vitest), le banc sous Electron.
- **Tests :** `npm test --workspaces --if-present`, paquet après paquet. Les tests chronométrés d'un paquet sont dans un même fichier, joués l'un après l'autre. Un seuil est fixé à environ trois fois la mesure obtenue : la marge absorbe le bruit, pas une régression d'un ordre de grandeur.
- **Mesure de la mémoire sous Node :** `forceGc()` (dans `@cirrus/fixtures`) passe par `v8.setFlagsFromString('--expose-gc')` puis `vm.runInNewContext('gc')`, appelé deux fois avant de lire `process.memoryUsage().heapUsed`.

## Review Focus

1. **Annulation, rétablissement et synchro par `updateScene` :** une action inverse met la scène à jour comme une action directe, et `receive` (plan 5) aussi. Testé à la tâche 4 (l'oracle joue aussi l'annulation de chaque action).
2. **Action sur un autre plan que celui affiché :** une répercussion, un collage ailleurs ou les opérations d'un plan Q laissent la scène affichée exacte. Changer d'onglet vers Q construit Q à neuf. Testé à la tâche 4.
3. **Plan vide, et retrait du dernier élément :** la scène, l'index et le visible restent cohérents, sans aucune référence à un emplacement libéré. Testé aux tâches 4 et 5.
4. **Glissement interrompu** par Échap, perte du focus ou clic droit : l'image revient exactement à celle d'avant l'aperçu, sans géométrie fantôme. Testé à la tâche 7.
5. **Titres difficiles :** glyphe absent de l'atlas (ℝ, ℕ, €…), titre vide, mot de 60 caractères. La mise en page ne casse pas, et le nombre de lignes de la boîte reste celui du dessin. Testé à la tâche 8.

---

### Task 1 : Banc fiable et mesure de référence

**Files :**
- `packages/fixtures/src/large.ts`, et `packages/fixtures/src/gc.ts` (`forceGc`) ;
- Create : `packages/store/src/bulk.ts` ;
- `packages/app/scripts/bench.mjs`, `src/main/index.ts`, `src/main/bench.ts`, `src/renderer/bench.ts`, `ui/GraphView.tsx` et `App.tsx` ;
- les tests correspondants ; `docs/bancs/`.

**Interfaces (Produces) :**
- **Identifiants :** `benchId(kind: string, i: number): string` donne des identifiants de 36 caractères à la forme d'un UUIDv7, déterministes, uniques et triés dans l'ordre de création. La base synthétique les utilise partout : la taille des chaînes devient celle de la vraie base.
- **Base sur disque :** `writeBenchBase(dir: string, s: State): void` crée une base SQLite du format du magasin, avec tous les enregistrements en une transaction et un journal vide.
  - `bench.mjs` la construit une fois dans `%TEMP%/cirrus-bench-<seed>-<nœuds>-<connexions>/`, avec un tampon de version du générateur.
  - Il la copie dans un dossier neuf pour chaque passe, car la passe d'édition l'écrit.
  - L'app l'ouvre par `CIRRUS_DATA`, comme une vraie base : `CIRRUS_BENCH` ne génère plus d'état en mémoire. Le chargement mesuré comprend donc la lecture SQLite.
- **Passes :**
  - `vsync` ;
  - `plancher`, avec toutes les couches masquées ;
  - `throttled-x4`.
- **Rapport :** pour la carte, la valeur brute, le plancher et le **contenu** (brut moins plancher), en médiane et au p95, hors reconstructions. Viennent ensuite le processeur, les phases du chargement, la mémoire et l'édition. Le nom du rapport se donne par `CIRRUS_BENCH_NAME` (par défaut `app-rendu-<date>`) : on n'écrase plus le rapport précédent.
- **Mémoire :**
  - en mode banc, le principal ajoute `--js-flags=--expose-gc` ;
  - en fin de passe, l'interface appelle deux fois `gc()` avant de lire `usedJSHeapSize` ;
  - le principal relève `app.getAppMetrics()` et rapporte la mémoire privée, en Mo, des processus Browser, Tab (l'interface et son travailleur) et GPU.
- **Phases du chargement**, en ms depuis le démarrage du principal : base ouverte, instantané envoyé, instantané reçu, état prêt, scène prête, moteur prêt (police et shaders), première image. Les marques de l'interface partent en temps absolu (`performance.timeOrigin + performance.now()`), et le principal les convertit.
- **Passe d'édition**, à la fin du parcours de la passe `vsync`, sur le nœud le plus proche du centre de la caméra profonde. Elle joue ce script :
  1. glissement de 300 px en 60 images, par la machine des gestes comme le rejeu des captures, puis dépôt ;
  2. renommage ;
  3. création d'un nœud au centre ;
  4. connexion des deux ;
  5. trois Ctrl+Z.

  **Latence :** de l'appel à `session.run` (ou à l'annulation) jusqu'à la fin du `renderFrame` qui dessine la nouvelle scène, par une promesse que résout la boucle. Elle se mesure aussi pour le dépôt. Pour le glissement, on rapporte le temps du fil principal par image d'aperçu, en médiane et au p95.

- [ ] **Step 1 : tests.**
  - `benchId` : 36 caractères, unique sur 600 000 valeurs, identique d'un appel à l'autre, croissant avec `i`.
  - `writeBenchBase` puis `LocalStore.open`, sur une grande base de 1 000 nœuds : on retrouve l'état, à instantané canonique égal.
  - `recordRun` avec trois passes : le contenu vaut brut moins plancher, et le nom suit `CIRRUS_BENCH_NAME`.
  - `forceGc` libère un tableau de 100 Mo : `heapUsed` redescend.
- [ ] **Step 2 :** constater l'échec, implémenter, tests verts.
- [ ] **Step 3 : référence.**
  - Lancer `npm run bench -w packages/app` avec `CIRRUS_BENCH_NAME=app-rendu-3c-reference`.
  - Contrôler que le rapport donne le plancher, le contenu, les phases, la mémoire et les latences d'édition.
  - Attendu, ordre de grandeur des mesures du 2026-11-03 : chargement d'au moins 9 s, éditions de plusieurs secondes, environ 350 ms par image de glissement.
- [ ] **Step 4 :** commit et push (`bench(app): plancher de la carte, mémoire après ramasse-miettes, phases du chargement, passe d'édition`).

### Task 2 : Branches par connexion, instantané compact, identifiants partagés

**Files :**
- Create : `packages/core/src/branches.ts` ;
- `state.ts`, `snapshot.ts`, `invariants.ts` et `commands.ts` du cœur ;
- `packages/store/src/localStore.ts` ;
- tous les appelants de `branchKey` et `parseBranchKey` (vue, app, fixtures, tests) ;
- `src/main/index.ts` et `App.tsx`.

**Interfaces (Produces) :**
- **`class BranchSet`.** Le stockage est un `Map<Id /* connexion */, readonly Id[]>` de paires plates `[plan0, nœud0, plan1, nœud1, …]`. Les tableaux sont immuables, remplacés à chaque changement. Le constructeur accepte le `Map` support, ce qui servira à la surcouche de la tâche 3. Méthodes :
  - `has(b: BranchRec): boolean`, `add(b): void`, `delete(b): void` ;
  - `get size(): number` et `[Symbol.iterator](): Iterator<BranchRec>` ;
  - `nodesIn(connection: Id, plan: Id): Id[]` et `plansOf(connection: Id): Id[]` ;
  - `inPlan(plan: Id): Map<Id, Id[]>`, la liste des connexions vers leurs nœuds, en un passage, pour `buildScene` ;
  - `clone(): BranchSet`.
- **`State.branches: BranchSet`.** `branchKey` et `parseBranchKey` quittent l'API. Les opérations `branch` gardent `key: BranchRec`.
- **Instantané compact :** `encodeState(s: State): string` et `decodeState(text: string): State`.
  - Chaque identifiant figure une seule fois, dans une table `ids`. Toute référence est un indice dans cette table, et la forme exacte des tuples est laissée à l'implémenteur.
  - Au décodage, toutes les références à un même identifiant sont la même chaîne (internement).
  - `toSnapshot` et `fromSnapshot` disparaissent, et l'IPC `cirrus:snapshot` renvoie `encodeState`.
- **Lecture du magasin :** `loadState` interne les identifiants (une table pendant la lecture) et remplit le `BranchSet` directement.

- [ ] **Step 0 :** mesurer, sous Node avec `forceGc`, le tas de l'état actuel décodé à partir de la base de référence, ainsi que le temps de stringify, de parse et de reconstruction. Noter ces chiffres au registre.
- [ ] **Step 1 : tests.**
  - `BranchSet` : add, has, delete, itération, taille, `nodesIn`, `plansOf`, `inPlan` et `clone`, contre un `Set` de clés écrit dans le test.
  - Aller-retour `decodeState(encodeState(s))` à instantané canonique égal, sur la base de test et sur une grande base de 2 000 nœuds.
  - Internement : sur l'état décodé, `members[i].node` et `nodes.get(id).id` sont la même chaîne. Vérifier par un `Map` d'identité sur 1 000 références tirées au hasard, en comparant aux chaînes de la table.
  - Base de référence :
    - le texte compact fait au plus 40 % de l'ancien ;
    - encodage plus décodage prennent au plus 1,5 s ;
    - le tas de l'état décodé est au plus 60 % de celui du Step 0.
- [ ] **Step 2 :** constater l'échec, implémenter, voir la suite complète passer (les appelants sont migrés), puis commit et push (`perf(core): branches par connexion, instantané compact, identifiants partagés`).

### Task 3 : État modifié sur place, brouillons en surcouche, index dérivés

**Files :**
- Create : `packages/core/src/overlay.ts` ;
- `state.ts`, `invariants.ts`, `commands.ts` et `history.ts` du cœur ;
- `packages/store/src/localStore.ts` ;
- `packages/app/src/renderer/session.ts`, `App.tsx` et `ui/GraphView.tsx` (props) ;
- `packages/view/src/clip.ts`, `repercussion.ts` et `scene.ts` (index du cœur) ;
- `packages/core/tests/scale.test.ts` et les nouveaux tests.

**Interfaces (Produces) :**
- **Surcouche :** `overlayState(base: State): State` rend un état dont les `Map` (enregistrements et index), ainsi que le `BranchSet`, lisent à travers `base` et écrivent dans leur propre couche.
  - `base` ne change jamais.
  - L'itération parcourt les entrées de base non masquées, puis celles de la couche.
  - Brouillon de commande, `combine`, `dryRun` de l'annulation et essai à blanc de `LocalStore.commit` l'utilisent. `cloneState` disparaît.
- **Index dérivés dans `State`,** tenus par `applyOp` et construits par `reindex(s)` au chargement (`emptyState`, `decodeState`, `loadState`). Leurs tableaux sont immuables et remplacés à chaque changement :
  - `memberOf: Map<Id /* nœud */, readonly Id[]>` : ses connexions de tout type, y compris à la corbeille ;
  - `groupsOf: Map<string /* `${plan}|${nœud}` */, readonly Id[]>` : ses groupes directs, selon la sémantique de `groupVia` ;
  - `groupMembers: Map<string /* `${plan}|${groupe}` */, readonly Id[]>` : l'inverse du précédent ;
  - `phantomsOf: Map<Id /* connexion */, readonly Id[]>` ;
  - `placedIn: Map<Id /* nœud */, readonly Id[]>`.
- **Lecture des groupes :** `groupOf(s, plan, node)` et `ancestors(s, plan, node)` lisent `groupsOf`, en O(1) et O(profondeur). `groupIndex` et le paramètre `GroupIndex` disparaissent.
- **Invariants :** `checkState(s, touched)` ne coûte plus que ce qu'il touche, grâce aux index. Sans `touched`, sa sémantique est inchangée.
- **Commandes :** celles qui parcouraient tout un `Map` passent par les index : `dropPhantoms`, `deleteEverywhere`, et ce qu'un `grep "\.values()"` relève dans `commands.ts`.
- **Session :** `EditSession` applique les actions sur place, après un essai à blanc sur une surcouche : un conflit laisse l'état intact.
  - Elle tient `rev: number` et appelle `onChange(s, a, rev)`.
  - `App` garde `{ state, rev, action }`.
  - `GraphView` reçoit `rev` et `action` (la dernière appliquée) en plus de `state`, et ses effets dépendent de `rev`.
- **Audit :** aucun consommateur ne compare deux versions de l'état, puisque l'ancienne est désormais le même objet. Chercher les états gardés (`useRef<State`, `prev`) et consigner le résultat au registre.

- [ ] **Step 1 : tests.**
  - **Surcouche :**
    - une écriture est invisible dans la base ;
    - suppression puis réajout ;
    - `size` exact ;
    - itération égale à base ∪ couche, privée de ce qui est supprimé ;
    - `BranchSet` en surcouche.
  - **Index :** après 300 opérations tirées au hasard sur la base de test, puis 50 sur la grande base, les index tenus à jour égalent ceux de `reindex` sur une copie (comparaison canonique).
  - **Invariants :** `checkState(s, touched)` égale `checkState(s)` filtré sur la portée, pour 100 actions tirées au hasard.
  - **Coûts sur la base de référence** :

    | Opération | Seuil |
    |---|---|
    | `moveNodes`, `editNode`, `createNode`, `connect`, `include`, et chacune sur une surcouche | ≤ 5 ms |
    | `deleteEverywhere` d'un nœud à 500 connexions | ≤ 20 ms |
    | `combine` de 50 `placeNode` | ≤ 20 ms |
    | essai à blanc d'une annulation | ≤ 5 ms |
    | `LocalStore.commit` d'un déplacement (base de `writeBenchBase`) | ≤ 10 ms |

    Ces seuils remplacent ceux de 300 ms de `scale.test.ts`.
  - **Session :** une action s'applique sur place et `rev` augmente ; un `commit` qui échoue laisse l'état et `rev` inchangés ; un conflit à l'application laisse l'état intact.
- [ ] **Step 2 :** constater l'échec, implémenter, suite complète verte, puis commit et push (`perf(core): état modifié sur place, brouillons en surcouche, index dérivés`).

### Task 4 : Scène à emplacements stables, mise à jour par les opérations

**Files :**
- `packages/view/src/scene.ts`, et Create : `packages/view/src/sceneUpdate.ts` ;
- `edit.ts`, `visibility.ts`, `menus.ts` et `layout.ts` de la vue ;
- `packages/app/src/renderer/actions.ts`, `ui/GraphView.tsx` et `bench.ts` ;
- les tests : `packages/view/tests/scene-update.test.ts`, et `scale-perf.test.ts` étendu.

**Interfaces (Produces) :**
- **`PlanScene` gagne :**
  - `connectionsById: Map<Id, number[]>`, les emplacements de la partie principale et de la partie lointaine ;
  - `hues: Map<number, number>`, le rang de chaque groupe de premier niveau, par identifiant (lu par `groupColors` au lieu de son cache) ;
  - `deadItems: number` et `deadConnections: number`.
- **Emplacements libérés :**
  - un élément retiré laisse dans son emplacement la sentinelle gelée `GONE_ITEM`, que rien ne référence plus : ni `byId`, ni `roots`, ni `children`, ni les extrémités ;
  - de même `GONE_CONNECTION` ;
  - `isLive(scene, i)` le teste. Les parcours complets de `scene.items` (`intruders`, `buildIndex`, `boundsOf`, `bench.ts`, `GraphView`) sautent ces emplacements.
- **`updateScene(prev: PlanScene, s: State, ops: Op[], measure: Measure, p: RenderParams): { scene: PlanScene; changes: SceneChanges }`,** avec `interface SceneChanges { items: number[]; connections: number[]; hierarchy: boolean; full: boolean }`. `items` et `connections` listent les emplacements changés, ajoutés ou retirés.
  - Il rend une nouvelle scène qui partage tout ce qui n'a pas changé ; `prev` est inchangée.
  - Des opérations sans effet sur ce plan rendent `prev` tel quel, avec des changements vides.
  - Il reconstruit tout (`full: true`) quand les emplacements libérés dépassent 25 %.
- **Algorithme :**
  1. Relever, à partir des opérations :
     - les nœuds touchés ;
     - les fantômes de ce plan ;
     - les connexions touchées, y compris celles d'un nœud renommé (titres des amorces), par `memberOf`.
  2. Rendre présent, mettre à jour ou retirer les éléments.
  3. Recalculer le parent de chaque nœud touché, des membres d'une inclusion changée, et des descendants d'inclusion d'un nœud qui apparaît ou disparaît (par `groupMembers`, jusqu'aux nœuds placés).
  4. Corriger enfants, genre (nœud ou groupe), racines et profondeurs.
  5. Redériver les groupes au-dessus de tout ce qui a changé, du plus profond au moins profond.
  6. Redériver les connexions touchées et celles des éléments apparus ou disparus.
  7. Recalculer les badges des nœuds concernés, par `memberOf`.
  8. Mettre à jour les bornes et `hues`.
- **Code partagé :** `buildScene` et `updateScene` partagent la dérivation d'un élément, de son parent, d'un groupe, des parties d'une connexion et d'un badge. Avec les index du cœur, `buildScene` ne relit plus les clés et passe par `inPlan` une seule fois.
- **Aperçus :** `withOffsets` et `withMoves` gardent `prev.bounds`, sans tout reparcourir.
- **Recherches par identifiant :** les recherches linéaires dans `scene.connections` passent par `connectionsById` (`menus.ts`, `actions.ts`, `GraphView.tsx`, `layout.ts`).
- **`GraphView` :** sur un nouveau `rev` portant une `action`, pour le même plan et le même `sceneParamsKey`, il appelle `updateScene`. Sinon il appelle `buildScene`. Le moteur reçoit encore la scène entière (tâche 5).

- [ ] **Step 1 : tests.**
  - **Oracle :** `canonicalScene(scene)` décrit la scène par identifiants, à 1e-9 près. `updateScene` doit l'égaler avec `buildScene` :
    - après chacune de 300 actions tirées au hasard sur la base de test, puis après leur annulation (Review Focus 1). Les actions passent par les commandes du cœur et par `pasteSteps` : déplacement, renommage, création, connexion, inclusion, exclusion, retrait d'un plan, suppression partout, scission et réunion de bras, placement d'une amorce, disposition et collage ;
    - pour chaque plan de la base de test (lobby, Thèse, Article, document), y compris quand l'action touche un autre plan (Review Focus 2) ;
    - après 30 actions sur la base de référence.
  - **Emplacements libérés :** après des suppressions, aucune référence à un emplacement libéré ; `intruders`, `buildIndex` et `boundsOf` les ignorent ; la scène est compactée au-delà de 25 %. Le retrait du dernier élément d'un plan donne une scène vide cohérente (Review Focus 3).
  - **Coûts sur la base de référence :**

    | `updateScene` pour… | Seuil |
    |---|---|
    | un déplacement | ≤ 3 ms |
    | un renommage | ≤ 3 ms |
    | une création | ≤ 5 ms |
    | une connexion | ≤ 5 ms |
    | une inclusion | ≤ 10 ms |
    | la suppression d'un groupe d'au moins 200 éléments, avec son contenu | ≤ 50 ms |

    `buildScene` passe sous 1,2 s, contre 3,8 s.
- [ ] **Step 2 :** constater l'échec, implémenter, suite complète verte, refaire trois captures du plan 3b (déplacement, dépôt, collage) et les comparer, puis commit et push (`perf(view): scène à emplacements stables, mise à jour par les opérations`).

### Task 5 : Index topologique, visible en une milliseconde, intrus du visible

**Files :** `packages/view/src/visibility.ts`, `edit.ts`, `params.ts`, `packages/app/src/renderer/render/PlanRenderer.ts` et `ui/GraphView.tsx` ; tests `visibility.test.ts` et `scale-perf.test.ts`.

**Interfaces (Produces) :**
- **`SceneIndex` gagne :**
  - `lca: Int32Array`, par emplacement de connexion ;
  - `byTop: Map<number, number[]>` : chaque connexion y est rangée sous chacun des sommets distincts de ses extrémités et de son centre. Le sommet est l'ancêtre directement sous le groupe commun, ou l'extrémité elle-même ;
  - `incident: Map<number, number[]>` : un élément vers les connexions qui y ont une extrémité ou leur centre ;
  - des tableaux typés à capacité doublée ;
  - l'arbre Flatbush des racines, et `dirtyRoots: number[]`. Les racines changées sont testées une à une, et l'arbre se reconstruit au-delà de `indexDirtyMax`, nouveau paramètre avancé valant 256 par défaut.
- **`updateIndex(index: SceneIndex, scene: PlanScene, changes: SceneChanges, p: RenderParams): SceneIndex`** modifie l'index et le rend. Il reconstruit tout si `changes.full`.
- **`computeVisible`** ne regarde que les connexions des listes `byTop` des éléments visités, au lieu de toutes celles de chaque groupe ouvert.
  - **Règle, écrite en commentaire :** une connexion est vue quand une extrémité remontée sous son groupe commun, ou son centre, est dans la vue.
  - Une connexion dont la seule raison d'être vue était un ancêtre en fondu au-dessus de son groupe commun n'est plus dessinée. Elle se trouvait hors de l'écran, déjà effacée par `endpointFade`.
- **Intrus du visible :** `visibleIntruders(scene: PlanScene, visible: VisibleSet): Map<number, number>` ne cherche les intrus que parmi les éléments et groupes visibles. `GraphView` l'appelle après chaque reconstruction, à la place du `intruders(scene)` complet.
- **`PlanRenderer.updateScene(scene: PlanScene, changes: SceneChanges): void`** met l'index à jour et reconstruit la géométrie. Le travailleur reçoit encore la scène entière (tâche 6).

- [ ] **Step 1 : tests.**
  - `computeVisible` égale une référence par force brute qui applique la règle ci-dessus :
    - pour 50 caméras tirées au hasard sur la base de référence, et pour chaque caméra du parcours du banc ;
    - pour 50 caméras sur chaque plan de la base de test, et sur un plan vide (Review Focus 3).
  - Après des actions tirées au hasard, `updateIndex` égale `buildIndex` : mêmes `lca`, mêmes ensembles `byTop`, mêmes bornes.
  - **Coûts sur la base de référence :**
    - `computeVisible` : ≤ 2 ms à chaque caméra du parcours, contre 29 à 66 ms ;
    - `updateIndex` d'un déplacement : ≤ 2 ms ;
    - `visibleIntruders` : ≤ 2 ms ;
    - `buildIndex` : ≤ 150 ms, contre 368 ms.
- [ ] **Step 2 :** constater l'échec, implémenter, suite complète verte, puis commit et push (`perf(view): index topologique, visible sans balayage, intrus du visible`).

### Task 6 : Travailleur sans scène

**Files :**
- Create : `packages/view/src/subscene.ts` ;
- `packages/app/src/renderer/render/frameWorker.ts`, `PlanRenderer.ts` et `frameData.ts` ;
- tests : `packages/view/tests/subscene.test.ts`.

**Interfaces (Produces) :**
- **Sous-scène :** `subScene(scene: PlanScene, visible: VisibleSet): { scene: PlanScene; visible: VisibleSet }`.
  - Elle retient :
    - les éléments et groupes visibles ;
    - leurs ancêtres ;
    - les éléments que référencent les connexions visibles ;
    - ces connexions ;
    - `hues`.
  - Les indices sont renumérotés, et `byId` et `connectionsById` réduits au sous-ensemble.
- **Messages au travailleur :** uniquement `{ t: 'frame'; seq; scene; visible; cam; origin; params; sides }`. Plus de message `scene`, plus d'index dans le travailleur.
- **`PlanRenderer.request()`** calcule le visible sur le fil principal, le garde avec la demande en vol, puis envoie la sous-scène. `receive` applique le cadre avec le visible gardé. L'index de survol garde ainsi les indices de la scène principale.

- [ ] **Step 1 : tests.**
  - `buildFrame` sur la sous-scène égale `buildFrame` sur la scène entière : mêmes tableaux de géométrie, mêmes lignes centrales, marqueurs, titres et amorces. Vérifié pour 20 caméras sur la base de référence, et pour chaque plan de la base de test.
  - `structuredClone` de la sous-scène prend au plus 5 ms à chaque caméra du parcours.
- [ ] **Step 2 :** constater l'échec, implémenter, suite complète verte, puis vérifier par une capture et par le journal du banc qu'aucune scène entière ne part plus au travailleur. Commit et push (`perf(app): le travailleur ne reçoit que la sous-scène visible`).

### Task 7 : Aperçus partiels

**Files :**
- `packages/view/src/frame.ts`, et Create : `packages/view/src/preview.ts` ;
- `scene.ts` (`withOffsets`) ;
- `packages/app/src/renderer/render/PlanRenderer.ts` et `ui/GraphView.tsx` ;
- tests : `packages/view/tests/preview.test.ts`.

**Interfaces (Produces) :**
- **Partage :** `previewSplit(scene: PlanScene, visible: VisibleSet, moving: number[], connections?: number[]): PreviewSplit` rend `{ items: Set<number>; groups: Set<number>; connections: Set<number> }`, avec :
  - `items` : les éléments déplacés et leurs descendants ;
  - `groups` : les groupes déplacés et leurs ancêtres ;
  - `connections` : les connexions visibles qui ont une extrémité (ouverte ou repliée) ou leur centre sur `items ∪ groups`, plus les connexions de scène données.
- **Filtre :** `buildFrame(…, filter?: FrameFilter)`, avec `interface FrameFilter { connection(ci: number): boolean; envelopes: boolean; title(item: number): boolean; layouts?: Map<number, Layout> }`. `layouts` remplace la disposition d'une connexion visible, comme `bundleFor` le fait déjà.
- **`PlanRenderer` :**
  - `beginPreview(moving: number[], connections?: number[]): void` construit une fois la partie **fixe** : tout sauf le partage, et aucune enveloppe ;
  - `preview(scene: PlanScene, layouts?: Map<number, Layout>): void` construit sur le fil principal la partie **vive**. Elle comprend :
    - les connexions du partage ;
    - toutes les enveloppes visibles, dont l'ordre parent puis enfant est ainsi garanti ;
    - les titres du partage ;
    - toutes les boîtes et tous les marqueurs ;
  - `endPreview(): void` retire la partie vive.

  Rubans, pointes et textes ont leur couche fixe et leur couche vive ; les enveloppes n'ont qu'une couche vive.
- **`GraphView` :** le glissement, le geste d'échelle et la poignée de disposition passent par ces trois appels, au lieu de `setScene(…, true)`. La poignée passe la disposition en surcharge, sans copier les connexions de la scène.
- **`withOffsets` :** son coût devient O(éléments déplacés + ancêtres).

- [ ] **Step 1 : tests.**
  - Pour un décalage nul, la partie fixe plus la partie vive égalent le cadre complet : mêmes triangles par connexion et par enveloppe. Vérifié sur la base de test et sur la base de référence.
  - Après `endPreview`, le cadre est identique à celui d'avant l'aperçu (Review Focus 4).
  - **Coûts sur la base de référence**, à la caméra profonde, pour une feuille d'environ 20 connexions tirée par le glissement :
    - `preview` : ≤ 3 ms ;
    - `beginPreview` : ≤ 30 ms.
- [ ] **Step 2 :** constater l'échec, implémenter, suite complète verte, refaire les captures du plan 3b liées au glissement, à l'échelle et aux poignées, puis commit et push (`perf(app): aperçus qui ne refont que ce qu'ils touchent`).

### Task 8 : Titres en un maillage MSDF

**Files :**
- Create : `packages/view/src/text.ts` ;
- `frame.ts` et `params.ts` de la vue ;
- `packages/app/src/renderer/render/shaders.ts`, `PlanRenderer.ts` et `frameWorker.ts` ;
- `texts.ts` disparaît, et `measureTitle` est remplacé ;
- tests : `packages/view/tests/text.test.ts`.

**Interfaces (Produces) :**
- **Police :** `parseBmFont(xml: string): FontData`. Elle lit les attributs de `info`, `common` et `distanceField`, les caractères (position, taille, décalages, avance) et les crénages. C'est un analyseur à expressions régulières, sans `DOMParser`, car il doit tourner dans le travailleur.
- **Mise en page :** `layoutText(font: FontData, text: string, size: number, wrap: number, lineHeight: number): TextLayout`, avec `wrap` à 0 pour ne pas couper.
  - Le résultat est `{ lines: number; width: number; height: number; glyphs: { x; y; w; h; u0; v0; u1; v1 }[] }`, centré sur (0, 0), chaque ligne centrée.
  - **Coupure :** gloutonne aux espaces. Un mot plus long que la largeur dépasse, seul sur sa ligne, comme `breakWords: false` chez Pixi.
  - Les crénages s'appliquent.
  - **Glyphe absent :** on prend celui de « ? » s'il existe. Sinon le glyphe est sauté, avec l'avance d'une espace.
- **Mesure :** `measureLines(font: FontData, p: RenderParams): Measure` remplace `measureTitle`. Les boîtes et le dessin partagent ainsi la même mise en page.
- **Géométrie :** `FrameGeometry` gagne `texts`, un quadrilatère par glyphe. Ses attributs :
  - `aAnchor` (centre du titre), `aOffset` (coin du glyphe, en unités monde), `aUV` et `aSize` (taille monde de la police) ;
  - `aKind` : 0 pour un nœud, 1 pour un groupe ouvert, 2 pour un groupe replié, 3 pour une connexion ;
  - `aK`, `aParentK`, `aFoldK`, `aDim` et `aConn`.

  Les fondus de `PlanRenderer.updateTexts` passent dans le shader, avec les mêmes formules. Les textes illisibles au zoom le plus profond que sert la géométrie restent non construits.
- **Shader :** `textShader(p: RenderParams, atlas: Texture): Shader`, en MSDF.
  - Écart en pixels d'écran : `distanceRange · aSize · uZoom / font.size`.
  - Couleur `inkColor`, ou `titleColor` pour les connexions.
  - Survol par `uHot`.
  - L'atlas est chargé par `Assets.load` de `font/inter-msdf.png`.
- **Travailleur :** il reçoit `FontData` une fois, par un message `{ t: 'font'; font }`. `TextPool` et `BitmapText` disparaissent du moteur.

- [ ] **Step 1 : tests.**
  - `parseBmFont` sur `inter-msdf.fnt` : 401 caractères, `distanceRange` 6, `size` 48, `scaleW` 740.
  - `layoutText` :
    - une ligne mesure la somme des avances et des crénages ;
    - une coupure connue donne le nombre de lignes attendu ;
    - un mot de 60 caractères tient sur une ligne qui dépasse ;
    - un titre vide donne 1 ligne et 0 glyphe ;
    - « ℝ€ » ne lève pas d'erreur (Review Focus 5).
  - Le titre d'un nœud donne un quadrilatère par glyphe visible, centré sur l'élément.
  - `measureLines` égale `layoutText(...).lines` à la taille de base.
- [ ] **Step 2 :** constater l'échec, implémenter, suite complète verte. Refaire toutes les captures du plan 3b et les comparer ; consigner au registre les titres dont la coupure a changé. Commit et push (`perf(app): titres en un seul maillage sur l'atlas MSDF`).

### Task 9 : Banc final, critères, registre

**Files :** `docs/bancs/`, `docs/superpowers/plans/2026-11-03-cirrus-performances-registre.md` et `2026-11-02-cirrus-design.md` (section 21).

- [ ] **Step 1 :** lancer le banc complet (trois passes et l'édition) avec `CIRRUS_BENCH_NAME=app-rendu-apres-3c`.
- [ ] **Step 2 :** comparer à la référence de la tâche 1. Les critères, sur la base de référence :

  | Critère | Cible |
  |---|---|
  | Chargement, du démarrage du principal à la première image, lecture SQLite comprise | ≤ 3 s. Si la seule lecture SQLite de la référence dépasse 1,5 s, la cible devient cette lecture plus 1,5 s |
  | Chaque édition du script (dépôt, renommage, création, connexion, annulation), jusqu'à l'image | ≤ 50 ms |
  | Glissement, fil principal par image d'aperçu | ≤ 4 ms au p95 |
  | Carte graphique, contenu (brut moins plancher) | ≤ 2 ms au p95 |
  | Processeur ×4 | ≤ 16 ms au p95 |
  | Couche des textes, au banc par couche | ≤ 0,15 ms en médiane |
  | Mémoire de l'interface, après ramasse-miettes | ≤ 50 % de la référence |
  | Mémoire privée du principal | ≤ 60 % de la référence |

  Un critère non tenu donne une ligne `Ruling:` au registre, avec la mesure et le levier suivant.
- [ ] **Step 3 :** inscrire dans la section 21 du design la méthode de mesure de la carte : le plancher, le contenu, et le critère de 2 ms lu sur le contenu. Écrire le registre : décisions, mesures et mineurs reportés. Commit et push (`docs: banc après le plan 3c, critères, registre`).
