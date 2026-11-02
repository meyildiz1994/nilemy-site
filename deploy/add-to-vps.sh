#!/usr/bin/env bash
# Adds nilemy.com to a VPS where a Caddy container (official caddy image)
# already fronts other sites. Other sites are never touched: the script only
# appends a marked block to the existing Caddyfile and does a graceful reload.
# If Caddy rejects the new config, the Caddyfile is restored.
#
#   add-to-vps.sh          stage: serve on plain HTTP only (DNS still elsewhere)
#   add-to-vps.sh live     after DNS points here: HTTPS + www -> apex
#   add-to-vps.sh remove   take the block out again
set -euo pipefail

MODE=${1:-stage}
REPO=https://github.com/meyildiz1994/nilemy-site.git
SITE=/opt/nilemy-site
NAME=nilemy-site
BEGIN="# >>> nilemy.com (nilemy-site/deploy) >>>"
END="# <<< nilemy.com <<<"

die() { echo "DUR / STOP: $*" >&2; exit 1; }

CADDY=$(docker ps --format '{{.Names}} {{.Image}}' | awk '$2 ~ /^caddy(:|$)/ {print $1; exit}')
[ -n "$CADDY" ] || die "no running caddy container found"

# Where the Caddyfile lives on the host and inside the container
HOSTFILE= ; INFILE=
while IFS='|' read -r src dst; do
  case "$dst" in
    */Caddyfile) HOSTFILE=$src; INFILE=$dst ;;
    /etc/caddy)
      if [ -z "$HOSTFILE" ] && [ -f "$src/Caddyfile" ]; then
        HOSTFILE=$src/Caddyfile; INFILE=/etc/caddy/Caddyfile
      fi ;;
  esac
done < <(docker inspect -f '{{range .Mounts}}{{.Source}}|{{.Destination}}{{"\n"}}{{end}}' "$CADDY")
[ -n "$HOSTFILE" ] && [ -f "$HOSTFILE" ] || die "Caddyfile mount not found on $CADDY"
NET=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$CADDY" | head -1)
[ -n "$NET" ] || die "no docker network on $CADDY"
echo "caddy: $CADDY  config: $HOSTFILE  network: $NET"

# Site files and the container that serves them
if [ "$MODE" != remove ]; then
  command -v git >/dev/null || { apt-get update -q && apt-get install -yq git; }
  if [ -d "$SITE/.git" ]; then
    git -C "$SITE" fetch -q --depth 1 origin main && git -C "$SITE" reset -q --hard origin/main
  else
    git clone -q --depth 1 "$REPO" "$SITE"
  fi
  if ! docker inspect "$NAME" >/dev/null 2>&1; then
    docker run -d -q --name "$NAME" --restart unless-stopped --network "$NET" \
      -v "$SITE":/usr/share/nginx/html:ro nginx:alpine >/dev/null
  fi

  # Pull main every 2 minutes so pushes go live
  cat > /etc/systemd/system/nilemy-pull.service <<EOF
[Unit]
Description=Update nilemy.com from GitHub
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'git -C $SITE fetch -q --depth 1 origin main && git -C $SITE reset -q --hard origin/main'
EOF
  cat > /etc/systemd/system/nilemy-pull.timer <<EOF
[Unit]
Description=Update nilemy.com from GitHub every 2 minutes
[Timer]
OnBootSec=1min
OnUnitActiveSec=2min
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable -q --now nilemy-pull.timer
fi

SERVE="	@hidden path /.git* /.github* /deploy* /README.md /CNAME
	respond @hidden 404
	encode zstd gzip
	reverse_proxy $NAME:80"
case "$MODE" in
  stage) BLOCK="http://nilemy.com, http://www.nilemy.com {
$SERVE
}" ;;
  live) BLOCK="nilemy.com {
$SERVE
}

www.nilemy.com {
	redir https://nilemy.com{uri} permanent
}" ;;
  remove) BLOCK= ;;
  *) die "unknown mode $MODE" ;;
esac

# Rewrite the file in place (same inode, so a single-file bind mount sees it)
BACKUP=$HOSTFILE.before-nilemy.$(date +%Y%m%d%H%M%S)
cp -p "$HOSTFILE" "$BACKUP"
NEW=$(awk -v b="$BEGIN" -v e="$END" '$0==b{skip=1;next} $0==e{skip=0;next} !skip' "$BACKUP")
{
  printf '%s\n' "$NEW"
  if [ -n "$BLOCK" ]; then printf '\n%s\n%s\n%s\n' "$BEGIN" "$BLOCK" "$END"; fi
} > "$HOSTFILE.tmp"
cat "$HOSTFILE.tmp" > "$HOSTFILE" && rm -f "$HOSTFILE.tmp"

restore() { cat "$BACKUP" > "$HOSTFILE"; die "caddy rejected the new config; restored $HOSTFILE (others untouched)"; }
docker exec "$CADDY" caddy validate --config "$INFILE" --adapter caddyfile >/dev/null 2>&1 || restore
docker exec "$CADDY" caddy reload --config "$INFILE" --adapter caddyfile || restore

if [ "$MODE" = remove ]; then
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  systemctl disable -q --now nilemy-pull.timer || true
fi

echo
echo "HAZIR / DONE ($MODE). Backup: $BACKUP"
