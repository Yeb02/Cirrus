# Bancs de mesure : synthèse (plan 1, 2026-11-02)

Mesures faites sur le portable principal (RTX 4070 Laptop, Ryzen 7 7435HS, panneau 2560×1600 à 165 Hz). Le petit PC n'étant pas disponible, sa tenue est extrapolée. Rapports détaillés : `rendu-2026-11-02.md` (essais précédents conservés) et `latex-2026-11-02.md`.

## Rendu : critère carte graphique non tenu, moteur confirmé

- **Carte graphique :** 3,57 ms au p95, et 1,21 ms en médiane, pour un critère de 2 ms. **Non tenu.**
- **Processeur sous ×4 :** 7,5 ms au p95, pour un critère de 16 ms. **Tenu.** Mais la pire image atteint 810 ms, lors d'une reconstruction en vue d'ensemble.
- **Autres mesures :** chargement d'un plan 440 ms, mémoire JavaScript 116 Mo.
- **Cause :** le remplissage des enveloppes de groupes, imbriquées sur plusieurs niveaux et mélangées par transparence. Sans elles, la carte graphique tombe à 0,12 ms en médiane et 1,16 ms au p95. L'anticrénelage multi-échantillons pèse environ 0,8 ms de la médiane. Textes, étoiles et boîtes sont négligeables.
- **Extrapolation au petit PC :** une carte intégrée est 5 à 10 fois moins puissante. Aujourd'hui, cela ferait 18 à 36 ms au p95, soit entre 30 et 55 images par seconde. Après correction des enveloppes, on serait autour de 6 à 12 ms, donc à 60 images par seconde. Ce sont des estimations.
- **Conclusion :** rien ne justifie de changer de moteur. Le dépassement tient à un seul poste, identifié et corrigeable, qui est aussi le premier du mode performance de la spec.

## Ce que le renderer de l'app doit reprendre (plan 3)

1. **Enveloppes, la priorité :**
   - les dessiner dans une texture à résolution réduite, puisqu'elles sont floues par nature ;
   - ou ne dessiner que la couche visible : comme les intérieurs sont opaques, un test de profondeur élimine les couches cachées.
   - Le mode performance (spec 19) les simplifiera en dernier recours.
2. **Anticrénelage :** le calculer dans les shaders, sur les bords des rubans et des boîtes, au lieu de l'anticrénelage multi-échantillons.
3. **Reconstructions :** construire les rubans hors du fil principal, ou les garder en cache par groupe. La vue d'ensemble coûte aujourd'hui jusqu'à 810 ms sous ×4.
4. **Acquis à conserver :**
   - préchauffage des shaders au chargement, sans quoi la première apparition gèle de l'ordre de 5 s ;
   - courbes aplaties selon leur courbure ;
   - connexions plus fines que visibles non construites ;
   - connexions lointaines en amorces ;
   - règle « au moins un nœud à l'écran » avec fondu ;
   - coordonnées relatives à une origine locale, pour la précision en float32 ;
   - données de visibilité en tableaux contigus.

## LaTeX : critère tenu largement

- **Résultats :** 35 à 84 ms préchauffé, contre 850 à 950 ms à froid, pour un objectif de 300 ms. Un nœud ordinaire s'affiche donc en moins d'un dixième de seconde après la pause de frappe, petite figure TikZ comprise.
- **mylatexformat :** inutile.
- **Noms accentués :** `\includegraphics{courbes_été.png}` compile correctement avec pdfLaTeX sous Windows. Le risque noté dans la spec est levé pour ce cas.
- **À reprendre dans l'app :**
  - un processus préparé d'avance ;
  - lecture du nom du job sur l'entrée standard, puis `\nonstopmode` : une erreur ne bloque jamais, et un fichier manquant échoue en quelques dizaines de millisecondes ;
  - références injectées par `\gdef\r@<label>`, car `\newlabel` est réservé au préambule ;
  - noms neutres ;
  - `-no-shell-escape`.

## Remarques de méthode

- **Mesure sans limite d'images :** elle ne mesure pas la carte graphique. La boucle prend plusieurs secondes d'avance puis gèle. Le banc chronomètre donc la carte graphique directement (`EXT_disjoint_timer_query_webgl2`), synchronisation verticale active.
- **Synchronisation à 100 Hz :** Chromium se cale sur l'écran principal, ici l'écran externe à 100 Hz, même quand la fenêtre est sur le panneau à 165 Hz. La cible de 165 Hz n'a pas pu être observée.
- **Scène synthétique :** elle suit ta description d'un graphe petit monde et sans échelle, avec 5 % de connexions lointaines en amorces.
