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

## Tâche 4 : principal — sources des publications, métadonnées, PDF d'arXiv

### Fait

- **`main/publications/sources.ts`** : `PUBLICATION_SOURCES`, le seul module qui nomme un hôte ou une adresse de publication, comme `LATEX_SOURCES`. Il donne :
  - `hosts` : `doi.org`, `api.crossref.org`, `data.crossref.org`, `api.datacite.org`, `data.datacite.org`, `data.crosscite.org` (Ruling plus bas) et `arxiv.org` ;
  - `doiUrl(doi)` : `https://doi.org/<DOI>`, chaque caractère qu'une adresse lirait autrement échappé, le « / » gardé ;
  - `arxivPdfUrl(id)` : `https://arxiv.org/pdf/<id>` ;
  - à part, `IDENTIFIER_LINKS` : les hôtes des liens qu'un utilisateur colle (`doi.org`, `dx.doi.org`, `www.doi.org` ; `arxiv.org`, `www.arxiv.org`, `export.arxiv.org`). On les lit comme des identifiants, sans jamais les demander. Ce ne sont pas des sources : les plans 5 et 9 ne les changeront pas.
- **`identifier.ts`** (pur) : `parseIdentifier(text)` reconnaît :
  - un DOI nu, après « doi: », ou en lien ;
  - un identifiant arXiv nouveau (`2401.01234v2`) ou ancien (`hep-th/9901001`, `math.GT/0309136`), nu, après « arXiv: », ou en lien `abs/` ou `pdf/` (avec ou sans `.pdf`) ;
  - le DOI qu'arXiv donne (`10.48550/arXiv.<id>`), lu comme l'identifiant arXiv ;
  - il refuse un texte de plus de `MAX_IDENTIFIER_CHARS` (1000), un DOI avec un caractère de contrôle, un blanc ou un segment « . » ou « .. », un lien vers un autre hôte ou dans un autre schéma.
  - `arxivDoi(id)` donne `10.48550/arXiv.<id sans version>`.
- **`csl.ts`** (pur) : `cslToFields(csl)` lit le titre, les auteurs « Prénom Nom » et l'année. Il ne lit que les champs propres de l'objet. Un champ d'un type inattendu est ignoré, et rien n'est évalué (détail dans les Rulings).
- **`fetch.ts`** :
  - `fetchPublication(id, deps)` demande à la fois le CSL-JSON et le BibTeX au résolveur de DOI. Pour un article arXiv, il télécharge ensuite le PDF, qui va au magasin par `deps.store` (`storeBytes`) ;
  - `importPublication(text, deps)` est l'entrée de l'IPC : un texte que `parseIdentifier` lit, sinon « Identifiant non reconnu. », sans aucune demande ;
  - `requestFetch(net.request)` est la `fetch` de production (Ruling plus bas).
  - Le résultat : `{ ok: true, id, csl, bibtex, pdf?, pdfMessage? }`, ou `{ ok: false, message }`.
- **`replay.ts`** : `replayFetch(dir)` rejoue des réponses enregistrées. `replayDirOf(env, capture)` dit quand l'app le prend (contrat plus bas).
- **IPC** `cirrus:publications:fetch` (`main/index.ts`) ; `publicationFetch(text)` au préchargement et dans `env.d.ts`. Le gestionnaire refuse tant que la base n'est pas ouverte. Il lit les réglages au moment de l'appel.
- **Réglages** (`params.ts`), groupe « Publications » de la rubrique « Fichiers », juste après « Annotations » : `publicationMaxKb` (2048) et `publicationTimeoutMs` (20 000), avancés. Le PDF a pour plafond `maxImportMb`.
- **Données de test** : `app/tests/data/publications/`, avec `index.json` et les corps enregistrés. `.gitattributes` les garde octet pour octet (`-text`, `core.autocrlf` est actif).
- **Test des adresses** : celui de `tinytex.test.ts` exempte aussi `publications/sources.ts`. Celui de `publications.test.ts` vérifie qu'aucun autre fichier de `app/src` (principal, préchargement, interface), commentaires compris, ne nomme un de ces hôtes.

### Le chemin d'une demande (Review Focus 1 et 5)

- Chaque demande part en GET, avec son `Accept`, et `redirect: 'manual'`.
- Avant chaque demande, et donc à chaque redirection, l'adresse est vérifiée :
  - HTTPS ;
  - le port par défaut ;
  - ni nom ni mot de passe ;
  - le nom d'hôte exactement dans `hosts`, tel que l'écrit l'analyseur d'URL : `doi.org.evil.example`, `doi.org@evil.example` ou un port 8443 sont refusés.
- Une redirection (301, 302, 303, 307 ou 308) se résout contre l'adresse qui la donne. On en suit 5 au plus. Une cible refusée n'est jamais demandée.
- Un corps se lit morceau par morceau, et la lecture s'arrête au premier octet au-delà du plafond. Une longueur déclarée trop grande est refusée sans lecture. Une bombe gzip s'arrête de même : le plafond compte les octets décodés.
- Le délai court aussi contre une `fetch` qui ignore son signal (une course).
- La demande est abandonnée dans tous les cas, une fois la réponse lue ou refusée.
- Une réponse se lit comme des données : du texte UTF-8 (un octet invalide devient U+FFFD), puis `JSON.parse`. Rien n'est évalué.

### Réseau : les deux vérifications manuelles (2026-11-07)

Un script jetable, qu'Electron 45 lance sans fenêtre (son Node 24.22 lit le TypeScript tel quel), appelle le chemin de production : `importPublication`, puis `requestFetch` sur `net.request`. Il enregistre chaque réponse.

- **Première vérification**, trois identifiants :

  | Demande | Accept | Statut | Réponse |
  |---|---|---|---|
  | `https://doi.org/10.48550/arXiv.1706.03762` | CSL, BibTeX | 302 | `Location: https://data.crosscite.org/10.48550%2FarXiv.1706.03762` (refusée : hôte hors de la liste) |
  | `https://doi.org/10.1007/978-0-387-49820-1` | CSL, BibTeX | 302 | `Location: https://api.crossref.org/v1/works/10.1007%2F978-0-387-49820-1/transform` |
  | `https://api.crossref.org/v1/works/10.1007%2F978-0-387-49820-1/transform` | CSL | 200 | `application/vnd.citationstyles.csl+json`, 2 436 octets (984 en gzip) |
  | idem | BibTeX | 200 | `application/x-bibtex`, 331 octets |
  | `https://doi.org/10.1007/cirrus-introuvable` | CSL, BibTeX | 404 | `text/html;charset=utf-8`, 10 616 octets (« Error: DOI Not Found ») |

  - L'arXiv est refusé par le garde, comme il se doit, en 318 ms : « Redirection refusée : « doi.org » renvoie vers « data.crosscite.org », qui n’est pas un serveur permis. ». Ni `data.crosscite.org` ni le PDF n'ont reçu de demande. Arrêt, et décision du contrôleur (Ruling plus bas).
  - Le livre de Crossref est importé en 420 ms : type `book`, « An Introduction to Kolmogorov Complexity and Its Applications », Ming Li et Paul Vitányi, 2008, et `@book{Li_2008, …}`.
  - Le DOI inconnu donne « Publication introuvable. » en 127 ms.
- **Seconde vérification**, le chemin arXiv seul, après l'ajout de `data.crosscite.org` :

  | Demande | Accept | Statut | Réponse |
  |---|---|---|---|
  | `https://doi.org/10.48550/arXiv.1706.03762` | CSL, BibTeX | 302 | `Location: https://data.crosscite.org/10.48550%2FarXiv.1706.03762` |
  | `https://data.crosscite.org/10.48550%2FarXiv.1706.03762` | CSL | 200 | `application/vnd.citationstyles.csl+json; charset=utf-8`, 2 240 octets |
  | idem | BibTeX | 200 | `application/x-bibtex; charset=utf-8`, 589 octets |
  | `https://arxiv.org/pdf/1706.03762` | `application/pdf` | 200 | `application/pdf`, 2 215 244 octets (égal à son `Content-Length`), `%PDF-1.5`, `filename="1706.03762v7.pdf"`, **sans redirection** |

  - L'import est complet en 931 ms : type `article`, « Attention Is All You Need », huit auteurs de « Ashish Vaswani » à « Illia Polosukhin », 2017, `@misc{…}`, et le PDF `1706.03762.pdf` (sha256 `bdfaa68d…df697`).
- **Hôtes atteints** : `doi.org`, `api.crossref.org`, `data.crosscite.org` et `arxiv.org`. **Jamais atteints** : `data.crossref.org`, `api.datacite.org` et `data.datacite.org`. Ils restent dans la liste de D5, car Crossref et DataCite peuvent y renvoyer.
- **Données gardées pour les tests**, telles que reçues : les deux CSL, les deux BibTeX et la page 404. Le vrai PDF (2,2 Mo) n'est pas commité. Il est remplacé par `arxiv-1706.03762.pdf`, un PDF valide d'une page et de 842 octets, qui porte le titre et « arXiv:1706.03762 ».

### Contrat du rejeu (pour les tâches 5 et 7)

- **Activation** : `CIRRUS_PUBLICATIONS_REPLAY=<dossier>`, prise seulement avec `CIRRUS_DATA` et en mode capture (`CIRRUS_CAPTURE`) ou avec `CIRRUS_BACKGROUND=1`, comme dans `interface.mjs` (`replayDirOf`). Sur la base de l'utilisateur, la variable est ignorée, avec un avertissement dans la console, et le réseau sert.
- **`<dossier>/index.json`** contient `{ "responses": [{ "url", "accept"?, "status", "headers"?, "body"? }] }`.
  - Une demande prend la première réponse de son adresse dont l'`accept` est le sien, ou qui n'en a pas.
  - `body` est un nom de fichier du dossier, jamais un chemin.
  - On garde `content-type`, et `location` pour une redirection.
  - Une demande sans réponse échoue comme hors ligne (`TypeError`), d'où « Pas de connexion. ». Le rejeu ne passe jamais au réseau.
  - L'index se relit à chaque demande, si bien qu'un scénario peut le changer entre deux imports.
- **Le dossier enregistré** est `packages/app/tests/data/publications`. Il répond à :
  - `arXiv:1706.03762`, ou tout texte qui le désigne : son CSL, son BibTeX et le PDF de remplacement ;
  - `10.1007/978-0-387-49820-1` : le livre de Crossref, sans PDF ;
  - `10.1007/cirrus-introuvable` : « Publication introuvable. » ;
  - tout autre identifiant reconnu : « Pas de connexion. ».

### Décisions

Fixées par le contrôleur avant la tâche :
- les redirections se suivent à la main, chacune vérifiée, en HTTPS seulement ;
- chaque corps est lu sous son plafond, et analysé comme des données ;
- du HTML au lieu de JSON donne « Réponse inattendue du serveur de DOI. » ;
- les réglages `publicationMaxKb` et `publicationTimeoutMs` vont dans le groupe « Publications », après « Annotations » ;
- l'argument de l'IPC est un texte borné ;
- le réseau ne sert qu'à la demande ;
- les tests et les vérifications rejouent, et le rejeu ne vaut que sur une base de test ;
- une seule vérification réseau, consignée ici.

- Ruling (contrôleur, option A) : **`data.crosscite.org` entre dans `PUBLICATION_SOURCES.hosts`**, et `data.datacite.org` y reste.
  - Constat : `doi.org` répond 302 vers `https://data.crosscite.org/10.48550%2FarXiv.1706.03762` au DOI d'arXiv `10.48550/arXiv.1706.03762`, en CSL comme en BibTeX (première vérification). `data.crosscite.org` est le service de négociation de contenu des DOI de DataCite, qui a succédé à celui de `data.datacite.org`. Celui-ci y renvoie et reste dans la liste de D5.
  - Options :
    - A, ajouter l'hôte (choix) ;
    - B, demander directement `api.datacite.org` pour un identifiant arXiv, sans `doi.org` ;
    - C, les deux.
  - Pourquoi A plutôt que B : un seul chemin pour tout DOI de DataCite (arXiv, Zenodo…), comme le veut D5. Avec B, les autres DOI de DataCite resteraient refusés.
  - Vérifié : `data.crosscite.org` répond lui-même, en 200, sans autre redirection (seconde vérification).
  - Coût si faux : un hôte dans la liste.
- Ruling : **la `fetch` de production est `requestFetch`, sur `net.request` d'Electron, et non `net.fetch`.**
  - Contre un serveur local, `net.fetch` d'Electron 45 rejette en mode `manual` (« Redirect was cancelled »). En mode `follow`, il suit seul et cache où il est allé (`url` vide, `redirected` faux). Il ne permet donc aucune vérification par saut.
  - `net.request` en `redirect: 'manual'` émet `redirect` (statut, adresse absolue) avant de suivre. `requestFetch` en fait une réponse 3xx avec `Location`, et arrête la demande. `fetch.ts` vérifie la cible, et la demande ou non.
  - Il passe aussi `credentials: 'omit'`, ni cookie envoyé ni gardé, vérifié contre le serveur local, et `cache: 'no-store'`.
  - Un écouteur qui lèverait serait une exception non rattrapée du principal : un statut hors bornes ou un en-tête refusé rejette la promesse à la place.
  - Options :
    - `net.fetch` en `follow`, sans contrôle des sauts ;
    - le `fetch` global de Node (undici), qui rend bien les 3xx, mais sans le mandataire ni les certificats du système ;
    - `net.request` (choix).
  - Coût si faux : une soixantaine de lignes.
- Ruling : **`parseIdentifier` vit dans `identifier.ts`, pur, et `cslToFields` dans `csl.ts`, pur.** L'interface (tâche 5) peut les importer, comme elle importe `LATEX_SOURCES`.
  - Les hôtes des liens collés sont dans `sources.ts` (`IDENTIFIER_LINKS`), pour que le test des hôtes reste strict.
  - Sont aussi reconnus, au-delà du brief :
    - un identifiant arXiv nouveau, nu (`2401.01234`) ;
    - le DOI d'arXiv, lu comme l'identifiant arXiv, pour que son PDF vienne aussi.
  - L'identifiant arXiv garde sa version ; `arxivDoi` la retire, car le DOI d'arXiv n'en a pas, et le PDF prend la version demandée.
  - Coût si faux : nul.
- Ruling : **le résultat porte aussi `id`** (l'identifiant lu, pour les tags `doi` ou `arxiv` de D7) **et `pdfMessage`.**
  - Le PDF d'arXiv qui ne vient pas laisse venir la publication, et `pdfMessage` dit pourquoi. C'est l'import « dégradé » du Review Focus 1. Les causes : pas `%PDF`, plus de `maxImportMb`, introuvable, erreur HTTP, redirection refusée, délai, plus de connexion, ou enregistrement impossible.
  - Options :
    - refuser tout l'import ;
    - taire la raison ;
    - la dire (choix).
  - Coût si faux : la tâche 5 montre ou non `pdfMessage`.
- Ruling : **le CSL et le BibTeX sont tous deux requis.** Ils sont demandés en même temps, et le premier qui échoue arrête l'autre : un 404 rapide n'attend pas le délai de l'autre demande. Seule sa raison est dite.
  - Coût si faux : un BibTeX facultatif, et la tâche 5 fabrique alors la clé (D7 le prévoit).
- Ruling : **le délai** (`publicationTimeoutMs`) **couvre tout l'échange d'une demande de métadonnées** : redirections et corps. Pour le PDF, c'est l'attente maximale de données, réarmée à chaque morceau, comme `latexDownloadStallMs` : un gros PDF sur une connexion lente va au bout, et un serveur qui distille ses métadonnées est coupé. Un seul réglage pour les deux.
  - Coût si faux : un second réglage.
- Ruling : **les valeurs des réglages.**
  - `publicationMaxKb` vaut 2048 Ko, de 16 à 65 536, au pas de 16.
    - Mesuré : 2,2 et 2,4 Ko de CSL, 0,3 et 0,6 Ko de BibTeX, 10 Ko pour la page 404.
    - Le CSL de Crossref liste les références, et les articles d'une grande collaboration ont des milliers d'auteurs avec leurs affiliations : quelques centaines de Ko.
    - 2 Mo laissent cette marge, et la mémoire reste bornée.
  - `publicationTimeoutMs` vaut 20 000 ms, de 1 000 à 600 000, au pas de 500.
    - Mesuré : de 0,1 à 0,5 s par échange, et 0,5 s pour le PDF de 2,2 Mo.
    - L'API de Crossref met parfois plusieurs secondes.
    - 20 s, c'est 40 fois l'échange le plus lent mesuré, sous les 60 s de `latexDownloadStallMs`.
  - Coût si faux : deux valeurs.
- Ruling : **les types attendus.**
  - Le CSL : `application/json` ou `application/<…>+json`, en minuscules, sans paramètres ; puis un objet avec un titre (`cslToFields`).
  - Le BibTeX : `application/x-bibtex` ou `text/x-bibtex`, et un texte qui commence par « @ » une fois débarrassé de ses blancs. Celui de Crossref commence par une espace.
  - Ce sont les types reçus des deux serveurs. Sinon : « Réponse inattendue du serveur de DOI. ».
  - Coût si faux : un type de plus.
- Ruling : **les messages au-delà des quatre du brief**, en français :
  - « Le serveur de DOI ne répond pas (délai de 20 s dépassé). » ;
  - « Réponse trop grosse du serveur de DOI (plus de 2 048 Ko). » ;
  - « Le serveur de DOI a répondu par une erreur (HTTP 503). » ;
  - « Redirection refusée : « doi.org » renvoie vers « x », qui n’est pas un serveur permis. » ;
  - « Redirection refusée : « doi.org » renvoie vers une adresse qui n’est pas en HTTPS. » ;
  - « Trop de redirections depuis « doi.org ». » ;
  - les raisons du PDF ;
  - « L’import de la publication a échoué : erreur inattendue. » pour une erreur de programme, dont la cause va à la console ;
  - « La base n’est pas ouverte. ».
  - Un 404 ou un 410 donne « Publication introuvable. ». Une erreur de la pile réseau, quelle qu'elle soit (`fetch failed`, `net::ERR_*`), donne « Pas de connexion. », et sa cause va à la console.
  - Coût si faux : des textes.
- Ruling : **5 redirections au plus et 1000 caractères au plus sont des bornes fixes de sécurité**, et non des réglages, comme la liste `RUNNABLE` du plan 4a. Les chaînes de `doi.org` font un saut.
  - Coût si faux : deux réglages.
- Ruling : **`cslToFields`.**
  - Le titre : une chaîne, ou la première d'une liste. Les balises en ligne que Crossref laisse (`<i>`, `<sub>`, `<scp>`, `<mml:…>`) sont retirées. Un « < » qui n'ouvre pas de balise reste. Les entités sont décodées (`&amp;`, `&#233;`, sauf les caractères de contrôle). Les blancs deviennent une espace.
  - Les auteurs : `literal`, sinon le prénom, les particules, le nom et le suffixe (« Ludwig van Beethoven », « Martin Luther King Jr. »). Les éditeurs ne remplacent pas des auteurs absents : le tag est `auteur`.
  - L'année : `issued`, puis `published-print`, puis `published-online`. La première `date-part` doit être un entier de 0 à 9999, sinon on prend quatre chiffres de `raw` ou `literal`.
  - Seuls les champs propres de l'objet comptent : `{"__proto__": {"title": …}}` n'a pas de titre.
  - Coût si faux : nul.
- Ruling : **le PDF s'appelle `<identifiant>.pdf`**, le « / » d'un ancien identifiant devenu « _ » (`hep-th_9901001.pdf`). Il est lu en mémoire, sous `maxImportMb`, puis passé à `storeBytes`.
  - arXiv borne ses dépôts à quelques dizaines de Mo.
  - Coût si faux : écrire au fil de la lecture, dans un fichier temporaire.
- Ruling : **aucune adresse électronique ni agent particulier n'est envoyé**. On garde l'agent d'Electron, et pas de « polite pool » de Crossref, qui demanderait une adresse.
  - Coût si faux : un en-tête.
- Ruling : **un scénario d'interface vérifie l'IPC dans l'app construite**, sur le rejeu : l'article d'arXiv, son PDF octet pour octet dans le magasin de la base de test, le livre sans PDF, les refus en français et ce qu'une page peut envoyer d'autre qu'un texte. Aucun nœud n'est créé : la tâche 5 construit les nœuds.

### Vérifications

- **Tests écrits d'abord** (rouge, pour la raison attendue) :
  - `app/tests/publications.test.ts` ne se chargeait pas : `csl.ts` n'existait pas ;
  - dans `view/tests/params.test.ts`, `publicationMaxKb` valait `undefined` ;
  - le test de l'arrêt réciproque attendait tout le délai (5 s, délai du test dépassé).
- **`publications.test.ts`**, 17 tests :
  - les formes et les refus de `parseIdentifier` ;
  - les sources, et l'absence de ces hôtes dans le reste de `app/src` ;
  - l'article d'arXiv et le livre de Crossref rejoués, de bout en bout ;
  - le DOI inconnu ;
  - sans réseau, trois erreurs de la pile réseau ;
  - les redirections refusées (autre hôte, identifiants dans l'adresse, port, hors HTTPS, `file:`, sans `Location`, sans fin) et une chaîne permise, relative, pour chaque statut ;
  - du HTML ou autre chose au lieu du CSL ou du BibTeX ;
  - une réponse trop grosse, lue au plus jusqu'à un morceau au-delà de son plafond, et annulée ; une longueur déclarée, non lue ; le plafond exact, pris ;
  - un serveur muet, ou qui s'arrête en cours de réponse, ou qui distille ses métadonnées ;
  - le PDF : bon, faux (HTML, espace en tête, tronqué), trop gros, redirigé ailleurs, introuvable, en erreur, sans réseau, magasin en échec, ou lent mais jamais muet ;
  - l'arrêt réciproque des deux demandes ;
  - les erreurs HTTP ;
  - `importPublication` sur ce qui n'est pas un texte ;
  - `cslToFields` défensif ;
  - `requestFetch` sur une fausse `ClientRequest` ;
  - le rejeu et `replayDirOf`.
- **Suites**, chaque paquet seul, `--maxWorkers=1` : `view` 245 et `app` 380, tous passés. `tsc --noEmit -p .` est sans erreur dans `view` et `app`.
- **Scénarios d'interface** : 12 sur 12, dont le nouveau, « importer une publication par le pont, réponses rejouées ».
- **Captures** : une suite neuve de 24 images, sur le code final. Contre `reference-3c` : 11 sur 11 à 0 pixel ; contre `plan4a` : 8 sur 8 ; contre `plan4b` : 5 sur 5. Aucune image n'est refaite.

### Notes

- **Pour la tâche 5** :
  - **la clé BibTeX de DataCite est une adresse** : `@misc{https://doi.org/10.48550/arxiv.1706.03762, …`. La clé de D7, « celle de l'entrée si elle en a une », donnerait un fichier `<clé>.bib` au nom refusé (`:` et `/`). Il faut la refuser comme clé, par `checkFileName`, et prendre le nom et l'année (`vaswani2017`). Celle de Crossref (`Li_2008`) est un nom permis ;
  - le BibTeX de DataCite écrit le DOI en majuscules (`10.48550/ARXIV.1706.03762`) : on compare les DOI sans la casse pour les doublons. Un identifiant arXiv se compare sans sa version (`arxivDoi` la retire) ;
  - la base de test a déjà « An Introduction to Kolmogorov Complexity and Its Applications », avec `clé_bibtex = li2008` et sans tag `doi`. Importer `10.1007/978-0-387-49820-1`, rejoué, n'en est un doublon par aucune règle de D7 : clé `Li_2008`, DOI absent. C'est à trancher, et c'est un scénario tout prêt ;
  - le CSL traverse l'IPC tel quel, par clonage structuré ;
  - `cslToFields` et `parseIdentifier` s'importent depuis l'interface ;
  - une liste d'auteurs peut compter des milliers de noms : le nombre de tags `auteur` est à décider ;
  - le PDF est au magasin avant toute action, comme un fichier importé : l'action de la tâche 5 n'a plus qu'à le référencer.

## Tâche 5 : BibTeX, nœuds de publication, dialogue d'import, PDF déposé

### Fait

- **`core/src/bibtex.ts`**, un analyseur à nous, sans dépendance :
  - `parseBibtex(text)` donne `{ entries, problems }`. Une `BibEntry` a son type (en minuscules), sa clé (`''` sans clé), sa ligne et deux `Map` de champs :
    - `fields`, les valeurs : macros `@string` du fichier remplacées, mois nommés (`jul` : « July »), concaténations `#` jointes, LaTeX gardé ;
    - `raw`, les mêmes comme BibTeX les écrit : texte entre accolades, nombre nu, macro inconnue du fichier gardée en macro (un mois aussi).
  - Il lit `@type{…}` et `@type(…)`, les valeurs entre accolades (imbriquées), entre guillemets (un guillemet dans des accolades est du texte), les nombres, les macros (définies avant leur usage, sans casse), `@string`, `@comment`, `@preamble`, et les commentaires `%` (Ruling plus bas).
  - Une entrée abîmée est signalée à sa ligne, avec la raison, et la lecture reprend au prochain « @ » en début de ligne. Un champ en double garde le premier ; une clé en double (sans casse) est signalée, les deux entrées gardées ; une macro inconnue est laissée vide, et signalée.
  - La correspondance de chaque accolade est calculée une fois, d'avance (celle des parenthèses au premier `@comment(`), et rien n'est récursif. Le temps total est borné par le compteur de travail de la ronde 2 de la revue (`BIB_WORK_PER_CHAR`).
  - Borné (Ruling plus bas) : une valeur de `BIB_MAX_VALUE_CHARS` au plus, toutes ensemble quatre fois la taille du texte plus une valeur, `BIB_MAX_ENTRIES` entrées lues, `BIB_MAX_PROBLEMS` problèmes listés.
- `latexToUnicode(s)` : accents (`\'e`, `\"{o}`, `{\'e}`, `\c c`, `\'\i`) composés en NFC, lettres (`{\o}`, `\ss`, `\L`), `--` et `---`, ``` `` ``` et `''`, `~` en espace, accolades de protection et `$` retirés, caractères échappés (`\&`, `\%`…), lettres grecques ; une commande inconnue est retirée et son argument gardé (`\emph{x}` : x). Une passe, sans récursion.
- `bibNames(field)` et `bibAuthors(field)` : les noms découpés comme BibTeX les découpe (« Prénom von Nom », « von Nom, Prénom », « von Nom, Jr, Prénom »), un nom entre accolades d'un seul tenant (`{Groupe de travail}`), « and » hors accolades et sans casse, « others » écarté. `bibAuthors` les écrit « Prénom von Nom Jr », comme `cslToFields`.
- `bibFields(entry)` (titre, auteurs, année de `year` puis de `date`), `bibIdentifiers(entry)` (le DOI ; l'identifiant arXiv par le DOI d'arXiv, `eprint` avec `archiveprefix` ou `eprinttype`, « arXiv:… » dans `eprint`, `journal`, `note` ou `howpublished`, une page d'arXiv dans `url`), `cleanDoi`, `cleanArxiv`, `normalizedTitle`, `yearIn`.
- `safeCiteKey(key)`, `citeKey(entry, taken)` (D7, Rulings plus bas) et `bibtexEntry(entry, key)` : l'entrée écrite seule sous sa clé, un champ par ligne. Relue, elle donne les mêmes champs.
- `createNode` prend aussi `files` (déjà au magasin) : le nœud naît avec, en une opération.
- **`app/src/renderer/publications/build.ts`** :
  - `PublicationIndex.of(state)` : les publications de la base, par DOI, identifiant arXiv, clé et titre normalisé avec l'année ; ses `keys`, toutes les `clé_bibtex`, corbeille comprise. `add(plan)` sert à la tâche 6 (les doublons d'un même fichier).
  - `planPublication(index, input, maxAuthors)` : le titre, les tags de D7, la clé et le `.bib`, ou le refus d'un doublon, qui nomme le nœud.
  - `publicationBuild(plan, files, scene, at, zoom, p, index?)` : une action, le nœud posé au point, au cran lisible, entrant dans le groupe dont l'enveloppe le reçoit (`newNodeBuild`, partagé avec `createBuild` dans `actions.ts`). Refusée au calcul si la publication est entrée entre-temps.
  - `publicationOf(result, dropped)` lit la réponse du principal (le CSL par `cslToFields` seulement, le BibTeX par `parseBibtex`).
  - `importByIdentifier(text, dropped, deps)` et `createFromPdf(pdf, title, deps)` : le chemin d'un import, testable sans fenêtre (les dépendances sont passées), jusqu'à son issue (`done`, `failed`, `notified`, `dropped`).
- **`identify.ts`** : `findIdentifier(text, meta)` (D8), pur. **`pdfClues.ts`** : `readPdfClues(ref, pages, kept)`, les métadonnées et le texte des premières pages par pdf.js.
- **`ui/PublicationDialog.tsx`** : le champ, « Importer » (ou Entrée), l'état (« Recherche… », la raison d'un échec, l'identifiant trouvé), « Créer le nœud » pour un PDF sans identifiant, « Fermer » (ou Échap). Le dialogue entier prend un PDF déposé.
- **Le menu du fond** (`view/src/menus.ts`) : « Importer une publication… », après « Nouveau nœud » et « Coller ». `GraphView` ouvre le dialogue, retient le point du clic droit, son zoom et son plan, et pose le nœud par la session.
- **L'IPC** (`main/index.ts`, `fetch.ts`, préchargement, `env.d.ts`) : `publicationFetch(text, { pdf: false })` ne télécharge pas le PDF d'arXiv (un PDF déposé, D8). Le principal ne prend que `{ pdf: false }` exactement ; toute autre valeur garde le téléchargement de la tâche 4.
- **Réglages** (groupe « Publications », avancés) : `publicationMaxAuthors` (50, de 1 à 10 000) et `publicationPdfPages` (2, de 1 à 20).
- `nodeFiles.ts` : le graphe ne prend pas les fichiers lâchés sur le dialogue (`GRAPH_REFUSES`). C'est le dialogue qui les prend.
- **Données** : `core/tests/data/reel-50.bib`, cinquante références réelles écrites comme les écrivent JabRef, Google Scholar, DBLP, Crossref et la main ; `app/tests/data/publications/shannon-1948.{csl.json,bib}`, composées sur le modèle de Crossref, puis remplacées par les vraies réponses à la ronde 1 de la revue. `.gitattributes` garde `core/tests/data/` octet pour octet.

### Décisions

- Ruling (contrôleur) : **une clé d'entrée qui n'est pas une clé sûre est écartée** : `citeKey` prend alors le nom et l'année (D7), et le `.bib` est écrit sous la clé retenue (l'entrée réécrite avec elle). Une adresse (la clé de DataCite, `https://doi.org/10.48550/arxiv.1706.03762`) ne peut être ni un nom de fichier ni une clé de `\cite`.
  - Ce que `safeCiteKey` prend : des lettres et chiffres ASCII et « _ . + - », d'abord une lettre, un chiffre ou « _ », 200 au plus, pas un nom que Windows réserve (`con`, `aux`…), et `safeLabel`.
  - Il refuse donc aussi les clés de DBLP (`DBLP:conf/nips/…` : « : » et « / » ne sont pas permis dans un nom de fichier, et « : » est actif avec babel en français) et une clé non ASCII (BibTeX lit en 8 bits).
  - Coût si faux : la clé d'un nœud, celle que l'utilisateur citait étant remplacée par nom et année.
- Ruling (contrôleur) : **un même titre normalisé (casse, accents, ponctuation, espaces) et une même année font aussi un doublon**, en plus du DOI, de l'identifiant arXiv et de la clé (D7). Le livre de la base de test n'a pas de tag `doi`, et Crossref lui donne la clé `Li_2008` : sans cette règle, il serait recréé. La notification nomme le nœud existant. Les DOI se comparent sans la casse (DataCite les écrit en majuscules).
  - Coût si faux : un import refusé que l'utilisateur voulait (deux œuvres du même titre la même année).
- Ruling, amendé à la ronde 1 de la revue (plus bas) : **les doublons**, dans cet ordre : même DOI, même identifiant arXiv (sans version ; un tag `doi` qui est celui d'arXiv compte comme son identifiant), même clé d'entrée (telle qu'écrite), même titre et même année. Message : « Déjà dans la base (même DOI) : « titre ». ». Un nœud à la corbeille n'est pas un doublon. Le DOI ou l'identifiant tapé est comparé avant le réseau ; la clé, le titre et l'année, après la réponse ; tout est vérifié de nouveau au calcul de l'action.
  - Options : compter la corbeille (refuser un import que l'on peut vouloir refaire) ; ne vérifier qu'après la réponse (une demande au réseau pour rien).
  - Coût si faux : une règle de plus ou de moins dans `PublicationIndex`.
- Ruling : **les champs du nœud viennent du CSL** (`cslToFields` : titre, auteurs, année), **le `.bib` et la clé du BibTeX**. Le BibTeX ne complète que ce que le CSL n'a pas. Un BibTeX illisible refuse l'import (« Le BibTeX reçu est illisible : la publication n’est pas importée. ») plutôt que de créer un nœud sans `.bib`.
  - Coût si faux : un import refusé quand le serveur envoie un BibTeX abîmé (il a déjà passé le contrôle de type de la tâche 4).
- Ruling : **le `.bib` du nœud est l'entrée réécrite** (`bibtexEntry`) et non le texte reçu : un champ par ligne, les macros du fichier remplacées, un mois et une macro inconnue gardés en macro. Un seul chemin pour le réseau et pour un `.bib` entier (tâche 6), où un `.bib` par nœud doit se lire seul, sans les `@string` de son fichier.
  - Coût si faux : la mise en page du texte reçu, perdue.
- Ruling : **la clé fabriquée** est le nom de famille du premier auteur (sans particule), en lettres ASCII minuscules, puis l'année : `vaswani2017`, `neumann1944`, `vitanyi2008`. Sans auteur, le premier mot du titre ; sans l'un ni l'autre, « publication ». En cas de collision, sans casse, avec toute `clé_bibtex` de la base, corbeille comprise : b, c… z, puis aa, ab… Une clé que Windows réserve est sautée (`conb`).
  - Coût si faux : la forme des clés fabriquées.
- Ruling : **les tags** : `auteur` (au plus `publicationMaxAuthors`, 50 : un article de collaboration en compte des milliers, et le `.bib` les garde tous), `date_de_publication` (l'année), `clé_bibtex`, `doi` tel que donné, `arxiv` sans sa version (l'article ; le PDF garde la sienne dans son nom). Une entrée de `.bib` qui a les deux identifiants (tâche 6) porte les deux tags. Les clés de tag ne sont pas ajoutées au registre : un tag d'une clé inconnue est libre.
  - Coût si faux : un réglage, ou un tag de plus.
- Ruling : **deux réglages nouveaux**, avancés, dans « Publications » : `publicationMaxAuthors` (50) et `publicationPdfPages` (2, les « deux premières pages » de D8, en valeur par défaut). Les autres bornes sont des bornes fixes de sécurité (Ruling suivant).
- Ruling : **bornes fixes de sécurité** (comme les 5 redirections de la tâche 4), pas des réglages :
  - une valeur de 2^20 caractères (1 048 576), toutes les valeurs d'un fichier quatre fois sa taille plus une valeur, 50 000 entrées (25 fois les 2 000 du plan), 200 problèmes listés ;
  - 8 accents au plus sur une lettre : une longue suite de marques de classes alternées ferait réordonner la normalisation Unicode sans fin. `normalizedTitle` retire les marques du texte avant de le décomposer, pour la même raison (il lit aussi des titres de CSL) ;
  - un identifiant de 1 000 caractères au plus, sans caractère de contrôle ;
  - pour un PDF déposé : 200 000 caractères de texte, 100 métadonnées de 2 000 caractères, un titre de 300.
  - Coût si faux : un réglage de plus.
- Ruling : **la lecture d'un `.bib`** suit biber et JabRef là où BibTeX est plus strict :
  - « % » commente jusqu'à la fin de la ligne entre les entrées et entre les jetons d'une entrée (une entrée mise en commentaire n'est pas lue) ;
  - un « @ » n'ouvre une commande qu'en début de texte, après un blanc ou après la fin d'une entrée (celui d'une adresse électronique n'en ouvre pas) ;
  - après une entrée abîmée, la lecture reprend au prochain « @ » en début de ligne ;
  - une accolade fermante de trop entre guillemets rend l'entrée abîmée, comme pour BibTeX.
  - Coût si faux : une entrée de plus ou de moins lue dans un fichier abîmé.
- Ruling : **`latexToUnicode`** : `~` devient une espace ordinaire et non insécable (un titre de nœud se coupe et se cherche) ; l'apostrophe ASCII reste telle quelle, comme dans les titres du CSL ; ``` `` ``` et `''` deviennent « “ » et « ” ».
  - Coût si faux : un caractère.
- Ruling : **l'identifiant d'un PDF déposé** (`findIdentifier`) se cherche dans cet ordre : les métadonnées (celles dont le nom dit DOI d'abord), puis l'estampille d'arXiv dans la marge (« arXiv:1706.03762v7 [cs.CL] »), puis le premier DOI du texte, puis une autre mention « arXiv:… », puis un lien. Un préprint arXiv cite souvent des DOI dans sa première page ; un éditeur imprime le sien en tête. Chaque candidat passe par `parseIdentifier`, comme au principal.
  - Coût si faux : un mauvais identifiant proposé, que l'utilisateur voit avant « Importer ».
- Ruling : **le dialogue** :
  - en haut du graphe, il ne bloque rien ;
  - il retient le point du clic droit, son zoom et son plan : le nœud s'y pose, même si la vue a bougé ;
  - un autre plan affiché le ferme, et le résultat attendu est abandonné (le nœud n'aurait plus de scène où se poser) ;
  - un doublon, ou une action refusée, se dit par une notification, et le dialogue se ferme ; un échec du réseau ou de la lecture se dit dans le dialogue, qui reste ouvert pour corriger l'identifiant ;
  - un rejet de l'IPC (une réponse qu'Electron ne sait pas cloner) devient « L’import de la publication a échoué : le processus principal n’a pas répondu. », un rejet de `storeText` « Le fichier .bib de la publication n’a pas pu être enregistré dans la base. », la cause allant à la console ;
  - un PDF importé sans le sien (`pdfMessage`) se dit par une notification ;
  - « Créer le nœud » n'est offert que pour un PDF sans identifiant.
  - Coût si faux : un import à relancer après un changement d'onglet.
- Ruling : **pdf.js reste chargé à la demande** : le dialogue importe `pdfClues.ts` au premier PDF déposé. Importé directement, il portait le paquet principal de 970 à 1 775 Ko.
- Ruling, remplacé à la ronde 1 de la revue (les vraies réponses, enregistrées par le contrôleur) : **`shannon-1948.csl.json` et `shannon-1948.bib` ne sont pas enregistrés mais composés** sur le modèle des réponses de Crossref de la tâche 4 : aucune session réseau n'était permise à cette tâche. Le scénario « par DOI » en a besoin, car le livre enregistré est un doublon de la base de test. Leur `about`, dans `index.json`, le dit.
  - Coût si faux : le scénario vérifie notre lecture d'une réponse plausible de Crossref, pas de la vraie.

### Mesures

- 2 000 entrées réelles (le fichier de 50 répété 40 fois, 569 Ko, 1 950 clés en double signalées) : 29 ms sur ce PC, après une première lecture à 48 ms. Le test des 2 000 entrées, dont 20 abîmées : 18 ms.
- Le fichier réel de 50 entrées : 5 ms. 20 000 `@comment(` jamais fermés : 249 ms (11,5 s avant la table des parenthèses).
- Le paquet principal de l'interface : 970 Ko, et le module `pdfClues` 2 Ko à part.

### Vérifications

- **Tests écrits d'abord** (rouges pour la raison attendue) :
  - `core/tests/bibtex.test.ts` ne se chargeait pas : `bibtex.ts` n'existait pas ;
  - `core/tests/commands.test.ts`, la création avec ses fichiers : `expected [] to deeply equal [ { name: 'li2008.bib', … } ]` ;
  - `app/tests/publicationImport.test.ts` ne se chargeait pas : `identify.ts` n'existait pas ; puis 2 échecs sur 13, les tags `auteur` absents tant que `publicationMaxAuthors` n'existait pas ;
  - `view/tests/params.test.ts` et `menus.test.ts` : `publicationMaxAuthors: expected undefined to be 50`, `expected [ 'newNode' ] to deeply equal [ 'newNode', 'importPublication' ]` ;
  - `app/tests/publications.test.ts`, `pdf: false` : `expected { name: '1706.03762.pdf', … } to be undefined` ;
  - `app/tests/nodeFiles.test.ts`, le dialogue : `expected { to: 'node', node: 'n' } to deeply equal { to: 'refused' }` ;
  - à la relecture : 20 000 `@comment(` en 11 485 ms au lieu de moins d'une seconde ; `cleanDoi` gardait un caractère de contrôle ; un nœud qui a `arxiv` puis `doi` n'était indexé que par le premier.
- **Suites**, chaque paquet seul, `--maxWorkers=1` : `core` 125 tests (14 fichiers), `view` 246 (30), `app` 395 (37). Tous passés. `tsc --noEmit -p .` sans erreur dans les trois.
- **Scénarios d'interface** : 17 sur 17, dont cinq nouveaux sur les réponses rejouées, par de vrais clics, frappes et dépôts de fichiers :
  - « importer une publication par arXiv, avec son PDF ; Ctrl+Z » : le nœud posé au point du clic droit, ses tags, son PDF (octet pour octet), son `vaswani2017.bib` ; un Ctrl+Z le retire ;
  - « importer une publication par DOI » : `Shannon_1948`, son `month = jul` ;
  - « importer une publication par un PDF déposé, puis un PDF sans identifiant » : un vrai dépôt de fichier du disque (`Input.dispatchDragEvent`), l'identifiant trouvé dans le PDF remplit le champ, « Importer » garde `attention.pdf` au lieu de télécharger celui d'arXiv ; puis « Créer le nœud » pour `Li_Vitányi_extrait.pdf` ;
  - « hors ligne » : « Pas de connexion. » puis « Identifiant non reconnu. » dans le dialogue, rien de créé, et le pop-up d'un nœud s'ouvre pendant que le dialogue est ouvert ;
  - « en double » : le livre de la base de test, refusé par son titre et son année, puis l'article d'arXiv importé deux fois, le second refusé avant le réseau.
- Ce qu'un scénario ne vérifie pas :
  - le dialogue fermé pendant « Recherche… » : le rejeu répond aussitôt. `importByIdentifier` le vérifie à chaque étape (tests) ;
  - un dépôt de plusieurs fichiers ou d'un fichier qui n'est pas un PDF sur le dialogue : des messages du composant, sans logique à tester ailleurs.
- **Captures** : deux suites neuves de 24 images, la seconde sur le code final. Pour chacune : contre `reference-3c`, 11 sur 11 à 0 pixel ; contre `plan4a`, 8 sur 8 ; contre `plan4b`, 5 sur 5. Aucune image n’est refaite : le menu et le dialogue ne sont dans aucune capture.

### Notes

- **Pour la tâche 6** :
  - `parseBibtex`, `bibFields`, `bibIdentifiers`, `PublicationIndex` (avec `add`), `planPublication` et `publicationBuild` sont prêts. L'import d'un `.bib` entier est une action ; on peut composer les `publicationBuild` dans un `combine`, ou faire un `newNodeBuild` par entrée ;
  - `parseBibtex` tient en mémoire quatre octets par caractère du texte (la table des accolades) : la tâche 6 doit borner la taille du `.bib` qu'elle lit ;
  - deux entrées d'un même fichier dont la clé n'est pas sûre (DBLP) ne sont pas des doublons par la clé : la seconde prend `…b`. Seuls leur DOI, leur identifiant arXiv, ou leur titre et leur année les rapprochent ;
  - une clé en double dans le fichier est signalée par l'analyseur, et les deux entrées sont rendues : c'est `PublicationIndex.add` qui écarte la seconde.

### Revue, ronde 1

La revue (`task-5-review.md`) a demandé cinq corrections : I1, I2 avec M2, M1, M3, et les vraies réponses de Shannon. M4 à M10 sont différés au ledger, et M8 (borner le texte donné à `parseBibtex`) ira à la tâche 6.

- **I1, les guillemets jamais fermés étaient quadratiques.**
  - Le problème : une valeur entre guillemets jamais fermée qui saute des groupes d'accolades, puis une longue queue. Chaque entrée reprise refaisait le parcours jusqu'à la fin : 49 s pour 1,1 Mo.
  - Correction : le parcours entre guillemets s'arrête à la première accolade fermante qui ne ferme aucun de ses groupes (« l'accolade fermante de la ligne N ne ferme rien entre les guillemets. »). BibTeX la refuse aussi. Le chemin de `@preamble` passe par la même fonction.
  - Ce que cela garantit, corrigé à la ronde 2 : un parcours qui commence dans un groupe qu'un autre a sauté finit au plus tard à l'accolade qui ferme ce groupe. Les parcours de deux guillemets différents ne passent donc jamais par le même caractère. Un même guillemet peut être reparcouru par des entrées reprises, et une même queue relue : la lecture n'était pas linéaire au total (re-revue, N1).
  - Mesures : les deux cas de la revue (`@a{k,t="{` et `@preamble{"{`, 10 000 fois, puis 1 000 000 de caractères) prennent ensemble 145 ms au test, contre 53,5 s avant. Toute la sonde `hostile.mjs` du relecteur passe : son pire cas, 100 000 auteurs, prend 360 ms.
- Ruling (contrôleur, I2 et M2) : **une même clé, ou un même titre normalisé et une même année, ne font un doublon que si aucun identifiant ne les contredit.**
  - Il y a contradiction quand les deux côtés ont un DOI et qu'ils diffèrent, ou un identifiant arXiv et qu'ils diffèrent. Un DOI d'un côté et un arXiv de l'autre ne se contredisent pas.
  - `PublicationIndex` garde, pour chaque clé et chaque titre-année, les nœuds qui les portent avec leurs identifiants.
  - Une clé reçue ainsi écartée passe par `citeKey`. Crossref donne `He_2016` à deux articles de He et al. : le second devient `he2016`.
  - Le livre de Li et Vitányi de la base de test reste un doublon : son nœud n'a pas de DOI.
  - Coût si faux : une publication recréée quand deux fiches de la même œuvre portent des DOI différents (un chapitre et son livre, par exemple).
- **M1, les clés comparées sans la casse.** `citeKey` compare désormais la clé propre de l'entrée sans la casse, comme BibTeX : `LI2008`, quand `li2008` est prise, donne `li2008b`.
- **M3, toutes les valeurs indexées.**
  - L'index retient toutes les valeurs des tags `doi`, `arxiv` et `clé_bibtex`.
  - Il lit chaque identifiant par `parseIdentifier` avant `cleanDoi` et `cleanArxiv` : `https://arxiv.org/abs/1706.03762` et `https://doi.org/10.1000%2Fabc` sont lus, et le DOI d'arXiv compte comme l'identifiant arXiv, quel que soit le tag qui le porte.
- **Les vraies réponses de Shannon**, enregistrées par le contrôleur le 2026-11-07, remplacent les réponses composées, octet pour octet. Le texte `about` d'`index.json` le dit. Le CSL réel a `type: "journal-article"`, que rien ne lit.
- Ruling (contrôleur) : **un mois écrit en entier, sans casse (`month=July`, comme l'écrit Crossref), est lu comme la macro de ce mois**, sans problème signalé, et le `.bib` réécrit le met sous sa macro de trois lettres (`month = jul`). Un `@string` du fichier qui définit `july` l'emporte toujours.
- **Vérifications** :
  - tests vus rouges : I1 en 53 514 ms au lieu de moins d'une seconde ; l'ancien message pour l'accolade égarée ; `month=July` signalé comme macro inconnue, le mois vide ; `citeKey` qui rendait `LI2008` ; `He_2016` refusé (« même clé BibTeX ») ; la seconde valeur d'un tag `doi` ignorée ;
  - suites, chaque paquet seul : `core` 127, `view` 246, `app` 397, tous passés ; `tsc` sans erreur dans `core` et `app` ;
  - scénarios : 17 sur 17, dont « importer une publication par DOI » sur les vraies réponses (`month = jul` dans le `.bib`) ;
  - captures : non refaites, rien de ce qui est dessiné n'a changé (l'analyseur et l'index des doublons seulement).

### Revue, ronde 2

La re-revue (`task-5-rereview.md`) a trouvé I1 partiel (N1, préexistant) et un Minor nouveau (N2).

- Ruling (contrôleur, N1) : **un compteur de travail dans `parseBibtex`.**
  - Le problème : une entrée abîmée qui atteint une longue queue la relit en entier, et chaque entrée reprise au « @ » suivant la relit encore. Les valeurs en accolades imbriquées et les commentaires `%` suffisent pour y arriver : 13,2 s pour 2 Mo.
  - La règle : chaque boucle de balayage ajoute au compteur les caractères qu'elle examine. Ce sont l'identifiant, les blancs et commentaires, la clé, les chiffres, le parcours entre guillemets, et la recherche du « @ » suivant avec les blancs examinés derrière lui. Les valeurs en accolades, sautées, restent au budget des valeurs.
  - Le plafond : `BIB_WORK_PER_CHAR` (8) fois la taille du texte, plus `BIB_WORK_SLACK` (1 Mio), une borne fixe de sécurité. Au-delà, la lecture s'arrête, les entrées déjà lues sont gardées, et le problème dit « Le fichier est trop abîmé pour être lu en entier : la lecture s’arrête ligne N. », à la ligne de la commande en cours.
  - Les fichiers réels en sont loin, à 0,4 fois leur taille : `reel-50.bib` (0,39), le même fichier quarante fois, soit 2 000 entrées (0,39), les 2 000 entrées du test dont 20 abîmées (0,44), Shannon de Crossref (0,26), arXiv de DataCite (0,23).
  - Le parcours entre guillemets garde sa règle de la ronde 1 : les parcours de deux guillemets différents ne passent pas par le même caractère. C'est le compteur qui borne le total, et les commentaires « Linear » de `bibtex.ts` ont été corrigés.
  - Coût si faux : un fichier très abîmé, mais légitime, lu en partie seulement.
- Ruling (contrôleur, N2) : **`cleanDoi` retire la ponctuation finale d'un DOI lu** (« . », « , », « ; »). C'est la part de M10 sur le point final, avancée.
  - Pourquoi : un DOI différent est désormais un veto contre un doublon. Un tag `doi: 10.1109/CVPR.2016.90.`, écrit avec le point de la phrase, faisait recréer la publication.
  - `readId` (`build.ts`) passe aussi par `cleanDoi` le DOI que `parseIdentifier` rend, puisque `parseIdentifier` le garde tel qu'il est tapé.
  - `findIdentifier` retirait déjà cette ponctuation avant `parseIdentifier`.
  - Le DOI tapé dans le dialogue part au réseau tel quel, mais sa comparaison avant le réseau retire le point : un doublon est donc dit sans demande.
  - Coût si faux : un DOI qui finirait vraiment par un point (aucun n'est connu) serait lu sans lui.
- **Vérifications** :
  - tests vus rouges : la queue de 2 Mo en 18 529 ms au lieu de moins d'une seconde ; `cleanDoi('10.1109/CVPR.2016.90.')` gardait le point ; le nœud au DOI pointé faisait planifier l'import au lieu de le refuser « même DOI » ;
  - sondes du relecteur : `tail.mjs`, 129 ms (identifiant), 62 ms (blancs) et 87 ms (guillemet) pour 2 Mo, au lieu de 13,2 s, 2,4 s et 2,4 s ; `hostile.mjs` passe en entier ; le fuzz de `probe.mjs`, 107 952 textes, donne les mêmes entrées, et les mêmes nombres et lignes de problèmes qu'avant la ronde 1 ; `dots.mjs` donne « même DOI » pour les formes pointées ;
  - suites, scénarios : voir le rapport de la tâche 5, section « Ronde 2 ».

## Tâche 6 : import d'un fichier `.bib` en un bloc compact

### Fait

- **Cœur, `core/src/bibtex.ts`** :
  - `BIB_MAX_CHARS` (16 × 2^20 caractères) : `parseBibtex` le vérifie lui-même. Au-delà, aucune entrée, et un problème dit la taille et la borne : « Le fichier fait 16 777 217 caractères, plus que les 16 777 216 qu’un .bib peut compter : il n’est pas lu. ». Tous les chemins sont donc bornés, la réponse du serveur de la tâche 5 comprise.
  - `BIB_MAX_BYTES` (2 × `BIB_MAX_CHARS` + 2, soit 32 Mo) : un fichier plus gros ne peut pas être un texte de `BIB_MAX_CHARS` caractères, quel que soit son encodage (UTF-16 avec son BOM, deux octets par caractère). Le principal ne le lit pas.
  - `BIB_NAME_CHARS` (80) et `bibShort` : un nom tiré du fichier (clé, type, champ, macro) est coupé dans les messages de l’analyseur, puis « … », sans couper un caractère en deux. La macro inconnue de 200 000 caractères de la sonde `pct-string` ne finit plus entière dans un message.
  - Le résultat de `parseBibtex` gagne `omitted` (les problèmes non listés au-delà de `BIB_MAX_PROBLEMS`) et `stopped` (pourquoi la lecture s’est arrêtée avant la fin : trop grand, trop d’entrées, trop abîmé). Le type s’appelle `BibRead`.
  - `CiteKeys` : les clés prises, gardées en minuscules, avec pour chaque base le premier suffixe peut-être libre. `citeKey` l’accepte (un `Set` toujours, relu à chaque appel). Une clé fabriquée coûte quelques recherches, même pour 50 000 entrées de même base.
- **Vue, `view/src/block.ts`** : `bibBlock(n, step, p, lines?)` (la grille du bloc, `ceil(√n)` colonnes, rangée par rangée, centrée) et `blockHalves` (ses demi-dimensions, pour le contour du fantôme). Deux réglages avancés du groupe « Publications » : `bibBlockGapPx` (24) et `bibNoticeLines` (5). Le menu du fond offre « Importer un fichier .bib… » (`importBib`), après « Importer une publication… ».
- **Magasin, `store/src/files.ts`** : `storeBytesAsync`, `storeBytes` sans tenir le processus (le même fichier temporaire synchronisé puis renommé), pour que plusieurs écritures se fassent à la fois.
- **Principal** :
  - `main/bib.ts` : `readBib(path, maxBytes)` lit un `.bib` déposé ou choisi, comme `importPaths` (chemin réseau refusé avant tout accès, lien non suivi, dossier refusé), par son descripteur, jamais au-delà de `maxBytes` + 1 octets, dans un tampon à lui. `bibPickOf(env, capture)` : l’entrée de test `CIRRUS_BIB_PICK`.
  - `main/files.ts` : `storeTexts(dir, items, maxBytes)`, des textes enregistrés en un appel, huit à la fois, chacun vérifié comme par `storeText` avant toute écriture, `STORE_TEXTS_MAX` (1 000) par appel, `maxImportMb` en tout. `storeText` et lui partagent `textBytes`.
  - IPC (`main/index.ts`, préchargement, `env.d.ts`) : `cirrus:bib:read` (seulement le chemin d’un dépôt, que le préchargement a vu), `cirrus:bib:pick` (le sélecteur du système, ou `CIRRUS_BIB_PICK`, jamais le sélecteur dans une fenêtre de test), `cirrus:files:store-texts`.
- **Interface** :
  - `publications/bib.ts` : `bibText` (le décodage des aperçus, `decodeText`), `planBib` (les entrées planifiées contre la base et contre les entrées au-dessus d’elles), `bibNotice` (la notification), `storeBibs` (les `.bib` enregistrés par lots de `BIB_STORE_BATCH`), `bibImportBuild` (l’action).
  - `publications/build.ts` : la clé propre seule est une marque (règle du contrôleur) ; `PublicationIndex.add(plan, line)` ; un doublon du même fichier est dit « Déjà plus haut dans le fichier, ligne N (même …) : « titre ». » ; le titre nommé est coupé par `bibShort` ; `keys` est un `CiteKeys`.
  - `files/nodeFiles.ts` : `dropRoute` rend `{ to: 'bib' }` pour un `.bib` seul lâché sur le fond du graphe ; `backgroundNotice` dit quoi faire des autres dépôts sur le fond.
  - `ui/GraphView.tsx` : le geste `{ kind: 'bib' }`, sur le modèle du collage : le fantôme du bloc suit le curseur, un clic le pose, Échap l’abandonne. Le dépôt sur le fond, l’entrée du menu, la notification.
  - `ui/ContextMenu.tsx` (`Ghost` et son contour `box`), `ui/Toasts.tsx` et `styles.css` (`.ghost-block`, `.toast.lines`).
- **Données** : `fixtures/assets/bibliographie.bib`, le `.bib` de la base de test (sept publications, le livre de la base en double, une entrée abîmée). La construction de la base ne le lit pas : la base est inchangée.

### Décisions

Décisions du contrôleur (envoi de la tâche 6), appliquées :

- Ruling (contrôleur, M8) : **`BIB_MAX_CHARS` = 16 × 2^20 caractères dans le cœur, vérifié par `parseBibtex` lui-même** ; au-delà, aucune entrée, un problème dit la taille et la borne. Le principal refuse de lire un fichier plus gros que ce que la borne permet, octets comptés pour un texte UTF-16 : `BIB_MAX_BYTES` = 2 × `BIB_MAX_CHARS` + 2. Un UTF-8 de 17 à 32 Mo est donc lu par le principal, puis refusé par `parseBibtex`, qui dit pourquoi. Coût si faux : un `.bib` énorme refusé, que l’utilisateur coupe.
- Ruling (contrôleur) : **seule la clé propre d’une entrée (celle du fichier ou du serveur) est une marque de doublon** ; une clé fabriquée par `citeKey` est seulement prise. `planPublication` met la clé propre dans `marks` (et non la clé retenue), si bien que `PublicationIndex.add` et la revérification de `publicationBuild` et de `bibImportBuild` suivent la règle. Coût si faux : deux entrées d’un fichier comparées sur une clé que l’une n’a jamais eue.
- Ruling (contrôleur) : **les doublons à l’intérieur du fichier suivent la règle de la base**, par `index.add` après chaque entrée retenue. Deux entrées à clé non sûre ne se comparent que par leurs identifiants et par le titre et l’année.
- Ruling (contrôleur) : **la base ne change qu’au clic, en une action, « Importer <n> publications »** (« Importer une publication » pour une seule), retirée par un seul Ctrl+Z. Échap annule la pose. Pas de réseau.
- Ruling (contrôleur) : **la notification** dit les publications posées, les doublons écartés en nommant le nœud existant, et les problèmes par leur ligne ; chaque liste a au plus `bibNoticeLines` lignes, puis « – et N autres. ». Rien d’importable : rien ne se pose, et elle le dit.
- Ruling (contrôleur) : **le dépôt** : sur le fond, l’import ; sur un nœud, un fichier du nœud ; sur le dialogue de la tâche 5, refusé.
- Ruling (contrôleur) : **« Importer un fichier .bib… »** ouvre le sélecteur du système par le principal, qui lit le fichier. Dans une fenêtre de test, le sélecteur ne s’ouvre jamais : `CIRRUS_BIB_PICK` nomme le fichier, seulement avec `CIRRUS_DATA` et le mode capture ou `CIRRUS_BACKGROUND=1` (comme `CIRRUS_PUBLICATIONS_REPLAY`) ; sans lui, rien n’est choisi, et la console le dit.

Décisions de la tâche :

- Ruling : **le moment d’écriture au magasin : dès que le fantôme paraît, en fond, par lots de 100 (`BIB_STORE_BATCH`), chaque lot écrit huit fichiers à la fois par le principal** (`storeTexts`, `storeBytesAsync`). Le clic attend les `.bib` qui restent, et le fantôme, resté au point du clic, dit l’avancement.
  - Mesures sur ce PC : 2 000 petits fichiers écrits un à un par `storeBytes` prennent 14,2 à 14,8 s, presque tout dans les fsync et la création des fichiers (sans fsync, 2,4 à 3,7 s). Huit à la fois, l’import en prend 5,8 à 6,0 s.
  - Options écartées : écrire avant le fantôme (le fantôme attendrait 6 à 14 s), écrire au clic (le clic attendrait autant), ou `storeText` appelé 2 000 fois (14 s, le principal tenu 7 ms à chaque fois).
  - Les `.bib` d’une pose abandonnée restent au magasin, qui n’efface jamais. Échap arrête l’envoi des lots suivants.
  - Coût si faux : un clic qui attend l’enregistrement (5,6 s pour 2 000 entrées si l’on clique aussitôt), ce que dit le fantôme.
- Ruling : **`citeKey` devient linéaire** (`CiteKeys`) : le `Set` des clés prises était abaissé en entier à chaque appel, et la recherche du suffixe repartait de « b ». 2 000 entrées coûtaient 80 à 99 ms. 50 000 entrées de même base (sans auteur ni année, le même premier mot) auraient pris des minutes ; elles prennent moins d’une seconde. Coût si faux : rien ; un `Set` reste accepté.
- Ruling : **le bloc** est centré sous le curseur, comme le barycentre d’un collage. Il a `ceil(√n)` colonnes, rangée par rangée, et la dernière rangée part de la gauche.
  - Une colonne a la largeur d’une boîte, plus `bibBlockGapPx`. Une rangée a la hauteur de sa plus haute boîte, plus l’écart. Les lignes des titres sont mesurées avec la police, comme la scène les mesure, si bien qu’aucun titre ne déborde sur la rangée suivante.
  - Le pas de la grille n’est donc pas une constante à lui : il suit la taille des boîtes au cran lisible.
  - Coût si faux : un réglage de plus (un pas fixe en lignes).
- Ruling : **tout le bloc entre dans le groupe dont l’enveloppe est sous le curseur**, comme un collage (`groupAt` au point du clic), et non chaque nœud dans le groupe de son propre point. Coût si faux : un nœud du bloc hors de l’enveloppe y entre quand même.
- Ruling : **les réglages** : `bibBlockGapPx` (24, de 0 à 400) et `bibNoticeLines` (5, de 1 à 100), avancés, dans « Publications ».
  - `BIB_NAME_CHARS` (80) est une borne fixe de sécurité du cœur, où les messages de l’analyseur se font, et que la notification reprend : 200 problèmes nommant chacun une macro d’un mégaoctet tiendraient 400 Mo.
  - Les titres nommés par un doublon sont coupés au même nombre, y compris dans les messages de la tâche 5 pour un titre de plus de 80 caractères.
  - `BIB_STORE_BATCH` (100) et `STORE_TEXTS_MAX` (1 000) sont des bornes fixes de l’IPC. Les huit écritures à la fois sont une constante d’entrée-sortie, ni de rendu ni d’interaction.
- Ruling : **le fantôme** reprend l’étiquette du collage (« Importer 7 publications ») et ajoute le contour du bloc tel qu’il serait posé au zoom affiché (`.ghost-block`), recalculé quand le zoom change pendant la pose.
  - Au cran lisible, le contour a à peu près la même taille à l’écran à tous les zooms. Pour 2 000 entrées, il dépasse la fenêtre.
  - Pendant l’enregistrement, l’étiquette dit « · fichiers .bib : 400 / 2 000 ».
- Ruling : **revérification au calcul de l’action** : une publication entrée entre-temps (par ses marques), ou une clé du bloc prise entre-temps (sans la casse), refuse toute l’action, sans rien créer, avec la raison et « Rien n’est importé : recommence l’import du fichier. ». L’utilisateur recommence, et le doublon est alors écarté et nommé. Option écartée : écarter en silence les entrées concernées. Coût si faux : un import à refaire, dans un cas rare (la pose bloque les autres gestes).
- Ruling : **après le clic, Échap n’annule plus** : le clic est l’engagement, le fantôme dit l’avancement jusqu’à l’action. Pendant ce temps, l’import compte comme un geste en cours (Ctrl+Z, un autre `.bib` ou un nœud déposé attendent). Un autre plan affiché d’ici là : rien n’est créé, et la notification le dit. Une perte du focus pendant la pose l’abandonne, comme un collage.
- Ruling : **un `.bib` lâché sur le fond avec d’autres fichiers, ou parmi des fichiers refusés, n’est pas importé** : la notification dit « Dépose un seul fichier .bib à la fois sur le fond du graphe pour l’importer ; un autre fichier se dépose sur un nœud. ».
- Ruling : **la notification** :
  - en tête, les publications posées, ou pourquoi aucune ne l’est (aucune entrée nouvelle, aucune entrée lisible, aucune entrée BibTeX) ;
  - puis la raison d’un arrêt de la lecture, s’il y en a eu un ;
  - puis les doublons, « – ligne 54, « titre » : déjà dans la base (même clé BibTeX) : « nœud existant ». » ;
  - puis les problèmes, « – ligne 79 : message ».
  - Elle passe par une notification de plusieurs lignes (`.toast.lines`), seulement si elle a un saut de ligne : les autres notifications ne changent pas.
  - Sa durée reste `toastMs`.
- Ruling : **le décodage se fait dans l’interface** (`decodeText`, comme les aperçus) : le principal rend les octets, dans un tampon à eux (jamais le tampon commun de Node, dont d’autres octets traverseraient l’IPC). Un binaire est refusé : « « x.bib » n’est pas un fichier texte : rien n’est importé. ».
- Ruling : **le titre d’un doublon** est celui de l’entrée (accents LaTeX convertis), sinon sa clé, sinon « Sans titre ».
- Ruling : **`bibImportBuild` vit dans `publications/bib.ts`**, à côté de `publicationBuild` et des règles des doublons, plutôt que dans `actions.ts` (le brief nomme ce fichier) : il en reprend `readableStep` et `groupAt`. Coût si faux : un déplacement.
- Ruling : **des marques `performance.mark('cirrus:bib:…')`** (le dépôt ou le choix, le fantôme, l’enregistrement fini, le clic, l’action appliquée) servent aux mesures des scénarios. Elles ne coûtent rien, et chacune remplace la précédente.

### Mesures

Toutes trois fois au moins, sur ce PC, la machine chargée par le travail de l’utilisateur.

- **Test unitaire, 2 000 entrées réelles en forme** (`bibImport.test.ts`, analyse, plan contre la base de test, puis calcul de l’action) :
  - avant `CiteKeys` : 193, 222 et 275 ms en tout ;
  - après : 141, 112 et 112 ms, dont 80 à 110 ms pour l’analyse et le plan, et 29 à 32 ms pour l’action.
- **`citeKey` × 2 000 avec un `Set`** : 99, 80 et 82 ms (sonde). Avec `CiteKeys`, 50 000 clés de même base en moins d’une seconde (test).
- **Le magasin, 2 000 petits fichiers** (sonde hors app) :
  - un à un, par `storeBytes` : 14 164, 14 790 et 14 773 ms ;
  - quatre à la fois, en asynchrone : 6 006 et 6 414 ms ;
  - seize à la fois : 4 894 à 6 052 ms ;
  - sans fsync : 2 441 et 3 739 ms.
- **Dans l’application construite, 2 000 entrées** (scénario « un .bib de 2 000 entrées », marques de la page) :

  | Passe | Dépôt → fantôme | Fantôme → `.bib` enregistrés | Clic → action | Clic → image |
  |---|---|---|---|---|
  | 1, clic après l’enregistrement | 141 ms | 5 978 ms | 202 ms | 562 ms |
  | 2, clic après l’enregistrement | 103 ms | 6 023 ms | 232 ms | 596 ms |
  | 3, clic après l’enregistrement | 113 ms | 5 805 ms | 266 ms | 642 ms |
  | 4, clic aussitôt | 111 ms | 5 879 ms | 5 596 ms | 5 640 ms |
  | 5, clic aussitôt | 109 ms | 5 868 ms | 5 585 ms | 5 620 ms |
  | 6, clic aussitôt | 103 ms | 5 882 ms | 5 613 ms | 5 636 ms |

  « Clic → action » va jusqu’à l’action appliquée à l’état de l’interface (calcul, écriture dans la base par le principal, application) ; « → image », jusqu’à deux images de la boucle après elle.

  Le passage complet des scénarios, refait ensuite, donne les mêmes ordres :
  - dépôt → fantôme : 144, 105, 106, 128, 110 et 104 ms ;
  - enregistrement : 5 813, 5 664, 5 672, 5 307, 5 487 et 5 194 ms ;
  - clic → action après l’enregistrement : 241, 224 et 244 ms (→ image : 611, 592 et 611 ms) ;
  - clic aussitôt : 5 054, 5 198 et 4 902 ms.

### Vérifications

- **Tests écrits d’abord**, vus rouges pour la raison attendue :
  - `core/tests/bibtex.test.ts` : `BIB_MAX_CHARS` absent (`expected undefined to be 16777216`), `omitted` et `stopped` absents, `BIB_NAME_CHARS` absent ; puis `CiteKeys is not a constructor` ;
  - `view/tests/block.test.ts` : `block.ts` n’existait pas ;
  - `view/tests/params.test.ts` : `bibBlockGapPx: expected undefined to be 24` ; `menus.test.ts` : le menu du fond sans `importBib` ;
  - `store/tests/files.test.ts` : `storeBytesAsync is not a function` ;
  - `app/tests/publicationImport.test.ts` : la marque était la clé fabriquée (`expected [ 'he2016' ] to deeply equal [ 'He_2016' ]`) ;
  - `app/tests/bibImport.test.ts` : `publications/bib.ts` n’existait pas ;
  - `app/tests/nodeFiles.test.ts` : `expected { to: 'notice' } to deeply equal { to: 'bib' }` ;
  - `app/tests/bibFile.test.ts` : `main/bib.ts` n’existait pas.
- **Suites**, chaque paquet seul, `--maxWorkers=1` : `core` 132 (14 fichiers), `store` 21 (3), `fixtures` 13 (4), `view` 251 (31), `app` 414 (39), `bench/latex` 7, `bench/rendu` 46. Tous passés. `tsc --noEmit -p .` sans erreur dans `core`, `store`, `view` et `app`.
- **Scénarios d’interface** : 21 sur 21, dont quatre nouveaux, par de vrais événements, fenêtre en arrière-plan :
  - « importer un .bib déposé sur le fond » :
    - `bibliographie.bib` est déposé par `dropFiles` ;
    - le fantôme « Importer 7 publications » suit le curseur, avec son contour de 678 × 326 px (trois boîtes de 210 et deux écarts de 24) ;
    - rien n’est créé avant le clic ; un clic pose sept nœuds en trois colonnes et trois rangées autour du point, au cran 0 ;
    - les tags de Shannon sont vérifiés, et chaque nœud a son `<clé>.bib`, lu au magasin ;
    - la notification nomme le livre de la base (« même clé BibTeX ») et l’entrée abîmée (« ligne 79 ») ;
    - un seul Ctrl+Z retire les sept, et le livre reste ;
  - « importer un .bib par le menu du fond (entrée de test) » : `CIRRUS_BIB_PICK`, aucun sélecteur ; Échap retire le fantôme, puis un clic ne crée rien ; choisi de nouveau, un clic pose les sept ;
  - « un .bib déposé sur un nœud en devient un fichier ; sur le dialogue d’import, il est refusé » : le livre de la base gagne `bibliographie.bib` ; le dialogue dit « « bibliographie.bib » n’est pas un PDF. » ; aucun fantôme ni aucun nœud ;
  - « un .bib de 2 000 entrées » : les mesures plus haut, six imports suivis chacun d’un Ctrl+Z.
- **Captures** : une suite neuve de 24 images, sur le code final. Contre `reference-3c`, 11 sur 11 à 0 pixel ; contre `plan4a`, 8 sur 8 ; contre `plan4b`, 5 sur 5. Aucune image n’est refaite : le fantôme du bloc et la notification de plusieurs lignes ne sont dans aucune capture.

### Revue, ronde 1

La revue (`task-6-review.md`) a demandé I1 et sept Minors, M1 à M7. M8 à M12 sont différés au ledger.

- Ruling (contrôleur, I1) : **la notification d’un import de `.bib` reste `bibNoticeMs`** (20 000 ms, de 2 000 à 600 000, réglage avancé de « Publications »).
  - Un clic sur elle, ou un Échap que rien d’autre ne prend, la ferme plus tôt.
  - Elle seule prend les clics (`.toast.closable`) : les autres notifications gardent `pointer-events: none` et `toastMs`.
  - La notification « rien d’importable » la suit aussi, puisqu’elle a ses listes.
  - Un même Échap peut fermer à la fois un panneau flottant et cette notification : les deux écoutent l’Échap que rien n’a pris. C’est accepté.
  - Coût si faux : une notification de 20 s.
- Ruling (contrôleur, M1) : **les marques de clé se comparent sans la casse** (`mark` et `duplicate`), comme BibTeX. La règle de contradiction des identifiants ne change pas.
- Ruling (contrôleur, M2) : **une même clé deux fois dans un fichier n’est dite qu’une fois.**
  - L’entrée porte `repeats` (la ligne de la première), et `repeatedKeyMessage(entry)` est l’unique source du message de l’analyseur.
  - `planBib` retire ce problème pour une entrée écartée comme doublon. S’il n’était pas listé, il ôte un au décompte `omitted`, et la ligne « Et N autres problèmes. » de l’analyseur quand ce décompte tombe à 0.
  - Une clé répétée que des identifiants contredisent (deux publications) garde le problème de l’analyseur, puisque la seconde reçoit une clé fabriquée.
- Ruling (contrôleur, M3) : **les clés propres sûres de tout le fichier sont réservées d’abord** (`CiteKeys.reserve`) : une clé fabriquée les évite, et l’entrée dont c’est la clé propre la garde. Elles ne sont jamais des marques.
  - Un `\cite{li2008}` existant désigne ainsi toujours l’entrée de clé propre `li2008`.
  - **Le test `He_2016` / `he2016` est adapté** : la première entrée reçoit `he2016b` (au lieu de `he2016`), la seconde garde sa clé propre `he2016` (au lieu de `he2016b`), sans être un doublon. Les marques restent `He_2016` et `he2016`.
  - Coût si faux : une clé fabriquée qui saute la clé propre d’une entrée écartée plus bas comme doublon (`foo2008b` au lieu de `foo2008`).
- Ruling (contrôleur, M4) : **pendant l’attente qui suit le clic, rien qui pose quelque chose ne commence.**
  - La forme : un prédicat `bibWaiting()`, sur le modèle de `gestures.busy`. Il est vérifié dans `startPlacing` (Ctrl+V, une amorce, un fantôme absent, une répercussion), à l’ouverture des menus, dans `pick` (un menu resté ouvert) et au glisser d’une amorce.
  - La raison est dite : « Import du .bib en cours : attends que ses publications soient posées. ».
  - Les refus « Un geste est en cours… (Échap) » disent cette raison pendant l’attente (`busyReason`) : Ctrl+Z, un nœud déposé, un autre `.bib`.
  - Seul le fantôme du bloc est redessiné.
  - Pendant l’attente, le fantôme reste au point du clic dans le monde, à l’échelle de son cran, si la vue bouge.
  - Un autre plan affiché pendant l’attente abandonne l’import tout de suite, efface le fantôme, et le dit.
- Ruling (contrôleur, M5) : **`storeBytesAsync` renomme de nouveau un fichier temporaire tenu** (EPERM, EBUSY, EACCES, tant que la destination manque) :
  - trois essais au plus, avec une pause de 30 ms fois l’essai (`RENAME_TRIES`, `RENAME_PAUSE_MS`, des bornes fixes du magasin) ;
  - un temporaire qu’on ne peut retirer (`rm`) ne masque plus le blob présent : c’est `existsSync(dest)` qui décide.
- Ruling (contrôleur, M6) : **la raison donnée par le magasin est dite** (`messageOf`) :
  - `bibStoreFailure(err)` pour le `.bib` : « Les fichiers .bib des publications n’ont pas pu être enregistrés dans la base : <raison>. Rien n’est importé. » ;
  - l’import par identifiant de la tâche 5 ajoute la raison après le sien.
- Ruling (contrôleur, M7) : **l’import par identifiant revérifie au calcul une clé prise entre-temps** (sans la casse), et **refuse** comme `bibImportBuild` : « La clé « he2016 » a été prise entre-temps. Rien n’est importé : recommence l’import. ».
  - Pourquoi refuser plutôt que refaire `citeKey` : le `.bib` du nœud est déjà au magasin sous cette clé, qu’il porte dans son texte. Une autre clé demanderait un autre `.bib`, écrit avant l’action, ce que l’action pure ne peut pas faire.
  - Coût si faux : un import à refaire, dans un cas rare.
- **Vérifications** :
  - tests vus rouges :
    - `bibNoticeMs: expected undefined to be 20000` ;
    - `toastMsFor` absent ;
    - `reserved.reserve is not a function` ;
    - `repeats` absent (`expected [ undefined, undefined ] to deeply equal [ undefined, 1 ]`) ;
    - `Smith2020` puis `smith2020b` planifiés ;
    - le problème de clé répétée dit en plus du doublon, puis la ligne « Et N autres » restée (`expected [ +0, 201 ] to deeply equal [ +0, 200 ]`) ;
    - `li2008b`, `li2008c`, `li2008d` au lieu de `li2008d`, `li2008b`, `li2008c` ;
    - `he2016` puis `he2016b` au lieu de `he2016b` puis `he2016` ;
    - `Li2008` contre `li2008` planifié au lieu d’être refusé ;
    - le renommage sans nouvel essai (`EPERM: operation not permitted, rename`, `expected 1 to be 3`) ;
    - `bibStoreFailure` absent, puis le message de la tâche 5 sans la raison ;
    - `publicationBuild` sans refus de la clé prise (`expected function to throw an error, but it didn't`) ;
  - scénarios vus rouges, les deux corrections désactivées le temps d’un essai : « la notification de l’import n’est plus là après 5 s » ; « Ctrl+V n’est pas refusé » ;
  - suites, chaque paquet seul, `--maxWorkers=1` : `core` 132 (14 fichiers), `store` 23 (4), `view` 251 (31), `app` 419 (40). Tous passés. `tsc --noEmit -p .` sans erreur dans `core`, `store`, `view` et `app` ;
  - scénarios d’interface : 22 sur 22, dont un nouveau. « pendant l’attente d’un .bib posé… » : 2 000 entrées, un clic aussitôt ; Ctrl+V est refusé avec la raison, et le fantôme dit toujours « Enregistrement des fichiers .bib : 600 / 2 000… » ; le menu du fond ne s’ouvre pas ; rien n’est collé. Le scénario du dépôt sur le fond vérifie aussi que la notification est encore là après 5,5 s, puis qu’un clic la ferme ; celui du menu, qu’Échap la ferme. Les mesures de 2 000 entrées restent du même ordre (dépôt → fantôme 100 à 138 ms, clic → action 208 à 240 ms après l’enregistrement) ;
  - captures : non refaites. Le rendu des scènes de référence n’a pas changé : seule une notification qu’un clic ferme prend une classe nouvelle, et aucune capture n’en montre.

## Tâche 7 : mesures, captures et spec

### Fait

- **`packages/app/scripts/cdp.mjs`**, nouveau : `launch`, la fenêtre de Cirrus pilotée par DevTools, sortie telle quelle de `interface.mjs`, qui l'importe désormais. Elle gagne `page.send`, une commande de DevTools telle quelle (la molette des mesures).
- **`packages/app/scripts/mesures-annotations.mjs`**, nouveau, et `npm run mesures -w packages/app [-- bib|ouverture|defilement]` : les mesures de la tâche, trois passes chacune, sur des bases de test neuves, fenêtres en arrière-plan (`CIRRUS_BACKGROUND=1`), sans réseau.
- **`packages/fixtures/scripts/add-reading.ts`**, nouveau : il ajoute à une base de test « lecture_de_mesure.pdf », 25 pages de 40 lignes (122 886 octets), fichier de deux nœuds du lobby :
  - « Lecture de mesure (50 annotations) », en (−700, −300) : deux passages de chaque page annotés, d'une à trois lignes, 101 rectangles, une action chacun, comme l'app les fait ;
  - « Lecture de mesure (sans annotation) », en (−700, −140) : le même fichier, sans annotation.
  - La base de test elle-même ne change pas : ni les tests ni les captures ne lisent ce PDF.
- **`GraphView.tsx`** :
  - deux marques de mesure de plus, `cirrus:bib:read` (le fichier rendu par le principal) et `cirrus:bib:planned` (décodé, analysé, comparé à la base) ;
  - l'enregistrement des `.bib` d'un import compte parmi les chargements des vues (`loading`), qu'une capture attend (`viewsSettled`).
- **`scripts/captures.mjs`** :
  - cinq scènes nouvelles (Vérifications) ;
  - l'option `--only=<scène>,…` ;
  - la sorte `publications`, qui branche `CIRRUS_PUBLICATIONS_REPLAY` sur `tests/data/publications` ;
  - `import.from`, un fichier copié pour être déposé ;
  - l'en-tête nomme `plan4c`, `--only` et le rejeu.
- **`compare-captures.mjs`** : l'en-tête nomme `plan4c`.
- **`docs/captures/plan4c/`**, nouveau : `pdf-surlignages`, `popup-annotations`, `plan-lecture`, `import-publication` et `bloc-bib`. Les autres dossiers de captures n'ont pas de README, celui-ci non plus.
- **La spec** (`2026-11-02-cirrus-design.md`) :
  - section 4 : la ligne de PDF.js, et un bloc « Annotations et publications (plan 4c) », sur le modèle du plan 4b ;
  - section 5.2 : l'`anchor` d'un nœud ;
  - section 5.4 : les tags d'une publication importée (`auteur`, `date_de_publication`, `clé_bibtex`, `doi`, `arxiv`), et le `.bib` en fichier du dossier ;
  - sections 6.3 et 7 : l'exception des annotations retirées de leur dernier plan ;
  - section 12 : la puce « Annotation de PDF » précisée, et le paragraphe « Fixé par le plan 4c » ;
  - section 18 : les sources des publications (`PUBLICATION_SOURCES`) ;
  - section 19 : les groupes « Annotations » et « Publications » sous « Fichiers ».

### Mesures

Toutes dans l'app construite, trois passes chacune, sur ce PC (Ryzen 7 7435HS, 16 Go, environ 3 Go libres), la machine chargée par le travail de l'utilisateur. Les fenêtres sont hors des écrans, sans focus (`CIRRUS_BACKGROUND=1`, focus émulé). Leurs images se suivent à environ 10,7 ms.

- **L'analyse d'un `.bib` de 2 000 entrées** (seuil : moins d'une seconde).
  - Deux fichiers :
    - « réelles » : les cinquante références de `core/tests/data/reel-50.bib` (JabRef, Scholar, DBLP, Crossref, à la main : `@string`, `#`, mois, accents, `@comment`, `@preamble`, `%`), quarante fois, chaque copie avec sa clé, son titre, son DOI et son identifiant arXiv. Cela fait 2 000 entrées distinctes, 596 Ko, sans problème ni doublon ;
    - « de la tâche 6 » : les 2 000 entrées de six lignes du scénario de la tâche 6, 359 Ko.
  - `parseBibtex` seul, sous Node 26 (le même code que l'app) :

    | Entrées | Passe 1 | Passe 2 | Passe 3 |
    |---|---|---|---|
    | réelles | 30,7 ms | 20,6 ms | 18,2 ms |
    | de la tâche 6 | 14,7 ms | 12,5 ms | 10,9 ms |

  - Dans l'app, par les marques de l'import, le fichier déposé sur le fond :

    | Entrées, passe | Dépôt → fichier lu | Lu → analysé et planifié | → fantôme | Dépôt → fantôme |
    |---|---|---|---|---|
    | réelles, 1 | 25 ms | 111 ms | 21 ms | 156 ms |
    | réelles, 2 | 13 ms | 87 ms | 14 ms | 114 ms |
    | réelles, 3 | 12 ms | 88 ms | 13 ms | 114 ms |
    | tâche 6, 1 | 16 ms | 95 ms | 8 ms | 119 ms |
    | tâche 6, 2 | 13 ms | 114 ms | 10 ms | 137 ms |
    | tâche 6, 3 | 14 ms | 88 ms | 9 ms | 111 ms |

    « Analysé et planifié » compte le décodage, l'analyse, et la comparaison de chaque entrée avec la base et avec les entrées au-dessus d'elle (`planBib`). « → fantôme » compte la mesure des titres et le bloc.
  - **Le seuil est tenu** : l'analyse seule prend de 11 à 31 ms, et tout ce qui précède le fantôme de 111 à 156 ms, au plus 16 % de la seconde.
- **La pose de ces 2 000 entrées**, le clic donné une fois les `.bib` enregistrés. Il n'y a pas de seuil. La tâche 6 mesurait 202 à 266 ms jusqu'à l'action, et 562 à 642 ms jusqu'à l'image.

  | Entrées, passe | Fantôme → `.bib` enregistrés | Clic → action | Clic → image |
  |---|---|---|---|
  | réelles, 1 | 5 709 ms | 223 ms | 598 ms |
  | réelles, 2 | 5 659 ms | 238 ms | 614 ms |
  | réelles, 3 | 5 431 ms | 241 ms | 614 ms |
  | tâche 6, 1 | 5 312 ms | 246 ms | 615 ms |
  | tâche 6, 2 | 5 311 ms | 561 ms | 938 ms |
  | tâche 6, 3 | 5 095 ms | 205 ms | 581 ms |

  - « Clic → action » va jusqu'à l'action appliquée à l'état de l'interface : calcul, écriture dans la base par le principal, application. « → image » va jusqu'à deux images de la boucle après elle. L'image qui montre les 2 000 nœuds vient environ 370 ms après l'action.
  - Une passe sur six prend 561 ms jusqu'à l'action, comme la première passe du scénario de la tâche 6 dans `npm run interface` (510 ms). La cause n'est pas établie : le ramasse-miettes, ou l'écriture de la base.
- **L'ouverture d'un PDF de 50 annotations** : « lecture_de_mesure.pdf » ouvert depuis le pop-up de son nœud, dans son aperçu (1 000 × 820 px). La mesure va du clic sur le fichier à la page 1 dessinée, à son texte, à ses 5 rectangles et à la marge de 50 lignes, puis à l'image qui suit.
  - Le même fichier sans annotation sert de témoin, dans un aperçu plus étroit de la largeur de la marge (760 px). Les deux lecteurs ont 743 px et le même zoom, 91 %.
  - À froid, le premier PDF de la session (pdf.js et son travailleur chargés) :

    | Passe | Page 1 dessinée | Son texte | Ses surlignages | La marge | Tout → image | Sans annotation → image |
    |---|---|---|---|---|---|---|
    | 1 | 340 ms | 361 ms | 328 ms | 6 ms | 390 ms | 381 ms |
    | 2 | 333 ms | 354 ms | 321 ms | 6 ms | 389 ms | 377 ms |
    | 3 | 339 ms | 360 ms | 323 ms | 6 ms | 384 ms | 374 ms |

  - À chaud, l'aperçu fermé puis rouvert :

    | Passe | Page 1 dessinée | Son texte | Ses surlignages | La marge | Tout → image | Sans annotation → image |
    |---|---|---|---|---|---|---|
    | 1 | 29 ms | 21 ms | 14 ms | 3 ms | 45 ms | 34 ms |
    | 2 | 27 ms | 21 ms | 14 ms | 5 ms | 45 ms | 35 ms |
    | 3 | 27 ms | 22 ms | 14 ms | 3 ms | 45 ms | 35 ms |

  - Les surlignages paraissent avant le canevas : leur couche vient avec la page lue, avant la fin de son dessin.
  - Les annotations coûtent de 9 à 12 ms à froid, et 10 à 11 ms à chaud. La part de la marge et celle de la couche des surlignages n'ont pas été séparées.
- **Le dessin des surlignages pendant le défilement.**
  - Le geste : l'aperçu ouvert à la page 1, défilé jusqu'à la fin par la molette, 24 994 px en 11 s environ. C'est un vrai défilement de Chromium, par `Input.dispatchMouseEvent` (`mouseWheel`, 100 px toutes les 16 ms).
  - Ce qui est noté :
    - à chaque image, par une boucle `requestAnimationFrame` : son heure, le défilement, les pages en vue (par leur place et le défilement, sans mise en page), les pages qui portent une couche de surlignages, leurs rectangles et leurs canevas ;
    - le rendu qui suit chaque image, par une tâche postée ;
    - les images longues, de 50 ms et plus, par un `PerformanceObserver` (`long-animation-frame`).

  | Passe | Images | Intervalle p50 | p95 | max | Au-delà de 1,5 × p50 | Rendu p95 | Images longues |
  |---|---|---|---|---|---|---|---|
  | 50 annotations, 1 | 1 051 | 10,6 ms | 11,2 ms | 21,3 ms | 1 | 1,3 ms | 0 |
  | 50 annotations, 2 | 1 064 | 10,7 ms | 11,2 ms | 21,7 ms | 1 | 1,3 ms | 0 |
  | 50 annotations, 3 | 1 056 | 10,7 ms | 11,2 ms | 22,3 ms | 2 | 1,3 ms | 0 |
  | sans annotation, 1 | 1 073 | 10,7 ms | 11,2 ms | 15,8 ms | 0 | 1,2 ms | 0 |
  | sans annotation, 2 | 1 054 | 10,6 ms | 11,2 ms | 14,2 ms | 0 | 1,2 ms | 0 |
  | sans annotation, 3 | 1 034 | 10,7 ms | 11,2 ms | 17,1 ms | 1 | 1,2 ms | 0 |

  - Le temps par image ne change pas avec les surlignages, ni en médiane ni au p95. Une ou deux images sur mille en prennent deux (21 à 22 ms), contre zéro ou une sans eux.
  - **La preuve que seules les pages dessinées portent leurs surlignages**, la même aux trois passes :
    - au plus 2 pages en vue, et au plus 4 avec leurs surlignages, sur 25 qui en ont toutes. Au plus 17 rectangles dans la page, sur 101 ;
    - les 25 pages les ont reçus tour à tour ;
    - aucune page ne les reçoit avant d'être en vue ou à une page d'elle (`pdfPagesAhead`, 1) : 0 fois ;
    - ceux d'une page qui en sort restent en tout 34 ou 35 images, au plus 5, 6 et 5 images après (54, 64 et 53 ms), et toujours avec son canevas (0 fois sans). Le lecteur lâche la page au rendu suivant de React, et ses surlignages avec elle ;
    - une page en vue et dessinée n'est jamais sans les siens (0 fois).
  - Une première série, avant que les deux lecteurs aient la même largeur, a donné les mêmes ordres : intervalles p50 10,7 ms et p95 11,2 ms des deux côtés. Le témoin, sans marge, y avait un plus fort zoom et 33 485 px à défiler.

### Décisions

- Ruling: **les mesures ont leur script, `mesures-annotations.mjs`, et non des scénarios de `interface.mjs`.** Elles prennent environ quatre minutes (six lancements et six imports de 2 000 entrées), et n'ont ni réussite ni échec à vérifier. `launch` passe dans `cdp.mjs`, que les deux scripts importent.
  - Options : des scénarios de `npm run interface`, qui s'allongerait d'autant ; un script à part (choix).
  - Coût si faux : déplacer trois fonctions.
- Ruling: **le PDF de 50 annotations vient d'un script de mesure, `add-reading.ts`, et non de la base de test.** La base de test, que lisent les tests et les captures, ne change pas.
  - Le PDF a 25 pages : le défilement passe par beaucoup de pages et en laisse la plupart hors de la vue.
  - Ses lignes commencent et finissent par leur numéro, `(07) … 07.`, pour que chaque passage commence et finisse sur une ligne à lui (`passage`).
  - Un second nœud porte le même fichier, sans annotation : le témoin a les mêmes octets, et rien d'autre ne diffère.
  - Coût si faux : une fonction de plus dans `fixtures/src`.
- Ruling: **« les pages visibles » de la contrainte sont les pages que le lecteur dessine** : celles de la vue, et `pdfPagesAhead` (1) de chaque côté, comme leurs canevas.
  - Options : les pages strictement en vue, par le réglage existant à 0 (`pdfPagesAhead`) ; les pages dessinées (choix).
  - Pourquoi : un surlignage suit le dessin de sa page. Une page dessinée d'avance montre les siens dès qu'elle entre dans la vue, sans éclair. Mesuré : jamais avant, et partis avec le canevas.
  - Coût si faux : `pdfPagesAhead` à 0, ou une condition dans `PdfPage`.
- Ruling: **l'analyse se mesure de deux façons** : `parseBibtex` seul, sous Node, et dans l'app, entre deux marques nouvelles, `cirrus:bib:read` et `cirrus:bib:planned`.
  - L'app ne sépare pas l'analyse de la comparaison avec la base : les deux se font dans `planBib`. Une marque dans `bib.ts`, un module pur, y mettrait un effet de bord.
  - Coût si faux : nul.
- Ruling: **les 2 000 entrées réelles sont `reel-50.bib` quarante fois**, chaque copie avec sa clé, son titre, son DOI et son identifiant arXiv, nouveau ou ancien.
  - Sans cela, l'import écarterait 1 950 doublons, comme à la mesure de la tâche 5, et ne poserait que 50 publications.
  - Vérifié par une sonde : 2 000 entrées, aucun problème, aucune marque de doublon commune.
  - Coût si faux : nul.
- Ruling: **l'enregistrement des `.bib` d'un import compte parmi les chargements des vues** (`loading`). Une capture attend ces chargements (`viewsSettled`).
  - Sans cela, rien n'attendait l'enregistrement, et l'étiquette de `bloc-bib` pouvait dire « · fichiers .bib : n / 7 » selon le disque.
  - Seule l'attente des captures lit cet ensemble. Pas de test unitaire : la capture le vérifie, identique d'une suite à l'autre.
  - Coût si faux : nul pour l'utilisateur.
- Ruling: **`import-publication` montre le dialogue avant « Importer », l'identifiant arXiv tapé dans son champ** (`CIRRUS_CLICK`, `type:arXiv:1706.03762`). Le rejeu est branché tout de même (`publications`), et rien ne part.
  - Options :
    - un PDF déposé sur le dialogue, l'identifiant trouvé dans le champ. Une capture ne sait pas déposer sur le dialogue : il prend un `FileList`, et un fichier fait par un script n'a pas de chemin (`getPathForFile`) ;
    - l'import fait, sur le rejeu : le dialogue se ferme ;
    - l'identifiant tapé (choix).
  - Coût si faux : une option de capture qui dépose un fichier sur un élément, par DevTools.
- Ruling: **`bloc-bib` dépose le `.bib` de la base de test sur le ciel par `CIRRUS_IMPORT`**, et non par le menu du fond et `CIRRUS_BIB_PICK`. La capture attend le dépôt avant ses clics et ses chargements. La réponse du sélecteur, une IPC, pouvait au contraire venir après l'image.
  - Coût si faux : nul.
- Ruling: **le cadre de deux scènes.**
  - `pdf-surlignages` ferme le pop-up de la publication une fois l'aperçu ouvert (`.node-popup .close`). L'aperçu, de 1 000 px, s'ouvre à gauche du pop-up et le couvrait en partie.
  - `plan-lecture` a sa vue, (0, −20) au zoom 1,6. Le cadrage par défaut du plan, au zoom 4,3 environ, coupait le titre du groupe.
  - Coût si faux : nul.
- Ruling: **`captures.mjs` prend `--only=<scène>,…`**, pour mettre une scène au point. Les références se vérifient toujours sur des suites entières.
  - Coût si faux : nul.
- Ruling: **la spec gagne aussi un bloc à la section 4 et une ligne à la section 6.3**, au-delà des sections demandées (5.2, 5.4, 7, 12, 18 et 19). Le plan 4b avait fait de même pour la section 4, et la section 6.3 disait « un objet retiré de son dernier plan y va » sans l'exception.
  - Coût si faux : deux paragraphes.

### Vérifications

- **Tests** : aucun test nouveau. La tâche ajoute deux marques de mesure, une attente des captures, et des scripts de mesure et de capture (Rulings plus haut).
- **Suites**, chaque paquet seul, `--maxWorkers=1` : `core` 132 (14 fichiers), `store` 23 (4), `fixtures` 13 (4), `view` 251 (31), `app` 419 (40), `bench/latex` 7 (1), `bench/rendu` 46 (7). Tous passés, 891 en tout.
- **`tsc --noEmit -p .`** : sans erreur dans `core`, `store`, `fixtures` (ses scripts compris, donc `add-reading.ts`), `view`, `app`, `bench/latex` et `bench/rendu`.
- **Scénarios d'interface** (`npm run interface`) : 22 sur 22. Aucun n'est ajouté : les mesures ont leur script.
- **Captures** :
  - deux suites neuves de 29 images, sur le code final, dans le scratchpad ;
  - **déterminisme** : les deux suites sont identiques au pixel (`compare-captures.mjs`, 29 sur 29, 0 à regarder), et même octet pour octet (`cmp`, 29 sur 29) ;
  - les cinq images nouvelles de la première suite sont la référence `plan4c` ;
  - la seconde suite, contre `reference-3c` : 11 sur 11 à 0 pixel ; contre `plan4a` : 8 sur 8 ; contre `plan4b` : 5 sur 5 ; contre `plan4c` : 5 sur 5. La première, contre les trois premières, est aussi à 0 pixel ;
  - aucune image des références existantes n'est refaite ;
  - les cinq scènes, regardées :
    - `pdf-surlignages` : le chapitre à 91 %, le passage de la page 1 surligné sur ses deux lignes, et la marge de trois annotations. On y lit la version précédente, « dans aucun plan » ; la page 1, « Lecture », avec son liseré ; la page 2, « dans aucun plan » ;
    - `popup-annotations` : le pop-up entier de la publication, ses fichiers et sa section « Annotations » de trois lignes ;
    - `plan-lecture` : le groupe « An Introduction to Kolmogorov Complexity and Its Applications », son titre entier, et l'annotation de la page 1 dans son enveloppe ;
    - `import-publication` : le dialogue en haut du graphe, « arXiv:1706.03762 » dans son champ, « Importer », l'indication et « Fermer » ;
    - `bloc-bib` : « Importer 7 publications » au milieu du contour du bloc (678 × 326 px), sur le ciel, à gauche de la publication.

### Notes

- Les mesures se refont par `npm run mesures -w packages/app`, ou par `node scripts/mesures-annotations.mjs bib|ouverture|defilement` après une construction.
- Points d'attention :
  - l'image qui suit la pose de 2 000 publications vient environ 370 ms après l'action : la scène se refait avec 2 000 nœuds de plus. C'est l'ordre de la tâche 6 ;
  - une pose sur six a pris 561 ms jusqu'à l'action, au lieu d'environ 230 ms, sans cause établie ;
  - l'ouverture à froid d'un PDF reste dominée par le chargement de pdf.js, avec ou sans annotations : environ 0,34 s pour la première page.

## Revue finale : les corrections

La revue de tout le plan (`e4d957f..b2c5657`) a demandé deux Important, I1 et I2. Le contrôleur y a ajouté M5 et M6, passés Important, et deux Rulings révisés, R1 et R2. Les autres Minors (M1 à M4, le plein écran d'une version précédente, la paire préprint et actes) restent différés au ledger.

### Fait

- **I1, l'annotation demandée depuis un pop-up est montrée une seule fois.**
  - L'aperçu la consommait à chaque montage (`useEffect` sur `reveal.seq`, qui tourne aussi au montage). Or l'aperçu se démonte pendant que son fichier est en plein écran, et se remonte au retour ou à une version nouvelle (`key={f.hash}`).
  - Désormais, `AnnotatedPdf` la montre puis le dit (`AnnotationContext.onRevealed(seq)`). Le panneau la lâche alors (`withoutReveal`, dans `Panels.tsx`). Une demande plus récente, faite entre-temps, reste.
  - Monté de nouveau, l'aperçu n'a donc plus rien à rejouer : il s'ouvre où le plein écran l'a laissé, sans clignoter, et ne rouvre pas une version précédente quittée par « Revenir à la version actuelle ».
- **I2, un menu sur une ligne d'annotation.**
  - Un clic droit sur une ligne, dans la marge du lecteur (`AnnotationMargin`) ou dans la section « Annotations » du pop-up (`NodePopup`), ouvre son menu. Les deux listes partagent `useAnnotationMenu`, sur l'idiome du menu d'un fichier (`ContextMenu`). Les items viennent de `annotationMenu` (`files/annotations.ts`), une fonction pure, comme `fileMenu`.
  - « Ouvrir sa fiche » ouvre le pop-up de l'annotation à côté du panneau. Le chemin est celui d'un lien : `onNodeLink`, puis `Panels.openLinked`.
  - « Supprimer » appelle `deleteAnnotationBuild` (`actions.ts`), qui fait `deleteEverywhere` : une action, un Ctrl+Z. Le libellé devient « Supprimer partout » quand l'annotation figure dans un plan.
  - Dans le plein écran, le menu n'offre que « Supprimer ». Ce pas entre dans `fullSteps`, comme une annotation faite là : son Ctrl+Z et son Ctrl+Y le défont et le refont.
  - Le menu est en position fixe dans le plein écran comme dans un panneau (`styles.css`).
- **R1 révisé, la clé propre gardée quand BibTeX et LaTeX la lisent.**
  - `safeCiteKey` (`core/src/bibtex.ts`) accepte l'ASCII imprimable, sans blanc ni `\ { } % # , ~ " ' ( ) =`, sans `://` ni `^^`, 200 caractères au plus. Elle ne regarde plus les noms réservés de Windows.
  - Le nom du fichier vient de `bibFileName(key)`, une fonction nouvelle :
    - `< > : " / \ | ? *` y deviennent `_` ;
    - un nom réservé de Windows reçoit `_` après le mot réservé : `con_.bib`, `nul_.x.bib`.
  - `planPublication` (`publications/build.ts`) écrit l'entrée sous la clé gardée, dans le fichier que nomme `bibFileName`. `planBib` réserve désormais aussi les clés de DBLP. Les documentations de `citeKey` et de `CiteKeys` le disent.
  - Les clés `DBLP:conf/nips/VaswaniSPUJGKP17`, `Hinton:2006` et `DBLP:journals/ppi/Kolmogorov65` (la base de test) sont gardées. L'adresse de DataCite reste remplacée, par `hinton2015` ou `vaswani2017`.
- **R2 révisé, le premier auteur dans la règle du titre et de l'année.**
  - `familyName(author)` (`core/src/bibtex.ts`) donne le nom de famille d'un auteur, sans casse, accents, ponctuation ni blancs :
    - il accepte « Prénom Nom » et « Nom, Prénom », lus par `bibNames`, sans les particules ;
    - un « Jr. », « Sr. », « II », « III » ou « IV » final est d'abord retiré.
  - Les marques (`Marks`, `Holder`) portent `author` :
    - pour un nœud, son premier tag `auteur` ;
    - pour un import, son premier auteur « Prénom Nom », celui que son nœud portera.
  - `PublicationIndex.duplicate` refuse une correspondance par titre et année quand les deux côtés ont un premier auteur et que leurs noms diffèrent. C'est la règle de contradiction des identifiants (`agrees`). La correspondance par clé ne change pas.
- **M5, une ligne de spec.** La spec 6.5 gagne « Références d'un fichier » : les empreintes des ancres sont des références de fichiers, que la synchronisation (plan 5), le serveur et « Poids de l'historique » (6.3) comptent comme telles. La 5.2 y renvoie, en une phrase.
- **M6, la garde de `add-reading.ts`.**
  - `fixtures/src/testBase.ts`, nouveau :
    - `userBaseDir(env)` donne `%APPDATA%\@cirrus\app\base` ;
    - `isUserBase(dir, env)` compare sans la casse et suit les liens ;
    - `testBaseRefusal(dir, env)` refuse la base de l'utilisateur, un dossier sans base, et une base dont le journal ne commence pas par une ligne signée `FIXTURE_PC` (« fixture »). Il lit le journal en lecture seule.
  - `add-reading.ts` refuse ce que `testBaseRefusal` refuse, puis prend le verrou de la base (`lockBase`), qu'il rend à la fin.
  - `lockBase` passe de `app/src/main/lock.ts` à `@cirrus/store` (`store/src/lock.ts`). `app/src/main/lock.ts` le réexporte.
  - `make-fixture.ts` signe par `FIXTURE_PC`, et refuse la place de la base de l'utilisateur.
- **La spec** (`2026-11-02-cirrus-design.md`) :
  - 5.2 : l'empreinte d'une ancre est une référence de fichier ;
  - 5.4 : seul le nom du `<clé>.bib` est nettoyé ;
  - 6.5 : « Références d'un fichier » (M5) ;
  - 7 : « Supprimer » dans le menu d'une ligne met une annotation à la corbeille, même hors de tout plan ;
  - 12 : « La clé BibTeX » et « Les doublons » réécrits (R1, R2), « Ouvrir une annotation » une seule fois (I1), « Le menu d'une ligne » (I2).
- **La base de test** : le commentaire de `fixtures/assets/bibliographie.bib` dit la clé de DBLP gardée, au même nombre de lignes. Les numéros de ligne des entrées ne changent pas.
- **`interface.mjs`** :
  - la clé de DBLP de la base de test, dans `BIB_KEYS`, et son fichier par `bibFileName` (importé de `@cirrus/core`) ;
  - trois scénarios nouveaux, marqués « (revue finale) ».

### Décisions

- Ruling (I1) : **le panneau lâche l'annotation une fois montrée** (`onRevealed`, puis `withoutReveal`).
  - Options :
    - garder le dernier `seq` traité hors du composant, dans `views` sous `reveal:<hash>` ;
    - le rappel qui retire `reveal` du panneau (choix).
  - Pourquoi : `views` est gardé par PC dans `localStorage`, et le compteur des demandes (`reveals`) repart de 0 à chaque lancement. Un `seq` gardé d'une session pourrait masquer la première demande de la suivante. Le panneau, lui, dit seul ce qui reste à montrer.
  - Coût si faux : une fonction pure de `Panels.tsx` et un rappel.
- Ruling (I2) : **pas de dialogue avant « Supprimer »**.
  - Pourquoi : la question du graphe sert à choisir entre « ici » et « partout », et une ligne n'a pas d'« ici ». Il n'existe aucun avertissement propre à « partout ». Le menu est déjà le choix explicite, et Ctrl+Z le défait.
  - Ce qui le remplace : le libellé « Supprimer partout » quand l'annotation figure dans un plan, qu'elle quitte aussi. Sa ligne nomme ces plans juste à côté.
  - Coût si faux : un `AskDialog` à ouvrir dans la marge et dans le plein écran.
- Ruling (I2) : **en plein écran, une annotation posée dans un plan se supprime aussi.** Ce pas change le graphe caché, mais c'est un pas de ce plein écran : son Ctrl+Z le défait là.
  - La règle de la revue de la tâche 5 ne vise que Ctrl+Z sur les pas faits avant le plein écran.
  - Coût si faux : n'offrir « Supprimer » qu'aux annotations hors plan, en plein écran.
- Ruling (I2) : **`deleteAnnotationBuild` refuse, au calcul, un nœud absent, sans ancre, ou déjà à la corbeille.** Les refus disent « Cette annotation n'existe plus. », « Ce nœud n'est pas une annotation. » et « Cette annotation est déjà supprimée. » : une ligne restée affichée un instant de trop ne refait pas une action.
- Ruling (I2) : **« Ouvrir sa fiche » passe par `onNodeLink`**, le chemin d'un lien. Le pop-up s'ouvre à côté du panneau, ou passe devant s'il est ouvert, et un nœud absent se dit (« Ce nœud n'existe plus. »).
- Ruling (R1) : **`^^` est refusé aussi**, en plus des conditions du Ruling. TeX le lit comme un code de caractère, et le pilote ne l'injecte jamais (`injectable`, `main/latex/driver.ts`) : une telle clé ne se compilerait dans aucun résumé.
  - Coût si faux : une clé de plus fabriquée, dans un cas qu'aucune bibliographie réelle ne présente.
- Ruling (R1) : **la clé seule n'évite plus les noms réservés de Windows.** Une clé `aux` reste `aux`, et `@misc{, author = {Con, A.}}` donne `con` au lieu de `conb`. Seul le fichier les évite : `aux_.bib`, `con_.bib`.
  - Coût si faux : nul pour LaTeX, que ces noms ne gênent pas.
- Ruling (R1) : **les tests où `DBLP:x/1` tenait le rôle d'une clé non sûre prennent une adresse** (`https://example.org/x/1`).
  - Ce sont, dans `bibImport.test.ts`, les doublons dans le fichier, la réserve des clés propres et la clé fabriquée prise entre-temps ; dans `bibtex.test.ts`, la réserve de `CiteKeys`.
  - Leur sens ne change pas. Un cas nouveau vérifie que deux `DBLP:x/1` sont désormais un doublon par la clé, dit une fois.
- Ruling (R2) : **le nom de famille se lit des deux côtés sur « Prénom Nom », avec la même fonction.**
  - Options :
    - le dernier mot ;
    - `bibNames` sur l'entrée, pour l'import ;
    - `familyName` sur « Prénom Nom » des deux côtés (choix).
  - Pourquoi : un nœud n'a que son tag « Prénom Nom ». Un nom entre accolades, `{Groupe de travail}`, relu depuis son tag, donnerait un autre nom de famille que l'entrée elle-même. `bibNames` fait mieux que le dernier mot : il lit « Nom, Prénom » et les particules, et un « Jr. » final est retiré.
  - Coût si faux : deux nœuds pour une même œuvre quand un seul côté écrit « Jr. » sans virgule devant un nom qui n'est pas le dernier mot, ce qui est rare.
- Ruling (R2) : **le nom de famille ne se calcule que pour une marque de titre et d'année.** Un nœud sans année n'en a pas besoin, et `PublicationIndex.of` ne lit pas les auteurs de toute la base pour rien.
- Ruling (M5) : **la ligne va à la 6.5**, la section des fichiers, que la synchronisation et le serveur liront. La 5.2 y renvoie en une phrase.
- Ruling (M6) : **la marque d'une base de test est la signature de son journal.** La première ligne doit être signée « fixture » (`FIXTURE_PC`).
  - Options :
    - un fichier marqueur écrit par `make-fixture.ts`, qu'une copie de dossier emporterait ;
    - le contenu de la base de test (le plan « Lecture », les tags `doi` et `arxiv`), que la vraie base peut avoir ;
    - la signature du journal (choix).
  - Pourquoi : `make-fixture.ts` signe « fixture », et l'app signe par l'identifiant de `pc.json`, un uuidv7, jamais ce mot. Elle se lit en lecture seule, sans rien écrire.
  - Le chemin `%APPDATA%\@cirrus\app\base` est refusé avant toute lecture, même s'il contient une base de test copiée là.
  - Sans `APPDATA` (un autre système), la marque seule protège.
  - Coût si faux : un script refusé sur une base de test d'un autre genre, ce qu'aucun script ne fait.
- Ruling (M6) : **`lockBase` passe dans `@cirrus/store`.** Le paquet `fixtures` ne peut pas importer `app`, qui dépend de lui. Le magasin tient déjà le dossier de la base, et `app/src/main/lock.ts` réexporte.
  - Coût si faux : un fichier à déplacer de nouveau.
- Ruling (M6) : **`make-fixture.ts` refuse aussi la place de la base de l'utilisateur.** Sinon, l'app ouvrirait une base de test comme si c'était la sienne.
  - Coût : trois lignes.

### Vérifications

- **Tests vus rouges**, chacun avant sa correction :
  - I1 :
    - `withoutReveal is not a function` ;
    - le scénario « (revue finale, I1) », la correction de `Panels` absente : « l'aperçu revient à la page 2, le passage clignotant, et non à la page 1 que le plein écran a laissée ».
  - I2 :
    - `annotationMenu is not a function` et `deleteAnnotationBuild is not a function` ;
    - les deux scénarios « (revue finale, I2) » : « le clic droit n'ouvre pas le menu de la ligne », et de même en plein écran.
  - R1 :
    - `expected 'conb' to be 'con'` ;
    - `expected 'vaswani2017' to be 'DBLP:conf/nips/VaswaniSPUJGKP17'` ;
    - `DBLP:conf/nips/VaswaniSPUJGKP17: expected false to be true` ;
    - `bibFileName is not a function` ;
    - côté app, `expected 'DBLP:conf/nips/VaswaniSPUJGKP17.bib' to be 'DBLP_conf_nips_VaswaniSPUJGKP17.bib'`, et de même pour `DBLP:journals/ppi/Kolmogorov65` et `DBLP:x/1`.
  - R2 :
    - `familyName is not a function` ;
    - `expected [ 'smith2020' ] to deeply equal [ 'smith2020', 'doe2020' ]`.
  - M6 : `Cannot find module '../src/testBase.ts'`. Puis, contre les deux scripts d'origine remisés le temps d'un essai, `expected +0 to be 1` deux fois : `add-reading.ts` écrivait dans la fausse base de l'utilisateur, et `make-fixture.ts` en bâtissait une à sa place.
- **Suites**, chaque paquet seul, `--maxWorkers=1`, toutes passées, 902 en tout :
  - `core` 135 (14 fichiers) ;
  - `store` 23 (4) ;
  - `fixtures` 16 (5) ;
  - `view` 251 (31) ;
  - `app` 424 (40) ;
  - `bench/latex` 7 (1) ;
  - `bench/rendu` 46 (7).
- **`tsc --noEmit -p .`** : sans erreur dans les sept paquets.
- **Les tests ne touchent jamais la vraie base.** Ceux de M6 miment sa place sous un `%APPDATA%` temporaire, passé à la garde et au processus du script.
- **Scénarios d'interface** (`npm run interface`) : 25 sur 25, dont trois nouveaux, par de vrais clics :
  - « (revue finale, I1) » : le menu de la ligne du pop-up, qu'Échap ferme seul ; un clic sur la ligne « p. 2 » ouvre l'aperçu à la page 2, le passage clignotant. Puis ⤢, la page 1 tapée dans le plein écran, Échap : l'aperçu revient à la page 1, et reste deux secondes sans clignoter ;
  - « (revue finale, I2) » dans la marge : la page 2 en vue, son surlignage dessiné. Le menu de la ligne offre « Ouvrir sa fiche » et « Supprimer ». « Ouvrir sa fiche » ouvre le pop-up de l'annotation, qu'Échap ferme seul. « Supprimer » met l'annotation à la corbeille, et son surlignage et sa ligne partent. Ctrl+Z les rend ;
  - « (revue finale, I2) » en plein écran : le menu n'offre que « Supprimer ». Ctrl+Z rend l'annotation, Ctrl+Y la supprime de nouveau, et le plein écran reste ouvert.
- **Captures** : une suite neuve de 29 images, sur le code final, dans le scratchpad. Contre `reference-3c` : 11 sur 11 à 0 pixel ; contre `plan4a` : 8 sur 8 ; contre `plan4b` : 5 sur 5 ; contre `plan4c` : 5 sur 5. Aucune image « à regarder », aucune référence refaite. Le commentaire changé de `bibliographie.bib` ne change pas `bloc-bib`.
