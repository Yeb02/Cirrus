# Banc de rendu de l'application : app-rendu-apres-t8 (2026-11-04)

Base synthétique : 50000 nœuds, 500000 connexions de connaissance, graine 1 (générateur du plan 1, version 2 : identifiants de 36 caractères), lue sur disque dans une copie neuve à chaque passe, par son instantané binaire et la fin du journal (la passe `secours` exceptée). Parcours : vue d'ensemble, descente à travers tous les niveaux de groupes, déplacement de trois écrans, retour (40 s) ; première seconde écartée.

Passes : `vsync` ; `plancher`, toutes couches masquées (une image vide) ; `throttled-x4`, processeur ralenti quatre fois ; `secours`, la même base sans son instantané (chargement depuis les tables) ; `vide`, une base vide (le plancher d'Electron).

Carte : ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU (0x00002860) Direct3D11 vs_5_0 ps_5_0, D3D11) ; canevas 2561×1544 px.

## Carte graphique, hors reconstructions (ms)

| | p50 | p95 |
|---|---|---|
| Brut (vsync) | 1.70 | 2.38 |
| Plancher (couches masquées) | 0.02 | 0.02 |
| **Contenu** (brut moins plancher) | **1.68** | **2.36** |

Le contenu soustrait les quantiles du plancher à ceux du brut : c'est le coût du dessin lui-même, sans le plancher du chronomètre.

## Passes

| Passe | Carte (ms) p50 / p95 / max | Carte hors reconstructions (ms) p50 / p95 | Processeur (ms) p50 / p95 / max | Intervalle (ms) p50 / p99 / max | Reconstructions (causes) | Processeur des images reconstruites (ms) p50 / p95 / max | Pire image |
|---|---|---|---|---|---|---|---|
| vsync | 1.71 / 2.73 / 7.62 | 1.70 / 2.38 | 0.20 / 1.60 / 8.40 | 10.5 / 10.8 / 41.8 | 298 (stale 2, fold 20, reveal 4, rect 270, origin 1) | 1.70 / 4.30 / 8.40 | 8 ms à 15.8 s (reconstruction) |
| plancher | 0.02 / 0.02 / 1.85 | 0.02 / 0.02 | 0.10 / 1.60 / 8.10 | 10.5 / 10.9 / 41.6 | 296 (stale 2, fold 20, reveal 4, rect 269, origin 1) | 1.80 / 3.90 / 8.10 | 8 ms à 8.9 s (reconstruction) |
| throttled-x4 | 1.59 / 2.89 / 9.55 | 1.55 / 2.14 | 0.70 / 8.20 / 29.50 | 10.4 / 11.1 / 135.8 | 398 (stale 2, fold 20, reveal 4, rect 244, origin 1) | 7.90 / 12.90 / 29.50 | 30 ms à 15.8 s (reconstruction) |
| secours | 1.49 / 3.20 / 10.68 | 1.48 / 2.13 | 0.20 / 1.60 / 8.10 | 10.3 / 10.9 / 52.7 | 297 (stale 2, fold 20, reveal 4, rect 270, origin 1) | 1.80 / 3.80 / 8.10 | 8 ms à 8.9 s (reconstruction) |
| vide | 0.25 / 0.45 / 3.24 | 0.25 / 0.45 | 0.20 / 0.30 / 0.40 | 10.4 / 10.8 / 13.2 | 0 (stale 1) | — / — / — | 0 ms à 2.3 s |

## Phases du chargement (ms depuis le démarrage du processus principal)

| Passe | base ouverte | données envoyées | données reçues | état prêt | scène prête | moteur prêt | première image |
|---|---|---|---|---|---|---|---|
| vsync | 128 | 398 | 515 | 829 | 1683 | 972 | 1817 |
| plancher | 130 | 407 | 543 | 836 | 1689 | 983 | 1816 |
| throttled-x4 | 514 | 850 | 1274 | 2362 | 6427 | 2696 | 7158 |
| secours | 128 | 7187 | 7301 | 7958 | 9010 | 8124 | 9249 |
| vide | 144 | 329 | 330 | 333 | 610 | 606 | 620 |

## Mémoire (Mo, après deux ramasse-miettes)

| Passe | Tas JS de l'interface | Principal (Browser, privée) | Interface (Tab, privée) | Carte (GPU, privée) |
|---|---|---|---|---|
| vsync, après chargement | 251 | 42 | 335 | 169 |
| vsync, après éditions | 304 | 41 | 519 | 213 |
| plancher | 250 | 39 | 334 | 164 |
| throttled-x4 | 251 | 39 | 342 | 171 |
| secours | 251 | 113 | 335 | 171 |
| vide | 4 | 38 | 42 | 229 |

Le tas JS est `performance.memory.usedJSHeapSize` (mémoire précise) après deux `gc()` dans l'interface ; la mémoire privée vient de `app.getAppMetrics()`, le principal ayant aussi forcé ses collections. Relevés en fin de passe ; pour la passe d'édition, aussi avant elle (« après chargement » : le chargement et le parcours de 40 s faits, avant la première édition).

## Édition (fin de la passe vsync)

Sur « Nœud 44 ∑ », le nœud le plus proche du centre de la caméra profonde. Latence : de l'appel (session, annulation, dépôt) à la fin du rendu de la première image de la nouvelle scène.

| Étape | ms |
|---|---|
| Glissement de 300 px en 60 images : fil principal par image d'aperçu, p50 / p95 / max (60 images) | 113.5 / 167.2 / 204.2 |
| Dépôt | 250 |
| Renommage | 16 |
| Création d'un nœud au centre | 41 |
| Connexion des deux | 16 |
| Ctrl+Z n° 1 | 21 |
| Ctrl+Z n° 2 | 10 |
| Ctrl+Z n° 3 | 52 |
| Onglet d'un plan neuf (scène construite) | 18 |
| Retour à l'onglet du lobby (scène gardée) | 15 |

## Critères (spec 21)

- **Carte graphique :** 2.73 ms au p95 sur toutes les images, pour un critère de 2 ms : **non tenu**. Hors reconstructions : 2.38 ms ; contenu seul : 2.36 ms : **non tenu**.
- **Processeur sous ×4 :** 8.20 ms au p95, pour un critère de 16 ms : **tenu**.
