# Registre du plan 4b : la chaîne LaTeX — mesures, décisions, écarts

Plan : `docs/superpowers/plans/2026-11-05-cirrus-latex.md`. Départ : 533fc69. Une décision que le plan ne fixe pas se consigne ici sous la forme `Ruling:` : ses options, le choix, pourquoi, et son coût s'il est faux.

## Tâche 1 : socle — préambule global, module LaTeX partagé, base de test

### Mesures

- **`titleToTex` sous pdfLaTeX** (TinyTeX du banc, pdfTeX 1.40.29, `DEFAULT_PREAMBLE`, `-no-shell-escape -interaction=nonstopmode`, `openin_any=p`, `openout_any=p`, `shell_escape=f`) : un document d'une ligne par caractère, chacune passée par `titleToTex`. Les caractères essayés sont tous ceux de U+0020 à U+017F, la ponctuation gardée, toute la table mathématique, `中` et `😀`, plus les titres du Review Focus 1.
  - Gardés tels quels, trois sortes de caractères arrêtent la compilation :
    - DEL (U+007F) : « Text line contains an invalid character » ;
    - les contrôles C1 (U+0080 à U+009F) : « Unicode character … not set up for use with LaTeX » ;
    - neuf lettres du latin étendu A, `Ħ ħ ĸ Ŀ ŀ ŉ Ŧ ŧ ſ` : la même erreur.
  - Une fois ces caractères rendus en « ? », le même document compile sous `-halt-on-error`, sans aucune erreur : 11 pages.
  - Le reste passe : tout le Latin-1 (U+00A0 à U+00FF), le reste du latin étendu A, `‘ ’ “ ” « » – — … ·`, les lettres grecques et les symboles en `\ensuremath`, `\mathbb` (amssymb).
- Suite : 126 tests sur 126 dans `core`, `store` et `fixtures`. Avant l'implémentation, 76 sur 84 passaient : trois fichiers ne se chargeaient pas, faute de `latex.ts`, et huit tests échouaient. Suite complète : 581 tests sur 581 (566 au départ du plan, 15 de plus). `tsc` : `core`, `store`, `view`, `fixtures` et `app` sans erreur.
- Captures, deux suites refaites de zéro, chacune dans un dossier neuf :
  - contre `reference-3c` : 11 sur 11 à 0 pixel ;
  - contre `plan4a` avant sa mise à jour : 7 sur 8 à 0 pixel. `popup-vignettes` diffère de 2 746 pixels (0,180 %, sous la tolérance) ; refaite (ci-dessous) ;
  - `plan4a` mise à jour : la seconde suite y est à 0 pixel sur 8 ;
  - d'une suite à l'autre, les 19 images sont identiques au pixel.

### Décisions

Fixées par le contrôleur avant la tâche :
- dans `titleToTex`, l'espace reste une espace, et `’` (U+2019) est gardé ;
- les majuscules grecques qui ont une commande la prennent ; ε, φ et ς deviennent `\epsilon`, `\phi` et `\varsigma` ;
- `setPreamble` refuse un texte égal à `preambleText(s)`. Une base sans préambule refuse donc `DEFAULT_PREAMBLE`.

- Ruling: **`titleToTex` rend « ? » pour DEL, les contrôles C1 (U+007F à U+009F) et `Ħ ħ ĸ Ŀ ŀ ŉ Ŧ ŧ ſ`**, bien que la tâche garde tels quels les caractères de U+0020 à U+017F.
  - Options :
    - la plage entière, comme écrit ;
    - ces caractères en « ? » (choix) ;
    - une approximation de chacun (`H`, `\hbar`, `L·`, `'n`, `s`…).
  - Pourquoi : chacun arrête pdfLaTeX (mesuré ci-dessus). Or la tâche veut une source « inerte », et le Review Focus 1 une compilation qui ne casse pas. « ? » est le repli que la tâche donne déjà à tout caractère qu'elle ne sait pas rendre. Une approximation interpréterait le texte de l'utilisateur.
  - Coût si faux : une liste de neuf lettres et une borne, dans `latex.ts`.
- Ruling: **`¬` (U+00AC) et `±` (U+00B1) passent par la table, en `\ensuremath{\neg}` et `\ensuremath{\pm}`**, bien qu'ils soient aussi dans la plage gardée.
  - Pourquoi : la tâche les nomme dans la table. Une liste explicite l'emporte sur une plage. Les deux formes compilent.
  - Coût si faux : deux entrées de la table.
- Ruling: **les majuscules grecques sans commande deviennent la latine droite, `\ensuremath{\mathrm{A}}`**, et `ο` devient `\ensuremath{o}`.
  - Options : `\ensuremath{A}`, en italique ; `\ensuremath{\mathrm{A}}`, droite (choix).
  - Pourquoi : `\Gamma` et les autres capitales grecques de TeX sont droites en mode mathématique. Une capitale en italique jurerait à côté. Les minuscules grecques sont en italique, et `o` aussi.
  - Coût si faux : treize entrées de la table.
- Ruling: **la table compte aussi les variantes `ϑ ϕ ϖ ϱ ϵ`**, en `\vartheta`, `\phi`, `\varpi`, `\varrho` et `\epsilon`.
  - Pourquoi : la tâche dit « au moins ». `ϕ` et `ϵ` suivent la règle du contrôleur pour φ et ε.
  - Coût si faux : cinq entrées.
- Ruling: **`DEFAULT_PREAMBLE` finit par un saut de ligne** : ses huit lignes, chacune terminée par `\n`.
  - Options : sans le saut de ligne final ; avec (choix).
  - Pourquoi : c'est la forme des `.tex` de la base de test, et celle qu'un éditeur garde. Le préambule par défaut n'est jamais stocké : un changement d'avis ne touche aucune base.
  - Coût si faux : un caractère. Une base où l'utilisateur aurait remis le défaut garderait l'ancien texte, différent du nouveau défaut d'un saut de ligne.
- Ruling: **`safeLabel` compte les caractères en points de code** (`[...name].length`), après un refus rapide au-delà de 400 unités UTF-16.
  - Pourquoi : « 200 caractères ». Un label accentué ou à symboles n'est pas pénalisé par l'UTF-16.
  - Coût si faux : nul pour les labels réels.
- Ruling: **l'instantané garde sa version 1.** Le champ `preamble` de la partie JSON n'est écrit que si la base a un préambule.
  - Options :
    - passer à la version 2, qui refuserait tout instantané existant et ferait relire les tables au premier lancement ;
    - un champ facultatif, sans changer de version (choix).
  - Pourquoi : un instantané d'une base sans préambule reste celui d'avant le plan, octet pour octet. Un instantané d'avant le plan se décode avec `preamble: null`, ce qui est juste, puisque sa base n'en avait pas. Un préambule mal formé est refusé (`SnapshotError`, retour aux tables).
  - Coût si faux : une version à passer plus tard ; l'app relirait alors les tables une fois.
- Ruling: **l'enregistrement du préambule est vérifié comme ceux des nœuds et des connexions** (`checkRecord`) : un objet dont `text` est une chaîne.
  - Où : à `applyOp`, au chargement en bloc (`loadRecords`) et avant l'écriture en base (`LocalStore.commit`).
  - Pourquoi : `preambleText` doit rendre une chaîne, puisque TeX la reçoit telle quelle. Une opération sans « avant » ni « après » est refusée (`empty preamble operation`), comme pour les autres enregistrements.
  - Coût si faux : nul.
- Ruling: **base de test, l'image de Kolmogorov** : la tâche dit « les mêmes octets que celui de MDL ». Or `schéma_compression.png` est porté par « Compression sans perte », et non par MDL.
  - Choix : le même fichier de `assets/`. Kolmogorov reçoit donc la même empreinte que la copie de « Compression sans perte », et le magasin n'en garde qu'une.
  - Pourquoi : il n'y a qu'une image dans les ressources. L'intention, un `.tex` qui inclut une image de son propre nœud déjà présente dans le magasin, ne change pas.
  - Coût si faux : nul.
- Ruling: **base de test, les fichiers de Kolmogorov sont joints par la dernière action de la construction**, après l'annulation.
  - Pourquoi : les captures datent l'historique d'une action par minute, dans l'ordre (`fixHistoryTimes`). Une action insérée plus tôt décalerait d'une minute les dates des pop-ups de MDL et de la publication. Le résumé de l'entropie, la relation, les tags et les clés de tags passent par les actions qui existaient déjà.
  - Coût si faux : nul.
- Ruling: **base de test, la relation de « Déduction jointe » remplace l'ancienne** (« Ces trois nœuds ensemble… ») : une connexion n'a qu'une relation. Aucun test ni aucune capture ne lisait l'ancien texte.
  - Coût si faux : une ligne.
- Ruling: **`popup-vignettes` refaite dans `plan4a`.**
  - Elle différait de 2 746 pixels (0,180 %), et sa seule différence a été regardée : le pop-up de la publication montre le tag `clé_bibtex : li2008` après `date_de_publication : 2008`.
  - Les dates du pop-up ne changent pas : les fichiers de Kolmogorov sont joints en dernier (plus haut).
  - L'image vient d'une suite neuve, copiée dans `plan4a`, comme au plan 4a pour `popup-noeud`. `captures.mjs --replace` sur `plan4a` y aurait écrit aussi les onze scènes de `reference-3c`. Les sept autres images de `plan4a` et celles de `reference-3c` ne sont pas touchées.
  - Coût si faux : nul.
- Ruling: **les tags `clé_bibtex` et `label` s'insèrent au registre après `date_de_publication`**, avec les autres clés des nœuds.
  - Pourquoi : les suggestions de tags d'un nœud suivent l'ordre du registre. Les deux clés y viennent après les clés existantes, et le test des suggestions (`panels.test.ts`) les compte désormais.
  - Coût si faux : l'ordre de deux suggestions.

### Notes

- `Snapshot.preamble` est obligatoire, comme le fixe la tâche. Les quatre aides de test qui triaient chaque champ de `toSnapshot` comme une liste comparent désormais aussi le préambule : `localStore`, `benchBase`, `bench` et `load` (`Array.isArray(v) ? … : canonical(v)`). L'oracle de `columns.test.ts`, d'avant le plan 4b, reçoit `preamble: null`.
- Le test de migration du schéma 1 au schéma 2 retire aussi la table `preamble`, puisque la migration 3 la recrée. Une migration livrée n'a pas été touchée.

## Tâche 2 : principal — TinyTeX : emplacement, installation épinglée, paquets

## Tâche 3 : principal — compilation préchauffée, cloisonnée, en cache

## Tâche 4 : interface — registre des labels et des citations, requêtes, compilation à la pause

## Tâche 5 : interface — éditeur LaTeX, plein écran d'un `.tex`, enregistrement

## Tâche 6 : interface — résumé et relation compilés, liens `cirrus:`

## Tâche 7 : préambule, installation de LaTeX, paquets manquants

## Tâche 8 : mesures, captures, spec

## Mesures du plan 4b

| Mesure | Tâche | Valeur | Conditions |
| --- | --- | --- | --- |

## Mineurs reportés

Chaque ligne `minor (deferred)` du suivi du plan, dans l'ordre des tâches, avec ses fichiers et ses lignes.

### Tâche 1

- Pour la tâche 3 (Review Focus 1 : « l'aperçu montre le texte tel qu'il est écrit ») : `titleToTex` garde tels quels les caractères de la plage. Deux cas affichent pourtant autre chose que le texte tapé :
  - sous T1, les ligatures de TeX changent un titre : `--` et `---` deviennent des tirets ; deux apostrophes, ou deux accents graves, des guillemets ; `<<` et `>>` des chevrons ; `,,` un guillemet bas ; un point d'exclamation ou d'interrogation suivi d'un accent grave, un signe renversé ;
  - sous un préambule sans T1 (OT1), `<`, `>` et `|` deviennent d'autres glyphes.

  Rien n'est exécuté, et la compilation ne casse pas. Briser les ligatures (`-{}`, `'{}`, `<{}`) changerait la sortie que la tâche 1 fixe (latex.ts, `titleToTex`).

## Décisions du contrôleur (plan 4b)

Chaque décision du contrôleur (`Ruling:`) du suivi de l'exécution, qui disparaîtra avec l'espace de travail, dans son ordre : décision — raison — coût si faux. Quand une décision est détaillée plus haut, sous sa tâche, la ligne le dit.

### Avant la tâche 1 (examen des tâches)

- Ruling P1: T2 exports the base package list as `BASE_PACKAGES` (the list provision installs); T7's withPackage reads it — cost if wrong: a rename.
- Ruling P2: T6 drops the « Titre court » relabel of the connection title (never asked, would change the frozen reference-3c capture fenetre-connexion) — cost if wrong: one label.
- Ruling P3: T6 keeps the relation's empty-field look as today (placeholder « Relation (LaTeX) », same box) so reference-3c fenetre-connexion stays within tolerance — cost if wrong: one placeholder text.
