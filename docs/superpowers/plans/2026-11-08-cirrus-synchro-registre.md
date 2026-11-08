# Registre du plan 5a : serveur local et synchronisation — mesures, décisions, écarts

Plan : `docs/superpowers/plans/2026-11-08-cirrus-synchro.md`, approuvé par l'utilisateur le 2026-11-08 (005129a, départ du plan). Spec : `2026-11-02-cirrus-design.md`, sections 3, 4, 5.6, 6, 18, 18.1, 19 et 21 (point 3). Une décision que le plan ne fixe pas se consigne ici sous la forme `Ruling:` : ses options, le choix, pourquoi, et son coût s'il est faux.

Décisions du contrôleur avant la tâche 1 (journal du contrôleur, `.superpowers/sdd/2026-11-08-cirrus-synchro/progress.md`) : R1 (`commit` reçoit aussi le PC d'origine), R2 (`SERVER_SNAPSHOT_UNITS` dans `bounds.ts`), R3 (le réglage `syncReceiveBatchMs`), R4 (le nom d'une copie de conflit d'un `.tex`).

## Tâche 1 : cœur — fusion, réconciliation, validation des opérations, journal v4

### Fait

- **`ops.ts`** : `parseOp`, `SyncFormatError` et `MAX_ID_CHARS` (128).
- **`sync.ts`**, nouveau :
  - les types `Unit`, `RemoteUnit` et `Reconciliation` ;
  - `parseUnit` et `parseRemoteUnit` ;
  - `MAX_LABEL_CHARS` (500) et `MAX_OPS_PER_UNIT` (200 000) ;
  - `reconcile` et `SyncDivergedError`.
- **`merge.ts`**, nouveau : `rebaseUnit`, la fusion de D4 ; `fileNameKey`, la règle des noms de fichiers du réimport.
- **`commands.ts`** : `addedViolation`, tiré de `Draft.finish`, qui l'appelle désormais.
- **`history.ts`** : `UndoStack.forget`.
- **Magasin :**
  - schéma v4 : `unit`, `kind`, `superseded`, l'index `changes_unit`, et l'index partiel `changes_pending` ;
  - `commit(a, { at, unit, pc })` ;
  - `pendingUnits(limit)`, `applyReconciliation(r)` et `lastServerSeq()` ;
  - `historyOf` sans les inverses ;
  - `ChangeRow` gagne `unit`, `kind` et `superseded`.
- **L'app** : `nameKey` (`renderer/files/merge.ts`) est désormais `fileNameKey` du cœur.

### Mesures

- **La simulation** (`reconcile.test.ts`) : trois PC virtuels et un séquenceur, qui applique les règles du serveur (D1), à graine fixe.
  - 2 000 commandes tirées, dont environ 1 830 écritures et 126 commandes refusées sur place.
  - Environ 2 170 réconciliations, 1 360 accusés de réception, 930 écritures réécrites, 41 écartées, et 2 500 réponses « en retard ».
  - Au repos : les quatre états sont égaux, et `checkState` ne trouve rien.
  - Durée : 2,4 s.
- **La même simulation sur 30 graines** (fichier jetable, hors du dépôt) : toutes convergent, sans violation, en 3,3 s chacune en moyenne. Par graine, les chemins « suppression perdue » et « retour » servent environ 300 et 20 fois, et 30 placements ou branches sont rendus.
- **Après le fix de la revue** (une copie par conflit d'un `.tex`), la simulation tire aussi l'enregistrement d'un `.tex` sur les nœuds les plus disputés.
  - Sur 2 000 commandes : environ 1 800 écritures, 2 290 réconciliations, 1 250 écritures réécrites, 48 écartées, et 45 notifications de copie de conflit.
  - Au repos, l'état final garde 30 copies, au plus 7 sur un même nœud, chacune d'un conflit distinct dans le temps.
  - Durée : 2,35 s.

### Décisions

- Ruling: **un accusé de réception n'est que la tête des écritures reçues** : `acked` liste les écritures en attente que le serveur relaie en premier, telles quelles. Une écriture acceptée après celle d'un autre PC arrive derrière elle.
  - Elle est d'abord défaite avec les autres écritures en attente, puis reçue comme les autres écritures. Elle ne figure ni dans `acked` ni dans `rebased`.
  - Ses lignes sont réécrites avec leur numéro, de genre `local`, puisque c'est une action de ce PC, et ses lignes d'origine sont marquées remplacées.
  - Options :
    - la numéroter en place, comme un accusé : impossible, ses lignes ont été défaites avant les écritures reçues qui la précèdent ;
    - la réécrire (choix).
  - Coût si faux : deux lignes de plus au journal pour une telle écriture. Son action quitte aussi la pile d'annulation (tâche 4), bien qu'inchangée.
- Ruling: **`rebased` est toujours la liste des écritures en attente après la réconciliation.**
  - Si rien n'a été défait (`rewind` vide), ce sont les mêmes objets, et la base n'écrit rien pour elles. Sinon, chacune est réécrite.
  - Une écriture rejouée sans changement revient sous le même objet : la tâche 4 sait ainsi ce qui a vraiment été réécrit, et donc ce qui quitte la pile (`forget`).
  - Les consommateurs prennent `pending = r.rebased`, sans cas à part.
  - Coût si faux : nul.
- Ruling: **le message d'une écriture écartée est la phrase entière**, « « Mettre « X » dans « G » » écartée : « X » est déjà dans le groupe « H », depuis un autre PC. ».
  - Pour une violation `twoGroups`, le groupe « H » est cherché, sans l'écriture, dans les plans de ses branches. Toute autre violation donne son propre message.
  - Pour un refus du serveur, la phrase reprend son message.
  - `notices` porte les autres notifications : les copies de conflit.
  - Coût si faux : un format de chaîne.
- Ruling: **supprimé d'un côté, modifié de l'autre, la modification gagne aussi pour ce qui n'est pas un enregistrement entier**, comme le dit la spec 6.2 : un fichier, un membre, un placement, un fantôme, une forme de connexion ou une clé du registre. Le plus récent ne gagne que si les deux côtés l'ont changé.
  - Options : le plus récent gagne toujours, en lisant D4 (« le plus récent gagne [C] ») à la lettre.
  - Coût si faux : un déplacement perdrait contre une suppression plus ancienne.
- Ruling: **ce que perd une suppression en attente d'un objet modifié ailleurs** :
  - son enregistrement et ses placements et branches, comme le dit D4 ;
  - aussi ses appartenances, et les connexions que l'écriture jetait pour avoir perdu ce membre ;
  - ses fantômes, enfin.
  - Pourquoi : sinon, « Supprimer partout » contre un renommage ailleurs serait écartée pour une violation `branchNotMember` (une branche gardée, son membre retiré), avec un message obscur.
  - Les placements d'un nœud comptent comme une modification : un nœud déplacé ailleurs pendant qu'il est jeté ici n'est pas jeté.
  - Coût si faux : une suppression rejouée en partie, quelques lignes.
- Ruling: **ce qui revient avec un objet supprimé ailleurs et modifié ici** :
  - Pour un nœud, une modification est un changement de son enregistrement ou d'un de ses placements (déplacé, ou posé dans un autre plan). Le nœud revient alors, et l'écriture rejouée écrit son enregistrement s'il n'y était pas.
  - Reviennent aussi les placements de ce nœud que l'écriture qui l'a supprimé avait retirés, si leur plan existe. Reviennent enfin ses branches, dans une connexion vivante dont il est membre, ou les branches de la connexion revenue.
  - Ne reviennent ni ses appartenances retirées ni les connexions jetées, comme le dit D4 (« les placements et les branches »).
  - Coût si faux : un nœud déplacé ici et jeté ailleurs revient. Sinon, l'écriture serait écartée pour `trashedPlaced`.
- Ruling: **un tag se fusionne par clé quand le registre déclare sa clé `multi: false` et d'un genre autre que `word`**. Tout autre tag est un élément (clé, valeur) d'un ensemble.
  - Coût si faux : un mot déclaré à une valeur se fusionnerait par clé.
- Ruling: **l'ordre d'une liste fusionnée** (tags, fichiers, membres) : celui du serveur, puis ce que seule l'écriture a, dans son ordre, puis les copies de conflit.
  - Coût si faux : un ordre d'affichage.
- Ruling: **`parseOp` est strict.**
  - Un champ inconnu est refusé. Un identifiant compte de 1 à 128 caractères : celui d'un enregistrement, une clé de tag, le nœud d'un membre ou d'une poignée, et ceux de l'écriture, de l'action et du PC.
  - Le libellé compte 500 caractères au plus. Une empreinte compte 64 chiffres hexadécimaux en minuscules, et une taille est un entier positif.
  - Les autres textes (titre, résumé, relation, valeur de tag, préambule) ne sont bornés que par `MAX_BODY_BYTES`.
  - `parseOp` rend l'opération reçue telle quelle, sans copie.
  - Options : ignorer un champ inconnu. Mais le serveur garderait alors n'importe quoi, et un « avant » nettoyé ne correspondrait plus.
  - Coût si faux : une écriture portant un champ étranger est refusée par le serveur, et donc écartée avec sa notification. Les commandes d'aujourd'hui n'en produisent pas.
- Ruling: **`parseRemoteUnit`**, absent des interfaces du plan, lit une écriture relayée (`seq` entier, au moins égal à son nombre d'opérations) pour le flux de la tâche 3. `parseUnit` refuse un `seq`.
  - Coût si faux : nul.
- Ruling: **`MAX_OPS_PER_UNIT` et `MAX_LABEL_CHARS` sont des constantes du cœur** (`sync.ts`), que `parseUnit` applique. Le `bounds.ts` de la tâche 2 réexporte `MAX_OPS_PER_UNIT`.
  - Coût si faux : nul.
- Ruling: **les numéros du serveur commencent à 1**, et `last_server_seq` vaut 0 tant que rien n'est reçu. La spec 6.2 dit « à partir de 0 ».
  - `applyReconciliation` exige que les lignes reçues suivent `last_server_seq` exactement, sans trou ni recouvrement. Sinon, elle lève une erreur et n'écrit rien.
  - La tâche 2 numérote donc ses lignes à la suite depuis 1, ce que fait le `local_seq` de sa base.
  - Coût si faux : un décalage d'un numéro.
- Ruling: **les inverses d'une réconciliation forment une seule écriture**, au libellé « Défaire les écritures en attente (synchronisation) », signée de ce PC et jamais envoyée. `historyOf` ne les montre pas.
  - Coût si faux : nul.
- Ruling: **l'index partiel `changes_pending`**, en plus de l'index sur `unit` que demande le plan : `pendingUnits` et le marquage des lignes remplacées ne lisent pas tout le journal.
  - Coût si faux : un index de plus.
- Ruling: **`historyOf` montre les lignes remplacées**, celle qui a perdu comme celle que remplace sa version rejouée, avec `kind` et `superseded` pour l'interface. Il ne cache pas une ligne remplacée dont la version rejouée est identique.
  - Pourquoi : la fiche d'un nœud compte des actions (`historySummary`), et la version rejouée garde l'identifiant de son action : elle ne compte pas en double.
  - Coût si faux : une ligne en double dans une future vue détaillée de l'historique.
- Ruling: **`nameKey` de l'app est `fileNameKey` du cœur**, une seule règle pour le réimport et la fusion.
  - Coût si faux : nul.
- Ruling: **`UndoStack.forget(action)`** retire le pas des deux piles, et aussi un pas qu'une autre action a complété (`extend`), quand l'une ou l'autre est nommée. Les écritures d'une annulation ou d'un rétablissement (identifiants nouveaux) ne sont pas suivies.
  - Une telle écriture réécrite laisse son pas en pile, mais l'essai à blanc refusera ensuite ce qui ne s'applique plus.
  - Coût si faux : une annulation proposée, puis refusée (« a été modifié depuis »).
- Ruling: **après la migration v4, tout le journal d'une base existante est en attente** : ses lignes sont locales, sans numéro du serveur.
  - D7 (tâche 5) les numérote quand on envoie la base au serveur.
  - D'ici là, la tâche 4 n'envoie les écritures en attente à l'interface qu'avec un serveur jumelé.
  - Elle ne les tronque pas : une réconciliation défait toutes les écritures en attente, et `applyReconciliation` vérifie que le compte y est. `pendingUnits(limit)` ne sert qu'à former un lot à envoyer (tâche 3). Ceci corrige le rapport de la tâche 1, qui conseillait de borner `cirrus:load` par `limit` (revue de la tâche 1, Minor 1).
  - Après la migration, une même action peut aussi donner deux écritures de même identifiant : `unit = action_id`, et avant v4 les enregistrements d'un `.tex` (plan 4b) n'étaient pas toujours voisins dans le journal. `pendingUnits` rend alors `[X, Y, X]`, que le serveur prendrait pour un doublon. Le journal migré ne doit donc partir que par l'envoi de la base (D7, tâche 5), jamais écriture par écriture (revue, Minor 2).
  - Coût si faux : la mémoire au chargement, pour un journal de plusieurs milliers d'actions.
- Ruling: **`commit` écrit toujours une ligne locale sans numéro** (`kind 'local'`, `server_seq` NULL), au serveur aussi (R1). Sur la base du serveur (tâche 2), chaque ligne compterait donc comme en attente, et l'index partiel `changes_pending` couvrirait tout le journal.
  - La tâche 2 a besoin d'écrire le numéro de chaque ligne qu'elle accepte : soit un champ de plus à `commit`, soit son propre numéro de ligne (`local_seq`) pris comme numéro du serveur. C'est à elle de trancher, et de le consigner ici. Le journal du serveur envoyé à un PC (D7) doit porter ses numéros (revue, Minor 3).
  - Coût si faux : un index partiel inutile au serveur.
- Ruling: **une seule copie de conflit par conflit d'un `.tex`**, qui tient la dernière version du côté perdant (fix de la revue de la tâche 1, Important 1).
  - Le problème : chaque écriture en attente est rejouée seule. Plusieurs enregistrements du même `.tex` (une action, une écriture par enregistrement, plan 4b) contre un changement reçu donnaient une copie et une notification par enregistrement perdant. Une écriture déjà rejouée, avec sa copie, qui était rejouée de nouveau sur un autre changement du `.tex`, gardait aussi une copie de la version intermédiaire de l'autre PC.
  - La règle : une copie de la version de base du `.tex` (la version d'avant l'écriture), nommée en copie de conflit de ce fichier et absente de la base, est la copie du même conflit à un tour précédent. Elle est remplacée par la nouvelle copie, qui tient la dernière version perdante et porte la date de cette écriture.
    - Dans l'état courant, c'est ma version qui a perdu à un enregistrement précédent de la même réconciliation, ou à la réconciliation d'un autre PC.
    - Dans l'écriture, c'est leur version, qui a perdu quand cette écriture a été rejouée la fois d'avant.
  - Le gagnant reste celui de la règle des champs, écriture par écriture : en fin de réconciliation, c'est donc le dernier enregistrement de ce PC contre le changement reçu.
  - Un même `.tex` ajouté des deux côtés, avec deux contenus, est un conflit comme un autre : les deux versions restent, et une notification le dit. Sans version de base, il n'y a pas de copie d'un tour précédent à remplacer (revue de f9e091e, qui l'avait perdu).
  - `reconcile` ne notifie que les copies encore présentes une fois toutes les écritures rejouées : une notification par conflit.
  - Options :
    - décider d'abord, pour toute la réconciliation, chaque `.tex` contre la dernière version en attente. Mais il faudrait à `rebaseUnit` un contexte de plus, et la reprise d'une écriture déjà rejouée resterait à traiter ;
    - reconnaître la copie du même conflit à son contenu et à son nom (choix) : `rebaseUnit` garde sa signature, et la même règle couvre les deux cas.
  - Coût si faux : un fichier nommé comme une copie de conflit, ajouté par l'utilisateur dans la même écriture que le `.tex` et tenant exactement sa version d'avant, serait remplacé. Cette version reste dans l'historique.
- Ruling: **la simulation tire aussi « placer dans l'autre plan »**, en plus des commandes de la liste du plan, pour qu'un nœud soit souvent dans deux plans (retirer d'un plan sans jeter). Depuis le fix de la revue, elle tire aussi l'enregistrement d'un `.tex`.
  - Le client de la simulation envoie, comme celui de la tâche 3, tout ce qui attend dès que rien n'est en vol, 50 écritures au plus.
  - Avec des envois de 4 écritures et trois actions par envoi, les files d'attente montaient à 140 écritures, et la simulation prenait 10 s.
  - Coût si faux : nul.

## Tâche 2 : le serveur

### Fait

- **`packages/server`**, nouveau paquet `@cirrus/server` (`npm run serveur -w packages/server`) :
  - `bounds.ts` : les bornes du plan, plus `MAX_PAIR_BODY_BYTES` (4 Kio), `MAX_HASHES_PER_REQUEST` (10 000), `MAX_PC_NAME_CHARS` (100) et `SERVER_SNAPSHOT_UNITS` (500, R2) ;
  - `tokens.ts` : `serveur.db` (les PC jumelés, les codes en attente), le jumelage et les jetons ;
  - `canon.ts` : la base de référence, son état en mémoire, et `Canon.accept` dans l'ordre de la tâche ;
  - `events.ts` : les flux d'événements ;
  - `server.ts` : HTTP et les routes ; `main.ts` : la ligne de commande (`jumeler`, `pcs`, `revoquer`) ; `index.ts` exporte aussi `Tokens`, pour les tests des PC (tâche 3).
- **Cœur :** `plainName` (venu de l'app, qui le réexporte) et son contrôle dans `parseOp` ; `SYNC_PROTOCOL_VERSION` (1) et le type `UnitResult` dans `sync.ts`.
- **Magasin :**
  - `commit(a, { numbered: true })`, `numberedUnit(unit)`, `unitsAfter(after, minLines)`, `changesSince(after, limit)` ;
  - `LocalStore.open(dir, { pc, durable: true })` ;
  - `receiveBlob(storeDir, hash, source, maxBytes)` et `BlobError` (`files.ts`), que la tâche 3 pourra reprendre pour ses téléchargements.

### Mesures

- **Une écriture acceptée** (HTTP, `parseUnit`, `applyOps`, `addedViolation`, `commit` synchronisé sur le disque, relais) : 496 écritures en 5 requêtes en 0,35 s environ, soit 0,7 ms chacune, sur cette machine.
- **`commit` seul**, 1 000 modifications d'un nœud (script jetable) : 0,6 ms avec `synchronous = FULL`, 0,17 ms avec `NORMAL`.

### Décisions

- Ruling: **les lignes du serveur sont numérotées par `commit(a, { numbered: true })`** : `server_seq` = `local_seq` de chaque ligne, `kind 'local'`, avec le PC, l'heure et les identifiants reçus (R1, R6). Dans la transaction, `commit` vérifie que les numéros pris (le dernier + 1) sont ceux que SQLite a donnés : le journal ne fait que grandir.
  - Rien n'est donc en attente au serveur, et les pages de `GET /journal` portent leurs numéros.
  - Options : prendre `local_seq` pour numéro sans écrire `server_seq` (le journal servi à un PC, D7, n'aurait pas ses numéros) ; un champ `serverSeq` libre à `commit` (le serveur calculerait un numéro que le journal donne déjà).
  - Coût si faux : une option de `commit`.
- Ruling: **la base du serveur est synchronisée sur le disque à chaque écriture** (`durable`, `synchronous = FULL`), comme `serveur.db`. Avec `NORMAL`, une coupure de courant pourrait reprendre des écritures déjà numérotées et relayées : le serveur redonnerait leurs numéros à d'autres, et tous les PC divergeraient. Les PC gardent `NORMAL`.
  - Coût : 0,45 ms de plus par écriture acceptée (mesures ci-dessus), soit 0,45 s pour 1 000 écritures en attente.
  - Coût si faux : ce temps.
- Ruling: **la règle des noms de fichiers est au cœur** (`plainName`, dans `ops.ts`) ; l'app la réexporte de `main/files.ts`, sans changer son comportement. `parseOp` refuse un fichier que l'« après » d'une opération de nœud ajoute (un nom absent de l'« avant ») sous un nom qui n'est pas simple : « Opération mal formée : node.after.files[i].name n’est pas un nom de fichier simple. ».
  - Un nom déjà dans l'« avant » n'est pas rejugé : l'« avant » doit être l'enregistrement tel qu'il est, au serveur comme au PC.
  - Options : rejuger tous les noms (un nœud portant un nom ancien ne pourrait plus être modifié par la synchro) ; un contrôle au serveur seul (le PC ne vérifierait pas ce qu'il reçoit).
  - Coût si faux : une écriture qui ajoute un nom non simple est écartée. L'app n'en fait pas : `checkFileName` a la même règle.
- Ruling: **les essais faux du jumelage comptent contre chaque code en attente** (une colonne `failures` par code) : chaque `/pair` au code faux l'incrémente pour tous, et un code qui atteint `PAIRING_TRIES` est brûlé. Un corps mal formé (400) n'essaie aucun code et ne compte pas.
  - Les codes sont gardés hachés : un essai faux ne peut pas être imputé à un code. Avec un seul code en attente, le cas courant, c'est exactement « 5 essais faux ». Un code créé après des essais faux part de zéro.
  - Options : un compteur global (un nouveau code hériterait d'essais qui ne le visaient pas).
  - Coût si faux : un programme de la machine (le serveur n'écoute que sur elle) peut brûler les codes en attente ; il ne peut pas en deviner un (80 bits).
- Ruling: **le format du code** : 16 caractères de la base 32 de Crockford (80 bits), affichés en quatre groupes (`ABCD-EFGH-JKMN-PQRS`). À la saisie, la casse, les tirets et les espaces ne comptent pas, O vaut 0, I et L valent 1. Le code est haché par SHA-256 : avec 5 essais et 10 minutes, un hachage lent n'apporterait rien.
  - Coût si faux : un format d'affichage.
- Ruling: **le nom d'un PC au serveur est celui de `jumeler`**, unique sans tenir compte de la casse : c'est celui que `revoquer` prend. Le `name` du corps de `/pair` est gardé comme le nom de sa machine, que `pcs` montre.
  - `jumeler` refuse un nom déjà jumelé (« revoque-le d’abord ») ; un nouveau code pour un nom en attente remplace l'ancien.
  - Un PC déjà jumelé (même identifiant) qui se jumelle de nouveau prend le nom du code et un nouveau jeton, et l'ancien ne vaut plus rien : le cas d'un PC dissocié, ou qui a perdu son `serveur.json`.
  - Coût si faux : une colonne de `serveur.db`.
- Ruling: **`revoquer` efface la ligne du PC** : son jeton est refusé dès la requête suivante (`serveur.db` est relu à chaque requête, sans cache), et son flux ouvert est fermé au ping suivant (`SSE_PING_MS`).
  - Coût si faux : un flux ouvert reçoit encore jusqu'à 15 s d'écritures après sa révocation.
- Ruling: **les gardes contre un navigateur**, en plus de l'absence d'en-têtes CORS :
  - l'en-tête `Host` doit nommer cette machine (`127.0.0.1`, `localhost` ou `[::1]`), sinon 403 : une page qui ferait pointer son domaine sur 127.0.0.1 (DNS rebinding) n'obtient rien ;
  - chaque corps JSON exige `Content-Type: application/json` (415 sinon) : une page d'un autre site ne peut pas en envoyer sans requête préalable, et `OPTIONS` répond 405 ;
  - `/pair`, seule route sans jeton, lit 4 Kio au plus.
  - Au plan 9, la liste des noms admis prendra celui du serveur loué.
  - Coût si faux : quelques lignes ; un client qui enverrait un autre `Content-Type` serait refusé.
- Ruling: **une requête dont une écriture est signée d'un autre PC est refusée entière (403), avant toute acceptation.** `Canon.accept` refuse aussi une telle écriture (étape 2).
  - Options : un 403 au milieu de la boucle, après l'acceptation des écritures qui le précèdent (la requête serait en partie écrite).
  - Coût si faux : nul.
- Ruling: **un identifiant d'écriture connu, mais d'un autre PC, est refusé** (« Cet identifiant d’écriture est déjà celui d’une écriture d’un autre PC. »), plutôt qu'accepté avec le numéro de l'autre.
  - Coût si faux : nul (les identifiants sont des uuidv7).
- Ruling: **`applyOps` qui échoue autrement que sur un « avant »** (`OpConflictError`) donne un refus, avec son message, et non une erreur 500 : l'écriture ne pourra jamais s'appliquer, et le PC l'écarte. Un `commit` qui échoue après l'application à l'état (les tables ne suivraient plus l'état) remet l'état et répond 500.
  - Coût si faux : une erreur du serveur présentée comme un refus.
- Ruling: **`empty` (`/hello`) se lit dans l'état en mémoire**, au sens de D7 : ni nœud, ni connexion, ni placement, aucun plan qu'un lobby. La tâche 5 pourra le remplacer par `LocalStore.isEmpty`.
  - La base du serveur ne crée pas de lobby : le premier arrive d'un PC, par une écriture ou par l'envoi de sa base. Deux PC vides jumelés l'un après l'autre apporteraient chacun le leur : c'est à la tâche 5 de le régler (D7).
  - Coût si faux : la définition de « vide ».
- Ruling: **le flux** :
  - chaque écriture est un événement `id: <seq>`, `event: unit`, `data: <RemoteUnit>` (une ligne de JSON) ; la reprise suit `Last-Event-ID`, sinon `?after=`, sinon 0 ;
  - un numéro au milieu d'une écriture répond 400 ; un numéro au-delà du dernier répond 409 (« ses données ont été remplacées ou restaurées ») ;
  - une écriture du serveur est une suite de lignes consécutives du même identifiant (`unitsAfter`) ;
  - un flux rattrape le journal par pages de `MAX_JOURNAL_PAGE` lignes, puis passe au direct. Un flux dont le tampon est plein repasse par le journal une fois vidé : un PC lent n'entasse rien dans la mémoire du serveur. Le passage au direct se fait dans le même pas synchrone que la lecture d'une page vide, et chaque écriture est dans la base avant d'être relayée : ni trou ni doublon ;
  - le relais sérialise une écriture une fois pour tous les flux en direct ;
  - `event: settings` (tâche 6) n'est pas encore émis.
  - Coût si faux : le format d'un événement.
- Ruling: **`GET /snapshot` encode l'état en mémoire** au moment de la requête, et `Cirrus-Seq` dit le numéro qu'il couvre, le dernier. Il ne rend pas l'instantané gardé, qui peut avoir jusqu'à 499 écritures de retard.
  - Coût si faux : un encodage de l'état par requête, rare (D7).
- Ruling: **l'instantané du serveur** s'écrit toutes les `SERVER_SNAPSHOT_UNITS` écritures acceptées depuis le dernier, et à l'arrêt s'il ne couvre pas la fin du journal. Au démarrage, un instantané inutilisable est effacé, sinon un plus récent ne le remplacerait jamais (`writeSnapshot` ne garde que le plus récent), et l'état est relu des tables.
  - Coût si faux : nul.
- Ruling: **un seul serveur par dossier de données**, par le verrou de sa base (`lockBase`) : deux serveurs tiendraient deux états en mémoire, et donneraient deux fois les mêmes numéros.
  - Coût si faux : nul.
- Ruling: **`GET /journal`** rend `{ rows: ChangeRow[] }`, avec `after` à 0 et `limit` à `MAX_JOURNAL_PAGE` par défaut ; un `limit` plus grand est ramené à `MAX_JOURNAL_PAGE`.
  - Coût si faux : un format de réponse.
- Ruling: **la ligne de commande** : un `--data` relatif part du dossier où `npm run` a été lancé (`INIT_CWD`), pas de `packages/server`. Sans `LOCALAPPDATA` ni `--data`, elle refuse plutôt que de deviner un dossier.
  - Coût si faux : nul.
- Ruling: **le message de D10, quand plusieurs versions diffèrent**, les cite toutes : « (protocole 1, ici 2 ; schéma 4, ici 5) ». Un en-tête absent s'écrit « ? ».
  - Coût si faux : un texte.

## Tâche 3 : le client de synchro du principal

### Fait

- **`packages/app/src/main/sync/`**, nouveau :
  - `client.ts` : `SyncClient`, `SyncDeps`, `SyncParams` et `SyncStatus` ;
  - `events.ts` : `readEvents`, la lecture d'un flux SSE ;
  - `config.ts` : `ServerConfig`, `SecretStore`, `fileSecrets` (`serveur.json`, le jeton chiffré par un `TokenCipher`), `serverUrl` et `pair` ;
  - `downloads.ts` : `Downloads`, `filesToSend`, `filesToFetch`, `isPdf` et `hasBlob`.
- **Tests :** `packages/app/tests/support/virtualPc.ts` (`Lab`, `VirtualPc`, `Net`) et `packages/app/tests/sync.test.ts`. L'app prend `@cirrus/server` en dépendance de développement.
- **Cœur :** `MAX_BODY_BYTES`, `MAX_UNITS_PER_REQUEST` et `MAX_HASHES_PER_REQUEST` passent dans `sync.ts` ; le `bounds.ts` du serveur les réexporte.
- **Magasin :** `LocalStore.pendingCount()`.
- **Réglages :** le groupe « Synchronisation », dans la nouvelle rubrique « Serveur » (R3).

### Mesures

Mesuré par un test jetable, hors du dépôt : deux PC virtuels et le serveur dans un seul processus, sur cette machine, avec les réglages par défaut (sauf la reconnexion).

- **Une action sur A, vue sur B :** 76 ms en médiane, 79 ms au plus, sur 20 renommages faits l'un après l'autre. La fenêtre de réception, `syncReceiveBatchMs` (50 ms), en prend la plus grande part ; le plan demande moins d'une seconde.
- **500 créations de nœuds faites d'un coup sur A** (1 000 lignes) : B les a toutes reçues et écrites en 1,2 s. A les a envoyées en 31 requêtes `/units`, par lots de 50 ; B les a réconciliées en 27 ou 28 lots.
- **`sync.test.ts`** (18 tests, dont trois PC à la fois, un serveur arrêté puis relancé, des flux coupés ou retenus) : 5 s. Lancé 15 fois de suite, il passe chaque fois.

### Décisions

- Ruling: **un état « refusé » dit s'il vient d'une divergence** : `{ state: 'refused', message, diverged: true }`. C'est le cas quand une écriture reçue ne s'applique pas ici (`SyncDivergedError` levée par `reconcile`). C'est aussi le cas quand le serveur déclare « en retard » une écriture de ce PC alors que le PC avait déjà reçu tout ce que le serveur avait (règle suivante).
  - Options :
    - un état `diverged` à part : l'union du plan changerait pour ses consommateurs ;
    - un drapeau sur `refused` (choix) : la pastille dit « Serveur : <raison> » dans les deux cas, et la tâche 4 sait qu'elle doit relire l'état de la base.
  - Le client s'arrête alors, sans réessayer, jusqu'au prochain `start()`.
  - Coût si faux : un champ.
- Ruling: **« en retard » au numéro `n`, alors que la base avait déjà reçu jusqu'à `n` quand l'écriture a été lue : refus pour divergence, pas un nouvel essai.**
  - Le serveur n'a rien que le PC n'ait pas. Renvoyer l'écriture donnerait la même réponse, sans fin.
  - Seule la première réponse non acceptée d'une requête compte. Celles qui la suivent sont « en retard » par la règle du serveur, pas par leurs « avant ».
  - Options :
    - réessayer à intervalles croissants : une boucle toutes les 30 s, sous une pastille « Hors ligne » qui mentirait ;
    - refuser (choix).
  - Coût si faux : un PC s'arrête sur une anomalie qu'un nouvel essai aurait levée ; `start()` réessaie.
- Ruling: **les bornes qu'un PC doit respecter sont au cœur.** `MAX_BODY_BYTES`, `MAX_UNITS_PER_REQUEST` et `MAX_HASHES_PER_REQUEST` sont dans `sync.ts`, et le `bounds.ts` du serveur les réexporte, comme `MAX_OPS_PER_UNIT`. Le client :
  - coupe `/files/missing` en paquets de `MAX_HASHES_PER_REQUEST` ;
  - envoie au plus `MAX_UNITS_PER_REQUEST` écritures par requête, la borne haute de `syncBatchUnits` ;
  - n'envoie jamais un corps de plus de `MAX_BODY_BYTES` : il coupe le lot en deux. Une écriture seule trop grosse est écartée comme le serveur l'aurait refusée (« Écriture trop grosse pour le serveur : 67108864 octets au plus. »), avec sa notification.
  - Pourquoi : le serveur répond 413 sur la longueur annoncée, sans lire le corps. Le client pourrait voir une connexion coupée au lieu du 413, et réessayer sans fin.
  - Options :
    - recopier les valeurs dans le client : elles divergeraient un jour ;
    - en faire des réglages : ce ne sont pas des choix de l'utilisateur.
  - Coût si faux : trois réexportations. Une écriture de plus de 64 Mio est perdue au lieu de bloquer tout l'envoi : il en faudrait une de plus de 100 000 nœuds environ.
- Ruling: **refusé ou hors ligne** :
  - toute réponse 4xx donne « refusé », sans nouvel essai : 401 pour le jeton, 403, 409 pour le format ou des données remplacées, 400 ;
  - toute réponse ou trame illisible aussi : un JSON invalide, une écriture mal formée, un trou dans les numéros du flux ;
  - une erreur du réseau, une réponse 5xx et un flux que le serveur ferme donnent « hors ligne », puis un nouvel essai ;
  - un `PUT /files` refusé n'arrête pas la synchro : 400 quand le fichier local ne correspond plus à son empreinte, 413 au-delà de 1 Gio. Le fichier est laissé, et le serveur refuse l'écriture (« Fichier manquant au serveur. »), écartée avec sa notification.
  - Coût si faux : un 4xx passager arrête la synchro jusqu'au prochain `start()`.
- Ruling: **la reconnexion** :
  - le premier essai après `start()` montre « connecting ». Les suivants restent « offline » jusqu'à ce que l'un réussisse : la pastille ne clignote pas ;
  - le premier nouvel essai part après `syncRetryMinMs`, puis l'attente double, jusqu'à `syncRetryMaxMs`. Elle repart du plus court dès qu'un flux s'ouvre. Pas d'aléa : un serveur ne sert que quelques PC ;
  - un `syncRetryMinMs` au-dessus de `syncRetryMaxMs` est lu comme `syncRetryMaxMs` ;
  - `start()`, hors ligne ou refusé, réessaie tout de suite (le clic sur la pastille), sans remettre l'attente à zéro.
  - Coût si faux : le libellé d'un état.
- Ruling: **`behind` compte des numéros du serveur** (des lignes), pas des écritures : le dernier numéro donné par `/hello`, moins `last_server_seq`.
  - Coût si faux : une unité d'affichage.
- Ruling: **`pending` compte les écritures pas encore accusées**, y compris celles que le serveur a acceptées et dont l'accusé n'est pas revenu. `LocalStore.pendingCount()` les compte comme `pendingUnits` les groupe, sur l'index des lignes en attente, sans lire leurs opérations.
  - Coût si faux : une méthode.
- Ruling: **l'envoi** :
  - une requête à la fois par connexion, et seulement quand aucune réconciliation n'est en cours : le client n'envoie pas ce qui va être réécrit ;
  - une écriture acceptée n'est pas renvoyée tant que son accusé n'est pas revenu (le client la garde par identifiant, avec son numéro) : les lots se suivent sans attendre les accusés ;
  - après « en retard (n) », il attend que la base ait écrit jusqu'à `n` ; après « refusée », que la réconciliation ait écarté l'écriture ;
  - il démarre dès que le flux est ouvert, sans attendre le rattrapage : au pire, une réponse « en retard » de plus.
  - Coût si faux : nul.
- Ruling: **la réception** :
  - la première écriture reçue ouvre une fenêtre de `syncReceiveBatchMs`. À sa fin, tout ce qui est arrivé part en un lot ;
  - les réconciliations s'enchaînent une à une, quelle que soit la connexion ;
  - au départ, un lot perd les écritures que `last_server_seq` couvre déjà (une connexion précédente les a écrites), et la première qui reste doit le suivre exactement ;
  - à la coupure, les écritures reçues mais pas encore passées sont oubliées : elles reviennent depuis `last_server_seq`.
  - Coût si faux : la mémoire d'un gros rattrapage, qui s'accumule pendant qu'une réconciliation tourne (voir le rapport de la tâche 3).
- Ruling: **un `reconcile` qui échoue autrement que par `SyncDivergedError`** compte comme une connexion coupée : hors ligne, puis un nouvel essai. La base n'a rien écrit, `last_server_seq` n'a pas bougé, et les écritures reviennent.
  - La tâche 4 doit relire l'état de l'interface quand l'écriture de la réconciliation a échoué. Le PC virtuel le fait.
  - Coût si faux : un essai de plus.
- Ruling: **les fichiers** :
  - **l'envoi :** les empreintes qu'un lot ajoute par rapport à l'« avant », comme `Canon.missingFile`. Elles sont demandées à `/files/missing`, puis les fichiers manquants partent un à un, avant la requête du lot.
    - Chacun part une fois par session du client : le serveur n'efface jamais un fichier.
    - Le corps est lu du disque au fil de l'envoi (`fs.openAsBlob`), jamais chargé en entier ;
  - **la réception :** seulement les fichiers qu'une écriture reçue ajoute par rapport à l'« avant ». Un PDF se reconnaît à l'extension `.pdf`, sans tenir compte de la casse ;
  - **la taille :** au plus ce que le serveur annonce (`Content-Length`, qu'il envoie toujours), puis l'empreinte est vérifiée (`receiveBlob`). Une réponse sans longueur est refusée ;
  - **un téléchargement coupé par le réseau** est repris à la connexion suivante. Un fichier absent du serveur, ou aux octets faux, ne l'est pas ;
  - **`fetchBlob`** part tout de suite, hors de la limite `syncDownloads` (un lecteur attend), ou rejoint le téléchargement en cours du même fichier.
  - Coût si faux : un fichier absent jusqu'à son ouverture, que `cirrus-file:` ira chercher (tâche 4).
- Ruling: **l'horloge** :
  - l'écart est l'heure du serveur moins le milieu de l'échange `/hello`, arrondi à la milliseconde. Il est mesuré à chaque `/hello` ;
  - il est gardé en mémoire, et vaut 0 avant le premier `/hello` du processus : une écriture faite hors ligne avant toute connexion garde l'heure du PC ;
  - l'avertissement part au-delà de `syncClockSkewWarnMs`. N est l'écart en minutes, arrondi, au moins 1, avec « minute » au singulier pour 1. Le texte est celui du plan, apostrophe droite comprise : « L'horloge de ce PC diffère de celle du serveur de N minutes : règle-la. ».
  - Coût si faux : les écritures hors ligne d'un PC décalé, avant sa première connexion, gardent leur décalage. La tâche 4 peut garder le dernier écart.
- Ruling: **`serveur.json`** contient `{ url, name, token }`, où `token` est le base64 de ce que rend le chiffrement (`safeStorage` dans l'app). Il s'écrit dans un fichier temporaire, ensuite renommé.
  - Absent ou illisible, il ne donne aucun serveur, avec un avertissement s'il est illisible. `write(null)` l'efface.
  - `pair` est dans `config.ts`. `serverUrl` n'accepte qu'une origine `http` ou `https`, sans chemin, et retire la barre finale.
  - Coût si faux : un format de fichier.
- Ruling: **le groupe « Synchronisation »** est dans la rubrique « Serveur », la dernière de `PARAM_RUBRICS`. Ses réglages sont tous avancés. Ce sont les six que lit le client :
  - `syncBatchUnits`, de 1 à 100 (`MAX_UNITS_PER_REQUEST`) ;
  - `syncDownloads`, de 1 à 16 ;
  - `syncRetryMinMs`, de 100 à 60 000 ;
  - `syncRetryMaxMs`, de 1 000 à 600 000 ;
  - `syncClockSkewWarnMs`, de 10 000 à 3 600 000 ;
  - `syncReceiveBatchMs`, de 0 à 1 000.
  - La tâche 4 ajoute `syncConnectTimeoutMs` et `syncSuspendFlushMs`.
  - Coût si faux : des bornes.
- Ruling: **`flush(ms)`** rend la main quand le serveur a accepté toutes les écritures en attente, sans attendre leurs accusés, ou après `ms`. Sans connexion ouverte, il rend la main tout de suite.
  - Coût si faux : nul.
- Ruling: **le PC virtuel des tests** ne crée pas de lobby. Il écrit chaque action dans la base, puis dans l'état. Si l'écriture d'une réconciliation échoue, il relit l'état et les écritures en attente depuis la base, comme le fera la tâche 4.
  - Coût si faux : nul.
