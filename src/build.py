#!/usr/bin/env python3
"""Builds nilemy.com in six languages from src/.

    python3 src/build.py

Turkish lives at the root (/, /story/, /privacy/, /terms/, /support/), the other languages under
/en/, /de/, /fr/, /pt-br/ and /it/. The server only serves files, so the built pages are committed
next to the sources. Edit src/ and run this again; never edit the built pages by hand.

- src/strings.json: per language, the menu and footer words, the landing page copy and each page's
  title and description.
- src/home.html: the landing page, with {{placeholders}}.
- src/pages/<lang>/<page>.html: the body of each text page. {{base}} is the language's path
  ("" or "/en"), {{mail}} the e-mail box with its copy button.
"""
import html
import json
import re
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'src'
SITE = 'https://nilemy.com'
S = json.loads((SRC / 'strings.json').read_text(encoding='utf-8'))
LANGS = list(S)  # Turkish first: it is the root
PAGES = ['', 'story', 'privacy', 'terms', 'support']
SCREENS = ['home', 'history', 'insights', 'daily']
SCREENS_VERSION = 5  # bump when assets/screens change, so browsers fetch the new ones
DOC_CSS_VERSION = 2  # bump when assets/doc.css changes, for the same reason
SHARE_IMAGE = '/assets/share.png'  # the picture shared links show, made from src/share.html (steps there)


def base(lang):
    return '' if lang == 'tr' else '/' + lang


def url(lang, page):
    return f"{base(lang)}/{page + '/' if page else ''}"


def esc(s):
    return html.escape(s, quote=True)


# Root (Turkish) pages send everyone else to their language once: the language picked earlier
# in the menu, else the first of the browser's languages we have, else English. Crawlers stay,
# so Turkish is indexed at the root; the other languages have their own URLs.
REDIRECT = """<script>
  (function () {
    var paths = { tr: '', en: '/en', de: '/de', fr: '/fr', 'pt-br': '/pt-br', it: '/it' };
    var lang = null;
    try { lang = localStorage.getItem('nilemy.lang'); } catch (e) {}
    if (!paths.hasOwnProperty(lang)) {
      lang = null;
      if (/bot|crawl|spider|slurp|facebookexternalhit|lighthouse|preview/i.test(navigator.userAgent)) return;
      var list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''];
      for (var i = 0; i < list.length && !lang; i++) {
        var code = String(list[i]).toLowerCase().slice(0, 2);
        if (code === 'pt') code = 'pt-br';
        if (paths.hasOwnProperty(code)) lang = code;
      }
      lang = lang || 'en';
    }
    if (lang !== 'tr') location.replace(paths[lang] + location.pathname + location.search + location.hash);
  })();
</script>"""

# The language menu: a <details> with plain links to the same page in each language, so it works
# without JavaScript and crawlers see every language. assets/site.js remembers the choice.
SWITCHER_CSS = """  .langs { position: relative; }
  .langs summary {
    list-style: none; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
    font: 600 12px/1 var(--font); letter-spacing: .04em; color: var(--muted);
    background: var(--blush); border-radius: 999px; padding: 9px 12px; user-select: none;
  }
  .langs summary::-webkit-details-marker { display: none; }
  .langs summary svg { width: 14px; height: 14px; flex: none; }
  .langs summary .chev { width: 10px; height: 10px; transition: transform .2s ease; }
  .langs[open] summary { background: var(--brand); color: var(--bg); }
  .langs[open] summary .chev { transform: rotate(180deg); }
  .langs ul {
    position: absolute; right: 0; top: calc(100% + 8px); z-index: 10; margin: 0; padding: 6px; list-style: none;
    min-width: 200px; background: var(--bg); border: 1px solid var(--blush); border-radius: 16px;
    box-shadow: 0 18px 40px -18px rgba(74, 21, 48, .45);
  }
  .langs a {
    display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 12px; border-radius: 10px;
    color: var(--fg); text-decoration: none; font: 500 15px/1.2 var(--font);
  }
  .langs a:hover { background: var(--blush); }
  .langs a[aria-current="true"] { color: var(--brand); font-weight: 700; }
  .langs a span { color: var(--muted); font-size: 12px; font-weight: 600; letter-spacing: .04em; }
  .langs summary:focus-visible, .langs a:focus-visible { outline: 3px solid var(--brand); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) { .langs summary .chev { transition: none; } }"""

GLOBE = ('<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2">'
         '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/></svg>')
CHEV = ('<svg class="chev" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" '
        'stroke-linecap="round" stroke-linejoin="round"><path d="M2 3.5l3 3 3-3"/></svg>')

SOCIALS = [('https://www.instagram.com/nilemy.app/', 'Instagram'), ('https://www.tiktok.com/@nilemy.app', 'TikTok'),
           ('https://www.linkedin.com/company/nilemy/', 'LinkedIn')]


def switcher(lang, page):
    s = S[lang]
    current = ' aria-current="true"'
    items = '\n'.join(
        f'      <li><a href="{url(l, page)}" hreflang="{S[l]["hreflang"]}" lang="{S[l]["hreflang"]}" data-lang="{l}"'
        f'{current if l == lang else ""}>{esc(S[l]["name"])} <span>{S[l]["short"]}</span></a></li>'
        for l in LANGS)
    return (f'<details class="langs">\n    <summary aria-label="{esc(s["ui"]["language"])}: {esc(s["name"])}">{GLOBE}{s["short"]}{CHEV}</summary>\n'
            f'    <ul>\n{items}\n    </ul>\n  </details>')


def head_links(lang, page):
    links = [f'<link rel="canonical" href="{SITE}{url(lang, page)}">']
    links += [f'<link rel="alternate" hreflang="{S[l]["hreflang"]}" href="{SITE}{url(l, page)}">' for l in LANGS]
    links.append(f'<link rel="alternate" hreflang="x-default" href="{SITE}{url("tr", page)}">')
    return '\n'.join(links)


def png_size(path):
    """A PNG's width and height, read from its header."""
    head = path.read_bytes()[:24]
    assert head[:8] == b'\x89PNG\r\n\x1a\n', f'{path} is not a PNG'
    return struct.unpack('>II', head[16:24])


def share_tags(lang, page):
    """Open Graph and X tags, so a link shared in WhatsApp, iMessage, X or Facebook shows the logo
    (SHARE_IMAGE) with the page's title and description. The title leaves out " · Nilemy", because
    apps show the site name next to it."""
    s = S[lang]
    title, desc = s['meta'][page or 'home']
    title = title.removesuffix(' · Nilemy')
    image = SITE + SHARE_IMAGE
    width, height = png_size(ROOT / SHARE_IMAGE.lstrip('/'))  # stops the build if the picture is missing
    return '\n'.join([
        '<meta property="og:type" content="website">',
        '<meta property="og:site_name" content="Nilemy">',
        f'<meta property="og:title" content="{esc(title)}">',
        f'<meta property="og:description" content="{esc(desc)}">',
        f'<meta property="og:url" content="{SITE}{url(lang, page)}">',
        f'<meta property="og:image" content="{image}">',
        '<meta property="og:image:type" content="image/png">',
        f'<meta property="og:image:width" content="{width}">',
        f'<meta property="og:image:height" content="{height}">',
        '<meta property="og:image:alt" content="Nilemy">',
        f'<meta property="og:locale" content="{s["og"]}">',
    ] + [f'<meta property="og:locale:alternate" content="{S[l]["og"]}">' for l in LANGS if l != lang] + [
        '<meta name="twitter:card" content="summary_large_image">',
        f'<meta name="twitter:image" content="{image}">',
        '<meta name="twitter:image:alt" content="Nilemy">',
    ])


def mail(lang):
    ui = S[lang]['ui']
    return (f'<div class="mail"><code>info@nilemy.com</code><button type="button" class="copy" data-copy="info@nilemy.com" '
            f'data-done="{esc(ui["copied"])}">{esc(ui["copy"])}</button></div>')


def fill(text, values):
    for k, v in values.items():
        text = text.replace('{{' + k + '}}', v)
    assert '{{' not in text, text[text.find('{{'):text.find('{{') + 60]
    return text


# Hyphenated words with a part of three letters or fewer (e-mail, AES-256, E-Mail-Adresse, the
# German "-phase") and references such as 6(1)(a) read badly split across two lines, so they are
# kept on one. Longer compounds (Store-Konto) may still break at the hyphen.
TOKEN = re.compile(r'(?<![\w-])(?:\S*\)\(\S*|-?\w+(?:-\w+)*)(?![\w-])')


def keep_together(text):
    def mark(m):
        word = m.group(0)
        if ')(' in word or ('-' in word and any(len(part) <= 3 for part in word.split('-'))):
            return f'<span class="nw">{word}</span>'
        return word
    return ''.join(part if part.startswith('<') else TOKEN.sub(mark, part) for part in re.split(r'(<[^>]+>)', text))


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')


def home(lang):
    s = S[lang]
    h = s['home']
    first, lazy = ' class="on"', ' loading="lazy"'
    values = {
        'hreflang': s['hreflang'],
        'metaTitle': esc(s['meta']['home'][0]),
        'metaDesc': esc(s['meta']['home'][1]),
        'headLinks': (REDIRECT + '\n' if lang == 'tr' else '') + head_links(lang, ''),
        'og': share_tags(lang, ''),
        'switcherCss': SWITCHER_CSS,
        'switcher': switcher(lang, ''),
        'base': base(lang),
        'screens': ''.join(
            f'<img src="/assets/screens/{lang}-{name}.webp?v={SCREENS_VERSION}" alt="{esc(h["screens"][n])}"'
            f'{first if n == 0 else lazy} decoding="async" width="780" height="1594">'
            for n, name in enumerate(SCREENS)),
        'dots': ''.join(
            f'<button type="button" id="dot-{name}" aria-label="{esc(h["screens"][n])}" aria-current="{str(n == 0).lower()}"></button>'
            for n, name in enumerate(SCREENS)),
        'script': HOME_SCRIPT,
    }
    for k, v in h.items():
        if isinstance(v, str):
            values['home.' + k] = v  # copy may hold <br> and <em>
    for k, v in s['ui'].items():
        values['ui.' + k] = esc(v)
    out = fill((SRC / 'home.html').read_text(encoding='utf-8'), values)
    write(ROOT / base(lang).lstrip('/') / 'index.html', out)


HOME_SCRIPT = """<script src="/assets/site.js" defer></script>
<script>
  // The phone shows the app's screens in turn; the dots pick one. The heart line draws itself in.
  const shots = document.querySelectorAll('#screen img');
  const dots = document.querySelectorAll('#dots button');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let current = 0;
  let timer = null;
  function show(i) {
    current = i;
    shots.forEach((img, n) => img.classList.toggle('on', n === i));
    dots.forEach((b, n) => b.setAttribute('aria-current', String(n === i)));
  }
  function restart() {
    if (reduce) return;
    clearInterval(timer);
    timer = setInterval(() => show((current + 1) % shots.length), 3600);
  }
  dots.forEach((b, n) => b.addEventListener('click', () => { show(n); restart(); }));
  document.querySelectorAll('.store[aria-disabled="true"]').forEach((a) => a.addEventListener('click', (e) => e.preventDefault()));

  const heart = document.querySelector('.heart-line');
  if (!reduce && 'IntersectionObserver' in window) {
    heart.classList.add('ready');
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { heart.classList.add('drawn'); io.disconnect(); }
    }, { threshold: 0.6 });
    io.observe(heart);
  }
  restart();
</script>"""


DOC = """<!doctype html>
<html lang="{{hreflang}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{{title}}</title>
<meta name="description" content="{{desc}}">
<meta name="theme-color" content="#FCF5F6">
{{headLinks}}
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="192x192" href="/assets/favicon-192.png">
<link rel="icon" type="image/png" href="/assets/favicon.png">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
{{og}}
<link rel="preload" href="/assets/fonts/plus-jakarta-sans-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/fonts/fonts.css">
<link rel="stylesheet" href="/assets/doc.css?v={{cssVersion}}">
<style>
{{switcherCss}}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <a class="home" href="{{base}}/"><img src="/assets/mark.svg" alt="">Nilemy</a>
    <nav class="topbar">
      <a class="nav-link" href="{{base}}/story/"{{storyCurrent}}>{{storyLink}}</a>
      {{switcher}}
    </nav>
  </header>

  <main{{mainClass}}>
{{body}}  </main>

  <footer>
    <span>© 2026 Nilemy</span>
    <a href="{{base}}/">nilemy.com</a>
    <a href="{{base}}/story/">{{storyLink}}</a>
    <a href="{{base}}/privacy/">{{privacy}}</a>
    <a href="{{base}}/terms/">{{terms}}</a>
    <a href="{{base}}/support/">{{support}}</a>
{{socials}}
  </footer>
</div>
<script src="/assets/site.js" defer></script>
</body>
</html>
"""


def doc(lang, page):
    s = S[lang]
    ui = s['ui']
    body = (SRC / 'pages' / lang / f'{page}.html').read_text(encoding='utf-8')
    body = keep_together(fill(body, {'base': base(lang), 'mail': mail(lang)}))
    values = {
        'hreflang': s['hreflang'],
        'title': esc(s['meta'][page][0]),
        'desc': esc(s['meta'][page][1]),
        'headLinks': (REDIRECT + '\n' if lang == 'tr' else '') + head_links(lang, page),
        'og': share_tags(lang, page),
        'switcherCss': SWITCHER_CSS,
        'cssVersion': str(DOC_CSS_VERSION),
        'switcher': switcher(lang, page),
        'base': base(lang),
        'storyCurrent': ' aria-current="page"' if page == 'story' else '',
        'storyLink': esc(ui['storyLink']),
        'privacy': esc(ui['privacy']),
        'terms': esc(ui['terms']),
        'support': esc(ui['support']),
        'mainClass': ' class="story"' if page == 'story' else '',
        'body': body,
        'socials': '\n'.join(f'    <a href="{u}" target="_blank" rel="me noopener">{n}</a>' for u, n in SOCIALS),
    }
    write(ROOT / base(lang).lstrip('/') / page / 'index.html', fill(DOC, values))


def sitemap():
    rows = []
    for page in PAGES:
        for lang in LANGS:
            alts = '\n'.join(f'    <xhtml:link rel="alternate" hreflang="{S[l]["hreflang"]}" href="{SITE}{url(l, page)}"/>' for l in LANGS)
            alts += f'\n    <xhtml:link rel="alternate" hreflang="x-default" href="{SITE}{url("tr", page)}"/>'
            rows.append(f'  <url>\n    <loc>{SITE}{url(lang, page)}</loc>\n{alts}\n  </url>')
    write(ROOT / 'sitemap.xml', '<?xml version="1.0" encoding="UTF-8"?>\n'
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n'
          + '\n'.join(rows) + '\n</urlset>\n')


if __name__ == '__main__':
    for lang in LANGS:
        home(lang)
        for page in PAGES[1:]:
            doc(lang, page)
    sitemap()
    print('built', len(LANGS) * len(PAGES), 'pages')
