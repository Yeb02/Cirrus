# Plan 3 (rendu) — registre d'exécution

Copie du registre tenu pendant l'exécution (décisions « Ruling », tâches terminées, relecture finale et corrections). Plan : `docs/superpowers/plans/2026-11-02-cirrus-rendu.md`.

Exécution : inline (executing-plans), l'utilisateur absent pour la nuit (« continue aussi loin que possible ») ; plan exécuté sans attendre son approbation (consigne).
Ruling: plan 3 « rendu et interactions » scindé en 3 (rendu) et 3b (interactions d'édition) — un plan unique dépasserait ce qu'une exécution tient proprement — coût si faux : aucun, 3b suit immédiatement.
Ruling: repli d'un groupe : les bouts de connexion glissent (deux positions par sommet, mélange dans le shader) plutôt qu'un fondu enchaîné — la spec 8.5 dit « glisse en continu » — coût si faux : quatre attributs de plus par sommet.
Pre-flight: interfaces partagées T1→T2..T9 (RenderParams, stepScale, Camera), T2→T3/T4 (PlanScene), T3→T4 (bundleGeometry/appendBundle), T4→T6/T7 (VisibleSet, FrameGeometry, HitIndex), T5→T6..T8 (IPC, bridge). Vérifiés à la lecture : cohérents après la correction du glissement (AppendOptions.fade, VisibleEnd.item2).
Task 1: complete (commits fef0ec4..190ce80, tests: npm test -w packages/view →    Duration  265ms (import 43%, transform 24%, worker 17%, tests 16%))
Task 2: complete (commits 190ce80..c9dc001, tests: npm test -w packages/view →    Duration  450ms (import 38%, transform 25%, tests 25%, worker 12%))
Task 3: complete (commits c9dc001..79cb7ab, tests: npm test -w packages/view →    Duration  511ms (import 38%, transform 30%, tests 20%, worker 12%))
Task 4: Ruling: `openGroupsAt(wx, wy, zoom)` prend le zoom (les groupes se replient entre deux reconstructions) ; `buildFrame` reçoit en plus `prevSides` (titres stables) et `reuse` (tableaux réutilisés) ; `FrameGeometry` porte `origin`, `stubs` et l'identifiant/côté des titres — compléments d'interface, coût si faux : nul.
Task 4: Ruling: un fantôme de centre replié dans un groupe fermé masque la partie lointaine de son bras — cas rare, pas de règle dans la spec — coût si faux : la partie lointaine disparaît tant que le groupe du fantôme est replié.
Task 4: mesure (10 000 nœuds, 50 000 connexions) : scène + index 428 ms ; cadre 13 à 140 ms selon le zoom (4 500 connexions visibles à 0,3). À reprendre en tâche 9 (travailleur) et au plan 3b (mises à jour incrémentales de la scène après une édition).
Task 4: complete (commits 79cb7ab..481e197, tests: npm test -w packages/view →    Duration  1.44s (tests 48%, import 25%, transform 22%, worker 5%))
Task 5: complete (commits 481e197..44f7dd3, tests: npm test -w packages/app →    Duration  308ms (import 36%, transform 30%, tests 24%, worker 9%))
Task 6: Ruling: teintes des groupes de premier niveau dans leur ordre de création (et non par hachage), défauts bleu puis violet comme la maquette validée — un hachage donnait rose et vert — coût si faux : changer `groupHues` dans les paramètres.
Task 6: Ruling: titre d'un groupe ouvert posé juste au-dessus de son enveloppe (comme la maquette), et nouveau paramètre `groupTitleSwap` [0,45 ; 0,95] pour le passage du titre au centre — la constante de la maquette devient réglable — coût si faux : nul.
Task 6: Ruling: anticrénelage analytique pour les rubans, les boîtes et les marqueurs ; les flèches (petits triangles) n'en ont pas — coût si faux : bords de flèches légèrement crénelés, à reprendre si l'utilisateur le remarque.
Task 6: Ruling: redessin à chaque redimensionnement signalé par PixiJS — une capture à 0,001 était vide une fois sur quatre (canevas effacé après la première image) — coût si faux : nul.
Task 6: captures de contrôle dans docs/captures/plan3/ (cadre, repli en cours, replié, zoom 2, Thèse, Article).
Task 6: complete (commits 44f7dd3..6454043, tests: npm test --workspaces --if-present →    Duration  1.43s (tests 46%, import 28%, transform 20%, worker 6%))
Task 7: Ruling: un clic gauche enfoncé sur un élément ne fait rien dans ce plan (le déplacement d'éléments vient au plan 3b) ; sur le fond, y compris le fond d'un groupe ouvert, il déplace la vue — spec 9.1 — coût si faux : nul.
Task 7: vérification par captures (survol simulé, CIRRUS_HOVER) : faisceau illuminé et rappel de hiérarchie ; infobulle d'une amorce. Les gestes réels (molette, glisser, clavier) ne sont pas automatisés : à essayer à la main.
Task 7: complete (commits 6454043..df41454, tests: npm test -w packages/view →    Duration  1.47s (tests 46%, import 27%, transform 21%, worker 5%))
Task 8: Ruling: nouveau paramètre `settingsSaveDelayMs` (300 ms) pour le délai d'écriture des réglages — « délais de pause et de synchro » sont des paramètres avancés (spec 19) — coût si faux : nul.
Task 8: Ruling: la scène ne se reconstruit que si un paramètre qu'elle lit change (`sceneParamsKey`) ; un autre réglage recrée seulement les shaders et le cadre — coût si faux : nul.
Task 8: complete (commits df41454..d9881f1, tests: npm test --workspaces --if-present →    Duration  1.45s (tests 47%, import 28%, transform 19%, worker 5%))
Task 9: Ruling: la grande base réutilise le générateur du banc du plan 1 (import relatif vers bench/rendu) plutôt qu'une copie — une seule distribution synthétique, celle que l'utilisateur a décrite — coût si faux : déplacer le générateur dans packages/fixtures.
Task 9: Ruling: le parcours de caméra vise le premier nœud le plus profond, comme le banc du plan 1 — viser le dernier faisait sortir la vue du rectangle préparé à presque chaque image (853 reconstructions au lieu de ~180) — coût si faux : nul, c'est un choix de banc.
Task 9: Ruling: enveloppes dessinées directement dans la passe principale par défaut (envelopeResolution = 1) — mesure : le temps carte ne dépend pas de la résolution (2,5 ms à 1, 0,5 et 0,25), la passe supplémentaire coûtait ~0,9 ms en médiane ; la texture réduite reste disponible en dessous de 1 — coût si faux : remettre 0,5 dans les paramètres.
Task 9: constat de méthode : le chronomètre de la carte (TIME_ELAPSED) compte aussi l'attente entre deux envois du processeur ; le banc publie donc aussi le temps « hors reconstructions ».
Task 9: travailleur : à 5 000 nœuds sous ×4, processeur p95 16,0 → 10,4 ms, pire image 236 → 29 ms, intervalle p95 19,9 → 10,1 ms.
Task 9: Ruling: une seule demande au travailleur à la fois ; la suivante part au retour, d'où se trouve alors la caméra — sinon, à 50 000 nœuds, des demandes s'empilaient pour des endroits déjà quittés — coût si faux : nul.
Task 9: Ruling: la visibilité se calcule aussi dans le travailleur ; l'index de survol se construit au premier survol ; les textes illisibles avant la prochaine reconstruction ne sont pas créés — le fil principal dépassait 20 ms au p95 à 50 000 nœuds — coût si faux : nul.
Task 9: buildScene à 50 000 nœuds : 7,7 s → mesure à refaire ; les badges et les connexions lisaient l'état par des millions de clés en chaîne, remplacées par les branches du plan regroupées une fois.
Task 9: Ruling: l'état part du processus principal en texte JSON (et non en objet cloné) — à 50 000 nœuds et 500 000 connexions, la copie de l'objet par l'IPC et le pont du préchargement prenait 403 s, contre ~6 s pour tout le reste du chargement — coût si faux : nul.
Task 9: banc officiel (50 000 nœuds, 500 000 connexions) : chargement 7,9 s ; processeur ×4 p95 5,8 ms (tenu) ; carte p95 4,5 ms (non tenu) ; étude par couche : texte et marqueurs ≈ 1,1 ms en médiane, enveloppes 0,4 ms au p95. Correction de la carte non faite dans cette tâche (comme prévu au plan) : pistes consignées dans le rapport.
Task 9: complete (commits d9881f1..55ccd8d, tests: npm test --workspaces --if-present →    Duration  1.46s (tests 41%, import 30%, transform 23%, worker 6%))
Final review: subagent Opus, verdict « With fixes » (2 critiques, 6 importants, 15 mineurs). Re-grade : M2 (connexion masquée sans badge) relevé en Important (l'information disparaît sans trace, rôle même du badge, spec 11.3).
Final: fixed C1 (réglage hors bornes gelant le rendu) — withOverrides ramène chaque valeur dans les bornes de sa fiche et garde les intervalles ordonnés ; starLayers, gridLevels, starsInRect et smooth sont gardés contre les paramètres dégénérés ; la boucle d'affichage survit à une exception — tests « un réglage hors bornes… » et « paramètres dégénérés… » RED→GREEN, suite verte.
Final: fixed C2 (bandeau ⚙ ouvert en cours de route caché par le canevas) — ResizeObserver sur l'hôte du canevas et overflow: hidden — vérifié par capture (CIRRUS_CLICK=.gear), docs/captures/plan3/parametres-ouverts-en-cours.png.
Final: fixed I1 (connexion survolée périmée après reconstruction) — l'indice survolé est remis à zéro à chaque cadre appliqué, et le survol est recalculé au pointeur immobile après une reconstruction et après un zoom à la molette — vérification par lecture (pas de test possible sans WebGL).
Final: fixed I2 (rappel de hiérarchie peu cliquable) — ses événements de pointeur ne remontent plus au graphe — vérification par lecture.
Final: fixed I3 (clic sur un libellé modifié = remise à zéro) — les lignes du bandeau sont des div, plus des label — vérification par lecture.
Final: fixed I4 (sous-groupe replié qui ne s'estompe pas avec son parent) — attribut aParentK des enveloppes, alpha × (1 − foldT(parent)) — test « l'enveloppe d'un sous-groupe porte le repli de son parent » RED→GREEN.
Final: fixed I5 (connexions parallèles ouvertes fusionnées) — seules les extrémités relevées sur un groupe replié fusionnent — test « deux connexions parallèles ouvertes restent distinctes » RED→GREEN.
Final: fixed I6 (constantes en dur) — 12 nouveaux paramètres avec fiche (groupTitleOffset, titleCharWidth, titleBoxHeight, markerRingPx, phantomFillAlpha, phantomTitleDim, foldClickable, stubHitFactor, starPresence, starSeed, starColor, gridColor) ; le test « chaque paramètre a sa fiche » les couvre.
Final: fixed M2 relevé en Important (connexion masquée sans badge) — un nœud présent d'une connexion masquée ici porte le badge — test « une connexion masquée… laisse un badge » RED→GREEN.
Final: minor (deferred): M1 glissement pas entièrement continu (marqueur et titres à la position ouverte, tronc réduit d'un coup à la fin, largeur qui saute au cran du groupe, amorce dans un groupe qui se replie).
Final: minor (deferred): M3 tronc et amorces à f^k sans l'échelle de texte ; titres de connexion fondus sur titleFontPx et non textPx(kMax).
Final: minor (deferred): M4 pas de taille minimale pour un groupe replié de premier niveau ; survol des boîtes agrandies à leur vraie taille.
Final: minor (deferred): M5 le banc ne compte pas apply() dans le temps processeur ; base synthétique sans titres de connexion ; titleSides grossit et part à chaque demande.
Final: Ruling: M6 seuils du test de grande échelle relâchés (400 ms par cadre, 1,5 s par scène) au lieu des 300 ms du plan — la scène à 10 000 nœuds mesurait 428 ms et la machine du second PC est plus lente ; la construction des cadres est passée dans le travailleur — coût si faux : une régression de 300 à 400 ms passerait inaperçue.
Final: minor (deferred): M7 chaque cran de curseur des paramètres recrée tous les objets GPU, et les paramètres de scène reconstruisent la scène entière.
Final: minor (deferred): M8 IPC du banc exposée hors mode banc ; pas de garde will-navigate/setWindowOpenHandler ; le processus principal importe @cirrus/fixtures ; import sans extension vers le banc dans large.ts. À traiter avant la mise en production (plan 9).
Final: minor (deferred): M9 échec d'écriture des réglages silencieux ; changement perdu s'il précède la fermeture de moins de settingsSaveDelayMs.
Final: minor (deferred): M10 glyphes manquants (ℝ ℕ ∼ ∝ ⊗ ‖ ≪ ≫ indices, espace fine, €) : régénérer l'atlas avec un jeu plus large.
Final: minor (deferred): M11 onerror du travailleur sans terminate().
Final: minor (deferred): M12 option --keys documentée sans effet à 55ccd8d (implémentée depuis, plan 3b tâche 2).
Final: minor (deferred): M13 plan d'un seul nœud ouvert à zoom ≈7 (paramètre fitMaxZoom à ajouter).
Final: minor (deferred): M14 facteur entre 1,2 et 1,44 : deux niveaux peuvent se replier à la fois.
Final: minor (deferred): M15 une amorce peut passer sous la boîte de son nœud source.
