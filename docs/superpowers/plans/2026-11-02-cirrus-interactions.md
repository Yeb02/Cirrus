# Cirrus, plan 3b : interactions d'édition — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** on édite le graphe à la souris et au clavier, dans le rendu du plan 3. On peut :
- sélectionner et déplacer ;
- créer des nœuds et des connexions ;
- mettre dans un groupe et en sortir ;
- changer les crans d'échelle ;
- scinder un bras ;
- copier-coller entre plans ;
- cacher et supprimer.

Chaque action passe par une commande du socle, s'enregistre dans la base locale et s'annule par Ctrl+Z.

**Architecture :**
- **Interface :** elle garde une copie de l'état. Une action s'y calcule par une commande pure (`@cirrus/core`), part au processus principal qui l'écrit (`store.commit`), puis s'applique à la copie.
- **Pile d'annulation :** elle vit dans l'interface. Elle est unique pour toute l'application (spec 6.4).
- **Gestes :** ils sont décrits par une machine à états pure (`packages/view/src/gestures.ts`), testée sous Node, qui émet des intentions.
- **Commandes :** l'interface React traduit ces intentions en commandes.
- **Rendu :** le moteur du plan 3 reçoit la scène reconstruite et des surcharges temporaires de position pendant un déplacement.

**Tech Stack :** celle du plan 3, sans nouvelle dépendance.

**Spec :** `C:\Users\alpha\Desktop\Cirrus\2026-11-02-cirrus-design.md`, sections 6.4, 7, 8.1, 8.5 (bras scindés, réglages d'une connexion), 9, 10, 11 et 19.

## Global Constraints

- Les contraintes du plan 3 valent toujours :
  - travail sur `main`, avec un commit et un push par tâche ;
  - syntaxe effaçable, avec l'extension dans les imports ;
  - toute constante est dans `RenderParams` ;
  - rien ne bouge sans action de l'utilisateur ;
  - cloisonnement de l'interface.
- **Une action, un pas :** un geste complet forme une seule `Action`, donc un seul Ctrl+Z (spec 6.4). C'est le cas d'un déplacement de sélection, d'un collage, ou d'une scission de bras avec ses deux fantômes. Les commandes se composent par `combine` (tâche 1).
- **Annulation :**
  - la caméra, la sélection et les paramètres ne s'annulent pas ;
  - dans un champ de texte, Ctrl+Z agit sur le texte ;
  - si le pas annulé touche un autre plan que celui affiché, une notification le nomme.
- **Erreurs :**
  - une `CommandError` s'affiche en notification, avec son message français, et rien ne change ;
  - une erreur d'écriture en base annule l'action en mémoire : la copie de l'interface n'est modifiée qu'après le succès de l'écriture.
- **Gestes (spec 9.1) :**
  - un mouvement de `clickSlopPx` pixels au plus reste un clic ;
  - pendant un geste sans bouton enfoncé, la molette et les flèches restent actives, le clic gauche pose, et Échap ou le clic droit annule.
- **Questions « partout ou ici seulement » :** « ici seulement » est la réponse par défaut, et cette réponse par défaut est un paramètre (spec 19).

## Review Focus

1. **Annuler après une modification venue d'ailleurs :** l'annulation est refusée proprement, avec une notification, sans rien casser. Cela vaut aussi pour la synchro à venir. Testé dans la tâche 2.
2. **Geste interrompu :** Échap, perte du focus, changement d'onglet ou clic droit pendant un déplacement ou un geste sans bouton. Rien n'est écrit, et l'état d'avant revient à l'écran. Testé dans la tâche 4.
3. **Déposer dans son propre descendant, ou un groupe dans lui-même :** c'est refusé, avec le message du socle, et la position d'origine revient. Testé dans la tâche 6.
4. **Coller dans un plan qui contient déjà certains nœuds :** ces nœuds gardent leur place et leur groupe, les autres arrivent, et les connexions suivent selon la règle des deux nœuds (spec 7). Testé dans la tâche 10.
5. **Échelle d'un groupe très imbriqué :** − puis + rend exactement les positions d'origine, aux erreurs d'arrondi près, et aucun autre élément ne bouge. Testé dans la tâche 8.

---

### Task 1 : Socle — composition d'actions, disposition d'une connexion, crans d'échelle

**Files :** `packages/core/src/commands.ts` et `packages/core/tests/commands.test.ts`.

**Interfaces (Produces) :**
- `combine(s: State, label: string, steps: ((s: State) => Action)[]): Action`.
  - Chaque étape est calculée sur l'état laissé par les précédentes, avec une copie de travail par `cloneState`.
  - Les opérations sont concaténées dans une seule action.
  - Une `CommandError` d'une étape interrompt tout.
- `setLayout(s, plan, connection, layout: Omit<ConnectionLayout, 'plan' | 'connection'> | null): Action`. Elle écrit ou efface la disposition propre au plan (spec 5.5 et 8.5).
- `scaleItems(s, plan, items: Id[], delta: number): Action`, pour le cran ± d'une sélection (spec 8.1) :
  - **nœud simple :** k reçoit `delta` ;
  - **groupe :** son titre reçoit `k + delta`, et les positions de tous ses descendants (nœuds et fantômes) sont dilatées autour du barycentre des enfants directs, par `factor^delta`, récursivement. Le cran des membres ne change pas ;
  - **sélection de plusieurs éléments :** leurs centres sont dilatés autour de leur barycentre, et chacun change d'échelle comme ci-dessus.

  Les fantômes passent par des opérations `phantom` dans la même action.

- [ ] **Step 1 : tests.**
  - `combine` de `createNode` puis `connect` donne une seule action, et un seul `invertAction` défait tout.
  - Une étape fautive lève une erreur et l'état reste intact.
  - `setLayout` aller-retour.
  - `scaleItems` :
    - un nœud seul passe à k + 1 ;
    - pour un groupe de la base de test, − puis + rend les positions à 1e-9 près (Review Focus 5) ;
    - un nœud hors du groupe ne bouge pas ;
    - un fantôme du groupe est dilaté.
- [ ] **Step 2 :** constater l'échec, implémenter, voir les tests passer, puis commit et push (`feat(core): composition d'actions, disposition des connexions, crans d'échelle`).

### Task 2 : Session d'édition — copie de l'état, écriture, annulation, notifications

**Files :**
- Create : `packages/app/src/renderer/session.ts` et `packages/app/tests/session.test.ts`.
- Modify : `src/main/index.ts` (IPC `cirrus:commit`), `src/preload/index.ts`, `env.d.ts`, `App.tsx`, `ui/Toasts.tsx`.

**Interfaces :**
- `class EditSession`. Elle prend `constructor(state: State, commit: (a: Action) => Promise<void>, onChange: (s: State, a: Action) => void)` et expose :
  - `run(build: (s: State) => Action): Promise<Result>` ;
  - `undo(): Promise<Result>` et `redo(): Promise<Result>` ;
  - `get state(): State`.

  Le résultat est `type Result = { ok: true; action: Action; plans: Id[] } | { ok: false; message: string }`. `plans` liste les plans touchés par l'action, pour la notification.
- **Ordre :**
  1. la commande est calculée, et une `CommandError` donne `ok: false` ;
  2. l'action est écrite par `commit` ; un échec donne `ok: false` et laisse la copie intacte ;
  3. elle est appliquée à la copie ;
  4. elle est enregistrée dans `UndoStack`, et `onChange` est appelé.

  Les appels sont mis en file d'attente : deux actions rapides ne se croisent jamais.
- **IPC :** `cirrus:commit (action) → void`. Le processus principal appelle `store.commit`. Une erreur repart avec son message, et une `OpConflictError` donne « La base a changé : action refusée. ».
- **Clavier :**
  - Ctrl+Z et Ctrl+Y annulent et rétablissent, sauf dans un champ de texte ;
  - une notification « Annulé : … dans le plan … » s'affiche si le plan touché n'est pas celui affiché (spec 6.4).
- **Rendu :** la scène se reconstruit après chaque changement, et la caméra est conservée.

- [ ] **Step 1 : tests** (avec un `commit` factice) :
  - une action réussie s'applique et s'annule ;
  - un `commit` qui échoue laisse l'état intact et ne pousse rien sur la pile ;
  - une `CommandError` devient `ok: false` avec son message ;
  - une annulation après une modification d'un autre objet est refusée proprement (Review Focus 1) ;
  - deux `run` lancés sans attendre s'exécutent dans l'ordre.
- [ ] **Step 2 :** constater l'échec, implémenter, tests verts, vérifier par une capture que la notification s'affiche, puis commit et push.

### Task 3 : Sélection

**Files :**
- `packages/view/src/selection.ts` et son test ;
- le moteur, pour la mise en évidence : un attribut de sélection dans les boîtes et les rubans, plus le contour d'un groupe sélectionné.

**Interfaces :**
- `type Selection = { items: Set<Id>; connections: Set<Id> }`.
- `toggle(sel, target): Selection`, pour Ctrl+clic (spec 9.1).
- `inRectangle(scene, rect, zoom, p): Id[]`, selon les règles de la spec 9.3 :
  - un élément est pris si son centre est dans le rectangle ;
  - un groupe replié, c'est-à-dire dès que ses membres ne sont plus cliquables (`foldT ≥ 0,5`), est pris entier ou pas du tout ;
  - un groupe ouvert est pris si et seulement si tous ses membres le sont.
- `selectionCenter(scene, sel): Vec2`, le barycentre (spec 9.2).
- **Désélection :** un clic gauche sur le fond, ou un clic droit hors de la sélection.

- [ ] Tests des trois règles de la spec 9.3 sur la base de test, puis implémentation, mise en évidence vérifiée par capture, commit et push.

### Task 4 : Machine des gestes

**Files :** `packages/view/src/gestures.ts` et son test. Nouveaux paramètres : `clickSlopPx` (4) et `dragEdgePanPx` (0, désactivé).

**Interfaces :**
- `type Pointer = { t: 'down' | 'move' | 'up'; button: 0 | 2; sx: number; sy: number; ctrl: boolean; alt: boolean; hit: Hit; time: number } | { t: 'key'; key: string } | { t: 'cancel' }`.
- `type Intent` :
  - `{ t: 'click'; hit; ctrl }` et `{ t: 'context'; hit; sx; sy }` ;
  - `{ t: 'pan'; dx; dy }` ;
  - `{ t: 'dragStart'; items }`, `{ t: 'dragMove'; dxWorld; dyWorld; sx; sy }`, `{ t: 'dragEnd'; dropAt: Vec2; alt }` et `{ t: 'dragCancel' }` ;
  - `{ t: 'rectStart' }`, `{ t: 'rectMove'; rect }` et `{ t: 'rectEnd'; rect }` ;
  - `{ t: 'placeMove'; sx; sy }`, `{ t: 'place'; at: Vec2 }` et `{ t: 'placeCancel' }`, pour les gestes sans bouton.
- `class GestureMachine` :
  - `start(mode: 'place' | 'connect' | 'exclude' | 'paste' | 'split')` ouvre un geste sans bouton ;
  - `feed(p: Pointer, cam: Camera): Intent[]`.
- **Règles (spec 9.1) :**
  - **bouton enfoncé sur un élément :** déplacement de l'élément et de toute sa sélection. Sur le fond, ou sur le fond d'un groupe ouvert : déplacement de la vue ;
  - **Ctrl et bouton enfoncé :** rectangle de sélection ;
  - **Alt :** déplacement « exclure du groupe » ;
  - **Échap, clic droit ou `cancel`** (perte du focus, changement d'onglet) annulent le geste en cours (Review Focus 2).

- [ ] Tests de chaque transition :
  - un mouvement sous `clickSlopPx` donne un clic ;
  - un mouvement au-delà donne un déplacement ;
  - Échap pendant un déplacement donne `dragCancel` ;
  - un geste sans bouton se pose au clic gauche et s'annule au clic droit.

  Ensuite : implémentation, branchement dans `GraphView` (qui remplace la gestion directe du plan 3), commit et push.

### Task 5 : Déplacer des éléments

**Files :**
- `packages/view/src/scene.ts` : `withOffsets(scene, moves: Map<number, Vec2>): PlanScene`, qui décale les éléments déplacés et recalcule les enveloppes de leurs ancêtres sans relire l'état ;
- le moteur : une scène de travail pendant le déplacement ;
- `GraphView`.

**Règles :**
- Pendant le déplacement, la scène de travail est redessinée au plus une fois par image. Au relâchement, une seule action est écrite : `moveNodes` pour les nœuds, plus `movePhantom` pour les fantômes, réunis par `combine`.
- Un groupe se déplace d'un bloc, avec tous ses descendants (spec 10).
- Une annulation rend l'état d'avant (Review Focus 2).

- [ ] Tests de `withOffsets` :
  - le centre d'un groupe suit ses membres ;
  - les autres éléments ne bougent pas.

  Ensuite : branchement, vérification par une capture d'un déplacement simulé, commit et push.

### Task 6 : Groupes — entrer, sortir, intrus

**Règles (spec 10) :**
- **Entrée :** au dépôt, l'élément entre dans le groupe le plus profond sous le curseur, qui s'illumine pendant le déplacement.
  - Un simple dépôt fait entrer un nœud libre, ou descendre un nœud vers un sous-groupe de son groupe.
  - Déposer sur un nœud simple en fait un groupe. Son cran passe alors à `max(k des membres) + groupOffsetSteps` s'il était plus bas (spec 8.1).
- **Sortie :** « Exclure du groupe » dans le menu, ou Alt+déplacement, lance un geste sans bouton ; un clic pose. Reposer le nœud dans son groupe change seulement sa position.
- **Refus :** une inclusion qui créerait une boucle est refusée avec le message du socle, et la position d'origine revient (Review Focus 3).
- **Intrus :** un nœud étranger recouvert par une enveloppe porte un signe très visible (un cercle orange) et une infobulle « intrus dans le groupe … ». Il n'est jamais repoussé.
- **« Partout ou ici seulement » :** la question n'est posée que si la relation d'inclusion existe déjà dans un autre plan. Ce plan 3b applique « ici seulement ». La répercussion « partout », avec placement manuel, fait l'objet de la tâche 12.

- [ ] Tests :
  - `dropTarget(scene, point, dragged): number | null`, le groupe le plus profond qui n'est ni l'élément ni un de ses descendants ;
  - `intruders(scene): Map<number, number>`, chaque élément recouvert associé à son groupe.

  Ensuite : implémentation, captures de l'entrée et de l'intrus, commit et push.

### Task 7 : Menus contextuels, création de nœud, titre

**Files :** `ui/ContextMenu.tsx` et `ui/TitleEditor.tsx` (un champ posé sur la boîte).

**Menus :**
- **nœud :**
  - ajouter une connexion ;
  - exclure du groupe ;
  - − et + (échelle) ;
  - cacher dans ce plan ;
  - supprimer… ;
  - ajouter au lobby (dans un plan ordinaire) ;
  - renommer ;
- **connexion ou branche :** scinder ce bras (sur une branche) ; disposer (tâche 11) ; supprimer la connexion… ;
- **fantôme :** s'y téléporter ; réunir ce bras ;
- **amorce :** importer le nœud dans ce plan ;
- **fond ou groupe ouvert :** nouveau nœud ; coller ; renommer le groupe (sur un groupe) ;
- **sélection :** copier ; cacher ; − et +.

**Création :**
- Le nœud suit le curseur et un clic le pose (spec 12).
- L'éditeur de titre s'ouvre aussitôt. Entrée valide et Échap annule la création.
- La création et le titre forment une seule action.

- [ ] Tests de `menuFor(hit, selection): MenuItem[]`, qui dit quels articles apparaissent pour chaque cible. Ensuite : implémentation, captures des menus, commit et push.

### Task 8 : Crans d'échelle

- − et + dans les menus, et Ctrl+molette sur la sélection ou sur l'élément sous le curseur, appellent `scaleItems` (tâche 1).
- Ctrl+molette regroupe les crans d'un même geste en une seule action, un nouveau pas commençant après `scaleGesturePauseMs` (nouveau paramètre, 400 ms).
- Tests : regroupement des crans par la machine des gestes. Ensuite : commit et push.

### Task 9 : Connexions — tracer, membres, bras scindés, amorces

**Tracer (spec 11.1) :**
- Une ligne droite part du nœud et suit le curseur ; les cibles valides s'illuminent.
- **cibles :** un autre nœud crée une connexion sortante ; le cœur d'une connexion existante (marqueur, ou point central des connexions 1 vers 1 pendant le geste) ajoute le nœud comme source par `addMember` ;
- **cibles exclues :** le fond d'un groupe ouvert et les groupes qui contiennent le nœud de départ.

**Fenêtre de la connexion (spec 8.5 et 11.2) :**
- au clic, elle s'ouvre à l'endroit du clic, avec le titre, la relation en texte brut (l'aperçu LaTeX attend le plan 4) et la liste des membres ;
- les membres absents du plan sont grisés ;
- on y change les rôles, on y ajoute un nœud par son titre avec des suggestions, et on y retire un membre.

**Scinder un bras (spec 8.5) :**
1. le curseur tient le fantôme du nœud lointain, et un clic le pose ;
2. la vue saute vers le nœud lointain, où un clic pose le second fantôme ;
3. la vue revient.

Le tout forme une seule action par `splitArm`, et Échap annule à chaque étape.

**Fantômes et amorces :**
- « S'y téléporter » déplace la caméra et entre dans précédent et suivant ; ce mécanisme ne fait ici que la caméra, l'historique de navigation vient au plan 6 ;
- une amorce se déplace en créant ou déplaçant son fantôme `'absent'` ;
- un clic sur une amorce importe le nœud, qui suit le curseur jusqu'au clic.

- [ ] Tests des cibles valides (`connectTargets(scene, from)`) et de la suite d'étapes de la scission dans la machine des gestes. Ensuite : implémentation, captures, commit et push.

### Task 10 : Copier, coller, cacher, supprimer, ajouter au lobby

**Copier-coller (spec 7) :**
- Ctrl+C copie la sélection, avec le plan et le zoom d'origine.
- Ctrl+V lance un geste sans bouton : le contenu suit le curseur sous forme de fantôme, et un clic le pose.
- Les crans changent de Δk = arrondi de log_f(zoom à la copie ÷ zoom au collage), et les distances de f^Δk.
- Une connexion suit si au moins deux de ses nœuds sont collés ; ses autres branches deviennent des amorces.
- Les inclusions sont recalculées sur l'ancêtre présent.
- Les nœuds déjà présents gardent leur place et leur groupe (Review Focus 4).
- Le collage forme une seule action, par `combine`.

**Cacher :** les éléments sont retirés de ce plan par `removeFromPlan`. Un avertissement apparaît si c'est leur dernier plan.

**Supprimer (Suppr, et le menu) :**
- une fenêtre demande « partout » ou « ici seulement » ;
- elle indique le nombre d'instances et avertit s'il s'agit de la dernière ;
- « partout » passe par `deleteEverywhere`.

**Ajouter au lobby :** depuis un plan, le lobby s'ouvre et le nœud suit le curseur jusqu'au clic.

- [ ] Tests :
  - `pastePlan(state, clip, plan, at, zoom): (s) => Action[]` couvre les cas de la spec 7 ;
  - `deleteSummary(state, ids)` compte les instances et repère les dernières.

  Ensuite : implémentation, captures, commit et push.

### Task 11 : Disposer une connexion

- Quand une connexion est sélectionnée, on peut déplacer le marqueur, orienter le tronc avec une poignée de rotation et régler les poignées de Bézier de chaque branche, comme dans la maquette.
- Le réglage est propre au plan et passe par `setLayout`.
- « Rétablir la disposition automatique » efface ce réglage.
- [ ] Tests de `layoutHandles(geometry)`, qui donne la position des poignées, puis de l'application d'un déplacement de poignée. Ensuite : implémentation, captures, commit et push.

### Task 12 : Répercussion « partout » d'une inclusion

La spec 10 s'applique, telle qu'elle est écrite :
- **Question :** une seule question au dépôt. Elle annonce son coût, par exemple « Partout : 4 plans, dont 2 à placer à la main ».
- **Plans touchés :**
  - seuls changent les plans où le nœud était dans le groupe quitté, ou dans aucun groupe ;
  - un plan où le nœud appartient à un troisième groupe n'est pas touché et est signalé ;
  - un plan où la répercussion créerait une boucle est ignoré et signalé ;
  - là où le groupe d'arrivée n'existe pas, le nœud rejoint le plus bas ancêtre présent.
- **Placement manuel :** les plans à corriger s'ouvrent l'un après l'autre, cadrés sur le nœud, qui est tenu au bout du curseur. Un clic le pose et Échap laisse ce plan tel quel.
- **Annulation :** l'ensemble se défait en un seul Ctrl+Z, grâce à une action composée et complétée au fil des plans.

- [ ] Tests de `repercussion(state, node, fromGroup, toGroup)`, qui donne les plans changés, signalés et à placer, sur une base à trois plans. Ensuite : implémentation, commit et push.
