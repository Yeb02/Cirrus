# Cirrus, plan 3c : performances — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** à 50 000 nœuds et 550 000 connexions, le coût du chargement, d'une édition, d'un glissement, d'une image et de la mémoire ne dépend plus de la taille de la base. Seul ce qui change, ou ce qui est visible, se calcule. La carte graphique fait le travail géométrique ; le processeur ne prépare que des données compactes.

**Pourquoi.** Mesures du 2026-11-03 sur la base du banc :

| Poste | Mesure | Cause |
|---|---|---|
| Chargement : 9,2 s | 0,7 s pour écrire le JSON (principal), 0,9 s pour le lire, 1,2 s pour reconstruire l'état, 3,8 s de scène, 0,4 s d'index, jusqu'à 3,7 s de copie de la scène au travailleur | trois conversions, deux copies, une scène qui couvre tout le plan |
| Une édition : plusieurs secondes | la session recopie toutes les collections, dont 1,18 million de branches ; chaque commande, l'annulation et le magasin clonent l'état ; les invariants relisent toutes les branches ; `groupIndex` prend 0,5 s ; puis scène, index et copie sont refaits en entier | aucun index, une copie à chaque pas |
| Une image de glissement : 0,36 s | dont 0,32 s pour l'index complet | l'aperçu passe par « nouvelle scène » |
| Recherche du visible : 29 à 66 ms | 47 000 connexions examinées pour en garder de 40 à 170 | connexions rangées par groupe commun, sans lien avec la vue |
| Reconstruction de la géométrie : 13 à 21 ms | 1 à 5 ms pour les faisceaux, 6 à 16 ms pour les triangles. Plan plat de 20 000 nœuds vu en entier : 0,85 s, dont 0,8 s de triangles | courbes découpées sur le processeur |
| Carte graphique, médiane / p95 hors reconstructions : 2,42 / 4,79 ms | écran vide : 0,78 / 1,58 ms ; textes : 0,6 / 1,2 ms ; ciel : 0,3 ms ; tout le reste : 0,75 ms | plancher du chronomètre, titres dessinés un par un par Pixi |
| Mémoire | état : 332 Mo sous Node (connexions 268, branches 93) ; scène : 283 Mo ; une copie de la scène dans le travailleur, une de l'état dans le principal | objets JS et clés texte. Le relevé de 1,44 Go ne forçait pas le ramasse-miettes |

**Architecture (détail et alternatives : « Décisions de conception ») :**
- **Une seule copie de l'état, dans l'interface.** Le principal ne garde que la base et valide chaque écriture par SQL.
- **Cœur :**
  - les connexions, leurs membres et leurs branches sont rangés **en colonnes**, et le reste en objets. On les lit par des façades `Map` ;
  - des **index dérivés** sont tenus par `applyOp` ;
  - les commandes s'appliquent **sur place**, avec un retour arrière exact.
- **Chargement :** un **instantané binaire**, rangé dans la base avec le numéro du journal qu'il couvre, plus la fin du journal rejouée.
- **Scène :**
  - elle est **mise à jour par les opérations**, avec des emplacements stables ;
  - les scènes des onglets ouverts restent en cache ;
  - le visible se trouve par un **index topologique**.
- **Rendu :**
  - un moteur **WebGL 2 à nous**, sans Pixi ni travailleur ;
  - une **texture des éléments** (position, demi-tailles, cran, repli), lue par des **instances** : boîtes, marqueurs, glyphes, et courbes des connexions simples calculées dans le vertex shader ;
  - le processeur ne calcule plus que les faisceaux complexes et les enveloppes ;
  - un déplacement réécrit quelques texels.

**Tech Stack :** TypeScript, Electron, React, WebGL 2 et SQLite (`node:sqlite`). Pixi est retiré. Aucune nouvelle dépendance.

**Spec :** `C:\Users\alpha\Desktop\Cirrus\2026-11-02-cirrus-design.md`, sections 4 (seul le principal touche le disque), 6 (journal, synchro), 6.4 (une action, un pas), 8 (rendu), 19 (réglages) et 21 (bancs, critères ; « on ajoute le mode performance plutôt que de changer de moteur »).

## Décisions de conception

Pour chaque décision : les options, celle qui est choisie, pourquoi, ses conséquences sur les plans suivants, et son coût si elle est fausse. Les chiffres viennent des mesures ci-dessus ou d'estimations notées « ≈ », toutes sous Chromium avec compression des pointeurs.

1. **Représentation de l'état.**
   - **Options :**
     - **A.** Des objets en `Map`, avec identifiants partagés et index : ≈ 170 o par connexion, 5 objets par connexion à parcourir pour le ramasse-miettes.
     - **B.** Tout en tableaux typés : le plus compact, mais tout le cœur et ses 150 lecteurs sont à réécrire.
     - **C.** Colonnes pour ce qui se compte en centaines de milliers (connexions, membres, branches), objets pour le reste (nœuds, placements, fantômes, plans, dispositions), lus par des façades `Map` : ≈ 90 o par connexion, dont 48 pour sa chaîne d'identifiant, et un seul objet par connexion.
   - **Choix : C.** Il prend le gain de B là où il compte, et les lecteurs ne changent presque pas.
   - **Conséquences :**
     - les opérations du journal et de la synchro (plan 5) restent des enregistrements objets, que l'état applique à ses colonnes ;
     - les recherches et filtres futurs balaient des colonnes.
   - **Si c'est faux :** tout passe par les façades ; changer de rangement ne touche que les tables derrière elles.
2. **Modification de l'état et brouillons.**
   - **Options :**
     - **A.** Copier l'état (actuel) : O(base).
     - **B.** Structures persistantes : O(log n), mais des lectures 2 à 5 fois plus lentes et de la mémoire en plus.
     - **C.** Surcouche en copie sur écriture : O(opérations), mais des `Map` surchargées, mal adaptées aux colonnes.
     - **D.** Sur place, avec retour arrière par les opérations inverses, qui sont exactes : O(opérations), cela marche avec les colonnes et ne demande aucune structure en plus.
   - **Choix : D.**
   - **Risque :** une exception au milieu d'une commande. Chaque commande passe donc par `transact`, qui annule dans un `finally`.
   - **Conséquence :** un ancien état n'est plus une photo figée. Une révision `rev` remplace l'identité d'objet pour React.
   - **Si c'est faux :** revenir à C pour les seuls brouillons.
3. **Où vit l'état.**
   - **Options :**
     - **A.** Deux copies, dans le principal et dans l'interface (actuel) : mémoire doublée, transfert complet au chargement.
     - **B.** Une seule copie, dans l'interface. Le principal ne garde que la base et valide une écriture par SQL : il relit la ligne courante et la compare à l'« avant ».
     - **C.** L'interface ouvre SQLite elle-même : contraire au cloisonnement (spec 4).
   - **Choix : B.**
   - **Conséquence synchro :** le client de synchro (plan 5) vit dans le principal, écrit en base, puis transmet à l'interface (`receive`).
   - **Si c'est faux :** rendre un état au principal ; `loadState` reste disponible.
4. **Chargement.**
   - **Options :**
     - **A.** Relire les tables à chaque démarrage (actuel) : un JSON analysé par enregistrement.
     - **B.** Un fichier d'instantané à côté de la base : rapide, mais le fichier et la base peuvent diverger.
     - **C.** Un instantané binaire dans la base même (table `snapshot`, avec le numéro de journal couvert), puis la fin du journal rejouée : une seule lecture, atomique avec la base.
   - **Choix : C.** Les tables restent, comme chemin de secours et pour l'historique par objet (spec 6.3). L'instantané est écrit à partir de l'encodage de l'interface, au repos et à la fermeture.
   - **Si c'est faux :** le chemin de secours est A.
5. **Transfert du principal à l'interface.**
   - **Options :**
     - **A.** Du JSON (actuel) : 127 millions de caractères, sur deux octets chacun dès qu'un caractère n'est pas latin.
     - **B.** Le clone structuré d'objets : 403 s mesurées au plan 3.
     - **C.** Un seul `ArrayBuffer` : colonnes numériques, plus une section de textes en UTF-8 (`TextDecoder`). La copie se fait à la vitesse de la mémoire, et les colonnes se lisent directement sur le tampon reçu.
   - **Choix : C.**
6. **Moteur de rendu.**
   - **Options :**
     - **A.** Pixi, triangles sur le processeur et travailleur (actuel).
     - **B.** Natif (Vulkan ou OpenGL) : il faudrait réécrire toute l'interface (menus, dialogues, champs de texte, et plus tard LaTeX et PDF), et la spec 21 l'écarte.
     - **C.** WebGPU : il permet le calcul sur la carte, mais c'est un portage complet, avec un risque de pilote sur le petit PC, et inutile pour nos primitives.
     - **D.** WebGL 2 à nous, piloté par la carte. Une texture des éléments est lue par des instances : boîtes, marqueurs, glyphes, et courbes simples (deux membres, extrémités en boîtes, sans amorce, disposition ni glissement) calculées dans le vertex shader. Le processeur ne garde que les faisceaux complexes et les enveloppes.
   - **Choix : D.**
   - **Conséquences :**
     - un déplacement réécrit quelques texels ;
     - plus de travailleur, ni de copie de scène ;
     - un plan plat de 20 000 nœuds vu en entier ne demande qu'une liste d'instances ;
     - la couche reste mince : un second moteur WebGPU reste possible.
   - **Si c'est faux :** la formule des courbes simples existe en double, en GLSL et en TS (pour le survol). Un test compare la version TS à `bundleGeometry`, et la comparaison des captures contrôle le GLSL.
7. **Précision.**
   - **Options :**
     - positions absolues en float32 : fausses de plusieurs pixels à fort zoom loin de l'origine ;
     - émulation de doubles dans le shader : compliquée ;
     - positions relatives à une origine.
   - **Choix :** positions relatives à une origine, réécrites quand une reconstruction déplace l'origine. Cela coûte O(éléments), ≈ 1 ms à 100 000 éléments.
8. **Texte.**
   - **Options :**
     - une texture de canevas par titre : envois lents ;
     - du texte vectoriel sur la carte (façon Slug) : qualité maximale, très complexe ;
     - des glyphes MSDF instanciés sur l'atlas existant.
   - **Choix :** les glyphes MSDF instanciés. Un caractère absent de l'atlas devient « ? » ; générer l'atlas à la volée est renvoyé à plus tard.
   - **Conséquence :** l'affichage LaTeX des nœuds (plan 4) reste une couche DOM ou PDF à part.
9. **Recherche du visible.**
   - **Options :**
     - le balayage par groupe commun (actuel) ;
     - un index spatial des connexions : leurs bornes se périment à chaque déplacement dans un grand groupe ;
     - un rangement topologique : sous le sommet de chaque extrémité, sans aucune borne à tenir.
   - **Choix :** le rangement topologique.
10. **Scènes.**
    - **Options :**
      - les reconstruire, même accélérées : ≥ 0,2 s par édition à 50 000 nœuds ;
      - les mettre à jour par les opérations.
    - **Choix :** la mise à jour par les opérations, avec un cache des scènes des onglets ouverts (borne `cachedPlans`, 4 par défaut), plutôt qu'une construction à chaque changement d'onglet.
11. **Trop de faisceaux complexes à la fois.**
    - **Options :**
      - un travailleur : copies, et une scène en double ;
      - un découpage dans le temps : un budget par image (`rebuildBudgetMs`, 4 par défaut), le reste à l'image suivante.
    - **Choix :** le découpage dans le temps.
12. **Retiré :** le paramètre `envelopeResolution` et sa texture réduite. Le plan 3 a mesuré qu'elle n'apportait rien, et le moteur à nous reste mince.

## Global Constraints

- **Contraintes des plans 3 et 3b, toujours valables :**
  - travail sur `main`, sans branche, avec un commit puis un push par tâche, jamais en force ;
  - syntaxe effaçable, avec l'extension dans les imports ;
  - toute constante de rendu ou d'interaction est un paramètre avancé de `RenderParams` ;
  - cloisonnement de l'interface ;
  - seul le principal touche le disque.
- **Aucune fonctionnalité ne change.** La suite de captures de référence de la tâche 1 se compare après chaque tâche qui touche le rendu : au plus 0,5 % des pixels peuvent différer de plus de 16 niveaux, sauf écart consigné, comme une coupure de titre à la tâche 7.
- **Base de référence :** `buildLargeState({ seed: 1, nodes: 50_000, connections: 500_000 })`, avec les identifiants de 36 caractères de la tâche 1. Les tests de coût tournent sous Node (vitest), le banc sous Electron.
- **Tests :**
  - commande officielle : `npm test --workspaces --if-present`, paquet après paquet ;
  - les tests chronométrés d'un paquet sont dans un même fichier, joués l'un après l'autre ;
  - un seuil vaut environ trois fois la mesure obtenue.
- **Mémoire sous Node :** `forceGc()` (dans `@cirrus/fixtures`) passe par `v8.setFlagsFromString('--expose-gc')` et `vm.runInNewContext('gc')`, appelé deux fois avant `process.memoryUsage().heapUsed`.
- **Avant chaque décision non prévue ici :** comparer les options et leurs conséquences futures, puis les consigner au registre sous la forme `Ruling:`. La performance est une exigence, pas une optimisation à faire plus tard.

## Review Focus

1. **Annulation, rétablissement et synchro par les chemins incrémentaux :** une action inverse met à jour colonnes, index, scène et texture comme une action directe, et `receive` aussi. Testé aux tâches 2, 5 et 9 (les oracles jouent l'annulation de chaque action).
2. **Action sur un autre plan que celui affiché, et scènes en cache :** une répercussion, un collage ailleurs ou les opérations d'un plan Q laissent exactes toutes les scènes en cache. Changer d'onglet montre Q à jour. Testé à la tâche 5.
3. **Plan vide, retrait du dernier élément, emplacements recyclés :** aucune référence ne pointe sur un emplacement libéré, ni dans la scène, ni dans l'index, ni dans les instances. Testé aux tâches 5, 6 et 8.
4. **Instantané périmé, absent ou corrompu,** ou d'une autre version du format : le chargement retombe sur les tables, sans rien perdre. Une fermeture brutale après des actions donne, au démarrage suivant, l'instantané plus la fin du journal. Testé à la tâche 4.
5. **Glissement interrompu** par Échap, perte du focus ou clic droit : texture et instances reviennent exactement à l'image d'avant. Testé à la tâche 9.

---

### Task 1 : Banc fiable, captures de référence, mesure de référence

**Files :**
- `packages/fixtures/src/large.ts`, et Create : `packages/fixtures/src/gc.ts` ;
- Create : `packages/store/src/bulk.ts` ;
- `packages/app/scripts/bench.mjs`, et Create : `scripts/captures.mjs` et `scripts/compare-captures.mjs` ;
- `src/main/index.ts`, `src/main/bench.ts`, `src/renderer/bench.ts`, `ui/GraphView.tsx` et `App.tsx` ;
- tests ; `docs/bancs/` et `docs/captures/reference-3c/`.

**Interfaces (Produces) :**
- **Identifiants :** `benchId(kind: string, i: number): string` donne 36 caractères à la forme d'un UUIDv7, déterministes, uniques et croissants avec `i`. La base synthétique les utilise partout.
- **Base sur disque :** `writeBenchBase(dir: string, s: State): void` écrit une base au format du magasin, en une transaction, avec un journal vide.
  - `bench.mjs` la construit une fois dans `%TEMP%/cirrus-bench-<seed>-<nœuds>-<connexions>/`, avec un tampon de version du générateur.
  - Il la copie dans un dossier neuf à chaque passe.
  - L'app l'ouvre par `CIRRUS_DATA`. `CIRRUS_BENCH` ne génère plus d'état en mémoire : le chargement comprend la lecture de la base.
- **Passes :** `vsync`, `plancher` (toutes couches masquées) et `throttled-x4`.
- **Rapport :**
  - carte : brut, plancher et **contenu** (brut moins plancher), en médiane et au p95, hors reconstructions ;
  - processeur ;
  - intervalles entre images : médiane, p99 et maximum ;
  - phases du chargement ;
  - mémoire ;
  - édition.

  Le nom se donne par `CIRRUS_BENCH_NAME`, par défaut `app-rendu-<date>`.
- **Mémoire :**
  - en mode banc, le principal ajoute `--js-flags=--expose-gc` ;
  - en fin de passe, l'interface appelle deux fois `gc()` avant de lire `usedJSHeapSize` ;
  - le principal rapporte `app.getAppMetrics()` : la mémoire privée, en Mo, de Browser, Tab et GPU.
  - Une passe sur une base vide donne le plancher d'Electron.
- **Phases du chargement**, en ms depuis le démarrage du principal : base ouverte, données envoyées, données reçues, état prêt, scène prête, moteur prêt, première image. L'interface envoie ses marques en temps absolu (`performance.timeOrigin + performance.now()`).
- **Passe d'édition** (à la fin du parcours `vsync`, sur le nœud le plus proche du centre de la caméra profonde) :
  1. glissement de 300 px en 60 images, par la machine des gestes, puis dépôt ;
  2. renommage ;
  3. création d'un nœud au centre ;
  4. connexion des deux ;
  5. trois Ctrl+Z.

  On mesure la **latence**, de l'appel (`session.run`, annulation, dépôt) à la fin du rendu de la nouvelle scène, par une promesse que résout la boucle. Pour le glissement, on mesure le temps du fil principal par image d'aperçu.
- **Captures de référence :** `npm run captures -w packages/app` produit `docs/captures/reference-3c/*.png` à partir d'une liste de scènes dans `captures.mjs` :
  - lobby en vue d'ensemble ;
  - zoom profond ;
  - groupe à mi-repli ;
  - sélection ;
  - aperçu de glissement ;
  - fenêtre d'une connexion ;
  - amorces et fantômes ;
  - fond en grille ;
  - plan document ;
  - survol d'une connexion.

  `compare-captures.mjs <dossierA> <dossierB>` décode les PNG par `nativeImage` et rapporte, par image, la part des pixels qui diffèrent de plus de 16 niveaux.

- [ ] **Step 1 : tests.**
  - `benchId` : 36 caractères, unique sur 600 000 valeurs, déterministe, croissant.
  - `writeBenchBase` puis `LocalStore.open`, sur une grande base de 1 000 nœuds, rend l'état (instantané canonique égal).
  - `recordRun` à trois passes : le contenu vaut brut moins plancher ; le nom suit `CIRRUS_BENCH_NAME`.
  - `forceGc` libère un tableau de 100 Mo.
- [ ] **Step 2 :** constater l'échec, implémenter, tests verts.
- [ ] **Step 3 :**
  - Produire la suite de captures de référence, et vérifier que `compare-captures` d'un dossier contre lui-même donne 0 %.
  - Lancer le banc avec `CIRRUS_BENCH_NAME=app-rendu-3c-reference`, plus une passe sur une base vide.
  - Contrôler que le rapport donne plancher, contenu, intervalles, phases, mémoire et latences.
- [ ] **Step 4 :** commit et push (`bench(app): plancher de la carte, mémoire après ramasse-miettes, phases, édition, captures de référence`).

### Task 2 : Cœur en colonnes, façades, index dérivés

**Files :**
- Create : `packages/core/src/tables.ts` (colonnes et pools), `packages/core/src/facades.ts` et `packages/core/tests/oracle/` (le modèle objet actuel, copié tel quel comme oracle) ;
- `state.ts`, `snapshot.ts`, `invariants.ts` et `commands.ts` du cœur ;
- `packages/store/src/localStore.ts` ;
- `packages/fixtures/src/large.ts` ;
- les tests qui écrivaient directement dans les `Map` (`scale.test.ts`…), à faire passer par `applyOp`.

**Interfaces (Produces) :**
- **Rangées :** nœuds, plans et connexions reçoivent une rangée entière, stable tant que l'enregistrement existe et recyclée par liste libre. Les tables vont de l'identifiant à la rangée (`Map<Id, number>`) et de la rangée à l'identifiant (`string[]`).
- **Connexions en colonnes :** `kind: Uint8Array`, `title: string[]`, `relation: string[]`, `tags: (readonly TagValue[])[]` (un tableau vide gelé partagé) et `trashedAt: Float64Array` (NaN pour l'absence).
  - Les **membres** sont dans un pool `Int32Array` de `rangéeNœud * 4 + rôle`, avec début, longueur et capacité par connexion.
  - Une connexion qui grandit est relogée en fin de pool, et le pool se compacte au-delà de 50 % de perte.
- **Branches :** un second pool `Int32Array` de paires (rangée de plan, rangée de nœud) par connexion. `class BranchSet` le présente par :
  - `has(b: BranchRec)`, `add`, `delete`, `size` et l'itération en `BranchRec` ;
  - `nodesIn(connection, plan): Id[]` et `plansOf(connection): Id[]` ;
  - `forEachInPlan(plan, fn: (connectionRow: number, nodeRows: Int32Array) => void)`.
- **Le reste en objets :** nœuds (`NodeRec[]` par rangée), plans, placements (par plan : un `Map<rangéeNœud, Placement>`), fantômes, dispositions et clés de tags.
- **Façades :** `s.nodes`, `s.connections`, `s.plans`, `s.placements` (clé `${plan}|${nœud}`, analysée), `s.phantoms` et `s.connLayouts` sont des `ReadonlyMap` : `get`, `has`, `keys`, `values`, `entries`, `size` et l'itération.
  - `s.connections.get` matérialise un `ConnectionRec`.
  - On n'écrit plus que par `applyOp`. Le `set` des façades lève une erreur.
  - Des accès directs servent aux chemins chauds : `connRow(s, id)`, `membersOf(s, row)`, `placementOf(s, plan, node)`.
- **Index dérivés,** tenus par `applyOp` et construits par `reindex(s)` au chargement :
  - `memberOf` : pour chaque rangée de nœud, ses rangées de connexion (tout type, corbeille comprise) ;
  - `groupOf` : pour chaque plan, un `Int32Array` qui donne le groupe direct d'une rangée de nœud selon `groupVia` (−1 si aucun), plus un `Map` des nœuds qui ont plusieurs groupes, pour l'invariant `twoGroups` ;
  - `groupMembers` : pour chaque plan, un `Map<rangéeGroupe, number[]>` ;
  - `phantomsOf` : pour chaque connexion, ses fantômes ;
  - `placedIn` : pour chaque nœud, ses plans.
- **Lecture des groupes :** `groupOf(s, plan, node)` et `ancestors(s, plan, node)` se lisent dans l'index. `groupIndex` disparaît, ainsi que `branchKey` et `parseBranchKey` côté API.

- [ ] **Step 0 :** mesurer, avec `forceGc`, le tas de l'état actuel pour la base de référence, et le noter au registre.
- [ ] **Step 1 : tests.**
  - **Oracle :** 2 000 opérations tirées au hasard (ajout, modification et retrait de chaque type d'enregistrement, branches, annulations) appliquées à l'état en colonnes et à l'oracle objet. Après chaque centaine, les façades égalent l'oracle (instantanés canoniques triés).
  - **Index :** les index tenus à jour égalent ceux de `reindex` sur un état reconstruit, après chaque centaine.
  - **Pools :** relogement d'une connexion qui grandit, compaction, rangées recyclées sans fuite.
  - **Base de référence :** tas de l'état au plus 45 % du Step 0, et `reindex` en au plus 300 ms.
- [ ] **Step 2 :** constater l'échec, implémenter, suite complète verte (les lecteurs passent par les façades), puis commit et push (`perf(core): connexions et branches en colonnes, façades de lecture, index dérivés`).

### Task 3 : Commandes sur place, retour arrière, invariants à la portée, session

**Files :**
- `commands.ts`, `history.ts`, `invariants.ts` et `state.ts` du cœur ;
- `packages/app/src/renderer/session.ts`, `App.tsx` et `ui/GraphView.tsx` (props) ;
- `packages/view/src/clip.ts`, `repercussion.ts` et `connect.ts` (index) ;
- `packages/core/tests/scale.test.ts` et nouveaux tests.

**Interfaces (Produces) :**
- **Transactions :** `transact<T>(s: State, fn: (d: Draft) => T): T`.
  - Le brouillon applique ses opérations **sur** `s`.
  - En sortie, normale ou par exception, tout est annulé par les inverses, dans l'ordre inverse.
  - `finish` vérifie les invariants : l'« après » avec les opérations appliquées, puis l'« avant » une fois annulées. Il rend l'action, et `s` est intact.
  - Toutes les commandes passent par `transact`.
  - `combine` ouvre une seule transaction pour ses étapes, et le contrôle des invariants se fait une fois.
  - L'essai à blanc de l'annulation applique puis annule.
  - `cloneState` disparaît.
- **Commandes :** celles qui parcouraient tout un `Map` passent par les index : `dropPhantoms`, `deleteEverywhere`, et tout ce qu'un `grep "values()"` relève dans `commands.ts`.
- **Invariants :** `checkState(s, touched)` ne lit que la portée, par les index. Sans portée, la sémantique est inchangée.
- **Session :**
  - `EditSession` applique sur place, après commit, et tient `rev: number` ;
  - elle appelle `onChange(s, a, rev)` ;
  - `App` garde `{ state, rev, action }` ;
  - `GraphView` reçoit `rev` et `action`, et ses effets dépendent de `rev`.
- **Audit :** aucun consommateur ne compare deux versions de l'état. Chercher `useRef<State` et `prev`, puis consigner au registre.

- [ ] **Step 1 : tests.**
  - Une commande qui lève une erreur au milieu laisse l'état identique, à instantané canonique égal.
  - Une commande réussie laisse l'état identique et rend l'action attendue.
  - `checkState(s, touched)` égale `checkState(s)` filtré sur la portée, pour 100 actions tirées au hasard.
  - **Coûts sur la base de référence :**

    | Opération | Seuil |
    |---|---|
    | `moveNodes`, `editNode`, `createNode`, `connect`, `include`, `exclude` | ≤ 2 ms |
    | `deleteEverywhere` d'un nœud à 500 connexions | ≤ 10 ms |
    | `combine` de 50 `placeNode` | ≤ 10 ms |
    | essai à blanc d'une annulation | ≤ 2 ms |

    Ces seuils remplacent ceux de 300 ms.
  - **Session :** l'application se fait sur place et `rev` augmente. Un commit qui échoue laisse l'état et `rev` inchangés.
- [ ] **Step 2 :** constater l'échec, implémenter, suite complète verte, puis commit et push (`perf(core): commandes sur place avec retour arrière, invariants à la portée`).

### Task 4 : Base sans copie de l'état, instantané binaire, chargement

**Files :**
- Create : `packages/core/src/codec.ts` ;
- `packages/store/src/localStore.ts` et `schema.ts` (table `snapshot`, migration) ;
- `packages/app/src/main/index.ts`, `base.ts` et `src/preload/index.ts` ;
- `env.d.ts`, `App.tsx` et `session.ts` ;
- `packages/view/src/params.ts`.

**Interfaces (Produces) :**
- **Codec :** `encodeState(s: State): ArrayBuffer` et `decodeState(buf: ArrayBuffer): State`.
  - Format versionné : un en-tête, les colonnes numériques et une section de textes en UTF-8 séparés par `\0`, décodée par `TextDecoder`.
  - Les colonnes du décodage lisent le tampon reçu sans copie quand c'est possible.
  - Les objets (nœuds, fantômes…) sont encodés de façon compacte, avec des références par rangée. La forme exacte est laissée à l'implémenteur.
  - Au décodage, toutes les références à un identifiant sont la même chaîne.
- **Magasin :**
  - `LocalStore` ne garde plus d'état en mémoire. `commit(a)` vérifie l'« avant » de chaque opération en relisant la ligne courante (comparaison canonique), écrit dans la même transaction, et lève `OpConflictError` au premier écart, avec annulation (`ROLLBACK`). Il rend le `local_seq` de la dernière ligne.
  - `trash()` et la vérification du lobby passent par SQL.
  - `readSnapshot(): { data: ArrayBuffer; seq: number; version: number } | null`.
  - `writeSnapshot(data: ArrayBuffer, seq: number): void` n'écrit que si `seq` dépasse celui de l'instantané stocké.
  - `changesSince(seq)` existe déjà.
- **IPC :**
  - `cirrus:load` rend `{ data: ArrayBuffer; tail: string /* opérations en JSON */; seq: number }`. Si l'instantané est absent, d'une autre version ou illisible, le principal construit l'état depuis les tables (`loadState`, chemin de secours), l'encode, puis l'oublie.
  - `cirrus:snapshot:save (data, seq)`.
  - `cirrus:commit` rend `seq`.
- **Interface :**
  - elle décode et rejoue la fin du journal ;
  - la session tient `seq` ;
  - elle encode et envoie l'instantané après `snapshotAfterActions` actions (paramètre, 200 par défaut), une fois au repos depuis `snapshotIdleMs` (2000 par défaut), et à la fermeture : le principal attend l'instantané au plus `snapshotQuitMs` (2000 par défaut) avant de quitter.

- [ ] **Step 1 : tests.**
  - Aller-retour `decodeState(encodeState(s))` égal à l'oracle, sur la base de test et sur une grande base de 2 000 nœuds.
  - Internement : sur 1 000 références tirées au hasard, `members[i].node` et `nodes.get(id).id` sont la même chaîne.
  - `commit` refuse un « avant » périmé et ne laisse ni ligne ni journal.
  - **Chargement (Review Focus 4) :**
    - instantané plus fin du journal égalent l'état complet, y compris après une « fermeture brutale » (actions écrites sans instantané) ;
    - un instantané corrompu, ou d'une autre version, fait retomber sur les tables ;
    - un instantané plus ancien ne remplace pas un plus récent.
  - **Coûts sur la base de référence :**
    - encodage ≤ 300 ms ;
    - décodage ≤ 250 ms ;
    - `commit` d'un déplacement ≤ 5 ms ;
    - lecture de l'instantané ≤ 150 ms.
- [ ] **Step 2 :** constater l'échec, implémenter, suite complète verte, lancer l'app sur la base de test puis sur une copie de la base de l'utilisateur. Commit et push (`perf(store): une seule copie de l'état, instantané binaire, chargement par instantané et journal`).

### Task 5 : Scène mise à jour par les opérations, cache des onglets

**Files :**
- `packages/view/src/scene.ts`, et Create : `packages/view/src/sceneUpdate.ts` ;
- `edit.ts`, `menus.ts`, `layout.ts`, `clip.ts` et `params.ts` de la vue ;
- `packages/app/src/renderer/actions.ts`, `ui/GraphView.tsx` et `bench.ts` ;
- tests : `scene-update.test.ts` et `scale-perf.test.ts`.

**Interfaces (Produces) :**
- **Éléments :** des objets `SceneItem` à emplacements stables.
  - Un élément retiré laisse la sentinelle gelée `GONE_ITEM`, que rien ne référence plus, et `isLive(scene, i)` le teste. Les emplacements libres sont recyclés.
  - `itemOfNode: Int32Array` et `itemOfPhantom: Map<Id, number>` remplacent `byId`. `byId` reste comme façade de lecture.
- **Parties de connexion en colonnes :**
  - `connRow: Int32Array` (rangée du cœur) et `part: Uint8Array` ;
  - un pool d'extrémités : élément, rôle, pointillé, et clé par rangée de nœud ;
  - `center: Int32Array` et `layout: (ConnectionLayout | undefined)[]` ;
  - les amorces, rares, dans un `Map<partie, SceneStub[]>`.

  Les lecteurs passent par `partEnds(scene, i)`, `partOf(scene, connectionId)` (un `Map<rangéeConnexion, number[]>`) et une façade `scene.connections[i]` qui matérialise pour le code d'interface. `GONE_PART` vaut pour les parties retirées.
- **Couleurs :** `hues: Map<number, number>`, le rang des groupes de premier niveau, lu par `groupColors`.
- **Mise à jour :** `updateScene(prev: PlanScene, s: State, ops: Op[], measure: Measure, p: RenderParams): { scene: PlanScene; changes: SceneChanges }`, avec `interface SceneChanges { items: number[]; parts: number[]; hierarchy: boolean; full: boolean }`.
  - Les colonnes de `prev` sont copiées en écriture : `prev` reste valide pour un geste qui la tient.
  - Des opérations sans effet sur le plan rendent `prev` tel quel.
  - Au-delà de 25 % d'emplacements libres, la scène est reconstruite (`full`).
- **Algorithme :**
  1. Relever, à partir des opérations : les nœuds touchés, les fantômes du plan, et les connexions touchées, y compris celles d'un nœud renommé, par `memberOf`.
  2. Rendre présent, mettre à jour ou retirer les éléments.
  3. Recalculer les parents : des nœuds touchés, des membres d'une inclusion changée, et des descendants d'inclusion d'un nœud apparu ou disparu (par `groupMembers`).
  4. Corriger enfants, genre, racines et profondeurs.
  5. Redériver les groupes au-dessus de ce qui a changé, du plus profond au moins profond.
  6. Redériver les parties des connexions touchées et des éléments apparus ou disparus.
  7. Recalculer les badges par `memberOf`.
  8. Mettre à jour les bornes et `hues`.

  `buildScene` partage les dérivations, en un passage par `forEachInPlan`.
- **Cache :** `GraphView` garde la scène des `cachedPlans` derniers onglets (paramètre, 4 par défaut). Chaque action les met toutes à jour par `updateScene`. Un changement d'onglet vers un plan en cache est immédiat.
- **Recherches :** les recherches linéaires dans `scene.connections` passent par `partOf` (`menus.ts`, `actions.ts`, `GraphView.tsx`, `layout.ts`).

- [ ] **Step 1 : tests.**
  - **Oracle :** `canonicalScene(scene)` décrit la scène par identifiants, à 1e-9 près. `updateScene` doit égaler `buildScene` :
    - après chacune de 300 actions tirées au hasard sur la base de test (commandes du cœur et `pasteSteps` : déplacement, renommage, création, connexion, inclusion, exclusion, retrait d'un plan, suppression partout, scission et réunion de bras, amorce placée, disposition, collage), puis après leur annulation (Review Focus 1) ;
    - pour chaque plan de la base de test, y compris quand l'action touche un autre plan (Review Focus 2) ;
    - après 30 actions sur la base de référence.
  - **Emplacements :**
    - aucune référence à un emplacement libéré, et le recyclage reste juste ;
    - le retrait du dernier élément d'un plan donne une scène vide cohérente (Review Focus 3) ;
    - au-delà de 25 % d'emplacements libres, la scène est compactée.
  - **Coûts sur la base de référence :**

    | `updateScene` pour… | Seuil |
    |---|---|
    | un déplacement, un renommage | ≤ 1 ms |
    | une création, une connexion | ≤ 2 ms |
    | une inclusion | ≤ 5 ms |
    | la suppression d'un groupe d'au moins 200 éléments, avec son contenu | ≤ 20 ms |

    `buildScene` passe sous 400 ms, contre 3,8 s. Le tas de la scène du lobby est au plus 30 % de la mesure du 2026-11-03 (283 Mo).
- [ ] **Step 2 :** constater l'échec, implémenter, suite complète verte, comparer les captures de référence (0 % attendu, car rien de visible ne change), puis commit et push (`perf(view): scène mise à jour par les opérations, parties de connexion en colonnes, cache des onglets`).

### Task 6 : Index topologique, visible en une milliseconde, intrus du visible

**Files :** `packages/view/src/visibility.ts`, `edit.ts` et `params.ts` ; `packages/app/src/renderer/render/PlanRenderer.ts` et `ui/GraphView.tsx` ; tests.

**Interfaces (Produces) :**
- **`SceneIndex` :**
  - `lca: Int32Array` par partie ;
  - `byTop: Map<number, number[]>` : chaque partie y est rangée sous les sommets distincts de ses extrémités et de son centre. Le sommet est l'ancêtre directement sous le groupe commun, ou l'extrémité elle-même ;
  - `incident: Map<number, number[]>` ;
  - les bornes et `parent` en tableaux typés à capacité doublée ;
  - l'arbre Flatbush des racines, et `dirtyRoots: number[]`. L'arbre se reconstruit au-delà de `indexDirtyMax` racines changées (paramètre avancé, 256 par défaut).
- **`updateIndex(index: SceneIndex, scene: PlanScene, changes: SceneChanges, p: RenderParams): SceneIndex`.** Il reconstruit tout si `changes.full`.
- **`computeVisible`** ne regarde que les parties des listes `byTop` des éléments visités.
  - **Règle, écrite en commentaire :** une partie est vue quand une extrémité remontée sous son groupe commun, ou son centre, est dans la vue.
  - Ce qui n'était vu que grâce à un ancêtre en fondu au-dessus du groupe commun n'est plus dessiné. C'était hors de l'écran, et déjà effacé par `endpointFade`.
- **Intrus :** `visibleIntruders(scene: PlanScene, visible: VisibleSet): Map<number, number>` remplace l'appel complet à `intruders(scene)` dans `GraphView`.
- **Moteur :** `PlanRenderer.updateScene(scene: PlanScene, changes: SceneChanges): void`.

- [ ] **Step 1 : tests.**
  - `computeVisible` égale une force brute qui applique la règle :
    - 50 caméras tirées au hasard, plus les caméras du parcours du banc, sur la base de référence ;
    - 50 caméras par plan de la base de test, et sur un plan vide (Review Focus 3).
  - `updateIndex` égale `buildIndex` après des actions tirées au hasard.
  - **Coûts sur la base de référence :**
    - `computeVisible` ≤ 1 ms à chaque caméra du parcours, et ≤ 5 ms sur un plan plat de 20 000 nœuds vu en entier ;
    - `updateIndex` d'un déplacement ≤ 1 ms ;
    - `visibleIntruders` ≤ 1 ms ;
    - `buildIndex` ≤ 150 ms.
- [ ] **Step 2 :** constater l'échec, implémenter, suite complète verte, puis commit et push (`perf(view): index topologique, visible sans balayage, intrus du visible`).

### Task 7 : Moteur WebGL 2 à nous, titres en glyphes MSDF

**Files :**
- Create : `packages/app/src/renderer/gl/` (`context.ts`, `program.ts`, `buffers.ts`, `texture.ts`, `timer.ts`) ;
- Create : `packages/view/src/text.ts` ;
- `render/PlanRenderer.ts`, `render/shaders.ts` et `render/meshes.ts` ;
- `render/texts.ts` disparaît ;
- `frame.ts`, `scene.ts` (mesure) et `params.ts` de la vue ;
- `ui/GraphView.tsx` et `bench.ts` ;
- tests : `packages/view/tests/text.test.ts`.

**Décision interne :** les maillages et les shaders ne changent pas : ils sont réécrits en GLSL ES 3.00 sans l'enveloppe de Pixi, et le travailleur est gardé. Ce qui change d'algorithme vient à la tâche 8 ; chaque étape se vérifie par les captures.
- **Les titres changent ici.** Pixi ne disparaît que si ses `BitmapText` sont remplacés, et leur remplacement est de toute façon un nouveau dessin.
- **Alternatives écartées :**
  - garder Pixi pour les seuls titres : deux moteurs sur un même canevas ;
  - un chemin de titres provisoire : du travail jeté.

**Interfaces (Produces) :**
- **`createGl(canvas): Gl`** couvre :
  - le contexte WebGL 2, en `antialias: false` et `premultipliedAlpha: true` ;
  - le redimensionnement au `devicePixelRatio` ;
  - la perte et la restauration du contexte ;
  - `EXT_disjoint_timer_query_webgl2` pour le banc.
- **Ressources :**
  - `Program` : compilation qui rapporte la ligne fautive, uniformes en cache ;
  - `VertexArray` : attributs par sommet et par instance (`vertexAttribDivisor`) ;
  - `DynamicBuffer` : `bufferSubData` de la partie utilisée, capacité doublée ;
  - `Texture2D`, y compris `RGBA32F` lue par `texelFetch`.
- **Ordre de dessin :** inchangé (ciel, étoiles, enveloppes, rubans, pointes, boîtes, contours, marqueurs, titres).
- **Retraits :** `envelopeResolution` et la texture réduite, et `pixi.js` dans `package.json`.
- **Titres :**
  - **Police :** `parseBmFont(xml: string): FontData`, un analyseur à expressions régulières (il tourne aussi dans le travailleur). Il lit `info`, `common`, `distanceField`, les caractères et les crénages.
  - **Mise en page :** `layoutText(font: FontData, text: string, size: number, wrap: number, lineHeight: number): TextLayout`, avec `wrap` à 0 pour ne pas couper.
    - Le résultat est `{ lines: number; width: number; height: number; glyphs: { x; y; w; h; u0; v0; u1; v1 }[] }`, centré sur (0, 0), chaque ligne centrée.
    - **Coupure :** gloutonne aux espaces. Un mot trop long dépasse, seul sur sa ligne.
    - Les crénages s'appliquent.
    - **Glyphe absent :** celui de « ? », sinon l'avance d'une espace.
    - La mise en page est en cache par (texte, largeur).
  - **Mesure :** `measureLines(font: FontData, p: RenderParams): Measure` remplace `measureTitle` : boîtes et dessin partagent la même mise en page.
  - **Géométrie :** `FrameGeometry` gagne `glyphInstances`, une instance par glyphe.
    - Attributs : ancre (le centre du titre), décalage, UV, taille monde, genre (0 nœud, 1 groupe ouvert, 2 groupe replié, 3 connexion), indice visible et atténuation.
    - Les fondus de `PlanRenderer.updateTexts` passent dans le shader, avec les mêmes formules.
    - Les textes illisibles au zoom le plus profond servi ne sont pas construits.
  - **Shader MSDF :**
    - écart en pixels d'écran : `distanceRange · taille · uZoom / font.size` ;
    - `inkColor`, ou `titleColor` pour les connexions ;
    - survol par `uHot` ;
    - l'atlas `font/inter-msdf.png` est chargé par `createImageBitmap`.
  - Le travailleur reçoit `FontData` une fois, par `{ t: 'font'; font }`.

- [ ] **Step 1 : tests.**
  - `DynamicBuffer` : capacité et plage envoyée.
  - `parseBmFont` sur `inter-msdf.fnt` : 401 caractères, `distanceRange` 6, `size` 48, `scaleW` 740.
  - `layoutText` :
    - la largeur d'une ligne vaut la somme des avances et des crénages ;
    - une coupure connue donne le nombre de lignes attendu ;
    - un mot de 60 caractères tient sur une seule ligne qui dépasse ;
    - un titre vide donne 1 ligne et 0 glyphe ;
    - « ℝ€ » ne lève pas d'erreur.
  - `measureLines` égale `layoutText(...).lines` à la taille de base.
  - Le titre d'un nœud donne une instance par glyphe visible.
- [ ] **Step 2 :** constater l'échec, porter et implémenter, suite complète verte, puis vérifier :
  - captures de référence à au plus 0,5 % de pixels différents par image, hors titres dont la coupure change (consignés), avec les écarts d'anticrénelage consignés ;
  - banc : contenu de la carte, couche des textes et processeur, notés au registre.

  Commit et push (`refactor(app): moteur WebGL 2 à nous, titres en glyphes MSDF, sans Pixi`).

### Task 8 : Rendu piloté par la carte — texture des éléments, instances, plus de travailleur

**Files :**
- Create : `packages/view/src/instances.ts` (pur, testé sous Node) et `packages/view/src/geometry/simple.ts` ;
- `frame.ts`, `hit.ts` et `params.ts` de la vue ;
- `packages/app/src/renderer/render/PlanRenderer.ts` et `shaders.ts` ;
- `frameWorker.ts` et `frameData.ts` sont supprimés.

**Interfaces (Produces) :**
- **Texture des éléments :** `itemTexels(scene: PlanScene, origin: Vec2, out: Float32Array, slots?: number[]): void`. Elle remplit, pour chaque emplacement, 2 texels RGBA32F :
  - `x − ox`, `y − oy`, `halfW`, `halfH` ;
  - `k`, `parentK` (`NO_GROUP` si aucun), `maxChildK` et des drapeaux (genre, style de fantôme, badge).

  Sans `slots`, elle remplit tout ; avec, seulement ces emplacements, pour un `texSubImage2D` des seules rangées touchées. La texture a 1024 texels de large.
- **Instances**, construites par `buildInstances(scene, visible, cam, origin, p, budget?: { deadline: number }): Instances` :
  - `boxes: Int32Array` : les emplacements visibles ;
  - `simple: Int32Array` : par connexion simple visible, élément A, élément B, rôles, indice visible (survol) et drapeaux. Une **connexion simple** a deux extrémités en boîtes (pas de groupe replié), pas d'amorce, de centre, de disposition ni de fondu `slide` ;
  - `curves: Float32Array` : une instance par branche d'un faisceau complexe, avec la cubique ouverte (8 flottants), la cubique repliée (8), la largeur, le rôle, les drapeaux (creux, pointillé, amorce), l'indice visible, les extrémités du fondu et le repli ;
  - `glyphs` : les pointes et points des faisceaux complexes ;
  - les glyphes des titres (tâche 7) portent l'emplacement de leur élément : l'ancre se lit dans la texture, et un titre suit un déplacement sans rien réécrire. Le titre d'une connexion garde son ancre en clair ;
  - `markers` ;
  - `envelopes` : un maillage sur le processeur, comme aujourd'hui.

  Les faisceaux complexes au-delà de `budget.deadline` (paramètre `rebuildBudgetMs`, 4 par défaut) sont repris à l'image suivante, avec un drapeau `pending`.
- **Shaders :**
  - les courbes simples se calculent dans le vertex shader à partir des deux texels A et B : ancrage sur la boîte avec `anchorGap`, milieu, tangentes et tension, selon la formule de `bundleGeometry` à deux membres ;
  - une bande de `curveSegments` segments (paramètre, 32 par défaut) par cubique ;
  - même largeur, même fondu et même survol qu'aujourd'hui ;
  - les pointes des courbes simples sont aussi calculées dans le shader ;
  - les cubiques complexes s'évaluent de même à partir de leurs points de contrôle.
- **Jumeau TS :** `simpleBranches(a: BundleEnd, b: BundleEnd, p: RenderParams): Branch[]` dans `geometry/simple.ts`, le pendant TS exact du GLSL, sert au survol.
- **Survol :** `buildHitIndex` prend les instances. Les courbes des connexions simples proches du point se calculent à la demande par `simpleBranches`.
- **Reconstruction :** plus de travailleur ni de copie. Elle se fait au déclenchement actuel, sauf `zoomIn` : les courbes ne se rééchantillonnent plus. L'origine se déplace et la texture se réécrit quand la caméra s'en éloigne de plus de `originShiftPx` (paramètre, 100 000 px à l'écran).

- [ ] **Step 1 : tests.**
  - `simpleBranches` égale `bundleGeometry` à 1e-9 près, pour 1 000 paires tirées au hasard (positions, demi-tailles, crans, rôles).
  - `buildInstances` sur la base de test : chaque connexion visible est soit simple, soit en branches complexes, jamais les deux. Les emplacements cités sont vivants (Review Focus 3).
  - `itemTexels` restreint aux emplacements donnés égale le remplissage complet sur ces rangées.
  - **Coûts sur la base de référence :**
    - `buildInstances` ≤ 3 ms à chaque caméra du parcours ;
    - ≤ 4 ms sur le plan plat de 20 000 nœuds vu en entier, contre 852 ms pour `buildFrame` aujourd'hui ;
    - `itemTexels` complet ≤ 3 ms.
- [ ] **Step 2 :**
  - Constater l'échec, implémenter, puis supprimer le travailleur et `frameData.ts`, avec la suite complète verte.
  - Comparer les captures de référence : au plus 0,5 % de pixels différents.
  - Lancer le banc, et noter au registre le contenu de la carte et le temps des reconstructions.
  - Commit et push (`perf(app): rendu piloté par la carte, texture des éléments, instances, sans travailleur`).

### Task 9 : Aperçus et éditions par la texture

**Files :** `packages/view/src/preview.ts` (pur), `scene.ts` (`withOffsets`, `withMoves`), `PlanRenderer.ts` et `ui/GraphView.tsx` ; tests.

**Interfaces (Produces) :**
- **Partage :** `previewSplit(scene: PlanScene, visible: VisibleSet, moving: number[]): { items: number[]; groups: number[]; complex: number[] }` :
  - `items` : les éléments déplacés et leurs descendants ;
  - `groups` : leurs ancêtres et les groupes déplacés ;
  - `complex` : les faisceaux complexes visibles qui touchent `items ∪ groups`.
- **Aperçu :** `PlanRenderer.preview(scene: PlanScene, split, layouts?: Map<number, Layout>): void`. Il réécrit :
  - les texels de `items` et de `groups` ;
  - les instances `curves` des faisceaux de `complex` ;
  - les enveloppes des groupes de `groups`.

  Le reste ne bouge pas. Les connexions simples, les boîtes et les glyphes suivent seuls, par la texture.
- **Fin :** `PlanRenderer.endPreview(): void` réécrit les mêmes texels et instances depuis la scène de base.
- **`withOffsets` et `withMoves`** coûtent O(éléments touchés) et ne copient que ce qu'ils changent. La poignée de disposition passe sa disposition en surcharge (`layouts`), sans copier la scène.
- **Après une édition :** `updateScene` donne les emplacements changés, puis `PlanRenderer.updateScene` réécrit leurs texels et leurs faisceaux complexes. On ne reconstruit que si l'ensemble visible a pu changer (`hierarchy`, ou des emplacements ajoutés ou retirés).

- [ ] **Step 1 : tests.**
  - `previewSplit` sur la base de test : déplacer un groupe y fait entrer ses descendants et ses ancêtres, et les faisceaux complexes qui les touchent.
  - Pour un décalage nul, `preview` puis `endPreview` laissent la texture et les instances identiques, octet pour octet (Review Focus 5).
  - Après une action puis son annulation, passées par `updateScene` et `PlanRenderer.updateScene`, la texture et les instances égalent celles d'une reconstruction complète (Review Focus 1).
  - **Coûts sur la base de référence**, à la caméra profonde, pour une feuille d'environ 20 connexions tirée par le glissement :
    - préparation d'une image d'aperçu (`withOffsets`, `previewSplit` en cache, texels, instances) ≤ 0,5 ms ;
    - pour un groupe de 200 éléments : ≤ 3 ms.
- [ ] **Step 2 :** constater l'échec, implémenter, suite complète verte, comparer les captures, puis commit et push (`perf(app): aperçus et éditions par la texture des éléments`).

### Task 10 : Banc final, critères, registre

**Files :** `docs/bancs/`, `docs/superpowers/plans/2026-11-03-cirrus-performances-registre.md` et `2026-11-02-cirrus-design.md` (section 21).

- [ ] **Step 1 :** lancer le banc complet (passes, édition et base vide) avec `CIRRUS_BENCH_NAME=app-rendu-apres-3c`, ainsi que la suite de captures.
- [ ] **Step 2 :** comparer à la référence. Critères, sur la base de référence :

  | Critère | Cible |
  |---|---|
  | Chargement, du démarrage du principal à la première image, avec instantané | ≤ 1,5 s. Le chemin de secours (sans instantané) est mesuré et rapporté |
  | Changement d'onglet vers un plan en cache | ≤ 50 ms |
  | Ouverture du lobby sans cache | ≤ 500 ms |
  | Chaque édition du script, jusqu'à l'image | ≤ 30 ms |
  | Image de glissement, fil principal | ≤ 1 ms au p95 |
  | Reconstruction (visible et instances) | ≤ 4 ms au p95 sur le parcours |
  | Carte graphique, contenu | ≤ 1 ms en médiane et ≤ 2 ms au p95 |
  | Processeur ×4 | ≤ 16 ms au p95 |
  | Intervalle entre images | p99 ≤ 1,5 fois la médiane |
  | Mémoire de l'interface, après ramasse-miettes | ≤ 150 Mo |
  | Mémoire privée du principal | ≤ celle de la base vide + 50 Mo |

  Un critère non tenu donne une ligne `Ruling:` au registre, avec la mesure et le levier suivant.
- [ ] **Step 3 :** inscrire dans la section 21 du design la méthode de mesure (plancher, contenu, mémoire après ramasse-miettes, latence d'édition), et la décision d'un état unique avec un instantané en base (section 4). Écrire le registre : décisions, mesures et mineurs reportés. Commit et push (`docs: banc après le plan 3c, critères, registre`).
