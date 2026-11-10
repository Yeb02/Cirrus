#!/usr/bin/env bash
# Cirrus's server on a rented machine (plan 9, D2), installed once by its user, as root, on Ubuntu 24.04 LTS:
#   bash installer-serveur.sh <domaine> ["<clé publique SSH>"]
# Without its arguments, it asks for them. It installs:
#   - Node (the version the repository needs) from NodeSource, Caddy from its own repository, git;
#   - the system user cirrus, and the repository cloned into /opt/cirrus at its latest release (else main), with its
#     production dependencies (npm ci --omit=dev), the server's imports tried as cirrus;
#   - the data in /var/lib/cirrus (cirrus's, 700), the domain in /etc/cirrus/serveur.env;
#   - the systemd units (the server, its hourly update), enabled and started, and the command cirrus-serveur;
#   - the Caddyfile with the domain; ufw (22, 80, 443, TCP); unattended-upgrades;
#   - SSH by key only, once a key is authorised: nobody is locked out.
# Then it fetches the latest release's installer (deploy/mettre-a-jour.sh) and says what comes next, in French.
# It is idempotent: run again, it breaks nothing, and puts the code on the latest release, the units, the Caddyfile and
# cirrus-serveur back from it.

set -Eeuo pipefail
umask 022

GITHUB_DEPOT=Yeb02/Cirrus
DEPOT=/opt/cirrus
DONNEES=/var/lib/cirrus
CONFIG=/etc/cirrus
UTILISATEUR=cirrus
NODE_MAJEURE=26

etape() { printf '\n== %s\n' "$*"; }
dire() { printf '%s\n' "$*"; }
mourir() {
  printf 'Échec : %s\n' "$*" >&2
  exit 1
}
trap 'printf "Échec à la ligne %s : %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR

# A domain name alone, as the server takes it (cli.ts, hostName): lower-case ASCII labels of letters, digits and inner
# hyphens, 63 characters each, 253 in all; at least two labels, the last not a number (no IP address: no certificate).
domaine_valide() {
  local d=$1
  [[ ${#d} -le 253 ]] || return 1
  [[ $d =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || return 1
  [[ ! $d =~ \.[0-9]+$ ]]
}

# The number of valid public keys in the file $1.
cles_autorisees() { { ssh-keygen -l -f "$1" 2>/dev/null || true; } | wc -l; }

# The key $2, when given, authorised for the account $1; then at least one key must be: SSH by key only follows.
autoriser_la_cle() {
  local compte=$1 cle=$2 maison fichier
  maison=$(getent passwd "$compte" | cut -d: -f6)
  [[ -n $maison ]] || mourir "le compte $compte n’a pas de dossier personnel."
  fichier="$maison/.ssh/authorized_keys"
  if [[ -n $cle ]]; then
    ssh-keygen -l -f <(printf '%s\n' "$cle") >/dev/null 2>&1 || mourir "cette clé publique SSH est illisible : $cle"
    install -d -m 700 -o "$compte" -g "$(id -gn "$compte")" "$maison/.ssh"
    # The key's type and body, compared with the lines already there: added once.
    if ! grep -qF -- "$(awk '{ print $1 " " $2 }' <<<"$cle")" "$fichier" 2>/dev/null; then
      # A last line without its newline would be joined to the key.
      if [[ -s $fichier && -n $(tail -c 1 "$fichier") ]]; then printf '\n' >>"$fichier"; fi
      printf '%s\n' "$cle" >>"$fichier"
      dire "Clé SSH ajoutée à $fichier."
    fi
    chown "$compte:$(id -gn "$compte")" "$fichier"
    chmod 600 "$fichier"
  fi
  if [[ $(cles_autorisees "$fichier") -lt 1 ]]; then
    mourir "aucune clé SSH n’est autorisée pour $compte ($fichier). Donne ta clé publique (le contenu de ton fichier id_ed25519.pub) en second argument : sinon, SSH par clé seulement t’enfermerait dehors. Rien n’a été changé."
  fi
}

installer_les_paquets() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q ca-certificates curl gnupg git ufw unattended-upgrades
  # Node, from NodeSource (its documented setup): the major version the repository needs, preferred to Ubuntu's.
  install -d -m 755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --batch --yes --dearmor -o /etc/apt/keyrings/nodesource.gpg
  chmod 644 /etc/apt/keyrings/nodesource.gpg
  printf 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_%s.x nodistro main\n' "$NODE_MAJEURE" >/etc/apt/sources.list.d/nodesource.list
  printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' >/etc/apt/preferences.d/nodejs
  # Caddy, from its own repository (its documented setup, the same file names).
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  chmod 644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  printf 'deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main\n' >/etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q nodejs caddy
  local majeure
  majeure=$(node -p 'process.versions.node.split(".")[0]')
  [[ $majeure -ge $NODE_MAJEURE ]] || mourir "Node $majeure est installé, $NODE_MAJEURE au moins est attendu."
  dire "Node $(node --version), $(caddy version | cut -d' ' -f1), $(git --version)."
}

creer_l_utilisateur() {
  if ! id -u "$UTILISATEUR" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$DONNEES" --no-create-home --shell /usr/sbin/nologin "$UTILISATEUR"
    dire "Utilisateur système $UTILISATEUR créé."
  fi
  # The data: cirrus's alone. versions/ is root's: the update writes there, the server only reads.
  install -d -m 700 -o "$UTILISATEUR" -g "$UTILISATEUR" "$DONNEES"
  install -d -m 755 -o root -g root "$DONNEES/versions"
}

# The repository in /opt/cirrus, root's (the server's user reads it, never writes it), at main for now.
cloner_le_depot() {
  if [[ ! -d $DEPOT/.git ]]; then
    [[ ! -e $DEPOT ]] || mourir "$DEPOT existe et n’est pas un dépôt git : déplace-le, puis relance le script."
    git clone --quiet "https://github.com/$GITHUB_DEPOT.git" "$DEPOT"
  fi
  git -C "$DEPOT" fetch --quiet --force --tags origin
  git -C "$DEPOT" -c advice.detachedHead=false checkout --quiet --force --detach origin/main
}

# The code on the latest release when there is one, else main; its dependencies; its imports tried as cirrus.
placer_le_code() {
  local temporaire trouve=0 tag=''
  temporaire=$(mktemp -d)
  lire_derniere_publication "$temporaire/publication.json" || trouve=$?
  case $trouve in
    0)
      node "$VERIFIER" publication "$temporaire/publication.json" "$GITHUB_DEPOT" >"$temporaire/fichiers" ||
        mourir "la dernière version publiée sur GitHub est incomplète : regarde l’onglet Actions du dépôt, puis relance le script."
      tag=$(awk -F '\t' '$1 == "tag" { print $2 }' "$temporaire/fichiers")
      ;;
    1) dire "Aucune version n’est encore publiée sur GitHub : le code est celui de main." ;;
    *) mourir "GitHub ne répond pas : relance le script plus tard." ;;
  esac
  rm -rf -- "$temporaire"
  if [[ -n $tag ]]; then
    git -C "$DEPOT" -c advice.detachedHead=false checkout --quiet --force --detach "refs/tags/$tag"
    dire "Code de la version $tag."
  fi
  npm_ci || mourir "npm ci --omit=dev a échoué dans $DEPOT."
  serveur_importable || mourir "le serveur ne se charge pas (une dépendance manque-t-elle après --omit=dev ?)."
  dire "Dépendances installées ; le serveur se charge en $UTILISATEUR."
}

configurer_le_service() {
  local domaine=$1
  install -d -m 755 "$CONFIG"
  cat >"$CONFIG/serveur.env.nouveau" <<FIN
# The domain of Cirrus's server (installer-serveur.sh): the service and the SSH commands (cirrus-serveur) read it.
CIRRUS_NOM=$domaine
FIN
  chmod 644 "$CONFIG/serveur.env.nouveau"
  mv -f "$CONFIG/serveur.env.nouveau" "$CONFIG/serveur.env"
  poser_les_fichiers_systeme || mourir "les unités systemd n’ont pas pu être posées."
  systemctl daemon-reload
  systemctl enable --quiet cirrus-serveur.service cirrus-maj.timer
  # Restarted, not only started: a run again takes the code just placed.
  systemctl restart cirrus-serveur.service
  systemctl start cirrus-maj.timer
  serveur_repond || mourir "le serveur ne répond pas sur 127.0.0.1:$PORT : regarde journalctl -u cirrus-serveur -e."
  dire "Service cirrus-serveur actif ; la mise à jour passe chaque heure (cirrus-maj.timer)."
}

configurer_caddy() {
  local domaine=$1
  sed "s/%DOMAINE%/$domaine/g" "$DEPOT/deploy/Caddyfile.modele" >/etc/caddy/Caddyfile.nouveau
  caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile.nouveau >/dev/null 2>&1 ||
    mourir "Caddy refuse le Caddyfile (caddy validate --config /etc/caddy/Caddyfile.nouveau le dit)."
  chmod 644 /etc/caddy/Caddyfile.nouveau
  mv -f /etc/caddy/Caddyfile.nouveau /etc/caddy/Caddyfile
  systemctl enable --quiet caddy.service
  systemctl reload-or-restart caddy.service
  dire "Caddy sert https://$domaine (son certificat arrive dès que le domaine pointe vers cette machine)."
}

configurer_le_pare_feu() {
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow 22/tcp >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
  dire "Pare-feu actif : 22 (SSH), 80 et 443 (HTTPS) en TCP, rien d’autre."
}

configurer_les_mises_a_jour() {
  cat >/etc/apt/apt.conf.d/20auto-upgrades <<'FIN'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
FIN
  # Ubuntu's security updates (its own 50unattended-upgrades), plus Node and Caddy: the server faces the Internet. A
  # kernel update is applied by a reboot at night; the services start again by themselves.
  cat >/etc/apt/apt.conf.d/52cirrus-unattended-upgrades <<'FIN'
// Cirrus (deploy/installer-serveur.sh): Node and Caddy updated with the rest, and a reboot at night when one is needed.
Unattended-Upgrade::Origins-Pattern {
	"site=deb.nodesource.com";
	"site=dl.cloudsmith.io";
};
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
FIN
  systemctl enable --quiet --now unattended-upgrades.service
  dire "Mises à jour de sécurité automatiques (Ubuntu, Node, Caddy), redémarrage à 4 h 30 quand un noyau l’attend."
}

# SSH by key only. The file is read before the others of sshd_config.d (sshd keeps the first value it reads): it wins
# over a cloud image's PasswordAuthentication yes.
durcir_ssh() {
  local fichier=/etc/ssh/sshd_config.d/00-cirrus.conf
  cat >"$fichier" <<'FIN'
# Cirrus (deploy/installer-serveur.sh): SSH by key only (spec 18); root by key only.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
FIN
  chmod 644 "$fichier"
  if ! sshd -t; then
    rm -f -- "$fichier"
    mourir "sshd refuse sa configuration : $fichier est retiré, SSH reste tel qu’il était."
  fi
  systemctl try-reload-or-restart ssh.service || dire "Attention : ssh.service n’a pas relu sa configuration ; elle vaudra à son prochain démarrage."
  if sshd -T 2>/dev/null | grep -qi '^passwordauthentication no$'; then
    dire "SSH : par clé seulement."
  else
    dire "Attention : sshd -T ne dit pas « passwordauthentication no » ; regarde /etc/ssh/sshd_config.d/."
  fi
}

# Whether the domain points to this machine yet: a warning only, Caddy waits for it.
verifier_le_dns() {
  local domaine=$1 ip ips
  ips=$(getent ahosts "$domaine" 2>/dev/null | awk '{ print $1 }' | sort -u || true)
  for ip in $ips; do
    if hostname -I | tr ' ' '\n' | grep -qxF -- "$ip"; then return 0; fi
  done
  dire "Attention : $domaine ne pointe pas (encore) vers cette machine ($(hostname -I | xargs)). Fais l’enregistrement DNS (A, et AAAA pour l’IPv6) : Caddy obtiendra son certificat dès qu’il pointera ici."
}

# Not « main »: the update's script, sourced below, defines a function of that name.
installer() {
  [[ $(id -u) -eq 0 ]] || mourir "lance-moi en root : sudo bash installer-serveur.sh <domaine>."
  command -v apt-get >/dev/null || mourir "ce script est fait pour Ubuntu 24.04 (apt-get introuvable)."
  # shellcheck source=/dev/null
  . /etc/os-release
  if [[ ${ID:-} != ubuntu || ${VERSION_ID:-} != 24.04 ]]; then dire "Attention : ce script est fait pour Ubuntu 24.04, cette machine est ${PRETTY_NAME:-inconnue}."; fi

  local domaine=${1:-} cle=${2:-}
  if [[ -z $domaine ]]; then
    [[ -t 0 ]] || mourir "usage : bash installer-serveur.sh <domaine> [\"<clé publique SSH>\"]"
    read -r -p 'Nom de domaine du serveur (par exemple cirrus.mondomaine.fr) : ' domaine
    read -r -p 'Ta clé publique SSH, une ligne « ssh-ed25519 AAAA… » (vide : garder celles déjà autorisées) : ' cle
  fi
  domaine=${domaine,,}
  domaine_valide "$domaine" || mourir "« $domaine » n’est pas un nom de domaine seul (sans https://, chemin ni port)."

  etape "Clé SSH"
  autoriser_la_cle "${SUDO_USER:-root}" "$cle"
  etape "Paquets : Node, Caddy, git, ufw, unattended-upgrades"
  installer_les_paquets
  etape "Utilisateur $UTILISATEUR et dossier des données"
  creer_l_utilisateur
  etape "Dépôt dans $DEPOT"
  cloner_le_depot
  # The update's functions (the release read, npm ci, the units, the server heard), from the checkout.
  # shellcheck source=deploy/mettre-a-jour.sh
  . "$DEPOT/deploy/mettre-a-jour.sh"
  placer_le_code
  etape "Service"
  configurer_le_service "$domaine"
  etape "Caddy"
  configurer_caddy "$domaine"
  etape "Pare-feu"
  configurer_le_pare_feu
  etape "Mises à jour automatiques"
  configurer_les_mises_a_jour
  etape "SSH"
  durcir_ssh
  etape "Installateur de la dernière version"
  if bash "$DEPOT/deploy/mettre-a-jour.sh"; then
    dire "La page de téléchargement sert la dernière version publiée."
  else
    dire "Attention : l’installateur n’est pas encore en place (le message ci-dessus dit pourquoi). La mise à jour réessaie chaque heure ; une fois la cause réglée : systemctl start cirrus-maj.service."
  fi
  verifier_le_dns "$domaine"

  cat <<FIN

Cirrus est installé sur https://$domaine.

La suite :
  1. Vérifie le service :            systemctl status cirrus-serveur
     et son journal :                journalctl -u cirrus-serveur -e
  2. Sur la page https://$domaine/installer, le navigateur doit montrer un cadenas.
  3. Fais un code pour ton premier PC : cirrus-serveur jumeler "Fixe"
     puis, dans Cirrus sur ce PC : Réglages › Serveur, l'adresse https://$domaine, le code, « Jumeler ».
     Il envoie sa base au serveur.
  4. Pour chaque autre PC : cirrus-serveur jumeler "Portable", puis, sur ce PC, la page
     https://$domaine/installer avec le code, et le même code dans Cirrus.
  5. Les PC jumelés :                cirrus-serveur pcs
     Retirer un PC :                 cirrus-serveur revoquer "Portable"
  6. Les mises à jour arrivent seules ; leur journal : journalctl -u cirrus-maj -e

Le guide complet : $DEPOT/deploy/LISEZ-MOI.md
FIN
}

# One line, with exit: run as /opt/cirrus/deploy/installer-serveur.sh, the checkouts above rewrite this very file.
installer "$@"; exit $?
