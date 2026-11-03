# Banc de rendu de l'application : app-rendu-apres-t4 (2026-11-03)

Base synthétique : 50000 nœuds, 500000 connexions de connaissance, graine 1 (générateur du plan 1, version 2 : identifiants de 36 caractères), lue sur disque dans une copie neuve à chaque passe, par son instantané binaire et la fin du journal (la passe `secours` exceptée). Parcours : vue d'ensemble, descente à travers tous les niveaux de groupes, déplacement de trois écrans, retour (40 s) ; première seconde écartée.

Passes : `vsync` ; `plancher`, toutes couches masquées (une image vide) ; `throttled-x4`, processeur ralenti quatre fois ; `secours`, la même base sans son instantané (chargement depuis les tables) ; `vide`, une base vide (le plancher d'Electron).

Carte : ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU (0x00002860) Direct3D11 vs_5_0 ps_5_0, D3D11) ; canevas 2561×1544 px.

## Carte graphique, hors reconstructions (ms)

| | p50 | p95 |
|---|---|---|
| Brut (vsync) | 2.23 | 4.13 |
| Plancher (couches masquées) | 0.03 | 0.03 |
| **Contenu** (brut moins plancher) | **2.20** | **4.10** |

Le contenu soustrait les quantiles du plancher à ceux du brut : c'est le coût du dessin lui-même, sans le plancher du chronomètre.

## Passes

| Passe | Carte (ms) p50 / p95 / max | Carte hors reconstructions (ms) p50 / p95 | Processeur (ms) p50 / p95 / max | Intervalle (ms) p50 / p99 / max | Reconstructions (causes) | Pire image |
|---|---|---|---|---|---|---|
| vsync | 2.24 / 4.84 / 20.50 | 2.23 / 4.13 | 0.50 / 1.70 / 12.20 | 10.8 / 140.0 / 195.0 | 104 (stale 1, fold 20, zoomIn 5, rect 79) | 12 ms à 4.4 s (reconstruction) |
| plancher | 0.03 / 0.03 / 3.25 | 0.03 / 0.03 | 0.20 / 0.80 / 2.90 | 10.9 / 160.7 / 271.6 | 97 (stale 1, fold 20, zoomIn 5, rect 72) | 3 ms à 1.3 s |
| throttled-x4 | 0.38 / 3.68 / 34.79 | 0.36 / 3.54 | 2.50 / 11.50 / 44.90 | 10.8 / 907.4 / 1135.1 | 35 (stale 1, fold 17, zoomIn 3, rect 16) | 45 ms à 26.4 s (reconstruction) |
| secours | 0.36 / 3.53 / 12.91 | 0.30 / 3.44 | 0.50 / 2.80 / 20.80 | 10.9 / 152.4 / 230.3 | 98 (stale 1, fold 20, zoomIn 5, rect 73) | 21 ms à 21.7 s (reconstruction) |
| vide | 0.09 / 0.10 / 0.11 | 0.09 / 0.10 | 0.30 / 0.50 / 2.80 | 10.9 / 12.0 / 12.2 | 0 (stale 1) | 3 ms à 1.3 s |

## Phases du chargement (ms depuis le démarrage du processus principal)

| Passe | base ouverte | données envoyées | données reçues | état prêt | scène prête | moteur prêt | première image |
|---|---|---|---|---|---|---|---|
| vsync | 124 | 688 | 806 | 1070 | 4571 | 1432 | 6885 |
| plancher | 204 | 1158 | 1340 | 1661 | 6089 | 2182 | 8524 |
| throttled-x4 | 283 | 1005 | 1547 | 2704 | 26988 | 3507 | 40205 |
| secours | 202 | 9126 | 9253 | 9960 | 14085 | 10342 | 16760 |
| vide | 197 | 693 | 693 | 703 | 1108 | 1103 | 1144 |

## Mémoire (Mo, après deux ramasse-miettes)

| Passe | Tas JS de l'interface | Principal (Browser, privée) | Interface (Tab, privée) | Carte (GPU, privée) |
|---|---|---|---|---|
| vsync, après chargement | 327 | 37 | 915 | 289 |
| vsync, après éditions | 1327 | 36 | 4465 | 225 |
| plancher | 326 | 37 | 911 | 296 |
| throttled-x4 | 327 | 37 | 851 | 244 |
| secours | 327 | 113 | 919 | 358 |
| vide | 9 | 38 | 61 | 267 |

Le tas JS est `performance.memory.usedJSHeapSize` (mémoire précise) après deux `gc()` dans l'interface ; la mémoire privée vient de `app.getAppMetrics()`, le principal ayant aussi forcé ses collections. Relevés en fin de passe ; pour la passe d'édition, aussi avant elle (« après chargement » : le chargement et le parcours de 40 s faits, avant la première édition).

## Édition (fin de la passe vsync)

Sur « Nœud 44 ∑ », le nœud le plus proche du centre de la caméra profonde. Latence : de l'appel (session, annulation, dépôt) à la fin du rendu de la première image de la nouvelle scène.

| Étape | ms |
|---|---|
| Glissement de 300 px en 60 images : fil principal par image d'aperçu, p50 / p95 / max (60 images) | 426.5 / 554.1 / 557.9 |
| Dépôt | 5253 |
| Renommage | 4968 |
| Création d'un nœud au centre | 6080 |
| Connexion des deux | 7265 |
| Ctrl+Z n° 1 | 7559 |
| Ctrl+Z n° 2 | 7311 |
| Ctrl+Z n° 3 | 7366 |

## Critères (spec 21)

- **Carte graphique :** 4.84 ms au p95 sur toutes les images, pour un critère de 2 ms : **non tenu**. Hors reconstructions : 4.13 ms ; contenu seul : 4.10 ms : **non tenu**.
- **Processeur sous ×4 :** 11.50 ms au p95, pour un critère de 16 ms : **tenu**.
