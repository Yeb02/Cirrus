# Banc de rendu de l'application (2026-11-02)

Base synthétique : 50000 nœuds, 500000 connexions (générateur du plan 1). Parcours : vue d'ensemble, descente à travers tous les niveaux de groupes, déplacement de trois écrans, retour (40 s). Première seconde écartée.

| Passe | Carte graphique (ms) p50 / p95 / max | Carte hors reconstructions (ms) p50 / p95 | Processeur (ms) p50 / p95 / max | Intervalle (ms) p50 / p95 | Reconstructions (causes) | Pire image | Chargement | Mémoire JS |
|---|---|---|---|---|---|---|---|---|
| vsync | 2.74 / 7.76 / 38.31 | 2.62 / 4.20 | 0.50 / 2.00 / 12 | 10.60 / 11.80 | 102 (stale 1, fold 20, zoomIn 5, rect 77) | 12 ms à 4.5 s (reconstruction) | 9.2 s | 521 Mo |
| throttled-x4 | 2.74 / 7.99 / 27.41 | 2.69 / 4.52 | 1.70 / 8.20 / 36 | 10.60 / 11.50 | 43 (stale 1, fold 17, zoomIn 5, rect 22) | 36 ms à 5.9 s (reconstruction) | 39.5 s | 1440 Mo |

Carte : ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU (0x00002860) Direct3D11 vs_5_0 ps_5_0, D3D11) ; canevas 2561×1544 px.

## Critères (spec 21)

- **Carte graphique :** 7.76 ms au p95 sur toutes les images, pour un critère de 2 ms : **non tenu**. Hors reconstructions (le dessin seul) : 4.20 ms : **non tenu**. Le chronomètre de la carte compte aussi l'attente entre deux envois du processeur : une reconstruction (envoi des tampons) le gonfle.
- **Processeur sous ×4 :** 8.20 ms au p95, pour un critère de 16 ms : **tenu**.
