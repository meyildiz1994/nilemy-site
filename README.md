# nilemy.com

The landing page (the app on the first screen, then our story and the footer) and the text pages (story, privacy, terms, support), in the app's six languages: Turkish, English, German, French, Portuguese (Brazil) and Italian.

## Languages and building

- Turkish is at the root (`/`, `/story/`, `/privacy/`, `/terms/`, `/support/`), so the links in the app and on the App Store keep working. The other languages are under `/en/`, `/de/`, `/fr/`, `/pt-br/` and `/it/`.
- The pages are built from `src/` with `python3 src/build.py` (no packages needed). Edit `src/`, run it, and commit the built pages too: the server only serves files. Don't edit the built `index.html` files by hand.
  - `src/strings.json`: per language, the menu and footer words, the landing page copy, and each page's title and description.
  - `src/home.html`: the landing page template.
  - `src/pages/<lang>/<page>.html`: the text of each page. A change to a page goes into all six languages.
- A Turkish root page sends a visitor to their language once: the language they picked in the menu (kept in their browser), else the first browser language the site has, else English. Search engines stay on the Turkish page; every page lists the others with `hreflang`, and so does `sitemap.xml`.
- The language menu is plain links, so it works without JavaScript; `assets/site.js` remembers the choice and runs the copy buttons.
- Check the pages at phone and desktop widths in every language before merging; German has the longest words.

## Other files

- `assets/doc.css` styles the text pages; the landing page has its CSS inline.
- `assets/screens/<lang>-{home,history,insights,daily}.webp` are real app screens in each language (390×797 pt at 2×, under a drawn status bar). Regenerate them from a web export of the app when its look changes, and bump `SCREENS_VERSION` in `src/build.py`.
- Fonts (Plus Jakarta Sans) are served from `assets/fonts/`, with no calls to Google Fonts.
- The App Store button links to the live listing. The Google Play button is marked as coming soon and goes nowhere until the Android app is out.
- `favicon.ico` (16/32/48) and `assets/favicon-192.png` are the logo mark for browsers and search results.
- `assets/share.png` (1200×630) is the picture a shared link shows in WhatsApp, iMessage, X or Facebook: the logo on the site background, made from `src/share.html`. Every page points to it with Open Graph and X tags. Apps keep old previews for a while, so give a changed picture a new file name (`SHARE_IMAGE` in `src/build.py`).
- `robots.txt` points crawlers to `sitemap.xml`. `app-ads.txt` is for AdMob and stays at the root.
- `api/` is the server behind the app's Premium daily note, reached at `/api/` (set up with `deploy/add-api.sh`).
- Hosting: Emre's Hostinger VPS (2.24.113.154), next to other projects behind a dockerized Caddy (`proxy-caddy-1`). An `nginx:alpine` container `nilemy-site` serves `/opt/nilemy-site`, and a systemd timer pulls `main` there every 2 minutes, so merging to `main` publishes. `deploy/add-to-vps.sh` sets this up (`stage`, `live` with HTTPS, or `remove`); it only edits a marked block at the end of the shared Caddyfile. `deploy/check-vps.sh` is a read-only look at the server. Until November 2026 the site was on GitHub Pages; `CNAME` is left over from that.
