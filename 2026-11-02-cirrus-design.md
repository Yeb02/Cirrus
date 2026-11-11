# Cirrus : document de design (première version)

Date : 2026-11-02. Sources : `Spécification.txt`, notes de `Exigences.txt`, et la discussion de design du 31 octobre au 2 novembre 2026.

**Lecture.** Sauf mention contraire, chaque décision vient de l'utilisateur ou a été proposée puis acceptée explicitement. **[C]** marque un choix de Claude, non discuté ou accepté sans commentaire. Le constructeur peut revoir un [C] s'il a une bonne raison, mais il doit le signaler.

Ce document remplace la spécification là où ils divergent. Les écarts principaux sont signalés à leur place : pas de commit ni de push, et la règle de suppression depuis un plan.

Une maquette jetable de rendu est conservée dans `maquettes/faisceaux-v2.html`. L'utilisateur en a validé le rendu des groupes et des connexions. Seuls ses principes de calcul sont à reprendre : ce n'est pas une base de code.

---

## 1. Intention

Cirrus est un gestionnaire de connaissances personnel pour un chercheur en machine learning, seul utilisateur, qui travaille sur plusieurs PC.

L'information y est atomisée en nœuds reliés par des connexions, et se consulte dans un plan 2D au zoom fractal. Il y a un plan central, le lobby, et un nombre illimité de plans annexes qui montrent chacun une partie du graphe sous un angle choisi.

Le logiciel sert aussi à :
- assembler des publications LaTeX à partir des nœuds ;
- laisser des LLM consulter la base sans jamais la modifier ;
- faire tourner une veille bibliographique automatique dont l'utilisateur trie les résultats.

L'esthétique visée est éthérée et céleste, comme le nom Cirrus. Le résultat doit être « très pro » : ergonomie soignée, performances excellentes et rendu de grande qualité. Le graphe garde une forme stable dans le temps : rien ne bouge sans que l'utilisateur l'ait voulu.

## 2. Objectifs, non-objectifs, anti-objectifs

**Objectifs de la première version**
- Graphe de nœuds et de connexions multi-sources et multi-cibles, avec groupes imbriqués, dans un lobby et des plans, sur une seule application de bureau.
- Synchronisation permanente entre PC via un serveur, fonctionnement complet hors ligne, historique de toutes les éditions et annulation par Ctrl+Z et Ctrl+Y.
- Contenu des nœuds en LaTeX surtout, avec un aperçu compilé quasi instantané et des liens `\ref` et `\cite` entre nœuds.
- Assemblage de documents LaTeX exportables pour Overleaf.
- Serveur MCP en lecture seule pour Claude Code et ChatGPT.
- Veille par LLM avec journal de résultats à trier.
- Agenda, feuillets de notes, recherche instantanée, santé du graphe.

**Non-objectifs**
- Téléphone, tablette ou interaction tactile : l'app tourne sur PC (Windows, et Linux si c'est sans effort).
- Plusieurs utilisateurs, partage ou collaboration.
- Stockage de datasets ou de poids de modèles, jamais. Seuls les PDF sont volumineux.
- Aller-retour avec Overleaf : on exporte, puis on finalise ailleurs.
- Fenêtres hors de l'application.
- Exécution de code par un LLM.

**Anti-objectifs** (ce qui serait un échec même si tout fonctionne)
- Un nœud qui se déplace sans action de l'utilisateur : ni moteur physique, ni disposition automatique, ni « répulsion ».
- Un LLM capable de modifier la base.
- Un sur-dimensionnement : l'utilisateur veut des solutions sobres, sûres « sans être overkill ».
- Un rendu qui distrait : scintillement, animations gratuites.

## 3. Contraintes

- **Utilisateur :** il ne lira ni ne modifiera le code, qui est entièrement laissé aux agents. Il ajuste en revanche lui-même tous les paramètres graphiques dans l'app.
- **Framework :** il doit être mainstream (bien documenté, débogué, complet, bien connu des LLM), très performant et beau, avec relativement peu de code.
- **Serveur :** budget d'« une poignée d'euros » par mois, charge minime, quelques Go de stockage au départ.
- **Abonnements :** les conversations LLM consomment l'abonnement de l'utilisateur, pas l'API. Seule la veille utilise l'API.
- **Ordre de validation :** tout doit fonctionner en local avant de louer le serveur (`Exigences.txt`).
- **Tests :** une petite base artificielle contenant juste ce qu'il faut pour exercer chaque fonctionnalité (`Exigences.txt`).
- **Mise en service :** l'utilisateur saisira ses vraies données quand tout sera prêt, serveur loué compris. Le format peut donc évoluer librement jusque-là. Des ajustements continueront ensuite, par exemple sur les groupes, donc la lecture des anciennes bases s'impose dès la mise en service.
- **Machines :** le PC principal est un portable Lenovo avec une RTX 4070 Laptop, un Ryzen 7 7435HS, 16 Go de mémoire et un écran de 2560×1600 à 165 Hz. C'est le plus puissant. Un second PC, plus petit, a une carte graphique intégrée et fixe le plancher de performance. Il n'est pas disponible pour les mesures : on extrapole à partir du portable principal (section 21).
- **Structure du graphe** (utilisateur, 2026-11-02) : petit monde et sans échelle. Plus deux nœuds sont éloignés dans le graphe, moins il est probable qu'ils soient connectés.
- **Volume visé à terme :** quelques dizaines de milliers de nœuds, et environ dix fois plus de connexions. Seule une petite fraction est rendue à chaque instant : l'écran ne couvre qu'un sous-graphe, dont la plupart des nœuds sont dans des groupes repliés.
- **Compatibilité des données :** toute version ultérieure de l'app lit toute base plus ancienne. L'inverse n'est pas requis : l'app se met à jour d'office si le serveur l'exige, sans refus.
- **Format :** les données ne sont ni chiffrées ni obfusquées, au format type JSON. Leur lecture par une autre application n'a pas à être facilitée.
- **Code source :** il est hébergé sur le GitHub de l'utilisateur, avec une copie sur le serveur.

**Fixé par le plan 9** (section 18 pour le statut de ses décisions) :
- **la mise à jour d'office** est faite : une app plus ancienne que la version officielle, ou dont le serveur refuse le format, se met à jour seule ; depuis le 2026-11-11, elle est forcée : un écran bloque l'app pendant le téléchargement, puis l'app enregistre tout, se ferme, s'installe et se relance (section 18.1) ;
- **le code source** est le dépôt public `Yeb02/Cirrus`. Le serveur en garde un clone, au tag de la version qu'il sert (section 18) ;
- **la base de l'utilisateur ne bouge pas :** l'app installée garde son dossier, `%APPDATA%\@cirrus\app`, que ni une mise à jour ni une désinstallation ne touchent (section 18.1) ;
- **l'ordre de validation** est tenu : tout est prêt et vérifié sur ce PC, sans VM ni secret. Louer la VM et le domaine, créer la clé de signature et faire le premier déploiement reviennent à l'utilisateur (section 18).

## 4. Architecture et pile technique

**Pile retenue** (choisie par Claude sur délégation de l'utilisateur, qui l'a acceptée)
- **App de bureau :** Electron et TypeScript.
  - Rendu du graphe : un moteur WebGL 2 à nous, piloté par la carte graphique. Il remplace PixiJS, sur décision de l'utilisateur du 2026-11-03 (plan 3c) :
    - une texture des éléments (position, demi-tailles, cran, repli, style) est lue par des instances : boîtes, glyphes MSDF des titres, et courbes des connexions simples, calculées dans le vertex shader ;
    - le processeur prépare le reste, sans travailleur : les faisceaux complexes et leurs pointes, les enveloppes des groupes, les marqueurs des faisceaux, les anneaux (sélection, cible du dépôt, intrus) et le fond ;
    - un déplacement ou un aperçu réécrit quelques texels et quelques instances ;
    - la couche reste mince : un second moteur WebGPU reste possible.
  - Interface (panneaux, pop-ups, onglets) : React.
  - Éditeur .tex : CodeMirror 6. Depuis le plan 4a, il affiche aussi le texte et le code, en lecture seule. Depuis le plan 4b, il modifie les .tex, les résumés, les relations et le préambule, avec suggestions et diagnostics.
  - Lecture et annotation de PDF : PDF.js. Depuis le plan 4a, il tourne dans un lecteur à nous. Depuis le plan 4b, il dessine aussi les aperçus compilés, et depuis le plan 4c les surlignages des annotations (section 12). Il lit aussi, à l'import d'une publication, les premières pages d'un PDF déposé.
  - Octets des fichiers : un protocole `cirrus-file:`, servi par le principal (plan 4a).
- **Base locale :** SQLite, avec les entrées en JSON et les fichiers des nœuds tels quels sur le disque.
- **Serveur :** Node.js et TypeScript, SQLite et fichiers sur disque. Le serveur MCP utilise le SDK TypeScript officiel de MCP, la veille le SDK TypeScript d'Anthropic.
- **LaTeX :** pdfLaTeX via TinyTeX, installé après accord dans le dossier local de l'utilisateur, `%LOCALAPPDATA%\Cirrus\TinyTeX` (section 13).
- **Distribution :** installateur Windows et mises à jour automatiques servies par le serveur. Paquet Linux si c'est sans effort, ce qu'Electron permet en général.
- **Langage unique :** TypeScript partout. Le modèle de données et le protocole de synchro sont partagés entre l'app et le serveur.

**Écartés :**
- Tauri : il s'appuie sur le navigateur du système, moins fiable pour WebGL sous Linux, et ajoute Rust.
- Qt : trop de code pour cette interface.
- Flutter : écosystème plus mince pour l'éditeur et le PDF.
- Moteurs de jeu : faibles pour le texte et le PDF.

**Cloisonnement [C] :** le processus d'interface n'a aucun accès direct au système. Seul le processus principal touche aux fichiers, à SQLite, au réseau et à pdfLaTeX.

**Un seul état, avec un instantané en base (plan 3c) :**
- L'état vit en une seule copie, dans le processus d'interface : ses connexions, leurs membres et leurs branches en colonnes, le reste en objets. Les commandes s'y appliquent sur place, avec un retour arrière exact.
- Le principal ne garde aucun état. Il tient la base et valide chaque écriture par SQL : il relit la ligne courante et la compare à l'« avant » de chaque opération, et refuse l'action au premier écart.
- La base garde un instantané binaire de l'état, dans sa table `snapshot`, avec le numéro du journal qu'il couvre. Au chargement, le principal envoie cet instantané en un seul `ArrayBuffer` avec la fin du journal, que l'interface décode puis rejoue.
- Sans instantané utilisable (absent, d'une autre version, ou que l'interface ne peut ni décoder ni compléter par le journal), le principal reconstruit l'état depuis les tables et l'encode, sans le garder : c'est le chemin de secours. L'instantané refait remplace alors l'ancien.
- L'interface encode un nouvel instantané au repos, une fois un nombre d'actions atteint, et à la fermeture ; un instantané périmé au chargement est refait au repos. Elle l'envoie au principal, qui l'écrit : le cloisonnement tient.
- Les tables restent la source de vérité, avec le journal et l'historique par objet (section 6.3) ; l'instantané n'en est qu'un cache.

**Fichiers des nœuds (plan 4a) :** les décisions D1 à D7 du plan, que l'utilisateur a approuvé le 2026-11-04. Ce qu'elles donnent à l'usage est à la section 12.
- **D1, accès aux octets :** le principal sert son magasin de fichiers par le protocole `cirrus-file:`, en lecture seule, avec les plages HTTP. L'interface n'y lit que par `fetch`, `<img>` et pdf.js : ni `file:`, ni une IPC qui recopierait le fichier entier.
- **D2, PDF :** pdf.js dans un lecteur à nous, et non le lecteur de Chromium, pour avoir la sélection du texte, les liens de l'app et la page affichée. Un transport à nous lui fait lire le fichier par plages, car pdf.js lirait sinon tout un fichier servi par `cirrus-file:`.
- **D3, texte et code :** CodeMirror 6 en lecture seule, qui ne dessine que les lignes visibles. Il servira d'éditeur `.tex` au plan 4b.
- **D4, tableaux :** un analyseur à nous lit le CSV et le TSV dans l'app (RFC 4180, séparateur détecté). Les `.xlsx` et `.ods` s'ouvrent avec l'application du système.
- **D5, ouverture par le système :** l'application reçoit une copie en lecture seule dans `%TEMP%\cirrus-ouverts`, jamais le fichier du magasin. Un exécutable ou un script n'est jamais lancé ainsi (section 12).
- **D6, import :** le principal copie les fichiers dans le magasin avant qu'une action ne les référence. L'interface calcule l'action, comme toutes les autres.
- **D7, pop-ups :** des panneaux en coordonnées d'écran, communs à tous les onglets et non gardés d'une session à l'autre. Ancrés au nœud, ils suivraient la caméra et deviendraient illisibles au zoom.
- **Contraintes :** l'interface ne lit les octets d'un fichier que par `cirrus-file:`, et le principal n'y sert que les empreintes SHA-256 valides de son magasin. Rien n'est chargé du réseau : pdf.js, son travailleur, ses cartes de caractères et ses polices sont dans l'app. La politique de sécurité du contenu (CSP) n'ouvre `cirrus-file:` qu'aux images et aux lectures par `fetch`.

**LaTeX (plan 4b) :** les décisions D1 à D8 du plan, que l'utilisateur a approuvé le 2026-11-05. Ce qu'elles donnent à l'usage est aux sections 12 et 13.
- **TinyTeX :** il n'est pas dans l'installateur. Il se télécharge la première fois qu'il sert, après l'accord de l'utilisateur, dans `%LOCALAPPDATA%\Cirrus\TinyTeX` : le dossier itinérant (`%APPDATA%`) ne convient pas à 313 Mo de binaires. Toutes les adresses de téléchargement sont dans un seul module du principal (`LATEX_SOURCES`), que le serveur remplacera (section 18).
- **Compilation :** dans le principal, par des pdfLaTeX préparés d'avance. Seul le principal lance pdfLaTeX et `tlmgr`, et touche le réseau pour eux.
- **Cache :** les PDF compilés vont dans `<base>/latex/cache`, retrouvés par l'empreinte de tout ce qui entre dans la compilation, jamais synchronisés. L'interface les lit par `cirrus-file://latex/<empreinte>/<nom>`, comme les fichiers du magasin.
- **Registre des labels :** il est tenu par l'interface, qui a l'état. Le principal reste sans état : la requête de compilation porte les titres et les citations dont la source a besoin.

**Annotations et publications (plan 4c) :** les décisions D1 à D9 du plan, que l'utilisateur a approuvé le 2026-11-07. Ce qu'elles donnent à l'usage est à la section 12.
- **Annotations :** un nœud ordinaire qui porte un champ `anchor` (5.2). L'interface en tient un index par PDF et par version, dérivé de l'état comme le registre des labels. Il parcourt les nœuds à chaque changement de l'état, jamais à chaque image, et ne relit que les annotations changées : de 1,1 à 1,2 ms à 50 000 nœuds et 500 annotations [C].
- **Réseau :** seul le principal interroge le réseau pour une publication, par un module unique de sources (`PUBLICATION_SOURCES`, section 18), à la demande explicite de l'utilisateur.
- **Lecture :** le BibTeX et le CSL-JSON se lisent par du code à nous, sans dépendance. L'interface construit les nœuds, comme toutes les actions. Un `.bib` déposé ou choisi est lu par le principal, borné, puis décodé et analysé par l'interface ; les `.bib` des entrées sont écrits au magasin par lots [C].

**Synchronisation (plan 5a) :** les décisions D1 à D10 du plan, que l'utilisateur a approuvé le 2026-11-08. Ce qu'elles donnent à l'usage est à la section 6.6, le serveur à la section 18, les réglages partagés à la section 19.
- **D1, le serveur** est un paquet Node, `@cirrus/server`, qui reprend le cœur et le magasin des PC. Il garde la base de référence au format d'un PC (tables, journal et fichiers), plus `serveur.db` pour les PC jumelés, les codes de jumelage et les réglages. Il en tient aussi l'état en mémoire, comme un PC, et vérifie chaque action reçue comme une commande : elle ne peut pas ajouter de violation. Deux inclusions du même nœud dans deux groupes du même plan, faites en même temps sur deux PC, sont ainsi départagées, alors que chacune est juste seule. Il numérote les actions qu'il accepte et les relaie à tous les PC.
- **Le PC** écrit chaque action dans sa base tout de suite, comme avant. Elle reste « en attente » jusqu'à ce que le serveur la numérote. Le client de synchro, dans le principal, envoie les actions en attente et reçoit celles des autres PC. Il ne dépend pas d'Electron : le réseau, les secrets et l'horloge lui sont donnés, et les tests font tourner plusieurs PC dans un seul processus.
- **La réconciliation** se calcule dans l'interface, qui tient l'état : elle défait les actions en attente, applique celles du serveur, puis rejoue les siennes par-dessus, fusionnées (section 6.6). Le principal l'écrit en une transaction, en vérifiant chaque « avant », comme une action. Son coût suit les actions en attente et les enregistrements qu'elles touchent, jamais la taille de la base. Une action reçue sans rien en attente s'applique comme une action locale, par la mise à jour incrémentale de la scène.
- **D2, le transport :** HTTP, et un flux d'événements (`text/event-stream`) pour ce que le serveur pousse, qui reprend où il s'était arrêté (`Last-Event-ID`) après une coupure. Ni WebSocket, qui demanderait une dépendance au serveur, ni interrogation à intervalle. Aucune dépendance nouvelle : `node:http`, `node:sqlite` et `node:crypto` au serveur ; `net.fetch`, `safeStorage` et `powerMonitor` au PC.
- **D3, le jumelage par un code**, et **D10, les formats et les versions :** section 18.

**Suite de la synchronisation (plan 5b) :** les décisions D1 à D8 du plan (`docs/superpowers/plans/2026-11-09-cirrus-synchro-suite.md`). Il a été écrit et exécuté en travail autonome le 2026-11-09, sur la demande de l'utilisateur (« tu pourras continuer avec la suite du plan ») : ses décisions sont toutes de Claude, et l'utilisateur ne les a pas encore approuvées. Comme ailleurs, [C] marque en plus un choix fait pendant l'exécution ; le registre du plan (`docs/superpowers/plans/2026-11-09-cirrus-synchro-suite-registre.md`) en donne la raison et le coût. Ce qu'elles donnent à l'usage est aux sections 6.1, 6.2, 6.5, 12 et 13, le serveur à la section 18, les réglages à la section 19, l'état du serveur à la section 20.
- **La recompilation en arrière-plan** se décide dans l'interface, qui tient l'état et le registre des labels. Après chaque synchronisation, elle calcule les sources dont la demande de compilation a changé, et les envoie au principal, qui les compile une à une quand l'utilisateur ne compile rien (section 13).
- **Le réseau des publications** sort de l'app dans un paquet commun, `@cirrus/sources`, que le principal et le serveur importent. Il ne dépend que du cœur, et reçoit ses fonctions de réseau et de résolution des noms : les tests n'atteignent jamais Internet. Un PC jumelé et connecté demande l'import au serveur, qui garde le PDF dans son magasin. Sinon, le principal du PC le fait lui-même, comme au plan 4c (sections 12 et 18).
- **La présence des `.tex`** est une petite table de `serveur.db`, que chaque PC remplace par la liste de ses `.tex` ouverts (section 6.1).
- **La comparaison** d'un `.tex` et de sa copie de conflit est un plein écran fondé sur `@codemirror/merge` 6.12.3, l'extension de comparaison de CodeMirror 6, chargée à la demande (section 6.2). C'est la seule dépendance nouvelle. Le réseau ouvert prend `node:https`, `node:dns` et `net.BlockList`, sans dépendance.

**Les outils essentiels de la saisie (plan 6a) :** les décisions D1 à D6 du plan (`docs/superpowers/plans/2026-11-10-cirrus-outils-essentiels.md`). L'utilisateur a voulu le plan 6 coupé en deux, une partie légère tout de suite et l'autre plus tard ; le contenu de la partie légère est un choix de Claude. Le plan a été écrit le 2026-11-09 et exécuté en travail autonome le 2026-11-10 : ses décisions sont toutes de Claude, et l'utilisateur ne les a pas encore approuvées. Comme ailleurs, [C] marque en plus un choix fait pendant l'exécution ; le registre du plan (`docs/superpowers/plans/2026-11-10-cirrus-outils-essentiels-registre.md`) en donne la raison et le coût. Ce qu'elles donnent à l'usage est aux sections 5.4, 6.3, 7, 14, 19 et 20. Aucune dépendance nouvelle.
- **La recherche** est un index en mémoire, dans l'interface, et non la table FTS5 que la section 14 avait choisie [C]. Une table nouvelle changeait le schéma de la base (v5), que la synchro compare entre le serveur et chaque PC, alors que l'état est déjà tout entier dans l'interface. L'index est construit une fois au chargement, par tranches, dans les moments libres après la première image ; puis chaque action le met à jour par les seuls objets qu'elle touche, comme l'index des annotations. Il ne touche ni la base ni la synchro. Il est mesuré à la section 14.
- **Les sauts** passent par un seul mécanisme : la vue reçoit une cible (un nœud ou une connexion, dans un plan), ouvre le plan et cadre l'objet. La pile de « précédent » et « suivant » vit à côté de lui, dans la vue, qui connaît les caméras ; elle n'est gardée que pour la session [C].
- **Le registre des tags** gagne quatre commandes du cœur (section 5.4). Chacune est une action : un Ctrl+Z la défait, la synchro la transporte, et le serveur la vérifie comme les autres. La corbeille gagne de même `restoreConnection` (section 6.3).
- **Les consultations** s'écrivent dans un fichier à part, `consultations.db`, à côté de la base et hors de son schéma, qui reste v4. Elles ne sont pas synchronisées pour l'instant (section 20).
- **La fenêtre n'a plus de menu** (`Menu.setApplicationMenu(null)`) [C] : un Alt relâché après Alt+← aurait pu montrer la barre « Fichier Édition… », ce qu'un essai en arrière-plan ne pouvait pas vérifier. L'app construite perd ainsi le zoom de la page, le rechargement, les outils de développement, F11, Ctrl+W et Ctrl+M, dont elle ne se sert pas ; Ctrl+C, Ctrl+V, Ctrl+X, Ctrl+A et Ctrl+Z restent ceux de Chromium dans un champ. En développement seulement, Ctrl+R et Ctrl+Maj+I sont rendus. Reste à essayer par l'utilisateur, au premier plan : Alt+←, Alt+→ et un Alt seul ne doivent rien montrer.

**Bancs de mesure en tête de plan :** voir la section 21.

## 5. Modèle de données

### 5.1 Principe : objets uniques et vues par plan

Chaque nœud et chaque connexion existe une seule fois en base. Les plans, lobby compris, ne contiennent que des références, avec leur disposition propre.

Modifier le contenu d'un nœud ou d'une connexion depuis n'importe quel plan le modifie partout : titre, résumé, tags, fichiers, texte de relation, rôles. En revanche, la présence, la position, l'échelle, les branches visibles et l'appartenance aux groupes sont propres à chaque plan.

### 5.2 Nœud

- **Identifiant**, voir la section 6.
- **Titre :** texte Unicode simple, sans LaTeX pour commencer. Les symboles comme ≤, ∑ ou θ sont permis.
- **Résumé :** court texte LaTeX stocké dans la fiche, pas dans un fichier. Il est compilé par la même chaîne que les .tex (section 13) [C].
- **Tags :** voir 5.4.
- **Dossier :** une liste de fichiers à plat, sans sous-dossiers [C]. Par exemple `Enoncé_détaillé.tex` ou `calcul_mdl_séquence_aléatoire.py`. Les noms accentués sont attendus.
- **Copies, jamais de pointeurs :** les fichiers d'un nœud vivent dans le dossier de données de l'app. Importer un fichier, par exemple en le déposant, en fait une copie, et modifier l'original ensuite n'affecte pas la base. Les fichiers ne sont pas modifiés hors de Cirrus : il n'y a ni surveillance de dossiers ni prise en compte de modifications extérieures.
- **Ancre** (plan 4c, D1) : un nœud d'annotation porte un champ `anchor`. C'est un nœud ordinaire, qu'on renomme, résume, tague et pose comme les autres (section 12).
  - Il contient le nœud du PDF, le nom du fichier, l'empreinte de sa version, la page (à partir de 1), les rectangles du passage et le texte surligné.
  - Les rectangles sont dans les coordonnées de la page PDF : des points, l'axe y vers le haut, un rectangle par ligne.
  - L'empreinte désigne la version annotée, qui reste au magasin quand le fichier est réimporté (section 12). C'est une référence de fichier, comme le fichier d'un dossier (section 6.5).
  - Chaque enregistrement est vérifié avant d'être écrit : de 1 à 500 rectangles, au plus 20 000 caractères [C]. Le PDF n'est contrôlé qu'à la création : il peut ensuite aller à la corbeille, ou son fichier être remplacé.
  - Un nœud sans ancre n'a pas ce champ : une base plus ancienne s'ouvre sans changement, et l'instantané garde son format [C].
  - Son titre est le début du passage, `annotationTitleChars` caractères (80), puis « … ».

Exemple fourni par l'utilisateur : nœud « Minimum Description Length Principle (MDL) », avec pour résumé « Énonce que le meilleur modèle génératif d'un jeu de données est celui qui le compresse le plus ». Ses tags sont `statut_epistémique:consensus_scientifique` (rang 5), `pertinence:central` (rang 5), `nature:principe`, `théorie de l'information`, `algorithmie`, `axiome` et `provenance:externe`. Son dossier contient les deux fichiers cités plus haut.

### 5.3 Connexion

- **Titre court :** facultatif. Il est affiché discrètement près du marqueur.
- **Relation :** court texte LaTeX, affiché compilé dans le pop-up de la connexion (plan 4b). Elle peut définir des labels (5.4).
- **Tags.**
- **Membres :** des couples (nœud, rôle). Le rôle vaut **source** (flèche sortante du nœud), **cible** (flèche entrante) ou **associé** (simple point, relation sans direction pour ce nœud). Le rôle d'un nœud dans une connexion est global : il ne peut pas être source dans un plan et cible dans un autre [C, accepté].
- **Ensemble des membres :** c'est la réunion des branches de tous les plans (5.5). Pour le LLM et les documents, la connexion vaut cette réunion [C].
- **Taille :** une connexion peut relier plusieurs sources à plusieurs cibles. « A et B ensemble impliquent C » ne se réduit pas à A→C plus B→C.

Il existe deux sortes de connexions techniques :
- **Inclusion :** tag `inclus_dans_le_groupe`, sans texte. Le nœud membre est inclus dans le nœud groupe (section 10).
- **Structure :** tags `partie:X` (X entier) et `suivant`. Elles n'existent que dans les plans de type document (section 15).

La recherche, le MCP, les badges et la santé du graphe excluent les connexions de structure. Les connexions d'inclusion n'apparaissent que comme groupes [C].

### 5.4 Registre de tags et de labels

- **Clé :** chaque clé déclare son type, qui peut être mot simple, numérique, énumération ordonnée, date ou texte. Elle déclare aussi sa portée (nœud, connexion ou les deux), si elle accepte plusieurs valeurs (comme `auteur:X`, `auteur:Y`) et si elle est obligatoire, avec dans ce cas sa valeur par défaut.
- **Énumérations ordonnées :** le nom et le rang désignent la même valeur, donc `statut_epistémique:5` et `consensus_scientifique` sont équivalents. On peut ainsi filtrer « ≥ 3 » tout en lisant le nom.
- **Valeurs par défaut :** elles ne sont pas stockées. Ajouter plus tard une clé obligatoire ne touche donc aucun nœud, et la santé du graphe peut lister les valeurs jamais renseignées.
- **Renommage :** il est global, ce qui évite que `ml` et `machine-learning` coexistent.
- **Labels LaTeX :** leur registre est dérivé des `\label` des .tex, des résumés (une équation, par exemple) et des relations, et du tag `label`, qui donne un label au titre d'un nœud (`label: mdl`, un seul par nœud : `\ref{mdl}` désigne le nœud) (décision de l'utilisateur, 2026-11-05). Toutes ces sortes partagent un même registre, et chaque label est unique dans toute la base : un doublon apparaît en rouge (section 13).
- **Publications :** un nœud de publication porte les tags `auteur:…` (multivalué, `auteur:Anon` si inconnu) et `date_de_publication:…`. Il porte aussi sa clé BibTeX pour `\cite`, dans le tag `clé_bibtex` (`clé_bibtex: li2008`) [C, plan 4b : un tag plutôt qu'un champ dédié. Il se synchronise, se cherche et se modifie comme les autres, sans changer le modèle]. Une clé portée par deux nœuds apparaît en rouge, comme un label en double.
  - **Tags d'une publication importée** (plan 4c, D7) :
    - `auteur`, un par auteur, « Prénom Nom », au plus `publicationMaxAuthors` (50) [C]. Le `.bib` les garde tous. Sans auteur connu, l'import n'en met aucun [C] ;
    - `date_de_publication`, l'année ;
    - `clé_bibtex`, la clé de l'entrée (section 12) ;
    - `doi`, tel que donné, ou `arxiv`, l'identifiant sans sa version. Une entrée de `.bib` qui a les deux porte les deux [C].
  - `doi` et `arxiv` sont des clés de texte, à une valeur, comme `clé_bibtex`. L'import n'ajoute aucune clé au registre : une clé absente du registre est acceptée telle quelle [C].
  - **Le `.bib` est un fichier du dossier** (D7) : l'entrée BibTeX d'une publication est un fichier `<clé>.bib` de son nœud, et non un champ. Seul son nom est nettoyé de ce qu'un nom de fichier refuse (section 12) : la clé reste entière dans le tag et dans l'entrée. Elle se synchronise, se versionne et se lit comme les autres fichiers. C'est l'entrée réécrite par Cirrus, un champ par ligne, les macros `@string` de son fichier remplacées : elle se lit seule [C]. Le document (section 15) assemblera son `.bib` à partir de ces fichiers [C].

**Fixé par le plan 6a** (écrit le 2026-11-09 et exécuté en travail autonome le 2026-11-10 ; ses décisions sont de Claude, et l'utilisateur ne les a pas encore approuvées : section 4) : le registre des tags se tient depuis l'app (D4). [C] marque, comme plus haut, un choix fait pendant l'exécution ; le registre du plan (`docs/superpowers/plans/2026-11-10-cirrus-outils-essentiels-registre.md`) en donne la raison et le coût.
- **Quatre commandes du cœur,** une action chacune, qu'un Ctrl+Z défait :
  - `defineTagKey` crée une clé ou en change la définition ;
  - `renameTagKey` renomme une clé partout : sa définition, et chaque nœud et chaque connexion qui la porte, corbeille comprise. Un objet qui porte déjà la nouvelle clé garde, pour une clé à une valeur, la valeur de l'ancienne ; pour une clé multiple, les valeurs sont réunies sans doublon. Une clé non déclarée renommée en une clé déclarée passe sous sa définition, sans en écrire [C] ;
  - `deleteTagKey` retire une définition : ses tags restent sur les objets, comme une clé non déclarée ;
  - `renameEnumValue` renomme une valeur d'énumération, la réécrit sur chaque objet qui la porte, garde son rang et fait suivre la valeur par défaut. Un objet qui porte le rang n'est pas touché : il désigne toujours la valeur [C].
- **Les refus,** dans un message français :
  - un changement de type, de portée, de multiplicité ou de valeurs d'énumération qu'une valeur déjà portée ne respecterait plus, corbeille comprise. Le message compte les objets et nomme le premier : « 1 nœud porte … : « T ». », « N nœuds portent …, dont « T ». » [C]. Une connexion se nomme par son titre, sinon la première ligne de sa relation, sinon ses membres (« la connexion entre « A » et « B » ») [C] ;
  - un nom de clé vide, trop long (128 caractères), déjà pris par une autre définition, avec « : » ou une espace autour [C] ; une définition identique, une valeur d'énumération sans nom ou de rang non fini, deux noms ou deux rangs égaux, une valeur par défaut que la définition n'accepte pas [C] ;
  - une clé dont Cirrus se sert : `label`, `clé_bibtex`, `auteur`, `date_de_publication`, `doi`, `arxiv`, `partie` et `suivant`. Elle ne se renomme ni ne se supprime, et garde sa forme ; seuls son caractère obligatoire et sa valeur par défaut se changent. Créée dans le registre, elle prend la forme que Cirrus lui donne [C].
- **Les valeurs se jugent comme une saisie les lit** [C] : un mot sans valeur, tout autre type avec une ; un nombre, ou un texte qui se lit comme un nombre à la française ; une énumération, un nom ou un rang. Faute d'une règle des dates, une date accepte toute valeur, comme un texte. Rien n'est converti : un texte « 2024 » reste un texte sous une clé devenue numérique. Une saisie de tag lit désormais un rang décimal ou négatif (« niveau:2,5 ») [C].
- **La portée d'une clé** n'est pas jugée à la saisie d'un tag : les suggestions la respectent, et une définition qui la rétrécit est refusée tant qu'une valeur portée la viole [C].
- **Le panneau « Registre des tags »,** ouvert par « Registre des tags… », la dernière entrée du menu du fond :
  - il liste les clés déclarées, puis celles que des objets portent sans déclaration (« non déclarée »), chacune avec son type, sa portée et le nombre d'objets qui la portent, « dont n à la corbeille » [C]. L'ordre est celui des mots, sans casse ni accents [C]. Un champ filtre la liste ;
  - on y crée, modifie, renomme et supprime une clé, et on y édite les valeurs d'une énumération, nom et rang. L'enregistrement d'un formulaire est une seule action : les valeurs renommées, puis le reste de la définition [C]. Deux valeurs qui s'échangent leur nom sont refusées : « renomme-les une à une » [C] ;
  - une clé non déclarée se « Déclare » avec la définition que disent ses porteurs : un mot si aucun ne lui donne de valeur, un nombre si toutes se lisent comme tel, un texte sinon [C] ;
  - une clé de Cirrus montre sa forme sans la laisser changer, et n'a ni « Renommer… » ni « Supprimer » [C] ;
  - une définition changée ailleurs (une annulation, une synchro) remplace un formulaire qu'on n'a pas touché ; sinon un avis le dit, avec « Reprendre la définition actuelle » [C] ;
  - Échap le ferme, sauf si quelque chose de plus proche le prend d'abord : un champ, une question, un menu, la recherche, un pop-up [C]. Il s'ouvre à la place de la corbeille, et à côté des réglages [C].
- **Les tags d'une connexion :** son pop-up gagne la section « Tags » de celui d'un nœud, ses suggestions limitées aux clés de portée connexion ou les deux. Rien ne permettait de les modifier.
- **Avec la synchro** (6.6, D4), tout converge sans violation, testé sur un serveur et deux PC puis sur 2 000 commandes tirées au hasard [C]. Un renommage croisé avec un changement fait ailleurs peut rendre l'ancienne clé à un objet : le panneau la montre « non déclarée », et un second renommage la range. Croisé avec la mise à la corbeille, ailleurs, d'un objet qui la portait, l'objet revient avec la nouvelle clé : « la modification gagne » (6.2) [C]. Croisé avec le retrait de la définition, ailleurs, le retrait se perd [C]. Une annulation se vérifie désormais comme une commande : une écriture reçue entre-temps qui la rendrait fausse la fait refuser (« … a été modifié depuis. ») [C].
- **La borne d'un renommage** est celle d'une écriture, 64 Mio : de l'ordre de 100 000 objets porteurs. Au-delà, il est refusé avant toute écriture, et le message le dit [C].
- **Mesuré** sur 50 000 nœuds de trois tags chacun : la liste du panneau se calcule en 12 ms en médiane, à chaque action tant qu'il est ouvert [C].

### 5.5 Plan

- **Type :** lobby (un seul), plan ordinaire ou plan document.
- **Placements :** pour chaque nœud présent, une position (x, y) et un **cran d'échelle** entier k (section 8.1). Un nœud n'apparaît qu'une fois par plan.
- **Branches :** la liste des couples (connexion, nœud) affichés dans ce plan. Elle permet à une même connexion de montrer des nœuds différents selon le plan, grâce au choix « ici seulement » (section 11).
- **Disposition des connexions :** pour chaque connexion affichée, le marqueur, épinglé ou recalculé, l'angle du tronc, les poignées de Bézier de chaque branche et la position des amorces.
- **Inclusions :** les couples (nœud, groupe) valables dans ce plan, au plus un groupe direct par nœud.
- **Couleur des groupes :** propre au plan [C].
- **Plan document :** connexions de structure, fichiers retenus et titre de remplacement (section 15).

Un nœud ou une connexion créé dans un plan ordinaire est **exclusif** à ce plan tant qu'il n'est pas ajouté au lobby.

### 5.6 Autres données

- Préambule LaTeX global, versionné (section 13).
- Entrées d'agenda, feuillets, configuration et rapports de veille, journal (sections 16 et 17).
- Paramètres de l'app (section 19).
- Analytics (section 20).

## 6. Synchronisation, historique et annulation

L'outil de version est sans commit ni push, ce qui remplace la spécification.

### 6.1 Flux et rythme

- **Les flux** (plan 5a, D5) : le contenu, les connexions et la disposition passent par un seul flux ordonné, pour que l'ordre du serveur vaille pour tous. Chaque ligne du journal garde son flux (`flow`), que le MCP et les analytics liront [C]. Les analytics auront leur propre envoi, par lots (plan 6b ; le plan 6a les enregistre sur chaque PC, section 20). Tout se synchronise en permanence.
- **Écriture locale :** chaque changement est écrit tout de suite sur le disque, puis envoyé au serveur, qui le relaie aux autres PC ouverts.
- **Rythme** (plan 5a, D8) : chaque écriture part dès qu'elle est faite.
  - un déplacement en est une au relâchement de la souris ;
  - un .tex en est une à chaque enregistrement : après `texSaveIdleMs` (10 s) sans frappe, à Ctrl+S, et à la fermeture de son plein écran ou de la fenêtre (section 12). « Après 30 secondes sans frappe » est donc tenu au plus tard [C] ;
  - une sauvegarde locale a lieu toutes les quelques secondes, contre les plantages.
- **Veille du PC :** Windows ne laisse qu'environ deux secondes, avec `PBT_APMSUSPEND`. À l'annonce, l'app tente d'envoyer ce qui attend, pendant `syncSuspendFlushMs` (1,5 s), sans garantie. Au réveil, elle remet le voile « Synchronisation… » et reprend la connexion (plan 5a, D8).
- **.tex ouvert ailleurs** (fixé par le plan 5b, D6 ; section 4 pour le statut de ses décisions) :
  - **la présence :** chaque PC jumelé dit au serveur la liste des `.tex` qu'il a ouverts en plein écran (`PUT /presence`), dès que sa connexion est ouverte et à chaque changement, jamais hors d'elle [C]. Le serveur la garde dans `serveur.db`, par PC, et la remplace à chaque envoi. Un fichier encore ouvert garde son heure d'un envoi à l'autre [C]. Une révocation retire la liste du PC. Le serveur répond par les mêmes fichiers ouverts sur d'autres PC, le plus ancien d'abord ;
  - **l'avertissement :** ouvrir un `.tex` qu'un autre PC a ouvert l'annonce dans le bandeau du plein écran : « Ce .tex est ouvert sur « Portable » depuis 14h32 : sa dernière version y est peut-être restée. ». Le PC porte le nom que `jumeler` lui a donné, et l'heure est celle de ce PC ; un autre jour, la date est donnée aussi [C]. Hors ligne, rien n'est dit ;
  - **la fin :** fermer le plein écran, recharger la page ou fermer la fenêtre retire le `.tex` de la liste. À la fermeture de l'app, cet envoi est attendu `syncSuspendFlushMs` au plus [C]. Un PC qui s'arrête brutalement laisse son `.tex` « ouvert » jusqu'à son prochain branchement : l'avertissement dit « peut-être ». C'est le cas visé, un portable fermé avec un enregistrement en attente. Une liste refusée ou perdue n'est renvoyée qu'au changement ou à la connexion suivants ;
  - **options écartées :** un verrou, car un PC hors ligne bloquerait le fichier ; la présence par le flux d'événements seul, perdue à un redémarrage du serveur pendant que le PC qui l'a ouverte est hors ligne.
- **Un .tex changé ailleurs pendant qu'il est ouvert** (plan 5b, D6) : jusqu'au plan 5a, le plein écran ne relisait jamais le fichier, et son enregistrement suivant remplaçait la version arrivée, sans copie de conflit. Désormais :
  - s'il n'a rien de non enregistré, il charge la nouvelle version, et une notification le dit : « « x.tex » a été modifié sur un autre PC : sa nouvelle version est chargée. ». Elle est chargée hors de l'historique de l'éditeur, qui est vidé : un Ctrl+Z ne la défait jamais [C] ;
  - sinon, il garde le texte tapé, et le bandeau dit : « « x.tex » a aussi été modifié sur un autre PC : à l'enregistrement, cette version-là sera gardée sous « x (conflit du … ).tex ». ». L'enregistrement écrit le texte tapé sous le nom, et la version venue d'ailleurs sous le nom de conflit de la section 6.2, daté de l'heure de l'enregistrement, en une seule action [C]. La notification le dit : « « x.tex » a été modifié sur deux PC : l'autre version est gardée sous « x (conflit du 2026-11-09 14h32).tex ». » [C] ;
  - le choix se fait d'après la version dont le texte est parti, au moment où l'action est calculée : une version arrivée pendant l'écriture au magasin est gardée aussi [C]. Une version devenue binaire ou trop grande, rien n'étant tapé, s'affiche comme à l'ouverture. Une version illisible le dit, et le texte reste : un enregistrement fait de lui la garde à côté [C].
- **Démarrage** (plan 5a, D8) : le graphe s'affiche depuis la base locale, sous un voile « Synchronisation… » qui retient les actions. Le voile se lève quand le PC a rattrapé le serveur, ou après `syncConnectTimeoutMs` (4 s). À chaque branchement, le PC dit ses versions au serveur, qui refuse un format différent (section 18.1). Depuis le plan 9, ce refus lance la mise à jour d'office.
- **Hors ligne :** passé ce délai, l'app reste ouverte, hors ligne, et la pastille « Hors ligne » le dit dans la barre des onglets. Elle se reconnecte d'elle-même au retour du serveur, et ses actions partent alors (plan 5a, D8).

### 6.2 Identifiants et conflits

- **Identifiants :** les changements portent des entiers ordonnés. Le numéro définitif est attribué par le serveur à l'arrivée, car un PC hors ligne ne peut pas le connaître. Il commence à 1, et 0 veut dire « rien reçu » (plan 5a) [C]. Chaque PC retient le dernier numéro reçu (`last_server_seq`), ce qui suffit à reprendre le flux et à détecter une divergence.
- **Changements indépendants :** s'ils portent sur des objets ou des champs différents, ils s'appliquent tous les deux.
- **Même champ** (titre, tag, position…) : le plus récent gagne, selon l'heure de l'action, puis l'identifiant du PC en cas d'égalité, et l'autre reste dans l'historique (6.6, D4).
- **Même .tex :** les deux versions restent dans le dossier du nœud : la plus récente garde le nom, l'autre devient « nom (conflit du 2026-11-08 14h32).tex », et une notification le dit (6.6, D4). Depuis le plan 5b, elle nomme le nœud : « Un .tex de « Titre » a été modifié sur deux PC : l'autre version est gardée sous « … ». », « Sans titre » pour un nœud qui n'en a pas [C]. La comparaison, plus bas, les réconcilie.
- **Supprimé d'un côté, modifié de l'autre :** la modification gagne et l'objet revient.
- Il n'y a pas de fusion ligne à ligne : c'est l'utilisateur qui réconcilie, par la comparaison.
- **Comparer un .tex et sa copie de conflit** (fixé par le plan 5b, D7) :
  - **l'entrée :** dans la liste des fichiers du pop-up d'un nœud, la ligne d'une copie de conflit offre un bouton « Comparer », si son original est un `.tex` du même nœud, reconnu par son nom (« (2) » compris, la casse et la forme Unicode comptant comme partout) [C]. Un original renommé ou retiré, un fichier qui n'est pas un `.tex` : pas de bouton ;
  - **le plein écran :** modal, comme celui du préambule. À gauche l'original, modifiable ; à droite la copie, en lecture seule ; au-dessus de chaque côté, « Original, modifiable » et « Copie de conflit, lecture seule » [C]. L'en-tête dit « Comparer « note.tex » et « note (conflit du … ).tex » ». Les blocs qui diffèrent sont colorés, une flèche par bloc reprend celui de la copie dans l'original, et les parties identiques sont repliées : `compareContextLines` (3) lignes gardées autour d'un bloc, à partir de `compareFoldMinLines` (4) lignes [C]. Les deux textes sont décodés comme dans le plein écran d'un `.tex` (CRLF, Windows-1252) ;
  - **les boutons :** « Enregistrer » écrit l'original, en une action, « Réconcilier « x.tex » ». « Enregistrer et retirer la copie » fait de même et retire aussi la copie du dossier, dans la même action ; la copie reste dans l'historique et dans le magasin. Les deux ferment la comparaison ; « Enregistrer » sans rien de repris la ferme sans rien écrire [C]. Ctrl+S est « Enregistrer ». Échap ou × avec des changements demandent « Abandonner la réconciliation ? », « Annuler » ayant le focus. La fenêtre fermée pendant une comparaison enregistre ce qui a été repris, comme « Enregistrer » [C] ;
  - **pendant la comparaison :** un original changé ailleurs suit la règle du `.tex` ouvert (6.1). Rien n'étant repris, il est rechargé à gauche et dit ; sinon, il est gardé sous son nom de conflit à l'enregistrement. Une copie changée ailleurs est relue à droite, et dite : « La copie « … » a changé sur un autre PC : sa nouvelle version est montrée. ». « Enregistrer et retirer la copie » ne retire que la copie montrée, reconnue à son empreinte : une copie changée entre-temps reste, et une notification le dit [C] ;
  - **les limites :** un fichier de plus de `textViewMaxMb` ne se compare pas, jugé sur sa taille avant toute lecture : « Trop grand pour être comparé ici. » [C]. Un binaire dit « Fichier binaire : Cirrus ne peut pas l'afficher. ». Une nouvelle version de l'original trop grande, arrivée pendant la comparaison, est gardée sans être montrée, et une notification le dit [C]. La comparaison de fichiers de plusieurs Mo n'a pas été mesurée ;
  - **option écartée :** une comparaison à nous, Myers ou par lignes, soit plus de code pour un résultat moins bon.

### 6.3 Historique

- **Contenu :** toutes les éditions entrent dans l'historique, déplacements et changements d'échelle compris.
- **Historique par nœud :** on peut consulter les versions et restaurer un nœud seul. Une vue des différences textuelles est fournie.
- **Corbeille :** un objet retiré de son dernier plan y va, sauf une annotation (section 7).
- **Copies :** l'historique complet est conservé sur chaque PC.
- **Poids de l'historique :** une fenêtre à part dans le menu principal, d'usage très exceptionnel, par exemple pour un PDF sur lequel l'utilisateur s'est ravisé. Elle affiche le poids par nœud et par type, et permet de supprimer un contenu en gardant la trace de son existence : nom, date et taille. Une restauration affiche alors « contenu supprimé ».
- **Plus tard :** un curseur temporel en lecture seule.

**Fixé par le plan 6a** (écrit le 2026-11-09 et exécuté en travail autonome le 2026-11-10 ; ses décisions sont de Claude, et l'utilisateur ne les a pas encore approuvées : section 4) : la corbeille se voit, et ses objets se restaurent un à un (D5). [C] marque, comme plus haut, un choix fait pendant l'exécution ; le registre du plan en donne la raison et le coût. La restauration dans les plans est à la section 7.
- **Le panneau « Corbeille »,** ouvert par « Corbeille… » dans le menu du fond, juste avant « Registre des tags… » [C] :
  - il liste les nœuds, les annotations et les connexions de connaissance jetés, du plus récent au plus ancien, chacun avec son genre (« nœud », « annotation », « connexion ») et sa date courte, « 10/11/2026 10:05 ». Au même instant, un nœud passe avant les connexions que sa suppression a emportées [C] ;
  - une connexion se nomme comme dans les refus du registre (5.4) : son titre, sa relation, sinon ses membres [C]. Un lien de groupe ou de structure n'y est pas : c'est une appartenance ou la machinerie d'un document [C] ;
  - un champ filtre par le titre, sans casse ni accents ;
  - la liste n'a pas de plafond : chaque ligne n'est redessinée que si ce qu'elle montre change [C]. Sur la base de référence, 1 000 nœuds et 1 000 connexions à la corbeille, elle se lit en 3,5 ms [C] ;
  - le panneau reste ouvert après une restauration, pour la suivante ; il s'ouvre à la place du registre des tags, et Échap le ferme de même, même avec un pop-up épinglé à l'écran ou la recherche ouverte sans le focus, qui ne prennent pas cet Échap [C] ;
  - « Restaurer » est éteint, sa raison pour titre, sur une connexion qui n'a plus que moins de deux nœuds : « Il reste moins de deux nœuds à cette connexion : elle ne peut pas revenir. » ; la ligne reste listée [C] ;
  - une connexion restaurée que nul plan ne montre le dit : « Connexion restaurée ; aucun plan ne réunit deux de ses nœuds. » [C] ;
  - fermer le panneau, par la croix ou par Échap, abandonne la pose d'un nœud en cours, non un autre geste [C] ;
  - une ligne périmée — le nœud n'est plus à la corbeille (un Ctrl+Z, une synchro) —, est refusée avant tout fantôme : « Ce nœud n’est pas à la corbeille. » [C].
- **Vider la corbeille :** rien ne se vide. La suppression d'un contenu passera par « Poids de l'historique », au plan 6b.
- **Hors du plan 6a :** l'historique par nœud (versions, restauration, différences), « Poids de l'historique » et le curseur temporel (section 24).

### 6.4 Annulation (Ctrl+Z, Ctrl+Y)

- **Mécanisme :** toute action d'édition s'annule. L'annulation ajoute à l'historique une modification inverse sans rien effacer, car le changement est peut-être déjà sur le serveur [C, non contesté].
- **Granularité :** une action compte pour un pas. Un déplacement complet ou une répercussion sur plusieurs plans, placements manuels compris, forment chacun un seul pas.
- **Pile :** une seule pile pour toute l'app, pas une par plan, vidée à la fermeture [C, non contesté]. Si le pas annulé touche un plan que l'utilisateur ne regarde pas, une notification le nomme.
- **Texte :** dans un champ de texte ou l'éditeur .tex, Ctrl+Z agit sur le texte.
- **Exclus :** la caméra, la sélection et les paramètres ne sont pas annulables.

### 6.5 Fichiers volumineux

- **Stockage :** le serveur détient tous les PDF. Un PC télécharge un PDF depuis le serveur à la première lecture, puis le garde (plan 5a, D6). Il ne va jamais le chercher à son URL d'origine.
- **« Tout télécharger »** (fixé par le plan 5b, D8) : une action rare, par PC, dans le bloc « Serveur » d'un PC jumelé (section 19). C'est une action, et non un réglage : elle vaut pour ce PC seul, alors que les réglages sont partagés.
  - « Télécharger tous les PDF… » compte les PDF que la base référence aujourd'hui et qui manquent sur ce PC, avec leur volume, d'après les tailles des références. Ce sont ceux des dossiers des nœuds hors de la corbeille [C], et les versions des ancres des annotations vivantes dont le PDF n'est pas à la corbeille ; jamais une version que seul l'historique garde. La version d'une ancre que plus aucun dossier ne tient compte pour la taille du fichier de même nom de son nœud [C]. Puis il demande : « 37 PDF à télécharger, 1,2 Go ; 48,0 Go libres sur ce disque. », avec « Télécharger » et « Annuler ». Tout y étant : « Tous les PDF de la base sont déjà sur ce PC. » [C] ;
  - un volume qui laisserait moins de `downloadAllReserveMb` (1 024 Mo) libres est refusé : « Pas assez de place : 1,2 Go à télécharger, 0,8 Go libres. ». Quand seule la réserve manque, la phrase la nomme, et dit où la régler [C] ;
  - le téléchargement passe par la file de la synchro, `syncDownloads` à la fois avec ses autres téléchargements [C], chaque fichier vérifié par son empreinte. Le bloc dit l'avancement, au plus toutes les 200 ms (« 12 PDF sur 37, 340 Mo sur 1,2 Go »), et offre « Arrêter » ;
  - il s'arrête au premier fichier que le réseau perd ou que le serveur refuse (5xx, 401, 403) : « Serveur perdu : téléchargement arrêté à 12 PDF sur 37. ». Il s'arrête aussi au premier que le disque de ce PC refuse, et le dit. Un fichier absent du serveur ou abîmé compte comme « n'a pas pu l'être », et la suite continue [C]. Rien de partiel n'entre au magasin ;
  - il n'est pas repris au démarrage suivant : relancé, il ne compte que ce qui manque encore [C]. Un PDF ouvert pendant ce temps le quitte, et redevient un téléchargement ordinaire [C].
- **Autres fichiers :** .tex, .py, images et le reste se synchronisent normalement sur chaque PC : ils se téléchargent dès que l'action qui les ajoute arrive (plan 5a, D6).
- **Références d'un fichier** (plan 4c, revue finale) : un fichier du magasin est retenu par le dossier d'un nœud, par l'historique, et par l'empreinte de l'ancre d'une annotation (`anchor.hash`, section 5.2). Après une réimportation, la version annotée n'est plus dans le dossier de son nœud, mais son annotation l'ouvre encore (section 12). La synchronisation (plan 5a, D6), le stockage des PDF par le serveur (section 18) et la suppression d'un contenu (« Poids de l'historique », section 6.3) comptent ces empreintes comme des références : une telle version se synchronise et se garde comme un fichier de dossier, et « Poids de l'historique » la compte et nomme ses annotations avant de la supprimer.

### 6.6 Fixé par le plan 5a

**Fixé par le plan 5a** (approuvé par l'utilisateur le 2026-11-08) : plusieurs PC partagent une même base par un serveur, qui tourne pour l'instant sur le PC de l'utilisateur (section 21, point 3). [C] marque, comme ailleurs, un choix de Claude fait pendant l'exécution ; le registre du plan (`docs/superpowers/plans/2026-11-08-cirrus-synchro-registre.md`) en donne la raison et le coût. L'architecture est à la section 4, le serveur et le jumelage à la section 18, les réglages partagés à la section 19.

- **D4, l'ordre et les conflits :** le serveur numérote et vérifie strictement ; le PC rejoue ses actions en attente sur ce qui arrive.
  - Le serveur accepte les actions dans leur ordre d'arrivée, chaque « avant » exact. Une action dont un « avant » ne correspond plus est « en retard » : le PC reçoit ce qui lui manque, rejoue son action dessus, puis la renvoie. Une action que le serveur a déjà, reconnue à son identifiant (sa réponse perdue en route), est « acceptée » avec son numéro, sans être appliquée de nouveau.
  - **La fusion** (6.2) se fait au PC, enregistrement par enregistrement et champ par champ, entre l'« avant » de l'action en attente, l'enregistrement tel que le serveur l'a fait, et l'« après » de l'action :
    - un champ changé d'un seul côté prend la valeur de ce côté ;
    - changé des deux côtés, le plus récent gagne : l'heure de l'action, puis l'identifiant du PC ;
    - un tag d'une clé à une seule valeur, déclarée dans le registre et d'un autre genre que mot simple, se fusionne par clé. Tout autre tag (un mot simple, une clé multiple comme `auteur`) est l'élément d'un ensemble, dont les ajouts et les retraits des deux côtés comptent [C] ;
    - les fichiers se fusionnent par nom, sans tenir compte de la casse ni de la forme Unicode, comme le réimport. Un même `.tex` changé des deux côtés garde ses deux versions : la plus récente garde le nom, l'autre devient « nom (conflit du 2026-11-08 14h32).tex », daté de l'écriture perdante en heure locale du PC qui rejoue, puis « (2) » si le nom est pris [C]. Une notification le dit : « Un .tex a été modifié sur deux PC : l'autre version est gardée sous « … ». ». Un conflit ne donne qu'une copie, même quand plusieurs enregistrements l'ont perdu [C]. Pour un autre fichier, le plus récent gagne, et l'autre version reste dans l'historique [C] ;
    - les membres d'une connexion se fusionnent par nœud, et le rôle de chacun est un champ. Un placement, un fantôme, la forme d'une connexion et une clé du registre sont chacun un champ, où le plus récent gagne [C]. La présence d'une branche est un champ ;
    - une liste fusionnée garde l'ordre du serveur, puis ce que seule l'action a, puis les copies de conflit [C].
  - **Supprimé d'un côté, modifié de l'autre :** la modification gagne, pour un enregistrement entier comme pour un fichier, un membre, un placement, un fantôme, une forme ou une clé [C]. Un nœud mis à la corbeille ou effacé revient avec la modification, et avec les placements et les branches que la même action lui avait retirés, si leur plan existe encore ; ses appartenances retirées et les connexions jetées ne reviennent pas [C]. Un nœud déplacé, ou posé dans un autre plan, compte comme modifié. À l'inverse, une action en attente qui jette un objet modifié entre-temps ailleurs perd la suppression de cet objet, de ses placements, de ses branches, de ses appartenances et de ses fantômes [C].
  - Une action rejouée est vérifiée comme une commande : elle ne peut pas ajouter de violation. Si elle en ajoute une, elle est écartée, et une notification la nomme : « « Mettre « X » dans « G » » écartée : « X » est déjà dans le groupe « H », depuis un autre PC. ». Si elle ne change plus rien, elle disparaît sans bruit.
  - Ce qu'une action écartée avait créé ne revient pas par une action suivante qui le modifiait. Ce n'est pas un cas de « supprimé d'un côté, modifié de l'autre » : l'objet n'a jamais existé au serveur. L'action suivante garde le reste de ses changements, et la notification de l'action écartée la nomme : « … Ce que « Modifier une connexion » changeait à ce qu'elle avait créé est écarté avec elle. » (revue finale du plan 5a) [C].
  - **L'heure des actions :** à chaque branchement, le serveur donne la sienne. Le PC corrige l'heure de ses actions de l'écart mesuré (au milieu de l'échange), et avertit au-delà de `syncClockSkewWarnMs` (2 min) : « L'horloge de ce PC diffère de celle du serveur de 7 minutes : règle-la. ». L'avertissement est dans l'infobulle de la pastille, et dans une notification, une fois par message et par session [C]. Ses limites sont à la section 23.
  - **Options écartées :** le dernier arrivé au serveur gagne (une modification faite hier hors ligne écraserait celle de ce matin) ; la fusion au serveur (sa logique serait en deux endroits) ; une bibliothèque de CRDT (un autre modèle de données, lourd : le nôtre a déjà ses « avant » et ses « après »).
- **D5, le journal (schéma v4)** reste l'histoire exacte des tables. Chaque ligne gagne :
  - `unit`, l'identifiant de l'écriture, une par appel à `commit`. Les enregistrements successifs d'un `.tex`, qui forment une seule action (section 12), font plusieurs écritures ;
  - `kind` : `local` pour une action de ce PC, `remote` pour une action reçue, `rewind` pour l'inverse d'une action en attente défaite par une réconciliation, jamais envoyé. Les inverses d'une réconciliation forment une seule écriture, « Défaire les écritures en attente (synchronisation) » [C] ;
  - `superseded`, qui marque une ligne locale remplacée par sa version rejouée, ou écartée ;
  - `server_seq`, le numéro du serveur. La méta `last_server_seq` dit d'où reprendre le flux, et s'écrit dans la même transaction que les lignes reçues : un arrêt brutal ne perd ni ne double rien.
  - Rejouer le journal dans l'ordre local redonne toujours les tables ; l'instantané et le chargement ne changent pas. Une base plus ancienne s'ouvre sans changement (migration v4) : son journal est alors en attente, et ne part qu'avec l'envoi de la base (D7).
  - **L'historique d'un objet** montre les lignes locales et reçues, sans les inverses. Une modification perdante y reste : celle d'un autre PC parce qu'elle est arrivée, la sienne marquée « écartée » sur le PC qui l'a faite [C].
  - **Le Ctrl+Z :** une action réécrite ou écartée par une réconciliation quitte la pile d'annulation [C], comme une action de ce PC que le serveur a acceptée après celle d'un autre. Annuler une action que d'autres ont touchée depuis reste refusé (« a été modifié depuis »). Limite : les écritures d'une annulation ou d'un rétablissement ne sont pas suivies. Réécrites, leur pas reste dans la pile, et son annulation est ensuite refusée de même [C].
- **D6, les fichiers :**
  - **L'envoi :** avant d'envoyer une action, le PC envoie au serveur les fichiers qu'elle ajoute et qu'il n'a pas encore, ceux des dossiers comme l'empreinte des ancres, lus du disque au fil de l'envoi. Le serveur vérifie l'empreinte SHA-256 de chaque fichier reçu, et refuse une action dont un fichier lui manque (« Fichier manquant au serveur. »).
  - **La réception :** les fichiers que les actions reçues ajoutent se téléchargent tout de suite, en fond, `syncDownloads` (4) à la fois, chacun vérifié par son empreinte, sauf les PDF. Un téléchargement interrompu, par la veille ou par la fermeture de l'app, reprend à la connexion suivante : ce qui reste à faire est noté à côté de la base, dans `downloads.json` [C].
  - **Les PDF** se téléchargent à leur première lecture (6.5) : le protocole `cirrus-file:` va chercher au serveur un PDF absent, vérifie son empreinte, le garde, puis le sert. L'ouverture par l'application du système fait de même [C]. Hors ligne, le lecteur dit « PDF pas encore téléchargé : serveur injoignable. ». Une vignette, ou la taille de la version d'une annotation, ne déclenche jamais de téléchargement : la vignette montre l'icône du genre [C], l'annotation dit « PDF pas encore téléchargé : il le sera à son ouverture. » et s'ouvre quand même [C].
  - **Les versions anciennes** d'un fichier, que seul l'historique référence, se téléchargent quand on les ouvre [C].
  - Un fichier du magasin n'est jamais effacé, au PC comme au serveur.
- **D7, le premier jumelage : envoyer sa base ou prendre celle du serveur.** Une base de PC est « vide » quand elle n'a ni nœud, ni connexion, ni placement, seulement son lobby, et n'a jamais rien reçu d'un serveur. Elle est « vierge » quand elle est de plus telle que sa première ouverture l'a faite : son journal ne tient que la création de son lobby, et son magasin aucun fichier (demande de l'utilisateur, 2026-11-09). Un serveur tient une base dès qu'il a accepté une écriture, ou que son état n'est pas vide [C].
  - **PC vide, serveur vide :** la synchro démarre, et le lobby du PC devient la première écriture du serveur.
  - **PC plein, serveur vide :** « Envoyer la base de ce PC au serveur (n nœuds, m fichiers) ».
    - Le PC lit et vérifie d'abord tout ce qu'il enverra, avant toute requête : une ligne abîmée l'arrête là, dite en français [C].
    - Il envoie ensuite tous les fichiers de son magasin, son instantané, son journal par pages (pour l'historique), et enfin `done`, qui rend le serveur non vide. Ses lignes reçoivent leurs numéros, et la synchro démarre.
    - Le serveur vérifie la structure de ce qu'il reçoit, mais ne refuse pas une violation que la base portait déjà : il la compte et la signale [C]. Le PC coupe un libellé trop long avant l'envoi, qui n'est donc jamais bloqué par lui ; le serveur refuse toujours un libellé trop long qu'il reçoit [C].
    - Une ligne passée que les bornes d'aujourd'hui refuseraient, comme une clé de tag trop longue écrite par une version plus ancienne, s'envoie aussi, puis se prend, avec son numéro. Seules les lignes appliquées comme des actions, la fin du journal après l'instantané, passent le contrôle entier. Si l'une ne le passe pas, l'état des tables part [C].
  - **PC vide, serveur plein :** le PC prend la base du serveur. Un serveur qui ne tient que le lobby d'un autre PC compte comme plein : le PC le prend, plutôt que d'apporter un second lobby [C].
    - **Un PC vierge** la prend sans rien demander, dès que le code est accepté. L'utilisateur ne compte se servir que d'une seule base : la base vide que crée un nouveau PC n'a aucune raison d'aller au serveur, et tout ce qu'elle tient (rien) est effacé (demande de l'utilisateur, 2026-11-09). Le bloc « Serveur » dit seulement le téléchargement en cours, puis le redémarrage.
    - **Un PC vide qui a déjà servi,** par exemple un nœud créé puis annulé, se voit proposer « Prendre la base du serveur (n nœuds) » [C].
    - Le PC télécharge l'instantané, le journal et les fichiers autres que les PDF dans un dossier neuf, `<base>-nouvelle`, avec les réglages du serveur et son propre identifiant de PC. Une marque, écrite en dernier, le dit complet [C].
    - L'app redémarre, et l'échange se fait avant que la base s'ouvre. Une base vierge est alors effacée. Elle est relue à ce moment : une action faite pendant le téléchargement la fait garder. Toute autre ancienne base est gardée sous `base-avant-jumelage-AAAA-MM-JJ` (« (2) » si le nom est pris). Un renommage refusé un moment, par un antivirus, est retenté ; s'il échoue encore, l'ancienne base s'ouvre, même vierge, et la base prise attend le démarrage suivant, ce que disent une notification et le bloc « Serveur » [C].
    - Un téléchargement interrompu laisse l'ancienne base intacte, même vierge, et révoque le jeton. Le bloc « Serveur » dit l'erreur sous le formulaire.
  - **PC plein, serveur plein :** refusé, avec l'explication : « Ce PC et le serveur tiennent chacun une base : Cirrus ne fusionne pas deux bases, le jumelage est refusé. ». Seul est proposé « Remplacer la base de ce PC par celle du serveur (n nœuds) », la sienne gardée de même.
  - **Le serveur dont ce PC suit déjà la base** (revue finale du plan 5a) : la base du serveur a une identité, créée avec elle et gardée dans sa base, donc après la perte de `serveur.db` aussi. Un envoi de base la remplace. Le PC la garde à son premier jumelage.
    - Le serveur donne cette nouvelle identité dès le début de l'envoi, et le PC la garde avec sa dernière ligne envoyée juste avant `done`. Si la réponse de `done` se perd après que le serveur a pris la base (l'app quittée, le réseau coupé), le jumelage suivant reconnaît la base envoyée : ses lignes reçoivent leurs numéros, ses réglages partent comme à l'envoi, et le PC reprend, sans offre de remplacement (revue courte du plan 5a) [C].
    - Jumelé de nouveau avec ce serveur, après « Dissocier ce PC », une révocation ou la perte de `serveur.db`, le PC reprend : ce n'est pas un premier jumelage. Rien n'est proposé ni mis à part, et ses actions faites entre-temps partent [C]. Ses réglages ne sont pas redatés : ceux du serveur s'appliquent.
    - Un PC dont le serveur tient une autre base (ses données remplacées) s'arrête, sans rien en recevoir : « Le serveur tient une autre base que celle que suit ce PC : ses données ont été remplacées. Dissocie ce PC, puis jumelle-le de nouveau. ».
  - Tant que l'utilisateur n'a pas répondu, rien n'est écrit ni démarré : le jeton reste en mémoire [C]. Une annulation, ou un premier jumelage qui échoue, révoque le jeton : le PC reste non jumelé, sa base telle quelle.
- **D8, le démarrage, le hors-ligne et la veille** (6.1) :
  - **le voile** « Synchronisation… » couvre toute la fenêtre et retient le pointeur et les touches, au démarrage d'une base jumelée et au réveil. Il se lève quand le PC a rattrapé le serveur, quand le serveur refuse, ou après `syncConnectTimeoutMs` (4 s). Hors ligne, il attend tout ce délai, le serveur pouvant revenir [C] ;
  - **la pastille,** dans la barre des onglets, dit « Connexion… », « Synchronisation… » pendant le rattrapage, « À jour », « Envoi de 3 actions… », « Hors ligne », ou « Serveur : <raison> » pour un refus de version ou de jeton. « Hors ligne » et « Serveur : … » se cliquent pour réessayer. Sans serveur jumelé, il n'y a ni voile ni pastille ;
  - **la reconnexion** se tente à intervalles qui doublent, de `syncRetryMinMs` (1 s) à `syncRetryMaxMs` (30 s). L'attente repart du plus court quand une connexion a fait ses preuves : une réconciliation écrite, ou une connexion tenue `syncRetryMaxMs` [C] ;
  - **la réception** regroupe les actions arrivées pendant `syncReceiveBatchMs` (50 ms), puis les réconcilie ensemble. La scène reçoit une seule action, « Synchronisation » [C] ;
  - **sans serveur jumelé,** rien ne change : l'app fonctionne seule, et ses actions restent en attente, sans effet. « Dissocier ce PC » ramène à cet état : les actions faites ensuite restent sur ce PC.
- **Mesures** (tâche 7, sur ce PC, trois passes chacune, `npm run mesures -w packages/app -- synchro` ; le registre du plan donne la méthode) :
  - d'une écriture sur un PC virtuel au nouveau titre montré par une app jumelée, sur 50 renommages : 62,9 ms en médiane, 64,7 ms au p95 et 66 ms au plus. Le critère, un p95 sous 200 ms, est tenu. La fenêtre de réception (`syncReceiveBatchMs`, 50 ms) en fait l'essentiel ;
  - 10 écritures en attente réconciliées avec 100 reçues, sur la base de référence (50 000 nœuds) : 3,3 à 3,6 ms en médiane et 4,2 ms au plus, ce qui borne le p95, puis 5,2 à 5,7 ms pour la première d'une session ; sur une base de 600 nœuds, 3,6 à 4,5 ms et 7,3 à 7,8 ms. Le critère, 50 ms, est tenu, et le coût ne suit pas la taille de la base ;
  - une action acceptée par le serveur qui tient la base de référence : 1,9 ms en médiane et 5 ms au p95, la requête HTTP comprise. Le critère, une médiane sous 10 ms, est tenu. La première action après le démarrage du serveur a pris 0,3 s ;
  - envoyer la base de référence au serveur prend 20,5 s (21 s à la tâche 7), et la prendre 21,6 s, presque tout dans l'écriture en bloc des tables, une fois par PC. Le serveur qui la tient occupe 293 Mo une fois redémarré sur elle (en 0,4 s), et 492 Mo juste après l'envoi (tâche 5).
- **Hors du plan 5a :** fait au plan 5b (sections 6.1, 6.2, 6.5, 12, 13 et 20) ; le reste, section 24.

## 7. Lobby, plans et opérations entre plans

- **Lobby :** le plan central, bibliothèque de référence, ouvert dans son propre onglet. Chaque plan s'ouvre dans un onglet. Un plan peut être permanent ou servir de plan de travail.
- **Nouveau plan :** créé depuis le menu, il est vide, et l'utilisateur y colle des nœuds. Créé par filtrage, il sera défini plus tard (section 23).
- **Nœuds exclusifs :** un filtre visuel met en évidence ce qui est exclusif au plan.
- **Ajout au lobby :** l'opération « ajouter au lobby », par nœud ou par connexion, demande de placer le nœud à la main dans le lobby. Le nœud suit le curseur et un clic le pose. Une connexion se place automatiquement, puisqu'elle dépend de ses nœuds.

**Suppression.** Elle demande toujours s'il faut supprimer **partout** ou **ici seulement**, dans ce plan ou ce lobby.
- Le dialogue indique combien d'instances existent et avertit s'il s'agit de la dernière.
- Cette règle remplace celle de la spécification, selon laquelle un plan ne pouvait supprimer que ses objets exclusifs. Le dialogue et la corbeille sont les garde-fous.
- Un objet retiré de son dernier plan va à la corbeille. Il en revient par le panneau « Corbeille » (section 6.3), plus bas.
- **Exception, les annotations** (plan 4c) [C] : une annotation, un nœud qui porte une ancre (5.2), retirée de son dernier plan reste vivante, dans aucun plan, comme à sa création (section 12). Elle reste ainsi dans la marge du lecteur et dans le pop-up de son PDF. « Partout » la met à la corbeille, comme tout nœud, et de même « Supprimer » dans le menu de sa ligne, même hors de tout plan (section 12, revue finale). Ce choix-là ne pose pas la question « partout ou ici seulement » : il ne peut que la supprimer partout, son libellé le dit, et Ctrl+Z la rend [C]. L'avertissement du dernier plan ne la nomme pas.

**Cacher une sélection** (menu de sélection) retire les éléments de ce plan.
- Un avertissement apparaît si c'est le dernier plan qui contient certains éléments.
- Un nœud caché laisse des amorces sur ses connexions encore visibles (11.3).
- Retirer un nœud de groupe d'un plan demande si son contenu suit, récursivement. Sinon, chaque membre s'affiche dans son plus proche ancêtre présent dans le plan, sans créer de connexion.

**Copier et coller** (il n'y a pas de « couper »)
- **Fantôme :** au collage, le contenu suit le curseur sous forme de fantôme, et un clic le pose.
- **Échelle :** tous les éléments collés changent du même nombre de crans Δk. On choisit le cran le plus proche de celui qui conserverait exactement la place qu'occupait la sélection à l'écran au moment de la copie : Δk = arrondi de log_f(zoom à la copie ÷ zoom au collage). Les distances changent du même rapport f^Δk. L'écart avec la taille d'origine reste au plus de ×√f.
- **Positions :** les positions relatives sont conservées.
- **Connexions :** une connexion suit si au moins deux de ses nœuds sont dans la sélection. Ses autres branches deviennent des amorces.
- **Groupes :** un groupe suit selon les règles de la sélection (9.3). Les inclusions sont recalculées sur l'ancêtre présent.
- **Nœuds déjà présents :** dans le plan d'arrivée, ils gardent leur place et leur groupe, et l'app propose de les déplacer [C, non contesté].
- **Dépôt dans une enveloppe :** les règles d'entrée dans un groupe s'appliquent (section 10).

**Filtrage :** il conserve les positions relatives.

**Fixé par le plan 6a** (écrit le 2026-11-09 et exécuté en travail autonome le 2026-11-10 ; ses décisions sont de Claude, et l'utilisateur ne les a pas encore approuvées : section 4) : la restauration depuis la corbeille (D5), et « Voir dans un autre plan » (D3, section 14). [C] marque, comme plus haut, un choix fait pendant l'exécution ; le registre du plan en donne la raison et le coût.
- **Restaurer un nœud** (« Restaurer » dans la corbeille) : son titre suit le curseur, comme un collage, au cran lisible, et un clic le pose dans le plan montré, dans le groupe dont l'enveloppe reçoit le clic, en une action [C]. Échap abandonne. Une annotation se restaure de même, posée dans le plan montré [C]. Un autre « Restaurer » remplace une pose en cours ; tout autre geste en cours la refuse [C]. Les amorces « absentes » de ce nœud dans ce plan disparaissent, comme à toute pose [C]. Fermer le panneau abandonne la pose en cours, et une ligne périmée est refusée avant qu'un fantôme ne suive le curseur (6.3) [C].
- **Restaurer une connexion :** elle revient tout de suite, en une action, avec une branche pour chacun de ses membres dans chaque plan où au moins deux d'entre eux sont placés, documents à part ; ni amorce ni fantôme [C]. Ses membres restent ce qu'ils sont, même un membre encore à la corbeille, qui ne se montre nulle part [C]. Une connexion qu'aucun plan ne montre revient sans branche, vue par les pop-ups et les badges de ses membres, et le dit : « Connexion restaurée ; aucun plan ne réunit deux de ses nœuds. » [C]. Les refus :
  - « Ses nœuds sont à la corbeille : restaure-les d’abord. », avec moins de deux membres vivants ;
  - « Il reste moins de deux nœuds à cette connexion : elle ne peut pas revenir. », quand la suppression d'un de ses nœuds l'en a retiré [C] ; le bouton « Restaurer » est alors éteint dès la liste, cette phrase pour titre (6.3) [C].
- **Ce qui ne revient pas :** les appartenances et les connexions retirées avec un nœud, comme à la synchro (6.2). Le Ctrl+Z de la session, lui, rend tout.
- **Avec la synchro :** une connexion restaurée sur un PC pendant qu'un autre supprime partout un de ses membres converge sans violation, dans les quatre ordres. Elle revient ; le membre reste à la corbeille, et sa branche est une amorce vers un nœud jeté, que l'import refuse (« Ce nœud est à la corbeille. ») [C]. Une règle de synchro pour ce cas attend le plan 6b.

## 8. Rendu du graphe

### 8.1 Échelles

- **Zoom :** continu, centré sur le curseur. Il se commande à la molette ou avec + et −, et les flèches déplacent la vue.
- **Échelle de texte :** une valeur globale et continue. Elle change la taille du texte de tous les éléments, et celle des boîtes des nœuds simples.
- **Échelle de taille :** un **cran entier k par élément et par plan**, valant f^k, avec un facteur f global de 2 par défaut. Le choix de 2 se justifie ainsi : à 1,5 ou φ, le parent commence à s'effacer avant que ses membres aient disparu ; à 3, il faut parcourir plus de zoom.
  - **Nœud simple :** son cran change la taille de son texte et de sa boîte [C, non contesté].
  - **Groupe :** son cran change la taille de son titre, et le cran de tous ses descendants, nœuds, sous-groupes et fantômes, du même nombre de crans. Les distances entre ses membres se dilatent d'autant autour de son centre, récursivement dans les sous-groupes, pour que le contenu ne se chevauche pas. La forme est conservée, et le tout est une seule action (un seul Ctrl+Z).
    - **Fixé le 2026-11-11 (retours de l'utilisateur).** Auparavant, ni le texte ni le cran des membres ne changeaient.
  - Changer un cran ne déplace aucun autre élément.
  - **Nouveau groupe :** il est créé un certain nombre de crans au-dessus de son plus grand membre. Ce décalage est un paramètre graphique avancé (section 19), réglé par défaut à deux crans [C], car l'utilisateur trouvait trop étroite la marge où le titre d'un groupe est visible sans ses membres.
- **Formule :** taille à l'écran d'un texte = taille de base × échelle de texte × f^k × zoom.
- **Entrée dans un groupe :** elle ne touche pas à l'échelle, et l'ajustement reste à la charge de l'utilisateur.
- **Sélection :** elle change d'échelle comme un seul élément, en dilatant ses distances autour de son barycentre sans changer la forme.
- **Commandes [C] :** − et + dans le menu contextuel, et Ctrl+molette sur la sélection ou sur l'élément sous le curseur.
- **Contrôle :** le changement de cran se fait à la main.

### 8.2 Niveaux de détail

Tout dépend de la taille du texte à l'écran. En dézoomant, disparaissent dans l'ordre :
1. le marqueur et le titre des connexions ;
2. le texte des nœuds ;
3. puis les groupes se referment.

Les nœuds hors groupe restent affichés, avec une taille minimale à l'écran [C]. Tous les seuils sont réglables. Les défauts de la maquette sont : texte des nœuds de 6 à 8 px, repli des groupes de 4,5 à 6,5 px, titres de connexion de 6,5 à 9 px. Un groupe s'ouvre selon son plus grand membre.

**Fixé le 2026-11-11 (retours de l'utilisateur).** Le repli d'un groupe suit la même plage que le texte des nœuds (`textFade`, 6 à 8 px par défaut), selon son plus grand membre : le texte de ce membre et l'opacité du groupe vont ensemble, et les membres plus petits s'effacent plus tôt. Le réglage du repli (`groupFold`) n'existe plus.

### 8.3 Nœuds

- **Forme :** une boîte avec son titre, rien d'autre. Au premier coup d'œil, « le titre suffit ».
- **Mise en page [C] :** largeur fixe, titre sur plusieurs lignes, hauteur adaptée, sans troncature.
- **Couleur [C] :** la même pour tous les nœuds. La couleur reste réservée aux groupes et aux mises en évidence.
- **Informations :** tags, type de contenu et statut épistémique apparaissent dans le pop-up et par les filtres, jamais sur la boîte [C].
- **Signes [C] :** un petit signe apparaît seulement s'il y a quelque chose à signaler. C'est le cas d'un conflit de .tex, d'un intrus dans une enveloppe ou de connexions existantes absentes du plan.
- **Mise en évidence :** la recherche et le filtre des nœuds exclusifs atténuent ce qui ne correspond pas [C].

### 8.4 Groupes

- **Groupe :** un nœud. Ouvert, il apparaît comme une enveloppe diffuse colorée autour de ses membres. En dézoomant, l'enveloppe s'opacifie jusqu'à cacher son contenu et devient le nœud de groupe, portant son titre. Rien ne bouge à l'écran, et sa taille reflète son contenu.
- **Imbrication :** les groupes s'imbriquent sur plusieurs niveaux.
- **Couleurs non miscibles [C, non contesté] :** l'intérieur de chaque niveau est opaque, et seul le bord flou se mêle au parent. Des couches transparentes de même teinte perdraient vite leur contraste : 68 %, puis 46 %, puis 31 % du premier écart à l'opacité 0,32.
  - **Défaut :** la teinte du parent, avec une luminosité décalée d'un écart minimal dans l'espace OKLCH.
  - **Choix manuel :** la couleur choisie par l'utilisateur prime.
- **Rappel discret :** un coin de l'écran montre la hiérarchie des groupes sous le curseur. Il est cliquable [C].

### 8.5 Connexions

- **Cas 1 vers 1 :** une courbe simple, sans point visible.
- **Faisceau :**
  - les sources convergent vers un marqueur central, puis les branches divergent vers les cibles, et les associés s'y rattachent ;
  - les branches sont tangentes au tronc à leur arrivée ;
  - le marqueur se place au milieu entre le centre des sources et celui des cibles, et ne bouge que si l'un de ses nœuds bouge ;
  - quand on sélectionne la connexion, on peut déplacer le marqueur, orienter le tronc et régler les poignées de Bézier de chaque branche, et ce réglage est propre au plan.
- **Flèches :** flèche sortante pour une source, entrante pour une cible, point pour un associé.
- **Titre :** sans boîte, placé près du marqueur sans recouvrir le marqueur ni les lignes. Sa distance au marqueur est réglable. Sans titre, rien ne s'affiche.
- **Survol :** il illumine toute la connexion.
- **Pop-up :** un clic ouvre la relation en pop-up, à l'endroit du clic.
- **Nœud absent du plan :** il devient une **amorce** en pointillés, nommée au survol, déplaçable et cliquable comme un hyperlien. La connexion s'affiche dès que deux de ses nœuds sont présents.
- **Bras scindés et fantômes** (décisions de l'utilisateur, 2026-11-02). Une connexion est dessinée en entier par défaut. Pour les rares connexions entre nœuds très éloignés, l'utilisateur peut scinder un bras.
  - **Geste :** un clic droit sur une branche, entre le centre et un nœud, propose « scinder ce bras ». Le geste crée deux fantômes, que l'utilisateur place à la main :
    1. Le curseur tient le fantôme du nœud lointain, et un clic gauche le pose près du faisceau.
    2. La vue saute vers le nœud lointain, où le curseur tient le second fantôme, et un clic gauche le pose.
    3. La vue revient à sa position initiale.
  - **Annulation [C] :** Échap annule tout le geste, et le geste entier se défait en un seul Ctrl+Z.
  - **Foyers :** une connexion peut ainsi former plusieurs foyers. Chaque foyer dessine normalement ses membres réels, et chaque bras scindé y est remplacé par le fantôme du nœud lointain, qui garde le rôle et la flèche de ce nœud. Du côté du nœud lointain, sa branche relie le nœud au second fantôme, qui représente le centre de la connexion (confirmé par l'utilisateur).
  - **Position :** un fantôme est fixe dans le plan, et grandit et rétrécit avec le zoom comme le reste.
  - **Usage** (décision de l'utilisateur) :
    - un clic gauche ouvre le contenu de ce que représente le fantôme, comme sur l'original : le pop-up du nœud lointain, ou celui de la connexion ;
    - un clic droit propose « s'y téléporter », qui amène la vue sur l'original et compte comme un saut pour précédent et suivant, ainsi que « réunir ce bras », qui supprime les deux fantômes et redessine la branche entière ;
    - le survol nomme ce que représente le fantôme [C].
  - **Plan :** les fantômes et les foyers font partie de la disposition, donc ils sont propres à chaque plan.
- **Fantômes et groupes** (décision de l'utilisateur, 2026-11-02) : tout fantôme, qu'il vienne d'un bras scindé ou d'un membre absent du plan (11.3), se place dans un groupe comme un nœud ordinaire. Il entre dans l'enveloppe et en sort selon les mêmes règles, compte dans le calcul de l'enveloppe et se replie avec le groupe. Son appartenance ne concerne que son plan, donc aucune question « partout ou ici seulement » ne se pose [C].
- **Connexion hors écran** (décision de l'utilisateur, 2026-11-02) : une connexion ne s'affiche que si au moins un de ses nœuds est à l'écran. Pour éviter les apparitions et disparitions brutales, elle s'efface progressivement quand son nœud le plus proche sort légèrement de l'écran. La largeur de cette marge de fondu est un paramètre avancé, à 150 px par défaut [C].
- **Largeur :** elle n'exprime que l'échelle, pas le sens de la relation.
  - Largeur à l'écran = largeur de base × échelle locale × zoom, bornée par défaut entre 1 et 5 px. Sous le minimum, la ligne ne s'affine plus : elle s'efface.
  - L'échelle locale varie le long de la branche, de l'échelle d'un nœud à celle de l'autre. Une connexion entre deux échelles très différentes s'amincit donc et se dissout vers le petit nœud.
  - La flèche suit la largeur locale. Le marqueur et le tronc prennent la plus grande échelle de la connexion. Une connexion n'a pas d'échelle propre.
  - **Implémentation :** des rubans de triangles à largeur variable, et non de simples traits.
- **Groupe replié :**
  - une connexion interne s'efface avec le groupe ;
  - l'extrémité d'une connexion sortante glisse en continu du membre vers le bord du groupe ;
  - plusieurs membres d'une même connexion fusionnent en une seule branche ;
  - plusieurs connexions entre les mêmes extrémités deviennent une ligne titrée « 2 connexions », que le pop-up détaille ;
  - la flèche est évidée si la branche vient de l'intérieur, pleine si elle est attachée au groupe lui-même.
- **À faire dans l'app :** répartir les points d'arrivée sur le bord d'un groupe, car des connexions venant du même côté se superposent dans la maquette.

### 8.6 Fond

- **Ciel étoilé :** fond par défaut [C]. Les étoiles sont fixées dans le plan, en couches, une par cran d'échelle.
  - En zoomant, une couche s'écarte et s'efface avant de paraître trop clairsemée, et une couche plus fine apparaît.
  - En dézoomant, une couche s'efface avant de former un tapis.
  - La densité à l'écran reste à peu près constante.
  - Les étoiles sont des points d'environ un pixel, sans aucun scintillement.
  - Elles sont calculées à la volée, de façon déterministe, sans stockage.
- **Grille fractale :** elle est très discrète et liée au facteur f. Un interrupteur dans les paramètres graphiques choisit entre le ciel et la grille.

## 9. Interactions

### 9.1 Souris et clavier

- **Clic gauche :** sur un nœud ou une connexion, il le sélectionne.
- **Double clic :** sur un nœud, une connexion, une amorce ou un fantôme, il ouvre son pop-up (celui du nœud représenté pour une amorce ou un fantôme). Le délai et la distance sont ceux du système.
  - **Fixé le 2026-11-11 (retours de l'utilisateur).** Auparavant, le simple clic ouvrait le pop-up.
- **Clic droit :** sur un nœud ou une connexion, il ouvre le menu contextuel. Sur le fond, il ouvre le menu du groupe le plus bas sous le curseur, ou celui du plan.
- **Clic gauche enfoncé :**
  - sur un élément, il le déplace, avec toute la sélection s'il en fait partie ;
  - sur le fond, il déplace la vue ;
  - si la souris bouge de quelques pixels au plus, c'est un clic [C].
- **Fond d'un groupe ouvert :** il compte comme du fond. On déplace un groupe ouvert par son titre [C].
- **Ctrl+clic :** il ajoute à la sélection, ou retire un élément déjà sélectionné [C].
- **Ctrl+clic enfoncé :** il dessine un rectangle de sélection jusqu'au relâchement, et ajoute ce qu'il contient.
- **Désélection :** un clic gauche sur le fond, ou un clic droit hors de la sélection, relâche toute la sélection.
- **Menu de sélection :** il s'ouvre par un clic droit sur un élément sélectionné et propose copier, cacher, et − et + pour l'échelle.
- **Gestes sans bouton enfoncé :** tirer une connexion, exclure d'un groupe, poser un collage ou un nouveau nœud. Pendant ces gestes, la molette et les flèches restent actives, le clic gauche pose, Échap ou le clic droit annule [C].
- **Interaction tactile :** aucune.

### 9.2 Sélection et pivot

Une sélection se comporte comme un groupe temporaire sans titre. Son centre est son barycentre [C].

### 9.3 Rectangle et groupes

- **Centre :** un élément est pris si son barycentre est dans le rectangle.
- **Groupe fermé :** il l'est dès que ses membres ne sont plus cliquables, et il est alors pris tout entier ou pas du tout, sans compteur affiché. Ce même seuil vaut pour le rectangle.
- **Groupe ouvert :** le nœud de groupe est pris si et seulement si tous ses membres le sont, quelle que soit l'échelle.

## 10. Groupes : appartenance et opérations

- **Hiérarchie :** dans un plan, un nœud a au plus un groupe direct, ce qui forme une hiérarchie simple. L'appartenance est une connexion d'inclusion. Les boucles sont interdites.
- **Enveloppe :** elle se calcule à partir des membres, et la position d'un groupe se déduit d'eux. Un groupe vide se comporte comme un nœud simple avec sa propre position.
- **Entrée :** déposer un nœud dans l'enveloppe le fait entrer dans le groupe le plus profond sous le curseur, qui s'illumine pendant le déplacement. Un simple dépôt fait entrer un nœud libre, ou faire descendre un nœud vers un sous-groupe de son groupe. Pour sortir ou passer dans un groupe voisin, il faut « exclure » [C, accepté].
- **Sortie :** l'action contextuelle « exclure du groupe » lance un déplacement sans bouton enfoncé, et un clic gauche pose. Alt+déplacement fait la même chose. Reposer le nœud dans son groupe change seulement sa position.
- **Échelle à l'entrée :** elle ne change pas.
- **Intrus :** une enveloppe qui grandit jusqu'à recouvrir un nœud étranger déclenche un avertissement très explicite. Le nœud n'est jamais repoussé.

**Répercussion dans les autres plans**
- **Question :** à chaque dépôt, si la relation d'inclusion existe ailleurs ou y est possible, l'app pose une seule question : « partout » ou « ici seulement ». « Ici seulement » est la réponse par défaut [C].
- **Effet de « partout » :**
  - la sortie s'applique dans les autres plans ;
  - si le nœud est tombé dans un autre groupe, l'inclusion se répercute dans chaque plan qui contient ce groupe ;
  - là où ce groupe n'existe pas, le nœud rejoint le groupe le plus bas de sa nouvelle chaîne d'ancêtres qui existe là-bas ;
  - sans aucun ancêtre présent, il sort simplement du groupe quitté.
- **Plans exclus [C, accepté sans retour] :** seuls changent les plans où le nœud était dans le groupe quitté, ou dans aucun groupe. Un plan où il appartient à un troisième groupe, sans rapport, n'est pas touché et est signalé. Un plan où la répercussion créerait une boucle est ignoré et signalé.
- **Placement manuel :** rien ne se place seul. Dans chaque plan touché où la position du nœud contredit sa nouvelle appartenance, l'utilisateur le replace à la main. C'est le cas d'un nœud hors de l'enveloppe du groupe rejoint, ou encore dans celle du groupe quitté.
  - Le dialogue annonce le coût avant la réponse, par exemple « Partout : 4 plans, dont 2 à placer à la main ».
  - L'app ouvre ces plans l'un après l'autre, cadrés sur l'endroit concerné, avec le nœud au bout du curseur. Un clic le pose, et Échap laisse ce plan tel quel.
  - Le changement ne s'applique à un plan qu'au clic, donc aucun état en attente n'est conservé.
  - Un groupe se déplace d'un bloc, et l'ensemble se défait en un seul Ctrl+Z.

**Problème ouvert.** L'utilisateur juge difficile la contrainte que l'inclusion fait peser sur les nœuds présents dans plusieurs plans. Il verra à l'usage, et une évolution de la structure de données n'est pas exclue. Changer la règle de répercussion ne demandera pas de transformer les données.

## 11. Connexions : création et membres

### 11.1 Créer une connexion

- **Geste :** clic droit sur un nœud, puis « ajouter une connexion ». Une ligne droite suit le curseur depuis ce nœud, jusqu'au clic sur une cible :
  - **un autre nœud :** la connexion est sortante du nœud de départ par défaut ;
  - **le cœur d'une connexion existante :** le nœud de départ y est ajouté comme source.
- **Cibles valides :** ce qui s'illumine sous le curseur. Le fond d'un groupe ouvert et les groupes qui contiennent le nœud de départ ne sont jamais des cibles. Pendant le geste, les connexions 1 vers 1 affichent leur point central [C, accepté].
- **Répercussion :** s'il y a lieu, l'app demande si la connexion doit apparaître dans tous les plans où ses deux nœuds existent déjà, ou seulement ici. « Ici seulement » est la réponse par défaut [C]. Un plan qui reçoit la connexion la place automatiquement, sans déplacer de nœud.

### 11.2 Modifier les membres (pop-up de la connexion)

- **Rôles :** on change le rôle d'un membre (source, cible, associé).
- **Ajout :** un petit bouton + permet de taper le titre d'un nœud, avec les meilleures correspondances proposées. Un nœud absent du plan s'y affiche en amorce. Si la connexion et le nœud existent ailleurs, l'app demande « partout » ou « ici seulement ».
- **Liste :** le pop-up liste tous les membres de la connexion, en grisé ceux qui ne sont pas affichés dans ce plan [C, accepté].
- **Plans sans le nœud :** un plan qui contient la connexion mais pas le nœud ajouté ne change pas, ce qui garde sa forme stable [C, accepté].
- **Suppression d'un membre :** la règle de suppression s'applique : partout ou ici, avec le nombre d'instances et un avertissement pour la dernière.
- **Moins de deux nœuds :** une connexion qui n'a plus deux nœuds affichés dans un plan s'y masque, et sa forme revient avec le nœud. Une connexion qui n'a plus deux membres du tout est supprimée, après avertissement.

### 11.3 Amorces

Une amorce apparaît quand une branche de ce plan vise un nœud absent du plan : après « cacher », par un ajout via le bouton +, ou lors d'un collage.

- **Import :** un clic sur l'amorce permet d'importer le nœud dans le plan.
- **Badge :** sur un nœud, un badge discret signale ses connexions existantes mais absentes de ce plan [C, non contesté].

## 12. Contenu des nœuds : pop-ups et plein écran

- **Pop-up de nœud :** il montre le titre, le résumé compilé, les tags, les métadonnées et le contenu du dossier avec des aperçus. On peut l'épingler, le déplacer et le redimensionner. Les mêmes possibilités valent pour les aperçus d'éléments.
- **Plein écran d'un élément :**
  - image ;
  - PDF ;
  - .tex, avec le code et l'aperçu compilé côte à côte ;
  - fichiers texte et code ;
  - tableaux.
  Échap quitte cette vue, qui se rouvre au même endroit. Les autres formats s'ouvrent avec l'application du système, sur une copie temporaire en lecture seule [C], pour que rien ne modifie la base en dehors de Cirrus.
- **Mise à jour d'un fichier :** on réimporte explicitement, en déposant la nouvelle version sur le nœud. Elle remplace l'ancienne, qui reste dans l'historique [C].
- **Édition :** le titre, le résumé, les tags, l'import de fichiers et la création de nœuds se font dans la fenêtre principale. Un .tex se modifie dans son plein écran (plan 4b).
- **Création d'un nœud :** depuis le menu contextuel du fond, le nœud suit le curseur et un clic le pose [C].
- **Annotation de PDF :** surligner un passage crée un nœud d'annotation qui porte le passage, le PDF et la page. Le nœud du PDF devient un groupe pour le rendu, ses annotations en étant les membres, dans les plans où elles y sont déposées (plan 4c).
  - **Placement [C] :** pour ne pas interrompre la lecture et ne rien placer automatiquement, une annotation n'apparaît dans aucun plan à sa création. Elle est listée dans la marge du lecteur PDF et dans le pop-up du nœud du PDF.
  - **Ajout à un plan :** l'utilisateur l'y dépose depuis cette liste. La déposer dans l'enveloppe du PDF crée une inclusion ordinaire, avec la règle d'entrée et la question « partout ou ici seulement » (section 10).
  - **Retour au PDF :** un clic sur l'annotation ouvre le PDF à la bonne page.
- **Import de publications :**
  - un identifiant arXiv, un DOI ou un PDF déposé remplit le titre, les auteurs, la date et l'entrée BibTeX ;
  - le serveur récupère le PDF quand il est en accès libre, sinon l'utilisateur le dépose [C] ;
  - l'import d'un fichier .bib, qui servira à charger la bibliographie actuelle et à tester l'ergonomie de l'import, arrive comme un bloc compact qui suit le curseur [C].

**Fixé par le plan 4a** (approuvé par l'utilisateur le 2026-11-04). Ici comme ailleurs, [C] marque un choix de Claude, fait pendant l'exécution. Le registre du plan (`docs/superpowers/plans/2026-11-04-cirrus-fichiers-registre.md`) donne la raison et le coût de chacun.

- **Genres de fichiers et vues :** l'extension donne le genre d'un fichier. Chaque genre a sa vue, la même dans l'aperçu et en plein écran.
  - **Image** (`png`, `jpg`, `gif`, `webp`, `svg`, `avif`…) : ajustée à la vue, et agrandie au plus quatre fois [C]. La molette zoome autour du curseur, le glissement la déplace, et un double-clic passe de l'ajustement au 1:1.
  - **PDF :** les pages sont virtualisées, ajustées à la largeur de la première page [C]. Le texte se sélectionne et se copie. Un lien interne mène à sa destination. Un lien `http`, `https` ou `mailto` s'ouvre par le système, et tout autre lien est ignoré.
  - **Texte et code** (`txt`, `md`, `py`, `json`, `bib`, `ipynb`…, les scripts Perl, Ruby et PHP [C], et `Makefile`, `README`) : CodeMirror 6 en lecture seule, coloré selon le langage, avec la recherche par Ctrl+F. Les lignes longues du texte se replient, pas celles du code.
  - **LaTeX** (`tex`) : au plan 4a, le source s'affichait, coloré. Depuis le plan 4b, l'aperçu montre le PDF compilé, et le plein écran l'éditeur à côté de l'aperçu (« Fixé par le plan 4b », plus bas).
  - **Tableau** (`csv`, `tsv`) : les lignes et les colonnes sont virtualisées, et la première ligne sert d'en-tête.
  - **Tout le reste** n'a pas de vue dans Cirrus : un simple clic l'ouvre avec l'application du système, sans passer par un menu. Ce que Windows lancerait est montré dans l'explorateur (« Ouverture par le système », ci-dessous).
- **Encodages :** un texte en UTF-8, en UTF-16 avec BOM ou en Windows-1252, comme le CSV de l'Excel français, s'affiche lisiblement. Un UTF-16 sans BOM est pris pour un binaire. Un fichier binaire qui porte une extension de texte affiche « Fichier binaire : Cirrus ne peut pas l'afficher. » [C].
  - Un texte surtout en UTF-8, où traînent quelques octets d'un autre encodage, reste en UTF-8 : chacun de ces octets s'affiche « � », et les accents restent lisibles. Il ne se lit en Windows-1252 que si ces octets sont nombreux, c'est-à-dire si les caractères UTF-8 valides ne sont pas au moins deux fois plus nombreux qu'eux [C].
- **Au même endroit :** chaque vue se rouvre à sa place, retrouvée par l'empreinte du fichier. C'est la ligne du texte, le défilement du tableau, le zoom de l'image, ou la page et le zoom du PDF. Une nouvelle version s'ouvre au début.
- **Tableurs :** le CSV et le TSV s'affichent dans l'app. Les `.xlsx` et `.ods` s'ouvrent avec l'application du système, faute d'une bibliothèque sobre pour les lire. C'est à revoir si l'usage le demande.
- **Ouverture par le système** (décision de l'utilisateur, 2026-11-04) :
  - « Ouvrir avec l'application du système » n'est offert que pour les images, les PDF et les formats que Cirrus ne sait pas afficher ;
  - le texte, le code (les scripts Perl, Ruby et PHP compris [C]), les `.tex` et les tableaux ne s'affichent que dans Cirrus ;
  - une courte liste d'exécutables, `.sh` et les fichiers compilés de Python (`.pyc`, `.pyo`, `.pyzw`) [C] compris, est montrée dans l'explorateur, jamais lancée ;
  - un script n'est donc jamais remis à Windows, ni par un clic ni par le menu ;
  - le coût accepté : un fichier que Cirrus n'affiche pas s'ouvre par le système d'un simple clic, et un exécutable d'un type absent de la liste serait lancé ainsi ;
  - l'utilisateur a jugé excessives des protections plus larges (« Ça m'a l'air overkill »).
- **Copies remises au système** [C] : elles sont en lecture seule et portent la marque du web (zone Internet, `ZoneId=3`). Windows les traite donc comme des fichiers téléchargés, et Office les ouvre en mode protégé.
  - Elles sont temporaires. Au démarrage suivant, Cirrus efface celles qui sont restées en lecture seule.
  - Un fichier enregistré à côté d'une copie (« Enregistrer sous » propose son dossier) est gardé. Mais rien n'en revient dans la base : on le réimporte en le déposant sur le nœud.
- **Import :**
  - on importe en déposant des fichiers sur un nœud du graphe ou sur son pop-up, ou par « Ajouter des fichiers… » ;
  - seuls les fichiers réellement déposés, ou choisis dans la boîte de dialogue, sont importés [C]. Le principal refuse aussi les chemins réseau, ce qui n'est pas un fichier ordinaire, et un fichier de plus de `maxImportMb` (200 Mo par défaut) ;
  - un fichier refusé l'est avec sa raison en français, et les autres sont importés. De même, chaque échec d'une ouverture par le système est dit en français, et nomme le fichier [C] ;
  - sur un pop-up, un fichier est pris n'importe où, sur sa liste de fichiers comme sur ses champs ;
  - un fichier lâché ailleurs (onglets, réglages, champ de texte, fond du graphe) n'est pas importé, et la fenêtre ne navigue jamais vers lui.
- **Fusion par nom au réimport :**
  - un fichier déposé remplace celui du même nom, à sa place. La casse et la forme Unicode ne comptent pas : « rapport.pdf » remplace « Rapport.pdf » ;
  - il prend la nouvelle orthographe, et l'ancienne version reste dans l'historique ;
  - un fichier identique, de même empreinte, ne change rien. Quand tout un dépôt est ainsi inchangé, la notification dit « Déjà à jour. » ; dans un dépôt mêlé, le fichier identique n'est simplement pas nommé ;
  - deux fichiers du même nom dans un même dépôt deviennent « a.txt » et « a (2).txt » ;
  - un dépôt de plusieurs fichiers forme une seule action, donc un seul Ctrl+Z.
- **Fichiers du pop-up :** chaque fichier montre son nom, son genre et sa taille, et une vignette pour une image ou un PDF. Un clic sur un fichier que Cirrus affiche ouvre son aperçu à côté du pop-up, et un double-clic son plein écran. Un clic droit propose, selon le genre, le plein écran et l'application du système, puis le renommage et le retrait. Un fichier retiré se remet par Ctrl+Z, et sa copie reste au magasin. Le clic qui ferme un menu contextuel n'agit pas sur ce qu'il touche, où que ce soit dans l'app ; son appui ferme encore les pop-ups non épinglés [C].
- **Métadonnées du pop-up :** la date de création, celle de la dernière modification, le nombre de modifications, les plans où le nœud figure, le nombre de ses connexions de connaissance et son identifiant.
- **Pop-ups épinglés et non épinglés :**
  - un clic sur un nœud, sur un groupe ou sur le fantôme d'un nœud lointain ouvre son pop-up près du clic. Pour le fantôme, c'est la règle de la section 8.5 ;
  - un nœud n'a qu'un pop-up : un second clic le fait passer devant ;
  - un pop-up non épinglé se ferme quand un autre s'ouvre, à tout clic hors de tout panneau, ou par Échap. Échap annule d'abord un geste du graphe en cours, même lancé depuis le menu contextuel, et le pop-up reste ;
  - exception connue, reportée : un clic sur ce qui flotte au-dessus du graphe (le coin de la hiérarchie, le pop-up d'une connexion, le menu, une question) laisse ouvert le pop-up non épinglé ;
  - un pop-up épinglé reste d'un onglet à l'autre, mais pas d'une session à l'autre ;
  - l'aperçu d'un fichier suit les mêmes règles. Un seul aperçu non épinglé est ouvert à la fois ;
  - le pop-up d'un nœud supprimé dit « Ce nœud n'existe plus. », et son contenu revient si la suppression est annulée.
- **Une vue suit son fichier par son nom** [C] : un fichier retiré ferme son plein écran, et son aperçu dit qu'il n'est plus dans le nœud. Il en va de même d'un fichier renommé.
- **Plein écran** [C] : il couvre toute la fenêtre, onglets compris, et il est modal. Le focus y reste, et les raccourcis de l'app (Ctrl+Z, Ctrl+Y, Suppr…) n'agissent pas sous lui.
- **Erreurs** [C] : une erreur dans un pop-up, un aperçu ou le plein écran se dit en français à sa place. Le pop-up ou l'aperçu se déplace et se ferme encore ; le plein écran se quitte par son × ou par Échap. La fenêtre, le graphe et les autres panneaux restent, et un panneau rouvert réessaie.
- **Lectures bornées :**
  - une vue de texte ou de tableau ne lit jamais plus que son plafond (`textViewMaxMb`, `tableViewMaxMb`). Un bandeau dit alors ce qui est affiché ;
  - un PDF se lit par plages, à la demande de pdf.js [C]. Un PDF dont toutes les pages pendent de la racine (LibreOffice, Ghostscript, scanners) est lu en entier à l'ouverture : 1,3 s pour 78,5 Mo, mesuré. Ce coût est accepté sur le jugement de l'utilisateur du 2026-11-04, à la clôture du plan 3c : les performances sont correctes pour l'instant, et on y reviendra si sa vraie base grandit ;
  - une vignette ne lit une image ou un PDF que jusqu'à `thumbMaxMb` (4 Mo par défaut) [C]. Une image plus grande n'est pas lue, et la lecture d'un PDF s'arrête à ce plafond. La ligne montre alors l'icône du genre ;
  - ouvrir un pop-up ne lit donc aucun fichier au-delà de `thumbMaxMb`.

**Fixé par le plan 4b** (approuvé par l'utilisateur le 2026-11-05) : le résumé et la relation compilés, et le plein écran d'un .tex. Le reste de la chaîne est à la section 13. [C] marque, comme plus haut, un choix de Claude fait pendant l'exécution ; le registre du plan (`docs/superpowers/plans/2026-11-05-cirrus-latex-registre.md`) en donne la raison et le coût.

- **Résumé et relation compilés :** le pop-up d'un nœud montre son résumé compilé, et celui d'une connexion sa relation.
  - **Présentation :** un PDF rogné à son contenu, composé sur `latexSnippetWidthCm` (9 cm), puis dessiné à la largeur du pop-up sans dépasser `latexSnippetMaxZoom` (1,6). Une autre largeur recompile les résumés et les relations ouverts [C]. Il garde les couleurs du document, comme du papier : noir sur une carte blanche [C]. L'utilisateur a choisi de garder ce papier à 9 cm, la largeur restant un réglage (2026-11-07).
  - **États :** avant la première compilation, ou sans LaTeX, le source s'affiche en caractères à chasse fixe, avec la raison en petit. Une erreur garde le dernier PDF valide, avec une ligne rouge (« Erreur ligne 1 : Undefined control sequence. ») et un bouton « Journal » ; sans PDF valide, le source prend sa place [C]. Un champ vide garde la zone de texte d'avant, avec « Résumé, en LaTeX » ou « Relation (LaTeX) » en attente [C].
  - **Modifier :** un clic, Entrée ou F2 ouvre un éditeur compact, le curseur à la fin, avec l'aperçu du brouillon dessous, compilé à chaque pause de frappe. Quitter le champ enregistre le texte, en une action. Passer à une autre fenêtre ne quitte pas le champ ; fermer la fenêtre l'enregistre, même depuis la barre des tâches ou par Alt+F4 [C]. Échap rend le texte enregistré sans rien écrire. Il remonte d'un cran à la fois : le journal, puis le brouillon, puis le pop-up [C]. Dans l'éditeur, Ctrl+Z agit sur le texte, jamais sur la base [C].
  - **Liens :** un clic sur un lien vers un nœud ouvre le pop-up de ce nœud, non épinglé, à côté du panneau d'où vient le clic, ou le fait passer devant s'il est ouvert [C]. Sous un plein écran, qui est modal, le lien le dit dans l'en-tête et n'ouvre rien [C]. Un nœud parti dit « Ce nœud n'existe plus. ».
  - **Sans éclair :** un nouveau PDF remplace l'ancien sur place, et le source ne se montre jamais entre deux PDF [C]. Un pop-up rouvert dessine son résumé en 17 ms. Le premier résumé d'une session attend la compilation et le chargement de pdf.js : environ 0,6 s, dont 0,45 s pour pdf.js.
- **Plein écran d'un .tex :** l'éditeur à gauche, l'aperçu compilé à droite.
  - **L'éditeur :** CodeMirror 6, coloré en LaTeX, avec les numéros de ligne, la recherche (Ctrl+F), les longues lignes repliées [C] et son propre historique (Ctrl+Z, Ctrl+Y). Dans les accolades d'un `\ref` ou d'un `\cite`, il suggère les labels et les clés du registre, dans l'ordre français, sans tenir compte de la casse ni des accents [C]. Il souligne en rouge un label inconnu ou en double, une clé inconnue ou portée par deux nœuds, et la ligne d'une erreur de compilation.
  - **L'aperçu :** le lecteur PDF du plan 4a, sur le dernier PDF valide. Un nouveau PDF y prend la place de l'ancien, au même zoom et au même défilement, sans éclair. Il s'affiche moins de 300 ms après la pause de frappe pour 95 % des frappes mesurées (288 ms au p95, jusqu'au canevas), mais pas toutes : une a pris 329 ms (section 13).
  - **Le bandeau :** « Compilation… », « Erreur ligne 12 : … », « Enregistré » ou « Non enregistré : <raison> ». « Journal » ouvre le journal de pdfLaTeX par-dessus l'aperçu. Un clic sur l'erreur place l'éditeur à sa ligne, et Échap ne ferme que le journal.
  - **Enregistrement** (D6, décision de l'utilisateur, 2026-11-05) : après une pause de frappe de `texSaveIdleMs` (10 s), à Ctrl+S, à la fermeture du plein écran et à celle de la fenêtre. C'est seulement si le texte diffère de la dernière version enregistrée : taper puis effacer n'enregistre rien. Le premier enregistrement écrit le fichier en UTF-8, avec des fins de ligne LF, quels que soient son encodage et ses fins de ligne d'origine (Windows-1252, UTF-16, CRLF) [C].
  - **Regroupement :** des enregistrements successifs du même .tex ne forment qu'une modification de l'historique, et un seul Ctrl+Z. Il ne faut aucune autre action entre eux : ni modification, ni annulation, ni rétablissement. Cela vaut d'une ouverture du plein écran à la suivante, dans une même session de l'app. Les versions intermédiaires restent dans le journal, invisibles. Chaque enregistrement est une écriture de la même action, qui part au serveur dès qu'elle est faite (6.6, D5).
  - **Un enregistrement refusé** (le nœud ou le fichier parti entre-temps) garde le texte dans l'éditeur et dit pourquoi. Une seconde demande de fermeture pose « Fermer sans enregistrer ? », « Annuler » ayant le focus [C].
  - **Un .tex plus grand que `textViewMaxMb`** s'affiche en lecture seule, avec la raison et sans aperçu [C].
  - L'aperçu d'un .tex, à côté du pop-up, montre son PDF compilé.
- **Préambule :** il se modifie dans un plein écran du même genre, ouvert depuis les réglages (section 13, D5).

**Fixé par le plan 4c** (approuvé par l'utilisateur le 2026-11-07) : les annotations de PDF, l'import d'une publication par son identifiant ou son PDF, et l'import d'un fichier `.bib`. [C] marque, comme plus haut, un choix de Claude fait pendant l'exécution ; le registre du plan (`docs/superpowers/plans/2026-11-05-cirrus-annotations-registre.md`) en donne la raison et le coût. Le champ `anchor` est à la section 5.2, les tags des publications à la section 5.4, les sources du réseau à la section 18.

- **Surligner :** on sélectionne du texte dans un lecteur PDF, dans l'aperçu ou en plein écran.
  - « Annoter » paraît au bord droit, sous la dernière ligne de la sélection, une fois l'appui terminé [C]. Ctrl+Maj+A fait de même [C]. Une sélection vide ou faite de blancs n'offre rien.
  - Une sélection qui passe d'une page à l'autre est coupée à la fin de la première [C] : une annotation, une page.
  - Un passage trop long est refusé, et la notification dit sa longueur et la borne : 20 000 caractères ou 500 lignes [C]. La sélection reste, pour qu'on la raccourcisse.
  - L'annotation naît dans aucun plan. C'est une action, et Ctrl+Z la défait. En plein écran, Ctrl+Z et Ctrl+Y ne défont et ne refont que les pas faits dans ce plein écran [C].
- **Le surlignage :** un rectangle translucide par ligne, de la couleur `annotationColor` (un jaune, #ffd23f [C]) à `annotationOpacity` (0,35), multiplié avec la page : le texte reste noir [C]. Il reste sur son texte à tous les zooms : 0,5 pt d'écart au plus, mesuré à 91 % et à 277 %. Le lecteur ne dessine que les surlignages des pages qu'il dessine : celles de la vue, et `pdfPagesAhead` (1) de chaque côté (mesures, plus bas).
- **La marge du lecteur :** à droite du PDF, repliable, `annotationMarginPx` de large (240 px), au plus la moitié de la vue [C].
  - Elle ne paraît que si le fichier lu a des annotations [C]. Elle liste celles de ce fichier, dans l'ordre des pages, puis de haut en bas.
  - Chaque ligne montre le début du passage, la page, les plans où l'annotation figure, ou « dans aucun plan », et « sur une version précédente » s'il y a lieu. Celles de la version montrée ont un liseré [C].
  - Son repli se garde par fichier, comme la page lue [C].
- **Le pop-up d'un PDF** a une section « Annotations », après « Fichiers », quand il en a : la liste de la marge [C]. Le pop-up d'une annotation commence par « Annotation de « <PDF> », p. <n> », qui ouvre le PDF là [C].
- **Ouvrir une annotation :** un clic sur une ligne ouvre le PDF à sa page, le passage centré dans la vue et clignotant pendant `annotationFlashMs` (1,2 s). Depuis un pop-up, il s'ouvre dans l'aperçu de son fichier, à côté du pop-up [C], une seule fois : l'aperçu qui revient du plein écran, ou qui montre une version nouvelle, reprend sa place sans rejouer l'annotation (revue finale). Ce qui manque se dit à la place, et la ligne ne s'ouvre plus : le PDF à la corbeille ou absent, le fichier retiré du nœud, la version absente du magasin.
- **Le menu d'une ligne** (revue finale) : un clic droit sur une ligne, dans la marge ou dans le pop-up du PDF, ouvre son menu [C].
  - « Ouvrir sa fiche » ouvre le pop-up de l'annotation à côté du panneau : on la renomme, la résume et la tague là, même dans aucun plan.
  - « Supprimer » la met à la corbeille partout, en une action, qu'un Ctrl+Z défait. Il se lit « Supprimer partout » quand elle figure dans un plan, qu'elle quitte aussi [C].
  - En plein écran, modal, le menu n'offre que ce choix (« Supprimer », ou « Supprimer partout »), un pas de ce plein écran : son Ctrl+Z et son Ctrl+Y le défont et le refont.
- **Versions** (D2) : une annotation porte sur la version du PDF où elle a été faite, que le magasin garde après une réimportation. Le lecteur ne dessine sur un PDF que les annotations de sa version. Celle d'une version précédente s'ouvre sur sa version, dans la même vue, sous une bannière et son bouton « Revenir à la version actuelle » [C].
- **Poser une annotation dans un plan :** on glisse une ligne de la marge de l'aperçu, ou du pop-up, sur le graphe. Le plein écran est modal : on n'y glisse rien.
  - Elle prend la place du dépôt, au cran lisible. Lâchée dans l'enveloppe d'un groupe, elle y entre. Lâchée sur un nœud simple, celui de son PDF ou un autre, elle y entre aussi, et ce nœud devient un groupe, comme pour un nœud déplacé (section 10) [C].
  - Le nœud ou le groupe qui la recevrait s'illumine pendant le survol. La question « partout ou ici seulement » suit la section 10.
  - Déjà dans ce plan : « Déjà dans ce plan. », et la vue se cadre sur elle [C]. Pendant un geste ou une question, le dépôt est refusé et la notification dit pourquoi [C].
  - C'est une action, et Ctrl+Z la défait. Retirée de son dernier plan, l'annotation reste vivante (section 7).
- **Importer une publication par son identifiant :** « Importer une publication… », dans le menu du fond, ouvre un dialogue en haut du graphe. Il ne bloque rien [C], et Échap ou « Fermer » le ferme.
  - On y tape un DOI, un identifiant arXiv, nouveau ou ancien, avec ou sans sa version, ou un lien vers l'un d'eux.
  - Seul « Importer », ou Entrée, touche le réseau (section 18).
  - Le nœud se pose au point du clic droit, au cran lisible, même si la vue a bougé [C]. Son titre est celui de l'article, les accents LaTeX convertis. Il porte les tags de la section 5.4, et son `<clé>.bib`. L'import est une action, qu'un Ctrl+Z retire.
  - Le PDF d'un article arXiv se télécharge seul, et vient au nœud. S'il ne vient pas, la publication vient sans lui, et une notification dit pourquoi [C]. En attendant le serveur, c'est le PC qui le télécharge (demande de l'utilisateur, 2026-11-05).
  - Un échec se dit en français dans le dialogue, qui reste ouvert : « Identifiant non reconnu. », « Publication introuvable. », « Pas de connexion. »… Rien n'est créé.
- **Importer une publication par son PDF** (D8) : un PDF déposé sur le dialogue entre au magasin. Ses métadonnées et ses `publicationPdfPages` premières pages (2) sont lues, à la recherche d'un DOI ou d'un identifiant arXiv. Trouvé, il remplit le champ, et « Importer » garde ce PDF. Sinon, « Créer le nœud » crée le nœud sous le titre des métadonnées, ou le nom du fichier, le PDF attaché, et l'utilisateur complète.
- **L'usage visé** (utilisateur, 2026-11-08 : « j'importerais un PDF soit en collant une URL, soit en important le fichier depuis mon ordinateur ») : au plan 4c, le fichier passait par le dialogue, où on le dépose ; un PDF lâché sur le fond n'était pas importé, et le dialogue n'avait pas de bouton pour le choisir. Une adresse n'était lue que d'arXiv ou de `doi.org`. Le plan 5b fait le reste (plus bas).
- **La clé BibTeX** (revue finale, révisé) : celle de l'entrée si BibTeX et LaTeX la lisent : des caractères ASCII imprimables, sans blanc ni `\ { } % # , ~ " ' ( ) =`, sans `://` ni `^^`, 200 au plus [C]. L'import d'un `.bib` charge la bibliographie actuelle, dont les `\cite` nomment déjà ces clés : celles de DBLP (`DBLP:conf/nips/VaswaniSPUJGKP17`) et « Auteur:Année » (`Hinton:2006`) sont donc gardées, dans le tag `clé_bibtex` et dans l'entrée écrite. La clé de DataCite, une adresse, est remplacée par le nom de famille du premier auteur et l'année, en lettres et chiffres ASCII (`vaswani2017`), puis `vaswani2017b`, et ainsi de suite ; de même une clé prise ou absente. Seul le nom du fichier est nettoyé : `< > : " / \ | ? *` y deviennent `_`, et un nom réservé de Windows reçoit un `_` (`DBLP_conf_nips_VaswaniSPUJGKP17.bib`, `con_.bib`) [C].
- **Les doublons :** une publication qui a déjà ce DOI, cet identifiant arXiv, cette clé, ou ce titre et cette année [C], n'est pas recréée, et la notification nomme le nœud existant. Une clé, ou un titre et une année, ne comptent que si aucun identifiant ne les contredit [C]. Un même titre et une même année ne comptent pas non plus quand les deux côtés ont un premier auteur et que leurs noms de famille diffèrent, sans casse, accents ni ponctuation (revue finale) [C] : deux chapitres « Introduction » de 2020, de Smith et de Doe, sont deux publications. Le premier auteur d'un nœud est son premier tag `auteur`, son nom de famille lu comme BibTeX lit un nom (« Prénom Nom » ou « Nom, Prénom », sans les particules ni « Jr. ») [C]. Un nœud à la corbeille ne compte pas.
- **Importer un fichier `.bib`** (D9) : on le dépose sur le fond du graphe, ou on passe par « Importer un fichier .bib… » dans le menu du fond.
  - Sans réseau, ses entrées deviennent des publications, avec leurs doublons écartés, ceux de la base comme ceux du fichier.
  - Elles suivent le curseur en un bloc compact : le fantôme du collage, « Importer 7 publications », et le contour du bloc au cran lisible. Le bloc compte `ceil(√n)` colonnes, `bibBlockGapPx` (24 px) entre les boîtes [C].
  - Pendant que le bloc suit le curseur, leurs `.bib` s'enregistrent en fond, et le fantôme dit l'avancement [C].
  - Un clic pose tout le bloc, en une seule action, « Importer <n> publications », qu'un seul Ctrl+Z retire. Échap abandonne la pose. Après le clic, on attend l'enregistrement, et rien d'autre ne commence [C].
  - La notification dit les publications posées, les doublons écartés en nommant le nœud existant, et les entrées abîmées par leur ligne, `bibNoticeLines` (5) par liste. Elle reste `bibNoticeMs` (20 s), et un clic ou Échap la ferment [C].
  - Un `.bib` déposé sur un nœud en devient un fichier, comme tout fichier. Déposé sur le fond avec d'autres fichiers, il n'est pas importé [C].
- **La lecture d'un `.bib`** se fait par un analyseur à nous : macros `@string`, concaténations `#`, mois, `@comment`, `@preamble`, commentaires `%`, accents LaTeX, noms « von » et « Jr ». Une entrée abîmée est signalée à sa ligne, et la lecture reprend à la suivante. Un fichier de plus de 16 Mi caractères n'est pas lu, et le temps de lecture d'un fichier abîmé est borné [C].
- **Mesures** (tâche 7, sur ce PC, la machine chargée par le travail de l'utilisateur ; trois passes chacune, dans l'app construite, fenêtre en arrière-plan) :
  - un `.bib` de 2 000 entrées s'analyse en 11 à 31 ms : l'analyseur seul, sur 2 000 entrées réelles en forme (600 Ko) ou sur celles de la tâche 6. Dans l'app, du dépôt au fantôme, il faut 111 à 156 ms, dont 87 à 114 ms pour décoder, analyser et comparer à la base. Le seuil d'une seconde est tenu ;
  - les 2 000 `.bib` s'enregistrent en 5,1 à 5,7 s pendant que le bloc suit le curseur. Un clic donné ensuite pose le bloc en 205 à 561 ms, et l'image qui le montre vient 0,58 à 0,94 s après le clic ;
  - un PDF de 25 pages et 50 annotations s'ouvre dans l'aperçu en 384 à 390 ms à froid, le premier de la session : sa première page, ses surlignages et la marge de 50 lignes, jusqu'à l'image. Le même fichier sans annotation s'ouvre en 374 à 381 ms. À chaud : 45 ms, contre 34 à 35 ms ;
  - à la molette, de la première page à la dernière (25 000 px en 11 s), les images se suivent à 10,7 ms en médiane et 11,2 ms au p95, avec ou sans surlignages, et aucune ne dépasse 50 ms. La plus longue prend 21 à 22 ms avec eux, 14 à 17 ms sans ;
  - pendant ce défilement, 4 pages au plus sur 25 portent leurs surlignages, et 17 rectangles au plus sur 101 sont dans la page. Aucune page ne les reçoit avant d'entrer dans la vue ± 1 page. Ceux d'une page qui en sort partent avec son canevas, au plus 6 images (64 ms) plus tard.
- **Hors du plan 4c :** la récupération par le serveur, et un PDF trouvé hors d'arXiv (faits au plan 5b, plus bas) ; l'annotation à main levée ou par zone ; la veille (section 16.2).

**Fixé par le plan 5b** (écrit et exécuté en travail autonome le 2026-11-09 ; ses décisions sont de Claude, et l'utilisateur ne les a pas encore approuvées : section 4) : les publications récupérées par le serveur, l'import par l'adresse de n'importe quel article, le DOI lu dans l'adresse d'un éditeur, un PDF lâché sur le fond et « Choisir un PDF… ». [C] marque, comme plus haut, un choix fait pendant l'exécution ; le registre du plan (`docs/superpowers/plans/2026-11-09-cirrus-synchro-suite-registre.md`) en donne la raison et le coût. Les gardes du réseau ouvert et la route du serveur sont à la section 18, la comparaison d'un `.tex` et de sa copie de conflit à la section 6.2.

- **D2, l'import passe par le serveur :**
  - un PC jumelé et connecté envoie au serveur le texte saisi (`POST /publications`). Le serveur fait l'import, garde le PDF dans son magasin, et rend le même résultat qu'au plan 4c, le PDF donné par sa référence. Le PC ne le télécharge qu'à sa première lecture (6.6, D6). Avant d'envoyer l'action qui crée le nœud, le PC demande au serveur les fichiers qui lui manquent : le PDF y est, rien n'est envoyé ;
  - « jumelé et connecté » veut dire une connexion dont le branchement est fait et le flux ouvert [C]. Sans serveur jumelé, ou s'il ne répond pas comme il faut (le réseau, un serveur occupé ou en erreur, une route absente, une réponse illisible), le principal du PC fait l'import lui-même, comme au plan 4c, et une ligne de la console dit pourquoi [C]. Le PDF part alors au serveur avec l'action, comme tout fichier ajouté ;
  - un refus du serveur (« Publication introuvable. », une adresse refusée…) est montré tel quel, et n'est pas refait au PC. Mais un réseau du serveur qui n'aboutit pas (pas de connexion, un délai dépassé) n'est pas la réponse de la publication : le PC l'importe alors par son propre réseau [C]. Un réseau qui demande un proxy, qu'Electron traverse et Node non, laisse ainsi un PC jumelé aussi bien loti qu'au plan 4c ;
  - le PC lit la réponse du serveur comme une donnée : chaque champ est vérifié, et un fichier est une référence exacte (un nom simple, une empreinte SHA-256, une taille entière) [C] ;
  - un PC qui s'en va, ou l'arrêt du serveur, arrête l'import. Un PDF déjà gardé reste au magasin du serveur, qui n'efface jamais un fichier [C] ;
  - le réseau ne sert toujours qu'à la demande explicite de l'utilisateur : le serveur n'importe rien de lui-même ;
  - **options écartées :** le serveur seul, sans repli, qui laisserait sans import un PC hors du réseau du serveur ; un module dupliqué dans le serveur, deux copies des gardes à tenir.
- **D3, l'adresse d'un article ou d'un PDF de n'importe quel site :**
  - une adresse `https:` est acceptée sur le port 443, sans identifiants. Une adresse `http:` est refusée : « Seules les adresses https sont acceptées. ». Les autres refus disent le port, les identifiants, ou « Adresse refusée : elle mène à une machine du réseau local. » (section 18) ;
  - **un PDF**, reconnu à ses cinq premiers octets (`%PDF-`), entre au magasin, puis suit le chemin d'un PDF déposé sur le dialogue, qui cherche son identifiant dans ses premières pages. Son nom est celui du fichier de l'adresse s'il finit par `.pdf`, sinon l'identifiant, sinon « publication.pdf » [C] ;
  - **une page HTML** est lue sous `publicationMaxKb`, comme du texte, jamais comme du code. Ses balises `<meta>` du standard Highwire, que suivent OpenReview, PMLR, les actes de NeurIPS, l'ACM, Springer et bien d'autres, donnent son DOI (`citation_doi`), son identifiant arXiv (`citation_arxiv_id`) et l'adresse de son PDF (`citation_pdf_url`, demandée en `https` si la page l'écrit en `http` [C]). Le DOI, sinon l'identifiant, importe les métadonnées, puis le PDF de la page vient avec, sous les mêmes gardes, avant celui d'arXiv [C]. Sans identifiant, le PDF de la page suit le chemin d'un PDF déposé. Une page qui ne mène à rien : « Cette page ne mène à aucun PDF. » ;
  - une balise de plus de 8 Ko est sautée, un identifiant trop long ou une adresse de plus de 2 048 caractères écartés : des bornes fixes de sécurité [C] ;
  - le champ du dialogue ne coupe rien de ce qu'on y colle : un texte y est une adresse de 2 048 caractères au plus (un lien signé vers un PDF dépasse souvent 1 000), un identifiant de 1 000, seul ou dans une adresse. Au-delà, « Adresse trop longue (plus de 2 048 caractères). », sans réseau. Le principal et le serveur tiennent la même borne (revue finale du plan 5b) [C] ;
  - tout le téléchargement d'un PDF, d'arXiv comme d'une adresse, est borné par `publicationPdfMaxMs` (5 min) : « Le téléchargement du PDF a dépassé 5 min : arrêté. » [C] ;
  - **options écartées :** une liste de sites permis, qui demanderait une version de l'app à chaque nouvelle conférence ; lire le PDF dans les liens de la page, fragile et propre à chaque site.
- **D4, le DOI lu dans l'adresse d'un éditeur :** une adresse `http(s)` dont le chemin, une fois décodé, contient un DOI (`10.<4 à 9 chiffres>/…`) qui commence un segment se lit comme ce DOI, sans requête : `dl.acm.org/doi/pdf/10.1145/…`, `link.springer.com/article/10.1007/…`, `onlinelibrary.wiley.com/doi/full/10.1111/…`. Le « / » final, puis une fin `.pdf`, puis un dernier segment `full`, `abs`, `abstract`, `pdf`, `epdf` ou `fulltext` placé après le DOI, sont retirés [C]. C'est une lecture d'identifiant, comme les liens de `doi.org` (section 18) : elle passe avant la récupération de D3, et vaut pour tout site [C].
- **D5, un PDF lâché sur le fond, et « Choisir un PDF… » :**
  - un seul PDF lâché sur le fond ouvre le dialogue d'import au point du dépôt, avec ce PDF, comme s'il y avait été déposé. Le dialogue est occupé dès qu'il paraît (« Lecture de « x.pdf »… ») [C]. Pendant un geste ou une question, le dépôt est refusé, avec la raison habituelle [C] ;
  - plusieurs fichiers, ou un PDF avec d'autres, gardent une notification, qui cite les deux cas permis : « Dépose un seul .bib ou un seul PDF sur le fond, ou un fichier sur un nœud pour l'y ajouter. » [C] ;
  - le dialogue gagne « Choisir un PDF… », à gauche de sa rangée de boutons [C], qui ouvre le sélecteur de fichiers du système, filtré sur les PDF. Les tests passent par `CIRRUS_PDF_PICK`, permis seulement sur une base de test, comme `CIRRUS_BIB_PICK` ;
  - son champ accepte toute adresse : « DOI, identifiant arXiv ou adresse d'un article ». Le texte d'aide devient : « Un DOI, un identifiant arXiv ou l'adresse d'un article ; ou dépose un PDF ici. » [C]. Une adresse qui mène à un PDF sans identifiant remplace un PDF déposé avant : la dernière demande gagne [C].
- **Non couvert :** l'import par le serveur d'une adresse qui mène à un PDF sans identifiant ; le transport est testé, mais aucun scénario de l'interface ne le joue, le rejeu des tests ne demandant jamais le serveur [C]. Les pages de test d'OpenReview, de PMLR et des actes de NeurIPS sont écrites de mémoire, sans réseau ; de vraies pages enregistrées pourront les remplacer.

## 13. LaTeX

- **Compilateur :** pdfLaTeX, comme Overleaf par défaut, via TinyTeX installé par l'app, après accord, dans le dossier local de l'utilisateur (D1, plus bas). TinyTeX pèse environ 74 Mo à télécharger sous Windows, et 313 Mo installé. L'app détecte elle-même les paquets manquants dans le journal et les installe avec `tlmgr`. La liste des paquets installés est un paramètre partagé, pour que tous les PC compilent la même chose [C].
- **Fichiers .tex de nœud :** ils n'ont pas de préambule. Un préambule global unique, versionné, sert à tous. Un .tex qui contient `\documentclass` est compilé tel quel.
- **Résumé et relation :** ils passent par la même chaîne.
- **Lieu :** la compilation se fait sur le PC, donc aussi hors ligne.
- **Cache :** les PDF produits restent en cache local sans être synchronisés.
- **Erreur :** le dernier PDF valide reste affiché, avec le journal à côté.
- **Sécurité :** aucune commande du document n'est exécutée (`\write18` est refusé). Un paquet comme `minted`, qui en a besoin, ne fonctionnera pas. Pour le document, TeX n'écrit que dans son dossier de travail, mais peut tout lire. Les outils de polices de TeX Live peuvent écrire dans TinyTeX (D4, plus bas).
- **Exigence explicite : temps de compilation minimaux.**
  - **Pas de compilation inutile :** chaque PDF est retrouvé par une empreinte de son contenu, du préambule et des titres cités. Après une synchro, les sources changées se recompilent en arrière-plan (plan 5b, plus bas), donc ouvrir un nœud ne compile presque jamais.
  - **Préambule chargé d'avance :** un processus pdfLaTeX est lancé à l'avance et attend après le préambule, puis reçoit le nœud. C'est la technique de TeX-fast-recompile, qui fonctionne avec tous les paquets. `mylatexformat` (2011) ne sert qu'en complément si les mesures le justifient.
  - **Une seule passe :** les liens vers d'autres nœuds sont fournis par l'app. Une seconde passe n'a lieu que si les références internes au nœud ont changé.
  - **Pendant la frappe :** toute modification interrompt la compilation en cours et en relance une après une courte pause (`latexTypingPauseMs`, 300 ms).
  - **Objectif :** moins de 300 ms pour l'aperçu d'un nœud ordinaire, à compter de la fin de la pause de frappe. C'est une cible, à mesurer en premier (section 21). Une figure TikZ lourde restera lente.
- **Noms accentués :** l'app compile sous des noms neutres, car l'outil cité signale des problèmes de noms accentués sous Windows. Un `\includegraphics` vers un fichier accentué compile (plan 4b).
- **Liens entre nœuds :**
  - `\label` alimente le registre global. Un doublon ou un lien cassé apparaît en rouge et dans la santé du graphe.
  - Dans un aperçu isolé, un `\ref` vers un autre nœud affiche le titre du nœud cible, faute de numéro. Dans le même nœud, et dans un document assemblé, les vrais numéros sont gardés.
  - `\cite` pointe vers le nœud de la publication et affiche une citation courte.
  - Les liens sont produits par `hyperref` avec un schéma d'URL propre à l'app, que le lecteur PDF intercepte.
- **Éditeur :** simple, avec coloration syntaxique, et suggestions pour `\ref` et `\cite` à partir des registres.

**Fixé par le plan 4b** (approuvé par l'utilisateur le 2026-11-05, avec D6 et D7 amendés ce jour-là, et D4 amendée ensuite par lui). Ici comme ailleurs, [C] marque un choix de Claude, fait pendant l'exécution ; le registre du plan (`docs/superpowers/plans/2026-11-05-cirrus-latex-registre.md`) en donne la raison et le coût. Ce que voit l'utilisateur du résumé compilé, de la relation et du plein écran d'un .tex est à la section 12.

- **D1, TinyTeX :**
  - il se télécharge la première fois qu'il sert, après l'accord de l'utilisateur, dans `%LOCALAPPDATA%\Cirrus\TinyTeX`. Une notice le propose une fois par session, avec « Installer » et « Plus tard ». La section « LaTeX » des réglages dit son état (« LaTeX : prêt (TeX Live 2026) ») et permet de l'installer à tout moment ;
  - la version est épinglée : TinyTeX v2026.11 (TeX Live 2026, pdfTeX 1.40.29), un installateur de 73,7 Mo vérifié par son empreinte SHA-256 avant d'être lancé. L'installation prend environ une minute (56 et 67 s mesurées), et fait 313 Mo ;
  - une installation à moitié faite ne compte jamais : elle se fait dans un dossier à part, renommé à la fin [C]. Pendant ce temps, un résumé dit « LaTeX est en cours d'installation. », puis se compile sans frappe ;
  - un téléchargement qui ne reçoit plus rien pendant `latexDownloadStallMs` (1 min) s'arrête. L'installation échoue alors avec « Le téléchargement de TinyTeX a échoué (aucune donnée depuis 60 s). », et la notice offre « Réessayer » [C] ;
  - les paquets viennent du dépôt de TeX Live, par le réseau de miroirs de CTAN, et non du miroir de TinyTeX, qui est un tiers [C] ;
  - un paquet manquant s'installe de lui-même : le fichier absent est lu dans le journal, `tlmgr` cherche le paquet qui le contient et l'installe, puis la compilation repart. Il faut de 10 à 20 s, parfois bien plus sur un miroir lent (154 s une fois). Le paquet s'ajoute au réglage partagé `latexPackages`, que chaque PC installe à son démarrage ;
  - un nom inconnu dans `latexPackages` ne rend jamais LaTeX impossible à installer : les paquets de base passent d'abord, ceux de l'utilisateur ensuite, chacun au mieux [C] ;
  - hors ligne, la compilation dit « Paquet LaTeX introuvable pour « x.sty » (hors ligne ?) ». Une recherche que `tlmgr` n'a pas pu faire (hors ligne, trop longue) est refaite par une compilation suivante, `latexLookupRetryMs` (1 min) après l'échec, et pas avant : les vues recompilent à chaque fin de recherche, et un `tlmgr` en échec tournerait sinon en boucle. Un fichier qu'aucun paquet ne contient n'est plus cherché avant le démarrage suivant [C]. Un appel à `tlmgr` qui dépasse `latexTlmgrTimeoutMs` (10 min) est arrêté, avec ce qu'il a lancé [C] ;
  - **signature des paquets :** TinyTeX ne livre pas gpg, et TeX Live n'en fournit aucun pour Windows. Le seul candidat, `tlgpg` de N. Preining, se dit lui-même hors de TeX Live : il n'a pas été intégré. Les paquets arrivent donc par HTTPS, et chacun est contrôlé par l'empreinte SHA-512 que donne la base de TeX Live, sans que la signature de cette base soit vérifiée. L'utilisateur a choisi d'en rester là, l'option la plus simple (2026-11-08). Le risque d'un miroir piraté se réduira au moment où le serveur copiera le dépôt (section 18) ;
  - limite connue : TeX Live gèle son dépôt chaque printemps. Vers avril 2027, le `tlmgr` de 2026 n'installera plus de paquet depuis Internet ; c'est l'échéance du dépôt figé du serveur (section 18).
- **D2, compilation et cache :**
  - `latexWarmProcesses` pdfLaTeX (2) attendent après le préambule, dans le principal. Dès qu'une compilation en prend un, un autre se prépare ;
  - chaque PDF est retrouvé par l'empreinte de tout ce qui entre dans sa compilation : la source, le préambule, les titres et les citations injectés, les fichiers du nœud, le mode, la largeur d'un résumé, les versions du moteur et du pilote. Le cache est plafonné à `latexCacheMb` (500 Mo). Au-delà, il est ramené à `latexCacheTrimPercent` (90 %) de ce plafond, le plus ancien partant le premier, pour que les suivants trouvent leur place sans nettoyage [C]. Il n'est jamais synchronisé. Ouvrir un pop-up dont le résumé est en cache ne compile pas ;
  - le dossier du cache est listé une fois par session, en arrière-plan, au démarrage. D'ici là, un PDF se retrouve par sa seule clé [C] ;
  - une compilation dure au plus `latexTimeoutMs` (10 s) : une boucle infinie est arrêtée, avec « Compilation trop longue (plus de 10 s) : arrêtée. ». Un préambule invalide le dit aussitôt : « Le préambule ne compile pas : … » ;
  - une seule passe, puisque l'app fournit les labels des autres sources. Une seconde n'a lieu que si les numéros de la source ont changé, relus de son `.aux`. Un .tex qui contient `\documentclass` est compilé tel quel, à froid, avec une seconde passe si son journal la demande [C] ;
  - aucun pdfLaTeX ne survit à la fermeture de l'app, ni rien de ce qu'il a lancé (D4).
- **D3, résumé et relation :** un PDF rogné à son contenu, de largeur fixe (section 12). KaTeX ou MathJax seraient instantanés, mais les macros du préambule leur manqueraient.
- **D4, ce que TeX peut faire** (décision de l'utilisateur, 2026-11-05 : « Pour ce qui est des tex, ne sois pas excessivement prudent, ce seront les miens ») :
  - TeX n'écrit, pour le document, que dans son dossier de travail (`openout_any=p`), et n'exécute aucune commande du document (`-no-shell-escape`, `shell_escape=f`) : `\write18` ne lance rien. Il ne peut pas atteindre les fichiers du magasin : un `\openout` vers le nom d'un fichier du nœud écrit un nouveau fichier dans le dossier de travail, et le chemin du dossier de liens est refusé. Le fichier du magasin reste identique, octet pour octet ;
  - exception : les outils de polices de TeX Live (`mktexpk`, `mktextfm`, `mf`) restent permis. kpathsea les lance pour produire une police qui manque, par exemple sous `[T1]{fontenc}` sans `lmodern`, et ils écrivent dans le `texmf-var` de TinyTeX, jamais dans le magasin. Produire une police manquante est le fonctionnement normal de TeX. Une annulation, un délai dépassé ou la fermeture de l'app arrêtent pdfLaTeX avec tout ce qu'il a lancé (`taskkill /t`) [C] ;
  - il peut lire tout fichier que le compte Windows peut lire : TeX Live 2026 a fait d'`openin_any` un réglage sans effet ;
  - les risques acceptés : un .tex venu d'ailleurs peut recopier un fichier local dans son propre PDF, qui ne quitte pas le cache local, ou faire contacter un serveur SMB par Windows (un nom UNC). Aucun bac à sable du système n'est prévu ;
  - les autres fichiers du nœud sont visibles sous leur nom (`\includegraphics{schéma_compression.png}`), par des liens physiques vers le magasin, dans un dossier que TeX lit sans pouvoir l'écrire. Une base dont le chemin porte des accents compile aussi : TeX y trouve ces fichiers par un chemin relatif [C] ;
  - un fichier du nœud absent du magasin de ce PC (un PDF jamais ouvert, qui reste au serveur jusqu'à sa première lecture ; un fichier reçu mais pas encore téléchargé) est laissé hors de la demande, avant le calcul de sa clé, pour les demandes de l'utilisateur comme pour celles du fond (revue finale du plan 5b). Une source qui ne s'en sert pas compile ; un `.tex` qui l'inclut reçoit l'erreur de TeX, son fichier introuvable. Le fichier arrivé, la demande suivante a une autre clé [C] ;
  - les variables de l'environnement de l'utilisateur qui déferaient cela (`TEXMFOUTPUT`, `TEXINPUTS`, `TEXMF_OUTPUT_DIRECTORY`…, et leurs variantes) sont retirées de celui de TeX [C] ;
  - tout texte que l'app injecte (titres, citations) devient une source inerte : un titre comme `50 % & co_x #1 {a} \input{x}` s'affiche tel qu'il est écrit. Un caractère que pdfLaTeX ne sait pas rendre devient « ? » [C].
- **D5, préambule :**
  - c'est une donnée de la base, versionnée : une opération `preamble`, qui entre dans l'historique et dans la synchro, et que Ctrl+Z annule. Le préambule par défaut n'est jamais stocké : une base sans préambule utilise `DEFAULT_PREAMBLE`, qui charge `article` (11 pt, A4), `fontenc` (T1), `lmodern`, `amsmath`, `amssymb`, `amsthm`, `graphicx`, `xcolor` et `hyperref` ;
  - il se modifie dans un plein écran ouvert par « Modifier le préambule… », dans la section « LaTeX » des réglages, avec à côté un exemple compilé : un paragraphe accentué, une équation numérotée citée par `\eqref`, une liste et un lien [C] ;
  - on l'enregistre explicitement, par « Enregistrer » ou Ctrl+S, qui attendent la compilation en cours. Un préambule qui ne compile pas demande « Le préambule ne compile pas. L'enregistrer quand même ? ». « Annuler » ferme sans rien demander [C]. Échap ou × avec des changements demandent « Abandonner les modifications du préambule ? ». « Préambule par défaut » remet `DEFAULT_PREAMBLE` dans le brouillon.
- **D6, un .tex se modifie dans son plein écran :** section 12.
- **D7, liens entre nœuds :**
  - un `\ref` vers un label d'un autre nœud affiche le titre de ce nœud, lié par `cirrus://node/<id>`. Un clic ouvre son pop-up (section 12) ;
  - un label se définit par `\label` dans un .tex, dans un résumé ou dans une relation, et pour le titre d'un nœud par le tag `label` (5.4) ;
  - dans la même source, les vrais numéros, par son `.aux` relu ; entre deux sources du même nœud, le titre du nœud [C] ;
  - un label que rien ne définit s'affiche en rouge, suivi de « ? ». Un label défini plusieurs fois s'affiche en rouge, avec le titre de sa première définition. Un label d'un nœud mis à la corbeille ne compte plus ;
  - `\cite{li2008}` affiche « [Li et Vitányi, 2008] », lié au nœud de la publication par son tag `clé_bibtex` (5.4). Une clé inconnue s'affiche en rouge, suivie de « ? » [C]. Une clé portée par deux nœuds s'affiche en rouge aussi, avec la citation du premier [C] ;
  - l'éditeur marque les mêmes fautes que l'aperçu.
- **D8, le registre des labels** est tenu par l'interface, dérivé des résumés, des relations, des tags `label` et des .tex. Il ne relit que les sources qui ont changé, et se reconstruit au plus une fois par pause de frappe : de 4 à 14 ms sur la base du banc, 50 000 nœuds et 549 189 connexions, sans .tex [C].
- **Mesures** (`docs/bancs/latex-app-2026-11-05.md`), dans l'app construite, sur la base de test, de la fin de la pause de frappe (`latexTypingPauseMs`, 300 ms) au canevas du nouveau PDF mis dans la page. Chaque frappe est suivie de 1,2 s de repos, et toutes les frappes de cette condition sont comptées, essais compris :
  - le résumé de l'entropie, dans son pop-up (63 frappes) : 176 ms en médiane, 243 ms au p95, 257 ms au plus ;
  - `complexité.tex`, dans son plein écran (69 frappes) : 254 ms en médiane, 288 ms au p95, 329 ms au plus. Les sessions se rangent vers 200 ms ou vers 260 ms, et la médiane dépend de celles qu'on compte ; la cause n'est pas établie ;
  - la cible de 300 ms est tenue au p95, mais pas à chaque frappe : une frappe du .tex sur 69 l'a dépassée (329 ms), et une autre, avec un repos de 0,8 s, a pris 306 ms. L'image suivante vient de 1 à 13 ms après le canevas (environ 4 ms en médiane) : pour le .tex, elle donne 291 ms au p95 et 331 ms au plus ;
  - la compilation, dans le principal, en prend environ les trois quarts (de 118 à 208 ms selon la frappe pour le résumé, de 131 à 239 ms pour le .tex). pdf.js, de la première réponse du PDF au canevas, prend de 25 à 56 ms pour le résumé, et de 41 à 95 ms pour le .tex. L'IPC, le rendu de React et la première réponse du PDF prennent environ 5 ms (de 4 à 8) ;
  - un pop-up rouvert dans la session, son résumé en cache : 17 ms. Le premier résumé d'une session : 0,49 s en cache, 0,62 s s'il faut compiler, dont 0,45 s pour charger pdf.js et son travailleur. Les charger d'avance, au repos, serait le levier suivant.
- **Hors du plan 4b :** la recompilation en arrière-plan après une synchro (faite au plan 5b, plus bas) ; le saut vers la cible avec « précédent » et « suivant » (fait au plan 6a, depuis le pop-up du lien : section 14), et l'aperçu au survol d'un lien (plan 6b) ; la liste des doublons et des liens cassés dans la santé du graphe ; l'assemblage des documents (section 15) ; SyncTeX ; l'installation de TinyTeX hors de Windows, où `CIRRUS_TINYTEX` désigne une TinyTeX existante.

**Fixé par le plan 5b** (écrit et exécuté en travail autonome le 2026-11-09 ; ses décisions sont de Claude, et l'utilisateur ne les a pas encore approuvées : section 4) : la recompilation en arrière-plan après une synchronisation. [C] marque, comme plus haut, un choix fait pendant l'exécution ; le registre du plan (`docs/superpowers/plans/2026-11-09-cirrus-synchro-suite-registre.md`) en donne la raison et le coût.

- **D1, ce qui se recompile :** les sources dont la demande de compilation a changé par une synchronisation, et elles seules [C] :
  - le résumé d'un nœud, la relation d'une connexion et les `.tex` d'un nœud, quand leur texte ou les fichiers du nœud ont changé ;
  - les sources qui citent un label dont les définitions ont changé (leur nombre, leur titre, leur nœud, leur place), ou une clé dont les porteurs, ou la citation courte du premier, ont changé : titre, nœud, tags `label`, `clé_bibtex`, `auteur`, `date_de_publication`, corbeille ;
  - toutes les sources quand le préambule a changé, sauf un `.tex` autonome, compilé sans lui ;
  - jamais un résumé ou une relation vide, que sa vue ne compile pas.
- **Où :** l'interface, qui tient l'état et le registre. Une action reçue par la synchronisation porte une marque explicite, jamais son libellé [C]. L'interface note ce que les synchronisations ont changé, et garde le registre d'avant la première [C]. À la reconstruction suivante du registre, une fois lus les `.tex` changés, elle calcule les sources touchées et leurs demandes. Elle les envoie au principal en un lot, dans des créneaux à part (`bg:<créneau>`), pour ne jamais annuler la compilation d'une vue ouverte.
  - L'index des sources qui citent chaque label et chaque clé est fait entier à la première synchronisation qui le demande, puis passé d'un registre au suivant, qui le corrige des seules sources analysées de nouveau : une construction ne coûte rien de plus tant qu'aucune synchronisation n'a eu lieu (sur la base du banc, de 50 à 55 ms avec ou sans l'index, et 21 ms une fois pour le faire) [C].
  - Une erreur de ce calcul se dit dans la console, et n'empêche jamais la construction du registre [C].
- **La priorité :** le principal compile ces demandes une à une, sur les pdfLaTeX préparés, comme celles de l'utilisateur, et seulement quand aucune compilation de l'utilisateur ne tourne ni n'attend.
  - Une demande de l'utilisateur qui va attendre un pdfLaTeX préparé arrête la compilation de fond si celle-ci attend aussi, ou si aucun n'est libre pour son préambule. Arrêtée, elle reprend sa place en tête de la file, puis repart au tour suivant de la boucle après la dernière demande de l'utilisateur [C].
  - Une demande de l'utilisateur pour la source même que le fond compile arrête celle du fond, qui n'est pas reprise : la vue la compile [C]. Le texte tapé dans cette source compte aussi, sous son propre créneau (`draft:<créneau>` : le plein écran d'un `.tex`, l'aperçu d'un champ ; revue finale du plan 5b) [C].
  - Une demande déjà en cache est sautée sans compiler, par une lecture du cache qui ne change ni son ordre ni la date du fichier (`PdfCache.has`).
  - Une compilation de fond ne part jamais à froid (un `.tex` autonome) tant qu'une demande de l'utilisateur est en vol, n'installe aucun paquet, et n'est pas gardée si son préambule n'est plus celui des pdfLaTeX préparés. Sans LaTeX, ou pendant que la réserve se repose après un échec, la file est vidée : chaque source se compilera à son ouverture, comme avant [C].
  - **Un pdfLaTeX gardé prêt pour l'utilisateur** (décidé après les mesures de la tâche 8) : une compilation de fond ne prend un pdfLaTeX préparé que si un autre reste prêt après elle. Avec `latexWarmProcesses` à 2, le fond n'en occupe qu'un et en laisse un prêt ; il avance donc au rythme des préparations, environ 0,44 s par source. « Prêt » s'entend d'un pdfLaTeX qui a fini de charger le préambule : un pdfLaTeX en cours de préparation ne compte pas, sinon le fond prendrait le dernier prêt et la frappe attendrait la préparation du suivant [C]. Avec un seul pdfLaTeX préparé, il n'y a rien à garder : seule la pause retient le fond.
  - **La pause pendant la frappe** (décidée de même) : après chaque demande de l'utilisateur, même servie par le cache [C], le fond ne commence aucune compilation pendant `latexBackgroundPauseMs` (2 s, réglage avancé, section 19). Une compilation de fond déjà partie suit la règle d'avant : une demande de l'utilisateur qui ne trouve aucun pdfLaTeX libre l'arrête, et elle reprend en tête de la file. La file repart d'elle-même quand la pause s'écoule sans nouvelle demande, par une seule minuterie, reposée à chaque demande. À 0, le fond repart dès que l'utilisateur n'a plus rien en vol, comme avant, avec la réserve.
- **L'ordre :** les résumés et les relations d'abord, puis les `.tex`, chacun dans l'ordre d'arrivée. Une demande nouvelle pour un même créneau remplace celle qui attend.
- **La borne :** `latexBackgroundMax` (300, de 0 à 5 000 par pas de 10, réglage avancé de la rubrique LaTeX) demandes au plus, celle qui tourne comprise [C]. Au-delà, les plus récentes ne sont pas gardées : elles se compileront à l'ouverture. 0 désactive la recompilation de fond. Les demandes refusées par le principal (une forme fausse) sont dites en une ligne de la console [C] ; un fichier absent du magasin n'en refuse aucune (plus haut).
- **Ce qui ne déclenche rien :** une action de ce PC, dont la vue ouverte compile déjà la source ; une base prise au serveur ; le démarrage.
- **Options écartées :** tenir l'état dans le principal, pour qu'il calcule seul les demandes, ce qui demanderait d'y porter le registre et de charger l'état une seconde fois ; tout recompiler après une synchronisation, contraire à « le coût suit ce qui change ».
- **Mesures de la tâche 8, avant la réserve et la pause** (sur ce PC, dans l'app construite, fenêtre en arrière-plan, la TinyTeX du banc et `latexWarmProcesses` 2 comme au plan 4b ; trois passes, chacune sur une base de test neuve à laquelle s'ajoutent 100 nœuds résumés, envoyée à un serveur de la machine par le bloc « Serveur » ; `npm run mesures -w packages/app -- latex-fond`, le registre du plan donne la méthode) :
  - un PC virtuel change les 100 résumés en une écriture : le premier PDF de fond est dans le cache 234 à 246 ms après elle, et le centième 23,6 à 24,2 s après, soit 157 ms par résumé en médiane. Pendant qu'on tape, il faut 28,3 à 29,8 s ;
  - l'aperçu d'un résumé qu'on tape, de la fin de la pause de frappe au canevas : sans compilation de fond, 167 ms en médiane et 185 ms au p95 (60 frappes, 192 ms au plus), comme au plan 4b. Pendant la compilation de fond des 100 résumés : 375 ms en médiane, 526 ms au p95 et 569 ms au plus (90 frappes). **La cible de 300 ms n'était pas tenue pendant le fond** : 79 frappes sur 90 la dépassaient. La cause : le fond prenait chaque pdfLaTeX préparé dès qu'il était prêt, si bien que la frappe n'en trouvait pas de libre ; elle arrêtait la compilation de fond, comme D1 le veut, puis attendait qu'un pdfLaTeX finisse de se préparer. Un essai avec `latexWarmProcesses` à 3 donnait 225 ms en médiane, mais 413 ms au p95. D'où la réserve et la pause, plus haut ;
  - un pop-up dont le fond a compilé le résumé s'ouvre, du relâchement du clic au canevas, en 36 ms en médiane et 50 ms au p95 (30 ouvertures, de 25 à 51 ms), sans aucune compilation : la cible de 50 ms est tenue au p95, mais une ouverture sur 30 l'a dépassée (50,5 ms). Le premier pop-up d'une session attend le chargement de pdf.js : de 0,46 à 0,79 s.
- **Mesures avec la réserve et la pause** (le même script, la même méthode, trois passes, 2026-11-09). Une seule différence : un tour avec frappe tape 15 frappes au plus, la moyenne des tours de la tâche 8, puis attend la fin du fond, qui sinon ne finirait jamais sous la pause [C] :
  - le fond seul met ses 100 PDF en 43,7 à 44,6 s (43,5 à 43,6 s dans la série à pause nulle), au lieu de 23,6 à 24,2 s : 438 ms par résumé en médiane et 483 ms au p95, de 404 à 551 ms, le rythme régulier des préparations ;
  - l'aperçu tapé, avec les réglages par défaut : 167 ms en médiane, 184 ms au p95 et 199 ms au plus pendant que le fond a ses 100 résumés à compiler (90 frappes), contre 169 et 196 ms sans fond (60 frappes). **La cible de 300 ms est tenue.** À ce rythme, une demande toutes les 1,7 à 1,9 s, la pause tait le fond : sur six tours, il n'a mis que trois PDF pendant la frappe, chacun avant la première demande de son tour, quand la précédente datait de plus de 2 s. Les 100 résumés sont prêts 70,2 à 70,7 s après l'écriture : 25 s de frappe, la pause, puis le fond seul ;
  - la réserve seule, `latexBackgroundPauseMs` à 0 : le fond compile pendant qu'on tape, de 43 à 48 PDF par tour de 25 s de frappe. L'aperçu tient pourtant 143 ms en médiane, 169 ms au p95 et 180 ms au plus (90 frappes), contre 165 et 184 ms sans fond (60 frappes) : la frappe trouve toujours un pdfLaTeX prêt. Qu'elle soit plus rapide pendant le fond que sans lui n'est pas expliqué ; le processeur, occupé, garde peut-être une fréquence plus haute. Les 100 résumés sont prêts de 47,8 à 49,9 s après l'écriture. La réserve suffit donc à tenir la cible, et la pause ajoute une marge : le fond ne commence rien pendant qu'on tape ;
  - un pop-up dont le fond a compilé le résumé : 36 ms en médiane, 38 ms au p95 et 39 ms au plus (30 ouvertures, aucune compilation), la cible de 50 ms tenue à chaque fois. Le premier pop-up d'une session, sans compilation lui non plus : de 0,61 à 0,88 s, et de 0,58 à 0,82 s avec la pause à 0, au lieu de 0,46 à 0,79 s. C'est le chargement de pdf.js dans la fenêtre, que le changement ne touche pas : l'écart n'est pas expliqué.

## 14. Navigation et recherche

- **Recherche instantanée** (Ctrl+K [C]) :
  - filtres sur le titre, les tags, le résumé, le contenu (désactivé par défaut, car il inclut les PDF) et le plan ;
  - les résultats s'affichent dans une liste déroulante, dans l'ordre : plan actuel, puis lobby pour ce qui n'est pas dans le plan, puis autres plans ;
  - les éléments trouvés sont mis en évidence dans le graphe ;
  - un index plein texte local assure la rapidité [C : FTS5 de SQLite].
- **Précédent et suivant :** ils concernent les sauts par hyperlien ou par recherche, y compris entre plans et lobby. Un simple déplacement n'y entre pas. Les raccourcis sont Alt+← et Alt+→, et les boutons latéraux de la souris [C].
- **Hyperliens** (`\ref`, `\cite`) :
  - le survol montre un aperçu ;
  - un clic gauche saute à la cible, avec le même ordre de priorité que la recherche ;
  - un clic droit laisse choisir le plan d'arrivée ;
  - on peut importer le nœud cible dans le plan actuel.
- **Autres plans :** le menu contextuel d'un nœud ou d'une connexion propose « voir dans un autre plan ».
- **Plus tard :** ouvrir le pop-up d'un nœud cité depuis un aperçu, récursivement, pour rassembler du contexte sans changer de plan.

**Fixé par le plan 6a** (écrit le 2026-11-09 et exécuté en travail autonome le 2026-11-10 ; ses décisions sont de Claude, et l'utilisateur ne les a pas encore approuvées : section 4) : la recherche (D1), les sauts avec « précédent » et « suivant » (D2), et « Voir dans un autre plan » (D3). [C] marque, comme plus haut, un choix fait pendant l'exécution ; le registre du plan (`docs/superpowers/plans/2026-11-10-cirrus-outils-essentiels-registre.md`) en donne la raison et le coût.
- **La boîte de Ctrl+K :** un champ en haut du graphe, centré sur lui et non sur la fenêtre, avec ses filtres et la liste des résultats dessous.
  - Chaque ligne montre le titre et l'endroit : « ce plan », « lobby », le nom d'un autre plan, ou « aucun plan » pour une annotation. Les flèches parcourent la liste, Entrée ou un clic saute au résultat, Échap ferme.
  - Les filtres : Titre, Tags et Résumé sont cochés ; Contenu (les `.tex`) ne l'est pas, ni « Ce plan seulement ». Le texte des PDF et des autres fichiers attend le plan 6b.
  - Ctrl+K marche partout, un champ de texte compris, sauf sous un plein écran ou l'éditeur du préambule, pendant une question, et dans un éditeur de code, où il garde son sens [C]. Il est entendu avant tout panneau : le pop-up d'une connexion, qui garde ses touches, ne l'avale pas [C]. Un second Ctrl+K rend le focus au champ et sélectionne ce qui y est tapé [C].
  - Un clic dans le graphe qui ferme les pop-ups libres ferme aussi la recherche [C]. Un plein écran qui s'ouvre la ferme. La boîte passe au-dessus des notifications [C].
  - Tant qu'elle est ouverte, les résultats du plan actuel sont cerclés dans le graphe, d'une couleur à eux, `searchFoundColor`, un vert (#5ee38f), sans devenir une sélection [C]. Une connexion est cerclée par ses extrémités dessinées dans le plan [C]. Le cercle se dessine après celui des intrus et avant le dépôt et la sélection : un objet trouvé et sélectionné montre la sélection [C].
- **L'index,** en mémoire (section 4), garde pour chaque nœud, et pour chaque connexion de connaissance, hors de la corbeille :
  - le titre ;
  - les tags, clé et valeur, tels que l'objet les porte : une valeur par défaut, qui serait sur tous, n'y est pas [C] ;
  - le résumé, ou la relation d'une connexion ;
  - le texte de ses `.tex`, déjà lus pour le registre des labels (section 13).

  Une connexion d'inclusion ou de structure n'y est pas [C]. Tout est replié, sans casse ni accents, « œ » et « æ » valant deux lettres : « noeud » trouve « Nœud » [C]. Un « mot » de plus de 100 caractères (une empreinte, du base64 dans un `.tex`) n'est pas gardé [C]. Les plans d'un objet ne sont pas dans l'index : la requête les lit pour ce qu'elle trouve, dans l'état du moment [C]. Le texte nouveau d'un `.tex` se relit par tranches dans les moments libres, jamais pendant un rendu [C].
- **Sa construction :** une fois au chargement, par tranches de `searchBuildSliceMs` (8 ms) au plus, dans les moments libres, après la première image [C]. Un moment libre en enchaîne plusieurs, tant qu'il dure plus d'1 ms et qu'aucune touche ni aucun clic n'attend (`navigator.scheduling.isInputPending`, sans compter la souris ni la molette) ; la première tranche d'un moment est toujours faite, et, sans `isInputPending`, c'est la seule [C]. La relecture des `.tex` en fait autant. Le banc et les captures ne la font qu'au premier Ctrl+K. Jusque-là, la boîte dit « Préparation de la recherche… ». Les actions faites pendant ce temps lui sont données à la fin. Ensuite, chaque action ne relit que les nœuds et les connexions qu'elle touche, même quand plusieurs actions arrivent en un seul rendu [C].
- **La requête :** chaque mot tapé doit être le début d'un mot de l'objet, dans les champs choisis : « enon comp » trouve « Énoncé de la complexité ». Les mots peuvent se trouver dans deux champs différents [C]. Une frappe qui précise la précédente ne relit que ce que celle-ci avait trouvé [C].
- **L'ordre des résultats :** ce qui est dans le plan actuel, puis dans le lobby, puis dans les autres plans, puis dans aucun plan. Dans chaque groupe, un titre qui répond passe avant les tags, qui passent avant le résumé et le contenu ; le champ d'un résultat est le moins bon de ceux où se trouve chacun de ses mots [C]. À égalité, l'ordre des mots du titre, repliés, comme dans un dictionnaire, puis l'ordre français [C]. Au plus `searchMaxResults` (50) résultats.
- **Le saut** (D2) va dans ce plan si l'objet y est, sinon dans le lobby, sinon dans le premier autre plan qui l'a, dans l'ordre des onglets puis des noms. Il ouvre le plan dans son onglet s'il le faut, cadre l'objet comme le coin de la hiérarchie (une connexion par ses extrémités dessinées), et le cercle un instant, `searchFlashMs` (1,2 s). Un objet dans aucun plan, une annotation, ouvre son pop-up sous la boîte [C] ; une connexion vivante qu'aucun plan ne montre (restaurée sans branche) le dit : « Cette connexion n’est dans aucun plan : aucun plan ne réunit deux de ses nœuds. » [C]. Un objet jeté ou retiré entre-temps le dit : « Cet objet n’est plus là : il a été jeté, ou retiré de ce plan. », le message de tous les sauts [C].
- **Ce qui saute :** un résultat de la recherche ; « Voir dans un autre plan » ; un bouton de plan dans le pop-up d'un nœud, qui cadre désormais le nœud (« Voir ce nœud dans ce plan ») [C] ; « S'y téléporter », qui garde son centrage au zoom courant [C] ; et « Aller au nœud », nouveau, dans le pop-up qu'un lien a ouvert, si le nœud est dans un plan [C].
- **Les liens :** un clic sur un lien `\ref` ou `\cite` ouvre toujours le pop-up du nœud (section 13, plan 4b, D7, plus récent que la ligne « un clic gauche saute à la cible » ci-dessus) [C]. Le saut se fait de ce pop-up, par « Aller au nœud ».
- **« Précédent » et « suivant » :**
  - chaque saut pousse sur une pile l'endroit d'où l'on part : le plan et sa caméra. Alt+← revient en arrière, Alt+→ repart en avant, comme les boutons latéraux de la souris ; un saut fait après un retour efface ce qui était en avant ;
  - au plus `navHistoryMax` (100) endroits, pour la session seulement. Un simple déplacement de la vue n'y entre pas. Un endroit dont le plan a disparu est sauté, de même qu'un endroit identique à celui où l'on est [C] ;
  - un retour ne cercle rien. Il attend la fin d'un geste en cours, comme Ctrl+Z [C] ;
  - Alt+← et Alt+→ marchent partout hors plein écran ; un champ de texte, un champ LaTeX en édition, l'éditeur du titre et CodeMirror les gardent, de même que les boutons latéraux [C]. Les quatre flèches avec Alt ne déplacent plus la vue ; les flèches seules la déplacent toujours [C]. Les boutons latéraux ne comptent plus comme un clic gauche dans le graphe ;
  - le principal écoute aussi les commandes « navigateur » de Windows (`app-command`) : les touches de certains claviers, ou une souris dont le pilote les envoie. Mesuré : un bouton latéral n'en produit pas, Chromium le donne à la page comme un `mouseup` [C].
- **« Voir dans un autre plan »** (D3) est la dernière entrée du menu d'un nœud, d'un groupe ou d'une connexion qui sont aussi dans un autre plan que celui-ci ; pas d'un fantôme, d'une amorce, du fond ni d'une sélection de plusieurs objets [C]. Le lobby compte comme un plan, un plan document aussi. Avec un seul autre plan, il y saute ; avec plusieurs, une question les liste par leur nom : le lobby, puis les onglets ouverts dans leur ordre, puis les autres plans par leur nom [C].
- **Option écartée :** l'index plein texte FTS5 de SQLite, que cette section avait choisi (section 4).
- **Mesures** (tâche 6, sur ce PC, trois passes chacune, `npm run mesures -w packages/app -- recherche` ; le registre du plan donne la méthode). Dans l'app construite, sa fenêtre hors de l'écran, sur la base de référence (50 000 nœuds et 500 000 connexions ; ses titres sont « Nœud n », sans résumé ni tag) et sur la même base « enrichie » : chaque nœud y a un titre de mots, un résumé de 50 à 110 mots et trois tags, tirés d'un vocabulaire de 3 197 mots [C].
  - **Une frappe,** de la touche à l'image qui montre la liste : 13,2 ms en médiane et 23,8 ms au p95 sur la base de référence (135 frappes), 19,6 et 28,1 ms sur la base enrichie (267 frappes), lettres seules et rafales comprises (une touche toutes les 35 ms). **Le critère, un p95 sous 50 ms, est tenu.** Deux frappes passent 50 ms sur chaque base : 57 et 71 ms, 52 et 83 ms. Une lettre seule, qui trouve presque tout : 23,6 et 25,4 ms au p95.
  - **La construction de l'index au chargement** commence 5 à 11 ms après la première image, par tranches de 8,5 ms au p95 et 10,4 ms au plus, sans aucune tâche de plus de 50 ms : elle ne retarde pas la première image. Sans elle (`requestIdleCallback` coupé), la première image vient 1 508 à 1 608 ms après la navigation, et avec elle 1 605 à 1 767 ms ; mais l'écart, entre deux chargements de la même session, est déjà là avant que l'état ne soit prêt, et sur la base enrichie il va dans les deux sens (2 459 à 3 178 ms sans, 2 514 à 3 164 ms avec). Son travail : 0,39 à 0,44 s sur la base de référence, 1,95 à 2,11 s sur la base enrichie. Mesurée ainsi, elle n'avançait que d'une tranche par moment libre, une toutes les 60 ms environ quand la fenêtre est au repos : l'index était prêt 2,8 à 3,2 s après la première image sur la base de référence, et 14,6 à 15,8 s sur la base enrichie, ce qui est le « avant ». Elle enchaîne depuis ses tranches dans un même moment libre, tant qu'il reste plus d'1 ms et qu'aucune touche ni aucun clic n'attend (`navigator.scheduling.isInputPending({ includeContinuous: false })`) [C]. **L'effet attendu n'est pas mesuré :** le temps jusqu'à l'index prêt, et ce qu'une molette ou un survol attend pendant la construction (au plus un moment libre, 50 ms, au lieu d'une tranche de 8 ms ; une touche ou un clic interrompent, eux, après une tranche au plus), sont à mesurer à une exécution ultérieure ; on ne sait pas non plus si `navigator.scheduling` est exposé par Electron 45 à l'exécution, la chaîne `isInputPending` étant dans son binaire. Sans lui, la construction se fait comme avant, une tranche par moment. Jusque-là, Ctrl+K dit « Préparation de la recherche… » (section 24).
  - **Une action ordinaire :** la mise à jour de l'index coûte à un renommage 0,1 ms en médiane et 0,3 ms au plus sur la base de référence, 0,3 et 0,5 ms sur la base enrichie ; à un déplacement, qui ne relit rien, 0 ms en médiane et 0,9 ms au plus. De l'Entrée à l'image, un renommage prend 25 ms en médiane sans l'index et 24,6 ms avec (48,8 et 45,3 ms sur la base enrichie), hors le premier de chaque session, de 90 à 234 ms avec ou sans : l'écart est dans le bruit. Un déplacement, du relâchement à l'image, avec l'index : 16,4 ms en médiane et 24,9 ms au p95 (36,8 et 45,1 ms sur la base enrichie).
  - **Le dessin avec le cercle :** pendant un zoom à la molette, une image prend 0,3 à 0,4 ms de processeur en médiane et 1,5 à 2,1 ms au p95, et 0,85 à 0,89 ms de carte graphique en médiane et 1,26 à 1,30 ms au p95, avec ou sans le cercle, de 50 résultats comme de 500 (`searchMaxResults` au plus) : aucun écart mesurable.
- **Hors du plan 6a :** l'aperçu au survol d'un lien, le choix du plan d'arrivée au clic droit et l'import du nœud cible ; le texte des PDF et des autres fichiers dans la recherche (plan 6b, section 24).

## 15. Documents

- **Plan document :** un type de plan entièrement dédié à un document, utilisé à côté d'un plan ordinaire où l'utilisateur organise ses idées. Les connexions de connaissance n'y sont pas affichées.
- **Arbre :** le document est un arbre construit avec les primitives du graphe.
  - **Racine :** elle porte le titre du document. Son dossier contient le modèle de conférence (.cls, .sty, .bst) et les auteurs [C, accepté].
  - **Parties :** une connexion `partie:X` fait du nœud cible la partie X de la section du nœud source. Seul l'ordre compte. La profondeur 1 donne `\section`, la 2 `\subsection` et la 3 `\subsubsection`.
  - **Suivants :** un nœud partie peut pointer vers un **suivant**, rendu en `\paragraph{titre du suivant}` puis contenu, dans la même partie, et ainsi de suite en chaîne.
  - **Nœuds spéciaux :** par tag, le résumé et les annexes. L'introduction est une simple partie 1 [C, accepté].
  - **Liant :** les nœuds de liant sont exclusifs au plan.
- **Contenu d'une partie :** son titre est celui du nœud, sauf si la connexion qui l'attache porte un titre court. Son corps est formé des fichiers retenus du nœud, dans l'ordre choisi.
- **Données propres au document :** le rang, les fichiers retenus et le titre de remplacement sont portés par la connexion qui attache le nœud. Un nœud n'apparaît qu'une fois par document.
- **Panneau « sommaire »** (accepté, à condition d'être ergonomique) :
  - Chaque ligne affiche un numéro (1, 1.2…) ou ¶ pour un suivant, puis le titre.
  - En bas du panneau, la ligne sélectionnée montre ses fichiers, avec une case à cocher et un ordre réglable par déplacement.
  - **Tab :** fait de la ligne une sous-partie de la précédente.
  - **Maj+Tab :** remonte d'un niveau.
  - **Alt+↑ et Alt+↓ :** déplacent la ligne avec tout son contenu.
  - **Déplacement à la souris :** la hauteur choisit la place, le décalage horizontal le niveau. Un trait montre où la ligne atterrira, et seules les places valides sont proposées.
  - **Partie ou suivant :** un clic sur le numéro ou le ¶ bascule de l'un à l'autre, ou un raccourci réglable.
  - **← et → :** plient et déplient.
  - **Suppr :** retire la ligne et tout son sous-arbre du document, les nœuds restant dans le plan.
  - **+ :** ajoute un nœud par son titre, avec suggestions. On peut aussi déposer un nœud du plan dans le sommaire.
  - **Sélection multiple :** Ctrl+clic et Maj+clic sélectionnent plusieurs lignes, qui bougent ensemble.
  - **Lien avec le plan :** survoler une ligne surligne son nœud dans le plan, un clic la sélectionne et un double-clic ouvre le pop-up du nœud.
  - **Nouveau liant :** créé depuis le panneau, il suit le curseur dans le plan jusqu'au clic qui le pose.
  - **Contraintes :** une ligne déplacée emporte toujours ses sous-parties et ses suivants. Un suivant reste juste sous sa partie, avant les sous-parties, car LaTeX rattacherait un `\paragraph` placé après une `\subsection` à cette dernière. Une partie qui a des sous-parties ne peut pas devenir un suivant, et l'app explique pourquoi.
  - Le panneau écrit les mêmes données que les connexions tracées dans le plan.
- **Génération :**
  - les titres Unicode sont convertis pour pdfLaTeX (θ → `$\theta$`) ;
  - `\cite` alimente un .bib automatique ;
  - un `\ref` vers un nœud absent du document est signalé dans le panneau ;
  - une image devient une figure et un .py un listing, les détails restant à fixer ;
  - un fichier ajouté au nœud après coup reste décoché et signalé ;
  - un document peut désactiver un paquet du préambule global incompatible avec son modèle.
- **Réactivité :** le document réagit aux modifications des nœuds faites dans d'autres plans.
- **Export [C] :** un dossier contenant `main.tex`, un fichier par section, les figures, le `.bib` et le modèle, prêt pour Overleaf. On ne fige pas de version.

## 16. LLM

### 16.1 Conversations : serveur MCP

- **Clients :** l'utilisateur discute avec Claude depuis Claude Code, ou avec GPT depuis l'app ChatGPT. GPT ne sert qu'aux conversations qui passent par le MCP.
- **Consommation :** les deux consomment l'abonnement de l'utilisateur, pas l'API.
- **Serveur :** un seul serveur MCP, hébergé sur le serveur Cirrus et commun aux deux clients. L'app ChatGPT n'accepte que des serveurs MCP distants, via son mode développeur, encore en bêta.
- **Lecture seule stricte :** aucun outil d'écriture, et un accès à la base en lecture seule. « Le LLM n'a pas le droit d'éditer la database. »
- **Accès :** OAuth obligatoire, avec l'utilisateur comme seul compte. Mot de passe et code TOTP [C]. L'accès sans authentification est exclu.
- **Outils de la première version :**
  - **sommaire :** titres et résumés, par pages, filtrables par tag ou par plan, c'est-à-dire la liste de tous les nœuds avec leur résumé que demande la spécification ;
  - **recherche :** la même que dans l'app ;
  - **lecture d'un nœud :** métadonnées, liste des fichiers et contenu texte ;
  - **voisinage :** connexions et groupes d'un nœud ;
  - **plan :** nœuds et connexions d'un plan.
  Chaque réponse est plafonnée en taille, avec une suite par pages, pour ne pas déborder le contexte du LLM.
- **« Copier pour un LLM »** dans le menu de sélection : les titres, résumés, .tex et connexions sélectionnés partent en Markdown dans le presse-papiers. Cela fonctionne partout.
- **Test en local :** le MCP doit aussi tourner en local. Claude Code peut s'y connecter, mais ChatGPT ne le pourra qu'une fois le serveur public en HTTPS.

### 16.2 Veille

- **Fonctionnement :** sur le serveur, à fréquence réglable, un LLM Claude (Sonnet ou Haiku) veille des sujets, des auteurs ou des organisations, via l'API d'Anthropic.
- **Périmètre :** il n'accède pas à toute la base. Il ne voit que :
  - ses instructions de veille ;
  - un document persistant par sujet, qu'il enrichit des liens, noms et sources récurrentes, ainsi que des retours de l'utilisateur ;
  - en lecture, les nœuds de publications externes, pour ne pas recommander ce qui est déjà connu.
- **Interdits :** il n'exécute rien. Il dispose d'Internet, par la recherche et la lecture web de l'API, et peut seulement écrire dans son dossier et son rapport.
- **Rapport :** des liens vers l'information pertinente, avec éventuellement des extraits en texte quand il s'agit d'un fragment d'une grosse page.
- **Processus :** la veille tourne dans un processus séparé, sans droit d'écriture sur la base [C].
- **Budgets :**
  - deux plafonds de tokens, un mensuel et un par session de veille ;
  - le LLM connaît son budget, pour répartir son effort uniformément, et signale s'il est insuffisant ;
  - le serveur coupe lui-même la session, car le budget communiqué au modèle (« task budget », en bêta) n'est qu'indicatif ;
  - le nombre de recherches web est aussi plafonné, chacune coûtant environ 1 centime en plus des tokens.
- **Facturation :**
  - les forfaits Max et Ultra incluent respectivement 100 $ et 200 $ de crédits API par mois, sans report, inutilisables dans Claude Code ;
  - à épuisement, si aucun crédit n'a été acheté, l'API s'arrête sans rien facturer au forfait ;
  - la veille a son propre espace de travail Console, avec sa limite de dépense [C].
- **Clé API :** elle reste uniquement sur le serveur. Une variable `ANTHROPIC_API_KEY` sur un PC ferait facturer Claude Code à l'API au lieu de l'abonnement.
- **Abonnement :** il n'est pas utilisé pour la veille, car son usage planifié sans l'utilisateur n'est pas clairement permis.
- **Avant de coder :** vérifier dans la documentation de l'API les identifiants de modèles, les versions des outils de recherche et le paramètre de budget.

### 16.3 Journal des veilles

- **Onglet « journal » :** la liste chronologique des bilans, chacun archivé une fois traité.
- **Tri :** un mécanisme de priorité et des quotas de suggestions limitent le volume, pour que l'utilisateur ne s'y noie pas.
- **Lecture :** l'utilisateur lit intégralement toute suggestion avant de l'intégrer au graphe, par l'import de publications.
- **Retour :** un motif de rejet ou d'acceptation, facultatif, est transmis au document persistant du sujet.
- **Provenance :** on ne trace pas si un nœud vient d'une suggestion du LLM.

## 17. Agenda et feuillets

- **Agenda :** un onglet ouvert depuis le menu, en forme de frise chronologique qu'on peut remonter dans le passé. Il ne contient que ce que l'utilisateur y écrit, sans trace automatique.
  - **Entrées [C] :** une date, un titre, un texte facultatif et des liens éventuels vers des nœuds.
  - **Rappels [C] :** aucun dans la première version.
- **Feuillets :** des notes éparses et temporaires, dans un onglet à part, listées par date. Ils précisent le « bloc-notes global ».
  - **Usage [C] :**
    - un feuillet peut devenir un nœud en une action ;
    - rien ne s'efface automatiquement, chaque feuillet affichant son âge ;
    - un raccourci dans l'app crée un feuillet.
  - **Historique :** les feuillets sont des éditions comme les autres, donc ils entrent dans l'historique et se défont par Ctrl+Z.
- **Méta du travail :** plus tard.

## 18. Serveur, sécurité et déploiement

- **D'abord en local :** pendant le développement, le serveur tourne sur le PC de l'utilisateur, avec le même code. On ne loue qu'une fois tout validé.
- **Le serveur local** (plan 5a, D1 et D2 ; architecture à la section 4) : `npm run serveur -w packages/server -- [--data <dossier>] [--port 7310]`. Ses données vont par défaut dans `%LOCALAPPDATA%\Cirrus\serveur` : `base/`, une base au format d'un PC, et `serveur.db`, pour les PC jumelés, les codes en attente et les réglages partagés. Un seul serveur tourne par dossier, par le verrou de sa base [C].
  - **Il n'écoute que sur la machine** (`127.0.0.1` ou `::1`), et refuse de démarrer sur une autre adresse : sur le serveur loué, Caddy, devant lui, porte le HTTPS (plan 9, plus bas). Il ne répond à aucune requête d'un navigateur : aucun en-tête CORS, un en-tête `Host` qui doit nommer la machine, ou depuis le plan 9 un nom qu'on lui a donné (contre une page qui ferait pointer son domaine sur elle), et un `Content-Type: application/json` exigé pour tout corps JSON [C].
  - **Toute entrée est vérifiée avant toute écriture :** le JSON, la forme de chaque opération, les empreintes, les tailles. La forme est lue strictement : un champ inconnu est refusé [C]. Un refus ne laisse rien d'écrit, et le serveur continue.
  - **Une action reçue** passe, dans l'ordre : sa forme ; le PC du jeton, qui seul peut signer ses actions ; une action déjà connue, acceptée avec son numéro ; un fichier manquant, qui la refuse ; ses « avant », sinon elle est « en retard » ; les règles du graphe, sinon elle est refusée ; l'écriture dans la base, synchronisée sur le disque à chaque action, pour qu'une coupure de courant ne fasse jamais redonner un numéro déjà relayé [C] ; enfin le relais à tous les flux ouverts.
  - **Son instantané** s'écrit toutes les `SERVER_SNAPSHOT_UNITS` (500) actions et à l'arrêt. Avec la base de référence, il redémarre sur lui en 0,4 s.
- **Le jumelage** (plan 5a, D3) :
  - sur le serveur, `npm run serveur -w packages/server -- jumeler "Portable"` affiche un code de 16 caractères (80 bits), en quatre groupes (`ABCD-EFGH-JKMN-PQRS`) ; à la saisie, la casse, les tirets et les espaces ne comptent pas [C]. Il ne sert qu'une fois, et expire après 10 minutes ou 5 essais faux, comptés contre chaque code en attente [C] ;
  - dans Cirrus, Réglages › Serveur (section 19) : l'adresse du serveur, ce code et le nom de ce PC. Le PC reçoit un jeton de 256 bits. Sans HTTPS, seul un serveur de cette machine est accepté : le code et le jeton ne passent jamais en clair sur le réseau [C] ;
  - le serveur ne garde que l'empreinte SHA-256 du jeton. Le PC garde le jeton chiffré par Windows (`safeStorage`, DPAPI) dans `serveur.json`, à côté de sa base : une base de test ne peut donc jamais parler au serveur de l'utilisateur. Si Windows ne peut pas le chiffrer, le jumelage est refusé ;
  - `pcs` liste les PC jumelés et les codes en attente, et `revoquer "Portable"` en retire un : son jeton est refusé dès la requête suivante. Un PC révoque aussi son propre jeton quand on annule son premier jumelage, quand celui-ci échoue, et par « Dissocier ce PC » [C] ;
  - **options écartées :** un mot de passe (il faudrait le stocker et le protéger contre les essais) ; OAuth, prévu pour le MCP et trop lourd pour la synchro ; des certificats clients, pénibles sous Windows ;
  - sur le serveur loué, l'utilisateur lance les mêmes commandes par SSH : `cirrus-serveur jumeler "Portable"` (plan 9, plus bas).
- **Les routes** (en JSON, sauf mention ; toutes exigent le jeton du PC, sauf `/pair` et, depuis le plan 9, `/installer`) :
  - `POST /pair` échange le code contre un jeton ; `POST /unpair` révoque le jeton qui la porte, et lui seul [C] ;
  - `GET /hello`, avec les versions du PC dans ses en-têtes (18.1), rend l'heure du serveur, son dernier numéro, s'il tient une base, son nombre de nœuds et l'identité de sa base (6.6, D7) ;
  - `GET /events` est le flux, qui reprend à `Last-Event-ID`. `event: unit` porte une action numérotée, `event: settings` des réglages changés, et un commentaire `: ping` part toutes les 15 s ;
  - `POST /units` reçoit des actions, traitées dans l'ordre : chacune est « acceptée » (avec son numéro), « en retard » ou « refusée » (avec sa raison). Après la première non acceptée, les suivantes sont « en retard » ;
  - `POST /files/missing` dit quels fichiers manquent ; `PUT /files/<empreinte>` reçoit des octets bruts, et `GET /files/<empreinte>` les rend ;
  - `GET /snapshot` rend l'état encodé et le numéro qu'il couvre ; `GET /journal` rend le journal par pages, pour l'historique ;
  - `POST /seed`, `/seed/journal` et `/seed/done` reçoivent la base d'un PC, sur un serveur qui n'en tient aucune (6.6, D7). Le dernier PC qui commence un envoi le mène, et un envoi partiel reste invisible jusqu'à `done`. `POST /seed` rend l'identité que la base aura, tirée par le serveur ; `done` la lui donne, et la rend [C] ;
  - `GET /settings` et `POST /settings` : les réglages partagés (section 19) ;
  - depuis le plan 5b : `POST /publications` importe une publication pour le PC (section 12, plus bas) ; `PUT /presence` remplace la liste des `.tex` que ce PC a ouverts, et rend ceux des autres PC (section 6.1) ; `GET /status` rend la taille de la base, celle du magasin, son nombre de fichiers, l'espace libre du disque, et si le premier compte du magasin court encore (section 20) ;
  - depuis le plan 9 : `/hello` rend aussi la version officielle que le serveur sert (`version`) ; `GET /versions/version.json`, `version.json.sig`, `latest.yml` et l'installateur que nomme le manifeste servent les mises à jour (18.1), et rien d'autre de ce dossier [C] ; `GET` et `POST /installer` sont la page de téléchargement (plus bas).
- **Ce que le serveur sert de plus** (plan 5b) :
  - **`POST /publications`** prend exactement `{ text, pdf?: false, maxKb, maxPdfBytes, timeoutMs, pdfMaxMs }` : les plafonds de ce PC, que le serveur ramène sous ses propres bornes. Un champ inconnu, un nombre qui n'est pas fini et au-dessus de zéro, un texte trop long : 400, « Demande d'import invalide : … » [C]. L'ordre est le jeton, le corps, la place, puis l'import ; rien n'est écrit avant l'import [C]. Au-delà de deux imports à la fois : 503, « Le serveur importe déjà d'autres publications : réessaie dans un instant. ». Son réseau qui n'aboutit pas répond 502, et le PC importe alors lui-même [C]. Il passe par `fetch` de Node, les redirections suivies à la main, et par le réseau ouvert gardé de `@cirrus/sources`, sans rien desserrer de ses gardes ;
  - **`PUT /presence`** prend `{ open: [{ node, name }] }`, vérifié en entier avant toute écriture, et range chaque fichier par PC, nœud et nom comparé comme au réimport (migration v3 de `serveur.db`) [C]. Le serveur n'exige pas l'extension `.tex` : il range des fichiers ouverts, quels qu'ils soient ;
  - **`GET /status`** : la base est la taille de `cirrus.db` et de ses fichiers `-wal` et `-shm`, l'espace libre celui du disque des données [C]. Le serveur compte son magasin une fois au démarrage, en fond, par la seule taille de ses fichiers, puis ajoute chaque fichier qu'il place, reçu d'un PC ou importé par lui ; un fichier reçu deux fois à la fois compte une fois [C].
- **Les bornes** du serveur sont des constantes nommées et documentées (`packages/server/src/bounds.ts`), pas des réglages, car le serveur sert tous les PC :
  - 64 Mio par requête d'actions (`MAX_BODY_BYTES`, aussi pour les autres requêtes JSON d'un PC jumelé), 100 actions par requête, 200 000 opérations par action ;
  - 1 Gio par fichier, 2 Gio pour l'instantané d'une base envoyée, 10 000 lignes par page du journal ;
  - un `: ping` toutes les 15 s ; un code de jumelage valable 10 min et 5 essais ;
  - et aussi [C] : 4 Kio pour `/pair` et 64 caractères pour son code, 10 000 empreintes par requête, 100 caractères pour le nom d'un PC, 128 pour un identifiant ou une clé de tag qu'une action ajoute, 500 pour le libellé d'une action, un instantané toutes les 500 actions, 5 s d'attente pour écrire `serveur.db` ; pour les réglages (section 19), 500 par requête, 1 000 gardés en tout, 64 caractères par clé, 64 Kio par valeur, et une heure d'au plus un jour d'avance sur celle du serveur ;
  - depuis le plan 5b : 16 Kio pour le corps de `/publications` (un texte de 2 048 caractères, chacun de 6 octets au plus en JSON, et les plafonds ; revue finale), 2 imports à la fois, 60 s par échange et 8 Mio de métadonnées, 10 min pour télécharger un PDF [C], dont la taille reste bornée par celle d'un fichier ; 100 `.tex` ouverts par PC et 64 Kio pour le corps de `/presence` [C] ;
  - depuis le plan 9 : 1 Kio pour le formulaire de `/installer`, 64 Kio pour un petit fichier des versions [C], et les délais du serveur (plus bas).
  - Le PC applique à chacune de ses actions, au moment où elle est faite, le contrôle du serveur : une action qu'il refuserait est refusée tout de suite, avec un message en français, et n'est jamais défaite après coup. Supprimer d'un coup plus de 200 000 objets se fait en plusieurs fois (revue finale du plan 5a) [C].
  - Celles qu'un PC doit respecter aussi sont au cœur, que `bounds.ts` reprend : le client de synchro découpe ses envois pour ne jamais les dépasser [C].
- **Hébergement [C, accepté] :**
  - Hetzner Cloud CX23 : 2 vCPU, 4 Go de mémoire, 40 Go de SSD, en Allemagne.
  - Environ 4,49 € par mois, IPv4 comprise, selon des sources secondaires, à confirmer à la commande.
  - Une source signale que cette gamme était parfois impossible à commander en septembre et octobre 2026. Le repli est OVH VPS-1, en France, autour de 8 € HT par mois.
  - S'y ajoute un nom de domaine, environ 10 € par an, pour le HTTPS.
- **Rôle du serveur :** synchroniser, stocker les PDF, importer une publication à la demande d'un PC (plan 5b), servir le MCP, lancer la veille, héberger l'installateur et les mises à jour, et garder une copie du code. Il ne compile pas de LaTeX.
- **Outils de LaTeX sur le serveur** (demande de l'utilisateur, 2026-11-05 : « mettre tous les utils sur le serveur, de manière à ce que l'utilisateur n'aille rien chercher sur internet, afin de ne pas casser l'app si une version ultérieure non rétrocompatible était publiée ») :
  - le serveur gardera l'installateur épinglé de TinyTeX, et un instantané figé, tel quel, du dépôt de TeX Live de l'année : environ 5 Go. La signature de TeX Live y reste, sans être vérifiée : l'utilisateur a choisi de rester sans gpg (section 13) ;
  - les PC ne téléchargeront que depuis lui, et passer à une TeX Live plus récente deviendra un acte délibéré ;
  - toutes les sources de téléchargement sont déjà dans un seul module du principal (`LATEX_SOURCES`), et `tlmgr` nomme son dépôt à chaque appel : les installations faites avant le serveur le suivront aussi ;
  - jusqu'à ce que le serveur loué garde ce dépôt, ce que le plan 9 n'a pas fait (section 24), les PC vont sur Internet, le serveur local du plan 5a n'en gardant aucun. Le gel de printemps de TeX Live, vers avril 2027, est l'échéance.
- **Sources des publications** (plan 4c, D5, D6 ; plan 5b, D2 à D4) : le serveur récupère les métadonnées et le PDF d'une publication pour un PC jumelé et connecté ; sinon, le principal du PC le fait (section 12).
  - Toutes les adresses sont dans un seul module, `PUBLICATION_SOURCES`, comme `LATEX_SOURCES`. Depuis le plan 5b, il est dans le paquet commun `@cirrus/sources`, avec la lecture d'un identifiant, l'échange gardé et la lecture du CSL et du BibTeX : le principal et le serveur l'importent, sans copie.
  - Le principal demande à `doi.org` le CSL-JSON (titre, auteurs, date) et le BibTeX de l'entrée, par la négociation de contenu. Un identifiant arXiv passe par le DOI que lui donne arXiv (`10.48550/arXiv.<id>`). Le PDF d'un article arXiv vient de `https://arxiv.org/pdf/<id>`.
  - Pour un identifiant, seuls sont demandés `doi.org`, `api.crossref.org`, `data.crossref.org`, `api.datacite.org`, `data.datacite.org`, `data.crosscite.org` [C] et `arxiv.org`. `doi.org` renvoie un DOI de DataCite vers `data.crosscite.org`, qui succède à `data.datacite.org` (constaté le 2026-11-07). Une autre adresse passe par le réseau ouvert gardé, plus bas.
  - Tout passe en HTTPS. Chaque redirection est vérifiée avant d'être suivie, 5 au plus [C]. Chaque réponse est lue sous son plafond (`publicationMaxKb`, 2 Mo ; `maxImportMb` pour le PDF) et dans son délai (`publicationTimeoutMs`, 20 s), puis lue comme des données, jamais comme du code. Tout le téléchargement d'un PDF est borné par `publicationPdfMaxMs` (5 min) [C]. Aucun cookie n'est envoyé ni gardé, aucune adresse électronique non plus [C].
  - Le réseau ne sert qu'à la demande explicite de l'utilisateur : « Importer », jamais au démarrage ni en arrière-plan. Un `.bib` s'importe sans réseau.
  - Les liens qu'un utilisateur colle (`dx.doi.org`, `www.arxiv.org`, `export.arxiv.org`…) se lisent comme des identifiants, sans être demandés : ce ne sont pas des sources [C]. Depuis le plan 5b, un DOI lu dans le chemin de n'importe quelle adresse aussi (section 12, D4).
  - Les tests et les captures rejouent des réponses enregistrées, avec une résolution des noms injectée, et n'atteignent jamais le réseau. En rejeu, le serveur n'est jamais demandé [C].
- **Le réseau ouvert gardé** (plan 5b, D3), au PC comme au serveur, pour l'adresse d'un article de n'importe quel site :
  - seule une adresse `https:` sur le port 443, sans nom d'utilisateur ni mot de passe, est acceptée. Une IP écrite sous une forme numérique (`https://2130706433/`, `https://0x7f.1/`) est jugée comme l'adresse qu'elle désigne ; une réponse du résolveur qui n'est pas une IP bien écrite est refusée [C] ;
  - le nom est résolu, et toutes ses adresses doivent être publiques. Sont refusées, par un `net.BlockList` : en IPv4, `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4` et `240/4` ; en IPv6, `::/96` [C], `::1`, `fc00::/7`, `fe80::/10`, `fec0::/10` [C], `ff00::/8`, `2001:db8::/32`, `100::/64`, `64:ff9b:1::/48` et Teredo (`2001::/32`) [C]. Une adresse qui porte une IPv4 (`::ffff:0:0/96`, `64:ff9b::/96`, SIIT, 6to4) est jugée comme son IPv4 [C]. Message : « Adresse refusée : elle mène à une machine du réseau local. » ;
  - contre un DNS qui change d'avis, la connexion se fait à l'adresse vérifiée elle-même ; le nom ne sert qu'au TLS, dont le certificat est contrôlé contre lui [C]. Une connexion qui échoue avant toute réponse passe à l'adresse vérifiée suivante, les IPv4 d'abord, 4 au plus par saut [C] ;
  - chaque redirection est vérifiée de même, 5 au plus, et une redirection vers `http:` est refusée ;
  - le type d'une réponse donne sa règle de lecture jusqu'à ses cinq premiers octets, qui décident : une page se lit sous `publicationMaxKb`, un PDF sous `maxImportMb`. Un seul lecteur de corps et un seul délai servent l'échange des identifiants et le réseau ouvert ; le tampon part de la longueur annoncée, sans dépasser 1 Mio, puis double avec les octets reçus [C] ;
  - le magasin de certificats du système n'est pas ajouté : un site derrière un proxy d'entreprise serait refusé, le DOI restant possible [C].
- **Sécurité** (« ne transige pas, mais pas overkill », la VM étant dédiée) [C, accepté] :
  - administration uniquement par clé SSH ;
  - pare-feu n'ouvrant que HTTPS et SSH ;
  - correctifs de sécurité automatiques ;
  - HTTPS avec un certificat Let's Encrypt ;
  - un jeton par PC, révocable, pour la synchro ;
  - OAuth pour le MCP ;
  - veille isolée dans son propre processus ;
  - mises à jour de l'app signées par une clé gardée hors du serveur et vérifiées par l'app, pour qu'un serveur piraté ne puisse pas installer de code sur les PC [C].
- **Sauvegarde hors serveur :** aucune dans la première version. L'utilisateur a refusé le PC miroir. Chaque PC garde la base et son historique.
  - **Risque accepté :** seul le serveur détient tous les PDF. Un PDF déjà lu reste en cache sur les PC qui l'ont ouvert, les publications se retéléchargent en général depuis leur source, et les annotations sont des nœuds, présents sur chaque PC. Seul un PDF jamais ouvert et introuvable ailleurs serait perdu avec le serveur.
  - **Amélioration possible :** une sauvegarde chiffrée sur un espace externe, pour environ 3 € par mois.
- **Installation** (décidée avec l'utilisateur le 2026-11-09, pour le plan 9) :
  - **la première installation passe par le code de jumelage.** Par SSH, `jumeler "<nom>"` affiche le code et l'adresse de la page de téléchargement du serveur. Sur le nouveau PC, l'utilisateur ouvre cette page et y tape le code pour télécharger l'installateur. Le téléchargement ne consomme pas le code : il vit 10 minutes, et 5 essais faux le brûlent. Au premier lancement, l'utilisateur tape le même code pour jumeler le PC, qui, vierge, prend alors la base du serveur (6.6, D7). Il n'y a de mot de passe nulle part ;
  - **les mises à jour passent par le jumelage.** Le PC les demande au serveur avec son jeton. Un PC révoqué ne reçoit rien, et aucun mot de passe n'est stocké ;
  - **les signatures :** chaque version est signée dans l'intégration continue de GitHub, avec la clé gardée dans les secrets de GitHub (18.1), jamais sur le serveur. L'app vérifie la signature avec la clé publique qu'elle porte avant d'installer ; la mise à jour est forcée : l'app enregistre tout, se ferme, s'installe et se relance (18.1). Seule la toute première installation ne repose que sur le HTTPS ;
  - **le dépôt GitHub est public,** si bien que l'installateur ne contient rien de secret. Le code ne sert qu'à ne pas laisser une page ouverte sur Internet.

**Fixé par le plan 9** (`docs/superpowers/plans/2026-11-10-cirrus-production.md`, écrit et exécuté en travail autonome le 2026-11-10 : ses décisions D1 à D8 sont de Claude, dans le cadre de l'installation décidée avec l'utilisateur juste au-dessus, et l'utilisateur ne les a pas encore approuvées) : le serveur loué, en HTTPS, la page de téléchargement et le déploiement. Les versions, la CI et « Cirrus Dev » sont à la section 18.1, la synchro sur un réseau réel à la section 23. [C] marque, comme plus haut, un choix fait pendant l'exécution ; le registre du plan (`docs/superpowers/plans/2026-11-10-cirrus-production-registre.md`) en donne la raison et le coût.
- **D1, le HTTPS par Caddy :** Node n'écoute toujours que sur la machine, `127.0.0.1:7310`. Caddy reçoit le HTTPS sur le port 443, en HTTP/1.1 et HTTP/2 [C], obtient et renouvelle seul son certificat Let's Encrypt, et transmet chaque requête avec son `Host`, le flux d'événements sans le retenir.
  - Le serveur admet, en plus de la machine, les noms qu'on lui donne (`--nom <domaine>`, ou `CIRRUS_NOM`) : un nom de domaine ASCII, comparé sans casse ni port [C]. Il ne lit aucun `X-Forwarded-*` : rien d'autre ne lui fait confiance.
  - **Ses délais :** les en-têtes d'une requête en 60 s au plus ; aucun délai total par requête, les envois de fichiers et de base étant bornés par leur taille ; 2 min d'inactivité, levées pendant l'import d'une publication [C] ; une connexion gardée 65 s, plus longtemps que Caddy ne garde les siennes vers lui [C]. Un corps JSON doit arriver en 30 s, plus une seconde par 8 Kio annoncés, sinon 408 [C]. Un corps qui passe sa borne en cours de route reçoit 413, sans rien écrire ; ce qui reste d'un corps refusé est lu 1 Mio en 5 s au plus, puis la connexion est fermée [C]. Les temporaires d'un envoi coupé par un arrêt brutal sont ôtés au démarrage [C].
  - **Options écartées :** le HTTPS dans Node, qui demande de recharger le certificat à chaque renouvellement ; nginx et certbot, deux outils au lieu d'un.
- **D5, la page de téléchargement,** seule route sans jeton avec `/pair`, sous le même contrôle du `Host` :
  - `GET /installer` rend une page minimale, un champ pour le code et un bouton, sans script, avec une CSP stricte ;
  - `POST /installer`, un formulaire, vérifie le code comme `/pair` : un essai faux compte contre chaque code en attente, et les essais des deux routes s'additionnent [C]. Un bon code n'est pas consommé, et renvoie l'installateur de la version officielle ; un code faux, la page, avec « Code inconnu ou expiré. ». Rien n'est dit de la version publiée à qui n'a pas un bon code, et rien de la requête n'est repris dans la page [C] ;
  - le serveur ne vérifie pas la signature de ce qu'il sert : sa mise à jour l'a vérifiée avant de le poser, et la première installation s'en remet au HTTPS (plus haut) [C]. Un fichier des versions n'est servi que s'il est un fichier ordinaire, sous un seul nom, et non un lien [C].
- **D2, la VM :** Hetzner CX23 (plus haut) sous Ubuntu 24.04 LTS, et un nom de domaine. `deploy/installer-serveur.sh <domaine>`, lancé une fois en root, et qu'on relance sans rien casser, installe :
  - Node 26 et Caddy, depuis leurs dépôts officiels ;
  - un utilisateur système `cirrus` ; le code dans `/opt/cirrus`, à root, au dernier tag publié ; les données dans `/var/lib/cirrus`, que seul `cirrus` lit, le dossier par défaut du serveur lancé en root sous Linux [C] ;
  - le service systemd, sous `cirrus`, durci [C] ; ufw, qui n'ouvre que 22, 80 (le défi de Let's Encrypt) et 443, en TCP ; les correctifs de sécurité automatiques, avec un redémarrage à 4 h 30 quand un noyau l'attend [C] ; SSH par clé seulement, le script refusant de couper les mots de passe tant qu'aucune clé n'est autorisée [C].
- **D6, la mise à jour du serveur,** par un minuteur systemd, chaque heure : `deploy/mettre-a-jour.sh` lit la dernière version publiée sur GitHub et en télécharge les fichiers. Il vérifie la signature du manifeste et l'empreinte de l'installateur avec la clé du code en place, jamais avec celle de la version qui arrive [C]. Puis il passe le code au tag (`npm ci`, sans les dépendances de développement ni aucun script [C]), relance le service, et pose les fichiers dans le dossier des versions, à root : le serveur le lit sans pouvoir l'écrire [C]. Ses migrations se font au démarrage, comme avant. Un échec garde la version d'avant, et rien ne revient jamais en arrière. Le code vient de GitHub par git, en HTTPS, sans signature à lui : qui tient le compte GitHub tient le serveur [C].
- **L'administration,** par SSH : `cirrus-serveur jumeler "<nom>"`, `pcs` et `revoquer "<nom>"`, un petit script qui lance le serveur sous l'utilisateur `cirrus`, jamais en root, sur ses données et avec son domaine [C]. `jumeler` affiche aussi l'adresse de la page de téléchargement ; `pcs` affiche les noms sans caractère de contrôle (D8).
- **L'app livrée (D8) :** le banc n'y est pas ; toute permission que demanderait une page (caméra, micro, notifications…) est refusée ; les fusibles d'Electron lui ôtent le mode Node et le débogueur [C].
- **Ce que l'utilisateur fera,** pas à pas dans `deploy/LISEZ-MOI.md` :
  1. louer la VM, avec sa clé SSH, et le domaine, puis faire pointer le domaine vers la VM ;
  2. créer la clé de signature (`node deploy/cle-de-signature.mjs`), mettre la clé privée dans le secret GitHub `CIRRUS_SIGNING_KEY`, et pousser la clé publique : tant que la clé provisoire est dans le code, ni le serveur ni les PC n'installent rien ;
  3. une fois la première version publiée, lancer `installer-serveur.sh` sur la VM ;
  4. envoyer sa base depuis son PC, par le jumelage habituel, à l'adresse `https://` du domaine ;
  5. installer Cirrus sur ses autres PC par la page de téléchargement.

### 18.1 Versions et développement

L'utilisateur veut pouvoir développer l'app depuis n'importe quel PC et tester une nouvelle version localement. Un simple push sur son GitHub doit suffire à mettre à jour la version officielle.

- **Version officielle :** elle est construite à chaque push sur la branche principale. Une intégration continue sur GitHub produit les installateurs et les signe avec la clé conservée dans les secrets de GitHub, donc hors du serveur [C]. Le serveur récupère cette version, se met à jour lui-même, applique les migrations de données et la sert aux PC.
- **Versions acceptées :** une app plus ancienne que la version officielle se met à jour d'office. Une app plus récente, ou marquée dev ou pré-version, est acceptée.
- **Protection des vraies données [C] :** une version de développement ne se connecte au vrai serveur que si son format de données est identique à celui du serveur. Si elle change le format, elle travaille sur une copie des données, avec un serveur local. Sans cela, elle écrirait sur le serveur des données que la version officielle des autres PC ne saurait pas lire, et ces PC ne pourraient pas se mettre à jour vers une version qui n'existe pas encore.
- **Installation de développement [C] :** une version de développement s'installe à côté de la version officielle, sous une identité distincte (« Cirrus Dev ») et avec son propre dossier de données locales. Un test ne peut donc pas abîmer la base locale de la version officielle.
- **Formats** (plan 5a, D10) : à chaque branchement (`/hello`), le PC dit au serveur la version du protocole de synchro, celle du schéma de sa base et celle de l'instantané. Si l'une diffère, le serveur refuse : « Ce serveur garde ses données dans un autre format (schéma 4, ici 5) : mets à jour Cirrus, ou travaille sur un serveur local. ». Plusieurs versions qui diffèrent sont toutes citées [C]. La pastille dit alors « Serveur : <raison> », et la synchro s'arrête. Depuis le plan 9, ce refus lance aussi la mise à jour d'office (plus bas).

**Fixé par le plan 9** (section 18 pour le statut de ses décisions) : les versions, les mises à jour signées et « Cirrus Dev ». Deux dépendances nouvelles, à versions exactes : electron-builder, qui construit les installateurs et n'entre pas dans l'app, et electron-updater, qui télécharge les mises à jour.
- **D6, la CI :** chaque push sur `main` qui ne touche pas que la documentation [C] lance une intégration continue GitHub, sous Windows : `npm ci`, `tsc` et les tests de chaque paquet, puis l'installateur, à la version `0.1.<n>`, `n` étant le numéro de l'exécution. Les scénarios, les captures, les bancs et LaTeX n'y tournent pas, et les mesures de la base de référence n'y sont qu'indicatives : un runner partagé ne dit rien des cibles de ce PC [C]. Elle signe ensuite le manifeste et publie `v0.1.<n>` sur GitHub : l'installateur, `latest.yml`, le manifeste et sa signature. **Sans la clé dans les secrets, elle construit et teste, mais ne publie rien**, et son résumé le dit. La clé n'atteint ni l'installation des dépendances ni les tests : deux jobs, l'un qui construit et teste sans secret ni droit d'écriture, l'autre qui signe et publie sans installer aucune dépendance [C].
- **D4, les mises à jour signées :**
  - **la clé :** une paire ed25519 (`node:crypto`). La clé publique est dans le code de l'app ; la clé privée, que le script qui fait la paire ne montre qu'une fois [C], dans le secret `CIRRUS_SIGNING_KEY`, jamais dans le dépôt ni sur le serveur ;
  - **le manifeste,** `version.json` (`{ version, file, sha512, size, date }`) et sa signature, faits par la CI. La confiance vient de lui seul : electron-updater ne fait que télécharger, avec le jeton du PC ;
  - **à l'app :** elle cherche à chaque `/hello` qui annonce une version plus récente que la sienne, à un format refusé, et toutes les `updateCheckMs` (1 h) pendant la connexion. Elle vérifie la signature avant tout téléchargement, exige que `latest.yml` décrive exactement le fichier du manifeste [C], puis compare la taille et le sha512 de l'installateur téléchargé à ceux du manifeste. Un échec n'installe rien, et une notification le dit, une fois par session [C]. Un serveur qui annonce une version qu'il ne sert pas est un refus [C] ;
  - **la mise à jour forcée, avec relance** (l'utilisateur, 2026-11-11 : « le PC doit maj son app et ne peut pas continuer. Tout doit être sauvegardé, puis l'app fermée et maj. ») : dès que l'app tient un manifeste **dont la signature est vérifiée** et dont la version est plus récente que la sienne — jamais avant : une fausse annonce d'un serveur compromis ne bloque rien —, un écran au-dessus de tout bloque l'app, « Mise à jour de Cirrus vers 0.1.n », « Téléchargement… », avec la progression qu'electron-updater donne. Il n'a pas de bouton tant que tout va bien. L'installateur vérifié et armé, l'écran dit « Enregistrement, puis redémarrage… », et l'app ferme sa fenêtre par son chemin normal : le `.tex` ouvert, les champs LaTeX en cours, l'instantané et les consultations sont enregistrés ; les écritures en attente sont déjà dans la base locale, et partent au redémarrage. À la fermeture, l'installateur se lance en silence, puis relance l'app. La pastille suit le déroulement à la place de « À jour » ou d'un format refusé ;
  - **un échec pendant la mise à jour forcée :** un téléchargement interrompu (le réseau) est dit sur l'écran, qui offre « Continuer sans mettre à jour » ; la vérification suivante, périodique ou au prochain `/hello`, reprend le déroulement, et l'écran revient. Un refus (`latest.yml` ou l'installateur autre que celui du manifeste signé) est dit de même, avec la notification, une fois par session ; il n'est pas redemandé dans la session. Une relance sur une base prise du serveur (D7) n'installe rien à cette fermeture-là, ni ne ferme rien d'elle-même. La clé d'essai des essais de bout en bout s'arrête à l'armement : l'écran dit l'essai, offre « Continuer », et rien ne se ferme ni ne s'installe ;
  - **chaque version publiée redémarre les PC ouverts,** au plus une fois par heure, au rythme du minuteur du serveur (`cirrus-maj.timer`) : chaque push sur `main` qui fait une version la fait arriver sur les PC dans l'heure ;
  - **jamais en arrière :** une app plus récente ou égale, en pré-version, ou « Cirrus Dev », ne se met jamais à jour. Sans la vraie clé publique dans le code, rien ne s'installe ; une clé d'essai, celle des essais de bout en bout, n'installe jamais rien [C] ;
  - **option écartée :** la signature de code Windows (Authenticode), un certificat payant. Sans elle, SmartScreen avertit à chaque installation par la page.
- **D3, les deux variantes :**
  - **l'app officielle,** « Cirrus » (`io.github.yeb02.cirrus`), garde la base là où elle est, `%APPDATA%\@cirrus\app`, et s'installe dans `%LOCALAPPDATA%\Programs\cirrus` [C]. Sa version est dite sous le bloc « Serveur » des Réglages : « Cirrus 0.1.<n> » [C] ;
  - **« Cirrus Dev »** (`io.github.yeb02.cirrus.dev`, `npm run paquet:dev`) a son dossier de données, `%APPDATA%\@cirrus\app-dev`, son dossier d'installation, son verrou d'instance unique, ses jetons et son icône, marquée « DEV ». Les deux tournent côte à côte et ne partagent que TinyTeX, dont les installations ne font qu'ajouter. L'app lit sa variante dans le nom de son paquet, à chaque démarrage : une même construction fait les deux paquets [C]. Une version de développement ne se met jamais à jour ;
  - `npm run dev` reste l'app officielle, sur la vraie base [C] : la faire passer à « Cirrus Dev » est laissé à l'utilisateur (section 24).
- **L'installateur** (NSIS) est en un clic, pour l'utilisateur seul, sans droits d'administrateur ni dossier à choisir [C] ; l'installation pour tous n'est pas prise en charge. **Le désinstalleur n'efface jamais les données,** pas plus qu'une mise à jour, qui le lance [C].

## 19. Paramètres

- **Exposition :** tous les paramètres sont exposés dans l'app pour que l'utilisateur les ajuste, dans un bandeau latéral « Réglages ».
- **Rubriques** (demande de l'utilisateur, 2026-11-07 : « une hiérarchie des options qui les range par type ») : le bandeau range ses groupes de réglages sous sept rubriques repliées : Apparence, Navigation, Fenêtres, Fichiers, LaTeX, Performances et base, et Serveur depuis le plan 5a. Une rubrique ouverte montre ses réglages principaux, puis « Avancés (n) » pour les autres. Un champ de recherche trouve un réglage par son libellé, son groupe ou sa rubrique, sans tenir compte des accents ni de la casse, avancés compris. Les rubriques ouvertes restent ouvertes d'une ouverture du bandeau à la suivante, pendant la session [C].
- **Paramètres graphiques :**
  - distance du titre des connexions ;
  - seuils de disparition du texte ;
  - transition d'un groupe vers son contenu ;
  - tension et longueur du tronc, qui sont des options de la maquette à garder ;
  - largeur des connexions (base, minimum, maximum) ;
  - facteur f et échelle de texte ;
  - fond (ciel ou grille) et son opacité ;
  - couleurs.
- **Paramètres graphiques avancés :** toute constante de rendu ou d'interaction dont ce document fixe une valeur par défaut est un paramètre réglable, rangé dans une section « avancés » du bandeau. C'est un principe général, voulu par l'utilisateur. Exemples :
  - décalage d'échelle d'un nouveau groupe ;
  - seuils des niveaux de détail ;
  - taille minimale des nœuds à l'écran ;
  - bornes de largeur des connexions ;
  - densité et taille des étoiles ;
  - seuil séparant un clic d'un déplacement ;
  - délais de pause et de synchro ;
  - réponse par défaut des dialogues « partout ou ici seulement ».
- **LaTeX (plan 4b) :** les réglages de la chaîne forment la rubrique « LaTeX ». La largeur du résumé compilé (9 cm) et la liste des paquets ajoutés y sont des réglages principaux (2026-11-07) ; les autres sont des avancés : les processus préparés, les délais, la largeur et l'agrandissement du résumé compilé, le cache, le journal, la pause de frappe, l'enregistrement d'un .tex, les suggestions de l'éditeur, le délai de `tlmgr`, l'attente d'un téléchargement bloqué, le délai avant de chercher à nouveau un paquet, et la liste partagée des paquets ajoutés (`latexPackages`). En tête de la rubrique, un bloc dit l'état de LaTeX, propose de l'installer et ouvre le préambule, qui est une donnée de la base et non un réglage (section 13, D5).
- **Fichiers (plan 4c) :** les groupes « Annotations » et « Publications » suivent « PDF » dans la rubrique « Fichiers » [C]. La couleur du surlignage y est un réglage principal. Les autres sont des avancés : l'opacité du surlignage, la durée du clignotement, la longueur du titre d'une annotation et la largeur de la marge ; pour les publications, le plafond et le délai des réponses du réseau, les auteurs gardés en tags, les pages lues d'un PDF déposé, l'écart entre les boîtes du bloc d'un `.bib`, et les lignes et la durée de sa notification.
- **Serveur (plan 5a) :** la rubrique « Serveur », la dernière, commence par un bloc. Non jumelé, il montre « Adresse du serveur » (`http://127.0.0.1:7310` proposée), « Code de jumelage », « Nom de ce PC » (celui de la machine) et « Jumeler », et dit un refus en dessous. Au premier jumelage, il pose la question de D7 à la place du formulaire (section 6.6), puis dit l'envoi ou le téléchargement en cours, sans rien à cliquer [C]. Un PC vierge n'a pas de question : « Jumeler » mène droit au téléchargement de la base du serveur, puis au redémarrage. Si le téléchargement échoue, le formulaire revient, avec l'erreur en dessous. Jumelé, il montre le serveur, le nom de ce PC, l'état de la synchro et « Dissocier ce PC ». Son groupe « Synchronisation » n'a que des réglages avancés : l'attente du serveur sous le voile et au jumelage, `syncConnectTimeoutMs` (4 s) ; les délais de reconnexion, `syncRetryMinMs` (1 s) et `syncRetryMaxMs` (30 s) ; les actions par requête, `syncBatchUnits` (50, au plus 100) ; les téléchargements à la fois, `syncDownloads` (4) ; l'écart d'horloge qui fait avertir, `syncClockSkewWarnMs` (2 min) ; l'envoi avant la veille, `syncSuspendFlushMs` (1,5 s) ; la fenêtre de réception, `syncReceiveBatchMs` (50 ms) [C].
- **Plan 5b :** jumelé, le bloc « Serveur » dit aussi, sous l'état de la synchro, l'état du serveur (section 20), et offre « Télécharger tous les PDF… » sur sa propre rangée, au-dessus de « Dissocier ce PC » ; la question, puis l'avancement et « Arrêter », y prennent sa place (6.5) [C]. Les réglages nouveaux sont tous avancés :
  - rubrique « LaTeX » : dans le groupe « Compilation », la file de la recompilation de fond, `latexBackgroundMax` (300, de 0 à 5 000 par pas de 10, section 13), puis la pause du fond après chaque demande de l'utilisateur, « Pause des recompilations de fond pendant la frappe (ms) », `latexBackgroundPauseMs` (2 000 ms, de 0 à 60 000 par pas de 100 ; 0 : le fond n'attend que la fin des demandes en vol, section 13) ; dans le groupe « Éditeur LaTeX », les lignes gardées autour d'un bloc de la comparaison, `compareContextLines` (3, de 0 à 100), et la longueur à partir de laquelle des lignes identiques se replient, `compareFoldMinLines` (4, de 1 à 1 000) : les valeurs de la bibliothèque, devenues réglages [C] ;
  - rubrique « Fichiers », groupe « Publications » : la durée d'un téléchargement de PDF, `publicationPdfMaxMs` (5 min, de 10 s à 1 h) [C] ;
  - groupe « Synchronisation », qui passe à 12 réglages : l'intervalle de l'état du serveur, `serverStatusPollMs` (5 s, de 1 à 60 s, par pas de 0,5 s) ; l'espace gardé libre par « Tout télécharger », `downloadAllReserveMb` (1 024 Mo, de 0 à 100 000, par pas de 64) [C] ; les mesures dont la latence et le débit sont la médiane, `serverStatusSamples` (5, de 1 à 50), et la taille minimale d'un transfert compté dans le débit, `throughputMinMb` (1 Mo, de 0,1 à 100) [C].
- **Plan 6a** (section 4 pour le statut de ses décisions) : les réglages nouveaux.
  - Rubrique « Navigation », un groupe nouveau, « Recherche », dont tous les réglages sont avancés : les résultats montrés au plus, `searchMaxResults` (50, de 10 à 500, par pas de 10) ; la durée du cercle après un saut, `searchFlashMs` (1 200 ms, de 0 à 10 000) ; le temps d'une tranche de la construction de l'index, `searchBuildSliceMs` (8 ms, de 2 à 50) [C] ; les endroits gardés par « précédent » et « suivant », `navHistoryMax` (100, de 10 à 1 000, par pas de 10) [C].
  - Rubrique « Apparence », groupe « Sélection et dépôt » : la couleur des résultats de la recherche, `searchFoundColor`, un vert, qu'un test garde distinct de la sélection, des intrus et du dépôt [C].
  - Rubrique « Performances et base », un groupe nouveau, « Consultations » (section 20) : « Enregistrer mes consultations », un choix Oui / Non, « Oui » par défaut, réglage principal [C]. Une valeur gardée qui n'est ni l'une ni l'autre, un fichier de réglages modifié à la main par exemple, se lit « Non » : l'interrupteur tombe du côté fermé [C]. Le délai entre deux écritures, `consultationsFlushMs` (10 s, de 1 à 600 s, par pas de 1 s), est avancé.
- **Plan 9** (section 18 pour le statut de ses décisions) : le bloc « Serveur » ne propose plus d'adresse ; le champ est vide, « https://cirrus.mondomaine.fr » pour exemple, et le refus d'une adresse invalide nomme https [C]. Le groupe « Synchronisation » gagne quatre réglages avancés, et passe à 16, la limite du panneau [C] : `syncRequestTimeoutMs` (30 s, de 5 s à 10 min), `syncStreamSilenceMs` (40 s, de 20 s à 10 min) et `syncReceiveMaxUnits` (500, de 50 à 10 000), section 23 ; `updateCheckMs` (1 h, de 5 min à un jour), section 18.1.
- **Mode performance :** envisageable si les bancs de mesure le rendent nécessaire (section 21). Un interrupteur dans les paramètres graphiques allégerait alors les effets coûteux : flou des enveloppes, rubans à largeur variable, ciel étoilé, résolution du rendu.
- **Stockage** (plan 5a, D9) : les valeurs sont centralisées sur le serveur et communes à tous les PC : tous les réglages sont partagés. Des valeurs propres à un PC seront revues plus tard si besoin. L'adresse du serveur, le nom du PC et son jeton (`serveur.json`) ne sont pas des réglages.
  - **Le serveur fait autorité :** un réglage qu'il n'a pas vaut sa valeur par défaut. Il garde chaque réglage avec l'heure de sa dernière modification et le PC qui l'a faite. Le plus récent gagne, réglage par réglage, puis l'identifiant du PC, comme pour les actions [C].
  - **L'heure d'un changement** est celle du serveur, par l'écart mesuré au branchement, et vient toujours après le dernier changement de ce réglage que ce PC a vu, d'une milliseconde au moins [C]. Elle ne dépasse jamais l'heure corrigée du PC de plus d'un jour, moins `syncClockSkewWarnMs`, et le serveur refuse un réglage daté de plus d'un jour d'avance sur la sienne [C].
  - **Un retour au défaut** est gardé avec son heure, comme une valeur : un changement plus ancien ne peut pas faire revenir l'ancienne [C].
  - **Un réglage reçu** s'applique tout de suite, borné comme un réglage lu du disque. Une clé inconnue est ignorée, une valeur hors bornes est ramenée dans ses bornes, et une valeur d'un autre genre est ignorée, celle du PC gardée, avec un avertissement dans la console [C]. `latexPackages` reçu s'installe au démarrage suivant (section 13, D1).
  - **Au premier jumelage :** deux bases vides, ou un PC qui envoie la sienne, envoient tous les réglages du PC, datés de l'heure du serveur au jumelage. Un PC qui prend la base du serveur, ou y remplace la sienne, prend ses réglages et n'envoie rien des siens [C].
- **Hors ligne :** chaque PC garde sa copie, `settings.json`. Un changement fait dans les Réglages attend dans `settings-pending.json`, sa dernière valeur seulement par réglage, et part à la reconnexion ; la modification la plus récente l'emporte. Un PC jumelé qui a perdu ce fichier prend les réglages du serveur [C].
- **Historique :** les paramètres sont hors de l'historique et de l'annulation [C].

## 20. Santé du graphe, analytics et état du serveur

- **Santé du graphe :**
  - références cassées ;
  - labels en double ;
  - nœuds orphelins ou jamais revus ;
  - tags obligatoires jamais renseignés ;
  - conflits de .tex ;
  - intrus dans une enveloppe ;
  - plans ignorés lors d'une répercussion.
  Elle fonctionne sans LLM.
- **Analytics :** l'app trace les ouvertures, les consultations de nœuds, l'usage de chaque fonction, le temps passé et l'historique des actions, dans le flux séparé. La première version se contente d'enregistrer. Un tableau de bord est un objectif à très long terme.
- **État du serveur** (fixé par le plan 5b, D8 ; section 4 pour le statut de ses décisions) : la pastille ne dit que l'état de la synchro (section 6.6). Le bloc « Serveur » d'un PC jumelé dit, sous lui, cinq lignes : « Latence », « Débit », « Base du serveur », « Magasin du serveur » (« 12 fichiers, 340 Mo », « (décompte en cours) » pendant le premier compte) et « Espace libre du serveur », « — » tant qu'une valeur n'est pas connue [C].
  - **la latence :** la médiane des `serverStatusSamples` (5) derniers allers-retours de `GET /status`, mesurés par le principal jusqu'à la réponse, sur une horloge monotone [C]. Le bloc la demande à son affichage, puis `serverStatusPollMs` (5 s) après chaque réponse, jamais deux à la fois, et seulement avec une connexion ouverte [C]. Au dixième sous 10 ms, entière au-delà [C] ;
  - **le débit :** la médiane des `serverStatusSamples` (5) derniers transferts de fichiers d'au moins `throughputMinMb` (1 Mo), dans un sens ou dans l'autre, chacun entier, son écriture sur le disque comprise [C]. L'envoi de la base au premier jumelage n'est pas compté ;
  - **l'espace :** la base du serveur, son magasin (taille et nombre de fichiers) et l'espace libre de son disque, que `GET /status` rend (section 18) ;
  - chaque valeur est en fin de ligne, et n'est pas dessinée dans une capture : elle change d'une fois à l'autre [C] ;
  - **option écartée :** un test de débit qui enverrait des octets pour rien.
- **La santé du graphe** ne liste pas encore les conflits de `.tex` : elle n'est pas faite.
- **L'enregistrement des consultations** (fixé par le plan 6a, D6 ; section 4 pour le statut de ses décisions) : le début des analytics, pour la santé du graphe du plan 6b (« jamais revus »). [C] marque, comme plus haut, un choix fait pendant l'exécution ; le registre du plan en donne la raison et le coût.
  - **Le fichier :** `consultations.db`, à côté de la base et hors de son schéma, pour ne pas changer le format que la synchro compare. Une table, `events (at, pc, kind, subject, plan, detail)` ; `at`, `pc` et `kind` sont obligatoires [C]. Il est créé à la première écriture, en WAL [C]. Il n'est pas synchronisé : son envoi par lots au serveur vient au plan 6b.
  - **Ce qui s'enregistre :** l'ouverture et la fermeture de l'app ; un plan montré, à chaque changement d'onglet actif ; le pop-up d'un nœud ou d'une connexion ouvert (une ligne par connexion que montre la ligne cliquée) [C] ; un fichier ouvert en aperçu ou en plein écran, son nom en détail [C] ; une recherche faite, une par ouverture de la boîte, avec son texte et le résultat choisi, ou sans résultat si elle se ferme sans choix [C] ; un saut qui a abouti, retour et avance compris, jamais un saut refusé [C] ; les moments où la fenêtre prend ou perd le focus, une fenêtre cachée comptant comme sans focus, pour le temps passé [C]. Chaque événement dit le plan montré, sauf un plan montré ou un saut, qui disent celui où l'on arrive [C].
  - **Ce qui ne s'enregistre pas :** ni texte tapé ni contenu, hors le texte d'une recherche. Rien avant que les réglages ne soient lus, ni en mode banc ou capture [C]. Ce n'est pas une action : rien n'entre dans le journal ni dans l'annulation.
  - **L'écriture :** l'interface garde les événements en mémoire et les envoie au principal toutes les `consultationsFlushMs` (10 s), dès le premier d'une file vide, et à la fermeture, en premier [C]. Le principal les écrit en une transaction, et refuse un lot entier à la moindre irrégularité ; le PC est le sien, jamais celui que dirait l'interface [C].
  - **Les pannes :** un fichier verrouillé, abîmé, plein, ou dans un dossier disparu : un avertissement dans la console, une fois jusqu'à la prochaine écriture réussie, et le lot est perdu. Rien de visible, et la fermeture n'attend jamais [C]. Une fermeture brutale perd au plus `consultationsFlushMs` d'événements.
  - **L'interrupteur,** « Enregistrer mes consultations » (section 19) : éteint, rien ne s'enregistre, et ce qui attendait est abandonné [C].
  - **Une base prise du serveur** (6.6, D7) emmène `consultations.db` dans la nouvelle base, s'il n'y en a pas déjà un : l'historique d'usage de ce PC n'est pas dans la base [C].

## 21. Ordre de construction imposé

1. **Bancs de mesure, avant tout le reste.** Ils doivent valider les deux exigences les plus risquées :
   - **rendu :** une base synthétique au volume visé, soit quelques dizaines de milliers de nœuds et environ dix fois plus de connexions, organisés en groupes imbriqués. Les rubans, les enveloppes, le texte à toutes les échelles et le ciel étoilé doivent tous être présents.
     - Le banc mesure le déplacement et le zoom à travers plusieurs niveaux de groupes, ainsi que le chargement d'un plan.
     - Le petit PC, qui fixe le plancher de 60 images par seconde, n'est pas disponible. Les mesures se font donc sur le portable principal, avec des marges qui permettent d'extrapoler [C].
     - **Carte graphique :** le temps qu'elle consacre à une image doit rester sous environ un huitième du budget à 60 images par seconde, soit environ 2 ms en 2560×1600, car une carte intégrée est typiquement 5 à 10 fois moins puissante.
     - **Processeur :** le temps par image doit rester sous 16 ms avec le ralentissement ×4 de Chromium.
     - Ces marges sont des estimations, à revoir si le petit PC redevient disponible.
     - **Méthode de mesure (plan 3c) :** le banc de l'application (`npm run bench -w packages/app`) lit la base de référence (50 000 nœuds, 500 000 connexions de connaissance, graine 1) sur le disque, dans une copie neuve à chaque passe. Il suit un parcours de caméra de 40 s : vue d'ensemble, descente à travers tous les niveaux de groupes, déplacement, retour. La première seconde est écartée.
       - **Plancher et contenu :** le temps de la carte se mesure par des requêtes de chronomètre (`EXT_disjoint_timer_query_webgl2`), sur les images sans reconstruction. Une passe où toutes les couches sont masquées donne le plancher, le temps d'une image vide. Le contenu vaut le brut moins le plancher, en médiane et au p95 : c'est lui que vise le critère de la carte.
       - **Mémoire après ramasse-miettes :** dans l'interface, deux `gc()` précèdent la lecture de `usedJSHeapSize`, en mémoire précise. Pour chaque processus, la mémoire privée vient de `app.getAppMetrics()`, le principal ayant forcé ses collections. Elle se relève après le chargement et le parcours, avant les éditions. Une passe sur une base vide donne le plancher d'Electron.
       - **Latence d'édition :** elle va de l'appel (session, annulation, dépôt) à la fin du rendu de la première image de la nouvelle scène, par une promesse que résout la boucle de dessin. Pour un glissement, on mesure le temps du fil principal par image d'aperçu.
       - **Autres passes :** processeur ralenti quatre fois, chemin de secours (la base sans son instantané), titres en grille au seuil de lisibilité. Les critères du plan 3c et leurs mesures sont au registre du plan.
     - **Portable principal :** viser autant que possible la fréquence de son écran, 165 Hz.
     - Si les marges ne sont pas tenues, on ajoute le mode performance (section 19) plutôt que de changer de moteur.
     - Le rendu ne doit traiter que ce qui est visible et déplié : il faut un index spatial par plan et une gestion des niveaux de détail, plutôt que de tout envoyer à la carte graphique.
     - **Arrière-plan :** fenêtre cachée ou sans le focus, le rendu est en pause (réglage avancé « Mise en pause du rendu »). Le reste du temps, une image n'est dessinée que si quelque chose a changé.
   - **compilation :** TinyTeX, processus préparé à l'avance et objectif de 300 ms, mesurés sur le portable principal. Le banc du 2026-11-02 l'a tenu. L'app le tient au p95 au plan 4b, mais pas à chaque frappe (section 13, « Mesures »).
2. **Base de test artificielle :** juste ce qu'il faut pour exercer chaque fonctionnalité, avec des tests automatiques par fonctionnalité.
3. **Serveur en local :** tout fonctionne en local, y compris la synchro entre deux instances de l'app, avant de louer le serveur. Le plan 5a l'a fait : ses scénarios de l'interface synchronisent deux apps, l'une après l'autre, et un PC virtuel, par un serveur de la machine (section 6.6).
4. **Déploiement sur le serveur loué :** en dernier.

Le découpage détaillé relève du plan d'implémentation.

## 22. Laissé au constructeur

- Les valeurs par défaut non fixées ici : tailles, couleurs exactes, durées d'animation, délais de pause.
- Les raccourcis non fixés ici.
- La forme du protocole de synchro et le schéma SQLite, dans le respect des règles des sections 5 et 6.
- Le schéma d'URL des liens internes au PDF.
- Les règles fines de conversion des fichiers non .tex en LaTeX.
- La présentation exacte des dialogues « partout ou ici seulement ».
- La répartition des points d'arrivée sur le bord d'un groupe.

## 23. Questions ouvertes et risques

- **Inclusion multi-plans :** problème mis de côté, à juger à l'usage (section 10).
- **Plan créé par filtrage :** il reste à définir (instantané ou vue liée, choix des critères), de même que le langage de requête de graphe évoqué par la spécification.
- **Performances :** non mesurées, d'où les bancs de la section 21. Le petit PC à carte graphique intégrée est le cas le plus risqué, et il n'est mesuré que par extrapolation.
- **Volume :** quelques centaines de milliers de connexions pèsent aussi sur la première synchro d'un nouveau PC, l'index de recherche et la pagination du MCP, à vérifier avec la base synthétique. La première synchro est mesurée au plan 5a : environ 20 s pour envoyer ou prendre la base de référence, une fois par PC (section 6.6). L'index de recherche l'est au plan 6a : sur 50 000 nœuds de longs résumés, une frappe tient 28 ms au p95, et sa construction, 2 s de travail, était prête 15 s après la première image, à une tranche par moment libre ; elle enchaîne désormais ses tranches (`isInputPending`), et le temps qu'elle y gagne n'est pas mesuré : c'est pour une exécution ultérieure (section 14).
- **Horloge des PC** (plan 5a) : le plus récent gagne selon l'heure des actions et des réglages. Le PC corrige la sienne de l'écart avec le serveur, mesuré à chaque branchement, et avertit au-delà de `syncClockSkewWarnMs` (2 min) : un PC en avance d'une heure ne gagne donc pas tous les conflits. Restaient trois limites, revues au plan 9 (D7) :
  - l'écart n'était connu qu'au premier branchement de la session : une action faite hors ligne avant lui gardait l'heure du PC, décalage compris. **Fixé par le plan 9 :** l'écart mesuré est gardé dans `serveur.json`, réécrit quand il bouge d'une seconde au moins [C], et repris au démarrage suivant. Une telle action est datée de l'écart de la session d'avant ; seule une horloge changée entre-temps la trompe encore ;
  - il est mesuré une fois par connexion : la dérive d'une horloge pendant une longue connexion n'est pas suivie ;
  - un réglage ne peut être daté de plus d'un jour d'avance sur le serveur : une horloge très en avance ne tient un réglage contre les autres PC que ce temps-là, au plus (section 19).
- **Connexion à moitié morte** (plan 5a) : le PC ne remarquait ni un flux qui ne reçoit plus rien, `: ping` compris, ni un serveur qui ne répond plus, et la pastille pouvait dire « À jour » sur une connexion morte. **Fixé par le plan 9** (D7 ; section 18 pour le statut de ses décisions) :
  - chaque requête a un délai, `syncRequestTimeoutMs` (30 s), plus le temps de son corps à 8 Kio/s, le rythme que le serveur exige aussi [C]. Passé ce délai, c'est une panne du réseau : « Hors ligne », puis la reconnexion ;
  - un transfert (un fichier, la base, une page du journal) n'a pas de délai total, mais un délai d'inactivité, le même réglage. `net.fetch` d'Electron lisant tout un corps avant de l'envoyer, la réponse d'un envoi est attendue en plus le temps du corps entier à ce rythme [C] ;
  - le flux d'événements est tenu pour coupé après `syncStreamSilenceMs` (40 s) sans rien recevoir, ses `: ping` passant toutes les 15 s : la session finit, et la reconnexion repart. Une connexion ne fait ses preuves qu'une fois que son flux a apporté des octets : un mandataire qui le retiendrait ferait croître l'attente entre deux essais, au lieu de rouvrir sans cesse [C] ;
  - les écritures reçues se traitent par lots de `syncReceiveMaxUnits` (500) au plus, une transaction chacun, et le flux n'est plus lu tant qu'un lot entier attend : un retard de 50 000 écritures tient la mémoire bornée [C] ;
  - une demande d'import au serveur a pour délai celui de son PDF plus une minute, et `/seed/done`, qui attend l'import d'une base par le serveur, dix minutes [C] ;
  - un fichier de plus de 1 Gio, que le serveur refuserait, ne part jamais : l'écriture qui l'ajoute est écartée sur ce PC, qui le dit [C].
- **La mise en production** (plan 9) : rien n'a encore tourné sur une VM. Les scripts du serveur ne sont éprouvés que par une simulation sous Git Bash et par relecture : le premier déploiement de l'utilisateur en sera le premier vrai essai. Qui tient le compte GitHub tient le serveur et les versions : la double authentification le protège. Changer de clé de signature bloque toutes les mises à jour, jusqu'à réinstaller chaque PC par la page.
- **ChatGPT :** le mode développeur est en bêta, les forfaits éligibles sont incertains, et l'emplacement de l'option a changé en 2026.
- **Hébergeur :** disponibilité et prix des offres Hetzner à vérifier à la commande.
- **Noms accentués :** risque avec pdfLaTeX sous Windows. Au plan 4b, un fichier accentué et une base au chemin accentué compilent ; une installation de TinyTeX sous un chemin accentué n'a pas été essayée.
- **Signature des paquets LaTeX :** sans gpg, la base des paquets de TeX Live n'est pas vérifiée (section 13, D1). Risque accepté par l'utilisateur, qui a choisi l'option la plus simple (2026-11-08).
- **Gel de TeX Live :** vers avril 2027, `tlmgr` 2026 n'installera plus de paquet depuis Internet, d'où le dépôt figé du serveur (section 18).
- **PDF :** le serveur est le seul à les détenir tous. Un PDF déjà lu reste toutefois en cache sur les PC qui l'ont ouvert, donc seul un PDF jamais ouvert et introuvable ailleurs serait perdu avec le serveur.

## 24. Écarté ou reporté

**Écarté :**
- téléphone ;
- mini-carte ;
- signets de position ;
- disposition automatique, même ponctuelle ;
- moteur physique ;
- import de l'existant, l'utilisateur saisissant ses contributions à la main ;
- scission et fusion de nœuds ;
- connexions implicites et rétroliens, car une vraie connexion existera en général ;
- propagation du doute, car les dépendances ne sont jamais formelles ;
- provenance des suggestions LLM ;
- gel de version d'un document ;
- aller-retour avec Overleaf ;
- fenêtres détachables ;
- « couper » ;
- PC miroir ;
- trace automatique dans l'agenda ;
- exécution de code ou d'expériences par un LLM.

**Reporté :**
- sons de l'interface ;
- méta du travail ;
- curseur temporel ;
- pop-ups récursifs depuis les hyperliens ;
- paramètres propres à chaque PC ;
- formules LaTeX dans les titres ;
- sauvegarde externe chiffrée ;
- tableau de bord des analytics, à très long terme ;
- les autres idées classées « peut attendre » :
  - lien vers un dépôt ou un run d'expérience ;
  - carte de chaleur de l'attention ;
  - suggestions de liens ou de doublons ;
  - revue espacée ;
  - partage.

**Hors du plan 5b :**
- **plan 6 :** le saut « précédent » et « suivant », fait au plan 6a (section 14) ; le flux des analytics, dont le plan 6a fait l'enregistrement sur chaque PC (section 20), et l'aperçu au survol d'un lien, au plan 6b (plus bas) ;
- **plan 9 :** fait, sauf ce que liste « Hors du plan 9 », plus bas ;
- **la santé du graphe** (section 20), qui listera les conflits de `.tex` ;
- **à revoir à l'usage :** le magasin de certificats du système pour le réseau ouvert, si un site échoue derrière un proxy ; des pages enregistrées d'OpenReview, de PMLR et des actes de NeurIPS, à la place des pages de test écrites de mémoire ; une liste de `.tex` ouverts que le serveur n'a pas reçue, renvoyée sans attendre le changement suivant.

**Fait au plan 6a** (section 4) : la recherche, « précédent » et « suivant », « Voir dans un autre plan » (section 14) ; le registre des tags (5.4) ; la corbeille (6.3, 7) ; l'enregistrement des consultations (section 20).

**Hors du plan 6a (plan 6b, à venir) :**
- la santé du graphe (section 20), qui listera aussi les conflits de `.tex` et les nœuds jamais revus, d'après les consultations ;
- l'agenda et les feuillets (section 17) ;
- l'envoi des consultations au serveur, par lots (section 20) ;
- l'aperçu au survol d'un lien, le choix du plan d'arrivée au clic droit et l'import du nœud cible (section 14) ;
- le texte des PDF et des autres fichiers dans la recherche (section 14) ;
- l'historique par nœud : ses versions, leur restauration et leurs différences (6.3) ;
- « Poids de l'historique » (6.3), seul moyen de supprimer un contenu : la corbeille ne se vide pas ;
- une règle de synchro pour une connexion vivante dont un membre est à la corbeille (section 7) ;
- **à essayer par l'utilisateur, au premier plan :** Alt+←, Alt+→ et un Alt seul ne montrent aucune barre (section 4) ; une vraie souris à boutons latéraux, dont le pilote enverrait aussi des commandes « navigateur », ferait deux pas au lieu d'un (section 14) ;
- **à mesurer, à une exécution ultérieure :** l'index de recherche prêt après la première image sur la base enrichie (15 s avant), et ce que la molette, le survol et les frappes attendent pendant sa construction, depuis que ses tranches s'enchaînent dans un même moment libre tant qu'aucune touche ni aucun clic n'attend (`isInputPending`) : l'effet est attendu, non mesuré (section 14) ;
- **à revoir à l'usage :** le premier renommage d'une session, de 90 à 234 ms, et la première lettre d'une recherche, jusqu'à 71 ms, plus lents que les suivants (section 14).

**Fait au plan 9** (section 18) : le serveur loué derrière Caddy, en HTTPS, la page de téléchargement et le déploiement (18) ; la CI, les installateurs, les mises à jour signées et « Cirrus Dev » (18.1) ; la synchro sur un réseau réel (23).

**Hors du plan 9 :**
- **le dépôt figé de TeX Live** sur le serveur, avant le gel de printemps, vers avril 2027 (sections 18 et 23) ;
- **ce que D7 laisse pour plus tard,** jugé acceptable pour un seul utilisateur et une petite base :
  - l'envoi des fichiers un par un au premier jumelage ;
  - l'import d'une base envoyée dans le traitement de la requête, qui retient les autres requêtes du serveur (revue courte du plan 5a, A1) ;
  - l'écriture synchrone du PDF d'une publication par le serveur : un PDF de 200 Mo arrête sa boucle le temps de l'écrire et de le synchroniser sur le disque ;
  - le pic de mémoire pendant qu'un tampon de réponse grandit, moins de deux fois le plafond ;
  - une première adresse qui ne répond jamais (un trou noir) prend tout le délai d'un échange : un délai plus court par tentative ;
- **un envoi de la synchro vraiment en flux** (`net.request`) : le délai d'inactivité verrait l'envoi lui-même, et le principal ne tiendrait plus en mémoire un fichier entier, jusqu'à 1 Gio, pendant son envoi (section 23) ;
- **une signature du code du serveur,** des tags signés : il vient aujourd'hui de GitHub par git, en HTTPS (section 18) ;
- **à décider par l'utilisateur :** `npm run dev` sous l'identité de « Cirrus Dev », qui protégerait la vraie base pendant le développement ;
- **à revoir à l'usage :** installer LaTeX dans les deux variantes à la fois, qui partagent TinyTeX, peut se heurter ; un PC qui lit le manifeste pendant qu'une version se pose peut voir une signature dépareillée, et dire une fois « Mise à jour refusée » ; après un arrêt brutal, le serveur peut relire jusqu'à 999 lignes de son journal au démarrage, ce qu'une ligne réglerait.
