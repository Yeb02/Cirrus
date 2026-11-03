# Banc de rendu de l'application : app-rendu-apres-t7 (2026-11-03)

Base synthétique : 50000 nœuds, 500000 connexions de connaissance, graine 1 (générateur du plan 1, version 2 : identifiants de 36 caractères), lue sur disque dans une copie neuve à chaque passe, par son instantané binaire et la fin du journal (la passe `secours` exceptée). Parcours : vue d'ensemble, descente à travers tous les niveaux de groupes, déplacement de trois écrans, retour (40 s) ; première seconde écartée.

Passes : `vsync` ; `plancher`, toutes couches masquées (une image vide) ; `throttled-x4`, processeur ralenti quatre fois ; `secours`, la même base sans son instantané (chargement depuis les tables) ; `vide`, une base vide (le plancher d'Electron).

Carte : ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU (0x00002860) Direct3D11 vs_5_0 ps_5_0, D3D11) ; canevas 2561×1544 px.

## Carte graphique, hors reconstructions (ms)

| | p50 | p95 |
|---|---|---|
| Brut (vsync) | 1.51 | 2.44 |
| Plancher (couches masquées) | 0.02 | 0.02 |
| **Contenu** (brut moins plancher) | **1.49** | **2.42** |

Le contenu soustrait les quantiles du plancher à ceux du brut : c'est le coût du dessin lui-même, sans le plancher du chronomètre.

## Passes

| Passe | Carte (ms) p50 / p95 / max | Carte hors reconstructions (ms) p50 / p95 | Processeur (ms) p50 / p95 / max | Intervalle (ms) p50 / p99 / max | Reconstructions (causes) | Pire image |
|---|---|---|---|---|---|---|
| vsync | 1.53 / 3.64 / 9.98 | 1.51 / 2.44 | 0.20 / 1.00 / 3.40 | 10.5 / 11.0 / 42.1 | 300 (stale 1, fold 20, zoomIn 5, rect 275) | 3 ms à 4.4 s (reconstruction) |
| plancher | 0.02 / 0.02 / 4.09 | 0.02 / 0.02 | 0.10 / 1.10 / 3.90 | 10.4 / 11.0 / 47.3 | 297 (stale 1, fold 20, zoomIn 5, rect 272) | 4 ms à 19.4 s |
| throttled-x4 | 1.58 / 3.54 / 9.39 | 1.56 / 2.33 | 0.70 / 4.70 / 146.30 | 10.3 / 20.7 / 208.1 | 258 (stale 1, fold 20, zoomIn 5, rect 233) | 146 ms à 33.4 s (reconstruction) |
| secours | 1.34 / 3.58 / 9.12 | 1.25 / 2.19 | 0.20 / 1.10 / 3.70 | 10.3 / 10.9 / 52.3 | 297 (stale 1, fold 20, zoomIn 5, rect 272) | 4 ms à 32.9 s (reconstruction) |
| vide | 0.22 / 0.30 / 4.30 | 0.22 / 0.30 | 0.10 / 0.20 / 0.40 | 10.3 / 10.8 / 11.0 | 0 (stale 1) | 0 ms à 3.0 s |

## Phases du chargement (ms depuis le démarrage du processus principal)

| Passe | base ouverte | données envoyées | données reçues | état prêt | scène prête | moteur prêt | première image |
|---|---|---|---|---|---|---|---|
| vsync | 125 | 507 | 620 | 1036 | 1951 | 1192 | 2391 |
| plancher | 410 | 692 | 824 | 1128 | 1880 | 1231 | 2266 |
| throttled-x4 | 196 | 522 | 1111 | 2429 | 8338 | 2831 | 11178 |
| secours | 126 | 7662 | 7777 | 8414 | 9523 | 8579 | 10168 |
| vide | 161 | 381 | 382 | 385 | 731 | 717 | 751 |

## Mémoire (Mo, après deux ramasse-miettes)

| Passe | Tas JS de l'interface | Principal (Browser, privée) | Interface (Tab, privée) | Carte (GPU, privée) |
|---|---|---|---|---|
| vsync, après chargement | 246 | 41 | 623 | 168 |
| vsync, après éditions | 302 | 39 | 722 | 210 |
| plancher | 246 | 41 | 624 | 180 |
| throttled-x4 | 246 | 38 | 630 | 169 |
| secours | 246 | 112 | 632 | 168 |
| vide | 4 | 39 | 47 | 244 |

Le tas JS est `performance.memory.usedJSHeapSize` (mémoire précise) après deux `gc()` dans l'interface ; la mémoire privée vient de `app.getAppMetrics()`, le principal ayant aussi forcé ses collections. Relevés en fin de passe ; pour la passe d'édition, aussi avant elle (« après chargement » : le chargement et le parcours de 40 s faits, avant la première édition).

## Édition (fin de la passe vsync)

Sur « Nœud 44 ∑ », le nœud le plus proche du centre de la caméra profonde. Latence : de l'appel (session, annulation, dépôt) à la fin du rendu de la première image de la nouvelle scène.

| Étape | ms |
|---|---|
| Glissement de 300 px en 60 images : fil principal par image d'aperçu, p50 / p95 / max (60 images) | 130.8 / 189.7 / 208.4 |
| Dépôt | 305 |
| Renommage | 20 |
| Création d'un nœud au centre | 65 |
| Connexion des deux | 46 |
| Ctrl+Z n° 1 | 16 |
| Ctrl+Z n° 2 | 11 |
| Ctrl+Z n° 3 | 10 |
| Onglet d'un plan neuf (scène construite) | 24 |
| Retour à l'onglet du lobby (scène gardée) | 17 |

## Critères (spec 21)

- **Carte graphique :** 3.64 ms au p95 sur toutes les images, pour un critère de 2 ms : **non tenu**. Hors reconstructions : 2.44 ms ; contenu seul : 2.42 ms : **non tenu**.
- **Processeur sous ×4 :** 4.70 ms au p95, pour un critère de 16 ms : **tenu**.
