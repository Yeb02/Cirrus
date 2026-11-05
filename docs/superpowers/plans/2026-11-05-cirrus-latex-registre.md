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

### Mesures

- **Asset épinglé** : `TinyTeX-1-windows-v2026.11.exe`, de la version v2026.11, publiée le 2026-11-01. La version existe : aucun repli n'a été nécessaire.
  - URL : `https://github.com/rstudio/tinytex-releases/releases/download/v2026.11/TinyTeX-1-windows-v2026.11.exe` ;
  - taille : 73 710 178 octets ;
  - SHA-256 : `375e8adec0177cd9ec6a1f8c76efe0c22b1a0c260e76a00386bcea52d88e5354` ;
  - téléchargé et haché le 2026-11-05. L'empreinte calculée est celle que GitHub affiche pour l'asset (`digest`).
- **Vérification manuelle de `provision`** : un script jetable, avec le `fetch` de Node à la place de `net.fetch`, et le reste du module tel quel (`fetchDownload`, `runFile`).
  - `CIRRUS_TINYTEX` désignait un dossier temporaire neuf, créé vide d'avance, et dont le chemin porte une espace (`%TEMP%\cirrus provision-…\TinyTeX`) ;
  - deux passes, chacune dans un dossier neuf : avant et après la correction du code de sortie (plus bas).

  | Passe | Total | Téléchargement | Extraction | `tlmgr` (mise à jour, 9 paquets) et renommage | Taille installée |
  | --- | --- | --- | --- | --- | --- |
  | 1 | 75,7 s | 17,9 s | 36,5 s | 21,3 s | 313,5 Mo |
  | 2 | 73,0 s | 18,8 s | 34,1 s | 20,2 s | 313,5 Mo |
  | 3 (après la revue : dépôt de CTAN, 8 paquets de base) | 86,7 s | 20,6 s | 34,6 s | 31,5 s | 313,5 Mo |

  - Les passes 1 et 2 installaient aussi `tikz-cd` par `provision`, depuis `tlnet.yihui.org`.
  - La passe 3 suit les décisions R2.2 et R2.4 (plus bas) : `tlmgr option repository ctan`, puis `update --self` et `BASE_PACKAGES`, depuis les miroirs de CTAN. Les paquets de l'utilisateur sont venus ensuite, par `ensure`.

  - `pdflatex --version` : « pdfTeX 3.141592653-2.6-1.40.29 (TeX Live 2026) », la version du banc. Il ne reste que `<root>`, ni `.partial` ni `.download` ;
  - sur cette installation, avec le vrai `tlmgr` :
    - `installed()` compte 126 paquets, dont les huit de `BASE_PACKAGES` et `tikz-cd` ;
    - la sortie de `tlmgr search --global --file /siunitx.sty` a la forme que `packageOf` lit (`siunitx:` puis le chemin, après une tabulation). `installFor('siunitx.sty')` rend `siunitx`, en 10,4 s puis en 9,2 s ;
    - `installFor` d'un fichier qu'aucun paquet ne contient rend null, et `ensure(['siunitx', 'tikz-cd'])` rend `[]` ;
  - `DEFAULT_PREAMBLE` compile sur l'installation neuve, sous `texEnv`, avec les seuls paquets de `BASE_PACKAGES` (PDF de 50 627 octets) ;
  - dépôt : TinyTeX règle `tlmgr` sur `https://tlnet.yihui.org`, un miroir de tlnet. `tlmgr` affichait « verified », grâce au gpg de Git présent dans le PATH de Git Bash. Avec le PATH de Windows, c'est « not verified » (constat sous la décision R2.4). Depuis cette décision, `provision` passe au dépôt de CTAN ;
  - les deux dossiers temporaires sont effacés. `%LOCALAPPDATA%\Cirrus` n'a jamais été créé.
- **Défaut trouvé à la première passe, et corrigé** : un `tlmgr install` d'un paquet inconnu rendait le code 0.
  - Cause : `tlmgr.bat` finit par `goto :eof` après `tlmgr.pl`. Lancé seul par `cmd /c`, un tel fichier perd son code de sortie. `perl tlmgr.pl` rend 25, par `call` 1, et sans `call` 0.
  - Correction : `runFile` passe par `cmd /d /s /c "call "<bat>" <args>"`. Un test refait la fin de `tlmgr.bat` : il échouait avant la correction et passe depuis.
  - À la seconde passe, le même `tlmgr install` rend 1.
- Suite : 601 tests sur 601 (581 avant la tâche) : 19 dans `tinytex.test.ts`, et un de plus dans `params.test.ts`. Après les correctifs de la revue : 604 sur 604, dont 22 dans `tinytex.test.ts`. `tsc` : `app` et `view` sans erreur. Les deux tests qui ont besoin de la TinyTeX du banc sont sautés, avec leur raison, si elle manque (vérifié avec `CIRRUS_TINYTEX=C:\nulle-part`).

### Décisions

- Ruling: **`provision` prend un cinquième paramètre facultatif, `release`** (`TINYTEX_RELEASE` par défaut).
  - Pourquoi : on ne fabrique pas un fichier qui ait l'empreinte du vrai asset. Sans ce paramètre, le bon chemin ne se testerait qu'en téléchargeant, ce que les tests ne font jamais.
  - Coût si faux : un paramètre.
- Ruling: **`findBinaries(root, run = runFile)`** : un second paramètre facultatif. `provision` vérifie ainsi pdfLaTeX dans `.partial`, par `deps.run`, avant de renommer, et `<root>` n'apparaît qu'une fois l'installation complète. Le renommage est la dernière étape. Coût si faux : nul.
- Ruling: **un `<root>` déjà là** : vide, il est retiré (`rmdirSync`, qui échoue sur un dossier non vide). Non vide, il est refusé avant tout téléchargement, et n'est jamais effacé.
  - Message : « Le dossier <root> existe déjà mais ne contient pas de TinyTeX qui fonctionne : supprime-le pour réinstaller LaTeX. »
  - Pourquoi : `CIRRUS_TINYTEX` peut désigner un dossier de l'utilisateur. Renommer sur un dossier existant échouerait sous Windows, mais seulement après 70 s de travail.
  - Coût si faux : l'utilisateur efface lui-même une TinyTeX cassée.
- Ruling: **les dépendances de production sont dans `tinytex.ts`, sans Electron** :
  - `runFile` (`execFile`, `windowsHide`) ;
  - `fetchDownload(fetchFn)`, qui écrit la réponse dans le fichier au fil du flux.

  La tâche 7 passera `fetchDownload(net.fetch)`. La vérification manuelle a pris `fetchDownload(fetch)`, c'est-à-dire le même code. `onBytes(n)` reçoit le total écrit jusque-là, qui devient `done`. Une erreur de réseau ou de disque devient « Le téléchargement de TinyTeX a échoué (<raison>). ». Coût si faux : nul.
- Ruling: **un `.bat` passe par `cmd.exe /d /s /c "call …"`, avec une ligne de commande que `runFile` construit lui-même.**
  - Node refuse de lancer un `.bat` sans interpréteur (EINVAL), et `shell: true` avec des arguments est déprécié (DEP0190).
  - Chaque argument doit être un mot de `[A-Za-z0-9._/=-]`, et le chemin du `.bat` ne doit porter ni `"`, ni `%`, ni `^`. Sinon, l'appel est refusé avant de lancer quoi que ce soit (« Argument refusé pour tlmgr.bat : … »).
  - Pourquoi : `cmd.exe` lirait `&`, `|`, `%…%` comme des commandes ou des variables. Or le nom d'un fichier manquant vient du journal d'un `.tex`, qui peut venir d'ailleurs.
  - Coût si faux : un paquet dont le nom porterait `+` serait refusé. Aucun n'est apparu.
- Ruling: **`missingFile` ne rend qu'un nom de `[A-Za-z0-9._-]`** : il va sur la ligne de commande de `tlmgr`. Ce sont les caractères de `latexPackages`. Coût si faux : un paquet au nom exotique ne s'installe pas de lui-même.
- Ruling: **`texEnv` retire aussi les variantes de ses sept variables** : `TEXMFOUTPUT`, `TEXINPUTS`, `TEXMFHOME` et `TEXMFCNF`, qu'il enlève, et `openin_any`, `openout_any` et `shell_escape`, qu'il fixe.
  - Les variantes : les autres casses (Windows ignore la casse d'un nom), ainsi que `VAR.progname` et `VAR_progname`, que kpathsea lit avant `VAR`.
  - Pourquoi : sans cela, un `openin_any_pdflatex=a` dans l'environnement de l'utilisateur déferait D4.
  - Coût si faux : nul.
- Ruling: **`runFile` donne aux outils (`tlmgr`, `pdflatex --version`) l'environnement privé des quatre chemins de l'utilisateur et de leurs variantes**, mais sans les réglages paranoïaques.
  - Pourquoi : un `TEXMFCNF` laissé par une autre distribution ferait lire à `tlmgr` les arbres d'une autre TeX. `fmtutil` et `updmap`, lancés par `tlmgr`, écrivent dans les arbres de TinyTeX, ce que `openout_any=p` pourrait gêner.
  - Coût si faux : nul.
- Ruling: **`Packages` met `tlmgr` à jour si le dépôt l'exige**, puis réessaie l'installation une fois.
  - Le signal : la sortie de l'installation contient « tlmgr itself needs to be updated ».
  - Pourquoi : TeX Live met à jour `tlmgr` lui-même en cours d'année. Un `tlmgr` plus ancien refuse alors toute installation (`tlmgr.pl`, `check_for_critical_updates`). Sans cela, les paquets à la demande cesseraient de s'installer quelques semaines après l'installation.
  - Coût si faux : une dizaine de lignes.
- Ruling: **`ensure` est un seul tour de la file** : la liste des paquets installés, puis leur installation, sans autre appel entre les deux. Coût si faux : nul.
- Ruling: **la sortie de `run` (`out`) est la sortie standard, suivie de la sortie d'erreur.** `tlmgr` écrit ses erreurs dans la seconde. Un échec rend sa cause : « tlmgr install a échoué (code 1) : … », selon la décision R2.1 du contrôleur, qui remplace « sa dernière ligne ». `installed()` ne garde que les lignes sans espace. Coût si faux : nul.
- Ruling: **l'étape `packages` est annoncée avant le premier appel à `tlmgr`** (`option repository ctan`), avec la liste qui sera installée, `BASE_PACKAGES` seuls (décision R2.2). Coût si faux : nul.
- Ruling: **le renommage final est réessayé** sur EPERM, EACCES et EBUSY : jusqu'à vingt fois, toutes les 250 ms.
  - Pourquoi : un antivirus qui lit encore les binaires frais empêche Windows de déplacer le dossier.
  - Le nettoyage (`rmSync`, `maxRetries: 10`) ne masque jamais l'erreur qui l'a causé. Ce qui reste, la passe suivante l'efface d'abord.
  - Coût si faux : nul.
- Ruling: **la sorte `words` porte ses caractères** (`WORD`, exporté par `@cirrus/view`), plutôt qu'un motif propre à chaque fiche.
  - Pourquoi : `latexPackages` est le seul réglage de cette sorte.
  - Le champ du panneau sépare les mots par des espaces et retire les doublons. Un mot invalide y remet le texte précédent, comme le champ des listes.
  - Coût si faux : un champ `pattern` dans `ParamSpec`.
- ~~Ruling: le dépôt de TinyTeX est gardé (`tlnet.yihui.org`).~~ Remplacée par la décision R2.4 du contrôleur : `provision` passe au dépôt de CTAN. La signature « verified » que cette décision invoquait venait du gpg de Git, et non de TinyTeX (constat sous R2.4).

## Tâche 3 : principal — compilation préchauffée, cloisonnée, en cache

### Constat : TeX Live 2026 ne restreint plus les lectures

- **Ce que TeX Live 2026 a changé** : `openin_any` n'a plus aucun effet. Le `texmf.cnf` de TinyTeX v2026.11 le dit, lignes 702 à 716 : « as of 2026, openin_any no longer has any effect; the underlying kpse_in_name_ok and related functions always return true » (fil `tex-live` de décembre 2025). La raison donnée : le réglage cassait des compilations normales, et des moyens détournés lisaient tout de même les zones interdites.
- **Mesuré** (pdfTeX 1.40.29, environnement de `texEnv`, `openin_any=p` posé, pilote préchauffé) :
  - `kpsewhich -safe-in-name` accepte un nom absolu (`C:/Windows/win.ini`), un nom qui remonte (`../x.tex`) et un nom UNC (`//evil.example/share/x.tex`). Il refuse les mêmes noms en écriture (`-safe-out-name`) ;
  - `\input{C:/Windows/win.ini}` lit le fichier, et le journal montre `(c:/Windows/win.ini)`. `\input{../../links/p1/x.tex}` lit aussi. `\IfFileExists{C:/Windows/win.ini}{OUI}{NON}` affiche OUI ;
  - les primitives de pdfTeX lisent tout chemin :
    - `\pdffiledump` a mis dans le PDF les premiers octets de `win.ini` (« ; for 16-bit app ») ;
    - `\pdfmdfivesum file`, `\pdffilesize` et `\pdffilemoddate` y ont mis l'empreinte, la taille et la date d'un fichier ;
    - `\pdfximage` y a mis une image prise ailleurs sur le disque ;
    - `\pdfobj stream file` y a mis le contenu d'un fichier texte ;
  - redéfinir les commandes ne protège pas : après `\let\input\relax`, `\pdfprimitive\input{…}` lit encore. expl3 garde en plus ses propres copies des primitives (`\tex_filedump:D`…) ;
  - un nom UNC fait ouvrir par Windows une connexion SMB vers un serveur quelconque.
- **Ce qui tient** :
  - `\openout` vers `../../links/p<n>/schéma_compression.png` est refusé (« I can't write on file »), et le fichier du magasin reste identique, octet pour octet ;
  - `\write18` ne lance rien.
- **Décision du contrôleur, appliquée dans cette tâche :**

  Ruling (provisoire, soumis à l'utilisateur) : D4 devient « TeX n'écrit que dans son dossier et n'exécute rien ; il peut lire tout fichier que le compte Windows peut lire » — TeX Live 2026 a fait d'`openin_any` un réglage sans effet, et aucune solution simple ne restreint les lectures — risques restants : un .tex venu d'ailleurs peut recopier un fichier du disque dans son propre PDF, qui reste dans le cache local, et un nom UNC fait contacter un serveur SMB par Windows ; le vrai remède est un bac à sable du système (AppContainer : aucune lecture hors des dossiers accordés, aucun réseau), au plan 9 sauf décision contraire de l'utilisateur.

  - En conséquence :
    - `texEnv` ne pose plus `openin_any`. Le laisser suggérerait une protection qui n'existe pas ; un commentaire d'une ligne le dit ;
    - les tests du Review Focus 2 sont reformulés : trois tests d'écriture et `\write18`, sans aucun test de lecture, ni refusée ni permise.
  - Les options pesées pour garder D4 sont dans le rapport de la tâche 3 :
    - un bac à sable du système (le seul qui tienne) ;
    - l'examen de la source avant compilation ;
    - le fichier `-recorder` relu après coup : falsifiable, car la source peut le tronquer par `\openout` ;
    - un autre moteur.

### Mesures

- **Compilation préchauffée de `complexité.tex`** :
  - **p50 de 138 ms sur 20** (min 130, max 144) ;
  - conditions : `DEFAULT_PREAMBLE`, mode `page`, l'image du nœud, trois références, une citation, un label cassé, et les `known` de la première compilation (une passe chacune). Une pause de 1,2 s entre deux compilations laisse la réserve se refaire : la mesure est celle d'un processus prêt ;
  - le test `complexité.tex préchauffé` refait la mesure. Son seuil est de 420 ms, trois fois la mesure.
  - Décomposition, mesurée avant les deux optimisations ci-dessous (p50 de 156 ms) :

    | Étape | Durée |
    | --- | --- |
    | Clé | 1 ms |
    | Prise d'un processus | 12 ms, le lancement du remplaçant qui bloquait le fil |
    | Liens, source et corps | 5 ms |
    | pdfLaTeX | environ 115 ms |
    | Lecture du journal et du `.aux` | 7 ms |
    | Mise en cache | 11 ms |

  - pdfLaTeX seul, mesuré hors du service (du nom du job à la sortie) : 113 ms pour ce `.tex`, 89 ms pour `Bonjour $x^2$.`. Le banc mesurait de 35 à 84 ms, avec un autre préambule et d'autres fragments.
- **Chemin accentué (Review Focus 1)** : chaque test qui compile a sa base sous `cirrus-é-latex-…`. Un `TEXINPUTS` absolu n'y trouve pas `schéma_compression.png`, alors que la même base en ASCII le trouve. La forme relative le trouve (décision plus bas).
- **Suite** : 645 tests sur 645 (604 avant la tâche) :

  | Fichier | Tests ajoutés |
  | --- | --- |
  | `latexCompiler.test.ts` | 23 (2 sans TeX) |
  | `latexLog.test.ts` | 12 |
  | `latexCache.test.ts` | 4 |
  | `latex.test.ts` (core) | 1 |
  | `params.test.ts` | 1 |

  `tsc` : `app`, `view`, `core`, `store` et `fixtures` sans erreur. `electron-vite build` réussit. Une capture de l'app construite (`CIRRUS_TINYTEX` du banc) démarre, s'écrit, puis quitte sans laisser de `pdflatex.exe`. `%LOCALAPPDATA%\Cirrus` n'a pas été créé.
- **Le test `TEXMF_OUTPUT_DIRECTORY` mord** : sans le correctif de `texEnv`, pdfLaTeX a écrit `.aux`, `.log`, `.out`, `.pdf` et le fichier de `\openout` dans le dossier de la variable, et le test échoue. Avec le correctif, ce dossier reste vide.

### Décisions

- Ruling: **`TEXINPUTS=../../links/p<n>;`, relatif au dossier de travail**, et non le chemin absolu du dossier de liens.
  - Options :
    - le chemin absolu (la tâche) ;
    - un nom court 8.3 : Node ne sait pas le demander, et il peut être désactivé sur le volume ;
    - des copies dans le dossier de travail : lent pour un gros fichier, et TeX pourrait les écrire ;
    - le chemin relatif (choix).
  - Pourquoi :
    - le chemin absolu échoue sous un chemin de base accentué (mesuré) : kpathsea semble lire l'environnement dans la page de code ANSI ;
    - le chemin relatif reste en ASCII quel que soit le chemin de la base, et désigne le même dossier.
  - Coût si faux : une ligne.
- Ruling: **`texEnv` retire aussi `TEXMF_OUTPUT_DIRECTORY`** (TeX Live 2024) et ses variantes de casse et de programme.
  - Pourquoi : cette variable, posée dans l'environnement de l'utilisateur, envoyait ailleurs tout ce que TeX écrit (mesuré).
  - Elle s'ajoute aux quatre variables de chemin de la tâche 2. `runFile`, qui lance `tlmgr` et `pdflatex --version`, l'enlève donc aussi.
  - Coût si faux : nul.
- Ruling: **un dossier par processus**, `work/p<n>` et `links/p<n>`, `n` étant le numéro du processus, et `job-<n>` son job.
  - Les dossiers sont effacés dès que le processus est sorti et son PDF parti au cache, puis vidés au démarrage du service.
  - Pourquoi : un remplaçant se prépare pendant que le job précédent tourne. Partager un dossier de liens mêlerait leurs fichiers.
  - Coût si faux : deux dossiers et deux petits fichiers par processus, environ 1 ms.
- Ruling: **le pilote définit trois macros de l'app.**
  - `\cirrus@label{nom}{numéro}{page}{ancre}` définit `\r@<nom>` à cinq champs, avec ou sans hyperref :
    - le noyau de 2026 lit lui aussi cinq champs (mesuré : `\ref` affiche le premier, `\pageref` le deuxième) ;
    - le nom est passé par `\detokenize`.
  - `\cirrus@cite{clé}{texte}` définit `\b@<clé>` directement. hyperref met son lien de citation dans `\bibcite`, et non dans `\cite` : le seul lien est donc le nôtre, et aucun lien n'est imbriqué.
  - `\cirrus@link{id}{texte}` donne `\href{cirrus://node/<id>}{texte}` :
    - le préfixe de l'adresse est passé par `\detokenize` dès la lecture du pilote, si bien qu'aucun caractère actif de babel n'y entre ;
    - l'identifiant n'est injecté que s'il vérifie `[0-9A-Za-z_-]{1,100}` ; sinon, pas de lien.
  - Un label d'une autre source a pour premier champ son titre lié, et ses champs 4 et 5 vides. hyperref 7.01s ne fait alors pas son propre lien (« Suppressing link with empty target ») : un seul lien `cirrus://node/<id>`, que pdf.js lit.
  - Coût si faux : quelques lignes du pilote, et `DRIVER_VERSION`.
- Ruling: **la page d'un label d'une autre source est « ? »**, pour un label cassé ou en double aussi.
  - Pourquoi : `\pageref` vers un autre nœud n'a pas de page. Le titre ne convient pas non plus : hyperref fait de la page le nom d'une ancre, `page.<champ>`.
  - Coût si faux : un champ.
- Ruling: **un label ou une clé porteur de `^^` est omis**, en plus de ce que refuse `safeLabel`.
  - Pourquoi : TeX lit `^^7b` comme `{` avant tout le reste, et le corps du job casserait.
  - Les champs des `known` (numéro, page, ancre) sont injectés tels que le `.aux` les donne. Ils sont omis si leurs accolades ne s'équilibrent pas, ou s'ils portent `#`, `%`, `^^` ou un caractère de contrôle.
  - Coût si faux : un label exotique s'affiche en « ?? ».
- Ruling: **une clé de citation inconnue s'affiche en rouge, suivie de « ? »** (`[li2009 ?]`), comme un label cassé. Un doublon s'affiche en rouge, avec le titre de sa première définition, **lié à son nœud** s'il en a un : le lien est posé autour du rouge, qui l'emporte ainsi sur `urlcolor`. Coût si faux : une ligne de `jobBody`.
- Ruling: **les labels que la source cite** sont l'argument de toute commande finissant par `ref` (`\ref`, `\eqref`, `\pageref`, `\autoref`, `\cref{a,b}`…), hors des commentaires.
  - Le commentaire suit la règle du `scanTex` de la tâche 4 : un `%` qu'aucune barre oblique inverse n'échappe.
  - Une seconde passe part si l'un de ces labels, défini par la source, a un numéro, une page ou une ancre différents des `known`.
  - Coût si faux : une seconde passe de trop ou de moins.
- Ruling: **un document autonome n'a une seconde passe** que si son journal demande « Rerun » (« Rerun to get », « Rerun LaTeX », « Please rerun »), ou si les lignes de renvois de son `.aux` ont changé (`\newlabel`, `\bibcite`, `\@writefile`).
  - Pourquoi : le `.aux` change toujours à la première passe, car il contient au moins `\relax` et `\@abspage@last`. Le comparer en entier ferait toujours deux compilations à froid, soit une seconde de plus.
  - La seconde passe se fait dans le même dossier, sous le même nom de job : elle relit le `.aux` et la table des matières de la première. Le test d'une table des matières le vérifie (`passes: 2`).
  - Coût si faux : une expression régulière.
- Ruling: **le journal ne se coupe pas** : `max_print_line=100000`, `error_line=254` et `half_error_line=238` sont dans l'environnement de pdfLaTeX, que kpathsea lit.
  - Pourquoi : la pile des fichiers ouverts se lit alors sur les parenthèses du journal, sans ligne coupée.
  - `parseLog` saute l'extrait de texte qui suit un « Overfull » ou un « Underfull » : ses parenthèses n'ouvrent aucun fichier. Le test d'un extrait réel à parenthèse ouverte le vérifie.
  - Une erreur est du préambule si elle précède `CIRRUS-READY` et que la source n'est pas ouverte. Sa ligne n'est donnée que si le fichier lu est `preamble.tex`, ou la source pour une erreur de la source.
  - Coût si faux : nul.
- Ruling: **un préambule qui échoue est redit aussitôt**, sans nouveau processus, jusqu'à `warm()` ou un autre préambule, quand l'échec est déterministe : le processus sort avec un journal.
  - Un dépassement du délai, ou un pdfLaTeX qui ne démarre pas, n'est pas retenu : la requête suivante réessaie.
  - La tâche 7 appellera `warm(préambule)` après avoir installé un paquet.
  - Coût si faux : un champ.
- Ruling: **deux optimisations du chemin d'une compilation** (mesurées, plus haut) :
  - la réserve se complète au tour suivant de la boucle d'événements, une fois le job remis. Lancer un processus prend environ 10 ms du fil principal ;
  - le journal et le `.aux` sont lus en même temps.
- Ruling: **le cache tient un index en mémoire.**
  - Il est dressé une seule fois depuis le dossier, dans l'ordre des dates des PDF. Une lecture rafraîchit la date de son PDF, pour la session suivante.
  - Une compilation ne liste donc jamais le dossier. À 500 Mo de PDF de 100 Ko, ce serait 5 000 `stat` à chaque compilation.
  - La description est écrite directement après le PDF : une description coupée est un raté.
  - `trim` ne retire jamais le PDF qu'on vient de ranger, même seul au-dessus du plafond.
  - `get` rend aussi `passes`, que le service rend avec `cached: true`.
  - Coût si faux : le dossier modifié par un autre programme n'est vu qu'au démarrage suivant.
- Ruling: **un nom déjà présent dans le dossier de liens est effacé avant d'être relié ou copié.**
  - Pourquoi : copier sur un lien physique écrirait dans le fichier du magasin.
  - Les noms passent par `plainName` (`files.ts`, exporté). La règle est plus stricte que celle de la tâche : elle refuse aussi `<>"|?*`, un point ou une espace final, et les noms de périphériques.
  - Coût si faux : nul.
- Ruling: **les IPC.**
  - `cirrus:latex:compile` passe par `invoke`. Une requête refusée reçoit la réponse fixée (`INVALID_REQUEST`), et sa cause va dans la console.
  - `cirrus:latex:cancel` et `cirrus:latex:warm` passent par `send`.
  - `latexStatus()` lit `cirrus:latex:status:get`, et `cirrus:latex:status` pousse les changements.
  - `LatexStatus` et `InstallProgress` vivent dans `@cirrus/core`. Le `Progress` de `tinytex.ts` en est un alias.
  - Le service a une méthode de plus, `state()`.
  - Coût si faux : des noms de canaux.
- Ruling: **la fermeture attend `dispose()`.**
  - `window-all-closed` l'attend avant de rendre le verrou de la base : l'instance suivante vide les dossiers du service, que des processus en train de sortir tiendraient encore.
  - `will-quit` l'attend pour tout autre arrêt.
  - Les sorties des captures et du banc passent par `exitAfterLatex`, car `app.exit` saute `will-quit`.
  - Coût si faux : nul.
- Ruling: **les réglages que LaTeX lit sont gardés en mémoire** dans le principal (`currentParams`), et relus du fichier après `cirrus:settings:set`.
  - Pourquoi : une compilation les lit plusieurs fois, et chaque lecture relit `settings.json`.
  - Coût si faux : nul.
- Ruling: **les pas des réglages**, que la tâche ne fixe pas (sauf la largeur) :

  | Réglage | Pas |
  | --- | --- |
  | `latexWarmProcesses` | 1 |
  | `latexTimeoutMs` | 100 |
  | `latexSnippetWidthCm` | 0,5 (la tâche) |
  | `latexCacheMb` | 10 |
  | `latexLogMaxKb` | 16 |

  Les libellés prennent l'apostrophe typographique (décision du plan 4a). La durée du message de délai s'écrit à la française : « 2 s », « 1,5 s ». Coût si faux : des pas.
- Ruling: **deux messages que la tâche ne donne pas.**
  - Une compilation en mode `page` qui ne produit aucune page reçoit « La compilation n'a produit aucune page. ».
  - En mode `snippet`, la page fait au moins 1 pt de haut, pour une source vide.
  - Coût si faux : un message.
- Ruling: **deux tests adaptés à la TinyTeX du banc.**
  - **babel français** : `babel-french` (`french.ldf`) n'y est pas. `\usepackage[french]{babel}` échoue (« Unknown option 'french' »). Avec `provide=*`, le français se charge depuis la locale de babel, mais `:` n'est pas actif (catcode 12, mesuré).
    - Le test prend donc `\usepackage[french,provide=*]{babel}` et rend `:` actif par le mécanisme de babel, `\useshorthands*{:}\defineshorthand{:}{\thinspace\string:}`, comme le fait `french.ldf` (catcode 13, mesuré). Le risque testé, un `:` actif dans `\ref{eq:x}` et dans une clé de citation, est le même.
  - **`letterpaper`** : le document autonome charge `geometry`. Le noyau seul ne donne pas la taille du papier à pdfTeX, qui garde l'A4 du `pdftexconfig` de TinyTeX (mesuré : 595,3 pt).
  - Coût si faux : deux préambules de test.
- Ruling: **TeX ne lit qu'en vertu de la décision provisoire** (plus haut).
  - Les tests d'écriture visent `../../links/p<k>/…` à la k-ième compilation d'un service, qui tourne dans `p<k>` : chaque tentative vise donc le dossier de liens de son propre processus.
  - Le refus ne dépend pas du dossier visé, puisque `..` est refusé à l'écriture.

### Notes

- Le `titleToTex` de la tâche 1 parcourt désormais `text.normalize('NFC')` (relecture de la tâche 1, mineur 1). Un « e » suivi de l'accent combinant donnait « e? », et donne « é » ; un test le vérifie.
- `blobRequest` et `latexRequest` partagent la lecture de l'adresse (`parseUrl`) et la réponse avec ses plages (`served`). `fileResponse` choisit l'hôte du protocole.
- Les extraits de journal des tests sont réels : `tests/latex-logs/*.log`, sortis de TinyTeX v2026.11 sous le pilote. Le chemin de TinyTeX y est raccourci. Une ligne n'en est retirée que si ses propres parenthèses ferment ce qu'elles ouvrent, si bien que la pile des fichiers reste la vraie.

### Revue, tour 1

- **Important corrigé : un pdfLaTeX dédié restait vivant.** Ce processus était parti pour une requête mise en attente avant un changement de préambule. Il restait vivant quand la réserve revenait au préambule de cette requête, et que la requête prenait un processus de la réserve (P1, P2 puis P1). Pire, son échec ultérieur au chargement réglait la requête : sa compilation en cours était tuée, avec « Compilation trop longue » et `where: 'preamble'`.
  - Correctif (`compiler.ts`) :
    - une requête prend son processus dédié dès qu'il est prêt, quel que soit devenu le préambule de la réserve ;
    - quand elle reçoit un autre processus, ou quand elle est réglée, son processus dédié est arrêté et détaché ;
    - un processus dédié qui échoue alors que la réserve a retrouvé le préambule de sa requête laisse la requête à la réserve. Celle-ci la sert, ou la fait échouer avec la même erreur.
  - Deux tests :
    - « préambules alternés P1, P2, P1 » : chaque requête a sa réponse, il ne reste que la réserve, puis rien après `dispose()` ;
    - « un pdfLaTeX dédié dépassé… » : le préambule P1 attend un fichier `gate.tex` que le test ne donne qu'à la réserve.

    Avant le correctif, ils échouaient sur 3 processus vivants pour 2 attendus, et sur « Compilation trop longue (plus de 2 s) : arrêtée. ».

## Tâche 4 : interface — registre des labels et des citations, requêtes, compilation à la pause

## Tâche 5 : interface — éditeur LaTeX, plein écran d'un `.tex`, enregistrement

## Tâche 6 : interface — résumé et relation compilés, liens `cirrus:`

## Tâche 7 : préambule, installation de LaTeX, paquets manquants

## Tâche 8 : mesures, captures, spec

## Mesures du plan 4b

| Mesure | Tâche | Valeur | Conditions |
| --- | --- | --- | --- |
| Téléchargement de TinyTeX v2026.11 (TinyTeX-1, Windows) | 2 | 73,7 Mo ; 17,9 s puis 18,8 s | `fetch` de Node, réseau de la machine de développement |
| Installation complète par `provision` | 2 | 75,7 s puis 73,0 s ; 313,5 Mo installés | téléchargement, extraction (34 à 37 s), `tlmgr update --self`, 9 paquets, renommage, depuis `tlnet.yihui.org` |
| Installation complète par `provision`, après la revue | 2 | 86,7 s ; 313,5 Mo installés | dépôt de CTAN (`option repository ctan`), `update --self`, 8 paquets de base, renommage |
| `Packages.ensure` de 3 noms, dont un inconnu | 2 | 17,2 s | un lot `tlmgr install`, puis la liste relue ; miroirs de CTAN |
| `installFor` d'un paquet absent (`siunitx`) | 2 | 10,4 s puis 9,2 s | `search --global`, puis `install`, depuis `tlnet.yihui.org` |
| `Packages.installed()` (`tlmgr info --list --only-installed`) | 2 | 1,6 s | TinyTeX du banc, sans réseau |
| Compilation préchauffée de `complexité.tex` (de la requête à la réponse) | 3 | p50 138 ms sur 20 (min 130, max 144) ; 156 ms avant les optimisations | `DEFAULT_PREAMBLE`, mode `page`, image, 3 références, 1 citation, 1 label cassé, une passe ; TinyTeX du banc |
| pdfLaTeX seul, préchauffé (du nom du job à la sortie) | 3 | 113 ms pour `complexité.tex` ; 89 ms pour `Bonjour $x^2$.` | p50 sur 9, hors du service |

## Mineurs reportés

Chaque ligne `minor (deferred)` du suivi du plan, dans l'ordre des tâches, avec ses fichiers et ses lignes.

### Tâche 1

- Pour la tâche 3 (Review Focus 1 : « l'aperçu montre le texte tel qu'il est écrit ») : `titleToTex` garde tels quels les caractères de la plage. Deux cas affichent pourtant autre chose que le texte tapé :
  - sous T1, les ligatures de TeX changent un titre : `--` et `---` deviennent des tirets ; deux apostrophes, ou deux accents graves, des guillemets ; `<<` et `>>` des chevrons ; `,,` un guillemet bas ; un point d'exclamation ou d'interrogation suivi d'un accent grave, un signe renversé ;
  - sous un préambule sans T1 (OT1), `<`, `>` et `|` deviennent d'autres glyphes.

  Rien n'est exécuté, et la compilation ne casse pas. Briser les ligatures (`-{}`, `'{}`, `<{}`) changerait la sortie que la tâche 1 fixe (latex.ts, `titleToTex`).

### Tâche 2

- Pour la tâche 7 : `runFile` n'a pas de délai maximal. Un `tlmgr` suspendu au réseau bloquerait la file de `Packages`, et tous les appels suivants. Un délai serait un réglage avancé du groupe « LaTeX » (`packages/app/src/main/latex/tinytex.ts`, `runFile`).
- Pour la tâche 7 : `BASE_PACKAGES` est dans le principal (décision P1). Si `withPackage` vit dans l'interface, elle ne pourra pas importer `tinytex.ts`, qui tire `node:child_process`. La liste irait alors dans `@cirrus/core` (`latex.ts`).
- Une installation dans un chemin accentué (un nom d'utilisateur Windows accentué, dans `LOCALAPPDATA`) n'a pas été essayée. Un chemin avec une espace l'a été. `tlmgr.bat` et le Perl de TeX Live sont connus pour mal vivre les chemins non ASCII (`tinytex.ts`, `provision`).
- `texEnv` laisse les autres variables d'arbres de kpathsea (`TEXMF`, `TEXMFAUXTREES`, `TEXMFLOCAL`…). Elles ne viennent que de l'environnement de l'utilisateur, mais pourraient ajouter des arbres que TeX lirait. La tâche en nomme quatre (`tinytex.ts`, `TEX_PATHS`).

### Tâche 3

- Pour la tâche 6 : `\nameref` vers le label d'un autre nœud n'affiche rien, car le troisième champ est vide. Y mettre le titre lié demanderait de vérifier ce que nameref en fait (`driver.ts`, `jobBody`).
- Sous le vrai `babel-french`, absent de la TinyTeX du banc, `: ; ! ?` prennent l'espace fine française dans un titre ou un nom de label injecté (« absent :label ? »). C'est la typographie de babel ; rien n'est interprété (`driver.ts`, `jobBody`).
- Un document autonome qui ne charge ni `geometry` ni hyperref garde l'A4 de pdfTeX, quel que soit son papier. C'est le comportement de pdfLaTeX lui-même (`compiler.ts`, `runStandalone`).
- `citedLabels` ne voit pas `\hyperref[label]{texte}`, dont le label est entre crochets (`driver.ts`).
- Le délai vaut par passe : une compilation en deux passes peut durer deux fois `latexTimeoutMs` (`compiler.ts`, `finish`).
- Au-delà de `latexWarmProcesses` requêtes simultanées, les suivantes attendent qu'un processus se prépare à froid, environ 600 ms (`compiler.ts`, `fill`).
- pdfLaTeX seul prend 89 ms pour une ligne sur cette machine, contre 35 à 84 ms au banc pour ses fragments. La différence n'a pas été cherchée : le préambule et les fragments diffèrent, et la mesure de la tâche 8 tranchera (`compiler.ts`).
- Les dossiers des processus tués par `dispose()` restent jusqu'au démarrage suivant, qui les vide (`compiler.ts`, `dispose`).

## Décisions du contrôleur (plan 4b)

Chaque décision du contrôleur (`Ruling:`) du suivi de l'exécution, qui disparaîtra avec l'espace de travail, dans son ordre : décision — raison — coût si faux. Quand une décision est détaillée plus haut, sous sa tâche, la ligne le dit.

### Avant la tâche 1 (examen des tâches)

- Ruling P1: T2 exports the base package list as `BASE_PACKAGES` (the list provision installs); T7's withPackage reads it — cost if wrong: a rename.
- Ruling P2: T6 drops the « Titre court » relabel of the connection title (never asked, would change the frozen reference-3c capture fenetre-connexion) — cost if wrong: one label.
- Ruling P3: T6 keeps the relation's empty-field look as today (placeholder « Relation (LaTeX) », same box) so reference-3c fenetre-connexion stays within tolerance — cost if wrong: one placeholder text.

### Tâche 2, revue (correctifs, tour 1)

- Ruling R2.1 : **une installation qui échoue dit sa cause, et non la ligne de clôture de `tlmgr`.**
  - Le constat : `tlmgr` finit toujours un échec par « …: An error has occurred. See above messages. Exiting. » (`tlmgr.pl`, l. 750). La cause, par exemple « package x not present in repository. » (l. 4033), vient avant.
  - La règle : le message garde la dernière ligne qui nomme une cause. Il saute la ligne de clôture, « action … returned an error », « please see warning above », la ligne du dépôt et les cadres de `=`.
  - Les tests : les faux `tlmgr` écrivent la vraie ligne de clôture après la cause. L'ancien code échouait à ces tests.
  - Coût si faux : une expression régulière.
- Ruling R2.2 : **un mot inconnu dans `latexPackages` ne rend jamais LaTeX impossible à installer.**
  - `provision(root, deps, onProgress, release?)` n'installe que `BASE_PACKAGES`, et un échec à cette étape fait toujours échouer l'installation.
  - Les paquets de l'utilisateur passent par `Packages.ensure(names)`, au mieux. Il rend `{ installed, failed: { name, reason }[] }` et ne lève jamais parce que `tlmgr` ne connaît pas un nom.
  - Le mécanisme : un seul appel `tlmgr install` pour le lot, puis la liste relue. `tlmgr` installe ce qu'il connaît et nomme le reste (`$F_WARNING`, puis `next`, l. 4033). La raison d'un nom est la dernière ligne de `tlmgr` qui le cite, sinon la cause de l'échec (hors ligne : chaque nom porte la même). `ensure` ne lève que si la liste locale est illisible.
  - La tâche 7 appelle `ensure(latexPackages)` après `provision`, puis à chaque démarrage.
  - Vérifié sur une installation neuve : `ensure(['tikz-cd', 'paquet-faute-xyz', '-a', 'siunitx'])` installe `tikz-cd` et `siunitx` en 17,2 s. `paquet-faute-xyz` échoue avec « tlmgr.pl install: package paquet-faute-xyz not present in repository. », et `-a` avec « nom de paquet invalide ».
  - Coût si faux : un paramètre et une forme de retour.
- Ruling R2.3 : **un mot qui commence par `-` atteindrait `tlmgr` comme une option** (`--repository=…`, `--reinstall`). Or `latexPackages` sera synchronisé depuis le serveur (plan 5).
  - Un mot doit donc vérifier `^[A-Za-z0-9][A-Za-z0-9._-]*$`, à deux endroits :
    - dans la validation du réglage (`WORD`, `params.ts`) ;
    - dans `Packages`, avant tout appel à `tlmgr` (`PACKAGE_NAME`). Un nom refusé va dans `failed`, avec « nom de paquet invalide ». Un paquet que rendrait `search` sous cette forme n'est pas installé : `installFor` rend null.
  - Les deux expressions sont les mêmes. `tinytex.ts` garde la sienne, sans importer `@cirrus/view`, pour que la frontière de `tlmgr` ne dépende pas d'un réglage.
  - Testé avec `--repository=x`, `-a` et `.x` des deux côtés.
  - Coût si faux : nul.
- Ruling R2.4 : **les paquets viennent du dépôt de TeX Live** (D1 et la contrainte « Réseau »), et non de `tlnet.yihui.org`, le miroir de TinyTeX, qui est un tiers.
  - Pendant `provision`, après l'extraction et avant `tlmgr update --self`, l'app lance `tlmgr option repository ctan`. Le dépôt devient `https://mirror.ctan.org/systems/texlive/tlnet`, que le réseau de miroirs de CTAN redirige à chaque appel (vu : ircam.fr, tetaneutral.net, ibcp.fr, dauphine.fr).
  - Cette décision remplace la décision « le dépôt de TinyTeX est gardé » de la tâche 2.
  - Coût si faux : un appel.
  - **Constat sur la vérification des signatures** : sur une installation neuve, `tlmgr` dit « (verified) » sous Git Bash, et « (not verified: gpg unavailable) » avec le PATH de Windows. Ce second cas est celui de l'app lancée normalement.
    - Pourquoi : `tlmgr` cherche `TL_GNUPG`, puis `gpg` et `gpg2` dans le PATH, puis `tlpkg/installer/gpg/gpg.exe` (`TLCrypto.pm`, `setup_gpg`). TinyTeX ne livre pas ce dernier.
    - Les « (verified) » des passes manuelles venaient du gpg de Git pour Windows (`/usr/bin/gpg`), présent dans le PATH de Git Bash.
    - Le PATH de Windows de cette machine ne contient que `C:\Program Files\Git\cmd`, sans gpg. Mesuré sur la même installation, par `tlmgr update --list`, avec les deux PATH.
    - Sans gpg, `tlmgr` télécharge tout de même par HTTPS et contrôle chaque archive par l'empreinte SHA-512 de la base `texlive.tlpdb`. Seule l'authenticité de cette base, signée par TeX Live, n'est pas vérifiée.
    - Le dépôt ne contient pas de paquet `tlgpg` (`tlmgr info tlgpg` ne trouve rien).
    - Rien n'a été changé pour cela. C'est une décision à prendre : fixer `TL_GNUPG` vers un gpg, en livrer un, ou accepter HTTPS et les empreintes.

### Tâche 3, blocage de D4

- Ruling R3.1 (provisoire, soumis à l'utilisateur) : **D4 devient « TeX n'écrit que dans son dossier et n'exécute rien ; il peut lire tout fichier que le compte Windows peut lire »**, avec ses conséquences :
  - un `TEXINPUTS` relatif ;
  - `TEXMF_OUTPUT_DIRECTORY` retiré, et `openin_any` plus posé, par `texEnv` ;
  - des tests d'écriture à la place des tests de lecture.

  Le texte de la décision et le constat qui l'a amenée sont sous la tâche 3, plus haut.
