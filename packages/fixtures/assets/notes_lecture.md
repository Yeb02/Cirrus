# Notes de lecture : le principe MDL

Lu dans *An Introduction to Kolmogorov Complexity and Its Applications* (Li et Vitányi, 2008), chapitre 5.

- Le MDL en deux parties : longueur du modèle, plus longueur des données encodées à l’aide du modèle.
- Lien avec la priore universelle : −log m(x) = K(x) + O(1).
- À relire : la version « raffinée » de Rissanen et la complexité stochastique.

## Questions

1. Le choix du code préfixe change-t-il le modèle retenu ?
2. Que retient le principe sur une séquence aléatoire ? Voir `calcul_mdl_séquence_aléatoire.py`.
3. Quel rapport avec les taux de `mesures_compression.csv` ?
