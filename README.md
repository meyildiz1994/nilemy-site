# nilemy.com

The landing page: a first screen with the app, then our story and the footer below it, Turkish and English (follows the browser, TR | EN switch). `story/` is the full story.

- Text pages (`story/`, `privacy/`, `terms/`, `support/`) share `assets/doc.css` and `assets/doc.js`.
- `index.html` is self-contained (inline CSS/JS, the logo inlined as SVG). Fonts come from Google Fonts.
- `assets/screens/` are real app screens (390×797 pt at 2×, under a drawn status bar). Regenerate them from a web export of the app when the app's look changes.
- The store buttons are marked "Yakında / Soon" and go nowhere. When the app is live, replace them with Apple's and Google's official badges and links.
- `favicon.ico` (16/32/48) and `assets/favicon-192.png` are the logo mark for browsers and search results; every page links them and its own canonical URL.
- `sitemap.xml` lists the pages (home, story, privacy, terms, support) and `robots.txt` points crawlers to it. Add new pages to the sitemap.
- `CNAME` holds the custom domain. `.github/workflows/site.yml` publishes this repo with GitHub Pages on every change to `main`.
