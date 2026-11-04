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
