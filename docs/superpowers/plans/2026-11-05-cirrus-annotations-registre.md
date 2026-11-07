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
