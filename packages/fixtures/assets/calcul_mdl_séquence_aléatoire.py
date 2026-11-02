"""Longueur de description en deux parties d'une séquence binaire, sous un modèle de Bernoulli."""

import math
import random


def code_brut(n: int) -> float:
    """Sans modèle : un bit par symbole."""
    return float(n)


def code_bernoulli(sequence: list[int]) -> float:
    """L(M) + L(D | M) : le paramètre p à précision 1/sqrt(n), puis les données sous p."""
    n = len(sequence)
    k = sum(sequence)
    l_modele = 0.5 * math.log2(n)
    if k in (0, n):
        return l_modele
    p = k / n
    l_donnees = -(k * math.log2(p) + (n - k) * math.log2(1 - p))
    return l_modele + l_donnees


if __name__ == "__main__":
    random.seed(0)
    for p in (0.5, 0.9):
        seq = [1 if random.random() < p else 0 for _ in range(1000)]
        print(f"p = {p} : brut {code_brut(len(seq)):.0f} bits, Bernoulli {code_bernoulli(seq):.0f} bits")
