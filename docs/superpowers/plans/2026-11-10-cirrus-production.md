# Cirrus, plan 9 : la mise en production — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Écrit le 2026-11-10, en l'absence de l'utilisateur**, qui a fixé l'ordre : plan 6a, puis plan 9, puis la saisie de ses données. Il s'exécute sans attendre son approbation, comme le veut le travail autonome. Ce qui demande l'utilisateur n'est pas fait sans lui, mais préparé et listé : louer la VM et le domaine, créer la clé de signature et la mettre dans les secrets de GitHub, faire le premier déploiement.

**Goal :** que Cirrus tourne pour de vrai :
- un serveur loué, en HTTPS, durci ;
- un installateur Windows construit et signé par GitHub à chaque push ;
- des mises à jour vérifiées et installées d'office ;
- une version de développement, « Cirrus Dev », qui ne peut pas abîmer les vraies données ;
- les fragilités de la synchro, notées « avant le plan 9 », réglées.

Hors de ce plan, vers avril 2027 : le dépôt figé de TeX Live sur le serveur.

**Architecture :**
- **Le serveur** reste le même programme Node, qui n'écoute que sur la machine. Caddy, devant lui, porte le HTTPS (certificat Let's Encrypt renouvelé seul) et le transmet tel quel. Un service systemd le lance ; un minuteur systemd le met à jour depuis les versions publiées sur GitHub.
- **L'installateur** est fait par electron-builder (NSIS, par utilisateur), dans une intégration continue GitHub. La CI signe un manifeste de la version (ed25519, `node:crypto`) avec la clé gardée dans les secrets de GitHub.
- **Les mises à jour :** l'app les demande au serveur avec son jeton (electron-updater, fournisseur générique), vérifie le manifeste signé avec la clé publique qu'elle porte, contrôle l'empreinte de l'installateur téléchargé, puis l'installe à la fermeture.
- **La première installation** passe par une page du serveur, ouverte par le code de jumelage.

**Tech Stack :** celle du plan 6a, plus electron-builder et electron-updater (les outils courants d'Electron) ; Caddy, systemd et ufw sur la VM (Debian ou Ubuntu LTS) ; GitHub Actions.

**Spec :** `C:\Users\alpha\Desktop\Cirrus\2026-11-02-cirrus-design.md`, sections 3, 18, 18.1 et 23.

**Carte du code :** `C:\Users\alpha\AppData\Local\Temp\claude\C--Users-alpha-Desktop-Cirrus\c00b2880-ac19-4a32-91f3-33431b25af52\scratchpad\carte-9.md`. Chaque implémenteur la lit pour sa partie.

## Décisions

Une décision non prévue ici se consigne au registre (`docs/superpowers/plans/2026-11-10-cirrus-production-registre.md`, créé à la tâche 1) sous la forme `Ruling:`, avec son coût si elle est fausse.

- **D1, le HTTPS par un mandataire, Caddy.**
  - Node garde son refus d'écouter ailleurs que sur la machine. Caddy reçoit le HTTPS sur le port 443, obtient et renouvelle seul son certificat Let's Encrypt, et transmet à `127.0.0.1:7310` en gardant l'en-tête `Host`.
  - Le serveur gagne `--nom <domaine>`, qui ajoute ce nom à la liste des hôtes admis. Rien d'autre ne lui fait confiance : il ne lit aucun `X-Forwarded-*`.
  - **Options écartées :**
    - le HTTPS dans Node, qui demande de recharger le certificat à chaque renouvellement ;
    - nginx plus certbot, deux outils au lieu d'un.
  - Le flux d'événements reçoit `X-Accel-Buffering: no` ; Caddy transmet déjà un flux `text/event-stream` sans le retenir.
  - Les délais du serveur sont fixés explicitement :
    - `headersTimeout` de 60 s ;
    - `requestTimeout` à 0 pour les envois de fichiers et de base, que bornent déjà leurs tailles ;
    - `keepAliveTimeout` de 65 s.
- **D2, la VM.**
  - **Le choix :** Hetzner CX23 (spec 18), Ubuntu 24.04 LTS, et un nom de domaine. L'utilisateur choisit le registraire.
  - **`deploy/installer-serveur.sh`,** lancé une fois par l'utilisateur en root, installe :
    - Node (la version que fixe le dépôt) et Caddy, depuis leurs dépôts officiels ;
    - un utilisateur système `cirrus` et le dépôt cloné dans `/opt/cirrus` ;
    - les données dans `/var/lib/cirrus` ;
    - les unités systemd ;
    - ufw (22, 80 pour le défi ACME, 443) ;
    - `unattended-upgrades` ;
    - SSH par clé seulement.
  - **Il est idempotent :** le relancer ne casse rien.
  - **Le serveur sur Linux :** son dossier par défaut devient `/var/lib/cirrus` (ou `$XDG_DATA_HOME/cirrus` hors root). Sous Windows, il reste `LOCALAPPDATA`.
  - **L'administration :** `jumeler`, `pcs` et `revoquer` se lancent par SSH : `sudo -u cirrus cirrus-serveur jumeler "Portable"`, par un petit script dans `/usr/local/bin`. `jumeler` affiche aussi l'adresse de la page de téléchargement (D5).
  - **Aucune sauvegarde** hors serveur (spec 18, refusée par l'utilisateur). Le guide signale les instantanés de Hetzner comme option payante.
- **D3, l'identité de l'app, et « Cirrus Dev ».**
  - **L'app officielle :**
    - elle a `productName` « Cirrus », un `appId` à elle, et une version (`package.json`, `0.1.0`, que la CI complète par son numéro de build : `0.1.<n>`) ;
    - **son dossier de données ne bouge pas :** elle fixe `userData` à `%APPDATA%\@cirrus\app`, là où est déjà la base de l'utilisateur. Changer de nom l'y aurait fait disparaître [C].
  - **« Cirrus Dev »** est une variante de construction (`npm run paquet:dev`) avec :
    - son nom ;
    - son `appId` ;
    - son `userData` (`%APPDATA%\@cirrus\app-dev`) ;
    - son verrou d'instance unique ;
    - son icône (marquée « DEV »).

    Elle partage TinyTeX, dont les installations ne font qu'ajouter.
  - **Une version de développement** ne parle au vrai serveur que si ses formats sont identiques. C'est déjà le cas : le refus 409 de `/hello`.
- **D4, les mises à jour signées.**
  - **La clé :** une paire ed25519.
    - La clé publique est dans le code de l'app (`main/update/key.ts`).
    - La clé privée est dans le secret GitHub `CIRRUS_SIGNING_KEY`.
    - `deploy/cle-de-signature.mjs` crée la paire ; l'utilisateur le lance une fois.
  - **Le manifeste :** `version.json { version, file, sha512, size, date }`, signé (`version.json.sig`) par la CI. electron-updater s'appuie sur `latest.yml`, que la CI produit aussi ; mais la confiance vient du seul manifeste signé.
  - **Au serveur :** les routes `GET /versions/version.json`, `/versions/version.json.sig` et `/versions/<installateur>` exigent le jeton. `/hello` gagne la version officielle qu'il sert (`version`).
  - **À l'app :**
    1. Au branchement, si la version officielle est plus récente que la sienne, ou si le serveur refuse son format, l'app télécharge `version.json` et sa signature.
    2. Elle vérifie la signature avec sa clé publique. Un échec : rien n'est installé, et une notification le dit.
    3. Elle laisse electron-updater télécharger l'installateur, avec le jeton en en-tête.
    4. Elle compare l'empreinte sha512 du fichier téléchargé à celle du manifeste signé.
    5. Elle l'installe à la fermeture, en silence, puis l'app se relance.

    Une app plus récente, ou de développement, n'est jamais ramenée en arrière (spec 18.1).
  - **Ce qui est dit à l'utilisateur :** la pastille dit « Mise à jour prête : elle s'installera à la fermeture. ». Un format refusé dit déjà « mets à jour Cirrus » ; la mise à jour s'y fait seule.
  - **Option écartée :** la signature de code Windows (Authenticode), un certificat payant. Sans elle, Windows SmartScreen avertit à la première installation. Le guide le dit.
- **D5, la page de téléchargement.**
  - `GET /installer` rend une page HTML minimale :
    - un champ pour le code et un bouton ;
    - sans script ;
    - avec une CSP stricte (`default-src 'none'; style-src 'unsafe-inline'; form-action 'self'`).
  - `POST /installer` (formulaire, `application/x-www-form-urlencoded`, 4 Kio au plus) vérifie le code comme `/pair` :
    - un essai faux compte contre chaque code en attente (`PAIRING_TRIES`) ;
    - le code n'est pas consommé ;
    - un code bon renvoie l'installateur de la version officielle, et un code faux la page, avec « Code inconnu ou expiré. ».
  - Ce sont les deux seules routes sans jeton avec `/pair`. Elles passent le même contrôle de `Host`.
- **D6, la CI.**
  - **Le déclencheur :** `.github/workflows/version.yml`, à chaque push sur `main`, sur `windows-latest`.
  - **Les étapes :**
    1. `npm ci` ;
    2. `tsc` sur chaque paquet ;
    3. les tests de core, store, fixtures, view, server et sources. Ceux de l'app tournent sans TinyTeX, et les tests de LaTeX se sautent ;
    4. `electron-vite build`, puis electron-builder (`--win nsis --publish never`), à la version `0.1.<run_number>` ;
    5. la signature du manifeste avec `CIRRUS_SIGNING_KEY` ;
    6. une version publiée sur GitHub (`v0.1.<n>`), avec l'installateur, `latest.yml`, `version.json` et sa signature.
  - **Sans le secret,** la CI construit et teste, mais ne publie rien. Le résumé de la CI le dit.
  - **Le serveur se met à jour** (`deploy/mettre-a-jour.sh`, minuteur systemd, chaque heure) :
    1. il lit la dernière version publiée par l'API de GitHub ;
    2. si elle est nouvelle, il en télécharge les fichiers dans `/var/lib/cirrus/versions/`, et vérifie la signature du manifeste avec la clé publique du dépôt ;
    3. il se place au tag dans `/opt/cirrus`, fait `npm ci --omit=dev`, et relance le service.

    Ses propres migrations se font au démarrage, comme aujourd'hui. Un échec garde la version d'avant.
- **D7, la robustesse de la synchro sur Internet** (spec 23 ; registre du plan 5a).
  - **Les délais :**
    - chaque requête du PC au serveur a un délai, le réglage `syncRequestTimeoutMs` (30 s) ;
    - les envois de fichiers ont un délai d'inactivité, et non un délai total ;
    - un flux d'événements qui ne reçoit plus rien pendant deux pings (`2 × 15 s`, plus une marge) est tenu pour coupé : la reconnexion repart.
  - **Les lots :** les écritures reçues sont traitées par lots bornés, `syncReceiveMaxUnits` (500), en plusieurs transactions si un retard est grand.
  - **L'horloge :** l'écart d'horloge mesuré est gardé dans `serveur.json` et repris au branchement suivant.
  - **Laissés pour plus tard,** mesurés comme acceptables pour un seul utilisateur et une petite base :
    - l'envoi des fichiers un par un au premier jumelage ;
    - l'import de la base dans le traitement de la requête (A1) ;
    - l'écriture synchrone d'un PDF importé ;
    - la marge de mémoire du lecteur ;
    - une adresse qui ne répond pas, qui consomme tout le délai.
- **D8, le durcissement de l'app.**
  - Le banc n'est branché qu'en mode banc : `wireBench`, l'exposition du préchargement, l'import de `@cirrus/fixtures`. L'app livrée ne l'embarque pas.
  - `session.setPermissionRequestHandler` refuse tout : caméra, micro, notifications, géolocalisation… Cirrus n'en demande aucune.
  - `pcs` affiche les noms de PC sans caractères de contrôle.
  - Un `PUT /files` dont le corps dépasse `MAX_FILE_BYTES` en cours de route reçoit 413.

**Ce que l'utilisateur fera, listé dans `deploy/LISEZ-MOI.md` :**
1. Louer la VM et le domaine, et faire pointer le domaine vers la VM.
2. Lancer `deploy/cle-de-signature.mjs`, et mettre la clé privée dans les secrets du dépôt GitHub. La clé publique est déjà dans le code, ou s'y met par un commit que le script prépare.
3. Copier et lancer `installer-serveur.sh` sur la VM.
4. Envoyer sa base depuis son PC, par le jumelage habituel, avec l'adresse `https://` du domaine.
5. Installer Cirrus sur ses autres PC par la page de téléchargement.

## Global Constraints

- **Les contraintes des plans précédents :**
  - `main` sans branche ;
  - les agents font leurs commits, le contrôleur pousse ;
  - commits en français, terminés par `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` ;
  - syntaxe effaçable ;
  - identifiants et commentaires en anglais, textes de l'interface en français ;
  - toute constante d'interaction ou de synchro est un réglage de `RenderParams` ;
  - les bornes du serveur sont dans `bounds.ts`.
- **Nouveaux réglages,** tous avancés :
  - `syncRequestTimeoutMs` : 30 000, de 5 000 à 600 000 ;
  - `syncStreamSilenceMs` : 40 000, de 20 000 à 600 000 ;
  - `syncReceiveMaxUnits` : 500, de 50 à 10 000 ;
  - `updateCheckMs` : 3 600 000, de 300 000 à 86 400 000.
- **Sécurité** (« ne transige pas, mais pas overkill ») :
  - aucune clé privée dans le dépôt ;
  - aucune route nouvelle sans jeton, hors `/installer` (D5) ;
  - toute entrée est vérifiée avant toute écriture ;
  - un manifeste à la signature fausse n'installe rien.
- **La base de l'utilisateur ne bouge pas :** `userData` reste `%APPDATA%\@cirrus\app`.
- **Les tests et les captures :**
  - jamais Internet, hors les outils de construction ;
  - jamais la base de l'utilisateur ;
  - une seule exécution d'Electron à la fois ;
  - pendant une tâche, seuls les scénarios d'interface qui la concernent ; tous les scénarios et toutes les captures une fois, en fin de tâche ;
  - les scripts shell sont vérifiés par `bash -n`, et par shellcheck s'il est installé.
- **Rien ne s'exécute hors de la machine de l'utilisateur.** Aucun agent ne se connecte à une VM ni ne crée de secret GitHub. Le premier passage de la CI aura lieu au push qui l'ajoute : il doit construire et tester sans publier, faute de secret.
- **Le processus :** une relecture par tâche, au plus un tour de correction. Les tâches 1, 4 et 5 gardent toute la rigueur.

## Review Focus

1. **Le serveur derrière Caddy :**
   - un `Host` inattendu ;
   - un flux d'événements retenu par le mandataire ;
   - un envoi de 1 Gio lent ;
   - un redémarrage pendant un envoi.

   Tout est refusé ou repris proprement. Testé à la tâche 1.
2. **Une mise à jour hostile :**
   - un manifeste à la signature fausse ;
   - un installateur dont l'empreinte diffère ;
   - une version plus ancienne présentée comme nouvelle ;
   - un serveur qui ment sur sa version.

   Rien n'est installé, et la notification le dit. Testé à la tâche 4.
3. **Un réseau qui se dégrade :**
   - un serveur qui ne répond plus sans couper ;
   - un flux silencieux ;
   - un retard de 50 000 écritures.

   La pastille finit par dire « Hors ligne », la reconnexion repart, et la mémoire reste bornée. Testé à la tâche 2.
4. **« Cirrus Dev » et l'app officielle sur le même PC.** Leurs données, leurs verrous et leurs jetons restent séparés. La version de développement d'un autre format ne touche jamais au vrai serveur. Testé à la tâche 3.
5. **La page de téléchargement attaquée :**
   - des codes devinés ;
   - un corps énorme ;
   - un `Host` étranger ;
   - une injection dans la page.

   C'est refusé, les essais sont comptés, et aucun installateur ne sort sans un bon code. Testé à la tâche 5.

---

### Task 1 : Le serveur prêt pour Internet

**Files :** `packages/server/src/main.ts`, `server.ts`, `events.ts`, `bounds.ts`, `tokens.ts` (l'affichage de `pcs`), les tests du serveur ; le registre du plan.

**Interfaces (Produces) :**
- `ServerOptions.names?: string[]` : les noms admis en plus de la machine. La ligne de commande gagne `--nom <domaine>`, répétable.
- Le dossier par défaut suit le système : `LOCALAPPDATA` sous Windows ; `/var/lib/cirrus` pour root, sinon `$XDG_DATA_HOME/cirrus`, sous Linux.
- `jumeler` affiche `https://<nom>/installer` quand un `--nom` est donné, ou que `CIRRUS_NOM` est fixé.
- Le serveur HTTP reçoit des délais explicites (D1), et le flux d'événements l'en-tête `X-Accel-Buffering: no`.
- Un corps de `PUT /files` qui dépasse la borne en cours de route reçoit 413, sans écriture.

- [ ] **Step 1 : tests (toute la rigueur).**
  - un `Host` égal au nom admis, accepté ; un autre, refusé ;
  - le dossier par défaut selon le système, la plateforme étant injectée ;
  - l'adresse affichée par `jumeler` ;
  - le 413 en cours de route ;
  - `pcs` sans caractères de contrôle ;
  - l'en-tête du flux ;
  - les délais posés.
- [ ] **Step 2 :** lancer, puis voir l'échec.
- [ ] **Step 3 :** implémenter.
- [ ] **Step 4 :** la suite du serveur et `tsc`.
- [ ] **Step 5 :** créer le registre. Commits.

### Task 2 : La synchro sur un réseau réel

**Files :** `packages/app/src/main/sync/connection.ts`, `client.ts`, `events.ts` du principal, `config.ts` (l'écart d'horloge gardé), `downloads.ts` et `uploads.ts` (délai d'inactivité), `renderer/ui/settings/ServerBlock.tsx` (l'adresse proposée vide, avec le texte d'aide « https://cirrus.mondomaine.fr ») ; `packages/view/src/params.ts` ; les tests.

**Interfaces (Produces) :**
- `conn.request(path, init, opts?: { timeoutMs?: number })` : par défaut `syncRequestTimeoutMs`.
- Le flux tenu pour coupé après `syncStreamSilenceMs` sans rien recevoir.
- `syncReceiveMaxUnits` par lot.
- `ServerConfig.clockOffsetMs?: number`.

- [ ] **Step 1 : tests.**
  - un serveur qui ne répond plus, sans couper : le délai, « Hors ligne », puis la reconnexion ;
  - un flux silencieux : la reconnexion ;
  - un retard de 50 000 écritures : traité en lots, la mémoire bornée ;
  - l'écart d'horloge repris ;
  - le message d'une adresse invalide, qui nomme https.
- [ ] **Step 2 :** lancer, puis voir l'échec.
- [ ] **Step 3 :** implémenter.
- [ ] **Step 4 :** les suites et `tsc`, puis les scénarios de synchro.
- [ ] **Step 5 :** commits.

### Task 3 : L'identité de l'app, « Cirrus Dev », et le durcissement

**Files :**
- Create : `packages/app/electron-builder.yml` (avec ses variantes), `packages/app/build/icon.ico` et `icon-dev.ico` (faites par un script à partir d'un SVG simple), `main/identity.ts`.
- Modify : `main/index.ts` (`userData` fixé, nom, verrou, `AppUserModelId`, le banc seulement en mode banc, les permissions refusées), `preload/index.ts`, `main/latex/tinytex.ts` (TinyTeX partagé), `packages/app/package.json` (version, `paquet`, `paquet:dev`).

**Interfaces (Produces) :**
- `appIdentity(env): { name: 'Cirrus' | 'Cirrus Dev'; userData: string; appId: string; dev: boolean }`, décidée par une variable fixée à la construction (`CIRRUS_VARIANT`).
- `npm run paquet -w packages/app` produit `dist/Cirrus Setup <version>.exe`, et `paquet:dev` « Cirrus Dev ».

- [ ] **Step 1 : tests.**
  - `appIdentity`, pour chaque variante : l'officielle garde `%APPDATA%\@cirrus\app` ;
  - le banc absent hors mode banc ;
  - le gestionnaire de permissions qui refuse tout.
- [ ] **Step 2 :** lancer, puis voir l'échec.
- [ ] **Step 3 :** implémenter.
- [ ] **Step 4 :**
  - les suites ;
  - `npm run paquet` produit un installateur ;
  - l'app installée par lui, lancée en arrière-plan sur une base de test (`CIRRUS_DATA`), s'ouvre ;
  - les scénarios et les captures, inchangés.
- [ ] **Step 5 :** commits.

### Task 4 : Les mises à jour signées

**Files :**
- Create : `deploy/cle-de-signature.mjs`, `packages/app/scripts/signer-version.mjs` (pour la CI), `main/update/` (`key.ts`, `manifest.ts`, `updater.ts`), les tests.
- Modify : `packages/server/src/server.ts` (routes `/versions/*`, `version` dans `/hello`), `bounds.ts` ; `main/sync/*` (la version officielle reçue) ; la pastille (« Mise à jour prête… ») ; `packages/app/package.json` (electron-updater).

**Interfaces (Produces) :**
- `verifyManifest(json: string, sig: string, publicKey: string): Manifest | null` (ed25519, `node:crypto`).
- `checkInstaller(path: string, m: Manifest): Promise<boolean>` (sha512).
- `Updater` : il demande, vérifie, laisse electron-updater télécharger avec le jeton, contrôle l'empreinte, et arme l'installation à la fermeture.
- Le serveur sert `/versions/` depuis `<data>/versions/`, avec le jeton.

- [ ] **Step 1 : tests (toute la rigueur).**
  - une signature bonne ; fausse ; un manifeste modifié ;
  - un installateur à l'empreinte fausse ;
  - une version plus ancienne, ou égale ;
  - une app de développement, jamais ramenée en arrière ;
  - les routes sans jeton, 401 ;
  - `/hello` qui donne la version.

  Une clé de test est faite dans le test, jamais dans le dépôt.
- [ ] **Step 2 :** lancer, puis voir l'échec.
- [ ] **Step 3 :** implémenter.
- [ ] **Step 4 :** les suites et `tsc`. Un essai de bout en bout local :
  1. deux installateurs construits, `0.1.1` puis `0.1.2`, signés avec une clé de test ;
  2. un serveur local qui sert le second ;
  3. l'app `0.1.1` installée, sur une base de test, le trouve, le vérifie et l'arme.
- [ ] **Step 5 :** commits.

### Task 5 : La page de téléchargement

**Files :** `packages/server/src/server.ts` (routes `/installer`), `installer.ts` (la page), `tokens.ts` (le code vérifié sans être consommé), `bounds.ts`, les tests.

- [ ] **Step 1 : tests (toute la rigueur).**
  - la page, et sa CSP ;
  - un bon code : l'installateur, le code non consommé, `/pair` marche ensuite ;
  - un code faux : la page avec le message, l'essai compté ;
  - cinq faux : les codes brûlés ;
  - un corps trop gros ;
  - un `Host` étranger ;
  - une valeur qui tente une injection dans la page, échappée.
- [ ] **Step 2 :** lancer, puis voir l'échec.
- [ ] **Step 3 :** implémenter.
- [ ] **Step 4 :** la suite du serveur et `tsc`.
- [ ] **Step 5 :** commits.

### Task 6 : La CI, le déploiement et le guide

**Files :**
- Create :
  - `.github/workflows/version.yml` ;
  - `deploy/installer-serveur.sh` ;
  - `deploy/mettre-a-jour.sh` ;
  - `deploy/Caddyfile.modele` ;
  - `deploy/cirrus-serveur.service`, `cirrus-maj.service` et `cirrus-maj.timer` ;
  - `deploy/cirrus-serveur` (le script d'administration par SSH) ;
  - `deploy/LISEZ-MOI.md`, le guide en français.

- [ ] **Step 1 : vérifications.**
  - `bash -n` sur chaque script, et shellcheck s'il est installé ;
  - la CI validée par `actionlint` s'il est installé, sinon relue ;
  - le guide relu contre les scripts : chaque commande qu'il cite existe.
- [ ] **Step 2 :** écrire les scripts et la CI.
- [ ] **Step 3 :** les scripts de mise à jour et d'installation se testent dans une simulation locale, sous Git Bash, avec des fonctions remplacées par des variables d'environnement. À défaut, la relecture fait foi, consignée.
- [ ] **Step 4 :** le push qui ajoute la CI la déclenche. Le contrôleur regarde son résultat : construite et testée, rien de publié faute de secret.
- [ ] **Step 5 :** commits.

### Task 7 : La spec et la clôture

- [ ] **Step 1 :** tous les scénarios d'interface et toutes les captures.
- [ ] **Step 2 :** la spec. Inscrire ce qui a été fixé (« Fixé par le plan 9 ») aux sections 3, 18, 18.1 et 23. Retirer de la section 24 ce qui est fait, et y laisser le dépôt figé de TeX Live (avril 2027) et ce que D7 laisse pour plus tard.
- [ ] **Step 3 :** le registre ; la liste des actions de l'utilisateur, recopiée dans le message final.
- [ ] **Step 4 :** commits.
