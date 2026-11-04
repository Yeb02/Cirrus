# Cirrus, plan 4a : fichiers et pop-ups — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** un nœud reçoit des fichiers et s'ouvre dans un pop-up. On peut :
- cliquer sur un nœud pour ouvrir son pop-up : titre, résumé, tags, métadonnées, fichiers avec des aperçus. Le pop-up s'épingle, se déplace et se redimensionne, comme l'aperçu d'un fichier ;
- importer des fichiers en les déposant sur le nœud ou sur son pop-up, ou par une boîte de dialogue. Une nouvelle version déposée remplace le fichier du même nom, l'ancienne restant dans l'historique ;
- voir en plein écran une image, un PDF, un fichier texte ou de code, un tableau CSV ; Échap en sort, et le fichier se rouvre au même endroit ;
- ouvrir tout autre format avec l'application du système, sur une copie en lecture seule.

Chaque modification d'un nœud passe par une commande du socle, s'enregistre dans la base locale et s'annule par Ctrl+Z.

**Architecture :**
- **Octets des fichiers :** le principal sert le magasin de fichiers (`files/<2>/<sha256>`, plan 2) par un protocole `cirrus-file:` en lecture seule, avec les plages HTTP. L'interface, cloisonnée, n'y lit que par `fetch`, `<img>` et pdf.js. Elle demande au principal d'importer des chemins et d'ouvrir des copies.
- **Modifications :** l'interface calcule l'action (`editNode` sur `files`, `title`, `summary` ou `tags`), comme toutes les autres, et la session l'écrit (plan 3b).
- **Pop-ups :** des panneaux flottants de la fenêtre, en coordonnées d'écran, gérés au niveau de `App`. `GraphView` signale seulement le clic sur un nœud et le dépôt de fichiers.
- **Vues :** un composant par genre de fichier (image, PDF, texte, tableau), le même dans un aperçu et en plein écran.

**Tech Stack :** celle du plan 3c, plus `pdfjs-dist` et CodeMirror 6 (`@codemirror/state`, `view`, `language`, `language-data`, `search`, `commands`), dernière version stable à l'installation, figée par `package-lock.json`.

**Spec :** `C:\Users\alpha\Desktop\Cirrus\2026-11-02-cirrus-design.md`, sections 5.2, 5.4, 6.4, 6.5, 12 (sauf l'annotation de PDF et l'import de publications, qui viennent au plan 4c) et 19.

## Décisions

Chaque décision ci-dessous a comparé ses options. Une décision non prévue ici se consigne au registre (`docs/superpowers/plans/2026-11-04-cirrus-fichiers-registre.md`, créé à la tâche 1) sous la forme `Ruling:`, avec ses options et son coût si elle est fausse.

- **D1, accès aux octets : le protocole `cirrus-file:`.**
  - Une IPC qui renverrait un `ArrayBuffer` recopierait tout le fichier à chaque ouverture. Un gros PDF ne se chargerait plus par morceaux, et une image demanderait une URL `blob:`.
  - `file://` casserait le cloisonnement : l'interface lirait le disque.
  - Au plan 5, c'est ici que se branchera le téléchargement depuis le serveur d'un PDF absent du PC (spec 6.5), sans toucher aux vues.
- **D2, PDF : pdf.js dans un lecteur à nous.**
  - Le lecteur intégré de Chromium (`plugins: true`) ne demanderait rien à écrire. Il ne donne en revanche accès ni à la sélection de texte (annotations, plan 4c), ni aux liens au schéma de l'app (spec 13), ni à la page affichée (« ouvrir le PDF à la bonne page »).
  - Coût : environ 1,5 Mo de code, et un lecteur à pages virtualisées à écrire.
- **D3, texte et code : CodeMirror 6 en lecture seule.**
  - highlight.js ou Shiki produisent du HTML statique : tout le fichier entre dans le DOM, ce qui est lent au-delà de quelques milliers de lignes. Il faudrait en plus un autre outil pour l'éditeur `.tex` du plan 4b.
  - Monaco pèse plusieurs Mo, avec des travailleurs : c'est surdimensionné.
  - CodeMirror ne dessine que les lignes visibles. Il servira d'éditeur au plan 4b (coloration, suggestions `\ref` et `\cite`).
- **D4, tableaux : CSV et TSV dans l'app.**
  - Ils sont lus par un analyseur à nous (RFC 4180, séparateur détecté, dont le point-virgule de l'Excel français) et affichés en lignes virtualisées.
  - SheetJS, pour le `.xlsx`, pèse environ 1 Mo et n'est plus distribué par npm depuis 2023. Les `.xlsx` et `.ods` s'ouvrent donc avec l'application du système ; c'est à revoir si l'usage le demande.
- **D5, ouverture par le système.**
  - L'application du système reçoit une copie en lecture seule dans `%TEMP%\cirrus-ouverts`, jamais le fichier du magasin.
  - Un exécutable ou un script (liste fixe de la tâche 1) n'est jamais ouvert ainsi : l'explorateur le montre à la place. Laisser faire Windows exécuterait par exemple un `.py` associé à Python.
- **D6, import : le principal copie les fichiers dans le magasin avant que l'action ne les référence.**
  - C'est la règle d'`importFile` : un fichier n'est jamais référencé avant d'être sur le disque.
  - Une action refusée laisse une copie orpheline, sans effet. Le ménage viendra avec la synchro (plan 5).
  - L'autre option serait une IPC qui importe et écrit l'action dans le principal. On garde le schéma actuel, où l'interface calcule toutes les actions.
- **D7, pop-ups en coordonnées d'écran, communs à tous les onglets.**
  - Non gardés d'une session à l'autre.
  - Un pop-up ancré au nœud dans le monde suivrait la caméra : il deviendrait illisible au zoom, et un nœud figure dans plusieurs plans.

**Hors du plan 4a :**
- l'aperçu LaTeX compilé et l'éditeur `.tex` (plan 4b) : le résumé et les `.tex` s'affichent en source ;
- l'annotation de PDF et l'import de publications (plan 4c) ;
- l'historique des versions d'un fichier (plans suivants) ;
- la synchro des fichiers (plan 5).

## Global Constraints

- Les contraintes des plans 3 à 3c valent toujours :
  - travail sur `main`, sans branche, avec un commit puis un push par tâche, jamais en force ;
  - messages de commit en français, terminés par `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` ;
  - syntaxe effaçable, avec l'extension dans les imports ;
  - toute constante de rendu ou d'interaction est un paramètre avancé de `RenderParams`, avec un libellé français (section « Avancé », groupe « Fichiers » ou « Pop-ups ») ;
  - identifiants et commentaires en anglais, textes de l'interface en français.
- **Cloisonnement :**
  - l'interface reste cloisonnée (`sandbox`, `contextIsolation`) et seul le principal touche le disque ;
  - l'interface lit les octets d'un fichier par `cirrus-file:` seulement, et le principal n'y sert que des empreintes SHA-256 valides de son magasin ;
  - rien n'est chargé du réseau à l'exécution : pdf.js, son travailleur, ses cartes de caractères et ses polices sont dans l'app.
- **CSP :** la politique de `index.html` reste aussi stricte que possible. Chaque source ajoutée (`cirrus-file:`, ce qu'exige pdf.js) reçoit un `Ruling:` au registre, qui dit pourquoi.
- **Fichiers (spec 5.2) :**
  - des copies, jamais des pointeurs ;
  - un dossier à plat ;
  - les noms accentués sont attendus ;
  - rien n'est modifié hors de Cirrus ;
  - une copie du magasin n'est jamais effacée, car l'historique y renvoie.
- **Une action, un pas :** un dépôt de plusieurs fichiers sur un nœud forme une seule action, donc un seul Ctrl+Z (spec 6.4). Dans un champ de texte du pop-up, Ctrl+Z agit sur le texte.
- **Performance :**
  - une vue ne lit jamais plus que son plafond réglable (plages HTTP) ;
  - le texte, les tableaux et les pages d'un PDF ne dessinent que ce qui est visible ;
  - ouvrir un pop-up ne lit aucun fichier entier.
- **Tests :**
  - `npx vitest run --maxWorkers=1` à la racine (la mémoire du PC est juste) ;
  - `npx tsc --noEmit -p packages/<paquet>` pour chaque paquet touché ;
  - un seuil de test chronométré vaut environ trois fois la mesure.
- **Captures :**
  - les captures de `docs/captures/reference-3c` ne changent pas, à 0,5 % des pixels près (plus de 16 niveaux), sauf écart consigné. Une capture qui clique sur un nœud montre désormais son pop-up : sa référence se refait, avec un `Ruling:` ;
  - les nouvelles captures vont dans `docs/captures/plan4a/`, qui sert ensuite de référence ;
  - aucun test ni aucune capture n'ouvre la base de l'utilisateur.

## Review Focus

1. **Redéposer un fichier dont le nom diffère par la casse ou la normalisation Unicode** (« Rapport.pdf » contre « rapport.pdf », un « é » décomposé venu d'une archive) : la nouvelle version remplace l'ancienne au lieu de s'ajouter à côté. Testé dans la tâche 2.
2. **Dépôts inattendus :**
   - un dossier, un fichier au-delà de `maxImportMb`, ou un fichier disparu entre le dépôt et l'import : il est refusé avec sa raison en français, et les autres fichiers sont importés ;
   - un fichier lâché ailleurs que sur un nœud ou un pop-up (onglets, réglages, champ de texte, fond du graphe) : la fenêtre ne navigue jamais vers lui.

   Testé dans les tâches 1 et 4.
3. **Ouvrir avec le système un fichier exécutable ou un script** (`.py`, `.bat`, `.exe`, `.ps1`, `.lnk`, `.js`…) : il n'est jamais exécuté, l'explorateur le montre. Testé dans la tâche 1.
4. **Un texte qui n'est pas en UTF-8**, comme le CSV à points-virgules et accents en Windows-1252 de l'Excel français, ou de l'UTF-16 avec BOM ; un binaire avec une extension de texte : il s'affiche lisiblement, ou avec le message « fichier binaire ». Jamais de caractères illisibles ni de plantage. Testé dans la tâche 2.
5. **Le nœud supprimé, le fichier retiré, ou leur ajout annulé** pendant qu'un pop-up est épinglé ou qu'un fichier est en plein écran : le panneau dit « n'existe plus », le plein écran se ferme, rien ne plante. Testé dans les tâches 3 et 5.

---

### Task 1 : Principal — protocole des fichiers, import, copies en lecture seule, historique

**Files :**
- Create : `packages/app/src/main/files.ts`, `packages/app/tests/files.test.ts`, `docs/superpowers/plans/2026-11-04-cirrus-fichiers-registre.md`.
- Modify :
  - `packages/app/src/main/index.ts` (schéma privilégié, `protocol.handle`, IPC, ménage des copies au démarrage) ;
  - `packages/app/src/preload/index.ts`, `packages/app/src/renderer/env.d.ts` ;
  - `packages/app/src/renderer/index.html` (CSP) ;
  - `packages/view/src/params.ts` et ses tests.

**Interfaces (Produces) :**
- `FILE_SCHEME = 'cirrus-file'`. L'URL d'un fichier est `cirrus-file://blob/<sha256>/<nom encodé par encodeURIComponent>` ; le nom ne sert qu'au type de contenu.
- `blobRequest(storeDir: string, url: string, range: string | null): BlobAnswer`, où :

  ```ts
  type BlobAnswer =
    | { status: 400 | 404 | 416; headers: Record<string, string> }
    | { status: 200 | 206; headers: Record<string, string>; path: string; start: number; end: number }
  ```

  - L'empreinte doit correspondre à `/^[0-9a-f]{64}$/`, et le chemin vient de `filePath` (plan 2) ; sinon 400.
  - Un fichier absent du magasin donne 404.
  - Une plage `bytes=a-b`, `bytes=a-` ou `bytes=-n` donne 206 avec `Content-Range`, et une plage hors du fichier 416.
  - Les en-têtes comprennent toujours `Accept-Ranges: bytes` et `Content-Length`. `end` est inclus.
  - Le gestionnaire de `protocol.handle` ouvre `createReadStream(path, { start, end })` et le rend par `Readable.toWeb`.
- `contentTypeOf(name: string): string` : `image/…` pour les images de la tâche 2, `application/pdf`, sinon `application/octet-stream` (l'interface décode le texte elle-même).
- `importPaths(storeDir: string, paths: string[], maxBytes: number): ImportResult`, avec `interface ImportResult { refs: FileRef[]; refused: { name: string; reason: string }[] }`. Les raisons possibles sont « c'est un dossier », « introuvable » et « plus de N Mo ». Chaque fichier accepté passe par `importFile` (plan 2).
- `isRunnable(name: string): boolean`. Extensions, insensibles à la casse : `exe com bat cmd ps1 psm1 vbs vbe js jse wsf wsh msi msp msc scr pif cpl hta lnk url reg jar py pyw pyz appref-ms`.
- `openableCopy(storeDir: string, ref: FileRef, root: string): string` :
  - la copie va dans `root/<16 premiers caractères de l'empreinte>/<nom>` et passe en lecture seule (`chmodSync(…, 0o444)`) ;
  - une copie déjà là est réutilisée.
- `cleanCopies(root: string): void` : efface ce qu'il peut (le droit d'écriture rendu d'abord) et ignore ce qui est encore ouvert.
- `historySummary(rows: ChangeRow[]): HistorySummary`, avec `interface HistorySummary { created: number | null; modified: number | null; changes: number }` : le plus petit et le plus grand `at`, et le nombre d'actions distinctes (`ChangeRow` vient de `@cirrus/store`).
- IPC, et le pont `CirrusBridge` :
  - `pathForFile(file: File): string`, par `webUtils.getPathForFile` dans le preload ; `''` pour ce qui n'est pas un fichier du disque ;
  - `importFiles(paths: string[]): Promise<ImportResult>` (`cirrus:files:import`) ;
  - `pickFiles(): Promise<ImportResult>` (`cirrus:files:pick`, par `dialog.showOpenDialog` avec plusieurs fichiers ; rien choisi donne des listes vides) ;
  - `openFile(ref: FileRef): Promise<{ ok: true; shown: 'app' | 'folder' } | { ok: false; message: string }>` (`cirrus:files:open`, par `openableCopy`, puis `shell.openPath`, ou `shell.showItemInFolder` si `isRunnable`) ;
  - `historyOf(id: Id): Promise<HistorySummary>` (`cirrus:history`, par `store.historyOf`).
- Réglage `maxImportMb` : 200, entre 1 et 4096, libellé « Taille maximale d'un fichier importé (Mo) », groupe « Fichiers ». Le principal le lit par `withOverrides(settings())`, comme `snapshotQuitMs`.
- CSP : `img-src` et `connect-src` reçoivent `cirrus-file:`.
- Au démarrage, après l'ouverture de la base : `cleanCopies(join(tmpdir(), 'cirrus-ouverts'))`. Bench et captures ne l'appellent pas.

- [ ] **Step 1 : tests** (`packages/app/tests/files.test.ts`, dans un dossier temporaire et un magasin construit par `importFile`) :
  - `blobRequest` :
    - rend 200 avec le type et la taille du fichier ;
    - rend 206 pour chacune des trois formes de plage ;
    - rend 416 au-delà de la taille, et 404 pour une empreinte valide mais absente ;
    - rend 400 pour `..`, une empreinte trop courte, des majuscules, et une barre oblique inverse.
  - `importPaths` sur un fichier accentué, un dossier, un fichier de `maxBytes + 1` octets et un chemin absent : un `FileRef` et trois refus, avec leurs raisons exactes.
  - `isRunnable` : vrai pour `Script.PY`, `a.ps1` et `raccourci.lnk`, faux pour `notes.txt`, `figure.png` et `article.pdf` (Review Focus 3).
  - `openableCopy` : la copie a le même contenu et le même nom, elle est en lecture seule (`(statSync(p).mode & 0o200) === 0`), et un second appel rend le même chemin.
  - `cleanCopies` efface une copie en lecture seule.
  - `historySummary` sur trois lignes de deux actions : `created`, `modified`, et `changes = 2`.
- [ ] **Step 2 :** `npx vitest run --maxWorkers=1 packages/app/tests/files.test.ts`. Attendu : échec, faute de `files.ts`.
- [ ] **Step 3 :** implémenter `files.ts`, puis le câblage :
  - `protocol.registerSchemesAsPrivileged`, avant `ready`, avec `standard`, `secure`, `supportFetchAPI` et `stream` ;
  - `protocol.handle` après `openBase` ;
  - les IPC, le pont et la CSP ;
  - le réglage et son test dans `params.test.ts`.
- [ ] **Step 4 :** relancer le fichier (tout passe), puis la suite complète et `tsc` sur `app` et `view`. Lancer les captures et les comparer à `docs/captures/reference-3c` : 11 sur 11 dans la tolérance.
- [ ] **Step 5 :** créer le registre, avec la règle de la CSP. Commit et push (`feat(app): protocole des fichiers, import, copies en lecture seule`).

### Task 2 : Logique des fichiers dans l'interface, base de test

**Files :**
- Create :
  - `packages/app/src/renderer/files/kind.ts`, `merge.ts`, `decode.ts`, `viewState.ts` ;
  - `packages/app/tests/fileLogic.test.ts`.
- Modify :
  - `packages/app/src/renderer/actions.ts` (trois `Build`) ;
  - `packages/fixtures/src/build.ts` et ses tests ;
  - `packages/fixtures/assets/` (trois fichiers).

**Interfaces (Produces) :**
- `kind.ts` :
  - `type FileKind = 'image' | 'pdf' | 'tex' | 'text' | 'table' | 'other'` ;
  - `fileKind(name: string): FileKind` :
    - image : `png jpg jpeg gif webp bmp svg avif ico` ;
    - pdf : `pdf` ;
    - tex : `tex` ;
    - table : `csv tsv` ;
    - text : `txt md bib py ipynb js mjs ts tsx jsx json yaml yml toml ini cfg c h cpp hpp cc rs go java kt jl r m sh ps1 bat lua sql html css xml log rst`, plus les noms sans extension `Makefile`, `Dockerfile`, `LICENSE` et `README` ;
    - tout le reste : `other`.
  - `fileUrl(ref: FileRef): string` (format de la tâche 1) ;
  - `formatSize(bytes: number): string`, en base 1024 : « 0 o », « 812 o », « 12,3 Ko », « 4,5 Mo », « 1,2 Go » (une décimale sous 100).
- `merge.ts` :
  - `sameName(a: string, b: string): boolean`, après `normalize('NFC')` et `toLocaleLowerCase('fr')` ;
  - `mergeFiles(existing: FileRef[], incoming: FileRef[]): Merge`, avec `interface Merge { files: FileRef[]; added: string[]; replaced: string[]; unchanged: string[] }` :
    - un nom déjà présent (au sens de `sameName`) est remplacé à sa place et prend l'orthographe du nouveau, sauf s'il a la même empreinte : il compte alors comme `unchanged` ;
    - un nom nouveau s'ajoute à la fin ;
    - deux fichiers du même nom dans un même dépôt : le suivant reçoit « (2) », « (3) »… avant l'extension.
  - `checkFileName(name: string, files: FileRef[], except?: string): string | null`. Il rend null si le nom est permis, sinon un message français :
    - nom vide ;
    - caractères `<>:"/\|?*` ou caractères de contrôle ;
    - point ou espace final ;
    - noms réservés de Windows (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`, avec ou sans extension) ;
    - nom déjà pris.
- `actions.ts` :
  - `filesBuild(node: Id, incoming: FileRef[]): Build`, libellé « Ajouter des fichiers à « titre » », ou « Remplacer « nom » » si l'unique fichier en remplace un ; null si tout est `unchanged` ;
  - `renameFileBuild(node: Id, name: string, newName: string): Build`, libellé « Renommer « nom » » ;
  - `removeFileBuild(node: Id, name: string): Build`, libellé « Retirer « nom » de « titre » ».

  Les trois passent par `editNode`, sous ce libellé, par `combine`.
- `decode.ts` :
  - `decodeText(bytes: Uint8Array): { text: string; encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252' } | { binary: true }` :
    - le BOM décide d'abord ;
    - un octet nul dans les 8 premiers Ko, sans BOM UTF-16, signifie un binaire ;
    - sinon UTF-8 strict (`fatal: true`), et Windows-1252 en cas d'échec.
  - `parseDelimited(text: string, maxRows: number, delimiter?: ',' | ';' | '\t'): { rows: string[][]; delimiter: ',' | ';' | '\t'; truncated: boolean }` :
    - guillemets à la RFC 4180, guillemets doublés, retours à la ligne dans un champ, CRLF ou LF ;
    - sans séparateur donné, celui dont le nombre par ligne, hors guillemets, est le plus constant sur les 20 premières lignes ;
    - `.tsv` impose la tabulation.
- `viewState.ts` : `class ViewStates`, construit par `(storage: Storage | null, max: number)`, avec `get(hash): Record<string, number> | undefined` et `set(hash, v)`.
  - Le plus ancien part au-delà de `max`.
  - Chaque accès à `storage` est sous `try/catch`, sous la clé `cirrus.fileViews`.
- Base de test :
  - `mesures_compression.csv` : points-virgules, accents, écrit en octets Windows-1252 et non en UTF-8 ; il sert au Review Focus 4 dans les captures ;
  - `notes_lecture.md`, en UTF-8 ;
  - `présentation.pptx` : quelques octets, de genre `other`.
  - Les deux premiers vont au nœud « Minimum Description Length Principle (MDL) », le troisième à un autre nœud de la base de test.

- [ ] **Step 1 : tests** (`packages/app/tests/fileLogic.test.ts`) :
  - `fileKind` pour un nom de chaque liste, une extension en majuscules et `Makefile`.
  - `formatSize` donne exactement les cinq exemples ci-dessus.
  - `mergeFiles` (Review Focus 1) :
    - « rapport.pdf » remplace « Rapport.pdf » à sa place ;
    - un « é » décomposé remplace le composé ;
    - la même empreinte sous le même nom compte comme `unchanged` ;
    - deux « a.txt » dans un dépôt donnent « a.txt » et « a (2).txt ».
  - `checkFileName` : un cas par refus, plus un nom accentué permis.
  - Les trois `Build`, sur la base de test avec `applyOps` :
    - un dépôt de trois fichiers, dont un remplacement, forme une seule action ;
    - `invertAction` rend exactement la liste d'avant ;
    - un dépôt où tout est `unchanged` donne null.
  - `decodeText` (Review Focus 4) :
    - « Éléments;Durée » en Windows-1252 est relu exactement ;
    - UTF-16LE et UTF-16BE avec BOM, et UTF-8 avec BOM (le BOM n'est pas gardé) ;
    - un PNG renommé `.txt` donne `binary`.
  - `parseDelimited` :
    - un champ entre guillemets avec point-virgule, guillemet doublé et retour à la ligne ;
    - la détection de `;` contre `,` sur un CSV français à décimales avec virgule ;
    - `truncated` au-delà de `maxRows`.
  - Coût de `parseDelimited` : 100 000 lignes de 8 colonnes, avec un plafond d'environ trois fois la mesure, noté au registre.
  - `ViewStates` : aller-retour, éviction du plus ancien, et un `storage` qui lève ne casse rien.
  - La base de test : le nœud MDL a ses quatre fichiers d'avant plus les deux nouveaux, et les octets du CSV sont bien ceux de Windows-1252.
- [ ] **Step 2 :** `npx vitest run --maxWorkers=1 packages/app/tests/fileLogic.test.ts packages/fixtures`. Attendu : échec, faute des modules.
- [ ] **Step 3 :** implémenter.
- [ ] **Step 4 :** les tests passent, puis la suite complète et `tsc` sur `app` et `fixtures`.
- [ ] **Step 5 :** commit et push (`feat(app): genres de fichiers, fusion des dépôts, décodage, base de test`).

### Task 3 : Panneaux flottants et pop-up de nœud

**Files :**
- Create :
  - `packages/app/src/renderer/ui/panels/geometry.ts`, `ui/panels/FloatingPanel.tsx`, `ui/panels/Panels.tsx`, `ui/NodePopup.tsx` ;
  - `packages/app/src/renderer/files/tags.ts` ;
  - `packages/app/tests/panels.test.ts`.
- Modify : `App.tsx`, `ui/GraphView.tsx`, `styles.css`, `packages/app/scripts/captures.mjs`, `packages/view/src/params.ts`.

**Interfaces (Produces) :**
- `geometry.ts` :
  - `interface Rect { x: number; y: number; w: number; h: number }` ;
  - `placeAt(at: { x: number; y: number }, size: { w: number; h: number }, bounds: Rect, gap: number): Rect` : à droite et en dessous du clic, retourné à gauche ou au-dessus pour rester dans `bounds` ;
  - `clampRect(r: Rect, bounds: Rect, min: number): Rect` : taille au moins `min`, l'en-tête (les 32 premiers pixels) toujours dans `bounds` ;
  - `dragRect(r: Rect, edge: 'move' | 'e' | 's' | 'se', dx: number, dy: number, bounds: Rect, min: number): Rect`.
- `Panels.tsx` :
  - `type PanelTarget = { kind: 'node'; node: Id } | { kind: 'file'; node: Id; name: string }` ;
  - `interface Panel { id: number; target: PanelTarget; rect: Rect; pinned: boolean; z: number }` ;
  - `resolveTarget(s: State, t: PanelTarget): { node: NodeRec; file?: FileRef } | null` : null pour un nœud absent ou à la corbeille, ou un fichier retiré (Review Focus 5) ;
  - le gestionnaire offre `openNode(node: Id, client: { x: number; y: number })` et `closeLoose()` ; la tâche 5 ajoute `openFile(node, name, near: Rect)`.
  - **Règles :**
    - ouvrir le pop-up d'un nœud ferme les panneaux non épinglés ;
    - un clic hors de tout panneau ferme les non épinglés ;
    - les épinglés restent, d'un onglet à l'autre ;
    - un clic sur un panneau le met devant ;
    - Échap ferme le panneau non épinglé le plus haut quand aucun geste du graphe n'est en cours ;
    - un nœud qui a déjà un pop-up ouvert ne s'en voit pas ouvrir un second : son pop-up passe devant.
- `NodePopup.tsx` :
  - **en-tête :** sert de poignée de déplacement, avec le titre éditable (`renameBuild`, validé à la perte du focus ou par Entrée), « épingler » et « fermer » ;
  - **« Résumé (LaTeX) » :** une zone de texte, enregistrée à la perte du focus (`editNode`, champ `summary`). Le source s'affiche, l'aperçu compilé attend le plan 4b ;
  - **tags :** des pastilles « clé : valeur » retirables. Un champ ajoute un tag avec des suggestions tirées des clés du registre puis des valeurs d'énumération. Les tags obligatoires absents s'affichent en grisé avec leur valeur par défaut (`effectiveTags`) ; les remplir les écrit ;
  - **métadonnées :**
    - créé le, modifié le et le nombre de modifications, par `historyOf`, relu quand ce nœud change ;
    - les plans où il figure (`placedIn`), chacun un bouton qui ouvre son onglet ;
    - le nombre de connexions de connaissance (`memberOf`, `connKind`) ;
    - l'identifiant, sélectionnable ;
  - **fichiers :** nom, genre et taille. Les actions arrivent à la tâche 4, les aperçus aux tâches 5 et 6.
  - Un nœud qui n'existe plus affiche « Ce nœud n'existe plus. ».
- `tags.ts` :
  - `parseTag(input: string, defs: ReadonlyMap<string, TagKeyDef>): TagValue` :
    - « mot » donne `{ key: 'mot' }`, et « clé:valeur » donne `{ key, value }` ;
    - une valeur est convertie en nombre pour une clé `number`, la virgule française acceptée ;
    - une valeur passe par `normalizeTag` pour une clé `enum` ;
    - une erreur lève `TagError` avec un message français ;
  - `withTag(tags: TagValue[], tag: TagValue, defs): TagValue[]` : une clé non multiple remplace sa valeur ;
  - `withoutTag(tags, tag): TagValue[]`.
- `GraphView` :
  - un clic sans Ctrl sur un nœud ou un groupe (pas un fantôme) le sélectionne, comme aujourd'hui, et appelle `props.onOpenNode(id, { x: clientX, y: clientY })` ;
  - un clic sur le fond appelle `props.onBackgroundClick()`.
- Réglages, groupe « Pop-ups » :
  - `popupWidthPx` : 380, entre 200 et 1600 ;
  - `popupHeightPx` : 460, entre 160 et 1400 ;
  - `panelMinPx` : 200, entre 120 et 600 ;
  - `panelGapPx` : 12, entre 0 et 60.

- [ ] **Step 1 : tests** (`packages/app/tests/panels.test.ts`) :
  - `placeAt` : au coin bas-droit de `bounds`, le panneau est retourné et reste entier dedans.
  - `clampRect` : un panneau tiré hors de l'écran garde son en-tête visible, et sa taille ne descend pas sous `min`.
  - `dragRect`, pour `move`, `e`, `s` et `se`.
  - `resolveTarget` (Review Focus 5) : null après `deleteEverywhere` du nœud, après `removeFileBuild` du fichier, et après l'annulation de l'ajout d'un fichier.
  - `parseTag`, `withTag` et `withoutTag`, sur le registre de la base de test : mot, nombre à virgule, énumération par nom et par rang, valeur d'énumération inconnue (message), clé non multiple remplacée, clé multiple ajoutée.
- [ ] **Step 2 :** constater l'échec, implémenter, voir passer les tests, puis la suite complète et `tsc` sur `app`.
- [ ] **Step 3 : captures.**
  - Ajouter `popup-noeud` (un clic sur le nœud MDL, par `CIRRUS_POINTER`) à `captures.mjs`, référence dans `docs/captures/plan4a/`.
  - Comparer les autres captures à `reference-3c`. Celles qui cliquent sur un nœud montrent maintenant son pop-up : leur référence se refait, avec un `Ruling:`.
- [ ] **Step 4 :** commit et push (`feat(app): pop-up de nœud, panneaux épinglables, déplaçables et redimensionnables`).

### Task 4 : Fichiers du nœud — dépôt, réimport, renommage, retrait, ouverture par le système

**Files :**
- Create : `packages/app/src/main/navigation.ts`, `packages/app/tests/navigation.test.ts`.
- Modify :
  - `ui/NodePopup.tsx` et `ui/GraphView.tsx` ;
  - `App.tsx`, `ui/ContextMenu.tsx` si besoin ;
  - `packages/app/src/main/index.ts`, `packages/app/scripts/captures.mjs` ;
  - `packages/app/tests/actions.test.ts`, `packages/app/tests/session.test.ts`.

**Interfaces :**
- Consumes : tâches 1 et 2 (`importFiles`, `pickFiles`, `openFile`, `pathForFile`, `filesBuild`, `renameFileBuild`, `removeFileBuild`, `checkFileName`).
- Produces :
  - **`importInto(node: Id, paths: string[]): Promise<void>`, dans `App` et passé au pop-up et au graphe :**
    - `importFiles`, puis `filesBuild` par la session ;
    - les refus forment une seule notification : « 2 fichiers non importés : x (c'est un dossier), y (plus de 200 Mo) » ;
    - un remplacement est notifié « « nom » remplacé » ;
    - un dépôt où tout est `unchanged` est notifié « Déjà à jour ».
  - **Dépôt sur le graphe :**
    - `GraphView` accepte `dragover` et `drop` de fichiers ;
    - `dropFilesAt(sx: number, sy: number, paths: string[])` : au point du dépôt, le test de clic (`hitAt`) désigne un nœud ou un groupe, qui reçoit les fichiers par la nouvelle prop `onDropFiles(node: Id, paths: string[])`, branchée sur `importInto` ;
    - sur le fond, la notification dit : « Dépose le fichier sur un nœud pour l'y ajouter. ».
  - **Dépôt sur le pop-up :** la liste des fichiers le reçoit, et le bouton « Ajouter des fichiers… » appelle `pickFiles`.
  - **Menu d'un fichier (clic droit) :**
    - « Ouvrir avec l'application du système ». Pour un exécutable, le principal le montre dans l'explorateur (`shown: 'folder'`), et la notification dit : « Fichier exécutable : montré dans l'explorateur, sans l'ouvrir. ». La liste des extensions ne vit qu'au principal ;
    - « Renommer » (champ en place, refusé par `checkFileName`) ;
    - « Retirer du nœud ».

    Les tâches 5 et 6 y ajoutent « Ouvrir en plein écran ». Un fichier de genre `other` s'ouvre par le système au clic.
  - **Garde de la fenêtre (Review Focus 2) :**
    - `App` empêche le comportement par défaut de `dragover` et `drop` sur `window` ;
    - `navigationAllowed(url: string, appUrl: string): boolean`, dans `main/navigation.ts` : seule l'adresse de l'app elle-même est permise, ni `file:`, ni une autre page ;
    - le principal refuse `will-navigate` quand `navigationAllowed` est faux, et répond `deny` à `setWindowOpenHandler`.
  - **Captures :** le lancement accepte `CIRRUS_IMPORT="sx,sy|chemin"`, qui appelle la même fonction que le dépôt (`dropFilesAt(sx, sy, paths)`) après la première image.

- [ ] **Step 1 : tests.**
  - `navigation.test.ts` (Review Focus 2) : `navigationAllowed` accepte l'adresse de l'app, avec ou sans fragment ; il refuse un PDF en `file:`, une page `https:` et `about:blank`.
  - `actions.test.ts` : `filesBuild` puis `renameFileBuild` puis `removeFileBuild` sur la base de test ; chaque action se défait seule par `invertAction`.
  - `session.test.ts`, avec la session et son écriture simulée :
    - un dépôt de trois fichiers donne un seul pas d'annulation ;
    - Ctrl+Z rend la liste d'avant ;
    - Ctrl+Y la remet.
- [ ] **Step 2 :** constater l'échec, implémenter, voir passer les tests, puis la suite complète et `tsc`.
- [ ] **Step 3 : captures.** Ajouter `import-noeud` : `CIRRUS_IMPORT` dépose sur le nœud MDL un fichier écrit dans un dossier temporaire, puis la capture montre son pop-up avec le nouveau fichier. Comparer toutes les captures.
- [ ] **Step 4 :** commit et push (`feat(app): fichiers du nœud, dépôt, réimport, renommage, ouverture par le système`).

### Task 5 : Vues des fichiers — images, texte et code, tableaux ; aperçus et plein écran

**Files :**
- Create :
  - `ui/viewers/Viewer.tsx`, `ImageViewer.tsx`, `TextViewer.tsx`, `TableViewer.tsx` ;
  - `ui/FullScreen.tsx`, `ui/panels/FilePreview.tsx` ;
  - `packages/app/src/renderer/files/read.ts`, `packages/app/tests/viewers.test.ts`.
- Modify : `ui/panels/Panels.tsx`, `ui/NodePopup.tsx`, `App.tsx`, `styles.css`, `packages/view/src/params.ts`, `packages/app/package.json` (CodeMirror), `captures.mjs`.

**Interfaces (Produces) :**
- `read.ts` :
  - `readHead(ref: FileRef, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }>` : `fetch(fileUrl(ref), { headers: { Range: 'bytes=0-<maxBytes − 1>' } })` dès que `ref.size > maxBytes` ;
  - `rangeHeader(size: number, maxBytes: number): string | null`, testable seul.
- `Viewer.tsx` : `<Viewer file={ref} node={id} mode="preview" | "full" />`.
  - Il choisit la vue par `fileKind`. Un `tex` s'affiche en texte, coloré comme LaTeX.
  - Un binaire affiche « Fichier binaire : ouvre-le avec l'application du système. », avec le bouton.
  - Une lecture tronquée affiche un bandeau « Seuls les N premiers Mo sont affichés. ».
- **Vues :**
  - `ImageViewer` : ajustée à la vue ; la molette zoome autour du curseur, le glissement déplace, et un double-clic passe de l'ajustement au 1:1.
  - `TextViewer` :
    - CodeMirror 6 en lecture seule, langage selon l'extension (`@codemirror/language-data`, chargé à la demande) ;
    - numéros de ligne et recherche (Ctrl+F) ;
    - retour à la ligne pour `txt`, `md` et `log`, pas pour le code.
  - `TableViewer` :
    - `parseDelimited` sur au plus `tableMaxRows` lignes, la première ligne en en-tête ;
    - lignes virtualisées de `tableRowPx`, défilement horizontal, numéros de ligne.
- **Plein écran (`FullScreen`) :**
  - il couvre toute la fenêtre, onglets compris ;
  - l'en-tête montre le nom du fichier, le titre du nœud et « Ouvrir avec l'application du système » ;
  - Échap en sort ;
  - il se ferme seul si `resolveTarget` devient null (Review Focus 5).
- **Aperçu d'un fichier (`FilePreview`) :**
  - le même `Viewer` en mode `preview`, dans un `FloatingPanel` épinglable, déplaçable et redimensionnable ;
  - un bouton ⤢ passe en plein écran ;
  - `Panels` gagne `openFile(node, name, near)`, qui place l'aperçu à côté du pop-up (`placeAt`).
- **« Au même endroit » :** `ViewStates`, avec `viewStatesKept` entrées, par empreinte. On y garde :
  - la première ligne visible du texte ;
  - le défilement du tableau ;
  - le zoom et le centre de l'image.
- **Pop-up :**
  - un clic sur un fichier visible dans l'app ouvre son aperçu, et un double-clic le plein écran ;
  - les images ont une vignette (`<img loading="lazy" decoding="async">` de `thumbPx`) ;
  - le menu gagne « Ouvrir en plein écran ».
- **Réglages, groupe « Fichiers » :**
  - `textViewMaxMb` : 32, entre 1 et 512 ;
  - `tableViewMaxMb` : 16, entre 1 et 512 ;
  - `tableMaxRows` : 100 000, entre 1 000 et 2 000 000 ;
  - `tableRowPx` : 24, entre 16 et 48 ;
  - `imageZoomSpeed` : 0,0015, entre 0,0002 et 0,01 ;
  - `thumbPx` : 64, entre 24 et 256 ;
  - `viewStatesKept` : 200, entre 10 et 5 000.

- [ ] **Step 1 : tests** (`packages/app/tests/viewers.test.ts`) :
  - `rangeHeader` : null sous le plafond, `bytes=0-1048575` pour 1 Mo.
  - Le choix de la vue par genre, dont `tex` en texte et `other` sans vue.
  - Fermeture du plein écran quand le fichier est retiré, testée sur la fonction pure qui la décide (Review Focus 5).
- [ ] **Step 2 :** constater l'échec, implémenter, voir passer les tests, puis la suite complète et `tsc`.
- [ ] **Step 3 : captures.**
  - Ajouter `plein-ecran-code` (`calcul_mdl_séquence_aléatoire.py`), `plein-ecran-tableau` (le CSV en Windows-1252 : accents lisibles, colonnes séparées), `plein-ecran-image` et `apercu-fichier` (pop-up et aperçu côte à côte).
  - Clics par `CIRRUS_CLICK` sur `.file[data-name="…"]`.
  - Comparer toutes les captures.
- [ ] **Step 4 :** commit et push (`feat(app): vues des fichiers, aperçus et plein écran`).

### Task 6 : PDF — lecteur, vignettes, liens

**Files :**
- Create : `ui/viewers/PdfViewer.tsx`, `packages/app/src/renderer/files/pdf.ts`, `packages/app/src/renderer/files/pdfLayout.ts`, `packages/app/tests/pdfLayout.test.ts`.
- Modify : `ui/viewers/Viewer.tsx`, `ui/NodePopup.tsx`, `packages/app/src/main/index.ts`, `packages/app/src/main/navigation.ts` et son test, preload, `env.d.ts`, `index.html` (CSP), `packages/app/package.json` (`pdfjs-dist`), `electron.vite.config.ts` si besoin, `params.ts`, `captures.mjs`.

**Interfaces (Produces) :**
- `pdfLayout.ts` (pur) :
  - `pageOffsets(sizes: { w: number; h: number }[], zoom: number, gap: number): Float64Array` : le haut de chaque page, et la hauteur totale en dernier ;
  - `visiblePages(offsets: Float64Array, top: number, height: number, ahead: number): { first: number; last: number }`, par dichotomie ;
  - `fitWidthZoom(pageWidth: number, viewWidth: number, margin: number): number`.
- `pdf.ts` :
  - **pdf.js :**
    - son travailleur, ses cartes de caractères et ses polices standard sont servis par l'app ;
    - les documents s'ouvrent par `getDocument({ url: fileUrl(ref), disableAutoFetch: true })`, ce qui charge par plages ;
    - au plus `pdfDocsKept` documents restent ouverts : le plus ancien est détruit ;
  - `pageThumbnail(ref: FileRef, px: number): Promise<string>` : la première page en URL `blob:`, en cache par empreinte.
- `PdfViewer` :
  - **affichage :**
    - pages virtualisées : seules les pages de `visiblePages` ± `pdfPagesAhead` ont un canevas, à la densité de l'écran ;
    - les autres sont des cases à leur taille ;
    - un canevas qui sort est libéré, et un rendu en cours est annulé au défilement ;
  - **zoom et navigation :**
    - ajusté à la largeur par défaut ;
    - Ctrl+molette et « + » ou « − » font des pas de `pdfZoomStep`, jusqu'à `pdfMaxZoom` ;
    - un champ « page n / N » mène à une page ;
  - **texte :** une couche de texte sélectionnable et copiable sur les pages dessinées ;
  - **liens :**
    - un lien interne mène à sa destination ;
    - un lien `http`, `https` ou `mailto` passe par `openUrl` ;
    - un autre schéma est ignoré (le schéma de l'app vient au plan 4b) ;
  - **« Au même endroit » :** la page, son décalage et le zoom, par `ViewStates`.
- `openUrl(url: string): Promise<void>` (`cirrus:open-url`) : le principal vérifie le schéma par `externalUrlAllowed(url: string): boolean` (`main/navigation.ts` : `http:`, `https:` ou `mailto:` seulement), puis `shell.openExternal`.
- **Pop-up :** les PDF ont la vignette de leur première page, et l'aperçu et le plein écran utilisent `PdfViewer`.
- **Réglages, groupe « Fichiers » :**
  - `pdfPagesAhead` : 1, entre 0 et 5 ;
  - `pdfZoomStep` : 1,15, entre 1,02 et 2 ;
  - `pdfMaxZoom` : 5, entre 1 et 10 ;
  - `pdfDocsKept` : 4, entre 1 et 32 ;
  - `pdfGapPx` : 12, entre 0 et 64.

- [ ] **Step 1 : tests** (`packages/app/tests/pdfLayout.test.ts`) :
  - `pageOffsets` pour trois pages de tailles différentes.
  - `visiblePages` : en haut, au milieu, au bas, une vue plus haute que le document, et `ahead` qui déborde des bornes. Sur 2 000 pages, le résultat est égal à un balayage linéaire pour 1 000 positions au hasard.
  - `fitWidthZoom`.
  - `externalUrlAllowed` (`navigation.test.ts`) : il accepte `https:` et `mailto:`, et refuse `file:`, `javascript:` et `cirrus:`.
- [ ] **Step 2 :** constater l'échec, implémenter, voir passer les tests, puis la suite complète et `tsc`.
- [ ] **Step 3 : captures.**
  - Ajouter `plein-ecran-pdf` (`Li_Vitányi_extrait.pdf`) et `popup-vignettes` (le pop-up du nœud qui porte le PDF et l'image).
  - Si la base de test n'a qu'un PDF d'une page, y ajouter un PDF de plusieurs pages, écrit par un script sans dépendance, pour que la capture montre deux pages.
  - Comparer toutes les captures.
- [ ] **Step 4 :** consigner au registre toute source ajoutée à la CSP pour pdf.js, et ce qui est copié dans l'app (travailleur, cartes, polices) avec sa taille. Commit et push (`feat(app): lecteur PDF, vignettes et liens`).

### Task 7 : Registre, spec, vérification finale

**Files :** `docs/superpowers/plans/2026-11-04-cirrus-fichiers-registre.md`, `2026-11-02-cirrus-design.md` (sections 4 et 12), `docs/captures/plan4a/`.

- [ ] **Step 1 :** la suite complète (`npx vitest run --maxWorkers=1`), `tsc` sur tous les paquets, et toutes les captures, comparées à `reference-3c` et `plan4a` : tout passe, ou l'écart est consigné.
- [ ] **Step 2 : spec.**
  - Section 4 : ajouter à la pile pdf.js, CodeMirror 6 et le protocole `cirrus-file:`, avec les décisions D1 à D7 en une ligne chacune.
  - Section 12 : préciser ce que le plan a fixé :
    - genres de fichiers et leurs vues ;
    - CSV et TSV dans l'app, `.xlsx` par le système ;
    - les exécutables jamais ouverts ;
    - le comportement des pop-ups épinglés ;
    - la fusion par nom au réimport.
- [ ] **Step 3 :** le registre recense les décisions, mesures et mineurs reportés de chaque tâche. Commit et push (`docs: plan 4a, registre et spec`).
