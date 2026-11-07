# Registre du plan 4c : annotations de PDF et import de publications — mesures, décisions, écarts

Plan : `docs/superpowers/plans/2026-11-05-cirrus-annotations-publications.md`, approuvé par l'utilisateur le 2026-11-07 (e4d957f, départ du plan). Spec : `2026-11-02-cirrus-design.md`, sections 5.2, 5.4, 6.5, 10, 12 et 18. Une décision que le plan ne fixe pas se consigne ici sous la forme `Ruling:` : ses options, le choix, pourquoi, et son coût s'il est faux.

## Tâche 1 : socle — champ `anchor`, commande d'annotation, base de test

### Fait

- **Modèle** (`model.ts`) : `Anchor { pdf, file, hash, page, rects, text }` et `NodeRec.anchor?`. Les rectangles `[x0, y0, x1, y1]`, un par ligne, sont dans les coordonnées PDF de la page : des points, l'axe y vers le haut, comme le `/Rect` d'un lien.
- **`annotation.ts`**, nouveau :
  - `validAnchor` vérifie les bornes. Le PDF et le nom de fichier ne sont pas vides. L'empreinte compte 64 chiffres hexadécimaux. La page est un entier ≥ 1. Il y a de 1 à 500 rectangles de quatre nombres finis (`ANCHOR_MAX_RECTS`), et au plus 20 000 caractères de texte (`ANCHOR_MAX_TEXT`).
  - `annotationTitle(text, max)` met le passage sur une ligne et garde ses `max` premiers caractères, puis « … ».
  - `ANNOTATION_TITLE_CHARS = 80` sera la valeur par défaut du réglage `annotationTitleChars` (tâche 2).
- **`createAnnotation(s, a, title)`** (`commands.ts`) crée un nœud sans placement, avec sa propre copie de l'ancre, au libellé « Annoter « <titre> », p. <n> ». Elle refuse, par une `CommandError` en français :
  - une ancre hors de ses bornes : « Ce passage ne peut pas être annoté. » ;
  - un PDF absent : « Le PDF à annoter n’existe pas. » ;
  - un PDF à la corbeille : « Le PDF à annoter est à la corbeille. »
- **Contrôle des enregistrements** (`state.ts`, `checkNode`) : un nœud dont l'ancre est hors de ses bornes est refusé avant toute écriture (`invalid node anchor`). Le refus vaut à `applyOp`, au retour arrière, au chargement en bloc et dans `LocalStore.commit`, par `checkRecord`.
- **Instantané** (`codec.ts`) : un nœud avec `anchor` passe par le chemin JSON (`IRREGULAR`), sans changer le format ; `SNAPSHOT_VERSION` reste 1. Au décodage, une ancre invalide lève `SnapshotError`, et l'interface relit alors l'état depuis les tables (`loadPayload(store, true)`).
- **`index.ts`** exporte `annotation.ts`.
- **Magasin :** aucun changement. Le nœud s'écrit en JSON tel quel, et `commit` passe déjà par `checkRecord`.
- **Base de test** (`fixtures/src/build.ts`, `pdf.ts`) :
  - les tags `doi` et `arxiv` (texte, nœud, une valeur) entrent au registre après `date_de_publication` ;
  - `chapterPdf({ earlier: true })` écrit la version précédente du chapitre : la troisième ligne du paragraphe de sa page 1 dit autre chose. Elle entre au magasin par `storeBytes`, sous le nom `Li_Vitányi_chapitre_1.pdf`, à l'action qui joignait déjà les deux PDF de la publication ;
  - après toutes les autres actions :
    1. une annotation de la page 1 sur cette version ;
    2. la réimportation du fichier courant (« Remplacer « Li_Vitányi_chapitre_1.pdf » », comme `filesBuild`) : il garde son nom et sa place, et prend la nouvelle empreinte ; l'ancien blob reste au magasin ;
    3. une annotation de la page 1 et une de la page 2 sur la version courante ;
    4. le plan « Lecture », où la publication (cran 1, en 0, 0) et l'annotation de la page 1 (cran 0, en 0, 0) sont posées. L'annotation y est incluse dans la publication, qui y devient un groupe.
  - `FixtureIds` gagne `plans.lecture` et `nodes.annotationPage1`, `annotationPage2` et `annotationEarlier` ;
  - `passage(page, from, to)` (`pdf.ts`) rend le passage comme une sélection le donne : les lignes jointes par un saut de ligne, et un rectangle par ligne, calculé avec les largeurs Helvetica.

### Mesures

- **Largeurs Helvetica contre pdf.js** (pdfjs-dist 6.5.438, `getTextContent`), par un script jetable :
  - 42 lignes régulières des deux versions du chapitre, dont tous les paragraphes, ont, à 0,01 pt près, la largeur et l'abscisse que pdf.js leur donne. Restent hors de la comparaison les numéros de page, que le script a cherchés dans une autre ligne, et les deux lignes du sommaire, que pdf.js découpe en plusieurs morceaux ;
  - 110 caractères de la table, chacun sur sa ligne, ont la largeur de pdf.js. L'espace, que pdf.js sépare, est vérifiée par les paragraphes.
  - Les surlignages de la tâche 2 tomberont donc sur les glyphes dessinés.
- **Les ancres de la base de test** :
  - p. 1 : `[[309.42, 581, 500.172, 594.8], [72, 565, 499.536, 578.8]]` ;
  - p. 2 : `[[176.064, 711, 470.208, 724.8], [72, 695, 261.42, 708.8]]` ;
  - version précédente, p. 1 : `[[309.42, 581, 500.172, 594.8], [72, 565, 382.812, 578.8]]`.
- **La base de test** compte 91 actions et 213 lignes de journal.

### Décisions

Fixées par le contrôleur avant la tâche :
- l'« index » du titre de la tâche, ce sont les exports de `index.ts`. L'`AnnotationIndex` dérivé de l'interface est pour la tâche 2 ;
- une ancre invalide dans l'instantané l'envoie au chemin de secours, au lieu d'entrer en silence dans l'état ;
- la cohérence de `anchor.pdf` n'est contrôlée qu'à la création. Le PDF peut ensuite aller à la corbeille, ou son fichier être remplacé, et l'annotation reste valide (Review Focus 4, tâches 2 et 3) ;
- la troisième annotation porte sur une version précédente que la base de test stocke, annote, puis remplace comme le fait une réimportation ;
- les actions nouvelles de la base de test viennent après toutes les autres (dates de l'historique dans les captures) ;
- les tags `doi` et `arxiv` vont au registre près de `auteur` et `date_de_publication`.

- Ruling: **la forme de l'ancre se vérifie au contrôle des enregistrements** (`checkNode`, donc `checkRecord`), et non comme une règle de `invariants.ts`. Le contrôleur avait demandé une règle.
  - Options :
    - une violation de `checkState` ;
    - le contrôle des enregistrements (choix) ;
    - les deux.
  - Pourquoi : `checkState` ne sert qu'aux commandes. Le journal rejoué, une action reçue d'un autre PC (plan 5) et `LocalStore.commit` passent, eux, par `checkRecord`. Avec une simple règle, une ancre invalide entrerait en base. L'instantané la refuserait, et le chemin de secours réencoderait les mêmes tables : la base ne se rouvrirait plus. Le contrôle des enregistrements la refuse partout avant toute écriture, et une règle de plus ne pourrait jamais se déclencher. `createAnnotation` vérifie d'abord l'ancre, avec un message en français. Une annotation reste, pour les règles, un nœud comme un autre (testé : renommée, résumée, posée, incluse, son PDF à la corbeille).
  - Coût si faux : une ligne dans `checkState`, et sa copie dans l'oracle des règles.
- Ruling: **l'empreinte s'écrit en minuscules**, comme le magasin nomme ses fichiers (`digest('hex')`). La même en majuscules ne désignerait pas le même `FileRef.hash`.
  - Coût si faux : un drapeau `i` dans `validAnchor`.
- Ruling: **le PDF et le nom de fichier d'une ancre ne sont pas vides.** Un identifiant n'est jamais vide, et `checkFileName` refuse un nom vide.
  - Coût si faux : nul.
- Ruling: **`ANNOTATION_TITLE_CHARS = 80` est une constante du cœur**, que le réglage `annotationTitleChars` de la tâche 2 prendra pour valeur par défaut. La base de test l'utilise.
  - `annotationTitle` met les blancs d'une sélection (sauts de ligne, tabulations) en une espace, compte en caractères et non en unités UTF-16, et retire l'espace avant « … ». Le titre seul est « 80 caractères, puis … », comme le dit D1.
  - Coût si faux : nul.
- Ruling: **`createAnnotation` garde sa propre copie de l'ancre, et ses seuls champs connus.** Un tableau de rectangles changé ensuite par l'appelant ne change pas l'enregistrement, et un champ de plus ne s'écrit pas.
  - Coût si faux : nul.
- Ruling: **la version précédente du chapitre entre par l'action qui joignait déjà les PDF**, au lieu de trois actions nouvelles en fin de construction (remettre l'ancienne, l'annoter, réimporter).
  - Pourquoi : l'historique reste vraisemblable, avec une version d'abord, puis sa réimportation. Le nombre et l'ordre des actions d'avant ne changent pas, ni donc leurs dates dans les captures. Le fichier final est celui de `assets/`, comme le vérifie le test du plan 4a.
  - Coût si faux : deux actions de plus, en fin de construction.
- Ruling: **les rectangles de la base de test viennent des largeurs Helvetica** (`pdf.ts`), vérifiées contre pdf.js (plus haut). Ils ne viennent pas de l'estimation des liens, une demi-taille par caractère, qui dérive de plusieurs points en fin de ligne.
  - La hauteur est celle des zones des liens : de 0,25 sous la ligne de base à 0,9 au-dessus.
  - Le texte d'un passage joint ses lignes par un saut de ligne, comme le texte d'une sélection dans la couche de texte de pdf.js. La tâche 2 le confirmera sur une vraie sélection.
  - Coût si faux : trois rectangles dans la base de test.
- Ruling: **les tags `doi` et `arxiv` font sortir `clé_bibtex` et `label` des huit premières suggestions d'un champ vide.** Le test des suggestions (`panels.test.ts`) en demande désormais dix, et compte toutes les clés des nœuds, dans l'ordre du registre.
  - Coût si faux : l'ordre de quatre suggestions.
- Ruling: **`popup-vignettes` refaite dans `plan4a`.**
  - Elle différait de 1 178 pixels (0,077 %, sous la tolérance). Les deux images ont été comparées à l'œil : trois lignes des métadonnées de la publication changent, et rien d'autre.
    - « Modifié le » passe de 10 h 28 à 11 h 29 : la réimportation et la pose dans « Lecture » sont les deux dernières actions sur la publication ;
    - « Historique » passe de 2 à 4 modifications, pour la même raison ;
    - « Plans » montre « Lobby » et « Lecture ».
  - « Créé le », les tags et les vignettes ne changent pas.
  - Le changement est inévitable : la tâche veut une réimportation et la publication posée dans « Lecture ». Les nouvelles actions viennent toutes après les autres, et aucune autre date ne bouge.
  - L'image vient de la première suite neuve, copiée seule dans `plan4a`, comme au plan 4b. Les autres images des trois références ne sont pas touchées.
  - Coût si faux : nul.

### Vérifications

- **Tests écrits d'abord** (rouge, pour la raison attendue) :
  - `core/tests/annotation.test.ts` ne se chargeait pas : `annotation.ts` n'existait pas ;
  - dans `codec.test.ts`, une ancre invalide se décodait sans `SnapshotError` ;
  - dans `localStore.test.ts`, `createAnnotation` n'existait pas ;
  - dans `fixtures/tests/build.test.ts`, la base de test n'avait pas d'annotations.
- **Suites :**
  - après l'implémentation : `core` 107 tests, `store` 20, `fixtures` 13 et `view` 243, tous passés. Dans `app`, 344 sur 345 passaient : seul le test des suggestions de tags échouait (Ruling plus haut). Corrigé, il passe (`panels.test.ts`, 15 sur 15) ;
  - `fixtures` relancé seul après le dernier changement de `pdf.ts` : 13 sur 13 ;
  - une seconde suite complète a été arrêtée par Claude Code, faute de mémoire sur la machine, avant la fin de `core`. Elle n'a pas été relancée. Les sources de `core`, `store` et `view` n'ont pas changé depuis la première ;
  - `tsc --noEmit -p .` : sans erreur dans `core`, `store`, `fixtures`, `view` et `app`.
- **Captures :**
  - première suite neuve, 24 images :
    - contre `reference-3c` : 11 sur 11 à 0 pixel ;
    - contre `plan4a` : 7 sur 8 à 0 pixel. `popup-vignettes` différait de 1 178 pixels, et a été refaite (Ruling plus haut) ;
    - contre `plan4b` : 5 sur 5 à 0 pixel ;
  - deuxième suite : elle a échoué en cours de route, avec 19 images et sans les scènes LaTeX. Les résumés n'y étaient pas compilés, et le pop-up de la publication y montrait l'état d'avant les dernières actions de la base de test. Le code n'avait pas changé depuis la première suite, et son journal, coupé, n'a pas été gardé.
    - La base de test, construite trois fois à la main, sort chaque fois entière : 91 actions, 213 lignes, code de sortie 0.
    - Cause probable, non établie : le manque de mémoire de la machine, qui a fait arrêter la suite de tests plus tard.
  - troisième suite : 24 sur 24, à 0 pixel contre `reference-3c`, `plan4a` mise à jour et `plan4b`. Elle est aussi identique au pixel à la première.
- **Scénarios d'interface** (`npm run interface`) : aucun d'ajouté. La tâche ne touche ni l'interface ni le principal, et rien n'y est à vérifier dans l'app construite.

### Notes

- Le cas limite des enregistrements irréguliers de `codec.test.ts` (`oddities`) compte désormais une annotation, avec un `\0` et un surrogat seul dans son texte. Elle fait l'aller-retour contre l'oracle.
- L'oracle des règles (`tests/oracle/invariants.ts`) n'a pas changé : aucune règle n'est nouvelle.
