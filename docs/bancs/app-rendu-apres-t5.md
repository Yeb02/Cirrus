# Banc de rendu de l'application : app-rendu-apres-t5 (2026-11-03)

Base synthétique : 50000 nœuds, 500000 connexions de connaissance, graine 1 (générateur du plan 1, version 2 : identifiants de 36 caractères), lue sur disque dans une copie neuve à chaque passe, par son instantané binaire et la fin du journal (la passe `secours` exceptée). Parcours : vue d'ensemble, descente à travers tous les niveaux de groupes, déplacement de trois écrans, retour (40 s) ; première seconde écartée.

Passes : `vsync` ; `plancher`, toutes couches masquées (une image vide) ; `throttled-x4`, processeur ralenti quatre fois ; `secours`, la même base sans son instantané (chargement depuis les tables) ; `vide`, une base vide (le plancher d'Electron).

Carte : ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU (0x00002860) Direct3D11 vs_5_0 ps_5_0, D3D11) ; canevas 2561×1544 px.

## Carte graphique, hors reconstructions (ms)

| | p50 | p95 |
|---|---|---|
| Brut (vsync) | 2.24 | 4.07 |
| Plancher (couches masquées) | 0.17 | 0.18 |
| **Contenu** (brut moins plancher) | **2.06** | **3.89** |

Le contenu soustrait les quantiles du plancher à ceux du brut : c'est le coût du dessin lui-même, sans le plancher du chronomètre.

## Passes

| Passe | Carte (ms) p50 / p95 / max | Carte hors reconstructions (ms) p50 / p95 | Processeur (ms) p50 / p95 / max | Intervalle (ms) p50 / p99 / max | Reconstructions (causes) | Pire image |
|---|---|---|---|---|---|---|
| vsync | 2.32 / 5.77 / 21.26 | 2.24 / 4.07 | 0.50 / 2.00 / 10.80 | 10.7 / 138.5 / 171.0 | 105 (stale 1, fold 20, zoomIn 5, rect 80) | 11 ms à 4.5 s (reconstruction) |
| plancher | 0.17 / 0.18 / 4.47 | 0.17 / 0.18 | 0.20 / 0.70 / 3.80 | 10.7 / 130.7 / 151.4 | 106 (stale 1, fold 20, zoomIn 5, rect 81) | 4 ms à 19.5 s |
| throttled-x4 | 2.74 / 8.10 / 35.58 | 2.70 / 4.61 | 2.10 / 9.90 / 45.30 | 10.8 / 724.5 / 1901.6 | 39 (stale 1, fold 17, zoomIn 4, rect 19) | 45 ms à 7.7 s (reconstruction) |
| secours | 2.68 / 8.00 / 43.77 | 2.52 / 4.30 | 0.50 / 2.00 / 11.70 | 10.8 / 129.4 / 176.0 | 107 (stale 1, fold 20, zoomIn 5, rect 82) | 12 ms à 4.4 s (reconstruction) |
| vide | 0.32 / 0.63 / 9.19 | 0.32 / 0.63 | 0.30 / 0.40 / 0.50 | 10.7 / 13.9 / 28.2 | 0 (stale 1) | 1 ms à 1.2 s |

## Phases du chargement (ms depuis le démarrage du processus principal)

| Passe | base ouverte | données envoyées | données reçues | état prêt | scène prête | moteur prêt | première image |
|---|---|---|---|---|---|---|---|
| vsync | 171 | 873 | 1030 | 1321 | 2857 | 1614 | 4077 |
| plancher | 132 | 715 | 818 | 1221 | 2743 | 1544 | 3893 |
| throttled-x4 | 133 | 716 | 1097 | 2196 | 10510 | 2940 | 15473 |
| secours | 125 | 7933 | 8088 | 8755 | 10269 | 9010 | 11380 |
| vide | 152 | 673 | 674 | 678 | 905 | 898 | 926 |

## Mémoire (Mo, après deux ramasse-miettes)

| Passe | Tas JS de l'interface | Principal (Browser, privée) | Interface (Tab, privée) | Carte (GPU, privée) |
|---|---|---|---|---|
| vsync, après chargement | 238 | 38 | 792 | 253 |
| vsync, après éditions | 282 | 36 | 1209 | 263 |
| plancher | 236 | 40 | 792 | 242 |
| throttled-x4 | 237 | 42 | 601 | 247 |
| secours | 238 | 114 | 787 | 293 |
| vide | 9 | 41 | 61 | 281 |

Le tas JS est `performance.memory.usedJSHeapSize` (mémoire précise) après deux `gc()` dans l'interface ; la mémoire privée vient de `app.getAppMetrics()`, le principal ayant aussi forcé ses collections. Relevés en fin de passe ; pour la passe d'édition, aussi avant elle (« après chargement » : le chargement et le parcours de 40 s faits, avant la première édition).

## Édition (fin de la passe vsync)

Sur « Nœud 44 ∑ », le nœud le plus proche du centre de la caméra profonde. Latence : de l'appel (session, annulation, dépôt) à la fin du rendu de la première image de la nouvelle scène.

| Étape | ms |
|---|---|
| Glissement de 300 px en 60 images : fil principal par image d'aperçu, p50 / p95 / max (60 images) | 249.2 / 314.2 / 326.1 |
| Dépôt | 1316 |
| Renommage | 930 |
| Création d'un nœud au centre | 996 |
| Connexion des deux | 968 |
| Ctrl+Z n° 1 | 895 |
| Ctrl+Z n° 2 | 944 |
| Ctrl+Z n° 3 | 966 |
| Onglet d'un plan neuf (scène construite) | 23 |
| Retour à l'onglet du lobby (scène gardée) | 989 |

## Critères (spec 21)

- **Carte graphique :** 5.77 ms au p95 sur toutes les images, pour un critère de 2 ms : **non tenu**. Hors reconstructions : 4.07 ms ; contenu seul : 3.89 ms : **non tenu**.
- **Processeur sous ×4 :** 9.90 ms au p95, pour un critère de 16 ms : **tenu**.
