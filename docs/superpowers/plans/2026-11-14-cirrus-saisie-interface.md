# Cirrus, plan 6b : la saisie et l'interface — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Écrit le 2026-11-14, avec l'utilisateur, qui le relit avant toute implémentation.**
> - Le 6b de la spec (section 24, « Hors du plan 6a ») est coupé en deux, à la demande de l'utilisateur. Ce plan prend la saisie et l'interface. Le **plan 6c** prendra l'historique : les versions d'un nœud, leur restauration et leurs différences, « Poids de l'historique » et le texte des PDF dans la recherche.
> - Tranché par l'utilisateur le 2026-11-14 :
>   - une connexion à un seul nœud se dessine comme un bras court et un marqueur déplaçable. Elle peut se créer d'un seul nœud, et elle reste quand on retire son avant-dernier membre ;
>   - la couleur d'un groupe se choisit dans une palette, ou librement, ou revient à « Automatique » ;
>   - « Poids de l'historique » (plan 6c) ne supprimera que des fichiers.
>   - un nœud qui part à la corbeille, partout ou de son dernier plan, quitte ses connexions, et celles qui gardent 0 ou 1 nœud le suivent (D2, D3) ;
>   - l'exécution : Claude fait lui-même les petites tâches, et confie à des sous-agents les plus volumineuses ou critiques.
> - Les autres décisions sont de Claude.

**Goal :** finir ce qui manque à la saisie des vraies données. L'utilisateur pourra alors :
- colorer ses groupes plan par plan ;
- poser une connexion sur un seul nœud ;
- lire un lien sans l'ouvrir, choisir où il mène ou importer sa cible ;
- tenir un agenda et des feuillets ;
- surveiller la santé de son graphe, consultations de tous ses PC comprises.

Ce plan fixe aussi deux choses :
- une restauration croisée avec une suppression partout converge proprement ;
- une mise à jour forcée qui ne progresse plus finit par abandonner.

**Architecture :**
- **Un seul changement de format, à la tâche 1 :** deux nouvelles sortes d'enregistrements (`agenda` et `sheet`), et un champ facultatif `color` sur un placement. `SCHEMA_VERSION` passe de 4 à 5 et `SYNC_PROTOCOL_VERSION` de 1 à 2. Le serveur, qui se met à jour seul, refuse alors chaque PC resté en arrière (409 au `/hello`), et ce PC prend la mise à jour forcée du plan 9. `SNAPSHOT_VERSION` ne bouge pas (règle de `codec.ts:16-19`).
- **Les connexions à un membre** changent une règle du cœur, partagée avec le serveur par `addedViolation`. Le rendu passe par le chemin « complexe » existant (`bundleGeometry`, shaders `CURVE` et `MARKER`), sans nouveau shader.
- **L'agenda et les feuillets** sont des onglets qui ne sont pas des plans. `App` garde l'onglet actif (`view`) à part du plan montré (`active`), qui reste un identifiant de plan pour tout ce qui le lit déjà.
- **La santé du graphe** est un panneau, sur le modèle de la corbeille. Elle est calculée dans l'interface, et les sections coûteuses le sont par tranches.
- **Les consultations** partent au serveur par lots, dans `serveur.db`, hors de la base et de son journal. La santé lit en retour, pour chaque nœud, sa dernière consultation, tous PC confondus.

**Tech Stack :** celle du plan 6a. Une seule déclaration nouvelle : `builder-util-runtime` 9.7.0, déjà installé comme dépendance d'electron-updater, déclaré dans `packages/app/package.json` pour son `CancellationToken` (D9).

**Spec :** `C:\Users\alpha\Desktop\Cirrus\2026-11-02-cirrus-design.md`, sections 5.3, 5.5, 5.6, 7, 8.4, 8.5, 11, 14, 17, 18.1, 19, 20 et 24.

**Registre :** `docs/superpowers/plans/2026-11-14-cirrus-saisie-interface-registre.md`, créé à la tâche 1. Une décision que ce plan ne fixe pas s'y consigne sous la forme `Ruling: … — pourquoi — coût si faux`, en entrées courtes.

## Global Constraints

- Tout texte montré à l'utilisateur est en français. Les apostrophes des messages sont typographiques (’), comme dans le code existant.
- Toute constante de rendu ou d'interaction est un réglage de `packages/view/src/params.ts` (`RenderParams`, `DEFAULT_PARAMS`, `PARAM_SPECS`), avancé (`A`) sauf mention contraire. Un groupe de réglages a au plus 16 entrées (`params.test.ts:52`).
- Toute édition est une action du cœur (`Action`). Elle entre dans le journal, se synchronise, et un Ctrl+Z la défait. Les consultations et les réglages ne sont pas des actions.
- On ne change jamais une migration livrée (`schema.ts`, `tokens.ts`). On en ajoute une.
- Les tests et les captures tournent sans focus ni premier plan. Aucun agent ne lance `npm run dev`, `start` ni `essai`.
- Le processus allégé s'applique (relecture unique par tâche, au plus un tour de correction, scénarios d'interface ciblés pendant la tâche), sauf aux tâches 1, 3 et 9 (format, synchro, serveur) : rigueur complète.
- Travail sur `main`, sans branche. Un commit par étape « Commit » ; l'utilisateur pousse lui-même, après avoir essayé « Cirrus Dev ».

## Review Focus

1. **Un PC resté en version 1 rencontre le serveur en version 2.** Il doit voir l'écran de mise à jour forcée, et non « Le serveur a envoyé une écriture illisible ». Test à la tâche 1 : `/hello` avec `Cirrus-Protocol: 1` répond 409.
2. **Une couleur libre extrême** (`#000000`, `#ffffff`, un vert saturé hors de la gamme OKLCH de la palette) : le groupe la montre telle quelle, et ses sous-groupes restent distincts d'elle et entre eux. Test à la tâche 5.
3. **Un aperçu de lien orphelin :** le pop-up qui portait le lien se ferme, défile ou passe en édition pendant l'attente du survol. L'aperçu ne doit ni rester à l'écran ni apparaître après coup. Test à la tâche 6.
4. **Une entrée d'agenda ou un feuillet qui nomme un nœud jeté ou disparu :** l'entrée le montre barré, avec « (à la corbeille) » ou « (disparu) ». Un clic dit pourquoi rien ne s'ouvre, et rien ne plante. Test à la tâche 7.
5. **Un lot de consultations envoyé deux fois** (réponse perdue, PC fermé pendant l'envoi) : le serveur ne garde aucun doublon, et le PC reprend où le serveur s'est arrêté. Test à la tâche 9.

---

## Décisions

- **D1, le format 2** (spec 5.5, 5.6, 6.6, 18.1).
  - **Les enregistrements nouveaux** (`packages/core/src/model.ts`) :
    ```ts
    export interface AgendaEntryRec { id: Id; day: string; title: string; text: string; nodes: Id[] }
    export interface SheetRec { id: Id; createdAt: number; text: string }
    export interface Placement { plan: Id; node: Id; x: number; y: number; k: number; color?: string }
    ```
    - `day` s'écrit `AAAA-MM-JJ` et doit être une date réelle.
    - `title` fait de 1 à 200 caractères après `trim`, et `text` au plus 20 000 caractères.
    - `nodes` compte au plus 50 identifiants distincts.
    - `SheetRec.text` fait au plus 100 000 caractères. `createdAt` est un temps en ms, entier et fini.
    - `color` s'écrit `#rrggbb` en minuscules (`/^#[0-9a-f]{6}$/`). Son absence veut dire « Automatique ».
  - **Les ops :** `{ t: 'agenda'; before: AgendaEntryRec | null; after: AgendaEntryRec | null }` et `{ t: 'sheet'; … }`. Elles appartiennent au flux `content`, et leur sujet est leur `id`.
  - **La fusion** reprend l'enregistrement entier : le plus récent l'emporte, comme pour un placement. Deux PC qui modifient en même temps le même feuillet, ou le même groupe (couleur d'un côté, déplacement de l'autre), gardent la dernière écriture [C]. Pour un seul utilisateur, c'est rare.
  - **Le stockage :** la migration v5 crée `agenda (id TEXT PRIMARY KEY, json TEXT NOT NULL)` et `sheets (id TEXT PRIMARY KEY, json TEXT NOT NULL)`. Le placement garde son JSON : `color` n'y demande aucune migration.
  - **L'instantané** gagne `agenda?` et `sheets?` dans sa partie JSON, et `SNAPSHOT_VERSION` reste 1. Un placement coloré est « irrégulier » (`regularPlacement`, `codec.ts:100`) : il passe par la partie JSON.
  - **`isEmpty()`** compte aussi l'agenda et les feuillets : une base qui n'a qu'eux n'est pas vierge au premier jumelage.
  - **Les versions :** `SCHEMA_VERSION` passe à 5, et `SYNC_PROTOCOL_VERSION` (`core/src/sync.ts:51`) à 2. L'un ou l'autre suffirait à refuser un PC ancien ; les deux disent vrai.
  - **Les commandes du cœur** (`commands.ts`), une action chacune :
    - `setGroupColor(s, plan, node, color: string | null)`, libellée « Couleur de « T » ». Elle refuse un nœud qui n'est pas un groupe dans ce plan : « Ce nœud n’est pas un groupe dans ce plan. ». `null` retire le champ ;
    - `putAgendaEntry(s, e)`, libellée « Agenda : « titre » » ;
    - `deleteAgendaEntry(s, id)`, libellée « Supprimer « titre » de l’agenda » ;
    - `putSheet(s, sh)`, libellée « Feuillet » ;
    - `deleteSheet(s, id)`, libellée « Supprimer un feuillet ».
    - Une valeur hors des bornes est refusée en français, par la vérification de l'op (`ops.ts`) que la commande, le serveur et l'envoi partagent.
- **D2, une connexion à un seul membre** (spec 5.3, 8.5, 11 ; retour de l'utilisateur du 2026-11-11, point 4).
  - **La règle :** une connexion de connaissance vivante a au moins un membre. L'invariant `members` (`invariants.ts:119-124`) refuse désormais zéro membre, avec le message « Une connexion doit relier au moins un nœud. ». Les connexions d'inclusion et de structure ne changent pas.
  - **Retirer un membre** (`removeMember`) garde la connexion tant qu'il lui reste un membre. Retirer le dernier la met à la corbeille, et ce membre reste dans sa liste, pour une restauration.
  - **Un nœud qui part à la corbeille quitte ses connexions** (décision de l'utilisateur, 2026-11-14). Cela vaut pour « Supprimer partout » (`deleteEverywhere`) comme pour le retrait de son dernier plan (`removeFromPlan`, « Cacher » ou « Ici seulement ») : il est retiré de chacune de ses connexions, vivantes ou déjà à la corbeille, avec ses branches et ses fantômes. Une connexion vivante qui garde alors 0 ou 1 nœud part à la corbeille avec lui. Le retrait volontaire d'un membre (`removeMember`), lui, garde une connexion à un nœud.
    - Un seul outil du cœur, `Draft.leaveConnections(s, node)`, sert aux deux chemins.
    - Une annotation qui quitte son dernier plan reste vivante (spec 7) : elle garde ses connexions.
    - Restaurer un nœud ne lui rend pas ses connexions ; la corbeille rend une connexion, avec les membres qui lui restent.
    - L'avertissement de « Cacher » (`trashNote`, `questions.ts:78`) compte aussi les connexions qui partiraient : « « A » ira à la corbeille (dernier plan), avec 2 connexions ».
  - **La création :** le geste « Ajouter une connexion » se termine aussi :
    - par un clic sur le fond. Le marqueur est épinglé là, dans ce plan (`setLayout`, `marker`) ;
    - par Entrée. Le marqueur prend alors sa place par défaut.
    - Le nœud de départ est source, comme pour toute connexion tirée. La question « partout ou ici » porte sur les autres plans où ce nœud est placé (`otherPlans(s, plan, [from])`).
  - **Le dessin** passe par le chemin complexe :
    - un bras va du bord du nœud au marqueur ;
    - le marqueur est toujours dessiné, ce qui le rend cliquable, et le titre court se pose près de lui comme pour les autres connexions ;
    - le glyphe du rôle se pose au bout côté nœud : une flèche sortante pour une source, entrante pour une cible, un point pour un associé.
    - Sans marqueur épinglé, le marqueur est à `singleArmLength` (80, en unités du monde, multiplié par `f^k` du nœud) du bord du nœud, dans la direction `singleArmAngle` (−45°, vers le haut à droite à l'écran). On le déplace par sa poignée, comme aujourd'hui, et il suit son nœud (`layoutsFollowing`).
  - **Ce qui la montre :** elle s'affiche dans un plan où son nœud est placé. Une connexion de deux membres dont un seul est présent reste masquée, avec son badge, comme aujourd'hui (`view/tests/scene.test.ts:128`).
  - **Copier et coller :** une connexion à un membre suit si son nœud est dans la sélection (`clip.ts:57`).
  - **La corbeille :** restaurer une connexion demande au moins un membre vivant. Il y a deux refus :
    - « Ses nœuds sont à la corbeille : restaure-les d’abord. », quand elle a des membres mais aucun vivant ;
    - « Il ne reste aucun nœud à cette connexion : elle ne peut pas revenir. » (`RESTORE_CONNECTION_LOST`), quand elle n'en a plus aucun.
    - Elle revient avec une branche par membre vivant, dans chaque plan où au moins `min(2, vivants)` de ses membres sont placés. Une connexion jetée avec un nœud ne l'a plus dans sa liste (D2) : elle revient sans lui, à un nœud s'il ne lui en reste qu'un.
  - **Les messages qui disaient « deux » :**
    - la question du retrait d'un membre (`questions.ts:58-67`) ne parle de corbeille que pour le dernier membre ;
    - `RESTORED_WITHOUT_BRANCH` devient « Connexion restaurée ; aucun plan ne montre ses nœuds. » ;
    - `CONNECTION_NO_PLAN` devient « Cette connexion n’est dans aucun plan. ».
- **D3, la règle de synchro de la section 7** (« une connexion vivante dont un membre est à la corbeille »).
  - **Le constat :** avec D2, aucune commande ne laisse plus un nœud jeté dans une connexion vivante. Seule une synchro croisée le peut : un PC jette un nœud (partout, ou de son dernier plan) pendant qu'un autre restaure une connexion qui le contenait, lui ajoute un membre ou la recrée par Ctrl+Z.
  - **La règle :** le départ d'un nœud à la corbeille l'emporte. La connexion fusionnée n'a pas ce nœud, ni ses branches, ni ses fantômes, et si elle garde 0 ou 1 nœud alors qu'elle en avait au moins deux, elle va à la corbeille ; le même état sur les deux PC, dans tous les ordres.
  - **Le moyen :**
    - la fusion des membres par nœud (`mergeMembers`, `merge.ts:280`) garde le retrait fait par `leaveConnections`, face au changement de `trashedAt` d'une restauration ;
    - `rebaseUnit` (`merge.ts:358-474`) écarte des ops rebasées les branches et les fantômes d'un membre retiré, et ajoute, pour une écriture qui jette un nœud, le retrait de ce nœud des connexions vivantes de l'état reçu (sur le modèle des `extra`, `merge.ts:438-474`). Sinon `addedViolation` jetterait l'écriture entière ;
    - aucun invariant nouveau : une base ancienne qui a déjà un tel état reste lisible, et la santé du graphe ne le liste pas [C].
  - **Les tests :**
    - quatre ordres × {[X, Y], [X, Y, Z]} × {suppression partout, retrait du dernier plan}, croisés avec la restauration de la connexion (`core/tests/trash.test.ts:226-249`, `crossed`). Attendu : aucune écriture perdue ; X à la corbeille ; la connexion sans X, ni branche ni fantôme de X ; à la corbeille pour [X, Y], vivante à deux pour [X, Y, Z] ; les deux PC dans le même état ;
    - le même croisement avec `addMember(c, X)` sur l'autre PC ;
    - les 2 000 commandes tirées au hasard (`reconcile.test.ts:448`) passent toujours.
- **D4, la couleur d'un groupe, propre au plan** (spec 5.5, 8.4, « Choix manuel »).
  - **La règle de couleur** (`groupColors`, `view/src/frame.ts:21`) remonte de ce groupe, lui compris, jusqu'au premier ancêtre qui porte une couleur dans ce plan.
    - **Sans ancêtre coloré :** la règle d'aujourd'hui.
    - **Avec un ancêtre coloré :** sa couleur `#rrggbb` se convertit en OKLCH (`rgbToOklch`, nouveau, dans `color.ts`). L'ancêtre la montre telle quelle (`closed`). Un sous-groupe, à la profondeur relative d > 0, garde la teinte et la chroma, avec une luminosité décalée de d × `groupLightnessStep`, rebondie dans `groupLightnessRange` comme aujourd'hui. Un sous-groupe qui a sa propre couleur la montre, et la transmet aux siens.
    - L'enveloppe ouverte reste un mélange avec le ciel (`envelopeOpacityOpen`).
  - **La palette :** `groupPaletteHues`, 12 teintes espacées de 30° à partir de 15°, à la luminosité `groupLightness` et à la chroma `groupPaletteChroma` (0,12). Deux réglages de plus dans « Groupes », qui passe de 14 à 16 entrées.
  - **Le sélecteur** (`ui/GroupColorPicker.tsx`, nouveau) :
    - les 12 pastilles de la palette ;
    - « Automatique » ;
    - « Autre… », un `<input type="color">`, comme les réglages (`SettingsPanel.tsx:67`).
    - Un choix est une action (`setGroupColor`). Le sélecteur reste ouvert pour en essayer un autre, et Échap ou un clic dehors le ferme.
  - **Où on le trouve :**
    - l'entrée « Couleur… » du menu d'un groupe (`menus.ts`), qui ouvre le sélecteur à l'endroit du clic ;
    - une section « Couleur dans ce plan » du pop-up d'un groupe (`NodePopup.tsx`), qui reçoit pour cela le plan montré de `Panels`.
- **D5, les liens `\ref` et `\cite`** (spec 14).
  - **L'aperçu au survol :** après `linkPreviewDelayMs` (400 ms) sur un lien, un aperçu se pose près du lien (`ui/latex/LinkPreview.tsx`, nouveau). Il montre :
    - le titre du nœud ;
    - son résumé compilé (`useCompiled` + `buildRequest` + `LatexSnippet`, sans l'édition de `NodePopup`) ;
    - la ligne de ses plans (« ce plan », « lobby », noms).
    - Il disparaît quand le pointeur quitte le lien, quand le pop-up qui le porte se ferme, défile ou change de mode, et à tout clic. Il n'est pas interactif : ouvrir un nœud depuis un aperçu reste pour plus tard (spec 14).
  - **Le clic droit sur un lien** ouvre un `ContextMenu` :
    - « Ouvrir le pop-up » (le clic gauche d'aujourd'hui) ;
    - « Voir dans « P » », pour chaque plan qui a le nœud, dans l'ordre de `elsewhere()` (`navigation.ts:119`), précédé de « Voir dans ce plan » s'il y est ;
    - « Importer ici », si le nœud n'est pas dans le plan montré.
    - Un nœud jeté ou disparu montre la seule entrée « Ouvrir le pop-up », qui dit `NODE_GONE` comme aujourd'hui.
  - **« Importer ici »** suit le modèle de « Restaurer » (`GraphView.tsx:582-597`). `GraphHandle.importHere(node)` refuse, par une notification :
    - un nœud déjà dans le plan (`ALREADY_HERE`, avec cadrage du nœud, comme `dropNodeAt`) ;
    - un nœud jeté ;
    - un geste en cours (`busyReason('d’importer')`).
    - Sinon il lance `startPlacing({ kind: 'import', node, label: 'Importer ici' }, titre, lastPointer ?? centre)`, et le clic pose le nœud par `importBuild`.
  - **Le plein écran** ne change pas : ses liens ne font qu'avertir (`FullScreen.tsx:103`).
- **D6, l'agenda et les feuillets** (spec 17).
  - **Les onglets :**
    - « Agenda » et « Feuillets » s'ouvrent depuis le menu « + » de la barre d'onglets, après les plans fermés, et depuis le menu du fond. Ils se ferment comme un plan.
    - `App` garde `view: 'graph' | 'agenda' | 'sheets'` à part de `active`, qui reste le dernier plan montré. GraphView reste monté mais caché (`display: none`) : sa caméra et ses scènes survivent à un aller-retour.
    - Les onglets ouverts s'enregistrent avec les autres (`cirrus.tabs`), sous les identifiants réservés `@agenda` et `@feuillets`, que `liveTabs` garde.
  - **L'agenda** (`ui/AgendaView.tsx`) :
    - une frise verticale, du plus ancien en haut au plus lointain en bas, regroupée par mois (« novembre 2026 ») ;
    - une ligne marque aujourd'hui, et la vue s'y place à l'ouverture ;
    - chaque entrée montre sa date, son titre, son texte et ses nœuds liés ;
    - « Nouvelle entrée » ouvre un formulaire : date (aujourd'hui par défaut), titre, texte, et nœuds ajoutés par un champ qui cherche dans l'index de Ctrl+K (titres seulement).
    - Un clic sur un nœud lié fait comme « Aller au nœud » (`goToNode`). Un nœud jeté ou disparu est barré, suivi de « (à la corbeille) » ou « (disparu) ».
    - Modifier et supprimer se font depuis l'entrée. Aucun rappel.
  - **Les feuillets** (`ui/SheetsView.tsx`) :
    - une liste, du plus récent au plus ancien ;
    - chaque feuillet est un texte libre éditable sur place, avec son âge : « à l’instant », « il y a 5 min », « il y a 3 h », « il y a 2 j », puis la date.
    - La frappe s'enregistre après `sheetTypingPauseMs` (800 ms) de pause, et à la perte du focus. Les enregistrements d'une même frappe se fondent en un seul pas d'annulation (`run(build, { merge: true })`).
    - Dans le champ, Ctrl+Z agit sur le texte (spec 6.4).
    - Rien ne s'efface seul.
  - **Le raccourci :** Ctrl+Maj+N crée un feuillet vide, ouvre l'onglet « Feuillets » et y met le focus, depuis n'importe où sauf un plein écran ou une question ouverte.
  - **Feuillet → nœud :** « En faire un nœud » ramène l'onglet du dernier plan montré, et un fantôme suit le curseur, comme une restauration. Le clic crée le nœud et supprime le feuillet, en une action (`sheetToNode(s, sheet, plan, x, y, k)`, `combine` de `createNode` et `deleteSheet`) :
    - le titre est la première ligne non vide, coupée à 200 caractères ;
    - le résumé est le reste, ses caractères spéciaux LaTeX échappés (`\ { } % $ & # _ ^ ~`) : un texte libre ne doit pas casser une compilation.
    - Échap abandonne, et le feuillet reste.
  - **La recherche** ne voit ni l'agenda ni les feuillets [C]. Cela pourra venir plus tard.
- **D7, l'envoi des consultations** (spec 20). Il est dans ce plan parce que « jamais revus » doit compter tous les PC.
  - **Le serveur :** la migration v4 de `serveur.db` (`server/src/tokens.ts`) crée une table de consultations. Les routes sont authentifiées comme les autres.
    ```sql
    CREATE TABLE consultations (pc TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL,
      subject TEXT, plan TEXT, detail TEXT, PRIMARY KEY (pc, seq));
    CREATE INDEX consultations_subject ON consultations (subject, at);
    ```
    - `POST /consultations { events: [{ seq, at, kind, subject?, plan?, detail? }] }` écrit les événements, au plus `MAX_CONSULTATIONS_PER_REQUEST` (1 000) et `MAX_CONSULTATIONS_BODY_BYTES` (1 Mio). Il fait `INSERT OR IGNORE` sur `(pc, seq)`, et répond `{ upto }`, le plus grand `seq` gardé pour ce PC. Un lot irrégulier est refusé en entier (`parseConsultations`, partagé avec le PC).
    - `GET /consultations/upto` répond `{ upto }`.
    - `GET /consultations/seen` répond `{ seen: [subject, at][] }`, la dernière consultation de chaque sujet, tous PC confondus. Il ne compte que les sortes qui disent qu'on a regardé un objet : `node_popup`, `connection_popup`, `file_preview`, `file_fullscreen`, `jump` et `search` avec un résultat.
  - **Le PC :**
    - le `seq` d'un événement est le `rowid` de `consultations.db` ;
    - une table `sent (base TEXT PRIMARY KEY, upto INTEGER NOT NULL)`, créée par `CREATE TABLE IF NOT EXISTS`, retient ce qui est parti vers chaque base du serveur (son `baseId`). Une base prise d'un autre serveur repart de ce que celui-ci dit (`/consultations/upto`) ;
    - `SyncClient` envoie ce qui attend à l'ouverture de la connexion, puis toutes les `consultationsSendMs` (60 s), par lots de 1 000, un envoi à la fois, et seulement avec une connexion ouverte ;
    - interrupteur éteint (`consultationsRecord === 'no'`), rien ne part.
  - **La lecture :** `cirrus:consultations:seen` rend à l'interface une table `Map<Id, number>`, fusion de ce que dit le serveur et des événements locaux pas encore partis. Sans serveur, elle ne lit que le local.
- **D8, la santé du graphe** (spec 20).
  - **Le panneau « Santé du graphe »** (`ui/HealthPanel.tsx`, logique pure dans `renderer/health.ts`) :
    - il s'ouvre par « Santé du graphe… », l'entrée du menu du fond placée avant « Corbeille… » ;
    - il est exclusif avec la corbeille et le registre (`useScreens`), et Échap le ferme (`usePanelEscape`).
  - **Les sections**, chacune repliable, avec son compte, dans cet ordre :
    1. **Références cassées :** un `\ref` vers un label inconnu, un `\cite` vers une clé qu'aucun nœud vivant ne porte. Une ligne par source, avec le nom.
    2. **Labels en double**, et **clés BibTeX en double**.
    3. **Conflits de `.tex` :** chaque copie « (conflit du …) » d'un nœud dont l'original existe (`conflictOriginal`). La ligne ouvre la comparaison.
    4. **Tags obligatoires non renseignés :** pour chaque clé obligatoire, les objets qui ne la portent pas, avec ou sans valeur par défaut (spec 5.4 : « les valeurs jamais renseignées »). Une ligne par clé, avec son compte ; on la déplie pour voir ses objets.
    5. **Nœuds orphelins :** vivants, hors annotations, membres d'aucune connexion de connaissance vivante.
    6. **Jamais revus :** des nœuds vivants, hors annotations, créés il y a plus de `healthUnseenDays` (30) jours (l'instant de création se lit dans leur identifiant uuidv7), et qui n'ont aucune consultation sur aucun PC (D7). La section le dit quand l'interrupteur des consultations est éteint.
    7. **Intrus dans une enveloppe :** par plan, `intruders(buildScene(…))`, calculés par tranches de `searchBuildSliceMs` dans les moments libres, comme l'index de recherche ; « Calcul en cours… » jusque-là. La scène déjà en cache d'un plan sert telle quelle.
    8. **Plans ignorés lors d'une répercussion :** les plans `third` et `loops` de `repercussion()`, et ceux qu'un Échap a sautés. Ils sont retenus pour la session seulement, au plus 200 [C] : ils ne se déduisent pas de l'état.
  - **Une ligne** montre l'objet (titre, ou nom de la connexion comme à la corbeille) et son endroit. Un clic saute à lui (`destination` + `reveal`), sinon ouvre son pop-up.
  - **Le recalcul :** à chaque action, pour les sections 1 à 6, que le registre LaTeX suit déjà ; seulement si le panneau est ouvert. Critère : sur la base de référence (50 000 nœuds, 500 000 connexions), les sections 1 à 6 se calculent en moins de 150 ms. Sinon, elles passent aussi par tranches.
  - La spec liste aussi les « nœuds orphelins ou jamais revus » et les « références cassées » : tout ce qu'elle liste est couvert.
- **D9, le délai sans progrès d'une mise à jour forcée** (revue de la mise à jour forcée, 2026-11-11).
  - Le réglage `updateStallMs` vaut 120 000 ms (2 min), de 10 000 à 3 600 000. Il va dans un groupe nouveau, « Mises à jour », avec `updateCheckMs` qui quitte « Synchronisation », sous la rubrique « Serveur ».
  - Un chien de garde s'arme au début du téléchargement (`fetchInstaller`) et se réarme à chaque `download-progress`. À son terme, il annule le téléchargement par un `CancellationToken` passé à `downloadUpdate`, et l'échec dit : « aucune donnée depuis 2 min ». Il suit le modèle de `fetchDownload` (`latex/tinytex.ts:129-160`) et de sa durée lisible (`seconds(ms)`). L'essai suivant vient comme après tout échec.

**Hors du plan 6b (plan 6c) :** l'historique par nœud (ses versions, leur restauration, leurs différences), « Poids de l'historique » (des fichiers seulement, avec leur nom, leur date et leur taille gardés) et le texte des PDF et des autres fichiers dans la recherche.

---

### Task 1 : le format 2 (D1)

**Files:**
- Modify : `packages/core/src/model.ts:43-82`, `ops.ts` (Op :8-18, `flowOf` :21-25, `subjectOf` :32-50, vérificateurs :114-202, `RECORDS` :219-228), `tables.ts:447-463`, `state.ts` (State :48-62, `stateOf` :83-91, `write` :287-357, `loadRecords` :360-392, `checkRecord` :575-588), `snapshot.ts`, `codec.ts` (JsonPart :51-69, encode ~221, decode ~618), `merge.ts` (`recordKey` :26, `current` :51), `commands.ts` (Draft :106-125, commandes nouvelles), `sync.ts:51`, `index.ts`
- Modify : `packages/store/src/schema.ts` (v5), `localStore.ts` (`loadState` :97, `rowOf` :121, `persistOp` :161, `importState` :410, `isEmpty` :603), `bulk.ts:12`
- Modify : `packages/fixtures/src/large.ts:59`, `packages/server/tests/support.ts:17`
- Create : `docs/superpowers/plans/2026-11-14-cirrus-saisie-interface-registre.md`
- Test : `packages/core/tests/format2.test.ts` (nouveau), `packages/store/tests/localStore.test.ts`, `packages/server/tests/format.test.ts` (nouveau)

**Interfaces:**
- Produces : les types `AgendaEntryRec`, `SheetRec`, `Placement.color` ; `State.agenda: ReadonlyMap<Id, AgendaEntryRec>`, `State.sheets: ReadonlyMap<Id, SheetRec>` ; `setGroupColor(s, plan, node, color: string | null): Action`, `putAgendaEntry(s, e: AgendaEntryRec): Action`, `deleteAgendaEntry(s, id: Id): Action`, `putSheet(s, sh: SheetRec): Action`, `deleteSheet(s, id: Id): Action` ; `NOT_A_GROUP = 'Ce nœud n’est pas un groupe dans ce plan.'`. Tout est exporté de `@cirrus/core`.

- [ ] **Step 1 : créer le registre**, avec l'en-tête du registre du plan 6a (plan, date, règle `Ruling:`). Commit : `docs: registre du plan 6b`.
- [ ] **Step 2 : écrire les tests qui échouent** (`format2.test.ts`) :
  - `un placement coloré fait l’aller-retour de l’instantané` : `decodeState(encodeState(s))` rend `color: '#3a7bd5'`, et `SNAPSHOT_VERSION === 1` ;
  - `une couleur mal formée est refusée` : `parseOp` d'un placement `color: '#3A7BD5'`, `'#fff'` et `'bleu'` lève une erreur ;
  - `setGroupColor refuse un nœud qui n’est pas un groupe` → `NOT_A_GROUP` ; `setGroupColor(…, null)` rend un placement sans clé `color` ;
  - `déplacer un groupe garde sa couleur` : `moveNodes` après `setGroupColor`, et `color` est toujours là ;
  - `agenda et feuillets : création, modification, suppression, annulation` : `invertAction` de chaque action rend l'état d'avant (`State.agenda`, `State.sheets`) ;
  - `les bornes de l’agenda` : `day: '2026-02-30'`, un titre vide après `trim`, 201 caractères, 51 nœuds, un nœud répété → chacun refusé ;
  - `les bornes d’un feuillet` : 100 001 caractères, `createdAt: 1.5` → refusés ;
  - `deux PC modifient deux feuillets différents` : `crossed` (`core/tests/twoPcs.ts:53`), dans les quatre ordres, garde les deux, sans écriture perdue ;
  - `les versions` : `SYNC_PROTOCOL_VERSION === 2`.
- [ ] **Step 3 : les lancer**, `npm test -w packages/core -- format2`. Attendu : ÉCHEC (types et commandes absents).
- [ ] **Step 4 : implémenter D1 dans le cœur,** en suivant la liste du précédent du préambule (commit `8942dba`) : model → ops → tables → state → snapshot → codec → merge → commandes. Les deux sortes nouvelles sont des `Map` sous `MapFacade`, comme `phantoms`. `subjectOf` rend l'`id`.
- [ ] **Step 5 : les lancer**, puis toute la suite du cœur : `npm test -w packages/core`. Attendu : SUCCÈS.
- [ ] **Step 6 : le stockage et le serveur.** Tests :
  - `localStore.test.ts` : `agenda et feuillets survivent à une réouverture` (commit, fermeture, `open`, l'état les a) ; `isEmpty est faux avec un seul feuillet` ; `SCHEMA_VERSION === 5` ;
  - `server/tests/format.test.ts` : `un PC en protocole 1 est refusé` (`/hello` avec `Cirrus-Protocol: 1` → 409, et le message contient « mets à jour Cirrus ») ; `le serveur accepte une écriture d’agenda` (`Canon.accept` → accepté, relu après redémarrage).
  - Implémenter la v5 (`schema.ts`), `loadState`, `rowOf`, `persistOp`, `importState` (`held`), `isEmpty`, `insertState`, la fixture `large.ts`, et `FORMAT` dans `support.ts`.
- [ ] **Step 7 : tout lancer**, `npm test -w packages/core && npm test -w packages/store && npm test -w packages/server && npm test -w packages/app`. Attendu : SUCCÈS.
- [ ] **Step 8 : commit**, `feat(core, store): le format 2 — l’agenda, les feuillets et la couleur d’un placement ; schéma 5, protocole 2`.

### Task 2 : le délai sans progrès d'une mise à jour forcée (D9)

**Files:**
- Modify : `packages/view/src/params.ts` (`updateStallMs` ; groupe « Mises à jour » avec `updateCheckMs` ; `PARAM_RUBRICS` « Serveur »), `packages/app/src/main/update/updater.ts` (`UpdaterDeps.params` :112, `fetchInstaller` :359-391, `progress` :426), `packages/app/package.json` (`"builder-util-runtime": "9.7.0"`)
- Test : `packages/app/tests/update.test.ts`, `packages/view/tests/params.test.ts`, `packages/app/tests/settingsTree.test.ts`

**Interfaces:**
- Consumes : `FeedUpdater.downloadUpdate(token?: CancellationToken)`.
- Produces : `RenderParams.updateStallMs: number`.

- [ ] **Step 1 : tests qui échouent :**
  - `update.test.ts` → `un téléchargement sans progrès échoue après updateStallMs` : un faux `FeedUpdater` dont `downloadUpdate` ne se résout jamais et n'émet rien ; horloge simulée (`vi.useFakeTimers`). Après 120 000 ms, le jeton est annulé, et le flux est `{ step: 'failed' }` avec un message qui contient « aucune donnée depuis 2 min » ;
  - `chaque progrès réarme le délai` : un `download-progress` à 100 s, puis rien. Il n'y a pas d'échec à 200 s, et l'échec vient à 220 s ;
  - `params.test.ts` → la fiche de `updateStallMs` (défaut 120 000, bornes 10 000 et 3 600 000, groupe « Mises à jour ») ; « Synchronisation » a 15 entrées.
- [ ] **Step 2 : les lancer**, `npm test -w packages/app -- update` et `npm test -w packages/view -- params`. Attendu : ÉCHEC.
- [ ] **Step 3 : implémenter D9.**
- [ ] **Step 4 : les lancer, avec `settingsTree`.** Attendu : SUCCÈS.
- [ ] **Step 5 : commit**, `feat(app): une mise à jour forcée sans progrès abandonne après updateStallMs (2 min)`.

### Task 3 : connexions à un membre et règle de synchro, dans le cœur (D2, D3)

Rigueur complète : synchro.

**Files:**
- Modify : `packages/core/src/invariants.ts:119-124`, `commands.ts` (`Draft.leaveConnections`, `removeFromPlan` :335-348, `deleteEverywhere` :351-371, `removeMember` :423-433, `restoreConnection` :889-912, `RESTORE_CONNECTION_LOST` :376), `merge.ts` (`mergeMembers` :280, `rebaseUnit` :358-474), `packages/core/tests/oracle/invariants.ts:117`
- Modify (tests qui supposaient deux membres) : `core/tests/invariants.test.ts:41`, `transact.test.ts:283` (prendre une autre violation déjà là), `commands.test.ts:61, 198`, `core/tests/trash.test.ts:178-249`, `server/tests/seed.test.ts:115`, `app/tests/firstSync.test.ts:391`
- Test : `packages/core/tests/single.test.ts` (nouveau), `packages/core/tests/trash.test.ts`

**Interfaces:**
- Produces : `connect(s, { plan, members: [un seul] })` accepté ; `RESTORE_CONNECTION_LOST = 'Il ne reste aucun nœud à cette connexion : elle ne peut pas revenir.'`.

- [ ] **Step 1 : tests qui échouent** (`single.test.ts`) :
  - `une connexion d’un seul membre se crée` ;
  - `une connexion sans membre est refusée` (code `members`, « Une connexion doit relier au moins un nœud. ») ;
  - `retirer l’avant-dernier membre garde la connexion`, avec un seul membre, vivante, et ses branches de l'autre retirées ;
  - `retirer le dernier membre la met à la corbeille`, ce membre restant dans sa liste ;
  - `supprimer partout un nœud d’une connexion de deux la jette, sans lui` ; `… d’une connexion de trois la garde à deux` ; `… d’une connexion d’un seul nœud la jette` ;
  - `retirer un nœud de son dernier plan le retire de ses connexions`, avec les mêmes trois cas ; `une annotation qui quitte son dernier plan garde ses connexions` ;
  - `jeter un nœud le retire aussi des connexions déjà à la corbeille` ;
  - `restaurer un nœud ne lui rend pas ses connexions` ;
  - `restaurer une connexion d’un membre vivant` revient, avec une branche dans chaque plan où ce nœud est placé ;
  - `restaurer une connexion sans membre` → `RESTORE_CONNECTION_LOST` ;
  - `restaurer une connexion dont tous les membres sont à la corbeille` → « Ses nœuds sont à la corbeille : restaure-les d’abord. ».
- [ ] **Step 2 : réécrire le test des quatre ordres** (`trash.test.ts:226-249`) selon D3 : quatre ordres × {[X, Y], [X, Y, Z]} × {`deleteEverywhere(X)`, `removeFromPlan(dernier plan de X)`}, croisés avec `restoreConnection(c)`, puis avec `addMember(c, X)`. Attendu : `dropped` vide ; X à la corbeille ; `c` sans X, ni branche ni fantôme de X ; à la corbeille pour [X, Y], vivante pour [X, Y, Z] ; l'état des deux PC identique (`encodeState` égaux).
- [ ] **Step 3 : les lancer**, `npm test -w packages/core -- single trash`. Attendu : ÉCHEC.
- [ ] **Step 4 : implémenter D2 (règle, `leaveConnections`, commandes, messages du cœur) puis D3 (`mergeMembers`, `rebaseUnit`).** L'avertissement de « Cacher » (`questions.ts:78`, `lastPlanNodes` d'`actions.ts`) compte les connexions qui partiraient ; son test dans `app/tests`. Mettre à jour l'oracle et les tests listés.
- [ ] **Step 5 : tout lancer**, `npm test -w packages/core && npm test -w packages/server && npm test -w packages/app`, dont les 2 000 commandes au hasard (`reconcile.test.ts`). Attendu : SUCCÈS.
- [ ] **Step 6 : commit**, `feat(core): une connexion peut n’avoir qu’un membre ; un nœud jeté quitte ses connexions, même en synchro croisée`.

### Task 4 : connexions à un membre, le dessin et le geste (D2)

**Files:**
- Modify : `packages/view/src/scene.ts:545`, `visibility.ts:793`, `geometry/bundle.ts:92-173`, `instances.ts` (`markerCores` :413, `writeComplex` :541), `clip.ts:57`, `params.ts` (`singleArmLength`, `singleArmAngle`, groupe « Connexions »), `connect.ts` (`connectTarget` :14)
- Modify : `packages/app/src/renderer/ui/graph/placement.ts:108-125`, `actions.ts:266` (`connectBuild`), `ui/graph/questions.ts:53-71`, `trash.ts:10-56`, `ui/TrashPanel.tsx:22-23`, `search/pick.ts:7`
- Test : `packages/view/tests/single.test.ts` (nouveau), `view/tests/scene.test.ts`, `app/tests/trash.test.ts`, scénario `connexion à un seul nœud` dans `packages/app/scripts/interface.mjs`

**Interfaces:**
- Consumes : `connect`, `setLayout` (tâche 3).
- Produces : `connectBuild(scene, from, target: ConnectTarget | { kind: 'alone'; at?: Vec }, everywhere): Build`.

- [ ] **Step 1 : tests qui échouent** (`view/tests/single.test.ts`) :
  - `une connexion d’un membre se montre là où son nœud est placé` : `buildScene` → une connexion, un marqueur ;
  - `son marqueur par défaut` est à `singleArmLength · f^k` du bord du nœud, dans la direction `singleArmAngle` (tolérance 1e-6) ;
  - `un marqueur épinglé est respecté` ; `il suit son nœud déplacé` (`layoutsFollowing`) ;
  - `le marqueur se touche` : `markerAt` au centre du marqueur la rend ;
  - `le glyphe dit le rôle` : source, une flèche au bout côté nœud ;
  - `copier son nœud la copie` (`clip.ts`) ;
  - `scene.test.ts:128` reste vert : deux membres et un seul présent, elle reste masquée avec son badge.
- [ ] **Step 2 : les lancer**, `npm test -w packages/view -- single scene`. Attendu : ÉCHEC.
- [ ] **Step 3 : implémenter le dessin**, par le chemin complexe : une seule extrémité. `M` vient du marqueur épinglé, sinon de la position par défaut. `u` va du bord vers `M`, et le marqueur est toujours dessiné (`multi` ou un drapeau `single`).
- [ ] **Step 4 : implémenter le geste et les messages côté app.** Dans `placement.ts`, un clic sur le fond (`intent.hit.kind === 'background'`) ou Entrée termine la connexion seule. Puis `connectBuild` avec `{ kind: 'alone', at }`. Mettre à jour `questions.ts`, `trash.ts`, `TrashPanel.tsx` et `pick.ts` (D2), et leurs tests (`app/tests/trash.test.ts:103-231`).
- [ ] **Step 5 : le scénario d'interface** `connexion à un seul nœud` :
  - clic droit sur un nœud → « Ajouter une connexion » → clic sur le fond ;
  - la base a une connexion d'un membre, dont le marqueur est épinglé au point du clic ;
  - Ctrl+Z la retire.
  - Ajuster le scénario de la corbeille (`interface.mjs:2410-2474`). Lancer `npm run interface -w packages/app -- connexion corbeille`. Attendu : SUCCÈS.
- [ ] **Step 6 : commit**, `feat(view, app): une connexion d’un seul nœud, un bras et son marqueur ; le geste se termine sur le fond`.

### Task 5 : la couleur d'un groupe (D4)

**Files:**
- Modify : `packages/view/src/color.ts` (`rgbToOklch`), `frame.ts:21` (`groupColors`), `scene.ts` (`SceneItem.color`, `nodeItem` :387), `sceneUpdate.ts` (`sameOwn` :99-101, copie :631-635), `params.ts` (`groupPaletteHues`, `groupPaletteChroma`), `menus.ts` (`groupColor`, « Couleur… »)
- Modify : `packages/app/src/renderer/actions.ts` (`groupColorBuild`), `ui/graph/menuActions.ts`, `ui/NodePopup.tsx` (section « Couleur dans ce plan », prop `plan`), `ui/panels/Panels.tsx:384`, `styles.css`
- Create : `packages/app/src/renderer/ui/GroupColorPicker.tsx`
- Test : `packages/view/tests/color.test.ts`, `frame.test.ts`, `menus.test.ts`, scénario `couleur d’un groupe`

**Interfaces:**
- Consumes : `setGroupColor`, `Placement.color` (tâche 1).
- Produces : `rgbToOklch(c: Rgb): { L: number; C: number; h: number }` ; `groupColorBuild(plan: Id, node: Id, color: string | null): Build` ; `GroupColorPicker(props: { x: number; y: number; color: string | null; params: RenderParams; onPick(color: string | null): void; onClose(): void })`.

- [ ] **Step 1 : tests qui échouent :**
  - `color.test.ts` → `rgbToOklch est l’inverse de oklchToRgb` dans la gamme, à 1e-3 près, sur 200 couleurs tirées ;
  - `frame.test.ts` → `un groupe coloré montre sa couleur exacte` (`closed` égal à `hexToRgb(color)` à 1/255 près) ; `ses sous-groupes en prennent la teinte, plus clairs ou plus sombres d’un pas` ; `un sous-groupe coloré l’emporte et transmet la sienne` ; `#000000, #ffffff et #00ff00 donnent des sous-groupes distincts du parent` (écart d'au moins 0,03 en L) ; `sans couleur, rien ne change` (comparaison au calcul d'avant) ;
  - `menus.test.ts` → « Couleur… » est au menu d'un groupe, pas d'un nœud simple ni d'une connexion ;
  - `params.test.ts` → les deux fiches nouvelles ; « Groupes » a 16 entrées.
- [ ] **Step 2 : les lancer.** Attendu : ÉCHEC.
- [ ] **Step 3 : implémenter le calcul et la scène** (une couleur de placement changée marque l'élément `reshaped`).
- [ ] **Step 4 : implémenter le sélecteur, l'entrée de menu et la section du pop-up.**
- [ ] **Step 5 : le scénario d'interface** `couleur d’un groupe` :
  - menu d'un groupe → « Couleur… » → troisième pastille → le placement du groupe porte `color` ;
  - « Automatique » le retire ;
  - Ctrl+Z le rend.
  - `npm run interface -w packages/app -- couleur`. Attendu : SUCCÈS.
- [ ] **Step 6 : commit**, `feat(view, app): la couleur d’un groupe, propre au plan — palette, couleur libre ou automatique`.

### Task 6 : les liens, l'aperçu, le clic droit et « Importer ici » (D5)

**Files:**
- Modify : `packages/app/src/renderer/ui/viewers/PdfViewer.tsx` (`PageProps` :502, le lien :650-656), `ui/latex/LatexSnippet.tsx`, `ui/latex/LatexField.tsx`, `ui/NodePopup.tsx`, `ui/ConnectionPopup.tsx`, `ui/panels/Panels.tsx`, `ui/viewers/Viewer.tsx`, `App.tsx` (`nodeLink` :455, `showIn` :464), `ui/GraphView.tsx` (`GraphHandle` :51-61, `importHere`), `packages/view/src/params.ts` (`linkPreviewDelayMs`)
- Create : `packages/app/src/renderer/ui/latex/LinkPreview.tsx`, `packages/app/src/renderer/links.ts` (logique pure : `linkMenu`)
- Test : `packages/app/tests/links.test.ts` (nouveau), scénario `lien : aperçu, menu, importer ici`

**Interfaces:**
- Produces :
  - le contexte `LinkActions = { onNode(id: Id): void; onHover(id: Id | null, rect: DOMRect | null): void; onMenu(id: Id, x: number, y: number): void }`, passé de `Panels` à `PdfPage` à la place du seul `onNode`, dans des refs stables comme aujourd'hui ;
  - `linkMenu(s, node: Id, here: Id, tabs: Id[]): { action: 'open' | 'here' | 'import' | `plan:${Id}`; label: string }[]` ;
  - `GraphHandle.importHere(node: Id): void`.

- [ ] **Step 1 : tests qui échouent** (`links.test.ts`) :
  - `linkMenu d’un nœud dans ce plan et le lobby` → `['open', 'here', 'plan:lobby']`, sans `import` ;
  - `linkMenu d’un nœud ailleurs` → `[…, 'import']`, avec les plans dans l'ordre de `elsewhere()` ;
  - `linkMenu d’un nœud jeté` → `['open']` ;
  - `l’aperçu attend linkPreviewDelayMs` (horloge simulée : rien à 399 ms, l'aperçu à 400 ms) ;
  - `l’aperçu ne vient pas si le pointeur part avant` ; `il disparaît quand son pop-up se démonte` (Review Focus 3).
- [ ] **Step 2 : les lancer**, `npm test -w packages/app -- links`. Attendu : ÉCHEC.
- [ ] **Step 3 : implémenter D5**, en faisant passer les trois rappels de `App` jusqu'à `PdfPage`.
- [ ] **Step 4 : le scénario d'interface :**
  - un nœud A dont le résumé fait `\ref` vers un nœud B, placé dans un autre plan ;
  - le survol du lien montre `.link-preview` avec le titre de B ;
  - clic droit → « Importer ici » → clic dans le graphe → B est placé dans le plan de A, et Ctrl+Z le retire.
  - `npm run interface -w packages/app -- lien`. Attendu : SUCCÈS.
- [ ] **Step 5 : commit**, `feat(app): un lien se prévisualise au survol ; son clic droit choisit le plan ou importe la cible`.

### Task 7 : les onglets de l'agenda et des feuillets (D6)

**Files:**
- Modify : `packages/app/src/renderer/tabs.ts` (`liveTabs` :23, ids `@agenda`, `@feuillets`), `ui/Tabs.tsx`, `App.tsx` (`view`, rendu :577-606, raccourci Ctrl+Maj+N près de :150-210), `packages/view/src/menus.ts` (`agenda`, `sheets`), `ui/graph/menuActions.ts`, `ui/graph/placement.ts` (`{ kind: 'sheet'; sheet: Id }`), `actions.ts` (`agendaBuild`, `sheetBuild`, `sheetToNodeBuild`), `packages/core/src/commands.ts` (`sheetToNode`), `packages/view/src/params.ts` (`sheetTypingPauseMs`), `styles.css`
- Create : `packages/app/src/renderer/agenda.ts` (pur : `agendaMonths`, `ageOf`), `ui/AgendaView.tsx`, `ui/SheetsView.tsx`, `packages/app/src/renderer/sheets.ts` (pur : `sheetNode(text): { title: string; summary: string }`)
- Test : `packages/app/tests/agenda.test.ts`, `packages/app/tests/sheets.test.ts`, `packages/core/tests/format2.test.ts`, scénarios `agenda` et `feuillets`

**Interfaces:**
- Consumes : `putAgendaEntry`, `deleteAgendaEntry`, `putSheet`, `deleteSheet` (tâche 1) ; l'index de recherche (titres) ; `goToNode` (App).
- Produces : `sheetToNode(s, sheet: Id, plan: Id, x: number, y: number, k: number): Action` ; `sheetNode(text: string): { title: string; summary: string }` ; `ageOf(at: number, now: number): string`.

- [ ] **Step 1 : tests qui échouent :**
  - `sheets.test.ts` → `sheetNode('\n  Idée  \nsuite 50% & co_x')` vaut `{ title: 'Idée', summary: 'suite 50\\% \\& co\\_x' }` ; un texte vide donne le titre « Feuillet » ; une première ligne de 300 caractères est coupée à 200 ;
  - `ageOf` → « à l’instant » (< 1 min), « il y a 5 min », « il y a 3 h », « il y a 2 j » (< 7 j), puis « 07/11/2026 » ;
  - `agenda.test.ts` → `agendaMonths` regroupe par mois, dans l'ordre des dates, et place la ligne d'aujourd'hui entre la veille et le lendemain ; un nœud lié jeté est marqué `gone: 'trash'`, un nœud disparu `gone: 'missing'` (Review Focus 4) ;
  - `liveTabs` garde `@agenda` et `@feuillets` et écarte un identifiant inconnu ;
  - `format2.test.ts` → `sheetToNode crée le nœud et retire le feuillet en une action`, et un Ctrl+Z rend le feuillet.
- [ ] **Step 2 : les lancer.** Attendu : ÉCHEC.
- [ ] **Step 3 : implémenter `sheetToNode`, la logique pure, puis les onglets et les deux vues**, avec le fantôme de « En faire un nœud » et le raccourci.
- [ ] **Step 4 : les scénarios d'interface :**
  - `agenda` : « + » → « Agenda » → « Nouvelle entrée » → titre « Réunion » → Entrée. La base a l'entrée du jour, et Ctrl+Z la retire ;
  - `feuillets` : Ctrl+Maj+N → taper « Idée » → attendre la pause. La base a le feuillet. « En faire un nœud » → clic dans le graphe : le nœud « Idée » est placé, et le feuillet a disparu.
  - `npm run interface -w packages/app -- agenda feuillets`. Attendu : SUCCÈS.
- [ ] **Step 5 : commit**, `feat(app): l’agenda et les feuillets, deux onglets ; Ctrl+Maj+N crée un feuillet, qui devient un nœud en une action`.

### Task 8 : l'envoi des consultations au serveur (D7)

Rigueur complète : serveur.

**Files:**
- Modify : `packages/server/src/tokens.ts` (`MIGRATIONS` v4 ; `putConsultations`, `consultationsUpto`, `seen`), `server.ts` (`routes` :316 ; erreurs :677-679), `bounds.ts` (`MAX_CONSULTATIONS_PER_REQUEST`, `MAX_CONSULTATIONS_BODY_BYTES`)
- Move : `parseConsultations` (`packages/app/src/main/consultations.ts:25`) dans `packages/core/src/consultations.ts`, pour que le serveur le partage
- Modify : `packages/app/src/main/consultations.ts` (`pending(after, max)`, table `sent`, `markSent`, `localSeen`), `main/sync/client.ts` (après `conn.open = true` :440 ; minuterie), `main/sync/wire.ts` et `preload/index.ts` (`cirrus:consultations:seen`), `main/index.ts:318`, `packages/view/src/params.ts` (`consultationsSendMs`)
- Test : `packages/server/tests/consultations.test.ts` (nouveau), `packages/app/tests/consultations.test.ts`

**Interfaces:**
- Produces : `POST /consultations`, `GET /consultations/upto`, `GET /consultations/seen` (D7) ; `window.cirrus.consultationsSeen(): Promise<[Id, number][]>`.

- [ ] **Step 1 : tests qui échouent :**
  - `server/tests/consultations.test.ts` :
    - `un lot s’écrit et rend upto` ;
    - `le même lot deux fois ne double rien` (le compte des lignes est inchangé, `upto` identique : Review Focus 5) ;
    - `un lot irrégulier est refusé en entier` (400, rien d'écrit) ;
    - `1 001 événements` → 413 ;
    - `sans jeton` → 401 ;
    - `seen rend la dernière consultation par sujet, tous PC confondus` : deux PC jumelés, et le plus récent l'emporte ;
    - `seen ignore app_open et plan_shown` ;
  - `app/tests/consultations.test.ts` :
    - `pending rend ce qui suit le dernier envoyé` ;
    - `markSent est par base` ;
    - `un envoi coupé reprend à upto` : un faux serveur répond une fois sans corps, puis `upto` ; rien n'est perdu ni doublé ;
    - `interrupteur éteint : rien ne part`.
- [ ] **Step 2 : les lancer**, `npm test -w packages/server -- consultations` et `npm test -w packages/app -- consultations`. Attendu : ÉCHEC.
- [ ] **Step 3 : implémenter le serveur, puis le PC, puis l'IPC de lecture.**
- [ ] **Step 4 : tout lancer**, serveur et app. Attendu : SUCCÈS.
- [ ] **Step 5 : commit**, `feat(server, app): les consultations partent au serveur par lots ; « vu » se lit pour tous les PC`.

### Task 9 : la santé du graphe (D8)

**Files:**
- Create : `packages/app/src/renderer/health.ts` (pur), `ui/HealthPanel.tsx`
- Modify : `packages/app/src/renderer/latex/registry.ts` (`citedNames(): { labels: [string, Origin[]][]; keys: [string, Origin[]][] }`, public, sur `citersIndex()`), `ui/graph/repercussion.ts:46-51` et `placement.ts:173` (journal de session `skippedPlans`), `ui/screens.ts` (`healthOpen`, exclusif), `packages/view/src/menus.ts` (`health`, « Santé du graphe… »), `ui/graph/menuActions.ts`, `App.tsx:595, 615-620`, `packages/view/src/params.ts` (`healthUnseenDays`), `styles.css`
- Test : `packages/app/tests/health.test.ts` (nouveau), scénario `santé du graphe`

**Interfaces:**
- Consumes : `LatexRegistry`, `conflictOriginal`, `effectiveTags`, `intruders`, `buildScene`, `consultationsSeen` (tâche 8), `destination`, `GraphHandle.reveal`.
- Produces :
  ```ts
  type HealthSection = 'broken' | 'doubles' | 'conflicts' | 'tags' | 'orphans' | 'unseen' | 'intruders' | 'skipped';
  interface HealthRow { section: HealthSection; kind: 'node' | 'connection' | 'plan'; id: Id; title: string; detail: string; key: string }
  function healthRows(s: State, registry: LatexRegistry, seen: ReadonlyMap<Id, number> | null, skipped: readonly SkippedPlan[], now: number, p: RenderParams): HealthRow[];
  class IntruderScan { constructor(s: State, plans: Id[], sceneOf: (plan: Id) => PlanScene); step(budgetMs: number): boolean; rows(): HealthRow[] }
  ```

- [ ] **Step 1 : tests qui échouent** (`health.test.ts`, sur une petite base construite pour chaque cas) :
  - `un \ref vers un label inconnu est une référence cassée` ; `un \cite vers une clé portée seulement par un nœud jeté aussi` ;
  - `deux \label égaux sont un doublon` ; `deux nœuds de même clé_bibtex aussi` ;
  - `une copie « (conflit du …) » avec son original est un conflit` ; `sans original, non` ;
  - `une clé obligatoire avec valeur par défaut, absente d’un nœud, le liste` ; `une clé de portée connexion ne liste pas les nœuds` ;
  - `un nœud sans connexion de connaissance est orphelin` ; `une inclusion seule ne compte pas` ; `une annotation n’est jamais orpheline` ;
  - `jamais revu` : un nœud créé il y a 31 jours sans consultation y est ; un nœud de 29 jours n'y est pas ; un nœud consulté non plus ; avec `seen === null`, la section est vide et le dit ;
  - `IntruderScan trouve l’intrus d’un plan, par tranches` : `step(0.001)` rend `false` jusqu'à la fin, puis `rows()` ;
  - `les plans ignorés d’une répercussion sont retenus, 200 au plus`.
- [ ] **Step 2 : les lancer**, `npm test -w packages/app -- health`. Attendu : ÉCHEC.
- [ ] **Step 3 : implémenter `health.ts`, `citedNames`, le journal des plans ignorés, puis le panneau.**
- [ ] **Step 4 : la mesure.** Sur la base de référence, par un test marqué lent ou par `npm run mesures -w packages/app -- sante` (sur le modèle de la recherche) : la médiane de `healthRows` sur trois passes doit rester sous 150 ms. La consigner au registre. Au-delà, passer les sections 1 à 6 par tranches, et le consigner aussi.
- [ ] **Step 5 : le scénario d'interface** `santé du graphe` :
  - menu du fond → « Santé du graphe… » → la section « Nœuds orphelins » liste un nœud de la base de test ;
  - un clic sur sa ligne le cadre (le plan montré et la caméra changent) ;
  - Échap ferme.
  - `npm run interface -w packages/app -- santé`. Attendu : SUCCÈS.
- [ ] **Step 6 : commit**, `feat(app): la santé du graphe — références, doublons, conflits, tags, orphelins, jamais revus, intrus et plans ignorés`.

### Task 10 : la spec, la suite entière et la clôture

**Files:**
- Modify : `2026-11-02-cirrus-design.md` :
  - 5.3 : « au moins un membre » ;
  - 5.5 et 8.4 : la couleur ;
  - 5.6 et 17 : agenda et feuillets ;
  - 7 : D2, D3 et la règle de synchro, qui remplace « attend le plan 6b » ;
  - 8.5 : le bras seul ;
  - 11 : le geste ;
  - 14 : D5 ;
  - 18.1 : D9 ;
  - 19 : les réglages nouveaux ;
  - 20 : D7, D8 ;
  - 24 : « Fait au plan 6b » et « Hors du plan 6b (plan 6c) ».
- Modify : le registre (clôture).

- [ ] **Step 1 : écrire les sections de la spec**, en « Fixé par le plan 6b », avec [C] pour les choix faits à l'exécution, comme au plan 6a.
- [ ] **Step 2 : la suite entière**, `npm test -w packages/core && npm test -w packages/view && npm test -w packages/store && npm test -w packages/server && npm test -w packages/app`. Attendu : SUCCÈS.
- [ ] **Step 3 : tous les scénarios d'interface**, `npm run interface -w packages/app`. Attendu : SUCCÈS, nouveaux compris.
- [ ] **Step 4 : la relecture finale** de tout le plan par un relecteur neuf (Opus), centrée sur la synchro (tâches 1, 3 et 8). Corriger, puis consigner au registre.
- [ ] **Step 5 : commit**, `docs: la spec après le plan 6b ; registre clos`. Puis dire à l'utilisateur ce qu'il doit essayer dans « Cirrus Dev » avant de pousser : une version qui change le format, donc une mise à jour forcée de chaque PC.
