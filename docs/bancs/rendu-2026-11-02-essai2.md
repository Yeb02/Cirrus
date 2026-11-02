# Banc de rendu — 2026-11-02

**Verdict : ÉCHOUÉ**

- Carte graphique : p95 de l'intervalle sans limite (hors reconstructions) = 5.90 ms (critère ≤ 2 ms) → non tenu.
- Toutes images comprises : p95 = 6.00 ms, maximum = 5908.4 ms.
- Processeur : p95 du temps par image sous ×4 = 2.50 ms (critère ≤ 16 ms) → tenu ; pire image 7428 ms.
- Avec synchronisation : p95 = 10.20 ms pour un budget de 6.06 ms à 165 Hz (informatif).

## Passes

| Passe | Carte graphique | Rendu | Écran | Reconstructions | Sommets de rubans (max) | Chargement (ms) | Mémoire JS (Mo) |
|---|---|---|---|---|---|---|---|
| uncapped | ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU (0x00002860) Direct3D11 vs_5_0 ps_5_0, D3D11) | 2561×1601 | 2561x1601 @165 Hz (interne) | 132 | 6689424 | 1123 | 1280 |
| throttled-x4 | ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU (0x00002860) Direct3D11 vs_5_0 ps_5_0, D3D11) | 2561×1601 | 2561x1601 @165 Hz (interne) | 102 | 3217598 | 1153 | 1000 |
| vsync | ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU (0x00002860) Direct3D11 vs_5_0 ps_5_0, D3D11) | 2561×1601 | 2561x1601 @165 Hz (interne) | 154 | 6225080 | 1128 | 1720 |

## Intervalle entre images (ms)

| Passe | p50 | p95 | max | images |
|---|---|---|---|---|
| uncapped | 0.30 | 6.00 | 5908.40 | 21840 |
| throttled-x4 | 1.90 | 4.10 | 7427.10 | 10754 |
| vsync | 10.00 | 10.20 | 1730.10 | 3304 |

## Intervalle hors reconstructions (ms)

| Passe | p50 | p95 | max | images |
|---|---|---|---|---|
| uncapped | 0.30 | 5.90 | 3135.80 | 21598 |
| throttled-x4 | 1.80 | 3.80 | 17.80 | 10583 |
| vsync | 10.00 | 10.20 | 1730.10 | 3021 |

## Temps processeur par image (ms)

| Passe | p50 | p95 | max | images |
|---|---|---|---|---|
| uncapped | 0.20 | 5.40 | 5898.10 | 21841 |
| throttled-x4 | 0.90 | 2.50 | 7428.20 | 10755 |
| vsync | 0.40 | 2.40 | 1535.80 | 3305 |
