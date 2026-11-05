# Cirrus, plan 4b : la chaîne LaTeX — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** le LaTeX de Cirrus se compile. On peut :
- lire le résumé d'un nœud et la relation d'une connexion compilés dans leurs pop-ups, et les modifier avec l'aperçu sous les yeux ;
- ouvrir un `.tex` en plein écran, l'éditeur à gauche et l'aperçu compilé à droite. Le fichier s'enregistre seul, et chaque version reste dans l'historique ;
- lier les nœuds : un `\ref` vers le label d'un autre nœud affiche son titre, un `\cite` affiche une citation courte de la publication. Un clic sur le lien ouvre le pop-up du nœud. Un label cassé ou en double apparaît en rouge ;
- modifier le préambule global, qui sert à tous les nœuds.

L'aperçu d'un nœud ordinaire s'affiche en moins de 300 ms après la pause de frappe (spec 13). Une erreur laisse le dernier PDF valide à l'écran, avec le journal à côté. LaTeX n'écrit rien hors de son dossier et n'exécute aucune commande (D4, tel que l'utilisateur l'a amendé).

**Architecture :**
- **Compilation :** dans le principal (spec 4), par pdfLaTeX de TinyTeX, préparé d'avance comme au banc (`bench/latex/src/warmCompiler.ts`). Les PDF produits vont dans un cache local, servi par `cirrus-file://latex/…`.
- **Données :** le préambule devient une donnée de la base, versionnée (une opération `preamble`). La clé BibTeX d'une publication est un tag `clé_bibtex`.
- **Registre des labels :** dans l'interface, qui tient l'état (plan 3c). Le principal ne garde que son cache et ses processus.
- **Vues :** un éditeur CodeMirror 6 modifiable, avec coloration, suggestions et diagnostics, sert au résumé, à la relation, aux `.tex` et au préambule. L'aperçu d'un `.tex` est le lecteur PDF du plan 4a. Le résumé et la relation sont dessinés par pdf.js à la largeur de leur pop-up.

**Tech Stack :** celle du plan 4a, plus `@codemirror/autocomplete` et `@codemirror/lint` (dernière version stable à l'installation, figée par `package-lock.json`). La coloration LaTeX est déjà là (`@codemirror/language-data`, mode `stex`). TinyTeX v2026.11, pdfTeX 1.40.29 (TeX Live 2026), celui du banc.

**Spec :** `C:\Users\alpha\Desktop\Cirrus\2026-11-02-cirrus-design.md`, sections 5.2, 5.3, 5.4 (labels, clé BibTeX), 5.6 (préambule), 12 (plein écran `.tex`, résumé compilé), 13 et 19. Les résultats du banc LaTeX sont dans `docs/bancs/resultats.md`, section « LaTeX ».

## Décisions

Chaque décision ci-dessous a comparé ses options. Une décision non prévue ici se consigne au registre (`docs/superpowers/plans/2026-11-05-cirrus-latex-registre.md`, créé à la tâche 1) sous la forme `Ruling:`, avec ses options et son coût si elle est fausse.

- **D1, TinyTeX : téléchargé la première fois qu'il sert, après ton accord, dans `%LOCALAPPDATA%\Cirrus\TinyTeX`.**
  - La version est épinglée (v2026.11, celle du banc) et vérifiée par son empreinte SHA-256 avant d'être lancée. Le téléchargement fait environ 100 Mo, et l'installation environ 300 Mo.
  - Les paquets manquants s'installent d'eux-mêmes par `tlmgr`, depuis le dépôt de TeX Live (spec 13). Chacun s'ajoute au réglage partagé `latexPackages`, que chaque PC installe à son démarrage.
  - *Exécution :* `provision` n'installe que `BASE_PACKAGES`, et les paquets de l'utilisateur passent ensuite par `Packages.ensure`, au mieux (R2.2). Le dépôt est celui de CTAN (`tlmgr option repository ctan`, R2.4). Toutes les sources sont dans `LATEX_SOURCES` (tâche 7), que le serveur remplacera (spec 18). TinyTeX ne livre pas gpg : la signature de la base des paquets n'est pas vérifiée, et la question est rendue à l'utilisateur (registre, tâche 7).
  - L'inclure dans l'installateur viendra peut-être avec le plan 9. Il n'existe pas encore, et ajouterait 100 Mo à chaque mise à jour de l'app.
  - Le dossier de données (`%APPDATA%`, itinérant) ne convient pas à 300 Mo de binaires. Une installation TeX du système irait contre la spec 13.
  - Limite connue : TeX Live gèle son dépôt chaque printemps. Vers avril 2027, le `tlmgr` de 2026 n'installera plus de paquet, et il faudra une TinyTeX plus récente (plan 9).
- **D2, compilation dans le principal, PDF en cache local.**
  - `latexWarmProcesses` pdfLaTeX (2 par défaut) attendent après le préambule. Une compilation en prend un, et un autre se prépare aussitôt.
  - Le cache est dans `<base>/latex/cache`. Chaque PDF y est retrouvé par l'empreinte de tout ce qui entre dans la compilation : source, préambule, titres injectés, fichiers du nœud, mode, versions du moteur et du pilote. Le cache est plafonné à `latexCacheMb` (500 Mo), le plus ancien partant le premier. Il n'est jamais synchronisé (spec 13).
  - L'interface lit ces PDF par `cirrus-file://latex/<empreinte>/<nom>`, comme les fichiers du magasin (plan 4a, D1).
- **D3, résumé et relation : un PDF rogné à son contenu.**
  - La largeur est fixe, `latexSnippetWidthCm` (9 cm), et la hauteur suit le contenu. pdf.js le dessine à la largeur du pop-up, sans dépasser `latexSnippetMaxZoom`.
  - KaTeX ou MathJax seraient instantanés, mais ce ne serait plus la même chaîne : les macros du préambule manqueraient, et le rendu différerait du document (spec 5.2 [C]).
  - Recompiler à la largeur du pop-up recompilerait à chaque redimensionnement.
- **D4, TeX n'écrit que dans son dossier et n'exécute rien. Il peut lire tout fichier que le compte Windows peut lire** (amendée à la tâche 3, R3.1, puis acceptée par l'utilisateur, 2026-11-05 : « Pour ce qui est des tex, ne sois pas excessivement prudent, ce seront les miens »).
  - Les réglages de kpathsea `openout_any=p` et `shell_escape=f` sont passés par l'environnement, avec `-no-shell-escape`. Un nom absolu ou qui remonte (`..`) est donc refusé en écriture.
  - TeX Live 2026 a fait d'`openin_any` un réglage sans effet : `texEnv` ne le pose plus. Risques acceptés : un `.tex` venu d'ailleurs peut recopier un fichier local dans son propre PDF, qui reste dans le cache local, et un nom UNC fait contacter un serveur SMB par Windows. Aucun bac à sable du système n'est prévu.
  - Les autres fichiers du nœud sont visibles sous leur nom (`\includegraphics{schéma.png}`, `\input{annexe}`). Ce sont des liens physiques vers le magasin, rangés dans un dossier hors de celui de TeX que seul `TEXINPUTS` désigne, par un chemin relatif. TeX peut les lire, mais ni les écrire ni les effacer.
- **D5, le préambule est une donnée de la base, versionnée.**
  - C'est une opération `preamble` : elle entre dans l'historique et dans la synchro du plan 5, et Ctrl+Z l'annule.
  - On le modifie dans un plein écran ouvert depuis les réglages, avec un aperçu d'exemple. On l'enregistre explicitement, parce qu'un préambule à moitié tapé casserait toutes les compilations.
  - En faire un réglage le sortirait de l'historique, contre la spec 5.6. En faire un fichier d'un nœud spécial serait du bricolage.
- **D6, un `.tex` se modifie dans son plein écran, éditeur et aperçu côte à côte** (pause et regroupement fixés par l'utilisateur, 2026-11-05).
  - **Quand :** il s'enregistre après une pause de frappe de `texSaveIdleMs` (10 s), à Ctrl+S, à la fermeture du plein écran et à celle de la fenêtre. C'est toujours à condition que le texte diffère de la dernière version enregistrée : taper puis effacer n'enregistre rien.
  - **Regroupement :** des enregistrements successifs du même `.tex` ne forment qu'une seule modification dans l'historique, et un seul Ctrl+Z. Il ne faut aucune autre action entre eux : aucune autre modification, ni annulation, ni rétablissement. Cela vaut d'une ouverture du plein écran à la suivante, pendant une même session de l'app.
  - **Mécanisme :** les enregistrements regroupés portent l'identifiant d'action du premier, dans le journal, et prolongent le même pas d'annulation. Les versions intermédiaires restent dans le journal (quelques Ko chacune), mais l'historique n'en montre qu'une.
  - **Conséquence pour le plan 5 :** une action peut recevoir des lignes après avoir été envoyée, et la synchro doit l'accepter.
  - *Exécution :* la session prend `run(build, { merge })`, la clé d'un `.tex` étant `tex:<nœud>:<nom>`. Un changement reçu (`receive`) met aussi fin au regroupement. Un enregistrement refusé (nœud ou fichier parti) garde le texte dans l'éditeur et le dit ; une seconde demande de fermeture pose « Fermer sans enregistrer ? » (registre, tâche 5).
  - N'enregistrer qu'à la fermeture perdrait la frappe en cas de panne. Enregistrer à chaque frappe ferait une version par lettre.
- **D7, liens entre nœuds.**
  - **Vers un autre nœud :** un `\ref` vers un label d'un autre nœud affiche son titre, avec un lien `cirrus://node/<id>`. Un clic ouvre le pop-up de ce nœud ; le saut avec « précédent » et « suivant » vient avec la navigation (plan 6).
  - **Où un label se définit** (demande de l'utilisateur, 2026-11-05) :
    - par `\label` dans un `.tex` ;
    - par `\label` dans le résumé d'un nœud, par exemple sur une équation ;
    - par `\label` dans la relation d'une connexion ;
    - pour le titre d'un nœud, par un tag `label` (`label: mdl`, un seul par nœud) : `\ref{mdl}` désigne le nœud lui-même. Dans un document (spec 15), ce sera le numéro de sa section.

    Tous ces labels partagent un même registre : chacun est unique dans la base, et un doublon apparaît en rouge, quelle que soit sa sorte.
  - **Dans la même source :** les vrais numéros, par le `.aux` relu. Une seconde passe n'a lieu que si ces numéros ont changé.
  - **Entre deux sources du même nœud** (deux `.tex`, ou le résumé et un `.tex`) : le titre du nœud [C].
  - **Labels invalides :** un label que rien ne définit s'affiche en rouge, suivi de « ? ». Un label défini plusieurs fois s'affiche en rouge, avec le titre de sa première définition.
  - **`\cite{li2008}` :** il affiche « [Li et Vitányi, 2008] », avec un lien vers le nœud de la publication. Une clé inconnue s'affiche en rouge. Une clé portée par plusieurs nœuds aussi, avec la citation du premier par identifiant : la requête porte pour cela `doubledCites` (revue de la tâche 4), et l'éditeur la marque.
  - **Clé de citation :** c'est un tag `clé_bibtex`, plutôt que le champ dédié prévu à la spec 5.4 [C]. Il se synchronise, se cherche et se modifie comme les autres tags, sans changer le modèle. Le plan 4c le remplira à l'import d'une publication.
- **D8, le registre des labels est tenu par l'interface.**
  - Il est dérivé des résumés, des relations, des tags `label` et des `.tex`. Ces derniers sont lus par `cirrus-file:` et gardés en mémoire par empreinte.
  - Le principal reste sans état (plan 3c, décision 3). La requête de compilation porte les titres et les citations dont la source a besoin.

**Hors du plan 4b :**
- la recompilation en arrière-plan après une synchro (plan 5) ;
- le saut vers la cible avec « précédent » et « suivant », et l'aperçu au survol d'un lien (spec 14, plan 6) ;
- la santé du graphe : le registre expose les doublons et les liens cassés, mais leur liste vient plus tard ;
- l'assemblage des documents (spec 15) ;
- la synchronisation entre le source et le PDF (SyncTeX) ;
- l'installation automatique de TinyTeX hors de Windows : ailleurs, `CIRRUS_TINYTEX` désigne une TinyTeX existante.

## Global Constraints

- Les contraintes des plans 3 à 4a valent toujours :
  - travail sur `main`, sans branche, avec un commit puis un push par tâche, jamais en force ;
  - messages de commit en français, terminés par `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` ;
  - syntaxe effaçable, avec l'extension dans les imports ;
  - toute constante de rendu ou d'interaction est un paramètre avancé de `RenderParams`, avec un libellé français, dans le groupe « LaTeX » de la section « Avancé » ;
  - identifiants et commentaires en anglais, textes de l'interface en français.
- **Cloisonnement :**
  - l'interface reste cloisonnée, et seul le principal touche le disque, pdfLaTeX, `tlmgr` et le réseau ;
  - l'interface lit les octets par `cirrus-file:` seulement. Le principal n'y sert que des empreintes SHA-256 valides, celles du magasin (`blob`) et celles du cache (`latex`).
- **TeX (D4) :**
  - pdfLaTeX tourne toujours avec `-no-shell-escape -interaction=nonstopmode -halt-on-error`, et l'environnement de `texEnv` (tâche 2) ;
  - TeX ne reçoit que des noms relatifs : le pilote, le préambule et la source sont dans son dossier de travail ;
  - tout texte de l'utilisateur injecté par l'app passe par `titleToTex` (tâche 1), et un label n'est injecté que s'il passe `safeLabel` ;
  - aucun pdfLaTeX ne survit à la fermeture de l'app.
- **Réseau :** seuls le téléchargement épinglé de TinyTeX, après accord, et `tlmgr` (dépôt de TeX Live) y accèdent, tous deux depuis le principal.
- **Données :** le préambule par défaut n'est jamais stocké. Une base sans préambule utilise `DEFAULT_PREAMBLE` (comme les valeurs par défaut des tags, spec 5.4). Une base plus ancienne s'ouvre sans changement (spec 3).
- **Une action, un pas :** des enregistrements successifs d'un même `.tex`, sans aucune autre action entre eux, forment une seule modification de l'historique et un seul Ctrl+Z (D6). Dans un éditeur, Ctrl+Z agit sur le texte.
- **Performance :**
  - l'aperçu d'un nœud ordinaire s'affiche en moins de 300 ms après la fin de la pause de frappe (cible de la spec 13, mesurée à la tâche 8) ;
  - ouvrir un pop-up dont le résumé est en cache ne compile pas ;
  - le registre ne relit que les sources qui ont changé.
- **Tests :**
  - `npx vitest run --maxWorkers=1` à la racine, et `npx tsc --noEmit -p packages/<paquet>` pour chaque paquet touché ;
  - les tests qui compilent prennent pdfLaTeX dans `CIRRUS_TINYTEX`, sinon dans `bench/latex/vendor/TinyTeX`. Ils sont sautés, avec la raison, si aucun n'est là, et ne téléchargent jamais rien ;
  - aucun test ni aucune capture n'ouvre la base de l'utilisateur, ni n'écrit dans `%LOCALAPPDATA%\Cirrus` ;
  - un seuil de test chronométré vaut environ trois fois la mesure.
- **Captures :**
  - `docs/captures/reference-3c` ne change pas, à 0,5 % des pixels près ;
  - une capture de `docs/captures/plan4a` qui montre un résumé compilé se refait, avec un `Ruling:` ;
  - les nouvelles captures vont dans `docs/captures/plan4b/` ;
  - les captures compilent avec la TinyTeX du banc (`CIRRUS_TINYTEX`), et attendent que la compilation soit finie avant de prendre l'image.

## Review Focus

1. **Des titres et des labels pleins de caractères spéciaux injectés dans une compilation :**
   - un titre comme `50 % & co_x #1 {a} ~ ^ \input{x} θ ≤ ∑`, ou « Rasoir d'Occam » avec son apostrophe typographique ;
   - un label avec `:` sous un préambule `babel` français, qui rend `:` actif ;
   - une base dont le chemin porte des accents.

   L'aperçu montre le texte tel qu'il est écrit. Rien n'est interprété ni exécuté, et la compilation ne casse pas. Testé dans les tâches 1 et 3.
2. **Un `.tex` qui tente de sortir de son dossier :** `\input{C:/Windows/win.ini}`, `\IfFileExists` sur un chemin absolu, `\input{../…}`, un `\openout` vers un fichier du nœud, `\write18`. Tout est refusé, et le magasin reste intact, octet pour octet. Testé dans la tâche 3.
3. **Une compilation qui tourne mal :**
   - une frappe rapide ;
   - une boucle infinie ;
   - un préambule invalide ;
   - LaTeX absent ;
   - un paquet manquant hors ligne.

   Le dernier PDF valide reste affiché, et l'erreur est dite en français. L'interface ne se fige pas, et aucun pdfLaTeX ne reste orphelin. Testé dans les tâches 3, 4 et 7.
4. **Fermer le plein écran ou la fenêtre pendant la pause d'enregistrement d'un `.tex`.** La frappe est enregistrée. Un enregistrement refusé (nœud supprimé entre-temps) garde le texte dans l'éditeur et le dit. Testé dans la tâche 5.
5. **Des liens en mauvais état :**
   - un label défini dans deux nœuds ;
   - un `\ref` vers le label d'un nœud mis à la corbeille ;
   - un `\cite` d'une clé inconnue ou portée par deux nœuds ;
   - un `.tex` plus grand que `textViewMaxMb`.

   Le lien apparaît en rouge dans l'aperçu et dans l'éditeur, sans jamais planter. Testé dans les tâches 4 et 5.

---

### Task 1 : Socle — préambule global, module LaTeX partagé, base de test

**Files :**
- Create :
  - `packages/core/src/latex.ts`, `packages/core/tests/latex.test.ts` ;
  - `packages/fixtures/assets/complexité.tex` ;
  - `docs/superpowers/plans/2026-11-05-cirrus-latex-registre.md`.
- Modify :
  - `packages/core/src/model.ts`, `ops.ts`, `state.ts`, `commands.ts`, `codec.ts`, `snapshot.ts`, `invariants.ts`, `index.ts` ;
  - `packages/store/src/schema.ts` (une migration), `localStore.ts`, `bulk.ts` ;
  - `packages/view/src/sceneUpdate.ts` (l'opération ne touche pas la scène) ;
  - `packages/fixtures/src/build.ts`, et les tests de ces paquets.

**Interfaces (Produces) :**
- `model.ts` : `interface PreambleRec { text: string }`.
- `ops.ts` :
  - `{ t: 'preamble'; before: PreambleRec | null; after: PreambleRec | null }` ;
  - flux `content` ;
  - `subjectOf` rend `'preamble'`.
- `state.ts` :
  - `State.preamble: PreambleRec | null` (null : jamais fixé) ;
  - `preambleText(s: State): string`, qui rend `s.preamble?.text ?? DEFAULT_PREAMBLE`.
- `commands.ts` : `setPreamble(s: State, text: string): Action`.
  - Son libellé est « Modifier le préambule LaTeX ».
  - Un texte égal à `preambleText(s)` lève `CommandError('Le préambule est déjà celui-ci.')`.
  - Remettre exactement `DEFAULT_PREAMBLE` écrit `after: { text: DEFAULT_PREAMBLE }`, et non null : l'historique garde ce qui a été choisi.
- Instantané :
  - `Snapshot.preamble: PreambleRec | null`, encodé dans la partie JSON du codec ;
  - un instantané d'avant ce plan, sans ce champ, se décode avec `preamble: null`.
- Base :
  - la migration suivante crée `CREATE TABLE preamble (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)` ;
  - l'écriture vérifie l'« avant » par `SELECT json FROM preamble WHERE id = 1`, comme les autres enregistrements ;
  - le chargement des tables et `bulk.ts` le lisent et l'écrivent.
- `latex.ts`, exporté par `@cirrus/core` :
  - `DEFAULT_PREAMBLE`, exactement :

    ```latex
    \documentclass[11pt,a4paper]{article}
    \usepackage[T1]{fontenc}
    \usepackage{lmodern}
    \usepackage{amsmath,amssymb,amsthm}
    \usepackage{graphicx}
    \usepackage{xcolor}
    \usepackage{hyperref}
    \hypersetup{colorlinks, linkcolor=blue!50!black, citecolor=green!40!black, urlcolor=blue!60!black}
    ```

  - `CITE_KEY_TAG = 'clé_bibtex'` et `LABEL_TAG = 'label'` (le label du titre d'un nœud, D7) ;
  - `titleToTex(text: string): string` : un texte de l'utilisateur (titre, citation courte) rendu en source pdfLaTeX inerte :
    - `\ # $ % & _ { } ~ ^` deviennent `\textbackslash{} \# \$ \% \& \_ \{ \} \textasciitilde{} \textasciicircum{}` ;
    - les caractères de U+0020 à U+017F (latin de base, Latin-1 et Latin étendu A) et `‘ ’ “ ” « » – — … ·` restent tels quels ;
    - au moins ces caractères passent par une table vers `\ensuremath{…}` :
      - les lettres grecques, `ο` devenant `o` et les majuscules sans commande devenant la latine ;
      - `≤ ≥ ≠ ≈ ≡ ∼ ∝ ∞ ∑ ∏ ∫ ∂ ∇ √ ± ∓ → ← ↔ ⇒ ⇐ ⇔ ∈ ∉ ⊂ ⊆ ⊃ ⊇ ∪ ∩ ∅ ∀ ∃ ¬ ∧ ∨ ℓ` ;
      - `ℕ ℤ ℚ ℝ ℂ` en `\mathbb{…}` ;
    - tout autre caractère devient `?` ;
  - `safeLabel(name: string): boolean` : un nom de 1 à 200 caractères, sans `\ { } % #` ni caractère de contrôle ;
  - les types échangés par l'IPC des tâches 3 à 7 :

    ```ts
    export type CompileMode = 'snippet' | 'page';
    /** A label of another source: its node's title is shown, linked to the node (D7). */
    export interface InjectedRef { label: string; title: string; node: Id | null }
    /** A label of this very source, from its last compile's .aux: its number, page and hyperref anchor. */
    export interface KnownLabel { label: string; number: string; page: string; anchor: string }
    /** text: the short citation, plain Unicode (« Li et Vitányi, 2008 »). */
    export interface InjectedCite { key: string; text: string; node: Id }
    export interface CompileRequest {
      slot: string;           // one per source: 'summary:<id>', 'relation:<id>', 'file:<id>:<name>', 'preamble'
      mode: CompileMode;
      source: string;
      preamble: string;
      refs: InjectedRef[];
      broken: string[];       // cited, defined nowhere
      doubled: InjectedRef[]; // cited, defined more than once: the first definition
      cites: InjectedCite[];
      doubledCites: InjectedCite[]; // cited, held by several nodes: the first's citation (task 4 review)
      unknownCites: string[];
      known: KnownLabel[];    // a hint only: never part of the cache key
      resources: FileRef[];   // the node's other files, visible under their names
    }
    export interface TexError { message: string; line: number | null; where: 'source' | 'preamble' }
    export interface CompiledPdf { key: string; size: number; pages: number }
    export type CompileAnswer =
      | { status: 'ok'; pdf: CompiledPdf; labels: KnownLabel[]; log: string; ms: number; passes: number; cached: boolean; installed?: string[] }
      | { status: 'error'; error: TexError; labels: KnownLabel[]; log: string; ms: number; missing?: string; installed?: string[] }
      | { status: 'cancelled' }
      | { status: 'unavailable'; reason: 'absent' | 'installing' | 'failed'; message: string };
    ```

- Base de test :
  - tag `clé_bibtex` (texte, nœud, une seule valeur, facultatif), et `clé_bibtex: li2008` sur la publication de Li et Vitányi ;
  - tag `label` (texte, nœud, une seule valeur, facultatif), et `label: solomonoff` sur le nœud de Solomonoff ;
  - le nœud de Kolmogorov reçoit `complexité.tex` et `schéma_compression.png`, les mêmes octets que celui de MDL ;
  - le nœud de l'entropie reçoit le résumé `Pour une source $X$ de loi $p$ :\begin{equation}\label{ent:def}H(X) = -\sum_x p(x) \log_2 p(x)\end{equation}en bits.` ;
  - la connexion « Déduction jointe » reçoit la relation `Ensemble, $K(x) \le L_{\mathrm{MDL}}(x) + O(1)$.` ;
  - `complexité.tex`, exactement :

    ```latex
    \section{Complexité de Kolmogorov}\label{kc:section}

    La complexité de $x$ relativement à une machine universelle $U$ est
    \begin{equation}\label{kc:def}
      K_U(x) = \min \{\, |p| : U(p) = x \,\}.
    \end{equation}
    L'équation~\eqref{kc:def} ne dépend de $U$ qu'à une constante près
    (\ref{mdl:enonce} en donne une lecture pratique ; voir \cite{li2008}).
    L'entropie~\eqref{ent:def} en est la version probabiliste ; voir aussi \ref{solomonoff}.
    Un lien cassé reste visible : \ref{absent:label}.

    \includegraphics[width=3cm]{schéma_compression.png}
    ```

- [ ] **Step 1 : tests.**
  - `packages/core/tests/latex.test.ts` :
    - `titleToTex('50 % & co_x #1 {a} ~ ^ \\input{x}')` vaut `50 \% \& co\_x \#1 \{a\} \textasciitilde{} \textasciicircum{} \textbackslash{}input\{x\}` ;
    - `titleToTex('Rasoir d’Occam — été')` reste inchangé ;
    - `titleToTex('θ ≤ ∑ ℝ')` vaut `\ensuremath{\theta} \ensuremath{\leq} \ensuremath{\sum} \ensuremath{\mathbb{R}}` ;
    - `titleToTex('中😀')` vaut `??` ;
    - `safeLabel` est vrai pour `eq:mdl`, `fig:a_b` et `thm 2`, faux pour `''`, `a}b`, `a\\b`, `a%b`, `a#b`, un nom de 201 caractères et `a\u0007b`.
  - Commandes (`packages/core/tests/commands.test.ts`) :
    - `setPreamble` change `preambleText` ;
    - annuler rend `DEFAULT_PREAMBLE` et `preamble` null ;
    - un même texte est refusé avec le message ;
    - l'opération a le sujet `'preamble'` et le flux `content`.
  - Codec : l'aller-retour garde le préambule, et une partie JSON sans `preamble` se décode en `preamble: null`.
  - Base (`packages/store/tests`) :
    - un préambule écrit se relit après réouverture ;
    - un « avant » qui ne correspond plus est refusé (`OpConflictError`) ;
    - une base créée au schéma précédent migre sans perte.
  - Base de test : Kolmogorov porte les deux fichiers, la publication `clé_bibtex: li2008`, Solomonoff `label: solomonoff`, l'entropie son résumé, et « Déduction jointe » sa relation.
- [ ] **Step 2 :** `npx vitest run --maxWorkers=1 packages/core packages/store packages/fixtures`. Attendu : échec, faute de `latex.ts` et de l'opération.
- [ ] **Step 3 :** implémenter. Suivre le chemin de l'opération `tagKey` à travers `ops`, `state`, `codec`, `snapshot`, `invariants`, `localStore` et `bulk`. Dans `sceneUpdate`, l'opération ne demande rien.
- [ ] **Step 4 :** relancer la suite complète et `tsc` sur `core`, `store`, `view`, `fixtures` et `app`. Lancer les captures et les comparer à `docs/captures/reference-3c` et `docs/captures/plan4a`. Un écart (un nœud qui montre désormais des fichiers, par exemple) reçoit un `Ruling:` et sa référence est refaite.
- [ ] **Step 5 :** créer le registre, avec un tableau « Mesures du plan 4b » vide et la section « Décisions du contrôleur (plan 4b) ». Commit et push (`feat(core): préambule LaTeX global, module LaTeX partagé, base de test`).

### Task 2 : Principal — TinyTeX : emplacement, installation épinglée, paquets

**Files :**
- Create : `packages/app/src/main/latex/tinytex.ts`, `packages/app/tests/tinytex.test.ts`.
- Modify :
  - `packages/view/src/params.ts` et ses tests : une sorte de réglage `words` (liste de mots) et `latexPackages` ;
  - `packages/app/src/renderer/ui/SettingsPanel.tsx` : la sorte `words`, un champ où les mots sont séparés par des espaces.

**Interfaces (Produces) :**
- `TINYTEX_RELEASE: { version: 'v2026.11'; asset: string; url: string; sha256: string; bytes: number }`.
  - L'implémenteur trouve le nom exact de l'asset `TinyTeX-1-windows-*.exe` de la version v2026.11 (`https://api.github.com/repos/rstudio/tinytex-releases/releases/tags/v2026.11`). Il le télécharge une fois, en calcule l'empreinte et la taille, et les écrit dans le code.
  - Il consigne au registre l'URL, l'empreinte et la date.
- `interface TexBinaries { root: string; pdflatex: string; tlmgr: string; version: string }`, où `version` est la première ligne de `pdflatex --version`.
- `tinyTexRoot(env: Record<string, string | undefined>): string` :
  - `CIRRUS_TINYTEX` s'il est fixé ;
  - sinon `join(env.LOCALAPPDATA, 'Cirrus', 'TinyTeX')` ;
  - sans l'un ni l'autre, il lève `Error('Dossier de LaTeX introuvable : LOCALAPPDATA n’est pas défini.')`.
- `findBinaries(root: string): Promise<TexBinaries | null>` : `root/bin/windows/pdflatex.exe` et `tlmgr.bat`, s'ils sont là et que `pdflatex --version` répond.
- `texEnv(env: Record<string, string | undefined>): Record<string, string>` :
  - une copie de l'environnement, sans `TEXMFOUTPUT`, `TEXINPUTS`, `TEXMFHOME` ni `TEXMFCNF` ;
  - avec `openin_any=p`, `openout_any=p` et `shell_escape=f`.
  - *Exécution :* il retire aussi `TEXMF_OUTPUT_DIRECTORY` et les variantes de casse et de programme de toutes ces variables, et ne pose plus `openin_any`, sans effet depuis TeX Live 2026 (R3.1).
- *Exécution :* `provision(root, deps, onProgress, release?)`, sans liste de paquets : il règle le dépôt de CTAN, met `tlmgr` à jour et installe `BASE_PACKAGES` ; les paquets de l'utilisateur viennent ensuite par `ensure` (R2.2, R2.4). `ensure(names)` rend `{ installed: string[]; failed: { name, reason }[] }` et ne lève pas pour un nom que `tlmgr` ne connaît pas. Le texte ci-dessous est celui d'avant l'exécution.
- `provision(root, deps, packages, onProgress): Promise<TexBinaries>` :
  - `deps: { download(url: string, dest: string, onBytes: (n: number) => void): Promise<void>; run(file: string, args: string[]): Promise<{ code: number; out: string }> }` ;
  - `onProgress(p: Progress)`, avec `type Progress = { step: 'download'; done: number; total: number } | { step: 'extract' } | { step: 'packages'; names: string[] }`.
  - Les étapes, dans l'ordre :
    1. télécharger dans `<root>.download/` ;
    2. vérifier la taille et l'empreinte. Un écart efface le fichier et lève `Error('Le téléchargement de TinyTeX est corrompu (empreinte inattendue).')` ;
    3. extraire dans `<root>.partial/` (`<exe> -y -o<dossier>`) ;
    4. `tlmgr update --self`, puis `tlmgr install pgf xcolor hyperref amsmath amsfonts amscls lm graphics` et les `packages` ;
    5. renommer en `<root>`, puis effacer `.download` et `.partial`.
  - Tout échec ne laisse ni `<root>`, ni `.partial`, ni `.download` : une installation à moitié faite ne compte jamais comme installée.
- `missingFile(log: string): string | null` :
  - le nom de `! LaTeX Error: File `x.sty' not found.` ;
  - seulement pour les extensions `sty cls bst fd def clo cfg ldf` : un `\input{annexe}` absent n'est pas un paquet.
- `packageOf(out: string, file: string): string | null`, sur la sortie de `tlmgr search --global --file /<file>` : le premier paquet dont un chemin listé finit exactement par `/<file>`.
- `class Packages` :
  - `constructor(bins: TexBinaries, run: Deps['run'])` ;
  - `installed(): Promise<Set<string>>`, par `tlmgr info --list --only-installed --data name`, sans réseau ;
  - `ensure(names: string[]): Promise<string[]>` : il installe ceux qui manquent, et rend ceux qu'il a installés ;
  - `installFor(file: string): Promise<string | null>` : `search`, puis `install`. Il rend le paquet, ou null si aucun ne contient ce fichier ;
  - un seul `tlmgr` tourne à la fois, les appels suivants attendant leur tour.
- Réglage `latexPackages: string[]` :
  - `[]` par défaut ;
  - libellé « Paquets LaTeX ajoutés (installés sur chaque PC) », groupe « LaTeX » ;
  - seuls des mots de `[A-Za-z0-9._-]` sont acceptés. Une valeur invalide garde la valeur par défaut, comme les autres réglages.

- [ ] **Step 1 : tests** (`packages/app/tests/tinytex.test.ts`) :
  - `tinyTexRoot` avec `CIRRUS_TINYTEX`, avec `LOCALAPPDATA` seul, puis sans les deux (le message) ;
  - `findBinaries` : null pour un dossier vide, et les chemins pour la TinyTeX du banc (sauté si absente) ;
  - `texEnv` fixe les trois variables, retire `TEXMFOUTPUT` et `TEXINPUTS`, et garde `PATH` ;
  - `provision`, avec des dépendances factices :
    - le bon chemin appelle les étapes dans l'ordre, puis renomme ;
    - une empreinte fausse lève le message, et ne laisse ni `<root>` ni `.partial` ni `.download` ;
    - un échec de l'extraction ou de `tlmgr` ne laisse rien non plus ;
  - `missingFile` sur des extraits de journaux réels : un `.sty`, un `.cls` et un `\input` absent (null) ;
  - `packageOf` : une correspondance exacte, un nom qui n'est qu'un suffixe d'un autre (`/xfoo.sty` contre `/foo.sty`), et aucune correspondance ;
  - `Packages` (factice) :
    - `ensure` n'installe que les absents ;
    - deux appels simultanés passent l'un après l'autre ;
  - avec la TinyTeX du banc (sauté si absente) : `installed()` contient `hyperref` ;
  - `params.test.ts` : `latexPackages` accepte `['tikz-cd']`, et refuse `['a b']` et `[3]`.
- [ ] **Step 2 :** lancer ces tests. Attendu : échec, faute de `tinytex.ts`.
- [ ] **Step 3 :** implémenter `tinytex.ts`, le réglage et le champ du panneau. En production, `download` passe par `net.fetch` d'Electron, en flux vers le fichier, et `run` par `execFile` avec `windowsHide`. La vérification manuelle suit :
  - fixer `CIRRUS_TINYTEX` sur un dossier temporaire neuf ;
  - appeler `provision` par un petit script ;
  - vérifier que `pdflatex --version` répond et que la version est « TeX Live 2026 » ;
  - effacer le dossier, et consigner la durée et la taille au registre.
- [ ] **Step 4 :** relancer les tests, puis la suite complète et `tsc` sur `app` et `view`.
- [ ] **Step 5 :** commit et push (`feat(app): TinyTeX épinglé, paquets LaTeX installés à la demande`).

### Task 3 : Principal — compilation préchauffée, cloisonnée, en cache

**Files :**
- Create :
  - `packages/app/src/main/latex/driver.ts`, `compiler.ts`, `cache.ts`, `log.ts` ;
  - `packages/app/tests/latexCompiler.test.ts`, `latexLog.test.ts`, `latexCache.test.ts`, et un `tests/latexPdf.ts` qui lit le texte, les liens et la taille des pages d'un PDF par `pdfjs-dist` sous Node.
- Modify :
  - `packages/app/src/main/files.ts` : l'hôte `latex` du protocole ;
  - `packages/app/src/main/index.ts` : le service, les IPC, l'arrêt à la fermeture ;
  - `packages/app/src/preload/index.ts`, `packages/app/src/renderer/env.d.ts` ;
  - `packages/view/src/params.ts` et ses tests.

**Interfaces :**
- Consumes : `texEnv`, `findBinaries` et `TexBinaries` (tâche 2), ainsi que `titleToTex`, `safeLabel` et les types de `latex.ts` (tâche 1).
- Produces :
  - `driverSource(): string` : le pilote du banc (`bench/latex/src/driver.ts`), réécrit pour D4 :
    - `\input{preamble}` est relatif ;
    - après le préambule viennent les macros de l'app, puis des replis par `\providecommand`, pour que les titres injectés compilent même si le préambule ne charge ni `amssymb` ni `xcolor` ni `hyperref` : `\mathbb` devient `\mathbf`, la couleur rouge se passe de `xcolor`, et un lien devient du texte simple sans `hyperref` ;
    - puis `\begin{document}`, `CIRRUS-READY`, la lecture du nom de job en `\scrollmode`, `\nonstopmode`, `\input` du job et `\end{document}`.
  - `jobBody(req: CompileRequest, src: string, widthCm: number): string`. C'est une fonction pure, qui écrit dans l'ordre :
    - les `\r@<label>` des `known` ;
    - ceux des `refs`, dont le texte est `titleToTex(title)` dans un lien `cirrus://node/<id>` ;
    - ceux de `broken`, en rouge : le nom suivi de « ? » ;
    - ceux de `doubled`, en rouge : le titre ;
    - les citations (`\b@<clé>`, texte `titleToTex(text)` lié au nœud), et les clés inconnues, en rouge ;
    - le nom du label est passé par `\detokenize`, pour rester juste quand `babel` rend des caractères actifs. Un label refusé par `safeLabel` est omis ;
    - enfin `\input{<src>}` en mode `page`, ou en mode `snippet` la source composée dans une boîte de `widthCm` (`\parindent=0pt`), puis émise seule sur une page de la taille exacte de la boîte, par `\pdfpagewidth`, `\pdfpageheight` et `\shipout`.
  - `parseLog(log: string, src: string): { error: TexError | null; pages: number; warnings: number }` :
    - la première ligne `!` ;
    - son `l.<n>` quand l'erreur est dans `src` (`where: 'source'`), sinon `line: null` ;
    - une erreur pendant le chargement du préambule donne `where: 'preamble'` et sa ligne dans le préambule ;
    - le nombre de pages vient de `Output written on … (N page`.
  - `readAux(aux: string): KnownLabel[]`, depuis les `\newlabel{x}{{num}{page}{…}{anchor}{…}}`.
  - `class PdfCache` :
    - `constructor(dir: string, maxBytes: () => number)` ;
    - `key(req: CompileRequest, engine: string, widthCm: number): string` : le SHA-256 du JSON de `DRIVER_VERSION`, `engine`, `mode`, `widthCm` (en mode `snippet`), `preamble` (sauf pour un `\documentclass` autonome), `source`, `refs`, `broken`, `doubled`, `cites`, `unknownCites`, et les `resources` triées par nom (nom et empreinte). Jamais `slot` ni `known` ;
    - `get(key): { pdf: CompiledPdf; labels: KnownLabel[]; log: string } | null`, qui touche la date du fichier (le plus ancien part le premier) ;
    - `put(key, pdfPath, meta): CompiledPdf`, par déplacement ;
    - `trim(): void`.
  - `class LatexService` :
    - `constructor(opts: { binaries: () => Promise<TexBinaries | null>; root: string /* <base>/latex */; store: string; cache: PdfCache; params: () => RenderParams; status(s: LatexStatus): void })` ;
    - `compile(req: CompileRequest): Promise<CompileAnswer>` ;
    - `cancel(slot: string): void` ;
    - `warm(preamble: string): void` ;
    - `dispose(): Promise<void>`.
    - `type LatexStatus = { state: 'ready' } | { state: 'absent' } | { state: 'installing'; progress: Progress | { step: 'package'; name: string } } | { state: 'failed'; message: string }`.
    - *Exécution :* à la tâche 7, l'état et `status` passent à `LatexSetup`, placé devant le service, qui gagne `restart()`. `ready` porte `version`. `jobBody` et la clé du cache comptent aussi `doubledCites` (`DRIVER_VERSION` 3 à la fin de la tâche 6).
  - `latexRequest(cacheDir: string, url: string, range: string | null): BlobAnswer`, dans `files.ts` :
    - `cirrus-file://latex/<clé de 64 hex>/<nom>`, servi depuis `<cacheDir>/<clé>.pdf` en `application/pdf` ;
    - avec les mêmes règles que `blobRequest` : 400, 404, plages, et `Content-Security-Policy: sandbox`.
  - IPC et pont :
    - `latexCompile(req: CompileRequest): Promise<CompileAnswer>` (`cirrus:latex:compile`). Le principal valide la forme de la requête : chaînes, tableaux, `source` d'au plus `textViewMaxMb`, empreintes des ressources présentes au magasin, noms plats ;
    - `latexCancel(slot: string): void` ;
    - `latexWarm(preamble: string): void` ;
    - `latexStatus(): Promise<LatexStatus>`, et `onLatexStatus(cb: (s: LatexStatus) => void): () => void`, poussé par `cirrus:latex:status`.
  - Réglages, groupe « LaTeX » :
    - `latexWarmProcesses` : 2, de 1 à 4, « pdfLaTeX préparés d'avance » ;
    - `latexTimeoutMs` : 10000, de 1000 à 120000, « Durée maximale d'une compilation (ms) » ;
    - `latexSnippetWidthCm` : 9, de 4 à 20, pas de 0,5, « Largeur du résumé et de la relation compilés (cm) » ;
    - `latexCacheMb` : 500, de 20 à 20000, « Taille du cache des PDF compilés (Mo) » ;
    - `latexLogMaxKb` : 256, de 16 à 4096, « Taille gardée d'un journal de compilation (Ko) ».

**Mécanisme imposé (D2, D4) :**
- **Dossiers :**
  - chaque processus préparé a son dossier de travail `<base>/latex/work/p<n>/`, qui contient `driver.tex`, `preamble.tex` et les jobs ;
  - et son dossier de liens `<base>/latex/links/p<n>/`, hors du premier ;
  - son environnement est `texEnv(process.env)`, plus `TEXINPUTS=<dossier de liens>;` (le `;` final garde les chemins de la distribution) ;
  - `work` et `links` sont vidés au démarrage du service.
- **Job :**
  - avant de remettre le nom du job, le service remplit le dossier de liens : un lien physique vers le fichier du magasin pour chaque ressource, ou une copie si le lien échoue ;
  - les noms sont vérifiés : ni `/`, ni `\`, ni `:`, ni `.` ou `..` ;
  - la source est écrite en UTF-8 sous `job-<n>-src.tex`, et le corps sous `job-<n>-body.tex`.
- **Après la sortie :**
  - le résultat est bon si le code vaut 0, si le PDF existe et s'il n'y a aucune erreur ;
  - les labels du `.aux` sont relus. Si ceux que la source définit et cite diffèrent des `known` reçus, une seconde compilation part avec les nouveaux, une fois au plus (`passes: 2`) ;
  - le PDF va au cache, avec le journal (les derniers `latexLogMaxKb`) et les labels.
- **`\documentclass` hors d'un commentaire :** la source est compilée telle quelle, à froid, avec le même environnement et les mêmes dossiers. Une seconde passe suit si le `.aux` a changé ou si le journal demande « Rerun ».
- **File d'attente :**
  - une requête dont la clé est en cache répond aussitôt, avec `cached: true`, sans processus ;
  - une nouvelle requête d'un emplacement annule celle qui l'attend ou qui tourne (`cancelled`, le processus tué) ;
  - les autres attendent un processus préparé, dans l'ordre d'arrivée.
- **Préambule :** une requête dont le préambule diffère de celui des processus préparés les remplace : le dernier préambule l'emporte.
- **Erreurs :**
  - `latexTimeoutMs` dépassé : le processus est tué, avec l'erreur « Compilation trop longue (plus de 10 s) : arrêtée. », la durée étant celle du réglage ;
  - préambule invalide : « Le préambule ne compile pas : <ligne !> », avec `where: 'preamble'`, rendu avant le délai (repris du banc) ;
  - fichier manquant : l'erreur porte `missing` (`missingFile`). L'installation vient à la tâche 7.
- **Sans pdfLaTeX** (`binaries()` rend null) : `unavailable`, avec `reason: 'absent'`.
- **Fermeture :** `will-quit` attend `dispose()`, qui tue tous les pdfLaTeX et attend leur sortie.

- [ ] **Step 1 : tests.**
  - Unitaires, sans TeX :
    - `parseLog` et `readAux` sur des extraits réels : erreur dans la source avec sa ligne, erreur dans le préambule, pages, labels ;
    - `jobBody` : un label refusé par `safeLabel` est omis, et un titre passe par `titleToTex` ;
    - `PdfCache` : la même requête donne la même clé, et `known` ou `slot` ne la changent pas. Un octet de plus dans la source la change. Au-delà du plafond, `trim` efface le plus ancien ;
    - `latexRequest` : 200, 206, 400 pour une clé invalide, et 404 pour une clé absente.
  - Avec pdfLaTeX (sauté si absent), chaque test sur sa propre base temporaire. L'une a un chemin accentué (`cirrus-é-…`, Review Focus 1). Le préambule est `DEFAULT_PREAMBLE`, sauf mention contraire :
    - `snippet : la page a la largeur réglée et la hauteur du contenu` : `Bonjour $x^2$.` à 9 cm donne une page de 255,1 ± 1 pt de large et de moins de 40 pt de haut ;
    - `page : un fragment prend les pages du préambule` : une page A4 (595,3 pt) ;
    - `un \ref vers un autre nœud affiche son titre et mène au nœud` : le texte contient le titre de MDL, et un lien `cirrus://node/<id>` ;
    - `titres spéciaux : rien ne casse` : le titre `50 % & co_x #1 {a} \input{x}` donne `ok`, et le texte contient `50 % & co_x #1 {a} \input{x}` ;
    - `babel français : les références injectées tiennent` : le préambule avec `\usepackage[french]{babel}` et un ref `eq:x` montre le titre ;
    - `label cassé et doublon en rouge` : le texte contient `absent:label ?` et le titre du doublon ;
    - `\cite d'une publication` : le texte contient `[Li et Vitányi, 2008]`, avec un lien vers son nœud ;
    - `numéros internes : seconde passe seulement s'ils changent` : une équation et `(\ref{a})` donnent `(1)` avec `passes: 2`. La même requête avec les `labels` rendus, mais un mot changé, donne `passes: 1` ;
    - `cache : la même requête ne recompile pas` : `cached: true`, sans nouveau processus ;
    - `annulation par l'emplacement` : une source lente puis une rapide, au même emplacement, donnent `cancelled` puis `ok` ;
    - `délai : une boucle infinie est arrêtée` : `\loop\iftrue\repeat` avec `latexTimeoutMs` à 2000 donne l'erreur en moins de 4 s ;
    - `préambule invalide : dit, et vite` : `where: 'preamble'`, avant le délai ;
    - `TeX ne lit pas hors de son dossier` (Review Focus 2) : `\input{C:/Windows/win.ini}` et `\input{../../links/p1/x}` échouent, et `\IfFileExists{C:/Windows/win.ini}{OUI}{NON}` affiche `NON`. *Exécution :* ce test est retiré, TeX Live 2026 laissant tout lire (D4 amendée, R3.1) ; les tests d'écriture et de `\write18` restent ;
    - `TeX n'écrit pas dans les fichiers du nœud` : un `\openout` vers le fichier de ressource, par son nom et par `../../links/p<n>/<nom>`, laisse le fichier du magasin identique, à l'empreinte près ;
    - `aucune commande` : `\immediate\write18{cmd /c echo x > pwned.txt}` ne crée aucun fichier ;
    - `fichiers du nœud sous leur nom` : `\includegraphics{schéma_compression.png}` compile, et l'image est dans le PDF ;
    - `\documentclass : compilé tel quel` : un document autonome en `letterpaper` donne une page de 612 pt ;
    - `fichier manquant` : le préambule avec `\usepackage{paquetinexistant}` donne `missing: 'paquetinexistant.sty'` ;
    - `fermeture : aucun pdfLaTeX ne reste` : après `dispose()`, aucun des processus lancés n'est vivant.
- [ ] **Step 2 :** lancer ces tests. Attendu : échec, faute des modules.
- [ ] **Step 3 :** implémenter, en reprenant `WarmCompiler` du banc et les points de `docs/bancs/resultats.md` (« À reprendre dans l'app », « Restent à traiter »). Câbler le protocole, les IPC, le pont et les réglages.
- [ ] **Step 4 :** relancer les tests, puis la suite complète et `tsc` sur `app` et `view`. Consigner au registre la durée d'une compilation préchauffée de `complexité.tex` (p50 sur 20).
- [ ] **Step 5 :** commit et push (`feat(app): compilation LaTeX préchauffée, cloisonnée et en cache`).

### Task 4 : Interface — registre des labels et des citations, requêtes, compilation à la pause

**Files :**
- Create :
  - `packages/app/src/renderer/latex/scan.ts`, `registry.ts`, `request.ts`, `scheduler.ts`, `useCompiled.ts`, `texts.ts` ;
  - `packages/app/tests/latexScan.test.ts`, `latexRegistry.test.ts`, `latexRequest.test.ts`, `compileScheduler.test.ts`.
- Modify :
  - `packages/app/src/renderer/App.tsx` : les textes des `.tex` et le registre au niveau de l'app, et `latexWarm` après le chargement ;
  - `packages/view/src/params.ts` et ses tests.

**Interfaces :**
- Consumes : `CompileRequest` et les types de `latex.ts`, `preambleText`, `CITE_KEY_TAG` (tâche 1), et le pont `latexCompile` / `latexCancel` (tâche 3).
- Produces :
  - `scanTex(text: string): TexScan` :

    ```ts
    /** from, to: the name's offsets inside its braces; line: 1-based. */
    export interface TexMark { name: string; from: number; to: number; line: number }
    export interface TexScan { labels: TexMark[]; refs: TexMark[]; cites: TexMark[]; standalone: boolean }
    ```

    - refs : `\ref \eqref \pageref \autoref \cref \Cref \nameref \vref`, avec leurs formes étoilées ;
    - citations : `\cite \citep \citet \citealp \citealt \citeauthor \citeyear \nocite \parencite \textcite`, avec leurs formes étoilées, jusqu'à deux arguments optionnels `[…]`, et des clés séparées par des virgules, espaces retirés ;
    - un `%` non échappé commence un commentaire, et les environnements `verbatim`, `Verbatim` et `lstlisting` sont sautés ;
    - `standalone` : un `\documentclass` hors d'un commentaire.
  - `type Origin = { kind: 'summary'; node: Id } | { kind: 'relation'; connection: Id } | { kind: 'file'; node: Id; name: string }` : une source qui se compile ;
  - `type DefOrigin = Origin | { kind: 'title'; node: Id }` : là où un label est défini, le titre d'un nœud compris (tag `label`, D7) ;
  - `slotOf(o: Origin): string` : `'summary:<id>'`, `'relation:<id>'` ou `'file:<id>:<nom>'`.
  - `interface LabelDef { label: string; origin: DefOrigin; line: number; title: string; node: Id | null }`, où :
    - `title` est le titre du nœud, ou celui de la connexion pour une relation (`node` vaut alors null) ;
    - `line` vaut 0 pour un tag `label`.
  - `class LatexRegistry` :
    - `static build(s: State, texts: ReadonlyMap<string, string>, previous?: LatexRegistry): LatexRegistry` ;
    - les sources sont, pour les nœuds et les connexions hors de la corbeille :
      - les résumés et les relations non vides ;
      - les tags `label` ;
      - les `.tex` dont le texte est dans `texts` (clé : l'empreinte) ;
    - avec `previous`, une source dont l'origine et le texte n'ont pas changé reprend son analyse sans la refaire ;
    - `definitions(label: string): LabelDef[]`, dans l'ordre des identifiants ;
    - `labels(): LabelDef[]` ;
    - `citeNodes(key: string): Id[]` ;
    - `citeKeys(): { key: string; node: Id; text: string }[]`.
  - `shortCitation(n: NodeRec): string` :
    - les noms viennent des tags `auteur`, dans leur ordre : le dernier mot de chacun (« Paul Vitányi » donne « Vitányi ») ;
    - l'année vient des quatre premiers chiffres de `date_de_publication` ;
    - « Li, 2008 » pour un auteur, « Li et Vitányi, 2008 » pour deux, « Li et al., 2008 » à partir de trois ;
    - sans auteur, le titre du nœud ; sans année, rien après le nom.
  - `buildRequest(a: { origin: Origin; source: string; s: State; registry: LatexRegistry; known: KnownLabel[] }): CompileRequest` :
    - `mode` vaut `page` pour un fichier, et `snippet` pour un résumé ou une relation ;
    - chaque label cité que la source ne définit pas va dans :
      - `refs` s'il a une définition ;
      - `broken` s'il n'en a aucune ;
      - `doubled` s'il en a plusieurs, avec la première ;
    - chaque clé citée va dans `cites` si elle a un nœud (le premier par identifiant s'il y en a plusieurs), sinon dans `unknownCites` ;
    - `resources` : les fichiers du nœud, sauf la source elle-même ; aucun pour une relation ;
    - `preamble` vaut `preambleText(s)`.
  - `class CompileScheduler` (pure, son temps et son pont injectés) :
    - `constructor(bridge: { compile(r: CompileRequest): Promise<CompileAnswer>; cancel(slot: string): void }, timers, pauseMs: () => number)` ;
    - `request(r: CompileRequest | null): void` ;
    - `subscribe(cb: (v: CompiledView) => void): () => void` ;
    - `dispose(): void`.

    ```ts
    export interface CompiledView {
      pdf: CompiledPdf | null;   // the last good one: kept while compiling and after an error
      error: TexError | null;    // of the latest finished compile
      log: string;
      pending: boolean;
      unavailable: { reason: 'absent' | 'installing' | 'failed'; message: string } | null;
      missing?: string;
    }
    ```

    - la première requête part aussitôt, ce qui fait qu'ouvrir un pop-up n'attend pas ;
    - une requête qui change annule aussitôt la compilation en cours de son emplacement et part après `pauseMs`, chaque nouvelle requête relançant la pause ;
    - une réponse `cancelled`, ou celle d'une requête dépassée, est ignorée ;
    - les `labels` rendus servent de `known` à la requête suivante du même emplacement, par une table du module.
  - `useCompiled(req: CompileRequest | null): CompiledView`, une mince enveloppe React du planificateur.
  - `texts.ts` : `loadTexTexts(s: State, have: ReadonlyMap<string, string>, maxBytes: number, signal: AbortSignal): Promise<Map<string, string>>` :
    - il lit par `readHead` et `decodeText` (plan 4a) les `.tex` qui ne sont pas encore lus, quatre à la fois ;
    - un binaire ou un texte tronqué est écarté, et compte comme vide ;
    - l'app relance la construction du registre, au plus une fois par `latexTypingPauseMs`, quand l'état ou les textes changent.
  - Réglage `latexTypingPauseMs` : 300, de 50 à 3000, « Pause de frappe avant de compiler (ms) ».

- [ ] **Step 1 : tests.**
  - `scanTex` :
    - les labels, les refs et les citations avec leurs positions et leurs lignes ;
    - `% \label{x}` est ignoré, mais pas `\% \label{y}` ;
    - `\cite[p.~3][voir]{a, b}` donne deux marques ;
    - `\eqref*{x}` est une ref ;
    - un label dans `verbatim` est ignoré ;
    - `% \documentclass{article}` n'est pas autonome.
  - Registre :
    - un label défini dans deux nœuds a deux définitions ;
    - celui d'un nœud à la corbeille n'en a plus ;
    - un label d'une relation porte le titre de la connexion ;
    - le tag `label: solomonoff` définit `solomonoff`, d'origine `title`, avec le titre du nœud ;
    - un tag `label` qui reprend le `\label` d'un `.tex` d'un autre nœud donne deux définitions ;
    - `citeNodes('li2008')` donne la publication de la base de test ;
    - reconstruire après la modification d'un seul résumé n'analyse que lui (un compteur injecté dans l'analyse).
  - `shortCitation` : un auteur, deux, trois, aucun, et une date absente.
  - `buildRequest` sur la base de test, pour `complexité.tex` :
    - `refs` contient `mdl:enonce` avec le titre et l'identifiant de MDL, `ent:def` (une équation de son résumé) avec le titre de l'entropie, et `solomonoff` (le titre) avec celui de Solomonoff ;
    - `broken` vaut `['absent:label']` ;
    - `cites` contient `li2008` avec « Li et Vitányi, 2008 » ;
    - `kc:def` n'est pas dans `refs` ;
    - `resources` vaut `[schéma_compression.png]`.
  - `CompileScheduler`, avec de fausses minuteries et un faux pont :
    - trois requêtes pendant la pause n'en compilent qu'une, la dernière ;
    - une requête qui change annule (`cancel` appelé) ;
    - la première part sans pause ;
    - une erreur garde le dernier `pdf` ;
    - une réponse dépassée est ignorée ;
    - les labels rendus reviennent en `known` (Review Focus 3).
- [ ] **Step 2 :** lancer ces tests. Attendu : échec, faute des modules.
- [ ] **Step 3 :** implémenter, et câbler le registre et `latexWarm` dans `App`.
- [ ] **Step 4 :** relancer les tests, puis la suite complète et `tsc` sur `app` et `view`.
- [ ] **Step 5 :** commit et push (`feat(app): registre des labels et des citations, compilation à la pause`).

### Task 5 : Interface — éditeur LaTeX, plein écran d'un `.tex`, enregistrement

**Files :**
- Create :
  - `packages/app/src/renderer/ui/latex/LatexEditor.tsx`, `editorLogic.ts`, `TexWorkbench.tsx`, `CompileLog.tsx`, `saveScheduler.ts` ;
  - `packages/app/tests/latexEditor.test.ts`, `texSave.test.ts`.
- Modify :
  - `packages/app/src/renderer/ui/FullScreen.tsx` : un `.tex` ouvre l'atelier ;
  - `packages/app/src/renderer/ui/viewers/Viewer.tsx` : l'aperçu d'un `.tex` montre le PDF compilé ;
  - `packages/app/src/renderer/ui/viewers/PdfViewer.tsx` : le mode `live` ;
  - `packages/app/src/renderer/files/kind.ts`, `pdf.ts` : `ViewRef` ;
  - `packages/app/src/renderer/App.tsx` : enregistrer avant la fermeture ;
  - `packages/app/src/renderer/session.ts` et ses tests : l'option `merge` ;
  - `packages/store/src/files.ts` et ses tests : `storeBytes` ;
  - `packages/app/src/main/index.ts`, le preload, `env.d.ts` : `storeText` ;
  - `packages/app/package.json` ;
  - `packages/view/src/params.ts`.

**Interfaces :**
- Consumes : `LatexRegistry`, `buildRequest`, `useCompiled` et `scanTex` (tâche 4), `filesBuild` (plan 4a), et `UndoStack.extend` (plan 3b), que l'option `merge` de la session réutilise.
- Produces :
  - `storeBytes(storeDir: string, name: string, bytes: Uint8Array): FileRef`, dans `@cirrus/store`, avec les garanties d'`importFile` : fsync, renommage, et doublon reconnu par l'empreinte ;
  - `storeText(name: string, text: string): Promise<FileRef>` (`cirrus:files:store-text`). Le principal refuse un nom qui ne passe pas `checkFileName` (plan 4a), et un texte de plus de `maxImportMb`. Le texte est écrit en UTF-8, sans BOM.
  - `type ViewRef = FileRef & { store?: 'latex' }`. `fileUrl` prend l'hôte `latex` pour un PDF compilé, et le cache de documents de `pdf.ts` est rangé par `<store>:<hash>`.
  - `editorLogic.ts` :
    - `refContext(doc: string, pos: number): { kind: 'ref' | 'cite'; from: number; prefix: string } | null` : la position est-elle dans les accolades d'une ref ou d'une citation (tâche 4) ?
    - `completionsFor(ctx, registry): { label: string; detail: string }[]`. Le préfixe se compare sans casse ni accents. Une ref a pour détail le titre du nœud, une citation la citation courte ;
    - `type Diag = { from: number; to: number; severity: 'error' | 'warning'; message: string }` ;
    - `diagnosticsFor(scan: TexScan, req: CompileRequest, registry: LatexRegistry, own: Origin, error: TexError | null, lineStart: (line: number) => number): Diag[]` :
      - « Label inconnu : x » ;
      - « Label défini plusieurs fois : x » ;
      - « Ce label existe déjà dans « <titre> » » (pour un label défini ici et ailleurs) ;
      - « Clé de citation inconnue : x » ;
      - l'erreur de compilation, à sa ligne quand elle est dans la source.
  - `LatexEditor(props: { value: string; onChange(text: string): void; registry: LatexRegistry; diagnostics: Diag[]; compact?: boolean; autoFocus?: boolean; onSave?(): void; ariaLabel: string; jumpTo?: { line: number; seq: number } })` :
    - CodeMirror modifiable, en `stex`, avec la recherche (Ctrl+F) et les phrases françaises du plan 4a ;
    - les suggestions par `@codemirror/autocomplete`, et les diagnostics par `@codemirror/lint` ;
    - les numéros de ligne, sauf en `compact` ;
    - Ctrl+S appelle `onSave` ;
    - les raccourcis de l'app (Suppr, Ctrl+Z…) ne partent pas d'un éditeur qui a le focus.
  - `TexWorkbench(props: { node: NodeRec; file: FileRef; state: State; registry: LatexRegistry; params: RenderParams; onSave(text: string): Promise<{ ok: boolean; message?: string }>; onClose(): void })`, dans le plein écran (`FullScreen` garde sa modalité et son Échap) :
    - à gauche l'éditeur, à droite l'aperçu (`PdfViewer` en mode `live` sur le dernier PDF valide) ;
    - un bandeau d'état : « Compilation… », « Erreur ligne 12 : … », « Enregistré », « Non enregistré : <raison> » ;
    - un bouton « Journal » ouvre `CompileLog`, où un clic sur une erreur place l'éditeur à sa ligne ;
    - le fichier est lu par `readHead`. Un texte tronqué ou un binaire s'affiche sans pouvoir être modifié, avec la raison.
  - `class SaveScheduler` (pure, son temps injecté) :
    - `constructor(saved: string, save: (text: string) => Promise<{ ok: boolean }>, timers, idleMs: () => number)`, où `saved` est le texte du fichier ouvert ;
    - `edit(text: string): void`, `saveNow(): Promise<void>`, `flush(): Promise<void>` ;
    - `dirty: boolean` (le texte diffère du dernier enregistré), `onState(cb)` ;
    - il enregistre après `idleMs` sans frappe, à `saveNow` (Ctrl+S) et à `flush` (fermeture), seulement si le texte diffère du dernier enregistré (D6) ;
    - un enregistrement refusé garde `dirty` et le texte.
  - Regroupement (D6), dans la session : `run(build, { merge?: string })`.
    - Si la dernière action écrite par la session portait la même clé `merge`, et que rien n'a été écrit depuis (aucune autre action, aucune annulation, aucun rétablissement), la nouvelle action reprend son identifiant : ses lignes du journal portent le même `action_id`, et elle prolonge le même pas d'annulation (`UndoStack.extend`).
    - Sinon, c'est une action nouvelle.
    - La clé d'un `.tex` est `tex:<nœud>:<nom normalisé par sameName>`.
    - Cette mémoire ne dure que le temps de la session de l'app.
  - Enregistrer un `.tex` :
    - `storeText(nom, texte)`, puis `filesBuild(s, node, [ref])`, qui garde le nom et la place, par `run(…, { merge })` ;
    - le libellé de l'action est « Modifier « complexité.tex » » ;
    - à la fermeture de la fenêtre, `App` attend le `flush` de l'atelier ouvert avant d'envoyer l'instantané.
  - `PdfViewer` en mode `live` : un nouveau `file` remplace le document sur place, avec le même zoom et le même défilement, borné à la nouvelle hauteur. Les anciennes pages restent jusqu'à ce que les nouvelles soient dessinées, sans éclair blanc.
  - Aperçu d'un `.tex` (panneau `FilePreview`) :
    - le PDF compilé (`PdfViewer`, lecture seule), avec « Compilation… » avant le premier ;
    - LaTeX indisponible : le source, comme au plan 4a.
  - Réglage `texSaveIdleMs` : 10000, de 1000 à 600000, « Pause de frappe avant l'enregistrement d'un .tex (ms) ».

- [ ] **Step 1 : tests.**
  - `refContext` et `completionsFor` :
    - `\ref{md|` donne `mdl:enonce`, avec le titre de MDL ;
    - `\cite{LI|` donne `li2008`, avec « Li et Vitányi, 2008 » ;
    - `\eqref{|` propose tous les labels ;
    - hors d'une ref, null.
  - `diagnosticsFor` sur `complexité.tex` :
    - `absent:label` est inconnu, à sa position ;
    - un label `kc:def` défini aussi dans un autre nœud du test est signalé ;
    - une erreur de compilation à la ligne 4 couvre la ligne 4.
  - `SaveScheduler`, avec de fausses minuteries (Review Focus 4) :
    - frappes puis pause de 10 s : un seul enregistrement, et aucun avant la fin de la pause ;
    - taper puis revenir au texte enregistré : aucun enregistrement, ni à la pause ni à `flush` ;
    - Ctrl+S enregistre aussitôt ;
    - `flush` enregistre ce qui reste ;
    - un refus garde `dirty`, et le suivant réessaie.
  - Regroupement, sur une session et une base de test temporaire :
    - trois enregistrements successifs de `complexité.tex` donnent un seul `action_id` au journal, une seule modification dans `historySummary`, et un seul Ctrl+Z, qui revient au texte d'avant le premier ;
    - un déplacement de nœud entre deux enregistrements les sépare : deux modifications ;
    - une annulation entre deux enregistrements les sépare aussi ;
    - l'enregistrement d'un autre `.tex` les sépare aussi ;
    - deux ouvertures successives du plein écran, sans rien entre elles, se regroupent.
  - `storeBytes` : l'empreinte et la taille sont justes, et un second appel identique ne crée pas de doublon. `storeText` refuse `a/b.tex`, `..` et `nul.tex`.
  - Avec pdfLaTeX (sauté si absent) : la requête de `complexité.tex` (tâche 4) compile, et le PDF contient le titre de MDL.
- [ ] **Step 2 :** lancer ces tests. Attendu : échec.
- [ ] **Step 3 :** implémenter. Vérifier dans l'app construite, sur une copie de la base de test :
  - ouvrir `complexité.tex` en plein écran, taper, voir l'aperçu changer ;
  - fermer par Échap pendant la pause, puis vérifier que la nouvelle version est dans le pop-up ;
  - rouvrir, modifier encore et refermer : le pop-up compte une seule modification de plus ;
  - Ctrl+Z, une fois le plein écran fermé, annule les deux ouvertures d'un coup.
- [ ] **Step 4 :** relancer les tests, la suite complète et `tsc` sur `app`, `store` et `view`. Lancer les captures et les comparer aux références.
- [ ] **Step 5 :** commit et push (`feat(app): éditeur LaTeX et plein écran d'un .tex`).

### Task 6 : Interface — résumé et relation compilés, liens `cirrus:`

**Files :**
- Create :
  - `packages/app/src/renderer/ui/latex/LatexSnippet.tsx`, `LatexField.tsx`, `fieldState.ts`, `links.ts` ;
  - `packages/app/tests/latexField.test.ts`.
- Modify :
  - `packages/app/src/renderer/ui/NodePopup.tsx`, `ConnectionPopup.tsx` ;
  - `packages/app/src/renderer/ui/viewers/PdfViewer.tsx` : les liens `cirrus:` ;
  - `packages/app/src/renderer/App.tsx` : ouvrir le pop-up d'un nœud lié ;
  - `packages/app/src/main/navigation.ts` : son commentaire seulement, car `cirrus:` ne va jamais au système ;
  - `packages/app/scripts/captures.mjs` : TinyTeX, et l'attente de la compilation ;
  - `packages/view/src/params.ts`.

**Interfaces :**
- Consumes : `useCompiled`, `buildRequest` et `Origin` (tâche 4), `LatexEditor` et `CompileLog` (tâche 5), et `ViewRef` (tâche 5).
- Produces :
  - `nodeLinkOf(url: string): Id | null` : l'identifiant de `cirrus://node/<id>` si `<id>` est un identifiant de l'app (`/^[0-9a-f-]{36}$/`), sinon null.
  - `LatexSnippet(props: { pdf: CompiledPdf; params: RenderParams; onNodeLink(id: Id): void })` :
    - toutes ses pages, ajustées à la largeur du conteneur, sans dépasser `latexSnippetMaxZoom`, nettes selon `devicePixelRatio` ;
    - une couche de texte sélectionnable ;
    - les liens : `cirrus://node/…` appelle `onNodeLink`, `http`, `https` et `mailto` passent par `openUrl` (plan 4a), et tout autre lien est ignoré.
  - `fieldState.ts`, un réducteur pur, `fieldReducer(state: FieldState, event: FieldEvent): { state: FieldState; commit?: string }` :
    - états `view` et `edit` (avec son brouillon) ;
    - un clic ailleurs que sur un lien, ou Entrée ou F2 quand le champ a le focus, passe en `edit` ;
    - le focus qui quitte le champ et son aperçu fait un `commit` si le brouillon diffère, puis revient en `view` ;
    - Échap rend la valeur enregistrée et revient en `view`, sans `commit`.
  - `LatexField(props: { origin: Origin; value: string; placeholder: string; state: State; registry: LatexRegistry; params: RenderParams; onCommit(text: string): void; onNodeLink(id: Id): void })` :
    - **en `view` :**
      - le snippet compilé ;
      - avant la première compilation, ou si LaTeX est indisponible : le source, en caractères à chasse fixe, avec la raison en petit ;
      - une erreur avec un PDF valide : le snippet, une ligne rouge « Erreur ligne 2 : … » et un bouton « Journal » ;
      - une erreur sans PDF valide : le source et la ligne rouge ;
      - une valeur vide : le texte d'attente, en gris ;
    - **en `edit` :** `LatexEditor` compact, avec le snippet du brouillon dessous, compilé à la pause.
  - `NodePopup`, « Résumé » : `LatexField`, d'origine `summary`, avec le texte d'attente « Résumé, en LaTeX ». `commit` passe par `summaryBuild`, et un refus remet la valeur.
  - `ConnectionPopup`, « Relation » : `LatexField`, d'origine `relation`, avec « Relation, en LaTeX ». Le titre de la connexion change de libellé : il devient « Titre court ».
  - `App`, `onNodeLink(id)` :
    - ouvre le pop-up non épinglé du nœud, à droite du panneau d'où vient le clic, ou le fait passer devant s'il est ouvert ;
    - pour un nœud absent ou à la corbeille, une notification « Ce nœud n'existe plus. » ;
    - les liens `cirrus:` de `PdfViewer` (aperçu d'un `.tex`, atelier, PDF du magasin) font de même. Le principal ne reçoit jamais un `cirrus:`.
  - Réglage `latexSnippetMaxZoom` : 1,6, de 0,5 à 4, pas de 0,1, « Agrandissement maximal du résumé compilé ».
  - Captures :
    - `captures.mjs` passe `CIRRUS_TINYTEX=bench/latex/vendor/TinyTeX`, et refuse de tourner s'il est absent ;
    - en mode capture, l'interface ne signale `cirrus:ready` qu'une fois toutes les compilations demandées finies.

- [ ] **Step 1 : tests.**
  - `nodeLinkOf` : un identifiant valide, `cirrus://node/` sans identifiant, `cirrus://autre/x`, `https://…`, et un identifiant de 35 caractères.
  - `fieldReducer` :
    - clic : passage en `edit` ;
    - Échap : retour, sans `commit` ;
    - focus perdu avec changement : `commit` ;
    - sans changement : pas de `commit` ;
    - Entrée et F2 passent en `edit`.
- [ ] **Step 2 :** lancer ces tests. Attendu : échec.
- [ ] **Step 3 :** implémenter. Vérifier dans l'app construite :
  - le résumé de l'entropie compilé dans son pop-up ;
  - la modification avec l'aperçu sous les yeux ;
  - Échap ;
  - la relation de « Déduction jointe » ;
  - un clic sur le titre de MDL dans l'aperçu de `complexité.tex`, qui ouvre le pop-up de MDL.
- [ ] **Step 4 :** relancer les tests, la suite complète et `tsc` sur `app` et `view`. Lancer les captures :
  - `reference-3c` reste inchangé, la fenêtre de connexion d'« Analogue bayésien » n'ayant pas de relation ;
  - les captures de `plan4a` qui montrent le résumé de MDL se refont, avec un `Ruling:` qui dit lesquelles.
- [ ] **Step 5 :** commit et push (`feat(app): résumé et relation compilés, liens entre nœuds`).

### Task 7 : Préambule, installation de LaTeX, paquets manquants

**Files :**
- Create :
  - `packages/app/src/renderer/ui/latex/PreambleEditor.tsx`, `LatexNotice.tsx` ;
  - `packages/app/tests/latexInstall.test.ts`.
- Modify :
  - `packages/app/src/renderer/ui/SettingsPanel.tsx` : une section « LaTeX » ;
  - `packages/app/src/renderer/App.tsx`, `actions.ts` (`preambleBuild`) ;
  - `packages/app/src/main/index.ts`, `latex/compiler.ts` ;
  - le preload, `env.d.ts`.

**Interfaces :**
- Consumes : `provision`, `Packages` et `TINYTEX_RELEASE` (tâche 2), `LatexService` (tâche 3), `LatexEditor` (tâche 5), et `setPreamble` (tâche 1).
- Produces :
  - `latexInstall(): Promise<void>` (`cirrus:latex:install`) :
    - lance `provision` vers `tinyTexRoot(process.env)`, avec `latexPackages` (*exécution :* `provision`, puis `ensure(latexPackages)` avant `ready`) ;
    - le statut passe par `installing` (progression), puis `ready` ou `failed` ;
    - un second appel pendant l'installation est sans effet ;
    - le principal ne télécharge jamais rien sans cet appel.
  - **Paquets :**
    - au démarrage, une fois la fenêtre chargée et pdfLaTeX présent, le principal fait `Packages.ensure(latexPackages)` en arrière-plan. Un échec hors ligne est seulement consigné dans la console ;
    - une compilation qui rend `missing` déclenche `installFor`, avec le statut `{ state: 'installing', progress: { step: 'package', name } }`. Si un paquet est installé, les processus préparés sont refaits, la compilation repart une fois, et la réponse porte `installed: <paquet>` (*exécution :* `installed` est une liste, et la compilation repart après chaque nouveau paquet) ;
    - si aucun paquet n'est trouvé ou si `tlmgr` échoue : l'erreur « Paquet LaTeX introuvable pour « x.sty » (hors ligne ?) ».
  - `withPackage(params: RenderParams, name: string): RenderParams | null` : null si le paquet est déjà dans la liste ou dans celle de `provision`. Sinon, l'interface ajoute le paquet à `latexPackages` et enregistre les réglages.
  - `LatexNotice` (en haut de la fenêtre, une fois par session) :
    - sans LaTeX : « LaTeX n'est pas installé : les résumés et les .tex s'affichent en source. Cirrus peut installer TinyTeX (environ 100 Mo à télécharger). », avec « Installer » et « Plus tard » ;
    - pendant l'installation : « Installation de LaTeX : 37 % » au téléchargement, puis « Installation de LaTeX : décompression… » et « Installation des paquets… » ;
    - une fois installé : « LaTeX est installé. » ;
    - en cas d'échec : « L'installation de LaTeX a échoué : <raison> », avec « Réessayer » ;
    - pendant l'installation d'un paquet : « Installation du paquet LaTeX « x »… ».
  - `SettingsPanel`, section « LaTeX » :
    - l'état (« LaTeX : prêt (TeX Live 2026) », « absent », « installation… ») ;
    - les boutons « Installer LaTeX » (s'il est absent) et « Modifier le préambule… ».
  - `PreambleEditor`, en plein écran modal comme celui des fichiers :
    - `LatexEditor` sur un brouillon du préambule, et l'aperçu de `PREAMBLE_SAMPLE` compilé avec ce brouillon (emplacement `'preamble'`, mode `page`). `PREAMBLE_SAMPLE` est un paragraphe accentué, une équation numérotée citée par `\eqref`, une liste et un lien ;
    - les boutons « Enregistrer » (`preambleBuild(texte)`, par `setPreamble`), « Annuler » et « Préambule par défaut » (qui met `DEFAULT_PREAMBLE` dans le brouillon) ;
    - enregistrer un brouillon qui ne compile pas demande « Le préambule ne compile pas. L'enregistrer quand même ? » ;
    - Échap avec des changements non enregistrés demande « Abandonner les modifications du préambule ? ».

- [ ] **Step 1 : tests** (`packages/app/tests/latexInstall.test.ts`, avec un service et des dépendances factices) :
  - installation :
    - absent, puis installation, puis les statuts dans l'ordre jusqu'à `ready` ;
    - un second appel pendant l'installation est sans effet ;
    - un échec donne `failed` avec le message français, et réessayer est possible ;
  - paquet manquant :
    - `installFor` rend `x` : recompilation, et `installed: 'x'` ;
    - `installFor` rend null : le message ;
    - un paquet installé ne l'est qu'une fois, même demandé par deux compilations à la fois ;
  - `withPackage` : un ajout, un doublon (null), et un paquet de la liste de `provision` (null) ;
  - `preambleBuild` : l'action s'annule par Ctrl+Z.
- [ ] **Step 2 :** lancer ces tests. Attendu : échec.
- [ ] **Step 3 :** implémenter. Vérifier dans l'app construite :
  - sans `CIRRUS_TINYTEX`, et avec `LOCALAPPDATA` pointant vers un dossier temporaire, la notice, l'installation complète et la première compilation ;
  - puis le préambule : ajouter `\usepackage{tikz-cd}` (installé à la demande s'il manque), enregistrer, et voir les aperçus suivre.
- [ ] **Step 4 :** relancer les tests, la suite complète et `tsc` sur `app`.
- [ ] **Step 5 :** commit et push (`feat(app): préambule, installation de LaTeX et des paquets`).

### Task 8 : Mesures, captures, spec

**Files :**
- Create : `docs/captures/plan4b/*.png`, et `docs/bancs/latex-app-2026-11-05.md`.
- Modify :
  - `packages/app/scripts/captures.mjs` : les scènes nouvelles ;
  - `2026-11-02-cirrus-design.md` : sections 4, 5.4, 12 et 13 ;
  - le registre.

- [ ] **Step 1 : mesures dans l'app construite**, sur une copie de la base de test, avec la TinyTeX du banc. Le temps va de la fin de la pause de frappe à l'image de l'aperçu dessinée :
  - 20 modifications du résumé de l'entropie dans son pop-up ;
  - 20 modifications de `complexité.tex` dans son atelier ;
  - l'ouverture d'un pop-up dont le résumé est en cache ;
  - la première compilation après le démarrage.

  Les médianes et p95 vont au registre (« Mesures du plan 4b ») et dans `docs/bancs/latex-app-2026-11-05.md`. Si la cible de 300 ms n'est pas tenue pour les deux premières, la cause est mesurée et consignée, avec le levier suivant.

  Le mécanisme de mesure est libre (marques de performance, `CIRRUS_KEYS`), sans interface nouvelle.
- [ ] **Step 2 : captures** dans `docs/captures/plan4b/` :
  - `popup-resume-compile` : le pop-up de l'entropie ;
  - `relation-compilee` : la fenêtre de « Déduction jointe » ;
  - `plein-ecran-tex` : l'atelier sur `complexité.tex`, avec le lien cassé en rouge dans l'éditeur et dans l'aperçu ;
  - `tex-erreur` : l'atelier après une frappe qui casse la compilation, avec le dernier PDF valide, la ligne d'erreur et le journal ;
  - `preambule` : l'éditeur du préambule.

  Comparer aussi les suites `reference-3c` (11 sur 11) et `plan4a`.
- [ ] **Step 3 : spec.**
  - Section 13 : un paragraphe « Fixé par le plan 4b », en prose et en listes comme celui de la section 12, avec ce que l'usage donne de D1 à D8, et chaque choix de Claude marqué [C] ;
  - section 4 : TinyTeX et le cache ;
  - section 5.4 : la clé BibTeX devient le tag `clé_bibtex` ;
  - section 12 : le plein écran `.tex` et le résumé compilé.
- [ ] **Step 4 :** la suite complète, `tsc` sur les cinq paquets, et les trois suites de captures.
- [ ] **Step 5 :** commit et push (`docs: plan 4b, mesures, captures et spec`).
