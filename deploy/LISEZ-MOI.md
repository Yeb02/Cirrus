# Cirrus sur ton serveur : le guide

Ce guide te mène d'une VM vide à un Cirrus qui tourne sur ton propre serveur, en HTTPS, avec tes PC jumelés et des mises à jour qui arrivent seules. Compte une heure, dont la moitié à attendre (le DNS, la CI).

Partout ci-dessous, remplace `cirrus.mondomaine.fr` par ton domaine.

## Ce qu'il te faut

- une VM sous Ubuntu 24.04 LTS, avec une IPv4 publique : un VPS d'entrée de gamme suffit (1 à 2 vCPU, 2 Go de mémoire), chez OVHcloud (« VPS ») ou Hetzner Cloud (CX23). **Un hébergement web mutualisé ne convient pas**, même avec SSH : Cirrus a besoin d'un service qui tourne en permanence, de ses propres ports et des droits root ;
- un nom de domaine, chez le registraire de ton choix (environ 10 € par an) ;
- ton compte GitHub, avec les droits sur `Yeb02/Cirrus` ;
- sur ton PC : le dépôt cloné, Node 26, et un terminal (PowerShell).

## 1. Une clé SSH

Le serveur ne s'ouvre que par une clé SSH, jamais par un mot de passe.

Si tu n'en as pas déjà une, dans PowerShell :

```
ssh-keygen -t ed25519
```

Accepte le chemin proposé ; une phrase de passe est conseillée. Ta clé publique est la ligne « ssh-ed25519 AAAA… » du fichier `C:\Users\<toi>\.ssh\id_ed25519.pub`. C'est la seule que tu donnes ; l'autre fichier, sans `.pub`, ne quitte jamais ton PC.

## 2. Louer la VM

**Chez OVHcloud :** dans l'espace client, commande un **VPS** (pas un hébergement web) :

- **Image :** Ubuntu 24.04.
- **Clé SSH :** colle ta clé publique quand la commande la propose. OVHcloud crée le compte `ubuntu`, qui entre par ta clé et passe root par `sudo`. Sans clé donnée, il t'envoie un mot de passe par e-mail : donne alors ta clé au script (étape 5).
- **Sauvegardes :** en option payante (voir « Les limites »).

Une fois le VPS livré, son IPv4 (et son IPv6) sont dans **Bare Metal Cloud › VPS**.

**Chez Hetzner Cloud :** « Add Server », image Ubuntu 24.04, type CX23, IPv4 et IPv6 publiques, et ta clé dans **SSH keys** : tu entres alors en `root` par ta clé, et les commandes de l'étape 5 se passent de `sudo`.

Note l'IPv4 et l'IPv6 de la VM.

## 3. Le domaine et le DNS

Dans la zone DNS de ton domaine, chez ton registraire (chez OVHcloud : **Web Cloud › Noms de domaine › ton domaine › Zone DNS**) :

- un enregistrement **A** : `cirrus` vers l'IPv4 de la VM ;
- un enregistrement **AAAA** : `cirrus` vers son IPv6. Il est facultatif, mais s'il existe, il doit être juste : Let's Encrypt le préfère à l'IPv4.

Il ne doit rester aucun autre A, AAAA ni CNAME pour `cirrus`. Si tu as ajouté le sous-domaine à ton hébergement web (OVHcloud : **Multisite**), retire-le de là : il a créé des enregistrements vers l'hébergement, qui enverraient une partie des visites et Let's Encrypt ailleurs que sur la VM.

Depuis ton PC, `nslookup cirrus.mondomaine.fr` doit donner les adresses de la VM. Cela prend de quelques minutes à quelques heures.

## 4. La clé de signature des versions

GitHub construit et signe chaque version de Cirrus avec une clé que tu crées une fois. Tes PC et ton serveur n'installent que ce qu'elle signe. Fais-la **avant** d'installer le serveur : tant que le code porte la clé provisoire, le serveur n'installe aucune version.

1. Sur ton PC, dans le dossier du dépôt, dans un terminal (pas dans un fichier ni un tube : le script refuse) :

   ```
   node deploy/cle-de-signature.mjs
   ```

   Il écrit la clé publique dans `packages/app/src/main/update/key.ts`, et affiche la clé privée, de `-----BEGIN PRIVATE KEY-----` à `-----END PRIVATE KEY-----`.
2. Sur GitHub, dans le dépôt : **Settings › Secrets and variables › Actions › New repository secret**. Nom : `CIRRUS_SIGNING_KEY` ; valeur : la clé privée, tout compris, de BEGIN à END. Ne la garde nulle part ailleurs, ne la colle dans aucun message.
3. Commite et pousse la clé publique :

   ```
   git add packages/app/src/main/update/key.ts
   git commit -m "La clé publique des mises à jour"
   git push
   ```

4. Ce push lance la CI (onglet **Actions**, « Version »). Une demi-heure plus tard environ, une version `v0.1.<n>` apparaît dans **Releases**, avec l'installateur, `latest.yml`, `version.json` et `version.json.sig`. Si aucune n'apparaît (le secret ajouté après le push, une publication ratée) : **Actions › Version › Run workflow**, sur `main`.

Sans le secret, la CI construit et teste chaque push, mais ne publie rien, et son résumé le dit : « Pas de clé de signature : version construite et testée, rien n'est publié. »

Ne refais pas la clé (`--remplacer`) sans raison grave : les Cirrus installés refuseraient toute version signée par la nouvelle, et il faudrait les réinstaller un par un par la page de téléchargement.

## 5. Installer le serveur

Une fois la première version publiée :

```
ssh ubuntu@<IPv4 de la VM>
curl -fsSLO https://raw.githubusercontent.com/Yeb02/Cirrus/main/deploy/installer-serveur.sh
sudo bash installer-serveur.sh cirrus.mondomaine.fr
```

(Chez Hetzner : `ssh root@…`, et la commande sans `sudo`.)

Si tu n'as pas donné ta clé à la commande du VPS (tu es entré par un mot de passe), donne-la en second argument, entre guillemets :

```
sudo bash installer-serveur.sh cirrus.mondomaine.fr "ssh-ed25519 AAAA… toi@ton-pc"
```

Le script refuse de couper les mots de passe tant qu'aucune clé n'est autorisée. Il ne vérifie pourtant que la forme de la clé, pas qu'elle t'ouvre une session : la vérification est à faire toi-même, à la fin (ci-dessous). Il installe :

- Node 26 (depuis NodeSource) et Caddy (depuis son dépôt), git ;
- l'utilisateur système `cirrus`, et le dépôt dans `/opt/cirrus`, à sa dernière version publiée ;
- les données dans `/var/lib/cirrus`, que seul `cirrus` lit ; les versions servies dans `/var/lib/cirrus-maj`, que seul root écrit ;
- le service `cirrus-serveur`, et sa mise à jour chaque heure (`cirrus-maj.timer`) ;
- Caddy, qui porte le HTTPS et obtient seul son certificat Let's Encrypt ;
- le pare-feu (ufw) : 22, 80 et 443, rien d'autre ;
- les mises à jour de sécurité automatiques, avec un redémarrage à 4 h 30 quand un noyau l'attend ;
- SSH par clé seulement.

**Avant de fermer ta session SSH**, ouvre un second terminal sur ton PC et vérifie que tu entres encore :

```
ssh ubuntu@<IPv4 de la VM>
```

Si ce second terminal est refusé, ne ferme pas le premier : depuis lui, rends les mots de passe à SSH, puis règle ta clé et relance le script.

```
sudo rm /etc/ssh/sshd_config.d/00-cirrus.conf
sudo systemctl reload ssh
```

Le script finit par la liste de ce qui suit. Tu peux le relancer sans rien casser : `sudo bash /opt/cirrus/deploy/installer-serveur.sh cirrus.mondomaine.fr`. C'est aussi ainsi que tu remets le serveur sur la dernière version, ou que tu changes de domaine.

## 6. Vérifier

Sur la VM :

- `systemctl status cirrus-serveur` dit « active (running) » ;
- `journalctl -u cirrus-serveur -e` montre « Serveur Cirrus : http://127.0.0.1:7310 … » ;
- `journalctl -u caddy -e` montre que le certificat est obtenu (« certificate obtained successfully ») ;
- `journalctl -u cirrus-maj -e` finit par « Cirrus 0.1.<n> est en place. » ;
- `systemctl list-timers cirrus-maj.timer` dit quand passe la prochaine mise à jour.

Sur ton PC, `https://cirrus.mondomaine.fr/installer` montre la page « Cirrus : installer », avec le cadenas.

## 7. Le premier PC : il envoie sa base

C'est le PC qui a ta base. Sur la VM :

```
cirrus-serveur jumeler "Fixe"
```

Il affiche un code de jumelage, valable 10 minutes pour un seul PC, et l'adresse de la page de téléchargement.

Si Cirrus n'est pas encore installé sur ce PC par un installateur (tu le lances depuis le dépôt), installe-le d'abord par la page, comme à l'étape 8. L'app installée retrouve ta base : elle garde son dossier, `%APPDATA%\@cirrus\app`.

Si ce PC est encore jumelé à un serveur local d'essai, **Réglages › Serveur** montre ce jumelage au lieu du formulaire : **Dissocier ce PC** d'abord. Cela marche même le serveur local éteint, et ta base reste sur ce PC.

Puis, dans Cirrus, **Réglages › Serveur** :

- **Adresse du serveur :** `https://cirrus.mondomaine.fr` ;
- **Code de jumelage :** le code ;
- **Nom de ce PC :** comme tu veux ;
- **Jumeler.**

Cirrus propose « Envoyer la base de ce PC au serveur (… nœuds, … fichiers) » : c'est ce que tu veux. Le serveur prend la base et ses fichiers ; une grosse base prend un moment.

## 8. Les autres PC

Sur la VM, un code par PC :

```
cirrus-serveur jumeler "Portable"
```

Sur le nouveau PC :

1. Ouvre `https://cirrus.mondomaine.fr/installer`, tape le code, « Télécharger l'installateur ». Le code n'est pas consommé : il sert encore au jumelage.
2. Lance l'installateur. **Windows SmartScreen avertit**, car l'installateur n'est pas signé par un certificat de Windows (payant, écarté) : « Windows a protégé votre ordinateur ». Clique **Informations complémentaires**, puis **Exécuter quand même**. Si Edge retient le fichier (« n'est pas fréquemment téléchargé »), choisis « … », **Conserver**, puis **Conserver quand même**.
3. L'installateur ne demande rien : il installe Cirrus pour toi seul, sans droits d'administrateur, dans `%LOCALAPPDATA%\Programs\cirrus`, puis l'ouvre.
4. Dans Cirrus, **Réglages › Serveur** : l'adresse, **le même code** (dans ses 10 minutes), le nom de ce PC, **Jumeler**. Le PC prend la base du serveur.

Cinq codes faux, tapés sur la page ou dans Cirrus, brûlent les codes en attente : refais `cirrus-serveur jumeler`.

## 9. Les mises à jour

Tu n'as rien à faire :

1. **Chaque push sur `main`** qui change autre chose que `docs/` ou des fichiers `.md` : la CI construit Cirrus, le teste, signe son manifeste et publie `v0.1.<n>`. Un push qui ne change que la documentation ne fait pas de version.
2. **Dans l'heure, le serveur** la prend. Il vérifie la signature avec la clé du code qu'il fait tourner, puis l'empreinte de l'installateur. Il passe son code au tag de la version, copie ses bases et redémarre, puis sert le nouvel installateur. Il ne revient jamais en arrière.
   - Un échec avant le redémarrage (un téléchargement, une vérification, `npm ci`) laisse la version d'avant en place, et l'heure suivante réessaie.
   - Si le nouveau serveur ne répond pas dans la minute, ses bases d'avant et le code d'avant sont remis et relancés. Cette version n'est plus essayée ; la suivante le sera.
3. **Chaque PC ouvert**, à sa connexion suivante ou dans l'heure, vérifie la signature de la nouvelle version, puis la met à jour d'office :
   - un écran bloque Cirrus : « Mise à jour de Cirrus vers 0.1.<n> », « Téléchargement… », avec la progression ;
   - l'installateur téléchargé et vérifié, l'écran dit « Enregistrement, puis redémarrage… » : Cirrus enregistre tout, comme quand tu le fermes, puis se ferme, s'installe et se relance seul. Tu n'as rien à cliquer ;
   - si le téléchargement échoue (le réseau), l'écran le dit et propose « Continuer sans mettre à jour » ; la vérification suivante recommence, et l'écran revient.

**Chaque version publiée redémarre donc les PC ouverts**, au plus une fois par heure, au rythme de la mise à jour du serveur (`cirrus-maj.timer`). Pour ne pas être interrompu, pousse sur `main` quand tu ne travailles pas.

Une version refusée, signature fausse ou installateur différent, ne s'installe nulle part : le PC le dit par une notification, et le serveur dans son journal. Une fausse annonce ne bloque jamais Cirrus : l'écran n'apparaît qu'une fois la signature vérifiée. « Cirrus Dev » ne se met jamais à jour.

Pour voir la dernière mise à jour du serveur, ou la lancer tout de suite :

```
journalctl -u cirrus-maj -e
systemctl start cirrus-maj.service
```

## 10. Retirer un PC

```
cirrus-serveur pcs
cirrus-serveur revoquer "Portable"
```

`pcs` liste les PC jumelés et les codes en attente. `revoquer` retire un PC : son jeton ne vaut plus rien, il ne se synchronise plus. Sa base locale reste sur lui.

## Les limites

- **Aucune sauvegarde hors du serveur** (spec 18). Le serveur et chaque PC jumelé ont la base entière, mais rien n'en garde l'historique ailleurs. Si tu en veux une, c'est une option payante de ton hébergeur : les sauvegardes automatiques du VPS, ou des instantanés à la demande.
- **L'installation pour tous les utilisateurs de Windows n'est pas prise en charge.** L'installateur installe pour toi seul, sans droits d'administrateur, et ses mises à jour aussi.
- **LaTeX dans les deux variantes à la fois** : Cirrus et « Cirrus Dev » partagent TinyTeX (`%LOCALAPPDATA%\Cirrus\TinyTeX`). Installer LaTeX, ou un paquet LaTeX, dans les deux en même temps peut se heurter. Si une installation échoue ainsi, relance-la une fois l'autre finie.
- **SmartScreen** avertit à chaque installation par la page (étape 8) : l'installateur n'a pas de signature de Windows.
- **Le code du serveur vient de GitHub.** La signature couvre le manifeste et l'installateur. Le code, lui, est pris au tag de la version par git, en HTTPS, et seulement si son manifeste signé est bon. Qui tient ton compte GitHub tient donc ton serveur et tes versions : protège-le (double authentification).
- **Changer de clé de signature** (`--remplacer`) bloque tout : les PC refusent les nouvelles versions, et le serveur aussi tant que tu n'as pas relancé `installer-serveur.sh`. Il faut ensuite réinstaller chaque PC par la page.
- **Essayer une version en développement :** pas par `npm run dev`, qui ouvre ta vraie base et, jumelée, parle au vrai serveur. Construis plutôt « Cirrus Dev » (`npm run paquet:dev -w packages/app`, l'installateur dans `packages/app/dist`) : il a ses propres dossiers, et ne se met jamais à jour.
- **Un redémarrage la nuit**, à 4 h 30, quand une mise à jour du noyau l'attend. Les services repartent seuls, et les PC se reconnectent seuls.

## Dépannage

Sur la VM, en root (précède chaque commande de `sudo` si tu entres en `ubuntu`) :

| Pour… | La commande |
|---|---|
| l'état du serveur | `systemctl status cirrus-serveur` |
| son journal (la fin ; `-f` pour le suivre) | `journalctl -u cirrus-serveur -e` |
| le relancer | `systemctl restart cirrus-serveur` |
| l'état de Caddy, son journal | `systemctl status caddy`, `journalctl -u caddy -e` |
| la mise à jour : son journal, sa prochaine heure, tout de suite | `journalctl -u cirrus-maj -e`, `systemctl list-timers cirrus-maj.timer`, `systemctl start cirrus-maj.service` |
| le pare-feu | `ufw status` |
| le domaine que le serveur accepte | `cat /etc/cirrus/serveur.env` |
| tout remettre en place | `bash /opt/cirrus/deploy/installer-serveur.sh cirrus.mondomaine.fr` |

Ce que tu peux voir :

- **« Hôte refusé »** dans Cirrus : l'adresse tapée n'est pas le domaine donné à l'installation. Regarde `/etc/cirrus/serveur.env`, ou relance `installer-serveur.sh` avec le bon domaine.
- **La page ne s'ouvre pas, ou sans cadenas** : le domaine ne pointe pas vers la VM (`nslookup`), ou Caddy n'a pas encore son certificat (`journalctl -u caddy -e`).
- **« Aucune version n'est encore publiée sur ce serveur. »** sur la page : aucune version n'est publiée sur GitHub, ou le serveur l'a refusée (`journalctl -u cirrus-maj -e`).
- **`cirrus-maj` en échec, « la clé publique … est encore provisoire »** : fais l'étape 4, attends la version qu'elle publie, puis relance `installer-serveur.sh`.
- **`cirrus-maj` en échec, « le serveur de v0.1.<n> n'a pas répondu ici »** : le serveur de cette version ne démarrait pas, et la version d'avant tourne. Son journal le dit (`journalctl -u cirrus-serveur -e`). Une fois la cause réglée, ou pour la réessayer : `rm /var/lib/cirrus-maj/echec`, puis `systemctl start cirrus-maj.service`.
- **« Code inconnu ou expiré. »** : le code a plus de 10 minutes, a servi à jumeler un PC, ou cinq essais faux l'ont brûlé. Refais `cirrus-serveur jumeler`.
- **Une mise à jour refusée** sur un PC : regarde le journal de `cirrus-maj` sur le serveur, et l'onglet Actions sur GitHub.
