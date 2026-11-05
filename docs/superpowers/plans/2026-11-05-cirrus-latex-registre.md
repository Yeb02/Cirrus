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

### Mesures

- **Construction du registre sur la base du banc** (50 000 nœuds, 549 189 connexions, sans `.tex`), sous vitest, douze constructions, une sur deux avec `previous` :
  - avec les accesseurs de rangée (`connKind`, `connTrashed`, `connRelation`) appelés pour chaque connexion : de 104 à 160 ms. La boucle des connexions en prend à elle seule de 93 à 141 ms, celle des nœuds de 1 à 9 ms ;
  - avec `relationRows` (décision plus bas) : de 4 à 14 ms.
- **Suite** : 681 tests sur 681 (647 avant la tâche), 34 de plus :

  | Fichier | Tests ajoutés |
  | --- | --- |
  | `latexScan.test.ts` | 8 |
  | `latexRegistry.test.ts` | 13, dont 3 pour `loadTexTexts` |
  | `latexRequest.test.ts` | 3 |
  | `compileScheduler.test.ts` | 8 |
  | `params.test.ts` (view) | 1 |
  | `columns.test.ts` (core) | 1 |

  `tsc` : `app`, `view` et `core` sans erreur.
- **App construite** (`electron-vite build`), une capture sous `CIRRUS_TINYTEX` (TinyTeX du banc) : `latexWarm` a préparé les deux pdfLaTeX (`latex/work/p1` et `p2` dans la base de la capture), aucun `pdflatex.exe` ne reste après la sortie, et `%LOCALAPPDATA%\Cirrus` n'a pas été créé.
- **Captures**, une suite neuve : 11 sur 11 à 0 pixel contre `reference-3c`, 8 sur 8 à 0 pixel contre `plan4a`.

### Décisions

Fixées par le contrôleur avant la tâche :
- un label défini deux fois dans la même source compte pour deux définitions ;
- une ref vers un label que la source définit elle-même n'est pas injectée, même s'il est défini ailleurs aussi : le numéro de la source l'emporte, et le doublon est le diagnostic de l'éditeur (tâche 5) ;
- `doubled` porte la première définition dans l'ordre des identifiants, puis dans celui des origines ; le `title` d'une définition d'origine `title` est le titre du nœud ;
- `citeKeys()[].text` est la `shortCitation` du nœud ;
- les tags, le résumé et les fichiers d'un nœud à la corbeille ne définissent rien, ni la relation d'une connexion à la corbeille ;
- les minuteries du planificateur sont injectées sous la forme `{ set(fn, ms): unknown; clear(h): void }`, et le hook prend `window.setTimeout` ;
- deux requêtes se comparent par un JSON stable, sans `known`.

- Ruling: **la règle du document autonome vit dans `@cirrus/core`** : `withoutComments` et `isStandalone` passent de `driver.ts` à `latex.ts`, sans changement, et `scanTex(...).standalone` appelle `isStandalone`.
  - Options : recopier la règle dans l'interface et tester les mêmes cas ; la partager (choix).
  - Pourquoi : ce sont deux fonctions de chaînes, sans rien du principal. Une seule règle sert les deux processus, qui ne peuvent donc pas diverger. `cache.ts`, `compiler.ts` et `latexLog.test.ts` les importent désormais de `@cirrus/core`, et les cas de `latexLog.test.ts` sont refaits par `scanTex` dans `latexScan.test.ts`.
  - Coût si faux : trois imports.
- Ruling: **`relationRows(s)` et `connRelation(s, row)` s'ajoutent aux accesseurs du cœur** (`state.ts`).
  - `relationRows` rend les rangées des connexions dont la relation n'est pas vide, corbeille comprise, en lisant les colonnes en local.
  - Pourquoi : appeler les accesseurs pour chacune des 549 189 rangées coûtait de 93 à 141 ms par construction (mesure plus haut), et le registre se reconstruit après chaque action. Bâtir chaque enregistrement par `s.connections` coûterait plus encore.
  - Coût si faux : deux fonctions exportées.
- Ruling: **`scanTex` ne découpe par virgules que les refs de cleveref** (`\cref`, `\Cref`), et les citations ; chaque nom d'une liste perd ses espaces de bord. Un nom seul est pris tel qu'il est écrit, comme LaTeX le lit : `\ref{ a }` cherche « a » entouré d'espaces.
  - Le `citedLabels` du principal découpe toute commande en « ref ». Il ne décide que d'une seconde passe : la différence ne change aucune compilation.
  - Coût si faux : un ensemble de noms.
- Ruling: **ce qui n'est pas une marque** : un nom vide ou fait d'espaces, un nom qui porte `#` (le paramètre d'une macro, `\newcommand\r[1]{\ref{#1}}`), la clé `*` (`\nocite{*}`), un argument jamais fermé. Un commentaire dans un argument en est retiré, comme le fait TeX (revue, tour 1, plus bas).
  - Pourquoi : l'éditeur (tâche 5) marquerait en rouge `\ref{#1}` dans une définition, et `*` comme une clé inconnue. `safeLabel` refuserait de toute façon `#` à l'injection.
  - Coût si faux : une condition.
- Ruling: **`scanTex` saute aussi `verbatim*` et `Verbatim*`**, et cherche la fin `\end{<nom>}` telle quelle, comme le fait LaTeX. Un environnement jamais fermé va jusqu'au bout du texte. TeX saute les espaces et les sauts de ligne entre la commande, son étoile, ses arguments optionnels et son accolade : `scanTex` aussi. Les refs ne lisent pas d'argument optionnel, puisque aucune de la liste n'en prend. Coût si faux : nul.
- Ruling: **l'ordre des définitions** : par identifiant (celui du nœud, ou de la connexion pour une relation), puis le titre, le résumé, les fichiers dans l'ordre du nœud, puis la position dans la source.
  - `labels()` rend toutes les définitions par label, dans l'ordre des unités de code, puis dans cet ordre-là.
  - `citeKeys()` les rend par clé, puis par nœud.
  - Coût si faux : un comparateur.
- Ruling: **un titre vide se montre « Sans titre »**, le mot du pop-up de connexion. Cela vaut pour la définition d'un nœud ou d'une connexion sans titre, et pour la citation d'une publication sans auteur ni titre.
  - Pourquoi : un `\ref` vers la relation d'une connexion sans titre n'afficherait rien dans l'aperçu. Le lien serait alors invisible, alors que Review Focus 5 le veut visible.
  - Coût si faux : une expression.
- Ruling: **les tags `label` et `clé_bibtex` sont lus sans leurs espaces de bord** : `\cite` et les listes perdent aussi les leurs. Une valeur vide ne définit rien. Chaque tag `label` compte : deux tags égaux sur un même nœud, que le registre de tags refuse d'ordinaire (`multi: false`), font un doublon. Coût si faux : un `trim`.
- Ruling: **`LatexRegistry.build` prend un quatrième paramètre facultatif, `analyse`** (`scanTex` par défaut). C'est le compteur que la tâche demande d'injecter dans l'analyse.
  - `scanOf(origin, text)` rend l'analyse du registre si `text` est le texte qu'il a lu pour cette source, et une analyse neuve sinon. `buildRequest` s'en sert : ouvrir un pop-up dont le résumé n'a pas changé ne relit pas sa source.
  - Coût si faux : un paramètre et une méthode.
- Ruling: **`shortCitation` prend pour année la première suite de quatre chiffres** de `date_de_publication` (`/\d{4}/`) : « 05/2008 » donne 2008, là où les quatre premiers chiffres épars donneraient « 0520 ». Sans auteur, le titre est suivi de l'année s'il y en a une (« Un livre, 2008 »). Coût si faux : une expression régulière.
- Ruling: **les définitions de la source elle-même ne comptent pas dans `buildRequest`**. Le registre les tient de la version de la source qui est dans l'état, et non du texte tapé : un `\label` effacé à l'instant ne cache pas un label désormais cassé.
  - Le tag `label` du même nœud compte, lui : `\ref{mdl}` dans le résumé de MDL désigne le nœud lui-même (D7).
  - Chaque label et chaque clé n'apparaît qu'une fois, dans l'ordre de leur première citation, si bien que la clé du cache reste stable.
  - Le texte d'une citation vient de l'enregistrement actuel du nœud. Une clé dont le nœud a disparu depuis la construction du registre passe dans `unknownCites`.
  - Coût si faux : un filtre.
- Ruling: **le planificateur, pour une autre source** : une requête d'un autre emplacement part aussitôt, et vide la vue. Le PDF d'une autre source ne doit pas passer pour « le dernier bon ».
  - `request(null)` abandonne la pause et annule la compilation en cours. `pending` devient faux, et la vue est gardée. La même requête, redonnée ensuite, part aussitôt : le cache du principal y répond.
  - Coût si faux : une branche.
- Ruling: **une réponse `cancelled` à la requête courante** remet `pending` à faux, sans rien montrer d'autre. Seul le principal l'annule de lui-même, à la fermeture, ou quand une autre vue demande le même emplacement. Les réponses `cancelled` des requêtes que le planificateur a lui-même annulées sont ignorées par leur numéro.
  - Pourquoi : sinon, la vue resterait « en cours » sans fin.
  - Coût si faux : une branche.
- Ruling: **le planificateur et les états sans compilation** :
  - `unavailable` garde le PDF, l'erreur et le journal, et une réponse `ok` ou `error` l'efface ;
  - un pont qui échoue (l'IPC) devient une erreur de la source, « La compilation n'a pas pu être demandée : … », et le PDF reste ;
  - `subscribe` donne aussitôt la vue courante.
  - Coût si faux : nul.
- Ruling: **la table des `known`** se remplit des labels de chaque réponse `ok` ou `error`, vides compris, puisque les deux ont lu un `.aux`. À l'envoi, le `known` de la requête est remplacé par celui de la table quand elle connaît l'emplacement. `knownLabels(slot)` la lit, pour les tâches 5 et 6. Coût si faux : nul.
- Ruling: **`useCompiled(req, pauseMs = DEFAULT_PARAMS.latexTypingPauseMs)`** prend un second paramètre facultatif, la pause.
  - Pourquoi : chaque pop-up et le plein écran reçoivent `params` en prop. Une valeur de module que l'app réglerait serait un couplage caché.
  - Le pont du hook compte chaque compilation parmi ce que les vues chargent (`loading`), pour que la capture attende. Le planificateur est créé dans un effet, ce qui le rend sûr sous le StrictMode de React.
  - Coût si faux : un paramètre.
- Ruling: **`loadTexTexts`, les cas difficiles** :
  - un `.tex` plus long que le plafond n'est pas lu du tout, puisque sa taille le dit : `readHead` le rendrait tronqué, et il serait écarté ;
  - un blob illisible compte comme vide pour la session, et la console le dit. Il n'est pas relu à chaque action ;
  - les textes des fichiers partis sont lâchés, et un signal levé fait rejeter le chargement ;
  - l'app relit tous les textes quand le plafond change : un `.tex` laissé vide parce que trop long peut y tenir désormais.
  - Coût si faux : nul.
- Ruling: **l'app reconstruit le registre au plus une fois par `latexTypingPauseMs`** : tout de suite après un moment calme, et sinon à la fin de la pause qui suit la dernière construction, avec l'état tel qu'il est alors. Les textes se relisent après chaque action : c'est une boucle sur les nœuds, qui ne lit que les `.tex` nouveaux. Coût si faux : nul.
- Ruling: **`latexWarm` n'est pas appelé pour le banc**, qui mesure le graphe. Les captures le gardent : la tâche 8 y compilera. Coût si faux : une condition.
- Ruling: **le pas de `latexTypingPauseMs` est de 10 ms.** La tâche n'en fixe pas. Coût si faux : un nombre.

### Notes

- `scanTex` fait une passe sur le texte, plus celle de `isStandalone`. Les lignes se comptent au fil des marques.
- Le registre n'est encore lu par aucune vue : `App` le tient dans son état, pour les pop-ups et le plein écran des tâches 5 et 6.

### Revue, tour 1

- **Important corrigé : un commentaire dans un argument faisait perdre l'argument entier.** `\cite{li2008,%⏎ solomonoff1964}` ou `\cite{%⏎ a,%⏎ b}` ne donnaient aucune marque. Les clés n'allaient alors ni dans `cites` ni dans `unknownCites`, et l'aperçu montrait un « [?] » sans lien ni rouge.
  - Le correctif est dans `scan.ts`. La recherche de l'accolade fermante saute un commentaire jusqu'au bout de sa ligne, au lieu d'échouer.
  - Le contenu d'un argument est lu comme TeX le lit : un commentaire en est retiré, avec la fin de sa ligne et les espaces du début de la suivante. Une liste se découpe et perd ses espaces sur ce contenu. Les positions restent celles du texte : une marque va de son premier caractère à son dernier, et `\ref{kc%⏎:def}` donne `kc:def`.
  - Un commentaire entre la commande et son accolade est sauté aussi (`\cite%⏎{k}`).
  - Un test le vérifie : un `\cite` sur deux lignes avec commentaires, la forme `\cite{%⏎ a,%⏎ b}`, un `\cref` sur deux lignes, `\label{a%⏎}`, un argument optionnel, une virgule dans un commentaire. Il échouait avant le correctif, avec « expected [] to deeply equal [ …(2) ] ».
- **Important corrigé : une clé portée par plusieurs nœuds est rouge dans l'aperçu** (décision du contrôleur, plus bas, « Tâche 4, revue »).
  - `CompileRequest` reçoit `doubledCites: InjectedCite[]`.
  - `buildRequest` y met une clé que tiennent plusieurs nœuds vivants, avec la citation du premier par identifiant. Les nœuds du registre sont relus dans l'état : un nœud parti à la corbeille depuis la construction ne compte plus.
  - `jobBody` l'affiche comme un label en double : la citation courte en rouge, liée au nœud du premier.
  - `DRIVER_VERSION` passe à 2. La clé du cache compte le champ, et `invalidRequest` le vérifie.
  - Tests : `buildRequest` (deux nœuds, puis l'un à la corbeille), `jobBody` (la branche rouge, et une clé refusée omise), la clé du cache, la validation, et une compilation réelle (« [Li et Vitányi, 2008] », du rouge, le lien vers la publication). Avant le correctif, la compilation réelle donnait « Voir [?]. ».
- Ruling: **un doublon de clé est lié au premier nœud**, comme un label en double, le rouge à l'intérieur du lien, ce qui l'emporte sur `citecolor`. Coût si faux : une ligne de `jobBody`.
- Suite après les correctifs : 683 tests sur 683, deux de plus. `tsc` : `app`, `view` et `core` sans erreur.

## Tâche 5 : interface — éditeur LaTeX, plein écran d'un `.tex`, enregistrement

### Mesures

- **Suite** : 705 tests sur 705 (683 avant la tâche), 22 de plus :

  | Fichier | Tests ajoutés |
  | --- | --- |
  | `latexEditor.test.ts` | 5 (`refContext`, `completionsFor`, `diagnosticsFor`) |
  | `texSave.test.ts` | 13 : `SaveScheduler` (5), le regroupement sur une base de test (5), `texMergeKey`, `storeText`, une compilation réelle |
  | `session.test.ts` | 2 (l'option `merge`) |
  | `files.test.ts` (store) | 1 (`storeBytes`) |
  | `params.test.ts` (view) | 1 |

  `fileLogic.test.ts` vérifie en plus l'hôte `latex` de `fileUrl`. `tsc` : `app`, `store` et `view` sans erreur. Une première suite complète a vu `scale.test.ts` (store) échouer sur son chronomètre, la machine chargée : l'EPERM du nettoyage, mineur reporté de la tâche 3. Relancé seul, il passe, et la suite finale passe en entier.
- **Compilation réelle** de la requête de `complexité.tex` (`buildRequest`, emplacement `draft:`) : le PDF montre le titre de MDL ; 1,2 s, la base de test et le pdfLaTeX à froid compris.
- **App construite**, sur des copies de la base de test (`CIRRUS_DATA`), un profil à part (`--user-data-dir`) et la TinyTeX du banc (`CIRRUS_TINYTEX`), menée par le protocole des outils de Chrome (`--remote-debugging-port`) :
  - Échap pendant la pause : le texte est enregistré, puis le plein écran se ferme, en 128 ms ;
  - fermeture de la fenêtre pendant la pause, comme par son × (`WM_CLOSE`, `taskkill` sans `/F`) : le texte est au journal, et l'app sort en 655 ms ;
  - aucun pdfLaTeX ne reste, `%LOCALAPPDATA%\Cirrus` n'existe pas, et le profil comme la base de l'utilisateur n'ont pas changé.
- **Captures**, une suite neuve : 11 sur 11 à 0 pixel contre `reference-3c`, 8 sur 8 à 0 pixel contre `plan4a`. Aucune capture du plan 4a ne montre un `.tex` : rien n'est refait.

### Décisions

Fixées par le contrôleur avant la tâche :
- le brouillon d'un éditeur se compile sous son propre emplacement, `draft:<emplacement>` ; la vue enregistrée garde le sien. Au plus un `useCompiled` par emplacement, et la pause est toujours `params.latexTypingPauseMs` ;
- `diagnosticsFor` marque « Clé de citation portée par plusieurs nœuds : x » ;
- le regroupement (D6, tel que l'utilisateur l'a dit) : `run(build, { merge })` ; les enregistrements regroupés reprennent l'identifiant de la première action au journal et prolongent son pas d'annulation ; toute autre action écrite y met fin ;
- le texte de l'éditeur part du texte décodé du fichier, qui est le `saved` du planificateur, puis le texte de chaque enregistrement réussi ;
- le brouillon se compile par `buildRequest` sur le texte tapé, la première fois aussitôt ;
- l'aperçu d'un `.tex` ouvert sous le plein écran garde son emplacement et le texte enregistré ;
- le plein écran d'un `.tex` suit son fichier par son nom (R19 du plan 4a) : un enregistrement change l'empreinte, la vue reste ;
- un enregistrement refusé à la fermeture laisse le plein écran ouvert avec son bandeau ; une seconde demande (Échap, ×) ferme après la question « Fermer sans enregistrer ? ».

- Ruling: **le store accepte plusieurs commits du même identifiant d'action** : `changes.action_id` n'a qu'un index (`changes_action`), sans contrainte d'unicité, et `historySummary` compte les identifiants distincts. Annuler le pas regroupé écrit une seule action inverse, faite de toutes les opérations regroupées, de la dernière à la première : vérifié sur une base de test (trois lignes, un identifiant ; puis trois lignes d'annulation, un identifiant). Coût si faux : nul.
- Ruling: **la mémoire du regroupement s'arrête aussi à un changement reçu** (`receive`, plan 5) : « rien n'a été écrit depuis » vaut pour ce qui vient d'ailleurs. Une commande refusée, ou une écriture qui échoue, n'écrit rien et n'y met donc pas fin. Coût si faux : une ligne.
- Ruling: **un enregistrement ne ramène jamais ce qui est parti** (`texSaveRefusal`, `actions.ts`).
  - Le constat : `filesBuild` ajouterait à la fin un fichier retiré entre-temps, ou écrirait dans un nœud à la corbeille.
  - La règle : l'action est refusée, à son calcul, si le nœud est absent ou à la corbeille (« Ce nœud n’existe plus. ») ou si le fichier n'y est plus (« « x.tex » n’est plus dans ce nœud. »). `saveTex` le vérifie aussi avant de confier le texte au principal, pour ne rien stocker en vain.
  - Un texte que le fichier a déjà (`filesBuild` nul, ou « Déjà à jour. » au calcul) compte comme enregistré, sans rien écrire.
  - Le libellé « Modifier « x.tex » » remplace celui de `filesBuild` (« Remplacer « x » »).
  - Coût si faux : une fonction.
- Ruling: **un plein écran dont le `.tex` disparaît alors que son texte n'est pas enregistré reste ouvert**, sur sa dernière cible (`App`, `lastFull`). L'enregistrement suivant est alors refusé et le dit, et la fermeture pose la question. Sans texte en attente, il se ferme comme avant (Review Focus 5).
  - Pourquoi : Review Focus 4 veut que le texte reste dans l'éditeur. Sous le plein écran, qui est modal, rien dans l'app ne peut supprimer le nœud : seul `receive` (plan 5) le pourra.
  - Coût si faux : une référence dans `App`.
- Ruling: **`TexWorkbench` reçoit aussi `views` et une `ref`** (`WorkbenchHandle` : `dirty`, `flush`, `requestClose`).
  - Pourquoi : `PdfViewer` garde sa place dans `views`. `App` attend `flush` avant l'instantané à la fermeture de la fenêtre, et `FullScreen` passe Échap et × par `requestClose`.
  - Le plein écran d'un `.tex` reçoit `tex: { state, registry, onSave, workbench }`, et l'atelier vit dans son propre morceau, chargé à la demande comme les vues.
  - Coût si faux : deux props.
- Ruling: **les fins de ligne sont celles de l'éditeur** : le texte lu est normalisé en « \n », comme CodeMirror le lit, et c'est ce texte qui sert de `saved`. Un fichier en CRLF passe donc en LF à son premier vrai enregistrement, et l'ouvrir sans rien taper n'enregistre rien. Coût si faux : les fins de ligne d'un fichier changent, ce que TeX ignore.
- Ruling: **le mode `live` de `PdfViewer` est `live: { keptAs }`** : la place du PDF compilé est gardée sous la clé de sa source (`latex:<emplacement enregistré>`), et non sous une empreinte qui change à chaque compilation. L'aperçu et l'atelier la partagent : ils ne se montrent jamais ensemble. Dans l'atelier, le lecteur est en mode `preview` et ne prend pas le focus, qui reste à l'éditeur. Coût si faux : une clé.
- Ruling: **le remplacement sur place** (mode `live`) :
  - le nouveau document prend la place de l'ancien une fois sa première page lue ;
  - le défilement reste tel quel, et le navigateur le borne à la nouvelle hauteur ; le zoom ou l'ajustement restent aussi ;
  - chaque page garde son dessin jusqu'à ce que celui de la nouvelle page le remplace ; son canevas n'est libéré que si la page quitte la zone dessinée ;
  - l'ancien document est lâché au tour suivant ;
  - un PDF compilé illisible alors qu'un autre est affiché laisse celui-ci, la cause dans la console.

  Coût si faux : nul.
- Ruling: **Échap ne ferme les suggestions que si elles sont affichées**. Le `completionKeymap` de CodeMirror prend Échap pendant toute requête en cours, c'est-à-dire 100 ms après chaque touche. Le plein écran manquait alors l'Échap tapé juste après une frappe : c'est l'app construite qui l'a montré. `LatexEditor` reprend ce keymap, avec son propre Échap (`completionStatus === 'active'`). Coût si faux : une liaison.
- Ruling: **Tab, dans le plein écran, compte l'éditeur** : `[contenteditable="true"]` rejoint la liste des éléments focalisables du piège. Sinon, Tab depuis l'éditeur partait vers le premier bouton, et le cycle ne revenait plus à l'éditeur. Tab n'est pas lié dans l'éditeur, pour l'accessibilité. Coût si faux : un sélecteur.
- Ruling: **l'éditeur coupe les longues lignes, compact ou non** (`EditorView.lineWrapping`) : un `.tex` est de la prose. Il a son propre historique : Ctrl+Z et Ctrl+Y y agissent sur le texte, et le Ctrl+Z de l'app ne part pas d'un champ modifiable. Coût si faux : une extension.
- Ruling: **les suggestions** :
  - un préfixe se compare par « commence par », sans accents (NFD, marques retirées) ni casse ;
  - l'ordre est le français (`Intl.Collator('fr')`), ce qui règle le mineur reporté de la tâche 4 sur `labels()` ;
  - chaque label ou clé n'apparaît qu'une fois : le titre de la première définition, la citation du premier nœud par identifiant ;
  - CodeMirror ne filtre ni ne trie (`filter: false`), et n'en dessine que 100 (`maxRenderedOptions`, sa valeur) ;
  - `refContext` ne lit que la ligne du curseur : une ref coupée par un commentaire n'a pas de suggestion.

  Coût si faux : un comparateur.
- Ruling: **`diagnosticsFor`, les cas que la tâche ne fixe pas** :
  - une clé en double vient de `req.doubledCites`, soit `citeNodes(key)` parmi les nœuds vivants, celle de l'aperçu ;
  - un label défini ici deux fois et ailleurs aussi dit « Ce label existe déjà dans « titre » » ;
  - une erreur du préambule, ou sans ligne, n'est pas un diagnostic de l'éditeur : le bandeau la dit ;
  - tous sont des erreurs, en rouge ;
  - `lineStart` rend la longueur + 1 après la dernière ligne, si bien que l'erreur de la dernière ligne la couvre jusqu'au bout ;
  - l'éditeur n'applique les diagnostics que s'ils sont ceux de son texte, pour ne pas en montrer à des positions périmées.

  Coût si faux : nul.
- Ruling: **le journal (`CompileLog`)** :
  - l'erreur cliquable est la première de TeX, celle de la réponse (la seule, sous `-halt-on-error`), quand elle est sur une ligne de la source ; le clic ferme le journal et place l'éditeur à la ligne ;
  - le journal suit tel quel, ses lignes « ! » en rouge ;
  - les avertissements « on input line N » ne sont pas des liens, car leur fichier (préambule, pilote ou source) n'est pas connu ;
  - Échap ferme le journal seul.

  Coût si faux : nul.
- Ruling: **le bandeau** :
  - côté compilation : « Compilation… », « Erreur ligne 12 : … », et le message de l'indisponibilité de LaTeX ; une erreur du préambule montre son message tel quel (« Le préambule ne compile pas : … »), une erreur sans ligne « Erreur : … » ;
  - côté enregistrement : « Non enregistré : … », « Enregistrement… » pendant un enregistrement, « Enregistré » ; rien pendant la pause.

  Coût si faux : des textes.
- Ruling: **un `.tex` plus long que `textViewMaxMb`, ou binaire** :
  - dans l'aperçu, il montre son source (`TextViewer`, qui dit pourquoi) : le principal refuse de toute façon une source de plus de `textViewMaxMb` ;
  - dans le plein écran, il s'affiche en lecture seule, avec « Plus de N Mo : ce fichier ne se modifie pas dans Cirrus. », sans aperçu ;
  - un binaire y montre la phrase du plan 4a.

  L'aperçu attend le registre avec « Compilation… », et montre une erreur au-dessus d'un PDF valide en bandeau. Coût si faux : nul.
- Ruling: **`storeText`, côté principal** :
  - il reprend `checkFileName` de l'interface, une fonction pure, avec une liste vide : seules les règles du nom comptent ;
  - il retire un U+FEFF de tête ;
  - la limite compte les octets UTF-8 ;
  - les arguments de l'IPC sont typés `unknown` et vérifiés.

  Coût si faux : nul.
- Ruling: **la première requête du brouillon porte les `known` de l'emplacement enregistré** (`knownLabels(slot)`), jusqu'à ce que le brouillon ait les siens. Le PDF compilé est adressé sous le nom du `.tex` en `.pdf`, qui ne sert qu'au type. Coût si faux : nul.
- Ruling: **l'atelier enregistre aussi quand il se démonte autrement que par `requestClose`**, par filet de sécurité : `App` le ferme quand son fichier part sans texte en attente. Il ne le fait pas après « Fermer sans enregistrer ». Coût si faux : nul.
- Ruling: **le pas de `texSaveIdleMs` est de 500 ms.** La tâche n'en fixe pas. Coût si faux : un nombre.

### Notes

- `window.close()` depuis la page ferme la fenêtre sans l'événement `close` d'Electron. L'enregistrement à la fermeture ne se vérifie donc qu'en fermant la fenêtre comme le fait l'utilisateur : son ×, ou `WM_CLOSE`.
- Le nettoyage des canevas d'une page PDF démontée lit désormais l'élément saisi à son montage : React détache les références avant les nettoyages passifs, et `box.current` y valait déjà null.
- Mineurs de la tâche 4 traités ici :
  - la clé portée par deux nœuds est marquée dans l'éditeur ;
  - une source n'a qu'un `useCompiled` : le brouillon a son emplacement, et l'aperçu est couvert pendant le plein écran ;
  - les requêtes sont mémorisées (`useMemo`) ;
  - les suggestions suivent l'ordre français ;
  - le commentaire de `TexMark` dit qu'un nom coupé par un commentaire l'inclut dans sa portée.

## Tâche 6 : interface — résumé et relation compilés, liens `cirrus:`

### Mesures

- **Suite** : 722 tests sur 722 (705 avant la tâche), 17 de plus :

  | Fichier | Tests ajoutés |
  | --- | --- |
  | `latexField.test.ts` | 8 : `nodeLinkOf`, `linkTarget`, `fieldReducer` (6) |
  | `panels.test.ts` | 2 (`withLinked`, `linkedRect`) |
  | `latexEditor.test.ts` | 2 (`lineStartOf`, `suggestionOptions`) |
  | `compileScheduler.test.ts` | 2 (`PendingHold`, `viewsSettled`) |
  | `texSave.test.ts` | 1 (la question « Fermer sans enregistrer ? ») |
  | `latexCompiler.test.ts` | 1 (la profondeur d'un strut sous la dernière ligne) |
  | `params.test.ts` (view) | 1 |

  `latexLog.test.ts` vérifie en plus le strut dans le corps d'un snippet. `tsc` : `app`, `view` et `core` sans erreur.
  - Une première suite complète a vu deux tests chronométrés échouer, la machine chargée par les captures et l'app menée à côté : `scale-perf.test.ts` (view, 21,1 ms pour un plafond de 20) et `scale.test.ts` (store). Relancés seuls, ils passent, le second trois fois sur trois ; la suite finale passe en entier.
  - L'EPERM de `scale.test.ts` masque sa vraie cause : un `expect` qui échoue saute `store.close()`, et le nettoyage bute alors sur la base ouverte. Mesuré à part : `readSnapshot` 130 ms pour un plafond de 150, le commit 0,4 ms pour 5.
- **App construite**, sur des copies de la base de test (`CIRRUS_DATA`), un profil à part et la TinyTeX du banc, menée par le protocole des outils de Chrome (`Emulation.setFocusEmulationEnabled`, voir les notes) :
  - Entropie : le résumé est compilé et dessiné de 0,73 à 1,0 s après le clic, à la première ouverture. Ce temps comprend le pdfLaTeX préparé, le morceau de pdf.js et son worker. Le source est montré jusque-là.
  - Réouverture du même pop-up : le snippet est dessiné en 23 ms, sans compilation (un seul PDF au cache), et le source n'est jamais montré (observé par un `MutationObserver`).
  - Modification : le brouillon est compilé et dessiné environ 500 ms après la frappe, pause de 300 ms comprise.
  - Échap rend la vue enregistrée, sans modification à l'historique. Le pop-up reste, et un second Échap le ferme. Entrée et F2 rouvrent l'éditeur. Quitter le champ enregistre (« 2 modifications »), et 150 ms après, la vue montre le PDF, sans le source entre les deux.
  - « Déduction jointe » : « Ensemble, K(x) ≤ LMDL(x) + O(1). » compilé, modifié avec l'aperçu dessous, puis Échap.
  - Aperçu de `complexité.tex` : cinq zones de liens vers des nœuds (le titre de MDL, coupé sur deux lignes, en donne deux) et une destination interne. Un clic sur le titre de MDL ouvre son pop-up, non épinglé, devant, à gauche de l'aperçu, faute de place à droite. Un second clic n'en ouvre pas d'autre.
  - Le même `.tex` en plein écran : le lien dit « Lien vers « Minimum Description Length Principle (MDL) » : ferme le plein écran pour l’ouvrir. », et aucun panneau ne s'ouvre.
  - LaTeX absent (`CIRRUS_TINYTEX` vers un dossier vide) : le source, puis « LaTeX n’est pas installé. ».
  - Erreur : la ligne rouge « Erreur ligne 1 : Undefined control sequence. » et « Journal », sous le dernier PDF valide, dans l'éditeur comme dans la vue enregistrée. Le journal s'ouvre sans quitter le champ, et un clic sur l'erreur place l'éditeur à sa ligne.
  - Après la sortie, aucun pdfLaTeX ne reste, et `%LOCALAPPDATA%\Cirrus` n'existe pas.
- **Captures** (19 sur 19), avant de refaire les références :
  - `reference-3c` : 10 sur 11 à 0 pixel, et `fenetre-connexion` à 1,474 % ;
  - `plan4a` : 5 sur 8 à 0 pixel (`plein-ecran-*`, `popup-vignettes`), `popup-noeud` à 4,290 %, `import-noeud` à 4,424 % et `apercu-fichier` à 4,382 %.

  Deux suites successives sont identiques au pixel près (19 sur 19). Après les nouvelles références : 11 sur 11 et 8 sur 8 à 0 pixel.

### Décisions

Fixées par le contrôleur avant la tâche :
- P2 : le titre de la connexion garde son libellé ;
- P3 : la relation vide garde l'aspect d'avant, avec le texte d'attente « Relation (LaTeX) » ;
- en modification, le brouillon se compile sous `draft:<emplacement>`, la vue sous le sien, l'un des deux seulement à la fois, avec `params.latexTypingPauseMs` ;
- trois points de la revue de la tâche 5 : les suggestions de CodeMirror deviennent des réglages ; dans « Fermer sans enregistrer ? », le focus et Entrée vont au choix qui ne perd rien ; l'aperçu de l'atelier ne se redessine pas à chaque frappe ;
- les ambiguïtés :
  - le snippet dessine toutes ses pages ;
  - « quitter le champ et son aperçu », c'est sortir de l'élément du champ (éditeur, snippet, bouton « Journal ») ; un clic sur un lien de l'aperçu ne vaut pas sortie ;
  - un lien du résumé vers son propre nœud fait passer son pop-up devant ;
  - dans un plein écran, qui est modal, un lien vers un nœud n'ouvre rien et le dit dans son bandeau.

- Ruling: **`reference-3c/fenetre-connexion` est refaite**, selon la règle de repli de P3 (« si c'est impossible, refaire cette capture avec un Ruling qui dit pourquoi »).
  - Pourquoi : la prémisse de P3 était fausse. « Analogue bayésien » a une relation depuis le plan 2 (`build.ts`, l. 133), et l'image de référence la montre (« La priore universelle de l’induction de Solomonoff… »). Compilée, elle devient une carte blanche : 1,474 % des pixels.
  - P3 vaut pour une relation vide, qui reste le champ d'avant. Le résumé vide de la publication le prouve : `popup-vignettes` est inchangée, à 0 pixel.
  - Coût si faux : une image.
- Ruling: **les captures refaites dans `plan4a`** : `popup-noeud`, `import-noeud` et `apercu-fichier`. Elles montrent le pop-up de MDL, dont le résumé est désormais compilé.
  - `plein-ecran-code` et `plein-ecran-tableau` ouvrent ce pop-up sous un plein écran qui le couvre : à 0 pixel.
  - `popup-vignettes` (la publication, sans résumé) et les autres plein écran : à 0 pixel.
  - Coût si faux : trois images.
- Ruling: **le snippet est dessiné sur une carte blanche, aux couleurs du document**. Le préambule choisit ses couleurs pour le papier (des liens `blue!50!black`), et les inverser changerait le rendu que D3 veut fidèle. Le blanc des pages vient de `.pdf-page`, comme dans le lecteur. La marge de la carte, `CARD_PAD_PX` (8 px), est une dimension de la feuille de style, comme `CELL_PAD_PX` du tableau. Coût si faux : du CSS.
- Ruling: **un champ vide est la zone de texte d'avant**, en lecture seule, avec son texte d'attente : « Résumé, en LaTeX » sur 4 lignes, « Relation (LaTeX) » sur 3 (P3). `LatexField` reçoit pour cela `rows`. Un clic, Entrée ou F2 ouvrent l'éditeur. Un texte fait seulement de blancs compte pour vide : il n'est pas compilé. Coût si faux : un paramètre.
- Ruling: **`onCommit(text)` rend `Promise<boolean>`**, et non `void` comme dans la tâche.
  - Le champ montre le texte enregistré jusqu'à ce que la valeur l'ait, ou que l'enregistrement soit refusé. La valeur est alors remise.
  - Pourquoi : sinon, après chaque modification, la vue montrerait l'ancien résumé pendant la pause de frappe. Le planificateur attend 300 ms avant une requête changée.
  - `ConnectionPopup.onEdit` rend aussi `Promise<boolean>`.
  - Coût si faux : un type.
- Ruling: **`registry: LatexRegistry | null`** : c'est le registre d'`App`, nul tant qu'il n'est pas construit. Le champ montre alors le source, « Compilation… », et l'éditeur n'offre pas de suggestions. Coût si faux : nul.
- Ruling: **aucun éclair du source entre les deux modes, ni à la réouverture** :
  - chaque mode montre le dernier PDF de l'autre jusqu'à avoir le sien : l'éditeur part de celui de la vue ; après un enregistrement, la vue part de celui du brouillon ; après Échap, de celui de la vue d'avant ;
  - une mémoire de la session garde, par emplacement, le dernier PDF montré et son texte (`shownBefore`, `LatexField.tsx`) ;
  - les tailles de pages d'un PDF sont gardées tant que son enregistrement est tenu (`sizesOf`, une `WeakMap`, `LatexSnippet.tsx`). Un pop-up rouvert dessine alors ses pages blanches à leur taille, puis leur contenu : 23 ms, mesuré plus haut.

  Coût si faux : deux petites tables.
- Ruling: **la sortie du champ** :
  - c'est un `focusout` dont la cible suivante est hors du champ ;
  - sans cible, la sortie compte, sauf si le document a perdu le focus (`document.hasFocus()`) : la fenêtre quittée laisse le champ ouvert ;
  - le champ lui-même prend le focus (`tabIndex` 0 en vue, −1 en modification), si bien qu'un clic sur une partie du champ qui n'en prend pas le garde dedans ;
  - démonté en cours de saisie, il enregistre ce qui a changé : c'est le filet de sécurité, comme pour l'atelier.

  Coût si faux : nul.
- Ruling: **les clics qui n'ouvrent pas l'éditeur** : un clic qui finit une sélection dans le texte compilé (`getSelection()` non vide), et un clic sur un lien, sur un bouton (« Journal ») ou dans le journal. Coût si faux : une condition.
- Ruling: **Échap remonte d'un cran à la fois** : il ferme le journal, puis abandonne le brouillon, puis ferme le pop-up.
  - Le journal fermé rend le focus au champ, à son éditeur en modification.
  - Un lien d'un PDF pressé laisse le focus où il était (`mousedown`, `PdfPage`).
  - Le constat, dans l'app construite : l'Échap du journal laissait le focus au document, et l'Échap suivant fermait le pop-up, ce qui enregistrait le brouillon au démontage. Un lien du brouillon est redessiné à chaque compilation, et le focus posé sur lui se perdrait de même.
  - Coût si faux : deux gestionnaires.
- Ruling: **les états du champ que la tâche ne fixe pas** :
  - une erreur sans PDF valide montre le source, la ligne rouge et « Journal » ;
  - en modification, l'aperçu sous l'éditeur ne montre jamais le source, que l'éditeur montre déjà ;
  - toujours en modification, une ligne d'état est toujours là (« Compilation… », l'erreur et « Journal », ou rien), pour que le brouillon ne bouge pas ;
  - le curseur va à la fin du texte quand l'éditeur compact s'ouvre.

  Coût si faux : nul.
- Ruling: **un lien vers un nœud ne ferme aucun panneau** (`withLinked`) : celui où l'on a cliqué est en train d'être lu, et `withNode` le fermerait s'il est non épinglé. Le pop-up se place par `placeBeside`, à droite, sinon à gauche. Vu dans l'app : il couvre alors le pop-up de Kolmogorov, à gauche de l'aperçu. Coût si faux : une règle.
- Ruling: **l'avis d'un plein écran est dans son en-tête**, pendant `toastMs`. Un nœud parti y dit « Ce nœud n’existe plus. ». La règle vaut pour tout plein écran : l'atelier d'un `.tex`, ou un PDF du magasin. Coût si faux : un état.
- Ruling: **un lien `cirrus:` se lit dans `unsafeUrl`** (`linkTarget`, `links.ts`).
  - Le constat : pdf.js ne valide que http, https, ftp, mailto et tel. L'ancien `linksOf` ne lisait que `url`, et perdait donc les liens `cirrus:`.
  - Une adresse refusée ne retombe plus sur sa destination.
  - Sans `onNodeLink`, un lien vers un nœud n'est pas un lien ; sans `onDest`, une destination non plus. Le snippet ignore ses destinations, comme la tâche le veut.
  - Coût si faux : nul.
- Ruling: **`PdfViewer` est mémorisé (`memo`)**. L'atelier et l'aperçu d'un `.tex` lui donnent un `live` et un `onNodeLink` stables (`useMemo`, et `useCallback` sur une référence) : une frappe ne le redessine plus. `PdfPage` est exporté pour `LatexSnippet`, et ses styles valent pour `:is(.viewer-pdf, .latex-snippet)`. Coût si faux : nul.
- Ruling: **la page d'un snippet descend d'au moins la profondeur d'un strut sous sa dernière ligne** (`driver.ts`, `DRIVER_VERSION` 3).
  - Le constat, dans l'app construite : « en bits. », dernière ligne de l'Entropie, avait sa ligne de base sur le bord de la page. Les lettres rondes y perdaient environ 1 px. La boîte de TeX n'a pas de profondeur sous une ligne sans jambage.
  - Options :
    - corriger dans l'interface est impossible, car pdf.js dessine dans la boîte de la page ;
    - une marge fixe serait une constante de plus ;
    - la profondeur du strut (0,3 `\baselineskip`, 4,08 pt sous `DEFAULT_PREAMBLE`) est celle des lignes du préambule lui-même : c'est le choix.
  - Seul le bas est traité : voir les mineurs.
  - C'est un fichier du principal, hors de la liste de la tâche. Coût si faux : une ligne et une version.
- Ruling: **une capture attend les compilations demandées**, et ce qu'elles font dessiner :
  - `PendingHold` (`useCompiled.ts`) est tenu pendant toute compilation en attente, pause comprise. Il est lâché après le rendu de la réponse, une fois lancés les effets des enfants, qui commencent la lecture du PDF ;
  - `viewsSettled` attend un tour calme de 50 ms après la dernière lecture finie (`QUIET_MS`, `read.ts`). C'est une attente du banc de captures, et non un réglage ;
  - la reconstruction du registre en attente compte aussi, dans `App`.

  Le constat : une première suite a pris `fenetre-connexion` sur « Compilation… ». La retenue était lâchée à la réponse, avant que React ne dessine le snippet, et les 500 ms de marge du principal le cachaient d'ordinaire. Le test de `viewsSettled` reproduit le cas, et échouait avant le correctif. Coût si faux : 50 ms par attente de capture.
- Ruling: **les suggestions de l'éditeur LaTeX sont deux réglages** (groupe « LaTeX ») :
  - `latexSuggestionsMax`, « Suggestions de labels et de clés montrées dans l’éditeur LaTeX » : 100, de 10 à 1000, par pas de 10 (CodeMirror dessine chacune) ;
  - `latexSuggestionDelayMs`, « Délai avant les suggestions de l’éditeur LaTeX (ms) » : 100, de 0 à 1000, par pas de 10.

  Ce sont les valeurs de CodeMirror. Elles sont lues par `suggestionOptions`, et appliquées à nouveau quand elles changent, par un `Compartment`. Coût si faux : des bornes.
- Ruling: **« Fermer sans enregistrer ? » donne le focus à « Annuler »** : c'est `Question.focusCancel`, que `focusedChoice` lit. La question est construite par `unsavedQuestion` (`saveScheduler.ts`), qu'un test vérifie. Cela règle le mineur reporté de la tâche 5. Coût si faux : un champ.
- Ruling: **`captures.mjs` refuse de tourner sans la TinyTeX du banc** (`bin/windows/pdflatex.exe`), avec un message et le code 2. Il passe à chaque scène son chemin absolu dans `CIRRUS_TINYTEX`. Coût si faux : nul.
- Ruling: **l'éditeur et le snippet ont leurs propres morceaux**, chargés à la demande. Le morceau principal ne porte donc ni CodeMirror ni pdf.js, ce que la construction confirme : `TextLayer` n'est que dans les morceaux du lecteur PDF, `cm-scroller` que dans celui de `TextViewer`. La première fois, le snippet attend son morceau en montrant le source. Coût si faux : nul.

### Notes

- Menée en arrière-plan par le protocole des outils de Chrome, la fenêtre n'a pas le focus du système : `document.hasFocus()` y vaut faux, et la sortie du champ passait pour la fenêtre quittée. `Emulation.setFocusEmulationEnabled` rend la situation d'une fenêtre au premier plan.
- Points de la revue de la tâche 5 traités : les deux réglages des suggestions, le focus de « Fermer sans enregistrer ? », et l'aperçu stable de l'atelier.

### Revue, tour 1

- **Important corrigé : un clic sur l'aperçu du brouillon faisait perdre la frappe, et Ctrl+Z atteignait la base.**
  - Le constat : en modification, un clic sur l'aperçu ou sur la ligne d'état donnait le focus à l'élément du champ lui-même (`tabIndex` −1), et non à l'éditeur. Le curseur disparaissait, et la frappe suivante était perdue. Ctrl+Z passait au raccourci global d'`App`, qui annulait une action de la base. Quitter le champ enregistrait ensuite, ce qui vidait le rétablissement. C'était contraire à la spec 6.4.
  - Premier correctif : un clic qui ne sélectionne rien, ailleurs que sur un lien, un bouton, le journal ou l'éditeur, rend le focus à l'éditeur, son curseur où il était. `fieldReducer` le dit (`focusEditor`), et `LatexEditor` le prend par `focusSeq`, avec le `focus()` de CodeMirror, qui remet sa sélection.
  - Second correctif : le raccourci global d'`App` laisse aussi les touches d'un champ LaTeX en modification (`textOwnsKeys`, `keys.ts`, une fonction pure). C'est le cas après une sélection faite dans l'aperçu, quand le focus reste sur le champ.
  - Suppr ne peut pas atteindre la base depuis un champ : le pop-up de connexion arrête ses touches, et les panneaux sont hors du graphe.
  - Tests : `fieldReducer` (`focusEditor`) et `textOwnsKeys`. Le premier échouait avant le correctif (« expected { state } to deeply equal { state, focusEditor } »).
  - Vu dans l'app construite :
    - un clic sur l'aperçu, puis sur la ligne d'état, rend le focus à `.cm-content`, et la frappe continue au curseur (« en bits. ABC ») ;
    - après une sélection glissée dans l'aperçu, le focus reste sur le champ, et Ctrl+Z n'annule pas le tag ajouté juste avant à la base ;
    - ce Ctrl+Z, que le raccourci de l'app laisse passer, a été pris par l'annulation du texte du navigateur, qui a retiré la dernière frappe de l'éditeur ;
    - de retour dans l'éditeur, Ctrl+Z agit sur son historique, et la base reste inchangée.
- **Important corrigé : un lien d'un PDF du magasin ne prenait plus le focus** (régression du plan 4a). Le `mousedown` empêché valait pour toute `PdfPage` : après un clic sur un lien interne, + et − n'allaient plus au lecteur.
  - Le correctif : il ne vaut plus que pour le snippet (`keepFocus`, faux par défaut).
  - Vu dans l'app construite : un lien interne du chapitre de la publication, dans son aperçu, prend le focus dans la vue, et « + » fait ensuite passer le zoom de 65 % à 75 %. Un lien du brouillon laisse toujours le focus à l'éditeur, et ouvre le pop-up de MDL.
- Suite après les correctifs : 724 tests sur 724, deux de plus. `tsc` : `app` et `view` sans erreur. Captures : 11 sur 11 contre `reference-3c`, 8 sur 8 contre `plan4a`, à 0 pixel, sans rien de nouveau à refaire.
- Ruling: **le clic qui rend le focus à l'éditeur** :
  - ce qu'il touche prend son propre clic s'il est un lien, un bouton, le journal ou l'éditeur (`link` de l'événement) ;
  - un clic qui finit une sélection la garde, et ne rend pas le focus ;
  - une sélection glissée ne passe pas à l'éditeur, et c'est `textOwnsKeys` qui garde alors la base de Ctrl+Z.

  Coût si faux : une condition.

## Tâche 7 : préambule, installation de LaTeX, paquets manquants

### Constat : aucun gpg pour Windows dans TeX Live

- **Ce que TeX Live livre** :
  - `install-tl.zip` des versions 2019, 2021, 2022, 2023, 2024, 2025 et 2026 n'a pas de `tlpkg/installer/gpg/`. Ces archives sont figées dans les archives historiques de TUG (`https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/<année>/`) ; j'ai lu leur répertoire central par des requêtes HTTP Range ;
  - celui de 2026 (2026-03-01, 25 736 787 octets, SHA-256 `16894548ee3812727581dde08ceb7053d0e4a64bfdbdef2e9dd152930664de93`) porte `tlpkg/gpg/` : c'est le trousseau de TeX Live, que TinyTeX a déjà. Son `tlpkg/installer/` ne contient que curl, wget, xz, `tar.exe` et des scripts ;
  - le dépôt tlnet n'a pas de paquet `tlgpg`. Sa base (8 229 paquets, en cache dans la TinyTeX du banc) ne cite aucun fichier `installer/gpg`, et `texlive.infra.windows` ne livre que curl, lz4, tar, wget et xz ;
  - le svn de TeX Live (`tug.org/svn`) était injoignable d'ici : la connexion a été réinitialisée par curl et par Node, et refusée par WebFetch. Le fil `tex-live` de février 2023 le dit : « TeX Live does not install gpg itself ».
- **Le fichier que cherche `tlmgr`** (`TLCrypto.pm`, l. 402 : « a shipped version from tlgpg » ; `tlmgr.pl`, l. 7754 : « sub-repos (like tlgpg) ») vient d'un dépôt annexe.
  - Ce dépôt est à `https://www.texlive.info/tlgpg/`, tenu par Norbert Preining, l'auteur de `tlmgr`. Sa page le dit : « This repository and its contained programs are not part of TeX Live, nor are they affiliated with the TeX Users Group (TUG) ».
  - L'artefact : `archive/tlgpg.windows.tar.xz`, révision 10, de 1 802 264 octets, daté du 2023-03-20 (SHA-256 `07d37d9fcb2876851f2acbe6247cabfb95e1c18e4bc75f6b2d654b0ce714c881`). Il contient `gpg.exe` (GnuPG 1.4.23, 2018) et `iconv.dll`. Il a été listé, jamais lancé.
- **GnuPG lui-même** publie des installateurs NSIS signés : `https://gnupg.org/ftp/gcrypt/binary/gnupg-w32cli-1.4.23.exe` et `gnupg-w32-2.5.24_20260923.exe`. Les extraire demande 7-Zip, ou une installation sur le système.
- **gpg : question rendue à l'utilisateur, R2.4 inchangé.** Décision du contrôleur : rien n'est téléchargé, épinglé ni intégré. `tlmgr` télécharge par HTTPS et contrôle chaque archive par son SHA-512, sans vérifier la signature de la base. Les téléchargements de cette recherche sont effacés.

### Mesures

- **Installation complète depuis l'app construite** :
  - les conditions : sans `CIRRUS_TINYTEX`, `LOCALAPPDATA` dans un dossier temporaire neuf (`%TEMP%\cirrus-t7\local`), la notice, puis « Installer » ;
  - deux passes, de « Installer » à « LaTeX est installé. » :

    | Passe | Total | Téléchargement | Extraction | Paquets (`option`, `update --self`, base, renommage) |
    | --- | --- | --- | --- | --- |
    | 1 | 67,0 s | 17,6 s | 20 s | 24 s |
    | 2 | 55,7 s | 14,1 s | 18 s | 21 s |

  - Une passe antérieure, dans le dossier du bloc-notes, a pris 262,5 s, dont 203 s de paquets. Elle n'est pas retenue : son chemin était trop long (plus bas).
  - La notice a suivi chaque pourcentage (de 64 à 74 textes), puis « décompression… », « Installation des paquets… » et « LaTeX est installé. ». Rien n'est resté de `.partial` ni de `.download`.
  - Selon `tlmgr info --list --only-installed`, les huit paquets de base et `tikz-cd` sont installés.
- **Première compilation** : le pop-up de MDL, ouvert pendant l'installation, affichait « LaTeX est en cours d'installation. ». Son résumé s'est compilé sans frappe, 1,5 s puis 1,6 s après « installé ».
- **`tikz-cd` à la demande** :
  - le geste : `\usepackage{tikz-cd}` tapé dans le préambule ; la notice dit alors « Installation du paquet LaTeX « tikz-cd.sty »… » ;
  - de la frappe à l'aperçu recompilé sans erreur : 18,4 s, puis 154,3 s (un miroir lent), et 12,7 s dans la passe au chemin long ;
  - `settings.json` porte ensuite `"latexPackages":["tikz-cd"]`.
- **Appels de `tlmgr`**, sur une installation neuve, depuis les miroirs de CTAN :
  - l'étape « paquets » : `option repository ctan` 1,5 s ; `update --self` 10,0 s ; `install --reinstall` des huit paquets de base 19,7 s ;
  - `--repository ctan search --global --file /siunitx.sty`, quatre fois : de 10,2 à 11,9 s. Un miroir différent chaque fois : xjj.sh, ibcp.fr, sw-servers.net, tetaneutral.net.
  - Les 203 s et 154 s ci-dessus viennent d'un miroir lent : mirror.ctan.org en redirige chaque appel.
- **Défaut de l'essai : un chemin trop long perd des fichiers sans erreur.**
  - Sous `%TEMP%\claude\…\scratchpad\drive7-run\local\Cirrus\TinyTeX`, `tar` n'a pas pu écrire les fichiers les plus profonds de pgf : plus de 260 caractères (« Could not create file … No such file or directory »).
  - `tlmgr install pgf` a pourtant rendu 0, et pgf restait « installed: No ».
  - La racine réelle, `C:\Users\alpha\AppData\Local\Cirrus\TinyTeX`, fait 43 caractères, et le fichier le plus profond de pgf environ 130 de plus. Les passes retenues ont été refaites sous `%TEMP%\cirrus-t7` (racine de 61 caractères).
- **Vu dans l'app construite** (26 vérifications sur 26, puis 17 sur 17) :
  - **dans le préambule** :
    - Échap avec un changement demande « Abandonner les modifications du préambule ? », « Annuler » ayant le focus ; un second Échap ferme la question seule ;
    - « Enregistrer » ferme sans question un préambule qui compile, et le résumé suit : un nouveau PDF ;
    - Ctrl+Z sur le graphe rend le préambule par défaut ;
    - sans changement, Échap ferme ;
  - **au redémarrage** : aucune notice, et l'`ensure` de `latexPackages` passe en silence ;
  - **hors ligne** (un proxy mort) :
    - « Plus tard » range la notice, qui ne revient pas ;
    - « Installer LaTeX » des réglages donne « L'installation de LaTeX a échoué : Le téléchargement de TinyTeX a échoué (net::ERR_PROXY_CONNECTION_FAILED). », avec « Réessayer » ;
    - le résumé du pop-up dit l'échec, et rien ne reste dans `LOCALAPPDATA` ;
  - **à la fermeture** : aucun pdflatex de cette TinyTeX n'est resté.
- **Le dossier de l'essai a été effacé, et `%LOCALAPPDATA%\Cirrus` n'a jamais été créé.** Deux `pdflatex.exe` vivaient pendant l'essai, mais ils appartiennent à une autre instance de l'app (`packages/app/demo/out/main/index.js`, TinyTeX du banc). Ils n'ont pas été touchés.
- **Captures** : 11 sur 11 contre `reference-3c`, 8 sur 8 contre `plan4a`, à 0 pixel. La section « LaTeX » des réglages n'apparaît dans aucune capture, et la notice ne paraît pas quand LaTeX est là dès le départ.
- **Suite** : 748 tests sur 748 (724 avant la tâche), répartis ainsi. `tsc` : `app`, `view` et `core` sans erreur.

  | Fichier | Tests ajoutés |
  | --- | --- |
  | `latexInstall.test.ts` | 16 |
  | `tinytex.test.ts` | 4 |
  | `compileScheduler.test.ts` | 2 |
  | `latexCompiler.test.ts` | 1 |
  | `params.test.ts` | 1 |

### Décisions

- Ruling: **`LatexSetup` (`latex/setup.ts`) se place devant `LatexService`, et porte seul l'état de LaTeX.**
  - Il tient l'état et ses poussées, l'installation, les paquets du démarrage et les paquets manquants.
  - `LatexService` perd `status` et `state()`, et gagne `restart()` : la réserve est refaite avec son préambule, et son échec oublié.
  - Pourquoi :
    - les tests de la tâche veulent un service factice ;
    - deux sources de l'état se contrediraient : `absent` poussé pendant une installation.
  - Coût si faux : un module.
- Ruling: **`installed` est une liste**, sur une réponse `ok` comme sur une réponse `error`.
  - Après chaque paquet installé, la compilation repart une fois, tant que la réponse nomme un autre fichier que cette requête n'a pas encore cherché (par exemple tcolorbox, qui demande environ).
  - Pourquoi : un seul paquet par requête laisserait la vue en erreur jusqu'à la frappe suivante.
  - Coût si faux : le type d'un champ.
- Ruling: **les recherches de paquets passent une à une, une seule par fichier**, et les requêtes simultanées l'attendent ensemble.
  - Une recherche dont toutes les requêtes ont pris fin avant son tour n'a pas lieu, et n'est pas retenue : c'est un nom en cours de frappe (`t.sty`, puis `ti.sty`…).
  - Une requête annulée pendant sa recherche répond aussitôt `cancelled`, et la recherche continue.
  - La mémoire de la session (décision 5) retient aussi un échec de `tlmgr` (hors ligne) : il n'est réessayé qu'au démarrage suivant.
  - Coût si faux : un redémarrage après le retour du réseau.
- Ruling: **le statut d'un paquet en cours d'installation nomme le fichier manquant** : « Installation du paquet LaTeX « tikz-cd.sty »… ».
  - Pourquoi : le paquet n'est connu qu'après la recherche de `tlmgr`.
  - Coût si faux : un texte.
- Ruling: **`ready` porte `version`, la distribution** (« TeX Live 2026 », tirée de `pdflatex --version`) : la section « LaTeX » des réglages la montre. Coût si faux : un champ.
- Ruling: **le téléchargement n'est dit qu'à chaque pourcentage entier**.
  - Pourquoi : une centaine de messages IPC, au lieu d'un par morceau reçu, soit des milliers.
  - Coût si faux : nul.
- Ruling: **l'installation installe aussi les paquets de l'utilisateur (`ensure`), sous l'étape « Installation des paquets… », avant `ready`.**
  - Pourquoi : la première compilation les trouve. Le préambule a souvent besoin de `latexPackages`.
  - Coût si faux : environ 17 s de plus quand la liste n'est pas vide.
- Ruling: **les paquets du démarrage** :
  - **Quand** : `ensureAtStart`, à chaque `did-finish-load` de la fenêtre, jamais pour le banc ni pour les captures, qui gardent la TinyTeX du banc telle quelle.
  - **L'état** : il ne change pas pendant cette vérification. Si des paquets s'installent, la réserve est refaite et `ready` est redit, ce qui relance les vues.
  - **Les échecs** : un nom en échec n'est pas retenté de la session. Un `ensure` qui lève (liste illisible, délai dépassé) est consigné, puis retenté au chargement suivant.
  - Coût si faux : un démarrage.
- Ruling: **le délai de `tlmgr`, `latexTlmgrTimeoutMs`**.
  - Il vaut pour tout programme que lance l'installation : `tlmgr`, l'extracteur de TinyTeX, `pdflatex --version`. Le libellé le dit : « Durée maximale d'un appel à tlmgr ou à l'installateur de TinyTeX (ms) ».
  - Ses valeurs : 600 000 ms par défaut, de 10 000 ms à 1 h, par pas de 1 000. Le défaut vaut environ trois fois l'appel le plus lent mesuré (203 s, un miroir lent).
  - Le processus qui dépasse est arrêté avec ses descendants (`taskkill /t /f` : tuer `cmd.exe` seul laisserait le perl de `tlmgr`). L'échec dit « tlmgr ne répond plus (plus de 600 s) : arrêté. ».
  - Coût si faux : un réglage.
- Ruling: **`Packages` nomme le dépôt de `LATEX_SOURCES` à chaque appel qui atteint le réseau** (`--repository ctan`, pour `search`, `install` et `update --self`), en plus de l'`option repository` de `provision`.
  - Pourquoi : une nouvelle source, le serveur du plan 5/9, atteint aussi les installations faites avant elle.
  - `runFile` laisse passer « : » vers un `.bat`, pour une adresse ; `cmd.exe` n'en fait rien dans un argument.
  - Coût si faux : un argument.
- Ruling: **`LATEX_SOURCES` (`latex/sources.ts`) porte l'installateur de TinyTeX et le dépôt.**
  - `TINYTEX_RELEASE` en reste un alias, exporté par `tinytex.ts`.
  - Un test refuse toute adresse (`'https://…'`) et tout `'ctan'` dans les autres modules du principal.
  - Coût si faux : nul.
- Ruling: **`packageOf` préfère un chemin qui commence par `texmf-dist/tex/` (ou `RELOC/tex/`)**, puis la première correspondance exacte. Coût si faux : une expression régulière.
- Ruling: **les vues redemandent à chaque changement d'état de LaTeX, et à chaque `ready`** (`latexChanged`), pas seulement quand LaTeX devient prêt.
  - Ce qui repart : une source sans compilation ou en erreur, et une requête en cours, après sa réponse, si elle était partie avant le changement.
  - Pourquoi : un pop-up resté sur « LaTeX n'est pas installé. » montre ainsi « en cours d'installation », puis l'échec (vu dans l'app).
  - Coût si faux : une compilation de plus, rapide, par vue en erreur à chaque changement.
- Ruling: **`withPackage` refuse aussi un nom hors de `WORD`**, que le réglage rejetterait en entier au chargement. Coût si faux : nul.
- Ruling: **les paquets installés sont dits par le pont** (`noteInstalled`, dans `useCompiled.ts`), quelle que soit la vue qui reçoit la réponse ; App les ajoute à `latexPackages`. Coût si faux : nul.
- Ruling: **la notice** :
  - elle est dans la colonne des notifications, en haut au centre, au-dessus des pleins écrans ;
  - « Plus tard » vaut aussi pour un échec, et une installation relancée remet la notice ;
  - « LaTeX est installé. » reste `toastMs` ;
  - le conteneur des notifications est maintenant toujours dans la page, vide et invisible (captures à 0 pixel).

  Coût si faux : du style.
- Ruling: **la section « LaTeX » des réglages vient entre les réglages principaux et « Avancés ».**
  - Ses états : « LaTeX : prêt (TeX Live 2026) », « absent », « installation… », « l'installation a échoué ».
  - « Installer LaTeX » y paraît quand LaTeX est absent ou que son installation a échoué.
  - Coût si faux : une place.
- Ruling: **le plein écran du préambule** :
  - **Ses boutons** :
    - « Annuler » ferme sans demander : c'est un choix explicite ;
    - × demande, comme Échap ;
    - « Enregistrer » (et Ctrl+S) attend la compilation en cours ;
    - sans LaTeX, il enregistre sans demander, faute de pouvoir dire si le préambule compile ;
    - un brouillon inchangé ferme (`saveStep`).
  - **Ses erreurs** : une erreur du préambule est marquée sur sa ligne dans l'éditeur, et le journal y mène ; une erreur de l'exemple se dit « Dans l'exemple : … ».
  - **Sa construction** : il a son propre morceau, chargé à la demande. `useModal` est tiré de `FullScreen`, et sert aux deux.
  - Coût si faux : nul.
- Ruling: **`Panels` est couvert aussi par le plein écran du préambule** (`covered`). Vu dans l'app : l'Échap du préambule fermait le pop-up resté dessous. Coût si faux : nul.
- Ruling: **`PREAMBLE_SAMPLE`** : un paragraphe accentué (« Déjà, l'âme naïve du cœur… »), l'équation numérotée de l'entropie citée par `\eqref`, une liste à puces avec des mathématiques en ligne, et un lien `\href` vers CTAN. Coût si faux : un texte.

### Notes

- Les décisions 2 à 6 du contrôleur sont appliquées : les sources en un seul endroit, `BASE_PACKAGES` dans `@cirrus/core`, le délai de `tlmgr`, aucune boucle de tentatives au démarrage, et `packageOf` préférant `/tex/`. La relance des vues a été ajoutée au planificateur, comme le demandait la revue de la tâche 4.
- La tâche ne liste pas `sources.ts`, `setup.ts`, `install.ts` ni `preamble.ts`. La logique y est pure et testée, comme dans `saveScheduler.ts`.

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
| Construction du registre des labels, base du banc | 4 | de 4 à 14 ms ; de 104 à 160 ms avant `relationRows` | 50 000 nœuds, 549 189 connexions, sans `.tex` ; vitest, 12 constructions, une sur deux avec `previous` |
| Échap pendant la pause d'un `.tex` : enregistré, puis fermé | 5 | 128 ms | app construite, base de test, `complexité.tex` + un paragraphe ; une mesure |
| Fermeture de la fenêtre pendant la pause : enregistré, instantané, sortie | 5 | 655 ms | idem, `WM_CLOSE` jusqu'à la sortie du processus ; une mesure |
| Pop-up de l'Entropie, première ouverture : du clic au résumé dessiné | 6 | de 0,73 à 1,0 s | app construite, base de test, TinyTeX du banc ; pdfLaTeX préparé, morceau de pdf.js et son worker compris |
| Même pop-up rouvert, son résumé en cache : du clic au résumé dessiné | 6 | 23 ms (trois fois) | idem ; aucune compilation, le source jamais montré |
| Brouillon d’un résumé : de la frappe au snippet dessiné | 6 | environ 500 ms | idem ; pause de frappe de 300 ms comprise |
| Installation de LaTeX depuis l’app : de « Installer » à « LaTeX est installé. » | 7 | 67,0 s puis 55,7 s (téléchargement 17,6 et 14,1 s) | app construite, `LOCALAPPDATA` temporaire, `net.fetch`, miroirs de CTAN |
| Résumé ouvert pendant l’installation : compilé après « installé » | 7 | 1,6 s puis 1,5 s | idem ; sans frappe (`latexChanged`) |
| `tikz-cd` à la demande, du préambule tapé à l’aperçu recompilé | 7 | 18,4 s ; 154,3 s une fois (miroir lent) | idem ; `search --global`, `install`, réserve refaite |
| `tlmgr --repository ctan search --global --file` | 7 | de 10,2 à 11,9 s, quatre fois | installation neuve ; un miroir différent chaque fois |

## Mineurs reportés

Chaque ligne `minor (deferred)` du suivi du plan, dans l'ordre des tâches, avec ses fichiers et ses lignes.

### Tâche 1

- Pour la tâche 3 (Review Focus 1 : « l'aperçu montre le texte tel qu'il est écrit ») : `titleToTex` garde tels quels les caractères de la plage. Deux cas affichent pourtant autre chose que le texte tapé :
  - sous T1, les ligatures de TeX changent un titre : `--` et `---` deviennent des tirets ; deux apostrophes, ou deux accents graves, des guillemets ; `<<` et `>>` des chevrons ; `,,` un guillemet bas ; un point d'exclamation ou d'interrogation suivi d'un accent grave, un signe renversé ;
  - sous un préambule sans T1 (OT1), `<`, `>` et `|` deviennent d'autres glyphes.

  Rien n'est exécuté, et la compilation ne casse pas. Briser les ligatures (`-{}`, `'{}`, `<{}`) changerait la sortie que la tâche 1 fixe (latex.ts, `titleToTex`).

### Tâche 2

- Pour la tâche 7 : `runFile` n'a pas de délai maximal. Un `tlmgr` suspendu au réseau bloquerait la file de `Packages`, et tous les appels suivants. Un délai serait un réglage avancé du groupe « LaTeX » (`packages/app/src/main/latex/tinytex.ts`, `runFile`). Traité à la tâche 7 (`latexTlmgrTimeoutMs`).
- Pour la tâche 7 : `BASE_PACKAGES` est dans le principal (décision P1). Si `withPackage` vit dans l'interface, elle ne pourra pas importer `tinytex.ts`, qui tire `node:child_process`. La liste irait alors dans `@cirrus/core` (`latex.ts`). Traité à la tâche 7 (décision 3 du contrôleur).
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

### Tâche 4

- Pour la tâche 5 : une clé `clé_bibtex` portée par deux nœuds est rouge dans l'aperçu depuis la revue (`doubledCites`). L'éditeur doit la marquer aussi, par `citeNodes(key).length > 1` (`request.ts`).
- Pour les tâches 5 et 6 : deux vues du même emplacement s'annulent l'une l'autre dans le principal, puisqu'une requête annule la précédente de son emplacement. Une source ne doit avoir qu'un `useCompiled` à la fois (`scheduler.ts`).
- Pour les tâches 5 et 6 : `useCompiled` compare la requête à chaque changement de son identité, c'est-à-dire le JSON de toute la source. Les appelants gagnent à la mémoriser (`useMemo`) (`useCompiled.ts`).
- `\verb|…|` n'est pas sauté : `\verb|%|` y commence un commentaire, et `\verb|\label{x}|` y serait un label. Le `withoutComments` du principal fait de même (`scan.ts`).
- `labels()` trie les labels par unités de code, et non à la française. Les suggestions de la tâche 5 voudront peut-être `localeCompare` (`registry.ts`).
- Le registre se reconstruit en entier à chaque changement, au plus une fois par pause : de 4 à 14 ms sur la base du banc. Une mise à jour par les opérations de l'action ne viendra que si la vraie base grossit (`registry.ts`).
- Une action pendant la lecture des `.tex` l'abandonne. La lecture suivante reprend tout ce qui n'était pas fini (`App.tsx`).

### Tâche 5

- L'enregistrement à la fermeture de la fenêtre doit tenir dans `snapshotQuitMs` (2 s), avec l'instantané. Passé ce délai, le principal ferme quand même, et un `.tex` dont l'enregistrement traîne (un disque lent) serait perdu. Mesuré : 655 ms en tout (`App.tsx`, `onQuit`).
- Le plein écran gardé sur sa dernière cible, quand le `.tex` disparaît avec du texte en attente, ne peut arriver que par `receive` (plan 5). Il n'a pas été vu dans l'app ; un test couvre le refus (`App.tsx`, `lastFull`).
- Dans la question « Fermer sans enregistrer ? », Entrée choisit de fermer sans enregistrer : c'est la règle d'`AskDialog`, dont le premier choix a le focus (`TexWorkbench.tsx`). Traité à la tâche 6 (`focusCancel`).
- À chaque frappe, l'atelier analyse le texte deux fois (`buildRequest`, puis `diagnosticsFor` par `scanOf`), et l'éditeur le recopie en entier (`doc.toString()`). C'est négligeable pour un `.tex` ordinaire, sensible pour un `.tex` de quelques Mo (`TexWorkbench.tsx`, `LatexEditor.tsx`).
- L'aperçu d'un `.tex` relit le fichier par `readHead`, alors qu'`App` a déjà son texte pour le registre (`Viewer.tsx`, `TexPreview`).
- Pendant une frappe, « Compilation… » remplace dans le bandeau l'erreur de la compilation d'avant, qui revient si l'erreur reste (`TexWorkbench.tsx`).
- Un PDF compilé sorti du cache entre la réponse et sa lecture (404) est dit « introuvable dans la base » par `readHead` ; l'aperçu garde alors le précédent (`read.ts`, `PdfViewer.tsx`).

### Tâche 6

- Le haut d'un snippet dont la première ligne n'a ni hampe ni capitale (« une … ») peut perdre environ 1 px du débord des lettres rondes. Le strut ne couvre que le bas (`driver.ts`, `jobBody`).
- Le mineur de la tâche 3 sur `\nameref` reste ouvert : ni la tâche ni le contrôleur ne le portaient ici (`driver.ts`, `jobBody`).
- Un lien vers un nœud parti n'a pas été vu dans l'app : la notification « Ce nœud n’existe plus. » n'y vient que d'un PDF compilé avant le départ du nœud, et gardé jusqu'à la compilation suivante. `App.tsx` ne s'importe pas dans un test (`App.tsx`, `nodeLink`).
- Un pop-up ouvert par un lien passe à gauche du panneau d'où vient le clic quand la place manque à droite, et peut couvrir le pop-up du nœud dont le fichier portait le lien (`Panels.tsx`, `linkedRect`).
- À la première ouverture d'un pop-up dans la session, le source se montre de 0,7 à 1 s, le temps de la première compilation : c'est la règle de la tâche (`LatexField.tsx`).
- À chaque frappe, le champ analyse le brouillon deux fois (`buildRequest`, puis `diagnosticsFor` par `scanOf`), comme l'atelier (`LatexField.tsx`, `EditMode`).
- `shownBefore` garde un enregistrement par résumé ou relation montré, pour toute la session (`LatexField.tsx`).
- Le journal fermé par son ×, en vue, rend le focus au champ ; l'Échap suivant ferme alors le pop-up, comme avant d'ouvrir le journal (`LatexField.tsx`, `refocus`).
- Revue, tour 1, reportés par le contrôleur :
  - un enregistrement refusé laisse un temps le rendu du texte refusé (`LatexField.tsx`, `committed`) ;
  - le câblage React du champ, des pop-ups et d'`App` n'a pas de test automatique : seule l'app construite le vérifie ;
  - des répétitions à mettre en commun ;
  - un second Échap sur la relation compilée ne ferme pas le pop-up de connexion, qui arrête ses touches (`ConnectionPopup.tsx`) ;
  - les tests chronométrés déjà instables, `scale.test.ts` (store) et `scale-perf.test.ts` (view).

### Tâche 7

- **Un chemin trop long** : une racine de TinyTeX de plus de 120 caractères environ perd des fichiers sans erreur.
  - `tar` ne peut pas écrire les fichiers les plus profonds de pgf (plus de 260 caractères), et `tlmgr install` rend tout de même 0 (mesuré).
  - `provision` ne vérifie pas que `BASE_PACKAGES` est inscrit dans la base locale. La racine réelle de cette machine fait 43 caractères (`tinytex.ts`, `provision`).
- Une requête annulée pendant l'installation de son paquet répond `cancelled`, sans `installed`. `latexPackages` ne gagne alors pas ce paquet, que les autres PC installeront à la demande (`setup.ts`, `compileInstalling`).
- Une recherche qui échoue (`tlmgr` hors ligne) n'est pas refaite de la session : il faut redémarrer l'app après le retour du réseau (`setup.ts`, `found`).
- Quitter l'app pendant une installation laisse `tlmgr` ou l'extracteur aller à leur fin, sans les tuer. Ce qui reste de `.partial` est effacé à l'essai suivant (`index.ts`, `setup.ts`).
- Les miroirs de CTAN varient beaucoup. mirror.ctan.org redirige chaque appel, et des appels de 203 s et 154 s ont été vus, contre 10 à 30 s d'ordinaire. Le délai de 600 s couvre trois fois le pire vu (`sources.ts`, `repository`).
- `latexChanged` refait aussi, à chaque changement d'état, la compilation d'une vue en erreur pour une autre raison qu'un paquet : une compilation rapide de plus (`scheduler.ts`, `retry`).
- L'éditeur du préambule n'a ni suggestions ni diagnostics de labels (`registry` à null) : seule l'erreur du préambule y est marquée (`PreambleEditor.tsx`).
- Le pop-up de connexion se ferme à tout Échap et à tout appui hors de lui, même sous un plein écran. Il faut un clic hors de lui pour ouvrir le préambule, ce qui le ferme déjà (`ConnectionPopup.tsx`).

## Décisions du contrôleur (plan 4b)

Chaque décision du contrôleur (`Ruling:`) du suivi de l'exécution, qui disparaîtra avec l'espace de travail, dans son ordre : décision — raison — coût si faux. Quand une décision est détaillée plus haut, sous sa tâche, la ligne le dit.

### Avant la tâche 1 (examen des tâches)

- Ruling P1: T2 exports the base package list as `BASE_PACKAGES` (the list provision installs); T7's withPackage reads it — cost if wrong: a rename.
- Ruling P2: T6 drops the « Titre court » relabel of the connection title (never asked, would change the frozen reference-3c capture fenetre-connexion) — cost if wrong: one label.
- Ruling P3: T6 keeps the relation's empty-field look as today (placeholder « Relation (LaTeX) », same box) so reference-3c fenetre-connexion stays within tolerance — cost if wrong: one placeholder text.
  - Appliquée à la tâche 6, avec son repli : « Analogue bayésien » a une relation (`build.ts`, l. 133), et `reference-3c/fenetre-connexion` a donc été refaite (Ruling sous la tâche 6).

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

### Tâche 4, revue (correctifs, tour 1)

- Ruling : une clé de citation portée par plusieurs nœuds est rouge dans l'aperçu, avec la citation courte du premier nœud (champ `doubledCites` de la requête), comme un label en double — Review Focus 5 le demandait, la tâche 4 ne le portait pas — coût si faux : un champ.
  - Appliquée sous la tâche 4 (« Revue, tour 1 ») : `CompileRequest.doubledCites`, `buildRequest`, `jobBody`, `DRIVER_VERSION` à 2, la clé du cache et la validation de la requête par le principal.

### Avant la tâche 5

- Ruling : le brouillon d'un éditeur se compile sous `draft:<emplacement>`, la vue enregistrée sous le sien ; au plus un `useCompiled` par emplacement, avec `params.latexTypingPauseMs` — deux vues d'un emplacement s'annuleraient dans le principal — coût si faux : nul. Appliquée sous la tâche 5.
- Ruling : l'éditeur marque « Clé de citation portée par plusieurs nœuds : x » — le pendant, dans l'éditeur, de `doubledCites` — coût si faux : un message. Appliquée sous la tâche 5.
- Ruling : le regroupement est `run(build, { merge })` : les enregistrements regroupés reprennent l'identifiant de la première action, et toute autre action écrite, une annulation ou un rétablissement y met fin — D6, dans les mots de l'utilisateur — coût si faux : une option de la session. Appliquée sous la tâche 5.

### Avant la tâche 6

- Ruling : un `LatexField` en modification compile son brouillon sous `draft:<emplacement>`, en vue sous `<emplacement>`, l'un des deux seulement à la fois, avec `params.latexTypingPauseMs` — une source, un `useCompiled` — coût si faux : nul. Appliquée sous la tâche 6.
- Ruling : trois points de la revue de la tâche 5 passent à la tâche 6 : les constantes des suggestions de CodeMirror deviennent des réglages du groupe « LaTeX » ; dans « Fermer sans enregistrer ? », le focus et Entrée vont au choix qui ne perd rien ; le `live` de l'aperçu de l'atelier devient stable — règle de l'utilisateur sur les constantes, et une frappe qui ne relance pas la mise en page du PDF — coût si faux : nul. Appliquée sous la tâche 6.
- Ruling : le snippet dessine toutes ses pages ; « quitter le champ et son aperçu » veut dire sortir de l'élément du champ, et un clic sur un lien de l'aperçu n'enregistre rien à lui seul ; un lien du résumé vers son propre nœud fait passer son pop-up devant ; dans un plein écran, modal, un lien vers un nœud n'ouvre rien et le dit dans son bandeau, ailleurs il ouvre le pop-up — ambiguïtés de la tâche — coût si faux : nul. Appliquée sous la tâche 6.
- Ruling : un enregistrement refusé à la fermeture laisse le plein écran ouvert avec son bandeau ; une seconde demande ferme après « Fermer sans enregistrer ? » — plus simple que de garder le texte pour la session — coût si faux : une question. Appliquée sous la tâche 5.

### Avant la tâche 7

- Ruling 1 (gpg) : restaurer le gpg Windows officiel de TeX Live dans `<root>/tlpkg/installer/gpg/`, depuis un artefact officiel épinglé — décision de l'utilisateur, « sauf contrordre applique ta recommandation » — coût si faux : un téléchargement.
  - Constat de la tâche 7 : il n'existe pas d'artefact officiel de TeX Live qui le porte (le constat est sous la tâche 7).
  - Le contrôleur, ensuite : le gpg sort de la tâche. Rien n'est téléchargé, épinglé ni intégré, R2.4 reste, et la question revient à l'utilisateur.
- Ruling 2 : toutes les sources de téléchargement en un seul module du principal, `LATEX_SOURCES` (l'installateur de TinyTeX et le dépôt des paquets), Internet par défaut — demande de l'utilisateur : « mettre tous les utils sur le serveur, de manière à ce que l'utilisateur n'aille rien chercher sur internet » (plan 5/9) — coût si faux : un module. Appliquée sous la tâche 7.
- Ruling 3 : `BASE_PACKAGES` passe dans `@cirrus/core` : `withPackage`, dans l'interface, en a besoin — coût si faux : un import. Appliquée sous la tâche 7.
- Ruling 4 : `runFile` reçoit un délai pour `tlmgr`, un réglage « LaTeX » ; l'appel dépassé est arrêté, et l'échec dit en français — un `ensure` du démarrage ne doit jamais tenir la file — coût si faux : un réglage. Appliquée sous la tâche 7.
- Ruling 5 : un nom qu'`ensure` n'a pas pu installer n'est retenté qu'une fois par session de l'app ; un fichier manquant pour lequel `installFor` a rendu null n'est plus cherché de la session — pas de boucle de tentatives au démarrage — coût si faux : un redémarrage. Appliquée sous la tâche 7.
- Ruling 6 : parmi les correspondances exactes, `packageOf` préfère un chemin sous `texmf-dist/tex/` (mineur de la revue de la tâche 2) — coût si faux : une expression régulière. Appliquée sous la tâche 7.
- Ruling : après `ready` ou un paquet installé, les vues compilent à nouveau sans frappe, par un compteur que le planificateur compare (mineur de la revue de la tâche 4) — coût si faux : nul. Appliquée sous la tâche 7 (`latexChanged`).
