# Cirrus, plan 5b : suite de la synchronisation — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Écrit le 2026-11-09 sur la demande de l'utilisateur** (« tu pourras continuer avec la suite du plan »). Il s'exécute sans attendre son approbation, comme le veut le travail autonome : les décisions ci-dessous sont celles de Claude, et le registre en garde la raison et le coût.

**Goal :** finir ce que le plan 5a a laissé à la synchronisation (spec 24, « Hors du plan 5a, au plan 5b »). On peut alors :
- ouvrir un nœud changé sur un autre PC sans attendre sa compilation : elle s'est faite en arrière-plan ;
- importer une publication par l'adresse de n'importe quel article ou PDF, récupérée par le serveur quand il est joignable, et par le DOI lu dans l'adresse d'un éditeur ;
- lâcher un PDF sur le fond, ou le choisir par un bouton, pour l'importer ;
- être averti qu'un `.tex` est ouvert sur un autre PC, et ne jamais perdre en silence une version d'un `.tex` changé pendant qu'il est ouvert ;
- comparer un `.tex` et sa copie de conflit, et les réconcilier ;
- télécharger d'un coup tous les PDF de la base ;
- voir la latence, le débit et l'espace du serveur.

**Architecture :**
- **La recompilation en arrière-plan** se décide dans l'interface, qui tient l'état et le registre des labels. Après chaque synchronisation, elle calcule les sources dont la compilation a changé et les envoie au principal. Celui-ci les compile une à une, seulement quand aucune compilation de l'utilisateur ne tourne ni n'attend, et saute celles qui sont déjà en cache.
- **Le réseau des publications** sort de l'app dans un paquet commun, `@cirrus/sources`, que le principal et le serveur importent. Un PC jumelé et connecté demande l'import au serveur, qui récupère les métadonnées et le PDF, garde le PDF dans son magasin et rend sa référence. Sinon, le principal du PC le fait lui-même, comme aujourd'hui.
- **La présence des `.tex`** est une petite table du serveur, que chaque PC remplace par la liste de ses `.tex` ouverts.
- **La comparaison** est un plein écran fondé sur `@codemirror/merge`, l'extension de comparaison de CodeMirror 6.

**Tech Stack :** celle du plan 5a. Une seule dépendance nouvelle : `@codemirror/merge`, du même auteur que CodeMirror 6. Côté réseau ouvert, `node:https` et `node:dns`, avec `net.BlockList`, sans dépendance.

**Spec :** `C:\Users\alpha\Desktop\Cirrus\2026-11-02-cirrus-design.md`, sections 6.1, 6.2, 6.5, 12 (publications), 13, 18, 19, 20 et 24.

## Décisions

Chaque décision ci-dessous a comparé ses options. Une décision non prévue ici se consigne au registre (`docs/superpowers/plans/2026-11-09-cirrus-synchro-suite-registre.md`, créé à la tâche 1) sous la forme `Ruling:`, avec ses options et son coût si elle est fausse.

- **D1, la recompilation en arrière-plan après une synchronisation** (spec 13).
  - **Ce qui se recompile :** les sources dont la demande de compilation a changé par une synchronisation :
    - le résumé d'un nœud, la relation d'une connexion, et les `.tex` d'un nœud, quand leur texte ou les fichiers du nœud ont changé ;
    - toute source qui cite un label ou une clé dont la définition a changé : titre, nœud, tags `label`, `clé_bibtex`, `auteur`, `date_de_publication`, corbeille ;
    - toutes les sources quand le préambule a changé.
  - **Où :** l'interface tient l'état et le registre. Elle note ce que les synchronisations ont changé, puis, à la reconstruction suivante du registre, calcule les sources touchées et leurs demandes (`buildRequest`). Le principal les reçoit en lot, dans des créneaux à part (`bg:<créneau>`), pour ne jamais annuler la compilation d'une vue ouverte.
  - **La priorité :** le principal compile ces demandes une à une, seulement quand aucune compilation de l'utilisateur ne tourne ni n'attend. Une demande de l'utilisateur qui arrive sans processus préparé libre arrête la compilation de fond, qui reprend ensuite. Une demande déjà en cache est sautée sans compiler, par une lecture du cache qui ne change pas son ordre (`PdfCache.has`).
  - **L'ordre :** les résumés et les relations d'abord, puis les `.tex`, chacun dans l'ordre d'arrivée. Une demande nouvelle pour un même créneau remplace celle qui attend.
  - **La borne :** `latexBackgroundMax` (300, réglage avancé de la rubrique LaTeX) demandes en attente au plus. Au-delà, les plus récentes ne sont pas gardées : elles se compileront à l'ouverture, comme aujourd'hui. 0 désactive la recompilation de fond.
  - **Ce qui ne déclenche rien :** une action de ce PC (sa vue ouverte la compile déjà), une base prise au serveur, et le démarrage.
  - **Options écartées :**
    - **tenir l'état dans le principal**, pour qu'il calcule seul les demandes : il faudrait y porter le registre, et charger une seconde fois l'état ;
    - **tout recompiler après une synchronisation :** contraire à « le coût suit ce qui change ».
  - **Coût :** du processeur en fond, borné par `latexBackgroundMax` et par une compilation à la fois.
- **D2, le réseau des publications passe par le serveur** (spec 12 et 18).
  - **Le paquet commun :** `@cirrus/sources` reprend de `app/main/publications` les sources (`PUBLICATION_SOURCES`, `IDENTIFIER_LINKS`), la lecture d'un identifiant, l'échange gardé (`exchange`, redirections, plafonds, délais) et la lecture du CSL et du BibTeX. Il ne dépend que de `@cirrus/core`, et reçoit sa fonction de requête : `requestFetch(net.request)` dans Electron, le `fetch` de Node au serveur.
  - **Le chemin :** un PC jumelé et connecté envoie au serveur le texte saisi (`POST /publications`). Le serveur fait l'import, garde le PDF dans son magasin, et rend le même résultat qu'aujourd'hui, le PDF donné par sa référence (`FileRef`). Le PC ne le télécharge qu'à sa première lecture (D6 du plan 5a). Avant d'envoyer l'action qui crée le nœud, le PC demande déjà au serveur les fichiers qui lui manquent : le PDF y est, rien n'est envoyé.
  - **Sans serveur jumelé, ou serveur injoignable,** le principal du PC fait l'import lui-même, comme au plan 4c. Le PDF part au serveur avec l'action, comme tout fichier ajouté [C].
  - **Les plafonds** (`publicationMaxKb`, `publicationTimeoutMs`, `maxImportMb`) sont des réglages partagés. Le PC les envoie avec la demande, et le serveur les ramène sous ses propres bornes (`bounds.ts`).
  - **Le réseau ne sert toujours qu'à la demande explicite de l'utilisateur.** Le serveur n'importe rien de lui-même.
  - **Options écartées :**
    - **le serveur seul, sans repli :** hors du réseau du serveur, plus d'import du tout ;
    - **dupliquer le module dans le serveur :** deux copies des gardes à tenir.
- **D3, l'adresse d'un article ou d'un PDF de n'importe quel site, et ses gardes** (spec 12, 18).
  - **Ce qui est accepté :** une adresse `https:`, sur le port 443, sans identifiants. Une adresse `http:` est refusée : « Seules les adresses https sont acceptées. » [C].
  - **Les gardes contre les adresses internes :** le nom est résolu, et toutes ses adresses doivent être publiques. Sont refusées, par un `net.BlockList` :
    - en IPv4 : `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4`, `240/4` ;
    - en IPv6 : `::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`, `2001:db8::/32`, `100::/64`, et les adresses IPv4 incluses (`::ffff:0:0/96`, `64:ff9b::/96`), jugées comme leur IPv4.
  - **Contre un DNS qui change d'avis :** la connexion se fait à l'adresse vérifiée, par la fonction `lookup` de `https.request`. Le nom ne sert qu'au TLS (`servername`).
  - **Les redirections :** chacune est vérifiée de même, 5 au plus.
  - **Message d'une adresse refusée :** « Adresse refusée : elle mène à une machine du réseau local. ».
  - **Ce que rend l'adresse :**
    - **un PDF**, par son type ou ses premiers octets (`%PDF-`) : il entre au magasin, puis suit le chemin d'un PDF déposé sur le dialogue (D8 du plan 4c), qui cherche son DOI dans ses premières pages ;
    - **une page HTML :** elle est lue sous `publicationMaxKb`, comme du texte, jamais comme du code. Ses balises `<meta>` du standard Highwire, que suivent OpenReview, PMLR, les actes de NeurIPS, l'ACM, Springer et bien d'autres, donnent son DOI (`citation_doi`), son identifiant arXiv (`citation_arxiv_id`) et l'adresse de son PDF (`citation_pdf_url`). Le DOI ou l'identifiant importe les métadonnées, et le PDF de la page, s'il y en a un, vient avec, sous les mêmes gardes. Sans DOI, le PDF suit le chemin d'un PDF déposé ;
    - **rien de cela :** « Cette page ne mène à aucun PDF. ».
  - **Options écartées :**
    - **une liste de sites permis :** chaque nouvelle conférence demanderait une version de l'app ;
    - **lire le PDF dans la page par ses liens :** fragile, propre à chaque site.
- **D4, le DOI lu dans l'adresse d'un éditeur.** Une adresse `http(s)` dont le chemin, une fois décodé, contient un DOI (`10.<4 à 9 chiffres>/…`) se lit comme ce DOI, sans requête : `dl.acm.org/doi/pdf/10.1145/…`, `link.springer.com/article/10.1007/…`, `onlinelibrary.wiley.com/doi/full/10.1111/…`. Une fin `.pdf`, et un dernier segment `full`, `abs`, `abstract`, `pdf`, `epdf` ou `fulltext` placé après le DOI, sont retirés. C'est une lecture d'identifiant, comme les liens de `doi.org` (spec 18) : elle passe avant la récupération de D3 [C].
- **D5, un PDF lâché sur le fond, et « Choisir un PDF… »** (spec 12).
  - Un seul PDF lâché sur le fond ouvre le dialogue d'import au point du dépôt, avec ce PDF, comme s'il y avait été déposé. Plusieurs fichiers, ou un PDF avec d'autres, gardent la notification d'aujourd'hui, dont le texte cite les deux cas permis : un `.bib` seul, un PDF seul.
  - Le dialogue gagne « Choisir un PDF… », qui ouvre le sélecteur de fichiers du système, filtré sur les PDF. Les tests passent par `CIRRUS_PDF_PICK`, permis seulement sur une base de test, comme `CIRRUS_BIB_PICK`.
  - Son champ accepte désormais toute adresse : « DOI, identifiant arXiv ou adresse d'un article ».
- **D6, « .tex ouvert ailleurs », et un `.tex` changé pendant qu'il est ouvert** (spec 6.1).
  - **La présence :**
    - Chaque PC jumelé envoie au serveur la liste de ses `.tex` ouverts en plein écran, à chaque changement et à chaque branchement (`PUT /presence`). Le serveur la garde dans `serveur.db`, par PC, et la remplace à chaque envoi. Une révocation retire celle du PC.
    - Le serveur répond par les mêmes fichiers ouverts sur d'autres PC.
    - Ouvrir un `.tex` qu'un autre PC a ouvert l'annonce dans le bandeau du plein écran : « Ce .tex est ouvert sur « Portable » depuis 14h32 : sa dernière version y est peut-être restée. ». Hors ligne, rien n'est dit.
    - Un PC qui s'arrête sans fermer son `.tex` le laisse « ouvert » jusqu'à son prochain branchement : l'avertissement dit « peut-être ». C'est le cas qu'il vise, un portable fermé avec un enregistrement en attente.
  - **Un `.tex` changé ailleurs pendant qu'il est ouvert ici :** aujourd'hui, le plein écran ne relit jamais le fichier, et son enregistrement suivant remplace la version arrivée, sans copie de conflit. Désormais :
    - s'il n'a rien de non enregistré, il charge la nouvelle version : « « x.tex » a été modifié sur un autre PC : sa nouvelle version est chargée. » ;
    - sinon, il garde le texte tapé, et le bandeau dit : « « x.tex » a aussi été modifié sur un autre PC : à l'enregistrement, cette version-là sera gardée sous « x (conflit du … ).tex ». ». L'enregistrement écrit le texte tapé sous le nom, et la version venue d'ailleurs sous le nom de conflit de la spec 6.2, en une seule action. La notification de la synchro le dit [C].
  - **Options écartées :**
    - **un verrou :** un PC hors ligne bloquerait le fichier ;
    - **la présence par le flux d'événements seul :** perdue à un redémarrage du serveur, alors que le PC qui l'a ouverte est hors ligne.
- **D7, la comparaison d'un `.tex` et de sa copie de conflit** (spec 6.2).
  - **L'entrée :** dans la liste des fichiers du pop-up d'un nœud, une copie de conflit dont l'original est dans le même dossier (`isCopyOf`) offre « Comparer ». La notification d'un conflit nomme désormais le nœud : « Un .tex de « Titre » a été modifié sur deux PC : l'autre version est gardée sous « … ». ».
  - **Le plein écran :** à gauche, l'original, modifiable ; à droite, la copie, en lecture seule. Les blocs qui diffèrent sont colorés. Une flèche par bloc reprend celui de la copie dans l'original, et les parties identiques sont repliées (`MergeView`, avec `revertControls` et `collapseUnchanged`). L'en-tête nomme les deux fichiers.
  - **Les boutons :**
    - « Enregistrer » écrit l'original, en une action, « Réconcilier « x.tex » » ;
    - « Enregistrer et retirer la copie » fait de même, et retire aussi la copie du dossier, dans la même action. La copie reste dans l'historique et dans le magasin.
    - Échap ou × avec des changements demandent « Abandonner la réconciliation ? », « Annuler » ayant le focus.
  - **Un original changé ailleurs pendant la comparaison** suit D6.
  - **Un fichier de plus de `textViewMaxMb`** ne se compare pas : « Trop grand pour être comparé ici. ».
  - **Option écartée :** une comparaison à nous, Myers ou par lignes : plus de code pour un résultat moins bon.
- **D8, « Tout télécharger » et l'état du serveur** (spec 6.5, 20).
  - **Tout télécharger** est une action du bloc « Serveur » d'un PC jumelé.
    - « Télécharger tous les PDF… » compte les PDF que référence la base actuelle (dossiers des nœuds et ancres des annotations vivantes, sans les versions que seul l'historique garde) et qui manquent ici, avec leur volume, d'après les tailles des références. Puis il dit : « 37 PDF à télécharger, 1,2 Go ; 48 Go libres sur ce disque. », avec « Télécharger » et « Annuler ».
    - Un volume qui laisserait moins de `downloadAllReserveMb` (1 024 Mo) libres est refusé : « Pas assez de place : 1,2 Go à télécharger, 0,8 Go libres. ».
    - Le téléchargement passe par la file de la synchro, `syncDownloads` à la fois, chaque fichier vérifié par son empreinte. Le bloc dit l'avancement (« 12 PDF sur 37, 340 Mo sur 1,2 Go ») et offre « Arrêter ».
    - Il n'est pas repris au démarrage suivant : relancé, il ne compte que ce qui manque encore [C].
    - C'est une action, pas un réglage : elle vaut pour ce PC seul, alors que les réglages sont partagés.
  - **L'état du serveur,** dans le bloc d'un PC jumelé, sous l'état de la synchro :
    - **la latence :** la médiane des 5 derniers allers-retours de `GET /status`, demandé toutes les `serverStatusPollMs` (5 s) tant que le bloc est affiché ;
    - **le débit :** la médiane des 5 derniers transferts de fichiers d'au moins 1 Mio, dans un sens ou dans l'autre, ou « — » s'il n'y en a pas encore eu ;
    - **l'espace :** la base du serveur, son magasin (taille et nombre de fichiers) et l'espace libre de son disque. Le serveur tient la taille de son magasin à jour à chaque fichier reçu, après l'avoir comptée une fois au démarrage, en fond.
  - **Option écartée :** un test de débit qui enverrait des octets pour rien.

**Hors du plan 5b :**
- **Plan 6 :** le flux des analytics ; le saut « précédent » et « suivant » ; l'aperçu au survol d'un lien.
- **Plan 9 :** le HTTPS et le serveur loué, les installateurs, la mise à jour d'office et « Cirrus Dev », le dépôt figé de TeX Live ; un import de base au serveur qui ne bloque pas ses autres requêtes (revue courte du plan 5a, A1).
- **La santé du graphe** (spec 20), qui listera les conflits de `.tex`.

## Global Constraints

- Les contraintes des plans 3 à 5a valent toujours :
  - travail sur `main`, sans branche, avec un commit puis un push par étape, jamais en force ;
  - messages de commit en français, terminés par `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` ;
  - syntaxe effaçable, avec l'extension dans les imports ;
  - identifiants et commentaires en anglais, textes de l'interface en français.
- **Les réglages :** toute constante de rendu, d'interaction, de synchro ou de réseau est un paramètre de `RenderParams`, avec un libellé français, dans un groupe rangé sous une rubrique de `PARAM_RUBRICS`. Nouveaux réglages, tous avancés :
  - `latexBackgroundMax` : 300, de 0 à 5 000, rubrique LaTeX ;
  - `serverStatusPollMs` : 5 000, de 1 000 à 60 000, groupe « Synchronisation » ;
  - `downloadAllReserveMb` : 1 024, de 0 à 100 000, groupe « Synchronisation ».
- **Les bornes du serveur** sont des constantes nommées et documentées de `packages/server/src/bounds.ts` :
  - `MAX_PUBLICATION_BODY_BYTES` : 4 Kio ;
  - `MAX_PUBLICATION_FETCHES` : 2 imports à la fois ; au-delà, 503 : « Le serveur importe déjà d'autres publications : réessaie dans un instant. » ;
  - `MAX_PUBLICATION_TIMEOUT_MS` : 60 s ; `MAX_PUBLICATION_META_BYTES` : 8 Mio. La taille d'un PDF reste bornée par `MAX_FILE_BYTES` ;
  - `MAX_PRESENCE_ENTRIES` : 100 `.tex` ouverts par PC.
- **Sécurité** (« ne transige pas avec ça, mais pas overkill ») :
  - le serveur n'atteint le réseau qu'à la demande d'un PC jumelé, pour un import ;
  - le réseau ouvert passe par les gardes de D3, au PC comme au serveur ;
  - toute entrée du serveur est vérifiée avant toute écriture ; un refus ne laisse rien d'écrit.
- **Données :** un fichier du magasin n'est jamais effacé. La base d'un PC sans serveur se comporte comme au plan 5a, avec en plus D3, D4, D5 et D7, qui ne demandent pas de serveur.
- **Cloisonnement :** seul le principal touche le réseau et le disque. `@cirrus/sources` ne dépend pas d'Electron, et reçoit ses fonctions de réseau et de résolution, pour que les tests n'atteignent jamais Internet.
- **Performance :**
  - le calcul des sources à recompiler suit ce que la synchronisation a changé, jamais la taille de la base, sauf un changement de préambule ;
  - une compilation de l'utilisateur ne perd jamais sa place au profit d'une compilation de fond.
- **Tests et captures :**
  - `npx vitest run --maxWorkers=1`, paquet par paquet, et `tsc` sur chaque paquet touché ;
  - les tests rejouent des réponses enregistrées (`CIRRUS_PUBLICATIONS_REPLAY` et ses données), avec une résolution de noms injectée, et ne parlent qu'à un serveur qu'ils démarrent eux-mêmes sur `127.0.0.1`. Jamais Internet, jamais la base de l'utilisateur, jamais `%LOCALAPPDATA%\Cirrus` ;
  - les fenêtres restent en arrière-plan : `npm run interface`, `captures` et `mesures` seulement, une seule exécution d'Electron à la fois ;
  - pendant une tâche, seuls les scénarios d'interface qui la concernent tournent (`node scripts/interface.mjs <filtre>`). Tous les scénarios et toutes les captures tournent une fois, en fin de tâche (processus allégé, 2026-11-09). Une tâche a une relecture, avec au plus un tour de correction ; les tâches 2, 3 et 5, qui touchent au serveur et à la sécurité (les gardes du réseau ouvert, les routes nouvelles), gardent toute la rigueur ;
  - les captures des plans précédents ne changent pas, sauf écart consigné. Les nouvelles vont dans `docs/captures/plan5b/`.

## Review Focus

1. **Une adresse hostile :**
   - une adresse IP privée, de boucle ou de lien local, écrite telle quelle ou sous une forme numérique (`https://2130706433/`, `https://0x7f.1/`) ;
   - un nom résolu vers une telle adresse, dont `169.254.169.254` ;
   - IPv6 de boucle, locale unique, ou IPv4 incluse ;
   - une redirection vers l'une d'elles, ou vers `http:` ;
   - un nom dont la seconde résolution diffère de la première ;
   - une page HTML énorme, ou dont `citation_pdf_url` mène à une adresse interne.

   Tout est refusé avant la connexion, avec un message en français, et le serveur continue. Testé dans les tâches 2 et 3.
2. **Une avalanche de recompilations :** un préambule changé sur un autre PC, un nœud cité cent fois renommé, une semaine hors ligne rattrapée. La file reste bornée, rien ne se compile deux fois, et l'aperçu que l'utilisateur tape garde sa latence. Testé dans la tâche 1, mesuré à la tâche 8.
3. **Un `.tex` modifié des deux côtés pendant qu'il est ouvert :**
   - sur les deux PC à la fois, ou sur un PC qui passe hors ligne ;
   - enregistré pendant une comparaison ;
   - fermé par la fenêtre.

   Aucune version ne se perd en silence : la copie de conflit et la notification le disent. Une présence restée après un arrêt brutal avertit « peut-être », puis disparaît au branchement suivant de ce PC. Testé dans les tâches 5 et 6.
4. **Une copie de conflit à comparer quand ce n'est plus possible :** son original renommé ou retiré, son nœud à la corbeille, un fichier en CRLF ou en Windows-1252, ou trop grand. Le « Comparer » ne paraît pas, ou dit pourquoi. Testé dans la tâche 6.
5. **« Tout télécharger » qui tourne mal :** pas assez de place, le serveur perdu en route, l'app fermée pendant. Refusé d'avance, ou arrêté proprement ; aucun fichier à moitié écrit dans le magasin. Testé dans la tâche 7.

---

### Task 1 : La recompilation en arrière-plan

**Files :**
- Create :
  - `packages/app/src/renderer/latex/background.ts` : ce que les synchronisations ont changé, et les demandes à recompiler ;
  - `packages/app/tests/latexBackground.test.ts` ;
  - le registre du plan, `docs/superpowers/plans/2026-11-09-cirrus-synchro-suite-registre.md`.
- Modify :
  - `renderer/latex/registry.ts` : les sources qui citent un label ou une clé ;
  - `renderer/session.ts` et `renderer/sync/useSync.ts` : une action reçue par la synchronisation porte une marque explicite, jamais son libellé ;
  - `renderer/latex/useLatex.ts` (`useLatexRegistry`) : le calcul après la reconstruction du registre ;
  - `main/latex/cache.ts` (`has`), `main/latex/compiler.ts`, `main/latex/setup.ts`, `main/ipc/latex.ts`, `preload/index.ts`, `renderer/env.d.ts` : la file de fond ;
  - `packages/view/src/params.ts` : `latexBackgroundMax`.

**Interfaces (Produces) :**
- `LatexRegistry.citers(label: string): Origin[]` et `LatexRegistry.citersOfKey(key: string): Origin[]`, tenus par la construction incrémentale du registre, sans parcourir toutes les sources.
- `changedBySync(before: State, action: Action): SyncChange`, avec `interface SyncChange { nodes: Set<Id>; connections: Set<Id>; preamble: boolean }`. Pour chaque sujet, on compare le premier « avant » et le dernier « après », puisqu'une action de synchronisation contient les inverses de la réconciliation.
- `backgroundOrigins(change: SyncChange, previous: LatexRegistry, next: LatexRegistry, s: State, texts: ReadonlyMap<string, string>): Origin[]` : les sources touchées (D1), sans doublon, résumés et relations d'abord.
- **IPC :** `window.cirrus.latexBackground(reqs: CompileRequest[]): void` → `cirrus:latex:background`.
- **Main :** `LatexService.background(reqs: CompileRequest[]): void`, qui garde au plus `latexBackgroundMax` demandes en attente, chacune sous le créneau `bg:<créneau>`. `LatexService.backgroundIdle(): Promise<void>` sert aux tests et aux mesures.
- `PdfCache.has(key: string): boolean`, sans effet sur l'ordre ni sur la date du fichier.

- [ ] **Step 1 : tests.**
  - **`changedBySync` :** un résumé changé ; une relation changée ; un fichier ajouté à un nœud ; un résumé changé puis rendu à son texte dans la même réconciliation (rien) ; le préambule.
  - **`backgroundOrigins` :**
    - un nœud renommé dont le label est cité par trois résumés : ces trois-là, et le sien seulement si son texte a changé ;
    - une clé `clé_bibtex` déplacée d'un nœud à l'autre : ses citeurs ;
    - le préambule : toutes les sources, résumés et relations d'abord ;
    - une action de ce PC : rien.
  - **Main :**
    - une demande de fond en cache ne lance aucun processus ;
    - une demande de l'utilisateur arrivée pendant une compilation de fond passe d'abord, et la demande de fond reprend après ;
    - la file ne dépasse jamais `latexBackgroundMax`, et 0 n'en garde aucune ;
    - une demande nouvelle pour un même créneau remplace celle qui attend ;
    - `PdfCache.has` ne change ni l'ordre ni la date.
- [ ] **Step 2 :** lancer. Attendu : échec.
- [ ] **Step 3 :** implémenter. L'interface accumule les changements des synchronisations, puis les calcule à la reconstruction suivante du registre (`useLatexRegistry`), quand les textes des `.tex` changés sont lus.
- [ ] **Step 4 :** la suite de `app`, `view` et `core`, et `tsc`. Les captures ne doivent pas changer.
- [ ] **Step 5 :** créer le registre. Commit et push (`feat(latex): recompilation en arrière-plan après une synchronisation`).

### Task 2 : Le paquet `@cirrus/sources`, le DOI des éditeurs et le réseau ouvert gardé

**Files :**
- Create : `packages/sources/` (`package.json`, `src/index.ts`, `src/guard.ts`, `src/html.ts`, `tests/`).
- Move from `packages/app/src/main/publications/` : `sources.ts`, `identifier.ts`, `fetch.ts` (sauf `requestFetch`, propre à Electron, qui reste dans l'app), `csl.ts`, avec leurs tests. Les importeurs prennent le paquet, sans réexportation laissée dans l'app.

**Interfaces (Produces) :**
- `parseIdentifier(text: string): PublicationId | null` lit aussi le DOI d'une adresse d'éditeur (D4).
- **Le réseau ouvert gardé :** `openFetch(url: string, deps: OpenDeps, accept: string, cap: number): Promise<OpenAnswer>`.
  - `interface OpenDeps { resolve(host: string): Promise<{ address: string; family: 4 | 6 }[]>; connect: ConnectFn; timeoutMs: number; isPublic?(address: string): boolean }`.
  - `ConnectFn` fait la requête vers une adresse déjà vérifiée. Par défaut, `https.request` avec `lookup` fixé à cette adresse et `servername` au nom ; les tests en injectent une autre.
  - `isPublic(address: string): boolean` est la règle de D3, par un `net.BlockList`.
- `citationMeta(html: string): { doi?: string; arxiv?: string; pdfUrl?: string }`.
- **L'import :** `importPublication(text: unknown, deps: PublicationDeps, options?: { pdf?: false }): Promise<PublicationResult>`. `PublicationDeps` gagne `open: OpenDeps | null`. `PublicationResult` gagne `{ ok: true; kind: 'pdf'; pdf: FileRef }` : un PDF sans identifiant, à traiter comme un PDF déposé.
- **Messages :**
  - « Seules les adresses https sont acceptées. » ;
  - « Adresse refusée : elle mène à une machine du réseau local. » ;
  - « Cette page ne mène à aucun PDF. ».

- [ ] **Step 1 : tests.**
  - **D4 :** les adresses de l'ACM (`/doi/pdf/`, `/doi/abs/`), de Springer (`/article/`, `/chapter/`), de Wiley (`/doi/full/`, `/doi/epdf/`) et de Taylor & Francis donnent leur DOI ; une adresse sans DOI donne `null` ; un DOI suivi de `.pdf` le perd.
  - **`isPublic` :** chaque plage de D3, aux deux bouts ; une adresse publique ; `::ffff:127.0.0.1` ; `64:ff9b::a00:1`.
  - **`openFetch` :**
    - avec une résolution injectée, un nom résolu vers `10.0.0.5`, ou vers une adresse publique et une privée, est refusé sans connexion ;
    - `https://2130706433/` et `https://0x7f.1/` sont refusés ;
    - une redirection vers une adresse privée, ou vers `http:`, est refusée ;
    - plus de 5 redirections ;
    - une réponse plus longue que le plafond ;
    - le délai dépassé ;
    - la connexion reçoit l'adresse vérifiée, jamais le nom.
  - **`citationMeta` :**
    - les pages enregistrées d'OpenReview, de PMLR et des actes de NeurIPS, sous `packages/sources/tests/data/` ;
    - une page sans balise ;
    - une page énorme, lue sous son plafond.
  - **L'import :**
    - une adresse de PDF donne `{ kind: 'pdf' }` ;
    - une page avec `citation_doi` et `citation_pdf_url` donne les métadonnées et le PDF ;
    - une page dont `citation_pdf_url` est interne donne les métadonnées sans PDF, avec la raison.
  - Les tests du plan 4c passent, déplacés tels quels.
- [ ] **Step 2 :** lancer. Attendu : échec.
- [ ] **Step 3 :** implémenter, puis brancher l'app : `cirrus:publications:fetch` (`main/ipc/publications.ts`) passe `open` avec `dns.promises.lookup` et `https.request`. Le rejeu des tests (`replayFetch`) gagne les réponses du réseau ouvert.
- [ ] **Step 4 :** les suites de `sources` et `app`, et `tsc`. Les captures ne doivent pas changer.
- [ ] **Step 5 :** commit et push (`feat(sources): le réseau des publications en paquet commun, le DOI des éditeurs, les adresses ouvertes gardées`).

### Task 3 : Les publications récupérées par le serveur

**Files :**
- Modify :
  - `packages/server/src/server.ts` (la route), `bounds.ts`, `main.ts` (le réseau du serveur), `package.json` (`@cirrus/sources`) ;
  - `packages/app/src/main/sync/client.ts` et `host.ts` : un fournisseur d'import remis par `SyncHost`, comme `blobFetcher()`, par `conn.request` (`connection.ts`) ;
  - `main/ipc/publications.ts` : le choix du chemin ;
  - `main/sync/protocol.ts` ;
  - les tests du serveur et de l'app.

**Interfaces (Produces) :**
- **`POST /publications`**, corps `{ text: string; pdf?: false; maxKb: number; maxPdfBytes: number; timeoutMs: number }`, sous `MAX_PUBLICATION_BODY_BYTES` ; réponse : `PublicationResult`.
  - Le PDF va au magasin du serveur, et sa référence est rendue.
  - Les plafonds sont ramenés sous les bornes du serveur.
  - Au-delà de `MAX_PUBLICATION_FETCHES` imports en cours : 503.
- `startServer` gagne `sources?: { fetch: FetchFn; open: OpenDeps | null }`, que les tests injectent. Par défaut, le `fetch` de Node, redirections à la main, et le réseau ouvert de `@cirrus/sources`.
- **Main :** `importPublicationVia(text, options): Promise<PublicationResult>`.
  - Jumelé et connecté : le serveur.
  - Sinon, ou si le serveur ne répond pas : le principal, comme aujourd'hui.
  - Une réponse du serveur qui est un refus (« Publication introuvable. ») n'est pas refaite au PC.

- [ ] **Step 1 : tests.**
  - **Serveur :** avec un réseau rejoué, un import arXiv garde le PDF au magasin et rend sa référence ; un DOI sans PDF ; une adresse interne refusée ; un corps trop gros ou mal formé, refusé sans rien écrire ; sans jeton, 401 ; le troisième import simultané, 503.
  - **PC :**
    - jumelé, l'import passe par le serveur, et l'action qui crée le nœud n'envoie pas le PDF, que le serveur a déjà ;
    - le PDF se télécharge à sa première lecture ;
    - serveur arrêté : l'import se fait au PC, et le PDF part avec l'action au retour du serveur ;
    - non jumelé : comme au plan 4c.
- [ ] **Step 2 :** lancer. Attendu : échec.
- [ ] **Step 3 :** implémenter.
- [ ] **Step 4 :** les suites de `server`, `sources` et `app`, et `tsc`.
- [ ] **Step 5 :** commit et push (`feat(serveur): les publications récupérées par le serveur`).

### Task 4 : Le dialogue d'import : un PDF lâché sur le fond, « Choisir un PDF… », les adresses

**Files :**
- Modify :
  - `renderer/files/nodeFiles.ts` : la route `'pdf'` et le texte de la notification ;
  - `ui/graph/drop.ts` (`dropFilesAt`, à côté de la route `.bib`) et `ui/graph/publication.ts` (l'état du dialogue, qui porte le PDF lâché) ;
  - `ui/PublicationDialog.tsx` : un PDF initial, le bouton, le chemin `{ kind: 'pdf' }`, le texte du champ ;
  - `renderer/publications/build.ts` ;
  - `main/ipc/files.ts`, `main/bib.ts` (ou un module voisin pour `CIRRUS_PDF_PICK`), `preload/index.ts`, `renderer/env.d.ts` : `pickPdf`.

**Interfaces (Produces) :**
- `dropRoute` rend `'pdf'` pour un seul PDF lâché sur le fond.
- `PublicationDialog` gagne `initialPdf?: string`, un chemin déposé.
- `window.cirrus.pickPdf(): Promise<string | null>` : le sélecteur du système, filtré sur les PDF, parent la fenêtre ; `CIRRUS_PDF_PICK` sur une base de test.

- [ ] **Step 1 : tests.**
  - `dropRoute` : un PDF seul donne `'pdf'` ; deux PDF, ou un PDF et un `.bib`, donnent `'notice'` ; la notification cite les deux cas permis.
  - **Le dialogue :**
    - ouvert par un PDF lâché, il fait ce que fait un dépôt sur lui ;
    - un résultat `{ kind: 'pdf' }` d'une adresse fait de même ;
    - « Choisir un PDF… » annulé ne fait rien.
- [ ] **Step 2 :** lancer. Attendu : échec.
- [ ] **Step 3 :** implémenter.
- [ ] **Step 4 :** la suite de `app`, et `tsc`. Scénarios d'interface, avec le réseau rejoué :
  - un PDF lâché sur le fond donne un nœud au point du dépôt ;
  - un PDF choisi par `CIRRUS_PDF_PICK` ;
  - l'adresse d'une page d'OpenReview ;
  - l'adresse d'un article de l'ACM, lue comme un DOI.
- [ ] **Step 5 :** commit et push (`feat(publications): un PDF lâché sur le fond ou choisi, et l'import par adresse`).

### Task 5 : « .tex ouvert ailleurs », et un `.tex` changé pendant qu'il est ouvert

**Files :**
- Modify :
  - `packages/server/src/tokens.ts` (la table `open_tex` de `serveur.db`), `server.ts` (`PUT /presence`), `bounds.ts` ;
  - `main/sync/client.ts` (la liste ouverte, envoyée au branchement et à chaque changement), `host.ts` et `wire.ts` (les appels de l'interface), `protocol.ts`, `preload/index.ts`, `renderer/env.d.ts` ;
  - `ui/latex/TexWorkbench.tsx`, `ui/latex/saveScheduler.ts`, `renderer/actions.ts` (`texSaveBuild` avec copie de conflit), `ui/screens.ts`.

**Interfaces (Produces) :**
- **`PUT /presence {open: {node: Id; name: string}[]}`** → `{ others: { node: Id; name: string; pc: string; since: number }[] }`. Il remplace la liste de ce PC. Les noms se comparent comme au réimport (`nameKey`). Au plus `MAX_PRESENCE_ENTRIES` entrées.
- `window.cirrus.texOpened(node: Id, name: string): Promise<{ pc: string; since: number } | null>` et `window.cirrus.texClosed(node: Id, name: string): void`. Hors ligne ou non jumelé : `null`.
- `texSaveBuild(s, node, name, text, opts?: { keepTheirs?: FileRef })` : l'enregistrement qui garde la version venue d'ailleurs sous le nom de conflit (`conflictName` du cœur).

- [ ] **Step 1 : tests.**
  - **Serveur :** la liste remplacée ; les autres PC rendus avec leur nom ; une révocation qui retire la liste ; la liste gardée au redémarrage du serveur ; trop d'entrées, refusé.
  - **PC :** la liste renvoyée au branchement ; un PC qui ouvre un `.tex` déjà ouvert sur un autre reçoit son nom.
  - **Le plein écran :**
    - le fichier changé par une synchronisation, rien de non enregistré : la nouvelle version est chargée, avec la notification ;
    - avec du texte non enregistré : le bandeau, puis un enregistrement qui écrit les deux versions en une action ;
    - un Ctrl+Z de cette action rend l'état d'avant l'enregistrement.
- [ ] **Step 2 :** lancer. Attendu : échec.
- [ ] **Step 3 :** implémenter.
- [ ] **Step 4 :** les suites de `server` et `app`, et `tsc`. Dans la suite d'interface à deux PC (`TWO_PCS`), un pas : le `.tex` ouvert sur le PC virtuel avertit l'app.
- [ ] **Step 5 :** commit et push (`feat(synchro): .tex ouvert ailleurs, et un .tex changé pendant qu'il est ouvert`).

### Task 6 : La comparaison d'un `.tex` et de sa copie de conflit

**Files :**
- Create : `ui/latex/CompareView.tsx`, `packages/app/tests/compare.test.ts`.
- Modify :
  - `packages/app/package.json` : `@codemirror/merge`, à une version exacte publiée depuis plus de deux semaines ;
  - `ui/panels/NodePopup.tsx` : « Comparer » ;
  - `ui/FullScreen.tsx` et `ui/screens.ts` : le plein écran de comparaison ;
  - `renderer/actions.ts` : `reconcileTexBuild` ;
  - `packages/core/src/sync.ts` : le titre du nœud dans la notification.

**Interfaces (Produces) :**
- `conflictOriginal(files: readonly FileRef[], copy: FileRef): FileRef | null` : l'original d'une copie de conflit, d'après `isCopyOf`.
- `reconcileTexBuild(s, node, original: string, text: string, opts: { removeCopy?: string }): Build`, libellé « Réconcilier « x.tex » ».
- Le plein écran a la cible `{ kind: 'compare'; node: Id; original: string; copy: string }`.

- [ ] **Step 1 : tests.**
  - **`conflictOriginal` :** une copie et son original ; une copie dont l'original est renommé ou retiré ; « (2) ».
  - **`reconcileTexBuild` :** avec et sans retrait de la copie ; un Ctrl+Z qui rend les deux fichiers.
  - **La notification** nomme le nœud.
  - **Le plein écran :**
    - les deux textes, décodés comme dans le plein écran d'un `.tex` (CRLF, Windows-1252) ;
    - un fichier trop grand dit pourquoi ;
    - fermer avec des changements pose la question.
- [ ] **Step 2 :** lancer. Attendu : échec.
- [ ] **Step 3 :** implémenter.
- [ ] **Step 4 :** la suite de `app` et `core`, et `tsc`. Un scénario d'interface : une copie de conflit faite par deux PC, comparée, un bloc repris, enregistrée avec le retrait de la copie.
- [ ] **Step 5 :** commit et push (`feat(synchro): comparer un .tex et sa copie de conflit`).

### Task 7 : « Tout télécharger » et l'état du serveur

**Files :**
- Modify :
  - `packages/server/src/server.ts` (`GET /status`) et ce qui reçoit les fichiers (la taille du magasin tenue à jour) ;
  - `main/sync/downloads.ts` (le débit, et le téléchargement de tout ; `Downloads.want` accepte déjà toute empreinte), `uploads.ts` (le débit des envois), `client.ts` (`/status`, à côté de `blobRequest`), `host.ts`, `wire.ts`, `pairing.ts` (le contenu du bloc, `Pairing.info`), `protocol.ts`, `preload/index.ts`, `renderer/env.d.ts` ;
  - `ui/settings/ServerBlock.tsx` ;
  - `packages/view/src/params.ts` : `serverStatusPollMs`, `downloadAllReserveMb`.

**Interfaces (Produces) :**
- **`GET /status`** → `{ baseBytes: number; storeBytes: number; storeFiles: number; freeBytes: number }`.
- `window.cirrus.serverStatus(): Promise<{ latencyMs: number | null; throughput: number | null; server: {…} | null }>`.
- `referencedPdfs(s: State): FileRef[]` (renderer, pur) : les PDF des dossiers des nœuds et des ancres des annotations vivantes, sans doublon d'empreinte.
- `window.cirrus.downloadAllPlan(refs: FileRef[]): Promise<{ count: number; bytes: number; freeBytes: number }>` ; `downloadAllStart(refs)`, `downloadAllStop()`. L'avancement passe par un événement, comme l'état de la synchro.

- [ ] **Step 1 : tests.**
  - **Serveur :** `/status` après des fichiers reçus ; sans jeton, 401.
  - **Main :**
    - la latence, médiane de 5 ;
    - le débit, compté sur les transferts d'au moins 1 Mio seulement ;
    - le plan de téléchargement, qui ne compte que les absents ;
    - le refus quand la place manque ;
    - « Arrêter », puis une relance qui ne reprend que ce qui manque ;
    - le serveur perdu en route : arrêt propre, rien de partiel au magasin.
  - **`referencedPdfs` :** dossiers et ancres, sans doublon ; une annotation à la corbeille ; une version que seul l'historique garde.
- [ ] **Step 2 :** lancer. Attendu : échec.
- [ ] **Step 3 :** implémenter.
- [ ] **Step 4 :** les suites de `server` et `app`, et `tsc`.
- [ ] **Step 5 :** commit et push (`feat(synchro): tout télécharger, et l'état du serveur`).

### Task 8 : Scénarios, mesures, captures, spec

- [ ] **Step 1 : les scénarios d'interface** des tâches 4 à 6 passent, avec ceux des plans précédents.
- [ ] **Step 2 : les mesures** (`npm run mesures -w packages/app -- …`, trois passes chacune, dans l'app construite, fenêtre en arrière-plan, TinyTeX comme aux mesures du plan 4b ; méthode au registre) :
  - le temps pour recompiler en fond 100 résumés changés par une synchronisation, sur la base de test ;
  - l'aperçu d'un résumé qu'on tape pendant ce temps : le p95 reste sous la cible de 300 ms de la spec 13. Le comparer au même aperçu sans compilation de fond ;
  - l'ouverture d'un pop-up dont le résumé a été recompilé en fond : moins de 50 ms jusqu'au canevas.
- [ ] **Step 3 : les captures** (`docs/captures/plan5b/`) :
  - le dialogue avec une adresse ;
  - « Choisir un PDF… » ;
  - le bandeau « ouvert sur « Portable » » ;
  - le bandeau d'une version venue d'ailleurs ;
  - la comparaison ;
  - le bloc « Serveur » avec son état ;
  - la question de « Tout télécharger ».

  Les captures des plans précédents ne changent pas, au pixel près.
- [ ] **Step 4 : la spec.** Inscrire ce qui a été fixé (« Fixé par le plan 5b ») aux sections 6.1, 6.2, 6.5, 12, 13, 18, 19 et 20, et retirer de la section 24 ce qui est fait. Le registre, complété des mesures.
- [ ] **Step 5 :** commit et push (`docs: plan 5b, mesures, captures et spec`).
