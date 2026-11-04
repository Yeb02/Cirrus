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

## Tâche 3 : panneaux flottants et pop-up de nœud

### Mesures

- Suite complète : 518 tests sur 518 (507 + 10 dans `panels.test.ts` + 1 dans `params.test.ts`). `tsc` : `app` et `view` sans erreur.
- Captures, contre `reference-3c` : 10 sur 11 à 0,000 % ; `selection` à 5,609 % (85 378 pixels), le pop-up de MDL ouvert par son premier clic ; `popup-noeud` est nouvelle. `docs/captures/plan4a/` reçoit les 12. Une seconde suite, refaite de zéro, y est à 0,000 % sur les 12 (0 pixel) : les captures se répètent au pixel.
- Essai de l'app construite, hors dépôt : une base de test et un profil temporaires, un port de débogage, et des événements réels envoyés par CDP (`Input.dispatchMouseEvent`, `dispatchKeyEvent`, `insertText`). 34 vérifications passent, sans erreur ni avertissement dans la console de l'interface :
  - ouverture à droite et en dessous du clic, retournée en hauteur ;
  - déplacement par l'en-tête, agrandissement par le coin, bord droit arrêté à `panelMinPx`, en-tête gardé dans la fenêtre quand on le tire au-dehors, fenêtre réduite ;
  - épingler, le nouveau pop-up devant, Échap et clic sur le fond sans effet sur un épinglé, un seul pop-up par nœud, clic sur les onglets ;
  - titre (Entrée, Ctrl+Z hors du champ, Échap), résumé enregistré à la perte du focus, métadonnées relues ;
  - tags : remplacement d'une valeur, message de refus, suggestions au clavier et au clic, retrait, tags obligatoires en grisé puis remplis ;
  - Échap dans un champ, puis l'Échap suivant ; menu contextuel fermé par Échap sans fermer le pop-up ; déplacement de la vue sans fermer le pop-up ;
  - nœud supprimé partout pendant que son pop-up est épinglé : « Ce nœud n’existe plus. », puis son contenu revient après Ctrl+Z (Review Focus 5).

### Décisions

- Ruling: **clic hors des panneaux** — **remplacé à la correction 1** par la règle du plan, sur décision du contrôleur (ci-dessous). Il reste ici pour l'historique.
  - Dans le graphe, un clic sur le fond (avec ou sans Ctrl) appelle `onBackgroundClick`. Un clic sans Ctrl sur un nœud ou un groupe ouvre son pop-up, ce qui ferme les autres non épinglés.
  - Un Ctrl+clic sur un nœud, un clic sur une connexion, une amorce ou un fantôme laissent les panneaux. Un glissement de la vue ou d'un nœud n'est pas un clic : le pop-up reste.
  - Hors du graphe (onglets, réglages), un appui hors de tout panneau ferme les non épinglés, comme pour le menu contextuel et le pop-up de connexion.
  - Options :
    - tout appui hors des panneaux, graphe compris (l'idiome du menu) : déplacer la vue fermerait le pop-up ;
    - tout clic du graphe : le Ctrl+clic qui construit une sélection fermerait le pop-up qu'on lit ;
    - le choix, qui suit les deux props du plan.
  - Coût si faux : une ligne dans le `case 'click'` de `GraphView`. Conséquence : la capture `selection` garde le pop-up de MDL après le Ctrl+clic sur Solomonoff.
- Ruling: **Échap**.
  - `GraphView` prévient le défaut d'un Échap qu'il prend : un geste en cours (`gestures.busy`), une poignée tirée, son menu contextuel ou le pop-up d'une connexion ouverts.
  - Les champs d'un pop-up prennent le leur, et le panneau reste :
    - le titre rend sa valeur et se quitte ;
    - le résumé se quitte, donc s'enregistre comme à toute perte du focus ;
    - le champ des tags se vide, puis, vide, se quitte.

    L'Échap suivant ferme le panneau.
  - `Panels` écoute `keydown` sur `window`, en phase de bouillonnement, et ignore un événement dont `defaultPrevented` est vrai.
  - Options écartées :
    - le menu et le pop-up de connexion écoutant en capture et prévenant le défaut. Essayé puis retiré : l'Échap du champ « ajouter un nœud » du pop-up de connexion l'aurait fermé en entier ;
    - une vérification différée (`setTimeout`), indépendante de l'ordre des écouteurs, mais plus obscure.
  - Coût si faux : un Échap qui ferme deux choses. Une surcouche du graphe à venir devra s'ajouter à la condition.
- Ruling: **`HEADER_PX` vaut 32** : une constante de `geometry.ts`, la hauteur de `.panel > header` dans `styles.css`, et non un réglage. C'est une dimension de la feuille de style, comme ses marges. Coût si faux : un réglage, et la hauteur de l'en-tête lue dans le style.
- Ruling: **`clampRect` et `dragRect`**.
  - La taille va de `min` à celle de `bounds` ; `min` l'emporte dans une fenêtre minuscule.
  - L'en-tête est entier dans `bounds`, donc toute la largeur du panneau. En hauteur, le haut du panneau va du haut de `bounds` à `HEADER_PX` au-dessus du bas : le corps peut passer sous le bord.
  - Un bord tiré ne sort pas de `bounds` : l'agrandissement s'arrête au bord. Le geste part du rectangle du début et du déplacement total, sans cumul d'arrondis.
  - Une fenêtre réduite ramène chaque panneau par `clampRect`.
  - Options : n'en garder visible qu'une partie de l'en-tête, comme Windows ; l'en-tête entier (choix, la lecture littérale du plan).
  - Coût si faux : nul.
- Ruling: **`placeAt`** : de chaque côté, à `gap` du clic. Un panneau qui ne tient d'aucun côté va contre le bord qu'il dépasserait (dans les captures, les 460 pixels ne tiennent ni sous ni sur le clic de MDL : le pop-up est collé au bas). Plus grand que `bounds`, il est réduit à `bounds`. Coût si faux : nul.
- Ruling: **un nœud déjà ouvert** : son pop-up, épinglé ou non, passe devant là où il est, sans suivre le nouveau clic ; les autres non épinglés se ferment. Coût si faux : nul.
- Ruling: **profondeur** : un panneau mis devant prend la profondeur au-dessus de tous (la plus haute plus un), sans compteur global. Un panneau déjà devant ne change pas, et rien n'est redessiné. Coût si faux : nul.
- Ruling: **couche des panneaux** : `.panels`, `z-index: 15`, dans `.main`. Le menu « + » des onglets, oublié ici, passe au-dessus à la correction 1 (I2).
  - Elle passe au-dessus du graphe et de ses marques (coin de hiérarchie, infobulle, rectangle de sélection), sous les notifications (20), le fantôme d'un geste (25), le pop-up de connexion (28), les menus (30) et les questions (40).
  - Les panneaux sont en `position: fixed`, en pixels de la fenêtre (D7), et restent dans la zone sous les onglets : le rectangle de la couche.
  - `color-scheme: dark` y rend sombres la barre de défilement et les parties natives des champs.
  - Coût si faux : un `z-index`.
- Ruling: **glissement d'un panneau** : pendant le geste, seul le cadre suit le pointeur, par un état local de `FloatingPanel` ; son contenu n'est pas redessiné. La place s'écrit dans `Panels` au relâchement, ou à la perte de la capture du pointeur. Coût si faux : nul.
- Ruling: **`resolveTarget` trouve un fichier par `sameName`** : une nouvelle version déposée dans une autre casse garde son aperçu (Review Focus 1). Coût si faux : nul ; la tâche 5 en hérite.
- Ruling: **`parseTag`**.
  - Le texte est coupé au premier deux-points (une URL garde les siens), puis la clé et la valeur sont rognées.
  - Une clé du registre tient à son type :
    - un mot ne prend pas de valeur, et tout autre type en demande une ;
    - un nombre accepte la virgule, le point et les espaces, insécables comprises ;
    - une énumération se lit par son nom, ou par son rang écrit en chiffres ; un nom fait de chiffres reste un nom ;
    - une date ou un texte gardent la valeur telle quelle : le plan 4a ne lit pas les dates.
  - Une clé inconnue du registre est gardée telle quelle, mais « clé: » sans valeur est refusé.
  - Messages, avec l'apostrophe typographique (tâche 1) :
    - « Le tag est vide. » ;
    - « Il manque le nom du tag avant « : ». » ;
    - « Le tag « parallèle » ne prend pas de valeur. » ;
    - « Le tag « nature » demande une valeur : « nature:… ». » ;
    - « Il manque la valeur après « mot: ». » ;
    - « Le tag « partie » demande un nombre : « deux » n’en est pas un. » ;
    - celui de `normalizeTag` pour une valeur d'énumération inconnue, nom ou rang.
  - Coût si faux : la formulation ; une date mal écrite est acceptée.
- Ruling: **`withTag` et `withoutTag`**.
  - Une clé inconnue du registre prend une seule valeur, comme une clé déclarée simple. Un remplacement prend la place de l'ancienne valeur. Un tag déjà là rend la même liste : rien à écrire.
  - `withoutTag` retire exactement ce tag, cette valeur de sa clé.
  - Options : une clé inconnue multiple, ce qui garderait les deux valeurs d'une faute de frappe corrigée.
  - Coût si faux : la seconde valeur d'une clé non déclarée remplace la première ; il suffit de la déclarer multiple au registre.
- Ruling: **suggestions de tags** (`tagSuggestions`, pur, dans `tags.ts`).
  - Avant le deux-points : les clés de portée nœud (ou les deux) qui contiennent le texte, sans casse ni accents, celles qui commencent par lui d'abord, dans l'ordre du registre.
  - Après « clé: » : les valeurs de cette énumération, par rang, qui contiennent ce qui suit ou dont c'est le rang. Les autres types ne suggèrent rien.
  - Une clé choisie qui prend une valeur s'écrit dans le champ avec son deux-points, et ses valeurs s'affichent ; un mot s'ajoute. Flèches haut et bas, Entrée ou clic.
  - Leur nombre est un réglage, `tagSuggestions` (8, de 1 à 50, groupe « Pop-ups »), en plus des quatre du plan, par la règle des constantes réglables. Le pop-up de connexion garde son 8 d'avant.
  - Coût si faux : un réglage de trop.
- Ruling: **tag obligatoire absent** : sa pastille, grisée et en pointillés, montre la valeur par défaut. Un clic écrit « clé: » dans le champ et propose les valeurs ; le tag choisi est écrit et quitte le grisé. Coût si faux : nul.
- Ruling: **`tagsBuild` et `summaryBuild`** vont dans `actions.ts`, avec tous les `Build`, hors de la liste de fichiers du plan.
  - `tagsBuild` applique le changement sur l'état où l'action se calcule, pour que deux changements rapides comptent tous deux.
  - Il refuse un changement nul par « Ces tags sont déjà à jour. », plutôt que d'écrire une action vide (le même tag ajouté deux fois avant le premier enregistrement).
  - Coût si faux : nul.
- Ruling: **métadonnées**.
  - Les dates sont en français, date longue et heure (« 5 janvier 2026 à 10:09 »), au fuseau du PC ; « … » pendant la lecture, « — » sans historique.
  - L'historique se lit à l'ouverture. Il se relit après chaque action qui touche ce nœud (le `subjectOf` d'une de ses opérations : son enregistrement ou ses placements), annulations comprises, et quand plusieurs actions arrivent dans un même rendu.
  - Les connexions de connaissance comptées excluent celles de la corbeille. L'identifiant se sélectionne d'un clic (`user-select: all`).
  - Les genres s'affichent « image », « PDF », « LaTeX », « texte », « tableau », « autre ».
  - Coût si faux : un libellé.
- Ruling: **nœud disparu** : le corps dit « Ce nœud n’existe plus. », et l'en-tête garde le dernier titre vu, grisé. Le panneau reste où il était, et son contenu revient si la suppression est annulée (vérifié dans l'app). Coût si faux : nul.
- Ruling: **captures reproductibles**.
  - `captures.mjs` fixe les heures du journal de chaque base de test avant de lancer l'app : une action par minute, à partir du 5 janvier 2026 à 9 h UTC, dans l'ordre de leur écriture. Les dates d'un pop-up se lisent ainsi pareil à chaque capture.
  - L'identifiant d'un nœud, tiré au hasard à chaque construction de la base, porte la classe `volatile`. Le mode capture ne la dessine pas (`visibility: hidden`), et la mise en page ne change pas.
  - Options :
    - laisser varier : environ 0,1 % des pixels, sous la tolérance, mais « à regarder » à chaque comparaison, alors que la suite se répète au pixel ;
    - dater au jour seulement : varie encore d'un jour à l'autre ;
    - rendre la base de test déterministe : les identifiants viennent de `uuidv7`, dans le socle.
  - Coût si faux : une capture qui ne montre pas l'identifiant. Une capture qui fait une action, comme `import-noeud` à la tâche 4, aura « Modifié le » à l'heure de la capture : elle devra masquer ou fixer cette date à son tour.
- Ruling (imposé par le plan): **`selection` refaite** — **annulé à la correction 1** : le Ctrl+clic ferme désormais le pop-up, et `selection` retrouve `reference-3c` au pixel. Son premier clic, sur MDL, ouvre maintenant le pop-up du nœud ; le Ctrl+clic sur Solomonoff le laisse (premier `Ruling:` ci-dessus). L'image, regardée, ne diffère de `reference-3c` que par le pop-up, qui couvre le fantôme « Universalité algorithmique ». C'est la seule capture qui clique sur un nœud : `apercu-glissement` y appuie, mais glisse. Coût si faux : nul.
- Ruling: **référence des captures** — **remplacé à la correction 1**, sur décision du contrôleur (ci-dessous) : `docs/captures/plan4a/` reçoit toute la suite (12 images), dont `selection` refaite et `popup-noeud`.
  - Les dix autres sont identiques au pixel à `reference-3c`, qui reste telle quelle : la référence du plan 3c.
  - Pourquoi : `compare-captures` compte une image absente d'un côté comme un échec. Une référence complète se compare donc en une fois.
  - Options : refaire `selection` sur place dans `reference-3c` et ne mettre que les nouvelles dans `plan4a`, ce qui demande deux comparaisons dont chacune signale des absentes ; la suite complète (choix).
  - Coût si faux : déplacer `selection.png` dans `reference-3c` et retirer les dix doublons (1,4 Mo).
- Écart à la spec, imposé par le plan : un clic sur un fantôme n'ouvre aucun pop-up de nœud (« pas un fantôme »), alors que la spec 8.5 veut que le fantôme d'un nœud lointain ouvre le pop-up de ce nœud. Il suffirait d'appeler `onOpenNode(it.node, …)` pour un fantôme de genre `node`. À trancher par le contrôleur. **Tranché à la correction 1 : la spec l'emporte** (ci-dessous).

### Correction 1 (relecture de la tâche 3)

#### Mesures

- `panels.test.ts` : 13 tests sur 13. Les trois nouveaux (`closedIds`, `nodeOpenedBy`, `openingRect`) échouaient d'abord : les fonctions n'existaient pas.
- Suite complète : 521 tests sur 521 (518 + 3). `tsc` : `app` et `view` sans erreur.
- Essai dans l'app construite (même banc d'essai par CDP) : 41 vérifications sur 41, dont 7 nouvelles (I1 deux fois, I2, I3 deux fois, I4, Minor 9).
  - Sans le départ du champ avant la fermeture, les deux vérifications I1 échouent : le résumé et le titre tapés sont perdus. Le défaut que la relecture avait lu dans le code est ainsi reproduit.
  - Avec l'ancien `z-index: 10` du menu, la vérification I2 échoue : le point du menu est couvert par le panneau.
- Captures d'une suite neuve :
  - contre `reference-3c` : 11 sur 11 à 0 pixel, `selection` comprise ; `popup-noeud`, hors de cette référence, n'est pas comparée ;
  - contre `plan4a` : `popup-noeud` à 0 pixel, les onze autres hors de cette référence ;
  - `popup-noeud` refaite. Elle différait de 230 pixels (0,015 %), sa seule différence, regardée : le titre long s'arrête plus tôt dans l'en-tête, devant la zone de prise (Minor 9).
- `compare-captures` contre un dossier où manquent dix images de la référence : dix « absente », sortie 1. Le cas d'échec reste donc.
- Essai écarté : mettre la barre des onglets au-dessus de la couche (`.tabs { position: relative; z-index: 16 }`, la première solution de la relecture). Chaque capture différait alors de 258 pixels, et de 780 avec trois onglets : le contexte d'empilement de la barre change le lissage du texte de ses onglets.

#### Décisions

- Ruling (I1): **un champ en cours de saisie est quitté avant que son panneau ne se ferme**.
  - Toute fermeture passe par `apply(règle)` dans `Panels`. Si l'élément qui a le focus est dans un panneau que la règle ferme (`closedIds`, pur et testé), son `blur()` est appelé tout de suite, dans l'écouteur. Le champ s'enregistre donc comme à toute perte du focus, avant la fermeture.
  - Cela vaut pour toute fermeture : un appui hors des panneaux (onglets, roue, réglages), Échap, un nouveau pop-up, la croix, `closeLoose`.
  - Pourquoi : un appui natif ferme le panneau dans la micro-tâche qui suit son écouteur, avant que l'appui ne déplace le focus. Le champ disparaît alors avec le focus, et React n'envoie pas d'événement pendant un commit : `onBlur` ne venait jamais.
  - Options :
    - fermer sur `click` plutôt que sur `pointerdown` : le focus aurait bougé, mais l'idiome du menu changerait, et une fermeture par programme ne serait pas couverte ;
    - différer la fermeture après le `blur` ;
    - quitter le champ d'abord (choix, la première solution de la relecture).
  - Coût si faux : nul. Un tag tapé mais pas validé par Entrée n'est pas une modification : il part avec le panneau.
- Ruling (I2): **le menu « + » des onglets passe au-dessus des panneaux** : `.menu` passe de `z-index: 10` à 16, au-dessus de la couche (15). Le menu contextuel garde son 30 (`.context-menu`, déclaré après). La barre des onglets ne change pas : voir l'essai écarté ci-dessus. Coût si faux : nul.
- Ruling (I3, décision du contrôleur): **la règle du plan tient** : tout clic hors de tout panneau ferme les non épinglés.
  - Dans le graphe, `nodeOpenedBy` (pur et testé) dit quel pop-up un clic ouvre. Un clic qui n'en ouvre aucun appelle `onClickAway`, qui ferme les non épinglés : le fond, une connexion (qui ouvre alors son propre pop-up), une amorce, un fantôme absent ou de centre, un Ctrl+clic.
  - Un clic qui ouvre un pop-up ferme les autres non épinglés, et garde celui du nœud s'il est ouvert (`withNode`).
  - La prop `onBackgroundClick` du plan devient `onClickAway` : elle ne vaut plus pour le seul fond. `App` est son seul utilisateur. Coût si faux : un nom.
  - La capture `selection` retrouve `reference-3c` au pixel : son Ctrl+clic ferme le pop-up ouvert par son premier clic. Elle n'a pas à être refaite.
- Ruling (I4, décision du contrôleur, spec 8.5): **le fantôme d'un nœud lointain ouvre le pop-up de ce nœud**, comme l'original. Un fantôme absent garde son geste d'import, un fantôme de centre le pop-up de sa connexion (`nodeOpenedBy`). Coût si faux : une ligne.
- Ruling (décision du contrôleur): **`docs/captures/plan4a/` ne garde que les captures nouvelles du plan 4a**, aujourd'hui `popup-noeud`. Les onze autres en sont retirées. `reference-3c` reste inchangée, puisque `selection` n'y diffère plus.
  - `compare-captures <référence> <captures>` ne compare que les images de la référence. Une capture absente de la suite est un échec ; une capture de la suite absente de la référence est nommée, sans être comparée. Une suite complète se compare ainsi à chacun des deux dossiers.
  - Coût si faux : nul.
- Ruling (Minors 2, 3, 4, 5 et 9, décision du contrôleur):
  - **taille d'ouverture** : `openingRect` (pur et testé) ouvre le pop-up à `popupWidthPx × popupHeightPx`, jamais sous `panelMinPx`, et le garde dans la fenêtre par `clampRect` ;
  - **historique illisible** : « — » pour les deux dates et le nombre de modifications, plutôt que « … » sans fin. La cause va à la console ;
  - **modification refusée** :
    - `onEdit` rend une promesse, vraie quand l'action est écrite ;
    - refusés, le titre et le résumé reprennent la valeur du nœud ;
    - un tag refusé rend au champ le texte qui l'a demandé ;
    - le refus atteint la notification, comme pour toute modification ;
  - **glissement** : le rectangle où le panneau reste est lu une fois, à l'appui, et non à chaque mouvement du pointeur ;
  - **en-tête** : une zone de prise de 40 pixels au moins (`.drag`) sépare le titre des boutons ; un titre long s'arrête avant elle.

  Coût si faux : nul.

## Tâche 4 : fichiers du nœud — dépôt, réimport, renommage, retrait, ouverture par le système

### Mesures

- Suite complète : 532 tests sur 532 (521 + 11 : 2 dans `navigation.test.ts`, 6 dans `nodeFiles.test.ts`, 2 dans `session.test.ts`, 1 dans `actions.test.ts`). `tsc` : `app` sans erreur.
  - Avant le code : `navigation.test.ts`, `nodeFiles.test.ts` et `session.test.ts` échouaient, faute de `main/navigation.ts` et de `files/nodeFiles.ts`.
  - Le test d'`actions.test.ts` (un dépôt, un renommage, un retrait, chacun défait seul par `invertAction`) passait d'emblée : il porte sur les trois `Build` de la tâche 2.
- Captures, trois suites refaites de zéro :
  - contre `reference-3c` : 11 sur 11 à 0 pixel ;
  - contre `plan4a` avant sa mise à jour : `popup-noeud` à 132 pixels (0,009 %), refaite (ci-dessous) ;
  - `import-noeud` est nouvelle. D'une suite à l'autre, les 13 images sont identiques au pixel, `import-noeud` comprise ;
  - `plan4a` reçoit `popup-noeud` refaite et `import-noeud` : deux suites y sont à 0 pixel.
- Essai de l'app construite, hors dépôt : une base de test, un profil et un TEMP temporaires, un port de débogage. Le pilote envoie de vrais glissements de fichiers du système par CDP (`Input.dispatchDragEvent` avec des chemins du disque : `webUtils.getPathForFile`, la porte du preload et l'import du principal servent comme pour un dépôt de l'explorateur), et des souris et des touches réelles. 31 vérifications passent toutes aux quatre dernières passes, dont les deux dernières sur le code final ; les 30 autres passaient déjà aux trois passes d'avant le menu remonté :
  - dépôt sur MDL, notifié ; le même redéposé, « Déjà à jour. » ; une nouvelle version dans une autre casse remplace l'ancienne à sa place ;
  - sur le fond, la notice ; un dossier et un fichier au-delà de `maxImportMb` (1 Mo pour l'essai) refusés en une notification, l'autre fichier importé (Review Focus 2) ;
  - trois fichiers déposés ensemble, retirés tous trois par un seul Ctrl+Z, remis par Ctrl+Y ;
  - dépôt sur le pop-up, sur le résumé : ajouté, sans rien écrire dans le résumé, le panneau éclairé pendant le survol ;
  - lâché sur les onglets ou sur les réglages : rien n'est importé et la fenêtre reste sur l'app. Le principal ne voit passer aucune navigation : la garde de la page l'a arrêtée avant (Review Focus 2) ;
  - `location.href` d'un script vers un fichier : refusé par le principal (`will-navigate`) ; `window.open` : refusé ;
  - menus par genre ; Échap ferme le menu, pas le pop-up ; le menu du dernier fichier, au bas de la fenêtre, y reste entier ;
  - renommage : le nom sans l'extension choisi, un nom refusé gardé dans le champ avec sa raison, Échap, Entrée, un nom déjà pris refusé au départ du champ, Ctrl+Z ;
  - retrait, puis Ctrl+Z qui le remet à sa place ; la ligne d'un fichier sans vue (classe, infobulle, curseur) et son menu.
- Les 41 vérifications de la tâche 3 repassent sur l'app construite.
- Non essayé dans l'app : l'ouverture par le système (elle lancerait une application ou une fenêtre de l'explorateur sur le PC de l'utilisateur) et « Ajouter des fichiers… » (la boîte de dialogue du système est modale et ne se pilote pas par CDP). Leur message est testé par `openNotice` ; le chemin d'import est celui du dépôt.
- La toute première passe du pilote a vu la vue changer en cours d'essai : à partir du troisième dépôt, dépôts et clics sur MDL tombaient à côté. Ce n'est pas reproduit en huit passes. Une sonde montre qu'un glissement par CDP n'envoie aucun événement de pointeur à la page. La cause la plus probable est la souris réelle, au-dessus de la fenêtre, qui s'ouvre au premier plan.

### Décisions

- Ruling: **`importInto(node, paths, refused?)`**.
  - Le troisième paramètre, facultatif, porte les fichiers refusés avant l'import : un fichier déposé qui n'est pas sur le disque (`pathForFile` rend `''`, une image tirée d'un navigateur), avec la raison « pas un fichier du disque ». Ils rejoignent la notification des refus du principal. `onDropFiles` et `dropFilesAt` le portent aussi.
  - Options :
    - les ignorer : le dépôt ne ferait rien, sans un mot ;
    - les passer comme chemins : refusés « non déposé », ce qui est faux ;
    - le paramètre (choix).
  - Coût si faux : un paramètre.
- Ruling: **les notifications d'un dépôt** (`addImported`, `refusalNotice`, `dropNotice`, dans le nouveau module `files/nodeFiles.ts`).
  - Les refus en une seule : « 1 fichier non importé : x (c’est un dossier) », « 2 fichiers non importés : x (c’est un dossier), y (plus de 200 Mo) ». Les noms, sans guillemets, comme dans le plan.
  - Ce que le dépôt a fait, dans une seconde :
    - « « nom » remplacé », ou « 2 fichiers remplacés » ;
    - et, en plus du plan, les ajouts : « « a.txt » ajouté à « titre » », « 3 fichiers ajoutés à « titre » ». Sans elle, un dépôt sur le graphe n'aurait aucun effet visible : le graphe ne dessine pas les fichiers, et le pop-up peut être fermé ;
    - ajouts et remplacements ensemble, joints par « ; » ; les fichiers inchangés ne sont pas nommés.
  - Ce que le dépôt a fait est lu sur l'état où l'action se calcule (la même fusion que `filesBuild`), et non sur celui du dépôt.
  - « Déjà à jour. », avec son point : le texte du même refus à l'exécution (tâche 2), une constante, `UP_TO_DATE`, dans `actions.ts`. Le plan l'écrit sans point.
  - L'apostrophe est typographique, comme tous les textes depuis la tâche 1 : « l’y ajouter », « l’explorateur, sans l’ouvrir ». Le plan les écrit droites.
  - Options pour les ajouts : aucune notification (la lecture littérale) ; seulement pour un dépôt sur le graphe.
  - Coût si faux : une ligne par texte.
- Ruling: **le nœud qui reçoit un dépôt sur le graphe** : celui dont un clic au même point ouvrirait le pop-up (`nodeOpenedBy`).
  - C'est un nœud, un groupe, ou le nœud lointain d'un fantôme de bras scindé (spec 8.5, comme le pop-up).
  - Sur un fantôme absent ou de centre, une connexion, une amorce ou le fond, la notice dit « Dépose le fichier sur un nœud pour l’y ajouter. ».
  - Le pop-up d'une connexion et une question, posés sur le graphe, refusent le dépôt (curseur interdit) : il n'irait pas au nœud caché dessous.
  - Coût si faux : une ligne.
- Ruling: **le dépôt sur le pop-up** est pris partout sur le panneau (en-tête, résumé, tags, liste), et non sur la seule liste.
  - Le panneau s'éclaire pendant le survol (`.dropping`). Un dépôt sur le résumé n'y écrit rien.
  - `FloatingPanel` reçoit `onDropFiles`, facultatif : l'aperçu d'un fichier (tâche 5) ne le passera pas. Le pop-up d'un nœud disparu refuse le dépôt.
  - Options : la liste seule (la lecture littérale) : un dépôt juste à côté ne ferait rien.
  - Coût si faux : nul.
- Ruling: **la garde de la fenêtre** (Review Focus 2).
  - `App` ne prévient le défaut que d'un glissement de fichiers (`types` contient `Files`) que rien n'a pris, et met `dropEffect` à `none` : le curseur dit interdit, et rien n'est lâché. Un glissement de texte reste aux champs : déplacer un mot dans le résumé marche toujours.
  - Le principal refuse toute navigation hors de l'adresse de l'app (`navigationAllowed`), et répond `deny` à toute fenêtre.
  - `navigationAllowed` compare les deux adresses lues par `URL`, sans fragment. Une requête, une autre page du même serveur ou une adresse illisible sont refusées.
  - Options : prévenir tout `dragover` et tout `drop` (la lecture littérale) : le glisser-déposer de texte dans les champs cesserait.
  - Coût si faux : nul. Le principal arrête la navigation de toute façon.
- Ruling: **le menu d'un fichier**.
  - `ContextMenu` devient générique sur le type d'action : celui du graphe garde ses `MenuItem`, `fileMenu` donne celles d'un fichier.
  - Il est rendu dans le panneau, en `position: fixed`, aux coordonnées du clic. Le corps du pop-up défile et rogne ce qu'il contient. Hors du panneau, un appui sur le menu fermerait le pop-up (la règle du clic hors des panneaux).
  - Il reste dans la fenêtre : remonté et décalé à gauche de ce qu'il dépasserait. C'est le cas du dernier fichier d'un pop-up collé au bas de la fenêtre, comme le place `placeAt`. Cela vaut aussi pour le menu du graphe.
  - Son Échap est écouté en capture, défaut prévenu : il ne ferme que le menu, où que soit le focus. Le minor différé de la tâche 3 (l'Échap du menu du graphe, le focus hors du graphe) est réglé du même coup.
  - Coût si faux : nul.
- Ruling (décision du contrôleur): **« Ouvrir avec l’application du système »**.
  - Le menu ne l'offre que pour les genres image, PDF et autre (`fileMenu`). Le texte, le code, le LaTeX et les tableaux ne sont jamais confiés au système : Cirrus les affiche (tâche 5), et un script n'est donc jamais remis à Windows.
  - Un clic sur un fichier de genre autre l'ouvre ; un double-clic ne l'ouvre qu'une fois (son second clic, `detail` 2, est ignoré).
  - Le principal garde sa liste courte et montre un exécutable dans l'explorateur, avec la notification du plan.
  - Coût si faux : un genre de plus dans `TO_SYSTEM`.
- Ruling: **renommer**.
  - Le champ est en place, le nom sans son extension choisi, comme dans l'explorateur ; le nom tapé est rogné.
  - Entrée vérifie le nom par `checkFileName` : refusé, le champ reste ouvert, la raison sous la liste.
  - Quitter le champ garde le nom ; un refus arrive alors en notification, par `renameFileBuild` à l'exécution.
  - Échap abandonne, et le panneau reste.
  - Coût si faux : nul.
- Ruling: **« Retirer du nœud »** se fait sans question : une action, défaite par Ctrl+Z, et la copie reste au magasin. Coût si faux : une question.
- Ruling: **un nœud mis à la corbeille pendant un import** (l'import est asynchrone) : les fichiers y sont écrits, comme toute modification d'un nœud à la corbeille par `editNode`, et reviennent avec lui. Un nœud absent est refusé, « Nœud introuvable. ». Coût si faux : une condition.
- Ruling: **la capture `import-noeud`**.
  - `CIRRUS_IMPORT` passe par les options de lancement en mode capture seulement : un lancement ordinaire n'importe jamais rien dans la base de l'utilisateur.
  - Le preload ajoute ses chemins aux chemins déposés (décision du contrôleur). Après la première image, avant les clics et les touches, `App` appelle `dropFilesAt` du graphe par une poignée (`GraphHandle`). Le dépôt suit ensuite le chemin réel : `importInto`, `importFiles`, la porte du preload, le principal.
  - La scène : le clic sur MDL ouvre son pop-up, haut de 720 pixels (`popupHeightPx`, réglage de la scène) pour montrer la liste. Le fichier `données_importées.txt` est écrit dans un dossier temporaire, que `captures.mjs` crée puis retire. La notification de l'ajout est en haut.
  - « Modifié le » : une date de l'historique écrite depuis l'ouverture de la fenêtre porte la classe `volatile`, que le mode capture ne dessine pas, comme l'identifiant.
  - Options pour la date :
    - figer l'horloge du magasin en mode capture : une horloge à injecter dans `LocalStore`, hors des fichiers de la tâche ;
    - masquer toujours les dates : `popup-noeud` perdrait ses dates fixées ;
    - masquer les dates de la session (choix).
  - Coût si faux : la capture ne montre pas la date de l'import.
- Ruling: **`popup-noeud` refaite** : elle différait de 132 pixels (0,009 %, sous la tolérance). Seule différence, regardée : le pouce de la barre de défilement du pop-up est plus court, car le corps tient désormais le bouton « Ajouter des fichiers… ». Refaite pour que la référence reste au pixel. Coût si faux : nul.
- Ruling: **`OpenResult`**, la réponse de `cirrus:files:open`, est déclarée dans `main/files.ts`, et `env.d.ts` comme `nodeFiles.ts` la reprennent. Coût si faux : nul.
- Hors de la liste des fichiers du plan : `files/nodeFiles.ts` et son test, `nodeFiles.test.ts`, la logique pure du dépôt et du menu ; `actions.ts` (la constante `UP_TO_DATE`) ; `FloatingPanel.tsx`, `Panels.tsx` et `styles.css` ; `main/files.ts` (`OpenResult`) ; le preload et `env.d.ts`.

## Tâche 5 : vues des fichiers — images, texte et code, tableaux ; aperçus et plein écran

### Mesures

- Suite complète : 545 tests sur 545 (532 + 13 : 12 dans `viewers.test.ts`, 1 dans `params.test.ts`). Le test du menu de `nodeFiles.test.ts` suit « Ouvrir en plein écran ». `tsc` : `app` et `view` sans erreur.
  - Avant le code, `viewers.test.ts` échouait au chargement, faute de `files/read.ts`, et le test des réglages faute de `textViewMaxMb` (`undefined` au lieu de 32).
- CodeMirror 6, installé le 2026-11-04 par `npm install -w packages/app`, aux dernières versions stables, figées exactement dans `package.json` et par `package-lock.json` :
  - `@codemirror/state` 6.7.6, `view` 6.43.15, `language` 6.13.1, `language-data` 6.5.2, `search` 6.7.2, `commands` 6.11.1 ;
  - `@lezer/highlight` 1.2.5, pour `classHighlighter` (voir les couleurs ci-dessous).
  - 52 paquets ajoutés à `node_modules`, 9,1 Mo sur le disque, dont les langages de `language-data`. `npm audit` donne les 30 alertes d'avant, toutes de `msdf-bmfont-xml` (jimp, zod), un outil de développement ; aucune ne vient des nouveaux paquets.
- Ce que CodeMirror ajoute à l'interface construite (`out/renderer/assets`, code non minifié, comme toute la construction) :
  - le paquet de départ passe de 1 199 805 à 1 249 253 octets (+49 448). C'est le code des vues, des aperçus et du plein écran ; CodeMirror n'y est pas ;
  - CodeMirror a son propre morceau, `TextViewer-*.js` : 732 098 octets, lu au premier texte affiché ;
  - les langages forment 118 morceaux, 1 684 238 octets en tout, chacun lu à la demande : Python 54 932 octets, Markdown 85 692, LaTeX 5 633 ;
  - la feuille de style passe de 15 212 à 20 457 octets.
- Le travail d'une vue à son plafond par défaut, mesuré sous Node avec le même code, en trois passes. Il se fait une fois, à l'ouverture, sur le fil de l'interface :
  - un CSV de 16 Mo en Windows-1252 : décodé en 31 à 36 ms, analysé sur 100 000 lignes en 43 à 107 ms, largeurs des colonnes en 3 à 4 ms ;
  - un texte de 32 Mo en UTF-8 : décodé en 7 ms, `EditorState.create` en 41 à 47 ms, pour 383 826 lignes.
- Captures, trois suites neuves (A, B et C) :
  - contre `reference-3c` : 11 sur 11 à 0 pixel, à chaque suite ;
  - contre `plan4a` : `popup-noeud` et `import-noeud` à 0 pixel, à chaque suite ;
  - quatre nouvelles, prises de la suite B : `plein-ecran-code`, `plein-ecran-tableau`, `plein-ecran-image` et `apercu-fichier`. Les suites A et B sont identiques au pixel, 17 images sur 17, et C est à 0 pixel contre `plan4a`, 6 sur 6.
  - Regardées :
    - `plein-ecran-code` : le script coloré comme du Python, ses lignes numérotées, sans le bouton du système ;
    - `plein-ecran-tableau` : le CSV lisible (« Éléments », « Coût (€) », « l’œuvre d’une nuit »), en six colonnes ; la valeur entre guillemets « fenêtre de 32 Ko; dictionnaire figé » tient dans une seule cellule ;
    - `plein-ecran-image` : l'image de 32 × 32 pixels à sa taille, au centre, et le bouton du système dans l'en-tête ;
    - `apercu-fichier` : le pop-up de MDL et l'aperçu des notes à sa gauche, aligné sur son haut, le Markdown coloré, les lignes longues repliées.
- Essai de l'app construite par CDP. Le pilote, comme à la tâche 4, est hors dépôt, sur une base de test, un profil et un TEMP temporaires. Il envoie de vrais clics, double-clics, glissements, molettes et touches, et de vrais dépôts de fichiers. 43 vérifications sur 43 passent sur le code final :
  - vignette : l'image seule, `loading="lazy"`, `decoding="async"`, 64 pixels ;
  - un clic ouvre l'aperçu, à gauche du pop-up faute de place à droite, aligné sur son haut ; un autre fichier remplace l'aperçu non épinglé ;
  - un `.md` est replié, un `.py` ne l'est pas. Un script de 3 Mo, sous un plafond de 1 Mo pour l'essai, est lu par une seule requête `Range: bytes=0-1048575`, avec le bandeau « Seul le premier Mo est affiché. ». Moins de 300 lignes sont dans le DOM ;
  - un double-clic ouvre le plein écran. Il couvre toute la fenêtre, onglets compris, et donne le focus au texte. Ctrl+F ouvre la recherche en français, sans les champs de remplacement, et Entrée mène à l'occurrence. Le premier Échap ferme la recherche, le second le plein écran ;
  - en quittant le plein écran, le pop-up et l'aperçu non épinglés restent, et l'aperçu reprend la première ligne vue en plein écran. Le plein écran rouvert la reprend aussi ;
  - le menu d'un tableau n'offre pas le système. Un clic qui ferme le menu n'ouvre aucun aperçu, et le clic suivant si ;
  - un `.tex` est coloré ; « Ouvrir en plein écran » du menu montre le CSV de la base de test, accents lisibles ;
  - un grand tableau, sous des plafonds de 1 Mo et 1 000 lignes pour l'essai, montre les deux bandeaux. Moins de 60 lignes sont dans le DOM, et au défilement, celles de la vue ;
  - un binaire nommé `.txt` donne son message, sans bouton ;
  - une image de 2000 × 1000 pixels :
    - elle s'ajuste à 1584 × 792 ;
    - la molette zoome autour du curseur, le point visé restant sous lui au pixel près, et le glissement la déplace ;
    - le double-clic revient à l'ajustement, puis passe au 1:1 ;
    - les appuis dans le plein écran ne ferment pas le pop-up, et l'image se rouvre au 1:1 ;
  - un fichier renommé pendant son aperçu est suivi. Retiré, l'aperçu dit « Ce fichier n’est plus dans le nœud. », et Ctrl+Z le remet ;
  - une image déposée puis montrée en plein écran : Ctrl+Z défait son ajout, et le plein écran se ferme (Review Focus 5) ;
  - aucune requête ne part vers le réseau ;
  - la fenêtre est fermée pendant qu'un texte est en plein écran, puis l'app est relancée : le texte se rouvre à la première ligne vue en quittant.
  - Le défaut relevé à la relecture de la tâche 4 (Minor 5) est reproduit : sans la comparaison de l'appui, la vérification du clic qui ferme le menu échoue, l'aperçu s'ouvre.
  - Essai écarté : fermer la fenêtre par `window.close()` depuis la page. Le principal ne reçoit pas son événement `close` : ni l'instantané ni les vues ne sont enregistrés, et le pilote l'a d'abord pris pour un défaut. La croix de la fenêtre passe par `close` ; le pilote la reproduit par `BrowserWindow.close()`.

### Décisions

- Ruling: **CodeMirror dans un morceau à part, chargé au premier texte.**
  - `Viewer` charge `TextViewer.tsx` par `lazy(import())`, et `language.ts`, qui importe `@codemirror/language-data`, n'est importé que par lui. Le paquet de départ ne contient donc aucun code de CodeMirror. Chaque langage est un morceau de l'app, lu sur le disque par `file:`. Rien ne vient du réseau (vérifié ci-dessus), et la CSP ne change pas.
  - Options : CodeMirror dans le paquet de départ (environ 730 Ko de plus à lire au démarrage de chaque session) ; un morceau à part (choix).
  - Coût si faux : la première ouverture d'un texte attend le morceau, lu sur le disque local.
- Ruling (décision du contrôleur): **un binaire n'offre pas le système.**
  - Le plan demandait « Fichier binaire : ouvre-le avec l’application du système. », avec le bouton. Or un binaire ne s'affiche que pour un genre texte, code, LaTeX ou tableau, que la décision du contrôleur ne confie jamais au système. Le message devient « Fichier binaire : Cirrus ne peut pas l’afficher. », sans bouton.
  - Options : le bouton du plan, contre la décision ; le message du plan sans le bouton, qui dirait une chose impossible ; un message sans le bouton (choix).
  - Coût si faux : un bouton et une phrase.
- Ruling: **les bandeaux d'une lecture tronquée.**
  - « Seuls les N premiers Mo sont affichés. », N au format français ; pour 1 Mo, « Seul le premier Mo est affiché. ».
  - Un tableau coupé par `tableMaxRows` dit aussi « Seules les N premières lignes sont affichées. ». Sans ce bandeau, la coupure d'un CSV de 150 000 petites lignes resterait muette.
  - Un tableau lu jusqu'au plafond d'octets perd sa dernière ligne, probablement coupée, sauf si le plafond de lignes est venu avant.
  - Coût si faux : une phrase.
- Ruling: **une image ajustée n'est pas agrandie** (remplacé à la correction 1, ci-dessous : elle l'est jusqu'à 4 fois).
  - L'ajustement fait tenir l'image entière dans la vue, sans la grandir au-delà de sa taille : c'est l'usage des navigateurs et des visionneuses. Une image plus petite que la vue s'affiche donc à sa taille, et le double-clic n'y change rien.
  - Le zoom reste entre l'ajustement et `imageMaxZoom`. Le glissement garde l'image dans la vue : un axe que la vue contient en entier reste centré.
  - L'image est dessinée à sa taille zoomée, et non agrandie par une transformation, pour qu'un SVG reste net.
  - Options : agrandir toujours, ce qui rendrait floue une figure de 640 × 480 en plein écran ; jamais (choix par défaut) ; un réglage (`imageFitMaxZoom`, 1 par défaut).
  - Coût si faux : une valeur de réglage. La capture `plein-ecran-image` montre l'image de 32 pixels de la base de test à sa taille.
- Ruling: **six réglages de plus que le plan**, chaque constante étant un réglage :
  - groupe « Fichiers » :
    - `imageMaxZoom` : 32, entre 1 et 256, le zoom maximal d'une image ;
    - `imageFitMaxZoom` : 1, entre 1 et 32, l'agrandissement maximal de l'ajustement (remplacé à la correction 1 : 4 par défaut) ;
    - `tableColumnMaxPx` : 320, entre 60 et 2000, la largeur maximale d'une colonne ;
    - `tableMarginPx` : 240, entre 0 et 2000, la marge préparée autour de la vue d'un tableau, pour qu'un défilement ne montre pas d'abord des lignes vides ;
  - groupe « Pop-ups », à côté de la taille du pop-up :
    - `previewWidthPx` : 560, entre 200 et 1600 ;
    - `previewHeightPx` : 460, entre 160 et 1400. C'est la hauteur du pop-up, pour que les deux s'alignent.
  - Les sept réglages du plan prennent ses valeurs exactes.
  - Coût si faux : un réglage chacun.
- Ruling: **l'aperçu s'ouvre à côté du pop-up** (`placeBeside`, dans `geometry.ts`).
  - Il suit la règle de `placeAt`, mais pour toute la largeur du pop-up : à sa droite de `panelGapPx`, sinon à sa gauche. Faute de place des deux côtés, il va contre le bord du côté le plus large, et couvre ainsi le moins du pop-up. Il s'aligne sur le haut du pop-up et reste entier dans la fenêtre.
  - `placeAt` appliqué au coin du pop-up, la lettre du plan, mettrait l'aperçu sur le pop-up dès qu'il se retourne.
  - Coût si faux : nul.
- Ruling: **un aperçu non épinglé à la fois** (`withFile`). Un clic sur un autre fichier remplace l'aperçu non épinglé. Le pop-up et les panneaux épinglés restent. Un fichier déjà en aperçu passe devant, et n'en ouvre pas un second. Coût si faux : une règle.
- Ruling: **un aperçu et le plein écran suivent leur fichier** (`followTarget`, `followPanels`) (remplacé à la correction 1, ci-dessous : le fichier est trouvé par son nom seulement).
  - La cible d'un fichier garde son nom et, une fois trouvée, son empreinte (`PanelTarget.hash`, facultatif). `resolveTarget` cherche par le nom, puis par l'empreinte : un renommage est suivi, une nouvelle version aussi, et l'annulation de l'un ou de l'autre. La cible est ensuite ancrée sur le fichier trouvé.
  - Sans cela, renommer un fichier depuis son pop-up ferait dire à son aperçu que le fichier n'est plus là.
  - Le plein écran se ferme quand `followTarget` devient null (Review Focus 5) : fichier retiré, son ajout annulé, nœud supprimé. C'est la fonction pure testée, bâtie sur `resolveTarget`.
  - Limite : un fichier retiré dont le nœud garde un jumeau de même contenu, sous un autre nom, passe au jumeau, au lieu de se fermer. La vue montre alors le même contenu.
  - Coût si faux : la recherche par l'empreinte, une ligne.
- Ruling: **une seule vue par fichier, et le plein écran au-dessus de tout.**
  - Tant qu'un fichier est en plein écran, son aperçu laisse sa vue (`covered`). La vue du plein écran reprend donc là où l'aperçu en était, et l'aperçu là où le plein écran en est, sans deux vues qui écriraient chacune sa place.
  - Sous le plein écran, `Panels` ignore Échap et les appuis : ils sont au plein écran.
  - Le plein écran est au `z-index` 50, au-dessus des dialogues (40). Les notifications passent de 20 à 60, au-dessus de lui : un échec de « Ouvrir avec l’application du système » s'y lit. Elles ne recouvrent rien dans les captures (0 pixel).
  - Le plein écran prend le focus, pour que les touches ne passent pas au graphe, et le rend en se fermant.
  - Coût si faux : nul.
- Ruling: **Échap, Ctrl+F et Ctrl+Z dans un texte** (Ctrl+Z et le champ modifiable remplacés à la correction 1, ci-dessous).
  - Le raccourci Échap de CodeMirror (réduire la sélection) est retiré de son clavier par défaut : Échap ferme le plein écran ou l'aperçu non épinglé, même avec du texte choisi. Seule la recherche le garde pour se fermer, et le plein écran ne se ferme qu'au second Échap.
  - Le texte est un champ modifiable en lecture seule (`EditorState.readOnly`), comme le veut la recherche au clavier. Ctrl+Z et Ctrl+Y y restent donc au champ, comme dans tout champ (spec 6.4) : ils n'y font rien. Dans un tableau ou une image, ils défont et refont les actions de l'app.
  - Les textes de CodeMirror sont en français (`EditorState.phrases`) : la recherche, « aller à la ligne », le titre d'un caractère de contrôle.
  - Coût si faux : un raccourci.
- Ruling: **le double-clic.** Son premier clic ouvre l'aperçu, son double-clic le plein écran. En sortant du plein écran, on retrouve donc l'aperçu de ce fichier. Le double-clic ne choisit pas le nom au passage. Options : attendre le délai du double-clic avant d'ouvrir l'aperçu, ce qui retarderait chaque clic. Coût si faux : nul.
- Ruling (Minor 5 de la relecture de la tâche 4): **le clic qui ferme le menu ne fait rien d'autre** (remplacé à la correction 1, ci-dessous : avalé dans toute l'app).
  - `ContextMenu` passe à `onClose` l'appui qui l'a fermé. Le fichier compare cet appui à celui qu'il reçoit, le même événement natif, et ignore le clic qui suit (`fileClick`, testé). Le clic suivant agit.
  - Options : avaler le prochain clic de la fenêtre, qui risquait d'avaler un clic sans rapport après un glissement ; comparer l'événement (choix).
  - Le menu du graphe ne change pas.
  - Coût si faux : nul.
- Ruling: **« au même endroit ».**
  - Une instance de `ViewStates` pour l'app (`localStorage`, clé `cirrus.fileViews`, `max = viewStatesKept`), refaite seulement si ce réglage change.
  - Chaque vue garde sa place dans une référence à chaque défilement ou zoom. La place est écrite quand la vue est quittée, ou quand la fenêtre se ferme (`keepOpenViews`, dans `onQuit`), jamais à chaque défilement.
  - On garde, par empreinte : la première ligne vue du texte, le défilement du tableau, et pour l'image `{ fit: 1 }` ou son zoom et son centre. Une image ajustée s'ajuste de nouveau à la vue où elle se rouvre.
  - Une nouvelle version, d'une autre empreinte, s'ouvre au début.
  - Banc et captures ne gardent rien : une capture montre une vue comme elle s'ouvre, quoi qu'ait laissé une suite précédente dans leur profil.
  - Coût si faux : nul.
- Ruling: **les captures attendent les vues.**
  - `CIRRUS_CLICK` ouvre l'aperçu par `.file[data-name="…"]`, puis le plein écran par son ⤢ (`.file-preview .expand`) : un double-clic ne se simule pas par `.click()`.
  - `App` attend ensuite `viewsSettled()` avant `ready()`. Elle compte ce que les vues lisent ou chargent : le fichier, le morceau de CodeMirror, le langage, l'image.
  - Les quatre captures se répètent au pixel.
  - Coût si faux : nul.
- Ruling: **le tableau.**
  - Les lignes et les colonnes sont virtualisées, avec `tableMarginPx` de marge. L'en-tête et les numéros de ligne restent en vue (`position: sticky`). Les lignes de données sont numérotées à partir de 1.
  - Une colonne est aussi large que sa plus longue valeur, comptée en caractères puis mesurée par un canevas dans la police de la vue, l'en-tête en gras, plus le remplissage des cellules (`CELL_PAD_PX`, une dimension de la feuille de style), au plus `tableColumnMaxPx`. Le reste se coupe en « … ».
  - Une valeur sur plusieurs lignes s'affiche sur une seule.
  - Coût si faux : nul.
- Ruling: **les couleurs du texte** sont des classes (`classHighlighter` de `@lezer/highlight`, `.tok-*`), colorées dans `styles.css` aux tons de la palette, comme toutes les couleurs de l'interface. Elles ne sont pas des réglages : seules les couleurs du graphe le sont. Le thème de l'éditeur reprend les variables de la feuille de style. Coût si faux : un thème.
- Ruling: **le langage**, par `LanguageDescription.matchFilename`, l'extension lue sans la casse (« LISEZ-MOI.TXT »). Un carnet `.ipynb` est lu comme du JSON, que `language-data` ne relie pas à cette extension. Un `.tex` est coloré comme du LaTeX (`stex`). Le retour à la ligne vaut pour `txt`, `md` et `log`, comme le dit le plan : pas pour le `.tex`, que le plan 4b éditera. Coût si faux : une ligne.
- Ruling: **les vignettes** (remplacé à la correction 1, ci-dessous : plafonnées par `thumbMaxMb`) sont des `<img loading="lazy" decoding="async">` du fichier, comme le dit le plan. Une image visible dans la liste est donc lue en entier. La règle « ouvrir un pop-up ne lit aucun fichier entier » vaut pour les textes, les tableaux et les PDF, que le pop-up ne lit pas. Coût si faux : des vignettes faites par le principal.
- Ruling: **le PDF, en attendant la tâche 6** : son aperçu et son plein écran disent « Aperçu du PDF : à venir ». `Viewer` choisit la vue par genre ; la tâche 6 n'y remplace qu'une branche. Le plein écran d'un PDF offre déjà le système. Coût si faux : nul.
- Ruling: **`readHead`** lit le corps en flux et le lâche au plafond : même un serveur qui ignorerait la plage n'est pas lu au-delà. Un fichier absent du magasin (404) ou une réponse en erreur lève une `ReadError` en français, que la vue affiche. Coût si faux : nul.
- Hors de la liste des fichiers du plan :
  - `ui/viewers/views.ts` (la logique pure des vues), `ui/viewers/language.ts` (le langage, les textes français de CodeMirror) et `ui/viewers/common.tsx` (la place gardée, les messages) ;
  - `ui/ContextMenu.tsx` (l'appui qui ferme le menu) ;
  - `ui/panels/FloatingPanel.tsx` (`tools`, les boutons propres d'un panneau : le ⤢) et `ui/panels/geometry.ts` (`placeBeside`) ;
  - `files/nodeFiles.ts` (`offersSystem`, `fileClick`, `fileDoubleClick`, l'action `full`) et son test ;
  - `packages/view/tests/params.test.ts`.

### Correction 1 (relecture de la tâche 5)

Relecture : `task-5-review.md`, 0 Critique, 3 Importants, 8 Mineurs. Les décisions du contrôleur règlent les trois Importants, et les Mineurs 1, 4 et 5 sont repris dans cette correction.

#### Mesures

- Suite complète : 548 tests sur 548 (545 + 3 : le garde des clics, le tour de Tab du plein écran, le choix de la vignette). Le test du plein écran est réécrit sur `resolveTarget`, avec le jumeau. `tsc` : `app` et `view` sans erreur.
  - Avant le code : `viewers.test.ts` échouait au chargement, faute de `ui/clickGuard.ts`, et le test des réglages, `imageFitMaxZoom` valant 1 au lieu de 4.
  - Le défaut I1 est reproduit à 0cd21bd par un test jetable : le jumeau `copie_des_notes.md` présent, `notes_lecture.md` retiré, `followTarget` rend le jumeau au lieu de null.
- Captures, deux suites neuves (E et F) :
  - contre `reference-3c` : 11 sur 11 à 0 pixel ;
  - contre `plan4a` : seule `plein-ecran-image` change, de 1,061 % (16 145 pixels), l'image de 32 pixels étant désormais ajustée à 128 pixels. Regardée, puis refaite ;
  - la suite F est à 0 pixel contre `plan4a`, 6 sur 6. E et F sont identiques au pixel, 17 images sur 17.
- Le pilote par CDP passe 58 vérifications sur 58 sur le code final. Les 43 premières sont reprises, avec deux d'entre elles changées par les décisions : le renommage pendant un aperçu, et Ctrl+Z sous le plein écran. Les nouvelles vérifications :
  - une image au-delà de `thumbMaxMb` (1 Mo pour l'essai) montre l'icône de son genre, et aucune requête ne la lit ;
  - le texte en plein écran n'est pas modifiable mais reçoit le focus, et le plein écran porte `aria-modal` ;
  - le clic qui ferme le menu du graphe et tombe sur un fichier n'ouvre rien. De même pour le clic qui ferme le menu d'un fichier dans un pop-up épinglé et tombe sur un fichier d'un autre pop-up. Le clic suivant ouvre l'aperçu ;
  - renommé pendant son aperçu, un fichier n'est plus là. Retiré alors qu'un jumeau de même contenu reste, il n'est plus là non plus ;
  - Tab et Maj+Tab ne sortent jamais du plein écran, et Ctrl+Z n'y défait rien ;
  - une image absente du magasin dit « « absente.png » est introuvable dans la base. » ;
  - le morceau d'un langage retiré de l'app construite : le texte reste, sans couleurs, avec son bandeau ;
  - le morceau de la vue du texte retiré : un message dans la vue, la fenêtre et le pop-up restent, et une autre vue s'ouvre encore.
  - Contrôle : le garde des clics non installé, les trois vérifications du clic qui ferme un menu échouent, et l'aperçu s'ouvre à chaque fois.

#### Décisions

- Ruling (I1, décision du contrôleur): **un panneau de fichier trouve son fichier par son nom (`sameName`), jamais par son contenu.**
  - `PanelTarget` perd son empreinte, et `followTarget` et `followPanels` disparaissent. Le plein écran se ferme quand `resolveTarget` rend null.
  - Un fichier retiré ferme son plein écran, et son aperçu dit « Ce fichier n’est plus dans le nœud. », même si le nœud garde un jumeau de même contenu. Un fichier renommé aussi. Une nouvelle version, sous le même nom dans une autre casse, reste montrée.
  - Coût si faux : un fichier renommé ferme les vues qui le montrent.
- Ruling (I2, décision du contrôleur): **le clic qui ferme un menu contextuel est avalé dans toute l'app.**
  - `ui/clickGuard.ts` : `ClickGuard` est pur et testé. `guardClicks(window)` l'installe dans `App`, en capture sur la fenêtre.
  - `ContextMenu` lui donne l'appui qui l'a fermé. Le clic de cet appui est arrêté avant tout le reste, où qu'il tombe : un fichier, un bouton, un autre pop-up. Le double-clic dont le premier appui a fermé le menu est arrêté aussi.
  - Un clic du clavier ou d'un script (`detail` 0) passe toujours, et le clic d'un autre appui aussi : un appui qui a fermé un menu puis glissé ne retient rien.
  - Le menu du graphe y passe aussi. Les gestes du graphe vont par appui et relâchement, non par clic : ils ne changent pas, et `GraphView` n'est pas touché.
  - La comparaison propre à chaque pop-up (`closedBy`) disparaît, et `fileClick` perd son paramètre `dismissed`.
  - Coût si faux : nul.
- Ruling (I3, décision du contrôleur, imposé par le plan): **une vignette ne lit l'image que jusqu'à `thumbMaxMb`.**
  - `thumbMaxMb` vaut 4, entre 0 et 64, « Taille maximale d’une image pour sa vignette (Mo) », groupe « Fichiers ».
  - Au-delà, la ligne montre l'icône de son genre, à la même taille (`thumbFor`, testé).
  - La contrainte du plan se lit désormais « ouvrir un pop-up ne lit aucun fichier au-delà de `thumbMaxMb` ».
  - Coût si faux : une grande photo montre une icône dans le pop-up.
- Ruling (Mineur 1, décision du contrôleur): **« ajustée à la vue » comprend l'agrandissement.** `imageFitMaxZoom` vaut 4 par défaut. `plein-ecran-image` est refaite : l'image de 32 pixels s'y montre à 128. Coût si faux : une valeur de réglage.
- Ruling (Mineur 4, décision du contrôleur): **une vue qui échoue ne fait rien tomber.**
  - `Viewer` est entouré d'une frontière d'erreur. Un morceau qui ne se charge pas, ou une erreur de la vue, affiche « La vue de « nom » n’a pas pu s’ouvrir. » dans la vue ; la cause va à la console. La fenêtre, ses panneaux et les autres vues restent.
  - Un langage qui ne se charge pas laisse le texte montré, sans couleurs, avec son bandeau.
  - Une image qui ne se charge pas demande son premier octet (`readHead`). Absente du magasin, elle dit « « nom » est introuvable dans la base. ». Sinon, « Image illisible. ».
  - Les messages seuls d'une vue (lecture, PDF à venir, aucune vue) sont dans un cadre de vue, et ne recouvrent plus l'en-tête du plein écran.
  - Coût si faux : nul.
- Ruling (Mineur 5, décision du contrôleur): **le plein écran est modal.**
  - Il porte `aria-modal`. Tab y tourne en rond (`tabTarget`, testé), et un focus parti ailleurs y revient.
  - `App` ne fait pas Ctrl+Z ni Ctrl+Y sous lui. Suppr et les touches du graphe n'atteignent pas le graphe, dont le focus est hors du plein écran.
  - Le texte n'est plus un champ modifiable (`EditorView.editable.of(false)`), mais garde le focus par un `tabindex`. La recherche au clavier marche toujours (vérifié par le pilote).
  - Hors du plein écran, dans l'aperçu d'un texte, Ctrl+Z défait donc les actions de l'app, comme dans un tableau ou une image.
  - Coût si faux : on ne peut pas défaire une action depuis le plein écran.
- Mineurs non repris (décision du contrôleur) :
  - aucune capture ne montre de vignette, et les captures ne les attendent pas ;
  - `viewsSettled` n'attend pas une vue pas encore montée ;
  - la lecture répétée dans le texte et le tableau ;
  - le décodage sur le fil de l'interface ;
  - pas de test des composants.

### Correction 2 (relecture 1 de la correction 1)

Relecture : `task-5-rereview-1.md`. Les six points de la correction 1 sont réglés, et un nouvel Important est ouvert.

#### Mesures

- Avant le code, le nouveau test échoue. L'image de 32 pixels, ajustée à ×4, reste à ×4 au double-clic : « expected { zoom: 4, cx: 16, cy: 16 } to deeply equal { zoom: 1, cx: 16, cy: 16 } ».
- Suite complète : 549 tests sur 549 (548 + 1). `tsc` : `app` et `view` sans erreur.
- Captures, une suite neuve (G) : `reference-3c` 11 sur 11 et `plan4a` 6 sur 6 à 0 pixel. L'ajustement ne change pas, seule la borne basse du zoom change.
- Le pilote par CDP passe 62 vérifications sur 62, dont 4 nouvelles. Une image de 40 × 30 pixels en plein écran :
  - s'ajuste à ×4 ;
  - passe au 1:1 au double-clic, puis revient à l'ajustement ;
  - descend à la molette jusqu'à sa taille, pas plus bas.

#### Décisions

- Ruling (Important 1 de la relecture): **le zoom d'une image va du plus petit de l'ajustement et du 1:1 au plus grand de l'ajustement et de `imageMaxZoom`.**
  - Avec l'ajustement à ×4 (correction 1), la borne basse de l'ajustement rendait le double-clic du plan, « de l'ajustement au 1:1 », sans effet pour toute image que l'ajustement agrandit : un schéma, une petite figure. Elle empêchait aussi la molette de revenir à la taille de l'image.
  - Une image que l'ajustement réduit garde l'ajustement pour borne basse.
  - Coût si faux : une ligne.
- Le commentaire d'`ImageViewer` et la ligne `imageFitMaxZoom` du réglage de la tâche 5 disent désormais 4 (Mineur de la relecture).
