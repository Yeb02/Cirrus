#!/usr/bin/env bash
# Cirrus's server, updated from the versions published on GitHub (plan 9, D6). Run as root by cirrus-maj.timer, every
# hour; by hand: `systemctl start cirrus-maj.service`, its journal `journalctl -u cirrus-maj`.
#   1. It reads the latest release from GitHub's API, without a token: the repository is public.
#   2. When its tag is newer than what is deployed — the code in /opt/cirrus, or the files in /var/lib/cirrus/versions —,
#      its four files are downloaded into a temporary folder beside the data (the same file system as versions/).
#   3. version.json.sig is checked with the public key of the code deployed (key.ts), never with the new version's, and
#      the manifest must be the tag's version: deploy/verifier-version.mjs, which runs the app's own checks.
#   4. The installer must have the manifest's size and sha512.
#   5. The code goes to the tag, `npm ci --omit=dev`, its imports are tried as cirrus, then the service restarts and must
#      answer. Otherwise the code before is put back.
#   6. The installer, latest.yml, version.json.sig, then version.json last, each go into versions/ by a rename. The older
#      installers are removed.
# Any failure leaves the version before in place, says why in the journal, and exits non-zero. It runs as root, never as
# the server's user: it writes the code that user runs. While key.ts holds the placeholder, it installs nothing.
#
# Its functions can be sourced (installer-serveur.sh does, and so does the local simulation of task 6): main runs only
# when the script is run. main is called on the script's last line, with exit: bash has read the whole script before
# main starts, so the checkout of step 5, which rewrites this very file, cannot change what bash runs.

DEPOT=/opt/cirrus
DONNEES=/var/lib/cirrus
GITHUB_DEPOT=Yeb02/Cirrus
UTILISATEUR=cirrus
SERVICE=cirrus-serveur.service
PORT=7310
SYSTEMD=/etc/systemd/system
BIN=/usr/local/bin
VERIFIER=$DEPOT/deploy/verifier-version.mjs
VERROU=/run/cirrus-maj.lock
# The temporary folder of a run, removed at its end.
TEMPORAIRE=''

dire() { printf '%s\n' "$*"; }
erreur() { printf 'Échec : %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------------------------------------------------
# What touches the machine and the network: the local simulation replaces these functions.

est_root() { [[ $(id -u) -eq 0 ]]; }

# One run at a time: the timer's, or one by hand.
verrouiller() {
  exec 9>"$VERROU" || return 1
  flock --nonblock 9 || { erreur "une autre mise à jour est en cours."; return 1; }
}

# GitHub's answer for the latest release, into the file $1. Returns 0 for a release, 1 when none is published yet, 2 when
# GitHub cannot be reached or refuses (60 requests an hour without a token: the timer makes one).
lire_derniere_publication() {
  local code
  code=$(curl --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 20 \
    --max-time 120 --max-filesize 1048576 --header 'Accept: application/vnd.github+json' \
    --header 'X-GitHub-Api-Version: 2022-11-28' --output "$1" --write-out '%{http_code}' \
    "https://api.github.com/repos/$GITHUB_DEPOT/releases/latest") || { erreur "l’API de GitHub ne répond pas."; return 2; }
  case $code in
    200) return 0 ;;
    404) return 1 ;;
    *) erreur "l’API de GitHub répond $code."; return 2 ;;
  esac
}

# The address $1 (a file of a release on github.com, which redirects elsewhere: https only) into the file $2, $3 bytes at most.
telecharger() {
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 20 \
    --max-time 3600 --max-filesize "$3" --output "$2" "$1"
}

git_depot() { git -C "$DEPOT" "$@"; }

# The checkout's dependencies, production only, without their install scripts: the server needs none (no native module,
# node:sqlite is Node's own), and no script of a dependency ever runs as root.
npm_ci() { (cd "$DEPOT" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error); }

# The server's modules imported as cirrus, as the service will: every import resolves after npm ci --omit=dev, and the
# user can read them all. Nothing starts: main.ts alone runs the command line.
serveur_importable() {
  (cd / && runuser -u "$UTILISATEUR" -- node --input-type=module \
    -e "await import('$DEPOT/packages/server/src/cli.ts'); await import('$DEPOT/packages/server/src/server.ts');")
}

service() { systemctl "$@"; }

# Whether the server answers on this machine within a minute: any HTTP answer will do (/hello without a token: 401).
serveur_repond() {
  local i code
  for ((i = 0; i < 30; i++)); do
    sleep 2
    code=$(curl --silent --output /dev/null --max-time 5 --write-out '%{http_code}' "http://127.0.0.1:$PORT/hello") || true
    [[ $code =~ ^[1-5][0-9][0-9]$ ]] && return 0
  done
  return 1
}

# ---------------------------------------------------------------------------------------------------------------------
# The decisions.

# A version as the CI makes them (D3: 0.1.<n>): three numbers, without a leading zero.
version_valide() { [[ $1 =~ ^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$ ]]; }

# Whether the version $1 is newer than $2; an empty $2 (nothing deployed) is older than any.
plus_recente() {
  [[ -z $2 ]] && return 0
  [[ $1 != "$2" && $(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1) == "$1" ]]
}

# Whether the code deployed carries the placeholder instead of a public key: then no version can be checked.
cle_provisoire() {
  grep -q "^export const UPDATE_PUBLIC_KEY: string = 'PLACEHOLDER" "$DEPOT/packages/app/src/main/update/key.ts"
}

# The version of the code deployed: the highest version tag at its HEAD; empty on a branch (main, before any release).
version_du_code() {
  local t v best=''
  while IFS= read -r t; do
    v=${t#v}
    if version_valide "$v" && plus_recente "$v" "$best"; then best=$v; fi
  done < <(git_depot tag --points-at HEAD --list 'v*')
  printf '%s' "$best"
}

# The version of the files in versions/: that of version.json, its signature holding with the key of the code deployed;
# empty without one, or with one that does not hold (then the files are put back).
version_des_fichiers() { node "$VERIFIER" posee "$DEPOT" "$DONNEES/versions" 2>/dev/null || true; }

# The release listed in $1/fichiers (verifier-version.mjs publication), downloaded into $1/version, then checked against
# the tag $2. Prints the installer's name in the signed manifest, and nothing else.
telecharger_et_verifier() {
  local dossier=$1 tag=$2 role url taille
  mkdir -- "$dossier/version" || return 1
  while IFS=$'\t' read -r role url taille; do
    case $role in
      tag) ;;
      version.json | version.json.sig | latest.yml | installateur)
        telecharger "$url" "$dossier/version/$role" "$taille" || { erreur "$role de $tag non téléchargé ($url)."; return 1; } ;;
      *) erreur "fichier inattendu dans la liste de $tag : $role."; return 1 ;;
    esac
  done <"$dossier/fichiers"
  node "$VERIFIER" verifier "$DEPOT" "$tag" "$dossier/version"
}

# The units and the administration script of the checkout, put in place where they changed.
poser_les_fichiers_systeme() {
  local f change=0
  for f in cirrus-serveur.service cirrus-maj.service cirrus-maj.timer; do
    if ! cmp -s "$DEPOT/deploy/$f" "$SYSTEMD/$f"; then
      install -m 644 "$DEPOT/deploy/$f" "$SYSTEMD/$f" || return 1
      change=1
    fi
  done
  if ! cmp -s "$DEPOT/deploy/cirrus-serveur" "$BIN/cirrus-serveur"; then
    install -m 755 "$DEPOT/deploy/cirrus-serveur" "$BIN/cirrus-serveur" || return 1
  fi
  if [[ $change -eq 1 ]]; then service daemon-reload || return 1; fi
}

# The checkout back to the commit $1, with its dependencies.
remettre_le_code() {
  git_depot -c advice.detachedHead=false checkout --quiet --force --detach "$1" || return 1
  npm_ci
}

# The code moved to the tag $1, its dependencies installed, its imports tried, the service restarted and heard. When a
# step fails, the code before is put back (and restarted, if the new one had been) and it returns 1.
mettre_le_code_a() {
  local tag=$1 avant
  avant=$(git_depot rev-parse --verify HEAD) || return 1
  if ! git_depot fetch --quiet --force origin "+refs/tags/$tag:refs/tags/$tag"; then
    erreur "le tag $tag n’a pas pu être récupéré."
    return 1
  fi
  if ! git_depot -c advice.detachedHead=false checkout --quiet --force --detach "refs/tags/$tag"; then
    erreur "le code de $tag n’a pas pu être sorti : le code d’avant est remis."
    remettre_le_code "$avant" || erreur "le code d’avant non plus ; le service tourne encore sur celui qu’il a chargé."
    return 1
  fi
  if ! npm_ci || ! serveur_importable; then
    erreur "les dépendances de $tag ne s’installent pas, ou le serveur ne se charge pas : le code d’avant est remis."
    # The service still runs on what it loaded: it is not restarted.
    remettre_le_code "$avant" || erreur "le code d’avant non plus ; le service tourne encore sur celui qu’il a chargé, la prochaine heure réessaie."
    return 1
  fi
  poser_les_fichiers_systeme || { erreur "les unités de $tag n’ont pas pu être posées."; }
  service restart "$SERVICE" || true
  if ! serveur_repond; then
    erreur "le serveur de $tag ne répond pas : le code d’avant est remis et relancé."
    remettre_le_code "$avant" || erreur "le code d’avant n’a pas pu être remis entièrement."
    poser_les_fichiers_systeme || true
    service restart "$SERVICE" || true
    serveur_repond || erreur "le serveur d’avant ne répond pas non plus : regarde journalctl -u cirrus-serveur."
    return 1
  fi
}

# The checked files of $1 moved into versions/, the installer under the manifest's name $2: each by a rename on the
# same file system, version.json last — the server never names an installer that is not there yet. Then the other files
# of versions/ (the older installers) are removed: the server serves only the one version.json names.
poser_les_versions() {
  local source=$1 nom=$2 cible="$DONNEES/versions" f
  install -d -m 755 "$cible" || return 1
  chmod 644 "$source/installateur" "$source/latest.yml" "$source/version.json.sig" "$source/version.json" || return 1
  mv -f -- "$source/installateur" "$cible/$nom" || return 1
  mv -f -- "$source/latest.yml" "$cible/latest.yml" || return 1
  mv -f -- "$source/version.json.sig" "$cible/version.json.sig" || return 1
  mv -f -- "$source/version.json" "$cible/version.json" || return 1
  for f in "$cible"/*; do
    case ${f##*/} in
      "$nom" | latest.yml | version.json | version.json.sig) ;;
      *) if [[ -f $f && ! -L $f ]]; then rm -f -- "$f"; fi ;;
    esac
  done
}

# At the end of a run: the temporary folder removed, and a failure said once more.
fin() {
  local statut=$1
  if [[ -n $TEMPORAIRE ]]; then rm -rf -- "$TEMPORAIRE"; fi
  if [[ $statut -ne 0 ]]; then erreur "la mise à jour s’arrête ; la version d’avant reste en place."; fi
}

main() {
  set -Eeuo pipefail
  umask 022
  if ! est_root; then
    erreur "lance-moi en root : systemctl start cirrus-maj.service."
    return 1
  fi
  verrouiller || return 1
  if cle_provisoire; then
    erreur "la clé publique de $DEPOT (packages/app/src/main/update/key.ts) est encore provisoire : aucune version n’est installée. Fais la clé (node deploy/cle-de-signature.mjs, sur ton PC), commite key.ts, puis relance installer-serveur.sh une fois la version suivante publiée."
    return 1
  fi
  # What a run stopped short (a reboot, a kill) left behind.
  rm -rf -- "$DONNEES"/.maj-*
  TEMPORAIRE=$(mktemp -d "$DONNEES/.maj-XXXXXXXX")
  trap 'fin $?' EXIT

  local trouve=0
  lire_derniere_publication "$TEMPORAIRE/publication.json" || trouve=$?
  if [[ $trouve -eq 1 ]]; then
    dire "Aucune version publiée sur GitHub : rien à faire."
    return 0
  fi
  [[ $trouve -eq 0 ]] || return 1
  node "$VERIFIER" publication "$TEMPORAIRE/publication.json" "$GITHUB_DEPOT" >"$TEMPORAIRE/fichiers"

  local tag version code fichiers v nom
  tag=$(awk -F '\t' '$1 == "tag" { print $2 }' "$TEMPORAIRE/fichiers")
  version=${tag#v}
  code=$(version_du_code)
  fichiers=$(version_des_fichiers)
  if [[ $code == "$version" && $fichiers == "$version" ]]; then
    dire "Cirrus $version est déjà en place."
    return 0
  fi
  # Never back: a release older than what is deployed changes nothing.
  for v in "$code" "$fichiers"; do
    if [[ -n $v ]] && plus_recente "$v" "$version"; then
      dire "La dernière version publiée ($version) est plus ancienne que celle en place ($v) : rien n’est fait."
      return 0
    fi
  done
  dire "Version publiée : $version (code en place : ${code:-aucune version}, fichiers en place : ${fichiers:-aucun})."

  nom=$(telecharger_et_verifier "$TEMPORAIRE" "$tag")
  dire "$tag vérifiée : la signature de son manifeste, la taille et l’empreinte de son installateur."
  if [[ $code != "$version" ]]; then
    mettre_le_code_a "$tag" || return 1
    dire "Le code de $tag est en place, le service relancé."
  fi
  if [[ $fichiers != "$version" ]]; then
    poser_les_versions "$TEMPORAIRE/version" "$nom" || { erreur "les fichiers de $tag n’ont pas pu être posés dans $DONNEES/versions."; return 1; }
    dire "L’installateur de $tag est servi : $nom."
  fi
  dire "Cirrus $version est en place."
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; exit $?; fi
