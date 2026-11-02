# SDD ledger — plan: docs/superpowers/plans/2026-11-02-cirrus-socle.md

Spec: 2026-11-02-cirrus-design.md. Executor: inline (executing-plans). Branch: main (user instruction: no branches; I push after each task).

Setup: Ruling: no worktree and no branch — the user asked to work on main — cost if wrong: none.

Pre-flight (shared interfaces):
- T2 → T3/T4/T5: model types (NodeRec, ConnectionRec, PlanRec, Placement, BranchRec, ConnectionLayout, PhantomRec, TagKeyDef). Consistent.
- T3 → T4/T5/T6/T7: State, Op, applyOp, cloneState, invertOp, flowOf, subjectOf. Consistent.
- T4 → T5: checkState, groupOf, ancestors. Consistent.
- T5 → T6/T7/T9: Action { id, label, ops } defined in commands.ts. Consistent.
- T6 → T9: UndoStack.undo(state) returns the inverse Action, committed through LocalStore.commit (T7). Consistent.
- T7/T8 → T9: LocalStore, importFile. Consistent.
Task 1: complete (commits 9d4eaad..3d75a83, tests: npm test -w packages/core →    Duration  266ms (tests 56%, import 21%, transform 13%, worker 10%))
Task 2: complete (commits 3d75a83..7d4ec51, tests: npm test -w packages/core →    Duration  301ms (tests 45%, import 25%, transform 17%, worker 13%))
Task 3: complete (commits 7d4ec51..a089fdb, tests: npm test -w packages/core →    Duration  282ms (tests 33%, import 32%, transform 20%, worker 14%))
Task 4: complete (commits a089fdb..3618e14, tests: npm test -w packages/core →    Duration  290ms (import 32%, tests 32%, transform 21%, worker 14%))
Task 5: Ruling: PhantomOf 'center' carries the far node — the centre phantom must know which split arm it belongs to (joinArm finds both phantoms by node) — cost if wrong: none.
Task 5: Ruling: commands validate by difference — an action fails only if it adds a violation; violations already present do not block unrelated edits — cost if wrong: a pre-existing violation could linger unnoticed (the graph-health view will list them).
Task 5: Ruling: removeFromPlan drops the node's inclusion links in that plan (as member and as group); "content follows recursively" stays a UI choice for plan 3 — cost if wrong: one more command in plan 3.
Task 5: Ruling: a node trashed by leaving its last plan keeps its connections untouched (restorable as it was); deleteEverywhere also trashes the node's inclusion connections — cost if wrong: stubs toward a trashed node until the renderer hides them (plan 3).
Task 5: complete (commits 3618e14..096d979, tests: npm test -w packages/core →    Duration  331ms (import 33%, tests 33%, transform 20%, worker 14%))
Task 6: Ruling: commit 1f0a691 went in with one failing test (a pipe hid the exit code; my process error) — the failure was in the test's snapshot, which compared Map/Set iteration order; it now sorts entries. Commands are gated on the test exit code from now on — cost if wrong: none, history.ts unchanged.
Task 6: complete (commits 096d979..5b67676, tests: npm test -w packages/core →    Duration  332ms (import 35%, tests 31%, transform 21%, worker 13%))
Task 7: Ruling: le store n'appelle pas checkState (le brief le liste en Consumes) — les commandes du cœur valident déjà par différence de violations ; revalider tout l'état à chaque commit coûterait O(n) par action ; le store vérifie seulement les « avant » (essai à blanc d'applyOp) — si faux : une action fabriquée à la main hors des commandes peut écrire un état qui viole un invariant ; on ajoutera checkState(s, touched) au commit si un appelant non-commande apparaît (synchro, plan 5).
Task 7: complete (commits 5b67676..cddd82c, tests: npm test -w packages/store →    Duration  351ms (tests 59%, transform 18%, import 18%, worker 4%))
Task 8: complete (commits cddd82c..e7eaec8, tests: npm test -w packages/store →    Duration  358ms (tests 52%, import 22%, transform 19%, worker 6%))
Task 9: Ruling: le registre de tags est créé par une action brute d'opérations tagKey dans la base de test — le cœur n'a pas de commande pour le registre et aucune tâche du plan 2 n'en demande — si faux : il faudra une commande defineTagKey (validation, libellé) quand l'éditeur de registre arrivera (plan 6).
Task 9: Ruling: valeurs des énumérations inventées autour des seuls noms donnés (rang 5) : statut_epistémique = spéculation, hypothèse, plausible, étayé, consensus_scientifique (défaut hypothèse) ; pertinence = anecdotique, secondaire, utile, important, central (défaut utile) — si faux : un renommage dans le registre.
Task 9: Ruling: connexions de structure orientées parent → partie et partie → suivant (source → cible), comme la section 15 le décrit — si faux : inverser les rôles dans build.ts.
Task 9: Ruling: commande de test `npm test --workspaces --if-present` au lieu de `npm test --workspaces` — les espaces bench/* sans script test feraient échouer npm — sans coût.
Task 9: complete (commits e7eaec8..1d419ed, tests: npm test --workspaces --if-present →    Duration  369ms (tests 56%, import 21%, transform 16%, worker 7%))
Task 9: Ruling: ajout d'un .gitattributes (assets en -text) — avec core.autocrlf=true un clone Windows passait le PDF en CRLF (xref cassée, vérifié par cmp) et changeait les empreintes .tex/.py — sans coût.
Final: fixed C1 checkState quadratique (moveNodes 35,6 s → 17 ms, include 31,7 s → 40 ms à 10 000 nœuds / 60 000 connexions) — 'une commande reste rapide sur une grande base' RED (43 751 ms) → GREEN, plus le test de cohérence vérification limitée/complète ; suite verte
Final: fixed I1 fantômes survivant à leur membre / à leur connexion jetée, branche vers un non-membre — 'retirer un membre supprime les fantômes de son bras scindé', 'une connexion jetée perd tous ses fantômes', 'branche vers un nœud qui n'est pas membre de la connexion refusée' RED→GREEN ; suite verte. joinArm n'a pas de garde propre : la règle branchNotMember le refuse via Draft.finish.
Final: fixed (trouvé en mesurant I1) deleteEverywhere quadratique sur un nœud très connecté (500 connexions : 3,1 s → 28 ms, mesuré par script puis gardé par le test d'échelle) ; parseBranchKey en indexOf.
Final: fixed I2 removeFromPlan d'un groupe effaçait la hiérarchie de ses membres — "retirer un groupe d'un plan garde la hiérarchie de ses membres (spec 7)" RED→GREEN, plus le test de nettoyage des groupes cachés vides ; suite verte.
Final: Ruling: remplace la règle de la tâche 5 — un nœud retiré garde ses liens d'inclusion dans le plan tant qu'il a des membres (nœuds ou fantômes) ; sans membres il sort de son groupe, puis ses ancêtres cachés devenus vides aussi ; ancestors() renvoie aussi les groupes cachés, le rendu (plan 3) dessine chaque membre dans le plus proche ancêtre placé — la spec 7 l'exige (« sans créer de connexion »), le plan disait l'inverse — si faux : des liens cachés en trop, sans effet visible ; remettre le groupe dans le plan le rend avec ses membres.
Final: fixed I3 gardes des commandes (corbeille pour connect/addMember, plan inconnu pour addMember/restoreNode, nœud et groupe placés pour include, groupe placé pour movePhantom) — 'un nœud à la corbeille ne peut pas être connecté', 'un plan inconnu est refusé', "on n'inclut que dans un groupe présent dans le plan" RED→GREEN ; suite verte
Final: fixed I4 TagError sortait des commandes au lieu de CommandError — 'une valeur de tag inconnue est refusée par une CommandError' RED→GREEN ; suite verte
Final: Ruling: M5 (fsync) regradé Important — une coupure de courant juste après un import pouvait laisser une référence vers une copie tronquée, sans moyen de le voir ; corrigé (fsyncSync avant close) sans test RED : une coupure de courant ne se reproduit pas dans un test — si faux : aucun, coût négligeable par import.
Final review: subagent (Fable), package review-9d4eaad..8a00c3e. Verdict: With fixes (1 Critical, 4 Important, 11 Minor). Fix pass: C1, I1, I2, I3, I4 + M5 (fsync) regradé, chacun committé et poussé ; suite verte (core 41, store 9, fixtures 3).
Final: Ruling: T1 — packages/tsconfig.packages.json créé au lieu de modifier tsconfig.base.json comme le plan le disait — les options des paquets (erasableSyntaxOnly, imports .ts) auraient cassé bench/* — sans coût. (relevé par la relecture, M9)
Final: Ruling: T7 maintenue, prémisse corrigée — les commandes ne paient plus que ce qu'elles touchent (checkState(s, touched)) ; ajouter cette vérification dans LocalStore.commit coûterait peu et couvrirait la synchro du plan 5, mais tous les écrivains passent aujourd'hui par les commandes — si faux : une action brute (base de test, synchro) peut écrire un état invalide ; à ajouter au plan 5.
Final: Ruling: conflits au niveau de l'enregistrement entier, pas du champ (spec 6.2) — le plan 2 l'a choisi, le plan 5 comparera avant/après champ par champ — si faux : refaire la granularité des opérations au plan 5.
Final: Ruling: commandes absentes (supprimer/renommer un plan, éditer le registre, restaurer une connexion jetée, masquer un membre ici seulement, disposition des connexions) — hors plan 2, aux plans 3 et 6 — sans coût d'ici là (aucune interface).
Final: Ruling: validation des tags limitée aux énumérations (pas de multi, portée, nombre, date) — l'éditeur de tags (plan 3/6) contraindra la saisie — si faux : des tags mal typés stockés, que la santé du graphe listera.
Final: Ruling: règles propres aux documents (un nœud une fois par document, place des suivants) — plan 7 — sans coût d'ici là.
Final: Ruling: branches de connaissance vers un nœud à la corbeille gardées en amorces — le rendu (plan 3) les masque — sans coût.
Final: Ruling: copie de fichier synchrone, synchronous=NORMAL, pas de busy_timeout (une seule instance de l'app, verrou Electron au plan 3), noms NFC/NFD, croissance du journal, historyOf sans les opérations de branche, UUIDv7 non monotone dans la milliseconde — acceptés tels quels — sans coût à l'échelle visée.
Final: minor (deferred): M1 createPlan accepte un second lobby.
Final: minor (deferred): M2 actions sans effet (exclude sans groupe, removeMember d'un non-membre, include du groupe actuel) créent des pas d'annulation vides ou bruyants.
Final: minor (deferred): M3 un rétablissement refusé dit « Impossible d'annuler » au lieu de « rétablir ».
Final: minor (deferred): M4 UndoStack bouge avant le commit du store : un échec disque désynchronise la pile et le journal.
Final: minor (deferred): M5 fichiers temporaires .import-* jamais nettoyés après un plantage ; filePath ne valide pas le hash (à faire avant la synchro, plan 5).
Final: minor (deferred): M6 si BEGIN IMMEDIATE échoue, le ROLLBACK masque l'erreur d'origine ; requêtes préparées à chaque opération.
Final: minor (deferred): M7 Violation sans plan : la clé code|sujet confond deux plans.
Final: minor (deferred): M8 tests absents pour setRole, exclude, moveNodes, un rétablissement refusé, une migration depuis une version plus ancienne.
Final: minor (deferred): M10 Draft non exporté : le plan 3 ne peut pas composer plusieurs commandes en une action validée (répercussion multi-plans, spec 6.4).
Final: minor (deferred): M11 une clé d'énumération sans valeur est acceptée.
