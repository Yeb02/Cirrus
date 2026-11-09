# Cirrus, plan 6a : les outils essentiels de la saisie — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Écrit le 2026-11-09, en l'absence de l'utilisateur.**
> - L'utilisateur a voulu le plan 6 coupé en deux : « une légère avec les essentiels à faire maintenant, et une autre plus tard ».
> - Le contenu de cette partie légère est un choix de Claude. Il est annoncé à l'utilisateur, qui pourra le corriger.
> - Ce plan s'exécute sans attendre son approbation, comme le veut le travail autonome. Le registre garde la raison et le coût de chaque décision.

**Goal :** donner à l'utilisateur ce qu'il lui faut pour saisir ses vraies données sans se perdre. Il peut alors :
- retrouver tout nœud ou toute connexion par Ctrl+K ;
- revenir en arrière après un saut ;
- voir un objet dans ses autres plans ;
- tenir propre le registre de ses tags ;
- rattraper une suppression depuis la corbeille.

Ses consultations commencent aussi à s'enregistrer, pour la santé du graphe du plan 6b.

**Architecture :**
- **La recherche** est un index en mémoire, dans l'interface, tenu à jour action par action, comme l'index des annotations. Il ne touche ni la base ni la synchro.
- **Les sauts :**
  - Ils passent par un seul mécanisme. GraphView reçoit une cible à cadrer (un nœud ou une connexion, dans un plan), ouvre le plan et cadre l'objet.
  - Une pile de navigation retient chaque saut.
- **Le registre des tags** gagne des commandes du cœur (créer, modifier, renommer, supprimer une clé), et un panneau qui les appelle. Chaque changement est une action, qu'un Ctrl+Z défait et que la synchro transporte.
- **La corbeille** est un panneau qui liste les objets jetés et les restaure, par des commandes du cœur.
- **Les consultations** s'écrivent dans un fichier à part, `consultations.db`, à côté de la base. Il n'est pas synchronisé pour l'instant.

**Tech Stack :** celle du plan 5b. Aucune dépendance nouvelle.

**Spec :** `C:\Users\alpha\Desktop\Cirrus\2026-11-02-cirrus-design.md`, sections 5.4, 6.3, 7, 9, 14, 19 et 20.

**Carte du code :** `C:\Users\alpha\AppData\Local\Temp\claude\C--Users-alpha-Desktop-Cirrus\c00b2880-ac19-4a32-91f3-33431b25af52\scratchpad\carte-6a.md`. Chaque implémenteur la lit pour sa partie.

## Décisions

Une décision non prévue ici se consigne au registre (`docs/superpowers/plans/2026-11-10-cirrus-outils-essentiels-registre.md`, créé à la tâche 1) sous la forme `Ruling:`, avec son coût si elle est fausse.

- **D1, la recherche (Ctrl+K)** (spec 14).
  - **L'index :** en mémoire, dans l'interface. Il est tenu à jour à chaque action par les sujets qu'elle touche, et construit une fois au chargement. Pour chaque nœud, et pour chaque connexion qui n'est pas de structure, il garde :
    - le titre ;
    - les tags (clé et valeur) ;
    - le résumé, ou la relation pour une connexion ;
    - le texte de ses `.tex`, déjà lus pour le registre des labels.

    Tout est replié, sans casse ni accents. Les objets à la corbeille n'y sont pas.
  - **La requête :** chaque mot tapé doit être le début d'un mot de l'objet, dans les champs choisis (« enon comp » trouve « Énoncé de la complexité »).
  - **Les filtres :**
    - Titre, Tags et Résumé sont cochés par défaut.
    - Contenu (les `.tex`) ne l'est pas, comme le veut la spec.
    - « Ce plan seulement » ne l'est pas.
    - Le texte des PDF et des autres fichiers attend le plan 6b.
  - **L'ordre des résultats :**
    - d'abord ce qui est dans le plan actuel, puis dans le lobby, puis dans les autres plans, puis dans aucun plan (une annotation) ;
    - dans chaque groupe, un titre qui répond passe avant les tags, qui passent avant le résumé et le contenu ;
    - à égalité, l'ordre français des titres.
    - Au plus `searchMaxResults` (50) résultats.
  - **L'affichage :**
    - Ctrl+K ouvre un champ en haut du graphe, avec la liste des résultats dessous. Chaque ligne montre le titre et l'endroit (« ce plan », « lobby », le nom d'un autre plan).
    - Les flèches parcourent la liste, Entrée saute au résultat choisi, Échap ferme.
    - Tant que le champ est ouvert, les résultats du plan actuel sont cerclés dans le graphe, d'une couleur à eux (`searchFoundColor`), sans devenir une sélection.
  - **Le saut (D2) :**
    - dans ce plan : la vue cadre l'objet ;
    - sinon, dans le lobby ;
    - sinon, dans le premier autre plan qui l'a, dans l'ordre des onglets puis des noms ;
    - un objet dans aucun plan ouvre son pop-up.
  - **Ctrl+K marche partout,** sauf dans un plein écran, qui est modal, et dans un éditeur de code, où il garde son sens.
  - **Option écartée : FTS5 dans la base.** La spec l'avait choisi [C]. Mais une table nouvelle change le schéma (v5), que la synchro compare entre le serveur et chaque PC, et l'état est déjà en mémoire. La mesure de la tâche 6 doit tenir le critère : une frappe donne sa liste en moins de 50 ms au p95, sur la base de référence de 50 000 nœuds.
- **D2, les sauts et « précédent et suivant ».**
  - **Ce qui saute :**
    - un résultat de la recherche ;
    - « Voir dans un autre plan » ;
    - un bouton de plan dans le pop-up d'un nœud, qui cadre désormais le nœud ;
    - « S'y téléporter » ;
    - « Aller au nœud », nouveau, dans le pop-up qu'ouvre un lien.
  - **Les liens :** un clic sur un lien `\ref` ou `\cite` garde son sens du plan 4b, ouvrir le pop-up du nœud (spec 13, D7, plus récente que la ligne de la spec 14 qui parlait d'un saut). Le saut se fait de ce pop-up [C].
  - **Ce qu'un saut fait :**
    - il ouvre le plan, dans son onglet, s'il le faut ;
    - il cadre l'objet comme le fait le coin de la hiérarchie (`fitItem`), ou toute la connexion par ses parties ;
    - il cercle l'objet un instant (`searchFlashMs`, 1,2 s).
  - **La pile :**
    - chaque saut y pousse l'endroit d'où l'on part (le plan et sa caméra) ;
    - Alt+← revient en arrière et Alt+→ repart en avant, de même que les boutons latéraux de la souris ;
    - un saut fait après un retour efface ce qui était en avant ;
    - au plus `navHistoryMax` (100) endroits, pour la session seulement ;
    - un simple déplacement de la vue n'y entre pas.
  - **Les touches et les boutons :**
    - Alt+← et Alt+→ ne déplacent plus la vue ; les flèches seules la déplacent toujours.
    - Les boutons latéraux ne comptent plus comme un clic gauche dans le graphe.
    - Le principal écoute aussi `app-command` (`browser-backward`, `browser-forward`).
- **D3, « Voir dans un autre plan »** (spec 14).
  - Le menu d'un nœud ou d'une connexion le propose quand l'objet est dans un autre plan que celui-ci.
  - Avec un seul autre plan, il y saute ; avec plusieurs, une question les liste, par leur nom (`AskDialog`).
  - Le lobby compte comme un plan.
- **D4, le registre des tags** (spec 5.4).
  - **Les commandes du cœur,** une action chacune :
    - `defineTagKey(s, def)` crée une clé ou en modifie la définition ;
    - `renameTagKey(s, from, to)` renomme une clé partout : la définition, et chaque nœud et chaque connexion qui la porte, corbeille comprise. Si un objet porte déjà la nouvelle clé, une clé à une valeur garde la valeur de l'ancienne, et une clé multiple réunit les valeurs sans doublon ;
    - `deleteTagKey(s, key)` retire une définition. Ses tags restent sur les objets, comme une clé non déclarée, ce que la spec permet ;
    - `renameEnumValue(s, key, from, to)` renomme une valeur d'énumération, et la réécrit sur chaque objet qui la porte.
  - **Les refus :**
    - une modification de type, de portée ou de valeurs d'énumération qu'une valeur déjà portée ne respecterait plus. Le message nomme le nombre d'objets et le premier ;
    - un nom de clé vide, trop long (`MAX_ID_CHARS`) ou déjà pris par une autre définition ;
    - une clé dont Cirrus se sert : `label`, `clé_bibtex`, `auteur`, `date_de_publication`, `doi`, `arxiv`, `partie` et `suivant`. Elle se lit dans le panneau, mais ne se renomme, ne se supprime, ni ne change de type, de portée ou de multiplicité. Seuls son caractère obligatoire et sa valeur par défaut se changent [C].
  - **Le panneau « Registre des tags » :**
    - ouvert par le menu du fond ;
    - il liste les clés déclarées et les clés portées sans déclaration (« non déclarée »), chacune avec le nombre d'objets qui la portent ;
    - on y crée, modifie, renomme et supprime une clé, et on y édite les valeurs d'une énumération (nom et rang).
  - **Les tags d'une connexion :** le pop-up d'une connexion gagne la même section « Tags » que celui d'un nœud, avec ses suggestions limitées aux clés de portée connexion ou les deux. Rien ne permettait de les modifier.
  - **Une synchro** fait se croiser un renommage et une modification faite ailleurs : elle se fusionne enregistrement par enregistrement (6.6, D4), et peut rendre l'ancienne clé à un objet. Le panneau la montre alors comme « non déclarée », et un second renommage la range [C].
- **D5, la corbeille** (spec 6.3, 7).
  - **Le panneau « Corbeille »,** ouvert par le menu du fond :
    - il liste les nœuds et les connexions jetés, du plus récent au plus ancien, avec leur genre et leur date ;
    - un champ filtre par le titre ;
    - les annotations jetées y sont aussi.
  - **Restaurer un nœud :** le nœud suit le curseur comme un collage, au cran lisible, et un clic le pose dans le plan actuel (`restoreNode`), en une action. Échap abandonne.
  - **Restaurer une connexion :**
    - elle revient avec ses branches dans chaque plan où au moins deux de ses membres sont placés, en une action ;
    - avec moins de deux membres vivants, elle est refusée : « Ses nœuds sont à la corbeille : restaure-les d'abord. ».
  - **Ce qui ne revient pas :** les appartenances et les connexions retirées avec un nœud (comme dans la spec 6.2, à la synchro). Le Ctrl+Z de la session, lui, rend tout.
  - **Vider la corbeille :** rien ne se vide. La suppression d'un contenu passe par « Poids de l'historique », au plan 6b.
- **D6, l'enregistrement des consultations** (spec 20).
  - **Le fichier :** `consultations.db`, à côté de la base, et pas dans son schéma, pour ne pas changer le format que la synchro compare. Il a une table `events (at, pc, kind, subject, plan, detail)`, et n'est pas synchronisé : son envoi par lots au serveur vient au plan 6b [C].
  - **Ce qui s'enregistre :**
    - l'ouverture et la fermeture de l'app ;
    - un plan montré ;
    - le pop-up d'un nœud ou d'une connexion ouvert ;
    - un fichier ouvert en aperçu ou en plein écran ;
    - une recherche faite, avec son texte et le résultat choisi ;
    - un saut ;
    - les moments où la fenêtre prend ou perd le focus, pour le temps passé.
  - **L'écriture :** l'interface garde les événements en mémoire et les envoie au principal toutes les `consultationsFlushMs` (10 s) et à la fermeture. Le principal les écrit en une transaction.
  - **Ce qui ne s'enregistre pas :** ni texte tapé, ni contenu, hors le texte d'une recherche.
  - **L'interrupteur :** le réglage « Enregistrer mes consultations », sous une rubrique, l'arrête. S'il n'existe pas de réglage à deux états, un nombre 0 ou 1 en tient lieu [C].
  - **Ce n'est pas une action :** cela n'entre ni dans le journal, ni dans l'annulation.

**Hors du plan 6a (plan 6b) :**
- la santé du graphe ;
- l'agenda et les feuillets ;
- l'envoi des consultations au serveur ;
- l'aperçu au survol d'un lien, le choix du plan d'arrivée au clic droit, l'import du nœud cible ;
- le texte des PDF dans la recherche ;
- l'historique par nœud (versions, restauration, différences) ;
- « Poids de l'historique ».

## Global Constraints

- Les contraintes des plans 3 à 5b valent toujours :
  - travail sur `main`, sans branche. Les agents font leurs commits ; le contrôleur pousse, jamais en force ;
  - messages de commit en français, terminés par `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` ;
  - syntaxe effaçable, avec l'extension dans les imports ;
  - identifiants et commentaires en anglais, textes de l'interface en français.
- **Les réglages :** toute constante est un paramètre de `RenderParams`, avec un libellé français, dans un groupe d'une rubrique de `PARAM_RUBRICS`, à 16 entrées au plus par groupe. Nouveaux réglages :
  - `searchMaxResults` : 50, de 10 à 500 ;
  - `searchFoundColor` : une couleur distincte de celle de la sélection ;
  - `searchFlashMs` : 1 200, de 0 à 10 000 ;
  - `navHistoryMax` : 100, de 10 à 1 000 ;
  - `consultationsFlushMs` : 10 000, de 1 000 à 600 000 ;
  - l'interrupteur des consultations (D6).
- **La base :** son schéma ne change pas (v4). Les commandes nouvelles du cœur passent par `Draft.finish`, avec ses contrôles, et par les contrôles du serveur (`parseUnit`), comme toute action.
- **La performance :**
  - le coût d'une action sur l'index de recherche suit les sujets qu'elle touche ;
  - une frappe donne sa liste en moins de 50 ms au p95 sur la base de référence ;
  - la construction de l'index au chargement est mesurée, et ne retarde pas la première image.
- **Les tests et les captures :**
  - `npx vitest run --maxWorkers=1`, paquet par paquet, et `tsc` sur chaque paquet touché ;
  - pendant une tâche, seuls les scénarios d'interface qui la concernent tournent. Tous les scénarios et toutes les captures tournent une fois, en fin de tâche ;
  - jamais Internet, jamais la base de l'utilisateur, jamais `%LOCALAPPDATA%\Cirrus` ;
  - une seule exécution d'Electron à la fois, fenêtres en arrière-plan ;
  - les captures des plans précédents ne changent pas, sauf écart consigné. Les nouvelles vont dans `docs/captures/plan6a/`.
- **Le processus :** une relecture par tâche, au plus un tour de correction. Les commandes du cœur de la tâche 3 gardent toute la rigueur, car elles passent par la synchro.

## Review Focus

1. **Une recherche sur une grosse base :** 50 000 nœuds, des résumés longs, une frappe rapide. La liste suit sans geler la fenêtre, et le cercle des résultats ne ralentit pas le dessin. Mesuré à la tâche 6.
2. **Un renommage de clé croisé avec la synchro :** un autre PC a modifié entre-temps un objet qui la portait. Tout converge, sans violation. La clé ancienne, si elle revient, se voit. Testé à la tâche 3.
3. **Un saut vers un objet devenu introuvable :** jeté, retiré de son plan, ou d'un plan fermé entre-temps. Le saut le dit, la pile reste juste, et « précédent » ne mène pas à un plan supprimé. Testé à la tâche 2.
4. **Restaurer depuis la corbeille un nœud dont le plan d'origine n'existe plus, ou une connexion dont un membre est encore jeté.** C'est refusé ou fait proprement, en une action qu'un Ctrl+Z défait. Testé à la tâche 4.
5. **Les consultations quand l'app se ferme brutalement, ou que leur fichier est verrouillé :** au plus `consultationsFlushMs` d'événements perdus, jamais d'erreur visible ni de blocage de la fermeture. Testé à la tâche 5.

---

### Task 1 : L'index de recherche, Ctrl+K et le cadrage d'une cible

**Files :**
- Create :
  - `packages/app/src/renderer/search/index.ts` : l'index et la requête ;
  - `packages/app/src/renderer/ui/SearchBox.tsx` ;
  - `packages/app/tests/search.test.ts` ;
  - le registre du plan.
- Modify :
  - `App.tsx` : Ctrl+K et l'index, tenu sur `[state, rev]` comme `AnnotationIndex` ;
  - `ui/GraphView.tsx` et `ui/graph/*` : une cible à cadrer, et le cercle des résultats ;
  - `render/PlanRenderer.ts` : un quatrième contour, `found` ;
  - `packages/view/src/params.ts` : `searchMaxResults`, `searchFoundColor`, `searchFlashMs` ;
  - `latex/useLatex.ts` : il expose les textes des `.tex` à l'index.

**Interfaces (Produces) :**
- `class SearchIndex`, avec :
  - `static build(s: State, texts: ReadonlyMap<string, string>, previous?: SearchIndex, action?: Action | null): SearchIndex` : incrémental quand `previous` et `action` sont donnés ;
  - `query(q: string, f: SearchFilters, where: { plan: Id; lobby: Id; tabs: Id[] }, max: number): SearchHit[]`.
- `interface SearchFilters { title: boolean; tags: boolean; summary: boolean; content: boolean; planOnly: boolean }`.
- `interface SearchHit { id: Id; kind: 'node' | 'connection'; title: string; plan: Id | null; field: 'title' | 'tags' | 'summary' | 'content' }`. `plan` est celui où le saut ira : null pour un objet dans aucun plan.
- `GraphHandle.reveal(target: { plan: Id; id: Id; kind: 'node' | 'connection' }): boolean` : il ouvre le plan s'il le faut, cadre l'objet et le cercle. Il rend faux si l'objet n'est plus là.
- `PlanRenderer.setFound(items: Id[])`.

- [ ] **Step 1 : tests.**
  - **La requête :** le début des mots, sans casse ni accents ; plusieurs mots ; chaque filtre ; « Ce plan seulement » ; l'ordre (plan, lobby, autres, aucun ; titre avant tags avant résumé) ; une connexion de structure, absente ; un objet jeté, absent.
  - **L'incrémental :** un renommage, un tag ajouté, un nœud jeté puis rendu, une action de synchronisation. Chaque fois, le résultat est égal à celui d'un index construit de zéro.
  - **`reveal` :** un nœud de ce plan ; d'un autre plan ; une connexion ; un objet jeté, qui rend faux.
- [ ] **Step 2 :** lancer. Attendu : échec.
- [ ] **Step 3 :** implémenter.
- [ ] **Step 4 :** les suites de `app` et `view`, et `tsc`. Scénario d'interface : Ctrl+K, une frappe, puis Entrée saute vers un nœud d'un autre plan.
- [ ] **Step 5 :** créer le registre. Commits.

### Task 2 : La pile de navigation, « Voir dans un autre plan », les sauts

**Files :**
- Create : `packages/app/src/renderer/navigation.ts` (la pile, pure) et `packages/app/tests/navigation.test.ts`.
- Modify :
  - `App.tsx` ou `ui/GraphView.tsx` : la pile, Alt+← et Alt+→, les boutons latéraux ;
  - `main/window.ts` : `app-command` vers l'interface ;
  - `packages/view/src/menus.ts` : `seeElsewhere` ;
  - `ui/graph/menuActions.ts` ;
  - `ui/NodePopup.tsx` : les boutons de plan cadrent, et « Aller au nœud » dans un pop-up ouvert par un lien ;
  - `packages/view/src/params.ts` : `navHistoryMax`.

**Interfaces (Produces) :**
- `class NavHistory { push(here: Place): void; back(here: Place): Place | null; forward(here: Place): Place | null }`, avec `interface Place { plan: Id; camera: Camera }`.
- Le menu gagne `seeElsewhere`, libellé « Voir dans un autre plan ».

- [ ] **Step 1 : tests.**
  - **La pile :** pousser, revenir, repartir ; un saut après un retour efface ce qui était en avant ; la borne.
  - **Les endroits morts :** un endroit dont le plan a disparu est sauté.
  - **Le menu :** il n'offre « Voir dans un autre plan » que si l'objet est ailleurs.
  - **Les entrées :**
    - Alt+← ne déplace pas la vue ;
    - un bouton latéral n'est pas un clic gauche ;
    - les boutons de plan du pop-up cadrent le nœud.
- [ ] **Step 2 :** lancer. Attendu : échec.
- [ ] **Step 3 :** implémenter.
- [ ] **Step 4 :** la suite de `app` et `view`, et `tsc`. Scénario : un saut par la recherche, Alt+←, Alt+→, puis « Voir dans un autre plan » avec deux plans.
- [ ] **Step 5 :** commits.

### Task 3 : Le registre des tags

**Files :**
- Modify :
  - `packages/core/src/commands.ts` : `defineTagKey`, `renameTagKey`, `deleteTagKey`, `renameEnumValue`, et un accès `taggedWith(s, key)` exporté de `state.ts` ;
  - `core/src/index.ts` ;
  - les tests du cœur ;
  - `renderer/actions.ts` : les `Build` correspondants.
- Create :
  - `ui/TagRegistryPanel.tsx` ;
  - `packages/app/tests/tagRegistry.test.ts`.
- Modify :
  - `ui/ConnectionPopup.tsx` : la section « Tags », reprise de `NodePopup` (à extraire en un composant commun) ;
  - `packages/view/src/menus.ts` : `tagRegistry` dans le menu du fond ;
  - `App.tsx` ou `ui/screens.ts` : le panneau.

**Interfaces (Produces) :**
- `defineTagKey(s: State, def: TagKeyDef): Action`.
- `renameTagKey(s: State, from: string, to: string): Action`.
- `deleteTagKey(s: State, key: string): Action`.
- `renameEnumValue(s: State, key: string, from: string, to: string): Action`.

Toutes lèvent `CommandError`, avec le message français de D4. `PROTECTED_TAG_KEYS` liste les clés dont Cirrus se sert.

- [ ] **Step 1 : tests (rigueur entière).**
  - **Chaque commande et chaque refus de D4.**
  - **Le renommage :**
    - une clé à une valeur déjà portée sous le nouveau nom ;
    - une clé multiple avec des doublons ;
    - la corbeille comprise ;
    - un Ctrl+Z qui rend tout.
  - **La synchro :**
    - un renommage croisé avec la modification, sur un autre PC, d'un objet qui portait la clé. Dans la simulation du cœur (`reconcile`), tout converge sans violation ;
    - `parseUnit` accepte les actions produites.
  - **Les tags d'une connexion** s'ajoutent et se retirent.
- [ ] **Step 2 :** lancer. Attendu : échec.
- [ ] **Step 3 :** implémenter.
- [ ] **Step 4 :** les suites de `core`, `server` et `app`, et `tsc`. Scénario : créer une énumération, taguer deux nœuds, renommer une valeur, renommer la clé, Ctrl+Z.
- [ ] **Step 5 :** commits.

### Task 4 : La corbeille

**Files :**
- Modify :
  - `packages/core/src/commands.ts` : `restoreConnection`, et `restoreNode` revu si besoin ;
  - les tests du cœur ;
  - `renderer/actions.ts` ;
  - `ui/graph/placement.ts` : le genre de pose `restore` ;
  - `packages/view/src/menus.ts` : `trash` dans le menu du fond.
- Create : `ui/TrashPanel.tsx` et `packages/app/tests/trash.test.ts`.

**Interfaces (Produces) :**
- `restoreConnection(s: State, id: Id): Action` : les branches dans chaque plan où au moins deux membres vivants sont placés. Il refuse avec moins de deux membres vivants.
- `trashedItems(s: State): { id: Id; kind: 'node' | 'connection'; title: string; at: number }[]`, du plus récent au plus ancien.

- [ ] **Step 1 : tests.**
  - **La liste :** nœuds, connexions et annotations.
  - **Restaurer un nœud :** par la pose, dans le plan actuel.
  - **Restaurer une connexion :** ses branches ; le refus.
  - **Le Ctrl+Z** de chaque restauration.
  - **Le filtre** par titre.
- [ ] **Step 2 :** lancer. Attendu : échec.
- [ ] **Step 3 :** implémenter.
- [ ] **Step 4 :** les suites de `core` et `app`, et `tsc`. Scénario : jeter un nœud, l'ouvrir dans la corbeille, le poser, Ctrl+Z.
- [ ] **Step 5 :** commits.

### Task 5 : L'enregistrement des consultations

**Files :**
- Create :
  - `packages/app/src/main/consultations.ts` : le fichier et l'écriture par lots ;
  - `packages/app/src/renderer/consultations.ts` : la file et les points d'émission ;
  - `packages/app/tests/consultations.test.ts`.
- Modify :
  - `main/ipc/base.ts` (ou un module `ipc/consultations.ts`), `preload/index.ts`, `renderer/env.d.ts` ;
  - les points d'émission de D6 : `App.tsx`, `ui/panels/Panels.tsx`, `ui/GraphView.tsx`, `ui/graph/menuActions.ts`, `ui/screens.ts` ;
  - `packages/view/src/params.ts`.

**Interfaces (Produces) :**
- `interface Consultation { at: number; kind: ConsultationKind; subject?: Id; plan?: Id; detail?: string }`.
- `window.cirrus.recordConsultations(events: Consultation[]): void`.
- Au principal, `Consultations.open(dir: string, pc: string)` et `.write(events)`. Le fichier `consultations.db` est créé à la première écriture.

- [ ] **Step 1 : tests.**
  - un lot écrit en une transaction ;
  - l'écriture à la fermeture ;
  - l'interrupteur ;
  - un fichier verrouillé ou abîmé : un avertissement dans la console, rien de visible, et l'app continue ;
  - chaque genre d'événement émis par son point.
- [ ] **Step 2 :** lancer. Attendu : échec.
- [ ] **Step 3 :** implémenter.
- [ ] **Step 4 :** la suite de `app`, et `tsc`. Scénario : ouvrir un plan, un pop-up, faire une recherche et fermer l'app ; les événements sont dans `consultations.db`.
- [ ] **Step 5 :** commits.

### Task 6 : Scénarios, mesures, captures, spec

- [ ] **Step 1 :** tous les scénarios d'interface passent.
- [ ] **Step 2 : les mesures,** sur la base de référence (50 000 nœuds), trois passes :
  - la construction de l'index au chargement ;
  - une frappe dans la recherche, jusqu'à la liste affichée (critère : p95 sous 50 ms) ;
  - une action ordinaire, avant et après l'index (le surcoût) ;
  - le dessin avec le cercle des résultats.
- [ ] **Step 3 : les captures** (`docs/captures/plan6a/`) :
  - la recherche ouverte avec ses résultats ;
  - le registre des tags ;
  - une énumération en édition ;
  - les tags d'une connexion ;
  - la corbeille ;
  - la question de « Voir dans un autre plan ».

  Les captures des plans précédents restent à 0 px.
- [ ] **Step 4 : la spec.** Inscrire ce qui a été fixé (« Fixé par le plan 6a ») aux sections 5.4, 6.3, 7, 14, 19 et 20, et la section 24 (6a fait, 6b à venir). Le registre, avec les mesures.
- [ ] **Step 5 :** commits.
