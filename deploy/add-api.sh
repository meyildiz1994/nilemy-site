#!/usr/bin/env bash
# Starts the Nilemy API (api/: the app's AI features) in its own container on the VPS, next to
# nilemy-site, and routes https://nilemy.com/api/* to it. Other sites are never touched:
# the route goes inside the marked nilemy.com block (add-to-vps.sh live).
#
#   add-api.sh           first run asks for the Anthropic API key, then builds and starts
#   add-api.sh update    rebuild after a change in api/ (the key is kept)
#   add-api.sh key       replace the API key
#   add-api.sh remove    stop it and take the route out
set -euo pipefail

MODE=${1:-install}
SITE=/opt/nilemy-site
HOME_DIR=/opt/nilemy-api
NAME=nilemy-api
ENV_FILE=$HOME_DIR/api.env

die() { echo "DUR / STOP: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root"
[ -d "$SITE/.git" ] || die "$SITE not found; nilemy.com must be set up first (add-to-vps.sh)"

if [ "$MODE" = remove ]; then
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  bash "$SITE/deploy/add-to-vps.sh" live
  echo "HAZIR / DONE (remove). Key and data kept in $HOME_DIR"
  exit 0
fi

git -C "$SITE" fetch -q --depth 1 origin main && git -C "$SITE" reset -q --hard origin/main
mkdir -p "$HOME_DIR/data"
chown 1000:1000 "$HOME_DIR/data"   # the node user in the image

if [ ! -s "$ENV_FILE" ] || [ "$MODE" = key ]; then
  echo "Anthropic API anahtarını yapıştır (ekranda görünmez) / Paste the Anthropic API key (hidden):"
  read -rs KEY; echo
  case "$KEY" in sk-ant-*) ;; *) die "this doesn't look like an Anthropic key (sk-ant-...)" ;; esac
  umask 077
  printf 'ANTHROPIC_API_KEY=%s\nMODEL=claude-opus-5-5\nDAILY_CAP=3000\n' "$KEY" > "$ENV_FILE"
fi

CADDY=$(docker ps --format '{{.Names}} {{.Image}}' | awk '$2 ~ /^caddy(:|$)/ {print $1; exit}')
[ -n "$CADDY" ] || die "no running caddy container found"
NET=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$CADDY" | head -1)

start() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d -q --name "$NAME" --restart unless-stopped --network "$NET" \
    --env-file "$ENV_FILE" -v "$HOME_DIR/data":/data \
    --memory 256m --cpus 0.5 "$1" >/dev/null
}
# Health answers once Claude has taken the key and settings (a few seconds after start).
healthy() {
  for _ in 1 2 3 4 5 6; do
    sleep 3
    docker exec "$NAME" wget -qO- -T 60 http://localhost:8080/api/health >/dev/null 2>&1 && return 0
  done
  return 1
}

# The running version is kept as nilemy-api:previous, so a new one that fails its health check is rolled back.
docker image inspect nilemy-api >/dev/null 2>&1 && docker tag nilemy-api nilemy-api:previous
docker build -q -t nilemy-api "$SITE/api" >/dev/null
start nilemy-api
if ! healthy; then
  docker logs --tail 20 "$NAME"
  docker image inspect nilemy-api:previous >/dev/null 2>&1 || die "the API did not start"
  start nilemy-api:previous
  healthy || die "the API did not start, and neither did the previous version"
  die "the new API did not start (see the lines above); the previous version is running again"
fi

# Adds the /api route inside the nilemy.com block (add-to-vps.sh sees the running container).
bash "$SITE/deploy/add-to-vps.sh" live
echo
echo "HAZIR / DONE: https://nilemy.com/api/health"
