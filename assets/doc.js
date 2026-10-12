// Language for the text pages: each page holds a lang="tr" and a lang="en" block; show one.
(function () {
  function read() { try { return localStorage.getItem('nilemy.lang'); } catch (e) { return null; } }
  function write(v) { try { localStorage.setItem('nilemy.lang', v); } catch (e) {} }
  var saved = read();
  var lang = saved === 'tr' || saved === 'en' ? saved : (navigator.language || '').toLowerCase().indexOf('tr') === 0 ? 'tr' : 'en';
  function render() {
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-lang-block]').forEach(function (el) { el.hidden = el.getAttribute('data-lang-block') !== lang; });
    document.querySelectorAll('.lang button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.lang === lang)); });
    var t = document.querySelector('[data-lang-block="' + lang + '"] [data-title]');
    if (t) document.title = t.getAttribute('data-title');
  }
  document.querySelectorAll('.lang button').forEach(function (b) {
    b.addEventListener('click', function () { lang = b.dataset.lang; write(lang); render(); });
  });
  document.querySelectorAll('.copy').forEach(function (b) {
    b.addEventListener('click', function () {
      var text = b.getAttribute('data-copy');
      var done = function () { var old = b.textContent; b.textContent = b.getAttribute('data-done'); setTimeout(function () { b.textContent = old; }, 1600); };
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () {});
    });
  });
  render();
})();
