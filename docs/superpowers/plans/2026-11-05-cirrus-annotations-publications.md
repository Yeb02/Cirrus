# Cirrus, plan 4c : annotations de PDF et import de publications — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Approuvé par l'utilisateur le 2026-11-07** (« Le plan 4C : tout m'a l'air en ordre, procède. »).

**Goal :** on lit et on annote ses PDF, et on fait entrer ses publications dans la base. On peut :
- surligner un passage d'un PDF : cela crée un nœud d'annotation, qui porte le passage, le PDF et la page. Il n'entre dans aucun plan à sa création ;
- retrouver les annotations d'un PDF dans la marge du lecteur et dans le pop-up du nœud du PDF. Un clic ouvre le PDF à la bonne page, le passage surligné ;
- déposer une annotation dans un plan, depuis ces listes. Déposée dans le nœud du PDF, elle en devient membre, et le nœud du PDF devient un groupe ;
- importer une publication par son identifiant arXiv, son DOI ou son PDF : le titre, les auteurs, la date et l'entrée BibTeX se remplissent. Le PDF d'un article arXiv se télécharge seul ;
- importer un fichier `.bib` entier : ses publications arrivent en un bloc compact qui suit le curseur, et un clic les pose.

**Architecture :**
- **Annotations :** un nœud ordinaire qui porte un champ `anchor` (le PDF, sa version, la page, les rectangles du passage, le texte). Le lecteur PDF du plan 4a les dessine par-dessus ses pages. La pose dans un plan reprend le geste et les règles de groupe existants (spec 10).
- **Publications :** le principal interroge le réseau, à la demande explicite de l'utilisateur seulement, par un module unique de sources (comme `LATEX_SOURCES`), pour que le serveur prenne le relais plus tard. L'interface lit le BibTeX avec un analyseur à nous et construit les nœuds, comme toutes les actions.

**Tech Stack :** celle du plan 4b. Aucune dépendance nouvelle : le BibTeX et le CSL-JSON se lisent par du code à nous.

**Spec :** `C:\Users\alpha\Desktop\Cirrus\2026-11-02-cirrus-design.md`, sections 5.2, 5.4 (publications, `clé_bibtex`), 6.5, 10, 12 (« Annotation de PDF », « Import de publications ») et 18.

## Décisions

Chaque décision ci-dessous a comparé ses options. Une décision non prévue ici se consigne au registre (`docs/superpowers/plans/2026-11-05-cirrus-annotations-registre.md`, créé à la tâche 1) sous la forme `Ruling:`, avec ses options et son coût si elle est fausse.

- **D1, une annotation est un nœud qui porte un champ `anchor`.**
  - `anchor = { pdf: Id; file: string; hash: string; page: number; rects: [x0, y0, x1, y1][]; text: string }` : le nœud du PDF, le nom du fichier, l'empreinte de sa version, la page (à partir de 1), les rectangles du passage en coordonnées de la page PDF, et le texte surligné.
  - Son titre est le début du passage (`annotationTitleChars`, 80 caractères, puis « … ») [C]. On le renomme, et on lui écrit un résumé, comme à tout nœud.
  - L'instantané range un nœud qui a ce champ par son chemin JSON (`IRREGULAR`), sans changer le codec. C'est plus lent par nœud, mais une base compte quelques centaines d'annotations.
  - **Options écartées :** un enregistrement d'un type nouveau (une opération de plus partout, comme le préambule au plan 4b) ; un fichier `ancre.json` dans le dossier du nœud (il faudrait lire tous ces fichiers pour lister les annotations d'un PDF).
- **D2, une annotation porte sur la version du PDF où elle a été faite.** Le PDF peut être réimporté (plan 4a). L'annotation garde l'empreinte de sa version, qui reste au magasin, et c'est cette version qu'elle ouvre. Le lecteur ne dessine sur un PDF que les annotations de sa version. La liste nomme les autres « sur une version précédente », qui s'ouvrent sur leur version.
  - Reporter les rectangles sur une nouvelle version serait faux dès qu'une ligne bouge.
- **D3, surligner :**
  - on sélectionne du texte dans le lecteur, dans l'aperçu ou en plein écran ;
  - un petit bouton « Annoter » apparaît au bord de la sélection, et Ctrl+Maj+A fait de même [C] ;
  - c'est une action, annulée par Ctrl+Z ;
  - une sélection qui passe d'une page à l'autre est coupée à la fin de la première [C] : une annotation, une page ;
  - les surlignages se dessinent en rectangles translucides, de la couleur `annotationColor`.
- **D4, les listes et la pose.**
  - **Les listes :** la marge du lecteur, repliable, et le pop-up du nœud du PDF (section « Annotations ») listent ses annotations dans l'ordre des pages. Chacune montre sa page, son début, et les plans où elle figure.
  - **Le clic :** il ouvre le PDF à la page, et le passage clignote (`annotationFlashMs`).
  - **La pose :** on dépose une annotation depuis l'une de ces listes sur le graphe, par glisser-déposer. Elle prend la place du dépôt, au cran lisible. Déposée dans l'enveloppe du nœud du PDF, ou sur lui, elle en devient membre, et un nœud simple qui reçoit son premier membre devient un groupe (règles du plan 3). La question « partout ou ici seulement » suit la règle de la section 10.
  - Le plein écran est modal : on y lit et on y annote, mais on dépose depuis l'aperçu ou le pop-up.
- **D5, la source des publications : le DOI, par la négociation de contenu de `doi.org`.**
  - Un identifiant arXiv devient le DOI que lui donne arXiv (`10.48550/arXiv.<id>`). On n'a donc qu'un chemin, et pas de XML à lire.
  - Le principal demande à `doi.org` le CSL-JSON (titre, auteurs, date) et le BibTeX de l'entrée. `doi.org` redirige vers Crossref ou DataCite.
  - **Seuls les hôtes de `PUBLICATION_SOURCES` sont permis :** `doi.org`, `api.crossref.org`, `data.crossref.org`, `api.datacite.org`, `data.datacite.org` et `arxiv.org`. Tout passe en HTTPS, avec un plafond de taille et un délai (des réglages). Une réponse se lit comme des données, jamais comme du code.
  - Le réseau ne sert que sur une demande explicite de l'utilisateur.
  - Option écartée : l'API Atom d'arXiv, qu'il faudrait lire en XML, sans BibTeX.
- **D6, le PDF :**
  - celui d'un article arXiv se télécharge seul (`https://arxiv.org/pdf/<id>`), entre au magasin comme un fichier déposé, et se vérifie par ses premiers octets (`%PDF`) et par `maxImportMb` ;
  - celui d'une autre publication, l'utilisateur le dépose (spec 12 [C]) ;
  - la spec veut que le serveur récupère le PDF. Il n'existe pas encore : le principal du PC le fait d'ici là, par le même module de sources, que les plans 5 et 9 tourneront vers le serveur (demande de l'utilisateur du 2026-11-05).
- **D7, un nœud de publication :**
  - **Titre :** celui de l'article, avec les accents LaTeX convertis en Unicode (`\'e` donne « é »).
  - **Tags :** `auteur` (un par auteur, « Prénom Nom »), `date_de_publication`, `clé_bibtex`, et `doi` ou `arxiv`.
  - **Dossier :** l'entrée BibTeX y est un fichier `<clé>.bib`, plutôt qu'un champ. Elle se synchronise, se versionne et se lit comme les autres fichiers. Le document (spec 15) assemblera son `.bib` à partir de ces fichiers [C].
  - **Clé :** celle de l'entrée si elle en a une, sinon le nom du premier auteur suivi de l'année (`li2008`), puis `li2008b`, etc. en cas de collision.
  - **Doublons :** une publication qui a déjà ce DOI, cet identifiant arXiv ou cette clé n'est pas recréée. La notification nomme le nœud existant.
- **D8, un PDF déposé sans identifiant :**
  - l'interface cherche un DOI ou un identifiant arXiv dans les métadonnées et les deux premières pages (pdf.js), et propose l'import s'il en trouve un ;
  - sinon, le nœud prend le titre des métadonnées, ou le nom du fichier, et l'utilisateur complète.
- **D9, un fichier `.bib` :**
  - on le dépose sur le fond du graphe, ou on passe par « Importer un fichier .bib… » dans le menu du fond ;
  - ses entrées deviennent des nœuds de publication (D7), sans réseau ;
  - elles arrivent en une grille compacte qui suit le curseur (le fantôme du collage, plan 3b), et un clic les pose toutes en une seule action ;
  - les doublons sont écartés et nommés.

**Hors du plan 4c :**
- la récupération par le serveur (plans 5 et 9) ;
- un PDF trouvé hors d'arXiv (Unpaywall demanderait une adresse électronique) ;
- l'annotation à main levée ou par zone ;
- la veille (spec 16.2).

## Global Constraints

- Les contraintes des plans 3 à 4b valent toujours :
  - travail sur `main`, sans branche, avec un commit puis un push par tâche, jamais en force ;
  - messages de commit en français, terminés par `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` ;
  - syntaxe effaçable, avec l'extension dans les imports ;
  - toute constante de rendu ou d'interaction est un paramètre avancé de `RenderParams`, avec un libellé français (groupes « Annotations » et « Publications ») ;
  - identifiants et commentaires en anglais, textes de l'interface en français.
- **Cloisonnement :**
  - seul le principal touche le réseau et le disque ;
  - le réseau ne sert que sur une demande explicite de l'utilisateur, et seulement vers les hôtes de `PUBLICATION_SOURCES` (D5), en HTTPS ;
  - les tests n'accèdent jamais au réseau : ils rejouent des réponses enregistrées.
- **Données :**
  - une base plus ancienne s'ouvre sans changement ;
  - un fichier du magasin n'est jamais effacé, et l'annotation d'une version ancienne en dépend (D2).
- **Une action, un pas :** une annotation, un import, un `.bib` posé : chacun est une action et un Ctrl+Z.
- **Performance :**
  - le lecteur ne dessine que les surlignages des pages visibles ;
  - lister les annotations d'un PDF ne parcourt pas toute la base à chaque image : un index dérivé dans l'interface, reconstruit seulement sur ce qui a changé, comme le registre du plan 4b ;
  - un `.bib` de 2 000 entrées s'analyse en moins d'une seconde (mesuré à la tâche 7).
- **Tests et captures :**
  - `npx vitest run --maxWorkers=1`, et `tsc` sur chaque paquet touché ;
  - aucune capture ni aucun test n'ouvre la base de l'utilisateur ;
  - `docs/captures/reference-3c`, `plan4a` et `plan4b` ne changent pas, sauf écart consigné ;
  - les nouvelles captures vont dans `docs/captures/plan4c/`.

## Review Focus

1. **Une réponse du réseau ou un `.bib` hostile ou abîmé :**
   - du HTML au lieu de JSON ;
   - une réponse énorme ;
   - une redirection vers un hôte non permis ;
   - un `.bib` aux accolades déséquilibrées, avec des macros `@string`, des concaténations `#`, des commentaires, 2 000 entrées, des clés en double ou des accents LaTeX.

   L'import est refusé ou dégradé, avec la raison en français. Il ne plante jamais et ne lit jamais au-delà de son plafond. Testé dans les tâches 4 et 5.
2. **Un PDF réimporté** alors qu'il porte des annotations : elles restent liées à leur version, s'ouvrent sur elle, et la liste le dit. Testé dans les tâches 1 et 2.
3. **Une sélection difficile :** à cheval sur deux pages, sur une page tournée, à un fort zoom, ou sur une page encore en cours de dessin. Les rectangles sont en coordonnées de la page, et le surlignage reste aligné à tous les zooms. Testé dans la tâche 2.
4. **Le nœud du PDF mis à la corbeille, son fichier retiré, ou l'annotation annulée** pendant qu'une liste ou un lecteur l'affiche : la liste dit ce qui manque, et rien ne plante. Testé dans les tâches 2 et 3.
5. **Un import hors ligne, ou d'un identifiant inconnu :** l'erreur est dite en français, et rien n'est créé. Testé dans la tâche 4.

---

### Task 1 : Socle — champ `anchor`, commande d'annotation, index, base de test

**Files :**
- Create : `packages/core/src/annotation.ts`, `packages/core/tests/annotation.test.ts`, le registre du plan.
- Modify :
  - `packages/core/src/model.ts`, `codec.ts` (la validation d'un nœud `IRREGULAR` qui a un `anchor`), `invariants.ts`, `commands.ts`, `index.ts` ;
  - `packages/store/src/localStore.ts` si sa validation des nœuds l'exige ;
  - `packages/fixtures/src/build.ts`, `assets/`, et leurs tests.

**Interfaces (Produces) :**
- `interface Anchor { pdf: Id; file: string; hash: string; page: number; rects: [number, number, number, number][]; text: string }` ; `NodeRec.anchor?: Anchor`.
- `validAnchor(a: unknown): a is Anchor` :
  - la page est un entier ≥ 1, et il y a de 1 à 500 rectangles finis ;
  - le texte compte au plus 20 000 caractères, et l'empreinte 64 caractères hexadécimaux.
- `createAnnotation(s: State, a: Anchor, title: string): Action` :
  - un nœud sans placement, au libellé « Annoter « <début> », p. <n> » ;
  - le PDF doit exister et ne pas être à la corbeille, sinon `CommandError` en français.
- `annotationTitle(text: string, max: number): string`.
- Tags de la base de test : `doi` et `arxiv` (texte, nœud, une seule valeur).
- Base de test :
  - deux annotations sur `Li_Vitányi_chapitre_1.pdf`, aux pages 1 et 2. L'une est posée dans un nouveau plan « Lecture », dans le nœud de la publication, qui y devient un groupe ; l'autre n'est dans aucun plan ;
  - une troisième, sur une version précédente du PDF, réimportée par la base de test.

- [ ] **Step 1 : tests.**
  - `validAnchor` : les bornes.
  - `createAnnotation` : le nœud n'a aucun placement, `anchor` est gardé, et Ctrl+Z le retire. Un PDF à la corbeille est refusé.
  - Codec : un nœud avec `anchor` fait l'aller-retour, et un `anchor` invalide envoie au chemin de secours.
  - Base : l'écriture et la relecture d'un nœud avec `anchor`.
  - Base de test : les trois annotations, et le groupe dans « Lecture ».
- [ ] **Step 2 :** lancer. Attendu : échec.
- [ ] **Step 3 :** implémenter, puis lancer les captures. Une capture qui change, comme les plans listés dans le pop-up de la publication, se refait avec un `Ruling:`.
- [ ] **Step 4 :** la suite complète et `tsc`.
- [ ] **Step 5 :** créer le registre. Commit et push (`feat(core): annotations de PDF, base de test`).

### Task 2 : Lecteur PDF — surligner, dessiner, la marge, ouvrir à la page

**Files :**
- Create : `packages/app/src/renderer/files/annotations.ts` (index et géométrie), `ui/viewers/AnnotationLayer.tsx`, `ui/viewers/AnnotationMargin.tsx`, et des tests.
- Modify : `ui/viewers/PdfViewer.tsx`, `Viewer.tsx`, `FilePreview.tsx`, `FullScreen.tsx`, `App.tsx`, `packages/view/src/params.ts`.

**Interfaces (Produces) :**
- `class AnnotationIndex` :
  - `static build(s: State, previous?: AnnotationIndex): AnnotationIndex` : les annotations vivantes par PDF, puis par empreinte, dans l'ordre des pages ;
  - `of(pdf: Id): AnnotationEntry[]` ;
  - `forVersion(pdf: Id, hash: string): AnnotationEntry[]`.
- `selectionToAnchor(selection: Selection, pageOf: (el: Element) => { page: number; viewport: PageViewport } | null, pdf, file): Anchor | null` :
  - les rectangles du `Range`, ramenés en coordonnées de la page par `viewport.convertToPdfPoint` ;
  - fusionnés par ligne ;
  - coupés à la première page.
- `rectsOnScreen(anchor: Anchor, viewport: PageViewport): DOMRectLike[]`.
- `PdfViewer` :
  - le prop `annotations` ;
  - une couche de surlignage par page visible ;
  - le bouton « Annoter » près d'une sélection, et Ctrl+Maj+A ;
  - un `goto: { page: number; flash?: Anchor; seq: number }`.
- `AnnotationMargin` : la liste de D4, avec son bouton de repli, « sur une version précédente » pour celles d'une autre version, et le glisser vers le graphe (type MIME `application/x-cirrus-node`).
- Réglages :
  - `annotationColor` ;
  - `annotationOpacity` : 0,35 ;
  - `annotationFlashMs` : 1200 ;
  - `annotationTitleChars` : 80 ;
  - `annotationMarginPx` : 240.

- [ ] **Step 1 : tests** (géométrie pure, et l'index) :
  - aller-retour des coordonnées écran et PDF, à trois zooms et sur une page tournée ;
  - une sélection sur deux pages est coupée ;
  - deux lignes donnent deux rectangles fusionnés ;
  - l'index par version ;
  - une reconstruction après une modification ne relit que ce qui a changé.
- [ ] **Step 2 à 4 :** comme d'habitude. Vérifier dans l'app construite :
  - surligner dans l'aperçu, puis Ctrl+Z ;
  - surligner en plein écran ;
  - ouvrir une annotation depuis la marge ;
  - l'annotation d'une version précédente.
- [ ] **Step 5 :** commit et push (`feat(app): surligner un PDF, marge des annotations`).

### Task 3 : Pop-ups et pose dans un plan

**Files :**
- Modify : `ui/NodePopup.tsx` (la section « Annotations » du nœud d'un PDF, la ligne « Annotation de « <PDF> », p. <n> » du nœud d'une annotation), `ui/GraphView.tsx` (le dépôt d'un nœud venu d'une liste), `actions.ts`, `App.tsx`, `files/nodeFiles.ts` (la route du dépôt), et des tests.

**Interfaces (Produces) :**
- `placeDroppedBuild(scene, node: Id, at: Vec2, zoom, p, index?): Build` :
  - `importBuild` (plan 3b) si le nœud n'est pas dans ce plan ;
  - sinon une notification « Déjà dans ce plan. » et le cadrage sur lui.
- La question « partout ou ici seulement » quand l'inclusion existe ailleurs ou y est possible (`repercussion`, plan 3b).
- Le dépôt d'un `application/x-cirrus-node` sur le graphe, distinct du dépôt de fichiers (plan 4a, `dropRoute`).

- [ ] **Step 1 : tests :**
  - `placeDroppedBuild` : déposé sur le fond, il est placé ; dans l'enveloppe du PDF, il est membre ; sur le nœud simple du PDF, celui-ci devient un groupe ; déjà dans le plan, la notification ;
  - la route d'un dépôt de nœud contre celle d'un dépôt de fichiers.
- [ ] **Step 2 à 4 :** vérifier dans l'app construite :
  - le dépôt depuis le pop-up et depuis l'aperçu ;
  - le PDF qui devient un groupe ;
  - Ctrl+Z ;
  - le nœud du PDF mis à la corbeille pendant qu'une liste est ouverte.
- [ ] **Step 5 :** commit et push (`feat(app): annotations dans les pop-ups et pose dans un plan`).

### Task 4 : Principal — sources des publications, métadonnées, PDF d'arXiv

**Files :**
- Create : `packages/app/src/main/publications/sources.ts`, `fetch.ts`, `csl.ts`, et `packages/app/tests/publications.test.ts` (avec des réponses enregistrées dans `tests/data/`).
- Modify : `main/index.ts`, le preload, `env.d.ts`, `params.ts`.

**Interfaces (Produces) :**
- `PUBLICATION_SOURCES`, le seul endroit où figurent les hôtes et les URL (D5, D6).
- `parseIdentifier(text: string): { doi: string } | { arxiv: string } | null` : un DOI nu, une URL `doi.org`, `arXiv:2401.01234v2`, une URL `arxiv.org/abs/` ou `/pdf/`, et un ancien identifiant arXiv (`hep-th/9901001`).
- `fetchPublication(id, deps): Promise<{ ok: true; csl: Csl; bibtex: string; pdf?: FileRef } | { ok: false; message: string }>` :
  - redirections suivies seulement vers les hôtes permis, chacune vérifiée ;
  - plafond `publicationMaxKb` pour les métadonnées, `maxImportMb` pour le PDF ;
  - délai `publicationTimeoutMs` ;
  - le PDF ne va au magasin que si ses premiers octets sont `%PDF`.
- `cslToFields(csl: unknown): { title: string; authors: string[]; year: string | null } | null`, défensif : un champ inattendu est ignoré, jamais évalué.
- IPC `publicationFetch(text: string)`. Messages français : « Identifiant non reconnu. », « Publication introuvable. », « Pas de connexion. », « Réponse inattendue du serveur de DOI. ».

- [ ] **Step 1 : tests,** sans réseau (une fausse `fetch` qui rejoue `tests/data/*.json` et `*.bib`) :
  - les formes de `parseIdentifier` ;
  - une redirection vers un hôte non permis est refusée ;
  - une réponse HTML, une réponse trop grosse, un délai dépassé, une erreur 404, et l'absence de réseau ;
  - un PDF qui ne commence pas par `%PDF` est refusé ;
  - le CSL d'un article et celui d'un livre.
- [ ] **Step 2 à 4 :** comme d'habitude. Vérification manuelle avec le réseau, une fois : un identifiant arXiv et un DOI de Crossref, consignés au registre.
- [ ] **Step 5 :** commit et push (`feat(app): import des métadonnées de publications`).

### Task 5 : BibTeX, nœuds de publication, dialogue d'import, PDF déposé

**Files :**
- Create : `packages/core/src/bibtex.ts` (analyseur, normalisation, clé), `packages/core/tests/bibtex.test.ts`, `packages/app/src/renderer/publications/build.ts`, `ui/PublicationDialog.tsx`.
- Modify : `packages/view/src/menus.ts` (« Importer une publication… » dans le menu du fond), `ui/GraphView.tsx`, `actions.ts`, `App.tsx`.

**Interfaces (Produces) :**
- `parseBibtex(text: string): { entries: BibEntry[]; problems: { line: number; message: string }[] }` :
  - `@type{clé, champ = {…} | "…" | nombre | macro}` ;
  - `#`, `@string`, `@comment`, `@preamble` ;
  - des accolades imbriquées ;
  - une entrée abîmée signalée, avec sa ligne, sans arrêter les suivantes.
- `latexToUnicode(s: string): string` : `\'e`, `\"o`, `{\o}`, `\c{c}`, `--`, `~` et les accolades de protection.
- `bibAuthors(field: string): string[]` : « Li, Ming and Vitányi, Paul » donne « Ming Li », « Paul Vitányi », avec les particules et `{Collectif}`.
- `citeKey(entry, taken: Set<string>): string` (D7).
- `publicationBuild(s, fields, bibtex, at, scene, …): Build` : le nœud de D7, son `<clé>.bib` écrit par `storeText` (plan 4b), et son PDF s'il y en a un ; les doublons sont refusés avec la notification.
- `PublicationDialog` : un champ, « Importer », l'état (« Recherche… »), et la zone de dépôt d'un PDF ;
- PDF déposé (D8) : `findIdentifier(text: string, meta: Record<string, string>): { doi } | { arxiv } | null`.

- [ ] **Step 1 : tests :**
  - un `.bib` réel de 50 entrées, plus chaque piège du Review Focus 1 ;
  - `latexToUnicode` ;
  - `bibAuthors` : « Prénom Nom », « Nom, Prénom », « von Neumann, John », « {Groupe de travail} » ;
  - `citeKey` et ses collisions ;
  - `findIdentifier` sur un texte d'arXiv et un texte d'éditeur ;
  - `publicationBuild` : un doublon par DOI, par arXiv, par clé ; un import est un seul Ctrl+Z.
- [ ] **Step 2 à 4 :** vérifier dans l'app construite : l'import par arXiv avec son PDF, par DOI, par un PDF déposé, hors ligne, et un doublon.
- [ ] **Step 5 :** commit et push (`feat(app): publications par identifiant, BibTeX`).

### Task 6 : Import d'un `.bib` en un bloc compact

**Files :**
- Modify : `ui/GraphView.tsx` (un geste `{ kind: 'bib' }`), `packages/view/src/clip.ts` ou un module voisin (la grille du bloc), `files/nodeFiles.ts` (un `.bib` déposé sur le fond), `menus.ts` (« Importer un fichier .bib… »), `actions.ts`.

**Interfaces (Produces) :**
- `bibBlock(n: number, step: number, p): Vec2[]` : la grille compacte, `ceil(√n)` colonnes, à l'écart des boîtes au cran lisible.
- `bibImportBuild(entries, at, scene, …): Build` :
  - une seule action, « Importer <n> publications » ;
  - les doublons écartés et nommés dans une notification ;
  - les entrées abîmées nommées par leur ligne.

- [ ] **Step 1 : tests :**
  - la grille, de 1, 7 et 100 entrées ;
  - les doublons, avec la base existante et à l'intérieur du fichier ;
  - un `.bib` de 2 000 entrées : l'analyse et la construction sous le seuil (trois fois la mesure).
- [ ] **Step 2 à 4 :** vérifier dans l'app construite : déposer le `.bib` de la base de test, poser le bloc, puis Ctrl+Z.
- [ ] **Step 5 :** commit et push (`feat(app): import d'un fichier .bib`).

### Task 7 : Mesures, captures, spec

- [ ] **Step 1 : mesures.**
  - l'analyse et la pose d'un `.bib` de 2 000 entrées ;
  - l'ouverture d'un PDF de 50 annotations ;
  - le dessin des surlignages pendant le défilement.

  Au registre.
- [ ] **Step 2 : captures** dans `docs/captures/plan4c/` :
  - `pdf-surlignages` : le lecteur et sa marge ;
  - `popup-annotations` : le pop-up de la publication ;
  - `plan-lecture` : le PDF devenu groupe ;
  - `import-publication` : le dialogue ;
  - `bloc-bib` : le bloc qui suit le curseur.
- [ ] **Step 3 : spec.** Section 12, un paragraphe « Fixé par le plan 4c » ; sections 5.2 (`anchor`), 5.4 (tags `doi` et `arxiv`, le `.bib` en fichier) et 18 (les sources des publications, qui iront au serveur).
- [ ] **Step 4 :** la suite complète, `tsc` et les quatre suites de captures.
- [ ] **Step 5 :** commit et push (`docs: plan 4c, mesures, captures et spec`).
