# Cirrus, plan 5a : serveur local et synchronisation — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Approuvé par l'utilisateur le 2026-11-08** (« C'est bon »).

**Goal :** plusieurs PC partagent une même base par un serveur, qui tourne pour l'instant sur le PC de l'utilisateur (spec 21, point 3). On peut :
- jumeler un PC au serveur par un code affiché sur le serveur ;
- voir sur un PC, en moins d'une seconde, chaque action faite sur un autre ;
- travailler hors ligne : les actions partent au retour du réseau, et les conflits se règlent selon la spec 6.2 ;
- envoyer sa base au serveur la première fois, ou prendre celle du serveur sur un nouveau PC ;
- retrouver les fichiers des nœuds sur chaque PC, et les PDF à leur première lecture ;
- partager les réglages entre PC.

**Architecture :**
- **Le serveur** est un paquet Node, `@cirrus/server`, qui réutilise `@cirrus/core` et `@cirrus/store`. Il garde la base de référence : tables, journal et fichiers. Il en tient aussi l'état en mémoire, pour vérifier chaque action comme une commande est vérifiée. Il numérote les actions qu'il accepte et les relaie à tous les PC.
- **Le PC** écrit chaque action dans sa base tout de suite, comme aujourd'hui. Elle reste « en attente » jusqu'à ce que le serveur la numérote. Un client de synchro, dans le principal, envoie les actions en attente et reçoit celles des autres PC.
- **La réconciliation** se calcule dans l'interface, qui tient l'état : elle défait les actions en attente, applique celles du serveur, puis rejoue les siennes par-dessus, fusionnées. Le principal l'écrit en une transaction, en vérifiant chaque « avant », comme une action.

**Tech Stack :** celle du plan 4c. Côté serveur, Node 26, qui lit le TypeScript tel quel, avec `node:http`, `node:sqlite` et `node:crypto`. Côté PC, Electron (`net.fetch`, `safeStorage`, `powerMonitor`). Aucune dépendance nouvelle.

**Spec :** `C:\Users\alpha\Desktop\Cirrus\2026-11-02-cirrus-design.md`, sections 3, 4, 5.6, 6, 18, 18.1, 19 et 21 (point 3).

## Décisions

Chaque décision ci-dessous a comparé ses options. Une décision non prévue ici se consigne au registre (`docs/superpowers/plans/2026-11-08-cirrus-synchro-registre.md`, créé à la tâche 1) sous la forme `Ruling:`, avec ses options et son coût si elle est fausse.

- **D1, le serveur garde la base de référence et son état en mémoire.**
  - Il tient une base au format d'un PC (`LocalStore`, même schéma), plus un fichier à lui (`serveur.db`) pour les PC jumelés et les réglages.
  - À chaque action reçue, il vérifie :
    - la forme de chaque opération ;
    - chaque « avant », contre ses tables et son état ;
    - les règles du graphe, comme une commande : une action ne peut pas ajouter de violation.
  - Il garde un instantané de son état, comme le PC, pour redémarrer vite.
  - **Options écartées :**
    - **un relais sans état**, qui ne vérifierait rien et ne pourrait pas servir le MCP du plan 8 ;
    - **des tables sans état en mémoire.** Deux inclusions faites en même temps sur deux PC, du même nœud dans deux groupes du même plan, passeraient : chaque « avant » est juste, mais leur combinaison viole la règle d'un seul groupe direct.
  - **Coût :** la mémoire de l'état, mesurée à la tâche 5 sur la base de référence (50 000 nœuds). Le CX23 a 4 Go.
- **D2, le transport : HTTP, plus un flux SSE pour ce que le serveur pousse.**
  - Le PC envoie ses actions et ses fichiers par des requêtes ordinaires. Le serveur lui pousse les actions numérotées par un flux d'événements (`text/event-stream`), qui reprend où il s'était arrêté (`Last-Event-ID`) après une coupure.
  - **Au plan 5a, le serveur n'écoute que sur la machine** (`127.0.0.1` ou `::1`) : il refuse de démarrer sur une autre adresse, faute de HTTPS, qui viendra au plan 9.
  - Chaque route, sauf le jumelage, exige le jeton du PC. Le serveur ne répond à aucune requête d'un navigateur (pas d'en-têtes CORS).
  - Chaque corps de requête est borné. Les bornes sont des constantes nommées et documentées du serveur (Global Constraints).
  - **Options écartées :**
    - **WebSocket :** il faudrait une dépendance côté serveur (`ws`), et son authentification et sa reprise seraient à refaire ;
    - **interroger le serveur à intervalle :** plus de latence, et des requêtes à vide.
- **D3, le jumelage par un code.**
  - Sur le serveur, `npm run serveur -w packages/server -- jumeler "Portable"` affiche un code de 16 caractères (80 bits), qui ne sert qu'une fois. Il expire après 10 minutes ou 5 essais faux.
  - Dans Cirrus, Réglages › Serveur, on donne l'adresse du serveur et ce code. Le PC reçoit un jeton de 256 bits.
  - Le serveur ne garde que l'empreinte SHA-256 du jeton. Le PC garde le jeton chiffré par Windows (`safeStorage`, DPAPI), dans `serveur.json`, à côté de sa base : une base de test ne peut donc jamais parler au serveur de l'utilisateur.
  - `pcs` liste les PC jumelés, et `revoquer "Portable"` en retire un. Un PC ne peut envoyer que des actions signées de son propre identifiant.
  - **Options écartées :**
    - **un mot de passe :** il faudrait le stocker et le protéger contre les essais ;
    - **OAuth :** il est prévu pour le MCP (plan 8), et trop lourd pour la synchro ;
    - **des certificats clients :** pénibles sous Windows.
  - Au plan 9, l'utilisateur lancera la même commande par SSH.
- **D4, l'ordre et les conflits : le serveur numérote et vérifie strictement ; le PC rejoue ses actions en attente sur ce qui arrive.**
  - Le serveur accepte les actions dans leur ordre d'arrivée, avec chaque « avant » exact. Une action dont un « avant » ne correspond plus est déclarée « en retard ». Le PC reçoit alors ce qui lui manque, rejoue son action dessus, puis la renvoie.
  - **La fusion** (spec 6.2) se fait au PC, sur chaque enregistrement, champ par champ, entre :
    - l'« avant » de l'action en attente ;
    - l'enregistrement tel que le serveur l'a fait ;
    - l'« après » de l'action en attente.
  - **Les règles de fusion :**
    - un champ changé d'un seul côté prend la valeur de ce côté ;
    - changé des deux côtés, le plus récent gagne : l'heure de l'action, puis l'identifiant du PC en cas d'égalité ;
    - **tags :** un tag d'une clé à une seule valeur, déclarée dans le registre, se fusionne par clé. Les autres, mots simples ou clés multiples, comme `auteur`, se fusionnent comme un ensemble : les ajouts et les retraits des deux côtés comptent [C] ;
    - **fichiers :** ils se fusionnent par nom, sans tenir compte de la casse ni de la forme Unicode, comme le réimport. Si un même `.tex` est changé des deux côtés, les deux versions restent : la plus récente garde le nom, et l'autre devient « nom (conflit du 2026-11-08 14h32).tex ». Une notification le dit. Pour un autre fichier, le plus récent gagne, et l'autre version reste dans l'historique [C] ;
    - **membres d'une connexion :** ils se fusionnent par nœud, et le rôle de chacun est un champ ;
    - **placements, fantômes, formes de connexion et clés du registre :** chacun est un seul champ ; le plus récent gagne [C] ;
    - **branches :** leur présence est un champ ;
    - **supprimé d'un côté, modifié de l'autre :** la modification gagne. Un enregistrement mis à la corbeille ou effacé revient avec la modification, ainsi que les placements et les branches que la même action lui avait retirés, si leur plan existe encore [C]. À l'inverse, une action en attente qui jette un objet modifié entre-temps ailleurs perd la suppression de cet objet, de ses placements et de ses branches.
  - Une action rejouée est vérifiée comme une commande : elle ne peut pas ajouter de violation.
    - Si elle en ajoute une, elle est écartée, et une notification la nomme : « « Inclure X dans G » écartée : X est déjà dans le groupe H, depuis un autre PC. ».
    - Si elle ne change plus rien, elle disparaît sans bruit.
  - **L'heure des actions :** au branchement, le serveur donne la sienne. Le PC corrige celle de ses actions de l'écart mesuré, et avertit si cet écart dépasse `syncClockSkewWarnMs` (2 min) : « L'horloge de ce PC diffère de celle du serveur de 7 minutes : règle-la. ».
  - **Options écartées :**
    - **le dernier arrivé au serveur gagne :** plus simple, sans horloge. Mais une modification faite hier hors ligne écraserait celle de ce matin, contre la spec (« le plus récent gagne ») ;
    - **la fusion au serveur :** sa logique serait en deux endroits, et le PC devrait encore fusionner pour afficher ses actions en attente ;
    - **une bibliothèque de CRDT (Automerge, Yjs) :** un autre modèle de données, lourd. Le nôtre a déjà les « avant » et « après » qu'il faut.
  - **Coût :** celui d'une fusion est proportionnel aux enregistrements touchés, jamais à la taille de la base. Le cas courant, une action venue d'ailleurs sans rien en attente ici, s'applique comme une action locale.
- **D5, le journal (schéma v4) reste l'histoire exacte des tables.**
  - Chaque ligne gagne :
    - `unit`, l'identifiant de l'écriture, un par appel à `commit`. Les enregistrements successifs d'un `.tex`, qui forment une seule action (plan 4b), font plusieurs écritures ;
    - `kind` : `local` pour une action de ce PC, `remote` pour une action reçue, `rewind` pour l'inverse d'une action en attente défaite lors d'une réconciliation, jamais envoyé ;
    - `superseded`, qui marque une ligne locale remplacée par sa version rejouée, ou écartée.
  - Rejouer le journal dans l'ordre local redonne donc toujours les tables. L'instantané et le chargement ne changent pas.
  - **Les flux** (spec 6.1) : le contenu et la disposition passent par un seul flux ordonné, pour que l'ordre du serveur vaille pour les deux. Chaque ligne garde son flux (`flow`), que le MCP et les analytics liront [C]. Les analytics auront leur propre envoi, par lots, au plan 6.
  - **Les numéros :** `server_seq` reçoit, sur toute ligne, le numéro que le serveur lui a donné. La méta `last_server_seq` dit d'où reprendre le flux. Elle s'écrit dans la même transaction que les lignes reçues : un arrêt brutal ne perd ni ne double rien.
  - **Idempotence :** le serveur reconnaît une écriture déjà reçue à son identifiant. Il répond alors « acceptée », avec son numéro, sans l'appliquer de nouveau. C'est le cas d'une réponse perdue.
  - **L'historique d'un objet** montre les lignes locales et reçues, sans les inverses. Une modification perdante reste dans l'historique : celle d'un autre PC parce qu'elle est arrivée, la sienne marquée « écartée » sur le PC qui l'a faite [C].
  - **Le Ctrl+Z :** une action réécrite ou écartée par une réconciliation quitte la pile d'annulation [C]. Annuler une action que d'autres ont touchée depuis reste refusé, comme aujourd'hui (« a été modifié depuis »).
- **D6, les fichiers.**
  - **L'envoi :** avant d'envoyer une action, le PC envoie au serveur les fichiers qu'elle référence et qu'il n'a pas encore : ceux des dossiers et l'empreinte des ancres. Le serveur vérifie l'empreinte SHA-256 de chaque fichier reçu, et refuse une action dont un fichier lui manque.
  - **La réception :** les fichiers des enregistrements reçus se téléchargent tout de suite, en fond, sauf les PDF.
  - **Les PDF** se téléchargent à leur première lecture (spec 6.5) : le protocole `cirrus-file:` va chercher au serveur un PDF absent, vérifie son empreinte, le garde, puis le sert.
    - Hors ligne, le lecteur dit « PDF pas encore téléchargé : serveur injoignable. ».
    - Une vignette ne déclenche jamais de téléchargement : elle montre l'icône du genre [C].
  - **Les versions anciennes** d'un fichier, que seul l'historique référence, se téléchargent quand on les ouvre [C].
- **D7, le premier jumelage : envoyer sa base ou prendre celle du serveur.** Une base est « vide » quand elle n'a ni nœud, ni connexion, ni placement, seulement son lobby.
  - **PC vide, serveur vide :** la synchro démarre.
  - **PC plein, serveur vide :** « Envoyer la base de ce PC au serveur ». Le PC envoie son instantané, son journal (pour l'historique) et tous ses fichiers. Ses lignes reçoivent leurs numéros, et la synchro démarre.
  - **PC vide, serveur plein :** « Prendre la base du serveur ».
    - Le PC télécharge l'instantané, le journal et les fichiers autres que les PDF dans un dossier neuf.
    - L'app redémarre sur lui. L'ancienne base est gardée sous `base-avant-jumelage-<date>`.
    - Un téléchargement interrompu laisse l'ancienne base intacte.
  - **PC plein, serveur plein :** refusé, avec l'explication. Seul le remplacement de la base du PC par celle du serveur est proposé, la sienne gardée de même.
  - **Options écartées :**
    - **rejouer le journal du PC au serveur :** une base construite en bloc, comme la base de référence, n'a pas tout son journal ;
    - **un lobby à identifiant fixe pour fusionner deux bases :** la fusion de deux bases entières n'est pas demandée.
- **D8, le démarrage, le hors-ligne et la veille** (spec 6.1).
  - **Au démarrage :** le graphe s'affiche depuis la base locale sous un voile « Synchronisation… », qui retient les actions. Le voile se lève quand le PC a rattrapé le serveur, ou après `syncConnectTimeoutMs` (4 s). Dans ce second cas, une pastille « Hors ligne » reste dans la barre des onglets.
  - **La pastille** dit :
    - « À jour » ;
    - « Envoi de 3 actions… » ;
    - « Hors ligne », avec un clic pour réessayer ;
    - « Serveur : <raison> », pour un refus de version ou de jeton.
  - **La reconnexion** se tente à intervalles croissants, de `syncRetryMinMs` (1 s) à `syncRetryMaxMs` (30 s).
  - **La veille :** à l'annonce de la veille, l'app tente d'envoyer ce qui attend, pendant `syncSuspendFlushMs` (1,5 s). Au réveil, elle remet le voile et reprend la synchro.
  - **Le rythme :** chaque écriture part dès qu'elle est faite. Un déplacement en est déjà une au relâchement. Un `.tex` en est une à chaque enregistrement automatique (après 10 s de pause, plan 4b), ce qui respecte « après 30 secondes sans frappe » au plus tard [C].
  - **Sans serveur jumelé,** rien ne change : l'app fonctionne seule, et ses actions restent en attente, sans effet.
- **D9, les réglages partagés** (spec 19).
  - Le serveur garde chaque réglage avec l'heure de sa dernière modification. Le plus récent gagne, réglage par réglage.
  - Un réglage changé hors ligne part à la reconnexion. Un réglage reçu s'applique tout de suite, borné comme un réglage lu du disque.
  - Les réglages restent hors de l'historique et de l'annulation.
- **D10, formats et versions** (spec 18.1).
  - À chaque branchement, le PC dit au serveur :
    - la version du protocole ;
    - la version du schéma de la base ;
    - la version de l'instantané.
  - Si l'une diffère, le serveur refuse : « Ce serveur garde ses données dans un autre format (schéma 4, ici 5) : mets à jour Cirrus, ou travaille sur un serveur local. ».
  - La mise à jour d'office, les installateurs et l'identité « Cirrus Dev » attendent le plan 9.

**Hors du plan 5a :**
- **Plan 5b :**
  - les publications récupérées par le serveur ;
  - l'import par l'adresse d'un PDF de n'importe quel site (OpenReview, PMLR, actes de NeurIPS…), avec les gardes contre les adresses internes ;
  - le DOI lu dans l'adresse d'un éditeur ;
  - un PDF lâché sur le fond, qui ouvre le dialogue d'import, et le bouton « Choisir un PDF… » de ce dialogue ;
  - « .tex ouvert ailleurs » ;
  - la vue des différences d'un `.tex` en conflit ;
  - « Tout télécharger » ;
  - l'état du serveur : latence, débit, espace.
- **Plan 6 :** le flux des analytics.
- **Plan 9 :**
  - le HTTPS et le serveur loué ;
  - les installateurs, la mise à jour d'office et « Cirrus Dev » ;
  - le dépôt figé de TeX Live.

## Global Constraints

- Les contraintes des plans 3 à 4c valent toujours :
  - travail sur `main`, sans branche, avec un commit puis un push par tâche, jamais en force ;
  - messages de commit en français, terminés par `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` ;
  - syntaxe effaçable, avec l'extension dans les imports ;
  - toute constante de rendu, d'interaction ou de synchro est un paramètre avancé de `RenderParams`, avec un libellé français (groupe « Synchronisation », dans une nouvelle rubrique « Serveur » de `PARAM_RUBRICS`) ;
  - identifiants et commentaires en anglais, textes de l'interface en français.
- **Bornes du serveur :** ce sont des constantes nommées et documentées dans `packages/server/src/bounds.ts`, pas des réglages, car le serveur sert tous les PC.
  - `MAX_BODY_BYTES` : 64 Mio par requête d'actions ;
  - `MAX_UNITS_PER_REQUEST` : 100 ;
  - `MAX_OPS_PER_UNIT` : 200 000 ;
  - `MAX_FILE_BYTES` : 1 Gio ;
  - `MAX_SEED_BYTES` : 2 Gio ;
  - `MAX_JOURNAL_PAGE` : 10 000 lignes ;
  - `SSE_PING_MS` : 15 s ;
  - `PAIRING_TTL_MS` : 10 min ;
  - `PAIRING_TRIES` : 5.
- **Sécurité** (« ne transige pas avec ça, mais pas overkill ») :
  - pas de jeton en clair sur le disque, ni au serveur, ni au PC ;
  - le serveur n'écoute que sur la machine ;
  - toute entrée est vérifiée avant toute écriture : JSON, forme des opérations, empreintes, tailles ;
  - un refus ne laisse rien d'écrit.
- **Données :**
  - une base plus ancienne s'ouvre sans changement (migration v4) ;
  - un fichier du magasin n'est jamais effacé ;
  - la base d'un PC sans serveur se comporte exactement comme au plan 4c.
- **Cloisonnement :**
  - seul le principal touche le réseau et le disque ;
  - le client de synchro du principal ne dépend pas d'Electron (`fetch`, secrets et horloge injectés), pour que les tests fassent tourner plusieurs PC dans un seul processus.
- **Performance :**
  - le coût d'une réconciliation est proportionnel aux actions en attente et aux enregistrements qu'elles touchent, jamais à la taille de la base ;
  - une action reçue sans rien en attente s'applique comme une action locale, par la mise à jour incrémentale de la scène.
- **Tests et captures :**
  - `npx vitest run --maxWorkers=1`, et `tsc` sur chaque paquet touché ;
  - les tests ne parlent qu'à un serveur qu'ils démarrent eux-mêmes, sur `127.0.0.1` et un port libre. Jamais Internet, jamais la base de l'utilisateur, jamais `%LOCALAPPDATA%\Cirrus` ;
  - les fenêtres restent en arrière-plan : `npm run interface`, `captures` et `mesures` seulement, jamais `start`, `dev` ni `essai` depuis un agent, et une seule exécution d'Electron à la fois ;
  - `docs/captures/reference-3c`, `plan4a`, `plan4b` et `plan4c` ne changent pas, sauf écart consigné. Les nouvelles captures vont dans `docs/captures/plan5a/`.

## Review Focus

1. **Deux PC modifient la même chose en même temps :**
   - le même champ, ou deux champs du même nœud ;
   - deux tags ;
   - le même `.tex` ;
   - une suppression d'un côté et une modification de l'autre ;
   - le même nœud inclus dans deux groupes du même plan ;
   - un cycle de groupes créé à deux.

   Tous les PC finissent dans le même état que le serveur, sans violation. Ce qui est écarté est nommé. Testé dans la tâche 1 (simulation) et la tâche 3 (vrais clients).
2. **Le réseau qui casse au mauvais moment :**
   - le serveur arrêté pendant un envoi, l'action appliquée mais sa réponse perdue ;
   - le flux coupé au milieu d'un lot ;
   - l'app fermée avec des actions en attente.

   Rien n'est perdu ni doublé, et tout repart au retour. Testé dans les tâches 2 et 3.
3. **Une requête hostile ou abîmée :**
   - sans jeton, ou avec un jeton révoqué ;
   - signée d'un autre PC ;
   - un JSON invalide, ou un corps trop gros ;
   - une empreinte qui n'est pas de l'hexadécimal, ou un fichier dont les octets ne correspondent pas à l'empreinte ;
   - une opération mal formée, ou un code de jumelage deviné.

   Elle est refusée sans rien écrire, et le serveur continue. Testé dans la tâche 2.
4. **Une horloge de PC décalée :** l'écart est corrigé et signalé. Un PC en avance d'une heure ne gagne pas tous les conflits. Testé dans la tâche 3.
5. **Un premier jumelage interrompu, ou entre deux bases pleines :** l'ancienne base reste intacte et utilisable, et le refus s'explique. Testé dans la tâche 5.

---

### Task 1 : Cœur — fusion, réconciliation, validation des opérations, journal v4

**Files :**
- Create :
  - `packages/core/src/merge.ts` : la fusion des enregistrements et le rejeu d'une écriture ;
  - `packages/core/src/sync.ts` : les types de la synchro et `reconcile` ;
  - `packages/core/tests/merge.test.ts`, `packages/core/tests/reconcile.test.ts` ;
  - le registre du plan.
- Modify :
  - `packages/core/src/ops.ts` : `parseOp` ;
  - `commands.ts` : `addedViolation`, tiré de `Draft.finish` ;
  - `history.ts` : `UndoStack.forget` ;
  - `index.ts` ;
  - `packages/store/src/schema.ts` (v4) et `localStore.ts`, avec leurs tests.

**Interfaces (Produces) :**
- `interface Unit { unit: Id; action: Id; label: string; at: number; pc: string; ops: Op[] }` : une écriture. `interface RemoteUnit extends Unit { seq: number }` : `seq` est le numéro de sa dernière ligne au serveur, et ses lignes vont de `seq - ops.length + 1` à `seq`.
- `parseOp(x: unknown): Op` et `parseUnit(x: unknown): Unit` :
  - ils vérifient toute la forme : le type de l'opération, chaque champ de chaque enregistrement, des nombres finis, et des chaînes bornées (identifiants de 128 caractères au plus, libellé de 500) ;
  - `MAX_OPS_PER_UNIT` ;
  - ils lèvent `SyncFormatError`, avec un message en français.
- `addedViolation(s: State, ops: readonly Op[]): Violation | null` : `ops` déjà appliqués à `s`. C'est la règle de `Draft.finish`, que `finish` appelle désormais.
- `rebaseUnit(s: State, u: Unit, remote: readonly RemoteUnit[]): { unit: Unit | null; conflictCopies: string[] }` : l'écriture rejouée sur l'état courant (D4), ou `null` si elle ne change plus rien.
- `reconcile(s: State, pending: readonly Unit[], incoming: readonly RemoteUnit[], refused: readonly { unit: Id; message: string }[]): Reconciliation`. Elle laisse `s` dans l'état réconcilié, ou intact quand elle lève `SyncDivergedError`, si une opération reçue ne s'applique pas.
  - `interface Reconciliation { rewind: Op[]; remote: RemoteUnit[]; rebased: Unit[]; dropped: { unit: Unit; message: string }[]; acked: Id[]; notices: string[] }`.
  - Une écriture reçue qui est la première en attente, aux mêmes opérations, est un accusé de réception : aucun inverse n'est écrit pour elle.
- `UndoStack.forget(action: Id): void`.
- `LocalStore` :
  - `commit(a: Action, opts?: { at?: number; unit?: Id }): number`, inchangé pour ses appelants. L'interface donne l'identifiant de l'écriture ; sans lui, `uuidv7()` ;
  - `pendingUnits(limit?: number): Unit[]` ;
  - `applyReconciliation(r: Reconciliation): number`, en une transaction, chaque « avant » vérifié ;
  - `lastServerSeq(): number`.
- **Schéma v4 :** `changes` gagne `unit TEXT`, `kind TEXT NOT NULL DEFAULT 'local'` et `superseded INTEGER NOT NULL DEFAULT 0`, avec un index sur `unit`. Les lignes existantes prennent `unit = action_id`.

- [ ] **Step 1 : tests.**
  - **Fusion :** un tableau de cas, un par règle de D4. Notamment :
    - deux champs différents ;
    - le même champ, le plus récent gagnant, et à égalité d'heure l'identifiant du PC ;
    - un tag ajouté de chaque côté ;
    - une clé à une valeur ;
    - un `.tex` changé des deux côtés, qui donne la copie de conflit ;
    - un rôle de membre ;
    - un nœud jeté d'un côté et renommé de l'autre, qui revient avec ses placements ;
    - une écriture devenue sans effet, qui disparaît.
  - **`reconcile` :** l'accusé de réception ; une écriture en retard rejouée ; une écriture refusée par le serveur, écartée avec son message ; deux inclusions du même nœud, la seconde écartée ; une opération reçue qui ne s'applique pas lève `SyncDivergedError`, l'état intact.
  - **Simulation** (le test qui compte) : un séquenceur en mémoire, qui applique les règles du serveur (D1), et trois PC virtuels.
    - Ils jouent 2 000 commandes tirées au hasard, à graine fixe : créer, renommer, taguer, déplacer, inclure, exclure, jeter, connecter, changer un rôle.
    - Leurs livraisons sont retardées et mêlées au hasard.
    - Au repos, les quatre états sont égaux (`canonical(toSnapshot(s))`), et `checkState` ne trouve rien.
  - **`parseOp` :** chaque type d'opération fait l'aller-retour, et un champ manquant, un `NaN` ou une chaîne trop longue sont refusés.
  - **Base :**
    - la migration v4 d'une base v3 ;
    - `applyReconciliation`, qui écrit tout ou rien ;
    - le rejeu du journal après réconciliation, qui redonne les tables ;
    - `pendingUnits` ;
    - `last_server_seq`.
- [ ] **Step 2 :** lancer. Attendu : échec.
- [ ] **Step 3 :** implémenter.
- [ ] **Step 4 :** la suite complète et `tsc`. Les captures ne doivent pas changer.
- [ ] **Step 5 :** créer le registre. Commit et push (`feat(core): fusion et réconciliation des actions, journal v4`).

### Task 2 : Le serveur

**Files :**
- Create : `packages/server/` :
  - `package.json`, avec le script `serveur` ;
  - `src/main.ts` : la ligne de commande ;
  - `src/server.ts` : HTTP et les routes ;
  - `src/canon.ts` : la base de référence et l'acceptation des actions ;
  - `src/tokens.ts` : le jumelage et les jetons ;
  - `src/events.ts` : le flux SSE ;
  - `src/bounds.ts` : les bornes ;
  - `tests/`.

**Interfaces (Produces) :**
- `startServer(opts: { dataDir: string; port: number; host?: string; now?: () => number }): Promise<RunningServer>` ; `interface RunningServer { url: string; close(): Promise<void> }`.
  - Une autre adresse que `127.0.0.1` ou `::1` est refusée : « Le serveur n'écoute que sur cette machine tant qu'il n'a pas de HTTPS (plan 9). ».
  - Les données vont dans `dataDir/base/` (la base, au format d'un PC) et `dataDir/serveur.db` (les PC, les codes de jumelage et les réglages).
- **Ligne de commande :** `npm run serveur -w packages/server -- [--data <dossier>] [--port 7310]`. Par défaut, les données vont dans `%LOCALAPPDATA%\Cirrus\serveur`. Elle accepte aussi `jumeler "<nom>"`, `pcs` et `revoquer "<nom>"`.
- **Routes** (JSON, sauf mention) :
  - `POST /pair {code, pc, name}` donne `{token}`. C'est la seule route sans jeton.
  - `GET /hello`, avec les en-têtes `Cirrus-Protocol`, `Cirrus-Schema` et `Cirrus-Snapshot`, donne `{serverTime, lastSeq, empty}`. Un format différent répond 409, avec le message de D10.
  - `GET /events?after=<seq>` : le flux. `event: unit` porte une `RemoteUnit` ; `event: settings` sert à la tâche 6. Un `: ping` part toutes les `SSE_PING_MS`.
  - `POST /units {units: Unit[]}` donne `{results: ({accepted: number} | {stale: number} | {refused: string})[]}`, traités dans l'ordre. Après le premier non accepté, les suivants sont `{stale}`.
  - `POST /files/missing {hashes}` donne `{missing}`. `PUT /files/<hash>` reçoit des octets bruts, et `GET /files/<hash>` les rend.
  - `GET /snapshot` rend l'instantané (en-tête `Cirrus-Seq`). `GET /journal?after=&limit=` rend les pages du journal, pour l'historique.
- **`Canon.accept(u: Unit, pc: string)`, dans cet ordre :**
  1. `parseUnit`, sinon refusée ;
  2. l'identifiant du PC doit être celui du jeton, sinon 403 ;
  3. une écriture déjà connue est acceptée avec son numéro, sans rien appliquer ;
  4. un fichier référencé absent la refuse : « Fichier manquant au serveur. » ;
  5. `applyOps` sur l'état, sinon en retard ;
  6. `addedViolation`, sinon refusée, l'état remis ;
  7. l'écriture dans la base (`kind: 'local'`, et l'heure, le PC et l'identifiant de l'écriture reçus) ;
  8. le relais à tous les flux ouverts.
- **L'instantané du serveur** s'écrit toutes les 500 écritures (`SERVER_SNAPSHOT_UNITS`) et à l'arrêt.

- [ ] **Step 1 : tests** (serveur dans le processus, port libre).
  - **Jumelage :** le code, puis le jeton. Un code faux, expiré ou épuisé est refusé. La base ne contient que l'empreinte du jeton.
  - **Accès :**
    - sans jeton : 401 ;
    - jeton révoqué : 401 ;
    - écriture signée d'un autre PC : 403 ;
    - corps trop gros : 413 ;
    - JSON invalide : 400 ;
    - empreinte mal formée : 400 ;
    - octets qui ne correspondent pas à l'empreinte : 400, rien gardé.
  - **Actions :**
    - acceptée, puis relayée à deux flux ;
    - en retard ;
    - refusée pour une violation ;
    - la même envoyée deux fois, appliquée une seule fois ;
    - un fichier manquant.
  - **Flux :** la reprise après `Last-Event-ID`, sans trou ni doublon.
  - **Redémarrage :** le serveur arrêté puis relancé reprend sa numérotation et son état, par l'instantané et la fin du journal.
  - **Adresse :** démarrer sur `0.0.0.0` est refusé.
- [ ] **Step 2 :** lancer. Attendu : échec.
- [ ] **Step 3 :** implémenter.
- [ ] **Step 4 :** la suite complète et `tsc`.
- [ ] **Step 5 :** commit et push (`feat(server): serveur local, jumelage, acceptation et relais des actions`).

### Task 3 : Le client de synchro du principal

**Files :**
- Create :
  - `packages/app/src/main/sync/client.ts` ;
  - `sync/events.ts` : la lecture d'un flux SSE ;
  - `sync/config.ts` : `serveur.json` et le secret ;
  - `sync/downloads.ts` ;
  - `packages/app/tests/support/virtualPc.ts` ;
  - `packages/app/tests/sync.test.ts`.

**Interfaces (Produces) :**
- `interface ServerConfig { url: string; token: string; name: string }`. Elle est lue et écrite par `SecretStore { read(): ServerConfig | null; write(c: ServerConfig | null): void }` : `safeStorage` dans l'app, en clair dans les tests.
- `interface SyncDeps { fetch: typeof fetch; store: LocalStore; storeDir: string; secrets: SecretStore; reconcile(incoming: RemoteUnit[], refused: { unit: Id; message: string }[]): Promise<void>; now(): number; params(): SyncParams; status(s: SyncStatus): void }`.
- `class SyncClient` :
  - `constructor(deps: SyncDeps)` ;
  - `start(): void` et `stop(): Promise<void>` ;
  - `kick(): void`, après chaque écriture locale ;
  - `flush(ms: number): Promise<void>`, à la veille ;
  - `fetchBlob(hash: string): Promise<boolean>` ;
  - `clockOffset(): number`.
- `type SyncStatus = { state: 'off' } | { state: 'connecting' } | { state: 'catching-up'; behind: number } | { state: 'live'; pending: number } | { state: 'offline'; pending: number } | { state: 'refused'; message: string }`, plus `clockWarning?: string`.
- **L'envoi :**
  - les écritures en attente, dans l'ordre, au plus `syncBatchUnits` par requête ;
  - les fichiers manquants au serveur d'abord, chacun une fois ;
  - `stale(n)` : le client attend d'avoir reçu jusqu'à `n`, puis renvoie ce qui attend alors ;
  - `refused` : l'écriture passe à la réconciliation comme écartée.
- **La réception :** des lots de 50 ms au plus, passés à `reconcile`. `last_server_seq` n'avance qu'avec l'écriture de la réconciliation.
- **Les téléchargements :** les fichiers des enregistrements reçus, autres que des PDF, qui manquent au magasin, `syncDownloads` (4) à la fois. Chacun est vérifié par son empreinte.
- **`virtualPc` :** un PC sans Electron, avec une `LocalStore` dans un dossier temporaire, un `State`, `reconcile` et `applyReconciliation`, et un `SyncClient` sur le `fetch` de Node.

- [ ] **Step 1 : tests** (deux ou trois PC virtuels et un serveur dans le processus).
  - Une action sur A est appliquée sur B.
  - Des actions faites des deux côtés en même temps, puis le repos : les trois états sont égaux.
  - B hors ligne (serveur arrêté), qui agit puis revient : tout passe, dans les deux sens.
  - Le chemin « en retard ».
  - Le chemin « refusé » : deux inclusions, et la notification.
  - Un `.txt` ajouté sur A arrive au magasin de B ; un PDF n'y arrive qu'après `fetchBlob`.
  - Le client arrêté entre l'acceptation et sa réponse : rien n'est doublé au serveur.
  - Une horloge de PC en avance de 10 min : `clockWarning`, et les heures des actions corrigées.
  - La reconnexion respecte `syncRetryMinMs` et `syncRetryMaxMs` (horloge simulée).
- [ ] **Step 2 :** lancer. Attendu : échec.
- [ ] **Step 3 :** implémenter.
- [ ] **Step 4 :** la suite complète et `tsc`.
- [ ] **Step 5 :** commit et push (`feat(app): client de synchro du principal`).

### Task 4 : L'app — réconciliation dans l'interface, voile, pastille, jumelage, PDF à la demande

**Files :**
- Create :
  - `packages/app/src/main/sync/wire.ts` : les IPC et la veille ;
  - `renderer/sync/syncSession.ts` ;
  - `ui/SyncVeil.tsx`, `ui/SyncChip.tsx` ;
  - `ui/settings/ServerBlock.tsx` ;
  - des tests.
- Modify :
  - `main/index.ts`, `main/base.ts` (`cirrus:load` envoie aussi les écritures en attente), `main/files.ts` (`cirrus-file:` va chercher un PDF absent) ;
  - `preload/index.ts`, `renderer/env.d.ts` ;
  - `renderer/session.ts`, `App.tsx` ;
  - `packages/view/src/params.ts`.

**Interfaces (Produces) :**
- **IPC :**
  - `cirrus:sync:incoming`, du principal vers l'interface, porte `{ units: RemoteUnit[]; refused: { unit: Id; message: string }[] }` ;
  - `cirrus:sync:reconciled` porte une `Reconciliation`, que le principal écrit avant de rendre le numéro du journal ;
  - `cirrus:sync:status` porte un `SyncStatus` ;
  - `cirrus:sync:pair(url, code, name)` et `cirrus:sync:unpair()`.
- **`EditSession`** :
  - `reconcile(units: RemoteUnit[], refused: …): Promise<{ notices: string[]; dropped: string[] }>`, dans la même file que les actions ;
  - `pending: Unit[]`, au chargement depuis la base, puis entretenu à chaque écriture ;
  - chaque écriture tire son identifiant (`uuidv7()`) et le passe à `window.cirrus.commit(a, unit)`.
- **La scène :** la mise à jour incrémentale reçoit, comme une seule action, les opérations de la réconciliation : inverses, reçues et rejouées.
- **Réglages :**
  - la rubrique « Serveur » commence par un bloc. Non jumelé, il montre « Adresse du serveur » (par défaut `http://127.0.0.1:7310`), « Code de jumelage », « Nom de ce PC » (par défaut le nom de la machine) et « Jumeler ». Jumelé, il montre l'état et « Dissocier ce PC » ;
  - le groupe « Synchronisation » contient :
    - `syncConnectTimeoutMs` (4 000) ;
    - `syncRetryMinMs` (1 000) et `syncRetryMaxMs` (30 000) ;
    - `syncBatchUnits` (50) ;
    - `syncDownloads` (4) ;
    - `syncClockSkewWarnMs` (120 000) ;
    - `syncSuspendFlushMs` (1 500).
- **`cirrus-file:` :**
  - avec un serveur, un blob absent est demandé à `SyncClient.fetchBlob`, puis servi ;
  - hors ligne, il répond 503, et le lecteur dit « PDF pas encore téléchargé : serveur injoignable. » ;
  - une requête de vignette (`?vignette`) ne télécharge jamais.
- **La veille :** `powerMonitor`, `suspend` puis `flush(syncSuspendFlushMs)`, `resume` puis le voile et la reconnexion.

- [ ] **Step 1 : tests.**
  - `EditSession.reconcile` : rejouer, écarter, accuser réception, et `forget` sur la pile. Une action locale arrivée pendant une réconciliation passe après elle.
  - Le chargement rend les écritures en attente.
  - `cirrus-file:` avec un faux serveur : téléchargé, vérifié, servi ; une empreinte fausse est refusée ; le hors-ligne donne 503 ; une vignette ne télécharge pas.
  - Le groupe et la rubrique des réglages.
  - Le bloc « Serveur » : jumeler et dissocier.
- [ ] **Step 2 :** lancer. Attendu : échec.
- [ ] **Step 3 :** implémenter, puis lancer les captures. Sans serveur, rien ne doit changer à l'écran : ni voile ni pastille.
- [ ] **Step 4 :** la suite complète et `tsc`.
- [ ] **Step 5 :** commit et push (`feat(app): synchro dans l'interface, voile, pastille et jumelage`).

### Task 5 : Le premier jumelage — envoyer sa base, ou prendre celle du serveur

**Files :**
- Modify :
  - `packages/server/src/server.ts` et `canon.ts` : `POST /seed`, `/seed/journal` et `/seed/done` ;
  - `packages/store/src/localStore.ts` : `importState`, `importJournal` et `isEmpty` ;
  - `main/sync/` (`firstSync.ts`) ;
  - `ServerBlock.tsx` ;
  - des tests.

**Interfaces (Produces) :**
- `LocalStore` :
  - `isEmpty(): boolean`, au sens de D7 ;
  - `importState(s: State, seq: number): void`, en bloc, comme `bulk.ts` ;
  - `importJournal(rows: ChangeRow[]): void`.
- **Envoyer sa base (`seed`) :**
  - seulement vers un serveur vide, et seulement par le PC qui vient de se jumeler ;
  - d'abord les fichiers, tout `files/` ;
  - puis l'instantané, au plus `MAX_SEED_BYTES` ;
  - puis le journal par pages ;
  - enfin `done`, qui rend le serveur non vide et numérote les lignes du PC.
- **Prendre la base du serveur (`adopt`) :**
  - l'instantané, le journal par pages et les fichiers autres que les PDF vont dans `<base>-nouvelle` ;
  - puis `app.relaunch()` sur elle. L'ancienne base est renommée `base-avant-jumelage-<AAAA-MM-JJ>` ;
  - une interruption supprime `<base>-nouvelle` et laisse tout le reste.
- **Les dialogues** (D7) : « Envoyer la base de ce PC au serveur (n nœuds, m fichiers) », « Prendre la base du serveur (n nœuds) », et le refus entre deux bases pleines, avec le remplacement proposé.

- [ ] **Step 1 : tests.**
  - `seed` puis `adopt`, entre deux PC virtuels : les états sont égaux, l'historique d'un nœud est complet, et les fichiers sont là, PDF à part.
  - Le refus entre deux bases pleines.
  - `seed` refusé vers un serveur qui n'est plus vide.
  - Un `adopt` interrompu au milieu : l'ancienne base est intacte.
- [ ] **Step 2 :** lancer. Attendu : échec.
- [ ] **Step 3 :** implémenter.
- [ ] **Step 4 :** mesurer `seed` et `adopt` sur la base de référence (50 000 nœuds, 500 000 connexions), et la mémoire du serveur une fois chargé. Ces mesures vont au registre.
- [ ] **Step 5 :** la suite complète et `tsc`. Commit et push (`feat: premier jumelage, envoyer sa base ou prendre celle du serveur`).

### Task 6 : Les réglages partagés

**Files :**
- Modify :
  - `packages/server/src/server.ts`, `tokens.ts` (la table `settings`) ;
  - `main/settings.ts`, `main/sync/client.ts`, `preload`, `App.tsx` ;
  - des tests.

**Interfaces (Produces) :**
- **Serveur :**
  - `GET /settings` rend `{ [key]: { value, at, pc } }` ;
  - `POST /settings { changes: { [key]: { value: unknown | null; at: number } } }` : le plus récent gagne, clé par clé, puis l'identifiant du PC. `null` revient à la valeur par défaut ;
  - `event: settings` porte les clés changées.
- **PC :**
  - `settings.json` reste la copie locale ;
  - un changement fait dans les Réglages est noté avec son heure dans `settings-pending.json` jusqu'à son envoi ;
  - un changement reçu s'écrit dans `settings.json` et va à l'interface (`cirrus:settings:changed`), borné par `withOverrides`.

- [ ] **Step 1 : tests.**
  - Le plus récent gagne, et à égalité d'heure l'identifiant du PC.
  - Un réglage changé hors ligne part au retour.
  - Deux PC finissent avec les mêmes réglages.
  - Une valeur hors bornes reçue est ramenée dans ses bornes, et une clé inconnue est ignorée.
- [ ] **Step 2 :** lancer. Attendu : échec.
- [ ] **Step 3 :** implémenter.
- [ ] **Step 4 :** la suite complète et `tsc`.
- [ ] **Step 5 :** commit et push (`feat: réglages partagés par le serveur`).

### Task 7 : Scénarios, mesures, captures, spec

**Files :**
- Create : `packages/app/scripts/mesures-synchro.mjs`.
- Modify :
  - `scripts/interface.mjs` (scénarios de synchro) et `scripts/captures.mjs` ;
  - la spec ;
  - le registre.

- [ ] **Step 1 : les scénarios** (`npm run interface`, une seule fenêtre d'Electron à la fois, en arrière-plan). Ils lancent un serveur sur des données temporaires et jumellent par la ligne de commande.
  1. L'app A crée un nœud avec un `.txt` et quitte. L'app B prend la base du serveur, puis montre le nœud et son fichier.
  2. B est ouverte. Un PC virtuel renomme le nœud : B montre le nouveau titre en moins d'une seconde.
  3. Le serveur est arrêté : la pastille de B dit « Hors ligne ». B agit, puis le serveur revient : l'action part, et le PC virtuel la reçoit.
  4. Un PDF absent de B s'ouvre : il est téléchargé, puis affiché.
- [ ] **Step 2 : les mesures** (`npm run mesures`), trois passes chacune :
  - du `commit` sur un PC virtuel à l'action appliquée dans l'app B, sur 50 actions : la médiane et le p95. **Critère : p95 sous 200 ms.**
  - la réconciliation de 10 écritures en attente contre 100 reçues : **sous 50 ms**.
  - l'acceptation d'une action au serveur, sur la base de référence : **médiane sous 10 ms**.
  - `seed`, `adopt` et la mémoire du serveur (tâche 5), reportés.
- [ ] **Step 3 : les captures** dans `docs/captures/plan5a/` : le voile, la pastille « Hors ligne », et le bloc « Serveur », jumelé et non jumelé. Les références des plans précédents restent à 0 pixel d'écart.
- [ ] **Step 4 : la spec.**
  - Sections 4 (le serveur), 6 (« Fixé par le plan 5a » : D4 à D8), 18 (le serveur local, le jumelage, les routes, les bornes) et 19 (les réglages partagés).
  - Section 23 : le risque d'horloge.
  - Section 24 : ce qui part au plan 5b.
- [ ] **Step 5 :** la suite complète, `tsc`, les scénarios et les captures. Commit et push (`docs: plan 5a, mesures, captures et spec`).
