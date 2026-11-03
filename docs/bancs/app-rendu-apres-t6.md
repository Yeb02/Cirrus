# Banc de rendu de l'application : app-rendu-apres-t6 (2026-11-03)

Base synthétique : 50000 nœuds, 500000 connexions de connaissance, graine 1 (générateur du plan 1, version 2 : identifiants de 36 caractères), lue sur disque dans une copie neuve à chaque passe, par son instantané binaire et la fin du journal (la passe `secours` exceptée). Parcours : vue d'ensemble, descente à travers tous les niveaux de groupes, déplacement de trois écrans, retour (40 s) ; première seconde écartée.

Passes : `vsync` ; `plancher`, toutes couches masquées (une image vide) ; `throttled-x4`, processeur ralenti quatre fois ; `secours`, la même base sans son instantané (chargement depuis les tables) ; `vide`, une base vide (le plancher d'Electron).

Carte : ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU (0x00002860) Direct3D11 vs_5_0 ps_5_0, D3D11) ; canevas 2561×1544 px.

## Carte graphique, hors reconstructions (ms)

| | p50 | p95 |
|---|---|---|
| Brut (vsync) | 1.85 | 2.80 |
| Plancher (couches masquées) | 0.17 | 0.18 |
| **Contenu** (brut moins plancher) | **1.68** | **2.63** |

Le contenu soustrait les quantiles du plancher à ceux du brut : c'est le coût du dessin lui-même, sans le plancher du chronomètre.

## Passes

| Passe | Carte (ms) p50 / p95 / max | Carte hors reconstructions (ms) p50 / p95 | Processeur (ms) p50 / p95 / max | Intervalle (ms) p50 / p99 / max | Reconstructions (causes) | Pire image |
|---|---|---|---|---|---|---|
| vsync | 1.88 / 3.55 / 11.22 | 1.85 / 2.80 | 0.40 / 1.70 / 4.00 | 10.5 / 10.8 / 42.1 | 303 (stale 1, fold 20, zoomIn 5, rect 278) | 4 ms à 19.4 s |
| plancher | 0.17 / 0.18 / 8.07 | 0.17 / 0.18 | 0.20 / 1.10 / 3.00 | 10.5 / 10.9 / 31.7 | 302 (stale 1, fold 20, zoomIn 5, rect 277) | 3 ms à 19.5 s |
| throttled-x4 | 1.68 / 4.00 / 9.88 | 1.66 / 3.75 | 1.60 / 6.40 / 16.00 | 10.4 / 20.8 / 116.0 | 264 (stale 1, fold 20, zoomIn 5, rect 239) | 16 ms à 21.1 s (reconstruction) |
| secours | 1.76 / 3.89 / 9.44 | 1.73 / 3.34 | 0.40 / 1.70 / 5.10 | 10.5 / 10.9 / 24.8 | 302 (stale 1, fold 20, zoomIn 5, rect 277) | 5 ms à 32.2 s (reconstruction) |
| vide | 0.34 / 0.66 / 9.29 | 0.34 / 0.66 | 0.30 / 0.40 / 1.00 | 10.5 / 11.0 / 14.4 | 0 (stale 1) | 1 ms à 2.4 s |

## Phases du chargement (ms depuis le démarrage du processus principal)

| Passe | base ouverte | données envoyées | données reçues | état prêt | scène prête | moteur prêt | première image |
|---|---|---|---|---|---|---|---|
| vsync | 121 | 791 | 929 | 1211 | 2480 | 1482 | 2937 |
| plancher | 350 | 713 | 839 | 1128 | 2353 | 1363 | 2759 |
| throttled-x4 | 402 | 769 | 1230 | 2119 | 8586 | 2695 | 10648 |
| secours | 135 | 6509 | 6618 | 7179 | 8413 | 7370 | 8810 |
| vide | 168 | 580 | 581 | 584 | 816 | 812 | 829 |

## Mémoire (Mo, après deux ramasse-miettes)

| Passe | Tas JS de l'interface | Principal (Browser, privée) | Interface (Tab, privée) | Carte (GPU, privée) |
|---|---|---|---|---|
| vsync, après chargement | 255 | 38 | 650 | 190 |
| vsync, après éditions | 311 | 38 | 757 | 243 |
| plancher | 254 | 37 | 644 | 208 |
| throttled-x4 | 256 | 39 | 674 | 190 |
| secours | 255 | 114 | 683 | 191 |
| vide | 9 | 39 | 61 | 272 |

Le tas JS est `performance.memory.usedJSHeapSize` (mémoire précise) après deux `gc()` dans l'interface ; la mémoire privée vient de `app.getAppMetrics()`, le principal ayant aussi forcé ses collections. Relevés en fin de passe ; pour la passe d'édition, aussi avant elle (« après chargement » : le chargement et le parcours de 40 s faits, avant la première édition).

## Édition (fin de la passe vsync)

Sur « Nœud 44 ∑ », le nœud le plus proche du centre de la caméra profonde. Latence : de l'appel (session, annulation, dépôt) à la fin du rendu de la première image de la nouvelle scène.

| Étape | ms |
|---|---|
| Glissement de 300 px en 60 images : fil principal par image d'aperçu, p50 / p95 / max (60 images) | 121.2 / 172.8 / 225.8 |
| Dépôt | 218 |
| Renommage | 20 |
| Création d'un nœud au centre | 67 |
| Connexion des deux | 52 |
| Ctrl+Z n° 1 | 18 |
| Ctrl+Z n° 2 | 11 |
| Ctrl+Z n° 3 | 12 |
| Onglet d'un plan neuf (scène construite) | 24 |
| Retour à l'onglet du lobby (scène gardée) | 15 |

## Critères (spec 21)

- **Carte graphique :** 3.55 ms au p95 sur toutes les images, pour un critère de 2 ms : **non tenu**. Hors reconstructions : 2.80 ms ; contenu seul : 2.63 ms : **non tenu**.
- **Processeur sous ×4 :** 6.40 ms au p95, pour un critère de 16 ms : **tenu**.
