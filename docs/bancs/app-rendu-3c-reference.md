# Banc de rendu de l'application : app-rendu-3c-reference (2026-11-03)

Base synthétique : 50000 nœuds, 500000 connexions de connaissance, graine 1 (générateur du plan 1, version 2 : identifiants de 36 caractères), lue sur disque dans une copie neuve à chaque passe. Parcours : vue d'ensemble, descente à travers tous les niveaux de groupes, déplacement de trois écrans, retour (40 s) ; première seconde écartée.

Passes : `vsync` ; `plancher`, toutes couches masquées (une image vide) ; `throttled-x4`, processeur ralenti quatre fois ; `vide`, une base vide (le plancher d'Electron).

Carte : ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU (0x00002860) Direct3D11 vs_5_0 ps_5_0, D3D11) ; canevas 2561×1544 px.

## Carte graphique, hors reconstructions (ms)

| | p50 | p95 |
|---|---|---|
| Brut (vsync) | 2.49 | 3.95 |
| Plancher (couches masquées) | 0.17 | 0.18 |
| **Contenu** (brut moins plancher) | **2.32** | **3.77** |

Le contenu soustrait les quantiles du plancher à ceux du brut : c'est le coût du dessin lui-même, sans le plancher du chronomètre.

## Passes

| Passe | Carte (ms) p50 / p95 / max | Carte hors reconstructions (ms) p50 / p95 | Processeur (ms) p50 / p95 / max | Intervalle (ms) p50 / p99 / max | Reconstructions (causes) | Pire image |
|---|---|---|---|---|---|---|
| vsync | 2.56 / 4.47 / 21.28 | 2.49 / 3.95 | 0.40 / 1.90 / 11.80 | 10.6 / 149.8 / 465.3 | 105 (stale 1, fold 20, zoomIn 5, rect 81) | 12 ms à 4.5 s (reconstruction) |
| plancher | 0.17 / 0.18 / 1.74 | 0.17 / 0.18 | 0.20 / 0.70 / 4.90 | 10.5 / 138.8 / 451.4 | 107 (stale 1, fold 20, zoomIn 5, rect 83) | 5 ms à 19.4 s |
| throttled-x4 | 0.31 / 7.82 / 21.49 | 0.18 / 4.22 | 2.60 / 19.50 / 565.70 | 10.0 / 1540.0 / 2570.1 | 23 (stale 1, fold 13, zoomIn 2, rect 9) | 566 ms à 7.7 s |
| vide | 0.30 / 0.48 / 1.53 | 0.30 / 0.48 | 0.20 / 0.40 / 0.70 | 10.0 / 10.3 / 11.0 | 0 (stale 1) | 1 ms à 2.8 s |

## Phases du chargement (ms depuis le démarrage du processus principal)

| Passe | base ouverte | données envoyées | données reçues | état prêt | scène prête | moteur prêt | première image |
|---|---|---|---|---|---|---|---|
| vsync | 9003 | 10251 | 11108 | 13107 | 18055 | 13531 | 20670 |
| plancher | 4963 | 6130 | 6891 | 8962 | 12962 | 9194 | 15105 |
| throttled-x4 | 4607 | 5689 | 7510 | 18259 | 43751 | 18920 | 62284 |
| vide | 140 | 594 | 595 | 596 | 812 | 808 | 831 |

## Mémoire (Mo, après deux ramasse-miettes)

| Passe | Tas JS de l'interface | Principal (Browser, privée) | Interface (Tab, privée) | Carte (GPU, privée) |
|---|---|---|---|---|
| vsync | 1672 | 531 | 5098 | 225 |
| plancher | 557 | 463 | 1325 | 208 |
| throttled-x4 | 557 | 456 | 1162 | 245 |
| vide | 9 | 39 | 61 | 257 |

Le tas JS est `performance.memory.usedJSHeapSize` (mémoire précise) après deux `gc()` dans l'interface ; la mémoire privée vient de `app.getAppMetrics()`, le principal ayant aussi forcé ses collections.

## Édition (fin de la passe vsync)

Sur « Nœud 44 ∑ », le nœud le plus proche du centre de la caméra profonde. Latence : de l'appel (session, annulation, dépôt) à la fin du rendu de la première image de la nouvelle scène.

| Étape | ms |
|---|---|
| Glissement de 300 px en 60 images : fil principal par image d'aperçu, p50 / p95 / max (60 images) | 382.0 / 515.0 / 665.3 |
| Dépôt | 6478 |
| Renommage | 6450 |
| Création d'un nœud au centre | 7877 |
| Connexion des deux | 8535 |
| Ctrl+Z n° 1 | 7637 |
| Ctrl+Z n° 2 | 6790 |
| Ctrl+Z n° 3 | 6651 |

## Critères (spec 21)

- **Carte graphique :** 4.47 ms au p95 sur toutes les images, pour un critère de 2 ms : **non tenu**. Hors reconstructions : 3.95 ms ; contenu seul : 3.77 ms : **non tenu**.
- **Processeur sous ×4 :** 19.50 ms au p95, pour un critère de 16 ms : **non tenu**.

## Remarques (ajoutées à la lecture du rapport)

- Base : 554 Mo sur disque, 549 189 connexions (dont 49 189 d'inclusion) et 1 177 133 branches, écrite en 13,1 s. Le chronomètre de la carte (`EXT_disjoint_timer_query_webgl2`) était disponible dans les quatre passes, sans mesure disjointe ; `gc()` aussi.
- **Plancher :** 0,17 / 0,18 ms, bien sous l'« écran vide » de 0,78 / 1,58 ms cité au plan. `all` masque aussi les anneaux (sélection, dépôt, intrus), que l'ancienne liste de couches laissait ; la cause de l'écart n'est pas vérifiée. La passe `vide` (ciel et étoiles d'un lobby vide) donne 0,30 / 0,48 ms.
- **Phases :** l'ouverture de la base varie d'une copie à l'autre. Sous Node, trois copies neuves se sont ouvertes en 6,2, 8,6 et 9,3 s ; ici 9,0, 5,0 et 4,6 s. Une différence de phase de moins de 2 à 3 s n'est donc pas un signal. La scène attend le moteur (la mesure des titres lit la police) : « moteur prêt » précède « scène prête ».
- **Intervalles vsync :** p95 de 11,6 ms, mais p99 de 150 ms et maximum de 465 ms. Les images longues (environ 1 %) tombent hors de `renderFrame` : application des images du travailleur sur le fil principal, ramasse-miettes. Cause non mesurée.
- **Passe ×4 dégradée :** 457 images en 40 s (1 045 au plan 3b), intervalle p95 de 1,28 s. Le fil principal est presque toujours occupé hors `renderFrame`, et le travailleur ne livre que 23 reconstructions. L'écran garde donc surtout une géométrie périmée. Ses temps de carte (p50 de 0,31 ms) ne décrivent pas le même contenu que la passe vsync. Le processeur au p95 (19,5 ms, contre 8,2 ms au plan 3b avec des identifiants courts) et la pire image (566 ms, sans reconstruction) sont probablement des pauses du ramasse-miettes ; ce n'est pas vérifié.
- **Mémoire après l'édition :** le tas de l'interface passe de 557 Mo (plancher, ×4) à 1 672 Mo après les sept éditions de la passe vsync ; la mémoire privée de son processus (Tab), de 1,2 ou 1,3 Go à 5,1 Go. Des copies anciennes de l'état et de la scène restent tenues (session, état React, fibres). Cause non vérifiée.
- **Édition :** les valeurs mesurées rejoignent celles du plan : une image d'aperçu de glissement prend 0,38 s au p50 (0,36 s au plan), une édition 6,5 à 8,5 s.
