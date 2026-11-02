# Banc de rendu — 2026-11-02

**Verdict : RÉUSSI**

- Carte graphique : p95 du temps GPU mesuré (passe vsync) = 1.72 ms (critère ≤ 2 ms) → tenu ; pire image 42.4 ms.
- Processeur : p95 du temps par image sous ×4 = 4.30 ms (critère ≤ 16 ms) → tenu ; pire image 1056 ms.
- Avec synchronisation : cadence plafonnée à 100 Hz (médiane 10.00 ms), celle d'un autre écran : la cible de 165 Hz n'a pas pu être observée (informatif).

## Passes

| Passe | Carte graphique | Rendu | Écran | Reconstructions | Sommets de rubans (max) | Chargement (ms) | Mémoire JS (Mo) |
|---|---|---|---|---|---|---|---|
| throttled-x4 | ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU (0x00002860) Direct3D11 vs_5_0 ps_5_0, D3D11) | 2561×1601 | 2561x1601 @165 Hz (interne) | 135 | 198264 | 401 | 116 |
| vsync | ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU (0x00002860) Direct3D11 vs_5_0 ps_5_0, D3D11) | 2561×1601 | 2561x1601 @165 Hz (interne) | 172 | 198264 | 408 | 116 |

## Intervalle entre images (ms)

| Passe | p50 | p95 | max | images |
|---|---|---|---|---|
| throttled-x4 | 10.00 | 10.20 | 1060.00 | 3129 |
| vsync | 10.00 | 10.10 | 1100.00 | 3790 |

## Intervalle hors reconstructions (ms)

| Passe | p50 | p95 | max | images |
|---|---|---|---|---|
| throttled-x4 | 10.00 | 10.10 | 20.00 | 2895 |
| vsync | 10.00 | 10.10 | 1100.00 | 3467 |

## Temps GPU par image, mesuré (ms)

| Passe | p50 | p95 | max | images |
|---|---|---|---|---|
| throttled-x4 | 0.27 | 0.99 | 232.30 | 3129 |
| vsync | 0.31 | 1.72 | 42.36 | 3790 |

## Temps processeur par image (ms)

| Passe | p50 | p95 | max | images |
|---|---|---|---|---|
| throttled-x4 | 1.20 | 4.30 | 1056.10 | 3129 |
| vsync | 0.40 | 5.90 | 126.60 | 3790 |

## Pires images

- **throttled-x4** — Pire image à t = 7.2 s : intervalle 1060 ms, processeur 56 ms, reconstruction.
  Pire reconstruction : t 6, totalMs 1056, renderMs 741, ribbonsOnly 1, ribbonMs 309, ribbonVertices 198264.
- **vsync** — Pire image à t = 1.1 s : intervalle 1100 ms, processeur 2 ms.
  Pire reconstruction : t 4, totalMs 111, renderMs 6, ribbonsOnly 1, ribbonMs 103, ribbonVertices 196646.
