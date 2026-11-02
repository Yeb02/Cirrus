# Banc de rendu — 2026-11-02

**Verdict : ÉCHOUÉ**

- Carte graphique : p95 de l'intervalle sans limite = 5.70 ms (critère ≤ 2 ms) → non tenu.
- Processeur : p95 du temps par image sous ×4 = 4.50 ms (critère ≤ 16 ms) → tenu.
- Avec synchronisation : p95 = 39.80 ms pour un budget de 6.06 ms à 165 Hz (informatif).

## Passes

| Passe | Carte graphique | Rendu | Écran | Reconstructions | Chargement (ms) | Mémoire JS (Mo) |
|---|---|---|---|---|---|---|
| uncapped | ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU (0x00002860) Direct3D11 vs_5_0 ps_5_0, D3D11) | 2561×1601 | 2561x1601 @165 Hz (interne) | 27 | 1854 | 3760 |
| throttled-x4 | ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU (0x00002860) Direct3D11 vs_5_0 ps_5_0, D3D11) | 2561×1601 | 2561x1601 @165 Hz (interne) | 8 | 1797 | 2060 |
| vsync | ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU (0x00002860) Direct3D11 vs_5_0 ps_5_0, D3D11) | 2561×1601 | 2561x1601 @165 Hz (interne) | 33 | 1812 | 3760 |

## Intervalle entre images (ms)

| Passe | p50 | p95 | max | images |
|---|---|---|---|---|
| uncapped | 0.30 | 5.70 | 7052.70 | 8213 |
| throttled-x4 | 2.20 | 6.40 | 11874.00 | 1519 |
| vsync | 10.00 | 39.80 | 2450.10 | 1086 |

## Temps processeur par image (ms)

| Passe | p50 | p95 | max | images |
|---|---|---|---|---|
| uncapped | 0.20 | 4.40 | 7058.10 | 8214 |
| throttled-x4 | 1.20 | 4.50 | 11871.40 | 1520 |
| vsync | 0.50 | 1.30 | 1911.40 | 1087 |
