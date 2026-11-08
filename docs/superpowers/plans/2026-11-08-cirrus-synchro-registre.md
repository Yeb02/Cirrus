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
  - D'ici là, la tâche 4 doit borner ce que `cirrus:load` envoie (`pendingUnits(limit)`), ou n'envoyer les écritures en attente qu'avec un serveur jumelé.
  - Coût si faux : la mémoire au chargement, pour un journal de plusieurs milliers d'actions.
- Ruling: **la simulation tire aussi « placer dans l'autre plan »**, en plus des commandes de la liste du plan, pour qu'un nœud soit souvent dans deux plans (retirer d'un plan sans jeter).
  - Le client de la simulation envoie, comme celui de la tâche 3, tout ce qui attend dès que rien n'est en vol, 50 écritures au plus.
  - Avec des envois de 4 écritures et trois actions par envoi, les files d'attente montaient à 140 écritures, et la simulation prenait 10 s.
  - Coût si faux : nul.
