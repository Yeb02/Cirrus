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

## Tâche 2 : lecteur PDF — surligner, dessiner, la marge, ouvrir à la page

### Fait

- **`files/annotations.ts`**, nouveau, sans pdf.js à l'exécution (App le charge dans le premier morceau de l'app) :
  - `AnnotationIndex.build(s, previous?)`, `of(pdf)` et `forVersion(pdf, hash)`. L'index range les annotations vivantes (une ancre, hors de la corbeille) par PDF, puis par empreinte. Chaque liste suit l'ordre des pages, puis va du haut de la page vers le bas, puis de gauche à droite, puis par identifiant. Une entrée porte le nœud tel qu'il était à la construction, son ancre, et les plans où il est posé, avec leur nom ;
  - la reconstruction repart de l'index précédent. Elle garde une entrée dont l'enregistrement et les plans n'ont pas changé, et une liste dont les entrées n'ont pas changé. Si rien n'a changé, elle rend l'index précédent lui-même, et React ne redessine rien ;
  - `ofFile(entries, file)` donne la liste de la marge : les annotations de ce fichier, par son empreinte ou, pour une autre version, par son nom ;
  - la géométrie :
    - `mergeLines` fusionne les rectangles de l'écran par ligne ;
    - `pdfRects` les ramène dans la page par `viewport.convertToPdfPoint`, au millième de point ;
    - `rectsOnScreen` fait le chemin inverse, par `convertToViewportPoint` ;
  - `selectionToAnchor(selection, pageOf, pdf, file)` parcourt la sélection, la coupe à la fin de sa première page et rend l'ancre ;
  - `anchorRefusal(a)` dit en français pourquoi un passage est trop long ;
  - `titleChars(n)` fait du réglage un entier ≥ 1 ;
  - `NODE_MIME = 'application/x-cirrus-node'`.
- **`ui/viewers/AnnotationLayer.tsx`** dessine les surlignages d'une page, plus le passage qui clignote. **`ui/viewers/AnnotationMargin.tsx`** est la marge (D4).
- **`PdfViewer`** prend trois nouveaux props :
  - `annotations` : les entrées de la version montrée. Chaque page dessinée reçoit les siennes, et elles seules ;
  - `annotate: { pdf, onAnnotate(a): boolean }` :
    - « Annoter » paraît au bord droit, sous la dernière ligne de la sélection ;
    - Ctrl+Maj+A fait de même, dans la vue ;
    - les pages lues (`PDFPageProxy`) sont tenues par index (`onPage` de `PdfPage`), pour donner la page et la fenêtre d'affichage (viewport) d'un élément de la sélection ;
  - `goto: { page, flash?, seq }` :
    - le passage est centré dans la vue, son début gardé visible quand il est plus large qu'elle, et il clignote ;
    - un `goto` donné avant la lecture du document attend la première mise en page.
- **`Viewer.tsx`** :
  - `AnnotationContext` : l'index, `onAnnotate`, `draggable`, et `reveal` (pour la tâche 3) ;
  - `AnnotatedPdf` met le lecteur et sa marge côte à côte. Une annotation d'une autre version ouvre cette version, sous une bannière « Version précédente de « … », réimporté depuis. » et son bouton « Revenir à la version actuelle ».
- **Raccordement :**
  - App construit l'index à chaque changement de l'état, depuis le précédent. Il le passe à `Panels`, puis à `FilePreview` (marge glissable), et à `FullScreen` (marge non glissable, D4) ;
  - `annotate` refuse un passage trop long par une notification. Sinon, il lance `createAnnotation` par la session, une action, avec le titre `annotationTitle(text, titleChars(annotationTitleChars))`.
- **Ctrl+Z en plein écran** : App note les pas faits dans le plein écran ouvert. Ctrl+Z et Ctrl+Y n'y agissent que si le pas à défaire ou à refaire en fait partie. Pour cela, `UndoStack` gagne `nextUndo` et `nextRedo` (cœur) et `EditSession` les relaie.
- **`read.ts`** : `blobSize(ref)` lit la taille d'une version que le magasin garde, par la longueur de la réponse de cirrus-file:. Le corps n'est pas lu.
- **Réglages** (`params.ts`), groupe « Annotations » de la rubrique « Fichiers », après « PDF » :
  - `annotationColor` (#ffd23f), réglage principal ;
  - `annotationOpacity` (0,35), `annotationFlashMs` (1200), `annotationTitleChars` (`ANNOTATION_TITLE_CHARS`, 80) et `annotationMarginPx` (240), réglages avancés.
- **`styles.css`** : la couche (multipliée avec la page), le clignotement, « Annoter », la marge et la bannière.
- **`scripts/interface.mjs`** :
  - outils nouveaux : un glisser à la souris (`drag`), une touche avec ses modificateurs (`press`), le rectangle d'un caractère (`charRect`), les options de lancement et les réglages d'un scénario ;
  - six scénarios nouveaux (Vérifications).
- **`scripts/captures.mjs`** : le commentaire de `plein-ecran-pdf` dit le nouveau zoom.

### Mesures

- **Une vraie sélection contre la base de test** (scénario « surligner dans l'aperçu ») : le même passage de la page 1, du premier caractère au dernier, glissé à la souris.
  - Le texte est identique, lignes jointes par `\n`, comme `getSelection().toString()`.
  - Les rectangles réels sont `[[308.966, 581.494, 499.913, 594.734], [71.983, 565.499, 499.496, 578.739]]`, ceux de la base de test `[[309.42, 581, 500.172, 594.8], [72, 565, 499.536, 578.8]]`. Ils sont à 0,45 pt au plus en x, et 0,5 pt en y.
  - L'écart en x vient de la couche de texte de pdf.js. Elle dessine une police du système, étirée à la largeur de chaque morceau : ses caractères tombent jusqu'à un demi-point des glyphes du canevas, sur lesquels tombent les rectangles de la base de test (largeurs Helvetica).
- **Alignement d'un surlignage sur son texte**, côtés gauche et droit, puis milieu en hauteur :
  - à 91 % : 0,54, 0,29 et 0,24 px ;
  - à 277 % : 1,79, 1,15 et 0,38 px.
  - Soit environ 0,48 pt à chaque zoom : l'écart précédent, et rien qui grandisse avec le zoom.
- **Coût de l'index**, sur 50 500 nœuds et 500 annotations (100 posées), médiane de 25 constructions, par un test jetable (`buildLargeState`, 50 000 nœuds) :
  - construction entière : 1,20 ms ;
  - reconstruction après un changement sans annotation : 1,10 ms ;
  - après le renommage d'une annotation : 1,23 ms.
  - L'essentiel est le parcours des nœuds.
- **Une sélection sur deux pages** (glissée de la page 1 à la page 2) : `toString()` donne « Écrire à l’auteur : auteur@example.org\n11.1 Notations ». L'ancre, coupée, garde « Écrire à l’auteur : auteur@example.org\n1 » : la dernière ligne, puis le numéro de page, dans l'ordre où la page dessine son texte. Elle a deux rectangles, tous deux sur la page 1.

### Décisions

Fixées par le contrôleur avant la tâche :
- `annotationTitleChars` vaut `ANNOTATION_TITLE_CHARS` par défaut, en entier ≥ 1 ;
- le groupe « Annotations » va dans « Fichiers », après « PDF » ; `annotationColor` est un réglage principal, les autres sont avancés ;
- une sélection vide ou faite de blancs n'offre pas « Annoter » ;
- une sélection trop longue est refusée par une notification, plutôt que coupée en silence ;
- Ctrl+Maj+A n'est ni pris par un autre raccourci, ni pris à un autre ;
- les vérifications « dans l'app construite » sont des scénarios de `interface.mjs`.

- Ruling: **l'index parcourt tous les nœuds à chaque changement de l'état**, comme le registre LaTeX du plan 4b, mais ne relit que les annotations changées.
  - Options :
    - le parcours, avec les entrées gardées (choix) ;
    - un index des nœuds ancrés dans le cœur, tenu par `applyOp`, qui ne parcourrait que les annotations ;
    - les opérations de la dernière action, qui manqueraient celles de deux actions rendues en une fois par React.
  - Pourquoi : 1,1 ms à 50 000 nœuds, par action et jamais par image, et sans toucher l'état du cœur.
  - Coût si faux : un ensemble `anchored` dans `Indices` (cœur), et une boucle sur lui.
- Ruling: **les lignes se fusionnent dans l'espace de l'écran.** Deux rectangles sont sur une ligne s'ils se recouvrent sur la moitié de la hauteur du plus bas, et qu'au plus une hauteur de ligne les sépare. Les mots et les morceaux s'y joignent, un exposant y entre, deux colonnes restent à part.
  - Ce n'est pas un réglage : c'est la définition d'une ligne, et non une constante de rendu.
  - On fusionne à l'écran parce qu'une ligne y est horizontale, même sur une page tournée d'un quart de tour. Un rectangle de l'écran reste un rectangle dans la page.
  - Coût si faux : deux réglages.
- Ruling: **les rectangles sont ceux des morceaux de texte sélectionnés**, chacun par une plage à lui, et pas `Range.getClientRects()`.
  - Celle-ci compte aussi les boîtes des éléments : la fin de contenu de pdf.js, qui couvre la page pendant une sélection, et les `<br>`.
  - Le parcours suit les liens des nœuds (`firstChild`, `nextSibling`, `parentNode`), sans `TreeWalker`. Un test peut ainsi lui donner un DOM en miniature.
  - Un morceau fait de blancs ne donne pas de rectangle.
  - Coût si faux : nul.
- Ruling: **le texte joint les morceaux de la première page, et met un saut de ligne à chaque `<br>`** (pdf.js en met un en fin de ligne). Les blancs des deux bouts sont retirés.
  - Sur le passage de la base de test, c'est mot pour mot `getSelection().toString()`, et le texte de `passage()` : Tâche 1 confirmée.
  - Coût si faux : nul.
- Ruling: **un passage trop long est refusé**, selon les bornes de `validAnchor` : 20 000 unités UTF-16, comme `text.length`, ou 500 lignes. La notification dit « Ce passage est trop long pour être annoté : 20 001 caractères, au plus 20 000. », ou « … 501 lignes, au plus 500. ». La sélection reste, pour qu'on la raccourcisse.
  - Coût si faux : couper au lieu de refuser, trois lignes.
- Ruling: **en plein écran, Ctrl+Z et Ctrl+Y défont et refont les seuls pas faits dans ce plein écran** (ses annotations). Ils restaient sans effet en plein écran (revue de la tâche 5 du plan 4a), pour ne pas changer le graphe caché dessous. Une annotation n'y change rien.
  - Options :
    - sans effet, l'annotation se défaisant une fois sorti du plein écran ;
    - les seuls pas du plein écran (choix) ;
    - tous les pas, ce qui changerait le graphe caché.
  - Le scénario le vérifie : une annotation faite dans l'aperçu, avant le plein écran, reste après deux Ctrl+Z en plein écran.
  - Coût si faux : trois lignes dans App.
- Ruling: **une annotation d'une autre version s'ouvre dans la même vue** (aperçu ou plein écran), sous une bannière qui ramène à la version actuelle, et non dans un nouveau panneau.
  - Sa taille est lue par `blobSize` : la longueur de la réponse de cirrus-file:, le corps lâché aussitôt. Le nœud n'a plus la `FileRef` de cette version, et pdf.js a besoin de la longueur.
  - Options :
    - un appel au principal pour la taille du blob (préchargement et principal) ;
    - une taille dans l'ancre (le format de la tâche 1) ;
    - la longueur de la réponse (choix).
  - Une version absente du magasin le dit à la place du lecteur : « Cette version de « … » est introuvable dans la base. »
  - Coût si faux : un appel au principal.
- Ruling: **la marge montre les annotations du fichier lu, et ne paraît que s'il en a.** Ce sont celles de son empreinte, ou d'une autre version sous son nom, et non toutes celles du nœud : un autre PDF du même nœud a son propre lecteur.
  - Elle est ouverte par défaut. Son repli se garde par fichier dans `ViewStates` (`annotations:<empreinte>`) : c'est un état de la vue, comme sa page, et non un réglage.
  - Elle prend au plus la moitié de la vue (CSS `max-width: 50%`), pour qu'un aperçu étroit garde son PDF.
  - Coût si faux : nul.
- Ruling: **la marge montre le début du passage** (D4, « son début ») en `annotationTitleChars` caractères. Le titre du nœud ne s'y voit que par l'info-bulle, s'il a été renommé.
  - Elle montre ensuite la page, les plans (ou « dans aucun plan »), et « sur une version précédente » pour une annotation faite sur une autre empreinte que le fichier du nœud.
  - Les annotations de la version montrée ont un liseré.
  - À page et place égales, l'ordre suit l'identifiant : la version précédente de la base de test passe d'abord.
  - Coût si faux : nul.
- Ruling: **« Annoter » paraît une fois l'appui terminé**, et non pendant le glisser, pour ne pas suivre le pointeur.
  - Ctrl+Maj+A, et le clic du bouton, relisent la sélection sur le moment : une touche juste après l'appui précède l'image qui l'aurait lue.
  - L'appui sur le bouton ne prend ni la sélection ni le focus (`preventDefault` sur `mousedown`).
  - La touche vient de `e.key`, qui suit la disposition du clavier : sur un clavier AZERTY, A est à sa place.
  - Coût si faux : nul.
- Ruling: **le clignotement** passe la couleur opaque sur le passage, multipliée avec la page, en une animation CSS : deux battements, puis un fondu sur `annotationFlashMs`. Un nouveau `seq` le relance. Avec 0, rien ne clignote.
  - Coût si faux : nul.
- Ruling: **la couleur par défaut est un jaune, #ffd23f.** Le brief ne la donnait pas.
  - Le surlignage est multiplié avec la page (`mix-blend-mode: multiply`) : le texte reste noir.
  - Coût si faux : nul.
- Ruling: **les bornes des réglages** :
  - opacité de 0,05 à 1 ;
  - clignotement de 0 à 10 000 ms, au pas de 50 ;
  - titre de 1 à 500 caractères ; `withOverrides` ne l'arrondit pas, `titleChars` le fait à l'usage ;
  - marge de 120 à 800 px, au pas de 10.
  - Coût si faux : nul.
- Ruling: **la source du glisser** (pour la tâche 3) ne porte que `application/x-cirrus-node` (l'identifiant du nœud), `effectAllowed = 'copy'`.
  - Pas de `text/plain` : un champ de texte ne prend rien.
  - En plein écran, rien ne se glisse.
  - Coût si faux : nul.
- Ruling: **`plein-ecran-pdf` refaite dans `plan4a`.**
  - Elle différait de 287 608 pixels (18,894 %). Les deux images ont été comparées à l'œil :
    - la marge, à droite, liste les trois annotations du chapitre ;
    - les surlignages sont sur leurs lignes, en pages 1 et 2 ;
    - le lecteur, plus étroit, s'ajuste à 165 % au lieu de 195 %, et les neuf pas de « − » mènent à 47 % au lieu de 55 %.
  - Rien d'autre ne change. Le changement est le sujet même de la tâche.
  - L'image vient de la suite finale, copiée seule dans `plan4a`.
  - Coût si faux : nul.

### Vérifications

- **Tests écrits d'abord** (rouge, pour la raison attendue) :
  - `app/tests/annotations.test.ts` ne se chargeait pas : `annotations.ts` n'existait pas ;
  - dans `viewers.test.ts`, `blobSize is not a function` ;
  - dans `core/tests/history.test.ts`, `nextUndo` et `nextRedo` valaient `undefined` ;
  - dans `view/tests/params.test.ts`, la fiche de `annotationColor` manquait.
- **Les tests de `annotations.test.ts`** :
  - aller-retour entre l'écran et la page, à 60 %, 150 % et 400 %, droite et tournée de 90°, par de vraies fenêtres d'affichage de pdf.js (son édition sans DOM) ;
  - les rectangles de la base de test à l'échelle de chaque zoom ;
  - la fusion des lignes : deux lignes, un exposant, deux colonnes ;
  - sur un DOM en miniature : deux lignes en trois morceaux, une sélection sur deux pages coupée, une sélection commencée hors du texte, une vide, une hors des pages ;
  - les refus d'un passage trop long ;
  - l'index par version, ce qu'en garde la marge, la corbeille ;
  - une reconstruction qui ne relit que ce qui a changé (identité des entrées et des listes), dont une annotation retirée de son dernier plan, qui part à la corbeille (spec 7) et quitte l'index.
- **Suites** :
  - `core` : 108 tests ; `view` : 244 ; `app` : 355. Tous passés, chaque paquet seul, `--maxWorkers=1` ;
  - `tsc --noEmit -p .` : sans erreur dans `core`, `view` et `app`.
- **Scénarios d'interface** : 8 sur 8, sur une base de test et un profil temporaires, fenêtre hors des écrans. Les six nouveaux :
  1. surligner dans l'aperçu, puis Ctrl+Z. La sélection est glissée à la souris sur la couche de texte, puis on clique « Annoter ». Le scénario vérifie :
     - le nœud dans la base, son ancre comparée à celle de la base de test ;
     - la sélection levée ;
     - le surlignage et la marge ;
     - le focus dans le lecteur ;
     - Ctrl+Z, qui retire le nœud de la base, de la page et de la marge (Review Focus 4) ;
  2. surligner en plein écran par Ctrl+Maj+A, puis Ctrl+Z et Ctrl+Y, sur les seuls pas du plein écran. La marge se glisse dans l'aperçu, pas en plein écran ;
  3. une sélection sur deux pages, coupée à la fin de la première ;
  4. ouvrir une annotation depuis la marge. Le scénario vérifie :
     - le surlignage aligné sur son texte à 91 % et à 277 % (tolérance de 0,75 pt) ;
     - la page 2 montrée ;
     - le début du passage dans la vue, sur son texte ;
     - l'animation en cours ;
  5. l'annotation de la version précédente. Le scénario vérifie :
     - le libellé « sur une version précédente » ;
     - la version précédente ouverte, son texte (« qui l’engendre. ») ;
     - son annotation dessinée et alignée, qui clignote ;
     - le retour à la version actuelle ;
  6. une version absente du magasin, son blob effacé de la base de test. Le lecteur dit « Cette version de « … » est introuvable dans la base. », la marge reste, et la version actuelle revient.
  - Ce qu'un scénario ne vérifie pas :
    - une page tournée : la base de test n'en a pas. Les tests unitaires la couvrent, par les fenêtres d'affichage de pdf.js tournées de 90° ;
    - une page encore en cours de dessin, affaire de moment. L'ancre ne lit que la couche de texte et la fenêtre d'affichage, jamais le canevas ;
    - le dépôt sur le graphe (tâche 3) ;
    - la notification d'un passage trop long, couverte par `anchorRefusal` : la base de test n'a pas 20 000 caractères à sélectionner.
- **Captures** : deux suites neuves, chacune de 24 images. La seconde vient du code final.
  - Contre `reference-3c` : 11 sur 11 à 0 pixel. Contre `plan4b` : 5 sur 5 à 0 pixel.
  - Contre `plan4a` : 7 sur 8 à 0 pixel ; `plein-ecran-pdf` est refaite (Ruling plus haut). Avec elle, 8 sur 8 à 0 pixel.
  - Les deux suites sont identiques au pixel (24 sur 24).

### Notes

- **Pour la tâche 3** :
  - `AnnotationIndex.of(pdf)` donne la liste du pop-up ;
  - `AnnotationContext.reveal` ouvre une annotation dans un aperçu (version, page, clignotement) ;
  - la marge de l'aperçu est déjà une source de glisser (`NODE_MIME`) ;
  - une annotation retirée de son dernier plan, « ici seulement », part à la corbeille, et donc de l'index (`removeFromPlan`, spec 7).

## Tâche 3 : pop-ups et pose dans un plan

### Fait

- **Cœur** (`commands.ts`) : `removeFromPlan` ne met plus à la corbeille une annotation qui quitte son dernier plan (décision du contrôleur, plus bas). « Supprimer partout » (`deleteEverywhere`) l'y met toujours.
- **`actions.ts`** :
  - `placeDroppedBuild(scene, node, at, zoom, p, index?)` : le dépôt d'un nœud tiré d'une liste. C'est `importBuild` (plan 3b), au cran lisible, qui entre dans le groupe dont l'enveloppe reçoit le point. Déposé sur un nœud simple, le nœud y entre aussi, et ce nœud devient un groupe `groupOffsetSteps` au-dessus de lui, comme le fait `dropBuild` pour un nœud lâché sur un nœud. Une action, un Ctrl+Z ;
  - `ALREADY_HERE` (« Déjà dans ce plan. ») : le refus de `placeDroppedBuild` quand le nœud est déjà posé là au moment du calcul ;
  - `lastPlanNodes` ne compte plus une annotation parmi les nœuds qui iraient à la corbeille.
- **`files/nodeFiles.ts`** :
  - `carried(e)` dit ce que porte un glisser : un nœud (`NODE_MIME`) d'abord, puis des fichiers, sinon rien. `carriesFiles` est faux pour un nœud, même accompagné de fichiers ;
  - `dropRoute(zone, node, what = 'files')` : un nœud a sa propre route, `{ to: 'place' }` sur le graphe, quoi qu'il y ait sous le point, et `refused` partout ailleurs. La garde de la fenêtre (`refusesStrayDrop`) ne le refuse jamais.
- **`files/annotations.ts`** : `annotationSource(s, anchor)` donne le fichier du PDF où s'ouvre une annotation. C'est celui qui porte son empreinte, quel que soit son nom, sinon celui de son nom, qui porte alors une version plus récente (`earlier`). Sinon, elle dit ce qui manque : le nœud du PDF absent ou à la corbeille, le fichier retiré du nœud.
- **`ui/viewers/AnnotationMargin.tsx`** : la ligne d'une annotation devient `AnnotationItem`, que la marge et le pop-up partagent. Sa note (« sur une version précédente », ou ce qui manque) est donnée par la liste. Sans `onOpen`, elle ne s'ouvre pas, mais se glisse encore. Le DOM de la marge ne change pas.
- **`ui/NodePopup.tsx`** :
  - le pop-up d'un PDF a une section « Annotations », après « Fichiers », quand il en a. C'est la liste de la marge : page, début du passage, plans ou « dans aucun plan », « sur une version précédente ». Un clic ouvre l'annotation dans l'aperçu de son fichier, à côté du pop-up, à sa page, le passage clignotant. Chaque ligne se glisse sur le graphe ;
  - le pop-up d'une annotation commence par « Annotation de « <PDF> », p. <n> », un bouton qui ouvre le PDF là ;
  - ce qui manque se dit à la place, et la ligne ne s'ouvre plus : le PDF à la corbeille ou absent, le fichier retiré du nœud, ou la version absente du magasin. Celle-ci est demandée par `blobSize` à l'affichage (`useUnreadable`).
- **`ui/panels/Panels.tsx`** : un panneau d'aperçu garde `reveal`, l'annotation qu'un pop-up lui demande de montrer. `withFile(…, reveal?)` la lui donne, et un aperçu déjà ouvert passe devant et la montre. `openFile(…, anchor?)` compte les demandes, si bien que la même annotation, redemandée, clignote de nouveau. `FilePreview` la passe à `AnnotationContext.reveal` (tâche 2).
- **`ui/GraphView.tsx`** :
  - le dépôt d'un `application/x-cirrus-node` a sa route (`takesNode`), distincte de celle des fichiers. Pendant le survol, le nœud ou le groupe qui le recevrait s'illumine (`setDropTarget`, spec 10). Lâché, il passe par `dropNodeAt`, et le graphe prend le focus ;
  - `dropNodeAt` :
    - déjà dans le plan : « Déjà dans ce plan. », et la vue se cadre sur lui (`fitItem`) ;
    - sinon `placeDroppedBuild`, avec la question « partout ou ici seulement » quand il entre dans un groupe ;
    - pendant un geste, une question ou une répercussion, le dépôt est refusé par une notification, comme Ctrl+Z ;
  - la question de `dropAsking` devient `askRepercussion(plan, moves, build, restore)`, que le dépôt d'une annotation reprend : elle y passe d'aucun groupe (`from` nul) au nœud qui la reçoit. `busy()` rassemble les gestes en cours, pour Ctrl+Z et pour ce dépôt.
- **`styles.css`** : les lignes d'annotation se dessinent par `.annotation-list` (la marge et le pop-up), avec les mêmes règles qu'avant pour la marge, plus la section du pop-up et la ligne « Annotation de … ».
- **`scripts/interface.mjs`** :
  - `dragDrop(from, to)` : un glisser-déposer HTML5 par la souris (détail plus bas) ;
  - `node scripts/interface.mjs <texte>` ne lance que les scénarios dont le nom contient ce texte (après une construction) ;
  - trois scénarios nouveaux (Vérifications).

### Décisions

Fixées par le contrôleur avant la tâche :
- la liste du pop-up est celle de la marge, sa ligne réutilisée ; un clic ouvre le PDF à la page, le passage clignotant (`reveal`) ; on glisse aussi depuis le pop-up ;
- le pop-up d'une annotation montre « Annotation de « <PDF> », p. <n> », et un clic l'ouvre là ; le PDF à la corbeille, ou la version absente, se disent, sans rien casser ;
- déposée sur un nœud simple, l'annotation en fait un groupe dont elle est le premier membre, par la règle de `dropBuild` ;
- la question « partout ou ici seulement » suit la section 10 et le chemin existant de la répercussion (plan 3b) ;
- un glisser de nœud et un glisser de fichiers sont deux routes ; la garde de la fenêtre ne refuse pas un nœud sur le graphe.

- Ruling: **une annotation qui quitte son dernier plan reste vivante, dans aucun plan, et ne va pas à la corbeille** (décision du contrôleur). C'est une exception à la spec 7, pour un nœud qui porte une ancre.
  - Pourquoi : D1 la fait naître dans aucun plan et la range sous son PDF. Retirée d'un plan, elle ne doit pas quitter la marge et le pop-up. « Supprimer partout » la met toujours à la corbeille.
  - Options :
    - la corbeille (spec 7), qui la ferait disparaître des listes ;
    - rester vivante (choix) ;
    - le demander à chaque retrait.
  - L'avertissement « ira à la corbeille (dernier plan) » ne la nomme plus (`lastPlanNodes`). Le test de l'index de la tâche 2, qui contournait l'ancien comportement, revient au cas simple : retirée de son dernier plan, elle reste dans l'index, dans aucun plan.
  - Coût si faux : une condition dans `removeFromPlan` et un filtre dans `lastPlanNodes`.
- Ruling: **« Déjà dans ce plan. » est dit deux fois** :
  - par GraphView, qui lit la scène avant toute question, et cadre la vue sur le nœud ;
  - par le refus de `placeDroppedBuild`, au calcul, si le nœud a été posé entre-temps.
  - Options : rendre `null` (rien à tester), rendre `{ build, notice }` (une signature autre que celle du brief), le refus (choix).
  - Coût si faux : nul.
- Ruling: **un nœud tiré d'une liste entre dans tout nœud simple sur lequel on le lâche**, pas seulement dans celui de son PDF : c'est la règle de `dropBuild`, qui fait entrer un nœud libre dans le nœud où on le lâche.
  - Coût si faux : une condition, l'hôte étant `anchor.pdf`.
- Ruling: **les libellés de l'historique** sont « Poser un nœud dans ce plan » et « Poser un nœud dans « <titre> » ». Le titre d'une annotation, jusqu'à 80 caractères, alourdirait les notifications d'annulation.
  - Coût si faux : nul.
- Ruling: **la question « partout ou ici seulement » ne se pose que si l'annotation entre dans un groupe** et que la répercussion change un autre plan.
  - Elle reprend `repercussion` avec `from` nul : là où l'annotation est posée sans groupe et où son hôte, ou un de ses ancêtres, existe, elle y entre ; un plan où elle est dans un autre groupe est laissé et nommé.
  - Une annotation dans aucun autre plan, le cas ordinaire, ne pose pas de question.
  - `importBuild` et le collage ne la posent pas (plan 3b) ; seul `dropAsking` la posait, et c'est son code, extrait en `askRepercussion`, que le dépôt reprend.
  - Coût si faux : nul.
- Ruling: **le nœud ou le groupe qui recevrait le dépôt s'illumine pendant le survol** (spec 10), par `setDropTarget`, recalculé à chaque `dragover`, par l'index de la scène.
  - Il s'illumine même si le nœud se révèle déjà dans le plan : pendant le survol, le navigateur ne donne que le type de ce qu'on glisse, pas l'identifiant.
  - Coût si faux : nul.
- Ruling: **un dépôt pendant un geste, une question ou une répercussion est refusé**, par une notification : « Un geste est en cours : terminez-le ou abandonnez-le (Échap) avant de poser ce nœud. » C'est la garde de Ctrl+Z (`busy()`). Après un dépôt, le graphe a le focus : Ctrl+Z et Suppr y agissent.
  - Coût si faux : nul.
- Ruling: **la section « Annotations » vient après « Fichiers », et seulement quand le nœud en a**, comme la marge. Ses lignes n'ont pas le liseré de la version montrée : le pop-up n'en montre aucune. Une ligne qui ne peut pas s'ouvrir dit pourquoi, et se glisse encore. La ligne « Annotation de … » ouvre le corps du pop-up d'une annotation, avant le résumé.
  - Coût si faux : nul.
- Ruling: **une version absente du magasin est cherchée à l'affichage du pop-up**, par `blobSize`, une demande par version montrée, dont le corps n'est pas lu. La demande compte parmi les chargements des vues : une capture l'attend.
  - Options :
    - la dire seulement au clic, où le lecteur la dit déjà (tâche 2) ;
    - un appel au principal qui liste les blobs absents ;
    - la demander à l'affichage (choix).
  - Coût si faux : une demande par version, à chaque ouverture d'un pop-up qui en liste.
- Ruling: **une annotation ouverte depuis un pop-up s'ouvre dans l'aperçu de son fichier, à côté de ce pop-up.** Un aperçu déjà ouvert de ce fichier passe devant et la montre. Il garde `reveal` : un clic sur le fichier lui-même ne relance pas le clignotement.
  - Coût si faux : nul.
- Ruling: **les scénarios glissent par `Input.setInterceptDrags`.**
  - La souris presse la ligne et bouge, de vrais événements. Chromium commence son glisser, que remplit le `dragstart` de la ligne.
  - DevTools intercepte ce glisser au lieu de le confier au système, et le livre au graphe (`Input.dispatchDragEvent` : entrée, survol, dépôt), comme le ferait le système.
  - Les données livrées sont celles que la page a mises, et le scénario vérifie qu'elles ne portent que `NODE_MIME` et l'identifiant. Aucune solution de repli n'a servi.
  - Coût si faux : nul.
- Ruling: **`popup-vignettes` refaite dans `plan4a`.**
  - Elle différait de 15 380 pixels (1,010 %). Les deux images ont été comparées à l'œil :
    - la section « Annotations » paraît après « Fichiers », sa première ligne visible : « La complexité de Kolmogorov d’une chaîne est la taille du plus petit programme q… », « p. 1 », « dans aucun plan », « sur une version précédente » ;
    - le corps du pop-up dépasse désormais ses 720 pixels : une barre de défilement paraît, et la colonne de droite (les tailles, le champ des tags, le résumé) se décale de sa largeur.
  - Rien d'autre ne change. Le changement est le sujet même de la tâche.
  - L'image vient de la seconde suite, copiée seule dans `plan4a`.
  - Coût si faux : nul.

### Vérifications

- **Tests écrits d'abord** (rouge, pour la raison attendue) :
  - `core/tests/annotation.test.ts` : l'annotation retirée de son dernier plan avait un `trashedAt` ;
  - `app/tests/actions.test.ts` : `placeDroppedBuild is not a function`, `ALREADY_HERE` valait `undefined`, et `lastPlanNodes` nommait l'annotation ;
  - `app/tests/nodeFiles.test.ts` : `carried is not a function` ;
  - `app/tests/annotations.test.ts` : `annotationSource is not a function`, et l'annotation retirée de son dernier plan était à la corbeille ;
  - `app/tests/panels.test.ts` : l'aperçu n'avait pas de `reveal`.
- **Les tests nouveaux** :
  - `placeDroppedBuild` : sur le fond, posée au point, au cran lisible, sans groupe ; dans l'enveloppe du PDF dans « Lecture », membre, le groupe gardant son cran ; sur le nœud simple du PDF dans le lobby, membre, le PDF devenu un groupe deux crans au-dessus, et l'action défaite en un pas ; déjà dans le plan, refusée « Déjà dans ce plan. », aussi quand elle y est posée entre le geste et le calcul ; à la corbeille, refusée ;
  - les routes : un nœud contre des fichiers, sur le graphe, un pop-up, la marge, le pop-up d'une connexion, une question, le plein écran, les onglets ;
  - `annotationSource` : la version courante, la précédente, le fichier renommé, la précédente alors perdue, le PDF à la corbeille, le PDF absent ;
  - `withFile` et `reveal` ;
  - le retrait d'une annotation de son dernier plan dans le cœur, l'index et `deleteBuild`.
- **Suites**, chaque paquet seul, `--maxWorkers=1` : `core` 109, `store` 20, `view` 244, `app` 363, tous passés. `store` et `view` n'ont pas changé, mais dépendent de `removeFromPlan`. `tsc --noEmit -p .` : sans erreur dans `core` et `app`.
- **Scénarios d'interface** : 11 sur 11, dont trois nouveaux, par de vrais glisser-déposer (`dragDrop`) :
  1. « poser une annotation depuis le pop-up sur le nœud du PDF, qui devient un groupe ; Ctrl+Z ». Le scénario vérifie :
     - la liste du pop-up, celle de la marge : trois lignes, les plans, « sur une version précédente » ;
     - le glisser, qui ne porte que le nœud de l'annotation ;
     - dans la base, l'annotation posée au cran 0, membre de la publication, qui passe du cran 0 au cran 2 ;
     - la liste, qui dit « Lobby », et le focus sur le graphe ;
     - Ctrl+Z, qui retire l'annotation du lobby et rend au PDF son cran et sa simplicité, l'annotation restant dans la base ;
  2. « poser une annotation depuis l'aperçu sur le fond ; reposée, « Déjà dans ce plan. » » :
     - posée à 0,15 unité du point du dépôt, au cran lisible, sans groupe ;
     - la marge qui dit « Lobby » ;
     - reposée : « Déjà dans ce plan. », et elle ne bouge pas ;
  3. « le nœud du PDF mis à la corbeille pendant que ses listes sont ouvertes ». Le scénario :
     - pose l'annotation, ouvre son pop-up et l'épingle ;
     - clique « Annotation de « … », p. 2 » : le chapitre s'ouvre à la page 2, le passage clignotant ;
     - épingle l'aperçu, le tire par son en-tête, ouvre le pop-up du PDF et sa liste, puis Suppr et « Partout ».
     - Vérifié : la ligne de l'annotation dit « Le PDF « … » est à la corbeille. » et n'est plus un bouton ; le pop-up du PDF et son aperçu disent « Ce nœud n’existe plus. » ; aucun panneau n'a échoué ; l'annotation n'est pas à la corbeille ;
     - Ctrl+Z rend le PDF : la ligne redevient un bouton, et l'aperçu montre de nouveau ses pages.
  - Ce qu'un scénario ne vérifie pas :
    - le cadrage sur le nœud déjà là, et l'illumination de l'hôte pendant le survol : le graphe se dessine en WebGL, sans DOM à lire ;
    - la question « partout ou ici seulement » sur un dépôt d'annotation : la base de test n'a pas d'annotation posée sans groupe dans un plan où son PDF existe. Le chemin est celui de `dropAsking`, extrait sans changement ;
    - la version absente du magasin dans le pop-up : la tâche 2 vérifie le lecteur ; le pop-up passe par le même `blobSize`.
- **Captures** : deux suites neuves, chacune de 24 images, sur le code final, identiques au pixel entre elles (24 sur 24).
  - Contre `reference-3c` : 11 sur 11 à 0 pixel. Contre `plan4b` : 5 sur 5 à 0 pixel.
  - Contre `plan4a` : 7 sur 8 à 0 pixel. `plein-ecran-pdf`, dont le pop-up de la publication est sous le plein écran, ne change pas. `popup-vignettes` est refaite (Ruling plus haut) : avec elle, 8 sur 8 à 0 pixel.

### Notes

- **Pour les tâches 4 à 6** : `dropRoute(zone, node, what)` distingue déjà ce que porte un glisser (`carried`). Un `.bib` ou un PDF déposé sur le fond y trouvera sa route à côté de `notice` et de `place`, sans toucher celle d'un nœud.
