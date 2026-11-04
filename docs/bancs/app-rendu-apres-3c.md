# Banc de rendu de l'application : app-rendu-apres-3c (2026-11-04)

Base synthétique : 50000 nœuds, 500000 connexions de connaissance, graine 1 (générateur du plan 1, version 2 : identifiants de 36 caractères), lue sur disque dans une copie neuve à chaque passe, par son instantané binaire et la fin du journal (la passe `secours` exceptée). Parcours : vue d'ensemble, descente à travers tous les niveaux de groupes, déplacement de trois écrans, retour (40 s) ; première seconde écartée.

Passes : `vsync` ; `plancher`, toutes couches masquées (une image vide) ; `throttled-x4`, processeur ralenti quatre fois ; `secours`, la même base sans son instantané (chargement depuis les tables) ; `dense`, un plan de titres en grille au seuil de lisibilité, à la place du parcours ; `vide`, une base vide (le plancher d'Electron). Entre `dense` et `vide`, des réécritures de l'instantané sur une copie de la base, sans fenêtre.

Carte : ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU (0x00002860) Direct3D11 vs_5_0 ps_5_0, D3D11) ; canevas 2561×1544 px.

## Carte graphique, hors reconstructions (ms)

| | p50 | p95 |
|---|---|---|
| Brut (vsync) | 1.67 | 2.42 |
| Plancher (couches masquées) | 0.02 | 0.02 |
| **Contenu** (brut moins plancher) | **1.64** | **2.39** |

Le contenu soustrait les quantiles du plancher à ceux du brut : c'est le coût du dessin lui-même, sans le plancher du chronomètre.

## Passes

| Passe | Carte (ms) p50 / p95 / max | Carte hors reconstructions (ms) p50 / p95 | Processeur (ms) p50 / p95 / max | Intervalle (ms) p50 / p99 / max | Reconstructions (causes) | Processeur des images reconstruites (ms) p50 / p95 / max | Pire image |
|---|---|---|---|---|---|---|---|
| vsync | 1.67 / 2.47 / 6.92 | 1.67 / 2.42 | 0.20 / 1.60 / 8.60 | 10.0 / 10.2 / 40.0 | 302 (stale 1, fold 20, reveal 4, rect 275, origin 1) | 1.70 / 3.40 / 8.60 | 9 ms à 8.9 s (reconstruction) |
| plancher | 0.02 / 0.02 / 0.95 | 0.02 / 0.02 | 0.20 / 1.60 / 8.60 | 10.0 / 10.3 / 50.0 | 303 (stale 1, fold 20, reveal 4, rect 276, origin 1) | 1.70 / 3.50 / 8.60 | 9 ms à 15.8 s (reconstruction) |
| throttled-x4 | 1.64 / 2.35 / 6.86 | 1.52 / 2.23 | 0.70 / 5.00 / 26.30 | 10.0 / 10.2 / 120.0 | 348 (stale 1, fold 20, reveal 4, rect 273, origin 1) | 5.10 / 10.00 / 26.30 | 26 ms à 15.8 s (reconstruction) |
| secours | 1.34 / 2.92 / 15.65 | 1.16 / 2.10 | 0.20 / 1.60 / 9.50 | 10.0 / 10.2 / 50.0 | 303 (stale 1, fold 20, reveal 4, rect 275, origin 1) | 1.80 / 4.10 / 9.50 | 10 ms à 8.9 s (reconstruction) |
| dense | 1.25 / 2.45 / 7.29 | 1.25 / 2.49 | 0.20 / 0.90 / 9.40 | 10.0 / 10.2 / 19.9 | 17 (stale 2, rect 16) | 2.50 / 9.40 / 9.40 | 9 ms à 2.9 s (reconstruction) |
| vide | 0.21 / 0.29 / 2.16 | 0.21 / 0.29 | 0.20 / 0.30 / 0.40 | 10.0 / 10.3 / 10.5 | 0 (stale 1) | — / — / — | 0 ms à 4.2 s |

## Phases du chargement (ms depuis le démarrage du processus principal)

| Passe | base ouverte | données envoyées | données reçues | état prêt | scène prête | moteur prêt | première image |
|---|---|---|---|---|---|---|---|
| vsync | 385 | 694 | 826 | 1196 | 2046 | 1357 | 2183 |
| plancher | 137 | 403 | 549 | 891 | 1708 | 1041 | 1852 |
| throttled-x4 | 136 | 417 | 958 | 1922 | 5860 | 2294 | 6545 |
| secours | 138 | 7266 | 7467 | 8379 | 9375 | 8578 | 9592 |
| dense | 298 | 592 | 708 | 1033 | 2001 | 1229 | 2187 |
| vide | 139 | 316 | 316 | 318 | 701 | 695 | 734 |

## Mémoire (Mo, après deux ramasse-miettes)

| Passe | Tas JS de l'interface | Principal (Browser, privée) | Interface (Tab, privée) | Carte (GPU, privée) |
|---|---|---|---|---|
| vsync, après chargement | 254 | 38 | 339 | 171 |
| vsync, après éditions | 368 | 38 | 541 | 238 |
| plancher | 254 | 41 | 339 | 166 |
| throttled-x4 | 254 | 39 | 333 | 172 |
| secours | 254 | 116 | 343 | 172 |
| dense | 275 | 43 | 439 | 173 |
| vide | 4 | 38 | 42 | 246 |

Le tas JS est `performance.memory.usedJSHeapSize` (mémoire précise) après deux `gc()` dans l'interface ; la mémoire privée vient de `app.getAppMetrics()`, le principal ayant aussi forcé ses collections. Relevés en fin de passe ; pour la passe d'édition, aussi avant elle (« après chargement » : le chargement et le parcours de 40 s faits, avant la première édition).

## Édition (fin de la passe vsync)

Sur « Nœud 44 ∑ », le nœud le plus proche du centre de la caméra profonde. Latence : de l'appel (session, annulation, dépôt) à la fin du rendu de la première image de la nouvelle scène.

| Étape | ms |
|---|---|
| Glissement de 300 px en 60 images : fil principal par image d'aperçu, p50 / p95 / max (60 images) | 1.6 / 2.3 / 5.7 |
| Octets envoyés par image d'aperçu, p50 / p95 / max (dont la texture des éléments : 16384 / 16384 / 16384) | 120332 / 120332 / 120332 |
| Anneaux et marqueurs refaits par image d'aperçu (`updateMarkers`, `updateOutline`), ms p50 / p95 / max ; part de l'image p50 / p95 : 7 % / 17 % | 0.100 / 0.300 / 0.500 |
| Dépôt | 138 |
| Renommage | 14 |
| Création d'un nœud au centre | 29 |
| Connexion des deux | 9 |
| Ctrl+Z n° 1 | 11 |
| Ctrl+Z n° 2 | 10 |
| Ctrl+Z n° 3 | 10 |
| Dépôt dans un autre groupe (Alt, dans « Nœud 20 ») | 11 |
| Onglet d'un plan neuf (scène construite) | 18 |
| Retour à l'onglet du lobby (scène gardée) | 17 |
| Ouverture du lobby sans cache (scène et index construits) | 469 |

Octets envoyés par image d'aperçu, par maillage (p50 / max ; sur la taille du maillage entier à son dernier envoi complet) : arrow 65968 / 65968 sur 78508 ; curve 23296 / 23296 sur 28784 ; intruder 1280 / 1280 sur 800 ; marker 3360 / 3360 sur 2688 ; previewEnvelope 7960 / 7960 ; sky 104 / 104 sur 80 ; text 1980 / 1980 sur 8040.

## Vue dense au seuil de lisibilité (passe dense)

Un plan neuf où les 3102 nœuds (47 × 66) pris au lobby sont posés en grille, une boîte d'une ligne par cellule, sans connexion ; la caméra tenue au seuil de lisibilité des titres (zoom 0.375), déplacée d'un écran, rapprochée jusqu'aux titres entiers (zoom 0.500), ramenée (20 s, première seconde écartée).

| Mesure | Valeur |
|---|---|
| Glyphes construits au plus pour une image | 14175 glyphes, 1755 éléments visibles (à 9.5 s) |
| Processeur par image (ms), p50 / p95 / max | 0.20 / 0.90 / 9.40 |
| Processeur des images reconstruites (ms), p50 / p95 / max (16 images) | 2.50 / 9.40 / 9.40 |
| Carte, toutes images (ms), p50 / p95 / max | 1.25 / 2.45 / 7.29 |
| Carte hors reconstructions (ms), brut p50 / p95 ; contenu (brut moins plancher) p50 / p95 | 1.25 / 2.49 ; 1.22 / 2.46 |
| Intervalle entre images (ms), p50 / p99 / max | 10.0 / 10.2 / 19.9 |
| Reconstructions (causes) | 17 (stale 2, rect 16) |

## Réécritures de l'instantané (copie de la base du banc)

Sur une copie neuve de la base du banc, 5 fois : une action (un nœud du lobby déplacé) écrite par `LocalStore.commit`, puis l'instantané de l'état (61.0 Mo) encodé et réécrit (`writeSnapshot`), comme l'interface l'envoie au repos.

| Étape | Base (cirrus.db, Mo) | Journal WAL (Mo) |
|---|---|---|
| avant | 614.7 | 0.0 |
| ouverte | 614.7 | 0.0 |
| réécriture 1 | 614.7 | 0.0 |
| réécriture 2 | 675.7 | 61.5 |
| réécriture 3 | 675.7 | 61.5 |
| réécriture 4 | 675.7 | 61.5 |
| réécriture 5 | 675.7 | 61.5 |
| fermée | 675.7 | 0.0 |

Après la dernière réécriture : 14898 pages libres sur 164971 (pages de 4096 octets : 61.0 Mo libres). Encodage (ms) : 325, 198, 235, 387, 337 ; écriture (ms) : 133, 1313, 168, 155, 148.

## Critères (plan 3c, tâche 10)

| Critère | Cible | Mesure | Tenu |
|---|---|---|---|
| Chargement, du démarrage du principal à la première image, avec instantané | ≤ 1,5 s | 2183 ms | **non tenu** |
| Chemin de secours (sans instantané) | mesuré et rapporté | 9592 ms | tenu |
| Changement d’onglet vers un plan en cache | ≤ 50 ms | 17 ms | tenu |
| Ouverture du lobby sans cache | ≤ 500 ms | 469 ms | tenu |
| Chaque édition du script, jusqu’à l’image | ≤ 30 ms | 138 ms au pire (dépôt) | **non tenu** |
| Image de glissement, fil principal | ≤ 1 ms au p95 | 2.30 ms au p95 | **non tenu** |
| Reconstruction (visible et instances) | ≤ 4 ms au p95 sur le parcours | 3.40 ms au p95 | tenu |
| Carte graphique, contenu | ≤ 1 ms en médiane et ≤ 2 ms au p95 | 1.64 / 2.39 ms | **non tenu** |
| Processeur ×4 | ≤ 16 ms au p95 | 5.00 ms au p95 | tenu |
| Intervalle entre images | p99 ≤ 1,5 fois la médiane | p99 10.2 ms, 1.02 fois la médiane (10.0 ms) | tenu |
| Mémoire de l’interface, après ramasse-miettes | ≤ 150 Mo | 254 Mo | **non tenu** |
| Mémoire privée du principal | ≤ celle de la base vide + 50 Mo | 38 Mo (vide : 38 Mo) | tenu |

## Remarques (ajoutées à la lecture du rapport)

- **Machine :** au repos, sur secteur ; pendant les sept étapes, les autres processus prenaient 3,8 % des 16 processeurs logiques en moyenne et 12 % au plus (l'antivirus à chaque copie de la base, `system`, `dwm`). Base du banc reconstruite par le banc (14 s), 614,7 Mo.
- **Chargement :** la passe `vsync`, la première après la construction de la base, ouvre sa copie en 385 ms contre 137 ms aux suivantes ; 1 852 ms jusqu'à la première image à la passe `plancher`.
- **Dépôt :** première édition de la session ; les sept suivantes prennent de 9 à 29 ms. Sous Node, la première commande après le décodage paie ≈ 380 ms de tables construites à leur premier usage (registre du plan 3c, tâche 10).
- **Vue dense :** l'écran du banc fait ≈ 1 707 × 1 029 pixels CSS (rapport 1,5) : 1 755 éléments visibles et 14 175 glyphes au plus au seuil de lisibilité, avec les titres courts de la base synthétique.
- **Octets par maillage :** la taille d'un maillage entier compte ses tampons de sommets ou d'instances, sans les indices ; les marqueurs et les anneaux, refaits en entier à chaque image avec leurs indices, envoient donc plus que cette taille.
- Critères, leviers suivants et comparaison à la référence : registre du plan 3c, section « Tâche 10 ».
