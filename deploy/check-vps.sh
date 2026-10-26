#!/usr/bin/env bash
# Read-only: shows what already serves the web on this VPS, so the site can be
# added without touching other projects. Changes nothing.
echo "== 80/443 =="
ss -ltnpH '( sport = :80 or sport = :443 )' 2>/dev/null | awk '{print $4, $6}'
echo "== installed =="
for c in nginx apache2 caddy docker traefik pm2 certbot; do command -v $c >/dev/null && echo "$c"; done
[ -d /usr/local/lsws ] && echo "openlitespeed"
if command -v nginx >/dev/null; then
  echo "== nginx sites =="
  grep -rhoE 'server_name[^;]+' /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | sort -u
fi
if [ -f /etc/caddy/Caddyfile ]; then
  echo "== Caddyfile =="
  grep -vE '^\s*(#|$)' /etc/caddy/Caddyfile | head -30
fi
if command -v docker >/dev/null; then
  echo "== docker =="
  docker ps --format '{{.Names}}  {{.Image}}  {{.Ports}}' 2>/dev/null | head -20
fi
echo "== disk =="
df -h / | tail -1
