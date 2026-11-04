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

## 4. Architecture et pile technique

**Pile retenue** (choisie par Claude sur délégation de l'utilisateur, qui l'a acceptée)
- **App de bureau :** Electron et TypeScript.
  - Rendu du graphe : un moteur WebGL 2 à nous, piloté par la carte graphique. Il remplace PixiJS, sur décision de l'utilisateur du 2026-11-03 (plan 3c) :
    - une texture des éléments (position, demi-tailles, cran, repli, style) est lue par des instances : boîtes, glyphes MSDF des titres, et courbes des connexions simples, calculées dans le vertex shader ;
    - le processeur prépare le reste, sans travailleur : les faisceaux complexes et leurs pointes, les enveloppes des groupes, les marqueurs des faisceaux, les anneaux (sélection, cible du dépôt, intrus) et le fond ;
    - un déplacement ou un aperçu réécrit quelques texels et quelques instances ;
    - la couche reste mince : un second moteur WebGPU reste possible.
  - Interface (panneaux, pop-ups, onglets) : React.
  - Éditeur .tex : CodeMirror 6. Depuis le plan 4a, il affiche aussi le texte et le code, en lecture seule.
  - Lecture et annotation de PDF : PDF.js. Depuis le plan 4a, il tourne dans un lecteur à nous ; l'annotation vient au plan 4c.
  - Octets des fichiers : un protocole `cirrus-file:`, servi par le principal (plan 4a).
- **Base locale :** SQLite, avec les entrées en JSON et les fichiers des nœuds tels quels sur le disque.
- **Serveur :** Node.js et TypeScript, SQLite et fichiers sur disque. Le serveur MCP utilise le SDK TypeScript officiel de MCP, la veille le SDK TypeScript d'Anthropic.
- **LaTeX :** pdfLaTeX via TinyTeX, installé dans le dossier de l'app (section 13).
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

Exemple fourni par l'utilisateur : nœud « Minimum Description Length Principle (MDL) », avec pour résumé « Énonce que le meilleur modèle génératif d'un jeu de données est celui qui le compresse le plus ». Ses tags sont `statut_epistémique:consensus_scientifique` (rang 5), `pertinence:central` (rang 5), `nature:principe`, `théorie de l'information`, `algorithmie`, `axiome` et `provenance:externe`. Son dossier contient les deux fichiers cités plus haut.

### 5.3 Connexion

- **Titre court :** facultatif. Il est affiché discrètement près du marqueur.
- **Relation :** court texte LaTeX, affiché dans le pop-up de la connexion.
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
- **Labels LaTeX :** leur registre est dérivé des `\label` de tous les .tex, et chaque label est unique dans toute la base.
- **Publications :** un nœud de publication porte les tags `auteur:…` (multivalué, `auteur:Anon` si inconnu) et `date_de_publication:…`. Il porte aussi une clé BibTeX pour `\cite` [C : un champ dédié].

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

- **Trois flux séparés :**
  - le contenu et les connexions ;
  - la disposition ;
  - les analytics, envoyés par lots.
  Tous se synchronisent en permanence.
- **Écriture locale :** chaque changement est écrit tout de suite sur le disque, puis envoyé au serveur, qui le relaie aux autres PC ouverts.
- **Rythme par type :**
  - un déplacement part au relâchement de la souris ;
  - un .tex en cours d'édition part à la fermeture du fichier ou de l'app, et aussi après 30 secondes sans frappe ;
  - une sauvegarde locale a lieu toutes les quelques secondes, contre les plantages.
- **Veille du PC :** Windows ne laisse qu'environ deux secondes, avec `PBT_APMSUSPEND`. L'app tente un envoi à l'annonce, sans garantie, puis envoie automatiquement au réveil.
- **.tex ouvert ailleurs :** le serveur note quel PC a ouvert quel .tex. Ouvrir ce fichier sur un autre PC avertit que sa dernière version est peut-être restée sur le premier.
- **Démarrage :** l'app vérifie sa version, se met à jour si le serveur l'exige, synchronise derrière un écran de chargement, puis s'ouvre. Le réveil d'un PC déclenche la même vérification.
- **Hors ligne :** si le serveur ne répond pas après quelques secondes, l'app s'ouvre hors ligne avec un indicateur visible, puis se resynchronise au retour du réseau.

### 6.2 Identifiants et conflits

- **Identifiants :** les changements portent des entiers de 64 bits ordonnés, à partir de 0. Le numéro définitif est attribué par le serveur à l'arrivée, car un PC hors ligne ne peut pas le connaître. Chaque PC retient le dernier numéro vu, ce qui suffit à détecter une divergence.
- **Changements indépendants :** s'ils portent sur des objets ou des champs différents, ils s'appliquent tous les deux.
- **Même champ** (titre, tag, position…) : le plus récent gagne, et l'autre reste dans l'historique.
- **Même .tex :** les deux versions restent dans le dossier du nœud, qui est signalé, et l'utilisateur les réconcilie avec la vue des différences.
- **Supprimé d'un côté, modifié de l'autre :** la modification gagne et l'objet revient.
- Il n'y a pas de fusion ligne à ligne.

### 6.3 Historique

- **Contenu :** toutes les éditions entrent dans l'historique, déplacements et changements d'échelle compris.
- **Historique par nœud :** on peut consulter les versions et restaurer un nœud seul. Une vue des différences textuelles est fournie.
- **Corbeille :** un objet retiré de son dernier plan y va.
- **Copies :** l'historique complet est conservé sur chaque PC.
- **Poids de l'historique :** une fenêtre à part dans le menu principal, d'usage très exceptionnel, par exemple pour un PDF sur lequel l'utilisateur s'est ravisé. Elle affiche le poids par nœud et par type, et permet de supprimer un contenu en gardant la trace de son existence : nom, date et taille. Une restauration affiche alors « contenu supprimé ».
- **Plus tard :** un curseur temporel en lecture seule.

### 6.4 Annulation (Ctrl+Z, Ctrl+Y)

- **Mécanisme :** toute action d'édition s'annule. L'annulation ajoute à l'historique une modification inverse sans rien effacer, car le changement est peut-être déjà sur le serveur [C, non contesté].
- **Granularité :** une action compte pour un pas. Un déplacement complet ou une répercussion sur plusieurs plans, placements manuels compris, forment chacun un seul pas.
- **Pile :** une seule pile pour toute l'app, pas une par plan, vidée à la fermeture [C, non contesté]. Si le pas annulé touche un plan que l'utilisateur ne regarde pas, une notification le nomme.
- **Texte :** dans un champ de texte ou l'éditeur .tex, Ctrl+Z agit sur le texte.
- **Exclus :** la caméra, la sélection et les paramètres ne sont pas annulables.

### 6.5 Fichiers volumineux

- **Stockage :** le serveur détient tous les PDF. Un PC télécharge un PDF depuis le serveur à la première lecture, puis le garde. Il ne va jamais le chercher à son URL d'origine.
- **« Tout télécharger » :** option rare, par PC. Elle annonce le volume et le compare à l'espace libre.
- **Autres fichiers :** .tex, .py, images et le reste se synchronisent normalement sur chaque PC.

## 7. Lobby, plans et opérations entre plans

- **Lobby :** le plan central, bibliothèque de référence, ouvert dans son propre onglet. Chaque plan s'ouvre dans un onglet. Un plan peut être permanent ou servir de plan de travail.
- **Nouveau plan :** créé depuis le menu, il est vide, et l'utilisateur y colle des nœuds. Créé par filtrage, il sera défini plus tard (section 23).
- **Nœuds exclusifs :** un filtre visuel met en évidence ce qui est exclusif au plan.
- **Ajout au lobby :** l'opération « ajouter au lobby », par nœud ou par connexion, demande de placer le nœud à la main dans le lobby. Le nœud suit le curseur et un clic le pose. Une connexion se place automatiquement, puisqu'elle dépend de ses nœuds.

**Suppression.** Elle demande toujours s'il faut supprimer **partout** ou **ici seulement**, dans ce plan ou ce lobby.
- Le dialogue indique combien d'instances existent et avertit s'il s'agit de la dernière.
- Cette règle remplace celle de la spécification, selon laquelle un plan ne pouvait supprimer que ses objets exclusifs. Le dialogue et la corbeille sont les garde-fous.
- Un objet retiré de son dernier plan va à la corbeille.

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

## 8. Rendu du graphe

### 8.1 Échelles

- **Zoom :** continu, centré sur le curseur. Il se commande à la molette ou avec + et −, et les flèches déplacent la vue.
- **Échelle de texte :** une valeur globale et continue. Elle change la taille du texte de tous les éléments, et celle des boîtes des nœuds simples.
- **Échelle de taille :** un **cran entier k par élément et par plan**, valant f^k, avec un facteur f global de 2 par défaut. Le choix de 2 se justifie ainsi : à 1,5 ou φ, le parent commence à s'effacer avant que ses membres aient disparu ; à 3, il faut parcourir plus de zoom.
  - **Nœud simple :** son cran change la taille de son texte et de sa boîte [C, non contesté].
  - **Groupe :** son cran change la taille de son titre et dilate les distances entre ses membres autour de leur barycentre, récursivement dans les sous-groupes. La forme est conservée, et ni le texte ni le cran des membres ne changent.
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

- **Clic gauche :** sur un nœud ou une connexion, il ouvre son pop-up.
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
- **Édition :** le titre, le résumé, les tags, l'import de fichiers et la création de nœuds se font dans la fenêtre principale.
- **Création d'un nœud :** depuis le menu contextuel du fond, le nœud suit le curseur et un clic le pose [C].
- **Annotation de PDF :** surligner un passage crée un nœud d'annotation qui porte le passage, le PDF et la page. Le nœud du PDF devient un groupe pour le rendu, ses annotations en étant les membres.
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
  - **LaTeX** (`tex`) : le source s'affiche, coloré. L'éditeur et l'aperçu compilé côte à côte viennent au plan 4b. Le résumé du pop-up s'affiche aussi en source jusque-là.
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

## 13. LaTeX

- **Compilateur :** pdfLaTeX, comme Overleaf par défaut, via TinyTeX installé dans le dossier de l'app. TinyTeX pèse environ 99 Mo compressés sous Windows. L'app détecte elle-même les paquets manquants dans le journal et les installe avec `tlmgr`. La liste des paquets installés est un paramètre partagé, pour que tous les PC compilent la même chose [C].
- **Fichiers .tex de nœud :** ils n'ont pas de préambule. Un préambule global unique, versionné, sert à tous. Un .tex qui contient `\documentclass` est compilé tel quel.
- **Résumé et relation :** ils passent par la même chaîne.
- **Lieu :** la compilation se fait sur le PC, donc aussi hors ligne.
- **Cache :** les PDF produits restent en cache local sans être synchronisés.
- **Erreur :** le dernier PDF valide reste affiché, avec le journal à côté.
- **Sécurité :** aucune commande shell n'est permise. Un paquet comme `minted`, qui en a besoin, ne fonctionnera pas.
- **Exigence explicite : temps de compilation minimaux.**
  - **Pas de compilation inutile :** chaque PDF est retrouvé par une empreinte de son contenu, du préambule et des titres cités. Après une synchro, les nœuds modifiés se recompilent en arrière-plan, donc ouvrir un nœud ne compile presque jamais.
  - **Préambule chargé d'avance :** un processus pdfLaTeX est lancé à l'avance et attend après le préambule, puis reçoit le nœud. C'est la technique de TeX-fast-recompile, qui fonctionne avec tous les paquets. `mylatexformat` (2011) ne sert qu'en complément si les mesures le justifient.
  - **Une seule passe :** les liens vers d'autres nœuds sont fournis par l'app. Une seconde passe n'a lieu que si les références internes au nœud ont changé.
  - **Pendant la frappe :** toute modification interrompt la compilation en cours et en relance une après une courte pause.
  - **Objectif :** moins de 300 ms pour l'aperçu d'un nœud ordinaire, à compter de la fin de la pause de frappe. C'est une cible, à mesurer en premier (section 21). Une figure TikZ lourde restera lente.
- **Noms accentués :** l'app compile sous des noms neutres, car l'outil cité signale des problèmes de noms accentués sous Windows. Le cas d'un `\includegraphics` vers un fichier accentué reste à tester.
- **Liens entre nœuds :**
  - `\label` alimente le registre global. Un doublon ou un lien cassé apparaît en rouge et dans la santé du graphe.
  - Dans un aperçu isolé, un `\ref` vers un autre nœud affiche le titre du nœud cible, faute de numéro. Dans le même nœud, et dans un document assemblé, les vrais numéros sont gardés.
  - `\cite` pointe vers le nœud de la publication et affiche une citation courte.
  - Les liens sont produits par `hyperref` avec un schéma d'URL propre à l'app, que le lecteur PDF intercepte.
- **Éditeur :** simple, avec coloration syntaxique, et suggestions pour `\ref` et `\cite` à partir des registres.

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
- **Hébergement [C, accepté] :**
  - Hetzner Cloud CX23 : 2 vCPU, 4 Go de mémoire, 40 Go de SSD, en Allemagne.
  - Environ 4,49 € par mois, IPv4 comprise, selon des sources secondaires, à confirmer à la commande.
  - Une source signale que cette gamme était parfois impossible à commander en septembre et octobre 2026. Le repli est OVH VPS-1, en France, autour de 8 € HT par mois.
  - S'y ajoute un nom de domaine, environ 10 € par an, pour le HTTPS.
- **Rôle du serveur :** synchroniser, stocker les PDF, servir le MCP, lancer la veille, héberger l'installateur et les mises à jour, et garder une copie du code. Il ne compile pas de LaTeX.
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
- **Installation :** l'installateur se télécharge depuis le serveur à la première connexion. Au premier lancement, l'utilisateur s'authentifie et le PC reçoit son jeton [C].

### 18.1 Versions et développement

L'utilisateur veut pouvoir développer l'app depuis n'importe quel PC et tester une nouvelle version localement. Un simple push sur son GitHub doit suffire à mettre à jour la version officielle.

- **Version officielle :** elle est construite à chaque push sur la branche principale. Une intégration continue sur GitHub produit les installateurs et les signe avec la clé conservée dans les secrets de GitHub, donc hors du serveur [C]. Le serveur récupère cette version, se met à jour lui-même, applique les migrations de données et la sert aux PC.
- **Versions acceptées :** une app plus ancienne que la version officielle se met à jour d'office. Une app plus récente, ou marquée dev ou pré-version, est acceptée.
- **Protection des vraies données [C] :** une version de développement ne se connecte au vrai serveur que si son format de données est identique à celui du serveur. Si elle change le format, elle travaille sur une copie des données, avec un serveur local. Sans cela, elle écrirait sur le serveur des données que la version officielle des autres PC ne saurait pas lire, et ces PC ne pourraient pas se mettre à jour vers une version qui n'existe pas encore.
- **Installation de développement [C] :** une version de développement s'installe à côté de la version officielle, sous une identité distincte (« Cirrus Dev ») et avec son propre dossier de données locales. Un test ne peut donc pas abîmer la base locale de la version officielle.

## 19. Paramètres

- **Exposition :** tous les paramètres sont exposés dans l'app pour que l'utilisateur les ajuste, les graphiques dans un bandeau latéral « paramètres graphiques ».
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
- **Mode performance :** envisageable si les bancs de mesure le rendent nécessaire (section 21). Un interrupteur dans les paramètres graphiques allégerait alors les effets coûteux : flou des enveloppes, rubans à largeur variable, ciel étoilé, résolution du rendu.
- **Stockage :** les valeurs sont centralisées sur le serveur et communes à tous les PC. Des valeurs propres à un PC seront revues plus tard si besoin.
- **Hors ligne :** chaque PC garde sa copie, et la modification la plus récente l'emporte à la reconnexion.
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
- **État du serveur :** l'app affiche la latence, le débit et l'espace utilisé.

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
   - **compilation :** TinyTeX, processus préparé à l'avance et objectif de 300 ms, mesurés sur le portable principal.
2. **Base de test artificielle :** juste ce qu'il faut pour exercer chaque fonctionnalité, avec des tests automatiques par fonctionnalité.
3. **Serveur en local :** tout fonctionne en local, y compris la synchro entre deux instances de l'app, avant de louer le serveur.
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
- **Volume :** quelques centaines de milliers de connexions pèsent aussi sur la première synchro d'un nouveau PC, l'index de recherche et la pagination du MCP, à vérifier avec la base synthétique.
- **ChatGPT :** le mode développeur est en bêta, les forfaits éligibles sont incertains, et l'emplacement de l'option a changé en 2026.
- **Hébergeur :** disponibilité et prix des offres Hetzner à vérifier à la commande.
- **Noms accentués :** risque avec pdfLaTeX sous Windows.
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
