#!/usr/bin/env bash
# Sets up nilemy.com on a fresh Ubuntu 24.04 VPS: Caddy serves this repo with
# automatic HTTPS, and a timer pulls main every 2 minutes so pushes go live.
# Safe to run again.
set -euo pipefail

REPO=https://github.com/meyildiz1994/nilemy-site.git
SITE=/var/www/nilemy-site
IP=$(curl -fsS4 https://api.ipify.org || hostname -I | awk '{print $1}')

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq git curl gnupg debian-keyring debian-archive-keyring apt-transport-https

# Caddy from its official repository
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -yq caddy
fi

# Site files
if [ -d "$SITE/.git" ]; then
  git -C "$SITE" fetch -q origin main && git -C "$SITE" reset -q --hard origin/main
else
  git clone -q --depth 1 "$REPO" "$SITE"
fi

cat > /etc/caddy/Caddyfile <<EOF
(site) {
	root * $SITE
	@hidden path /.git* /.github* /deploy* /README.md /CNAME
	respond @hidden 404
	encode zstd gzip
	header -Server
	file_server
}

nilemy.com {
	import site
}

www.nilemy.com {
	redir https://nilemy.com{uri} permanent
}

# Plain-HTTP preview by IP, for testing before DNS points here
http://$IP {
	import site
}
EOF
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable -q caddy
systemctl reload caddy || systemctl restart caddy

# Pull main every 2 minutes
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

# Open web ports if the Ubuntu firewall is on (never turns it on)
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp && ufw allow 443/tcp
fi

echo
echo "HAZIR / DONE: http://$IP"
