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
- Ruling: **extension d'un exécutable**, lue comme Windows la lit.
  - Les points et les espaces finaux tombent : « a.bat. » s'ouvrirait comme « a.bat ». Un nom qui n'est qu'une extension (« .lnk ») la porte.
  - La liste est fixe : une liste de sécurité n'est pas un réglage. Celle du plan a été remplacée à la correction 1 (I3 ci-dessous).
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
- Ruling: **messages d'`openFile`** (Minor 2 de la relecture, correction 1) : toujours « Impossible d’ouvrir le fichier : <raison> », par `openFailure`.
  - « il manque dans la base » pour un fichier absent du magasin, « nom de fichier refusé » pour une référence refusée.
  - Sinon, le texte anglais de Node ou de `shell.openPath` suit les deux-points.

  Coût si faux : la formulation.
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
- Ruling (I3, imposé par le plan): **liste des exécutables**.
  - Elle reprend la table de Microsoft « File types blocked in Outlook » (page « Blocked attachments in Outlook », support.microsoft.com/office/434752e1-02d3-4e90-9124-8b81e49a8519). La page ne parle plus de « Level 1 ». Elle a été lue le 2026-11-04 et compte 133 extensions, dont `pyc`, `pyzw`, `chm`, `application`, `scf`, `inf`, `xll`, `settingcontent-ms`, `iso` et `mht`.
  - S'y ajoutent les entrées du plan qui n'y sont pas, `psm1`, et les autres paquets d'applications : `msix`, `msixbundle`, `appxbundle`. `appref-ms` et `appx` y sont déjà.
  - Pourquoi : la liste du plan oubliait des types qui exécutent du code à l'ouverture. Une liste tenue par Microsoft est la référence habituelle, sans excès.
  - Option écartée : une liste blanche de documents, qui échoue fermée, mais bloque tout format légitime non listé et demande un entretien.
  - Coût si faux : un type de document inhabituel est montré dans l'explorateur au lieu d'être ouvert.
