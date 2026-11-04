# Registre du plan 4a : fichiers et pop-ups — mesures, décisions, écarts

Plan : `docs/superpowers/plans/2026-11-04-cirrus-fichiers-popups.md`. Départ : 63a9818. Une décision que le plan ne fixe pas se consigne ici sous la forme `Ruling:` : ses options, le choix, pourquoi, et son coût s'il est faux.

## Tâche 1 : principal — protocole des fichiers, import, copies en lecture seule, historique

### Mesures

- **Accès au schéma depuis la page** (Electron 45, script d'essai à part, page `file://` comme l'app construite, puis `http://localhost` comme le serveur de dev) :
  - sans le privilège `corsEnabled`, `fetch` et XHR vers `cirrus-file:` sont refusés (« Cross origin requests are only supported for protocol schemes: chrome, chrome-extension, chrome-untrusted, data, http, https ») ; `<img>` passe ;
  - avec `corsEnabled`, `fetch` (entier, `bytes=0-9`, `bytes=990-`, `bytes=-10`) et XHR à plage passent, depuis les deux origines. Les réponses sont de type `basic` : aucun en-tête `Access-Control-*` n'est demandé, aucune requête OPTIONS n'est envoyée, et `Accept-Ranges` et `Content-Range` sont lisibles (pdf.js les lit par XHR, car son chargeur `fetch` est réservé à `http:` et `https:`).
- **URL reçue par le gestionnaire** : Chromium la canonicalise avant. L'hôte passe en minuscules, `..` et `%2e%2e` sont résolus, `\` devient `/`. La requête et le fragment (`?q=1#frag`) arrivent au gestionnaire ; les majuscules de l'empreinte restent.
- **SVG servi puis chargé comme document** (la fenêtre qui naviguerait vers lui) : son script s'exécute, avec le pont du preload exposé. Avec l'en-tête `Content-Security-Policy: sandbox`, Chromium le bloque.
- **Copies en lecture seule** : le Node d'Electron 45 (24.22.1) refuse `rmSync` sur un fichier en lecture seule (EPERM), celui de vitest (26.13.0) l'efface. `unlinkSync` l'efface dans les deux, et `rmSync` aussi après `chmodSync(…, 0o644)`. Un fichier en lecture seule se renomme.
- **Import d'un fichier de 200 Mo** (`importFile`, Node 26, cache disque chaud) : 629–685 ms en trois passes, le processus bloqué pendant ce temps.
- **Essai de bout en bout** du principal et du preload construits (mode capture, base de test temporaire, page d'essai chargée par `ELECTRON_RENDERER_URL` avec la CSP de `index.html`) :
  - `importFiles` : deux fichiers importés, dont un nom accentué ; le dossier et le chemin absent refusés avec leur raison ;
  - par `fetch` : 206 et les octets exacts de la plage, 200 entier, 416, 404, 400 pour une empreinte en majuscules ; `<img>` chargée, type `image/png` ;
  - `pathForFile` d'un `File` construit dans la page, puis d'un objet quelconque : `''` ;
  - `historyOf` : les mêmes date de création, date de modification et nombre d'actions (4) que le SQL ; un identifiant inconnu donne `null`, `null`, 0 ;
  - `openFile` : refusé, avec un message en français, pour `..\x.bat` et pour une empreinte absente du magasin.
- Suite complète : 476 tests sur 476 (463 + 13). `tsc` : `app` et `view` sans erreur. Captures : 11 sur 11 à 0,000 % de `reference-3c`.

### Décisions

- Ruling: **CSP**, `img-src 'self' data: blob: cirrus-file:` et `connect-src 'self' cirrus-file:`.
  - Options :
    - `cirrus-file:` dans `img-src` et `connect-src` seulement (choix) ;
    - dans `default-src`, ce qui l'ouvrirait aussi aux scripts, cadres, objets et médias ;
    - aucune source, les octets passant par IPC en URL `blob:` (écarté par D1).
  - Pourquoi : `<img>` (images, vignettes) et `fetch`/XHR (`readHead`, pdf.js) sont les seuls chemins de D1. `connect-src` reprend `'self'`, car il remplace `default-src` pour les connexions ; le serveur de dev et son HMR restent permis. Ni `media-src`, ni `frame-src`, ni `object-src`, ni `script-src`, ni `worker-src` ne reçoivent quoi que ce soit : le plan 4a n'a ni vidéo ni cadre, et pdf.js ajoutera ce qu'il exige à la tâche 6, avec son propre `Ruling:`.
  - Coût si faux : une source de plus, à la tâche qui en a besoin.
- Ruling: **privilège `corsEnabled`** en plus des quatre du plan (`standard`, `secure`, `supportFetchAPI`, `stream`).
  - Options : les quatre seuls ; `corsEnabled` en plus (choix) ; `bypassCSP`, qui passerait aussi outre la CSP de la page.
  - Pourquoi : sans lui, `fetch` et XHR sont refusés depuis la page (mesuré ci-dessus), et l'interface ne pourrait lire ni texte ni PDF. Aucun en-tête CORS n'est nécessaire.
  - Coût si faux : nul ; seule notre fenêtre charge des pages.
- Ruling: **`Content-Security-Policy: sandbox`** sur les réponses 200 et 206.
  - Options :
    - rien, la garde de navigation de la tâche 4 suffisant ;
    - l'en-tête (choix) ;
    - servir le SVG en `application/octet-stream`, ce qui casserait son affichage par `<img>`.
  - Pourquoi : un SVG ou un HTML du magasin devenu document exécuterait ses scripts avec le pont exposé (mesuré). L'en-tête ne change rien pour `<img>`, `fetch` et XHR. C'est une défense en profondeur, qui ne dépend d'aucune garde.
  - Coût si faux : nul pour les vues prévues. Une future vue qui afficherait un fichier servi comme document le recevrait sans scripts.
- Ruling: **lecture de l'URL** : exactement `cirrus-file://blob/<empreinte>/<nom>`, en deux segments.
  - Coupés avant la lecture : la requête et le fragment (Chromium les transmet, et `encodeURIComponent` échappe `?` et `#` dans un nom).
  - Refusés avec 400 : une barre oblique inverse n'importe où, un encodage `%` invalide, un nom vide, un autre hôte.
  - Options : `new URL`, qui résout lui-même `..` et accepterait sans bruit `blob/x/../<empreinte>/a` ; un découpage de la chaîne (choix).
  - Coût si faux : une URL construite autrement (sans nom, par exemple) reçoit 400. `fileUrl` (tâche 2) construit exactement ce format.
- Ruling: **plages**.
  - Une seule plage est servie. Plusieurs plages, une plage inversée, une autre unité ou `bytes=-` sont ignorées et le fichier est servi entier (RFC 9110, 14.2, le permet).
  - Une fin au-delà de la taille est ramenée à la fin, et un suffixe plus long que le fichier donne tout le fichier.
  - Un suffixe nul, ou toute plage sur un fichier vide, donne 416 avec `Content-Range: bytes */<taille>`. L'unité est insensible à la casse.
  - Options : 416 pour une plage invalide ; l'ignorer (choix).
  - Coût si faux : un client qui demande plusieurs plages reçoit tout le fichier ; pdf.js et `readHead` n'en demandent qu'une.
- Ruling: **réponses sans corps** : 400, 404 et 416 portent `Accept-Ranges: bytes` et `Content-Length: 0`. Un fichier vide donne 200 sans corps (`createReadStream` refuse `end = −1`). Le gestionnaire vit dans `files.ts` (`blobResponse`), où il se teste sous Node avec les octets réels, plutôt qu'en ligne dans `index.ts`. Coût si faux : nul.
- Ruling: **types de contenu** : `png`, `jpg`/`jpeg`, `gif`, `webp`, `bmp`, `svg` (`image/svg+xml`), `avif`, `ico` et `pdf`.
  - Options pour `ico` : `image/vnd.microsoft.icon` (IANA) ou `image/x-icon`, celui que les navigateurs emploient (choix).
  - L'extension se lit comme Windows la lit : après le dernier point, sans les points ni les espaces finaux (voir `isRunnable`).
  - Coût si faux : nul.
- Ruling: **raison de refus « illisible »**, en plus des trois du plan : un échec qui n'est pas une absence (`ENOENT`, `ENOTDIR` : « introuvable »). Les raisons de la correction 1 (I1 ci-dessous) s'y ajoutent.
  - Cas visés : un fichier tenu en exclusivité par un autre programme, ou un accès refusé ; une erreur d'écriture du magasin (disque plein) se lit aussi « illisible », fichier par fichier.
  - Options :
    - relancer l'erreur, ce qui ferait échouer tout le dépôt sans importer les autres fichiers, contre le Review Focus 2 ;
    - tout appeler « introuvable », ce qui tromperait ;
    - « illisible » (choix).
  - Coût si faux : un libellé.
- Ruling: **« plus de N Mo »**.
  - N vaut `maxBytes / 2^20`, écrit à la française (`toLocaleString('fr-FR')`, une décimale au plus). C'est `maxImportMb`, puisque le principal passe `maxImportMb × 2^20`.
  - Le Mo vaut 2^20 octets, comme pour `formatSize` (tâche 2, base 1024), et un fichier d'exactement `maxBytes` octets est accepté.
  - Coût si faux : nul.
- Ruling: **apostrophe typographique** dans les textes de l'interface : « c’est un dossier », « Taille maximale d’un fichier importé (Mo) ».
  - Options : l'apostrophe droite du plan, mot pour mot ; l'apostrophe typographique (choix).
  - Pourquoi : tous les libellés de `params.ts` et les messages de `index.ts` emploient ’, et les plans écrivent ' partout, y compris pour les libellés déjà livrés en ’.
  - Coût si faux : un test d'une tâche suivante qui comparerait la forme droite échoue visiblement ; un caractère à changer.
- Ruling: **extension d'un fichier ouvert par le système**, lue comme Windows la lit.
  - Les points et les espaces finaux tombent : « a.bat. » s'ouvrirait comme « a.bat ». Un nom qui n'est qu'une extension (« .lnk ») la porte.
  - La liste est fixe : une liste de sécurité n'est pas un réglage. C'est celle du plan, plus `sh`, depuis la correction 2 (ci-dessous).
  - Coût si faux : nul.
- Ruling: **`openableCopy` vérifie la référence reçue par IPC**.
  - L'empreinte doit avoir 64 caractères hexadécimaux. Le nom doit être un simple nom de fichier : aucun de `<>:"/\|?*`, ni caractère de contrôle, ni point ou espace final, ni nom de périphérique réservé (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`, avec ou sans extension). Sinon la fonction lève.
  - Pourquoi : `..\..\x.bat` écrirait hors du dossier des copies, `a.txt:flux` dans un flux de données alternatif, `CON` vers la console.
  - Options : faire confiance à l'interface ; vérifier (choix).
  - Coût si faux : nul. `checkFileName` (tâche 2) refuse les mêmes noms, donc aucun nom permis dans un nœud n'est refusé ici.
- Ruling: **écriture et réemploi des copies**.
  - Une copie s'écrit sous un nom temporaire (`.copie-<hex>`) dans le même dossier, passe en lecture seule, puis est renommée : une copie trouvée est entière.
  - Une copie n'est réemployée que telle qu'elle a été laissée : en lecture seule, de la taille du fichier du magasin, et marquée (I2 ci-dessous). Sinon elle est refaite. Ce cas couvre une copie dont on a retiré la lecture seule à la main, même réécrite à taille égale (Minor 3 de la relecture, correction 1).
  - Options :
    - réemployer ce qui est là (plan) ;
    - comparer la taille seule (livraison) ;
    - comparer la taille, le droit d'écriture et la marque (correction 1, choix).
  - Coût si faux : un `stat` et la lecture d'un flux de 26 octets par ouverture.
- Ruling: **ménage des copies**.
  - Les fichiers repassent en écriture, puis `unlinkSync` les efface ; c'est ce qui marche sous le Node d'Electron, mesuré. Les dossiers vidés s'effacent par `rmdirSync`, et un fichier qui ne s'efface pas (encore ouvert) repasse en lecture seule.
  - `cleanCopies` est appelé juste après `createWindow`, pendant que la fenêtre charge, et seulement hors banc et hors captures. Le banc de construction et le banc d'instantanés rendent la main avant. Un lancement normal sur une autre base (`CIRRUS_DATA`) fait aussi le ménage.
  - Coût si faux : deux instances sur deux bases partagent `%TEMP%\cirrus-ouverts`, et le démarrage de la seconde efface les copies fermées de la première. Une application qui a lu son fichier puis l'a fermé continue de l'afficher.
- Ruling: **messages d'`openFile`** : remplacé à la correction 2 (ci-dessous). La correction 1 laissait passer le texte anglais de Node et de `shell.openPath` après un cadre français.
- Ruling: **décision d'ouvrir ou de montrer** (Minor 4, correction 1) : `openTarget` dans `files.ts` rend `{ path, shown }` et se teste. Le gestionnaire IPC ne fait plus qu'appeler `shell.showItemInFolder` ou `shell.openPath`. Coût si faux : nul.
- Ruling: **types du pont** : `env.d.ts` importe `ImportResult` et `HistorySummary` de `../main/files.ts` par `import type`, effacé à la construction.
  - Options : recopier les formes dans `env.d.ts`, comme le fait le reste du fichier ; importer le type (choix).
  - Pourquoi : le principal et le pont partagent ainsi une seule définition.
  - Coût si faux : nul.
- Ruling: **`protocol.handle` aussi au banc et aux captures**. Les captures des tâches 3 à 6 montrent des vignettes. Coût si faux : nul.
- Ruling: **l'import reste synchrone dans le principal**, comme le plan le définit (`importPaths` rend un `ImportResult`).
  - Mesure : 200 Mo prennent environ 0,65 s, fenêtre figée.
  - Options : un `worker_threads` qui importe, sans rien changer au pont, déjà asynchrone (reporté) ; synchrone (choix).
  - Coût si faux : un gel d'environ 0,65 s par 200 Mo importés. La correction ne touche pas l'interface.

### Correction 1 (relecture de la tâche 1)

- Ruling (I1): **l'import ne lit que les fichiers déposés, locaux et ordinaires**.
  - Le preload garde, dans sa fermeture, l'ensemble des chemins que `pathForFile` a rendus dans cette page. `importFiles` ne transmet au principal que ceux-là ; les autres reviennent refusés, « non déposé ».
  - Le principal refuse les chemins réseau et de périphérique (`\\serveur\…`, `//…`, `\\?\…`, `\\.\…`), « chemin réseau ou de périphérique », avant tout accès au disque.
  - Il refuse aussi ce qui n'est pas un fichier ordinaire, « pas un fichier ordinaire » (Minor 1 de la relecture). Le test passe par `lstat`, donc un lien n'est jamais suivi : un lien vers un partage ouvrirait SMB comme un chemin UNC.
  - Le gestionnaire IPC ne garde que les chaînes d'un tableau. `pickFiles` ne change pas, puisque ses chemins viennent de la boîte de dialogue du principal ; ils passent par les mêmes refus.
  - Pourquoi : sans la porte, un script de la page faisait copier n'importe quel fichier lisible (`.ssh\id_rsa`) dans le magasin, puis le lisait par `cirrus-file:`. Un chemin UNC envoyait les identifiants NTLM de l'utilisateur.
    - Les scripts de la page n'atteignent pas la fermeture du preload (`contextIsolation`), et `getPathForFile` rend `''` pour un `File` qu'ils fabriquent.
    - D6 reste tel quel : l'interface calcule les actions, et aucune IPC n'est ajoutée. Il faut désormais une faille du moteur de rendu, et non un simple script.
  - Options écartées : faire confiance aux chemins de la page (livraison) ; un import écrit par le principal sur un événement de dépôt, qu'Electron ne fournit pas.
  - Mesures :
    - avant la correction, le test des chemins réseau a pris 2,7 s pour `\\serveur\partage\a.txt` (tentative SMB), et `\\.\NUL` comme `\\?\<chemin>` étaient importés ;
    - sous Electron, avec le preload construit et un vrai fichier du disque donné à un `<input type=file>` par `DOM.setFileInputFiles` (CDP), le chemin du fichier réel passe, tandis que `C:\Windows\win.ini` et `42`, nommés par la page, reviennent « non déposé » sans atteindre le principal.
  - Coût si faux : un fichier légitime d'un partage réseau doit d'abord être copié en local. Il en va de même pour un lien symbolique, dont on dépose la cible.
- Ruling (I2): **marque du web sur chaque copie ouvrable**.
  - Le flux `<copie>:Zone.Identifier` reçoit `[ZoneTransfer]\r\nZoneId=3\r\n`, écrit avant le passage en lecture seule : Windows refuse d'écrire un flux d'un fichier en lecture seule (EPERM), mesuré. Le renommage garde le flux.
  - Une copie réemployée qui l'a perdu est refaite, marquée.
  - Sur un volume sans flux (non NTFS), l'écriture échoue sans bruit : la copie n'a pas de marque et se refait à chaque ouverture.
  - Pourquoi : le magasin ne garde que le flux principal d'un fichier importé, et Cirrus ne doit pas blanchir la marque d'un fichier téléchargé. Sans elle, SmartScreen, le mode protégé d'Office, son blocage des macros venues d'Internet et les blocages de zone des CHM et HTA ne jouent plus.
  - Options écartées : garder la zone d'origine de chaque fichier, ce qui demanderait un champ de `FileRef` synchronisé entre PC ; ne marquer que les exécutables.
  - Coût si faux : les documents Office de l'utilisateur ouverts depuis Cirrus passent par le mode protégé, à un clic. Une modification d'une copie en lecture seule n'est de toute façon pas gardée.
    - Les macros, elles, ne s'activent plus du tout : depuis 2022, Office bloque sans bouton les macros VBA d'un fichier venu d'Internet (relecture 1 de la correction). Un `.docm` ou un `.xlsm` de l'utilisateur ouvert depuis Cirrus s'ouvre donc sans ses macros.
- Ruling (I3, imposé par le plan): **liste des exécutables** — **abandonné à la correction 2**, à la demande de l'utilisateur, pour la liste courte du plan plus `sh` (ci-dessous). Il reste ici pour l'historique.
  - Elle reprend la table de Microsoft « File types blocked in Outlook » (page « Blocked attachments in Outlook », support.microsoft.com/office/434752e1-02d3-4e90-9124-8b81e49a8519). La page ne parle plus de « Level 1 ». Elle a été lue le 2026-11-04 et compte 133 extensions, dont `pyc`, `pyzw`, `chm`, `application`, `scf`, `inf`, `xll`, `settingcontent-ms`, `iso` et `mht`.
  - S'y ajoutent les entrées du plan qui n'y sont pas, `psm1`, et les autres paquets d'applications : `msix`, `msixbundle`, `appxbundle`. `appref-ms` et `appx` y sont déjà.
  - Pourquoi : la liste du plan oubliait des types qui exécutent du code à l'ouverture. Une liste tenue par Microsoft est la référence habituelle, sans excès.
  - Option écartée : une liste blanche de documents, qui échoue fermée, mais bloque tout format légitime non listé et demande un entretien.
  - Coût si faux : un type de document inhabituel est montré dans l'explorateur au lieu d'être ouvert.

### Correction 2 (relecture 1 de la correction)

- Ruling (abandonne la liste d'Outlook, I3) : **liste courte des exécutables : celle du plan, plus `sh`**, à la demande de l'utilisateur.
  - `isRunnable` garde son nom et son sens : vrai veut dire « montré dans l'explorateur, jamais ouvert ». Sa liste redevient celle du plan (`exe com bat cmd ps1 psm1 vbs vbe js jse wsf wsh msi msp msc scr pif cpl hta lnk url reg jar py pyw pyz appref-ms`), plus `sh`.
  - Pourquoi `sh` : sur ce PC, `.sh` (`sh_auto_file`, Git for Windows) s'ouvre dans `git-bash.exe` et s'exécute (relecture 1 de la correction).
  - Pourquoi pas plus : l'utilisateur a jugé excessives la liste d'Outlook et la liste blanche que la relecture proposait ensuite. Celle-ci a été écrite puis retirée avant tout commit.
  - Ce qui limite l'exposition : à partir de la tâche 4, « ouvrir avec l'application du système » n'est proposé que pour les images, les PDF et les formats que Cirrus ne sait pas afficher. Le texte, le code et les tableaux ne s'affichent jamais qu'à l'intérieur de Cirrus. Toute copie ouverte porte en outre la marque du web (I2).
  - Options :
    - la liste d'Outlook (correction 1) ;
    - une liste blanche de documents ;
    - la liste du plan plus `sh` (choix, décision de l'utilisateur).
  - Coût si faux : un type qui s'exécute à l'ouverture et manque à la liste (relevés par la relecture : `.pyc`, `.chm`, `.application`, `.vsto`, `.xaml`…) serait ouvert par son application, sur une copie marquée de la zone Internet.
- Ruling (Minor 2, prolongé) : **chaque échec d'`openFile` atteint l'utilisateur en français et nomme le fichier**, par `openFailure(name, e)`.
  - Une phrase par cause connue :
    - « Impossible d’ouvrir « nom » : le fichier manque dans la base. » (`ENOENT`) ;
    - « … : sa copie est encore ouverte dans une autre application. » (`EBUSY`) ;
    - « … : Windows refuse l’accès à sa copie. » (`EACCES`, `EPERM`) ;
    - « … : le disque est plein. » (`ENOSPC`) ;
    - « … : ce nom de fichier n’est pas permis. » (référence refusée par `openableCopy`, code `CIRRUS_REFUSED_NAME`) ;
    - « Windows n’a pas pu ouvrir « nom » : aucune application ne semble associée à ce type de fichier. » (échec de `shell.openPath`, qui rend une chaîne).
  - Toute autre erreur, y compris une référence malformée : « … : une erreur inattendue s’est produite. »
  - Aucun texte anglais n'atteint l'utilisateur : le gestionnaire IPC écrit la cause à la console.
  - Coût si faux : la formulation.

## Tâche 2 : logique des fichiers dans l'interface, base de test

### Mesures

- **Coût de `parseDelimited`** : 100 000 lignes de 8 colonnes, dont un champ entre guillemets avec point-virgule par ligne (5,3 millions de caractères), séparateur détecté. Meilleur de sept passes après deux d'échauffement, Node 26.13 de vitest : 45,5, 48,7 et 48,5 ms en trois lancements. **Plafond du test : 150 ms**, environ trois fois la mesure.
  - Variantes essayées sur le même texte, hors dépôt :
    - la prochaine occurrence du séparateur, de LF et de CR cherchée par `indexOf` et gardée : 59 ms ;
    - un simple `split('\r\n')` puis `split(';')`, sans guillemets : 55 ms ;
    - le seul balayage des caractères, sans rien allouer : 14 ms.
  - L'allocation des 800 000 chaînes et 100 000 tableaux domine. Le balayage caractère par caractère (`charCodeAt`) est gardé.
- Suite complète : 507 tests sur 507 (481 + 25 dans `fileLogic.test.ts` + 1 dans `build.test.ts`). `tsc` : `app` et `fixtures` sans erreur. Captures : 11 sur 11 à 0,000 % de `reference-3c` ; les fichiers ne se voient pas dans le graphe.

### Décisions

- Ruling: **`filesBuild` reçoit l'état** : `filesBuild(s: State, node: Id, incoming: FileRef[]): Build`, au lieu de `filesBuild(node, incoming)`.
  - Pourquoi : « null si tout est `unchanged` » demande les fichiers actuels du nœud, que la signature du plan ne donne pas. C'est l'usage de `pasteBuild(s, …)`, `lastPlanNodes(s, …)` et `dropMemberships(s, …)`.
  - La fusion est refaite sur l'état où l'action se calcule, car la session met les actions en file. Le même dépôt appliqué entre-temps, deux dépôts rapides du même fichier par exemple, y est refusé par `CommandError('Déjà à jour.')` : la session rend `{ ok: false, message: 'Déjà à jour.' }` et n'écrit rien.
  - Un nœud absent à la création ne donne pas null : l'action est refusée à son calcul, « Nœud introuvable. », comme `editNode` le fait.
  - Options :
    - l'état en premier (choix) ;
    - les fichiers actuels en troisième argument ;
    - la signature du plan, sans null, ce qui écrirait une action vide.
  - Coût si faux : la tâche 4 appelle `filesBuild(session.state, node, refs)`.
- Ruling: **libellé « Remplacer « nom » »** quand le seul changement du dépôt est un remplacement : rien d'ajouté, un seul remplacé, quel que soit le nombre de fichiers `unchanged` du même dépôt. Sinon « Ajouter des fichiers à « titre » », au pluriel, même pour un seul fichier ajouté (libellé du plan). Le nom est celui du fichier après le dépôt, dans la nouvelle orthographe.
  - Options : seulement pour un dépôt d'un seul fichier ; dès que le seul changement est un remplacement (choix).
  - Coût si faux : un libellé de l'historique.
- Ruling: **numéro d'un doublon du dépôt** : le second « a.txt » prend le premier « (n) », à partir de 2, qu'aucun fichier du dépôt ne porte, ni par son nom d'origine ni par un numéro déjà donné. Il fusionne ensuite comme les autres.
  - Exemple : [a.txt, A.txt, a (2).txt] donne « a.txt », « A (3).txt » (dans sa propre orthographe) et « a (2).txt ».
  - Le numéro va avant la dernière extension (« archive.tar (2).gz »). Un nom dont le seul point est en tête n'a pas d'extension (« .env (2) »).
  - Options :
    - sauter aussi les noms du nœud : rien n'est jamais remplacé, mais le même dépôt refait ajoute « (3) », « (4) »… ;
    - ne sauter que ceux du dépôt (choix) : le même dépôt refait ne change rien (testé).
  - Coût si faux : un « a (2).txt » sans rapport, déjà dans le nœud, serait remplacé par le second « a.txt » d'un dépôt. La notification dit « remplacé », Ctrl+Z le rend, et l'ancienne copie reste au magasin.
- Ruling: **`renameFileBuild` et `removeFileBuild` vérifient à l'exécution**.
  - Un fichier qui n'est plus là (exactement ce nom) est refusé : « « nom » n’est plus dans ce nœud. ».
  - Le renommage repasse par `checkFileName` sur l'état du moment ; un refus devient une `CommandError` avec le même message.
  - Renommer en exactement le même nom donne null. Changer la seule casse est permis.
  - Coût si faux : nul.
- Ruling: **`checkFileName`** refuse exactement ce que refuse `plainName` du principal (tâche 1), puis un nom déjà pris. Un nom permis ici se copie donc toujours pour l'application du système.
  - Messages, avec l'apostrophe typographique (tâche 1) :
    - « Le nom ne peut pas être vide. » ;
    - « Le caractère « : » n’est pas permis dans un nom de fichier. » : le caractère fautif est nommé ;
    - « Le nom ne peut pas contenir de caractère de contrôle. » ;
    - « Le nom ne peut pas finir par un point ou un espace. » ;
    - « « CON » est un nom réservé par Windows. » : le nom donné, extension comprise ;
    - « Ce nœud a déjà un fichier « Rapport.pdf ». » : le fichier qui gêne, dans son orthographe.
  - `except` désigne le fichier renommé par son nom exact, et non par `sameName`. Ainsi, dans un nœud qui aurait deux noms égaux au sens de `sameName` (données anciennes ou synchronisées), on ne peut pas renommer l'un en l'autre.
  - Coût si faux : la formulation.
- Ruling: **`formatSize`** :
  - une espace simple entre le nombre et l'unité, comme dans les exemples du plan ; l'interface y mettra `white-space: nowrap` ;
  - un arrondi qui atteint 1024 passe à l'unité suivante (1 048 575 o donne « 1,0 Mo ») ;
  - « To » est la dernière unité.
  - Coût si faux : nul.
- Ruling: **lecture de l'extension** dans l'interface : la même que celle du principal (après le dernier point, sans les points ni les espaces finaux), pour que le genre d'un fichier et le type sous lequel il est servi s'accordent. Les noms sans extension du plan se comparent sans la casse (`makefile` est du texte). Coût si faux : nul.
- Ruling: **`fileUrl` répète `cirrus-file`** au lieu d'importer `FILE_SCHEME`, car `main/files.ts` importe `node:fs` et n'entre pas dans l'interface. Le format est tenu par un test : `blobRequest` relit `fileUrl` d'un fichier de la base de test jusqu'à son chemin dans le magasin. Coût si faux : nul.
- Ruling: **`decodeText(bytes, truncated = false)`** : un second paramètre facultatif.
  - Pourquoi : `readHead` (tâche 5) coupe un fichier à son plafond, souvent au milieu d'un caractère UTF-8. L'UTF-8 strict échouerait alors, et tout le fichier s'afficherait en Windows-1252, illisible, contre le Review Focus 4.
  - Avec `truncated`, le décodage se fait en flux (`stream: true`) : le caractère coupé à la fin est laissé de côté, en UTF-8 comme en UTF-16.
  - Options :
    - rien, ce qui casse les lectures tronquées ;
    - le paramètre (choix) ;
    - toujours tolérer une fin coupée, ce qui ferait perdre son dernier caractère à un fichier Windows-1252 entier dont le seul octet accentué est le dernier (« Café »), lu comme UTF-8.
  - Coût si faux : la tâche 5 passe le `truncated` de `readHead`.
- Ruling: **BOM et binaires**.
  - Un BOM UTF-8 suivi d'un octet nul dans les 8 premiers Ko donne un binaire : seul un BOM UTF-16 exempte de ce test, dans l'ordre du plan.
  - Après un BOM, le décodage n'est pas strict : le BOM décide, et une séquence invalide y devient U+FFFD.
  - Coût si faux : nul.
- Ruling: **détection du séparateur**.
  - Chaque candidat (tabulation, point-virgule, virgule) est appliqué aux 20 premiers enregistrements avec ses propres règles de guillemets : un séparateur entre guillemets ne compte pas.
  - Son score est la part des enregistrements non vides qui ont son nombre le plus fréquent, si ce nombre n'est pas nul.
  - À égalité, l'ordre tabulation, point-virgule, virgule départage : une tabulation ou un point-virgule apparaît rarement dans une valeur, une virgule souvent (décimales françaises). Sans aucun candidat, la virgule.
  - `delimiterFor(name)` rend la tabulation pour un `.tsv`, et sinon `undefined` (séparateur détecté). La tâche 5 le passe à `parseDelimited`.
  - Coût si faux : un fichier sans en-tête qui aurait, sur chaque ligne, autant de points-virgules dans des valeurs que de virgules séparatrices serait lu au point-virgule.
- Ruling: **tolérance de `parseDelimited`**, pour qu'un fichier mal formé s'affiche au lieu d'échouer :
  - un guillemet jamais refermé prend tout le reste du texte ;
  - ce qui suit un guillemet fermant, jusqu'au séparateur, s'ajoute au champ ;
  - un guillemet au milieu d'un champ sans guillemets est un caractère ordinaire ;
  - un CR seul termine aussi un enregistrement (ancien Excel pour Mac) ;
  - une ligne vide est une ligne d'un champ vide, et le dernier saut de ligne n'en crée pas ;
  - `maxRows` compte la ligne d'en-tête ;
  - les sauts de ligne d'un champ restent tels quels.

  Coût si faux : nul.
- Ruling: **`ViewStates`**.
  - L'ancienneté est celle du dernier `set` : `get` ne rajeunit pas une entrée.
  - Le stockage reçoit un tableau JSON de paires `[empreinte, vue]`, la plus ancienne d'abord, réécrit en entier à chaque `set`. Les vues s'enregistrent donc quand on quitte une vue, pas à chaque défilement.
  - À la lecture, une entrée mal formée (pas un objet de nombres) est écartée, et un `max` plus petit qu'avant retire les plus anciennes.
  - Il faut une seule instance pour l'app : chacune lit le stockage une fois, à sa construction.
  - Coût si faux : au réglage maximal (5 000 entrées), environ 0,5 Mo de JSON écrit par `set`.
- Ruling: **base de test**.
  - `présentation.pptx` va au nœud « Chapitre 2 : compression et généralisation » (`theseOnly`, plan « Thèse »), qui reçoit ainsi une action de plus dans le journal de la base de test. Ses 22 octets forment une archive ZIP vide (le seul enregistrement de fin de répertoire central).
  - Le nœud MDL a quatre fichiers, et non six, sur décision du contrôleur : le plan comptait mal. Ce sont ses deux fichiers d'avant, plus le CSV et le `.md`.
  - `mesures_compression.csv` :
    - six colonnes et six lignes, CRLF, en octets Windows-1252 ;
    - en-tête « Éléments;Durée (s);Taux de compression;Méthode;Coût (€);Remarque » ;
    - virgules décimales, un champ entre guillemets qui contient un point-virgule, et `€`, `’` et `œ` (0x80, 0x92, 0x9C), des octets que Latin-1 n'a pas.
    - Il a été écrit par un script hors dépôt, dont le source n'est qu'ASCII : chaque octet est un échappement `\xNN`, passé par `Buffer.from(…, 'latin1')`. Le test des fixtures vérifie ses octets.
  - `notes_lecture.md` est en UTF-8 sans BOM, avec des fins de ligne LF.
  - Coût si faux : nul.
