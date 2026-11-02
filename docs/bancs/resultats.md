# Bancs de mesure : synthèse (plan 1, 2026-11-02)

Mesures faites sur le portable principal (RTX 4070 Laptop, Ryzen 7 7435HS, panneau 2560×1600 à 165 Hz). Le petit PC n'étant pas disponible, sa tenue est extrapolée.

**Rapports :**
- `rendu-2026-11-02.md` : passe officielle, tous effets actifs ;
- `rendu-2026-11-02-sans-enveloppes.md` : même scénario, sans les enveloppes de groupes ;
- `rendu-2026-11-02-essai1.md` et `-essai2.md` : essais antérieurs au changement de méthode ;
- `latex-2026-11-02.md` : compilation LaTeX.

## Rendu : critère carte graphique non tenu, moteur confirmé

- **Carte graphique :** 3,66 ms au p95 et 1,82 ms en médiane, pour un critère de 2 ms. **Non tenu.** Sur les différentes exécutions, le p95 varie entre 3,45 et 3,78 ms.
- **Processeur sous ×4 :** 4,8 ms au p95, pour un critère de 16 ms. **Tenu.**
- **Pires images :**
  - Sous ×4, la pire atteint 1,27 s. C'est une reconstruction des seuls rubans en début de descente, quand le zoom dépasse la marge d'échantillonnage : 352 ms de construction et 902 ms côté PixiJS pour créer et envoyer les tampons d'environ 200 000 sommets.
  - Sans ralentissement, la même reconstruction coûte 123 ms, et la pire image de la passe synchronisée 130 ms.
- **Autres mesures :** chargement d'un plan 440 ms, mémoire JavaScript d'environ 120 Mo. Ce chiffre ne compte pas les tampons de la carte graphique.
- **Cause :** le remplissage des enveloppes de groupes, imbriquées et mélangées par transparence. Sans elles, la carte graphique passe à **1,72 ms au p95, et le critère est tenu** (rapport `sans-enveloppes`). Une étude par couche, consignée au registre mais non rejouée en rapport, attribue en plus environ 0,8 ms de la médiane à l'anticrénelage multi-échantillons. Textes, étoiles et boîtes sont négligeables.
- **Extrapolation au petit PC :** une carte intégrée est 5 à 10 fois moins puissante. Aujourd'hui, cela ferait environ 18 à 37 ms au p95. Sans le surcoût des enveloppes, ce serait 9 à 17 ms, donc proche de 60 images par seconde. Ce sont des estimations, avec les réserves ci-dessous.
- **Conclusion :** rien ne justifie de changer de moteur. Le dépassement tient à un poste identifié et corrigeable, qui est aussi le premier du mode performance de la spec.

## Ce que le renderer de l'app doit reprendre (plan 3)

1. **Enveloppes, la priorité :**
   - les dessiner dans une texture à résolution réduite, puisqu'elles sont floues par nature ;
   - ou ne dessiner que la couche visible : avec des intérieurs opaques, comme le veut la spec (8.4), un test de profondeur élimine les couches cachées. Le banc les a dessinées translucides, donc cette piste reste à vérifier.
   - Le mode performance les simplifiera en dernier recours.
2. **Rubans :**
   - construire leur géométrie hors du fil principal ;
   - réutiliser et mettre à jour les tampons existants plutôt que d'en créer de nouveaux à chaque reconstruction, puisque l'envoi pèse plus que le calcul.
3. **Anticrénelage :** le calculer dans les shaders, sur les bords des rubans et des boîtes, au lieu de l'anticrénelage multi-échantillons.
4. **Acquis à conserver :**
   - préchauffage des shaders au chargement, sans quoi la première apparition gèle de l'ordre de 5 s ;
   - **libération de la géométrie de tout maillage remplacé**, car `Mesh.destroy()` ne la libère pas ;
   - **réserve d'objets texte** réutilisés d'une reconstruction à l'autre ;
   - courbes aplaties selon leur courbure ;
   - connexions plus fines que visibles non construites ;
   - règle « au moins un nœud à l'écran » avec fondu ;
   - connexions lointaines en amorces vers un fantôme fixe dans le plan ;
   - coordonnées relatives à une origine locale ;
   - données de visibilité en tableaux contigus.

## LaTeX : critère tenu largement

- **Résultats :** 35 à 84 ms préchauffé, contre 850 à 950 ms à froid, pour un objectif de 300 ms. Un nœud ordinaire s'affiche donc en moins d'un dixième de seconde après la pause de frappe, petite figure TikZ comprise.
- **mylatexformat :** inutile.
- **Noms accentués :** `\includegraphics{courbes_été.png}` compile correctement avec pdfLaTeX sous Windows, et l'image est bien incluse dans le PDF.
- **À reprendre dans l'app :**
  - un processus préparé d'avance ;
  - pdfLaTeX lancé en `nonstopmode`, avec `\scrollmode` uniquement le temps de lire le nom du job sur l'entrée standard, et un délai maximal pour le chargement du préambule. Aucune erreur, ni dans le préambule ni dans un nœud, ne peut alors bloquer : un fichier manquant échoue en quelques dizaines de millisecondes, et un préambule invalide est rejeté avant le délai ;
  - références injectées par `\gdef\r@<label>`, car `\newlabel` est réservé au préambule ;
  - noms neutres ;
  - `-no-shell-escape`.
- **Restent à traiter dans le plan 4 :**
  - échapper les titres et les chemins injectés ;
  - tester un dossier de ressources au chemin accentué ;
  - définir une politique de lecture des fichiers par TeX.

## Remarques de méthode

- **Mesure sans limite d'images :** elle ne mesure pas la carte graphique. La boucle prend plusieurs secondes d'avance puis gèle. Le banc chronomètre donc la carte graphique directement (`EXT_disjoint_timer_query_webgl2`), synchronisation verticale active.
- **Fréquences de la carte graphique :** sous synchronisation verticale, avec environ 2 ms de travail par image de 10 ms, la carte tourne à fréquences réduites par la gestion d'énergie. Les valeurs absolues en héritent, mais pas les comparaisons, avec ou sans enveloppes. Une mesure en mode « performances maximales » du pilote NVIDIA reste à faire.
- **Composition :** le chronomètre n'englobe que le dessin de la scène. La composition de la fenêtre de 2560×1600 par Chromium s'y ajoute, et une carte intégrée la sentira.
- **Première seconde :** elle est écartée de toutes les statistiques, car elle contient l'apparition de la fenêtre et le passage en plein écran.
- **Synchronisation à 100 Hz :** Chromium se cale sur l'écran principal, ici l'écran externe à 100 Hz, même quand la fenêtre est sur le panneau à 165 Hz. Le rapport le signale, et la cible de 165 Hz n'a pas pu être observée.
- **Scène synthétique :** elle suit ta description d'un graphe petit monde et sans échelle. Les 5 % de connexions lointaines y sont en amorces vers un fantôme fixe, placé d'office faute d'utilisateur.

## Plan 3 : banc de l'application (2026-11-02)

Rapport : `app-rendu-2026-11-02.md` (50 000 nœuds, 500 000 connexions, même parcours que le plan 1).

- **Processeur sous ×4 :** 5,8 ms au p95, critère tenu ; pire image 25 ms (contre 1,27 s au plan 1) grâce au travailleur.
- **Carte graphique :** 4,5 ms au p95, critère non tenu. Les enveloppes ne sont plus en cause (dessin direct) ; le texte et les marqueurs pèsent le plus.
- **Chargement :** 7,9 s.
