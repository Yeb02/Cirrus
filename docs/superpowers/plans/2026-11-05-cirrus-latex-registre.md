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
