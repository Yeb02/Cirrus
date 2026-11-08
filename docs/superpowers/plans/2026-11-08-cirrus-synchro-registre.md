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
  - `downloads.ts` : `Downloads`, `filesToSend`, `filesToFetch`, `isPdf`, `isHash`, `hasBlob` et `DOWNLOADS_FILE` (la liste des téléchargements d'office restant à faire, R9).
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
  - le premier nouvel essai part après `syncRetryMinMs`, puis l'attente double, jusqu'à `syncRetryMaxMs`. Pas d'aléa : un serveur ne sert que quelques PC ;
  - l'attente repart du plus court quand une connexion a fait ses preuves : une réconciliation écrite, ou un flux resté ouvert `syncRetryMaxMs`. Un flux qui s'ouvre ne suffit pas (revue de la tâche 3, Important 1) :
    - un flux que le serveur ferme aussitôt, ou une réconciliation qui échoue toujours, ramènerait sinon le client toutes les `syncRetryMinMs`, sans fin ;
    - à chaque retour, il relirait tout depuis `last_server_seq`, et la pastille clignoterait ;
  - un `syncRetryMinMs` au-dessus de `syncRetryMaxMs` est lu comme `syncRetryMaxMs` ;
  - `start()`, hors ligne ou refusé, réessaie tout de suite (le clic sur la pastille), sans remettre l'attente à zéro.
  - Options pour la preuve :
    - le flux ouvert (le premier choix, écarté par la revue) ;
    - le rattrapage atteint : un serveur dont la lecture du journal échoue après l'ouverture du flux bouclerait encore ;
    - une réconciliation écrite, ou `syncRetryMaxMs` de connexion (choix) : un progrès réel, ou une connexion qui tient. Une connexion calme qui tombe après une heure repart donc du plus court.
  - Coût si faux : après une coupure, le premier essai d'une connexion qui n'a encore rien reçu peut attendre jusqu'à `syncRetryMaxMs`.
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
  - **un téléchargement d'office coupé par le réseau, ou par `stop()`,** est repris à la connexion suivante, et au démarrage suivant (R9, plus bas). Un fichier absent du serveur, ou aux octets faux, ne l'est pas ;
  - **`fetchBlob`** part tout de suite, hors de la limite `syncDownloads` (un lecteur attend), ou rejoint le téléchargement en cours du même fichier.
    - Un fichier en file d'attente qu'on demande ainsi reste un téléchargement d'office : repris s'il échoue.
    - Un PDF demandé qui échoue, hors ligne, ne l'est pas : il sera redemandé à sa prochaine ouverture (D6). Avant la revue, tout échec était repris d'office, PDF compris.
  - Coût si faux : un fichier absent jusqu'à son ouverture, que `cirrus-file:` ira chercher (tâche 4).
- Ruling: **R9 du contrôleur, mis en œuvre : les téléchargements d'office interrompus par `stop()` (la veille) ou par la fermeture de l'app ne sont pas perdus** (revue de la tâche 3, Important 2).
  - **La liste :** ceux qui restent à faire (en file, en cours, coupés) sont gardés à côté de la base, dans `downloads.json` (`DOWNLOADS_FILE`, `{ "hashes": [...] }`).
    - Elle s'écrit dans un fichier temporaire, ensuite renommé, comme `settings.json`.
    - Elle est relue par le `Downloads` du prochain client sur la même base, et remise en file à l'ouverture du flux (`retry`).
  - **Quand elle s'écrit :**
    - quand `want` met en file au moins un fichier nouveau ;
    - à `stop()`, exacte : ce qui était en file ou en cours, moins ce qui est arrivé avant l'arrêt ;
    - elle est effacée quand il ne reste plus rien (file, en cours, coupés).
  - **Son contenu :** elle peut nommer un fichier arrivé depuis, si l'app s'est arrêtée brutalement. `want` le saute alors : il est déjà au magasin, ce qui coûte un `existsSync`.
  - **Son coût :** une écriture proportionnelle à ce qui reste à télécharger, à chaque lot reçu qui apporte des fichiers nouveaux. Aucune lecture de la base.
  - **Une liste illisible** est signalée et ignorée. Un échec d'écriture est signalé, et les téléchargements continuent.
  - Options :
    - une recherche des fichiers absents au démarrage : elle lirait toute la base ;
    - accepter la perte : les fichiers resteraient absents jusqu'à leur ouverture, et hors ligne, pour toujours ;
    - une liste gardée (choix du contrôleur).
  - Coût si faux : un petit fichier de plus à côté de la base, réécrit à chaque lot qui apporte des fichiers.
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

## Tâche 4 : l'app — réconciliation dans l'interface, voile, pastille, jumelage, PDF à la demande

### Fait

- **Le principal :**
  - `main/sync/host.ts`, nouveau et sans Electron : `SyncHost`, la vie du client (démarré quand l'interface tient ses écritures en attente, arrêté puis relancé au réveil, arrêté à la fermeture), l'aller-retour d'une réconciliation par l'interface, le jumelage et la dissociation, l'heure de chaque écriture locale ;
  - `main/sync/wire.ts`, nouveau : les IPC `cirrus:sync:*`, la fenêtre, `safeStorage` et `powerMonitor` ;
  - `main/index.ts` : `SyncHost` créé à l'ouverture de la base, `cirrus:commit` par lui, `cirrus:load` avec les écritures en attente, l'arrêt du client avant la fermeture de la base ;
  - `main/base.ts` : `pcId` exporté, `loadPayload(store, fromTables, pending)` ;
  - `main/files.ts` : `cirrus-file:` va chercher au serveur un fichier absent (`fileResponse(…, fetchBlob)`), 503 sinon ; `?vignette` ne télécharge jamais.
- **L'interface :**
  - `renderer/session.ts` : `EditSession` tire l'identifiant de chaque écriture, garde les écritures en attente (`follow`, `unfollow`, `pending`), `reconcile`, `reload` ;
  - `renderer/sync/syncSession.ts`, nouveau : `SyncSession` (réception, voile, pastille, jumelage) et `chipOf` ;
  - `ui/SyncVeil.tsx`, `ui/SyncChip.tsx`, `ui/settings/ServerBlock.tsx`, nouveaux ; `Tabs` (la pastille), `SettingsPanel` (le bloc en tête de « Serveur »), `App.tsx` ;
  - `files/kind.ts`, `read.ts`, `pdf.ts`, `NodePopup.tsx` : les vignettes demandent `?vignette` ; le lecteur dit « PDF pas encore téléchargé : serveur injoignable. ».
- **Magasin :** `LocalStore.isEmpty()`, « vide » au sens de D7, comme `Canon.empty`.
- **Réglages :** `syncConnectTimeoutMs` (4 000) et `syncSuspendFlushMs` (1 500), dans le groupe « Synchronisation ».
- **Tests :** `tests/syncSession.test.ts`, `tests/syncHost.test.ts`, `tests/syncFiles.test.ts`, `tests/support/appPc.ts` (l'app comme PC du labo, sans Electron), et des ajouts à `load.test.ts`, `localStore.test.ts` et `params.test.ts`.
- **Scénario de l'interface** (`interface.mjs`, le 26e) : une base neuve jumelée par le bloc « Serveur » à un serveur démarré par le scénario (127.0.0.1, un port libre, un dossier temporaire). Il vérifie dans Electron `net.fetch` (le flux, les écritures, l'envoi d'un fichier lu du disque), `safeStorage` (le jeton chiffré dans `serveur.json`), la pastille, puis « Dissocier ce PC ». L'option `empty` d'un scénario prend une base neuve au lieu de la base de test.

### Décisions

- Ruling: **l'heure d'une écriture locale est donnée par le principal** : `cirrus:commit(action, unit)` rend `{ seq, at }`, où `at` est `Date.now()` du principal plus `clockOffset()` du client. L'écriture en attente de l'interface prend ce même `at`.
  - Options : envoyer l'écart à l'interface, qui calculerait `at` et le passerait (deux horloges, et un écart qui peut changer sans changement d'état) ; le rendre du principal (choix : une seule source).
  - Coût si faux : un champ de plus dans la réponse de `cirrus:commit`.
- Ruling: **le client démarre quand l'interface le demande** (`cirrus:sync:start`) : au chargement, une fois que la session tient ses écritures en attente, ou après un jumelage. Le principal n'envoie donc jamais d'écritures reçues à une interface qui ne peut pas les réconcilier.
  - Options : démarrer au lancement et retenir les réconciliations jusqu'à ce que la fenêtre soit prête.
  - Coût si faux : la connexion s'ouvre après le chargement de la fenêtre, quelques centaines de millisecondes plus tard qu'au plus tôt.
- Ruling: **les écritures en attente ne vont à l'interface qu'avec un serveur jumelé** (R5 : toutes alors). Sans serveur, `cirrus:load` n'en envoie aucune et la session n'en garde aucune (`follow` seulement jumelé) : rien ne change au plan 4c, ni en mémoire.
  - Au jumelage, la session demande la liste entière au principal (`cirrus:sync:pending`) dans sa file : aucune écriture n'est en cours, et la liste est complète avant le démarrage.
  - Coût si faux : nul.
- Ruling: **l'ordre du jumelage** (R8, R10, R11, D3) :
  - d'abord, sans rien demander au serveur, donc sans dépenser le code : `safeStorage` disponible, une adresse `http`/`https` valide, `http:` seulement sur cette machine (R10), un code et un nom donnés, et une base « vide » (`LocalStore.isEmpty()`) qui n'a jamais rien reçu d'un serveur (`lastServerSeq() = 0`, sinon son flux reprendrait à un numéro que ce serveur n'a jamais donné) ;
  - puis `/pair`, puis `/hello` avec le jeton, seul moyen de connaître le journal du serveur ;
  - un serveur dont le journal n'est pas vide est refusé, même s'il ne tient qu'un lobby (R11 : le journal vide). Le lobby de ce PC deviendrait un second lobby, alors que `/hello` dit `empty` au sens de D7 et l'accepterait ;
  - un refus après `/pair` jette le jeton : le PC reste inscrit au serveur, et le message dit de le révoquer (`revoquer`) avant un nouveau code.
  - Options : garder le jeton sans démarrer (le client démarrerait au lancement suivant, contre R8) ; ne regarder que `empty` (deux lobbies).
  - Coût si faux : un `revoquer` pour l'utilisateur, dans un cas que la tâche 5 remplace (prendre la base du serveur).
- Ruling: **les requêtes du jumelage attendent `syncConnectTimeoutMs` au plus** (le réglage du voile, son libellé étendu) : un serveur qui ne répond jamais ne bloque ni le bloc ni la fermeture de l'app, qui attend la fin d'un jumelage en cours.
  - Options : un réglage de plus ; aucune borne.
  - Coût si faux : un serveur très lent ne peut pas être jumelé en moins de 4 s.
- Ruling: **le voile** monte au chargement d'une base jumelée et au réveil (`cirrus:sync:veil`), pas à un clic sur « Réessayer ». Il descend à « live » ou à « refused », ou après `syncConnectTimeoutMs`. « off » ne le lève pas (le réveil arrête puis relance le client), « offline » non plus : le serveur peut revenir pendant ces 4 s (D8, à la lettre).
  - Il couvre toute la fenêtre, onglets compris, et retient le pointeur et les touches (prises à la fenêtre, avant toute autre écoute).
  - Options : le lever dès « offline », pour travailler sans attendre quand le serveur est éteint.
  - Coût si faux : 4 s d'attente au démarrage quand le serveur est éteint.
- Ruling: **les textes de la pastille** :
  - aucune sans serveur ;
  - « Connexion… », puis « Hors ligne » (un clic réessaie) quand le voile a renoncé (D8) ;
  - « Synchronisation… » pendant le rattrapage ;
  - « À jour », ou « Envoi de n actions… » (« 1 action » au singulier ; n compte les écritures) ;
  - « Hors ligne », un clic réessaie ;
  - « Serveur : <raison> » : un clic réessaie aussi, comme `start()` le permet ;
  - l'avertissement de l'horloge dans l'infobulle, et une notification une fois par message et par session (chaque reconnexion le redit).
  - Coût si faux : des textes.
- Ruling: **« Réessayer » pendant un arrêt est mis en file**, pas ignoré : le démarrage, l'arrêt, le réveil, le jumelage, la dissociation et la fermeture forment une seule file au principal. Le clic part donc une fois l'arrêt fini, jamais pendant.
  - Coût si faux : nul.
- Ruling: **la pile d'annulation après une réconciliation** (D5) : une écriture en attente qui n'est ni accusée ni rejouée telle quelle (le même objet dans `rebased`) quitte la pile (`forget` de son action). Cela vaut pour une écriture réécrite, écartée, reçue après celles d'un autre PC (règle de la tâche 1) ou devenue sans effet.
  - Coût si faux : nul.
- Ruling: **la scène reçoit une action « Synchronisation »** dont les opérations sont les inverses, les écritures reçues hors accusés, et les écritures rejouées quand il y a eu des inverses. Un accusé seul ne change pas l'état : la scène n'en sait rien, et il ne coupe pas la fusion d'un `.tex` (une écriture reçue la coupe).
  - Coût si faux : nul.
- Ruling: **l'aller-retour d'une réconciliation** :
  - le principal envoie `cirrus:sync:incoming { id, units, refused }` ; l'interface répond `cirrus:sync:reconciled(id, issue)`, où l'issue est `{ reconciliation }`, `{ diverged }` ou `{ error }`. La réconciliation renvoyée ne nomme les écritures reçues que par leur identifiant et leur numéro : le principal les a (revue, Minor 4) ;
  - le principal vérifie que les écritures reçues de la réconciliation sont celles qu'il a envoyées (identifiants et numéros, dans l'ordre), puis écrit sa propre copie de celles-ci. Il vérifie aussi que les écritures rejouées sont de ce PC et bien formées ;
  - leurs opérations sont vérifiées par la base en écrivant (`checkRecord`, chaque « avant »), pas par `parseOp`, plus strict. Une écriture que le serveur refuserait doit encore pouvoir être défaite ici, puis écartée ; sinon, la synchro bloquerait pour toujours ;
  - un `id` inconnu ou déjà réglé est refusé ;
  - `EditSession.reconcile` prend un troisième argument, `write` (l'écriture par le principal, son numéro du journal), en plus des deux du plan.
  - Coût si faux : nul.
- Ruling: **les échecs** :
  - **divergence dans l'interface** (`SyncDivergedError`, l'état intact) : le principal rejette par une vraie `SyncDivergedError`. Le client s'arrête (« refused », diverged), et l'interface relit alors son état de la base, une fois par refus. La pastille dit pourquoi, et un clic réessaie ;
  - **réconciliation refusée par la base** : le principal rejette, le client passe hors ligne et réessaie. L'interface, en avance sur la base, relit son état et le dit par une notification ;
  - **autre échec dans l'interface** (le cœur a rendu l'état intact) : `{ error }`, sans relecture.
  - Coût si faux : nul.
- Ruling: **relire l'état sur place** (`EditSession.reload`) : un nouvel objet d'état, son numéro du journal et ses écritures en attente, la pile d'annulation vidée, la scène refaite. La fenêtre, les onglets et les panneaux restent.
  - Options : recharger la page (`location.reload`), plus simple, mais on perdrait les panneaux ouverts et le texte tapé.
  - Coût si faux : nul.
- Ruling: **une fenêtre qui s'en va** (fermée, son rendu perdu, sa page rechargée : `did-start-navigation` du cadre principal) voit ses réconciliations rejetées (`detach`). `stop()` ne les attend donc jamais. Sans fenêtre, une réception est rejetée tout de suite.
  - Revu au tour 2 de la revue (Minor 1) : `detach` suit une navigation du cadre principal **faite** (`did-navigate`), plus une navigation commencée (`did-start-navigation`). Une navigation que `will-navigate` refuse finit avant d'être faite : la page qui l'a refusée reste prête. Electron n'émet `did-navigate` que pour une navigation du cadre principal vers un autre document ; une ancre dans la page donne `did-navigate-in-page`. `watchWindow` est passé dans `host.ts`, testé sans Electron sur des émetteurs.
  - Révisé par R13 (revue de la tâche 4, Important 1) : `detach` lève aussi le drapeau `ready`, que pose `cirrus:sync:start`. Tant qu'il est baissé, `reconcile` rejette aussitôt. Le client réessaie plus tard, et la nouvelle page le relance en demandant à démarrer. Avant, une réception envoyée à une page rechargée qui n'écoutait pas encore restait en attente pour toujours, et `stop()` avec elle. Aucune limite de temps n'est posée sur les attentes (R13).
  - Coût si faux : nul.
- Ruling: **un nouveau client à chaque dissociation** : les fichiers connus du serveur (`onServer`), l'écart d'horloge et les téléchargements en mémoire sont ceux d'un serveur. Cela règle la remarque de la revue de la tâche 3 (`onServer` jamais vidé).
  - Coût si faux : nul.
- Ruling: **`cirrus-file:` avec un serveur** :
  - un fichier absent du magasin (404) est demandé par `fetchBlob`, sauf pour une requête qui ne télécharge jamais : une vignette (`?vignette`), ou la seule taille d'une version (`?taille`, R12) ;
  - tout échec donne 503, car `fetchBlob` ne dit que vrai ou faux : hors ligne, absent du serveur, octets faux ;
  - une requête qui ne télécharge jamais, pour un fichier absent, répond 503 tout de suite, sans rien demander au serveur : pas encore téléchargé (revu par R12 ; une vignette répondait 404) ;
  - sans serveur jumelé, tout `cirrus-file:` répond comme au plan 4c (404 pour un fichier absent) ;
  - le message du lecteur est celui du plan pour un PDF, « « nom » pas encore téléchargé : serveur injoignable. » pour un autre fichier ;
  - les vignettes d'images demandent `?vignette` elles aussi, et montrent l'icône de l'image si elles échouent ;
  - une vignette de PDF qui n'a pas pu lire son fichier (`ReadError`) n'est pas gardée en cache : elle est redemandée à la prochaine ouverture ;
  - une vue qui rejoint l'ouverture d'un PDF par une vignette, et la voit échouer ainsi, l'ouvre de nouveau elle-même.
  - Coût si faux : « serveur injoignable » dit pour un fichier que le serveur n'a pas.
- Ruling (annulé par R12, revue de la tâche 4, Important 4) : **la liste des versions d'un fichier dans un pop-up** (`blobSize`) téléchargeait une version absente dès qu'un pop-up l'énumérait.
  - Désormais, la taille de la version d'une annotation se demande par `?taille` (`blobSize(…, { sizeOnly: true })`). Elle ne télécharge jamais. Jumelé, une version absente est « PDF pas encore téléchargé : il le sera à son ouverture. » (`NotDownloadedError`, `absentVersion`). L'annotation reste ouverte au clic, et c'est le lecteur qui télécharge le PDF.
  - Sans serveur, une version absente est introuvable et ne s'ouvre pas, comme au plan 4c.
  - L'ouverture d'une version précédente dans le lecteur (`Viewer`) demande sa taille sans `?taille` : c'est une ouverture, qui télécharge.
  - Coût si faux (R12) : une annotation dont le serveur a perdu le PDF paraît saine jusqu'à son ouverture.
- Ruling: **`safeStorage.encryptString` et `decryptString`**, synchrones, sont dépréciés dans Electron 45 au profit de leurs formes asynchrones. Ils sont gardés : `SecretStore` (tâche 3) est synchrone.
  - Coût si faux : passer `SecretStore` en asynchrone quand Electron les retirera.
- Ruling: **`EditSession.receive` est gardé** : l'app ne l'appelle plus, `reconcile` le remplace, mais ses tests l'emploient pour figurer une modification venue d'ailleurs.
  - Coût si faux : une méthode morte.
- Ruling: **le nom montré dans le bloc d'un PC jumelé** est celui donné au jumelage, gardé dans `serveur.json`. Le nom de `jumeler` au serveur peut être différent.
  - Coût si faux : un texte.
- Ruling: **l'adresse proposée par le bloc** (`http://127.0.0.1:7310`, le port par défaut de la ligne de commande du serveur) est une constante de l'interface (`ServerBlock`) : non jumelé, `info()` du principal ne propose pas d'adresse. Le test de garde du plan 4b (`tinytex.test.ts`) interdit toute adresse écrite dans un module du principal hors des fichiers de sources.
  - Options : un fichier de sources de la synchro au principal, ajouté aux exceptions du test.
  - Coût si faux : nul ; ce n'est qu'une proposition, que l'utilisateur remplace.

### Correctifs de la revue (tâche 4, tour 1)

Décisions du contrôleur : R12 (D6 tient : aucune lecture de la taille d'une version ne télécharge) et R13 (le drapeau `ready`, sans limite de temps sur les attentes), plus haut dans les règles qu'elles révisent.

- Ruling: **l'instantané pendant l'écriture d'une réconciliation** (Important 2) : la session se dit occupée (`busy`) entre la réconciliation de son état et son écriture par la base. `SnapshotSaver` ne prend alors rien, comme pour une session rompue. Un instantané dû attend de nouveau le repos ; à la fermeture, il est sauté, et le journal a tout.
  - Options : faire passer les instantanés par la file de la session (la fermeture attendrait la réconciliation en cours).
  - Coût si faux : un instantané de moins, pris au repos suivant.
- Ruling: **le voile du démarrage dure le `syncConnectTimeoutMs` chargé** (Important 3) : `SyncSession.open` le reçoit des réglages que l'app vient de lire. La référence de l'app n'a le réglage qu'après son premier rendu. Le voile du réveil lit le réglage du moment.
  - Coût si faux : nul.
- Ruling: **dissocier efface `serveur.json` d'abord** (Minor 2), puis la liste des téléchargements, au mieux : un échec n'est que signalé (`console.warn`). La base est alors sans serveur, même si la liste reste.
  - Coût si faux : une liste orpheline, que le client du prochain jumelage relit et dont les fichiers absents du serveur ne sont pas redemandés.
- Ruling: **jumelé par le principal, c'est fait** (Minor 3) : si la prise des écritures en attente ou le démarrage échoue ensuite, `SyncSession.pair` le dit par une notification (« relance Cirrus ») et rend tout de même `{ ok: true }`. L'app relit l'état du serveur jumelé après tout jumelage, réussi ou non : le bloc montre « Dissocier ce PC ».
  - Coût si faux : nul.
- Ruling: **une vue de la synchro identique à la précédente n'est pas redonnée** (Minor 5) : comparée en texte (voile, état, pastille), quelques dizaines d'octets.
  - Coût si faux : nul.

### Correctifs de la revue (tâche 4, tour 2)

Décision du contrôleur : R14 (l'ouverture par l'application du système est une ouverture : elle télécharge, comme le veulent D6 et R12).

- Ruling: **R14, mis en œuvre** : `openTargetFetched` (`main/files.ts`). Jumelé, un fichier que le magasin n'a pas est d'abord demandé par `fetchBlob`, le même chemin que `cirrus-file:` : vérifié par son empreinte, et deux ouvertures à la fois ne font qu'un téléchargement. Sa copie en lecture seule s'ouvre ensuite comme avant.
  - Hors ligne, ou absent du serveur : « PDF pas encore téléchargé : serveur injoignable. », les mots du lecteur (`notDownloaded`, pris de `renderer/files/read.ts`, comme `files.ts` prend déjà `checkFileName` à l'interface).
  - Une version ancienne suit la même règle. Sans serveur, rien ne change (« le fichier manque dans la base »).
  - Coût si faux : nul.

## Tâche 5 : le premier jumelage — envoyer sa base, ou prendre celle du serveur

### Fait

- **Le serveur :**
  - `seed.ts`, nouveau : `Seeds`, l'envoi d'une base à un serveur vide (R16). L'instantané (`POST /seed`, `Cirrus-Seq` : la ligne qu'il couvre) va dans un fichier temporaire au fil de sa réception, borné à `MAX_SEED_BYTES` ; le journal par pages (`POST /seed/journal`) va dans une base de travail ; `POST /seed/done` vérifie le tout et le donne au canon. Le tout sous `<données>/seed/<essai>/`, effacé une fois pris, abandonné, ou au démarrage du serveur ;
  - `Canon.fresh()` (aucune écriture et un état vide) et `Canon.seed()` (journal et état en une transaction) ; `Hub.endStreams()` ; `Tokens.revokeToken()` ;
  - `POST /unpair` (R15) : un PC révoque son propre jeton, et lui seul ; un envoi de base qu'il menait est abandonné ;
  - `/hello` dit aussi `nodes`, les nœuds du serveur (l'offre « Prendre la base du serveur (n nœuds) »).
- **Le cœur :** `MAX_JOURNAL_PAGE` et `MAX_SEED_BYTES` passent dans `sync.ts`, bornes du protocole que le PC respecte aussi ; `bounds.ts` les réexporte, comme `MAX_BODY_BYTES`.
- **Le magasin :**
  - `LocalStore.importJournal(rows)`, `importState(s, seq)` (en bloc, par `insertState`, tiré de `bulk.ts` et partagé avec `writeBenchBase`), `numberSeeded(last)`, `atomically(fn)` (transactions emboîtées), `nodeCount()` ;
  - `parseChangeRow(x, localSeq)` : une ligne de journal reçue d'ailleurs, vérifiée entière (`parseOp` pour son opération), par le serveur qui reçoit une base comme par le PC qui prend la sienne ;
  - `storedHashes(dir)` : tous les fichiers du magasin.
- **L'app :**
  - `main/sync/firstSync.ts`, nouveau : l'offre de D7 (`firstSyncOffer`, `offerMessage`), `seedBase`, `adoptBase`, `swapStaged` (l'échange au démarrage), `revokeSelf` (R15) ;
  - `main/sync/host.ts` : `pair` rend l'offre ; `first(choix)` y répond ; `info()` la redonne tant qu'elle attend ; « Dissocier ce PC » révoque le jeton ; la fermeture interrompt un envoi en cours ;
  - `main/index.ts` : l'échange de la base prise, avant l'ouverture ; `relaunch` (`app.relaunch()` puis `app.quit()`) et `secretsAt` injectés ;
  - `wire.ts`, `preload`, `env.d.ts` : `cirrus:sync:first` (`syncFirst`) ;
  - l'interface : `SyncSession.first`, et le bloc « Serveur » montre l'offre à la place du formulaire (`offerAction`, style `.server-offer`).
- **Tests :** `packages/server/tests/seed.test.ts` (7), `packages/app/tests/firstSync.test.ts` (6), des ajouts à `localStore.test.ts` (3), `syncSession.test.ts` (1) et `syncHost.test.ts` (deux tests réécrits : la base pleine et le serveur plein ne sont plus refusés).
- **Scénario de l'interface** (le 27e) : la base de test entière, jumelée par le bloc « Serveur » à un serveur local vide : l'offre et ses nombres, l'envoi, les lignes numérotées, la pastille « À jour ». Aucun scénario ne prend la base du serveur : il relancerait l'app (couvert dans vitest, relance injectée, et l'échange au démarrage).
- **Mesures :** `packages/app/scripts/mesures-synchro.mjs` (`node --expose-gc scripts/mesures-synchro.mjs [<base>]`, ou `… journal <lignes>`).

### Mesures

Méthode : `scripts/mesures-synchro.mjs`, sur une copie de la base de référence du banc (`%TEMP%\cirrus-bench-1-50000-500000`, générateur 2 : 50 000 nœuds, 549 189 connexions avec les inclusions, 1 177 133 branches, 44 618 fantômes ; jamais la base de l'utilisateur). Le serveur, le PC qui envoie et celui qui prend tournent chacun dans son processus, l'un après l'autre (le serveur pendant les deux) : aucun processus ne tient deux grands états. Mémoire : `process.memoryUsage().rss`, après un ramasse-miettes forcé, et son pic relevé toutes les 20 ms. Node 26.13, cette machine.

- **Envoyer la base de référence** (`seed`) : **20,5 s**, dont `POST /seed` (l'instantané, 58 Mo) 0,19 s et `POST /seed/done` **20,3 s**. Son journal est vide (une base construite en bloc) : `done` décode l'instantané, le vérifie et l'écrit. Pic du PC qui envoie : 369 Mo (il envoie son instantané rangé, sans construire d'état).
- **Prendre la base de référence** (`adopt`) : **21,6 s**, dont `GET /snapshot` 0,73 s. Pic du PC qui prend : 575 Mo.
- **Où va le temps** (même instantané, script jetable) : `decodeState` 0,27 s, `checkState` 0,37 s, `encodeState` 0,54 s ; l'écriture en bloc des tables, **18,8 s** dans la base d'un PC (WAL, `synchronous = NORMAL`), dont les connexions 3,9 s, les 1,18 million de branches 7,0 s et la validation 5,5 s (le WAL). Avec un cache de 256 Mo : 14,9 s ; sans WAL ni synchronisation : 11,9 s. Voir la décision « l'écriture en bloc n'est pas accélérée ».
- **Le serveur, mémoire :** vide, 74 Mo ; juste après l'envoi, **492 Mo** (pic 580 Mo pendant `done`) ; redémarré, sa base chargée de son instantané en **0,39 s**, **293 Mo** ; après avoir servi une prise de sa base, 399 Mo (pic 513 Mo : l'instantané encodé pour `GET /snapshot`). Le CX23 a 4 Go.
- **Le journal par pages** (une base de 20 000 lignes, un nœud renommé 20 000 fois) : envoi 0,9 s (deux pages, 0,22 s ; `done` 0,35 s) ; prise 0,57 s (deux pages de `GET /journal`, 0,19 s). Soit 10 µs environ par ligne, dans chaque sens : la sérialisation de chaque ligne par `GET /journal` (relevée à la tâche 2) ne pèse pas.
- **La taille des bases :** 586 Mo pour la base de référence, autant au serveur et dans la base prise.
- **`downloads.json` réécrit à chaque lot d'un long rattrapage** (tâche 3, minor reporté) : `Downloads.want` de 10 fichiers par lot reconcilié, aucun téléchargement ne finissant (le réseau les retient), donc une liste qui grandit.
  - 1 000 lots (10 000 fichiers en attente à la fin) : 4,1 s en tout ; un lot coûte 3,3 ms à 2 000 en attente, 4,4 ms à 10 000 ; le fichier fait 654 Kio.
  - 5 000 lots (50 000 en attente) : 43 s en tout ; 5,5 ms par lot à 10 000, 12,6 ms à 50 000 ; 3,2 Mo.
  - Soit 0,25 µs par fichier en attente et par lot : quadratique, mais négligeable tant que les téléchargements suivent (4 à la fois, `syncDownloads`) et que la liste reste courte. Il ne pèserait qu'au rattrapage d'une très grande base dont aucun fichier ne descend. Rien n'est changé.

### Décisions

- Ruling: **un serveur « tient une base » dès qu'il a une écriture, ou que son état n'est pas vide** (`Canon.fresh()` : aucune écriture et un état vide au sens de D7). Seul un serveur qui n'en tient aucune reçoit une base (R16), ou le lobby d'un PC vide comme première écriture (R7).
  - Pourquoi : une base construite en bloc, comme celle du banc, a un journal vide. Envoyée, elle laisse au serveur un journal vide ; à la lettre de R16 (« journal vide »), ce serveur paraîtrait encore vide, recevrait une seconde base ou un second lobby.
  - Le PC lit de même `/hello` : `lastSeq > 0` ou `empty` faux.
  - Options : le journal seul (le défaut ci-dessus) ; une marque dans `serveur.db` (une table de plus pour ce que l'état dit déjà).
  - Coût si faux : nul.
- Ruling: **la base d'un PC est « vide » quand elle ne tient rien (`isEmpty`) et n'a jamais rien reçu d'un serveur** (`lastServerSeq() = 0`). Une base qui a déjà été jumelée compte donc comme pleine : elle s'envoie, ses lignes renumérotées par le nouveau serveur (`numberSeeded` efface les anciens numéros).
  - Options : la refuser, comme la tâche 4 (rien ne permettait alors de la renuméroter).
  - Coût si faux : nul.
- Ruling: **l'instantané envoyé est celui que la base garde, avec la ligne qu'il couvre ; le serveur rejoue sur lui les lignes suivantes**, chaque « avant » vérifié. Sans instantané de ce format, le principal construit l'état de ses tables (`loadState`, `encodeState`). Les deux se lisent d'un seul tenant, avec la dernière ligne du journal : une écriture faite pendant l'envoi reste en attente, et part une fois la synchro démarrée.
  - Options : toujours l'état des tables (plusieurs secondes et un second état dans le principal à 50 000 nœuds) ; l'état de l'interface (le principal ne peut pas le lui demander au milieu du jumelage).
  - Coût si faux : un instantané qui ne suivrait pas les tables. Le serveur le refuse alors, si son journal ne s'applique pas sur lui.
- Ruling: **ce que `done` vérifie** (révisée au tour 1 de la revue : R19, les violations déjà là ne sont plus refusées) : l'instantané décodé (sa structure, sa somme de contrôle, ses index), les lignes après lui rejouées, et aucune règle du graphe enfreinte (`checkState` entier, 0,37 s à 50 000 nœuds). Chaque ligne du journal passe `parseChangeRow`, donc `parseOp`, à son arrivée. Un refus de `done` abandonne l'envoi : le PC recommence.
  - Options : ne vérifier que l'instantané (un PC jumelé n'est pas un inconnu, mais « toute entrée est vérifiée ») ; refuser toute ligne d'un autre PC.
  - Coût si faux : une ligne ancienne que `parseOp` refuserait bloquerait l'envoi de sa base. Le message nomme la ligne (« Ligne n du journal de ce PC : … »).
- Ruling: **les lignes envoyées gardent leur PC, leur genre et leur marque « remplacée »**, et le serveur les numérote lui-même (server_seq = local_seq, R6). Les lignes de la base de test sont signées `fixture` : les refuser bloquerait toute base faite par `make-fixture.ts`, ou copiée d'un autre PC.
  - Coût si faux : un historique qui nomme un PC jamais jumelé.
- Ruling: **un PC plein et un serveur qui ne tient qu'un lobby, celui d'un autre PC, reçoivent le refus entre deux bases pleines** ; seul le remplacement est proposé. Un envoi ne va qu'à un serveur qui ne tient rien (R16) : le lobby d'un autre PC est déjà une écriture, que d'autres PC suivent peut-être.
  - Coût si faux : pour envoyer une base pleine après qu'un PC vide s'est jumelé, il faut un serveur neuf (un autre dossier de données).
- Ruling: **l'offre et son jeton restent dans la mémoire du principal jusqu'à la réponse** ; rien n'est écrit, rien ne démarre (R8). `info()` la redonne au bloc (un panneau fermé puis rouvert, une page rechargée). Un nouveau jumelage abandonne l'offre précédente et révoque son jeton. Quitter l'abandonne sans le révoquer : on ne fait pas attendre la fermeture sur le réseau.
  - Options : écrire `serveur.json` aussitôt (une base jumelée dont la première synchro n'est pas réglée, contre R8).
  - Coût si faux : un PC orphelin dans `pcs`, comme après un arrêt brutal pendant un envoi (accepté : `revoquer` le retire).
- Ruling: **les fichiers d'abord, tous ceux du magasin** (les anciennes versions comprises), puis l'instantané, le journal, `done`, dans l'ordre de la consigne. Un envoi refusé ensuite laisse ses fichiers au serveur : ils sont désignés par leur empreinte, inoffensifs, et un fichier du magasin n'est jamais effacé. `done` ne vérifie pas que chaque fichier nommé par l'état est là : une base dont le magasin a perdu un fichier s'envoie quand même, et ce fichier reste absent partout (« pas encore téléchargé »).
  - Options : refuser l'envoi (une base dont un fichier est perdu ne s'enverrait jamais).
  - Coût si faux : un fichier absent, que l'on voit comme tel.
- Ruling: **la prise : les fichiers actuels des nœuds, ceux de la corbeille compris, sauf les PDF**. Un fichier que l'ancienne base a déjà est lié dans la nouvelle (un lien en dur ; copié s'il ne se peut pas : un fichier du magasin ne change jamais). Les autres sont téléchargés et vérifiés. Un fichier que le serveur n'a pas est laissé : son nœud le dira à l'ouverture. Les anciennes versions et les PDF viennent à l'ouverture (D6).
  - La base prise reçoit `pc.json` (l'identifiant de ce PC, celui du jeton, R17), `settings.json` (copié : les réglages de ce PC restent les siens jusqu'à la tâche 6) et `serveur.json` (le jeton chiffré, par `secretsAt`). Sa marque, `complete.json`, s'écrit en dernier, synchronisée sur le disque.
  - Coût si faux : nul.
- Ruling: **l'échange au démarrage** (R17 ; ses renommages revus au tour 1 de la revue, R21) :
  - le verrou est pris, puis lâché le temps des renommages (son fichier est dans le dossier), puis repris ;
  - le nom de l'ancienne base est `<dossier>-avant-jumelage-AAAA-MM-JJ`, en heure locale, puis « (2) », « (3) »… s'il est pris. La base de l'utilisateur s'appelle `base` : c'est le nom de la spec ;
  - l'ancienne base perd `downloads.json` et `serveur.json` ;
  - un dossier sans `cirrus.db` (un arrêt entre les deux renommages) est effacé, pas gardé ;
  - un renommage refusé un moment (l'antivirus) est retenté 5 fois, 100 ms × l'essai, des bornes fixes comme celles du magasin. S'il échoue encore, l'ancienne base est remise à sa place si elle l'avait quittée, elle s'ouvre, et l'échange attend le démarrage suivant ;
  - sans base prise, un seul `stat`.
  - Coût si faux : un renommage au démarrage.
- Ruling: **ni l'envoi ni la prise n'ont de délai** : ce sont des opérations sur toute la base, voulues par l'utilisateur, et un instantané de 2 Gio n'a pas de borne raisonnable. Quitter les interrompt (un `AbortController`). Les requêtes du jumelage restent bornées par `syncConnectTimeoutMs`. Aucun réglage nouveau.
  - Coût si faux : un serveur qui se fige au milieu d'un envoi laisse le bloc sur « Envoi de la base… » jusqu'à la fermeture.
- Ruling: **`done` est synchrone au serveur** (décodage, rejeu, vérification, écriture en une transaction) : les autres requêtes attendent, 20 s à 50 000 nœuds. Un serveur qui ne tient aucune base ne sert encore aucun PC synchronisé. Les flux ouverts sont fermés après `done` : ils reprennent par le journal.
  - Coût si faux : 20 s d'attente pour un PC qui se jumellerait au même moment.
- Ruling: **l'écriture en bloc n'est pas accélérée** (confirmé par R22). Elle fait 18,8 s des 20 s de l'envoi comme de la prise, à 50 000 nœuds et 1,18 million de branches.
  - Options mesurées ou estimées : un cache SQLite de 256 Mo pendant l'import (−20 %, mesuré) ; la base prise écrite sans WAL ni synchronisation, comme celle du banc (−37 %, mesuré ; une marque protège déjà une base prise incomplète) ; les branches en `WITHOUT ROWID`, une migration de schéma (un arbre au lieu de deux) ; les insertions triées par clé.
  - Pourquoi pas maintenant : une opération faite une fois par PC, sur une base dix fois plus grande que la vraie (plan 3c clos), et chaque option ajoute une API ou une migration.
  - Coût si faux : 20 s une fois par PC à cette taille. Les options ci-dessus restent ouvertes si la vraie base grossit.
- Ruling: **un refus après `/pair` révoque le jeton** (R15) : un `/hello` refusé ou illisible, une offre annulée, un envoi ou une prise qui échoue. La consigne de la tâche 4, « révoque-le avant de le jumeler de nouveau », disparaît. Le serveur arrêté au milieu, la révocation échoue, ce qui est seulement signalé : le PC reste inscrit jusqu'à `revoquer`.
  - Coût si faux : nul.
- Ruling: **« Dissocier ce PC » efface d'abord `serveur.json`, puis révoque le jeton au mieux** (`syncConnectTimeoutMs`), puis efface `downloads.json`. Hors ligne, le PC est dissocié quand même.
  - Coût si faux : un PC orphelin dans `pcs` quand on dissocie hors ligne.
- Ruling: **pendant une prise, l'ancienne base reste utilisable** : les actions faites entre le clic et la relance y restent, et partent avec elle sous `…-avant-jumelage-…`.
  - Options : retenir les actions sous le voile pendant la prise (le voile appartient à la synchro, qui ne tourne pas encore).
  - Coût si faux : une action faite pendant le téléchargement, qu'on retrouve dans l'ancienne base.
- Ruling: **le bloc « Serveur » montre l'offre à la place du formulaire** : son explication, le nom sous lequel la base de ce PC sera gardée, le bouton et « Annuler ». Les boutons sont ceux de la consigne : « Envoyer la base de ce PC au serveur (n nœuds, m fichiers) », « Prendre la base du serveur (n nœuds) » ; pour le refus entre deux bases pleines, « Remplacer la base de ce PC par celle du serveur (n nœuds) ». Le singulier sous 2 (« 1 nœud », « 0 nœud »).
  - Coût si faux : des mots.
- Ruling: **`m fichiers` compte les fichiers du magasin** (`files/`), puisque c'est ce qu'envoie l'envoi, anciennes versions comprises, et non les fichiers que nomment les nœuds.
  - Coût si faux : un nombre.
- Ruling: **un arrêt brutal pendant un envoi** laisse le PC inscrit au serveur (`pcs`) sans `serveur.json` : un orphelin, accepté. L'envoi partiel reste invisible ; il est effacé au démarrage suivant du serveur, ou au prochain envoi. Au jumelage suivant, le serveur est encore vide, et le PC envoie de nouveau.
  - Coût si faux : une ligne de trop dans `pcs`.

### Correctifs de la revue (tâche 5, tour 1)

Décisions du contrôleur : R19 (`done` ne refuse pas ce que la base du PC portait déjà), R20 (un libellé est coupé, jamais refusé à l'envoi), R21 (les bornes de l'échange restent fixes, allongées), R22 (les accélérations mesurées ne sont pas appliquées).

- Ruling: **l'envoi lit et vérifie d'abord ce qu'il enverra, avant toute requête** (`prepareSeed`, Important 3) : la dernière ligne du journal ; chaque ligne telle qu'elle partira (son libellé coupé), vérifiée comme le serveur la vérifie (`parseChangeRow`, numérotée de 1 sans trou) ; l'instantané rangé, décodé (une copie) et la fin du journal rejouée sur lui, sinon l'état des tables (le repli est signalé dans la console). Une ligne vraiment mal formée arrête l'envoi là, dit en français (« Ligne n du journal de ce PC : … »), et seul le jeton est révoqué.
  - Les règles du graphe ne sont pas jugées ici (R19).
  - Coût : une lecture du journal et le décodage de l'instantané, une fois par envoi (0,27 s à 50 000 nœuds, plus 10 µs par ligne), dans le principal, d'un seul tenant.
  - Coût si faux : nul.
- Ruling: **les fichiers sont listés après cette lecture** (Important 1). Un fichier est rangé avant l'écriture qui le nomme : toute ligne envoyée trouve donc le sien dans la liste. Une écriture faite après reste en attente, et le client l'envoie avec son fichier. L'ordre des requêtes reste celui de la consigne (les fichiers, l'instantané, le journal, `done`).
  - Options : lister deux fois et envoyer la différence (une seconde passe pour le même effet).
  - Coût si faux : nul.
- Ruling: **R19, mis en œuvre** : `done` vérifie encore la structure (chaque ligne à son arrivée, la fin du journal rejouée sur l'instantané). Les violations que l'état porte déjà sont comptées et signalées dans la console du serveur, et gardées. Remplace la décision « ce que `done` vérifie » sur ce point.
- Ruling: **R20, mis en œuvre** :
  - `truncateLabel` (cœur, `ops.ts`, avec `MAX_LABEL_CHARS`, qui y passe depuis `sync.ts` : `commands.ts` ne peut pas lire `sync.ts` sans cycle) coupe à 500 unités, finit par « … », et ne coupe jamais un caractère en deux ;
  - `Draft.finish` coupe tout libellé ; `invertAction` et le rétablissement aussi : « Annuler : » ou « Rétablir : » devant un libellé de 500 unités le portaient à 510 (trouvé en écrivant le test) ;
  - le client coupe le libellé d'une écriture en attente écrite avant la borne quand elle part (`POST /units`), et l'envoi celui de chaque ligne ;
  - le serveur refuse toujours un libellé trop long.
  - Coût si faux : un libellé coupé dans l'historique.
- Ruling: **l'échange au démarrage, revu** (Important 2, R21) :
  - chaque renommage est retenté 10 fois, la pause de 150 ms × l'essai, 7 s en tout : de quoi laisser un antivirus parcourir une base écrite juste avant. Ce sont des bornes fixes, documentées, pas des réglages : l'échange a lieu avant qu'aucune base, donc aucun réglage, ne soit ouverte (R21) ;
  - l'ancienne base, quand la nouvelle n'a pas pu prendre sa place, est remise par le même renommage retenté ;
  - `startBase` : si l'échange échoue en laissant une base à sa place, elle s'ouvre, et une base prise attend. S'il n'en laisse aucune, le démarrage s'arrête (`failOpen`), avec un message qui dit où est chaque base. `lockBase` et `openBase` ne créent jamais une base vide à la place de celle de l'utilisateur ;
  - une base prise qui attend (sa marque est là) est dite par une notification à l'ouverture et dans le bloc « Serveur » (`ServerInfo.waiting`, un `stat` à chaque `info()`).
  - Remplace le point « un renommage refusé un moment … 5 fois, 100 ms » de la décision « l'échange au démarrage ».
- Ruling: **les fichiers de la base prise sont sur le disque avant sa marque** (Minor 1) : `pc.json` écrit et synchronisé ; `serveur.json` aussi, puisque `fileSecrets.write` synchronise maintenant son fichier temporaire avant de le renommer, au jumelage ordinaire comme à la prise.
  - Coût : un `fsync` par écriture de `serveur.json`, une fois par jumelage.
- Ruling: **un premier jumelage en cours se voit** (Minor 3) : `info()` le rend (`busy` : « Envoi de la base au serveur… » ou « Téléchargement de la base du serveur… »), et le bloc ne montre que cela, sans formulaire ni bouton.
- Ruling: **un `done` refusé parce que le serveur n'est plus vide efface l'envoi partiel** de ce PC (Minor 5) : jusqu'à `MAX_SEED_BYTES` d'instantané ne restent plus sur le disque jusqu'au prochain envoi ou au redémarrage.
- Ruling: **un arrêt brutal entre `done` et l'écriture de `serveur.json`** (Minor 6) laisse le serveur tenir la base de ce PC, et ce PC non jumelé, ses lignes numérotées (`numberSeeded` a lieu avant `serveur.json`). Au jumelage suivant, sa base compte comme pleine et le serveur aussi : seul le remplacement est proposé, et les écritures faites après l'envoi partent avec l'ancienne base, mise à part.
  - Options : écrire `serveur.json` avant `done`. Un arrêt entre les deux laisserait alors une base jumelée dont la première synchro n'est pas réglée (contre R8), que le client enverrait écriture par écriture.
  - La fenêtre dure quelques millisecondes, après un envoi réussi : accepté.
  - Coût si faux : les écritures de quelques secondes à reprendre dans l'ancienne base.
- Ruling: **R22, les accélérations mesurées de l'écriture en bloc ne sont pas appliquées** : ni la base prise sans WAL (−37 %), ni le cache de 256 Mo (−20 %). C'est une opération faite une fois, d'environ 2 s à la taille de la vraie base, et le travail sur les performances est clos tant qu'elle ne grossit pas (plan 3c). Confirme la décision « l'écriture en bloc n'est pas accélérée ».
  - Coût si faux : environ 20 s, une fois, sur une base de 50 000 nœuds.
- **Tests ajoutés :**
  - cœur : le libellé coupé à la fin d'une commande, ainsi que pour annuler et rétablir ;
  - serveur : une base qui porte déjà une violation s'envoie ; une écriture acceptée entre `/seed` et `/seed/done` fait recevoir 409 à `done` et efface l'envoi partiel ; après un envoi, le redémarrage relit l'état gardé en mémoire ;
  - app :
    - un fichier rangé pendant l'envoi arrive au serveur, et le bloc dit l'envoi en cours ;
    - un libellé trop long et une violation déjà là ne bloquent pas l'envoi ;
    - un instantané qui ne se rejoue pas fait prendre l'état des tables ;
    - une ligne mal formée arrête l'envoi avant toute requête ;
    - une écriture en attente au libellé trop long part coupée ;
    - l'ancienne base est remise en réessayant ;
    - sans base à sa place, le démarrage s'arrête ;
    - une base qui attend est dite à l'ouverture et dans le bloc.

## Tâche 6 : les réglages partagés

Décisions du contrôleur pour cette tâche : R23 (tous les réglages sont partagés ; le serveur fait autorité ; au premier jumelage, un envoi de base ou deux bases vides envoient les réglages du PC, une prise prend ceux du serveur ; ensuite, la dernière valeur de chaque réglage attend dans `settings-pending.json` ; l'ordre de la fusion du cœur) et R24 (le serveur vérifie la forme, le PC les bornes).

### Fait

- **Le cœur :** `newer` et `Stamp` (`merge.ts`) sont exportés : la même comparaison décide entre deux écritures et entre deux changements d'un réglage, au serveur comme au PC. `sync.ts` gagne `MAX_SETTINGS_PER_REQUEST` (500, que le client respecte aussi), `SettingChange` (`{ value, at }`) et `SettingRow` (`{ value, at, pc }`).
- **La vue :** `settingValue(clé, valeur)`, une valeur bornée comme `withOverrides` lit un fichier de réglages (qui s'en sert désormais), ou `undefined` pour une clé qui n'est pas un réglage ou une valeur d'un autre genre.
- **Le serveur :**
  - `serveur.db` v2 : la table `settings (key, value, at, pc)`, la valeur en JSON, `NULL` pour un retour au défaut ;
  - `Tokens.settings()` et `Tokens.putSettings()` (une transaction : chaque changement gardé s'il est plus récent, par `newer`) ;
  - `settings.ts`, nouveau : `parseSettingChanges` (R24), `SettingsError` (400) ;
  - `GET /settings` et `POST /settings` (la réponse : chaque réglage envoyé tel que le serveur le garde) ; `Hub.publishSettings` (`event: settings`, sans `id`) ;
  - `bounds.ts` : `MAX_SETTING_KEY_CHARS` (64), `MAX_SETTING_VALUE_BYTES` (64 Kio), `MAX_SETTINGS_PER_REQUEST` réexporté du cœur ; le corps borné par `MAX_BODY_BYTES`, comme toute requête JSON d'un PC jumelé.
- **L'app :**
  - `main/settings.ts` : `SharedSettings` (`local`, `pending`, `receive`, `acknowledge`, `pairedAt`, `adopt`, `unpaired`) et `parseSettingRows` ; `settings-pending.json` ;
  - `main/sync/client.ts` : les réglages du serveur lus en entier à chaque connexion, une fois le flux ouvert ; l'événement `settings` ; l'envoi des réglages en attente en tête de la boucle d'envoi ;
  - `main/sync/host.ts` : `setSettings` (ce que `cirrus:settings:set` appelle), les réglages datés de l'heure du jumelage (deux bases vides, ou après un envoi de base), effacés de l'attente à la dissociation ; `HostWindow.settings` ;
  - `main/sync/firstSync.ts` : la prise écrit les réglages du serveur dans la base prise, et ne copie plus ceux du PC ;
  - `main/index.ts`, `wire.ts`, `preload`, `env.d.ts` : `cirrus:settings:set` reçoit les seuls réglages changés ; `cirrus:settings:changed` (`onSettingsChanged`) porte un lot reçu ;
  - l'interface : `renderer/settingChanges.ts` (`localChanges`, `applyReceived`, `keepUnsaved`), et `App.tsx` n'écrit que ce qui a changé ici et applique chaque lot reçu en un rendu.
- **Tests :** `packages/server/tests/settings.test.ts` (3 après la revue), `packages/app/tests/sharedSettings.test.ts` (17 après la revue) ; `EventReader.next` et `settings` (support du serveur), `Lab.settings` et `Lab.putSettings`, `AppPc.settingsTold`.
- **Scénario de l'interface** (le 26e, « jumeler une base neuve… ») : un réglage changé par un autre PC arrive dans `settings.json` et dans le bandeau (le champ montre la valeur reçue) ; un réglage tapé dans le bandeau arrive au serveur, puis rien n'attend ; après « Dissocier ce PC », `settings-pending.json` n'est plus là et les réglages de ce PC restent.

### Décisions

- Ruling: **l'interface n'envoie que les réglages changés chez elle** (`cirrus:settings:set` reçoit `{ clé: valeur }`, `null` pour un retour au défaut), et non plus tous ceux qui diffèrent des défauts.
  - Pourquoi : le principal écrit un lot reçu dans `settings.json` pendant que l'interface peut envoyer les siens. Envoyés en entier, ils porteraient l'ancienne valeur d'un réglage reçu un instant plus tôt, que le principal prendrait pour un changement local, plus récent : il effacerait le changement de l'autre PC, partout.
  - Sans serveur, le fichier écrit est le même, et il y a autant d'appels ou moins (aucun quand rien n'a changé).
  - Coût si faux : nul.
- Ruling: **l'heure d'un changement local suit ce que ce PC a vu** : `max(maintenant + écart, heure du dernier changement connu de ce réglage + 1)`, le dernier connu étant le sien en attente ou celui reçu du serveur.
  - Pourquoi : un réglage n'a pas d'« avant » comme une écriture ; seule l'heure décide. Un changement que l'utilisateur fait après en avoir vu un autre doit passer après lui, même si l'horloge de l'autre PC avance un peu. Deux changements du même PC dans la même milliseconde se suivent aussi.
  - Coût si faux : un changement daté d'une milliseconde de plus.
- Ruling: **le PC lit les réglages du serveur en entier (`GET /settings`) une fois son flux ouvert, et les applique avant tout ce que le flux apporte.** Un réglage changé entre les deux arrive par les deux ; l'heure de chaque réglage reçu, gardée en mémoire pour la connexion, empêche de l'appliquer deux fois ou d'appliquer un plus ancien.
  - Options : le lire avant d'ouvrir le flux (un changement fait entre les deux serait perdu jusqu'à la connexion suivante) ; une marque des réglages dans `/hello` (une requête de moins quand rien n'a changé, mais un second numéro à tenir).
  - Coût : une requête par connexion, quelques Kio.
- Ruling: **un réglage reçu s'applique selon R24** : une clé qui n'est pas un réglage est ignorée sans bruit (un PC plus récent peut en avoir de nouveaux) ; une valeur hors bornes est ramenée dans ses bornes (`settingValue`, comme `withOverrides`) ; une valeur d'un autre genre (un texte pour un nombre) est ignorée, celle de ce PC gardée, et dite dans la console. Un réglage ramené à son défaut quitte `settings.json`.
  - Coût si faux : un réglage qui diffère entre deux versions de Cirrus.
- Ruling: **un retour au défaut est gardé au serveur avec son heure** (`value` `NULL`), et rendu par `GET /settings` : un changement plus ancien ne peut pas faire revenir la valeur.
  - Coût : une ligne par réglage remis au défaut.
- Ruling: **l'événement `settings` va à tous les flux ouverts**, ceux qui rattrapent compris (ses trames sont entières), sans `id` : les numéros du flux sont ceux des écritures.
- Ruling: **les réglages en attente partent en tête de la boucle d'envoi**, avant les écritures et quoi qu'elles attendent, avec son attente croissante entre deux essais : ni délai ni réglage nouveaux. `flush` (avant la veille) les envoie aussi.
  - Des réglages refusés par le serveur (400, 413 : ils le seraient encore) sont abandonnés et dits dans la console ; une autre erreur coupe la connexion, et ils repartent à la suivante.
  - Un événement `settings` illisible est ignoré (dit) : un réglage ne vaut pas d'arrêter les écritures. Une réponse illisible à `GET` ou `POST /settings` arrête le client, comme une réponse illisible à `/units`.
  - Les réglages en attente ne comptent pas dans la pastille (« Envoi de n actions… »).
- Ruling: **« l'heure du jumelage » (R23) est l'heure du serveur que donne le `/hello` du jumelage.** Pour un envoi de base, elle est gardée avec l'offre, et c'est elle qui date les réglages une fois l'envoi fait. `settings-pending.json` est écrit juste avant `serveur.json` : un arrêt entre les deux le laisse sans serveur, et le jumelage suivant le récrit.
- Ruling: **la prise écrit les réglages du serveur dans la base prise** (`GET /settings` pendant `adoptBase`), avec un `settings-pending.json` vide : l'app redémarre sur eux, sans passer par les défauts sous le voile, et n'envoie rien des siens.
- ~~Ruling: une base jumelée avant cette tâche envoie ses réglages au premier démarrage.~~ **Retirée par R25** (revue de la tâche 6, Minor 1) : aucune vraie base n'a jamais été jumelée, et cette migration faisait de la présence de `settings-pending.json` une marque cachée. Si ce fichier était perdu pendant le jumelage, tout `settings.json` passait au-dessus des changements plus récents des autres PC. Un PC jumelé sans ce fichier prend maintenant les réglages du serveur, comme le dit R23.
  - Coût si faux : une base de développement jumelée avant la tâche 6 revient aux réglages du serveur.
- Ruling: **un lot reçu avant que l'interface ait lu ses réglages** (une page rechargée pendant que le principal synchronise) est appliqué sur eux quand elle les lit.
- ~~Ruling: le serveur ne borne que chaque requête, pas le nombre de réglages qu'il garde.~~ **Remplacée** au tour 1 de la revue (Minor 3) : voir `MAX_SETTINGS_KEPT` ci-dessous.
- Ruling: **`latexPackages` reçu s'installe au démarrage suivant**, comme le dit D1 du plan 4b (« installés sur chaque PC à son démarrage »), pas aussitôt.

### Correctifs de la revue (tâche 6, tour 1)

Décision du contrôleur : R25 (la migration `upgrade` est retirée).

- Ruling: **le bandeau change un réglage clé par clé, sur l'état le plus récent** (Important 1).
  - Le défaut : `SettingsPanel` rebâtissait toute la table à partir des réglages de son dernier rendu, et App la posait telle quelle. Un lot reçu du serveur s'applique par une mise à jour fonctionnelle, que React ne rend qu'un peu plus tard. Une entrée faite dans cet intervalle (un curseur, un chiffre tapé, un ↺) posait donc une table qui ne le contenait pas encore. Les réglages reçus repartaient alors avec leur ancienne valeur, datés comme le changement le plus récent, et défaisaient le changement de l'autre PC partout.
  - Le correctif : le bandeau donne `onChange(clé, valeur)`, et App fait `setParams(withSetting(clé, valeur))`, une mise à jour fonctionnelle bornée par `withOverrides`. « Tout réinitialiser » a son propre appel (`onResetAll`, tous les défauts). Le ↺ passe par `onChange(clé, défaut)`. Aucun autre endroit ne rebâtit la table depuis un rendu : les paquets LaTeX installés (`onPackagesInstalled`) passaient déjà par une mise à jour fonctionnelle. Il n'y a pas de « Rétablir » des réglages : les réglages sont hors de l'historique.
  - Coût si faux : nul.
- Ruling: **`cirrus:settings:set` répond par ce qu'il a écrit pour ses clés** (bornées, `null` pour le défaut), et l'interface l'adopte comme un lot reçu (Minor 2). Un réglage reçu pendant que l'enregistrement était en route, et dit à l'interface avant la réponse, cède ainsi la place à ce qui est dans `settings.json`. Une réponse qui ne change rien (le cas courant) ne coûte aucun rendu (`applyReceived` rend alors l'objet lui-même). Aucun message de plus : c'est la réponse de l'appel.
- Ruling: **le serveur garde au plus `MAX_SETTINGS_KEPT` réglages** (1 000, plus de cinq fois les 173 d'aujourd'hui ; Minor 3). Une requête qui en ajouterait au-delà est refusée entière (400), dans la transaction, avant toute écriture. Un réglage déjà gardé change toujours. Ce plafond borne aussi `GET /settings`, que chaque PC lit à chaque connexion.
- Ruling: **l'heure d'un réglage est un nombre entier de millisecondes, de 0 à 2^53 − 1** (`isSettingTime`, dans le cœur ; Minor 4). Le serveur la vérifie à la réception ; le PC aussi, dans ce que le serveur rend et dans son `settings-pending.json`. Au-delà, `at + 1 === at` : un PC ne pourrait plus passer un changement qu'il a vu, et à heure égale le plus grand identifiant gagnerait toujours.
- Ruling: **un changement local s'écrit dans `settings-pending.json` avant `settings.json`** (Minor 5). Un arrêt entre les deux laisse le changement en attente : il part, et la réponse du serveur écrit `settings.json` et le dit à l'interface. Dans l'ordre inverse, il était perdu à la lecture entière suivante.
- Ruling: **une erreur de disque en appliquant des réglages reçus est dite** (`console.warn`, « Réglages reçus non appliqués ») **et n'arrête jamais la synchro des documents** (Minor 6). La lecture entière de la connexion suivante les applique de nouveau.
- Ruling: **une seule comparaison des valeurs de réglage** (`sameSetting`, dans la vue), que `diffFromDefaults`, le bandeau, le principal et l'interface partagent ; `keepUnsaved` ne regarde que les propriétés propres (Minor 7).
- **Tests ajoutés :**
  - serveur : l'heure fractionnaire, négative ou au-delà de 2^53 est refusée, 2^53 − 1 acceptée ; le plafond des réglages gardés (rempli, une clé de trop refusée avec la requête entière, une clé gardée change encore) ;
  - app :
    - R25 (un PC jumelé sans `settings-pending.json` prend les réglages du serveur, n'envoie rien) ;
    - l'entrée du bandeau juste après un lot reçu (la file de mises à jour de React, rejouée) ;
    - la réponse de `cirrus:settings:set` et sa course avec un lot reçu ;
    - les heures non entières refusées ;
    - `settings-pending.json` écrit avant `settings.json` ;
    - le disque qui refuse `settings.json` pendant que les écritures continuent ;
    - un changement local pendant que `GET /settings` est en cours ;
    - un objet reçu pour une liste ;
    - une clé qui n'est pas un réglage dans `keepUnsaved`.
