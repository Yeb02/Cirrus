# Banc de rendu de l'application : app-rendu-3c-reference (2026-11-03)

Base synthétique : 50000 nœuds, 500000 connexions de connaissance, graine 1 (générateur du plan 1, version 2 : identifiants de 36 caractères), lue sur disque dans une copie neuve à chaque passe. Parcours : vue d'ensemble, descente à travers tous les niveaux de groupes, déplacement de trois écrans, retour (40 s) ; première seconde écartée.

Passes : `vsync` ; `plancher`, toutes couches masquées (une image vide) ; `throttled-x4`, processeur ralenti quatre fois ; `vide`, une base vide (le plancher d'Electron).

Carte : ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU (0x00002860) Direct3D11 vs_5_0 ps_5_0, D3D11) ; canevas 2561×1544 px.

## Carte graphique, hors reconstructions (ms)

| | p50 | p95 |
|---|---|---|
| Brut (vsync) | 2.31 | 4.02 |
| Plancher (couches masquées) | 0.08 | 0.10 |
| **Contenu** (brut moins plancher) | **2.22** | **3.92** |

Le contenu soustrait les quantiles du plancher à ceux du brut : c'est le coût du dessin lui-même, sans le plancher du chronomètre.

## Passes

| Passe | Carte (ms) p50 / p95 / max | Carte hors reconstructions (ms) p50 / p95 | Processeur (ms) p50 / p95 / max | Intervalle (ms) p50 / p99 / max | Reconstructions (causes) | Pire image |
|---|---|---|---|---|---|---|
| vsync | 2.37 / 4.57 / 15.84 | 2.31 / 4.02 | 0.50 / 1.60 / 15.00 | 10.0 / 140.2 / 180.1 | 104 (stale 1, fold 20, zoomIn 5, rect 79) | 15 ms à 4.5 s (reconstruction) |
| plancher | 0.08 / 0.10 / 0.79 | 0.08 / 0.10 | 0.20 / 0.70 / 3.70 | 10.0 / 140.0 / 350.0 | 106 (stale 1, fold 20, zoomIn 5, rect 82) | 4 ms à 19.5 s |
| throttled-x4 | 2.02 / 5.15 / 65.94 | 1.98 / 4.35 | 2.10 / 6.80 / 30.10 | 10.0 / 730.2 / 1110.1 | 39 (stale 1, fold 17, zoomIn 4, rect 19) | 30 ms à 19.0 s (reconstruction) |
| vide | 0.19 / 0.23 / 5.27 | 0.19 / 0.23 | 0.30 / 0.40 / 0.60 | 10.0 / 10.2 / 10.7 | 0 (stale 1) | 1 ms à 1.3 s |

## Phases du chargement (ms depuis le démarrage du processus principal)

| Passe | base ouverte | données envoyées | données reçues | état prêt | scène prête | moteur prêt | première image |
|---|---|---|---|---|---|---|---|
| vsync | 8799 | 10194 | 10960 | 13203 | 18039 | 13621 | 20461 |
| plancher | 6511 | 7687 | 8449 | 10647 | 14957 | 10887 | 17124 |
| throttled-x4 | 5786 | 6973 | 8885 | 19364 | 43921 | 20100 | 55954 |
| vide | 148 | 587 | 588 | 590 | 820 | 816 | 833 |

## Mémoire (Mo, après deux ramasse-miettes)

| Passe | Tas JS de l'interface | Principal (Browser, privée) | Interface (Tab, privée) | Carte (GPU, privée) |
|---|---|---|---|---|
| vsync, après chargement | 558 | 459 | 1310 | 251 |
| vsync, après éditions | 1672 | 541 | 4943 | 227 |
| plancher | 557 | 461 | 1336 | 203 |
| throttled-x4 | 557 | 459 | 1106 | 292 |
| vide | 9 | 39 | 63 | 254 |

Le tas JS est `performance.memory.usedJSHeapSize` (mémoire précise) après deux `gc()` dans l'interface ; la mémoire privée vient de `app.getAppMetrics()`, le principal ayant aussi forcé ses collections. Relevés en fin de passe ; pour la passe d'édition, aussi avant elle (« après chargement » : le chargement et le parcours de 40 s faits, avant la première édition).

## Édition (fin de la passe vsync)

Sur « Nœud 44 ∑ », le nœud le plus proche du centre de la caméra profonde. Latence : de l'appel (session, annulation, dépôt) à la fin du rendu de la première image de la nouvelle scène.

| Étape | ms |
|---|---|
| Glissement de 300 px en 60 images : fil principal par image d'aperçu, p50 / p95 / max (60 images) | 416.0 / 526.0 / 672.4 |
| Dépôt | 7360 |
| Renommage | 7360 |
| Création d'un nœud au centre | 7126 |
| Connexion des deux | 8275 |
| Ctrl+Z n° 1 | 7163 |
| Ctrl+Z n° 2 | 7638 |
| Ctrl+Z n° 3 | 7360 |

## Critères (spec 21)

- **Carte graphique :** 4.57 ms au p95 sur toutes les images, pour un critère de 2 ms : **non tenu**. Hors reconstructions : 4.02 ms ; contenu seul : 3.92 ms : **non tenu**.
- **Processeur sous ×4 :** 6.80 ms au p95, pour un critère de 16 ms : **tenu**.

## Remarques (ajoutées à la lecture du rapport)

- **Base :** 554 Mo sur disque, 549 189 connexions (dont 49 189 d'inclusion) et 1 177 133 branches, reprise du cache (tampon à jour). Le chronomètre de la carte était disponible dans les quatre passes, sans mesure disjointe ; `gc()` aussi.
- **Mémoire.** Après le chargement et le parcours, le tas vaut 558 Mo, comme les passes sans édition (557 Mo) : c'est le coût du chargement. Les sept éditions ajoutent ensuite 1 114 Mo de tas (1 672 Mo) et 3,6 Go de mémoire privée à l'interface (de 1,3 à 4,9 Go). D'anciennes copies de l'état et de la scène restent donc tenues après les éditions (session, état React, fibres) ; la cause n'est pas vérifiée.
- **Plancher :** 0,08 / 0,10 ms, bien sous l'« écran vide » de 0,78 / 1,58 ms cité au plan. `all` masque aussi les anneaux (sélection, dépôt, intrus) ; la cause de l'écart n'est pas vérifiée.
- **Intervalles vsync :** p95 de 10,2 ms, mais p99 de 140 ms et maximum de 180 ms. Les images longues (environ 1 %) tombent hors de `renderFrame` : application des images du travailleur, ramasse-miettes. Cause non mesurée.
- **Variabilité d'un lancement à l'autre.** Un premier lancement du même jour, avant la dernière correction, différait nettement :
  - plancher : 0,17 / 0,18 ms ;
  - processeur sous ×4 au p95 : 19,5 ms ; 457 images au lieu de 1 081, intervalle p95 de 1,28 s ;
  - intervalle p50 : 10,6 ms au lieu de 10,0.
  Dans ce lancement-là, le pointeur physique pouvait se trouver sur la fenêtre plein écran : ses `pointermove` passaient par `hover()` et l'index de touche, sur le fil principal. Depuis, les modes banc et capture ignorent les évènements réels. L'état de la carte ou de l'alimentation a aussi pu jouer. Ni l'un ni l'autre n'est vérifié : une comparaison à cette référence doit tenir compte de cet écart.
- **Phases :** l'ouverture de la base varie d'une copie à l'autre. Sous Node, trois copies neuves se sont ouvertes en 6,2, 8,6 et 9,3 s ; ici 8,8, 6,5 et 5,8 s. Une différence de moins de 2 à 3 s n'est donc pas un signal. La scène attend le moteur (la mesure des titres lit la police) : « moteur prêt » précède « scène prête ».
- **Édition :** les valeurs rejoignent celles du plan. Une image d'aperçu de glissement prend 0,42 s au p50 (0,36 s au plan), une édition de 7,1 à 8,3 s.
