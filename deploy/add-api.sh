#!/usr/bin/env bash
# Starts the Nilemy API (api/: the app's daily note) in its own container on the VPS, next to
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

docker build -q -t nilemy-api "$SITE/api" >/dev/null
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d -q --name "$NAME" --restart unless-stopped --network "$NET" \
  --env-file "$ENV_FILE" -v "$HOME_DIR/data":/data \
  --memory 256m --cpus 0.5 nilemy-api >/dev/null
sleep 3
docker exec "$NAME" wget -qO- http://localhost:8080/api/health >/dev/null || { docker logs --tail 20 "$NAME"; die "the API did not start"; }

# Adds the /api route inside the nilemy.com block (add-to-vps.sh sees the running container).
bash "$SITE/deploy/add-to-vps.sh" live
echo
echo "HAZIR / DONE: https://nilemy.com/api/health"
