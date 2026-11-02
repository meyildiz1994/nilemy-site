# nilemy.com

The landing page: a first screen with the app, then our story and the footer below it, Turkish and English (follows the browser, TR | EN switch). `story/` is the full story.

- Text pages (`story/`, `privacy/`, `terms/`, `support/`) share `assets/doc.css` and `assets/doc.js`.
- `index.html` is self-contained (inline CSS/JS, the logo inlined as SVG). Fonts come from Google Fonts.
- `assets/screens/` are real app screens (390×797 pt at 2×, under a drawn status bar). Regenerate them from a web export of the app when the app's look changes.
- The store buttons are marked "Yakında / Soon" and go nowhere. When the app is live, replace them with Apple's and Google's official badges and links.
- `favicon.ico` (16/32/48) and `assets/favicon-192.png` are the logo mark for browsers and search results; every page links them and its own canonical URL.
- `sitemap.xml` lists the pages (home, story, privacy, terms, support) and `robots.txt` points crawlers to it. Add new pages to the sitemap.
- Hosting: Emre's Hostinger VPS (2.24.113.154), next to other projects behind a dockerized Caddy (`proxy-caddy-1`). An `nginx:alpine` container `nilemy-site` serves `/opt/nilemy-site`, and a systemd timer pulls `main` there every 2 minutes, so merging to `main` publishes. `deploy/add-to-vps.sh` sets this up (`stage`, `live` with HTTPS, or `remove`); it only edits a marked block at the end of the shared Caddyfile. `deploy/check-vps.sh` is a read-only look at the server. Until November 2026 the site was on GitHub Pages; `CNAME` is left over from that.
